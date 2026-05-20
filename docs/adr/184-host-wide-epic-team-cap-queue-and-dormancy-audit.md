# ADR-184: Host-wide epic-team cap + spawn queue + dormancy audit

**Status**: proposed
**Date**: 2026-05-18
**Driver-ref**: 2026-05-17 22:25 MYT driver-inbox P0 — hax box RAM-pinned (49/61 GiB RAM, 61/127 GiB swap, load 24, 61 tmux servers, 225 claude procs, ~56 GiB RSS observed). Driver: hard cap on concurrent atmux epic-teams across all projects + serialization/queue policy + audit-and-retire-dormant protocol for the current 61.
**Relates**: ADR-018 (per-team tmux socket isolation), ADR-058 (cage tiering — host-tier becomes implicit Tier-0), ADR-077 (medic — dormancy-heuristic precedent), ADR-090 (epic-team lifecycle — `spawn-epic` / `dissolve-epic`), ADR-126 (JSON fallback storage pattern), ADR-132/158 (sentinel — pluggable observer; possible v2 host-tier candidate), ADR-148 (commit-cadence ground-truth signal).

## Context

Epic-teams (per ADR-090) spawn one tmux server + N member panes (~150-280 MB RSS each) per ephemeral child team. With M projects on hax (atmux / unum / sopx / rentx / bugbot / fixer / mmx) × K active epic-teams each, RSS scales O(MK). 2026-05-17 22:25 MYT snapshot:

- 49/61 GiB RAM used (80%)
- 61/127 GiB swap used (48%)
- Load avg 24
- 61 tmux servers
- 225 claude procs
- ~56 GiB combined RSS

System is degraded: fork/spawn cost is now significant, swap thrash, claude TUI redraw latency. Continuing to allow `atmux team spawn-epic` without an upper bound continues the degradation. Driver framed the cap as non-negotiable.

The hard problem is **cross-project visibility**. Inside an atmux cage, `atmux/lead` cannot see sopx cages — each project's `team.json` + `.atmux/state.db` is project-scoped. A host-wide cap requires a host-tier registry that every `spawn-epic` invocation across every project consults.

## Decision

### Host-wide registry

Single JSON file at `~/.atmux/state/host-epic-registry.json` (per-user; matches ADR-126 fallback convention; hax is single-user per global CLAUDE.md `/Machines`). Schema:

```jsonc
{
  "version": 1,
  "hostCap": 8,                            // hard cap; defaults below
  "perProjectSoftCap": 3,                  // advisory; not enforced in v1
  "epics": [
    {
      "epicId": "e-xxxxxxxx",
      "project": "atmux",                  // parent team name
      "parentRoot": "/root/work/src/atmux",
      "epicRoot": "/root/work/src/atmux-epics/e-xxxxxxxx",
      "tmuxSocketPath": "<absolute path>",
      "memberCount": 6,
      "spawnedAt": <epoch-sec>,
      "lastCommitAt": <epoch-sec | null>,  // computed lazily by host-audit
      "lastPaneActivityAt": <epoch-sec | null>,
      "priority": "normal | emergency",
      "queuedBy": "<member or driver>"
    }
  ],
  "queue": [
    {
      "queueId": "q-xxxxxxxx",
      "project": "atmux",
      "spawnArgs": ["e-yyyyyyyy", "--from", "atmux"],  // verbatim spawn-epic argv
      "queuedAt": <epoch-sec>,
      "queuedBy": "<member>",
      "priority": "normal | emergency"
    }
  ]
}
```

Concurrent access protected by `flock` on `~/.atmux/state/host-epic-registry.json.lock` (sibling lockfile; sidecars matching the convention in `.atmux/{flags,decisions,kanban}.md.lock`). Every read+write that mutates state takes the lock; bare reads (e.g. `host-audit --json`) snapshot under the lock then release before formatting.

**Default `hostCap = 8`** rationale: 64 GiB hax box; each epic-team ≈ 6 members × ~250 MB RSS = ~1.5 GiB ⇒ 8 × 1.5 GiB ≈ 12 GiB epic-cage RSS budget (leaves ~50 GiB for parent teams, OS, observability). Tunable via `~/.atmux/host-config.json::hostCap` — operator can lower to 4 if RAM pressure spikes; cap is the hard ceiling, not a target.

### `atmux team spawn-epic` gate

Pre-spawn flow (replaces the current direct-spawn path):

1. Open + `flock` `~/.atmux/state/host-epic-registry.json.lock`.
2. Read registry; filter `epics[]` to **live** entries — `tmux -S <tmuxSocketPath> list-sessions` returns exit-0. Stale entries (socket gone) get pruned in this pass.
3. If `live.length < hostCap`:
   - Insert new entry with `spawnedAt = now`, `priority` from `--priority` flag (default `normal`).
   - Release flock.
   - Proceed with existing spawn-epic (worktree + tmux socket + cockpit registry per ADR-090).
4. If `live.length ≥ hostCap` **AND** `--queue` flag passed:
   - Append to `queue[]` with `spawnArgs = original argv`.
   - Release flock.
   - Exit code **75** (`EX_TEMPFAIL`).
   - Discord-ping `[host-cap-queue-grew]` template when queue length crosses thresholds {3, 5, 10}.
5. If `live.length ≥ hostCap` **AND** no `--queue` flag:
   - Release flock.
   - Hard-refuse: exit code **16**.
   - Print: (i) `epics[]` roster sorted by dormancy (most-dormant first), with last-commit-age + last-pane-activity-age columns; (ii) suggested retirement targets (top-3 dormants); (iii) hint `atmux team dissolve-epic <epicId>` + `atmux team spawn-epic … --queue` retry.
   - Discord-ping `[host-cap-reached]` template (rate-limited 1 ping / 10 min / project to prevent storm).

`--priority emergency` (driver-audited; logged to `~/.atmux/state/host-priority-audit.log`) jumps to head of queue but does **NOT** raise the cap. Cap is non-negotiable.

### Dormancy heuristic

An epic-team is **dormant** when ALL hold:

| Signal | Threshold (default) | Source |
|---|---|---|
| `lastCommitAt < now - 4h` | 240 min | `git -C <epicRoot> log -1 --format=%ct` |
| `lastPaneActivityAt < now - 1h` | 60 min | Newest `.atmux/state/heartbeats/<epicId>-<member>.json` mtime across the cage's members |

Thresholds tunable via `~/.atmux/host-config.json::dormancy.{commitMin,paneMin}`. Both-must-hold is intentional: a busy researcher (pane active, no commits yet) is NOT dormant; a stuck-on-something cage (commits stale, but member typing) is NOT dormant; only the both-cold case surfaces.

Dormancy is a **surface signal** for the operator. v1 does NOT auto-retire — see OQ4.

### New verb: `atmux host-audit`

```
atmux host-audit [--json] [--dry-run] [--retire-dormant] [--commit-min N] [--pane-min M] [--init]
```

| Flag | Default | Effect |
|---|---|---|
| `--json` | false | Machine-readable output. Stderr stays human. |
| `--dry-run` | true (when `--retire-dormant`) | Report-only; no dissolve calls. |
| `--retire-dormant` | false | Invoke `atmux team dissolve-epic <epicId>` on each dormant. **Operator-gated** — refuses unless `~/.atmux/host-config.json::dormancy.autoRetireEnabled === true`. |
| `--commit-min N` | from host-config | Override `dormancy.commitMin` for this run. |
| `--pane-min M` | from host-config | Override `dormancy.paneMin` for this run. |
| `--init` | false | First-run BACKFILL — glob `*-epics/e-*/` worktrees host-wide, populate registry from on-disk state. |

Output (`--json` shape):

```jsonc
{
  "scanned": 12,
  "live": 11,
  "stale": 1,                              // tmux socket gone; pruned from registry
  "dormant": 4,
  "epics": [
    {
      "epicId": "e-xxxxxxxx",
      "project": "atmux",
      "ageH": 5.2,                         // hours since spawnedAt
      "lastCommitAgeH": 6.1,
      "lastPaneActivityAgeH": 2.3,
      "verdict": "dormant | active | stale"
    }
  ],
  "queue": { "depth": 3, "head": { "queueId": "q-...", "project": "..." } }
}
```

Cron line installed by `atmux start` at the **host-tier** (NEW concept — sibling to per-team cron blocks):

```
# >>> atmux:host
*/15 * * * * /usr/local/bin/atmux host-audit --json >> ~/.atmux/state/host-audit-report.jsonl 2>&1
# <<< atmux:host
```

Sandwiched by `atmux:host` markers so `atmux stop` can prune. Idempotent install + prune.

### `atmux team dissolve-epic` registry cleanup

Existing verb (per ADR-090) extended. On successful dissolve:

1. Acquire registry flock.
2. Remove the epic's row from `epics[]`.
3. If `queue[]` non-empty: pop highest-priority head; release flock; **exec** that queued spawn-epic via the same code path (re-enters the gate, may succeed or re-queue).
4. Discord-ping `[host-cap-opened]` if a queued spawn dispatched.

### Discord templates (new)

| Template | Fires on | Body |
|---|---|---|
| `[host-cap-reached]` | hard-refuse | live count / cap / top-3 dormants suggested for retirement; rate-limited 1/10min/project |
| `[host-cap-opened]` | dissolve frees slot AND queue had entries | dispatched epicId + project + queuedAt-age |
| `[host-cap-queue-grew]` | queue length crosses {3, 5, 10} | depth + next-head epicId |
| `[host-dormant-warning]` | `host-audit` cron finds new dormants | epicId list + per-epic dormancy reasons; rate-limited 1/hour/epicId |

### Config: `~/.atmux/host-config.json`

NEW host-tier config; created on first `atmux team spawn-epic` (or `atmux host-audit --init`) if absent.

```jsonc
{
  "version": 1,
  "hostCap": 8,
  "perProjectSoftCap": 3,
  "dormancy": {
    "commitMin": 240,                      // 4h
    "paneMin": 60,                         // 1h
    "autoRetireEnabled": false             // operator opt-in only
  },
  "queue": {
    "maxLength": 20,
    "fullPolicy": "hard-refuse"            // alt: "evict-oldest" (NOT v1)
  }
}
```

### Migration (one-time backfill)

The 61 existing tmux-server snapshot pre-dates the registry. First `atmux host-audit --init`:

1. Glob `<HOME>/work/src/*-epics/e-*` + `<HOME>/work/ifca/*-epics/e-*` etc. (parent-root convention from ADR-090 — `<parentRoot>-epics/<epicId>`).
2. For each match: parse `<epicRoot>/.atmux/team.json` for `name` + parent linkage; `tmux -S <socket> list-sessions` for liveness; `git -C <epicRoot> log -1 --format=%ct` for `lastCommitAt`.
3. Atomic write to `~/.atmux/state/host-epic-registry.json`.
4. Emit `[host-cap-reached]` Discord ping if live count already ≥ hostCap so operator knows the next spawn will refuse.

Operator-driven manual reduction precedes any new spawn — v1 cap (8) is well below current 61. Driver handles the cross-cage retirement triage in parallel (out-of-band); this ADR provides the registry + verbs that triage uses.

## Consequences

| Lane | What changes |
|---|---|
| **be** | `src/verbs/team-spawn-epic.ts` gains pre-spawn flock + cap-check + queue path (~80-120 LOC). |
| **be** | `src/verbs/team-dissolve-epic.ts` gains registry-row-remove + queue-auto-dispatch on success (~40-60 LOC). |
| **be** | New verb `src/verbs/host-audit.ts` (~150-200 LOC) + `src/core/host-registry.ts` (~100-150 LOC: flock-bracketed IO, Zod-validated). |
| **be** | New `src/schema/host-registry.ts` Zod schema for registry + host-config. |
| **db** | Registry is JSON (per ADR-126 fallback); NO state.db migration. Cleanest layer separation. |
| **ops** | `atmux start` installs **host-tier** cron block (NEW concept) sandwiched by `# >>> atmux:host` markers. `atmux stop` prunes idempotently. |
| **docs** | NEW `docs/RUNBOOK-host-tier.md`; CHANGELOG; `CLAUDE.md` §host-cap pointer; brief update for lead/planner (`templates/briefs/lead.md` + `planner.md` — `spawn-epic` capacity awareness). |
| **test** | Unit tests for registry IO under flock contention; e2e for spawn-epic refusal + queue + dissolve-epic auto-dispatch + dormancy detection via fake heartbeat timestamps. |

**Forward enablement**: sentinel (ADR-132/158) gains a candidate role at host-tier — surfacing dormants, nudging drivers when queue grows. Separate ADR if pursued.

**Rollback**: delete `~/.atmux/state/host-epic-registry.json` + `host-config.json` + remove host-tier cron + revert spawn-epic gate to no-op via a `hostCapEnabled=false` host-config short-circuit. Existing live epic-teams unaffected.

## Open questions

1. **OQ1: Registry location — `~/.atmux/state/` (per-user) or `/var/atmux/` (host-wide root-owned)?**
   - Default: **per-user `~/.atmux/state/`**. Hax is single-user (geoyws) per global CLAUDE.md `/Machines`. /var/ adds permission overhead for v1 single-user gain.
   - Reversibility: medium — a `host-audit migrate` verb would relocate.

2. **OQ2: JSON + flock vs SQLite WAL for the registry?**
   - Default: **JSON + flock**. O(10s) writes/hour, no contention bottleneck expected. SQLite WAL is overkill + adds dependency. Matches ADR-126 fallback convention.
   - Reversibility: medium — if write contention surfaces, migrate via host-audit migrate verb.

3. **OQ3: Default cap value — 8?**
   - Default: **8** on 64 GiB hax box per the cap-math above (~12 GiB epic-cage RSS budget out of 64 GiB total). Tunable.
   - Reversibility: low — operator edits host-config.json + next spawn-epic reads new value.

4. **OQ4: Auto-retire dormants?**
   - Default: **NO** by default; opt-in via `host-config.json::dormancy.autoRetireEnabled = true`. Cross-cage automatic reaping is risky — a dormant cage may be mid-long-test, mid-research, or mid-conflict-resolution. v1 surfaces the verdict; operator dissolves manually.
   - Reversibility: low — flip the bool.

5. **OQ5: Per-project quota — enforced or advisory?**
   - Default: **advisory** (`perProjectSoftCap` recorded but not gated). Host cap is non-negotiable; per-project distribution is operator-managed.
   - Reversibility: medium — adding enforcement later breaks teams that relied on advisory semantics.

6. **OQ6: Queue ordering — FIFO or priority?**
   - Default: **priority then FIFO**. `priority=emergency` jumps ahead (audited to host-priority-audit.log); within same priority, FIFO.
   - Reversibility: low.

7. **OQ7: Queue-full policy — refuse or evict-oldest?**
   - Default: **hard-refuse** when `queue.length ≥ queue.maxLength` (default 20). Eviction is dangerous; refusal surfaces backpressure cleanly.
   - Reversibility: low.

8. **OQ8: Spawn-epic at cap — block until capacity or return immediately?**
   - Default: **return immediately** with exit 75. Non-blocking. Background watcher (`host-audit` cron) detects capacity + dispatches queued head. Avoids stranding the verb invocation for hours.
   - Reversibility: low.

9. **OQ9: How does `host-audit` know who to Discord-ping when capacity opens?**
   - Default: queue entry's `queuedBy` field carries the requesting member; ping target derives from `team.json::discord` for that member's project. Falls back to default-channel if unresolvable.
   - Reversibility: low.

## Sub-tasks (decomposed by planner)

- **T1** — ADR-184 draft (this file) + Zod schema sketch for registry + host-config + cross-refs (lane=`misc`, deps=none, priority=1).
- **T2** — Schema + IO module `src/core/host-registry.ts` + `src/schema/host-registry.ts` with flock-bracketed read/write, atomic temp-file rename, Zod validation (lane=`be`, deps=T1, priority=1).
- **T3** — `atmux host-audit --init` BACKFILL — glob `*-epics/e-*` host-wide, write initial registry, emit `[host-cap-reached]` if already over cap (lane=`be`, deps=T2, priority=1).
- **T4** — `atmux team spawn-epic` gate — pre-spawn flock + cap-check + queue + exit-75 path + roster-print on refuse + Discord templates (lane=`be`, deps=T2, priority=1).
- **T5** — `atmux team dissolve-epic` registry-cleanup + queue auto-dispatch on success + `[host-cap-opened]` ping (lane=`be`, deps=T2+T4, priority=2).
- **T6** — `atmux host-audit` verb (read-only scan + dormancy verdict + `--json` + `--retire-dormant` operator-gated path) + host-tier cron block install/prune in `atmux start`/`atmux stop` (lane=`be`, deps=T2, priority=2).
- **T7** — e2e: cap-refuse → dissolve → queued spawn fires; dormancy detection via fake heartbeat mtimes + fake git log; flock contention test under 4-way parallel spawn-epic (lane=`test`, deps=T4+T5+T6, priority=2).
- **T8** — Docs: NEW `docs/RUNBOOK-host-tier.md` + CHANGELOG + `CLAUDE.md` §host-cap pointer + briefs update (lead + planner) + ADR-184 status flip proposed→accepted gated on reviewer signoff (lane=`misc`, deps=T7, priority=3).

## Acceptance

- [ ] ADR-184 lands proposed → accepted after reviewer signoff.
- [ ] `~/.atmux/state/host-epic-registry.json` exists + `host-audit --init` backfills successfully against current 61 tmux servers.
- [ ] `atmux team spawn-epic` hard-refuses at cap with printed roster + retirement hints; `--queue` enqueues + exit 75.
- [ ] `atmux team dissolve-epic` removes the row + auto-dispatches highest-priority queued head.
- [ ] `atmux host-audit` (cron `*/15`) surfaces dormants to `~/.atmux/state/host-audit-report.jsonl` + Discord `[host-dormant-warning]`.
- [ ] Discord templates fire with correct rate-limits (`[host-cap-reached]` 1/10min/project, `[host-dormant-warning]` 1/hour/epicId).
- [ ] e2e green; reviewer signs off.

## Out of scope (deferred)

- **Cross-host registry** (multi-machine atmux). v1 is single-host (hax only).
- **Auto-retirement of dormants** in v1 — operator-gated opt-in only.
- **Sentinel-style host-tier observer** (ADR-132/158 extension) — separate ADR if pursued; host-audit cron is the v1 substitute.
- **Per-member RSS caps** — kernel cgroup territory; different layer.
- **Web UI / TUI for queue management** — CLI + Discord templates suffice for v1.
- **Soft per-project caps enforcement** — advisory only in v1 per OQ5.

## Cross-refs

- ADR-018 (per-team tmux socket isolation).
- ADR-058 (cage tiering — host-tier is implicit Tier-0).
- ADR-077 (medic — dormancy-heuristic precedent for idle-pane signal).
- ADR-090 (epic-team lifecycle — `spawn-epic` + `dissolve-epic`; this ADR extends both).
- ADR-126 (JSON fallback storage pattern — registry uses this path).
- ADR-132/158 (sentinel — possible v2 host-tier observer).
- ADR-148 (commit-cadence ground-truth signal — primary dormancy axis).
- Origin: 2026-05-17 22:25 MYT driver P0 (driver-inbox tail line 5742+).
