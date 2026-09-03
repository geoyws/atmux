// Unit tests for src/core/driver-pane-health.ts — ADR-064 §4.
// Exercises the pair-aware probe path using injected tmux deps.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaneInfo, TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import { probeDriverPane } from "../../../src/core/driver-pane-health.ts";
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

function teamWithoutDriverSession(): Team {
  return {
    name: "team",
    members: [],
  };
}

function teamWithNullDriverSession(): Team {
  return {
    name: "team",
    members: [],
    driverSession: null,
  };
}

function teamWithDriverSession(): Team {
  return {
    name: "team",
    members: [],
    driverSession: { tui: "claude" },
  };
}

function pane(
  overrides: Partial<PaneInfo> & Pick<PaneInfo, "index" | "pid" | "width" | "height">,
): PaneInfo {
  const result: PaneInfo = {
    index: overrides.index,
    pid: overrides.pid,
    title: overrides.title ?? "driver",
    width: overrides.width,
    height: overrides.height,
  };
  if (overrides.id !== undefined) result.id = overrides.id;
  if (overrides.left !== undefined) result.left = overrides.left;
  if (overrides.role !== undefined) result.role = overrides.role;
  return result;
}

function captureFor(targets: Record<string, string>, seen: string[] = []): CaptureFn {
  return async (target: string) => {
    seen.push(target);
    const text = targets[target];
    if (text === undefined) {
      throw new Error(`unexpected capture target: ${target}`);
    }
    return text;
  };
}

describe("probeDriverPane — canonical config and driver-window discovery", () => {
  test("team without driverSession still probes the canonical roster", async () => {
    let listCalled = false;
    const result = await probeDriverPane(teamWithoutDriverSession(), atmuxDir, {
      listWindowNames: async () => {
        listCalled = true;
        return [];
      },
      capture: async () => "",
    });

    expect(result.configured).toBe(true);
    expect(result.windowExists).toBe(false);
    expect(listCalled).toBe(true);
  });

  test("driverSession=null still probes the canonical roster", async () => {
    let listCalled = false;
    const result = await probeDriverPane(teamWithNullDriverSession(), atmuxDir, {
      listWindowNames: async () => {
        listCalled = true;
        return [];
      },
      capture: async () => "",
    });

    expect(result.configured).toBe(true);
    expect(result.windowExists).toBe(false);
    expect(listCalled).toBe(true);
  });

  test("configured but no driver window returns windowExists=false without list-panes or capture", async () => {
    let listPanesCalled = false;
    let captureCalled = false;
    const result = await probeDriverPane(teamWithDriverSession(), atmuxDir, {
      listWindowNames: async () => ["lead", "planner", "reviewer"],
      listPanes: async () => {
        listPanesCalled = true;
        return [];
      },
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
    expect(listPanesCalled).toBe(false);
    expect(captureCalled).toBe(false);
  });

  test("listWindowNames failure fails closed before window probing", async () => {
    let listPanesCalled = false;
    const result = await probeDriverPane(teamWithDriverSession(), atmuxDir, {
      listWindowNames: async () => {
        throw new Error("tmux unreachable");
      },
      listPanes: async () => {
        listPanesCalled = true;
        return [];
      },
      capture: async () => "",
    });

    expect(result.configured).toBe(true);
    expect(result.windowExists).toBe(false);
    expect(result.state).toBeNull();
    expect(result.pairDecision).toBe("unavailable");
    expect(result.pairReason).toBe("pair.observer.list_windows_failed");
    expect(listPanesCalled).toBe(false);
  });
});

describe("probeDriverPane — production-default tmux adapters", () => {
  test("uses tmux.window.listWindows, tmux.pane.listPanes, and captures the worker pane id", async () => {
    let listWindowsSession = "";
    let listPanesTarget = "";
    let captureTarget = "";
    const worker = pane({
      id: "%1",
      index: 1,
      pid: 11,
      left: 4,
      width: 80,
      height: 24,
      role: "worker",
    });
    const attention = pane({
      id: "%2",
      index: 0,
      pid: 10,
      left: 18,
      width: 80,
      height: 24,
      role: "attention",
    });
    const tmux = {
      window: {
        async listWindows(sessionName: string) {
          listWindowsSession = sessionName;
          return [{ index: 0, id: "%1", name: "driver", active: true }];
        },
      },
      pane: {
        async listPanes(target: string) {
          listPanesTarget = target;
          return [attention, worker];
        },
        async capturePane(opts: {
          target: string;
          start?: number;
          end?: number;
          includeAnsi?: boolean;
        }) {
          captureTarget = opts.target;
          return STATE_FIXTURES.READY;
        },
      },
    } as unknown as TmuxNamespace;

    const result = await probeDriverPane(teamWithDriverSession(), atmuxDir, { tmux });

    expect(listWindowsSession).toBe("test-sess");
    expect(listPanesTarget).toBe("test-sess:driver");
    expect(captureTarget).toBe("%1");
    expect(result.configured).toBe(true);
    expect(result.windowExists).toBe(true);
    expect(result.pairDecision).toBe("noop");
    expect(result.pairReason).toBe("pair.two.valid");
    expect(result.state).toBe("READY");
    expect(result.evidence.length).toBeGreaterThan(0);
  });
});

describe("probeDriverPane — valid pair captures the worker pane", () => {
  for (const state of [
    "READY",
    "TYPING",
    "BUSY",
    "COMPACTING",
    "RATE-LIMIT",
    "MODAL",
    "SHELL",
    "UNKNOWN",
  ] as const) {
    test(`attention-first pair still captures worker state=${state}`, async () => {
      const worker = pane({
        id: "%1",
        index: 1,
        pid: 11,
        left: 3,
        width: 80,
        height: 24,
        role: "worker",
      });
      const attention = pane({
        id: "%2",
        index: 0,
        pid: 10,
        left: 20,
        width: 80,
        height: 24,
        role: "attention",
      });
      const seen: string[] = [];
      const result = await probeDriverPane(teamWithDriverSession(), atmuxDir, {
        listWindowNames: async () => ["driver"],
        listPanes: async () => [attention, worker],
        capture: captureFor(
          {
            [worker.id ?? ""]: STATE_FIXTURES[state],
            [attention.id ?? ""]: "Do you want Claude to proceed?\n[y/N]: ",
          },
          seen,
        ),
      });

      expect(result.configured).toBe(true);
      expect(result.windowExists).toBe(true);
      expect(result.pairDecision).toBe("noop");
      expect(result.pairReason).toBe("pair.two.valid");
      expect(seen).toEqual(["%1"]);
      expect(result.state).toBe(state);
      if (state === "UNKNOWN") {
        expect(result.evidence).toBe("");
      } else {
        expect(result.evidence.length).toBeGreaterThan(0);
      }
    });
  }

  test("attention content can never drive the captured state", async () => {
    const worker = pane({
      id: "%1",
      index: 1,
      pid: 11,
      left: 3,
      width: 80,
      height: 24,
      role: "worker",
    });
    const attention = pane({
      id: "%2",
      index: 0,
      pid: 10,
      left: 20,
      width: 80,
      height: 24,
      role: "attention",
    });
    const seen: string[] = [];
    const result = await probeDriverPane(teamWithDriverSession(), atmuxDir, {
      listWindowNames: async () => ["driver"],
      listPanes: async () => [attention, worker],
      capture: captureFor(
        {
          [worker.id ?? ""]: STATE_FIXTURES.READY,
          [attention.id ?? ""]: STATE_FIXTURES.MODAL,
        },
        seen,
      ),
    });

    expect(result.state).toBe("READY");
    expect(result.evidence).not.toContain("Claude to proceed");
    expect(seen).toEqual(["%1"]);
  });
});

describe("probeDriverPane — safe singletons capture the kept pane and expose attention-addition planning", () => {
  test("singleton without a role keeps the pane and reports plan-add-attention", async () => {
    const kept = pane({ id: "%5", index: 0, pid: 21, left: 7, width: 80, height: 24 });
    const seen: string[] = [];
    const result = await probeDriverPane(teamWithDriverSession(), atmuxDir, {
      listWindowNames: async () => ["driver"],
      listPanes: async () => [kept],
      capture: captureFor({ [kept.id ?? ""]: STATE_FIXTURES.TYPING }, seen),
    });

    expect(result.pairDecision).toBe("plan-add-attention");
    expect(result.pairReason).toBe("pair.singleton.safe_absent_role");
    expect(result.pairDiagnostics?.[0]).toContain("unlabelled pane");
    expect(result.state).toBe("TYPING");
    expect(seen).toEqual(["%5"]);
  });

  test("singleton worker keeps the pane and reports plan-add-attention", async () => {
    const kept = pane({
      id: "%5",
      index: 0,
      pid: 21,
      left: 7,
      width: 80,
      height: 24,
      role: "worker",
    });
    const seen: string[] = [];
    const result = await probeDriverPane(teamWithDriverSession(), atmuxDir, {
      listWindowNames: async () => ["driver"],
      listPanes: async () => [kept],
      capture: captureFor({ [kept.id ?? ""]: STATE_FIXTURES.READY }, seen),
    });

    expect(result.pairDecision).toBe("plan-add-attention");
    expect(result.pairReason).toBe("pair.singleton.safe_worker_role");
    expect(result.pairDiagnostics?.[0]).toContain("worker pane");
    expect(result.state).toBe("READY");
    expect(seen).toEqual(["%5"]);
  });
});

describe("probeDriverPane — fail-closed pair shapes never capture", () => {
  test("attention singleton fails closed", async () => {
    const attention = pane({
      id: "%2",
      index: 0,
      pid: 10,
      left: 4,
      width: 80,
      height: 24,
      role: "attention",
    });
    let captureCalled = false;
    const result = await probeDriverPane(teamWithDriverSession(), atmuxDir, {
      listWindowNames: async () => ["driver"],
      listPanes: async () => [attention],
      capture: async () => {
        captureCalled = true;
        return "";
      },
    });

    expect(result.pairDecision).toBe("fail-closed");
    expect(result.pairReason).toBe("pair.singleton.attention_role");
    expect(captureCalled).toBe(false);
  });

  test("unknown singleton role fails closed", async () => {
    const unknown = pane({
      id: "%6",
      index: 0,
      pid: 10,
      left: 4,
      width: 80,
      height: 24,
      role: "planner",
    });
    let captureCalled = false;
    const result = await probeDriverPane(teamWithDriverSession(), atmuxDir, {
      listWindowNames: async () => ["driver"],
      listPanes: async () => [unknown],
      capture: async () => {
        captureCalled = true;
        return "";
      },
    });

    expect(result.pairDecision).toBe("fail-closed");
    expect(result.pairReason).toBe("pair.singleton.unknown_role");
    expect(captureCalled).toBe(false);
  });

  test("missing role in a two-pane pair fails closed", async () => {
    const worker = pane({
      id: "%1",
      index: 0,
      pid: 10,
      left: 2,
      width: 80,
      height: 24,
      role: "worker",
    });
    const missing = pane({
      id: "%11",
      index: 1,
      pid: 11,
      left: 8,
      width: 80,
      height: 24,
    });
    let captureCalled = false;
    const result = await probeDriverPane(teamWithDriverSession(), atmuxDir, {
      listWindowNames: async () => ["driver"],
      listPanes: async () => [worker, missing],
      capture: async () => {
        captureCalled = true;
        return "";
      },
    });

    expect(result.pairDecision).toBe("fail-closed");
    expect(result.pairReason).toBe("pair.two.missing_role");
    expect(captureCalled).toBe(false);
  });

  test("unknown role in a two-pane pair fails closed", async () => {
    const worker = pane({
      id: "%1",
      index: 0,
      pid: 10,
      left: 2,
      width: 80,
      height: 24,
      role: "worker",
    });
    const unknown = pane({
      id: "%6",
      index: 1,
      pid: 11,
      left: 8,
      width: 80,
      height: 24,
      role: "planner",
    });
    let captureCalled = false;
    const result = await probeDriverPane(teamWithDriverSession(), atmuxDir, {
      listWindowNames: async () => ["driver"],
      listPanes: async () => [worker, unknown],
      capture: async () => {
        captureCalled = true;
        return "";
      },
    });

    expect(result.pairDecision).toBe("fail-closed");
    expect(result.pairReason).toBe("pair.two.unknown_role");
    expect(captureCalled).toBe(false);
  });

  test("duplicate workers fail closed", async () => {
    const left = pane({
      id: "%7",
      index: 0,
      pid: 10,
      left: 2,
      width: 80,
      height: 24,
      role: "worker",
    });
    const right = pane({
      id: "%8",
      index: 1,
      pid: 11,
      left: 8,
      width: 80,
      height: 24,
      role: "worker",
    });
    let captureCalled = false;
    const result = await probeDriverPane(teamWithDriverSession(), atmuxDir, {
      listWindowNames: async () => ["driver"],
      listPanes: async () => [left, right],
      capture: async () => {
        captureCalled = true;
        return "";
      },
    });

    expect(result.pairDecision).toBe("fail-closed");
    expect(result.pairReason).toBe("pair.two.duplicate_worker");
    expect(captureCalled).toBe(false);
  });

  test("duplicate attention panes fail closed", async () => {
    const left = pane({
      id: "%7",
      index: 0,
      pid: 10,
      left: 2,
      width: 80,
      height: 24,
      role: "attention",
    });
    const right = pane({
      id: "%8",
      index: 1,
      pid: 11,
      left: 8,
      width: 80,
      height: 24,
      role: "attention",
    });
    let captureCalled = false;
    const result = await probeDriverPane(teamWithDriverSession(), atmuxDir, {
      listWindowNames: async () => ["driver"],
      listPanes: async () => [left, right],
      capture: async () => {
        captureCalled = true;
        return "";
      },
    });

    expect(result.pairDecision).toBe("fail-closed");
    expect(result.pairReason).toBe("pair.two.duplicate_attention");
    expect(captureCalled).toBe(false);
  });

  test("reversed geometry fails closed", async () => {
    const worker = pane({
      id: "%1",
      index: 0,
      pid: 10,
      left: 18,
      width: 80,
      height: 24,
      role: "worker",
    });
    const attention = pane({
      id: "%2",
      index: 1,
      pid: 11,
      left: 3,
      width: 80,
      height: 24,
      role: "attention",
    });
    let captureCalled = false;
    const result = await probeDriverPane(teamWithDriverSession(), atmuxDir, {
      listWindowNames: async () => ["driver"],
      listPanes: async () => [worker, attention],
      capture: async () => {
        captureCalled = true;
        return "";
      },
    });

    expect(result.pairDecision).toBe("fail-closed");
    expect(result.pairReason).toBe("pair.two.reversed_geometry");
    expect(captureCalled).toBe(false);
  });

  test("equal geometry fails closed", async () => {
    const worker = pane({
      id: "%1",
      index: 0,
      pid: 10,
      left: 7,
      width: 80,
      height: 24,
      role: "worker",
    });
    const attention = pane({
      id: "%2",
      index: 1,
      pid: 11,
      left: 7,
      width: 80,
      height: 24,
      role: "attention",
    });
    let captureCalled = false;
    const result = await probeDriverPane(teamWithDriverSession(), atmuxDir, {
      listWindowNames: async () => ["driver"],
      listPanes: async () => [worker, attention],
      capture: async () => {
        captureCalled = true;
        return "";
      },
    });

    expect(result.pairDecision).toBe("fail-closed");
    expect(result.pairReason).toBe("pair.two.reversed_geometry");
    expect(captureCalled).toBe(false);
  });

  test("zero panes fail closed", async () => {
    let captureCalled = false;
    const result = await probeDriverPane(teamWithDriverSession(), atmuxDir, {
      listWindowNames: async () => ["driver"],
      listPanes: async () => [],
      capture: async () => {
        captureCalled = true;
        return "";
      },
    });

    expect(result.pairDecision).toBe("fail-closed");
    expect(result.pairReason).toBe("pair.zero_panes");
    expect(captureCalled).toBe(false);
  });

  test("more than two panes fail closed", async () => {
    const worker = pane({
      id: "%1",
      index: 0,
      pid: 10,
      left: 2,
      width: 80,
      height: 24,
      role: "worker",
    });
    const attention = pane({
      id: "%2",
      index: 1,
      pid: 11,
      left: 8,
      width: 80,
      height: 24,
      role: "attention",
    });
    const extra = pane({
      id: "%9",
      index: 2,
      pid: 12,
      left: 14,
      width: 80,
      height: 24,
      role: "worker",
    });
    let captureCalled = false;
    const result = await probeDriverPane(teamWithDriverSession(), atmuxDir, {
      listWindowNames: async () => ["driver"],
      listPanes: async () => [worker, attention, extra],
      capture: async () => {
        captureCalled = true;
        return "";
      },
    });

    expect(result.pairDecision).toBe("fail-closed");
    expect(result.pairReason).toBe("pair.too_many_panes");
    expect(captureCalled).toBe(false);
  });

  test("missing pane id fails closed before capture", async () => {
    const worker = pane({
      id: "%1",
      index: 0,
      pid: 10,
      left: 2,
      width: 80,
      height: 24,
      role: "worker",
    });
    const missingId = pane({
      index: 1,
      pid: 11,
      left: 8,
      width: 80,
      height: 24,
      role: "attention",
    } as Partial<PaneInfo> & Pick<PaneInfo, "index" | "pid" | "width" | "height">);
    let captureCalled = false;
    const result = await probeDriverPane(teamWithDriverSession(), atmuxDir, {
      listWindowNames: async () => ["driver"],
      listPanes: async () => [worker, missingId],
      capture: async () => {
        captureCalled = true;
        return "";
      },
    });

    expect(result.pairDecision).toBe("fail-closed");
    expect(result.pairReason).toBe("pair.observer.missing_pane_metadata");
    expect(result.windowExists).toBe(true);
    expect(captureCalled).toBe(false);
  });

  test("bogus non-empty tmux pane id fails closed before capture", async () => {
    const bogusId = pane({
      id: "pane-1",
      index: 1,
      pid: 11,
      left: 8,
      width: 80,
      height: 24,
      role: "attention",
    });
    let captureCalled = false;
    const result = await probeDriverPane(teamWithDriverSession(), atmuxDir, {
      listWindowNames: async () => ["driver"],
      listPanes: async () => [bogusId],
      capture: async () => {
        captureCalled = true;
        return "";
      },
    });

    expect(result.pairDecision).toBe("fail-closed");
    expect(result.pairReason).toBe("pair.observer.missing_pane_metadata");
    expect(result.windowExists).toBe(true);
    expect(captureCalled).toBe(false);
  });

  test("missing left geometry fails closed before capture", async () => {
    const worker = pane({
      id: "%1",
      index: 0,
      pid: 10,
      left: 2,
      width: 80,
      height: 24,
      role: "worker",
    });
    const missingLeft = pane({
      id: "%10",
      index: 1,
      pid: 11,
      width: 80,
      height: 24,
      role: "attention",
    } as Partial<PaneInfo> & Pick<PaneInfo, "index" | "pid" | "width" | "height">);
    let captureCalled = false;
    const result = await probeDriverPane(teamWithDriverSession(), atmuxDir, {
      listWindowNames: async () => ["driver"],
      listPanes: async () => [worker, missingLeft],
      capture: async () => {
        captureCalled = true;
        return "";
      },
    });

    expect(result.pairDecision).toBe("fail-closed");
    expect(result.pairReason).toBe("pair.observer.missing_pane_metadata");
    expect(captureCalled).toBe(false);
  });

  test("non-finite left geometry fails closed before capture", async () => {
    const worker = pane({
      id: "%1",
      index: 0,
      pid: 10,
      left: Number.NaN,
      width: 80,
      height: 24,
      role: "worker",
    });
    let captureCalled = false;
    const result = await probeDriverPane(teamWithDriverSession(), atmuxDir, {
      listWindowNames: async () => ["driver"],
      listPanes: async () => [worker],
      capture: async () => {
        captureCalled = true;
        return "";
      },
    });

    expect(result.pairDecision).toBe("fail-closed");
    expect(result.pairReason).toBe("pair.observer.missing_pane_metadata");
    expect(captureCalled).toBe(false);
  });

  test("listPanes failure fails closed before capture", async () => {
    let captureCalled = false;
    const result = await probeDriverPane(teamWithDriverSession(), atmuxDir, {
      listWindowNames: async () => ["driver"],
      listPanes: async () => {
        throw new Error("tmux list-panes failed");
      },
      capture: async () => {
        captureCalled = true;
        return "";
      },
    });

    expect(result.pairDecision).toBe("unavailable");
    expect(result.pairReason).toBe("pair.observer.list_panes_failed");
    expect(result.windowExists).toBe(true);
    expect(captureCalled).toBe(false);
  });
});

describe("probeDriverPane — capture failure on a valid pair stays on the pair decision", () => {
  test("capture throws → pair remains noop + state=null + evidence=''", async () => {
    const worker = pane({
      id: "%1",
      index: 0,
      pid: 10,
      left: 2,
      width: 80,
      height: 24,
      role: "worker",
    });
    const attention = pane({
      id: "%2",
      index: 1,
      pid: 11,
      left: 8,
      width: 80,
      height: 24,
      role: "attention",
    });
    const result = await probeDriverPane(teamWithDriverSession(), atmuxDir, {
      listWindowNames: async () => ["driver"],
      listPanes: async () => [worker, attention],
      capture: async () => {
        throw new Error("capture-pane: pane resizing");
      },
    });

    expect(result).toEqual({
      configured: true,
      windowExists: true,
      state: null,
      evidence: "",
      pairDecision: "noop",
      pairReason: "pair.two.valid",
      pairDiagnostics: [
        "The driver pair is valid and ordered left-to-right.",
        "Run atmux doctor to inspect driver-pane roles and geometry.",
      ],
    });
  });
});
