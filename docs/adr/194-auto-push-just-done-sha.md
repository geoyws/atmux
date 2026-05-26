# ADR-194: auto-push targets the just-done SHA, not branch tip — shared-worktree race mitigation

**Status**: Accepted — ratified by driver 2026-05-21 (push just-done SHA not branch tip; §OQ recommendations as-written: post-rebase capture, reuse fail-branch-resolve, no sticky --no-auto-push, `git commit --only` RECOMMENDED with 30-day observation window (flip to mandatory if any incident continues post-D1), no --force-with-lease)
**Date**: 2026-05-20
**Related**: [ADR-057](./057-stall-prevention.md) §D7 R57-T7 (auto-push origin), [ADR-091](./091-kanban-driven-auto-merge.md) (shared-worktree fan-in mode that the race depends on), [ADR-032](./032-socket-pubsub-messaging-layer.md) (cross-pane recovery channel used during incident response), [ADR-134](./134-in-team-auto-merger.md) (intra-team merger that consumes pushed history), [feedback_shared_index_commit_race_hazard](memory) (prior occurrences across e-f28c2596 + e-1e223687).

## Context

Four shared-index swap incidents in three days (e-f28c2596 ×2 on 2026-05-18, e-1e223687 ×2 on 2026-05-20) have now produced one fully-documented multi-commit scramble — see [`docs/audit/2026-05-20-shared-index-swap.md`](../audit/2026-05-20-shared-index-swap.md). The audit's empirical finding cuts past the previously-suspected staging-index swap and lands on a **second, additive race**: the post-commit `git push origin <branch>` that fires automatically on every `atmux done`.

### Empirical citations

| Site | Behavior | Evidence |
|---|---|---|
| `src/verbs/claim.ts:295–302` | Wires `runAutoPush(atmuxDir, { ... })` into the `done` transition unconditionally. Best-effort; failures audit-log but don't block the kanban move. | be-2 root-cause analysis, 2026-05-20 22:32 MYT |
| `src/core/auto-push.ts:144–275` | `runAutoPush` resolves current branch, rebases, then `git push origin <branch>` (line **245**). Pushes whatever the worktree's branch HEAD currently points at — not the SHA the just-finished Task produced. | direct read; line refs supplied by be-2 |
| `.atmux/logs/auto-push.jsonl` | Audit log. Per-attempt JSONL with `ts / branch / outcome / detail / flagId`. Outcome enum: `success / skipped-staging / skipped-disabled / abort-rebase-conflict / fail-push / fail-fetch / fail-branch-resolve`. | `src/core/auto-push.ts:60–87` |
| 2026-05-20 14:07–14:09 window | SHA `a108370` (fe-2's edge-test work landed under be-2's commit subject) is present in `origin/geoyws-epic-e-1e223687` history. **Audit log has NO entry for the push of `a108370`.** Push reached origin via some path that bypassed the instrumented `runAutoPush` — most likely a direct `git push` from a sibling pane that ran `done` in a separate cwd or a manual recovery push, OR a successful `runAutoPush` whose audit append was preempted by a process restart. | `docs/audit/2026-05-20-shared-index-swap.md` §4, audit-log diff |

### The race, made precise

Two members (call them A and B) share one worktree on one branch (`worktreeIsolation: false` per `team.json` of any epic-team that takes the ADR-091 default). Their `claude` panes run in parallel:

```
T_0  A: git add a.ts           (a.ts now staged)
T_1  A: git diff --cached --stat  → "a.ts | 12"  (verification passes)
T_2  B: git add b.ts           (b.ts joins a.ts in shared index)
T_3  A: git commit -m "task A" (HEAD = SHA_A; ships a.ts + b.ts)
T_4  A: atmux done             (runAutoPush → git push origin <branch> → SHA_A on origin)
T_5  B: detects swap, git diff --cached → empty (their staged work consumed)
```

The push at T_4 cements the swap on origin. Even if B detects the absorption at T_5 and stages a clean recovery commit, A's auto-push has already published the bad SHA. The only remaining recovery surfaces are:

- **Force-push** to rewrite history — refused by CLAUDE.md push policy + a hard "no" when ≥1 sibling has already fetched.
- **Audit-doc post-hoc reconciliation** — what the project resorted to four times in three days.
- **Direct delete + re-commit** — fragile, requires every consumer to re-fetch with `--force` semantics.

The race window between B's `git add` and A's `atmux done` is sub-second under busy chain. No human pre-commit verification recipe (per `feedback_shared_index_commit_race_hazard`'s §How-to-apply #1) catches it; even the audit recipe's mandatory `git show --stat HEAD` post-commit check only *detects* the swap — it does not prevent the publish.

### Why the existing pre-commit `git diff --cached --stat` is insufficient

The verification check + `git commit` are two separate syscalls; the kernel may schedule another pane's `git add` between them. Lead's serialized commit-chain via STOP messages (per `[lead] 21:39 MYT` outbox entry) **does** close the staging race — but only as long as every member's pane respects the GO signal, and only when commits are visible-and-acknowledged-before-push. Four incidents in three days suggest the discipline-based mitigation has empirically failed.

### What this ADR is, and is not

This ADR does **not** propose flipping `worktreeIsolation: true` by default — that's a separate structural change with its own cost profile (per-member worktree + auto-merger overhead per ADR-091's resolved-open #2), and is the lead's standing P0 escalation that warrants its own ADR.

This ADR proposes the **minimal, non-structural** mitigation: push only the SHA that the just-done Task produced, not the branch tip. Combined with `git commit --only <path>` as a worker-side commit-time defensive pattern, it closes both legs of the race **inside the existing shared-worktree mode** without requiring per-member-branch infrastructure.

## Decision

### D1 — `runAutoPush` pushes the just-done SHA, not branch tip

Change the push step at `src/core/auto-push.ts:245` from:

```ts
const pushR = await git(["push", "origin", branch]);
```

to a SHA-pinned refspec:

```ts
const headSha = await resolveHeadSha(git);  // git rev-parse HEAD; fail-branch-resolve outcome on null
if (headSha === null) { /* audit fail-branch-resolve + return */ }
const pushR = await git(["push", "origin", `${headSha}:refs/heads/${branch}`]);
```

**Semantics shift**:

- `git push origin <branch>` ships ALL local commits between the remote tip and the local branch tip — including any sibling's in-flight bad/recovery commits that landed on HEAD after the just-done commit.
- `git push origin <sha>:refs/heads/<branch>` ships exactly the history reaching the named SHA — siblings' later commits are **left local** until their own `atmux done` fires their own auto-push. The push fast-forwards `refs/heads/<branch>` on origin to `<sha>`; if a sibling has already published a later commit on the same branch, the push is rejected non-fast-forward (audit outcome `fail-push`, P3 flag) and the operator can investigate.

**Capture point**: the SHA must be captured **before** `git fetch` + `git rebase`. Rebase rewrites the commit-graph; the post-rebase HEAD SHA is a different commit. Capture at the start of the auto-push flow (between branch-resolve at line 168 and policy-check at line 182), pass through the rebase step, then use at the push step. If rebase mutates HEAD, push the rebased SHA — the just-done content is preserved under a new SHA, which is what we want to publish.

### D2 — `git commit --only <path>` as canonical worker defensive pattern

Update `templates/briefs/member.md` + `templates/briefs/lead.md` + the per-role briefs that mention commit ordering (`committer.md`, `merger.md`, `epic-lead.md`) to teach the `--only <path>` form as the canonical worker commit:

```bash
# OLD (race-prone in shared-worktree mode):
git add src/foo.ts
git diff --cached --stat  # verification beat
git commit -m "feat(foo): bar"

# NEW (race-immune at the commit-time leg):
git commit --only src/foo.ts -m "feat(foo): bar"
# Optional pre-commit verification: git diff --staged src/foo.ts
```

`git commit --only` semantics: rebuilds a fresh in-memory index from the named paths' working-tree state at the moment `commit` runs, ignoring any sibling-staged content in the shared `.git/index`. The shared index is left untouched (sibling's stage survives), and the commit ships only the named paths' content. This is the **commit-time** counterpart to D1's **push-time** mitigation; the two together close both legs of the race.

**Caveats**:

- `--only` requires every path in scope to be passed explicitly — `git commit --only` with no path errors out. For workers shipping multiple files, the brief should teach the `--only path1 path2 path3` multi-arg form.
- `--only` does NOT bypass pre-commit hooks; lint-staged + bun test on the staged paths still fire normally. Per CLAUDE.md hooks policy this is correct.
- For workers who already use `git add <path> && git commit`, the migration is mechanical. For workers who use `git add .` or `git add -A`, that pattern stays broken — call it out in the brief as anti-pattern.

### D3 — Optional `--no-auto-push` escape on `atmux done`

Add a `--no-auto-push` flag to `atmux done` (and equivalently to `atmux task done`) that audit-logs `skipped-disabled` (the existing enum value works verbatim) and skips the push for that one transition. Use case: workers who want to land a commit locally without immediately publishing — e.g. when they want to chain a follow-up amend or interactive rebase before the push.

Surface in `src/verbs/claim.ts::done` argv parser. The flag is opt-in per-call; the team-level `team.json::whip.stallPrevention.autoPushOnDone: false` default-disable still works as before (per `src/core/auto-push.ts:300` already reads this), and `--no-auto-push` is the per-call escape on a team that has auto-push enabled by default.

### D4 — Audit-log gap probe

The 2026-05-20 incident's `a108370` push has no audit-log entry. This means at least one push path bypasses `runAutoPush`. Add a `doctor` check (or fold into the existing `audit` verb) that:

- Reads the last N commits on `origin/<currentBranch>` via `git log -N --format=%H`.
- Reads the audit log via `tail -N .atmux/logs/auto-push.jsonl`.
- Asserts every commit SHA pushed has a matching audit entry with `outcome: success`.
- Flags any SHA on origin without an audit entry as a candidate manual-push or unaudited path — operator follows up.

This is detection, not prevention; but it surfaces holes in the audit-log coverage so we can find + close other unaudited push paths (manual `git push` from claude panes; recovery-script pushes; any other call site).

### D5 — Reference docs/audit/2026-05-20-shared-index-swap.md as empirical motivation

The audit doc is the empirical record. Cite it in:

- This ADR (above, §Empirical citations + table).
- ADR-091 §Open-questions amendment (audit-doc becomes the evidence for the resolved-open #2 carve-out — "shared worktree default OK for ship-velocity teams, but shared-worktree teams editing shared core files need the D1+D2 mitigations").
- `templates/briefs/lead.md` §Shared-worktree incident response — point at the audit doc as the canonical recovery template for future occurrences.

## Consequences

### What changes for which lanes

- **BE lane / core**: `src/core/auto-push.ts` gains a `resolveHeadSha` helper + the push refspec changes. ~10 LOC. Existing 9 audit-log outcomes are unchanged; the `fail-push` outcome now also covers the non-fast-forward case (where a sibling published a later commit first) — detail string distinguishes (`"non-fast-forward: remote moved between done and push"`).
- **BE lane / verbs**: `src/verbs/claim.ts::done` adds the `--no-auto-push` flag. ~5 LOC.
- **TEST lane**: paired test cases for the new SHA-pinned push refspec + the non-fast-forward outcome + `--no-auto-push` flag + the audit-log gap probe. Coverage stays at 100% on tracked paths. Existing test cases in `tests/unit/core/auto-push.test.ts` need updating to assert the refspec form, not the bare branch form.
- **FE lane / docs**: `templates/briefs/{member,lead,committer,merger,epic-lead}.md` get the `--only <path>` canonical-pattern teaching. Same-commit doc update per CLAUDE.md.
- **OPS lane**: no impact on CI / deploy / cron. The auto-push cron path is unchanged (auto-push fires on `done`, not on a cron tick).
- **No impact on intra-team auto-merger (ADR-134)** or epic-team auto-merger (ADR-091) — both consume pushed history; they're agnostic to which client pushed what. Once a SHA is on origin, the merger doesn't care how it got there.

### Performance + safety

- One extra `git rev-parse HEAD` per `atmux done` — sub-millisecond, negligible.
- Push semantic is strictly safer: the worst case is a `fail-push: non-fast-forward` instead of an aggressive blanket-publish. The retry path is for the operator to either (a) pull + retry the task, or (b) inspect the divergent SHA before deciding.
- `--only <path>` pattern in workers slows them down by ~0 ms (no extra syscalls vs `git add` + `git commit`) — the trade is "two-step" vs "one-step" cognitive load, not runtime cost.

### Rollback path

D1 is a refspec change in one file (`src/core/auto-push.ts:245`). Rollback = revert the line. Audit log shape unchanged; no migration needed.

D2 is a doc/brief teaching change — no code path. Rollback = revert the brief edit.

D3 adds a flag with default-on auto-push behavior preserved. Rollback = drop the flag from argv-parser.

D4 is a new doctor probe. Rollback = drop the probe.

### What we give up

- Workers who relied on `atmux done` to publish their entire local branch (including any in-progress sibling commits) lose that behavior. This was never the documented contract; the documented contract (ADR-057 §D7) is "publish the just-done Task's work." D1 enforces the contract more strictly than the prior implementation did.
- A worker on a stale local tip whose subsequent `done` push fails non-fast-forward will need to pull + rebase + retry — a manual loop instead of the silent fast-forward that the bare `git push origin <branch>` provided. This is a feature, not a regression: the silent fast-forward is exactly the mechanism that ships sibling bad commits.

## Open questions

### OQ1 (low): SHA capture point — pre-rebase, post-rebase, or both?

**Default**: post-rebase. Rationale: the rebase step is a normal part of the auto-push flow (per ADR-057 §D7); the worker's just-done content survives rebase as a new SHA, and that's what we want to publish. Capturing pre-rebase + pushing pre-rebase SHA would defeat the rebase (push a SHA that conflicts with origin tip).

Reversibility: medium. Could be reversed if a future ADR removes the rebase step or splits auto-push into "push as-is" vs "rebase-then-push" modes.

### OQ2 (low): Detached HEAD + rebase-mid-flight states

If `git rev-parse HEAD` runs while a rebase is in progress (e.g. a sibling started one in the shared worktree), HEAD may resolve to a non-branch SHA. Existing `fail-branch-resolve` outcome handles this; the new code path adds an explicit `fail-sha-resolve` outcome variant or reuses `fail-branch-resolve` with a different detail string.

**Default**: reuse `fail-branch-resolve` with detail `"could not resolve HEAD SHA (rebase in progress or worktree state)"`. Avoids enum churn.

Reversibility: low. Pure naming choice.

### OQ3 (medium): Should `--no-auto-push` be repeatable / sticky?

`--no-auto-push` as proposed is single-call; the next `atmux done` re-enables. Alternative: a session-sticky flag (e.g. `atmux config --no-auto-push` for the current pane) that disables until cleared. Cost: extra state surface in `.atmux/state/`; benefit: workers running a multi-commit recovery don't have to remember to type the flag each time.

**Default**: single-call only. Workers doing multi-commit recoveries can edit `team.json::whip.stallPrevention.autoPushOnDone: false` for the team-wide default-disable, then re-enable after recovery. Avoids new state surface.

Reversibility: high. Adding a sticky variant later is purely additive.

### OQ4 (high — driver may want to override): D2 → mandatory or recommended?

`git commit --only <path>` as a brief-taught canonical pattern can be **recommended** (workers MAY use it; default workflow still works) or **mandatory** (workers MUST use it; reviewer flags `git add` + `git commit` two-step in commit-comment-grep audits).

- **Recommended (default)**: low cognitive load, gradual rollout, reviewer-tolerant.
- **Mandatory**: closes the staging-race leg fully; reviewer overhead for grep-checks.

**Default**: **recommended** with a 30-day window to observe occurrence rate post-D1-ship. If incidents continue (even one) after D1 lands, flip to mandatory + reviewer auto-flag on `git add` + `git commit` two-step in shared-worktree teams.

Reversibility: high (driver mid-implementation call). Worker-brief docs change is one PR away in either direction.

### OQ5 (medium): Interaction with `--force-with-lease` push patterns

The current `auto-push.ts:245` uses plain `git push origin <branch>` (no `--force-with-lease`). D1 changes the refspec form but keeps the non-force semantics. If a future ADR introduces `--force-with-lease` for some workflow, the SHA-pinned refspec is compatible (`git push --force-with-lease origin <sha>:refs/heads/<branch>`) and adds a stronger safety check.

**Default**: keep plain push. No `--force-with-lease` introduced by this ADR. Reversibility: high.

### OQ6 (low): Audit-log gap probe scope — D4 as part of this ADR or separate Task?

D4 (the audit-log gap probe) is detection-not-prevention; it surfaces unaudited push paths but doesn't fix them. Could be:

- **Folded into this ADR**: ships in the same Epic as D1+D2+D3 — operator gets the full mitigation stack in one cycle.
- **Separate ADR / Task**: lets D1+D2+D3 ship faster; the probe lands later as a follow-up hardening.

**Default**: fold into this ADR as D4. The probe is ~30 LOC + matching tests; trivial-to-add scope, and shipping it alongside D1 means the operator can immediately see whether D1 closed the gap (audit-log coverage should hit 100% post-D1 if D1 is the only push path).

Reversibility: medium. Splitting later requires a follow-up ADR; folding now is irreversible-within-the-ADR but reversible at the impl-Task level.

All resolutions logged via `atmux decisions add` (reversibility per the table above; OQ4 → high → real-time Discord ping; others → low/medium → digest only).

## References

- [ADR-057](./057-stall-prevention.md) §D7 R57-T7 — auto-push origin + the documented contract this ADR enforces more strictly.
- [ADR-091](./091-kanban-driven-auto-merge.md) — shared-worktree epic-team fan-in default (`worktreeIsolation: false`) that creates the race surface.
- [ADR-032](./032-socket-pubsub-messaging-layer.md) — cross-pane STOP messages used in 2026-05-20 incident response.
- [ADR-134](./134-in-team-auto-merger.md) — intra-team auto-merger that consumes the pushed history; shape unaffected by this ADR.
- [`docs/audit/2026-05-20-shared-index-swap.md`](../audit/2026-05-20-shared-index-swap.md) — empirical motivation. 4 incidents documented; §SHA-to-task mapping is the canonical reverse-lookup.
- Memory entry: `feedback_shared_index_commit_race_hazard.md` — prior occurrences + the (now-empirically-insufficient) discipline-based mitigation recipe.
- `src/verbs/claim.ts:295–302` — auto-push wire-in site.
- `src/core/auto-push.ts:144–275` — `runAutoPush` body. Line **245** is the push step that D1 changes.
- `.atmux/logs/auto-push.jsonl` — audit log shape (`src/core/auto-push.ts:60–87`). D4 probe consumes this.
- be-2's 2026-05-20 22:32 MYT outbox entry — original root-cause finding; supplied the precise line refs and the audit-log-gap discovery.
