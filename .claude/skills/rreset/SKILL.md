---
name: rreset
description: Recursively `git fetch origin <branch>` + `git reset --hard origin/<branch>` on root + every nested git submodule currently on `<branch>`. Use when the user types `/rreset <branch>` or asks to "reset all submodules to origin/<branch>" / "rreset <branch>". DESTRUCTIVE — discards uncommitted work + unpushed commits. Snaps the entire monorepo (root + nested submodules) to the remote tip of `<branch>`. Skips repos on a different branch with a hint to run `/rcheckout <branch>` first. Wraps `scripts/recursive-reset.sh` from the atmux repo.
---

# rreset — recursive submodule reset

Snap each repo (root + nested submodules) currently on `<branch>` to its own `origin/<branch>` tip via `git fetch` + `git reset --hard`. **DESTRUCTIVE** — discards uncommitted changes, staged changes, AND unpushed commits across every repo on the named branch.

## When to use

The canonical "fresh slate" operation in the per-member-long-lived-branch (PMLLB) flow (ADR-069+075):

1. **Member starts a new task on a clean base.** Member finishes task-A, claims task-B → run `/rreset main` first (or `/rreset <member-branch>` after rebase) to snap the worktree to origin's tip across root + submodules.
2. **Recover from a botched experimental change.** Operator made local changes they want to abandon; `/rreset <branch>` drops everything.
3. **Sync after a force-push** (rare, manual) — when origin's `<branch>` history was rewritten and local copies need to discard their version.

DO NOT use for routine "pull latest" — `/rpull <branch>` is the non-destructive equivalent and preserves any local state.

## Invocation

The user passes the target branch: `/rreset main` or `/rreset atmux-geoyws`. **Branch arg is mandatory.**

## Implementation

```bash
bash "$(git rev-parse --show-toplevel)/scripts/recursive-reset.sh" "$BRANCH"
```

Where `$BRANCH` is the user-supplied argument. The script resolves the repo root from `$PWD`.

## Pre-flight refusal

If any repo (root or submodule) is currently on a different branch, the script REFUSES with the list of mismatches and a hint to run `/rcheckout <branch>` first. This prevents the resetter from accidentally pulling repos onto the wrong line.

## Reset order

Leaves-first (deepest submodules first), root last — symmetric with `/rpush`. Each repo's reset is local; order is functionally independent but kept consistent for predictability.

## After running

Report the summary line. If any repo failed (fetch error, network issue), surface them so the user can retry or investigate. Working tree should be clean across every repo afterward — verify with `git status` if uncertain.

## Operator-facing report format — attention + verdict markers

Per `[[feedback-unambiguous-attention-and-verdict]]` and the coordination-plugin precedent. `/rreset` is destructive; the verdict communicates whether the destruction landed AND whether what was destroyed is recoverable.

**Verdict-derivation rules:**
- **✅** every repo on `<branch>` fetched + reset cleanly, working tree clean across the tree, AND no unpushed commits were observably destroyed (pre-reset HEAD matched origin tip on every repo).
- **⚠** reset landed cleanly BUT some repos had unpushed commits at HEAD pre-reset (now recoverable only via reflog) — operator should know what was just dropped.
- **🔴** pre-flight refused (off-branch repos), OR ≥1 fetch failed (network/auth), OR reset itself failed mid-tree leaving partial state.
- **👁** attaches when operator must decide: confirm dropped unpushed work was intentional, run reflog recovery, manually finish a partial reset.

**Examples:**
```
✅ /rreset myteam-beta-dev — root + 4 submodules snapped to origin/<branch>, no unpushed commits dropped
```
```
👁 ⚠ /rreset myteam-beta-dev — reset OK, 2 repos had unpushed commits (now reflog-only)
Dropped: apps/foo/_svc (3 commits ahead of origin), apps/bar/_lib (1 commit ahead)
👁 Operator: if any of those mattered, recover via `git reflog` in the affected repo NOW (before next gc)
```
```
👁 🔴 /rreset <product>-staging — refused per safety reminder
Cause: primary-staging branch, operator must explicitly intend to drop unpushed staging commits
👁 Operator: if intentional, override by running the underlying script manually with --i-mean-it; otherwise abort
```

**Anti-pattern:** marking `✅` after dropping unpushed work without surfacing what was dropped. Silent destructive success defeats the safety reminder — always escalate to `⚠ + 👁` when reflog is the only recovery path.

## Safety reminders

- This **discards uncommitted work** silently. There is no `--dry-run` or interactive prompt — operator confirms by typing the command.
- This **discards unpushed commits**. If you pushed before resetting, recovery is via `git reflog`. If you didn't, the work is gone.
- Per project push policy: **never `/rreset` a primary staging branch** (`<product>-staging`) unless the operator explicitly intends to drop unpushed staging commits — those are typically driver-manual-only operations.

## Related

- `/rcheckout <branch>` — switch all repos to `<branch>` first (required pre-flight if any repo is on a different branch).
- `/rpull <branch>` — non-destructive: `git pull --ff-only`. Preserves local state. Use this 99% of the time.
- `/rpush <branch>` — push direction.
