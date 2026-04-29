---
name: rcheckout
description: Recursively checkout `<branch>` on root + every nested git submodule, including detached HEADs. Use when the user types `/rcheckout <branch>` or asks to switch recursively. The branch is always the calling member's branch (per-member-branch model — see ADR-035). Wraps `scripts/recursive-checkout.sh` in the current project.
---

# rcheckout — recursive checkout

Switch root + every nested submodule onto `<branch>`. Handles detached HEADs by attaching to the branch; creates the branch from `origin/<branch>` if it exists only on the remote. Skips repos where `<branch>` doesn't exist locally or on origin (warn-and-continue).

## Invocation

`/rcheckout <branch>` — e.g. `/rcheckout aix-geoyws`. **Branch arg is mandatory.** Per ADR-035, there is no "config-mode" default that reads `.gitmodules` — the branch identifies the calling member, which `.gitmodules` cannot capture.

## Implementation

```bash
bash "$(git rev-parse --show-toplevel)/scripts/recursive-checkout.sh" "$BRANCH"
```

Where `$BRANCH` is the user-supplied argument. The script resolves the repo root from `$PWD`.

## After running

Report the summary line and any per-repo `WARN:` lines. If any failures (branch missing local + origin), surface them so the user can decide whether to create the branch.

## Related

- `/rpull <branch>` — recursive `git pull --ff-only origin <branch>` after checkout.
- `/rpush <branch>` — recursive `git push origin <branch>` (leaves-first).
