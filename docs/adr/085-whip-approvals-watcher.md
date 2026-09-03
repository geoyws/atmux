# ADR-085: Whip approvals-watcher — surface proposed-ADRs, stale driver-asks, long-blocked tasks

**Status**: accepted (2026-05-14, all deps green — t-21c3aa64 whip §2.5 integration + Discord template, t-9281649f status NEEDS APPROVAL row, t-3516d73a tests; paperwork flip authorized by driver per Task t-968416aa queue-drain dispatch)
**Date**: 2026-05-12
**Accepted**: 2026-05-14

## Context

Decomposition of t-e1bf1bbd (George, 14:14 MYT 2026-05-08): "always surface non-approved work in driver-asks digest so it doesn't rot."

### Failure mode observed (2026-05-08)

George ran a paperwork-catch-up batch at 14:13 MYT — 7 ADRs sat in `Status: proposed` for days while their implementation had already shipped (ADR-bun/062, /064, /068; ADR/032, /033, /036, /037). The whip cycle never surfaced them; they aged silently. historical decision number 068 (no surviving ADR file) §HC#4 already nailed the philosophy ("live-not-cached status / uptime / activity"), but it scopes to runtime state (pane liveness, kanban counts, lead-events). This ADR extends HC#4's contract to **paperwork debt**: anything awaiting driver/lead acknowledgement that whip can see in plaintext.

The pattern recurs today — 6 ADRs are currently `proposed` (077, 079, 080, 081, 082, 084), several with implementation already merged. Without a watcher, the next paperwork-catch-up batch is a matter of when, not if.

### Three approval-debt buckets

| Bucket | Source | Stale threshold | Today's count (sample) |
|---|---|---|---|
| A — Proposed ADRs | `docs/adr/*.md` matching `^**Status**:\s*(proposed\|draft\|wip\|pending)` | always stale | 6 |
| B — Untriaged driver-inbox asks | `.atmux/driver-inbox.md` `^## ` heading without inline ✅/📤/⏳/❌ marker in the heading or its section body | >30 min since the timestamp in the heading | TBD per tick |
| C — Long-blocked tasks | kanban tasks where `status = blocked` | >2 h since most recent state transition | TBD per tick |

These are three different reads, but the same surfacing pipeline.

## Decision

Add a `needs-approval` scan to whip's tick loop. Re-runs every tick (5 min cron + manual `atmux whip`), live-not-cached per historical decision number 068 (no surviving ADR file) §HC#4.

### Scan API (`src/lib/needs-approval.ts`)

```ts
export interface NeedsApprovalEntry {
  bucket: "adr" | "inbox" | "kanban";
  id: string;          // ADR slug / heading anchor / task-id
  path: string;        // file path (ADR) / driver-inbox.md (inbox) / kanban-row pointer
  subject: string;     // heading text / task subject (≤80 char)
  ageMin: number;      // minutes since the source timestamp
}

export interface NeedsApprovalReport {
  adr: NeedsApprovalEntry[];
  inbox: NeedsApprovalEntry[];
  kanban: NeedsApprovalEntry[];
  total: number;
}

export async function scanNeedsApproval(deps?: ScanDeps): Promise<NeedsApprovalReport>;
```

`ScanDeps` injects fs + clock for tests; defaults to real fs + `Date.now()`.

### Three surfaces

1. **`atmux status`** (existing verb, `src/verbs/status.ts`) — append `NEEDS APPROVAL: N ADRs / M inbox / K kanban` count row. `--json` snapshot grows a `needsApproval: NeedsApprovalReport` field.
2. **Whip Discord digest** — new template `whip-needs-approval` per CLAUDE.md Discord format §6: header `📋 **[whip-needs-approval]** · \`atmux\` · HH:MM MYT`, bulleted body grouped by bucket, ≤80 chars per bullet, max 5 entries per bucket (overflow → "+N more" tail). Skip the ping entirely when `total == 0`.
3. **lead-events JSONL** — append one `{ts, kind: "needs-approval-snapshot", report}` row per tick. Feeds future dashboards.

### Heading-marker grammar (bucket B)

Driver-inbox today uses two patterns for status:
- Marker on the heading itself: `## 17:07 MYT 2026-05-08 — ... 📤 **[13:22 MYT planner]** decomposed ...`
- Marker in section body (first line under heading): `✅ override: <reason>` / `📤 ...` / `⏳ ...` / `❌ ...`

The scan considers an ask **triaged** if ANY of {✅, 📤, ⏳, ❌} appears in the heading text OR in the first 20 non-blank lines of its section body. The `🚨` / 🪫 emojis are CATEGORY markers (P0, budget-pause), NOT status — those don't count as triage.

### Stale-threshold rationale

- Bucket A (ADR): no grace — `proposed` is the stale state. If it's been merged for >24h still proposed, that's the very pattern we're catching.
- Bucket B (inbox): 30 min. Empirical: lead's whip cycle is 5 min, so a 30-min unmarked ask = lead saw it 6 times without triaging. That's the rot signal.
- Bucket C (kanban): 2h. Most blockers resolve faster than 2h; >2h means coordination gap.

## Consequences

- **Whip lane (whip-impl)**: gains a §2.5 scan-and-surface block; new `whip-needs-approval` Discord template behind the existing `sendDiscord` path.
- **Status lane (parity-read-impl)**: `gatherStatus` gains a `needsApproval` field; printer gains one row; `--json` payload grows one key. Breaking change for any current `--json` consumer — none known, but reviewer should grep.
- **DB lane**: no schema change. All three buckets read existing surfaces (filesystem ADRs, plaintext driver-inbox, SQLite kanban with `status` column already present).
- **What we give up**: a teammate who deliberately leaves a `proposed` ADR pending discussion will see it pinged every 5 min. Mitigation: a `^**Status**:\s*proposed\s*\(deferred:\s*<reason>\)` annotation suppresses the entry. Reviewer enforces deferred-reason at ADR-write time.
- **Rollback path**: feature-flag via `team.json` `whip.needsApprovalEnabled` (default `true`). Setting `false` skips the scan + suppresses both surfaces. Reverting the commit is also safe — no migration.

## Open questions

1. **OQ1**: Should bucket C (kanban-blocked) also include `todo` tasks with `staleMin` exceeded (per historical decision number 053 (no surviving ADR file) staleness model)? Recommended default — **no**; staleness is a different signal (no claim within window) and whip already handles it via §4 (stale-task surfacing). Keep `needs-approval` scoped to status=blocked transitions. (reversibility: low — easy to add later if signal demand exists)
2. **OQ2**: Discord noise budget. If bucket totals exceed ~15 entries, the ping body explodes past 2000 chars and chunks. Recommended default — **single chunk, hard-cap at 5 per bucket + "+N more" tail**, driver shells in for full list via `atmux status --json | jq .needsApproval`. (reversibility: low)
3. **OQ3**: Should `^Status: draft` ADRs (vs `proposed`) be excluded — i.e., is `draft` an intentional "not ready for review yet" state? Recommended default — **include both**; today's corpus uses `proposed` exclusively, but defending against future drift is cheap. Author who genuinely wants a draft uses the `(deferred: <reason>)` escape hatch. (reversibility: low)

OQ1+OQ2+OQ3 are all reversibility:low; `atmux decisions add` is the right channel once the verb ports to bun, but for now I'll record them in this ADR + leave the override window open until reviewer pre-land signoff.

## Refs

- Parent kanban entry: t-e1bf1bbd (planner-claimed 2026-05-12)
- historical decision number 068 (no surviving ADR file) §HC#4 — live-not-cached status contract this ADR extends
- historical decision number 053 (no surviving ADR file) — staleness model (separate surface, do not conflate)
- CLAUDE.md §Discord message format — `whip-needs-approval` template shape
- `src/verbs/whip.ts:142+` — WhipArgs / classifySessionState integration point
- `src/verbs/status.ts:128+` — StatusSnapshot interface to extend
