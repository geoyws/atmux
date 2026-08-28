// The fixtures are the judge's ground truth, so they must mean what they
// claim. Every assertion here runs the fixture text through the REAL
// classifier — the same function the live sweep uses — so a fixture that
// drifts (or a classifier change that reclassifies one) fails the unit
// suite instead of quietly making the judge grade against a lie.

import { describe, expect, test } from "bun:test";
import { classifyText, RETRY_POLICY } from "../../../../../src/core/pane-state.ts";
import {
  attentionPanes,
  groundTruthBriefing,
  MUTATION_FIXTURES,
  requiredStaleSec,
  TEAM_FIXTURES,
  teamName,
} from "../../../../../src/core/vox/e2e/fixtures.ts";
import { FAKE_TEAM_PREFIX } from "../../../../../src/core/vox/e2e/isolation.ts";
import {
  CLASSIFY_TAIL_LINES,
  classifyPaneObservation,
  extractComposerResidue,
  type PaneObservation,
} from "../../../../../src/core/vox/fleet.ts";

function observe(
  overrides: Partial<PaneObservation> & Pick<PaneObservation, "capture">,
): PaneObservation {
  return {
    team: "vox-e2e-alpha",
    member: "m",
    windowName: "m",
    sessionUp: true,
    windowPresent: true,
    paneDead: false,
    currentCommand: "sleep",
    activityAgeSec: 5,
    ...overrides,
  };
}

describe("voice e2e fixtures — classifier agreement", () => {
  for (const team of TEAM_FIXTURES) {
    for (const pane of team.panes) {
      test(`${teamName(team)}/${pane.member} classifies as ${pane.expect.bucket}/${pane.expect.kind}`, () => {
        // Age the window past this fixture's staleness requirement, exactly
        // as the harness does before it asks the question.
        const activityAgeSec = pane.minStaleSec > 0 ? pane.minStaleSec + 5 : 5;
        const verdict = classifyPaneObservation(
          observe({
            team: teamName(team),
            member: pane.member,
            windowName: pane.member,
            capture: pane.text,
            activityAgeSec,
          }),
        );
        expect(verdict.bucket).toBe(pane.expect.bucket);
        expect(verdict.kind).toBe(pane.expect.kind);
      });
    }
  }

  test("the ghost team has no panes — its `dead` verdict comes from an absent session", () => {
    const ghost = TEAM_FIXTURES.find((t) => t.kind === "ghost");
    expect(ghost).toBeDefined();
    expect(ghost?.panes.length).toBe(0);
    const verdict = classifyPaneObservation(observe({ capture: null, sessionUp: false }));
    expect(verdict.bucket).toBe("attention");
    expect(verdict.kind).toBe("dead");
  });
});

describe("voice e2e fixtures — the staleness requirement is load-bearing", () => {
  test("residue in a freshly-touched window is TYPING, not a wedge", () => {
    // If this ever stops holding, the harness's wait is pointless and the
    // wedged pane would be reported as quiet — a silent false negative.
    const wedged = TEAM_FIXTURES[0]?.panes.find((p) => p.expect.kind === "idle-residue");
    expect(wedged).toBeDefined();
    expect(wedged?.minStaleSec).toBeGreaterThan(60);
    const fresh = classifyPaneObservation(
      observe({ capture: wedged?.text ?? "", activityAgeSec: 1 }),
    );
    expect(fresh.bucket).toBe("quiet");
  });

  test("requiredStaleSec is the max across fixtures", () => {
    expect(requiredStaleSec()).toBe(70);
  });
});

describe("voice e2e fixtures — residue text is clean", () => {
  test("the composer residue carries no box-drawing characters", () => {
    // A trailing `│` swallowed into the capture group would be read back to
    // the operator as part of what they supposedly typed.
    const wedged = TEAM_FIXTURES[0]?.panes.find((p) => p.expect.kind === "idle-residue");
    const residue = extractComposerResidue(wedged?.text ?? "");
    expect(residue).toBe("also add the rollback path before you push");
  });

  test("the healthy pane's empty composer yields no residue", () => {
    const healthy = TEAM_FIXTURES[0]?.panes.find((p) => p.expect.kind === "working");
    expect(extractComposerResidue(healthy?.text ?? "")).toBeNull();
  });
});

describe("mutation fixtures — classifier agreement, before AND after", () => {
  for (const team of MUTATION_FIXTURES) {
    for (const pane of team.panes) {
      test(`${teamName(team)}/${pane.member} starts as ${pane.expect.bucket}/${pane.expect.kind}`, () => {
        const verdict = classifyPaneObservation(
          observe({
            team: teamName(team),
            member: pane.member,
            windowName: pane.member,
            capture: pane.text,
            // The interactive panes run a shell `read` loop for their
            // whole life, so `pane_current_command` is `sh`, not `sleep`.
            // Asserted with the REAL command so a classifier change that
            // started reading a bare shell as a dead TUI would fail here
            // rather than in a $0.15 live run.
            currentCommand: pane.after === undefined ? "sleep" : "sh",
          }),
        );
        expect(verdict.bucket).toBe(pane.expect.bucket);
        expect(verdict.kind).toBe(pane.expect.kind);
      });

      if (pane.after !== undefined) {
        const after = pane.after;
        test(`${teamName(team)}/${pane.member} repaints to ${after.expect.bucket}/${after.expect.kind}`, () => {
          const verdict = classifyPaneObservation(
            observe({
              team: teamName(team),
              member: pane.member,
              windowName: pane.member,
              capture: after.text,
              currentCommand: "sh",
            }),
          );
          expect(verdict.bucket).toBe(after.expect.bucket);
          expect(verdict.kind).toBe(after.expect.kind);
        });

        test(`${teamName(team)}/${pane.member}'s repaint pushes the modal out of the classifier tail`, () => {
          // The subtle one. `capture-pane -S -40` returns scrollback, so
          // after the repaint the capture still CONTAINS the modal — the
          // classifier only ignores it because the repaint is longer than
          // `CLASSIFY_TAIL_LINES`. A shorter repaint would leave a pane
          // that genuinely moved still classifying as blocked, and the
          // receipt would then lie in the pessimistic direction.
          const lines = after.text.split("\n").length;
          expect(lines).toBeGreaterThanOrEqual(CLASSIFY_TAIL_LINES);
          const scrollback = `${pane.text}\n${after.text}`;
          const verdict = classifyPaneObservation(
            observe({ capture: scrollback, currentCommand: "sh" }),
          );
          expect(verdict.bucket).toBe(after.expect.bucket);
          expect(verdict.kind).toBe(after.expect.kind);
        });
      }
    }
  }

  test("the mutation cage needs no staleness wait at all", () => {
    // No residue fixture ⇒ zero top-up, which is what keeps a cage per
    // mutating scenario affordable.
    expect(requiredStaleSec(MUTATION_FIXTURES)).toBe(0);
  });

  test("it carries a team-lead, or tell_lead would refuse before writing anything", () => {
    const lead = MUTATION_FIXTURES[0]?.panes.find((p) => p.role === "team-lead");
    expect(lead?.member).toBe("lead");
  });

  test("the lead pane is READY under the SEND-side classifier, not BUSY", () => {
    // Two different ladders read this pane. The fleet classifier decides
    // what the assistant SAYS about it; `classifyText` decides how long
    // `atmux send` WAITS before pinging it, and a BUSY verdict costs
    // `RETRY_POLICY.BUSY` = 5s × 6 = 25s — past vox's 20s toolTimeoutMs,
    // so `tell_lead` returns `tool_timeout`, the model retries, and the
    // ask lands twice. Measured at 25550ms/25541ms before this fixture
    // was corrected; pinned here so it cannot regress into another live
    // run's bill. See ADR-272 §Supplement E6.
    const lead = MUTATION_FIXTURES[0]?.panes.find((p) => p.member === "lead");
    expect(classifyText(lead?.text ?? "").state).toBe("READY");
  });

  test("the panes a nudge targets are MODAL, which the send path does NOT poll", () => {
    // The same ladder, the other way round: MODAL has maxAttempts 0, so a
    // nudge into a permission prompt is not delayed at all. That is why
    // `pane_nudge` fits inside the tool timeout while `tell_lead` on a
    // busy lead does not.
    for (const member of ["be-1", "be-2", "driver-2"]) {
      const pane = MUTATION_FIXTURES[0]?.panes.find((p) => p.member === member);
      expect(classifyText(pane?.text ?? "").state).toBe("MODAL");
      expect(RETRY_POLICY.MODAL.maxAttempts).toBe(0);
    }
  });

  test("every pane a mutating scenario targets keeps a receipt", () => {
    // A pane with no `after` keeps no receipt, so an assertion about it
    // could never observe an Enter — the definition of a vacuous negative.
    for (const member of ["be-1", "be-2", "driver-2"]) {
      const pane = MUTATION_FIXTURES[0]?.panes.find((p) => p.member === member);
      expect(pane?.after).toBeDefined();
    }
  });

  test("the briefing describes the mutation cage, not the read cage", () => {
    const briefing = groundTruthBriefing(MUTATION_FIXTURES);
    expect(briefing).toContain("vox-e2e-bravo");
    expect(briefing).not.toContain("vox-e2e-alpha");
    expect(briefing).toContain("driver-2");
  });

  test("attentionPanes over the mutation cage names the three blocked panes", () => {
    expect(attentionPanes(MUTATION_FIXTURES)).toEqual([
      { team: "vox-e2e-bravo", member: "be-1", kind: "permission-prompt" },
      { team: "vox-e2e-bravo", member: "be-2", kind: "permission-prompt" },
      { team: "vox-e2e-bravo", member: "driver-2", kind: "permission-prompt" },
    ]);
  });
});

describe("voice e2e fixtures — shape", () => {
  test("every team name carries the fake prefix", () => {
    for (const team of TEAM_FIXTURES) {
      expect(teamName(team).startsWith(FAKE_TEAM_PREFIX)).toBe(true);
    }
  });

  test("attentionPanes lists exactly the panes that need the operator", () => {
    const panes = attentionPanes();
    expect(panes).toEqual([
      { team: "vox-e2e-alpha", member: "be-1", kind: "permission-prompt" },
      { team: "vox-e2e-alpha", member: "fe-1", kind: "idle-residue" },
    ]);
  });

  test("the briefing names every team and pane, and forbids inventing others", () => {
    const briefing = groundTruthBriefing();
    for (const team of TEAM_FIXTURES) {
      expect(briefing).toContain(teamName(team));
      for (const pane of team.panes) expect(briefing).toContain(pane.member);
    }
    expect(briefing).toContain("hallucination");
  });

  test("exactly one live team and one ghost team", () => {
    expect(TEAM_FIXTURES.filter((t) => t.kind === "live").length).toBe(1);
    expect(TEAM_FIXTURES.filter((t) => t.kind === "ghost").length).toBe(1);
  });
});
