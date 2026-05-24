// ADR-139 T4 (t-a830d2ee): refusal auto-rotate trigger glue.
//
// Sits between the SCAN + RECORD path (ADR-139 T3, this file's
// upstream) and the rotate-fire path (`atmux rotate <member>`).
// For each per-member decision tick:
//
//   1. Read recent `refusal_events` rows from the team's state.db
//      (windowMin lookback per the resolved config).
//   2. Hand the ledger to `refusal-threshold.ts::shouldRotate` (pure
//      ADR-139 T2 decision module).
//   3. Apply two outer gates the pure threshold layer doesn't see:
//        a. `exemptMembers` — never auto-rotate the member.
//        b. `maxRotationsPerDay` cap — beyond N fires per UTC day for
//           a single member, emit HARD escalation instead of another
//           rotate.
//   4. On a green decision: fire `atmux rotate <member>` via injected
//      spawn, append a row to the rotations log, fire the Discord
//      `[member-refusal-rotate]` template, file a complaint (HARD only).
//
// Pure-of-direct-IO via the `RefusalTriggerDeps` seam — every
// collaborator (DB handle, spawn, clock, logger, fs append, Discord
// sender) is injectable. Production callers (medic) call
// `runRefusalTriggerForTeam` once per tick after the SCAN + RECORD
// pass; the function iterates members + dispatches per-member.

import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { type DiscordSendOpts, renderMemberRefusalRotate } from "../abstractions/discord.ts";
import { appendText, ensureDir } from "../abstractions/fs.ts";
import { formatMyt } from "../abstractions/time.ts";
import {
  type ResolvedRefusalConfig,
  resolveRefusalConfig,
  type Team,
  type TeamMember,
} from "../schema/team.ts";
import { stateDir } from "./common.ts";
import { fileDedupedComplaint } from "./complaints.ts";
import { listRefusalEventsForMember } from "./refusal-scan.ts";
import { type RefusalEvent, type ShouldRotateDecision, shouldRotate } from "./refusal-threshold.ts";

/** Per-member decision the trigger emits. Surfaced in
 *  `RefusalTriggerResult.perMember` for logging + test assertions. */
export interface PerMemberTriggerDecision {
  member: string;
  /** What happened on this tick: `rotate-fired` (rotate spawned),
   *  `cap-hit-escalated` (HARD escalation, no rotate), `exempt`
   *  (member in `exemptMembers`), `skip-no-events` (no rows in
   *  window — common case), `skip-below-threshold` (rows present
   *  but no class crossed its threshold), `disabled` (config gate
   *  off). */
  outcome:
    | "rotate-fired"
    | "cap-hit-escalated"
    | "exempt"
    | "skip-no-events"
    | "skip-below-threshold"
    | "disabled";
  /** Triggering class when `outcome === 'rotate-fired'` /
   *  `'cap-hit-escalated'`; null otherwise. */
  triggeringClass: "soft" | "hard" | "role" | null;
  /** Human-readable reason — taken from `shouldRotate` for fire
   *  paths, fixed strings for skip paths. */
  reason: string;
  /** Today's rotation count for this member AFTER this tick (used
   *  in the cap arithmetic + Discord footer). */
  rotationsToday: number;
}

/** Aggregate result of one trigger pass over the team's members. */
export interface RefusalTriggerResult {
  rotated: number;
  capHit: number;
  exempt: number;
  skipped: number;
  perMember: PerMemberTriggerDecision[];
}

/** Injected `atmux rotate` runner shape. Returns the exit code from
 *  the child process; >=1 surfaces as a failure log line. */
export type SpawnAtmuxFn = (argv: ReadonlyArray<string>) => Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

/** Injected Discord sender. Default no-ops in tests; production wires
 *  to the real webhook sender (caller passes that in). */
export type DiscordSendFn = (opts: DiscordSendOpts) => Promise<void>;

/** Dependency seam for the trigger module. All collaborators
 *  injectable so unit tests pin every dimension. */
export interface RefusalTriggerDeps {
  /** Open team state.db handle. Used by both the `refusal_events`
   *  read + the `complaints` write. Tests pass an in-memory DB
   *  pre-seeded with rows. */
  db: Database;
  /** `atmux rotate <member>` runner. Tests pass a recorder; prod
   *  wires to `spawn({cmd: "atmux", argv: [...]})`. */
  spawnAtmux: SpawnAtmuxFn;
  /** Clock seconds. Default `() => Math.floor(Date.now()/1000)`. */
  nowSec?: () => number;
  /** Logger. Default writes to stderr. */
  log?: (msg: string) => void;
  /** atmuxDir for the rotations log path resolution. Required —
   *  there's no sensible default. */
  atmuxDir: string;
  /** Discord sender — default is a no-op (caller injects when wired
   *  to a real webhook). The renderer always runs; the dispatch is
   *  what's gated. */
  sendDiscord?: DiscordSendFn;
  /** Filesystem append override — defaults to `appendText` from
   *  `src/abstractions/fs.ts`. Tests pass a recorder. */
  fsAppend?: (path: string, body: string) => Promise<void>;
  /** Member subset — defaults to all team members. */
  memberFilter?: (m: TeamMember) => boolean;
}

function defaultLog(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

/** UTC day-key for the rotations cap. Using UTC (not MYT) so cron
 *  on a UTC-clocked host (hax) and the rotations log row line up
 *  without TZ-skew arithmetic. The display layer (Discord footer,
 *  operator-facing summary) renders MYT separately via formatMyt. */
function utcDayKey(nowSec: number): string {
  const d = new Date(nowSec * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Count today's rotations for a member by parsing the rotations log
 *  file. One row per fire; format documented in
 *  `appendRotationLogRow` below. Idempotent — log file is append-only
 *  + each row has a unique random id, so two readers see the same
 *  count. */
async function countTodayRotations(
  rotationsLogPath: string,
  member: string,
  nowSec: number,
  readFile: (path: string) => Promise<string>,
): Promise<number> {
  let body: string;
  try {
    body = await readFile(rotationsLogPath);
  } catch {
    return 0;
  }
  const today = utcDayKey(nowSec);
  let count = 0;
  for (const line of body.split("\n")) {
    if (line.length === 0) continue;
    // Row shape: `{iso}\t{day}\t{team}\t{member}\t{severity}\t{reason}`
    const parts = line.split("\t");
    if (parts.length < 4) continue;
    if (parts[1] === today && parts[3] === member) count += 1;
  }
  return count;
}

/** Append one row to the rotations log. Format tab-separated so a
 *  grep-only operator can spot the columns; first column is ISO
 *  timestamp (UTC), second is the UTC day-key the cap arithmetic
 *  reads. */
async function appendRotationLogRow(
  rotationsLogPath: string,
  args: {
    nowSec: number;
    team: string;
    member: string;
    severity: string;
    reason: string;
  },
  fsAppend: (path: string, body: string) => Promise<void>,
): Promise<void> {
  const iso = new Date(args.nowSec * 1000).toISOString();
  const day = utcDayKey(args.nowSec);
  // Strip tabs + newlines from the reason so the row stays
  // single-line + properly tokenised.
  const reasonClean = args.reason.replace(/[\t\n]+/g, " ").trim();
  const row = `${iso}\t${day}\t${args.team}\t${args.member}\t${args.severity}\t${reasonClean}\n`;
  await fsAppend(rotationsLogPath, row);
}

/** Hydrate stored rows into `RefusalEvent`s for the pure threshold
 *  layer. The classifier shape mirrors what the SCAN + RECORD path
 *  wrote — we reconstruct the minimal fields shouldRotate reads. */
function rowsToRefusalEvents(
  rows: ReturnType<typeof listRefusalEventsForMember>,
  team: string,
): RefusalEvent[] {
  return rows.map((r) => ({
    member: r.member,
    team,
    timestamp: r.detectedAt,
    result: {
      detected: true,
      severity: r.severity,
      confidence: r.confidence,
      phrases: r.phrases,
    },
  }));
}

/** Run the trigger pass for one team. Iterates team.members, applies
 *  the threshold gate + outer gates, fires `atmux rotate` on a green
 *  decision, surfaces aggregate metrics in the return value. */
export async function runRefusalTriggerForTeam(
  team: Team,
  deps: RefusalTriggerDeps,
): Promise<RefusalTriggerResult> {
  const log = deps.log ?? defaultLog;
  const nowSecFn = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const filter = deps.memberFilter ?? (() => true);
  const fsAppend = deps.fsAppend ?? appendText;
  const sendDiscord = deps.sendDiscord ?? (async () => {});

  const config: ResolvedRefusalConfig = resolveRefusalConfig(team.refusalDetection);
  const rotationsLogPath = join(stateDir(deps.atmuxDir), "refusal-rotations.log");
  // Best-effort dir creation — ignore failures, the fsAppend will
  // surface the real error.
  try {
    await ensureDir(stateDir(deps.atmuxDir));
  } catch {
    // swallow — append will report if the dir really cannot be made.
  }

  const result: RefusalTriggerResult = {
    rotated: 0,
    capHit: 0,
    exempt: 0,
    skipped: 0,
    perMember: [],
  };

  if (!config.enabled) {
    for (const m of team.members) {
      if (!filter(m)) continue;
      result.perMember.push({
        member: m.name,
        outcome: "disabled",
        triggeringClass: null,
        reason: "team.refusalDetection.enabled=false",
        rotationsToday: 0,
      });
      result.skipped += 1;
    }
    log(`refusal-trigger: team=${team.name} disabled — ${result.skipped} skipped`);
    return result;
  }

  const exemptSet = new Set(config.exemptMembers);
  const nowSec = nowSecFn();

  // Read the rotations log once per tick; pass to the per-member
  // counter via a tiny `readFile` closure so we don't re-read for
  // every member. The cap is a per-MEMBER count, so we parse the
  // file lazily per member-check.
  const readFile = async (path: string): Promise<string> => {
    const file = Bun.file(path);
    if (!(await file.exists())) return "";
    return file.text();
  };

  for (const m of team.members) {
    if (!filter(m)) continue;

    if (exemptSet.has(m.name)) {
      const rotationsToday = await countTodayRotations(rotationsLogPath, m.name, nowSec, readFile);
      result.perMember.push({
        member: m.name,
        outcome: "exempt",
        triggeringClass: null,
        reason: "member in exemptMembers",
        rotationsToday,
      });
      result.exempt += 1;
      continue;
    }

    const windowMaxRows = Math.max(config.softThreshold, config.hardThreshold, 50);
    const rows = listRefusalEventsForMember(deps.db, m.name, windowMaxRows);
    if (rows.length === 0) {
      result.perMember.push({
        member: m.name,
        outcome: "skip-no-events",
        triggeringClass: null,
        reason: "no refusal_events rows for member",
        rotationsToday: 0,
      });
      result.skipped += 1;
      continue;
    }

    const events = rowsToRefusalEvents(rows, team.name);
    const decision: ShouldRotateDecision = shouldRotate(
      events,
      {
        softThreshold: config.softThreshold,
        hardThreshold: config.hardThreshold,
        roleThreshold: config.roleThreshold,
        windowMin: config.windowMin,
      },
      nowSec,
    );

    if (!decision.rotate) {
      result.perMember.push({
        member: m.name,
        outcome: "skip-below-threshold",
        triggeringClass: null,
        reason: `recent events present but no class crossed threshold (rows=${rows.length})`,
        rotationsToday: 0,
      });
      result.skipped += 1;
      continue;
    }

    const rotationsBefore = await countTodayRotations(rotationsLogPath, m.name, nowSec, readFile);

    if (rotationsBefore >= config.maxRotationsPerDay) {
      // Cap hit — HARD escalation path. No rotate; complaint + Discord
      // marker so the operator sees the saturation.
      const complaintId = `c-${randomBytes(4).toString("hex")}`;
      try {
        fileDedupedComplaint(deps.db, nowSec, {
          sourceKind: "refusal-trigger",
          sourceId: `refusal-cap-hit:${team.name}:${m.name}:${utcDayKey(nowSec)}`,
          targetTeam: team.name,
          incidentSummary: `${m.name}: refusal-rotation cap hit (${rotationsBefore}/${config.maxRotationsPerDay} today)`,
          rootCause: decision.reason,
          preventiveAsk:
            "Operator intervention: pause team, swap account, OR rotate manually with extended context — auto-rotate cap saturated for the UTC day.",
          openedBy: "refusal-trigger",
          extra: {
            complaint_hash: complaintId,
            member: m.name,
            triggeringClass: decision.triggeringClass,
            phrases: rows[0]?.phrases ?? [],
          },
        });
      } catch (e) {
        log(
          `refusal-trigger: ${team.name}/${m.name} cap-hit complaint file failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
      try {
        await sendDiscord(
          renderMemberRefusalRotate({
            team: team.name,
            member: m.name,
            severity: decision.triggeringClass ?? "soft",
            eventCount: rows.length,
            windowMin: config.windowMin,
            rotationsToday: rotationsBefore,
            maxRotationsPerDay: config.maxRotationsPerDay,
            escalation: "cap-hit",
            topPhrases: rows
              .slice(0, 2)
              .flatMap((r) => r.phrases.map((p) => p.phrase))
              .slice(0, 2),
            whenMs: nowSec * 1000,
          }),
        );
      } catch (e) {
        log(
          `refusal-trigger: ${team.name}/${m.name} cap-hit Discord render failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
      result.perMember.push({
        member: m.name,
        outcome: "cap-hit-escalated",
        triggeringClass: decision.triggeringClass,
        reason: `cap saturated (${rotationsBefore}/${config.maxRotationsPerDay}); HARD escalation`,
        rotationsToday: rotationsBefore,
      });
      result.capHit += 1;
      log(
        `refusal-trigger: ${team.name}/${m.name} CAP-HIT (${rotationsBefore}/${config.maxRotationsPerDay}) — HARD escalation`,
      );
      continue;
    }

    // Green light — fire rotate.
    let spawnOk = false;
    let spawnErr: string | undefined;
    try {
      const out = await deps.spawnAtmux(["rotate", m.name]);
      spawnOk = out.exitCode === 0;
      if (!spawnOk) {
        spawnErr = `exit=${out.exitCode}; stderr=${out.stderr.slice(0, 200)}`;
      }
    } catch (e) {
      spawnErr = e instanceof Error ? e.message : String(e);
    }

    // Record the fire regardless of spawn outcome — the operator
    // needs to see the attempt even on spawn failure (next tick
    // re-fires only if events keep landing).
    await appendRotationLogRow(
      rotationsLogPath,
      {
        nowSec,
        team: team.name,
        member: m.name,
        severity: decision.triggeringClass ?? "soft",
        reason: spawnOk
          ? decision.reason
          : `${decision.reason} [spawn-failed: ${spawnErr ?? "unknown"}]`,
      },
      fsAppend,
    );
    const rotationsAfter = rotationsBefore + 1;

    try {
      await sendDiscord(
        renderMemberRefusalRotate({
          team: team.name,
          member: m.name,
          severity: decision.triggeringClass ?? "soft",
          eventCount: rows.length,
          windowMin: config.windowMin,
          rotationsToday: rotationsAfter,
          maxRotationsPerDay: config.maxRotationsPerDay,
          escalation: spawnOk ? "rotate" : "spawn-failed",
          topPhrases: rows
            .slice(0, 2)
            .flatMap((r) => r.phrases.map((p) => p.phrase))
            .slice(0, 2),
          whenMs: nowSec * 1000,
        }),
      );
    } catch (e) {
      log(
        `refusal-trigger: ${team.name}/${m.name} Discord render failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }

    result.perMember.push({
      member: m.name,
      outcome: "rotate-fired",
      triggeringClass: decision.triggeringClass,
      reason: spawnOk
        ? decision.reason
        : `${decision.reason} [spawn-failed: ${spawnErr ?? "unknown"}]`,
      rotationsToday: rotationsAfter,
    });
    result.rotated += 1;
    log(
      `refusal-trigger: ${team.name}/${m.name} ROTATE fired (${decision.triggeringClass}; today=${rotationsAfter}/${config.maxRotationsPerDay}) ${
        spawnOk ? "ok" : "[spawn-failed]"
      }`,
    );
  }

  log(
    `refusal-trigger: tick complete — team=${team.name} rotated=${result.rotated} cap-hit=${result.capHit} exempt=${result.exempt} skipped=${result.skipped}`,
  );
  // Reference formatMyt so the build keeps the import tree intact —
  // a future doc-build path uses the helper in the same module.
  void formatMyt;
  return result;
}
