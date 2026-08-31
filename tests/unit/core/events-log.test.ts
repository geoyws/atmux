// Unit tests for src/core/events-log.ts (kanban t-91cd050f).
//
// Covers:
// - eventsLogPathFor — pure year/month bucket resolution (UTC)
// - serializeEvent — JSONL line shape (schema field order, omit-when-
//   empty for member + extra, snake_case `duration_ms` on the wire)
// - appendVerbEvent — folder creation + line atomicity + multi-write
//   accumulation (proves single-process append-by-append correctness)
// - safeAppendVerbEvent — soft-degrade on append failure (read-only
//   parent dir → stderr WARN + resolve)
// - schema round-trip — write + read-back via JSON.parse preserves all
//   fields (including snake_case on-wire vs camelCase in TS shape)

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendVerbEvent,
  eventsLogPathFor,
  safeAppendVerbEvent,
  serializeEvent,
  type VerbEvent,
} from "../../../src/core/events-log.ts";

// ---------- eventsLogPathFor ----------

describe("eventsLogPathFor", () => {
  test("emits <atmuxDir>/logs/<YYYY>/<MM>/events.jsonl for mid-month UTC", () => {
    // 2026-05-12 UTC ≈ epoch 1778572800000
    const ts = Date.UTC(2026, 4 /* May = month 4 */, 12, 10, 0, 0);
    expect(eventsLogPathFor("/a", ts)).toBe("/a/logs/2026/05/events.jsonl");
  });

  test("zero-pads single-digit month", () => {
    const jan = Date.UTC(2026, 0, 15, 0, 0, 0);
    expect(eventsLogPathFor("/a", jan)).toBe("/a/logs/2026/01/events.jsonl");
    const sep = Date.UTC(2026, 8, 30, 23, 59, 59);
    expect(eventsLogPathFor("/a", sep)).toBe("/a/logs/2026/09/events.jsonl");
  });

  test("buckets by UTC — late-night local-time event near month boundary still picks UTC month", () => {
    // 2026-05-31 23:30 UTC → still May UTC, regardless of local tz
    const lateMay = Date.UTC(2026, 4, 31, 23, 30, 0);
    expect(eventsLogPathFor("/a", lateMay)).toBe("/a/logs/2026/05/events.jsonl");
    // 2026-06-01 00:30 UTC → June
    const earlyJune = Date.UTC(2026, 5, 1, 0, 30, 0);
    expect(eventsLogPathFor("/a", earlyJune)).toBe("/a/logs/2026/06/events.jsonl");
  });

  test("handles year boundary", () => {
    const lastDec = Date.UTC(2026, 11, 31, 23, 59, 59);
    expect(eventsLogPathFor("/a", lastDec)).toBe("/a/logs/2026/12/events.jsonl");
    const firstJan = Date.UTC(2027, 0, 1, 0, 0, 1);
    expect(eventsLogPathFor("/a", firstJan)).toBe("/a/logs/2027/01/events.jsonl");
  });
});

// ---------- serializeEvent ----------

describe("serializeEvent", () => {
  function baseEvent(): VerbEvent {
    return {
      ts: 1715290000,
      verb: "dispatch",
      args: ["alpha", "t-123"],
      outcome: "ok",
      durationMs: 142,
      exit: 0,
      team: "atmux",
    };
  }

  test("emits the spec-shape JSON with trailing newline", () => {
    const line = serializeEvent(baseEvent());
    expect(line.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(line);
    expect(parsed).toEqual({
      ts: 1715290000,
      verb: "dispatch",
      args: ["alpha", "t-123"],
      outcome: "ok",
      duration_ms: 142,
      exit: 0,
      team: "atmux",
    });
  });

  test("converts TS camelCase `durationMs` to wire snake_case `duration_ms`", () => {
    const line = serializeEvent(baseEvent());
    expect(line).toContain('"duration_ms":142');
    expect(line).not.toContain("durationMs");
  });

  test("omits `member` when absent or empty", () => {
    const parsedAbsent = JSON.parse(serializeEvent(baseEvent()));
    expect("member" in parsedAbsent).toBe(false);
    const parsedEmpty = JSON.parse(serializeEvent({ ...baseEvent(), member: "" }));
    expect("member" in parsedEmpty).toBe(false);
  });

  test("includes `member` when populated", () => {
    const parsed = JSON.parse(serializeEvent({ ...baseEvent(), member: "alpha" }));
    expect(parsed.member).toBe("alpha");
  });

  test("omits `extra` when absent or empty object", () => {
    const parsedAbsent = JSON.parse(serializeEvent(baseEvent()));
    expect("extra" in parsedAbsent).toBe(false);
    const parsedEmpty = JSON.parse(serializeEvent({ ...baseEvent(), extra: {} }));
    expect("extra" in parsedEmpty).toBe(false);
  });

  test("includes `extra` when non-empty", () => {
    const parsed = JSON.parse(
      serializeEvent({ ...baseEvent(), extra: { taskId: "t-123", lane: "be" } }),
    );
    expect(parsed.extra).toEqual({ taskId: "t-123", lane: "be" });
  });

  test("`args` always emitted as array even when empty", () => {
    const parsed = JSON.parse(serializeEvent({ ...baseEvent(), args: [] }));
    expect(parsed.args).toEqual([]);
  });

  test("`outcome` covers all three states", () => {
    for (const outcome of ["ok", "warn", "error"] as const) {
      const parsed = JSON.parse(serializeEvent({ ...baseEvent(), outcome }));
      expect(parsed.outcome).toBe(outcome);
    }
  });

  test("empty `team` (pre-init / no team.json) serializes as empty string, not omitted", () => {
    const parsed = JSON.parse(serializeEvent({ ...baseEvent(), team: "" }));
    expect(parsed.team).toBe("");
  });
});

// ---------- appendVerbEvent ----------

describe("appendVerbEvent", () => {
  let atmuxDir: string;
  beforeEach(async () => {
    atmuxDir = await mkdtemp(join(tmpdir(), "atmux-eventslog-"));
  });
  afterEach(async () => {
    await rm(atmuxDir, { recursive: true, force: true });
  });

  function evt(overrides: Partial<VerbEvent> = {}): VerbEvent {
    return {
      ts: 1715290000,
      verb: "dispatch",
      args: ["alpha"],
      outcome: "ok",
      durationMs: 10,
      exit: 0,
      team: "atmux",
      ...overrides,
    };
  }

  test("creates the year/month folder on first write + appends one JSONL line", async () => {
    const epoch = Date.UTC(2026, 4, 12, 10, 0, 0);
    await appendVerbEvent(atmuxDir, evt({ verb: "task" }), { epochMsForBucket: epoch });
    const path = join(atmuxDir, "logs", "2026", "05", "events.jsonl");
    const body = await readFile(path, "utf8");
    expect(body.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(body.trim());
    expect(parsed.verb).toBe("task");
    // Folder structure landed as expected.
    const folderStat = await stat(join(atmuxDir, "logs", "2026", "05"));
    expect(folderStat.isDirectory()).toBe(true);
  });

  test("multiple appends accumulate as separate JSONL lines (line atomicity)", async () => {
    const epoch = Date.UTC(2026, 4, 12, 10, 0, 0);
    await appendVerbEvent(atmuxDir, evt({ verb: "v1" }), { epochMsForBucket: epoch });
    await appendVerbEvent(atmuxDir, evt({ verb: "v2", exit: 64, outcome: "warn" }), {
      epochMsForBucket: epoch,
    });
    await appendVerbEvent(atmuxDir, evt({ verb: "v3", exit: 99, outcome: "error" }), {
      epochMsForBucket: epoch,
    });
    const body = await readFile(join(atmuxDir, "logs", "2026", "05", "events.jsonl"), "utf8");
    const lines = body.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0] ?? "").verb).toBe("v1");
    expect(JSON.parse(lines[1] ?? "").verb).toBe("v2");
    expect(JSON.parse(lines[2] ?? "").verb).toBe("v3");
    // Outcome lattice survives the round-trip.
    expect(JSON.parse(lines[1] ?? "").outcome).toBe("warn");
    expect(JSON.parse(lines[2] ?? "").outcome).toBe("error");
  });

  test("events spanning month boundary land in distinct files", async () => {
    const lateMay = Date.UTC(2026, 4, 31, 23, 30, 0);
    const earlyJune = Date.UTC(2026, 5, 1, 0, 30, 0);
    await appendVerbEvent(atmuxDir, evt({ verb: "may1" }), { epochMsForBucket: lateMay });
    await appendVerbEvent(atmuxDir, evt({ verb: "may2" }), { epochMsForBucket: lateMay });
    await appendVerbEvent(atmuxDir, evt({ verb: "jun1" }), { epochMsForBucket: earlyJune });
    const mayBody = await readFile(join(atmuxDir, "logs", "2026", "05", "events.jsonl"), "utf8");
    const junBody = await readFile(join(atmuxDir, "logs", "2026", "06", "events.jsonl"), "utf8");
    expect(mayBody.trim().split("\n")).toHaveLength(2);
    expect(junBody.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(junBody.trim()).verb).toBe("jun1");
  });

  test("defaults `epochMsForBucket` to `Date.now()` when omitted", async () => {
    await appendVerbEvent(atmuxDir, evt());
    const now = new Date();
    const yyyy = String(now.getUTCFullYear());
    const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
    const path = join(atmuxDir, "logs", yyyy, mm, "events.jsonl");
    const body = await readFile(path, "utf8");
    expect(body.length).toBeGreaterThan(0);
  });

  test("schema round-trip — every documented field preserved through write+read", async () => {
    const epoch = Date.UTC(2026, 4, 12, 10, 0, 0);
    const original: VerbEvent = {
      ts: 1715290000,
      verb: "task",
      args: ["add", "Some subject", "--lane", "be"],
      outcome: "warn",
      durationMs: 235,
      exit: 64,
      member: "alpha",
      team: "atmux",
      extra: { taskId: "t-deadbeef", lane: "be", priority: 2 },
    };
    await appendVerbEvent(atmuxDir, original, { epochMsForBucket: epoch });
    const body = await readFile(join(atmuxDir, "logs", "2026", "05", "events.jsonl"), "utf8");
    const parsed = JSON.parse(body.trim());
    // Wire shape uses snake_case `duration_ms` per spec.
    expect(parsed.ts).toBe(original.ts);
    expect(parsed.verb).toBe(original.verb);
    expect(parsed.args).toEqual([...original.args]);
    expect(parsed.outcome).toBe(original.outcome);
    expect(parsed.duration_ms).toBe(original.durationMs);
    expect(parsed.exit).toBe(original.exit);
    expect(parsed.member).toBe(original.member);
    expect(parsed.team).toBe(original.team);
    expect(parsed.extra).toEqual(original.extra ?? {});
  });
});

// ---------- safeAppendVerbEvent ----------

describe("safeAppendVerbEvent", () => {
  let atmuxDir: string;
  beforeEach(async () => {
    atmuxDir = await mkdtemp(join(tmpdir(), "atmux-eventslog-safe-"));
  });
  afterEach(async () => {
    await rm(atmuxDir, { recursive: true, force: true });
  });

  function evt(): VerbEvent {
    return {
      ts: 1715290000,
      verb: "dispatch",
      args: [],
      outcome: "ok",
      durationMs: 1,
      exit: 0,
      team: "atmux",
    };
  }

  test("happy path — succeeds without invoking stderr", async () => {
    const epoch = Date.UTC(2026, 4, 12, 10, 0, 0);
    const stderrCalls: string[] = [];
    await safeAppendVerbEvent(atmuxDir, evt(), (s) => stderrCalls.push(s), {
      epochMsForBucket: epoch,
    });
    expect(stderrCalls).toHaveLength(0);
    const body = await readFile(join(atmuxDir, "logs", "2026", "05", "events.jsonl"), "utf8");
    expect(body.length).toBeGreaterThan(0);
  });

  test("read-only parent dir → swallowed + stderr WARN emitted, no throw", async () => {
    // Pre-create logs/2026/05 as a regular FILE (not directory) at the
    // target path — appendText's ensureDir + appendFile will reject with
    // ENOTDIR. Cleanest way to force a write failure without changing
    // mode (which mkdtemp owns).
    await mkdir(join(atmuxDir, "logs", "2026"), { recursive: true });
    await Bun.write(join(atmuxDir, "logs", "2026", "05"), "blocker");
    const epoch = Date.UTC(2026, 4, 12, 10, 0, 0);
    const stderrCalls: string[] = [];
    await safeAppendVerbEvent(atmuxDir, evt(), (s) => stderrCalls.push(s), {
      epochMsForBucket: epoch,
    });
    // Should NOT throw; WARN should be emitted.
    expect(stderrCalls.length).toBeGreaterThan(0);
    expect(stderrCalls.join("")).toContain("events-log: append skipped");
  });

  test("stderr defaults to process.stderr.write when omitted", async () => {
    // Smoke — just verifies no crash when stderr arg is absent.
    const epoch = Date.UTC(2026, 4, 12, 10, 0, 0);
    await safeAppendVerbEvent(atmuxDir, evt(), undefined, { epochMsForBucket: epoch });
    const body = await readFile(join(atmuxDir, "logs", "2026", "05", "events.jsonl"), "utf8");
    expect(body.length).toBeGreaterThan(0);
  });

  test("stderr defaults to process.stderr.write and emits warning on ENOTDIR", async () => {
    await mkdir(join(atmuxDir, "logs", "2026"), { recursive: true });
    await Bun.write(join(atmuxDir, "logs", "2026", "05"), "blocker");
    const epoch = Date.UTC(2026, 4, 12, 10, 0, 0);
    const stderrCalls: string[] = [];
    const originalStderrWrite = process.stderr.write;
    try {
      process.stderr.write = ((chunk: string | Uint8Array) => {
        stderrCalls.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
        return true;
      }) as typeof process.stderr.write;
      await safeAppendVerbEvent(atmuxDir, evt(), undefined, { epochMsForBucket: epoch });
    } finally {
      process.stderr.write = originalStderrWrite;
    }
    expect(stderrCalls.length).toBeGreaterThan(0);
    expect(stderrCalls.join("")).toContain("events-log: append skipped");
  });
});
