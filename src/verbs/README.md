# `src/verbs/` — domain verb files

One file per CLI verb. Each file exports exactly:

```ts
export default async function run(args: string[]): Promise<number>
```

Returning the process exit code. The dispatcher in `src/cli.ts` resolves `verb → file → run` (per [ADR-010](../../docs/adr-bun/010-cli-dispatcher.md)).

## Verb roster (v1, frozen scope)

23 distinct verb files (7 of 30 user-visible verbs are dispatcher-routed aliases):

```
up.ts, init.ts, start.ts, stop.ts, attach.ts, status.ts,
send.ts, tell.ts, reply.ts, kanban.ts, dispatch.ts, inbox.ts, claim.ts,
report.ts, whip.ts, cost.ts, rotate.ts, handoff.ts, pause.ts,
add-member.ts, reconfigure.ts, dashboard.ts, doctor.ts
```

Aliases routed in `src/cli.ts`: `broadcast` → `send`, `tell-lead` → `tell`, `outbox` → `reply`, `task` → `kanban`, `done` → `claim`, `rotate-lead` → `rotate`, `resume` → `pause`.

## Layer rules (ADR-003)

- Verbs MAY import from `src/core/*`, `src/abstractions/*`, `src/schema/*`, `src/errors`.
- Verbs MUST NOT import from another verb. Shared logic moves to `src/core/`.
- Verbs MUST NOT contain `JSON.parse` (use `src/abstractions/json.ts`), `Bun.spawn` (use `src/abstractions/spawn.ts`), or `new Date().toLocale*` (use `src/abstractions/time.ts`). Reviewer regex enforces ([ADR-003](../../docs/adr-bun/003-module-taxonomy.md), [ADR-006](../../docs/adr-bun/006-error-handling.md)).

## v2 (Phase 6, ADR-014)

Some verbs collapse into nested subcommands and become folders here (`src/verbs/task/{add,list,claim,done}.ts`, `src/verbs/member/{add,rm,rename,pause,resume}.ts`). v1 stays flat-files.

## Population

Phase 2 work — porter-A and porter-B fill in by verb-split per PLAN.md §6.1:

- **porter-A (lifecycle + state, 13 verbs):** up, init, start, stop, attach, add-member, reconfigure, rotate, handoff, pause, kanban (→ `task`), claim, inbox.
- **porter-B (messaging + supervisor + diag, 10 verbs):** send, tell, reply, dispatch, whip, report, doctor, cost, status, dashboard.
