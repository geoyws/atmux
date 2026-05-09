// Unit tests for `.atmux/state/cursor-self-heal-state.json` 24h dedup
// state-file (ADR-055 R1-T8 §D2 + §D7).
//
// Covers: path composition, load/write round-trip, malformed-JSON
// recovery, defensive value-type stripping, dedup TTL semantics, mutate-
// and-record helpers. Sister tests covering the higher-level recipe
// orchestration (whip-tick self-heal pass) live in
// tests/unit/verbs/whip.test.ts; this file isolates the state-file
// lifecycle per ADR-055 §D7.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cursorSelfHealStatePath,
  DEFAULT_DEDUP_TTL_SEC,
  isRecentSelfHeal,
  loadSelfHealState,
  recordSelfHealFire,
  type SelfHealState,
  writeSelfHealState,
} from "../../../src/core/cursor-self-heal-state.ts";

let atmuxDir: string;

beforeEach(async () => {
  atmuxDir = await mkdtemp(join(tmpdir(), "atmux-self-heal-state-"));
  await mkdir(join(atmuxDir, "state"), { recursive: true });
});

afterEach(async () => {
  await rm(atmuxDir, { recursive: true, force: true });
});

// ---------- Path ----------

describe("cursorSelfHealStatePath", () => {
  test("appends state/cursor-self-heal-state.json to atmuxDir", () => {
    expect(cursorSelfHealStatePath("/tmp/foo")).toBe("/tmp/foo/state/cursor-self-heal-state.json");
  });
});

// ---------- DEFAULT_DEDUP_TTL_SEC ----------

describe("DEFAULT_DEDUP_TTL_SEC", () => {
  test("is 24 hours per ADR-055 §D2", () => {
    expect(DEFAULT_DEDUP_TTL_SEC).toBe(24 * 60 * 60);
  });
});

// ---------- Load / write round-trip ----------

describe("loadSelfHealState + writeSelfHealState", () => {
  test("absent file → empty SelfHealState", async () => {
    const s = await loadSelfHealState(atmuxDir);
    expect(s).toEqual({});
  });

  test("write → read round-trip preserves the recipeId→epoch map", async () => {
    const original: SelfHealState = {
      "fix:team-json-schema-drift": 1700000010,
      "fix:cron-pollution": 1700000020,
    };
    await writeSelfHealState(atmuxDir, original);
    const loaded = await loadSelfHealState(atmuxDir);
    expect(loaded).toEqual(original);
  });

  test("malformed JSON → empty map (corrupt-fresh recovery)", async () => {
    await writeFile(cursorSelfHealStatePath(atmuxDir), "{not json");
    const s = await loadSelfHealState(atmuxDir);
    expect(s).toEqual({});
  });

  test("non-object root (array) → empty map", async () => {
    await writeFile(cursorSelfHealStatePath(atmuxDir), "[1,2,3]");
    const s = await loadSelfHealState(atmuxDir);
    expect(s).toEqual({});
  });

  test("non-object root (string) → empty map", async () => {
    await writeFile(cursorSelfHealStatePath(atmuxDir), JSON.stringify("hello"));
    const s = await loadSelfHealState(atmuxDir);
    expect(s).toEqual({});
  });

  test("null root → empty map (defensive)", async () => {
    await writeFile(cursorSelfHealStatePath(atmuxDir), "null");
    const s = await loadSelfHealState(atmuxDir);
    expect(s).toEqual({});
  });

  test("non-numeric values are stripped on load (defensive)", async () => {
    await writeFile(
      cursorSelfHealStatePath(atmuxDir),
      JSON.stringify({
        "fix:cron-pollution": 1,
        junk: "string-value",
        nan: Number.NaN,
        obj: { foo: 1 },
      }),
    );
    const s = await loadSelfHealState(atmuxDir);
    expect(s).toEqual({ "fix:cron-pollution": 1 });
  });

  test("writeSelfHealState produces JSON the bash side can cat-read", async () => {
    const s: SelfHealState = { "fix:team-json-schema-drift": 1700000010 };
    await writeSelfHealState(atmuxDir, s);
    const text = await readFile(cursorSelfHealStatePath(atmuxDir), "utf8");
    expect(JSON.parse(text)).toEqual(s);
  });

  test("writeSelfHealState overwrites existing file", async () => {
    await writeSelfHealState(atmuxDir, { "fix:a": 1 });
    await writeSelfHealState(atmuxDir, { "fix:b": 2 });
    const after = await loadSelfHealState(atmuxDir);
    expect(after).toEqual({ "fix:b": 2 });
  });
});

// ---------- isRecentSelfHeal ----------

describe("isRecentSelfHeal", () => {
  const NOW = 1_700_000_000;

  test("false when recipe never fired", () => {
    expect(isRecentSelfHeal({}, "fix:team-json-schema-drift", NOW)).toBe(false);
  });

  test("true when recipe fired exactly now (boundary inclusive)", () => {
    const s = recordSelfHealFire({}, "fix:cron-pollution", NOW);
    expect(isRecentSelfHeal(s, "fix:cron-pollution", NOW)).toBe(true);
  });

  test("true within default 24h window", () => {
    // Fired 12h ago — well inside 24h.
    const fireSec = NOW - 12 * 3600;
    const s = { "fix:cron-pollution": fireSec };
    expect(isRecentSelfHeal(s, "fix:cron-pollution", NOW)).toBe(true);
  });

  test("true at exact TTL boundary (lastFire = now - ttl)", () => {
    const s = { "fix:x": NOW - DEFAULT_DEDUP_TTL_SEC };
    expect(isRecentSelfHeal(s, "fix:x", NOW)).toBe(true);
  });

  test("false just past TTL boundary (lastFire < now - ttl)", () => {
    const s = { "fix:x": NOW - DEFAULT_DEDUP_TTL_SEC - 1 };
    expect(isRecentSelfHeal(s, "fix:x", NOW)).toBe(false);
  });

  test("supports custom TTL override (1h dedup)", () => {
    const oneHour = 3600;
    const justUnder = { "fix:x": NOW - 3500 };
    const justOver = { "fix:x": NOW - 3700 };
    expect(isRecentSelfHeal(justUnder, "fix:x", NOW, oneHour)).toBe(true);
    expect(isRecentSelfHeal(justOver, "fix:x", NOW, oneHour)).toBe(false);
  });

  test("scoped per recipe — different recipeId is independent", () => {
    const s = recordSelfHealFire({}, "fix:cron-pollution", NOW);
    expect(isRecentSelfHeal(s, "fix:supervisor-missing", NOW)).toBe(false);
    expect(isRecentSelfHeal(s, "fix:cron-pollution", NOW)).toBe(true);
  });

  test("future-stamped entries count as recent (clock-skew defensive)", () => {
    // lastFire > nowSec — could be NTP skew between writer + cron host.
    // Defensive: treat as recent (skip recipe) rather than re-fire.
    const s = { "fix:x": NOW + 10_000 };
    expect(isRecentSelfHeal(s, "fix:x", NOW)).toBe(true);
  });
});

// ---------- recordSelfHealFire ----------

describe("recordSelfHealFire", () => {
  test("records firing without losing prior recipes", () => {
    let s: SelfHealState = {};
    s = recordSelfHealFire(s, "fix:team-json-schema-drift", 1700000010);
    s = recordSelfHealFire(s, "fix:cron-pollution", 1700000020);
    expect(s["fix:team-json-schema-drift"]).toBe(1700000010);
    expect(s["fix:cron-pollution"]).toBe(1700000020);
  });

  test("re-firing the same recipe overwrites the timestamp", () => {
    let s: SelfHealState = {};
    s = recordSelfHealFire(s, "fix:cron-pollution", 1);
    s = recordSelfHealFire(s, "fix:cron-pollution", 999);
    expect(s["fix:cron-pollution"]).toBe(999);
  });

  test("returns a new state object — does not mutate input", () => {
    const original: SelfHealState = { "fix:a": 1 };
    const next = recordSelfHealFire(original, "fix:b", 2);
    expect(original).toEqual({ "fix:a": 1 }); // unchanged
    expect(next).toEqual({ "fix:a": 1, "fix:b": 2 });
    expect(next).not.toBe(original);
  });
});

// ---------- Integration: dedup-then-fire-then-skip cycle ----------

describe("integration — full dedup cycle", () => {
  test("skip-when-recent → fire-after-window-elapses pattern", () => {
    let now = 1_700_000_000;
    let s: SelfHealState = {};

    // Tick 1: never fired → not recent → record fire.
    expect(isRecentSelfHeal(s, "fix:cron-pollution", now)).toBe(false);
    s = recordSelfHealFire(s, "fix:cron-pollution", now);

    // Tick 2 (5 min later): recent → skip.
    now += 5 * 60;
    expect(isRecentSelfHeal(s, "fix:cron-pollution", now)).toBe(true);

    // Tick 3 (12h later): still recent (24h window) → skip.
    now += 12 * 3600;
    expect(isRecentSelfHeal(s, "fix:cron-pollution", now)).toBe(true);

    // Tick 4 (25h later cumulative — past 24h from fire) → not recent.
    now = 1_700_000_000 + 25 * 3600;
    expect(isRecentSelfHeal(s, "fix:cron-pollution", now)).toBe(false);

    // Re-fire stamps new epoch.
    s = recordSelfHealFire(s, "fix:cron-pollution", now);
    expect(s["fix:cron-pollution"]).toBe(now);
  });
});
