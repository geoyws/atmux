// Edge-case tests for src/verbs/team-rename-tmux.ts.
//
// Companion to team-rename-tmux.test.ts. That file proves every line
// + function reachable (100% reported coverage); this file proves
// behaviour at edges the line-counter can't see — multi-member
// interactions, partial-batch failure shapes, mixed-state outcome
// ordering, and degenerate inputs.
//
// Lives as a separate file (rather than appended) so it can be added
// during the post-T5 durable-improvement window without contending
// with any in-flight Write on the original test file.

import { describe, expect, test } from "bun:test";
import type { GitSpawn } from "../../../src/abstractions/branch-merge.ts";
import type { SpawnResult } from "../../../src/abstractions/spawn.ts";
import type { TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import {
  renamePerMemberBranches,
  renameTeamViewerWindow,
} from "../../../src/verbs/team-rename-tmux.ts";

// ============================================================
// Shared helpers (mirror team-rename-tmux.test.ts)
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

function mockCockpitTmux(opts: {
  windows?: Array<{ index: number; id: string; name: string; active: boolean }>;
  listWindowsThrows?: boolean;
  renameWindowThrows?: boolean;
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
        if (opts.renameWindowThrows) throw new Error("rename-window EBUSY");
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

const REPO = "/srv/repo";

// ============================================================
// renameTeamViewerWindow — edge cases
// ============================================================

describe("renameTeamViewerWindow (edges)", () => {
  test("listWindows returns empty array — same identity-step path as window-not-found", async () => {
    const { tmux, renameWindowCalls } = mockCockpitTmux({ windows: [] });
    const step = await renameTeamViewerWindow({
      tmux,
      cockpitSession: "atmux_cockpit",
      oldName: "atmux",
      newName: "atmux-renamed",
    });
    expect(renameWindowCalls).toEqual([]);
    expect(step.label).toMatch(/window not found; skipped/);
    await step.undo();
    expect(renameWindowCalls).toEqual([]);
  });

  test("rename-window throws during forward step — error propagates", async () => {
    // listWindows succeeds, finds the target, but renameWindow throws.
    // renameTeamViewerWindow does not catch this — the caller's
    // rollbackWalk handles the unwinding. Verify the throw surfaces.
    const { tmux } = mockCockpitTmux({
      windows: [{ index: 2, id: "@2", name: "atmux", active: false }],
      renameWindowThrows: true,
    });
    await expect(
      renameTeamViewerWindow({
        tmux,
        cockpitSession: "atmux_cockpit",
        oldName: "atmux",
        newName: "atmux-new",
      }),
    ).rejects.toThrow(/rename-window EBUSY/);
  });

  test("cockpit session name with non-canonical chars threads through to target spec", async () => {
    // Defensive: validates that the windowTarget construction uses the
    // caller-provided cockpitSession verbatim (no normalisation), so
    // operator-overridden cockpit sessions like `atmux_cockpit_test`
    // route correctly.
    const { tmux, renameWindowCalls } = mockCockpitTmux({
      windows: [{ index: 7, id: "@7", name: "team-a", active: false }],
    });
    await renameTeamViewerWindow({
      tmux,
      cockpitSession: "atmux_cockpit_test",
      oldName: "team-a",
      newName: "team-a-renamed",
    });
    expect(renameWindowCalls).toEqual([
      { target: "atmux_cockpit_test:7", name: "team-a-renamed" },
    ]);
  });

  test("oldName === newName — still resolves the window then renames in place (no special-case)", async () => {
    // Document current behaviour: identity-rename is NOT special-cased
    // at this layer. The dispatcher (T2) is expected to short-circuit
    // before invoking renameTeamViewerWindow when old === new, but
    // this layer remains pure — calling it with equal names invokes
    // tmux's rename-window with the same name (no-op at tmux level,
    // produces a valid RollbackStep).
    const { tmux, renameWindowCalls } = mockCockpitTmux({
      windows: [{ index: 1, id: "@1", name: "atmux", active: false }],
    });
    const step = await renameTeamViewerWindow({
      tmux,
      cockpitSession: "atmux_cockpit",
      oldName: "atmux",
      newName: "atmux",
    });
    expect(renameWindowCalls).toEqual([{ target: "atmux_cockpit:1", name: "atmux" }]);
    await step.undo();
    // Both forward + undo address the same target with the same name.
    expect(renameWindowCalls).toEqual([
      { target: "atmux_cockpit:1", name: "atmux" },
      { target: "atmux_cockpit:1", name: "atmux" },
    ]);
  });
});

// ============================================================
// renamePerMemberBranches — multi-member + partial-batch edges
// ============================================================

describe("renamePerMemberBranches (edges)", () => {
  test("empty members array — no calls, empty outcomes, no-branches rollback label", async () => {
    const { git, calls } = scriptedGit(() => gitFail("never called"));
    const r = await renamePerMemberBranches({
      teamDir: REPO,
      members: [],
      oldName: "old",
      newName: "new",
      push: true,
      git,
    });
    expect(calls).toEqual([]);
    expect(r.outcomes).toEqual([]);
    expect(r.rollback.label).toMatch(/0 branches/);
    await r.rollback.undo();
    expect(calls).toEqual([]);
  });

  test("mixed-state batch — renamed + skipped-missing + skipped-already-renamed in one batch", async () => {
    // 3 members:
    //   - "lead": old branch present → renamed
    //   - "planner": both branches absent → skipped-missing
    //   - "reviewer": new branch already present (manual rename) → skipped-already-renamed
    // Outcomes list preserves member order; rollback only walks renamed.
    const { git, calls } = scriptedGit((argv) => {
      if (argv.includes("show-ref")) {
        const ref = argv[argv.length - 1] ?? "";
        if (ref === "refs/heads/old-lead") return gitOk();
        if (ref === "refs/heads/old-planner") return gitFail("absent");
        if (ref === "refs/heads/new-planner") return gitFail("absent");
        if (ref === "refs/heads/old-reviewer") return gitFail("absent");
        if (ref === "refs/heads/new-reviewer") return gitOk();
        return gitFail("unexpected ref: " + ref);
      }
      if (argv.includes("branch") && argv.includes("-m")) return gitOk();
      if (argv.includes("push")) return gitOk();
      return gitFail("unexpected");
    });
    const r = await renamePerMemberBranches({
      teamDir: REPO,
      members: [{ name: "lead" }, { name: "planner" }, { name: "reviewer" }],
      oldName: "old",
      newName: "new",
      push: true,
      git,
    });
    expect(r.outcomes).toEqual([
      { member: "lead", status: "renamed", pushed: "atomic" },
      { member: "planner", status: "skipped-missing" },
      { member: "reviewer", status: "skipped-already-renamed" },
    ]);
    expect(r.rollback.label).toMatch(/1 branch\b/); // singular, only lead was renamed

    // Rollback restores ONLY the renamed lead branch.
    const fwd = calls.length;
    await r.rollback.undo();
    const undoCalls = calls.slice(fwd);
    expect(undoCalls.length).toBe(2); // branch -m + atomic push
    expect(undoCalls[0]).toEqual(["-C", REPO, "branch", "-m", "new-lead", "old-lead"]);
  });

  test("git branch -m fails on second member — first member's outcome already recorded; throw surfaces", async () => {
    // members[0] succeeds; members[1] fails at branch -m. We get a
    // ConfigError thrown — outcomes list is unobservable from the call
    // site (the throw replaces the result). This tests the
    // throw-on-mid-batch behaviour which the caller's rollback engine
    // is expected to compensate for.
    const seen = new Set<string>();
    const { git } = scriptedGit((argv) => {
      if (argv.includes("show-ref")) {
        const ref = argv[argv.length - 1] ?? "";
        return ref.startsWith("refs/heads/old-") ? gitOk() : gitFail("absent");
      }
      if (argv.includes("branch") && argv.includes("-m")) {
        const oldB = argv[argv.indexOf("-m") + 1] ?? "";
        if (seen.has(oldB)) return gitFail("re-run", 128);
        seen.add(oldB);
        if (oldB === "old-planner") return gitFail("branch already exists", 128);
        return gitOk();
      }
      if (argv.includes("push")) return gitOk();
      return gitFail("unexpected");
    });
    await expect(
      renamePerMemberBranches({
        teamDir: REPO,
        members: [{ name: "lead" }, { name: "planner" }],
        oldName: "old",
        newName: "new",
        push: false,
        git,
      }),
    ).rejects.toThrow(/branch -m old-planner new-planner/);
  });

  test("single-member rollback label uses singular 'branch' (not 'branches')", async () => {
    const { git } = scriptedGit((argv) => {
      if (argv.includes("show-ref")) {
        const ref = argv[argv.length - 1] ?? "";
        return ref.startsWith("refs/heads/old-") ? gitOk() : gitFail("absent");
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
    expect(r.rollback.label).toMatch(/\(1 branch\)/);
    expect(r.rollback.label).not.toMatch(/\(1 branches\)/);
  });

  test("zero-renamed rollback label uses plural 'branches' (degenerate but correct)", async () => {
    // All members skipped → rollback label says "(0 branches)" — plural
    // form per the JS pluralisation rule (n === 1 ? "" : "es"). This
    // documents the chosen rule.
    const { git } = scriptedGit(() => gitFail("absent"));
    const r = await renamePerMemberBranches({
      teamDir: REPO,
      members: [{ name: "lead" }, { name: "planner" }],
      oldName: "old",
      newName: "new",
      push: false,
      git,
    });
    expect(r.outcomes.every((o) => o.status === "skipped-missing")).toBe(true);
    expect(r.rollback.label).toMatch(/\(0 branches\)/);
  });

  test("undo() walks renamed-members in INSERTION order (not reverse)", async () => {
    // Documents intentional choice: each member's branch rename is
    // independent of every other member's (different refs). Reversing
    // the walk would not buy atomicity but would scramble the log,
    // making operator triage harder. Verify forward-order undo.
    const { git, calls } = scriptedGit((argv) => {
      if (argv.includes("show-ref")) {
        const ref = argv[argv.length - 1] ?? "";
        return ref.startsWith("refs/heads/old-") ? gitOk() : gitFail("absent");
      }
      if (argv.includes("branch")) return gitOk();
      return gitFail("unexpected");
    });
    const r = await renamePerMemberBranches({
      teamDir: REPO,
      members: [{ name: "alpha" }, { name: "bravo" }, { name: "charlie" }],
      oldName: "old",
      newName: "new",
      push: false,
      git,
    });
    const fwd = calls.length;
    await r.rollback.undo();
    const undoCalls = calls.slice(fwd);
    expect(undoCalls[0]).toEqual(["-C", REPO, "branch", "-m", "new-alpha", "old-alpha"]);
    expect(undoCalls[1]).toEqual(["-C", REPO, "branch", "-m", "new-bravo", "old-bravo"]);
    expect(undoCalls[2]).toEqual(["-C", REPO, "branch", "-m", "new-charlie", "old-charlie"]);
  });

  test("forward atomic-success + undo atomic-success — symmetric path coverage", async () => {
    const { git, calls } = scriptedGit((argv) => {
      if (argv.includes("show-ref")) {
        const ref = argv[argv.length - 1] ?? "";
        return ref.startsWith("refs/heads/old-") ? gitOk() : gitFail("absent");
      }
      if (argv.includes("branch")) return gitOk();
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
    const fwdAtomic = calls.find((c) => c.includes("--atomic"));
    expect(fwdAtomic).toBeDefined();
    expect(fwdAtomic).toEqual([
      "-C",
      REPO,
      "push",
      "origin",
      "--atomic",
      "new-lead:new-lead",
      ":old-lead",
    ]);

    await r.rollback.undo();
    // Both atomic pushes (forward + restore) should be argv-symmetric
    // with old↔new swapped.
    const allAtomic = calls.filter((c) => c.includes("--atomic"));
    expect(allAtomic).toHaveLength(2);
    expect(allAtomic[1]).toEqual([
      "-C",
      REPO,
      "push",
      "origin",
      "--atomic",
      "old-lead:old-lead",
      ":new-lead",
    ]);
  });

  test("per-branch fallback in forward AND undo — combinatorial path", async () => {
    // forward atomic fails → per-branch fwd succeeds; undo atomic fails
    // too → per-branch undo succeeds. Tests both fallbacks in one batch.
    let atomicSeen = 0;
    const { git, calls } = scriptedGit((argv) => {
      if (argv.includes("show-ref")) {
        const ref = argv[argv.length - 1] ?? "";
        return ref.startsWith("refs/heads/old-") ? gitOk() : gitFail("absent");
      }
      if (argv.includes("branch")) return gitOk();
      if (argv.includes("push") && argv.includes("--atomic")) {
        atomicSeen += 1;
        return gitFail("atomic always rejected", 128);
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
    expect(r.outcomes).toEqual([{ member: "lead", status: "renamed", pushed: "per-branch" }]);
    expect(atomicSeen).toBe(1); // forward atomic attempt
    await r.rollback.undo();
    expect(atomicSeen).toBe(2); // undo atomic attempt also fired
    // Expected fwd shape: show-ref + branch + atomic-fail + per-branch-create + per-branch-delete.
    // Expected undo shape: branch + atomic-fail + per-branch-create + per-branch-delete.
    // Total = 5 + 4 = 9 calls.
    expect(calls.length).toBe(9);
  });
});
