# ADR-153: Auto-promotion rules — kanban-blocked → complaint (24h) / driver-inbox → flag (12h) / lead-outbox → inbox_messages (6h) + `blocked_at` column

**Status**: proposed
**Date**: 2026-05-16
**Author**: atmux team (docs / t-28a75ee5)
**Parent EPIC**: t-cc7e9ce2
**Closes complaint**: c-33475fd6
**Driver-ref**: /bruh sweep 2026-05-16 00:17 MYT → operator "fix all complaints" directive → planner decomposed 00:43 MYT.
**Deps**: [ADR-152](152-atmux-blockers-list-unified-verb.md) (`blocker_class` taxonomy + canonical row shape that auto-promotion consumes).
**Reviewer**: pre-flag gate before T2–T6 impl tasks dispatch.

## Context

### The freshness problem — blockers age silently

[ADR-152](152-atmux-blockers-list-unified-verb.md) shipped a unified blockers-list aggregation across 7 coordination surfaces. But aggregation alone doesn't promote stale entries from low-visibility surfaces to high-visibility ones. Today three concrete staleness fingerprints recur:

1. **Kanban Tasks parked at `status=blocked`** with no aging signal — operator has to grep `atmux task list --status blocked` and remember when each was set. A 30h blocker looks identical to a 30min blocker.
2. **Driver-inbox entries** sitting unread for hours because the lead is mid-rotation / context-pressured / on a long Task. The driver doesn't know which inbox rows the lead has actually seen.
3. **Lead-outbox replies** to driver questions that the driver never acks — the lead doesn't know if the reply landed, and the question may need re-asking.

Each fingerprint has a different natural threshold and a different natural promotion target. The unifying pattern: **a stale signal on surface X should auto-promote into a higher-attention surface Y after a class-specific threshold**.

### Why deterministic rules, not heuristics

The unblocker role (ADR-151 — proposed) needs a queryable, stable source of "what is overdue?" — not "what is the unblocker's LLM-judged guess about overdue?" Auto-promotion gives the unblocker (and the operator, and the lead) a deterministic upgrade path. Operators can predict behaviour: a Task blocked at 23h is invisible; at 24h+1min a complaint will exist on the next groom tick.

This ADR ships **three rules in v1** (R1/R2/R3) chosen because each has prior evidence — recurrent observed staleness, clear natural promotion target, idempotent reapply. Future rules (R4+) land via new ADRs with the same shape (idempotence predicate + threshold + target).

### Connection to the coordination fleet

| ADR | Role |
|---|---|
| **ADR-151 unblocker** (proposed) | drains the consolidated signal each tick; reads ADR-152 inventory + ADR-153 freshness markers |
| **ADR-152 blockers list** (proposed; ships first per dep order) | inventory — what is blocked right now |
| **ADR-153 auto-promotion** (this ADR) | freshness signal — which blockers have aged past their class threshold |
| **ADR-154 storage port** (proposed) | substrate — markdown driver-inbox / lead-outbox → SQLite; R2/R3 predicates depend on this in steady-state |
| **ADR-155 pane-state verb** (proposed) | volatile signal — pane content classified per tick |

ADR-153 is the **temporal-overlay** for ADR-152. ADR-152 reports "this row is blocked"; ADR-153 reports "this row is blocked AND has aged past its class threshold". Downstream consumers (unblocker, ombudsman, operator triage) read the combined surface.

## Decision

### (D1) Three rules — idempotent, threshold-keyed, cron-driven

**Pre-flag #2 (idempotence is load-bearing)** — every rule includes a `NOT EXISTS` sub-query that prevents double-fire on the same source row. Reviewer rejects any R-rule definition without an idempotence predicate.

#### R1 — kanban-blocked → complaint (24h threshold)

**Detect**:
```sql
SELECT t.id, t.subject, t.blocked_at
  FROM tasks t
 WHERE t.status = 'blocked'
   AND (strftime('%s','now') - t.blocked_at) > (24 * 3600)
   AND NOT EXISTS (
     SELECT 1 FROM complaints c
      WHERE c.related_task_id = t.id
        AND c.status = 'open'
        AND c.opened_via = 'auto-promotion-R1'
   );
```

**Promote** (per matched row):
```sql
INSERT INTO complaints (id, opened_at, summary, related_task_id, blocker_class, status, opened_via, extra)
VALUES (
  '<uuid>',
  strftime('%s','now'),
  'stale blocker N+<age> on T-<task-id>',
  <task-id>,
  '<resolved-class>',         -- see pre-flag #1 below
  'open',
  'auto-promotion-R1',
  '{"thresholdHours": 24, "ruleId": "R1"}'
);
```

**`blocker_class` resolution** (pre-flag #1 — default + override):
1. Parse the matched task's body / note for an explicit marker: `[blocker_class:<value>]` (case-insensitive); when present and the value is a valid `BlockerClass` per ADR-152 §D3, use it verbatim.
2. Otherwise default to `"dep-not-shipped"` — the most common shape for stale 24h+ blockers (a dep that was supposed to land hasn't).

**Auto-resolve** (per tick, on every R1 pass — pre-flag #3 cron-not-write-hook):
```sql
UPDATE complaints
   SET status = 'resolved',
       resolved_at = strftime('%s','now'),
       extra = json_set(extra, '$.resolvedReason', 'task-unblocked')
 WHERE opened_via = 'auto-promotion-R1'
   AND status = 'open'
   AND related_task_id IN (
     SELECT id FROM tasks WHERE status != 'blocked'
   );
```

Cron-keyed (not write-hook) — cheap to run on every groom tick; one query handles every auto-promoted complaint at once.

#### R2 — driver-inbox unread → flag (12h threshold)

**Detect** (post-ADR-154 steady-state):
```sql
SELECT di.id, di.summary, di.opened_at
  FROM driver_inbox di
 WHERE di.triage_glyph IS NULL
   AND (strftime('%s','now') - di.opened_at) > (12 * 3600)
   AND NOT EXISTS (
     SELECT 1 FROM flags f
      WHERE f.relates_to_driver_inbox = di.id
        AND f.opened_via = 'auto-promotion-R2'
        AND f.resolved_at IS NULL
   );
```

**Pre-ADR-154 fallback** (markdown parse path): regex-match `^## \[?(?P<ts>\d{4}-\d{2}-\d{2}|HH:MM)` headings in `.atmux/driver-inbox.md` `## Open` section, skip headings whose body contains an inline triage glyph (`✅` / `📤` / `⏳` / `❌`), filter by `(now - parsed-ts) > 12h`. The pre-/post-154 paths are interchangeable: R2's predicate semantics stay stable; only the read path swaps.

**Promote** (per matched row):
```sql
INSERT INTO flags (id, opened_at, summary, severity, opened_via, relates_to_driver_inbox, extra)
VALUES (
  '<uuid>',
  strftime('%s','now'),
  '[stale-inbox] driver-inbox row #<id>: <summary> (age N+<age-h>)',
  'p2',
  'auto-promotion-R2',
  <driver-inbox-id>,
  '{"thresholdHours": 12, "ruleId": "R2"}'
);
```

**No auto-resolve — pre-flag #4 (flag stays one cycle)**. The flag is a one-shot detection signal: operator / driver / lead sees it on the next whip tick, acks the underlying driver-inbox row via triage glyph (✅ / 📤 / ⏳ / ❌), and the row's `triage_glyph` becomes non-NULL — R2 stops re-promoting. The flag persists in `.atmux/flags.md` until the next operator-triggered `atmux flag resolve` (manual; consistent with `flags.md` lifecycle per [ADR-010](010-atmux-flag.md)).

#### R3 — lead-outbox Open >6h unacked → heads-up via `inbox_messages` (6h threshold)

**Detect** (post-ADR-154 steady-state):
```sql
SELECT lo.id, lo.summary, lo.opened_at
  FROM lead_outbox lo
 WHERE lo.archived_at IS NULL
   AND (strftime('%s','now') - lo.opened_at) > (6 * 3600)
   AND NOT EXISTS (
     SELECT 1 FROM inbox_messages im
      WHERE im.relates_to_outbox = lo.id
        AND im.opened_via = 'auto-promotion-R3'
   );
```

**Pre-ADR-154 fallback** (markdown parse path): regex-match `## Open` section in `.atmux/lead-outbox.md`, parse `opened_at` from leading timestamp, filter unacked rows (no driver `✅` ack on the line), apply 6h threshold.

**Promote** (per matched row):
```sql
INSERT INTO inbox_messages (id, member, sender, kind, body, sent_at, opened_via, relates_to_outbox, extra)
VALUES (
  '<uuid>',
  '__driver__',                                 -- driver's well-known inbox key
  '__auto-promotion__',
  'heads-up',
  '<outbox-summary> (age N+<age-h>, unacked)',
  strftime('%s','now'),
  'auto-promotion-R3',
  <outbox-id>,
  '{"thresholdHours": 6, "ruleId": "R3"}'
);
```

**Auto-archive via existing `atmux outbox --ack <id>`** — when the driver runs the existing ack semantics on the source outbox row, the row's `archived_at` becomes non-NULL and R3's predicate stops matching; future ticks don't re-emit heads-ups for that row. **Pre-flag #8 (R3 dedup)**: the `NOT EXISTS` predicate on `inbox_messages.relates_to_outbox` is the per-row dedup gate — one heads-up per stale outbox row, regardless of how many ticks the row stays unacked past the 6h threshold.

### (D2) `blocked_at` column — new timestamp on `tasks`

#### Schema addition

```sql
ALTER TABLE tasks ADD COLUMN blocked_at INTEGER NULL;
```

`INTEGER` (epoch seconds, matching the existing `claimed_at` / `completed_at` columns). `NULL` on rows that have never been in the blocked state.

#### Write semantics

Set in the **same transaction** as the `status = 'blocked'` UPDATE (`BEGIN IMMEDIATE; UPDATE tasks SET status='blocked', blocked_at=strftime('%s','now') WHERE id=?; COMMIT;`). Transition OUT of blocked clears nothing — `blocked_at` retains the most recent blocked transition timestamp, preserving the freshness signal for R1's predicate (R1 only fires on `status='blocked'`, so cleared transitions self-evict from the predicate's result set).

If a Task re-enters blocked (`blocked → in-progress → blocked`), the second transition overwrites `blocked_at` with the new epoch. R1's `(now - blocked_at) > 24h` measures **time-since-most-recent-block-entry**, which is the operator-meaningful clock.

#### Backfill — pre-flag #5 (`blocked_at` migration heuristic)

Existing `status='blocked'` rows at migration time have no historical timestamp; the schema column is `NULL` until the migration backfills:

```sql
UPDATE tasks
   SET blocked_at = claimed_at
 WHERE status = 'blocked'
   AND blocked_at IS NULL;
```

**Acknowledged compromise**: `claimed_at` is **when the Task was claimed**, not **when it was blocked**. For most existing blockers, `claimed_at < blocked_at` (the Task ran for some time, then got blocked) — which means the backfilled timestamp **understates** the block-age. R1 fires earlier than the operator-true clock for backfilled rows. The compromise is acceptable because (a) forward-looking blocks have accurate timestamps (write-time stamping in the §Write semantics block above) and (b) the migration cycles through once; backfilled rows are bounded.

Documented in §Implementation as the **cut-over compromise**; an enhanced backfill (heuristic-parsing `task.note` for "blocked at HH:MM MYT" markers) is **out of scope** for v1 — too brittle, low ROI.

### (D3) Single groom-verb path — extend whip cycle, no new cron

**Recommendation** (pre-flag #6 sibling discussion): extend the existing whip cycle. Two paths considered:

| Path | Cost | Verdict |
|---|---|---|
| **(a) Extend whip cycle** at 15min default cadence: whip turn appends a "groom" pass after dispatch + status snapshot. Reuses whip's existing budget guard + tick-dedup. | One extra ~10ms SQLite read pass per tick. Zero new cron lines. | ✅ recommended |
| (b) New cron line `*/15 * * * * atmux groom` registered via `cron-install` | One additional cron line per team; one more failure point in `atmux doctor`'s cron-coverage check. | Rejected — cost outweighs benefit |

The extended whip turn calls a new verb-level function `runGroomPass()` in `src/verbs/groom.ts` (or `src/core/groom.ts` — placement decision deferred to T3 reviewer). The function is also invocable standalone via:

```
atmux groom [--rules R1,R2,R3] [--dry-run]
```

`--dry-run` reports what WOULD be promoted without writing to any table — useful for operator inspection and for the e2e gate. `--rules` (CSV) lets operators run a subset (`atmux groom --rules R1` for the kanban-blocked sweep only). Default `--rules R1,R2,R3` runs all three.

**Idempotence guarantee** (pre-flag #2 reified): re-running `atmux groom` immediately after a previous successful tick is a no-op — every rule's `NOT EXISTS` predicate filters out already-promoted rows. This makes `--dry-run` operator-safe even when the surrounding whip tick is mid-flight.

### (D4) Thresholds — defaults + per-team override

```jsonc
// team.json (additive optional block)
{
  "groom": {
    "autoPromotionThresholds": {
      "r1Hours": 24,
      "r2Hours": 12,
      "r3Hours": 6
    }
  }
}
```

Resolution order (pre-flag #6 — ADR-149 sibling pattern):

1. `team.groom.autoPromotionThresholds.<rN>Hours` — per-team override
2. `cockpit.defaultGroom.autoPromotionThresholds.<rN>Hours` — fleet default (optional)
3. Hardcoded defaults — `r1=24h`, `r2=12h`, `r3=6h`

Defaults chosen because:

- **24h for R1**: a kanban Task that's been blocked for a working day deserves operator attention. Shorter thresholds spam complaints on transient cross-lane waits.
- **12h for R2**: driver-inbox unread overnight is a real signal — operator was offline, lead didn't triage. 12h spans the operator-asleep window in MYT.
- **6h for R3**: lead-outbox replies are typically same-session — 6h covers a long Task cycle. Beyond 6h the driver probably needs a re-ask.

All three thresholds are configurable per-team and per-fleet without re-deploying atmux.

### (D5) Idempotence proof (pre-flag #2 lock-in)

Every rule's `INSERT` is **gated by a `NOT EXISTS` sub-query** on the promotion-target row's `opened_via` marker matching the rule id. The `opened_via` column convention (rule ids `auto-promotion-R1` / `auto-promotion-R2` / `auto-promotion-R3`) is the per-rule dedup ledger. Reviewer's audit-checklist row for ADR-153 T2+ impl is: **"every rule predicate carries `NOT EXISTS (... opened_via=<rule-id> ...)`"** — drift here breaks idempotence and re-promotes the same source row on every tick.

### (D6) Pre-flag synthesis (8 pre-flags folded into above)

For reviewer cross-check:

1. **`dep-not-shipped` default for R1 promotions** — §D1 R1 with `[blocker_class:X]` marker override; ✅ folded.
2. **Idempotence is load-bearing** — §D1 every rule + §D5 explicit proof; ✅ folded.
3. **R1 auto-resolve via cron, not write-hook** — §D1 R1 Auto-resolve block; ✅ folded.
4. **R2 flag stays one cycle** — §D1 R2 No auto-resolve note; ✅ folded.
5. **`blocked_at` backfill cut-over compromise** — §D2 Backfill block with acknowledged compromise; ✅ folded.
6. **Rule thresholds configurable** — §D4 with resolution order; ✅ folded.
7. **Cross-team awareness deferred** — §Out of scope explicit deferral to ADR-150 verb integration; ✅ folded.
8. **R3 dedup** — §D1 R3 NOT EXISTS predicate + closing paragraph; ✅ folded.

## Consequences

**Positive**

- Stale blockers / unread inbox / unacked outbox become **automatically visible** without requiring the operator to remember to scan. Reduces operator vigilance load.
- The unblocker role (ADR-151) gets a deterministic freshness signal alongside ADR-152's inventory signal — no LLM-judgment on "what is overdue?"; the threshold is the contract.
- `blocked_at` column adds a single timestamp; future ADRs (e.g. lane-stall measurement, dormancy classification) can reuse it without new schema work.
- `--dry-run` makes operator validation cheap; e2e gates the v1 rules against synthetic fixtures.
- Idempotence proof means re-running `atmux groom` is always safe — no risk of complaint storm from a stuck cron.

**Negative**

- Three new write-paths into existing tables (complaints / flags / inbox_messages) — each path is one more place a future schema change could break. Mitigation: `opened_via` columns make the auto-promoted rows trivially distinguishable; cleanup queries by rule id are one-liners.
- Backfill compromise (§D2) means initial R1 fires may overstate block-age. Bounded — only affects rows blocked **at migration time**; forward-looking blocks have accurate stamps.
- The R2 flag-stays-one-cycle convention (pre-flag #4) means stale-inbox flags accumulate in `flags.md` until manual resolve. Operator burden if `flags.md` is left ungroomed. Mitigation: future ADR may add an auto-archive after triage-glyph appears; deferred from v1.
- Pre-ADR-154 fallback paths (regex on markdown driver-inbox / lead-outbox) carry drift risk if the markdown format changes mid-release-window. Mitigation: post-ADR-154 the regex paths retire; until then, format-drift on these surfaces becomes a same-commit doc-update gate per CLAUDE.md.

**Reversibility**: **HIGH for v1**, lowering over time.

- Yanking ADR-153 = remove the three rules + `runGroomPass()` call + `blocked_at` column (additive, no data loss when dropped).
- Auto-promoted rows in `complaints` / `flags` / `inbox_messages` are bulk-deletable by `opened_via = 'auto-promotion-R<n>'` — one `DELETE` per rule.
- Once downstream consumers (ADR-151 unblocker) come to depend on the auto-promoted rows as their drain queue, reversal cost rises — but those consumers don't exist yet in proposed state.

## Implementation plan

This ADR's commit is doc-only. Impl is staged across T2–T6 per the standard lead-saturation carve-out (matches ADR-152 §Implementation plan staging):

1. **T2 — Schema additive migration**: `tasks.blocked_at INTEGER NULL` column + backfill UPDATE; `opened_via TEXT NULL` columns on `complaints` / `flags` / `inbox_messages` if not already present; Zod schema updates in `src/schema/kanban.ts` + `src/schema/complaints.ts` + `src/schema/flags.ts` + `src/schema/inbox.ts`. Same-commit migration test (`bun test --timeout 30000` per CLAUDE.md).
2. **T3 — Groom-verb scaffold**: `src/verbs/groom.ts` (or `src/core/groom.ts` — reviewer picks) with `runGroomPass()` + `--rules` CSV parsing + `--dry-run` flag. Wire into `src/cli.ts`. Reusable from whip cycle.
3. **T4 — R1 detector + promoter**: `src/core/groom-rules/r1-kanban-blocked-to-complaint.ts`. Pure functions; `detect(now: number, db: Db) => Match[]` + `promote(match: Match, db: Db) => void`. Same-commit unit tests with golden fixtures.
4. **T5 — R2 detector + promoter**: `src/core/groom-rules/r2-inbox-stale-to-flag.ts`. Includes the pre-ADR-154 markdown-parse fallback path; post-ADR-154 the parse-fallback path retires (T5 follow-up Task).
5. **T6 — R3 detector + promoter**: `src/core/groom-rules/r3-outbox-stale-to-heads-up.ts`. Includes the pre-ADR-154 markdown-parse fallback path.
6. **T7 — Whip integration + e2e**: hook `runGroomPass()` into `src/verbs/whip.ts::runTick()`; `tests/e2e/groom-auto-promotion.test.ts` synthetic team with one fixture per rule, walks past threshold, asserts promotions land + idempotent re-run + auto-resolve on un-block.

Reviewer-gated at each Task per the standing reviewer audit-bar.

## Out of scope

- **Cross-team R1** — promotions land in the team's local `state.db`; cross-team awareness (a complaint about Team A's blocker filed in Team B's `state.db`) reuses ADR-150's `walkAllTeamAtmuxDirs` primitive and lands post-ADR-150. Document explicitly in v1 so reviewer doesn't push cross-team into scope.
- **Rules R4+** — every future rule lands via a new ADR amending §D1 with the same shape (idempotence predicate + threshold + target). Candidates surfaced but deferred: stale-complaint → cross-team-escalate, repeated-rotation → kill-cage, push-policy-gate-aging → operator-ping.
- **Auto-resolve for R2 flag** — flag stays until manual `atmux flag resolve`. A future ADR may auto-clear after the driver-inbox row's `triage_glyph` becomes non-NULL; deferred.
- **Blockers list verb** — ADR-152 T1+ ships the inventory side; ADR-153 is the freshness side.
- **Storage migration** — ADR-154 T1+ ports markdown driver-inbox + lead-outbox to SQLite. The pre-ADR-154 markdown-parse fallback paths in R2 + R3 are the bridge.
- **Pane-state verb** — ADR-155 T1+ is the 8th-surface volatile signal; not a promotion-eligible surface (pane-state is per-tick volatile, not durable; would re-fire on every tick).
- **Unblocker role** — ADR-151 T1+ owns the drain side; ADR-153 emits aging signals, ADR-151 acts on them.
- **Execution slices T2–T7** — staged per lead saturation carve-out; this ADR is design-only.
- **Manual override at promotion time** — operator can suppress an R1 promotion by adding `[suppress_auto_promotion]` to a Task body; deferred to future ADR if real friction emerges. v1 promotes mechanically.

## Cross-references

- **[ADR-005](005-kanban-as-source-of-truth.md)** — kanban as source of truth; R1 reads `tasks.status`.
- **[ADR-007](007-kanban-design.md)** — kanban pull-model + `blocked` lifecycle state. R1 measures time-in-blocked.
- **[ADR-008](008-decisions-verb.md)** — decisions verb; the `🔵 Decisions Needed` surface that ADR-152 catalogs.
- **[ADR-010](010-atmux-flag.md)** — `atmux flag` + `.atmux/flags.md` lifecycle. R2 emits into this surface.
- **[ADR-060](060-state-sqlite-port.md)** — `.atmux/state.db` SQLite canonical store.
- **[ADR-076](076-sql-canonical-inbox.md)** — `inbox_messages` table. R3 emits into this surface.
- **[ADR-077](077-superdoctor-cockpit-role.md)** + **[ADR-133](133-medic-rename.md)** — medic + complaints substrate. R1 emits into `complaints` table.
- **[ADR-147](147-ombudsman-and-release-notes.md)** — ombudsman adjudicates the open `complaints` set, including auto-promoted ones (drains R1's output).
- **[ADR-149](149-)** (proposed) — eternal-improvement gating; sibling config-block pattern reused for `team.groom.autoPromotionThresholds`.
- **[ADR-150](150-)** (proposed) — cross-team complaints; future cross-team R1 integration depends on this.
- **[ADR-151](151-)** (proposed) — unblocker; downstream consumer of R1/R2/R3 aging signals.
- **[ADR-152](152-atmux-blockers-list-unified-verb.md)** — blockers list inventory; ADR-153 is the temporal-overlay sibling. R1 promotions surface in ADR-152's `blocker_class: "dep-not-shipped"` (default) bucket; ADR-152 lifts the class from the auto-promoted complaint's column.
- **[ADR-154](154-)** (proposed) — coordination-storage port; provides `driver_inbox` + `lead_outbox` SQLite tables that R2/R3 read in steady-state.
- **[ADR-155](155-)** (proposed) — pane-state verb; deliberately not a promotion-eligible surface (volatile).
- Complaint `c-33475fd6` — originator (driver-claude-sopx /bruh sweep 2026-05-16 00:17 MYT); this ADR's acceptance closes it.
- `[[feedback_decomp_same_session_with_deps]]` (memory) — sub-tasks T2–T7 to be filed with `deps[]` chain in the same planner-near session.
