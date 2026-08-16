// The fixtures are the judge's ground truth, so they must mean what they
// claim. Every assertion here runs the fixture text through the REAL
// classifier — the same function the live sweep uses — so a fixture that
// drifts (or a classifier change that reclassifies one) fails the unit
// suite instead of quietly making the judge grade against a lie.

import { describe, expect, test } from "bun:test";
import {
  attentionPanes,
  groundTruthBriefing,
  requiredStaleSec,
  TEAM_FIXTURES,
  teamName,
} from "../../../../../src/core/voice/e2e/fixtures.ts";
import { FAKE_TEAM_PREFIX } from "../../../../../src/core/voice/e2e/isolation.ts";
import {
  classifyPaneObservation,
  extractComposerResidue,
  type PaneObservation,
} from "../../../../../src/core/voice/fleet.ts";

function observe(
  overrides: Partial<PaneObservation> & Pick<PaneObservation, "capture">,
): PaneObservation {
  return {
    team: "voice-e2e-alpha",
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

describe("voice e2e fixtures — shape", () => {
  test("every team name carries the fake prefix", () => {
    for (const team of TEAM_FIXTURES) {
      expect(teamName(team).startsWith(FAKE_TEAM_PREFIX)).toBe(true);
    }
  });

  test("attentionPanes lists exactly the panes that need the operator", () => {
    const panes = attentionPanes();
    expect(panes).toEqual([
      { team: "voice-e2e-alpha", member: "be-1", kind: "permission-prompt" },
      { team: "voice-e2e-alpha", member: "fe-1", kind: "idle-residue" },
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
