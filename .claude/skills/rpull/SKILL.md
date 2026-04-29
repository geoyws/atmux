---
name: rpull
description: Recursively `git pull --ff-only origin <branch>` on root + every nested git submodule currently on `<branch>`. Use when the user types `/rpull <branch>` or asks to "pull all submodules from <branch>" / "rpull <branch>". Skips repos on a different branch with a hint. Wraps `scripts/recursive-pull.sh` from the atmux repo.
---

# rpull — recursive submodule pull

Fast-forward each repo (root + nested submodules) that is currently on `<branch>` against `origin/<branch>`. Skips repos on a different branch — never silently switches branches.

## Invocation

The user passes the target branch: `/rpull sopx-geoyws`.

## Implementation

```bash
bash /root/work/src/atmux/scripts/recursive-pull.sh "$BRANCH"
```

Where `$BRANCH` is the user-supplied argument. Do not change cwd — the script defaults to `$PWD`.

## --ff-only rationale

The script enforces `--ff-only` so the sweep can never produce an unexpected merge commit. If a repo has diverged from origin, the pull fails and is reported in the summary; the user resolves it by hand.

## After running

Report the summary line. If any repo SKIP'd because of branch mismatch, suggest `/rcheckout <branch>` first. If any failed (non-ff or network), show the affected repos.

## Related

- `/rcheckout <branch>` — switch all repos to `<branch>` first.
- `/rpush <branch>` — push direction.
