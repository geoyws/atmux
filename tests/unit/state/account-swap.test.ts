// Unit tests for `.atmux/state/account-swap.json` state-file lifecycle
// (ADR-056 R1-T12 §D9).
//
// State-file shape, lock contention, idempotence on tick interruption,
// aborted-resume. Sister tests covering the per-member workflow +
// orchestrator live in tests/unit/core/account-swap.test.ts; this file
// isolates the durable state-file lifecycle per ADR-056 §D9
// "tests/unit/state/account-swap.test.ts".

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  abortInProgressDecisions,
  type AccountSwapState,
  accountSwapStatePath,
  clearAccountSwapState,
  isAccountSwapActive,
  isStaleActiveState,
  loadAccountSwapState,
  STALE_PROGRESS_SEC,
  type SwapDecision,
  type SwapTrigger,
  withAccountSwapLock,
  writeAccountSwapState,
} from "../../../src/core/account-swap.ts";

let atmuxDir: string;

beforeEach(async () => {
  atmuxDir = await mkdtemp(join(tmpdir(), "atmux-account-swap-state-"));
  await mkdir(join(atmuxDir, "state"), { recursive: true });
});

afterEach(async () => {
  await rm(atmuxDir, { recursive: true, force: true });
});

// ---------- Path ----------

describe("accountSwapStatePath", () => {
  test("appends state/account-swap.json to atmuxDir", () => {
    expect(accountSwapStatePath("/tmp/foo")).toBe("/tmp/foo/state/account-swap.json");
  });
});

// ---------- Sample fixtures ----------

function trigger(overrides?: Partial<SwapTrigger>): SwapTrigger {
  return {
    account: "ifca",
    h5_pct_used: 95,
    wk_pct_used: 60,
    ...overrides,
  };
}

function decision(overrides: Partial<SwapDecision> & { from: string; to: string }): SwapDecision {
  return {
    status: "pending",
    startedAt: null,
    finishedAt: null,
    shadowName: null,
    ...overrides,
  };
}

function activeState(overrides?: Partial<AccountSwapState>): AccountSwapState {
  return {
    active: true,
    passId: "swap-deadbeef",
    startedAt: 1700000000,
    trigger: trigger(),
    decisions: { alice: decision({ from: "ifca", to: "icloud" }) },
    history: [],
    ...overrides,
  };
}

// ---------- Load / write round-trip ----------

describe("loadAccountSwapState + writeAccountSwapState", () => {
  test("absent file → null", async () => {
    expect(await loadAccountSwapState(atmuxDir)).toBeNull();
  });

  test("write → read round-trip preserves all fields", async () => {
    const original = activeState();
    await writeAccountSwapState(atmuxDir, original);
    const loaded = await loadAccountSwapState(atmuxDir);
    expect(loaded).toEqual(original);
  });

  test("malformed JSON → null (corrupt-fresh)", async () => {
    await writeFile(accountSwapStatePath(atmuxDir), "{not json");
    expect(await loadAccountSwapState(atmuxDir)).toBeNull();
  });

  test("shape mismatch → null (defensive)", async () => {
    await writeFile(accountSwapStatePath(atmuxDir), JSON.stringify({ active: true }));
    expect(await loadAccountSwapState(atmuxDir)).toBeNull();
  });

  test("decisions can carry status=in-progress + done + aborted + excluded", async () => {
    const s = activeState({
      decisions: {
        alice: decision({ from: "ifca", to: "icloud", status: "done", finishedAt: 1700000100 }),
        bob: decision({ from: "ifca", to: "icloud", status: "aborted" }),
        carl: decision({ from: "ifca", to: "icloud", status: "excluded" }),
        dee: decision({ from: "ifca", to: "icloud", status: "in-progress", startedAt: 1700000050 }),
      },
    });
    await writeAccountSwapState(atmuxDir, s);
    const loaded = await loadAccountSwapState(atmuxDir);
    expect(loaded?.decisions?.alice?.status).toBe("done");
    expect(loaded?.decisions?.bob?.status).toBe("aborted");
    expect(loaded?.decisions?.carl?.status).toBe("excluded");
    expect(loaded?.decisions?.dee?.status).toBe("in-progress");
  });

  test("history entries preserved across round-trip", async () => {
    const s = activeState({
      active: false,
      history: [
        {
          passId: "swap-prev1",
          completedAt: 1699999000,
          swapped: 3,
          excluded: 1,
          aborted: 0,
        },
      ],
    });
    await writeAccountSwapState(atmuxDir, s);
    const loaded = await loadAccountSwapState(atmuxDir);
    expect(loaded?.history).toHaveLength(1);
    expect(loaded?.history[0]?.passId).toBe("swap-prev1");
  });

  test("rejects entries with invalid status (defensive validation)", async () => {
    await writeFile(
      accountSwapStatePath(atmuxDir),
      JSON.stringify({
        active: true,
        passId: "swap-x",
        startedAt: 1,
        trigger: trigger(),
        decisions: {
          alice: {
            from: "a",
            to: "b",
            status: "bogus",
            startedAt: null,
            finishedAt: null,
            shadowName: null,
          },
        },
        history: [],
      }),
    );
    expect(await loadAccountSwapState(atmuxDir)).toBeNull();
  });
});

// ---------- isAccountSwapActive ----------

describe("isAccountSwapActive", () => {
  test("false when state file is absent", async () => {
    expect(await isAccountSwapActive(atmuxDir)).toBe(false);
  });

  test("true when state file present and active=true", async () => {
    await writeAccountSwapState(atmuxDir, activeState());
    expect(await isAccountSwapActive(atmuxDir)).toBe(true);
  });

  test("false when state file present but active=false (history-only)", async () => {
    await writeAccountSwapState(
      atmuxDir,
      activeState({
        active: false,
        decisions: {},
        history: [{ passId: "swap-old", completedAt: 1, swapped: 0, excluded: 0, aborted: 0 }],
      }),
    );
    expect(await isAccountSwapActive(atmuxDir)).toBe(false);
  });
});

// ---------- clearAccountSwapState ----------

describe("clearAccountSwapState", () => {
  test("removes state file", async () => {
    await writeAccountSwapState(atmuxDir, activeState());
    expect(await isAccountSwapActive(atmuxDir)).toBe(true);
    await clearAccountSwapState(atmuxDir);
    expect(await isAccountSwapActive(atmuxDir)).toBe(false);
  });

  test("idempotent on already-absent state", async () => {
    await clearAccountSwapState(atmuxDir);
    await clearAccountSwapState(atmuxDir);
    expect(await isAccountSwapActive(atmuxDir)).toBe(false);
  });
});

// ---------- isStaleActiveState — idempotence on tick interruption ----------

describe("isStaleActiveState", () => {
  test("inactive state is never stale", () => {
    const s = activeState({
      active: false,
      startedAt: 0,
      decisions: {},
    });
    expect(isStaleActiveState(s, 9_999_999_999)).toBe(false);
  });

  test("active state with recent startedAt → not stale", () => {
    const s = activeState({ startedAt: 1700000000, decisions: {} });
    expect(isStaleActiveState(s, 1700000000 + 60)).toBe(false);
  });

  test("active state with no progress and age > STALE_PROGRESS_SEC → stale", () => {
    const s = activeState({ startedAt: 1700000000, decisions: {} });
    expect(isStaleActiveState(s, 1700000000 + STALE_PROGRESS_SEC + 1)).toBe(true);
  });

  test("active state with recent decision activity → not stale", () => {
    const s = activeState({
      startedAt: 1700000000,
      decisions: {
        alice: decision({
          from: "ifca",
          to: "icloud",
          status: "in-progress",
          startedAt: 1700000000 + STALE_PROGRESS_SEC, // recent
        }),
      },
    });
    expect(isStaleActiveState(s, 1700000000 + STALE_PROGRESS_SEC + 60)).toBe(false);
  });

  test("active state with old finishedAt > STALE → stale (no recent forward progress)", () => {
    const s = activeState({
      startedAt: 1700000000,
      decisions: {
        alice: decision({
          from: "ifca",
          to: "icloud",
          status: "done",
          startedAt: 1700000000,
          finishedAt: 1700000050,
        }),
      },
    });
    expect(isStaleActiveState(s, 1700000050 + STALE_PROGRESS_SEC + 1)).toBe(true);
  });
});

// ---------- abortInProgressDecisions — aborted-resume ----------

describe("abortInProgressDecisions", () => {
  test("flips in-progress decisions to aborted; leaves others untouched", () => {
    const before = activeState({
      decisions: {
        alice: decision({ from: "ifca", to: "icloud", status: "in-progress", startedAt: 1 }),
        bob: decision({ from: "ifca", to: "icloud", status: "done", finishedAt: 2 }),
        carl: decision({ from: "ifca", to: "icloud", status: "pending" }),
        dee: decision({ from: "ifca", to: "icloud", status: "excluded" }),
      },
    });
    const after = abortInProgressDecisions(before, 9999);
    expect(after.decisions?.alice?.status).toBe("aborted");
    expect(after.decisions?.alice?.finishedAt).toBe(9999);
    expect(after.decisions?.bob?.status).toBe("done"); // untouched
    expect(after.decisions?.carl?.status).toBe("pending");
    expect(after.decisions?.dee?.status).toBe("excluded");
  });

  test("returns same state when nothing in-progress", () => {
    const s = activeState({
      decisions: { alice: decision({ from: "a", to: "b", status: "done", finishedAt: 1 }) },
    });
    const after = abortInProgressDecisions(s, 9999);
    // Same shape (deep equal); reference may differ but content unchanged.
    expect(after.decisions).toEqual(s.decisions);
  });
});

// ---------- withAccountSwapLock ----------

describe("withAccountSwapLock", () => {
  test("runs fn under flock + returns its value", async () => {
    const result = await withAccountSwapLock(atmuxDir, async () => "hello");
    expect(result).toBe("hello");
  });

  test("releases lock on fn throw", async () => {
    let caught = false;
    try {
      await withAccountSwapLock(atmuxDir, async () => {
        throw new Error("boom");
      });
    } catch {
      caught = true;
    }
    expect(caught).toBe(true);
    // Subsequent acquire should succeed (lock was released).
    const result = await withAccountSwapLock(atmuxDir, async () => "after");
    expect(result).toBe("after");
  });

  test("serializes concurrent fn invocations", async () => {
    const events: string[] = [];
    const slow = async (label: string): Promise<void> => {
      await withAccountSwapLock(atmuxDir, async () => {
        events.push(`${label}-start`);
        await new Promise((res) => setTimeout(res, 30));
        events.push(`${label}-end`);
      });
    };
    await Promise.all([slow("A"), slow("B")]);
    // Either A completes fully before B, or B before A — never interleaved.
    const aStartIdx = events.indexOf("A-start");
    const aEndIdx = events.indexOf("A-end");
    const bStartIdx = events.indexOf("B-start");
    const bEndIdx = events.indexOf("B-end");
    expect(aEndIdx).toBeGreaterThan(aStartIdx);
    expect(bEndIdx).toBeGreaterThan(bStartIdx);
    // No interleave: either all of A then all of B, or vice versa.
    expect(aEndIdx === aStartIdx + 1 || bEndIdx === bStartIdx + 1).toBe(true);
  });
});

// ---------- File IO + bash-readable shape ----------

describe("file IO + bash-readable shape", () => {
  test("writeAccountSwapState produces JSON the bash side can cat-read", async () => {
    const s = activeState();
    await writeAccountSwapState(atmuxDir, s);
    const text = await readFile(accountSwapStatePath(atmuxDir), "utf8");
    expect(JSON.parse(text)).toEqual(s);
  });

  test("write overwrites existing file", async () => {
    await writeAccountSwapState(atmuxDir, activeState({ passId: "swap-1" }));
    await writeAccountSwapState(atmuxDir, activeState({ passId: "swap-2" }));
    expect((await loadAccountSwapState(atmuxDir))?.passId).toBe("swap-2");
  });
});
