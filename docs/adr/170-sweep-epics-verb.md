# ADR-170 — `atmux team sweep-epics` verb: enumerate + safely dissolve idle epic-teams

Status: Accepted — ratified by driver 2026-05-21 (`atmux team sweep-epics [--apply] [--idle-hours N] [--parent T] [--json]` — 4-signal verdict; --apply dispatches dissolveEpic only on SAFE-DISSOLVE; §OQ recommendations as-written)
Date: 2026-05-17

## Context

Epic-teams (ADR-090) are spawned via `atmux team spawn-epic` and torn down via
`atmux team dissolve-epic` once their scope is complete. In practice operators
spawn epic-teams faster than they tear them down — a 14-epic-team cockpit
accumulates after a few weeks of work. The dead/stale entries hold cockpit
window slots; the live-but-idle ones hold tmux panes + claude processes
(observed: a 14-epic-team cockpit topping 50 GiB RSS / 192 claude procs).

Today the operator's only sweep path is manual: read cockpit.json, `atmux task
list` each epic-team's kanban, eyeball "all-done? clean? pushed?", then
`atmux team dissolve-epic <epicId>` one by one. The cost is paid every time
RAM pressure surfaces, and the manual gate (verify branch is pushed before a
worktree-prune) is easy to skip under pressure.

`atmux team dissolve-epic` (ADR-090) already enforces the per-team gate (all
tasks `done`/`wontfix` + worktree clean). What's missing is a fleet-level
"show me what's safe to dissolve, dissolve them all" pass.

## Decision

Add `atmux team sweep-epics [--apply] [--idle-hours N] [--parent <team>] [--json]`
— a composition verb that:

1. Walks every enabled `epic-team` in cockpit.json via the existing
   `enabledTeams()` flattener (ADR-089 §F).
2. For each, computes a verdict from four signals (open-task count, last
   commit age, worktree-clean, branch-pushed-to-origin).
3. Renders a markdown table (or JSON with `--json`).
4. With `--apply`, dispatches `dissolveEpic([epicId])` for every
   `SAFE-DISSOLVE` candidate. STALE-IDLE and RISKY candidates are reported
   but **never** auto-dissolved — they need human review.

### Verdict ladder

| Verdict | Trigger | `--apply` action |
|---|---|---|
| `DRAIN` | open tasks > 0 (status NOT IN done/wontfix) | skip — work pending |
| `SAFE-DISSOLVE` | 0 open tasks AND worktree clean AND branch pushed to `origin` | dissolve via ADR-090 |
| `STALE-IDLE` | 0 open tasks AND last commit ≥ `idle-hours` (default 24h) AND **not** branch-pushed | report only — operator must push or investigate first |
| `RISKY` | worktree dirty OR unmerged commits not on origin | report only — manual review |
| `MISSING` | cockpit entry but worktree directory absent | report only — cockpit cleanup needs separate verb |

The strictness of `SAFE-DISSOLVE` is the load-bearing design choice: a
worktree-prune that drops unpushed commits is unrecoverable. Requiring the
branch to be on `origin` means the commits survive prune; the operator can
re-checkout any time.

### Why not just lower `dissolveEpic`'s threshold

ADR-090's gate is per-epic ("this kanban is done; this worktree is clean").
The branch-pushed check is fleet-level safety — operators running sweep over
14 epics shouldn't have to remember to manually verify push state for each.
Adding it to `dissolveEpic` directly would change the contract for callers
that already verified out-of-band; layering it in the sweep keeps both shapes
honest.

### Why not auto-dissolve STALE-IDLE

Empty-kanban epic-teams typically come from one of:

- Just-spawned, planner hasn't filed tasks yet (false-positive — don't kill)
- Planning-state EPIC whose tasks were never decomposed (operator decision)
- Aborted epic that should have been dissolved long ago (true-positive)

The signal is too noisy for automation. Sweep reports them with the age so
the operator decides.

## Consequences

- New verb adds no infrastructure — pure composition over `loadCockpit` +
  `enabledTeams` + `defaultGitSpawn` + `openDatabase` + `dissolveEpic`.
- The `--apply` path runs `dissolveEpic` for each candidate sequentially;
  failures abort the sweep with the failed epicId in the error (no partial
  rollback — each dissolve is independently durable per ADR-090).
- Caller-scope gate is inherited from `dissolveEpic` — sweep itself is
  read-only and runs from any scope; only `--apply` triggers the gate.
- Operator-runnable from the cockpit driver pane via a single command,
  replacing the ~15-min manual sweep observed today.

## Out of scope

- Auto-running on a cron — `sentinel` could call this with `--apply` in
  future, but the current design surfaces it as an operator verb only.
  Cron integration is a separate ADR.
- "Drain mode" that completes leftover tasks before dissolving — DRAIN
  candidates are explicitly skipped; operator routes via `task move`
  manually.
- Cross-team rebalancing (moving members between epic-teams) — that's
  ADR-091 (committer) / ADR-161 (member move) territory.
- Top-level team sweep — only `epic-team` nodes are candidates. Top-level
  teams require explicit `atmux stop`.
