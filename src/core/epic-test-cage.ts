// ADR-144 §Cage mode T3 (t-8cba0705): isolated test-runner for the
// epic-team test-gate. Provisions a fresh tmpdir, runs the test command
// with TMUX_TMPDIR scoped to the cage + TMUX env unset (per memory
// [[feedback_pause_bun_tests]]), captures the outcome, and tears down.
//
// Lifecycle (one-shot per merge attempt per ADR-144 §Cage mode lifecycle):
//
//   1. {@link expandCagePath} resolves `${team}` / `${epic}` placeholders
//      in `team.epicTeam.cageTmpdir`.
//   2. {@link provisionCage} `mkdir -p` the path.
//   3. {@link runCageTest} spawns `env -u TMUX TMUX_TMPDIR=<cage>
//      <testCommand>` with the configured timeout. Re-tries up to
//      `retryOnFlake` times on a non-zero exit.
//   4. {@link teardownCage} `rm -rf` the path (idempotent).
//
// Why `env -u TMUX`: an `unset TMUX &&` prefix would require a shell
// invocation; `env -u VAR` is the no-shell equivalent that strips
// `$TMUX` from the child's env without parsing through bash. The cage-
// guard memory [[feedback_pause_bun_tests]] explains why this matters:
// running `bun test` from inside an atmux session inherits `$TMUX`
// pointing at the parent socket, and the test's tmux teardown calls
// `kill-server` honoring `$TMUX` over `$TMUX_TMPDIR` — which propagates
// up to the parent cage. The unset breaks that propagation.
//
// Out of scope here:
//   - The actual `ready_to_merge → tested` state transition. The caller
//     (epic-merge.ts::runAutoMerge ADR-144 path) owns the transition;
//     this module just runs the test and reports the outcome.
//   - The Discord [epic-test-pass] / [epic-test-fail] templates (T5).
//   - The deployed-mode runner (T4 lives in a sibling module).

import { spawn as defaultSpawn, type SpawnOpts, type SpawnResult } from "../abstractions/spawn.ts";
import type { TestOutcome } from "./branch-merge-state.ts";

/** Test-injection seam for the spawn primitive. Production callers
 *  pass nothing (defaults to {@link defaultSpawn} from
 *  src/abstractions/spawn.ts). Tests pass a stub that returns canned
 *  {@link SpawnResult} fixtures keyed off the argv. */
export type CageSpawn = (opts: SpawnOpts) => Promise<SpawnResult>;

// ---------- Path expansion ----------

/** Expand `${team}` and `${epic}` placeholders in `template`. Pure —
 *  no I/O. Matches the ADR-144 §Config shape's default of
 *  `/tmp/atmux_${team}_${epic}_test_cage`.
 *
 *  Unrecognized placeholders are LEFT VERBATIM (no throw) — operator
 *  overrides may use shell-style placeholders that the cage doesn't
 *  expand. The shell-call site (which doesn't exist in v1 — paths are
 *  passed directly to mkdir/rm without shell parsing) is the right
 *  place to handle those. */
export function expandCagePath(template: string, team: string, epic: string): string {
  return template.replaceAll("${team}", team).replaceAll("${epic}", epic);
}

// ---------- Provision / teardown ----------

/** Provision the cage directory. Idempotent — `mkdir -p` succeeds even
 *  if the directory already exists from a prior aborted run.
 *
 *  The caller (epic-merge.ts) typically calls this once at the start
 *  of a test cycle; on a `test_failed → in_progress` recovery loop,
 *  the next cycle's provision reuses the same directory. Teardown
 *  fires per cycle to keep the disk footprint bounded. */
export async function provisionCage(
  cagePath: string,
  spawn: CageSpawn = defaultSpawn,
): Promise<void> {
  await spawn({
    cmd: "mkdir",
    argv: ["-p", cagePath],
    timeoutMs: 5_000,
  });
}

/** Tear down the cage directory. Idempotent — `rm -rf` succeeds on a
 *  missing path. Safe to call after any outcome (pass / fail / throw)
 *  so the caller can always wrap in try/finally. */
export async function teardownCage(
  cagePath: string,
  spawn: CageSpawn = defaultSpawn,
): Promise<void> {
  await spawn({
    cmd: "rm",
    argv: ["-rf", cagePath],
    timeoutMs: 10_000,
  });
}

// ---------- Test execution ----------

/** Per-attempt result returned by {@link runCageTestOnce}. */
export interface CageAttemptResult {
  outcome: "pass" | "fail";
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** Composite result from {@link runCageTest} after applying
 *  retryOnFlake logic. */
export interface CageTestResult {
  outcome: TestOutcome & ("pass" | "fail");
  /** Number of attempts that actually ran. `1` for a first-try pass;
   *  `1 + retryOnFlake` upper-bound when retries are exhausted on
   *  consecutive fails. */
  attempts: number;
  /** Last attempt's stdout/stderr/exitCode/durationMs. The caller
   *  surfaces this via merger_state.note + Discord [epic-test-fail]
   *  (T5). */
  last: CageAttemptResult;
  /** Total wall-clock duration across all attempts (sum of per-attempt
   *  `durationMs`). */
  totalDurationMs: number;
}

/** Tokenise a shell-ish test command into argv. Splits on whitespace
 *  and respects single+double quotes for tokens with spaces. Does NOT
 *  interpret `$VAR` / `~` / backticks — those are deliberately left
 *  unevaluated (ADR-144 testCommand is meant to be a direct argv
 *  shape, not a shell expression).
 *
 *  Pure — no I/O. Returns the argv array; throws on unterminated
 *  quotes (caller surfaces as a usage error). */
export function tokenizeTestCommand(cmd: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote !== null) {
      if (c === quote) {
        quote = null;
      } else {
        buf += c;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === " " || c === "\t") {
      if (buf.length > 0) {
        out.push(buf);
        buf = "";
      }
      continue;
    }
    buf += c;
  }
  if (quote !== null) {
    throw new Error(`tokenizeTestCommand: unterminated ${quote} quote in: ${cmd}`);
  }
  if (buf.length > 0) out.push(buf);
  if (out.length === 0) {
    throw new Error("tokenizeTestCommand: empty command");
  }
  return out;
}

/** Run the test command ONCE against the cage. Wraps the command in
 *  `env -u TMUX TMUX_TMPDIR=<cagePath> <testCommand>` so:
 *
 *    - Any tmux spawn from inside the test process resolves under the
 *      cage's tmpdir, NOT the parent atmux session's.
 *    - The test's tmux teardown (`kill-server` etc.) hits the cage
 *      server (which is uniquely scoped to this run) rather than the
 *      parent's.
 *
 *  Exit code 0 → outcome `"pass"`; non-zero → outcome `"fail"`. Per
 *  ADR-144 the retry logic lives in {@link runCageTest}; this function
 *  is the per-attempt primitive. */
export async function runCageTestOnce(
  cagePath: string,
  testCommand: string,
  cwd: string,
  timeoutMs: number,
  spawn: CageSpawn = defaultSpawn,
): Promise<CageAttemptResult> {
  const tokens = tokenizeTestCommand(testCommand);
  const start = Date.now();
  const result = await spawn({
    cmd: "env",
    argv: ["-u", "TMUX", `TMUX_TMPDIR=${cagePath}`, ...tokens],
    cwd,
    timeoutMs,
    // Accept any exit code so the spawn primitive doesn't throw on a
    // failing test — we classify based on exit code in the caller.
    expectExitCode: "any",
  });
  return {
    outcome: result.exitCode === 0 ? "pass" : "fail",
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs > 0 ? result.durationMs : Date.now() - start,
  };
}

/** Options for {@link runCageTest}. */
export interface RunCageTestOpts {
  /** Resolved cage tmpdir (post-{@link expandCagePath}). */
  cagePath: string;
  /** Shell-tokenised test command (ADR-144 §Config `testCommand`). */
  testCommand: string;
  /** Working directory the test command runs in. Production callers
   *  pass the epic-team's worktree root (where `bun test` resolves
   *  the project's source tree). */
  cwd: string;
  /** Per-attempt timeout in ms. Production callers compute
   *  `team.epicTeam.testTimeoutMin * 60_000`. */
  timeoutMs: number;
  /** Per-ADR-144 §retryOnFlake: retry up to N times on a fail. `0` =
   *  no retry. */
  retryOnFlake: number;
  /** Test injection — override the spawn primitive. */
  spawn?: CageSpawn;
}

/** Run the test command against the cage with retryOnFlake semantics.
 *  On a PASS, returns immediately. On a FAIL, retries up to
 *  `retryOnFlake` times — if any retry passes, returns PASS with
 *  `attempts > 1`. If every attempt fails, returns FAIL with the LAST
 *  attempt's evidence.
 *
 *  Why "any retry passes wins": ADR-144 §retryOnFlake resolves OQ-3
 *  to retain N=1 — single flake is common enough that 0 would
 *  over-fire test_failed. The semantics are "test is treated as
 *  passing if ANY of (1 + retryOnFlake) attempts pass" — this is the
 *  flake-tolerant interpretation. Operators can disable by setting
 *  `retryOnFlake: 0`.
 *
 *  Does NOT touch state.db — the caller (epic-merge.ts) records the
 *  outcome via {@link MergerStateRepo.transition} after this returns.
 */
export async function runCageTest(opts: RunCageTestOpts): Promise<CageTestResult> {
  const spawn = opts.spawn ?? defaultSpawn;
  const maxAttempts = 1 + Math.max(0, Math.floor(opts.retryOnFlake));
  let last: CageAttemptResult | null = null;
  let totalDurationMs = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const r = await runCageTestOnce(
      opts.cagePath,
      opts.testCommand,
      opts.cwd,
      opts.timeoutMs,
      spawn,
    );
    totalDurationMs += r.durationMs;
    last = r;
    if (r.outcome === "pass") {
      return {
        outcome: "pass",
        attempts: attempt,
        last: r,
        totalDurationMs,
      };
    }
  }
  // All attempts failed. `last` is set because maxAttempts >= 1.
  if (last === null) {
    throw new Error("runCageTest: invariant — maxAttempts >= 1 should guarantee last is set");
  }
  return {
    outcome: "fail",
    attempts: maxAttempts,
    last,
    totalDurationMs,
  };
}

// ---------- Top-level orchestrator ----------

/** Options for {@link runCageTestGate}. Composes the lifecycle —
 *  provision + run + teardown — into one call. Caller passes the
 *  resolved cage path + test command; this helper handles the try/
 *  finally teardown so callers can't leak cage tmpdirs. */
export interface RunCageTestGateOpts {
  cagePath: string;
  testCommand: string;
  cwd: string;
  timeoutMs: number;
  retryOnFlake: number;
  spawn?: CageSpawn;
}

/**
 * Full lifecycle: provision → run (with retries) → teardown. Returns
 * the {@link CageTestResult}. Teardown fires in `finally` so it runs
 * even on a thrown spawn (e.g. timeout on a wedged bun process).
 *
 * Callers (epic-merge.ts ADR-144 path) wrap this in the
 * `ready_to_merge → tested` transition. The returned outcome maps
 * onto the row's `test_outcome` field; the caller decides whether to
 * advance `tested → merging` (PASS) or `tested → test_failed` (FAIL).
 */
export async function runCageTestGate(opts: RunCageTestGateOpts): Promise<CageTestResult> {
  const spawn = opts.spawn ?? defaultSpawn;
  await provisionCage(opts.cagePath, spawn);
  try {
    return await runCageTest({
      cagePath: opts.cagePath,
      testCommand: opts.testCommand,
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      retryOnFlake: opts.retryOnFlake,
      spawn,
    });
  } finally {
    // Teardown is best-effort — a failure here shouldn't mask a test
    // outcome. The mkdir/rm primitives are extremely reliable, but
    // defensively wrap in catch so we never throw FROM the finally
    // path on top of a more meaningful test-result exception.
    await teardownCage(opts.cagePath, spawn).catch(() => {});
  }
}
