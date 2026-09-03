// Unit tests for doctor.ts::checkDriverPaneState — ADR-064 §4.
// The pair-aware probe should surface layout problems before state
// classification, while legacy fixtures without pair fields still
// follow the state-only path.

import { describe, expect, test } from "bun:test";
import type { DriverPaneHealth } from "../../../src/core/driver-pane-health.ts";
import type { Team } from "../../../src/schema/team.ts";
import { checkDriverPaneState } from "../../../src/verbs/doctor.ts";

const FAKE_TEAM: Team = { name: "team", members: [] };
const FAKE_DIR = "/tmp/fake";

function probe(health: DriverPaneHealth): () => Promise<DriverPaneHealth> {
  return async () => health;
}

describe("checkDriverPaneState — pair-first severity matrix", () => {
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

  test("configured + no window → yellow driver-pane-state + start hint", async () => {
    const rows = await checkDriverPaneState(FAKE_TEAM, FAKE_DIR, {
      probe: probe({ configured: true, windowExists: false, state: null, evidence: "" }),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.label).toBe("driver-pane-state");
    expect(rows[0]?.detail).toBe("team has no live driver window");
    expect(rows[0]?.hint).toBe("run atmux start");
  });

  test("safe singleton with absent role → yellow driver-pane-pair", async () => {
    const rows = await checkDriverPaneState(FAKE_TEAM, FAKE_DIR, {
      probe: probe({
        configured: true,
        windowExists: true,
        state: "READY",
        evidence: "ignored",
        pairDecision: "plan-add-attention",
        pairReason: "pair.singleton.safe_absent_role",
        pairDiagnostics: [
          "A single unlabelled pane is safe to keep.",
          "Run atmux doctor to inspect driver-pane roles and geometry.",
        ],
      }),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.label).toBe("driver-pane-pair");
    expect(rows[0]?.detail).toContain("pair.singleton.safe_absent_role");
    expect(rows[0]?.hint).toBe("run atmux start to add the attention pane");
  });

  test("safe singleton with worker role → yellow driver-pane-pair", async () => {
    const rows = await checkDriverPaneState(FAKE_TEAM, FAKE_DIR, {
      probe: probe({
        configured: true,
        windowExists: true,
        state: "READY",
        evidence: "ignored",
        pairDecision: "plan-add-attention",
        pairReason: "pair.singleton.safe_worker_role",
        pairDiagnostics: [
          "A single worker pane is safe to keep.",
          "Run atmux doctor to inspect driver-pane roles and geometry.",
        ],
      }),
    });
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.label).toBe("driver-pane-pair");
    expect(rows[0]?.detail).toContain("pair.singleton.safe_worker_role");
  });

  test("fail-closed pair → red driver-pane-pair", async () => {
    const rows = await checkDriverPaneState(FAKE_TEAM, FAKE_DIR, {
      probe: probe({
        configured: true,
        windowExists: true,
        state: null,
        evidence: "",
        pairDecision: "fail-closed",
        pairReason: "pair.two.duplicate_worker",
        pairDiagnostics: [
          "Exactly two driver panes cannot both be workers.",
          "Run atmux doctor to inspect driver-pane roles and geometry.",
        ],
      }),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("red");
    expect(rows[0]?.label).toBe("driver-pane-pair");
    expect(rows[0]?.detail).toContain("pair.two.duplicate_worker");
    expect(rows[0]?.hint).toBe("repair the driver-pane layout before starting");
  });

  test("observer failure → red driver-pane-pair", async () => {
    const rows = await checkDriverPaneState(FAKE_TEAM, FAKE_DIR, {
      probe: probe({
        configured: true,
        windowExists: true,
        state: null,
        evidence: "",
        pairDecision: "unavailable",
        pairReason: "pair.observer.list_panes_failed",
        pairDiagnostics: [
          "Driver pane metadata could not be read from tmux.",
          "Run atmux doctor to inspect driver-pane roles and geometry.",
        ],
      }),
    });
    expect(rows[0]?.status).toBe("red");
    expect(rows[0]?.label).toBe("driver-pane-pair");
    expect(rows[0]?.detail).toContain("pair.observer.list_panes_failed");
  });

  test("window-list failure → red driver-pane-pair before no-window", async () => {
    const rows = await checkDriverPaneState(FAKE_TEAM, FAKE_DIR, {
      probe: probe({
        configured: true,
        windowExists: false,
        state: null,
        evidence: "",
        pairDecision: "unavailable",
        pairReason: "pair.observer.list_windows_failed",
        pairDiagnostics: [
          "Driver window metadata could not be read from tmux.",
          "Run atmux doctor to inspect driver-pane roles and geometry.",
        ],
      }),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("red");
    expect(rows[0]?.label).toBe("driver-pane-pair");
    expect(rows[0]?.detail).toContain("pair.observer.list_windows_failed");
    expect(rows[0]?.hint).toBe("repair the driver-pane layout before starting");
  });

  test("noop pair + READY → green driver-pane-state", async () => {
    const rows = await checkDriverPaneState(FAKE_TEAM, FAKE_DIR, {
      probe: probe({
        configured: true,
        windowExists: true,
        state: "READY",
        evidence: "tokens · esc to interrupt",
        pairDecision: "noop",
        pairReason: "pair.two.valid",
        pairDiagnostics: [
          "The driver pair is valid and ordered left-to-right.",
          "Run atmux doctor to inspect driver-pane roles and geometry.",
        ],
      }),
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.status).toBe("green");
    expect(rows[0]?.label).toBe("driver-pane-pair");
    expect(rows[0]?.detail).toContain("pair.two.valid");
    expect(rows[1]?.status).toBe("green");
    expect(rows[1]?.label).toBe("driver-pane-state");
    expect(rows[1]?.detail).toBe("state=READY");
  });

  test("noop pair + RATE-LIMIT → yellow driver-pane-state", async () => {
    const rows = await checkDriverPaneState(FAKE_TEAM, FAKE_DIR, {
      probe: probe({
        configured: true,
        windowExists: true,
        state: "RATE-LIMIT",
        evidence: "You've hit your limit",
        pairDecision: "noop",
        pairReason: "pair.two.valid",
        pairDiagnostics: [
          "The driver pair is valid and ordered left-to-right.",
          "Run atmux doctor to inspect driver-pane roles and geometry.",
        ],
      }),
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.status).toBe("green");
    expect(rows[0]?.label).toBe("driver-pane-pair");
    expect(rows[1]?.status).toBe("yellow");
    expect(rows[1]?.label).toBe("driver-pane-state");
    expect(rows[1]?.detail).toContain("RATE-LIMIT");
  });

  test("noop pair + SHELL → yellow driver-pane-state", async () => {
    const rows = await checkDriverPaneState(FAKE_TEAM, FAKE_DIR, {
      probe: probe({
        configured: true,
        windowExists: true,
        state: "SHELL",
        evidence: "$ ",
        pairDecision: "noop",
        pairReason: "pair.two.valid",
        pairDiagnostics: [
          "The driver pair is valid and ordered left-to-right.",
          "Run atmux doctor to inspect driver-pane roles and geometry.",
        ],
      }),
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.status).toBe("green");
    expect(rows[0]?.label).toBe("driver-pane-pair");
    expect(rows[1]?.status).toBe("yellow");
    expect(rows[1]?.label).toBe("driver-pane-state");
    expect(rows[1]?.detail).toContain("SHELL");
  });

  test("legacy fixture without pair fields still follows the state-only path", async () => {
    const rows = await checkDriverPaneState(FAKE_TEAM, FAKE_DIR, {
      probe: probe({
        configured: true,
        windowExists: true,
        state: "MODAL",
        evidence: "Do you want Claude to proceed?",
      }),
    });
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.label).toBe("driver-pane-state");
    expect(rows[0]?.hint).toBe("answer the modal in the driver pane");
  });

  test("legacy fixture without pair fields and READY still works", async () => {
    const rows = await checkDriverPaneState(FAKE_TEAM, FAKE_DIR, {
      probe: probe({ configured: true, windowExists: true, state: "READY", evidence: "" }),
    });
    expect(rows[0]?.status).toBe("green");
    expect(rows[0]?.label).toBe("driver-pane-state");
  });
});

describe("checkDriverPaneState — single label across all rows", () => {
  test("every produced row uses the expected label for grep-able log searches", async () => {
    const fixtures: DriverPaneHealth[] = [
      { configured: true, windowExists: false, state: null, evidence: "" },
      {
        configured: true,
        windowExists: true,
        state: "READY",
        evidence: "",
        pairDecision: "noop",
        pairReason: "pair.two.valid",
        pairDiagnostics: [
          "The driver pair is valid and ordered left-to-right.",
          "Run atmux doctor to inspect driver-pane roles and geometry.",
        ],
      },
      {
        configured: true,
        windowExists: true,
        state: "RATE-LIMIT",
        evidence: "x",
        pairDecision: "noop",
        pairReason: "pair.two.valid",
        pairDiagnostics: [
          "The driver pair is valid and ordered left-to-right.",
          "Run atmux doctor to inspect driver-pane roles and geometry.",
        ],
      },
      {
        configured: true,
        windowExists: true,
        state: "SHELL",
        evidence: "$",
        pairDecision: "noop",
        pairReason: "pair.two.valid",
        pairDiagnostics: [
          "The driver pair is valid and ordered left-to-right.",
          "Run atmux doctor to inspect driver-pane roles and geometry.",
        ],
      },
      {
        configured: true,
        windowExists: true,
        state: null,
        evidence: "",
        pairDecision: "plan-add-attention",
        pairReason: "pair.singleton.safe_worker_role",
        pairDiagnostics: [
          "A single worker pane is safe to keep.",
          "Run atmux doctor to inspect driver-pane roles and geometry.",
        ],
      },
      {
        configured: true,
        windowExists: true,
        state: null,
        evidence: "",
        pairDecision: "fail-closed",
        pairReason: "pair.two.duplicate_attention",
        pairDiagnostics: [
          "Exactly two driver panes cannot both be attention panes.",
          "Run atmux doctor to inspect driver-pane roles and geometry.",
        ],
      },
    ];
    const labels = [
      "driver-pane-state",
      "driver-pane-pair",
      "driver-pane-pair",
      "driver-pane-pair",
      "driver-pane-pair",
      "driver-pane-pair",
    ];
    for (const [index, h] of fixtures.entries()) {
      const rows = await checkDriverPaneState(FAKE_TEAM, FAKE_DIR, { probe: probe(h) });
      expect(rows[0]?.label).toBe(labels[index]);
    }
  });
});
