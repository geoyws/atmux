// ADR-005: Zod schema for `.atmux/team.json`.
//
// The boundary file every verb that knows the team identity reads. v1
// models the fields that core + the abstractions currently consume; the
// schema is `.passthrough()` because the templates ship with operator-
// authored `_comment_*` keys (see templates/team.example.json) and
// because Phase 2 porters add `whip` / `report` / `discord` sub-shapes
// as their verbs land. Once every consumer is modeled (Phase 2 close),
// flip to `.strict()` per src/schema/README.md's strict-by-default
// rule. Tightening the union is forward-compatible; loosening it
// later is not.
//
// References: ADR-005 (JSON+lock), ADR-003 (schemas import zod only),
// templates/team.example.json (canonical shape at HEAD 2aadc3f),
// lib/common.sh::atmux::team_field (bash-side reader).

import { z } from "zod";

/** TUI types atmux supports launching into a pane.
 *
 * Bash `lib/tui.sh::atmux::tui_cmd` treats `tui` as a free-form name —
 * known built-ins (claude/opencode/kimi/cursor/shell/bash/zsh) hit a
 * hard-coded launcher; any other value MUST be registered in
 * `team.tuiCommands` (see `tests/unit/tui_resolution.bats`). The schema
 * therefore accepts `z.string()` rather than a closed enum: locking the
 * enum to the built-ins would refuse legitimate `team.tuiCommands`
 * names like `claude-fresh` / `opencode-minimax-fast` (live use,
 * documented at `lib/tui.sh:21`). */
export const TuiKind = z.string();
export type TuiKind = z.infer<typeof TuiKind>;

/** Member entry in `team.json :: members[]`. */
export const TeamMember = z
  .object({
    name: z.string().min(1),
    role: z.string().optional(),
    lane: z.string().optional(),
    tui: TuiKind.optional(),
    model: z.string().optional(),
    cwd: z.string().optional(),
    emoji: z.string().optional(),
    /** Per-member full-command override (lib/tui.sh:30-37 / lib/add-member.sh:21).
     *  When present, `atmux::tui_cmd` uses it verbatim, ignoring `team.tuiCommands`
     *  and built-in launchers. Stamped at `add-member` time via `--command <cmd>`. */
    command: z.string().optional(),
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
 * `team.json::whip` sub-config — typed per ADR-054 §D1.
 *
 * `.strict()` is intentional — drift detection requires unknown-key
 * rejection. Passthrough at this level would mask typos like
 * `budgetPauseTreshold` (note typo); strict surfaces them via the
 * 🔧 [whip-config-drift] Discord ping per ADR-054 §D3.
 *
 * Includes ALL fields used by ADR-053 (budget knobs), ADR-055
 * (selfHeal), and ADR-056 (account fallback). Adding a field requires
 * updating this schema — the intentional friction CLAUDE.md asks for.
 *
 * Bash-shared note: bash whip uses several of these fields too
 * (`staleMin`, `leadMaxMin`, `autoRotate`); they predate this schema
 * and are read in bash via `lib/whip.sh:71-81`'s loose jq lookup.
 * Adding the typed schema doesn't change bash behaviour — bash never
 * read a `schemaVersion` and we don't introduce one (per
 * `src/schema/README.md` §"Burn-in compatibility"). Operator typos in
 * fields bash uses also surface via this drift mechanism.
 */
export const TeamWhip = z
  .object({
    /** Cron interval in minutes. Default 15 (raised from 5 on
     *  2026-05-13 per t-dcbff97c §4 — auto-drain teams only need the
     *  lead awake ~4× / hour; the prior 5min cadence amplified the
     *  whip rate-limit footprint without commensurate benefit). ADR-054
     *  OQ-1 surfaces cron-vs-schema mismatch as future doctor work. */
    intervalMins: z.number().int().positive().default(15),
    /** Stale-task threshold (min). Default 90 (raised from bash 30 in
     *  bash E2/S7 — demo-walk tasks legitimately run 60-90min). */
    staleMin: z.number().int().nonnegative().default(90),
    /** Lead uptime cutoff (min). ≥this → recommend rotate. Default 60. */
    leadMaxMin: z.number().int().positive().default(60),
    /** Auto-rotate execution gate. V-25 only recommends; auto-execute
     *  is V-26-deferred per ADR-021. Default false. */
    autoRotate: z.boolean().default(false),
    /** Number of consecutive DOWN ticks before reporting (false-alert
     *  dampener). Default 2 per bash E6/S1. Used by readWhipConfig +
     *  the 2-tick session-DOWN gate; pre-existed ADR-054 — added here
     *  to keep `.strict()` mode from rejecting valid live team.json. */
    downConfirmTicks: z.number().int().positive().default(2),
    /** When `false`, suppress 💓 [whip-heartbeat] on clean ticks.
     *  Pre-existed ADR-054 — added here to keep `.strict()` from
     *  rejecting valid live team.json (every whip test sets it). */
    heartbeat: z.boolean().default(true),
    /** ADR-080 §A1: lead ctx-pct rotation threshold (0–100). When the
     *  lead pane's `tok N/M` indicator parses to a pct ≥ this, the
     *  rotate-recommendation fires even if uptime hasn't tripped
     *  `leadMaxMin`. Default 70 — per George's >30% ctx remaining
     *  directive (23:02 MYT 2026-05-08). Per-team field; only the lead
     *  is gated this way (non-lead members rotate on uptime only per
     *  OQ-A1 default). */
    leadCtxRotateThreshold: z.number().int().min(0).max(100).default(70),

    // ---------- ADR-049 / ADR-053 budget knobs ----------
    /** Pause threshold (% of budget consumed). Default 90. */
    budgetPauseThreshold: z.number().int().min(0).max(100).default(90),
    /** Resume threshold (% of budget remaining). Default 80. */
    budgetResumeThreshold: z.number().int().min(0).max(100).default(80),
    /** Warning bands (fractions of budget remaining). Default
     *  [0.50, 0.25, 0.15] — pings at the 50%/25%/15% remaining marks. */
    budgetWarningBands: z.array(z.number().min(0).max(1)).default([0.5, 0.25, 0.15]),
    /** Lead time before refresh, in minutes. Default 30. */
    budgetRefreshLeadMins: z.number().int().nonnegative().default(30),
    /** Optional Claude account override for budget probe. */
    claudeAccount: z.string().optional(),

    // ---------- ADR-043 (deprecated under R1; back-compat read) ----------
    /** Idle-tick threshold for ADR-043 auto-stop. Default 0 (disabled
     *  under R1 — eternal-improvement Mode B + budget-pause supersede).
     *  Doctor warns when value > 0 (informational; no behavior change). */
    autoStopAfterIdleTicks: z.number().int().nonnegative().default(0),

    // ---------- ADR-055 self-heal opt-in ----------
    /** Enable cursor self-heal recipes. Default false. */
    selfHealEnabled: z.boolean().default(false),
    /** Whitelist of recipe ids the cursor may auto-apply. Default []. */
    selfHealRecipes: z.array(z.string()).default([]),

    // ---------- ADR-085 needs-approval watcher ----------
    /** Whip §2.5: scan proposed-ADR / untriaged-inbox / long-blocked-
     *  kanban buckets each tick, fire Discord ping on `total > 0`,
     *  append a lead-events JSONL row regardless. Default true.
     *  Setting `false` skips scan + ping + JSONL — pure opt-out. */
    needsApprovalEnabled: z.boolean().default(true),

    // ---------- ADR-056 account-swap opt-in ----------
    /** Ordered fallback chain of Claude accounts. Default []. */
    accountFallback: z.array(z.string()).default([]),
    /** Threshold (% of budget) at which account-swap fires. Default 75. */
    accountSwapTriggerThreshold: z.number().int().min(0).max(100).default(75),
    /** Health threshold for fallback selection — a fallback account is
     *  viable when BOTH h5 AND wk pct-used are ≤ this. Default 50
     *  (ADR-056 §D2: "half-used is safe-enough; deeper would over-constrain"). */
    accountSwapFallbackHealthThreshold: z.number().int().min(0).max(100).default(50),
    /** Hard cap per single-member swap (seconds). Aborts the swap (not the
     *  member) if exceeded. Default 300 (ADR-056 §"Push-back" 5-min cap). */
    accountSwapPerMemberDeadlineSec: z.number().int().positive().default(300),
    /** Roles excluded from swap pass — their conversation memory doesn't
     *  survive `atmux handoff`. Default lead/planner/reviewer
     *  (ADR-056 §"Lead/planner exclusion"). */
    accountSwapExcludeRoles: z.array(z.string()).default(["lead", "planner", "reviewer"]),
  })
  .strict();
export type TeamWhip = z.infer<typeof TeamWhip>;

/**
 * `team.json::fallback` sub-config — ADR-058 multi-tier fallback chain
 * (Cursor Tier 2 → Kimi Tier 3 → MiniMax Tier 4).
 *
 * Default-OFF: `enabled: false` is the v1 ship gate. Existing teams
 * see no behavior change until they explicitly opt in. The strict
 * shape catches typos (e.g. `enabld`) at boot via the same drift
 * Discord-ping path as `whip` — applied here too because fallback
 * tiers run as different Linux UIDs (Tier 3+) and a misconfigured
 * `enabled` would silently dispatch into a non-existent provisioned
 * cage.
 *
 * `tierBudgetThresholds` are future-proof knobs for picking-tier-by-
 * remaining-budget — unused in T4 (the v1 selection picks highest
 * tier with capacity per ADR-058 §D2). Surfaced now so the schema
 * doesn't churn when the threshold logic lands.
 */
export const TeamFallback = z
  .object({
    /** Master switch. Default false (no fallback dispatch on pause). */
    enabled: z.boolean().default(false),
    /** Optional per-tier budget thresholds for tier selection. Unused
     *  in T4; surfaced for forward-compat per ADR-058 §D2 OQ7. */
    tierBudgetThresholds: z
      .object({
        tier2Pct: z.number().int().min(0).max(100).optional(),
        tier3Pct: z.number().int().min(0).max(100).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type TeamFallback = z.infer<typeof TeamFallback>;

/**
 * `team.json::cron` sub-config — per-team cron-line PATH override.
 *
 * Cron's bare env on Ubuntu is
 * `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`, which
 * does NOT include `/root/.bun/bin` (bun lives there under mise).
 * atmux-bun's shebang is `#!/usr/bin/env bun`, so cron-fired verbs
 * (whip, report, decisions digest, groom, whip-resume-check, etc.)
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
 * `team.json::report` sub-config — cron cadence for the report /
 * discorder progress + heartbeat lines (ADR-079 §A).
 *
 * Replaces the prior `z.unknown().optional()` placeholder. `.strict()`
 * per `whip` precedent — typo'd keys (`intervalMin` vs `intervalMins`)
 * surface as drift findings rather than silently using the default.
 *
 * Validation note: schema only enforces basic shape (positive int). The
 * cron renderer (`src/core/cron.ts::cronEvery`) throws `ConfigError`
 * when the value is outside 1–60 OR not a divisor of 60 (per ADR-079
 * OQ-A1: throw at render time + warn at config-load time via doctor's
 * `cron-interval-divisor` check).
 */
export const TeamReport = z
  .object({
    /** Cron interval in minutes for `report` (or `discorder progress`).
     *  Default 30. Must be a divisor of 60: 1, 2, 3, 4, 5, 6, 10, 12,
     *  15, 20, 30, 60. */
    intervalMins: z.number().int().positive().default(30),
    /** Cron interval in hours for `discorder heartbeat`. Default 1.
     *  Must be a divisor of 24: 1, 2, 3, 4, 6, 8, 12, 24. */
    heartbeatHours: z.number().int().positive().default(1),
  })
  .strict();
export type TeamReport = z.infer<typeof TeamReport>;

/**
 * `team.json::decisions` sub-config — cron cadence for `decisions
 * digest` (ADR-079 §A). Hourly granularity per ADR — minute-level
 * cadence makes no sense for the 4-hour digest verb.
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
 * `team.json::groom` sub-config — daily groom hour-of-day (ADR-079 §A).
 * Groom runs once per day at the operator-chosen hour (default 04:00,
 * the quietest window).
 */
export const TeamGroom = z
  .object({
    /** Hour-of-day (0–23) at which `groom --quiet` fires. Default 4. */
    atHour: z.number().int().min(0).max(23).default(4),
  })
  .strict();
export type TeamGroom = z.infer<typeof TeamGroom>;

/**
 * `team.json::unblocker` sub-config — cron cadence for the unblocker
 * tick line (ADR-079 §A). Only emitted when the team has a member with
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
 * gate lives here.
 *
 * Naming: bash `lib/claim.sh:200` + `templates/briefs/member.md` use
 * `kanban.crossLaneClaim` (boolean, default true). ADR-062 §OQ4 also
 * mentioned `lanePickup.strict=true` as inverse — the field landed
 * under `kanban.crossLaneClaim` to match the existing brief + bash
 * precedent (workers read the brief; one canonical name beats two
 * equivalent ones). `crossLaneClaim=true` ≡ `lanePickup.strict=false`.
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
     *  block on `atmux start` (whip / report-or-discorder / decisions /
     *  groom / optional whip-resume-check / optional unblocker). When
     *  `false`, `atmux start` skips cron entirely and the operator must
     *  run `atmux cron-install` manually. Bash precedent at
     *  `lib/start.sh:378-387`: default `true` because most teams want
     *  scheduled supervision; the opt-out exists for hosts that manage
     *  cron out-of-band. `ATMUX_NO_CRON=1` short-circuits the same path
     *  for test sandboxes — the env wins over this flag. */
    cronAutoInstall: z.boolean().default(true),
  })
  .strict();
export type TeamKanban = z.infer<typeof TeamKanban>;

/**
 * `team.json::gitter` sub-config — gitter-member knobs.
 *
 * ADR-080 §B2: lane-tick's auto-done scan calls `findCommitForTask` to
 * back-fill `atmux done` for in-progress `commit t-X` tasks whose commit
 * already landed on disk but whose kanban entry never closed (operator-
 * observed sopx pain: 29 stale `commit t-X` tasks at 07:14 MYT
 * 2026-05-09). The scan needs a repo path; `repoPath` is optional with
 * a default resolved at the call site (atmux-dir's parent — the most
 * common shape per OQ-B1).
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
     *  `atmux start` provisions a worktree under
     *  `worktreeRoot/<member>/` for each member and rewires
     *  `member.cwd` to that path; stop / doctor / cockpit honor the
     *  same root. Optional + effectively `false` — existing teams keep
     *  the shared-tree behavior with no `team.json` migration. Opt in
     *  per-team by setting `worktreeIsolation: true`. Read-sites should
     *  default via `team.worktreeIsolation === true` (truthy check)
     *  rather than relying on schema-fill, mirroring the
     *  `singleSession` pattern. */
    worktreeIsolation: z.boolean().optional(),
    /** ADR-082 §2: directory (relative to the team's project root)
     *  where per-member worktrees live when
     *  `worktreeIsolation === true`. Effective default
     *  `.atmux/worktrees`; co-locates with the team's existing
     *  `.atmux/` state directory so the cleanup path mirrors the rest
     *  of the team's filesystem footprint. No-op when isolation is
     *  off. Use {@link DEFAULT_WORKTREE_ROOT} when reading. */
    worktreeRoot: z.string().optional(),
    /** ADR-088: when `true` AND `worktreeIsolation === true`, `atmux start`
     *  passes `initSubmodules: true` through to `provisionWorktree`, which
     *  runs `git submodule update --init --recursive` inside each newly
     *  created worktree. Best-effort: a non-zero exit warns to stderr but
     *  does not abort provisioning. Default `false` — teams without
     *  submodules pay zero cost; teams with submodules opt in explicitly. */
    worktreeInitSubmodules: z.boolean().optional(),
    /** Single-session opt-in (default `false` per 2026-04-30 reversal,
     *  see templates/team.example.json comment). */
    singleSession: z.boolean().optional(),
    /** TUI to auto-spawn in the cage's driver window on `atmux start`. */
    driverTui: z.string().nullable().optional(),
    /** ADR-044: when set, the team session is created with `driver` as
     *  window 1 (in place of the `__home` placeholder). Members spawn as
     *  windows 2..N+1 in declarative order. `null` is accepted as
     *  "explicitly disabled" (matches existing wizard output). Resolution
     *  order for the TUI command: `driverSession.tui` → `driverTui` →
     *  `"claude"`.
     *
     *  ADR-064 §5 + §OQ5: `command` field dropped 2026-05-08 — verified
     *  zero call sites pre-edit; no consumer ever read it (only `.tui`
     *  is wired through `src/verbs/start.ts:344`). Strict-mode rejects
     *  any `team.json` that still sets it; clean-cut, no deprecation
     *  cycle per OQ5 (planner verified no live config sets the key). */
    driverSession: z
      .object({
        tui: z.string().nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),
    /** Member roster. Order is preserved (window layout depends on it). */
    members: z.array(TeamMember),
    emojis: TeamEmojis.optional(),
    /** ADR-054: typed whip sub-config with strict drift detection. */
    whip: TeamWhip.optional(),
    /** ADR-058: multi-tier fallback chain (Cursor/Kimi/MiniMax). */
    fallback: TeamFallback.optional(),
    /** Per-team cron PATH override (bug t-2db59eee). */
    cron: TeamCron.optional(),
    /** ADR-062 §OQ4: kanban-orchestration knobs (cross-lane fallback). */
    kanban: TeamKanban.optional(),
    /** ADR-079 §A: cron cadence for report / discorder progress + heartbeat. */
    report: TeamReport.optional(),
    /** ADR-079 §A: cron cadence for `decisions digest`. */
    decisions: TeamDecisions.optional(),
    /** ADR-079 §A: daily groom hour-of-day. */
    groom: TeamGroom.optional(),
    /** ADR-079 §A: cron cadence for `unblocker tick`. */
    unblocker: TeamUnblocker.optional(),
    /** ADR-080 §B2: gitter-member knobs (auto-done scan repo path). */
    gitter: TeamGitter.optional(),
    /** Phase 2 sub-shapes — typed once verb porters land. */
    discord: z.unknown().optional(),
    tuiCommands: z.unknown().optional(),
  })
  .passthrough();
export type Team = z.infer<typeof Team>;

/** ADR-082 §2: effective default for `team.worktreeRoot` when the field
 *  is unset. Co-located with the schema so read-sites in W3 (start),
 *  W4 (stop), and W5 (doctor) share the same constant. */
export const DEFAULT_WORKTREE_ROOT = ".atmux/worktrees";
