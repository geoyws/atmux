# ADR-152: `atmux blockers list` — unified blockers verb, 7-surface fan-out, blocker_class taxonomy

**Status**: proposed
**Date**: 2026-05-16
**Author**: atmux team (docs / t-94a1c95e)
**Parent EPIC**: t-8f3061ef
**Closes complaint**: c-1d28fc72 (filed by driver-claude-sopx 2026-05-15)
**Driver-ref**: /bruh sweep 2026-05-16 00:17 MYT → operator "fix all complaints" directive → planner decomposed 00:43 MYT.
**Reviewer**: pre-flag gate before T2–T6 impl tasks dispatch.

## Numbering-shift header

The slot `ADR-152` was originally allocated to the **medic → canary rename** ADR (kanban EPIC `t-20674483`, planner memo 2026-05-14). On 2026-05-16 the operator authorized a 5-ADR fleet covering coordination-state unification (cross-team complaints, unblocker, blockers-list, storage-migration, pane-state). The fleet supersedes the medic-canary slot allocation; medic-canary moves to **next-free-after-155 (likely ADR-156)**. Any pointer in another doc, kanban Task body, or commit message that reads "ADR-152 medic-canary" must be re-pointed to ADR-156 when that ADR is drafted. This ADR holds the 152 slot.

## Context

### The seven surfaces problem

A single atmux team in flight today coordinates state across **seven distinct surfaces**, each with its own storage shape, lifecycle, and reader. None of them share a queryable index. Operators, lead, planners, and the soon-to-arrive unblocker role (ADR-151) need a "what is blocking us right now?" answer in <2 seconds — today it takes a `cat / rg / atmux task list / atmux complaints list` round across all seven:

| # | Surface | Storage | Reader today | Lifecycle |
|---|---|---|---|---|
| 1 | **Kanban** `status=blocked` | `.atmux/state.db::tasks` (SQLite, ADR-060 + ADR-076) | `atmux task list --status blocked` | Member sets via `atmux flag --task <id> --needs unblock` (per ADR-010 D3) or planner sets manually |
| 2 | **Complaints** `status=open` | `.atmux/state.db::complaints` (SQLite, post-ADR-077 §D5 schema) | `atmux complaints list --status open` | Medic / whip-velocity-gate / operator / CLI files; ombudsman (ADR-147) or operator triages |
| 3 | **Flags** | `.atmux/flags.md` (append-only markdown, per [ADR-010](010-atmux-flag.md) §D1) | `cat .atmux/flags.md` or `atmux flag list` (when available) | Member files via `atmux flag …`; lead resolves |
| 4 | **Driver-inbox** | `.atmux/driver-inbox.md` (`## Open` section + Archive, per [ADR-085](085-whip-approvals-watcher.md) §B + global CLAUDE.md) | `cat .atmux/driver-inbox.md` | `atmux tell-lead` writes; lead triages inline (✅ / 📤 / ⏳ / ❌); archives >24h |
| 5 | **Lead-outbox** | `.atmux/lead-outbox.md` (`## Open` section) | `atmux outbox [--ack]` | Member `atmux reply` writes; driver reads + acks |
| 6 | **Decisions** | `.atmux/pending-decisions.md` (🔵 *Decisions Needed* + 🟡 *Auto-mode resolutions*, per [ADR-008](008-decisions-verb.md) + [ADR-020](020-decisions-renderer-richness-gate.md)) | `atmux decisions list` | Lead files via `atmux decisions add`; operator overrides by replying |
| 7 | **Todo** | `.claude/projects/<branch>/todo.md` (per-branch todo skill state) | `/todo` skill | Per-member / per-branch task scratchpad |

### Why a unified verb (not a unified store)

The Task body's preventive ask (verbatim from c-1d28fc72) is explicit: **don't move the storage around**. Markdown surfaces stay markdown. The cost of a v1 storage migration would block ADR-151 (unblocker), ADR-153 (auto-promotion), and ADR-154 (storage port) on a single dependency chain. Instead, ADR-152 ships a **READ-ONLY aggregation layer** that joins SQLite reads with regex-based markdown parsers and emits normalized rows.

This decoupling means the verb works **before AND after** ADR-154 ports markdown surfaces to SQLite: the row shape stays stable, the parser internals swap. Downstream consumers (unblocker T-fba73bf8, auto-promotion T-cc7e9ce2) query the verb's output and never see the storage swap.

### Why now — foundation for the coordination fleet

Three concurrent ADRs (151, 153, 154) all depend on a single queryable signal source for blockers:

- **ADR-151 unblocker**: drains the blockers list each tick, applies deterministic policy.
- **ADR-153 auto-promotion**: reads `blocker_class` to decide which class of blockers gets auto-resolved vs operator-escalated.
- **ADR-154 storage port** (decision-pending → SQLite-everywhere): preserves ADR-152's row shape across the storage migration; only the parser internals churn.

Without ADR-152, each of the three would re-implement the seven-surface fan-out in its own scope — three drift-prone parsers instead of one canonical reader. This ADR is the **foundation** that admits one canonical reader per surface and lets every downstream coordination ADR query it cheaply.

## Decision

### (D1) Verb signature

```
atmux blockers list [--json] [--class <c>] [--source <s>] [--max-age <duration>]
```

- `--json` — emit JSON array (machine consumption); default is table (human consumption).
- `--class <c>` — filter to a single `blocker_class` value (closed enum, §D3).
- `--source <s>` — filter to one or more surfaces. CSV-multi-value per **§Decision-anchor pre-flag #4**: `--source kanban,complaints` returns rows from those two surfaces only. Zod CSV-splitter.
- `--max-age <duration>` — filter to rows with `age >= <duration>`. Compact form per global CLAUDE.md §Duration formatting + **§Decision-anchor pre-flag #5**: `15min`, `2h`, `6h45m`, `25h49m`. Reuses the existing duration parser; **MUST NOT** introduce a new vocabulary.

### (D2) Normalized row shape (canonical)

Every row, regardless of source surface, conforms to:

```ts
interface BlockerRow {
  id: string;                  // surface-local id (kanban: task-id; complaints: complaint-id; flags: flag-id; markdown: stable hash of "<surface>:<line-anchor>")
  source: BlockerSource;       // closed enum of 7 surfaces (kanban|complaints|flags|driver-inbox|lead-outbox|decisions|todo)
  opened_at: number;           // epoch seconds; for markdown surfaces, parsed from leading "HH:MM MYT" or "YYYY-MM-DD" anchor on the line/section
  age: string;                 // pre-formatted compact duration ("15min", "6h45m", "25h49m"); derived from now − opened_at
  summary: string;             // ≤120 chars; truncated with "…" on overflow
  blocker_class: BlockerClass; // closed enum, §D3
  suggested_action: string;    // ≤80 chars; verb-led ("rotate lead", "dispatch reviewer", "escalate to operator"); see §D5 derivation rules
  related_task_id?: string;    // kanban Task id when discoverable (parsed from text body or carried natively by sources 1/2)
}
```

**Additive forward-compat**: downstream consumers (ADR-151/153/154) may receive extra fields in future minor releases without breaking. Removals require a new ADR.

### (D3) `blocker_class` taxonomy — closed enum, 8 values (per **§Decision-anchor pre-flag #1**)

```ts
export const BLOCKER_CLASSES = [
  "decision-pending",     // 🔵 Decisions Needed entry; awaiting operator override
  "member-stuck",         // member fired flag with --needs unblock; pane wedged or context-degraded
  "cross-lane-WIP",       // Task blocked on cross-lane dependency that's in-progress elsewhere
  "tooling-broken",       // CI green-but-empty, hooks failing environmentally, binary missing
  "stale-claim",          // owner field set but no commits / no pane-state activity in window
  "dep-not-shipped",      // deps[] referenced task not yet status=done; structural wait
  "review-pending",       // Story advanced to review state; reviewer claim hasn't fired
  "push-policy-gate",     // primary-staging push refused per push-policy; needs operator authorization
] as const;
export type BlockerClass = (typeof BLOCKER_CLASSES)[number];
```

**Zod literal-union enforcement** at parser boundary — free-form `blocker_class` strings reject. Expansion requires a new ADR amending this list (pre-flag #1 lock-in). Downstream consumers (unblocker policy, auto-promotion rules) key off these 8 values; drift breaks them.

### (D4) Storage-vs-lift derivation

Two paths for `blocker_class` resolution depending on source:

**SQLite-native sources** (storage extends to carry the field):

| Surface | Column added | Default-on-read |
|---|---|---|
| `kanban` (status=blocked) | `tasks.blocker_class TEXT NULL` (additive migration — same release as T2 schema impl) | `null` → infer from `task.note` text (regex), then `member-stuck` if `note` mentions "wedged"/"stuck", else `cross-lane-WIP` if `deps[]` non-empty, else `tooling-broken` |
| `complaints` | `complaints.blocker_class TEXT NULL` (additive) | `null` → infer from `source_kind`: medic→`tooling-broken`, whip-velocity-gate→`member-stuck`, operator/cli→`decision-pending` |

**Markdown surfaces** (lift from leading emoji prefix OR explicit `[class:X]` token):

| Surface | Emoji-prefix lift (v1 canonical) | Explicit-token override |
|---|---|---|
| `pending-decisions.md` | 🔵 *Decisions Needed* line → `decision-pending` | `[class:X]` anywhere in line wins |
| `driver-inbox.md` `## Open` | ⏳ inline marker → `review-pending` · 📤 inline marker → `stale-claim` (routed-to-planner ack) | `[class:X]` wins |
| `lead-outbox.md` `## Open` | (no canonical emoji yet) | `[class:X]` required |
| `flags.md` | `🚨 [<flag-id>]` from `atmux flag --severity p0` → `tooling-broken` if `--needs unblock`; else `member-stuck` | `[class:X]` wins |
| `todo.md` | (no canonical emoji) | `[class:X]` required |

**Emoji table (v1 canonical, three mappings)**:

```
🔵  →  decision-pending      (pending-decisions §🔵 Decisions Needed heading + line-level)
⏳  →  review-pending         (driver-inbox lead inline triage marker)
📤  →  stale-claim            (driver-inbox lead inline "routed to planner" marker)
```

The v1 emoji table is **intentionally narrow** — only mappings that already have consistent prior-art convention in this codebase. The remaining 5 classes (`member-stuck`, `cross-lane-WIP`, `tooling-broken`, `dep-not-shipped`, `push-policy-gate`) rely on the **explicit `[class:X]` token** convention. A future ADR may extend the emoji table once a class accumulates enough conventional usage to land unambiguously.

**Inference fall-through** (markdown-surface only, when no emoji + no `[class:X]` token): row carries `blocker_class: "member-stuck"` as the v1 default — most generic class — with a verb-output marker `(inferred)` so the operator can see which rows are class-uncertain. This default never fires on SQLite-native sources (those carry the column directly post-T2 migration).

### (D5) `suggested_action` derivation rules

Per `blocker_class`, the verb produces a verb-led action hint:

| Class | `suggested_action` template |
|---|---|
| `decision-pending` | `atmux decisions resolve <decision-id> --pick <letter>` (when letter-menu present) OR `escalate to operator` |
| `member-stuck` | `rotate <member>` OR `clear <member>` (cite the wedge fingerprint in summary) |
| `cross-lane-WIP` | `wait on t-<dep-id>` (cite the upstream dep id) |
| `tooling-broken` | `escalate to medic` (delegates to ADR-077 §D2 detection-class chain) |
| `stale-claim` | `release claim on <task-id> + reassign to <member>` (citing lane affinity) |
| `dep-not-shipped` | `wait on t-<dep-id>` (cite the upstream dep id; same template as cross-lane-WIP but semantic distinction matters for downstream policy) |
| `review-pending` | `claim <review-task-id> --as <reviewer-member>` |
| `push-policy-gate` | `escalate to operator for authorization` (per CLAUDE.md push-policy) |

Templates are **string templates**, not policy decisions — downstream consumers (unblocker) read the template + substitute concrete values. ADR-151 §D5 should fold these templates verbatim as its policy default; deviation requires reviewer pre-flag.

### (D6) Output mode — table vs JSON

**Table mode** (default — human consumption):

```
 ID            SOURCE         AGE     CLASS              SUMMARY                                          ACTION
 t-12ab34cd    kanban         25h49m  cross-lane-WIP     ADR-091 dogfood blocked on t-7e9eed65 (todo)     wait on t-7e9eed65
 c-1d28fc72    complaints     47min   decision-pending   blockers verb missing → 7-surface manual scan    escalate to operator
 di-3f12c8d4   driver-inbox   12h     stale-claim        2026-05-15 14:03 — planner route on ADR-091     release claim on di-3f12c8d4
 [...]
```

Columns: `ID` (left, 13ch), `SOURCE` (12ch), `AGE` (8ch — compact duration per CLAUDE.md), `CLASS` (18ch), `SUMMARY` (truncated to terminal width − fixed-columns), `ACTION` (right, ≤80ch). Sort: `opened_at` ASC (oldest first — drives operator/unblocker attention to staleness).

**JSON mode** (`--json` — machine consumption): emits `BlockerRow[]` per §D2. No envelope (no `{rows: […]}`), so JSONL-style streaming is trivially possible if T2 impl needs it.

### (D7) Pre-flag synthesis (§Decision-anchor folded into above)

For reviewer cross-check:

1. **Closed enum for `blocker_class`** — §D3 Zod literal-union; ✅ folded.
2. **NO storage migration in this ADR** — §Context "Why a unified verb (not a unified store)" + §D4 footnote; ✅ folded.
3. **Markdown parsers stay regex-based** — §Implementation plan + §D4 fall-through; ✅ folded.
4. **`--source` filter is multi-value** — §D1 CSV-multi-value clause; ✅ folded.
5. **`--max-age` duration parser** — §D1 reuses CLAUDE.md compact form + existing parser; ✅ folded.
6. **Cross-team filter deferred** — §Out of scope explicit deferral to a follow-up Task post-ADR-150; ✅ folded.

## Consequences

**Positive**

- Single queryable signal for "what is blocking us right now?" — operators, lead, planners, unblocker (ADR-151), auto-promotion (ADR-153) all read the same row shape from one verb.
- Zero storage churn in v1 — markdown surfaces stay markdown, SQLite surfaces gain one additive `blocker_class` column. Reversible.
- ADR-154 storage port can replace markdown parsers with SQLite reads without changing the row shape; downstream consumers see no break.
- The closed enum (§D3) locks downstream policy semantics — drift between unblocker (ADR-151), auto-promotion (ADR-153), and human-operator triage is prevented at the type boundary.

**Negative**

- Regex-based markdown parsers carry inherent drift risk — if `driver-inbox.md` format changes, the parser breaks silently (no schema gate). Mitigation: parser-per-surface unit tests in T2 + same-commit doc-update gate per CLAUDE.md when any markdown format is renamed/repositioned.
- The 8-value taxonomy is opinionated — a real blocker that doesn't fit will be force-fit into `member-stuck` (the §D4 fall-through default). Mitigation: monitor `(inferred)`-marked rows in T7 e2e tests; if >20% of rows are inferred, expand the taxonomy via a new ADR (not by free-text widening).
- v1 single-team scope — multi-team clusters need cross-team aggregation; deferred (§Out of scope) — operator gets a one-team view per call.

**Reversibility**: **HIGH**. The verb is purely additive (no storage change, no behaviour change to existing surfaces). Yanking ADR-152 = remove the verb + the two `blocker_class` columns (additive, no data loss). Downstream consumers (ADR-151/153) that come to depend on it would also yank; current proposed-state means no downstream impl exists yet.

## Implementation plan

This ADR's commit is doc-only. Impl is staged across T2–T6 (per Task body's "Execution slices — staged per lead saturation carve-out" out-of-scope note):

1. **T2 — Schema additive migration**: `tasks.blocker_class TEXT NULL` + `complaints.blocker_class TEXT NULL`; Zod literal-union schema in `src/schema/blockers.ts`; migration test (`bun test`-gated, --timeout 30000 per CLAUDE.md).
2. **T3 — Verb scaffold**: `src/verbs/blockers.ts` with the `list` subcommand wired into `src/cli.ts`; `--json` / `--class` / `--source` / `--max-age` arg parsing; column-aware table renderer (reuses existing table helper if one exists; else single-purpose new helper).
3. **T4 — SQLite readers**: `readKanbanBlockers()` + `readComplaintsBlockers()` + the `null → infer` fall-through in §D4. Repository-pattern (e.g. `KanbanBlockersRepo`) mirroring existing `SuperdoctorAttemptsRepo` shape.
4. **T5 — Markdown parsers** (5 surfaces): one regex-based parser per markdown file (flags, driver-inbox, lead-outbox, decisions, todo). Each parser exported as a pure function: `(text: string) => BlockerRow[]`. Same-commit unit tests with golden fixtures for each surface format.
5. **T6 — Table + JSON renderer**: column widths, truncation rules, sort order. Snapshot tests against golden output for stability.
6. **T7 — e2e**: `tests/e2e/blockers-list.test.ts` — synthetic team with one row per surface, walk `atmux blockers list`, assert 7 rows + class coverage + `--source`/`--class` filter behavior.

Reviewer-gated at each Task per the standing reviewer audit-bar (§Audit checklist, brief v2).

## Out of scope

- **Storage migration** (markdown → SQLite for surfaces 3–7) — ADR-154 (proposed, separate draft). ADR-152 must work BEFORE AND AFTER ADR-154 ships; the parser layer is the swap-point.
- **Auto-promotion rules** (which `blocker_class` classes auto-resolve vs escalate) — ADR-153 (proposed). ADR-152 reports; ADR-153 acts.
- **Unblocker role** (the consumer that drains the list each tick) — ADR-151 (proposed). ADR-152 emits rows; ADR-151 owns the drain policy.
- **Pane-state structured verb** (an 8th surface bridging tmux pane content into the row shape) — ADR-155 (proposed); deliberately not folded into ADR-152's v1 7-surface set because pane-state has different residency semantics (volatile per-tick capture, not durable storage).
- **Cross-team aggregation** — v1 walks only the current team's `.atmux/` dir. Cross-team via cockpit walkAllTeamAtmuxDirs reuses ADR-150's primitive (proposed) and lands as a follow-up Task post-ADR-150 (probably `atmux blockers list --cross-team` flag). Document explicitly here so reviewer doesn't push the cross-team wiring up into v1.
- **Execution slices T2–T6** — staged per lead saturation carve-out; this ADR is design-only.
- **Mutation verbs** (`atmux blockers resolve <id>`, `atmux blockers reclassify <id> --class <c>`) — out of scope for v1; the verb is **READ-ONLY**. Mutation goes through the source-of-truth verb for each surface (`atmux task move`, `atmux complaints resolve`, `atmux flag resolve`, etc.).

## Cross-references

- **[ADR-007](007-kanban-design.md)** — kanban pull-model + Task state lifecycle including `blocked`. Surface 1 of 7.
- **[ADR-008](008-decisions-verb.md)** — decisions verb + 🔵 *Decisions Needed* heading convention. Surface 6 of 7.
- **[ADR-010](010-atmux-flag.md)** — `atmux flag` verb + `.atmux/flags.md` storage. Surface 3 of 7.
- **[ADR-020](020-decisions-renderer-richness-gate.md)** — decisions renderer + 🟡 *Auto-mode resolutions* heading convention.
- **[ADR-060](060-state-sqlite-port.md)** — `.atmux/state.db` SQLite-as-canonical. Surfaces 1 + 2 read from here.
- **[ADR-076](076-sql-canonical-inbox.md)** — inbox-in-tasks (driver-inbox is **markdown** surface; member↔lead inbox is **SQLite**); informs the surface-4-vs-internal-inbox distinction.
- **[ADR-077](077-superdoctor-cockpit-role.md)** + **[ADR-133](133-medic-rename.md)** — medic + complaints substrate. Surface 2 of 7.
- **[ADR-085](085-whip-approvals-watcher.md)** — `## Open` section convention in driver-inbox + flags untriaged-detection precedent. Surface 4 of 7.
- **[ADR-147](147-ombudsman-and-release-notes.md)** — complaints adjudicator (drains surface 2's open queue); reads ADR-152's `decision-pending` + `tooling-broken` rows on the next adjacency.
- **[ADR-150](150-)** (proposed, separate draft) — cross-team complaints; sibling adjacency, ADR-152 deferred cross-team aggregation reuses ADR-150's walkAllTeamAtmuxDirs primitive when shipped.
- **[ADR-151](151-)** (proposed, separate draft) — unblocker role; downstream consumer of ADR-152's row stream.
- **[ADR-153](153-)** (proposed, separate draft) — auto-promotion; downstream consumer of ADR-152's `blocker_class` taxonomy.
- **[ADR-154](154-)** (proposed, separate draft) — coordination-storage port; preserves ADR-152's row shape across the markdown→SQLite migration.
- **[ADR-155](155-)** (proposed, separate draft) — pane-state structured verb; named as out-of-scope §8th surface.
- Complaint `c-1d28fc72` — originator (driver-claude-sopx 2026-05-15); this ADR's acceptance closes it.
- `[[feedback_decomp_same_session_with_deps]]` (memory) — sub-tasks T2–T6 to be filed with `deps[]` chain in the same planner-near session.
