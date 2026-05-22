// Native listener spawner — wraps the `atmux-listener` Rust subprocess
// (rust/atmux-listener) that wraps Honker's blocking `Database::listen`.
//
// Produces an `AsyncIterable<string>` of wake-up signals that
// `watchEvents()` consumes as its `externalSignals` source. Each yielded
// string is the raw "<channel>\t<payload>" line the subprocess emitted —
// callers ignore the value and drain the events table on each yield.
//
// **Lifecycle ownership**: the returned iterable's `next()` calls drive
// the subprocess. When the consumer breaks out (or AbortSignal fires),
// the subprocess is killed via stdin close (which the listener treats
// as graceful exit). The caller can also explicitly call `.return()` on
// the iterator.
//
// **Failure handling**: subprocess spawn failure throws immediately
// (the caller can fall back to poll-mode). Runtime crash (binary
// exits non-zero) ends the iterator cleanly — caller's watchEvents
// degrades to poll-mode per its externalSignals contract.
//
// **Where the binary lives**: production callers point `binaryPath` at
// the build:install-staged `/opt/atmux/<v>/bin/atmux-listener`. Tests
// override with a fake-spawn injection seam.

import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";

/** Test-injection seam — wraps Node's child_process.spawn so tests can
 *  feed canned stdout streams without launching real subprocesses. */
export interface NativeSpawnFn {
  (
    binary: string,
    args: ReadonlyArray<string>,
  ): {
    stdout: AsyncIterable<string>;
    kill: () => void;
    onExit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  };
}

/** Default spawner — uses node:child_process. Reads stdout line-by-line
 *  via a readline-like splitter to handle the listener's
 *  newline-delimited protocol. */
export const defaultNativeSpawn: NativeSpawnFn = (binary, args) => {
  const child: ChildProcess = nodeSpawn(binary, [...args], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = lineStream(child);
  const onExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
  return {
    stdout,
    kill: () => {
      // Closing stdin lets the listener exit cleanly on its next
      // stdout flush (broken pipe). SIGTERM as belt-and-braces.
      child.stdin?.end();
      if (!child.killed) child.kill("SIGTERM");
    },
    onExit,
  };
};

/** Yield decoded lines from a child's stdout — drops the trailing "\n",
 *  handles partial-line buffering across `data` events. */
async function* lineStream(child: ChildProcess): AsyncGenerator<string, void, void> {
  if (!child.stdout) return;
  let buffer = "";
  child.stdout.setEncoding("utf8");
  for await (const chunk of child.stdout as unknown as AsyncIterable<string>) {
    buffer += chunk;
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.length > 0) yield line;
      idx = buffer.indexOf("\n");
    }
  }
  if (buffer.length > 0) yield buffer;
}

export interface NativeListenerOpts {
  /** Absolute path to the `atmux-listener` binary. Caller resolves
   *  this from `/opt/atmux/current/bin/atmux-listener` or test fixture. */
  binaryPath: string;
  /** Absolute path to the team's `state.db`. */
  dbPath: string;
  /** Honker notification channel — `honker:stream:<topic>` per
   *  Honker's stream-publish convention. */
  channel: string;
  /** Test-injection seam — override the spawn fn. */
  spawn?: NativeSpawnFn;
  /** Optional logger sink for diagnostic lines (e.g. listener stderr
   *  surface, "ready" handshake observed). */
  onDiagnostic?: (msg: string) => void;
}

export interface NativeListenerHandle {
  /** AsyncIterable yielding one string per notification line. Skips the
   *  initial "ready" handshake — only event lines reach consumers. */
  signals: AsyncIterable<string>;
  /** Terminate the subprocess. Idempotent. */
  stop: () => void;
  /** Resolves with the subprocess's exit details when it exits. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/**
 * Spawn the `atmux-listener` subprocess subscribed to `channel` on
 * `dbPath`. Returns a handle whose `signals` AsyncIterable yields
 * lines from the listener's stdout (skipping the "ready" handshake).
 *
 * Pass `handle.signals` into `watchEvents({ externalSignals: ... })`
 * to drive the consumer loop kernel-blocked.
 *
 * Throws synchronously if `spawn()` itself fails (binary missing, no
 * permission, etc.). Caller's fallback should catch and degrade to
 * poll-mode.
 */
export function spawnNativeListener(opts: NativeListenerOpts): NativeListenerHandle {
  const spawn = opts.spawn ?? defaultNativeSpawn;
  const { stdout, kill, onExit } = spawn(opts.binaryPath, [opts.dbPath, opts.channel]);
  const diag = opts.onDiagnostic ?? (() => {});

  // Filter out the "ready" handshake line — callers only care about
  // notification lines, but observing "ready" is useful for diagnostics.
  async function* filtered(): AsyncGenerator<string, void, void> {
    let seenReady = false;
    for await (const line of stdout) {
      if (!seenReady && line === "ready") {
        seenReady = true;
        diag("native-listener: ready");
        continue;
      }
      yield line;
    }
  }

  return {
    signals: filtered(),
    stop: kill,
    exited: onExit,
  };
}

/**
 * Resolve the default `atmux-listener` binary path. Production atmux
 * deploys land the binary alongside the main `atmux` shim at
 * `/opt/atmux/current/bin/atmux-listener`; this helper returns that
 * path unless `ATMUX_LISTENER_BIN` overrides it.
 *
 * Returns `null` when the env override is empty AND the default path
 * doesn't exist — callers fall back to poll-mode.
 */
export function resolveDefaultListenerBinary(
  env: NodeJS.ProcessEnv = process.env,
  existsSync: (path: string) => boolean = (path) =>
    Bun.file(path).size > 0 || false,
): string | null {
  const explicit = env.ATMUX_LISTENER_BIN?.trim();
  if (explicit && explicit.length > 0) {
    return existsSync(explicit) ? explicit : null;
  }
  const defaultPath = "/opt/atmux/current/bin/atmux-listener";
  return existsSync(defaultPath) ? defaultPath : null;
}
