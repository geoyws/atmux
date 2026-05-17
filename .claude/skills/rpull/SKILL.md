---
name: rpull
description: Recursively `git pull --ff-only origin <branch>` on root + every nested git submodule currently on `<branch>`. Use when the user types `/rpull <branch>` or asks to "pull all submodules from <branch>" / "rpull <branch>". Skips repos on a different branch with a hint. Wraps `scripts/recursive-pull.sh` from the atmux repo.
---

# rpull — recursive submodule pull

Fast-forward each repo (root + nested submodules) that is currently on `<branch>` against `origin/<branch>`. Skips repos on a different branch — never silently switches branches.

## Invocation

The user passes the target branch: `/rpull myteam-alpha-dev`.

## Implementation

```bash
bash "$(git rev-parse --show-toplevel)/scripts/recursive-pull.sh" "$BRANCH"
```

Where `$BRANCH` is the user-supplied argument. The script resolves the repo root from `$PWD` and recurses into every nested submodule on `<branch>`. Don't change cwd — be inside the target project's tree when invoking.

The branch is the **calling member's branch** (`myteam-beta-dev`, `myteam-beta-bob`, `myteam-alpha-dev`, `myteam-c-dev`, etc.). Per the per-member-branch model (ADR-035), the branch arg is mandatory — there is no `.gitmodules`-driven default.

## --ff-only rationale

The script enforces `--ff-only` so the sweep can never produce an unexpected merge commit. If a repo has diverged from origin, the pull fails and is reported in the summary; the user resolves it by hand.

## After running

Report the summary line. If any repo SKIP'd because of branch mismatch, suggest `/rcheckout <branch>` first. If any failed (non-ff or network), show the affected repos.

## Related

- `/rcheckout <branch>` — switch all repos to `<branch>` first.
- `/rpush <branch>` — push direction.

## Operator-facing report format — attention + verdict markers

Per `[[feedback-unambiguous-attention-and-verdict]]` and the coordination-plugin precedent.

**Verdict-derivation rules:**
- **✅** every repo on `<branch>` ff-pulled cleanly (or was already up-to-date).
- **⚠** all repos pulled but some were no-op (already at origin), or pre-flight skipped repos on a different branch.
- **🔴** pre-flight refused entirely (any repo on the wrong branch), OR ≥1 repo had divergent commits blocking ff-only.
- **👁** attaches when operator must intervene: rcheckout to switch off-branch repos first, manually resolve divergence.

**Examples:**
```
✅ /rpull myteam-beta-dev — root + 4 submodules ff-pulled (2 had updates, 3 already current)
```
```
👁 🔴 /rpull myteam-beta-dev — pre-flight refused
Mismatches: apps/foo/_svc on `master` (expected myteam-beta-dev)
👁 Operator: run `/rcheckout myteam-beta-dev` first, then retry /rpull
```
