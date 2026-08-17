// ADR-202 §Amendment 2026-05-22 (V) — `atmux orchd` top-level verb.
//
// Promotes the event-router persona to first-class CLI surface. Splits
// the verb tree to align with the persona separation:
//
//   committer (verb) — merge-related operations:
//     --sweep   (existing, ADR-134)   branch-walking auto-merger
//
//   orchd    (verb) — event-routing operations:
//     --start   (long-lived NOTIFY/LISTEN consumer, multi-topic
//                dispatcher — uses atmux-listener Rust subprocess)
//     --drain   (one-shot cron-backstop drain across all topics)
//     --once    (test ergonomics — exit after first batch)
//     --max-events N (test ergonomics — exit after N events)
//
// The legacy `committer --daemon` / `committer --drain` invocations were
// ADR-224 deprecation aliases for this verb; they were removed per
// ADR-266 §D2 (window expired) — invoking them now fails with an
// actionable error pointing here.
//
// Implementation re-uses the existing `committerDaemonVerb` /
// `committerDrainVerb` bodies — this verb is just a renamed entry
// point. Wiring stays in `verbs/committer.ts` to avoid a churn-only
// move; this file is a thin dispatcher.

import { join } from "node:path";
import { loadEventById, saveOffset } from "../abstractions/events.ts";
import { closeDatabase, openDatabase } from "../abstractions/sqlite.ts";
import { migrations } from "../abstractions/sqlite-migrations.ts";
import { invokeAutoMergeInCage } from "../core/auto-merge-invoke.ts";
import { getAtmuxDir, type ResolveDirOpts, requireTeam } from "../core/common.ts";
import { probeHostPressure } from "../core/host-pressure.ts";
import { loadKanban } from "../core/kanban.ts";
import { bootstrapOrchd } from "../core/orchd-bootstrap.ts";
import { dispatchDissolveEpic as dispatchDissolveEpicImport } from "../core/orchd-dispatch/dissolve-epic.ts";
import { dispatchEpicMerge as dispatchEpicMergeImport } from "../core/orchd-dispatch/epic-merge.ts";
import { dispatchGitPush as dispatchGitPushImport } from "../core/orchd-dispatch/git-push.ts";
import { reapStaleEpicTeams } from "../core/orchd-reap.ts";
import { isCageAliveForTeam, listSpawnedEpicTeamsForTeam } from "../core/orchd-reap-enum.ts";
// ADR-224 §D6 — orchd subscription registry seam (Phase 1 zero-handler).
// Re-exported from this verb module so Phase 2 + sibling EPIC e-a946af69
// callers can register against the same canonical surface they see in
// `atmux orchd` (verb file = entry-point) without an extra import hop.
// The actual registry lives in src/core/orchd-registry.ts; this is the
// public seam from the verb side. Phase 1 ships the wiring; handlers
// stay empty until Phase 2 dispatches.
import {
  findOrchdSubscriptionsByTopic,
  ORCHD_SUBSCRIPTIONS,
  visitOrchdSubscriptions,
} from "../core/orchd-registry.ts";
import { orchdSweep } from "../core/orchd-sweep.ts";
import { pressureMonitorTick, resolveSpawnQueueLimits } from "../core/spawn-queue.ts";
import { ConfigError, UsageError } from "../errors.ts";
import {
  buildEventDrivenContext,
  type CommitterOpts,
  committerDaemonVerb,
  committerDrainVerb,
} from "./committer.ts";
import { runLaneTick, runLaneTickForOne } from "./lane-tick.ts";
import { spawnEpic } from "./team/spawn-epic.ts";

export {
  findOrchdSubscriptionsByTopic,
  ORCHD_SUBSCRIPTIONS,
  type OrchdSubscription,
  registerOrchdSubscription,
  visitOrchdSubscriptions,
} from "../core/orchd-registry.ts";

const USAGE =
  "atmux orchd <--start|--drain|--sweep|--reap-stale|--handle-one|--status> [--team-dir <path>] [--once] [--max-events N] [--dry-run] [--event-id ID --topic T [--task-id ID --member NAME --lane L]]";

export interface ParsedOrchdArgs {
  /** Sub-verbs:
   *   - `start`       : long-lived multi-topic event-router. Pre-VII this
   *                     was the Bun long-lived process. Post-VII the
   *                     Rust `atmux-orchd` binary owns the long-lived
   *                     subscription + dispatch loop. This Bun verb's
   *                     --start path remains as a fallback when the Rust
   *                     binary isn't present (degraded mode).
   *   - `drain`       : one-shot cron-backstop drain across all topics.
   *                     Processes pending events via subscriber_offsets
   *                     table, exits 0.
   *   - `handle-one`  : (ADR-202 §VII) single-event dispatch — load
   *                     event by --event-id + --topic, run handler,
   *                     save offset, exit. Spawned by atmux-orchd Rust
   *                     binary once per arriving event.
   *   - `status`      : (ADR-202 §VIII /btw #9) single-shot diagnostic —
   *                     subscriber offsets, recent event counts per
   *                     topic, last-handler-outcome. Operator runs it
   *                     instead of grepping logs. */
  subverb:
    | "start"
    | "drain"
    | "sweep"
    | "reap-stale"
    | "handle-one"
    | "status"
    | "sweep-merges"
    | "scan-context"
    | "housekeep"
    | "scan-budget";
  teamDir?: string;
  /** `--once`: exit after first batch (test ergonomics). */
  once?: boolean;
  /** `--dry-run`: (reap-stale) classify spawned epic-teams + print the
   *  verdict, take NO destructive action. ADR-250 §D2. */
  dryRun?: boolean;
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
   *  derivation in {@link orchdHandleOne}. Standalone --member
   *  (without --task-id + --lane) is rejected as a wire-format
   *  mistake. */
  member?: string;
  /** `--lane L`: see {@link taskId} — required alongside --task-id. */
  lane?: string;
  /** `--consumer-id ID`: (e-10-eee9ea5a) when the Rust dispatcher
   *  spawns one --handle-one per ORCHD_SUBSCRIPTIONS entry, it passes
   *  the consumer-id so Bun can route directly to that specific
   *  handler (instead of dispatching via topic-only). Required for
   *  the registry-driven dispatch path; absent → legacy hardcoded
   *  topic branches (task.done → gitter merge, task.unclaimed →
   *  lane-tick) for back-compat with un-upgraded Rust binaries. */
  consumerId?: string;
}

export function parseOrchdArgs(argv: ReadonlyArray<string>): ParsedOrchdArgs {
  let subverb:
    | "start"
    | "drain"
    | "sweep"
    | "reap-stale"
    | "handle-one"
    | "status"
    | "sweep-merges"
    | "scan-context"
    | "housekeep"
    | "scan-budget"
    | undefined;
  let teamDir: string | undefined;
  let once = false;
  let dryRun = false;
  let maxEvents: number | undefined;
  let eventId: string | undefined;
  let topic: string | undefined;
  let taskId: string | undefined;
  let member: string | undefined;
  let lane: string | undefined;
  let consumerId: string | undefined;
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
    if (a === "--sweep" || a === "sweep") {
      subverb = "sweep";
      i += 1;
      continue;
    }
    if (a === "--reap-stale" || a === "reap-stale") {
      subverb = "reap-stale";
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
    if (a === "--sweep-merges" || a === "sweep-merges") {
      subverb = "sweep-merges";
      i += 1;
      continue;
    }
    if (a === "--scan-context" || a === "scan-context") {
      subverb = "scan-context";
      i += 1;
      continue;
    }
    if (a === "--housekeep" || a === "housekeep") {
      subverb = "housekeep";
      i += 1;
      continue;
    }
    if (a === "--scan-budget" || a === "scan-budget") {
      subverb = "scan-budget";
      i += 1;
      continue;
    }
    if (a === "--once") {
      once = true;
      i += 1;
      continue;
    }
    if (a === "--dry-run") {
      dryRun = true;
      i += 1;
      continue;
    }
    if (a === "--max-events") {
      const v = argv[i + 1];
      if (v === undefined || v === "") {
        throw new UsageError({
          what: "orchd: --max-events requires a value",
          hint: USAGE,
        });
      }
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new UsageError({
          what: `orchd: --max-events must be a positive integer (got ${v})`,
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
          what: "orchd: --team-dir requires a value",
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
          what: "orchd: --event-id requires a value",
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
          what: "orchd: --topic requires a value",
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
          what: "orchd: --task-id requires a value",
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
          what: "orchd: --member requires a value",
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
          what: "orchd: --lane requires a value",
          hint: USAGE,
        });
      }
      lane = v;
      i += 2;
      continue;
    }
    if (a === "--consumer-id") {
      const v = argv[i + 1];
      if (v === undefined || v === "") {
        throw new UsageError({
          what: "orchd: --consumer-id requires a value",
          hint: USAGE,
        });
      }
      consumerId = v;
      i += 2;
      continue;
    }
    if (a?.startsWith("-") === true) {
      throw new UsageError({ what: `orchd: unknown flag: ${a}`, hint: USAGE });
    }
    throw new UsageError({ what: `orchd: unexpected arg: ${a}`, hint: USAGE });
  }
  if (subverb === undefined) {
    throw new UsageError({
      what: "orchd: no sub-verb specified (--start, --drain, --sweep, --reap-stale, --handle-one, or --status)",
      hint: USAGE,
    });
  }
  if (subverb === "handle-one") {
    if (eventId === undefined) {
      throw new UsageError({
        what: "orchd --handle-one: --event-id required",
        hint: USAGE,
      });
    }
    if (topic === undefined) {
      throw new UsageError({
        what: "orchd --handle-one: --topic required",
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
  //     when omitted, orchdHandleOne picks the first member with matching
  //     lane. Standalone --member (without the pair) is a wire-format
  //     mistake — reject so misconfigured callers fail loudly.
  if ((taskId === undefined) !== (lane === undefined)) {
    const missing = taskId === undefined ? "--task-id" : "--lane";
    throw new UsageError({
      what:
        `orchd --handle-one: --task-id and --lane must be provided together ` +
        `(missing: ${missing})`,
      hint: USAGE,
    });
  }
  if (member !== undefined && (taskId === undefined || lane === undefined)) {
    throw new UsageError({
      what: "orchd --handle-one: --member is only valid alongside --task-id + --lane",
      hint: USAGE,
    });
  }
  const out: ParsedOrchdArgs = { subverb };
  if (teamDir !== undefined) out.teamDir = teamDir;
  if (once) out.once = true;
  if (dryRun) out.dryRun = true;
  if (maxEvents !== undefined) out.maxEvents = maxEvents;
  if (eventId !== undefined) out.eventId = eventId;
  if (topic !== undefined) out.topic = topic;
  if (taskId !== undefined) out.taskId = taskId;
  if (member !== undefined) out.member = member;
  if (lane !== undefined) out.lane = lane;
  if (consumerId !== undefined) out.consumerId = consumerId;
  return out;
}

/**
 * `atmux orchd` top-level dispatch. Delegates to the existing
 * committer verb-layer functions via a re-shaped `ParsedCommitterArgs`
 * — single source of truth for the daemon/drain bodies stays in
 * `committer.ts`. Future amendment can move the bodies here once
 * legacy `committer --daemon` is removed.
 */
export async function orchd(
  argv: ReadonlyArray<string>,
  opts: CommitterOpts = {},
): Promise<number> {
  const parsed = parseOrchdArgs(argv);
  if (parsed.subverb === "handle-one") {
    return await orchdHandleOne(parsed, opts);
  }
  if (parsed.subverb === "status") {
    return await orchdStatus(parsed);
  }
  if (parsed.subverb === "sweep") {
    return await orchdSweepCli(parsed);
  }
  if (parsed.subverb === "reap-stale") {
    return await orchdReapStaleCli(parsed);
  }
  if (parsed.subverb === "sweep-merges") {
    return await orchdSweepMergesCli(parsed);
  }
  if (parsed.subverb === "scan-context") {
    return await orchdScanContextCli(parsed);
  }
  if (parsed.subverb === "housekeep") {
    return await orchdHousekeepCli(parsed);
  }
  if (parsed.subverb === "scan-budget") {
    return await orchdScanBudgetCli(parsed);
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
    // ADR-224 §D6 — walk the subscription registry seam before handing
    // off to the existing daemon body. Phase 1 ships an empty
    // ORCHD_SUBSCRIPTIONS array → visitor fires zero times → no
    // behavior change. Phase 2 + sibling EPIC e-a946af69 populate the
    // array; the visitor callback then handles per-handler offset init
    // + dispatch wiring. Today's gitter / lane-router subscriptions stay
    // owned by committerDaemonVerb (single source of truth, ADR-202 §V).
    visitOrchdSubscriptions(() => {
      // Phase 2 wires this — see [[orchd-registry]] §D6 sketch.
    });

    // ADR-228 §D4 + §D7 (Phase 5b, driver P0 step 4/5 2026-05-23):
    // pressure-monitor drain loop. Wakes every pressureCheckIntervalSec
    // (default 60s per ADR-228 §D6), probes host pressure, and on
    // under-threshold-AND-non-empty-queue invokes pressureMonitorTick
    // for one drain attempt (drain-one-per-tick per §DA4). Runs in
    // parallel with committerDaemonVerb's watcher; both stop on
    // SIGINT/SIGTERM via the shared process-signal handler installed
    // by committerDaemonVerb.
    //
    // Owns its own db handle (per-loop SQLite connection; WAL mode
    // tolerates concurrent connections) so the inner spawn-epic call
    // can open additional db handles without contention on the daemon's
    // primary connection.
    const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
    const monitorAtmuxDir = await getAtmuxDir(dirOpts);
    const monitorDb = openDatabase(join(monitorAtmuxDir, "state.db"), migrations);
    const monitorLimits = resolveSpawnQueueLimits(process.env);
    const onMonitorTick = async (): Promise<void> => {
      try {
        await pressureMonitorTick({
          db: monitorDb,
          probeHostPressure: () => probeHostPressure({ env: process.env }),
          spawnEpic: async (argv) => {
            try {
              const rc = await spawnEpic(argv);
              return { success: rc === 0 };
            } catch (e) {
              return {
                success: false,
                reason: e instanceof Error ? e.message : String(e),
              };
            }
          },
          limits: monitorLimits,
        });
      } catch (e) {
        process.stderr.write(
          `orchd --start: pressure-monitor tick threw — ${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
    };
    const monitorInterval = setInterval(() => {
      void onMonitorTick();
    }, monitorLimits.pressureCheckIntervalSec * 1000);
    // setInterval keeps the event loop alive — unref so committerDaemonVerb's
    // SIGINT-driven exit path isn't blocked by the timer reference.
    monitorInterval.unref();
    try {
      return await committerDaemonVerb(committerArgs, opts);
    } finally {
      clearInterval(monitorInterval);
      closeDatabase(monitorDb);
    }
  }
  return await committerDrainVerb(committerArgs, opts);
}

/**
 * `atmux orchd --handle-one --event-id X --topic T` — ADR-202 §VII.
 *
 * Single-event dispatch: load the named event from the events table,
 * route to its topic handler, exit 0 on success / non-zero on failure.
 * Spawned per-event by the Rust `atmux-orchd` binary, which owns the
 * long-lived subscription + offset advancement.
 *
 * Bun process lifecycle per invocation: load → dispatch → exit. ~50ms
 * cold start + handler time (1-30s for gitter merge, ~1s for lane-tick).
 *
 * Offset advancement is the Rust side's responsibility — this handler
 * does NOT save offset. The Rust binary advances on observing exit-code
 * 0 from this process.
 */
async function orchdHandleOne(parsed: ParsedOrchdArgs, opts: CommitterOpts = {}): Promise<number> {
  const eventId = parsed.eventId;
  const topic = parsed.topic;
  if (eventId === undefined || topic === undefined) {
    // Parser guarantees both; defensive check for ts narrowing.
    throw new UsageError({
      what: "orchd --handle-one: parser invariant violated (missing event-id or topic)",
    });
  }
  // e-10-eee9ea5a — registry-driven dispatch path. When the Rust
  // dispatcher passes --consumer-id, route directly to that handler
  // from ORCHD_SUBSCRIPTIONS instead of the legacy topic-only
  // branches. This unblocks every handler registered by
  // bootstrapOrchd (auto-merge, dissolve-solo-worker, auto-push,
  // auto-dissolve, spawn-on-ready, spawn-on-unblocked, complaint).
  // Legacy callers (Rust without --consumer-id, or operator-direct
  // CLI use) fall through to the hardcoded topic branches below.
  if (parsed.consumerId !== undefined) {
    return await orchdHandleOneByConsumerId(parsed, eventId, topic);
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
        ctx.logger.log(`orchd --handle-one: event ${eventId} not found in task.done — skip`);
        ctx.closeDb(ctx.db);
        return 0; // not an error — event may have been pruned, or wrong topic
      }
      const outcome = await ctx.handler(event);
      ctx.logger.log(
        `orchd --handle-one: task.done eventId=${eventId} taskId=${event.taskId} outcome=${outcome}`,
      );
      ctx.closeDb(ctx.db);
      return 0;
    } catch (e) {
      ctx.logger.log(
        `orchd --handle-one: task.done eventId=${eventId} threw: ${e instanceof Error ? e.message : String(e)}`,
      );
      ctx.closeDb(ctx.db);
      return 1;
    }
  }
  if (topic === "task.unclaimed") {
    const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
    const team = await requireTeam(dirOpts);
    const atmuxDir = await getAtmuxDir(dirOpts);
    // ADR-202 §Amendment 2026-05-22 IX-A (T3 unified contract): when
    // the Rust dispatcher passes (taskId, lane) from the event payload,
    // use the lean per-event dispatcher. Member derivation from lane
    // lives inside runLaneTickForOne (single source of truth). Absent
    // --task-id / --lane (back-compat with older orchd events +
    // degraded-mode Bun --start path) → fall through to runLaneTick
    // (cross-member enumeration is the correct degraded behavior).
    try {
      if (parsed.taskId !== undefined && parsed.lane !== undefined) {
        const leanOpts: { taskId: string; lane: string; member?: string } = {
          taskId: parsed.taskId,
          lane: parsed.lane,
        };
        if (parsed.member !== undefined) leanOpts.member = parsed.member;
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
        `orchd --handle-one: task.unclaimed eventId=${eventId} threw: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      return 1;
    }
  }
  throw new ConfigError({
    what: `orchd --handle-one: unknown topic '${topic}' (expected task.done or task.unclaimed)`,
  });
}

/**
 * e-10-eee9ea5a — registry-driven `--handle-one` dispatch. The Rust
 * dispatcher passes `--consumer-id <id>`; we look up that exact
 * subscription from {@link ORCHD_SUBSCRIPTIONS}, load the event, run
 * the handler. One spawn per consumer per event (Rust manages
 * per-consumer offsets via `subscriber_offsets`).
 *
 * Bootstrap is called on every invocation — it's idempotent
 * (registerOrchdSubscription deduplicates by consumerId) so the
 * registry stays populated across the long-lived Rust loop's repeated
 * Bun spawns. Bootstrap deps are minimal here (db + team + atmuxDir);
 * production injection of dispatchers (mergeDeps, pushDeps, etc.)
 * happens lazily inside each handler's stub-default path, so even the
 * minimal bootstrap path is sufficient to deliver complaint events
 * (which need no extra deps) and to no-op spawn events safely
 * (`skipped-row-missing` per ADR-231 §D2).
 */
async function orchdHandleOneByConsumerId(
  parsed: ParsedOrchdArgs,
  eventId: string,
  topic: string,
): Promise<number> {
  const consumerId = parsed.consumerId;
  if (consumerId === undefined) {
    throw new UsageError({
      what: "orchd --handle-one: orchdHandleOneByConsumerId called without --consumer-id",
    });
  }
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const atmuxDir = await getAtmuxDir(dirOpts);
  const team = await requireTeam(dirOpts);
  const dbPath = join(atmuxDir, "state.db");
  const db = openDatabase(dbPath, migrations);
  try {
    // Same dep wiring as committer.ts::committerDrainVerb plus e-11-446429c9
    // in-cage epic-merge invoker: when this cage IS an epic-team
    // (team.epicTeam set), auto-merge dispatches via the in-cage
    // `atmux epic-merge tick` verb spawn (replaces the retired
    // ADR-091 cron tick). For parent cages without epicTeam set, the
    // central dispatcher falls through to its safety-net
    // skipped-not-mine (cross-cage routing is the deferred ADR-232
    // §D2 OQ-1 work).
    const epicRepoPath = atmuxDir.endsWith("/.atmux")
      ? atmuxDir.slice(0, -"/.atmux".length)
      : atmuxDir;
    bootstrapOrchd({
      db,
      mergeDeps: {
        dispatchEpicMerge: async (epicId) => {
          if (team.epicTeam !== undefined && team.epicTeam.parentEpicKanbanId === epicId) {
            return await invokeAutoMergeInCage(epicRepoPath);
          }
          return await dispatchEpicMergeImport({ epicId }, { localTeamName: team.name });
        },
      },
      dissolveDeps: {
        dispatchDissolveEpic: async (epicId) =>
          dispatchDissolveEpicImport({ epicId }, { localCageName: team.name }),
      },
      pushDeps: {
        dispatchGitPush: async (parentBase) =>
          dispatchGitPushImport(
            { cage: team.name, branch: parentBase },
            { localCageName: team.name },
          ),
      },
      spawnDeps: {
        atmuxDir,
        team,
      },
      // ADR-247 §D2 — lead-stall watchdog. Reads the CURRENT kanban at
      // ping-time (§OQ3) and rate-limits via the cage's state file.
      // bootstrapOrchd skips registration when
      // `team.leadStallWatchdog.enabled === false` (§D6 off-switch).
      leadStallDeps: {
        atmuxDir,
        team: {
          name: team.name,
          members: team.members,
          ...(team.leadStallWatchdog !== undefined
            ? { leadStallWatchdog: team.leadStallWatchdog }
            : {}),
        },
        loadSnapshot: async () => {
          const kanban = await loadKanban(atmuxDir);
          return { stories: kanban.stories ?? [], tasks: kanban.tasks };
        },
      },
    });
    const subs = findOrchdSubscriptionsByTopic(topic).filter((s) => s.consumerId === consumerId);
    if (subs.length === 0) {
      process.stderr.write(
        `orchd --handle-one: no subscription registered for consumerId='${consumerId}' topic='${topic}' (registry has ${ORCHD_SUBSCRIPTIONS.length} subs)\n`,
      );
      return 0; // not an error — registry may not yet include this consumer in older builds
    }
    const event = loadEventById(db, eventId);
    if (event === null) {
      process.stderr.write(
        `orchd --handle-one: event ${eventId} not found (pruned?) — consumerId='${consumerId}' topic='${topic}' — skip\n`,
      );
      return 0;
    }
    if (event.topic !== topic) {
      process.stderr.write(
        `orchd --handle-one: event ${eventId} topic mismatch — expected '${topic}', got '${event.topic}' — skip\n`,
      );
      return 0;
    }
    try {
      const sub = subs[0];
      if (sub === undefined) {
        return 0;
      }
      await sub.handler(event);
      // Advance our local offset record — the Rust caller also advances
      // on rc=0 so this is idempotent.
      saveOffset(db, consumerId, eventId);
      return 0;
    } catch (e) {
      process.stderr.write(
        `orchd --handle-one: consumerId='${consumerId}' topic='${topic}' eventId=${eventId} threw: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      return 1;
    }
  } finally {
    closeDatabase(db);
  }
}

/**
 * `atmux orchd --status` — single-shot diagnostic (ADR-202 §VIII /btw #9).
 *
 * Surfaces orchd's observable state in one command so operators can
 * grep + understand health without diving into `.atmux/logs/orchd.log`:
 *   - Per-consumer subscriber offset (last processed event)
 *   - Total events table size + recent-window count (last hour)
 *   - Per-topic event count (last 24h)
 *   - Honker substrate load state
 *
 * Output is tab-separated lines, grep-able. Returns exit 0 always —
 * status is read-only diagnostic.
 */

/**
 * `atmux orchd --sweep` — one-shot cron-backstop walk (ADR-231 §D4).
 *
 * Resolves the local atmuxDir, runs `orchdSweep(atmuxDir)` once, and
 * prints the counters JSON to stdout for cron-line + Discord
 * summarization (T-S2.3 surfaces the structured summary). Exit code:
 * 0 on clean sweep (any counter values); non-zero only if `orchdSweep`
 * throws (the walker swallows handler errors per its own contract, so
 * the only throws here are unrecoverable setup failures — atmuxDir
 * unresolvable, etc.).
 *
 * `--once` is the canonical form (consistent with `--drain`); reused
 * verbatim — no per-invocation arg processing beyond `--team-dir`.
 */
async function orchdSweepCli(parsed: ParsedOrchdArgs): Promise<number> {
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const atmuxDir = await getAtmuxDir(dirOpts);
  const result = await orchdSweep(atmuxDir);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

/**
 * `atmux orchd --reap-stale [--team-dir <p>] [--dry-run]` — ADR-250 §D2.
 *
 * Walks this team's spawned epic-teams (cockpit `sessions[]` walk +
 * per-epic-socket liveness via `tmuxTmpdir` → `resolveTeamSocket`, ADR-251)
 * and acts per class: dead-cage orphan → reap (`performDissolveEpic`);
 * live-but-idle → escalate (log-only this phase); live+active → skip.
 *
 * `--dry-run` classifies + prints the verdict without acting — the safe
 * first pass an operator runs to SEE the classification before any
 * destructive reap. The dead-cage reap inherits `performDissolveEpic`'s
 * caller-scope gate (refuses unless `ATMUX_CALLER_SCOPE=driver`) + its
 * skip-on-dirty worktree refuse, so this surface never force-prunes.
 *
 * Output mirrors the other orchd sweeps: one human-readable summary line
 * + one line per acted/notable epic. Exit 0 unless setup throws (the
 * walker isolates per-epic action failures into the `errors` counter).
 */
async function orchdReapStaleCli(parsed: ParsedOrchdArgs): Promise<number> {
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const atmuxDir = await getAtmuxDir(dirOpts);
  const dryRun = parsed.dryRun ?? false;
  const result = await reapStaleEpicTeams(atmuxDir, {
    dryRun,
    listSpawnedEpicTeams: (dir) => listSpawnedEpicTeamsForTeam(dir),
    isCageAlive: (team) => isCageAliveForTeam(team),
    // dissolve + escalate use the core production defaults
    // (performDissolveEpic + stderr log) — ADR-250 §D5.
    logger: {
      info: (m) => process.stderr.write(`${m}\n`),
      warn: (m) => process.stderr.write(`${m}\n`),
    },
  });
  const { isoLocalTs } = await import("../core/orchd-log-fmt.ts");
  const ts = isoLocalTs();
  const tag = dryRun ? "🔎 reap-stale (dry-run)" : "♻️ reap-stale";
  const emoji = result.errors > 0 ? "🔴 " : "";
  process.stdout.write(
    `[${ts}] ${emoji}${tag} · considered=${result.considered} reaped=${result.reaped} ` +
      `escalated=${result.escalated} live-active=${result.skippedActive} errors=${result.errors}\n`,
  );
  for (const d of result.details) {
    // Quiet the common live-active rows under a non-dry run; surface
    // everything under --dry-run (the operator is inspecting).
    if (!dryRun && d.outcome === "skipped-live-active") continue;
    process.stdout.write(`[${ts}]   ${d.epicId}\t${d.outcome}\t${d.reason}\n`);
  }
  return 0;
}

/**
 * `atmux orchd --sweep-merges` — e-11-446429c9 §S5.
 *
 * One-shot reconcile pass: walks epics, dispatches merge for
 * unattended ready ones. Fires from the Rust orchd's 5-min in-process
 * ticker (S6) — NOT a crontab entry, dies with the orchd process.
 *
 * Same dispatch closure as orchdHandleOneByConsumerId so event-driven
 * + sweep paths share one code path. Writes JSON result to stdout
 * for the Rust caller's log capture.
 */
/**
 * `atmux orchd --scan-budget` — e-14-0f156732.
 *
 * Consolidates the existing budget pieces: probeBudget (per-account
 * rate-limit probe), runBudgetCheck (orchestrator with band-warning
 * dedup + refresh-soon dedup), discord.ts renderers (no-LLM
 * templates per ADR-237). Fires from orchd's 15min in-process ticker
 * alongside ctx-scan.
 *
 * Default behavior: probe every unique claudeAccount across team
 * members, fire Discord band-warning when crossing thresholds
 * (50% / 75% / 85% / 90% remaining → ping each band ONCE per epoch).
 * Pause/fallback path remains opt-in via team.json::fallback.enabled.
 *
 * Dedup: budget-warning-state.ts already keys on (account, window,
 * band) — operator's per-account dedup ask satisfied by existing
 * mechanism.
 */
async function orchdScanBudgetCli(parsed: ParsedOrchdArgs): Promise<number> {
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const atmuxDir = await getAtmuxDir(dirOpts);
  const team = await requireTeam(dirOpts);
  try {
    const { runBudgetCheck } = await import("../core/whip-budget-check.ts");
    const { isoLocalTs } = await import("../core/orchd-log-fmt.ts");
    const { send: discordSend } = await import("../abstractions/discord.ts");
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const verdict = await runBudgetCheck(
      {
        atmuxDir,
        nowMs,
        nowSec,
        team: {
          name: team.name,
          members: team.members.map((m) => {
            const cb: { name: string; claudeAccount?: string } = { name: m.name };
            if (typeof m.claudeAccount === "string" && m.claudeAccount !== "") {
              cb.claudeAccount = m.claudeAccount;
            }
            return cb;
          }),
          // Fallback path stays opt-in — orchd's scan does NOT auto-spawn
          // fallback cages; that requires team.fallback.enabled per ADR-058.
          ...(team.fallback !== undefined ? { fallback: team.fallback } : {}),
        },
        config: {
          // Defaults match whip-budget-check.ts production defaults.
          budgetPauseThreshold: 90,
          budgetResumeThreshold: 80,
          budgetWarningBands: [0.5, 0.25, 0.15],
          budgetRefreshLeadMins: 30,
        },
      },
      { discordSend },
    );
    const ts = isoLocalTs();
    const emoji = verdict === "active" ? "💰" : verdict.startsWith("paused") ? "🟡" : "💤";
    process.stdout.write(
      `[${ts}] ${emoji} budget-scan · verdict=${verdict} · accounts=${new Set(team.members.map((m) => m.claudeAccount).filter((a) => a !== undefined && a !== null && a !== "")).size}\n`,
    );
    return 0;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[budget-scan] 🔴 errored: ${reason}\n`);
    return 0; // non-fatal — sweep ticker continues
  }
}

/**
 * `atmux orchd --housekeep` — e-12-640853f3 §S4.
 *
 * Daily maintenance pass: prune old events table rows (where every
 * consumer has progressed past them), drop stale subscriber_offsets
 * for retired consumer-ids, unlink rotated log archives older than
 * 30 days, drop merger_state terminal rows older than 30 days.
 *
 * Fires from the Rust orchd's 24h in-process ticker — NOT a crontab
 * entry per operator stance.
 */
async function orchdHousekeepCli(parsed: ParsedOrchdArgs): Promise<number> {
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const atmuxDir = await getAtmuxDir(dirOpts);
  const dbPath = join(atmuxDir, "state.db");
  const db = openDatabase(dbPath, migrations);
  try {
    const { housekeep } = await import("../core/orchd-housekeep.ts");
    const { isoLocalTs } = await import("../core/orchd-log-fmt.ts");
    const {
      ORCHD_MERGE_CONSUMER_ID,
      ORCHD_DISSOLVE_CONSUMER_ID,
      ORCHD_PUSH_CONSUMER_ID,
      ORCHD_DISSOLVE_SOLO_WORKER_CONSUMER_ID,
      ORCHD_SPAWN_ON_READY_CONSUMER_ID,
      ORCHD_SPAWN_ON_UNBLOCKED_CONSUMER_ID,
      ORCHD_COMPLAINT_CONSUMER_ID,
      ORCHD_ROTATION_CONSUMER_ID,
    } = await import("../core/orchd-bootstrap.ts");
    const activeConsumerIds = [
      "atmux:gitter",
      "atmux:lane-router",
      ORCHD_MERGE_CONSUMER_ID,
      ORCHD_DISSOLVE_CONSUMER_ID,
      ORCHD_PUSH_CONSUMER_ID,
      ORCHD_DISSOLVE_SOLO_WORKER_CONSUMER_ID,
      ORCHD_SPAWN_ON_READY_CONSUMER_ID,
      ORCHD_SPAWN_ON_UNBLOCKED_CONSUMER_ID,
      ORCHD_COMPLAINT_CONSUMER_ID,
      ORCHD_ROTATION_CONSUMER_ID,
    ];
    const result = await housekeep({
      db,
      atmuxDir,
      activeConsumerIds,
      log: (msg) => process.stderr.write(`${msg}\n`),
    });
    const ts = isoLocalTs();
    const errCount = result.errors.length;
    const emoji = errCount > 0 ? "🔴" : "🧹";
    process.stdout.write(
      `[${ts}] ${emoji} housekeep · events=${result.eventsPruned} offsets=${result.offsetsPruned} ` +
        `rotated-logs=${result.rotatedLogsPruned} merger-terminal=${result.mergerTerminalPruned} ` +
        `errors=${errCount}\n`,
    );
    for (const err of result.errors) {
      process.stderr.write(`[${ts}] 🔴 housekeep · ${err}\n`);
    }
    return 0;
  } finally {
    closeDatabase(db);
  }
}

/**
 * `atmux orchd --scan-context` — e-13-04c8b3bf §S4.
 *
 * Walks each member's pane, captures statusline, parses context-%,
 * emits `member.context-high` event for members at/above threshold
 * (default 40%, operator-overrideable via team.json::contextThreshold).
 * Lead consumer (ADR-212 / e-cc3728bf) wakes + decides handoff /
 * rotate / leave-alone.
 *
 * Fires from the Rust orchd's 15-min in-process ticker — NOT a
 * crontab entry per operator stance.
 */
async function orchdScanContextCli(parsed: ParsedOrchdArgs): Promise<number> {
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const atmuxDir = await getAtmuxDir(dirOpts);
  const team = await requireTeam(dirOpts);
  const dbPath = join(atmuxDir, "state.db");
  const db = openDatabase(dbPath, migrations);
  try {
    const { scanContextAcrossMembers } = await import("../core/orchd-context-scan.ts");
    const { buildWindowName, getSessionName, resolveTeamSocket } = await import(
      "../core/common.ts"
    );
    const { createTmux } = await import("../abstractions/tmux.ts");

    const sessionName = await getSessionName({ ...dirOpts, team });
    const socketPath = resolveTeamSocket(team);
    const tmux = createTmux({ socketPath });

    const threshold = Number.isFinite(Number(process.env.ATMUX_CONTEXT_THRESHOLD))
      ? Number(process.env.ATMUX_CONTEXT_THRESHOLD)
      : undefined;

    const scanDeps: Parameters<typeof scanContextAcrossMembers>[0] = {
      db,
      team,
      tmux,
      sessionName,
      resolveWindowTarget: (member) => {
        const windowName = buildWindowName(member.name, member.emoji, member.label, member.role);
        return `${sessionName}:${windowName}`;
      },
      log: (msg) => process.stderr.write(`${msg}\n`),
    };
    if (threshold !== undefined) scanDeps.threshold = threshold;
    const result = await scanContextAcrossMembers(scanDeps);

    // Human-readable summary line (mirrors sweep-merges shape).
    const { isoLocalTs } = await import("../core/orchd-log-fmt.ts");
    const ts = isoLocalTs();
    const emoji = result.membersEmitted > 0 ? "📊" : "💤";
    const verdict =
      result.membersEmitted > 0
        ? `${result.membersEmitted} over threshold → member.context-high emitted`
        : result.membersOverThreshold > 0
          ? `${result.membersOverThreshold} over threshold (deduped)`
          : "all under threshold";
    process.stdout.write(
      `[${ts}] ${emoji} ctx-scan · ${result.membersConsidered} members · ${verdict} · ` +
        `ok=${result.perMember.filter((m) => m.outcome === "ok").length} ` +
        `unknown=${result.membersUnknown} errored=${result.membersErrored}\n`,
    );
    // Per-member emit lines (only when emitted, for operator scan).
    for (const pm of result.perMember) {
      if (pm.outcome === "over-threshold" && pm.emitted === true) {
        process.stdout.write(
          `[${ts}] 📊 ctx-scan:${pm.member} ${pm.percent}% (≥${threshold ?? 40}%) emitted\n`,
        );
      }
    }
    return 0;
  } finally {
    closeDatabase(db);
  }
}

async function orchdSweepMergesCli(parsed: ParsedOrchdArgs): Promise<number> {
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const atmuxDir = await getAtmuxDir(dirOpts);
  const team = await requireTeam(dirOpts);
  const dbPath = join(atmuxDir, "state.db");
  const db = openDatabase(dbPath, migrations);
  try {
    const { sweepMerges } = await import("../core/orchd-merge-sweep.ts");
    const { formatSweepReport } = await import("../core/orchd-log-fmt.ts");
    const epicRepoPath = atmuxDir.endsWith("/.atmux")
      ? atmuxDir.slice(0, -"/.atmux".length)
      : atmuxDir;
    const result = await sweepMerges({
      db,
      loadKanban: () => loadKanban(atmuxDir),
      dispatchEpicMerge: async (epicId) => {
        if (team.epicTeam !== undefined && team.epicTeam.parentEpicKanbanId === epicId) {
          return await invokeAutoMergeInCage(epicRepoPath);
        }
        return await dispatchEpicMergeImport({ epicId }, { localTeamName: team.name });
      },
      log: (msg) => process.stderr.write(`${msg}\n`),
    });
    // e-12-640853f3 §S2 — default render is human-readable summary
    // (one header line + only-interesting per-epic verdicts). JSON form
    // available via env override for machine consumers.
    if (process.env.ATMUX_ORCHD_SWEEP_JSON === "1") {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      process.stdout.write(`${formatSweepReport(result)}\n`);
    }
    return 0;
  } finally {
    closeDatabase(db);
  }
}

async function orchdStatus(parsed: ParsedOrchdArgs): Promise<number> {
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const atmuxDir = await getAtmuxDir(dirOpts);
  const dbPath = join(atmuxDir, "state.db");
  const db = openDatabase(dbPath, migrations);
  try {
    const now = Math.floor(Date.now() / 1000);
    const hourAgo = now - 3600;
    const dayAgo = now - 86_400;

    process.stdout.write("# atmux orchd --status\n");
    process.stdout.write(`team-dir\t${atmuxDir}\n`);
    process.stdout.write(`db\t${dbPath}\n`);

    // Subscriber offsets
    process.stdout.write("\n## consumer offsets\n");
    const consumers = db
      .prepare(
        "SELECT consumer_name, last_event_id, last_processed_at_sec FROM subscriber_offsets ORDER BY consumer_name",
      )
      .all() as Array<{
      consumer_name: string;
      last_event_id: string;
      last_processed_at_sec: number;
    }>;
    if (consumers.length === 0) {
      process.stdout.write("(no consumers yet — orchd hasn't processed any events)\n");
    }
    for (const c of consumers) {
      const ageSec = now - c.last_processed_at_sec;
      process.stdout.write(`${c.consumer_name}\tlast=${c.last_event_id}\tage=${ageSec}s\n`);
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
