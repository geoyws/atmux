// ADR-132 §D6 (t-f3e9ac2a / T5): effective-default resolver for the
// pluggable cockpit-W3 whip-manager (Martinet) abstraction.
//
// Mirrors the existing `merger-config.ts` resolver pattern (ADR-088
// §Decision-3 — single resolution path, single test injection point).
// The Zod schemas in `src/schema/team.ts` + `src/schema/cockpit.ts`
// declare the static defaults; this helper bridges schema-string to
// the runtime `Martinet` impl-factory dispatch in T8 by emitting a
// fully-resolved config struct.
//
// **Precedence** (per ADR-132 §D6):
//   team.json::martinet > cockpit.json::defaultMartinet > hardcoded "claude"
//
// **Overrides merge** (per ADR-132 §D6):
//   For each `martinetOverrides` field, explicit-value-on-team beats
//   per-impl default. Per-impl defaults are co-located with the
//   schema (DEFAULT_MARTINET_CADENCE_SEC, DEFAULT_MARTINET_-
//   ESCALATION_CONFIDENCE) so adding a new impl needs the constant
//   updated in lockstep.
//
// **Why T8, not start.ts**: Martinet is cockpit-level (W3 sibling of
// superdoctor at W2 per ADR-132 §D2 reshape 2026-05-14 10:13 MYT) —
// per-team `atmux start` wiring is NOT applicable; the resolver is
// consumed by `src/verbs/martinet.ts` (T8) on every fleet-wide tick.
// The task body's "wire into start.ts" line predates the §D2 reshape;
// leaving start.ts untouched per docs-discipline (ADR wins when doc
// and ADR disagree).

import type { MartinetImpl } from "../schema/team.ts";
import {
  DEFAULT_MARTINET_CADENCE_SEC,
  DEFAULT_MARTINET_ESCALATION_CONFIDENCE,
  type Team,
} from "../schema/team.ts";
import type { Cockpit } from "../schema/cockpit.ts";

/** Effective per-team martinet config — resolved impl + fully-merged
 *  overrides (no `undefined` for fields with a per-impl default).
 *  Consumed by the T8 fleet-wide tick + every Martinet factory in
 *  `src/abstractions/martinets/*.ts`. */
export interface ResolvedMartinetConfig {
  /** Resolved impl after precedence resolution. */
  impl: MartinetImpl;
  /** Per-tick cadence in seconds, after merge. */
  cadenceSec: number;
  /** Self-confidence floor (0.0-1.0), after merge. Honored only by
   *  non-`claude` impls — the degenerate ClaudeMartinet has no
   *  self-confidence signal. */
  escalationConfidenceThreshold: number;
}

/**
 * Resolve a team's effective martinet config — precedence walk +
 * override merge. Pure function: no I/O, no `git`, no `bun:test`
 * dependency. Safe to call inside the T8 fleet-wide tick at any
 * cadence.
 *
 * @param team — the parsed `Team` (from {@link loadTeam}).
 * @param cockpit — optional cockpit config. Pass when running inside
 *   the cockpit-W3 tick; omit (or pass `undefined`) when callers
 *   only have the team config (e.g. unit tests that exercise the
 *   `team > hardcoded` path without a cockpit roster).
 */
export function resolveMartinet(
  team: Team,
  cockpit?: Cockpit | undefined,
): ResolvedMartinetConfig {
  // Precedence: team > cockpit > hardcoded "claude".
  const impl: MartinetImpl =
    team.martinet ?? cockpit?.defaultMartinet ?? "claude";

  // Per-impl defaults are uniform at v1 (both 270s, both 0.7) but the
  // override merge happens by-field anyway so adding a per-impl
  // divergence later (e.g. cursor=180s for tighter ticks) needs only
  // a constant swap, not a control-flow change.
  const overrides = team.martinetOverrides ?? {};
  const cadenceSec = overrides.cadenceSec ?? DEFAULT_MARTINET_CADENCE_SEC;
  const escalationConfidenceThreshold =
    overrides.escalationConfidenceThreshold ??
    DEFAULT_MARTINET_ESCALATION_CONFIDENCE;

  return { impl, cadenceSec, escalationConfidenceThreshold };
}
