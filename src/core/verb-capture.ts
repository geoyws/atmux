// ADR-272: voice operator interface — in-process verb capture + the
// FIFO mutex that serializes every voice tool execution.
//
// `captureVerbStdout` is lifted verbatim from `src/verbs/dashboard.ts`
// (which now re-imports it from here) so that core code — the voice
// tool bridge (`src/core/vox/tool-bridge.ts`) — can capture verb
// output without importing from `src/verbs/**`. The dependency
// direction stays verbs→core: the verb function itself always arrives
// as an argument.
//
// Why a mutex: both capture wrappers monkeypatch `process.stdout.write`
// / `console.log` around the verb call and restore the saved originals
// in `finally`. Two CONCURRENT captures clobber each other's saved
// original (capture A restores capture B's override → later writes land
// in a dead buffer). `createVerbMutex()` is the strict-FIFO async lock
// every voice tool execution serializes through — one capture in flight
// at a time, queued in call order, with a BOUNDED queue and an abandon
// path so a wedged holder degrades the lane instead of ending it
// (ADR-272 §Supplement-P7 §R2).

import { VerbMutexError } from "../errors.ts";

/** Verb function shape — every verb exports `(args) => Promise<exit>`. */
export type VerbFn = (a: ReadonlyArray<string>) => Promise<number>;

/** Outcome of one redirected verb run. `errorMessage` is set (and
 *  `exitCode` is `null`) when the verb threw instead of returning. */
export interface CaptureVerbRunResult {
  stdout: string;
  exitCode: number | null;
  errorMessage?: string;
}

/**
 * The ONE redirect implementation shared by both capture wrappers.
 * Monkeypatches `process.stdout.write` + `console.log` to an in-memory
 * buffer around the verb call; restores the originals in `finally`
 * (guaranteed even when the verb throws). A thrown error is caught into
 * `errorMessage` — never re-raised — so callers decide how to render it.
 */
async function runRedirected(
  verb: VerbFn,
  args: ReadonlyArray<string>,
): Promise<CaptureVerbRunResult> {
  let buf = "";
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origLog = console.log;
  process.stdout.write = ((s: string | Uint8Array) => {
    buf += typeof s === "string" ? s : new TextDecoder().decode(s);
    return true;
  }) as typeof process.stdout.write;
  console.log = (msg: unknown) => {
    buf += `${String(msg)}\n`;
  };
  try {
    const exitCode = await verb(args);
    return { stdout: buf, exitCode };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { stdout: buf, exitCode: null, errorMessage: msg };
  } finally {
    process.stdout.write = origStdoutWrite;
    console.log = origLog;
  }
}

/**
 * Run an in-process verb function with `process.stdout.write` and
 * `console.log` redirected to a buffer. Returns the captured text.
 * Errors thrown by the verb are caught and re-rendered as a single
 * line `"<verb-name>: <message>\n"` — bash dashboard.sh swallows the
 * whole call via `|| true`, mirror.
 */
export async function captureVerbStdout(
  verb: VerbFn,
  args: ReadonlyArray<string>,
  label: string,
): Promise<string> {
  const r = await runRedirected(verb, args);
  if (r.errorMessage !== undefined) return `${r.stdout}${label}: ${r.errorMessage}\n`;
  return r.stdout;
}

/**
 * Voice-bridge capture: same stdout/console.log redirect core as
 * {@link captureVerbStdout}, but returns the verb's numeric exit code,
 * and a thrown error lands in `errorMessage` (with `exitCode: null`)
 * instead of being appended to the buffer — the tool bridge renders
 * failures into typed envelopes, not into the captured text.
 */
export async function captureVerbRun(
  verb: VerbFn,
  args: ReadonlyArray<string>,
): Promise<CaptureVerbRunResult> {
  return await runRedirected(verb, args);
}

/**
 * What the mutex is doing right now.
 *
 * WHY IT IS OBSERVABLE. A verb that never returns keeps its slot forever
 * — the tool timeout bounds the RESPONSE, not the execution — so every
 * later tool call waits behind it. That is a wedge, not a stall, and
 * nothing about it is visible from outside unless the mutex says so,
 * which is exactly how `/healthz` came to answer `{"ok":true}` for a
 * functionally dead service. This struct is what makes the wedge
 * reportable, and `holder` / `heldSince` remain the whole of that verdict
 * — the queue cap added below deliberately does NOT touch them.
 */
export interface VerbMutexState {
  /** Label of the function currently holding the lock; null when idle. */
  holder: string | null;
  /** Clock value at which the current holder acquired; null when idle. */
  heldSince: number | null;
  /** Functions queued and not yet started (excludes the holder). */
  queueDepth: number;
}

/** Label used when `run` is called without one. */
export const VERB_MUTEX_UNLABELLED = "(unlabelled)";

/**
 * Default cap on callers QUEUED behind the holder (the holder itself is
 * not counted).
 *
 * The operator is one person speaking, and a provider issues at most a
 * handful of parallel tool calls per turn. Eight waiting calls is already
 * far past anything a conversation produces, so the cap is only ever
 * reached when the lane is stuck — at which point refusing immediately,
 * NAMING the stuck verb, beats accepting work that will never be spoken.
 */
export const VERB_MUTEX_MAX_QUEUE = 8;

export interface VerbMutexRunOpts {
  /**
   * Give up if this function has not STARTED within `abandonAfterMs` of
   * being queued. It is then skipped — never run — and its caller gets a
   * {@link VerbMutexError} with `reason: "abandoned"`.
   *
   * The voice bridge passes its own tool timeout here, which makes the
   * rule: *a call whose response deadline has already passed must not be
   * executed late.* Its result was discarded the moment the bridge
   * answered `tool_timeout`, so running it buys nothing — and for the
   * mutating tools P7 enables it actively harms, firing a `dispatch_task`
   * minutes after the operator was told it timed out.
   *
   * Omitted = never abandon (the historical behaviour).
   */
  abandonAfterMs?: number;
}

/** Strict-FIFO async mutex — see file header for why it exists. */
export interface VerbMutex {
  /** Queue `fn`. `label` names the work for {@link VerbMutex.state} — the
   *  voice bridge passes the tool name so a wedge can be attributed.
   *  Rejects with {@link VerbMutexError} when the queue is at its cap, or
   *  when `opts.abandonAfterMs` elapsed before `fn` could start. */
  run<T>(fn: () => Promise<T>, label?: string, opts?: VerbMutexRunOpts): Promise<T>;
  /** Current holder + queue depth. Cheap; safe to call per health probe. */
  state(): VerbMutexState;
}

export interface CreateVerbMutexOpts {
  /**
   * Clock stamped onto `heldSince`. MUST be the same clock the consumer
   * compares against, or the held-duration it computes is meaningless.
   * Defaults to `Date.now`.
   */
  clock?: () => number;
  /** Queue cap; defaults to {@link VERB_MUTEX_MAX_QUEUE}. */
  maxQueueDepth?: number;
}

/**
 * Create a strict-FIFO async mutex. `run(fn)` queues `fn` behind every
 * previously queued function (call order = execution order) and resolves
 * / rejects with `fn`'s own outcome. A rejection does NOT poison the
 * queue: the slot is released in `finally`, so the next queued function
 * still runs.
 *
 * THE QUEUE IS BOUNDED, and this reverses the earlier "deliberately
 * uncapped" design (ADR-272 §Supplement-P7 §R2). The old argument was
 * that a cap would "hide a wedge behind a cheerful rejection". That is
 * true of a cap ALONE and false of this one, for two reasons:
 *
 *   1. The wedge verdict never depended on queue depth. It is computed
 *      from `holder` + `heldSince` (see {@link VerbMutexState}), both
 *      untouched here, so `/healthz` stays exactly as loud as before.
 *   2. A refusal that NAMES the holder is not cheerful. A capped-out
 *      caller learns which verb is stuck and for how long — strictly more
 *      than the bare timeout it used to get after burning its full
 *      deadline waiting.
 *
 * And the abandon path is what turns reporting into recovery: when a
 * stuck verb finally returns, entries whose deadline has passed are
 * SKIPPED rather than executed, so the queue drains at once instead of
 * grinding through a backlog of answers nobody is waiting for.
 *
 * What this does NOT do: rescue a verb that never returns at all. The
 * capture wrapper monkeypatches `process.stdout.write`, so a second verb
 * cannot run alongside the first (see the file header). The lane still
 * needs its holder to finish; what changes is that everything behind it
 * fails fast, fails loudly, and drains cleanly.
 */
export function createVerbMutex(opts: CreateVerbMutexOpts = {}): VerbMutex {
  const clock = opts.clock ?? ((): number => Date.now());
  const queueCap = opts.maxQueueDepth ?? VERB_MUTEX_MAX_QUEUE;
  let tail: Promise<void> = Promise.resolve();
  let holder: string | null = null;
  let heldSince: number | null = null;
  let queueDepth = 0;
  return {
    run<T>(
      fn: () => Promise<T>,
      label: string = VERB_MUTEX_UNLABELLED,
      runOpts: VerbMutexRunOpts = {},
    ): Promise<T> {
      if (queueDepth >= queueCap) {
        return Promise.reject(
          new VerbMutexError({
            reason: "queue_full",
            label,
            blockedBy: holder,
            waitedMs: 0,
            queueDepth,
            queueCap,
          }),
        );
      }
      // Who we are waiting on. Captured NOW because by the time this
      // entry reaches the head the holder has just released, and a null
      // there would name nobody.
      const blockedBy = holder;
      const enqueuedAt = clock();
      const prev = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      queueDepth += 1;
      return prev.then(async () => {
        queueDepth -= 1;
        const waitedMs = clock() - enqueuedAt;
        const deadline = runOpts.abandonAfterMs;
        if (deadline !== undefined && waitedMs > deadline) {
          // Skipped, not run: releasing FIRST keeps the queue draining.
          release();
          throw new VerbMutexError({
            reason: "abandoned",
            label,
            blockedBy,
            waitedMs,
            queueDepth,
            queueCap,
          });
        }
        holder = label;
        heldSince = clock();
        try {
          return await fn();
        } finally {
          holder = null;
          heldSince = null;
          release();
        }
      });
    },
    state(): VerbMutexState {
      return { holder, heldSince, queueDepth };
    },
  };
}
