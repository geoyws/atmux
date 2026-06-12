// ADR-253 — `atmux topo --reap --apply` fail-CLOSED unit tests.
//
// Covers the three fail-OPEN defects fixed in ADR-253 + the new
// fail-closed contract. These exercise the REAL implementation — the
// liveness predicates are not stubbed; they run against constructed
// tmux/git probe states (per CLAUDE.md "NO LIES" doctrine + 100%
// coverage on touched logic).
//
//   Defect 1 — driver-scope gate (src/verbs/topo.ts::reapSubflow):
//     - non-driver --reap --apply  → ConfigError (refused)
//     - driver     --reap --apply  → proceeds (primitive runs)
//     - non-driver --reap (dry-run, no --apply) → UNGATED
//     - non-driver read-only topo  → UNGATED
//
//   Defect 2 — presence-as-liveness (topo-io.ts::isCageActiveWith):
//     - any session present → active (even when created hours ago —
//       the old `created > fiveMinAgo` test wrongly read this inactive)
//
//   Defect 3 — fail-closed probes:
//     - isCageActiveWith: empty list → inactive; throw → active
//     - isWorktreeActiveWith: clean+old → inactive; dirty → active;
//       status rc!=0 → active; log rc!=0 → active; unparseable ts →
//       active; throw → active

import { describe, expect, test } from "bun:test";
import type { GitSpawn } from "../../../src/abstractions/worktree.ts";
import { emptySeenState, type SeenState } from "../../../src/core/orphan-detector.ts";
import type { ReapDeps, ReapLogEntry } from "../../../src/core/reap.ts";
import type { DiscoveryIO, TmuxSocketEntry } from "../../../src/core/topo-aggregate.ts";
import { ConfigError } from "../../../src/errors.ts";
import { topo } from "../../../src/verbs/topo.ts";
import {
  type CageSessionInfo,
  isCageActiveWith,
  isWorktreeActiveWith,
} from "../../../src/verbs/topo-io.ts";

// ---------- Shared test scaffolding ----------

function makeLogger(): { log: (m: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (m: string) => lines.push(m), lines };
}

/** Minimal stub IO that surfaces exactly the cage-tmux orphans we want
 *  so the reap cascade reaches the --apply gate. */
function makeIOWithCageOrphans(refs: string[]): DiscoveryIO {
  const sockets: TmuxSocketEntry[] = refs.map((ref) => ({
    socket: `/tmp/atmux-x/epics/${ref}/tmux-0/default`,
    parent: "x",
    eid: ref,
  }));
  return {
    async readCockpit() {
      // One parent team so the manifest has a worktree for resolvers.
      return {
        schemaVersion: 1,
        cockpitSession: "atmux_cockpit",
        sessions: [{ type: "team", name: "atmux", enabled: true, root: "/srv/atmux", sessions: [] }],
        teams: [],
      } as unknown as Awaited<ReturnType<DiscoveryIO["readCockpit"]>>;
    },
    cockpitRegistryPath() {
      return "/root/.atmux/cockpit.json";
    },
    cockpitSocketPath() {
      return "/tmp/.tmux-1000/atmux-cockpit";
    },
    async cageAlive() {
      return false;
    },
    async readKanban() {
      return null;
    },
    async gitCurrentBranch() {
      return null;
    },
    async gitLastCommitAt() {
      return null;
    },
    async gitAheadCount() {
      return null;
    },
    async gitMergedInto() {
      return null;
    },
    async listAliveCageSockets() {
      return sockets;
    },
    async listCronMarkerBlocks() {
      return null;
    },
    async listEpicWorktreeDirs() {
      return [];
    },
    async listEpicBranches() {
      return [];
    },
    async listKanbanEpicRows() {
      return null;
    },
    now() {
      return new Date("2026-05-23T00:00:00.000Z");
    },
  };
}

/** Recording ReapDeps stub — the cascade primitives. Liveness probes
 *  default to inactive (Gate 1 passes) so the driver-gate is the only
 *  refusal under test for the Defect-1 cases. */
interface RecordedReapDeps {
  deps: ReapDeps;
  killCageServerCalls: string[];
  reapLog: ReapLogEntry[];
}

function makeReapDeps(): RecordedReapDeps {
  const r: RecordedReapDeps = { deps: {} as ReapDeps, killCageServerCalls: [], reapLog: [] };
  r.deps = {
    async killCageServer(s) {
      r.killCageServerCalls.push(s);
    },
    async cronReaperReap() {},
    async rmZombieWorktree() {},
    async deleteBranch() {},
    async removeRegistryEntry() {},
    async isCageActive() {
      return false;
    },
    async isWorktreeActive() {
      return false;
    },
    async isBranchMerged() {
      return true;
    },
    async appendReapLog(e) {
      r.reapLog.push(e);
    },
    now() {
      return new Date("2026-05-23T00:00:00.000Z");
    },
  };
  return r;
}

/** Seen-state aged past the 30s observation grace so the named cage
 *  orphans are emitted (not held in first-observation). The classifier
 *  keys grace by `<class>::<ref>`; for cage-tmux orphans the ref is the
 *  epic id (the socket entry's `eid`). */
function pastGrace(eids: string[]): SeenState {
  const old = new Date("2026-05-22T12:00:00.000Z").toISOString();
  const entries: Record<string, string> = {};
  for (const eid of eids) entries[`cage-tmux-without-registry::${eid}`] = old;
  return { schema_version: 1, generated_at: old, entries };
}

// ---------- Defect 1: driver-scope gate ----------

describe("ADR-253 Defect 1 — driver-scope gate on topo --reap --apply", () => {
  test("non-driver --reap --apply --yes → ConfigError (refused, no primitive runs)", async () => {
    const io = makeIOWithCageOrphans(["e-x"]);
    const reap = makeReapDeps();
    const log = makeLogger();
    let thrown: unknown;
    try {
      await topo(["--reap", "--apply", "--yes"], {
        io,
        seenState: emptySeenState(new Date("2026-05-22T12:00:00.000Z")),
        saveSeenState: async () => {},
        reapDeps: reap.deps,
        logger: log,
        callerScope: () => "member",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as ConfigError).message).toContain("caller scope is not 'driver'");
    // The destructive primitive must NEVER have run.
    expect(reap.killCageServerCalls).toEqual([]);
  });

  test("driver --reap --apply --yes → proceeds (primitive runs)", async () => {
    const io = makeIOWithCageOrphans(["e-x"]);
    const reap = makeReapDeps();
    const log = makeLogger();
    const rc = await topo(["--reap", "--apply", "--yes"], {
      io,
      // Pre-age generated_at far enough back that the orphan is past the
      // 30s observation grace and surfaces in the cascade.
      seenState: pastGrace(["e-x"]),
      saveSeenState: async () => {},
      reapDeps: reap.deps,
      logger: log,
      callerScope: () => "driver",
    });
    expect(rc).toBe(0);
    expect(reap.killCageServerCalls).toEqual(["/tmp/atmux-atmux/epics/e-x/tmux-0/default"]);
  });

  test("non-driver --reap (dry-run, no --apply) is UNGATED", async () => {
    const io = makeIOWithCageOrphans(["e-x"]);
    const reap = makeReapDeps();
    const log = makeLogger();
    const rc = await topo(["--reap"], {
      io,
      seenState: pastGrace(["e-x"]),
      saveSeenState: async () => {},
      reapDeps: reap.deps,
      logger: log,
      callerScope: () => "member",
    });
    expect(rc).toBe(0);
    // Dry-run never invokes the destructive primitive but also must not refuse.
    expect(reap.killCageServerCalls).toEqual([]);
    expect(log.lines.join("\n")).toContain("reap (dry-run)");
  });

  test("non-driver read-only topo is UNGATED", async () => {
    const io = makeIOWithCageOrphans([]);
    const log = makeLogger();
    const rc = await topo([], {
      io,
      seenState: emptySeenState(new Date("2026-05-22T12:00:00.000Z")),
      saveSeenState: async () => {},
      logger: log,
      callerScope: () => "member",
    });
    expect(rc).toBe(0);
    expect(log.lines[0]).toContain("cockpit");
  });

  test("default scope resolver reads injected env (member env refuses --apply)", async () => {
    const io = makeIOWithCageOrphans(["e-x"]);
    const reap = makeReapDeps();
    const log = makeLogger();
    let thrown: unknown;
    try {
      await topo(["--reap", "--apply", "--yes"], {
        io,
        seenState: pastGrace(["e-x"]),
        saveSeenState: async () => {},
        reapDeps: reap.deps,
        logger: log,
        // No callerScope seam — exercises the default resolver against env.
        env: { ATMUX_CALLER_SCOPE: "member" } as NodeJS.ProcessEnv,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect(reap.killCageServerCalls).toEqual([]);
  });

  test("default scope resolver reads injected env (driver env allows --apply)", async () => {
    const io = makeIOWithCageOrphans(["e-x"]);
    const reap = makeReapDeps();
    const log = makeLogger();
    const rc = await topo(["--reap", "--apply", "--yes"], {
      io,
      seenState: pastGrace(["e-x"]),
      saveSeenState: async () => {},
      reapDeps: reap.deps,
      logger: log,
      env: { ATMUX_CALLER_SCOPE: "driver" } as NodeJS.ProcessEnv,
    });
    expect(rc).toBe(0);
    expect(reap.killCageServerCalls).toEqual(["/tmp/atmux-atmux/epics/e-x/tmux-0/default"]);
  });
});

// ---------- Defect 2 + 3: isCageActiveWith (REAL implementation) ----------

describe("ADR-253 Defect 2/3 — isCageActiveWith (real logic, constructed states)", () => {
  test("live session present → active (presence-as-liveness)", async () => {
    const session: CageSessionInfo = { name: "atmux", windows: 3, created: 1_700_000_000 };
    const active = await isCageActiveWith(async () => [session]);
    expect(active).toBe(true);
  });

  test("long-running cage (session created hours ago) → STILL active", async () => {
    // The defeated old gate keyed on `created > now-5min`, so a cage
    // created hours ago read INACTIVE — defeating Gate 1 for the common
    // case. Presence-as-liveness must read it active.
    const ancient = Math.floor(Date.now() / 1000) - 6 * 60 * 60; // 6h ago
    const session: CageSessionInfo = { name: "atmux", windows: 2, created: ancient };
    const active = await isCageActiveWith(async () => [session]);
    expect(active).toBe(true);
  });

  test("multiple sessions present → active", async () => {
    const active = await isCageActiveWith(async () => [
      { name: "a", windows: 1, created: 1 },
      { name: "b", windows: 1, created: 2 },
    ]);
    expect(active).toBe(true);
  });

  test("empty session list (server answered, zero sessions) → inactive", async () => {
    const active = await isCageActiveWith(async () => []);
    expect(active).toBe(false);
  });

  test("throwing probe (socket unreadable / tmux error) → FAIL-CLOSED active", async () => {
    const active = await isCageActiveWith(async () => {
      throw new Error("no server running on /tmp/...");
    });
    expect(active).toBe(true);
  });
});

// ---------- Defect 3: isWorktreeActiveWith (REAL implementation) ----------

/** Build a GitSpawn that answers `status`/`log` from a script. Each
 *  call consumes the matching entry; mirrors the SpawnResult shape. */
function makeGit(handlers: {
  status?: { exitCode: number; stdout: string };
  log?: { exitCode: number; stdout: string };
  throwOn?: "status" | "log";
}): GitSpawn {
  return async (argv) => {
    const sub = argv.includes("status") ? "status" : argv.includes("log") ? "log" : "other";
    if (handlers.throwOn === sub) throw new Error(`git ${sub} exploded`);
    const h = sub === "status" ? handlers.status : sub === "log" ? handlers.log : undefined;
    return {
      cmd: "git",
      argv,
      exitCode: h?.exitCode ?? 0,
      signalled: null,
      stdout: h?.stdout ?? "",
      stderr: "",
      durationMs: 1,
    };
  };
}

describe("ADR-253 Defect 3 — isWorktreeActiveWith (real logic, constructed states)", () => {
  const now = () => new Date("2026-05-23T00:00:00.000Z");
  const nowSec = Math.floor(new Date("2026-05-23T00:00:00.000Z").getTime() / 1000);

  test("clean + old commit → inactive", async () => {
    const oldCommit = nowSec - 60 * 60; // 1h ago, outside 5min window
    const git = makeGit({
      status: { exitCode: 0, stdout: "" },
      log: { exitCode: 0, stdout: `${oldCommit}\n` },
    });
    expect(await isWorktreeActiveWith(git, "/srv/atmux-epics/e-1", now)).toBe(false);
  });

  test("dirty working tree → active", async () => {
    const git = makeGit({ status: { exitCode: 0, stdout: " M src/foo.ts\n" } });
    expect(await isWorktreeActiveWith(git, "/srv/atmux-epics/e-1", now)).toBe(true);
  });

  test("clean + recent commit (within window) → active", async () => {
    const recent = nowSec - 60; // 1 min ago
    const git = makeGit({
      status: { exitCode: 0, stdout: "" },
      log: { exitCode: 0, stdout: `${recent}\n` },
    });
    expect(await isWorktreeActiveWith(git, "/srv/atmux-epics/e-1", now)).toBe(true);
  });

  test("git status rc != 0 (not a repo / locked) → FAIL-CLOSED active", async () => {
    const git = makeGit({ status: { exitCode: 128, stdout: "" } });
    expect(await isWorktreeActiveWith(git, "/srv/atmux-epics/e-1", now)).toBe(true);
  });

  test("git log rc != 0 (clean status, recency unreadable) → FAIL-CLOSED active", async () => {
    const git = makeGit({
      status: { exitCode: 0, stdout: "" },
      log: { exitCode: 128, stdout: "" },
    });
    expect(await isWorktreeActiveWith(git, "/srv/atmux-epics/e-1", now)).toBe(true);
  });

  test("unparseable commit timestamp → FAIL-CLOSED active", async () => {
    const git = makeGit({
      status: { exitCode: 0, stdout: "" },
      log: { exitCode: 0, stdout: "not-a-number\n" },
    });
    expect(await isWorktreeActiveWith(git, "/srv/atmux-epics/e-1", now)).toBe(true);
  });

  test("git status throws → FAIL-CLOSED active", async () => {
    const git = makeGit({ throwOn: "status" });
    expect(await isWorktreeActiveWith(git, "/srv/atmux-epics/e-1", now)).toBe(true);
  });

  test("git log throws → FAIL-CLOSED active", async () => {
    const git = makeGit({ status: { exitCode: 0, stdout: "" }, throwOn: "log" });
    expect(await isWorktreeActiveWith(git, "/srv/atmux-epics/e-1", now)).toBe(true);
  });

  test("default clock argument is exercised (no explicit now)", async () => {
    // Old commit relative to the real clock → inactive. Exercises the
    // default `now = () => new Date()` parameter branch.
    const longAgo = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
    const git = makeGit({
      status: { exitCode: 0, stdout: "" },
      log: { exitCode: 0, stdout: `${longAgo}\n` },
    });
    expect(await isWorktreeActiveWith(git, "/srv/atmux-epics/e-1")).toBe(false);
  });
});
