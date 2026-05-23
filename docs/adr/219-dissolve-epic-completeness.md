# ADR-219: `dissolve-epic` completeness — cage `kill-server` + merged-branch `-D` + orphan-detection invariant

**Status**: Accepted — ratified by driver 2026-05-23 (impl shipped via Epic e-7a1014f9 + tracked task #8: `killServer` at src/verbs/team/dissolve-epic.ts:526 + branch -D + orphan-detection probe; closes the 8-orphan-cage reap class observed 2026-05-21 21:35-22:05 MYT).
**Date**: 2026-05-22
**Driver-ref**: 2026-05-21 superdoctor reaps (21:35 / 21:48 / 22:05 MYT) — 8 orphan cages across sopx + atmux, ~18GB RAM + 67 claude processes recovered. 4 consecutive `atmux team dissolve-epic --skip-checks` calls reported success but left the cage tmux server alive with 7+ panes and the merged branch undeleted; operator had to hand-run `tmux kill-server` + `git branch -D` to actually complete each teardown. Filed via Epic `e-7a1014f9` (parent task `t-609c1921`, P0, lead-routed 02:34 MYT 2026-05-22).
**Cross-refs**: [ADR-090](090-epic-team-lifecycle.md) §`dissolve-epic` + §Amendment 2026-05-21 (substrate being completed), [ADR-179](179-per-member-branch-fan-in.md) (merged-into-trunk detection — `git merge-base --is-ancestor`), [ADR-077](077-superdoctor-cockpit-role.md) §doctor probes (orphan-detection invariant lands here), [ADR-162](162-atmux-owns-tmux-infrastructure.md) (per-cage tmux socket isolation — cage-kill targets the cage socket, not the cockpit socket), [ADR-087](087-atmux-stop-soft.md) (softStop primitive — preserved as best-effort step 1; kill-server is the load-bearing step 2), [ADR-218](218-auto-fold-in-verb-and-lead-auto-drive.md) (auto-fold-in — calls `dissolve-epic` at end of chain; completeness is its post-condition), [ADR-197](197-cron-reaper-teardown-contract.md) (cron-strip teardown — sibling teardown contract).

Sibling EPICs (same lifecycle-hygiene class):
- `e-46f7fd64` — ADR-218 auto-fold-in (verdict → action; depends on dissolve completeness for clean post-condition).
- `e-13f311f5` — host-wide epic-team cap (accumulation prevention; complements dissolve-completeness from the spawn side).
- `e-db13ac01` — sweep-epics auto-cron + orphan-cron reaper (related crontab hygiene; reaps cron blocks left behind by incomplete dissolves).

## Context

[ADR-090](090-epic-team-lifecycle.md) §`dissolve-epic` ships the verb that tears down an epic-team: pre-flight gates → soft-stop the cage → prune worktree → unregister from parent cockpit → mark parent EPIC done. The 2026-05-21 §Amendment closed an earlier `softStopHook = undefined → step-5 no-op` regression by introducing `defaultCageTeardown` (`src/verbs/team/dissolve-epic.ts:453`), which runs ADR-087 `softStop` then `tmux kill-session "=<sessionName>"` against the cage's own socket.

That amendment shipped (commit `defaultCageTeardown`, 5 unit tests, 16/16 dissolve-epic suite green). It is INCOMPLETE in production. The 2026-05-21 superdoctor sweep documents three classes of residue surviving a successful `dissolve-epic --skip-checks` call:

| Step | ADR-090 §Amendment intent | Observed (2026-05-21 21:35–22:05 MYT) |
|---|---|---|
| Worktree removal (step 6) | gone | ✅ gone |
| Cage tmux teardown (step 5) | `kill-session "=<sessionName>"` reaps the cage server | ❌ cage tmux server stays ALIVE with 7+ windows on `/tmp/atmux-<team>/epics/<eid>/tmux-0/default` |
| Merged-branch delete | not in §Amendment scope | ❌ branch retained on `git branch` after the fan-in had already landed on trunk |
| Orphan-detection warning | not in §Amendment scope | ❌ no `atmux doctor` row; accumulation invisible until host RAM pressure surfaced |

The smoking gun: 4 consecutive `--skip-checks` dissolves on 2026-05-21 22:05 MYT (`e-92b8fa97` / `e-cc3728bf` / `e-b545b70c` / `e-7471f008`) all reported success + all left the cage tmux server alive + all required manual `tmux kill-server` + `git branch -D`. Cumulative cost: ~18GB RAM + 67 claude processes + ~30 min of operator-cycles per the 22:05 lead-queue narrative. The same pattern repeated 3× in one day, so the regression is not load-bearing on `--skip-checks` specifically — `--skip-checks` only bypasses the pre-flight gates (steps 4a + 4b in `dissolve-epic.ts`), not the teardown.

### Why `kill-session` is insufficient

The cage socket at `/tmp/atmux-<team>/epics/<eid>/tmux-0/default` is its own tmux server with potentially MULTIPLE sessions (the cage's primary team session plus any cockpit-spawned viewer sessions per [ADR-162](162-atmux-owns-tmux-infrastructure.md)). `tmux kill-session "=<sessionName>"` only kills the named session; remaining sessions on the same socket keep the tmux server process alive, which keeps the underlying claude TUI panes alive, which keeps the RAM allocated. `tmux kill-server` on the cage's socket is the unconditional reap that nukes every session under the same socket-process — the correct primitive for "this cage is done; reclaim everything."

### Why `git branch -D` belongs in `dissolve-epic`

Dissolution is the natural moment to garbage-collect the branch: the worktree has been pruned (step 6), the cage has been killed (step 5 once this ADR ships), the parent EPIC is being marked done (step 8). Leaving the branch behind only matters if the operator might want to recover work — which is exactly what the merged-into-trunk check resolves. If the branch is an ancestor of trunk (`git merge-base --is-ancestor <branch> <trunk>` per ADR-179 fan-in convention), nothing on the branch isn't already on trunk; deletion is lossless. If unmerged + `--skip-checks` is in play, operator owns the rescue path — skip the delete, log the skip.

### Why orphan-detection invariant matters

Without a doctor probe, the failure mode is silent. The 2026-05-21 accumulation went unnoticed for hours because there is no signal that connects "cage tmux server alive" with "epic-team is supposed to be dissolved." [ADR-077](077-superdoctor-cockpit-role.md) §doctor probes already owns the structural-anomaly surface; this ADR adds one row to that surface — the invariant *cage tmux alive ⇒ `<eid>` rostered in `cockpit.json::sessions`* — so a future regression in the cage-kill site (or a partial dissolve due to a network-partitioned cockpit) shows up as a yellow doctor row instead of an 8-cage / 18GB pile-up.

## Decision

Three fixes ship in ONE commit. The reviewer specifically gates the ORDERING of the cage-kill site (per §D1 below — must NOT inherit the parent-cockpit-missing short-circuit from the viewer-remove path).

### §D1 — Cage `tmux kill-server` as the FINAL teardown step

Replace `tmux.session.killSession("=<sessionName>")` at `src/verbs/team/dissolve-epic.ts:494` with `tmux.server.killServer()` against the resolved cage socket. The dissolve pipeline becomes (changes in **bold**):

1. Resolve caller-scope. Refuse if not driver.
2. Find epic-team in `cockpit.json`. Refuse if absent.
3. Resolve epic root + parent root.
4. Pre-flight gates (skipped under `--skip-checks`).
5. **`defaultCageTeardown`** (reshaped): (5a) ADR-087 `softStop` — best-effort, swallows failures. (5b) **`tmux.server.killServer()` against the cage socket** — load-bearing; idempotent on already-dead server; runs unconditionally after 5a.
6. `pruneWorktree`.
7. **`git branch -D <branch>` if merged-into-trunk check passes** (per §D2 below).
8. Remove epic-team entry from parent `cockpit.json::sessions`.
9. Mark parent EPIC done.
10. **Doctor probe** invariant lands at `atmux doctor` + `atmux cockpit rebuild` (per §D3 below) — runtime check, not a step in the dissolve pipeline.

**Reviewer-gated ordering**: the cage-kill (step 5b) MUST NOT short-circuit on `parent-cockpit-missing`. Today the viewer-remove helper (`removeEpicViewerFromParentCage` in `src/core/cockpit.ts`) emits `parent session 'atmux' not running on /tmp/atmux-atmux/sock — skipping viewer remove` and continues — that's the right behavior for the viewer-remove path (the viewer is on the COCKPIT socket; if cockpit is down, there's nothing to remove). It is the WRONG precedent for cage-kill: cage-kill targets the CAGE socket, which is a separate process; whether the cockpit is up or down has no bearing on whether the cage is up or down. The reviewer must confirm `defaultCageTeardown` derives the cage socket via `resolveCageSocket(teamName, epicRoot)` (the existing SSOT helper at `src/core/cockpit.ts:1030`) and is independent of cockpit-liveness probes.

**Idempotency**: `tmux.server.killServer()` against an already-dead socket throws; wrap in try/catch and treat the throw as the target state. Same pattern as the existing `killSession` swallow at `dissolve-epic.ts:495-498`. The probe at line 467 (`tmux.session.hasSession`) stays as the up-front shortcut — when it returns false, return early (no softStop, no kill-server). When it returns true, run both steps; the `kill-server` swallow covers the case where the session dies between probe and kill.

**Socket resolution**: use the existing `resolveCageSocket(teamName, epicRoot)` helper (per §OQ1 recommendation below — SSOT preserved). Honor `team.json::tmuxTmpdir` override transitively via the helper's existing path-resolution logic. No inline socket-path reconstruction in `defaultCageTeardown`.

### §D2 — `git branch -D <branch>` when merged-into-trunk

After `pruneWorktree` succeeds (step 6), check `git merge-base --is-ancestor <branch> <trunk>` against the parent repo's resolved trunk (`team.json::base` of the parent team, defaulting to `main`). On pass, run `git branch -D <branch>`. On fail:

- **Default path** (`--skip-checks` NOT passed): skip the branch delete + log `dissolve-epic: branch <branch> not merged into <trunk> — skipping delete` + emit a yellow row in the verb output. The dissolve still completes; the branch stays for operator inspection.
- **`--skip-checks` path** (operator-explicit): same behavior. `--skip-checks` is for bypassing the kanban / worktree-clean gates (steps 4a + 4b); it does NOT authorize destructive branch deletion of unmerged work. Operator rescue path is `git branch -D <branch>` manually after they've extracted whatever they want.

**Branch resolution**: the epic-team's branch name follows ADR-090 §spawn-epic convention (`<parentBase>-<epicId>` or the `team.json::base` field of the child team). Read it from the child `team.json::base` (the load already happens at step 5 for the cage teardown — reuse the same `childTeam` object).

**Failure handling on `git branch -D` itself**: warn + continue. If the merged-into-trunk check passed but the delete fails (race against an external git operation, sliced repo, permission glitch), log the failure + proceed to step 8 (cockpit unregister). The branch can be GC'd manually; not blocking the dissolve.

### §D3 — Orphan-detection invariant at `atmux doctor` + `atmux cockpit rebuild`

Add a new probe to [ADR-077](077-superdoctor-cockpit-role.md) §doctor probes + the cockpit-rebuild post-walk:

- **Invariant**: for every cage tmux server alive at `/tmp/atmux-<team>/epics/*/tmux-0/default` (or the team's resolved `tmuxTmpdir`-prefixed path), the corresponding `<eid>` MUST be rostered in `cockpit.json::sessions` under the parent team.
- **On violation**: emit a YELLOW doctor row (not red — operator agency on cleanup timing per §OQ3 below). Row body names the cage socket path + the missing `<eid>` + the hint `tmux -S <socket> kill-server` to manually reap.
- **Implementation**: scan the cage-socket paths under `/tmp/atmux-*/epics/*/tmux-0/default` (or the team-specific tmpdir per `team.json::tmuxTmpdir`); for each alive server (`tmux -S <path> list-sessions` succeeds), look up the parent team in `cockpit.json` + check whether the `<eid>` (derived from the socket path) is in `sessions[]`. If not, emit the row.
- **Cockpit-rebuild integration**: `atmux cockpit rebuild` already iterates the tree; add the same probe inline so a rebuild surfaces orphans alongside its own structural fixes.

This closes the silent-accumulation class. The same invariant would have caught all 8 of the 2026-05-21 orphans before the host RAM pressure surfaced (the first cage went orphan ~13h before the 22:05 sweep; the doctor probe runs hourly via [ADR-077](077-superdoctor-cockpit-role.md) cadence, so the first ping would have hit ~12h earlier).

## Open Questions

### OQ1 — Cage-socket-path derivation: SSOT helper vs inline reconstruction?

**Recommendation: SSOT helper** (`resolveCageSocket` from `src/core/cockpit.ts:1030`). The helper already exists and is used by `defaultCageTeardown` at `dissolve-epic.ts:460`; the doctor probe (§D3) should use it too, and any future cage-tmux callsite should call through it. The alternative — inline-reconstructing `/tmp/atmux-<team>/epics/<eid>/tmux-0/default` at three callsites — was the pattern before `resolveCageSocket` consolidated it, and it is the kind of drift that landed us here (the §Amendment 2026-05-21 `defaultCageTeardown` was correct, but a hand-rolled cage-socket path at a doctor probe would silently miss the `team.json::tmuxTmpdir` override case).

### OQ2 — `git branch -D` failure handling: refuse on local-uncommitted vs warn-skip?

**Recommendation: warn + skip** (operator owns the rescue path). Two cases:
- Merged-into-trunk check passes but `git branch -D` fails (race / glitch): warn + continue + leave the branch for next-time. The dissolve completes regardless; the branch is post-condition residue, not load-bearing.
- Merged-into-trunk check fails (unmerged work on the branch): skip the delete + log the skip. `--skip-checks` does NOT escalate to `git branch -D --force`. The operator who wants to nuke unmerged work runs it themselves; the verb refuses to destroy lossy.

Rejected alternative: refuse the entire dissolve on `git branch -D` failure. Rationale for rejecting: the dissolve has already pruned the worktree + killed the cage at that point (steps 5–6); refusing partway leaves the state half-torn-down, which is worse than leaving the branch behind.

### OQ3 — Doctor probe: warn (yellow) vs error (red)?

**Recommendation: warn (yellow)** — operator agency on cleanup timing. Rationale:
- A live cage with no roster entry is not corruption; it's a leak. The work isn't lost — the cage may still have in-progress claude turns, the worktree may still have uncommitted work the operator wants to inspect.
- Auto-red would tempt an auto-fix in superdoctor, which would race with operator-in-progress recovery (the 2026-05-21 case: operator was *in the middle of* inspecting the e-b545b70c rescue artifacts when the cage was reaped).
- Yellow surfaces the leak + gives the operator the `kill-server` hint without auto-acting. Aligns with [ADR-077](077-superdoctor-cockpit-role.md) §Authority — superdoctor has full authority for structural fixes BUT must not race with operator-in-progress paths; yellow keeps this in the operator-driven cleanup lane, not the autonomous-fix lane.

Rejected alternative: red + auto-`tmux kill-server` from superdoctor. Rationale for rejecting: the race-with-operator-inspection risk above; the operator's `superdoctor-rescue-2026-05-21-21-55/` workflow (4 state.db backups + 2 untracked docs) is exactly what an auto-reaper would have destroyed before extraction.

## Consequences

### Positive

- **Dissolve completes**. `atmux team dissolve-epic <eid> [--skip-checks]` post-condition is: worktree absent + cage tmux server dead + merged branch absent + parent EPIC marked done. Manual `tmux kill-server` + `git branch -D` becomes unnecessary in the happy path.
- **Silent accumulation surfaces early**. Orphan-detection invariant catches the next regression at the first hourly doctor run, not the 8-cage / 18GB-pressure point.
- **Operator rescue paths preserved**. `--skip-checks` still bypasses kanban + worktree-clean gates; unmerged-branch delete still requires operator action; yellow doctor row still leaves cleanup timing to operator.
- **No new helpers**. Reuses existing `resolveCageSocket` + `cageSessionName` + `softStop` + the cockpit-rebuild walker. ~30-line edit in `dissolve-epic.ts` + ~50-line edit at the doctor probe.

### Negative

- **Cage-kill is now `kill-server`, not `kill-session`**. If a cage tmux server is ever shared across epic-teams (it isn't today, but a future consolidation could try), this would nuke all of them. Mitigation: per [ADR-162](162-atmux-owns-tmux-infrastructure.md) the cage socket is per-`<team>/<eid>` by construction; no consolidation is on the roadmap. Defense-in-depth: the orphan-detection probe (§D3) treats every cage server as belonging to a single `<eid>` and surfaces a violation if that ever changes.
- **`git branch -D` runs against the parent repo from the dissolve verb**. The verb already mutates the parent (`cockpit.json::sessions`, parent kanban EPIC row); this expands the mutation surface by one line. Mitigation: gated on `git merge-base --is-ancestor` check; failure is non-fatal; same idempotency contract as the existing cockpit mutation.

### Migration / compatibility

- No schema changes. No `team.json` field additions. No `cockpit.json` field additions.
- Pre-existing orphan cages from before this ADR ships are not auto-reaped — the doctor probe surfaces them; the operator runs `tmux -S <socket> kill-server` to clean each. (Existing manual-cleanup path stays; the goal is preventing future accumulation, not retroactively reaping today's backlog.)
- ADR-090 §Amendment 2026-05-21 is superseded by this ADR's §D1 — the `kill-session` step becomes `kill-server`; the existing `defaultCageTeardown` test suite needs the assertion updated (`tmux.server.killServer` instead of `tmux.session.killSession`).

## Out of scope

- **Cross-host orphan detection** — single-host hax only. ADR-184 host-cap territory.
- **Auto-recovery of pre-existing orphans** — superdoctor's manual reap covers the backlog; this ADR prevents future accumulation. A separate ADR could ship an auto-reaper for old orphans, but operator-driven cleanup is sufficient for the current backlog size (post-2026-05-21 reap: zero).
- **Auto-delete unmerged branches** — operator rescue path preserved per §D2. A future ADR could add `dissolve-epic --force-branch-delete` for the unmerged-and-discardable case, but this ADR keeps the default safe.
- **Cage tmpdir GC** — `atmux cockpit rebuild` already reconciles tmpdirs (per ADR-090 §Out-of-scope). The doctor probe in §D3 surfaces the residue; the rebuild reconciles it.

## Filed via

- EPIC `e-7a1014f9` (P0 dissolve-epic completeness — 3 fixes one commit; T1 = this ADR).
- Parent ticket `t-609c1921` (driverOnly P0 atmux-bug — closes when ADR + 3 fixes ship).
- Lead routing 02:34 MYT 2026-05-22. Subtask T1 (docs role, this commit) claimed via `atmux claim --next` 2026-05-22.
