// Unit tests for src/core/orchd-log-fmt.ts (e-12-640853f3 §S2 + §S3).

import { describe, expect, test } from "bun:test";
import { formatSweepReport, isoLocalTs, logLine } from "../../../src/core/orchd-log-fmt.ts";
import type { SweepResult } from "../../../src/core/orchd-merge-sweep.ts";

function emptyResult(): SweepResult {
  return {
    epicsConsidered: 0,
    epicsAttended: 0,
    epicsNotReady: 0,
    epicsAlreadyMerged: 0,
    epicsDispatchedMerged: 0,
    epicsDispatchedGateHeld: 0,
    epicsDispatchedSkipped: 0,
    epicsErrored: 0,
    perEpic: [],
  };
}

describe("isoLocalTs", () => {
  test("returns HH:MM:SSZ format", () => {
    const ts = isoLocalTs(new Date("2026-05-24T10:11:12Z"));
    expect(ts).toBe("10:11:12Z");
  });
});

describe("logLine", () => {
  test("formats with bracketed ts + emoji + scope + msg", () => {
    expect(logLine("✅", "sweep", "all good", "10:00:00Z")).toBe(
      "[10:00:00Z] ✅ sweep all good",
    );
  });
});

describe("formatSweepReport — empty result", () => {
  test("single 🧭 header line for no-action sweep", () => {
    const r = emptyResult();
    const out = formatSweepReport(r, "10:00:00Z");
    expect(out).toBe(
      "[10:00:00Z] 🧭 sweep · 0 epics · no action · ready=0 attended=0 not-ready=0 already-merged=0",
    );
  });
});

describe("formatSweepReport — many skip-only epics (the 75-epic atmux case)", () => {
  test("collapses 50×no-decomp + 15×in-planning into rollup, no per-epic lines", () => {
    const r = emptyResult();
    r.epicsConsidered = 65;
    r.epicsNotReady = 65;
    for (let i = 0; i < 50; i += 1) {
      r.perEpic.push({
        epicId: `e-${i.toString().padStart(8, "0")}`,
        outcome: "skipped-not-ready",
        reason: "no tasks or stories",
      });
    }
    for (let i = 0; i < 15; i += 1) {
      r.perEpic.push({
        epicId: `e-x${i.toString().padStart(8, "0")}`,
        outcome: "skipped-not-ready",
        reason: "story status=planning",
      });
    }
    const out = formatSweepReport(r, "10:00:00Z");
    expect(out).toContain("🧭 sweep · 65 epics · no action");
    expect(out).toContain("skips: 50×no-decomp, 15×in-planning");
    // No per-epic lines for skips.
    expect(out.split("\n")).toHaveLength(1);
  });
});

describe("formatSweepReport — dispatch verdicts", () => {
  test("includes per-epic line for merged + emoji ✅ header", () => {
    const r = emptyResult();
    r.epicsConsidered = 2;
    r.epicsDispatchedMerged = 1;
    r.epicsNotReady = 1;
    r.perEpic.push({ epicId: "e-merged-1", outcome: "dispatched-merged" });
    r.perEpic.push({
      epicId: "e-skip-1",
      outcome: "skipped-not-ready",
      reason: "no tasks or stories",
    });
    const out = formatSweepReport(r, "10:00:00Z");
    expect(out).toContain("[10:00:00Z] ✅ sweep · 2 epics · 1 merged");
    expect(out).toContain("✅ sweep:e-merged-1 dispatched-merged");
    // Skipped epic NOT line-by-lined.
    expect(out).not.toContain("e-skip-1 ");
  });

  test("includes 🟡 per-epic line for gate-held + 🟡 header", () => {
    const r = emptyResult();
    r.epicsConsidered = 1;
    r.epicsDispatchedGateHeld = 1;
    r.perEpic.push({
      epicId: "e-blocked-1",
      outcome: "dispatched-gate-held",
      reason: "merge-conflict on packages/foo",
    });
    const out = formatSweepReport(r, "10:00:00Z");
    expect(out).toContain("🟡 sweep · 1 epics · 1 deferred");
    expect(out).toContain(
      "🟡 sweep:e-blocked-1 dispatched-gate-held — merge-conflict on packages/foo",
    );
  });

  test("includes 🔴 per-epic line for errored + 🔴 header", () => {
    const r = emptyResult();
    r.epicsConsidered = 1;
    r.epicsErrored = 1;
    r.perEpic.push({
      epicId: "e-error-1",
      outcome: "errored",
      reason: "subprocess died",
    });
    const out = formatSweepReport(r, "10:00:00Z");
    expect(out).toContain("🔴 sweep · 1 epics · 1 errored");
    expect(out).toContain("🔴 sweep:e-error-1 errored — subprocess died");
  });
});

describe("formatSweepReport — attended bucket rollup", () => {
  test("groups attended-inprogress + attended-grace separately", () => {
    const r = emptyResult();
    r.epicsConsidered = 4;
    r.epicsAttended = 4;
    r.perEpic.push({
      epicId: "e-1",
      outcome: "skipped-attended",
      reason: "2 in-progress task(s)",
    });
    r.perEpic.push({
      epicId: "e-2",
      outcome: "skipped-attended",
      reason: "1 in-progress task(s)",
    });
    r.perEpic.push({
      epicId: "e-3",
      outcome: "skipped-attended",
      reason: "1 task(s) done in last 300s — leaving grace window",
    });
    r.perEpic.push({
      epicId: "e-4",
      outcome: "skipped-attended",
      reason: "1 task(s) done in last 300s — leaving grace window",
    });
    const out = formatSweepReport(r, "10:00:00Z");
    expect(out).toContain("skips: 2×attended-inprogress, 2×attended-grace");
  });
});
