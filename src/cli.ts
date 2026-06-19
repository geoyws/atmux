// ADR-010: CLI dispatcher.
// ADR-006: top-level error mapping (tag → BSD sysexits).
// ADR-263: lean keep-set — atmux is a tmux harness + a task feed. The
// fleet-coordination verbs (orchd, cockpit, lanes, epics/stories, whip,
// auto-merge, roles, budget, refusal, …) were removed per ADR-263 §D4.
// Surviving verbs: lifecycle (init/start/stop/status/attach/up) · panes
// (send/broadcast) · maintenance (cleanup/reconfigure/doctor/sync/
// version/help) · the optional task feed (task/claim/done). The git task
// source (`issues sync`) lands in ADR-263 P3.
//
// Unknown verbs throw `UsageError`, caught by the top-level handler which
// maps it to exit 64 (EX_USAGE). `reportError` covers every ADR-006 error
// class so verbs that throw typed errors get correct sysexits.
//
// **Pure library** — no module-level side effects. The TS entrypoint is
// `bin/atmux-bun`; running `bun run src/cli.ts <verb>` directly is NOT
// supported. This keeps `src/cli.ts` 100% unit-testable per ADR-009 §2.

import { exists } from "./abstractions/fs.ts";
import { getAtmuxDir, teamJsonPath, tryLoadTeam } from "./core/common.ts";
import { safeAppendVerbEvent, type VerbEvent } from "./core/events-log.ts";
import { AtmuxError, exitCodeForTag, formatErrorChain, UsageError } from "./errors.ts";
import { attach } from "./verbs/attach.ts";
import { claim, done } from "./verbs/claim.ts";
import { cleanup } from "./verbs/cleanup.ts";
import { doctor } from "./verbs/doctor.ts";
import { help } from "./verbs/help.ts";
import { init } from "./verbs/init.ts";
import { reconfigure } from "./verbs/reconfigure.ts";
import { send } from "./verbs/send.ts";
import { start } from "./verbs/start.ts";
import { status } from "./verbs/status.ts";
import { stop } from "./verbs/stop.ts";
import { dispatchSyncSubverb } from "./verbs/sync.ts";
import { task } from "./verbs/task.ts";
import { up } from "./verbs/up.ts";
import { version } from "./verbs/version.ts";

/**
 * Entry point — process argv (sliced past binary + script name) and
 * return the exit code. Wraps `dispatch` in a top-level catch that
 * maps ADR-006-tagged errors to BSD sysexits (`UsageError` → 64,
 * `*-timeout` → 75, `ConfigError` → 78, etc.). Anything not an
 * `AtmuxError` is treated as a programmer bug → exit 99 + stack.
 *
 * Wraps the dispatch call in an events-log envelope (t-91cd050f): every
 * verb invocation appends one JSONL line to
 * `<atmuxDir>/logs/<YYYY>/<MM>/events.jsonl` with timing + outcome +
 * exit code. The append is best-effort.
 */
export async function main(argv: ReadonlyArray<string>): Promise<number> {
  const startMs = Date.now();
  const verb = argv[0] ?? "";
  let exit = 0;
  let outcome: VerbEvent["outcome"] = "ok";
  try {
    exit = await dispatch(argv);
    outcome = exit === 0 ? "ok" : "warn";
  } catch (err) {
    exit = reportError(err);
    outcome = "error";
  }
  await logVerbEvent({ verb, args: argv.slice(1), startMs, exit, outcome });
  return exit;
}

interface LogVerbEventOpts {
  verb: string;
  args: ReadonlyArray<string>;
  startMs: number;
  exit: number;
  outcome: VerbEvent["outcome"];
}

/**
 * Best-effort events-log append for `main()`'s envelope. Skipped when
 * `<atmuxDir>` doesn't exist on disk (first run / `init` against an
 * empty cwd). Team name is read from team.json when present, empty string
 * otherwise (schema-tolerant for pre-init partial states).
 *
 * Internal — exported only via the test re-import in
 * `tests/unit/cli.test.ts` for direct coverage.
 */
export async function logVerbEvent(opts: LogVerbEventOpts): Promise<void> {
  // Skip `--version` / `-V` / `--help` / `-h` aliases entirely — those
  // never touch the team state + would create a noise event for every
  // shell tab-complete probe.
  if (opts.verb === "--version" || opts.verb === "-V") return;
  if (opts.verb === "--help" || opts.verb === "-h") return;
  let atmuxDir: string;
  try {
    atmuxDir = await getAtmuxDir({});
  } catch {
    return; // path resolution itself failed — skip event log
  }
  if (!(await exists(atmuxDir))) return; // no team yet, skip
  let team = "";
  try {
    const t = await tryLoadTeam({ dir: atmuxDir });
    if (t !== null) team = t.name;
  } catch {
    // team.json malformed or absent — fall through with empty team
    if (await exists(teamJsonPath(atmuxDir))) {
      // team.json exists but unreadable — still log with empty team
    }
  }
  const event: VerbEvent = {
    ts: Math.floor(Date.now() / 1000),
    verb: opts.verb,
    args: opts.args,
    outcome: opts.outcome,
    durationMs: Date.now() - opts.startMs,
    exit: opts.exit,
    team,
  };
  await safeAppendVerbEvent(atmuxDir, event);
}

/**
 * Verb-table dispatch. Throws `UsageError` on unknown verb so the
 * exit code (64) flows through `reportError` rather than being a
 * dispatcher-special case.
 */
async function dispatch(argv: ReadonlyArray<string>): Promise<number> {
  const verb = argv[0] ?? "";
  switch (verb) {
    case "version":
    case "--version":
    case "-V":
      return version(argv.slice(1));
    case "help":
    case "--help":
    case "-h":
      return help(argv.slice(1));
    case "init":
      return init(argv.slice(1));
    case "start":
      return start(argv.slice(1));
    case "stop":
      return stop(argv.slice(1));
    case "status":
      return status(argv.slice(1));
    case "attach":
      return attach(argv.slice(1));
    case "send":
      return send(argv.slice(1));
    case "broadcast":
      return send(["--broadcast", ...argv.slice(1)]);
    case "task":
      return task(argv.slice(1));
    case "claim":
      return claim(argv.slice(1));
    case "done":
      return done(argv.slice(1));
    case "sync":
      return dispatchSyncSubverb(argv.slice(1));
    case "cleanup":
      return cleanup(argv.slice(1));
    case "reconfigure":
      return reconfigure(argv.slice(1));
    case "doctor":
      return doctor(argv.slice(1));
    case "up":
      return up(argv.slice(1));
    case "":
      // bare `atmux` aliases to `up` (ADR-014).
      return up([]);
    default:
      throw new UsageError({
        what: `unknown verb: ${verb || "<none>"}`,
        hint: "run 'atmux help' for the list of verbs",
      });
  }
}

/**
 * Map an error to stderr output + exit code per ADR-006 §"Top-level
 * catch":
 *
 * - `UsageError` → `atmux: <what>` + 2-space-indented hint (if any),
 *   exit 64.
 * - Other `AtmuxError` → `atmux: <tag>: <message>`, exit per
 *   `exitCodeForTag`. With `ATMUX_DEBUG=1` the full `cause` chain
 *   follows on stderr (per `formatErrorChain`).
 * - Anything else (programmer error / non-Error throw) →
 *   `atmux: internal error` + stack (or `String(err)`), exit 99.
 *
 * Exported so each branch can be unit-tested directly.
 */
export function reportError(err: unknown): number {
  if (err instanceof UsageError) {
    const ctx = err.context as { what: string; hint?: string };
    process.stderr.write(`atmux: ${ctx.what}\n`);
    if (ctx.hint !== undefined && ctx.hint !== "") {
      process.stderr.write(`  ${ctx.hint}\n`);
    }
    return 64;
  }
  if (err instanceof AtmuxError) {
    process.stderr.write(`atmux: ${err.tag}: ${err.message}\n`);
    const debug = process.env.ATMUX_DEBUG;
    if (debug !== undefined && debug !== "") {
      process.stderr.write(formatErrorChain(err));
    }
    return exitCodeForTag(err.tag);
  }
  process.stderr.write("atmux: internal error\n");
  if (err instanceof Error) {
    process.stderr.write(`${err.stack ?? err.message}\n`);
  } else {
    process.stderr.write(`${String(err)}\n`);
  }
  return 99;
}
