# ADR-288 — Driver window worker/attention pane pair

**Status**: Accepted — operator-direct 2026-09-03

## Context

ADR-239's 2026-05-26 amendment intentionally raised the parent-team floor to five drivers while the operator rebuilt the fleet. That sweep is now historical only. The live contract returns to the three-driver floor and adds a single canonical worker/attention pair schema for later tmux materializers.

This ADR is intentionally numbered 288 in this branch. It supersedes ADR-239 Amendment-2026-05-26 A1's five-driver floor and the concurrent driver-count wording that lands in the owner branch's ADR-287. It keeps the existing names, worktree layout, strict member-roster policy, and no-sendkeys rule intact.

## Decision

Parent teams declare exactly three driver entries by default:

- `driver`
- `driver-2`
- `driver-3`

Explicit rosters from 3 through 10 drivers remain valid. Roster sizes of 1 or 2 fail schema validation, and sizes above 10 fail schema validation. Missing driver rosters resolve to the canonical three-driver default via the shared driver helper.

The canonical pair preset is:

- horizontal layout
- worker pane on the left
- attention pane on the right
- attention is not a member
- attention workflow is `kb-att`
- attention authority is `decision-only`
- attention has exactly one launch field, `command` (non-empty string or `null`), and it defaults to `null`
- tmux metadata key `@atmux_driver_pane_role` carries `worker` or `attention` on both panes
- later slices resolve the worker by that key and validate that worker stays on the left

Stored team configs keep `driverPair` optional. When the field is absent,
callers materialize the same canonical preset through `resolveDriverPair(team)`
instead of relying on schema defaults.

The worker pane carries no extra role semantics beyond "left worker". Later materializers overlay the worker pane with the driver entry's own `tui`, `cwd`, and `claudeAccount`.

## Scope

This ADR does not implement tmux runtime, reconcile, observer, doctor, or attachment behavior yet. It only records the stored contract and the helper/schema surfaces that later slices consume.

## Acceptance contract for later slices

Unit tests pin the stored contract, integration tests prove later-slice reconcile behavior, and live E2E stays out of scope until an actual operator flow exists. Later slices must prove:

- reconcile materializes exactly two panes per driver pair, with worker left and attention right
- the attention pane starts as an interactive shell when `command` is null
- the attention pane stays non-member in all fleet/observer views
- doctor reports the pair contract rather than guessing from window names
- integration tests fail if the driver floor is not 3, if explicit 1-2 rosters are accepted, if explicit 4-10 rosters are lost or reordered, or if attention auto-launches by default

## Historical note

The 2026-05-26 five-driver floor remains in ADR-239 as provenance. It is no longer the live floor.
