// Unit tests for doctor.ts::checkDriverPaneState — ADR-064 §4
// (Task t-c8a70988). Each severity branch exercised with an
// injected probe fixture so the test doesn't need a real tmux.

import { describe, expect, test } from "bun:test";
import type { DriverPaneHealth } from "../../../src/core/driver-pane-health.ts";
import type { Team } from "../../../src/schema/team.ts";
import { checkDriverPaneState } from "../../../src/verbs/doctor.ts";

const FAKE_TEAM: Team = { name: "team", members: [] };
const FAKE_DIR = "/tmp/fake";

function probe(health: DriverPaneHealth): () => Promise<DriverPaneHealth> {
  return async () => health;
}

describe("checkDriverPaneState — severity matrix", () => {
  test("team=null → no rows (defensive guard)", async () => {
    const rows = await checkDriverPaneState(null, FAKE_DIR);
    expect(rows).toHaveLength(0);
  });

  test("configured=false → no rows (unconfigured ≠ broken)", async () => {
    const rows = await checkDriverPaneState(FAKE_TEAM, FAKE_DIR, {
      probe: probe({ configured: false, windowExists: false, state: null, evidence: "" }),
    });
    expect(rows).toHaveLength(0);
  });

  test("configured + no window → yellow with 'config drift' detail + 'atmux start' hint", async () => {
    const rows = await checkDriverPaneState(FAKE_TEAM, FAKE_DIR, {
      probe: probe({ configured: true, windowExists: false, state: null, evidence: "" }),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.label).toBe("driver-pane-state");
    expect(rows[0]?.detail).toContain("driverSession");
    expect(rows[0]?.hint).toBe("run atmux start");
  });

  test("configured + READY → green", async () => {
    const rows = await checkDriverPaneState(FAKE_TEAM, FAKE_DIR, {
      probe: probe({
        configured: true,
        windowExists: true,
        state: "READY",
        evidence: "tokens · esc to interrupt",
      }),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("green");
    expect(rows[0]?.label).toBe("driver-pane-state");
    expect(rows[0]?.detail).toBe("state=READY");
  });

  test("configured + TYPING → green (compose box has text but pane is responsive)", async () => {
    const rows = await checkDriverPaneState(FAKE_TEAM, FAKE_DIR, {
      probe: probe({
        configured: true,
        windowExists: true,
        state: "TYPING",
        evidence: "Press up to edit queued messages",
      }),
    });
    expect(rows[0]?.status).toBe("green");
    expect(rows[0]?.detail).toBe("state=TYPING");
  });

  test("configured + RATE-LIMIT → yellow + 'wait for budget refresh' hint", async () => {
    const rows = await checkDriverPaneState(FAKE_TEAM, FAKE_DIR, {
      probe: probe({
        configured: true,
        windowExists: true,
        state: "RATE-LIMIT",
        evidence: "You've hit your limit",
      }),
    });
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.detail).toContain("RATE-LIMIT");
    expect(rows[0]?.hint).toBe("wait for budget refresh");
  });

  test("configured + MODAL → yellow + 'answer the modal' hint", async () => {
    const rows = await checkDriverPaneState(FAKE_TEAM, FAKE_DIR, {
      probe: probe({
        configured: true,
        windowExists: true,
        state: "MODAL",
        evidence: "Do you want Claude to proceed?",
      }),
    });
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.detail).toContain("MODAL");
    expect(rows[0]?.hint).toBe("answer the modal in the driver pane");
  });

  test("configured + COMPACTING → yellow + 'wait for compaction' hint", async () => {
    const rows = await checkDriverPaneState(FAKE_TEAM, FAKE_DIR, {
      probe: probe({
        configured: true,
        windowExists: true,
        state: "COMPACTING",
        evidence: "Compacting conversation",
      }),
    });
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.detail).toContain("COMPACTING");
    expect(rows[0]?.hint).toBe("wait for compaction to finish");
  });

  test("configured + SHELL → yellow ('unexpected state')", async () => {
    const rows = await checkDriverPaneState(FAKE_TEAM, FAKE_DIR, {
      probe: probe({
        configured: true,
        windowExists: true,
        state: "SHELL",
        evidence: "$ ",
      }),
    });
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.detail).toContain("SHELL");
    expect(rows[0]?.hint).toBe("check the driver pane manually");
  });

  test("configured + UNKNOWN → yellow ('unexpected state')", async () => {
    const rows = await checkDriverPaneState(FAKE_TEAM, FAKE_DIR, {
      probe: probe({
        configured: true,
        windowExists: true,
        state: "UNKNOWN",
        evidence: "",
      }),
    });
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.detail).toContain("UNKNOWN");
  });

  test("configured + state=null (capture failure) → yellow + 'tmux server health' hint", async () => {
    const rows = await checkDriverPaneState(FAKE_TEAM, FAKE_DIR, {
      probe: probe({ configured: true, windowExists: true, state: null, evidence: "" }),
    });
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.detail).toContain("no signal");
    expect(rows[0]?.hint).toBe("check tmux server health");
  });

  test("evidence is truncated to 60 chars in the detail string", async () => {
    const longEvidence = "a".repeat(200);
    const rows = await checkDriverPaneState(FAKE_TEAM, FAKE_DIR, {
      probe: probe({
        configured: true,
        windowExists: true,
        state: "MODAL",
        evidence: longEvidence,
      }),
    });
    // Detail includes the evidence in parens — must contain the
    // 60-char prefix + ellipsis, not the full 200 chars.
    expect(rows[0]?.detail).toContain("a".repeat(60));
    expect(rows[0]?.detail).toContain("…");
    expect(rows[0]?.detail?.length).toBeLessThan(150);
  });
});

describe("checkDriverPaneState — single label across all rows", () => {
  test("every produced row uses label='driver-pane-state' for grep-able log searches", async () => {
    const fixtures: DriverPaneHealth[] = [
      { configured: true, windowExists: false, state: null, evidence: "" },
      { configured: true, windowExists: true, state: "READY", evidence: "" },
      { configured: true, windowExists: true, state: "RATE-LIMIT", evidence: "x" },
      { configured: true, windowExists: true, state: "SHELL", evidence: "$" },
      { configured: true, windowExists: true, state: null, evidence: "" },
    ];
    for (const h of fixtures) {
      const rows = await checkDriverPaneState(FAKE_TEAM, FAKE_DIR, { probe: probe(h) });
      expect(rows[0]?.label).toBe("driver-pane-state");
    }
  });
});
