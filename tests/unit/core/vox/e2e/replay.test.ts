// The D7 confirm-gate scenario, driven against a FAKE bridge.
//
// The live version of this runs against the real bridge and the real
// cage; what is tested here is the SCENARIO — that it asks the right five
// questions, that it fails when the gate fails, and above all that it
// cannot go green while the gate is broken. The two headline tests are
// therefore the sabotage ones: a bridge that ignores single-use, and a
// bridge that ignores argument binding. Both must come back red.

import { describe, expect, test } from "bun:test";
import type { TmuxNamespace } from "../../../../../src/abstractions/tmux.ts";
import { buildCagePlan } from "../../../../../src/core/vox/e2e/cage.ts";
import { MUTATION_FIXTURES } from "../../../../../src/core/vox/e2e/fixtures.ts";
import {
  classifyEnvelope,
  nudgeArgs,
  REPLAY_TOOL,
  type ReplayContext,
  runConfirmReplay,
} from "../../../../../src/core/vox/e2e/replay.ts";
import type { ExecuteToolOutput, ToolBridge } from "../../../../../src/core/vox/tool-bridge.ts";

const TEMP = "/tmp/atmux-vox-e2e-replay";
const TEAM = "vox-e2e-bravo";
const PLAN = buildCagePlan({ tempRoot: TEMP, uid: 1000, fixtures: MUTATION_FIXTURES });
const receipt = (member: string): string => `${TEMP}/panes/${TEAM}/${member}.enters`;

/**
 * A confirm store + nudge runner in miniature, with each D7 property
 * INDIVIDUALLY defeatable.
 *
 * Built this way on purpose: a fake that is simply correct proves the
 * scenario passes when everything works, which is the easy half. Being
 * able to break exactly one property at a time is what proves the
 * scenario would notice.
 */
function fakeBridge(opts: {
  /** Ignore single-use — a spent token keeps redeeming. */
  allowReplay?: boolean;
  /** Ignore the argument binding — any token redeems any args. */
  ignoreBinding?: boolean;
  /** Execute a gated call even with NO token (the gate fails open). */
  failOpen?: boolean;
  /** Never issue a token at all. */
  noToken?: boolean;
  /** Stop issuing fresh tokens after this many issues. */
  issueCap?: number;
  /** Refuse to ever execute for this member — an INERT pane. This is the
   *  exact condition the control exists to detect. */
  inertMember?: string;
  /** Execute, but deliver nothing to the pane — a tool that reports
   *  success while the keystroke goes nowhere (ADR-273 D5's whole
   *  premise). */
  silentlyDropKeystroke?: boolean;
  enters: Map<string, number>;
}): ToolBridge {
  const tokens = new Map<string, string>(); // token → binding
  let issued = 0;
  const bind = (args: Record<string, unknown>): string =>
    `${REPLAY_TOOL}|${String(args.member)}|${String(args.action)}`;
  const run = (member: string): void => {
    if (opts.silentlyDropKeystroke === true) return;
    opts.enters.set(member, (opts.enters.get(member) ?? 0) + 1);
  };
  return {
    executeTool: async (input): Promise<ExecuteToolOutput> => {
      const args = JSON.parse(input.argsJson) as Record<string, unknown>;
      const token = typeof args.confirm_token === "string" ? args.confirm_token : undefined;
      const member = String(args.member);
      const wanted = bind(args);
      const redeem = (): boolean => {
        if (token === undefined) return opts.failOpen === true;
        const held = tokens.get(token);
        if (held === undefined) return false;
        if (opts.allowReplay !== true) tokens.delete(token);
        return opts.ignoreBinding === true || held === wanted;
      };
      if (redeem()) {
        // An INERT pane still passes the GATE — the token was valid — and
        // then fails in the verb. That is the shape the control has to
        // catch, and it is why the refusal is placed after `redeem()`
        // rather than before it.
        if (member === opts.inertMember) {
          return {
            envelopeJson: JSON.stringify({ ok: false, tool: input.name, error: "verb_failed" }),
          };
        }
        run(member);
        return { envelopeJson: JSON.stringify({ ok: true, tool: input.name, data: "NUDGE ok" }) };
      }
      if (opts.noToken === true || (opts.issueCap !== undefined && issued >= opts.issueCap)) {
        return {
          envelopeJson: JSON.stringify({ ok: false, tool: input.name, error: "verb_failed" }),
        };
      }
      issued += 1;
      const fresh = `tok-${issued}`;
      tokens.set(fresh, wanted);
      return {
        envelopeJson: JSON.stringify({
          ok: false,
          tool: input.name,
          error: "needs_confirmation",
          token: fresh,
        }),
        needsConfirmation: { token: fresh, preview: `Confirm nudge: ${member}` },
      };
    },
    health: () => ({
      wedged: false,
      stuckTool: null,
      heldMs: null,
      queueDepth: 0,
      wedgeThresholdMs: 0,
    }),
  };
}

function ctx(bridge: ToolBridge, enters: Map<string, number>): ReplayContext {
  return {
    plan: PLAN,
    bridge,
    sessionId: "sess",
    team: TEAM,
    now: () => 0,
    sleep: async () => {},
    tmux: () => ({}) as unknown as TmuxNamespace,
    readFile: async (path) => {
      for (const [member, n] of enters) {
        if (path === receipt(member)) return "enter\n".repeat(n);
      }
      return null;
    },
  };
}

/** Ids of every failing assertion, for readable expectations. */
function failed(results: Array<{ id: string; pass: boolean }>): string[] {
  return results.filter((r) => !r.pass).map((r) => r.id);
}

describe("runConfirmReplay — the happy path", () => {
  test("all five steps pass against a bridge that honours D7", async () => {
    const enters = new Map<string, number>();
    const r = await runConfirmReplay(ctx(fakeBridge({ enters }), enters));
    expect(failed(r)).toEqual([]);
    // The control ran, so the negatives above it were not vacuous.
    expect(r.map((x) => x.id)).toContain("replay:5-control-landed");
    expect(enters.get("be-1")).toBe(1);
    expect(enters.get("be-2")).toBe(1);
  });

  test("it logs through the injected sink and is silent without one", async () => {
    const enters = new Map<string, number>();
    const lines: string[] = [];
    await runConfirmReplay({ ...ctx(fakeBridge({ enters }), enters), log: (l) => lines.push(l) });
    expect(lines.join("\n")).toContain("replay: redeeming the token");
    const enters2 = new Map<string, number>();
    await expect(
      runConfirmReplay(ctx(fakeBridge({ enters: enters2 }), enters2)),
    ).resolves.toBeArray();
  });
});

describe("runConfirmReplay — it must go RED when the gate is broken", () => {
  test("a bridge that lets a SPENT token redeem again is caught", async () => {
    const enters = new Map<string, number>();
    const r = await runConfirmReplay(ctx(fakeBridge({ allowReplay: true, enters }), enters));
    expect(failed(r)).toContain("replay:3-spent-token-refused");
    expect(failed(r)).toContain("replay:3-no-second-enter");
    expect(enters.get("be-1")).toBe(2);
  });

  test("a bridge that ignores ARGUMENT BINDING is caught", async () => {
    const enters = new Map<string, number>();
    const r = await runConfirmReplay(ctx(fakeBridge({ ignoreBinding: true, enters }), enters));
    expect(failed(r)).toContain("replay:4-args-bound");
    expect(failed(r)).toContain("replay:4-be2-untouched");
  });

  test("a gate that FAILS OPEN — running an un-tokened gated call — is caught", async () => {
    const enters = new Map<string, number>();
    const r = await runConfirmReplay(ctx(fakeBridge({ failOpen: true, enters }), enters));
    expect(failed(r)).toContain("replay:1-gate-holds");
    expect(failed(r)).toContain("replay:1-nothing-ran");
  });

  test("a bridge that never issues a token stops after step 1, saying why", async () => {
    const enters = new Map<string, number>();
    const r = await runConfirmReplay(ctx(fakeBridge({ noToken: true, enters }), enters));
    expect(failed(r)).toContain("replay:1-gate-holds");
    expect(r.map((x) => x.id)).not.toContain("replay:2-redeem-runs");
  });

  test("a refused replay that returns no fresh token is reported, not skipped", async () => {
    // The re-preview is what step 4 uses. If it stops arriving, the
    // argument-binding half of the scenario cannot run — and silence
    // there would read as a pass.
    const enters = new Map<string, number>();
    const r = await runConfirmReplay(ctx(fakeBridge({ issueCap: 1, enters }), enters));
    expect(failed(r)).toContain("replay:3-reissued");
  });

  test("a mismatch that returns no fresh token loses the CONTROL, and says so", async () => {
    const enters = new Map<string, number>();
    const r = await runConfirmReplay(ctx(fakeBridge({ issueCap: 2, enters }), enters));
    const control = r.find((x) => x.id === "replay:5-control");
    expect(control?.pass).toBe(false);
    expect(control?.detail).toContain("stand unverified");
  });

  test("an INERT control pane is caught — this is what stops the negatives being vacuous", async () => {
    // The failure mode the control exists for. `be-2` refuses everything,
    // so "be-2 was untouched" at step 4 was true for the wrong reason:
    // that pane could never have moved. Step 5 must fail rather than let
    // the scenario go green on three meaningless zeros.
    const enters = new Map<string, number>();
    const r = await runConfirmReplay(ctx(fakeBridge({ inertMember: "be-2", enters }), enters));
    expect(failed(r)).toContain("replay:5-control-runs");
    expect(failed(r)).toContain("replay:5-control-landed");
  });

  test("a redemption that passes the gate and then FAILS in the verb is caught", async () => {
    const enters = new Map<string, number>();
    const r = await runConfirmReplay(ctx(fakeBridge({ inertMember: "be-1", enters }), enters));
    expect(failed(r)).toContain("replay:2-redeem-runs");
    expect(failed(r)).toContain("replay:2-one-enter");
  });

  test("a redemption that reports success while delivering nothing is caught", async () => {
    // ADR-273 D5's premise: "I pressed Enter" is a claim. Here every
    // envelope says `ok`, and every receipt stays at zero.
    const enters = new Map<string, number>();
    const r = await runConfirmReplay(
      ctx(fakeBridge({ silentlyDropKeystroke: true, enters }), enters),
    );
    expect(failed(r)).toContain("replay:2-one-enter");
    expect(failed(r)).toContain("replay:5-control-landed");
    // …and the envelope-level assertions all PASSED, which is exactly why
    // grading a mutating scenario on envelopes would certify the claim
    // with the claim.
    expect(failed(r)).not.toContain("replay:2-redeem-runs");
  });
});

describe("runConfirmReplay — preconditions", () => {
  test("refuses a cage whose target pane keeps no receipt", async () => {
    const enters = new Map<string, number>();
    const bad: ReplayContext = {
      ...ctx(fakeBridge({ enters }), enters),
      team: "vox-e2e-nope",
    };
    const r = await runConfirmReplay(bad);
    expect(r.length).toBe(1);
    expect(r[0]?.id).toBe("replay:0-precondition");
  });

  test("refuses a cage whose target pane already shows an Enter", async () => {
    // A dirty cage would make every count downstream meaningless.
    const enters = new Map<string, number>([["be-1", 1]]);
    const r = await runConfirmReplay(ctx(fakeBridge({ enters }), enters));
    expect(r.length).toBe(1);
    expect(r[0]?.detail).toContain("already shows 1 Enter");
  });
});

describe("classifyEnvelope", () => {
  test("an ok envelope means the verb RAN", () => {
    expect(classifyEnvelope('{"ok":true}').outcome).toBe("executed");
  });

  test("needs_confirmation means it was only PREVIEWED", () => {
    expect(classifyEnvelope('{"ok":false,"error":"needs_confirmation"}').outcome).toBe("previewed");
  });

  test("any other error is neither, and names itself", () => {
    const c = classifyEnvelope('{"ok":false,"error":"readonly_mode"}');
    expect(c.outcome).toBe("other");
    expect(c.error).toBe("readonly_mode");
  });

  test("an unparseable envelope is `other`, never `executed`", () => {
    // Failing safe matters here: an envelope we cannot read must never be
    // mistaken for a successful redemption.
    expect(classifyEnvelope("not json").outcome).toBe("other");
  });

  test("an envelope with neither ok nor error reports unknown", () => {
    expect(classifyEnvelope("{}").error).toBe("unknown");
  });
});

describe("nudgeArgs", () => {
  test("spells the action out rather than leaning on the schema default", () => {
    expect(JSON.parse(nudgeArgs(TEAM, "be-1"))).toEqual({
      team: TEAM,
      member: "be-1",
      action: "submit",
    });
  });

  test("carries the token when one is offered", () => {
    expect(JSON.parse(nudgeArgs(TEAM, "be-1", "t")).confirm_token).toBe("t");
  });
});
