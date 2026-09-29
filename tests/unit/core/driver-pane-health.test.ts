// Unit tests for src/core/driver-pane-health.ts — ADR-064 §4
// (Task t-c8a70988). Mocks tmux.list-windows + capture-pane via
// injected deps; exercises every {configured × windowExists × 7
// PaneStates} combination plus the failure-mode degradations.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaneInfo, TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import { probeDriverPane, probeDriverPanes } from "../../../src/core/driver-pane-health.ts";
import type { CaptureFn, PaneState } from "../../../src/core/pane-state.ts";
import type { Team } from "../../../src/schema/team.ts";

let teamDir: string;
let atmuxDir: string;

beforeEach(async () => {
  teamDir = await mkdtemp(join(tmpdir(), "atmux-driver-pane-"));
  atmuxDir = join(teamDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  await mkdir(join(atmuxDir, "state"), { recursive: true });
  // Anchor session so getSessionName returns deterministically.
  await writeFile(join(atmuxDir, "state", "session.txt"), "test-sess\n");
});

afterEach(async () => {
  await rm(teamDir, { recursive: true, force: true });
});

// ---------- Fixture text per pane state ----------

const STATE_FIXTURES: Record<PaneState, string> = {
  READY: "│ > \ntok 67k/100  ⏵⏵ auto mode on\n",
  TYPING: "Press up to edit queued messages\n",
  BUSY: "✻ Honking…\n",
  COMPACTING: "Compacting conversation (15%)…\n",
  "RATE-LIMIT": "You've hit your limit on Claude Pro.\n",
  MODAL: "Do you want Claude to proceed?\n[y/N]: ",
  SHELL: "geoyws@hax:~ $ \n",
  UNKNOWN: "some text that matches nothing\n",
};

// ---------- Team factories ----------

function teamWithoutDriverSession(): Team {
  return {
    name: "team",
    members: [],
    drivers: [
      { name: "driver", tui: null, cwd: "." },
      { name: "driver-2", tui: null, cwd: ".atmux/worktrees/driver-2" },
      { name: "driver-3", tui: null, cwd: ".atmux/worktrees/driver-3" },
    ],
    driverPair: {
      layout: "horizontal",
      panes: [
        { role: "worker", side: "left" },
        {
          role: "attention",
          side: "right",
          workflow: "kb-att",
          authority: "decision-only",
          tui: null,
          command: null,
        },
      ],
    },
  };
}

function teamWithDriverSession(): Team {
  return {
    name: "team",
    members: [],
    drivers: [
      { name: "driver", tui: null, cwd: "." },
      { name: "driver-2", tui: null, cwd: ".atmux/worktrees/driver-2" },
      { name: "driver-3", tui: null, cwd: ".atmux/worktrees/driver-3" },
    ],
    driverPair: {
      layout: "horizontal",
      panes: [
        { role: "worker", side: "left" },
        {
          role: "attention",
          side: "right",
          workflow: "kb-att",
          authority: "decision-only",
          tui: null,
          command: null,
        },
      ],
    },
    driverSession: { tui: "claude" },
  };
}

function teamWithNullDriverSession(): Team {
  return {
    name: "team",
    members: [],
    drivers: [
      { name: "driver", tui: null, cwd: "." },
      { name: "driver-2", tui: null, cwd: ".atmux/worktrees/driver-2" },
      { name: "driver-3", tui: null, cwd: ".atmux/worktrees/driver-3" },
    ],
    driverPair: {
      layout: "horizontal",
      panes: [
        { role: "worker", side: "left" },
        {
          role: "attention",
          side: "right",
          workflow: "kb-att",
          authority: "decision-only",
          tui: null,
          command: null,
        },
      ],
    },
    driverSession: null,
  };
}

// ---------- configured=false ----------

describe("probeDriverPane — configured=false short-circuits", () => {
  test("driverSession undefined → no I/O, returns unconfigured snapshot", async () => {
    let listCalled = false;
    let captureCalled = false;
    const result = await probeDriverPane(teamWithoutDriverSession(), atmuxDir, {
      listWindowNames: async () => {
        listCalled = true;
        return [];
      },
      capture: async () => {
        captureCalled = true;
        return "";
      },
    });
    expect(result).toEqual({
      configured: false,
      windowExists: false,
      state: null,
      evidence: "",
    });
    expect(listCalled).toBe(false);
    expect(captureCalled).toBe(false);
  });

  test("driverName override is reflected in the snapshot and capture target", async () => {
    let target = "";
    const result = await probeDriverPane(teamWithDriverSession(), atmuxDir, {
      driverName: "driver-2",
      listWindowNames: async () => ["driver-2"],
      capture: async (t) => {
        target = t;
        return STATE_FIXTURES.READY;
      },
    });
    expect(result.driverName).toBe("driver-2");
    expect(result.windowExists).toBe(true);
    expect(target).toBe("test-sess:driver-2");
  });

  test("driverSession null → unconfigured (same as undefined)", async () => {
    const result = await probeDriverPane(teamWithNullDriverSession(), atmuxDir, {
      listWindowNames: async () => ["driver"],
      capture: async () => STATE_FIXTURES.READY,
    });
    expect(result.configured).toBe(false);
    expect(result.windowExists).toBe(false);
  });
});

// ---------- configured=true, windowExists=false ----------

describe("probeDriverPane — configured but no driver window", () => {
  test("returns windowExists=false + state=null", async () => {
    let captureCalled = false;
    const result = await probeDriverPane(teamWithDriverSession(), atmuxDir, {
      listWindowNames: async () => ["lead", "planner", "reviewer"], // no driver
      capture: async () => {
        captureCalled = true;
        return "";
      },
    });
    expect(result).toEqual({
      configured: true,
      windowExists: false,
      state: null,
      evidence: "",
    });
    // Capture should not be called when window doesn't exist.
    expect(captureCalled).toBe(false);
  });

  test("listWindowNames I/O failure degrades to windowExists=false", async () => {
    const result = await probeDriverPane(teamWithDriverSession(), atmuxDir, {
      listWindowNames: async () => {
        throw new Error("tmux unreachable");
      },
      capture: async () => STATE_FIXTURES.READY,
    });
    expect(result.configured).toBe(true);
    expect(result.windowExists).toBe(false);
    expect(result.state).toBeNull();
  });
});

describe("probeDriverPane — production-default tmux adapters", () => {
  test("uses tmux.window.listWindows and tmux.pane.capturePane when deps omit overrides", async () => {
    const tmux = {
      window: {
        async listWindows(_sessionName: string) {
          return [{ index: 0, id: "%1", name: "driver", active: true }];
        },
      },
      pane: {
        // Pre-pair fixture shape: no pane rows → the probe keeps the
        // legacy window-target capture and leaves pair fields absent.
        async listPanes(_target: string) {
          return [];
        },
        async capturePane(_opts: {
          target: string;
          start?: number;
          end?: number;
          includeAnsi?: boolean;
        }) {
          return STATE_FIXTURES.READY;
        },
      },
    } as unknown as TmuxNamespace;

    const result = await probeDriverPane(teamWithDriverSession(), atmuxDir, { tmux });

    expect(result.configured).toBe(true);
    expect(result.windowExists).toBe(true);
    expect(result.state).toBe("READY");
    expect(result.evidence.length).toBeGreaterThan(0);
  });

  test("tmux.window.listWindows rejection degrades to windowExists=false without capturePane", async () => {
    let captureCalled = false;
    const tmux = {
      window: {
        async listWindows(_sessionName: string) {
          throw new Error("tmux list-windows failed");
        },
      },
      pane: {
        async capturePane(_opts: {
          target: string;
          start?: number;
          end?: number;
          includeAnsi?: boolean;
        }) {
          captureCalled = true;
          return STATE_FIXTURES.READY;
        },
      },
    } as unknown as TmuxNamespace;

    const result = await probeDriverPane(teamWithDriverSession(), atmuxDir, { tmux });

    expect(result).toEqual({
      configured: true,
      windowExists: false,
      state: null,
      evidence: "",
    });
    expect(captureCalled).toBe(false);
  });
});

describe("probeDriverPanes — production-default tmux adapters", () => {
  test("uses tmux.window.listWindows and tmux.pane.capturePane when deps omit overrides", async () => {
    const tmux = {
      window: {
        async listWindows(_sessionName: string) {
          return [
            { index: 0, id: "%1", name: "driver", active: true },
            { index: 1, id: "%2", name: "driver-2", active: false },
            { index: 2, id: "%3", name: "driver-3", active: false },
          ];
        },
      },
      pane: {
        // Pre-pair fixture shape: no pane rows → legacy capture, no pair fields.
        async listPanes(_target: string) {
          return [];
        },
        async capturePane(_opts: {
          target: string;
          start?: number;
          end?: number;
          includeAnsi?: boolean;
        }) {
          return STATE_FIXTURES.READY;
        },
      },
    } as unknown as TmuxNamespace;

    const result = await probeDriverPanes(teamWithDriverSession(), atmuxDir, { tmux });
    expect(result.map((h) => h.driverName)).toEqual(["driver", "driver-2", "driver-3"]);
    expect(result.every((h) => h.state === "READY")).toBe(true);
  });
});

// ---------- configured=true, windowExists=true × all 7 PaneStates ----------

describe("probeDriverPane — windowExists=true × every PaneState", () => {
  for (const state of [
    "READY",
    "TYPING",
    "COMPACTING",
    "RATE-LIMIT",
    "MODAL",
    "SHELL",
    "UNKNOWN",
  ] as const) {
    test(`pane state=${state} surfaces in snapshot`, async () => {
      const fixture = STATE_FIXTURES[state];
      let captureTarget = "";
      const result = await probeDriverPane(teamWithDriverSession(), atmuxDir, {
        listWindowNames: async () => ["driver", "lead"],
        capture: async (target) => {
          captureTarget = target;
          return fixture;
        },
      });
      expect(result.configured).toBe(true);
      expect(result.windowExists).toBe(true);
      expect(result.state).toBe(state);
      // capture target is `<session>:driver`.
      expect(captureTarget).toBe("test-sess:driver");
      // Evidence is non-empty for every state EXCEPT UNKNOWN
      // (UNKNOWN is the no-match fallthrough → evidence="").
      if (state === "UNKNOWN") {
        expect(result.evidence).toBe("");
      } else {
        expect(result.evidence.length).toBeGreaterThan(0);
      }
    });
  }
});

// ---------- capture failure degradations ----------

describe("probeDriverPane — capture failure", () => {
  test("capture throws → windowExists=true + state=null + evidence=''", async () => {
    const result = await probeDriverPane(teamWithDriverSession(), atmuxDir, {
      listWindowNames: async () => ["driver"],
      capture: async () => {
        throw new Error("capture-pane: pane resizing");
      },
    });
    expect(result).toEqual({
      configured: true,
      windowExists: true,
      state: null,
      evidence: "",
    });
  });
});

function driverRoster(count: number): Team["drivers"] {
  return Array.from({ length: count }, (_unused, i) => ({
    name: i === 0 ? "driver" : `driver-${i + 1}`,
    cwd: i === 0 ? "." : `.atmux/worktrees/driver-${i + 1}`,
    tui: null,
  }));
}

describe("probeDriverPanes — roster-shaped probes", () => {
  test("team without driverSession returns unconfigured roster without I/O", async () => {
    const team: Team = {
      name: "team",
      members: [],
      drivers: [
        { name: "driver", tui: null, cwd: "." },
        { name: "driver-2", tui: null, cwd: ".atmux/worktrees/driver-2" },
        { name: "driver-3", tui: null, cwd: ".atmux/worktrees/driver-3" },
      ],
      driverPair: {
        layout: "horizontal",
        panes: [
          { role: "worker", side: "left" },
          {
            role: "attention",
            side: "right",
            workflow: "kb-att",
            authority: "decision-only",
            tui: null,
            command: null,
          },
        ],
      },
    };
    let listCalled = false;
    let captureCalled = false;
    const result = await probeDriverPanes(team, atmuxDir, {
      listWindowNames: async () => {
        listCalled = true;
        return [];
      },
      capture: async () => {
        captureCalled = true;
        return STATE_FIXTURES.READY;
      },
    });
    expect(result.map((h) => h.configured)).toEqual([false, false, false]);
    expect(listCalled).toBe(false);
    expect(captureCalled).toBe(false);
  });

  test("canonical 3-driver roster preserves roster order", async () => {
    const team: Team = {
      name: "team",
      members: [],
      drivers: [
        { name: "driver", tui: null, cwd: "." },
        { name: "driver-2", tui: null, cwd: ".atmux/worktrees/driver-2" },
        { name: "driver-3", tui: null, cwd: ".atmux/worktrees/driver-3" },
      ],
      driverPair: {
        layout: "horizontal",
        panes: [
          { role: "worker", side: "left" },
          {
            role: "attention",
            side: "right",
            workflow: "kb-att",
            authority: "decision-only",
            tui: null,
            command: null,
          },
        ],
      },
      driverSession: { tui: "claude" },
    };
    let listCalls = 0;
    const captureTargets: string[] = [];
    const result = await probeDriverPanes(team, atmuxDir, {
      listWindowNames: async () => {
        listCalls += 1;
        return ["driver", "driver-2", "driver-3"];
      },
      capture: async (target) => {
        captureTargets.push(target);
        return STATE_FIXTURES.READY;
      },
    });
    expect(listCalls).toBe(1);
    expect(result.map((h) => h.driverName)).toEqual(["driver", "driver-2", "driver-3"]);
    expect(captureTargets).toEqual([
      "test-sess:driver",
      "test-sess:driver-2",
      "test-sess:driver-3",
    ]);
  });

  test("10-driver roster preserves declared order", async () => {
    const team: Team = {
      name: "team",
      members: [],
      driverPair: {
        layout: "horizontal",
        panes: [
          { role: "worker", side: "left" },
          {
            role: "attention",
            side: "right",
            workflow: "kb-att",
            authority: "decision-only",
            tui: null,
            command: null,
          },
        ],
      },
      driverSession: { tui: "claude" },
      drivers: driverRoster(10),
    };
    const result = await probeDriverPanes(team, atmuxDir, {
      listWindowNames: async () => [
        "driver",
        "driver-2",
        "driver-3",
        "driver-4",
        "driver-5",
        "driver-6",
        "driver-7",
        "driver-8",
        "driver-9",
        "driver-10",
      ],
      capture: async () => STATE_FIXTURES.READY,
    });
    expect(result.map((h) => h.driverName)).toEqual([
      "driver",
      "driver-2",
      "driver-3",
      "driver-4",
      "driver-5",
      "driver-6",
      "driver-7",
      "driver-8",
      "driver-9",
      "driver-10",
    ]);
  });

  test("driver healthy + driver-2 missing → missing window stays distinct", async () => {
    const team: Team = {
      name: "team",
      members: [],
      drivers: [
        { name: "driver", tui: null, cwd: "." },
        { name: "driver-2", tui: null, cwd: ".atmux/worktrees/driver-2" },
        { name: "driver-3", tui: null, cwd: ".atmux/worktrees/driver-3" },
      ],
      driverPair: {
        layout: "horizontal",
        panes: [
          { role: "worker", side: "left" },
          {
            role: "attention",
            side: "right",
            workflow: "kb-att",
            authority: "decision-only",
            tui: null,
            command: null,
          },
        ],
      },
      driverSession: { tui: "claude" },
    };
    const result = await probeDriverPanes(team, atmuxDir, {
      listWindowNames: async () => ["driver", "driver-3"],
      capture: async () => STATE_FIXTURES.READY,
    });
    expect(result[0]).toMatchObject({
      driverName: "driver",
      configured: true,
      windowExists: true,
      state: "READY",
    });
    expect(result[1]).toMatchObject({
      driverName: "driver-2",
      configured: true,
      windowExists: false,
      state: null,
    });
  });

  test("driver healthy + driver-10 capture malformed → fails closed without capture state", async () => {
    const team: Team = {
      name: "team",
      members: [],
      driverPair: {
        layout: "horizontal",
        panes: [
          { role: "worker", side: "left" },
          {
            role: "attention",
            side: "right",
            workflow: "kb-att",
            authority: "decision-only",
            tui: null,
            command: null,
          },
        ],
      },
      driverSession: { tui: "claude" },
      drivers: driverRoster(10),
    };
    const result = await probeDriverPanes(team, atmuxDir, {
      listWindowNames: async () => [
        "driver",
        "driver-2",
        "driver-3",
        "driver-4",
        "driver-5",
        "driver-6",
        "driver-7",
        "driver-8",
        "driver-9",
        "driver-10",
      ],
      capture: async (target) => {
        if (target.endsWith(":driver-10")) throw new Error("malformed pane capture");
        return STATE_FIXTURES.READY;
      },
    });
    expect(result[9]).toMatchObject({
      driverName: "driver-10",
      configured: true,
      windowExists: true,
      state: null,
      evidence: "",
    });
  });

  test("tmux list-window failure returns every configured driver as missing without capture", async () => {
    const team: Team = {
      name: "team",
      members: [],
      drivers: [
        { name: "driver", tui: null, cwd: "." },
        { name: "driver-2", tui: null, cwd: ".atmux/worktrees/driver-2" },
        { name: "driver-3", tui: null, cwd: ".atmux/worktrees/driver-3" },
      ],
      driverPair: {
        layout: "horizontal",
        panes: [
          { role: "worker", side: "left" },
          {
            role: "attention",
            side: "right",
            workflow: "kb-att",
            authority: "decision-only",
            tui: null,
            command: null,
          },
        ],
      },
      driverSession: { tui: "claude" },
    };
    let captureCalled = false;
    const result = await probeDriverPanes(team, atmuxDir, {
      listWindowNames: async () => {
        throw new Error("tmux list failed");
      },
      capture: async () => {
        captureCalled = true;
        return STATE_FIXTURES.READY;
      },
    });
    expect(result.map((h) => h.windowExists)).toEqual([false, false, false]);
    expect(result.every((h) => h.evidence === "" && h.state === null)).toBe(true);
    expect(captureCalled).toBe(false);
  });

  test("attention window does not drive worker state", async () => {
    const team: Team = {
      name: "team",
      members: [],
      drivers: [
        { name: "driver", tui: null, cwd: "." },
        { name: "driver-2", tui: null, cwd: ".atmux/worktrees/driver-2" },
        { name: "driver-3", tui: null, cwd: ".atmux/worktrees/driver-3" },
      ],
      driverPair: {
        layout: "horizontal",
        panes: [
          { role: "worker", side: "left" },
          {
            role: "attention",
            side: "right",
            workflow: "kb-att",
            authority: "decision-only",
            tui: null,
            command: null,
          },
        ],
      },
      driverSession: { tui: "claude" },
    };
    const captureTargets: string[] = [];
    const result = await probeDriverPanes(team, atmuxDir, {
      listWindowNames: async () => ["driver", "driver-2", "driver-3", "attention"],
      capture: async (target) => {
        captureTargets.push(target);
        if (target.endsWith(":driver")) return STATE_FIXTURES.READY;
        if (target.endsWith(":driver-2")) return STATE_FIXTURES.TYPING;
        return STATE_FIXTURES.SHELL;
      },
    });
    expect(result.map((h) => h.driverName)).toEqual(["driver", "driver-2", "driver-3"]);
    expect(captureTargets).toEqual([
      "test-sess:driver",
      "test-sess:driver-2",
      "test-sess:driver-3",
    ]);
    expect(result[0]?.state).toBe("READY");
    expect(result[1]?.state).toBe("TYPING");
    expect(result[2]?.state).toBe("SHELL");
  });
});

// ---------- target string assembly ----------

describe("probeDriverPane — target uses session anchor", () => {
  test("session resolved via getSessionName + ':driver' suffix", async () => {
    let target = "";
    const dummyCapture: CaptureFn = async (t: string) => {
      target = t;
      return STATE_FIXTURES.READY;
    };
    await probeDriverPane(teamWithDriverSession(), atmuxDir, {
      listWindowNames: async () => ["driver"],
      capture: dummyCapture,
    });
    // session.txt seeded as "test-sess" in beforeEach.
    expect(target).toBe("test-sess:driver");
  });
});

// ---------- ADR-288 pair observation ----------

function pairPane(overrides: Partial<PaneInfo> & Pick<PaneInfo, "left">): PaneInfo {
  return {
    index: 0,
    pid: 111,
    title: "pane",
    width: 80,
    height: 24,
    ...overrides,
  };
}

/** teamWithDriverSession with the ADR-288 rollout gate switched on. */
function materializedTeam(): Team {
  const team = teamWithDriverSession();
  return { ...team, driverPair: { ...team.driverPair, materialize: true } } as Team;
}

describe("probe with driverPair.materialize off (rollout gate)", () => {
  // Live driver windows today often hold two panes with no role metadata
  // (the operator's own left/right split). With the gate off the probe
  // must not look at panes at all: same window-target capture as before
  // the pair runtime, and no pair fields.
  const rolelessSplit = async (): Promise<ReadonlyArray<PaneInfo>> => {
    throw new Error("listPanes must not be called with the gate off");
  };

  test("probeDriverPane never lists panes and classifies the window target", async () => {
    const targets: string[] = [];
    const result = await probeDriverPane(teamWithDriverSession(), atmuxDir, {
      listWindowNames: async () => ["driver"],
      listPanes: rolelessSplit,
      capture: async (target) => {
        targets.push(target);
        return STATE_FIXTURES.READY;
      },
    });
    expect(targets).toEqual(["test-sess:driver"]);
    expect(result.state).toBe("READY");
    expect(result.pairDecision).toBeUndefined();
    expect(result.pairReason).toBeUndefined();
  });

  test("probeDriverPanes never lists panes for any live window", async () => {
    const targets: string[] = [];
    const result = await probeDriverPanes(teamWithDriverSession(), atmuxDir, {
      listWindowNames: async () => ["driver", "driver-2"],
      listPanes: async () => [
        pairPane({ id: "%1", left: 0 }),
        pairPane({ id: "%2", left: 80 }),
        pairPane({ id: "%3", left: 120 }),
      ],
      capture: async (target) => {
        targets.push(target);
        return STATE_FIXTURES.READY;
      },
    });
    expect(targets).toEqual(["test-sess:driver", "test-sess:driver-2"]);
    expect(result.map((r) => r.pairDecision)).toEqual([undefined, undefined, undefined]);
    expect(result.map((r) => r.state)).toEqual(["READY", "READY", null]);
  });
});

describe("probeDriverPane — pair observation", () => {
  test("listPanes rejects → unavailable observer failure, no capture", async () => {
    let captureCalled = false;
    const result = await probeDriverPane(materializedTeam(), atmuxDir, {
      listWindowNames: async () => ["driver"],
      listPanes: async () => {
        throw new Error("tmux unreachable");
      },
      capture: async () => {
        captureCalled = true;
        return STATE_FIXTURES.READY;
      },
    });
    expect(result.windowExists).toBe(true);
    expect(result.state).toBeNull();
    expect(result.pairDecision).toBe("unavailable");
    expect(result.pairReason).toBe("pair.observer.list_panes_failed");
    expect(result.pairDiagnostics?.[1]).toContain("atmux doctor");
    expect(captureCalled).toBe(false);
  });

  test("pane row missing the immutable id → fail-closed, no capture", async () => {
    let captureCalled = false;
    const result = await probeDriverPane(materializedTeam(), atmuxDir, {
      listWindowNames: async () => ["driver"],
      listPanes: async () => [pairPane({ left: 0 })],
      capture: async () => {
        captureCalled = true;
        return STATE_FIXTURES.READY;
      },
    });
    expect(result.pairDecision).toBe("fail-closed");
    expect(result.pairReason).toBe("pair.observer.missing_pane_metadata");
    expect(result.state).toBeNull();
    expect(captureCalled).toBe(false);
  });

  test("three panes → fail-closed too_many_panes, no capture", async () => {
    let captureCalled = false;
    const result = await probeDriverPane(materializedTeam(), atmuxDir, {
      listWindowNames: async () => ["driver"],
      listPanes: async () => [
        pairPane({ id: "%1", left: 0, role: "worker" }),
        pairPane({ id: "%2", left: 40, role: "attention" }),
        pairPane({ id: "%3", left: 80, role: "worker" }),
      ],
      capture: async () => {
        captureCalled = true;
        return STATE_FIXTURES.READY;
      },
    });
    expect(result.pairDecision).toBe("fail-closed");
    expect(result.pairReason).toBe("pair.too_many_panes");
    expect(result.state).toBeNull();
    expect(captureCalled).toBe(false);
  });

  test("valid pair → noop observation and worker pane captured by id", async () => {
    const targets: string[] = [];
    const result = await probeDriverPane(materializedTeam(), atmuxDir, {
      listWindowNames: async () => ["driver"],
      listPanes: async () => [
        pairPane({ id: "%9", left: 40, role: "attention" }),
        pairPane({ id: "%8", left: 0, role: "worker" }),
      ],
      capture: async (t) => {
        targets.push(t);
        return STATE_FIXTURES.READY;
      },
    });
    expect(result.pairDecision).toBe("noop");
    expect(result.pairReason).toBe("pair.two.valid");
    expect(result.state).toBe("READY");
    expect(targets).toEqual(["%8"]);
  });

  test("safe singleton → plan-add-attention and keep pane captured by id", async () => {
    const targets: string[] = [];
    const result = await probeDriverPane(materializedTeam(), atmuxDir, {
      listWindowNames: async () => ["driver"],
      listPanes: async () => [pairPane({ id: "%7", left: 0, role: "worker" })],
      capture: async (t) => {
        targets.push(t);
        return STATE_FIXTURES.SHELL;
      },
    });
    expect(result.pairDecision).toBe("plan-add-attention");
    expect(result.pairReason).toBe("pair.singleton.safe_worker_role");
    expect(result.state).toBe("SHELL");
    expect(targets).toEqual(["%7"]);
  });

  test("capture failure keeps the pair observation with state=null", async () => {
    const result = await probeDriverPane(materializedTeam(), atmuxDir, {
      listWindowNames: async () => ["driver"],
      listPanes: async () => [
        pairPane({ id: "%8", left: 0, role: "worker" }),
        pairPane({ id: "%9", left: 40, role: "attention" }),
      ],
      capture: async () => {
        throw new Error("transient tmux error");
      },
    });
    expect(result.pairDecision).toBe("noop");
    expect(result.pairReason).toBe("pair.two.valid");
    expect(result.state).toBeNull();
  });

  test("legacy [] listing → window-target capture and absent pair fields", async () => {
    const targets: string[] = [];
    const result = await probeDriverPane(materializedTeam(), atmuxDir, {
      listWindowNames: async () => ["driver"],
      listPanes: async () => [],
      capture: async (t) => {
        targets.push(t);
        return STATE_FIXTURES.READY;
      },
    });
    expect(result.pairDecision).toBeUndefined();
    expect(result.state).toBe("READY");
    expect(targets).toEqual(["test-sess:driver"]);
  });
});

describe("probeDriverPanes — pair observation per window", () => {
  test("mixed roster: noop + fail-closed + missing stay distinct", async () => {
    const targets: string[] = [];
    const result = await probeDriverPanes(materializedTeam(), atmuxDir, {
      listWindowNames: async () => ["driver", "driver-2"],
      listPanes: async (target) => {
        if (target === "test-sess:driver") {
          return [
            pairPane({ id: "%8", left: 0, role: "worker" }),
            pairPane({ id: "%9", left: 40, role: "attention" }),
          ];
        }
        return [
          pairPane({ id: "%10", left: 0, role: "worker" }),
          pairPane({ id: "%11", left: 40, role: "attention" }),
          pairPane({ id: "%12", left: 80 }),
        ];
      },
      capture: async (t) => {
        targets.push(t);
        return STATE_FIXTURES.READY;
      },
    });
    expect(result.map((h) => h.driverName)).toEqual(["driver", "driver-2", "driver-3"]);
    expect(result[0]?.pairDecision).toBe("noop");
    expect(result[0]?.state).toBe("READY");
    expect(result[1]?.pairDecision).toBe("fail-closed");
    expect(result[1]?.pairReason).toBe("pair.too_many_panes");
    expect(result[1]?.state).toBeNull();
    expect(result[2]?.windowExists).toBe(false);
    expect(result[2]?.pairDecision).toBeUndefined();
    expect(targets).toEqual(["%8"]);
  });

  test("listPanes rejects → unavailable per live window", async () => {
    const result = await probeDriverPanes(materializedTeam(), atmuxDir, {
      listWindowNames: async () => ["driver"],
      listPanes: async () => {
        throw new Error("tmux unreachable");
      },
      capture: async () => STATE_FIXTURES.READY,
    });
    expect(result[0]?.pairDecision).toBe("unavailable");
    expect(result[0]?.pairReason).toBe("pair.observer.list_panes_failed");
    expect(result[0]?.state).toBeNull();
  });

  test("incomplete metadata fails a single window closed without capture", async () => {
    let captureCalled = false;
    const result = await probeDriverPanes(materializedTeam(), atmuxDir, {
      listWindowNames: async () => ["driver"],
      listPanes: async () => [pairPane({ id: "%8", left: 0 }), pairPane({ left: 40 })],
      capture: async () => {
        captureCalled = true;
        return STATE_FIXTURES.READY;
      },
    });
    expect(result[0]?.pairDecision).toBe("fail-closed");
    expect(result[0]?.pairReason).toBe("pair.observer.missing_pane_metadata");
    expect(captureCalled).toBe(false);
  });

  test("capture failure keeps the pair observation with state=null", async () => {
    const result = await probeDriverPanes(materializedTeam(), atmuxDir, {
      listWindowNames: async () => ["driver"],
      listPanes: async () => [pairPane({ id: "%8", left: 0 })],
      capture: async () => {
        throw new Error("transient tmux error");
      },
    });
    expect(result[0]?.pairDecision).toBe("plan-add-attention");
    expect(result[0]?.state).toBeNull();
  });
});
