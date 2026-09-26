// e-50 T4 (t-c56842cb): `atmux budget collect|report` verb tests.
// Hermetic: stubbed probes + temp HOME (never the operator's
// budget.db, never the network). Live proof rides the T4 smoke run.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withBudgetDb } from "../../../src/core/budget-db.ts";
import type { UsageRow } from "../../../src/abstractions/usage-adapters.ts";
import {
  budget,
  collectBudget,
  parseBudgetArgs,
  renderReset,
  reportBudget,
} from "../../../src/verbs/budget.ts";

function row(provider: string, account: string, metric: string, value: number | null): UsageRow {
  return { provider, account, metric, value, valueText: null, unit: "pct", ok: 1, error: null };
}

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "budget-test-"));
}

describe("parseBudgetArgs", () => {
  test("collect + report defaults", () => {
    expect(parseBudgetArgs(["collect"])).toMatchObject({ subcommand: "collect", json: false, window: "24h", live: false });
    expect(parseBudgetArgs(["report", "--window", "7d", "--provider", "zai", "--live", "--json"])).toMatchObject({
      subcommand: "report",
      window: "7d",
      provider: "zai",
      live: true,
      json: true,
    });
  });

  test("rejects bad invocations", () => {
    for (const argv of [
      [],
      ["tally"],
      ["report", "--window", "30d"],
      ["report", "--provider"],
      ["collect", "--live"],
      ["collect", "--window", "7d"],
      ["collect", "--provider", "zai"],
    ]) {
      expect(() => parseBudgetArgs(argv)).toThrow();
    }
  });
});

describe("collectBudget", () => {
  test("one batch, shared ts, rows readable back", async () => {
    const home = tempHome();
    const probe = async (): Promise<UsageRow[]> => [
      row("zai", "zai", "util_5h", 30),
      { provider: "kimi", account: "kimi", metric: "status", value: null, valueText: null, unit: "enum", ok: 0, error: "boom" },
    ];
    const summary = await collectBudget({ home, probe, now: () => "2026-09-26T00:00:00.000Z" });
    expect(summary).toMatchObject({ ts: "2026-09-26T00:00:00.000Z", rows: 2, ok: 1, failed: 1 });
    const stored = await withBudgetDb(
      (db) =>
        db.query("SELECT provider, metric, value, ok, error, raw_json FROM usage_snapshot").all() as Array<{
          provider: string;
          metric: string;
          value: number | null;
          ok: number;
          error: string | null;
          raw_json: string | null;
        }>,
      { home },
    );
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({ provider: "zai", metric: "util_5h", value: 30, ok: 1 });
    expect(stored[1]).toMatchObject({ provider: "kimi", ok: 0, error: "boom", raw_json: null });
  });
});

describe("reportBudget", () => {
  async function seed(home: string): Promise<void> {
    await collectBudget({
      home,
      now: () => "2026-09-26T00:00:00.000Z",
      probe: async () => [row("zai", "zai", "util_5h", 20), row("zai", "zai", "util_weekly", 10)],
    });
    await collectBudget({
      home,
      now: () => "2026-09-26T12:00:00.000Z",
      probe: async () => [row("zai", "zai", "util_5h", 30), row("zai", "zai", "util_weekly", 15)],
    });
  }

  test("latest batch + deltas vs window start; actuals null outside a team", async () => {
    const home = tempHome();
    await seed(home);
    const rep = await reportBudget(
      { subcommand: "report", json: false, window: "24h", live: false },
      { home, cwd: home },
    );
    expect(rep.ts).toBe("2026-09-26T12:00:00.000Z");
    expect(rep.accounts).toHaveLength(1);
    const acc = rep.accounts[0];
    expect(acc?.metrics.util_5h?.value).toBe(30);
    expect(acc?.delta5h).toBe(10);
    expect(acc?.deltaWeekly).toBe(5);
    expect(acc?.actualUsd).toBeNull();
  });

  test("provider filter + empty db", async () => {
    const home = tempHome();
    await seed(home);
    const filtered = await reportBudget(
      { subcommand: "report", json: false, window: "24h", provider: "deepseek", live: false },
      { home, cwd: home },
    );
    expect(filtered.accounts).toHaveLength(0);
    const empty = await reportBudget(
      { subcommand: "report", json: false, window: "24h", live: false },
      { home: tempHome(), cwd: home },
    );
    expect(empty.accounts).toHaveLength(0);
    expect(empty.ts).toBe("");
  });
});

describe("renderReset", () => {
  test("epoch_ms renders absolute + relative", () => {
    const s = renderReset(Date.now() + 3600_000, null, "epoch_ms");
    expect(s).toContain("in 1h");
  });

  test("iso8601 + passthrough shapes", () => {
    expect(renderReset(null, "2026-08-01T00:00:00Z", "iso8601")).toContain("2026");
    expect(renderReset(null, "available", "enum")).toBe("available");
    expect(renderReset(null, null, null)).toBe("unknown");
  });
});

describe("budget entry", () => {
  test("collect --json prints the summary; report with no snapshots exits 1", async () => {
    const home = tempHome();
    const lines: string[] = [];
    const errs: string[] = [];
    const code = await budget(["collect", "--json"], {
      home,
      probe: async () => [row("zai", "zai", "util_5h", 1)],
      now: () => "2026-09-26T00:00:00.000Z",
      stdout: (s: string) => {
        lines.push(s);
      },
      stderr: (s: string) => {
        errs.push(s);
      },
    });
    expect(code).toBe(0);
    expect(JSON.parse(lines.join(""))).toMatchObject({ rows: 1, ok: 1 });
    const code2 = await budget(["report"], {
      home: tempHome(),
      cwd: home,
      stdout: (s: string) => {
        lines.push(s);
      },
      stderr: (s: string) => {
        errs.push(s);
      },
    });
    expect(code2).toBe(1);
    expect(errs.join("")).toContain("no snapshots");
  });
});
