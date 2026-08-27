# RUNBOOK — team-of-teams lifecycle (pre-sopx capstone)

> **2026-05-24 alignment** — Post-[ADR-233](adr/233-cron-auto-install-disabled-trust-orchd.md)
> atmux NEVER writes to crontab; the Rust `atmux-orchd` daemon runs
> per-team with 4 in-process tickers (5min sweep-merges · 15min
> context-scan + budget-scan · hourly log-rotate · 24h housekeep) +
> 10 honker consumers (merge / dissolve / push / spawn:on-ready /
> spawn:on-unblocked / dissolve-solo-worker / complaint / rotation /
> gitter). Anywhere this runbook says "wait for the `*/N` cron tick",
> read that as "orchd's in-process ticker fires every N minutes — or
> invoke `atmux <verb>` directly to push the cycle yourself."

Operator-facing playbook for the team-of-teams (epic-team) lifecycle that atmux exercises end-to-end in `tests/e2e/team-of-teams-pre-sopx.test.ts`. Pairs ADR-089 (cockpit-walk DFS substrate) + ADR-090 (epic-team lifecycle) + ADR-091 (epic-merge state machine) + ADR-092 (cross-team tell-lead) into a single operator narrative.

> **Scope note.** This playbook covers epic-teams specifically — nested cages that exist *because of a kanban epic*, and that carry an `epicId` linking back to it. **It is not the general nesting model.** ADR-089's nesting mechanism is reason-agnostic: a cage may contain child cages to arbitrary depth for any purpose, and a nested cage needs no epic and no `epicId` ([ADR-089 §Amendment 2026-08-27](adr/089-hierarchical-cockpit.md) §(A); operator-facing form in [RUNBOOK-cockpit.md §11](RUNBOOK-cockpit.md)). Everything below applies to the epic-shaped instance, not to nesting as such.

⚠️ **Status: phase-2 partial — cross-team `tell-lead` paths (§Cross-team tell-lead) flipped to Verified per t-bc4fdb19. Lifecycle walk (§Sopx adoption) + doctor checks (§Doctor checks) remain phase-1 / t-c2e544b6 scope. Operator-runnable surfaces (`atmux team spawn-epic` / `dissolve-epic` / `epic-merge` cron) are now on the up-impl-3 branch via cherry-pick of `ba7ee3f` (ADR-092) + `a670648` (phase-1 skeleton); committer fan-in to trunk is in flight (committer-stuck-bug t-f4088323).**

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
5. **Trigger fan-in.** Per epic: `atmux committer --sweep` (or wait for the `*/10` cron tick). Per-member branches fan into `<epic-trunk>` via ADR-091 state machine (`recording → merging → merged`).
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
| Epic-team committer stuck mid `recording`                   | `atmux committer --reset --epic <name>` clears the in-memory state machine + lets the next `*/10` sweep re-trigger from clean.               |
| Parent's `KanbanEpic` row stuck in `merging` post-dissolve | `atmux task move <epicId> done --as <operator>` (driver-only refuse-gate per ADR-033 — operator must use `--as driver` or have driverOnly bypass). Investigate via `atmux doctor` for orphan check. |
| Cron block lingers after dissolve                        | `atmux cron-uninstall --team <parent>-epic-<name>` (post-ADR-091 verb; manual `crontab -e` is the operator-side fallback).                  |

For phase-1 skeleton state: all of the above are **intended** behaviour; phase-2 wires assertions for each.

## Cross-team tell-lead (Verified — phase-2, t-bc4fdb19)

`atmux tell-lead --team <other>` routes a message into another team's `driver-inbox.md` + fires a heads-up nudge to its lead pane. Three canonical paths now asserted in `tests/e2e/team-of-teams-pre-sopx.test.ts::describe("ADR-092 cross-team tell-lead (phase-2, t-bc4fdb19)")`:

- **parent driver → epic-lead.** `atmux tell-lead --team <epic-name> "<msg>"` from the parent's driver pane (`ATMUX_CALLER_SCOPE=driver`). Asserted: target's `<epic-atmuxDir>/driver-inbox.md` carries the msg; source's parent inbox stays clean (routing went to target, not source).
- **epic-lead → parent.** `atmux tell-lead --team <parent-name> "<msg>"` from an epic-team's lead pane (no scope override). Allowed natively via ADR-092 §D3 case (c) — the cockpit's `epicTeam.parent` linkage authorizes child→parent. Asserted: parent's inbox gets the msg.
- **unrelated-team caller-scope refusal.** Stage an outsider sibling team in the same cockpit; attempt cross-team tell-lead from it → refused with `EX_NOPERM=77` exit per ADR-099. Asserted: NO inbox write on either side (refusal lands BEFORE `appendDriverInbox`).

Test pattern: tmux send unavoidably fails in the test harness (no cage server backs the resolved socket path) — that's the EXPECTED terminal failure mode. The verb's `appendDriverInbox` lands before the tmux send (per ADR-029 §F6 + tell-lead.ts comment), so inbox-as-evidence is the durable assertion target.

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

## Fleet sweep — `atmux team sweep-epics` (ADR-170)

Operators accumulate epic-teams faster than they tear them down. `sweep-epics` walks every enabled epic-team in `cockpit.json`, classifies each by activity, and (with `--apply`) dissolves the safe ones via the ADR-090 `dissolve-epic` pipeline.

```bash
atmux team sweep-epics                       # read-only report
atmux team sweep-epics --json                # machine-readable
atmux team sweep-epics --parent sopx         # filter to one parent's children
atmux team sweep-epics --idle-hours 48       # tune STALE-IDLE threshold (default 24h)
ATMUX_CALLER_SCOPE=driver \
  atmux team sweep-epics --apply             # dissolve SAFE-DISSOLVE candidates
```

Verdicts (full ladder in ADR-170 §Verdict ladder):

| Verdict | When | `--apply` |
|---|---|---|
| `DRAIN` | open tasks > 0 | skip |
| `SAFE-DISSOLVE` | 0 open tasks AND clean AND branch pushed to origin | dissolve |
| `STALE-IDLE` | 0 open tasks AND last commit ≥ idle-hours AND NOT pushed | report — push or investigate first |
| `RISKY` | dirty worktree OR unmerged unpushed commits | report — manual review |
| `MISSING` | cockpit entry but worktree directory absent | report — manual cockpit cleanup |

`--apply` runs only against `SAFE-DISSOLVE` rows. STALE-IDLE and RISKY are reported but never auto-dissolved — a worktree-prune that drops unpushed commits is unrecoverable, so the push-to-origin check is load-bearing.

## Cross-refs

- ADR-089 — cockpit-walk DFS substrate (load-bearing for `--team <name>` lookup).
- ADR-090 — epic-team lifecycle (TeamEpic + KanbanEpic + spawn-epic / dissolve-epic verbs + epic-rosters/default + epic-lead brief).
- ADR-170 — `sweep-epics` verb (composition over loadCockpit + dissolveEpic; SAFE-DISSOLVE auto-apply, STALE-IDLE/RISKY report-only).
- ADR-091 — epic-merge state machine (`recording → merging → merged`) + epic-merge cron + committer epic-team brief.
- ADR-092 — cross-team tell-lead (parent ↔ epic-lead routing + caller-scope refusal).
- ADR-099 — `EX_NOPERM=77` refusal exit code (used by cross-team caller-scope gate).
- ADR-033 — driver-only refuse-gate (applies to parent-kanban Epic-row state transitions).
- ADR-057 §D5a — submodule pointer integrity (extended by ADR-092's D5a check).
- `tests/e2e/team-of-teams-pre-sopx.test.ts` — paired e2e spec (phase-1 skeleton in this commit; phase-2 wires assertions per t-bc4fdb19).
