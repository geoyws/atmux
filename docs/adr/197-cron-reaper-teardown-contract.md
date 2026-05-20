# ADR-197: Cron-reaper teardown contract — unified cron-cleanup path for `dissolve-epic` / `sweep-epics --apply` / `atmux stop`

**Status**: proposed
**Date**: 2026-05-20
**Driver-ref**: 2026-05-20 docs sweep — t-28ccade1 (Epic e-59b43669 T1)
**Cross-refs**: [ADR-083](083-cron-install-port-scope.md) (cron-install scope + `atmux cron-orphans` shape), [ADR-170](170-sweep-epics-verb.md) (sweep-epics classifier — auto-apply explicitly deferred there), [ADR-178](178-test-cage-leak-reaper.md) (test-cage leak reaper — sibling pattern at the tmux-socket layer), [ADR-181](181-global-ram-budget-gate-on-spawn.md) §T6 (host-audit cousin for the multi-project orphan-cron surface), complaint `c-ced218fb` (10 orphan `atmux:team=` cron blocks survive teardown), complaint `c-27a1c8f4` (test-cage socket leak — sibling class), memory `project_epic_team_dissolve_cron_leak` (the 2026-05-19 observation that motivates this ADR).

## Context

`atmux start` installs marker-fenced cron blocks per team into the operator's host crontab:

```
# >>> atmux:team=<name>
*/5 * * * * cd <atmuxDir> && atmux whip --auto
*/30 * * * * cd <atmuxDir> && atmux report
0 */4 * * * cd <atmuxDir> && atmux decisions digest
# <<< atmux:team=<name>
```

Per-team marker-sandwich is the canonical idempotent arm-mechanism (per ADR-083 §B + the §Cron discipline shorthand added to `CLAUDE.md` at 51015b5 alongside ADR-192). `atmux start` re-installs by removing any existing block with the same marker before re-writing — fine for the start path.

The **teardown** side is incomplete. Three call sites should remove cron blocks but don't (or only do partially):

1. **`atmux team dissolve-epic <eid>`** — removes the epic-team's worktree + cockpit.json `sessions[]` entry, but does NOT remove the `# >>> atmux:team=<eid>` cron block. Memory `project_epic_team_dissolve_cron_leak` documents 8+ surviving epic-team orphan blocks observed 2026-05-19 (e-aeaf7ed4 / e-2c1ac890 / e-fa58a2f9 / e-a25968cc / e-a3077ca0 from atmux; e-2c6ed4b2 from sopx; e-4d8c0b12 from unum). Cron blocks fire `cd <gone-dir> && atmux whip --auto` every 5 min — host load + log noise scaling linearly with leak count (~42 firings/hour at 10 orphans).
2. **`atmux team sweep-epics --apply`** — classifies idle epic-teams + dissolves SAFE-DISSOLVE candidates. The dissolve path it triggers inherits the same gap from #1 — sweep can be 100% green on `dissolve()` returncodes while still leaving cron blocks behind. ADR-170 §"Out of scope" explicitly deferred auto-cron-firing of sweep; that's the right call for the *runner*, but the cron-removal-on-dissolve is independent and not deferred.
3. **`atmux stop`** — soft-stop (ADR-087/177) keeps cron blocks alive while the session resumes (right answer); hard `atmux stop --force` SHOULD remove them but does so inconsistently across paths (`/tmp/atmux-lifecycle-*` lifecycle-test sockets observed orphaning blocks via SIGKILL'd test runs per complaint `c-ced218fb`).

A `cron-orphans` verb exists at `src/verbs/cron-orphans.ts` per ADR-083 §DEFERRED row 2 + t-e1247699 (`--prune` flag, t-e1247699 ship). It scans the OS crontab for marker-fenced blocks whose `ATMUX_DIR=` path no longer exists on disk and emits `[{team, atmux_dir}]` JSON (read-only default; `--prune` rewrites the crontab to strip them). Doctor consumes the same `findCronOrphans` core helper to surface a `cron-config` row.

`cron-orphans` solves the *detection + manual-prune* surface. It does NOT close the lifecycle gap — every dissolve-epic / sweep --apply / stop --force still leaves new blocks behind, and the operator (or a periodic cron) has to chase them with `cron-orphans --prune`.

### Failure-mode taxonomy

1. **dissolve-epic doesn't fire the cron strip.** Most-common class today (~80% of observed orphans). dissolve-epic owns worktree-remove + cockpit-mutate; nobody owns cron-strip.
2. **sweep-epics --apply hits the same gap via dissolve.** Inherited from #1.
3. **`atmux stop --force` SIGKILL race.** Crash kills the JS process before any teardown hook runs; block survives. Same root-cause as the test-cage socket leak in complaint c-27a1c8f4 / ADR-178.
4. **Operator manual `tmux kill-server` / `kill -9 <atmux pid>`.** Bypasses every JS-level hook by definition. Backstop cron is the only defense.
5. **dissolve-epic path-mismatch.** dissolve-epic looks up the cron block by team-name; if the marker uses a different normalization than dissolve's lookup key (e.g. emoji-prefix label vs ID), strip silently misses. Same class as the recent ADR-161 hyphen-vs-underscore label drift fixed by EPIC e-a3077ca0.

## Decision

### Three-part contract

**Part A — `atmux cron-reaper [--dry-run|--apply]` verb** (NEW; supersedes `cron-orphans` vocabulary, see Migration below):

```
atmux cron-reaper [--dry-run|--apply] [--scope <team-name>|--all]
```

- Defaults: `--dry-run --all` (read-only listing of every orphan marker-block found in the host crontab).
- `--apply` rewrites the host crontab to strip the matched orphans atomically (single `crontab -` invocation, no partial state).
- `--scope <team-name>` narrows the match to a single `atmux:team=<name>` block (used by the teardown hooks below — dissolve-epic doesn't want to reap unrelated parents).
- `--scope` repeatable: `--scope eid1 --scope eid2` for batched sweep teardown.
- Exit codes: `0` success / `64` usage error / `1` crontab unavailable (carries over from `cron-orphans` non-fatal posture for the read path; the apply path refuses if crontab unavailable).
- JSON output identical to `cron-orphans` payload (snake_case `atmux_dir`) so existing aggregators stay shape-agnostic; an extra `removed: boolean` field appears when `--apply` was used.

**Part B — Teardown-hook contract** (LOAD-BEARING):

Three call sites add an explicit cron-reaper hook step:

| Caller | Step ordering | Scope arg |
|---|---|---|
| `atmux team dissolve-epic <eid>` | **AFTER** worktree-remove + cockpit-mutate, BEFORE the dispatch-dissolve return | `--scope <eid>` |
| `atmux team sweep-epics --apply` | Per-classified-SAFE-DISSOLVE epic, AFTER the inner dissolve-epic call returns success (already covered transitively by dissolve-epic's hook — sweep doesn't fire a second cron-reaper, but it surfaces the hook's count in its summary output for operator visibility) | inherited from dissolve |
| `atmux stop [--force]` | **AFTER** session-kill + state-flush, BEFORE process exit | `--scope <team-name>` (the team being stopped — never `--all`; multi-team stops fire the hook once per team) |

Rule: the teardown hook is ALWAYS `--apply --scope <name>`. Never `--all` from a teardown hook — limits blast radius if the lookup-key normalization drifts (failure-mode #5 above; a misaligned key reaping `--all` would strip unrelated teams' blocks).

**Part C — Doctor orphan-cron probe shape** (refines existing `cron-config` probe):

```
cron-config: <green|yellow|red>
  orphans_found: N
  orphans:
    - team: <name>     atmux_dir: <path>     last_fire: <iso-ts>    age_min: N
    - team: ...
  recommended: atmux cron-reaper --apply --scope <name>  (per orphan)
              atmux cron-reaper --apply --all          (bulk path)
```

Severity:
- **green** when `orphans_found == 0`.
- **yellow** when `orphans_found ∈ [1, 3]` (operator notice; not blocking).
- **red** when `orphans_found ≥ 4` (likely systematic dissolve-epic regression OR a SIGKILL'd test run — see complaint c-ced218fb where 10 orphans was the operator-trigger to file the complaint).

The probe re-uses `findCronOrphans` from `src/core/cron.ts`; the additional `last_fire` / `age_min` fields come from the cron-block's `CRON_LAST_FIRE_AT=<unix-ts>` annotation written by `atmux whip --auto` at every fire (NEW annotation, lands as part of impl T2 — see Sub-tasks below). Block age signals whether the leak is recent or has been bleeding for weeks (recent → recent teardown regression; old → long-tail SIGKILL races).

### Migration — `cron-orphans` → `cron-reaper`

`cron-orphans [--prune]` and `cron-reaper [--dry-run|--apply]` are functionally equivalent on the listing + bulk-prune paths. The rename is justified by:

1. **Vocabulary alignment with ADR-178** (test-cage leak reaper). Reaper is the canonical atmux verb-name for "scan + clean up leaked resources"; consolidating the two leak surfaces under the same vocab makes the operator surface easier to learn.
2. **`--scope` flag is awkward to add to `cron-orphans --prune`.** Renaming is cleaner than retro-fitting.

Backward-compat grace: `cron-orphans [--prune]` stays as an alias for `cron-reaper [--apply]` for one release; emits a deprecation-warn to stderr referencing this ADR. Removal lands in the version after.

### What we give up

- **Single-file independence.** Three callers now depend on a shared cron-reaper module (or its core helper). One bug in cron-reaper bricks teardown across all three. Mitigation: keep the core helper (`reapTeamCronBlock(teamName, opts)` in `src/core/cron.ts`) narrow + heavily unit-tested; verbs are thin wrappers.
- **Slightly slower dissolve/stop paths.** One additional `crontab -l + crontab -` round-trip per call. Crontab IO is O(10ms) on a healthy host; negligible in operator-cycles vs the cleanup payoff.
- **Doctor's `cron-config` row becomes noisier on healthy hosts** — the structured `orphans: []` output is more verbose than the current single yellow/green line. Mitigation: terse output when `orphans_found == 0` (just `cron-config: green`, no further structure).

### Rollback path

If the teardown-hook integration surfaces problems in production (e.g. cron-reaper's scope lookup mismatches dissolve-epic's name lookup → strips wrong block):

1. **Disable Part B (hooks) via env**: `ATMUX_CRON_REAPER_TEARDOWN_HOOK=0` skips the hook step in each caller; verbs continue working standalone. Operator can fall back to manual `atmux cron-reaper --apply` while the bug is fixed.
2. **Per-caller disable**: `dissolve-epic --no-cron-reaper`, `stop --no-cron-reaper` flags. Last-resort surgical bypass.
3. **Full revert**: drop Part B entirely; ship Parts A + C as a manual + doctor-surfaced flow. Loses the lifecycle automation but preserves cron-orphans-equivalent detection.

## Sub-tasks (decomposed by planner; this ADR is the spec — impl Tasks land downstream)

- **T1** — ADR-197 draft (this file). Lane=`misc`, deps=none, priority=1. (← *this Task is t-28ccade1*)
- **T2** — Verb impl: `src/verbs/cron-reaper.ts` + rename core helpers in `src/core/cron.ts` + `atmux cron-orphans` deprecation-alias shim. Same-commit unit tests covering `--dry-run` / `--apply` / `--scope` / scope-narrowing. Lane=`be`, deps=T1, priority=1.
- **T3** — Teardown-hook wiring in `src/verbs/team/dissolve-epic.ts` (Part B row 1). Same-commit integration test (write a fake cron-block + run dissolve + assert block stripped). Lane=`be`, deps=T2, priority=1.
- **T4** — Teardown-hook wiring in `src/verbs/team/sweep-epics.ts` (Part B row 2 — surface count in summary; dissolve-epic's hook covers the strip). Same-commit unit test for the summary line. Lane=`be`, deps=T3, priority=2.
- **T5** — Teardown-hook wiring in `src/verbs/stop.ts` (Part B row 3). Carve out the `--force` SIGKILL path explicitly — the hook runs in the SIGTERM-safe path; SIGKILL bypass is covered by the backstop cron from T7. Same-commit integration test. Lane=`be`, deps=T2, priority=1.
- **T6** — Doctor probe refinement in `src/verbs/doctor.ts::checkCronOrphans` to consume the new probe shape (Part C). Same-commit doctor-output snapshot test. Lane=`be`, deps=T2, priority=2.
- **T7** — `CRON_LAST_FIRE_AT` annotation in `atmux whip --auto` cron template + cron-reaper consumption. Backstop cron (`*/30 * * * * atmux cron-reaper --apply --all`) installed by `atmux start` for SIGKILL / manual-kill class. Same-commit annotation parse test + backstop install test. Lane=`be`, deps=T2, priority=2.
- **T8** — Docs sweep: CLAUDE.md §Cron discipline (extend the existing pointer from 51015b5 to name cron-reaper + teardown contract), CHANGELOG entry, RUNBOOK-cron-migration.md (if affected), brief templates that reference cron-orphans get the deprecation note. Lane=`misc` (docs), deps=T2 (vocab needs to be live first), priority=3.

## Open questions

1. **(LOW reversibility) Name choice — `cron-reaper` vs `cron-cleanup` vs `cron-prune`**: Recommend `cron-reaper` to align with ADR-178 (`test-reaper`). Alternative `cron-cleanup` is more transparent to first-time operators but loses the sibling-resource vocabulary alignment. `cron-prune` is too close to the existing `--prune` flag (overload confusion).

2. **(LOW reversibility) Scope of `--scope`** — should it accept a glob/regex pattern, or stay strict-string-match-only? Recommend strict-string-match-only (mirrors `dissolve-epic <eid>` arg semantics). Glob/regex opens the same blast-radius footgun the `--all` carve-out closes. Operators who want bulk reaping pass multiple `--scope` flags.

3. **(MEDIUM reversibility) Hook step ordering in `dissolve-epic`** — should cron-reaper fire BEFORE or AFTER worktree-remove? Default proposal: AFTER (so a cron block firing mid-teardown doesn't trip on a half-removed worktree). Trade-off: if dissolve-epic crashes between worktree-remove and cron-reaper, the cron block survives — but that crash window is exactly what the backstop cron from T7 catches. Reversal would be one-line in T3.

4. **(MEDIUM reversibility) Backstop cron cadence** — `*/30 * * * *` proposed in T7. More aggressive (`*/5 * * * *`) catches leaks faster but increases the no-op crontab-IO load. Less aggressive (`0 * * * *`) saves IO but lets noise accumulate longer. Default 30 min is a compromise; operator can re-tune via `team.json::cron.reaperCadenceMin`.

5. **(LOW reversibility) Apply path failure mode** — if `crontab -` rewrite fails mid-flight (e.g. host crontab IO error), should the verb roll forward (next run retries) or surface a hard error? Recommend hard error + non-zero exit. The atomic `crontab -` semantics mean partial-write isn't possible (atomic on POSIX); a hard error indicates a host-level problem the operator should see, not silently mask. Teardown-hook callers absorb the exit code into their own surfacing path (dissolve-epic's exit propagates; sweep-epics summarizes; stop logs warn-and-continues since session-kill already happened).

6. **(MEDIUM reversibility) Cross-project orphan scope** — single-user hax convention means one operator's crontab houses orphans across ALL projects (atmux + sopx + unum + ...). Should `cron-reaper --apply --all` reap across projects, or refuse without a confirm flag? Recommend reap-across-projects-by-default; the marker-fence + `ATMUX_DIR` path-exists check already scopes to "actually-orphan". Cross-project blast-radius is bounded by the existence check (won't touch an active project's blocks). Operators who want narrower scope use repeated `--scope` flags.

## Cross-refs

- [ADR-083](083-cron-install-port-scope.md) (cron-install-port-scope — `atmux cron-orphans` shape that this ADR supersedes vocabulary-wise).
- [ADR-170](170-sweep-epics-verb.md) (sweep-epics-verb — auto-apply explicitly deferred there; this ADR's Part B wires the dissolve-side cron-strip that sweep transitively benefits from).
- [ADR-178](178-test-cage-leak-reaper.md) (test-cage leak reaper — sibling pattern at the tmux-socket layer; same operator-vocabulary `reaper` for "scan + clean leaked resources").
- [ADR-181](181-global-ram-budget-gate-on-spawn.md) §T6 (host-audit — same multi-project surface; cron-reaper is one of the inventories host-audit aggregates).
- [ADR-192](192-cron-arm-idempotency-contract.md) (cron-idempotency contract for arm-a-cadence verbs — sibling on the install side; this ADR is the symmetric teardown side).
- Complaint `c-ced218fb` (10 orphan `atmux:team=` cron blocks survive teardown — the trigger observation).
- Complaint `c-27a1c8f4` (test-cage socket leak — sibling class at the tmux-socket layer; ADR-178 is the resolution).
- Complaint `c-238f0faf` (test-fixture tmux socket leak — adjacent class; informs the `--scope` blast-radius carve-out).
- Memory `project_epic_team_dissolve_cron_leak` (2026-05-19 observation; pre-existing operator workaround `crontab -l | grep -v 'atmux:team=<eid>' | crontab -`).
- Memory `feedback_atmux_lifecycle_orphan_cron` (recurring class — atmux lifecycle tests leaving orphan crons hide real-team dormancy).
- `src/verbs/cron-orphans.ts` (today's verb that this ADR supersedes vocabulary-wise + builds upon shape-wise).
- `src/core/cron.ts::findCronOrphans` / `pruneCronOrphans` (existing core helpers; cron-reaper re-uses them + adds `reapTeamCronBlock(teamName, opts)`).
- `CLAUDE.md` §Cron discipline (added at 51015b5 alongside ADR-192; T8 extends it to name the teardown contract).
