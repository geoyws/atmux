// ADR-231 §D2/§D5 — `atmux team spawn-epic` subprocess stub for Phase 2
// handler unit tests (S3.1, t-16-27fdc08b).
//
// The spawn handler (T-S2.5, `src/core/orchd-spawn.ts`) invokes the
// `atmux team spawn-epic` CLI as a subprocess and classifies the result
// per the §D5 3-way failure matrix:
//   - exit 0                                                       → success → set epics.spawned_at
//   - exit non-zero + stderr matches `/host-wide cap (\d+) reached/`  → host-pressure → defer
//   - exit non-zero + stderr matches `/eligible=false: /`             → eligibility-race → silent
//   - exit non-zero + stderr matches neither                          → hard failure → flag + no retry
//
// This stub stands in for the subprocess so handler unit tests can
// exercise each branch deterministically. Default behaviour = exit 0
// (success); tests poll {@link SpawnEpicStub.setResult} to inject the
// canonical stderr blobs the classifier (`src/core/orchd-spawn-classify.ts`)
// recognises.
//
// Canonical stderr fixtures are exported so test assertions can compare
// against them directly — same strings the production classifier
// regexes match against (verified by `tests/unit/core/orchd-spawn-classify.test.ts`).

/** Exit-code + stderr shape returned by {@link SpawnEpicStub.invoke}. */
export interface SpawnEpicResult {
  /** Exit status of the simulated `atmux team spawn-epic` process. */
  readonly exitCode: number;
  /** Captured stdout. Empty by default. */
  readonly stdout: string;
  /** Captured stderr. Empty on success; populated on failure-class
   *  results so the classifier (ADR-231 §D5) can categorise the run. */
  readonly stderr: string;
  /** Classification hint for assertions. NOT consumed by production
   *  code — production reads stderr + uses the regex classifier. The
   *  hint exists so test setup is self-documenting. */
  readonly kind: "success" | "host-pressure" | "eligibility-race" | "hard-failure";
}

/** Recorded invocation of the stub — tests assert on count + args. */
export interface SpawnEpicInvocation {
  readonly epicId: string;
  readonly roster: string;
  readonly force: boolean;
  /** Anything else the handler passed (e.g. `--reason`). */
  readonly extraArgs: ReadonlyArray<string>;
  /** Sequence index of the invocation (1-based). Mirrors HonkerMock
   *  publish-order semantics so tests can correlate multi-invoke
   *  scenarios. */
  readonly sequence: number;
}

// ---------- Canonical stderr fixtures (per ADR-231 §D5 / orchd-spawn-classify.ts) ----------

/**
 * ADR-184 host-pressure refusal — emitted by spawn-epic when the host-
 * wide epic-team cap is reached. Matches the production regex
 * `/host-wide cap\s*\(\d+\)\s*reached/`. Source: `tests/unit/core/
 * orchd-spawn-classify.test.ts:17` (exact text the classifier was
 * authored against).
 */
export const CANONICAL_HOST_PRESSURE_STDERR =
  "spawn-epic: host-wide cap (8) reached — try again later";

/**
 * ADR-225 eligibility-race refusal — emitted by `epicIsEligible()` when
 * an epic's deps haven't all landed or `is_ready=0` got flipped between
 * the orchd wake and the spawn-epic invocation. Matches the production
 * regex `/eligible=false:\s/`. Source: `tests/unit/core/
 * orchd-spawn-classify.test.ts:40`.
 */
export const CANONICAL_ELIGIBILITY_RACE_STDERR =
  "eligible=false: dep e-deadbeef not done";

/**
 * Representative hard-failure stderr — matches NEITHER transient regex,
 * so the classifier returns `"hard"`. Tests can override with any
 * non-matching string; this is the default for `kind: "hard-failure"`.
 */
export const CANONICAL_HARD_FAILURE_STDERR =
  "spawn-epic: invalid roster 'nonexistent' — no such roster file";

/** Pre-built success result — exit 0, no stderr. */
export const SUCCESS_RESULT: SpawnEpicResult = {
  exitCode: 0,
  stdout: "",
  stderr: "",
  kind: "success",
};

/** Pre-built host-pressure result. Exit 1 + canonical stderr. */
export const HOST_PRESSURE_RESULT: SpawnEpicResult = {
  exitCode: 1,
  stdout: "",
  stderr: CANONICAL_HOST_PRESSURE_STDERR,
  kind: "host-pressure",
};

/** Pre-built eligibility-race result. Exit 1 + canonical stderr. */
export const ELIGIBILITY_RACE_RESULT: SpawnEpicResult = {
  exitCode: 1,
  stdout: "",
  stderr: CANONICAL_ELIGIBILITY_RACE_STDERR,
  kind: "eligibility-race",
};

/** Pre-built hard-failure result. Exit 1 + non-matching stderr. */
export const HARD_FAILURE_RESULT: SpawnEpicResult = {
  exitCode: 1,
  stdout: "",
  stderr: CANONICAL_HARD_FAILURE_STDERR,
  kind: "hard-failure",
};

/** Invocation arg shape — what the handler passes per spawn attempt. */
export interface SpawnEpicInvokeArgs {
  readonly epicId: string;
  readonly roster: string;
  readonly force?: boolean;
  readonly extraArgs?: ReadonlyArray<string>;
}

/**
 * The stub. Construct with {@link createSpawnEpicStub}. Tests call
 * `.setResult()` to inject the desired outcome, pass `.invoke` into the
 * production handler under test as the subprocess seam, then assert on
 * `.invocations` afterwards.
 */
export interface SpawnEpicStub {
  /** Subprocess seam — production handler calls this in place of
   *  `Bun.spawn(["atmux", "team", "spawn-epic", ...])`. Records the
   *  invocation, returns the currently-configured result. */
  invoke(args: SpawnEpicInvokeArgs): Promise<SpawnEpicResult>;
  /** Configure the next (and subsequent) `.invoke()` returns. Defaults
   *  to SUCCESS_RESULT at construction. */
  setResult(result: SpawnEpicResult): void;
  /** Configure a sequence of results — `.invoke()` consumes one per
   *  call, then falls back to the last entry once exhausted. Useful
   *  for "first call transient-fails, second call succeeds" scenarios
   *  the cron `--sweep` backstop test (T-S3.2) needs. */
  setResultSequence(results: ReadonlyArray<SpawnEpicResult>): void;
  /** All recorded invocations, in call order. */
  readonly invocations: ReadonlyArray<SpawnEpicInvocation>;
  /** Drop every invocation + restore default SUCCESS_RESULT. */
  reset(): void;
}

/**
 * Construct a fresh stub. Defaults to `SUCCESS_RESULT` for every
 * `.invoke()` call until `.setResult()` / `.setResultSequence()` is
 * called.
 *
 * @example
 *   const stub = createSpawnEpicStub();
 *   stub.setResult(HOST_PRESSURE_RESULT);
 *   await spawnEpicHandler({ epicId: "e-x" }, { spawnEpicInvoke: stub.invoke });
 *   expect(stub.invocations).toHaveLength(1);
 *   expect(stub.invocations[0].epicId).toBe("e-x");
 */
export function createSpawnEpicStub(initial?: SpawnEpicResult): SpawnEpicStub {
  const invocations: SpawnEpicInvocation[] = [];
  let defaultResult: SpawnEpicResult = initial ?? SUCCESS_RESULT;
  let sequence: SpawnEpicResult[] | null = null;
  let sequenceCursor = 0;

  return {
    invocations,

    async invoke(args: SpawnEpicInvokeArgs): Promise<SpawnEpicResult> {
      invocations.push({
        epicId: args.epicId,
        roster: args.roster,
        force: args.force ?? false,
        extraArgs: args.extraArgs ?? [],
        sequence: invocations.length + 1,
      });

      if (sequence !== null && sequence.length > 0) {
        const idx = Math.min(sequenceCursor, sequence.length - 1);
        sequenceCursor += 1;
        return sequence[idx];
      }
      return defaultResult;
    },

    setResult(result: SpawnEpicResult): void {
      defaultResult = result;
      sequence = null;
      sequenceCursor = 0;
    },

    setResultSequence(results: ReadonlyArray<SpawnEpicResult>): void {
      sequence = [...results];
      sequenceCursor = 0;
    },

    reset(): void {
      invocations.length = 0;
      defaultResult = SUCCESS_RESULT;
      sequence = null;
      sequenceCursor = 0;
    },
  };
}
