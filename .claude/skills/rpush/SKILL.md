---
name: rpush
description: Recursively `git push origin <branch>` on root + every nested git submodule currently on `<branch>`. Use when the user types `/rpush <branch>` or asks to "push all submodules to <branch>" / "rpush <branch>". Pushes leaves-first so parent submodule pointers always reference commits already on origin. Skips repos on a different branch with a hint. Wraps `scripts/recursive-push.sh` from the atmux repo.
---

# rpush — recursive submodule push

Push each repo (root + nested submodules) currently on `<branch>` to `origin/<branch>`. **Leaves-first ordering** so a parent's submodule pointer never lands on origin pointing at a child commit that doesn't exist yet.

## Invocation

The user passes the target branch: `/rpush myteam-alpha-dev`.

## Implementation

```bash
bash "$(git rev-parse --show-toplevel)/scripts/recursive-push.sh" "$BRANCH"
```

Where `$BRANCH` is the user-supplied argument. The script resolves the repo root from `$PWD`.

The branch is the **calling member's branch** (per-member-branch model, ADR-035). Branch arg is mandatory.

## Push order rationale

Submodules are pushed deepest-first via `git submodule foreach --recursive`'s output reversed. The parent pushes last. If you push parent before children, fetchers of the parent get a "submodule update failed: commit not found" error.

## Push policy reminder

This script delegates branch decisions to the caller. **Per project push policy**, primary staging branches (`<product>-staging`) are the driver-manual ONLY — never auto-push to those. WIP / per-developer branches (`<product>-<dev>` / `<product>-<dev>-staging`) are fine. The script does not enforce this — the **caller must.**

## After running

Report the summary line. If any repo SKIP'd because of branch mismatch, suggest `/rcheckout <branch>` first. If any push failed, show the affected repos and the error from `tail -3` of git's output.

## Related

- `/rcheckout <branch>` — switch all repos to `<branch>` first.
- `/rpull <branch>` — pull direction.

## Operator-facing report format — attention + verdict markers

Per `[[feedback-unambiguous-attention-and-verdict]]` and the coordination-plugin precedent.

**Verdict-derivation rules:**
- **✅** every repo on `<branch>` pushed cleanly, leaves-first ordering preserved, parent pointer refs visible on origin.
- **⚠** pushed OK but some repos were no-op (already at origin), OR pre-flight skipped off-branch repos.
- **🔴** pre-flight refused, OR ≥1 push rejected (non-fast-forward, hook block, primary-staging push attempt per project push policy).
- **👁** attaches when operator must intervene: authorize a primary-staging push, resolve a non-ff rejection, switch off-branch repos.

**Examples:**
```
✅ /rpush myteam-beta-dev — 4 submodules + root pushed (leaves-first), all origin tips updated
```
```
👁 🔴 /rpush myteam-beta-staging — refused per project push policy
Cause: primary-staging branch is driver-manual only
👁 Operator: authorize then run `scripts/push-staging.sh <product>-staging`
```
