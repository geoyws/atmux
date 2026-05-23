// ADR-232 §D1 — dispatchEpicMerge unit coverage.
//
// Pins per task t-3-bfbda5d8 AC:
//   - Function exported + Zod-validated input/output.
//   - LOCAL route invokes performEpicMerge (via invokeLocal hook) and
//     returns its result mapped to DispatchEpicMergeResult shape.
//   - REMOTE route emits dispatch message + returns ack/error correctly.
//   - Failure surfaces atmux flag add with epicId + target cage +
//     stderrTail in body.
//   - cage-not-found path → flag-add + gate-held.

import { describe, expect, test } from "bun:test";
import type {
  SpawnOpts,
  SpawnResult,
  spawn as defaultSpawnType,
} from "../../../../src/abstractions/spawn.ts";
import type { PerformEpicMergeResult } from "../../../../src/core/epic-merge.ts";
import {
  type CageInfo,
  DispatchEpicMergeInputSchema,
  DispatchEpicMergeResultSchema,
  dispatchEpicMerge,
  type FlagAddInput,
  mapLocalResult,
  type RemoteAckResult,
} from "../../../../src/core/orchd-dispatch/epic-merge.ts";

// Stub spawn factory — returns a typed spawn that records calls + answers
// per-call from a scripted result list. Used to drive the default
// dispatchRemote / flagAdd hooks without forking real processes.
function stubSpawn(
  scripts: Array<Partial<SpawnResult>>,
): {
  spawn: typeof defaultSpawnType;
  calls: SpawnOpts[];
} {
  const calls: SpawnOpts[] = [];
  let i = 0;
  const spawn = (async (opts: SpawnOpts): Promise<SpawnResult> => {
    calls.push(opts);
    const next = scripts[i++] ?? {};
    return {
      cmd: opts.cmd,
      argv: opts.argv ?? [],
      exitCode: next.exitCode ?? 0,
      signalled: next.signalled ?? null,
      stdout: next.stdout ?? "",
      stderr: next.stderr ?? "",
      durationMs: next.durationMs ?? 0,
    };
  }) as typeof defaultSpawnType;
  return { spawn, calls };
}

// ---------- Test fixtures ----------

const LOCAL_CAGE: CageInfo = {
  name: "e-60e16169",
  root: "/tmp/atmux-test-cage",
  parentBase: "atmux-geoyws",
};

const REMOTE_CAGE: CageInfo = {
  name: "e-a946af69",
  root: "/tmp/atmux-test-remote-cage",
  parentBase: "atmux-geoyws",
};

function captureFlagAdd(): {
  hook: (input: FlagAddInput) => Promise<void>;
  calls: FlagAddInput[];
} {
  const calls: FlagAddInput[] = [];
  return {
    hook: async (input) => {
      calls.push(input);
    },
    calls,
  };
}

// ---------- Schema validation ----------

describe("DispatchEpicMergeInputSchema", () => {
  test("accepts well-formed input", () => {
    expect(DispatchEpicMergeInputSchema.parse({ epicId: "e-60e16169" })).toEqual({
      epicId: "e-60e16169",
    });
    expect(
      DispatchEpicMergeInputSchema.parse({
        epicId: "e-60e16169",
        targetCage: "e-other",
      }),
    ).toEqual({ epicId: "e-60e16169", targetCage: "e-other" });
  });

  test("rejects empty epicId", () => {
    expect(() => DispatchEpicMergeInputSchema.parse({ epicId: "" })).toThrow();
  });

  test("rejects missing epicId", () => {
    expect(() => DispatchEpicMergeInputSchema.parse({})).toThrow();
  });
});

describe("DispatchEpicMergeResultSchema", () => {
  test("accepts all 5 union variants", () => {
    expect(() =>
      DispatchEpicMergeResultSchema.parse({
        state: "merged",
        parentBase: "main",
        mergeSha: "abc1234",
      }),
    ).not.toThrow();
    expect(() =>
      DispatchEpicMergeResultSchema.parse({ state: "merge-conflict", reason: "x.ts" }),
    ).not.toThrow();
    expect(() =>
      DispatchEpicMergeResultSchema.parse({ state: "gate-held", reason: "rebase pending" }),
    ).not.toThrow();
    expect(() => DispatchEpicMergeResultSchema.parse({ state: "already-merged" })).not.toThrow();
    expect(() =>
      DispatchEpicMergeResultSchema.parse({ state: "skipped-not-mine" }),
    ).not.toThrow();
  });

  test("rejects unknown state", () => {
    expect(() => DispatchEpicMergeResultSchema.parse({ state: "weird" })).toThrow();
  });
});

// ---------- LOCAL route ----------

describe("dispatchEpicMerge — LOCAL route", () => {
  test("invokes invokeLocal + maps merged result with SHA", async () => {
    const invokeLocal = async (
      _epicId: string,
      _cage: CageInfo,
    ): Promise<PerformEpicMergeResult> => ({
      state: "merged",
      changed: true,
      reason: "merge sha deadbeef on atmux-geoyws",
      mergedSha: "deadbeefcafe",
      dissolveDispatched: true,
    });
    const flag = captureFlagAdd();

    const r = await dispatchEpicMerge(
      { epicId: "e-60e16169" },
      {
        resolveCage: async () => LOCAL_CAGE,
        isLocalCage: () => true,
        invokeLocal,
        flagAdd: flag.hook,
      },
    );

    expect(r).toEqual({
      state: "merged",
      parentBase: "atmux-geoyws",
      mergeSha: "deadbeefcafe",
    });
    expect(flag.calls).toEqual([]);
  });

  test("maps merged result without SHA → already-merged (no-op merge)", async () => {
    const invokeLocal = async (): Promise<PerformEpicMergeResult> => ({
      state: "merged",
      changed: true,
      reason: "no-op (no commits ahead) — dissolve still pending",
      dissolveDispatched: true,
    });
    const r = await dispatchEpicMerge(
      { epicId: "e-60e16169" },
      { resolveCage: async () => LOCAL_CAGE, isLocalCage: () => true, invokeLocal },
    );
    expect(r).toEqual({ state: "already-merged" });
  });

  test("maps conflict → merge-conflict", async () => {
    const invokeLocal = async (): Promise<PerformEpicMergeResult> => ({
      state: "conflict",
      changed: true,
      reason: "conflict on epic-x: src/a.ts, src/b.ts",
      dissolveDispatched: false,
    });
    const r = await dispatchEpicMerge(
      { epicId: "e-60e16169" },
      { resolveCage: async () => LOCAL_CAGE, isLocalCage: () => true, invokeLocal },
    );
    expect(r).toEqual({
      state: "merge-conflict",
      reason: "conflict on epic-x: src/a.ts, src/b.ts",
    });
  });

  test("maps in-progress / gate-held states → gate-held", async () => {
    const invokeLocal = async (): Promise<PerformEpicMergeResult> => ({
      state: "in_progress",
      changed: false,
      reason: "missing reviewer-trunk-signoff",
      dissolveDispatched: false,
    });
    const r = await dispatchEpicMerge(
      { epicId: "e-60e16169" },
      { resolveCage: async () => LOCAL_CAGE, isLocalCage: () => true, invokeLocal },
    );
    expect(r).toEqual({ state: "gate-held", reason: "missing reviewer-trunk-signoff" });
  });

  test("LOCAL path without invokeLocal returns gate-held (wire-up gap, no flag)", async () => {
    const flag = captureFlagAdd();
    const r = await dispatchEpicMerge(
      { epicId: "e-60e16169" },
      {
        resolveCage: async () => LOCAL_CAGE,
        isLocalCage: () => true,
        flagAdd: flag.hook,
        // invokeLocal: undefined
      },
    );
    expect(r.state).toBe("gate-held");
    if (r.state === "gate-held") {
      expect(r.reason).toContain("local invoker not wired");
    }
    // Wire-up gap is NOT a flag-add condition — the gate-held + the
    // subscriber's merge-blocked emit are sufficient operator signal.
    expect(flag.calls).toEqual([]);
  });
});

// ---------- REMOTE route ----------

describe("dispatchEpicMerge — REMOTE route", () => {
  test("ok=true → skipped-not-mine with cage name in reason", async () => {
    let dispatchedEpicId: string | null = null;
    let dispatchedCage: CageInfo | null = null;
    const dispatchRemote = async (
      epicId: string,
      cage: CageInfo,
    ): Promise<RemoteAckResult> => {
      dispatchedEpicId = epicId;
      dispatchedCage = cage;
      return { ok: true };
    };
    const flag = captureFlagAdd();

    const r = await dispatchEpicMerge(
      { epicId: "e-60e16169" },
      {
        resolveCage: async () => REMOTE_CAGE,
        isLocalCage: () => false,
        dispatchRemote,
        flagAdd: flag.hook,
      },
    );

    expect(dispatchedEpicId).toBe("e-60e16169");
    expect(dispatchedCage).toEqual(REMOTE_CAGE);
    expect(r.state).toBe("skipped-not-mine");
    if (r.state === "skipped-not-mine") {
      expect(r.reason).toContain(REMOTE_CAGE.name);
      expect(r.reason).toContain("dispatched");
    }
    expect(flag.calls).toEqual([]);
  });

  test("ok=false → flag-add + gate-held with stderr in body", async () => {
    const dispatchRemote = async (): Promise<RemoteAckResult> => ({
      ok: false,
      stderrTail: "atmux: command not found in target cage",
    });
    const flag = captureFlagAdd();

    const r = await dispatchEpicMerge(
      { epicId: "e-60e16169" },
      {
        resolveCage: async () => REMOTE_CAGE,
        isLocalCage: () => false,
        dispatchRemote,
        flagAdd: flag.hook,
      },
    );

    expect(r.state).toBe("gate-held");
    if (r.state === "gate-held") {
      expect(r.reason).toContain(REMOTE_CAGE.name);
      expect(r.reason).toContain("atmux: command not found");
    }
    expect(flag.calls).toHaveLength(1);
    const flagInput = flag.calls[0];
    if (flagInput === undefined) throw new Error("flag call missing");
    expect(flagInput.epicId).toBe("e-60e16169");
    expect(flagInput.targetCage).toBe(REMOTE_CAGE.name);
    expect(flagInput.stderrTail).toBe("atmux: command not found in target cage");
  });

  test("ok=false with empty stderr → flag carries '(no stderr captured)' placeholder", async () => {
    const dispatchRemote = async (): Promise<RemoteAckResult> => ({ ok: false });
    const flag = captureFlagAdd();
    await dispatchEpicMerge(
      { epicId: "e-x" },
      {
        resolveCage: async () => REMOTE_CAGE,
        isLocalCage: () => false,
        dispatchRemote,
        flagAdd: flag.hook,
      },
    );
    expect(flag.calls).toHaveLength(1);
    const flagInput = flag.calls[0];
    if (flagInput === undefined) throw new Error("flag call missing");
    expect(flagInput.stderrTail).toBe("(no stderr captured)");
  });

  test("targetCage override forces REMOTE path (empty root)", async () => {
    let dispatchedCage: CageInfo | null = null;
    const dispatchRemote = async (
      _e: string,
      cage: CageInfo,
    ): Promise<RemoteAckResult> => {
      dispatchedCage = cage;
      return { ok: true };
    };
    const r = await dispatchEpicMerge(
      { epicId: "e-60e16169", targetCage: "e-override" },
      {
        // resolveCage MUST NOT be called when targetCage override is present.
        resolveCage: async () => {
          throw new Error("resolveCage should not run with targetCage override");
        },
        isLocalCage: () => true, // even if forced true, empty root skips LOCAL
        dispatchRemote,
      },
    );
    expect(r.state).toBe("skipped-not-mine");
    expect(dispatchedCage?.name).toBe("e-override");
    expect(dispatchedCage?.root).toBe("");
  });
});

// ---------- cage-not-found ----------

describe("dispatchEpicMerge — cage-not-found", () => {
  test("resolveCage returns null → flag-add + gate-held", async () => {
    const flag = captureFlagAdd();
    const r = await dispatchEpicMerge(
      { epicId: "e-unknown" },
      {
        resolveCage: async () => null,
        flagAdd: flag.hook,
      },
    );
    expect(r.state).toBe("gate-held");
    if (r.state === "gate-held") {
      expect(r.reason).toContain("cage not found for epic e-unknown");
    }
    expect(flag.calls).toHaveLength(1);
    const flagInput = flag.calls[0];
    if (flagInput === undefined) throw new Error("flag call missing");
    expect(flagInput.epicId).toBe("e-unknown");
    expect(flagInput.targetCage).toBe("(unresolved)");
    expect(flagInput.stderrTail).toContain("registry walk returned no match");
  });
});

// ---------- Input validation ----------

describe("dispatchEpicMerge — input validation", () => {
  test("invalid input throws before any side effects", async () => {
    const flag = captureFlagAdd();
    const dispatchRemote = async (): Promise<RemoteAckResult> => {
      throw new Error("dispatchRemote should not run on invalid input");
    };
    await expect(
      dispatchEpicMerge(
        // @ts-expect-error — deliberately invalid
        { epicId: "" },
        { flagAdd: flag.hook, dispatchRemote },
      ),
    ).rejects.toThrow();
    expect(flag.calls).toEqual([]);
  });
});

// ---------- Default impls (via spawn injection) ----------

describe("dispatchEpicMerge — default dispatchRemote (Bun subprocess per §D2 path A)", () => {
  test("exit 0 → ok=true; argv carries --topic epic.merge-request + --epic-id + cwd=cage.root", async () => {
    const stub = stubSpawn([{ exitCode: 0 }]);
    const r = await dispatchEpicMerge(
      { epicId: "e-60e16169" },
      {
        resolveCage: async () => REMOTE_CAGE,
        isLocalCage: () => false,
        spawn: stub.spawn,
        // dispatchRemote: undefined → exercise default
      },
    );
    expect(r.state).toBe("skipped-not-mine");
    // Only one spawn call expected (the dispatch); flagAdd not invoked on success.
    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0];
    if (call === undefined) throw new Error("spawn call missing");
    expect(call.cmd).toBe("atmux");
    expect(call.argv).toEqual([
      "orchd",
      "--handle-one",
      "--topic",
      "epic.merge-request",
      "--epic-id",
      "e-60e16169",
    ]);
    expect(call.cwd).toBe(REMOTE_CAGE.root);
  });

  test("non-zero exit → ok=false with stderr tail; flagAdd default fires", async () => {
    const stub = stubSpawn([
      { exitCode: 1, stderr: "orchd: target cage daemon not responding" },
      { exitCode: 0 }, // flag-add call
    ]);
    const r = await dispatchEpicMerge(
      { epicId: "e-60e16169" },
      {
        resolveCage: async () => REMOTE_CAGE,
        isLocalCage: () => false,
        spawn: stub.spawn,
      },
    );
    expect(r.state).toBe("gate-held");
    if (r.state === "gate-held") {
      expect(r.reason).toContain("orchd: target cage daemon not responding");
    }
    // Two spawn calls: dispatchRemote + flagAdd.
    expect(stub.calls).toHaveLength(2);
    const flagCall = stub.calls[1];
    if (flagCall === undefined) throw new Error("flag spawn call missing");
    expect(flagCall.cmd).toBe("atmux");
    expect(flagCall.argv?.slice(0, 2)).toEqual(["flag", "add"]);
    const body = flagCall.argv?.[2] ?? "";
    expect(body).toContain("e-60e16169");
    expect(body).toContain(REMOTE_CAGE.name);
    expect(body).toContain("orchd: target cage daemon not responding");
    expect(flagCall.argv).toContain("--severity");
    expect(flagCall.argv).toContain("p1");
  });

  test("default dispatchRemote: spawn-throw → ok=false with thrown message", async () => {
    const throwingSpawn = (async () => {
      throw new Error("ENOENT: atmux not on PATH");
    }) as typeof defaultSpawnType;
    const flag = captureFlagAdd();
    const r = await dispatchEpicMerge(
      { epicId: "e-60e16169" },
      {
        resolveCage: async () => REMOTE_CAGE,
        isLocalCage: () => false,
        spawn: throwingSpawn,
        flagAdd: flag.hook,
      },
    );
    expect(r.state).toBe("gate-held");
    if (r.state === "gate-held") {
      expect(r.reason).toContain("ENOENT: atmux not on PATH");
      expect(r.reason).toContain("spawn threw");
    }
    expect(flag.calls).toHaveLength(1);
  });

  test("default flagAdd: spawn-throw is swallowed (best-effort side effect)", async () => {
    // First call (dispatchRemote) returns non-zero; second call (flagAdd)
    // throws — must not propagate.
    let callIdx = 0;
    const spawn = (async (opts: SpawnOpts): Promise<SpawnResult> => {
      callIdx += 1;
      if (callIdx === 1) {
        return {
          cmd: opts.cmd,
          argv: opts.argv ?? [],
          exitCode: 2,
          signalled: null,
          stdout: "",
          stderr: "boom",
          durationMs: 0,
        };
      }
      throw new Error("flag add subprocess died");
    }) as typeof defaultSpawnType;

    const r = await dispatchEpicMerge(
      { epicId: "e-60e16169" },
      {
        resolveCage: async () => REMOTE_CAGE,
        isLocalCage: () => false,
        spawn,
      },
    );
    expect(r.state).toBe("gate-held");
  });

  test("default dispatchRemote: huge stderr is tailed to last 500 chars", async () => {
    const big = "x".repeat(2000);
    const stub = stubSpawn([
      { exitCode: 1, stderr: big },
      { exitCode: 0 },
    ]);
    const r = await dispatchEpicMerge(
      { epicId: "e-60e16169" },
      {
        resolveCage: async () => REMOTE_CAGE,
        isLocalCage: () => false,
        spawn: stub.spawn,
      },
    );
    expect(r.state).toBe("gate-held");
    if (r.state === "gate-held") {
      // 500-char tail substring is in the reason; full body is NOT.
      const reasonStderr = r.reason.slice(r.reason.indexOf("xxx"));
      expect(reasonStderr.length).toBeLessThanOrEqual(500 + 64); // 500 + suffix slack
    }
  });

  test("default dispatchRemote: empty stderr falls back to stdout for tail", async () => {
    const stub = stubSpawn([
      { exitCode: 3, stderr: "", stdout: "merge would conflict on a.ts" },
      { exitCode: 0 },
    ]);
    const r = await dispatchEpicMerge(
      { epicId: "e-60e16169" },
      {
        resolveCage: async () => REMOTE_CAGE,
        isLocalCage: () => false,
        spawn: stub.spawn,
      },
    );
    expect(r.state).toBe("gate-held");
    if (r.state === "gate-held") {
      expect(r.reason).toContain("merge would conflict on a.ts");
    }
  });
});

describe("dispatchEpicMerge — default resolveCage / isLocalCage", () => {
  test("default resolveCage returns null → cage-not-found path", async () => {
    // No resolveCage override, no targetCage → default returns null.
    const stub = stubSpawn([{ exitCode: 0 }]); // flagAdd default
    const r = await dispatchEpicMerge(
      { epicId: "e-unknown" },
      { spawn: stub.spawn },
    );
    expect(r.state).toBe("gate-held");
    if (r.state === "gate-held") {
      expect(r.reason).toContain("cage not found");
    }
    // flagAdd default fired once.
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.argv?.slice(0, 2)).toEqual(["flag", "add"]);
  });

  test("default isLocalCage matches cwd prefix", async () => {
    const cwdCage: CageInfo = { name: "x", root: process.cwd(), parentBase: "main" };
    const invokeLocal = async (): Promise<PerformEpicMergeResult> => ({
      state: "merged",
      changed: true,
      reason: "ok",
      mergedSha: "abc",
      dissolveDispatched: false,
    });
    const r = await dispatchEpicMerge(
      { epicId: "e-x" },
      {
        resolveCage: async () => cwdCage,
        // isLocalCage: undefined → exercise default; cwd === cage.root → true.
        invokeLocal,
      },
    );
    expect(r.state).toBe("merged");
  });

  test("default isLocalCage rejects cage with empty root", async () => {
    const emptyRoot: CageInfo = { name: "x", root: "", parentBase: "main" };
    const stub = stubSpawn([{ exitCode: 0 }]);
    // empty root forces REMOTE path; default dispatchRemote fires.
    const r = await dispatchEpicMerge(
      { epicId: "e-x" },
      {
        resolveCage: async () => emptyRoot,
        spawn: stub.spawn,
      },
    );
    expect(r.state).toBe("skipped-not-mine");
  });
});

// ---------- mapLocalResult (pure helper) ----------

describe("mapLocalResult", () => {
  test("merged + SHA → merged variant with cage.parentBase", () => {
    const r = mapLocalResult(
      {
        state: "merged",
        changed: true,
        reason: "ok",
        mergedSha: "abc123",
        dissolveDispatched: true,
      },
      LOCAL_CAGE,
    );
    expect(r).toEqual({
      state: "merged",
      parentBase: LOCAL_CAGE.parentBase,
      mergeSha: "abc123",
    });
  });

  test("merged without SHA → already-merged", () => {
    const r = mapLocalResult(
      {
        state: "merged",
        changed: true,
        reason: "no-op",
        dissolveDispatched: false,
      },
      LOCAL_CAGE,
    );
    expect(r).toEqual({ state: "already-merged" });
  });

  test("merged with empty SHA → already-merged", () => {
    const r = mapLocalResult(
      {
        state: "merged",
        changed: true,
        reason: "no-op",
        mergedSha: "",
        dissolveDispatched: false,
      },
      LOCAL_CAGE,
    );
    expect(r).toEqual({ state: "already-merged" });
  });

  test("conflict → merge-conflict with reason", () => {
    const r = mapLocalResult(
      {
        state: "conflict",
        changed: true,
        reason: "conflict on x: a.ts",
        dissolveDispatched: false,
      },
      LOCAL_CAGE,
    );
    expect(r).toEqual({ state: "merge-conflict", reason: "conflict on x: a.ts" });
  });

  test("non-terminal states → gate-held", () => {
    const states: PerformEpicMergeResult["state"][] = [
      "open",
      "in_progress",
      "ready_to_merge",
      "rebasing",
      "merging",
      "tested",
      "test_failed",
    ];
    for (const state of states) {
      const r = mapLocalResult(
        {
          state,
          changed: false,
          reason: `state ${state} reason`,
          dissolveDispatched: false,
        },
        LOCAL_CAGE,
      );
      expect(r.state).toBe("gate-held");
      if (r.state === "gate-held") {
        expect(r.reason).toBe(`state ${state} reason`);
      }
    }
  });
});
