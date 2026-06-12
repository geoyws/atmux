---
name: driver
description: Driver-1 fleet-consolidation skill. Verbs — consolidate (fetch + merge every sibling driver branch into the base driver branch), status (read-only ahead/behind report). Use /atmux:driver <verb> [args].
argument-hint: <verb> [--dry-run]
---

<!-- authored 2026-06-10 — distilled from the unum driver-4 consolidation session -->

# /atmux:driver — Driver-1 consolidation of sibling driver branches

In the multi-driver model, one repo has several parallel Claude drivers:
driver 1 owns the base branch (e.g. `unum-geoyws`) and each additional
driver works on `<base>-driver-N` (e.g. `unum-geoyws-driver-4`). The
other drivers fix bugs and ship features on their branches; **driver 1's
job is to fetch and merge all of their work back into `<base>`** so the
base branch stays the single consolidated truth.

This skill is **prompt-driven by design — there is no script**. Branch
classification is mechanical, but merge-conflict resolution between
drivers (port collisions, same-bug-fixed-twice, renames racing new
features) requires judgment. The verbs below are the procedure; you are
the executor.

## Verbs

- `consolidate [--dry-run]` — the full fetch → classify → snapshot →
  merge → regenerate → gate → push pipeline. `--dry-run` stops after
  classification and reports what would merge.
- `status` — read-only: classification report only. Identical to
  `consolidate --dry-run` minus the dirty-tree snapshot planning.

Unknown verb → error: `"Usage: /atmux:driver <verb>. Verbs: consolidate|status"`.

---

## Verb — `consolidate`

### 1. Detect + classify

```bash
git fetch --prune origin
BASE=$(git branch --show-current)          # driver-1's branch = merge target
git for-each-ref "refs/remotes/origin/${BASE}-driver-*" --format='%(refname:short)'
```

- Exclude deploy variants: `*-staging`, `*-testing`, `*-e2e` are tier
  branches, never merge sources.
- For each driver branch: `git rev-list --left-right --count
  ${BASE}...origin/${BASE}-driver-N` → `behind ahead`. `ahead=0` →
  already merged, skip.
- **Containment check** (saves merges): a driver branch whose unmerged
  commits all appear in another driver branch (look for `chore: merge
  driver-N into driver-M` commits) is covered by merging the superset.
  Verify with `git rev-list origin/branch-A..origin/branch-B`. Merge
  maximal supersets only; re-verify the subsumed branches hit `ahead=0`
  afterwards.
- `--dry-run` / `status`: emit the report (§6 headers) and stop here.

### 2. Snapshot the dirty tree — never stash, never discard

If `git status --porcelain` is non-empty, the tree holds a previous
session's in-flight work. **Commit it as a snapshot before merging** —
`chore(driver-1): snapshot in-flight work before driver-N consolidation`
— with a body that itemizes what it contains. Rules:

- Never `git stash` it (stashes get lost across sessions) and never
  `git checkout --` anything (that destroys work you didn't author).
- If part of the dirty work is a *competing fix* for a bug a sibling
  driver also fixed (diff the dirty file against the driver branch to
  find out), still commit it — note the supersession in the snapshot
  body and resolve in the sibling's favor during the merge. History
  keeps both; nothing is destroyed.

### 3. Merge with the conflict doctrine

`git merge --no-ff origin/<superset-branch>`. Resolve conflicts by class:

- **Additive lists** (docker-compose services + depends_on, umbrella
  `mix.exs` releases, subgraph/SUBGRAPHS arrays, runtime config repo +
  endpoint lists, i18n namespaces): **union** — keep both sides'
  additions.
- **Same bug, two fixes**: the **tier-verified fix wins** (the one with
  deploy/go-live receipts on a live tier). The other side's attempt is
  already preserved in the snapshot commit. Check the loser's approach
  for latent flaws before discarding it from the tree — if it's actually
  better AND verified, say so in the report instead of silently picking.
- **Resource collisions** (two new services claiming the same port,
  schema name, env slot): first-landed on `<base>` keeps its slot; the
  incoming service is **renumbered to the next free slot — then sweep
  the ENTIRE repo for the old value**: app config, docker-compose,
  tier/infra compose files, healthchecks, env.example, deploy scripts,
  e2e harnesses, ADRs and PRDs that pin the value (update specs; leave
  historical evidence lines that record what actually ran). A renumber
  that misses the tier compose while the gateway supergraph bakes the
  new value = a broken deploy.
- **Refactor vs. rename races** (one side restructured code the other
  side renamed through): take the refactor, then re-apply the rename
  inside it. Grep for the old name afterwards.
- **Generated artifacts** (supergraph, codegen output, lockfiles):
  **never hand-merge** — resolve source conflicts first, then
  regenerate (`pnpm install` for lockfiles, the repo's compose/codegen
  scripts for the rest).

### 4. Post-merge integrity sweep

Auto-merge hides as much as conflicts show. Before committing:

- `git diff --check` + `git grep '^<<<<<<< '` — no markers anywhere.
- Grep every renumbered/renamed value repo-wide; expect zero stale hits
  outside historical-evidence docs.
- **Every-list-that-enumerates-services check**: a new service from a
  sibling must appear in *all* registries the repo keeps (runtime
  config lists, release lists, compose, supergraph, gateway deps,
  backup/DR discovery, CI matrices). Sibling drivers reliably miss the
  ones their tier doesn't exercise (e.g. prod-only runtime lists when
  their tier runs MIX_ENV=dev).

### 5. Gates, commit, push, verify

- Run the repo's local gates per its CLAUDE.md (e.g. `pnpm type-check`,
  `pnpm test`, `mix test`). Long suites: run in background, but do NOT
  push until they pass — report honestly if you pushed nothing because
  a gate is red. No-lies rules apply: a gate you skipped is a gate you
  report as skipped, not as green.
- Merge-commit message lists each resolution class explicitly (what
  won, what was renumbered, what was regenerated).
- Push `<base>` per the repo's push policy (per-dev branch-staging
  auto-pushes; primary staging / main NEVER without operator
  authorization).
- Re-verify every driver branch now shows `ahead=0` against `<base>`.
  Any branch still ahead → it received commits mid-consolidation; loop
  once, then report instead of looping forever.

### 6. Report (verdict-first header, then detail)

- `**✅ Consolidated** — N driver branches merged into <base>, gates green, pushed.`
- `**⚠ Consolidated with calls** — merged, but <list judgment calls: supersessions, renumbers>.`
- `**👁 Needs your call** — <conflict/gate/push blocker requiring the operator>.`
- `**✅ Nothing to merge** — all driver branches at ahead=0.`

Body: per-branch verdict table, conflict resolutions with one-line
rationale each, gate results with receipts, what was pushed.

## What it does NOT do

- Fix the bugs the other drivers are fixing — consolidation only.
- Merge epic-team branches (`/atmux:ghostbuster` owns `${TRUNK}-epic-*`).
- Push primary staging / main (operator-manual per push policy).
- Delete or rewrite sibling driver branches — they belong to their drivers.
