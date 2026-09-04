# ADR-245: Singleton `.atmux/` per project — no nested atmux state

**Status**: Accepted — ratified by operator 2026-05-27 13:15 MYT (live operator-design session)
**Date**: 2026-05-27
**Driver-ref**: operator-direct 2026-05-27 — "there will always be one .atmux per project and all branching development we assume will have to be another project."
**Cross-refs**: [ADR-018](018-per-team-tmux-socket-isolation.md) (cage isolation — one tmux server per team), [ADR-082](082-worktree-isolation-per-member.md) (per-member long-lived branches), [ADR-084](084-worktree-per-member-branch-model.md) (per-member git worktrees under `.atmux/worktrees/`), [ADR-090](090-epic-team-lifecycle.md) (epic-team subtrees + dissolution), [ADR-211](211-orchd-spawn-supervisor.md) §nested-.atmux-ban (orchd-spawn checks for nested .atmux), [ADR-239](239-three-driver-minimum-per-team-and-no-sendkeys-invariant.md) (per-driver worktrees), [ADR-244](244-per-repo-pre-commit-kanban-decisions-snapshot.md) §Supersession-2026-05-26 (atmux state in dotfiles, symlinked into the project's singleton .atmux/)

## Context

Atmux's runtime model relies on a project-root `.atmux/` directory holding the team's source-of-truth state (team.json symlink → dotfile, state/*, decisions.md, worktrees/, kanban DB, lock files, logs). The expected invariant — implicit across the codebase but never codified — is that **each project has exactly one `.atmux/`**.

Recent failure modes that surfaced the gap:

1. **Worktrees inheriting tracked atmux state** (root cause of ADR-244 §Supersession-2026-05-26's worktree-duplication concern). When `.atmux/team.json` was tracked in-repo, every per-member / per-driver git worktree under `.atmux/worktrees/<name>/` got its own copy at `.atmux/worktrees/<name>/.atmux/team.json` — a NESTED `.atmux/`. Atmux's read-path then ambiguates: does the worktree's pane consult the parent's `.atmux/team.json` (single source of truth) or its own nested copy (drifts independently)? The latter is wrong but invisible until states drift.
2. **Orchd-window spawn from a worktree's nested `.atmux/`** (fixed in `adb0fa7 fix(orchd-window): BAN nested .atmux paths at maybeSpawnOrchdWindow entry`). The supervisor would target the wrong tmux session if its `teamRoot` resolution landed on a nested `.atmux/` instead of the parent's.
3. **Epic-team team.json under double `e-` prefix** (fixed in `9bbbb9a fix(epic-naming,atmux-dir): strip e- prefix from epic branch token + strip-back ancestor walk for nested .atmux/`). Symptom: spawn-epic produced branch names like `<base>-e-e-21-<hash>` because the e- prefix was being doubled by the spawn code.

All three failures share a root cause: the codebase wasn't enforcing that `.atmux/` exists only at the project root. This ADR codifies the rule + names the implementation discipline.

## Decision

### D1 — Each project has exactly one `.atmux/`, at the project root

**Definition of "project root":** the directory at which `atmux start <team>` resolves the team's identity. For a normal team this is the directory containing the team's `.atmux/team.json` (which today is a symlink to the operator's dotfile per ADR-244 §Supersession-2026-05-26). For an epic-team (ADR-090), the project root is the epic-team's own dedicated directory (typically `<atmux-source>/src/atmux-epics/e-<n>-<hash>/`), NOT the parent team's directory.

**The invariant:** for any project root P, the set of directories matching `find P -type d -name '.atmux'` MUST contain exactly P/.atmux/. Any other match is a violation.

Concrete: `P/.atmux/worktrees/<name>/.atmux/` MUST NOT exist. Per-member and per-driver worktrees under `P/.atmux/worktrees/<name>/` do NOT carry their own atmux state — they share the parent's `.atmux/` via the project-root resolution.

### D2 — Worktrees under `.atmux/worktrees/` are legitimate; they share the parent's `.atmux/`

The structural layout from ADR-082 (per-member branches), ADR-084 (per-member worktrees), and ADR-239 §A1 (per-driver worktrees) STAYS — `.atmux/worktrees/<name>/` is the canonical home for per-member and per-driver git worktrees. What this ADR adds:

- **Shared atmux state.** Each `<name>` worktree is a working tree on its own branch (`<base>-<name>`), but it does NOT have its own `.atmux/` subdir. The worktree's pane (whether driver or member) consults the PARENT's `.atmux/team.json` (via the operator's dotfile symlink) — there's no per-worktree team config, no per-worktree decisions log, no per-worktree kanban. Single source of truth.
- **Concretely**: a worktree at `P/.atmux/worktrees/driver-2/` does not have `P/.atmux/worktrees/driver-2/.atmux/team.json`. Atmux's read code walks UP from the worktree's CWD to find the nearest `.atmux/` and stops at P/.atmux/.

### D3 — Branching development that needs DIFFERENT atmux state is a separate project

The operator may want a branch of development with a DIFFERENT team roster, kanban, decisions log, etc. — e.g. an experimental shape of the team, or a different product spawned off a fork. Per this ADR, that is **a separate project, not a nested .atmux/**.

Practical examples:

- **Epic-team (ADR-090)** — separate project tree at `<atmux-source>/src/atmux-epics/e-<n>-<hash>/`. Has its own `.atmux/team.json` (managed via dotfiles per ADR-244 §Supersession-2026-05-26). Its own kanban, decisions, etc. Not nested under the parent's `.atmux/`.
- **Fork of a managed project** — clone the repo to a new top-level directory (`~/work/src/<project>-experiment/`), give it its own `.atmux/team.json` via dotfile entry, register it in `_dotfiles/atmux/_repo-registry.sh`. It's a peer of the original project, not a sub-tree.
- **Per-tier deployment cages** (sopx-staging, sopx-geoyws-driver-2-staging, etc.) — already separate project trees under `/root/work/ifca/deployments/<cage>/`. Each carries its own `.atmux/team.json` symlinked to its own dotfile entry.

The user-facing rule: "if you need atmux to manage it differently, it's a different project."

### D4 — Enforcement points across the codebase

Implementation surfaces that MUST honor + enforce the singleton invariant:

1. **`maybeSpawnOrchdWindow`** (`src/core/orchd-window.ts`) — already enforces via `adb0fa7`. Refuses to spawn against a nested `.atmux/` teamRoot.
2. **Worktree provisioner** (`src/abstractions/worktree.ts::provisionWorktree`) — `git worktree add` MUST NOT carry tracked `.atmux/` content into the new worktree. Since ADR-244 §Supersession-2026-05-26 untracked `.atmux/team.json` (and decisions.md, kanban.sqlite) everywhere, this is structurally guaranteed: the worktree branch has nothing atmux-flavored to checkout. Reviewers MUST refuse any future PR that re-introduces a tracked `.atmux/<anything>` carve-out outside of doc-comment artifacts.
3. **Strip-back ancestor walk** (`src/core/cage-resolver.ts` + `src/core/cockpit.ts`) — when resolving the project root from an arbitrary CWD (e.g. inside a worktree), the walker MUST strip back to the FIRST `.atmux/` it finds going up the directory tree, then strip back further if that `.atmux/` is itself under another `.atmux/worktrees/`. Implemented in `9bbbb9a`.
4. **Epic-team spawn** (`src/verbs/team/spawn-epic.ts`) — the epic-team gets its own top-level directory under `src/atmux-epics/e-<n>-<hash>/`, NOT a nested directory under the parent's `.atmux/`. The dotfile registry (per ADR-244 §Supersession-2026-05-26) gets a new entry for the epic-team's `<repo-key>` → `<path>` mapping. Implemented + registered in this commit's `_repo-registry.sh` (e-21-6593dd0f, e-22-4d6af038, e-23-0f71512b).
5. **CI lint** (future, post-this-ADR) — a `bun scripts/lint-nested-atmux.ts` check could enforce zero nested `.atmux/` dirs across the tree on every commit. Deferred — current state is clean; lint hardens against regressions.

### D5 — Cleanup of historical nested `.atmux/` was a one-shot 2026-05-27 sweep

The 2026-05-26 + 2026-05-27 cleanup pass that paired this ADR with ADR-244 §Supersession-2026-05-26 removed 13 nested `.atmux/` directories across 4 repos (atmux + rentx-root + unum-root + ifca-docs). Each removal was paired with a per-member-branch commit that untracked the `.atmux/team.json` blob on that branch, so the nested `.atmux/` cannot re-appear on future checkouts. After this sweep, the invariant from D1 is FACT, not just intent.

Verification command (any future reviewer can run):

```bash
find /root/work -maxdepth 8 -type d -name '.atmux' 2>/dev/null | \
  awk '$0 ~ /\/\.atmux\/worktrees\/.+\/\.atmux$/ {print "NESTED: " $0}'
```

Empty output = invariant holds.

## Consequences

### What changes

- Codebase invariant explicitly named. Future ADRs reference D1-D3.
- Reviewer gates extended: any tracked `.atmux/<anything>` carve-out beyond the operator-private dotfile symlink pattern is a no-merge.
- Branching-dev workflow standardized: "want a different atmux setup? spawn a new project." No more ambiguity about whether a sub-worktree can have its own roster.

### What breaks

- **Nothing in current runtime** — the cleanup pass already removed every historical nested `.atmux/`. The ADR codifies the existing post-cleanup state.
- Future PRs that try to re-introduce tracked `.atmux/<anything>` carve-outs trip reviewer enforcement.

### What we give up

- Per-worktree atmux customization. A driver-N worktree CANNOT have its own kanban-experiments folder, its own decisions log fork, etc. If you want that, spawn a peer project. (Same cost noted in ADR-244 §Supersession-2026-05-26 — the dotfile-centric model already pushed everyone to this shape.)

### Rollback path

Revert this ADR + un-enforce D4's points. No code-level rollback needed because the ADR documents an invariant that's already structurally true.

## Decision-anchors

- **DA1 ↔ D1**: singleton invariant — operator ask 2026-05-27 verbatim "there will always be one .atmux per project"
- **DA2 ↔ D2**: worktree subdirs share parent — derivative: ADR-082+ADR-239 layout stays, just without nested .atmux
- **DA3 ↔ D3**: branching-dev → separate project — operator ask 2026-05-27 verbatim "all branching development we assume will have to be another project"
- **DA4 ↔ D4**: enforcement points list — derived from the three historical failure modes in §Context
- **DA5 ↔ D5**: 2026-05-27 sweep is the one-shot — operator authorized "clean all nested .atmux" 2026-05-27; the 13-file cleanup landed in commits across atmux + 3 product repos

## Open questions

1. **OQ1**: Should `atmux doctor` include a singleton check (refuse with hint if nested `.atmux/` detected at runtime)? **Lean**: yes, low-cost addition — deferred to a follow-up so this ADR ships minimal. Tracked as a doctor enhancement.
2. **OQ2**: Should the dotfile registry (`_dotfiles/atmux/_repo-registry.sh`) auto-derive epic-team entries from `<atmux-source>/src/atmux-epics/e-*/` rather than requiring manual registry edits? **Lean**: convention-based discovery is brittle (e-* names change as epics rotate); operator-explicit is cleaner. Keep manual.
3. **OQ3**: What about per-driver experimental atmux setups (e.g. driver-4 wants to dogfood a different kanban model)? **Lean**: that's exactly D3 — spawn a new project, don't nest. Operator can copy-fork.
