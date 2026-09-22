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
import type { Team } from "../../../src/schema/team.ts";
import { gatherStatus, status } from "../../../src/verbs/status.ts";

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
  /** Map of session → window names returned by listWindows. */
  windowsBySession?: Record<string, string[]>;
  /** Whether `hasSession` returns true (default true). */
  sessionUp?: boolean;
}

function buildFakeTmux(opts: FakeTmuxOpts = {}): TmuxNamespace {
  const sessionUp = opts.sessionUp ?? true;
  const captures = opts.paneCaptures ?? {};
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
      listPanes: async () => [],
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

// ---------- gatherStatus shape ----------

describe("gatherStatus — driverPane field populated", () => {
  test("team without driverSession → driverPane.configured=false", async () => {
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
    const tmux = buildFakeTmux();
    const snap = await gatherStatus(tmux, team, "test-sess", atmuxDir);
    expect(snap.driverPane.configured).toBe(false);
    expect(snap.driverPane.windowExists).toBe(false);
    expect(snap.driverPane.state).toBeNull();
    expect(snap.driverPanes).toBeDefined();
    const driverPanes = snap.driverPanes ?? [];
    expect(driverPanes).toHaveLength(3);
    expect(driverPanes.every((dp) => dp.configured === false)).toBe(true);
  });

  test("team with driverSession + driver window → state=READY surfaces", async () => {
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
    const tmux = buildFakeTmux({
      windowsBySession: { "test-sess": ["driver", "lead"] },
      paneCaptures: { "test-sess:driver": "│ > \ntok 67k/100  ⏵⏵ auto mode\n" },
    });
    const snap = await gatherStatus(tmux, team, "test-sess", atmuxDir);
    expect(snap.driverPane.configured).toBe(true);
    expect(snap.driverPane.windowExists).toBe(true);
    expect(snap.driverPane.state).toBe("READY");
    expect(snap.driverPanes).toBeDefined();
    expect((snap.driverPanes ?? []).map((dp) => dp.driverName)).toEqual([
      "driver",
      "driver-2",
      "driver-3",
    ]);
  });

  test("team with driverSession but no driver window → windowExists=false", async () => {
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
    const tmux = buildFakeTmux({
      windowsBySession: { "test-sess": ["lead", "planner"] },
    });
    const snap = await gatherStatus(tmux, team, "test-sess", atmuxDir);
    expect(snap.driverPane.configured).toBe(true);
    expect(snap.driverPane.windowExists).toBe(false);
    expect(snap.driverPanes).toHaveLength(3);
  });
});

// ---------- status verb JSON output ----------

describe("status verb JSON — includes driverPane", () => {
  test("--json emits driverPane field populated from snapshot", async () => {
    const team: Team = {
      name: "team",
      members: [{ name: "m1" }],
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
    expect(parsed.driverPanes).toHaveLength(3);
    expect(parsed.driverPanes[0]?.driverName).toBe("driver");
  });

  test("--json: team without driverSession → driverPane.configured=false in payload", async () => {
    const team: Team = {
      name: "team",
      members: [{ name: "m1" }],
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
    await writeFile(join(atmuxDir, "team.json"), JSON.stringify(team));
    const { out } = await captureStdout(() =>
      status(["--json", "--socket", "/tmp/atmux-no-such-socket", "--team-dir", teamDir]),
    );
    const parsed = JSON.parse(out);
    expect(parsed.driverPane.configured).toBe(false);
    expect(parsed.driverPanes).toHaveLength(3);
    expect(parsed.driverPanes.every((dp: { configured: boolean }) => dp.configured === false)).toBe(
      true,
    );
  });
});

// ---------- status verb text render ----------

describe("status verb text — driver row visibility", () => {
  test("configured=true → driver row above member table", async () => {
    const team: Team = {
      name: "team",
      members: [{ name: "m1" }],
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
    await writeFile(join(atmuxDir, "team.json"), JSON.stringify(team));
    const { out } = await captureStdout(() =>
      status(["--socket", "/tmp/atmux-no-such-socket", "--team-dir", teamDir]),
    );
    expect(out).toContain("🚗 driver  configured=y");
    expect(out).toContain("🚗 driver-2  configured=y");
    expect(out).toContain("🚗 driver-3  configured=y");
    // Driver row must precede the member table header.
    const driverIdx = out.indexOf("🚗 driver");
    const memberHdrIdx = out.indexOf("member       role");
    expect(memberHdrIdx).toBeGreaterThan(driverIdx);
  });

  test("configured=false → no driver row in text output", async () => {
    const team: Team = {
      name: "team",
      members: [{ name: "m1" }],
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
    await writeFile(join(atmuxDir, "team.json"), JSON.stringify(team));
    const { out } = await captureStdout(() =>
      status(["--socket", "/tmp/atmux-no-such-socket", "--team-dir", teamDir]),
    );
    expect(out).not.toContain("🚗 driver");
  });
});
