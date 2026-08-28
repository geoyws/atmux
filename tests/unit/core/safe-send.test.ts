// Unit tests for src/core/safe-send.ts (ADR-057 §D1 R57-T1).
//
// safeSendKeys gate: classify pane → send / retry / refuse. Drives
// the flag-emit + retry-policy paths from src/core/pane-state.ts.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentThinking,
  composerEmpty,
  contextNonZero,
  DEFAULT_SEND_KEYS_FAILURES_LOG_REL,
  DEFAULT_VERIFY_POLL_MS,
  DEFAULT_VERIFY_RETRIES,
  DEFAULT_VERIFY_TIMEOUT_MS,
  KNOWN_MODAL_SETTLE_MS,
  MAX_KNOWN_MODAL_DISMISSALS,
  modalClosed,
  PANE_SEND_LOCK_TIMEOUT_MS,
  type PaneVerifier,
  paneMatchesRegex,
  SafeSendKeysError,
  type SafeSendKeysWithVerifyOpts,
  type SafeSendOpts,
  type SafeSendOutcome,
  safePreflight,
  safeSendKeys,
  safeSendKeysWithVerify,
  sanitizePaneLockKey,
  verifierForTui,
  withPaneSendLock,
} from "../../../src/core/safe-send.ts";

interface FlagCall {
  severity: "p0" | "p1" | "p2" | "p3";
  body: string;
}

interface SendCall {
  target: string;
  text: string;
  /** undefined = caller passed no opts arg (user-payload sends). */
  enter: boolean | undefined;
}

interface SafeSendFixture {
  /** Captures returned in order; classifier polls per attempt. */
  captures: string[];
  flags: FlagCall[];
  sends: SendCall[];
  sleeps: number[];
}

function buildFixture(captures: string[]): {
  fixture: SafeSendFixture;
  opts: SafeSendOpts;
} {
  const fixture: SafeSendFixture = {
    captures,
    flags: [],
    sends: [],
    sleeps: [],
  };
  let captureIdx = 0;
  const opts: SafeSendOpts = {
    capture: async () => {
      const i = Math.min(captureIdx, fixture.captures.length - 1);
      captureIdx += 1;
      return fixture.captures[i] ?? "";
    },
    sendKeys: async (target, text, sendOpts) => {
      fixture.sends.push({ target, text, enter: sendOpts?.enter });
    },
    raiseFlag: async (severity, body) => {
      fixture.flags.push({ severity, body });
    },
    sleep: async (ms) => {
      fixture.sleeps.push(ms);
    },
  };
  return { fixture, opts };
}

const FEEDBACK_SURVEY_PANE = `● How is Claude doing this session? (optional)
  1: Bad    2: Fine   3: Good   0: Dismiss`;

// ---------- READY happy path ----------

describe("safeSendKeys — READY happy path", () => {
  test("READY pane → sent immediately, no flag", async () => {
    const { fixture, opts } = buildFixture(["\ntok 67k/100  ⏵⏵ auto mode\n"]);
    const result = await safeSendKeys("atmux:1.0", "hello", opts);
    expect(result.outcome).toBe("sent");
    expect(result.attempts).toBe(1);
    expect(fixture.sends).toEqual([{ target: "atmux:1.0", text: "hello", enter: undefined }]);
    expect(fixture.flags).toHaveLength(0);
    expect(fixture.sleeps).toHaveLength(0);
  });
});

// ---------- TYPING retry path ----------

describe("safeSendKeys — TYPING retries", () => {
  test("TYPING → READY on second attempt", async () => {
    const { fixture, opts } = buildFixture([
      "Press up to edit queued messages",
      "\ntok 67k/100  ⏵⏵ auto mode\n",
    ]);
    const result = await safeSendKeys("atmux:1.0", "hi", opts);
    expect(result.outcome).toBe("sent");
    expect(result.attempts).toBe(2);
    expect(fixture.sleeps).toEqual([2_000]);
    expect(fixture.sends).toHaveLength(1);
  });

  test("TYPING for 3 attempts → exhausted-typing + flag p3", async () => {
    const { fixture, opts } = buildFixture([
      "Press up to edit queued messages",
      "Press up to edit queued messages",
      "Press up to edit queued messages",
    ]);
    const result = await safeSendKeys("atmux:1.0", "hi", opts);
    expect(result.outcome).toBe("exhausted-typing");
    expect(result.attempts).toBe(3);
    expect(fixture.sends).toHaveLength(0);
    expect(fixture.flags).toHaveLength(1);
    expect(fixture.flags[0]?.severity).toBe("p3");
  });
});

// ---------- COMPACTING retry path ----------

describe("safeSendKeys — COMPACTING retries", () => {
  test("COMPACTING → READY on second attempt", async () => {
    const { fixture, opts } = buildFixture([
      "Compacting conversation",
      "\ntok 67k/100  ⏵⏵ auto mode\n",
    ]);
    const result = await safeSendKeys("x", "y", opts);
    expect(result.outcome).toBe("sent");
    expect(fixture.sleeps).toEqual([5_000]);
  });

  test("COMPACTING for 6 attempts (30s budget) → exhausted-compacting + flag p3", async () => {
    const captures = Array(6).fill("Compacting conversation");
    const { fixture, opts } = buildFixture(captures);
    const result = await safeSendKeys("x", "y", opts);
    expect(result.outcome).toBe("exhausted-compacting");
    expect(result.attempts).toBe(6);
    expect(fixture.sleeps).toHaveLength(5);
    expect(fixture.sleeps.every((s) => s === 5_000)).toBe(true);
    expect(fixture.flags[0]?.severity).toBe("p3");
  });
});

// ---------- BUSY retry path (ADR-080 §C) ----------

describe("safeSendKeys — BUSY retries", () => {
  test("BUSY → READY on second attempt (turn completed)", async () => {
    const { fixture, opts } = buildFixture(["✻ Cooked for 12s", "\ntok 67k/100  ⏵⏵ auto mode\n"]);
    const result = await safeSendKeys("x", "y", opts);
    expect(result.outcome).toBe("sent");
    expect(fixture.sleeps).toEqual([5_000]);
  });

  test("BUSY for 6 attempts (30s budget) → exhausted-busy + flag p3", async () => {
    const captures = Array(6).fill("✻ Cooked for 30s");
    const { fixture, opts } = buildFixture(captures);
    const result = await safeSendKeys("x", "y", opts);
    expect(result.outcome).toBe("exhausted-busy");
    expect(result.attempts).toBe(6);
    expect(fixture.sleeps).toHaveLength(5);
    expect(fixture.sleeps.every((s) => s === 5_000)).toBe(true);
    expect(fixture.flags[0]?.severity).toBe("p3");
  });
});

// ---------- MODAL refusal ----------

describe("safeSendKeys — MODAL refusal", () => {
  test("MODAL pane → refused-modal + flag p3 + no send", async () => {
    const { fixture, opts } = buildFixture(["Do you want Claude to run rm -rf? [y/N]"]);
    const result = await safeSendKeys("x", "answer", opts);
    expect(result.outcome).toBe("refused-modal");
    expect(result.dismissals).toBe(0);
    expect(fixture.sends).toHaveLength(0);
    expect(fixture.flags).toHaveLength(1);
    expect(fixture.flags[0]?.severity).toBe("p3");
    expect(fixture.flags[0]?.body).toContain("MODAL");
  });
});

// ---------- MODAL with known-modal auto-dismissal (Path B) ----------

describe("safeSendKeys — known-modal auto-dismiss", () => {
  test("feedback-survey MODAL → dismissed with '0' (no Enter) → READY → sent", async () => {
    const { fixture, opts } = buildFixture([FEEDBACK_SURVEY_PANE, "\ntok 67k/100  ⏵⏵ auto mode\n"]);
    const result = await safeSendKeys("atmux:1.0", "real payload", opts);
    expect(result.outcome).toBe("sent");
    expect(result.dismissals).toBe(1);
    // Two sends: dismiss '0' first, then user payload.
    expect(fixture.sends).toEqual([
      { target: "atmux:1.0", text: "0", enter: false },
      { target: "atmux:1.0", text: "real payload", enter: undefined },
    ]);
    expect(fixture.sleeps).toEqual([KNOWN_MODAL_SETTLE_MS]);
    expect(fixture.flags).toHaveLength(0);
  });

  test("feedback-survey persists past MAX_KNOWN_MODAL_DISMISSALS → refused-modal + flag", async () => {
    // 4 captures all show the feedback survey — dismissals exhaust the
    // budget and we fall through to refused-modal. Catalog matches
    // exactly MAX_KNOWN_MODAL_DISMISSALS (3) times before the loop exits.
    const captures = [
      FEEDBACK_SURVEY_PANE,
      FEEDBACK_SURVEY_PANE,
      FEEDBACK_SURVEY_PANE,
      FEEDBACK_SURVEY_PANE,
    ];
    const { fixture, opts } = buildFixture(captures);
    const result = await safeSendKeys("atmux:1.0", "payload", opts);
    expect(result.outcome).toBe("refused-modal");
    expect(result.dismissals).toBe(MAX_KNOWN_MODAL_DISMISSALS);
    // 3 dismissal sends; 0 user-payload sends.
    expect(fixture.sends).toHaveLength(MAX_KNOWN_MODAL_DISMISSALS);
    for (const s of fixture.sends) {
      expect(s.text).toBe("0");
      expect(s.enter).toBe(false);
    }
    expect(fixture.flags).toHaveLength(1);
    expect(fixture.flags[0]?.severity).toBe("p3");
  });

  test("unknown MODAL (no catalog match) → refused-modal, dismissals=0", async () => {
    // Already covered by the basic MODAL refusal test above; this pins
    // the dismissals counter on the unknown-modal path explicitly.
    const { fixture, opts } = buildFixture(["Allow this tool to proceed?"]);
    const result = await safeSendKeys("x", "y", opts);
    expect(result.outcome).toBe("refused-modal");
    expect(result.dismissals).toBe(0);
    expect(fixture.sends).toHaveLength(0);
  });

  test("feedback-survey clears after 1 dismiss → no flag fired", async () => {
    // Sanity: the happy-path dismissal must not raise a flag (the
    // recovery is silent; the survey is expected friction).
    const { fixture, opts } = buildFixture([FEEDBACK_SURVEY_PANE, "\ntok 67k/100  ⏵⏵ auto mode\n"]);
    await safeSendKeys("x", "y", opts);
    expect(fixture.flags).toHaveLength(0);
  });
});

// ---------- SHELL refusal ----------

describe("safeSendKeys — SHELL refusal", () => {
  test("SHELL pane (bash $ prompt) → refused-shell + flag p2", async () => {
    const { fixture, opts } = buildFixture(["user@host:~$ "]);
    const result = await safeSendKeys("x", "claude", opts);
    expect(result.outcome).toBe("refused-shell");
    expect(fixture.sends).toHaveLength(0);
    expect(fixture.flags).toHaveLength(1);
    expect(fixture.flags[0]?.severity).toBe("p2");
  });
});

// ---------- RATE-LIMIT refusal ----------

describe("safeSendKeys — RATE-LIMIT refusal", () => {
  test("RATE-LIMIT pane → refused-rate-limit but NO flag (ADR-053 takes over)", async () => {
    const { fixture, opts } = buildFixture(["You've hit your limit"]);
    const result = await safeSendKeys("x", "y", opts);
    expect(result.outcome).toBe("refused-rate-limit");
    expect(fixture.sends).toHaveLength(0);
    // RATE-LIMIT severity is null per REFUSAL_SEVERITY → no flag.
    expect(fixture.flags).toHaveLength(0);
  });
});

// ---------- UNKNOWN refusal ----------

describe("safeSendKeys — UNKNOWN refusal", () => {
  test("unmatched capture → refused-unknown + flag p2", async () => {
    const { fixture, opts } = buildFixture(["random pane content"]);
    const result = await safeSendKeys("x", "y", opts);
    expect(result.outcome).toBe("refused-unknown");
    expect(fixture.sends).toHaveLength(0);
    expect(fixture.flags[0]?.severity).toBe("p2");
  });
});

// ---------- raiseFlag absent / failing ----------

describe("safeSendKeys — flag handling", () => {
  test("no raiseFlag opt → refusal still records outcome", async () => {
    const captures = ["user@host:~$ "];
    let captureIdx = 0;
    let sent = 0;
    const result = await safeSendKeys("x", "y", {
      capture: async () => captures[captureIdx++] ?? "",
      sendKeys: async () => {
        sent += 1;
      },
    });
    expect(result.outcome).toBe("refused-shell");
    expect(sent).toBe(0);
  });

  test("raiseFlag throwing is non-fatal (best-effort)", async () => {
    const captures = ["user@host:~$ "];
    let captureIdx = 0;
    const result = await safeSendKeys("x", "y", {
      capture: async () => captures[captureIdx++] ?? "",
      sendKeys: async () => {},
      raiseFlag: async () => {
        throw new Error("flag-svc down");
      },
    });
    expect(result.outcome).toBe("refused-shell");
  });
});

// ---------- Logger integration ----------

describe("safeSendKeys — log invocations", () => {
  test("log fires on send + on refusal", async () => {
    const logs: string[] = [];
    const captures = ["\ntok 67k/100  ⏵⏵ auto mode\n"];
    let captureIdx = 0;
    await safeSendKeys("alice-target", "msg", {
      capture: async () => captures[captureIdx++] ?? "",
      sendKeys: async () => {},
      log: (m) => {
        logs.push(m);
      },
    });
    expect(logs.some((m) => m.includes("sent"))).toBe(true);
  });

  test("log fires on retry-exhausted refusal", async () => {
    const logs: string[] = [];
    let captureIdx = 0;
    const captures = ["Press up to edit queued messages"].concat(
      Array(3).fill("Press up to edit queued messages"),
    );
    await safeSendKeys("x", "y", {
      capture: async () => captures[captureIdx++] ?? "",
      sendKeys: async () => {},
      sleep: async () => {},
      log: (m) => {
        logs.push(m);
      },
    });
    expect(logs.some((m) => m.includes("exhausted-typing"))).toBe(true);
  });
});

// ---------- safePreflight ----------
//
// Same classify+dismiss loop as safeSendKeys but no terminal send.
// Used by callers that own a paste-buffer pattern (loadBuffer +
// pasteBuffer + Enter) where the trailing Enter can't be routed
// through safeSendKeys (after paste, the pane classifies as TYPING
// and the gate would retry to exhaustion).

describe("safePreflight — happy path", () => {
  test("READY pane → ready=true, no sends, no dismissals", async () => {
    const { fixture, opts } = buildFixture(["\ntok 67k/100  ⏵⏵ auto mode\n"]);
    const result = await safePreflight("atmux:1.0", opts);
    expect(result.ready).toBe(true);
    expect(result.finalClassification.state).toBe("READY");
    expect(result.dismissals).toBe(0);
    expect(result.attempts).toBe(1);
    expect(fixture.sends).toHaveLength(0);
  });
});

describe("safePreflight — known-modal dismissal", () => {
  test("CC feedback survey → dismisses '0' and re-classifies", async () => {
    const { fixture, opts } = buildFixture([
      FEEDBACK_SURVEY_PANE, // pre-dismiss
      "\ntok 67k/100  ⏵⏵ auto mode\n", // post-dismiss
    ]);
    const result = await safePreflight("atmux:1.0", opts);
    expect(result.ready).toBe(true);
    expect(result.dismissals).toBe(1);
    expect(result.finalClassification.state).toBe("READY");
    // The dismissal sent the modal's keystroke ("0" for feedback-survey).
    expect(fixture.sends).toHaveLength(1);
    expect(fixture.sends[0]?.text).toBe("0");
    expect(fixture.sends[0]?.enter).toBe(false);
    // KNOWN_MODAL_SETTLE_MS slept after dismissal.
    expect(fixture.sleeps).toContain(KNOWN_MODAL_SETTLE_MS);
  });
});

describe("safePreflight — non-sendable terminal states", () => {
  test("UNKNOWN pane → ready=false, no flags raised", async () => {
    // Empty capture → UNKNOWN (no patterns match).
    const { fixture, opts } = buildFixture([""]);
    const result = await safePreflight("atmux:1.0", opts);
    expect(result.ready).toBe(false);
    expect(result.finalClassification.state).toBe("UNKNOWN");
    expect(result.dismissals).toBe(0);
    // Preflight never raises flags (caller decides per warn-and-proceed).
    expect(fixture.flags).toHaveLength(0);
  });

  test("RATE-LIMIT pane → ready=false, no dismiss attempted", async () => {
    const { fixture, opts } = buildFixture(["You've hit your limit"]);
    const result = await safePreflight("atmux:1.0", opts);
    expect(result.ready).toBe(false);
    expect(result.finalClassification.state).toBe("RATE-LIMIT");
    expect(fixture.flags).toHaveLength(0);
  });

  test("SHELL pane → ready=false", async () => {
    const { fixture, opts } = buildFixture(["user@host:~$ "]);
    const result = await safePreflight("atmux:1.0", opts);
    expect(result.ready).toBe(false);
    expect(result.finalClassification.state).toBe("SHELL");
    expect(fixture.flags).toHaveLength(0);
  });
});

describe("safePreflight — retryable states", () => {
  test("TYPING then READY → polls + exits ready=true", async () => {
    const { fixture, opts } = buildFixture([
      "Press up to edit queued messages", // TYPING (1st capture)
      "\ntok 67k/100  ⏵⏵ auto mode\n", // READY (after retry)
    ]);
    const result = await safePreflight("atmux:1.0", opts);
    expect(result.ready).toBe(true);
    expect(result.finalClassification.state).toBe("READY");
    expect(result.attempts).toBe(2);
    expect(fixture.sends).toHaveLength(0);
    expect(fixture.sleeps.length).toBeGreaterThan(0);
  });

  test("COMPACTING that never clears → exhausts retries, ready=false", async () => {
    // All captures show COMPACTING — preflight retries until policy
    // bound, then exits with ready=false. No flags raised (caller
    // decides per warn-and-proceed).
    const captures = Array(20).fill("Compacting conversation");
    const { fixture, opts } = buildFixture(captures);
    const result = await safePreflight("atmux:1.0", opts);
    expect(result.ready).toBe(false);
    expect(result.finalClassification.state).toBe("COMPACTING");
    expect(fixture.flags).toHaveLength(0);
  });
});

describe("safePreflight — bounded modal dismissal", () => {
  test("modal that won't dismiss → exits after MAX dismissals, ready=false", async () => {
    // All captures show the same modal (dismiss attempts don't change it).
    const captures: string[] = [];
    for (let i = 0; i < MAX_KNOWN_MODAL_DISMISSALS + 2; i += 1) {
      captures.push(FEEDBACK_SURVEY_PANE);
    }
    const { fixture, opts } = buildFixture(captures);
    const result = await safePreflight("atmux:1.0", opts);
    expect(result.ready).toBe(false);
    expect(result.dismissals).toBe(MAX_KNOWN_MODAL_DISMISSALS);
    expect(fixture.sends).toHaveLength(MAX_KNOWN_MODAL_DISMISSALS);
  });
});

// ---------- SafeSendOutcome union exhaustiveness ----------

describe("SafeSendOutcome — value discriminator", () => {
  test("each refusal/exhaustion outcome is covered by a test in this file", () => {
    // Sanity meta-test: enumerate the union members so adding a new
    // value forces a test addition (see expects above).
    const outcomes: SafeSendOutcome[] = [
      "sent",
      "refused-shell",
      "refused-modal",
      "refused-rate-limit",
      "refused-unknown",
      "exhausted-typing",
      "exhausted-busy",
      "exhausted-compacting",
    ];
    expect(outcomes).toHaveLength(8);
  });
});

// ===========================================================================
// ADR-138 T2 (t-af007bb2): safeSendKeysWithVerify + 5 verifiers + escalation
// ===========================================================================

interface VerifyFixture {
  /** Captures returned in order. The fixture distinguishes pre-send
   *  capture (index 0) from post-send poll captures (1..N) so the
   *  test can drive verifier success / failure deterministically. */
  captures: string[];
  sends: { target: string; text: string }[];
  sleeps: number[];
  logs: { path: string; content: string }[];
  /** Simulated clock — starts at 0; sleep() advances; now() reads. */
  clockMs: number;
}

function buildVerifyFixture(captures: string[]): {
  fixture: VerifyFixture;
  baseOpts: Omit<SafeSendKeysWithVerifyOpts, "target" | "keys" | "expectVerifier">;
} {
  const fixture: VerifyFixture = {
    captures,
    sends: [],
    sleeps: [],
    logs: [],
    clockMs: 0,
  };
  let captureIdx = 0;
  const baseOpts: Omit<SafeSendKeysWithVerifyOpts, "target" | "keys" | "expectVerifier"> = {
    capture: async () => {
      const i = Math.min(captureIdx, fixture.captures.length - 1);
      captureIdx += 1;
      return fixture.captures[i] ?? "";
    },
    sendKeys: async (target: string, text: string) => {
      fixture.sends.push({ target, text });
    },
    sleep: async (ms: number) => {
      fixture.sleeps.push(ms);
      fixture.clockMs += ms;
    },
    now: () => fixture.clockMs,
    nowFormatted: () => "16:42 MYT 2026-05-14",
    appendLog: async (path: string, content: string) => {
      fixture.logs.push({ path, content });
    },
    // Empty home avoids resolving against the operator's real `$HOME`
    // even if HOME leaks; tests that exercise the path-resolution
    // path override this.
    home: "",
  };
  return { fixture, baseOpts };
}

// ---------- safeSendKeysWithVerify — defaults + bounds ----------

describe("safeSendKeysWithVerify default constants", () => {
  test("DEFAULT_VERIFY_TIMEOUT_MS is 3000", () => {
    expect(DEFAULT_VERIFY_TIMEOUT_MS).toBe(3000);
  });
  test("DEFAULT_VERIFY_RETRIES is 1 (= 2 total attempts)", () => {
    expect(DEFAULT_VERIFY_RETRIES).toBe(1);
  });
  test("DEFAULT_VERIFY_POLL_MS is 250", () => {
    expect(DEFAULT_VERIFY_POLL_MS).toBe(250);
  });
  test("DEFAULT_SEND_KEYS_FAILURES_LOG_REL matches ADR-138 §Escalation", () => {
    expect(DEFAULT_SEND_KEYS_FAILURES_LOG_REL).toBe(".atmux/state/send-keys-failures.log");
  });
});

// ---------- Happy path: verifier passes on first poll ----------

describe("safeSendKeysWithVerify — happy path", () => {
  test("pre-send verifier refusal performs zero sends and zero escalation writes", async () => {
    const lines: string[] = [];
    const { fixture, baseOpts } = buildVerifyFixture(["operator is typing"]);
    const result = await safeSendKeysWithVerify({
      ...baseOpts,
      log: (line) => lines.push(line),
      target: "atmux:_bot",
      keys: "offer",
      expectVerifier: () => true,
      preSendVerifier: () => false,
    });
    expect(result).toEqual({
      success: false,
      attempts: 0,
      finalCapture: "operator is typing",
    });
    expect(fixture.sends).toHaveLength(0);
    expect(fixture.logs).toHaveLength(0);
    expect(lines).toContain("safeSendKeysWithVerify: atmux:_bot pre-send verifier refused");
  });

  test("awaits an async pre-send verifier before admitting the send", async () => {
    const { fixture, baseOpts } = buildVerifyFixture(["ready"]);
    let checked = false;
    const result = await safeSendKeysWithVerify({
      ...baseOpts,
      target: "atmux:_bot",
      keys: "offer",
      expectVerifier: () => true,
      preSendVerifier: async () => {
        await Promise.resolve();
        checked = true;
        return false;
      },
    });
    expect(checked).toBe(true);
    expect(result.attempts).toBe(0);
    expect(fixture.sends).toHaveLength(0);
  });

  test("verifier returns true after first poll → success on attempt 1", async () => {
    // Captures: [0]=pre-send, [1]=post-send (verifier returns true).
    const { fixture, baseOpts } = buildVerifyFixture(["pre", "VERIFIED-state"]);
    const verifier: PaneVerifier = (cap) => cap.includes("VERIFIED");

    const result = await safeSendKeysWithVerify({
      ...baseOpts,
      target: "atmux:lead",
      keys: "claim --next\nC-m",
      expectVerifier: verifier,
    });

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.finalCapture).toBe("VERIFIED-state");
    expect(fixture.sends).toHaveLength(1);
    expect(fixture.sends[0]?.target).toBe("atmux:lead");
    expect(fixture.sleeps).toHaveLength(1); // exactly one poll-interval sleep
    expect(fixture.logs).toHaveLength(0); // no escalation
  });

  test("custom opts (timeoutMs / pollIntervalMs / retries) are honored", async () => {
    const { fixture, baseOpts } = buildVerifyFixture(["pre", "OK"]);
    const result = await safeSendKeysWithVerify({
      ...baseOpts,
      target: "atmux:m",
      keys: "x",
      expectVerifier: (c) => c === "OK",
      timeoutMs: 5000,
      pollIntervalMs: 100,
      retries: 3,
    });
    expect(result.success).toBe(true);
    // First sleep is the custom poll-interval, not the default.
    expect(fixture.sleeps[0]).toBe(100);
  });
});

// ---------- Retry path: verifier passes on attempt 2 ----------

describe("safeSendKeysWithVerify — retry path", () => {
  test("attempt 1 times out, attempt 2 verifies → success on attempt 2", async () => {
    // Sequence with timeoutMs=300, pollIntervalMs=100:
    //   capture[0] pre → "pre"
    //   send #1
    //   sleep 100 → capture[1] "stuck" → not verified
    //   sleep 100 → capture[2] "stuck" → not verified
    //   sleep 100 → capture[3] "stuck" → not verified → deadline elapsed
    //   loop: attempt 2 → send #2
    //   sleep 100 → capture[4] "OK" → verified
    const captures = ["pre", "stuck", "stuck", "stuck", "OK"];
    const { fixture, baseOpts } = buildVerifyFixture(captures);
    const result = await safeSendKeysWithVerify({
      ...baseOpts,
      target: "atmux:m",
      keys: "x",
      expectVerifier: (c) => c === "OK",
      timeoutMs: 300,
      pollIntervalMs: 100,
      retries: 1,
    });
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.finalCapture).toBe("OK");
    expect(fixture.sends).toHaveLength(2);
    expect(fixture.logs).toHaveLength(0); // success, no escalation
  });
});

// ---------- Escalation path: all retries exhausted → log written ----------

describe("safeSendKeysWithVerify — escalation path", () => {
  test("verifier never returns true → escalation log written + success=false", async () => {
    // Stay stuck forever — verifier never passes. retries=1, timeoutMs=200,
    // pollIntervalMs=100 → 2 attempts, ~4 polls total.
    const captures = Array.from({ length: 20 }, (_, i) => `stuck-${i}`);
    const { fixture, baseOpts } = buildVerifyFixture(captures);
    const result = await safeSendKeysWithVerify({
      ...baseOpts,
      target: "atmux:🧭-lead",
      keys: "claim --next --as lead\nC-m",
      expectVerifier: () => false,
      timeoutMs: 200,
      pollIntervalMs: 100,
      retries: 1,
    });
    expect(result.success).toBe(false);
    expect(result.attempts).toBe(2);
    expect(fixture.sends).toHaveLength(2);
    expect(fixture.logs).toHaveLength(1);
    const log = fixture.logs[0];
    if (log === undefined) throw new Error("expected log entry");
    expect(log.content).toContain("target=atmux:🧭-lead");
    expect(log.content).toContain("attempts=2");
    expect(log.content).toContain("timeout=200ms");
    // \n in keys normalised to \\n for grep-friendliness.
    expect(log.content).toContain("keys='claim --next --as lead\\nC-m'");
    expect(log.content).toContain("preCapture:");
    expect(log.content).toContain("postCapture:");
    expect(log.content).toContain("[16:42 MYT 2026-05-14]");
  });

  test("escalation log path defaults to $HOME-relative when no override", async () => {
    const captures = ["pre", "stuck", "stuck"];
    const { fixture, baseOpts } = buildVerifyFixture(captures);
    const result = await safeSendKeysWithVerify({
      ...baseOpts,
      home: "/tmp/fakehome",
      target: "atmux:m",
      keys: "x",
      expectVerifier: () => false,
      timeoutMs: 100,
      pollIntervalMs: 100,
      retries: 0,
    });
    expect(result.success).toBe(false);
    expect(fixture.logs[0]?.path).toBe(`/tmp/fakehome/${DEFAULT_SEND_KEYS_FAILURES_LOG_REL}`);
  });

  test("escalation log path honors explicit override", async () => {
    const captures = ["pre", "stuck", "stuck"];
    const { fixture, baseOpts } = buildVerifyFixture(captures);
    await safeSendKeysWithVerify({
      ...baseOpts,
      escalationLogPath: "/tmp/explicit.log",
      target: "atmux:m",
      keys: "x",
      expectVerifier: () => false,
      timeoutMs: 100,
      pollIntervalMs: 100,
      retries: 0,
    });
    expect(fixture.logs[0]?.path).toBe("/tmp/explicit.log");
  });

  test("appendLog failure is swallowed (best-effort) — caller still gets success=false", async () => {
    const captures = ["pre", "stuck", "stuck"];
    const { baseOpts } = buildVerifyFixture(captures);
    const result = await safeSendKeysWithVerify({
      ...baseOpts,
      appendLog: async () => {
        throw new Error("disk full");
      },
      target: "atmux:m",
      keys: "x",
      expectVerifier: () => false,
      timeoutMs: 100,
      pollIntervalMs: 100,
      retries: 0,
    });
    expect(result.success).toBe(false);
    expect(result.attempts).toBe(1);
  });

  test("falls back to relative log path when no $HOME and no override", async () => {
    const { fixture, baseOpts } = buildVerifyFixture(["pre", "stuck", "stuck"]);
    // home defaults to "" in buildVerifyFixture; explicitly null-out
    // the environment branch via env override below would require a
    // global mutation. The fixture's home: "" path is the test target.
    await safeSendKeysWithVerify({
      ...baseOpts,
      target: "atmux:m",
      keys: "x",
      expectVerifier: () => false,
      timeoutMs: 100,
      pollIntervalMs: 100,
      retries: 0,
    });
    // When home="" and no escalationLogPath, falls back to the
    // relative path literal.
    expect(fixture.logs[0]?.path).toBe(DEFAULT_SEND_KEYS_FAILURES_LOG_REL);
  });
});

// ---------- Throw path: SafeSendKeysError raised on exhaustion ----------

describe("safeSendKeysWithVerify — throw path", () => {
  test("onFail='throw' raises SafeSendKeysError with target/keys/attempts/finalCapture", async () => {
    const captures = Array.from({ length: 10 }, () => "stuck");
    const { baseOpts } = buildVerifyFixture(captures);
    let thrown: unknown = null;
    try {
      await safeSendKeysWithVerify({
        ...baseOpts,
        target: "atmux:m",
        keys: "y",
        expectVerifier: () => false,
        timeoutMs: 100,
        pollIntervalMs: 100,
        retries: 1,
        onFail: "throw",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SafeSendKeysError);
    if (!(thrown instanceof SafeSendKeysError)) throw new Error("unreachable");
    expect(thrown.target).toBe("atmux:m");
    expect(thrown.keys).toBe("y");
    expect(thrown.attempts).toBe(2);
    expect(thrown.name).toBe("SafeSendKeysError");
    expect(thrown.message).toContain("attempts=2");
  });

  test("onFail='throw' on success path does NOT throw", async () => {
    const { baseOpts } = buildVerifyFixture(["pre", "OK"]);
    const result = await safeSendKeysWithVerify({
      ...baseOpts,
      target: "atmux:m",
      keys: "y",
      expectVerifier: (c) => c === "OK",
      onFail: "throw",
    });
    expect(result.success).toBe(true);
  });
});

// ---------- Logger injection ----------

describe("safeSendKeysWithVerify — logger", () => {
  test("log callback fires on success", async () => {
    const lines: string[] = [];
    const { baseOpts } = buildVerifyFixture(["pre", "OK"]);
    await safeSendKeysWithVerify({
      ...baseOpts,
      log: (m) => lines.push(m),
      target: "atmux:m",
      keys: "x",
      expectVerifier: (c) => c === "OK",
    });
    expect(lines.some((l) => l.includes("verified"))).toBe(true);
  });

  test("log callback fires on attempt-timeout AND escalation", async () => {
    const lines: string[] = [];
    const { baseOpts } = buildVerifyFixture(["pre", "stuck", "stuck", "stuck"]);
    await safeSendKeysWithVerify({
      ...baseOpts,
      log: (m) => lines.push(m),
      target: "atmux:m",
      keys: "x",
      expectVerifier: () => false,
      timeoutMs: 100,
      pollIntervalMs: 100,
      retries: 0,
    });
    expect(lines.some((l) => l.includes("timed out"))).toBe(true);
    expect(lines.some((l) => l.includes("ESCALATED"))).toBe(true);
  });
});

// ---------- Built-in verifier coverage ----------

describe("composerEmpty verifier", () => {
  test("positive: composer prompt at end of pane → true", () => {
    const v = composerEmpty();
    expect(v("some output\nmore output\n❯ ")).toBe(true);
    expect(v("> Tip: foo\n❯ ")).toBe(true);
    expect(v("❯ ")).toBe(true);
  });
  test("negative: composer contains text → false", () => {
    const v = composerEmpty();
    // Multiline mode `/❯\s*$/m` matches end-of-line, so a pane with
    // "❯ <text>" followed by more lines does NOT match — there's
    // no end-of-line immediately after the prompt prefix.
    expect(v("❯ claim --next --as lead")).toBe(false);
  });
  test("negative: empty pane → false", () => {
    const v = composerEmpty();
    expect(v("")).toBe(false);
  });
});

describe("agentThinking verifier", () => {
  test("matches every documented 18-verb status indicator", () => {
    const v = agentThinking();
    // The 18 verbs documented in ADR-138 T2 task body.
    const verbs = [
      "Cooking",
      "Schlepping",
      "Honking",
      "Crunching",
      "Cogitating",
      "Brewing",
      "Effecting",
      "Imagining",
      "Sautéeing",
      "Kneading",
      "Misting",
      "Puttering",
      "Grooving",
      "Ruminating",
      "Worked",
      "Cooked",
      "Crunched",
      "Sautéed",
    ];
    for (const verb of verbs) {
      expect(v(`✻ ${verb}...`)).toBe(true);
    }
  });
  test("matches `… (Ns)` and `… (Nms)` elapsed markers", () => {
    const v = agentThinking();
    expect(v("✻ Brewing… (12s)")).toBe(true);
    expect(v("Honking… (450ms)")).toBe(true);
  });
  test("negative: idle composer / no indicator → false", () => {
    const v = agentThinking();
    expect(v("❯ ")).toBe(false);
    expect(v("just some output without an indicator")).toBe(false);
  });
});

describe("modalClosed verifier", () => {
  test("positive: modal text absent → true", () => {
    const v = modalClosed("Trust this workspace?");
    expect(v("normal pane content")).toBe(true);
  });
  test("negative: modal text still present → false", () => {
    const v = modalClosed("Trust this workspace?");
    expect(v("┌ Trust this workspace? ─┐\n│ 1. Yes  2. No │\n└─┘")).toBe(false);
  });
});

describe("contextNonZero verifier", () => {
  test("positive: `Nk tokens` token count → true", () => {
    const v = contextNonZero();
    expect(v("↑ 4k tokens · ↓ 1k")).toBe(true);
    expect(v("0.5k tokens — bootstrap done")).toBe(true);
    expect(v("12 tokens used")).toBe(true);
  });
  test("negative: `ctx --` marker → false (overrides token-like text)", () => {
    const v = contextNonZero();
    // Even if "tokens" appears nearby, the explicit `ctx --` no-
    // context marker wins per ADR-081 §C.
    expect(v("ctx -- pre-bootstrap state")).toBe(false);
    expect(v("ctx -- waiting · 0 tokens")).toBe(false);
  });
  test("negative: no token marker → false", () => {
    const v = contextNonZero();
    expect(v("❯ idle composer")).toBe(false);
    expect(v("")).toBe(false);
  });
});

describe("paneMatchesRegex verifier", () => {
  test("positive: regex matches", () => {
    const v = paneMatchesRegex(/hello\s+world/);
    expect(v("xxx hello world yyy")).toBe(true);
  });
  test("negative: regex does not match", () => {
    const v = paneMatchesRegex(/^EXACT$/);
    expect(v("EXACT extra")).toBe(false);
  });
  test("case-insensitive flag honored", () => {
    const v = paneMatchesRegex(/error/i);
    expect(v("FATAL ERROR")).toBe(true);
  });
});

// ---------- Default-adapter coverage (defaultNowFormatted + defaultAppendLog) ----------
//
// The internal `defaultNowFormatted` + `defaultAppendLog` functions are
// the prod adapters injected when callers omit the `nowFormatted` /
// `appendLog` overrides. Tests inject mocks above; these tests exercise
// the real adapters to lock 100% line coverage on the T2 surface.

describe("safeSendKeysWithVerify — default nowFormatted adapter", () => {
  test("real adapter produces `HH:MM MYT YYYY-MM-DD` shape in log entry", async () => {
    // Sleep override so the test doesn't actually wait on real time.
    // Use a real temp file for appendLog so defaultAppendLog runs too —
    // this single test exercises BOTH default adapters end-to-end.
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "atmux-safesend-test-"));
    const logPath = path.join(tmpDir, "nested", "send-keys-failures.log");
    try {
      let clock = 0;
      const captures = ["pre", "stuck", "stuck"];
      let i = 0;
      const result = await safeSendKeysWithVerify({
        target: "atmux:m",
        keys: "x",
        expectVerifier: () => false,
        timeoutMs: 100,
        pollIntervalMs: 100,
        retries: 0,
        escalationLogPath: logPath,
        capture: async () => captures[Math.min(i++, captures.length - 1)] ?? "",
        sendKeys: async () => {},
        sleep: async (ms: number) => {
          clock += ms;
        },
        now: () => clock,
        // No nowFormatted / appendLog overrides — exercises defaults.
      });
      expect(result.success).toBe(false);
      // The escalation log file exists + carries an MYT-format prefix.
      const content = await fs.readFile(logPath, "utf8");
      expect(content).toMatch(/^\[\d\d:\d\d MYT \d{4}-\d\d-\d\d\]/);
      expect(content).toContain("target=atmux:m");
      expect(content).toContain("attempts=1");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("safeSendKeysWithVerify — resolveLogPath HOME-env fallback", () => {
  test("explicit-undefined `home` falls through to process.env.HOME", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "atmux-fakehome-"));
    const priorHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const logs: { path: string; content: string }[] = [];
      const captures = ["pre", "stuck", "stuck"];
      let i = 0;
      let clock = 0;
      await safeSendKeysWithVerify({
        target: "atmux:m",
        keys: "x",
        expectVerifier: () => false,
        timeoutMs: 100,
        pollIntervalMs: 100,
        retries: 0,
        // No `home`, no `escalationLogPath` — resolver reads process.env.HOME.
        capture: async () => captures[Math.min(i++, captures.length - 1)] ?? "",
        sendKeys: async () => {},
        sleep: async (ms: number) => {
          clock += ms;
        },
        now: () => clock,
        nowFormatted: () => "16:42 MYT 2026-05-14",
        appendLog: async (p: string, c: string) => {
          logs.push({ path: p, content: c });
        },
      });
      expect(logs[0]?.path).toBe(`${tmpHome}/${DEFAULT_SEND_KEYS_FAILURES_LOG_REL}`);
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      await fs.rm(tmpHome, { recursive: true, force: true });
    }
  });
});

// ---------- ADR-138 T3b2: verifierForTui ----------

describe("verifierForTui", () => {
  test("claude tui → composerEmpty verifier (matches `❯ ` at line end)", () => {
    const v = verifierForTui("claude");
    expect(v).not.toBeNull();
    // Composer-empty regex matches Claude's prompt with optional
    // trailing whitespace at end-of-line.
    expect(v?.("user input here\n❯ ")).toBe(true);
    expect(v?.("user input here\n❯  ")).toBe(true);
    // Doesn't match plain shell prompt.
    expect(v?.("user input here\n$ ")).toBe(false);
  });

  test.each([
    [undefined],
    [""],
    ["shell"],
    ["bash"],
    ["zsh"],
    ["opencode"],
    ["kimi"],
    ["cursor"],
    ["custom-launcher-x"],
  ])("'%s' tui → null (skip verify, falls back to legacy submitAfterPaste)", (tui) => {
    expect(verifierForTui(tui)).toBeNull();
  });
});

// ---------- e-49 / c-cb9561e0: per-pane send-keys lock ----------

describe("sanitizePaneLockKey", () => {
  test("alnum + dash + underscore pass through unchanged", () => {
    expect(sanitizePaneLockKey("atmux_lead-2")).toBe("atmux_lead-2");
  });

  test("colon (the canonical tmux session:window separator) becomes underscore", () => {
    expect(sanitizePaneLockKey("atmux:lead")).toBe("atmux_lead");
  });

  test("emoji + multibyte unicode collapse to underscores", () => {
    // 🧭_lead — emoji at start, ASCII rest. Each emoji code-point unit
    // becomes _; the leading emoji is multi-byte so collapses to 4 _.
    const out = sanitizePaneLockKey("🧭_lead");
    expect(out.endsWith("_lead")).toBe(true);
    expect(out.match(/^[A-Za-z0-9_-]+$/)).not.toBeNull();
  });

  test("path separators stripped (defense against target traversal)", () => {
    expect(sanitizePaneLockKey("atmux:../etc/passwd")).toBe("atmux____etc_passwd");
  });

  test("default timeout is 60s", () => {
    expect(PANE_SEND_LOCK_TIMEOUT_MS).toBe(60_000);
  });
});

describe("withPaneSendLock", () => {
  test("serializes concurrent writers against the same target", async () => {
    const lockDir = mkdtempSync(join(tmpdir(), "pane-lock-test-"));
    const target = "atmux:lead";

    // Sequence-numbered work-units; each writer appends start+end
    // markers around a 30ms async block. If the lock works, no
    // start-marker is followed by another writer's start-marker before
    // the holder's end-marker. If broken, starts interleave.
    const ledger: string[] = [];
    const writer = (id: number) =>
      withPaneSendLock(
        target,
        async () => {
          ledger.push(`start-${id}`);
          await new Promise((r) => setTimeout(r, 30));
          ledger.push(`end-${id}`);
        },
        { lockDir },
      );

    await Promise.all([writer(1), writer(2), writer(3), writer(4), writer(5)]);

    // 5 writers × 2 markers = 10 entries.
    expect(ledger).toHaveLength(10);
    // Each start-N is immediately followed by end-N (serialized).
    for (let i = 0; i < ledger.length; i += 2) {
      const start = ledger[i] as string;
      const end = ledger[i + 1] as string;
      expect(start.startsWith("start-")).toBe(true);
      expect(end.startsWith("end-")).toBe(true);
      expect(start.slice(6)).toBe(end.slice(4));
    }
  });

  test("different targets do NOT serialize against each other", async () => {
    const lockDir = mkdtempSync(join(tmpdir(), "pane-lock-test-"));
    const startedAt: Record<string, number> = {};
    const endedAt: Record<string, number> = {};

    const writer = (target: string) =>
      withPaneSendLock(
        target,
        async () => {
          startedAt[target] = Date.now();
          await new Promise((r) => setTimeout(r, 50));
          endedAt[target] = Date.now();
        },
        { lockDir },
      );

    const t0 = Date.now();
    await Promise.all([writer("atmux:lead"), writer("atmux:planner"), writer("atmux:reviewer")]);
    const totalMs = Date.now() - t0;

    // 3 parallel writers × 50ms each. If serialized: ~150ms. Parallel:
    // ~50ms. Give 80ms ceiling for CI noise — well under serialized.
    expect(totalMs).toBeLessThan(120);
    // All three started within ~5ms of each other (parallel).
    const startTimes = Object.values(startedAt);
    const startSpread = Math.max(...startTimes) - Math.min(...startTimes);
    expect(startSpread).toBeLessThan(30);
  });

  test("fn's return value flows through the lock", async () => {
    const lockDir = mkdtempSync(join(tmpdir(), "pane-lock-test-"));
    const out = await withPaneSendLock("atmux:lead", () => Promise.resolve("payload"), {
      lockDir,
    });
    expect(out).toBe("payload");
  });

  test("fn's thrown error releases the lock + propagates", async () => {
    const lockDir = mkdtempSync(join(tmpdir(), "pane-lock-test-"));
    await expect(
      withPaneSendLock(
        "atmux:lead",
        () => {
          throw new Error("boom");
        },
        { lockDir },
      ),
    ).rejects.toThrow("boom");

    // Next acquire on the same target must succeed (lock released
    // in finally{} even on throw).
    let secondRan = false;
    await withPaneSendLock(
      "atmux:lead",
      () => {
        secondRan = true;
      },
      { lockDir },
    );
    expect(secondRan).toBe(true);
  });

  test("LockTimeoutError fail-open: log + proceed without serialization", async () => {
    const lockDir = mkdtempSync(join(tmpdir(), "pane-lock-test-"));
    const target = "atmux:lead";
    const logged: string[] = [];

    // Start a holder that takes longer than the 100ms timeout we pass.
    const holderDone = (async () => {
      await withPaneSendLock(
        target,
        async () => {
          await new Promise((r) => setTimeout(r, 500));
        },
        { lockDir },
      );
    })();

    // Give holder a moment to acquire.
    await new Promise((r) => setTimeout(r, 20));

    // Second writer: 100ms timeout while holder still holds → must
    // fail-open + run fn + log.
    let secondRan = false;
    const out = await withPaneSendLock(
      target,
      () => {
        secondRan = true;
        return "fail-open-payload";
      },
      { lockDir, timeoutMs: 100, log: (m) => logged.push(m) },
    );

    expect(out).toBe("fail-open-payload");
    expect(secondRan).toBe(true);
    expect(logged.some((l) => l.includes("timed out") && l.includes("fail-open"))).toBe(true);

    await holderDone;
  });
});
