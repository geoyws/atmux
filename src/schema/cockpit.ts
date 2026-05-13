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
  })
  .strict();
export type CockpitSuperdoctor = z.infer<typeof CockpitSuperdoctor>;

/** ADR-086: cockpit-wide `atmux pulse` probe tunables. All fields opt-in;
 *  defaults are 30 / 5 / 30 (window / interval / dedup minutes). */
export const CockpitPulse = z
  .object({
    /** Commit-cadence observation window in minutes. Verdict logic
     *  consults `git log --since=<windowMin>min`. Default 30. */
    windowMins: z.number().int().positive().optional(),
    /** Cron tick interval in minutes (documented in
     *  `docs/RUNBOOK-pulse.md`; auto-install is Phase 2). Default 5. */
    intervalMins: z.number().int().positive().optional(),
    /** Re-fire dedup window for sustained-urgency verdicts (🔴 / 🚨)
     *  in minutes. Default 30. */
    dedupMins: z.number().int().positive().optional(),
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
  })
  .passthrough();
export type Cockpit = z.infer<typeof Cockpit>;
