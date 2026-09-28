# ADR-288: Driver window worker/attention pane pair

**Status:** Proposed
**Date:** 2026-09-03
**Deciders:** Team

## Context

ADR-239 originally raised the parent-team driver floor to five. That floor is no longer the intended contract for this branch slice. The approved driver-window pair epic needs a single declarative source that later materializers can consume without re-encoding pane-role semantics in each runtime path.

The sibling ADR-287 branch carries the concurrent cockpit-nesting work and the drivers-only default roster note. This ADR intentionally uses the next available number on the producer branch and does not rely on fabricated ADR-286/287 index rows here.

## Decision

We restore the parent-team driver floor to exactly three drivers:

- `driver`
- `driver-2`
- `driver-3`

The schema accepts explicit rosters from 3 through 10 drivers inclusive. Explicit 1-2 driver rosters fail validation. Explicit rosters above 10 fail validation. Missing `drivers` resolves to the canonical three-driver roster.

We also define one canonical driver-pair preset for later materializers:

- horizontal layout;
- worker pane on the left;
- attention pane on the right;
- attention is not a member;
- attention workflow is `kb-att`;
- attention authority is `decision-only`;
- attention `tui` and `command` both default to `null`;
- if a later materializer sees both `tui` and `command`, `command` is the canonical launch field and wins.

This slice stores that pair declaratively in team config and template surfaces. It does not implement tmux runtime/reconcile, observer, doctor, or integration behavior yet.

The canonical pair source supersedes ADR-239 Amendment 2026-05-26 A1's five-driver floor and the affected driver-count wording carried forward in ADR-287. It keeps ADR-239's no-sendkeys invariant, existing names/worktrees, strict member-roster policy, and historical incident/provenance text intact.

## Consequences

Later runtime and observer slices can read one normalized source of truth for:

- default parent-team drivers;
- worker/attention pane layout;
- attention launch defaults;
- attention workflow and authority.

The cost is one additional schema field and one extra contract surface in the template and ADR index. That is acceptable because it prevents each later consumer from re-declaring the same role semantics.

## Amendment 2026-09-28 — floor superseded (a-cce1e2fa)

George resolves a-cce1e2fa with floor 1 (`MIN_PARENT_TEAM_DRIVERS = 1`
stays). The Decision's floor-3 wording above ("explicit 1-2 driver
rosters fail validation") no longer holds; 1-10 validate, >10 fail.
The canonical pair source itself is unaffected. See ADR-239
§Amendment 2026-09-28.

## References

- [ADR-239: three-driver minimum and no-sendkeys invariant](239-three-driver-minimum-per-team-and-no-sendkeys-invariant.md)
- [ADR-287: canonical cockpit nesting and drivers-only roster](287-canonical-cockpit-nesting-and-drivers-only-roster.md)
- [`templates/team.example.json`](../../templates/team.example.json)
- [`src/core/drivers.ts`](../../src/core/drivers.ts)
