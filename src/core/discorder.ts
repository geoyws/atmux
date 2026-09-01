// ADR-068 cutover (Tier 1, P0) — `atmux discorder` core helpers.
//
// Bash port target: lib/discorder.sh @ HEAD (frozen ref under
// .archive-bash-atmux-20260507/lib/discorder.sh).
//
// Two subverbs (per ADR-022, opt-in via a `role: discorder`
// member declaration). Pre-ADR-233 these fired from cron; post-ADR-233
// the verbs are operator/orchd-invoked (cron auto-install retired):
//
//   progress   — 30-min digest of git commits + done Tasks since the
//                last successful tick. Cursor at
//                `<atmuxDir>/state/discorder-progress-cursor.json`.
//   heartbeat  — hourly state-of-team (alive members, in-flight count,
//                blocker count, lead uptime).
//
// Both buckets are READ-ONLY on kanban / git / decisions; never claim,
// never plan. A degraded fallback is acceptable — bash `_atmux_whip_
// delta_since` is rich (decisions block, open p0 flags pointer); this
// port covers commits + done Tasks + advanced stories. The decisions/
// flags blocks are deferred until those verbs themselves land in TS
// (parity-state-impl lane per Tier 2 of driver-inbox 13:35 MYT P0).
//
// Discord delivery: shared `abstractions/discord.send` with the existing
// `whip-progress` / `whip-heartbeat` templates — bash literally emits
// `[whip-progress]` from discorder, so the TS port keeps that header.

import { join } from "node:path";
import { z } from "zod";
import { atomicWrite, readTextOrNull } from "../abstractions/fs.ts";
import { tryReadJson } from "../abstractions/json.ts";
import { spawn } from "../abstractions/spawn.ts";
import { now as nowMs } from "../abstractions/time.ts";
import type { TmuxNamespace } from "../abstractions/tmux.ts";
import type { TeamMember as Member, Team } from "../schema/team.ts";
import { inboxPathFor, stateDir, teamJsonPath } from "./common.ts";
import { loadKanban } from "./kanban.ts";
import { kanbanWorkStateAvailable } from "./kanban-backend.ts";

// ---------- Cursor ----------

const CursorState = z.object({ epoch: z.number().int().nonnegative() });
export type DiscorderCursor = z.infer<typeof CursorState>;

export function progressCursorPath(atmuxDir: string): string {
  return join(stateDir(atmuxDir), "discorder-progress-cursor.json");
}

/** Read `.epoch` from the progress cursor file. Returns null on
 *  missing / malformed (parity with bash). */
export async function readProgressCursor(atmuxDir: string): Promise<number | null> {
  const path = progressCursorPath(atmuxDir);
  let parsed: DiscorderCursor | null = null;
  try {
    parsed = await tryReadJson(path, CursorState);
  } catch {
    return null;
  }
  if (parsed === null) return null;
  return parsed.epoch;
}

/** Atomically write `{epoch: <epochSec>}` to the cursor file. */
export async function writeProgressCursor(atmuxDir: string, epochSec: number): Promise<void> {
  const path = progressCursorPath(atmuxDir);
  await atomicWrite(path, `${JSON.stringify({ epoch: epochSec })}\n`);
}

// ---------- Progress aggregator ----------

export interface ProgressDelta {
  /** Window start (epoch sec). Always set — caller sees what was used. */
  sinceEpoch: number;
  /** Commits in window, oldest-first. Capped via `commitCap`. */
  commits: { sha: string; subject: string; author: string }[];
  /** True when more commits exist past the cap. */
  commitsTruncated: boolean;
  /** Tasks transitioned to `done` (`completedAt > sinceEpoch`), oldest-first. */
  doneTasks: { id: string; subject: string; owner: string }[];
  /** True when more done-tasks exist past the cap. */
  doneTasksTruncated: boolean;
  /** Stories with `advancedAt > sinceEpoch`, oldest-first. */
  advancedStories: { id: string; epic: string; title: string; status: string }[];
  advancedStoriesTruncated: boolean;
}

export interface ProgressAggregateOpts {
  /** Override clock for tests. */
  nowMs?: number;
  /** Per-bucket cap for the rendered view. Default 5; matches bash. */
  cap?: number;
  /** Override the spawn handle (test injection). */
  spawnGit?: (since: number) => Promise<string>;
}

/**
 * Aggregate the progress delta since `sinceEpoch`. Read-only.
 * `gitDir` is the cwd from which `git log --since=@<epoch>` runs;
 * defaults to `process.cwd()` (matching bash, which fires the cron
 * with `cd $project_root` upstream).
 */
export async function aggregateProgress(
  atmuxDir: string,
  gitDir: string,
  sinceEpoch: number,
  opts: ProgressAggregateOpts = {},
): Promise<ProgressDelta> {
  const cap = opts.cap ?? 5;
  const out: ProgressDelta = {
    sinceEpoch,
    commits: [],
    commitsTruncated: false,
    doneTasks: [],
    doneTasksTruncated: false,
    advancedStories: [],
    advancedStoriesTruncated: false,
  };

  // ---- commits ----
  const rawGit = opts.spawnGit
    ? await opts.spawnGit(sinceEpoch).catch(() => "")
    : await runGitLogSince(gitDir, sinceEpoch);
  if (rawGit.length > 0) {
    const lines = rawGit.split("\n").filter((l) => l.length > 0);
    for (const line of lines) {
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      out.commits.push({
        sha: parts[0] ?? "",
        subject: parts[1] ?? "",
        author: parts[2] ?? "",
      });
    }
  }
  if (out.commits.length > cap) {
    out.commitsTruncated = true;
    out.commits = out.commits.slice(0, cap);
  }

  // ---- kanban-driven done tasks + advanced stories ----
  try {
    if (!(await kanbanWorkStateAvailable(atmuxDir))) return out;
    const parsed = await loadKanban(atmuxDir);
    const doneAll = parsed.tasks
      .filter((t) => typeof t.completedAt === "number" && t.completedAt > sinceEpoch)
      .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
    if (doneAll.length > cap) out.doneTasksTruncated = true;
    for (const t of doneAll.slice(0, cap)) {
      out.doneTasks.push({
        id: t.id,
        subject: t.subject ?? "",
        owner: t.owner ?? "-",
      });
    }
    // Stories — schema doesn't expose `advancedAt` directly (passthrough);
    // grab via Bun.file fallback path. Bash uses jq-passthrough; TS port
    // accesses through the validated tasks/stories arrays where possible.
    const stories = parsed.stories as ReadonlyArray<Record<string, unknown>>;
    const advAll = stories
      .filter((s) => {
        const a = s.advancedAt;
        return typeof a === "number" && a > sinceEpoch;
      })
      .sort((a, b) => ((a.advancedAt as number) ?? 0) - ((b.advancedAt as number) ?? 0));
    if (advAll.length > cap) out.advancedStoriesTruncated = true;
    for (const s of advAll.slice(0, cap)) {
      out.advancedStories.push({
        id: String(s.id ?? ""),
        epic: String(s.epic ?? ""),
        title: String(s.title ?? ""),
        status: String(s.status ?? "?"),
      });
    }
  } catch {
    // Missing or unreadable work state is a degraded empty projection.
  }

  return out;
}

async function runGitLogSince(cwd: string, sinceEpoch: number): Promise<string> {
  // Ignore errors: if not in a repo, return empty.
  try {
    const probe = await spawn({
      cmd: "git",
      argv: ["rev-parse", "--git-dir"],
      cwd,
      expectExitCode: "any",
    });
    if (probe.exitCode !== 0) return "";
    const log = await spawn({
      cmd: "git",
      argv: ["log", `--since=@${sinceEpoch}`, "--pretty=tformat:%h%x09%s%x09%an"],
      cwd,
      expectExitCode: "any",
    });
    if (log.exitCode !== 0) return "";
    return log.stdout;
  } catch {
    return "";
  }
}

// ---------- Heartbeat aggregator ----------

export interface HeartbeatDriftedMember {
  name: string;
  role: string;
  /** Reason — `window-missing` | `tui-not-running:<paneCmd>` */
  reason: string;
}

export interface HeartbeatSnapshot {
  sessionUp: boolean;
  totalMembers: number;
  aliveCount: number;
  drifted: HeartbeatDriftedMember[];
  inFlightTasks: number;
  blockedTasks: number;
  /** Lead name (for the uptime line) — null when no team-lead role declared. */
  leadName: string | null;
  /** Lead uptime in seconds — null when no anchor file exists. */
  leadUptimeSec: number | null;
}

export interface HeartbeatAggregateOpts {
  nowMs?: number;
}

/**
 * Aggregate team state for the hourly heartbeat. Pure assembly over
 * the tmux + kanban + state-file probes.
 */
export async function aggregateHeartbeat(
  team: Team,
  atmuxDir: string,
  sessionName: string,
  tmux: TmuxNamespace,
  opts: HeartbeatAggregateOpts = {},
): Promise<HeartbeatSnapshot> {
  const sessionUp = await tmux.session.hasSession(`=${sessionName}`).catch(() => false);

  let aliveCount = 0;
  const drifted: HeartbeatDriftedMember[] = [];
  if (sessionUp) {
    for (const m of team.members) {
      const winName = buildWinName(m);
      const target = `${sessionName}:${winName}`;
      // Probe pane current command via `tmux display-message`. Missing
      // window → throw; treat as drift.
      let paneCmd: string | null = null;
      try {
        const out = await tmux.pane.displayMessage({
          target,
          format: "#{pane_current_command}",
          print: true,
        });
        paneCmd = out.replace(/\n+$/, "").trim();
      } catch {
        drifted.push({
          name: m.name,
          role: m.role ?? "member",
          reason: "window-missing",
        });
        continue;
      }
      const want = wantedTuiCmd(m);
      if (want !== null && paneCmd !== want) {
        drifted.push({
          name: m.name,
          role: m.role ?? "member",
          reason: `tui-not-running:${paneCmd ?? "?"}`,
        });
        continue;
      }
      aliveCount += 1;
    }
  }

  // Kanban counts
  let inFlightTasks = 0;
  let blockedTasks = 0;
  try {
    if (!(await kanbanWorkStateAvailable(atmuxDir))) throw new Error("work state absent");
    const k = await loadKanban(atmuxDir);
    for (const t of k.tasks) {
      if (t.status === "in-progress") inFlightTasks += 1;
      else if (t.status === "blocked") blockedTasks += 1;
    }
  } catch {
    // unreadable work state → counts stay 0
  }

  // Lead uptime — anchored at max(<lead>-rotated.epoch, session-start.txt)
  let leadName: string | null = null;
  let leadUptimeSec: number | null = null;
  for (const m of team.members) {
    if (m.role === "team-lead") {
      leadName = m.name;
      break;
    }
  }
  if (leadName !== null) {
    const sd = stateDir(atmuxDir);
    const rotEpoch = await readEpochFile(join(sd, `${leadName}-rotated.epoch`));
    const sessEpoch = await readEpochFile(join(sd, "session-start.txt"));
    const anchor = Math.max(rotEpoch, sessEpoch);
    if (anchor > 0) {
      const nowSec = Math.floor((opts.nowMs ?? nowMs()) / 1000);
      const elapsed = nowSec - anchor;
      if (elapsed > 0) leadUptimeSec = elapsed;
    }
  }

  return {
    sessionUp,
    totalMembers: team.members.length,
    aliveCount,
    drifted,
    inFlightTasks,
    blockedTasks,
    leadName,
    leadUptimeSec,
  };
}

function buildWinName(m: Member): string {
  if (m.emoji !== undefined && m.emoji.length > 0) return `${m.emoji}${m.name}`;
  return m.name;
}

function wantedTuiCmd(m: Member): string | null {
  switch (m.tui ?? "claude") {
    case "claude":
      return "claude";
    case "opencode":
      return "opencode";
    case "kimi":
      return "kimi";
    case "cursor":
      return "cursor-agent";
    default:
      return null;
  }
}

async function readEpochFile(path: string): Promise<number> {
  const text = await readTextOrNull(path);
  if (text === null) return 0;
  const trimmed = text.trim();
  const n = Number.parseInt(trimmed, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Imports below avoided to keep the module self-contained; the only
// schema reference is `Member` for window-name building (matches the
// bash `tui` switch). The actual heartbeat sender lives in the verb.
// Suppress unused-import lint since `inboxPathFor` / `teamJsonPath` are
// reachable via tests of the per-team probes in follow-up work.
void inboxPathFor;
void teamJsonPath;
