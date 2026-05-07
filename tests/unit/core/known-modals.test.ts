// Unit tests for src/core/known-modals.ts (ADR-057 t-3e58a605 Path B).
//
// Catalog precedence + per-entry pattern correctness. The catalog is
// small + audited — these tests pin every entry's match shape so a
// subtle pattern change can't silently regress the auto-dismiss path.

import { describe, expect, test } from "bun:test";
import { detectKnownModal, KNOWN_MODALS } from "../../../src/core/known-modals.ts";

// Canonical capture text from a real Claude Code feedback survey, as
// observed in the live incident on 2026-05-07 that motivated this
// task (driver-inbox 10:26 MYT).
const FEEDBACK_SURVEY_PANE = `
some prior chat scrollback...

● How is Claude doing this session? (optional)
  1: Bad    2: Fine   3: Good   0: Dismiss
`;

describe("detectKnownModal — feedback-survey", () => {
  test("matches the canonical 4-row prompt → dismisses with '0', no Enter", () => {
    const match = detectKnownModal(FEEDBACK_SURVEY_PANE);
    expect(match).not.toBeNull();
    expect(match?.modal.id).toBe("feedback-survey");
    expect(match?.modal.keys).toBe("0");
    expect(match?.modal.pressEnter).toBe(false);
    expect(match?.evidence).toContain("How is Claude doing this session");
    expect(match?.evidence).toContain("0: Dismiss");
  });

  test("partial capture missing the dismiss row → no match (safety)", () => {
    // Without "0: Dismiss" we don't ratify the dismissal — refuse to
    // guess. This protects against truncated captures + non-standard
    // survey variants where '0' isn't the dismiss key.
    const partial = `
● How is Claude doing this session? (optional)
  1: Bad    2: Fine   3: Good
`;
    expect(detectKnownModal(partial)).toBeNull();
  });

  test("survey with extra whitespace between rows → still matches", () => {
    const spaced = `
● How is Claude doing this session?

  1: Bad

  2: Fine

  3: Good

  0: Dismiss
`;
    expect(detectKnownModal(spaced)?.modal.id).toBe("feedback-survey");
  });

  test("non-survey pane content → no match", () => {
    expect(detectKnownModal("3.4k tokens · esc to interrupt")).toBeNull();
    expect(detectKnownModal("Press up to edit queued messages")).toBeNull();
    expect(detectKnownModal("user@host:~$ ")).toBeNull();
    expect(detectKnownModal("")).toBeNull();
  });

  test("user typed the survey prompt as plain text → still matches (acceptable false-positive)", () => {
    // We accept this: the regex is broad enough that a user pasting the
    // exact 4-row text into the compose box would match. In practice
    // the pane-state classifier returns TYPING (queued-message) before
    // safeSendKeys ever calls detectKnownModal, so this never fires on
    // user input. Test pins the intent so a future regex tightening
    // doesn't break the live survey path.
    const userTyped = `How is Claude doing this session? 1: Bad 2: Fine 3: Good 0: Dismiss`;
    expect(detectKnownModal(userTyped)?.modal.id).toBe("feedback-survey");
  });
});

describe("KNOWN_MODALS catalog invariants", () => {
  test("every entry has stable id + non-empty keys + finite description", () => {
    for (const modal of KNOWN_MODALS) {
      expect(modal.id).toMatch(/^[a-z0-9-]+$/);
      expect(modal.keys.length).toBeGreaterThan(0);
      expect(modal.description.length).toBeGreaterThan(10);
      expect(typeof modal.pressEnter).toBe("boolean");
    }
  });

  test("ids are unique across the catalog", () => {
    const ids = KNOWN_MODALS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("catalog ships at least one entry (feedback-survey)", () => {
    expect(KNOWN_MODALS.length).toBeGreaterThanOrEqual(1);
    expect(KNOWN_MODALS.some((m) => m.id === "feedback-survey")).toBe(true);
  });
});
