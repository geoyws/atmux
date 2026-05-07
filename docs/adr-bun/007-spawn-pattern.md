# ADR-007: Subprocess spawn pattern (`Bun.spawn` wrapper)

**Status:** accepted
**Date:** 2026-05-04
**Owner:** architect (drafted to gate Phase 0 exit; foundation porter implements)

## Context

Bash atmux shells out constantly. At HEAD `2aadc3f` the worktree's `lib/` invokes (excluding internal helper functions):

| Tool | Approx. invocations | Pattern |
|---|---|---|
| `tmux` | ~40 across 13 subcommands | one-shot send / capture |
| `jq` | 172 | parse + filter JSON |
| `curl` | 2 | Discord webhook + doctor health probe |
| `flock` | 2 | concurrent-write protection (ADR-005 obsoletes) |
| `mktemp` | 5 | atomic-write tmp file |
| `date` | 8 | timestamps (ADR-012 obsoletes) |
| `command -v` | 7 | doctor `which`-style checks |

After the port:
- `jq` is gone (parsed JSON in-memory via ADR-005).
- `flock`, `mktemp`, `date` move into TS abstractions (ADR-005, ADR-012).
- `tmux`, `curl`, `command -v` remain external shellouts. `command -v` is not a real shell-out — Bun has `Bun.which()`. So it goes too.
- The Discord webhook send goes through `~/.claude/skills/whip/scripts/ping-discord.sh` (per ADR-008), which is itself a shell script the TS code spawns.
- Other shellouts will surface as Phase 2 progresses (e.g. `git` for the auto-dispatch-on-commit feature, `tput` for TUI sizing).

Every external shellout in the bash code today either:

1. Discards stderr (`2>/dev/null`).
2. Discards exit code (`|| true`).
3. Both.

The TS port replaces all of this with **one wrapper** in `src/abstractions/spawn.ts`. Every external invocation goes through it. Every failure becomes a typed error. Every timeout is enforceable.

This is the foundation that ADR-004 (tmux), ADR-008 (discord), and any future shellout-using abstraction sits on top of. ADR-006 declares the error classes `SpawnError` + `SpawnTimeoutError`; this ADR specifies the API that throws them.

## Decision

### Single primary export — `spawn(opts)`

```ts
// src/abstractions/spawn.ts
import { SpawnError, SpawnTimeoutError } from "../errors";

export interface SpawnOpts {
  cmd: string;                          // executable name; resolved via Bun.which if not absolute
  argv: string[];                       // args (no shell parsing)
  stdin?: string | Buffer | Uint8Array; // piped to child's stdin; closed after write
  cwd?: string;                         // default: process.cwd()
  env?: Record<string, string>;         // ADDED to process.env, not replacing
  timeoutMs?: number;                   // default: 30_000
  expectExitCode?: number | number[];   // default: [0]; throws SpawnError if mismatched
  signal?: AbortSignal;                 // external cancellation
  logPrefix?: string;                   // attached to logger output (PLAN.md §10)
}

export interface SpawnResult {
  cmd: string;
  argv: string[];
  exitCode: number;
  signalled: NodeJS.Signals | null;
  stdout: string;                       // captured fully; UTF-8 decode
  stderr: string;                       // captured fully; UTF-8 decode
  durationMs: number;
}

export async function spawn(opts: SpawnOpts): Promise<SpawnResult>;
```

Behaviour:

1. **Resolve `cmd`.** If `cmd` contains a `/`, use as-is. Otherwise resolve via `Bun.which(cmd)` — throws `SpawnError` (tag `spawn`) with `exitCode: -1` and `stderr: "command not found: <cmd>"` if unresolvable. (`-1` is the convention for "didn't run".)
2. **Spawn.** Use `Bun.spawn({ cmd: [cmd, ...argv], stdin, cwd, env, stdout: "pipe", stderr: "pipe" })`. Write stdin (if given), close.
3. **Wait with timeout.** Race `proc.exited` against `Bun.sleep(timeoutMs)`. On timeout: `proc.kill("SIGTERM")`; sleep 1s grace; if still alive, `proc.kill("SIGKILL")`; throw `SpawnTimeoutError`.
4. **Validate exit code.** `expectExitCode` defaults to `[0]`. Caller can pass `0` (single), `[0, 1]` (e.g. `tmux has-session`), `[0, 1, 2]` (e.g. `grep`), or `"any"` for "don't validate" (rare; document at call site).
5. **On mismatch.** Throw `SpawnError` with full `argv`, `exitCode`, `stderr`, `stdout`, captured.
6. **On match.** Resolve with `SpawnResult`.
7. **On `AbortSignal`.** If signal fires during exec: kill (SIGTERM → SIGKILL same as timeout), throw `SpawnError` with `cause: signal.reason`.

### Streaming variant — `spawnStream(opts)`

For long-running processes where we don't want to buffer all output (tmux attach, dashboard's pane capture loop):

```ts
export interface SpawnStreamOpts extends Omit<SpawnOpts, "expectExitCode"> {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  expectExitCode?: number | number[] | "any";  // same as spawn; default 0
}

export interface SpawnStreamHandle {
  pid: number;
  exited: Promise<SpawnResult>;       // resolves with full SpawnResult once child exits
  kill(signal?: NodeJS.Signals): void;
  writeStdin(data: string | Uint8Array): Promise<void>;
  closeStdin(): Promise<void>;
}

export function spawnStream(opts: SpawnStreamOpts): SpawnStreamHandle;
```

`spawnStream` is for the rare cases (`attach`, `dashboard --interval`) where a verb interactively manages a child. The default for everything else is `spawn()`.

### Logging

`spawn` integrates with the atmux logger (per PLAN.md §10):

```ts
// Implementation pseudo-sketch
const log = logger.child({ verb: getCurrentVerb(), team: getCurrentTeam(), member: getCurrentMember() });
log.debug(`spawn: ${cmd} ${argv.join(" ")}`, { logPrefix: opts.logPrefix });
// …after child exit:
log.debug(`spawn: ${cmd} → exit ${exitCode} in ${durationMs}ms`);
```

The `{verb} {team} {member}` prefix convention is preserved from bash atmux (PLAN.md §10 logger note). When debug logging is on (`ATMUX_DEBUG=1`), every spawn emits a one-line entry on `stderr`.

Stderr-on-failure is logged separately. `SpawnError` includes the full stderr in `.context.stderr`, so debug log always has the diagnosis.

### MYT-aware timestamps

Logger uses `time.formatMyt()` from `src/abstractions/time.ts` (per ADR-012) for log line timestamps. No `Date()` usage in `spawn.ts` itself except via `Bun.nanoseconds()` for duration measurement (which is monotonic + locale-blind).

### What this wrapper does NOT do

- **No shell.** `cmd` + `argv` are passed as a flat array to `Bun.spawn`; no shell interpretation. If a caller needs shell features, they spawn `bash -c '<script>'` explicitly (and own the quoting).
- **No retry.** Retries are caller responsibility. Some callers (Discord webhook post; HTTP probes) want exponential-backoff retry; that lives in the caller's logic, not in spawn.
- **No streaming-and-buffering hybrid.** Either `spawn` (full buffer) or `spawnStream` (streaming). Not both.
- **No PTY.** `Bun.spawn` doesn't allocate a TTY by default; we don't need one for any current verb. If the dashboard verb someday needs raw PTY, that's a separate ADR.

### Test pattern

`spawn.ts` has unit tests at `tests/unit/abstractions/spawn.test.ts`:

- Argv echo tests (`spawn({ cmd: "echo", argv: ["hi"] })` returns `stdout: "hi\n"`).
- Exit code validation (`spawn({ cmd: "false" })` throws `SpawnError`; `expectExitCode: [0, 1]` accepts).
- Timeout (`spawn({ cmd: "sleep", argv: ["10"], timeoutMs: 100 })` throws `SpawnTimeoutError` within ~150ms).
- Stdin pipe (`spawn({ cmd: "cat", stdin: "hello" })` returns `stdout: "hello"`).
- AbortSignal cancellation.
- Bun.which resolution (`spawn({ cmd: "definitely-not-a-command" })` throws `SpawnError`).

For higher-layer tests (verb tests), `spawn` is mocked: replace `import { spawn } from "../abstractions/spawn"` with a fixture that returns canned `SpawnResult`s keyed by argv. Foundation porter ships a `tests/helpers/mockSpawn.ts` for this.

## Consequences

**Positives:**

- Every external invocation goes through one place. ADR-006 R4 (no `Bun.spawn` outside this file) is mechanically enforceable.
- Stderr is captured even on success (it's just discarded by callers that don't read it). Diagnostic-on-failure is automatic.
- Timeout is mandatory-with-default. No process can leak indefinitely.
- Streaming variant lets attach/dashboard verbs avoid the all-or-nothing buffering trap.
- AbortSignal support means a future "cancel current verb" implementation (Ctrl-C-handler in `cli.ts`) is possible without rewriting every IO call.
- `expectExitCode` array semantics handle bash atmux's actual patterns: `tmux has-session` (0 or 1) is now typed at the call site, not silently swallowed.
- Logging integration delivers the `{verb} {team} {member}` prefix discipline from PLAN.md §10 without per-call ceremony.

**Negatives:**

- Foundation porter implements ~300 LOC of wrapper + test. Real work, but it pays back forever.
- Streaming + buffering are different APIs; choosing wrong loses ergonomics. Mitigated by `spawn` being the obvious default and `spawnStream` reserved for known cases.
- `signal` parameter forces every spawn-using abstraction to plumb cancellation if it wants it. Phase 1 starts without cancellation; Phase 2 verbs that want it opt in.
- AbortSignal + Bun.spawn integration is nuanced (Bun's API is async); foundation porter must verify the SIGTERM-then-SIGKILL grace works correctly. Smoke test in unit suite.
- Bun.which is not perfectly cross-platform; on macOS some PATH entries (`/opt/homebrew/bin`) need explicit env handling. Documented in the foundation porter's notes; tested.

**Follow-up tickets:**

- Foundation porter (Phase 1) implements `src/abstractions/spawn.ts` + tests as part of #18 (skeleton + Phase 1 work).
- Foundation porter writes `tests/helpers/mockSpawn.ts` for verb-test injection.
- ADR-004 (tmux) consumes `spawn` for every subcommand wrap.
- ADR-008 (discord) consumes `spawn` for the Discord shell-script call.
- Doctor verb (Phase 2) replaces `command -v` checks with `Bun.which()` (no shellout needed; faster).

## Alternatives considered

### A. Use `node:child_process` directly

Considered. Works in Bun, more familiar to Node devs. Rejected because `Bun.spawn` has cleaner async semantics (`proc.exited` is a real Promise, no event-listener dance) and integrates with Bun's runtime monitor. We're committed to Bun (ADR-001); using its native primitive is the consistent choice.

### B. Use `execa` npm dep

Surveyed. `execa` is a popular wrapper around `child_process` with sensible defaults (throw on non-zero, stderr capture, timeout). We'd need it if we were on Node. On Bun, `Bun.spawn` already gives us most of what `execa` adds; the remaining ~100 LOC of wrapping is what this ADR specifies. Avoiding the dep keeps supply-chain surface tight and makes the hot-path code legible without crossing a lib boundary in the debugger.

### C. Multiple specialized wrappers (`spawnTmux`, `spawnCurl`, `spawnGit`)

Rejected. Per-subsystem wrappers belong at the abstraction layer (`tmux.ts`, `discord.ts`). The spawn wrapper is one layer below — it doesn't know about subsystems. Putting tmux-specific argv-construction in `spawn.ts` would violate ADR-003 (abstractions don't know about each other's domains).

### D. Use a libuv-style poll loop with raw `posix_spawn`

Comically out of scope. Bun.spawn already does this for us. We'd be reinventing the runtime.

### E. Block on `Bun.spawnSync` and skip async entirely

Rejected. atmux is async-IO heavy (tmux + Discord + lock + JSON file all happen interleaved within a single verb). `spawnSync` would serialize work that has no reason to be serial. Async is the default; sync is for nothing in v1 scope.

## References

- PLAN.md §10 (tooling table — Bun's native fetch + spawn justification)
- ADR-001 Pressure 2 (silent error swallow; bash spawns are the primary instance)
- ADR-003 (module taxonomy — `spawn.ts` is one of the 8 abstractions; everyone shells out through it)
- ADR-004 (tmux abstraction — consumer)
- ADR-006 (error handling — declares `SpawnError`, `SpawnTimeoutError`)
- ADR-008 (discord webhook — consumer)
- ADR-012 (time + timezone — logger uses `time.formatMyt`)
- bash `lib/common.sh` and elsewhere — every `2>/dev/null || true` is the pattern this wrapper closes
