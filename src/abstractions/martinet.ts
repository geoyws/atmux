// ADR-132 §D1 / T2 (t-2791cf60): pluggable Martinet abstraction.
//
// One swappable contract for cockpit-level pane-capture + nudging,
// offloading mechanical observation+action work from the Claude
// lead's per-team whip cycle. The Claude lead retains exclusive
// authority over judgment-class decisions via the strict escalation
// gate (§D5 / `shouldEscalateToClaudeLead`).
//
// `name` field constrained to the SHIPPING impl set per the
// 2026-05-14 12:53 MYT driver simplification of ADR-132 §Decision:
// MiniMax + Kimi backends dropped ("unreliable and not smart
// enough"). Production set is `cursor` (composer-2-fast) + `claude`
// (degenerate fallback). Schema-side enum (T5) mirrors this two-
// impl set; this commit's `name` literal is the canonical source.
//
// Sub-task chain (per EPIC t-b9529ea9):
//   T1 — ADR-132 spec (done, t-0a889489)
//   T2 — this commit: interface + ClaudeMartinet degenerate impl
//   T3 — CursorMartinet impl (was MinimaxMartinet pre-simplification)
//   T4 — DEPRECATED no-op (was KimiMartinet)
//   T5 — Zod schema fields (team.martinet, cockpit.defaultMartinet)
//   T6 — escalation classifier (`src/core/martinet-escalation.ts`)
//   T7 — fleet-wide tick verb (`src/verbs/martinet.ts`)
//   T8 — cockpit W3 integration

import type { PaneClassification } from "../core/pane-state.ts";

// ---------- Observation primitives ----------

/** One kanban-claim event observed since the last tick. Used by
 *  `kanbanDelta.newClaims` for cadence + dispatch correlation. */
export interface ClaimEvent {
  /** `t-XXXXXXXX` — task ID per ADR-060 kanban schema. */
  taskId: string;
  /** Member name from `team.members[].name` that claimed. */
  member: string;
  /** Epoch seconds — `tasks.claimed_at` column directly. */
  claimedAtSec: number;
}

/** Lightweight reference to a kanban task. Used by
 *  `kanbanDelta.completedSinceLastTick` to avoid hydrating the
 *  full KanbanTask shape when only the identity matters. */
export interface TaskRef {
  taskId: string;
  /** Optional subject line for log readability — Martinet impls
   *  may populate to keep escalation diagnoses self-describing. */
  subject?: string;
}

/** A kanban hygiene fingerprint flagged as `wedged` for Martinet's
 *  observe(). Composes on ADR-131's `HygieneFingerprintClass` set
 *  (ghost-owner, lane-mismatch, role-mismatch, lane-null-orphan,
 *  prio-null) — the Martinet observation surfaces wedges the medic
 *  (formerly `superdoctor`; renamed per ADR-133) hygiene drain
 *  hasn't auto-fixed yet so the Claude lead can intervene via the
 *  E2 escalation channel (§D5). */
export interface WedgeFingerprint {
  taskId: string;
  /** Free-form fingerprint class — typically maps 1:1 to
   *  ADR-131's `HygieneFingerprintClass`, but accepts unknown
   *  classes for forward-compat with Martinet-side observations
   *  that aren't kanban-hygiene-rooted. */
  class: string;
  /** Minutes the fingerprint has been observed in the wedged
   *  state — used by E1 (`wedged-after-nudge >15min`) and E2
   *  (`P0 wedge ≥4h`) escalation gates. */
  wedgedMin: number;
}

/** Per-member observation row. One per `team.members[]` entry on
 *  every Martinet tick. */
export interface MemberObservation {
  /** Member name (matches `team.members[].name`). */
  name: string;
  /** Pane classification at observation time (PaneClassification
   *  is the shared shape from `src/core/pane-state.ts` — re-used
   *  to keep Martinet impls aligned with the existing
   *  whip/watchdog/doctor classifier set rather than splitting a
   *  parallel state language). */
  paneState: PaneClassification;
  /** Approximate context-token count read from claude's status
   *  footer (`↑ Nk ↓ Mk tokens` strip). `null` when the footer
   *  isn't visible in the most recent capture window (e.g.
   *  TUI mid-bootstrap). Cheap-to-compute — regex extract from the
   *  pane-capture string the same capture step uses for state
   *  classification. */
  ctxTokens: number | null;
  /** Safe to fire `tmux send-keys Enter`? `true` when the pane
   *  shows queued-but-unsubmitted composer text AND no modal /
   *  compacting / rate-limit banner is intercepting input (per
   *  global CLAUDE.md "always read pane state BEFORE tmux
   *  send-keys"). False covers MODAL / COMPACTING / RATE-LIMIT /
   *  UNKNOWN paneState. */
  lastEnterPushable: boolean;
  /** The actual composer-buffer text observed in the pane,
   *  ready for Enter-push when `lastEnterPushable === true`.
   *  `null` when no queued text is present. */
  queuedComposerText: string | null;
}

/** The Martinet tick payload — one struct per (team, tick). Same
 *  shape across every Martinet impl so the cockpit-level T7 fleet
 *  iterator doesn't need impl-specific scaffolding. */
export interface Observation {
  team: string;
  members: ReadonlyArray<MemberObservation>;
  kanbanDelta: {
    /** Tasks claimed since `lastTickAt`. */
    newClaims: ReadonlyArray<ClaimEvent>;
    /** Tasks transitioned to `done` since `lastTickAt`. */
    completedSinceLastTick: ReadonlyArray<TaskRef>;
    /** Active hygiene wedges (ADR-131 fingerprints not yet
     *  auto-fixed by medic's drain — renamed from `superdoctor` per
     *  ADR-133). Composes E2 escalation evidence directly — Martinet
     *  shouldn't re-implement detection; just observe whatever's in
     *  the medic-hygiene table where `fix_applied_at IS NULL` (the
     *  table name lands with the ADR-131 schema migration). */
    wedgedClaims: ReadonlyArray<WedgeFingerprint>;
  };
  /** Commit-cadence sweep counts — recent commit rate is the
   *  load-bearing signal for the E6 ship-zero gate (`0 commits
   *  across root + submodules >2hr` is the mandatory-escalation
   *  fingerprint). */
  commitCadence: {
    /** Commits across root + submodules since the previous tick. */
    sinceLastTick: number;
    /** Commits across root + submodules in the last 30 minutes. */
    last30min: number;
    /** Commits across root + submodules in the last 2 hours.
     *  `0` here triggers E6 escalation regardless of Martinet
     *  impl. */
    last2hr: number;
  };
  /** Epoch milliseconds at which this observation was assembled
   *  — anchors per-team tick cadence + staleness checks. */
  lastTickAt: number;
}

// ---------- Nudge actions ----------

/** Discriminated union over every action a Martinet may emit.
 *  Per ADR-132 §D5: `rotate` is escalation-only at the classifier
 *  layer (T6 hard-codes the rewrite); listing it here keeps the
 *  shape complete for impls that legitimately surface a rotation
 *  recommendation via the escalation channel. */
export type NudgeAction =
  | {
      kind: "enter-push";
      member: string;
      reason: string;
    }
  | {
      kind: "claim-next";
      member: string;
      reason: string;
    }
  | {
      kind: "rotate";
      member: string;
      reason: string;
    }
  | {
      kind: "escalate-to-claude-lead";
      observation: Observation;
      reason: string;
    };

// ---------- Escalation reason enum ----------

/** ADR-132 §D5 escalation triggers. E6 (`ship-zero-2hr`) is
 *  MANDATORY — no impl may suppress it; T6's escalation classifier
 *  hard-codes E6 above the per-impl gate. */
export type EscalationReason =
  | "wedged-after-nudge" // E1
  | "hygiene-blocker-p0" // E2
  | "merge-conflict-or-push" // E3
  | "inbox-unprocessed" // E4
  | "low-confidence-streak" // E5
  | "ship-zero-2hr"; // E6 — mandatory

// ---------- Apply result ----------

/** Outcome of a single `apply()` call. `evidence` carries the
 *  human-readable detail the cockpit-level dispatcher logs +
 *  surfaces (e.g. "fired Enter on atmux:fe-1, captured `↑ 1k
 *  tokens` post-send"). */
export interface ApplyResult {
  success: boolean;
  evidence: string;
}

// ---------- The Martinet interface ----------

/**
 * Pluggable cockpit-level whip-manager. Every impl is wired by
 * `src/abstractions/martinets/<name>.ts`; the fleet-wide tick
 * (T7) iterates `cockpit.json::teams` and dispatches on
 * `team.json::martinet`.
 *
 * Lifecycle expectations:
 *
 *   - `observe(team)` is called every tick (per-team cadence
 *     from `martinetOverrides.cadenceSec`). Pure read — no
 *     mutations to atmux state.
 *   - `decide(obs)` consumes the observation and emits zero-or-
 *     more `NudgeAction`s. The escalation classifier (T6) may
 *     rewrite specific actions per the §D5 gate before they hit
 *     `apply()`.
 *   - `apply(action)` fires the side-effect (tmux send-keys,
 *     atmux verb shell-out). NEVER called for `kind:
 *     escalate-to-claude-lead` — escalation is terminal at the
 *     dispatcher boundary (the cockpit writes to the team's
 *     driver-inbox / lead pane).
 *   - `shouldEscalateToClaudeLead(obs)` is the strict gate. Each
 *     impl may apply its own escalation policy AT OR ABOVE the
 *     mandatory E6 floor (T6 enforces the floor unconditionally).
 *
 * Per ADR-132 §D2 the dispatcher lives in cockpit W3 (sibling of
 * medic at W2 — formerly named `superdoctor`; renamed per ADR-133).
 * The impl itself does NOT manage its own cage — the cockpit rebuild
 * step provisions cages per `cockpit.martinet.{claudeAccount,
 * tuiOverrides}` (ADR-077 §D2 pattern verbatim).
 */
export interface Martinet {
  /** Impl identifier. Constrained to `claude` (degenerate
   *  baseline) + `cursor` (production default, composer-2-fast).
   *  See header comment for the 2026-05-14 simplification trail
   *  — MiniMax + Kimi backends dropped pre-implementation. */
  readonly name: "claude" | "cursor";

  /** Assemble the per-team observation snapshot for this tick.
   *  Reads pane state, kanban delta, and commit cadence. Throws
   *  if `team` does not resolve to a known cockpit roster
   *  entry. */
  observe(team: string): Promise<Observation>;

  /** Decide on zero-or-more nudge actions from one observation.
   *  Order MATTERS — actions emitted earlier dispatch earlier.
   *  Impls may return an empty array (no-op tick, all-green
   *  sweep). */
  decide(obs: Observation): Promise<NudgeAction[]>;

  /** Fire one side-effect for a non-escalation action. Caller
   *  filters `kind: escalate-to-claude-lead` out BEFORE invoking
   *  `apply` — that branch is terminal at the dispatcher. */
  apply(action: NudgeAction): Promise<ApplyResult>;

  /** Strict escalation gate. Returns `true` iff at least one §D5
   *  trigger fires. Independent of `decide()` so the dispatcher
   *  can preempt impl judgment when E6 (mandatory) is tripped. */
  shouldEscalateToClaudeLead(obs: Observation): boolean;
}
