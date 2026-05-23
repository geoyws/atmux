// ADR-139 §D2 / T3 (t-841049e4): refusal-event scan + record path.
//
// Pure-of-direct-IO orchestrator that the medic (hourly, ADR-077 /
// ADR-133) invokes once per team:
//   1. For each team member, capture the member's tmux pane.
//   2. Run the capture through `classifyRefusal` (ADR-139 T2).
//   3. When `detected === true`, write a row to `refusal_events`
//      (v6 → v7 migration). T4 reads accumulated rows + decides on
//      rotation; T3 ships only SCAN + RECORD.
//
// Idempotency: the `refusal_events` table has a
// `UNIQUE(member, minute_bucket, severity)` constraint, so re-scans
// within the same minute (medic + future orchd event consumer firing
// inside a 60s window, or a tick double-firing on retry) collapse via
// via `INSERT OR IGNORE`. The `recorded` field on `RefusalScanResult`
// distinguishes "row written" from "row deduped". No background
// pruning lives here — T4 / T5 add retention policy if needed.
//
// All external collaborators (tmux pane capture, classifier, DB
// handle, clock) are injected via the `RefusalScanDeps` seam so unit
// tests can pin every dimension without touching disk / tmux. Defaults
// fall through to the real implementations.

import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { exists } from "../abstractions/fs.ts";
import { closeDatabase, openDatabase } from "../abstractions/sqlite.ts";
import { migrations } from "../abstractions/sqlite-migrations.ts";
import { createTmux, type TmuxNamespace } from "../abstractions/tmux.ts";
import type { Team, TeamMember } from "../schema/team.ts";
import { buildWindowName, getSessionName, resolveTeamSocket } from "./common.ts";
import {
  classifyRefusal,
  type RefusalClass,
  type RefusalDetectionResult,
} from "./refusal-classifier.ts";

/** Severity stored on a `refusal_events` row — `none` is never written
 *  (caller only writes when `detected === true`), so the column union
 *  drops the `none` variant. */
export type RefusalEventSeverity = RefusalClass;

/** Single `refusal_events` row shape — used as the canonical read
 *  model for T4's threshold gate + the unit-test read-back path. */
export interface RefusalEventRow {
  id: string;
  member: string;
  team: string;
  phrases: { phrase: string; class: RefusalClass }[];
  severity: RefusalEventSeverity;
  confidence: number;
  detectedAt: number;
  minuteBucket: number;
}

/** Outcome of a single `recordRefusalEvent` call. `recorded === false`
 *  means the `UNIQUE(member, minute_bucket, severity)` constraint
 *  collapsed the write into an existing row (idempotent re-scan). */
export interface RecordRefusalEventOutcome {
  id: string;
  recorded: boolean;
  minuteBucket: number;
}

/** Inputs to `recordRefusalEvent`. The caller passes the team-scoped
 *  member name + team name explicitly; we do not derive them from any
 *  ambient context. `result.detected` MUST be true — callers guard. */
export interface RecordRefusalEventOpts {
  member: string;
  team: string;
  result: RefusalDetectionResult;
}

/** Pure (db + clock) record path — synchronous since bun:sqlite is
 *  synchronous and there is no I/O beyond the open DB handle. Tests
 *  construct an in-memory DB via `openDatabase(":memory:", migrations)`
 *  and call this directly. */
export function recordRefusalEvent(
  db: Database,
  nowSec: number,
  opts: RecordRefusalEventOpts,
): RecordRefusalEventOutcome {
  if (!opts.result.detected || opts.result.severity === "none") {
    throw new Error(
      "recordRefusalEvent: caller must guard on result.detected === true and severity !== 'none'",
    );
  }
  const id = `r-${randomBytes(4).toString("hex")}`;
  const minuteBucket = Math.floor(nowSec / 60);
  const phrasesJson = JSON.stringify(opts.result.phrases);
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO refusal_events
       (id, member, team, phrases, severity, confidence, detected_at, minute_bucket)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const info = stmt.run(
    id,
    opts.member,
    opts.team,
    phrasesJson,
    opts.result.severity,
    opts.result.confidence,
    nowSec,
    minuteBucket,
  );
  return { id, recorded: (info.changes ?? 0) > 0, minuteBucket };
}

/** Read-back helper — exposes the most-recent `limit` rows for a
 *  member, newest first. T4 (threshold gate) calls this with a
 *  window matching its config; T3 ships it for unit tests + the
 *  read-side surface of the verb (operator audit). */
export function listRefusalEventsForMember(
  db: Database,
  member: string,
  limit: number = 100,
): RefusalEventRow[] {
  const rows = db
    .prepare(
      `SELECT id, member, team, phrases, severity, confidence, detected_at, minute_bucket
       FROM refusal_events
       WHERE member = ?
       ORDER BY detected_at DESC
       LIMIT ?`,
    )
    .all(member, limit) as Array<{
    id: string;
    member: string;
    team: string;
    phrases: string;
    severity: string;
    confidence: number;
    detected_at: number;
    minute_bucket: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    member: r.member,
    team: r.team,
    phrases: JSON.parse(r.phrases) as { phrase: string; class: RefusalClass }[],
    severity: r.severity as RefusalEventSeverity,
    confidence: r.confidence,
    detectedAt: r.detected_at,
    minuteBucket: r.minute_bucket,
  }));
}

/** Per-member outcome surfaced to the verb + medic log. */
export interface PerMemberRefusalScan {
  member: string;
  /** `none` when classifier matched nothing; the highest-precedence
   *  class otherwise. */
  severity: "none" | RefusalClass;
  /** Number of phrase matches in the classifier result. */
  matches: number;
  /** True when a row was inserted (not deduped). */
  recorded: boolean;
  /** Row id (when `recorded === true`) — for cross-reference in the
   *  log line that medic surfaces. */
  eventId?: string;
  /** Non-fatal reason for a skip (pane capture empty, member excluded,
   *  classifier no-op). Surface in the log so operators can audit. */
  skipReason?: string;
}

/** Aggregate scan outcome — what the verb returns + what tests assert. */
export interface RefusalScanResult {
  scanned: number;
  detected: number;
  recorded: number;
  deduped: number;
  perMember: PerMemberRefusalScan[];
}

/** Dependency seam — every external collaborator is injectable so tests
 *  can pin classifier output / db rows / clock without touching disk or
 *  tmux. */
export interface RefusalScanDeps {
  tmux?: TmuxNamespace;
  /** Pane-capture fn. Default delegates to `tmux.pane.capturePane`. */
  paneCapture?: (target: string) => Promise<string>;
  /** Classifier override. Default `classifyRefusal`. */
  classify?: (capture: string) => RefusalDetectionResult;
  /** DB-handle factory. Default opens `<atmuxDir>/state.db` with the
   *  shared migration ladder. Tests pass an in-memory handle and a
   *  noop close. */
  openDb?: () => { db: Database; close: () => void };
  /** Clock override. Default `() => Math.floor(Date.now() / 1000)`. */
  nowSec?: () => number;
  /** Logger. Default writes one line per outcome to stderr. */
  log?: (msg: string) => void;
  /** Subset of members to scan; defaults to all team members (filtered
   *  by an internal "is-claude-pane" predicate the team config doesn't
   *  yet surface — for v1 we scan every member). */
  memberFilter?: (m: TeamMember) => boolean;
}

/** Default logger — single-line per outcome to stderr so cron capture
 *  stays grep-friendly. */
function defaultLog(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

/** Default DB factory — opens the team's state.db with the canonical
 *  migration ladder. Returns the `close` callback so callers don't
 *  need to import `closeDatabase` directly. */
function defaultOpenDb(atmuxDir: string): { db: Database; close: () => void } {
  const path = join(atmuxDir, "state.db");
  const db = openDatabase(path, migrations);
  return { db, close: () => closeDatabase(db) };
}

/** Scan every member-pane in the team, classify, record positive
 *  results to `refusal_events`. Returns the aggregate outcome. */
export async function scanTeamForRefusals(
  team: Team,
  atmuxDir: string,
  deps: RefusalScanDeps = {},
): Promise<RefusalScanResult> {
  const log = deps.log ?? defaultLog;
  const classify = deps.classify ?? classifyRefusal;
  const nowSecFn = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const filter = deps.memberFilter ?? (() => true);

  const session = await getSessionName({ dir: atmuxDir, team });
  const tmux = deps.tmux ?? createTmux({ socketPath: resolveTeamSocket(team) });
  const paneCapture: (target: string) => Promise<string> =
    deps.paneCapture ?? ((target: string) => tmux.pane.capturePane({ target, start: -50 }));

  // DB is required before we start scanning — if the state.db is
  // missing (uninitialized team), short-circuit to a fully no-op
  // result rather than crashing the cron loop.
  const dbPath = join(atmuxDir, "state.db");
  if (deps.openDb === undefined && !(await exists(dbPath))) {
    log(`refusal-scan: ${dbPath} not initialized — skipping`);
    return { scanned: 0, detected: 0, recorded: 0, deduped: 0, perMember: [] };
  }

  const { db, close } = deps.openDb !== undefined ? deps.openDb() : defaultOpenDb(atmuxDir);
  try {
    const nowSec = nowSecFn();
    const perMember: PerMemberRefusalScan[] = [];
    let scanned = 0;
    let detected = 0;
    let recorded = 0;
    let deduped = 0;

    for (const m of team.members) {
      if (!filter(m)) {
        perMember.push({
          member: m.name,
          severity: "none",
          matches: 0,
          recorded: false,
          skipReason: "filtered",
        });
        continue;
      }
      const windowName = buildWindowName(m.name, m.emoji, m.label);
      const windowTarget = `${session}:${windowName}`;
      let capture = "";
      try {
        capture = await paneCapture(windowTarget);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        log(`refusal-scan: ${m.name} capture failed: ${reason}`);
        perMember.push({
          member: m.name,
          severity: "none",
          matches: 0,
          recorded: false,
          skipReason: `capture-failed: ${reason}`,
        });
        continue;
      }
      scanned += 1;
      if (capture.length === 0) {
        perMember.push({
          member: m.name,
          severity: "none",
          matches: 0,
          recorded: false,
          skipReason: "empty-capture",
        });
        continue;
      }

      const result = classify(capture);
      if (!result.detected || result.severity === "none") {
        perMember.push({
          member: m.name,
          severity: "none",
          matches: 0,
          recorded: false,
        });
        continue;
      }
      detected += 1;
      const outcome = recordRefusalEvent(db, nowSec, {
        member: m.name,
        team: team.name,
        result,
      });
      if (outcome.recorded) {
        recorded += 1;
        log(
          `refusal-scan: ${m.name} severity=${result.severity} ` +
            `confidence=${result.confidence.toFixed(2)} ` +
            `matches=${result.phrases.length} → recorded (${outcome.id})`,
        );
      } else {
        deduped += 1;
        log(
          `refusal-scan: ${m.name} severity=${result.severity} ` +
            `confidence=${result.confidence.toFixed(2)} ` +
            `matches=${result.phrases.length} → deduped (minute_bucket=${outcome.minuteBucket})`,
        );
      }
      perMember.push({
        member: m.name,
        severity: result.severity,
        matches: result.phrases.length,
        recorded: outcome.recorded,
        eventId: outcome.id,
      });
    }

    log(
      `refusal-scan: tick complete — scanned=${scanned} detected=${detected} ` +
        `recorded=${recorded} deduped=${deduped}`,
    );
    return { scanned, detected, recorded, deduped, perMember };
  } finally {
    close();
  }
}
