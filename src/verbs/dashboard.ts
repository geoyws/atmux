// ADR-010: CLI dispatcher — `dashboard` verb (interactive, redraw loop).
// Bash spec: lib/dashboard.sh @ worktree-frozen.
//
// `atmux dashboard [--interval <s>] [-n <s>]`
//
// Live full-screen status panel. Every `interval` seconds the screen
// is cleared (ANSI \e[2J + cursor home \e[H), a header is printed, and
// four sections are emitted:
//
//   1. `atmux status` — full output (un-truncated).
//   2. `─── recent kanban ───` + `atmux task list` first 10 lines.
//   3. `─── driver-inbox open ───` + lines under `## Open` in the
//      driver-inbox.md that begin with `- `, first 5.
//   4. `─── lead-outbox open ───` + `atmux outbox` first 10 lines.
//
// Coverage strategy. The render LOOP is impossible to assert directly
// in `bun:test` (it never terminates against a real `setTimeout` clock).
// We follow the `attach.ts` pattern: extract a pure `dashboardLoop`
// that takes injectable deps (`collect`, `sleep`, `write`, `signal`,
// `maxFrames`); the public `dashboard()` wires real deps. Tests drive
// the loop with stubs and `maxFrames` to assert frame composition,
// signal handling, and arg parsing without spinning real terminals.
//
// Bash divergence note. Bash shells out (`"$ATMUX_BIN_DIR/atmux"
// status`) so each tick costs ~3 fork+exec round-trips. The TS port
// composes data in-process via the same data primitives the verbs use
// (`gatherStatus`, `loadKanban`, etc.). Output text is held to bash
// parity by reusing the verbs' own renderers; only the wrapping +
// truncation logic lives here.

import { exists } from "../abstractions/fs.ts";
import { driverInboxPath, getAtmuxDir, type ResolveDirOpts, requireTeam } from "../core/common.ts";
import { type DriverPaneHealth, probeDriverPane } from "../core/driver-pane-health.ts";
import { UsageError } from "../errors.ts";

const USAGE = "atmux dashboard [--interval <s>]";

// ---------- Args ----------

/** Parsed `dashboard` argv. */
export interface DashboardArgs {
  intervalSec: number;
  teamDir?: string;
}

/** Pure parser. Throws `UsageError` on bad invocation. */
export function parseDashboardArgs(argv: ReadonlyArray<string>): DashboardArgs {
  let intervalSec = 5;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--interval" || a === "-n") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({
          what: `dashboard: ${a} requires a seconds value`,
          hint: USAGE,
        });
      }
      const parsed = Number(v);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new UsageError({
          what: `dashboard: ${a} must be a positive number, got '${v}'`,
          hint: USAGE,
        });
      }
      intervalSec = parsed;
      i += 2;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({
          what: "dashboard: --team-dir requires a directory argument",
          hint: USAGE,
        });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    throw new UsageError({ what: `dashboard: unknown arg: ${a ?? ""}`, hint: USAGE });
  }
  const out: DashboardArgs = { intervalSec };
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

// ---------- Frame composition ----------

/** ANSI clear-screen-and-home sequence (bash `printf '\e[H\e[2J'`). */
export const CLEAR_AND_HOME = "\x1b[H\x1b[2J";

/** ANSI clear-screen (bash `printf '\e[2J'` — no cursor home). */
export const CLEAR = "\x1b[2J";

/** Bold ANSI on/off (bash `$atmux_c_bld` / `$atmux_c_rst`). */
const BOLD_ON = "\x1b[1m";
const BOLD_OFF = "\x1b[0m";

/** Snapshot inputs for one rendered frame. Strings are concatenated
 *  by `composeFrame`. Each section is provided as the captured text
 *  (already truncated to its bash-`head -N` cap). */
export interface FrameSnapshot {
  intervalSec: number;
  /** `atmux status` body (full output, no truncation). */
  status: string;
  /** First ≤10 lines of `atmux task list`. */
  recentKanban: string;
  /** First ≤5 lines under `## Open` in `driver-inbox.md` that start
   *  with `- ` (looser than `outbox`'s `- [` because bash awk uses
   *  the same looser pattern in dashboard.sh:34). */
  driverInbox: string;
  /** First ≤10 lines of `atmux outbox`. */
  outbox: string;
  /** ADR-064 §4: driver-pane health snapshot. Optional for back-compat
   *  with existing test fixtures; absence is rendered same as
   *  `configured=false` (block skipped). */
  driverPane?: DriverPaneHealth;
}

/** Compose one frame body (no leading clear; the loop emits that). */
export function composeFrame(snap: FrameSnapshot): string {
  const header = `${BOLD_ON}🎛️  atmux dashboard${BOLD_OFF}   (refresh ${snap.intervalSec}s — ctrl-c to exit)\n\n`;
  // bash dashboard.sh:27 always emits a trailing newline after status
  // via the `echo ""` on line 28; preserve.
  const statusBlock = `${snap.status}${ensureTrailingNewline(snap.status)}\n`;
  const kanbanBlock = `─── recent kanban ───\n${snap.recentKanban}${ensureTrailingNewline(snap.recentKanban)}\n`;
  // ADR-064 §4: driver-pane block above driver-inbox. Skipped when the
  // team didn't opt into the ADR-044 driver-window topology OR when the
  // snapshot lacks the field (back-compat).
  const driverPaneBlock =
    snap.driverPane === undefined ? "" : renderDriverPaneBlock(snap.driverPane);
  const inboxBlock = `─── driver-inbox open ───\n${snap.driverInbox}${ensureTrailingNewline(snap.driverInbox)}\n`;
  const outboxBlock = `─── lead-outbox open ───\n${snap.outbox}${ensureTrailingNewline(snap.outbox)}`;
  return `${header}${statusBlock}${kanbanBlock}${driverPaneBlock}${inboxBlock}${outboxBlock}`;
}

/** ADR-064 §4 dashboard block. Empty string when unconfigured (skip
 *  block); else 3-line block with trailing newline. */
function renderDriverPaneBlock(dp: DriverPaneHealth): string {
  if (!dp.configured) return "";
  const window = dp.windowExists ? "exists" : "missing";
  const state = dp.windowExists ? (dp.state ?? "UNKNOWN") : "n/a";
  const evidence = dp.evidence.length > 80 ? `${dp.evidence.slice(0, 80)}…` : dp.evidence;
  return (
    `─── driver pane ───\n` +
    `configured=y  window=${window}  state=${state}\n` +
    `evidence: ${evidence}\n`
  );
}

/** Empty string → "" (no newline). Otherwise return "\n" if missing,
 *  "" if present. Mirrors bash's behaviour where `echo ""` emits a
 *  blank line independent of whether the prior command's output ended
 *  with a newline; this helper stitches subsections together cleanly. */
function ensureTrailingNewline(s: string): string {
  if (s.length === 0) return "";
  return s.endsWith("\n") ? "" : "\n";
}

/** Take the first N lines of `s`. `\n`-delimited. The slice INCLUDES
 *  the trailing newline of the Nth line if present. Mirrors `head -N`
 *  semantics (bash `... | head -10`). */
export function takeFirstLines(s: string, n: number): string {
  if (n <= 0 || s.length === 0) return "";
  const lines = s.split("\n");
  // `split('\n')` on "a\nb\n" yields ["a","b",""] — keep that empty
  // tail so a re-join roundtrips. Take min(n+1, lines.length) so the
  // joined result has exactly `n` `\n` separators when the source had
  // ≥n full lines.
  const take = Math.min(n, lines.length);
  const chunk = lines.slice(0, take);
  // If the source ended with a newline AND we took all lines, append
  // the empty tail back so the join produces the same trailing newline.
  if (take === lines.length) return s; // unchanged
  return `${chunk.join("\n")}\n`;
}

/**
 * Awk equivalent of `awk '/^## Open/{flag=1;next}/^## /{flag=0}flag &&
 * /^- /'` from bash dashboard.sh:34. Lines BETWEEN the `## Open`
 * heading and the next `## …` heading that start with `- ` (any
 * character after the dash-space). Looser than `collectOpenEntries`
 * in reply.ts which requires `- [` — bash dashboard's awk uses the
 * looser pattern, and we mirror that.
 */
export function collectDashboardOpenLines(body: string): string[] {
  const lines = body.split("\n");
  let inOpen = false;
  const out: string[] = [];
  for (const line of lines) {
    if (/^## Open/.test(line)) {
      inOpen = true;
      continue;
    }
    if (/^## /.test(line)) {
      inOpen = false;
      continue;
    }
    if (inOpen && /^- /.test(line)) out.push(line);
  }
  return out;
}

// ---------- Dashboard loop ----------

/** Source-of-data + plumbing for one dashboard tick. Tests stub
 *  `collect`, `sleep`, `write`, and `signal` for deterministic
 *  assertions without real timers / real terminals. */
export interface DashboardLoopDeps {
  /** Resolve the current frame's data inputs. */
  collect: () => Promise<Omit<FrameSnapshot, "intervalSec">>;
  /** Resolve after `ms` ms. Default uses `setTimeout`. */
  sleep: (ms: number) => Promise<void>;
  /** Write to stdout. Default = `process.stdout.write`. */
  write: (s: string) => void;
  /** External cancellation. When fired, the loop returns 0 between
   *  ticks (and immediately if fired before the first frame). */
  signal?: AbortSignal;
  /** Test cap on frame count. `undefined` = unbounded (the prod loop). */
  maxFrames?: number;
}

/**
 * Render frames until `signal` aborts or `maxFrames` is reached. The
 * caller owns the dependency wiring; this function only knows about
 * the abstract render-tick contract.
 */
export async function dashboardLoop(deps: DashboardLoopDeps, intervalSec: number): Promise<number> {
  // `aborted` is a mutable getter on AbortSignal — re-evaluate via a
  // closure on every tick. TS narrowing assumes properties don't
  // change across statements, which would mark the second check
  // unreachable; the closure call breaks that narrowing.
  const isAborted = (): boolean => deps.signal?.aborted ?? false;
  if (isAborted()) return 0;
  // Bash dashboard.sh:21 emits a single clear before the loop body so
  // the operator sees a clean canvas even if the first `collect` is
  // slow.
  deps.write(CLEAR);
  let frames = 0;
  while (true) {
    if (isAborted()) return 0;
    const data = await deps.collect();
    const frame = composeFrame({ intervalSec, ...data });
    deps.write(`${CLEAR_AND_HOME}${frame}`);
    frames += 1;
    if (deps.maxFrames !== undefined && frames >= deps.maxFrames) return 0;
    await deps.sleep(intervalSec * 1000);
  }
}

// ---------- Real-data collector (prod wiring) ----------

/** Build a `collect` closure bound to the resolved team + dirs. The
 *  closure invokes the in-process verb functions with `process.stdout`
 *  redirected to a per-call buffer, then truncates the captured
 *  strings per bash's `head -N` semantics. Public for direct unit
 *  tests of the wiring layer. */
export function makeRealCollect(
  collectStatus: () => Promise<string>,
  collectTaskList: () => Promise<string>,
  collectOutbox: () => Promise<string>,
  readDriverInbox: () => Promise<string | null>,
  collectDriverPane?: () => Promise<DriverPaneHealth>,
): () => Promise<Omit<FrameSnapshot, "intervalSec">> {
  return async () => {
    // SEQUENTIAL — `captureVerbStdout` mutates `process.stdout.write`
    // around its verb call and restores in `finally`. Two concurrent
    // captures would clobber each other's saved-original (verb A
    // restores to verb B's override → next call writes to a stale
    // buffer). Bash dashboard.sh runs the same four reads serially
    // anyway; we mirror. The `head -10` truncation makes this cheap.
    const status = await collectStatus();
    const kanban = await collectTaskList();
    const outbox = await collectOutbox();
    const di = await readDriverInbox();
    const driverPane = collectDriverPane === undefined ? undefined : await collectDriverPane();
    let driverInbox = "";
    if (di !== null) {
      const lines = collectDashboardOpenLines(di).slice(0, 5);
      driverInbox = lines.length > 0 ? `${lines.join("\n")}\n` : "";
    }
    const out: Omit<FrameSnapshot, "intervalSec"> = {
      status,
      recentKanban: takeFirstLines(kanban, 10),
      outbox: takeFirstLines(outbox, 10),
      driverInbox,
    };
    if (driverPane !== undefined) out.driverPane = driverPane;
    return out;
  };
}

/**
 * Run an in-process verb function with `process.stdout.write` and
 * `console.log` redirected to a buffer. Returns the captured text.
 * Errors thrown by the verb are caught and re-rendered as a single
 * line `"<verb-name>: <message>\n"` — bash dashboard.sh swallows the
 * whole call via `|| true`, mirror.
 */
export async function captureVerbStdout(
  verb: (a: ReadonlyArray<string>) => Promise<number>,
  args: ReadonlyArray<string>,
  label: string,
): Promise<string> {
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
    await verb(args);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    buf += `${label}: ${msg}\n`;
  } finally {
    process.stdout.write = origStdoutWrite;
    console.log = origLog;
  }
  return buf;
}

// ---------- Public verb entry ----------

/** Default `sleep` — resolves after `ms` ms via setTimeout. Exported
 *  so the coverage gate sees the same code path tests can drive
 *  directly with a 0-ms tick. */
export function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Build a closure that reads `<atmuxDir>/driver-inbox.md` if it
 *  exists, else returns `null`. Exported so the read path is unit-
 *  testable without going through the full `dashboard()` wiring. */
export function buildDriverInboxReader(atmuxDir: string): () => Promise<string | null> {
  return async () => {
    const p = driverInboxPath(atmuxDir);
    if (!(await exists(p))) return null;
    return await Bun.file(p).text();
  };
}

/** Verb function shape — every verb exports `(args) => Promise<exit>`. */
type VerbFn = (a: ReadonlyArray<string>) => Promise<number>;

/** Wiring layer: build the `DashboardLoopDeps` for the prod runtime.
 *  Exported so the closures (the four collect-binders + the write
 *  passthrough) are exercisable from unit tests without spinning the
 *  full `dashboard()` entry point. The dashboard verb itself just
 *  hands these deps to `dashboardLoop` and registers signal handlers. */
export function buildLoopDeps(
  atmuxDir: string,
  statusVerb: VerbFn,
  taskVerb: VerbFn,
  outboxVerb: VerbFn,
  signal: AbortSignal,
  collectDriverPane?: () => Promise<DriverPaneHealth>,
): DashboardLoopDeps {
  return {
    collect: makeRealCollect(
      () => captureVerbStdout(statusVerb, [], "status"),
      () => captureVerbStdout(taskVerb, ["list"], "task list"),
      () => captureVerbStdout(outboxVerb, [], "outbox"),
      buildDriverInboxReader(atmuxDir),
      collectDriverPane,
    ),
    sleep: realSleep,
    write: (s: string) => {
      process.stdout.write(s);
    },
    signal,
  };
}

/**
 * `atmux dashboard [--interval <s>] [-n <s>]`.
 *
 * Returns 0 on signal-abort (SIGINT/SIGTERM) or when the cancel signal
 * is fired by the caller. Throws `ConfigError` (no team.json) /
 * `UsageError` (bad args) before entering the loop.
 */
export async function dashboard(argv: ReadonlyArray<string>): Promise<number> {
  const parsed = parseDashboardArgs(argv);

  const dirOpts: ResolveDirOpts = {};
  if (parsed.teamDir !== undefined) dirOpts.teamDir = parsed.teamDir;

  // Pre-flight: same team-required precondition bash enforces via
  // `atmux::require_team`. Failing here yields a ConfigError → exit 78
  // before the screen-clear, so the operator sees the message rather
  // than a blank dashboard frame.
  const team = await requireTeam(dirOpts);
  const atmuxDir = await getAtmuxDir(dirOpts);

  // Lazy import the in-process verbs we delegate to. Static imports at
  // module top would create import-cycle risk against any verb that
  // ever wants to invoke the dashboard programmatically; lazy keeps
  // the dependency direction one-way.
  const { status: statusVerb } = await import("./status.ts");
  const { task: taskVerb } = await import("./task.ts");
  const { outbox: outboxVerb } = await import("./reply.ts");

  // SIGINT / SIGTERM → graceful shutdown. Bash dashboard.sh:18 sets a
  // trap that prints `dashboard: exit` and exits 0; mirror the visible
  // line + clean exit. The AbortController is the cancel signal we
  // pass to dashboardLoop; the listener is removed in finally.
  const abort = new AbortController();
  const onSignal = () => {
    process.stdout.write("\ndashboard: exit\n");
    abort.abort();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const deps = buildLoopDeps(atmuxDir, statusVerb, taskVerb, outboxVerb, abort.signal, () =>
      probeDriverPane(team, atmuxDir),
    );
    return await dashboardLoop(deps, parsed.intervalSec);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
