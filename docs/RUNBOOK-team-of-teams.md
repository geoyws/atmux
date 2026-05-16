# RUNBOOK — team-of-teams lifecycle (pre-sopx capstone)

Operator-facing playbook for the team-of-teams (epic-team) lifecycle that atmux exercises end-to-end in `tests/e2e/team-of-teams-pre-sopx.test.ts`. Pairs ADR-089 (cockpit-walk DFS substrate) + ADR-090 (epic-team lifecycle) + ADR-091 (epic-merge state machine) + ADR-092 (cross-team tell-lead) into a single operator narrative.

⚠️ **Status: phase-1 skeleton — operator-runnable surfaces (`atmux team spawn-epic` / `dissolve-epic` / `epic-merge` cron) currently live on un-merged member branches per the capstone Task t-edc93b42 phase-1 ship note. This RUNBOOK ships now to reserve the canonical structure; phase-2 (t-bc4fdb19) flips its sections from "Intended" to "Verified" once the gitter sweep fans the dependent surfaces into trunk.**

## When to spawn an epic-team

An epic-team is a **time-bounded, focused team-of-teams** spun under a long-lived parent team for a discrete piece of work — typically a single ADR's worth of decomposition that fans out across multiple lanes (FE + BE + TEST + REVIEW) and would otherwise burn the parent team's roster slots for weeks.

Use it when:

- A piece of work has its own EPIC + 5+ Tasks decomposed across 2+ lanes.
- The work is **completable** (vs steady-state) — there's a definitive "done" state where the epic-team dissolves.
- Parent team's roster is full or you want to keep the parent team's commit-cadence focused on a different stream.
- Cross-team coordination via `atmux tell-lead --team <parent>` or `--team <other-epic>` is acceptable (no member-to-member messaging required).

Don't use it when:

- The work is steady-state (use a regular team via `atmux init` + `atmux team spawn-member`).
- The work is < 1 Task in scope (just claim it on the parent team).
- You need cross-team member-to-member messaging (deferred per ADR-092 §Out of scope).

## Sopx adoption (the canonical pre-sopx flip)

Driver-inbox 14:03 MYT lines 3122-3132 documented the sopx adoption sequence. Captured verbatim here so the spec's `test.step()` labels and this RUNBOOK's beat names stay 1:1 — the e2e is the rehearsal; this RUNBOOK is the dress.

1. **Pre-flight on the parent team.** `atmux status --json` shows `sessionState=up` + every roster slot in `cageState=active` + no open complaints (`atmux complaints list --status open`).
2. **Spawn 2 parallel throwaway epics.** `atmux team spawn-epic --from <parent> --epic-name <e1> --roster epic-default` + `atmux team spawn-epic --from <parent> --epic-name <e2> --roster epic-default`. Cockpit window for each epic auto-launches per ADR-089's recursive walk.
3. **Seed mock Tasks under each epic.** `atmux task add --epic <epic-id> --lane fe "..."` + `--lane be "..."` against each epic's `<root>/.atmux/epic-<name>/state.db`.
4. **Walk each epic's lifecycle.** Per epic: members claim → commit on `<epic-trunk>-<member>` → `atmux done`. Watch `atmux status` for cadence; expect ≤30min per Task ship.
5. **Trigger fan-in.** Per epic: `atmux gitter --sweep` (or wait for the `*/10` cron tick). Per-member branches fan into `<epic-trunk>` via ADR-091 state machine (`recording → merging → merged`).
6. **Dissolve each epic.** `atmux team dissolve-epic --epic <e1> --soft` + `--epic <e2> --soft`. Soft-stop notices members → grace window → resume manifest written → worktree pruned → cockpit entry removed → cron block removed. ADR-090↔091 wire-up triggers epic-trunk → parent-trunk fan-in on the way out.
7. **Verify parent's kanban.** Both `KanbanEpic` rows are `status='done'` + `completedAt` populated. Parent `git log --oneline --merges` shows 2 new merge commits (one per epic).
8. **Sopx flip readiness.** `atmux complaints list --status open` empty; `atmux doctor` green on the parent + zero residual `epic-team` entries in `cockpit.sessions[]`. **Sopx adoption can begin.**

## State-snapshot expectations (per Test finding report pattern)

CLAUDE.md §Testing Discipline — every operator beat above maps to a snapshot the e2e captures + asserts:

| Stage label                        | parent.KanbanEpic.status | cockpit.epic-entry | worktree present | cage alive | cron block |
|------------------------------------|--------------------------|--------------------|------------------|------------|------------|
| `pre-spawn-baseline`               | (no row)                 | (absent)           | no               | no         | no         |
| `post-spawn-parallel`              | `planning`               | present            | yes              | yes        | yes        |
| `post-seed`                        | `planning`               | present            | yes              | yes        | yes        |
| `post-task-done-per-epic`          | `in-progress`            | present            | yes              | yes        | yes        |
| `post-epic-trunk-fan-in`           | `in-progress`            | present            | yes              | yes        | yes        |
| `post-parent-trunk-merge` (mid-dissolution) | `merging`       | present            | yes              | yes        | yes        |
| `post-dissolution`                 | `done`                   | absent             | no               | no         | no         |
| `post-cleanup` (== `pre-spawn-baseline`) | (no row + every set diff empty) | absent | no | no | no |

The last row is the **idempotence proof**: every leaked side-effect from the spawn → dissolve cycle is reclaimed.

## Failure-mode triage

If any of these go wrong in operator-runtime, the rollback path is non-destructive:

| Symptom                                                  | Recovery                                                                                                                                  |
|----------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------|
| `spawn-epic` fails after partial cockpit-write           | `atmux team dissolve-epic --epic <name> --force` (skips soft-stop grace, kills cage, prunes worktree) → re-spawn.                          |
| Epic-team gitter stuck mid `recording`                   | `atmux gitter --reset --epic <name>` clears the in-memory state machine + lets the next `*/10` sweep re-trigger from clean.               |
| Parent's `KanbanEpic` row stuck in `merging` post-dissolve | `atmux task move <epicId> done --as <operator>` (driver-only refuse-gate per ADR-033 — operator must use `--as driver` or have driverOnly bypass). Investigate via `atmux doctor` for orphan check. |
| Cron block lingers after dissolve                        | `atmux cron-uninstall --team <parent>-epic-<name>` (post-ADR-091 verb; manual `crontab -e` is the operator-side fallback).                  |

For phase-1 skeleton state: all of the above are **intended** behaviour; phase-2 wires assertions for each.

## Cross-team tell-lead (deferred to phase-2)

`atmux tell-lead --team <other>` routes a message into another team's `driver-inbox.md` + fires a heads-up nudge to its lead pane. Three canonical paths the e2e will assert in phase-2 (t-bc4fdb19):

- **parent driver → epic-lead.** `atmux tell-lead --team <epic-name> "<msg>"` from the parent's driver pane.
- **epic-lead → parent.** `atmux tell-lead --team <parent-name> "<msg>"` from an epic-team's lead pane.
- **unrelated-team caller-scope refusal.** Spawn an unrelated sibling team in the same cockpit; attempt cross-team tell-lead from there; verify refusal with `EX_NOPERM=77` exit code per ADR-099.

Member-to-member cross-team messaging is **out of scope** entirely — use `atmux send <member>` within a team only.

## Doctor checks (deferred to phase-2)

ADR-092 dogfood (t-c2e544b6) extends `atmux doctor` with three new probe classes for epic-team correctness:

- **D5a** — submodule pointer integrity for epic-team worktree under parent (extends existing ADR-057 §D5a).
- **D8** — `epicTeam.parent` reachability + parent kanban consistency. Detects orphan epic-teams (parent removed mid-lifecycle).
- **D9** — prefix-level consistency. Every cage's `tmux.conf` prefix matches its `ATMUX_NESTING_LEVEL` env (ADR-089).

Phase-2 builds corrupted-cockpit fixtures + asserts each check returns the correct severity row.

## Adjacent-to-adjacent flags (from t-cc4c5fd9 audit)

Three cross-cutting concerns the post-ship audit surfaced. None block phase-1 / phase-2 directly, but operator should be aware:

1. **GitHub Actions cross-account secret scoping under pr-mode.** Auto-mode capstone doesn't trigger; pr-mode follow-up will need a slow-mode ADR. Secrets follow target repo (not author).
2. **Claude API rate-limit ceiling under 2 epics × 7 members = 14 simultaneous TUIs.** Validate via `/coordination:budget` before spawning two parallel epics on the same account. Cross-correlate with t-77ae2baa Class 3 stress test.
3. **gh-CLI process-global auth-switch race under pr-mode.** `gh auth switch` mutates `~/.config/gh/hosts.yml::active-user` globally. Auto-mode capstone bypasses this; pr-mode follow-up will need mutex sequencing per ADR-090/091 audit fold-in.

## Cross-refs

- ADR-089 — cockpit-walk DFS substrate (load-bearing for `--team <name>` lookup).
- ADR-090 — epic-team lifecycle (TeamEpic + KanbanEpic + spawn-epic / dissolve-epic verbs + epic-rosters/default + epic-lead brief).
- ADR-091 — epic-merge state machine (`recording → merging → merged`) + epic-merge cron + gitter epic-team brief.
- ADR-092 — cross-team tell-lead (parent ↔ epic-lead routing + caller-scope refusal).
- ADR-099 — `EX_NOPERM=77` refusal exit code (used by cross-team caller-scope gate).
- ADR-033 — driver-only refuse-gate (applies to parent-kanban Epic-row state transitions).
- ADR-057 §D5a — submodule pointer integrity (extended by ADR-092's D5a check).
- `tests/e2e/team-of-teams-pre-sopx.test.ts` — paired e2e spec (phase-1 skeleton in this commit; phase-2 wires assertions per t-bc4fdb19).
