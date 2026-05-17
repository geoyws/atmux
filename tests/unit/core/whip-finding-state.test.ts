// Unit tests for src/core/whip-finding-state.ts (ADR-079 §D — per-
// template Discord-emit dedup gate).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_HEARTBEAT_SEC,
  HASH_HEX_LEN,
  hashFindingBullets,
  loadWhipFindingState,
  recordFindingFire,
  saveWhipFindingState,
  shouldFireFinding,
  type WhipFindingState,
  whipFindingStatePath,
} from "../../../src/core/whip-finding-state.ts";

let atmuxDir: string;

beforeEach(async () => {
  const tmp = await mkdtemp(join(tmpdir(), "atmux-wfs-"));
  atmuxDir = join(tmp, ".atmux");
  await mkdir(join(atmuxDir, "state"), { recursive: true });
});

afterEach(async () => {
  await rm(atmuxDir, { recursive: true, force: true }).catch(() => {});
});

// ---------- hashFindingBullets ----------

describe("hashFindingBullets", () => {
  test("returns a 16-hex-char string", () => {
    const h = hashFindingBullets(["a", "b"]);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(h).toHaveLength(HASH_HEX_LEN);
  });

  test("identical input → identical hash (deterministic)", () => {
    const a = hashFindingBullets(["x", "y", "z"]);
    const b = hashFindingBullets(["x", "y", "z"]);
    expect(a).toBe(b);
  });

  test("different input → different hash (collision-rare)", () => {
    expect(hashFindingBullets(["a"])).not.toBe(hashFindingBullets(["b"]));
    // Re-ordered → different hash (matches operator's "re-ordered set
    // IS a different observation" expectation per ADR-079 §D).
    expect(hashFindingBullets(["a", "b"])).not.toBe(hashFindingBullets(["b", "a"]));
  });

  test("empty array hashes deterministically", () => {
    expect(hashFindingBullets([])).toBe(hashFindingBullets([]));
    expect(hashFindingBullets([])).not.toBe(hashFindingBullets([""]));
  });
});

// ---------- shouldFireFinding (3 branches per ADR §D test plan) ----------

describe("shouldFireFinding — gate branches", () => {
  test("missing key → transition (first observation)", () => {
    const v = shouldFireFinding({}, "whip-blocker", "abc", 1_700_000_000);
    expect(v).toBe("transition");
  });

  test("changed hash → transition", () => {
    const state: WhipFindingState = {
      "whip-blocker": { hash: "old", lastFireSec: 1_700_000_000 },
    };
    expect(shouldFireFinding(state, "whip-blocker", "new", 1_700_000_001)).toBe("transition");
  });

  test("identical hash within heartbeat window → suppress", () => {
    const state: WhipFindingState = {
      "whip-blocker": { hash: "abc", lastFireSec: 1_700_000_000 },
    };
    // 30min later, default heartbeat 60min → suppress
    expect(shouldFireFinding(state, "whip-blocker", "abc", 1_700_000_000 + 30 * 60)).toBe(
      "suppress",
    );
  });

  test("identical hash past heartbeat window → heartbeat", () => {
    const state: WhipFindingState = {
      "whip-blocker": { hash: "abc", lastFireSec: 1_700_000_000 },
    };
    // exactly heartbeatSec later → heartbeat (boundary inclusive)
    expect(
      shouldFireFinding(state, "whip-blocker", "abc", 1_700_000_000 + DEFAULT_HEARTBEAT_SEC),
    ).toBe("heartbeat");
    // well past → also heartbeat
    expect(shouldFireFinding(state, "whip-blocker", "abc", 1_700_000_000 + 2 * 3600)).toBe(
      "heartbeat",
    );
  });

  test("Number.POSITIVE_INFINITY heartbeat → suppress permanently on stable hash", () => {
    const state: WhipFindingState = {
      "whip-blocker": { hash: "abc", lastFireSec: 1_700_000_000 },
    };
    // 1 year later, infinite heartbeat → still suppress
    expect(
      shouldFireFinding(
        state,
        "whip-blocker",
        "abc",
        1_700_000_000 + 365 * 86400,
        Number.POSITIVE_INFINITY,
      ),
    ).toBe("suppress");
  });

  test("per-template-key isolation (whip-blocker change doesn't trip whip-overdue suppress)", () => {
    const state: WhipFindingState = {
      "whip-blocker": { hash: "x", lastFireSec: 1_700_000_000 },
      "whip-overdue": { hash: "y", lastFireSec: 1_700_000_000 },
    };
    expect(shouldFireFinding(state, "whip-blocker", "x", 1_700_000_001)).toBe("suppress");
    expect(shouldFireFinding(state, "whip-overdue", "y", 1_700_000_001)).toBe("suppress");
    // Changing only whip-blocker's hash leaves whip-overdue's suppress intact.
    expect(shouldFireFinding(state, "whip-blocker", "X", 1_700_000_001)).toBe("transition");
    expect(shouldFireFinding(state, "whip-overdue", "y", 1_700_000_001)).toBe("suppress");
  });
});

// ---------- recordFindingFire (pure update) ----------

describe("recordFindingFire", () => {
  test("stamps key + leaves other keys intact", () => {
    const state: WhipFindingState = {
      "whip-overdue": { hash: "old", lastFireSec: 100 },
    };
    const next = recordFindingFire(state, "whip-blocker", "newhash", 200);
    expect(next["whip-blocker"]).toEqual({ hash: "newhash", lastFireSec: 200 });
    expect(next["whip-overdue"]).toEqual({ hash: "old", lastFireSec: 100 });
    // Original state not mutated.
    expect(state["whip-blocker"]).toBeUndefined();
  });

  test("overwrite same key with new hash + epoch", () => {
    const state: WhipFindingState = {
      "whip-blocker": { hash: "h1", lastFireSec: 100 },
    };
    const next = recordFindingFire(state, "whip-blocker", "h2", 200);
    expect(next["whip-blocker"]).toEqual({ hash: "h2", lastFireSec: 200 });
  });
});

// ---------- I/O round-trip + corruption tolerance ----------

describe("loadWhipFindingState / saveWhipFindingState", () => {
  test("missing file → empty map", async () => {
    expect(await loadWhipFindingState(atmuxDir)).toEqual({});
  });

  test("round-trip: save then load returns identical state", async () => {
    const state: WhipFindingState = {
      "whip-blocker": { hash: "abc", lastFireSec: 1_700_000_000 },
      "whip-progress": { hash: "def", lastFireSec: 1_700_000_500 },
    };
    await saveWhipFindingState(atmuxDir, state);
    expect(await loadWhipFindingState(atmuxDir)).toEqual(state);
  });

  test("malformed JSON → empty map (no throw)", async () => {
    const path = whipFindingStatePath(atmuxDir);
    await Bun.write(path, "{not json");
    expect(await loadWhipFindingState(atmuxDir)).toEqual({});
  });

  test("non-object root JSON → empty map", async () => {
    const path = whipFindingStatePath(atmuxDir);
    await Bun.write(path, JSON.stringify(["array", "not", "object"]));
    expect(await loadWhipFindingState(atmuxDir)).toEqual({});
  });

  test("missing/invalid per-key fields → key dropped silently", async () => {
    const path = whipFindingStatePath(atmuxDir);
    await Bun.write(
      path,
      JSON.stringify({
        good: { hash: "abc", lastFireSec: 100 },
        "no-hash": { lastFireSec: 100 },
        "bad-epoch": { hash: "x", lastFireSec: "not-a-number" },
        "empty-hash": { hash: "", lastFireSec: 100 },
      }),
    );
    const got = await loadWhipFindingState(atmuxDir);
    expect(Object.keys(got)).toEqual(["good"]);
    expect(got["good"]).toEqual({ hash: "abc", lastFireSec: 100 });
  });

  test("save writes pretty-printed JSON with trailing newline", async () => {
    const state: WhipFindingState = {
      "whip-blocker": { hash: "abc", lastFireSec: 100 },
    };
    await saveWhipFindingState(atmuxDir, state);
    const txt = await readFile(whipFindingStatePath(atmuxDir), "utf8");
    expect(txt.endsWith("\n")).toBe(true);
    expect(txt).toContain("\n  "); // 2-space indent (pretty print)
  });
});
