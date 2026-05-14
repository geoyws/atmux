// ADR-063: cockpit roster schema for `~/.atmux/cockpit.json`.
//
// One entry per team that participates in the operator cockpit. Order
// in `teams[]` defines cockpit window order. Disabled teams keep their
// config but are skipped on `atmux cockpit rebuild`.
//
// `claudeAccount` is opt-in — operators with a single Claude login leave
// it unset and atmux uses inherited shell env. Multi-account operators
// (per-team CLAUDE_CONFIG_DIR isolation) populate `configDir` and atmux
// writes the canonical env prefix into the team's `team.json` on
// rebuild.
//
// `tuiOverrides` is also opt-in — defaults to `effortLevel=xhigh`,
// `permissionMode=auto`. Override on a per-team basis when needed.
//
// .strict() at the leaf-object level catches typos (the same drift
// detection rationale as ADR-054 §D3); .passthrough() at the top-level
// lets future fields (e.g. multi-cockpit support) land without a schema
// break for existing rosters.

import { z } from "zod";

/** Per-team Claude account binding. Resolves to
 *  `CLAUDE_CONFIG_DIR=<configDir> claude ...` in the spawned TUI command. */
export const CockpitClaudeAccount = z
  .object({
    /** Absolute path to the per-account ~/.claude-* directory. */
    configDir: z.string().min(1),
    /** Free-form label for status / Discord output (e.g. "ifca", "personal"). */
    label: z.string().optional(),
  })
  .strict();
export type CockpitClaudeAccount = z.infer<typeof CockpitClaudeAccount>;

/** Per-team TUI launch overrides. All fields opt-in; bare object falls
 *  back to atmux defaults. */
export const CockpitTuiOverrides = z
  .object({
    /** `CLAUDE_CODE_EFFORT_LEVEL` value. Default `xhigh` per CLAUDE.md. */
    effortLevel: z.string().optional(),
    /** `--permission-mode` flag value. Default `auto` per CLAUDE.md. */
    permissionMode: z.string().optional(),
    /** `--plugin-dir <path>` flag value. No default — flag omitted when unset. */
    pluginDir: z.string().optional(),
  })
  .strict();
export type CockpitTuiOverrides = z.infer<typeof CockpitTuiOverrides>;

/** A single team entry in the cockpit roster. */
export const CockpitTeam = z
  .object({
    /** Team identifier — matches `team.json::name`. Used to derive cage
     *  socket path (`/tmp/atmux-<name>/sock`) and session name. */
    name: z.string().min(1),
    /** Absolute path to the project root containing `.atmux/team.json`. */
    root: z.string().min(1),
    /** When false, rebuild skips this team but preserves the config so
     *  it can be re-enabled with no re-typing. Default true. */
    enabled: z.boolean().default(true),
    /** Optional per-team Claude account isolation. */
    claudeAccount: CockpitClaudeAccount.optional(),
    /** Optional per-team TUI launch overrides. */
    tuiOverrides: CockpitTuiOverrides.optional(),
  })
  .strict();
export type CockpitTeam = z.infer<typeof CockpitTeam>;

/** ADR-077: cockpit-level superdoctor role. Singleton, opt-in. When
 *  `enabled` is true, `atmux cockpit rebuild` ensures cockpit window 2
 *  is named `superdoctor` and runs the resolved TUI command (defaults
 *  identical to the team-window builder; override per-account via
 *  `claudeAccount` / `tuiOverrides`).
 *
 *  Reuses `CockpitClaudeAccount` + `CockpitTuiOverrides` verbatim so
 *  the spawn shape stays consistent with team windows — same drift
 *  detection (.strict() at the leaf, ADR-054 §D3 pattern). */
export const CockpitSuperdoctor = z
  .object({
    /** When false, rebuild skips superdoctor but preserves the config
     *  so it can be re-enabled with no re-typing. Default false (opt-in
     *  — see ADR-077 §D1: cost-conscious by default). */
    enabled: z.boolean().default(false),
    /** Optional Claude account isolation. Same semantics as
     *  CockpitTeam.claudeAccount; when unset, superdoctor inherits the
     *  operator's default Claude env (matches superdriver's default). */
    claudeAccount: CockpitClaudeAccount.optional(),
    /** Optional TUI launch overrides. Same defaults as a team window
     *  (`effortLevel=xhigh`, `permissionMode=auto`). */
    tuiOverrides: CockpitTuiOverrides.optional(),
    /** t-22453c1e: auto-fire `/loop /superdoctor` after a freshly-created
     *  superdoctor window settles to its idle Claude prompt. Default true
     *  when omitted (the reconcile-side check tests for explicit `false`).
     *  Pre-existing windows are NEVER touched. Set `false` for manual REPL
     *  control. `.optional()` rather than `.default()` so the inferred TS
     *  type stays operator-friendly for direct-object fixtures (tests + the
     *  reconcile call-path don't pay for a Zod parse trip). */
    autoStart: z.boolean().optional(),
    /** t-22453c1e: max wall-clock seconds to wait for the new superdoctor
     *  pane to settle to a Claude idle prompt before bailing without a
     *  send-keys. Defaults to 30 when omitted — empirically Claude welcome
     *  screen + plugin load runs ~5-15s on hax; 30s leaves headroom. */
    autoStartTimeoutSec: z.number().int().positive().optional(),
  })
  .strict();
export type CockpitSuperdoctor = z.infer<typeof CockpitSuperdoctor>;

/** ADR-086: cockpit-wide `atmux pulse` probe tunables. All fields opt-in;
 *  defaults are 30 / 5 / 30 (window / interval / dedup minutes). */
/** ADR-086 §Phase 1.5: verdict literal keys for the per-verdict dedup
 *  ladder. Restated here (not imported from `core/pulse-state.ts` to
 *  avoid the schema → core dependency direction) — kept in lockstep
 *  with `VerdictSchema` in pulse-state.ts. */
const PulseVerdictLiteralSchema = z.enum([
  "🟢 Shipping",
  "🟡 Cool",
  "🟡 Idle",
  "🔴 Stalled",
  "🚨 Need you",
]);

/**
 * ADR-132 §D6: cockpit-level `martinet` block — fleet-wide knobs for
 * the pluggable cockpit-W3 whip-manager (provisioned at cockpit
 * rebuild per ADR-132 §D3, sibling of superdoctor at W2 per
 * ADR-077 §D2).
 *
 * `enabled` defaults `false` — existing cockpit rosters carry no
 * breaking change. When unset / false, W3 is NOT provisioned and
 * per-team viewers stay at the pre-W3 window positions per
 * ADR-132 §D2 backward-compatibility note.
 *
 * `model` is `cursor`-only — `claude` backend has no model selector
 * (it runs the operator's standard Claude TUI). When the resolved
 * martinet is `claude`, this field is ignored.
 *
 * `cageTier` literal-pinned to `"tier-2"`: per ADR-132 §D4 the
 * Cursor impl runs in the operator-user cage tier (full git access
 * for in-line cleanup ops like `atmux task assign` reassignments).
 * `claude` (degenerate) runs Tier 1 — the cockpit-rebuild path
 * short-circuits the cage provisioning step entirely.
 *
 * `claudeAccount` re-uses {@link CockpitClaudeAccount} from the
 * existing superdoctor/team session pattern. Only relevant when the
 * resolved martinet is `claude` — it bounds the operator account
 * the W3 cage spawns under. Ignored for `cursor`.
 *
 * `.strict()` consistent with the surrounding leaf-object pattern —
 * typo'd keys (`enbled`, `cursorBin`) surface via drift detection.
 */
export const CockpitMartinet = z
  .object({
    /** Master switch. Default false (W3 NOT provisioned; per-team
     *  whip stays in-team, classic codepath). */
    enabled: z.boolean().default(false),
    /** Absolute path to the `cursor-agent` binary. Default targets
     *  the operator-standard `/usr/local/bin/cursor-agent` install
     *  path. Override on hosts where Cursor lives elsewhere. Used
     *  only when the resolved martinet is `cursor`. */
    cursorBinPath: z.string().default("/usr/local/bin/cursor-agent"),
    /** Cursor model identifier. Default `composer-2-fast` (the
     *  cost-efficient choice for the cockpit-tick observation pass;
     *  upgrade to `composer-2` only when a team needs deeper
     *  reasoning at the martinet tier — typically not). */
    model: z.enum(["composer-2-fast", "composer-2"]).default("composer-2-fast"),
    /** Cursor cage tier — pinned to `tier-2` per ADR-132 §D4.
     *  Future tiers (3+ for Linux-user-isolated cages) would need
     *  a fresh ADR + enum bump. */
    cageTier: z.literal("tier-2").default("tier-2"),
    /** Claude account binding for the degenerate `claude` impl.
     *  Only used when the resolved martinet is `claude`; ignored
     *  otherwise. Same shape as the superdoctor / team-session
     *  pattern — single source of `configDir` + `label`. */
    claudeAccount: CockpitClaudeAccount.optional(),
  })
  .strict();
export type CockpitMartinet = z.infer<typeof CockpitMartinet>;

export const CockpitPulse = z
  .object({
    /** Commit-cadence observation window in minutes. Verdict logic
     *  consults `git log --since=<windowMin>min`. Default 30. */
    windowMins: z.number().int().positive().optional(),
    /** Cron tick interval in minutes (documented in
     *  `docs/RUNBOOK-pulse.md`; auto-install is Phase 2). Default 5. */
    intervalMins: z.number().int().positive().optional(),
    /** **Soft-deprecated** as of ADR-086 §Phase 1.5 (2026-05-13).
     *  Legacy flat re-fire window in minutes — when set AND
     *  `dedupLadderMins` is unset, the verb populates the per-verdict
     *  ladder uniformly with this value (backward-compat for operator
     *  configs frozen pre-Phase-1.5). New configs prefer
     *  `dedupLadderMins` for per-verdict cadence. */
    dedupMins: z.number().int().positive().optional(),
    /** ADR-086 §Phase 1.5: per-verdict dedup ladder. Operator override
     *  merges OVER `DEFAULT_PULSE_DEDUP_LADDER`: missing verdicts
     *  inherit the default; explicit `null` disables re-fire for that
     *  verdict (silence until verdict transitions); positive int sets
     *  the cadence in minutes. Partial keys allowed — operators tune
     *  only the verdicts they care about. */
    dedupLadderMins: z
      .partialRecord(PulseVerdictLiteralSchema, z.number().int().positive().nullable())
      .optional(),
  })
  .strict();
export type CockpitPulse = z.infer<typeof CockpitPulse>;

/** `~/.atmux/cockpit.json` top-level shape. Passthrough so future
 *  fields (e.g. `cockpits[]` for multi-cockpit) don't reject. */
export const Cockpit = z
  .object({
    /** tmux session name on the operator's default socket. Default
     *  `atmux_teams` per ADR-046 / ADR-050. */
    cockpitSession: z.string().min(1).default("atmux_teams"),
    /** Ordered roster — defines cockpit window order. */
    teams: z.array(CockpitTeam),
    /** Optional cockpit-level superdoctor (ADR-077). When set + enabled,
     *  occupies cockpit window 2 between superdriver (1) and team
     *  viewers (3..N). Omit or set `enabled: false` for the legacy
     *  ADR-063 cockpit shape. */
    superdoctor: CockpitSuperdoctor.optional(),
    /** Optional ADR-086 pulse probe tunables. Omit for defaults. */
    pulse: CockpitPulse.optional(),
    /** ADR-132 §D6: fleet-wide default martinet impl. Per-team
     *  `team.json::martinet` overrides this; this value beats the
     *  hard-coded `"claude"` fallback. `cursor` is the recommended
     *  production default for cost-tier reasons (composer-2-fast
     *  vs Opus on mechanical observation work — per ADR-132 §"Cost"
     *  win, ~10× token reduction). */
    defaultMartinet: z.enum(["claude", "cursor"]).optional(),
    /** ADR-132 §D6: cockpit-level martinet block — provisioning +
     *  binary path + model + cage tier + (claude-only) account
     *  binding. See {@link CockpitMartinet} doc-comment for field-
     *  by-field rationale. */
    martinet: CockpitMartinet.optional(),
  })
  .passthrough();
export type Cockpit = z.infer<typeof Cockpit>;
