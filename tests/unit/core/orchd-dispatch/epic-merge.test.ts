// ADR-232 §D1 + §D2.a — dispatchEpicMerge unit coverage.
//
// Pins per task t-3-bfbda5d8 AC + t-20/t-21 fix sweep:
//   - Function exported + Zod-validated input/output.
//   - LOCAL route invokes performEpicMerge (via invokeLocal hook) and
//     returns its result mapped to DispatchEpicMergeResult shape.
//   - REMOTE route emits dispatch message + returns ack/error correctly.
//   - Failure surfaces atmux flag add with epicId + target cage +
//     stderrTail in body — ONLY on dispatch failure, NOT cage-not-found.
//   - cage-not-found path → quiet skipped-not-mine (no flag) per
//     ADR-232 §D2.a + §D3 fallback semantics (fixed in c477954 review
//     iteration: pre-fix flag-spammed on every event).
//   - §D2.a local-cage-skip guard: cage.name === localTeamName →
//     skipped-not-mine with reason "local-cage-already-owns".
//   - §D2.a anti-pattern guard: targetCage matching /^e-\d+-[0-9a-f]+$/
//     refused as caller bug (epicId-as-cage-name conflation).

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

  test("LOCAL path without invokeLocal returns skipped-not-mine (wire-up gap, no flag)", async () => {
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
    expect(r.state).toBe("skipped-not-mine");
    if (r.state === "skipped-not-mine") {
      expect(r.reason).toContain("local invoker not wired");
    }
    // Wire-up gap is NOT a flag-add condition — quiet skipped-not-mine.
    expect(flag.calls).toEqual([]);
  });
});

// ---------- REMOTE route ----------

describe("dispatchEpicMerge — REMOTE route", () => {
  test("ok=true → skipped-not-mine with cage name in reason", async () => {
    const captured: { epicId?: string; cage?: CageInfo } = {};
    const dispatchRemote = async (
      epicId: string,
      cage: CageInfo,
    ): Promise<RemoteAckResult> => {
      captured.epicId = epicId;
      captured.cage = cage;
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

    expect(captured.epicId).toBe("e-60e16169");
    expect(captured.cage).toEqual(REMOTE_CAGE);
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
    const captured: { cage?: CageInfo } = {};
    const dispatchRemote = async (
      _e: string,
      cage: CageInfo,
    ): Promise<RemoteAckResult> => {
      captured.cage = cage;
      return { ok: true };
    };
    const r = await dispatchEpicMerge(
      { epicId: "e-60e16169", targetCage: "other-cage" },
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
    expect(captured.cage?.name).toBe("other-cage");
    expect(captured.cage?.root).toBe("");
  });
});

// ---------- ADR-232 §D2.a — cage-not-found (quiet skipped-not-mine, NO flag) ----------

describe("dispatchEpicMerge — cage-not-found (§D2.a + §D3 fallback)", () => {
  test("resolveCage returns null → quiet skipped-not-mine (NO flag-add)", async () => {
    const flag = captureFlagAdd();
    const r = await dispatchEpicMerge(
      { epicId: "e-unknown" },
      {
        resolveCage: async () => null,
        flagAdd: flag.hook,
      },
    );
    expect(r.state).toBe("skipped-not-mine");
    if (r.state === "skipped-not-mine") {
      expect(r.reason).toContain("cage not found for epic e-unknown");
      expect(r.reason).toContain("resolveCage returned null");
    }
    // REGRESSION GATE — pre-c477954-fix flag-spammed here on every event;
    // the fix swaps to quiet skipped-not-mine + zero flag-add calls.
    expect(flag.calls).toEqual([]);
  });

  test("default resolveCage (unwired) → quiet skipped-not-mine on every event", async () => {
    // This is the c477954-fix regression scenario: a wire-up that
    // passes no resolveCage at all. The dispatcher must NOT raise a
    // flag on each event — that was the reviewer's REJECT condition.
    const flag = captureFlagAdd();
    const r = await dispatchEpicMerge(
      { epicId: "e-anything" },
      { flagAdd: flag.hook },
    );
    expect(r.state).toBe("skipped-not-mine");
    expect(flag.calls).toEqual([]);
  });
});

// ---------- ADR-232 §D2.a — local-cage-skip guard (parent → child only) ----------

describe("dispatchEpicMerge — §D2.a local-cage-skip guard", () => {
  test("resolved cage.name === localTeamName → skipped-not-mine with local-cage-already-owns", async () => {
    const invokeLocal = async (): Promise<PerformEpicMergeResult> => {
      throw new Error("invokeLocal should NEVER fire when local-cage-skip guard is active");
    };
    const dispatchRemote = async (): Promise<RemoteAckResult> => {
      throw new Error("dispatchRemote should NEVER fire when local-cage-skip guard is active");
    };
    const r = await dispatchEpicMerge(
      { epicId: "e-60e16169" },
      {
        localTeamName: "e-60e16169",
        resolveCage: async () => ({
          name: "e-60e16169",
          root: "/some/path",
          parentBase: "atmux-geoyws",
        }),
        invokeLocal,
        dispatchRemote,
      },
    );
    expect(r.state).toBe("skipped-not-mine");
    if (r.state === "skipped-not-mine") {
      expect(r.reason).toContain("local-cage-already-owns");
      expect(r.reason).toContain("e-60e16169");
      expect(r.reason).toContain("ADR-232 §D2.a");
    }
  });

  test("local-skip via explicit targetCage that matches localTeamName", async () => {
    const r = await dispatchEpicMerge(
      { epicId: "e-anything", targetCage: "atmux" },
      {
        localTeamName: "atmux",
        invokeLocal: async () => {
          throw new Error("invokeLocal should not fire on local-skip");
        },
        dispatchRemote: async () => {
          throw new Error("dispatchRemote should not fire on local-skip");
        },
      },
    );
    expect(r.state).toBe("skipped-not-mine");
    if (r.state === "skipped-not-mine") {
      expect(r.reason).toContain("local-cage-already-owns");
    }
  });

  test("local-skip guard does NOT fire when localTeamName is undefined", async () => {
    // No localTeamName → guard inert, normal routing applies.
    const captured: { reached?: boolean } = {};
    const r = await dispatchEpicMerge(
      { epicId: "e-x" },
      {
        // localTeamName: undefined
        resolveCage: async () => REMOTE_CAGE,
        isLocalCage: () => false,
        dispatchRemote: async () => {
          captured.reached = true;
          return { ok: true };
        },
      },
    );
    expect(captured.reached).toBe(true);
    expect(r.state).toBe("skipped-not-mine");
  });

  test("local-skip is name-based, NOT path-based (resilient to worktree moves)", async () => {
    // CageInfo's `root` field is irrelevant to the local-skip guard;
    // only `name` matters. This pins the §D2.a name-based comparison.
    const r = await dispatchEpicMerge(
      { epicId: "e-x" },
      {
        localTeamName: "my-team",
        resolveCage: async () => ({
          name: "my-team",
          root: "/some/totally/unrelated/path",
          parentBase: "main",
        }),
      },
    );
    expect(r.state).toBe("skipped-not-mine");
    if (r.state === "skipped-not-mine") {
      expect(r.reason).toContain("local-cage-already-owns");
    }
  });
});

// ---------- ADR-232 §D2.a — anti-pattern guard (epicId-as-cage-name) ----------

describe("dispatchEpicMerge — §D2.a anti-pattern guard", () => {
  test("targetCage matching epicId shape /^e-\\d+-[0-9a-f]+$/ is refused with explainer", async () => {
    const r = await dispatchEpicMerge(
      { epicId: "e-1-118d16a9", targetCage: "e-2-deadbeef" },
      {
        // even with everything wired, the guard fires first at step 0
        resolveCage: async () => {
          throw new Error("resolveCage should not fire on anti-pattern guard");
        },
        invokeLocal: async () => {
          throw new Error("invokeLocal should not fire on anti-pattern guard");
        },
        dispatchRemote: async () => {
          throw new Error("dispatchRemote should not fire on anti-pattern guard");
        },
      },
    );
    expect(r.state).toBe("gate-held");
    if (r.state === "gate-held") {
      expect(r.reason).toContain("targetCage");
      expect(r.reason).toContain("looks like an epic id");
      expect(r.reason).toContain("ADR-232 §D2.a");
      expect(r.reason).toContain("e-2-deadbeef");
    }
  });

  test("non-epicId-shaped targetCage passes the guard (real cage name)", async () => {
    // "atmux" should pass — only the digit-counter epicId shape
    // /^e-\d+-[0-9a-f]+$/ trips the guard.
    let dispatched = false;
    await dispatchEpicMerge(
      { epicId: "e-1-118d16a9", targetCage: "atmux" },
      {
        dispatchRemote: async () => {
          dispatched = true;
          return { ok: true };
        },
      },
    );
    expect(dispatched).toBe(true);
  });

  test("targetCage 'e-60e16169' (8-hex tail, no counter prefix) — passes guard", async () => {
    // Per ADR-090 §spawn-epic step 7, epic-team cage names default to
    // `e-<hash>` shape (8-char hex) — NOT the `e-<counter>-<hash>`
    // shape minted by addEpic. The guard must not false-positive on
    // legitimate cage names.
    let dispatched = false;
    await dispatchEpicMerge(
      { epicId: "e-1-118d16a9", targetCage: "e-60e16169" },
      {
        dispatchRemote: async () => {
          dispatched = true;
          return { ok: true };
        },
      },
    );
    expect(dispatched).toBe(true);
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
        // Empty epicId is TS-valid (string) but schema-invalid
        // (`.min(1)` refine) — Zod rejects at runtime.
        { epicId: "" },
        { flagAdd: flag.hook, dispatchRemote },
      ),
    ).rejects.toThrow();
    expect(flag.calls).toEqual([]);
  });
});

// ---------- Default impls (via spawn injection) ----------

describe("dispatchEpicMerge — default dispatchRemote (Bun subprocess per §D2.b path A)", () => {
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
  test("default resolveCage returns null → quiet skipped-not-mine (no flag)", async () => {
    // No resolveCage override, no targetCage → default returns null.
    // Per §D2.a fix, cage-not-found is QUIET — no flag-add spam.
    const flag = captureFlagAdd();
    const r = await dispatchEpicMerge({ epicId: "e-unknown" }, { flagAdd: flag.hook });
    expect(r.state).toBe("skipped-not-mine");
    if (r.state === "skipped-not-mine") {
      expect(r.reason).toContain("cage not found");
    }
    expect(flag.calls).toEqual([]);
  });

  test("default isLocalCage uses localTeamName name-comparison", async () => {
    const r = await dispatchEpicMerge(
      { epicId: "e-x" },
      {
        localTeamName: "my-team",
        resolveCage: async () => ({
          name: "my-team",
          root: "/whatever",
          parentBase: "main",
        }),
        invokeLocal: async () => {
          throw new Error("should hit local-skip guard before invokeLocal");
        },
      },
    );
    // local-skip guard returns skipped-not-mine
    expect(r.state).toBe("skipped-not-mine");
    if (r.state === "skipped-not-mine") {
      expect(r.reason).toContain("local-cage-already-owns");
    }
  });

  test("default isLocalCage with no localTeamName → always returns false (every cage REMOTE)", async () => {
    const captured: { reached?: boolean } = {};
    const r = await dispatchEpicMerge(
      { epicId: "e-x" },
      {
        // localTeamName: undefined → makeDefaultIsLocalCage returns always-false
        resolveCage: async () => ({
          name: "anycage",
          root: "/path",
          parentBase: "main",
        }),
        dispatchRemote: async () => {
          captured.reached = true;
          return { ok: true };
        },
      },
    );
    expect(captured.reached).toBe(true);
    expect(r.state).toBe("skipped-not-mine");
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
