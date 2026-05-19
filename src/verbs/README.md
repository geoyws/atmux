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

Sub-verb dispatchers in `src/cli.ts`: `team` → `src/verbs/team/*` (+ `team-repair-rename.ts`), `member` → `dispatchMemberSubverb` in `src/verbs/member.ts`, `sync` → `dispatchSyncSubverb` in `src/verbs/sync.ts`.

### `sync claude-team-json` ([ADR-164](../../docs/adr/164-sync-claude-team-json.md))

Materializes `.claude/team.json` from `.atmux/team.json` — closes the legacy `.claude/team.json` drift operators hit when migrating off the Claude `/team` skill family. Core compute path lives in `src/core/sync-claude-team-json/{index,mapping,color-map,name-rewrite,drift,diff,types}.ts`; the dispatcher (`src/verbs/sync.ts`) only handles flag-parse, dry-run preview, write-path composition, and `DriftAbortError → exit 65` translation.

Flag surface:

- `--dry-run` — render +/-/space unified-diff preview to stdout + exit 0 without writing (ADR-164 §step 8).
- `--overwrite-briefs` — replace hand-authored Claude-side `role` text with the atmux role-enum; off-by-default preserves expensive briefs (§OQ-4).
- `--force` — override drift refusal when the on-disk `_atmuxSync` fingerprint mismatches the file's current member roster (§step 5 + §OQ-5).

Exit codes: `0` success, `64` (EX_USAGE) bad flags, `65` (EX_DATAERR) drift refused.

Operator one-pager: [docs/RUNBOOK-sync.md](../../docs/RUNBOOK-sync.md). Migrator README entry: [README.md §"Migrating off the Claude `/team` skill"](../../README.md).

### `cockpit rotate` ([ADR-167](../../docs/adr/167-cockpit-rotate-verb.md))

Operator-fired rotation of cockpit role panes (`medic` / `sentinel` / `<team-name>`) with brief-paste-ready handoff. Closes Rung C of the `/bruh` escalation chain — the previously manual handoff + Ctrl-C + canonical-respawn protocol. Lives in [`src/verbs/cockpit-rotate.ts`](cockpit-rotate.ts) and dispatched from `src/verbs/cockpit.ts` (sub-verb pattern, sibling to `cockpit rebuild` + `cockpit migrate-socket`).

Flag surface:

- `<session-name>` — required positional: `medic`, `sentinel`, or a registered team-name. `superdriver` is unconditionally refused (operator REPL pane).
- `--force` — bypass pre-flight gates 1-3 (user-not-typing, pane-idle, uptime) ONLY. Gate 4 (never-rotate-superdriver) is unconditional.

Exit codes: `0` success, `64` (EX_USAGE) bad argv, `65` (EX_DATAERR) gate refusal (1-4), `70` (EX_SOFTWARE) respawn / handoff-write failure, `78` (EX_CONFIG) caller-scope refusal (driver-only per [ADR-033](../../docs/adr/033-caller-scope-gate.md)).

Side effects: writes per-role handoff Markdown to `~/.claude/teams/__cockpit__/<role>/handoff.md` (atomic-write, 100KB soft cap); appends NDJSON audit row to `~/.atmux/state/cockpit-rotate-audit.log`; fires `cockpit-rotate-refused` Discord template on gate refusal. The c-alias wrapper resolver lives at [`src/abstractions/claude-account-wrapper.ts`](../abstractions/claude-account-wrapper.ts) per [ADR-094](../../docs/adr/094-c-alias-spawn-convention.md).

Operator one-pager: [docs/RUNBOOK-cockpit.md §6](../../docs/RUNBOOK-cockpit.md).

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
