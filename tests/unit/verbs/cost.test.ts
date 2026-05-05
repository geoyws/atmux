// Unit tests for src/verbs/cost.ts (ADR-010).
// Bash spec ref: lib/cost.sh @ worktree-frozen.
//
// Coverage strategy
// -----------------
// Pure helpers (parseCostArgs, parseSinceString, slugifyCwd, claudeProjectsDirFor,
// usageFromLine, sumUsageFromJsonl, emptyDetail, formatJsonReport,
// formatTextReport, formatEpochUtc) tested directly. Side-effect helpers
// (readSessionStartEpoch, resolveSinceEpoch, loadPricing, listClaudeJsonlFiles,
// computeMemberCost, computeTeamCost, writeCostCache) tested against
// fixture .atmux/ + fixture ~/.claude/projects/. Public verb driven
// against fixture team.json with injected computeMember + writeCache.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import { DEFAULT_PRICING, type Pricing } from "../../../src/schema/pricing.ts";
import type { TeamMember } from "../../../src/schema/team.ts";
import {
  type CostDetail,
  type CostReport,
  claudeProjectsDirFor,
  computeMemberCost,
  computeTeamCost,
  cost,
  emptyDetail,
  formatEpochUtc,
  formatJsonReport,
  formatTextReport,
  listClaudeJsonlFiles,
  loadPricing,
  parseCostArgs,
  parseSinceString,
  readSessionStartEpoch,
  resolveSinceEpoch,
  slugifyCwd,
  sumUsageFromJsonl,
  usageFromLine,
  writeCostCache,
} from "../../../src/verbs/cost.ts";

// ---------- parseCostArgs ----------

describe("parseCostArgs", () => {
  test("default — json=false, no member/since/teamDir", () => {
    expect(parseCostArgs([])).toEqual({ json: false });
  });

  test("--member captured", () => {
    expect(parseCostArgs(["--member", "alpha"])).toEqual({ json: false, member: "alpha" });
  });

  test("--since captured", () => {
    expect(parseCostArgs(["--since", "1700000000"])).toEqual({
      json: false,
      since: "1700000000",
    });
  });

  test("--json flips json to true", () => {
    expect(parseCostArgs(["--json"])).toEqual({ json: true });
  });

  test("--team-dir captured", () => {
    expect(parseCostArgs(["--team-dir", "/x"])).toEqual({ json: false, teamDir: "/x" });
  });

  test("multiple flags combine", () => {
    expect(parseCostArgs(["--member", "a", "--since", "X", "--json"])).toEqual({
      json: true,
      member: "a",
      since: "X",
    });
  });

  test("--member without value → UsageError", () => {
    expect(() => parseCostArgs(["--member"])).toThrow(UsageError);
  });

  test("--since without value → UsageError", () => {
    expect(() => parseCostArgs(["--since"])).toThrow(UsageError);
  });

  test("--team-dir without value → UsageError", () => {
    expect(() => parseCostArgs(["--team-dir"])).toThrow(UsageError);
  });

  test("unknown flag → UsageError", () => {
    expect(() => parseCostArgs(["--bogus"])).toThrow(UsageError);
  });
});

// ---------- parseSinceString ----------

describe("parseSinceString", () => {
  test("all-digits → epoch seconds", () => {
    expect(parseSinceString("1700000000")).toBe(1_700_000_000);
  });

  test("ISO 8601 string → epoch seconds (UTC)", () => {
    expect(parseSinceString("2026-01-01T00:00:00Z")).toBe(Math.floor(Date.UTC(2026, 0, 1) / 1000));
  });

  test("non-numeric, unparseable → null", () => {
    expect(parseSinceString("not-a-date")).toBeNull();
  });
});

// ---------- slugifyCwd / claudeProjectsDirFor ----------

describe("slugifyCwd", () => {
  test("/foo/bar → -foo-bar (every / to -)", () => {
    expect(slugifyCwd("/foo/bar")).toBe("-foo-bar");
  });

  test("path with trailing slash preserved", () => {
    expect(slugifyCwd("/foo/bar/")).toBe("-foo-bar-");
  });
});

describe("claudeProjectsDirFor", () => {
  test("composes home + .claude/projects + slug", () => {
    expect(claudeProjectsDirFor("/home/u", "/work/x")).toBe("/home/u/.claude/projects/-work-x");
  });
});

// ---------- usageFromLine + sumUsageFromJsonl ----------

const opusModel = "claude-opus-4-7";
const opusPriced = DEFAULT_PRICING["claude-opus-4-7"];
if (opusPriced === undefined) throw new Error("test setup: missing opus pricing");

describe("usageFromLine", () => {
  test("computes per-class USD with opus pricing", () => {
    const d = usageFromLine(
      {
        type: "assistant",
        message: {
          model: opusModel,
          usage: {
            input_tokens: 1_000_000,
            output_tokens: 500_000,
            cache_creation_input_tokens: 200_000,
            cache_read_input_tokens: 100_000,
          },
        },
      },
      DEFAULT_PRICING,
    );
    expect(d.input).toBe(1_000_000);
    expect(d.output).toBe(500_000);
    expect(d.cacheWrite).toBe(200_000);
    expect(d.cacheRead).toBe(100_000);
    // opus: input=15, output=75, cacheWrite=18.75, cacheRead=1.5 (per million)
    // 1*15 + 0.5*75 + 0.2*18.75 + 0.1*1.5 = 15 + 37.5 + 3.75 + 0.15 = 56.4
    expect(d.usd).toBeCloseTo(56.4, 6);
  });

  test("missing tokens default to 0; missing model uses default pricing", () => {
    const d = usageFromLine({ type: "assistant", message: { usage: {} } }, DEFAULT_PRICING);
    expect(d.input).toBe(0);
    expect(d.output).toBe(0);
    expect(d.cacheWrite).toBe(0);
    expect(d.cacheRead).toBe(0);
    expect(d.usd).toBe(0);
  });
});

describe("sumUsageFromJsonl", () => {
  const assistant1 = JSON.stringify({
    type: "assistant",
    message: {
      model: opusModel,
      usage: { input_tokens: 1000, output_tokens: 100 },
    },
  });
  const assistant2 = JSON.stringify({
    type: "assistant",
    message: {
      model: opusModel,
      usage: { input_tokens: 500, output_tokens: 50, cache_read_input_tokens: 200 },
    },
  });
  const userLine = JSON.stringify({ type: "user", message: { content: "hi" } });

  test("sums valid assistant lines, skips other line types", () => {
    const text = [userLine, assistant1, "", assistant2, "not-json", "{}"].join("\n");
    const got = sumUsageFromJsonl(text, DEFAULT_PRICING);
    expect(got.input).toBe(1500);
    expect(got.output).toBe(150);
    expect(got.cacheRead).toBe(200);
    expect(got.cacheWrite).toBe(0);
    // (1500*15 + 150*75 + 200*1.5) / 1M = (22500 + 11250 + 300) / 1M = 0.03405
    expect(got.usd).toBeCloseTo(0.03405, 6);
  });

  test("empty input → all zeros", () => {
    expect(sumUsageFromJsonl("", DEFAULT_PRICING)).toEqual({
      input: 0,
      output: 0,
      cacheWrite: 0,
      cacheRead: 0,
      usd: 0,
    });
  });
});

// ---------- emptyDetail + formatters ----------

describe("emptyDetail", () => {
  test("zero shape with the supplied source label", () => {
    expect(emptyDetail("alpha", "opencode", "unknown")).toEqual({
      member: "alpha",
      tui: "opencode",
      usd: 0,
      tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 },
      source: "unknown",
      files: [],
    });
  });
});

describe("formatJsonReport", () => {
  test("pretty-prints with trailing newline", () => {
    const report: CostReport = {
      totalUsd: 1.234,
      members: [emptyDetail("a", "claude", "claude-jsonl")],
    };
    const out = formatJsonReport(report);
    expect(out.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(out.trim()) as CostReport;
    expect(parsed.totalUsd).toBe(1.234);
    expect(parsed.members[0]?.member).toBe("a");
  });
});

describe("formatTextReport", () => {
  test("renders header + table + total", () => {
    const out = formatTextReport(
      {
        totalUsd: 0.5,
        members: [
          {
            member: "alpha",
            tui: "claude",
            usd: 0.25,
            tokens: { input: 100, output: 50, cacheWrite: 0, cacheRead: 0, total: 150 },
            source: "claude-jsonl",
            files: [],
          },
        ],
      },
      1_700_000_000,
    );
    expect(out).toContain("💰 cost — since 2023-11-14 22:13:20 (epoch 1700000000)");
    expect(out).toContain("MEMBER");
    expect(out).toContain("alpha");
    expect(out).toContain("$0.2500");
    expect(out).toContain("150");
    expect(out).toContain("claude-jsonl");
    expect(out).toContain("TOTAL: $0.5000");
  });

  test("epoch=0 renders timestamp as '-'", () => {
    const out = formatTextReport({ totalUsd: 0, members: [] }, 0);
    expect(out).toContain("since - (epoch 0)");
  });

  test("padding works when member name exceeds column width (no truncation)", () => {
    const out = formatTextReport(
      {
        totalUsd: 0,
        members: [
          {
            member: "very-long-member-name-here",
            tui: "claude",
            usd: 0,
            tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 },
            source: "claude-jsonl",
            files: [],
          },
        ],
      },
      0,
    );
    expect(out).toContain("very-long-member-name-here");
  });
});

describe("formatEpochUtc", () => {
  test("YYYY-MM-DD HH:MM:SS in UTC", () => {
    expect(formatEpochUtc(0)).toBe("1970-01-01 00:00:00");
    expect(formatEpochUtc(Math.floor(Date.UTC(2026, 0, 5, 14, 30, 45) / 1000))).toBe(
      "2026-01-05 14:30:45",
    );
  });
});

// ---------- readSessionStartEpoch + resolveSinceEpoch ----------

describe("readSessionStartEpoch", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atmux-cost-since-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("returns 0 when state/session-start.txt absent", async () => {
    expect(await readSessionStartEpoch(dir)).toBe(0);
  });

  test("returns epoch when file has integer", async () => {
    await mkdir(join(dir, "state"), { recursive: true });
    await writeFile(join(dir, "state", "session-start.txt"), "1700000000\n");
    expect(await readSessionStartEpoch(dir)).toBe(1_700_000_000);
  });

  test("returns 0 on malformed contents", async () => {
    await mkdir(join(dir, "state"), { recursive: true });
    await writeFile(join(dir, "state", "session-start.txt"), "garbage\n");
    expect(await readSessionStartEpoch(dir)).toBe(0);
  });

  test("returns 0 on negative contents", async () => {
    await mkdir(join(dir, "state"), { recursive: true });
    await writeFile(join(dir, "state", "session-start.txt"), "-1\n");
    expect(await readSessionStartEpoch(dir)).toBe(0);
  });
});

describe("resolveSinceEpoch", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atmux-cost-resolve-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("--since numeric → that epoch", async () => {
    expect(await resolveSinceEpoch({ json: false, since: "1234" }, dir)).toBe(1234);
  });

  test("--since ISO → parsed epoch", async () => {
    expect(await resolveSinceEpoch({ json: false, since: "2026-01-01T00:00:00Z" }, dir)).toBe(
      Math.floor(Date.UTC(2026, 0, 1) / 1000),
    );
  });

  test("--since unparseable → 0 (bash:50 short-circuit)", async () => {
    expect(await resolveSinceEpoch({ json: false, since: "garbage-string" }, dir)).toBe(0);
  });

  test("--since empty string → falls through to session-start.txt", async () => {
    await mkdir(join(dir, "state"), { recursive: true });
    await writeFile(join(dir, "state", "session-start.txt"), "999\n");
    expect(await resolveSinceEpoch({ json: false, since: "" }, dir)).toBe(999);
  });

  test("no --since → reads session-start.txt", async () => {
    await mkdir(join(dir, "state"), { recursive: true });
    await writeFile(join(dir, "state", "session-start.txt"), "777\n");
    expect(await resolveSinceEpoch({ json: false }, dir)).toBe(777);
  });

  test("no --since + no session-start.txt → 0", async () => {
    expect(await resolveSinceEpoch({ json: false }, dir)).toBe(0);
  });
});

// ---------- loadPricing ----------

describe("loadPricing", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atmux-cost-pricing-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("ATMUX_PRICING_FILE absent → DEFAULT_PRICING", async () => {
    const p = await loadPricing({});
    expect(p).toBe(DEFAULT_PRICING);
  });

  test("ATMUX_PRICING_FILE empty string → DEFAULT_PRICING", async () => {
    const p = await loadPricing({ ATMUX_PRICING_FILE: "" });
    expect(p).toBe(DEFAULT_PRICING);
  });

  test("ATMUX_PRICING_FILE points to readable JSON → parsed", async () => {
    const f = join(dir, "pricing.json");
    await writeFile(
      f,
      JSON.stringify({
        default: { input: 9, output: 9, cacheWrite: 9, cacheRead: 9 },
        "custom-model": { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 },
      }),
    );
    const p = await loadPricing({ ATMUX_PRICING_FILE: f });
    expect(p.default.input).toBe(9);
  });

  test("ATMUX_PRICING_FILE points to missing file → DEFAULT_PRICING", async () => {
    const p = await loadPricing({ ATMUX_PRICING_FILE: join(dir, "nope.json") });
    expect(p).toBe(DEFAULT_PRICING);
  });
});

// ---------- listClaudeJsonlFiles ----------

describe("listClaudeJsonlFiles", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atmux-cost-list-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("returns [] when dir does not exist", async () => {
    expect(await listClaudeJsonlFiles(join(dir, "nope"), 0)).toEqual([]);
  });

  test("returns matching .jsonl files newer than sinceEpoch", async () => {
    const old = join(dir, "old.jsonl");
    const fresh = join(dir, "fresh.jsonl");
    await writeFile(old, "{}\n");
    await writeFile(fresh, "{}\n");
    // Force `old` to be older than the cutoff.
    const past = new Date(1_000_000 * 1000);
    await utimes(old, past, past);
    const files = await listClaudeJsonlFiles(dir, 2_000_000);
    expect(files).toEqual([fresh]);
  });

  test("recurses into 1 level of subdirs (maxdepth=2)", async () => {
    const sub = join(dir, "sub");
    await mkdir(sub);
    const f1 = join(dir, "a.jsonl");
    const f2 = join(sub, "b.jsonl");
    await writeFile(f1, "{}\n");
    await writeFile(f2, "{}\n");
    const files = await listClaudeJsonlFiles(dir, 0);
    expect(files.sort()).toEqual([f1, f2].sort());
  });

  test("ignores non-.jsonl files", async () => {
    await writeFile(join(dir, "x.json"), "{}\n");
    await writeFile(join(dir, "y.txt"), "x");
    expect(await listClaudeJsonlFiles(dir, 0)).toEqual([]);
  });

  test("returns [] when path resolves to a file (readdir → ENOTDIR caught)", async () => {
    // exists() returns true for a regular file, but readdir on it
    // throws ENOTDIR — exercises the catch in walkUpToDepth (the
    // race-safety guard mirrored from bash's `find ... 2>/dev/null`).
    const f = join(dir, "regular-file");
    await writeFile(f, "not a directory");
    expect(await listClaudeJsonlFiles(f, 0)).toEqual([]);
  });
});

// ---------- computeMemberCost ----------

describe("computeMemberCost", () => {
  let home: string;
  let projDir: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "atmux-cost-home-"));
    projDir = join(home, ".claude", "projects", "-work-cwd");
    await mkdir(projDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("non-claude TUI → empty detail with source=unknown", async () => {
    const m: TeamMember = { name: "alpha", tui: "opencode", cwd: "/work/cwd" };
    const detail = await computeMemberCost(m, 0, { home });
    expect(detail.source).toBe("unknown");
    expect(detail.tui).toBe("opencode");
    expect(detail.usd).toBe(0);
  });

  test("claude TUI, no project dir → claude-jsonl source, zeroes", async () => {
    const m: TeamMember = { name: "ghost", tui: "claude", cwd: "/work/missing" };
    const detail = await computeMemberCost(m, 0, { home });
    expect(detail.source).toBe("claude-jsonl");
    expect(detail.usd).toBe(0);
    expect(detail.files).toEqual([]);
  });

  test("claude TUI, jsonl file present → tokens + usd summed", async () => {
    await writeFile(
      join(projDir, "session.jsonl"),
      [
        JSON.stringify({
          type: "assistant",
          message: { model: opusModel, usage: { input_tokens: 1000, output_tokens: 100 } },
        }),
      ].join("\n"),
    );
    const m: TeamMember = { name: "alpha", tui: "claude", cwd: "/work/cwd" };
    const detail = await computeMemberCost(m, 0, { home });
    expect(detail.tokens.input).toBe(1000);
    expect(detail.tokens.output).toBe(100);
    expect(detail.tokens.total).toBe(1100);
    expect(detail.files).toHaveLength(1);
    expect(detail.usd).toBeCloseTo((1000 * 15 + 100 * 75) / 1_000_000, 6);
  });

  test("defaults tui to 'claude' when unset on member", async () => {
    const m: TeamMember = { name: "alpha", cwd: "/work/cwd" };
    const detail = await computeMemberCost(m, 0, { home });
    expect(detail.tui).toBe("claude");
  });

  test("defaults cwd to '.' when member has no cwd", async () => {
    // Resolves to process.cwd(); the projects dir won't exist under
    // our mock $HOME, so detail.files is []. The point is that the
    // verb doesn't crash without a cwd.
    const m: TeamMember = { name: "alpha", tui: "claude" };
    const detail = await computeMemberCost(m, 0, { home });
    expect(detail.source).toBe("claude-jsonl");
    expect(detail.files).toEqual([]);
  });

  test("listFiles + readFile injection — exercises both opts paths", async () => {
    const m: TeamMember = { name: "alpha", tui: "claude", cwd: "/work/cwd" };
    const detail = await computeMemberCost(m, 0, {
      home,
      listFiles: async () => ["/fake/a.jsonl", "/fake/b.jsonl"],
      readFile: async () =>
        JSON.stringify({
          type: "assistant",
          message: { model: opusModel, usage: { input_tokens: 100, output_tokens: 10 } },
        }),
    });
    expect(detail.tokens.input).toBe(200); // both files contribute
    expect(detail.files).toHaveLength(2);
  });

  test("custom pricing override applied", async () => {
    const customPricing: Pricing = {
      default: { input: 100, output: 0, cacheWrite: 0, cacheRead: 0 },
    };
    const detail = await computeMemberCost({ name: "alpha", tui: "claude", cwd: "/work/cwd" }, 0, {
      home,
      pricing: customPricing,
      listFiles: async () => ["/fake/a.jsonl"],
      readFile: async () =>
        JSON.stringify({
          type: "assistant",
          message: { usage: { input_tokens: 1_000_000 } },
        }),
    });
    // 1M input × 100/M = 100 USD
    expect(detail.usd).toBe(100);
  });
});

// ---------- writeCostCache ----------

describe("writeCostCache", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atmux-cost-cache-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("writes <atmuxDir>/state/cost-<member>.json with pretty JSON", async () => {
    const detail: CostDetail = emptyDetail("alpha", "claude", "claude-jsonl");
    await writeCostCache(dir, detail);
    const text = await readFile(join(dir, "state", "cost-alpha.json"), "utf8");
    const parsed = JSON.parse(text) as CostDetail;
    expect(parsed.member).toBe("alpha");
    expect(text.endsWith("\n")).toBe(true);
  });
});

// ---------- computeTeamCost ----------

describe("computeTeamCost", () => {
  test("aggregates per-member detail + totalUsd", async () => {
    const home = await mkdtemp(join(tmpdir(), "atmux-cost-team-"));
    try {
      const members: TeamMember[] = [
        { name: "alpha", tui: "opencode" },
        { name: "bravo", tui: "claude", cwd: "/work/missing" },
      ];
      const report = await computeTeamCost(members, 0, { home });
      expect(report.members).toHaveLength(2);
      expect(report.totalUsd).toBe(0);
      expect(report.members[0]?.source).toBe("unknown");
      expect(report.members[1]?.source).toBe("claude-jsonl");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("uses default pricing when opts.pricing omitted", async () => {
    const home = await mkdtemp(join(tmpdir(), "atmux-cost-team-pricing-"));
    try {
      const report = await computeTeamCost([{ name: "x", tui: "opencode" }], 0, { home });
      expect(report.totalUsd).toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

// ---------- cost() — public verb ----------

describe("cost() — public verb", () => {
  let teamDir: string;
  let atmuxDir: string;
  let stdoutBuf: string;
  const stdout = (s: string): void => {
    stdoutBuf += s;
  };

  beforeEach(async () => {
    teamDir = await mkdtemp(join(tmpdir(), "atmux-cost-verb-"));
    atmuxDir = join(teamDir, ".atmux");
    stdoutBuf = "";
  });
  afterEach(async () => {
    await rm(teamDir, { recursive: true, force: true });
  });

  const seedTeam = async (name: string, members: TeamMember[]): Promise<void> => {
    await mkdir(atmuxDir, { recursive: true });
    await writeFile(join(atmuxDir, "team.json"), JSON.stringify({ name, members }));
  };

  test("UsageError on unknown arg propagates", async () => {
    await expect(cost(["--bogus"])).rejects.toBeInstanceOf(UsageError);
  });

  test("ConfigError when no team.json", async () => {
    await expect(cost(["--team-dir", teamDir])).rejects.toBeInstanceOf(ConfigError);
  });

  test("text output (default) — header + per-member rows + total", async () => {
    await seedTeam("demo", [
      { name: "alpha", tui: "opencode" },
      { name: "bravo", tui: "opencode" },
    ]);
    const exit = await cost(["--team-dir", teamDir, "--since", "0"], { stdout });
    expect(exit).toBe(0);
    expect(stdoutBuf).toContain("💰 cost — since");
    expect(stdoutBuf).toContain("alpha");
    expect(stdoutBuf).toContain("bravo");
    expect(stdoutBuf).toContain("TOTAL: $0.0000");
    // Cache files written.
    const a = JSON.parse(
      await readFile(join(atmuxDir, "state", "cost-alpha.json"), "utf8"),
    ) as CostDetail;
    expect(a.member).toBe("alpha");
  });

  test("--json output — valid JSON envelope", async () => {
    await seedTeam("demo", [{ name: "alpha", tui: "opencode" }]);
    await cost(["--team-dir", teamDir, "--since", "0", "--json"], { stdout });
    const parsed = JSON.parse(stdoutBuf) as CostReport;
    expect(parsed.totalUsd).toBe(0);
    expect(parsed.members[0]?.member).toBe("alpha");
  });

  test("--member filters to one row + writes only its cache", async () => {
    await seedTeam("demo", [
      { name: "alpha", tui: "opencode" },
      { name: "bravo", tui: "opencode" },
    ]);
    await cost(["--team-dir", teamDir, "--since", "0", "--member", "bravo"], { stdout });
    expect(stdoutBuf).toContain("bravo");
    expect(stdoutBuf).not.toContain("  alpha   "); // narrow check — bravo only
    // Only bravo's cache exists.
    const cacheA = await readFile(join(atmuxDir, "state", "cost-alpha.json"), "utf8").catch(
      () => null,
    );
    const cacheB = await readFile(join(atmuxDir, "state", "cost-bravo.json"), "utf8");
    expect(cacheA).toBeNull();
    expect(cacheB).toContain("bravo");
  });

  test("delegates to injected computeMember + writeCache", async () => {
    await seedTeam("demo", [{ name: "alpha", tui: "claude", cwd: "/x" }]);
    let computeCalls = 0;
    let cacheCalls = 0;
    await cost(["--team-dir", teamDir, "--since", "100"], {
      stdout,
      computeMember: async (m) => {
        computeCalls += 1;
        return {
          member: m.name,
          tui: "claude",
          usd: 1.23,
          tokens: { input: 1, output: 2, cacheWrite: 3, cacheRead: 4, total: 10 },
          source: "claude-jsonl",
          files: ["/fake.jsonl"],
        };
      },
      writeCache: async () => {
        cacheCalls += 1;
      },
    });
    expect(computeCalls).toBe(1);
    expect(cacheCalls).toBe(1);
    expect(stdoutBuf).toContain("$1.2300");
    expect(stdoutBuf).toContain("TOTAL: $1.2300");
  });

  test("default stdout sink engaged when opts omit it", async () => {
    await seedTeam("demo", [{ name: "alpha", tui: "opencode" }]);
    let captured = "";
    const origStdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string | Uint8Array) => {
      captured += typeof s === "string" ? s : new TextDecoder().decode(s);
      return true;
    }) as typeof process.stdout.write;
    try {
      await cost(["--team-dir", teamDir, "--since", "0"]);
    } finally {
      process.stdout.write = origStdout;
    }
    expect(captured).toContain("alpha");
  });
});
