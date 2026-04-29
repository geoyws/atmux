---
name: rpush
description: Recursively `git push origin <branch>` on root + every nested git submodule currently on `<branch>`. Use when the user types `/rpush <branch>` or asks to "push all submodules to <branch>" / "rpush <branch>". Pushes leaves-first so parent submodule pointers always reference commits already on origin. Skips repos on a different branch with a hint. Wraps `scripts/recursive-push.sh` from the atmux repo.
---

# rpush — recursive submodule push

Push each repo (root + nested submodules) currently on `<branch>` to `origin/<branch>`. **Leaves-first ordering** so a parent's submodule pointer never lands on origin pointing at a child commit that doesn't exist yet.

## Invocation

The user passes the target branch: `/rpush sopx-geoyws`.

## Implementation

```bash
bash /root/work/src/atmux/scripts/recursive-push.sh "$BRANCH"
```

Where `$BRANCH` is the user-supplied argument. Do not change cwd — the script defaults to `$PWD`.

## Push order rationale

Submodules are pushed deepest-first via `git submodule foreach --recursive`'s output reversed. The parent pushes last. If you push parent before children, fetchers of the parent get a "submodule update failed: commit not found" error.

## Push policy reminder

This script delegates branch decisions to the caller. **Per project push policy**, primary staging branches (`<product>-staging`) are George-manual ONLY — never auto-push to those. WIP / per-developer branches (`<product>-<dev>` / `<product>-<dev>-staging`) are fine. The script does not enforce this — the **caller must.**

## After running

Report the summary line. If any repo SKIP'd because of branch mismatch, suggest `/rcheckout <branch>` first. If any push failed, show the affected repos and the error from `tail -3` of git's output.

## Related

- `/rcheckout <branch>` — switch all repos to `<branch>` first.
- `/rpull <branch>` — pull direction.
