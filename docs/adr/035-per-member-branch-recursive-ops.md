# ADR-035: Per-member-branch model + recursive ops contract

**Status**: accepted
**Date**: 2026-04-29
**Related**: ADR-024 (per-member model selection), ADR-029 (driver/lead/superdriver scope), ADR-028 (no-agent-push to main/master)

## Context

Across IFCA monorepos with submodules (`aix-root`, `sopx-root`) and Unum, members work on **per-member branches** — `aix-yj` for YJ, `aix-geoyws` for George's aix work, `sopx-geoyws` for George's sopx work, `geoyws-beads` for George's Unum beads work. The branch identifies the member, not the product or the staging tier.

When a member enters their working state, root + every nested submodule is on **their** branch. Their pointer-bumps and code edits flow through that branch and the corresponding submodule branches. Other members' branches are not modified.

Three failure modes were observed before this ADR:

1. **macOS-hardcoded slash commands.** `aix-root/.claude/commands/r{pull,push,checkout}.md` had absolute paths like `/Users/geoyws/work/ifca/src/aix-root` baked in. Non-functional on hax (Linux). Created by a Mac-side session and never tested cross-machine.

2. **`.gitmodules` config-mode default.** The same aix slash commands defaulted to reading `submodule.<name>.branch` from `.gitmodules` to "unify" each submodule on its declared branch when invoked with no arg. `.gitmodules` cannot capture *which member is currently working* — it's a fixed declaration. Any "default" it produces is correct for at most one member and wrong for all others.

3. **Override-mode-as-blanket-policy.** During a fleet audit 2026-04-29, the superdriver ran `recursive-checkout.sh aix-geoyws` against aix-root's 17 submodules to "unify on the root branch." The immediate ops fast-forwarded cleanly, but the model is wrong: it erases per-member branch state in submodules and creates collisions next time a different member checks out their branch (their submodule branches may not exist locally, or will be stale).

The driver corrected: *"the intent is that each team member has their own branch... so no all-in on aix-geoyws."*

## Decision

### 1. `/rcheckout`, `/rpull`, `/rpush` always take an explicit branch arg

The atmux `scripts/recursive-{pull,push,checkout}.sh` design is the canonical contract:

```
recursive-pull.sh <branch> [<repo-root>]
recursive-push.sh <branch> [<repo-root>]
recursive-checkout.sh <branch> [<repo-root>]
```

`<branch>` is **mandatory**. Scripts refuse without it (`"${1:?usage: ... <branch>}"`). The branch is the **calling member's branch**, supplied explicitly each invocation.

No config-mode (no-arg) variants. No `.gitmodules`-reading "smart default." No "uniform on root branch" inference.

### 2. Skills are deployed per-team, not global

Each team's project ships its own copy:
- `<project-root>/scripts/recursive-{pull,push,checkout}.sh`
- `<project-root>/.claude/skills/r{pull,push,checkout}/SKILL.md` (referencing the team's own `scripts/`)

Not promoted to `~/.claude/skills/` (global). Reasons:
- Each team can adapt the script (e.g., custom `--ff-only` policy, lint hooks, push-policy guards) without affecting other teams.
- Skill discovery is project-scoped; a team's lead/members get the skill via the team's own project context.
- Eliminates the "global skill referencing one team's hardcoded path" anti-pattern (atmux's earlier skill referenced `/root/work/src/atmux/scripts/recursive-pull.sh` — fine while atmux owned the canon, broken once each team has its own).

### 3. Submodule load = detached HEAD; per-member-branch is for working state only

`git submodule update --init --recursive` after a fresh clone leaves submodules in detached HEAD at the parent's pinned SHA. **That's the correct read-only state.** `/rcheckout <my-branch>` is for *entering the working state* (so commits land on the right branch + push targets are obvious). Don't run `/rcheckout` reflexively after a load.

### 4. `.gitmodules` `branch = ` is metadata, not a working-state directive

`branch = aix-geoyws` in `.gitmodules` means: *when someone runs `git submodule update --remote`, fetch the latest commit from this branch into the parent's pin.* It does NOT mean "all members must have this submodule on this branch." Treat it as a remote-tracking hint for SHA bumps, not a checkout target.

## Consequences

**Removed (2026-04-29):**
- `aix-root/.claude/commands/rpull.md` — macOS-pathed, config-mode default. Superseded by `aix-root/.claude/skills/rpull/SKILL.md` (per-team) wrapping `aix-root/scripts/recursive-pull.sh`.
- `aix-root/.claude/commands/rpush.md` — same reasons.
- `aix-root/.claude/commands/rcheckout.md` — same reasons.

**Added per-team (2026-04-29):**
- `aix-root/scripts/recursive-{pull,push,checkout}.sh` (copy of atmux canon)
- `aix-root/.claude/skills/r{pull,push,checkout}/SKILL.md`
- `sopx-root/scripts/recursive-{pull,push,checkout}.sh`
- `sopx-root/.claude/skills/r{pull,push,checkout}/SKILL.md`
- Unum geoyws-beads worktree: same pair (pending — has no submodules so /rpull /rpush /rcheckout degrade to root-only ops, but the uniform interface is still useful)

**Push policy reminder (unchanged from CLAUDE.md):** primary staging branches (`<product>-staging`) are George-manual ONLY. `/rpush` does NOT auto-detect staging — the **caller** must respect the policy. Per-member branches (`aix-geoyws`, `aix-yj`, `sopx-geoyws`, `geoyws-beads`) are auto-pushable.

## Notes for the future

If a team genuinely wants "all submodules on one branch always" (e.g., a tightly-coupled monorepo where each release locks every submodule to the same tag), that's a *different ADR* — and would require tooling that's `.gitmodules`-driven by design (not the per-member tooling here). Don't conflate the two models.
