import { describe, expect, test } from "bun:test";
import { MUTATION_FIXTURES } from "../../../../../src/core/vox/e2e/fixtures.ts";
import {
  checkToolGate,
  MUT_TEAM,
  READ_CAGE,
  SCENARIOS,
  type Scenario,
  scenarioById,
  scenarioCageKey,
  scenarioIds,
  scenarioPostconditions,
  scenarioTurns,
} from "../../../../../src/core/vox/e2e/scenarios.ts";

const stub = (expectAnyTool: string[]): Scenario => ({
  id: "x",
  utterance: "u",
  expectAnyTool,
  criteria: [],
});

describe("the scenario table", () => {
  test("covers the read half and the mutating half", () => {
    expect(scenarioIds()).toEqual([
      "attention",
      "all_ok",
      "drilldown",
      "nudge_confirmed",
      "nudge_declined",
      "driver_refused",
      "tell_lead_delivered",
      "confirm_replay",
    ]);
  });

  test("the attention scenario routes to fleet_attention", () => {
    expect(scenarioById("attention")?.expectAnyTool).toContain("fleet_attention");
  });

  test("the all_ok scenario accepts any of the read-only fleet tools", () => {
    expect(scenarioById("all_ok")?.expectAnyTool).toContain("fleet_quiet");
  });

  test("ids are unique and every SPOKEN scenario has an utterance and criteria", () => {
    expect(new Set(scenarioIds()).size).toBe(SCENARIOS.length);
    for (const s of SCENARIOS) {
      expect(s.utterance.length).toBeGreaterThan(0);
      // A protocol scenario is graded by its own assertions, not by a
      // judge, so it carries no criteria — and it must instead carry
      // something that CAN fail, which the next test pins.
      if (s.protocol === undefined) expect(s.criteria.length).toBeGreaterThan(0);
      for (const c of s.criteria) {
        expect(c.id.length).toBeGreaterThan(0);
        expect(c.question.length).toBeGreaterThan(0);
      }
    }
  });

  test("every mutating scenario asserts something about the CAGE", () => {
    // The rule the mutating half rests on: a scenario that enables
    // mutations and then grades itself only on what the assistant SAID is
    // certifying `ok=true` with `ok=true`.
    for (const s of SCENARIOS) {
      if (s.mutations !== true) continue;
      const asserts = (s.postconditions?.length ?? 0) > 0 || s.protocol !== undefined;
      expect(asserts).toBe(true);
    }
  });

  test("only the mutating scenarios opt out of readonly, and each uses a mutation cage", () => {
    for (const s of SCENARIOS) {
      if (s.mutations !== true) {
        expect(scenarioCageKey(s)).toBe(READ_CAGE);
        continue;
      }
      expect(scenarioCageKey(s)).not.toBe(READ_CAGE);
      expect(s.fixtures).toBe(MUTATION_FIXTURES);
    }
  });

  test("the two confirm scenarios differ in exactly one turn", () => {
    // The decline is only evidence about the GATE if it is otherwise
    // identical to the confirmation. If the two asked different questions,
    // a divergent outcome could be attributed to the question.
    const yes = scenarioTurns(scenarioById("nudge_confirmed") as Scenario);
    const no = scenarioTurns(scenarioById("nudge_declined") as Scenario);
    expect(yes.length).toBe(2);
    expect(no.length).toBe(2);
    expect(no[0]).toBe(yes[0] as string);
    expect(no[1]).not.toBe(yes[1] as string);
  });

  test("a single-utterance scenario reports exactly one turn", () => {
    expect(scenarioTurns(scenarioById("attention") as Scenario)).toEqual([
      "What needs my attention right now?",
    ]);
  });

  test("scenarioPostconditions is empty for the read scenarios and populated for the mutating ones", () => {
    expect(scenarioPostconditions(scenarioById("attention") as Scenario).length).toBe(0);
    expect(
      scenarioPostconditions(scenarioById("nudge_confirmed") as Scenario).length,
    ).toBeGreaterThan(0);
  });

  test("the decline scenario asserts ZERO enters on the pane the confirm scenario moves", () => {
    // The pairing that stops the negative being vacuous: the same fixture
    // pane, one scenario proving it moves and one proving it did not.
    const declined = scenarioPostconditions(scenarioById("nudge_declined") as Scenario);
    const confirmed = scenarioPostconditions(scenarioById("nudge_confirmed") as Scenario);
    expect(declined.map((p) => p.id)).toContain(`enters:${MUT_TEAM}/be-1=0`);
    expect(confirmed.map((p) => p.id)).toContain(`enters:${MUT_TEAM}/be-1=1`);
  });

  test("the driver scenario asserts ZERO enters on the driver pane", () => {
    // ADR-239 §D2 is the whole scenario, and it is unfalsifiable from the
    // transcript alone — a model can say anything about what it did.
    const ids = scenarioPostconditions(scenarioById("driver_refused") as Scenario).map((p) => p.id);
    expect(ids).toContain(`enters:${MUT_TEAM}/driver-2=0`);
  });

  test("criterion ids are unique within a scenario", () => {
    for (const s of SCENARIOS) {
      const ids = s.criteria.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  test("the all_ok criteria name the real problems, so 'invented' is checkable", () => {
    const invented = scenarioById("all_ok")?.criteria.find(
      (c) => c.id === "did_not_invent_problems",
    );
    expect(invented?.question).toContain("vox-e2e-alpha/be-1 (permission-prompt)");
    expect(invented?.question).toContain("vox-e2e-alpha/fe-1 (idle-residue)");
  });

  test("an unknown id resolves to null rather than throwing", () => {
    expect(scenarioById("nope")).toBeNull();
  });
});

describe("checkToolGate — the mechanical half", () => {
  test("passes when an expected tool was invoked", () => {
    const r = checkToolGate(stub(["fleet_attention"]), ["list_teams", "fleet_attention"]);
    expect(r.ok).toBe(true);
    expect(r.reason).toBeNull();
  });

  test("fails when none was, and names what it saw", () => {
    const r = checkToolGate(stub(["fleet_attention"]), ["cost_report"]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("expected one of [fleet_attention]");
    expect(r.reason).toContain("invoked [cost_report]");
  });

  test("says 'nothing' when no tool was invoked at all", () => {
    // The interesting failure: a model that answered from thin air. A gate
    // that reported an empty list here would read as though it had passed.
    const r = checkToolGate(stub(["fleet_attention"]), []);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("invoked [nothing]");
  });

  test("an empty expectation opts out of the gate", () => {
    const r = checkToolGate(stub([]), []);
    expect(r.ok).toBe(true);
    expect(r.reason).toBeNull();
  });
});
