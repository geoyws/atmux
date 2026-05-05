// ADR-010: CLI dispatcher — `cost` verb.
// Bash spec: lib/cost.sh @ worktree-frozen.
//
// Per-member USD + token usage tracking. Best-effort across TUIs:
//
//   - claude: parse `~/.claude/projects/<slug-of-cwd>/*.jsonl` files
//     newer than `since-epoch`, sum `assistant.message.usage` blocks
//     against the per-model pricing map (USD per million tokens).
//   - other TUIs: emit zero-shape with `source: "unknown"`.
//
// Each per-member detail is cached at `<atmuxDir>/state/cost-<name>.json`
// so subsequent invocations (whip ticks) can read the cache rather than
// re-parsing the full history every time. (The current implementation
// re-parses on every run; the cache file IS the cache, but no read-side
// invalidation logic exists yet — that's V-25 whip's call when it adds
// the cron loop.)
//
// `since-epoch` resolution order (mirrors bash:45-55):
//
//   1. `--since <value>` arg:
//      - all-digits → numeric epoch seconds
//      - else → `Date.parse` ISO/local string → epoch seconds (0 on parse fail)
//   2. `<atmuxDir>/state/session-start.txt` (written by `atmux start`)
//   3. `0` (start of epoch — count everything)

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { z } from "zod";
import { exists, statOrNull } from "../abstractions/fs.ts";
import { tryParseJsonString, tryReadJson } from "../abstractions/json.ts";
import { getAtmuxDir, type ResolveDirOpts, requireTeam, stateDir } from "../core/common.ts";
import { UsageError } from "../errors.ts";
import { DEFAULT_PRICING, Pricing, pricingFor } from "../schema/pricing.ts";
import type { TeamMember } from "../schema/team.ts";

const USAGE = "atmux cost [--member <name>] [--since <iso|epoch>] [--json]";

// ---------- Args ----------

export interface CostArgs {
  member?: string;
  since?: string;
  json: boolean;
  teamDir?: string;
}

/** Pure parser. Throws `UsageError` on bad invocation. */
export function parseCostArgs(argv: ReadonlyArray<string>): CostArgs {
  let member: string | undefined;
  let since: string | undefined;
  let json = false;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--member") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "cost: --member requires a value", hint: USAGE });
      }
      member = v;
      i += 2;
      continue;
    }
    if (a === "--since") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "cost: --since requires a value", hint: USAGE });
      }
      since = v;
      i += 2;
      continue;
    }
    if (a === "--json") {
      json = true;
      i += 1;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "cost: --team-dir requires a value", hint: USAGE });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    throw new UsageError({ what: `cost: unknown arg: ${a ?? ""}`, hint: USAGE });
  }
  const out: CostArgs = { json };
  if (member !== undefined) out.member = member;
  if (since !== undefined) out.since = since;
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

// ---------- Since resolution ----------

const ALL_DIGITS = /^[0-9]+$/;

/** Parse a `--since` string per bash:46-51. Numeric → epoch seconds;
 *  otherwise `Date.parse` (ISO 8601, RFC 2822, etc.). Returns `null` on
 *  parse failure so the caller can fall through to `session-start.txt`. */
export function parseSinceString(value: string): number | null {
  if (ALL_DIGITS.test(value)) return Number.parseInt(value, 10);
  const ms = Date.parse(value);
  if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  return null;
}

/** Read `<stateDir>/session-start.txt` as epoch seconds. Missing or
 *  unparseable → 0. */
export async function readSessionStartEpoch(atmuxDir: string): Promise<number> {
  const p = join(stateDir(atmuxDir), "session-start.txt");
  if (!(await exists(p))) return 0;
  const text = await readFile(p, "utf8");
  const n = Number.parseInt(text.trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Resolve effective since-epoch per the bash:45-55 cascade. */
export async function resolveSinceEpoch(args: CostArgs, atmuxDir: string): Promise<number> {
  if (args.since !== undefined && args.since !== "") {
    const parsed = parseSinceString(args.since);
    if (parsed !== null) return parsed;
    return 0; // bash:50 — `date -d "$since" +%s 2>/dev/null || echo 0`
  }
  return await readSessionStartEpoch(atmuxDir);
}

// ---------- Path helpers ----------

/** Slug a cwd → `~/.claude/projects/<slug>` directory name. Bash:112
 *  uses `${abs//\//-}` (replace every `/` with `-`); preserves the
 *  leading slash form (`/foo/bar` → `-foo-bar`). */
export function slugifyCwd(absPath: string): string {
  return absPath.replaceAll("/", "-");
}

/** `~/.claude/projects/<slug-of-cwd>/`. */
export function claudeProjectsDirFor(home: string, cwd: string): string {
  return join(home, ".claude", "projects", slugifyCwd(cwd));
}

// ---------- Pricing load ----------

/** Resolve the pricing map.
 *  - `$ATMUX_PRICING_FILE` set + readable + parseable → that.
 *  - else → `DEFAULT_PRICING` (bundled, mirrors lib/pricing.json). */
export async function loadPricing(env: NodeJS.ProcessEnv = process.env): Promise<Pricing> {
  const override = env.ATMUX_PRICING_FILE;
  if (override !== undefined && override !== "") {
    const got = await tryReadJson(override, Pricing);
    if (got !== null) return got;
  }
  return DEFAULT_PRICING;
}

// ---------- JSONL line shape ----------

/**
 * Minimal Zod shape for a Claude session JSONL `assistant` line. We
 * pluck `model` + the four token counters; everything else is ignored.
 * `passthrough()` so unknown / future fields don't fail the line-level
 * `tryParseJsonString` filter (those just become "skipped" lines).
 */
const AssistantLine = z
  .object({
    type: z.literal("assistant"),
    message: z
      .object({
        model: z.string().optional(),
        usage: z
          .object({
            input_tokens: z.number().optional(),
            output_tokens: z.number().optional(),
            cache_creation_input_tokens: z.number().optional(),
            cache_read_input_tokens: z.number().optional(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();
type AssistantLine = z.infer<typeof AssistantLine>;

// ---------- Per-block math ----------

export interface UsageDelta {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  usd: number;
}

/** Per-line USD + token contribution. Pure — no IO, no state. */
export function usageFromLine(line: AssistantLine, pricing: Pricing): UsageDelta {
  const u = line.message.usage;
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const p = pricingFor(pricing, line.message.model);
  const usd =
    (input * p.input) / 1_000_000 +
    (output * p.output) / 1_000_000 +
    (cacheWrite * p.cacheWrite) / 1_000_000 +
    (cacheRead * p.cacheRead) / 1_000_000;
  return { input, output, cacheWrite, cacheRead, usd };
}

/** Sum a fully-parsed `.jsonl` content string. Pure. */
export function sumUsageFromJsonl(text: string, pricing: Pricing): UsageDelta {
  const acc: UsageDelta = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, usd: 0 };
  for (const raw of text.split("\n")) {
    if (raw === "") continue;
    const line = tryParseJsonString(raw, AssistantLine);
    if (line === null) continue;
    const d = usageFromLine(line, pricing);
    acc.input += d.input;
    acc.output += d.output;
    acc.cacheWrite += d.cacheWrite;
    acc.cacheRead += d.cacheRead;
    acc.usd += d.usd;
  }
  return acc;
}

// ---------- File listing ----------

/**
 * List `.jsonl` files under `dir` whose mtime ≥ `sinceEpoch`. Mirrors
 * bash:117-123 with maxdepth=2 (Claude stores either flat
 * `<dir>/<uuid>.jsonl` or one level deeper for archived sessions).
 * Returns absolute paths sorted lexicographically (deterministic order
 * for testability).
 */
export async function listClaudeJsonlFiles(dir: string, sinceEpoch: number): Promise<string[]> {
  if (!(await exists(dir))) return [];
  const out: string[] = [];
  await walkUpToDepth(dir, 2, async (path, isFile) => {
    if (!isFile) return;
    if (!path.endsWith(".jsonl")) return;
    const s = await statOrNull(path);
    if (s === null) return;
    if (Math.floor(s.mtimeMs / 1000) < sinceEpoch) return;
    out.push(path);
  });
  out.sort();
  return out;
}

async function walkUpToDepth(
  dir: string,
  depth: number,
  visit: (path: string, isFile: boolean) => Promise<void>,
): Promise<void> {
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // dir vanished mid-walk — silent skip per bash's `2>/dev/null`
  }
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isFile()) {
      await visit(path, true);
    } else if (e.isDirectory() && depth > 1) {
      await walkUpToDepth(path, depth - 1, visit);
    }
  }
}

// ---------- Per-member cost ----------

/** Per-member cost detail. Mirrors bash's JSON output shape. */
export interface CostDetail {
  member: string;
  tui: string;
  usd: number;
  tokens: {
    input: number;
    output: number;
    cacheWrite: number;
    cacheRead: number;
    total: number;
  };
  source: string;
  files: string[];
}

/** Zero-shape for an unknown TUI (or claude with no project files). */
export function emptyDetail(member: string, tui: string, source: string): CostDetail {
  return {
    member,
    tui,
    usd: 0,
    tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 },
    source,
    files: [],
  };
}

export interface ComputeMemberOpts {
  /** `~` resolution; defaults to `os.homedir()`. */
  home?: string;
  /** Pricing map; defaults to `loadPricing()` cached at the call site. */
  pricing?: Pricing;
  /** Read fn override (test injection). */
  readFile?: (path: string) => Promise<string>;
  /** List fn override (test injection). */
  listFiles?: (dir: string, sinceEpoch: number) => Promise<string[]>;
}

/** Compute cost for one member. */
export async function computeMemberCost(
  member: TeamMember,
  sinceEpoch: number,
  opts: ComputeMemberOpts = {},
): Promise<CostDetail> {
  const tui = member.tui ?? "claude";
  if (tui !== "claude") return emptyDetail(member.name, tui, "unknown");

  const home = opts.home ?? homedir();
  const pricing = opts.pricing ?? (await loadPricing());
  const cwd = resolvePath(member.cwd ?? ".");
  const projDir = claudeProjectsDirFor(home, cwd);
  const list = opts.listFiles ?? listClaudeJsonlFiles;
  const files = await list(projDir, sinceEpoch);

  if (files.length === 0) {
    const empty = emptyDetail(member.name, "claude", "claude-jsonl");
    empty.files = [];
    return empty;
  }

  const read = opts.readFile ?? ((p: string) => readFile(p, "utf8"));
  const acc: UsageDelta = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, usd: 0 };
  for (const f of files) {
    const text = await read(f);
    const d = sumUsageFromJsonl(text, pricing);
    acc.input += d.input;
    acc.output += d.output;
    acc.cacheWrite += d.cacheWrite;
    acc.cacheRead += d.cacheRead;
    acc.usd += d.usd;
  }
  return {
    member: member.name,
    tui: "claude",
    usd: acc.usd,
    tokens: {
      input: acc.input,
      output: acc.output,
      cacheWrite: acc.cacheWrite,
      cacheRead: acc.cacheRead,
      total: acc.input + acc.output + acc.cacheWrite + acc.cacheRead,
    },
    source: "claude-jsonl",
    files,
  };
}

// ---------- Cache write ----------

/** Write per-member detail to `<stateDir>/cost-<name>.json`. */
export async function writeCostCache(atmuxDir: string, detail: CostDetail): Promise<void> {
  const dir = stateDir(atmuxDir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `cost-${detail.member}.json`), `${JSON.stringify(detail, null, 2)}\n`);
}

// ---------- Output formatters ----------

export interface CostReport {
  totalUsd: number;
  members: CostDetail[];
}

/** Format the JSON report (pretty-printed). */
export function formatJsonReport(report: CostReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** Format the text table — bash:84-91. Pure. */
export function formatTextReport(report: CostReport, sinceEpoch: number): string {
  const tsHuman = sinceEpoch > 0 ? formatEpochUtc(sinceEpoch) : "-";
  const lines: string[] = [];
  lines.push(`💰 cost — since ${tsHuman} (epoch ${sinceEpoch})`);
  lines.push("");
  lines.push("  MEMBER         USD        TOKENS       SOURCE");
  for (const m of report.members) {
    lines.push(
      `  ${pad(m.member, 14)} $${pad(m.usd.toFixed(4), 9)} ${pad(String(m.tokens.total), 12)} ${m.source}`,
    );
  }
  lines.push("");
  lines.push(`  TOTAL: $${report.totalUsd.toFixed(4)}`);
  return `${lines.join("\n")}\n`;
}

function pad(s: string, n: number): string {
  if (s.length >= n) return s;
  return s + " ".repeat(n - s.length);
}

/** `YYYY-MM-DD HH:MM:SS` in UTC. Bash uses local-tz `date -d @ts`; we
 *  pin UTC so test output is deterministic regardless of host timezone. */
export function formatEpochUtc(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const pad2 = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

// ---------- Public verb entry ----------

export interface CostOpts {
  /** stdout sink. Defaults to `process.stdout.write`. */
  stdout?: (line: string) => void;
  /** stderr sink. Defaults to `process.stderr.write`. */
  stderr?: (line: string) => void;
  /** ENV override (test injection). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Home dir override; defaults to `os.homedir()`. */
  home?: string;
  /** computeMemberCost override (test injection). */
  computeMember?: typeof computeMemberCost;
  /** writeCostCache override (test injection). */
  writeCache?: typeof writeCostCache;
}

export function defaultStdoutWrite(s: string): boolean {
  return process.stdout.write(s);
}

export function defaultStderrWrite(s: string): boolean {
  return process.stderr.write(s);
}

/** `atmux cost [--member <name>] [--since <iso|epoch>] [--json]`. */
export async function cost(argv: ReadonlyArray<string>, opts: CostOpts = {}): Promise<number> {
  const parsed = parseCostArgs(argv);
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const team = await requireTeam(dirOpts);
  const atmuxDir = await getAtmuxDir(dirOpts);

  const stdout = opts.stdout ?? defaultStdoutWrite;
  const env = opts.env ?? process.env;
  const sinceEpoch = await resolveSinceEpoch(parsed, atmuxDir);
  const pricing = await loadPricing(env);
  const computeFn = opts.computeMember ?? computeMemberCost;
  const cacheFn = opts.writeCache ?? writeCostCache;
  const homeOpt = opts.home ?? homedir();

  const members: CostDetail[] = [];
  let totalUsd = 0;
  for (const member of team.members) {
    if (parsed.member !== undefined && parsed.member !== member.name) continue;
    const detail = await computeFn(member, sinceEpoch, { home: homeOpt, pricing });
    members.push(detail);
    totalUsd += detail.usd;
    await cacheFn(atmuxDir, detail);
  }

  const report: CostReport = { totalUsd, members };
  if (parsed.json) {
    stdout(formatJsonReport(report));
  } else {
    stdout(formatTextReport(report, sinceEpoch));
  }
  return 0;
}

// ---------- Public team-cost helper (used by V-25 whip / report) ----------

/** Compute total cost for the whole team since `sinceEpoch`. Mirrors
 *  bash `atmux::compute_team_cost`. Doesn't write the per-member cache
 *  (callers that need persistence call `cost()` instead). */
export async function computeTeamCost(
  members: ReadonlyArray<TeamMember>,
  sinceEpoch: number,
  opts: ComputeMemberOpts = {},
): Promise<CostReport> {
  const pricing = opts.pricing ?? (await loadPricing());
  const home = opts.home ?? homedir();
  const out: CostDetail[] = [];
  let totalUsd = 0;
  for (const m of members) {
    const detail = await computeMemberCost(m, sinceEpoch, { ...opts, pricing, home });
    out.push(detail);
    totalUsd += detail.usd;
  }
  return { totalUsd, members: out };
}
