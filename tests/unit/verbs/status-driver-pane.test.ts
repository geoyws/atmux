// Unit tests for status.ts driver-pane integration — ADR-064 §4
// (Task t-c8a70988). Exercises gatherStatus's driver-pane probe via
// a fake tmux namespace; asserts the snapshot field is populated and
// surfaces in the JSON output. Text-render assertion stays observational
// via stdout capture (renderTextStatus is module-private).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import type { DriverPaneHealth } from "../../../src/core/driver-pane-health.ts";
import type { Team } from "../../../src/schema/team.ts";
import {
  gatherStatus,
  renderTextStatus,
  type StatusSnapshot,
  status,
} from "../../../src/verbs/status.ts";

let teamDir: string;
let atmuxDir: string;

beforeEach(async () => {
  teamDir = await mkdtemp(join(tmpdir(), "atmux-status-driver-"));
  atmuxDir = join(teamDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  await mkdir(join(atmuxDir, "state"), { recursive: true });
  await writeFile(join(atmuxDir, "state", "session.txt"), "test-sess\n");
});

afterEach(async () => {
  await rm(teamDir, { recursive: true, force: true });
});

// ---------- Fake tmux namespace ----------

interface FakeTmuxOpts {
  /** Map of `<session>:<window>` → fixture text returned by capturePane. */
  paneCaptures?: Record<string, string>;
  /** Map of `<session>:<window>` → pane metadata returned by listPanes. */
  panesByTarget?: Record<
    string,
    Array<{ id?: string; index: number; pid: number; left?: number; role?: string }>
  >;
  /** Map of session → window names returned by listWindows. */
  windowsBySession?: Record<string, string[]>;
  /** Whether `hasSession` returns true (default true). */
  sessionUp?: boolean;
}

function buildFakeTmux(opts: FakeTmuxOpts = {}): TmuxNamespace {
  const sessionUp = opts.sessionUp ?? true;
  const captures = opts.paneCaptures ?? {};
  const panesByTarget = opts.panesByTarget ?? {};
  const windows = opts.windowsBySession ?? {};
  // Cast through unknown to satisfy the structural check while keeping
  // the fake intentionally narrow (only the methods status + the probe
  // call are stubbed; everything else is a throwing default).
  const fake = {
    server: {},
    session: {
      hasSession: async (_name: string) => sessionUp,
    },
    window: {
      listWindows: async (session: string) => {
        const names = windows[session.replace(/^=/, "")] ?? [];
        return names.map((name, i) => ({ index: i, id: `@${i}`, name, active: i === 0 }));
      },
    },
    pane: {
      capturePane: async (o: { target: string }) => captures[o.target] ?? "",
      displayMessage: async () => "(down)",
      listPanes: async (target: string) => panesByTarget[target] ?? [],
    },
    buffer: {},
    client: {},
    option: {},
  };
  return fake as unknown as TmuxNamespace;
}

async function captureStdout<T>(fn: () => Promise<T>): Promise<{ out: string; result: T }> {
  let out = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string | Uint8Array) => {
    out += typeof s === "string" ? s : new TextDecoder().decode(s);
    return true;
  }) as typeof process.stdout.write;
  try {
    const result = await fn();
    return { out, result };
  } finally {
    process.stdout.write = orig;
  }
}

function makeStatusSnapshot(driverPane: DriverPaneHealth): StatusSnapshot {
  return {
    team: "team",
    session: "test-sess",
    sessionState: "up",
    members: [],
    kanban: { todo: 0, inProgress: 0, done: 0, blocked: 0 },
    driverInboxOpen: 0,
    driverPane,
    medic: {
      configured: false,
      enabled: false,
      sessionAlive: false,
      windowAlive: false,
    },
    needsApproval: { adr: [], inbox: [], kanban: [], total: 0 },
    lead: {
      configured: false,
      leadMember: null,
      leadSessionStartedAt: null,
      lead_session_uptime_s: null,
      leadPanePid: null,
      shell_pid_etime_s: null,
    },
  };
}

// ---------- gatherStatus shape ----------

describe("gatherStatus — driverPane field populated", () => {
  test("team without driverSession still resolves the canonical driver roster", async () => {
    const team: Team = { name: "team", members: [] };
    const tmux = buildFakeTmux();
    const snap = await gatherStatus(tmux, team, "test-sess", atmuxDir);
    expect(snap.driverPane.configured).toBe(true);
    expect(snap.driverPane.windowExists).toBe(false);
    expect(snap.driverPane.state).toBeNull();
    expect(snap.driverPane.pairDecision).toBeUndefined();
  });

  test("team with driverSession + driver window captures the worker pane", async () => {
    const team: Team = {
      name: "team",
      members: [],
      driverSession: { tui: "claude" },
    };
    const worker = { id: "%101", index: 0, pid: 11, left: 2, role: "worker" };
    const attention = { id: "%102", index: 1, pid: 12, left: 8, role: "attention" };
    const tmux = buildFakeTmux({
      windowsBySession: { "test-sess": ["driver", "lead"] },
      panesByTarget: { "test-sess:driver": [attention, worker] },
      paneCaptures: {
        "%101": "│ > \ntok 67k/100  ⏵⏵ auto mode\n",
        "%102": "Do you want Claude to proceed?\n[y/N]: ",
      },
    });
    const snap = await gatherStatus(tmux, team, "test-sess", atmuxDir);
    expect(snap.driverPane.configured).toBe(true);
    expect(snap.driverPane.windowExists).toBe(true);
    expect(snap.driverPane.pairDecision).toBe("noop");
    expect(snap.driverPane.pairReason).toBe("pair.two.valid");
    expect(snap.driverPane.state).toBe("READY");
  });

  test("team with driverSession but no driver window → windowExists=false", async () => {
    const team: Team = {
      name: "team",
      members: [],
      driverSession: { tui: "claude" },
    };
    const tmux = buildFakeTmux({
      windowsBySession: { "test-sess": ["lead", "planner"] },
    });
    const snap = await gatherStatus(tmux, team, "test-sess", atmuxDir);
    expect(snap.driverPane.configured).toBe(true);
    expect(snap.driverPane.windowExists).toBe(false);
    expect(snap.driverPane.pairDecision).toBeUndefined();
  });

  test("window-list failure is distinguishable from no window", async () => {
    const team: Team = {
      name: "team",
      members: [],
      driverSession: { tui: "claude" },
    };
    const tmux = buildFakeTmux();
    let listPanesCalled = false;
    tmux.window.listWindows = async () => {
      throw new Error("tmux list-windows failed");
    };
    tmux.pane.listPanes = async () => {
      listPanesCalled = true;
      return [];
    };
    const snap = await gatherStatus(tmux, team, "test-sess", atmuxDir);
    expect(snap.driverPane.configured).toBe(true);
    expect(snap.driverPane.windowExists).toBe(false);
    expect(snap.driverPane.pairDecision).toBe("unavailable");
    expect(snap.driverPane.pairReason).toBe("pair.observer.list_windows_failed");
    expect(listPanesCalled).toBe(false);
  });

  test("pane-list failure keeps the discovered window and exposes an observer failure", async () => {
    const team: Team = {
      name: "team",
      members: [],
      driverSession: { tui: "claude" },
    };
    const tmux = buildFakeTmux({
      windowsBySession: { "test-sess": ["driver"] },
    });
    tmux.pane.listPanes = async () => {
      throw new Error("tmux list-panes failed");
    };
    const snap = await gatherStatus(tmux, team, "test-sess", atmuxDir);
    expect(snap.driverPane.windowExists).toBe(true);
    expect(snap.driverPane.pairDecision).toBe("unavailable");
    expect(snap.driverPane.pairReason).toBe("pair.observer.list_panes_failed");
  });

  test("malformed pane metadata keeps the discovered window and fails closed", async () => {
    const team: Team = {
      name: "team",
      members: [],
      driverSession: { tui: "claude" },
    };
    const malformedPane = {
      index: 0,
      pid: 11,
      left: 2,
      role: "worker",
    } satisfies {
      id?: string;
      index: number;
      pid: number;
      left?: number;
      role?: string;
    };
    const tmux = buildFakeTmux({
      windowsBySession: { "test-sess": ["driver"] },
      panesByTarget: { "test-sess:driver": [malformedPane] },
    });
    const snap = await gatherStatus(tmux, team, "test-sess", atmuxDir);
    expect(snap.driverPane.windowExists).toBe(true);
    expect(snap.driverPane.pairDecision).toBe("fail-closed");
    expect(snap.driverPane.pairReason).toBe("pair.observer.missing_pane_metadata");
  });

  test("safe singleton JSON shape reports plan-add-attention", async () => {
    const team: Team = {
      name: "team",
      members: [],
      driverSession: { tui: "claude" },
    };
    const tmux = buildFakeTmux({
      windowsBySession: { "test-sess": ["driver"] },
      panesByTarget: {
        "test-sess:driver": [{ id: "%5", index: 0, pid: 21, left: 7, role: "worker" }],
      },
      paneCaptures: {
        "%5": "Press up to edit queued messages\n",
      },
    });
    const snap = await gatherStatus(tmux, team, "test-sess", atmuxDir);
    expect(snap.driverPane.windowExists).toBe(true);
    expect(snap.driverPane.pairDecision).toBe("plan-add-attention");
    expect(snap.driverPane.pairReason).toBe("pair.singleton.safe_worker_role");
  });
});

// ---------- status verb JSON output ----------

describe("status verb JSON — includes driverPane", () => {
  test("--json emits driverPane field populated from snapshot", async () => {
    const team: Team = {
      name: "team",
      members: [{ name: "m1" }],
      driverSession: { tui: "claude" },
    };
    await writeFile(join(atmuxDir, "team.json"), JSON.stringify(team));

    // Inject through a fake tmux by stubbing createTmux. Easier path:
    // run with --json and a fake socket that has no session — gatherStatus
    // probes will return configured=true + windowExists=false. Asserts
    // the JSON path serializes driverPane regardless of pane health.
    const { out } = await captureStdout(() =>
      status(["--json", "--socket", "/tmp/atmux-no-such-socket", "--team-dir", teamDir]),
    );
    const parsed = JSON.parse(out);
    expect(parsed.driverPane).toBeDefined();
    expect(parsed.driverPane.configured).toBe(true);
    // Window won't exist on a non-running socket; that's fine.
    expect(typeof parsed.driverPane.windowExists).toBe("boolean");
  });

  test("--json: team without driverSession still resolves canonical drivers", async () => {
    const team: Team = { name: "team", members: [{ name: "m1" }] };
    await writeFile(join(atmuxDir, "team.json"), JSON.stringify(team));
    const { out } = await captureStdout(() =>
      status(["--json", "--socket", "/tmp/atmux-no-such-socket", "--team-dir", teamDir]),
    );
    const parsed = JSON.parse(out);
    expect(parsed.driverPane.configured).toBe(true);
    expect(parsed.driverPane.windowExists).toBe(false);
  });
});

// ---------- status verb text render ----------

describe("status verb text — driver row visibility", () => {
  test("observer failure renders a pair failure, not no-window", async () => {
    const { out } = await captureStdout(() =>
      Promise.resolve(
        renderTextStatus(
          makeStatusSnapshot({
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
          300,
        ),
      ),
    );
    expect(out).toContain("🚗 driver");
    expect(out).toContain("pair=observer-failure");
    expect(out).toContain("reason=pair.observer.list_windows_failed");
    expect(out).not.toContain("state=no-window");
  });

  test("pane-list failure renders pair=observer-failure with its reason", async () => {
    const { out } = await captureStdout(() =>
      Promise.resolve(
        renderTextStatus(
          makeStatusSnapshot({
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
          300,
        ),
      ),
    );
    expect(out).toContain("pair=observer-failure");
    expect(out).toContain("reason=pair.observer.list_panes_failed");
    expect(out).not.toContain("state=no-window");
  });

  test("malformed metadata renders pair=fail-closed with its reason", async () => {
    const { out } = await captureStdout(() =>
      Promise.resolve(
        renderTextStatus(
          makeStatusSnapshot({
            configured: true,
            windowExists: true,
            state: null,
            evidence: "",
            pairDecision: "fail-closed",
            pairReason: "pair.observer.missing_pane_metadata",
            pairDiagnostics: [
              "Driver pane metadata is incomplete.",
              "Run atmux doctor to inspect driver-pane roles and geometry.",
            ],
          }),
          300,
        ),
      ),
    );
    expect(out).toContain("pair=fail-closed");
    expect(out).toContain("reason=pair.observer.missing_pane_metadata");
  });

  test("safe singleton renders pair=plan-add-attention with its reason", async () => {
    const { out } = await captureStdout(() =>
      Promise.resolve(
        renderTextStatus(
          makeStatusSnapshot({
            configured: true,
            windowExists: true,
            state: "TYPING",
            evidence: "Press up to edit queued messages\n",
            pairDecision: "plan-add-attention",
            pairReason: "pair.singleton.safe_worker_role",
            pairDiagnostics: [
              "A single worker pane is safe to keep.",
              "Run atmux doctor to inspect driver-pane roles and geometry.",
            ],
          }),
          300,
        ),
      ),
    );
    expect(out).toContain("pair=plan-add-attention");
    expect(out).toContain("reason=pair.singleton.safe_worker_role");
    expect(out).not.toContain("state=no-window");
  });

  test("actual window absence still renders state=no-window", async () => {
    const { out } = await captureStdout(() =>
      Promise.resolve(
        renderTextStatus(
          makeStatusSnapshot({
            configured: true,
            windowExists: false,
            state: null,
            evidence: "",
          }),
          300,
        ),
      ),
    );
    expect(out).toContain("state=no-window");
    expect(out).not.toContain("pair=");
  });

  test("healthy worker-targeted state still renders state=READY", async () => {
    const { out } = await captureStdout(() =>
      Promise.resolve(
        renderTextStatus(
          makeStatusSnapshot({
            configured: true,
            windowExists: true,
            state: "READY",
            evidence: "│ > ",
            pairDecision: "noop",
            pairReason: "pair.two.valid",
            pairDiagnostics: [
              "The driver pair is valid and ordered left-to-right.",
              "Run atmux doctor to inspect driver-pane roles and geometry.",
            ],
          }),
          300,
        ),
      ),
    );
    expect(out).toContain("🚗 driver");
    expect(out).toContain("state=READY");
    expect(out).not.toContain("pair=observer-failure");
  });

  test("canonical roster without driverSession still renders the driver row", async () => {
    const team: Team = {
      name: "team",
      members: [{ name: "m1" }],
    };
    await writeFile(join(atmuxDir, "team.json"), JSON.stringify(team));
    const { out } = await captureStdout(() =>
      status(["--socket", "/tmp/atmux-no-such-socket", "--team-dir", teamDir]),
    );
    expect(out).toContain("🚗 driver");
    expect(out).toContain("state=no-window");
    expect(out).toContain("configured=y");
    const driverIdx = out.indexOf("🚗 driver");
    const memberHdrIdx = out.indexOf("member       role");
    expect(memberHdrIdx).toBeGreaterThan(driverIdx);
  });
});
