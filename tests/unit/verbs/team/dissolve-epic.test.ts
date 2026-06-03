// Unit tests for src/verbs/team/dissolve-epic.ts (ADR-090
// §dissolve-epic, t-b430b185).
//
// Strategy: scratch dir + fake cockpit.json + pre-spawned epic-team
// fixture + mocked GitSpawn so the soft-stop + prune + cockpit-mutate
// + parent-EPIC-mark-done paths exercise observably. Caller-scope
// override mirrors spawn-epic.test.ts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitSpawn } from "../../../../src/abstractions/branch-merge.ts";
import type { SpawnResult } from "../../../../src/abstractions/spawn.ts";
import { closeDatabase, openDatabase } from "../../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../../src/abstractions/sqlite-migrations.ts";
import type { TmuxNamespace } from "../../../../src/abstractions/tmux.ts";
import type { Team as TeamShape } from "../../../../src/schema/team.ts";
import {
  type DissolveEpicOpts,
  defaultCageTeardown,
  deleteMergedEpicBranch,
  dissolveEpic,
  parseDissolveEpicArgs,
} from "../../../../src/verbs/team/dissolve-epic.ts";

let scratch: string;
let cockpitPath: string;
let parentRoot: string;
let epicRoot: string;

beforeEach(async () => {
  scratch = join(tmpdir(), `atmux-dissolve-epic-${Date.now()}-${Math.random()}`);
  await mkdir(scratch, { recursive: true });
  cockpitPath = join(scratch, "cockpit.json");
  parentRoot = join(scratch, "parent-team");
  epicRoot = join(scratch, "parent-team-epics", "e-1");

  await mkdir(parentRoot, { recursive: true });
  await mkdir(join(parentRoot, ".atmux"), { recursive: true });
  await mkdir(epicRoot, { recursive: true });
  await mkdir(join(epicRoot, ".atmux"), { recursive: true });

  // Cockpit with the parent + epic-team already registered.
  await writeFile(
    cockpitPath,
    JSON.stringify({
      schemaVersion: 1,
      sessions: [
        {
          type: "team",
          name: "parent-team",
          enabled: true,
          root: parentRoot,
          sessions: [
            {
              type: "epic-team",
              name: "e-1",
              parent: "parent-team",
              epicId: "e-1",
            },
          ],
        },
      ],
    }),
  );

  // Child team.json with the epicTeam block populated.
  await writeFile(
    join(epicRoot, ".atmux", "team.json"),
    JSON.stringify({
      name: "e-1",
      members: [{ name: "lead", role: "lead" }],
      worktreeIsolation: false,
      epicTeam: {
        parent: "parent-team",
        parentEpicKanbanId: "e-aabb0001",
        parentBase: "main",
        mergeMode: "auto",
      },
    }),
  );

  // Child state.db — seed via openDatabase so migrations apply.
  const childDb = openDatabase(join(epicRoot, ".atmux", "state.db"), migrations);
  closeDatabase(childDb);

  // Parent state.db with an EPIC row matching parentEpicKanbanId so
  // dissolve-epic step 8 has something to mark done.
  const parentDb = openDatabase(join(parentRoot, ".atmux", "state.db"), migrations);
  parentDb
    .query(
      `INSERT INTO epics (id, title, status, created_at)
       VALUES ($id, $title, $status, $now)`,
    )
    .run({
      $id: "e-aabb0001",
      $title: "test epic",
      $status: "in-progress",
      $now: 1000,
    });
  closeDatabase(parentDb);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

// ---------- Arg parsing ----------

describe("parseDissolveEpicArgs", () => {
  test("minimal — epicId only", () => {
    const r = parseDissolveEpicArgs(["e-1"]);
    expect(r.epicId).toBe("e-1");
    expect(r.skipChecks).toBe(false);
    expect(r.forcePrune).toBe(false);
  });

  test("--skip-checks + --force-prune both honored", () => {
    const r = parseDissolveEpicArgs(["e-1", "--skip-checks", "--force-prune"]);
    expect(r.skipChecks).toBe(true);
    expect(r.forcePrune).toBe(true);
  });

  test("missing epicId refuses", () => {
    expect(() => parseDissolveEpicArgs([])).toThrow(/<epicId> required/);
  });

  test("unknown flag refuses", () => {
    expect(() => parseDissolveEpicArgs(["e-1", "--bogus"])).toThrow(/unknown flag/);
  });
});

// ---------- Caller-scope gate ----------

describe("dissolveEpic — caller-scope gate", () => {
  test("refuses when caller is member", async () => {
    const opts: DissolveEpicOpts = {
      cockpitPath,
      callerScope: () => "member",
      git: cleanGitStub(),
    };
    await expect(dissolveEpic(["e-1"], opts)).rejects.toThrow(
      /refused.*caller scope is not 'driver'/,
    );
  });
});

// ---------- Pre-flight gates ----------

describe("dissolveEpic — pre-flight gates", () => {
  test("refuses when child kanban has open tasks (clean worktree)", async () => {
    // Insert one open task into the child kanban.
    const childDb = openDatabase(join(epicRoot, ".atmux", "state.db"), migrations);
    childDb
      .query(
        `INSERT INTO tasks (id, status, created_at)
         VALUES ($id, $status, $now)`,
      )
      .run({ $id: "t-open", $status: "todo", $now: 1000 });
    closeDatabase(childDb);

    const opts: DissolveEpicOpts = {
      cockpitPath,
      callerScope: () => "driver",
      git: cleanGitStub(),
      logger: { log: () => undefined, warn: () => undefined },
    };
    await expect(dissolveEpic(["e-1"], opts)).rejects.toThrow(/epic-team has 1 open task/);
  });

  test("refuses when worktree is dirty (no open tasks)", async () => {
    const opts: DissolveEpicOpts = {
      cockpitPath,
      callerScope: () => "driver",
      git: dirtyGitStub(),
      logger: { log: () => undefined, warn: () => undefined },
    };
    await expect(dissolveEpic(["e-1"], opts)).rejects.toThrow(/worktree.*has uncommitted/);
  });

  test("--skip-checks bypasses both gates", async () => {
    // Seed an open task + dirty worktree.
    const childDb = openDatabase(join(epicRoot, ".atmux", "state.db"), migrations);
    childDb
      .query(
        `INSERT INTO tasks (id, status, created_at)
         VALUES ($id, $status, $now)`,
      )
      .run({ $id: "t-open", $status: "todo", $now: 1000 });
    closeDatabase(childDb);

    const opts: DissolveEpicOpts = {
      cockpitPath,
      callerScope: () => "driver",
      git: dirtyGitStub(),
      // Explicit no-op to skip the default cage teardown (no real
      // tmux in test scratch dir).
      softStopHook: async () => undefined,
      logger: { log: () => undefined, warn: () => undefined },
    };
    const rc = await dissolveEpic(["e-1", "--skip-checks"], opts);
    expect(rc).toBe(0);
  });
});

// ---------- Happy path ----------

describe("dissolveEpic — happy path", () => {
  test("clean state → soft-stop + worktree prune + cockpit unregister + parent EPIC marked done", async () => {
    let softStopFired = false;
    const childTeamNames: string[] = [];
    const opts: DissolveEpicOpts = {
      cockpitPath,
      callerScope: () => "driver",
      git: cleanGitStub(),
      softStopHook: async (deps) => {
        softStopFired = true;
        childTeamNames.push(deps.childTeam.name);
      },
      logger: { log: () => undefined, warn: () => undefined },
    };
    const rc = await dissolveEpic(["e-1"], opts);
    expect(rc).toBe(0);
    expect(softStopFired).toBe(true);
    expect(childTeamNames).toEqual(["e-1"]);

    // Cockpit entry removed.
    const cockpitAfter = JSON.parse(await readFile(cockpitPath, "utf8"));
    const parentSession = cockpitAfter.sessions[0];
    // Either the sessions[] was deleted (empty case) OR it's an empty
    // array.
    if (parentSession.sessions !== undefined) {
      expect(parentSession.sessions).toHaveLength(0);
    }

    // Parent EPIC row flipped to done.
    const parentDb = openDatabase(join(parentRoot, ".atmux", "state.db"), migrations);
    const row = parentDb
      .query<{ status: string; completed_at: number | null }, []>(
        `SELECT status, completed_at FROM epics WHERE id = 'e-aabb0001'`,
      )
      .get();
    closeDatabase(parentDb);
    expect(row?.status).toBe("done");
    expect(row?.completed_at).not.toBeNull();
  });

  test("dissolve of partially-spawned remnant (no child team.json) still cleans cockpit", async () => {
    // Remove the child team.json — simulate a failed spawn-epic.
    await rm(join(epicRoot, ".atmux", "team.json"), { force: true });
    const opts: DissolveEpicOpts = {
      cockpitPath,
      callerScope: () => "driver",
      git: cleanGitStub(),
      logger: { log: () => undefined, warn: () => undefined },
    };
    const rc = await dissolveEpic(["e-1"], opts);
    expect(rc).toBe(0);
    // Cockpit entry cleaned regardless.
    const cockpitAfter = JSON.parse(await readFile(cockpitPath, "utf8"));
    const parentSession = cockpitAfter.sessions[0];
    if (parentSession.sessions !== undefined) {
      expect(parentSession.sessions).toHaveLength(0);
    }
  });
});

// ---------- Refusal paths ----------

describe("dissolveEpic — refusal paths", () => {
  test("refuses when epic-team not in cockpit", async () => {
    const opts: DissolveEpicOpts = {
      cockpitPath,
      callerScope: () => "driver",
      git: cleanGitStub(),
    };
    await expect(dissolveEpic(["no-such-epic"], opts)).rejects.toThrow(/not found in cockpit/);
  });
});

// ---------- Git stub helpers ----------

function cleanGitStub(): GitSpawn {
  return async (argv: ReadonlyArray<string>): Promise<SpawnResult> => {
    if (argv.includes("status") && argv.includes("--porcelain")) {
      return ok("");
    }
    if (argv.includes("worktree") && argv.includes("remove")) {
      return ok("");
    }
    return ok("");
  };
}

function dirtyGitStub(): GitSpawn {
  return async (argv: ReadonlyArray<string>): Promise<SpawnResult> => {
    if (argv.includes("status") && argv.includes("--porcelain")) {
      return ok(" M file1.ts\n M file2.ts\n");
    }
    if (argv.includes("worktree") && argv.includes("remove")) {
      return ok("");
    }
    return ok("");
  };
}

function ok(stdout: string): SpawnResult {
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

// ---------- defaultCageTeardown — production cage reap ----------
//
// Regression coverage for the ghost-tmux fix (2026-05-21). Pre-fix
// dissolve-epic only invoked softStop when explicitly injected → cage
// tmux servers never killed in production. These tests pin the
// invariant: when childTeam is non-null + cage alive, killSession
// MUST run regardless of softStop outcome.

describe("defaultCageTeardown — production cage reap", () => {
  function mockTmux(opts: {
    hasSessionResult?: boolean | "throw";
    onCall?: (label: string, name?: string) => void;
  }): TmuxNamespace {
    const note = opts.onCall ?? (() => undefined);
    // Minimal mock — only session.hasSession + session.killSession +
    // pane.sendKeys are exercised by defaultCageTeardown's softStop +
    // killSession path. Rest are unreachable stubs satisfying the
    // structural type only.
    const ns = {
      session: {
        async hasSession(name: string) {
          note("hasSession", name);
          if (opts.hasSessionResult === "throw") {
            throw new Error("tmux: no such socket");
          }
          return opts.hasSessionResult ?? true;
        },
        async killSession(name: string) {
          note("killSession", name);
        },
        async newSession() {
          note("newSession");
        },
        async listSessions() {
          return [];
        },
        async renameSession() {
          note("renameSession");
        },
        async setEnvironment() {
          note("setEnvironment");
        },
      },
      pane: {
        async sendKeys() {
          note("sendKeys");
        },
        async capturePane() {
          return "";
        },
        async listPanes() {
          return [];
        },
        async displayMessage() {
          return "0";
        },
        async killPane() {
          note("killPane");
        },
        async splitWindow() {
          return { sessionName: "x", windowIndex: 0, paneIndex: 0 };
        },
      },
      window: {
        async listWindows() {
          return [];
        },
        async newWindow() {
          return { sessionName: "x", windowIndex: 0 };
        },
        async killWindow() {
          note("killWindow");
        },
        async renameWindow() {
          note("renameWindow");
        },
        async selectWindow() {
          note("selectWindow");
        },
        async moveWindow() {
          note("moveWindow");
        },
        async swapWindow() {
          note("swapWindow");
        },
      },
      buffer: {
        async loadBuffer() {
          note("loadBuffer");
        },
        async pasteBuffer() {
          note("pasteBuffer");
        },
        async deleteBuffer() {
          note("deleteBuffer");
        },
      },
      client: {
        async attachSession() {
          note("attachSession");
        },
        async attachSessionInheritStdio() {
          note("attachSessionInheritStdio");
        },
        async switchClient() {
          note("switchClient");
        },
        async listClients() {
          return [];
        },
      },
      option: {
        async setOption() {
          note("setOption");
        },
      },
      server: {
        async hasServer() {
          note("hasServer");
          return true;
        },
        async killServer() {
          note("killServer");
        },
      },
    };
    return ns as unknown as TmuxNamespace;
  }

  function fakeChildTeam(): TeamShape {
    return {
      name: "e-1",
      members: [],
      worktreeIsolation: false,
    } as unknown as TeamShape;
  }

  test("alive cage → hasSession + killSession + killServer ALL called (e-7a1014f9 §Fix #1)", async () => {
    const calls: Array<{ label: string; name: string | undefined }> = [];
    await defaultCageTeardown({
      epicRoot,
      childTeam: fakeChildTeam(),
      tmuxFactory: () =>
        mockTmux({
          hasSessionResult: true,
          onCall: (label, name) => calls.push({ label, name }),
        }),
      logger: { log: () => undefined, warn: () => undefined },
    });
    const labels = calls.map((c) => c.label);
    expect(labels).toContain("hasSession");
    expect(labels).toContain("killSession");
    expect(labels).toContain("killServer");
    // Ordering invariant: killSession BEFORE killServer (graceful before
    // hammer); enforces the actual reap ordering in the helper.
    expect(labels.indexOf("killSession")).toBeLessThan(labels.indexOf("killServer"));
  });

  test("dead cage → hasSession false → killSession SKIPPED", async () => {
    const calls: Array<{ label: string; name: string | undefined }> = [];
    await defaultCageTeardown({
      epicRoot,
      childTeam: fakeChildTeam(),
      tmuxFactory: () =>
        mockTmux({
          hasSessionResult: false,
          onCall: (label, name) => calls.push({ label, name }),
        }),
      logger: { log: () => undefined, warn: () => undefined },
    });
    const labels = calls.map((c) => c.label);
    expect(labels).toContain("hasSession");
    expect(labels).not.toContain("killSession");
  });

  test("hasSession throws → no killSession, no rethrow", async () => {
    const calls: string[] = [];
    await expect(
      defaultCageTeardown({
        epicRoot,
        childTeam: fakeChildTeam(),
        tmuxFactory: () =>
          mockTmux({
            hasSessionResult: "throw",
            onCall: (label) => calls.push(label),
          }),
        logger: { log: () => undefined, warn: () => undefined },
      }),
    ).resolves.toBeUndefined();
    expect(calls).not.toContain("killSession");
  });

  test("session name uses cage form 'atmux-<name>' when no state/session.txt anchor", async () => {
    const seen: string[] = [];
    await defaultCageTeardown({
      epicRoot,
      childTeam: fakeChildTeam(),
      tmuxFactory: () =>
        mockTmux({
          hasSessionResult: true,
          onCall: (label, name) => {
            if (label === "killSession" && name !== undefined) seen.push(name);
          },
        }),
      logger: { log: () => undefined, warn: () => undefined },
    });
    // resolveCageSessionName({name:'e-1', root: epicRoot}) → 'atmux-e-1'
    // (no anchor in epic root + non-"atmux" team → hyphen-form default,
    // matching what start.ts creates via getSessionName fallback).
    // killSession receives the `=` exact-match prefix.
    expect(seen).toEqual(["=atmux-e-1"]);
  });

  test("ADR-251: epic cage socket resolved via tmuxTmpdir (resolveTeamSocket), not the /tmp/atmux-<epicId> guess", async () => {
    // Regression: resolveCageSocket(name, epicRoot) guesses
    // /tmp/atmux-<epicId>/sock and reports a LIVE epic cage as dead.
    // Epic cages set team.tmuxTmpdir at spawn; the teardown MUST resolve
    // the socket from it so the liveness probe + killSession reach the
    // real cage. Capture the socketPath the tmuxFactory receives.
    let capturedSocket: string | undefined;
    const childTeam = {
      name: "e-1",
      members: [],
      worktreeIsolation: false,
      tmuxTmpdir: "/tmp/atmux-parent/epics/e-1",
    } as unknown as TeamShape;
    await defaultCageTeardown({
      epicRoot,
      childTeam,
      tmuxFactory: (config) => {
        capturedSocket = (config as { socketPath?: string }).socketPath;
        return mockTmux({ hasSessionResult: false });
      },
      logger: { log: () => undefined, warn: () => undefined },
    });
    const uid = process.getuid?.() ?? 0;
    expect(capturedSocket).toBe(`/tmp/atmux-parent/epics/e-1/tmux-${uid}/default`);
  });

  test("default path: dissolve-epic with no softStopHook still kills cage", async () => {
    // End-to-end test exercising the default cage teardown path
    // through dissolveEpic (no softStopHook injected). Uses
    // tmuxFactory to mock the cage; verifies killSession lands.
    const calls: string[] = [];
    const opts: DissolveEpicOpts = {
      cockpitPath,
      callerScope: () => "driver",
      git: cleanGitStub(),
      tmuxFactory: () =>
        mockTmux({
          hasSessionResult: true,
          onCall: (label) => calls.push(label),
        }),
      logger: { log: () => undefined, warn: () => undefined },
    };
    const rc = await dissolveEpic(["e-1"], opts);
    expect(rc).toBe(0);
    expect(calls).toContain("killSession");
  });
});

// ---------- deleteMergedEpicBranch — branch-residue cleanup ----------
//
// e-7a1014f9 §Fix #2 — merged epic branches must be deleted on
// dissolve. Previously these accumulated indefinitely (sopx hit 12+
// before manual cleanup). Behavior matrix:
//   - branch absent → no-op
//   - branch present + merged → git branch -D
//   - branch present + unmerged → preserve + warn for operator rescue
//   - branch present + skipChecks=true + unmerged → preserve + warn
//     (skip-checks does NOT bypass the unmerged guard)

describe("deleteMergedEpicBranch — merged-branch reaper", () => {
  test("branch absent → no-op (no logger noise)", async () => {
    const argvSeen: string[][] = [];
    const git: GitSpawn = async (argv) => {
      argvSeen.push([...argv]);
      // show-ref --verify returns exit 1 when ref absent
      if (argv.includes("show-ref")) return okSpawn("", 1);
      return okSpawn("");
    };
    const warns: string[] = [];
    const logs: string[] = [];
    await deleteMergedEpicBranch({
      parentRoot,
      parentBase: "main",
      epicId: "e-1",
      skipChecks: false,
      git,
      logger: { log: (m) => logs.push(m), warn: (m) => warns.push(m) },
    });
    expect(warns).toEqual([]);
    expect(logs).toEqual([]);
    // Post-2026-05-26 double-e fix: probes BOTH the new (`<base>-epic-<id-without-e-prefix>`)
    // and legacy (`<base>-epic-<id>`) branch shapes; both probe before
    // bail. ADR-090 §Disk layout amendment back-compat window.
    expect(argvSeen).toHaveLength(2);
    expect(argvSeen[0]).toContain("show-ref");
    expect(argvSeen[1]).toContain("show-ref");
  });

  test("branch present + merged → git branch -D + green log", async () => {
    const argvSeen: string[][] = [];
    const git: GitSpawn = async (argv) => {
      argvSeen.push([...argv]);
      if (argv.includes("show-ref")) return okSpawn("", 0); // present
      if (argv.includes("merge-base")) return okSpawn("", 0); // merged
      if (argv.includes("branch") && argv.includes("-D")) return okSpawn("Deleted branch.");
      return okSpawn("");
    };
    const warns: string[] = [];
    const logs: string[] = [];
    await deleteMergedEpicBranch({
      parentRoot,
      parentBase: "main",
      epicId: "e-1",
      skipChecks: false,
      git,
      logger: { log: (m) => logs.push(m), warn: (m) => warns.push(m) },
    });
    expect(warns).toEqual([]);
    expect(logs.some((m) => m.includes("deleted merged branch"))).toBe(true);
    expect(logs.some((m) => m.includes("main-epic-1"))).toBe(true);
    // show-ref + merge-base + branch -D = 3 git calls
    expect(argvSeen).toHaveLength(3);
  });

  test("branch present + unmerged → preserve + warn (operator rescue)", async () => {
    const git: GitSpawn = async (argv) => {
      if (argv.includes("show-ref")) return okSpawn("", 0); // present
      if (argv.includes("merge-base")) return okSpawn("", 1); // NOT merged
      // We should NEVER reach branch -D here
      if (argv.includes("branch") && argv.includes("-D")) {
        throw new Error("branch -D MUST NOT be called when unmerged");
      }
      return okSpawn("");
    };
    const warns: string[] = [];
    const logs: string[] = [];
    await deleteMergedEpicBranch({
      parentRoot,
      parentBase: "main",
      epicId: "e-1",
      skipChecks: false,
      git,
      logger: { log: (m) => logs.push(m), warn: (m) => warns.push(m) },
    });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("unmerged commits");
    expect(warns[0]).toContain("git -C");
    expect(warns[0]).toContain("branch -D main-epic-1");
    expect(logs).toEqual([]);
  });

  test("skipChecks=true + unmerged → STILL preserves (rescue path stays)", async () => {
    // Operator's --skip-checks bypasses kanban + worktree-dirty gates
    // BUT must NOT silently destroy unpushed commits on an unmerged
    // branch. e-7a1014f9 spec is explicit: --skip-checks AND unmerged
    // = preserve.
    const git: GitSpawn = async (argv) => {
      if (argv.includes("show-ref")) return okSpawn("", 0);
      if (argv.includes("merge-base")) return okSpawn("", 1);
      if (argv.includes("branch") && argv.includes("-D")) {
        throw new Error("must NOT delete unmerged branch even with --skip-checks");
      }
      return okSpawn("");
    };
    const warns: string[] = [];
    await deleteMergedEpicBranch({
      parentRoot,
      parentBase: "main",
      epicId: "e-1",
      skipChecks: true,
      git,
      logger: { log: () => undefined, warn: (m) => warns.push(m) },
    });
    expect(warns[0]).toContain("unmerged commits");
  });

  test("git error during delete → warn + manual hint (best-effort)", async () => {
    const git: GitSpawn = async (argv) => {
      if (argv.includes("show-ref")) return okSpawn("", 0);
      if (argv.includes("merge-base")) return okSpawn("", 0); // merged
      if (argv.includes("branch") && argv.includes("-D")) {
        throw new Error("permission denied");
      }
      return okSpawn("");
    };
    const warns: string[] = [];
    await deleteMergedEpicBranch({
      parentRoot,
      parentBase: "main",
      epicId: "e-1",
      skipChecks: false,
      git,
      logger: { log: () => undefined, warn: (m) => warns.push(m) },
    });
    expect(warns[0]).toContain("branch delete failed");
    expect(warns[0]).toContain("permission denied");
    expect(warns[0]).toContain("manual:");
  });

  test("show-ref probe throws → graceful no-op (treats as branch-absent)", async () => {
    const git: GitSpawn = async (argv) => {
      if (argv.includes("show-ref")) throw new Error("git not available");
      return okSpawn("");
    };
    const warns: string[] = [];
    await deleteMergedEpicBranch({
      parentRoot,
      parentBase: "main",
      epicId: "e-1",
      skipChecks: false,
      git,
      logger: { log: () => undefined, warn: (m) => warns.push(m) },
    });
    expect(warns).toEqual([]);
  });
});

function okSpawn(stdout: string, exitCode = 0): SpawnResult {
  return {
    exitCode,
    stdout,
    stderr: "",
    argv: [],
    cmd: "git",
    signalled: null,
    durationMs: 0,
  };
}
