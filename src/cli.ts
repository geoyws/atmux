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

import { exists } from "./abstractions/fs.ts";
import { getAtmuxDir, teamJsonPath, tryLoadTeam } from "./core/common.ts";
import { safeAppendVerbEvent, type VerbEvent } from "./core/events-log.ts";
import { AtmuxError, exitCodeForTag, formatErrorChain, UsageError } from "./errors.ts";
import { addMember } from "./verbs/add-member.ts";
import { attach } from "./verbs/attach.ts";
import { audit } from "./verbs/audit.ts";
import { blockers } from "./verbs/blockers.ts";
import { claim, done } from "./verbs/claim.ts";
import { cleanup } from "./verbs/cleanup.ts";
import { cockpit } from "./verbs/cockpit.ts";
import { committer } from "./verbs/committer.ts";
import { complaints } from "./verbs/complaints.ts";
import { cost } from "./verbs/cost.ts";
import { cronInstall } from "./verbs/cron-install.ts";
import { cronOrphans } from "./verbs/cron-orphans.ts";
import { cronRemove } from "./verbs/cron-remove.ts";
import { dashboard } from "./verbs/dashboard.ts";
import { discorder } from "./verbs/discorder.ts";
import { dispatch as dispatchVerb } from "./verbs/dispatch.ts";
import { doctor } from "./verbs/doctor.ts";
import { driverInbox } from "./verbs/driver-inbox.ts";
import { epic } from "./verbs/epic.ts";
import { epicMerge } from "./verbs/epic-merge.ts";
import { groom } from "./verbs/groom.ts";
import { handoff } from "./verbs/handoff.ts";
import { health } from "./verbs/health.ts";
import { help } from "./verbs/help.ts";
import { hygieneTick } from "./verbs/hygiene-tick.ts";
import { improve } from "./verbs/improve.ts";
import { inbox } from "./verbs/inbox.ts";
import { init } from "./verbs/init.ts";
import { laneDriftCheck } from "./verbs/lane-drift-check.ts";
import { laneStallTick } from "./verbs/lane-stall-tick.ts";
import { laneTick } from "./verbs/lane-tick.ts";
import { dispatchMemberSubverb } from "./verbs/member.ts";
import { mergeCycle } from "./verbs/merge-cycle.ts";
import { mergeMember } from "./verbs/merge-member.ts";
import { migrateState } from "./verbs/migrate-state.ts";
import { ombudsman } from "./verbs/ombudsman.ts";
import { pause, resume } from "./verbs/pause.ts";
import { poke } from "./verbs/poke.ts";
import { pokeResumeCheck } from "./verbs/poke-resume-check.ts";
import { pulse } from "./verbs/pulse.ts";
import { reconfigure } from "./verbs/reconfigure.ts";
import { refusalScan } from "./verbs/refusal-scan.ts";
import { outbox, reply } from "./verbs/reply.ts";
import { report } from "./verbs/report.ts";
import { rotate, rotateLead } from "./verbs/rotate.ts";
import { send } from "./verbs/send.ts";
import { sentinel } from "./verbs/sentinel.ts";
import { start } from "./verbs/start.ts";
import { status } from "./verbs/status.ts";
import { stop } from "./verbs/stop.ts";
import { story } from "./verbs/story.ts";
import { task } from "./verbs/task.ts";
import { dissolveEpic } from "./verbs/team/dissolve-epic.ts";
import { spawnEpic } from "./verbs/team/spawn-epic.ts";
import { teamRepairRename } from "./verbs/team-repair-rename.ts";
import { tellLead } from "./verbs/tell-lead.ts";
import { up } from "./verbs/up.ts";
import { version } from "./verbs/version.ts";
import { watchdog } from "./verbs/watchdog.ts";

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
 * exit code. The append is best-effort — any failure (no team yet,
 * disk full, race on parent dir) is swallowed by `safeAppendVerbEvent`
 * with a stderr WARN. Events are observability, not load-bearing state.
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
 * empty cwd) — no point creating `logs/` next to a not-yet-initialised
 * team. Team name is read from team.json when present, empty string
 * otherwise (schema-tolerant for pre-init partial states).
 *
 * Internal — exported only via the test re-import in
 * `tests/unit/cli.test.ts` for direct coverage. Production calls come
 * exclusively from `main()` above.
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
    case "audit":
      return audit(argv.slice(1));
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
    case "epic":
      return epic(argv.slice(1));
    case "story":
      return story(argv.slice(1));
    case "team":
      return dispatchTeamSubverb(argv.slice(1));
    case "member":
      return dispatchMemberSubverb(argv.slice(1));
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
    case "lane-tick":
      return laneTick(argv.slice(1));
    case "lane-stall-tick":
      return laneStallTick(argv.slice(1));
    case "lane-drift-check":
      return laneDriftCheck(argv.slice(1));
    case "refusal-scan":
      return refusalScan(argv.slice(1));
    case "merge-cycle":
      return mergeCycle(argv.slice(1));
    case "merge-member":
      return mergeMember(argv.slice(1));
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
    case "cron-install":
      return cronInstall(argv.slice(1));
    case "cron-remove":
      return cronRemove(argv.slice(1));
    case "cron-orphans":
      return cronOrphans(argv.slice(1));
    case "cockpit":
      return cockpit(argv.slice(1));
    case "sentinel":
      return sentinel(argv.slice(1));
    case "ombudsman":
      return ombudsman(argv.slice(1));
    case "committer":
      return committer(argv.slice(1));
    case "gitter":
      // ADR-159 TR2 legacy alias — `atmux gitter` retained for one
      // release cycle; emit a deprecation-warn so cron + operator
      // scripts surface the rename ask. TR3+ amendment removes the
      // alias.
      process.stderr.write(
        "atmux: 'gitter' verb is deprecated — use 'committer' per ADR-159. " +
          "Accepting this release; will fail next release.\n",
      );
      return committer(argv.slice(1));
    case "epic-merge":
      return epicMerge(argv.slice(1));
    case "complaints":
      return complaints(argv.slice(1));
    case "blockers":
      return blockers(argv.slice(1));
    case "doctor":
      return doctor(argv.slice(1));
    case "health":
      return health(argv.slice(1));
    case "driver-inbox":
      return driverInbox(argv.slice(1));
    case "poke":
      return poke(argv.slice(1));
    case "poke-resume-check":
      return pokeResumeCheck(argv.slice(1));
    // ADR-160: legacy `whip` + `whip-resume-check` surfaces retained for
    // one release cycle with stderr deprecation-warn. Operator cron lines
    // continue invoking the canonical `poke` handler via this alias;
    // post-cycle the alias is removed and stale cron entries get a
    // refusal hint citing ADR-160.
    case "whip":
      process.stderr.write(
        "atmux: 'atmux whip' is deprecated and renamed to 'atmux poke' per ADR-160; routing to canonical handler. Update cron lines + scripts before the next release.\n",
      );
      return poke(argv.slice(1));
    case "whip-resume-check":
      process.stderr.write(
        "atmux: 'atmux whip-resume-check' is deprecated and renamed to 'atmux poke-resume-check' per ADR-160; routing to canonical handler. Update cron lines + scripts before the next release.\n",
      );
      return pokeResumeCheck(argv.slice(1));
    case "watchdog":
      return watchdog(argv.slice(1));
    case "pulse":
      return pulse(argv.slice(1));
    case "improve":
      return improve(argv.slice(1));
    case "groom":
      return groom(argv.slice(1));
    case "hygiene-tick": {
      // ADR-131 T3 (t-247b4b35): superdoctor's kanban-hygiene pass.
      // hygieneTick returns a DrainTickResult; the CLI dispatcher
      // discards it and returns exit code 0 unless an exception
      // bubbles up.
      await hygieneTick(argv.slice(1));
      return 0;
    }
    case "cleanup":
      return cleanup(argv.slice(1));
    case "discorder":
      return discorder(argv.slice(1));
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
 * `atmux team <sub> [args]` — bash spec routes `rename` + `repair-rename`
 * here. V1 ports `repair-rename` only; `rename` still pending (lib/
 * team-rename.sh @ 398 LOC). Unknown sub-verbs throw UsageError so the
 * exit code matches bash bin-atmux:295 (echo + exit 64).
 */
export async function dispatchTeamSubverb(argv: ReadonlyArray<string>): Promise<number> {
  const sub = argv[0];
  if (sub === undefined || sub === "") {
    throw new UsageError({
      what: "team: subverb required (try: repair-rename | spawn-epic | dissolve-epic)",
      hint: "run 'atmux help' for the list of verbs",
    });
  }
  switch (sub) {
    case "repair-rename":
      return teamRepairRename(argv.slice(1));
    case "spawn-epic":
      return spawnEpic(argv.slice(1));
    case "dissolve-epic":
      return dissolveEpic(argv.slice(1));
    default:
      throw new UsageError({
        what: `team: unknown subverb '${sub}' (try: repair-rename | spawn-epic | dissolve-epic)`,
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
