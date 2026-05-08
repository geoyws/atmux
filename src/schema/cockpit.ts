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

/** `~/.atmux/cockpit.json` top-level shape. Passthrough so future
 *  fields (e.g. `cockpits[]` for multi-cockpit) don't reject. */
export const Cockpit = z
  .object({
    /** tmux session name on the operator's default socket. Default
     *  `atmux_teams` per ADR-046 / ADR-050. */
    cockpitSession: z.string().min(1).default("atmux_teams"),
    /** Ordered roster — defines cockpit window order. */
    teams: z.array(CockpitTeam),
  })
  .passthrough();
export type Cockpit = z.infer<typeof Cockpit>;
