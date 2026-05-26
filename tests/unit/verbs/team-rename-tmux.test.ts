// Unit tests for src/verbs/team-rename-step5.ts (ADR-027 T5).
//
// Both exports exercised across every branch for 100% line + branch
// coverage:
//   - renameTeamViewerWindow: happy / no-op-window-absent /
//     cockpit-unreachable / dup-window-only-first-renamed.
//   - renamePerMemberBranches: happy-atomic / push=false /
//     skipped-missing / skipped-already-renamed / atomic-fallback /
//     git-branch-fail-throws / undo-atomic / undo-no-push /
//     undo-atomic-fallback / default-spawner-smoke.

import { describe, expect, test } from "bun:test";
import type { GitSpawn } from "../../../src/abstractions/branch-merge.ts";
import type { SpawnResult } from "../../../src/abstractions/spawn.ts";
import type { TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import {
  type BranchRenameMember,
  renamePerMemberBranches,
  renameTeamViewerWindow,
} from "../../../src/verbs/team-rename-tmux.ts";

// ============================================================
// Cockpit-tmux mock
// ============================================================

/** Build a minimal TmuxNamespace mock with scripted `listWindows` +
 *  recording `renameWindow`. Every other namespace member throws on
 *  access (safety net for accidental coupling — T5 must touch only
 *  these two surfaces). */
function mockCockpitTmux(opts: {
  windows?: Array<{ index: number; id: string; name: string; active: boolean }>;
  listWindowsThrows?: boolean;
}): {
  tmux: TmuxNamespace;
  renameWindowCalls: Array<{ target: string; name: string }>;
} {
  const renameWindowCalls: Array<{ target: string; name: string }> = [];
  const notImplemented = (path: string): (() => never) => {
    return () => {
      throw new Error(`mockCockpitTmux: ${path} not implemented`);
    };
  };
  const tmux = {
    session: {
      newSession: notImplemented("session.newSession"),
      hasSession: notImplemented("session.hasSession"),
      killSession: notImplemented("session.killSession"),
      listSessions: notImplemented("session.listSessions"),
      renameSession: notImplemented("session.renameSession"),
      setEnvironment: notImplemented("session.setEnvironment"),
    },
    window: {
      newWindow: notImplemented("window.newWindow"),
      killWindow: notImplemented("window.killWindow"),
      listWindows: async (_session: string) => {
        if (opts.listWindowsThrows) throw new Error("cockpit socket unreachable");
        return opts.windows ?? [];
      },
      renameWindow: async (
        target: string | { sessionName: string; windowIndex: number },
        name: string,
      ) => {
        const t =
          typeof target === "string" ? target : `${target.sessionName}:${target.windowIndex}`;
        renameWindowCalls.push({ target: t, name });
      },
      selectWindow: notImplemented("window.selectWindow"),
      moveWindow: notImplemented("window.moveWindow"),
      swapWindow: notImplemented("window.swapWindow"),
    },
    pane: {
      sendKeys: notImplemented("pane.sendKeys"),
      capturePane: notImplemented("pane.capturePane"),
      listPanes: notImplemented("pane.listPanes"),
      displayMessage: notImplemented("pane.displayMessage"),
      killPane: notImplemented("pane.killPane"),
      splitWindow: notImplemented("pane.splitWindow"),
    },
    buffer: {
      loadBuffer: notImplemented("buffer.loadBuffer"),
      pasteBuffer: notImplemented("buffer.pasteBuffer"),
      deleteBuffer: notImplemented("buffer.deleteBuffer"),
    },
    client: {
      attachSession: notImplemented("client.attachSession"),
      attachSessionInheritStdio: notImplemented("client.attachSessionInheritStdio"),
      switchClient: notImplemented("client.switchClient"),
      listClients: notImplemented("client.listClients"),
    },
    option: {
      setOption: notImplemented("option.setOption"),
      showOptions: notImplemented("option.showOptions"),
    },
    server: {
      hasServer: notImplemented("server.hasServer"),
      killServer: notImplemented("server.killServer"),
    },
  } as unknown as TmuxNamespace;
  return { tmux, renameWindowCalls };
}

// ============================================================
// renameTeamViewerWindow
// ============================================================

describe("renameTeamViewerWindow", () => {
  test("happy path — team-viewer window present, rename + rollback restores", async () => {
    const { tmux, renameWindowCalls } = mockCockpitTmux({
      windows: [
        { index: 1, id: "@1", name: "_lead", active: false },
        { index: 2, id: "@2", name: "atmux-kanban", active: false },
        { index: 3, id: "@3", name: "_sentinel", active: true },
      ],
    });
    const step = await renameTeamViewerWindow({
      tmux,
      cockpitSession: "atmux_cockpit",
      oldName: "atmux-kanban",
      newName: "atmux",
    });
    expect(renameWindowCalls).toEqual([{ target: "atmux_cockpit:2", name: "atmux" }]);
    expect(step.label).toMatch(/rename-team-viewer-window atmux-kanban → atmux$/);

    await step.undo();
    expect(renameWindowCalls).toEqual([
      { target: "atmux_cockpit:2", name: "atmux" },
      { target: "atmux_cockpit:2", name: "atmux-kanban" },
    ]);
  });

  test("no-op — team-viewer window absent → identity step", async () => {
    const { tmux, renameWindowCalls } = mockCockpitTmux({
      windows: [
        { index: 1, id: "@1", name: "_lead", active: false },
        { index: 2, id: "@2", name: "other-team", active: false },
      ],
    });
    const step = await renameTeamViewerWindow({
      tmux,
      cockpitSession: "atmux_cockpit",
      oldName: "atmux-kanban",
      newName: "atmux",
    });
    expect(renameWindowCalls).toEqual([]);
    expect(step.label).toMatch(/window not found; skipped/);
    await step.undo();
    expect(renameWindowCalls).toEqual([]);
  });

  test("cockpit unreachable — listWindows throws → identity step", async () => {
    const { tmux, renameWindowCalls } = mockCockpitTmux({ listWindowsThrows: true });
    const step = await renameTeamViewerWindow({
      tmux,
      cockpitSession: "atmux_cockpit",
      oldName: "atmux-kanban",
      newName: "atmux",
    });
    expect(renameWindowCalls).toEqual([]);
    expect(step.label).toMatch(/cockpit unreachable; skipped/);
    await step.undo();
    expect(renameWindowCalls).toEqual([]);
  });

  test("only first matching window renamed (defensive against dup viewer windows)", async () => {
    const { tmux, renameWindowCalls } = mockCockpitTmux({
      windows: [
        { index: 1, id: "@1", name: "atmux", active: false },
        { index: 5, id: "@5", name: "atmux", active: false },
      ],
    });
    const step = await renameTeamViewerWindow({
      tmux,
      cockpitSession: "atmux_cockpit",
      oldName: "atmux",
      newName: "atmux-renamed",
    });
    expect(renameWindowCalls).toEqual([{ target: "atmux_cockpit:1", name: "atmux-renamed" }]);
    await step.undo();
    expect(renameWindowCalls).toEqual([
      { target: "atmux_cockpit:1", name: "atmux-renamed" },
      { target: "atmux_cockpit:1", name: "atmux" },
    ]);
  });
});

// ============================================================
// renamePerMemberBranches
// ============================================================

function gitOk(stdout = ""): SpawnResult {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    argv: [],
    cmd: "git",
    signalled: null,
    durationMs: 0,
  };
}

function gitFail(stderr: string, code = 1): SpawnResult {
  return {
    exitCode: code,
    stdout: "",
    stderr,
    argv: [],
    cmd: "git",
    signalled: null,
    durationMs: 0,
  };
}

function scriptedGit(matcher: (argv: ReadonlyArray<string>) => SpawnResult): {
  git: GitSpawn;
  calls: ReadonlyArray<string>[];
} {
  const calls: ReadonlyArray<string>[] = [];
  const git: GitSpawn = async (argv) => {
    calls.push(argv);
    return matcher(argv);
  };
  return { git, calls };
}

const REPO = "/srv/repo";
const MEMBERS: BranchRenameMember[] = [{ name: "lead" }, { name: "planner" }];

describe("renamePerMemberBranches", () => {
  test("happy path (push=true, atomic supported) — rename + atomic push for each member", async () => {
    const { git, calls } = scriptedGit((argv) => {
      if (argv.includes("show-ref")) {
        const ref = argv[argv.length - 1] ?? "";
        if (ref.startsWith("refs/heads/old-")) return gitOk();
        return gitFail("not found");
      }
      if (argv.includes("branch") && argv.includes("-m")) return gitOk();
      if (argv.includes("push") && argv.includes("--atomic")) return gitOk();
      return gitFail("unexpected argv: " + argv.join(" "));
    });
    const r = await renamePerMemberBranches({
      teamDir: REPO,
      members: MEMBERS,
      oldName: "old",
      newName: "new",
      push: true,
      git,
    });
    expect(r.outcomes).toEqual([
      { member: "lead", status: "renamed", pushed: "atomic" },
      { member: "planner", status: "renamed", pushed: "atomic" },
    ]);
    expect(r.rollback.label).toMatch(/2 branches/);
    expect(calls.length).toBe(6);
    expect(calls[1]).toEqual(["-C", REPO, "branch", "-m", "old-lead", "new-lead"]);
    expect(calls[2]).toEqual([
      "-C",
      REPO,
      "push",
      "origin",
      "--atomic",
      "new-lead:new-lead",
      ":old-lead",
    ]);
  });

  test("push=false → local-only rename, pushed=skipped", async () => {
    const { git, calls } = scriptedGit((argv) => {
      if (argv.includes("show-ref")) {
        const ref = argv[argv.length - 1] ?? "";
        return ref.startsWith("refs/heads/old-") ? gitOk() : gitFail("not found");
      }
      if (argv.includes("branch") && argv.includes("-m")) return gitOk();
      return gitFail("unexpected: " + argv.join(" "));
    });
    const r = await renamePerMemberBranches({
      teamDir: REPO,
      members: [{ name: "lead" }],
      oldName: "old",
      newName: "new",
      push: false,
      git,
    });
    expect(r.outcomes).toEqual([{ member: "lead", status: "renamed", pushed: "skipped" }]);
    expect(calls.length).toBe(2);
    expect(calls.some((c) => c.includes("push"))).toBe(false);
  });

  test("skip-on-missing — old branch absent, new branch absent → skipped-missing", async () => {
    const { git, calls } = scriptedGit(() => gitFail("not found"));
    const r = await renamePerMemberBranches({
      teamDir: REPO,
      members: [{ name: "lead" }],
      oldName: "old",
      newName: "new",
      push: true,
      git,
    });
    expect(r.outcomes).toEqual([{ member: "lead", status: "skipped-missing" }]);
    expect(calls.length).toBe(2);
    expect(calls.some((c) => c.includes("branch"))).toBe(false);
  });

  test("skip-on-already-renamed — old branch absent, new branch present", async () => {
    const { git, calls } = scriptedGit((argv) => {
      const ref = argv[argv.length - 1] ?? "";
      if (ref.startsWith("refs/heads/old-")) return gitFail("not found");
      if (ref.startsWith("refs/heads/new-")) return gitOk();
      return gitFail("unexpected");
    });
    const r = await renamePerMemberBranches({
      teamDir: REPO,
      members: [{ name: "lead" }],
      oldName: "old",
      newName: "new",
      push: true,
      git,
    });
    expect(r.outcomes).toEqual([{ member: "lead", status: "skipped-already-renamed" }]);
    expect(calls.length).toBe(2);
  });

  test("atomic push fails → per-branch fallback (create then delete)", async () => {
    const { git, calls } = scriptedGit((argv) => {
      if (argv.includes("show-ref")) {
        const ref = argv[argv.length - 1] ?? "";
        return ref.startsWith("refs/heads/old-") ? gitOk() : gitFail("not found");
      }
      if (argv.includes("branch") && argv.includes("-m")) return gitOk();
      if (argv.includes("push") && argv.includes("--atomic"))
        return gitFail("remote rejected atomic", 128);
      if (argv.includes("push")) return gitOk();
      return gitFail("unexpected: " + argv.join(" "));
    });
    const r = await renamePerMemberBranches({
      teamDir: REPO,
      members: [{ name: "lead" }],
      oldName: "old",
      newName: "new",
      push: true,
      git,
    });
    expect(r.outcomes).toEqual([{ member: "lead", status: "renamed", pushed: "per-branch" }]);
    expect(calls.length).toBe(5);
    expect(calls[3]).toEqual(["-C", REPO, "push", "origin", "new-lead:new-lead"]);
    expect(calls[4]).toEqual(["-C", REPO, "push", "origin", ":old-lead"]);
  });

  test("git branch -m fails → ConfigError surfaces", async () => {
    const { git } = scriptedGit((argv) => {
      if (argv.includes("show-ref")) {
        const ref = argv[argv.length - 1] ?? "";
        return ref.startsWith("refs/heads/old-") ? gitOk() : gitFail("not found");
      }
      if (argv.includes("branch") && argv.includes("-m"))
        return gitFail("fatal: branch already exists", 128);
      return gitFail("unexpected");
    });
    await expect(
      renamePerMemberBranches({
        teamDir: REPO,
        members: [{ name: "lead" }],
        oldName: "old",
        newName: "new",
        push: false,
        git,
      }),
    ).rejects.toThrow(/branch -m old-lead new-lead.*failed.*branch already exists/);
  });

  test("undo() reverses rename + atomic-push restore", async () => {
    const { git, calls } = scriptedGit((argv) => {
      if (argv.includes("show-ref")) {
        const ref = argv[argv.length - 1] ?? "";
        return ref.startsWith("refs/heads/old-") ? gitOk() : gitFail("not found");
      }
      if (argv.includes("branch") && argv.includes("-m")) return gitOk();
      if (argv.includes("push")) return gitOk();
      return gitFail("unexpected");
    });
    const r = await renamePerMemberBranches({
      teamDir: REPO,
      members: MEMBERS,
      oldName: "old",
      newName: "new",
      push: true,
      git,
    });
    const fwd = calls.length;
    await r.rollback.undo();
    const undoCalls = calls.slice(fwd);
    expect(undoCalls.length).toBe(4);
    expect(undoCalls[0]).toEqual(["-C", REPO, "branch", "-m", "new-lead", "old-lead"]);
    expect(undoCalls[1]).toEqual([
      "-C",
      REPO,
      "push",
      "origin",
      "--atomic",
      "old-lead:old-lead",
      ":new-lead",
    ]);
    expect(undoCalls[2]).toEqual(["-C", REPO, "branch", "-m", "new-planner", "old-planner"]);
  });

  test("undo() — push=false skips remote restore", async () => {
    const { git, calls } = scriptedGit((argv) => {
      if (argv.includes("show-ref")) {
        const ref = argv[argv.length - 1] ?? "";
        return ref.startsWith("refs/heads/old-") ? gitOk() : gitFail("not found");
      }
      if (argv.includes("branch")) return gitOk();
      return gitFail("unexpected");
    });
    const r = await renamePerMemberBranches({
      teamDir: REPO,
      members: [{ name: "lead" }],
      oldName: "old",
      newName: "new",
      push: false,
      git,
    });
    const fwd = calls.length;
    await r.rollback.undo();
    const undoCalls = calls.slice(fwd);
    expect(undoCalls).toEqual([["-C", REPO, "branch", "-m", "new-lead", "old-lead"]]);
  });

  test("undo() — atomic restore fails → per-branch restore fallback", async () => {
    let atomicCalls = 0;
    const { git, calls } = scriptedGit((argv) => {
      if (argv.includes("show-ref")) {
        const ref = argv[argv.length - 1] ?? "";
        return ref.startsWith("refs/heads/old-") ? gitOk() : gitFail("not found");
      }
      if (argv.includes("branch") && argv.includes("-m")) return gitOk();
      if (argv.includes("push") && argv.includes("--atomic")) {
        atomicCalls += 1;
        return atomicCalls === 1 ? gitOk() : gitFail("atomic rejected on restore", 128);
      }
      if (argv.includes("push")) return gitOk();
      return gitFail("unexpected");
    });
    const r = await renamePerMemberBranches({
      teamDir: REPO,
      members: [{ name: "lead" }],
      oldName: "old",
      newName: "new",
      push: true,
      git,
    });
    const fwd = calls.length;
    await r.rollback.undo();
    const undoCalls = calls.slice(fwd);
    expect(undoCalls.length).toBe(4);
    expect(undoCalls[2]).toEqual(["-C", REPO, "push", "origin", "old-lead:old-lead"]);
    expect(undoCalls[3]).toEqual(["-C", REPO, "push", "origin", ":new-lead"]);
  });

  test("default git spawner used when opts.git absent — falls back, returns outcomes", async () => {
    // Smoke against defaultGitSpawn: against a non-existent repo, show-ref
    // exits non-zero on both probes → outcome is skipped-missing for every
    // member. Proves the default-spawner path is wired without needing a
    // real git fixture.
    const r = await renamePerMemberBranches({
      teamDir: "/nonexistent-path-for-team-rename-t5-smoke",
      members: [{ name: "x" }],
      oldName: "old",
      newName: "new",
      push: false,
    });
    expect(r.outcomes).toEqual([{ member: "x", status: "skipped-missing" }]);
  });
});
