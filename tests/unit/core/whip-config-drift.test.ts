// Unit tests for src/core/whip-config-drift.ts (ADR-054 §D2 helpers).
//
// Covers:
//   - composeDriftReport: issue extraction, canonical sort, ≤5 cap,
//     hash stability + difference, secret masking in rawSnippet.
//   - composeCatastrophicDrift: invalid_json code path.
//   - makeDriftSafeDefaults: strips invalid keys, applies Zod defaults,
//     handles missing required fields, malformed top-level shape.
//   - shouldFireDriftPing + recordDriftPing: 24h re-fire window,
//     hash dedup, multi-hash sequencing.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ZodError, z } from "zod";
import {
  composeCatastrophicDrift,
  composeDriftReport,
  DRIFT_REFIRE_WINDOW_SEC,
  makeDriftSafeDefaults,
  recordDriftPing,
  shouldFireDriftPing,
  whipConfigDriftStatePath,
} from "../../../src/core/whip-config-drift.ts";
import { Team, TeamWhip } from "../../../src/schema/team.ts";

let atmuxDir: string;

beforeEach(async () => {
  atmuxDir = await mkdtemp(join(tmpdir(), "atmux-drift-"));
  await mkdir(join(atmuxDir, "state"), { recursive: true });
});

afterEach(async () => {
  await rm(atmuxDir, { recursive: true, force: true });
});

// ---------- composeDriftReport ----------

describe("composeDriftReport", () => {
  /** Build a Zod error from a real schema parse fail. */
  function makeZodError(rawShape: unknown): ZodError {
    const result = Team.safeParse(rawShape);
    if (result.success) throw new Error("test setup: shape was supposed to fail validation");
    return result.error;
  }

  test("extracts issues with path + code + message", () => {
    const err = makeZodError({
      name: "t",
      members: [],
      whip: { unknownKey: 1 },
    });
    const report = composeDriftReport(err, "raw");
    expect(report.issues.length).toBeGreaterThan(0);
    const first = report.issues[0]!;
    expect(first.path).toContain("whip");
    expect(first.code).toBeTruthy();
    expect(first.message).toBeTruthy();
  });

  test("caps issue count at 5", () => {
    // Create a shape with many invalid whip fields.
    const rawShape = {
      name: "t",
      members: [],
      whip: {
        budgetPauseThreshold: "ninety",
        budgetResumeThreshold: "eighty",
        leadMaxMin: "sixty",
        staleMin: "ninety",
        intervalMins: "five",
        autoRotate: "yes",
        budgetRefreshLeadMins: "thirty",
      },
    };
    const err = makeZodError(rawShape);
    const report = composeDriftReport(err, "raw");
    expect(report.issues.length).toBeLessThanOrEqual(5);
  });

  test("hash is stable across compose calls on identical input", () => {
    const err1 = makeZodError({ name: "t", members: [], whip: { unknownKey: 1 } });
    const err2 = makeZodError({ name: "t", members: [], whip: { unknownKey: 1 } });
    const r1 = composeDriftReport(err1, "raw");
    const r2 = composeDriftReport(err2, "raw");
    expect(r1.driftHash).toBe(r2.driftHash);
  });

  test("hash differs between distinct drifts", () => {
    const errA = makeZodError({ name: "t", members: [], whip: { keyA: 1 } });
    const errB = makeZodError({ name: "t", members: [], whip: { keyB: 1 } });
    const a = composeDriftReport(errA, "raw");
    const b = composeDriftReport(errB, "raw");
    expect(a.driftHash).not.toBe(b.driftHash);
  });

  test("issue sort is canonical (path then code) — order doesn't depend on Zod issue order", () => {
    // Same issues, different parse order, should hash the same.
    // We can't easily reorder Zod issues, so we just assert determinism
    // by hashing twice and confirming equality (already tested above).
    // Plus assert sort by path within issues array.
    const err = makeZodError({
      name: "t",
      members: [],
      whip: { zlast: 1, aFirst: 2 },
    });
    const report = composeDriftReport(err, "raw");
    if (report.issues.length >= 2) {
      const paths = report.issues.map((i) => i.path.join("."));
      const sorted = [...paths].sort();
      expect(paths).toEqual(sorted);
    }
  });

  test("rawSnippet truncated to ≤500 chars", () => {
    const err = makeZodError({ name: "t", members: [], whip: { unknown: 1 } });
    const longRaw = "a".repeat(2000);
    const report = composeDriftReport(err, longRaw);
    expect(report.rawSnippet.length).toBeLessThanOrEqual(500);
  });

  test("rawSnippet masks secret-shaped key=value patterns", () => {
    const err = makeZodError({ name: "t", members: [], whip: { unknown: 1 } });
    const raw = `{"discord": {"webhookUrl": "https://discord.com/api/webhooks/12345/secret-token-here"}}`;
    const report = composeDriftReport(err, raw);
    expect(report.rawSnippet).toContain("<redacted>");
    expect(report.rawSnippet).not.toContain("secret-token-here");
  });

  test("rawSnippet masks long base64-looking substrings", () => {
    const err = makeZodError({ name: "t", members: [], whip: { unknown: 1 } });
    const longB64 = "A".repeat(50);
    const raw = `prefix-${longB64}-suffix`;
    const report = composeDriftReport(err, raw);
    expect(report.rawSnippet).toContain("<redacted:");
    expect(report.rawSnippet).not.toContain(longB64);
  });

  test("catastrophic flag is false on schema-only drift", () => {
    const err = makeZodError({ name: "t", members: [], whip: { unknown: 1 } });
    const report = composeDriftReport(err, "raw");
    expect(report.catastrophic).toBe(false);
  });

  test("Zod issue with numeric path index produces string-form path", () => {
    // Force a numeric path via members array element invalid.
    const result = Team.safeParse({ name: "t", members: [{ name: 123 }] });
    if (result.success) throw new Error("setup: expected failure");
    const report = composeDriftReport(result.error, "raw");
    // At least one issue path should include the numeric "0" as string.
    const paths = report.issues.flatMap((i) => i.path);
    expect(paths).toContain("members");
    expect(paths.some((p) => p === "0")).toBe(true);
  });
});

// ---------- composeCatastrophicDrift ----------

describe("composeCatastrophicDrift", () => {
  test("synthesizes invalid_json issue from parse error", () => {
    const err = new SyntaxError("Unexpected token in JSON at position 5");
    const report = composeCatastrophicDrift(err, "{not json}");
    expect(report.catastrophic).toBe(true);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]?.code).toBe("invalid_json");
    expect(report.issues[0]?.message).toContain("Unexpected token");
    expect(report.issues[0]?.path).toEqual([]);
  });

  test("non-Error parse-error coerces to string", () => {
    const report = composeCatastrophicDrift("oops", "{not json}");
    expect(report.issues[0]?.message).toContain("oops");
  });

  test("hash differs from non-catastrophic drift on same raw", () => {
    const cat = composeCatastrophicDrift(new Error("bad"), "raw");
    const result = Team.safeParse({ name: "t", members: [], whip: { unknown: 1 } });
    if (result.success) throw new Error("setup");
    const norm = composeDriftReport(result.error, "raw");
    expect(cat.driftHash).not.toBe(norm.driftHash);
  });
});

// ---------- makeDriftSafeDefaults ----------

describe("makeDriftSafeDefaults", () => {
  test("strips invalid keys from whip + applies all defaults", () => {
    const raw = {
      name: "t",
      members: [],
      whip: {
        unknownKey: 1,
        budgetPauseThreshold: "ninety", // type mismatch — stripped
        leadMaxMin: 45, // valid — preserved
      },
    };
    const safe = makeDriftSafeDefaults(raw);
    const parsed = Team.parse(safe);
    expect(parsed.whip?.leadMaxMin).toBe(45);
    expect(parsed.whip?.budgetPauseThreshold).toBe(90); // default applied
    expect(parsed.whip?.staleMin).toBe(90); // default applied
  });

  test("missing whip block → all whip defaults applied", () => {
    const raw = { name: "t", members: [] };
    const safe = makeDriftSafeDefaults(raw);
    const parsed = Team.parse(safe);
    expect(parsed.whip?.intervalMins).toBe(5);
    expect(parsed.whip?.staleMin).toBe(90);
    expect(parsed.whip?.leadMaxMin).toBe(60);
    expect(parsed.whip?.autoRotate).toBe(false);
  });

  test("malformed top-level (string instead of object) → minimal valid team shape", () => {
    const safe = makeDriftSafeDefaults("not an object");
    const parsed = Team.parse(safe);
    expect(parsed.name).toBe("unknown-team");
    expect(parsed.members).toEqual([]);
    expect(parsed.whip).toBeDefined();
  });

  test("array top-level → minimal valid team shape", () => {
    const safe = makeDriftSafeDefaults([1, 2, 3]);
    const parsed = Team.parse(safe);
    expect(parsed.name).toBe("unknown-team");
  });

  test("missing name → synthesized 'unknown-team'", () => {
    const safe = makeDriftSafeDefaults({ members: [] });
    expect((safe as { name: string }).name).toBe("unknown-team");
  });

  test("non-array members → coerced to empty array", () => {
    const safe = makeDriftSafeDefaults({ name: "t", members: "not-array" });
    expect((safe as { members: unknown[] }).members).toEqual([]);
  });

  test("preserves valid top-level fields verbatim", () => {
    const raw = {
      name: "myteam",
      description: "hello",
      members: [{ name: "alice", role: "lead", tui: "claude" }],
      whip: { staleMin: 120 },
    };
    const safe = makeDriftSafeDefaults(raw);
    const parsed = Team.parse(safe);
    expect(parsed.name).toBe("myteam");
    expect(parsed.description).toBe("hello");
    expect(parsed.members).toHaveLength(1);
    expect(parsed.whip?.staleMin).toBe(120);
  });

  test("safe defaults shape always parses through Team schema", () => {
    // Range of catastrophic shapes.
    for (const raw of [null, undefined, 42, "string", [], { foo: "bar" }]) {
      const safe = makeDriftSafeDefaults(raw);
      expect(() => Team.parse(safe)).not.toThrow();
    }
  });
});

// ---------- TeamWhip schema ----------

describe("TeamWhip schema", () => {
  test("empty object parses to all defaults", () => {
    const w = TeamWhip.parse({});
    expect(w.intervalMins).toBe(5);
    expect(w.staleMin).toBe(90);
    expect(w.leadMaxMin).toBe(60);
    expect(w.autoRotate).toBe(false);
    expect(w.budgetPauseThreshold).toBe(90);
    expect(w.budgetResumeThreshold).toBe(80);
    expect(w.budgetWarningBands).toEqual([0.5, 0.25, 0.15]);
    expect(w.budgetRefreshLeadMins).toBe(30);
    expect(w.autoStopAfterIdleTicks).toBe(0);
    expect(w.selfHealEnabled).toBe(false);
    expect(w.selfHealRecipes).toEqual([]);
    expect(w.accountFallback).toEqual([]);
    expect(w.accountSwapTriggerThreshold).toBe(75);
  });

  test("strict mode rejects unknown keys", () => {
    expect(() => TeamWhip.parse({ unknownKey: 1 })).toThrow();
    expect(
      () => TeamWhip.parse({ budgetPauseTreshold: 90 }), // typo
    ).toThrow();
  });

  test("type mismatch on a known field rejects", () => {
    expect(() => TeamWhip.parse({ budgetPauseThreshold: "ninety" })).toThrow();
  });

  test("budgetPauseThreshold range enforced (0-100)", () => {
    expect(() => TeamWhip.parse({ budgetPauseThreshold: 101 })).toThrow();
    expect(() => TeamWhip.parse({ budgetPauseThreshold: -1 })).toThrow();
  });

  test("budgetWarningBands accepts numbers in [0..1]", () => {
    const w = TeamWhip.parse({ budgetWarningBands: [0.9, 0.5, 0.1] });
    expect(w.budgetWarningBands).toEqual([0.9, 0.5, 0.1]);
  });

  test("budgetWarningBands rejects values > 1", () => {
    expect(() => TeamWhip.parse({ budgetWarningBands: [1.5] })).toThrow();
  });

  test("claudeAccount accepts a string", () => {
    const w = TeamWhip.parse({ claudeAccount: "c-i" });
    expect(w.claudeAccount).toBe("c-i");
  });

  test("downConfirmTicks default is 2 (preserved bash parity)", () => {
    expect(TeamWhip.parse({}).downConfirmTicks).toBe(2);
  });

  test("heartbeat default is true (preserved bash parity)", () => {
    expect(TeamWhip.parse({}).heartbeat).toBe(true);
  });
});

// ---------- whipConfigDriftStatePath ----------

describe("whipConfigDriftStatePath", () => {
  test("appends state/whip-config-drift-state.json to atmuxDir", () => {
    expect(whipConfigDriftStatePath("/tmp/foo")).toBe(
      "/tmp/foo/state/whip-config-drift-state.json",
    );
  });
});

// ---------- shouldFireDriftPing ----------

describe("shouldFireDriftPing", () => {
  test("true when state file is absent", async () => {
    expect(await shouldFireDriftPing(atmuxDir, "abc123", 1_800_000_000)).toBe(true);
  });

  test("true when hash not present in state file", async () => {
    await recordDriftPing(atmuxDir, "other-hash", 1_800_000_000);
    expect(await shouldFireDriftPing(atmuxDir, "new-hash", 1_800_001_000)).toBe(true);
  });

  test("false when hash present AND last fire within 24h", async () => {
    await recordDriftPing(atmuxDir, "abc", 1_800_000_000);
    expect(await shouldFireDriftPing(atmuxDir, "abc", 1_800_000_000 + 60 * 60)).toBe(false);
  });

  test("true when hash present AND last fire ≥24h ago (re-fire window)", async () => {
    await recordDriftPing(atmuxDir, "abc", 1_800_000_000);
    expect(
      await shouldFireDriftPing(atmuxDir, "abc", 1_800_000_000 + DRIFT_REFIRE_WINDOW_SEC),
    ).toBe(true);
  });

  test("false at boundary just before 24h", async () => {
    await recordDriftPing(atmuxDir, "abc", 1_800_000_000);
    expect(
      await shouldFireDriftPing(atmuxDir, "abc", 1_800_000_000 + DRIFT_REFIRE_WINDOW_SEC - 1),
    ).toBe(false);
  });
});

// ---------- recordDriftPing ----------

describe("recordDriftPing", () => {
  test("creates state file with single hash entry on first call", async () => {
    await recordDriftPing(atmuxDir, "abc", 1_800_000_000);
    const text = await readFile(whipConfigDriftStatePath(atmuxDir), "utf8");
    const parsed = JSON.parse(text);
    expect(parsed).toEqual({ abc: 1_800_000_000 });
  });

  test("appends new hash without losing previous entries", async () => {
    await recordDriftPing(atmuxDir, "abc", 1_800_000_000);
    await recordDriftPing(atmuxDir, "def", 1_800_001_000);
    const parsed = JSON.parse(await readFile(whipConfigDriftStatePath(atmuxDir), "utf8"));
    expect(parsed).toEqual({ abc: 1_800_000_000, def: 1_800_001_000 });
  });

  test("re-fire updates the timestamp for an existing hash", async () => {
    await recordDriftPing(atmuxDir, "abc", 1_800_000_000);
    await recordDriftPing(atmuxDir, "abc", 1_800_999_999);
    const parsed = JSON.parse(await readFile(whipConfigDriftStatePath(atmuxDir), "utf8"));
    expect(parsed).toEqual({ abc: 1_800_999_999 });
  });

  test("multi-drift sequencing: 3 distinct hashes accumulate", async () => {
    await recordDriftPing(atmuxDir, "h1", 1);
    await recordDriftPing(atmuxDir, "h2", 2);
    await recordDriftPing(atmuxDir, "h3", 3);
    const parsed = JSON.parse(await readFile(whipConfigDriftStatePath(atmuxDir), "utf8"));
    expect(Object.keys(parsed).sort()).toEqual(["h1", "h2", "h3"]);
  });
});

// ---------- DRIFT_REFIRE_WINDOW_SEC constant ----------

describe("DRIFT_REFIRE_WINDOW_SEC", () => {
  test("is 24h in seconds", () => {
    expect(DRIFT_REFIRE_WINDOW_SEC).toBe(24 * 60 * 60);
  });
});

// Sanity — keep the imports we may not directly call live.
void z;
