// Unit tests for src/core/topo-aggregate.ts (ADR-222 §D3 / t-4de545c8
// + Plan-B refactor under t-4b1c831d).
//
// Architecture split per lead routing 2026-05-22:
//   - gatherDiscovery(io): async, the ONLY IO entry point → Discovery
//   - aggregateTopo(discovery): sync pure transformation → TopoManifest
//   - walkCockpit: pure shape walker, consumed by gatherDiscovery
//
// Coverage matrix:
//   gatherDiscovery:
//     - cockpit null (§D5 row 1) → empty parents + cockpit.data: null +
//       global probes still populated
//     - cockpit present + per-parent + per-epic probes fully populated
//     - cockpit-socket alive true / false
//     - parents sorted alphabetically; epics sorted by eid
//     - parent branch null → epic ahead/merged auto-null + no IO calls;
//       parent branch empty string → no branches enumeration
//     - elapsed_ms computed from io.now() delta; clock-skew clamped ≥0
//     - every IO method's null return surfaces on the right field
//
//   aggregateTopo:
//     - empty discovery (cockpit null, no parents) → minimal manifest
//     - populated discovery → teams + epics + summary; orphans empty
//     - cockpit alive / dead counts toward summary.cages_alive
//     - parent + epic soft_stopped flags surface on manifest rows
//     - last_activity = max(last_commit, kanban.last_activity)
//     - in_parent_kanban: null when parentKanban null; null when
//       epic_ids missing; true when epic_ids contains eid; false
//       when absent
//     - summary.elapsed_ms = discovery.elapsed_ms (verbatim)
//
//   walkCockpit:
//     - empty / team-only / epic-team under team / recursive nesting
//     - epicId fallback to name; missing root/parent coerced; non-array
//       sessions skipped; malformed entries skipped; non-team/epic
//       sessions ignored; soft_stopped_at recognized
//
//   Path helpers (cageSocketForTeam / cageSocketForEpic /
//     atmuxDirForTeam / worktreeForEpic / atmuxDirForEpic /
//     formatIsoMs).

import { describe, expect, test } from "bun:test";
import type { LoadedCockpit } from "../../../src/core/cockpit.ts";
import {
  aggregateTopo,
  atmuxDirForEpic,
  atmuxDirForTeam,
  cageSocketForEpic,
  cageSocketForTeam,
  type Discovery,
  type DiscoveryIO,
  type EpicDiscovery,
  formatIsoMs,
  gatherDiscovery,
  type KanbanProbe,
  type ParentDiscovery,
  walkCockpit,
  worktreeForEpic,
} from "../../../src/core/topo-aggregate.ts";

// ---------- Stub IO for gatherDiscovery ----------

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
  sockets?: ReturnType<DiscoveryIO["listAliveCageSockets"]> extends Promise<infer T> ? T : never;
  cronBlocks?: Awaited<ReturnType<DiscoveryIO["listCronMarkerBlocks"]>>;
  worktrees?: (
    parentRoot: string,
    parentName: string,
  ) => Awaited<ReturnType<DiscoveryIO["listEpicWorktreeDirs"]>>;
  branches?: (
    repoPath: string,
    base: string,
    parentName: string,
  ) => Awaited<ReturnType<DiscoveryIO["listEpicBranches"]>>;
  kanbanEpicRows?: (atmuxDir: string) => Awaited<ReturnType<DiscoveryIO["listKanbanEpicRows"]>>;
  nowSeq?: Date[];
}

interface StubIOCalls {
  cageAlive: string[];
  kanban: Array<{ atmuxDir: string; parent: boolean }>;
  branch: string[];
  lastCommit: string[];
  ahead: Array<{ repo: string; base: string; branch: string }>;
  merged: Array<{ repo: string; base: string; branch: string }>;
  sockets: number;
  cron: number;
  worktrees: Array<{ root: string; name: string }>;
  branches: Array<{ repo: string; base: string; name: string }>;
  kanbanEpicRows: string[];
  now: number;
}

function makeStubIO(spec: StubIOSpec = {}): { io: DiscoveryIO; calls: StubIOCalls } {
  const calls: StubIOCalls = {
    cageAlive: [],
    kanban: [],
    branch: [],
    lastCommit: [],
    ahead: [],
    merged: [],
    sockets: 0,
    cron: 0,
    worktrees: [],
    branches: [],
    kanbanEpicRows: [],
    now: 0,
  };
  const nowSeq = spec.nowSeq ?? [
    new Date("2026-05-22T13:54:00.000Z"),
    new Date("2026-05-22T13:54:00.100Z"),
  ];
  const io: DiscoveryIO = {
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
    async listAliveCageSockets() {
      calls.sockets += 1;
      return spec.sockets ?? [];
    },
    async listCronMarkerBlocks() {
      calls.cron += 1;
      return spec.cronBlocks === undefined ? null : spec.cronBlocks;
    },
    async listEpicWorktreeDirs(root, name) {
      calls.worktrees.push({ root, name });
      return spec.worktrees ? spec.worktrees(root, name) : [];
    },
    async listEpicBranches(repo, base, name) {
      calls.branches.push({ repo, base, name });
      return spec.branches ? spec.branches(repo, base, name) : [];
    },
    async listKanbanEpicRows(atmuxDir) {
      calls.kanbanEpicRows.push(atmuxDir);
      return spec.kanbanEpicRows ? spec.kanbanEpicRows(atmuxDir) : null;
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

// ---------- Discovery fixtures for aggregateTopo tests ----------

function emptyDiscovery(overrides: Partial<Discovery> = {}): Discovery {
  return {
    generated_at: new Date("2026-05-22T13:54:00.000Z"),
    elapsed_ms: 0,
    cockpit: {
      socket: "/tmp/.tmux-1000/atmux-cockpit",
      alive: false,
      registry_path: "/root/.atmux/cockpit.json",
      data: null,
    },
    parents: [],
    global: { sockets_alive: [], cron_marker_blocks: null },
    ...overrides,
  };
}

function parentDiscovery(overrides: Partial<ParentDiscovery> = {}): ParentDiscovery {
  return {
    name: "atmux",
    root: "/srv/atmux",
    soft_stopped: false,
    atmux_dir: "/srv/atmux/.atmux",
    worktree: "/srv/atmux",
    cage_socket: "/tmp/atmux-atmux/sock",
    cage_alive: false,
    branch: null,
    last_commit: null,
    kanban: null,
    worktrees_on_disk: [],
    branches: [],
    kanban_epic_rows: null,
    epics: [],
    ...overrides,
  };
}

function epicDiscovery(overrides: Partial<EpicDiscovery> = {}): EpicDiscovery {
  return {
    eid: "e-1",
    session_name: "ep-1",
    parent: "atmux",
    soft_stopped: false,
    atmux_dir: "/srv/atmux-epics/e-1/.atmux",
    worktree: "/srv/atmux-epics/e-1",
    cage_socket: "/tmp/atmux-atmux/epics/e-1/tmux-0/default",
    cage_alive: false,
    branch: null,
    last_commit: null,
    ahead: null,
    merged: null,
    kanban: null,
    ...overrides,
  };
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

  test("worktreeForEpic resolves to sibling atmux-epics dir", () => {
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
    expect(formatIsoMs(new Date("2026-05-22T13:54:00.123Z"))).toBe("2026-05-22T13:54:00.123Z");
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
    expect(r.epicsByParent.get("atmux")).toEqual([
      { eid: "e-1", sessionName: "ep", softStopped: false },
    ]);
  });

  test("epic-team without epicId falls back to session name", () => {
    const r = walkCockpit(
      cockpitWith([
        teamSession("atmux", "/srv/atmux", [
          { type: "epic-team", name: "ep-noid", enabled: true, parent: "atmux", sessions: [] },
        ]),
      ]),
    );
    expect(r.epicsByParent.get("atmux")?.[0]?.eid).toBe("ep-noid");
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

// ---------- gatherDiscovery — cockpit null (§D5 row 1) ----------

describe("gatherDiscovery — cockpit null (§D5 row 1)", () => {
  test("emits empty parents with cockpit.data null + cockpit.alive false", async () => {
    const { io } = makeStubIO({ cockpit: null, cageAlive: () => false });
    const d = await gatherDiscovery(io);
    expect(d.cockpit.data).toBeNull();
    expect(d.cockpit.alive).toBe(false);
    expect(d.cockpit.socket).toBe("/tmp/.tmux-1000/atmux-cockpit");
    expect(d.cockpit.registry_path).toBe("/root/.atmux/cockpit.json");
    expect(d.parents).toEqual([]);
  });

  test("global sockets + cron still gathered when cockpit null", async () => {
    const { io } = makeStubIO({
      cockpit: null,
      sockets: [{ socket: "/tmp/atmux-x/sock", parent: "x", eid: null }],
      cronBlocks: [{ ref: "atmux:team=x", atmux_dir: "/srv/x/.atmux", atmux_dir_exists: false }],
    });
    const d = await gatherDiscovery(io);
    expect(d.global.sockets_alive).toHaveLength(1);
    expect(d.global.cron_marker_blocks).toHaveLength(1);
  });

  test("cockpit socket alive surfaces on cockpit.alive", async () => {
    const { io } = makeStubIO({ cockpit: null, cageAlive: () => true });
    const d = await gatherDiscovery(io);
    expect(d.cockpit.alive).toBe(true);
  });
});

// ---------- gatherDiscovery — happy paths ----------

describe("gatherDiscovery — populated paths", () => {
  test("parents sorted alphabetically; epics sorted by eid", async () => {
    const cockpit = cockpitWith([
      teamSession("zebra", "/srv/zebra"),
      teamSession("atmux", "/srv/atmux", [
        epicTeamSession("ep-b", "atmux", "e-bbb"),
        epicTeamSession("ep-a", "atmux", "e-aaa"),
      ]),
    ]);
    const { io } = makeStubIO({ cockpit, cageAlive: () => true });
    const d = await gatherDiscovery(io);
    expect(d.parents.map((p) => p.name)).toEqual(["atmux", "zebra"]);
    expect(d.parents[0]?.epics.map((e) => e.eid)).toEqual(["e-aaa", "e-bbb"]);
  });

  test("per-team probes populate parent fields", async () => {
    const cockpit = cockpitWith([teamSession("atmux", "/srv/atmux")]);
    const { io, calls } = makeStubIO({
      cockpit,
      cageAlive: () => true,
      branch: () => "atmux-geoyws",
      lastCommit: () => "2026-05-22T13:00:00.000Z",
      kanban: () => ({
        epics: 1,
        epic_ids: ["e-1"],
        tasks_open: 4,
        tasks_done: 12,
        last_activity: "2026-05-22T13:50:00.000Z",
      }),
      worktrees: () => [{ path: "/srv/atmux-epics/e-1", parent: "atmux", eid: "e-1" }],
      branches: () => [{ parent: "atmux", branch: "atmux-geoyws-epic-e-1", eid: "e-1" }],
      kanbanEpicRows: () => [{ eid: "e-1", status: "in-progress" }],
    });
    const d = await gatherDiscovery(io);
    const p = d.parents[0];
    expect(p?.cage_alive).toBe(true);
    expect(p?.branch).toBe("atmux-geoyws");
    expect(p?.last_commit).toBe("2026-05-22T13:00:00.000Z");
    expect(p?.kanban?.tasks_open).toBe(4);
    expect(p?.worktrees_on_disk).toHaveLength(1);
    expect(p?.branches).toHaveLength(1);
    expect(p?.kanban_epic_rows).toEqual([{ eid: "e-1", status: "in-progress" }]);
    // listEpicBranches was called because branch was populated.
    expect(calls.branches).toHaveLength(1);
  });

  test("parent branch null → branches enumeration skipped, ahead/merged auto-null", async () => {
    const cockpit = cockpitWith([
      teamSession("atmux", "/srv/atmux", [epicTeamSession("ep", "atmux", "e-1")]),
    ]);
    const { io, calls } = makeStubIO({ cockpit, branch: () => null });
    const d = await gatherDiscovery(io);
    expect(d.parents[0]?.branches).toEqual([]);
    expect(d.parents[0]?.epics[0]?.ahead).toBeNull();
    expect(d.parents[0]?.epics[0]?.merged).toBeNull();
    expect(calls.branches).toHaveLength(0);
    expect(calls.ahead).toHaveLength(0);
    expect(calls.merged).toHaveLength(0);
  });

  test("parent branch empty string also skips branches enumeration", async () => {
    const cockpit = cockpitWith([teamSession("atmux", "/srv/atmux")]);
    const { io, calls } = makeStubIO({ cockpit, branch: () => "" });
    await gatherDiscovery(io);
    expect(calls.branches).toHaveLength(0);
  });

  test("epic probes populate epic fields + ahead/merged from parent branch", async () => {
    const cockpit = cockpitWith([
      teamSession("atmux", "/srv/atmux", [epicTeamSession("ep", "atmux", "e-1")]),
    ]);
    const { io, calls } = makeStubIO({
      cockpit,
      branch: (wt) => (wt === "/srv/atmux" ? "atmux-geoyws" : "atmux-geoyws-epic-e-1"),
      ahead: () => 3,
      merged: () => false,
    });
    const d = await gatherDiscovery(io);
    const e = d.parents[0]?.epics[0];
    expect(e?.ahead).toBe(3);
    expect(e?.merged).toBe(false);
    expect(e?.branch).toBe("atmux-geoyws-epic-e-1");
    expect(calls.ahead[0]?.branch).toBe("atmux-geoyws-epic-e-1");
    expect(calls.merged[0]?.branch).toBe("atmux-geoyws-epic-e-1");
  });

  test("ahead null (§D5 row 5) + merged true", async () => {
    const cockpit = cockpitWith([
      teamSession("atmux", "/srv/atmux", [epicTeamSession("ep", "atmux", "e-1")]),
    ]);
    const { io } = makeStubIO({
      cockpit,
      branch: () => "atmux-geoyws",
      ahead: () => null,
      merged: () => true,
    });
    const d = await gatherDiscovery(io);
    expect(d.parents[0]?.epics[0]?.ahead).toBeNull();
    expect(d.parents[0]?.epics[0]?.merged).toBe(true);
  });

  test("kanban null (§D5 row 2)", async () => {
    const cockpit = cockpitWith([teamSession("atmux", "/srv/atmux")]);
    const { io } = makeStubIO({ cockpit, kanban: () => null });
    const d = await gatherDiscovery(io);
    expect(d.parents[0]?.kanban).toBeNull();
  });

  test("kanban_epic_rows null (§D5 row 2 for the row-listing probe)", async () => {
    const cockpit = cockpitWith([teamSession("atmux", "/srv/atmux")]);
    const { io } = makeStubIO({ cockpit, kanbanEpicRows: () => null });
    const d = await gatherDiscovery(io);
    expect(d.parents[0]?.kanban_epic_rows).toBeNull();
  });

  test("cron blocks null (§D5 row 4)", async () => {
    const { io } = makeStubIO({ cockpit: null, cronBlocks: null });
    const d = await gatherDiscovery(io);
    expect(d.global.cron_marker_blocks).toBeNull();
  });

  test("elapsed_ms computed from io.now() delta", async () => {
    const cockpit = cockpitWith([teamSession("atmux", "/srv/atmux")]);
    const { io } = makeStubIO({
      cockpit,
      nowSeq: [new Date("2026-05-22T13:54:00.000Z"), new Date("2026-05-22T13:54:00.487Z")],
    });
    const d = await gatherDiscovery(io);
    expect(d.elapsed_ms).toBe(487);
  });

  test("clock-skew (finish before start) clamps elapsed_ms to 0", async () => {
    const cockpit = cockpitWith([teamSession("atmux", "/srv/atmux")]);
    const { io } = makeStubIO({
      cockpit,
      nowSeq: [new Date("2026-05-22T13:54:00.100Z"), new Date("2026-05-22T13:54:00.000Z")],
    });
    const d = await gatherDiscovery(io);
    expect(d.elapsed_ms).toBe(0);
  });

  test("soft_stopped flags propagate to parent + epic discovery rows", async () => {
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
    const d = await gatherDiscovery(io);
    expect(d.parents[0]?.soft_stopped).toBe(true);
    expect(d.parents[0]?.epics[0]?.soft_stopped).toBe(true);
  });

  test("cage_alive probes include cockpit + per-team + per-epic sockets", async () => {
    const cockpit = cockpitWith([
      teamSession("atmux", "/srv/atmux", [epicTeamSession("ep", "atmux", "e-1")]),
    ]);
    const { io, calls } = makeStubIO({ cockpit });
    await gatherDiscovery(io);
    expect(calls.cageAlive).toContain("/tmp/.tmux-1000/atmux-cockpit");
    expect(calls.cageAlive).toContain("/tmp/atmux-atmux/sock");
    expect(calls.cageAlive).toContain("/tmp/atmux-atmux/epics/e-1/tmux-0/default");
  });
});

// ---------- aggregateTopo (pure transformation) ----------

describe("aggregateTopo — empty / cockpit-null discovery", () => {
  test("emits minimal manifest from empty discovery", () => {
    const m = aggregateTopo(emptyDiscovery());
    expect(m.schema_version).toBe(2);
    expect(m.cockpit.alive).toBe(false);
    expect(m.cockpit.sessions_count).toBe(0);
    expect(m.teams).toEqual([]);
    expect(m.orphans).toEqual([]);
    expect(m.summary.teams_count).toBe(0);
    expect(m.summary.epics_count).toBe(0);
    expect(m.summary.cages_alive).toBe(0);
    expect(m.summary.elapsed_ms).toBe(0);
  });

  test("cockpit alive counts toward cages_alive", () => {
    const m = aggregateTopo(
      emptyDiscovery({
        cockpit: {
          socket: "/x",
          alive: true,
          registry_path: "/r",
          data: null,
        },
      }),
    );
    expect(m.cockpit.alive).toBe(true);
    expect(m.summary.cages_alive).toBe(1);
  });

  test("cockpit data populated → sessions_count from data.sessions.length", () => {
    const m = aggregateTopo(
      emptyDiscovery({
        cockpit: {
          socket: "/x",
          alive: true,
          registry_path: "/r",
          data: cockpitWith([teamSession("a", "/srv/a"), teamSession("b", "/srv/b")]),
        },
      }),
    );
    expect(m.cockpit.sessions_count).toBe(2);
  });
});

describe("aggregateTopo — teams + epics", () => {
  test("parent row populated from ParentDiscovery", () => {
    const m = aggregateTopo(
      emptyDiscovery({
        parents: [
          parentDiscovery({
            name: "atmux",
            branch: "atmux-geoyws",
            cage_alive: true,
            kanban: { tasks_open: 5, tasks_done: 100, last_activity: null, epics: 0 },
          }),
        ],
      }),
    );
    expect(m.teams[0]?.name).toBe("atmux");
    expect(m.teams[0]?.branch).toBe("atmux-geoyws");
    expect(m.teams[0]?.cage_alive).toBe(true);
    expect(m.teams[0]?.kanban?.tasks_open).toBe(5);
  });

  test("last_activity = max(last_commit, kanban.last_activity)", () => {
    const m = aggregateTopo(
      emptyDiscovery({
        parents: [
          parentDiscovery({
            last_commit: "2026-05-22T10:00:00.000Z",
            kanban: { tasks_open: 0, tasks_done: 0, last_activity: "2026-05-22T13:50:00.000Z" },
          }),
        ],
      }),
    );
    expect(m.teams[0]?.last_activity).toBe("2026-05-22T13:50:00.000Z");
  });

  test("last_activity prefers commit when commit > kanban", () => {
    const m = aggregateTopo(
      emptyDiscovery({
        parents: [
          parentDiscovery({
            last_commit: "2026-05-22T13:50:00.000Z",
            kanban: { tasks_open: 0, tasks_done: 0, last_activity: "2026-05-22T10:00:00.000Z" },
          }),
        ],
      }),
    );
    expect(m.teams[0]?.last_activity).toBe("2026-05-22T13:50:00.000Z");
  });

  test("last_activity null when both probes null", () => {
    const m = aggregateTopo(
      emptyDiscovery({
        parents: [parentDiscovery({ last_commit: null, kanban: null })],
      }),
    );
    expect(m.teams[0]?.last_activity).toBeNull();
  });

  test("soft_stopped flag surfaces on team + epic rows", () => {
    const m = aggregateTopo(
      emptyDiscovery({
        parents: [
          parentDiscovery({
            soft_stopped: true,
            epics: [epicDiscovery({ soft_stopped: true })],
          }),
        ],
      }),
    );
    expect(m.teams[0]?.soft_stopped).toBe(true);
    expect(m.teams[0]?.epics[0]?.soft_stopped).toBe(true);
  });

  test("non-softStopped omits the flag entirely", () => {
    const m = aggregateTopo(
      emptyDiscovery({
        parents: [parentDiscovery({ soft_stopped: false, epics: [epicDiscovery()] })],
      }),
    );
    expect(m.teams[0]?.soft_stopped).toBeUndefined();
    expect(m.teams[0]?.epics[0]?.soft_stopped).toBeUndefined();
  });

  test("in_parent_kanban: parent kanban null → null", () => {
    const m = aggregateTopo(
      emptyDiscovery({
        parents: [parentDiscovery({ kanban: null, epics: [epicDiscovery({ eid: "e-1" })] })],
      }),
    );
    expect(m.teams[0]?.epics[0]?.in_parent_kanban).toBeNull();
  });

  test("in_parent_kanban: epic_ids missing → null", () => {
    const m = aggregateTopo(
      emptyDiscovery({
        parents: [
          parentDiscovery({
            kanban: { tasks_open: 0, tasks_done: 0, last_activity: null, epics: 0 },
            epics: [epicDiscovery({ eid: "e-1" })],
          }),
        ],
      }),
    );
    expect(m.teams[0]?.epics[0]?.in_parent_kanban).toBeNull();
  });

  test("in_parent_kanban: epic_ids contains eid → true", () => {
    const m = aggregateTopo(
      emptyDiscovery({
        parents: [
          parentDiscovery({
            kanban: {
              tasks_open: 0,
              tasks_done: 0,
              last_activity: null,
              epics: 1,
              epic_ids: ["e-1"],
            },
            epics: [epicDiscovery({ eid: "e-1" })],
          }),
        ],
      }),
    );
    expect(m.teams[0]?.epics[0]?.in_parent_kanban).toBe(true);
  });

  test("in_parent_kanban: epic_ids missing this eid → false", () => {
    const m = aggregateTopo(
      emptyDiscovery({
        parents: [
          parentDiscovery({
            kanban: {
              tasks_open: 0,
              tasks_done: 0,
              last_activity: null,
              epics: 1,
              epic_ids: ["e-other"],
            },
            epics: [epicDiscovery({ eid: "e-1" })],
          }),
        ],
      }),
    );
    expect(m.teams[0]?.epics[0]?.in_parent_kanban).toBe(false);
  });

  test("epic ahead/merged values pass through verbatim", () => {
    const m = aggregateTopo(
      emptyDiscovery({
        parents: [
          parentDiscovery({
            epics: [epicDiscovery({ ahead: 7, merged: false })],
          }),
        ],
      }),
    );
    expect(m.teams[0]?.epics[0]?.branch_ahead_of_trunk).toBe(7);
    expect(m.teams[0]?.epics[0]?.branch_merged_to_trunk).toBe(false);
  });

  test("epic last_activity = max(last_commit, kanban.last_activity)", () => {
    const m = aggregateTopo(
      emptyDiscovery({
        parents: [
          parentDiscovery({
            epics: [
              epicDiscovery({
                last_commit: "2026-05-22T13:00:00.000Z",
                kanban: { tasks_open: 0, tasks_done: 0, last_activity: "2026-05-22T13:50:00.000Z" },
              }),
            ],
          }),
        ],
      }),
    );
    expect(m.teams[0]?.epics[0]?.last_activity).toBe("2026-05-22T13:50:00.000Z");
  });

  test("summary.cages_alive counts cockpit + parents + epics", () => {
    const m = aggregateTopo(
      emptyDiscovery({
        cockpit: { socket: "/x", alive: true, registry_path: "/r", data: null },
        parents: [
          parentDiscovery({ cage_alive: true, epics: [epicDiscovery({ cage_alive: true })] }),
          parentDiscovery({ name: "other", cage_alive: false }),
        ],
      }),
    );
    expect(m.summary.cages_alive).toBe(3);
  });

  test("summary.epics_count totals epics across all parents", () => {
    const m = aggregateTopo(
      emptyDiscovery({
        parents: [
          parentDiscovery({
            epics: [epicDiscovery({ eid: "e-1" }), epicDiscovery({ eid: "e-2" })],
          }),
          parentDiscovery({ name: "other", epics: [epicDiscovery({ eid: "e-3" })] }),
        ],
      }),
    );
    expect(m.summary.epics_count).toBe(3);
  });

  test("summary.elapsed_ms passes through from discovery verbatim", () => {
    const m = aggregateTopo(emptyDiscovery({ elapsed_ms: 487 }));
    expect(m.summary.elapsed_ms).toBe(487);
  });

  test("generated_at formatted via formatIsoMs", () => {
    const m = aggregateTopo(emptyDiscovery({ generated_at: new Date("2026-05-22T13:54:00.123Z") }));
    expect(m.generated_at).toBe("2026-05-22T13:54:00.123Z");
  });
});

// ---------- Determinism: same discovery → same manifest ----------

describe("determinism", () => {
  test("two aggregateTopo runs against the same discovery produce identical manifests", () => {
    const discovery = emptyDiscovery({
      cockpit: {
        socket: "/x",
        alive: true,
        registry_path: "/r",
        data: cockpitWith([teamSession("atmux", "/srv/atmux")]),
      },
      parents: [
        parentDiscovery({
          cage_alive: true,
          branch: "atmux-geoyws",
          last_commit: "2026-05-22T13:00:00.000Z",
          kanban: {
            tasks_open: 1,
            tasks_done: 2,
            last_activity: null,
            epics: 1,
            epic_ids: ["e-1"],
          },
          epics: [epicDiscovery({ ahead: 0, merged: true })],
        }),
      ],
    });
    expect(JSON.stringify(aggregateTopo(discovery))).toBe(JSON.stringify(aggregateTopo(discovery)));
  });
});

// ---------- t-a14dfe3e: manifest v2 group tier ----------

function groupSession(name: string, sessions: unknown[] = []) {
  return { type: "group" as const, name, enabled: true, sessions };
}

describe("aggregateTopo — group tier (manifest v2)", () => {
  test("a team inside a group reports that group and level 1", () => {
    const m = aggregateTopo(
      emptyDiscovery({
        cockpit: {
          socket: "/x",
          alive: true,
          registry_path: "/r",
          data: cockpitWith([groupSession("geoyws", [teamSession("atmux", "/srv/atmux")])]),
        },
        parents: [parentDiscovery({ name: "atmux" })],
      }),
    );
    expect(m.schema_version).toBe(2);
    expect(m.groups).toEqual([{ name: "geoyws", parent_group: null, level: 0 }]);
    expect(m.teams[0]?.group).toBe("geoyws");
    expect(m.teams[0]?.level).toBe(1);
  });

  test("an ungrouped team reports group null and level 0", () => {
    const m = aggregateTopo(
      emptyDiscovery({
        cockpit: {
          socket: "/x",
          alive: true,
          registry_path: "/r",
          data: cockpitWith([teamSession("solo", "/srv/solo")]),
        },
        parents: [parentDiscovery({ name: "solo" })],
      }),
    );
    expect(m.groups).toEqual([]);
    expect(m.teams[0]?.group).toBeNull();
    expect(m.teams[0]?.level).toBe(0);
  });

  test("nested groups carry parent_group and increasing level", () => {
    const m = aggregateTopo(
      emptyDiscovery({
        cockpit: {
          socket: "/x",
          alive: true,
          registry_path: "/r",
          data: cockpitWith([
            groupSession("outer", [groupSession("inner", [teamSession("deep", "/srv/deep")])]),
          ]),
        },
        parents: [parentDiscovery({ name: "deep" })],
      }),
    );
    // Sorted by name, so inner precedes outer regardless of tree order.
    expect(m.groups).toEqual([
      { name: "inner", parent_group: "outer", level: 1 },
      { name: "outer", parent_group: null, level: 0 },
    ]);
    expect(m.teams[0]?.group).toBe("inner");
    expect(m.teams[0]?.level).toBe(2);
  });

  test("a null cockpit yields no groups and leaves every team ungrouped", () => {
    const m = aggregateTopo(emptyDiscovery({ parents: [parentDiscovery({ name: "atmux" })] }));
    expect(m.groups).toEqual([]);
    expect(m.teams[0]?.group).toBeNull();
  });

  test("a cockpit that FAILS validation degrades to no groups instead of throwing", () => {
    // buildGroupTopology throws ConfigError on the collision shapes it
    // refuses — here, two enabled groups sharing a name. `atmux topo` is
    // the diagnostic you reach for WHEN cockpit.json is broken, so it
    // must keep reporting rather than die on the very config it exists
    // to inspect (ADR-222 §D5: no probe throws).
    const m = aggregateTopo(
      emptyDiscovery({
        cockpit: {
          socket: "/x",
          alive: true,
          registry_path: "/r",
          data: cockpitWith([groupSession("dup"), groupSession("dup")]),
        },
        parents: [parentDiscovery({ name: "atmux" })],
      }),
    );
    expect(m.groups).toEqual([]);
    expect(m.teams[0]?.group).toBeNull();
    expect(m.schema_version).toBe(2);
  });

  test("a team in cockpit.json but absent from discovery does not invent a row", () => {
    const m = aggregateTopo(
      emptyDiscovery({
        cockpit: {
          socket: "/x",
          alive: true,
          registry_path: "/r",
          data: cockpitWith([groupSession("g", [teamSession("known", "/srv/known")])]),
        },
        parents: [],
      }),
    );
    expect(m.teams).toEqual([]);
    expect(m.groups).toEqual([{ name: "g", parent_group: null, level: 0 }]);
  });
});
