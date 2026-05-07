// ADR-057 §D6b R57-T6: `atmux watchdog` verb — heartbeat-staleness
// detector. Intended for cron at `*/2 * * * * cd <project> && atmux
// watchdog`.
//
// On each tick:
//   1. Read `<atmuxDir>/heartbeats/<member>.epoch` for every member.
//   2. Members whose heartbeat is older than `heartbeatStaleSec`
//      (default 300s, configurable via team.json::stallPrevention.
//      heartbeatStaleSec) → flagged stale.
//   3. Stale members not yet pinged in the last 24h → fire 🛑
//      [whip-watchdog] Discord ping + record in dedup state.
//   4. Audit log line per stale member to <atmuxDir>/logs/watchdog.log.
//
// Dedup state file: `<atmuxDir>/state/watchdog-state.json` — flat
// `{<member>: <epoch-seconds-of-last-fire>}` map. 24h re-fire window
// keeps the lead from getting hourly dupes when a member is wedged.

import { join } from "node:path";
import {
  type DiscordSendOpts,
  renderWhipWatchdog,
  send as defaultDiscordSend,
} from "../abstractions/discord.ts";
import { appendText, ensureDir } from "../abstractions/fs.ts";
import { tryReadJson, writeJson } from "../abstractions/json.ts";
import { z } from "zod";
import { getAtmuxDir, type ResolveDirOpts, requireTeam, stateDir } from "../core/common.ts";
import {
  DEFAULT_HEARTBEAT_STALE_SEC,
  type HeartbeatAge,
  readHeartbeatAges,
} from "../core/heartbeat.ts";
import { defaultStderrWrite, defaultStdoutWrite, type Writer } from "../core/io.ts";
import { UsageError } from "../errors.ts";

const USAGE = "atmux watchdog [--no-discord] [--team-dir <dir>]";

/** ADR-057 §D6 default — 24h between repeat pings on the same stalled
 *  member. Quiet enough for hourly cron, loud enough that a still-stalled
 *  member doesn't get forgotten. */
export const WATCHDOG_REFIRE_WINDOW_SEC = 24 * 60 * 60;

export const WATCHDOG_STATE_FILENAME = "watchdog-state.json";

/** State map: `<member>` → epoch-seconds-of-last-fire. */
export const WatchdogStateSchema = z.record(z.string(), z.number().int().nonnegative());
export type WatchdogState = z.infer<typeof WatchdogStateSchema>;

export function watchdogStatePath(atmuxDir: string): string {
  return join(stateDir(atmuxDir), WATCHDOG_STATE_FILENAME);
}

export function watchdogLogPath(atmuxDir: string): string {
  return join(atmuxDir, "logs", "watchdog.log");
}

// ---------- Args ----------

export interface WatchdogArgs {
  pushDiscord: boolean;
  teamDir?: string;
}

export function parseWatchdogArgs(argv: ReadonlyArray<string>): WatchdogArgs {
  let pushDiscord = true;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--no-discord") {
      pushDiscord = false;
      i += 1;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "watchdog: --team-dir requires a value", hint: USAGE });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    throw new UsageError({ what: `watchdog: unknown arg: ${a ?? ""}`, hint: USAGE });
  }
  const out: WatchdogArgs = { pushDiscord };
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

// ---------- Public verb ----------

export interface WatchdogOpts {
  stdout?: Writer;
  stderr?: Writer;
  /** Clock override (test injection); defaults to Date.now. */
  now?: () => number;
  /** Discord send override (test injection). */
  discordSend?: typeof defaultDiscordSend;
  /** Override the heartbeat staleness threshold (test + per-team
   *  config injection). Default DEFAULT_HEARTBEAT_STALE_SEC. */
  staleSec?: number;
}

/** `atmux watchdog [--no-discord] [--team-dir <dir>]`. Cron-friendly. */
export async function watchdog(
  argv: ReadonlyArray<string>,
  opts: WatchdogOpts = {},
): Promise<number> {
  const parsed = parseWatchdogArgs(argv);
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const team = await requireTeam(dirOpts);
  const atmuxDir = await getAtmuxDir(dirOpts);

  const stdout = opts.stdout ?? defaultStdoutWrite;
  const stderr = opts.stderr ?? defaultStderrWrite;
  const clock = opts.now ?? Date.now;
  const send = opts.discordSend ?? defaultDiscordSend;
  const staleSec = opts.staleSec ?? readStaleSecFromTeam(team) ?? DEFAULT_HEARTBEAT_STALE_SEC;

  const nowMs = clock();
  const nowSec = Math.floor(nowMs / 1000);

  // 1. Read all heartbeat ages.
  const memberNames = team.members.map((m) => m.name);
  const ages = await readHeartbeatAges(atmuxDir, memberNames, nowSec);

  // 2. Filter stale (age > threshold OR null).
  const stale = ages.filter((a) => a.ageSec === null || a.ageSec > staleSec);
  if (stale.length === 0) {
    stdout("watchdog: all heartbeats fresh\n");
    return 0;
  }

  // 3. Audit log every stale finding (regardless of dedup gate).
  await writeAuditLines(atmuxDir, nowSec, stale);

  // 4. Dedup gate: only ping for members not yet pinged in the last 24h.
  const state = (await tryReadJson(watchdogStatePath(atmuxDir), WatchdogStateSchema)) ?? {};
  const toFire = stale.filter((a) => {
    const last = state[a.member];
    if (last === undefined) return true;
    return nowSec - last >= WATCHDOG_REFIRE_WINDOW_SEC;
  });

  if (toFire.length === 0) {
    stderr(
      `watchdog: ${stale.length} stale member(s); all in dedup window — no ping fired\n`,
    );
    return 0;
  }

  // 5. Fire Discord (best-effort) + record.
  if (parsed.pushDiscord) {
    try {
      await send(
        renderWhipWatchdog({
          team: team.name,
          stale: toFire.map((a) => ({ member: a.member, ageSec: a.ageSec })),
          staleSec,
          whenMs: nowMs,
        }),
      );
    } catch (e) {
      stderr(`watchdog: Discord send failed (continuing): ${stringifyErr(e)}\n`);
    }
  }

  const nextState: WatchdogState = { ...state };
  for (const a of toFire) nextState[a.member] = nowSec;
  await writeJson(watchdogStatePath(atmuxDir), WatchdogStateSchema, nextState);

  stdout(`watchdog: ${toFire.length} stale member(s) flagged this tick\n`);
  return 0;
}

// ---------- Internals ----------

function readStaleSecFromTeam(team: { whip?: unknown }): number | null {
  // Read team.whip.heartbeatStaleSec if present (typed extension TBD in
  // a future TeamWhip schema bump; today we read defensively).
  const whip = team.whip as { stallPrevention?: { heartbeatStaleSec?: unknown } } | undefined;
  const v = whip?.stallPrevention?.heartbeatStaleSec;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  return null;
}

async function writeAuditLines(
  atmuxDir: string,
  nowSec: number,
  stale: ReadonlyArray<HeartbeatAge>,
): Promise<void> {
  const path = watchdogLogPath(atmuxDir);
  await ensureDir(join(atmuxDir, "logs"));
  const lines = stale
    .map((a) => `${nowSec} member=${a.member} age_sec=${a.ageSec ?? "null"} reason=stale-heartbeat`)
    .join("\n");
  await appendText(path, `${lines}\n`);
}

function stringifyErr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
