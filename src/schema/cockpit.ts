// ADR-063 (legacy flat shape) → ADR-089 (recursive `sessions[]` shape).
//
// New canonical: `Cockpit.sessions[]` — a discriminated union on `type`
// across `team` / `epic-team` / `superdriver` / `medic` / `martinet`.
// `team` and `epic-team` carry nested `sessions[]` for arbitrary-depth
// nesting.
//
// ADR-133 (medic rename) + ADR-132 (martinet at W3) — the schema admits
// both the legacy `superdoctor` discriminator + block AND the canonical
// `medic` form during the one-release-cycle deprecation window. Loader
// (`enrichLegacyFields` in `src/core/cockpit.ts`) coerces legacy
// `superdoctor` to `medic` semantics and emits a deprecation warning;
// after the cycle the `superdoctor` literal is dropped from the union.
//
// Legacy fields (`teams[]`, `superdoctor`, `medic`) remain on the
// top-level Cockpit shape as OPTIONAL — populated by `loadCockpit`
// post-parse via DFS over `sessions[]` so existing duck-typed callers
// (audit.ts, status.ts' medic probe, cockpit verb's reconcile) keep
// working without an in-scope migration. Tagged `@deprecated`; removal
// in v2 schema bump per ADR-089 §F.
//
// `claudeAccount` is opt-in — operators with a single Claude login leave
// it unset and atmux uses inherited shell env. Multi-account operators
// (per-team CLAUDE_CONFIG_DIR isolation) populate `configDir`.
//
// `tuiOverrides` is also opt-in — defaults to `effortLevel=xhigh`,
// `permissionMode=auto`. Override on a per-session basis when needed.
//
// .strict() at the leaf-object level catches typos (the same drift
// detection rationale as ADR-054 §D3); .passthrough() at the top-level
// lets future fields (e.g. `prefixChain` overrides per ADR-089 §C) land
// without a schema break for existing rosters.

import { z } from "zod";

/** Per-session Claude account binding. Resolves to
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

/** Per-session TUI launch overrides. All fields opt-in; bare object falls
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

/** Common fields shared across every `sessions[]` entry. Each concrete
 *  session schema extends this with its discriminator + own extras. */
const CockpitSessionBase = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  /** Per-ADR-089 §C: optional override of the F-key prefix chain. When
   *  unset, the chain is computed from nesting depth at `loadCockpit` per
   *  ADR-089 §Decision-anchor #4. Validation (length + uniqueness) lives
   *  in the loader, not here — the schema only types the field. */
  prefixChain: z.array(z.string()).optional(),
  claudeAccount: CockpitClaudeAccount.optional(),
  tuiOverrides: CockpitTuiOverrides.optional(),
});

// ---------- Forward type declarations (Zod v4 recursion idiom) ----------
//
// `CockpitSession` is a discriminated union whose `team` and `epic-team`
// members carry nested `sessions[]` of the same union — recursive. Zod's
// runtime `z.lazy(...)` defers the union construction until first parse,
// breaking the cycle; the TS types are forward-declared as interface
// aliases so the schema-export `z.infer<>` lines up.

export interface TeamSessionT {
  type: "team";
  name: string;
  enabled: boolean;
  /** Absolute path to the project root containing `.atmux/team.json`. */
  root: string;
  prefixChain?: string[];
  claudeAccount?: CockpitClaudeAccount;
  tuiOverrides?: CockpitTuiOverrides;
  /** Recursive — children of any session type. */
  sessions: CockpitSessionT[];
}

export interface EpicTeamSessionT {
  type: "epic-team";
  name: string;
  enabled: boolean;
  /** Parent team name — must resolve to a `type: "team"` entry elsewhere
   *  in the tree. Cross-reference validation is deferred to `loadCockpit`
   *  (schema-level lookahead would require a custom resolver). */
  parent: string;
  /** Links back to `kanban.epics[].id` — populated by `spawn-epic`
   *  (ADR-090 impl). */
  epicId: string;
  prefixChain?: string[];
  claudeAccount?: CockpitClaudeAccount;
  tuiOverrides?: CockpitTuiOverrides;
  sessions: CockpitSessionT[];
}

export interface SuperdriverSessionT {
  type: "superdriver";
  name: string;
  enabled: boolean;
  prefixChain?: string[];
  claudeAccount?: CockpitClaudeAccount;
  tuiOverrides?: CockpitTuiOverrides;
}

export interface SuperdoctorSessionT {
  type: "superdoctor";
  name: string;
  enabled: boolean;
  prefixChain?: string[];
  claudeAccount?: CockpitClaudeAccount;
  tuiOverrides?: CockpitTuiOverrides;
}

/** Cockpit window 2 (post-ADR-133) — fleet self-healing role. Same
 *  shape as `SuperdoctorSessionT` (ADR-133 §D1 is naming-only; design
 *  decisions in ADR-077 are canonical under the new name). The
 *  loader's enrichment pass coerces legacy `superdoctor` entries to
 *  `medic` semantics so callers reading `cockpit.medic` see a
 *  consistent shape regardless of which discriminator the operator's
 *  cockpit.json used. */
export interface MedicSessionT {
  type: "medic";
  name: string;
  enabled: boolean;
  prefixChain?: string[];
  claudeAccount?: CockpitClaudeAccount;
  tuiOverrides?: CockpitTuiOverrides;
}

/** Cockpit window 3 (ADR-132 §D2) — pluggable Martinet role.
 *  Singleton (one per cockpit) — the fleet-wide tick loop iterates
 *  every enabled team per tick from this one cage, dispatching the
 *  resolved impl (`team.json::martinet` per team) on each. */
export interface MartinetSessionT {
  type: "martinet";
  name: string;
  enabled: boolean;
  prefixChain?: string[];
  claudeAccount?: CockpitClaudeAccount;
  tuiOverrides?: CockpitTuiOverrides;
}

export type CockpitSessionT =
  | TeamSessionT
  | EpicTeamSessionT
  | SuperdriverSessionT
  | SuperdoctorSessionT
  | MedicSessionT
  | MartinetSessionT;

// ---------- Concrete leaf schemas ----------

/** Standalone team — owns a project root + worktree. */
export const TeamSession: z.ZodType<TeamSessionT> = z.lazy(() =>
  CockpitSessionBase.extend({
    type: z.literal("team"),
    root: z.string().min(1),
    sessions: z.array(CockpitSession).default([]),
  }).strict(),
) as z.ZodType<TeamSessionT>;

/** Ephemeral sub-team under a parent team (ADR-090). Shares the parent's
 *  worktree — no own `root` field. */
export const EpicTeamSession: z.ZodType<EpicTeamSessionT> = z.lazy(() =>
  CockpitSessionBase.extend({
    type: z.literal("epic-team"),
    parent: z.string().min(1),
    epicId: z.string().min(1),
    sessions: z.array(CockpitSession).default([]),
  }).strict(),
) as z.ZodType<EpicTeamSessionT>;

/** Cockpit window 1 — the operator's superdriver REPL. Singleton in
 *  practice but represented as a discriminated entry per ADR-089
 *  §Decision so the schema doesn't carry sidecar singleton fields. */
export const SuperdriverSession: z.ZodType<SuperdriverSessionT> = z.lazy(() =>
  CockpitSessionBase.extend({
    type: z.literal("superdriver"),
  }).strict(),
) as z.ZodType<SuperdriverSessionT>;

/** Cockpit window 2 — the ADR-077 superdoctor role (legacy literal,
 *  ADR-133 renamed to `medic`). Singleton in practice (matches the
 *  legacy `Cockpit.superdoctor` shape) but lifted into `sessions[]`
 *  per ADR-089. Loader coerces this entry to `medic` semantics during
 *  the deprecation window. */
export const SuperdoctorSession: z.ZodType<SuperdoctorSessionT> = z.lazy(() =>
  CockpitSessionBase.extend({
    type: z.literal("superdoctor"),
  }).strict(),
) as z.ZodType<SuperdoctorSessionT>;

/** Cockpit window 2 (post-ADR-133) — canonical fleet self-healing
 *  role. Same shape as `SuperdoctorSession`; discriminator renamed
 *  per ADR-133 §D1. */
export const MedicSession: z.ZodType<MedicSessionT> = z.lazy(() =>
  CockpitSessionBase.extend({
    type: z.literal("medic"),
  }).strict(),
) as z.ZodType<MedicSessionT>;

/** Cockpit window 3 (ADR-132 §D2) — pluggable Martinet role. Singleton
 *  in practice; one cage hosts the fleet-wide tick loop. */
export const MartinetSession: z.ZodType<MartinetSessionT> = z.lazy(() =>
  CockpitSessionBase.extend({
    type: z.literal("martinet"),
  }).strict(),
) as z.ZodType<MartinetSessionT>;

/** Discriminated union — ADR-089 §Decision-anchor #2. Rejects unknown
 *  `type` strings (strict-mode union per the reviewer pre-flag). Wrapped
 *  in `z.lazy` so the recursive `TeamSession.sessions[]` references can
 *  resolve. The double-cast through `unknown` is the Zod-v4 idiom for
 *  forward-typed recursive discriminated unions — the runtime schema
 *  shape is correct; TS can't infer the recursive `CockpitSessionT`
 *  through `z.lazy` without help.
 *
 *  Discriminator literals retained for back-compat during the
 *  ADR-133 deprecation window: `superdoctor` + `medic` both accepted.
 *  The loader coerces `superdoctor` entries to `medic` semantics so
 *  duck-typed consumers reading `cockpit.medic` see one shape. */
export const CockpitSession = z.lazy(() =>
  z.discriminatedUnion("type", [
    TeamSession as unknown as z.ZodObject,
    EpicTeamSession as unknown as z.ZodObject,
    SuperdriverSession as unknown as z.ZodObject,
    SuperdoctorSession as unknown as z.ZodObject,
    MedicSession as unknown as z.ZodObject,
    MartinetSession as unknown as z.ZodObject,
  ]),
) as unknown as z.ZodType<CockpitSessionT>;

// ---------- Legacy shape (kept for back-compat synthesis only) ----------

/**
 * Legacy flat team entry — pre-ADR-089. Still exported so duck-typed
 * consumers (audit.ts) keep their imports valid. New code should walk
 * `Cockpit.sessions[]` instead; `loadCockpit` synthesizes a
 * `Cockpit.teams[]` array for back-compat.
 *
 * @deprecated v2-bump: drop in favour of `TeamSession` from `sessions[]`.
 */
export const CockpitTeam = z
  .object({
    name: z.string().min(1),
    root: z.string().min(1),
    enabled: z.boolean().default(true),
    claudeAccount: CockpitClaudeAccount.optional(),
    tuiOverrides: CockpitTuiOverrides.optional(),
  })
  .strict();
export type CockpitTeam = z.infer<typeof CockpitTeam>;

/**
 * Legacy singleton superdoctor — pre-ADR-089 + pre-ADR-133. Synthesized
 * by `loadCockpit` from the first `type: "superdoctor"` OR `type: "medic"`
 * entry in `sessions[]` (post-ADR-133 the loader coerces both to
 * medic-shape; this type aliases continue to surface for back-compat).
 *
 * @deprecated v2-bump: drop in favour of `MedicSession` from `sessions[]`
 *   (or read `cockpit.medic` directly — same shape, canonical name).
 */
export const CockpitSuperdoctor = z
  .object({
    enabled: z.boolean().default(false),
    claudeAccount: CockpitClaudeAccount.optional(),
    tuiOverrides: CockpitTuiOverrides.optional(),
    /** t-22453c1e: auto-fire `/loop /medic` (legacy `/loop /superdoctor`)
     *  after a freshly-created medic window settles to its idle Claude
     *  prompt. Default true when omitted (the reconcile-side check tests
     *  for explicit `false`). Pre-existing windows are NEVER touched. Set
     *  `false` for manual REPL control. `.optional()` rather than
     *  `.default()` so the inferred TS type stays operator-friendly for
     *  direct-object fixtures (tests + the reconcile call-path don't pay
     *  for a Zod parse trip). */
    autoStart: z.boolean().optional(),
    /** t-22453c1e: max wall-clock seconds to wait for the new medic pane
     *  to settle to a Claude idle prompt before bailing without a
     *  send-keys. Defaults to 30 when omitted — empirically Claude welcome
     *  screen + plugin load runs ~5-15s on hax; 30s leaves headroom. */
    autoStartTimeoutSec: z.number().int().positive().optional(),
  })
  .strict();
export type CockpitSuperdoctor = z.infer<typeof CockpitSuperdoctor>;

/** ADR-133 canonical alias for `CockpitSuperdoctor`. Same Zod schema;
 *  separate type alias so doc-discipline call sites can read `CockpitMedic`
 *  without churning the underlying struct during the deprecation window. */
export const CockpitMedic = CockpitSuperdoctor;
export type CockpitMedic = z.infer<typeof CockpitMedic>;

/** ADR-132 §D6: cockpit-tier Martinet configuration. Same struct pattern
 *  as `CockpitSuperdoctor` / `CockpitMedic` — singleton (one cage hosts
 *  the fleet-wide tick) with the standard `claudeAccount` +
 *  `tuiOverrides` knobs. */
export const CockpitMartinet = z
  .object({
    enabled: z.boolean().default(false),
    claudeAccount: CockpitClaudeAccount.optional(),
    tuiOverrides: CockpitTuiOverrides.optional(),
    /** Mirrors `CockpitSuperdoctor.autoStart` — auto-fire `/loop /martinet`
     *  after the freshly-created window settles to its idle Claude prompt.
     *  Default true when omitted. */
    autoStart: z.boolean().optional(),
    /** Mirrors `CockpitSuperdoctor.autoStartTimeoutSec` — readiness-poll
     *  deadline in seconds. Default 30. */
    autoStartTimeoutSec: z.number().int().positive().optional(),
  })
  .strict();
export type CockpitMartinet = z.infer<typeof CockpitMartinet>;

/** ADR-132 §D6 fleet-wide Martinet impl resolution: per-team
 *  `team.json::martinet` beats `cockpit.defaultMartinet` beats hard-coded
 *  `"claude"` fallback. Enum mirrors the post-2026-05-14-simplification
 *  shipping set in `src/abstractions/martinet.ts` — MiniMax + Kimi
 *  backends dropped pre-implementation. */
export const CockpitDefaultMartinet = z.enum(["claude", "cursor"]);
export type CockpitDefaultMartinet = z.infer<typeof CockpitDefaultMartinet>;

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

// ---------- Top-level cockpit ----------

/** `~/.atmux/cockpit.json` top-level shape. Passthrough so future
 *  fields land without a schema break for existing rosters. */
export const Cockpit = z
  .object({
    /** ADR-089 §Decision-anchor #1: explicit schema version. Missing /
     *  undefined treated as v0 by `loadCockpit` (migration shim path);
     *  `1` = recursive native; `2+` reserved for shim removal. */
    schemaVersion: z.number().int().default(1),
    /** tmux session name on the operator's default socket. Default
     *  `atmux_teams` per ADR-046 / ADR-050. */
    cockpitSession: z.string().min(1).default("atmux_teams"),
    /** ADR-089 §Pillar 1: recursive session tree. DFS-ordered; window
     *  order matches DFS traversal. */
    sessions: z.array(CockpitSession).default([]),
    /** ADR-089 §C: F-key prefix chain — defaults to `["F1","F2","F3","F4"]`
     *  when unset. Loader validates length + uniqueness. */
    prefixChain: z.array(z.string()).optional(),
    /** Legacy flat roster — populated by `loadCockpit` post-parse via
     *  DFS over `sessions[]` filtering `type === "team"`. Duck-typed
     *  consumers (audit.ts, cockpit verb) read this field. New code
     *  should walk `sessions[]` directly.
     *  @deprecated v2-bump per ADR-089 §F. */
    teams: z.array(CockpitTeam).optional(),
    /** Legacy singleton superdoctor — populated by `loadCockpit`
     *  post-parse from the first `type: "superdoctor"` entry in
     *  `sessions[]`. New code should walk `sessions[]` directly or read
     *  `cockpit.medic` (canonical alias per ADR-133).
     *
     *  ADR-133 deprecation window: when `superdoctor` is present and
     *  `medic` is not, the loader coerces this to medic semantics and
     *  emits a deprecation warning. When both are present, `medic`
     *  wins (loader warns + ignores `superdoctor`). Once the window
     *  closes (v2 schema bump), this field is removed; configs still
     *  carrying `superdoctor` fail-soft with an actionable error
     *  pointing at ADR-133.
     *
     *  @deprecated v2-bump per ADR-089 §F + ADR-133. */
    superdoctor: CockpitSuperdoctor.optional(),
    /** ADR-133 canonical singleton — fleet self-healing role (was
     *  `superdoctor`). Same struct as `superdoctor`; loader synthesizes
     *  this from either the `medic` block (canonical) or the legacy
     *  `superdoctor` block (deprecated). New code reads `cockpit.medic`
     *  directly. */
    medic: CockpitMedic.optional(),
    /** ADR-132 §D6 — cockpit-tier Martinet block. Singleton; one cage
     *  in cockpit window 3 hosts the fleet-wide tick loop. When unset
     *  or `enabled: false`, no W3 window is provisioned and per-team
     *  viewer windows occupy W3+ (the pre-ADR-132 topology). */
    martinet: CockpitMartinet.optional(),
    /** ADR-132 §D6 — fleet default Martinet impl. Resolution order:
     *  per-team `team.json::martinet` beats this beats hard-coded
     *  `"claude"`. */
    defaultMartinet: CockpitDefaultMartinet.optional(),
    /** Optional ADR-086 pulse probe tunables. Omit for defaults. */
    pulse: CockpitPulse.optional(),
  })
  .passthrough();
export type Cockpit = z.infer<typeof Cockpit>;
