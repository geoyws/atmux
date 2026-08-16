import { describe, expect, test } from "bun:test";
import {
  checkToolGate,
  SCENARIOS,
  type Scenario,
  scenarioById,
  scenarioIds,
} from "../../../../../src/core/voice/e2e/scenarios.ts";

const stub = (expectAnyTool: string[]): Scenario => ({
  id: "x",
  utterance: "u",
  expectAnyTool,
  criteria: [],
});

describe("the scenario table", () => {
  test("covers attention, reassurance, and a drill-down", () => {
    expect(scenarioIds()).toEqual(["attention", "all_ok", "drilldown"]);
  });

  test("the attention scenario routes to fleet_attention", () => {
    expect(scenarioById("attention")?.expectAnyTool).toContain("fleet_attention");
  });

  test("the all_ok scenario accepts any of the read-only fleet tools", () => {
    expect(scenarioById("all_ok")?.expectAnyTool).toContain("fleet_quiet");
  });

  test("ids are unique and every scenario has an utterance and criteria", () => {
    expect(new Set(scenarioIds()).size).toBe(SCENARIOS.length);
    for (const s of SCENARIOS) {
      expect(s.utterance.length).toBeGreaterThan(0);
      expect(s.criteria.length).toBeGreaterThan(0);
      for (const c of s.criteria) {
        expect(c.id.length).toBeGreaterThan(0);
        expect(c.question.length).toBeGreaterThan(0);
      }
    }
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
    expect(invented?.question).toContain("voice-e2e-alpha/be-1 (permission-prompt)");
    expect(invented?.question).toContain("voice-e2e-alpha/fe-1 (idle-residue)");
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
