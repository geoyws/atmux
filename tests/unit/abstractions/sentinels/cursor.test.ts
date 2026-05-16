// Unit tests for src/abstractions/sentinels/cursor.ts (ADR-132 T3 /
// t-e96d286a).
//
// Coverage targets (per CLAUDE.md testing discipline §"unit tests
// alongside code to 100% coverage" — narrowed denominator excludes
// the SYSTEM_PROMPT constant + the EMPTY_HISTORY const since they're
// data, not branches):
//
//   - Constructor — name literal `"cursor"`, default model
//     `composer-2-fast`, override model `composer-2`.
//   - observe() — pass-through to injected observeFn (referential
//     equality + arg threading).
//   - decide() — happy path: invokes runCursorAgent with `--print
//     --output-format json --model <model> --force <prompt>`; parses
//     envelope; parses NudgeAction[]; re-attaches observation to
//     escalate-to-claude-lead.
//   - decide() — fail-loud paths: spawn-fn throw → escalate;
//     unparseable envelope → escalate; envelope schema fail →
//     escalate; cursor reports is_error → escalate; result not JSON
//     → empty array (no-op tick); NudgeAction shape invalid →
//     escalate.
//   - decide() — multi-line stream-json envelope: takes LAST line.
//   - apply() — enter-push, claim-next, rotate variants. sendKeys
//     missing → success=false with diagnostic. escalate-to-claude-
//     lead → throws.
//   - shouldEscalateToClaudeLead() — E6 mandatory floor (last2hr=0
//     → true regardless of other state); empty-history fallback;
//     historyFn injection composes temporal gates.

import { describe, expect, test } from "bun:test";
import {
  CURSOR_SYSTEM_PROMPT,
  CursorEnvelopeSchema,
  CursorSentinel,
} from "../../../../src/abstractions/sentinels/cursor.ts";
import type {
  Sentinel,
  NudgeAction,
  Observation,
} from "../../../../src/abstractions/sentinel.ts";
import type { ObservationHistory } from "../../../../src/core/sentinel-escalation.ts";
import type { PaneClassification } from "../../../../src/core/pane-state.ts";

// ---------- Helpers ----------

function paneCls(state: PaneClassification["state"] = "READY"): PaneClassification {
  return { state, evidence: "", capturedAt: 0 };
}

function fixtureObservation(opts: {
  team?: string;
  last2hrCommits?: number;
  wedgedCount?: number;
  enterPushable?: boolean;
} = {}): Observation {
  const enterPushable = opts.enterPushable ?? true;
  return {
    team: opts.team ?? "atmux",
    members: [
      {
        name: "fe-1",
        paneState: paneCls("READY"),
        ctxTokens: 5_000,
        lastEnterPushable: enterPushable,
        queuedComposerText: enterPushable ? "atmux claim --next --as fe-1" : null,
      },
    ],
    kanbanDelta: {
      newClaims: [],
      completedSinceLastTick: [],
      wedgedClaims: Array.from({ length: opts.wedgedCount ?? 0 }, (_, i) => ({
        taskId: `t-w-${i}`,
        class: "ghost-owner",
        wedgedMin: 30,
      })),
    },
    commitCadence: {
      sinceLastTick: opts.last2hrCommits === 0 ? 0 : 2,
      last30min: opts.last2hrCommits === 0 ? 0 : 4,
      last2hr: opts.last2hrCommits ?? 10,
    },
    lastTickAt: 1_700_000_000_000,
  };
}

function envelope(opts: {
  result?: string;
  isError?: boolean;
  subtype?: "success" | "error";
  inputTokens?: number;
  outputTokens?: number;
}): string {
  return JSON.stringify({
    type: "result",
    subtype: opts.subtype ?? "success",
    is_error: opts.isError ?? false,
    duration_ms: 1500,
    result: opts.result ?? "[]",
    usage: {
      inputTokens: opts.inputTokens ?? 100,
      outputTokens: opts.outputTokens ?? 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  });
}

const okEnvelope = (actions: NudgeAction[] = []): string =>
  envelope({ result: JSON.stringify(actions) });

// ---------- Constructor ----------

describe("CursorSentinel — constructor", () => {
  test("name literal === 'cursor'", () => {
    const inst = new CursorSentinel({
      observeFn: async () => fixtureObservation(),
      runCursorAgent: async () => okEnvelope(),
    });
    expect(inst.name).toBe("cursor");
  });

  test("default model is 'composer-2-fast'", async () => {
    const seenArgs: string[][] = [];
    const inst = new CursorSentinel({
      observeFn: async () => fixtureObservation(),
      runCursorAgent: async (args) => {
        seenArgs.push(args);
        return okEnvelope();
      },
    });
    await inst.decide(fixtureObservation());
    const args = seenArgs[0];
    expect(args).toBeDefined();
    if (args === undefined) throw new Error("unreachable");
    const idx = args.indexOf("--model");
    expect(args[idx + 1]).toBe("composer-2-fast");
  });

  test("override model is honored", async () => {
    const seenArgs: string[][] = [];
    const inst = new CursorSentinel({
      observeFn: async () => fixtureObservation(),
      runCursorAgent: async (args) => {
        seenArgs.push(args);
        return okEnvelope();
      },
      model: "composer-2",
    });
    await inst.decide(fixtureObservation());
    const args = seenArgs[0];
    if (args === undefined) throw new Error("unreachable");
    expect(args[args.indexOf("--model") + 1]).toBe("composer-2");
  });

  test("instance satisfies Sentinel interface", () => {
    const inst: Sentinel = new CursorSentinel({
      observeFn: async () => fixtureObservation(),
      runCursorAgent: async () => okEnvelope(),
    });
    expect(typeof inst.observe).toBe("function");
    expect(typeof inst.decide).toBe("function");
    expect(typeof inst.apply).toBe("function");
    expect(typeof inst.shouldEscalateToClaudeLead).toBe("function");
  });
});

// ---------- observe() ----------

describe("CursorSentinel — observe()", () => {
  test("delegates to injected observeFn verbatim", async () => {
    const obs = fixtureObservation({ team: "delegated" });
    const seenTeams: string[] = [];
    const inst = new CursorSentinel({
      observeFn: async (team) => {
        seenTeams.push(team);
        return obs;
      },
      runCursorAgent: async () => okEnvelope(),
    });
    const out = await inst.observe("atmux");
    expect(seenTeams).toEqual(["atmux"]);
    expect(out).toBe(obs); // referential equality — pass-through
  });
});

// ---------- decide() — happy path ----------

describe("CursorSentinel — decide() happy path", () => {
  test("emits canonical CLI args (--print --output-format json --model --force <prompt>)", async () => {
    const seenArgs: string[][] = [];
    const inst = new CursorSentinel({
      observeFn: async () => fixtureObservation(),
      runCursorAgent: async (args) => {
        seenArgs.push(args);
        return okEnvelope();
      },
    });
    await inst.decide(fixtureObservation());
    const args = seenArgs[0];
    if (args === undefined) throw new Error("unreachable");
    expect(args).toContain("--print");
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("--output-format") + 1]).toBe("json");
    expect(args).toContain("--model");
    expect(args).toContain("--force");
    // Last arg is the prompt — must contain the system prompt + the
    // observation JSON.
    const prompt = args[args.length - 1];
    expect(prompt).toBeDefined();
    if (prompt === undefined) throw new Error("unreachable");
    expect(prompt).toContain(CURSOR_SYSTEM_PROMPT);
    expect(prompt).toContain('"team":');
  });

  test("parses NudgeAction[] from envelope.result", async () => {
    const inst = new CursorSentinel({
      observeFn: async () => fixtureObservation(),
      runCursorAgent: async () =>
        envelope({
          result: JSON.stringify([
            { kind: "enter-push", member: "fe-1", reason: "queued" },
            { kind: "claim-next", member: "be-1", reason: "idle" },
          ]),
        }),
    });
    const out = await inst.decide(fixtureObservation());
    expect(out).toHaveLength(2);
    expect(out[0]?.kind).toBe("enter-push");
    expect(out[1]?.kind).toBe("claim-next");
  });

  test("re-attaches observation to escalate-to-claude-lead emissions", async () => {
    const obs = fixtureObservation();
    const inst = new CursorSentinel({
      observeFn: async () => obs,
      runCursorAgent: async () =>
        envelope({
          result: JSON.stringify([
            { kind: "escalate-to-claude-lead", reason: "wedged" },
          ]),
        }),
    });
    const out = await inst.decide(obs);
    expect(out).toHaveLength(1);
    const action = out[0];
    if (action === undefined || action.kind !== "escalate-to-claude-lead") {
      throw new Error("expected escalate-to-claude-lead");
    }
    expect(action.observation).toBe(obs);
    expect(action.reason).toBe("wedged");
  });

  test("multi-line stream-json envelope — takes LAST { line", async () => {
    const inst = new CursorSentinel({
      observeFn: async () => fixtureObservation(),
      runCursorAgent: async () =>
        [
          '{"type":"meta","msg":"thinking..."}',
          '{"type":"meta","msg":"step 1"}',
          okEnvelope([{ kind: "enter-push", member: "fe-1", reason: "queued" }]),
        ].join("\n"),
    });
    const out = await inst.decide(fixtureObservation());
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("enter-push");
  });
});

// ---------- decide() — fail-loud paths ----------

describe("CursorSentinel — decide() fail-loud paths", () => {
  test("runCursorAgent throw → escalate-to-claude-lead with cause", async () => {
    const obs = fixtureObservation();
    const inst = new CursorSentinel({
      observeFn: async () => obs,
      runCursorAgent: async () => {
        throw new Error("ENOENT cursor-agent");
      },
    });
    const out = await inst.decide(obs);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("escalate-to-claude-lead");
    if (out[0]?.kind === "escalate-to-claude-lead") {
      expect(out[0].reason).toContain("ENOENT cursor-agent");
      expect(out[0].observation).toBe(obs);
    }
  });

  test("runCursorAgent rejection (non-Error) → escalate with String(cause)", async () => {
    const obs = fixtureObservation();
    const inst = new CursorSentinel({
      observeFn: async () => obs,
      runCursorAgent: async () => {
        throw "scalar-rejection";
      },
    });
    const out = await inst.decide(obs);
    expect(out).toHaveLength(1);
    if (out[0]?.kind === "escalate-to-claude-lead") {
      expect(out[0].reason).toContain("scalar-rejection");
    }
  });

  test("unparseable envelope → escalate", async () => {
    const inst = new CursorSentinel({
      observeFn: async () => fixtureObservation(),
      runCursorAgent: async () => "not-json-at-all",
    });
    const out = await inst.decide(fixtureObservation());
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("escalate-to-claude-lead");
    if (out[0]?.kind === "escalate-to-claude-lead") {
      expect(out[0].reason).toContain("unparseable");
    }
  });

  test("envelope failing schema → escalate", async () => {
    const inst = new CursorSentinel({
      observeFn: async () => fixtureObservation(),
      runCursorAgent: async () => '{"foo":"bar"}',
    });
    const out = await inst.decide(fixtureObservation());
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("escalate-to-claude-lead");
    if (out[0]?.kind === "escalate-to-claude-lead") {
      expect(out[0].reason).toContain("failed schema");
    }
  });

  test("cursor reports is_error → escalate with snippet", async () => {
    const inst = new CursorSentinel({
      observeFn: async () => fixtureObservation(),
      runCursorAgent: async () =>
        envelope({ result: "rate-limit hit", isError: true, subtype: "error" }),
    });
    const out = await inst.decide(fixtureObservation());
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("escalate-to-claude-lead");
    if (out[0]?.kind === "escalate-to-claude-lead") {
      expect(out[0].reason).toContain("rate-limit hit");
    }
  });

  test("envelope.subtype='error' without is_error flag → still escalate", async () => {
    const inst = new CursorSentinel({
      observeFn: async () => fixtureObservation(),
      runCursorAgent: async () =>
        envelope({ result: "soft fail", isError: false, subtype: "error" }),
    });
    const out = await inst.decide(fixtureObservation());
    expect(out[0]?.kind).toBe("escalate-to-claude-lead");
  });

  test("result not JSON → empty array (no-op tick, defer to next tick)", async () => {
    const inst = new CursorSentinel({
      observeFn: async () => fixtureObservation(),
      runCursorAgent: async () =>
        envelope({ result: "I cannot help with that." }),
    });
    const out = await inst.decide(fixtureObservation());
    expect(out).toHaveLength(0);
  });

  test("NudgeAction shape invalid → escalate with field hint", async () => {
    const inst = new CursorSentinel({
      observeFn: async () => fixtureObservation(),
      runCursorAgent: async () =>
        envelope({
          result: JSON.stringify([
            { kind: "unknown-kind", member: "fe-1" },
          ]),
        }),
    });
    const out = await inst.decide(fixtureObservation());
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("escalate-to-claude-lead");
    if (out[0]?.kind === "escalate-to-claude-lead") {
      expect(out[0].reason).toContain("invalid NudgeAction shape");
    }
  });

  test("NudgeAction missing required field → escalate", async () => {
    const inst = new CursorSentinel({
      observeFn: async () => fixtureObservation(),
      runCursorAgent: async () =>
        envelope({
          result: JSON.stringify([
            { kind: "enter-push", member: "fe-1" }, // missing reason
          ]),
        }),
    });
    const out = await inst.decide(fixtureObservation());
    expect(out[0]?.kind).toBe("escalate-to-claude-lead");
  });
});

// ---------- apply() ----------

describe("CursorSentinel — apply()", () => {
  test("escalate-to-claude-lead → throws (unreachable per dispatcher contract)", async () => {
    const inst = new CursorSentinel({
      observeFn: async () => fixtureObservation(),
      runCursorAgent: async () => okEnvelope(),
    });
    const obs = fixtureObservation();
    await expect(
      inst.apply({
        kind: "escalate-to-claude-lead",
        observation: obs,
        reason: "x",
      }),
    ).rejects.toThrow(/unreachable/);
  });

  test("enter-push: sends Enter to member window", async () => {
    const calls: { window: string; keys: string }[] = [];
    const inst = new CursorSentinel({
      observeFn: async () => fixtureObservation(),
      runCursorAgent: async () => okEnvelope(),
      sendKeys: async (window, keys) => {
        calls.push({ window, keys });
        return { success: true };
      },
    });
    const result = await inst.apply({
      kind: "enter-push",
      member: "fe-1",
      reason: "queued",
    });
    expect(result.success).toBe(true);
    expect(calls).toEqual([{ window: "fe-1", keys: "Enter" }]);
    expect(result.evidence).toContain("enter-push fe-1");
    expect(result.evidence).toContain("queued");
  });

  test("enter-push: send-keys returning success=false propagates", async () => {
    const inst = new CursorSentinel({
      observeFn: async () => fixtureObservation(),
      runCursorAgent: async () => okEnvelope(),
      sendKeys: async () => ({ success: false }),
    });
    const result = await inst.apply({
      kind: "enter-push",
      member: "fe-1",
      reason: "queued",
    });
    expect(result.success).toBe(false);
    expect(result.evidence).toContain("send-keys returned success=false");
  });

  test("claim-next: sends canonical claim cmd", async () => {
    const calls: { window: string; keys: string }[] = [];
    const inst = new CursorSentinel({
      observeFn: async () => fixtureObservation(),
      runCursorAgent: async () => okEnvelope(),
      sendKeys: async (window, keys) => {
        calls.push({ window, keys });
        return { success: true };
      },
    });
    const result = await inst.apply({
      kind: "claim-next",
      member: "be-1",
      reason: "idle",
    });
    expect(result.success).toBe(true);
    expect(calls).toEqual([
      { window: "be-1", keys: "atmux claim --next --as be-1" },
    ]);
    expect(result.evidence).toContain("claim-next be-1");
    expect(result.evidence).toContain("atmux claim --next --as be-1");
  });

  test("claim-next: send-keys failure propagates", async () => {
    const inst = new CursorSentinel({
      observeFn: async () => fixtureObservation(),
      runCursorAgent: async () => okEnvelope(),
      sendKeys: async () => ({ success: false }),
    });
    const result = await inst.apply({
      kind: "claim-next",
      member: "be-1",
      reason: "idle",
    });
    expect(result.success).toBe(false);
  });

  test("rotate: records intent, success=true (dispatcher fires actual atmux rotate)", async () => {
    const calls: { window: string; keys: string }[] = [];
    const inst = new CursorSentinel({
      observeFn: async () => fixtureObservation(),
      runCursorAgent: async () => okEnvelope(),
      sendKeys: async (window, keys) => {
        calls.push({ window, keys });
        return { success: true };
      },
    });
    const result = await inst.apply({
      kind: "rotate",
      member: "fe-1",
      reason: "60min uptime",
    });
    expect(result.success).toBe(true);
    expect(result.evidence).toContain("rotate intent recorded for fe-1");
    expect(result.evidence).toContain("atmux rotate fe-1");
    expect(result.evidence).toContain("60min uptime");
    // rotate is dispatcher-mediated — does NOT shell out via sendKeys.
    expect(calls).toEqual([]);
  });

  test("sendKeys missing → success=false with diagnostic evidence", async () => {
    const inst = new CursorSentinel({
      observeFn: async () => fixtureObservation(),
      runCursorAgent: async () => okEnvelope(),
    });
    const result = await inst.apply({
      kind: "enter-push",
      member: "fe-1",
      reason: "queued",
    });
    expect(result.success).toBe(false);
    expect(result.evidence).toContain("no sendKeys dep injected");
    expect(result.evidence).toContain("dispatcher wiring incomplete");
  });
});

// ---------- shouldEscalateToClaudeLead() ----------

describe("CursorSentinel — shouldEscalateToClaudeLead() (§D5 gate)", () => {
  test("E6 mandatory: last2hr=0 → true regardless of other state", () => {
    const inst = new CursorSentinel({
      observeFn: async () => fixtureObservation(),
      runCursorAgent: async () => okEnvelope(),
    });
    expect(
      inst.shouldEscalateToClaudeLead(fixtureObservation({ last2hrCommits: 0 })),
    ).toBe(true);
  });

  test("clean state: no triggers → false", () => {
    const inst = new CursorSentinel({
      observeFn: async () => fixtureObservation(),
      runCursorAgent: async () => okEnvelope(),
    });
    expect(
      inst.shouldEscalateToClaudeLead(
        fixtureObservation({ last2hrCommits: 10, enterPushable: false }),
      ),
    ).toBe(false);
  });

  test("E2 P0 hygiene wedge ≥240min → escalate", () => {
    const inst = new CursorSentinel({
      observeFn: async () => fixtureObservation(),
      runCursorAgent: async () => okEnvelope(),
    });
    const obs = fixtureObservation({ last2hrCommits: 10, enterPushable: false });
    obs.kanbanDelta.wedgedClaims = [
      { taskId: "t-x", class: "ghost-owner", wedgedMin: 250 },
    ];
    expect(inst.shouldEscalateToClaudeLead(obs)).toBe(true);
  });

  test("E1 wedged-after-nudge: historyFn injection drives temporal gate", () => {
    const obs = fixtureObservation({ last2hrCommits: 10, enterPushable: true });
    // Pretend an enter-push was fired 20min ago for fe-1; observation
    // still shows queued text + lastEnterPushable → wedged.
    const wedgedHistory: ObservationHistory = {
      enterPushedAt: { "fe-1": obs.lastTickAt - 20 * 60 * 1000 },
      lowConfidenceStreak: 0,
      inboxEntries: [],
      pendingGitDenials: [],
    };
    const inst = new CursorSentinel({
      observeFn: async () => obs,
      runCursorAgent: async () => okEnvelope(),
      historyFn: () => wedgedHistory,
    });
    expect(inst.shouldEscalateToClaudeLead(obs)).toBe(true);
  });

  test("empty-history fallback: temporal gates stay quiet, only E2/E6 fire", () => {
    const obs = fixtureObservation({ last2hrCommits: 10, enterPushable: true });
    const inst = new CursorSentinel({
      observeFn: async () => obs,
      runCursorAgent: async () => okEnvelope(),
      // No historyFn → defaults to EMPTY_HISTORY → E1 doesn't fire even
      // though queued text is present (no recorded enterPushedAt).
    });
    expect(inst.shouldEscalateToClaudeLead(obs)).toBe(false);
  });
});

// ---------- CursorEnvelopeSchema (exported for cockpit-tier
// dispatcher consumers + downstream test fixtures) ----------

describe("CursorEnvelopeSchema", () => {
  test("accepts canonical success envelope", () => {
    const result = CursorEnvelopeSchema.safeParse({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 1500,
      result: "[]",
      usage: { inputTokens: 100, outputTokens: 50 },
    });
    expect(result.success).toBe(true);
  });

  test("accepts envelope without optional usage", () => {
    const result = CursorEnvelopeSchema.safeParse({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "[]",
    });
    expect(result.success).toBe(true);
  });

  test("rejects envelope missing required result field", () => {
    const result = CursorEnvelopeSchema.safeParse({
      type: "result",
      subtype: "success",
      is_error: false,
    });
    expect(result.success).toBe(false);
  });

  test("rejects unknown subtype", () => {
    const result = CursorEnvelopeSchema.safeParse({
      type: "result",
      subtype: "weird",
      is_error: false,
      result: "[]",
    });
    expect(result.success).toBe(false);
  });
});
