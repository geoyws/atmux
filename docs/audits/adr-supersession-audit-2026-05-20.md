# ADR Supersession Chain Audit — 2026-05-20

**EPIC**: e-e2042331 · **Story**: s-824d1db9 · **Task**: t-8dae73d2 · **Auditor**: docs (🦦)

Total ADR files scanned: **162** (excluding `docs/adr/README.md`).
Supersession chains found: **14** (11 ADR-to-ADR, 3 to non-ADR sources).
Drifts flagged: **6** (D1 class — superseded ADR missing §Amendment annotation).
Scoped-supersession (OK, NOT drifts): **8**.
In-flight: **0** (all ADRs referenced by the planner-side Task body are now landed in trunk — see §Methodology staleness note).
Critical drifts (D5 / D6): **0**.

## Drift matrix

| # | Chain | Superseded ADR (status) | Superseder ADR (status) | Drift flags | Fix |
|---|---|---|---|---|---|
| 1 | ADR-016 → ADR-026 | ADR-016 *(superseded by ADR-026 — default policy only)* | ADR-026 *(accepted, 2026-04-27)* | none — explicit `Status: superseded by ADR-026` + bidirectional cross-ref | ✓ clean |
| 2 | ADR-025 §Phase 2 commit gate → ADR-034 | ADR-025 *(accepted; status line: "Phase 2 commit-gate superseded by ADR-034")* | ADR-034 *(accepted)* | none — Status line carries the scoped supersession | ✓ clean |
| 3 | ADR-029 §audit-storage detail → ADR-042 | ADR-029 *(accepted; status line: "audit-storage detail superseded by ADR-042")* | ADR-042 *(accepted)* | none — Status line + ADR-042 §"Related" cite the pair | ✓ clean |
| 4 | ADR-098 → ADR-126 *(narrows JSON scope)* | ADR-098 *(no §Amendment, no Status annotation)* | ADR-126 *(accepted; declares "Supersedes / extends: ADR-098")* | **D1** | T2 sweep — append §Amendment to ADR-098 noting ADR-126 supersedes the JSON+lock model for migrated state; JSON files that stay still follow this ADR |
| 5 | ADR-057 D3a/D3c → ADR-126 | ADR-057 *(no §Amendment, no Status annotation)* | ADR-126 *(accepted; declares "Supersedes / extends: ADR-057 D3a/D3c")* | **D1** | T2 sweep — append §Amendment to ADR-057 noting D3a/D3c (lock-TTL + atomic-write) are mostly obsolete for SQLite-migrated state; the sections stand for the JSON files retained |
| 6 | ADR-086 §Forward-pointer Phase 2 → ADR-132 | ADR-086 *(no §Amendment, no Status annotation)* | ADR-132 *(accepted; declares "Supersedes (in scope): ADR-086 §Forward pointer Phase 2")* | **D1** | T2 sweep — append §Amendment to ADR-086 noting the MiniMax-as-parallel-pulse-observer forward-pointer was generalised into the Martinet pluggable observer pattern by ADR-132 |
| 7 | ADR-077 § (naming only) → ADR-133 | ADR-077 *(accepted; 5 amend-style headers visible; ADR-133 rename documented)* | ADR-133 *(accepted; declares "Supersedes (naming only): ADR-077 §title")* | none — ADR-077 carries the ADR-133 rename annotation inline | ✓ clean |
| 8 | ADR-063 §session-name → ADR-135 | ADR-063 *(no §Amendment, no Status annotation)* | ADR-135 *(accepted; declares "Supersedes (naming only): ADR-063 §session-name")* | **D1** | T2 sweep — append §Amendment to ADR-063 noting `atmux_teams` session name is superseded by ADR-135's `atmux_cockpit` convention (in-place rename shim per ADR-135 §D4) |
| 9 | ADR-017 buildWindowName format → ADR-135 | ADR-017 *(no §Amendment, no Status annotation)* | ADR-135 *(accepted; declares "Supersedes (naming only): ADR-017 buildWindowName format")* | **D1** | T2 sweep — append §Amendment to ADR-017 noting the `<emoji><member>` no-separator default-member format was superseded by ADR-135's `<emoji>_<member>` underscore-prefix (and per ADR-161 §C the canonical separator for non-default members is hyphen) |
| 10 | ADR-127 §OQ5 → ADR-176 *(in part)* | ADR-127 *(no §Amendment, no Status annotation)* | ADR-176 *(declares "Supersedes (in part): ADR-127 §OQ5 — 3-criterion auto-revert gains 4th criterion epic-children-progressing")* | **D1** | T2 sweep — append §Amendment to ADR-127 noting §OQ5's 3-criterion auto-revert algorithm gains a 4th criterion via ADR-176; original 3 stand |
| 11 | ADR-132 (nomenclature) → ADR-158 | ADR-132 *(accepted; 6 amend-style headers; ADR-158 rename documented inline + via amendment + ADR-185 amendment)* | ADR-158 *(accepted; declares supersedes nomenclature only)* | none — ADR-132 carries both the ADR-158 rename + ADR-185 amendment | ✓ clean |
| 12 | ADR-145 (gitter id) → ADR-159 *(rename)* | ADR-145 *(accepted; "## Amendments" H2 + 2026-05-17 H3 documents the ADR-159 rename)* | ADR-159 *(accepted)* | none — bidirectional cross-ref present | ✓ clean |
| 13 | ADR-134 (gitter id) → ADR-159 *(rename)* | ADR-134 *(accepted; "## Amendments" H2 + 2026-05-17 + 2026-05-19 H3 entries)* | ADR-159 *(accepted)* | none — ADR-134 also carries today's t-afcc71af test-trust §Amendment (2026-05-19) | ✓ clean |
| 14 | ADR-183 §D1 (static cockpit-roster) → ADR-185 | ADR-183 *(accepted; "## Amendments" carries the 2026-05-20 §Amendment from t-1fad1f12)* | ADR-185 *(proposed; declares "Supersedes (in scope): ADR-183 §D1")* | none — bidirectional cross-ref landed in 10181eb (this docs commit) | ✓ clean |

## Scoped supersessions (informational, NOT drifts)

The eight `✓ clean` chains above are all **scoped supersessions** — the superseder rescinds only a specific sub-section / naming surface / OQ row of the superseded ADR. The superseded ADR's other decisions remain canonical. This is the normal pattern in this repo per the append-only ADR rule (project [CLAUDE.md](../../CLAUDE.md) §Source-of-truth chain); both ends of the chain document the pair, and the superseded ADR's overall `Status` stays `accepted` rather than flipping to `superseded`.

Scoped-supersession is **NOT a drift** per the T1 spec §D2 ("scoped-supersession case like ADR-186→ADR-138; expected/OK"). The matrix flags `none` for these.

## Critical drifts (D5 / D6)

**None.** No supersession refs point at non-existent ADR IDs (D5); no circular chains found (D6). All ADR IDs in the chain matrix above resolve to a real file in `docs/adr/`.

## Non-ADR supersessions (informational, NOT in matrix)

These supersession declarations point at non-ADR sources; they don't fit the matrix shape but are catalogued here for completeness:

- **ADR-038** `Supersedes: nothing (additive)` — explicitly disclaims any prior ADR. No action.
- **ADR-145** `Supersedes (operator policy): feedback_atmux_no_gitter_worker_commits memory` — supersedes an operator-policy memory file, not an ADR. No matrix entry.
- **ADR-146** `Supersedes (proposed only): prior branch-watcher / cron-poller suggestion (never landed as ADR)` — supersedes an un-ADR'd suggestion. No matrix entry.
- **ADR-183** `Supersedes (in scope): src/verbs/sentinel.ts:360-364 implementation comment` — supersedes a code comment, not an ADR clause. No matrix entry.
- **ADR-171** forward-references `Superseded by ADR-163 annotation` once ADR-163 ships — currently NOT a drift (ADR-163 hasn't shipped); track for future audit when it does.

## §Amendment-only annotations (NOT a drift class)

71 `§Amendment` markers exist across the ADR tree. They are **NOT** supersessions — they're in-place clarifications / tighten-the-scope notes within an accepted ADR's lifetime, per the append-only convention. The matrix above only flags amendments when they double as supersession-annotation (e.g. ADR-183 §Amendment 2026-05-20 is the bidirectional cross-ref for the ADR-185 supersession chain).

## Methodology

### Scan procedure

1. **Header parse** (`/tmp/adr-headers.txt`): per ADR file, extracted `id` (from filename), `Status:` (matching both `**Status**:` and `**Status:**` formats), `Date:` (analogous).
   - 160 / 162 ADRs have a parsable Status line (2 missing: ADR-170 `sweep-epics-verb.md`, ADR-177 `whip-velocity-gate.md` — both proposed-but-no-Status-line; flagged below but NOT a supersession-class drift).
   - 159 / 162 have a parsable Date line.

2. **Supersession scan**:
   - `grep -rEn "^\*\*Supersedes" docs/adr/*.md` → 11 forward declarations.
   - `grep -rEn "[Ss]uperseded by \[?ADR-[0-9]+" docs/adr/*.md` → 3 backward declarations (excluding forward-looking-ADR-171→ADR-163-once-shipped).
   - `grep -rEn "^\*\*Status\*\*:.*[Ss]upersed" docs/adr/*.md` → 3 Status-line scoped supersessions (cross-checks the above).
   - Combined 14 ADR-to-ADR chain rows + 5 non-ADR supersession declarations.

3. **§Amendment detection**:
   - Per-ADR count via `grep -cE "§Amendment|^## Amendments|^### .*[Aa]mendment|^### .*[Rr]enamed|^### [0-9]{4}-"` — matches both the dedicated `§Amendment 2026-MM-DD` H2 form (used by ADR-077, ADR-132, ADR-183, ADR-144 etc.) AND the `## Amendments` H2 + `### YYYY-MM-DD —` H3 form (used by ADR-134, ADR-145 etc.).

4. **Drift classification** per T1 spec §D1–D6:
   - D1 (Status / annotation missing on superseded ADR): 6 hits — see matrix.
   - D2 (scoped-supersession case): 8 hits — informational, not drift.
   - D3 (superseder missing rationale): all 14 superseder ADRs carry a §Decision section + WHY narrative; 0 hits.
   - D4 (asymmetric chain): subsumed by D1 — when one end is missing, the matrix flags as D1.
   - D5 (non-existent ADR ref): 0 hits.
   - D6 (circular): 0 hits.

### Methodology staleness note — Task body's "in-flight ADRs" list is post-merge stale

The t-8dae73d2 Task body's "In-flight ADRs (do NOT count as drift)" list referenced five planner-worktree-uncommitted ADRs as of the Task's filing time: ADR-178 (test-cage-leak-reaper), ADR-183 (deploy-completeness-probe-class), ADR-184 (host-wide-epic-team-cap), ADR-185 (sentinel-epic-team-scope-extension), ADR-186 (TUI send-keys 4-step canonical).

**This list is stale as of 2026-05-20 trunk state**:

- ADR-178 `test-cage-leak-reaper.md` — **landed in trunk** (pre-today; date 2026-05-18).
- ADR-183 — in trunk as `sentinel-scope-includes-epic-teams.md` (3b92c9d, 2026-05-20 morning), NOT `deploy-completeness-probe-class.md`. The deploy-completeness ADR was filed under a different number (and remains in-flight per the planner-side renumber audit; see auto-memory `feedback_pull_trunk_before_labeling_untracked` 2026-05-20).
- ADR-184 — `host-wide-epic-team-cap-queue-and-dormancy-audit.md` **landed in trunk** (date 2026-05-18).
- ADR-185 — landed today as `sentinel-dynamic-epic-discovery.md` (10181eb, t-1fad1f12) — different content from the planner-side draft (`sentinel-epic-team-scope-extension`); the trunk-side ADR-185 is the dynamic-discovery follow-up to ADR-183 §Amendment.
- ADR-186 — landed as `wedge-clearing-mechanism.md` (9e73193, 2026-05-19); the TUI send-keys 4-step ADR was renumbered to ADR-188 (`tui-send-keys-canonical-4-step.md`, affcffc, t-9807b215) per planner's 2026-05-20 09:55 MYT collision-resolution call.

All 5 "in-flight" entries from the Task body are now resolved (4 landed; 1 renumbered). The audit's matrix reflects trunk-truthful state. The Task body's "T1 audit should record this in the matrix and NOT file a fix Task for it" carve-out for ADR-186→ADR-138 specifically is **no longer applicable** in this matrix — ADR-186 in trunk is wedge-clearing-mechanism (not TUI send-keys), and the actual TUI send-keys ADR (ADR-188) carries its own scoped-supersession of ADR-138 §Why-blanket-3x which is **clean** (covered by t-0079bf87 per the Task body; not separately auditable here pending the impl-side fix).

This staleness is the same class as the 2026-05-20 finding logged in auto-memory `feedback_pull_trunk_before_labeling_untracked`: planner-worktree branches lag the trunk view, and audits that rely on planner-side filed-time facts must pull-and-cross-check before reporting.

### Two ADRs with missing `Status:` line

- **ADR-170** (`sweep-epics-verb.md`) — no `Status:` line in the header. Body suggests `proposed`. Not a supersession-class drift; flag for a separate T2-style sweep if the header lint matters.
- **ADR-177** (`whip-velocity-gate.md`) — same. Body suggests `accepted` (per the file's body text confirming velocity-gate shipped). Flag separately.

### Reproducibility

```bash
# Re-run the scan
cd /root/work/src/atmux
for f in docs/adr/*.md; do
  [[ "$f" == *README* ]] && continue
  aid=$(basename "$f" | sed 's/^\([0-9]*\)-.*/ADR-\1/')
  st=$(grep -m1 -iE '^\*\*status' "$f" | sed -E 's/^\*\*[Ss]tatus[*:]+\s*//' | sed -E 's/\*\*//g' | head -c 60)
  dt=$(grep -m1 -iE '^\*\*date'   "$f" | sed -E 's/^\*\*[Dd]ate[*:]+\s*//'  | sed -E 's/\*\*//g' | head -c 30)
  echo "$aid|${st}|${dt}|$f"
done

# Forward declarations
grep -rEn "^\*\*Supersedes" docs/adr/*.md

# Backward declarations
grep -rEn "[Ss]uperseded by \[?ADR-[0-9]+" docs/adr/*.md

# Status-line scoped supersessions
grep -rEn "^\*\*Status\*\*:.*[Ss]upersed" docs/adr/*.md

# Per-ADR amendment count
for adr in 077 086 098 057 127 063 017 132 145 134; do
  c=$(grep -cE "§Amendment|^## Amendments|^### .*[Aa]mendment|^### .*[Rr]enamed|^### [0-9]{4}-" docs/adr/${adr}-*.md)
  echo "ADR-${adr}: ${c}"
done
```

## Recommended T2 sweep scope

The 6 D1 drifts above are mechanical: each requires appending a single §Amendment header (or `## Amendments` H2 with one H3 child) to the superseded ADR pointing at the superseder + scope clause. Estimated effort: ≤30 LoC per ADR × 6 ADRs = ≤180 LoC total, single-commit landing.

Suggested commit subject for the sweep:
`docs(adr): T2 bidirectional supersession §Amendments — close 6 D1 drifts from audit 2026-05-20 (t-XXXXX)`

Suggested commit body sketch:
- ADR-017: append §Amendment for ADR-135 supersession (default-member naming).
- ADR-057: append §Amendment for ADR-126 supersession (D3a/D3c retire for SQLite-migrated state).
- ADR-063: append §Amendment for ADR-135 supersession (session-name `atmux_teams` → `atmux_cockpit`).
- ADR-086: append §Amendment for ADR-132 supersession (Forward-pointer Phase 2 generalised).
- ADR-098: append §Amendment for ADR-126 supersession (JSON scope narrows).
- ADR-127: append §Amendment for ADR-176 supersession (§OQ5 gains 4th criterion).

Each amendment is purely additive (append-only ADR convention preserved); no §Status flips. The §Status of each remains `accepted`.

## Cross-refs

- T1 spec: t-8dae73d2 (THIS audit deliverable).
- Project [CLAUDE.md](../../CLAUDE.md) §Source-of-truth chain — append-only ADR rule.
- [ADR-093](../adr/093-docs-consolidation-tombstone-and-renumber-map.md) — precedent for an audit-style ADR-tree health check (the renumber-tombstone audit set the convention for `docs/audits/` reports).
- auto-memory `project_adr_collision_resolutions_2026_05_18` (older-keeps-the-number heuristic; relevant for the ADR-185 vs planner-draft collision documented in §Methodology staleness note).
- auto-memory `feedback_pull_trunk_before_labeling_untracked` (2026-05-20) — same staleness class as observed here.
