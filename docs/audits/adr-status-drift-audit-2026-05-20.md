# ADR Status-drift Audit — 2026-05-20

**EPIC**: e-e2042331 · **Story**: s-87f9c54c · **Task**: t-031b8b9a · **Auditor**: docs (🦦)

Total ADR files scanned: **162** (excluding `docs/adr/README.md`).
In-flight skipped per Task body: **7** (178 / 183 / 184 / 185 / 186 / 187 / 188; see §Methodology staleness note — same class as the T1 audit observation).
Classified: **155**.

| Bucket | Count | Action in T4 |
|---|---|---|
| `proposed` → **promote to `accepted`** (code-refs + git-log present) | **18** | T4 sweep applies Status flip |
| `proposed` → **mark deferred** (>30d stale, no refs) | **0** | (none found) |
| `proposed` (in-progress, ≤30d) | (subset of remaining proposed) | no change; re-audit in 30d |
| `accepted` → **flag for orphan investigation** (no refs found) | **23** | follow-up Story (NOT this Epic) |
| `accepted` no change | **112** | no change |
| `superseded` no change | **1** | no change |

## Promote candidates (proposed → accepted)

The 18 ADRs below have BOTH `src/` code-references AND commit-log mentions. Per the classification matrix, T4 should flip their `Status` from `proposed` to `accepted`. Each has been merged + dogfooded; the proposed marker is just bookkeeping debt.

| ADR | Days old | src refs | git-log refs | Suggested Status |
|---|---|---|---|---|
| ADR-083 (`cron-install-port-scope`) | 8 | 10 | 8 | accepted (2026-05-20, shipped + dogfooded) |
| ADR-089 (`hierarchical-cockpit`) | 7 | 7 | 23 | accepted (2026-05-20, shipped + recursive cockpit walk in production) |
| ADR-090 (`epic-team-lifecycle`) | 5 | 15 | 33 | accepted (2026-05-20, epic-team spawn/dissolve verbs shipping daily) |
| ADR-091 (`kanban-driven-auto-merge`) | 4 | 17 | 51 | accepted (2026-05-20, epic-merge cron live; 51 git-log refs) |
| ADR-092 (`cross-team-tell-lead`) | 4 | 3 | 14 | accepted (2026-05-20, cross-team tell-lead verb live) |
| ADR-137 (`merge-over-rebase`) | 6 | 2 | 22 | accepted (2026-05-20, convention in use; 22 git-log refs) |
| ADR-151 (`autonomy-policy-config`) | 4 | 2 | 10 | accepted (2026-05-20, autonomy gates wired) |
| ADR-152 (`complaint-storage-cross-team`) | 4 | 2 | 14 | accepted (2026-05-20, complaint sub-verbs shipped) |
| ADR-154 (`blockers-list-unified-verb`) | 5 | 1 | 12 | accepted (2026-05-20, blockers list verb shipped) |
| ADR-155 (`auto-promotion-rules`) | 4 | 1 | 6 | accepted (2026-05-20, auto-promotion landed) |
| ADR-157 (`reviewer-trunk-signoff`) | 4 | 7 | 13 | accepted (2026-05-20, signoff path active) |
| ADR-159 (`gitter-to-committer-rename`) | 4 | 14 | 16 | accepted (2026-05-20, rename shipped + grace shim live) |
| ADR-160 (`whip-to-poke-rename`) | 4 | 9 | 11 | accepted (2026-05-20, rename shipped) |
| ADR-161 (`member-move-swap-sort-verbs`) | 4 | 16 | 26 | accepted (2026-05-20, all three verbs in production) |
| ADR-162 (`atmux-owns-tmux-infrastructure`) | 4 | 10 | 20 | accepted (2026-05-20, socket isolation + atmux.conf live; migrate-socket verb shipped) |
| ADR-163 (`bundled-tmux-binary`) | 4 | 1 | 8 | accepted (2026-05-20, opt-in shipped; note ADR-171 forward-refs ADR-163 supersession-once-shipped) |
| ADR-164 (`sync-claude-team-json`) | 4 | 9 | 17 | accepted (2026-05-20, `atmux sync claude-team-json` verb live) |
| ADR-168 (`send-keys-log-rotation-policy`) | 3 | 3 | 10 | accepted (2026-05-20, rotation policy in production) |

## Orphan candidates (accepted with no refs found)

The 23 ADRs below carry `Status: accepted` but produce **zero** `src/` ref matches AND **zero** `git log` mentions. This is the highest-signal indicator of orphan-class ADR — either (a) the decision shipped but uses different vocabulary in code than the ADR id, (b) the decision was a non-code-implementation policy (process / convention / decision-record only), or (c) the ADR was superseded without an explicit chain entry (a D1-class miss from the T1 supersession audit).

Per the Task body, orphan-investigation is **NOT scoped to this Epic** — it should land as a separate follow-up Story. The Task body's rule: `accepted | no | no | any | **flag for orphan investigation** | follow-up Story (NOT this Epic — defer per driver scoping)`. So this audit captures the list; T4 / future Story handles each individually.

| ADR | Days old | File |
|---|---|---|
| ADR-096 | 16 | `096-module-taxonomy.md` |
| ADR-102 | 16 | `102-test-strategy.md` |
| ADR-104 | 16 | `104-cutover-protocol.md` |
| ADR-105 | 16 | `105-time-and-timezone.md` |
| ADR-106 | 16 | `106-wip-bash-deferral.md` |
| ADR-107 | 16 | `107-verb-design-debt.md` |
| ADR-109 | 15 | `109-schema-version-deferred.md` |
| ADR-111 | 15 | `111-coordination-skills-integration.md` |
| ADR-112 | 15 | `112-doctor-port-scope.md` |
| ADR-113 | 15 | `113-writer-abstraction.md` |
| ADR-114 | 15 | `114-coordination-runtime-contract.md` |
| ADR-116 | 15 | `116-llm-judge-cascade.md` |
| ADR-117 | 15 | `117-spawn-account-matching.md` |
| ADR-118 | 15 | `118-sendtarget-discriminated-union.md` |
| ADR-119 | 15 | `119-parity-matrix-iter-1-scope.md` |
| ADR-120 | 15 | `120-parity-channel-mask.md` |
| ADR-122 | 14 | `122-phase3-state-mutating-lane-scope.md` |
| ADR-123 | 14 | `123-phase3-read-only-lane-scope.md` |
| ADR-124 | 14 | `124-phase3-lifecycle-lane-scope.md` |
| ADR-125 | 14 | `125-phase4a-error-class-expansion-scope.md` |
| ADR-128 | 12 | `128-complete-driver-role-port.md` |
| ADR-129 | 12 | `129-dogfood-meta-bundled.md` |
| ADR-130 | 16 | `130-project-layout.md` |

**Observation**: 22 of 23 orphans are in the ADR-096–130 range — the bash→bun-port consolidation cluster (per [ADR-093](../adr/093-docs-consolidation-tombstone-and-renumber-map.md)). Most are likely class (b) — process / scope / phase decisions whose implementations don't grep-match the ADR id because the bun-port code paths landed under different conceptual names. The orphan-investigation Story should triage by (a/b/c) class before deciding action per ADR.

## Mark-deferred candidates (proposed >30d, no refs)

**None.** No `proposed` ADR is both >30 days old AND has zero code-refs + zero git-log refs in the current dataset. All proposed ADRs are either (i) recent (≤30d) and in-progress, or (ii) ≤30d with code-refs/log-refs (those are in the promote bucket above). The dataset shows healthy decision cadence — proposed ADRs are shipping before going stale.

## Status field anomalies (informational, NOT classified)

- **ADR-170** (`sweep-epics-verb.md`) — no `Status:` line; body suggests `proposed`. Flag separately; T4 may want to add a Status line.
- **ADR-177** (`whip-velocity-gate.md`) — no `Status:` line; body suggests `accepted` (velocity-gate is in production). Flag separately.

Both are pre-existing header-format anomalies (also flagged in T1 audit §Two ADRs with missing Status: line); fixing them is a sibling sweep, not part of this audit's classification matrix.

## Methodology

### Scan procedure

1. **Header parse** — same as T1 audit. `/tmp/adr-classify.tsv` carries `(adr_id, status, date, days_old, src_refs, git_log_refs, file)` per ADR.
2. **Code-ref count** — `rg -l 'ADR-NNN\b|adr-NNN\b' src/` per ADR; counts files matching. Excludes `docs/`, `templates/`, `tests/` — only `src/` per Task body §3.
3. **Git-log ref count** — `git log --all --oneline --grep='ADR-NNN\b|adr-NNN\b'` per ADR; counts commit lines mentioning the ID. Uses `--all` to cover both trunk + member branches.
4. **Age calc** — `(today - Date_field) / 86400` in days; ADRs with unparseable Date treated as `days_old=0`.
5. **Classification** — `awk` matrix per Task body §Classification matrix; bucket each ADR + emit the per-row decision.

Reproducibility: the awk pipeline is in the commit body for t-031b8b9a; rerun against fresh trunk to refresh.

### Methodology staleness note

The Task body's "In-flight ADRs (skip classification)" list specifies 178/183/184/185/186 as `proposed by intent until shipped`. As of 2026-05-20 trunk state, these are all LANDED — and three of the five carry `Status: accepted` (ADR-183), with two carrying legitimate `proposed` (185/186). Two additional ADRs added in today's release sweep (ADR-187 / ADR-188) are also legitimately proposed pending reviewer signoff per their respective EPIC processes.

**Treatment**: the audit skipped ALL of 178/183/184/185/186/187/188 (7 entries) per the Task body's intent — even though most are now LANDED in trunk, their proposed-or-accepted status is in-flight for follow-up reviewer signoff cycles, not for this T3 audit to promote. The follow-up Tasks tracking each (t-b51f085b for ADR-185, t-0079bf87 for ADR-188 etc.) handle the proposed→accepted flip via their own ship-cycle.

Same staleness class as observed in T1 audit + auto-memory `feedback_pull_trunk_before_labeling_untracked` (2026-05-20): the planner-side Task body filed before today's release-sweep merge sees a stale view of what's in-flight; the audit uses trunk-truthful state but honors the in-flight semantic for the listed entries.

### Field caveats

- **`src/` only** — code-refs scan excludes `docs/`, `templates/`, `tests/`. An ADR cited only in templates/briefs or test fixtures won't show src-refs. This is the Task body's specified scope; if an ADR is genuinely "implemented" via brief-only changes, the classification matrix as written treats it as orphan-class. T4 should triage per the (a/b/c) categories above when reviewing the orphan list.
- **git-log `--all`** — covers all branches incl. member branches that haven't merged. A truly orphan ADR with zero log refs has had **zero** commit subjects naming it across the entire repo history. Highly signal-positive for orphan detection.
- **`\b` word-boundary** — the regex `ADR-NNN\b` matches `ADR-091` but NOT `ADR-091-0123`. Three-digit ADRs are matched intact; the boundary protects against `ADR-09` matching all `ADR-09[0-9]` IDs.

## Recommended T4 sweep scope

The T4 task (per the EPIC e-e2042331 Story s-87f9c54c sequence) should:

1. **Promote 18 ADRs** from `proposed` → `accepted` per the table above. Each is mechanical — edit the `**Status**:` line. Same-commit, single-PR landing. ≤50 LoC total.
2. **NOT** touch the orphan list — file a separate Story for the orphan-investigation work (Task body explicitly defers this from this Epic).
3. **Optional**: fix the two Status-line anomalies (ADR-170 / ADR-177) in the same sweep if cheap.

Suggested commit subject: `docs(adr): T4 promote 18 ADRs proposed → accepted per audit 2026-05-20 (t-XXXXX)`.

## Cross-refs

- T1 audit: [`docs/audits/adr-supersession-audit-2026-05-20.md`](./adr-supersession-audit-2026-05-20.md) (sha=f362f86, supersession chain matrix).
- T2 sweep: 4 §Amendments shipped at sha=f35a78e + t-55100181 follow-up filed for ADR-017/135 mistargeting.
- Project [CLAUDE.md](../../CLAUDE.md) §Source-of-truth chain — append-only ADR rule; Status field is the canonical lifecycle marker.
- auto-memory `project_adr_collision_resolutions_2026_05_18` (older-keeps-the-number heuristic; relevant for the bash→bun-port renumber cluster that drives most orphans).
- auto-memory `feedback_pull_trunk_before_labeling_untracked` (2026-05-20) — same in-flight staleness class as flagged in §Methodology staleness note.
