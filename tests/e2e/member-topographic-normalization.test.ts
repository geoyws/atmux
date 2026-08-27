// E2E: ADR-161 §EPIC-done #3 — PID + attachment preservation gate for
// the `atmux member move | swap | sort` verb suite.
//
// The unit tests under tests/unit/verbs/member.test.ts already drive a
// real tmux server with `base-index 1` and assert window-index +
// team.json mutations. This file adds the *explicit* PID-preservation
// invariant the ADR calls out: tmux `move-window` / `swap-window`
// preserve the running pane processes (and therefore PIDs + claude
// process state). We capture `pane_pid` per member-window before and
// after each verb, then assert PID equality across the moves.
//
// Test shape mirrors tests/e2e/member-rename.test.ts — shell-only
// roster (`tui: "shell"`, but we don't actually launch atmux; we
// `cat` per window so the pane has a live PID to track). Each test
// owns its own tmux server on a per-test absolute socketPath.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTmux, type TmuxNamespace } from "../../src/abstractions/tmux.ts";
import { Team } from "../../src/schema/team.ts";
import {
  memberMoveInternal,
  memberSortInternal,
  memberSwapInternal,
} from "../../src/verbs/member.ts";

setDefaultTimeout(30_000);

interface Member {
  name: string;
  role?: string;
  emoji: string;
  label?: string;
}

interface Fixture {
  atmuxDir: string;
  socketDir: string;
  socketPath: string;
  configPath: string;
  homeDir: string;
  teamName: string;
  sessionName: string;
  tmux: TmuxNamespace;
  members: Member[];
}

let fx: Fixture;
let priorTmux: string | undefined;

const DEFAULT_ROLES = new Set(["team-lead", "planner", "reviewer", "ombudsman"]);

function windowNameFor(m: Member): string {
  const role = m.role ?? "member";
  const isDefault = DEFAULT_ROLES.has(role);
  const display = m.label !== undefined && m.label.length > 0 ? m.label : m.name;
  return `${m.emoji}${isDefault ? "_" : "-"}${display}`;
}

async function buildFixture(members: ReadonlyArray<Member>): Promise<Fixture> {
  const teamName = `mt${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const sessionName = teamName; // bare per e-419553c6
  const atmuxDir = await mkdtemp(join(tmpdir(), "atmux-mt-dir-"));
  const socketDir = await mkdtemp(join(tmpdir(), "atmux-mt-sock-"));
  const socketPath = join(socketDir, "sock");
  const homeDir = await mkdtemp(join(tmpdir(), "atmux-mt-home-"));
  await mkdir(atmuxDir, { recursive: true });

  // ADR-162 base-index = 1 — match production tmux.conf so window-index
  // assertions land at W2..N (W1 = driver).
  const configPath = join(socketDir, "tmux.conf");
  await writeFile(configPath, "set -g base-index 1\n", "utf8");

  await writeFile(
    join(atmuxDir, "team.json"),
    `${JSON.stringify({ name: teamName, members }, null, 2)}\n`,
    "utf8",
  );

  const tmux = createTmux({ socketPath, configFile: configPath });
  // W1 = driver placeholder ("cat" keeps the pane alive with a stable PID).
  await tmux.session.newSession({
    name: sessionName,
    shellCommand: "cat",
    windowName: "driver",
  });
  for (const m of members) {
    await tmux.window.newWindow({
      sessionName,
      name: windowNameFor(m),
      shellCommand: "cat",
      detached: true,
    });
  }

  return {
    atmuxDir,
    socketDir,
    socketPath,
    configPath,
    homeDir,
    teamName,
    sessionName,
    tmux,
    members: [...members],
  };
}

beforeEach(() => {
  priorTmux = process.env.TMUX;
  delete process.env.TMUX;
});

afterEach(async () => {
  try {
    await fx.tmux.server.killServer();
  } catch {
    // expected: server may already be gone
  }
  if (priorTmux !== undefined) process.env.TMUX = priorTmux;
  await rm(fx.atmuxDir, { recursive: true, force: true });
  await rm(fx.socketDir, { recursive: true, force: true });
  await rm(fx.homeDir, { recursive: true, force: true });
});

/** Capture { memberId: { index, pid } } via the tmux abstraction's
 *  listWindows + listPanes primitives. Members rostered in team.json
 *  but with no live window (paused, pre-spawn) are absent from the
 *  result. */
async function capturePidMap(): Promise<Map<string, { index: number; pid: number }>> {
  const windows = await fx.tmux.window.listWindows(fx.sessionName);
  const out = new Map<string, { index: number; pid: number }>();
  for (const m of fx.members) {
    const wname = windowNameFor(m);
    const hit = windows.find((w) => w.name === wname);
    if (hit === undefined) continue;
    const panes = await fx.tmux.pane.listPanes({
      sessionName: fx.sessionName,
      windowIndex: hit.index,
    });
    const firstPane = panes[0];
    if (firstPane === undefined) continue;
    out.set(m.name, { index: hit.index, pid: firstPane.pid });
  }
  return out;
}

async function runMove(args: ReadonlyArray<string>): Promise<void> {
  await memberMoveInternal(args, {
    env: { ...process.env, ATMUX_DIR: fx.atmuxDir },
    cwd: fx.atmuxDir,
    home: fx.homeDir,
    stdout: () => {},
    stderr: () => {},
  });
}

async function runSwap(args: ReadonlyArray<string>): Promise<void> {
  await memberSwapInternal(args, {
    env: { ...process.env, ATMUX_DIR: fx.atmuxDir },
    cwd: fx.atmuxDir,
    home: fx.homeDir,
    stdout: () => {},
    stderr: () => {},
  });
}

async function runSort(args: ReadonlyArray<string>): Promise<void> {
  await memberSortInternal(args, {
    env: { ...process.env, ATMUX_DIR: fx.atmuxDir },
    cwd: fx.atmuxDir,
    home: fx.homeDir,
    stdout: () => {},
    stderr: () => {},
  });
}

async function readPersistedOrder(): Promise<string[]> {
  const body = JSON.parse(await readFile(join(fx.atmuxDir, "team.json"), "utf8"));
  return Team.parse(body).members.map((m) => m.name);
}

// ---------- e2e — move (AC#1) ----------

describe("e2e: ADR-161 — move preserves PIDs across window-index shift", () => {
  test("move shifts target's window-index without recreating its pane", async () => {
    fx = await buildFixture([
      { name: "lead", role: "team-lead", emoji: "🧭" },
      { name: "planner", role: "planner", emoji: "🗺️" },
      { name: "alpha", role: "member", emoji: "🛠️" },
      { name: "beta", role: "member", emoji: "📦" },
    ]);
    const before = await capturePidMap();
    expect(before.get("beta")!.index).toBe(5);

    await runMove(["beta", "--to", "3", "--socket-path", fx.socketPath]);

    const after = await capturePidMap();
    // beta's PID survives the move; the window now sits at W3.
    expect(after.get("beta")!.pid).toBe(before.get("beta")!.pid);
    expect(after.get("beta")!.index).toBe(3);
    // Every other member's PID is also preserved (move/swap-window do
    // not respawn panes anywhere on the table).
    for (const id of ["lead", "planner", "alpha"]) {
      expect(after.get(id)!.pid).toBe(before.get(id)!.pid);
    }
    // team.json now records beta at the new slot.
    const order = await readPersistedOrder();
    expect(order.indexOf("beta")).toBeLessThan(order.indexOf("alpha"));
  });

  test("idempotent: moving to current position is a no-op (no PID change)", async () => {
    fx = await buildFixture([
      { name: "lead", role: "team-lead", emoji: "🧭" },
      { name: "alpha", role: "member", emoji: "🛠️" },
    ]);
    const before = await capturePidMap();
    const alphaIdx = before.get("alpha")!.index;
    await runMove(["alpha", "--to", String(alphaIdx), "--socket-path", fx.socketPath]);
    const after = await capturePidMap();
    expect(after.get("alpha")).toEqual(before.get("alpha")!);
    expect(after.get("lead")).toEqual(before.get("lead")!);
  });
});

// ---------- e2e — swap (AC#2) ----------

describe("e2e: ADR-161 — swap exchanges two windows with both PIDs preserved", () => {
  test("swap two members; both PIDs survive, indices exchanged, no other window touched", async () => {
    fx = await buildFixture([
      { name: "lead", role: "team-lead", emoji: "🧭" },
      { name: "alpha", role: "member", emoji: "🛠️" },
      { name: "beta", role: "member", emoji: "📦" },
      { name: "gamma", role: "member", emoji: "🪄" },
    ]);
    const before = await capturePidMap();
    await runSwap(["alpha", "gamma", "--socket-path", fx.socketPath]);
    const after = await capturePidMap();

    expect(after.get("alpha")!.pid).toBe(before.get("alpha")!.pid);
    expect(after.get("gamma")!.pid).toBe(before.get("gamma")!.pid);
    expect(after.get("alpha")!.index).toBe(before.get("gamma")!.index);
    expect(after.get("gamma")!.index).toBe(before.get("alpha")!.index);

    // Untouched members keep both PID and index.
    expect(after.get("lead")).toEqual(before.get("lead")!);
    expect(after.get("beta")).toEqual(before.get("beta")!);
  });
});

// ---------- e2e — sort (AC#3) ----------

describe("e2e: ADR-161 — sort --defaults-first preserves PIDs across canonical reorder", () => {
  test("scrambled roster reorders to canonical defaults-first with every PID intact", async () => {
    // Defaults intentionally scrambled; user-added (alpha/beta) keep
    // their relative order per §Decision-anchor #4.
    fx = await buildFixture([
      { name: "alpha", role: "member", emoji: "🛠️" },
      { name: "reviewer", role: "reviewer", emoji: "🔍" },
      { name: "beta", role: "member", emoji: "📦" },
      { name: "lead", role: "team-lead", emoji: "🧭" },
      { name: "planner", role: "planner", emoji: "🗺️" },
    ]);
    const before = await capturePidMap();

    await runSort(["--defaults-first", "--socket-path", fx.socketPath]);

    const after = await capturePidMap();
    // Canonical order: lead → planner → reviewer → alpha → beta.
    const expectedOrder = ["lead", "planner", "reviewer", "alpha", "beta"];
    const sortedByIdx = [...after.entries()]
      .sort((a, b) => a[1].index - b[1].index)
      .map(([id]) => id);
    expect(sortedByIdx).toEqual(expectedOrder);

    // Every member's PID survives the reorder.
    for (const id of expectedOrder) {
      expect(after.get(id)!.pid).toBe(before.get(id)!.pid);
    }

    // team.json now persisted in canonical order too.
    const persisted = await readPersistedOrder();
    expect(persisted).toEqual(expectedOrder);
  });

  test("idempotent: already-sorted team produces zero PID changes and no team.json mutation", async () => {
    fx = await buildFixture([
      { name: "lead", role: "team-lead", emoji: "🧭" },
      { name: "planner", role: "planner", emoji: "🗺️" },
      { name: "alpha", role: "member", emoji: "🛠️" },
    ]);
    const before = await capturePidMap();
    const tjPathBefore = await readFile(join(fx.atmuxDir, "team.json"), "utf8");

    await runSort(["--defaults-first", "--socket-path", fx.socketPath]);

    const after = await capturePidMap();
    for (const id of ["lead", "planner", "alpha"]) {
      expect(after.get(id)).toEqual(before.get(id)!);
    }
    const tjPathAfter = await readFile(join(fx.atmuxDir, "team.json"), "utf8");
    expect(tjPathAfter).toBe(tjPathBefore);
  });
});

// ---------- e2e — refusal paths (AC#5) ----------

describe("e2e: ADR-161 — refusal paths", () => {
  test("move into W1 (driver slot) refuses with operator hint", async () => {
    fx = await buildFixture([{ name: "alpha", role: "member", emoji: "🛠️" }]);
    await expect(
      memberMoveInternal(["alpha", "--to", "1", "--socket-path", fx.socketPath], {
        env: { ...process.env, ATMUX_DIR: fx.atmuxDir },
        cwd: fx.atmuxDir,
        home: fx.homeDir,
        stdout: () => {},
        stderr: () => {},
      }),
    ).rejects.toThrow(/W1|driver/);
  });

  test("move unknown id surfaces a structured hint", async () => {
    fx = await buildFixture([{ name: "alpha", role: "member", emoji: "🛠️" }]);
    await expect(
      memberMoveInternal(["ghost", "--to", "3", "--socket-path", fx.socketPath], {
        env: { ...process.env, ATMUX_DIR: fx.atmuxDir },
        cwd: fx.atmuxDir,
        home: fx.homeDir,
        stdout: () => {},
        stderr: () => {},
      }),
    ).rejects.toThrow(/ghost|not found/);
  });

  test("swap rejects same-id positional pair at parse time", async () => {
    fx = await buildFixture([{ name: "alpha", role: "member", emoji: "🛠️" }]);
    await expect(
      memberSwapInternal(["alpha", "alpha", "--socket-path", fx.socketPath], {
        env: { ...process.env, ATMUX_DIR: fx.atmuxDir },
        cwd: fx.atmuxDir,
        home: fx.homeDir,
        stdout: () => {},
        stderr: () => {},
      }),
    ).rejects.toThrow(/cannot swap a member with itself/);
  });
});
