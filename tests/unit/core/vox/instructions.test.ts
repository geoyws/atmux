// Unit tests for src/core/vox/instructions.ts — ADR-272 Jarvis
// system prompt.
//
// The load-bearing clauses are pinned individually: report-only-what-
// the-tools-returned, the two-states rule (agent-state leads, process-
// state follows), the inferred-process-state "?" marker, confirm-preview
// VERBATIM rule, spawn/git refusal + tell_lead offer, readonly notice
// (present only when readonly), current-team default (mentioned only
// when set), MYT times, last-4 task ids, ≤3-word acknowledgement,
// ambiguous_team read-out.

import { describe, expect, test } from "bun:test";
import { buildInstructions } from "../../../../src/core/vox/instructions.ts";
import { formatProcessStateColumn } from "../../../../src/verbs/status.ts";

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

  // ADR-272 §Supplement — no-invention. Present unconditionally: the
  // disposition to fill a gap does not depend on readonly, on a current
  // team, or on the fleet being non-empty.
  test("report only what the tools returned: no inference, no fusing, no unnamed entities", () => {
    for (const opts of [
      BASE,
      { ...BASE, readonly: true },
      { ...BASE, teams: [], currentTeam: null },
    ]) {
      const s = buildInstructions(opts);
      expect(s).toContain("Say only what the tools returned");
      expect(s).toMatch(/say so plainly instead of inferring it/);
      expect(s).toMatch(/do not fuse two results into one claim/);
      expect(s).toMatch(/never name a team, pane, member, or count no tool gave you/);
      expect(s).toMatch(/empty result is an answer/);
    }
  });

  // ADR-273 §Supplement-6. `team_status` sends the TEXT table, so the
  // model sees BOTH state columns and must be told which one answers the
  // operator's question. "Active" read aloud means "working fine" to a
  // listener, and it is true of a pane blocked forever on a permission
  // prompt — leading with the process column is exactly the misread W6
  // recorded. Present unconditionally: which column answers the question
  // does not depend on readonly or on which teams exist.
  test("two states: the agent-state leads, the process-state is only a process claim", () => {
    for (const opts of [
      BASE,
      { ...BASE, readonly: true },
      { ...BASE, teams: [], currentTeam: null },
    ]) {
      const s = buildInstructions(opts);
      expect(s).toContain("agent-state");
      expect(s).toContain("process-state");
      expect(s).toMatch(/what the agent is DOING/);
      // The trap, named explicitly rather than left to inference.
      expect(s).toMatch(/process-active while its agent is stopped forever on a permission prompt/);
      expect(s).toMatch(/Lead with the agent-state/);
      // Not merely "lead with" — the process word must not be attached to
      // a pane already reported as stuck. A model that reports "be-1 is
      // blocked, process active" hands the listener both halves and lets
      // the reassuring one win.
      expect(s).toMatch(/Do NOT volunteer the process-state/);
      expect(s).toMatch(/not news about a stopped agent/);
      // The evidence line exists so a "why" can be answered from the tool
      // output rather than invented.
      expect(s).toMatch(/evidence line/);
    }
  });

  // The `?` is `CageHealth.inferredFromRender` (51e87b7) rendered by
  // `formatPaneStateColumn`: state read off the pane's render because no
  // agent process could be identified. Unmarked = measured. ADR-273
  // §Supplement-6 renamed the COLUMN to `process-state` (a row now
  // carries two pane states) and prefixed the cell — the marker itself is
  // untouched and the cell still ENDS in `?`, which is what this keys on.
  test('inferred process state: the trailing "?" is explained and must be spoken as unconfirmed', () => {
    for (const opts of [
      BASE,
      { ...BASE, readonly: true },
      { ...BASE, teams: [], currentTeam: null },
    ]) {
      const s = buildInstructions(opts);
      expect(s).toContain('"active?"');
      expect(s).toMatch(/read off the pane's screen/);
      expect(s).toMatch(/no agent process could be identified/);
      expect(s).toContain("unconfirmed");
      expect(s).toMatch(/no question mark was measured/);
      // The clause must name the column it is about — a clause pointing at
      // a column name that no longer renders teaches the model nothing.
      expect(s).toMatch(/A process-state ending in a question mark/);
    }
  });

  // The pin is only worth having if it fails when the marker stops being
  // rendered, so it is anchored to the RENDERER, not just to the prose.
  test("the marker the clause describes is the one the status table prints", () => {
    const s = buildInstructions(BASE);
    const cell = formatProcessStateColumn({
      name: "alpha",
      role: "member",
      tui: "claude",
      paneCommand: "claude",
      cageState: "active",
      pendingCount: 0,
      inProgressCount: 0,
      heartbeat_age_s: null,
      cageInferredFromRender: true,
    });
    // The rendered cell ends in the exact token the prompt quotes.
    expect(cell).toEndWith("active?");
    expect(s).toContain('"active?"');
    // …and a measured row does not.
    expect(
      formatProcessStateColumn({
        name: "alpha",
        role: "member",
        tui: "claude",
        paneCommand: "claude",
        cageState: "active",
        pendingCount: 0,
        inProgressCount: 0,
        heartbeat_age_s: null,
        cageInferredFromRender: false,
      }),
    ).not.toEndWith("?");
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
