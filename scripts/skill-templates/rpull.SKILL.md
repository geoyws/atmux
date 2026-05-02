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

## Related

- `/rcheckout <branch>` — switch all repos to `<branch>` first.
- `/rpush <branch>` — push direction.
