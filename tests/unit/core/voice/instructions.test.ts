// Unit tests for src/core/voice/instructions.ts — ADR-272 Jarvis
// system prompt.
//
// The load-bearing clauses are pinned individually: confirm-preview
// VERBATIM rule, spawn/git refusal + tell_lead offer, readonly notice
// (present only when readonly), current-team default (mentioned only
// when set), MYT times, last-4 task ids, ≤3-word acknowledgement,
// ambiguous_team read-out.

import { describe, expect, test } from "bun:test";
import { buildInstructions } from "../../../../src/core/voice/instructions.ts";

const BASE = {
  teams: ["atmux", "sopx-root", "mx-root"],
  currentTeam: "atmux" as string | null,
  readonly: false,
};

describe("buildInstructions — load-bearing clauses", () => {
  test("confirm rule: read the preview VERBATIM; only a clear yes redeems; hedge = no", () => {
    const s = buildInstructions(BASE);
    expect(s).toContain("needs_confirmation");
    expect(s).toContain("VERBATIM");
    expect(s).toContain("clear, unambiguous yes");
    expect(s).toMatch(/Silence, hesitation, a hedge/);
    expect(s).toContain("do not redeem");
  });

  test("spawn/stop/kill + git refusal, with the tell_lead offer", () => {
    const s = buildInstructions(BASE);
    expect(s).toMatch(/cannot spawn, stop, or kill agents/);
    expect(s).toMatch(/cannot touch git/);
    expect(s).toContain("tell_lead");
  });

  test("readonly=true: the mutations-disabled notice is present", () => {
    const s = buildInstructions({ ...BASE, readonly: true });
    expect(s).toContain("Readonly mode is active");
    expect(s).toMatch(/start that reply by saying mutations are disabled/);
  });

  test("readonly=false: no readonly notice", () => {
    const s = buildInstructions(BASE);
    expect(s).not.toContain("Readonly mode is active");
  });

  test("currentTeam set: mentioned as the default for team-scoped tools", () => {
    const s = buildInstructions(BASE);
    expect(s).toContain("The current team is atmux");
    expect(s).toContain("default to it");
    expect(s).not.toContain("No current team is selected");
  });

  test("currentTeam null: omitted; the ask-first clause appears instead", () => {
    const s = buildInstructions({ ...BASE, currentTeam: null });
    expect(s).not.toContain("The current team is");
    expect(s).toContain("No current team is selected");
  });

  test("teams list is spoken into the prompt", () => {
    const s = buildInstructions(BASE);
    expect(s).toContain("Teams in the fleet: atmux, sopx-root, mx-root.");
  });

  test("empty fleet degrades to an explicit no-teams line", () => {
    const s = buildInstructions({ ...BASE, teams: [], currentTeam: null });
    expect(s).toContain("no teams registered");
  });

  test("times are MYT; nowMytIso is included when provided", () => {
    const bare = buildInstructions(BASE);
    expect(bare).toContain("Malaysia time (MYT)");
    expect(bare).not.toContain("session started");
    const stamped = buildInstructions({ ...BASE, nowMytIso: "2026-08-14 15:04 MYT" });
    expect(stamped).toContain("2026-08-14 15:04 MYT");
    expect(stamped).toContain("session started");
  });

  test("task ids by last 4 chars", () => {
    expect(buildInstructions(BASE)).toContain("last 4 characters");
  });

  test("≤3-word acknowledgement before slow tools", () => {
    expect(buildInstructions(BASE)).toContain("three words or fewer");
  });

  test("never read lists/markdown/JSON aloud; 2-3 sentence replies", () => {
    const s = buildInstructions(BASE);
    expect(s).toMatch(/Never read lists, tables, markdown, or JSON aloud/);
    expect(s).toContain("two or three short sentences");
  });

  test("ambiguous_team → read the candidates and ask", () => {
    const s = buildInstructions(BASE);
    expect(s).toContain("ambiguous_team");
    expect(s).toMatch(/read out the candidate team names/);
  });

  test("persona: composed, dry, unhurried", () => {
    const s = buildInstructions(BASE);
    expect(s).toMatch(/composed, dry, and unhurried/);
  });

  test("pure function: same opts → same string", () => {
    expect(buildInstructions(BASE)).toBe(buildInstructions(BASE));
  });
});
