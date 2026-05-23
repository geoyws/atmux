# RUNBOOK — `atmux topo` fleet observability + reap cascade

Operator-facing reference for the `atmux topo` verb pair (read-only
manifest in [ADR-222](adr/222-cage-topography-read-only-verb-surface.md);
destructive `--reap` cascade in [ADR-223](adr/223-reap-cascade-semantics-and-safety.md)).

## What `atmux topo` is

A single verb that enumerates the entire atmux fleet — cockpit
session, every parent team, every epic-team, every cage tmux socket,
every kanban epic row, every cron block, every worktree on disk — and
emits a stable JSON manifest (`schema_version: 1`) + an orphan
classifier output. The destructive companion `--reap` composes the
canonical per-class reap primitives behind a 4-gate safety ladder.

Designed to replace today's N × N manual cleanup (per-class shell
invocations one at a time) with a single composer that the operator
runs at any cadence.

## Verb surface

### Read-only (ADR-222 §D1)

| Flag | Effect |
|---|---|
| (default) | Flat list of teams + epics + orphans |
| `--tree` | Tree-rendered cockpit → teams → epics |
| `--orphans` | Anomaly rows only (suppresses non-orphan teams) |
| `--json` | Machine-readable `TopoManifest` (cockpit-mirror crate pins on this) |
| `--team <name>` | Scope to one team subtree |
| `--since <iso>` | Filter rows whose `last_activity` is at or after the threshold |

`--tree` + `--orphans` + `--json` compose freely; `--json` overrides
`--tree` (tree only renders for human output).

### Destructive (ADR-223 §D1)

| Flag | Effect |
|---|---|
| `--reap` | Dry-run cascade — lists what WOULD be reaped (no destruction) |
| `--reap --apply` | Interactive per-orphan prompt (`[y]/[N]/[a]/[q]/[d]`) — Gate 4 |
| `--reap --apply --yes` | Non-interactive batch — gates 1-3 still enforced |
| `--reap --class <name>` | Scope cascade to one orphan class |
| `--reap --apply --skip-checks` | Bypass Gate 1 ONLY (operator-explicit, logged) |
| `--reap --apply --json` | Requires `--yes` — emits `{ reaped, skipped, refused, failed, bypassed, summary }` |

## Orphan class taxonomy (ADR-222 §D4)

The classifier emits orphan rows joining `class × ref × atmux_dir ×
details × first_seen × reap_hint`. Per the 30-second grace ladder
(per-host first-seen state at `~/.atmux/state/topo-orphan-seen.json`),
no orphan is emitted on its first observation — a row must persist
across two consecutive aggregations more than 30s apart (5min for
class 6). This insulates the operator from transient pipeline state
(in-flight dissolves, pre-spawn races).

### 1. `cage-tmux-without-registry`

A cage tmux server is alive at `/tmp/atmux-<parent>/epics/<eid>/tmux-0/default`
but `<eid>` is NOT rostered in the parent team's `cockpit.json::sessions[]`.

**Detection**: walk `/tmp/atmux-*/epics/*/`; probe each via `tmux -S
<socket> list-sessions`; cross-ref with cockpit. Absent → orphan.

**Reap (primary)**: `tmux -S <socket> kill-server` (PRIMARY — per
ADR-223 §D2 amendment 2026-05-22). `dissolveEpic` ALWAYS refuses on
this class because the orphan-definition IS the missing registry
entry — `dissolveEpic` looks up `<eid>` in `cockpit.json`, finds
nothing, and aborts before doing any work. **Two-pass cascade**: a
subsequent `topo --reap` run re-classifies the residue as
`branch-without-row` + `worktree-without-cage` + reaps via their
canonical primitives.

### 2. `cron-block-without-worktree`

A marker-fenced cron block (`# >>> atmux:team=<ref>`) exists in the
crontab but the declared `ATMUX_DIR` no longer exists on disk.

**Detection**: parse crontab marker blocks; `stat` each `ATMUX_DIR`.

**Reap**: `atmux cron-reaper --scope <ref> --apply` per
[ADR-197](adr/197-cron-reaper-teardown-contract.md).

### 3. `worktree-without-cage`

An epic-team worktree exists on disk at `<parent>/../atmux-epics/<eid>`
but no cage tmux server is alive AND no cockpit entry.

**Detection**: walk `<parent_root>/../atmux-epics/`; for each entry,
check cage socket + cockpit row; both absent → orphan.

**Reap**: `src/core/reap.ts::reapZombieWorktree(path)` — invokes
`rm -rf <path>` after Gate 1 (worktree-not-active) passes. The
defensive helper refuses `/` / `$HOME` / non-`atmux-epics/` paths
before delegating.

### 4. `branch-without-row`

A git branch matching `<base>-epic-<eid>` exists in a parent repo but
no kanban row, no cockpit entry, AND no worktree on disk.

**Detection**: `git for-each-ref refs/heads/<base>-epic-*` against
each parent; join against kanban + cockpit + worktree disk walk.

**Reap**: `git -C <repo> branch -D <branch>` after **Gate 3**
(`git merge-base --is-ancestor <branch> <base>`) passes. Unmerged
work is NEVER destroyed — preserves ADR-219 §D2 invariant.

### 5. `kanban-epic-without-cage`

A parent kanban has an epic row in `in-progress` status but no cage
tmux server is alive AND no worktree on disk.

**Detection**: per-parent kanban epic-row probe; join against cage +
worktree.

**Reap**: NEVER auto-reaped. Surface-only per ADR-223 §D2 row 5.
Operator decides — re-spawn (`atmux team spawn-epic <eid>`) or mark
the epic `wontfix`. Killing the kanban row is destruction of operator
intent.

### 6. `cockpit-registry-without-cage`

`cockpit.json::sessions[]` lists an `<eid>` but the cage socket has
been gone for ≥ 5 minutes (5-min grace, NOT the 30s default).

**Detection**: per cockpit registry row; check cage socket + age.

**Reap**: `removeRegistryEntry(eid)` — atomic rewrite of
cockpit.json removing the matching session entry. Registry-only
mutation; no tmux/worktree touch.

## Cascade order (ADR-223 §D2)

Within one `--apply` run, the composer reaps in this order — cheapest
first, biggest blast last:

1. `cron-block-without-worktree`
2. `cockpit-registry-without-cage`
3. `branch-without-row`
4. `worktree-without-cage`
5. `cage-tmux-without-registry`

Class 5 (`kanban-epic-without-cage`) is skipped — surface-only.

Rationale: each later class may depend on the previous being clean
(e.g. cage-tmux reap fanning out fails cleaner if its cron block is
already gone).

## Safety gates (ADR-223 §D3)

Four gates layered ABOVE the per-primitive reapers' own safety
checks. Each gate refuses on any failure; `--skip-checks` cascades to
**Gate 1 only** (per reviewer audit 2026-05-22).

### Gate 1 — never-reap-active

- **Cage tmux server**: refuse if `tmux -S <socket> list-sessions`
  shows any session with `attached_clients > 0` OR last-output within
  the last 5 minutes.
- **Worktree**: refuse if `git status --porcelain` shows any
  uncommitted change OR last commit within the last 5 minutes.

**Bypass**: `--skip-checks` cascades. Operator-explicit + logged in
the result's `bypassed[]` array.

### Gate 2 — never-reap-parent-without-confirm

Structural. The orphan-row schema in ADR-222 §D2 stamps
`kind: "epic" | "parent"`; the composer narrows to `kind === "epic"`
before dispatching to any destructive primitive. Compile-time
enforcement via TypeScript discriminated union.

**Bypass**: NEVER. Parent-team teardown belongs to `atmux team stop
--force` / `atmux team rm`; reap does not own that surface.

### Gate 3 — merge-base for branch deletion

`branch-without-row` reap gates on `git merge-base --is-ancestor
<branch> <trunk>`. Unmerged work is NEVER destroyed.

**Bypass**: NEVER bypassed by `--skip-checks` per reviewer audit
2026-05-22. Preserves [ADR-219](adr/219-dissolve-epic-completeness.md)
§D2's unmerged-work invariant. Operator rescue path stays manual:
`git branch -D` (or `--force`) after manual review.

### Gate 4 — per-orphan interactive confirmation

`--apply` without `--yes` prompts per orphan:

```
[1/8] orphan-class=cage-tmux-without-registry ref=e-deadbeef
  details: epic-team cage tmux alive at /tmp/atmux-atmux/epics/e-deadbeef/tmux-0/default; e-deadbeef not in cockpit sessions[] under 'atmux'
  reap: tmux -S /tmp/atmux-atmux/epics/e-deadbeef/tmux-0/default kill-server
[y]es / [N]o / [a]ll-this-class / [q]uit / [d]etails:
```

- `[y]` — confirm + reap
- `[N]` (default on empty input) — skip this orphan
- `[a]` — collapse confirmation for every remaining orphan in this class
- `[q]` — abort cascade; already-reaped orphans stay reaped; remaining untouched
- `[d]` — expand the full manifest row; re-prompt

**Bypass**: `--yes` skips Gate 4 only. NOT bypassed by
`--skip-checks` — different concern.

## `--skip-checks` cascade scope (ADR-223 §OQ4)

Only Gate 1 (active-check). Gates 2, 3, 4 are inviolable.

| Gate | `--skip-checks` cascades? |
|---|---|
| 1 — active-check | ✅ yes (operator-explicit + logged) |
| 2 — parent-kind | ❌ no (structural, compile-time enforced) |
| 3 — merge-base | ❌ no (preserves ADR-219 §D2 invariant) |
| 4 — interactive | ❌ no (separate flag: `--yes`) |

The result's `bypassed[]` array records every gate the operator
overrode, with the orphan ref attached.

## Result shape (`--reap --apply --json`)

```jsonc
{
  "reaped":   [{ "class": "...", "ref": "...", "primitive": "..." }],
  "skipped":  [{ "class": "...", "ref": "...", "primitive": "...", "reason": "..." }],
  "refused":  [{ "class": "...", "ref": "...", "reason": "gate-N-..." }],
  "failed":   [{ "class": "...", "ref": "...", "primitive": "...", "error": "..." }],
  "bypassed": [{ "gate": "gate-1-active-check", "ref": "..." }],
  "summary":  { "reaped_count": N, "skipped_count": N, "refused_count": N, "failed_count": N }
}
```

Per ADR-223 §D4 mid-cascade failure on orphan N does NOT block
orphan N+1 — failures collect into `failed[]`; remaining orphans
proceed.

## Reap-log (`~/.atmux/state/reap-log.jsonl`)

Per ADR-223 §OQ5, one JSONL line per reaped orphan:

```jsonc
{ "schema_version": 1, "timestamp": "...", "orphan_class": "...", "ref": "...", "primitive": "...", "result": "ok" }
{ "schema_version": 1, "timestamp": "...", "orphan_class": "...", "ref": "...", "primitive": "...", "result": "failed", "error": "..." }
```

Append-only; rotation is operator discretion (not load-bearing for
the verb). Both `result: ok` and `result: failed` are recorded.

## Performance budget

Cold first run on hax baseline (5 parent teams + 3 epic-teams):
**under 2 s wall-time** per ADR-222 §D3. Dogfood on 2026-05-22
(5 teams + 16 epics + 12 cages alive) measured **441-449 ms** —
~4.4× under budget.

## Related ADRs / runbooks

- [ADR-222](adr/222-cage-topography-read-only-verb-surface.md) — verb surface + manifest contract + orphan classifier
- [ADR-223](adr/223-reap-cascade-semantics-and-safety.md) — reap cascade + safety gates + composition map
- [ADR-090](adr/090-epic-team-lifecycle.md) — `dissolve-epic` (canonical for cleanly-registered teardown)
- [ADR-197](adr/197-cron-reaper-teardown-contract.md) — `cron-reaper` (cron-block reap primitive)
- [ADR-178](adr/178-test-cage-leak-reaper.md) — `test-reaper` (test-class sibling — NOT composed into topo's reap)
- [ADR-219](adr/219-dissolve-epic-completeness.md) — dissolve-epic completeness invariant (Gate 3 preserves §D2)
- [ADR-170](adr/170-sweep-epics-verb.md) — `sweep-epics` verdict ladder (topo manifest is a strict superset)
- [ADR-077](adr/077-superdoctor-cockpit-role.md) — doctor probes consume the topo manifest (per §D6 + 2026-05-22 amendment)
