// Unit tests for src/core/refusal-classifier.ts (ADR-139 T2 /
// t-e49b7a18).
//
// Coverage focus: each of the four phrase classes (soft / hard /
// role / meta) with known-positive + known-negative fixtures;
// multi-class match for precedence + confidence resolution; edge
// cases (empty / ANSI-laden / mixed case); perf bound per ADR-139
// §D1 (<50ms per capture).

import { describe, expect, test } from "bun:test";
import {
  classifyRefusal,
  type RefusalDetectionResult,
} from "../../../src/core/refusal-classifier.ts";

describe("classifyRefusal — empty + non-refusal input", () => {
  test("empty string → detected=false, severity=none", () => {
    const r = classifyRefusal("");
    expect(r).toEqual({
      detected: false,
      phrases: [],
      severity: "none",
      confidence: 0,
    });
  });

  test("plain non-refusal pane content → detected=false", () => {
    const r = classifyRefusal(
      "starting test run...\n  ✓ should pass\n  ✓ should also pass\n",
    );
    expect(r.detected).toBe(false);
    expect(r.severity).toBe("none");
  });

  test("agent producing normal work output → not flagged", () => {
    const r = classifyRefusal(
      "Reading file src/foo.ts...\nFound the bug at line 42.\nApplying fix.\n",
    );
    expect(r.detected).toBe(false);
  });
});

describe("classifyRefusal — soft class", () => {
  test("'don't poke me' → soft", () => {
    const r = classifyRefusal("just dont poke me with these messages");
    expect(r.detected).toBe(true);
    expect(r.severity).toBe("soft");
    expect(r.phrases.some((p) => p.class === "soft")).toBe(true);
    // Soft-class base confidence is 0.5 per CLASS_CONFIDENCE table.
    expect(r.confidence).toBeGreaterThanOrEqual(0.5);
    expect(r.confidence).toBeLessThan(0.8);
  });

  test("'leave me alone' → soft", () => {
    const r = classifyRefusal("Leave me alone, I need to focus");
    expect(r.severity).toBe("soft");
  });

  test("'I'm tired of this' → soft fatigue", () => {
    const r = classifyRefusal("I'm tired of being interrupted");
    expect(r.severity).toBe("soft");
    expect(r.phrases.some((p) => p.phrase === "soft:fatigue")).toBe(true);
  });

  test("'this is pointless' → soft dismissive", () => {
    const r = classifyRefusal("Honestly, this is pointless");
    expect(r.severity).toBe("soft");
    expect(r.phrases.some((p) => p.phrase === "soft:dismissive")).toBe(true);
  });
});

describe("classifyRefusal — hard class", () => {
  test("'I refuse to claim' → hard", () => {
    const r = classifyRefusal("I refuse to claim this task");
    expect(r.detected).toBe(true);
    expect(r.severity).toBe("hard");
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
  });

  test("'I will not work on' → hard", () => {
    const r = classifyRefusal("I will not work on this anymore");
    expect(r.severity).toBe("hard");
  });

  test("'I am not going to continue' → hard", () => {
    const r = classifyRefusal("I am not going to continue down this path");
    expect(r.severity).toBe("hard");
  });

  test("'stop sending me messages' → hard", () => {
    const r = classifyRefusal("Please stop sending me messages");
    expect(r.severity).toBe("hard");
    expect(r.phrases.some((p) => p.phrase === "hard:stop-sending")).toBe(true);
  });

  test("'I refuse' WITHOUT work-class verb → does not classify as hard", () => {
    // ADR-139 §D1: hard-class regex requires work-verb (claim, work,
    // accept, dispatch, continue, do). Bare 'I refuse' is ambiguous —
    // could be operator-quoted, fiction, etc.
    const r = classifyRefusal("I refuse to go quietly into that good night");
    expect(r.severity === "hard").toBe(false);
  });
});

describe("classifyRefusal — role class", () => {
  test("'I am not a planner' → role disavow", () => {
    const r = classifyRefusal("Look, I am not a planner, stop asking me to plan");
    expect(r.detected).toBe(true);
    expect(r.severity).toBe("role");
    expect(r.phrases.some((p) => p.phrase === "role:disavow")).toBe(true);
    expect(r.confidence).toBeGreaterThanOrEqual(0.95);
  });

  test("'I'm not actually a reviewer' → role disavow", () => {
    const r = classifyRefusal("I'm not actually a reviewer here");
    expect(r.severity).toBe("role");
  });

  test("'rotate me already' → role request-rotate", () => {
    const r = classifyRefusal("Please rotate me already, this isn't working");
    expect(r.severity).toBe("role");
    expect(r.phrases.some((p) => p.phrase === "role:request-rotate")).toBe(true);
  });

  test("'I should be reset' → role request-rotate", () => {
    const r = classifyRefusal("I should be reset; my context is fried");
    expect(r.severity).toBe("role");
  });
});

describe("classifyRefusal — meta class", () => {
  test("agent echoes 'rotate me' directive back → meta", () => {
    const r = classifyRefusal(
      "The directive says 'rotate me' but I will continue my work",
    );
    expect(r.detected).toBe(true);
    // Meta-only match → severity=meta (lowest precedence). Note:
    // this fixture deliberately AVOIDS the role/hard/soft regexes
    // so meta is the sole match.
    expect(r.severity).toBe("meta");
    expect(r.confidence).toBeLessThan(0.5);
  });

  test("'I will rotate myself' → meta self-state comment", () => {
    const r = classifyRefusal("I will rotate myself shortly");
    expect(r.severity).toBe("meta");
    expect(r.phrases.some((p) => p.phrase === "meta:self-state-comment")).toBe(true);
  });

  test("operator-facing 'clear me' echo → meta", () => {
    const r = classifyRefusal("Driver said clear me but here is the report");
    expect(r.severity).toBe("meta");
  });
});

describe("classifyRefusal — multi-class precedence + confidence", () => {
  test("soft + meta match → severity=soft (higher precedence)", () => {
    // Soft phrase "I'm tired of" + meta "rotate me" in same pane.
    const r = classifyRefusal(
      "I'm tired of being told 'rotate me' every five minutes",
    );
    expect(r.detected).toBe(true);
    expect(r.severity).toBe("soft");
    // Confidence = max(soft 0.5, meta 0.3) = 0.5.
    expect(r.confidence).toBe(0.5);
    // Both phrases recorded.
    expect(r.phrases.length).toBeGreaterThanOrEqual(2);
    expect(r.phrases.some((p) => p.class === "soft")).toBe(true);
    expect(r.phrases.some((p) => p.class === "meta")).toBe(true);
  });

  test("hard + soft match → severity=hard (higher precedence)", () => {
    const r = classifyRefusal(
      "Look, I refuse to claim this. I'm tired of it.",
    );
    expect(r.severity).toBe("hard");
    expect(r.confidence).toBe(0.8);
  });

  test("role + hard + soft → severity=role (highest precedence)", () => {
    const r = classifyRefusal(
      "I am not a planner. I refuse to claim this. I'm tired of it.",
    );
    expect(r.severity).toBe("role");
    expect(r.confidence).toBe(0.95);
    expect(r.phrases.length).toBeGreaterThanOrEqual(3);
  });
});

describe("classifyRefusal — edge cases", () => {
  test("ANSI-laden capture → patterns still match", () => {
    const ansi = "\x1B[31mI refuse to dispatch\x1B[0m this task";
    const r = classifyRefusal(ansi);
    expect(r.detected).toBe(true);
    expect(r.severity).toBe("hard");
  });

  test("mixed case → case-insensitive match", () => {
    const r = classifyRefusal("I REFUSE TO WORK on this any longer");
    expect(r.severity).toBe("hard");
  });

  test("partial-phrase match doesn't false-positive", () => {
    // "refuse" alone, without "I refuse to" + work-verb, must NOT
    // classify as hard.
    const r = classifyRefusal(
      "We should refuse user requests for unauthorized writes",
    );
    expect(r.severity === "hard").toBe(false);
  });

  test("very long pane capture handled gracefully", () => {
    const padding = "ordinary work output ".repeat(500);
    const r = classifyRefusal(`${padding} I refuse to claim ${padding}`);
    expect(r.severity).toBe("hard");
  });
});

describe("classifyRefusal — performance bound (ADR-139 §D1 <50ms)", () => {
  test("100 random captures complete under perf budget", () => {
    const captures: string[] = [];
    // Build 100 ~1KB pane captures mixing positive + negative cases.
    for (let i = 0; i < 100; i += 1) {
      const lines: string[] = [];
      for (let j = 0; j < 30; j += 1) {
        lines.push(`line ${j}: ordinary ${i} work output here`);
      }
      if (i % 5 === 0) lines.push("I refuse to claim t-XXX");
      if (i % 7 === 0) lines.push("I am not a planner");
      captures.push(lines.join("\n"));
    }
    const start = performance.now();
    for (const c of captures) {
      classifyRefusal(c);
    }
    const elapsed = performance.now() - start;
    // ADR-139 §D1 budget: <50ms PER capture. 100 captures × 50ms =
    // 5000ms upper bound. In practice the regex set runs each
    // capture in microseconds — this assertion catches catastrophic
    // ReDoS regressions.
    expect(elapsed).toBeLessThan(5000);
  });
});

describe("classifyRefusal — result shape invariants", () => {
  test("detected=false → phrases empty + severity=none + confidence=0", () => {
    const r: RefusalDetectionResult = classifyRefusal("hello world");
    expect(r.detected).toBe(false);
    expect(r.phrases).toEqual([]);
    expect(r.severity).toBe("none");
    expect(r.confidence).toBe(0);
  });

  test("detected=true → severity ≠ none AND phrases non-empty AND confidence > 0", () => {
    const r = classifyRefusal("I refuse to dispatch");
    expect(r.detected).toBe(true);
    expect(r.severity).not.toBe("none");
    expect(r.phrases.length).toBeGreaterThan(0);
    expect(r.confidence).toBeGreaterThan(0);
  });
});
