// ADR-273 §Supplement: `atmux token-budget` — provider/account quota
// headroom across Codex, Claude, Z.ai and Kimi.
//
// The IO half. Parsing, classification, verdict-folding, redaction and
// rendering all live in `src/core/vox/token-budget.ts` (pure,
// fixture-testable, shared with the `token_budget` voice tool); this
// file resolves the probe script, runs it, and prints.
//
// ---------------------------------------------------------------------
// Why it shells out instead of calling four provider APIs
// ---------------------------------------------------------------------
//
// `probe-budgets.sh` is the operator's maintained probe and already
// handles every provider's quirks, including the OAuth refresh Claude
// needs and Kimi's absent quota API. Reimplementing it here would give
// atmux a second copy to drift, and would put four sets of credentials
// in this process that it currently never touches. Shelling out through
// the sanctioned `spawn()` seam keeps the credentials on the far side of
// a subprocess boundary and keeps this file free of any of them.
//
// The script's stdout is NDJSON with no secret in it, and the renderer
// redacts anything credential-shaped anyway. stderr is NOT echoed
// verbatim for exactly that reason — see `probeFailureMessage`.

import { spawn } from "../abstractions/spawn.ts";
import {
  BUDGET_PROVIDERS,
  type BudgetProvider,
  parseBudgetRows,
  redactSecrets,
  renderBudgetReport,
  summarizeBudget,
} from "../core/vox/token-budget.ts";
import { ConfigError, UsageError } from "../errors.ts";

export { BUDGET_PROVIDERS, type BudgetProvider };

/** Allow-list predicate. The gate the verb runs, kept next to the list
 *  it gates so a new provider cannot be added to one and not the other. */
export function isBudgetProvider(v: string): v is BudgetProvider {
  return (BUDGET_PROVIDERS as ReadonlyArray<string>).includes(v);
}

const USAGE =
  "atmux token-budget [--provider all|codex|claude|zai|kimi] [--cache-only] " +
  "[--timeout-ms <n>] [--json]";

/** Default probe budget, ms. The script itself caps each provider call
 *  (Codex 8s, Claude/Kimi curl 15s), so this bounds the whole sweep. */
export const DEFAULT_BUDGET_PROBE_TIMEOUT_MS = 45_000;

/**
 * Resolve the probe timeout from `ATMUX_BUDGET_PROBE_TIMEOUT_MS`, failing
 * CLOSED to the default on missing / non-numeric / non-finite /
 * non-positive values — the `resolveDefaultTimeoutMs` contract from
 * `src/abstractions/spawn.ts`.
 */
export function resolveBudgetProbeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ATMUX_BUDGET_PROBE_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_BUDGET_PROBE_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_BUDGET_PROBE_TIMEOUT_MS;
  return n;
}

/** Where the probe script is looked for, in order. `ATMUX_BUDGET_PROBE`
 *  wins outright so an operator can point at a checkout.
 *
 *  `~/.agents/skills` is first because that is the ONE shared skills tree
 *  both Claude and Codex read; the `.claude*` paths are per-account
 *  symlinks into it and are kept only as a fallback for a host that has
 *  not run `init.sh`. */
export function budgetProbeCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const explicit = env.ATMUX_BUDGET_PROBE?.trim();
  if (explicit !== undefined && explicit !== "") return [explicit];
  const home = env.HOME ?? "";
  if (home === "") return [];
  const rel = "skills/budget/scripts/probe-budgets.sh";
  return [`${home}/.agents/${rel}`, `${home}/.claude/${rel}`, `${home}/.claude-gmail/${rel}`];
}

/** Parsed `token-budget` argv.
 *
 *  `provider` is a raw string, not a {@link BudgetProvider}, on purpose:
 *  the parser's job is WHERE a token landed, the verb's job is whether
 *  its value is legal. Validating the allow-list inside the parser would
 *  make the parser reject a hostile dash-led value instead of carrying
 *  it, and the catalog's argv-slot gate proves flag-value slots are safe
 *  precisely BY observing that the parser carries such a value through
 *  as data. Same split `parseNudgeArgs` uses for its `--action` enum. */
export interface TokenBudgetArgs {
  provider: string;
  cacheOnly: boolean;
  json: boolean;
  timeoutMs?: number;
}

/** Pure parser. Throws `UsageError` on a malformed INVOCATION (missing
 *  flag value, unknown flag). Value-legality is {@link tokenBudget}'s. */
export function parseTokenBudgetArgs(argv: ReadonlyArray<string>): TokenBudgetArgs {
  let provider = "all";
  let cacheOnly = false;
  let json = false;
  let timeoutMs: number | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--provider") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "token-budget: --provider requires a value", hint: USAGE });
      }
      provider = v;
      i += 2;
      continue;
    }
    if (a === "--timeout-ms") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "token-budget: --timeout-ms requires a value", hint: USAGE });
      }
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) {
        throw new UsageError({
          what: `token-budget: --timeout-ms must be a positive number, got ${JSON.stringify(v)}`,
          hint: USAGE,
        });
      }
      timeoutMs = n;
      i += 2;
      continue;
    }
    if (a === "--cache-only") {
      cacheOnly = true;
      i += 1;
      continue;
    }
    if (a === "--json") {
      json = true;
      i += 1;
      continue;
    }
    throw new UsageError({ what: `token-budget: unknown flag: ${a}`, hint: USAGE });
  }
  const out: TokenBudgetArgs = { provider, cacheOnly, json };
  if (timeoutMs !== undefined) out.timeoutMs = timeoutMs;
  return out;
}

/** Build the probe argv from parsed args. */
export function budgetProbeArgv(args: TokenBudgetArgs): string[] {
  return ["--json", "--provider", args.provider, ...(args.cacheOnly ? ["--cache-only"] : [])];
}

/**
 * Message for a probe that could not run.
 *
 * stderr is REDACTED before it is surfaced. The probe writes no secret
 * today, but this string is spoken aloud and written to logs, and a
 * failure path is exactly where a URL with a token in it would end up if
 * one ever were. Redacting costs nothing and closes that ahead of time.
 */
export function probeFailureMessage(stderrOrMessage: string): string {
  const clean = redactSecrets(stderrOrMessage).trim();
  const detail = clean === "" ? "no detail" : clean.split("\n").slice(-3).join(" ");
  return `BUDGET: UNKNOWN — the budget probe failed: ${detail}. Treat headroom as unverified.`;
}

/** Injection seam — every external boundary. */
export interface TokenBudgetDeps {
  /** Run the probe; resolve with its stdout. Rejects on failure. */
  runProbe?: (script: string, argv: ReadonlyArray<string>, timeoutMs: number) => Promise<string>;
  /** Does this path exist and is it executable? */
  exists?: (path: string) => Promise<boolean>;
  /** Epoch seconds, injected so cache-age rendering is deterministic. */
  nowSec?: () => number;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

async function defaultExists(path: string): Promise<boolean> {
  try {
    return await Bun.file(path).exists();
  } catch {
    return false;
  }
}

async function defaultRunProbe(
  script: string,
  argv: ReadonlyArray<string>,
  timeoutMs: number,
): Promise<string> {
  const r = await spawn({ cmd: script, argv, timeoutMs });
  return r.stdout;
}

/**
 * Run the budget report.
 *
 * Exit code is 0 whenever the probe RAN and at least one row was read —
 * including a report that says three budgets are at capacity. That is a
 * successful read of bad news, and the verdict lives in the rendered
 * text and in `--json`'s `ok` field.
 *
 * Nonzero is reserved for "could not measure anything at all": the probe
 * failed to run, or emitted nothing usable. That genuinely is a tool
 * failure, and the tool bridge is right to render it as one.
 *
 * The distinction matters because the bridge maps a nonzero exit to a
 * `verb_failed` envelope. An earlier version returned 1 on any degraded
 * budget, so "you are rate limited on Codex" reached the model as a
 * broken tool instead of as the answer. Caught by driving the real
 * bridge end to end.
 */
export async function tokenBudget(
  argv: ReadonlyArray<string>,
  deps: TokenBudgetDeps = {},
): Promise<number> {
  const args = parseTokenBudgetArgs(argv);
  // Allow-list gate lives HERE, not in the parser — see TokenBudgetArgs.
  if (!isBudgetProvider(args.provider)) {
    throw new UsageError({
      what: `token-budget: unknown provider ${JSON.stringify(args.provider)}`,
      hint: `--provider must be one of: ${BUDGET_PROVIDERS.join(", ")}`,
    });
  }
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? defaultExists;
  const runProbe = deps.runProbe ?? defaultRunProbe;
  const nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const log = deps.log ?? ((l: string) => console.log(l));
  const timeoutMs = args.timeoutMs ?? resolveBudgetProbeTimeoutMs(env);

  const candidates = budgetProbeCandidates(env);
  let script: string | null = null;
  for (const c of candidates) {
    if (await exists(c)) {
      script = c;
      break;
    }
  }
  if (script === null) {
    throw new ConfigError({
      what: "token-budget: budget probe script not found",
      hint:
        `looked in: ${candidates.length > 0 ? candidates.join(", ") : "(no HOME set)"}. ` +
        "Set ATMUX_BUDGET_PROBE to the probe-budgets.sh path, or install the budget skill.",
    });
  }

  let stdout: string;
  try {
    stdout = await runProbe(script, budgetProbeArgv(args), timeoutMs);
  } catch (e) {
    const detail =
      typeof e === "object" && e !== null && "stderr" in e && typeof e.stderr === "string"
        ? e.stderr
        : e instanceof Error
          ? e.message
          : String(e);
    const message = probeFailureMessage(detail);
    log(args.json ? JSON.stringify({ ok: false, error: message, rows: [] }) : message);
    return 1;
  }

  const parse = parseBudgetRows(stdout);
  const summary = summarizeBudget(parse, nowSec());
  if (args.json) {
    // Redacted on the way out too. `--json` passes the probe's rows
    // through, including its free-text `note`, so the JSON path must
    // carry the same guard the spoken path does — a leak that only
    // happens under a flag is still a leak.
    log(redactSecrets(JSON.stringify({ ok: summary.ok, summary, rows: parse.rows })));
  } else {
    log(renderBudgetReport(parse, nowSec()));
  }
  // Nothing readable at all is a tool failure; bad news is not.
  return parse.rows.length === 0 ? 1 : 0;
}
