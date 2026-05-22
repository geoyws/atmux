// Unit tests for src/core/topo-aggregate.ts (ADR-222 §D3 / t-4de545c8).
//
// Coverage matrix (per CLAUDE.md "100% coverage on tracked paths"):
//   - aggregateTopo:
//     - cockpit null  → minimal manifest (§D5 row 1)
//     - cockpit present + cockpit-tmux alive / dead
//     - parents iterated alphabetically + epics iterated by eid asc
//     - elapsed_ms computed from io.now() delta
//   - aggregateOneTeam:
//     - kanban null (§D5 row 2) / populated (parent shape with epics + epic_ids)
//     - cage alive true / false (§D5 row 3 timeout = false)
//     - branch null (§D5 row 6 broken worktree) / populated
//     - lastCommit null / populated, lastCommit + kanban last_activity max
//     - softStopped flag passed through
//   - aggregateOneEpic:
//     - kanban null / populated (epic shape — no epics field)
//     - cage alive true / false
//     - branch null / populated
//     - parentBranch null → ahead + merged both null, no IO call
//     - parentBranch populated → ahead/merged probed
//     - ahead null (§D5 row 5 timeout) / number; merged null / true / false
//     - in_parent_kanban: parent null → null; parent epic_ids absent → null;
//       parent epic_ids contains eid → true; absent → false
//     - softStopped flag passed through
//   - walkCockpit:
//     - empty sessions
//     - team-only
//     - epic-team under team (parent linkage)
//     - epic-team without `epicId` falls back to `name`
//     - recursive: epic-team nested two levels deep
//     - non-team/epic sessions ignored
//     - soft_stopped_at recognized on team + epic-team
//   - Path helpers (cageSocketForTeam, cageSocketForEpic, atmuxDirForTeam,
//     worktreeForEpic, atmuxDirForEpic, formatIsoMs)
//
// Per ADR-222 §D5 the aggregator must NEVER throw on a per-source
// failure — every test that pins a null IO return verifies the
// resulting manifest field rather than expecting a throw.

import { describe, expect, test } from "bun:test";
import type { LoadedCockpit } from "../../../src/core/cockpit.ts";
import {
  aggregateTopo,
  atmuxDirForEpic,
  atmuxDirForTeam,
  cageSocketForEpic,
  cageSocketForTeam,
  formatIsoMs,
  type KanbanProbe,
  type TopoIO,
  walkCockpit,
  worktreeForEpic,
} from "../../../src/core/topo-aggregate.ts";

// ---------- Stub IO ----------

interface StubIOSpec {
  cockpit?: LoadedCockpit | null;
  cockpitRegistryPath?: string;
  cockpitSocketPath?: string;
  cageAlive?: (socket: string) => boolean;
  kanban?: (atmuxDir: string, opts: { parent: boolean }) => KanbanProbe | null;
  branch?: (worktreePath: string) => string | null;
  lastCommit?: (worktreePath: string) => string | null;
  ahead?: (repoPath: string, base: string, branch: string) => number | null;
  merged?: (repoPath: string, base: string, branch: string) => boolean | null;
  /** Sequence of Date values returned by io.now() — index 0 used for
   *  the aggregator's `start`, index 1 for `finish`. Defaults to a
   *  fixed pair 100ms apart. */
  nowSeq?: Date[];
}

interface StubIOCalls {
  cageAlive: string[];
  kanban: Array<{ atmuxDir: string; parent: boolean }>;
  branch: string[];
  lastCommit: string[];
  ahead: Array<{ repo: string; base: string; branch: string }>;
  merged: Array<{ repo: string; base: string; branch: string }>;
  now: number;
}

function makeStubIO(spec: StubIOSpec = {}): { io: TopoIO; calls: StubIOCalls } {
  const calls: StubIOCalls = {
    cageAlive: [],
    kanban: [],
    branch: [],
    lastCommit: [],
    ahead: [],
    merged: [],
    now: 0,
  };
  const nowSeq = spec.nowSeq ?? [
    new Date("2026-05-22T13:54:00.000Z"),
    new Date("2026-05-22T13:54:00.100Z"),
  ];
  const io: TopoIO = {
    async readCockpit() {
      return spec.cockpit ?? null;
    },
    cockpitRegistryPath() {
      return spec.cockpitRegistryPath ?? "/root/.atmux/cockpit.json";
    },
    cockpitSocketPath() {
      return spec.cockpitSocketPath ?? "/tmp/.tmux-1000/atmux-cockpit";
    },
    async cageAlive(socket) {
      calls.cageAlive.push(socket);
      return spec.cageAlive ? spec.cageAlive(socket) : false;
    },
    async readKanban(atmuxDir, opts) {
      calls.kanban.push({ atmuxDir, parent: opts.parent });
      return spec.kanban ? spec.kanban(atmuxDir, opts) : null;
    },
    async gitCurrentBranch(worktreePath) {
      calls.branch.push(worktreePath);
      return spec.branch ? spec.branch(worktreePath) : null;
    },
    async gitLastCommitAt(worktreePath) {
      calls.lastCommit.push(worktreePath);
      return spec.lastCommit ? spec.lastCommit(worktreePath) : null;
    },
    async gitAheadCount(repoPath, base, branch) {
      calls.ahead.push({ repo: repoPath, base, branch });
      return spec.ahead ? spec.ahead(repoPath, base, branch) : null;
    },
    async gitMergedInto(repoPath, base, branch) {
      calls.merged.push({ repo: repoPath, base, branch });
      return spec.merged ? spec.merged(repoPath, base, branch) : null;
    },
    now() {
      const idx = Math.min(calls.now, nowSeq.length - 1);
      calls.now += 1;
      return nowSeq[idx] as Date;
    },
  };
  return { io, calls };
}

// ---------- Cockpit fixtures ----------

function teamSession(name: string, root: string, sessions: unknown[] = []) {
  return {
    type: "team" as const,
    name,
    enabled: true,
    root,
    sessions,
  };
}

function epicTeamSession(name: string, parent: string, epicId: string, sessions: unknown[] = []) {
  return {
    type: "epic-team" as const,
    name,
    enabled: true,
    parent,
    epicId,
    sessions,
  };
}

function cockpitWith(sessions: unknown[]): LoadedCockpit {
  return {
    schemaVersion: 1,
    cockpitSession: "atmux_cockpit",
    sessions: sessions as LoadedCockpit["sessions"],
    teams: [],
  } as unknown as LoadedCockpit;
}

// ---------- Path helpers ----------

describe("path helpers", () => {
  test("cageSocketForTeam returns /tmp/atmux-<team>/sock", () => {
    expect(cageSocketForTeam("atmux")).toBe("/tmp/atmux-atmux/sock");
    expect(cageSocketForTeam("unum")).toBe("/tmp/atmux-unum/sock");
  });

  test("cageSocketForEpic returns /tmp/atmux-<parent>/epics/<eid>/tmux-0/default", () => {
    expect(cageSocketForEpic("atmux", "e-501c5487")).toBe(
      "/tmp/atmux-atmux/epics/e-501c5487/tmux-0/default",
    );
  });

  test("atmuxDirForTeam joins .atmux", () => {
    expect(atmuxDirForTeam("/srv/atmux")).toBe("/srv/atmux/.atmux");
  });

  test("worktreeForEpic resolves to parent-sibling atmux-epics dir", () => {
    // path.join normalizes the `..` segment, so the result is the
    // sibling directory of the parent worktree.
    expect(worktreeForEpic("/root/work/src/atmux", "e-abc")).toBe(
      "/root/work/src/atmux-epics/e-abc",
    );
  });

  test("atmuxDirForEpic composes worktreeForEpic + .atmux", () => {
    expect(atmuxDirForEpic("/root/work/src/atmux", "e-abc")).toBe(
      "/root/work/src/atmux-epics/e-abc/.atmux",
    );
  });

  test("formatIsoMs formats with 3-digit ms precision", () => {
    const d = new Date("2026-05-22T13:54:00.123Z");
    expect(formatIsoMs(d)).toBe("2026-05-22T13:54:00.123Z");
  });
});

// ---------- walkCockpit ----------

describe("walkCockpit", () => {
  test("empty sessions yields empty result", () => {
    const r = walkCockpit(cockpitWith([]));
    expect(r.parents).toEqual([]);
    expect(r.epicsByParent.size).toBe(0);
  });

  test("team-only enumerates parents", () => {
    const r = walkCockpit(cockpitWith([teamSession("atmux", "/srv/atmux")]));
    expect(r.parents).toEqual([{ name: "atmux", root: "/srv/atmux", softStopped: false }]);
    expect(r.epicsByParent.size).toBe(0);
  });

  test("epic-team under team links to parent", () => {
    const r = walkCockpit(
      cockpitWith([teamSession("atmux", "/srv/atmux", [epicTeamSession("ep", "atmux", "e-1")])]),
    );
    expect(r.parents).toHaveLength(1);
    const epics = r.epicsByParent.get("atmux");
    expect(epics).toEqual([{ eid: "e-1", sessionName: "ep", softStopped: false }]);
  });

  test("epic-team without epicId falls back to session name", () => {
    const r = walkCockpit(
      cockpitWith([
        teamSession("atmux", "/srv/atmux", [
          { type: "epic-team", name: "ep-noid", enabled: true, parent: "atmux", sessions: [] },
        ]),
      ]),
    );
    const epics = r.epicsByParent.get("atmux");
    expect(epics?.[0]?.eid).toBe("ep-noid");
  });

  test("non-team/epic sessions are ignored", () => {
    const r = walkCockpit(
      cockpitWith([
        { type: "superdriver", name: "sd", enabled: true },
        { type: "medic", name: "m", enabled: true },
        teamSession("atmux", "/srv/atmux"),
      ]),
    );
    expect(r.parents).toEqual([{ name: "atmux", root: "/srv/atmux", softStopped: false }]);
    expect(r.epicsByParent.size).toBe(0);
  });

  test("recursive walk finds nested epic-teams", () => {
    const r = walkCockpit(
      cockpitWith([
        teamSession("atmux", "/srv/atmux", [
          teamSession("inner", "/srv/inner", [epicTeamSession("ep-2", "inner", "e-2")]),
        ]),
      ]),
    );
    expect(r.parents.map((p) => p.name).sort()).toEqual(["atmux", "inner"]);
    expect(r.epicsByParent.get("inner")?.[0]?.eid).toBe("e-2");
  });

  test("soft_stopped_at marks team + epic-team", () => {
    const r = walkCockpit(
      cockpitWith([
        {
          type: "team",
          name: "atmux",
          enabled: true,
          root: "/srv/atmux",
          soft_stopped_at: "2026-05-22T00:00:00Z",
          sessions: [
            {
              type: "epic-team",
              name: "ep",
              enabled: true,
              parent: "atmux",
              epicId: "e-1",
              soft_stopped_at: "2026-05-22T00:00:00Z",
              sessions: [],
            },
          ],
        },
      ]),
    );
    expect(r.parents[0]?.softStopped).toBe(true);
    expect(r.epicsByParent.get("atmux")?.[0]?.softStopped).toBe(true);
  });

  test("missing root coerces to empty string (defensive)", () => {
    const r = walkCockpit(cockpitWith([{ type: "team", name: "x", enabled: true, sessions: [] }]));
    expect(r.parents[0]?.root).toBe("");
  });

  test("missing parent on epic-team coerces to empty parent key", () => {
    const r = walkCockpit(
      cockpitWith([
        { type: "epic-team", name: "orphan", enabled: true, epicId: "e-x", sessions: [] },
      ]),
    );
    expect(r.epicsByParent.get("")?.[0]?.eid).toBe("e-x");
  });

  test("non-array sessions skipped without throwing", () => {
    const r = walkCockpit(
      cockpitWith([
        { type: "team", name: "atmux", enabled: true, root: "/srv/atmux", sessions: undefined },
      ]),
    );
    expect(r.parents).toHaveLength(1);
    expect(r.epicsByParent.size).toBe(0);
  });

  test("malformed child entries skipped (no type or no name)", () => {
    const r = walkCockpit(
      cockpitWith([
        teamSession("atmux", "/srv/atmux", [
          { type: 42, name: "bad" },
          { type: "team", name: undefined, root: "/srv/x" },
        ]),
      ]),
    );
    expect(r.parents).toEqual([{ name: "atmux", root: "/srv/atmux", softStopped: false }]);
  });
});

// ---------- aggregateTopo: cockpit null branch (§D5 row 1) ----------

describe("aggregateTopo — cockpit null (§D5 row 1)", () => {
  test("emits minimal manifest with cockpit.alive: false when socket dead", async () => {
    const { io } = makeStubIO({
      cockpit: null,
      cockpitSocketPath: "/tmp/.tmux-1000/atmux-cockpit",
      cageAlive: () => false,
    });
    const m = await aggregateTopo(io);
    expect(m.schema_version).toBe(1);
    expect(m.cockpit.alive).toBe(false);
    expect(m.cockpit.sessions_count).toBe(0);
    expect(m.cockpit.registry_path).toBe("/root/.atmux/cockpit.json");
    expect(m.cockpit.socket).toBe("/tmp/.tmux-1000/atmux-cockpit");
    expect(m.teams).toEqual([]);
    expect(m.orphans).toEqual([]);
    expect(m.summary.teams_count).toBe(0);
    expect(m.summary.cages_alive).toBe(0);
  });

  test("cockpit null with cockpit socket alive still gives alive:true + empty teams", async () => {
    const { io } = makeStubIO({
      cockpit: null,
      cageAlive: () => true,
    });
    const m = await aggregateTopo(io);
    expect(m.cockpit.alive).toBe(true);
    expect(m.summary.cages_alive).toBe(1);
    expect(m.teams).toEqual([]);
  });
});

// ---------- aggregateTopo: cockpit happy paths ----------

describe("aggregateTopo — teams + epics happy paths", () => {
  test("teams sorted alphabetically; epics sorted by eid", async () => {
    const cockpit = cockpitWith([
      teamSession("zebra", "/srv/zebra"),
      teamSession("atmux", "/srv/atmux", [
        epicTeamSession("ep-b", "atmux", "e-bbb"),
        epicTeamSession("ep-a", "atmux", "e-aaa"),
      ]),
    ]);
    const { io } = makeStubIO({ cockpit, cageAlive: () => true });
    const m = await aggregateTopo(io);
    expect(m.teams.map((t) => t.name)).toEqual(["atmux", "zebra"]);
    expect(m.teams[0]?.epics.map((e) => e.eid)).toEqual(["e-aaa", "e-bbb"]);
  });

  test("populated kanban + lastCommit produces max last_activity", async () => {
    const cockpit = cockpitWith([teamSession("atmux", "/srv/atmux")]);
    const { io } = makeStubIO({
      cockpit,
      cageAlive: () => true,
      branch: () => "atmux-geoyws",
      lastCommit: () => "2026-05-22T13:00:00.000Z",
      kanban: () => ({
        epics: 3,
        epic_ids: ["e-1", "e-2", "e-3"],
        tasks_open: 5,
        tasks_done: 100,
        last_activity: "2026-05-22T13:50:00.000Z",
      }),
    });
    const m = await aggregateTopo(io);
    const team = m.teams[0];
    expect(team?.branch).toBe("atmux-geoyws");
    expect(team?.kanban?.epics).toBe(3);
    expect(team?.kanban?.tasks_open).toBe(5);
    expect(team?.last_activity).toBe("2026-05-22T13:50:00.000Z"); // kanban > commit
  });

  test("last_activity prefers commit when commit > kanban", async () => {
    const cockpit = cockpitWith([teamSession("atmux", "/srv/atmux")]);
    const { io } = makeStubIO({
      cockpit,
      lastCommit: () => "2026-05-22T13:50:00.000Z",
      kanban: () => ({
        tasks_open: 0,
        tasks_done: 0,
        last_activity: "2026-05-22T10:00:00.000Z",
      }),
    });
    const m = await aggregateTopo(io);
    expect(m.teams[0]?.last_activity).toBe("2026-05-22T13:50:00.000Z");
  });

  test("kanban null (§D5 row 2) → kanban: null + last_activity from commit only", async () => {
    const cockpit = cockpitWith([teamSession("atmux", "/srv/atmux")]);
    const { io } = makeStubIO({
      cockpit,
      kanban: () => null,
      lastCommit: () => "2026-05-22T13:00:00.000Z",
    });
    const m = await aggregateTopo(io);
    expect(m.teams[0]?.kanban).toBeNull();
    expect(m.teams[0]?.last_activity).toBe("2026-05-22T13:00:00.000Z");
  });

  test("both kanban + commit null → last_activity null", async () => {
    const cockpit = cockpitWith([teamSession("atmux", "/srv/atmux")]);
    const { io } = makeStubIO({ cockpit });
    const m = await aggregateTopo(io);
    expect(m.teams[0]?.last_activity).toBeNull();
  });

  test("cage_alive: true counts toward summary.cages_alive", async () => {
    const cockpit = cockpitWith([
      teamSession("atmux", "/srv/atmux", [epicTeamSession("ep", "atmux", "e-1")]),
    ]);
    const { io } = makeStubIO({
      cockpit,
      cageAlive: (s) => s.includes("e-1") || s.includes(".tmux-1000"),
    });
    const m = await aggregateTopo(io);
    // cockpit + epic cage = 2 alive; parent cage dead.
    expect(m.summary.cages_alive).toBe(2);
    expect(m.teams[0]?.cage_alive).toBe(false);
    expect(m.teams[0]?.epics[0]?.cage_alive).toBe(true);
  });

  test("softStopped flag surfaces on team + epic rows", async () => {
    const cockpit = cockpitWith([
      {
        type: "team",
        name: "atmux",
        enabled: true,
        root: "/srv/atmux",
        soft_stopped_at: "2026-05-22T00:00:00Z",
        sessions: [
          {
            type: "epic-team",
            name: "ep",
            enabled: true,
            parent: "atmux",
            epicId: "e-1",
            soft_stopped_at: "2026-05-22T00:00:00Z",
            sessions: [],
          },
        ],
      },
    ]);
    const { io } = makeStubIO({ cockpit });
    const m = await aggregateTopo(io);
    expect(m.teams[0]?.soft_stopped).toBe(true);
    expect(m.teams[0]?.epics[0]?.soft_stopped).toBe(true);
  });

  test("non-softStopped omits the flag entirely", async () => {
    const cockpit = cockpitWith([teamSession("atmux", "/srv/atmux")]);
    const { io } = makeStubIO({ cockpit });
    const m = await aggregateTopo(io);
    expect(m.teams[0]?.soft_stopped).toBeUndefined();
  });

  test("elapsed_ms computed from io.now() delta", async () => {
    const cockpit = cockpitWith([teamSession("atmux", "/srv/atmux")]);
    const { io } = makeStubIO({
      cockpit,
      nowSeq: [new Date("2026-05-22T13:54:00.000Z"), new Date("2026-05-22T13:54:00.487Z")],
    });
    const m = await aggregateTopo(io);
    expect(m.summary.elapsed_ms).toBe(487);
    expect(m.generated_at).toBe("2026-05-22T13:54:00.000Z");
  });

  test("clock-skew (finish before start) clamps elapsed_ms to 0", async () => {
    const cockpit = cockpitWith([teamSession("atmux", "/srv/atmux")]);
    const { io } = makeStubIO({
      cockpit,
      nowSeq: [new Date("2026-05-22T13:54:00.100Z"), new Date("2026-05-22T13:54:00.000Z")],
    });
    const m = await aggregateTopo(io);
    expect(m.summary.elapsed_ms).toBe(0);
  });
});

// ---------- aggregateOneTeam: branch failure ----------

describe("aggregateOneTeam — failure narrowing", () => {
  test("branch null (§D5 row 6 broken worktree)", async () => {
    const cockpit = cockpitWith([teamSession("atmux", "/srv/atmux")]);
    const { io } = makeStubIO({ cockpit, branch: () => null });
    const m = await aggregateTopo(io);
    expect(m.teams[0]?.branch).toBeNull();
  });
});

// ---------- aggregateOneEpic: full matrix ----------

describe("aggregateOneEpic — git-probe matrix (§D5 row 5)", () => {
  test("parent branch null skips ahead/merged probes entirely", async () => {
    const cockpit = cockpitWith([
      teamSession("atmux", "/srv/atmux", [epicTeamSession("ep", "atmux", "e-1")]),
    ]);
    const { io, calls } = makeStubIO({
      cockpit,
      branch: () => null, // both parent + epic branches probe-null
    });
    const m = await aggregateTopo(io);
    const epic = m.teams[0]?.epics[0];
    expect(epic?.branch_ahead_of_trunk).toBeNull();
    expect(epic?.branch_merged_to_trunk).toBeNull();
    // No ahead/merged IO calls because parent branch was null.
    expect(calls.ahead).toHaveLength(0);
    expect(calls.merged).toHaveLength(0);
  });

  test("parent branch present + ahead/merged populated", async () => {
    const cockpit = cockpitWith([
      teamSession("atmux", "/srv/atmux", [epicTeamSession("ep", "atmux", "e-1")]),
    ]);
    const { io, calls } = makeStubIO({
      cockpit,
      branch: (wt) => (wt === "/srv/atmux" ? "atmux-geoyws" : "atmux-geoyws-epic-e-1"),
      ahead: () => 3,
      merged: () => false,
    });
    const m = await aggregateTopo(io);
    const epic = m.teams[0]?.epics[0];
    expect(epic?.branch_ahead_of_trunk).toBe(3);
    expect(epic?.branch_merged_to_trunk).toBe(false);
    // The ahead/merged probes hit the parent repo with the hint-branch name.
    expect(calls.ahead[0]?.base).toBe("atmux-geoyws");
    expect(calls.ahead[0]?.branch).toBe("atmux-geoyws-epic-e-1");
    expect(calls.merged[0]?.branch).toBe("atmux-geoyws-epic-e-1");
  });

  test("ahead null (§D5 row 5 timeout) + merged true", async () => {
    const cockpit = cockpitWith([
      teamSession("atmux", "/srv/atmux", [epicTeamSession("ep", "atmux", "e-1")]),
    ]);
    const { io } = makeStubIO({
      cockpit,
      branch: () => "atmux-geoyws",
      ahead: () => null,
      merged: () => true,
    });
    const m = await aggregateTopo(io);
    expect(m.teams[0]?.epics[0]?.branch_ahead_of_trunk).toBeNull();
    expect(m.teams[0]?.epics[0]?.branch_merged_to_trunk).toBe(true);
  });

  test("in_parent_kanban: parent kanban null → null", async () => {
    const cockpit = cockpitWith([
      teamSession("atmux", "/srv/atmux", [epicTeamSession("ep", "atmux", "e-1")]),
    ]);
    const { io } = makeStubIO({ cockpit, kanban: () => null });
    const m = await aggregateTopo(io);
    expect(m.teams[0]?.epics[0]?.in_parent_kanban).toBeNull();
  });

  test("in_parent_kanban: parent kanban missing epic_ids → null (conservative)", async () => {
    const cockpit = cockpitWith([
      teamSession("atmux", "/srv/atmux", [epicTeamSession("ep", "atmux", "e-1")]),
    ]);
    const { io } = makeStubIO({
      cockpit,
      kanban: (_dir, opts) =>
        opts.parent
          ? { tasks_open: 0, tasks_done: 0, last_activity: null, epics: 0 }
          : { tasks_open: 0, tasks_done: 0, last_activity: null },
    });
    const m = await aggregateTopo(io);
    expect(m.teams[0]?.epics[0]?.in_parent_kanban).toBeNull();
  });

  test("in_parent_kanban: epic_ids contains eid → true", async () => {
    const cockpit = cockpitWith([
      teamSession("atmux", "/srv/atmux", [epicTeamSession("ep", "atmux", "e-1")]),
    ]);
    const { io } = makeStubIO({
      cockpit,
      kanban: (_dir, opts) =>
        opts.parent
          ? {
              tasks_open: 0,
              tasks_done: 0,
              last_activity: null,
              epics: 1,
              epic_ids: ["e-1"],
            }
          : { tasks_open: 0, tasks_done: 0, last_activity: null },
    });
    const m = await aggregateTopo(io);
    expect(m.teams[0]?.epics[0]?.in_parent_kanban).toBe(true);
  });

  test("in_parent_kanban: epic_ids missing this eid → false", async () => {
    const cockpit = cockpitWith([
      teamSession("atmux", "/srv/atmux", [epicTeamSession("ep", "atmux", "e-1")]),
    ]);
    const { io } = makeStubIO({
      cockpit,
      kanban: (_dir, opts) =>
        opts.parent
          ? {
              tasks_open: 0,
              tasks_done: 0,
              last_activity: null,
              epics: 1,
              epic_ids: ["e-other"],
            }
          : { tasks_open: 0, tasks_done: 0, last_activity: null },
    });
    const m = await aggregateTopo(io);
    expect(m.teams[0]?.epics[0]?.in_parent_kanban).toBe(false);
  });

  test("epic kanban populated has no `epics` field on the manifest", async () => {
    const cockpit = cockpitWith([
      teamSession("atmux", "/srv/atmux", [epicTeamSession("ep", "atmux", "e-1")]),
    ]);
    const { io } = makeStubIO({
      cockpit,
      kanban: (_dir, opts) =>
        opts.parent
          ? { tasks_open: 0, tasks_done: 0, last_activity: null, epics: 1, epic_ids: ["e-1"] }
          : { tasks_open: 5, tasks_done: 2, last_activity: "2026-05-22T12:00:00.000Z" },
    });
    const m = await aggregateTopo(io);
    const epicKanban = m.teams[0]?.epics[0]?.kanban;
    expect(epicKanban?.tasks_open).toBe(5);
    expect(epicKanban?.tasks_done).toBe(2);
    expect(epicKanban?.epics).toBeUndefined();
  });

  test("epic socket path correctly probed", async () => {
    const cockpit = cockpitWith([
      teamSession("atmux", "/srv/atmux", [epicTeamSession("ep", "atmux", "e-1")]),
    ]);
    const { io, calls } = makeStubIO({ cockpit });
    await aggregateTopo(io);
    expect(calls.cageAlive).toContain("/tmp/atmux-atmux/epics/e-1/tmux-0/default");
    expect(calls.cageAlive).toContain("/tmp/atmux-atmux/sock");
  });
});

// ---------- Determinism: same IO → same manifest ----------

describe("determinism", () => {
  test("two runs against the same IO produce identical manifests", async () => {
    const cockpit = cockpitWith([
      teamSession("zebra", "/srv/zebra"),
      teamSession("atmux", "/srv/atmux", [epicTeamSession("ep", "atmux", "e-1")]),
    ]);
    const spec: StubIOSpec = {
      cockpit,
      cageAlive: () => true,
      branch: () => "atmux-geoyws",
      lastCommit: () => "2026-05-22T13:00:00.000Z",
      kanban: (_dir, opts) =>
        opts.parent
          ? { tasks_open: 1, tasks_done: 2, last_activity: null, epics: 1, epic_ids: ["e-1"] }
          : { tasks_open: 0, tasks_done: 0, last_activity: null },
      ahead: () => 0,
      merged: () => true,
      nowSeq: [new Date("2026-05-22T13:54:00.000Z"), new Date("2026-05-22T13:54:00.100Z")],
    };
    const first = await aggregateTopo(makeStubIO(spec).io);
    const second = await aggregateTopo(makeStubIO(spec).io);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
