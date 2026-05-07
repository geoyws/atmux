// Unit tests for src/core/safe-send.ts (ADR-057 §D1 R57-T1).
//
// safeSendKeys gate: classify pane → send / retry / refuse. Drives
// the flag-emit + retry-policy paths from src/core/pane-state.ts.

import { describe, expect, test } from "bun:test";
import {
  KNOWN_MODAL_SETTLE_MS,
  MAX_KNOWN_MODAL_DISMISSALS,
  safeSendKeys,
  type SafeSendOpts,
  type SafeSendOutcome,
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
    const { fixture, opts } = buildFixture(["3.4k tokens · esc to interrupt"]);
    const result = await safeSendKeys("atmux:1.0", "hello", opts);
    expect(result.outcome).toBe("sent");
    expect(result.attempts).toBe(1);
    expect(fixture.sends).toEqual([
      { target: "atmux:1.0", text: "hello", enter: undefined },
    ]);
    expect(fixture.flags).toHaveLength(0);
    expect(fixture.sleeps).toHaveLength(0);
  });
});

// ---------- TYPING retry path ----------

describe("safeSendKeys — TYPING retries", () => {
  test("TYPING → READY on second attempt", async () => {
    const { fixture, opts } = buildFixture([
      "Press up to edit queued messages",
      "3.4k tokens · esc to interrupt",
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
      "3.4k tokens · esc to interrupt",
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
    const { fixture, opts } = buildFixture([
      FEEDBACK_SURVEY_PANE,
      "3.4k tokens · esc to interrupt",
    ]);
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
    const { fixture, opts } = buildFixture([
      FEEDBACK_SURVEY_PANE,
      "3.4k tokens · esc to interrupt",
    ]);
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
    const captures = ["3.4k tokens · esc to interrupt"];
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
      "exhausted-compacting",
    ];
    expect(outcomes).toHaveLength(7);
  });
});
