// Unit tests for src/core/whip-strikes.ts — ADR-087 strike counter
// state file IO. Per-test mkdtemp so file IO is contained.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifierSwallowSymptomHash,
  etaLiedSymptomHash,
  incrementStrike,
  processFrozenSymptomHash,
  readStrikeRecord,
  readStrikesFile,
  renderStrikeTimeline,
  resetStrikeRecord,
  type StrikesFile,
  strikesPath,
  velocityStalledSymptomHash,
  writeStrikesFile,
} from "../../../src/core/whip-strikes.ts";

let root: string;
let atmuxDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "atmux-whip-strikes-"));
  atmuxDir = join(root, ".atmux");
  await mkdir(join(atmuxDir, "state"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("strikesPath", () => {
  test("builds <atmuxDir>/state/whip-strikes-<team>.json", () => {
    expect(strikesPath("/srv/.atmux", "demo")).toBe("/srv/.atmux/state/whip-strikes-demo.json");
  });

  test("preserves hyphens + underscores in team name", () => {
    expect(strikesPath("/srv/.atmux", "sopx-staging")).toContain("whip-strikes-sopx-staging.json");
    expect(strikesPath("/srv/.atmux", "a_b")).toContain("whip-strikes-a_b.json");
  });
});

describe("velocityStalledSymptomHash", () => {
  test("returns canonical `whip-<team>-velocity-stalled` form", () => {
    expect(velocityStalledSymptomHash("demo")).toBe("whip-demo-velocity-stalled");
  });
});

// ---------- ADR-087 §T2 (Task t-e91fec98 §2) symptom hashes ----------

describe("etaLiedSymptomHash", () => {
  test("returns canonical `whip-<team>-eta-lied` form", () => {
    expect(etaLiedSymptomHash("demo")).toBe("whip-demo-eta-lied");
  });

  test("preserves hyphens in team name", () => {
    expect(etaLiedSymptomHash("sopx-staging")).toBe("whip-sopx-staging-eta-lied");
  });
});

describe("classifierSwallowSymptomHash", () => {
  test("returns canonical `whip-<team>-classifier-swallow` form", () => {
    expect(classifierSwallowSymptomHash("demo")).toBe("whip-demo-classifier-swallow");
  });
});

describe("processFrozenSymptomHash", () => {
  test("returns canonical `whip-<team>-process-frozen` form", () => {
    expect(processFrozenSymptomHash("demo")).toBe("whip-demo-process-frozen");
  });
});

describe("all four symptom hashes are distinct for the same team", () => {
  test("four distinct strings", () => {
    const hashes = new Set([
      velocityStalledSymptomHash("demo"),
      etaLiedSymptomHash("demo"),
      classifierSwallowSymptomHash("demo"),
      processFrozenSymptomHash("demo"),
    ]);
    expect(hashes.size).toBe(4);
  });
});

// ---------- renderStrikeTimeline ----------

describe("renderStrikeTimeline", () => {
  test("renders strikes 0→N over Δt + last reason", () => {
    expect(
      renderStrikeTimeline(
        {
          count: 3,
          firstStrikeSec: 1000,
          lastStrikeSec: 1180,
          lastReason: "BAD: 0 commits in 60min window",
        },
        2200,
      ),
    ).toBe("strikes 0→3 over Δt=20min; last reason: BAD: 0 commits in 60min window");
  });

  test("returns 'no strikes recorded' for empty record", () => {
    expect(
      renderStrikeTimeline(
        { count: 0, firstStrikeSec: null, lastStrikeSec: null, lastReason: null },
        2000,
      ),
    ).toBe("no strikes recorded");
  });

  test("returns 'no strikes recorded' when firstStrikeSec is null even if count>0 (defensive)", () => {
    expect(
      renderStrikeTimeline(
        { count: 5, firstStrikeSec: null, lastStrikeSec: null, lastReason: "x" },
        2000,
      ),
    ).toBe("no strikes recorded");
  });

  test("clamps Δt to ≥1min so sub-60s windows don't render Δt=0min", () => {
    const out = renderStrikeTimeline(
      { count: 1, firstStrikeSec: 1000, lastStrikeSec: 1015, lastReason: "x" },
      1015,
    );
    expect(out).toContain("Δt=1min");
  });

  test("substitutes <no reason> when lastReason is null", () => {
    expect(
      renderStrikeTimeline(
        { count: 2, firstStrikeSec: 1000, lastStrikeSec: 1500, lastReason: null },
        2000,
      ),
    ).toContain("last reason: <no reason>");
  });

  test("counts increment in render output", () => {
    expect(
      renderStrikeTimeline(
        { count: 7, firstStrikeSec: 1000, lastStrikeSec: 1500, lastReason: "x" },
        2000,
      ),
    ).toContain("strikes 0→7");
  });
});

describe("readStrikesFile + readStrikeRecord", () => {
  test("missing file → empty StrikesFile (no throw)", async () => {
    const file = await readStrikesFile(atmuxDir, "demo");
    expect(file).toEqual({ records: {}, schemaVersion: 1 });
  });

  test("missing hash → empty StrikeRecord (no throw)", async () => {
    const rec = await readStrikeRecord(atmuxDir, "demo", "any-hash");
    expect(rec).toEqual({
      count: 0,
      firstStrikeSec: null,
      lastStrikeSec: null,
      lastReason: null,
    });
  });

  test("malformed JSON → empty StrikesFile (graceful degrade)", async () => {
    await writeFile(strikesPath(atmuxDir, "demo"), "{not valid json");
    const file = await readStrikesFile(atmuxDir, "demo");
    expect(file).toEqual({ records: {}, schemaVersion: 1 });
  });

  test("non-object JSON → empty StrikesFile", async () => {
    await writeFile(strikesPath(atmuxDir, "demo"), "[]");
    const file = await readStrikesFile(atmuxDir, "demo");
    expect(file).toEqual({ records: {}, schemaVersion: 1 });
  });

  test("partial record → fills missing fields with safe defaults", async () => {
    // Simulate a forward-compat scenario where the file has a
    // record with only `count` set (e.g. an older version).
    const wonky: unknown = {
      schemaVersion: 1,
      records: { "whip-demo-velocity-stalled": { count: 2 } },
    };
    await writeFile(strikesPath(atmuxDir, "demo"), JSON.stringify(wonky));
    const rec = await readStrikeRecord(atmuxDir, "demo", "whip-demo-velocity-stalled");
    expect(rec.count).toBe(2);
    expect(rec.firstStrikeSec).toBe(null);
    expect(rec.lastStrikeSec).toBe(null);
    expect(rec.lastReason).toBe(null);
  });

  test("round-trip: writeStrikesFile then readStrikesFile is identity", async () => {
    const file: StrikesFile = {
      schemaVersion: 1,
      records: {
        "whip-demo-velocity-stalled": {
          count: 2,
          firstStrikeSec: 1715630000,
          lastStrikeSec: 1715630600,
          lastReason: "BAD: 0 commits in 60min",
        },
      },
    };
    await writeStrikesFile(atmuxDir, "demo", file);
    const got = await readStrikesFile(atmuxDir, "demo");
    expect(got).toEqual(file);
  });
});

describe("incrementStrike", () => {
  test("first strike: count=1, firstStrikeSec===nowSec, lastReason captured", async () => {
    const rec = await incrementStrike(
      atmuxDir,
      "demo",
      "whip-demo-velocity-stalled",
      "BAD: 0 commits in 60min · 3 in-progress (stalled)",
      1715630000,
    );
    expect(rec.count).toBe(1);
    expect(rec.firstStrikeSec).toBe(1715630000);
    expect(rec.lastStrikeSec).toBe(1715630000);
    expect(rec.lastReason).toContain("BAD");
  });

  test("subsequent strike: count bumps, firstStrikeSec stays, lastStrikeSec updates", async () => {
    await incrementStrike(atmuxDir, "demo", "h1", "reason-1", 1000);
    const rec = await incrementStrike(atmuxDir, "demo", "h1", "reason-2", 2000);
    expect(rec.count).toBe(2);
    expect(rec.firstStrikeSec).toBe(1000);
    expect(rec.lastStrikeSec).toBe(2000);
    expect(rec.lastReason).toBe("reason-2");
  });

  test("three strikes → count=3 (matches DEFAULT_STRIKE_THRESHOLD)", async () => {
    await incrementStrike(atmuxDir, "demo", "h1", "r", 1000);
    await incrementStrike(atmuxDir, "demo", "h1", "r", 2000);
    const rec = await incrementStrike(atmuxDir, "demo", "h1", "r", 3000);
    expect(rec.count).toBe(3);
  });

  test("strike on distinct symptom hashes are independent counters", async () => {
    await incrementStrike(atmuxDir, "demo", "h-velocity", "r1", 1000);
    await incrementStrike(atmuxDir, "demo", "h-velocity", "r2", 2000);
    await incrementStrike(atmuxDir, "demo", "h-classifier-swallow", "r3", 1500);

    const r1 = await readStrikeRecord(atmuxDir, "demo", "h-velocity");
    const r2 = await readStrikeRecord(atmuxDir, "demo", "h-classifier-swallow");
    expect(r1.count).toBe(2);
    expect(r2.count).toBe(1);
  });

  test("strike on distinct teams are independent (separate files)", async () => {
    await incrementStrike(atmuxDir, "demoA", "h1", "r", 1000);
    await incrementStrike(atmuxDir, "demoB", "h1", "r", 1000);

    const rA = await readStrikeRecord(atmuxDir, "demoA", "h1");
    const rB = await readStrikeRecord(atmuxDir, "demoB", "h1");
    expect(rA.count).toBe(1);
    expect(rB.count).toBe(1);
    // Files are distinct paths.
    expect(strikesPath(atmuxDir, "demoA")).not.toBe(strikesPath(atmuxDir, "demoB"));
  });

  test("incrementStrike creates the state dir if missing", async () => {
    // Remove state dir to verify auto-create.
    await rm(join(atmuxDir, "state"), { recursive: true });
    await incrementStrike(atmuxDir, "demo", "h1", "r", 1000);
    const content = await readFile(strikesPath(atmuxDir, "demo"), "utf8");
    expect(content).toContain("h1");
  });
});

describe("resetStrikeRecord", () => {
  test("removes the symptom hash from the file", async () => {
    await incrementStrike(atmuxDir, "demo", "h1", "r", 1000);
    await resetStrikeRecord(atmuxDir, "demo", "h1");
    const rec = await readStrikeRecord(atmuxDir, "demo", "h1");
    expect(rec.count).toBe(0);
    expect(rec.firstStrikeSec).toBe(null);
  });

  test("reset on missing hash is a no-op (no throw)", async () => {
    await resetStrikeRecord(atmuxDir, "demo", "nonexistent");
    const file = await readStrikesFile(atmuxDir, "demo");
    expect(file.records).toEqual({});
  });

  test("reset on one hash leaves other hashes untouched", async () => {
    await incrementStrike(atmuxDir, "demo", "h-keep", "r1", 1000);
    await incrementStrike(atmuxDir, "demo", "h-reset", "r2", 1000);
    await resetStrikeRecord(atmuxDir, "demo", "h-reset");
    const kept = await readStrikeRecord(atmuxDir, "demo", "h-keep");
    const reset = await readStrikeRecord(atmuxDir, "demo", "h-reset");
    expect(kept.count).toBe(1);
    expect(reset.count).toBe(0);
  });

  test("reset then re-strike: firstStrikeSec restarts from new now", async () => {
    await incrementStrike(atmuxDir, "demo", "h1", "r1", 1000);
    await incrementStrike(atmuxDir, "demo", "h1", "r2", 2000);
    await resetStrikeRecord(atmuxDir, "demo", "h1");
    const rec = await incrementStrike(atmuxDir, "demo", "h1", "r3", 5000);
    expect(rec.count).toBe(1);
    expect(rec.firstStrikeSec).toBe(5000);
  });
});

describe("file format on disk", () => {
  test("schemaVersion === 1 in every write", async () => {
    await incrementStrike(atmuxDir, "demo", "h1", "r", 1000);
    const text = await readFile(strikesPath(atmuxDir, "demo"), "utf8");
    expect(text).toContain('"schemaVersion": 1');
  });

  test("JSON is pretty-printed (2-space indent)", async () => {
    await incrementStrike(atmuxDir, "demo", "h1", "r", 1000);
    const text = await readFile(strikesPath(atmuxDir, "demo"), "utf8");
    // Pretty-print: at least one nested-key line starts with 2+ spaces.
    expect(text).toMatch(/\n {2}"/);
  });

  test("file ends with trailing newline (POSIX convention)", async () => {
    await incrementStrike(atmuxDir, "demo", "h1", "r", 1000);
    const text = await readFile(strikesPath(atmuxDir, "demo"), "utf8");
    expect(text.endsWith("\n")).toBe(true);
  });
});
