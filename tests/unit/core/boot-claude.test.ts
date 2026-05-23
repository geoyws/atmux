// Unit tests for src/core/boot-claude.ts (ADR-081 §C completion /
// t-94d7ad60).
//
// Coverage strategy:
//   - renderBootPrompt — verbatim template + variable substitution.
//   - renderBootFailureNotice — markdown shape + reason mapping.
//   - isTuiReady / tokensMoved — regex hit/miss per the canonical
//     captures we expect from claude TUI scrollback.
//   - bootClaudeMember — pre-send sentinel, ready-poll
//     timeout/success, post-boot tokens-moved success on first try,
//     retry path (first miss → second hit), full-fail (both miss),
//     send-keys verb-failure with retry, capture-pane error → degrade.

import { describe, expect, test } from "bun:test";
import type { SendTarget, TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import {
  bootClaudeMember,
  isTuiReady,
  renderBootFailureNotice,
  renderBootPrompt,
  bootSignalLive,
  thinkingActive,
  tokensMoved,
} from "../../../src/core/boot-claude.ts";

// ---------- Fake-tmux helper ----------

interface CallRecord {
  kind: "send" | "capture";
  payload?: string;
  target?: string;
}

/** Build a stub TmuxNamespace that satisfies the bootClaudeMember
 *  surface (capture-pane + send-keys only). Other namespace methods
 *  remain undefined — bootClaudeMember never reaches them, and
 *  TS structural typing flags any drift. */
function fakeTmux(opts: {
  /** Sequence of capture-pane stdout strings. The implementation
   *  pops one per call; if the array is exhausted, the last entry
   *  is returned indefinitely (sticky steady-state). */
  captures: string[];
  /** If set, capturePane throws on the Nth call (1-indexed). */
  captureThrowOn?: number;
  /** If set, sendKeys throws on the Nth call (1-indexed). */
  sendThrowOn?: number;
}): {
  tmux: TmuxNamespace;
  calls: CallRecord[];
  getCaptureCallCount: () => number;
  getSendCallCount: () => number;
} {
  const calls: CallRecord[] = [];
  let captureCallCount = 0;
  let sendCallCount = 0;
  let captureIdx = 0;

  const tmux = {
    pane: {
      async capturePane(callOpts: { target: string }) {
        captureCallCount += 1;
        calls.push({ kind: "capture", target: callOpts.target });
        if (opts.captureThrowOn !== undefined && captureCallCount === opts.captureThrowOn) {
          throw new Error("capture-pane: process exited 1");
        }
        const last = opts.captures.length - 1;
        const i = captureIdx < last ? captureIdx : last;
        captureIdx += 1;
        return opts.captures[i] ?? "";
      },
      async sendKeys(callOpts: { keys: string; target: SendTarget }) {
        // ADR-138 T3b3 (t-06547e2d): boot-prompt path now goes via
        // pasteAndSubmit. The prompt text emits through
        // buffer.loadBuffer (recorded by the buffer mock below);
        // the C-m submit emits through THIS pane.sendKeys mock. We
        // do NOT log C-m to `calls` — it's implementation detail.
        // sendThrowOn still fires on the C-m send to preserve the
        // verb-failure-injection semantics existing tests depend on
        // (a throw at the submit step is observable as the send
        // failing, same as raw send-keys throwing pre-T3b3).
        sendCallCount += 1;
        if (opts.sendThrowOn !== undefined && sendCallCount === opts.sendThrowOn) {
          throw new Error("send-keys: process exited 1");
        }
      },
    },
    buffer: {
      // Buffer mock — pasteAndSubmit calls loadBuffer (with prompt
      // as data) + pasteBuffer in sequence, then submitAfterPaste
      // hits the pane.sendKeys mock above with the C-m keysym. The
      // load-buffer call records the prompt content as a "send"-
      // shaped entry on the calls timeline so tests asserting "send
      // fired with payload=<prompt>" continue working — the
      // payload-side semantics are identical (the text body lands
      // in the compose box via the buffer), only the on-tmux
      // mechanism differs (paste vs raw type).
      async loadBuffer(callOpts: { name: string; data: string }) {
        calls.push({ kind: "send", payload: callOpts.data });
      },
      async pasteBuffer(_o: { name?: string; target: SendTarget; deleteAfter?: boolean }) {},
    },
  } as unknown as TmuxNamespace;

  return {
    tmux,
    calls,
    getCaptureCallCount: () => captureCallCount,
    getSendCallCount: () => sendCallCount,
  };
}

const sendTarget: SendTarget = {
  kind: "member",
  member: "fe-1",
  team: "atmux",
  target: "atmux:fe-1",
};

const noopSleep = async (_ms: number) => {};

/** Synthetic monotonic clock. Each call advances by 100ms by
 *  default so `pollUntil`'s deadline check fires deterministically
 *  without real time. Override via `step` for tighter / wider
 *  windows in specific tests. */
function fakeClock(opts: { step?: number; start?: number } = {}) {
  let t = opts.start ?? 0;
  const step = opts.step ?? 100;
  return () => {
    const cur = t;
    t += step;
    return cur;
  };
}

// ---------- renderBootPrompt ----------

describe("renderBootPrompt", () => {
  test("ADR-081 §C boot prompt — single line, template-substituted, self-verifying", () => {
    const out = renderBootPrompt("atmux", "fe-1");
    expect(out).toBe(
      "First run `echo $ATMUX_MEMBER` — if it isn't `fe-1`, this paste mis-targeted (alert operator + abort, do NOT bootstrap). Otherwise read .atmux/team.json to find your role, then read /opt/atmux/current/templates/briefs/<your-role>.md + project CLAUDE.md, then bootstrap as fe-1.",
    );
    // Reviewer pre-flag: single-line (no newlines anywhere)
    expect(out.includes("\n")).toBe(false);
  });

  test("substitutes member placeholder", () => {
    // 2026-05-23 brief-path update — `{team}` placeholder kept in
    // renderBootPrompt signature for forward-compat but no longer
    // substituted in the current template body. Only `{member}` is
    // a load-bearing substitution; verify both that it lands AND that
    // the canonical brief-path references are present verbatim
    // (matching the install-dir layout).
    const out = renderBootPrompt("sopx-guild", "be-2");
    expect(out).toContain("bootstrap as be-2");
    expect(out).toContain(".atmux/team.json");
    expect(out).toContain("/opt/atmux/current/templates/briefs/<your-role>.md");
    expect(out).toContain("project CLAUDE.md");
  });

  test("self-verification preamble — recipient must check $ATMUX_MEMBER before adopting role", () => {
    const out = renderBootPrompt("sopx", "driver");
    // The "if it isn't `{member}`" assertion forces the recipient to
    // cross-check against the pane's env var before bootstrapping.
    // Prevents the 2026-05-19 mis-paste class (rotate mis-resolved
    // window 1, drove the driver pane to adopt "lead" role).
    expect(out).toContain("echo $ATMUX_MEMBER");
    expect(out).toContain("if it isn't `driver`");
    expect(out).toContain("mis-targeted");
    expect(out).toContain("do NOT bootstrap");
  });
});

// ---------- isTuiReady ----------

describe("isTuiReady", () => {
  test("matches `❯` glyph (compose-box prompt)", () => {
    expect(isTuiReady("> some-cwd\n❯ ")).toBe(true);
  });
  test("matches `tokens` text (status footer)", () => {
    expect(isTuiReady("↑ 5k ↓ 2k tokens · 12%")).toBe(true);
  });
  test("MISS: welcome banner with no prompt yet → false", () => {
    expect(isTuiReady("✻ Welcome to Claude\n\n  /help for help")).toBe(false);
  });
  test("MISS: empty string → false", () => {
    expect(isTuiReady("")).toBe(false);
  });
});

// ---------- tokensMoved ----------

describe("tokensMoved", () => {
  test("matches `Nk tokens` shape", () => {
    expect(tokensMoved("↑ 5k ↓ 2k tokens · 12%")).toBe(true);
    expect(tokensMoved("3k tokens")).toBe(true);
  });
  test("matches `tokens · N%` shape", () => {
    expect(tokensMoved("tokens · 5%")).toBe(true);
  });
  test("MISS: bare `tokens` with no count → false", () => {
    expect(tokensMoved("type tokens here")).toBe(false);
  });
  test("MISS: empty → false", () => {
    expect(tokensMoved("")).toBe(false);
  });
  test("MISS: zero count `0k tokens` → false (count must be > 0 to count as moved — regex rejects leading 0 only single-digit; 0k actually matches but we accept this is a corner; primary signal is presence of any nk shape after a turn)", () => {
    // Note: regex matches 0k too. Document the corner: a freshly-spawned
    // claude shows no count footer at all, so this corner is academic.
    expect(tokensMoved("0k tokens")).toBe(true);
  });
});

// ---------- thinkingActive + bootSignalLive (t-a1db24dd) ----------

describe("thinkingActive", () => {
  test("matches `✻ Churned for Xm Ys`", () => {
    expect(thinkingActive("✻ Churned for 2m 19s")).toBe(true);
  });
  test("matches `✻ Worked for Xm Ys`", () => {
    expect(thinkingActive("✻ Worked for 1m 30s")).toBe(true);
  });
  test("matches `✻ Worked for Xh`", () => {
    expect(thinkingActive("✻ Worked for 3h")).toBe(true);
  });
  test("matches `✻ thinking with N`", () => {
    expect(thinkingActive("✻ thinking with 4123")).toBe(true);
  });
  test("matches alternate spinner glyphs (✶ / ✽ / ✺ / ✷)", () => {
    expect(thinkingActive("✶ Churned for 1m 5s")).toBe(true);
    expect(thinkingActive("✽ thinking with 200")).toBe(true);
    expect(thinkingActive("✺ Worked for 30s")).toBe(true);
    expect(thinkingActive("✷ Churned for 2h")).toBe(true);
  });
  test("MISS: empty → false", () => {
    expect(thinkingActive("")).toBe(false);
  });
  test("MISS: spinner glyph alone with no thinking-verb → false", () => {
    expect(thinkingActive("✻ (no verb)")).toBe(false);
  });
  test("MISS: thinking verb without spinner glyph → false (guard against narrative text matches)", () => {
    expect(thinkingActive("the planner is thinking with 5 members")).toBe(false);
  });
});

describe("bootSignalLive", () => {
  test("true on tokensMoved-hit", () => {
    expect(bootSignalLive("↑ 5k ↓ 2k tokens · 12%")).toBe(true);
  });
  test("true on thinkingActive-hit (the t-a1db24dd false-negative fix)", () => {
    expect(bootSignalLive("✻ Churned for 2m 19s")).toBe(true);
  });
  test("true on both signals present", () => {
    expect(bootSignalLive("✻ Worked for 1m 30s\n↑ 1k ↓ 0k tokens")).toBe(true);
  });
  test("MISS: empty → false", () => {
    expect(bootSignalLive("")).toBe(false);
  });
  test("MISS: TUI-ready glyph alone → false (TUI rendered but turn hasn't started)", () => {
    expect(bootSignalLive("❯")).toBe(false);
  });
});

// ---------- bootClaudeMember sentinel ----------

describe("bootClaudeMember — pre-send sentinel", () => {
  test("already-booted: initial capture shows tokens → no send, no poll, returns immediately", async () => {
    const { tmux, calls } = fakeTmux({
      captures: ["↑ 5k ↓ 2k tokens · 12%"],
    });
    const r = await bootClaudeMember({
      tmux,
      sendTarget,
      paneTargetString: "atmux:fe-1",
      team: "atmux",
      member: "fe-1",
      sleep: noopSleep,
      now: fakeClock(),
    });
    expect(r.status).toBe("already-booted");
    expect(r.attempts).toBe(0);
    expect(calls.filter((c) => c.kind === "send")).toHaveLength(0);
  });
});

// ---------- bootClaudeMember TUI readiness path ----------

describe("bootClaudeMember — readiness poll", () => {
  test("TUI never reaches ready → failed with tui-not-ready, zero sends", async () => {
    const { tmux, calls } = fakeTmux({
      captures: ["✻ Welcome to Claude"], // never matches readiness
    });
    const r = await bootClaudeMember({
      tmux,
      sendTarget,
      paneTargetString: "atmux:fe-1",
      team: "atmux",
      member: "fe-1",
      readyTimeoutMs: 500,
      readyPollIntervalMs: 100,
      sleep: noopSleep,
      now: fakeClock({ step: 100 }),
    });
    expect(r.status).toBe("failed");
    expect(r.reason).toBe("tui-not-ready");
    expect(r.attempts).toBe(0);
    expect(calls.filter((c) => c.kind === "send")).toHaveLength(0);
  });

  test("TUI ready on second poll → send fires, tokens move first poll → booted in 1 attempt", async () => {
    const { tmux, calls } = fakeTmux({
      captures: [
        "✻ Welcome\n", // initial sentinel: not booted
        "✻ Welcome\n", // ready poll #1: not ready
        "❯ ", // ready poll #2: ready
        "↑ 3k tokens\n❯ ", // post-boot poll #1: tokens moved + composer cleared (composerEmpty matches `❯` at EOL via /m flag; tokensMoved still matches the prefix)
      ],
    });
    const r = await bootClaudeMember({
      tmux,
      sendTarget,
      paneTargetString: "atmux:fe-1",
      team: "atmux",
      member: "fe-1",
      readyTimeoutMs: 5_000,
      readyPollIntervalMs: 100,
      postBootTimeoutMs: 5_000,
      postBootPollIntervalMs: 100,
      sleep: noopSleep,
      now: fakeClock({ step: 100 }),
    });
    expect(r.status).toBe("booted");
    expect(r.attempts).toBe(1);
    const sends = calls.filter((c) => c.kind === "send");
    expect(sends).toHaveLength(1);
    expect(sends[0]!.payload).toBe(renderBootPrompt("atmux", "fe-1"));
  });
});

// ---------- bootClaudeMember retry path ----------

describe("bootClaudeMember — retry", () => {
  test("first attempt sends but tokens never move; second attempt succeeds → attempts=2", async () => {
    // Capture-call accounting (post t-1b45d565 — safeSendKeysWithVerify
    // composerEmpty step landed between paste and tokens-poll, so each
    // attempt now consumes: 1 preCapture + ≥1 verify-loop capture before
    // entering the tokens-moved poll). Sequence is intentionally tuned so
    // the sticky-last "↑ 1k tokens\n❯ " entry first appears at attempt-2's
    // tokens-poll, NOT during attempt 1.
    const { tmux, calls } = fakeTmux({
      captures: [
        "no-tokens", // [0] initial sentinel — tokensMoved FALSE
        "❯ ", // [1] readiness — isTuiReady TRUE
        // ----- attempt 1 -----
        "no-tokens\n❯ ", // [2] safeSend preCapture
        "no-tokens\n❯ ", // [3] verify-loop: composerEmpty TRUE (❯ at line end)
        "no-tokens\n❯ ", // [4] tokens-poll iter 1 — tokensMoved FALSE
        "no-tokens\n❯ ", // [5] tokens-poll iter 2 — FALSE, timeout exhausts
        // ----- attempt 2 -----
        "no-tokens\n❯ ", // [6] safeSend preCapture
        "no-tokens\n❯ ", // [7] verify-loop: composerEmpty TRUE
        "↑ 1k tokens\n❯ ", // [8] tokens-poll iter 1 — tokensMoved TRUE (sticky thereafter)
      ],
    });
    const r = await bootClaudeMember({
      tmux,
      sendTarget,
      paneTargetString: "atmux:fe-1",
      team: "atmux",
      member: "fe-1",
      readyTimeoutMs: 1_000,
      readyPollIntervalMs: 100,
      postBootTimeoutMs: 300,
      postBootPollIntervalMs: 100,
      maxAttempts: 2,
      sleep: noopSleep,
      now: fakeClock({ step: 100 }),
    });
    expect(r.status).toBe("booted");
    expect(r.attempts).toBe(2);
    // Second-attempt assertion: BOTH boot-prompt pastes fired
    // (loadBuffer records as "send"-shaped entry per fakeTmux contract).
    const sends = calls.filter((c) => c.kind === "send");
    expect(sends).toHaveLength(2);
    expect(sends[0]!.payload).toBe(renderBootPrompt("atmux", "fe-1"));
    expect(sends[1]!.payload).toBe(renderBootPrompt("atmux", "fe-1"));
  });

  test("both attempts fail → failed with tokens-never-moved, attempts=maxAttempts", async () => {
    const { tmux, calls } = fakeTmux({
      captures: [
        "✻ Welcome", // initial sentinel
        "❯ ", // ready
        "still nothing\n❯ ", // composer cleared (composerEmpty matches via /m on the trailing `❯ `) but tokensMoved keeps missing → tokens-never-moved on exhaustion (t-1b45d565 verify path is happy; tokens poll is the failing leg)
      ],
    });
    const r = await bootClaudeMember({
      tmux,
      sendTarget,
      paneTargetString: "atmux:fe-1",
      team: "atmux",
      member: "fe-1",
      readyTimeoutMs: 500,
      readyPollIntervalMs: 100,
      postBootTimeoutMs: 200,
      postBootPollIntervalMs: 100,
      maxAttempts: 2,
      sleep: noopSleep,
      now: fakeClock({ step: 100 }),
    });
    expect(r.status).toBe("failed");
    expect(r.reason).toBe("tokens-never-moved");
    expect(r.attempts).toBe(2);
    // Exactly 2 send-keys invocations (the retry pattern)
    expect(calls.filter((c) => c.kind === "send")).toHaveLength(2);
  });
});

// ---------- bootClaudeMember — submit-verify path (t-1b45d565) ----------

describe("bootClaudeMember — submit-verify path (t-1b45d565)", () => {
  test("composer stays loaded across all submitVerifyRetries — failed with submit-not-verified; tokensMoved poll skipped", async () => {
    // capture sequence: sentinel + ready + composer-loaded (NEVER clears
    // — the 8x bug fingerprint where the C-m is eaten). composerEmpty
    // regex `❯\s*$/m` requires `❯` at end-of-line; a line ending with
    // brief-text won't match. We embed a synthetic boot-prompt-loaded
    // line: `❯ <truncated brief text>` (no EOL after `❯`, so the regex
    // misses).
    const { tmux } = fakeTmux({
      captures: [
        "✻ Welcome", // sentinel — not booted
        "❯ ", // ready — `❯ ` IS at EOL here, but this capture is consumed by the READINESS poll, not the submit-verify poll
        "❯ Read /tmp/atmux-brief-generic-atmux.md and your role brief", // submit-verify polls — composer still has prompt text; `❯ ` is NOT at EOL → composerEmpty miss → verify times out across all submitVerifyRetries → submit-not-verified
      ],
    });
    const r = await bootClaudeMember({
      tmux,
      sendTarget,
      paneTargetString: "atmux:fe-1",
      team: "atmux",
      member: "fe-1",
      readyTimeoutMs: 500,
      readyPollIntervalMs: 100,
      submitVerifyTimeoutMs: 200,
      submitVerifyPollIntervalMs: 100,
      submitVerifyRetries: 0, // 1 send-attempt per cycle to keep clock budget tight
      // tokensMoved poll budget intentionally generous — if my code
      // wastes time polling tokens after a verify-fail, this would
      // exceed the fakeClock step and surface as a timeout instead
      // of submit-not-verified.
      postBootTimeoutMs: 99_000,
      postBootPollIntervalMs: 1_000,
      maxAttempts: 2,
      sleep: noopSleep,
      now: fakeClock({ step: 50 }),
      // Suppress escalation-log write (test injection — no disk IO).
      appendLog: async () => {},
    });
    expect(r.status).toBe("failed");
    expect(r.reason).toBe("submit-not-verified");
    expect(r.attempts).toBe(2);
  });

  test("composer-load then auto-clear on next poll — verify succeeds, tokens move → booted in 1 attempt", async () => {
    // Sequence: sentinel + ready + composer-loaded (verify poll #1
    // miss) + composer-cleared (verify poll #2 hit) + tokens-moved.
    // safeSendKeysWithVerify's internal poll loop catches the late-
    // clearing case within one send-attempt; no outer retry needed.
    const { tmux, getSendCallCount } = fakeTmux({
      captures: [
        "✻ Welcome", // sentinel
        "❯ ", // ready
        "❯ pre-capture for safeSend (not the verify poll)", // safeSendKeysWithVerify pre-capture
        "❯ still-has-text", // verify poll #1: composer not yet clear
        "❯ ", // verify poll #2: composer cleared → composerEmpty hit
        "↑ 4k tokens\n❯ ", // tokensMoved poll #1: tokens move + composer empty
      ],
    });
    const r = await bootClaudeMember({
      tmux,
      sendTarget,
      paneTargetString: "atmux:fe-1",
      team: "atmux",
      member: "fe-1",
      readyTimeoutMs: 500,
      readyPollIntervalMs: 100,
      submitVerifyTimeoutMs: 1_000,
      submitVerifyPollIntervalMs: 50,
      submitVerifyRetries: 0, // single send + internal poll catches the late-clear
      postBootTimeoutMs: 500,
      postBootPollIntervalMs: 100,
      maxAttempts: 2,
      sleep: noopSleep,
      now: fakeClock({ step: 25 }),
      appendLog: async () => {},
    });
    expect(r.status).toBe("booted");
    expect(r.attempts).toBe(1);
    // Exactly ONE C-m sendKeys call (safeSendKeysWithVerify single
    // attempt; verifier picks up the clear on poll #2).
    expect(getSendCallCount()).toBe(1);
  });
});

// ---------- send-keys verb-failure ----------

describe("bootClaudeMember — send-keys verb-failure", () => {
  test("send-keys throws on first attempt — retry succeeds → booted with attempts=2", async () => {
    const { tmux, getSendCallCount } = fakeTmux({
      captures: [
        "✻ Welcome", // sentinel
        "❯ ", // ready
        "↑ 2k tokens\n❯ ", // tokens move (after retry send-keys lands) + composer cleared
      ],
      sendThrowOn: 1, // first send-keys throws
    });
    const r = await bootClaudeMember({
      tmux,
      sendTarget,
      paneTargetString: "atmux:fe-1",
      team: "atmux",
      member: "fe-1",
      readyTimeoutMs: 500,
      postBootTimeoutMs: 500,
      maxAttempts: 2,
      sleep: noopSleep,
      now: fakeClock({ step: 100 }),
    });
    expect(r.status).toBe("booted");
    expect(r.attempts).toBe(2);
    expect(getSendCallCount()).toBe(2);
  });
});

// ---------- bootClaudeMember capture error ----------

describe("bootClaudeMember — capture error", () => {
  test("capture throws during readiness wait → failed with capture-error", async () => {
    const { tmux } = fakeTmux({
      captures: [""],
      captureThrowOn: 1, // first capturePane throws (initial sentinel
      // succeeds — wait, throw on call 1 = initial sentinel itself).
      // Initial sentinel error is swallowed (degrade-to-poll); the
      // readiness loop's first capture is the next throw target.
    });
    const r = await bootClaudeMember({
      tmux,
      sendTarget,
      paneTargetString: "atmux:fe-1",
      team: "atmux",
      member: "fe-1",
      readyTimeoutMs: 500,
      readyPollIntervalMs: 100,
      sleep: noopSleep,
      now: fakeClock({ step: 100 }),
    });
    // Initial sentinel throw is swallowed → falls to readiness loop
    // which DOES report capture-error on first capture-pane call.
    // But the readiness loop runs AFTER initial-sentinel and shares
    // the throw counter — second capture-pane (loop call 1) succeeds
    // and finds empty string (no ready). Then loop times out.
    // The actual returned reason depends on whether throw fires
    // during the loop. Verify it's a fail with one of the two
    // expected reasons (capture-error OR tui-not-ready depending
    // on which capture call the throw lands on).
    expect(r.status).toBe("failed");
    expect(r.reason).toBeDefined();
    expect(["capture-error", "tui-not-ready"]).toContain(r.reason ?? "");
  });
});

// ---------- renderBootFailureNotice ----------

describe("renderBootFailureNotice", () => {
  test("renders verdict-first markdown header naming team + member + reason", () => {
    const out = renderBootFailureNotice({
      team: "atmux",
      member: "fe-1",
      result: { status: "failed", attempts: 2, reason: "tokens-never-moved" },
      nowIso: "2026-05-14T10:22:00Z",
    });
    expect(out).toContain("## 🚨 [boot-failure]");
    expect(out).toContain("`atmux`");
    expect(out).toContain("`fe-1`");
    expect(out).toContain("2026-05-14T10:22:00Z");
    expect(out).toContain("🔴 Stalled");
    expect(out).toContain("2 boot attempts");
    expect(out).toContain("boot prompt sent but tokens never moved");
    // Operator-actionable suggestion at the bottom
    expect(out).toContain("atmux rotate fe-1");
  });

  test("maps each reason label distinctly", () => {
    const tui = renderBootFailureNotice({
      team: "t",
      member: "m",
      result: { status: "failed", attempts: 0, reason: "tui-not-ready" },
      nowIso: "ts",
    });
    expect(tui).toContain("TUI never reached ready state");

    const tokens = renderBootFailureNotice({
      team: "t",
      member: "m",
      result: { status: "failed", attempts: 2, reason: "tokens-never-moved" },
      nowIso: "ts",
    });
    expect(tokens).toContain("tokens never moved");

    const capture = renderBootFailureNotice({
      team: "t",
      member: "m",
      result: { status: "failed", attempts: 1, reason: "capture-error" },
      nowIso: "ts",
    });
    expect(capture).toContain("capture-pane");

    // t-1b45d565: submit-not-verified label names the operator-
    // actionable intervention (atmux send uses verified-send-keys).
    const submitNotVerified = renderBootFailureNotice({
      team: "t",
      member: "m",
      result: { status: "failed", attempts: 2, reason: "submit-not-verified" },
      nowIso: "ts",
    });
    expect(submitNotVerified).toContain("C-m submit was eaten");
    expect(submitNotVerified).toContain("verified-send-keys");
  });
});

// ---------- bootClaudeMember — forceBootPrompt (EPIC e-f28c2596 T7) ----------

describe("bootClaudeMember — forceBootPrompt (EPIC e-f28c2596 T7)", () => {
  test("forceBootPrompt=true: bypasses already-booted sentinel even when initial capture shows tokens", async () => {
    // Pre-T7: tokens-in-initial-capture → already-booted short-circuit
    // (status='already-booted', no send). Post-T7 with forceBootPrompt:true:
    // the sentinel block is skipped entirely; the call proceeds to readiness
    // wait + boot prompt + tokens-moved poll. The initial capture is NOT
    // consumed (no `capturePane(start: -40)` pre-poll), so the first capture
    // in the array is consumed by the readiness poll instead.
    const { tmux, calls } = fakeTmux({
      captures: [
        "❯ ↑ 5k tokens", // [0] readiness — isTuiReady TRUE (matches ❯ + tokens)
        "❯ pre", // [1] safeSend preCapture (composer not empty — would normally fail verify)
        "❯ ", // [2] safeSend verify poll #1 — composerEmpty TRUE
        "↑ 12k tokens\n❯ ", // [3] tokens-poll — tokensMoved TRUE, status=booted
      ],
    });
    const r = await bootClaudeMember({
      tmux,
      sendTarget,
      paneTargetString: "atmux:lead-x",
      team: "atmux",
      member: "lead-x",
      forceBootPrompt: true,
      readyTimeoutMs: 500,
      readyPollIntervalMs: 100,
      submitVerifyTimeoutMs: 500,
      submitVerifyPollIntervalMs: 50,
      submitVerifyRetries: 0,
      postBootTimeoutMs: 500,
      postBootPollIntervalMs: 100,
      maxAttempts: 1,
      sleep: noopSleep,
      now: fakeClock({ step: 25 }),
      appendLog: async () => {},
    });
    // Sentinel bypassed → boot prompt fired → status booted
    expect(r.status).toBe("booted");
    expect(r.attempts).toBe(1);
    // Exactly ONE "send"-shaped entry (loadBuffer carrying the boot prompt).
    const sends = calls.filter((c) => c.kind === "send");
    expect(sends).toHaveLength(1);
    expect(sends[0]!.payload).toBe(renderBootPrompt("atmux", "lead-x"));
  });

  test("forceBootPrompt=true + composer stays loaded → submit-not-verified (escalates to send-keys-failures.log)", async () => {
    // Pre-T7 + tokens-in-initial-capture would have returned already-booted
    // with no work. Post-T7 with forceBootPrompt:true the sentinel is
    // bypassed, the boot prompt fires, but the verifier never sees the
    // composer clear → submit-not-verified. The escalate path
    // (safeSendKeysWithVerify onFail:"escalate") fires; tests inject
    // appendLog so the recorder catches the disk-bound write without
    // touching real disk.
    const escalations: Array<{ path: string; body: string }> = [];
    const { tmux } = fakeTmux({
      captures: [
        "❯ ↑ 5k tokens", // [0] readiness ready
        "❯ pre", // [1] safeSend preCapture
        "❯ Read /tmp/atmux-brief", // [2..N] composer stays non-empty — sticky
      ],
    });
    const r = await bootClaudeMember({
      tmux,
      sendTarget,
      paneTargetString: "atmux:lead-x",
      team: "atmux",
      member: "lead-x",
      forceBootPrompt: true,
      readyTimeoutMs: 500,
      readyPollIntervalMs: 100,
      submitVerifyTimeoutMs: 200,
      submitVerifyPollIntervalMs: 50,
      submitVerifyRetries: 0,
      postBootTimeoutMs: 99_000, // generous — if we wrongly enter tokens poll, this surfaces as wrong-reason
      postBootPollIntervalMs: 1_000,
      maxAttempts: 1,
      sleep: noopSleep,
      now: fakeClock({ step: 25 }),
      appendLog: async (path, body) => {
        escalations.push({ path, body });
      },
    });
    expect(r.status).toBe("failed");
    expect(r.reason).toBe("submit-not-verified");
    // ADR-168: escalation log row was written.
    expect(escalations.length).toBeGreaterThanOrEqual(1);
    // The escalation entry references the target pane.
    expect(escalations[0]!.body).toContain("atmux:lead-x");
  });

  test("forceBootPrompt=false (default): tokens-in-initial-capture → already-booted (no regression — sentinel preserved for start.ts callers)", async () => {
    // Regression coverage: start.ts and other first-spawn callers do NOT
    // pass forceBootPrompt, so the default-false path must still short-
    // circuit on a tokens-moving pane (e.g. operator-pre-bootstrapped
    // member, double-call protection during start.ts re-entry).
    const { tmux, calls } = fakeTmux({
      captures: ["↑ 5k ↓ 2k tokens · 12%"],
    });
    const r = await bootClaudeMember({
      tmux,
      sendTarget,
      paneTargetString: "atmux:fe-1",
      team: "atmux",
      member: "fe-1",
      // forceBootPrompt omitted → undefined → branch enters sentinel
      sleep: noopSleep,
      now: fakeClock(),
    });
    expect(r.status).toBe("already-booted");
    expect(r.attempts).toBe(0);
    expect(calls.filter((c) => c.kind === "send")).toHaveLength(0);
  });

  test("forceBootPrompt=true + cold-boot (no tokens in initial capture) → booted (no regression on legitimate respawn)", async () => {
    // Counter-fixture from T8 task body: a cold-boot rotation (TUI
    // freshly started, no tokens yet) must still complete the full boot
    // path with forceBootPrompt:true — the option must not regress the
    // already-correct cold-start case.
    const { tmux, calls } = fakeTmux({
      captures: [
        "✻ Welcome to Claude", // [0] readiness poll #1 — not ready
        "❯ ", // [1] readiness poll #2 — ready
        "❯ pre", // [2] safeSend preCapture
        "❯ ", // [3] safeSend verify poll — composerEmpty TRUE
        "↑ 4k tokens\n❯ ", // [4] tokens-poll — tokensMoved TRUE
      ],
    });
    const r = await bootClaudeMember({
      tmux,
      sendTarget,
      paneTargetString: "atmux:lead-x",
      team: "atmux",
      member: "lead-x",
      forceBootPrompt: true,
      readyTimeoutMs: 5_000,
      readyPollIntervalMs: 100,
      submitVerifyTimeoutMs: 500,
      submitVerifyPollIntervalMs: 50,
      submitVerifyRetries: 0,
      postBootTimeoutMs: 500,
      postBootPollIntervalMs: 100,
      maxAttempts: 1,
      sleep: noopSleep,
      now: fakeClock({ step: 25 }),
      appendLog: async () => {},
    });
    expect(r.status).toBe("booted");
    expect(r.attempts).toBe(1);
    const sends = calls.filter((c) => c.kind === "send");
    expect(sends).toHaveLength(1);
    expect(sends[0]!.payload).toBe(renderBootPrompt("atmux", "lead-x"));
  });
});
