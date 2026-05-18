# ADR-090: Epic-team lifecycle — `spawn-epic` / `dissolve-epic` verbs + `TeamEpic` schema + roster preset

**Status**: proposed
**Date**: 2026-05-15
**Driver-ref**: `.atmux/driver-inbox.md` 14:03 MYT 2026-05-13 §Pillar 4 (lines 3054–3069) + §Pillar 3 EPIC-Task linkage (lines 3036–3052) + §Open call #3 (auto-merge gitter ownership, line 3137) + §Open call #5 resolved (EPIC-done definition, line 3140) + §Files modified (line 3088 schema citation).
**Parent Task**: t-e576dd43 (team-of-teams umbrella). **Authored under**: t-6f80c4cb (ADR seq 4/6, DRAFT only).
**Numbering shift**: this ADR is the **+1 shift** of driver-inbox's §ADR-089 epic-team-lifecycle ask, bumped to avoid collision with the live **ADR-086** (atmux-pulse, already shipped). The full shift is `driver-inbox §ADR-086→087 (stop --soft), §ADR-087→088 (submodule init), §ADR-088→089 (hierarchical cockpit), §ADR-089→090 (this), §ADR-090→091 (auto-merge), §ADR-091→092 (cross-team tell-lead)`. Future readers MUST cross-reference using the shifted IDs, not the original driver-inbox numbering.
**Reviewer pre-flag**: `.atmux/reviewer-preflag-ADR089-091.md` §ADR-090 (signed 2026-05-13) — 7 §Decision-anchors folded into §Decision below. Adjacent-class audit: `.atmux/audits/adr-089-091-adjacent-class-2026-05-13.md` §Class 1 (signed 2026-05-13) — 4 additional schema-field recommendations folded into §Decision below. All 11 anchors land as numbered §Decision-anchor lines before the prose.

## Context

### Why this ADR exists now

[ADR-089](089-hierarchical-cockpit.md) ships the recursive `Cockpit.sessions[]` schema + tmux prefix-chain that makes nesting *representable*. ADR-089 deliberately does NOT ship the verbs that create or destroy a nested team — that's this ADR's job. Without a defined `spawn-epic` / `dissolve-epic` pair, the only way to materialise an epic-team is by hand-editing `team.json` + running `git worktree add` + `atmux init` + cron-block-install in sequence. That sequence has ~12 failure modes (worktree pre-exists, branch namespace collision, submodule init partial, cockpit-walk wrong-tmpdir, etc.) — every one of which a human operator would hit before the second epic-team ever spawned.

[ADR-087](087-atmux-stop-soft.md) ships the `--soft` graceful-shutdown primitive + resume manifest. ADR-087 §Consequences explicitly names this ADR as the consumer: *"`src/core/soft-stop.ts` — new module exporting `softStop({team, tmux, atmuxDir, ...})` for re-use by ADR-090 `dissolve-epic`"*. Dissolve-epic is a graceful-stop-plus-prune; the lifecycle wraps soft-stop without reimplementing it.

[ADR-179](179-per-member-branch-fan-in.md) ships the bulk-merge `merger` verb for the **per-member-branch / normal-team** topology. This ADR addresses the **shared-cwd / epic-team** topology — a DIFFERENT fan-in pattern (single epic-branch → parent-base), running on a DIFFERENT scope (one epic-team → its parent). The two fan-in patterns coexist; no contention.

[ADR-091](091-kanban-driven-auto-merge.md) (draft pending, t-4af76f05) ships the kanban-driven auto-merge state machine that fires `git merge --no-ff <epic-branch>` once an epic-team's kanban hits `ready_to_merge`. ADR-091 cites this ADR for the `task.role: "reviewer-trunk-signoff"` marker convention; the two ADRs MUST agree on the marker shape (pre-flag #1 below). ADR-090 ships the marker definition; ADR-091 consumes it.

### What an epic-team looks like

From driver-inbox §Pillar 4:

```
/root/work/ifca/src/sopx-root/                <- parent (unchanged)
  .git/                                         - real git
  .atmux/team.json                             - parent: lead + planners + epic-router
/root/work/ifca/src/sopx-epics/                <- NEW (sibling, per §Decision-anchor #2)
  checkout-flow/                                - git worktree on sopx-geoyws-epic-checkout-flow
    .git → /root/work/ifca/src/sopx-root/.git/worktrees/checkout-flow
    .atmux/team.json                           - epic-team config
    .atmux/state.db                            - epic-team kanban
    apps/*, packages/*                         - submodules (init'd at spawn via ADR-088 primitive)
  reports-v2/
```

Each epic-team is a self-contained atmux project root with its own kanban, its own roster, its own cage (`/tmp/atmux-<parent>/epics/<epicId>/sock` per ADR-089 §Pillar 1), and its own tmux nesting prefix (per ADR-089 §Pillar 2). Members **share one worktree**: they all `cwd` to the epic-team's project root, kanban-pull, commit to the shared branch, push when the epic merges. Pull model is preserved *within* the EPIC. The per-member-branch isolation from ADR-082/084 does NOT apply at epic-team scope (§Decision-anchor #3, the HARD CONFLICT).

### Why the share-the-worktree carve-out matters

The per-member-branch model (ADR-084) was designed for a long-lived team where members work in parallel for weeks. An epic-team is by definition **ephemeral and tightly-scoped** — a single Epic, ≤2 weeks, ≤7 members. Per-member branches inside an EPIC would multiply the fan-in cost: N members × M EPIC merges = N×M trivial merge commits on `<base>-<member>` branches just to reach the EPIC's own base. The shared-worktree approach collapses N to 1 — one branch per EPIC, one merge to parent.

The carve-out is **structurally enforced** (§Decision-anchor #3): `team.epicTeam` set ⇒ `team.worktreeIsolation` MUST be `false`, refused at `loadTeam` if both are set. There is no path that lets an epic-team accidentally inherit per-member-branch isolation.

## Decision

Eleven §Decision-anchor lines first (7 from reviewer pre-flag + 4 from adjacent-class audit), then prose around each subsystem. Anchor references map back to the source documents cited in the ADR header.

> **§Decision-anchor #1** — `task.role: "reviewer-trunk-signoff"` is the canonical marker for the EPIC-done trunk-signoff gate (pre-flag #1). NOT `lane=review` (collides with normal Story-signoff Tasks), NOT subject-string-match (brittle), NOT a separate field (`role` reuses the existing `TeamMember.role` vocabulary at `src/schema/team.ts:50`). [ADR-091](091-kanban-driven-auto-merge.md) §State machine reads this marker verbatim; the two ADRs commit to the same string.
>
> **§Decision-anchor #2** — Epic-team disk layout is **sibling** `<projectRoot>-epics/<epicId>/`, NOT in-tree `<projectRoot>/.atmux/epics/<id>/` (pre-flag #2). In-tree puts a git worktree INSIDE the parent's tree, polluting `git status` + `git ls-files`. Sibling mirrors the existing per-member worktree convention from [ADR-082](082-worktree-isolation-per-member.md) (`.atmux/worktrees/<member>/` was rejected for the same reason; sibling pattern won). Cleanup is atomic via `rm -rf <projectRoot>-epics/`.
>
> **§Decision-anchor #3** — **HARD ARCHITECTURAL CONFLICT with [ADR-084](084-worktree-per-member-branch-model.md)** (pre-flag #3). ADR-084:135–136 states *"Switching back to all-members-on-shared-branch is impossible, structurally locked"* — for normal teams. ADR-090 carves out epic-team scope: `team.epicTeam !== undefined` ⇒ `team.worktreeIsolation` MUST be `false` (or unset). `loadTeam` refuses at parse time if both are set, citing this ADR. The carve-out reverses ADR-084 ONLY for epic-team-shaped teams; normal teams stay locked into per-member-branch isolation.
>
> **§Decision-anchor #4** — Roster override path takes **two flag forms only** (pre-flag #4): `--roster <preset-name>` (resolves to `templates/epic-rosters/<name>.json`) AND `--roster-file <path>` (one-off, absolute or project-relative). `--roster-inline <json>` is **explicitly rejected** — shell-quoting JSON across long-running shells is a foot-gun and the preset/file forms cover both common cases. Both forms validate against the `Team` schema before disk write (`loadTeam` refuses-then-aborts).
>
> **§Decision-anchor #5** — EPIC-done definition (fast-mode default) is *"all child Tasks `done` AND working-tree-clean AND HEAD ahead of `<parent-base>` AND `reviewer-trunk-signoff` Task in `done`"* (driver-inbox L3140 resolved + pre-flag #5). The `reviewer-trunk-signoff` Task DEFINITION explicitly requires: *reviewer verified every code-shipping child Task has paired tests* (per project [CLAUDE.md](../../CLAUDE.md) §Testing Discipline). Otherwise trunk-signoff lands green while test coverage is dark.
>
> **§Decision-anchor #6** — `mergeMode: "pr"` is **schema-accept-but-runtime-noop** in v1 (pre-flag #6 + audit Class 1 §3). Schema accepts both `"auto"` and `"pr"` values. ADR-091's runtime auto-merge only handles `"auto"`; `"pr"` validates but does nothing. Document explicitly so downstream gitter/reviewer authors don't infer pr-mode works. No `gh` CLI dependency introduced for code in this ADR's commit (audit §Class 1 evidence: zero existing `gh` invocations in atmux source pre-this-ADR).
>
> **§Decision-anchor #7** — `atmux stop` on a parent team with **live children** = refuse + list children + require `--force-recursive` to torch the whole tree depth-first (pre-flag #7). Couples to [ADR-087](087-atmux-stop-soft.md) §Decision: `--soft` propagation signals children FIRST, then waits for child sessions to write their own `resume.json` manifests, then handles the parent. Orphan epic-teams (parent's process tree dies, child cage at `/tmp/atmux-<parent>/epics/<id>/sock` survives as PPID=1) are prevented by this refuse-default.
>
> **§Decision-anchor #8** — `epicTeam.prTarget: { remote: string, base: string }` is an **opt-in schema field, REQUIRED when `mergeMode === "pr"`** (audit Class 1 §3). Refuse at `loadTeam` if `mergeMode === "pr"` and `prTarget.base` is missing. `remote` defaults to `"origin"`; `base` has NO default (operator-explicit to prevent silent-wrong-base merges).
>
> **§Decision-anchor #9** — `epicTeam.prAuthorUser: string` is an **opt-in schema field, REQUIRED when `mergeMode === "pr"`** (audit Class 1 §4). Names the `gh` CLI user that owns PR creation; ADR-091's pr-mode runtime (slow-mode, deferred) runs `gh auth switch --user <prAuthorUser>` before `gh pr create`. Refuse at `loadTeam` if `mergeMode === "pr"` and `prAuthorUser` is missing.
>
> **§Decision-anchor #10** — `spawn-epic --merge-mode pr` (or `team.epicTeam.mergeMode === "pr"`) runs **four fail-fast `gh` assertions BEFORE worktree creation** (audit Class 1 §2): (a) `gh auth status -h github.com` non-zero ⇒ refuse; (b) `gh auth status -h github.com --user <prAuthorUser>` non-zero ⇒ refuse; (c) `git -C <parentRoot> remote get-url <prTarget.remote>` failure ⇒ refuse; (d) `gh repo view <org>/<repo>` non-zero ⇒ refuse. Prevents the failure mode where epic boots, fills kanban, then explodes at `ready_to_merge → pr-open` (ADR-091's state-machine transition).
>
> **§Decision-anchor #11** — `gh auth switch` is **process-global** on `~/.config/gh/hosts.yml::active-user` (audit Class 1 §4 mitigation). Concurrent epic-teams creating PRs race on the active-user state. Serialize via a `state.db`-level advisory lock — `cockpit_gh_lock` row in the parent's `state.db`, `BEGIN IMMEDIATE`-acquired on PR-creation-write, released on PR-open-success. This is an ADR-091 runtime concern (mutex implementation lives there); ADR-090 only documents the constraint here so reviewers do not infer it's safe to omit.

### §Schema (additions to existing modules)

**`src/schema/team.ts`** — new `TeamEpic` sub-schema, new top-level `Team.epicTeam?: TeamEpic` field.

```ts
/** ADR-090 §Schema: epic-team config block. When set, the team is an
 *  ephemeral epic-team; `worktreeIsolation` MUST be false (refuse at load
 *  time per §Decision-anchor #3). Members share the team's project root
 *  (no per-member worktree provisioning at start.ts). */
export const TeamEpic = z
  .object({
    /** Parent team name. Cockpit walk uses this to attach the epic-team
     *  cage under the parent's tmpdir at `/tmp/atmux-<parent>/epics/<epicId>/sock`. */
    parent: z.string().min(1),
    /** Parent's `state.db` Epic row id (`e-XXXXXXXX`). Parent reads child's
     *  SQLite directly to render progress; this back-pointer lets a child
     *  surface conflicts/notes back to the right parent EPIC row. */
    parentEpicKanbanId: z.string().min(1),
    /** Parent branch the epic-team will merge into. Used by ADR-091's
     *  auto-merge state machine + `dissolve-epic` cleanup. Example: `"main"`,
     *  `"geoyws"`, `"sopx-geoyws"`. */
    parentBase: z.string().min(1),
    /** Merge mode for ADR-091 auto-merge state machine. `"auto"` runs the
     *  direct merge (default). `"pr"` is schema-accept-but-runtime-noop per
     *  §Decision-anchor #6 — accepted at schema, no-op at runtime in v1. */
    mergeMode: z.enum(["auto", "pr"]).default("auto"),
    /** §Decision-anchor #8: required when `mergeMode === "pr"`. Refuse at
     *  loadTeam if pr-mode is set and `prTarget.base` is missing. */
    prTarget: z
      .object({
        remote: z.string().default("origin"),
        base: z.string().min(1),
      })
      .strict()
      .optional(),
    /** §Decision-anchor #9: required when `mergeMode === "pr"`. The gh CLI
     *  user that owns PR creation. Defaults to the active gh account when
     *  unset (pr-mode runtime resolves at PR-creation time per ADR-091). */
    prAuthorUser: z.string().optional(),
  })
  .strict();
export type TeamEpic = z.infer<typeof TeamEpic>;
```

Cross-field refinements at the `Team`-level `.superRefine`:

1. `team.epicTeam !== undefined && team.worktreeIsolation === true` ⇒ refuse (§Decision-anchor #3).
2. `team.epicTeam?.mergeMode === "pr" && team.epicTeam.prTarget?.base === undefined` ⇒ refuse (§Decision-anchor #8).
3. `team.epicTeam?.mergeMode === "pr" && team.epicTeam.prAuthorUser === undefined` ⇒ refuse (§Decision-anchor #9).

The existing `Team.worktreeInitSubmodules` field (ADR-088 / `src/schema/team.ts:886`) is reused — `spawn-epic` sets it to `true` in the rendered `team.json` so the epic-team's shared worktree gets `git submodule update --init --recursive` at provisioning.

**`src/schema/kanban.ts`** — additions to `KanbanEpic` + `KanbanTask`.

```ts
// In KanbanEpic (currently passthrough at src/schema/kanban.ts:134-151):
//   ↳ Add explicit fields for tooling-friendliness; passthrough preserves forward-compat.
epicTeamName: z.string().nullable().optional(),     // child epic-team's `team.name`
epicTeamRoot: z.string().nullable().optional(),     // absolute path to child's project root
// And the ADR-091 forward-refs (declared here for schema-completeness; ADR-091 wires runtime):
prNumber: z.number().int().nullable().optional(),   // pr-mode (deferred)
prState: z.string().nullable().optional(),          // pr-mode (deferred)
note: z.string().nullable().optional(),             // free-form annotation, e.g. "conflict at <SHA>"

// In KanbanTask (currently passthrough at src/schema/kanban.ts:64-119):
role: z.string().nullable().optional(),             // §Decision-anchor #1: "reviewer-trunk-signoff"
```

Both schemas stay `.passthrough()` per their existing pattern (read-permissive for forward compat). The new fields are explicit so reviewers and tooling can lint on them.

### §Disk layout (per §Decision-anchor #2)

```
<projectRoot>/                                  # parent (unchanged)
  .git/                                          # real git
  .atmux/team.json                              # parent's team config
  .atmux/state.db                               # parent's kanban + EPIC row (with epicTeamName/Root)

<projectRoot>-epics/                            # NEW — sibling, never in-tree
  <epicId>/                                      # one per spawned epic-team
    .git → <projectRoot>/.git/worktrees/<epicId>
    .atmux/team.json                            # epic-team config (TeamEpic block set)
    .atmux/state.db                             # epic-team's own kanban (independent from parent)
    .atmux/sockets/                             # epic-team's UNIX sockets per ADR-032
    <project-tree>                              # source tree at branch <parent-base>-epic-<epicId>
    apps/*, packages/*                          # submodules (init'd at spawn via ADR-088 primitive)
```

Worktree branch is **`<parent-base>-epic-<epicId>`** (e.g. `sopx-geoyws-epic-e-1a2b3c4d`). The branch name is structurally distinct from the per-member-branch namespace (`<base>-<member>` for normal teams) — no collision class exists.

Cage tmpdir at **`/tmp/atmux-<parent>/epics/<epicId>/sock`** (per ADR-089 §Pillar 1). Parent cage cleanup tears down children naturally; `ls /tmp/atmux-<parent>/epics/` gives an at-a-glance view of all live child cages.

### §Roster preset

Ship **`templates/epic-rosters/default.json`** in this ADR's same commit (per project [CLAUDE.md](../../CLAUDE.md) §Docs Discipline — same-commit doc + template updates):

```json
{
  "members": [
    { "name": "lead",     "role": "lead",     "tui": "claude" },
    { "name": "planner",  "role": "planner",  "tui": "claude" },
    { "name": "reviewer", "role": "reviewer", "tui": "claude" },
    { "name": "fe-1",     "role": "member",   "lane": "fe", "tui": "claude" },
    { "name": "fe-2",     "role": "member",   "lane": "fe", "tui": "claude" },
    { "name": "be-1",     "role": "member",   "lane": "be", "tui": "claude" },
    { "name": "be-2",     "role": "member",   "lane": "be", "tui": "claude" }
  ]
}
```

Seven members — matches driver-inbox §Pillar 4. Resolution order at spawn-time (per §Decision-anchor #4):

1. `--roster-file <path>` provided ⇒ load file at path, validate, use.
2. `--roster <preset-name>` provided ⇒ resolve to `templates/epic-rosters/<preset-name>.json`, validate, use.
3. Neither provided ⇒ use `templates/epic-rosters/default.json`.
4. Both provided ⇒ refuse (mutually exclusive).

The loaded roster array MERGES into a synthesised `Team` object (parent's `tmuxTmpdir` is overridden to the nested path; `epicTeam` block is filled in; `worktreeInitSubmodules: true` is set; `worktreeIsolation` is left unset / false). `loadTeam` validates the synthesised object before disk write — any schema violation aborts spawn-epic before the worktree is created.

Operators ship custom presets by dropping `<name>.json` files into `templates/epic-rosters/` and referencing them by preset name.

### §`spawn-epic` verb

```
atmux team spawn-epic <epicId> --from <parentTeamName> [--roster <preset>] [--roster-file <path>]
                               [--merge-mode auto|pr] [--pr-base <branch>] [--pr-user <ghUser>]
                               [--parent-epic-kanban-id <eid>] [--no-cron-install]
```

Pipeline:

1. **Resolve parent.** Read `<parentTeamName>`'s `team.json` from the cockpit registry (per ADR-089 `loadCockpit`). Refuse if parent team not found.
2. **Resolve / validate roster** (§Decision-anchor #4 + §Roster preset above).
3. **Resolve / validate Epic-row.** `--parent-epic-kanban-id` (or auto-generate if absent) must reference an existing parent-kanban EPIC row in `open` or `in_progress` state. Refuse if the row already has `epicTeamName` set (epic already spawned).
4. **Fail-fast `gh` assertions** when `mergeMode === "pr"` (§Decision-anchor #10): all four assertions run BEFORE any disk mutation. First failure aborts.
5. **Compute paths.** `epicRoot = <projectRoot>-epics/<epicId>` (§Decision-anchor #2). `branchName = <parent-base>-epic-<epicId>`. `cageTmpdir = /tmp/atmux-<parent>/epics/<epicId>` (per ADR-089).
6. **Provision worktree.** `provisionWorktree({ projectRoot: <parentRoot>, wtRoot: <projectRoot>-epics, wtPath: <epicRoot>, wtBranch: <branchName>, initSubmodules: true })` — reuses ADR-082/088 primitive verbatim. No new worktree code.
7. **Synthesise + write `<epicRoot>/.atmux/team.json`.** Roster members + `name: <epicId>` + `epicTeam: { parent, parentEpicKanbanId, parentBase, mergeMode, prTarget?, prAuthorUser? }` + `worktreeInitSubmodules: true` + `worktreeIsolation: false`. Validate via `loadTeam` BEFORE write — refuse on any cross-field violation.
8. **Init child state.db.** `<epicRoot>/.atmux/state.db` created empty; schema applied via the same migration path used by `atmux init`.
9. **Update parent's `state.db` Epic row.** Set `epicTeamName = <epicId>`, `epicTeamRoot = <epicRoot>` via a `BEGIN IMMEDIATE; UPDATE ...; COMMIT;` (single-tx write; race-free against parent's whip).
10. **Register child cockpit entry.** Append a `{ type: "epic-team", name: <epicId>, parent: <parentTeamName> }` session to the parent's `cockpit.json::sessions[]` per ADR-089 schema. `atmux cockpit rebuild` is responsible for spawning the child cage on next walk (operator-driven), OR if `--no-cron-install` is omitted (the default) spawn-epic fires `atmux cockpit rebuild` itself as the final step.
11. **Cron-block install** (skipped iff `--no-cron-install` set). Standard per-team cron block installed in the operator's crontab under the marker `# >>> atmux:team=<epicId>` (per existing `atmux start` discipline).

Exit on success: print `epic-team spawned: <epicId> at <epicRoot> (parent=<parentTeamName>, branch=<branchName>)`. Cockpit can be attached via `atmux cockpit attach` → drill into child via the nested-prefix chain.

### §`dissolve-epic` verb

```
atmux team dissolve-epic <epicId> [--auto] [--skip-checks] [--force-recursive]
```

Pipeline (default — `--auto` is the same path; `--skip-checks` skips step 2; `--force-recursive` documented under §ADR-087-coupling below):

1. **Resolve epic-team.** Read `<epicRoot>/.atmux/team.json`. Refuse if `team.epicTeam` is unset (the team isn't an epic-team).
2. **EPIC-done check** (skipped iff `--skip-checks` — emergency-only flag, surfaced loudly in logs). Verify in order: (a) all child Tasks `status === "done"`, (b) child worktree is clean (`git -C <epicRoot> status --porcelain` empty), (c) child HEAD is ahead of `<parentBase>` (`git -C <epicRoot> rev-list --count <parentBase>..HEAD` > 0), (d) a Task with `role: "reviewer-trunk-signoff"` exists in `done` state (§Decision-anchor #1 + #5). Any failure ⇒ refuse + print the failing gate. `--skip-checks` bypasses all four; logs the bypass + the operator who invoked it (via `ATMUX_CALLER_SCOPE`).
3. **Trunk-merge gate** (operator's choice; defaults to the runtime hook from ADR-091). `dissolve-epic` itself does NOT run `git merge` — that's ADR-091's state machine. Two paths:
   - **`--auto` invoked from the ADR-091 cron** (after `merging → merged` transition succeeds): trunk-merge already happened; dissolve is the cleanup. Proceed to step 4.
   - **Operator-direct invocation** (no `--auto`): refuse if the Epic row in parent's `state.db` is not in `merged` state. Operator must run the merge first (or wait for ADR-091's cron). `--skip-checks` ALSO bypasses this gate; the operator owns the consequences.
4. **Soft-stop the epic-team.** Reuse ADR-087's `softStop({...})` core (per ADR-087 §Consequences). Members get the soft-stop notice → grace window → state/resume.json manifest with `reason: "dissolve-epic"` (per ADR-087 schema, line 102) → tmux session killed.
5. **Prune worktree.** `pruneWorktree(<epicRoot>)` (reuses ADR-082 §Cleanup primitive). Removes the worktree directory, the `.git/worktrees/<epicId>` admin file, and the branch `<branchName>` IFF the branch is fully merged into `<parentBase>` (`git branch -d` semantics, not `-D` — refuses unmerged branches as a safety net for `--skip-checks` misuse).
6. **GC cage tmpdir.** `rm -rf /tmp/atmux-<parent>/epics/<epicId>` (per ADR-089's cleanup discipline). Skipped if the directory was already gone (idempotent).
7. **Update parent's `state.db`.** Set Epic row status `merged → dissolved` (ADR-091's terminal transition, per ADR-091 pre-flag #6). Single-tx write. `epicTeamName` + `epicTeamRoot` cleared to `null`.
8. **Remove cockpit entry.** Remove the child's session from parent `cockpit.json::sessions[]`. Cron-block uninstall via the existing `atmux stop` cron-removal path.

Exit on success: print `epic-team dissolved: <epicId> (parent=<parentTeamName>, merged into <parentBase>)`. The parent's `atmux status` shows the EPIC row in `dissolved` state.

### §Shared-worktree semantics (per §Decision-anchor #3 + driver-inbox §Pillar 4)

`src/verbs/start.ts:485–500` (the per-member worktree provisioning loop) **SKIPS** when `team.epicTeam` is set. Every member spawns with `cwd = <epicRoot>` (the epic-team's project root). The pull model is preserved at the kanban layer — members `atmux claim --next` from the epic-team's `state.db`; commits land on the shared `<branchName>` branch; the gitter member runs the per-Task commit cycle as usual.

Cross-cite per §Decision-anchor #3: this carve-out exists exclusively for `team.epicTeam !== undefined`. Normal teams stay locked into per-member-branch isolation per ADR-084. The carve-out is enforced at three layers:

1. **Schema** — `loadTeam` refuses both-set (§Schema cross-field refinement #1).
2. **start.ts** — when `team.epicTeam` is set, the worktree-provisioning loop short-circuits before per-member-branch derivation; members' `cwd` is the team's root.
3. **doctor.ts** — extend D-something probe (impl Task) to flag a `team.json` that sets BOTH (defence-in-depth for hand-edited configs that bypass `loadTeam` somehow).

### §EPIC-done definition (per §Decision-anchor #5 + driver-inbox §Open call #5)

Fast mode (default, `mergeMode === "auto"`):

```
EPIC.status = "done" ⇔
    ALL child Tasks (in epic-team's state.db) have status="done"
  AND `git -C <epicRoot> status --porcelain` returns empty
  AND `git -C <epicRoot> rev-list --count <parentBase>..HEAD` > 0
  AND EXISTS Task t IN epic-team's state.db SUCH THAT t.role="reviewer-trunk-signoff" AND t.status="done"
```

The `reviewer-trunk-signoff` Task is filed by the reviewer ONLY AFTER they verify (a) every code-shipping child Task has paired tests OR same-commit tests landed (per project CLAUDE.md §Testing Discipline: *"Reviewer blocks code without tests on tracked paths"*), and (b) the commit-cadence gate from [ADR-148](148-commit-cadence-truth-signal.md) shows the epic-team shipping (not pane-alive-but-dormant). The reviewer's Task body MUST cite the test-coverage check explicitly so that the gate is auditable; a `role: "reviewer-trunk-signoff"` Task with no test-citation in the body is a reviewer-flag failure mode in its own right.

Slow mode (`mergeMode === "pr"`, deferred per §Decision-anchor #6):

```
EPIC.status = "done" ⇔
    PR <prNumber> on <prTarget.remote>/<prTarget.base> has been merged externally
```

Slow-mode runtime impl is deferred to a future ADR. Schema accepts the mode (§Decision-anchor #6); runtime in v1 is a no-op. The four `gh` fail-fast assertions (§Decision-anchor #10) still fire at `spawn-epic` time when `mergeMode === "pr"` so that schema-accept is structurally honest — an operator who sets pr-mode and lacks the gh CLI gets a refuse at spawn, not at the eventual auto-merge transition (which would happen hours/days later).

Lead override remains: `atmux team dissolve-epic --skip-checks` for emergencies (driver-inbox L3142). The override does NOT flip the EPIC's `state` to `done` if the gates are unmet — it ONLY bypasses the dissolve-epic refuse-gate. The Epic row in parent's `state.db` stays in whatever state it was (typically `conflict` or `in_progress`), the worktree is pruned, and the operator owns the consequences. `--skip-checks` always logs to the parent's `lead-outbox.md` so the next planner-near triages the bypass.

### §`gitter` extension (per driver-inbox §Open call #3, resolved: epic-team-scoped)

Each epic-team's roster MAY include a `gitter` member (default roster does not — operators add one for high-commit-frequency epics). The gitter member operates EXCLUSIVELY within the epic-team's cage:

1. Commits child Tasks per the standing gitter pattern ([ADR-145](145-atmux-adopts-gitter.md)).
2. Pushes to `<branchName>` on `origin` per the standing push policy (`<dev>-staging` shape — auto-push allowed; see CLAUDE.md §Push Policy).
3. Does NOT run the trunk-merge — that's ADR-091's auto-merge state machine (cron + `core/epic-merge.ts`). The gitter never invokes `git merge --no-ff` against `<parentBase>`; the state machine owns that op.
4. PR-body authorship (slow-mode, deferred): when ADR-091's pr-mode runtime ships, the gitter composes the PR body from the epic-team's Story summaries + cumulative diff stats. Re-uses the gitter brief's existing gh-pr-create primitive (`templates/briefs/gitter.md:287` already names the escape hatch). No new role needed.

Parent-team's gitter is **out of scope** of epic-team auto-merge. The parent gitter only receives merge-result notifications (via ADR-091's tell-lead surface to parent's planner-near, then onward via parent's standing gitter dispatch). Cross-team commits are not the parent gitter's job.

### §Concurrency (per §Decision-anchor #11 + ADR-091 forward-ref)

Two concurrency surfaces this ADR introduces:

1. **Multiple epic-teams under the same parent.** Independent — each has its own cage tmpdir, its own state.db, its own cron block, its own worktree. No shared mutable state at the parent level except the parent's `state.db` Epic rows (one per child epic-team). Writes to parent's `state.db` are single-tx (`BEGIN IMMEDIATE`) per §`spawn-epic` step 9 + §`dissolve-epic` step 7.
2. **Concurrent `gh auth switch` across epic-teams in pr-mode** (slow-mode runtime, deferred to ADR-091). Process-global on `~/.config/gh/hosts.yml::active-user`; serialize via `cockpit_gh_lock` advisory row in parent's `state.db` (§Decision-anchor #11). ADR-090 documents the constraint; ADR-091 implements the mutex acquire/release. v1 ships pr-mode as schema-accept-runtime-noop, so the lock is dormant in v1 — but the schema field is reserved here for future use.

### §ADR-087 coupling (per §Decision-anchor #7 + ADR-087 §Consequences)

`atmux stop` on a **parent team with live children** refuses by default. Behaviour matrix:

| Parent state | Children | `atmux stop` | `atmux stop --soft` | `atmux stop --force-recursive` |
|---|---|---|---|---|
| Live, no children | n/a | proceeds (bare stop, today's semantics) | proceeds (soft-stop, ADR-087) | n/a (no children to recurse) |
| Live, has children | live | **refuses** + lists children + suggests `--force-recursive` or per-child `dissolve-epic` | **soft-recursive**: signals children FIRST, waits for child resume manifests, then handles parent (ADR-087 propagation) | **bare-recursive**: kills children first (depth-first), then parent (today's semantics, applied tree-wide) |
| Live, has children | dissolved | proceeds — orphan cockpit-entries (`epicTeamName !== null` but child team absent) cleaned up during stop | proceeds — resume.json reflects the surviving child set (empty if all dissolved) | proceeds — same as bare |

`--force-recursive` is the destructive recursive-stop opt-in. Per [CLAUDE.md global §Hooks, Commits, Tooling]: destructive flags require explicit operator authorization; the verb refuses by default and prints the per-child cage tmpdir list so the operator can dissolve-epic each one before stopping the parent gracefully.

Orphan epic-teams (parent's process tree dies, child cage at `/tmp/atmux-<parent>/epics/<id>/sock` survives as PPID=1) are prevented by this refuse-default. A child cage that survives an external `kill -9` of the parent's tmux server is detectable via `atmux doctor` (impl Task in §Out-of-scope below): scan `/tmp/atmux-*/epics/*/sock` and compare against live parent cages; orphan child = `doctor` anomaly row.

### §Adjacent class — driver scope across cage boundaries (per ADR-089 §Adjacent-class)

Epic-team's driver pane is a **sub-driver** — `ATMUX_CALLER_SCOPE=driver` in the epic-team's cage authorises driver-scoped operations within that cage only (claim, dispatch, stop --soft of the epic-team itself). It does NOT authorise parent-scoped operations (cannot `atmux stop` the parent, cannot `atmux cockpit rebuild`, cannot `tell-lead --team <grandparent>` if a grandparent exists). Cage-entry resets inherited `ATMUX_CALLER_SCOPE` to ensure no parent-scope authority leaks via env into a child cage (ADR-089 pre-flag #6 carve-out applies verbatim).

This is documented here for completeness — runtime enforcement lives in [ADR-092](092-cross-team-tell-lead.md) (forward-ref) which ships the caller-scope-gate verb implementation.

## Consequences

### Lanes affected

- **schema** — new `TeamEpic` (`src/schema/team.ts`), new `Team.epicTeam` optional field, cross-field refinement at the `Team` schema level, new `KanbanEpic.epicTeamName/epicTeamRoot/prNumber/prState/note` explicit fields, new `KanbanTask.role` explicit field. All additive; no breaking change to existing teams (every new field is `optional()`).
- **be (verbs)** — two new verbs (`src/verbs/team/spawn-epic.ts`, `src/verbs/team/dissolve-epic.ts`), `src/cli.ts` registration. Reuses `provisionWorktree`, `pruneWorktree`, `loadTeam`, `loadCockpit`, `softStop` (ADR-087); no new abstractions introduced.
- **be (start.ts)** — `src/verbs/start.ts:485–500` short-circuit for `team.epicTeam !== undefined` (skip per-member worktree loop; cwd to team root). ~10-line edit.
- **be (doctor.ts)** — new probe: flag `team.json` with both `epicTeam` set AND `worktreeIsolation === true` (defence-in-depth for hand-edited configs). New probe: scan `/tmp/atmux-*/epics/*/sock` for orphan child cages without live parent. ~20-line edit.
- **ops (cron-install)** — re-uses existing per-team cron-block install via `atmux start` (no new code; `spawn-epic` calls the existing path).
- **fe (briefs)** — new `templates/briefs/epic-lead.md` (epic-team-scoped lead variant — pull-model preserved, shared-worktree explained). Reuses standing planner/reviewer/member briefs verbatim — they work at any team scope.
- **fe (templates)** — new `templates/epic-rosters/default.json` (seven-member preset).
- **docs** — same-commit ADR-090 markdown (this file), references from `docs/PRD.md` §Epic-team lifecycle (impl Task) + `docs/RUNBOOK-cockpit.md` §Spawning an epic-team (impl Task) — same-commit-with-impl rule per project CLAUDE.md §Docs Discipline.

### Reuse statement (per driver-inbox §Reused primitives)

This ADR ships **zero new abstractions**. Every primitive is already on disk:

- `provisionWorktree`, `pruneWorktree`, `sanitizeBranchSegment` — `src/abstractions/worktree.ts:70–342` (ADR-082 + ADR-088).
- `softStop` — `src/core/soft-stop.ts` (ADR-087 §Consequences).
- Per-team isolation (state.db, sockets, driver-inbox, whip cron) — Phase 1 / ADR-018 / ADR-076.
- `loadTeam`, `loadCockpit`, schema discipline — `src/core/team.ts` + ADR-054.
- `gitter` pattern — extend to epic-team scope by configuring an epic-team's roster to include a gitter member.

### What breaks (nothing in v1)

Every change is additive. Existing `team.json` files (with no `epicTeam` block) parse and behave identically. Existing `cockpit.json` files without recursive `sessions[]` continue via ADR-089's migration shim. The `--force-recursive` refuse-default on `atmux stop` is a NEW gate — operators who today run `atmux stop <parent>` against a parent-with-children team will hit the refuse and need to either `dissolve-epic` each child or pass `--force-recursive`. This is a deliberate breaking change at the operator-CLI layer; the failure mode it prevents (orphan child cages) is worse than the friction it introduces.

### Rollback path

Backward-compat is structural: every new field is `.optional()` and every new verb is additive. Rollback = uninstall the binary that ships these verbs; existing teams continue running on the prior binary unchanged. The `task.role: "reviewer-trunk-signoff"` marker is a `KanbanTask` annotation — Tasks without it parse fine; only ADR-091's auto-merge state machine reads the field. No data migration required either direction.

## Open questions

**None outstanding** — all 7 reviewer pre-flag anchors + all 4 adjacent-class audit recommendations are folded into §Decision above. Carve-out:

- **Class 3 multi-epic resource contention** (audit §Class 3, line 162): structurally pre-ship-unauditable. Post-dogfood Task seed in audit §Class 3; planner files the seed Task after `spawn-epic` ships green (T8 dogfood gate, separate impl Task tracked in this ADR's sibling decomp; deferred per audit carve-out).
- **GH Actions cross-account secret-scoping under pr-mode** (audit Class 1 §6): slow-mode wire-up only; documented in §Out-of-scope below. Re-surfaces when ADR-091's pr-mode runtime is implemented.

## Out of scope

- **Auto-merge state machine** — ADR-091 (`docs/adr/091-kanban-driven-auto-merge.md`, draft pending). All transitions (`open → in_progress → ready_to_merge → merging → merged → dissolved | conflict`) live there. ADR-090 ships the schema fields the state machine reads (`KanbanEpic.epicTeamName/Root`, `KanbanTask.role`, `TeamEpic.mergeMode`) and the verbs that surround it (`spawn-epic` boots an epic into `in_progress`; `dissolve-epic` consumes the `merged` state and writes `dissolved`).
- **Cross-team `tell-lead` routing** — ADR-092. The `tell-lead --team <name>` flag and the caller-scope-gate live there.
- **PR-mode runtime impl** — schema-accepted in this ADR (§Decision-anchor #6 + #8 + #9 + #10 + #11); runtime impl deferred to future ADR. The four `gh` fail-fast checks at `spawn-epic` time DO ship in v1 — they refuse early so pr-mode-set teams don't boot into a broken state.
- **GH Actions secret-scoping under pr-mode** — slow-mode wire-up only (audit Class 1 §6). Document in pr-mode-runtime ADR.
- **Class 3 multi-epic stress test** — post-dogfood Task per audit §Class 3 carve-out.
- **`atmux doctor` D9 prefix-level consistency check** — ADR-092 territory (per driver-inbox L3097 `doctor.ts:910-980 D9`).
- **Adjacent-class audit Task** — already filed as t-cc4c5fd9 (complete; this ADR consumes its findings).
- **Impl Tasks** — this ADR is a single design-doc commit. Sub-tasks are filed in the same session per [[feedback_decomp_same_session_with_deps]] in a sibling commit (see §Decomp below).

## Cross-references

- [ADR-018](018-per-team-tmuxdir.md) — per-team tmpdir; nesting under `/tmp/atmux-<parent>/epics/<epicId>/sock` re-uses this primitive.
- [ADR-032](032-socket-pubsub-messaging-layer.md) — socket-pubsub propagation; each epic-team gets its own sockets directory.
- [ADR-076](076-sqlite-everywhere.md) — state.db is canonical; each epic-team has its own.
- [ADR-082](082-worktree-isolation-per-member.md) — per-member worktree primitive (reused; HARD CONFLICT carve-out per §Decision-anchor #3).
- [ADR-084](084-worktree-per-member-branch-model.md) — per-member-branch model (HARD CONFLICT carve-out per §Decision-anchor #3).
- [ADR-087](087-atmux-stop-soft.md) — `soft-stop` primitive (consumed by `dissolve-epic` per §`dissolve-epic` step 4).
- [ADR-088](088-worktree-submodule-init.md) — `initSubmodules` primitive (consumed by `spawn-epic` step 6). *(Link target corrected 2026-05-18 via t-88da6978 — previously misrouted to `088-per-member-branch-fan-in.md`, which never contained the `initSubmodules` primitive; that ADR is now ADR-179 per the collision resolution noted below.)*
- [ADR-179](179-per-member-branch-fan-in.md) — per-member-branch fan-in (`<base>-<member>` → `<base>` merger); pre-existing collision with `088-worktree-submodule-init.md` resolved 2026-05-18 via t-88da6978 (renumbered → ADR-179, mirroring the sibling t-fe51cf64 resolution that moved whip-velocity-gate from ADR-087 to ADR-177 the same day). Both 087 + 088 collisions now closed; the project once again has a single ADR per number per CLAUDE.md §Docs Discipline "Single ADR tree per project".
- [ADR-089](089-hierarchical-cockpit.md) — recursive `Cockpit.sessions[]` + tmux prefix chain (consumed by `spawn-epic` step 10).
- [ADR-091](091-kanban-driven-auto-merge.md) — auto-merge state machine (consumes `TeamEpic.mergeMode` + `KanbanTask.role` + `KanbanEpic.epicTeamName/Root`); forward-ref pending t-4af76f05 ship.
- [ADR-092](092-cross-team-tell-lead.md) — cross-team tell-lead + caller-scope gate; forward-ref.
- [ADR-145](145-atmux-adopts-gitter.md) — gitter pattern (epic-team's gitter operates same way at smaller scope).
- [ADR-148](148-commit-cadence-truth-signal.md) — commit-cadence as the ground-truth signal; reviewer's trunk-signoff Task references this for the epic-team's velocity check.
- Driver-inbox 14:03 MYT 2026-05-13 §Pillar 4 + §Open call #3 + §Open call #5 (resolved).
- `.atmux/reviewer-preflag-ADR089-091.md` §ADR-090 (7 anchors).
- `.atmux/audits/adr-089-091-adjacent-class-2026-05-13.md` §Class 1 (4 schema-field recs) + §Class 3 carve-out.
- Project [CLAUDE.md](../../CLAUDE.md) §Testing Discipline (trunk-signoff test-coverage gate per §Decision-anchor #5) + §Docs Discipline (same-commit doc updates) + §Push Policy (epic-team's `<base>-epic-<epicId>` branches fall under `<dev>-staging` shape — auto-push allowed).
