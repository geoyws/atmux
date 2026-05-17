// SPEC-066 (kanban t-c2cd08b1): `atmux health` — composed read-only
// diagnostic snapshot. Foundational verb for fleet dashboard polling.
//
// Composes existing primitives into a single JSON payload:
//   - gatherStatus       → session/members/kanban/driverInboxOpen
//   - readHeartbeatAges  → ADR-057 §D6 per-member liveness
//   - probeBudget        → ADR-053 rate-limit utilization (opt-in)
//
// JSON-first by design — the foundational dashboard intent values
// machine-readable composition over human formatting. A minimal text
// renderer is available behind `--text` for terminal smoke-checks.
//
// Read-only: never writes state, no schema migrations, no side effects
// beyond the optional budget probe's own cache write.

import {
  type BudgetProbeResult,
  probeBudget as defaultProbeBudget,
  type ProbeBudgetOpts,
} from "../abstractions/budget-probe.ts";
import { now } from "../abstractions/time.ts";
import { createTmux, type TmuxNamespace } from "../abstractions/tmux.ts";
import {
  getAtmuxDir,
  getSessionName,
  type ResolveDirOpts,
  requireTeam,
  resolveTeamSocket,
} from "../core/common.ts";
import { DEFAULT_HEARTBEAT_STALE_SEC, readHeartbeatAges } from "../core/heartbeat.ts";
import { UsageError } from "../errors.ts";
import type { Team } from "../schema/team.ts";
import { gatherStatus, type KanbanCounts, type StatusSnapshot } from "./status.ts";

const USAGE =
  "atmux health [--json] [--text] [--budget] [--stale-sec <N>] [--socket <path>] [--team-dir <dir>]";

// ---------- Args ----------

/** Parsed `health` argv. */
export interface HealthArgs {
  /** Emit JSON. Default true (foundational-for-dashboard intent). */
  json: boolean;
  /** Emit human text instead of JSON. Mutually exclusive with `json`. */
  text: boolean;
  /** Probe each unique `claudeAccount` in the roster. Off by default —
   *  the probe makes a network call and writes to the per-account cache
   *  under `state/budget-probe-<account>.json`. Polling consumers opt in
   *  when they want the budget axis. */
  includeBudget: boolean;
  /** Heartbeat staleness threshold (seconds). Default 300 (ADR-057 §D6). */
  staleSec: number;
  socketPath?: string;
  teamDir?: string;
}

/** Pure parser. Throws `UsageError` on bad invocation. */
export function parseHealthArgs(argv: ReadonlyArray<string>): HealthArgs {
  let json = true;
  let text = false;
  let includeBudget = false;
  let staleSec = DEFAULT_HEARTBEAT_STALE_SEC;
  let socketPath: string | undefined;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--json") {
      json = true;
      text = false;
      i += 1;
      continue;
    }
    if (a === "--text") {
      text = true;
      json = false;
      i += 1;
      continue;
    }
    if (a === "--budget") {
      includeBudget = true;
      i += 1;
      continue;
    }
    if (a === "--stale-sec") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "health: --stale-sec requires a value", hint: USAGE });
      }
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n < 0) {
        throw new UsageError({ what: `health: --stale-sec invalid: ${v}`, hint: USAGE });
      }
      staleSec = n;
      i += 2;
      continue;
    }
    if (a === "--socket") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "health: --socket requires a path", hint: USAGE });
      }
      socketPath = v;
      i += 2;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "health: --team-dir requires a value", hint: USAGE });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    throw new UsageError({ what: `health: unknown arg: ${a ?? ""}`, hint: USAGE });
  }
  const out: HealthArgs = { json, text, includeBudget, staleSec };
  if (socketPath !== undefined) out.socketPath = socketPath;
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

// ---------- Snapshot shape ----------

/** Per-member row in the health snapshot. Extends the `MemberStatus`
 *  shape from `status` with heartbeat liveness — the two pieces a
 *  fleet dashboard needs to decide "is this member alive AND working." */
export interface HealthMemberRow {
  name: string;
  role: string;
  tui: string;
  emoji?: string;
  paneCommand: string;
  pendingCount: number;
  inProgressCount: number;
  /** Seconds since the supervisor last stamped a heartbeat for this
   *  member; `null` when no heartbeat file exists (member never started
   *  OR supervisor not running). */
  heartbeatAgeSec: number | null;
  /** True iff `heartbeatAgeSec === null` OR `heartbeatAgeSec > staleSec`. */
  heartbeatStale: boolean;
}

/** Per-account budget probe row. Always 0..N rows — empty when
 *  `includeBudget=false` or the roster has no `claudeAccount` set. */
export interface HealthBudgetRow {
  account: string;
  result: BudgetProbeResult;
}

/** Composed JSON payload. Stable enough for external consumers to
 *  index by field name; schema changes here are reviewer-gated. */
export interface HealthSnapshot {
  team: string;
  session: string;
  sessionState: "up" | "down";
  /** Epoch-seconds when this snapshot was generated (inj. for tests). */
  generatedAt: number;
  /** Staleness threshold applied to `heartbeatStale` decisions. */
  staleSec: number;
  members: HealthMemberRow[];
  kanban: KanbanCounts;
  driverInboxOpen: number;
  /** Empty array when `--budget` not requested OR roster has no
   *  `claudeAccount`. Order matches first-seen order in the roster. */
  budget: HealthBudgetRow[];
}

// ---------- Composition ----------

/** Test-injection seam for `gatherHealth`. */
export interface GatherHealthDeps {
  /** Override the wall clock; default real epoch seconds. */
  nowSec?: () => number;
  /** Override the budget probe; default `probeBudget` from
   *  `abstractions/budget-probe`. Tests inject a recorder; opt-in
   *  callers can pre-warm a cache and let the real probe read it. */
  probeBudget?: (account: string, opts?: ProbeBudgetOpts) => Promise<BudgetProbeResult>;
}

/** Pull `claudeAccount` off a roster member without forcing a Zod-level
 *  schema change. The team.json passthrough allows it; we just need a
 *  defensive read. */
function memberClaudeAccount(m: Team["members"][number]): string | null {
  const rec = m as Record<string, unknown>;
  const v = rec.claudeAccount;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Deduplicated list of `claudeAccount` values across the roster, in
 *  first-seen order. */
export function uniqueClaudeAccounts(team: Team): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of team.members) {
    const acc = memberClaudeAccount(m);
    if (acc === null) continue;
    if (seen.has(acc)) continue;
    seen.add(acc);
    out.push(acc);
  }
  return out;
}

/** Pure composition. Reuses `gatherStatus` for session/members/kanban,
 *  then layers heartbeat ages + optional budget probe results on top.
 *
 *  Budget probe failures collapse to `null`-omitted rows so a single
 *  account's 401 doesn't take the whole snapshot down. */
export async function gatherHealth(
  tmux: TmuxNamespace,
  team: Team,
  sessionName: string,
  atmuxDir: string,
  opts: { includeBudget: boolean; staleSec: number },
  deps: GatherHealthDeps = {},
): Promise<HealthSnapshot> {
  const statusSnap: StatusSnapshot = await gatherStatus(tmux, team, sessionName, atmuxDir);

  const nowSec = (deps.nowSec ?? (() => Math.floor(now() / 1000)))();
  const ages = await readHeartbeatAges(
    atmuxDir,
    team.members.map((m) => m.name),
    nowSec,
  );
  const ageByMember = new Map(ages.map((a) => [a.member, a.ageSec]));

  const members: HealthMemberRow[] = statusSnap.members.map((m) => {
    const ageSec = ageByMember.get(m.name) ?? null;
    const row: HealthMemberRow = {
      name: m.name,
      role: m.role,
      tui: m.tui,
      paneCommand: m.paneCommand,
      pendingCount: m.pendingCount,
      inProgressCount: m.inProgressCount,
      heartbeatAgeSec: ageSec,
      heartbeatStale: ageSec === null || ageSec > opts.staleSec,
    };
    if (m.emoji !== undefined) row.emoji = m.emoji;
    return row;
  });

  const budget: HealthBudgetRow[] = [];
  if (opts.includeBudget) {
    const probe = deps.probeBudget ?? defaultProbeBudget;
    for (const account of uniqueClaudeAccounts(team)) {
      try {
        const result = await probe(account, { atmuxDir });
        budget.push({ account, result });
      } catch {
        // Probe contract is meant to swallow errors into typed results
        // (probe-401 / probe-error / no-credentials). A thrown error is
        // either a programming bug or a runtime catastrophe; swallow it
        // here so one bad account doesn't take down the snapshot —
        // consumers detect the omission by comparing roster-seen
        // accounts against `budget[].account`.
      }
    }
  }

  return {
    team: statusSnap.team,
    session: statusSnap.session,
    sessionState: statusSnap.sessionState,
    generatedAt: nowSec,
    staleSec: opts.staleSec,
    members,
    kanban: statusSnap.kanban,
    driverInboxOpen: statusSnap.driverInboxOpen,
    budget,
  };
}

// ---------- Verb entry ----------

/** Build-tmux injection seam (mirrors `status` / `rotate` patterns so
 *  the verb is unit-testable without a real tmux server). */
export interface HealthOpts {
  buildTmux?: (socketPath: string) => TmuxNamespace;
  gatherDeps?: GatherHealthDeps;
}

/** `atmux health [--json|--text] [--budget] [--stale-sec N]`. Returns 0. */
export async function health(argv: ReadonlyArray<string>, opts: HealthOpts = {}): Promise<number> {
  const parsed = parseHealthArgs(argv);
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const team = await requireTeam(dirOpts);
  const sessionName = await getSessionName({ ...dirOpts, team });
  const atmuxDir = await getAtmuxDir(dirOpts);
  const socketPath = parsed.socketPath ?? resolveTeamSocket(team);
  const tmux = (opts.buildTmux ?? ((sp) => createTmux({ socketPath: sp })))(socketPath);
  const snap = await gatherHealth(
    tmux,
    team,
    sessionName,
    atmuxDir,
    { includeBudget: parsed.includeBudget, staleSec: parsed.staleSec },
    opts.gatherDeps ?? {},
  );

  if (parsed.text) {
    process.stdout.write(renderTextHealth(snap));
  } else {
    process.stdout.write(`${JSON.stringify(snap, null, 2)}\n`);
  }
  return 0;
}

/** Minimal text rendering — one line per member with the most operator-
 *  useful axes (pane state + heartbeat freshness + work-in-progress).
 *  Not the primary output path; the JSON shape is. */
export function renderTextHealth(snap: HealthSnapshot): string {
  const lines: string[] = [];
  lines.push(`team=${snap.team}  session=${snap.session}  [${snap.sessionState}]`);
  lines.push(
    `kanban  todo=${snap.kanban.todo}  in-progress=${snap.kanban.inProgress}  done=${snap.kanban.done}  blocked=${snap.kanban.blocked}  driver-inbox=${snap.driverInboxOpen}`,
  );
  lines.push("");
  for (const m of snap.members) {
    const hb = m.heartbeatAgeSec === null ? "hb=never" : `hb=${m.heartbeatAgeSec}s`;
    const stale = m.heartbeatStale ? " STALE" : "";
    lines.push(
      `  ${m.name.padEnd(20)} role=${m.role.padEnd(12)} tui=${m.tui.padEnd(8)} pane=${m.paneCommand.padEnd(8)} pending=${m.pendingCount}  in-progress=${m.inProgressCount}  ${hb}${stale}`,
    );
  }
  if (snap.budget.length > 0) {
    lines.push("");
    for (const b of snap.budget) {
      lines.push(
        `  budget  account=${b.account}  h5=${b.result.h5_pct_used}%  wk=${b.result.wk_pct_used}%  status=${b.result.status}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
