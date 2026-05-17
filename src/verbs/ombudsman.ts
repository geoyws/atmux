// ADR-147 §D2 / §D3 / §D4: ombudsman verb — complaint adjudicator.
//
// Sub-verbs:
//
//   atmux ombudsman tick [--team-dir <path>]
//       — cron-fired wake. Fast no-op when the sentinel is empty;
//         when non-empty, wakes the ombudsman pane via verified
//         send-keys (ADR-138) with `atmux ombudsman work`.
//
//   atmux ombudsman work [--id <c-id> --action <act> [--related-task <t-id>]
//                         [--note <text>]] [--team-dir <path>] [--json]
//       — without `--id`: prints the pending sentinel + open complaints
//         as JSON for the LLM-side ombudsman to read.
//       — with `--id` + `--action`: ATOMIC adjudication step — append
//         the release-notes entry, resolve the complaint (or leave open
//         for `defer`), remove from sentinel. The LLM calls `work
//         --id X --action Y` once per complaint after deciding.
//
//   atmux ombudsman index [--team-dir <path>]
//       — regenerates `docs/release-notes/README.md` TOC (recent-30
//         days). Stubbed to a single-line no-op message in T1; full
//         impl lands in T8 alongside the hygiene-tick integration.
//
// Authority gate: this verb is a write-path for the ombudsman role +
// the cron tick that wakes it. No member-claim semantics — the verb
// is invoked directly by the cron line + the LLM-side pane.
//
// **Release-notes integration note** (per ADR-147 §D4 + T5): the
// canonical `appendSection(epochMs, section, entry, opts)` writer
// ships in `src/abstractions/release-notes.ts` (T5; sibling-branch
// commit 75b8647 on `geoyws-up-impl-2`). T5 is not yet on this branch,
// so T1 inlines a minimal `appendComplaintAdjudication` helper
// (skeleton-create-on-miss + insert-at-section-tail) covering only
// the `## Complaints adjudicated` write. When T5 lands via the next
// trunk-sweep merge, this inline helper is replaced by a call into
// `appendSection`; the interface stays stable (`epochMs` + entry text
// + repo root) so the swap is mechanical, no contract change.

import { join } from "node:path";
import { z } from "zod";
import { ensureDir, exists, readText, writeText } from "../abstractions/fs.ts";
import { withLock } from "../abstractions/lock.ts";
import { closeDatabase, openDatabase } from "../abstractions/sqlite.ts";
import { migrations } from "../abstractions/sqlite-migrations.ts";
import { now } from "../abstractions/time.ts";
import { createTmux, type TmuxNamespace } from "../abstractions/tmux.ts";
import {
  buildWindowName,
  getAtmuxDir,
  getSessionName,
  type ResolveDirOpts,
  requireTeam,
  resolveTeamSocket,
} from "../core/common.ts";
import {
  isSentinelEmpty,
  readSentinel,
  removeFromSentinel,
  sentinelPath,
} from "../core/ombudsman.ts";
import { type CaptureFn, classifyText } from "../core/pane-state.ts";
import { ComplaintsRepo } from "../core/repositories/complaints-repo.ts";
import {
  type AppendLogFn,
  composerEmpty,
  type SendKeysFn,
  safeSendKeysWithVerify,
} from "../core/safe-send.ts";
import { UsageError } from "../errors.ts";
import type { Team, TeamMember } from "../schema/team.ts";

const USAGE =
  "atmux ombudsman {tick | work [--id <c-id> --action <epic|task|wontfix|already-addressed|defer> " +
  "[--related-task <t-id>] [--note <text>] [--json]] | index} [--team-dir <path>]";

// ---------- Action vocabulary ----------

/** The five adjudication actions per ADR-147 §D3. Values double as
 *  display labels in release-notes entries. */
export const OMBUDSMAN_ACTIONS = ["epic", "task", "wontfix", "already-addressed", "defer"] as const;
export type OmbudsmanAction = (typeof OMBUDSMAN_ACTIONS)[number];

/** Map each action to its terminal complaint status. `defer` leaves
 *  the complaint open (returns null). */
export function statusForAction(action: OmbudsmanAction): "resolved" | "wontfix" | null {
  switch (action) {
    case "epic":
    case "task":
    case "already-addressed":
      return "resolved";
    case "wontfix":
      return "wontfix";
    case "defer":
      return null;
  }
}

/** Bold-label rendered inside the release-notes entry. Verbose-friendly
 *  (`filed epic` instead of `epic`) per the brief's example formatting. */
export function actionLabel(action: OmbudsmanAction, relatedTask: string | null): string {
  switch (action) {
    case "epic":
      return relatedTask !== null ? `filed epic ${relatedTask}` : "filed epic";
    case "task":
      return relatedTask !== null ? `filed task ${relatedTask}` : "filed task";
    case "wontfix":
      return "wontfix";
    case "already-addressed":
      return "already addressed";
    case "defer":
      return "deferred";
  }
}

// ---------- Arg parsing ----------

export interface ParsedOmbudsmanArgs {
  subverb: "tick" | "work" | "index";
  /** work --id */
  id?: string;
  /** work --action */
  action?: OmbudsmanAction;
  /** work --related-task */
  relatedTask?: string;
  /** work --note */
  note?: string;
  /** work --json (bare work mode — list complaints as JSON) */
  json?: boolean;
  /** --team-dir override (test injection / cron use) */
  teamDir?: string;
}

export function parseOmbudsmanArgs(argv: ReadonlyArray<string>): ParsedOmbudsmanArgs {
  if (argv.length === 0) {
    throw new UsageError({ what: "ombudsman: missing sub-verb", hint: USAGE });
  }
  const sub = argv[0];
  if (sub !== "tick" && sub !== "work" && sub !== "index") {
    throw new UsageError({
      what: `ombudsman: unknown sub-verb: ${sub ?? ""}`,
      hint: USAGE,
    });
  }
  const out: ParsedOmbudsmanArgs = { subverb: sub };
  const need = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined) {
      throw new UsageError({
        what: `ombudsman ${sub}: ${flag} requires a value`,
        hint: USAGE,
      });
    }
    return v;
  };

  for (let i = 1; i < argv.length; ) {
    const a = argv[i];
    switch (a) {
      case "--id":
        out.id = need(i, "--id");
        i += 2;
        break;
      case "--action": {
        const v = need(i, "--action");
        if (!OMBUDSMAN_ACTIONS.includes(v as OmbudsmanAction)) {
          throw new UsageError({
            what: `ombudsman ${sub}: --action must be one of ${OMBUDSMAN_ACTIONS.join("|")} (got: ${v})`,
            hint: USAGE,
          });
        }
        out.action = v as OmbudsmanAction;
        i += 2;
        break;
      }
      case "--related-task":
        out.relatedTask = need(i, "--related-task");
        i += 2;
        break;
      case "--note":
        out.note = need(i, "--note");
        i += 2;
        break;
      case "--json":
        out.json = true;
        i += 1;
        break;
      case "--team-dir":
        out.teamDir = need(i, "--team-dir");
        i += 2;
        break;
      default:
        throw new UsageError({
          what: `ombudsman ${sub}: unknown arg: ${a ?? ""}`,
          hint: USAGE,
        });
    }
  }

  if (sub === "work" && out.id !== undefined) {
    if (out.action === undefined) {
      throw new UsageError({
        what: "ombudsman work: --action is required when --id is set",
        hint: USAGE,
      });
    }
    if ((out.action === "epic" || out.action === "task") && out.relatedTask === undefined) {
      throw new UsageError({
        what: `ombudsman work: --related-task is required for --action ${out.action}`,
        hint: USAGE,
      });
    }
  }

  return out;
}

// ---------- Verb entry ----------

/** Top-level dispatch. Returns a process exit code. */
export async function ombudsman(
  argv: ReadonlyArray<string>,
  deps: OmbudsmanDeps = {},
): Promise<number> {
  const parsed = parseOmbudsmanArgs(argv);
  switch (parsed.subverb) {
    case "tick":
      return await ombudsmanTick(parsed, deps);
    case "work":
      return await ombudsmanWork(parsed, deps);
    case "index":
      return await ombudsmanIndex(parsed, deps);
  }
}

/** Test-injectable deps. Defaults wire real `createTmux` +
 *  `safeSendKeysWithVerify` + the live filesystem. */
export interface OmbudsmanDeps {
  /** tmux namespace. Default: built per-call against the team's
   *  socket. Tests inject a fixture to avoid touching tmux. */
  tmux?: TmuxNamespace;
  /** Pane capture wrapper. Default: tmux.pane.capturePane. */
  capture?: CaptureFn;
  /** Send-keys wrapper. Default: tmux.pane.sendKeys. */
  sendKeys?: SendKeysFn;
  /** Append-log wrapper for safeSendKeysWithVerify escalation. */
  appendLog?: AppendLogFn;
  /** Logger for tick / work outcomes. Default: stderr line writes. */
  log?: (msg: string) => void;
  /** Clock for release-notes day-file path resolution. Default:
   *  abstractions/time.ts::now(). */
  now?: () => number;
  /** Override the repo root for release-notes path resolution. Default:
   *  walk up from `atmuxDir` to find the git root (.git presence). */
  repoRoot?: string;
}

// ---------- tick ----------

async function ombudsmanTick(parsed: ParsedOmbudsmanArgs, deps: OmbudsmanDeps): Promise<number> {
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const team = await requireTeam(dirOpts);
  const atmuxDir = await getAtmuxDir(dirOpts);
  const log = deps.log ?? defaultLog;

  // Fast path: sentinel empty → no-op exit 0. ADR-147 §D2 — cron tick
  // overhead is minimised because this is the common case.
  if (await isSentinelEmpty(atmuxDir)) {
    log(`ombudsman tick: sentinel empty — no-op`);
    return 0;
  }

  // Sentinel non-empty: locate the ombudsman pane + send-keys
  // `atmux ombudsman work` with verified-send-keys (ADR-138).
  const member = findOmbudsmanMember(team);
  if (member === null) {
    log(
      `ombudsman tick: sentinel non-empty but team has no role=ombudsman member — ` +
        `cron line shouldn't have fired; check team.ombudsman.enabled + member roster`,
    );
    return 0;
  }

  const session = await getSessionName({ ...dirOpts, team });
  const windowTarget = `${session}:${buildWindowName(member.name, member.emoji, member.label, member.role)}`;

  // Resolve tmux + send-keys deps. Test injection bypasses the real
  // tmux entirely; production wires the real socket-pinned namespace.
  let capture: CaptureFn;
  let sendKeys: SendKeysFn;
  if (deps.capture !== undefined && deps.sendKeys !== undefined) {
    capture = deps.capture;
    sendKeys = deps.sendKeys;
  } else {
    const tmux = deps.tmux ?? createTmux({ socketPath: resolveTeamSocket(team) });
    capture = async (target: string) => await tmux.pane.capturePane({ target, start: -30 });
    sendKeys = async (target: string, text: string, opts) =>
      await tmux.pane.sendKeys({
        target: {
          kind: "member",
          member: member.name,
          team: team.name,
          target,
        },
        keys: text,
        enter: opts?.enter !== false,
      });
  }

  // Verified send-keys per ADR-138: prove the agent picked up the
  // prompt (composer cleared) before declaring the wake successful.
  const result = await safeSendKeysWithVerify({
    target: windowTarget,
    keys: "atmux ombudsman work",
    expectVerifier: composerEmpty(),
    capture,
    sendKeys,
    ...(deps.appendLog !== undefined ? { appendLog: deps.appendLog } : {}),
    log: (m) => log(`ombudsman tick: ${m}`),
  });

  if (result.success) {
    log(
      `ombudsman tick: woke ${member.name} pane (attempts=${result.attempts}) ` +
        `— work injection verified`,
    );
    return 0;
  }
  log(
    `ombudsman tick: failed to wake ${member.name} pane after ${result.attempts} ` +
      `attempts — escalated to send-keys-failures.log`,
  );
  // Exit 0 even on escalation — the cron line shouldn't fail the
  // crontab. The escalation log is the durable surface.
  return 0;
}

// ---------- work ----------

async function ombudsmanWork(parsed: ParsedOmbudsmanArgs, deps: OmbudsmanDeps): Promise<number> {
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  await requireTeam(dirOpts);
  const atmuxDir = await getAtmuxDir(dirOpts);
  const log = deps.log ?? defaultLog;

  // Bare `work` (no --id): print pending complaints as JSON / table for
  // the LLM-side ombudsman to read. The LLM then runs one `work --id X
  // --action Y` per complaint after deciding.
  if (parsed.id === undefined) {
    return await listPendingComplaints(atmuxDir, parsed.json === true);
  }

  // --id present → atomic adjudication step. parseOmbudsmanArgs already
  // enforced that --action is set + --related-task is set when needed.
  const action = parsed.action!;
  const cId = parsed.id;
  const relatedTask = parsed.relatedTask ?? null;
  const note = parsed.note ?? null;

  const db = openDatabase(stateDbPath(atmuxDir), migrations);
  try {
    const repo = new ComplaintsRepo(db);
    const existing = repo.getById(cId);
    if (existing === null) {
      process.stderr.write(`atmux: ombudsman work: no such complaint: ${cId}\n`);
      return 1;
    }
    // Append release-notes entry FIRST — the durable response log per
    // §D4. Resolving the complaint before the write would leave a
    // resolved row with no audit trail if the release-notes write
    // crashed; the inverse failure (release-notes entry but complaint
    // still open) is recoverable via the operator (or the next tick
    // surfacing the still-open id).
    const repoRoot = deps.repoRoot ?? (await resolveRepoRoot(atmuxDir));
    const epochMs = (deps.now ?? now)();
    await appendComplaintAdjudication(repoRoot, epochMs, {
      complaintId: cId,
      action,
      relatedTask,
      note,
      summary: existing.incidentSummary,
    });

    // Flip the complaint row (skipped for `defer` — leave open).
    const terminalStatus = statusForAction(action);
    if (terminalStatus !== null) {
      const ok = repo.resolve({
        id: cId,
        status: terminalStatus,
        resolvedAt: Math.floor(epochMs / 1000),
        resolvedBy: "ombudsman",
        note: note ?? null,
        relatedTaskId: relatedTask,
      });
      if (!ok) {
        // Race: row vanished between getById + resolve. Surface but
        // don't fail loudly; the release-notes entry already landed.
        log(`ombudsman work: complaint ${cId} vanished between read + resolve`);
      }
    }

    // Sentinel update: clear unless `defer`. ADR-147 §D3 — defer leaves
    // the id in the sentinel so the next tick re-attempts.
    if (action !== "defer") {
      await removeFromSentinel(atmuxDir, cId);
    }

    log(
      `ombudsman work: ${cId} → ${actionLabel(action, relatedTask)}` +
        (note !== null ? ` (note: ${note})` : ""),
    );
    process.stdout.write(`${cId} → ${actionLabel(action, relatedTask)}\n`);
    return 0;
  } finally {
    closeDatabase(db);
  }
}

async function listPendingComplaints(atmuxDir: string, asJson: boolean): Promise<number> {
  const sentinel = await readSentinel(atmuxDir);
  const db = openDatabase(stateDbPath(atmuxDir), migrations);
  try {
    const repo = new ComplaintsRepo(db);
    const pendingComplaints = sentinel.pending
      .map((id) => repo.getById(id))
      .filter((c): c is NonNullable<typeof c> => c !== null && c.status === "open");

    if (asJson) {
      process.stdout.write(
        `${JSON.stringify(
          {
            sentinel: sentinel.pending,
            pending: pendingComplaints,
            sentinelPath: sentinelPath(atmuxDir),
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }

    if (pendingComplaints.length === 0) {
      process.stdout.write(`(no pending complaints in sentinel)\n`);
      return 0;
    }
    process.stdout.write(
      `📋 ombudsman work — ${pendingComplaints.length} pending complaint(s)\n\n`,
    );
    for (const c of pendingComplaints) {
      process.stdout.write(`🔴 ${c.id}  ${c.incidentSummary}\n`);
      if (c.rootCause !== null && c.rootCause.length > 0) {
        process.stdout.write(`    🔍 root cause: ${c.rootCause}\n`);
      }
      if (c.preventiveAsk !== null && c.preventiveAsk.length > 0) {
        process.stdout.write(`    🙏 preventive ask: ${c.preventiveAsk}\n`);
      }
      if (c.sourceKind !== null) {
        process.stdout.write(`    🎯 source: ${c.sourceKind}\n`);
      }
      process.stdout.write("\n");
    }
    return 0;
  } finally {
    closeDatabase(db);
  }
}

// ---------- index ----------

async function ombudsmanIndex(_parsed: ParsedOmbudsmanArgs, _deps: OmbudsmanDeps): Promise<number> {
  // T8 ships the full hygiene-tick / gitter integration that regenerates
  // the README.md TOC alongside `## Shipped` + `## Merges` + `## ADRs
  // landed` writers. T1's `index` is a labelled no-op so the verb-table
  // exposes the surface; once T8 lands, the impl swaps in.
  process.stdout.write(
    `atmux ombudsman index: TOC regeneration deferred to ADR-147 T8 (hygiene-tick / gitter integration)\n`,
  );
  return 0;
}

// ---------- Helpers ----------

function findOmbudsmanMember(team: Team): TeamMember | null {
  for (const m of team.members) {
    if (m.role === "ombudsman") return m;
  }
  return null;
}

function stateDbPath(atmuxDir: string): string {
  return join(atmuxDir, "state.db");
}

/** Walk up from `atmuxDir` until a `.git` directory is found; that's the
 *  repo root. Falls back to `atmuxDir`'s parent if no `.git` is found
 *  (e.g. test fixtures running outside a real git repo). */
async function resolveRepoRoot(atmuxDir: string): Promise<string> {
  // atmuxDir is typically `<repoRoot>/.atmux`; the parent is the candidate.
  // But submodule + worktree cases (e.g. `<repoRoot>/.atmux/worktrees/X`)
  // need the walk to find the right .git.
  let cur = atmuxDir;
  while (true) {
    const candidate = join(cur, ".git");
    if (await exists(candidate)) return cur;
    const parent = join(cur, "..");
    const parentResolved = await resolvePath(parent);
    if (parentResolved === cur) break;
    cur = parentResolved;
  }
  // Fallback: atmuxDir's immediate parent.
  return await resolvePath(join(atmuxDir, ".."));
}

async function resolvePath(p: string): Promise<string> {
  const { resolve } = await import("node:path");
  return resolve(p);
}

function defaultLog(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

// ---------- Release-notes append (T1 inline; T5 swaps in) ----------

/** Per-entry input to {@link appendComplaintAdjudication}. */
export interface ComplaintAdjudicationEntry {
  complaintId: string;
  action: OmbudsmanAction;
  relatedTask: string | null;
  note: string | null;
  summary: string;
}

/** MYT-anchored day path resolver. Local to this module until T5's
 *  `resolveDayFilePath` lands on this branch via the next trunk-sweep
 *  merge. Pure — no IO. */
export function resolveDayFilePath(repoRoot: string, epochMs: number): string {
  const d = new Date(epochMs);
  // Pull year/month/day in MYT via the same Intl.DateTimeFormat shape
  // T5 uses. en-CA locale gives ISO-ish YYYY-MM-DD output.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  const year = get("year");
  const month = get("month");
  const day = get("day");
  return join(repoRoot, "docs", "release-notes", year, month, `${year}-${month}-${day}.md`);
}

/** Skeleton for a fresh day-file per ADR-147 §D4. Sections are
 *  append-only by their respective owners (gitter, hygiene-tick,
 *  ombudsman, medic, operator). */
function dayFileSkeleton(epochMs: number): string {
  const d = new Date(epochMs);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  const isoDate = `${get("year")}-${get("month")}-${get("day")}`;
  return [
    `# ${isoDate}`,
    "",
    "## Shipped (kanban→done)",
    "",
    "## Merges (branch→trunk)",
    "",
    "## ADRs landed",
    "",
    "## Complaints adjudicated",
    "",
    "## Doctor regressions",
    "",
    "## Notes",
    "",
  ].join("\n");
}

const COMPLAINTS_SECTION_HEADER = "## Complaints adjudicated";

/**
 * Append one adjudication entry to the day's `## Complaints adjudicated`
 * section. Skeleton-create-on-miss: if the day-file doesn't exist, write
 * it first with the full skeleton, THEN insert the entry.
 *
 * Lock-guarded — concurrent writes to the same day-file are serialized
 * via `withLock(<path>.lock, ...)`, matching the T5 design (sibling
 * branch). Single-team mode only (T1 doesn't implement the `### <team>`
 * subsection per §D6 — atmux-the-monorepo runs one team, and that's the
 * only consumer in v1; T8 + multi-team gating land via T5 integration).
 */
export async function appendComplaintAdjudication(
  repoRoot: string,
  epochMs: number,
  entry: ComplaintAdjudicationEntry,
): Promise<void> {
  const path = resolveDayFilePath(repoRoot, epochMs);
  await ensureDir(join(path, ".."));
  await withLock(path, async () => {
    const body = (await exists(path)) ? await readText(path) : dayFileSkeleton(epochMs);
    const line = formatEntryLine(entry);
    const next = spliceUnderSection(body, COMPLAINTS_SECTION_HEADER, line);
    await writeText(path, next);
  });
}

/** Pure splice helper — exported so tests can drive the section-resolution
 *  logic without going through the lock + filesystem path. Find the
 *  `## Complaints adjudicated` header; insert the line at the section
 *  tail (just before the next `##` header, or EOF). If the section header
 *  is absent (shouldn't happen post-skeleton, but defensive), append the
 *  section + line at EOF. */
export function spliceUnderSection(body: string, header: string, line: string): string {
  const headerIdx = body.indexOf(header);
  if (headerIdx === -1) {
    const suffix = body.endsWith("\n") ? "" : "\n";
    return `${body}${suffix}\n${header}\n\n${line}\n`;
  }
  // Find the next `## ` header after this one. Scan line-by-line so
  // we don't false-match `##` inside fenced code blocks (release notes
  // shouldn't carry those, but defensive).
  const lines = body.split("\n");
  let inSection = false;
  let insertAt = lines.length; // EOF default
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (l === header) {
      inSection = true;
      continue;
    }
    if (inSection && /^## (?!#)/.test(l)) {
      insertAt = i;
      break;
    }
  }
  // Walk back over trailing blank lines so the insertion lands directly
  // below existing content (or directly below the header on first write).
  let actualInsert = insertAt;
  while (actualInsert > 0 && (lines[actualInsert - 1] ?? "").trim() === "") {
    actualInsert -= 1;
  }
  // Build the new lines array.
  const before = lines.slice(0, actualInsert);
  const after = lines.slice(actualInsert);
  // Ensure single blank line between header (or prior entry) and our line;
  // and single blank line after our line before the next section.
  const result: string[] = [...before, line];
  if (after.length > 0 && (after[0] ?? "").trim() !== "") {
    result.push("");
  }
  result.push(...after);
  return result.join("\n");
}

/** Render one adjudication line per the brief's example shape:
 *  `- c-xxxxxxxx → **<action>** (<one-line rationale>)`. */
export function formatEntryLine(entry: ComplaintAdjudicationEntry): string {
  const label = actionLabel(entry.action, entry.relatedTask);
  const rationale = entry.note !== null && entry.note.length > 0 ? entry.note : entry.summary;
  return `- ${entry.complaintId} → **${label}** (${rationale})`;
}
