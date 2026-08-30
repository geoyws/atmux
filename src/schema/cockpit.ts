// ADR-063 (legacy flat shape) → ADR-089 (recursive `sessions[]` shape).
//
// New canonical: `Cockpit.sessions[]` — a discriminated union on `type`
// across `team` / `group` / `superdriver` / `medic`. `team` carries
// nested `sessions[]` for arbitrary-depth nesting; `group` is a purely
// organisational container (no `root`, no cage, no tmux server) whose
// children nest exactly like a team's — ADR-089 §Amendment 2026-08-27
// §Implementation-ledger row 3, closed by e-419553c6.
//
// ADR-280 (2026-08-27) retired the `epic-team` member of that union along
// with its `epicId` / `parent` fields. Nesting is UNCHANGED — ADR-089
// §Amendment 2026-08-27 §(A) makes a `team` containing child cages the
// general model; what went is the epic-shaped instance, not the mechanism.
// A config still carrying `type: "epic-team"` now fails `safeParse` loud
// (the union is strict) rather than aliasing silently — ADR-266 §D2's
// expired-contract precedent.
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
 *     rebuilt on the next `atmux cockpit reconcile`. Medic shows a
 *     yellow / informational row but does NOT escalate.
 *
 * NOTE: this field is currently inert — no consumer reads it (the
 * former consumer was removed in the ADR-266 sweep). Kept so existing
 * cockpit.json files carrying `cageMode` still parse.
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
// `CockpitSession` is a discriminated union whose `team` member carries
// nested `sessions[]` of the same union — recursive. Zod's
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

/** Organisational container — ADR-089 §Amendment 2026-08-27
 *  §Implementation-ledger row 3 (e-419553c6). A group has NO `root`
 *  and NO backing cage, but since the 2026-08-28 true-containment
 *  decision every enabled group DOES back a real tmux server
 *  (`groupSocketPath(name)`; see ADR-089's 2026-08-28 group-tier note)
 *  holding one viewer window per child — the containment tier between
 *  the cockpit (F1) and the team cages (F3). Children are ordinary
 *  `sessions[]` entries — a `team` under a group is a normal team.
 *  Deliberately narrow (`.strict()`, no claudeAccount / tuiOverrides /
 *  prefixChain): a group server hosts only attach clients, so nothing
 *  would consume those fields — admitting them would be schema surface
 *  that silently does nothing. */
export interface GroupSessionT {
  type: "group";
  name: string;
  enabled: boolean;
  /** Recursive — children of any session type. */
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

/** Cockpit window 2 — fleet self-healing role (ADR-077 design, renamed
 *  from `superdoctor` per ADR-133; the legacy `superdoctor` discriminator
 *  was removed per ADR-266 §D2 — configs still carrying it fail at load
 *  with an actionable error). */
export interface MedicSessionT {
  type: "medic";
  name: string;
  enabled: boolean;
  prefixChain?: string[];
  claudeAccount?: CockpitClaudeAccount;
  tuiOverrides?: CockpitTuiOverrides;
  /** t-22453c1e: parity with the top-level `CockpitMedic.autoStart` so
   *  the legacy-shape lift's spread-into-sessions[] doesn't strip a
   *  field the reconcile-side check still reads. */
  autoStart?: boolean;
  /** t-22453c1e: parity with the top-level `CockpitMedic.autoStartTimeoutSec`. */
  autoStartTimeoutSec?: number;
}

export type CockpitSessionT = TeamSessionT | GroupSessionT | SuperdriverSessionT | MedicSessionT;

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

/** Non-cage organisational container (see {@link GroupSessionT}).
 *  NOT built on `CockpitSessionBase` — the base carries cage-facing
 *  fields (claudeAccount / tuiOverrides / prefixChain) that a cage-less
 *  container has no consumer for; `.strict()` refuses them so a config
 *  author finds out at load, not by silence. */
export const GroupSession: z.ZodType<GroupSessionT> = z.lazy(() =>
  z
    .object({
      type: z.literal("group"),
      name: z.string().min(1),
      enabled: z.boolean().default(true),
      sessions: z.array(CockpitSession).default([]),
    })
    .strict(),
) as z.ZodType<GroupSessionT>;

/** Cockpit window 1 — the operator's superdriver REPL. Singleton in
 *  practice but represented as a discriminated entry per ADR-089
 *  §Decision so the schema doesn't carry sidecar singleton fields. */
export const SuperdriverSession: z.ZodType<SuperdriverSessionT> = z.lazy(() =>
  CockpitSessionBase.extend({
    type: z.literal("superdriver"),
  }).strict(),
) as z.ZodType<SuperdriverSessionT>;

/** Cockpit window 2 — canonical fleet self-healing role (ADR-077 design;
 *  discriminator renamed from `superdoctor` to `medic` per ADR-133 §D1;
 *  the legacy `SuperdoctorSession` leaf was removed per ADR-266 §D2). */
export const MedicSession: z.ZodType<MedicSessionT> = z.lazy(() =>
  CockpitSessionBase.extend({
    type: z.literal("medic"),
    autoStart: z.boolean().optional(),
    autoStartTimeoutSec: z.number().int().positive().optional(),
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
 *  Discriminator literals: `superdoctor` was accepted during the
 *  ADR-133 deprecation window; that window closed and the literal was
 *  removed per ADR-266 §D2 — only `medic` parses now. `epic-team` was
 *  removed the same way per ADR-280 §D1; a config still carrying it
 *  fails to parse rather than degrading. */
export const CockpitSession = z.lazy(() =>
  z.discriminatedUnion("type", [
    TeamSession as unknown as z.ZodObject,
    GroupSession as unknown as z.ZodObject,
    SuperdriverSession as unknown as z.ZodObject,
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
 * ADR-133: canonical name for the cockpit health-check singleton (was
 * `CockpitSuperdoctor` pre-ADR-133; the deprecated alias + the legacy
 * `cockpit.superdoctor` key were removed per ADR-266 §D2 — configs still
 * carrying a `superdoctor` block fail at load with an actionable error
 * naming ADR-266). Operator-visible config key is `cockpit.medic`.
 * New code reads `cockpit.medic` directly.
 */
export const CockpitMedic = z
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
export type CockpitMedic = z.infer<typeof CockpitMedic>;

/** Operator-owned cockpit window with no backing atmux team cage.
 *
 * These windows are declarative peers of the team viewers, but they run a
 * local command directly on the cockpit server. A null or omitted command
 * deliberately means a plain zsh workspace. */
export const CockpitWindow = z
  .object({
    name: z.string().min(1),
    enabled: z.boolean().default(true),
    cwd: z.string().min(1),
    command: z.string().min(1).nullable().optional(),
  })
  .strict();
export type CockpitWindow = z.infer<typeof CockpitWindow>;

/** ADR-285 — one deterministic `(board, tag)` ownership route. The
 *  default team receives the first offer; fallbacks are tried one at a
 *  time, in declaration order, only after the configured interval. */
export const CockpitSuperbotRoute = z
  .object({
    board: z.string().min(1),
    tag: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    defaultTeam: z.string().min(1),
    fallbackTeams: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .superRefine((route, ctx) => {
    const owners = [route.defaultTeam, ...route.fallbackTeams];
    const seen = new Set<string>();
    for (const owner of owners) {
      if (seen.has(owner)) {
        ctx.addIssue({
          code: "custom",
          message: `team '${owner}' appears more than once in the ownership route`,
          path: ["fallbackTeams"],
        });
      }
      seen.add(owner);
    }
  });
export type CockpitSuperbotRoute = z.infer<typeof CockpitSuperbotRoute>;

/** ADR-285 — cockpit `_superbot` scheduler. Disabled + shadowed by
 *  default: parsing an old cockpit.json cannot activate automation. */
export const CockpitSuperbot = z
  .object({
    enabled: z.boolean().default(false),
    shadow: z.boolean().default(true),
    intervalMins: z.number().int().positive().default(30),
    fallbackAfterIntervals: z.number().int().positive().default(1),
    maxOffersPerTick: z.number().int().positive().max(100).default(20),
    routes: z.array(CockpitSuperbotRoute).default([]),
  })
  .strict()
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    for (const [i, route] of config.routes.entries()) {
      const key = `${route.board}\u0000${route.tag}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate superbot route for board='${route.board}' tag='${route.tag}'`,
          path: ["routes", i],
        });
      }
      seen.add(key);
    }
  });
export type CockpitSuperbot = z.infer<typeof CockpitSuperbot>;

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
    /** tmux session name on the dedicated cockpit socket. `atx` is the
     *  default for new configs, but an explicit value is authoritative and
     *  is never silently rewritten (ADR-279). */
    cockpitSession: z.string().min(1).default("atx"),
    /** ADR-089 §Pillar 1: recursive session tree. DFS-ordered; window
     *  order matches DFS traversal. */
    sessions: z.array(CockpitSession).default([]),
    /** Declarative operator-owned windows placed after `_medic` and before
     *  team viewers. They have no team cage and default to zsh. */
    windows: z.array(CockpitWindow).default([]),
    /** ADR-285 deterministic Kanban offer scheduler. Absence is parsed
     *  as disabled + shadow, never as implicit activation. */
    superbot: CockpitSuperbot.optional(),
    /** ADR-089 §C: F-key prefix chain — defaults to `["F1","F2","F3","F4"]`
     *  when unset. Loader validates length + uniqueness. */
    prefixChain: z.array(z.string()).optional(),
    /** Legacy flat roster — populated by `loadCockpit` post-parse via
     *  DFS over `sessions[]` filtering `type === "team"`. Duck-typed
     *  consumers (audit.ts, cockpit verb) read this field. New code
     *  should walk `sessions[]` directly.
     *  @deprecated v2-bump per ADR-089 §F. */
    teams: z.array(CockpitTeam).optional(),
    /** ADR-133 canonical singleton — fleet self-healing role (was
     *  `superdoctor` pre-ADR-133; the legacy `superdoctor` key was
     *  removed per ADR-266 §D2 — configs still carrying it fail at
     *  load with an actionable error naming ADR-266). New code reads
     *  `cockpit.medic` directly. */
    medic: CockpitMedic.optional(),
    /** Optional ADR-086 pulse probe tunables. Omit for defaults. */
    pulse: CockpitPulse.optional(),
    /** ADR-199 — Claude account pool. When populated, a spawner draws
     *  `team.claudeAccount` from this list via `selectAccount()`
     *  (least-loaded by budget probe state). Each entry extends
     *  {@link CockpitClaudeAccount} with an optional weight tie-breaker.
     *  Empty / unset → the existing per-member inheritance chain.
     *
     *  ADR-280 stage 3 note: the pool's only runtime consumer was
     *  `spawn-epic`, which is retired. The field, `core/account-pool.ts`
     *  and the `doctor` probe are KEPT — the mechanism is an account
     *  selector, not epic machinery, and nothing generic replaces it
     *  yet. It is currently read only by `doctor`. */
    claudeAccountPool: z.array(ClaudeAccountPoolEntry).optional(),
    /** ADR-229 §DA-Gate-2: cockpit-scope orchd-push policy layers
     *  (additive on top of the canonical {@link import("../core/auto-push.ts").STAGING_PATTERNS}
     *  via `isPushAllowed(branch, allowedOverride)`). Both lists default
     *  to empty so a missing block matches "no operator overrides".
     *
     *  - `refusedBases` — additional branches to refuse beyond the
     *    canonical staging-pattern set. Use case: project-specific
     *    `*-canary` / `*-release` patterns that aren't in
     *    `STAGING_PATTERNS` but the operator wants to gate.
     *  - `allowedBases` — escape-hatch overrides. Use case: `geoy.ws`
     *    personal-infra carve-out per global CLAUDE.md push policy
     *    (operator enrolls explicitly per §Consequences).
     *
     *  Precedence (per ADR-229 §DA-Gate-2): `allowedBases` > regex
     *  match in `STAGING_PATTERNS` > `refusedBases`. Allowlist beats
     *  both because it's the operator's explicit "yes, push this"
     *  override. */
    pushPolicy: z
      .object({
        refusedBases: z.array(z.string()).default([]),
        allowedBases: z.array(z.string()).default([]),
      })
      .strict()
      .optional(),
  })
  .passthrough();
export type Cockpit = z.infer<typeof Cockpit>;
