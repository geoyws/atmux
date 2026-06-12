# ADR-253: `atmux topo --reap --apply` fails CLOSED — driver-scope gate + presence-as-liveness + fail-closed probes

**Status**: accepted
**Date**: 2026-06-05
**Driver-ref**: P0 audit of the reap surface (audit finding ids `topo-reap-no-driver-scope-gate`, `iscageactive-creation-window-defeats-gate`, `reap-gate-probes-fail-open`). `atmux topo --reap --apply` is the single most destructive entry point in the tree: it enumerates orphans SYSTEM-WIDE across every team's cages, branches, and crontab blocks (not scoped to the calling cage like `/ghostbuster`), then runs `tmux kill-server` + `rm -rf <worktree>` + `git branch -D` against each. The audit found the safety it advertised (ADR-223 §D3 Gate 1, "never-reap-active") was defeated three independent ways, every one failing OPEN (destroying on uncertainty).

**Cross-refs**: [ADR-033](033-kanban-driver-only-flag.md) §Caller-scope gate (the `ATMUX_CALLER_SCOPE=driver` mechanism reused here), `src/core/dissolve-epic.ts:146` (the sibling destructive verb whose driver-scope gate this mirrors exactly), [ADR-219](219-dissolve-epic-completeness.md) §D2 (the unmerged-work invariant Gate 3 preserves; this ADR does not touch Gate 3), [ADR-250](250-orchd-stale-epic-reaper.md) / [ADR-251](251-epic-cage-socket-resolution.md) / [ADR-252](252-epic-cage-children-removal-guard.md) (sibling fail-closed / destructive-path-safety ADRs in the orchd leak-fix cluster — same "never destroy on uncertainty" doctrine this ADR applies to topo), [ADR-222](222-topo-fleet-observability.md) / [ADR-223](223-reap-cascade-semantics-and-safety.md) (the topo + reap-cascade design ADRs — currently reserved; a docs agent backfills them, and this ADR RATIFIES their §D3 Gate-1 + reap-safety semantics as the binding fail-closed contract).

## Context

The reap cascade (`src/core/reap.ts`, wired by `src/verbs/topo.ts` + `src/verbs/topo-io.ts`) layers four gates above each per-primitive reaper (ADR-223 §D3). Gate 1 ("never-reap-active") is the load-bearing safety: it must refuse to destroy a cage that still has a live tmux server or a worktree that still has uncommitted work / recent commits. The audit found Gate 1 — and the entry point that reaches it — broken three ways:

### Defect 1 — no driver-scope gate (`topo-reap-no-driver-scope-gate`)

`src/verbs/topo.ts::reapSubflow` ran the SYSTEM-WIDE destructive cascade with no caller-scope check. Any non-driver member pane (or any process that reached the verb) could run `atmux topo --reap --apply --yes` and tear down every team's cages, branches, and cron blocks across the whole host. The sibling destructive verb `dissolve-epic` (`src/core/dissolve-epic.ts:146`) already gates on `resolveCallerScope({env}) !== "driver"` per ADR-033 — `topo --reap --apply`, which is strictly MORE destructive (fleet-wide, not single-epic), had no such gate.

### Defect 2 — creation-window test defeats Gate 1 (`iscageactive-creation-window-defeats-gate`)

`src/verbs/topo-io.ts::isCageActive` decided "active" via:

```ts
const fiveMinAgo = Date.now() / 1000 - 5 * 60;
return sessions.some((s) => s.created > fiveMinAgo);
```

`s.created` is the tmux session START time, not last-activity. A cage created more than five minutes ago — i.e. EVERY long-running cage, which is the common case; cages live for hours — therefore read as "not active" even with live sessions and attached panes. The five-minute creation window inverted the gate: the longer a cage had been working, the more certainly Gate 1 would wave its reap through. This is the exact failure class ADR-219 documented from the 2026-05-21 superdoctor sweep (kill-server'd cages with 7+ live panes), re-introduced at the gate layer.

### Defect 3 — gate probes fail OPEN (`reap-gate-probes-fail-open`)

Both Gate-1 probes returned `false` (= "not active" = "safe to destroy") on uncertainty:

- `isCageActive`'s `catch` returned `false` — a socket that was momentarily unreadable, a tmux error, or a permission denial all read as "cage is dead, reap it".
- `isWorktreeActive` returned `false` on `git status` exit-code `!= 0` (not a repo / locked index / corrupt), on `git log` exit-code `!= 0`, on an unparseable commit timestamp, and in its `catch`. Every "I could not read the state" answer became "the worktree is quiescent, `rm -rf` it".

A destructive sweep must never destroy on a signal it could not read. These probes did the opposite.

## Decision

`atmux topo --reap --apply` fails CLOSED. Three changes, each independently load-bearing.

### 1. Driver-scope gate (mirrors `dissolve-epic`)

`src/verbs/topo.ts::reapSubflow` fires the gate at the top of the mutating path, before computing any per-orphan dependency:

```ts
if (parsed.apply) {
  const callerScope = opts.callerScope ?? (() => resolveCallerScope({ env: opts.env ?? process.env }));
  if (callerScope() !== "driver") {
    throw new ConfigError({ what: "topo --reap --apply: refused — caller scope is not 'driver'. ...", hint: "... ATMUX_CALLER_SCOPE=driver ..." });
  }
}
```

- Fires ONLY on `parsed.reap && parsed.apply` (the gate is inside `reapSubflow`, which only runs when `parsed.reap`; the `parsed.apply` guard scopes it to the mutating path).
- Read-only `atmux topo` and dry-run `atmux topo --reap` (WITHOUT `--apply`) stay UNGATED — members may still inspect what WOULD be reaped.
- `resolveCallerScope` imported from `src/core/common.ts` (ADR-033 §Caller-scope detection — the interim env gate: `ATMUX_CALLER_SCOPE=driver` ⇒ `driver`, anything else ⇒ `member`).
- A `callerScope` test seam + an `env` override are threaded through `TopoOpts` so unit tests inject scope without mutating the process env, matching the `DissolveEpicOpts.callerScope` pattern.

### 2. Presence-as-liveness for cages

`isCageActive` drops the `s.created > fiveMinAgo` test entirely (the `fiveMinAgo` constant is removed). Presence IS the liveness signal: ANY session on the socket ⇒ active. This matches the on-disk cage-socket enumeration's own signal (`isLiveCageSocket`: server present ⇒ alive). The logic is extracted into the exported, unit-testable predicate `isCageActiveWith(listSessions)` so the real behaviour is covered against constructed tmux states without touching the host.

### 3. Fail-CLOSED probes

Uncertainty ⇒ treat as active ⇒ REFUSE reap. The extracted predicates `isCageActiveWith` / `isWorktreeActiveWith` (both in `src/verbs/topo-io.ts`) return `true` on every uncertain path:

| Probe | Signal | Old result | New result |
|---|---|---|---|
| `isCageActiveWith` | empty session list (server answered, 0 sessions) | inactive | inactive (genuinely clean) |
| `isCageActiveWith` | any session present | depended on `created` age | **active** |
| `isCageActiveWith` | `listSessions` throws | inactive (fail-open) | **active (fail-closed)** |
| `isWorktreeActiveWith` | clean status + old commit | inactive | inactive (genuinely clean) |
| `isWorktreeActiveWith` | dirty status | active | active |
| `isWorktreeActiveWith` | clean status + recent commit | active | active |
| `isWorktreeActiveWith` | `git status` rc != 0 | inactive (fail-open) | **active (fail-closed)** |
| `isWorktreeActiveWith` | `git log` rc != 0 | inactive (fail-open) | **active (fail-closed)** |
| `isWorktreeActiveWith` | unparseable commit ts | inactive (fail-open) | **active (fail-closed)** |
| `isWorktreeActiveWith` | git throws | inactive (fail-open) | **active (fail-closed)** |

Only a genuinely-clean signal — an empty session list, or a clean + parseable + old git status — returns `false` (safe to reap). This mirrors the "never destroy on uncertainty" convention used by the cage-children enumeration and the orchd reap enumerator.

## Consequences

- A non-driver can no longer trigger a fleet-wide teardown. `ATMUX_CALLER_SCOPE=driver atmux topo --reap --apply` from a driver pane is the only path to apply; members get a `ConfigError` pointing at the dry-run alternative.
- Long-running cages (the common case) are now correctly read as active and refused — Gate 1 stops waving them through.
- A transient probe error (unreadable socket, locked git index) now refuses the reap rather than destroying. The operator escape hatch is `--skip-checks` (Gate 1 only, operator-explicit + logged in `bypassed[]` per ADR-223 §OQ4) for the rare case where the operator has independently confirmed the target is dead.
- `--skip-checks` still does NOT bypass Gate 2 (parent-kind, structural) or Gate 3 (merge-base, preserves ADR-219 §D2). This ADR changes only Gate 1's signal correctness + the entry-point scope gate; the inviolable gates are untouched.
- The Gate-1 predicates are now exported (`isCageActiveWith` / `isWorktreeActiveWith` + the `CageSessionInfo` type) and unit-tested against constructed states; `defaultReapDeps` delegates to them with the real tmux session-lister / git spawn. No `src/abstractions/tmux.ts` change was required.

## Test coverage

- `tests/unit/verbs/topo-reap.test.ts` — driver-scope gate (non-driver refuses, driver proceeds, dry-run + read-only ungated, default env resolver both ways) + REAL-implementation tests of `isCageActiveWith` (presence incl. hours-old session, empty ⇒ inactive, throw ⇒ active) and `isWorktreeActiveWith` (clean+old ⇒ inactive, dirty/recent ⇒ active, every fail-closed path ⇒ active).
- `tests/unit/core/reap.test.ts` — the orchestrator wired to the REAL predicates with throwing / rc-fail probes, proving the end-to-end chain: probe throws ⇒ predicate active ⇒ orchestrator refuses ⇒ destructive primitive never runs. These do NOT stub the function under test (per the audit note that the prior suite stubbed `isCageActive` with an injected boolean map and never exercised the real logic).
