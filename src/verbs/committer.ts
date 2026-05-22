// ADR-134 T4 (t-64e52aac): committer CLI verb — cron-fired sweep
// entry-point. Renamed from `gitter` per ADR-159 (TR2); legacy verb
// name `atmux gitter` retained as alias for one release cycle at
// the dispatcher layer (src/cli.ts).
//
// Hosts the `atmux committer --sweep` sub-verb that the per-team cron
// backstop fires (per ADR-134 §triggers §cron-backstop-secondary). The
// sweep walks per-member branches, consults the merger_state table,
// and queues merge attempts for branches that have commits-ahead-of-
// base AND aren't already in flight.
//
// Sub-verb shape:
//
//   atmux committer --sweep [--team-dir <path>]
//   atmux committer sweep   [--team-dir <path>]   (same — flag/sub-verb
//                                                forms both accepted
//                                                for cron-line
//                                                ergonomics)
//
// **T6 (in-progress, t-93ad8eff) layering note**: the broader committer
// member impl — `atmux committer` running as the per-team committer pane's
// claim+commit loop — is T6 territory. T4 owns ONLY the `--sweep`
// CLI entry-point. Both forms can coexist behind a single verb file:
// T6's per-pane loop will likely add a bare `atmux committer` (no
// sub-verb) entry that this file's `parseCommitterArgs` rejects today —
// T6 extends the parser when it lands. The dispatch boundary stays
// stable.
//
// **T3 (event-driven, t-27b06cda, parallel) layering note**: the
// dispatcher this verb calls into via `queueMergeAttempt` is the same
// dispatch path T3 ships for the event-driven socket-pubsub cascade.
// Until T3 lands the production dispatcher, this verb's default
// factory uses {@link recordingQueueMergeAttempt} — a stub that
// records the queue intent + logs to stderr so the cron sweep emits
// useful evidence without crashing. T3 swaps the real dispatcher in.
//
// Cron line shape (installed by T7, t-a87a39f1 — not in this commit):
//   */N * * * * <env> atmux committer --sweep >> <atmuxDir>/logs/
//   committer-cron.log 2>&1
//
// where N comes from `team.autoMerge.cronBackstopMin` (default 10 per
// ADR-134 §Config + {@link DEFAULT_AUTO_MERGE_CRON_BACKSTOP_MIN}).
// The cron line itself is T7's responsibility; T4 only contracts the
// argv shape the verb consumes.

import { join } from "node:path";
import {
  emit as emitImport,
  loadOffset as loadOffsetImport,
  saveOffset as saveOffsetImport,
  watchEvents as watchEventsImport,
} from "../abstractions/events.ts";
import { bootHonker as bootHonkerImport, getHonkerState as honkerStateImport } from "../abstractions/honker.ts";
import {
  type NativeListenerHandle,
  resolveDefaultListenerBinary,
  spawnNativeListener,
} from "../abstractions/native-listener.ts";
import { closeDatabase, type Database, openDatabase } from "../abstractions/sqlite.ts";
import { migrations } from "../abstractions/sqlite-migrations.ts";
import { defaultGitSpawn, type GitSpawn } from "../abstractions/worktree.ts";
import {
  type CommitterSweepDeps,
  type CommitterSweepResult,
  committerSweep,
  type QueueMergeFn,
} from "../core/committer-sweep.ts";
import { getAtmuxDir, type ResolveDirOpts, requireTeam } from "../core/common.ts";
import {
  createGitterMergeHandler as createGitterMergeHandlerImport,
  gitterConsume as gitterConsumeImport,
} from "../core/gitter-consumer.ts";
import { productionQueueMergeAttempt } from "../core/intra-team-merge-dispatcher.ts";
import { resolveMergerConfig } from "../core/merger-config.ts";
import { KanbanRepo } from "../core/repositories/kanban-repo.ts";
import { MergerStateRepo } from "../core/repositories/merger-state-repo.ts";
import { createLogger, type Logger } from "../core/tui.ts";
import type { Team as TeamShape } from "../schema/team.ts";
import { UsageError } from "../errors.ts";

const USAGE =
  "atmux committer <--sweep|--daemon|--drain> [--team-dir <path>] [--once] [--max-events N]";

// ---------- Arg parsing ----------

export interface ParsedCommitterArgs {
  /** Sub-verbs:
   *   - `sweep`  : original ADR-134 branch-poll cron sweep (T4).
   *   - `drain`  : ADR-202/203 cron-backstop event drain (one-shot
   *                gitterConsume — drains pending `task.done` events
   *                via the offset table, exits 0).
   *   - `daemon` : ADR-202/203 long-lived NOTIFY/LISTEN consumer
   *                (watchEvents loop; runs until SIGINT/SIGTERM). */
  subverb: "sweep" | "drain" | "daemon";
  /** Override the team-dir for `requireTeam` (test injection +
   *  cross-team invocation from the cockpit shell). */
  teamDir?: string;
  /** For `daemon`: exit after the first batch is processed. Test-mode
   *  knob; useful for cron-driven re-invocation under restrictive envs
   *  that don't want a long-lived process. */
  once?: boolean;
  /** For `daemon`: stop after processing this many events (safety
   *  bound). Default unbounded. */
  maxEvents?: number;
}

/** Pure parser. Throws `UsageError` on bad invocation; the verb-level
 *  wrapper catches and surfaces via the standard CLI dispatcher. */
export function parseCommitterArgs(argv: ReadonlyArray<string>): ParsedCommitterArgs {
  let subverb: "sweep" | "drain" | "daemon" | undefined;
  let teamDir: string | undefined;
  let once = false;
  let maxEvents: number | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--sweep" || a === "sweep") {
      subverb = "sweep";
      i += 1;
      continue;
    }
    if (a === "--drain" || a === "drain") {
      subverb = "drain";
      i += 1;
      continue;
    }
    if (a === "--daemon" || a === "daemon") {
      subverb = "daemon";
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
          what: "committer: --max-events requires a value",
          hint: USAGE,
        });
      }
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new UsageError({
          what: `committer: --max-events must be a positive integer (got ${v})`,
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
          what: "committer: --team-dir requires a value",
          hint: USAGE,
        });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    if (a?.startsWith("-") === true) {
      throw new UsageError({ what: `committer: unknown flag: ${a}`, hint: USAGE });
    }
    throw new UsageError({ what: `committer: unexpected arg: ${a}`, hint: USAGE });
  }
  if (subverb === undefined) {
    throw new UsageError({
      what: "committer: no sub-verb specified",
      hint: USAGE,
    });
  }
  const out: ParsedCommitterArgs = { subverb };
  if (teamDir !== undefined) out.teamDir = teamDir;
  if (once) out.once = true;
  if (maxEvents !== undefined) out.maxEvents = maxEvents;
  return out;
}

// ---------- Recording stub (test seam) ----------

/**
 * Recording-only `QueueMergeFn` factory — logs the queue intent and
 * returns `{queued:true}` without driving the state machine. Retained
 * as an exported test seam: the T4 unit-test matrix + T9's new tests
 * both pin behavior against this no-op dispatcher to isolate sweep-
 * eligibility from dispatcher-driven side effects.
 *
 * **Not the production default any longer.** T9 (t-6987392a) swapped
 * the verb-layer default to {@link productionQueueMergeAttempt} —
 * the cron sweep now actually fires merges via the shared
 * `performMerge` state-machine driver. This stub stays available for
 * tests that want to verify "the sweep picked the right branch"
 * without committing to a merge.
 */
export function recordingQueueMergeAttempt(logger: Logger): QueueMergeFn {
  return async ({ memberBranch, aheadCount }) => {
    logger.log(
      `committer --sweep: would queue merge of '${memberBranch}' (+${aheadCount} commits) — ` +
        "T3 dispatcher pending (t-27b06cda); recording intent only",
    );
    return { queued: true };
  };
}

// ---------- Verb entry ----------

export interface CommitterOpts {
  /** Logger sink override (default: `createLogger()`, stderr). */
  logger?: Logger;
  /** Test injection — override the git spawn-fn. Defaults to
   *  {@link defaultGitSpawn}. */
  git?: GitSpawn;
  /** Test injection — override the queue dispatcher. Defaults to
   *  {@link productionQueueMergeAttempt} per T9 (t-6987392a) — the
   *  production dispatcher walks the per-branch state machine via
   *  the shared `performMerge` driver. Tests inject
   *  {@link recordingQueueMergeAttempt} (no-op) when they want to
   *  isolate sweep eligibility from merge side effects. */
  queueMergeAttempt?: QueueMergeFn;
  /** Test injection — override the DB opener. Defaults to
   *  {@link openDatabase}. */
  openDb?: (path: string) => Database;
  /** Test injection — override the DB closer. */
  closeDb?: (db: Database) => void;
}

/** Top-level dispatch for `atmux committer <subverb>`. */
export async function committer(
  argv: ReadonlyArray<string>,
  opts: CommitterOpts = {},
): Promise<number> {
  const parsed = parseCommitterArgs(argv);
  switch (parsed.subverb) {
    case "sweep":
      return await committerSweepVerb(parsed, opts);
    case "drain":
      return await committerDrainVerb(parsed, opts);
    case "daemon":
      return await committerDaemonVerb(parsed, opts);
  }
}

/** Run one cron-tick sweep against the resolved team's repo. Returns
 *  0 on success (including no-op sweeps when autoMerge is disabled or
 *  there are no candidates); non-zero only on hard errors
 *  (USAGE / config-load failures propagate via thrown errors per the
 *  standard verb contract). */
export async function committerSweepVerb(
  parsed: ParsedCommitterArgs,
  opts: CommitterOpts = {},
): Promise<number> {
  const logger = opts.logger ?? createLogger();
  const git = opts.git ?? defaultGitSpawn;
  const openDb = opts.openDb ?? ((p: string) => openDatabase(p, migrations));
  const closeDb = opts.closeDb ?? closeDatabase;

  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const team = await requireTeam(dirOpts);
  const atmuxDir = await getAtmuxDir(dirOpts);

  // Honor the ADR-134 §Config opt-in. When `autoMerge.enabled !==
  // true`, the cron line shouldn't have been installed (T7 install
  // gates on enabled), but bare invocation outside the cron path
  // still gets here. Fast no-op + log + exit 0 — matches the
  // `whip-resume-check` posture (cheap no-op when not opted in).
  if (team.autoMerge?.enabled !== true) {
    logger.log(`committer --sweep: team '${team.name}' has autoMerge.enabled !== true — no-op`);
    return 0;
  }

  // Resolve baseBranch via the existing merger-config helper (same
  // resolution path as ADR-179 W2/W3 — single source of truth for
  // "what does this team merge into"). Note: `resolveMergerConfig`
  // reads `team.merger.baseBranch` first, falling back to the
  // worktree's current HEAD. ADR-134's `autoMerge` config doesn't
  // duplicate baseBranch — auto-merge always targets the team's
  // existing base. If a team wants a different base for auto-merge
  // than bulk merge-cycle, that's a future schema extension; not in
  // T4 scope.
  //
  // Worktree path — the team root is the parent worktree (i.e. the
  // path containing `.atmux/team.json`). Per ADR-134 §Decision the
  // committer runs against the team's primary worktree, not a per-
  // member sub-worktree; that's the "scoped to one team's git repo"
  // locality argument.
  const teamRoot = atmuxDir.endsWith("/.atmux")
    ? atmuxDir.slice(0, -"/.atmux".length)
    : join(atmuxDir, "..");
  const merger = await resolveMergerConfig(team, teamRoot, { git });
  const baseBranch = merger.baseBranch;

  // Open the team's state.db for merger_state lookups. The repo
  // stays open only for the duration of the sweep — cron firings
  // are one-shot.
  const db = openDb(join(atmuxDir, "state.db"));
  try {
    const repo = new MergerStateRepo(db);
    // T9 (t-6987392a): default to the production dispatcher when
    // the caller hasn't overridden. Resolved AFTER DB open + base
    // resolution so the dispatcher has full context. The recording
    // stub stays available as an explicit `opts.queueMergeAttempt`
    // injection (test seam only).
    // ADR-134 T3+T4 (t-2b7572d7): resolve member worktree from
     // `<base>-<member>` branch via the team's worktreeIsolation
     // convention. Mirrors `src/verbs/status.ts::resolveMemberWorktree`
     // but takes the branch directly; the convention is `<teamRoot>/
     // .atmux/worktrees/<member>` (or `team.worktreeRoot/<member>`).
     // Returns null when worktreeIsolation is disabled — the
     // dispatcher's rebase path treats null as "missing worktree" and
     // transitions to terminal conflict.
    const worktreeRoot = team.worktreeRoot ?? ".atmux/worktrees";
    const resolveMemberWorktreePath = async (memberBranch: string): Promise<string | null> => {
      if (team.worktreeIsolation !== true) return null;
      const prefix = `${baseBranch}-`;
      if (!memberBranch.startsWith(prefix)) return null;
      const member = memberBranch.slice(prefix.length);
      if (member.length === 0) return null;
      return worktreeRoot.startsWith("/")
        ? join(worktreeRoot, member)
        : join(teamRoot, worktreeRoot, member);
    };

    const queueMergeAttempt =
      opts.queueMergeAttempt ??
      productionQueueMergeAttempt({
        teamRoot,
        baseBranch,
        mergerRepo: repo,
        kanbanRepo: new KanbanRepo(db),
        git,
        logger,
        // ADR-160 candidate (t-f8beb03b): post-merge done-flip hook
        // wires through atmuxDir so the dispatcher's helper can open
        // the kanban DB after every successful merge tick.
        atmuxDir,
        resolveMemberWorktreePath,
      });
    const deps: CommitterSweepDeps = {
      teamRoot,
      baseBranch,
      // Roster gate (t-911c9314): non-member branches matching the
      // `<baseBranch>-*` glob (operator safety backups, archived
      // branches, epic-team fan-in branches handled by `epic-merge`)
      // get dropped before the dispatcher sees them. team.json is
      // already loaded above (`requireTeam`), so the projection is
      // free; the sweep core does the filter.
      rosterMembers: team.members.map((m) => m.name),
      mergerStateRepo: repo,
      queueMergeAttempt,
      git,
    };
    const result = await committerSweep(deps);
    logSweepResult(result, logger, team.name, baseBranch);
    return 0;
  } finally {
    closeDb(db);
  }
}

// ---------- ADR-202/203 event-driven verbs ----------

/**
 * `atmux committer --drain` — one-shot cron-backstop drain of pending
 * `task.done` events via the offset table. Same handler as `--daemon`
 * but exits after a single `gitterConsume()` invocation. Replaces the
 * fixed-cadence branch-poll of `--sweep` once consumers trust event-
 * driven coordination (cron line decommission per ADR-202 §D6).
 *
 * Returns 0 always — drain itself never fails the cron line; handler
 * throws are caught inside `withIdempotency` and re-attempted next
 * tick. Hard config errors (no team.json, missing state.db) propagate
 * through the standard verb error contract.
 */
export async function committerDrainVerb(
  parsed: ParsedCommitterArgs,
  opts: CommitterOpts = {},
): Promise<number> {
  const ctx = await buildEventDrivenContext(parsed, opts);
  const result = await gitterConsumeImport({
    db: ctx.db,
    handler: ctx.handler,
    logger: ctx.consumerLogger,
  });
  ctx.logger.log(
    `committer --drain: team='${ctx.team.name}' processed=${result.processed} escalated=${result.escalated}`,
  );
  ctx.closeDb(ctx.db);
  return 0;
}

/**
 * `atmux committer --daemon` — long-lived NOTIFY/LISTEN consumer.
 * Subscribes to `task.done` via `watchEvents()` (~100ms wake latency
 * under Honker, ~1.5s fallback) and routes each event through the
 * production gitter merge handler.
 *
 * Cancellation: handles SIGINT + SIGTERM by aborting the watcher
 * AbortController and exiting 0 once the in-flight event finishes.
 *
 * Test ergonomics: `--once` exits after the first batch; `--max-events
 * N` exits after processing N events. Both also flip the cancel signal
 * after the bound is hit.
 */
export async function committerDaemonVerb(
  parsed: ParsedCommitterArgs,
  opts: CommitterOpts = {},
): Promise<number> {
  const ctx = await buildEventDrivenContext(parsed, opts);
  const ac = new AbortController();
  const onSig = () => ac.abort();
  process.once("SIGINT", onSig);
  process.once("SIGTERM", onSig);
  let nativeListener: NativeListenerHandle | null = null;
  try {
    const honkerLoaded = honkerStateImport(ctx.db)?.loaded ?? false;
    // ADR-202 §Amendment 2026-05-22 (II) — prefer the atmux-listener
    // Rust subprocess for kernel-blocking wake when (a) Honker is
    // loaded and (b) the binary is available on disk. Falls back to
    // the in-process 100ms poll path when either is missing.
    const channel = "honker:stream:task.done";
    const dbPath = `${ctx.atmuxDir}/state.db`;
    let externalSignals: AsyncIterable<string> | undefined;
    let wakeMode = "poll";
    if (honkerLoaded) {
      const binaryPath = resolveDefaultListenerBinary();
      if (binaryPath !== null) {
        try {
          nativeListener = spawnNativeListener({
            binaryPath,
            dbPath,
            channel,
            onDiagnostic: (msg) => ctx.logger.log(`committer --daemon: ${msg}`),
          });
          externalSignals = nativeListener.signals;
          wakeMode = "native-listener";
        } catch (e) {
          ctx.logger.log(
            `committer --daemon: native listener spawn failed (${e instanceof Error ? e.message : String(e)}) — falling back to poll`,
          );
        }
      }
    }
    ctx.logger.log(
      `committer --daemon: team='${ctx.team.name}' honker=${honkerLoaded ? "loaded" : "fallback"} wake=${wakeMode} starting watcher (topics=[task.done])`,
    );
    let processed = 0;
    const consumerName = "atmux:gitter";
    const lastOffset = loadOffsetImport(ctx.db, consumerName);
    const watcher = watchEventsImport(ctx.db, {
      topics: ["task.done"],
      signal: ac.signal,
      initialOffset: lastOffset,
      honkerLoaded,
      ...(externalSignals ? { externalSignals } : {}),
    });
    for await (const event of watcher) {
      if (event.topic !== "task.done") continue;
      try {
        const outcome = await ctx.handler(event);
        saveOffsetImport(ctx.db, consumerName, event.eventId);
        processed += 1;
        ctx.logger.log(
          `committer --daemon: handled task.done eventId=${event.eventId} taskId=${event.taskId} outcome=${outcome}`,
        );
      } catch (e) {
        ctx.logger.log(
          `committer --daemon: handler threw on eventId=${event.eventId} — NOT advancing offset; will retry next NOTIFY: ${e instanceof Error ? e.message : String(e)}`,
        );
        break; // stop drain, will retry on next signal
      }
      if (parsed.once === true) {
        ac.abort();
        break;
      }
      if (parsed.maxEvents !== undefined && processed >= parsed.maxEvents) {
        ac.abort();
        break;
      }
    }
    ctx.logger.log(
      `committer --daemon: stopped (processed=${processed} aborted=${ac.signal.aborted})`,
    );
  } finally {
    process.removeListener("SIGINT", onSig);
    process.removeListener("SIGTERM", onSig);
    if (nativeListener !== null) nativeListener.stop();
    ctx.closeDb(ctx.db);
  }
  return 0;
}

/**
 * Shared bootstrap for `--drain` and `--daemon`. Loads team + opens
 * state.db + boots Honker + builds the production gitter merge handler.
 * Returns the assembled context — caller owns DB close via `closeDb`.
 *
 * Exported for testing: see `tests/unit/verbs/committer-event-driven.test.ts`.
 */
export async function buildEventDrivenContext(
  parsed: ParsedCommitterArgs,
  opts: CommitterOpts = {},
): Promise<{
  team: TeamShape;
  teamRoot: string;
  atmuxDir: string;
  baseBranch: string;
  db: Database;
  closeDb: (db: Database) => void;
  handler: (event: import("../schema/events.ts").TaskDonePayload) => Promise<import("../core/gitter-consumer.ts").HandlerOutcome>;
  logger: Logger;
  consumerLogger: import("../core/gitter-consumer.ts").Logger;
}> {
  const logger = opts.logger ?? createLogger();
  const git = opts.git ?? defaultGitSpawn;
  const openDb = opts.openDb ?? ((p: string) => openDatabase(p, migrations));
  const closeDb = opts.closeDb ?? closeDatabase;
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const team = await requireTeam(dirOpts);
  const atmuxDir = await getAtmuxDir(dirOpts);
  const teamRoot = atmuxDir.endsWith("/.atmux")
    ? atmuxDir.slice(0, -"/.atmux".length)
    : join(atmuxDir, "..");
  const merger = await resolveMergerConfig(team, teamRoot, { git });
  const baseBranch = merger.baseBranch;
  const db = openDb(join(atmuxDir, "state.db"));
  // Boot Honker against this db so getHonkerState() resolves true when
  // the substrate is healthy. Best-effort — bootHonker never throws.
  bootHonkerImport(db);
  const worktreeRoot = team.worktreeRoot ?? ".atmux/worktrees";
  const resolveMemberWorktreePath = async (memberBranch: string): Promise<string | null> => {
    if (team.worktreeIsolation !== true) return null;
    const prefix = `${baseBranch}-`;
    if (!memberBranch.startsWith(prefix)) return null;
    const member = memberBranch.slice(prefix.length);
    if (member.length === 0) return null;
    return worktreeRoot.startsWith("/")
      ? join(worktreeRoot, member)
      : join(teamRoot, worktreeRoot, member);
  };
  const consumerLogger: import("../core/gitter-consumer.ts").Logger = {
    info: (msg) => logger.log(msg),
    warn: (msg) => logger.log(msg),
    error: (msg) => logger.log(msg),
  };
  const handler = createGitterMergeHandlerImport({
    teamRoot,
    baseBranch,
    git,
    mergerRepo: new MergerStateRepo(db),
    kanbanRepo: new KanbanRepo(db),
    logger: consumerLogger,
    resolveMemberWorktreePath,
    emit: emitImport,
    atmuxDir,
    roster: team.members.map((m) => m.name),
  });
  return {
    team,
    teamRoot,
    atmuxDir,
    baseBranch,
    db,
    closeDb,
    handler,
    logger,
    consumerLogger,
  };
}

// ---------- Logging ----------

/** Emit a single human-readable summary line + per-action detail
 *  lines for the cron log. Keep it tight — every sweep tick writes
 *  to the log file, so verbose-by-default would bloat. Each entry's
 *  branch + action are enough to grep for; the `observedState` +
 *  `note` are bonus diagnostic. */
function logSweepResult(
  result: CommitterSweepResult,
  logger: Logger,
  teamName: string,
  baseBranch: string,
): void {
  logger.log(
    `committer --sweep: team='${teamName}' base='${baseBranch}' ` +
      `checked=${result.checked} queued=${result.queued} ` +
      `refused=${result.refused} skipped=${result.skipped}`,
  );
  for (const entry of result.entries) {
    const stateBit = entry.observedState ?? "null";
    const noteBit = entry.note !== undefined ? ` — ${entry.note}` : "";
    logger.log(
      `  • ${entry.memberBranch} (+${entry.aheadCount}) state=${stateBit} ` +
        `action=${entry.action}${noteBit}`,
    );
  }
}
