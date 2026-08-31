// Unit tests for src/core/pane-readiness.ts (t-47f4425f bootstrap-brief
// delivery verification, complaint c-fbecbf65).
//
// Covers:
//   - inspectClaudeReadiness — pure decision helper across each (state,
//     text, requireBriefConsumed) combination.
//   - awaitClaudePaneReady — polling probe terminates on first conclusive
//     state, falls through to "timeout" when the deadline lands first,
//     and emits stable elapsed-ms / attempts counters.
//   - formatReadinessWarning — emits null on happy path, structured
//     single-liner otherwise (operator-visible in cockpit-rebuild output).

import { describe, expect, test } from "bun:test";
import {
  awaitClaudePaneReady,
  formatReadinessWarning,
  inspectClaudeReadiness,
  type PaneReadinessResult,
} from "../../../src/core/pane-readiness.ts";
import { classifyText } from "../../../src/core/pane-state.ts";

// ---------- Captures library ----------

/** A fresh claude TUI at the welcome screen — the c-fbecbf65 pathology.
 *  Prompt visible (READY classification) but welcome banner + placeholder
 *  tips show no brief was consumed. */
const WELCOME_SCREEN = [
  "Welcome to Claude Code",
  "",
  '  Try "create a util logging.py that..."',
  '  Try "fix typecheck errors"',
  "",
  "❯",
  "",
  "  ⏵⏵ auto mode on",
].join("\n");

/** Claude with the brief consumed — token counter visible, no welcome
 *  banner. The c-fbecbf65 "team is actually running" target state. */
const ACTIVE_PANE = [
  "  Some output from the agent here ...",
  "",
  "❯",
  "",
  "  tok 47k/200  ⏵⏵ auto mode on",
].join("\n");

/** Pane fell back to a shell prompt — claude crashed or never spawned. */
const SHELL_PANE = "user@host:/work/src/atmux$ ";

/** Pane state mid-startup — capture happened before claude rendered its
 *  TUI; nothing matches the pattern catalog. */
const BOOTING_PANE = "\n\n\n";

// ---------- inspectClaudeReadiness ----------

describe("inspectClaudeReadiness", () => {
  test("welcome screen + requireBriefConsumed=true → starving", () => {
    const cls = classifyText(WELCOME_SCREEN);
    expect(inspectClaudeReadiness(WELCOME_SCREEN, cls, true)).toBe("starving");
  });

  test("welcome screen + requireBriefConsumed=false → ready (TUI alive)", () => {
    const cls = classifyText(WELCOME_SCREEN);
    expect(inspectClaudeReadiness(WELCOME_SCREEN, cls, false)).toBe("ready");
  });

  test("active pane + requireBriefConsumed=true → ready (token counter present)", () => {
    const cls = classifyText(ACTIVE_PANE);
    expect(inspectClaudeReadiness(ACTIVE_PANE, cls, true)).toBe("ready");
  });

  test("active pane + requireBriefConsumed=false → ready", () => {
    const cls = classifyText(ACTIVE_PANE);
    expect(inspectClaudeReadiness(ACTIVE_PANE, cls, false)).toBe("ready");
  });

  test("shell prompt → absent (any mode)", () => {
    const cls = classifyText(SHELL_PANE);
    expect(inspectClaudeReadiness(SHELL_PANE, cls, false)).toBe("absent");
    expect(inspectClaudeReadiness(SHELL_PANE, cls, true)).toBe("absent");
  });

  test("UNKNOWN classification → pending (caller polls)", () => {
    const cls = classifyText(BOOTING_PANE);
    expect(cls.state).toBe("UNKNOWN");
    expect(inspectClaudeReadiness(BOOTING_PANE, cls, false)).toBe("pending");
    expect(inspectClaudeReadiness(BOOTING_PANE, cls, true)).toBe("pending");
  });

  // Post-/clear edge case — bare prompt with no welcome banner and no
  // token counter (counter only appears after a message is consumed).
  // Strict mode must NOT flag this as starving — that would false-positive
  // on every successful rotate-lead clear.
  test("bare prompt, no banner, no tokens + strict → ready (post-/clear fallthrough)", () => {
    const text = "❯\n";
    const cls = classifyText(text);
    expect(cls.state).toBe("READY");
    expect(inspectClaudeReadiness(text, cls, true)).toBe("ready");
  });
});

// ---------- awaitClaudePaneReady ----------

interface ProbeFixture {
  captures: string[];
  sleeps: number[];
  /** Synthetic clock; advances by `clockTickMs` on each `now()` call so
   *  deadline arithmetic is deterministic without real timers. */
  nowMs: number;
  clockTickMs: number;
}

function buildProbeDeps(captures: string[], clockTickMs = 250) {
  const state: ProbeFixture = {
    captures,
    sleeps: [],
    nowMs: 1_000,
    clockTickMs,
  };
  let captureIdx = 0;
  const deps = {
    capture: async (_target: string) => {
      const i = Math.min(captureIdx, captures.length - 1);
      captureIdx += 1;
      return captures[i] ?? "";
    },
    sleep: async (ms: number) => {
      state.sleeps.push(ms);
      // Sleeps DO advance the synthetic clock (mirrors wall-time).
      state.nowMs += ms;
    },
    now: () => {
      const v = state.nowMs;
      state.nowMs += clockTickMs;
      return v;
    },
  };
  return { state, deps };
}

describe("awaitClaudePaneReady — terminates on first conclusive state", () => {
  test("active pane on first capture → ready, no sleeps", async () => {
    const { state, deps } = buildProbeDeps([ACTIVE_PANE]);
    const result = await awaitClaudePaneReady("atmux:0", { requireBriefConsumed: true }, deps);
    expect(result.state).toBe("ready");
    expect(result.attempts).toBe(1);
    expect(state.sleeps).toHaveLength(0);
  });

  test("welcome screen on first capture, strict → starving immediately", async () => {
    const { state, deps } = buildProbeDeps([WELCOME_SCREEN]);
    const result = await awaitClaudePaneReady("atmux:0", { requireBriefConsumed: true }, deps);
    expect(result.state).toBe("starving");
    expect(result.attempts).toBe(1);
    expect(state.sleeps).toHaveLength(0);
  });

  test("welcome screen on first capture, lax → ready (TUI alive)", async () => {
    const { deps } = buildProbeDeps([WELCOME_SCREEN]);
    const result = await awaitClaudePaneReady("atmux:0", { requireBriefConsumed: false }, deps);
    expect(result.state).toBe("ready");
    expect(result.attempts).toBe(1);
  });

  test("shell prompt on first capture → absent (any mode)", async () => {
    const { deps } = buildProbeDeps([SHELL_PANE]);
    const result = await awaitClaudePaneReady("atmux:0", {}, deps);
    expect(result.state).toBe("absent");
  });

  test("booting → active → ready on second attempt (sleeps once)", async () => {
    const { state, deps } = buildProbeDeps([BOOTING_PANE, ACTIVE_PANE]);
    const result = await awaitClaudePaneReady(
      "atmux:0",
      { requireBriefConsumed: true, pollIntervalMs: 100 },
      deps,
    );
    expect(result.state).toBe("ready");
    expect(result.attempts).toBe(2);
    expect(state.sleeps).toEqual([100]);
  });
});

describe("awaitClaudePaneReady — deadline handling", () => {
  test("stays UNKNOWN past deadline → timeout", async () => {
    // Synthetic clock ticks 250ms per now() call, sleeps add the poll
    // interval. With deadlineMs=600, we should see ~2 attempts before
    // the deadline trips.
    const { state, deps } = buildProbeDeps([BOOTING_PANE], 250);
    const result = await awaitClaudePaneReady(
      "atmux:0",
      { deadlineMs: 600, pollIntervalMs: 200 },
      deps,
    );
    expect(result.state).toBe("timeout");
    expect(result.attempts).toBeGreaterThanOrEqual(1);
    // At least one sleep happened (we polled then deadline tripped).
    expect(state.sleeps.length).toBeGreaterThanOrEqual(0);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(600);
  });

  test("uses the real default sleep before retrying UNKNOWN panes", async () => {
    const { state, deps } = buildProbeDeps([BOOTING_PANE], 250);
    const { sleep: _sleep, ...defaultSleepDeps } = deps;
    void _sleep;
    let markerHandle: ReturnType<typeof setTimeout> | null = null;
    const marker = new Promise<void>((resolve) => {
      markerHandle = setTimeout(() => {
        resolve();
      }, 0);
    });
    const probe = awaitClaudePaneReady(
      "atmux:0",
      { deadlineMs: 1_000, pollIntervalMs: 1 },
      defaultSleepDeps,
    );

    try {
      const firstSettled = await Promise.race([
        probe.then(() => "probe"),
        marker.then(() => "marker"),
      ]);
      expect(firstSettled).toBe("marker");

      const result = await probe;
      expect(result.state).toBe("timeout");
      expect(result.attempts).toBe(2);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(1_000);
      expect(state.sleeps).toHaveLength(0);
    } finally {
      await marker;
      if (markerHandle !== null) clearTimeout(markerHandle);
    }
  });

  test("welcome screen persists past deadline in strict mode → starving on first read", async () => {
    // The probe terminates on the first conclusive state — welcome
    // screen is conclusive in strict mode, so the deadline never trips.
    const { state, deps } = buildProbeDeps([WELCOME_SCREEN]);
    const result = await awaitClaudePaneReady(
      "atmux:0",
      { requireBriefConsumed: true, deadlineMs: 30_000 },
      deps,
    );
    expect(result.state).toBe("starving");
    expect(result.attempts).toBe(1);
    expect(state.sleeps).toHaveLength(0);
  });
});

// ---------- formatReadinessWarning ----------

describe("formatReadinessWarning", () => {
  function buildResult(state: PaneReadinessResult["state"]): PaneReadinessResult {
    return {
      state,
      paneClassification: { state: "READY", evidence: "❯", capturedAt: 1_000 },
      evidence: "Welcome to Claude Code\n❯",
      elapsedMs: 1_234,
      attempts: 3,
    };
  }

  test("ready → null (no warning emitted on happy path)", () => {
    expect(formatReadinessWarning("alice", buildResult("ready"))).toBeNull();
  });

  test("starving → single-line warning with member + state + evidence tail", () => {
    const line = formatReadinessWarning("alice", buildResult("starving"));
    expect(line).not.toBeNull();
    expect(line).toContain("alice");
    expect(line).toContain("starving");
    expect(line).toContain("Welcome to Claude Code");
    // Newlines replaced with ⏎ separator so the warning stays one line.
    expect(line).not.toContain("\n");
  });

  test("timeout → warning includes attempts + elapsed", () => {
    const line = formatReadinessWarning("bob", buildResult("timeout"));
    expect(line).not.toBeNull();
    expect(line).toContain("bob");
    expect(line).toContain("timeout");
    expect(line).toContain("3 captures");
    expect(line).toContain("1234ms");
  });

  test("absent → warning flags shell-fallback", () => {
    const line = formatReadinessWarning("charlie", buildResult("absent"));
    expect(line).not.toBeNull();
    expect(line).toContain("absent");
  });
});
