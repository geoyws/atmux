// Shared stdio-capture helpers for unit tests.
//
// Both `cli.test.ts::captureMain` and `dashboard.ts::captureVerbStdout`
// (production helper) implement the same monkey-patch pattern around
// `process.stdout.write`, `process.stderr.write`, and `console.log`.
// Tests for new verbs (report, cost, doctor) need the same capability;
// rather than copy-paste a fourth time, this helper centralizes the
// pattern.
//
// Two functions:
//
//   `captureStdio(fn)` — primitive. Runs `fn()` with stdout + stderr
//   + console.log redirected to in-memory buffers. Restores originals
//   in `finally`. Returns the awaited result + both buffers.
//
//   `captureMain(argv)` — convenience wrapper around the cli's `main`.
//   Returns `{ exit, stdout, stderr }` for assertion against bash-
//   parity output.
//
// Synchronous reportError-style captures (used by cli.test.ts) stay
// inline in that file — adapting captureStdio for a sync callback
// would split the type signature; not worth it for one call site.

import { main } from "../../src/cli.ts";

export interface CapturedStdio<T> {
  /** Whatever `fn()` returned (or its awaited resolved value). */
  result: T;
  stdout: string;
  stderr: string;
}

/**
 * Run `fn` with stdio redirected to in-memory buffers. Captures
 * `process.stdout.write`, `process.stderr.write`, and `console.log`
 * (verbs that use the latter — version, etc.). Originals are
 * restored in `finally` even if `fn` throws (the throw re-raises).
 *
 * Use this in any new verb test that needs to assert on stdout/stderr
 * without spinning a subprocess.
 */
export async function captureStdio<T>(fn: () => Promise<T> | T): Promise<CapturedStdio<T>> {
  let stdout = "";
  let stderr = "";
  const origLog = console.log;
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  console.log = (msg: unknown) => {
    stdout += `${String(msg)}\n`;
  };
  process.stdout.write = ((s: string | Uint8Array) => {
    stdout += typeof s === "string" ? s : new TextDecoder().decode(s);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array) => {
    stderr += typeof s === "string" ? s : new TextDecoder().decode(s);
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await fn();
    return { result, stdout, stderr };
  } finally {
    console.log = origLog;
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
  }
}

export interface CapturedMain {
  exit: number;
  stdout: string;
  stderr: string;
}

/**
 * Drive `main(argv)` with stdio captured. Wraps `captureStdio` —
 * `result` is the cli exit code surfaced as `exit` for ergonomics.
 */
export async function captureMain(argv: ReadonlyArray<string>): Promise<CapturedMain> {
  const { result, stdout, stderr } = await captureStdio(() => main(argv));
  return { exit: result, stdout, stderr };
}
