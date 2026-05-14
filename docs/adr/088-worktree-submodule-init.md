# ADR-088: Opt-in submodule init on worktree provision

**Status**: accepted
**Date**: 2026-05-13
**Extends**: ADR-082 (worktree isolation), ADR-084 (per-member branch model).
**Driver-ref**: driver-inbox 14:03 MYT 2026-05-13 §Pillar (file-mod citation `src/abstractions/worktree.ts:133-178`).

## Context

ADR-082 + ADR-084 land per-member git worktrees under `.atmux/worktrees/<member>/`. `provisionWorktree` calls `git -C <repoPath> worktree add` which copies the working tree but does NOT initialize submodules — `.gitmodules` is committed in the parent, but `<wt>/<submodule-path>` lands as an empty directory until something runs `git submodule update --init --recursive` against that worktree.

For atmux-the-monorepo this is fine: zero submodules. But for downstream projects with submodules (`sopx`, `aix`, `pxsaic`, `myteam-alpha-root`, the journals tree at `~/work/journals/.sb`), members spawning into a fresh worktree see empty submodule directories, fail their first build, and either:

- File a flag noting "missing files at <path>" (cognitive cost, false-positive),
- Manually run `git submodule update --init --recursive` (no canonical lane for this; brief doesn't mention it), or
- Silently work around the gap by using the parent worktree's submodules through symlink (defeats isolation).

ADR-090 `spawn-epic` (in-flight) needs this helper as a primitive — epic-teams will provision shared worktrees with submodule trees pre-populated. Building it now reuses the same code path; later epic-team spawn just sets the same opt-in flag.

## Decision

Add an **opt-in** `team.worktreeInitSubmodules?: boolean` field (default `false`). When `true`, `provisionWorktree` runs `git submodule update --init --recursive` inside the freshly-created worktree as a follow-up step. Helper exposed as `initSubmodules(wtPath: string): Promise<void>` so ADR-090 + future ad-hoc callers can reuse the same logic.

### Why opt-in (not auto)

`git submodule update --init --recursive` can be expensive (clone full submodule history per worktree) and bandwidth-significant on a fresh hax box. For atmux's own dogfood it's 0 submodules → 0 work; the no-op behavior is free. But for a 15-submodule monorepo × 20 members × multiple cage rebuilds per day, the wasted clone-bytes add up. Opt-in keeps the path conservative — teams that need it flip the flag, teams that don't never pay the cost.

### Why best-effort (warn-and-continue per submodule failure)

A submodule might fail to init for benign reasons (network blip on a transitive GitHub clone, credentials missing for a private third-party transitive). Aborting the entire `provisionWorktree` on one failed submodule punishes the operator disproportionately — the worktree itself is fine; only that one submodule's contents are missing. The reviewer can later run `git submodule update --init <path>` against the affected worktree to recover.

Threshold judgment: a single `git submodule update --init --recursive` call returns a non-zero exit on ANY submodule failure (it doesn't surface per-submodule status without `--quiet --progress` parsing). Implementation: capture exit code + stderr; if non-zero, log a warning to stderr and continue. Operator can re-run `atmux doctor` (future) to detect the gap. This matches the established `provisionWorktree` pattern where a stale-dir warning + manual reconcile beats silent destructive auto-checkout.

### Resolved opens

- **Disk cost** (#4 from driver-inbox): accepted. Worktrees are deleted on EPIC merge per ADR-091 (in-flight); per-worktree submodule copies auto-reclaim with their parent. No shared-cache optimization (`alternate refs`, `--reference`) in this ADR; revisit if profiling surfaces a real bottleneck.
- **Per-submodule init policy**: best-effort warn-and-continue per above. Reviewer judgment: warn-vs-fatal threshold lives in code, not config; if a team wants fatal behavior it can wrap `provisionWorktree` itself.

## Implementation surface

### New code

1. `src/abstractions/worktree.ts:initSubmodules(wtPath: string, opts?): Promise<void>`
   - Idempotent (rerun is safe; `git submodule update --init` short-circuits on already-initialized submodules).
   - No-op on a repo with no `.gitmodules` (the git command itself is a no-op then; we don't need to pre-check).
   - GitSpawn injection point for tests.

2. `ProvisionOpts.initSubmodules?: boolean`
   - When `true` AND `created === true`, `provisionWorktree` calls `initSubmodules(worktreePath)` as the last step (after `git worktree add` succeeds).
   - When `created === false` (idempotent no-op path, worktree already existed), DO NOT re-run init. Operator may have intentionally not initialized; submodule re-pull on every cage-rebuild would surprise them.

3. `team.worktreeInitSubmodules?: boolean` in `src/schema/team.ts`
   - Boolean opt-in, defaults to `false`.
   - `start.ts` reads this and threads it into the `provisionWorktree` opts.

### Tests

- `tests/unit/abstractions/worktree.test.ts` — unit gate:
  - `initSubmodules` invokes `git submodule update --init --recursive` with `-C <wtPath>`.
  - Non-zero exit warns but does NOT throw (assertion via fake GitSpawn returning rc=1 + stderr text).
  - `provisionWorktree({initSubmodules: false})` does NOT call submodule update.
  - `provisionWorktree({initSubmodules: true})` calls submodule update once, after worktree-add.
  - Idempotent no-op (`created === false` path) does NOT call submodule update.
- `tests/e2e/worktree-submodule.test.ts` — dogfood:
  - Set up a fixture repo with a single submodule (real git, real file system).
  - Provision a worktree with `initSubmodules: true`.
  - Assert the submodule path exists + contains content (`README.md` or similar fixture file).

## Out of scope

- Auto-init on every worktree (operator must flip the flag explicitly).
- Submodule update on EXISTING worktrees (`atmux submodule-update <member>` or `atmux doctor --fix worktree-submodule-missing`) — punted to a follow-up if operators surface the need.
- Shared submodule object-cache (`--reference` / `alternate refs`) — speculative optimization until profiling motivates it.

## Cross-references

- ADR-082: worktree isolation per member.
- ADR-084: per-member branch model (provisionWorktree now produces per-member branches; this ADR extends the post-creation step).
- ADR-090: `spawn-epic` will reuse `initSubmodules` as a primitive.
