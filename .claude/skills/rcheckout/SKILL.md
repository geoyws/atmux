---
name: rcheckout
description: Recursively checkout a branch on the root repo + every nested git submodule, including detached HEAD or wrong-branch repos. Use when the user types `/rcheckout <branch>` or asks to "switch all submodules to <branch>" / "rcheckout <branch>". For monorepos with deeply nested submodules (e.g. sopx-root tree). Wraps `scripts/recursive-checkout.sh` from the atmux repo.
---

# rcheckout — recursive submodule checkout

Switch the current repo and every nested submodule onto `<branch>`. Handles detached HEADs by attaching to the branch; creates the branch from `origin/<branch>` if it exists only on the remote.

## Invocation

The user passes the target branch as the argument: `/rcheckout sopx-geoyws`.

## Implementation

Run the script from the atmux scripts directory, against the user's current working directory:

```bash
bash /root/work/src/atmux/scripts/recursive-checkout.sh "$BRANCH"
```

Where `$BRANCH` is the user-supplied argument. Do not change the working directory before invoking — the script defaults to `$PWD`, which is what the user wants.

## After running

Report the summary line (`=== summary: N repo(s) failed... ===`) and any per-repo `WARN:` lines. If all green, one-line confirmation. If any failures, show the affected repos so the user can decide whether to create the missing branches.

## Related

- `/rpull <branch>` — recursive `git pull --ff-only origin <branch>` after checkout.
- `/rpush <branch>` — recursive `git push origin <branch>` (leaves-first ordering).
