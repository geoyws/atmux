// ADR-152 T1 — `atmux blockers list` unified verb.
//
// Closes complaint c-1d28fc72 (driver-claude-sopx 2026-05-15). Foundation
// for ADR-151 unblocker (t-fba73bf8) which needs a single queryable
// signal source instead of the operator memory-load that grew with team
// size.
//
// Fans out across 7 surfaces (4 SQLite + 3 markdown), normalizes each
// into a `BlockerRow`, joins the result. Storage is NOT moved — markdown
// stays where it is; this module only joins reads.
//
// Per-surface helpers are exported so the unblocker (and tests) can
// exercise them in isolation; `queryAllBlockers` is the verb-facing
// fan-out. All helpers take `nowSec` injectable so tests pin the clock.

import type { Database } from "bun:sqlite";
import { readTextOrNull } from "../abstractions/fs.ts";
import { decisionsLogPath, driverInboxPath } from "./common.ts";

// ---------- Taxonomy ----------

/** ADR-152 §taxonomy — eight blocker classes, the union forced by the
 *  complaint's preventive ask. New classes land here AND on the markdown
 *  surface convention (leading-emoji or `[class:X]` token); reviewer
 *  blocks additions without docs. */
export const BLOCKER_CLASSES = [
  "decision-pending",
  "member-stuck",
  "cross-lane-WIP",
  "tooling-broken",
  "stale-claim",
  "dep-not-shipped",
  "review-pending",
  "push-policy-gate",
] as const;
export type BlockerClass = (typeof BLOCKER_CLASSES)[number];

/** ADR-152 §surfaces — the seven sources `queryAllBlockers` joins. */
export const BLOCKER_SOURCES = [
  "sqlite-tasks-blocked",
  "sqlite-tasks-stale",
  "sqlite-complaints",
  "sqlite-merger-state",
  "md-decisions",
  "md-flags",
  "md-driver-inbox",
] as const;
export type BlockerSource = (typeof BLOCKER_SOURCES)[number];

/** Markdown leading-emoji → `BlockerClass` lift table. Per ADR-152
 *  §Markdown class lifting — operator-visible glyphs that already exist
 *  on the markdown surfaces (driver-inbox.md / lead-outbox.md / decisions
 *  triage) are the canonical class signal; the optional `[class:X]`
 *  token overrides when present. */
export const EMOJI_CLASS_TABLE: ReadonlyMap<string, BlockerClass> = new Map([
  ["🔵", "decision-pending"],
  ["⏳", "review-pending"],
  ["📤", "stale-claim"],
  ["🛠️", "tooling-broken"],
  ["🛠", "tooling-broken"],
  ["🚫", "push-policy-gate"],
  ["🔁", "cross-lane-WIP"],
]);

// ---------- Row shape ----------

export interface BlockerRow {
  /** Surface-prefixed for cross-surface uniqueness — `task:t-abc`,
   *  `complaint:c-xyz`, `decision:d-...`, `flag:f-...`, `merger:<branch>`,
   *  `inbox:<line-hash>`. */
  id: string;
  source: BlockerSource;
  /** Epoch seconds at the surface's "this thing started blocking"
   *  signal — task.created_at for blocked tasks, complaint.opened_at,
   *  merger.transitioned_at, parsed `[HH:MM MYT]` for markdown. When
   *  the markdown timestamp can't be parsed: 0 (surface-still-listed
   *  but `age_sec` reads "unknown" downstream). */
  opened_at: number;
  /** `nowSec - opened_at`, capped at 0 (negative would mean clock
   *  skew — treat as just-opened). 0 when `opened_at === 0`. */
  age_sec: number;
  /** ≤120-char one-line summary. Long bodies truncated with a trailing
   *  `…` so table rendering stays single-row. */
  summary: string;
  blocker_class: BlockerClass;
  /** Imperative one-liner the unblocker (or operator) can act on
   *  directly. ≤200 chars. */
  suggested_action: string;
  /** Populated when the surface ties to a kanban task (blocked tasks,
   *  flags with `task:` field, complaints with `related_task_id`). */
  related_task_id?: string;
}

// ---------- Helpers — taxonomy ----------

export function isBlockerClass(s: string): s is BlockerClass {
  return (BLOCKER_CLASSES as readonly string[]).includes(s);
}

export function isBlockerSource(s: string): s is BlockerSource {
  return (BLOCKER_SOURCES as readonly string[]).includes(s);
}

/** Truncate `s` to ≤`max` chars; appends `…` if cut. Whitespace squashed
 *  to single spaces so summaries don't break the table layout. */
export function truncate(s: string, max = 120): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

/** Compute `age_sec` with the cap-at-zero rule. */
function ageOf(openedAt: number, nowSec: number): number {
  if (openedAt <= 0) return 0;
  return Math.max(0, nowSec - openedAt);
}

/** Lift a `BlockerClass` from a leading-glyph or `[class:X]` token in
 *  free-form text per ADR-152 §Markdown class lifting. Returns `null`
 *  if no signal — caller falls back to a per-surface default. */
export function liftClassFromText(text: string): BlockerClass | null {
  const explicit = text.match(/\[class:([a-z-]+)\]/);
  if (explicit && isBlockerClass(explicit[1]!)) return explicit[1] as BlockerClass;
  const head = text.trim().slice(0, 4);
  for (const [glyph, cls] of EMOJI_CLASS_TABLE) {
    if (head.startsWith(glyph)) return cls;
  }
  return null;
}

// ---------- Surface 1: SQLite tasks (status=blocked) ----------

interface BlockedTaskRow {
  id: string;
  subject: string | null;
  body: string | null;
  owner: string | null;
  deps: string | null;
  created_at: number | null;
}

/** One row per `tasks.status='blocked'`. Class derivation: deps[]
 *  non-empty AND any dep not done → `dep-not-shipped`; else
 *  `member-stuck`. */
export function readBlockedTasks(db: Database, nowSec: number): BlockerRow[] {
  const rows = db
    .query("SELECT id, subject, body, owner, deps, created_at FROM tasks WHERE status = 'blocked'")
    .all() as BlockedTaskRow[];
  return rows.map((r) => {
    const deps: string[] = r.deps ? (JSON.parse(r.deps) as string[]) : [];
    const blockingDepIds = deps.length > 0 ? findUndoneDeps(db, deps) : [];
    const cls: BlockerClass = blockingDepIds.length > 0 ? "dep-not-shipped" : "member-stuck";
    const subject = r.subject ?? "(no subject)";
    const summary = truncate(`${r.id} ${subject}`);
    const action =
      cls === "dep-not-shipped"
        ? `Land or remove deps: ${blockingDepIds.join(", ")} (then \`atmux task move ${r.id} todo\`)`
        : `Re-claim or re-route: \`atmux task show ${r.id}\` then \`atmux task move ${r.id} todo\` once unblocked`;
    return {
      id: `task:${r.id}`,
      source: "sqlite-tasks-blocked",
      opened_at: r.created_at ?? 0,
      age_sec: ageOf(r.created_at ?? 0, nowSec),
      summary,
      blocker_class: cls,
      suggested_action: truncate(action, 200),
      related_task_id: r.id,
    };
  });
}

/** Inner: which of `depIds` are NOT in `tasks` with status='done'. Used
 *  to classify `blocked → dep-not-shipped` vs `blocked → member-stuck`. */
function findUndoneDeps(db: Database, depIds: readonly string[]): string[] {
  if (depIds.length === 0) return [];
  const placeholders = depIds.map(() => "?").join(",");
  const rows = db
    .query(`SELECT id FROM tasks WHERE id IN (${placeholders}) AND status = 'done'`)
    .all(...depIds) as { id: string }[];
  const done = new Set(rows.map((r) => r.id));
  return depIds.filter((d) => !done.has(d));
}

// ---------- Surface 2: SQLite tasks (in-progress past staleAge) ----------

interface InProgressRow {
  id: string;
  subject: string | null;
  owner: string | null;
  claimed_at: number | null;
  stale_min: number | null;
}

/** One row per `tasks.status='in-progress'` whose claim has aged past
 *  the per-task `stale_min` (or `defaultStaleClaimAgeSec` fallback).
 *  Class is always `stale-claim`; suggested action is rotate-or-handoff. */
export function readStaleInProgressTasks(
  db: Database,
  nowSec: number,
  defaultStaleClaimAgeSec: number,
): BlockerRow[] {
  const rows = db
    .query(
      "SELECT id, subject, owner, claimed_at, stale_min FROM tasks WHERE status = 'in-progress'",
    )
    .all() as InProgressRow[];
  const out: BlockerRow[] = [];
  for (const r of rows) {
    const claimed = r.claimed_at ?? 0;
    if (claimed === 0) continue;
    const staleSec = r.stale_min !== null ? r.stale_min * 60 : defaultStaleClaimAgeSec;
    const age = nowSec - claimed;
    if (age < staleSec) continue;
    const owner = r.owner ?? "(unowned)";
    const subject = r.subject ?? "(no subject)";
    const summary = truncate(`${r.id} owner=${owner} ${subject}`);
    out.push({
      id: `task-stale:${r.id}`,
      source: "sqlite-tasks-stale",
      opened_at: claimed,
      age_sec: age,
      summary,
      blocker_class: "stale-claim",
      suggested_action: truncate(
        `Member ${owner} stale on ${r.id} for ${Math.floor(age / 3600)}h — \`atmux handoff ${owner} <fresh-member>\` or \`atmux rotate ${owner}\``,
        200,
      ),
      related_task_id: r.id,
    });
  }
  return out;
}

// ---------- Surface 3: SQLite complaints (status=open) ----------

interface OpenComplaintRow {
  id: string;
  opened_at: number;
  incident_summary: string;
  source_kind: string | null;
  related_task_id: string | null;
  extra: string | null;
}

/** One row per `complaints.status='open'`. Class default is
 *  `tooling-broken`; lift from `extra.blocker_class` when present
 *  (forward-compat — schema doesn't enforce it yet). */
export function readOpenComplaints(db: Database, nowSec: number): BlockerRow[] {
  const rows = db
    .query(
      "SELECT id, opened_at, incident_summary, source_kind, related_task_id, extra FROM complaints WHERE status = 'open'",
    )
    .all() as OpenComplaintRow[];
  return rows.map((r): BlockerRow => {
    const extra = r.extra ? (JSON.parse(r.extra) as Record<string, unknown>) : {};
    const liftedClass =
      typeof extra.blocker_class === "string" && isBlockerClass(extra.blocker_class)
        ? (extra.blocker_class as BlockerClass)
        : null;
    const cls: BlockerClass = liftedClass ?? "tooling-broken";
    const kind = r.source_kind ?? "?";
    const summary = truncate(`${r.id} [${kind}] ${r.incident_summary}`);
    const action = `Triage + resolve: \`atmux complaints resolve ${r.id} --status resolved --note "<resolution>"\``;
    const base: BlockerRow = {
      id: `complaint:${r.id}`,
      source: "sqlite-complaints",
      opened_at: r.opened_at,
      age_sec: ageOf(r.opened_at, nowSec),
      summary,
      blocker_class: cls,
      suggested_action: truncate(action, 200),
    };
    return r.related_task_id ? { ...base, related_task_id: r.related_task_id } : base;
  });
}

// ---------- Surface 4: SQLite merger_state (state in conflict|reverted) ----------

interface MergerStateBlockerRow {
  member_branch: string;
  state: string;
  note: string | null;
  transitioned_at: number;
  conflict_sha: string | null;
}

/** One row per `merger_state` entry stuck at `conflict` or `reverted`.
 *  Class: `tooling-broken` for conflict (operator-fix-required),
 *  `push-policy-gate` for reverted (test-fail-revert per ADR-134
 *  §revertOnFail). */
export function readStuckMergerState(db: Database, nowSec: number): BlockerRow[] {
  const rows = db
    .query(
      "SELECT member_branch, state, note, transitioned_at, conflict_sha FROM merger_state WHERE state IN ('conflict','reverted')",
    )
    .all() as MergerStateBlockerRow[];
  return rows.map((r) => {
    const cls: BlockerClass = r.state === "reverted" ? "push-policy-gate" : "tooling-broken";
    const sha = r.conflict_sha ? ` @${r.conflict_sha.slice(0, 8)}` : "";
    const noteSuffix = r.note ? ` — ${r.note}` : "";
    const summary = truncate(`${r.member_branch} ${r.state}${sha}${noteSuffix}`);
    const action =
      r.state === "conflict"
        ? `Resolve conflict on \`${r.member_branch}\` then \`atmux committer --sweep\` to retry merge`
        : `Investigate revert on \`${r.member_branch}\` (test failed); fix + re-claim or set \`autoMerge.revertOnFail=false\` for manual recovery`;
    return {
      id: `merger:${r.member_branch}`,
      source: "sqlite-merger-state",
      opened_at: r.transitioned_at,
      age_sec: ageOf(r.transitioned_at, nowSec),
      summary,
      blocker_class: cls,
      suggested_action: truncate(action, 200),
    };
  });
}

// ---------- Markdown surfaces — shared parser primitives ----------

/** Parse `HH:MM MYT` (24h) → epoch seconds *for today* anchored on
 *  Asia/Kuala_Lumpur (UTC+8). When `nowSec` resolves to "the same date"
 *  the markdown's HH:MM is interpreted as today; otherwise we surface
 *  the entry with `opened_at: 0` so callers can degrade gracefully. The
 *  driver-inbox / decisions / flags markdown convention strips the date
 *  via per-day section headers; this matches the conservative path of
 *  the existing parsers in `src/core/driver-inbox.ts`. */
export function parseMytTimestampHHMM(hhmm: string, nowSec: number): number {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 0;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return 0;
  const nowMs = nowSec * 1000;
  const mytNow = new Date(nowMs + 8 * 3600 * 1000);
  const y = mytNow.getUTCFullYear();
  const mo = mytNow.getUTCMonth();
  const d = mytNow.getUTCDate();
  const utcMs = Date.UTC(y, mo, d, hh - 8, mm, 0);
  return Math.floor(utcMs / 1000);
}

// ---------- Surface 5: .atmux/decisions.md (🔵 / pending) ----------

/** Parse decisions.md sections of shape `### d-XXXXXXXX — <question> [hi|med|low] (HH:MM MYT)`
 *  with a `- **decided-by**: <member>` line. Pending decisions are those
 *  WITHOUT a `~~strikethrough~~` heading marker — same convention as the
 *  existing decisions verb. Default class is `decision-pending`. */
export async function readPendingDecisionsMd(
  atmuxDir: string,
  nowSec: number,
): Promise<BlockerRow[]> {
  const text = await readTextOrNull(decisionsLogPath(atmuxDir));
  if (!text) return [];
  const out: BlockerRow[] = [];
  const headerRe = /^### (d-[0-9a-f]+) — (.+?) \((\d{1,2}:\d{2}) MYT\)$/gm;
  for (const match of text.matchAll(headerRe)) {
    const [headLine, id, question, hhmm] = match;
    if (headLine.includes("~~")) continue;
    const opened = parseMytTimestampHHMM(hhmm!, nowSec);
    const summary = truncate(`${id} ${question}`);
    out.push({
      id: `decision:${id}`,
      source: "md-decisions",
      opened_at: opened,
      age_sec: ageOf(opened, nowSec),
      summary,
      blocker_class: "decision-pending",
      suggested_action: truncate(
        `Reply to override or accept: \`atmux send lead "override ${id}: <choice>"\` (or accept the recommended default)`,
        200,
      ),
    });
  }
  return out;
}

// ---------- Surface 6: .atmux/flags.md (open) ----------

/** Parse flags.md `### f-XXXXXXXX <member> [pN/<needs>] (HH:MM MYT)`
 *  headers, plus `### r-XXXXXXXX f-YYYYYYYY` resolution headers. A flag
 *  is OPEN iff no resolution row references its id. Class lifted from
 *  `**needs**: <decision|unblock|context>` → decision-pending /
 *  member-stuck / member-stuck respectively (member-stuck for context
 *  too — context-needed implies the member is wedged waiting). */
export async function readOpenFlagsMd(atmuxDir: string, nowSec: number): Promise<BlockerRow[]> {
  const path = atmuxDir.endsWith("/") ? `${atmuxDir}flags.md` : `${atmuxDir}/flags.md`;
  const text = await readTextOrNull(path);
  if (!text) return [];

  const resolved = new Set<string>();
  const resolveRe = /^### r-[0-9a-f]+ (f-[0-9a-f]+)/gm;
  for (const rMatch of text.matchAll(resolveRe)) {
    resolved.add(rMatch[1]!);
  }

  const out: BlockerRow[] = [];
  // Two-pass parse — find flag-header positions first, then slice the
  // body between adjacent `### ` headers (any `### ` boundary, not
  // just `### f-`). Avoids the `\n*$` over-match footgun that bites
  // single-regex `m`-flag lookahead bodies.
  const flagHeaderRe =
    /^### (f-[0-9a-f]+) (\S+) \[(p[0-9])\/(decision|unblock|context)\] \((\d{1,2}:\d{2}) MYT\)$/gm;
  const allHeaderRe = /^### /gm;
  const allHeaderPositions: number[] = [];
  for (const aMatch of text.matchAll(allHeaderRe)) {
    allHeaderPositions.push(aMatch.index);
  }
  const flagPositions: {
    start: number;
    end: number;
    id: string;
    member: string;
    severity: string;
    needs: string;
    hhmm: string;
    matchEnd: number;
  }[] = [];
  for (const fHeaderMatch of text.matchAll(flagHeaderRe)) {
    const [, id, member, severity, needs, hhmm] = fHeaderMatch;
    flagPositions.push({
      start: fHeaderMatch.index,
      end: 0,
      id: id!,
      member: member!,
      severity: severity!,
      needs: needs!,
      hhmm: hhmm!,
      matchEnd: fHeaderMatch.index + fHeaderMatch[0].length,
    });
  }
  for (const fp of flagPositions) {
    const next = allHeaderPositions.find((p) => p > fp.start);
    fp.end = next ?? text.length;
  }
  for (const fp of flagPositions) {
    const id = fp.id;
    const member = fp.member;
    const severity = fp.severity;
    const needs = fp.needs;
    const hhmm = fp.hhmm;
    const body = text.slice(fp.matchEnd, fp.end);
    if (resolved.has(id!)) continue;
    const cls: BlockerClass = needs === "decision" ? "decision-pending" : "member-stuck";
    const opened = parseMytTimestampHHMM(hhmm!, nowSec);
    const messageMatch = body!.match(/\*\*message\*\*: (.+)/);
    const message = messageMatch ? messageMatch[1]! : "(no message)";
    const taskMatch = body!.match(/\*\*task\*\*: (t-[0-9a-f]+)/);
    const summary = truncate(`${id} ${member} [${severity}/${needs}] ${message}`);
    const flagRow: BlockerRow = {
      id: `flag:${id}`,
      source: "md-flags",
      opened_at: opened,
      age_sec: ageOf(opened, nowSec),
      summary,
      blocker_class: cls,
      suggested_action: truncate(
        needs === "decision"
          ? `Decide + resolve: \`atmux send lead "<decision>"\` then resolve flag ${id}`
          : `Unblock ${member}: investigate the ${needs}-need then resolve flag ${id}`,
        200,
      ),
    };
    out.push(taskMatch ? { ...flagRow, related_task_id: taskMatch[1]! } : flagRow);
  }
  return out;
}

// ---------- Surface 7: .atmux/driver-inbox.md (⏳ / 🔵 / un-triaged stale) ----------

/** Walk driver-inbox.md entries; surface those whose first body line
 *  carries a leading triage glyph in {🔵, ⏳, 📤} OR is past
 *  `staleInboxAgeSec` without ANY closure glyph (✅ / ❌). Class lift
 *  from leading glyph; default for stale-untriaged is `stale-claim`.
 *
 *  Entry format per `src/core/driver-inbox.ts`:
 *    section-style: `## HH:MM MYT — <header>` ... body ...
 *    bullet-style:  `- [HH:MM MYT] <body>`
 *  We surface section-style entries (the typical multi-line driver ask
 *  shape); bullet-style entries are out of scope here — they're already
 *  surfaced by `atmux driver-inbox` and rarely block. */
export async function readDriverInboxBlockers(
  atmuxDir: string,
  nowSec: number,
  staleInboxAgeSec: number,
): Promise<BlockerRow[]> {
  const text = await readTextOrNull(driverInboxPath(atmuxDir));
  if (!text) return [];
  const out: BlockerRow[] = [];
  // Find every `## HH:MM MYT — header` line; slice the body between
  // adjacent header positions. Cleaner than one mega-regex with `m`-flag
  // lookaheads (which over-match `\n*$` at every line position).
  const headerRe = /^## (\d{1,2}:\d{2}) MYT — (.+?)$/gm;
  const headers: { hhmm: string; header: string; headerStart: number; headerEnd: number }[] = [];
  for (const hMatch of text.matchAll(headerRe)) {
    headers.push({
      hhmm: hMatch[1]!,
      header: hMatch[2]!,
      headerStart: hMatch.index,
      headerEnd: hMatch.index + hMatch[0].length,
    });
  }
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]!;
    const bodyEnd = i + 1 < headers.length ? headers[i + 1]!.headerStart : text.length;
    const body = text.slice(h.headerEnd, bodyEnd);
    const hhmm = h.hhmm;
    const header = h.header;
    const triage = liftClassFromText(body ?? "");
    const opened = parseMytTimestampHHMM(hhmm!, nowSec);
    const age = ageOf(opened, nowSec);

    let cls: BlockerClass;
    if (triage !== null) {
      cls = triage;
    } else if (opened > 0 && age >= staleInboxAgeSec) {
      cls = "stale-claim";
    } else {
      continue;
    }

    if (/[✅❌]/.test(body ?? "")) continue;

    const summary = truncate(`driver-inbox @${hhmm} ${header}`);
    out.push({
      id: `inbox:${hhmm}-${(header ?? "").slice(0, 16)}`,
      source: "md-driver-inbox",
      opened_at: opened,
      age_sec: age,
      summary,
      blocker_class: cls,
      suggested_action: truncate(
        cls === "decision-pending"
          ? `Lead: triage in driver-inbox.md (✅/📤/⏳) + reply via \`atmux send lead\` thread`
          : `Lead: triage stale entry in driver-inbox.md (acknowledge or archive)`,
        200,
      ),
    });
  }
  return out;
}

// ---------- Top-level fan-out ----------

export interface QueryAllBlockersOpts {
  /** Override `Math.floor(Date.now()/1000)` for tests. */
  nowSec?: number;
  /** Default fallback when `tasks.stale_min` is null. 24h. */
  defaultStaleClaimAgeSec?: number;
  /** Driver-inbox entries past this age without triage glyphs are
   *  treated as `stale-claim` blockers. 24h. */
  staleInboxAgeSec?: number;
}

/** ADR-152 §queryAllBlockers — the verb-facing fan-out. Joins seven
 *  surfaces; returns rows in stable insertion order (SQLite first
 *  per surface; markdown last). Caller filters/sorts as needed. */
export async function queryAllBlockers(
  atmuxDir: string,
  db: Database,
  opts: QueryAllBlockersOpts = {},
): Promise<BlockerRow[]> {
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const staleClaim = opts.defaultStaleClaimAgeSec ?? 24 * 3600;
  const staleInbox = opts.staleInboxAgeSec ?? 24 * 3600;

  const rows: BlockerRow[] = [];
  rows.push(...readBlockedTasks(db, now));
  rows.push(...readStaleInProgressTasks(db, now, staleClaim));
  rows.push(...readOpenComplaints(db, now));
  rows.push(...readStuckMergerState(db, now));
  rows.push(...(await readPendingDecisionsMd(atmuxDir, now)));
  rows.push(...(await readOpenFlagsMd(atmuxDir, now)));
  rows.push(...(await readDriverInboxBlockers(atmuxDir, now, staleInbox)));
  return rows;
}
