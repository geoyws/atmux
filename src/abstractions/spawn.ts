// ADR-007: Subprocess spawn pattern.
//
// The ONLY module allowed to call `Bun.spawn`. R4 (per ADR-006) is a
// reviewer-enforced regex against `\bBun\.spawn\s*\(` outside this file
// (and `tests/parity/runner.ts` which has the harness carve-out).
//
// `spawn(opts)` is the buffered default; everything not explicitly
// streaming uses it. `spawnStream(opts)` is for tmux attach / dashboard
// loops where buffering all stdout is wrong.

import { SpawnError, SpawnTimeoutError } from "../errors.ts";

// ---------- Types ----------

/** Either a single accepted exit code, an array of accepted exit codes,
 *  or `"any"` — the wildcard that disables exit-code validation. */
export type ExpectExitCode = number | ReadonlyArray<number> | "any";

export interface SpawnOpts {
  /** Executable name. If it contains `/` it's used verbatim; otherwise
   *  resolved via `Bun.which`. Throws `SpawnError(exitCode=-1)` on miss. */
  cmd: string;
  /** Argv tail (no shell parsing). */
  argv?: ReadonlyArray<string>;
  /** Optional stdin payload. Closed after write. */
  stdin?: string | Uint8Array;
  /** cwd override; defaults to `process.cwd()`. */
  cwd?: string;
  /** Env vars merged on top of `process.env`, NOT replacing it. */
  env?: Readonly<Record<string, string>>;
  /** Env var names DELETED from the merged result — i.e. the child sees
   *  them as absent, not as empty (ADR-281). `env` can only add or
   *  override; this is the only way to express "must not exist". Applied
   *  AFTER `env`, so deletion is the last word (see `mergeEnv`). */
  unsetEnv?: ReadonlyArray<string>;
  /** Hard timeout. Default 30_000ms. SIGTERM → 1s grace → SIGKILL. */
  timeoutMs?: number;
  /** Accepted exit code(s). Default `0`. Use `"any"` for "don't validate". */
  expectExitCode?: ExpectExitCode;
  /** External cancellation. Behaves identically to a timeout fire. */
  signal?: AbortSignal;
}

export interface SpawnResult {
  cmd: string;
  argv: ReadonlyArray<string>;
  exitCode: number;
  signalled: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface SpawnStreamOpts extends Omit<SpawnOpts, "expectExitCode"> {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  expectExitCode?: ExpectExitCode;
}

export interface SpawnStreamHandle {
  pid: number;
  exited: Promise<SpawnResult>;
  kill(signal?: NodeJS.Signals): void;
  writeStdin(data: string | Uint8Array): Promise<void>;
  closeStdin(): Promise<void>;
}

// ---------- Buffered spawn ----------

/** Operator override per t-681e5b91 (sopx submodule-init >30s on epic-team
 *  spawn). Env-parse fails closed to the 30s default if the value is missing,
 *  non-numeric, non-finite, or non-positive — submodule-heavy teams export
 *  `ATMUX_SPAWN_TIMEOUT_MS=120000` (or higher) at team-start time. Exported
 *  for direct unit-test coverage; the module-load resolution snapshots the
 *  value into `DEFAULT_TIMEOUT_MS`. */
export function resolveDefaultTimeoutMs(): number {
  const raw = process.env.ATMUX_SPAWN_TIMEOUT_MS;
  if (raw === undefined || raw === "") return 30_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 30_000;
  return parsed;
}

const DEFAULT_TIMEOUT_MS = resolveDefaultTimeoutMs();
const SIGKILL_GRACE_MS = 1_000;

/** Default hard timeout for shell-out-to-`git` wrappers
 *  (`worktree.ts` / `auto-done.ts` / `auto-push.ts` `defaultGitSpawn`).
 *  A distinct seam from {@link resolveDefaultTimeoutMs}'s
 *  `ATMUX_SPAWN_TIMEOUT_MS` (the tmux/cold-submodule-init spawn default):
 *  git plumbing calls (`worktree add`, `rev-parse`, `status`) are normally
 *  sub-second, but cold submodule fetch over a slow link or a large pack
 *  can blow past 30s. Operators bump `ATMUX_GIT_TIMEOUT_MS` per
 *  e-268447e2 T1 (t-e32bdf73). */
export const DEFAULT_GIT_SPAWN_TIMEOUT_MS = 30_000;

/**
 * Resolve the git-spawn timeout with precedence:
 *   `optTimeoutMs` (per-call) > env `ATMUX_GIT_TIMEOUT_MS` > {@link DEFAULT_GIT_SPAWN_TIMEOUT_MS}.
 *
 * Both the per-call override and the env value fail closed to the default
 * when non-finite or non-positive (mirrors {@link resolveDefaultTimeoutMs}):
 * a `0`, negative, `NaN`, or `Infinity` value is treated as "unset" rather
 * than disabling the timeout, so a fat-fingered export can't strand a git
 * call forever.
 */
export function resolveGitTimeoutMs(optTimeoutMs?: number): number {
  if (optTimeoutMs !== undefined && Number.isFinite(optTimeoutMs) && optTimeoutMs > 0) {
    return optTimeoutMs;
  }
  const raw = process.env.ATMUX_GIT_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_GIT_SPAWN_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_GIT_SPAWN_TIMEOUT_MS;
  return parsed;
}

/**
 * Spawn `cmd argv` and resolve with full `SpawnResult` once the child
 * exits within `timeoutMs`. Validates exit code against `expectExitCode`.
 */
export async function spawn(opts: SpawnOpts): Promise<SpawnResult> {
  const argv = opts.argv ?? [];
  const cmdResolved = resolveCmd(opts.cmd, argv);
  const expect = opts.expectExitCode ?? 0;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = mergeEnv(opts.env, opts.unsetEnv);
  const start = nowMs();

  const proc = Bun.spawn({
    cmd: [cmdResolved, ...argv],
    cwd: opts.cwd ?? process.cwd(),
    env,
    stdin: opts.stdin !== undefined ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  // Pipe stdin if requested, then close.
  if (opts.stdin !== undefined && proc.stdin) {
    const w = proc.stdin as { write?: (b: Uint8Array | string) => unknown; end?: () => unknown };
    if (w.write) w.write(opts.stdin);
    if (w.end) w.end();
  }

  // Race exit vs. timeout vs. abort.
  const timeoutHandle = setTimeoutToken(timeoutMs);
  const abortHandle = abortToken(opts.signal);

  let stdout = "";
  let stderr = "";
  let killed: "timeout" | "abort" | null = null;

  const outPromise = readStream(proc.stdout).then((s) => {
    stdout = s;
  });
  const errPromise = readStream(proc.stderr).then((s) => {
    stderr = s;
  });

  try {
    await Promise.race([
      proc.exited,
      timeoutHandle.fire.then(() => {
        killed = "timeout";
        return killTree(proc);
      }),
      abortHandle.fire.then(() => {
        killed = "abort";
        return killTree(proc);
      }),
    ]);
    // Always wait for actual exit so exitCode is final.
    await proc.exited;
    await Promise.all([outPromise, errPromise]);
  } finally {
    timeoutHandle.cancel();
    abortHandle.cancel();
  }

  const durationMs = nowMs() - start;
  const exitCode = proc.exitCode ?? -1;
  const signalled = signalNameFromExit(proc);

  if (killed === "timeout") {
    throw new SpawnTimeoutError({ cmd: opts.cmd, argv, timeoutMs });
  }
  if (killed === "abort") {
    throw new SpawnError({
      cmd: opts.cmd,
      argv,
      exitCode,
      stderr,
      stdout,
      cause: opts.signal?.reason ?? new Error("aborted"),
    });
  }
  if (!exitCodeAccepted(exitCode, expect)) {
    throw new SpawnError({ cmd: opts.cmd, argv, exitCode, stderr, stdout });
  }

  return {
    cmd: opts.cmd,
    argv,
    exitCode,
    signalled,
    stdout,
    stderr,
    durationMs,
  };
}

// ---------- TTY-inherit spawn (ADR-180) ----------

/** Options for `spawnInheritStdio` — narrow on purpose. No timeout (the
 *  call is interactive and blocks until the user detaches), no
 *  `expectExitCode` (the caller maps non-zero however suits — tmux
 *  attach surfaces nonzero as `TmuxError`), no stdin payload (stdio is
 *  inherited, not piped). */
export interface SpawnInheritStdioOpts {
  cmd: string;
  argv?: ReadonlyArray<string>;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  /** See `SpawnOpts.unsetEnv` (ADR-281). Same delete-after-merge rule. */
  unsetEnv?: ReadonlyArray<string>;
}

/**
 * Spawn `cmd argv` with the parent process's stdin/stdout/stderr
 * inherited (controlling tty flows through). Resolves with the child's
 * exit code; caller decides what nonzero means.
 *
 * ADR-180 carve-out to ADR-100. The only legitimate callsite today is
 * `client.attachSessionInheritStdio` in `abstractions/tmux.ts`, used
 * when the verb is human-typed (`atmux cockpit attach --human`) and
 * therefore guaranteed to have a real tty on fds 0/1/2. The agent path
 * stays on the piped `spawn()` default.
 */
export async function spawnInheritStdio(opts: SpawnInheritStdioOpts): Promise<number> {
  const argv = opts.argv ?? [];
  const cmdResolved = resolveCmd(opts.cmd, argv);
  const env = mergeEnv(opts.env, opts.unsetEnv);
  const proc = Bun.spawn({
    cmd: [cmdResolved, ...argv],
    cwd: opts.cwd ?? process.cwd(),
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
  return proc.exitCode ?? -1;
}

// ---------- Streaming spawn ----------

/**
 * Spawn `cmd argv` with onStdout / onStderr callbacks. Returns a handle
 * the caller can `kill()` / `writeStdin()` / await `exited` on.
 */
export function spawnStream(opts: SpawnStreamOpts): SpawnStreamHandle {
  const argv = opts.argv ?? [];
  const cmdResolved = resolveCmd(opts.cmd, argv);
  const expect = opts.expectExitCode ?? 0;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = mergeEnv(opts.env, opts.unsetEnv);
  const start = nowMs();

  const proc = Bun.spawn({
    cmd: [cmdResolved, ...argv],
    cwd: opts.cwd ?? process.cwd(),
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  let stdoutBuf = "";
  let stderrBuf = "";
  const stdoutPromise = streamWithCallback(proc.stdout, (s) => {
    stdoutBuf += s;
    opts.onStdout?.(s);
  });
  const stderrPromise = streamWithCallback(proc.stderr, (s) => {
    stderrBuf += s;
    opts.onStderr?.(s);
  });

  const timeoutHandle = setTimeoutToken(timeoutMs);
  const abortHandle = abortToken(opts.signal);
  let killed: "timeout" | "abort" | null = null;

  const exited: Promise<SpawnResult> = (async () => {
    try {
      await Promise.race([
        proc.exited,
        timeoutHandle.fire.then(() => {
          killed = "timeout";
          return killTree(proc);
        }),
        abortHandle.fire.then(() => {
          killed = "abort";
          return killTree(proc);
        }),
      ]);
      await proc.exited;
      await Promise.all([stdoutPromise, stderrPromise]);
    } finally {
      timeoutHandle.cancel();
      abortHandle.cancel();
    }
    const exitCode = proc.exitCode ?? -1;
    const durationMs = nowMs() - start;
    const signalled = signalNameFromExit(proc);
    if (killed === "timeout") {
      throw new SpawnTimeoutError({ cmd: opts.cmd, argv, timeoutMs });
    }
    if (killed === "abort") {
      throw new SpawnError({
        cmd: opts.cmd,
        argv,
        exitCode,
        stderr: stderrBuf,
        stdout: stdoutBuf,
        cause: opts.signal?.reason ?? new Error("aborted"),
      });
    }
    if (!exitCodeAccepted(exitCode, expect)) {
      throw new SpawnError({
        cmd: opts.cmd,
        argv,
        exitCode,
        stderr: stderrBuf,
        stdout: stdoutBuf,
      });
    }
    return {
      cmd: opts.cmd,
      argv,
      exitCode,
      signalled,
      stdout: stdoutBuf,
      stderr: stderrBuf,
      durationMs,
    };
  })();

  return {
    pid: proc.pid,
    exited,
    kill: (signal: NodeJS.Signals = "SIGTERM"): void => {
      try {
        proc.kill(signal);
      } catch {
        /* expected: kill on already-exited child is a no-op */
      }
    },
    writeStdin: async (data: string | Uint8Array): Promise<void> => {
      const w = proc.stdin as { write?: (b: Uint8Array | string) => unknown };
      if (w.write) w.write(data);
    },
    closeStdin: async (): Promise<void> => {
      const w = proc.stdin as { end?: () => unknown };
      if (w.end) w.end();
    },
  };
}

// ---------- Internals ----------

function resolveCmd(cmd: string, argv: ReadonlyArray<string>): string {
  if (cmd.includes("/")) return cmd;
  const resolved = Bun.which(cmd);
  if (!resolved) {
    throw new SpawnError({
      cmd,
      argv,
      exitCode: -1,
      stderr: `command not found: ${cmd}`,
    });
  }
  return resolved;
}

/** Build the child's environment: `process.env` → `extra` on top →
 *  `unset` deleted.
 *
 *  ADR-281. `extra` alone can only ADD or OVERRIDE, and the value type is
 *  `string`, so "this variable must not exist in the child" was
 *  previously unrepresentable — `{ NO_COLOR: "" }` is a DIFFERENT
 *  observable state (defined-but-empty; some consumers treat that as set,
 *  others as unset — ADR-277 §D1 rejects it for exactly that reason).
 *
 *  Ordering is deliberate and documented: deletion runs AFTER the merge,
 *  so `unset` WINS over a contradicting `extra` key. A caller that says
 *  both "set X" and "unset X" gets the absent form. The alternative
 *  (refusing the contradiction with a throw) would make the invariant
 *  runtime-conditional at every call site; making deletion the last word
 *  keeps "this variable cannot reach the child" unconditional, which is
 *  the whole point of the seam.
 *
 *  This NEVER touches `process.env` — atmux's own stdout keeps honouring
 *  https://no-color.org via `src/core/tui.ts::defaultPalette`, which reads
 *  `process.env` at call time. Only the child's copy is rewritten. */
function mergeEnv(
  extra?: Readonly<Record<string, string>>,
  unset?: ReadonlyArray<string>,
): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") base[k] = v;
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) base[k] = v;
  }
  if (unset) {
    for (const k of unset) delete base[k];
  }
  return base;
}

async function readStream(stream: ReadableStream<Uint8Array> | undefined): Promise<string> {
  if (!stream) return "";
  return new Response(stream).text();
}

async function streamWithCallback(
  stream: ReadableStream<Uint8Array> | undefined,
  onChunk: (chunk: string) => void,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let done = false;
  while (!done) {
    const r = await reader.read();
    done = r.done;
    if (!done) {
      const text = decoder.decode(r.value, { stream: true });
      if (text.length > 0) onChunk(text);
    }
  }
  const tail = decoder.decode();
  if (tail.length > 0) onChunk(tail);
}

function exitCodeAccepted(exitCode: number, expect: ExpectExitCode): boolean {
  if (expect === "any") return true;
  if (typeof expect === "number") return exitCode === expect;
  return expect.includes(exitCode);
}

function signalNameFromExit(proc: {
  signalCode?: NodeJS.Signals | number | null;
}): NodeJS.Signals | null {
  const s = proc.signalCode;
  if (typeof s === "string") return s;
  return null;
}

interface CancelToken {
  /** Resolves when the underlying timer / signal fires. */
  fire: Promise<void>;
  /** Idempotent. Cancels the timer / detaches the signal listener. */
  cancel(): void;
}

function setTimeoutToken(ms: number): CancelToken {
  if (!Number.isFinite(ms) || ms <= 0) {
    return { fire: new Promise<void>(() => {}), cancel: () => {} };
  }
  let id: ReturnType<typeof setTimeout> | null = null;
  const fire = new Promise<void>((resolve) => {
    id = setTimeout(resolve, ms);
  });
  return {
    fire,
    cancel: () => {
      if (id !== null) clearTimeout(id);
      id = null;
    },
  };
}

function abortToken(signal?: AbortSignal): CancelToken {
  if (!signal) {
    return { fire: new Promise<void>(() => {}), cancel: () => {} };
  }
  if (signal.aborted) {
    return { fire: Promise.resolve(), cancel: () => {} };
  }
  let listener: (() => void) | null = null;
  const fire = new Promise<void>((resolve) => {
    listener = () => resolve();
    signal.addEventListener("abort", listener, { once: true });
  });
  return {
    fire,
    cancel: () => {
      if (listener) signal.removeEventListener("abort", listener);
      listener = null;
    },
  };
}

async function killTree(proc: {
  kill: (sig?: number | NodeJS.Signals) => void;
  exited: Promise<number>;
}): Promise<void> {
  try {
    proc.kill("SIGTERM");
  } catch {
    /* expected: kill on already-exited child is a no-op */
  }
  // Race exit vs. SIGKILL grace.
  const grace = new Promise<void>((resolve) => setTimeout(resolve, SIGKILL_GRACE_MS));
  await Promise.race([proc.exited.then(() => undefined), grace]);
  try {
    proc.kill("SIGKILL");
  } catch {
    /* expected: kill on already-exited child is a no-op */
  }
}

function nowMs(): number {
  // `Bun.nanoseconds()` returns a high-resolution monotonic number (ns
  // since process start). Locale-blind, never goes backward.
  return Bun.nanoseconds() / 1_000_000;
}
