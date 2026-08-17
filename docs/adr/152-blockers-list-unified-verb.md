# ADR-152: `atmux blockers list` — unified verb fans across 7 surfaces with normalized rows + `blocker_class` taxonomy

**Status**: accepted (2026-05-16, ships in same commit as T1 impl per planner-deferred decomp note in t-8f3061ef body)
**Date**: 2026-05-16
**Author**: atmux team (driver complaint c-1d28fc72; impl by up-impl)
**Parent task**: t-8f3061ef
**Driver-ref**: complaint c-1d28fc72 (driver-claude-sopx /bruh sweep 2026-05-15) — *"build `atmux blockers list` unified verb that fans out across all 7 surfaces and returns normalized rows; don't move storage around — markdown stays where it is; one query joins everything"*. Filed under operator's *"fix all complaints"* directive 2026-05-16 00:17 MYT.
**Relates**: ADR-126 (kanban SQLite canonical — surface 1+2), ADR-077 §F2 (complaints box — surface 3), ADR-134 (in-team auto-merger merger_state — surface 4), ADR-008 (decisions verb — surface 5), ADR-022 (flags surface — surface 6), ADR-057 §D2 (driver-inbox.md format — surface 7), ADR-151 (unblocker — primary downstream consumer of the JSON form).

## Context

### The drain on operator memory

Today the operator (and the lead) tracks blockers across **seven separate surfaces** with no joined view:

| # | Surface | Storage |
|---|---|---|
| 1 | Blocked tasks | `state.db::tasks` where `status='blocked'` |
| 2 | Stale in-progress claims | `state.db::tasks` where `status='in-progress'` AND age past `stale_min` |
| 3 | Open complaints | `state.db::complaints` where `status='open'` |
| 4 | Stuck merger state | `state.db::merger_state` where `state IN ('conflict','reverted')` |
| 5 | Pending decisions | `.atmux/decisions.md` sections without `~~strikethrough~~` |
| 6 | Open flags | `.atmux/flags.md` flag rows without resolution rows |
| 7 | Untriaged driver-inbox entries | `.atmux/driver-inbox.md` sections with 🔵/⏳/📤 glyphs OR past stale-age without ✅/❌ |

Every promotion is **manual** — operator scrolls each surface, mentally tags each row with a class (decision-pending vs member-stuck vs tooling-broken etc.), de-duplicates against the kanban, decides on action. As the team scales (+5 members → +10 → +14) the memory load grows linearly and rotation compounds it (post-`/clear` operator/lead sees a fresh transcript with no carry-over of in-flight blocker context).

### Why a unified verb, not a per-surface tour

Two paths were considered:

- **(A) Keep per-surface verbs** (`atmux complaints list`, `atmux flags`, `atmux driver-inbox`, etc.) and ask the operator to `cat` each in turn. Status quo. No new code.
- **(B) Build `atmux blockers list` that joins reads across all 7.** New verb; consumers (unblocker, dashboard, operator triage) get one queryable signal source.

(A) loses to (B) on three axes:

1. **ADR-151 unblocker** (filed sibling-priority via /bruh sweep) explicitly needs *one* JSON query each tick to drive its decision-graph. Per-surface tours don't compose.
2. **Cross-surface dedup** — a blocked task `t-X` may *also* have an open flag `f-Y` referencing `t-X` AND a complaint `c-Z` whose `related_task_id = t-X`. (B) makes the dedup tractable (group by `related_task_id`); (A) leaves it to each consumer.
3. **Class-driven action** — without a normalized `blocker_class` field, downstream code can't branch on type (a `decision-pending` row needs a `decisions add --override` reply; a `member-stuck` row needs `atmux send <member>` + investigation). The taxonomy is a precondition for any automation, not a UX nice-to-have.

This ADR adopts (B). Storage stays where it is (markdown stays markdown; SQLite stays SQLite); the new module **only joins reads**.

## Decision

### (D1) Unified verb signature

```
atmux blockers list [--json] [--class <c>] [--source <s>] [--max-age <duration>]
```

- `--json` — emit machine-readable JSON array of `BlockerRow`. Stable shape (D2). No human-friendly headers / colors.
- `--class <c>` — filter to one `BlockerClass` (D3). Useful for unblocker tick: `--class decision-pending` to get only the queue it owns.
- `--source <s>` — filter to one `BlockerSource` (D4). Useful for surgical operator queries (`--source md-driver-inbox` to see only what's stuck in the inbox).
- `--max-age <duration>` — filter rows whose `age_sec > duration`. Suffix-form (`30m`, `2h`, `7d`) or bare seconds. Useful to suppress newly-opened-not-yet-blocking entries.

Default (no filters): every surface, every row. Operator-readable table when stdout-isatty; JSON when piped is NOT auto-detected — must pass `--json` explicitly. Avoids the "isatty heuristic confused by SSH" footgun.

### (D2) Normalized row shape — `BlockerRow`

```ts
interface BlockerRow {
  id: string;                  // surface-prefixed: "task:t-abc", "flag:f-xyz", ...
  source: BlockerSource;
  opened_at: number;           // epoch seconds; 0 = unparseable markdown timestamp
  age_sec: number;             // nowSec - opened_at, capped at 0
  summary: string;             // ≤120 chars, whitespace-squashed
  blocker_class: BlockerClass;
  suggested_action: string;    // imperative, ≤200 chars
  related_task_id?: string;
}
```

The `id` is **surface-prefixed** (not bare) so cross-surface uniqueness holds without forcing every surface to share an ID namespace. Joining consumers can split on `:` to recover the surface-local id.

`opened_at: 0` is the "unknown timestamp" sentinel — markdown surfaces whose `[HH:MM MYT]` couldn't be parsed get `0`, and `age_sec` reads as `0` in that case. Conservative: surfaces the row anyway so it doesn't get silently dropped.

### (D3) `BlockerClass` taxonomy — eight classes

Per the complaint preventive ask, verbatim:

```
decision-pending · member-stuck · cross-lane-WIP · tooling-broken
stale-claim · dep-not-shipped · review-pending · push-policy-gate
```

Class derivation per surface:

| Surface | Default class | Lift signal |
|---|---|---|
| `sqlite-tasks-blocked` | `member-stuck` | `dep-not-shipped` when any dep not done |
| `sqlite-tasks-stale` | `stale-claim` | (always) |
| `sqlite-complaints` | `tooling-broken` | `extra.blocker_class` JSON field (optional, forward-compat) |
| `sqlite-merger-state` | `tooling-broken` (conflict) | `push-policy-gate` (reverted) |
| `md-decisions` | `decision-pending` | (always) |
| `md-flags` | from `**needs**: <decision\|unblock\|context>` → `decision-pending` / `member-stuck` / `member-stuck` | |
| `md-driver-inbox` | from leading glyph (🔵/⏳/📤) | `stale-claim` for un-glyphed past stale-age |

The optional `[class:X]` token is supported on every markdown surface as an explicit override — when present it wins over the leading glyph (per `liftClassFromText` precedence). New classes land here AND on the markdown convention (lift table); reviewer blocks taxonomy additions without docs.

### (D4) `BlockerSource` enumeration — seven sources

```
sqlite-tasks-blocked · sqlite-tasks-stale · sqlite-complaints · sqlite-merger-state
md-decisions · md-flags · md-driver-inbox
```

Surfaces are listed in fan-out order (SQLite first, markdown last). Source-name plural-vs-singular follows the storage table (`tasks`, `complaints`) or filename (`flags`, `decisions`, `driver-inbox`).

Note on count: the complaint preventive-ask cited "all 7 surfaces" without strict enumeration. We chose blocked-tasks + stale-tasks as two distinct surfaces (different selectors, different default classes, different actions) rather than collapsing. Lead-outbox.md is intentionally OUT of scope (D9) — entries there are member→driver replies awaiting operator ack, surfaced by the existing `atmux outbox` verb.

### (D5) `queryAllBlockers(atmuxDir, db, opts)` — the fan-out

Single async function in `src/core/blockers.ts`. Pure aside from DB + FS reads; `nowSec` injectable for tests. Returns rows in insertion order (SQLite first per surface; markdown last) — caller filters/sorts as needed.

Per-surface helpers (`readBlockedTasks`, `readStaleInProgressTasks`, `readOpenComplaints`, `readStuckMergerState`, `readPendingDecisionsMd`, `readOpenFlagsMd`, `readDriverInboxBlockers`) are exported so the unblocker (and tests) can exercise each in isolation. Failure isolation: if one surface throws (corrupt markdown, etc.), the verb-side wrapper can choose to soft-degrade by catching per-surface; the core helpers themselves throw so test asserts can catch shape mismatches.

### (D6) Markdown parsers — regex-based; no PEG / lexer

The driver-inbox / decisions / flags markdown formats are **already consistent** (the existing per-surface verbs depend on them, e.g. `src/core/driver-inbox.ts::CURSOR_FILENAME` parsing). Regex parsers in `blockers.ts` mirror the conventions already enforced by the producing verbs — no new format invented, no PEG/lexer overhead.

If a surface's format drifts in the future, the per-surface helper's regex is the local fix point — reviewer blocks format changes that don't update both the producer (`src/verbs/decisions.ts` etc.) and the consumer (`src/core/blockers.ts`) in the same commit.

### (D7) Suggested-action shape — imperative, ≤200 chars, single-line

Every row carries a `suggested_action` field. Convention: one imperative sentence the unblocker (or operator) can act on directly. Backtick-quoted CLI commands inline. Examples:

- `Land or remove deps: t-dep-1, t-dep-2 (then \`atmux task move t-X todo\`)`
- `Member alice stale on t-Y for 30h — \`atmux handoff alice <fresh-member>\` or \`atmux rotate alice\``
- `Triage + resolve: \`atmux complaints resolve c-Z --status resolved --note "<resolution>"\``

Truncated to 200 chars to keep table rendering manageable. The unblocker may ignore the field and compute its own action; the field is a **hint** for low-cognitive-load triage, not a contract.

### (D8) CHANGELOG + ADR same-commit per docs-discipline

This commit ships:

1. New ADR file (`docs/adr/152-blockers-list-unified-verb.md`).
2. New core module (`src/core/blockers.ts`) + new verb (`src/verbs/blockers.ts`) + CLI dispatch wire-in (`src/cli.ts`).
3. Unit tests covering all 7 surface helpers + integration test for `queryAllBlockers`.
4. CHANGELOG entry under [Unreleased] § Shipped (newest-on-top).

Same-commit doc per `/CLAUDE.md §Docs Discipline` — the verb is a documented surface, the taxonomy + row shape are documented surfaces, the markdown class-lifting convention is a documented surface. All three land here.

### (D9) Out of scope (explicit)

- **Storage migration** — markdown stays markdown; SQLite stays SQLite. No background sync. The verb only joins reads.
- **lead-outbox.md as a blocker source** — entries there are member→driver replies awaiting operator ack, surfaced by the existing `atmux outbox` verb. Adding it would double-surface. Future ADR if a use case emerges.
- **Cross-team blockers fan-out** — single-team scope (this team's `state.db` + this team's `.atmux/*.md`). Cross-team aggregation belongs in cockpit-tier code, not in the per-team verb.
- **Auto-promotion** (e.g. driver-inbox entry → flag at 12h age) — separate ADR-153 territory; this verb is read-only.
- **Action execution** — the verb only *suggests* actions. Performing them is the unblocker's job (ADR-151) or operator-driven.
- **`atmux blockers add / resolve`** — there's no per-surface mutation verb here; resolutions go through the existing per-surface verbs (`atmux complaints resolve`, `atmux flags resolve`, `atmux task move`, etc.).

## Decision-anchor pre-flags (planner / reviewer)

1. **Markdown class-lifting precedence** — explicit `[class:X]` token > leading-glyph table > per-surface default. T1 impl asserts the order in `liftClassFromText`. Reviewer pre-flag every new lift entry: verify the glyph isn't already overloaded by an existing surface (the `EMOJI_CLASS_TABLE` is the single source of truth).

2. **Surface-prefix `id` contract** — every surface's helper MUST emit `id` as `<prefix>:<surface-local-id>` so cross-surface uniqueness holds. Adding a new surface = adding a new prefix + extending the integration test's `ids.size === rows.length` assert.

3. **`opened_at: 0` sentinel for unparseable markdown** — markdown surfaces parse `[HH:MM MYT]` against the *current MYT day*, since the markdown convention strips the date. Across-day-boundary entries (entry from yesterday whose HH:MM < now's HH:MM) will compute the wrong age. Acceptable for v1; date-aware parsing lands as a follow-up ADR if drift surfaces.

4. **No isatty auto-detection for `--json`** — operator must pass `--json` explicitly. Avoids the SSH/CI footgun where stdout-piping confuses heuristic-driven format selection.

5. **Per-surface helper failure mode** — helpers throw on shape mismatch (caller decides whether to swallow). Verb-level `blockers list` does NOT swallow — a corrupt surface produces a hard failure with a clear stack so the operator notices and fixes the source. Soft-degrade-per-surface lands as a follow-up if log-noise becomes a problem.

## Acceptance gates

- [x] ADR-152 lands at `docs/adr/152-blockers-list-unified-verb.md` with Status: proposed
- [x] `src/core/blockers.ts` exports `BlockerRow`, `BlockerClass`, `BlockerSource`, per-surface helpers, `queryAllBlockers`
- [x] `src/verbs/blockers.ts` exports `blockers(argv, dirOpts)` + parses `--json --class --source --max-age`
- [x] `src/cli.ts` dispatches `case "blockers"` to the verb
- [x] `tests/unit/core/blockers.test.ts` covers all 7 surface helpers + integration test for `queryAllBlockers`
- [x] CHANGELOG [Unreleased] § Shipped entry (newest-on-top)
- [ ] Reviewer pre-flag pass — taxonomy completeness + markdown class-lifting precedence (D-anchors #1-5)
- [ ] e2e: `atmux blockers list --json` against a synthetic team with all 7 surfaces seeded — emits expected row count + classes (deferred to ADR-152 T2 or rolled into ADR-151 unblocker e2e per /bruh sweep stagger)

## Cross-refs

- [ADR-126](126-sqlite-state-store.md) — kanban SQLite canonical (surface 1+2 substrate).
- [ADR-077](077-superdoctor-cockpit-role.md) §F2 — complaints box schema (surface 3).
- [ADR-134](134-in-team-auto-merger.md) — merger_state table (surface 4); revert vs conflict semantics drive the class derivation.
- [ADR-008](008-decisions-verb.md) — decisions verb format (surface 5).
- [ADR-057](057-driver-inbox-delta-only-read.md) §D2 — driver-inbox.md format (surface 7); existing parser at `src/core/driver-inbox.ts` is the spec for our regex.
- ADR-151 (unblocker) — primary downstream consumer of the JSON form.
- [ADR-148](148-commit-cadence-truth-signal.md) — sibling "single canonical truth signal" pattern; `blockers list` is to "what's blocked" what cadence is to "what's working".
- Complaint c-1d28fc72 — original surface-of-the-need.


## §Amendment 2026-05-20 — promoted to accepted (status-drift audit T4)

Promoted from `proposed` → `accepted` per [docs/audits/adr-status-drift-audit-2026-05-20.md](../audits/adr-status-drift-audit-2026-05-20.md) (sha=a6f1541). Code-refs + git-log refs both present at audit time confirming shipped + dogfooded status; the `proposed` marker was bookkeeping debt. Original Date preserved verbatim. Append-only — see Status field for the canonical flip; this §Amendment carries the audit traceability.

**Filed via** t-45b401c3 (T4 sweep, 2026-05-20).

## §Amendment 2026-08-14 — `--team-dir <dir>` flag (ADR-272 P3)

`atmux blockers list` gains `--team-dir <dir>` — the sibling-verb project-root override (`ResolveDirOpts.teamDir`, same pattern as `status` / `health` / `cost`). Additive; every existing invocation is unchanged. The explicit flag wins over caller-provided `dirOpts`. Motivation: the [ADR-272](272-voice-operator-interface.md) D2 voice tool bridge invokes every verb with an explicit `--team-dir` (no cwd context inside the voice server), and `blockers` was the one catalog verb missing the flag.
