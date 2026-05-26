// ADR-221 §v2 — solo-worker classifier.
//
// A "solo-worker" is an ephemeral 1-2 member team built on the existing
// ADR-090 epic-team infrastructure for SINGLE-task, self-contained
// scopes (per ADR-221 §Carve-outs). The discriminator is the team's
// name prefix: `w-*` per ADR-221 §v2 line 72 (`atmux team list-workers`
// filter: `type=epic-team AND name.startsWith("w-")`).
//
// Pure helper — no I/O, just the prefix check. Exported so the orchd
// auto-dissolve handler (ADR-231 §D6) and any future tooling
// (operator status display, complaint adjudicator, etc.) consume one
// canonical predicate instead of redefining the convention in N places.
//
// Cross-refs:
//   - ADR-221 §v2 line 72 — the prefix is the load-bearing convention.
//   - ADR-221 §v2 line 77 — explicit decision: prefix-based subscription
//     filter is more durable than silent fallthrough (refuses non-worker
//     `e-` ids in `dissolve-worker`).
//   - ADR-231 §D6 — the auto-dissolve handler consumes this classifier
//     to gate the dissolve-worker invocation.

/** Returns `true` iff `teamName` matches the ADR-221 §v2 solo-worker
 *  prefix convention. Pure, side-effect-free, allocation-free hot path.
 *
 *  Note: this checks the NAME convention, not the kanban Epic row's
 *  `worker-` driver-ref tag (which is a forensic annotation, not a
 *  structural discriminator). Per ADR-221 §v2 line 77, the prefix is
 *  the load-bearing convention; downstream tooling that needs the
 *  finer-grained worker-vs-epic-team distinction (e.g. activity-based
 *  classification) goes through `list-workers` + `sweep-epics` instead. */
export function isSoloWorkerTeamName(teamName: string): boolean {
  return teamName.startsWith("w-");
}
