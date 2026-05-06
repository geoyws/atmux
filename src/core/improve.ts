// ADR-052 T1: budget-spec parser + resolver + runId factory for the
// `atmux improve` verb. T2 owns the state-file IO + idempotence-detector
// primitives (`src/core/eternal-improvement.ts`); T1 layers spec/budget
// resolution + precedence-cascade on top.
//
// Pure helpers — no IO. Verb (src/verbs/improve.ts) wires these to
// `readBudgetProbe` (filesystem) and `writeState` (T2).

import { join } from "node:path";
import { z } from "zod";
import { tryReadJson } from "../abstractions/json.ts";
import { stateDir } from "./common.ts";

// ---------- Constants ----------

/** Standing default per ADR-052 §"Budget formula". */
export const DEFAULT_BUDGET_SPEC = "30%-wk";

/** Append-only ring cap per ADR-052 §State-file-schema. */
export const HISTORY_RING_MAX = 50;

/** Default 5h cap per Claude Max plan (ADR-049). Operator-overrideable. */
export const DEFAULT_5H_CAP_TOKENS = 5_000_000;

/** Default weekly cap per Claude Max plan (ADR-049). */
export const DEFAULT_WK_CAP_TOKENS = 100_000_000;

// ---------- Paths ----------

/** `.atmux/state/budget-probe-<team>.json` (ADR-049). */
export function budgetProbePath(atmuxDir: string, teamName: string): string {
  return join(stateDir(atmuxDir), `budget-probe-${teamName}.json`);
}

// ---------- Budget spec parser ----------

/** Parsed budget spec — discriminated union by `kind`. */
export type BudgetSpec =
  | { kind: "raw"; tokens: number }
  | { kind: "pct-5h"; pct: number }
  | { kind: "pct-wk"; pct: number };

const RAW_RE = /^[0-9]+$/;
const PCT_RE = /^([0-9]+)%(-(5h|wk))?$/;

/**
 * Parse a budget spec string per ADR-052 §"Budget formula":
 *   - `<int>`         raw token count
 *   - `<int>%`        fraction of weekly cap (default; equiv to `<int>%-wk`)
 *   - `<int>%-5h`     fraction of 5h cap
 *   - `<int>%-wk`     fraction of weekly cap
 *
 * Returns null on parse failure (caller throws UsageError with full spec).
 */
export function parseBudgetSpec(spec: string): BudgetSpec | null {
  if (RAW_RE.test(spec)) {
    const tokens = Number.parseInt(spec, 10);
    if (!Number.isFinite(tokens) || tokens < 0) return null;
    return { kind: "raw", tokens };
  }
  const m = PCT_RE.exec(spec);
  if (m === null) return null;
  const pct = Number.parseInt(m[1] ?? "", 10);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return null;
  const window = m[3] ?? "wk"; // bare `<int>%` → wk per ADR-052
  if (window === "5h") return { kind: "pct-5h", pct };
  return { kind: "pct-wk", pct };
}

// ---------- Budget-probe shape ----------

/** Loose shape of `.atmux/state/budget-probe-<team>.json`. ADR-049 owns
 *  the full schema; this models only the fields the budget resolver
 *  consumes (`h5_util`, `wk_util` — utilization fractions in [0..1];
 *  remaining = `1 - util`). */
export const BudgetProbe = z
  .object({
    h5_util: z.number().nonnegative().optional(),
    wk_util: z.number().nonnegative().optional(),
  })
  .passthrough();
export type BudgetProbe = z.infer<typeof BudgetProbe>;

/** Read the budget-probe file or return null on absence. */
export async function readBudgetProbe(
  atmuxDir: string,
  teamName: string,
): Promise<BudgetProbe | null> {
  return await tryReadJson(budgetProbePath(atmuxDir, teamName), BudgetProbe);
}

// ---------- Budget resolution ----------

export interface ResolveBudgetOpts {
  /** Pre-fetched probe (test injection). */
  probe?: BudgetProbe | null;
  /** 5h cap override; defaults to DEFAULT_5H_CAP_TOKENS. */
  cap5h?: number;
  /** Weekly cap override; defaults to DEFAULT_WK_CAP_TOKENS. */
  capWk?: number;
}

/** Result of `resolveBudget` — integer token total + human-readable
 *  formula string for `--dry-run` output. */
export interface ResolvedBudget {
  total: number;
  formula: string;
}

/**
 * Resolve a `BudgetSpec` to an integer token total. Per ADR-052, the
 * `min(remaining_wk_tokens_per_active_member)` over-members semantic
 * is approximated here by reading the team-level probe (ADR-049 emits
 * one file per team capturing the bottleneck member); the precise
 * per-member min lands in T7 once the loop wiring needs it.
 *
 * Returns null when `kind:pct-*` is asked but no probe is available
 * (caller maps to USAGE error per ADR-052 §"Budget formula" fail-closed
 * rule).
 */
export function resolveBudget(
  spec: BudgetSpec,
  opts: ResolveBudgetOpts = {},
): ResolvedBudget | null {
  const probe = opts.probe;
  const cap5h = opts.cap5h ?? DEFAULT_5H_CAP_TOKENS;
  const capWk = opts.capWk ?? DEFAULT_WK_CAP_TOKENS;

  if (spec.kind === "raw") {
    return { total: spec.tokens, formula: `raw=${spec.tokens}` };
  }
  if (probe === undefined || probe === null) return null;

  if (spec.kind === "pct-5h") {
    const util = probe.h5_util ?? 0;
    const remainingFrac = Math.max(0, 1 - util);
    const remaining = Math.floor(remainingFrac * cap5h);
    const total = Math.floor((spec.pct / 100) * remaining);
    return {
      total,
      formula: `${spec.pct}% × (1 − h5_util=${util.toFixed(2)}) × cap5h=${cap5h}`,
    };
  }
  const util = probe.wk_util ?? 0;
  const remainingFrac = Math.max(0, 1 - util);
  const remaining = Math.floor(remainingFrac * capWk);
  const total = Math.floor((spec.pct / 100) * remaining);
  return {
    total,
    formula: `${spec.pct}% × (1 − wk_util=${util.toFixed(2)}) × capWk=${capWk}`,
  };
}

// ---------- runId ----------

/** `ei-<8-hex>` per ADR-052 §State-file-schema. Random; collision
 *  probability is negligible at observed cadence. */
export function generateRunId(rng: () => number = Math.random): string {
  const hex = Math.floor(rng() * 0xff_ff_ff_ff)
    .toString(16)
    .padStart(8, "0")
    .slice(0, 8);
  return `ei-${hex}`;
}

// ---------- Precedence-cascade resolver ----------

export interface ResolveSpecArgs {
  /** CLI `--budget <spec>` value, or undefined. */
  cliBudget?: string;
}

/** Resolve the effective budget-spec string per ADR-052 precedence:
 *   1. CLI --budget
 *   2. env ATMUX_IMPROVE_BUDGET
 *   3. team.json::improve.defaultBudget
 *   4. built-in default `30%-wk`
 *
 * Pure — no IO. Caller passes pre-loaded env + team. */
export function resolveBudgetSpec(
  args: ResolveSpecArgs,
  env: NodeJS.ProcessEnv,
  team: unknown,
): string {
  if (args.cliBudget !== undefined && args.cliBudget.length > 0) return args.cliBudget;
  const fromEnv = env.ATMUX_IMPROVE_BUDGET;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const t = team as { improve?: { defaultBudget?: unknown } } | null;
  const tDefault = t?.improve?.defaultBudget;
  if (typeof tDefault === "string" && tDefault.length > 0) return tDefault;
  return DEFAULT_BUDGET_SPEC;
}
