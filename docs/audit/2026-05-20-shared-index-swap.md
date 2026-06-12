# 2026-05-20 — shared-index file-swap during ADR-027 EPIC e-1e223687

**Status:** post-incident audit, accepted (no history rewrite).
**Severity:** low — all code correct + tested + in trunk; only commit attributions scrambled.
**Author:** fe-2 (filed at lead's request as the clearest-context observer).

## TL;DR

Three near-simultaneous `git add` + `git commit` cycles by **be-2 (T3)**, **fe-1 (T4)**, and **fe-2 (T5)** on the shared epic-team worktree (`worktreeIsolation: false`) produced two commits on `origin/geoyws-epic-e-1e223687` whose subjects do not match the diff they actually ship:

| SHA | Commit subject (intent) | Actual diff (what shipped) | Author of intent | Author of diff |
|---|---|---|---|---|
| **37c156d** | ADR-027 T5 — cockpit team-viewer rename + per-member branch rename | T4 files: `src/verbs/team-rename-cockpit.ts` + `tests/unit/verbs/team-rename-cockpit.test.ts` (552 insertions) | fe-2 | fe-1 |
| **492f1fa** | ADR-027 T3 — file-state steps 1/2/5/9 | T3 files (`team-rename-fs.{ts,test.ts}`, 451 insertions) **plus** T5 files (`team-rename-tmux.{ts,test.ts}`, 730 insertions). 1181 insertions total. | be-2 | be-2 + fe-2 |

T4 (fe-1) has no commit of its own — the diff is in 37c156d. T5 (fe-2) has no commit of its own — the diff is in 492f1fa.

All three lanes (T3 / T4 / T5) ship their intended code + tests in trunk. Each new file passes `bun test` at 100% line + function coverage. `tsc --noEmit` clean. The scramble is purely on the commit-message↔diff mapping.

## Root cause

Atmux epic-team mode `worktreeIsolation: false` (per `[ADR-091](../adr/091-epic-team-fan-in.md)` + `.atmux/team.json` of this epic) shares **one** git worktree + **one** `.git/index` across every member's Claude pane. `git add` writes to the shared index; `git commit` reads from + clears it. Two parallel `add`+`commit` cycles can interleave in either direction:

- **Absorption**: A's `git add <my-files>` lands on top of B's already-staged-but-uncommitted files. A's `git commit` ships A's intended diff *plus* B's unintended files.
- **Swap**: A `git add`s file X; B `git commit`s before A's commit fires; B's commit ships A's staged X under B's message; A's next `git commit` attempts fail with "nothing to commit".

This incident is the **third manifestation** of the hazard in three days. Prior occurrences (epic e-f28c2596, 2026-05-18): one absorption (recovered pre-push), one swap (accepted post-push). Existing memory entry `feedback_shared_index_commit_race_hazard` already documents the failure modes + the pre-/post-commit verification recipe.

What's new here:

1. **Double swap across three members in one window.** Two commits each carry the wrong subject; three lanes of work end up scrambled across them.
2. **The structural file-split mitigation (one new file per lane: `team-rename-fs.ts` / `team-rename-cockpit.ts` / `team-rename-tmux.ts`) did not prevent the race.** The split was lead-approved earlier in the session specifically to dodge the *Write-tool overwrite* hazard ([`feedback_parallel_session_worktree_collision`](https://example) — different code path, same shared-tree root cause). It successfully addresses Write-overwrite. It does **not** address staging-index swap, because the shared index is still a single mutable buffer regardless of which files the diffs touch.
3. **Post-push recovery window collapsed mid-incident.** be-2 attempted `git reset --soft HEAD~1` + `git restore --staged` after detecting the absorption, but fe-2 had already pushed `492f1fa` to origin ~30s prior. fe-2 sent be-2 a STOP message to prevent the reset from cascading into a force-push to fix attribution; be-2 reset their divergent local `ccc5541` to `origin/geoyws-epic-e-1e223687` and discarded the local commit. T3 code byte-equal between the two attempts, so no work was lost.

## Recovery taken (Option C — non-destructive audit)

This document is the recovery. No history rewrite, no force-push.

- All trunk SHAs preserved (`c274453` T2 → `37c156d` "T5-msg-T4-code" → `492f1fa` "T3-msg-T3+T5-code"). `origin/geoyws-epic-e-1e223687` is the canonical state.
- Reviewer signoff for T3 / T4 / T5 should read by **diff content**, not commit subject. The mapping table above is the authoritative cross-reference.
- be-2's local divergent `ccc5541` was reset to origin (no force-push). T3 byte-equal between attempts; no work lost.
- T6 reviewer + T7 ADR-027 §Deviations section should both cite this audit by file path so future contributors auditing `git log` for ADR-027 work can trace the actual file provenance.

Rejected alternatives:

- **Option A** — accept misattribution without an audit: cheap, but leaves future-archaeologists with no trail when they grep `git log` for "T4" and find nothing.
- **Option B** — interactive rebase to split + reword the two commits: would require `git push --force` to overwrite published history. Force-pushing trunk with three contributors active in the last three commits trips the no-force-push posture in `CLAUDE.md` and risks invalidating any local fetches teammates have already done. Cost of the rewrite exceeded the cost of one audit doc.

## What worked

- **Mandatory `git diff --cached --stat` before every commit** (per `feedback_shared_index_commit_race_hazard` §How to apply #1) **detected the race**. fe-2's pre-commit diff cleanly showed `team-rename-tmux.{ts,test.ts}` only, matching intent — *at that instant*. The swap happened in the few-millisecond window between `git add` and `git commit`.
- **`git show --stat HEAD` immediately after the commit** caught the swap (552 insertions instead of the expected 730; wrong file names). Post-commit verification is load-bearing — the pre-commit check alone is insufficient.
- **"Nothing to commit" on the next attempt** was the swap symptom that surfaced the second leg of the double-scramble (fe-2's files had been consumed into be-2's commit).
- **Atmux `send` messaging cross-member resolved the recovery scramble quickly.** fe-2's STOP message to be-2 arrived before be-2 could `git push --force`. The supervisor / cron-poke layer (per [ADR-032](../adr/032-socket-pubsub-messaging-layer.md)) made the multi-pane coordination tractable.

## What didn't work

- **Per-lane file split alone is insufficient** as a shared-worktree mitigation. It prevents Write-tool overwrites of *file content* but not `git add` interleaving on the shared *index*. Future shared-worktree epic teams should pair the file-split with serialized commit ordering (T2 → T3 → T4 → T5, with each member acking the prior commit's push before staging their own).
- **Communicating intended serialization order via outbox is not enforced.** The lead correctly briefed the serialized commit chain earlier in the session, but the actual `git add` calls fired in parallel because each member's claude pane interpreted "code in parallel, signal before commit" as "stage in parallel, commit one-at-a-time" — and even one-at-a-time commits race when staging is pre-loaded.

## Recommendations

1. **Update the memory entry** `feedback_shared_index_commit_race_hazard` to flag this third occurrence + explicitly note that per-lane file splits do not prevent the staging race. *Done at incident time.*
2. **Filing as a Task: atmux-managed commit mutex for shared-worktree teams** (hardening candidate #6 in the existing memory). A flock-style advisory lock at `.atmux/state/git-index.lock` held across the `git add` + `git commit` of a single intent would serialize the staging window. Cheap to ship; opt-in via `team.json :: worktreeIsolation === false` triggers the lock. **Recommended priority: P1** given three occurrences in three days.
3. **Pre-commit hook** (hardening candidate #6, sibling): warn if the staged file list contains paths outside `$ATMUX_MEMBER`'s recent activity (heuristic; would have caught all three swaps).
4. **Reviewer T6 + ADR-027 §Deviations T7** should both link to this audit file when describing per-task provenance.

## SHA-to-task mapping (canonical)

For reviewer-grep:

| Task | Owner | Files | Located in commit |
|---|---|---|---|
| **T3** (file-state steps 1/2/5/9 — `acquireRenameLock` + `mutateTeamJsonName` + `state.txt` rewrite + lock release) | be-2 | `src/verbs/team-rename-fs.ts`, `tests/unit/verbs/team-rename-fs.test.ts` | `492f1fa` |
| **T4** (cockpit.json registry sync — step 7) | fe-1 | `src/verbs/team-rename-cockpit.ts`, `tests/unit/verbs/team-rename-cockpit.test.ts` | `37c156d` |
| **T5** (cockpit team-viewer rename — step 4 + per-member branch rename — step 8) | fe-2 | `src/verbs/team-rename-tmux.ts`, `tests/unit/verbs/team-rename-tmux.test.ts` | `492f1fa` |

## References

- Memory entry: `~/.claude-personal/projects/-root-work-src-atmux/memory/feedback_shared_index_commit_race_hazard.md` (updated with §3 covering this incident).
- ADR-091 §epic-team fan-in — `docs/adr/091-epic-team-fan-in.md` (why `worktreeIsolation: false` is the steady-state default for ship-velocity).
- ADR-032 §socket-pubsub messaging — `docs/adr/032-socket-pubsub-messaging-layer.md` (the cross-pane STOP message that prevented be-2's force-push).
- ADR-027 §Orchestration — `docs/adr/027-team-rename-verb-and-topology-invariant.md` (the parent EPIC; T7 §Deviations will cross-link here).
- Prior incidents 2026-05-18 (epic `e-f28c2596`): commits `4133af1` (absorption), `7cf5b02` + `1b6b111` (swap + follow-up).

## §4 — 4th manifestation: edge-test commits race (2026-05-20, follow-up)

Filed as a same-day extension after lead approved durable-improvement § (a) work on top of the already-shipped audit. Same root cause, narrower commit window, same recovery posture (accept; no force-push).

### What happened

After §1–§3 landed and the writes-halt was released for follow-up work, **be-2** and **fe-2** independently produced edge-case test files for their respective T3 / T5 source modules:

- **fe-2**: `tests/unit/verbs/team-rename-tmux.edge.test.ts` (467 lines, 12 cases — brings combined coverage on `team-rename-tmux.ts` to 100% line + 100% function across the original + edge test files).
- **be-2**: `tests/unit/verbs/team-rename-fs.test.ts` (103 lines of edge-test additions on top of the file shipped in `492f1fa`).

fe-2 staged via `git add tests/unit/verbs/team-rename-tmux.edge.test.ts`. Pre-commit `git diff --cached --stat` showed **both** files staged — be-2's `team-rename-fs.test.ts` modification was already in the index. fe-2 ran `git reset HEAD -- tests/unit/verbs/team-rename-fs.test.ts` to unstage be-2's work (per §point 4 absorption-recovery recipe). Post-reset `git diff --cached --name-only` confirmed only fe-2's file staged. fe-2 ran `git commit -m "test(team-rename-tmux): edge-case + rollback-path coverage for ADR-027 T5"`.

`git log --oneline -3` after the commit:

```
a108370 test(team-rename-fs): edge-case coverage for ADR-027 T3
3c66e37 docs(audit): 2026-05-20 shared-index file-swap during ADR-027 EPIC e-1e223687
492f1fa feat(team-rename): ADR-027 T3 — file-state steps 1/2/5/9
```

`git show --stat a108370` showed `tests/unit/verbs/team-rename-tmux.edge.test.ts | 467 ++++++++++++++++++++++++++` — the file is **fe-2's**, the subject is **be-2's**. Be-2's actual `team-rename-fs.test.ts` modification remained uncommitted on disk.

### Root cause (refined)

This occurrence sharpens the timing model: the race window between `git reset HEAD -- <other-files>` + `git diff --cached --name-only` (which confirmed clean state) + `git commit` is on the order of single-digit milliseconds. Be-2's parallel `git add` + `git commit` cycle landed inside that window: their `add` of `team-rename-fs.test.ts` re-staged it AFTER fe-2's reset, then their commit message landed AFTER fe-2's commit message but BEFORE fe-2's `git commit` actually closed.

The audit subject↔content mapping mechanism appears to bind the *message* in `git commit -m` order while the *staged-content* binds in `git add` order — and these two orderings interleaved in opposite directions across the two sessions for this commit.

### Recovery

Same Option C posture as §1–§3:

- fe-2 pushed `a108370` to `origin/geoyws-epic-e-1e223687` (`3c66e37..a108370`). Trunk is canonical.
- fe-2 notified be-2 via `atmux send` that `team-rename-fs.test.ts` is still uncommitted on disk and needs a follow-up `git commit` (with a corrected subject).
- fe-2 notified lead; lead approved §4 of this audit as the recovery artifact.
- be-2's pending follow-up commit will be serialized via lead GO signal (no more parallel commits in this session).

### Mapping update

Add to the canonical SHA-to-task table in §SHA-to-task mapping above:

| Task | Owner | Files | Located in commit | Subject in commit |
|---|---|---|---|---|
| **T5 edge-tests (durable-improvement §a)** | fe-2 | `tests/unit/verbs/team-rename-tmux.edge.test.ts` | `a108370` | "test(team-rename-fs): edge-case coverage for ADR-027 T3" *(subject is be-2's; content is fe-2's)* |
| **T3 edge-tests (durable-improvement §a, pending)** | be-2 | `tests/unit/verbs/team-rename-fs.test.ts` | *(not yet committed at audit-time)* | *(operator follow-up; lead GO signal)* |

### Reinforced recommendations

1. **`git reset HEAD -- <other-files>` does NOT close the race.** It clears the index for the duration of one round-trip but a parallel `add` can re-stage between the reset and the commit. The atmux-managed commit mutex proposed in §point 1 of the original recommendations is the only mechanism that fully closes this — moving the priority from P1 to **P0** in light of the 4th manifestation.
2. **No more parallel commits in the same shared worktree during the same session window.** Lead serializes via GO signals until T6 ships. The §a (durable improvements) work should have been gated on the same GO discipline; the audit + write-halt only covered the §1–§3 recovery commit itself.
3. **Single-pane GO discipline** = one member's `git add` + `git commit` + `git push` chain completes before the next member's chain begins. Cost: ~3–8s of serial wait per commit. Saves: scrambled commit attribution + audit overhead + reviewer confusion.

### Subject lookup table (additive)

| SHA | Subject claimed | Subject actual (by diff) | Owner-of-content | Owner-of-subject |
|---|---|---|---|---|
| `37c156d` | T5 (fe-2) | T4 (fe-1) | fe-1 | fe-2 |
| `492f1fa` | T3 (be-2) | T3 + T5 (be-2 + fe-2) | be-2 + fe-2 | be-2 |
| `a108370` | T3 edge-tests (be-2) | T5 edge-tests (fe-2) | fe-2 | be-2 |

Three of the four ADR-027-T-series commits since `c274453` (T2) are mis-attributed by subject. The audit doc is the canonical reverse-lookup for reviewer + T7 §Deviations.
