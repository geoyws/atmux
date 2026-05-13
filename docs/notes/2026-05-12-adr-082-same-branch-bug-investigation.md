# ADR-082 same-branch bug — investigation report

**Date**: 2026-05-12
**Reporter**: parity-read-impl (driver P0 ASK)
**Tracking**: t-eee0a7f6 (P100, lane=ops)
**Status**: root cause confirmed; fix proposal below

## Reproduction (exact error)

```
$ git worktree add /tmp/atmux-test-wt-bug-repro geoyws
Preparing worktree (checking out 'geoyws')
fatal: 'geoyws' is already used by worktree at '/root/work/src/atmux'
[exit 128]
```

This is the exact failure `atmux start` hits: every member tries to add a worktree on the team's current branch (`geoyws`), but git refuses to attach the same branch to two worktrees. This is a structural git safety property — only one worktree may "own" a ref-attached branch's HEAD.

## Root cause

**Contradiction inside ADR-082 itself.**

`docs/adr/082-worktree-isolation-per-member.md` §"Decision (1)" pseudocode included BOTH options:

```bash
git -C <repo> worktree add --detach "$wt_path" HEAD
# OR with branch: git -C <repo> worktree add "$wt_path" "$current_branch"
```

But the prose immediately below picked the wrong one:

> "Each worktree is created with `git worktree add <path> <current-branch>`, so members A and B both point at e.g. `geoyws`. Concurrent commits to the same branch behave exactly like two developers on two machines"

The "two developers on two machines" mental model breaks down at the `worktree add` boundary: two devs on two machines have two `.git/refs/heads/geoyws`, one each. Two worktrees of one repo share `.git/refs/heads/geoyws` — git refuses to let two heads point at one ref.

The implementation (`src/abstractions/worktree.ts:136`) followed the prose, not the pseudocode:

```ts
const result = await git(["-C", repoPath, "worktree", "add", worktreePath, branch]);
```

This shipped in commit `367e028` (W1) + `26cbcda` (W3) and only surfaces when `worktreeIsolation: true` (which atmux-team's `team.json` has). Demo-path teams without isolation are unaffected.

## Confirmed working alternative

```
$ git worktree add --detach /tmp/atmux-test-wt-bug-detach geoyws
Preparing worktree (detached HEAD 05b9877)
HEAD is now at 05b9877 docs(adr-082): bundle history — 99e4879 carried SPEC-063 alongside W1
[exit 0]

$ cd /tmp/atmux-test-wt-bug-detach && git status -sb
## HEAD (no branch)
```

`--detach` starts the worktree at the same commit as `<branch>` but in detached HEAD state. No ref-attachment, no contention.

## Fix candidates

### A. Detached HEAD per worktree — RECOMMENDED MVP

```ts
const result = await git(["-C", repoPath, "worktree", "add", "--detach", worktreePath, branch]);
```

**Pros**:
- Matches ADR-082 §1's pseudocode option (the `--detach HEAD` line that didn't make it into the prose).
- Smallest possible diff: one flag added.
- Members start at the same commit as the team's current branch (preserves the "shared starting state" promise).
- Aligned with the gitter-pattern: members `git add` in their isolated worktree (per-worktree `.git/index`), gitter commits centrally. Members never push from their own worktree, so the lack of a branch ref in the member worktree is invisible to the workflow.
- ADR-082's stated MVP win — "stash-collisions can no longer eat untracked files" — survives intact: detached worktrees still have isolated working trees and indexes.

**Cons / gaps**:
- Members on detached HEAD have empty `git branch --show-current`. If any teammate-side automation reads that to derive a branch name, it will break — needs audit (see "Test + impl impact" below).
- Auto-done / auto-push paths may need updates if they assume an attached branch in the member's cwd. Likely a follow-up Task.
- `findWorktreeBranch` already returns `""` for detached worktrees; current `provisionWorktree` idempotence check would mis-classify a successfully-provisioned detached worktree as "wrong branch" on the second `atmux start`. The idempotence check needs to flip: detached worktree at the expected path → reuse.

### B. Branch-per-member — DEFERRED (per ADR-082's own out-of-scope note)

ADR-082 §"Out of scope" explicitly defers this:
> "Branch-per-member feature branches — would convert 'shared-branch with push-conflicts' to 'merge-train with PR fan-in.' Larger lift; demo-week unaffordable; defer."

Reviving B for the demo-week MVP would re-open the deferred design — branch naming, cleanup-on-stop, push semantics, merge-back automation. Not a P0 fit.

### C. Mixed — original branch on main worktree, detached for the rest

Asymmetric, awkward to document; rejected.

## Recommendation

**Pick A — `--detach` MVP.** Smallest diff, fastest unblock, doesn't reopen the deferred B design. Documents the "members can't push from their worktree" implication as a known limitation; gitter pattern already absorbs it.

If A surfaces follow-on issues during demo prep (auto-push collisions, member tooling that needs a branch ref), B is the structural follow-up — file as a separate ADR addendum.

## Concrete code changes (sketch)

### 1. `src/abstractions/worktree.ts`

```ts
// Change line 136:
const result = await git(["-C", repoPath, "worktree", "add", "--detach", worktreePath, branch]);

// Change idempotence check (lines 124-135):
//   - If worktree exists and is detached → reuse (return {created: false, path}).
//   - If worktree exists and is on a NAMED branch → throw ConfigError (broken-state from
//     the pre-fix shipped code; operator must `git worktree remove` to retry).
const existing = await findWorktreeBranch(repoPath, worktreePath, git);
if (existing !== null) {
  // Per ADR-082 addendum 2026-05-12: post-fix worktrees are detached.
  // existing === "" means detached → idempotent reuse.
  // existing !== "" means an attached-branch worktree exists, which only
  // happens if the operator hand-attached or this was provisioned by
  // pre-fix code that never actually shipped a working state — refuse.
  if (existing === "") return { created: false, path: worktreePath };
  throw new ConfigError({
    what:
      `provisionWorktree: ${worktreePath} exists on attached branch '${existing}', ` +
      `expected detached HEAD per ADR-082`,
    hint: "remove with `git worktree remove <path>` and re-run `atmux start` to re-provision detached",
  });
}
```

Doc comments + the `branch === existing` reuse path also need updating.

### 2. `tests/unit/abstractions/worktree.test.ts`

- Update "fires `git worktree add`" argv assertion to include `--detach` (line 136-143).
- Update "worktree present on correct branch → idempotent no-op" — the test premise no longer applies (post-fix worktrees are detached, not on `geoyws`); rewrite as "worktree present on detached HEAD → idempotent no-op".
- Update "wrong branch" test — semantics flip: an attached-branch worktree at the expected path is now the broken state.
- "porcelain list with multiple worktrees finds the matching one by path" — the matching one will be detached too; update fixture.

### 3. `tests/unit/verbs/start.test.ts`

- "happy path" assertion `for (const c of addCalls) { expect(c).toContain("geoyws"); }` (line 805-807) still holds (`geoyws` is still in argv as the starting commit). Add an extra assertion that each `add` call also contains `--detach`.

### 4. `docs/adr/082-worktree-isolation-per-member.md`

Append an addendum:

```markdown
## Addendum 2026-05-12 — same-branch git refusal + pivot to --detach

**Bug**: §"Decision (1)" prose chose `git worktree add <path> <current-branch>`,
but git refuses to attach the same branch to two worktrees:

    fatal: '<branch>' is already used by worktree at '<main>'

This blocked atmux-team's first `worktreeIsolation: true` start (2026-05-12)
and would have blocked sopx-guild's demo-Wed cutover.

**Pivot**: per-member worktrees provisioned with `--detach`, starting at the
same commit as the team's current branch:

    git worktree add --detach <path> <branch>

**Trade-offs**:
- Members on detached HEAD lack `git branch --show-current` output. Gitter
  pattern already centralizes commits, so member-side branch awareness is
  not load-bearing for the documented workflow.
- Auto-push / auto-done paths that assume an attached branch in member cwds
  may need updates — file follow-up Tasks if surfaced.
- Branch-per-member (originally deferred under §"Out of scope") remains the
  structural fix if detached MVP surfaces ergonomics gaps.
```

## Test + impl impact (full enumeration)

| File | Change |
|---|---|
| `src/abstractions/worktree.ts` | Add `--detach`; update idempotence check; refresh doc comments |
| `tests/unit/abstractions/worktree.test.ts` | 4 test rewrites (argv + idempotence semantics) |
| `tests/unit/verbs/start.test.ts` | 1 assertion add (`--detach` in argv) |
| `docs/adr/082-worktree-isolation-per-member.md` | Addendum 2026-05-12 |
| `src/core/auto-done.ts`, `src/core/auto-push.ts` | **Audit needed** — confirm they don't break on detached HEAD in member cwd; defer to follow-up Task if they do |
| `src/verbs/doctor.ts` ADR-082 W5 probes | `worktree-wrong-branch` class needs re-thinking — detached IS the new expected state |

## Estimated effort

~30 LOC code + ~80 LOC test diffs + ADR addendum. Single commit, single member, ~30min including test runs. Drop-in for ops-lane porter.

## Suggested dispatch shape

New Task under t-eee0a7f6 (or a sibling):

> **W3.1 (ADR-082 hotfix)**: pivot worktree provisioning to `--detach`.
> Files: `src/abstractions/worktree.ts`, `tests/unit/abstractions/worktree.test.ts`, `tests/unit/verbs/start.test.ts`, `docs/adr/082-worktree-isolation-per-member.md`.
> AC: `git worktree add` argv includes `--detach`; idempotence test passes for re-provisioning a detached worktree; ADR addendum lands.
> Lane: ops. Priority: P100 (unblocks dogfooding `worktreeIsolation: true` on atmux-team).
