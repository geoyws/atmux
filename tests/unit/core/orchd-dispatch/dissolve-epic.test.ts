// Unit tests for src/core/orchd-dispatch/dissolve-epic.ts — ADR-232
// §D1 cross-cage dissolve-epic dispatcher.
//
// Coverage:
//   - LOCAL success → state=dissolved.
//   - LOCAL refusal (ConfigError from performDissolveEpic) →
//     state=gate-held with operator-actionable reason.
//   - LOCAL non-ConfigError throw → re-propagates (withIdempotency
//     retry surface).
//   - REMOTE route (cage != localCageName, in roster) → state=
//     skipped-not-mine (deferred per ADR-232 §D2).
//   - Cage-not-found (targetCage absent from roster AND != local) →
//     flag raised p1 + state=skipped-not-mine.
//   - Roster unset + localCageName unset → treats as local (driver-
//     CLI path).
//   - callerScope override default to "driver" passed into perform.
//   - Zod input validation: missing epicId → ZodError throw.
//   - targetCage defaults to epicId when omitted.
//   - performDissolveEpic invoked with skipChecks/forcePrune false
//     (dispatcher never bypasses gates).

import { describe, expect, test } from "bun:test";
import { ConfigError } from "../../../../src/errors.ts";
import {
  dispatchDissolveEpic,
  DispatchDissolveEpicInputSchema,
  type DispatchDissolveEpicDeps,
  type FlagSeverity,
} from "../../../../src/core/orchd-dispatch/dissolve-epic.ts";

// ---------- Test helpers ----------

interface PerformCall {
  epicId: string;
  skipChecks: boolean;
  forcePrune: boolean;
  callerScope?: "driver" | "member";
}

interface FlagCall {
  severity: FlagSeverity;
  body: string;
}

function recordingFlag(): {
  raiseFlag: (s: FlagSeverity, b: string) => Promise<void>;
  calls: FlagCall[];
} {
  const calls: FlagCall[] = [];
  const raiseFlag = async (severity: FlagSeverity, body: string): Promise<void> => {
    calls.push({ severity, body });
  };
  return { raiseFlag, calls };
}

function recordingPerform(behavior: "ok" | "config-error" | "other-error"): {
  perform: NonNullable<DispatchDissolveEpicDeps["perform"]>;
  calls: PerformCall[];
} {
  const calls: PerformCall[] = [];
  const perform: NonNullable<DispatchDissolveEpicDeps["perform"]> = async (input, opts) => {
    const scope = opts?.callerScope?.();
    const call: PerformCall = {
      epicId: input.epicId,
      skipChecks: input.skipChecks,
      forcePrune: input.forcePrune,
    };
    if (scope !== undefined) call.callerScope = scope;
    calls.push(call);
    if (behavior === "config-error") {
      throw new ConfigError({
        what: "dissolve-epic: refused — epic-team has 2 open tasks",
        hint: "finish or wontfix the open tasks",
      });
    }
    if (behavior === "other-error") {
      throw new Error("ENOMEM: out of memory");
    }
    return 0;
  };
  return { perform, calls };
}

// ---------- Zod input ----------

describe("DispatchDissolveEpicInputSchema", () => {
  test("epicId required", () => {
    expect(() => DispatchDissolveEpicInputSchema.parse({})).toThrow();
    expect(() => DispatchDissolveEpicInputSchema.parse({ epicId: "" })).toThrow();
  });

  test("targetCage optional", () => {
    const r = DispatchDissolveEpicInputSchema.parse({ epicId: "e-1" });
    expect(r.epicId).toBe("e-1");
    expect(r.targetCage).toBeUndefined();
  });
});

// ---------- LOCAL route ----------

describe("dispatchDissolveEpic — LOCAL route", () => {
  test("success → state=dissolved + perform called with driver scope + ungated flags", async () => {
    const { perform, calls } = recordingPerform("ok");
    const r = await dispatchDissolveEpic(
      { epicId: "e-42" },
      { perform, localCageName: "e-42" },
    );
    expect(r).toEqual({ state: "dissolved" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      epicId: "e-42",
      skipChecks: false,
      forcePrune: false,
      callerScope: "driver",
    });
  });

  test("ConfigError refusal → state=gate-held with operator-actionable reason", async () => {
    const { perform } = recordingPerform("config-error");
    const r = await dispatchDissolveEpic(
      { epicId: "e-blocked" },
      { perform, localCageName: "e-blocked" },
    );
    expect(r.state).toBe("gate-held");
    if (r.state !== "gate-held") throw new Error("narrow failed");
    expect(r.reason).toContain("2 open tasks");
    expect(r.reason).toContain("finish or wontfix");
  });

  test("non-ConfigError throw → re-propagates (retry surface)", async () => {
    const { perform } = recordingPerform("other-error");
    await expect(
      dispatchDissolveEpic({ epicId: "e-oom" }, { perform, localCageName: "e-oom" }),
    ).rejects.toThrow(/ENOMEM/);
  });

  test("localCageName + listCages both unset → treats as local (driver-CLI path)", async () => {
    const { perform, calls } = recordingPerform("ok");
    const r = await dispatchDissolveEpic({ epicId: "e-cli" }, { perform });
    expect(r).toEqual({ state: "dissolved" });
    expect(calls).toHaveLength(1);
  });
});

// ---------- REMOTE route ----------

describe("dispatchDissolveEpic — REMOTE route (v1 local-only)", () => {
  test("cage in roster but not local → state=skipped-not-mine (deferred per ADR-232 §D2)", async () => {
    const { perform, calls } = recordingPerform("ok");
    const { raiseFlag, calls: flags } = recordingFlag();
    const r = await dispatchDissolveEpic(
      { epicId: "e-remote", targetCage: "other-cage" },
      {
        perform,
        raiseFlag,
        localCageName: "this-cage",
        listCages: async () => ["this-cage", "other-cage"],
      },
    );
    expect(r.state).toBe("skipped-not-mine");
    if (r.state !== "skipped-not-mine") throw new Error("narrow failed");
    expect(r.reason).toContain("REMOTE transport deferred");
    expect(calls).toHaveLength(0); // perform NOT called for remote
    expect(flags).toHaveLength(0); // no flag for in-roster remote
  });
});

// ---------- Cage-not-found ----------

describe("dispatchDissolveEpic — cage-not-found", () => {
  test("targetCage absent from roster AND not local → p1 flag raised + state=skipped-not-mine", async () => {
    const { perform, calls } = recordingPerform("ok");
    const { raiseFlag, calls: flags } = recordingFlag();
    const r = await dispatchDissolveEpic(
      { epicId: "e-ghost", targetCage: "nowhere-cage" },
      {
        perform,
        raiseFlag,
        localCageName: "this-cage",
        listCages: async () => ["this-cage", "other-cage"],
      },
    );
    expect(r.state).toBe("skipped-not-mine");
    expect(calls).toHaveLength(0); // perform NOT called
    expect(flags).toHaveLength(1);
    expect(flags[0]?.severity).toBe("p1");
    expect(flags[0]?.body).toContain("nowhere-cage");
    expect(flags[0]?.body).toContain("e-ghost");
  });

  test("targetCage missing from roster BUT equals localCageName → LOCAL still fires", async () => {
    const { perform, calls } = recordingPerform("ok");
    const { raiseFlag, calls: flags } = recordingFlag();
    const r = await dispatchDissolveEpic(
      { epicId: "e-1", targetCage: "this-cage" },
      {
        perform,
        raiseFlag,
        localCageName: "this-cage",
        // Roster doesn't include this-cage; local-cage override wins.
        listCages: async () => ["other-cage"],
      },
    );
    expect(r).toEqual({ state: "dissolved" });
    expect(calls).toHaveLength(1);
    expect(flags).toHaveLength(0);
  });
});

// ---------- targetCage default ----------

describe("dispatchDissolveEpic — targetCage default", () => {
  test("omitted targetCage defaults to epicId (ADR-090 §spawn-epic step 7)", async () => {
    const { perform, calls } = recordingPerform("ok");
    // epicId equals localCageName → LOCAL fires; confirms targetCage
    // resolved to epicId rather than defaulting to undefined.
    const r = await dispatchDissolveEpic(
      { epicId: "e-77" },
      {
        perform,
        localCageName: "e-77",
        listCages: async () => ["e-77"],
      },
    );
    expect(r).toEqual({ state: "dissolved" });
    expect(calls).toHaveLength(1);
  });
});
