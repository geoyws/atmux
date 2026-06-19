// ADR-005: Zod schema for `.atmux/team.json`.
//
// The boundary file every verb that knows the team identity reads. The
// schema is `.passthrough()` at the root because the templates ship with
// operator-authored `_comment_*` keys (see templates/team.example.json)
// and because legacy `team.json` files predating ADR-263 carry now-
// retired fleet sub-blocks (whip / report / autoMerge / orchestration /
// issueSync / …). Passthrough lets those old configs still load while
// the slimmed schema only models the fields a kept verb actually reads.
//
// ADR-263 §D1/§D2/§D4 — the great simplification: the fleet-coordination
// config sub-blocks were deleted with their verbs/core. What remains is
// the harness identity (name + panes + tmux knobs) plus the optional
// task-feed knobs (kanban / autoEmitTrunkMerge / merger) and forensic
// observability toggles that kept code still reads.
//
// References: ADR-005 (JSON+lock), ADR-003 (schemas import zod only),
// ADR-263 (great simplification), templates/team.example.json.

import { z } from "zod";

/** TUI types atmux supports launching into a pane.
 *
 * `lib/tui.sh::atmux::tui_cmd` treats `tui` as a free-form name —
 * known built-ins (claude/opencode/kimi/cursor/shell/bash/zsh) hit a
 * hard-coded launcher; any other value MUST be registered in
 * `team.tuiCommands`. The schema therefore accepts `z.string()` rather
 * than a closed enum: locking the enum to the built-ins would refuse
 * legitimate `team.tuiCommands` names like `claude-fresh` /
 * `opencode-minimax-fast` (live use). */
export const TuiKind = z.string();
export type TuiKind = z.infer<typeof TuiKind>;

/** Member entry in `team.json :: members[]`. */
export const TeamMember = z
  .object({
    name: z.string().min(1),
    /** ADR-136 (Option B): display label decoupled from member `name`.
     *  When set, the display layer (buildWindowName, status) uses
     *  `label`; the `name` field remains the immutable id (kanban owner
     *  refs, state-file keys). When unset, the display layer falls back
     *  to `name` — zero migration for existing teams. Refine rule
     *  rejects `:` and `.` because both are tmux window-name separator
     *  chars and would break `__<team>__<member>` parsing. */
    label: z
      .string()
      .refine((s) => !s.includes(":") && !s.includes("."), {
        message: "label cannot contain ':' or '.' (tmux separator chars)",
      })
      .optional(),
    /** ADR-159 TR3 (2026-05-16): role-value shim — `"gitter"` is the
     *  legacy alias for the new canonical `"committer"`. At Zod parse
     *  time the transform coerces the legacy value to canonical so
     *  downstream consumers see one shape regardless of which value the
     *  operator's team.json declared. The shim is intentionally
     *  open-string (does NOT tighten to a closed enum) — rosters use a
     *  wide variety of role values; tightening to enum here would break
     *  working teams. */
    role: z
      .string()
      .transform((value) => (value === "gitter" ? "committer" : value))
      .optional(),
    lane: z.string().optional(),
    tui: TuiKind.optional(),
    model: z.string().optional(),
    cwd: z.string().optional(),
    emoji: z.string().optional(),
    /** Per-member full-command override (lib/tui.sh:30-37 / lib/add-member.sh:21).
     *  When present, `atmux::tui_cmd` uses it verbatim, ignoring `team.tuiCommands`
     *  and built-in launchers. Stamped at `add-member` time via `--command <cmd>`. */
    command: z.string().optional(),
    /** ADR-157 §D4 — explicit runtime selector for the per-member TUI
     *  flavor. Default-unset → falls back to TUI-driven runtime
     *  detection via `tui` (cursor / claude / shell / ...). Free-form
     *  string for forward-compat with future runtimes (per ADR-005
     *  `tui: z.string()` precedent). */
    runtime: z.string().optional(),
    /** ADR-157 §D2 — per-member goal hint, surfaced via the Claude Code
     *  `/goal` skill. Optional + additive; free-form string. Empty
     *  string = explicit opt-out. */
    goal: z.string().optional(),
  })
  .passthrough();
export type TeamMember = z.infer<typeof TeamMember>;

/** Emoji-assignment policy block. Mode mirrors bash `lib/emoji.sh`. */
export const TeamEmojis = z
  .object({
    mode: z.enum(["static", "random", "ai"]).optional(),
  })
  .passthrough();
export type TeamEmojis = z.infer<typeof TeamEmojis>;

/**
 * `team.json::cron` sub-config — per-team cron-line PATH override.
 *
 * Cron's bare env on Ubuntu is
 * `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`, which
 * does NOT include `/root/.bun/bin` (bun lives there under mise).
 * atmux-bun's shebang is `#!/usr/bin/env bun`, so cron-fired verbs
 * silently die with `/usr/bin/env: 'bun': No such file or directory`.
 *
 * Fix: bake an inline `PATH=<value> ` prefix into every emitted cron
 * line so each line picks up bun regardless of cron's narrow env.
 * Default targets hax (where atmux primarily runs); operators on other
 * hosts override via `team.cron.path` in `team.json`.
 *
 * Source: Bug t-2db59eee (cron whip fails with bun-not-found).
 */
export const TeamCron = z
  .object({
    /** Inline PATH baked into every cron line. Default targets hax
     *  (mise-managed bun at `/root/.bun/bin/bun`); override per-host
     *  when bun lives elsewhere. */
    path: z.string().default("/root/.bun/bin:/usr/local/bin:/usr/bin:/bin"),
  })
  .strict();
export type TeamCron = z.infer<typeof TeamCron>;

/**
 * `team.json::decisions` sub-config — cron cadence for `decisions
 * digest`. Hourly granularity — minute-level cadence makes no sense for
 * the 4-hour digest verb.
 */
export const TeamDecisions = z
  .object({
    /** Cron interval in hours for `decisions digest`. Default 4.
     *  Must be a divisor of 24: 1, 2, 3, 4, 6, 8, 12, 24. */
    intervalHours: z.number().int().positive().default(4),
  })
  .strict();
export type TeamDecisions = z.infer<typeof TeamDecisions>;

/**
 * `team.json::groom` sub-config — daily groom hour-of-day + per-sub-op
 * opt-in toggles. Groom runs once per day at the operator-chosen hour
 * (default 04:00, the quietest window).
 */
export const TeamGroom = z
  .object({
    /** Hour-of-day (0–23) at which `groom --quiet` fires. Default 4. */
    atHour: z.number().int().min(0).max(23).default(4),
    /** Invoke lane-drift-check as part of groom's daily sweep. */
    laneDriftCheck: z.boolean().optional(),
  })
  .strict();
export type TeamGroom = z.infer<typeof TeamGroom>;

/**
 * `team.json::unblocker` sub-config — cron cadence for the unblocker
 * tick line. Only emitted when the team has a member with
 * `role: "unblocker"`; the field is otherwise inert.
 */
export const TeamUnblocker = z
  .object({
    /** Cron interval in minutes for `unblocker tick`. Default 2. Must
     *  be a divisor of 60: 1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60. */
    intervalMins: z.number().int().positive().default(2),
  })
  .strict();
export type TeamUnblocker = z.infer<typeof TeamUnblocker>;

/**
 * `team.json::kanban` sub-config — kanban-orchestration knobs. ADR-062
 * §1 introduced `claim --next` lane-aware pull; the cross-lane fallback
 * gate lives here. Read by `src/verbs/claim.ts`.
 */
export const TeamKanban = z
  .object({
    /** Cross-lane fallback gate for `claim --next`. When `true` (default),
     *  a worker whose own-lane queue is dry falls back to `lane=null`
     *  Tasks (legacy + small misc work). When `false`, the second-pass
     *  fallback is suppressed and `claim --next` exits with a clear
     *  "no work in <LANE> lane" message — strict-lane mode. Per ADR-062
     *  §OQ4 default. */
    crossLaneClaim: z.boolean().default(true),
    /** ADR-083 §IN §4: auto-install the team's marker-fenced crontab
     *  block on `atmux start`. When `false`, `atmux start` skips cron
     *  entirely and the operator must run `atmux cron-install` manually.
     *  `ATMUX_NO_CRON=1` short-circuits the same path for test sandboxes
     *  — the env wins over this flag. */
    cronAutoInstall: z.boolean().default(true),
  })
  .strict();
export type TeamKanban = z.infer<typeof TeamKanban>;

/**
 * `team.json::gitter` sub-config — gitter-member knobs.
 *
 * lane-tick's auto-done scan needs a repo path; `repoPath` is optional
 * with a default resolved at the call site (atmux-dir's parent — the
 * most common shape).
 */
export const TeamGitter = z
  .object({
    /** Absolute path to the git repository the gitter commits in. When
     *  unset, lane-tick's auto-done scan defaults to `dirname(atmuxDir)`
     *  (the project root that contains `.atmux/`). Multi-repo teams
     *  override per-team. */
    repoPath: z.string().optional(),
  })
  .strict();
export type TeamGitter = z.infer<typeof TeamGitter>;

/** ADR-179 §Decision-2+3+6: per-member-branch fan-in policy ("merger"
 *  role). Opt-in `team.merger.enabled` activates either a `merger`
 *  member role or driver-fired `atmux merge-cycle`. Read by
 *  `src/core/kanban.ts` (shared-base short-circuit). Defaults preserve
 *  pre-ADR-179 operator-manual fan-in. */
export const TeamMerger = z
  .object({
    /** When `true`, fan-in automation is enabled. Default `false` —
     *  existing teams unaffected. */
    enabled: z.boolean().default(false),
    /** Branch to merge per-member branches into. Optional — when unset,
     *  resolved at read-time via `git -C <repoPath> branch --show-current`. */
    baseBranch: z.string().min(1).optional(),
    /** Hours-of-staleness threshold for the `merger-branch-stale`
     *  doctor probe. Default `24` (one-day fan-in cadence target). */
    stalenessHours: z.number().int().min(1).default(24),
    /** Cron cadence for the `atmux merge-cycle` line (added only when
     *  `enabled === true`). Default `15` (minutes); must be one of
     *  cron's divisor-of-60 set. */
    cycleIntervalMins: z.number().int().positive().optional(),
  })
  .strict();
export type TeamMerger = z.infer<typeof TeamMerger>;

/** ADR-179 §Decision-5 / W7 default — used by cron renderer +
 *  `cron-install` verb when `team.merger.cycleIntervalMins` is unset. */
export const DEFAULT_MERGER_CYCLE_INTERVAL_MINS = 15;

/**
 * t-e89c03f7: observability sub-shape — opt-in toggles for forensic
 * data collection that's useful for offline analysis but isn't load-
 * bearing for any live verb. Read by `src/core/pane-state.ts`.
 */
export const TeamObservability = z
  .object({
    /** t-e89c03f7: when true, every UNKNOWN classification from
     *  `classifyPane` appends a redacted-evidence row to
     *  `<atmuxDir>/logs/pane-state-unknown.jsonl`. Default false — opt-in
     *  to avoid disk churn on teams that aren't analyzing the data. */
    paneStateUnknownLog: z.boolean().optional(),
  })
  .strict();
export type TeamObservability = z.infer<typeof TeamObservability>;

/** `team.json::modalCycling` — ADR-142 modal-cycling detector tunables.
 *  All fields optional; defaults applied at the call-site. `.strict()`
 *  so typos trip drift-detection. */
export const TeamModalCycling = z
  .object({
    enabled: z.boolean().optional(),
    cycleThreshold: z.number().int().positive().optional(),
    windowMin: z.number().int().positive().optional(),
    commitGracePeriodMin: z.number().int().nonnegative().optional(),
    dedupMin: z.number().int().nonnegative().optional(),
    exemptMembers: z.array(z.string()).optional(),
  })
  .strict();
export type TeamModalCycling = z.infer<typeof TeamModalCycling>;

/** ADR-146 §D7: per-team `autoEmitTrunkMerge` config — governs whether
 *  `moveTask` auto-files a `merge t-xxx (branch→trunk)` Task when the
 *  last leaf of a per-Story-branch task chain lands done. Read by
 *  `src/core/kanban.ts`. Defaults applied per
 *  {@link DEFAULT_AUTO_EMIT_TRUNK_MERGE_CONFIG} when the block is
 *  absent. */
export const TeamAutoEmitTrunkMerge = z
  .object({
    /** Master switch. ADR-146 §D7 narrative: default `true` when
     *  `worktreeIsolation: true`, `false` otherwise. The resolver in
     *  `src/core/kanban.ts` reads `team.worktreeIsolation` to compute the
     *  effective default when this field is unset. */
    enabled: z.boolean().optional(),
    /** Owner for the auto-emitted Task when the team has no `gitter`
     *  member. `null` (default) leaves the Task unassigned for any
     *  member to claim via `atmux claim --next`. */
    fallbackAssignee: z.string().nullable().optional(),
    /** When `true`, skip auto-emit when `Story.branch ===
     *  <team-base-branch>`. Default `true`. */
    shortCircuitOnSharedBase: z.boolean().optional(),
  })
  .strict();
export type TeamAutoEmitTrunkMerge = z.infer<typeof TeamAutoEmitTrunkMerge>;

/** ADR-146 §D7 defaults — used by the moveTask hook in
 *  `src/core/kanban.ts` when the `autoEmitTrunkMerge` block is absent OR
 *  individual fields are unset. Co-located with the schema so non-Zod
 *  call sites share the same constants. */
export const DEFAULT_AUTO_EMIT_TRUNK_MERGE_CONFIG = {
  enabled: true,
  fallbackAssignee: null as string | null,
  shortCircuitOnSharedBase: true,
} as const;

/** `.atmux/team.json` — the team's durable identity + roster. */
export const Team = z
  .object({
    /** Team name. Constrained in-code (see core/common.ts checkTeamName). */
    name: z.string().min(1),
    /** Free-form description; surfaced in `atmux status` headers. */
    description: z.string().optional(),
    /** Cage tmpdir per ADR-018 (`/tmp/atmux-tmux_<team>`); empty/null
     *  means the team uses the operator default socket. */
    tmuxTmpdir: z.string().optional(),
    /** ADR-082 §2: per-member git worktree isolation. When `true`,
     *  `atmux start` provisions a worktree under `worktreeRoot/<member>/`
     *  for each member and rewires `member.cwd` to that path; stop /
     *  doctor honor the same root. Optional + effectively `false` —
     *  existing teams keep the shared-tree behavior. */
    worktreeIsolation: z.boolean().optional(),
    /** ADR-082 §2: directory (relative to the team's project root) where
     *  per-member worktrees live when `worktreeIsolation === true`.
     *  Effective default `.atmux/worktrees`. Use {@link DEFAULT_WORKTREE_ROOT}
     *  when reading. */
    worktreeRoot: z.string().optional(),
    /** ADR-179: when `true` AND `worktreeIsolation === true`, `atmux start`
     *  runs `git submodule update --init --recursive` inside each newly
     *  created worktree. Best-effort. Default `false`. */
    worktreeInitSubmodules: z.boolean().optional(),
    /** Single-session opt-in (default `false` per 2026-04-30 reversal,
     *  see templates/team.example.json comment). */
    singleSession: z.boolean().optional(),
    /** TUI to auto-spawn in the cage's driver window on `atmux start`. */
    driverTui: z.string().nullable().optional(),
    /** ADR-044: when set, the team session is created with `driver` as
     *  window 1 (in place of the `__home` placeholder). Members spawn as
     *  windows 2..N+1 in declarative order. `null` is accepted as
     *  "explicitly disabled". Resolution order for the TUI command:
     *  `driverSession.tui` → `driverTui` → `"claude"`. */
    driverSession: z
      .object({
        tui: z.string().nullable().optional(),
        /** ADR-239 §D7 — loose model pin for the driver's TUI. Any string
         *  accepted; `null` / absent both mean "unset". */
        model: z.string().nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),
    /** ADR-239 §D7 + §A5 (amended 2026-05-26) — declarative driver roster.
     *
     *  When present + non-empty, supersedes the legacy `driverSession` /
     *  `driverTui` fields and drives `atmux start`'s driver-spawn loop.
     *  Operator-interactive ONLY — no send-keys EVER (ADR-239 §D2), no
     *  pre-prompts / briefs (ADR-239 §D5 + §A3). Cap of 10 per ADR-239
     *  §A4 OQ1-resolution. */
    drivers: z
      .array(
        z
          .object({
            name: z.string().min(1),
            tui: z.string().min(1),
            cwd: z.string().min(1),
            claudeAccount: z.string().optional(),
          })
          .passthrough(),
      )
      .min(1)
      .max(10)
      .optional(),
    /** Member roster. Order is preserved (window layout depends on it). */
    members: z.array(TeamMember),
    emojis: TeamEmojis.optional(),
    /** Per-team cron PATH override (bug t-2db59eee). */
    cron: TeamCron.optional(),
    /** ADR-062 §OQ4: kanban-orchestration knobs (cross-lane fallback).
     *  Read by `src/verbs/claim.ts`. */
    kanban: TeamKanban.optional(),
    /** Cron cadence for `decisions digest`. */
    decisions: TeamDecisions.optional(),
    /** Daily groom hour-of-day. */
    groom: TeamGroom.optional(),
    /** Cron cadence for `unblocker tick`. */
    unblocker: TeamUnblocker.optional(),
    /** ADR-080 §B2: gitter-member knobs (auto-done scan repo path). */
    gitter: TeamGitter.optional(),
    /** ADR-179 §Decision-2: per-member-branch fan-in policy (merger
     *  role). Read by `src/core/kanban.ts` (shared-base short-circuit). */
    merger: TeamMerger.optional(),
    /** t-e89c03f7: observability toggles (forensic data collection).
     *  Read by `src/core/pane-state.ts`. */
    observability: TeamObservability.optional(),
    /** ADR-142: modal-cycling detector tunables. */
    modalCycling: TeamModalCycling.optional(),
    /** ADR-146 §D7: per-team `autoEmitTrunkMerge` config. Read by
     *  `src/core/kanban.ts`. Absent block uses
     *  {@link DEFAULT_AUTO_EMIT_TRUNK_MERGE_CONFIG}. */
    autoEmitTrunkMerge: TeamAutoEmitTrunkMerge.optional(),
    /** ADR-087: `atmux stop --soft` grace window between the per-member
     *  notify and the manifest write + session kill. Default 5 seconds
     *  when unset. */
    softStopGraceSeconds: z.number().int().nonnegative().optional(),
    /** Optional Discord webhook config. Read by `src/verbs/reconfigure.ts`. */
    discord: z.unknown().optional(),
    /** Per-team TUI launch-command aliases. Read by `src/core/tui-cmd.ts`,
     *  `src/verbs/reconfigure.ts`, `src/verbs/doctor.ts`. */
    tuiCommands: z.unknown().optional(),
  })
  .passthrough();
export type Team = z.infer<typeof Team>;

/** ADR-082 §2: effective default for `team.worktreeRoot` when the field
 *  is unset. Co-located with the schema so read-sites in start / stop /
 *  doctor share the same constant. */
export const DEFAULT_WORKTREE_ROOT = ".atmux/worktrees";

/** ADR-179 §Decision-3: default staleness window (hours) for the
 *  merger-branch-stale doctor probe + general merger heuristics. Mirrors
 *  the Zod `stalenessHours.default(24)`. */
export const DEFAULT_MERGER_STALENESS_HOURS = 24;
