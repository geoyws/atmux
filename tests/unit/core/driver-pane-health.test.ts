// Unit tests for src/core/driver-pane-health.ts — ADR-064 §4
// (Task t-c8a70988). Mocks tmux.list-windows + capture-pane via
// injected deps; exercises every {configured × windowExists × 7
// PaneStates} combination plus the failure-mode degradations.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TmuxNamespace } from "../../../src/abstractions/tmux.ts";
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

// ---------- Team factories ----------

function teamWithoutDriverSession(): Team {
  return {
    name: "team",
    members: [],
  };
}

function teamWithDriverSession(): Team {
  return {
    name: "team",
    members: [],
    driverSession: { tui: "claude" },
  };
}

function teamWithNullDriverSession(): Team {
  return {
    name: "team",
    members: [],
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
