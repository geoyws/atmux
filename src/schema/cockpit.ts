// ADR-063 (legacy flat shape) → ADR-089 (recursive `sessions[]` shape).
//
// New canonical: `Cockpit.sessions[]` — a discriminated union on `type`
// across `team` / `epic-team` / `superdriver` / `medic`.
// `team` and `epic-team` carry nested `sessions[]` for arbitrary-depth
// nesting.
//
// ADR-133 (medic rename) + ADR-132 (sentinel at W3) — the schema admits
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

/** ADR-199 — pool entry for `cockpit.claudeAccountPool[]`. Extends
 *  {@link CockpitClaudeAccount} with an optional `weight` (0..1) used
 *  as a tie-breaker when budget probe state is stale or absent. */
export const ClaudeAccountPoolEntry = z
  .object({
    /** Absolute path to the per-account ~/.claude-* directory. */
    configDir: z.string().min(1),
    /** Free-form label — MUST match the budget probe filename suffix
     *  (`~/.atmux/state/budget-probe-<label>.json`) so the selector
     *  can find the entry's live utilization. */
    label: z.string().min(1),
    /** Tie-breaker weight when budget data is stale or absent.
     *  Higher = preferred. Default 1.0. */
    weight: z.number().min(0).max(1).optional(),
  })
  .strict();
export type ClaudeAccountPoolEntry = z.infer<typeof ClaudeAccountPoolEntry>;

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

/**
 * t-72a6b7d7 / c-a99bf461: per-team operator-intent flag for the cage
 * tmux socket. Lets medic / superdoctor sweeps distinguish
 * "cage intentionally torn down" from "cage anomalously absent" — the
 * pre-flag state where sockets-missing was indistinguishable from
 * operator-driven direct mode forced the operator to manually annotate
 * out-of-band.
 *
 *   - `autonomous` (default) — the team runs a cage and a missing
 *     socket is anomalous. Medic flags it red. This is the existing
 *     pre-flag behaviour and what every legacy cockpit.json (no
 *     `cageMode` field at all) gets via the schema default.
 *   - `direct` — the team is operator-driven: cage absence is
 *     expected, presence is benign. Medic skips socket-presence checks
 *     entirely (green).
 *   - `paused` — the team is intentionally down today, expected to be
 *     rebuilt on the next `atmux cockpit rebuild`. Medic shows a
 *     yellow / informational row but does NOT escalate.
 *
 * Consumer logic lives in `src/core/superdoctor-cage-verdict.ts` —
 * `verdictForCage(cageMode, sessionAlive) → CageVerdict`.
 */
export const CockpitTeamCageMode = z.enum(["autonomous", "direct", "paused"]);
export type CockpitTeamCageMode = z.infer<typeof CockpitTeamCageMode>;

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
  /** t-72a6b7d7 / c-a99bf461 — operator-intent flag for the team's
   *  cage tmux socket. See {@link CockpitTeamCageMode} for the
   *  green/yellow/red interpretation. Defaults to `"autonomous"` at
   *  parse time so configs without the field keep pre-flag semantics. */
  cageMode?: CockpitTeamCageMode;
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
  /** t-72a6b7d7 — epic-teams inherit the same cageMode taxonomy as
   *  standalone teams. See {@link CockpitTeamCageMode}. */
  cageMode?: CockpitTeamCageMode;
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
  /** t-22453c1e: parity with legacy `CockpitSuperdoctor.autoStart` so the
   *  migration shim's spread-into-sessions[] doesn't strip a field the
   *  reconcile-side check still reads. */
  autoStart?: boolean;
  /** t-22453c1e: parity with legacy `CockpitSuperdoctor.autoStartTimeoutSec`. */
  autoStartTimeoutSec?: number;
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

export type CockpitSessionT =
  | TeamSessionT
  | EpicTeamSessionT
  | SuperdriverSessionT
  | SuperdoctorSessionT
  | MedicSessionT;

// ---------- Concrete leaf schemas ----------

/** Standalone team — owns a project root + worktree. */
export const TeamSession: z.ZodType<TeamSessionT> = z.lazy(() =>
  CockpitSessionBase.extend({
    type: z.literal("team"),
    root: z.string().min(1),
    cageMode: CockpitTeamCageMode.optional(),
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
    cageMode: CockpitTeamCageMode.optional(),
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
    autoStart: z.boolean().optional(),
    autoStartTimeoutSec: z.number().int().positive().optional(),
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
    /** t-72a6b7d7 — propagated through to the synthesized legacy roster
     *  from the underlying `TeamSession`. Consumers (medic sweep) read
     *  this off `cockpit.teams[]` rather than walking `sessions[]`. */
    cageMode: CockpitTeamCageMode.optional(),
  })
  .strict();
export type CockpitTeam = z.infer<typeof CockpitTeam>;

/**
 * Legacy singleton superdoctor — pre-ADR-089 + pre-ADR-133. Synthesized
 * by `loadCockpit` from the first `type: "superdoctor"` OR `type: "medic"`
 * entry in `sessions[]` (post-ADR-133 the loader coerces both to
 * medic-shape; this type aliases continue to surface for back-compat).
 *
 * @deprecated v2-bump per ADR-133. Drop in favour of `MedicSession` from
 *   `sessions[]` OR read `cockpit.medic` directly — same Zod shape,
 *   canonical name. The legacy `cockpit.superdoctor` key is accepted
 *   during the one-release deprecation window; loader coerces it to
 *   `medic` semantics with a stderr warning. Once the window closes
 *   (v2 schema bump), schema-load on a config carrying `superdoctor`
 *   soft-fails with an actionable error pointing at ADR-133. This
 *   export stays through the window so existing consumers (status.ts,
 *   audit.ts) don't churn.
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

/**
 * ADR-133: new canonical name for the cockpit health-check singleton.
 * Same shape as the deprecated {@link CockpitSuperdoctor} — the rename
 * is naming-only at the config + process surface to avoid collision
 * with the `atmux doctor` verb. Operator-visible config key is
 * `cockpit.medic`. Loader coerces legacy `cockpit.superdoctor` to
 * `medic` semantics with a stderr warning during the deprecation
 * window per ADR-133 §D2.
 */
export const CockpitMedic = CockpitSuperdoctor;
export type CockpitMedic = z.infer<typeof CockpitMedic>;

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
     *  `atmux_cockpit` per ADR-135 (was `atmux_teams` pre-ADR-135 per
     *  ADR-046 / ADR-050). Legacy literal `atmux_teams` is still
     *  accepted at parse time during the deprecation window — the
     *  string-level value passes Zod validation unchanged; the
     *  deprecation warning is emitted by `loadCockpit` when the field
     *  matches the legacy literal, and `cockpit rebuild` applies the
     *  in-place `tmux rename-session atmux_teams → atmux_cockpit`
     *  shim (ADR-135 §D4). After one semver bump, the legacy literal
     *  becomes a hard error pointing at ADR-135. */
    cockpitSession: z.string().min(1).default("atmux_cockpit"),
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
    /** Optional ADR-086 pulse probe tunables. Omit for defaults. */
    pulse: CockpitPulse.optional(),
    /** ADR-199 — Claude account pool for epic-team spawning. When
     *  populated, `spawn-epic` draws `team.claudeAccount` from this
     *  list via `selectAccount()` (least-loaded by budget probe state).
     *  Each entry extends {@link CockpitClaudeAccount} with an optional
     *  weight tie-breaker. Empty / unset → spawn-epic falls back to
     *  the existing per-member inheritance chain (ADR-090 §Amendment
     *  2026-05-20). */
    claudeAccountPool: z.array(ClaudeAccountPoolEntry).optional(),
  })
  .passthrough();
export type Cockpit = z.infer<typeof Cockpit>;
