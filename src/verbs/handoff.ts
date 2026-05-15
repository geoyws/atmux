// ADR-010: CLI dispatcher — `handoff` verb.
// Bash spec: lib/handoff.sh @ worktree-frozen.
//
// Move all in-progress work from one member to another.
//
// Two-phase capture:
//   1. Native (best-effort): ask the source pane to write a structured
//      summary to a known path; poll for the file (default 30s).
//   2. Fallback: tmux capture-pane on the source for the last N lines
//      (default 500). When the source window doesn't exist, write a
//      "source pane gone" stub so the target still has SOMETHING to
//      read.
//
// After capture: migrate kanban tasks (owner=from + status in
// {in-progress,blocked} → owner=to), clear from-inbox.inProgress,
// append migrated entries to to-inbox.inProgress, ping the target
// pane with a brief naming the handoff file + task count.
//
// Optional `--pause-from` then runs `atmux pause <from>` so the source
// member doesn't pick up new work after handoff.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exists } from "../abstractions/fs.ts";
import { updateJson } from "../abstractions/json.ts";
import { nowIso } from "../abstractions/time.ts";
import { createTmux, type TmuxNamespace } from "../abstractions/tmux.ts";
import {
  buildWindowName,
  getAtmuxDir,
  resolveTeamSocket,
  getSessionName,
  inboxPathFor,
  kanbanJsonPath,
  type ResolveDirOpts,
  requireTeam,
} from "../core/common.ts";
import { defaultStderrWrite, defaultStdoutWrite, type Writer } from "../core/io.ts";
import { pauseMember } from "../core/pause.ts";
import { sendToMember } from "../core/send.ts";
import { ConfigError, UsageError } from "../errors.ts";
import { type InboxEntry, Inbox as InboxSchema } from "../schema/inbox.ts";
import { Kanban as KanbanSchema, type KanbanTask } from "../schema/kanban.ts";
import type { Team, TeamMember } from "../schema/team.ts";
import { defaultSleep, windowExists } from "./rotate.ts";

const USAGE = "atmux handoff <from> <to> [--reason <text>] [--no-native] [--pause-from]";

// ---------- Args ----------

export interface HandoffArgs {
  from: string;
  to: string;
  reason: string;
  native: boolean;
  pauseFrom: boolean;
  socketPath?: string;
  teamDir?: string;
}

/** Pure parser. Throws `UsageError` on bad invocation. */
export function parseHandoffArgs(argv: ReadonlyArray<string>): HandoffArgs {
  let from = "";
  let to = "";
  let reason = "";
  let native = true;
  let pauseFrom = false;
  let socketPath: string | undefined;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--reason") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "handoff: --reason requires a value", hint: USAGE });
      }
      reason = v;
      i += 2;
      continue;
    }
    if (a === "--no-native") {
      native = false;
      i += 1;
      continue;
    }
    if (a === "--pause-from") {
      pauseFrom = true;
      i += 1;
      continue;
    }
    if (a === "--socket") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "handoff: --socket requires a path", hint: USAGE });
      }
      socketPath = v;
      i += 2;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "handoff: --team-dir requires a value", hint: USAGE });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    if (a?.startsWith("-")) {
      throw new UsageError({ what: `handoff: unknown flag: ${a}`, hint: USAGE });
    }
    if (from.length === 0) {
      from = a ?? "";
    } else if (to.length === 0) {
      to = a ?? "";
    } else {
      throw new UsageError({ what: "handoff: too many args", hint: USAGE });
    }
    i += 1;
  }
  if (from.length === 0 || to.length === 0) {
    throw new UsageError({ what: USAGE });
  }
  const out: HandoffArgs = { from, to, reason, native, pauseFrom };
  if (socketPath !== undefined) out.socketPath = socketPath;
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

// ---------- Pure render helpers ----------

/** Bash handoff.sh:51 — body of the prompt that asks the source pane to
 *  write a handoff summary. The literal `OK-HANDOFF` is the reply
 *  marker bash polls for indirectly via file presence (we mirror the
 *  prompt verbatim — file presence is the actual trigger). */
export function buildHandoffNoteAsk(handoffFile: string): string {
  return [
    `📝 Please write a concise handoff summary to \`${handoffFile}\` covering:`,
    "(1) what you were working on, (2) current state / blockers / open",
    "questions, (3) next steps. Keep it under 50 lines. Then reply OK-HANDOFF.",
  ].join(" ");
}

export interface ScreenCaptureNoteOpts {
  from: string;
  to: string;
  timestamp: string;
  reason: string;
  lines: number;
  capture: string;
}

/** Bash handoff.sh:67-75 — the screen-capture fallback file body. */
export function buildScreenCaptureNote(opts: ScreenCaptureNoteOpts): string {
  const reason = opts.reason.length > 0 ? opts.reason : "";
  return [
    "# Handoff via screen capture",
    "",
    `from: ${opts.from}`,
    `to: ${opts.to}`,
    `timestamp: ${opts.timestamp}`,
    `reason: ${reason}`,
    `method: tmux capture-pane (last ${opts.lines} lines)`,
    "",
    "## Captured pane",
    "",
    "```",
    opts.capture,
    "```",
    "",
  ].join("\n");
}

export interface AbsentSourceNoteOpts {
  from: string;
  to: string;
  timestamp: string;
  reason: string;
}

/** Bash handoff.sh:77-82 — the no-pane stub when the source window is
 *  already gone. */
export function buildAbsentSourceNote(opts: AbsentSourceNoteOpts): string {
  const reason = opts.reason.length > 0 ? opts.reason : "";
  return [
    "# Handoff — source member window is gone",
    "",
    `from: ${opts.from}`,
    `to: ${opts.to}`,
    `timestamp: ${opts.timestamp}`,
    `reason: ${reason}`,
    "",
    "(no pane to capture)",
    "",
  ].join("\n");
}

export interface BriefBodyOpts {
  from: string;
  to: string;
  reason: string;
  handoffFile: string;
  nMigrating: number;
}

/** Bash handoff.sh:110-120 — the message pasted into the target pane
 *  after handoff completes. */
export function buildBriefBody(opts: BriefBodyOpts): string {
  const reason = opts.reason.length > 0 ? opts.reason : "unspecified";
  return [
    `📦 HANDOFF — you are taking over from \`${opts.from}\`.`,
    "",
    `reason: ${reason}`,
    `handoff notes: ${opts.handoffFile}`,
    `migrated tasks: ${opts.nMigrating} (see \`atmux inbox ${opts.to}\`)`,
    "",
    "Please read the handoff notes and continue from there. Run:",
    `  atmux inbox ${opts.to}`,
    `  cat ${opts.handoffFile}`,
  ].join("\n");
}

/** Bash `date -u +%Y%m%dT%H%M%SZ` — used in the handoff filename. */
export function handoffTimestamp(epochMs: number): string {
  return new Date(epochMs)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

// ---------- Side-effect helpers ----------

/** Migrate every task with `owner === from && status ∈ {in-progress,
 *  blocked}` over to `to`. Returns the migrated entries in their post-
 *  reassignment shape — caller mirrors them into the to-inbox. */
export async function migrateTasks(
  atmuxDir: string,
  from: string,
  to: string,
): Promise<KanbanTask[]> {
  let migrated: KanbanTask[] = [];
  await updateJson(kanbanJsonPath(atmuxDir), KanbanSchema, (current) => {
    const next = {
      ...current,
      tasks: current.tasks.map((t) => {
        if (t.owner === from && (t.status === "in-progress" || t.status === "blocked")) {
          return { ...t, owner: to };
        }
        return t;
      }),
    };
    migrated = next.tasks.filter(
      (t) => t.owner === to && (t.status === "in-progress" || t.status === "blocked"),
    );
    // Narrow to entries that USED to be `from` — guard against pre-existing
    // `to` ownership matching the same status (would otherwise sweep an
    // unrelated task into the inbox-mirror).
    migrated = migrated.filter((t) =>
      current.tasks.some((orig) => orig.id === t.id && orig.owner === from),
    );
    return next;
  });
  return migrated;
}

/** Mirror `migrated` into to-inbox.inProgress (idempotent unique-by-id),
 *  clear from-inbox.inProgress. Bash handoff.sh:88-105. */
export async function migrateInboxes(
  atmuxDir: string,
  from: string,
  to: string,
  migrated: ReadonlyArray<KanbanTask>,
): Promise<void> {
  const fromPath = inboxPathFor(atmuxDir, from);
  const toPath = inboxPathFor(atmuxDir, to);
  if (await exists(fromPath)) {
    await updateJson(fromPath, InboxSchema, (current) => ({
      ...current,
      inProgress: [],
    }));
  }
  // Build the entries to push — bash uses the kanban tasks raw, but the
  // inbox schema expects `{id, subject?, body?, dispatchedAt?}`. Keep
  // dispatchedAt as the original task's claimedAt where present, else
  // `now()`-stamped at migration time.
  const entries: InboxEntry[] = migrated.map((t) => {
    const e: InboxEntry = { id: t.id };
    if (typeof t.subject === "string") e.subject = t.subject;
    if (typeof t.body === "string") e.body = t.body;
    return e;
  });
  await updateJson(
    toPath,
    InboxSchema,
    (current) => {
      const seen = new Set(current.inProgress.map((e) => e.id));
      const merged = [...current.inProgress];
      for (const e of entries) {
        if (!seen.has(e.id)) {
          merged.push(e);
          seen.add(e.id);
        }
      }
      return { ...current, inProgress: merged };
    },
    { initial: { pending: [], inProgress: [], done: [] } },
  );
}

/** Default file-existence poller — checks `path` every `intervalMs`,
 *  up to `timeoutMs`. Returns `true` on first hit, `false` on timeout. */
export async function pollForFile(
  path: string,
  timeoutMs: number,
  intervalMs: number,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<boolean> {
  if (timeoutMs <= 0) return await exists(path);
  let elapsed = 0;
  while (elapsed < timeoutMs) {
    if (await exists(path)) return true;
    await sleep(intervalMs);
    elapsed += intervalMs;
  }
  return await exists(path);
}

// ---------- Public verb entry ----------

export interface HandoffOpts {
  /** Tmux factory — defaults to `createTmux({ socketPath })`. */
  buildTmux?: (socketPath: string) => TmuxNamespace;
  /** File-existence poller — defaults to `pollForFile`. */
  pollFile?: (path: string, timeoutMs: number, intervalMs: number) => Promise<boolean>;
  /** Sleep override (forwarded into pollFile when default). */
  sleep?: (ms: number) => Promise<void>;
  /** stdout sink. Defaults to `process.stdout.write`. */
  stdout?: Writer;
  /** stderr sink. Defaults to `process.stderr.write`. */
  stderr?: Writer;
  /** Clock — defaults to `Date.now`. */
  now?: () => number;
  /** Wait-for-handoff-file timeout in seconds. Defaults to
   *  `$ATMUX_HANDOFF_WAIT` or 30. */
  waitSeconds?: number;
  /** Capture-pane line count. Defaults to `$ATMUX_HANDOFF_LINES` or 500. */
  captureLines?: number;
}

/** Default tmux factory — exported so tests can drive the closure
 *  without going through the rotate() / handoff() verb wiring. */
export function defaultBuildTmux(socketPath: string): TmuxNamespace {
  return createTmux({ socketPath });
}

/** Resolve the wait timeout from opts → env → default 30s. Exported so
 *  the env-fallback chain is unit-testable without going through the
 *  full verb. */
export function resolveWaitSeconds(
  opts: { waitSeconds?: number },
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (opts.waitSeconds !== undefined) return opts.waitSeconds;
  const raw = env.ATMUX_HANDOFF_WAIT;
  if (raw !== undefined && raw.length > 0) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 30;
}

/** Resolve capture-line count from opts → env → default 500. */
export function resolveCaptureLines(
  opts: { captureLines?: number },
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (opts.captureLines !== undefined) return opts.captureLines;
  const raw = env.ATMUX_HANDOFF_LINES;
  if (raw !== undefined && raw.length > 0) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 500;
}

/** `atmux handoff <from> <to> [...]`. Returns 0 on success. */
export async function handoff(
  argv: ReadonlyArray<string>,
  opts: HandoffOpts = {},
): Promise<number> {
  const parsed = parseHandoffArgs(argv);
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const team: Team = await requireTeam(dirOpts);

  const fromMember = findMember(team, parsed.from);
  if (fromMember === null) {
    throw new ConfigError({ what: `handoff: no such member in team.json: ${parsed.from}` });
  }
  const toMember = findMember(team, parsed.to);
  if (toMember === null) {
    throw new ConfigError({ what: `handoff: no such member in team.json: ${parsed.to}` });
  }

  const atmuxDir = await getAtmuxDir(dirOpts);
  const sessionName = await getSessionName({ ...dirOpts, team });
  const socketPath = parsed.socketPath ?? resolveTeamSocket(team);
  const tmux = (opts.buildTmux ?? defaultBuildTmux)(socketPath);
  const stdout = opts.stdout ?? defaultStdoutWrite;
  const stderr = opts.stderr ?? defaultStderrWrite;
  const clockNow = opts.now ?? Date.now;

  const ts = handoffTimestamp(clockNow());
  const handoffDir = join(atmuxDir, "handoff");
  await mkdir(handoffDir, { recursive: true });
  const handoffFile = join(handoffDir, `${parsed.from}-to-${parsed.to}-${ts}.md`);

  const fromTarget = `${sessionName}:${buildWindowName(fromMember.name, fromMember.emoji, fromMember.label)}`;
  const toTarget = `${sessionName}:${buildWindowName(toMember.name, toMember.emoji, toMember.label)}`;

  // Step 1: native ask (best-effort).
  let nativeOk = false;
  if (
    parsed.native &&
    (await windowExists(tmux, sessionName, buildWindowName(fromMember.name, fromMember.emoji, fromMember.label)))
  ) {
    const ask = buildHandoffNoteAsk(handoffFile);
    try {
      await sendToMember(
        tmux,
        atmuxDir,
        { target: fromTarget, member: parsed.from, team: team.name },
        ask,
        { verify: false },
      );
      const waitSec = resolveWaitSeconds(opts);
      const poller = opts.pollFile ?? pollForFile;
      nativeOk = await poller(handoffFile, waitSec * 1_000, 1_000);
    } catch (e) {
      // bash handoff.sh:52 condition fails → native_ok stays 0; no
      // separate warn.
      const msg = e instanceof Error ? e.message : String(e);
      stderr(`atmux: warn: handoff: native ask to ${parsed.from} failed: ${msg}\n`);
    }
  }

  // Step 2: fallback — screen scrape.
  if (!nativeOk) {
    stderr(`  native handoff did not produce ${handoffFile} — falling back to screen capture\n`);
    const lines = resolveCaptureLines(opts);
    const fromWindow = buildWindowName(fromMember.name, fromMember.emoji, fromMember.label);
    const sourceUp = await windowExists(tmux, sessionName, fromWindow);
    if (sourceUp) {
      let capture = "";
      try {
        capture = await tmux.pane.capturePane({ target: fromTarget, start: -lines });
      } catch {
        capture = "(capture failed)";
      }
      const body = buildScreenCaptureNote({
        from: parsed.from,
        to: parsed.to,
        timestamp: nowIso(clockNow()),
        reason: parsed.reason,
        lines,
        capture,
      });
      await writeFile(handoffFile, body);
    } else {
      const body = buildAbsentSourceNote({
        from: parsed.from,
        to: parsed.to,
        timestamp: nowIso(clockNow()),
        reason: parsed.reason,
      });
      await writeFile(handoffFile, body);
    }
  }

  // Step 3: migrate kanban + inboxes.
  const migrated = await migrateTasks(atmuxDir, parsed.from, parsed.to);
  if (migrated.length > 0) {
    await migrateInboxes(atmuxDir, parsed.from, parsed.to, migrated);
  }

  // Step 4: brief the target.
  const briefBody = buildBriefBody({
    from: parsed.from,
    to: parsed.to,
    reason: parsed.reason,
    handoffFile,
    nMigrating: migrated.length,
  });
  if (await windowExists(tmux, sessionName, buildWindowName(toMember.name, toMember.emoji, toMember.label))) {
    try {
      await sendToMember(
        tmux,
        atmuxDir,
        { target: toTarget, member: parsed.to, team: team.name },
        briefBody,
        { verify: false },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      stderr(`atmux: warn: handoff: ping to ${parsed.to} failed: ${msg}\n`);
    }
  } else {
    stderr(`handoff: target pane ${parsed.to} is not up — briefing deferred\n`);
  }

  // Step 5: optional --pause-from.
  if (parsed.pauseFrom) {
    const pauseReason = parsed.reason.length > 0 ? `handoff-${parsed.reason}` : "handoff-manual";
    await pauseMember(atmuxDir, parsed.from, { reason: pauseReason });
  }

  stdout(
    `handoff complete: ${parsed.from} → ${parsed.to} (${migrated.length} tasks, notes at ${handoffFile})\n`,
  );
  return 0;
}

// ---------- Internals ----------

function findMember(team: Team, name: string): TeamMember | null {
  return team.members.find((m) => m.name === name) ?? null;
}
