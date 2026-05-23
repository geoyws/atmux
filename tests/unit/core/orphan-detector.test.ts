// Unit tests for src/core/orphan-detector.ts (ADR-222 §D4 / t-4b1c831d).
//
// Coverage matrix per DoD ("1 positive + 1 negative per class + carve-outs"):
//
//   Class 1 (cage-tmux-without-registry):
//     pos: parent-cage alive, parent not in cockpit
//     pos: epic-cage alive, eid not in cockpit
//     neg: parent-cage alive, parent IS in cockpit
//     neg: epic-cage alive, eid IS in cockpit
//
//   Class 2 (cron-block-without-worktree):
//     pos: block with atmux_dir_exists=false → orphan
//     neg: block with atmux_dir_exists=true → no orphan
//     neg: cron_marker_blocks=null (§D5 row 4) → no class-2 rows
//
//   Class 3 (worktree-without-cage):
//     pos: worktree on disk, no matching cockpit epic
//     neg: worktree on disk, cockpit epic alive
//
//   Class 4 (branch-without-row):
//     pos: branch present, no cockpit + no worktree + no kanban row
//     neg: branch present, in cockpit
//     neg: branch present, kanban_epic_rows null (conservative skip)
//
//   Class 5 (kanban-epic-without-cage):
//     pos: row status=in-progress + no cage + no worktree
//     neg: row status=todo (not in-progress)
//     neg: row status=in-progress + worktree on disk
//     neg: row status=in-progress + cage alive
//     neg: kanban_epic_rows=null → no class-5 rows
//     carve-out: row in-progress + soft_stopped → no class-5 row
//
//   Class 6 (cockpit-registry-without-cage):
//     pos: cage_alive=false on epic ≥5min
//     neg: cage_alive=true
//     neg: cage_alive=false + soft_stopped → no class-6 row
//
//   Grace + state-file semantics:
//     30s grace: first observation never emits; second observation
//       ≥30s later emits with stable first_seen
//     5min grace for class 6: first observation never emits; 4min
//       later still doesn't emit; ≥5min emits
//     TTL eviction: stale entry NOT in candidate set + >7d old →
//       dropped
//     stale entry IN candidate set → preserved regardless of age
//     stale entry NOT in candidates + <7d → preserved
//
//   Ordering + determinism:
//     orphans sorted by (class, ref) per DoD
//     same inputs → same outputs

import { describe, expect, test } from "bun:test";
import {
  classifyOrphans,
  emptySeenState,
  type SeenState,
} from "../../../src/core/orphan-detector.ts";
import type {
  CronMarkerBlock,
  Discovery,
  ParentDiscovery,
  TmuxSocketEntry,
  TopoEpic,
  TopoManifest,
  TopoTeam,
  WorktreeOnDisk,
} from "../../../src/core/topo-aggregate.ts";

// ---------- Fixture builders ----------

function makeEpic(overrides: Partial<TopoEpic> = {}): TopoEpic {
  return {
    eid: "e-1",
    kind: "epic",
    parent: "atmux",
    atmux_dir: "/srv/atmux-epics/e-1/.atmux",
    worktree: "/srv/atmux-epics/e-1",
    branch: "atmux-geoyws-epic-e-1",
    cage_socket: "/tmp/atmux-atmux/epics/e-1/tmux-0/default",
    cage_alive: false,
    kanban: null,
    in_cockpit_registry: true,
    in_parent_kanban: null,
    branch_ahead_of_trunk: null,
    branch_merged_to_trunk: null,
    last_activity: null,
    ...overrides,
  };
}

function makeTeam(overrides: Partial<TopoTeam> = {}): TopoTeam {
  return {
    name: "atmux",
    kind: "parent",
    atmux_dir: "/srv/atmux/.atmux",
    worktree: "/srv/atmux",
    branch: "atmux-geoyws",
    cage_socket: "/tmp/atmux-atmux/sock",
    cage_alive: true,
    kanban: null,
    in_cockpit_registry: true,
    last_activity: null,
    epics: [],
    ...overrides,
  };
}

function makeManifest(overrides: Partial<TopoManifest> = {}): TopoManifest {
  return {
    schema_version: 1,
    generated_at: "2026-05-22T13:54:00.000Z",
    cockpit: {
      socket: "/tmp/.tmux-1000/atmux-cockpit",
      alive: true,
      registry_path: "/root/.atmux/cockpit.json",
      sessions_count: 1,
    },
    teams: [],
    orphans: [],
    summary: {
      teams_count: 0,
      epics_count: 0,
      cages_alive: 1,
      orphans_count: 0,
      elapsed_ms: 0,
    },
    ...overrides,
  };
}

function makeParent(overrides: Partial<ParentDiscovery> = {}): ParentDiscovery {
  return {
    name: "atmux",
    root: "/srv/atmux",
    soft_stopped: false,
    atmux_dir: "/srv/atmux/.atmux",
    worktree: "/srv/atmux",
    cage_socket: "/tmp/atmux-atmux/sock",
    cage_alive: true,
    branch: "atmux-geoyws",
    last_commit: null,
    kanban: null,
    worktrees_on_disk: [],
    branches: [],
    kanban_epic_rows: null,
    epics: [],
    ...overrides,
  };
}

function makeDiscovery(overrides: Partial<Discovery> = {}): Discovery {
  return {
    generated_at: new Date("2026-05-22T13:54:00.000Z"),
    elapsed_ms: 100,
    cockpit: {
      socket: "/tmp/.tmux-1000/atmux-cockpit",
      alive: true,
      registry_path: "/root/.atmux/cockpit.json",
      data: null,
    },
    parents: [],
    global: { sockets_alive: [], cron_marker_blocks: null },
    ...overrides,
  };
}

/** Build a seen-state where every candidate is pre-aged past its
 *  per-class grace — used in positive tests to skip the 30s/5min
 *  grace gating and exercise the emit path directly. */
function pastGraceSeenState(generatedAt: Date, keys: string[], ageMs = 60_000): SeenState {
  const seenIso = new Date(generatedAt.getTime() - ageMs).toISOString();
  const entries: Record<string, string> = {};
  for (const k of keys) entries[k] = seenIso;
  return { schema_version: 1, generated_at: seenIso, entries };
}

// ---------- emptySeenState ----------

describe("emptySeenState", () => {
  test("returns schema_version=1 + empty entries + given generated_at", () => {
    const d = new Date("2026-05-22T13:54:00.000Z");
    const s = emptySeenState(d);
    expect(s.schema_version).toBe(1);
    expect(s.entries).toEqual({});
    expect(s.generated_at).toBe(d.toISOString());
  });
});

// ---------- Grace + state-file semantics ----------

describe("grace + state-file semantics", () => {
  test("first observation never emits (30s grace not met)", () => {
    const generatedAt = new Date("2026-05-22T13:54:00.000Z");
    const discovery = makeDiscovery({
      generated_at: generatedAt,
      global: {
        sockets_alive: [
          { socket: "/tmp/atmux-orphan/sock", parent: "orphan", eid: null },
        ] satisfies TmuxSocketEntry[],
        cron_marker_blocks: null,
      },
    });
    const { orphans, updatedSeenState } = classifyOrphans(
      makeManifest(),
      discovery,
      emptySeenState(generatedAt),
    );
    expect(orphans).toEqual([]);
    expect(updatedSeenState.entries["cage-tmux-without-registry::orphan"]).toBe(
      generatedAt.toISOString(),
    );
  });

  test("second observation ≥30s later emits with stable first_seen", () => {
    const firstSeenAt = new Date("2026-05-22T13:54:00.000Z");
    const generatedAt = new Date("2026-05-22T13:54:31.000Z");
    const discovery = makeDiscovery({
      generated_at: generatedAt,
      global: {
        sockets_alive: [{ socket: "/tmp/atmux-orphan/sock", parent: "orphan", eid: null }],
        cron_marker_blocks: null,
      },
    });
    const seen: SeenState = {
      schema_version: 1,
      generated_at: firstSeenAt.toISOString(),
      entries: { "cage-tmux-without-registry::orphan": firstSeenAt.toISOString() },
    };
    const { orphans } = classifyOrphans(makeManifest(), discovery, seen);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.first_seen).toBe(firstSeenAt.toISOString());
  });

  test("class 6 needs 5min grace, not 30s", () => {
    const firstSeenAt = new Date("2026-05-22T13:50:00.000Z");
    // 31s later: past 30s, but not past 5min — should NOT emit.
    const at31s = new Date(firstSeenAt.getTime() + 31_000);
    const manifest = makeManifest({
      teams: [makeTeam({ epics: [makeEpic({ cage_alive: false })] })],
    });
    const seen: SeenState = {
      schema_version: 1,
      generated_at: firstSeenAt.toISOString(),
      entries: { "cockpit-registry-without-cage::e-1": firstSeenAt.toISOString() },
    };
    const at31sResult = classifyOrphans(manifest, makeDiscovery({ generated_at: at31s }), seen);
    expect(at31sResult.orphans).toEqual([]);
    // 5min + 1s later: emits.
    const at5min = new Date(firstSeenAt.getTime() + 5 * 60 * 1000 + 1000);
    const at5minResult = classifyOrphans(manifest, makeDiscovery({ generated_at: at5min }), seen);
    expect(at5minResult.orphans).toHaveLength(1);
    expect(at5minResult.orphans[0]?.class).toBe("cockpit-registry-without-cage");
  });
});

// ---------- TTL eviction ----------

describe("TTL eviction (7d window for non-candidate entries)", () => {
  test("stale non-candidate entry >7d old is dropped", () => {
    const generatedAt = new Date("2026-05-22T13:54:00.000Z");
    const longAgo = new Date(generatedAt.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const seen: SeenState = {
      schema_version: 1,
      generated_at: longAgo,
      entries: { "cron-block-without-worktree::atmux:team=gone": longAgo },
    };
    const { updatedSeenState } = classifyOrphans(
      makeManifest(),
      makeDiscovery({ generated_at: generatedAt }),
      seen,
    );
    expect(updatedSeenState.entries).toEqual({});
  });

  test("non-candidate entry <7d old is preserved", () => {
    const generatedAt = new Date("2026-05-22T13:54:00.000Z");
    const recent = new Date(generatedAt.getTime() - 60 * 1000).toISOString();
    const seen: SeenState = {
      schema_version: 1,
      generated_at: recent,
      entries: { "cron-block-without-worktree::atmux:team=gone": recent },
    };
    const { updatedSeenState } = classifyOrphans(
      makeManifest(),
      makeDiscovery({ generated_at: generatedAt }),
      seen,
    );
    expect(updatedSeenState.entries["cron-block-without-worktree::atmux:team=gone"]).toBe(recent);
  });

  test("candidate-set entry preserved regardless of age", () => {
    const generatedAt = new Date("2026-05-22T13:54:00.000Z");
    const ancient = new Date(generatedAt.getTime() - 100 * 24 * 60 * 60 * 1000).toISOString();
    const seen: SeenState = {
      schema_version: 1,
      generated_at: ancient,
      entries: { "cage-tmux-without-registry::orphan": ancient },
    };
    const discovery = makeDiscovery({
      generated_at: generatedAt,
      global: {
        sockets_alive: [{ socket: "/tmp/atmux-orphan/sock", parent: "orphan", eid: null }],
        cron_marker_blocks: null,
      },
    });
    const { updatedSeenState } = classifyOrphans(makeManifest(), discovery, seen);
    expect(updatedSeenState.entries["cage-tmux-without-registry::orphan"]).toBe(ancient);
  });
});

// ---------- Class 1: cage-tmux-without-registry ----------

describe("class 1: cage-tmux-without-registry", () => {
  test("pos: parent-cage alive, parent not in cockpit", () => {
    const generatedAt = new Date("2026-05-22T13:54:00.000Z");
    const discovery = makeDiscovery({
      generated_at: generatedAt,
      global: {
        sockets_alive: [{ socket: "/tmp/atmux-x/sock", parent: "x", eid: null }],
        cron_marker_blocks: null,
      },
    });
    const seen = pastGraceSeenState(generatedAt, ["cage-tmux-without-registry::x"]);
    const { orphans } = classifyOrphans(makeManifest(), discovery, seen);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.class).toBe("cage-tmux-without-registry");
    expect(orphans[0]?.ref).toBe("x");
    expect(orphans[0]?.reap_hint).toContain("kill-server");
  });

  test("pos: epic-cage alive, eid not in cockpit", () => {
    const generatedAt = new Date("2026-05-22T13:54:00.000Z");
    const discovery = makeDiscovery({
      generated_at: generatedAt,
      global: {
        sockets_alive: [
          {
            socket: "/tmp/atmux-atmux/epics/e-ghost/tmux-0/default",
            parent: "atmux",
            eid: "e-ghost",
          },
        ],
        cron_marker_blocks: null,
      },
    });
    const manifest = makeManifest({ teams: [makeTeam()] });
    const seen = pastGraceSeenState(generatedAt, ["cage-tmux-without-registry::e-ghost"]);
    const { orphans } = classifyOrphans(manifest, discovery, seen);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.ref).toBe("e-ghost");
    expect(orphans[0]?.reap_hint).toContain("kill-server");
  });

  test("neg: parent-cage alive, parent IS in cockpit", () => {
    const generatedAt = new Date("2026-05-22T13:54:00.000Z");
    const discovery = makeDiscovery({
      generated_at: generatedAt,
      global: {
        sockets_alive: [{ socket: "/tmp/atmux-atmux/sock", parent: "atmux", eid: null }],
        cron_marker_blocks: null,
      },
    });
    const manifest = makeManifest({ teams: [makeTeam()] });
    const { orphans } = classifyOrphans(manifest, discovery, emptySeenState(generatedAt));
    expect(orphans).toEqual([]);
  });

  test("neg: epic-cage alive, eid IS in cockpit", () => {
    const generatedAt = new Date("2026-05-22T13:54:00.000Z");
    const discovery = makeDiscovery({
      generated_at: generatedAt,
      global: {
        sockets_alive: [
          {
            socket: "/tmp/atmux-atmux/epics/e-1/tmux-0/default",
            parent: "atmux",
            eid: "e-1",
          },
        ],
        cron_marker_blocks: null,
      },
    });
    const manifest = makeManifest({ teams: [makeTeam({ epics: [makeEpic()] })] });
    const { orphans } = classifyOrphans(manifest, discovery, emptySeenState(generatedAt));
    expect(orphans).toEqual([]);
  });
});

// ---------- Class 2: cron-block-without-worktree ----------

describe("class 2: cron-block-without-worktree", () => {
  test("pos: block with atmux_dir_exists=false", () => {
    const generatedAt = new Date("2026-05-22T13:54:00.000Z");
    const blocks: CronMarkerBlock[] = [
      {
        ref: "atmux:team=e-gone",
        atmux_dir: "/srv/atmux-epics/e-gone/.atmux",
        atmux_dir_exists: false,
      },
    ];
    const discovery = makeDiscovery({
      generated_at: generatedAt,
      global: { sockets_alive: [], cron_marker_blocks: blocks },
    });
    const seen = pastGraceSeenState(generatedAt, [
      "cron-block-without-worktree::atmux:team=e-gone",
    ]);
    const { orphans } = classifyOrphans(makeManifest(), discovery, seen);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.class).toBe("cron-block-without-worktree");
    expect(orphans[0]?.atmux_dir).toBe("/srv/atmux-epics/e-gone/.atmux");
    expect(orphans[0]?.reap_hint).toContain("cron-reaper");
  });

  test("neg: block with atmux_dir_exists=true", () => {
    const generatedAt = new Date("2026-05-22T13:54:00.000Z");
    const blocks: CronMarkerBlock[] = [
      {
        ref: "atmux:team=atmux",
        atmux_dir: "/srv/atmux/.atmux",
        atmux_dir_exists: true,
      },
    ];
    const discovery = makeDiscovery({
      generated_at: generatedAt,
      global: { sockets_alive: [], cron_marker_blocks: blocks },
    });
    const { orphans } = classifyOrphans(makeManifest(), discovery, emptySeenState(generatedAt));
    expect(orphans).toEqual([]);
  });

  test("neg: cron_marker_blocks=null (§D5 row 4) yields no class-2 rows", () => {
    const generatedAt = new Date("2026-05-22T13:54:00.000Z");
    const discovery = makeDiscovery({
      generated_at: generatedAt,
      global: { sockets_alive: [], cron_marker_blocks: null },
    });
    const { orphans } = classifyOrphans(makeManifest(), discovery, emptySeenState(generatedAt));
    expect(orphans).toEqual([]);
  });
});

// ---------- Class 3: worktree-without-cage ----------

describe("class 3: worktree-without-cage", () => {
  test("pos: worktree on disk, no matching cockpit epic", () => {
    const generatedAt = new Date("2026-05-22T13:54:00.000Z");
    const wt: WorktreeOnDisk[] = [
      { path: "/srv/atmux-epics/e-zombie", parent: "atmux", eid: "e-zombie" },
    ];
    const discovery = makeDiscovery({
      generated_at: generatedAt,
      parents: [makeParent({ worktrees_on_disk: wt })],
    });
    const manifest = makeManifest({ teams: [makeTeam()] });
    const seen = pastGraceSeenState(generatedAt, ["worktree-without-cage::e-zombie"]);
    const { orphans } = classifyOrphans(manifest, discovery, seen);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.class).toBe("worktree-without-cage");
    expect(orphans[0]?.ref).toBe("e-zombie");
    expect(orphans[0]?.reap_hint).toContain("rm -rf");
  });

  test("neg: worktree on disk, cockpit epic alive", () => {
    const generatedAt = new Date("2026-05-22T13:54:00.000Z");
    const wt: WorktreeOnDisk[] = [{ path: "/srv/atmux-epics/e-1", parent: "atmux", eid: "e-1" }];
    const discovery = makeDiscovery({
      generated_at: generatedAt,
      parents: [makeParent({ worktrees_on_disk: wt })],
    });
    const manifest = makeManifest({
      teams: [makeTeam({ epics: [makeEpic({ cage_alive: true })] })],
    });
    const { orphans } = classifyOrphans(manifest, discovery, emptySeenState(generatedAt));
    expect(orphans).toEqual([]);
  });
});

// ---------- Class 4: branch-without-row ----------

describe("class 4: branch-without-row", () => {
  test("pos: branch present, no cockpit + no worktree + no kanban row", () => {
    const generatedAt = new Date("2026-05-22T13:54:00.000Z");
    const discovery = makeDiscovery({
      generated_at: generatedAt,
      parents: [
        makeParent({
          branches: [{ parent: "atmux", branch: "atmux-geoyws-epic-e-stale", eid: "e-stale" }],
          kanban_epic_rows: [],
        }),
      ],
    });
    const manifest = makeManifest({ teams: [makeTeam()] });
    const seen = pastGraceSeenState(generatedAt, ["branch-without-row::atmux-geoyws-epic-e-stale"]);
    const { orphans } = classifyOrphans(manifest, discovery, seen);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.class).toBe("branch-without-row");
    expect(orphans[0]?.ref).toBe("atmux-geoyws-epic-e-stale");
    expect(orphans[0]?.reap_hint).toContain("branch -D");
  });

  test("neg: branch present, eid in cockpit", () => {
    const generatedAt = new Date("2026-05-22T13:54:00.000Z");
    const discovery = makeDiscovery({
      generated_at: generatedAt,
      parents: [
        makeParent({
          branches: [{ parent: "atmux", branch: "atmux-geoyws-epic-e-1", eid: "e-1" }],
          kanban_epic_rows: [],
        }),
      ],
    });
    const manifest = makeManifest({ teams: [makeTeam({ epics: [makeEpic()] })] });
    const { orphans } = classifyOrphans(manifest, discovery, emptySeenState(generatedAt));
    expect(orphans).toEqual([]);
  });

  test("neg: kanban_epic_rows=null treated as kanban-present (conservative skip)", () => {
    const generatedAt = new Date("2026-05-22T13:54:00.000Z");
    const discovery = makeDiscovery({
      generated_at: generatedAt,
      parents: [
        makeParent({
          branches: [{ parent: "atmux", branch: "atmux-geoyws-epic-e-unknown", eid: "e-unknown" }],
          kanban_epic_rows: null,
        }),
      ],
    });
    const manifest = makeManifest({ teams: [makeTeam()] });
    const { orphans } = classifyOrphans(manifest, discovery, emptySeenState(generatedAt));
    expect(orphans).toEqual([]);
  });
});

// ---------- Class 5: kanban-epic-without-cage ----------

describe("class 5: kanban-epic-without-cage", () => {
  test("pos: in-progress + no cage + no worktree", () => {
    const generatedAt = new Date("2026-05-22T13:54:00.000Z");
    const discovery = makeDiscovery({
      generated_at: generatedAt,
      parents: [
        makeParent({
          kanban_epic_rows: [{ eid: "e-orphaned", status: "in-progress" }],
        }),
      ],
    });
    const manifest = makeManifest({ teams: [makeTeam()] });
    const seen = pastGraceSeenState(generatedAt, ["kanban-epic-without-cage::e-orphaned"]);
    const { orphans } = classifyOrphans(manifest, discovery, seen);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.class).toBe("kanban-epic-without-cage");
    expect(orphans[0]?.ref).toBe("e-orphaned");
  });

  test("neg: status=todo (not in-progress)", () => {
    const generatedAt = new Date("2026-05-22T13:54:00.000Z");
    const discovery = makeDiscovery({
      generated_at: generatedAt,
      parents: [makeParent({ kanban_epic_rows: [{ eid: "e-1", status: "todo" }] })],
    });
    const { orphans } = classifyOrphans(makeManifest(), discovery, emptySeenState(generatedAt));
    expect(orphans).toEqual([]);
  });

  test("neg: in-progress + worktree on disk", () => {
    const generatedAt = new Date("2026-05-22T13:54:00.000Z");
    const discovery = makeDiscovery({
      generated_at: generatedAt,
      parents: [
        makeParent({
          worktrees_on_disk: [{ path: "/srv/atmux-epics/e-1", parent: "atmux", eid: "e-1" }],
          kanban_epic_rows: [{ eid: "e-1", status: "in-progress" }],
        }),
      ],
    });
    const { orphans } = classifyOrphans(makeManifest(), discovery, emptySeenState(generatedAt));
    expect(orphans).toEqual([]);
  });

  test("neg: in-progress + cage alive", () => {
    const generatedAt = new Date("2026-05-22T13:54:00.000Z");
    const discovery = makeDiscovery({
      generated_at: generatedAt,
      parents: [makeParent({ kanban_epic_rows: [{ eid: "e-1", status: "in-progress" }] })],
    });
    const manifest = makeManifest({
      teams: [makeTeam({ epics: [makeEpic({ cage_alive: true })] })],
    });
    const { orphans } = classifyOrphans(manifest, discovery, emptySeenState(generatedAt));
    expect(orphans).toEqual([]);
  });

  test("neg: kanban_epic_rows=null yields no class-5 rows", () => {
    const generatedAt = new Date("2026-05-22T13:54:00.000Z");
    const discovery = makeDiscovery({
      generated_at: generatedAt,
      parents: [makeParent({ kanban_epic_rows: null })],
    });
    const { orphans } = classifyOrphans(makeManifest(), discovery, emptySeenState(generatedAt));
    expect(orphans).toEqual([]);
  });

  test("carve-out: in-progress + soft_stopped → no class-5 row", () => {
    const generatedAt = new Date("2026-05-22T13:54:00.000Z");
    const discovery = makeDiscovery({
      generated_at: generatedAt,
      parents: [makeParent({ kanban_epic_rows: [{ eid: "e-1", status: "in-progress" }] })],
    });
    const manifest = makeManifest({
      teams: [makeTeam({ epics: [makeEpic({ soft_stopped: true })] })],
    });
    const { orphans } = classifyOrphans(manifest, discovery, emptySeenState(generatedAt));
    expect(orphans).toEqual([]);
  });
});

// ---------- Class 6: cockpit-registry-without-cage ----------

describe("class 6: cockpit-registry-without-cage", () => {
  test("pos: cage_alive=false ≥5min triggers orphan", () => {
    const generatedAt = new Date("2026-05-22T13:54:00.000Z");
    const manifest = makeManifest({
      teams: [makeTeam({ epics: [makeEpic({ cage_alive: false })] })],
    });
    const seen = pastGraceSeenState(
      generatedAt,
      ["cockpit-registry-without-cage::e-1"],
      6 * 60 * 1000,
    );
    const { orphans } = classifyOrphans(
      manifest,
      makeDiscovery({ generated_at: generatedAt }),
      seen,
    );
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.class).toBe("cockpit-registry-without-cage");
    expect(orphans[0]?.ref).toBe("e-1");
  });

  test("neg: cage_alive=true → no orphan", () => {
    const generatedAt = new Date("2026-05-22T13:54:00.000Z");
    const manifest = makeManifest({
      teams: [makeTeam({ epics: [makeEpic({ cage_alive: true })] })],
    });
    const { orphans } = classifyOrphans(
      manifest,
      makeDiscovery({ generated_at: generatedAt }),
      emptySeenState(generatedAt),
    );
    expect(orphans).toEqual([]);
  });

  test("neg/carve-out: cage_alive=false + soft_stopped → no orphan", () => {
    const generatedAt = new Date("2026-05-22T13:54:00.000Z");
    const manifest = makeManifest({
      teams: [
        makeTeam({
          epics: [makeEpic({ cage_alive: false, soft_stopped: true })],
        }),
      ],
    });
    const seen = pastGraceSeenState(
      generatedAt,
      ["cockpit-registry-without-cage::e-1"],
      6 * 60 * 1000,
    );
    const { orphans } = classifyOrphans(
      manifest,
      makeDiscovery({ generated_at: generatedAt }),
      seen,
    );
    expect(orphans).toEqual([]);
  });
});

// ---------- Ordering ----------

describe("ordering", () => {
  test("orphans sorted by (class, ref) per DoD", () => {
    const generatedAt = new Date("2026-05-22T13:54:00.000Z");
    const blocks: CronMarkerBlock[] = [
      {
        ref: "atmux:team=z-gone",
        atmux_dir: "/srv/z",
        atmux_dir_exists: false,
      },
      {
        ref: "atmux:team=a-gone",
        atmux_dir: "/srv/a",
        atmux_dir_exists: false,
      },
    ];
    const discovery = makeDiscovery({
      generated_at: generatedAt,
      global: {
        sockets_alive: [{ socket: "/tmp/atmux-z/sock", parent: "z", eid: null }],
        cron_marker_blocks: blocks,
      },
    });
    const seen = pastGraceSeenState(generatedAt, [
      "cage-tmux-without-registry::z",
      "cron-block-without-worktree::atmux:team=a-gone",
      "cron-block-without-worktree::atmux:team=z-gone",
    ]);
    const { orphans } = classifyOrphans(makeManifest(), discovery, seen);
    expect(orphans.map((o) => `${o.class}::${o.ref}`)).toEqual([
      "cage-tmux-without-registry::z",
      "cron-block-without-worktree::atmux:team=a-gone",
      "cron-block-without-worktree::atmux:team=z-gone",
    ]);
  });
});

// ---------- Determinism ----------

describe("determinism", () => {
  test("same inputs → same outputs", () => {
    const generatedAt = new Date("2026-05-22T13:54:00.000Z");
    const discovery = makeDiscovery({
      generated_at: generatedAt,
      global: {
        sockets_alive: [{ socket: "/tmp/atmux-x/sock", parent: "x", eid: null }],
        cron_marker_blocks: null,
      },
    });
    const seen = pastGraceSeenState(generatedAt, ["cage-tmux-without-registry::x"]);
    const r1 = classifyOrphans(makeManifest(), discovery, seen);
    const r2 = classifyOrphans(makeManifest(), discovery, seen);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});
