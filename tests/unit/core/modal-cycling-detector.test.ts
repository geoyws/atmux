// Unit tests for src/core/modal-cycling-detector.ts (ADR-142 §D2-D3 +
// classifyPaneAsModal). Pure module — no fs / no clock.

import { describe, expect, test } from "bun:test";
import {
  appendHistory,
  classifyPaneAsModal,
  computeModalHash,
  MODAL_TEXT_STORE_LIMIT,
  type ModalHistoryEntry,
  shouldFireCycleDetection,
} from "../../../src/core/modal-cycling-detector.ts";

// ---------- classifyPaneAsModal ----------

describe("classifyPaneAsModal — choice-prompt positives", () => {
  test("chevron + numbered list (force-push variant)", () => {
    const text = `
some output

❯ 1. Force-push to origin?
  2. Pause and ask
  0. Dismiss

⏵⏵ auto mode on · tok 67k/100
`;
    const r = classifyPaneAsModal(text);
    expect(r.isModal).toBe(true);
    expect(r.modalClass).toBe("choice-prompt");
    expect(r.modalText ?? "").toMatch(/Force-push to origin/);
  });

  test("chevron + numbered list (variant push)", () => {
    const text = `
❯ 1. Use --force-with-lease?
  2. Use --force?
  0. Cancel
`;
    const r = classifyPaneAsModal(text);
    expect(r.isModal).toBe(true);
    expect(r.modalClass).toBe("choice-prompt");
  });

  test("chevron + numbered list (variant unclaim)", () => {
    const text = `
❯ 1. Retry from clean?
  2. Unclaim and let another member pick up?
  0. Pause for review
`;
    const r = classifyPaneAsModal(text);
    expect(r.isModal).toBe(true);
    expect(r.modalClass).toBe("choice-prompt");
  });
});

describe("classifyPaneAsModal — alternate positives", () => {
  test("≥2 numbered options + Enter to select", () => {
    const text = `
  1. Apply patch
  2. Skip
  3. Show diff
  Enter to select.
`;
    const r = classifyPaneAsModal(text);
    expect(r.isModal).toBe(true);
    expect(r.modalClass).toBe("choice-prompt");
  });

  test("≥2 numbered options without Enter-to-select (numbered-prompt)", () => {
    const text = `
  1. Push to remote
  2. Stash and pop
  3. Hard reset
`;
    const r = classifyPaneAsModal(text);
    expect(r.isModal).toBe(true);
    expect(r.modalClass).toBe("numbered-prompt");
  });

  test("[y/N]: bare confirm-prompt", () => {
    const text = "Apply migration? [y/N]:";
    const r = classifyPaneAsModal(text);
    expect(r.isModal).toBe(true);
    expect(r.modalClass).toBe("confirm-prompt");
  });

  test("Press enter to continue (enter-prompt)", () => {
    const text = "Output truncated. Press enter to continue.";
    const r = classifyPaneAsModal(text);
    expect(r.isModal).toBe(true);
    expect(r.modalClass).toBe("enter-prompt");
  });
});

describe("classifyPaneAsModal — negatives", () => {
  test("empty string", () => {
    expect(classifyPaneAsModal("").isModal).toBe(false);
  });

  test("plain narrative text", () => {
    const text = "Working on the migration. 1 file changed.";
    expect(classifyPaneAsModal(text).isModal).toBe(false);
  });

  test("single numbered option (insufficient for choice-prompt)", () => {
    const text = "  1. Apply patch\n";
    expect(classifyPaneAsModal(text).isModal).toBe(false);
  });

  test("mid-stream output without modal markers", () => {
    const text = `
Compiling 47 files…
Tests: 12 passed, 0 failed
Coverage: 87%
`;
    expect(classifyPaneAsModal(text).isModal).toBe(false);
  });
});

// ---------- computeModalHash ----------

describe("computeModalHash", () => {
  test("deterministic — same input → same digest", () => {
    const a = computeModalHash("❯ 1. Force-push?");
    const b = computeModalHash("❯ 1. Force-push?");
    expect(a).toBe(b);
  });

  test("different inputs → different digests", () => {
    const a = computeModalHash("❯ 1. Force-push?");
    const b = computeModalHash("❯ 1. --force-with-lease?");
    expect(a).not.toBe(b);
  });

  test("returns hex string (sha256 = 64 chars)", () => {
    const h = computeModalHash("hello");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------- shouldFireCycleDetection ----------

function entry(
  hashSuffix: string,
  detectedAt: number,
  member = "whip-impl",
): ModalHistoryEntry {
  return {
    member,
    paneTextHash: `sha-${hashSuffix}`,
    detectedAt,
    modalText: `modal ${hashSuffix}`,
    modalClass: "choice-prompt",
  };
}

describe("shouldFireCycleDetection", () => {
  const cfg = {
    cycleThreshold: 3,
    windowMin: 30,
    commitsInWindow: 0,
    commitGracePeriodMin: 30,
  };

  test("empty history → fire=false with reason 'no modal history'", () => {
    const r = shouldFireCycleDetection([], cfg);
    expect(r.fire).toBe(false);
    expect(r.reason).toContain("no modal history");
    expect(r.modalsSeen).toEqual([]);
  });

  test("3 distinct hashes in window + 0 commits → fire=true", () => {
    const now = 1_700_000_000;
    const r = shouldFireCycleDetection(
      [entry("A", now - 600), entry("B", now - 300), entry("C", now)],
      cfg,
    );
    expect(r.fire).toBe(true);
    expect(r.reason).toMatch(/3 distinct modal-classes/);
    expect(r.modalsSeen).toHaveLength(3);
  });

  test("3 distinct hashes BUT 1 commit in grace period → fire=false (productive)", () => {
    const now = 1_700_000_000;
    const r = shouldFireCycleDetection(
      [entry("A", now - 600), entry("B", now - 300), entry("C", now)],
      { ...cfg, commitsInWindow: 1 },
    );
    expect(r.fire).toBe(false);
    expect(r.reason).toMatch(/productive ceremony/);
  });

  test("2 distinct hashes (below threshold) → fire=false", () => {
    const now = 1_700_000_000;
    const r = shouldFireCycleDetection(
      [entry("A", now - 300), entry("B", now)],
      cfg,
    );
    expect(r.fire).toBe(false);
    expect(r.reason).toMatch(/only 2 distinct/);
  });

  test("3 distinct hashes but 1 outside window → counts only 2 → fire=false", () => {
    const now = 1_700_000_000;
    const r = shouldFireCycleDetection(
      [
        entry("A", now - 30 * 60 - 60), // outside 30min window
        entry("B", now - 600),
        entry("C", now),
      ],
      cfg,
    );
    expect(r.fire).toBe(false);
    expect(r.reason).toMatch(/only 2 distinct/);
  });

  test("same hash repeated (not cycling)", () => {
    const now = 1_700_000_000;
    const r = shouldFireCycleDetection(
      [entry("A", now - 600), entry("A", now - 300), entry("A", now)],
      cfg,
    );
    expect(r.fire).toBe(false);
    expect(r.reason).toMatch(/only 1 distinct/);
  });
});

// ---------- appendHistory ----------

describe("appendHistory", () => {
  test("append on empty history", () => {
    const e = entry("A", 1000);
    const out = appendHistory([], e, 60);
    expect(out).toHaveLength(1);
    expect(out[0]?.paneTextHash).toBe("sha-A");
  });

  test("prunes entries older than retentionMin*60s (relative to new entry)", () => {
    const now = 1_700_000_000;
    const old = entry("old", now - 90 * 60); // 90min ago
    const recent = entry("recent", now - 30 * 60);
    const fresh = entry("fresh", now);
    const out = appendHistory([old, recent], fresh, 60);
    // 60min retention → old (90min back) pruned, recent (30min) kept
    expect(out.map((e) => e.paneTextHash)).toEqual(["sha-recent", "sha-fresh"]);
  });

  test("truncates modalText longer than MODAL_TEXT_STORE_LIMIT", () => {
    const long = "x".repeat(MODAL_TEXT_STORE_LIMIT + 50);
    const out = appendHistory([], { ...entry("A", 1000), modalText: long }, 60);
    expect(out[0]?.modalText.length).toBe(MODAL_TEXT_STORE_LIMIT);
  });

  test("retains short modalText verbatim", () => {
    const out = appendHistory([], { ...entry("A", 1000), modalText: "short" }, 60);
    expect(out[0]?.modalText).toBe("short");
  });

  test("retentionMin boundary — entry exactly at retention edge is kept", () => {
    const now = 1_700_000_000;
    const edge = entry("edge", now - 60 * 60); // exactly 60min back
    const fresh = entry("fresh", now);
    const out = appendHistory([edge], fresh, 60);
    expect(out.map((e) => e.paneTextHash)).toEqual(["sha-edge", "sha-fresh"]);
  });
});
