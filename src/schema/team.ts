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
    /** ADR-136 (Option B): display label decoupled from member `name`.
     *  When set, the display layer (buildWindowName, status, Discord,
     *  briefs) uses `label`; the `name` field remains the immutable id
     *  (kanban owner refs, state-file keys, socket-pubsub topics). When
     *  unset, the display layer falls back to `name` — zero migration
     *  for existing teams. Refine rule rejects `:` and `.` because both
     *  are tmux window-name separator chars and would break
     *  `__<team>__<member>` parsing. */
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
     *  open-string (does NOT tighten to a closed enum) — current rosters
     *  use a wide variety of role values (docs / devops / dba / discorder
     *  / unblocker / etc.); tightening to enum here would break working
     *  teams. The role-enum closure is deferred to a follow-up ADR.
     *  Legacy `gitter` parse triggers no in-schema warn — the doctor
     *  probe `team-legacy-gitter-role` (registered separately) surfaces
     *  the deprecation. Removal: one release cycle per ADR-159 §Removal
     *  timeline. */
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
    /** ADR-157 §D4 — explicit runtime selector for the per-member
     *  TUI flavor. When `"cursor"`, the member runs under Cursor CLI
     *  (martinet path per ADR-132 + ADR-140) and `goal` (below) is a
     *  WARN-not-refuse no-op: Cursor has no `/goal` skill equivalent,
     *  so the field is allowed for partial-migration scenarios but
     *  doesn't drive a self-nudge loop. Default-unset → falls back
     *  to TUI-driven runtime detection via `tui` (cursor / claude /
     *  shell / ...). Free-form string for forward-compat with future
     *  runtimes (per ADR-005 `tui: z.string()` precedent). */
    runtime: z.string().optional(),
    /** ADR-157 §D2 — per-role unsatisfiable-in-steady-state goal
     *  injected via Claude Code v2.1.139+ `/goal` skill. Drives the
     *  per-turn Haiku evaluator that self-nudges the member back into
     *  the work loop with sub-second latency. Optional + additive.
     *
     *  Goal-phrasing rule (load-bearing per ADR-157 §Decision-anchor
     *  #1): the predicate MUST re-satisfy when real-world state
     *  regresses (a new commit lands, a new complaint files). Goals
     *  that satisfy once + never fire again halt the member
     *  permanently — opposite of intent. Reviewer pre-flag at every
     *  goal addition.
     *
     *  Runtime gate (ADR-157 §D4): when `runtime === "cursor"` this
     *  field is a WARN-not-refuse no-op — Cursor CLI has no `/goal`
     *  equivalent. Accept the value so partial migrations don't block
     *  schema load; runtime hooks (T3) short-circuit before injecting.
     *
     *  Resolution chain (ADR-157 §D2 / §OQ3): this explicit field
     *  takes precedence over the brief-parsed `## Standing Goal`
     *  section. See `src/core/goal-resolver.ts::resolveGoalForMember`
     *  — single source of truth; downstream hooks must NOT
     *  brief-parse directly. Empty string = explicit opt-out
     *  (per goal-resolver test contract). */
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

    // ---------- ADR-087 velocity-gate cadence knobs ----------
    /** ADR-087 §Spec. Per-team tunables for the whip velocity-gate
     *  classifier + strike counter. Operators rarely need to tune —
     *  the defaults match the operator-observed failure mode that
     *  drove the ADR (10 zero-commit heartbeats over 4.5h). The
     *  feature kill-switch is `crons.whipVelocityGateEnabled` (lives
     *  in `crons` for fleet-consistent shape with `laneTickEnabled`);
     *  this sub-config carries the threshold knobs. */
    velocityGate: z
      .object({
        /** Sliding window (minutes) over which the classifier counts
         *  ground-truth commits. Default 60 — one hour; matches the
         *  operator's "an hour without a commit on an active team is
         *  the threshold of suspicion" framing in the Task body. */
        windowMin: z.number().int().positive().optional(),
        /** Strike count that escalates to a complaint via the
         *  superdoctor-escalation pipeline (sibling Task t-e91fec98).
         *  Default 3 — matches Task body §6 "3+ strikes → file
         *  complaint for superdoctor". */
        strikeThreshold: z.number().int().positive().optional(),
        /** Standby grace window (minutes) — if a ground-truth commit
         *  landed within this lookback, BAD is downgraded to STANDBY
         *  (someone shipped recently; the team is not stalled, just
         *  catching breath). Default 30 — half the main window, so
         *  the "we just shipped, lead reading the next Task" state
         *  doesn't strike. */
        standbyGraceMin: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),

    // ---------- ADR-057 v1.1.x stall-prevention block ----------
    /** ADR-057 stall-prevention config. Carries the heartbeat staleness
     *  threshold consumed by `atmux watchdog` (§D6b) + `atmux status`
     *  (§D6c), plus the auto-push-on-done knobs consumed by the done-leg
     *  of `atmux claim` (§D7).
     *
     *  Pre-promotion the shape lived as a defensive `as { ... unknown
     *  }` cast in three places (src/core/auto-push.ts + src/verbs/
     *  watchdog.ts + src/verbs/status.ts). Schema-level promotion turns
     *  typos (`heartbeatStaleSecond`) into refusals at boot (surfaced
     *  via the existing whip-config-drift ping) instead of silent
     *  defaults at every read site. */
    stallPrevention: z
      .object({
        /** Heartbeat staleness threshold (s). Default 300 (5min) per
         *  ADR-057 §D6. Watchdog flags + status renders `💔` when
         *  age > this value. */
        heartbeatStaleSec: z.number().int().positive().default(300),
        /** ADR-057 §D7: push the per-member branch on every `atmux
         *  done` transition. Default true — surfaces drift early. The
         *  CLAUDE.md push policy continues to gate
         *  `origin/<base>-staging` targets via runAutoPush refusal. */
        autoPushOnDone: z.boolean().default(true),
        /** Rebase the per-member branch on origin/<base> before push.
         *  Default true — keeps criss-cross history bounded per
         *  ADR-082. */
        rebaseBeforePush: z.boolean().default(true),
        /** Explicit allow-list of push targets (rare; for non-standard
         *  trunk shapes). Empty list means "any branch except the
         *  CLAUDE.md push-policy refusal targets". Default []. */
        allowedPushBranches: z.array(z.string()).default([]),
      })
      .strict()
      .optional(),

    // ---------- ADR-050 fallback chain v1 (Tier 2 Cursor only) ----------
    /** ADR-050 §Decision. Per-team Tier 2 (Cursor) fallback policy for
     *  budget-pause recovery. Distinct from `team.fallback` (top-level,
     *  ADR-058 multi-tier cascade) — v1 narrows to Tier 2 only with a
     *  refuse-at-load `tier: z.literal(2)` so a misconfigured Tier 3+
     *  value can't reach the v1 spawn path. Tier 3+ stays available
     *  via the ADR-058 entry points (`dispatchFallbackOnPause`); the
     *  v1 narrow path (`spawnFallbackCage` / `teardownFallbackCage`)
     *  hits this sub-config. Once ADR-050b folds in Tier 3+, this
     *  literal lifts. Default: every field has a default → omitting
     *  the whole `fallback` block is equivalent to `enabled: false`
     *  (existing teams see no behavior change). */
    fallback: z
      .object({
        /** Master switch (v1 path). Default `false` — operator opts
         *  in per-team after reading ADR-050 §Trigger semantics. */
        enabled: z.boolean().default(false),
        /** Minutes the budget-pause must be continuously active
         *  before fallback fires. Default 30 — matches ADR-050
         *  §Trigger §1 "one-off rate-limit blips that resolve
         *  <30min do NOT spawn a fallback cage". Min 5 — anything
         *  shorter risks spawning a cage that immediately gets torn
         *  down when the resume tick arrives. */
        sustainMins: z.number().int().min(5).default(30),
        /** ADR-050 v1 supports Tier 2 only. `z.literal(2)` rejects
         *  any other value at schema-load (the schema-layer half of
         *  the Reviewer-pre-flag "defense-in-depth refuse at
         *  schema-load + call-site" gate). Tier 3+ deferred to
         *  ADR-050b — different isolation model (dedicated Linux
         *  user, ACL-restricted workspace, no .git in cage). */
        tier: z.literal(2).default(2),
        /** Cursor model passed to `cursor-agent --print --model
         *  <value> --force`. Default `composer-2` per ADR-050
         *  §"Cursor's mutative-git path is e2e-validated" reference. */
        cursorModel: z.string().default("composer-2"),
      })
      .strict()
      .optional(),
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
 * `team.json::groom` sub-config — daily groom hour-of-day (ADR-079 §A)
 * + per-sub-op opt-in toggles. Groom runs once per day at the operator-
 * chosen hour (default 04:00, the quietest window).
 */
export const TeamGroom = z
  .object({
    /** Hour-of-day (0–23) at which `groom --quiet` fires. Default 4. */
    atHour: z.number().int().min(0).max(23).default(4),
    /** ADR-062 §5 follow-up: invoke lane-drift-check as part of groom's
     *  daily sweep. Optional: when **unset**, the sub-op auto-enables
     *  iff `team.members[]` contains ≥1 entry with a non-empty `.lane`
     *  field (same auto-shape as `crons.laneTickEnabled`). **Explicit
     *  `false`** suppresses the sub-op regardless of roster — operators
     *  who want fast-feedback only via the every-2-min cron line + standalone
     *  `atmux lane-drift-check` toggle this off. **Explicit `true`**
     *  always runs (even with zero lane-tagged members, where it's a
     *  trivial no-op). Pairs with the standalone `atmux lane-drift-
     *  check` verb — both paths coexist (cron for fast feedback, groom
     *  for end-of-day catch-the-stragglers per Task t-3aa587cb). */
    laneDriftCheck: z.boolean().optional(),
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
 * `team.json::crons` sub-config — per-line cron kill-switches (ADR-062
 * §Rollback). Lets operators disable specific cron-emitted lines
 * without a code change. Distinct from cadence knobs (`whip`, `report`,
 * `decisions`, `groom`, `unblocker`) which live in their own sub-
 * objects; `crons` is the place for boolean enable/disable toggles
 * scoped to the cron emitter.
 *
 * Today only `laneTickEnabled` lives here (ADR-062 §Decision 4). Future
 * line-level kill-switches (e.g. `whipResumeCheckEnabled` for teams
 * that want claudeAccount probes but no auto-resume cron tick) would
 * land here too.
 */
export const TeamCrons = z
  .object({
    /** ADR-062 §Rollback. When `false`, suppress the `lane-tick` cron
     *  line even if the team has lane-tagged members. Default
     *  `true` (effective only when the gating member-condition holds —
     *  teams with zero `.lane`-tagged members skip the line regardless).
     *  Operators flip this off to halt lane-driven auto-claim without
     *  removing `.lane` annotations from `team.members[]`. */
    laneTickEnabled: z.boolean().default(true),
    /** ADR-087 §Rollback. Velocity-gate kill-switch. When `false`,
     *  whip skips ground-truth velocity classification + strike-counter
     *  bumping entirely (effectively reverting to pre-ADR-087 fake-
     *  liveness reliance on lead self-report). Default `true` — the
     *  gate is opt-OUT, not opt-in, because the operator-observed
     *  failure mode (10 zero-commit heartbeats over 4.5h) is what
     *  ADR-087 was authored to prevent. Pairs with
     *  `whip.velocityGate` cadence knobs (window minute count + strike
     *  threshold); the kill-switch lives here for fleet-consistent
     *  shape with `laneTickEnabled`. */
    whipVelocityGateEnabled: z.boolean().default(true),
    /** ADR-157 §D6 — lane-tick cron cadence override (minutes). Default
     *  5 — `/goal` (Claude Code v2.1.139+ skill) drives fast handoff
     *  on the happy path via per-turn Haiku evaluator; lane-tick runs
     *  at 5min as a structural backstop for failure modes /goal cannot
     *  see (wedged panes, rate-lockouts, compaction-wipe). Lower bound
     *  floor is /goal mean-time-to-detect-failure × 2 (~5min); ceiling
     *  10min (cron `\*\/10`) acceptable with operator validation. Must be a divisor
     *  of 60 — `cronEvery` refuses non-divisors (1, 2, 3, 4, 5, 6, 10,
     *  12, 15, 20, 30, 60). Pre-ADR-157 default was 2; teams upgrading
     *  pick up the new cadence on next `atmux start` / `atmux
     *  cron-install`. */
    laneTickMins: z
      .number()
      .int()
      .positive()
      .refine((n) => [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60].includes(n), {
        message:
          "laneTickMins must be a divisor of 60 (1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60) — cronEvery rejects non-divisors per ADR-062",
      })
      .default(5),
  })
  .strict();
export type TeamCrons = z.infer<typeof TeamCrons>;

/** ADR-157 §D6 default cadence for lane-tick — pre-T5 was 2 (cron
 *  `\*\/2 \* \* \* \*`); T5 relaxes to 5 because /goal handles fast
 *  handoff on the happy path. Co-located with the schema so cron
 *  renderer + tests share the constant. */
export const DEFAULT_LANE_TICK_CRON_MINS = 5;

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

/**
 * t-e89c03f7: observability sub-shape — opt-in toggles for forensic
 * data collection that's useful for offline analysis but isn't load-
 * bearing for any live verb. Symmetric with ADR-062 lane-tick gating
 * (the same field shape is used to opt into expensive observability
 * paths without making them mandatory).
 */
/** ADR-088 §Decision-2+3+6: per-member-branch fan-in policy ("merger"
 *  role). Worktree-isolated teams accumulate `<base>-<member>` branches
 *  whose commits never automatically return to `<base>`. Opt-in
 *  `team.merger.enabled` activates either a `merger` member role
 *  (Shape A) or driver-fired `atmux merge-cycle` verb (Shape B) — both
 *  consume the same effective config. Defaults preserve the
 *  pre-ADR-088 behaviour (operator-manual fan-in). */
export const TeamMerger = z
  .object({
    /** When `true`, fan-in automation is enabled: a `merger` member
     *  with role=`merger` runs the standard claim+work loop, or the
     *  `atmux merge-cycle` cron-template fires unattended. Default
     *  `false` — existing teams unaffected. */
    enabled: z.boolean().default(false),
    /** Branch to merge per-member branches into. Optional — when
     *  unset, `resolveMergerConfig` resolves it at read-time via
     *  `git -C <repoPath> branch --show-current` (mirrors ADR-088
     *  §Decision-3 pseudocode). Explicit value useful when the team
     *  operates on a branch other than the parent worktree's current
     *  HEAD (e.g. cron-fired merges against a fixed `<product>-staging`
     *  branch — gated by the push-policy guard in W2). */
    baseBranch: z.string().min(1).optional(),
    /** Hours-of-staleness threshold for the W6 `merger-branch-stale`
     *  doctor probe. A `<base>-<member>` branch with commits older
     *  than this AND zero merge-back fires the probe. Default `24`
     *  (one-day fan-in cadence target). */
    stalenessHours: z.number().int().min(1).default(24),
    /** ADR-088 §Decision-5 / W7 (t-2f12839e) — cron cadence for the
     *  `atmux merge-cycle` line (added to the team's standard cron
     *  block only when `enabled === true`). Default `15` (minutes);
     *  must be one of cron's divisor-of-60 set (1, 2, 3, 4, 5, 6, 10,
     *  12, 15, 20, 30, 60). The `cronEvery` renderer fail-fasts on
     *  non-divisors, but specifying directly here keeps the operator's
     *  intent visible in team.json. `atmux cron-install --template
     *  merge-cycle --interval <N>` accepts a transient override that
     *  applies for the install without rewriting this field. */
    cycleIntervalMins: z.number().int().positive().optional(),
  })
  .strict();
export type TeamMerger = z.infer<typeof TeamMerger>;

/** ADR-088 §Decision-5 / W7 default — used by `cron.ts::renderCronLines`
 *  + `cron-install` verb when `team.merger.cycleIntervalMins` is unset.
 *  Matches the 15-min default the ADR specifies. */
export const DEFAULT_MERGER_CYCLE_INTERVAL_MINS = 15;

/** ADR-134 §Config: per-team auto-merger config (intra-team gitter
 *  event-driven + cron-backstop fan-in). Separate from {@link TeamMerger}
 *  (ADR-088 bulk-merge-cycle verb) — they target different scopes:
 *  - `team.merger` — operator-fired `atmux merge-cycle` bulk pass,
 *    per ADR-088.
 *  - `team.autoMerge` — gitter member's event-driven auto-merge +
 *    cron-backstop sweep, per ADR-134.
 *
 *  The two can coexist: a team can opt into both ADR-088's hand-fired
 *  bulk pass AND ADR-134's continuous gitter auto-merge. They serialize
 *  through the same {@link MergerStateRepo} (ADR-091 + ADR-134 shared
 *  state machine), so concurrent firings are safe — BEGIN IMMEDIATE
 *  serializes the transitions.
 *
 *  Default state: absent (existing teams keep manual fan-in unchanged).
 *  Recommendation: enable on `worktreeIsolation: true` teams; the
 *  gitter brief (T6) auto-routes to worktree-fan-in mode when the
 *  block is present and `enabled === true`.
 *
 *  Schema landed in this commit (ADR-134 T4 / t-64e52aac) as the first
 *  consumer (the cron-backstop sweep). Other consumers — T6 gitter
 *  member impl, T7 cron-install template wiring, T8 e2e — read these
 *  fields without re-defining the surface. */
export const TeamAutoMerge = z
  .object({
    /** Master switch per ADR-134 §Config. Default `false` when the
     *  block is absent OR `enabled` is unset; existing teams keep the
     *  pre-ADR-134 manual fan-in. ADR's "true when worktreeIsolation
     *  is true" recommendation is operator-driven, not schema-default,
     *  to preserve back-compat — every existing `worktreeIsolation`
     *  team would otherwise flip silently. */
    enabled: z.boolean().default(false),
    /** ADR-134 §Config: when `true`, the gitter waits for a
     *  `reviewer-trunk-signoff` task on the member's branch before
     *  transitioning `ready_to_merge → merging`. v1 default `false`;
     *  forward-compat for teams that want a reviewer gate on every
     *  fan-in. Honored by T6 gitter member loop; the cron sweep
     *  (T4 / this commit) doesn't read this field — the gate fires
     *  at the per-merge step, not the queue step. */
    requireReviewerSignoff: z.boolean().default(false),
    /** ADR-134 §Config OQ-1: skip the post-merge `tested` state
     *  entirely. `false` (the default) runs `testCommand` after every
     *  merge; `true` short-circuits `merging → merged` and is the
     *  escape hatch for docs-only / archival-only teams. Honored by
     *  T6 gitter member loop. */
    skipTestGate: z.boolean().default(false),
    /** ADR-134 §Config OQ-1: the shell command the gitter runs to
     *  gate `merging → tested → merged`. Default `"bun test"` matches
     *  the atmux team's CI gate; per-team override (e.g. sopx might
     *  use `"pnpm test:unit"`). Honored by T6 gitter member loop. */
    testCommand: z.string().min(1).default("bun test"),
    /** ADR-134 §Config OQ-2: when `true` (default), a failed
     *  `testCommand` causes the gitter to `git revert` the merge
     *  commit and transition to `reverted` (terminal). When `false`,
     *  the gitter pauses at `test_failed` and pings the operator
     *  without reverting. Honored by T6 gitter member loop. */
    revertOnFail: z.boolean().default(true),
    /** ADR-134 §Config: cadence in minutes for the cron backstop
     *  sweep. Default `10`. Consumed by T7's cron-install template
     *  emission — this field is the cadence input to `cronEvery(N)`.
     *  T4's `atmux committer --sweep` verb is cadence-agnostic; it runs
     *  on whatever interval the cron line fires. Must be a divisor of
     *  60 for `cronEvery` (1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60);
     *  the renderer fail-fasts on non-divisors at install time. */
    cronBackstopMin: z.number().int().positive().default(10),
    /** ADR-134 §Config OQ-3: rate-limit the gitter to N merges/hour.
     *  Default `null` (uncapped) per the ADR's v1 recommendation;
     *  numeric value gates `ready_to_merge → merging` when the
     *  trailing-hour merge count is at or above the cap. Honored by
     *  T6 gitter member loop. */
    maxMergesPerHour: z.number().int().positive().nullable().default(null),
  })
  .strict();
export type TeamAutoMerge = z.infer<typeof TeamAutoMerge>;

/** ADR-134 §Config default — used by T4's `committer --sweep` cron line
 *  emission (T7 cron-install template) when `team.autoMerge
 *  .cronBackstopMin` is unset. Matches the 10-min default the ADR
 *  specifies; co-located with the schema so non-Zod call sites (cron
 *  renderer, T7 install) share the same constant. */
export const DEFAULT_AUTO_MERGE_CRON_BACKSTOP_MIN = 10;

export const TeamObservability = z
  .object({
    /** t-e89c03f7: when true, every UNKNOWN classification from
     *  `classifyPane` appends a redacted-evidence row to
     *  `<atmuxDir>/logs/pane-state-unknown.jsonl`. Used for the
     *  Phase B classifier-extension pass (top-N pattern catalog
     *  refinement). Default false — opt-in to avoid disk churn on
     *  teams that aren't analyzing the data. */
    paneStateUnknownLog: z.boolean().optional(),
  })
  .strict();
export type TeamObservability = z.infer<typeof TeamObservability>;

/**
 * `team.json::sentinel` enum — pluggable cockpit-W3 whip-manager impl
 * picked for this team. Two-impl set per the 2026-05-14 12:53 MYT
 * ADR-132 simplification (MiniMax + Kimi dropped as "unreliable and
 * not smart enough"; `claude` is the degenerate baseline, `cursor`
 * runs composer-2-fast as the production default).
 *
 * Adding a new backend requires extending this enum AND
 * `Sentinel["name"]` in `src/abstractions/sentinel.ts` in lockstep —
 * the runtime resolver (`resolveSentinel`) lives in
 * `src/core/sentinel-config.ts` and bridges schema-string to impl-
 * factory dispatch.
 */
export const SentinelImpl = z.enum(["claude", "cursor"]);
export type SentinelImpl = z.infer<typeof SentinelImpl>;

/**
 * `team.json::sentinelOverrides` — per-team knobs that compose over
 * the impl-side defaults baked into each Sentinel factory. Both
 * fields opt-in; the resolver merges-by-key so explicit values win
 * over per-impl defaults.
 *
 * `.strict()` consistent with the surrounding sub-blocks — drift
 * detection requires unknown-key rejection (ADR-054 §D3).
 */
export const TeamSentinelOverrides = z
  .object({
    /** Per-tick cadence in seconds. Per-impl defaults: `claude` 270s,
     *  `cursor` 270s (per ADR-132 §D3 — both stay aligned with the
     *  existing 270s whip cadence; tuned per-team only when commit
     *  cadence pressure or budget pressure demands it). */
    cadenceSec: z.number().int().positive().optional(),
    /** Self-confidence floor (0.0-1.0) below which the non-Claude
     *  Sentinel escalates instead of acting autonomously. Default
     *  0.7 per ADR-132 §D5 E5. Ignored by ClaudeSentinel (the
     *  degenerate impl has no self-confidence signal). */
    escalationConfidenceThreshold: z.number().min(0).max(1).optional(),
  })
  .strict();
export type TeamSentinelOverrides = z.infer<typeof TeamSentinelOverrides>;

/** ADR-132 §D5 E5 default — non-Claude Sentinel's self-confidence
 *  floor. Below this, the impl escalates to the Claude lead instead
 *  of firing the action. Co-located with the schema so resolver
 *  call-sites share the constant. */
export const DEFAULT_SENTINEL_ESCALATION_CONFIDENCE = 0.7;

/** ADR-132 §D3 default — per-tick cadence in seconds for both
 *  shipping impls. ClaudeSentinel matches the legacy 270s whip
 *  cadence; CursorSentinel matches it for parity. */
export const DEFAULT_SENTINEL_CADENCE_SEC = 270;

/**
 * `team.json::ombudsman` sub-config — ADR-147 §D1 + §D2. Per-team
 * complaint adjudicator role. Sentinel + cron wake; opt-in (default
 * disabled). The cron tick line is gated on BOTH
 * `team.ombudsman.enabled === true` AND `team.members[]` containing
 * an entry with `role: "ombudsman"` — absent either, the line is
 * suppressed (matches the `unblocker` precedent of gating cron output
 * on member-roster presence).
 *
 * `.strict()` consistent with sibling sub-blocks (whip / fallback /
 * merger) — drift detection requires unknown-key rejection (ADR-054 §D3).
 */
export const TeamOmbudsman = z
  .object({
    /** Master switch. Default `false` — existing teams keep current
     *  manual-adjudicate-via-operator behavior. Setting `true` AND
     *  including a `role: "ombudsman"` member activates the cron tick
     *  + sentinel-driven wake. */
    enabled: z.boolean().default(false),
    /** Cron interval in minutes for `atmux ombudsman tick`. Default
     *  resolved at read-time via {@link DEFAULT_OMBUDSMAN_TICK_INTERVAL_MINS}
     *  (15 per ADR-147 §D2). Must ultimately be a divisor of 60 for
     *  the `cronEvery` renderer (1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30,
     *  60); the renderer fail-fasts on non-divisors at install time.
     *  Schema enforces positive-integer shape only (matches
     *  TeamUnblocker / TeamReport precedent). */
    tickIntervalMins: z.number().int().positive().optional(),
  })
  .strict();
export type TeamOmbudsman = z.infer<typeof TeamOmbudsman>;

/** ADR-147 §D2 default — used by `cron.ts::renderCronLines` + the
 *  `atmux ombudsman tick` code path when
 *  `team.ombudsman.tickIntervalMins` is unset. Co-located with the
 *  schema so non-Zod call sites (cron renderer, tick verb) share the
 *  same constant — mirrors the
 *  {@link DEFAULT_MERGER_STALENESS_HOURS} / {@link DEFAULT_SENTINEL_CADENCE_SEC}
 *  precedent. */
export const DEFAULT_OMBUDSMAN_TICK_INTERVAL_MINS = 15;

/** ADR-148 §D7 default — used by `cron.ts::renderCronLines` + the
 *  `atmux lane-stall-tick` verb when `team.cadence.laneStallMinAgeSec`
 *  is unset. Co-located with the schema so non-Zod call sites
 *  (cron renderer, tick verb, decideLaneStall) share the same
 *  constant — mirrors {@link DEFAULT_OMBUDSMAN_TICK_INTERVAL_MINS} /
 *  {@link DEFAULT_MERGER_STALENESS_HOURS} precedent.
 *
 *  Note: the {@link TeamCadence} + {@link TeamCadenceThresholds} Zod
 *  schemas defined further below are the canonical surfaces; an earlier
 *  duplicate pair (T3 / t-e9424574) was removed in the trunk fan-in
 *  cleanup so cron / lane-stall / status consumers all share one
 *  schema. The two `DEFAULT_LANE_STALL_*` constants live here, between
 *  the modal-cycling block and the canonical cadence schema, because
 *  `src/verbs/lane-stall-tick.ts` and `src/core/cron.ts` consume them
 *  without needing to import the Zod symbol. */
export const DEFAULT_LANE_STALL_MIN_AGE_SEC = 1800;

/** ADR-148 §D4 / T3 — default cron cadence for the `lane-stall-watch`
 *  cron line, in minutes. 5min per the task body ("Cadence runs every
 *  5min"). Distinct from `DEFAULT_LANE_STALL_MIN_AGE_SEC` (task-age
 *  threshold) — this is the cron interval; that one is the Task
 *  must-be-this-old gate inside the verb. */
export const DEFAULT_LANE_STALL_CRON_INTERVAL_MINS = 5;

/**
 * `team.json::epicTeam` — ADR-090 §Schema. Ephemeral epic-team config
 * block. Presence means the team is an epic-team (a child of some parent
 * team that lives at `<projectRoot>-epics/<epicId>/`); absence means
 * normal team (the existing topology).
 *
 * **§Decision-anchor #3 carve-out** (HARD CONFLICT with ADR-084 per
 * ADR-090): when `epicTeam` is set, `worktreeIsolation` MUST be `false`.
 * The cross-field refinement on the `Team` schema enforces this at
 * `loadTeam` time — `team.epicTeam !== undefined && worktreeIsolation
 * === true` refuses with an explicit error citing ADR-090 §Decision-
 * anchor #3. Members of an epic-team SHARE one worktree (the epic-team's
 * project root); per-member-branch isolation does NOT apply at this
 * scope.
 *
 * **§Decision-anchor #6**: `mergeMode: "pr"` is schema-accept-but-
 * runtime-noop in v1. The schema validates both values; ADR-091's
 * auto-merge state machine only handles `"auto"` at this writing.
 * `pr`-mode runtime impl is deferred to a future ADR.
 *
 * **§Decision-anchor #8 + #9**: when `mergeMode === "pr"`, `prTarget.base`
 * AND `prAuthorUser` are REQUIRED. The Team-level superRefine enforces
 * the cross-field gates; this sub-schema marks them `.optional()` so the
 * auto-mode happy-path keeps zero required pr-fields.
 *
 * `.strict()` consistent with sibling sub-blocks (ombudsman / cadence /
 * autoMerge) — typo'd keys surface as drift findings (ADR-054 §D3).
 */
export const TeamEpic = z
  .object({
    /** Parent team name. Cockpit walk uses this to attach the epic-team
     *  cage under the parent's tmpdir at
     *  `/tmp/atmux-<parent>/epics/<epicId>/sock` (per ADR-089 §Pillar 1). */
    parent: z.string().min(1),
    /** Parent's `state.db` Epic row id (`e-XXXXXXXX`). Parent reads
     *  child's SQLite directly to render progress; this back-pointer lets
     *  a child surface conflicts/notes back to the right parent EPIC row. */
    parentEpicKanbanId: z.string().min(1),
    /** Parent branch the epic-team will merge into. Used by ADR-091's
     *  auto-merge state machine + `dissolve-epic` cleanup. Example: `"main"`,
     *  `"geoyws"`, `"sopx-geoyws"`. */
    parentBase: z.string().min(1),
    /** Merge mode for ADR-091 auto-merge state machine. `"auto"` runs the
     *  direct merge (default). `"pr"` is schema-accept-but-runtime-noop
     *  per §Decision-anchor #6 — accepted at schema, no-op at runtime in
     *  v1. Future ADR ships the pr-mode runtime. */
    mergeMode: z.enum(["auto", "pr"]).default("auto"),
    /** §Decision-anchor #8: required when `mergeMode === "pr"` (Team-level
     *  superRefine refuses on missing `prTarget.base` under pr-mode).
     *  `remote` defaults to `"origin"`; `base` has NO default
     *  (operator-explicit to prevent silent-wrong-base merges). */
    prTarget: z
      .object({
        remote: z.string().default("origin"),
        base: z.string().min(1),
      })
      .strict()
      .optional(),
    /** §Decision-anchor #9: required when `mergeMode === "pr"` (Team-level
     *  superRefine refuses on missing under pr-mode). Names the `gh` CLI
     *  user that owns PR creation; ADR-091's pr-mode runtime resolves at
     *  PR-creation time via `gh auth switch --user <prAuthorUser>`. */
    prAuthorUser: z.string().optional(),
  })
  .strict();
export type TeamEpic = z.infer<typeof TeamEpic>;

/** `team.json::modalCycling` — ADR-142 modal-cycling detector tunables.
 *  All fields optional; defaults applied at the call-site per ADR-142
 *  §Configuration. `.strict()` so typos (`windowMins` etc.) trip the
 *  same drift-detection ping as `whip` / `gitter`. */
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

/** ADR-148 §D2/§D7: cadence-classifier thresholds. All four ages are
 *  in seconds; defaults applied at the call-site per
 *  {@link DEFAULT_CADENCE_THRESHOLDS}. Strict-mode rejects typos so a
 *  misspelled `shippingMaxAgesSec` trips the same drift-detection ping
 *  as the surrounding `whip` / `gitter` sub-blocks (ADR-054 §D3). */
export const TeamCadenceThresholds = z
  .object({
    /** Below this age (seconds since last commit) AND ≥1 commit in
     *  the configured window → verdict `shipping`. Default 1800 (30min). */
    shippingMaxAgeSec: z.number().int().positive().optional(),
    /** Below this age AND zero commits in window → verdict `idle`
     *  (member could resume soon). Default 7200 (2h). */
    idleMaxAgeSec: z.number().int().positive().optional(),
    /** At or above this age AND zero commits in window → verdict
     *  `dormant`. Default 21600 (6h). */
    dormantMaxAgeSec: z.number().int().positive().optional(),
    /** Escalation flag threshold per ADR-132 §E6 contract bullet —
     *  zero commits AND age ≥ this → verdict `ship-zero-window`.
     *  Default 7200 (2h). Subset of `dormant` when the dormant
     *  threshold is higher; surfacing happens regardless of
     *  Sentinel impl. */
    shipZeroWindowSec: z.number().int().positive().optional(),
  })
  .strict();
export type TeamCadenceThresholds = z.infer<typeof TeamCadenceThresholds>;

/** ADR-146 §D7: per-team `autoEmitTrunkMerge` config. Strict — the
 *  block governs whether `moveTask` auto-files a `merge t-xxx
 *  (branch→trunk)` Task when the last leaf of a per-Story-branch
 *  task chain lands done. Defaults applied per
 *  {@link DEFAULT_AUTO_EMIT_TRUNK_MERGE_CONFIG} when the block is
 *  absent. */
export const TeamAutoEmitTrunkMerge = z
  .object({
    /** Master switch. ADR-146 §D7 narrative: default `true` when
     *  `worktreeIsolation: true`, `false` otherwise. The resolver in
     *  {@link resolveAutoEmitTrunkMergeConfig} reads
     *  `team.worktreeIsolation` to compute the effective default
     *  when this field is unset. */
    enabled: z.boolean().optional(),
    /** Owner for the auto-emitted Task when the team has no
     *  `gitter` member. `null` (default) leaves the Task
     *  unassigned for any member to claim via `atmux claim --next`. */
    fallbackAssignee: z.string().nullable().optional(),
    /** When `true`, skip auto-emit when `Story.branch ===
     *  <team-base-branch>` (no fan-in needed; work already on
     *  base). Default `true`. Disable for debug-only force-emit. */
    shortCircuitOnSharedBase: z.boolean().optional(),
  })
  .strict();
export type TeamAutoEmitTrunkMerge = z.infer<typeof TeamAutoEmitTrunkMerge>;

/** ADR-146 §D7 defaults — used by the moveTask hook in
 *  `src/core/kanban.ts` when the `autoEmitTrunkMerge` block is
 *  absent OR individual fields are unset. Co-located with the
 *  schema so non-Zod call sites share the same constants
 *  (mirrors {@link DEFAULT_CADENCE_CONFIG} precedent). */
export const DEFAULT_AUTO_EMIT_TRUNK_MERGE_CONFIG = {
  /** Effective default for `enabled` when neither the block nor the
   *  field is set. Resolver in `src/core/kanban.ts` reads
   *  `team.worktreeIsolation` to derive the team-wide default
   *  (`true` for isolated teams, `false` for shared-cwd teams) —
   *  this constant is the FIELD default when the team-wide compute
   *  result is `true`. */
  enabled: true,
  fallbackAssignee: null as string | null,
  shortCircuitOnSharedBase: true,
} as const;

/** `team.json::cadence` — ADR-148 §D7 commit-cadence config. All
 *  fields optional; defaults applied per
 *  {@link DEFAULT_CADENCE_CONFIG}. Absent block means the cadence
 *  column in `atmux status` falls back to fleet defaults (still
 *  computed; nothing opt-in required to surface). `.strict()`
 *  consistent with surrounding sub-blocks. */
export const TeamCadence = z
  .object({
    /** Master switch for cadence surfacing. Default `true` — the
     *  cadence column is the canonical truth signal per ADR-148 §D1
     *  and should surface by default. Disable for teams with
     *  legitimately erratic commit cadence (e.g. demo prep cycles)
     *  to silence the column. */
    enabled: z.boolean().optional(),
    /** Window-back for `commitsInWindow` count, seconds. Default
     *  1800 (30min) per ADR-148 §D2. */
    windowSec: z.number().int().positive().optional(),
    /** Verdict-classification thresholds (see {@link TeamCadenceThresholds}). */
    thresholds: TeamCadenceThresholds.optional(),
    /** ADR-148 §D4: lane-stall fallback toggle. When `true`, a
     *  cron-tick fires `atmux send <member>` Enter-push on
     *  lane=X todo>30min AND every member with lane-affinity X has
     *  cadence verdict ∈ {idle, dormant, ship-zero-window}. T2
     *  ships the column; T3 wires the cron rule. Default `true`. */
    laneStallEnabled: z.boolean().optional(),
    /** ADR-148 §D4 threshold — minimum age (seconds) of a stalled
     *  todo task before lane-stall escalates. Default 1800 (30min). */
    laneStallMinAgeSec: z.number().int().positive().optional(),
    /** Per-member opt-out — roles with legitimately low commit
     *  cadence (planner during long decomp passes, reviewer during
     *  multi-commit audit reviews). Exempt members appear in the
     *  cadence column with verdict suppressed to `(exempt)`.
     *  Default `[]`. */
    exemptMembers: z.array(z.string()).optional(),
  })
  .strict();
export type TeamCadence = z.infer<typeof TeamCadence>;

/** ADR-148 §D2/§D7 defaults — used by `src/verbs/status.ts` cadence
 *  column + (later) `src/core/cadence-classifier.ts` (T5) when the
 *  team's `cadence` block is absent or fields are unset. Co-located
 *  with the schema so non-Zod call sites share the same constants.
 *  Matches CLAUDE.md whip §0.05 2-hour ship-zero-window threshold. */
export const DEFAULT_CADENCE_THRESHOLDS = {
  shippingMaxAgeSec: 1800,
  idleMaxAgeSec: 7200,
  dormantMaxAgeSec: 21600,
  shipZeroWindowSec: 7200,
} as const;

/** ADR-148 §D7 defaults — wired through {@link resolveCadenceConfig}
 *  by status.ts on every call when the team's `cadence` block is
 *  absent. */
export const DEFAULT_CADENCE_CONFIG = {
  enabled: true,
  windowSec: 1800,
  thresholds: DEFAULT_CADENCE_THRESHOLDS,
  laneStallEnabled: true,
  laneStallMinAgeSec: 1800,
  exemptMembers: [] as readonly string[],
} as const;

/** ADR-139 §Config: `team.json::refusalDetection` block — governs the
 *  refusal-pattern auto-rotate trigger gate. Recorded events from
 *  ADR-139 T3 (`refusal_events` SQLite table) are read here; threshold
 *  decision lives in `src/core/refusal-threshold.ts::shouldRotate`
 *  (pure); the trigger glue (`src/core/refusal-trigger.ts`) reads this
 *  config + the recent rows to decide rotation fire.
 *
 *  `.strict()` is intentional per ADR-054 §D3 drift detection — typos
 *  (e.g. `softTreshold`) surface as a `team.json` load failure rather
 *  than a silent miss in the default-applier.
 *
 *  Threshold defaults mirror ADR-139 §D3 verbatim. `maxRotationsPerDay`
 *  defaults to 3 per the EPIC's OQ-2 resolved-default — beyond 3
 *  rotations in 24h the trigger emits HARD escalation rather than
 *  another rotate. */
export const TeamRefusalDetection = z
  .object({
    /** Master switch. Default `true` — enabled by default per
     *  ADR-139 §Config. Set `false` to suppress both medic + sentinel
     *  refusal scans for the team. */
    enabled: z.boolean().optional(),
    /** Soft-class events within `windowMin` to fire rotate. Default
     *  3 per ADR-139 §D3. */
    softThreshold: z.number().int().positive().optional(),
    /** Hard-class events within hard-window (fixed 10min) to fire
     *  rotate. Default 2 per ADR-139 §D3. */
    hardThreshold: z.number().int().positive().optional(),
    /** Role-class events to fire rotate (instant). Default 1 per
     *  ADR-139 §D3. */
    roleThreshold: z.number().int().positive().optional(),
    /** Window-back for soft + role threshold lookback, minutes.
     *  Default 30 per ADR-139 §D3. Hard-window is fixed at 10min
     *  via `refusal-threshold.HARD_REFUSAL_WINDOW_MIN` regardless. */
    windowMin: z.number().int().positive().optional(),
    /** Per-member opt-out — roles with legitimately refusal-like
     *  output (e.g. planner echoing operator directives back as part
     *  of decomposition). Exempt members never auto-rotate; the row
     *  still lands in `refusal_events` for audit. Default `[]`. */
    exemptMembers: z.array(z.string()).optional(),
    /** OQ-2 resolved default — max auto-rotations per member per
     *  24h. Beyond this count, the trigger emits HARD escalation
     *  to the operator instead of rotating again. Default 3. */
    maxRotationsPerDay: z.number().int().positive().optional(),
  })
  .strict();
export type TeamRefusalDetection = z.infer<typeof TeamRefusalDetection>;

/** ADR-139 §Config defaults — applied by {@link resolveRefusalConfig}
 *  when the team's `refusalDetection` block is absent or fields are
 *  unset. Mirror of `DEFAULT_REFUSAL_THRESHOLD_CONFIG` in
 *  `src/core/refusal-threshold.ts` extended with `enabled` +
 *  `exemptMembers` + `maxRotationsPerDay` (the Zod-only fields). */
export const DEFAULT_REFUSAL_DETECTION_CONFIG = {
  enabled: true,
  softThreshold: 3,
  hardThreshold: 2,
  roleThreshold: 1,
  windowMin: 30,
  exemptMembers: [] as readonly string[],
  maxRotationsPerDay: 3,
} as const;

/** Resolved-default shape that the trigger module consumes. Every
 *  field is concrete; `undefined`s from the optional Zod block are
 *  filled from {@link DEFAULT_REFUSAL_DETECTION_CONFIG}. */
export interface ResolvedRefusalConfig {
  enabled: boolean;
  softThreshold: number;
  hardThreshold: number;
  roleThreshold: number;
  windowMin: number;
  exemptMembers: readonly string[];
  maxRotationsPerDay: number;
}

/** Apply defaults to the team's `refusalDetection` block (absent or
 *  partial → fully resolved config). Pure — no I/O. The trigger
 *  module + medic + sentinel all call this at the top of each tick
 *  so the threshold gate sees concrete numbers. */
export function resolveRefusalConfig(
  block: TeamRefusalDetection | undefined,
): ResolvedRefusalConfig {
  return {
    enabled: block?.enabled ?? DEFAULT_REFUSAL_DETECTION_CONFIG.enabled,
    softThreshold: block?.softThreshold ?? DEFAULT_REFUSAL_DETECTION_CONFIG.softThreshold,
    hardThreshold: block?.hardThreshold ?? DEFAULT_REFUSAL_DETECTION_CONFIG.hardThreshold,
    roleThreshold: block?.roleThreshold ?? DEFAULT_REFUSAL_DETECTION_CONFIG.roleThreshold,
    windowMin: block?.windowMin ?? DEFAULT_REFUSAL_DETECTION_CONFIG.windowMin,
    exemptMembers: block?.exemptMembers ?? DEFAULT_REFUSAL_DETECTION_CONFIG.exemptMembers,
    maxRotationsPerDay:
      block?.maxRotationsPerDay ?? DEFAULT_REFUSAL_DETECTION_CONFIG.maxRotationsPerDay,
  };
}

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
    /** ADR-062 §Decision 4: per-line cron kill-switches (lane-tick today). */
    crons: TeamCrons.optional(),
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
    /** ADR-088 §Decision-2: per-member-branch fan-in policy (merger
     *  role). Opt-in via `merger.enabled: true`; effective config
     *  resolved at read-time via {@link resolveMergerConfig} from
     *  `src/core/merger-config.ts`. */
    merger: TeamMerger.optional(),
    /** ADR-134 §Config: per-team intra-team auto-merger config
     *  (gitter event-driven + cron-backstop fan-in). Distinct from
     *  {@link merger} (ADR-088 bulk-merge-cycle verb) — see
     *  {@link TeamAutoMerge} JSDoc for the scope comparison. Opt-in;
     *  absent block keeps pre-ADR-134 manual fan-in. */
    autoMerge: TeamAutoMerge.optional(),
    /** t-e89c03f7: observability toggles (forensic data collection). */
    observability: TeamObservability.optional(),
    /** ADR-142: modal-cycling detector tunables. Defaults applied per
     *  ADR-142 §Configuration when the block is absent. */
    modalCycling: TeamModalCycling.optional(),
    /** ADR-148 §D7: commit-cadence ground-truth signal config.
     *  Absent block uses {@link DEFAULT_CADENCE_CONFIG}; partial
     *  blocks fill missing fields from the same defaults at the
     *  call-site. Cadence is the canonical truth signal per
     *  ADR-148 §D1 — `atmux status` surfaces verdict + age in the
     *  new cadence column. */
    cadence: TeamCadence.optional(),
    /** ADR-146 §D7: per-team `autoEmitTrunkMerge` config — governs
     *  the `moveTask` auto-emit hook that fires a `merge t-xxx
     *  (branch→trunk)` Task when the last leaf of a Story's task
     *  chain transitions to `done`. Absent block uses
     *  {@link DEFAULT_AUTO_EMIT_TRUNK_MERGE_CONFIG} (default
     *  `enabled: true` for worktree-isolated teams, `false` for
     *  shared-cwd teams per ADR-146 §D5/§D7). Partial blocks fill
     *  missing fields from the same defaults at the call-site. */
    autoEmitTrunkMerge: TeamAutoEmitTrunkMerge.optional(),
    /** ADR-147 §D1/§D2: per-team complaint adjudicator config. Opt-in
     *  via `ombudsman.enabled: true` AND a roster member with
     *  `role: "ombudsman"`. Effective tick interval resolved at
     *  read-time via {@link DEFAULT_OMBUDSMAN_TICK_INTERVAL_MINS}. */
    ombudsman: TeamOmbudsman.optional(),
    /** ADR-090 §Schema: epic-team config. Presence marks the team as an
     *  ephemeral epic-team child of some parent team. When set, the
     *  Team-level superRefine enforces three cross-field gates:
     *    (1) `worktreeIsolation === true` ⇒ refuse (§Decision-anchor #3,
     *        HARD CONFLICT with ADR-084 — epic-team members share one
     *        worktree, not per-member branches);
     *    (2) `epicTeam.mergeMode === "pr" && !epicTeam.prTarget?.base` ⇒
     *        refuse (§Decision-anchor #8);
     *    (3) `epicTeam.mergeMode === "pr" && !epicTeam.prAuthorUser` ⇒
     *        refuse (§Decision-anchor #9).
     *  Absent block keeps existing teams unchanged (additive). */
    epicTeam: TeamEpic.optional(),
    /** ADR-087: `atmux stop --soft` grace window between the per-member
     *  notify and the manifest write + session kill. Default 5 seconds
     *  when unset. Setting `0` collapses the grace to a single tick but
     *  does not disable the feature (use bare `stop` for the no-grace
     *  path). */
    softStopGraceSeconds: z.number().int().nonnegative().optional(),
    /** ADR-132 §D6: pluggable cockpit-W3 whip-manager impl. Default-
     *  unset resolves to `cockpit.json::defaultSentinel`, then to the
     *  hard-coded `"claude"` baseline (preserves the pre-Sentinel
     *  per-team whip codepath for existing rosters). Restart-to-swap
     *  per OQ-1: changes require an `atmux cockpit rebuild` cycle. */
    sentinel: SentinelImpl.optional(),
    /** ADR-132 §D6: per-team knobs that compose over per-impl
     *  defaults baked into each Sentinel factory. Resolver merges
     *  by-key (explicit > per-impl default). */
    sentinelOverrides: TeamSentinelOverrides.optional(),
    /** ADR-139 §Config: refusal-pattern auto-rotate config — see
     *  {@link TeamRefusalDetection}. Absent block → defaults via
     *  {@link resolveRefusalConfig} (enabled=true, soft=3, hard=2,
     *  role=1, windowMin=30, cap=3/day). */
    refusalDetection: TeamRefusalDetection.optional(),
    /** Phase 2 sub-shapes — typed once verb porters land. */
    discord: z.unknown().optional(),
    tuiCommands: z.unknown().optional(),
  })
  .passthrough()
  .superRefine((team, ctx) => {
    // ADR-090 §Decision-anchor #3 (HARD CONFLICT carve-out with ADR-084):
    // an epic-team cannot also opt into per-member-branch isolation.
    // Members SHARE one worktree at the epic-team's project root; the
    // shared-worktree carve-out is structurally enforced here so a hand-
    // edited team.json that sets both keys is refused at loadTeam time.
    if (team.epicTeam !== undefined && team.worktreeIsolation === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["epicTeam"],
        message:
          "ADR-090 §Decision-anchor #3: team.epicTeam set with worktreeIsolation=true — HARD CONFLICT with ADR-084. Epic-team members share one worktree (the epic-team's project root); per-member-branch isolation is reserved for normal teams. Unset one of the two.",
      });
    }
    // ADR-090 §Decision-anchor #8: when pr-mode is set, prTarget.base
    // MUST be present. No default (operator-explicit) to prevent silent-
    // wrong-base merges.
    if (
      team.epicTeam !== undefined &&
      team.epicTeam.mergeMode === "pr" &&
      team.epicTeam.prTarget?.base === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["epicTeam", "prTarget", "base"],
        message:
          "ADR-090 §Decision-anchor #8: epicTeam.mergeMode='pr' requires epicTeam.prTarget.base. No default — operator must name the target branch explicitly.",
      });
    }
    // ADR-090 §Decision-anchor #9: when pr-mode is set, prAuthorUser
    // MUST be present. ADR-091's pr-mode runtime calls
    // `gh auth switch --user <prAuthorUser>` before `gh pr create`.
    if (
      team.epicTeam !== undefined &&
      team.epicTeam.mergeMode === "pr" &&
      team.epicTeam.prAuthorUser === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["epicTeam", "prAuthorUser"],
        message:
          "ADR-090 §Decision-anchor #9: epicTeam.mergeMode='pr' requires epicTeam.prAuthorUser. Names the gh CLI user that owns PR creation under pr-mode.",
      });
    }
  });
export type Team = z.infer<typeof Team>;

/** ADR-082 §2: effective default for `team.worktreeRoot` when the field
 *  is unset. Co-located with the schema so read-sites in W3 (start),
 *  W4 (stop), and W5 (doctor) share the same constant. */
export const DEFAULT_WORKTREE_ROOT = ".atmux/worktrees";

/** ADR-088 §Decision-3: default staleness window (hours) for the
 *  merger-branch-stale doctor probe + general merger heuristics. Mirrors
 *  the Zod `stalenessHours.default(24)` so non-Zod callers (W6 probe,
 *  brief docs) share the same constant. */
export const DEFAULT_MERGER_STALENESS_HOURS = 24;
