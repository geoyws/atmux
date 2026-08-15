// EPIC e-f28c2596 T5 — unit tests for src/core/queued-text-resubmit.ts (T1 c24ee2b).
//
// Covers the 4 documented state branches:
//   (a) empty composer            → noop;        sendKeysFn NOT called
//   (b) queued + active-turn      → skip;        sendKeysFn NOT called
//   (c) queued + idle             → fire;        sendKeysFn called once
//   (d) queued + post-fire fail   → log-failure; failureLogFn called with text + capture
//
// Plus negative-space coverage for `extractQueuedText` (composer absent, residue-only
// scrollback, glyph-on-non-composer-line) per memory feedback_residue_claim_text_not_queued_enter.

import { describe, expect, test } from "bun:test";
import {
  type ClockFn,
  detectAndResubmit,
  extractQueuedText,
  type QueuedResubmitFailureEntry,
  type QueuedResubmitFailureLogFn,
  type QueuedResubmitSendKeysFn,
  type QueuedResubmitSendResult,
} from "../../../src/core/queued-text-resubmit.ts";

// ---------- fixture helpers ----------

interface SendKeysCall {
  text: string;
}

interface FailureLogCall {
  entry: QueuedResubmitFailureEntry;
}

interface Fixture {
  sendKeysCalls: SendKeysCall[];
  failureLogCalls: FailureLogCall[];
  /** Configured response for sendKeysFn. Defaults to success=true. */
  sendKeysResult: QueuedResubmitSendResult;
  sendKeysFn: QueuedResubmitSendKeysFn;
  failureLogFn: QueuedResubmitFailureLogFn;
  clockFn: ClockFn;
}

function buildFixture(
  opts: { sendKeysResult?: Partial<QueuedResubmitSendResult>; clockMs?: number } = {},
): Fixture {
  const fx: Fixture = {
    sendKeysCalls: [],
    failureLogCalls: [],
    sendKeysResult: {
      success: opts.sendKeysResult?.success ?? true,
      attempts: opts.sendKeysResult?.attempts ?? 1,
      finalCapture: opts.sendKeysResult?.finalCapture ?? "post-send capture",
    },
    sendKeysFn: undefined as unknown as QueuedResubmitSendKeysFn,
    failureLogFn: undefined as unknown as QueuedResubmitFailureLogFn,
    clockFn: () => opts.clockMs ?? 1_700_000_000_000,
  };
  fx.sendKeysFn = async (text: string): Promise<QueuedResubmitSendResult> => {
    fx.sendKeysCalls.push({ text });
    return fx.sendKeysResult;
  };
  fx.failureLogFn = async (entry: QueuedResubmitFailureEntry): Promise<void> => {
    fx.failureLogCalls.push({ entry });
  };
  return fx;
}

/** Synthesize a Claude TUI pane capture (last N lines) with the given composer
 *  text + optional active-turn indicator. The composer prompt glyph `❯` lives
 *  on the LAST line; the optional indicator goes one line above it (mimics the
 *  status line above the composer in the real TUI). */
function paneCapture(opts: {
  composerText?: string;
  thinkingMarker?: string;
  /** Extra scrollback lines prepended above the indicator + composer. */
  scrollback?: ReadonlyArray<string>;
}): string {
  const lines: string[] = [];
  if (opts.scrollback !== undefined) lines.push(...opts.scrollback);
  if (opts.thinkingMarker !== undefined) lines.push(opts.thinkingMarker);
  // Composer line — glyph + optional text.
  lines.push(`❯ ${opts.composerText ?? ""}`.trimEnd());
  return lines.join("\n");
}

// ---------- detectAndResubmit: 4 state branches ----------

describe("detectAndResubmit — 4 state branches per T5 contract", () => {
  test("(a) empty composer → noop; sendKeysFn NOT called", async () => {
    const fx = buildFixture();
    const capture = paneCapture({ composerText: "" });
    const action = await detectAndResubmit(capture, fx.sendKeysFn, fx.clockFn, fx.failureLogFn);
    expect(action.kind).toBe("noop");
    expect(action.text).toBeUndefined();
    expect(fx.sendKeysCalls).toHaveLength(0);
    expect(fx.failureLogCalls).toHaveLength(0);
    expect(action.timestampMs).toBe(fx.clockFn());
    expect(action.reason).toContain("composer empty");
  });

  test("(a') composer absent (no ❯ glyph anywhere) → noop", async () => {
    const fx = buildFixture();
    const capture = "● How is Claude doing this session?\n[no composer here]";
    const action = await detectAndResubmit(capture, fx.sendKeysFn, fx.clockFn, fx.failureLogFn);
    expect(action.kind).toBe("noop");
    expect(fx.sendKeysCalls).toHaveLength(0);
    expect(fx.failureLogCalls).toHaveLength(0);
  });

  test("(b) queued + present-tense `Cooking…` (active spinner line) → skip mid-turn; sendKeysFn NOT called", async () => {
    const fx = buildFixture();
    const capture = paneCapture({
      composerText: "claim --next",
      // Active turn: the present-tense `Cooking…` verb (not the bare glyph) is
      // what marks this mid-turn per t-408a3c75.
      thinkingMarker: "✻ Cooking… (12s)",
    });
    const action = await detectAndResubmit(capture, fx.sendKeysFn, fx.clockFn, fx.failureLogFn);
    expect(action.kind).toBe("skip");
    expect(action.text).toBe("claim --next");
    expect(fx.sendKeysCalls).toHaveLength(0);
    expect(fx.failureLogCalls).toHaveLength(0);
    expect(action.reason).toContain("mid-turn");
  });

  test("(b') queued + ✶ glyph → skip", async () => {
    const fx = buildFixture();
    const capture = paneCapture({
      composerText: "/loop /whip",
      thinkingMarker: "✶ Schlepping…",
    });
    const action = await detectAndResubmit(capture, fx.sendKeysFn, fx.clockFn, fx.failureLogFn);
    expect(action.kind).toBe("skip");
    expect(fx.sendKeysCalls).toHaveLength(0);
  });

  test("(b'') queued + ✽ glyph → skip", async () => {
    const fx = buildFixture();
    const capture = paneCapture({
      composerText: "atmux ombudsman work",
      thinkingMarker: "✽ Crunching…",
    });
    const action = await detectAndResubmit(capture, fx.sendKeysFn, fx.clockFn, fx.failureLogFn);
    expect(action.kind).toBe("skip");
    expect(fx.sendKeysCalls).toHaveLength(0);
  });

  test("(b''') queued + present-tense thinking verb (no glyph) → skip", async () => {
    const fx = buildFixture();
    const capture = paneCapture({
      composerText: "stand down",
      thinkingMarker: "Cogitating…",
    });
    const action = await detectAndResubmit(capture, fx.sendKeysFn, fx.clockFn, fx.failureLogFn);
    expect(action.kind).toBe("skip");
    expect(fx.sendKeysCalls).toHaveLength(0);
  });

  test("(b'''') queued + `… (Ns)` elapsed marker → skip", async () => {
    const fx = buildFixture();
    const capture = paneCapture({
      composerText: "claim --next",
      thinkingMarker: "… (43s)",
    });
    const action = await detectAndResubmit(capture, fx.sendKeysFn, fx.clockFn, fx.failureLogFn);
    expect(action.kind).toBe("skip");
    expect(fx.sendKeysCalls).toHaveLength(0);
  });

  test("(c) queued + past-tense glyph in scrollback (idle) → fire; sendKeysFn called ONCE with the captured text", async () => {
    const fx = buildFixture({ sendKeysResult: { success: true, attempts: 1 } });
    const capture = paneCapture({
      composerText: "claim --next",
      // No active thinking marker; the `✻ Worked for 22s` line is a PAST-tense,
      // idle display — the turn has finished. Per t-408a3c75 the bare glyph is
      // no longer an active-turn indicator, so this MUST fire (the 2026-05-19
      // unum incident: 7/7 panes wedged exactly because this skipped).
      scrollback: ["✻ Worked for 22s", "(post-turn idle, no active indicator)"],
    });
    const action = await detectAndResubmit(capture, fx.sendKeysFn, fx.clockFn, fx.failureLogFn);
    expect(action.kind).toBe("fire");
    expect(action.text).toBe("claim --next");
    expect(fx.sendKeysCalls).toHaveLength(1);
    expect(fx.sendKeysCalls[0]?.text).toBe("claim --next");
    expect(fx.failureLogCalls).toHaveLength(0);
  });

  test("(c-regress) queued + `✻ Brewed for 1m 56s` past-tense glyph (idle) → fire (t-408a3c75 regression-guard)", async () => {
    const fx = buildFixture({ sendKeysResult: { success: true, attempts: 1 } });
    const capture = paneCapture({
      composerText: "/loop /whip",
      // Regression-guard for the 2026-05-19 unum wedge: a past-tense `✻ Brewed
      // for 1m 56s` display contains the spinner glyph but the agent is idle.
      // The bare glyph MUST NOT re-introduce a skip here.
      scrollback: ["✻ Brewed for 1m 56s"],
    });
    const action = await detectAndResubmit(capture, fx.sendKeysFn, fx.clockFn, fx.failureLogFn);
    expect(action.kind).toBe("fire");
    expect(action.text).toBe("/loop /whip");
    expect(fx.sendKeysCalls).toHaveLength(1);
    expect(fx.sendKeysCalls[0]?.text).toBe("/loop /whip");
    expect(fx.failureLogCalls).toHaveLength(0);
  });

  test("(c') queued + truly empty scrollback → fire; sendKeysFn called ONCE with the captured text", async () => {
    const fx = buildFixture({ sendKeysResult: { success: true, attempts: 1 } });
    const capture = paneCapture({
      composerText: "/loop /whip",
      scrollback: ["(empty scrollback, post-turn settled)"],
    });
    const action = await detectAndResubmit(capture, fx.sendKeysFn, fx.clockFn, fx.failureLogFn);
    expect(action.kind).toBe("fire");
    expect(action.text).toBe("/loop /whip");
    expect(fx.sendKeysCalls).toHaveLength(1);
    expect(fx.sendKeysCalls[0]?.text).toBe("/loop /whip");
    expect(fx.failureLogCalls).toHaveLength(0);
    expect(action.sendResult?.success).toBe(true);
    expect(action.sendResult?.attempts).toBe(1);
    expect(action.reason).toContain("resubmitted");
  });

  test("(c'') queued + multi-attempt success → fire; reports attempts in descriptor", async () => {
    const fx = buildFixture({ sendKeysResult: { success: true, attempts: 2 } });
    const capture = paneCapture({
      composerText: "atmux ombudsman work",
      scrollback: ["(post-turn idle)"],
    });
    const action = await detectAndResubmit(capture, fx.sendKeysFn, fx.clockFn, fx.failureLogFn);
    expect(action.kind).toBe("fire");
    expect(action.sendResult?.attempts).toBe(2);
    expect(action.reason).toContain("2 attempt");
  });

  test("(d) queued + post-fire no token-delta (success=false) → log-failure; failureLogFn called", async () => {
    const fx = buildFixture({
      sendKeysResult: { success: false, attempts: 2, finalCapture: "still has queued text" },
    });
    const capture = paneCapture({
      composerText: "claim --next",
      scrollback: ["(post-turn idle)"],
    });
    const action = await detectAndResubmit(capture, fx.sendKeysFn, fx.clockFn, fx.failureLogFn);
    expect(action.kind).toBe("log-failure");
    expect(action.text).toBe("claim --next");
    expect(fx.sendKeysCalls).toHaveLength(1);
    expect(fx.failureLogCalls).toHaveLength(1);
    const logged = fx.failureLogCalls[0]?.entry;
    expect(logged?.text).toBe("claim --next");
    expect(logged?.sendResult.success).toBe(false);
    expect(logged?.sendResult.attempts).toBe(2);
    expect(logged?.preCapture).toBe(capture);
    expect(logged?.timestampMs).toBe(fx.clockFn());
    expect(action.sendResult?.success).toBe(false);
    expect(action.reason).toContain("failed after 2 attempt");
  });
});

// ---------- detectAndResubmit: cross-cutting properties ----------

describe("detectAndResubmit — cross-cutting properties", () => {
  test("clockFn called exactly once; timestamp stamped into action descriptor", async () => {
    let clockCallCount = 0;
    const stableMs = 1_700_000_123_456;
    const clock: ClockFn = () => {
      clockCallCount += 1;
      return stableMs;
    };
    const sendKeysFn: QueuedResubmitSendKeysFn = async () => ({
      success: true,
      attempts: 1,
      finalCapture: "",
    });
    const failureLogFn: QueuedResubmitFailureLogFn = async () => {};
    const capture = paneCapture({ composerText: "" });
    const action = await detectAndResubmit(capture, sendKeysFn, clock, failureLogFn);
    expect(clockCallCount).toBe(1);
    expect(action.timestampMs).toBe(stableMs);
  });

  test("noop / skip never invoke sendKeysFn (no side effects on the safe paths)", async () => {
    const fx = buildFixture();
    // noop
    await detectAndResubmit(
      paneCapture({ composerText: "" }),
      fx.sendKeysFn,
      fx.clockFn,
      fx.failureLogFn,
    );
    // skip — active turn
    await detectAndResubmit(
      paneCapture({ composerText: "claim --next", thinkingMarker: "✻ Cooking…" }),
      fx.sendKeysFn,
      fx.clockFn,
      fx.failureLogFn,
    );
    expect(fx.sendKeysCalls).toHaveLength(0);
    expect(fx.failureLogCalls).toHaveLength(0);
  });

  test("fire success path NEVER invokes failureLogFn", async () => {
    const fx = buildFixture({ sendKeysResult: { success: true, attempts: 1 } });
    const capture = paneCapture({ composerText: "claim --next" });
    const action = await detectAndResubmit(capture, fx.sendKeysFn, fx.clockFn, fx.failureLogFn);
    expect(action.kind).toBe("fire");
    expect(fx.failureLogCalls).toHaveLength(0);
  });

  test("log-failure path passes the original pre-fire capture (not the post-fire capture)", async () => {
    const fx = buildFixture({
      sendKeysResult: { success: false, attempts: 1, finalCapture: "AFTER" },
    });
    const capture = paneCapture({ composerText: "claim --next" });
    await detectAndResubmit(capture, fx.sendKeysFn, fx.clockFn, fx.failureLogFn);
    expect(fx.failureLogCalls[0]?.entry.preCapture).toBe(capture);
    expect(fx.failureLogCalls[0]?.entry.preCapture).not.toBe("AFTER");
  });
});

// ---------- extractQueuedText: helper edge cases ----------

describe("extractQueuedText", () => {
  test("returns null for capture without ❯ glyph", () => {
    expect(extractQueuedText("nothing to see\nhere either")).toBeNull();
  });

  test("returns null for empty composer (`❯ ` with no trailing text)", () => {
    expect(extractQueuedText("scrollback\n❯ ")).toBeNull();
    expect(extractQueuedText("scrollback\n❯")).toBeNull();
    expect(extractQueuedText("scrollback\n❯  ")).toBeNull();
  });

  test("returns trimmed composer text", () => {
    expect(extractQueuedText("❯ claim --next")).toBe("claim --next");
    expect(extractQueuedText("❯   atmux ombudsman work   ")).toBe("atmux ombudsman work");
  });

  test("scans bottom-up — finds LAST ❯ (live composer beats scrollback bubbles)", () => {
    const capture = "❯ old prompt from a prior turn\n❯ stand down";
    expect(extractQueuedText(capture)).toBe("stand down");
  });

  test("scrollback containing ❯ but composer empty → null", () => {
    const capture = "❯ prior submission\n❯ ";
    expect(extractQueuedText(capture)).toBeNull();
  });

  test("composer text after `❯` glyph survives across multi-line capture", () => {
    const capture = [
      "● Welcome bubble",
      "● Some other output",
      "✻ Worked for 22s",
      "❯ /loop /whip",
    ].join("\n");
    expect(extractQueuedText(capture)).toBe("/loop /whip");
  });
});
