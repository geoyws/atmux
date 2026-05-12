# ADR-084: Per-member branch model for worktree isolation — amends ADR-082 OQ6

**Status**: proposed
**Date**: 2026-05-12
**Amends**: ADR-082 §"Decision (1) Branch model for MVP" + OQ6 resolution.
**Driver-ref**: 2026-05-12 ~11:40 MYT cockpit driver — *"every member tries to checkout 'geoyws' which git refuses"*.

## Context

### ADR-082 W6a dogfood-flip surfaced the bug

ADR-082 W1–W6a landed on `geoyws`:
- `src/abstractions/worktree.ts` provision/prune/list helpers (W1).
- `team.json` `worktreeIsolation` + `worktreeRoot` Zod fields (W2).
- `src/verbs/start.ts` per-member provision loop with cwd override (W3).
- `src/verbs/stop.ts --force` prune step (W4).
- `src/verbs/doctor.ts` worktree probe (W5).
- `team.json` `worktreeIsolation: true` flip on the atmux team (W6a, t-e82c1d11).

Verification gate W6c (t-4c6a30bf) is blocked pending W6b cage rebuild. **W6c will fail every gate** because the provisioning call physically cannot succeed under git's worktree-branch rules.

### Root cause

`provisionWorktree` at `src/abstractions/worktree.ts:136` shells:

```
git -C <repoPath> worktree add <wtPath> <branch>
```

`<branch>` is computed by `start.ts:469` from `git -C <projectRoot> branch --show-current`, which for the atmux team always resolves to `geoyws` — **the branch already checked out in the parent worktree** (`/root/work/src/atmux`). Git refuses:

```
fatal: 'geoyws' is already used by worktree at '/root/work/src/atmux'
```

The exception bubbles into `start.ts:491-499` which logs `worktree: <member> provision failed — falling back to shared cwd` and silently continues. Result: every member spawns at the shared `/root/work/src/atmux` cwd, the dogfood-flip is structurally inert, `.atmux/worktrees/` is never created (confirmed: directory does not exist on disk as of 11:50 MYT 2026-05-12).

The ADR-082 §"Branch model for MVP" claim — *"each worktree is created with `git worktree add <path> <current-branch>`, so members A and B both point at e.g. `geoyws`"* — was never possible. Git's worktree model is fundamentally one-branch-per-worktree (excluding `--detach`).

### Why this matters now

Demo Wed 2026-05-13 sopx-guild has 19 concurrent members. atmux has 11 (running today). Without a fix, the MVP claim *"stash-collisions can no longer eat untracked files"* is unmet — every cage rebuild silently reverts to the unisolated state ADR-082 was filed to prevent. The 2026-05-12 ADR-081 §"Stash-collision side-incident" bug class remains live.

## Decision

**Switch to per-member branch model.** Each member's worktree gets its own branch derived from the team's current branch:

```
member "up-impl"            → branch "geoyws-up-impl",            wt ".atmux/worktrees/up-impl"
member "parity-state-impl"  → branch "geoyws-parity-state-impl",  wt ".atmux/worktrees/parity-state-impl"
member "reviewer"           → branch "geoyws-reviewer",           wt ".atmux/worktrees/reviewer"
...
```

### Per-member branch naming convention

`<teamBranch>-<member>` — e.g. `geoyws-up-impl`. Rationale:

- **Upstream relationship is explicit.** Operator + driver inspecting `git branch --list` see the parent immediately. `git rebase geoyws` against `geoyws-up-impl` is unambiguous.
- **Push policy clean.** Per CLAUDE.md "Push Policy", `<product>-<dev>-staging` branches auto-push freely. `geoyws-<member>` is the same shape (non-primary-staging, individual-scoped) — auto-push allowed.
- **Namespace scoping.** All worktree branches sort together under `geoyws-*`, easy to grep / prune.
- **No collision with existing branches** — atmux already uses `geoyws` as the dev branch; no member is named after a real branch name.

Member-name sanitization: replace any non-`[a-zA-Z0-9_-]` characters with `-` before embedding in branch name. Today's atmux + sopx-guild members are all kebab-case ASCII; defensive measure for future names.

### `provisionWorktree` signature change

Current:
```ts
provisionWorktree(repoPath, branch, worktreePath, opts)
```

New — add `wtBranch` parameter (the member-scoped branch name):
```ts
provisionWorktree(repoPath, baseBranch, wtBranch, worktreePath, opts)
```

Spawn call becomes:
```ts
git -C <repoPath> worktree add -b <wtBranch> <wtPath> <baseBranch>
```

`-b <wtBranch>` creates `<wtBranch>` if absent, errors if already exists. The error path is recoverable: if `<wtBranch>` already exists from a previous run, fall through to plain `worktree add <wtPath> <wtBranch>` (no `-b`) so the existing branch is re-used. Both shapes are idempotent.

`findWorktreeBranch` (idempotence check) compares against `wtBranch`, not `baseBranch`:
- Worktree absent → provision.
- Worktree present AND on `wtBranch` → no-op, return `{ created: false }`.
- Worktree present AND on a different branch → throw (operator-managed mismatch, same as today).

### `start.ts` integration

Inside the `for (const member of team.members)` loop at `src/verbs/start.ts:485-500`:

```ts
const wtPath = resolveWorktreePath(team, member.name, dir);
const wtBranch = `${branch}-${sanitizeBranchSegment(member.name)}`;
const r = await provisionWorktree(repoPath, branch, wtBranch, wtPath, { git: gitSpawn });
```

`sanitizeBranchSegment(name)` is a small helper inside `worktree.ts` that returns `name.replace(/[^a-zA-Z0-9_-]/g, "-")`. Exported for the doctor probe.

### Doctor probe update (§5 of ADR-082)

Anomaly classes adjust:

- `worktree-missing` — unchanged (isolation team, no worktree dir for some member).
- `worktree-orphan` — unchanged (worktree dir for unknown member name).
- `worktree-wrong-branch` — now means *"worktree exists but not on `<base>-<member>` branch"*. The expected branch is computed per-member (using the same `sanitizeBranchSegment`), not a single team-wide branch.
- `worktree-disabled-but-present` — unchanged.

### `stop --force` prune (§4 of ADR-082)

Prune now leaves an orphan `<base>-<member>` branch behind. Two options:

1. **Leave the branch** — operator decides whether to keep / merge / delete. Safer; respects "never silently destroy work." Default.
2. **`--force --prune-branch` opt-in** — `atmux stop --force --prune-branch` follows `worktree remove` with `git branch -D <wtBranch>`. Deferred to follow-up ADR; out of scope for this fix.

`atmux doctor` surfaces orphan worktree branches via a new low-priority info (not anomaly) class: `worktree-branch-orphan` — a `geoyws-<name>` branch exists but no matching worktree. Suggests `git branch -D` to operator. Auto-fixable with `--fix` ONLY if `<name>` is not a current team member AND the branch has no unmerged commits relative to its base.

### Cross-references

- ADR-082 — supersedes OQ6 resolution; W1/W2/W3/W4/W5/W6a still hold; W6c verification needs the fix in this ADR.
- Push Policy (CLAUDE.md) — `geoyws-<member>` falls under `<dev>-staging` shape → auto-push freely.
- `feedback_destructive_ops_need_explicit_auth.md` — informs the `--prune-branch` opt-in framing.

## Consequences

- **One small round of edits.** `src/abstractions/worktree.ts` (signature + `-b` flag + sanitize helper), `src/verbs/start.ts:485-500` (compute wtBranch + thread through), `src/verbs/doctor.ts` worktree probe (per-member expected branch), corresponding unit tests. Estimated ~80 LOC additions + ~20 LOC modifications + ~60 LOC tests.
- **W6c dogfood-verify becomes physically possible.** All four gates (cwd-per-member, `git worktree list` count, `atmux doctor` zero anomalies, cross-member commit isolation) succeed once the cage is rebuilt.
- **Members get their own branches.** Workflow changes:
  - Each member commits + pushes to `<base>-<member>` freely.
  - Merging back to the base branch becomes an explicit operator action (`git checkout <base> && git merge <base>-<member>` or PR-based fan-in for products like SOPX).
  - For atmux specifically the gitter pattern can stay — one teammate (`gitter`) commits to its own `geoyws-gitter` branch; operator merges that into `geoyws` periodically. Or the gitter role moves to operating on the parent worktree's `geoyws` directly (existing pattern, no change).
- **Branch namespace grows.** N members × M team-rebuilds = N+M branches total (idempotence: same member always gets same branch). At 11 members on atmux + 19 on sopx-guild + future cockpit teams = ~30–40 branches under the `<base>-*` namespace per team. Acceptable; `git branch --list "<base>-*"` greps them together.
- **Reversibility — HIGH.** Switching back to "all members on shared branch" is impossible (git refuses), so the only reversal is back to `worktreeIsolation: false`. Per-member branch is structurally locked-in once isolation is on. Driver override channel exists for the *naming convention* (decisions log), not for going back to the impossible shape.
- **Demo Wed 2026-05-13 unaffected by ADR-082's MVP failure** — sopx-guild can opt into worktree isolation with this ADR's fix landed, OR stay on `worktreeIsolation: false` and rely on operator-side stash discipline (current state). Both paths unblock the demo; recommended path is land-the-fix-first if a worker is available.

## Open questions

OQ-1 — **Default `wtBranch` naming convention** — `<base>-<member>` vs `<member>-wt` vs `wt/<base>/<member>`. **Resolved default: `<base>-<member>`** (above rationale). Driver may override via `atmux decisions add` — namespace shape is the kind of bikeshed worth pinning early via the decisions log.

OQ-2 — **Branch cleanup on `stop --force`** — leave orphan branches (default) vs always prune. **Resolved default: leave** (safer; respects feedback_destructive_ops_need_explicit_auth.md). Follow-up `--prune-branch` flag deferred. Driver may override.

OQ-3 — **Gitter pattern alignment** — does the gitter role operate on its `geoyws-gitter` worktree branch, or on the parent repo's `geoyws` directly? **Deferred to operator.** Both work; no atmux-side enforcement.

## Audit trail

The exact `git worktree add` failure as it would have surfaced on a cage rebuild (reproducible from any current atmux worktree):

```
$ git -C /root/work/src/atmux worktree add /root/work/src/atmux/.atmux/worktrees/up-impl geoyws
fatal: 'geoyws' is already used by worktree at '/root/work/src/atmux'
```

The fix is one git CLI character — `-b <wtBranch>` between `add` and `<wtPath>` — plus a name-derivation helper. The ADR exists because the *naming convention* and the *operator-side workflow implications* (branch cleanup, push policy, merge train) need a recorded resolution, not because the code change is large.
