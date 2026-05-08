// ADR-010: CLI dispatcher.
// ADR-006: top-level error mapping (tag → BSD sysexits).
//
// Phase-1 minimal: routes the `version` verb (smallest state, first
// parity-harness verb per task #4). Unknown verbs throw `UsageError`,
// caught by the top-level handler which maps it to exit 64 (EX_USAGE)
// with a two-line bash-format stderr matching `bin/atmux:324-328`:
//
//   atmux: unknown verb: <verb>
//     run 'atmux help' for the list of verbs
//
// (Note on hint indent: bash uses 2-space; ADR-006 §"Top-level catch"
// sketches 7-space — bash parity wins here. The ADR's sketch was not
// strict, just illustrative; nothing else relies on the indent width.)
//
// `reportError` covers every ADR-006 error class so Phase 2 verbs that
// throw typed errors (FsError, TmuxError, etc.) get correct sysexits
// without further dispatcher work. Exported for direct unit testing
// (test naming convention: function exported AS-IS rather than `_`-
// prefixed because future verbs may legitimately call it for re-raise
// formatting; not test-only).
//
// Phase 2 expands the dispatch switch as porters land additional
// verbs; alias routing follows per ADR-014.
//
// **Pure library** — no module-level side effects. The TS entrypoint
// is `bin/atmux-bun` (excluded from the coverage denominator per its
// `bin/` path); running `bun run src/cli.ts <verb>` directly is NOT
// supported. This keeps `src/cli.ts` 100% unit-testable per ADR-009 §2.

import { AtmuxError, exitCodeForTag, formatErrorChain, UsageError } from "./errors.ts";
import { addMember } from "./verbs/add-member.ts";
import { attach } from "./verbs/attach.ts";
import { claim, done } from "./verbs/claim.ts";
import { cockpit } from "./verbs/cockpit.ts";
import { cost } from "./verbs/cost.ts";
import { dashboard } from "./verbs/dashboard.ts";
import { dispatch as dispatchVerb } from "./verbs/dispatch.ts";
import { doctor } from "./verbs/doctor.ts";
import { driverInbox } from "./verbs/driver-inbox.ts";
import { handoff } from "./verbs/handoff.ts";
import { help } from "./verbs/help.ts";
import { improve } from "./verbs/improve.ts";
import { inbox } from "./verbs/inbox.ts";
import { init } from "./verbs/init.ts";
import { migrateState } from "./verbs/migrate-state.ts";
import { pause, resume } from "./verbs/pause.ts";
import { reconfigure } from "./verbs/reconfigure.ts";
import { outbox, reply } from "./verbs/reply.ts";
import { report } from "./verbs/report.ts";
import { rotate, rotateLead } from "./verbs/rotate.ts";
import { send } from "./verbs/send.ts";
import { start } from "./verbs/start.ts";
import { status } from "./verbs/status.ts";
import { stop } from "./verbs/stop.ts";
import { task } from "./verbs/task.ts";
import { tellLead } from "./verbs/tell-lead.ts";
import { up } from "./verbs/up.ts";
import { version } from "./verbs/version.ts";
import { watchdog } from "./verbs/watchdog.ts";
import { whip } from "./verbs/whip.ts";
import { whipResumeCheck } from "./verbs/whip-resume-check.ts";

/**
 * Entry point — process argv (sliced past binary + script name) and
 * return the exit code. Wraps `dispatch` in a top-level catch that
 * maps ADR-006-tagged errors to BSD sysexits (`UsageError` → 64,
 * `*-timeout` → 75, `ConfigError` → 78, etc.). Anything not an
 * `AtmuxError` is treated as a programmer bug → exit 99 + stack.
 */
export async function main(argv: ReadonlyArray<string>): Promise<number> {
  try {
    return await dispatch(argv);
  } catch (err) {
    return reportError(err);
  }
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
    case "add-member":
      return addMember(argv.slice(1));
    case "reply":
      return reply(argv.slice(1));
    case "outbox":
      return outbox(argv.slice(1));
    case "send":
      return send(argv.slice(1));
    case "broadcast":
      return send(["--broadcast", ...argv.slice(1)]);
    case "task":
      return task(argv.slice(1));
    case "tell-lead":
      return tellLead(argv.slice(1));
    case "claim":
      return claim(argv.slice(1));
    case "done":
      return done(argv.slice(1));
    case "dispatch":
      return dispatchVerb(argv.slice(1));
    case "inbox":
      return inbox(argv.slice(1));
    case "pause":
      return pause(argv.slice(1));
    case "resume":
      return resume(argv.slice(1));
    case "dashboard":
      return dashboard(argv.slice(1));
    case "reconfigure":
      return reconfigure(argv.slice(1));
    case "rotate":
      return rotate(argv.slice(1));
    case "rotate-lead":
      return rotateLead(argv.slice(1));
    case "handoff":
      return handoff(argv.slice(1));
    case "report":
      return report(argv.slice(1));
    case "cost":
      return cost(argv.slice(1));
    case "cockpit":
      return cockpit(argv.slice(1));
    case "doctor":
      return doctor(argv.slice(1));
    case "driver-inbox":
      return driverInbox(argv.slice(1));
    case "whip":
      return whip(argv.slice(1));
    case "whip-resume-check":
      return whipResumeCheck(argv.slice(1));
    case "watchdog":
      return watchdog(argv.slice(1));
    case "improve":
      return improve(argv.slice(1));
    case "migrate-state":
      return migrateState(argv.slice(1));
    case "up":
      return up(argv.slice(1));
    case "":
      // bin/atmux:91 — bare `atmux` aliases to `up` (ADR-014).
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
 *   exit 64. Byte-matches bash `bin/atmux:324-328`.
 * - Other `AtmuxError` → `atmux: <tag>: <message>`, exit per
 *   `exitCodeForTag`. With `ATMUX_DEBUG=1` the full `cause` chain
 *   follows on stderr (per `formatErrorChain`).
 * - Anything else (programmer error / non-Error throw) →
 *   `atmux: internal error` + stack (or `String(err)`), exit 99.
 *
 * Exported so each branch can be unit-tested directly without wiring
 * a fake verb that throws each error type — every Phase 2 verb that
 * throws an `AtmuxError` exercises the same paths via `main()`.
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
