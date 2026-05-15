// Unit tests for src/core/superdoctor-cage-verdict.ts (t-72a6b7d7 / c-a99bf461).

import { describe, expect, test } from "bun:test";
import type { CockpitTeamCageMode } from "../../../src/schema/cockpit.ts";
import { verdictForCage } from "../../../src/core/superdoctor-cage-verdict.ts";

describe("verdictForCage — cross-product of cageMode × sessionAlive", () => {
  // ---------- autonomous (default) ----------

  test("autonomous + sessionAlive=true → green (cage healthy)", () => {
    const r = verdictForCage("autonomous", true);
    expect(r.verdict).toBe("green");
    expect(r.reason).toContain("cage healthy");
    expect(r.actionable).toBe(false);
  });

  test("autonomous + sessionAlive=false → RED (anomaly — needs action)", () => {
    const r = verdictForCage("autonomous", false);
    expect(r.verdict).toBe("red");
    expect(r.reason).toContain("cage missing");
    expect(r.reason).toContain("autonomous");
    expect(r.actionable).toBe(true);
  });

  test("cageMode undefined (legacy config) defaults to autonomous semantics", () => {
    // ACCEPTANCE: a cockpit.json with no `cageMode` field on a team
    // (the pre-flag state, every legacy roster) gets the same verdict
    // as if it were explicitly `autonomous`. Back-compat invariant.
    const explicit = verdictForCage("autonomous", false);
    const implicit = verdictForCage(undefined, false);
    expect(implicit).toEqual(explicit);

    const explicitOk = verdictForCage("autonomous", true);
    const implicitOk = verdictForCage(undefined, true);
    expect(implicitOk).toEqual(explicitOk);
  });

  // ---------- direct ----------

  test("direct + sessionAlive=false → GREEN (operator intent — no cage by design)", () => {
    const r = verdictForCage("direct", false);
    expect(r.verdict).toBe("green");
    expect(r.reason).toContain("direct-driver");
    expect(r.actionable).toBe(false);
  });

  test("direct + sessionAlive=true → yellow (unexpected cage, confirm intent)", () => {
    const r = verdictForCage("direct", true);
    expect(r.verdict).toBe("yellow");
    expect(r.reason).toContain("direct-driver");
    expect(r.reason).toContain("unexpected");
    expect(r.actionable).toBe(false);
  });

  // ---------- paused ----------

  test("paused + sessionAlive=false → yellow (informational — restart on rebuild)", () => {
    const r = verdictForCage("paused", false);
    expect(r.verdict).toBe("yellow");
    expect(r.reason).toContain("paused");
    expect(r.reason).toContain("rebuild");
    expect(r.actionable).toBe(false);
  });

  test("paused + sessionAlive=true → yellow (live cage on paused team — drift)", () => {
    const r = verdictForCage("paused", true);
    expect(r.verdict).toBe("yellow");
    expect(r.reason).toContain("paused");
    expect(r.reason).toContain("live cage");
    expect(r.actionable).toBe(false);
  });

  // ---------- Invariants across the 6-cell cross-product ----------

  test("RED verdict is ONLY emitted by autonomous + sessionAlive=false (the c-a99bf461 anomaly)", () => {
    const modes: ReadonlyArray<CockpitTeamCageMode> = ["autonomous", "direct", "paused"];
    for (const mode of modes) {
      for (const alive of [true, false]) {
        const r = verdictForCage(mode, alive);
        if (mode === "autonomous" && alive === false) {
          expect(r.verdict).toBe("red");
        } else {
          expect(r.verdict).not.toBe("red");
        }
      }
    }
  });

  test("actionable=true is ONLY set on the RED branch (informational rows never escalate)", () => {
    const modes: ReadonlyArray<CockpitTeamCageMode> = ["autonomous", "direct", "paused"];
    for (const mode of modes) {
      for (const alive of [true, false]) {
        const r = verdictForCage(mode, alive);
        if (r.verdict === "red") {
          expect(r.actionable).toBe(true);
        } else {
          expect(r.actionable).toBe(false);
        }
      }
    }
  });

  test("reason strings are stable + non-empty across the cross-product", () => {
    const modes: ReadonlyArray<CockpitTeamCageMode> = ["autonomous", "direct", "paused"];
    for (const mode of modes) {
      for (const alive of [true, false]) {
        const r = verdictForCage(mode, alive);
        expect(typeof r.reason).toBe("string");
        expect(r.reason.length).toBeGreaterThan(0);
      }
    }
  });
});
