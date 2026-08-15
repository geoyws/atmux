// Unit tests for the ADR-224 §D2 incremental-mode auto-rename probe in
// src/core/orchd-window.ts::maybeSpawnOrchdWindow.
//
// Coverage:
//   - Legacy `__relayd__` window present → rename called with correct
//     target + new name; supervisor NOT respawned (return false).
//   - Only `__orchd__` window present → no rename; idempotent skip
//     (return false; existing supervisor preserved).
//   - Neither window present → no rename; proceeds to spawn path.
//   - rename-window throws → warn logged, falls through to spawn-
//     idempotence check (degrade gracefully — already-existing __orchd__
//     still skips spawn; absent __orchd__ proceeds).
//   - listWindows throws → no rename probe + falls through to spawn
//     (defensive: probe + idempotence-check share the same listWindows
//     call, so probe-fail also fails the idempotence-check path).

import { describe, expect, test } from "bun:test";
import type { TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import { maybeSpawnOrchdWindow, ORCHD_WINDOW } from "../../../src/core/orchd-window.ts";
import type { Team } from "../../../src/schema/team.ts";

const LEGACY_RELAYD_WINDOW = "__relayd__";

interface ListWindowsResult {
  index: number;
  id: string;
  name: string;
  active: boolean;
}

interface RenameCall {
  target: unknown;
  name: string;
}

interface NewWindowCall {
  sessionName: string;
  name: string;
  cwd?: string;
}

interface MockTmuxRecorder {
  tmux: TmuxNamespace;
  renameCalls: RenameCall[];
  newWindowCalls: NewWindowCall[];
  sendKeysCalls: number;
}

function team(overrides: Partial<Team> = {}): Team {
  return {
    name: "demo",
    members: [
      { name: "be-1", role: "member", lane: "be" },
      { name: "committer", role: "committer", lane: "misc" },
    ],
    autoMerge: { enabled: true },
    // ADR-260: fixture opts into orchd mode so the downstream gates
    // (autoMerge / HONKER / idempotence / spawn) stay exercisable —
    // the manual-mode default short-circuits before all of them.
    orchestration: { mode: "orchd" },
    ...overrides,
  } as Team;
}

function mockTmux(opts: {
  listWindowsResult?: ListWindowsResult[];
  listWindowsThrows?: boolean;
  renameThrows?: boolean;
}): MockTmuxRecorder {
  const renameCalls: RenameCall[] = [];
  const newWindowCalls: NewWindowCall[] = [];
  let sendKeysCalls = 0;
  const notImpl = (path: string) => () => {
    throw new Error(`mockTmux: ${path} not implemented`);
  };
  const tmux = {
    session: {
      newSession: notImpl("session.newSession"),
      hasSession: notImpl("session.hasSession"),
      killSession: notImpl("session.killSession"),
      killServer: notImpl("session.killServer"),
      hasServer: notImpl("session.hasServer"),
      listSessions: notImpl("session.listSessions"),
      renameSession: notImpl("session.renameSession"),
      setEnvironment: notImpl("session.setEnvironment"),
    },
    server: {
      killServer: notImpl("server.killServer"),
      hasServer: notImpl("server.hasServer"),
    },
    window: {
      newWindow: async (params: { sessionName: string; name?: string; cwd?: string }) => {
        const name = params.name ?? "";
        const cwd = params.cwd;
        newWindowCalls.push(
          cwd === undefined
            ? { sessionName: params.sessionName, name }
            : { sessionName: params.sessionName, name, cwd },
        );
        return { windowIndex: 99, sessionName: params.sessionName, id: "@99" };
      },
      killWindow: notImpl("window.killWindow"),
      listWindows: async (_session: string) => {
        if (opts.listWindowsThrows) throw new Error("mock listWindows failure");
        return opts.listWindowsResult ?? [];
      },
      renameWindow: async (target: unknown, name: string) => {
        if (opts.renameThrows) throw new Error("mock renameWindow failure");
        renameCalls.push({ target, name });
      },
      selectWindow: notImpl("window.selectWindow"),
      moveWindow: notImpl("window.moveWindow"),
      swapWindow: notImpl("window.swapWindow"),
    },
    pane: {
      sendKeys: async () => {
        sendKeysCalls += 1;
      },
      capturePane: notImpl("pane.capturePane"),
      listPanes: notImpl("pane.listPanes"),
      displayMessage: notImpl("pane.displayMessage"),
      killPane: notImpl("pane.killPane"),
      splitWindow: notImpl("pane.splitWindow"),
    },
    buffer: {
      loadBuffer: notImpl("buffer.loadBuffer"),
      pasteBuffer: notImpl("buffer.pasteBuffer"),
      deleteBuffer: notImpl("buffer.deleteBuffer"),
    },
  } as unknown as TmuxNamespace;
  return {
    tmux,
    renameCalls,
    newWindowCalls,
    get sendKeysCalls() {
      return sendKeysCalls;
    },
  } as MockTmuxRecorder;
}

const logger = {
  log: () => {},
  warn: () => {},
  err: () => {},
  ok: () => {},
};

describe("maybeSpawnOrchdWindow — ADR-224 §D2 incremental auto-rename", () => {
  test("legacy __relayd__ present → rename in-place, no respawn (returns false)", async () => {
    const recorder = mockTmux({
      listWindowsResult: [
        { index: 3, id: "@3", name: LEGACY_RELAYD_WINDOW, active: false },
      ],
    });
    const ok = await maybeSpawnOrchdWindow({
      team: team(),
      session: "atmux-demo",
      teamRoot: "/tmp/demo",
      tmux: recorder.tmux,
      logger,
      env: {},
    });
    expect(ok).toBe(false);
    expect(recorder.renameCalls).toHaveLength(1);
    expect(recorder.renameCalls[0]!.name).toBe(ORCHD_WINDOW);
    // Target is a WindowId — sessionName + windowIndex matching the
    // legacy entry's index. No string-form coercion at the call site.
    expect(recorder.renameCalls[0]!.target).toEqual({
      sessionName: "atmux-demo",
      windowIndex: 3,
    });
    // Critical: no new supervisor spawned (running process preserved).
    expect(recorder.newWindowCalls).toHaveLength(0);
  });

  test("only __orchd__ present → idempotent skip (no rename, no spawn)", async () => {
    const recorder = mockTmux({
      listWindowsResult: [
        { index: 4, id: "@4", name: ORCHD_WINDOW, active: false },
      ],
    });
    const ok = await maybeSpawnOrchdWindow({
      team: team(),
      session: "atmux-demo",
      teamRoot: "/tmp/demo",
      tmux: recorder.tmux,
      logger,
      env: {},
    });
    expect(ok).toBe(false);
    expect(recorder.renameCalls).toHaveLength(0);
    expect(recorder.newWindowCalls).toHaveLength(0);
  });

  test("neither window present → no rename, proceeds to spawn", async () => {
    const recorder = mockTmux({
      listWindowsResult: [
        { index: 0, id: "@0", name: "__demo__home", active: true },
        { index: 1, id: "@1", name: "be-1", active: false },
      ],
    });
    const ok = await maybeSpawnOrchdWindow({
      team: team(),
      session: "atmux-demo",
      teamRoot: "/tmp/demo",
      tmux: recorder.tmux,
      logger,
      env: {},
    });
    expect(ok).toBe(true);
    expect(recorder.renameCalls).toHaveLength(0);
    expect(recorder.newWindowCalls).toHaveLength(1);
    expect(recorder.newWindowCalls[0]!.name).toBe(ORCHD_WINDOW);
  });

  test("rename throws → warn + fall-through; absent __orchd__ proceeds to spawn", async () => {
    // Mock: legacy __relayd__ present, renameWindow throws, no __orchd__.
    // Expected: warn (swallowed by logger), fall through, idempotence
    // check sees no __orchd__, spawn proceeds.
    const recorder = mockTmux({
      listWindowsResult: [
        { index: 3, id: "@3", name: LEGACY_RELAYD_WINDOW, active: false },
      ],
      renameThrows: true,
    });
    const ok = await maybeSpawnOrchdWindow({
      team: team(),
      session: "atmux-demo",
      teamRoot: "/tmp/demo",
      tmux: recorder.tmux,
      logger,
      env: {},
    });
    expect(ok).toBe(true);
    expect(recorder.newWindowCalls).toHaveLength(1);
    expect(recorder.newWindowCalls[0]!.name).toBe(ORCHD_WINDOW);
  });

  test("listWindows throws → no rename probe, no idempotence check, falls through to spawn", async () => {
    const recorder = mockTmux({ listWindowsThrows: true });
    const ok = await maybeSpawnOrchdWindow({
      team: team(),
      session: "atmux-demo",
      teamRoot: "/tmp/demo",
      tmux: recorder.tmux,
      logger,
      env: {},
    });
    expect(ok).toBe(true);
    expect(recorder.renameCalls).toHaveLength(0);
    expect(recorder.newWindowCalls).toHaveLength(1);
  });

  test("ATMUX_HONKER=off short-circuits before rename probe (no listWindows call)", async () => {
    // Gate 3 (honker=off) fires before the rename probe. Ensure we
    // don't accidentally rename windows for poll-mode teams.
    const recorder = mockTmux({
      listWindowsResult: [
        { index: 3, id: "@3", name: LEGACY_RELAYD_WINDOW, active: false },
      ],
    });
    const ok = await maybeSpawnOrchdWindow({
      team: team(),
      session: "atmux-demo",
      teamRoot: "/tmp/demo",
      tmux: recorder.tmux,
      logger,
      env: { ATMUX_HONKER: "off" },
    });
    expect(ok).toBe(false);
    expect(recorder.renameCalls).toHaveLength(0);
    expect(recorder.newWindowCalls).toHaveLength(0);
  });
});
