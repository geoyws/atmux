# ADR-015: Team members work in isolated git worktrees by default

**Status:** proposed (Phase 6 / v2 scope)
**Date:** 2026-05-05
**Owner:** architect (proposal originated from driver during Phase 1 dogfooding)

## Context

atmux today (bash @ HEAD) runs all team members against the same checkout of the parent project. Members coordinate via `.atmux/` state (kanban, inboxes), tmux panes, and member-to-member discipline (don't step on each other's files).

This works for state-isolated work (each member edits a distinct file). It breaks down for:
- **Concurrent test runs** — Vitest/Playwright/bun:test against shared `node_modules`, dist artifacts, dev servers, ports. Two members running the suite simultaneously corrupt each other's output, lock files, and process state.
- **Concurrent edits to the same file** — porter-A and porter-B both touching `src/abstractions/tmux.ts` race through git index, last-write-wins inside the working tree.
- **Branch-per-member workflows** — there's no clean way for porter-foundation to commit to a `worktree-atmux-bun-foundation` branch while reviewer pulls a different branch on the same checkout.
- **Rollback per member** — if porter-A's work needs reverting, the only granularity is "git reset" across the whole working tree, which clobbers everyone else's in-flight work.

The atmux-bun port team itself is dogfooding this pain right now. From the Phase 1 lead status DM:
> "tester: #39 (parity E2E with `version` stub) — has uncommitted `src/cli.ts` draft in working tree; coordinating with porter-foundation to avoid conflict"

That coordination is happening manually because there's no atmux primitive for it.

## Decision (proposed)

**v2 ships team-member-per-worktree as the default.** When `atmux start <team>` runs, each member gets their own git worktree under `<team-root>/.atmux/worktrees/<member>/` on a per-member branch (default name: `<team-branch>-<member>`). Members commit to their own branches. A new `atmux merge <member>` verb (or equivalent) ships diffs back to the team's primary branch via reviewer-gated merge.

Cleanup: `atmux stop <team>` (or member rotation via existing `rotate` verb) prunes the member's worktree if (a) the branch is fully merged or (b) operator opts in via `--discard`. Otherwise worktree is preserved and operator is told the path + branch name.

### Verb surface (v2, per ADR-014 subcommand structure)

```
atmux team start --worktrees           # opt-in for v2; default in v3
atmux member add <name>                # provisions worktree
atmux member rm <name>                 # prunes worktree (refuses if dirty unless --discard)
atmux member ws <name>                 # prints absolute worktree path (cd target)
atmux member status                    # shows per-member branch + dirty state + ahead/behind
atmux member merge <name>              # invokes reviewer gate, fast-forwards primary branch
```

### Defaults

- Worktree root: `<team-root>/.atmux/worktrees/<member>/` (parallel to current `.atmux/` state dir)
- Branch name: `<primary-branch>-<member>` (e.g. `worktree-atmux-bun-porter-foundation`)
- Lifecycle hooks: `atmux start` runs `git worktree add`, `atmux stop` runs `git worktree remove` (with safety checks)
- Member's tmux pane `cd`s into their worktree on launch (existing `lib/start.sh` extension)
- `team.json` schema gains `worktrees: { enabled: bool, root: string, branchPattern: string }` (Zod schema in `src/schema/team.ts`)

### Coordination implications

- **kanban.json + inboxes/** stay at `<team-root>/.atmux/` (NOT in member worktrees) — they're shared coordination state, not per-member work product
- **CI runs against the primary branch** after merge, not against per-member branches (matches existing pattern)
- **Reviewer's 8-check gate** runs in the reviewer's own worktree, pulling each member's branch as needed
- **Lead orchestration** unchanged — DMs and TaskList don't touch git

## Consequences

**Positives:**
- Parallel test runs no longer corrupt each other (separate `node_modules`, dist, dev-server ports)
- Per-member rollback is a `git worktree remove` away
- Branch-per-member becomes the natural unit of review (matches GitHub PR mental model)
- Reviewer can pull and inspect any member's branch without disturbing others
- The atmux-bun team's current manual coordination dance becomes a built-in primitive

**Negatives:**
- Disk usage: each worktree is a full checkout. Mitigation: `.gitignore` shared `node_modules` patterns; or lean on `pnpm` workspace links if the parent project uses pnpm.
- Bun's `node_modules` is not shareable across worktrees (bunfig has no per-worktree mode). Each member runs `bun install` separately. Mitigation: shared cache (`~/.bun/install/cache`) is automatic; only the symlink farm dupes.
- New verbs to design (`member ws`, `member merge`, `member status`) — fits cleanly in v2's subcommand surface (ADR-014).
- Cleanup edge cases: dirty worktree on `member rm`; orphaned branches on `team stop --discard`; concurrent worktree adds racing for the same branch name. All solvable with explicit safety prompts + `--force` overrides.
- Members who don't need worktree isolation (e.g., a docs-only member) pay the disk-tax for nothing. Mitigation: `--no-worktree` per-member flag in `member add`.

**Follow-up tickets:**
- ADR-015a: Branch naming convention — `<primary>-<member>` vs `member/<name>` vs `team/<team>/<member>`
- ADR-015b: Merge gate semantics — does `atmux member merge` fast-forward or require PR? Reviewer's role here vs GitHub's role
- ADR-015c: Disk-usage policies — auto-prune merged branches? Notify on >Nminutes-stale?
- ADR-015d: Interaction with existing tmux-pane-per-member — pane cwd's into worktree on launch; what happens if member dies and respawns?
- ADR-015e: WIP-stash on member rotation (existing `rotate` verb) — does rotated-out member's WIP stay on their branch or stash to a special ref?
- ADR-015f: Coordination state — confirm kanban/inboxes stay at team root, NOT in member worktrees, so members see shared state
- ADR-015g: Compatibility with non-git projects — atmux currently works on any directory; opt-out cleanly when no `.git` present

## Alternatives considered

### A. Stay with shared checkout (status quo)

Rejected for v2. The pain is real (current dogfooding evidence) and grows linearly with team size + parallelism.

### B. Member-per-branch on shared checkout (no worktrees)

Rejected. `git checkout <branch>` on a shared working tree breaks everyone else's running processes. Worktrees exist precisely for this case.

### C. Member-per-clone (full repo clone per member)

Rejected. Disk usage 10× worse than worktrees, no shared `.git/objects`, harder to merge (push to a remote, pull from another clone). Worktrees give the isolation without the duplication.

### D. Container-per-member (Docker/podman)

Rejected for v2. Heavy, breaks tmux integration, requires container runtime as new dep. Could be a v3 power-user mode.

### E. Use Claude Code's existing `Agent({isolation: "worktree"})`

Considered. That's per-Agent-call, not per-long-running-team-member. Each Agent spawn gets its own worktree, but a teammate spawned with `team_name: <name>` is a single long-running agent — one worktree for its whole lifetime. Fits the requirement: per-member worktrees that live as long as the member. atmux's job is to wrap this with the verb surface + coordination state placement.

## Implementation phasing

**Phase 6 (v2):**
- Ship `--worktrees` opt-in flag on `atmux team start`
- Implement `member ws`, `member status`, `member merge`, `member rm` with worktree semantics
- Default to opt-in (existing teams keep shared-checkout behaviour)
- Reviewer 8-check gate adapts to pull-then-review pattern

**Phase 7 (v3, post-3-month deprecation window):**
- Flip default to `--worktrees` on
- Remove shared-checkout legacy path
- Remove `--no-worktrees` opt-out (or keep as power-user escape hatch)

## References

- Driver-floated proposal during Phase 1 (this conversation)
- Lead status DM (2026-05-05 03:30 MYT) confirming current manual coordination of working-tree conflicts
- ADR-014 (verb design debt) — `member` namespace lands in Phase 6, `member ws/merge/status` fit naturally
- Claude Code Agent tool's `isolation: "worktree"` reference for the per-spawn case
