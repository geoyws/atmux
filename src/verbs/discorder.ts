// ADR-068 cutover (Tier 1, P0) — `atmux discorder` verb.
//
// Bash port target: lib/discorder.sh @ HEAD (frozen ref under
// .archive-bash-atmux-20260507/lib/discorder.sh).
//
// USAGE:
//   atmux discorder progress     # 30-min digest (commits + done Tasks)
//   atmux discorder heartbeat    # hourly state-of-team
//   atmux discorder -h | --help
//
// Both subverbs read-only on kanban / git / decisions; never claim,
// never plan. flock single-instance per subverb defends against
// overlapping invocations (mirrors lib/whip.sh:53-59). Post-ADR-233
// the cron-fired path is operator-on-demand / orchd-routed.
//
// Discord delivery via `whip-progress` / `whip-heartbeat` templates —
// bash discorder literally renders `[whip-progress]` in the header,
// so the template name is preserved for byte-parity with downstream
// dashboards / Discord-archive search.

import { join } from "node:path";
import {
  type DiscordSection,
  type DiscordSendOpts,
  send as discordSend,
} from "../abstractions/discord.ts";
import { ensureDir } from "../abstractions/fs.ts";
import { acquireWithTTL } from "../abstractions/lock.ts";
import { now as nowMs } from "../abstractions/time.ts";
import { createTmux, type TmuxNamespace } from "../abstractions/tmux.ts";
import {
  getAtmuxDir,
  getSessionName,
  type ResolveDirOpts,
  requireTeam,
  resolveTeamSocket,
} from "../core/common.ts";
import {
  aggregateHeartbeat,
  aggregateProgress,
  type HeartbeatSnapshot,
  type ProgressDelta,
  readProgressCursor,
  writeProgressCursor,
} from "../core/discorder.ts";
import { defaultStdoutWrite, type Writer } from "../core/io.ts";
import { createLogger, type Logger } from "../core/tui.ts";
import { ConfigError, LockError, LockTimeoutError, UsageError } from "../errors.ts";
import type { Team } from "../schema/team.ts";
import { isRenameInProgress } from "./team-rename-fs.ts";

// ---------- Args ----------

export type DiscorderSubVerb = "progress" | "heartbeat";

export interface ParsedDiscorderArgs {
  sub: DiscorderSubVerb;
  showHelp: boolean;
}

const VALID_SUBS = new Set<string>(["progress", "heartbeat"]);

const USAGE_TEXT = `\
atmux discorder <subverb>

  progress    — 30-min digest: commits + done Tasks since last cursor tick.
                Updates cursor on successful send.
  heartbeat   — hourly state-of-team: alive members, in-flight Tasks,
                blocker count, lead uptime.

  Both subverbs are read-only on kanban / git / decisions. Cron is
  registered by atmux on teams that declare a discorder member.
`;

export function parseDiscorderArgs(args: ReadonlyArray<string>): ParsedDiscorderArgs {
  if (args.length === 0) {
    return { sub: "progress", showHelp: true }; // shape filler for the type
  }
  const a = args[0] ?? "";
  if (a === "-h" || a === "--help") {
    return { sub: "progress", showHelp: true };
  }
  if (!VALID_SUBS.has(a)) {
    throw new UsageError({
      what: `discorder: unknown subverb '${a}' (try: progress | heartbeat)`,
      hint: "see atmux help",
    });
  }
  return { sub: a as DiscorderSubVerb, showHelp: false };
}

// ---------- Render helpers ----------

const BULLET_CAP_GRAPHEMES = 80;

/** Truncate a bullet at 80 graphemes, replacing the tail with `…`.
 *  Mirrors bash `_atmux_whip_delta_since`'s string-slice + ellipsis. */
function bullet80(s: string): string {
  // Cheap approximation — exact grapheme counting matches discord.ts's
  // strict validator. Conservative byte-truncate then re-trim trailing
  // partial multi-bytes is unnecessary here because the inputs are
  // ASCII-dominated (commit subjects, task ids). Use char-count for
  // simplicity; discord.ts will throw if a value sneaks past.
  if (s.length <= BULLET_CAP_GRAPHEMES) return s;
  return `${s.slice(0, BULLET_CAP_GRAPHEMES - 1)}…`;
}

/** Compose the [whip-progress] body sections from a `ProgressDelta`. */
export function buildProgressDiscordOpts(
  team: string,
  delta: ProgressDelta,
  windowDescription: string,
  whenMs?: number,
): DiscordSendOpts | null {
  const sections: DiscordSection[] = [];
  if (delta.commits.length > 0) {
    const bullets = delta.commits.map((c) =>
      bullet80(`✅ \`${c.sha}\` ${c.subject} — ${c.author}`),
    );
    if (delta.commitsTruncated) bullets.push("✅ +N more commits truncated");
    sections.push({
      label: `📊 Since last tick (${windowDescription})`,
      bullets,
    });
  }
  if (delta.doneTasks.length > 0) {
    const bullets = delta.doneTasks.map((t) =>
      bullet80(`✅ \`${t.id}\` ${t.subject} — ${t.owner}`),
    );
    if (delta.doneTasksTruncated) bullets.push("✅ +N more tasks truncated");
    sections.push({ label: "🎯 Tasks closed", bullets });
  }
  if (delta.advancedStories.length > 0) {
    const bullets = delta.advancedStories.map((s) =>
      bullet80(`📊 \`${s.id}\` [${s.epic}] ${s.title} → ${s.status}`),
    );
    if (delta.advancedStoriesTruncated) bullets.push("📊 +N more stories");
    sections.push({ label: "📊 Stories advanced", bullets });
  }
  if (sections.length === 0) return null;

  const out: DiscordSendOpts = {
    template: "whip-progress",
    team,
    category: "📊",
    sections,
  };
  if (whenMs !== undefined) out.whenMs = whenMs;
  return out;
}

/** Compose the [whip-heartbeat] body from a `HeartbeatSnapshot`. */
export function buildHeartbeatDiscordOpts(
  team: string,
  snap: HeartbeatSnapshot,
  whenMs?: number,
): DiscordSendOpts {
  const bullets: string[] = [];
  // Session-down banner replaces the whole `Team state` body.
  if (!snap.sessionUp) {
    bullets.push("🔴 session DOWN — see whip log");
  } else {
    bullets.push(`🟢 alive: ${snap.aliveCount}/${snap.totalMembers} members`);
    for (const d of snap.drifted) {
      const reason = d.reason.startsWith("tui-not-running")
        ? `🟡 \`${d.name}\` (${d.role}): pane is \`${d.reason.slice("tui-not-running:".length)}\` (TUI not running)`
        : `🔴 \`${d.name}\` (${d.role}): window missing`;
      bullets.push(bullet80(reason));
    }
    if (snap.inFlightTasks > 0) {
      bullets.push(`📊 in-flight: ${snap.inFlightTasks} task(s)`);
    }
    if (snap.blockedTasks > 0) {
      bullets.push(`🛑 blocked: ${snap.blockedTasks} task(s)`);
    }
    if (snap.leadName !== null && snap.leadUptimeSec !== null) {
      const uptime = formatUptime(snap.leadUptimeSec);
      bullets.push(`♻️ lead uptime: ${uptime} (\`${snap.leadName}\`)`);
    }
  }

  const out: DiscordSendOpts = {
    template: "whip-heartbeat",
    team,
    category: "💓",
    sections: [{ label: "🎯 Team state", bullets }],
  };
  if (whenMs !== undefined) out.whenMs = whenMs;
  return out;
}

function formatUptime(elapsedSec: number): string {
  if (elapsedSec < 3600) return `${Math.floor(elapsedSec / 60)}min`;
  const h = Math.floor(elapsedSec / 3600);
  const m = Math.floor((elapsedSec % 3600) / 60);
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

function formatWindow(elapsedSec: number): string {
  if (elapsedSec < 3600) return `${Math.floor(elapsedSec / 60)}min ago`;
  const h = Math.floor(elapsedSec / 3600);
  const m = Math.floor((elapsedSec % 3600) / 60);
  return m === 0 ? `${h}h ago` : `${h}h${m}m ago`;
}

// ---------- Verb body ----------

export interface DiscorderOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  stdout?: Writer;
  /** Test injection — pre-resolved atmuxDir. */
  atmuxDir?: string;
  /** Test injection — pre-resolved tmux namespace. */
  tmux?: TmuxNamespace;
  nowMs?: number;
  /** Test injection — pre-resolved team. */
  team?: Team;
  /** Test injection — disable Discord network call. Used by unit tests. */
  skipDiscord?: boolean;
  /** Test injection — alternate progress aggregator (e.g. when no git
   *  is available). */
  aggregateProgressFn?: typeof aggregateProgress;
}

export async function discorder(
  argv: ReadonlyArray<string>,
  opts: DiscorderOptions = {},
): Promise<number> {
  const stdout = opts.stdout ?? defaultStdoutWrite;
  const logger = opts.logger ?? createLogger();
  const env = opts.env ?? process.env;
  const parsed = parseDiscorderArgs(argv);

  if (parsed.showHelp) {
    stdout(USAGE_TEXT);
    return 0;
  }

  const dirOpts: ResolveDirOpts = {
    env,
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  };
  const atmuxDir = opts.atmuxDir ?? (await getAtmuxDir(dirOpts));

  // ADR-027 §Consequences — rename.lock guard. The digest aggregates
  // commits + done Tasks via team.json + kanban reads; a rename mid-
  // flight mutates team.json :.name + cron markers + session anchor,
  // any of which could fold into the digest's header / footer and
  // surface an indeterminate team-name in Discord. Skip silently;
  // the next tick after release lands a coherent digest.
  if (await isRenameInProgress(atmuxDir)) {
    logger.log(`discorder ${parsed.sub}: skipping — rename.lock present (ADR-027)`);
    return 0;
  }

  // Per-subverb single-instance lock. Bash uses
  // `<atmuxDir>/state/discorder-progress.lock` — same path here.
  const lockBase = join(atmuxDir, "state", `discorder-${parsed.sub}`);
  await ensureDir(join(atmuxDir, "state"));

  let handle = null;
  try {
    handle = await acquireWithTTL(lockBase, {
      timeoutMs: 0,
      auditDir: join(atmuxDir, "logs"),
    });
  } catch (e) {
    if (e instanceof LockTimeoutError || e instanceof LockError) {
      logger.log(`discorder ${parsed.sub}: another instance is running — skipping tick`);
      return 0;
    }
    throw e;
  }

  try {
    if (parsed.sub === "progress") {
      return await runProgress(parsed, atmuxDir, dirOpts, opts, logger);
    }
    return await runHeartbeat(parsed, atmuxDir, dirOpts, opts, logger);
  } finally {
    if (handle !== null) await handle.release();
  }
}

async function runProgress(
  _parsed: ParsedDiscorderArgs,
  atmuxDir: string,
  dirOpts: ResolveDirOpts,
  opts: DiscorderOptions,
  logger: Logger,
): Promise<number> {
  const team = opts.team ?? (await loadTeamSafe(dirOpts, logger));
  if (team === null) return 0;

  const stampMs = opts.nowMs ?? nowMs();
  const stampSec = Math.floor(stampMs / 1000);
  const cursor = await readProgressCursor(atmuxDir);
  const sinceEpoch = cursor !== null && cursor > 0 ? cursor : stampSec - 1800; // first run = now-30min

  const aggregate = opts.aggregateProgressFn ?? aggregateProgress;
  const delta = await aggregate(atmuxDir, opts.cwd ?? process.cwd(), sinceEpoch);

  if (
    delta.commits.length === 0 &&
    delta.doneTasks.length === 0 &&
    delta.advancedStories.length === 0
  ) {
    logger.log("discorder progress: no deltas since cursor — silent (no ping)");
    await writeProgressCursor(atmuxDir, stampSec);
    return 0;
  }

  const window = formatWindow(stampSec - sinceEpoch);
  const send = buildProgressDiscordOpts(team.name, delta, window, stampMs);
  if (send === null) {
    await writeProgressCursor(atmuxDir, stampSec);
    return 0;
  }

  if (opts.skipDiscord !== true) {
    try {
      await discordSend(send);
    } catch (e) {
      logger.warn(`discorder progress: discord send failed: ${errMsg(e)}`);
      // Cursor NOT advanced — next tick re-tries the same window.
      return 0;
    }
  }

  await writeProgressCursor(atmuxDir, stampSec);
  return 0;
}

async function runHeartbeat(
  _parsed: ParsedDiscorderArgs,
  atmuxDir: string,
  dirOpts: ResolveDirOpts,
  opts: DiscorderOptions,
  logger: Logger,
): Promise<number> {
  const team = opts.team ?? (await loadTeamSafe(dirOpts, logger));
  if (team === null) return 0;

  const sessionName = await getSessionName({ ...dirOpts, team });
  const tmux = opts.tmux ?? createTmux({ socketPath: resolveTeamSocket(team) });

  const snap = await aggregateHeartbeat(team, atmuxDir, sessionName, tmux, {
    ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
  });
  const send = buildHeartbeatDiscordOpts(team.name, snap, opts.nowMs);

  if (opts.skipDiscord !== true) {
    try {
      await discordSend(send);
    } catch (e) {
      logger.warn(`discorder heartbeat: discord send failed: ${errMsg(e)}`);
      return 0;
    }
  }

  return 0;
}

async function loadTeamSafe(dirOpts: ResolveDirOpts, logger: Logger): Promise<Team | null> {
  try {
    return await requireTeam(dirOpts);
  } catch (e) {
    if (e instanceof ConfigError) {
      logger.warn(`discorder: ${e.message}`);
      return null;
    }
    throw e;
  }
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
