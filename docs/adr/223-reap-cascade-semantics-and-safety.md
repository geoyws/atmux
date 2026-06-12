# ADR-223: `atmux topo --reap` — orphan-reap cascade semantics + safety gates

**Status**: accepted
**Date**: 2026-05-22
**Driver-ref**: EPIC e-95087c8b (topo + reap-cascade) — once [ADR-222](222-topo-fleet-observability.md) could enumerate + classify fleet orphans read-only, the operator needed a bounded, gated way to ACT on them: kill the dead cage server, strip the stale cron block, `rm -rf` the zombie worktree, `git branch -D` the merged-but-rowless branch, drop the dangling registry entry. `atmux topo --reap` is that destructive companion. It is the single most destructive entry point in the tree (system-wide `tmux kill-server` + `rm -rf` + `git branch -D`), so its safety contract is the load-bearing part of this ADR.

**Backfill note**: authored 2026-06-05 from the as-built code; this ADR documents an already-shipped surface (`src/core/reap.ts`, plus the `--reap` flag handling in `src/verbs/topo.ts` and the production `ReapDeps` + Gate-1 predicates in `src/verbs/topo-io.ts`). The implementation references this ADR's section anchors (`§D1`/`§D2`/`§D3`/`§D4`/`§OQ4`/`§OQ5`) verbatim; this document ratifies them.

**Cross-refs**: [ADR-222](222-topo-fleet-observability.md) (the read-only verb + orphan classifier this consumes), [ADR-219](219-dissolve-epic-completeness.md) §D2 (the unmerged-work invariant Gate 3 preserves), [ADR-090](090-epic-team-lifecycle.md) (`dissolve-epic`, the per-epic teardown verb whose semantics the cage class intentionally does NOT reuse — see §D2 row 1), [ADR-197](197-cron-reaper-teardown-contract.md) (the cron-reaper primitive class 2 dispatches to), [ADR-033](033-kanban-driver-only-flag.md) §Caller-scope gate (the `ATMUX_CALLER_SCOPE=driver` mechanism), [ADR-253](253-topo-reap-fail-closed.md) (the 2026-06-05 audit that ratifies this ADR's §D3 Gate-1 as the binding fail-closed contract — see §Amendment 2026-06-05).

## Context

ADR-222's classifier emits typed `TopoOrphan` rows over six classes. Five of them have a canonical destructive remedy; one (class 5, `kanban-epic-without-cage`) does not — re-spawn or wontfix is a human judgment call. The reap cascade must:

1. Compose the five remedies WITHOUT re-implementing any destruction (every destructive call dispatches through an injectable `ReapDeps` so the orchestrator stays pure + unit-testable).
2. Order the cascade so the cheapest, lowest-blast-radius reaps run first and the biggest-blast (cage kill-server) runs last — and so a multi-pass cascade can re-classify residue.
3. Gate every destructive call so it NEVER destroys live work or unmerged commits, and never destroys on a signal it could not read.

## Decision

`atmux topo --reap` opens the reap subflow. `--reap` alone is a DRY-RUN (lists what WOULD be reaped). `--apply` promotes it to mutating. `--yes` skips per-orphan interactive confirmation. `--class <name>` scopes the cascade to one orphan class. `--skip-checks` bypasses Gate 1 ONLY (operator-explicit).

### §D1 — Flag surface + cross-flag validation

- `--apply` requires `--reap`.
- `--yes` requires `--apply`.
- `--skip-checks` requires `--apply`.
- `--class <name>` requires `--reap` and must be one of the six class literals.
- `--apply --json` WITHOUT `--yes` is refused (interactive prompting + machine-readable output conflict).

### §D2 — Composition map + cascade order

| # | orphan class | primitive | note |
|---|---|---|---|
| 1 | `cage-tmux-without-registry` | `killCageServer(socket)` | see amendment below |
| 2 | `cron-block-without-worktree` | `cronReaperReap(scope)` | ADR-197 cron-reaper |
| 3 | `worktree-without-cage` | `rmZombieWorktree(path)` | the one NEW primitive — see below |
| 4 | `branch-without-row` | `deleteBranch(repoPath, branch)` | Gate 3 first |
| 5 | `kanban-epic-without-cage` | SURFACE-ONLY | never auto-reaped |
| 6 | `cockpit-registry-without-cage` | `removeRegistryEntry(eid)` | atomic cockpit rewrite |

**Cascade order** (cheapest first, biggest blast last):

1. `cron-block-without-worktree`
2. `cockpit-registry-without-cage`
3. `branch-without-row`
4. `worktree-without-cage`
5. `cage-tmux-without-registry`

Class 5 (`kanban-epic-without-cage`) is skipped — surface-only, routed to `skipped[]` with reason `surface-only (ADR-223 §D2 row 5 — never auto-reaped)`.

**Row-1 amendment (2026-05-22 reviewer audit).** `dissolveEpic` is intentionally NOT the class-1 primitive. `dissolveEpic` looks up `<eid>` in the cockpit registry — but the class-1 orphan IS the missing registry entry, so `dissolveEpic` finds nothing and aborts. The PRIMARY class-1 reap is therefore `tmux kill-server` on the cage socket; the NEXT pass re-classifies the residue (now-dead cage) as `branch-without-row` + `worktree-without-cage` and reaps those normally. This two-pass design is why the cascade is idempotent and re-runnable (§D4).

**The one NEW primitive.** Classes 1/2/4/6 reuse existing canonical reapers; only class 3 (`worktree-without-cage`) lacked one. `makeReapZombieWorktree(rm)` (in `src/core/reap.ts`) is a narrow `rm -rf` helper with defensive root-guards: it REFUSES an empty path, `/`, `$HOME`, or any path that does not contain `atmux-epics/`. The verb layer always passes an absolute `<parentRoot>/../atmux-epics/<eid>` path; the guard surfaces a programmer-bug before the destructive call.

### §D3 — Four safety gates

| gate | name | bypassable? |
|---|---|---|
| Gate 1 | active-check (never-reap-active) | by `--skip-checks` ONLY (operator-explicit, logged in `bypassed[]`) |
| Gate 2 | parent-kind (structural) | NEVER — compile-time discriminated union on `TopoOrphan.kind`; a `kind: "parent"` orphan is refused with `gate-2-parent-kind` (parent teardown is `atmux team rm`, not reap) |
| Gate 3 | merge-base | NEVER — preserves the ADR-219 §D2 unmerged-work invariant; a branch not fully merged into its base is refused |
| Gate 4 | interactive confirmation | the verb-layer per-orphan prompt (`[y]es / [N]o / [a]ll-this-class / [q]uit / [d]etails`); skipped by `--yes` |

Gate 1 applies to the cage + worktree classes:

- A cage is "active" iff its socket has a live tmux session (presence-as-liveness — see §Amendment 2026-06-05).
- A worktree is "active" iff it has uncommitted changes OR a commit within a recency window (default 5 min).

`--skip-checks` cascades to Gate 1 ONLY. It NEVER bypasses Gate 2 (structural) or Gate 3 (merge-base / ADR-219 §D2). This was the explicit reviewer-audit verdict 2026-05-22.

### §D4 — Idempotency + per-orphan result isolation

Re-running with no new orphans is a no-op (the underlying primitives are themselves idempotent on a missing target: `kill-server` on a dead socket, `branch -D` on a gone branch, `rm -rf` on a gone path, cron-strip on an absent block, registry-remove on an absent entry). A mid-cascade per-orphan failure is collected into `failed[]` WITHOUT blocking the remaining orphans — every primitive bubbles its error up to the orchestrator, which records it and continues.

The result shape (`ReapResult`) buckets every orphan into exactly one of `reaped[]` / `skipped[]` / `refused[]` / `failed[]`, plus a `bypassed[]` list of `{ gate, ref }` for `--skip-checks` rows.

### §OQ4 — `--skip-checks` audit trail

Every Gate-1 bypass is recorded as a `bypassed[]` row (`{ gate: "gate-1-active-check", ref }`) and printed in the human footer + the `--json` output. `--skip-checks` is the operator escape hatch for the rare case where the operator has independently confirmed a target is dead but a transient probe error refuses it. It is logged, not silent.

### §OQ5 — Reap log

Every reaped orphan appends one JSONL line to `~/.atmux/state/reap-log.jsonl`, stamped `schema_version: 1`: `{ schema_version, timestamp, orphan_class, ref, primitive, result: "ok"|"failed", error? }`. The verb layer owns the file path; the orchestrator receives an injected `appendReapLog` so unit tests stay pure.

## Consequences

- The operator can clean the whole fleet of orphans in one bounded, gated, logged pass — or dry-run it first.
- No destructive logic is re-implemented; every reap dispatches through `ReapDeps` and is covered by unit tests against recorded mocks.
- Gates 2 + 3 are structurally inviolable: a non-epic orphan can never reach a destructive call, and an unmerged branch can never be `-D`'d. This preserves ADR-219 §D2.
- The two-pass cascade design means a dead-cage orphan and its residue (branch + worktree) all get reaped across consecutive runs without special-casing.

## §Amendment 2026-06-05 — Gate-1 fail-closed ratification (ADR-253)

The 2026-06-05 audit of this surface ([ADR-253](253-topo-reap-fail-closed.md)) found that the Gate-1 "never-reap-active" contract described in §D3 was DEFEATED three independent ways in the as-shipped code, every one failing OPEN (destroying on uncertainty). ADR-253 fixes the implementation and this amendment ratifies the corrected semantics as the binding §D3 Gate-1 contract:

1. **Driver-scope gate.** `atmux topo --reap --apply` now fires a caller-scope gate at the top of the mutating path (`resolveCallerScope(...) === "driver"`, ADR-033 §Caller-scope gate), mirroring `dissolve-epic`. A non-driver member can NO LONGER trigger the system-wide teardown. Read-only `atmux topo` and dry-run `--reap` (without `--apply`) stay UNGATED.
2. **Presence-as-liveness.** A cage is active iff ANY session exists on its socket — NOT (as the original code did) iff a session was *created* within the last 5 minutes. Session `created` is the START time, not last-activity; the old test read every long-running cage (the common case) as "not active" and waved its reap through.
3. **Fail-CLOSED probes.** Uncertainty ⇒ treat as ACTIVE ⇒ REFUSE reap. A throwing/erroring Gate-1 probe (unreadable socket, locked git index, unparseable commit timestamp, `git status`/`git log` non-zero exit) now returns "active" so the gate refuses. Only a genuinely-clean signal (empty session list, or clean + parseable + old git status) returns "safe to reap". A destructive sweep must NEVER destroy on a signal it could not read.

These three corrections do not touch Gate 2 (structural) or Gate 3 (merge-base / ADR-219 §D2) — they make Gate 1's signal correct and scope the entry point to the driver. See ADR-253 for the per-defect detail, the fail-closed truth table, and the test coverage.
