# ADR-180: Human-attach verb (`--human` flag, TTY-inherit spawn carve-out)

**Status:** accepted
**Date:** 2026-05-18
**Owner:** driver (George)

## Context

ADR-100 fixes the spawn pattern: every external shellout goes through `spawn()` in `src/abstractions/spawn.ts`, which calls `Bun.spawn` with `stdin: "ignore" | "pipe"`, `stdout: "pipe"`, `stderr: "pipe"`. The pipes are essential for the agent caller — atmux is invoked headless by leads, members, cron, and watchdogs; those callers want exit codes + captured stderr, never a controlling terminal.

This breaks for one verb family: anything that calls `tmux attach-session`. tmux requires a controlling tty on stdin/stdout and exits 1 with `open terminal failed: not a terminal` when stdio is piped. The bug is observable today for `atmux cockpit attach` (added at commit 8f17885) and would surface the same way for `atmux attach` if a human ever tried it from a real shell. The verb test (`tests/unit/verbs/cockpit.test.ts:3014-3029`) and the abstraction-level test (`tests/unit/abstractions/tmux.test.ts:510-514`) both assert the failure path and call out the "no tty in `bun:test`" coverage gap — confirming the success path has never run end-to-end inside this codebase.

The workaround until now has been a shell alias that bypasses atmux and calls `tmux -L atmux-cockpit attach-session -t atmux_cockpit` directly. That works but loses atmux's config resolution (`ATMUX_COCKPIT_SOCKET` env override, `cockpit.json`-driven session name, future ADR-162 socket renames).

We want a real verb shape so the human entry point inherits atmux's resolution layer without inheriting the pipe-only spawn shape.

## Decision

### 1. New flag — `atmux cockpit attach --human`

`atmux cockpit attach` keeps its current shape (agent path: piped stdio, exits 1 on no-tty, useful for "is the cockpit alive?" probes). The `--human` flag opts into the inherit-stdio path: atmux resolves socket + session as before, then spawns `tmux attach-session` with the parent process's stdin/stdout/stderr inherited so a real TTY flows through to tmux.

**Rejection rules:** `--human` is rejected on `rebuild`, `reload`, `migrate-socket` — they have no attach step. Combined with `--config <path>` is fine (config resolves the socket/session before the attach).

Future work: wire the same flag through `atmux attach` (team cage attach). Not in this ADR — keeps the surface minimal and lets us validate the cockpit path before generalising.

### 2. New spawn primitive — `spawnInheritStdio(opts)`

Add a second export to `src/abstractions/spawn.ts`:

```ts
export interface SpawnInheritStdioOpts {
  cmd: string;
  argv?: ReadonlyArray<string>;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
}

export async function spawnInheritStdio(opts: SpawnInheritStdioOpts): Promise<number>;
```

Behaviour: resolve `cmd` (Bun.which the same way `spawn()` does), `Bun.spawn` with `stdin: "inherit"`, `stdout: "inherit"`, `stderr: "inherit"`, await `proc.exited`, return `exitCode ?? -1`. No buffering, no timeout (the call is interactive and blocks until the user detaches), no exit-code validation (the caller decides what nonzero means — for tmux attach, nonzero is the legitimate "not a tty" or "session vanished" surface and propagates as a `TmuxError`).

R4 still holds: `Bun.spawn` lives in `spawn.ts` and nowhere else. `spawnInheritStdio` is the second public callsite, used only by inherit-stdio-needing tmux verbs.

### 3. New tmux abstraction method — `client.attachSessionInheritStdio(name)`

Add a sibling to `client.attachSession(name)` on `TmuxNamespace`. Implementation calls `spawnInheritStdio({ cmd: "tmux", argv: [...socketArgs, "attach-session", "-t", name] })` and wraps a non-zero exit code in `TmuxError` so error handling stays uniform across the namespace.

### 4. `attachWithTmux` gets an `inheritStdio` opt

`src/verbs/attach.ts` already factors the team-attach driver into `attachWithTmux(tmux, sessionName)`. Extend its signature:

```ts
attachWithTmux(tmux, sessionName, opts?: { inheritStdio?: boolean }): Promise<number>
```

When `opts.inheritStdio` is true, call `tmux.client.attachSessionInheritStdio(target)` instead of `attachSession(target)`. The `$TMUX` env unset/restore dance still wraps both paths.

### 5. `cockpit attach` wiring

`parseCockpitArgs` accepts `--human`; rejects it on every sub-verb except `attach`. `ParsedCockpitArgs` grows a `human: boolean` field. `cockpitAttach()` passes `{ inheritStdio: parsed.human }` into `attachWithTmux`.

## Consequences

### Positive

- Human-typed `aca` works end-to-end without bypassing atmux's resolution layer. Env-override + cockpit.json-driven session name keep working.
- Agent callers see no behaviour change (`atmux cockpit attach` without `--human` keeps the piped-stdio shape).
- The carve-out is named and bounded — `spawnInheritStdio` exists for one purpose; any future tty-required tmux verb wires through the same path instead of growing a one-off `Bun.spawn` inside a verb.

### Negative

- Two spawn primitives + two attach-session methods to maintain. Mitigated by the narrow surface: only tmux attach-session needs the inherit path.
- atmux stays in the process tree as tmux's parent (we can't `execvp` from Bun without FFI). For typical detach/exit flows this is fine; for edge cases involving SIGTSTP forwarding or process-group ops, the behaviour may differ from `exec tmux …`. If issues surface, the upgrade path is FFI execvp, not redesign.
- Test coverage of the actual TTY path remains a `bun:test` gap (same constraint as `attachSession`). Tests cover argv-construction + dispatch shape; the runtime smoke test is the operator typing `aca`.

### Carve-out to ADR-100

ADR-100 §"Single primary export" stands. `spawnInheritStdio` is an explicit secondary export for the tty-required case, not a generalisation of `spawn`. Reviewer-gate regex `\bBun\.spawn\s*\(` continues to flag any third `Bun.spawn` callsite outside `spawn.ts`.

## Related

- ADR-100 — Subprocess spawn pattern (primary, piped-stdio default).
- ADR-162 — atmux owns tmux infrastructure (cockpit socket naming).
- ADR-135 — Cockpit naming convention (`atmux_cockpit` session, `atmux-cockpit` socket).
- Commit 8f17885 — `atmux cockpit attach` introduction (the verb this ADR repairs for human use).
