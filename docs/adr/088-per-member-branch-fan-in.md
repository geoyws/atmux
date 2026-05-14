# ADR-088: Per-member-branch fan-in policy — `<base>-<member>` → `<base>` merger model

**Status**: proposed
**Date**: 2026-05-14
**Resolves**: ADR-082 §"Out of scope" OQ3 (commit-batching / gitter-pattern policy) + ADR-084 OQ-3 (gitter-pattern alignment with per-member branches)
**Driver-ref**: 2026-05-14 ~08:00 MYT planner brief — *"planner-decompose next highest-value worktree epic — ADR-082 OQ items + ADR-084 OQ-2 (per-member-branch fan-in deferred decision)"*. Tracked on the kanban as t-71629309 (PLANNER decompose, this commit).

## Context

### ADR-082 + ADR-084 left fan-in unsolved

ADR-082 landed per-member worktrees at `<atmuxDir>/worktrees/<member>/`. ADR-084 amended OQ6: each worktree is on its own `<base>-<member>` branch (e.g. `geoyws-up-impl`, `geoyws-reviewer`). Members commit + push to their own branches freely under [[CLAUDE.md Push Policy]] (`<dev>-staging` shape — auto-push allowed).

**No automated path returns those commits to `<base>`.** ADR-084 §Consequences names this explicitly: *"Merging back to the base branch becomes an explicit operator action (`git checkout <base> && git merge <base>-<member>` or PR-based fan-in for products like SOPX)."* ADR-084 OQ-3 deferred the gitter-pattern question to the operator.

### Empirical state (this session)

`git -C /root/work/src/atmux branch --list 'geoyws-*'` returns 11 branches (every active atmux-team member). None have been merged back to `geoyws` since worktree-isolation flipped on 2026-05-12 (W6a). All forward-progress on `geoyws` since that flip came from George manually checking out `geoyws` + merging `<base>-<member>` branches periodically. That is a coordinating-operator bottleneck and trivially scales to 0 when George is asleep / occupied.

### Why this is now urgent

- atmux-team runs **11 concurrent members**; sopx-guild is opt-in-pending at 19. Without automation, fan-in is N × operator-touch per merge cycle. Linear in member count, manual in cadence.
- ADR-090 + ADR-091 specified epic-team auto-merge (`mergeMode: "auto"` + state machine) for the **shared-cwd / epic-team** topology — that does NOT cover the **per-member-branch / normal-team** topology this ADR addresses. ADR-091's gitter is the epic-team's, not the per-member-branch team's.
- The 2026-05-12 ADR-081 §"Stash-collision side-incident" structurally prevented further losses, but the *replacement workflow* (per-member branches) needs its own fan-in mechanism to be a complete pattern.

### Pre-decomp source-state audit

| Concern | Source-state finding | Scope adjustment |
|---|---|---|
| Branch listing | `git branch --list "<base>-*"` already works | Pure-shell primitive; no new abstraction needed |
| Worktree-aware ops | `src/abstractions/worktree.ts` provisions but never merges | Net-new `src/abstractions/branch-merge.ts` — pure git-shell wrapper |
| Verb layer | No `atmux merge-member` / `merge-cycle` verbs exist | Net-new `src/verbs/merge-member.ts` + `src/verbs/merge-cycle.ts` |
| team.json schema | `worktreeIsolation` + `worktreeRoot` shipped; no `merger` field | Net-new `team.merger.enabled` + `team.merger.baseBranch` (Zod optional) |
| Roles | `gitter.md`, `reviewer.md`, `lead.md` exist; no `merger.md` | Net-new `templates/briefs/merger.md` (alias-of-gitter for the fan-in lane) |
| Doctor probe | `worktree-*` probe classes shipped (ADR-082 §5) | Optional new `merger-branch-stale` probe (defer to follow-up if needed) |
| Push policy | `<base>-<member>` auto-push allowed; `<base>` push goes to driver | Merger pushes `<base>` after each merge — same `<base>`-push refuse-gate applies (merger needs explicit policy override; see §Decision-3 safeguards) |
| Cron primitives | `src/verbs/cron-install.ts` + `crontab.ts` shipped | `merge-cycle` cron template is one entry — reuse existing |

## Decision

### (1) Members are their own committers + pushers — no per-Task gitter relay

For worktree-isolated teams, the per-Task `gitter` relay pattern (one teammate commits + pushes on behalf of others; see `templates/briefs/gitter.md`) is **structurally redundant**. Each member already has:

- Their own worktree (`.atmux/worktrees/<member>/`)
- Their own `.git/index` (isolated by `git worktree`)
- Their own branch (`<base>-<member>`)
- Auto-push permission under [[CLAUDE.md Push Policy]]

The path-restricted-commit + lint-staged race-defenses in `gitter.md` are **inapplicable** in worktree-isolated teams — race conditions cannot occur across members. Each member commits + pushes their own Task work. This is already current practice on atmux-team (per [[feedback_atmux_no_gitter_worker_commits]]); ADR-088 encodes it formally.

**Implication**: worktree-isolated teams DO NOT declare a `gitter` member. The gitter brief stays valid for **shared-cwd teams** (epic-teams, legacy non-isolated) where the race-staging concerns apply.

### (2) Optional `merger` role for hands-off fan-in

Fan-in (`<base>-<member>` → `<base>`) is opt-in per-team via `team.json::merger.enabled`. Two opt-in shapes:

**Shape A: member-role merger** — declare a `merger` member in `team.json::members[]` (role=`merger`, tui=`claude`). The member runs the standard claim+work loop with a merger-specific brief (`templates/briefs/merger.md`). Inside that brief, the loop is:

1. `git -C <base-worktree> fetch origin`
2. `git -C <base-worktree> branch --list "<base>-*"` — enumerate all per-member branches.
3. For each `<base>-<m>` with commits ahead of `<base>` AND no observed `WIP:` / `[skip-merge]` markers: fire `atmux merge-member <m>`.
4. On clean fast-forward / `--no-ff` success: push `<base>` to origin (this is the carve-out — see §Decision-3 safeguards). Report `merger-success` flag with the SHA.
5. On conflict: `git merge --abort`, leave `<base>-<m>` untouched, surface via `atmux flag add --severity high` + `atmux reply` to driver. Skip; do not retry — semantic conflict needs human eyes.
6. Pace via `atmux claim --next --as merger` re-arm — the merger is event-driven (lane-tick wakes on each `task done` cascade) rather than polling.

**Shape B: driver-fired `atmux merge-cycle`** — no merger member. Driver / operator fires `atmux merge-cycle` (or schedules it via `atmux cron-install`). One-shot version of the merger loop. Reasonable for teams with sub-daily fan-in cadence or operator-supervised merging.

Default `team.merger.enabled === false`. Operators opt in explicitly per team. atmux-team is the first opt-in candidate (post-ADR-088 W2 lands).

### (3) `atmux merge-member <member>` verb — single-merge primitive

New verb at `src/verbs/merge-member.ts`. Idempotent; safety-gated. Pseudocode:

```ts
async function mergeMember(team: Team, member: string, opts: { push?: boolean }) {
  const base = team.merger?.baseBranch ?? currentBranch(team.repoPath);
  const wtBranch = `${base}-${sanitizeBranchSegment(member)}`;
  const baseWt = team.repoPath;

  await guardBaseWorktreeClean(baseWt);                // refuse if dirty
  await guardBranchExists(baseWt, wtBranch);           // refuse if branch absent
  await guardCommitsAhead(baseWt, base, wtBranch);     // refuse if no commits ahead (no-op)
  await git(baseWt, "fetch", "origin");
  await git(baseWt, "checkout", base);
  try {
    await git(baseWt, "merge", "--no-ff", wtBranch, "-m", `merge(${member}): fan-in <base>-<member> per ADR-088`);
  } catch (e) {
    await git(baseWt, "merge", "--abort");
    throw new MergeConflictError(member, wtBranch);
  }
  if (opts.push) {
    await guardPushTarget(base);                       // CLAUDE.md "Push Policy" — refuse if base matches `<product>-staging`
    await git(baseWt, "push", "origin", base);
  }
}
```

**Safeguards** (hard refuses, no overrides):

- `guardBaseWorktreeClean` — refuses if `<base>` worktree has unstaged or staged changes. The merger is never allowed to commit on top of operator-in-progress work.
- `guardPushTarget` — applies the [[CLAUDE.md Push Policy]] gate. If `<base>` matches `<product>-staging` (e.g. `sopx-staging`, `aix-staging`), the push is **refused** regardless of `opts.push`. Merger pushes are auto-allowed only for the `<product>-<dev>-staging` shape (e.g. `geoyws` itself for atmux — operator's per-dev branch). For primary-staging fan-in, merger writes to `<base>` locally + surfaces an `atmux reply` ask-for-push to the driver; operator fires `scripts/push-staging.sh staging` manually.
- `guardCommitsAhead` — emits a `no-op` exit (success, with informational stdout) when `<base>-<member>` has 0 commits ahead of `<base>`. Idempotent re-fire returns success without re-touching git state.

### (4) `atmux merge-cycle` verb — bulk-merge over all per-member branches

Single-shot wrapper that lists `<base>-*` branches, calls `merge-member` for each, summarizes. Used by Shape B (driver-fired) and by the cron template.

```
atmux merge-cycle [--team <name>] [--push] [--dry-run]
```

`--dry-run` lists what would merge without firing. `--push` propagates to per-member merges (still subject to the push-policy gate).

### (5) Cron template for unattended fan-in

`atmux cron-install --template merge-cycle [--interval 5m|15m|1h]`. Installs a cron entry that fires `atmux merge-cycle --push` for the current team at the chosen cadence. Default cadence on install: **15 minutes**. Output goes to `.atmux/merge-cycle.log` for the merger + doctor probes.

Cron-installed merge-cycle is the **automated equivalent** of a merger member, without burning a Claude Max seat. Trade-off: cron-mode loses the in-context flag-handling (conflicts go to the log + the standard `flags.md` channel rather than reactive driver-pings). Recommended path is **cron + driver tail-on-flag**, OR a merger member if seat budget allows.

### (6) Doctor probe additions

`src/verbs/doctor.ts` gains one new probe class (`merger-fan-in`):

- `merger-branch-stale` — `<base>-<m>` has commits ≥**`merger.stalenessHours`** old (default 24h) AND `team.merger.enabled === true`. Suggests `atmux merge-member <m>` or surface to operator. Auto-fixable with `--fix` only if `<base>` worktree is clean + `merge-member` returns clean fast-forward.
- `merger-disabled-but-member-present` — `team.members[]` contains a member with `role: "merger"` but `team.merger.enabled !== true`. Surface; not auto-fixable.

### (7) Deferred to future ADR-088b fold-in

- **PR-based fan-in** — `gh pr create` per `<base>-<m>`; auto-merge clean PRs via `gh pr merge --auto`. Heavier; needs `gh` auth + per-product PR-review-gate config. Driver-flagged use-case for sopx-guild (where reviewer-gated merge is the demo path); not in v1 scope for atmux-team.
- **Reviewer-gated fan-in** — require reviewer ✓ on every commit in `<base>-<m>` before merger picks up. ADR-085 (whip-approvals-watcher) is the precedent for the gate primitive; not in v1 scope.
- **Cross-team / cross-tenant fan-in** — epic-team children fan-in to epic-team base (complement of ADR-091's epic-merge cron). Reserved for an ADR-088b/c fold-in once ADR-090 + ADR-091 are accepted.
- **Submodule per-member merging** — gated on ADR-082 OQ4 outcome (per-member submodule worktrees). If the demo-Wed sopx submodule collision surfaced, that ADR fires first; submodule fan-in then composes on top of this ADR.

## Resolved open questions

ADR-082 OQ3 + ADR-084 OQ-3 resolved here. Each captured via `atmux decisions add` for driver override visibility (see commit body).

| OQ | Resolution | Reversibility | Rationale |
|---|---|---|---|
| ADR-082 OQ3 commit-batching | Members are their own committers in worktree-isolated teams; gitter-relay pattern is shared-cwd-only | medium | Structurally clean; matches `feedback_atmux_no_gitter_worker_commits.md`. Override = re-introduce gitter for isolated teams (would re-introduce the race the worktrees eliminated). |
| ADR-084 OQ-3 gitter alignment | No gitter in worktree-isolated teams; `merger` role replaces it for fan-in only | medium | Different responsibility (commit-per-Task vs branch-merge); different cadence (Task-level vs cycle-level). Override = collapse into one role (would mix per-Task commit-policy with branch-merge-policy). |

Three new OQs introduced by this ADR's design; recommended defaults below:

- **OQ-1 reviewer gate on fan-in** — should the merger refuse `merge-member` if reviewer hasn't approved every commit in `<base>-<m>`? **Default: no** (commits already gated at land-time by per-commit reviewer pass; per-branch re-gate is double-work). Override via decisions log when reviewer-gated merge becomes a sopx demo requirement.
- **OQ-2 conflict retry** — should `merge-cycle` retry conflicted branches on the next cycle with `--strategy theirs` or similar? **Default: no** (conflict = semantic, not transient; needs human triage). Override = adds an automated-resolution flag with a much longer rationale.
- **OQ-3 push cadence** — should the merger push `<base>` after each per-member merge, or batch + push at end of cycle? **Default: per-merge** (keeps origin in sync; survives merger crash mid-cycle; cheap on a 11-member team). Override to batch-push when network cost becomes meaningful (200+ member teams).

## Consequences

- **One round of edits across `src/abstractions/branch-merge.ts` (new), `src/verbs/merge-member.ts` (new), `src/verbs/merge-cycle.ts` (new), `src/schema/team.ts` (Zod `merger` block), `src/verbs/doctor.ts` (new probe class), `templates/briefs/merger.md` (new), `src/verbs/cron-install.ts` (new template entry).** Estimate: ~400 LOC additions + ~30 LOC modifications + ~180 LOC tests (unit + e2e). Smaller than ADR-082 (~500 LOC) — most of the primitives are git-shell wrappers.
- **Existing teams unaffected by default** — `merger.enabled: false` is the default. atmux-team + sopx-guild opt in by appending `"merger": { "enabled": true }` to `team.json`.
- **atmux-team gets a clean fan-in path** post-W2 — once the verb + merger member land, operator no longer needs to manually merge 11 branches per cycle.
- **`<base>` push policy gates merger** — primary-staging branches (`<product>-staging`) remain operator-manual. Merger refuses + surfaces. Per-dev branches (`geoyws`, `sopx-geoyws-staging`, etc.) auto-push freely.
- **Cron-mode merger does NOT need a Claude Max seat** — saves on agent budget for teams with sub-daily fan-in cadence; trade-off is loss of in-context flag-handling.
- **Doctor surfaces stale fan-in** — `merger-branch-stale` probe makes silent-no-merger configurations visible at `atmux doctor` time.
- **Reversibility — LOW for the policy, HIGH for the implementation**. Switching the policy back to "operator-manual fan-in" is one team.json field flip (`merger.enabled: false`) — the primitive verbs (`merge-member`, `merge-cycle`) remain available for operator one-shot use; only the loop / cron disappears. The "no gitter in isolated teams" rule is the harder lock-in — going back to gitter-relay in isolated teams would re-create the race ADR-082 was filed to prevent.

## Cross-references

- ADR-082 — per-member worktree isolation. ADR-088 resolves ADR-082's deferred OQ3.
- ADR-084 — per-member branch model. ADR-088 resolves ADR-084's deferred OQ-3 (gitter alignment).
- ADR-090 — epic-team shared-cwd lifecycle. Different topology; no member-branch / no fan-in needed inside an epic-team.
- ADR-091 — epic-merge state machine. Different scope (epic → parent merge, not per-member → base merge). ADR-088 may borrow ADR-091's transition-function structure for `merge-cycle`'s state shape.
- ADR-085 — whip-approvals-watcher. Precedent for the reviewer-gate primitive deferred in §Decision-7.
- ADR-028 — main/master PR-only push policy. Composes with §Decision-3 guards.
- `templates/briefs/gitter.md` — referenced and explicitly bounded as "shared-cwd-teams only" by ADR-088 §Decision-1.
- `feedback_atmux_no_gitter_worker_commits.md` — operator-side rule this ADR encodes formally.
- CLAUDE.md "Push Policy" — primary-staging gate composes with merger push-policy.

## Decomposition landing

This ADR is filed standalone; impl decomposed into the following sub-tasks (single-commit per sub-task; reviewer-gated):

| Seq | ID | Lane | Subject | Deps |
|---|---|---|---|---|
| W1 | t-bed51da2 | be | `src/abstractions/branch-merge.ts` + unit tests — `mergeMember(base, wtBranch, repoPath, opts)` primitive | none |
| W2 | t-e7724527 | be | `src/verbs/merge-member.ts` + integration test — verb wiring + push-policy guard | W1, W4 |
| W3 | t-d78127c7 | be | `src/verbs/merge-cycle.ts` — bulk wrapper + `--dry-run` + `--push` | W2 |
| W4 | t-f9f49ded | be | `src/schema/team.ts` Zod — `team.merger.{enabled, baseBranch, stalenessHours}` | none (parallel to W1) |
| W5 | t-ab5e31f6 | docs | `templates/briefs/merger.md` — loop-based merger member brief | W3 |
| W6 | t-81fca58f | be | `src/verbs/doctor.ts` — `merger-fan-in` probe class | W3, W4 |
| W7 | t-2f12839e | be | `src/verbs/cron-install.ts` — `--template merge-cycle` entry | W3 |
| W8 | t-7a7f0825 | test | `tests/e2e/merger-fan-in.test.ts` — fixture team, per-member branches with commits, merge-cycle → all merge clean + conflict surface + doctor probe + stop cleanup | W5, W6, W7 |

`merger.enabled: true` flip on atmux-team's own `team.json` is **gated to a separate W9 dogfood-flip Task post-W8 green** — matches the ADR-082 W6a discipline.

## Out of scope (separate ADRs / Tasks)

- **ADR-082 OQ4 — per-member submodule worktrees** — filed as parking-lot Task `t-d6293c8d` (driver-only, low-priority — surface only if sopx demo retrospective flags submodule-level collisions; re-fire-by date 2026-06-15 if zero triggers).
- **ADR-082 OQ5 — cockpit topology integration with worktrees** — filed as parking-lot Task `t-cea4d3e9` (driver-only, low-priority — revisit if cockpit rebuild surfaces a worktree race within 14 days).
- **ADR-084 OQ-2 — `atmux stop --force --prune-branch` flag** — filed as mechanical follow-up Task `t-3d84f6f2` (be, small; deferred-default per ADR-084 stands; flag is opt-in deletion with unmerged-protection retained).
