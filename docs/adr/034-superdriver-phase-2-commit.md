# ADR-034: Superdriver Phase 2 — drop the bypass-log commit gate, build now

**Status**: accepted
**Date**: 2026-04-28
**Supersedes**: ADR-025 §"Phase 2 commit gate" (the bypass-log empirical-evidence requirement). ADR-025 §"Decision" (Phase 1 surface — registry, super-status, super-tell, super-attach) **stands unchanged**; Phase 2 is now committed to ship on top of it.

## Context

ADR-025 deferred Phase 2 superdriver work behind an empirical commit gate: build cross-team Task pushing, cross-team Epics, cross-team arbitration, and a superdriver whip-cycle only after Phase 1 logs at least one *real* `superdriver-bypass-log.md` incident. The intent was healthy — don't speculate; let usage produce evidence.

The driver re-evaluated 2026-04-28 evening. The bypass-log gate has been overtaken by clarity about *what the superdriver is for*:

- **The product intent is "one place I talk to that coordinates the fleet."** Per-team `tell-lead` is structurally insufficient for cross-team Epics + cross-team Task push + cross-team arbitration regardless of how many bypass incidents log. The gap isn't an empirical question; it's a design one. Waiting for evidence of a structural gap is theater.
- **Phase 2 is already scoped, not speculative.** The 2026-04-28 08:05 MYT driver-inbox entry locked in five concrete design constraints (whip-cycle event-driven + exponential backoff + no ceiling + 24h daily floor; agent backoff sensitivity; cross-fleet inbox quiescence; self-isolation against backoff-reset feedback loops; bidirectional fleet comms via `superdriver-inbox.md` + `super-reply` verb + `superdriver.sock` pubsub). The constraints stand. The gate that said "don't decompose these into code yet" is what's being lifted.
- **Driver wait time is real cost.** The driver has been blocked on the "talk to one superdriver" use case since 2026-04-27. Empirical evidence collection has a non-zero opportunity cost; in this case it exceeded the cost of building.

## Decision

**Phase 2 is unblocked. Build now.**

The Phase 2 surface comprises both:

1. **The original ADR-025 deferral list** — cross-team Task pushing, cross-team Epics spanning teams, cross-team conflict arbitration, superdriver whip-cycle.
2. **The 2026-04-28 08:05 MYT design constraints** — whip-cycle scheduler with event-driven exponential backoff (Constraint 1), agent backoff discipline (Constraint 2), full-fleet inbox quiescence as backoff input (Constraint 3), self-isolation against tracker self-reset (Constraint 4), bidirectional fleet comms (Constraint 5).

**Implementation ordering** (driver recommendation; planner may refine):

- **Phase 2A — bidirectional comms (Constraint 5).** `~/.claude/teams/superdriver-inbox.md` + `lib/super-reply.sh` + `superdriver.sock` pubsub + `super-tell` direct-member polish. Without this, "talk to one superdriver" is monologue; everything else gates on it.
- **Phase 2B — whip-cycle + backoff (Constraints 1–4).** `lib/super-whip.sh` scheduler + tracker file + cron entry + brief discipline updates in `templates/briefs/superdriver.md`. Autonomous fleet awareness lands here.
- **Phase 2C — cross-team writes (original ADR-025 deferral list).** `super-epic` verb + cross-team Task push extension to `super-tell` (or new `super-task` verb — planner picks) + arbitration semantics. Highest blast-radius; ships last so observability is in place first.

**The bypass-log itself is retained but reframed.** `~/.claude/teams/superdriver-bypass-log.md` is no longer a *commit gate input*. It becomes a generic incident-log channel for "the superdriver wanted to do something its current verb surface doesn't sanction" — feeds future ADRs the same way any incident log feeds design, but no longer gates this Phase.

## Consequences

- **No new architectural primitives** beyond what the constraints already specified. Registry-as-file + flock + tell-lead durability + ADR-032 socket pubsub are reused.
- **Implementation scope estimate** (from the 08:05 entry's "Implementation hook"): `lib/super-whip.sh` (~150 LOC) + `lib/super-reply.sh` (~80 LOC) + `lib/super-tell.sh` extension (~30 LOC delta) + `lib/super-epic.sh` or super-task extension (~120 LOC) + brief updates + bats coverage. Multi-Story Epic.
- **ADR-025 Phase 1 surface is untouched** — registry, super-status, super-tell, super-attach all stay as currently shipped. No regressions to existing super-status digest behavior.
- **Cron tick cadence accepted.** `*/5 * * * * atmux super-whip` introduces a 5min granularity bash tick. Bash-tick cost is near-zero; only event-or-elapsed-nextWakeAt triggers an Opus digest spawn. Idle Opus burn risk that originally motivated ON-DEMAND Phase 1 is mitigated by the exponential backoff curve (Constraint 1) — dormant fleets reach multi-hour gaps within a working day.
- **Cross-team write blast radius accepted with mitigations.** Phase 2C expands superdriver's write authority from per-team `tell-lead` to direct kanban-write into other teams. Mitigations: every write flock-guarded (mirrors registry/kanban locks); audit JSONL at `~/.claude/teams/superdriver-writes.jsonl` (already specified by ADR-029); cross-team writes always carry `{origin: "superdriver"}` for traceability.
- **Phase 1 → Phase 2 transition is non-breaking.** Phase 1 verbs continue to work during Phase 2 implementation; Phase 2 verbs land additively.

## Risk register

| Risk | Mitigation |
|---|---|
| Phase 2 ships without real-world Phase 1 stress test (the original concern) | Phase 2 surfaces are additive on Phase 1 primitives; bats + e2e coverage required per constraint; staged ordering (2A → 2B → 2C) lets each Phase mature before the next builds on it. |
| Whip-cycle re-introduces idle Opus burn the original ON-DEMAND Phase 1 avoided | Constraint 1's exponential backoff (no ceiling) is the structural answer. Bash tick cost ≠ Opus spawn cost; only fleet-event or elapsed-nextWakeAt triggers a digest. Dormant fleet → multi-hour gaps within a day. |
| Cross-team kanban writes corrupt target team state | flock + atomic write + jq-based mutations + bats coverage + audit JSONL. Same pattern as kanban.json.lock that already protects per-team writes. |
| Bidirectional inbox spam (members floods superdriver-inbox) | Per-member rate limit in `super-reply` (default 10/hour, Constraint 5); breach surfaces in bypass-log for visibility. |
| Self-isolation rule is incomplete; agent finds a write path that resets its own backoff | Closed allow-list of fleet-event sources defined in Phase 2 ADR; agent cannot extend. Bats asserts that superdriver-origin writes do NOT change tracker. Defense-in-depth via flock on tracker mutation. |
| Driver decision reverses before Phase 2 ships (cost: half-built work) | Driver-stated direction (this ADR). Override channel is open via inbox reply if the picture changes; planner pauses on first sign of reversal. |

## Open questions

Defer to the Phase 2 implementation ADR (planner authors during decomposition). The 2026-04-28 08:05 inbox entry already lists open design questions for Constraint 5 (bypass-vs-gate on super-reply, super-tell-to-fleet-inbox, spam params, ack model). Add to that list during decomposition; resolve in the Phase 2 ADR.

## Cross-references

- [ADR-025](025-superdriver-phase-1.md) — Phase 1 surface (unchanged); §"Phase 2 commit gate" superseded by this ADR.
- [ADR-029](029-driver-lead-team-scope-superdriver-cross-team.md) — superdriver cross-team write authority + audit JSONL.
- [ADR-032](032-socket-pubsub-messaging-layer.md) — socket pubsub primitive that `superdriver.sock` extends to fleet level.
- Driver-inbox entry 2026-04-28 08:05 MYT — Constraints 1–5 (canonical design source for Phase 2 implementation).
