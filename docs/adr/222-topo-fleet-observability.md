# ADR-222: `atmux topo` — read-only fleet-topology observability verb

**Status**: accepted
**Date**: 2026-05-22
**Driver-ref**: EPIC e-95087c8b (topo + reap-cascade) — the fleet grew past the point where `atmux cockpit` (single-tree registry view) and per-team `atmux status` could answer "what is actually running across every team's cages, branches, worktrees, and crontab blocks, and which of those primitives is an ORPHAN?". `atmux topo` is the read-only aggregator + orphan classifier that answers it; ADR-223 is its destructive companion (`--reap`).

**Backfill note**: authored 2026-06-05 from the as-built code; this ADR documents an already-shipped surface (`src/verbs/topo.ts`, `src/verbs/topo-io.ts`, `src/core/topo-aggregate.ts`, `src/core/orphan-detector.ts`). The implementation references this ADR's section anchors (`§D1`/`§D2`/`§D4`/`§D5`) verbatim; this document ratifies them rather than introducing new design.

**Cross-refs**: [ADR-089](089-hierarchical-cockpit.md) (the hierarchical cockpit `sessions[]` tree this anchors its manifest on), [ADR-090](090-epic-team-lifecycle.md) / [ADR-219](219-dissolve-epic-completeness.md) (epic-team lifecycle + the orphan-detection invariant ADR-219 §D2 names — `topo` is the surfacing half), [ADR-223](223-reap-cascade-semantics-and-safety.md) (the `--reap` destructive companion that consumes this verb's orphan rows), [ADR-230](230-cockpit-mirror-rust-crate-fleet-event-consumer.md) (the Rust cockpit-mirror crate that pins on the `--json` `schema_version: 1` contract), [ADR-126](126-sqlite-state-store.md) (the `.atmux/state.db` kanban probe shape this reads through), [ADR-007](007-pull-kanban.md) (the Epic/Story/Task kanban whose epic rows class 5 reconciles against).

## Context

The fleet is a tree of teams, each with: a parent tmux cage (socket), zero-or-more epic-team cages (own sockets under `<tmuxTmpdir>/epics/<eid>`), per-member + per-epic git worktrees, per-epic `<base>-epic-<eid>` branches, kanban epic rows in `.atmux/state.db`, cockpit registry entries, and marker-fenced crontab blocks. Each of those primitives is created and destroyed by a different verb (`spawn-epic`, `dissolve-epic`, `team rm`, `cron-install`, `cron-reaper`, the auto-merge committer). When any pair drifts — a cage with no registry entry, a branch with no kanban row, a cron block whose `ATMUX_DIR` was `rm`'d — the primitive becomes an ORPHAN: it consumes RAM / disk / a crontab line / a socket while belonging to no live team.

There was no single read-only view that enumerated the whole tree AND classified the orphans. `atmux cockpit` shows the declared registry; `atmux status` is single-team; neither cross-checks the declared tree against the LIVE on-disk + on-socket + in-crontab state. Operators (and the ADR-230 Rust cockpit-mirror) needed a deterministic, machine-readable topology manifest with a stable orphan taxonomy.

## Decision

Add `atmux topo` — a strictly read-only fleet-topology aggregator + orphan classifier.

```
atmux topo [--tree] [--orphans] [--json] [--team <name>] [--since <iso>]
```

(The `--reap [--apply] [--yes] [--class <name>] [--skip-checks]` flags extend this verb and are governed by [ADR-223](223-reap-cascade-semantics-and-safety.md), not this ADR.)

### §D1 — Read-only contract + layering

`atmux topo` (without `--reap`) NEVER writes to `state.db`, tmux, crontab, worktrees, or branches. The verb is layered so the pure logic stays unit-testable to 100% without touching the host:

- `src/core/topo-aggregate.ts` — `gatherDiscovery(io)` (the IO-driven discovery walk) + `aggregateTopo(discovery)` (pure cockpit-anchored manifest builder) + the `Discovery` / `TopoManifest` / `TopoTeam` / `TopoEpic` / `TopoOrphan` types.
- `src/core/orphan-detector.ts` — `classifyOrphans(manifest, discovery, seenState)`, pure (§D4).
- `src/verbs/topo.ts` — the thin orchestrator: arg parse, filters (`--team` / `--since`), renderers (`--tree` / flat / `--json`), seen-state lifecycle.
- `src/verbs/topo-io.ts` — the production `DiscoveryIO` factory wrapping the tmux / crontab / sqlite / git / fs abstractions. Tested via dogfood against the real fleet, not unit tests (per CLAUDE.md "unit tests must NEVER touch real tmux/sqlite/git").

The ONLY persistence `atmux topo` performs is the orphan seen-state file (§D4) — intentional internal scaffolding for the first-observation grace ladder, not a fleet mutation. Reviewer-enforced: any write to a fleet primitive from the read-only path is a fail-state.

### §D2 — `--json` manifest contract

`--json` serializes the narrow `TopoManifest` ONLY — no `Discovery` bag leak. The manifest carries `schema_version: 1`; additive evolution within the integer. The ADR-230 Rust cockpit-mirror crate pins on this version. Manifest shape (top level): `cockpit` (alive + socket), `teams[]` (each with `cage_alive`, `branch`, `kanban` probe, `epics[]`), `orphans[]`, and a `summary` (`teams_count` / `epics_count` / `cages_alive` / `orphans_count`). Orphan ordering is deterministic `(class, ref)` so the mirror's diff loop pins on stable order.

### §D4 — Orphan classifier + grace ladder

`classifyOrphans` is pure: no IO, no clock reads (anchors on `discovery.generated_at`), deterministic for fixed inputs. Six orphan classes:

| # | class | meaning |
|---|---|---|
| 1 | `cage-tmux-without-registry` | alive cage socket, no cockpit/kanban entry |
| 2 | `cron-block-without-worktree` | marker-fenced cron block, its `ATMUX_DIR` gone on disk |
| 3 | `worktree-without-cage` | worktree on disk, no cage AND no cockpit entry |
| 4 | `branch-without-row` | `<base>-epic-<eid>` branch exists, no kanban + no cockpit + no worktree |
| 5 | `kanban-epic-without-cage` | kanban epic in-progress, no cage AND no worktree |
| 6 | `cockpit-registry-without-cage` | registry lists eid, cage gone |

**Grace ladder** (false-positive defense against creation/teardown races):

- Default 30s grace — every candidate must be observed in the seen-state for ≥30s before it is emitted as an orphan. The classifier NEVER emits on first observation.
- Class 6 raises the threshold to 5 min (a cage may legitimately be momentarily down between teardown and registry-cleanup).
- TTL eviction at 7d: a seen-state entry that is no longer a candidate AND is >7d behind `generated_at` is dropped.

**Carve-outs** (NEVER emitted):

- Soft-stopped teams (ADR-087): `cage_alive: false` is AS-INTENDED; classes 5 + 6 skip when `soft_stopped: true`.
- The same 30s grace covers the pre-spawn race (a freshly-spawned primitive whose siblings haven't landed yet).

Seen-state file: `~/.atmux/state/topo-orphan-seen.json`, shape `{ schema_version: 1, generated_at: ISO, entries: { "<class>::<ref>": ISO-first-observation } }`. Load is defensive: missing / unreadable / parse-broken → empty default (first run is the common case).

### §D5 — Every probe narrows to nullable on failure

The production `DiscoveryIO` factory (`defaultDiscoveryIO`) catches every fallible probe (tmux `hasServer`, git `rev-parse` / `log` / `merge-base`, sqlite open) and narrows to `null` / `false` / `[]` rather than throwing. A single unreadable socket or locked git index never aborts the whole topology walk — the affected primitive simply reads as absent for THIS read-only run. (The destructive `--reap` path inverts this posture to fail-CLOSED — see ADR-223 §D3 + ADR-253; a probe that can't confirm "dead" must NOT enable destruction.)

## Consequences

- Operators have one verb that answers "what is running and what is orphaned" across the whole fleet, deterministically, without mutating anything.
- The ADR-230 Rust cockpit-mirror has a stable `schema_version: 1` JSON contract to consume.
- ADR-223's `--reap` cascade has a typed orphan-row source (`TopoOrphan` discriminated on `class` + `kind`) so the destructive layer never re-implements discovery.
- The 30s/5min grace ladder structurally prevents the creation/teardown-race false-positive class that the 2026-05-21 superdoctor sweep (ADR-219 §D2) hit at the kill-server layer.

## Open questions

- **OQ1 — branch→parent lookup.** The manifest does not yet carry a branch→owning-parent table; the reap layer (ADR-223) falls back to the first team whose worktree is set when resolving a branch's repo path. Acceptable for the single-parent-per-trunk common case; a structured field is additive evolution within `schema_version: 1`.
- **OQ2 — cage-socket field on orphan rows.** Class-1 orphans carry the socket in the human `details` line but not as a structured field; the reap layer derives a canonical fallback path. Promoting the socket to a first-class `TopoOrphan` field is deferred (additive).
