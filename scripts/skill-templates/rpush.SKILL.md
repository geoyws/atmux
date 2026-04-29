---
name: rpush
description: Recursively `git push origin <branch>` on root + every nested git submodule currently on `<branch>`, leaves-first. Use when the user types `/rpush <branch>` or asks to push recursively. Refuses unless every repo is on `<branch>` — run `/rcheckout <branch>` first. Wraps `scripts/recursive-push.sh` in the current project.
---

# rpush — recursive push

Push each repo (root + nested submodules) currently on `<branch>` to `origin/<branch>`. **Leaves-first ordering** — submodules push deepest-first, root pushes last — so the parent's submodule pointer never lands on origin pointing at a child commit that doesn't exist yet.

The branch is the **calling member's branch** (per-member-branch model, ADR-035). Branch arg is mandatory.

## Invocation

`/rpush <branch>` — e.g. `/rpush aix-geoyws`.

## Implementation

```bash
bash "$(git rev-parse --show-toplevel)/scripts/recursive-push.sh" "$BRANCH"
```

Where `$BRANCH` is the user-supplied argument. The script resolves the repo root from `$PWD`.

## Push policy reminder

**Never push to primary staging** (`<product>-staging` — e.g. `aix-staging`, `sopx-staging`) — those are George-manual ONLY (see CLAUDE.md "Push Policy"). Per-member branches (`aix-geoyws`, `aix-yj`, `sopx-geoyws`, `geoyws-beads`, etc.) auto-push freely. The script does not enforce this — the **caller must.**

## After running

Report the summary line. If pre-flight refused, list mismatches and suggest `/rcheckout <branch>` first. If any push failed, show the affected repos.

## Related

- `/rcheckout <branch>` — switch all repos to `<branch>` first.
- `/rpull <branch>` — pull direction.
