# Whip §2.5 — Needs-approval surfacing

Operator reference for the whip-tick `needs-approval` scan introduced in [ADR-085](./adr/085-whip-approvals-watcher.md).

## What it is

A scan that runs every whip tick (5-min cron + manual `atmux whip`) across three sources of approval-debt and surfaces anything that's been waiting too long. The scan is **live-not-cached** per [ADR-068](./adr/068-live-truth-status.md) §HC#4 — every tick re-reads the source files. No persisted state to maintain.

When the scan finds anything actionable, it:

1. Emits a `[whip-needs-approval]` Discord template (verdict-first, dedup-keyed on `<team>:<bucket>:<id>`).
2. Surfaces the count on `atmux status` via a new `NEEDS APPROVAL` row.
3. Adds the structured entries to the `--json` snapshot's `needsApproval` field for downstream tooling.

## Scope — three buckets

| Bucket | Source | Stale threshold | What it catches |
|---|---|---|---|
| **A — Proposed ADRs** | `docs/adr/*.md` (+ `docs/adr-bun/*.md` if present) matching `^**Status**:\s*(proposed\|draft\|wip\|pending)` | Always stale (no time-based gate) | ADRs that shipped impl but never had their status flipped to `accepted` |
| **B — Untriaged driver-inbox asks** | `.atmux/driver-inbox.md` headings without inline `✅` / `📤` / `⏳` / `❌` marker | >30 min since the heading's MYT timestamp | Asks the lead hasn't acknowledged yet — typically auto-mode resolutions awaiting reviewer signoff |
| **C — Long-blocked tasks** | Kanban tasks with `status = blocked` (via `state.db`) | >2 h since the most recent state transition | Tasks that have been stuck in blocked and need an unblock decision |

All three reads are part of the same surfacing pipeline; the Discord template chunks them per-bucket so the operator's 2-second triage shows which class of debt is biggest.

### The (deferred:) carve-out for Bucket A

ADRs that are **intentionally** held in `proposed` status — pending an upstream decision, a parallel ADR, or an operator review window — would otherwise ping every tick. To suppress the ping while keeping the ADR honest about its state, use the convention:

```markdown
**Status**: proposed (deferred: <one-line reason>)
```

For example:

```markdown
**Status**: proposed (deferred: waits on ADR-091 epic-team auto-merger spec)
```

The whip scanner treats `(deferred: …)` as "not actually waiting on approval — operator will revisit." Bare `proposed` continues to ping. See [project-root CLAUDE.md §"ADR write-flow"](../CLAUDE.md) for the binding convention.

## Surfaces

### 1. `atmux status` — the approval row

The `atmux status` text output gains a row:

```text
📋 kanban board: 📌 N tasks todo, 🟡 N tasks in-progress, ✅ N tasks done, 🛑 N tasks blocked
📝 awaiting your approval: 3 proposed ADRs, 1 driver-inbox asks, 0 blocked kanban tasks
```

When all three buckets are empty, the row collapses to `📝 awaiting your approval: ✅ nothing is waiting for sign-off` (positive-state grammar matching the driver-pane / medic / kanban rows). The row is always present — it doesn't skip on empty. When the board itself is empty the line above it collapses to `📋 kanban board: no tasks on it at all`.

**Both lines are worded to survive being read ALOUD, and that is a functional requirement, not style.** `atmux status`'s text output is what the `team_status` voice tool hands to a language model. The earlier wording — `📋 kanban  📌 todo=0 …` immediately above `📝 NEEDS APPROVAL: ✅ clear` — was relayed to the operator as *"the kanban is clear and needs approval"*, fusing two true lines into one false claim; and the enumerated counts spent the words *in-progress* and *blocked*, which are also pane vocabulary, producing *"no tasks are in progress or blocked"* about a team that had a blocked pane. Each line now names its own subject in full and keeps the noun welded to every number. See [ADR-273](adr/273-voice-fleet-triage-and-pane-input.md) §Supplement-6 X3; the older grammar in [ADR-085](adr/085-whip-approvals-watcher.md) §Surfaces is superseded.

### 2. `atmux status --json` — `needsApproval` field

The JSON snapshot grows a `needsApproval` field with the structured per-bucket lists:

```json
{
  "needsApproval": {
    "total": 4,
    "adr": [
      { "id": "ADR-085", "path": "docs/adr/085-whip-approvals-watcher.md", "subject": "Whip approvals-watcher", "ageMin": 2880 }
    ],
    "inbox": [
      { "id": "2026-05-13T14:32 MYT — ADR-091 path question", "path": ".atmux/driver-inbox.md", "subject": "ADR-091 path question", "ageMin": 47 }
    ],
    "kanban": []
  }
}
```

Downstream tooling (atmux-dashboard, medic loop's hourly sweep, cockpit pulse) reads this field. The shape is forward-compatible — new buckets get appended without breaking existing consumers.

### 3. Discord `[whip-needs-approval]` template

Fires when `needsApproval.total > 0` AND at least one entry has crossed its stale threshold since the previous tick. Header: `📝 **[whip-needs-approval]** · \`<team>\` · HH:MM MYT`. Body lists up to 3 entries per bucket (older entries collapse to a `+N more` suffix). Dedup window: 30 min per `<team>:<bucket>:<id>` key — the scan is live, but the ping isn't (avoids spamming on every tick).

## Opt-out

Set `team.json::whip.needsApprovalEnabled = false` to disable the entire surfacing pipeline for one team. The scan still runs (the cost is trivial), but no surface fires. Used by teams whose docs-discipline lives outside `docs/adr/` or whose driver-inbox follows a different marker convention.

Default: `true` (no team.json field needed for the canonical surfacing).

## What it doesn't do

- **No auto-flip** — the scan surfaces, it doesn't decide. Flipping an ADR's `Status: proposed → accepted` is always a human (lead + reviewer + operator) decision per the [project-root CLAUDE.md §"ADR write-flow"](../CLAUDE.md) rule.
- **No retroactive backfill** — the scan reads source files at tick time. Historical "this ADR sat proposed for 6 days" data is not persisted; the scan answers "what's waiting NOW," not "what waited THEN."
- **No cross-team correlation** — each team's whip surfaces its own paperwork debt. The cockpit-tier medic ([ADR-077](./adr/077-superdoctor-cockpit-role.md) + [ADR-133](./adr/133-medic-rename.md)) handles fleet-wide aggregation if needed.

## Status

ADR-085 §Scan API (`src/lib/needs-approval.ts`) + §Three surfaces #1 (status row + JSON field) + §Three surfaces #2 (whip integration + Discord template) all shipped. ADR-085 flipped to accepted on 2026-05-14 alongside this doc landing (Task t-968416aa).
