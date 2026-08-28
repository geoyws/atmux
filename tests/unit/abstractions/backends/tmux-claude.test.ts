// Unit tests for the tmux-claude AgentBackend (ADR-258 Phase 1).
//
// The backend is a behavior-neutral DELEGATING wrapper over the existing
// send-keys machinery. These tests inject mocked machinery (createWindow /
// bootMember / awaitReady / sendToMember / capturePane / interruptKeys /
// softStopNotify / killWindow / probeBudget) via the TmuxClaudeDeps seam —
// no live tmux server, matching the repo's dependency-injection discipline
// (send.test.ts stubs `sleep`; pane-readiness tests inject `capture`).
//
// Every assertion checks REAL behaviour: the pane-state → status / event
// mapping, the delegation call-args, the graceful-then-hard shutdown order.
// If a mapping were wrong (e.g. BUSY → idle, MODAL → working) the matching
// test fails — no shape-only / always-true assertions.

import { describe, expect, test } from "bun:test";
import type {
  AgentEvent,
  AgentSpawnOptions,
  SessionHandle,
} from "../../../../src/abstractions/agent-backend.ts";
import {
  budgetToRateLimitStatus,
  createTmuxClaudeBackend,
  GRACEFUL_SHUTDOWN_GRACE_MS,
  paneStateToEvent,
  paneStateToStatusKind,
  TMUX_CLAUDE_BACKEND_ID,
  type TmuxClaudeDeps,
} from "../../../../src/abstractions/backends/tmux-claude.ts";
import type { BudgetProbeResult } from "../../../../src/abstractions/budget-probe.ts";
import type { BootResult } from "../../../../src/core/boot-claude.ts";
import type { PaneReadinessResult } from "../../../../src/core/pane-readiness.ts";
import type { PaneState } from "../../../../src/core/pane-state.ts";
import type { SendOutcome } from "../../../../src/core/send.ts";

const NO_SLEEP = (_ms: number): Promise<void> => Promise.resolve();

// ---------- Mock-deps factory ----------

interface Recorder {
  createWindowCalls: { sessionId: string; cwd: string; spawnOpts: AgentSpawnOptions }[];
  bootCalls: { sessionId: string; paneTargetString: string; spawnOpts: AgentSpawnOptions }[];
  awaitCalls: { target: string }[];
  sendCalls: { target: string; message: string; verify: boolean | undefined }[];
  captureCalls: string[];
  interruptCalls: string[];
  softStopCalls: string[];
  killCalls: string[];
  probeCalls: string[];
  /** Records the literal ORDER of side-effecting deps calls (for shutdown
   *  ordering assertions: softStop → sleep → kill). */
  order: string[];
}

interface MockConfig {
  paneTargetString?: string;
  bootResult?: BootResult;
  readiness?: PaneReadinessResult;
  /** Sequence of pane captures returned by capturePane (cycles on the last). */
  captures?: string[];
  sendOutcome?: SendOutcome;
  probe?: BudgetProbeResult | null;
  /** Omit awaitReady from deps (spawn succeeds on boot alone). */
  noAwaitReady?: boolean;
  /** Omit probeBudget from deps. */
  noProbe?: boolean;
  /** Omit softStopNotify from deps. */
  noSoftStop?: boolean;
  /** Make capturePane throw. */
  captureThrows?: boolean;
  /** Make probeBudget throw. */
  probeThrows?: boolean;
}

function mkDeps(cfg: MockConfig = {}): { deps: TmuxClaudeDeps; rec: Recorder; sleepMs: number[] } {
  const rec: Recorder = {
    createWindowCalls: [],
    bootCalls: [],
    awaitCalls: [],
    sendCalls: [],
    captureCalls: [],
    interruptCalls: [],
    softStopCalls: [],
    killCalls: [],
    probeCalls: [],
    order: [],
  };
  const sleepMs: number[] = [];
  const paneTargetString = cfg.paneTargetString ?? "atmux-t:0";
  const captures = cfg.captures ?? ["❯ "];
  let captureIdx = 0;

  const deps: TmuxClaudeDeps = {
    async createWindow(opts) {
      rec.createWindowCalls.push(opts);
      rec.order.push("createWindow");
      return { paneTargetString };
    },
    async bootMember(opts) {
      rec.bootCalls.push(opts);
      rec.order.push("bootMember");
      return cfg.bootResult ?? { status: "booted", attempts: 1 };
    },
    async sendToMember(target, message, sendOpts) {
      rec.sendCalls.push({ target, message, verify: sendOpts.verify });
      rec.order.push("sendToMember");
      return cfg.sendOutcome ?? ({ kind: "ok" } as unknown as SendOutcome);
    },
    async capturePane(target) {
      rec.captureCalls.push(target);
      if (cfg.captureThrows === true) throw new Error("capture boom");
      const txt = captures[Math.min(captureIdx, captures.length - 1)] ?? "";
      captureIdx += 1;
      return txt;
    },
    async interruptKeys(target) {
      rec.interruptCalls.push(target);
      rec.order.push("interruptKeys");
    },
    async killWindow(target) {
      rec.killCalls.push(target);
      rec.order.push("killWindow");
    },
    sleep: (ms: number) => {
      sleepMs.push(ms);
      rec.order.push(`sleep:${ms}`);
      return Promise.resolve();
    },
    now: () => 1_700_000_000_000,
  };

  if (cfg.noAwaitReady !== true) {
    deps.awaitReady = async (target) => {
      rec.awaitCalls.push({ target });
      rec.order.push("awaitReady");
      return (
        cfg.readiness ??
        ({
          state: "ready",
          paneClassification: { state: "READY", evidence: "", capturedAt: 0 },
          evidence: "",
          elapsedMs: 0,
          attempts: 1,
        } satisfies PaneReadinessResult)
      );
    };
  }
  if (cfg.noProbe !== true) {
    deps.probeBudget = async (account) => {
      rec.probeCalls.push(account);
      rec.order.push("probeBudget");
      if (cfg.probeThrows === true) throw new Error("probe boom");
      return cfg.probe ?? null;
    };
  }
  if (cfg.noSoftStop !== true) {
    deps.softStopNotify = async (target) => {
      rec.softStopCalls.push(target);
      rec.order.push("softStopNotify");
    };
  }

  return { deps, rec, sleepMs };
}

function spawnOpts(over: Partial<AgentSpawnOptions> = {}): AgentSpawnOptions {
  return {
    systemPrompt: { preset: "member" },
    cwd: "/work/wt/alice",
    selector: { account: "icloud" },
    ...over,
  };
}

function probeResult(over: Partial<BudgetProbeResult> = {}): BudgetProbeResult {
  return {
    account: "icloud",
    h5_pct_used: 42,
    wk_pct_used: 13,
    h5_reset_epoch: 1_700_001_000,
    wk_reset_epoch: 1_700_500_000,
    status: "allowed",
    source: "probe",
    probedAt: 1_700_000_000,
    ...over,
  };
}

// ===========================================================================
// Pure mapping helpers — paneStateToStatusKind
// ===========================================================================

describe("paneStateToStatusKind — 8-state → SessionStatusKind", () => {
  const cases: [PaneState, string][] = [
    ["READY", "idle"],
    ["TYPING", "working"],
    ["BUSY", "working"],
    ["COMPACTING", "working"],
    ["MODAL", "awaiting-input"],
    ["RATE-LIMIT", "rate-limited"],
    ["SHELL", "errored"],
    ["UNKNOWN", "errored"],
  ];
  for (const [state, expected] of cases) {
    test(`${state} → ${expected}`, () => {
      expect(paneStateToStatusKind(state)).toBe(expected as never);
    });
  }

  test("overloaded is unreachable — no pane-state maps to it", () => {
    const mapped = cases.map(([s]) => paneStateToStatusKind(s));
    expect(mapped).not.toContain("overloaded");
  });
});

// ===========================================================================
// Pure mapping helpers — paneStateToEvent
// ===========================================================================

describe("paneStateToEvent — pane-state → coarse AgentEvent", () => {
  test("READY → idle event", () => {
    expect(paneStateToEvent("READY", "")).toEqual({ type: "idle" });
  });

  test("MODAL → permission_request (empty tool ids — not fabricated)", () => {
    const e = paneStateToEvent("MODAL", "Do you want to proceed?");
    expect(e).not.toBeNull();
    if (e === null) throw new Error("unreachable");
    expect(e.type).toBe("permission_request");
    if (e.type !== "permission_request") throw new Error("unreachable");
    // Honesty: tool name + call id are NOT fabricated from pane text.
    expect(e.toolName).toBe("");
    expect(e.toolCallId).toBe("");
    expect(e.input).toBe("Do you want to proceed?");
  });

  test("RATE-LIMIT → error{kind:rate_limit} carrying the banner evidence", () => {
    const e = paneStateToEvent("RATE-LIMIT", "You've hit your limit");
    if (e === null || e.type !== "error") throw new Error("expected error event");
    expect(e.kind).toBe("rate_limit");
    expect(e.message).toContain("hit your limit");
  });

  test("SHELL → error{kind:other} naming the crash", () => {
    const e = paneStateToEvent("SHELL", "$");
    if (e === null || e.type !== "error") throw new Error("expected error event");
    expect(e.kind).toBe("other");
    expect(e.message).toContain("shell");
  });

  test("UNKNOWN → error{kind:other}", () => {
    const e = paneStateToEvent("UNKNOWN", "");
    if (e === null || e.type !== "error") throw new Error("expected error event");
    expect(e.kind).toBe("other");
  });

  test("BUSY / TYPING / COMPACTING → null (no fabricated token stream)", () => {
    expect(paneStateToEvent("BUSY", "✻ Cooked")).toBeNull();
    expect(paneStateToEvent("TYPING", "queued")).toBeNull();
    expect(paneStateToEvent("COMPACTING", "Compacting")).toBeNull();
  });

  test("RATE-LIMIT with no evidence still emits a non-empty message", () => {
    const e = paneStateToEvent("RATE-LIMIT", "");
    if (e === null || e.type !== "error") throw new Error("expected error event");
    expect(e.message.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Pure mapping helpers — budgetToRateLimitStatus
// ===========================================================================

describe("budgetToRateLimitStatus", () => {
  test("maps probe util/reset onto RateLimitWindowStatus", () => {
    const s = budgetToRateLimitStatus(probeResult());
    expect(s).toEqual({
      h5PctUsed: 42,
      wkPctUsed: 13,
      h5ResetEpoch: 1_700_001_000,
      wkResetEpoch: 1_700_500_000,
    });
  });

  test("null probe → null (no fabrication)", () => {
    expect(budgetToRateLimitStatus(null)).toBeNull();
  });

  test("no-credentials probe → null (no fabrication)", () => {
    expect(budgetToRateLimitStatus(probeResult({ status: "no-credentials" }))).toBeNull();
  });
});

// ===========================================================================
// spawn()
// ===========================================================================

describe("spawn() — delegates to createWindow + bootMember (+ awaitReady)", () => {
  test("returns a handle with backendId + cwd; calls window create then boot then ready", async () => {
    const { deps, rec } = mkDeps({ paneTargetString: "atmux-t:1" });
    const be = createTmuxClaudeBackend(deps);
    const handle = await be.spawn(spawnOpts({ cwd: "/work/wt/bob" }));

    expect(handle.backendId).toBe(TMUX_CLAUDE_BACKEND_ID);
    expect(handle.cwd).toBe("/work/wt/bob");
    expect(handle.sessionId.length).toBeGreaterThan(0);

    // Delegation order: window create → boot → readiness.
    expect(rec.order).toEqual(["createWindow", "bootMember", "awaitReady"]);
    // Boot got the resolved pane-target string from createWindow.
    expect(rec.bootCalls[0]?.paneTargetString).toBe("atmux-t:1");
    // Readiness probed the SAME pane target.
    expect(rec.awaitCalls[0]?.target).toBe("atmux-t:1");
  });

  test("backend id is tmux-claude", () => {
    const { deps } = mkDeps();
    expect(createTmuxClaudeBackend(deps).id).toBe(TMUX_CLAUDE_BACKEND_ID);
  });

  test("resumeSessionId is used verbatim as the sessionId", async () => {
    const { deps } = mkDeps();
    const be = createTmuxClaudeBackend(deps);
    const handle = await be.spawn(spawnOpts({ resumeSessionId: "atmux-prod:planner" }));
    expect(handle.sessionId).toBe("atmux-prod:planner");
  });

  test("boot FAILED → spawn throws (does not return a dead handle)", async () => {
    const { deps } = mkDeps({
      bootResult: { status: "failed", attempts: 2, reason: "tokens-never-moved" },
    });
    const be = createTmuxClaudeBackend(deps);
    await expect(be.spawn(spawnOpts())).rejects.toThrow(/boot failed/i);
  });

  test("already-booted boot result is accepted (does not throw)", async () => {
    const { deps } = mkDeps({ bootResult: { status: "already-booted", attempts: 0 } });
    const be = createTmuxClaudeBackend(deps);
    const handle = await be.spawn(spawnOpts());
    expect(handle.backendId).toBe(TMUX_CLAUDE_BACKEND_ID);
  });

  test("readiness absent → spawn throws", async () => {
    const { deps } = mkDeps({
      readiness: {
        state: "absent",
        paneClassification: { state: "SHELL", evidence: "$", capturedAt: 0 },
        evidence: "$",
        elapsedMs: 10,
        attempts: 1,
      },
    });
    const be = createTmuxClaudeBackend(deps);
    await expect(be.spawn(spawnOpts())).rejects.toThrow(/readiness absent/i);
  });

  test("readiness timeout → spawn throws", async () => {
    const { deps } = mkDeps({
      readiness: {
        state: "timeout",
        paneClassification: { state: "UNKNOWN", evidence: "", capturedAt: 0 },
        evidence: "",
        elapsedMs: 30_000,
        attempts: 30,
      },
    });
    const be = createTmuxClaudeBackend(deps);
    await expect(be.spawn(spawnOpts())).rejects.toThrow(/readiness timeout/i);
  });

  test("no awaitReady wired → spawn succeeds on a booted result alone", async () => {
    const { deps, rec } = mkDeps({ noAwaitReady: true });
    const be = createTmuxClaudeBackend(deps);
    const handle = await be.spawn(spawnOpts());
    expect(handle.backendId).toBe(TMUX_CLAUDE_BACKEND_ID);
    expect(rec.awaitCalls.length).toBe(0);
    expect(rec.order).toEqual(["createWindow", "bootMember"]);
  });

  test("readiness starving is NOT a spawn failure (brief probably consumed)", async () => {
    const { deps } = mkDeps({
      readiness: {
        state: "starving",
        paneClassification: { state: "READY", evidence: "", capturedAt: 0 },
        evidence: "Welcome to Claude Code",
        elapsedMs: 100,
        attempts: 2,
      },
    });
    const be = createTmuxClaudeBackend(deps);
    // starving is surfaced but not fatal — only absent/timeout throw.
    const handle = await be.spawn(spawnOpts());
    expect(handle.backendId).toBe(TMUX_CLAUDE_BACKEND_ID);
  });
});

// ===========================================================================
// send()
// ===========================================================================

describe("send() — delegates to the verified-send path (QUEUE semantics)", () => {
  test("calls deps.sendToMember with the session's pane target + message + verify:true", async () => {
    const { deps, rec } = mkDeps({ paneTargetString: "atmux-t:7" });
    const be = createTmuxClaudeBackend(deps);
    const handle = await be.spawn(spawnOpts());
    await be.send(handle, "go do the thing");

    expect(rec.sendCalls.length).toBe(1);
    expect(rec.sendCalls[0]?.target).toBe("atmux-t:7");
    expect(rec.sendCalls[0]?.message).toBe("go do the thing");
    // Verify-on matches `atmux send` today (the verified-send path).
    expect(rec.sendCalls[0]?.verify).toBe(true);
  });

  test("does NOT call interrupt — send queues, it does not preempt", async () => {
    const { deps, rec } = mkDeps();
    const be = createTmuxClaudeBackend(deps);
    const handle = await be.spawn(spawnOpts());
    await be.send(handle, "msg");
    expect(rec.interruptCalls.length).toBe(0);
  });
});

// ===========================================================================
// interrupt()
// ===========================================================================

describe("interrupt() — fires the raw C-c stop path", () => {
  test("calls deps.interruptKeys with the session's pane target", async () => {
    const { deps, rec } = mkDeps({ paneTargetString: "atmux-t:3" });
    const be = createTmuxClaudeBackend(deps);
    const handle = await be.spawn(spawnOpts());
    await be.interrupt(handle);
    expect(rec.interruptCalls).toEqual(["atmux-t:3"]);
    // interrupt is NOT routed through the send path.
    expect(rec.sendCalls.length).toBe(0);
  });
});

// ===========================================================================
// stream()
// ===========================================================================

/** Drain up to `max` events from an async-iterable. */
async function drain(it: AsyncIterable<AgentEvent>, max: number): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) {
    out.push(e);
    if (out.length >= max) break;
  }
  return out;
}

describe("stream() — coarse synthesized events from pane-state polling", () => {
  test("emits one event per state TRANSITION (READY → MODAL → RATE-LIMIT)", async () => {
    // Pane captures classifying to READY, then MODAL, then RATE-LIMIT.
    const { deps } = mkDeps({
      captures: ["❯ ", "Do you want to proceed?", "You've hit your limit"],
    });
    const be = createTmuxClaudeBackend(deps, { streamPollIntervalMs: 0 });
    const handle = await be.spawn(spawnOpts());
    const events = await drain(be.stream(handle), 3);

    expect(events[0]).toEqual({ type: "idle" });
    expect(events[1]?.type).toBe("permission_request");
    expect(events[2]?.type).toBe("error");
    if (events[2]?.type === "error") expect(events[2].kind).toBe("rate_limit");
  });

  test("BUSY ticks emit NO event (no fabricated text_chunk); transition to READY emits idle", async () => {
    const { deps } = mkDeps({
      // Three BUSY captures, then READY. BUSY emits nothing; READY → idle.
      captures: ["✻ Cooking…", "✻ Cooking…", "✻ Cooking…", "❯ "],
    });
    const be = createTmuxClaudeBackend(deps, { streamPollIntervalMs: 0 });
    const handle = await be.spawn(spawnOpts());
    const events = await drain(be.stream(handle), 1);
    // The only event drained is the idle from the READY transition —
    // proving BUSY produced no text_chunk / no event.
    expect(events).toEqual([{ type: "idle" }]);
    // And no event is ever a text_chunk.
    for (const e of events) expect(e.type).not.toBe("text_chunk");
  });

  test("stream terminates after shutdown() sets the flag", async () => {
    const { deps } = mkDeps({ captures: ["✻ busy"] });
    const be = createTmuxClaudeBackend(deps, { streamPollIntervalMs: 0 });
    const handle = await be.spawn(spawnOpts());
    // BUSY emits nothing, so the loop spins on captures; shut it down and
    // the async-iterable must complete.
    await be.shutdown(handle, "hard");
    const collected: AgentEvent[] = [];
    for await (const e of be.stream(handle)) collected.push(e);
    // Already shut down before iterating → zero events, clean completion.
    expect(collected).toEqual([]);
  });

  test("capture error mid-stream does not end the stream (keeps polling, then recovers)", async () => {
    // capturePane throws on the FIRST in-loop call, then returns READY.
    // The stream must swallow the throw + keep polling, then emit the idle
    // event from the recovered READY capture — proving the in-loop catch
    // path (continue-and-retry) is exercised, not the whole-stream reject.
    let calls = 0;
    const deps: TmuxClaudeDeps = {
      async createWindow() {
        return { paneTargetString: "atmux-t:err" };
      },
      async bootMember() {
        return { status: "booted", attempts: 1 };
      },
      async sendToMember() {
        return { kind: "ok" } as unknown as SendOutcome;
      },
      async capturePane() {
        calls += 1;
        if (calls === 1) throw new Error("transient capture fault");
        return "❯ ";
      },
      async interruptKeys() {},
      async killWindow() {},
      sleep: NO_SLEEP,
      now: () => 1,
    };
    const be = createTmuxClaudeBackend(deps, { streamPollIntervalMs: 0 });
    const handle = await be.spawn(spawnOpts({ resumeSessionId: "s-throw" }));
    let rejected = false;
    let firstEvent: AgentEvent | undefined;
    try {
      for await (const e of be.stream(handle)) {
        firstEvent = e;
        break;
      }
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(false);
    // The throw was swallowed; the recovered READY capture produced idle.
    expect(firstEvent).toEqual({ type: "idle" });
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});

// ===========================================================================
// status()
// ===========================================================================

describe("status() — pane-state classification + sidecar rate-limit window", () => {
  test("READY pane → idle; pulls rateLimitStatus from the sidecar", async () => {
    const { deps, rec } = mkDeps({ captures: ["❯ "], probe: probeResult() });
    const be = createTmuxClaudeBackend(deps);
    const handle = await be.spawn(spawnOpts());
    const s = await be.status(handle);
    expect(s.kind).toBe("idle");
    expect(s.rateLimitStatus).toEqual({
      h5PctUsed: 42,
      wkPctUsed: 13,
      h5ResetEpoch: 1_700_001_000,
      wkResetEpoch: 1_700_500_000,
    });
    expect(rec.probeCalls).toContain("icloud");
    expect(s.observedAtSec).toBe(1_700_000_000);
  });

  test("BUSY pane → working", async () => {
    const { deps } = mkDeps({ captures: ["✻ Cooking…"] });
    const be = createTmuxClaudeBackend(deps);
    const handle = await be.spawn(spawnOpts());
    expect((await be.status(handle)).kind).toBe("working");
  });

  test("MODAL pane → awaiting-input", async () => {
    const { deps } = mkDeps({ captures: ["Do you want to proceed? [y/N]"] });
    const be = createTmuxClaudeBackend(deps);
    const handle = await be.spawn(spawnOpts());
    expect((await be.status(handle)).kind).toBe("awaiting-input");
  });

  test("RATE-LIMIT pane → rate-limited", async () => {
    const { deps } = mkDeps({ captures: ["You've hit your limit"] });
    const be = createTmuxClaudeBackend(deps);
    const handle = await be.spawn(spawnOpts());
    expect((await be.status(handle)).kind).toBe("rate-limited");
  });

  test("SHELL pane → errored", async () => {
    const { deps } = mkDeps({ captures: ["user@host ~/work $ "] });
    const be = createTmuxClaudeBackend(deps);
    const handle = await be.spawn(spawnOpts());
    expect((await be.status(handle)).kind).toBe("errored");
  });

  test("capture failure → errored (honest, not fabricated)", async () => {
    // First spawn with a working capture, then flip the mock to throw is
    // hard with the simple harness; instead build a deps whose capturePane
    // always throws AND whose boot/readiness succeed via resume id.
    const { deps } = mkDeps({ captureThrows: true, noAwaitReady: true });
    const be = createTmuxClaudeBackend(deps);
    const handle = await be.spawn(spawnOpts());
    expect((await be.status(handle)).kind).toBe("errored");
  });

  test("no sidecar wired → rateLimitStatus omitted (no fabrication)", async () => {
    const { deps } = mkDeps({ captures: ["❯ "], noProbe: true });
    const be = createTmuxClaudeBackend(deps);
    const handle = await be.spawn(spawnOpts());
    const s = await be.status(handle);
    expect(s.kind).toBe("idle");
    expect(s.rateLimitStatus).toBeUndefined();
  });

  test("sidecar probe throws → rateLimitStatus omitted (swallowed)", async () => {
    const { deps } = mkDeps({ captures: ["❯ "], probeThrows: true });
    const be = createTmuxClaudeBackend(deps);
    const handle = await be.spawn(spawnOpts());
    const s = await be.status(handle);
    expect(s.rateLimitStatus).toBeUndefined();
  });

  test("default account → sidecar not probed (no creds to probe)", async () => {
    const { deps, rec } = mkDeps({ captures: ["❯ "], probe: probeResult() });
    const be = createTmuxClaudeBackend(deps);
    const handle = await be.spawn(spawnOpts({ selector: { account: "default" } }));
    await be.status(handle);
    expect(rec.probeCalls.length).toBe(0);
  });
});

// ===========================================================================
// cost()
// ===========================================================================

describe("cost() — tokens 0, USD omitted, windows from sidecar", () => {
  test("input/output tokens are 0; estimatedUsd omitted (never fabricated)", async () => {
    const { deps } = mkDeps({ probe: probeResult() });
    const be = createTmuxClaudeBackend(deps);
    const handle = await be.spawn(spawnOpts());
    const c = await be.cost(handle);
    expect(c.inputTokens).toBe(0);
    expect(c.outputTokens).toBe(0);
    expect(c.estimatedUsd).toBeUndefined();
    expect(c.currencyCode).toBeUndefined();
  });

  test("windowsActive + resetAt come from the budget-probe sidecar", async () => {
    const { deps } = mkDeps({ probe: probeResult() });
    const be = createTmuxClaudeBackend(deps);
    const handle = await be.spawn(spawnOpts());
    const c = await be.cost(handle);
    expect(c.windowsActive).toEqual({ h5: 42, wk: 13 });
    expect(c.resetAt).toEqual({ h5: 1_700_001_000, wk: 1_700_500_000 });
  });

  test("no sidecar / no creds → window fields omitted", async () => {
    const { deps } = mkDeps({ noProbe: true });
    const be = createTmuxClaudeBackend(deps);
    const handle = await be.spawn(spawnOpts());
    const c = await be.cost(handle);
    expect(c.inputTokens).toBe(0);
    expect(c.windowsActive).toBeUndefined();
    expect(c.resetAt).toBeUndefined();
  });

  test("no-credentials probe → window fields omitted", async () => {
    const { deps } = mkDeps({ probe: probeResult({ status: "no-credentials" }) });
    const be = createTmuxClaudeBackend(deps);
    const handle = await be.spawn(spawnOpts());
    const c = await be.cost(handle);
    expect(c.windowsActive).toBeUndefined();
  });
});

// ===========================================================================
// shutdown()
// ===========================================================================

describe("shutdown() — graceful (notify + grace + kill) vs hard (kill)", () => {
  test("graceful: softStopNotify → grace sleep → killWindow, in that order", async () => {
    const { deps, rec, sleepMs } = mkDeps({ paneTargetString: "atmux-t:9" });
    const be = createTmuxClaudeBackend(deps);
    const handle = await be.spawn(spawnOpts());
    // Trim the spawn-side order noise — focus on the shutdown tail.
    rec.order.length = 0;
    sleepMs.length = 0;
    await be.shutdown(handle, "graceful");

    expect(rec.softStopCalls).toEqual(["atmux-t:9"]);
    expect(rec.killCalls).toEqual(["atmux-t:9"]);
    // Order: notify BEFORE the grace sleep BEFORE the kill.
    expect(rec.order).toEqual([
      "softStopNotify",
      `sleep:${GRACEFUL_SHUTDOWN_GRACE_MS}`,
      "killWindow",
    ]);
  });

  test("hard: kills immediately — no softStopNotify, no grace sleep", async () => {
    const { deps, rec, sleepMs } = mkDeps({ paneTargetString: "atmux-t:2" });
    const be = createTmuxClaudeBackend(deps);
    const handle = await be.spawn(spawnOpts());
    rec.order.length = 0;
    sleepMs.length = 0;
    await be.shutdown(handle, "hard");

    expect(rec.softStopCalls.length).toBe(0);
    expect(sleepMs.length).toBe(0);
    expect(rec.killCalls).toEqual(["atmux-t:2"]);
    expect(rec.order).toEqual(["killWindow"]);
  });

  test("graceful with no softStopNotify wired → still grace-sleeps then kills", async () => {
    const { deps, rec } = mkDeps({ noSoftStop: true });
    const be = createTmuxClaudeBackend(deps);
    const handle = await be.spawn(spawnOpts());
    rec.order.length = 0;
    await be.shutdown(handle, "graceful");
    expect(rec.order).toEqual([`sleep:${GRACEFUL_SHUTDOWN_GRACE_MS}`, "killWindow"]);
  });

  test("graceful softStopNotify throwing does not block the kill", async () => {
    const { deps, rec } = mkDeps();
    deps.softStopNotify = async () => {
      throw new Error("notify boom");
    };
    const be = createTmuxClaudeBackend(deps);
    const handle = await be.spawn(spawnOpts());
    rec.killCalls.length = 0;
    await be.shutdown(handle, "graceful");
    expect(rec.killCalls.length).toBe(1);
  });

  test("shutdown then stream() yields nothing (terminated)", async () => {
    const { deps } = mkDeps({ captures: ["✻ busy"] });
    const be = createTmuxClaudeBackend(deps, { streamPollIntervalMs: 0 });
    const handle = await be.spawn(spawnOpts());
    await be.shutdown(handle, "hard");
    const collected: AgentEvent[] = [];
    for await (const e of be.stream(handle)) collected.push(e);
    expect(collected).toEqual([]);
  });
});

// ===========================================================================
// Cross-verb integration: target threading through the handle
// ===========================================================================

describe("session target threading", () => {
  test("two sessions get distinct targets routed to the right verbs", async () => {
    // Build deps whose createWindow returns a target derived from sessionId
    // so we can prove send/interrupt route to the correct pane per handle.
    const rec: { send: { t: string; m: string }[]; intr: string[] } = { send: [], intr: [] };
    const deps: TmuxClaudeDeps = {
      async createWindow(opts) {
        return { paneTargetString: `pane-for-${opts.sessionId}` };
      },
      async bootMember() {
        return { status: "booted", attempts: 1 };
      },
      async sendToMember(target, message) {
        rec.send.push({ t: target, m: message });
        return { kind: "ok" } as unknown as SendOutcome;
      },
      async capturePane() {
        return "❯ ";
      },
      async interruptKeys(target) {
        rec.intr.push(target);
      },
      async killWindow() {},
      sleep: NO_SLEEP,
      now: () => 1,
    };
    const be = createTmuxClaudeBackend(deps);
    const a: SessionHandle = await be.spawn(spawnOpts({ resumeSessionId: "A" }));
    const b: SessionHandle = await be.spawn(spawnOpts({ resumeSessionId: "B" }));

    await be.send(a, "to-a");
    await be.send(b, "to-b");
    await be.interrupt(a);

    expect(rec.send).toEqual([
      { t: "pane-for-A", m: "to-a" },
      { t: "pane-for-B", m: "to-b" },
    ]);
    expect(rec.intr).toEqual(["pane-for-A"]);
  });
});
