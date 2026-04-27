# ADR-030: Registry-recorded animal emojis per member — immutable once written

**Status**: accepted
**Date**: 2026-04-27
**Renumbered**: 2026-04-27 — was ADR-029 in initial draft; renumbered to ADR-030 after collision with driver's [ADR-029: Driver+lead team-scope](./029-driver-lead-team-scope-superdriver-cross-team.md) (which landed on disk first).
**Related**: [ADR-025](./025-superdriver-phase-1.md) (registry foundation), [ADR-027](./027-team-rename-verb-and-topology-invariant.md) (rename verb mutates registry)

## Context

`team.json:.members[].emoji` is currently optional. When absent, `team.json:.emojis.mode = "random"` triggers fresh random picks per spawn from a hardcoded animal palette. Today's fleet snapshot (2026-04-27 09:50 MYT):

- `aix-root` — entire roster has no `.emoji` field; each `atmux start` randomises.
- `sopx-mvp` — only the unblocker has a baked emoji; everyone else randomises.
- `atmux-kanban` — only the unblocker has one.
- `geoyws-beads` — only the unblocker has one.

Visible window-name emojis in `tmux list-windows` ARE displayed today (the `__<team>__<emoji><member>` window-name pattern), but they are **fresh on every restart**. Driver feedback: emojis should be stable forever once first assigned — the visual shorthand the driver builds up over weeks of operation is invalidated by every restart cycle.

Two failure modes with the current shape:

1. **Random churn on every restart** — `atmux rotate <member>` or `atmux stop` + `atmux start` re-randomises any member without a baked `team.json:.emoji`. The driver's mental model of "the rabbit is be-kanban" breaks the moment that team restarts.
2. **Bulk-rename Sg amplifies the problem** — Sg fires 4 team renames sequentially; each invokes the rename verb which (per ADR-027) doesn't touch members but the spawn flow on next ambient activity randomises any non-baked member. Without backfill before Sg, the entire fleet's emoji scheme is wiped in one bulk-rename window.

The right invariant is **immutable once written**. The first time a member spawns and gets a random emoji, that emoji persists forever across restarts. The registry (`~/.claude/teams/registry.json`, ADR-025) is the natural durable store — it survives `.atmux/` directory moves, team renames (per ADR-027 the registry primary key migrates), and cross-team aggregation.

## Decision

**Add `members[].emoji` field to registry schema** (extends ADR-025 §Decision):

```json
{
  "name": "atmux",
  "projectRoot": "/root/work/src/atmux",
  "sessionName": "atmux",
  "createdAt": 1777246800,
  "lastSeen": 1777251074,
  "status": "running",
  "members": [
    {"name": "lead", "emoji": "🦁"},
    {"name": "be-kanban", "emoji": "🐰"},
    ...
  ]
}
```

Each `members[i]` entry is a `{name, emoji}` object. The `emoji` field is **immutable once written** — `atmux::registry_upsert` MUST NOT overwrite an existing non-empty emoji. Only fills empty/missing slots.

**Lookup priority** at spawn time (`lib/start.sh`, `lib/add-member.sh`, anywhere member emoji is resolved):

1. **Registry** — `~/.claude/teams/registry.json` → `teams[name=$team].members[name=$member].emoji`. If present + non-empty → use it.
2. **team.json** — `<projectRoot>/.atmux/team.json:.members[name=$member].emoji`. If present + non-empty → use it AND persist back to registry (write-through cache).
3. **Random fallback** — pick from animal palette → use it AND persist back to registry. Subsequent spawns hit step 1 and return the persisted value.

The persist-back-on-random step is the load-bearing one: it converts the first-spawn random pick into a durable assignment.

**Backfill is mandatory before any rename or restart cycle that would re-randomise.** New `atmux registry-backfill` verb (`lib/registry-backfill.sh`, NEW): walks every running team's tmux windows, regex-parses the `__<team>__<emoji><member>` pattern, persists the parsed emoji into the registry. Idempotent — runs against any registry state. MUST be fired BEFORE bulk-rename Sg so the current spawn-emojis are captured before any restart cycle randomises them.

**Sg ordering dep**: each of the 4 Sg OPS Tasks (SG_T1..SG_T4) gains a deps entry on the Sh backfill OPS Task. Bulk-rename cannot fire before backfill.

## Consequences

- **`lib/registry.sh` schema gains `members[]` array** (~10 LOC delta to the upsert helper for the immutable-once-written guard).
- **`lib/start.sh` + `lib/add-member.sh` emoji-resolution refactor** — ~25 LOC: lookup priority chain + persist-back call. Centralise into a shared helper if natural.
- **`lib/registry-backfill.sh` (new) + `atmux registry-backfill` dispatcher** — ~50 LOC: walk tmux windows, regex-parse, persist. Driver-fired one-shot.
- **`tests/unit/registry_emoji.bats`** — lookup priority + persist-on-random + immutable-once-written (assert no overwrite) + cross-restart stability.
- **Backward compat** — teams without registry `members[]` array work as before until their first start (which then back-fills). Bumping registry schema is non-breaking; `members // []` default in jq filters.
- **Trade-off accepted**: registry schema grows; reads cost slightly more. Acceptable — registry is read on cron ticks (super-status, doctor) but not in the spawn hot path more than once.
- **Sg dependency**: backfill MUST run before Sg fires, OR each Sg OPS Task internally re-runs backfill. Cleaner is the explicit dep gate.
- **Lookup priority intentionally puts registry first** — it's the immutable layer. team.json is a cold-start seed only; registry takes over once a member has spawned.

## Open questions

1. **OQ I6 (medium): emoji immutability — strict (never overwrite) vs soft (overwrite if team.json explicitly sets a different one)?** Resolved: STRICT immutable. Once registry has an emoji for a member, it is permanent. team.json edits to an already-registered member's `.emoji` are ignored at spawn time. Override path: edit registry directly via jq (operator-explicit). (medium-rev — could relax to soft if operators find strict too restrictive.)
2. **OQ I7 (low): backfill script path?** Resolved: `lib/registry-backfill.sh` + `atmux registry-backfill` verb. Fits existing lib/<verb>.sh + bin/atmux dispatcher pattern. (low-rev — implementation choice.)
3. **OQ I4 (medium): Sg → Sh ordering — explicit deps gate vs internal re-backfill in Sg?** Resolved: explicit deps gate. Each SG_T1..SG_T4 deps on Sh OPS Task. Auditable + matches kanban deps[] gating semantics; internal re-backfill would scatter the invariant across 4 Tasks. (medium-rev.)

All resolutions logged to `.atmux/decisions.md`.
