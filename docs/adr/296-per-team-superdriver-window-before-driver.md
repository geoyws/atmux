# ADR-296: Per-team `superdriver` window before `driver`

**Status**: accepted (operator-direct)
**Date**: 2026-09-28
**Driver-ref**: operator-direct (George, 2026-09-28) — every team cage gains a `superdriver` seat at window 1, ahead of the driver roster. Superdrivers are typically used to coordinate driver syncs (`/sync-drivers`) and deployments across the lanes, and to arm the executor drivers (`/kb-arm`); the deployments themselves are typically done by driver 1 (`driver`, the trunk lane).
**Relates**: [ADR-239](239-three-driver-minimum-per-team-and-no-sendkeys-invariant.md) (driver roster, worktrees, front-of-cage ordering), [ADR-285](285-cooperative-bot-seat-and-superbot-offer-protocol.SUPERSEDED.md) (the `_bot` seat that follows the drivers), [ADR-278](278-nullable-driver-agent-harness.md) (null harness means zsh), ADR-287 §D5 (`members[]` deprecated), ADR-290 (cockpit-tier `_superdriver` / `_sd` operator windows — different session, different lifecycle)

## Context

`driver` (driver 1) is the trunk lane: it works from the repo root on the trunk branch, while each `driver-N` works from `.atmux/worktrees/driver-N` on `<trunk>-driver-N`. Syncing those lanes (`git merge origin/<base>` per ADR-239 D4 / ADR-137) and coordinating work across them had no seat — the operator did it by hand from whichever driver pane was free, mixing orchestration keystrokes into a lane that also carries trunk edits. The requested seat runs `/sync-drivers` from the repo root, coordinates deployments (which driver 1 typically performs from trunk), arms the executor drivers with `/kb-arm`, reads the board, files/assigns kb rows, and messages lane executors. It writes no product code and owns no branch.

## Decision

### D1 — Opt-out schema, absent means enabled

Top-level `team.json::superdriver` block, strict Zod object (`TeamSuperdriver` in `src/schema/team.ts`):

```json
{
  "superdriver": {
    "enabled": true,
    "tui": null
  }
}
```

`{"enabled": false}` opts out. An absent block, `{}`, or `{"enabled": true}` all resolve to enabled with defaults (`enabled` defaults `true`), so legacy team.json files gain the seat without migration. `tui: null` (or absent) leaves the seat on the normal interactive zsh floor, same as nullable drivers per ADR-278; a non-null harness alias launches two-stage (interactive shell first, TUI sent into the verified-idle shell second), mirroring the driver lifecycle in `src/verbs/start.ts`. `resolveSuperdriver(team, projectRoot)` in `src/core/superdriver.ts` is the single resolver; the canonical window name (`SUPERDRIVER_WINDOW_NAME = "superdriver"`) and lane (`SUPERDRIVER_LANE = "superdriver"`) live beside it.

### D2 — A seat, not a roster entry

`superdriver` is NOT a `drivers[]` entry and NOT a `members[]` entry. It has no worktree, no branch of its own, and its cwd is pinned to the repo root (not configurable). `/sync-drivers` rosters, kb-arm lane regexes, worktree provisioning, and driver branches are unchanged by construction — there is no new lane for them to enumerate.

### D3 — Window order: superdriver first, then drivers, then `_bot`, then members

Fresh `atmux start` creates the session with `superdriver` as the initial window (window 1), then driver windows at 2..N+1, then the ADR-285 `_bot` seat, then members/services. With `"enabled": false` the layout is exactly the old one (drivers at 1..N). Incremental start on a live cage lacking the seat inserts it with `tmux new-window -b` immediately before the first live roster-driver window — else before the lowest non-`__home` window — without killing any pane or touching any existing window. A disabled seat that is already present is left alone and logged, never reaped.

### D4 — Guards treat it as a protected seat by name

Member move/swap/sort derive protected indices by window NAME (`reservedSeatIndices(liveWindows, {superdriver} + roster driver names)` in `src/abstractions/tmux-window-orchestrator.ts`; `seatNamesForTeam` in `src/verbs/member.ts`), so the seat survives reorders that predate it. The legacy `driverIndex = 1` enforcement stays as-is. `LaunchAgentPaneIntent` gains `{ kind: "superdriver" }` (`src/core/agent-pane.ts`) with a matching `SendTarget` variant (`src/abstractions/tmux.ts`). `autolaunchTeam` (`src/verbs/cockpit.ts`) skips the superdriver window, and the cockpit viewer attach target stays `=<team>:driver`.

### D5 — Identity: kb actor and lane, no shortform

Kb actor `@:<owning-team>/<board>/superdriver`, lane field `--lane superdriver`. There is no shortform: `sd` already means the cockpit-tier `_sd` lanes per ADR-290. The seat is orchestration-only (§Context): its only pushes are those `/sync-drivers` makes.

### D6 — Distinct from the cockpit-tier `_superdriver` / `_sd` windows

The `atx` cockpit session's `_superdriver` / `_sd` operator windows (ADR-290) are a different session with a different lifecycle. Do not conflate or rename those; this ADR touches only the per-team cage seat.

## Consequences

- **Index shift.** `<team>:1` is now `superdriver` and `driver` is window 2 whenever the seat is enabled (it is, unless opted out). Name-based targets (`=<team>:driver`, `=<team>:superdriver`) are the stable form and are unaffected; anything addressing a cage by raw window number must assume slots move. Inside a team cage on the default prefix chain, `F3 1` lands on superdriver and drivers start at `F3 2`.
- **`/sync-drivers` roster unchanged.** The seat runs the verb; the verb's lane enumeration does not see the seat (D2).
- **Legacy `driverIndex = 1` guard kept** (D4) — it predates the seat and continues to mean what it meant; seat protection is name-based alongside it.
- **Opt-out is one field** (`"superdriver": {"enabled": false}`), and legacy team.json files need no edit to gain the default seat.

## Rejected alternatives

- **Window 0.** tmux `base-index 1` + `renumber-windows on` collapses a window 0 — the seat would not stay where it was put. Window 1 with everything else shifting down is the only stable front slot.
- **A `drivers[]` entry.** `/sync-drivers` would treat the seat as a lane: it would gain a worktree, a branch, and a roster slot, which is exactly the lane-shaped machinery an orchestration seat must stay out of.
- **A `members[]` entry.** `members[]` is deprecated per ADR-287 §D5, and team verbs (rotate, sort, dispatch, lane routing) would kill/respawn or dispatch the seat as a lane worker.

## Acceptance gates

- Fresh start orders `superdriver`, drivers, `_bot`, members; disabled teams keep the old layout byte-for-byte.
- Incremental start inserts before the first live driver with `new-window -b`; no pane killed; disabled-but-present left alone and logged.
- Move/swap/sort never displace the seat; attach targets by name still resolve.
- `templates/team.example.json` carries the block; JSON stays valid.
