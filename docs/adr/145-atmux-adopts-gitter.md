# ADR-145: atmux team adopts gitter — supersedes "workers commit + push own work" pattern

**Status**: Proposed
**Date**: 2026-05-14
**Author**: atmux team (planner / t-bcdd43f0)
**Driver-ref**: 2026-05-14 16:40 MYT cockpit driver — three back-to-back messages: *"or get gitter to merge"* / *"gitter should be merging not the lead"* / *"make this the case in atmux as a policy"*. Followed by 16:38 MYT P1 FAN-OUT context where 5 outstanding trunk-merges were sitting un-coordinated.
**Supersedes (operator policy)**: `feedback_atmux_no_gitter_worker_commits` memory — atmux's prior "workers commit + push own work; lead handles trunk merges manually" stance is reversed.

## Context

### What was the prior policy

`feedback_atmux_no_gitter_worker_commits` (prior memory): the atmux team intentionally did NOT spawn a gitter member. Rationale at the time: gitter pattern was for shared-cwd teams where the per-Task commit relay solved the race-staging problem; atmux is worktree-isolated (per [ADR-082](082-worktree-isolation-per-member.md) + [ADR-084](084-worktree-per-member-branch-model.md)), so members already commit + push their own per-Task work cleanly on their own branches. Adding a gitter would have been redundant for the per-Task commit case.

That reasoning was correct **for per-Task commits**. It missed **trunk merges**.

### The gap — trunk-merge coordination

Per-member branches isolate authoring but require periodic merge-back to the team's base branch (`geoyws`). Today that work falls to:

- Operator (manual `git checkout geoyws && git merge --no-ff geoyws-<member>` rounds)
- Lead (when operator asks lead to coordinate a fan-in pass)
- Whichever member happens to claim a "trunk merge" Task

This is the queue-drain bottleneck operator flagged. With 11 active members shipping commits in parallel, the trunk merges need to land continuously. Without a single owner, every round-N trunk-merge becomes a coordination event: lead has to dispatch it, members have to take time off lane work to do it, and the merge-time conflict resolution costs more when it accumulates.

### What already exists (don't re-design)

- **`templates/briefs/gitter.md`** — gitter brief v2 (~11kb). gitter is the ONLY member who commits + handles `merge s-xxx` Tasks from reviewer-advanced Stories + path-restricted commits + Co-Authored-By trailer composition. Already covers the merge-class Task shape.
- **[ADR-134](134-in-team-auto-merger.md)** — in-team auto-merger via expanded gitter role. Specifies `team.json::autoMerge` config, 10-state machine, socket-pubsub triggers + cron backstop, 3-way conflict surface. The mechanism exists.
- **[ADR-091](091-)** (when shipped) — epic-team auto-merge state machine (sibling pattern at higher nesting level).
- **gitter is first-class** role in atmux schemas: `role: "gitter"` is recognized; `defaultEmojiForRole("gitter")` returns `🌿`; `emojiPoolForRole` exists; `templates/briefs/gitter.md` is loadable.

ADR-145 is a **policy decision + team.json change**, NOT a new architecture. The architecture shipped in ADR-134.

### The 2026-05-14 operator pivot

Operator's framing: *"gitter should be merging not the lead"*. The merge work doesn't belong to lead (lead is a thin relay per [[feedback_lead_thin_relay]]); it doesn't belong to members (members focus on lane work); it belongs to a dedicated single-owner role. That role exists in atmux already (`gitter`), but atmux-team itself wasn't using it.

The reversal: atmux-team adopts the gitter pattern. The policy change is captured by this ADR; the schema change lands in the same commit (gitter member entry in `.atmux/team.json`); the spawn integration is a separate T2 Task (operator-driver fires `atmux start` or `atmux team add-member gitter` to bring the pane up).

## Decision

### (D1) atmux-team spawns a `gitter` member

Add a `gitter` member entry to `.atmux/team.json::members[]` in the same commit as this ADR. Shape (per existing schema; matches other role-class members):

```json
{
  "name": "gitter",
  "role": "gitter",
  "lane": "misc",
  "tui": "claude",
  "model": "default",
  "cwd": "/root/work/src/atmux",
  "emoji": "🌿",
  "claudeAccount": "personal"
}
```

**Emoji rationale**: `🌿` is the canonical pick from `defaultEmojiForRole("gitter")` per `src/core/common.ts::ROLE_EMOJI_POOLS["gitter"]` (first entry of `["🌿", "📝", "🗃️", "🪢", "🧵"]`). No emoji drift.

**Lane = `misc`**: gitter is fleet-spanning; no per-lane affinity. Matches `docs` role's `lane: "misc"` convention.

**`claudeAccount: "personal"`**: matches the rest of the atmux team's account binding.

### (D2) Gitter owns ALL merges in atmux — single-owner model

Three merge-classes; gitter owns all of them:

| Merge class | Source | Target | Trigger |
|---|---|---|---|
| **Task → commit** | member's worktree staged set | `<base>-<member>` (member's branch) | `atmux task move <id> done` cascade per ADR-007 pull-model + ADR-032 socket-pubsub |
| **Story → done** | reviewer-advanced Story chain | `<base>-<member>` (already-on-member-branch) | reviewer `atmux story advance s-xxx --to merging` cascade |
| **Branch → trunk** (round-N trunk-merge) | `<base>-<member>` (per-member branch) | `<base>` (team trunk, `geoyws` for atmux) | event-driven (socket-pubsub on `task done` per ADR-134 §Triggers) OR cron-backstop (`atmux gitter --sweep` per ADR-134 §Cron backstop) |

**Single-owner rationale**: alternative (split trunk-merge to gitter, leave per-Task commit to members) splits the merge-class boundary. Gitter then owns "branch merges" and members own "Task commits"; same git tooling, two owners; reviewer enforcement gets split between two roles; per-merge race-staging defense surface area doubles. **Operator's framing matches single-owner**: *"gitter should be merging"* — full ownership cleanest.

**For atmux specifically**, this means: members still author code in their per-member worktrees (per ADR-082+084) but **STOP committing**. The path-restricted commit + race-staging defense in `templates/briefs/gitter.md §"Path-restricted commits"` activates for atmux-team commits.

### (D3) Member discipline change — stop committing + stop self-merging trunk

| Action | Before ADR-145 | After ADR-145 |
|---|---|---|
| Author code | Member, in own worktree | Member, in own worktree (unchanged) |
| `git add` after Task done | Member | Member (stages for gitter) |
| `atmux task move <id> done` | Member | Member (cascade fires gitter via ADR-032) |
| Commit + push | Member (per-Task) | **Gitter** (per-Task commit relay per `templates/briefs/gitter.md`) |
| Merge trunk → member branch | Member (self-merge during whip cycles per prior memo) | **Gitter** (gitter pulls each member branch + merges trunk back in, if needed) |
| Merge member branch → trunk | Operator / member / lead, manual | **Gitter** (event-driven + cron-backstop per ADR-134) |

**Whip-cycle change**: each claim cycle's "fetch origin && check if origin/geoyws advanced; if yes self-merge" rule (added by operator 16:38 MYT) **re-shapes to gitter-owned merges**. Members STILL check `git fetch origin && git log HEAD..origin/geoyws` to see if trunk advanced — but the **action** on a positive check is `atmux reply "[member] trunk advanced by N commits; gitter please merge into geoyws-<member>"`, NOT self-merge.

Gitter's loop handles both directions:

1. **Trunk → member-branch (forward-merge for sibling-work pickup)**: when sibling commits land on trunk, gitter merges trunk into each per-member branch so members see siblings' work. Cadence: every cycle gitter checks `origin/geoyws` vs each `<base>-<member>`; merges fast-forward where clean.
2. **Member-branch → trunk (back-merge for fan-in)**: when a member's per-Task work is done and lane is clean, gitter merges `<base>-<member>` into `<base>` (`geoyws`) per ADR-134 §Triggers.

### (D4) `atmux doctor` warn-class — branch-trunk drift

New doctor probe class `gitter-branch-drift` (lands in a follow-up T-task; spec only here):

- **`branch-behind-trunk`** — `<base>-<member>` is N commits behind `origin/geoyws` AND `team.json::autoMerge.enabled === true` AND drift exceeds `gitter.staleness.warnAfterCommits` (default: 10). Surface: yellow warn — gitter has not picked up the forward-merge. Auto-fixable with `--fix` (calls `atmux gitter --sweep` to nudge).
- **`branch-ahead-trunk`** — `<base>-<member>` has N commits ahead of `origin/geoyws` AND no recent successful gitter merge-back (last `merger_state` row >X minutes old). Surface: yellow warn — gitter has not picked up the fan-in. Auto-fixable with `--fix`.

`gitter.staleness` config sub-block of the existing `autoMerge` block (ADR-134 §Config). Defaults shipped in T2 follow-up.

### (D5) Memory reversal

`feedback_atmux_no_gitter_worker_commits` is flagged for supersession by this ADR's commit:

- Memory body updated to **point at ADR-145** as the new policy.
- Status: "policy reversal 2026-05-14 — atmux-team adopts gitter; ADR-145 supersedes; old commit-self pattern no longer applies."
- Memory NOT deleted — preserved as historical context for "why the prior pattern existed + why it was reversed".

Existing project memory `feedback_atmux_no_gitter_worker_commits.md` already carries an in-flight reversal note ("operator adopted gitter-does-merges; ADR-145 pending; UNTIL it lands route TRUNK MERGES via tell-lead, members still commit own per-Task work"). This ADR's landing flips that to "policy now in effect; route ALL merges via gitter".

## Tradeoffs

### One owner vs split ownership

| Choice | Risk shape | Pick? |
|---|---|---|
| Single gitter owns all 3 merge-classes (this ADR) | **Bounded**: gitter is one Claude Max seat + one cage tmux window; gitter brief already exists; single-owner simplifies race-staging defense + reviewer enforcement | ✅ |
| Split: members do per-Task commits, gitter does trunk merges only | **Unbounded coordination cost**: two owners on the same git tooling; race-staging defense splits; reviewer must enforce "is this member's commit clean?" + "is this gitter's trunk merge clean?" separately | ❌ |
| Continue without gitter (status quo prior to 2026-05-14) | **Unbounded operator load**: every round-N trunk merge is a manual operator action; scales poorly past 5 active members; operator-flagged blocker today | ❌ |

### Member context shift

Member's per-Task `atmux task move <id> done` cycle no longer ends with "commit + push". The dispatch cascade (ADR-032 socket-pubsub) wakes gitter; gitter handles the commit + push. Members STAGE files (via `git add`) but DO NOT commit. This is a behavioural change that needs:

- Member brief updates (templates/briefs/lead.md, planner.md, reviewer.md, role-specific briefs) to drop "commit + push" from the loop steps and replace with "stage + mark done".
- T2 follow-up Task: brief-update sweep across `templates/briefs/`. **Out of T1 single-commit scope** — flagged for T2.

Trade-off accepted: members can still **commit + push** when gitter is down (degraded-mode fallback per gitter brief §"degraded-mode"); but the default-path is gitter-routed.

### Cage budget

One additional Claude Max seat (the gitter member). At Opus rates that's ~$15-30/day in steady state. Operator already considered this acceptable per the 2026-05-14 directive — recurring trunk-merge bottleneck cost (operator's time + waiting members) exceeds the gitter cage cost.

## Cross-references

- **[ADR-134](134-in-team-auto-merger.md)** — in-team auto-merger spec. State machine + triggers + 3-way conflict surface + `team.json::autoMerge` config block. **ADR-145 is the policy adoption of ADR-134's architecture for atmux-team specifically.**
- **[ADR-091](091-)** (when shipped) — epic-team auto-merge state machine. Sibling at higher nesting level; gitter pattern composes across nesting levels per ADR-134 §"Why in-team, not cockpit".
- **[ADR-082](082-worktree-isolation-per-member.md) + [ADR-084](084-worktree-per-member-branch-model.md)** — worktree-isolation substrate. atmux-team runs `worktreeIsolation: true` since 2026-05-12 (t-e82c1d11); gitter operates on those per-member branches.
- **[ADR-032](032-socket-pubsub-messaging-layer.md)** — task-done cascade socket-pubsub. Gitter subscribes to atmux-team's own pubsub socket (per ADR-134 §Triggers + §"Reviewer pre-flag" #1 own-team only).
- **[ADR-077](077-superdoctor-cockpit-role.md) + [ADR-133](133-medic-rename.md)** — medic. Medic's authority extends to rotating gitter if it goes wedged (same as any team member).
- **[ADR-132](132-pluggable-martinet.md)** — martinet. Martinet observes gitter's pane like any team-member pane; same nudge / escalation policy.
- **[ADR-007](007-pull-kanban.md)** — pull-model kanban. `atmux task move <id> done` cascade is the upstream trigger for the gitter's commit step.
- **`templates/briefs/gitter.md`** — gitter brief v2 (~11kb). Operative when this gitter member spawns. No edits needed; the brief is policy-neutral about which team's gitter is running it.
- **CLAUDE.md** "Lead is a thin relay" rule — reinforced by this ADR (lead doesn't do trunk merges; gitter does).
- **[[feedback_atmux_no_gitter_worker_commits]]** — superseded by this ADR. Memory body retained as historical context per §D5.
- **[[feedback_lead_thin_relay]]** — alignment principle.

## Open questions

**OQ-1 — Should gitter also handle reviewer-trunk-signoff Story merges (ADR-091 §pre-flag #3 marker)?**

ADR-091's reviewer-trunk-signoff convention (`task.role: "reviewer-trunk-signoff"` marker on a done Task gates `ready_to_merge → merging` transition) applies at epic-team level. For atmux-team's intra-team scope, ADR-134 made the reviewer signoff **optional** (default `requireReviewerSignoff: false`). Should atmux-team flip it to `true`?

**Recommended default**: **keep `false` for v1**; per-commit reviewer pass already gates each commit; per-branch re-gate is double-work for atmux's commit cadence. Revisit if commit-reviewer-pass leaks bugs into trunk.

Driver override via decisions log when concrete demand emerges.

**OQ-2 — Should gitter's claudeAccount differ from team default?**

Currently `claudeAccount: "personal"` matches the rest of atmux-team. Some teams pin gitter to a different account (e.g. budget-isolated; gitter's burn doesn't compete with code-authors for the shared budget window).

**Recommended default**: **same as team (`personal`)** for v1 — keeps account budget unified; simpler operator mental model. Driver can pin gitter to a dedicated account via team.json override if budget-isolation becomes a need (e.g. atmux-team in steady-state).

Driver override via decisions log when budget-isolation surfaces concrete demand.

## Trunk-merge dispatch (amended 2026-05-14, t-f462289a)

ADR-145 §D2 specifies gitter owns all three merge classes (Task→commit, Story→done, branch→trunk). The first two have established Task shapes documented in `templates/briefs/gitter.md`. The **branch→trunk** dispatch shape was not explicitly defined; this section closes the gap.

### Task subject convention

```
merge t-xxx (branch→trunk): geoyws-<member> → trunk
```

- Subject MUST include the literal `(branch→trunk)` marker so gitter's brief switches into trunk-merge mode (vs Story-merge / Task-commit modes).
- `geoyws-<member>` names the source branch (atmux convention; substitute `<base>-<member>` for other teams whose base branch is not `geoyws`).
- `trunk` is symbolic — gitter resolves to the team's current base branch via `git -C <teamRoot> branch --show-current` from the parent worktree (`geoyws` for atmux).

### Task body — required fields

```yaml
source-branch: geoyws-<member>          # full ref, e.g. geoyws-up-impl
target:        trunk                     # symbolic; gitter resolves to <base>
owning-lane:   <member>'s natural lane   # e.g. lifecycle, error-class — for dispatch routing
conflict-hint: <short prose>             # known collision surface (file paths, schemas, ADRs)
```

`conflict-hint` is optional but high-value: when populated, gitter pre-reads the cited files BEFORE attempting the merge so conflict resolution doesn't waste a full merge-abort cycle. Empty hint = clean FF expected.

### Gitter brief addendum

`templates/briefs/gitter.md` §"How work reaches you" gains a fourth Task shape (alongside `commit t-xxx`, `merge s-xxx`, `persist deferred items`):

```
4. merge t-xxx (branch→trunk) — fired when planner files a trunk-merge Task
   against an active per-member branch. Body has source-branch / target /
   owning-lane / conflict-hint fields. Gitter:
     a. Read source Task body — note source-branch + conflict-hint.
     b. Verify base worktree is clean (per ADR-088 §Decision-3 safeguard).
     c. git -C <teamRoot> fetch origin
     d. git -C <teamRoot> checkout <base>
     e. git -C <teamRoot> merge --no-ff <source-branch>
        - On clean merge: push trunk, mark Task done with --note "merged
          <source-branch> at <SHA>"
        - On conflict: read conflict-hint, resolve in-place if straightforward
          (rename/path-only conflicts), OR git merge --abort + atmux flag add
          --severity high + atmux reply "[gitter] conflict on <source-branch>;
          see flag <fid>" to escalate
     f. Push trunk only when merge is clean + reviewer-gated per CLAUDE.md
        Push Policy (geoyws is per-developer-staging shape; auto-push allowed)
```

The brief addendum lands in ADR-145 T2's member-brief sweep (per §Implementation plan T2 follow-up). Until then, gitter operates on the addendum prose from this ADR section directly.

### Dispatch ownership

- **Planner** files the `merge t-xxx (branch→trunk)` Task with all four fields populated.
- **Lead** verifies the field shape + dispatches to gitter (or planner can `atmux dispatch gitter t-xxx` directly when the trunk-merge is part of a planner-coordinated decompose pass — e.g. this Task t-f462289a's 6 trunk-merge filings).
- **Gitter** claims via the auto-dispatch cascade (ADR-032) AND/OR via cron-backstop sweep (per ADR-134 §Cron backstop) — same plumbing as Task→commit dispatch.

### High-leverage convergence pattern (per Part C of t-f462289a)

When multiple trunk-merge candidates collide on the same source files (e.g. 3+ branches all modify `src/schema/cockpit.ts`), filing a **convergence pre-Task** that gitter runs FIRST collapses the merge cost:

```
Subject: cockpit-schema-convergence (pre-trunk-merge reconciliation)
Body: gitter pulls all N colliding branches' versions of <shared-file-list>,
      manually composes the union/superset, pushes as single trunk commit.
      Subsequent per-branch trunk-merges then FF or near-FF.
```

The convergence pre-Task is head-of-queue (deps=[]) + priority 1; the colliding per-branch trunk-merges have `deps=[<convergence-task-id>]` so they only fire after the convergence lands. Non-colliding trunk-merges run in parallel without the dep.

This pattern is documented here for repeat use; planner files it discretionary (when the conflict-hint analysis surfaces ≥3 same-file collisions).

## Implementation plan

This ADR commits the **policy decision + team.json schema change** in a single commit per acceptance gate:

1. New file: `docs/adr/145-atmux-adopts-gitter.md` (this file).
2. Edit: `.atmux/team.json` — append `gitter` member entry to `members[]` array per §D1.

**T2 follow-up** (separate Task, filed in this commit's wake):

- Spawn integration — operator-driver fires `atmux start` (full restart) OR `atmux team add-member gitter` (hot-add) to bring the gitter pane up.
- Once alive, gitter takes over the 5 outstanding trunk-merges flagged at 16:38 MYT P1 FAN-OUT.
- Memory body update on `feedback_atmux_no_gitter_worker_commits.md` to reflect supersession.
- Member-brief sweep — drop "commit + push" steps from members' loop briefs, replace with "stage + mark done" (per §D3 member discipline change).

T2 is filed as a separate task (NOT in this commit's scope) so the policy ADR lands cleanly first.

## Acceptance gates

For ADR-145 single commit specifically (per t-bcdd43f0 §Acceptance):

- [x] `docs/adr/145-atmux-adopts-gitter.md` exists with `Status: Proposed`.
- [x] `.atmux/team.json` gets a `gitter` member entry using `defaultEmojiForRole("gitter") = 🌿` for emoji canonicality.
- [x] Cross-refs to ADR-134, ADR-091, ADR-082+084, ADR-032, gitter.md brief, `feedback_atmux_no_gitter_worker_commits` memory.
- [ ] Single commit; reviewer-gated.

Wider acceptance (T2 follow-up Task) — spawn integration + brief sweep + memory reversal — gates on T2 landing.

## Out of scope

- **Spawn integration** — T2 follow-up Task. This commit only lands the policy + schema; the operator fires `atmux start` (or hot-add) to bring the pane up.
- **Member-brief sweep** — dropping "commit + push" steps from member briefs. T2 follow-up.
- **Memory reversal on `feedback_atmux_no_gitter_worker_commits`** — T2 follow-up; ADR lands first, memory updates in T2 with explicit supersession pointer.
- **Cross-team gitter sharing** — atmux's gitter does NOT serve other teams (sopx, unum). Each team spawns its own gitter; same as the prior multi-team pattern.
- **Gitter cage tier change** — gitter inherits Tier 1 naturally from atmux-team's cage (per ADR-058 / ADR-134 §Cage tier). No new tier carve-out.
- **PR-mode gitter** — schema-accept-but-runtime-noop per ADR-091 pre-flag #8; ADR-145 ships auto-merge mode only.
