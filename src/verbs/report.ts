// ADR-010: CLI dispatcher — `report` verb.
// Bash spec: lib/report.sh @ worktree-frozen.
//
// 30-min progress digest intended for cron. Generates + prints + (when
// configured) pings Discord with: shipped tasks since last report,
// in-progress per member, blockers, open driver-inbox asks. Persists
// `<atmuxDir>/state/last-report.epoch` so next invocation knows the
// "since last" cutoff.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type DiscordSection, send as discordSend } from "../abstractions/discord.ts";
import { exists } from "../abstractions/fs.ts";
import { formatMyt } from "../abstractions/time.ts";
import {
  driverInboxPath,
  getAtmuxDir,
  type ResolveDirOpts,
  requireTeam,
  stateDir,
} from "../core/common.ts";
import { defaultStderrWrite, defaultStdoutWrite, type Writer } from "../core/io.ts";
import { kanbanWorkStateAvailable } from "../core/kanban-backend.ts";
import { loadKanban } from "../core/kanban.ts";
import { ConfigError, UsageError } from "../errors.ts";
import type { KanbanTask } from "../schema/kanban.ts";

const USAGE = "atmux report [--no-discord] [--team-dir <dir>]";

// ---------- Args ----------

export interface ReportArgs {
  pushDiscord: boolean;
  teamDir?: string;
}

/** Pure parser. Throws `UsageError` on bad invocation. */
export function parseReportArgs(argv: ReadonlyArray<string>): ReportArgs {
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
        throw new UsageError({ what: "report: --team-dir requires a value", hint: USAGE });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    throw new UsageError({ what: `report: unknown arg: ${a ?? ""}`, hint: USAGE });
  }
  const out: ReportArgs = { pushDiscord };
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

// ---------- Pure selection helpers ----------

/** Tasks completed AFTER `sinceEpoch` (in seconds). Mirrors bash's
 *  `select(.status=="done" and (.completedAt // 0) > $last)`. */
export function selectShipped(tasks: ReadonlyArray<KanbanTask>, sinceEpoch: number): KanbanTask[] {
  return tasks.filter((t) => t.status === "done" && (t.completedAt ?? 0) > sinceEpoch);
}

/** Tasks in `in-progress` status. */
export function selectInProgress(tasks: ReadonlyArray<KanbanTask>): KanbanTask[] {
  return tasks.filter((t) => t.status === "in-progress");
}

/** Tasks in `blocked` status. */
export function selectBlocked(tasks: ReadonlyArray<KanbanTask>): KanbanTask[] {
  return tasks.filter((t) => t.status === "blocked");
}

/** Driver-inbox `## Open` section bullets. Mirrors bash awk pass. */
export function selectOpenAsks(driverInbox: string): string[] {
  const lines = driverInbox.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  let inOpen = false;
  for (const line of lines) {
    if (/^## Open\b/.test(line)) {
      inOpen = true;
      continue;
    }
    if (/^## /.test(line)) {
      inOpen = false;
      continue;
    }
    if (inOpen && line.startsWith("- ")) {
      out.push(line);
    }
  }
  return out;
}

/** Bash row format: `  <emoji> <id> · <owner> · <subject>`. Owner
 *  defaults to "?" when null/absent (parity). */
export function formatTaskRow(emoji: string, t: KanbanTask): string {
  const owner = typeof t.owner === "string" && t.owner.length > 0 ? t.owner : "?";
  const subject = typeof t.subject === "string" ? t.subject : "";
  return `  ${emoji} ${t.id} · ${owner} · ${subject}`;
}

// ---------- Body builders ----------

export interface ReportBodyOpts {
  team: string;
  timestamp: string;
  shipped: ReadonlyArray<KanbanTask>;
  inProgress: ReadonlyArray<KanbanTask>;
  blocked: ReadonlyArray<KanbanTask>;
  openAsks: ReadonlyArray<string>;
}

/** Free-form text body, byte-parity with bash report.sh:60-77. Used
 *  for stdout (and as the `content` payload would be in bash, but the
 *  TS port routes Discord through structured `discord.send`). */
export function buildReportBody(opts: ReportBodyOpts): string {
  let body = `📊 **[atmux-report]** · \`${opts.team}\` · ${opts.timestamp}`;
  body += `\n\n🏗️ **Shipped** (since last report): ${opts.shipped.length}`;
  if (opts.shipped.length > 0) {
    body += `\n${opts.shipped.map((t) => formatTaskRow("✅", t)).join("\n")}`;
  }
  body += "\n\n🟡 **In-progress**";
  if (opts.inProgress.length > 0) {
    body += `\n${opts.inProgress.map((t) => formatTaskRow("🟡", t)).join("\n")}`;
  } else {
    body += "\n  (none)";
  }
  if (opts.blocked.length > 0) {
    body += `\n\n🛑 **Blocked**\n${opts.blocked.map((t) => formatTaskRow("🛑", t)).join("\n")}`;
  }
  if (opts.openAsks.length > 0) {
    body += `\n\n🙏 **Open driver-inbox asks**\n${opts.openAsks.join("\n")}`;
  }
  return body;
}

/** Structured Discord sections per ADR-008. Each bullet must start
 *  with an allowed prefix emoji + ≤80 graphemes. We strip the bash
 *  leading 2-space indent and collapse to `<emoji> <id> · <owner> ·
 *  <subject>` form. Subjects beyond the budget are ellipsized. */
export function buildDiscordSections(opts: ReportBodyOpts): DiscordSection[] {
  const sections: DiscordSection[] = [];

  const shippedBullets =
    opts.shipped.length > 0
      ? opts.shipped.map((t) => taskBullet("✅", t))
      : ["📊 (none since last report)"];
  sections.push({
    label: `🏗️ **Shipped** (since last report): ${opts.shipped.length}`,
    bullets: shippedBullets,
  });

  const ipBullets =
    opts.inProgress.length > 0 ? opts.inProgress.map((t) => taskBullet("🟡", t)) : ["📊 (none)"];
  sections.push({ label: "🟡 **In-progress**", bullets: ipBullets });

  if (opts.blocked.length > 0) {
    sections.push({
      label: "🛑 **Blocked**",
      bullets: opts.blocked.map((t) => taskBullet("🛑", t)),
    });
  }

  if (opts.openAsks.length > 0) {
    sections.push({
      label: "🙏 **Open driver-inbox asks**",
      bullets: opts.openAsks.map((line) => askBullet(line)),
    });
  }

  return sections;
}

/** ≤80 grapheme bullet — `<emoji> <id> · <owner> · <subject>`. Cuts
 *  the subject if needed; uses … to mark truncation. */
function taskBullet(emoji: string, t: KanbanTask): string {
  const owner = typeof t.owner === "string" && t.owner.length > 0 ? t.owner : "?";
  const subject = typeof t.subject === "string" ? t.subject : "";
  const prefix = `${emoji} ${t.id} · ${owner} · `;
  const max = 80;
  if (prefix.length + subject.length <= max) return `${prefix}${subject}`;
  const room = max - prefix.length - 1; // room for the ellipsis
  return `${prefix}${subject.slice(0, Math.max(0, room))}…`;
}

/** Open-asks bullet — strip the leading `- ` and prefix with the
 *  allowed `🙏` emoji. */
function askBullet(line: string): string {
  const body = line.replace(/^- /, "").trim();
  const prefix = "🙏 ";
  const max = 80;
  if (prefix.length + body.length <= max) return `${prefix}${body}`;
  const room = max - prefix.length - 1;
  return `${prefix}${body.slice(0, Math.max(0, room))}…`;
}

// ---------- Side-effect helpers ----------

/** Read `<stateDir>/last-report.epoch` as a non-negative integer.
 *  Missing / unparseable → 0. */
export async function readLastReportEpoch(atmuxDir: string): Promise<number> {
  const path = join(stateDir(atmuxDir), "last-report.epoch");
  if (!(await exists(path))) return 0;
  const text = await readFile(path, "utf8");
  const n = Number.parseInt(text.trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Persist the new epoch (in seconds). `mkdir -p` handles first-run. */
export async function writeLastReportEpoch(atmuxDir: string, epochSec: number): Promise<void> {
  await mkdir(stateDir(atmuxDir), { recursive: true });
  await writeFile(join(stateDir(atmuxDir), "last-report.epoch"), `${epochSec}\n`);
}

/** Read `<atmuxDir>/driver-inbox.md` or "" when absent. */
async function readDriverInbox(atmuxDir: string): Promise<string> {
  const p = driverInboxPath(atmuxDir);
  if (!(await exists(p))) return "";
  return await readFile(p, "utf8");
}

// ---------- Public verb entry ----------

export interface ReportOpts {
  /** stdout sink. Defaults to `process.stdout.write`. */
  stdout?: Writer;
  /** stderr sink. Defaults to `process.stderr.write`. */
  stderr?: Writer;
  /** Clock — defaults to `Date.now`. */
  now?: () => number;
  /** Discord sender override (test injection). Defaults to
   *  `discord.send`. Errors caught + warned, not re-thrown — bash
   *  parity (atmux::warn "discord: ping failed"). */
  discordSend?: (opts: Parameters<typeof discordSend>[0]) => Promise<void>;
  /** Webhook override forwarded to discord.send (test injection). */
  webhookOverride?: string;
}

/** `atmux report [--no-discord] [--team-dir <dir>]`. Returns 0 on success. */
export async function report(argv: ReadonlyArray<string>, opts: ReportOpts = {}): Promise<number> {
  const parsed = parseReportArgs(argv);
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const team = await requireTeam(dirOpts);
  const atmuxDir = await getAtmuxDir(dirOpts);

  const stdout = opts.stdout ?? defaultStdoutWrite;
  const stderr = opts.stderr ?? defaultStderrWrite;
  const clock = opts.now ?? Date.now;
  const send = opts.discordSend ?? discordSend;

  const last = await readLastReportEpoch(atmuxDir);
  const nowMs = clock();
  const nowSec = Math.floor(nowMs / 1000);
  const ts = formatMyt(nowMs);

  const tasks = (await kanbanWorkStateAvailable(atmuxDir))
    ? (await loadKanban(atmuxDir)).tasks
    : [];
  const shipped = selectShipped(tasks, last);
  const inProgress = selectInProgress(tasks);
  const blocked = selectBlocked(tasks);
  const driverInbox = await readDriverInbox(atmuxDir);
  const openAsks = selectOpenAsks(driverInbox);

  const bodyOpts: ReportBodyOpts = {
    team: team.name,
    timestamp: ts,
    shipped,
    inProgress,
    blocked,
    openAsks,
  };
  const body = buildReportBody(bodyOpts);
  stdout(`${body}\n`);

  if (parsed.pushDiscord) {
    const sections = buildDiscordSections(bodyOpts);
    const sendOpts: Parameters<typeof discordSend>[0] = {
      template: "report-digest",
      team: team.name,
      category: "📊",
      sections,
      whenMs: nowMs,
    };
    if (opts.webhookOverride !== undefined) sendOpts.webhookOverride = opts.webhookOverride;
    try {
      await send(sendOpts);
    } catch (e) {
      // Bash logs `atmux::log "discord: ATMUX_DISCORD_WEBHOOK not set"`
      // and continues — mirror by treating Discord errors as soft (the
      // verb's primary product is the stdout body + the epoch update).
      if (e instanceof ConfigError) {
        // No webhook resolved — bash equivalent of the no-op early
        // return at lib/discord.sh:9-11. Skip silently.
      } else {
        const reason = e instanceof Error ? e.message : String(e);
        stderr(`atmux: warn: report: discord ping failed: ${reason}\n`);
      }
    }
  }

  await writeLastReportEpoch(atmuxDir, nowSec);
  return 0;
}
