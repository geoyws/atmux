// ADR-077 §F2 / ADR-133: complaints verb family.
//
// `atmux complaints {list,file,resolve}` — operator + medic (formerly
// named `superdoctor`; renamed per ADR-133, both `--by medic` /
// `--by superdoctor` literals accepted during the one-release-cycle
// deprecation window) surface for reading, filing, and resolving
// complaints. Per-team storage: each team's `<root>/.atmux/state.db`
// `complaints` table holds its own rows (per ADR-077 §Open bias toward
// per-team).
//
// Sub-verbs:
//
//   atmux complaints list [--status <s>] [--json]
//       — list complaints in the current team's state.db. Default
//         status filter `open`. Omit `--status` filter via `--all`.
//
//   atmux complaints file --summary <s>
//                         [--root-cause <r>] [--ask <a>]
//                         [--by <attribution>] [--related-task <id>]
//                         [--kind <k>]
//       — file a new complaint. Returns the new id on stdout.
//
//   atmux complaints resolve <id> [--status resolved|wontfix]
//                                  [--by <attribution>]
//                                  [--note <text>]
//                                  [--related-task <id>]
//       — flip status to `resolved` (default) or `wontfix`. Stamps
//         resolved_at + resolved_by.
//
// Cross-team listing (e.g. `atmux complaints list --all-teams`) is
// out of scope here — operator can `find /root/work/**/.atmux/state.db
// -exec ...` until F5+1 lands a cockpit-aware verb.

import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { closeDatabase, openDatabase, transactImmediate } from "../abstractions/sqlite.ts";
import { migrations } from "../abstractions/sqlite-migrations.ts";
import { getAtmuxDir, type ResolveDirOpts, requireTeam } from "../core/common.ts";
import { addToSentinel, removeFromSentinel } from "../core/ombudsman.ts";
import { ComplaintsRepo } from "../core/repositories/complaints-repo.ts";
import { UsageError } from "../errors.ts";
import {
  COMPLAINT_SOURCE_KINDS,
  COMPLAINT_STATUSES,
  type Complaint,
} from "../schema/complaints.ts";

function stateDbPath(atmuxDir: string): string {
  return join(atmuxDir, "state.db");
}

const USAGE =
  "atmux complaints {list [--status <s>|--all] [--source-kind <k>] [--target-team <t>] [--json] | " +
  "file (--summary <s>|--title <s>) [--root-cause <r>|--body <r>] [--ask <a>] [--by <id>] [--kind <k>] [--severity <s>] " +
  "[--source-kind <k>] [--source-id <id>] [--target-team <t>] [--related-task <id>] | " +
  "resolve <id> [--status resolved|wontfix] [--by <id>] [--note <t>] [--related-task <id>]}";

export interface ParsedComplaintsArgs {
  subverb: "list" | "file" | "resolve";
  /** list */
  status?: string;
  all?: boolean;
  json?: boolean;
  /** file */
  summary?: string;
  rootCause?: string;
  ask?: string;
  by?: string;
  relatedTask?: string;
  kind?: string;
  /** v3 / t-e5e5d576: structured provenance — used by both `file`
   *  (writes the columns) and `list` (filters). */
  sourceKind?: string;
  sourceId?: string;
  targetTeam?: string;
  /** t-7bd53cba: severity classification for `file` subverb. Free-form
   *  string (commonly `low`/`medium`/`high`) — stored in
   *  `extra.severity` since the Complaint schema has no first-class
   *  severity column. Whip-side cron filers pass `--severity high`. */
  severity?: string;
  /** resolve */
  id?: string;
  resolveStatus?: "resolved" | "wontfix";
  note?: string;
  /** dir overrides */
  teamDir?: string;
}

/** Pure parser. */
export function parseComplaintsArgs(argv: ReadonlyArray<string>): ParsedComplaintsArgs {
  if (argv.length === 0) {
    throw new UsageError({ what: "complaints: missing sub-verb", hint: USAGE });
  }
  const sub = argv[0];
  if (sub !== "list" && sub !== "file" && sub !== "resolve") {
    throw new UsageError({ what: `complaints: unknown sub-verb: ${sub ?? ""}`, hint: USAGE });
  }
  const out: ParsedComplaintsArgs = { subverb: sub };

  let i = 1;
  if (sub === "resolve") {
    // First positional is the id.
    const idArg = argv[1];
    if (idArg === undefined || idArg.startsWith("-")) {
      throw new UsageError({
        what: "complaints resolve: <id> argument is required",
        hint: USAGE,
      });
    }
    out.id = idArg;
    i = 2;
  }

  while (i < argv.length) {
    const a = argv[i];
    const need = (flag: string): string => {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({
          what: `complaints ${sub}: ${flag} requires a value`,
          hint: USAGE,
        });
      }
      return v;
    };
    switch (a) {
      case "--status":
        out.status = need("--status");
        i += 2;
        break;
      case "--all":
        out.all = true;
        i += 1;
        break;
      case "--json":
        out.json = true;
        i += 1;
        break;
      case "--summary":
      case "--title":
        // `--title` is an alias for `--summary` (t-7bd53cba). The whip
        // velocity-gate shell scripts use the more-natural `--title`
        // term; the verb's canonical field is incidentSummary so we
        // continue to populate `out.summary` for downstream uniformity.
        out.summary = need(a);
        i += 2;
        break;
      case "--root-cause":
      case "--body":
        // `--body` is an alias for `--root-cause` (t-7bd53cba). Same
        // pattern as `--title`/`--summary` — whip-side callers prefer
        // the more-natural term; canonical field stays `rootCause`.
        out.rootCause = need(a);
        i += 2;
        break;
      case "--severity":
        // t-7bd53cba: free-form severity stored in `extra.severity`.
        // No allowlist enforcement here — callers (whip-velocity-gate,
        // operators) classify per their own conventions.
        out.severity = need("--severity");
        i += 2;
        break;
      case "--ask":
        out.ask = need("--ask");
        i += 2;
        break;
      case "--by":
        out.by = need("--by");
        i += 2;
        break;
      case "--kind":
        out.kind = need("--kind");
        i += 2;
        break;
      case "--source-kind":
        out.sourceKind = need("--source-kind");
        i += 2;
        break;
      case "--source-id":
        out.sourceId = need("--source-id");
        i += 2;
        break;
      case "--target-team":
        out.targetTeam = need("--target-team");
        i += 2;
        break;
      case "--related-task":
        out.relatedTask = need("--related-task");
        i += 2;
        break;
      case "--note":
        out.note = need("--note");
        i += 2;
        break;
      case "--team-dir":
        out.teamDir = need("--team-dir");
        i += 2;
        break;
      default:
        if (a === "--resolved" || a === "--wontfix") {
          // Convenience aliases for --status.
          out.resolveStatus = a === "--wontfix" ? "wontfix" : "resolved";
          i += 1;
          break;
        }
        throw new UsageError({
          what: `complaints ${sub}: unknown arg: ${a ?? ""}`,
          hint: USAGE,
        });
    }
  }

  // Sub-verb-specific validation.
  if (sub === "file") {
    if (out.summary === undefined || out.summary.length === 0) {
      throw new UsageError({
        what: "complaints file: --summary is required",
        hint: USAGE,
      });
    }
    if (out.sourceKind !== undefined && !COMPLAINT_SOURCE_KINDS.includes(out.sourceKind as never)) {
      throw new UsageError({
        what: `complaints file: --source-kind must be one of ${COMPLAINT_SOURCE_KINDS.join("|")} (got: ${out.sourceKind})`,
        hint: USAGE,
      });
    }
  }
  if (sub === "resolve") {
    if (out.resolveStatus === undefined && out.status !== undefined) {
      // `--status resolved|wontfix` accepted on the resolve verb too.
      if (out.status !== "resolved" && out.status !== "wontfix") {
        throw new UsageError({
          what: `complaints resolve: --status must be 'resolved' or 'wontfix' (got: ${out.status})`,
          hint: USAGE,
        });
      }
      out.resolveStatus = out.status;
    }
    if (out.resolveStatus === undefined) out.resolveStatus = "resolved";
  }
  if (sub === "list") {
    if (out.all === true && out.status !== undefined) {
      throw new UsageError({
        what: "complaints list: --all and --status are mutually exclusive",
        hint: USAGE,
      });
    }
    if (out.status !== undefined && !COMPLAINT_STATUSES.includes(out.status as never)) {
      throw new UsageError({
        what: `complaints list: --status must be one of ${COMPLAINT_STATUSES.join("|")} (got: ${out.status})`,
        hint: USAGE,
      });
    }
    if (out.sourceKind !== undefined && !COMPLAINT_SOURCE_KINDS.includes(out.sourceKind as never)) {
      throw new UsageError({
        what: `complaints list: --source-kind must be one of ${COMPLAINT_SOURCE_KINDS.join("|")} (got: ${out.sourceKind})`,
        hint: USAGE,
      });
    }
  }

  return out;
}

// ---------- Verb entry ----------

/** Top-level dispatch. */
export async function complaints(argv: ReadonlyArray<string>): Promise<number> {
  const parsed = parseComplaintsArgs(argv);
  switch (parsed.subverb) {
    case "list":
      return await complaintsList(parsed);
    case "file":
      return await complaintsFile(parsed);
    case "resolve":
      return await complaintsResolve(parsed);
  }
}

async function complaintsList(parsed: ParsedComplaintsArgs): Promise<number> {
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  await requireTeam(dirOpts);
  const atmuxDir = await getAtmuxDir(dirOpts);
  const db = openDatabase(stateDbPath(atmuxDir), migrations);
  try {
    const repo = new ComplaintsRepo(db);
    const status = parsed.all === true ? undefined : (parsed.status ?? "open");
    const listOpts: Parameters<typeof repo.list>[0] = {};
    if (status !== undefined) {
      listOpts.status = status as Complaint["status"] as never;
    }
    if (parsed.sourceKind !== undefined) listOpts.sourceKind = parsed.sourceKind;
    if (parsed.targetTeam !== undefined) listOpts.targetTeam = parsed.targetTeam;
    const rows = repo.list(listOpts);
    if (parsed.json === true) {
      process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    } else {
      renderTextList(rows, status);
    }
    return 0;
  } finally {
    closeDatabase(db);
  }
}

async function complaintsFile(parsed: ParsedComplaintsArgs): Promise<number> {
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const team = await requireTeam(dirOpts);
  const atmuxDir = await getAtmuxDir(dirOpts);
  const db = openDatabase(stateDbPath(atmuxDir), migrations);
  try {
    const repo = new ComplaintsRepo(db);
    const id = `c-${randomBytes(4).toString("hex")}`;
    const now = Math.floor(Date.now() / 1000);
    const extra: Record<string, unknown> = {};
    if (parsed.kind !== undefined && parsed.kind.length > 0) extra.kind = parsed.kind;
    // t-7bd53cba: severity is free-form metadata stashed in `extra` —
    // Complaint schema has no first-class severity column. Whip-side
    // filers pass `--severity high`; superdoctor reads `extra.severity`
    // for triage ordering.
    if (parsed.severity !== undefined && parsed.severity.length > 0) {
      extra.severity = parsed.severity;
    }

    // t-7bd53cba: when --target-team omitted, default to the current
    // team's name. Preserves the pre-v3 implicit "complaint in team X's
    // DB is about team X" semantics — explicit cross-team callers
    // (cockpit whip-velocity-gate) still pass --target-team to file
    // against a different observed team.
    const targetTeam = parsed.targetTeam ?? team.name;

    const c: Complaint = {
      id,
      openedAt: now,
      openedBy: parsed.by ?? null,
      incidentSummary: parsed.summary ?? "",
      rootCause: parsed.rootCause ?? null,
      preventiveAsk: parsed.ask ?? null,
      status: "open",
      resolvedAt: null,
      resolvedBy: null,
      relatedTaskId: parsed.relatedTask ?? null,
      sourceKind: parsed.sourceKind ?? null,
      sourceId: parsed.sourceId ?? null,
      targetTeam,
      extra,
    };
    // ADR-147 T2 §D2: serialize the DB insert via BEGIN IMMEDIATE so
    // concurrent file + resolve callers don't tear (ADR-091 pre-flag
    // #1). The sentinel write follows the COMMIT — it's an async JSON
    // op (flock + atomic rename via updateJson) and cannot run inside
    // the synchronous bun:sqlite transaction callback. A crash between
    // the DB commit and the sentinel append leaves `complaints.status
    // = 'open'` without a matching sentinel entry; the ombudsman work
    // loop reads BOTH and reconciles on the next tick per
    // `src/core/ombudsman.ts` §"Concurrency" comment — worst case is
    // one delayed adjudication, not a lost complaint.
    transactImmediate(db, () => repo.insert(c));
    // ADR-147 T2 skip-gate: only teams with `ombudsman.enabled: true`
    // write the sentinel. Preserves byte-equal behavior for the
    // existing fleet (every team currently has `ombudsman` unset).
    if (team.ombudsman?.enabled === true) {
      await addToSentinel(atmuxDir, id);
    }
    process.stdout.write(`${id}\n`);
    return 0;
  } finally {
    closeDatabase(db);
  }
}

async function complaintsResolve(parsed: ParsedComplaintsArgs): Promise<number> {
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const team = await requireTeam(dirOpts);
  const atmuxDir = await getAtmuxDir(dirOpts);
  const db = openDatabase(stateDbPath(atmuxDir), migrations);
  try {
    const repo = new ComplaintsRepo(db);
    // ADR-147 T2 §D2: BEGIN IMMEDIATE around the read+UPDATE so a
    // concurrent resolve on the same id sees a serial sequence
    // (matches the file-side BEGIN IMMEDIATE; together they
    // guarantee the DB layer never tears). Sentinel removal follows
    // the COMMIT — async flock + atomic rename can't run inside the
    // synchronous transaction callback. Drift is reconciled by the
    // ombudsman work loop (sentinel-id-with-no-open-complaint case).
    const ok = transactImmediate(db, () =>
      repo.resolve({
        id: parsed.id ?? "",
        status: parsed.resolveStatus ?? "resolved",
        resolvedAt: Math.floor(Date.now() / 1000),
        resolvedBy: parsed.by ?? null,
        note: parsed.note ?? null,
        relatedTaskId: parsed.relatedTask ?? null,
      }),
    );
    if (!ok) {
      process.stderr.write(`atmux: complaints resolve: no such id: ${parsed.id ?? ""}\n`);
      return 1;
    }
    // ADR-147 T2 skip-gate: only opt-in teams maintain the sentinel.
    // `removeFromSentinel` is idempotent (set-semantic remove) — a
    // missing id is a no-op, which covers the operator-manual
    // resolve path on a complaint that was never sentinel-tracked.
    if (team.ombudsman?.enabled === true) {
      await removeFromSentinel(atmuxDir, parsed.id ?? "");
    }
    process.stdout.write(`${parsed.id} → ${parsed.resolveStatus ?? "resolved"}\n`);
    return 0;
  } finally {
    closeDatabase(db);
  }
}

// ---------- Renderers ----------

function renderTextList(rows: Complaint[], statusFilter: string | undefined): void {
  if (rows.length === 0) {
    process.stdout.write(
      `(no complaints${statusFilter !== undefined ? ` with status=${statusFilter}` : ""})\n`,
    );
    return;
  }
  const headerScope = statusFilter !== undefined ? ` [status=${statusFilter}]` : " [all statuses]";
  process.stdout.write(`📋 complaints${headerScope}  count=${rows.length}\n\n`);
  for (const c of rows) {
    const statusEmoji = c.status === "open" ? "🔴" : c.status === "resolved" ? "✅" : "⚪";
    process.stdout.write(`${statusEmoji} ${c.id}  ${c.incidentSummary}\n`);
    if (c.rootCause !== null && c.rootCause.length > 0) {
      process.stdout.write(`    🔍 root cause: ${c.rootCause}\n`);
    }
    if (c.preventiveAsk !== null && c.preventiveAsk.length > 0) {
      process.stdout.write(`    🙏 preventive ask: ${c.preventiveAsk}\n`);
    }
    if (c.relatedTaskId !== null && c.relatedTaskId.length > 0) {
      process.stdout.write(`    🔗 related task: ${c.relatedTaskId}\n`);
    }
    if (c.openedBy !== null && c.openedBy.length > 0) {
      process.stdout.write(`    👤 opened by: ${c.openedBy}\n`);
    }
    process.stdout.write("\n");
  }
}
