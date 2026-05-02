# ADR-041: Token-savings — agents see slices, never full state files

**Status**: accepted
**Date**: 2026-05-02
**Related**: [ADR-007](./007-pull-kanban.md) (kanban schema), [ADR-013](./013-kanban-write-atomicity.md) (kanban write atomicity), [ADR-031](./031-aggressive-parallelisation-default.md) (aggressive parallelism)

## Context

Driver flagged 2026-04-30 16:07 MYT (after `8342e8b` groom shipped) that two larger token-savings plays remain unaddressed:

1. **Kanban whole-file reads.** `.atmux/kanban.json` on the atmux dogfood team is currently 1.2 MB (~300K tokens). Most agent invocations need a *slice* — only the cards relevant to a member's lane / inbox / current claim. Reading the whole file every turn is the dominant per-turn token cost on long-running teams.

   Hot paths today:
   - `atmux claim --next` — needs ready-todo cards (status=todo + deps satisfied + lane match). Server-side filter exists but agent-facing output may still leak whole-state context.
   - `atmux task list` + `atmux task show` — members tend to dump full kanban as conversational context instead of the targeted slice.
   - `atmux inbox <member>` + `atmux status` — per-member-and-current-state slices, never whole file.
   - Whip / lead context-load — re-reads `kanban.json` per tick.

2. **Prompt-cache discipline.** Whip turns rebuild context every cycle. The Anthropic prompt-cache TTL is ~5 min. State files (driver-inbox, lead-outbox, kanban) churn faster than that on active teams; the cache invalidates on every turn. Stable artifacts (CLAUDE.md, memory/, skill prompts, briefs) read FIRST stay cached even when the churning tail invalidates.

The two plays differ in shape:

- **(1) is read-path refactor inside atmux** — direct lever, low-risk, schema-stable.
- **(2) is harness-side ordering** — partly outside atmux's control (Claude Code decides what to send up). Atmux can influence: brief content ordering, what `claim --next` reply payload includes, whether `task list` output puts stable headers first.

Driver explicitly authorised auto-resolution: "No need to escalate decisions to me unless you hit something irreversible."

Three architectural shapes considered for slicing:

- **A (chosen)** — convention "agents see slices, never full state files" enforced at every kanban-reading callsite. Each `lib/*.sh` reader uses `jq` to slice (status / lane / member / story / epic) before emitting. Agent-facing output is per-purpose, not whole-state.
- **B (rejected)** — schema-level partition (separate kanban.json per Epic / per lane). Adds operational complexity (multi-file flock, cross-Epic queries become joins); schema churn for a problem solvable at read-time.
- **C (rejected)** — lazy materialised views (cached `.atmux/views/<name>.json` regenerated on kanban write). Cache invalidation surface; flock contention; benefit only manifests at extreme scale (10K+ Tasks). Premature.

Convention enforcement is the durable artifact regardless of future scaling.

## Decision

### Convention: agents see slices, never full state files

**Every `lib/*.sh` callsite that reads `.atmux/kanban.json`** (or `.atmux/decisions.md`, `.atmux/flags.md`, `.atmux/lead-outbox.md`, `.atmux/driver-inbox.md`) for **agent-facing output** uses an explicit slice — by status, lane, member, story, epic, or recency window — before emitting. Whole-file emit is reserved for `--full` flags + tooling-internal callsites (e.g. groom, doctor, audit).

Concrete rules:

1. **Default output is sliced**; full content gated behind `--full` flag.
2. **Slice criteria are explicit + greppable** in the lib source (the `jq` filter literal). No `jq '.'` in agent-facing output paths.
3. **Header-first ordering**: agent-facing output starts with stable header (counts, lane summary, ID list) before per-card body. Lets harness cache the header even when bodies churn.
4. **Per-purpose helpers**: `_atmux_kanban_ready_todo_for_lane`, `_atmux_kanban_member_inbox_slice`, `_atmux_kanban_epic_summary` — named functions over copy-pasted jq blobs. Single source of truth for each slice shape.

### Audit surface (Story 1)

Every `lib/*.sh` file that calls `jq` against `kanban.json` gets a callsite audit row:

| File | Callsite | Slice criterion | Agent-facing? | Status |
|---|---|---|---|---|
| `lib/claim.sh` | claim --next | ready-todo + deps + lane | Y | TBD |
| `lib/kanban.sh` | task list | status / lane filters | Y | TBD |
| `lib/kanban.sh` | task show <id> | by ID | Y | TBD |
| `lib/inbox.sh` | inbox <member> | by member | Y | TBD |
| `lib/status.sh` | status | per-team rollup | Y | TBD |
| `lib/whip.sh` | whip tick | stale + blocked + delta | N (whip-internal) | TBD |
| `lib/dispatch.sh` | dispatch | by ID | Y | TBD |
| `lib/super-status.sh` | fleet rollup | per-team summary | Y | TBD |
| `lib/groom.sh` | archive sweep | full-file traversal | N (admin-internal) | exempt |

Audit deliverable: each row's "Status" column flips to ✅ once the callsite emits per-purpose slice (or is documented exempt with rationale).

### Prompt-cache discipline (Story 2)

**Atmux-side levers** (in scope):
- **Brief ordering**: every member brief leads with stable preamble (role identity, channels, ADR cross-refs) before churning context (current Tasks, recent flags). Stable preamble is what gets cached; per-tick churn lands at the tail.
- **Claim --next reply payload**: include only the claimed Task's ID + subject + body + deps. Don't include full kanban state.
- **`task list` output**: emit ID/subject/status/owner only by default. Full body via `--full`. Stable per-Epic headers ordered first.
- **Whip prelude**: whip's first action is `atmux::brief_version` check — if brief unchanged, harness can re-use cached brief context. Whip body's churning section (since-last-tick delta + findings) lands LAST.

**Out-of-scope** (harness-side, document as guidance for agent authors):
- Anthropic prompt-cache TTL is harness-side; atmux can't control cache invalidation directly.
- Order of context blocks fed to claude is harness-side; atmux can only influence what each block CONTAINS.
- Cross-tick conversation persistence in `~/.claude/` is harness-side; atmux's role-discipline assumes it.

### Convention exception: `--full` flag

`--full` flag bypasses default slice + emits whole content. Reserved for:
- Operator debug (`atmux task list --full | grep ...`).
- Tooling internal (groom, doctor, audit class B detector) — typically NOT agent-facing.

Whole-file flag use in agent-facing context is a discipline regression; reviewer flags it.

## Consequences

- **`lib/claim.sh`, `lib/kanban.sh`, `lib/inbox.sh`, `lib/status.sh`, `lib/dispatch.sh`, `lib/super-status.sh`, `lib/whip.sh`** — per-callsite audit + slice-conversion (~5–15 LOC each).
- **`lib/kanban.sh`** gains `_atmux_kanban_*_slice` named helpers (~80 LOC; centralised).
- **All member briefs** (`templates/briefs/*.md`) — restructured: stable preamble first (role, channels, ADRs), churning context last. Cosmetic for cache discipline.
- **`README.md` §Conventions** — document "agents see slices, never full state files" + add `--full` flag escape-hatch note.
- **Reviewer responsibility**: flag whole-file emit in agent-facing output paths during review.
- **Test coverage**: per-callsite bats specs assert slice (jq filter is explicit + non-trivial). Negative tests assert whole-file emit fails review (lint-style assertion).
- **No schema change** — read-path refactor only. Kanban shape stays.
- **Trade-off accepted**: `--full` flag adds verb surface area. Justified by debug ergonomics; abuse caught by reviewer.

### Token math (informal)

Conservative estimate on the atmux dogfood team:
- Whole `kanban.json` read: ~300K tokens.
- Per-purpose slice (e.g. ready-todo for one lane): ~500–2K tokens.
- Savings per claim --next: ~99% of kanban-read budget.

Per-team scaling: linear in Task count for whole-file; near-constant for slices. The bigger the kanban, the bigger the win.

## Open questions (auto-mode resolved per driver greenlight)

1. **OQ D1 (low): convention enforcement — reviewer-discipline (chosen) vs lint script?** Resolved: reviewer-discipline first; lint script as follow-up if regressions surface. (low-rev — could add `tests/unit/lint_no_full_kanban_read.bats` as a follow-up.)
2. **OQ D2 (medium): brief preamble ordering — restructure all briefs at once vs incremental?** Resolved: incremental. Each brief touched in normal evolution; reviewer flags ordering on changes. Mass-restructure adds churn for marginal benefit; cache-discipline win is cumulative. (medium-rev)
3. **OQ D3 (low): `--full` flag scope — opt-in (chosen) vs default-on?** Resolved: opt-in. Agent-facing default is sliced; `--full` is operator escape hatch. (low-rev — flip if operator UX proves bad.)
4. **OQ D4 (medium): groom callsite exempt — special case (chosen) vs add `--full`?** Resolved: groom is admin-internal, not agent-facing. Whole-file traversal is correct. Document exempt status in audit row. (medium-rev — could add `--quiet` mode that emits slice for human-running operator.)
5. **OQ D5 (low): cache-discipline guidance — atmux ADR (chosen) vs separate ops doc?** Resolved: ADR. Convention crosses agent + brief + verb-output surfaces; ADR is the durable contract. Separate ops doc would fragment. (low-rev)

All resolutions logged via `atmux decisions add` per ADR-008 protocol.

## References

- [ADR-007](./007-pull-kanban.md) — kanban schema (slicing operates on this surface)
- [ADR-013](./013-kanban-write-atomicity.md) — write atomicity (read-path is the complement; ADR-041 is read-path)
- `8342e8b` — `feat(groom): periodic state hygiene for shared .atmux/ files` (groom Epic; this ADR is the follow-up)
- `t-63d70aca` — ADDENDUM 13 driver brief (verbatim under planner-claim history)
