// Integration tests for src/verbs/team-rename.ts T2 surface
// (renameTmuxSession, reinstallCronBlock, renderRenamePlan,
// teamRename dispatcher).
//
// Side-effect helpers driven against stub TmuxNamespace + CrontabIO +
// injected loaders so we never touch the host tmux server, host
// crontab, or the SQLite-backed kanban. Filesystem state lives under
// per-test mkdtemp so loadTeam's team.json read works without
// polluting /tmp.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CrontabIO } from "../../../src/abstractions/crontab.ts";
import type { TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import type { Cockpit } from "../../../src/schema/cockpit.ts";
import type { KanbanTask } from "../../../src/schema/kanban.ts";
import {
  reinstallCronBlock,
  renameTmuxSession,
  renderRenamePlan,
  type TeamRenameDeps,
  teamRename,
} from "../../../src/verbs/team-rename.ts";

// ---------- Fixture helpers ----------

interface RenameCall {
  oldName: string;
  newName: string;
}

function stubTmux(): { ns: TmuxNamespace; renames: RenameCall[] } {
  const renames: RenameCall[] = [];
  const ns = {
    session: {
      renameSession: async (oldName: string, newName: string) => {
        renames.push({ oldName, newName });
      },
    },
  } as unknown as TmuxNamespace;
  return { ns, renames };
}

function stubCrontab(initialBody: string | null = null): {
  io: CrontabIO;
  reads: number;
  writes: string[];
} {
  let body: string | null = initialBody;
  const writes: string[] = [];
  let reads = 0;
  return {
    io: {
      read: async () => {
        reads += 1;
        return body;
      },
      write: async (b: string) => {
        writes.push(b);
        body = b;
      },
      available: async () => true,
    },
    get reads() {
      return reads;
    },
    writes,
  };
}

async function fixtureTeamDir(teamName: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atmux-team-rename-"));
  await mkdir(join(root, ".atmux"), { recursive: true });
  await writeFile(
    join(root, ".atmux", "team.json"),
    JSON.stringify({ name: teamName, members: [] }),
  );
  return root;
}

function emptyCockpit(): Cockpit {
  return { schemaVersion: 1, cockpitSession: "atmux_cockpit", sessions: [] };
}

// ---------- renameTmuxSession ----------

describe("renameTmuxSession", () => {
  test("happy path fires rename + rollback reverses", async () => {
    const { ns, renames } = stubTmux();
    const step = await renameTmuxSession({ tmux: ns, oldSession: "old", newSession: "new" });
    expect(renames).toEqual([{ oldName: "old", newName: "new" }]);
    expect(step.label).toContain("old");
    expect(step.label).toContain("new");
    await step.undo();
    expect(renames).toEqual([
      { oldName: "old", newName: "new" },
      { oldName: "new", newName: "old" },
    ]);
  });

  test("idempotent when oldSession === newSession", async () => {
    const { ns, renames } = stubTmux();
    const step = await renameTmuxSession({ tmux: ns, oldSession: "same", newSession: "same" });
    expect(renames).toEqual([]);
    expect(step.label).toContain("skipped");
    await step.undo();
    expect(renames).toEqual([]);
  });

  test("undo swallows tmux failures (best-effort)", async () => {
    let renamesCalled = 0;
    const ns = {
      session: {
        renameSession: async (_old: string, _new: string) => {
          renamesCalled += 1;
          if (renamesCalled === 2) throw new Error("tmux died");
        },
      },
    } as unknown as TmuxNamespace;
    const step = await renameTmuxSession({ tmux: ns, oldSession: "a", newSession: "b" });
    await step.undo(); // throw is caught
    expect(renamesCalled).toBe(2);
  });
});

// ---------- reinstallCronBlock ----------

describe("reinstallCronBlock", () => {
  test("snapshots crontab, calls cronInstall, undo restores snapshot", async () => {
    const ct = stubCrontab("# original-body\n");
    let installCalls = 0;
    let installArgv: ReadonlyArray<string> = [];
    const fn = async (argv: ReadonlyArray<string>) => {
      installCalls += 1;
      installArgv = argv;
      // Simulate cronInstall writing a new body:
      await ct.io.write("# new-body\n");
      return 0;
    };
    const step = await reinstallCronBlock({
      teamDir: "/td",
      oldName: "old",
      newName: "new",
      crontab: ct.io,
      cronInstallFn: fn,
    });
    expect(installCalls).toBe(1);
    expect(installArgv).toEqual(["--quiet", "--team-dir", "/td"]);
    expect(ct.writes).toEqual(["# new-body\n"]);
    await step.undo();
    expect(ct.writes).toEqual(["# new-body\n", "# original-body\n"]);
  });

  test("null initial body → undo writes empty string", async () => {
    const ct = stubCrontab(null);
    const fn = async (_argv: ReadonlyArray<string>) => 0;
    const step = await reinstallCronBlock({
      teamDir: "/td",
      oldName: "o",
      newName: "n",
      crontab: ct.io,
      cronInstallFn: fn,
    });
    await step.undo();
    expect(ct.writes).toEqual([""]);
  });

  test("undo swallows write failures (best-effort)", async () => {
    const failingIo: CrontabIO = {
      read: async () => "orig",
      write: async () => {
        throw new Error("crontab broken");
      },
      available: async () => true,
    };
    const fn = async (_argv: ReadonlyArray<string>) => 0;
    const step = await reinstallCronBlock({
      teamDir: "/td",
      oldName: "o",
      newName: "n",
      crontab: failingIo,
      cronInstallFn: fn,
    });
    await step.undo(); // does not throw
  });
});

// ---------- renderRenamePlan ----------

describe("renderRenamePlan", () => {
  test("emits 12 lines covering all 9 steps", () => {
    const lines = renderRenamePlan({
      oldName: "old",
      newName: "new",
      newSession: "new",
      forceBranches: false,
    });
    expect(lines.length).toBe(12);
    expect(lines[0]).toContain("old");
    expect(lines[0]).toContain("new");
    const joined = lines.join("\n");
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      expect(joined).toContain(`  ${n}.`);
    }
  });

  test("force=true rendered in step 8", () => {
    const lines = renderRenamePlan({
      oldName: "o",
      newName: "n",
      newSession: "n",
      forceBranches: true,
    });
    expect(lines.find((l) => l.startsWith("  8."))).toContain("force=true");
  });
});

// ---------- teamRename dispatcher ----------

describe("teamRename dispatcher", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  const baseDeps = (): TeamRenameDeps & {
    tmuxRecorded: RenameCall[];
    cronCalls: number;
    stepLog: string[];
    stdoutBuf: string;
    stderrBuf: string;
    releaseCalled: number;
  } => {
    const tmuxRecorded: RenameCall[] = [];
    const cronCalls = { n: 0 };
    const stepLog: string[] = [];
    const out = { buf: "" };
    const err = { buf: "" };
    const releaseRef = { n: 0 };
    const tmux = {
      session: {
        renameSession: async (o: string, n: string) =>
          void tmuxRecorded.push({ oldName: o, newName: n }),
      },
    } as unknown as TmuxNamespace;
    const crontab = stubCrontab("").io;
    const deps: TeamRenameDeps = {
      buildTmuxAtSocket: () => tmux,
      crontab,
      cronInstallFn: async () => {
        cronCalls.n += 1;
        return 0;
      },
      loadCockpitFn: async () => emptyCockpit(),
      loadTasksFn: async () => [],
      acquireRenameLock: async () => {
        stepLog.push("acq-lock");
        return { label: "acquired lock", undo: async () => void stepLog.push("undo-acq-lock") };
      },
      mutateTeamJsonName: async () => {
        stepLog.push("mutate-team-json");
        return { label: "mutated team.json", undo: async () => void stepLog.push("undo-mutate") };
      },
      renameMemberWindows: async () => {
        stepLog.push("rename-windows");
        return { label: "renamed windows", undo: async () => void stepLog.push("undo-windows") };
      },
      rewriteSessionTxt: async () => {
        stepLog.push("rewrite-state");
        return { label: "rewrote state.txt", undo: async () => void stepLog.push("undo-state") };
      },
      updateCockpitRegistry: async () => {
        stepLog.push("update-cockpit");
        return { label: "updated cockpit", undo: async () => void stepLog.push("undo-cockpit") };
      },
      renameMemberBranches: async () => {
        stepLog.push("rename-branches");
        return { label: "renamed branches", undo: async () => void stepLog.push("undo-branches") };
      },
      releaseRenameLock: async () => {
        releaseRef.n += 1;
      },
      stdout: (s: string) => {
        out.buf += s;
      },
      stderr: (s: string) => {
        err.buf += s;
      },
    };
    return {
      ...deps,
      tmuxRecorded,
      get cronCalls() {
        return cronCalls.n;
      },
      stepLog,
      get stdoutBuf() {
        return out.buf;
      },
      get stderrBuf() {
        return err.buf;
      },
      get releaseCalled() {
        return releaseRef.n;
      },
    };
  };

  test("happy path — all steps fire in order", async () => {
    const td = await fixtureTeamDir("old-team");
    dirs.push(td);
    const d = baseDeps();
    const exit = await teamRename(["new-team", "--team-dir", td], d);
    expect(exit).toBe(0);
    expect(d.tmuxRecorded).toEqual([{ oldName: "old-team", newName: "new-team" }]);
    expect(d.cronCalls).toBe(1);
    expect(d.stepLog).toEqual([
      "acq-lock",
      "mutate-team-json",
      "rename-windows",
      "rewrite-state",
      "update-cockpit",
      "rename-branches",
    ]);
    expect(d.releaseCalled).toBe(1);
    expect(d.stdoutBuf).toContain("8 steps applied");
  });

  test("--dry-run prints plan + no tmux/cron calls", async () => {
    const td = await fixtureTeamDir("old-team");
    dirs.push(td);
    const d = baseDeps();
    const exit = await teamRename(["--dry-run", "new-team", "--team-dir", td], d);
    expect(exit).toBe(0);
    expect(d.tmuxRecorded).toEqual([]);
    expect(d.cronCalls).toBe(0);
    expect(d.stepLog).toEqual([]);
    expect(d.releaseCalled).toBe(0); // no lock acquired => no release
    expect(d.stdoutBuf).toContain("plan for");
    expect(d.stdoutBuf).toContain("--dry-run — no changes applied");
  });

  test("idempotent no-op when newName === current team name (no session override)", async () => {
    const td = await fixtureTeamDir("same-name");
    dirs.push(td);
    const d = baseDeps();
    const exit = await teamRename(["same-name", "--team-dir", td], d);
    expect(exit).toBe(0);
    expect(d.stdoutBuf).toContain("no-op");
    expect(d.tmuxRecorded).toEqual([]);
    expect(d.cronCalls).toBe(0);
  });

  test("collision refuse throws ConfigError before any state mutation", async () => {
    const td = await fixtureTeamDir("old-team");
    dirs.push(td);
    const d = baseDeps();
    d.loadCockpitFn = async () => ({
      ...emptyCockpit(),
      sessions: [
        {
          type: "team" as const,
          name: "new-team",
          enabled: true,
          root: "/r",
          sessions: [],
        },
      ],
    });
    await expect(teamRename(["new-team", "--team-dir", td], d)).rejects.toThrow(
      /team '\w+(?:-\w+)*' already exists in cockpit registry/,
    );
    expect(d.stepLog).toEqual([]);
  });

  test("in-progress task refuse bypassable via --force", async () => {
    const td = await fixtureTeamDir("old-team");
    dirs.push(td);
    const tasks: KanbanTask[] = [{ id: "t-1", status: "in-progress" }];

    // Without --force → refuse.
    {
      const d = baseDeps();
      d.loadTasksFn = async () => tasks;
      await expect(teamRename(["new-team", "--team-dir", td], d)).rejects.toThrow(/in-progress/);
    }
    // With --force → succeeds.
    {
      const d = baseDeps();
      d.loadTasksFn = async () => tasks;
      const exit = await teamRename(["new-team", "--force", "--team-dir", td], d);
      expect(exit).toBe(0);
      expect(d.stepLog.length).toBe(6);
    }
  });

  test("step failure mid-flight → rollback walks reverse + exit 1 + release lock", async () => {
    const td = await fixtureTeamDir("old-team");
    dirs.push(td);
    const d = baseDeps();
    // Step 4 (renameMemberWindows) throws — step 1, 2, 3 should be
    // undone in reverse order. The rollback log records "undo-mutate"
    // + "undo-acq-lock" (step 3 tmux undo is real, not via stepLog).
    d.renameMemberWindows = async () => {
      throw new Error("simulated step 4 failure");
    };
    const exit = await teamRename(["new-team", "--team-dir", td], d);
    expect(exit).toBe(1);
    // The dispatcher applied steps 1, 2, 3 before failure; rollback
    // walks 3 → 2 → 1.
    expect(d.stepLog).toEqual(["acq-lock", "mutate-team-json", "undo-mutate", "undo-acq-lock"]);
    // Tmux session was renamed forward THEN reversed by the rollback
    // chain (renameTmuxSession's undo).
    expect(d.tmuxRecorded).toEqual([
      { oldName: "old-team", newName: "new-team" },
      { oldName: "new-team", newName: "old-team" },
    ]);
    expect(d.releaseCalled).toBe(1);
    expect(d.stderrBuf).toContain("failed at step");
    expect(d.stderrBuf).toContain("rollback walked");
  });

  test("invalid team-name → ConfigError BEFORE any I/O", async () => {
    const td = await fixtureTeamDir("old-team");
    dirs.push(td);
    const d = baseDeps();
    await expect(teamRename(["Bad Name", "--team-dir", td], d)).rejects.toThrow(
      /invalid team-name/,
    );
    expect(d.stepLog).toEqual([]);
  });

  test("default-stub deps fire when caller omits step overrides", async () => {
    const td = await fixtureTeamDir("old-team");
    dirs.push(td);
    // Strip every step-override from baseDeps; keep only the I/O
    // injection (cockpit + tasks + tmux + crontab) so the dispatcher
    // exercises the default no-op stubs at every slot.
    const d = baseDeps();
    delete d.acquireRenameLock;
    delete d.mutateTeamJsonName;
    delete d.renameMemberWindows;
    delete d.rewriteSessionTxt;
    delete d.updateCockpitRegistry;
    delete d.renameMemberBranches;
    delete d.releaseRenameLock;
    const exit = await teamRename(["new-team", "--team-dir", td], d);
    expect(exit).toBe(0);
    expect(d.tmuxRecorded).toEqual([{ oldName: "old-team", newName: "new-team" }]);
    expect(d.cronCalls).toBe(1);
    expect(d.stdoutBuf).toContain("8 steps applied");
  });

  test("rollback-undo failure surfaces in stderr", async () => {
    const td = await fixtureTeamDir("old-team");
    dirs.push(td);
    const d = baseDeps();
    d.mutateTeamJsonName = async () => ({
      label: "step 2 — mutate (throwing undo)",
      undo: async () => {
        throw new Error("undo failed");
      },
    });
    d.renameMemberWindows = async () => {
      throw new Error("step 4 boom");
    };
    const exit = await teamRename(["new-team", "--team-dir", td], d);
    expect(exit).toBe(1);
    expect(d.stderrBuf).toContain("undo(s) failed");
    expect(d.stderrBuf).toContain("undo failed");
  });

  test("releaseRenameLock failure logs warning but does not change exit code", async () => {
    const td = await fixtureTeamDir("old-team");
    dirs.push(td);
    const d = baseDeps();
    d.releaseRenameLock = async () => {
      throw new Error("lock release exploded");
    };
    const exit = await teamRename(["new-team", "--team-dir", td], d);
    expect(exit).toBe(0);
    expect(d.stderrBuf).toContain("releaseRenameLock failed");
    expect(d.stderrBuf).toContain("lock release exploded");
  });
});
