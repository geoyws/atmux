---
name: rpush
description: Recursively `git push origin <branch>` on root + every nested git submodule currently on `<branch>`, leaves-first. Use when the user types `/rpush <branch>` or asks to push recursively. Refuses unless every repo is on `<branch>` — run `/rcheckout <branch>` first. Wraps `scripts/recursive-push.sh` in the current project.
---

# rpush — recursive push

Push each repo (root + nested submodules) currently on `<branch>` to `origin/<branch>`. **Leaves-first ordering** — submodules push deepest-first, root pushes last — so the parent's submodule pointer never lands on origin pointing at a child commit that doesn't exist yet.

The branch is the **calling member's branch** (per-member-branch model, ADR-035). Branch arg is mandatory.

## Invocation

`/rpush <branch>` — e.g. `/rpush myteam-beta-dev`.

## Implementation

```bash
bash "$(git rev-parse --show-toplevel)/scripts/recursive-push.sh" "$BRANCH"
```

Where `$BRANCH` is the user-supplied argument. The script resolves the repo root from `$PWD`.

## Push policy reminder

**Never push to primary staging** (`<product>-staging` — e.g. `myteam-beta-staging`, `myteam-alpha-staging`) — those are the driver-manual ONLY (see CLAUDE.md "Push Policy"). Per-member branches (`myteam-beta-dev`, `myteam-beta-bob`, `myteam-alpha-dev`, `myteam-c-dev`, etc.) auto-push freely. The script does not enforce this — the **caller must.**

## After running

Report the summary line. If pre-flight refused, list mismatches and suggest `/rcheckout <branch>` first. If any push failed, show the affected repos.

## Operator-facing report format — attention + verdict markers

Per `[[feedback-unambiguous-attention-and-verdict]]` and the coordination-plugin precedent.

**Verdict-derivation rules:**
- **✅** every repo on `<branch>` pushed cleanly, leaves-first ordering preserved, parent pointer refs visible on origin.
- **⚠** pushed OK but some repos were no-op (already at origin), OR pre-flight skipped off-branch repos.
- **🔴** pre-flight refused, OR ≥1 push rejected (non-fast-forward, hook block, primary-staging push attempt per CLAUDE.md push policy).
- **👁** attaches when operator must intervene: authorize a primary-staging push, resolve a non-ff rejection, switch off-branch repos.

**Examples:**
```
✅ /rpush myteam-beta-dev — 4 submodules + root pushed (leaves-first), all origin tips updated
```
```
👁 🔴 /rpush myteam-beta-staging — refused per CLAUDE.md push policy
Cause: primary-staging branch is driver-manual only
👁 Operator: authorize then run `scripts/push-staging.sh <product>-staging`
```

## Related

- `/rcheckout <branch>` — switch all repos to `<branch>` first.
- `/rpull <branch>` — pull direction.
