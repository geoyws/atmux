// ADR-202 §Amendment 2026-05-22 (V) — `atmux relayd` top-level verb.
//
// Promotes the event-router persona to first-class CLI surface. Splits
// the verb tree to align with the persona separation:
//
//   committer (verb) — merge-related operations:
//     --sweep   (existing, ADR-134)   branch-walking auto-merger
//
//   relayd    (verb) — event-routing operations:
//     --start   (long-lived NOTIFY/LISTEN consumer, multi-topic
//                dispatcher — uses atmux-listener Rust subprocess)
//     --drain   (one-shot cron-backstop drain across all topics)
//     --once    (test ergonomics — exit after first batch)
//     --max-events N (test ergonomics — exit after N events)
//
// The legacy `committer --daemon` / `committer --drain` invocations
// remain as deprecated aliases for one release, emitting a deprecation
// warn so cron lines + operator scripts surface the rename ask.
// Removed cleanly next release.
//
// Implementation re-uses the existing `committerDaemonVerb` /
// `committerDrainVerb` bodies — this verb is just a renamed entry
// point. Wiring stays in `verbs/committer.ts` to avoid a churn-only
// move; this file is a thin dispatcher.

import { join } from "node:path";
import { loadEventById, saveOffset } from "../abstractions/events.ts";
import { closeDatabase, openDatabase } from "../abstractions/sqlite.ts";
import { migrations } from "../abstractions/sqlite-migrations.ts";
import { getAtmuxDir, requireTeam, type ResolveDirOpts } from "../core/common.ts";
import {
  type CommitterOpts,
  buildEventDrivenContext,
  committerDaemonVerb,
  committerDrainVerb,
} from "./committer.ts";
import { ConfigError, UsageError } from "../errors.ts";
import type { Team } from "../schema/team.ts";
import { runLaneTick, runLaneTickForOne } from "./lane-tick.ts";

const USAGE =
  "atmux relayd <--start|--drain|--handle-one|--status> [--team-dir <path>] [--once] [--max-events N] [--event-id ID --topic T [--task-id ID --member NAME --lane L]]";

export interface ParsedRelaydArgs {
  /** Sub-verbs:
   *   - `start`       : long-lived multi-topic event-router. Pre-VII this
   *                     was the Bun long-lived process. Post-VII the
   *                     Rust `atmux-relayd` binary owns the long-lived
   *                     subscription + dispatch loop. This Bun verb's
   *                     --start path remains as a fallback when the Rust
   *                     binary isn't present (degraded mode).
   *   - `drain`       : one-shot cron-backstop drain across all topics.
   *                     Processes pending events via subscriber_offsets
   *                     table, exits 0.
   *   - `handle-one`  : (ADR-202 §VII) single-event dispatch — load
   *                     event by --event-id + --topic, run handler,
   *                     save offset, exit. Spawned by atmux-relayd Rust
   *                     binary once per arriving event.
   *   - `status`      : (ADR-202 §VIII /btw #9) single-shot diagnostic —
   *                     subscriber offsets, recent event counts per
   *                     topic, last-handler-outcome. Operator runs it
   *                     instead of grepping logs. */
  subverb: "start" | "drain" | "handle-one" | "status";
  teamDir?: string;
  /** `--once`: exit after first batch (test ergonomics). */
  once?: boolean;
  /** `--max-events N`: exit after processing N events (test ergonomics). */
  maxEvents?: number;
  /** `--event-id ID`: required when subverb is `handle-one`. */
  eventId?: string;
  /** `--topic T`: required when subverb is `handle-one`. */
  topic?: string;
  /** `--task-id ID`: (ADR-202 §Amendment 2026-05-22 IX-A) single-task
   *  hint for `handle-one --topic task.unclaimed`. The Rust dispatcher
   *  passes (taskId, lane) from the event payload so the Bun side can
   *  use the lean per-event dispatcher instead of the cross-member
   *  runLaneTick loop. Parser enforces: --task-id + --lane required-
   *  pair (T3 revision dropped --member from the required-set since
   *  TaskUnclaimedPayload has no member field — the handler derives
   *  member from lane via team.members[]). */
  taskId?: string;
  /** `--member NAME`: OPTIONAL override of the lane-to-member
   *  derivation in {@link relaydHandleOne}. Standalone --member
   *  (without --task-id + --lane) is rejected as a wire-format
   *  mistake. */
  member?: string;
  /** `--lane L`: see {@link taskId} — required alongside --task-id. */
  lane?: string;
}

export function parseRelaydArgs(argv: ReadonlyArray<string>): ParsedRelaydArgs {
  let subverb: "start" | "drain" | "handle-one" | "status" | undefined;
  let teamDir: string | undefined;
  let once = false;
  let maxEvents: number | undefined;
  let eventId: string | undefined;
  let topic: string | undefined;
  let taskId: string | undefined;
  let member: string | undefined;
  let lane: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--start" || a === "start") {
      subverb = "start";
      i += 1;
      continue;
    }
    if (a === "--drain" || a === "drain") {
      subverb = "drain";
      i += 1;
      continue;
    }
    if (a === "--handle-one" || a === "handle-one") {
      subverb = "handle-one";
      i += 1;
      continue;
    }
    if (a === "--status" || a === "status") {
      subverb = "status";
      i += 1;
      continue;
    }
    if (a === "--once") {
      once = true;
      i += 1;
      continue;
    }
    if (a === "--max-events") {
      const v = argv[i + 1];
      if (v === undefined || v === "") {
        throw new UsageError({
          what: "relayd: --max-events requires a value",
          hint: USAGE,
        });
      }
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new UsageError({
          what: `relayd: --max-events must be a positive integer (got ${v})`,
          hint: USAGE,
        });
      }
      maxEvents = n;
      i += 2;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined || v === "") {
        throw new UsageError({
          what: "relayd: --team-dir requires a value",
          hint: USAGE,
        });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    if (a === "--event-id") {
      const v = argv[i + 1];
      if (v === undefined || v === "") {
        throw new UsageError({
          what: "relayd: --event-id requires a value",
          hint: USAGE,
        });
      }
      eventId = v;
      i += 2;
      continue;
    }
    if (a === "--topic") {
      const v = argv[i + 1];
      if (v === undefined || v === "") {
        throw new UsageError({
          what: "relayd: --topic requires a value",
          hint: USAGE,
        });
      }
      topic = v;
      i += 2;
      continue;
    }
    if (a === "--task-id") {
      const v = argv[i + 1];
      if (v === undefined || v === "") {
        throw new UsageError({
          what: "relayd: --task-id requires a value",
          hint: USAGE,
        });
      }
      taskId = v;
      i += 2;
      continue;
    }
    if (a === "--member") {
      const v = argv[i + 1];
      if (v === undefined || v === "") {
        throw new UsageError({
          what: "relayd: --member requires a value",
          hint: USAGE,
        });
      }
      member = v;
      i += 2;
      continue;
    }
    if (a === "--lane") {
      const v = argv[i + 1];
      if (v === undefined || v === "") {
        throw new UsageError({
          what: "relayd: --lane requires a value",
          hint: USAGE,
        });
      }
      lane = v;
      i += 2;
      continue;
    }
    if (a?.startsWith("-") === true) {
      throw new UsageError({ what: `relayd: unknown flag: ${a}`, hint: USAGE });
    }
    throw new UsageError({ what: `relayd: unexpected arg: ${a}`, hint: USAGE });
  }
  if (subverb === undefined) {
    throw new UsageError({
      what: "relayd: no sub-verb specified (--start, --drain, or --handle-one)",
      hint: USAGE,
    });
  }
  if (subverb === "handle-one") {
    if (eventId === undefined) {
      throw new UsageError({
        what: "relayd --handle-one: --event-id required",
        hint: USAGE,
      });
    }
    if (topic === undefined) {
      throw new UsageError({
        what: "relayd --handle-one: --topic required",
        hint: USAGE,
      });
    }
  }
  // ADR-202 §Amendment 2026-05-22 IX-A (T3 revision — see commit msg
  // for t-c8efcec0): TaskUnclaimedPayload does NOT carry `member`
  // (task is unclaimed at emit time), so the Rust dispatcher passes
  // only `--task-id` + `--lane`. The Bun handler derives member from
  // lane via team.members[]. Wire-protocol contract:
  //   - --task-id + --lane is the required-pair (either both or neither).
  //   - --member is OPTIONAL — when provided it overrides lane-derivation;
  //     when omitted, relaydHandleOne picks the first member with matching
  //     lane. Standalone --member (without the pair) is a wire-format
  //     mistake — reject so misconfigured callers fail loudly.
  if ((taskId === undefined) !== (lane === undefined)) {
    const missing = taskId === undefined ? "--task-id" : "--lane";
    throw new UsageError({
      what:
        `relayd --handle-one: --task-id and --lane must be provided together ` +
        `(missing: ${missing})`,
      hint: USAGE,
    });
  }
  if (member !== undefined && (taskId === undefined || lane === undefined)) {
    throw new UsageError({
      what:
        "relayd --handle-one: --member is only valid alongside --task-id + --lane",
      hint: USAGE,
    });
  }
  const out: ParsedRelaydArgs = { subverb };
  if (teamDir !== undefined) out.teamDir = teamDir;
  if (once) out.once = true;
  if (maxEvents !== undefined) out.maxEvents = maxEvents;
  if (eventId !== undefined) out.eventId = eventId;
  if (topic !== undefined) out.topic = topic;
  if (taskId !== undefined) out.taskId = taskId;
  if (member !== undefined) out.member = member;
  if (lane !== undefined) out.lane = lane;
  return out;
}

/**
 * `atmux relayd` top-level dispatch. Delegates to the existing
 * committer verb-layer functions via a re-shaped `ParsedCommitterArgs`
 * — single source of truth for the daemon/drain bodies stays in
 * `committer.ts`. Future amendment can move the bodies here once
 * legacy `committer --daemon` is removed.
 */
export async function relayd(
  argv: ReadonlyArray<string>,
  opts: CommitterOpts = {},
): Promise<number> {
  const parsed = parseRelaydArgs(argv);
  if (parsed.subverb === "handle-one") {
    return await relaydHandleOne(parsed, opts);
  }
  if (parsed.subverb === "status") {
    return await relaydStatus(parsed);
  }
  // Adapt to ParsedCommitterArgs shape. The verb-layer functions
  // accept a superset that includes `--sweep`; we narrow to the
  // matching sub-verb name.
  const committerSubverb = parsed.subverb === "start" ? "daemon" : "drain";
  const committerArgs = {
    subverb: committerSubverb as "daemon" | "drain",
    ...(parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {}),
    ...(parsed.once === true ? { once: true as const } : {}),
    ...(parsed.maxEvents !== undefined ? { maxEvents: parsed.maxEvents } : {}),
  };
  if (parsed.subverb === "start") {
    return await committerDaemonVerb(committerArgs, opts);
  }
  return await committerDrainVerb(committerArgs, opts);
}

/**
 * `atmux relayd --handle-one --event-id X --topic T` — ADR-202 §VII.
 *
 * Single-event dispatch: load the named event from the events table,
 * route to its topic handler, exit 0 on success / non-zero on failure.
 * Spawned per-event by the Rust `atmux-relayd` binary, which owns the
 * long-lived subscription + offset advancement.
 *
 * Bun process lifecycle per invocation: load → dispatch → exit. ~50ms
 * cold start + handler time (1-30s for gitter merge, ~1s for lane-tick).
 *
 * Offset advancement is the Rust side's responsibility — this handler
 * does NOT save offset. The Rust binary advances on observing exit-code
 * 0 from this process.
 */
async function relaydHandleOne(
  parsed: ParsedRelaydArgs,
  opts: CommitterOpts = {},
): Promise<number> {
  const eventId = parsed.eventId;
  const topic = parsed.topic;
  if (eventId === undefined || topic === undefined) {
    // Parser guarantees both; defensive check for ts narrowing.
    throw new UsageError({
      what: "relayd --handle-one: parser invariant violated (missing event-id or topic)",
    });
  }
  if (topic === "task.done") {
    // Need full event-driven context for the gitter merge handler.
    const committerArgs = {
      subverb: "daemon" as const,
      ...(parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {}),
    };
    const ctx = await buildEventDrivenContext(committerArgs, opts);
    try {
      // ADR-202 §VIII caveat-fix: use loadEventById for direct lookup
      // instead of the brittle cursor-trick (decrement-last-char on
      // eventId + drainSince).
      const event = loadEventById(ctx.db, eventId);
      if (event === null || event.topic !== "task.done") {
        ctx.logger.log(`relayd --handle-one: event ${eventId} not found in task.done — skip`);
        ctx.closeDb(ctx.db);
        return 0; // not an error — event may have been pruned, or wrong topic
      }
      const outcome = await ctx.handler(event);
      ctx.logger.log(
        `relayd --handle-one: task.done eventId=${eventId} taskId=${event.taskId} outcome=${outcome}`,
      );
      ctx.closeDb(ctx.db);
      return 0;
    } catch (e) {
      ctx.logger.log(
        `relayd --handle-one: task.done eventId=${eventId} threw: ${e instanceof Error ? e.message : String(e)}`,
      );
      ctx.closeDb(ctx.db);
      return 1;
    }
  }
  if (topic === "task.unclaimed") {
    const dirOpts: ResolveDirOpts =
      parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
    const team = await requireTeam(dirOpts);
    const atmuxDir = await getAtmuxDir(dirOpts);
    // ADR-202 §Amendment 2026-05-22 IX-A: when the Rust dispatcher
    // passes (taskId, lane) from the event payload, use the lean
    // per-event dispatcher — single `safeSendKeysWithVerify` call to
    // ONE member, skipping the cross-member enumeration loop. Member
    // is derived from lane via team.members[] here (T3 revision —
    // TaskUnclaimedPayload has no member field). Absent --task-id /
    // --lane (back-compat with older relayd events + degraded-mode
    // Bun --start path) OR lane has no matching member → fall through
    // to runLaneTick (cross-member enumeration is the correct degraded
    // behavior).
    try {
      const leanOpts = resolveLeanDispatchOpts(parsed, team);
      if (leanOpts !== null) {
        await runLaneTickForOne(atmuxDir, team, leanOpts);
      } else {
        // No need to load the specific event payload — runLaneTick visits
        // ALL members of the team and picks tasks for each lane. The
        // event was just the wake-up signal.
        await runLaneTick(atmuxDir, team);
      }
      // Manually advance offset so this Bun process doesn't depend on
      // the Rust caller checking exit code precisely. The Rust caller
      // ALSO saves the offset on rc=0, which is idempotent. Offset
      // behavior is identical on both lean + fallback paths.
      const dbPath = join(atmuxDir, "state.db");
      const db = openDatabase(dbPath, migrations);
      try {
        saveOffset(db, "atmux:lane-router", eventId);
      } finally {
        closeDatabase(db);
      }
      return 0;
    } catch (e) {
      process.stderr.write(
        `relayd --handle-one: task.unclaimed eventId=${eventId} threw: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      return 1;
    }
  }
  throw new ConfigError({
    what: `relayd --handle-one: unknown topic '${topic}' (expected task.done or task.unclaimed)`,
  });
}

/**
 * Resolve lean per-event dispatch opts for `task.unclaimed`. Returns
 * the {taskId, member, lane} tuple {@link runLaneTickForOne} needs,
 * OR `null` when the caller should fall through to the cross-member
 * `runLaneTick` enumeration.
 *
 * Three null-cases collapse into the same fallback:
 *   1. --task-id or --lane absent — Rust dispatcher couldn't read the
 *      payload (legacy event lacking payload column, payload parse
 *      failure, etc).
 *   2. lane is set but no team.members[] entry carries that lane —
 *      misconfigured roster; cross-member enumeration is the correct
 *      degraded behavior (operator-visible via stderr line).
 *   3. (Explicit --member override): if --member was passed alongside
 *      --task-id + --lane, use it verbatim instead of derivation.
 *      Standalone --member was already rejected by the parser.
 *
 * Source of truth for member.lane: `team.members[]` filtered on
 * `.lane === opts.lane`, first-match wins. For 1-member-per-lane
 * teams (modern epic-team default) the pick is deterministic; for
 * teams with multiple workers per lane the first-listed-member wins
 * — a deliberate simplification, since the lean dispatch path is for
 * latency-sensitive nudging, not for load-balanced routing (lane-tick
 * cron still drains the lane via cross-member enumeration as the
 * always-on backstop).
 */
function resolveLeanDispatchOpts(
  parsed: ParsedRelaydArgs,
  team: Team,
): { taskId: string; member: string; lane: string } | null {
  if (parsed.taskId === undefined || parsed.lane === undefined) {
    return null;
  }
  let member = parsed.member;
  if (member === undefined) {
    const candidate = team.members.find((m) => m.lane === parsed.lane);
    if (candidate === undefined) {
      process.stderr.write(
        `relayd --handle-one: task.unclaimed lane=${parsed.lane} has no member in ` +
          `team.members[] — falling through to runLaneTick\n`,
      );
      return null;
    }
    member = candidate.name;
  }
  return { taskId: parsed.taskId, member, lane: parsed.lane };
}

/**
 * `atmux relayd --status` — single-shot diagnostic (ADR-202 §VIII /btw #9).
 *
 * Surfaces relayd's observable state in one command so operators can
 * grep + understand health without diving into `.atmux/logs/relayd.log`:
 *   - Per-consumer subscriber offset (last processed event)
 *   - Total events table size + recent-window count (last hour)
 *   - Per-topic event count (last 24h)
 *   - Honker substrate load state
 *
 * Output is tab-separated lines, grep-able. Returns exit 0 always —
 * status is read-only diagnostic.
 */
async function relaydStatus(parsed: ParsedRelaydArgs): Promise<number> {
  const dirOpts: ResolveDirOpts =
    parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const atmuxDir = await getAtmuxDir(dirOpts);
  const dbPath = join(atmuxDir, "state.db");
  const db = openDatabase(dbPath, migrations);
  try {
    const now = Math.floor(Date.now() / 1000);
    const hourAgo = now - 3600;
    const dayAgo = now - 86_400;

    process.stdout.write("# atmux relayd --status\n");
    process.stdout.write(`team-dir\t${atmuxDir}\n`);
    process.stdout.write(`db\t${dbPath}\n`);

    // Subscriber offsets
    process.stdout.write("\n## consumer offsets\n");
    const consumers = db
      .prepare(
        "SELECT consumer_name, last_event_id, last_processed_at_sec FROM subscriber_offsets ORDER BY consumer_name",
      )
      .all() as Array<{ consumer_name: string; last_event_id: string; last_processed_at_sec: number }>;
    if (consumers.length === 0) {
      process.stdout.write("(no consumers yet — relayd hasn't processed any events)\n");
    }
    for (const c of consumers) {
      const ageSec = now - c.last_processed_at_sec;
      process.stdout.write(
        `${c.consumer_name}\tlast=${c.last_event_id}\tage=${ageSec}s\n`,
      );
    }

    // Events table size + recent counts
    process.stdout.write("\n## events table\n");
    const total = db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
    const recent1h = db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE emitted_at_sec >= ?")
      .get(hourAgo) as { n: number };
    process.stdout.write(`total\t${total.n}\n`);
    process.stdout.write(`last-1h\t${recent1h.n}\n`);

    // Per-topic counts (last 24h)
    process.stdout.write("\n## per-topic (last 24h)\n");
    const perTopic = db
      .prepare(
        "SELECT topic, COUNT(*) AS n FROM events WHERE emitted_at_sec >= ? GROUP BY topic ORDER BY n DESC",
      )
      .all(dayAgo) as Array<{ topic: string; n: number }>;
    if (perTopic.length === 0) {
      process.stdout.write("(no events in last 24h)\n");
    }
    for (const t of perTopic) {
      process.stdout.write(`${t.topic}\t${t.n}\n`);
    }

    // Honker notifications channel (if substrate loaded)
    process.stdout.write("\n## honker notifications (if substrate loaded)\n");
    try {
      const notifMax = db
        .prepare("SELECT COALESCE(MAX(id), 0) AS n FROM _honker_notifications")
        .get() as { n: number };
      process.stdout.write(`_honker_notifications.max\t${notifMax.n}\n`);
    } catch {
      process.stdout.write("(table not present — honker substrate not loaded)\n");
    }

    // WAL observability — file size + journal mode
    process.stdout.write("\n## wal\n");
    try {
      const jm = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      process.stdout.write(`journal_mode\t${jm.journal_mode}\n`);
    } catch {
      // ignore
    }

    return 0;
  } finally {
    closeDatabase(db);
  }
}
