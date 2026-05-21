# ADR-196: `worktreeIsolation: true` as default for `spawn-epic` — structural fix for shared-index race class

**Status**: Accepted — ratified by driver 2026-05-21 (worktreeIsolation=true default for spawn-epic + opt-out flag/parent-inheritance; §OQ recommendations as-written: universal flip, no auto-migration of in-flight epics, ADR-082/084 branch naming, YES new epic-team-shared-mode doctor probe P2, dispatch-summary role-drift = separate scope)
**Date**: 2026-05-20
**Related**: [ADR-082](./082-worktree-per-member.md) (per-member worktree primitive), [ADR-084](./084-worktree-per-member-branch.md) (per-member-branch convention), [ADR-090](./090-epic-team-lifecycle.md) (spawn-epic / dissolve-epic — the verbs this ADR amends defaults on), [ADR-091](./091-kanban-driven-auto-merge.md) (fan-in mode the per-member-branch pattern feeds), [ADR-134](./134-in-team-auto-merger.md) (intra-team auto-merger consuming per-member commits), [ADR-194](./194-auto-push-just-done-sha.md) (sibling auto-push race mitigation — `shared` mode), [`feedback_shared_index_commit_race_hazard`](memory).

## Context

Across 3 days (2026-05-18 → 2026-05-20), 4 shared-index race incidents have manifested in epic-teams operating with `worktreeIsolation: false` (the current `spawn-epic` default):

| Date | Epic-team | Incidents | Class | Recovery |
|---|---|---|---|---|
| 2026-05-18 | `e-f28c2596` | ×2 | commit-race absorption + post-push swap | `feedback_shared_index_commit_race_hazard` memory |
| 2026-05-20 14:07–14:09 | `e-1e223687` | swap #1 | file-overwrite (be-1 Write clobbered fe-2's T5 src 874→622 lines, tests 910→437 lines — work GONE on disk pre-commit) | Structural-dodge: split each Task to its own file (`team-rename-tmux.ts` / `team-rename-cockpit.ts` / `team-rename-fs.ts`) per cage lead 21:47 |
| 2026-05-20 21:58 | `e-1e223687` | swap #2 | absorption + double-swap (SHA `37c156d` carries T5 msg but T4 content; SHA `492f1fa` carries T3 msg but T3+T5 content) | Non-destructive `docs/audit/2026-05-20-shared-index-swap.md` mapping SHA→actual-Task; no rebase; no force-push |
| 2026-05-20 22:04 | `e-1e223687` | swap #3 | 4th incident, recovered cleanly via `git commit --only <path>` defensive pattern (be-2 `1c2769f`) | Worker-side; beat lead's HOLD signal by seconds |
| 2026-05-20 22:12 | `e-1e223687` | swap #4 | auto-push race amplification (parent ADR-194 motivation) | Lead-coordinated single-writer rule for remaining T6/T7 |

**Cage lead's standing escalation** (cage `e-1e223687` outbox at 21:39 / 21:47 / 22:12 / 22:26 MYT 2026-05-20):

> **STRUCTURAL ASK**: please flip `worktreeIsolation=true` as default for `spawn-epic` when team edits shared core files — observed cost is 3 incidents in 3 days. […] **STANDING ESCALATION**: `worktreeIsolation=true` default for spawn-epic on shared-core teams.

The lead repeats the ask across 4 distinct moments in one session. The discipline rule (`feedback_shared_index_commit_race_hazard` mandates `git diff --cached --stat` pre-commit + `git show --stat HEAD` post-commit) **is insufficient on its own** — be-2's analysis 22:12 MYT shows the race window is sub-second under busy commit chains, **below human reaction time**. Even disciplined workers eat swaps.

### Sibling mitigations, why they're not enough

[ADR-194](./194-auto-push-just-done-sha.md) (auto-push targets just-done SHA) is a **mitigation** for the shared mode — it narrows the race window for the auto-push path specifically. It does **not** eliminate the underlying staging-index swap that produces the file-overwrite (incident 1, 2026-05-20 14:07) — a Write-tool race that happens before any commit. ADR-194 + worker `--only` discipline together still leave a non-zero race window.

The structural fix is **eliminate the shared index**. Per-member worktree (ADR-082) + per-member-branch (ADR-084) + auto-merger fan-in (ADR-091 / ADR-134) is the established alternative pattern: every member has their own `.git`-pointing worktree, their own branch, their own staging index. Commit races become structurally impossible.

The pattern is already shipped:
- ADR-082 (`worktreeIsolation: true` flag in `team.json` Zod schema) — primitive exists.
- ADR-084 (per-member-branch `-b` flag in `provisionWorktree`) — convention exists.
- ADR-091 epic-team fan-in handles per-member commits → trunk via the merger pattern.
- ADR-134 intra-team merger handles the auto-merge cadence.

The piece missing: **`spawn-epic` default is wrong** — defaults to `worktreeIsolation: false` (shared mode). Operators (and cage planners) inherit the unsafe mode unless they explicitly opt out.

## Decision

**Flip `worktreeIsolation` default to `true` for `atmux team spawn-epic`.** Shared-index mode (`worktreeIsolation: false`) becomes opt-in — operators who want it pass `--worktree-isolation=false` explicitly, or set `worktreeIsolation: false` in the parent team's `team.json` (inherited by spawn-epic at cage creation time).

### D1 — `spawn-epic` schema default flip

In `src/verbs/team.spawn-epic.ts`, change the default for the synthesized child `team.json::worktreeIsolation` from `false` to `true`. Cage child kanban + cage cockpit + cage roster all spin up with per-member worktrees from cage-start.

### D2 — `atmux team spawn-epic --worktree-isolation=<bool>` CLI flag

Explicit operator override. When passed, takes precedence over both the new default AND any parent `team.json` value. Surfaces in `--help` with the new default + the trade-off (shared mode is faster but race-prone; isolated mode is the safer default).

### D3 — Parent-team `team.json::worktreeIsolation` inheritance

If a parent team sets `worktreeIsolation: false` (deliberate shared-mode for tightly-coupled work that can't tolerate merger overhead), spawn-epic inherits that value as the cage child's default. The new D1 default applies when parent is unset (most cases).

### D4 — Deprecation grace for explicit `worktreeIsolation: false` in cage team.jsons

`src/schema/team.ts` Zod parser emits a **deprecation warning** (not error) when a cage team.json explicitly sets `worktreeIsolation: false`. Warning text: `[deprecated] worktreeIsolation: false carries shared-index race risk (ADR-196 §Context — 4 incidents 2026-05-18→05-20). Pin if intentional via team.json comment "// per ADR-196 §D3 acknowledged opt-out: <reason>".` One-release grace; no behavioral break in v0.8.x.

### D5 — No migration of in-flight epic-teams

Existing epic-teams (those with cages already spun up at the time this ADR ships) keep their current `worktreeIsolation` value. The flip applies only to `spawn-epic` calls **after** the ADR ships. In-flight epic-teams finish on their current mode; the merger pattern is opt-in for them via explicit re-spawn (which the operator can choose at any dissolve point).

### D6 — Default merger trigger from ADR-134 unchanged

Auto-merger fan-in cadence stays per [ADR-134](./134-in-team-auto-merger.md). No new merger trigger; the existing per-member-commit → auto-merge path absorbs the additional per-member branches transparently. The merger already detects `worktreeIsolation: true` and routes accordingly.

## Consequences

### Eliminates

- Shared-index staging swap (incident class observed 2026-05-18 ×2 + 2026-05-20 ×2 = 4 instances over 3 days). Per-member staging means siblings cannot stage into each other's index.
- File-overwrite races (incident 2026-05-20 14:07 — be-1's Write clobbering fe-2's on-disk T5). Per-member worktree means siblings cannot Write into each other's tree.
- Auto-push amplification (ADR-194 §Context) for the isolated-mode path. ADR-194 still applies for the residual shared-mode opt-out cases.
- "Single-writer rule" lead-coordination overhead (cage 22:12 MYT escalation 4 — "single-writer rule active for remaining T6/T7"). Per-member branches are structurally parallel-safe; no manual serialization.

### Costs

- **Disk**: N worktrees per epic-team cage instead of 1. At N=4 (typical) × ~50 MB working tree, +150 MB per cage. At 8 concurrent cages (ADR-184 host-cap default), +1.2 GB peak — modest for hax (128 GB RAM, ample disk).
- **Spawn-epic time**: N `git worktree add -b` instead of 1 `git worktree add`. Linear in N; ~2-3s per member added; cage spinup goes from ~5s to ~15s at N=4. Acceptable.
- **Auto-merger load**: more merge events through the ADR-134 intra-team merger. Already designed for this load per ADR-091/134; no architectural impact.
- **Cross-member coordination changes shape**: instead of "edit the same file; serialize commits" coordination, members coordinate via "claim independent Tasks; merger handles fan-in." Workers may need brief-update guidance on this; lane assignments become more important (avoid two members editing the same file in the same window — the merger will surface conflicts).

### Rollback path

Single-line revert in `src/verbs/team.spawn-epic.ts` (flip default back to `false`) — completely reversible. Existing in-flight epic-teams are unaffected (per D5). One-release grace via D4 makes the deprecation reversible without breakage.

## Open questions

1. **Universal flip vs. gate on "shared-core-files" detection?** **Default**: universal flip per D1 (apply to ALL spawn-epic). *Rationale*: detecting "shared-core-files" is itself fragile (depends on the EPIC body or path heuristics); universal flip is simpler + safer. Opt-out per D2/D3 covers the legitimate shared cases. Low-rev.

2. **Should existing in-flight epic-teams be auto-migrated?** **Default**: NO per D5. *Rationale*: migration mid-flight is destructive (would require dissolving + re-spawning the cage, losing state.db tasks). One-release grace per D4 surfaces the deprecation; operators choose to re-spawn at natural dissolve points. Low-rev.

3. **Per-member branch naming?** **Default**: existing ADR-082 / ADR-084 convention — `<base>-<member>` (e.g. `geoyws-epic-e-1e223687-be-1`). *Rationale*: no schema change; merger already routes on this pattern. Low-rev.

4. **Should `atmux doctor` add a probe for shared-mode epic-teams?** **Default**: YES (medium-rev). Probe class `epic-team-shared-mode` at P2 — surfaces every running epic-team with `worktreeIsolation: false` so operators can audit. Probe does not auto-fix (would require cage dissolve). Folds into `docs/RUNBOOK-doctor-probes.md` per [ADR-183](./183-deploy-completeness-probe-class.md). Medium-rev.

5. **Should the dispatch-summary verb (cage 22:36 MYT outbox — "verb dispatch-summary expects 'team-lead' role but team.json has 'lead'") be audited as part of this ADR's rollout?** **Default**: NO — separate scope. Surfaces as standalone Task `[atmux-bug] dispatch-summary role-name canonical drift (team-lead vs lead)` for the parent kanban. ADR-196 stays focused on the worktree-mode flip. Low-rev.

## Cross-refs

- **ADR-082** — `worktreeIsolation: true` primitive this ADR flips the default of.
- **ADR-084** — per-member-branch `-b` flag the per-member worktree uses.
- **ADR-090** — `spawn-epic` / `dissolve-epic` lifecycle this ADR amends defaults on.
- **ADR-091** — epic-team fan-in handles per-member-branch absorption to trunk.
- **ADR-134** — intra-team auto-merger consuming per-member commits; trigger unchanged.
- **ADR-194** — sibling auto-push mitigation for the residual shared-mode opt-out cases; D2/D3 leave shared-mode reachable, so ADR-194 still applies there.
- **ADR-195** — sibling carry-forward Tasks on EPIC-done; orthogonal to this ADR (both are shared-worktree-era hardening).
- **memory `feedback_shared_index_commit_race_hazard`** — empirical incident log (3 manifestations pre-this-session; this session adds #4); ADR-196 closes the class structurally.
- **memory `project_2026_05_19_wedge_audit_session`** — wedge-clearing mechanism that observed shared-mode pathology in adjacent contexts.
- **Driver-ref**: cage `e-1e223687` lead-outbox standing escalation at 21:39 / 21:47 / 22:12 / 22:26 MYT 2026-05-20.

## Spawn-epic hint

Single-Story EPIC. Tasks:

- **T1** — `src/verbs/team.spawn-epic.ts` default flip (D1) + new `--worktree-isolation=<bool>` CLI flag (D2) + parent-inheritance respect (D3); same-commit unit tests covering all three defaults paths (parent-unset / parent-true / parent-false / explicit-flag override). [be, P=1]
- **T2** — `src/schema/team.ts` Zod deprecation warning for explicit `worktreeIsolation: false` (D4); same-commit unit test asserting the warning fires once per parse with the exact message. [be, P=2, deps T1]
- **T3** — `atmux doctor` probe `epic-team-shared-mode` at P2 per OQ4 default. [be, P=2, deps T1]
- **T4** — e2e: spawn-epic with new default → cage spins up with N per-member worktrees + per-member branches + workers can `claim --next` + auto-merger fan-in absorbs cleanly to parent. Fixture epic-team body. [test, P=2, deps T1+T3]
- **T5** — Docs: `templates/briefs/planner.md` + `templates/briefs/lead.md` + `docs/RUNBOOK-spawn-epic.md` (NEW or extend) document the new default + the opt-out path; CHANGELOG entry under `[Unreleased]` §Changed; ADR-196 status flip after reviewer signoff. [misc, P=3, deps T4]

Cross-Epic dep: ADR-194 T1 (auto-push.ts mitigation) lands first per cage lead's "TWO COMPLEMENTARY FIXES" framing — ADR-194 covers the residual shared-mode opt-out path; ADR-196 makes that path opt-in rather than default.
