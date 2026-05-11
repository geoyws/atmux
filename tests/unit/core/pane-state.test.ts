// Unit tests for src/core/pane-state.ts (ADR-057 §D1 R57-T1; ADR-080 §C
// added BUSY for spinner-verb / mid-think detection).
//
// 8-state classifier: READY | TYPING | BUSY | MODAL | RATE-LIMIT |
// COMPACTING | SHELL | UNKNOWN. Plus retry policy + refusal severity
// constants.

import { describe, expect, test } from "bun:test";
import {
  classifyPane,
  classifyText,
  isRetryable,
  isSendable,
  type PaneClassification,
  type PaneState,
  REFUSAL_SEVERITY,
  RETRY_POLICY,
} from "../../../src/core/pane-state.ts";

const FIXED_NOW = 1_700_000_000_000;
const nowFn = (): number => FIXED_NOW;

// ---------- classifyText — discrete state coverage ----------

describe("classifyText — 8 discrete states", () => {
  test("READY when capture shows the empty prompt", () => {
    const r = classifyText("\n>\n", nowFn);
    expect(r.state).toBe("READY");
    expect(r.capturedAt).toBe(FIXED_NOW);
  });

  test("READY when capture shows the border-prefixed bare prompt (no tok footer)", () => {
    // The compose box renders as `│ > ` (ASCII) or `│ ❯ ` (Unicode) when
    // the user has typed nothing. A transient bootstrap or post-/clear
    // pane that hasn't redrawn the `tok N/M` footer yet still classifies
    // as READY — lane-tick.ts ADR-080 §A2 ctx-pct gate then sees null
    // ctx-pct and falls through to the normal claim injection.
    expect(classifyText("│ > \n", nowFn).state).toBe("READY");
    expect(classifyText("│ ❯ \n", nowFn).state).toBe("READY");
  });

  test("READY when capture shows the token-counter footer (no interrupt phrase)", () => {
    // Per ADR-080 §C: the canonical READY status-bar shape is the
    // token-counter `tok 67k/100`, NOT "esc to interrupt" — that phrase
    // only appears during an active turn (now classified BUSY).
    const r = classifyText("\ntok 67k/100  ⏵⏵ auto mode on\n", nowFn);
    expect(r.state).toBe("READY");
  });

  test("TYPING when 'Press up to edit queued messages' present", () => {
    const r = classifyText("draft text\nPress up to edit queued messages", nowFn);
    expect(r.state).toBe("TYPING");
  });

  test("BUSY when '✻ Cooked for Ns' spinner glyph present", () => {
    const r = classifyText("✻ Cooked for 12s\n", nowFn);
    expect(r.state).toBe("BUSY");
    expect(r.evidence).toContain("✻");
  });

  test("BUSY when '✽ Honking…' spinner glyph present", () => {
    const r = classifyText("✽ Honking\n", nowFn);
    expect(r.state).toBe("BUSY");
    expect(r.evidence).toContain("✽");
  });

  test("BUSY when spinner verb (Computing/Thinking/Working/Cooked/etc.) with ellipsis", () => {
    expect(classifyText("Computing…", nowFn).state).toBe("BUSY");
    expect(classifyText("Hullaballing...", nowFn).state).toBe("BUSY");
    expect(classifyText("Cogitating...", nowFn).state).toBe("BUSY");
    expect(classifyText("Sautéing…", nowFn).state).toBe("BUSY");
    expect(classifyText("Working…", nowFn).state).toBe("BUSY");
    expect(classifyText("Cooked…", nowFn).state).toBe("BUSY");
  });

  test("BUSY when generic 'esc to interrupt' banner present (mid-turn marker)", () => {
    // 2026-05-09 ADR-080 §C — pre-fix this string was the READY
    // status-bar marker. The interrupt banner only renders during an
    // active turn, so reclassified to BUSY.
    const r = classifyText("3.4k tokens · esc to interrupt", nowFn);
    expect(r.state).toBe("BUSY");
  });

  test("MODAL when 'Do you want Claude to' modal", () => {
    const r = classifyText("Do you want Claude to run rm -rf? [y/N]", nowFn);
    expect(r.state).toBe("MODAL");
  });

  test("MODAL when 'Allow this tool to proceed' prompt", () => {
    const r = classifyText("Allow this tool to proceed?", nowFn);
    expect(r.state).toBe("MODAL");
  });

  test("MODAL when [y/N]: prompt at end-of-line", () => {
    const r = classifyText("Confirm operation [y/N]:", nowFn);
    expect(r.state).toBe("MODAL");
  });

  test("MODAL when feedback-survey 'How is Claude doing this session' shows", () => {
    // t-3e58a605 Path B — survey modal blocks pane until dismissed.
    const r = classifyText(
      "● How is Claude doing this session? (optional)\n  1: Bad   2: Fine   3: Good   0: Dismiss",
      nowFn,
    );
    expect(r.state).toBe("MODAL");
  });

  test("RATE-LIMIT when 'hit your limit' banner", () => {
    const r = classifyText("Rate limit hit your limit until 12:00", nowFn);
    expect(r.state).toBe("RATE-LIMIT");
  });

  test("RATE-LIMIT — case-insensitive 'You've hit your limit'", () => {
    const r = classifyText("you've hit your limit", nowFn);
    expect(r.state).toBe("RATE-LIMIT");
  });

  test("COMPACTING when 'Compacting conversation' banner", () => {
    const r = classifyText("Compacting conversation...\n", nowFn);
    expect(r.state).toBe("COMPACTING");
  });

  test("SHELL when bash $-prompt at end of buffer", () => {
    const r = classifyText("user@host:~$ ", nowFn);
    expect(r.state).toBe("SHELL");
  });

  test("SHELL when zsh #-prompt at end of buffer", () => {
    const r = classifyText("root@hax:~# ", nowFn);
    expect(r.state).toBe("SHELL");
  });

  test("UNKNOWN when no patterns match", () => {
    const r = classifyText("random pane content with no Claude markers", nowFn);
    expect(r.state).toBe("UNKNOWN");
    expect(r.evidence).toBe("");
  });

  test("UNKNOWN on empty capture", () => {
    const r = classifyText("", nowFn);
    expect(r.state).toBe("UNKNOWN");
  });
});

// ---------- Pattern priority — RATE-LIMIT > COMPACTING > READY ----------

describe("classifyText — pattern priority", () => {
  test("RATE-LIMIT wins over COMPACTING when both signals present", () => {
    const r = classifyText("hit your limit\nCompacting conversation", nowFn);
    expect(r.state).toBe("RATE-LIMIT");
  });

  test("COMPACTING wins over BUSY when both signals present", () => {
    // BUSY is checked AFTER COMPACTING (compaction is more blocking;
    // the pane can't accept input until compaction finishes regardless
    // of any spinner showing simultaneously).
    const r = classifyText("Compacting conversation\n✻ Cooked for 5s", nowFn);
    expect(r.state).toBe("COMPACTING");
  });

  test("BUSY wins over MODAL when both signals present (OQ-C1)", () => {
    // ADR-080 §C OQ-C1: a busy pane that ALSO shows a modal hint is
    // mid-think — the modal will resolve when the turn completes.
    const r = classifyText("✻ Cooked for 5s\nDo you want Claude to proceed?", nowFn);
    expect(r.state).toBe("BUSY");
  });

  test("MODAL wins over TYPING when both present", () => {
    const r = classifyText("Press up to edit queued messages\n[y/N]:", nowFn);
    // [y/N]: is MODAL; pattern order matters.
    expect(r.state).toBe("MODAL");
  });

  test("READY wins when only the prompt pattern matches (no error/modal/busy)", () => {
    const r = classifyText("\n>\n", nowFn);
    expect(r.state).toBe("READY");
  });
});

// ---------- classifyPane — async wrapper ----------

describe("classifyPane — async capture wrapper", () => {
  test("invokes captureFn with the target + classifies result", async () => {
    let capturedTarget: string | undefined;
    const fakeCapture = async (target: string): Promise<string> => {
      capturedTarget = target;
      return "Compacting conversation";
    };
    const r = await classifyPane("atmux:1.0", fakeCapture, nowFn);
    expect(capturedTarget).toBe("atmux:1.0");
    expect(r.state).toBe("COMPACTING");
    expect(r.capturedAt).toBe(FIXED_NOW);
  });

  test("propagates capture errors", async () => {
    const failingCapture = async (): Promise<string> => {
      throw new Error("tmux dead");
    };
    await expect(classifyPane("x", failingCapture)).rejects.toThrow("tmux dead");
  });

  test("default nowMs uses real clock (within 5s)", async () => {
    const fake = async (): Promise<string> => "READY-shaped: > ";
    const before = Date.now();
    const r = await classifyPane("x", fake);
    const after = Date.now();
    expect(r.capturedAt).toBeGreaterThanOrEqual(before);
    expect(r.capturedAt).toBeLessThanOrEqual(after + 5);
  });
});

// ---------- isSendable / isRetryable predicates ----------

describe("isSendable", () => {
  test("only READY is immediately sendable", () => {
    expect(isSendable("READY")).toBe(true);
    expect(isSendable("TYPING")).toBe(false);
    expect(isSendable("BUSY")).toBe(false);
    expect(isSendable("MODAL")).toBe(false);
    expect(isSendable("RATE-LIMIT")).toBe(false);
    expect(isSendable("COMPACTING")).toBe(false);
    expect(isSendable("SHELL")).toBe(false);
    expect(isSendable("UNKNOWN")).toBe(false);
  });
});

describe("isRetryable", () => {
  test("TYPING + BUSY + COMPACTING are retryable; nothing else", () => {
    expect(isRetryable("TYPING")).toBe(true);
    expect(isRetryable("BUSY")).toBe(true);
    expect(isRetryable("COMPACTING")).toBe(true);
    expect(isRetryable("READY")).toBe(false);
    expect(isRetryable("MODAL")).toBe(false);
    expect(isRetryable("RATE-LIMIT")).toBe(false);
    expect(isRetryable("SHELL")).toBe(false);
    expect(isRetryable("UNKNOWN")).toBe(false);
  });
});

// ---------- RETRY_POLICY ----------

describe("RETRY_POLICY", () => {
  test("READY: no retry needed", () => {
    expect(RETRY_POLICY.READY).toEqual({ delayMs: 0, maxAttempts: 1 });
  });

  test("TYPING: 2s × 3 attempts", () => {
    expect(RETRY_POLICY.TYPING).toEqual({ delayMs: 2_000, maxAttempts: 3 });
  });

  test("BUSY: 5s × 6 attempts (= 30s budget)", () => {
    expect(RETRY_POLICY.BUSY).toEqual({ delayMs: 5_000, maxAttempts: 6 });
  });

  test("COMPACTING: 5s × 6 attempts (= 30s budget)", () => {
    expect(RETRY_POLICY.COMPACTING).toEqual({ delayMs: 5_000, maxAttempts: 6 });
  });

  test("non-retryable states have maxAttempts=0", () => {
    expect(RETRY_POLICY.MODAL.maxAttempts).toBe(0);
    expect(RETRY_POLICY["RATE-LIMIT"].maxAttempts).toBe(0);
    expect(RETRY_POLICY.SHELL.maxAttempts).toBe(0);
    expect(RETRY_POLICY.UNKNOWN.maxAttempts).toBe(0);
  });
});

// ---------- REFUSAL_SEVERITY ----------

describe("REFUSAL_SEVERITY", () => {
  test("READY: no refusal (null)", () => {
    expect(REFUSAL_SEVERITY.READY).toBeNull();
  });

  test("TYPING/BUSY/COMPACTING/MODAL: P3", () => {
    expect(REFUSAL_SEVERITY.TYPING).toBe("p3");
    expect(REFUSAL_SEVERITY.BUSY).toBe("p3");
    expect(REFUSAL_SEVERITY.COMPACTING).toBe("p3");
    expect(REFUSAL_SEVERITY.MODAL).toBe("p3");
  });

  test("SHELL/UNKNOWN: P2", () => {
    expect(REFUSAL_SEVERITY.SHELL).toBe("p2");
    expect(REFUSAL_SEVERITY.UNKNOWN).toBe("p2");
  });

  test("RATE-LIMIT: null (ADR-053 budget-pause path takes over)", () => {
    expect(REFUSAL_SEVERITY["RATE-LIMIT"]).toBeNull();
  });
});

// ---------- Type sanity ----------

describe("PaneState exhaustiveness", () => {
  test("all 8 states represented in RETRY_POLICY + REFUSAL_SEVERITY", () => {
    const states: PaneState[] = [
      "READY",
      "TYPING",
      "BUSY",
      "MODAL",
      "RATE-LIMIT",
      "COMPACTING",
      "SHELL",
      "UNKNOWN",
    ];
    for (const s of states) {
      expect(RETRY_POLICY[s]).toBeDefined();
      expect(REFUSAL_SEVERITY[s]).toBeDefined; // null is valid value
    }
  });

  test("PaneClassification shape is fully typed", () => {
    const c: PaneClassification = { state: "READY", evidence: "ok", capturedAt: 1 };
    expect(c.state).toBe("READY");
  });
});
