# `src/verbs/` — domain verb files

One file per CLI verb. Each file exports exactly:

```ts
export default async function run(args: string[]): Promise<number>
```

Returning the process exit code. The dispatcher in `src/cli.ts` resolves `verb → file → run` (per [ADR-010](../../docs/adr/103-cli-dispatcher.md)).

## Verb roster (v1, frozen scope)

26 distinct verb files (7 of 32 user-visible verbs are dispatcher-routed aliases):

```
up.ts, init.ts, start.ts, stop.ts, attach.ts, status.ts,
send.ts, tell.ts, reply.ts, kanban.ts, dispatch.ts, inbox.ts, claim.ts,
report.ts, whip.ts, improve.ts, whip-resume-check.ts, watchdog.ts, cost.ts,
rotate.ts, handoff.ts, pause.ts, add-member.ts, reconfigure.ts, dashboard.ts,
doctor.ts
```

`improve.ts` arms the ADR-052 eternal-improvement loop (kanban-empty fallback → autonomous self-improvement cycles, bounded by token budget). Lands as part of the automation bucket alongside `whip` / `report`.

`whip-resume-check.ts` is the ADR-053 1-min cron-precision verb for auto-resume from budget-pause. Lock-skipped on contention; ~1 probe call per active account per tick (mostly cache reads). Cron line is gated on `team.whip.claudeAccount` per `src/core/cron.ts::renderCronBlock`. See [ADR-053 §D4](../../docs/adr/053-budget-observability.md).

`watchdog.ts` is the ADR-057 §D6b heartbeat-staleness detector — a separate `*/2` cron line independent of whip's body-hash logic so a stuck whip doesn't blind the watchdog. On each tick it reads `<atmuxDir>/heartbeats/<member>.epoch`, flags members whose heartbeat is older than `team.whip.stallPrevention.heartbeatStaleSec` (default 300s), fires a 24h-deduped 🛑 `[whip-watchdog]` Discord ping, and audit-logs to `.atmux/logs/watchdog.log`. USAGE: `atmux watchdog [--no-discord] [--team-dir <dir>]`. See [ADR-057 §D6](../../docs/adr/057-stall-prevention.md) and the [stall-recovery runbook](../../docs/RUNBOOK-stall-recovery.md).

## Cursor self-heal recipes (`src/core/cursor-recipes/`)

Per ADR-055 — recipe-driven `cursor-agent` invocations for whitelisted problem classes. NOT verbs (no CLI surface); they're orchestration objects consumed by the whip-tick self-heal pass (`9554f70`). Each recipe at `src/core/cursor-recipes/<recipe>.ts` exports a `CursorRecipe` (`detect → propose → verify`) with `tokenCap` (default 5_000) + `fileAllowlist` (e.g. `["team.json", ".atmux/state/*"]`).

v1 default-enabled recipes: `fix:team-json-schema-drift` / `fix:cron-pollution` / `fix:supervisor-missing`. Operators opt-in via `team.json::whip.selfHealEnabled` + `selfHealRecipes`. Patches stage to `.atmux/state/cursor-self-heal-pending/<recipe>-<ts>.patch` for reviewer-gate — never auto-commit. See HANDOFF.md "🩹 Cursor self-heal" for operator usage + add-a-recipe smoke-test path.

Aliases routed in `src/cli.ts`: `broadcast` → `send`, `tell-lead` → `tell`, `outbox` → `reply`, `task` → `kanban`, `done` → `claim`, `rotate-lead` → `rotate`, `resume` → `pause`.

Sub-verb dispatchers in `src/cli.ts`: `team` → `src/verbs/team/*` (+ `team-repair-rename.ts`), `member` → `dispatchMemberSubverb` in `src/verbs/member.ts`, `sync` → `dispatchSyncSubverb` in `src/verbs/sync.ts` (first sub-verb `claude-team-json` materializes `.claude/team.json` from `.atmux/team.json` per [ADR-164](../../docs/adr/164-sync-claude-team-json.md); T8 covers the broader RUNBOOK + README sweep).

## Layer rules (ADR-003)

- Verbs MAY import from `src/core/*`, `src/abstractions/*`, `src/schema/*`, `src/errors`.
- Verbs MUST NOT import from another verb. Shared logic moves to `src/core/`.
- Verbs MUST NOT contain `JSON.parse` (use `src/abstractions/json.ts`), `Bun.spawn` (use `src/abstractions/spawn.ts`), or `new Date().toLocale*` (use `src/abstractions/time.ts`). Reviewer regex enforces ([ADR-003](../../docs/adr/096-module-taxonomy.md), [ADR-006](../../docs/adr/099-error-handling.md)).

## v2 (Phase 6, ADR-014)

Some verbs collapse into nested subcommands and become folders here (`src/verbs/task/{add,list,claim,done}.ts`, `src/verbs/member/{add,rm,rename,pause,resume}.ts`). v1 stays flat-files.

## Population

Phase 2 work — porter-A and porter-B fill in by verb-split per PLAN.md §6.1:

- **porter-A (lifecycle + state, 13 verbs):** up, init, start, stop, attach, add-member, reconfigure, rotate, handoff, pause, kanban (→ `task`), claim, inbox.
- **porter-B (messaging + supervisor + diag, 10 verbs):** send, tell, reply, dispatch, whip, report, doctor, cost, status, dashboard.
