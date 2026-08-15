// ADR-272: voice operator interface — in-process verb capture + the
// FIFO mutex that serializes every voice tool execution.
//
// `captureVerbStdout` is lifted verbatim from `src/verbs/dashboard.ts`
// (which now re-imports it from here) so that core code — the voice
// tool bridge (`src/core/voice/tool-bridge.ts`) — can capture verb
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
// at a time, queued in call order.

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
 * WHY IT IS OBSERVABLE. The queue has no cap and no abandon path by
 * design — the tool timeout bounds the RESPONSE, not the execution, so a
 * verb that never returns keeps its slot forever and every later tool
 * call queues behind it and times out. That is a wedge, not a stall, and
 * the only recovery is `atmux voice --stop`. Nothing about it is visible
 * from outside unless the mutex says so, which is exactly how `/healthz`
 * came to answer `{"ok":true}` for a functionally dead service. This
 * struct is what makes the wedge reportable.
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

/** Strict-FIFO async mutex — see file header for why it exists. */
export interface VerbMutex {
  /** Queue `fn`. `label` names the work for {@link VerbMutex.state} — the
   *  voice bridge passes the tool name so a wedge can be attributed. */
  run<T>(fn: () => Promise<T>, label?: string): Promise<T>;
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
}

/**
 * Create a strict-FIFO async mutex. `run(fn)` queues `fn` behind every
 * previously queued function (call order = execution order) and resolves
 * / rejects with `fn`'s own outcome. A rejection does NOT poison the
 * queue: the slot is released in `finally`, so the next queued function
 * still runs.
 *
 * The queue is deliberately UNCAPPED. Capping it would hide a wedge
 * behind a cheerful rejection; reporting it (see {@link VerbMutexState})
 * surfaces the real fault instead.
 */
export function createVerbMutex(opts: CreateVerbMutexOpts = {}): VerbMutex {
  const clock = opts.clock ?? ((): number => Date.now());
  let tail: Promise<void> = Promise.resolve();
  let holder: string | null = null;
  let heldSince: number | null = null;
  let queueDepth = 0;
  return {
    run<T>(fn: () => Promise<T>, label: string = VERB_MUTEX_UNLABELLED): Promise<T> {
      const prev = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      queueDepth += 1;
      return prev.then(async () => {
        queueDepth -= 1;
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
