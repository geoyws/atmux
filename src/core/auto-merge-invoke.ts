// e-11-446429c9 §S2 — auto-merge invoker for in-cage epic-team scenario.
//
// The orchd auto-merge handler runs in each cage's own orchd process.
// When the cage IS an epic-team (team.json::epicTeam set), its kanban
// task.done events should fire performEpicMerge against this cage's
// own state. ADR-091's in-cage cron tick used to drive this; ADR-233
// retired that cron and orchd inherits the responsibility.
//
// Implementation: spawn `atmux epic-merge tick --team-dir <teamDir>`
// as a one-shot subprocess. The verb already encapsulates the full
// merge flow (gate-resolve → state machine → performEpicMerge → emit
// epic.merged on success). Spawn cost is ~50ms — same order as the
// orchd Bun --handle-one cold start; acceptable.
//
// We don't extract performEpicMerge's context-building into a
// dispatcher-callable function because that builds heavy machinery
// (MergerStateRepo, gate resolution, test-gate hooks) that the verb
// already does; duplicating it would split the implementation across
// two code paths and trigger drift.
//
// Why subprocess vs in-process: epicMergeTickVerb calls process-global
// helpers (createLogger, requireTeam from cwd, env reads). Calling it
// in-process would need cwd manipulation + risk pollution. Subprocess
// gets a clean process per invocation; the dispatcher contract
// already expects this latency budget.
//
// **Output contract (ADR-255)**: the tick-result line that
// `src/verbs/epic-merge.ts::logTickResult` PRINTS and this module
// PARSES is a SINGLE shared shape — {@link serializeTickResult} is the
// producer, {@link parseTickResult} is the consumer. Both live here so
// they cannot drift independently (the prior bug: the producer printed
// `state='merged'` quoted + `sha=<sha>` while the consumer matched
// `state=merged` unquoted + `mergeSha=<sha>`, so merge-detection
// survived only by an accidental `/MERGED/i` substring fallback that
// also false-triggered on the word "merged" in the `reason='…'` prose,
// and `extractMergeSha`/`extractParentBase` returned the wrong value —
// corrupt mergeSha/parentBase flowed into emitted epic.merged payloads).

import { type SpawnOpts, type SpawnResult, spawn as defaultSpawn } from "../abstractions/spawn.ts";
import { SpawnTimeoutError } from "../errors.ts";
import type { DispatchEpicMergeResult } from "./orchd-merge.ts";

/**
 * Structured fields of one epic-merge tick-result line — the SINGLE
 * source of truth shared by the producer ({@link serializeTickResult},
 * called from `epic-merge.ts::logTickResult`) and the consumer
 * ({@link parseTickResult}, called from {@link invokeAutoMergeInCage}).
 *
 * ADR-255 §D1: keeping producer + consumer bound to one shape means a
 * field rename in the printed line is a compile-time edit here, not a
 * silent runtime drift between two regexes in two files.
 */
export interface TickResultLine {
  /** Team name (epic-team) the tick ran for. */
  team: string;
  /** Parent trunk branch the epic merged into. */
  parentBase: string;
  /** Post-tick merger state (the `BranchMergeState` literal). */
  state: string;
  /** `"advanced"` when the tick changed state, `"no-op"` otherwise. */
  verdict: "advanced" | "no-op";
  /** Fan-in SHA — present ONLY when the tick reached `merged` with a
   *  fresh commit ahead. `undefined` on no-op merges + non-merge ticks. */
  mergedSha?: string;
  /** True iff the tick auto-dispatched `dissolve-epic`. */
  dissolveDispatched: boolean;
  /** Operator-facing reason string. */
  reason: string;
}

/** Stable marker prefixing every tick-result line. Both producer and
 *  consumer reference this constant so the line shape is greppable +
 *  anchorable from one place (ADR-255 §D1). */
export const TICK_RESULT_PREFIX = "epic-merge tick:";

/**
 * Render the canonical tick-result line. The verb's `logTickResult`
 * passes this string straight to `logger.log`. Format (ADR-255 §D1):
 *
 *   `epic-merge tick: team='<team>' parentBase='<parentBase>' state='<state>' <verdict>[ sha=<sha>][ dissolve-dispatched] reason='<reason>'`
 *
 * Single-quoted fields are values that may contain spaces (team,
 * parentBase, state, reason); `sha=` is a bare hex token; the
 * `dissolve-dispatched` flag word is present only when true. The
 * ordering + quoting MUST match {@link parseTickResult} — they are the
 * two halves of the same contract and are co-located so a change to
 * one forces a change to the other.
 */
export function serializeTickResult(fields: TickResultLine): string {
  const sha = fields.mergedSha !== undefined ? ` sha=${fields.mergedSha}` : "";
  const dispatched = fields.dissolveDispatched ? " dissolve-dispatched" : "";
  return (
    `${TICK_RESULT_PREFIX} team='${fields.team}' parentBase='${fields.parentBase}' ` +
    `state='${fields.state}' ${fields.verdict}${sha}${dispatched} reason='${fields.reason}'`
  );
}

/**
 * Parse the LAST tick-result line out of a subprocess's stdout, or
 * `null` when no contract line is present. The verb may print other
 * lines (test-gate hooks, dissolve logs) so we scan for the marker and
 * take the final match — the tick-result line is logged once, at the
 * end of the tick, after `performEpicMerge` returns.
 *
 * ADR-255 §D1: the field regexes are anchored to the `key='value'`
 * shape `serializeTickResult` emits — `state='merged'` is matched by
 * EQUALITY on the quoted capture, never a substring of the whole line
 * (the old `/MERGED/i` substring false-triggered on the word "merged"
 * inside `reason='…'`). The single-quoted captures are quote-stripped
 * by the `'([^']*)'` group itself.
 */
export function parseTickResult(stdout: string): TickResultLine | null {
  let last: string | null = null;
  for (const line of stdout.split("\n")) {
    if (line.includes(TICK_RESULT_PREFIX)) last = line;
  }
  if (last === null) return null;

  const team = matchQuoted(last, "team");
  const parentBase = matchQuoted(last, "parentBase");
  const state = matchQuoted(last, "state");
  const reason = matchQuoted(last, "reason");
  // A well-formed line always carries team/parentBase/state/reason. If
  // any are missing the line is malformed (truncated / not ours) — fail
  // closed by returning null so the caller treats it as "no indicator".
  if (team === null || parentBase === null || state === null || reason === null) {
    return null;
  }

  // `sha=<hex>` is a bare token; only present on merged-with-commits.
  // Bounded to git's 7–40 hex SHA shape so a stray `sha=` in prose
  // can't smuggle in a non-SHA value.
  const shaMatch = last.match(/\bsha=([0-9a-f]{7,40})\b/i);
  const verdict: "advanced" | "no-op" = /\badvanced\b/.test(last) ? "advanced" : "no-op";
  const dissolveDispatched = /\bdissolve-dispatched\b/.test(last);

  return {
    team,
    parentBase,
    state,
    verdict,
    ...(shaMatch?.[1] !== undefined ? { mergedSha: shaMatch[1] } : {}),
    dissolveDispatched,
    reason,
  };
}

/** Extract a single-quoted `key='value'` field; quotes stripped by the
 *  capture group. `null` when the key is absent. */
function matchQuoted(line: string, key: string): string | null {
  const m = line.match(new RegExp(`${key}='([^']*)'`));
  return m?.[1] ?? null;
}

/** Default subprocess wait timeout (ms). A hung `epic-merge tick`
 *  cannot be allowed to freeze orchd's single thread (ADR-255 §D2 +
 *  ADR-231 failure-isolation). On timeout the abstraction-layer
 *  `spawn()` SIGTERM→SIGKILL's the child and throws `SpawnTimeoutError`,
 *  which {@link defaultSpawnEpicMergeTick} maps to `timedOut: true` —
 *  the tick is then treated as gate-held, NOT merged. */
export const DEFAULT_TICK_TIMEOUT_MS = 120_000;

/** Test-injection seam — production callers omit. */
export interface AutoMergeInvokerDeps {
  /** Spawn-and-wait. Resolves an {@link EpicMergeTickSpawnResult}.
   *  Default ({@link defaultSpawnEpicMergeTick}) routes through the
   *  R4-blessed `spawn()` abstraction against `atmux` on PATH with a
   *  bounded wait (see {@link DEFAULT_TICK_TIMEOUT_MS}). */
  spawnEpicMergeTick?: (teamDir: string) => Promise<EpicMergeTickSpawnResult>;
  /** Optional logger. Defaults to console-shape no-op. */
  log?: (msg: string) => void;
}

/**
 * Invoke the in-cage epic-merge tick for the current epic-team. Maps
 * the subprocess outcome to the DispatchEpicMergeResult shape the
 * auto-merge handler consumes.
 *
 * Result mapping:
 *   - spawn threw → `{state: "gate-held", reason}` (operator-observable,
 *     no retry storm).
 *   - timed out → `{state: "gate-held", reason}` — a hung tick is NOT a
 *     merge (ADR-255 §D2); the child was already SIGTERM→SIGKILL'd.
 *   - exit non-zero → `{state: "gate-held", reason}`.
 *   - exit 0 + a parsed tick-result line with `state='merged'` →
 *     `{state: "merged", parentBase, mergeSha}` (extracted from the
 *     SHARED contract line, ADR-255 §D1).
 *   - exit 0 + no merged indicator → `{state: "skipped-not-mine",
 *     reason}` so the handler doesn't emit a phantom epic.merged event.
 */
export async function invokeAutoMergeInCage(
  teamDir: string,
  deps: AutoMergeInvokerDeps = {},
): Promise<DispatchEpicMergeResult> {
  const spawnFn = deps.spawnEpicMergeTick ?? defaultSpawnEpicMergeTick;
  const log = deps.log ?? ((): void => undefined);

  let result: EpicMergeTickSpawnResult;
  try {
    result = await spawnFn(teamDir);
  } catch (e) {
    const reason = `invokeAutoMergeInCage: spawn failed — ${e instanceof Error ? e.message : String(e)}`;
    log(reason);
    return { state: "gate-held", reason };
  }

  log(
    `invokeAutoMergeInCage: teamDir=${teamDir} exit=${result.exitCode} timedOut=${result.timedOut === true} stdoutTail=${result.stdout.slice(-200)}`,
  );

  if (result.timedOut === true) {
    // A hung tick froze the subprocess past the bound; the child was
    // reaped. Treat as gate-held — emphatically NOT merged (ADR-255 §D2).
    const tail = (result.stderr || result.stdout).trim().slice(-300);
    return {
      state: "gate-held",
      reason: `atmux epic-merge tick timed out (${DEFAULT_TICK_TIMEOUT_MS}ms) — child reaped: ${tail}`,
    };
  }

  if (result.exitCode !== 0) {
    const tail = (result.stderr || result.stdout).trim().slice(-300);
    return {
      state: "gate-held",
      reason: `atmux epic-merge tick exit=${result.exitCode}: ${tail}`,
    };
  }

  // Success branch: detect whether the tick actually merged (vs. gate-
  // held / no-op) by parsing the SHARED contract line. `state='merged'`
  // is matched by EQUALITY on the quoted state field — never a
  // substring of the line — so `reason='already merged'` prose or a
  // `state='merging'` no-op can't false-trigger (ADR-255 §D1). When we
  // can't confirm a merge, return skipped-not-mine so the handler
  // doesn't emit a phantom epic.merged event.
  const parsed = parseTickResult(result.stdout);
  if (parsed !== null && parsed.state === "merged") {
    return {
      state: "merged",
      parentBase: parsed.parentBase,
      mergeSha: parsed.mergedSha ?? "",
    };
  }
  return {
    state: "skipped-not-mine",
    reason: "epic-merge tick ran clean (exit 0) but no merged indicator in stdout — gate-held or no-op",
  };
}

/** Bounded subprocess wait result — the consumer-facing shape
 *  {@link invokeAutoMergeInCage} maps to a `DispatchEpicMergeResult`. */
export interface EpicMergeTickSpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Set when the abstraction-layer `spawn()` timed the child out
   *  (SIGTERM→SIGKILL already applied). */
  timedOut?: boolean;
}

/**
 * Default subprocess spawn with a bounded wait. Routes through the
 * R4-blessed `spawn()` abstraction (`src/abstractions/spawn.ts`) — the
 * ONLY module allowed to call `Bun.spawn` per ADR-099 R4 + ADR-100 —
 * rather than a raw `Bun.spawn`. The abstraction gives buffered
 * stdout/stderr capture plus the SIGTERM→1s grace→SIGKILL timeout
 * machinery for free.
 *
 * ADR-255 §D2: the wait is bounded by `timeoutMs` (default
 * {@link DEFAULT_TICK_TIMEOUT_MS}). A hung tick — e.g. a git operation
 * blocked on a lock, or a test-gate that never returns — must not
 * freeze orchd's single thread. `expectExitCode: "any"` means a nonzero
 * exit is RETURNED (mapped to gate-held by the caller), not thrown;
 * only a timeout throws (`SpawnTimeoutError`), which we catch and map
 * to `timedOut: true`. `spawnImpl` is injected for unit coverage of
 * both the timeout and nonzero branches without real subprocesses.
 */
export async function defaultSpawnEpicMergeTick(
  teamDir: string,
  timeoutMs: number = DEFAULT_TICK_TIMEOUT_MS,
  spawnImpl: (opts: SpawnOpts) => Promise<SpawnResult> = defaultSpawn,
): Promise<EpicMergeTickSpawnResult> {
  try {
    const res = await spawnImpl({
      cmd: "atmux",
      argv: ["epic-merge", "tick", "--team-dir", teamDir],
      timeoutMs,
      expectExitCode: "any",
    });
    return { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr };
  } catch (e) {
    if (e instanceof SpawnTimeoutError) {
      // Child already SIGTERM→SIGKILL'd by spawn(); surface as timedOut
      // so the caller maps it to gate-held (NOT merged) per ADR-255 §D2.
      return { exitCode: -1, stdout: "", stderr: e.message, timedOut: true };
    }
    // Any other spawn failure (e.g. `atmux` not on PATH) propagates to
    // invokeAutoMergeInCage's try/catch → gate-held.
    throw e;
  }
}
