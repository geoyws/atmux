// e-50 T4 (t-c56842cb): `atmux budget collect|report` verbs.
//
// `collect` probes every provider/account via the T3 adapters and writes
// ONE batch of `usage_snapshot` rows (shared ISO UTC `ts`) into the
// cockpit-global `~/.atmux/state/budget.db` (T2 opener). `report` reads
// the latest batch plus window deltas and folds in measured Claude
// actual-spend from `cost.ts` where a team context exists.
//
// Security posture (ADR-270 D6): only usage numbers persist — never keys,
// tokens, JWTs or cookies. Adapters never return raw payloads, so
// `raw_json` is stored NULL (no secret-stripping risk at all).

import type { Database } from "bun:sqlite";
import { getAtmuxDir, tryLoadTeam } from "../core/common.ts";
import { defaultStderrWrite, defaultStdoutWrite, type Writer } from "../core/io.ts";
import { computeMemberCost, loadPricing } from "./cost.ts";
import { withBudgetDb } from "../core/budget-db.ts";
import { probeAllProviders, type UsageRow } from "../abstractions/usage-adapters.ts";
import { UsageError } from "../errors.ts";

const USAGE =
  "atmux budget collect [--json]\n" +
  "atmux budget report [--json] [--window 24h|7d] [--provider <p>] [--live]";

type Subcommand = "collect" | "report";

export interface BudgetArgs {
  subcommand: Subcommand;
  json: boolean;
  window: "24h" | "7d";
  provider?: string;
  live: boolean;
}

interface BudgetOpts {
  stdout?: Writer;
  stderr?: Writer;
  /** Test injection: fake HOME for the global budget.db. */
  home?: string;
  /** Test injection: stub adapter probes (hermetic collect). */
  probe?: () => Promise<UsageRow[]>;
  /** Test injection: fixed batch timestamp. */
  now?: () => string;
  /** Test injection: cwd for team-context resolution (actuals). */
  cwd?: string;
}

/** Pure parser. Throws `UsageError` on bad invocation. */
export function parseBudgetArgs(argv: ReadonlyArray<string>): BudgetArgs {
  const [sub, ...rest] = argv;
  if (sub !== "collect" && sub !== "report") {
    throw new UsageError({ what: "budget: expected `collect` or `report`", hint: USAGE });
  }
  const out: BudgetArgs = {
    subcommand: sub,
    json: false,
    window: "24h",
    live: false,
  };
  const seen = new Set<string>();
  const flag = (name: string): void => {
    if (seen.has(name)) throw new UsageError({ what: `budget: duplicate ${name}`, hint: USAGE });
    seen.add(name);
  };
  let i = 0;
  while (i < rest.length) {
    const a = rest[i];
    if (a === "--json") {
      flag("--json");
      out.json = true;
      i += 1;
    } else if (a === "--live") {
      flag("--live");
      if (sub !== "report") throw new UsageError({ what: "budget: --live is report-only", hint: USAGE });
      out.live = true;
      i += 1;
    } else if (a === "--window") {
      flag("--window");
      if (sub !== "report") throw new UsageError({ what: "budget: --window is report-only", hint: USAGE });
      const v = rest[i + 1];
      if (v !== "24h" && v !== "7d") {
        throw new UsageError({ what: "budget: --window takes 24h|7d", hint: USAGE });
      }
      out.window = v;
      i += 2;
    } else if (a === "--provider") {
      flag("--provider");
      if (sub !== "report") throw new UsageError({ what: "budget: --provider is report-only", hint: USAGE });
      const v = rest[i + 1];
      if (v === undefined || v.length === 0) {
        throw new UsageError({ what: "budget: --provider requires a value", hint: USAGE });
      }
      out.provider = v;
      i += 2;
    } else {
      throw new UsageError({ what: `budget: unexpected argument: ${a}`, hint: USAGE });
    }
  }
  return out;
}

// ---------- collect ----------

export interface CollectSummary {
  ts: string;
  rows: number;
  ok: number;
  failed: number;
}

/** Probe every provider and persist one batch. Returns the batch summary. */
export async function collectBudget(opts: BudgetOpts = {}): Promise<CollectSummary> {
  const ts = (opts.now ?? (() => new Date().toISOString()))();
  const rows = await (opts.probe ?? (() => probeAllProviders({ env: process.env })))();
  await withBudgetDb(
    (db) => {
      insertBatch(db, ts, rows);
    },
    ...(opts.home !== undefined ? [{ home: opts.home }] : []),
  );
  return {
    ts,
    rows: rows.length,
    ok: rows.filter((r) => r.ok === 1).length,
    failed: rows.filter((r) => r.ok !== 1).length,
  };
}

function insertBatch(db: Database, ts: string, rows: UsageRow[]): void {
  const stmt = db.prepare(
    `INSERT INTO usage_snapshot
       (ts, provider, account, metric, value, value_text, unit, ok, error, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  );
  const tx = db.transaction((batch: UsageRow[]) => {
    for (const r of batch) {
      stmt.run(ts, r.provider, r.account, r.metric, r.value, r.valueText, r.unit, r.ok, r.error);
    }
  });
  tx(rows);
}

// ---------- report ----------

export interface ReportAccount {
  provider: string;
  account: string;
  ok: number;
  metrics: Record<string, { value: number | null; valueText: string | null; unit: string | null; reset?: string }>;
  /** Measured Claude actual-spend (USD) — anthropic accounts only, null when unresolvable. */
  actualUsd: number | null;
  /** util_5h/util_weekly delta vs window start (latest − earliest), null when no earlier batch. */
  delta5h: number | null;
  deltaWeekly: number | null;
  error: string | null;
}

export interface BudgetReport {
  ts: string;
  window: string;
  accounts: ReportAccount[];
}

interface SnapshotRow {
  ts: string;
  provider: string;
  account: string;
  metric: string;
  value: number | null;
  value_text: string | null;
  unit: string | null;
  ok: number;
  error: string | null;
}

/** Read the latest batch (+ window-start batch for deltas) and render. */
export async function reportBudget(args: BudgetArgs, opts: BudgetOpts = {}): Promise<BudgetReport> {
  const windowMs = args.window === "7d" ? 7 * 24 * 3600 * 1000 : 24 * 3600 * 1000;
  const snapshot = await withBudgetDb(
    (db) => readBatches(db, args.provider, windowMs),
    ...(opts.home !== undefined ? [{ home: opts.home }] : []),
  );
  if (snapshot.latest.length === 0) {
    return { ts: "", window: args.window, accounts: [] };
  }
  const actuals = await claudeActuals(opts);
  const byAccount = new Map<string, ReportAccount>();
  for (const r of snapshot.latest) {
    const key = `${r.provider}\0${r.account}`;
    let acc = byAccount.get(key);
    if (acc === undefined) {
      acc = {
        provider: r.provider,
        account: r.account,
        ok: 1,
        metrics: {},
        actualUsd: r.provider === "anthropic" ? actuals : null,
        delta5h: null,
        deltaWeekly: null,
        error: null,
      };
      byAccount.set(key, acc);
    }
    if (r.ok !== 1) {
      acc.ok = 0;
      acc.error = r.error;
    }
    acc.metrics[r.metric] = metricView(r);
    const base = snapshot.baseline.get(`${key}\0${r.metric}`);
    if (base !== undefined && r.value !== null && base !== null && (r.metric === "util_5h" || r.metric === "util_weekly")) {
      const delta = r.value - base;
      if (r.metric === "util_5h") acc.delta5h = delta;
      else acc.deltaWeekly = delta;
    }
  }
  return { ts: snapshot.latestTs, window: args.window, accounts: [...byAccount.values()] };
}

function metricView(r: SnapshotRow): ReportAccount["metrics"][string] {
  const view: ReportAccount["metrics"][string] = { value: r.value, valueText: r.value_text, unit: r.unit };
  if (r.metric === "reset_5h" || r.metric === "reset_weekly") {
    view.reset = renderReset(r.value, r.value_text, r.unit);
  }
  return view;
}

/** Absolute local + relative reset rendering. Unknown shapes pass through as text. */
export function renderReset(value: number | null, valueText: string | null, unit: string | null): string {
  let ms: number | null = null;
  if (value !== null && unit === "epoch_ms") ms = value;
  else if (value !== null && unit === "epoch_s") ms = value * 1000;
  else if (valueText !== null && unit === "iso8601") {
    const t = Date.parse(valueText);
    if (!Number.isNaN(t)) ms = t;
  }
  if (ms === null) return valueText ?? (value !== null ? String(value) : "unknown");
  const date = new Date(ms);
  const abs = date.toLocaleString();
  const rel = relTime(ms - Date.now());
  return `${abs} (${rel})`;
}

function relTime(diffMs: number): string {
  const past = diffMs < 0;
  const mins = Math.round(Math.abs(diffMs) / 60000);
  const text = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${mins % 60 === 0 ? "" : `${mins % 60}m`}`;
  return past ? `${text} ago` : `in ${text}`;
}

interface Batches {
  latest: SnapshotRow[];
  latestTs: string;
  /** `${provider}\0${account}\0${metric}` → value at window-start batch. */
  baseline: Map<string, number | null>;
}

function readBatches(db: Database, provider: string | undefined, windowMs: number): Batches {
  const latestTs = db
    .query("SELECT MAX(ts) AS ts FROM usage_snapshot")
    .get() as { ts: string | null };
  if (latestTs.ts === null) return { latest: [], latestTs: "", baseline: new Map() };
  const cutoff = new Date(Date.parse(latestTs.ts) - windowMs).toISOString();
  const latestQuery = db.query(`SELECT ts, provider, account, metric, value, value_text, unit, ok, error
            FROM usage_snapshot WHERE ts = ? ${provider !== undefined ? "AND provider = ?" : ""}`);
  const latest = (provider !== undefined
    ? latestQuery.all(latestTs.ts, provider)
    : latestQuery.all(latestTs.ts)) as SnapshotRow[];
  const baseTs = db
    .query("SELECT MIN(ts) AS ts FROM usage_snapshot WHERE ts >= ?")
    .get(cutoff) as { ts: string | null };
  const baseline = new Map<string, number | null>();
  if (baseTs.ts !== null && baseTs.ts !== latestTs.ts) {
    const baseQuery = db.query(
      `SELECT provider, account, metric, value FROM usage_snapshot WHERE ts = ? ${provider !== undefined ? "AND provider = ?" : ""}`,
    );
    const base = (provider !== undefined
      ? baseQuery.all(baseTs.ts, provider)
      : baseQuery.all(baseTs.ts)) as Array<{
        provider: string;
        account: string;
        metric: string;
        value: number | null;
      }>;
    for (const b of base) baseline.set(`${b.provider}\0${b.account}\0${b.metric}`, b.value);
  }
  return { latest, latestTs: latestTs.ts, baseline };
}

/** Measured Claude actual-spend for the enclosing team, or null outside
 *  one. Team-total: jsonl actuals are per-member, not per-Claude-account,
 *  so every anthropic account row carries the same team total. */
async function claudeActuals(opts: BudgetOpts): Promise<number | null> {
  try {
    const atmuxDir = await getAtmuxDir({ cwd: opts.cwd ?? process.cwd(), env: {} });
    const team = await tryLoadTeam({ dir: atmuxDir });
    if (team === null) return null;
    const pricing = await loadPricing();
    let total = 0;
    for (const m of team.members) {
      total += (await computeMemberCost(m, 0, { pricing })).usd;
    }
    return total;
  } catch {
    return null;
  }
}

// ---------- entry ----------

/** `atmux budget …` — dispatcher. Returns process exit code. */
export async function budget(argv: ReadonlyArray<string>, opts: BudgetOpts = {}): Promise<number> {
  const stdout = opts.stdout ?? defaultStdoutWrite;
  const stderr = opts.stderr ?? defaultStderrWrite;
  const args = parseBudgetArgs(argv);
  if (args.subcommand === "collect") {
    const summary = await collectBudget(opts);
    if (args.json) {
      stdout(`${JSON.stringify(summary)}\n`);
    } else {
      stdout(
        `budget collect: ${summary.rows} rows (${summary.ok} ok, ${summary.failed} failed) @ ${summary.ts}\n`,
      );
    }
    return 0;
  }
  if (args.live) await collectBudget(opts);
  const rep = await reportBudget(args, opts);
  if (args.json) {
    stdout(`${JSON.stringify(rep)}\n`);
    return 0;
  }
  if (rep.accounts.length === 0) {
    stderr("budget report: no snapshots yet — run `atmux budget collect` first\n");
    return 1;
  }
  const lines: string[] = [`budget report @ ${rep.ts} (${rep.window} window):`];
  for (const a of rep.accounts) {
    const mark = a.ok === 1 ? "ok" : `FAIL ${a.error ?? ""}`;
    const utils = ["util_5h", "util_weekly"]
      .map((m) => {
        const v = a.metrics[m]?.value;
        if (v === undefined || v === null) return null;
        const d = m === "util_5h" ? a.delta5h : a.deltaWeekly;
        return `${m}=${v}%${d !== null ? ` (${d >= 0 ? "+" : ""}${d.toFixed(1)}pp)` : ""}`;
      })
      .filter((s) => s !== null)
      .join(" ");
    const money = ["balance_usd", "credits_usd", "usage_usd"]
      .map((m) => {
        const v = a.metrics[m]?.value;
        return v === undefined || v === null ? null : `${m}=$${v}`;
      })
      .filter((s) => s !== null)
      .join(" ");
    const resets = ["reset_5h", "reset_weekly"]
      .map((m) => {
        const r = a.metrics[m]?.reset;
        return r === undefined ? null : `${m}: ${r}`;
      })
      .filter((s) => s !== null)
      .join("; ");
    const actual = a.actualUsd !== null ? ` actual_spend=$${a.actualUsd.toFixed(2)}` : "";
    lines.push(`- ${a.provider}:${a.account} [${mark}] ${utils} ${money}${actual}${resets.length > 0 ? ` | ${resets}` : ""}`);
  }
  stdout(`${lines.join("\n")}\n`);
  return 0;
}
