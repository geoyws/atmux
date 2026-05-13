# ADR-093: Consolidate `docs/adr-bun/` into `docs/adr/` — single tree per project

**Status**: accepted
**Date**: 2026-05-13
**Date-accepted**: 2026-05-13 — T4 landed (adr-bun/ deleted; 36 ADRs renumbered to adr/095-130; docs/adr/README.md gained §Historical-context appendix; bun README.md merged narrative + file deleted). T7 smoke (`t-f1576e0a`) verifies post-consolidation state asserts.
**Driver-ref**: `.atmux/driver-inbox.md` 2026-05-13 08:25 MYT — *"adrs can't be split to bun and etc it should be one folder"* + *"make sure members read the docs"* + *"open sourced project to have it as a norm"*.
**Parent Task**: t-0c4e6397 (docs-consolidation EPIC). **Authored under**: t-7167f272 (Seq 1/7, head of Story A linear chain).

## Context

### Two ADR trees today

atmux's `docs/` tree carries **two ADR directories**:

- **`docs/adr/`** — the canonical tree, ADR-001 through ADR-086 + the recently-shipped 087-092 team-of-teams reservation. Contains every accepted architectural decision in the atmux project lifecycle.
- **`docs/adr-bun/`** — a parallel tree introduced during the bash → bun TypeScript port. Numbered 001-032 (contiguous) + 060/062/064/068 — **36 ADR files** total, plus a `README.md` tree-index (the 37th `.md`).

The `adr-bun/` tree was created when the bun port was a parallel-track engineering effort with its own internal decisions (TypeScript runtime, module taxonomy, JSON+locking model, error-handling shape, spawn pattern, etc.) that the main project hadn't ratified yet. During the port, having a separate `adr-bun/` folder kept the main `adr/` tree clean while bun-port decisions were still in flux.

### Bun-port era is over

The bun port has shipped — every bun-era ADR is either accepted-and-implemented (the TS source IS the implementation) or superseded by subsequent decisions. The two-tree topology has lost its reason to exist and is now a **coordination cost**:

1. **Numbering ambiguity**: `ADR-005` could mean main-tree (`docs/adr/005-doctor-preflight.md`) or bun-tree (`docs/adr-bun/005-json-and-locking.md`). Code comments + cross-references in subsequent ADRs have to qualify the path (`docs/adr-bun/005-…` vs `docs/adr/005-…`) on every mention — and slip when they don't.
2. **Search overhead**: `rg -n 'ADR-NNN' docs/adr/` misses bun-tree results; reviewers + members have to remember both paths.
3. **Onboarding friction**: open-source contributors (per driver-ref "open sourced project to have it as a norm") hit the two-tree pattern and don't know which is authoritative.
4. **Docs-discipline violation**: project `/CLAUDE.md` §The ADR → docs → context chain implicitly assumes a single ADR tree per project ("ADRs are append-only: once accepted, they are not edited except for follow-up annotations. Superseding decisions get a new ADR that references the old one"). Two trees mean two append-only sequences, two numbering monotonicities, no single audit trail.

### Why now

Demo-week 2026-05-13 surfaced this as part of the broader docs-discipline embed (driver-ref same date 08:25 MYT). The open-source publication target makes the cleanup load-bearing: external contributors land in a single, canonical `docs/adr/` tree on first read.

## Decision

Consolidate `docs/adr-bun/` into `docs/adr/` via mechanical renumber (no content edits, slug preservation, git-mv to preserve history). Single-ADR-tree-per-project norm captured in project `/CLAUDE.md` going forward.

Seven Tasks in linear sequence under EPIC `t-0c4e6397` (Story A):

- **T1 (this)** — author ADR-093 with renumber map + decisions.
- **T2** — execute renumber: `git mv` all 36 adr-bun ADRs to new IDs; update intra-tree cross-refs.
- **T3** — repo-wide ref-update: external files (PRD.md / READMEs / RUNBOOK / PLAN) point to new IDs.
- **T4** — delete `docs/adr-bun/` directory; merge `docs/adr-bun/README.md` historical-context paragraph into `docs/adr/README.md`; flip ADR-093 Status → `accepted`.
- **T5–T7** — Story B + smoke test, owned by sibling Tasks.

### Renumber map

Slugs are preserved verbatim. New monotonic IDs follow `docs/adr/`'s current max (086) + reserved team-of-teams range (087-092) + this consolidation ADR at **093** + the c-alias ADR at **094** (both authored 2026-05-13 ahead of T2 execution). Renumber starts at **095**.

| Old | New | Slug |
|---|---|---|
| `adr-bun/001` | `adr/095` | `why-typescript-on-bun` |
| `adr-bun/002` | `adr/130` | ⚠️ collision-tail — see resolution below |
| `adr-bun/003` | `adr/096` | `module-taxonomy` |
| `adr-bun/004` | `adr/097` | `tmux-abstraction` |
| `adr-bun/005` | `adr/098` | `json-and-locking` |
| `adr-bun/006` | `adr/099` | `error-handling` |
| `adr-bun/007` | `adr/100` | `spawn-pattern` |
| `adr-bun/008` | `adr/101` | `discord-webhook` |
| `adr-bun/009` | `adr/102` | `test-strategy` |
| `adr-bun/010` | `adr/103` | `cli-dispatcher` |
| `adr-bun/011` | `adr/104` | `cutover-protocol` |
| `adr-bun/012` | `adr/105` | `time-and-timezone` |
| `adr-bun/013` | `adr/106` | `wip-bash-deferral` |
| `adr-bun/014` | `adr/107` | `verb-design-debt` |
| `adr-bun/015` | `adr/108` | `team-worktrees-by-default` |
| `adr-bun/016` | `adr/109` | `schema-version-deferred` |
| `adr-bun/017` | `adr/110` | `window-naming` |
| `adr-bun/018` | `adr/111` | `coordination-skills-integration` |
| `adr-bun/019` | `adr/112` | `doctor-port-scope` |
| `adr-bun/020` | `adr/113` | `writer-abstraction` |
| `adr-bun/021` | `adr/114` | `coordination-runtime-contract` |
| `adr-bun/022` | `adr/115` | `whip-port-scope` |
| `adr-bun/023` | `adr/116` | `llm-judge-cascade` |
| `adr-bun/024` | `adr/117` | `spawn-account-matching` |
| `adr-bun/025` | `adr/118` | `sendtarget-discriminated-union` |
| `adr-bun/026` | `adr/119` | `parity-matrix-iter-1-scope` |
| `adr-bun/027` | `adr/120` | `parity-channel-mask` |
| `adr-bun/028` | `adr/121` | `phase3-cron-fired-lane-scope` |
| `adr-bun/029` | `adr/122` | `phase3-state-mutating-lane-scope` |
| `adr-bun/030` | `adr/123` | `phase3-read-only-lane-scope` |
| `adr-bun/031` | `adr/124` | `phase3-lifecycle-lane-scope` |
| `adr-bun/032` | `adr/125` | `phase4a-error-class-expansion-scope` |
| `adr-bun/060` | `adr/126` | `sqlite-state-store` |
| `adr-bun/062` | `adr/127` | `lane-claim-auto-pickup` |
| `adr-bun/064` | `adr/128` | `complete-driver-role-port` |
| `adr-bun/068` | `adr/129` | `dogfood-meta-bundled` |

**Total renumbered ADRs**: 36. **Range**: 095-130 inclusive (36 unique IDs).

#### ⚠️ Collision resolution for `adr-bun/002`

`adr/094-c-alias-spawn-convention.md` was authored under t-1a574d27 (Seq 1/6 of c-alias chain) on 2026-05-13 18:30 MYT — **after** the team-of-teams 087-092 reservation but **before** T2 (the bulk git-mv) executes. With **adr/093 = this consolidation ADR** (authored 2026-05-13 21:00 MYT under t-7167f272) **and adr/094 = c-alias**, the renumber start point shifts from a naive 093 to **095**.

That alone wouldn't be a collision — but `adr-bun/002-project-layout` would have landed at 094 in a naive shift, and 094 is also taken by c-alias. The natural shift+2 places 001→095 (skipping 002) and would put 002 at the next-free slot in the tail.

**Resolution**: `adr-bun/002-project-layout` becomes **`adr/130-project-layout.md`** — one slot past the renumber map's tail (which now ends at 129 for `adr-bun/068`). This keeps the renumber range tight (095-130 inclusive, no gaps inside the band) while letting the body of the map flow linearly from 001 → 095 onwards without a re-numbering hiccup.

Updated collision row:

| Old | New | Slug |
|---|---|---|
| `adr-bun/002` | `adr/130` | `project-layout` |

Reviewer pre-flag asked for "collision-free targets ≥093 (avoiding 087-092 team-of-teams reservation)" — this resolution honours that AC, accommodating both adr/093 (this consolidation ADR) and adr/094 (c-alias) which landed ahead of T2 execution.

#### Amendment trail (self-correction, 2026-05-13)

Initial draft (commit `70a4c60`) of this ADR contained a **self-collision** in the renumber map: it specified `adr-bun/001 → adr/093` while simultaneously living at `adr/093` itself, AND `adr-bun/002 → adr/094` while c-alias already occupied adr/094. Caught by docs at T2-claim time (`t-a350cc9a`); surfaced to lead; corrected map shifts the linear range start from 093 to 095 (this section). Single-commit amendment landed before T2 execution. ADR Status was `proposed` (still editable per docs-discipline append-only-once-accepted rule); amendment is in-band, no §Superseded marker required.

### Mechanical execution rules (T2)

T2 (`t-a350cc9a`) executes the renumber per these rules:

1. **`git mv` preserves history**. Each file is `git mv docs/adr-bun/<old>-<slug>.md docs/adr/<new>-<slug>.md`. `git log --follow` walks through the rename — verified on at least one sample per T2 AC.
2. **Slug preservation verbatim**. No re-slugging, no slug normalization, no abbreviation. `adr-bun/001-why-typescript-on-bun.md` → `adr/093-why-typescript-on-bun.md`, not `adr/093-bun-port-typescript.md`. Reviewer judgment on edge cases is reserved for **header line ID updates only**, not slugs.
3. **Header line update**. Each renamed ADR's `# ADR-NNN: <title>` line updates to the new ID: `adr-bun/001`'s header `# ADR-001: Why TypeScript on Bun` becomes `# ADR-095: Why TypeScript on Bun`.
4. **Intra-tree cross-references** within the renamed files get rewritten in the same T2 commit: `ADR-005` body refs → `ADR-098` (per the corrected map), `docs/adr-bun/NNN-slug.md` paths → `docs/adr/MMM-slug.md`. Per inventory: ≥10 files carry intra-tree cross-refs (adr-bun/005, 009, 010, 011, 012, 016, 018, 019, 027, 030, 031, 032).
5. **No content edits**. The renumber is mechanical-preserve-only. Reviewer rejects any T2 commit that adjusts Decision/Consequences/Open-questions content in the renamed files.

### External ref-update (T3)

T3 (`t-7abd3e45`) updates the 30 external references identified by the docs auditor 2026-05-13 ~19:00 MYT:

| File | Ref count | Type |
|---|---|---|
| `docs/PRD.md` | 12 | prose narrative |
| `src/schema/README.md` | 7 | code-comment-style ADR refs |
| `src/verbs/README.md` | 4 | code-comment-style ADR refs |
| `PLAN.md` | 3 | narrative + ADR backlog table |
| `docs/RUNBOOK-stall-recovery.md` | 2 | ADR pointer in runbook |
| `README.md` | 2 | top-level overview |

Plus any intra-tree refs the T2 commit didn't catch (T3 runs `rg -n 'docs/adr-bun/'` repo-wide; AC requires zero stale matches).

Most-cited bun IDs externally (helps prioritize verification): 057 (×3), 016 (×3), 052, 032, 031, 030, 029, 028, 014, 005 (each ×2). The renumber map covers each; T3 verifies the substitution lands cleanly.

### `docs/adr-bun/README.md` handling (§6 per Task body)

`docs/adr-bun/README.md` is a **tree-index for the bun-port era**, not an ADR. It carries historical context about the port (phase boundaries, parity matrix, cutover protocol references) that may be useful for future readers but doesn't belong in any single ADR.

**Decision** (§6 resolution): **merge as a §Historical-context appendix** at the end of `docs/adr/README.md` in T4 (`t-5254e590`). The current `docs/adr/README.md` is a brief 13-line index — the merge appends a *short* paragraph (≤10 lines) summarizing the bun-port era + cross-references to the renumbered ADRs (`See ADR-093 (why-typescript-on-bun) and ADR-103 (cutover-protocol) for the port-era context`). Verbatim copy of `adr-bun/README.md` content is **not** required — extract the durable historical narrative, drop the now-obsolete tree-index portion.

Alternative considered and rejected: **delete `docs/adr-bun/README.md` outright with no merge**. Rejected because the bun-port-era narrative has archival value (future contributors reading `docs/adr/103-cutover-protocol.md` benefit from one paragraph of context explaining *why* a cutover ADR existed). Per CLAUDE.md "ADRs are append-only" — the README narrative is the closest thing to an Epic-level summary the bun port has; deleting it loses that.

### Phase3-lane ADRs (`adr-bun/028-031`) — renumber vs archive

Reviewer pre-flag asked whether `adr-bun/028-031` (four Phase 3 lane-scope ADRs for the bun port) should be **archived** under `docs/adr/_archive/` rather than renumbered — they document obsolete port-era work whose decisions are now superseded by the production state.

**Decision**: **renumber, not archive**. Three reasons:

1. **Git blame + `rg` preservation**. Renumbering keeps the ADR in the live tree where `git log --follow` and `rg -i 'phase3' docs/adr/` find them. An `_archive/` subdirectory would hide them from default-scope greps.
2. **No obsoletion convention exists yet**. atmux has never archived an ADR; introducing the convention solely for these four would set a precedent that future supersession ADRs would have to live with (and there are likely more supersessions to come post-team-of-teams).
3. **Append-only discipline**. Per project `/CLAUDE.md`: "ADRs are append-only: once accepted, they are not edited except for follow-up annotations. Superseding decisions get a new ADR that references the old one." Archiving violates the append-only model; renumbering preserves it.

If the Phase 3 ADRs become disruptive in the live tree (e.g. cited by a confused contributor as "the current Phase 3 plan"), a follow-up ADR can mark them `Status: superseded by ADR-NNN` per the supersession convention. That ADR doesn't exist yet; not in scope here.

### Smoke test (T7 / `t-f1576e0a`)

Post-T4, the consolidation lands a smoke check:

- `ls docs/adr-bun/` returns "no such directory" (or empty).
- `rg 'docs/adr-bun/' --glob='!docs/adr/093-*'` returns zero matches across the repo.
- Every renamed ADR's `git log --follow` walks through the rename for at least one sampled file.
- `docs/adr/README.md` carries the §Historical-context appendix.

## Adjacent class — code-comment ADR refs

Code comments in `src/` reference ADRs via `// per ADR-NNN §X` style. The 30 external refs counted by the docs auditor are **doc-side**; **src-side comment refs** are a parallel concern — the same numbers, but `// per ADR-005 §B` could mean main-tree or bun-tree.

Out of scope for T3's `docs/`-level sweep; covered by a follow-up Task scope-flagged here: **T7-adjacent — src/ comment refs**. `rg -n 'ADR-[0-9]+' src/` produces a long list; auditor should triage which are bun-tree-numbered vs main-tree-numbered before T2 lands so the substitution is complete on the same commit boundary.

(If the count is small — single-digit — fold into T3. If meaningful — ≥20 — file the separate Task.)

## Consequences

- **Single ADR tree per project** post-T4. The norm captures in project `/CLAUDE.md` going forward.
- **Numbering monotonicity restored**: `docs/adr/` is 001-128 contiguous (+ 129 for the c-alias collision resolution) after T2 lands. The 087-092 team-of-teams reservation is preserved.
- **History preserved**: `git log --follow` walks each renamed ADR; no `git blame` loss.
- **No content drift**: T2/T3 are mechanical-preserve-only; reviewer rejects content edits.
- **Onboarding load drops**: open-source contributors hit one tree, one numbering, one canonical README.
- **Cross-ADR coupling**: ADRs that cite bun-tree IDs in their bodies (the ≥10 files with intra-tree cross-refs) get rewritten in T2's same commit. No dangling refs at any commit boundary.
- **Reversibility**: each Task in the chain is independently reversible via `git revert`. The full chain's reversal is the same `git revert` run T7 → T4 → T3 → T2 → T1 in reverse order, which `git revert -m 1` handles cleanly because none of the moves are merge commits.

## Open questions

- **OQ-1**: Should the `_archive/` convention be introduced for future supersession (not in this ADR, but as a follow-up)? **Resolved default**: defer — no need today. Driver may override via `atmux decisions add` if a supersession ADR proposes archival.
- **OQ-2**: Should T2 commit one ADR-rename per commit (36 commits) or one bulk renumber commit (1 commit)? **Resolved default**: bulk single commit per docs-discipline + reviewer pre-flag (T2 AC explicitly says "single commit"). Easier rollback, cleaner audit trail; `git log --follow` works either way.
- **OQ-3**: README.md merge wording — should the §Historical-context appendix be `Status: archival` annotated or just freeform prose? **Resolved default**: freeform prose, ≤10 lines, citing the renumber map and the dates of the bun-port era. No status annotation; the README is an index, not an ADR.

## Cross-references

- `.atmux/driver-inbox.md` 2026-05-13 08:25 MYT — original driver ask.
- Project `/CLAUDE.md` §The ADR → docs → context chain — motivating single-tree-per-project norm.
- Global `~/.claude/CLAUDE.md` §Docs Discipline → §Single ADR tree per project — same norm at the global level (added 2026-05-13 in this session per the docs-discipline embed).
- [ADR-094](094-c-alias-spawn-convention.md) — the c-alias ADR that landed mid-flight; cited inline in the renumber map for the `adr-bun/002` collision resolution.
- Docs auditor finding (2026-05-13 ~19:00 MYT) — external ref inventory (30 refs in 6 files) and count correction (33 → 36 ADR files; 37 .md including README).
- **Chain Tasks** (parent t-0c4e6397, Story A linear): T1 = this ADR (`t-7167f272`); T2 = renumber execution (`t-a350cc9a`); T3 = repo-wide ref-update (`t-7abd3e45`); T4 = delete `docs/adr-bun/` + flip Status (`t-5254e590`); T5 = brief-templates docs-discipline (Story B, already shipped under `t-55a0c780`); T6 = reviewer-gate doc-update column (Story B); T7 = smoke test (`t-f1576e0a`).
