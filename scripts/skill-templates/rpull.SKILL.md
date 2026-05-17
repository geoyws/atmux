---
name: rpull
description: Recursively `git pull --ff-only origin <branch>` on root + every nested git submodule currently on `<branch>`. Use when the user types `/rpull <branch>` or asks to pull recursively. Refuses unless every repo is on `<branch>` first — run `/rcheckout <branch>` to align. Wraps `scripts/recursive-pull.sh` in the current project.
---

# rpull — recursive pull

Fast-forward each repo (root + nested submodules) on `<branch>` against `origin/<branch>`. Refuses if any repo is on a different branch — partial pulls leave the tree in a half-state.

The branch is the **calling member's branch** (`myteam-beta-dev`, `myteam-beta-bob`, `myteam-alpha-dev`, `myteam-c-dev`, etc.). Per the per-member-branch model (ADR-035), the branch arg is mandatory — there is no `.gitmodules`-driven default.

## Invocation

`/rpull <branch>` — e.g. `/rpull myteam-beta-dev`.

## Implementation

```bash
bash "$(git rev-parse --show-toplevel)/scripts/recursive-pull.sh" "$BRANCH"
```

Where `$BRANCH` is the user-supplied argument. The script resolves the repo root from `$PWD` and recurses into every nested submodule on `<branch>`.

## --ff-only rationale

Enforces `--ff-only` so the sweep can never produce an unexpected merge commit. Diverged repos abort and are reported by name.

## After running

Report the summary line. If pre-flight refused, list the offending repos and suggest `/rcheckout <branch>` first.

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

## Related

- `/rcheckout <branch>` — switch all repos to `<branch>` first.
- `/rpush <branch>` — push direction.
