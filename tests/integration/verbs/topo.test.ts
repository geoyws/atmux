// Integration tests for src/verbs/topo.ts (ADR-222 §D1 / t-cd382b92).
//
// Drives the verb's full orchestration (gatherDiscovery + aggregateTopo +
// classifyOrphans + render) against a stubbed DiscoveryIO so the
// behavior is exercised end-to-end without touching real tmux, sqlite,
// or git on the host. Production IO is exercised by the dogfood Tasks
// (t-beff7d62 / t-5fef18bb) — these tests own the verb-logic gates.
//
// Coverage matrix (per ADR-222 §D1 surface):
//   parseTopoArgs:
//     - default flags
//     - --tree / --orphans / --json individually + composed
//     - --team <name> + --since <iso> with values
//     - missing-value / non-iso surface UsageError
//   topo() orchestration:
//     - empty fleet → minimal manifest + non-orphan render
//     - populated fleet → flat + tree renders include teams + epics
//     - orphan injected via discovery (eg. zombie cage socket) →
//       classifier emits row + render lists it
//     - --json output is exactly the TopoManifest JSON (no Discovery
//       leak per lead 2026-05-22 constraint)
//     - --team filter narrows manifest.teams
//     - --since filter narrows by last_activity (team + epic)
//     - --orphans flag suppresses non-orphan rows in flat + tree
//   renderers:
//     - flat: header + per-team rows + orphan section
//     - tree: cockpit root + team children + epic leaves + orphan
//             section
//     - flat with --orphans-only + no orphans → "no orphans" line
//   seen-state lifecycle:
//     - first observation → no orphans emitted (30s grace not met),
//       seenState updated
//     - injected pre-aged seen-state → orphans emitted

import { describe, expect, test } from "bun:test";
import type { LoadedCockpit } from "../../../src/core/cockpit.ts";
import { emptySeenState, type SeenState } from "../../../src/core/orphan-detector.ts";
import type {
  CronMarkerBlock,
  DiscoveryIO,
  KanbanProbe,
  TmuxSocketEntry,
} from "../../../src/core/topo-aggregate.ts";
import { UsageError } from "../../../src/errors.ts";
import { parseCronMarkerBlocks } from "../../../src/verbs/topo-io.ts";
import {
  applyFilters,
  defaultSeenStatePath,
  loadSeenStateOrDefault,
  parseTopoArgs,
  type ReapPromptResponse,
  renderFlat,
  renderTree,
  saveSeenState,
  topo,
} from "../../../src/verbs/topo.ts";
import type { ReapDeps, ReapLogEntry } from "../../../src/core/reap.ts";

// ---------- Stub IO ----------

interface StubIOSpec {
  cockpit?: LoadedCockpit | null;
  cageAlive?: (socket: string) => boolean;
  kanban?: (atmuxDir: string, opts: { parent: boolean }) => KanbanProbe | null;
  branch?: (worktreePath: string) => string | null;
  lastCommit?: (worktreePath: string) => string | null;
  sockets?: TmuxSocketEntry[];
  cronBlocks?: CronMarkerBlock[] | null;
  worktreesByParent?: Record<string, Array<{ path: string; parent: string; eid: string }>>;
  branchesByParent?: Record<string, Array<{ parent: string; branch: string; eid: string }>>;
  kanbanEpicRowsByParent?: Record<string, Array<{ eid: string; status: string }> | null>;
  now?: Date;
}

function makeStubIO(spec: StubIOSpec = {}): DiscoveryIO {
  const now = spec.now ?? new Date("2026-05-22T13:54:00.000Z");
  return {
    async readCockpit() {
      return spec.cockpit ?? null;
    },
    cockpitRegistryPath() {
      return "/root/.atmux/cockpit.json";
    },
    cockpitSocketPath() {
      return "/tmp/.tmux-1000/atmux-cockpit";
    },
    async cageAlive(socket) {
      return spec.cageAlive ? spec.cageAlive(socket) : false;
    },
    async readKanban(atmuxDir, opts) {
      return spec.kanban ? spec.kanban(atmuxDir, opts) : null;
    },
    async gitCurrentBranch(worktreePath) {
      return spec.branch ? spec.branch(worktreePath) : null;
    },
    async gitLastCommitAt(worktreePath) {
      return spec.lastCommit ? spec.lastCommit(worktreePath) : null;
    },
    async gitAheadCount() {
      return null;
    },
    async gitMergedInto() {
      return null;
    },
    async listAliveCageSockets() {
      return spec.sockets ?? [];
    },
    async listCronMarkerBlocks() {
      return spec.cronBlocks === undefined ? null : spec.cronBlocks;
    },
    async listEpicWorktreeDirs(_root, parentName) {
      return spec.worktreesByParent?.[parentName] ?? [];
    },
    async listEpicBranches(_repo, _base, parentName) {
      return spec.branchesByParent?.[parentName] ?? [];
    },
    async listKanbanEpicRows(atmuxDir) {
      const parentName = atmuxDir.split("/").at(-2);
      if (parentName === undefined) return null;
      return spec.kanbanEpicRowsByParent?.[parentName] ?? null;
    },
    now() {
      return now;
    },
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

function team(name: string, root: string, sessions: unknown[] = []) {
  return { type: "team" as const, name, enabled: true, root, sessions };
}

function epicTeam(name: string, parent: string, epicId: string) {
  return { type: "epic-team" as const, name, enabled: true, parent, epicId, sessions: [] };
}

interface CapturedOutput {
  log: (m: string) => void;
  lines: string[];
}

function makeLogger(): CapturedOutput {
  const lines: string[] = [];
  return {
    log: (m: string) => lines.push(m),
    lines,
  };
}

const pastGraceSeen = (key: string): SeenState => ({
  schema_version: 1,
  generated_at: new Date("2026-05-22T13:00:00.000Z").toISOString(),
  entries: { [key]: new Date("2026-05-22T13:00:00.000Z").toISOString() },
});

// ---------- parseTopoArgs ----------

describe("parseTopoArgs", () => {
  test("default flags", () => {
    const p = parseTopoArgs([]);
    expect(p).toEqual({
      tree: false,
      orphansOnly: false,
      json: false,
      reap: false,
      apply: false,
      yes: false,
      skipChecks: false,
    });
  });

  test("--tree + --orphans + --json compose", () => {
    const p = parseTopoArgs(["--tree", "--orphans", "--json"]);
    expect(p.tree).toBe(true);
    expect(p.orphansOnly).toBe(true);
    expect(p.json).toBe(true);
  });

  test("--team <name>", () => {
    expect(parseTopoArgs(["--team", "atmux"]).team).toBe("atmux");
  });

  test("--since <iso> normalizes to UTC ISO", () => {
    const p = parseTopoArgs(["--since", "2026-05-22T13:00:00Z"]);
    expect(p.sinceIso).toBe("2026-05-22T13:00:00.000Z");
  });

  test("--team missing value → UsageError", () => {
    expect(() => parseTopoArgs(["--team"])).toThrow(UsageError);
  });

  test("--team empty value → UsageError", () => {
    expect(() => parseTopoArgs(["--team", ""])).toThrow(UsageError);
  });

  test("--since missing value → UsageError", () => {
    expect(() => parseTopoArgs(["--since"])).toThrow(UsageError);
  });

  test("--since non-iso → UsageError", () => {
    expect(() => parseTopoArgs(["--since", "not-a-date"])).toThrow(UsageError);
  });

  test("--since empty → UsageError", () => {
    expect(() => parseTopoArgs(["--since", ""])).toThrow(UsageError);
  });

  test("unknown arg → UsageError", () => {
    expect(() => parseTopoArgs(["--bogus"])).toThrow(UsageError);
  });
});

// ---------- topo() orchestration ----------

describe("topo() — empty fleet", () => {
  test("returns exit 0 + emits flat with no teams", async () => {
    const io = makeStubIO({ cockpit: null });
    const log = makeLogger();
    const rc = await topo([], {
      io,
      seenState: emptySeenState(new Date("2026-05-22T13:54:00.000Z")),
      saveSeenState: async () => {},
      logger: log,
    });
    expect(rc).toBe(0);
    expect(log.lines[0]).toContain("cockpit");
    expect(log.lines.find((l) => l.includes("TEAM"))).toBeUndefined();
  });
});

describe("topo() — populated fleet", () => {
  test("flat render lists teams + epics", async () => {
    const cockpit = cockpitWith([team("atmux", "/srv/atmux", [epicTeam("ep", "atmux", "e-1")])]);
    const io = makeStubIO({
      cockpit,
      cageAlive: () => true,
      branch: () => "atmux-geoyws",
      kanban: () => ({ tasks_open: 1, tasks_done: 5, last_activity: null, epics: 1, epic_ids: ["e-1"] }),
    });
    const log = makeLogger();
    const rc = await topo([], {
      io,
      seenState: emptySeenState(new Date("2026-05-22T13:54:00.000Z")),
      saveSeenState: async () => {},
      logger: log,
    });
    expect(rc).toBe(0);
    const out = log.lines.join("\n");
    expect(out).toContain("TEAM atmux");
    expect(out).toContain("EPIC e-1");
  });

  test("--tree render emits tree shape", async () => {
    const cockpit = cockpitWith([team("atmux", "/srv/atmux", [epicTeam("ep", "atmux", "e-1")])]);
    const io = makeStubIO({ cockpit, cageAlive: () => true });
    const log = makeLogger();
    await topo(["--tree"], {
      io,
      seenState: emptySeenState(new Date("2026-05-22T13:54:00.000Z")),
      saveSeenState: async () => {},
      logger: log,
    });
    const out = log.lines.join("\n");
    expect(out).toContain("cockpit");
    expect(out).toContain("├──");
    expect(out).toContain("atmux");
  });

  test("--json emits TopoManifest JSON (no Discovery leak)", async () => {
    const cockpit = cockpitWith([team("atmux", "/srv/atmux")]);
    const io = makeStubIO({ cockpit, cageAlive: () => true });
    const log = makeLogger();
    await topo(["--json"], {
      io,
      seenState: emptySeenState(new Date("2026-05-22T13:54:00.000Z")),
      saveSeenState: async () => {},
      logger: log,
    });
    const parsed = JSON.parse(log.lines[0] ?? "{}");
    expect(parsed.schema_version).toBe(1);
    expect(parsed.teams).toHaveLength(1);
    // No discovery internals should appear on the public manifest.
    expect(parsed.discovery).toBeUndefined();
    expect(parsed.parents).toBeUndefined();
    expect(parsed.global).toBeUndefined();
  });
});

describe("topo() — orphan injection", () => {
  test("zombie cage socket surfaces as orphan in flat render", async () => {
    const cockpit = cockpitWith([team("atmux", "/srv/atmux")]);
    const io = makeStubIO({
      cockpit,
      sockets: [{ socket: "/tmp/atmux-ghost/sock", parent: "ghost", eid: null }],
    });
    const log = makeLogger();
    await topo([], {
      io,
      seenState: pastGraceSeen("cage-tmux-without-registry::ghost"),
      saveSeenState: async () => {},
      logger: log,
    });
    const out = log.lines.join("\n");
    expect(out).toContain("ORPHANS");
    expect(out).toContain("ghost");
  });

  test("--orphans flag in flat render suppresses team rows + shows orphans only", async () => {
    const cockpit = cockpitWith([team("atmux", "/srv/atmux")]);
    const io = makeStubIO({
      cockpit,
      sockets: [{ socket: "/tmp/atmux-ghost/sock", parent: "ghost", eid: null }],
    });
    const log = makeLogger();
    await topo(["--orphans"], {
      io,
      seenState: pastGraceSeen("cage-tmux-without-registry::ghost"),
      saveSeenState: async () => {},
      logger: log,
    });
    const out = log.lines.join("\n");
    expect(out).toContain("ORPHANS");
    expect(out).not.toContain("TEAM atmux");
  });

  test("--orphans with no orphans → 'no orphans detected'", async () => {
    const cockpit = cockpitWith([team("atmux", "/srv/atmux")]);
    const io = makeStubIO({ cockpit, cageAlive: () => true });
    const log = makeLogger();
    await topo(["--orphans"], {
      io,
      seenState: emptySeenState(new Date("2026-05-22T13:54:00.000Z")),
      saveSeenState: async () => {},
      logger: log,
    });
    expect(log.lines.join("\n")).toContain("no orphans detected");
  });
});

describe("topo() — filters", () => {
  test("--team narrows to single team", async () => {
    const cockpit = cockpitWith([team("atmux", "/srv/atmux"), team("unum", "/srv/unum")]);
    const io = makeStubIO({ cockpit, cageAlive: () => true });
    const log = makeLogger();
    await topo(["--json", "--team", "atmux"], {
      io,
      seenState: emptySeenState(new Date("2026-05-22T13:54:00.000Z")),
      saveSeenState: async () => {},
      logger: log,
    });
    const m = JSON.parse(log.lines[0] ?? "{}");
    expect(m.teams).toHaveLength(1);
    expect(m.teams[0].name).toBe("atmux");
  });

  test("--since drops teams whose last_activity is before threshold", async () => {
    const cockpit = cockpitWith([team("atmux", "/srv/atmux"), team("stale", "/srv/stale")]);
    const io = makeStubIO({
      cockpit,
      cageAlive: () => true,
      lastCommit: (wt) =>
        wt === "/srv/atmux" ? "2026-05-22T13:50:00.000Z" : "2026-05-20T00:00:00.000Z",
    });
    const log = makeLogger();
    await topo(["--json", "--since", "2026-05-22T00:00:00.000Z"], {
      io,
      seenState: emptySeenState(new Date("2026-05-22T13:54:00.000Z")),
      saveSeenState: async () => {},
      logger: log,
    });
    const m = JSON.parse(log.lines[0] ?? "{}");
    expect(m.teams.map((t: { name: string }) => t.name)).toEqual(["atmux"]);
  });

  test("--since narrows epics within retained team to those past threshold", async () => {
    const cockpit = cockpitWith([
      team("atmux", "/srv/atmux", [epicTeam("ep-fresh", "atmux", "e-1"), epicTeam("ep-stale", "atmux", "e-2")]),
    ]);
    const io = makeStubIO({
      cockpit,
      cageAlive: () => true,
      lastCommit: () => "2026-05-22T13:50:00.000Z",
      kanban: (_dir, opts) =>
        opts.parent
          ? {
              tasks_open: 0,
              tasks_done: 0,
              last_activity: null,
              epics: 2,
              epic_ids: ["e-1", "e-2"],
            }
          : null,
      branch: () => "atmux-geoyws",
    });
    // Workaround: stub lastCommit per-worktree to force stale on e-2.
    const ioCustom: DiscoveryIO = {
      ...io,
      async gitLastCommitAt(wt) {
        if (wt.includes("e-2")) return "2026-05-19T00:00:00.000Z";
        return "2026-05-22T13:50:00.000Z";
      },
    };
    const log = makeLogger();
    await topo(["--json", "--since", "2026-05-22T00:00:00.000Z"], {
      io: ioCustom,
      seenState: emptySeenState(new Date("2026-05-22T13:54:00.000Z")),
      saveSeenState: async () => {},
      logger: log,
    });
    const m = JSON.parse(log.lines[0] ?? "{}");
    expect(m.teams).toHaveLength(1);
    expect(m.teams[0].epics.map((e: { eid: string }) => e.eid)).toEqual(["e-1"]);
  });
});

// ---------- Seen-state lifecycle ----------

describe("seen-state lifecycle", () => {
  test("first observation doesn't emit orphans (grace not met)", async () => {
    const cockpit = cockpitWith([team("atmux", "/srv/atmux")]);
    const io = makeStubIO({
      cockpit,
      sockets: [{ socket: "/tmp/atmux-ghost/sock", parent: "ghost", eid: null }],
    });
    const savedSink: SeenState[] = [];
    const log = makeLogger();
    await topo([], {
      io,
      seenState: emptySeenState(new Date("2026-05-22T13:54:00.000Z")),
      saveSeenState: async (s) => {
        savedSink.push(s);
      },
      logger: log,
    });
    expect(log.lines.join("\n")).not.toContain("ORPHANS");
    expect(savedSink).toHaveLength(1);
    expect(savedSink[0]?.entries["cage-tmux-without-registry::ghost"]).toBeDefined();
  });
});

// ---------- defaultSeenStatePath ----------

describe("defaultSeenStatePath", () => {
  test("ends with .atmux/state/topo-orphan-seen.json", () => {
    expect(defaultSeenStatePath()).toMatch(/\.atmux\/state\/topo-orphan-seen\.json$/);
  });
});

// ---------- Renderers (direct) ----------

describe("renderFlat", () => {
  test("emits header + team + orphans section", () => {
    const out = renderFlat(
      {
        schema_version: 1,
        generated_at: "2026-05-22T13:54:00.000Z",
        cockpit: {
          socket: "/tmp/.tmux-1000/atmux-cockpit",
          alive: true,
          registry_path: "/root/.atmux/cockpit.json",
          sessions_count: 1,
        },
        teams: [
          {
            name: "atmux",
            kind: "parent",
            atmux_dir: "/srv/atmux/.atmux",
            worktree: "/srv/atmux",
            branch: "atmux-geoyws",
            cage_socket: "/tmp/atmux-atmux/sock",
            cage_alive: true,
            kanban: { tasks_open: 1, tasks_done: 2, last_activity: null },
            in_cockpit_registry: true,
            last_activity: null,
            epics: [],
          },
        ],
        orphans: [
          {
            kind: "epic",
            class: "cage-tmux-without-registry",
            ref: "ghost",
            details: "test",
            first_seen: "2026-05-22T13:00:00.000Z",
            reap_hint: "tmux -S /tmp/atmux-ghost/sock kill-server",
          },
        ],
        summary: {
          teams_count: 1,
          epics_count: 0,
          cages_alive: 1,
          orphans_count: 1,
          elapsed_ms: 10,
        },
      },
      false,
    );
    expect(out).toContain("TEAM atmux");
    expect(out).toContain("ORPHANS (1)");
    expect(out).toContain("hint:");
  });
});

describe("renderTree", () => {
  test("emits cockpit root + nested team + epic leaves", () => {
    const out = renderTree(
      {
        schema_version: 1,
        generated_at: "2026-05-22T13:54:00.000Z",
        cockpit: {
          socket: "/tmp/.tmux-1000/atmux-cockpit",
          alive: true,
          registry_path: "/root/.atmux/cockpit.json",
          sessions_count: 1,
        },
        teams: [
          {
            name: "atmux",
            kind: "parent",
            atmux_dir: "/srv/atmux/.atmux",
            worktree: "/srv/atmux",
            branch: null,
            cage_socket: "/tmp/atmux-atmux/sock",
            cage_alive: true,
            kanban: null,
            in_cockpit_registry: true,
            last_activity: null,
            epics: [
              {
                eid: "e-1",
                kind: "epic",
                parent: "atmux",
                atmux_dir: "/srv/atmux-epics/e-1/.atmux",
                worktree: "/srv/atmux-epics/e-1",
                branch: null,
                cage_socket: "/tmp/atmux-atmux/epics/e-1/tmux-0/default",
                cage_alive: true,
                kanban: null,
                in_cockpit_registry: true,
                in_parent_kanban: null,
                branch_ahead_of_trunk: null,
                branch_merged_to_trunk: null,
                last_activity: null,
              },
            ],
          },
        ],
        orphans: [],
        summary: {
          teams_count: 1,
          epics_count: 1,
          cages_alive: 2,
          orphans_count: 0,
          elapsed_ms: 0,
        },
      },
      false,
    );
    expect(out).toContain("cockpit");
    expect(out).toContain("├── atmux");
    expect(out).toContain("└── e-1");
  });
});

// ---------- loadSeenStateOrDefault / saveSeenState (round-trip) ----------

describe("seen-state file round-trip", () => {
  test("missing file → empty default", async () => {
    const orig = process.env.HOME;
    const tmp = await Bun.file("/tmp/atmux-test-home-1").exists();
    void tmp;
    process.env.HOME = "/tmp/atmux-test-no-such-dir-12345";
    try {
      const s = await loadSeenStateOrDefault(new Date("2026-05-22T13:54:00.000Z"));
      expect(s.entries).toEqual({});
      expect(s.schema_version).toBe(1);
    } finally {
      process.env.HOME = orig;
    }
  });

  test("save + reload round-trips", async () => {
    const orig = process.env.HOME;
    const tmpHome = "/tmp/atmux-test-home-roundtrip";
    process.env.HOME = tmpHome;
    try {
      const state = {
        schema_version: 1 as const,
        generated_at: "2026-05-22T13:54:00.000Z",
        entries: { "k::v": "2026-05-22T13:00:00.000Z" },
      };
      await saveSeenState(state);
      const reloaded = await loadSeenStateOrDefault(new Date("2026-05-22T13:54:00.000Z"));
      expect(reloaded.entries["k::v"]).toBe("2026-05-22T13:00:00.000Z");
    } finally {
      process.env.HOME = orig;
      // cleanup
      try {
        await Bun.file(`${tmpHome}/.atmux/state/topo-orphan-seen.json`).text();
        await import("node:fs/promises").then((fs) =>
          fs.rm(tmpHome, { recursive: true, force: true }),
        );
      } catch {
        // ignore
      }
    }
  });

  test("garbled file → empty default (defensive)", async () => {
    const orig = process.env.HOME;
    const tmpHome = "/tmp/atmux-test-home-garbled";
    process.env.HOME = tmpHome;
    try {
      const fs = await import("node:fs/promises");
      await fs.mkdir(`${tmpHome}/.atmux/state`, { recursive: true });
      await fs.writeFile(`${tmpHome}/.atmux/state/topo-orphan-seen.json`, "not json {{", "utf8");
      const s = await loadSeenStateOrDefault(new Date("2026-05-22T13:54:00.000Z"));
      expect(s.entries).toEqual({});
    } finally {
      process.env.HOME = orig;
      try {
        const fs = await import("node:fs/promises");
        await fs.rm(tmpHome, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  test("file with wrong shape → empty default", async () => {
    const orig = process.env.HOME;
    const tmpHome = "/tmp/atmux-test-home-wrong-shape";
    process.env.HOME = tmpHome;
    try {
      const fs = await import("node:fs/promises");
      await fs.mkdir(`${tmpHome}/.atmux/state`, { recursive: true });
      await fs.writeFile(
        `${tmpHome}/.atmux/state/topo-orphan-seen.json`,
        JSON.stringify({ schema_version: 999 }),
        "utf8",
      );
      const s = await loadSeenStateOrDefault(new Date("2026-05-22T13:54:00.000Z"));
      expect(s.entries).toEqual({});
    } finally {
      process.env.HOME = orig;
      try {
        const fs = await import("node:fs/promises");
        await fs.rm(tmpHome, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  test("loaded file missing generated_at → falls back to provided date", async () => {
    const orig = process.env.HOME;
    const tmpHome = "/tmp/atmux-test-home-no-genat";
    process.env.HOME = tmpHome;
    try {
      const fs = await import("node:fs/promises");
      await fs.mkdir(`${tmpHome}/.atmux/state`, { recursive: true });
      await fs.writeFile(
        `${tmpHome}/.atmux/state/topo-orphan-seen.json`,
        JSON.stringify({ schema_version: 1, entries: {} }),
        "utf8",
      );
      const d = new Date("2026-05-22T13:54:00.000Z");
      const s = await loadSeenStateOrDefault(d);
      expect(s.generated_at).toBe(d.toISOString());
    } finally {
      process.env.HOME = orig;
      try {
        const fs = await import("node:fs/promises");
        await fs.rm(tmpHome, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});

// ---------- applyFilters (direct) ----------

describe("applyFilters", () => {
  test("no filters passes manifest through", () => {
    const m = {
      schema_version: 1 as const,
      generated_at: "2026-05-22T13:54:00.000Z",
      cockpit: { socket: "/x", alive: true, registry_path: "/r", sessions_count: 0 },
      teams: [],
      orphans: [],
      summary: { teams_count: 0, epics_count: 0, cages_alive: 0, orphans_count: 0, elapsed_ms: 0 },
    };
    const r = applyFilters(m, {
      tree: false,
      orphansOnly: false,
      json: false,
      reap: false,
      apply: false,
      yes: false,
      skipChecks: false,
    });
    expect(r.teams).toEqual([]);
  });
});

// ---------- topo() default-IO fallback (smoke) ----------

describe("topo() default-IO fallback", () => {
  test("omitting opts.io falls through to defaultDiscoveryIO without throwing", async () => {
    const orig = process.env.HOME;
    process.env.HOME = "/tmp/atmux-test-default-io";
    const log = makeLogger();
    try {
      const rc = await topo(["--json"], {
        seenState: emptySeenState(new Date("2026-05-22T13:54:00.000Z")),
        saveSeenState: async () => {},
        logger: log,
      });
      expect(rc).toBe(0);
      expect(() => JSON.parse(log.lines[0] ?? "{}")).not.toThrow();
    } finally {
      process.env.HOME = orig;
    }
  });

  test("omitting opts.logger writes to stdout (smoke)", async () => {
    const orig = process.env.HOME;
    process.env.HOME = "/tmp/atmux-test-default-logger";
    const io = makeStubIO({ cockpit: null });
    // Capture stdout via temporary monkey-patch.
    const origWrite = process.stdout.write.bind(process.stdout);
    const captured: string[] = [];
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;
    try {
      const rc = await topo(["--json"], {
        io,
        seenState: emptySeenState(new Date("2026-05-22T13:54:00.000Z")),
        saveSeenState: async () => {},
        // logger intentionally omitted
      });
      expect(rc).toBe(0);
      expect(captured.join("")).toContain("schema_version");
    } finally {
      process.stdout.write = origWrite;
      process.env.HOME = orig;
    }
  });

  test("omitting opts.saveSeenState exercises default on-disk save", async () => {
    const orig = process.env.HOME;
    const tmpHome = "/tmp/atmux-test-default-save";
    process.env.HOME = tmpHome;
    const io = makeStubIO({ cockpit: null });
    const log = makeLogger();
    try {
      const rc = await topo(["--json"], {
        io,
        seenState: emptySeenState(new Date("2026-05-22T13:54:00.000Z")),
        logger: log,
      });
      expect(rc).toBe(0);
      // Verify the seen-state file was written.
      const fs = await import("node:fs/promises");
      const body = await fs.readFile(
        `${tmpHome}/.atmux/state/topo-orphan-seen.json`,
        "utf8",
      );
      expect(JSON.parse(body).schema_version).toBe(1);
    } finally {
      process.env.HOME = orig;
      try {
        const fs = await import("node:fs/promises");
        await fs.rm(tmpHome, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});

describe("renderTree orphan section", () => {
  test("emits orphans block when present", () => {
    const out = renderTree(
      {
        schema_version: 1,
        generated_at: "2026-05-22T13:54:00.000Z",
        cockpit: {
          socket: "/x",
          alive: true,
          registry_path: "/r",
          sessions_count: 0,
        },
        teams: [],
        orphans: [
          {
            kind: "epic",
            class: "cage-tmux-without-registry",
            ref: "ghost",
            details: "test",
            first_seen: "2026-05-22T13:00:00.000Z",
          },
        ],
        summary: {
          teams_count: 0,
          epics_count: 0,
          cages_alive: 1,
          orphans_count: 1,
          elapsed_ms: 0,
        },
      },
      false,
    );
    expect(out).toContain("orphans (1)");
    expect(out).toContain("[cage-tmux-without-registry] ghost");
  });
});

// ---------- parseCronMarkerBlocks ----------

describe("parseCronMarkerBlocks", () => {
  test("parses single block with ATMUX_DIR + stats existence", async () => {
    // Use a path that definitely doesn't exist so existence is false.
    const body = `
# >>> atmux:team=gone-team — managed by atmux start; do not edit by hand
ATMUX_DIR=/nonexistent/path/to/.atmux
*/5 * * * * something
# <<< atmux:team=gone-team
`;
    const blocks = await parseCronMarkerBlocks(body);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.ref).toBe("atmux:team=gone-team");
    expect(blocks[0]?.atmux_dir).toBe("/nonexistent/path/to/.atmux");
    expect(blocks[0]?.atmux_dir_exists).toBe(false);
  });

  test("parses block whose ATMUX_DIR exists (uses /tmp which always exists)", async () => {
    const body = `
# >>> atmux:team=test-team — managed by atmux start; do not edit by hand
ATMUX_DIR=/tmp
*/5 * * * * something
# <<< atmux:team=test-team
`;
    const blocks = await parseCronMarkerBlocks(body);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.atmux_dir_exists).toBe(true);
  });

  test("returns empty when no marker blocks present", async () => {
    const blocks = await parseCronMarkerBlocks("# unrelated cron\n0 0 * * * foo\n");
    expect(blocks).toEqual([]);
  });

  test("skips a block missing ATMUX_DIR (no atmux_dir to surface)", async () => {
    const body = `
# >>> atmux:team=noenv — managed by atmux start
*/5 * * * * echo hi
# <<< atmux:team=noenv
`;
    const blocks = await parseCronMarkerBlocks(body);
    expect(blocks).toEqual([]);
  });
});

// ---------- --reap flag-chain (ADR-223 §D1) ----------

// Stub ReapDeps for verb-level integration testing.
interface StubReapDepsRecord {
  deps: ReapDeps;
  killCageServerCalls: string[];
  cronReaperReapCalls: string[];
  rmZombieWorktreeCalls: string[];
  deleteBranchCalls: Array<{ repo: string; branch: string }>;
  removeRegistryEntryCalls: string[];
  reapLog: ReapLogEntry[];
}

function makeStubReapDeps(): StubReapDepsRecord {
  const r: StubReapDepsRecord = {
    deps: {} as ReapDeps,
    killCageServerCalls: [],
    cronReaperReapCalls: [],
    rmZombieWorktreeCalls: [],
    deleteBranchCalls: [],
    removeRegistryEntryCalls: [],
    reapLog: [],
  };
  r.deps = {
    async killCageServer(s) {
      r.killCageServerCalls.push(s);
    },
    async cronReaperReap(s) {
      r.cronReaperReapCalls.push(s);
    },
    async rmZombieWorktree(p) {
      r.rmZombieWorktreeCalls.push(p);
    },
    async deleteBranch(repo, branch) {
      r.deleteBranchCalls.push({ repo, branch });
    },
    async removeRegistryEntry(eid) {
      r.removeRegistryEntryCalls.push(eid);
    },
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

// Helper: stub IO that emits exactly the orphans we want.
function makeIOWithOrphans(orphans: Array<{ class: string; ref: string }>): DiscoveryIO {
  // Build a cockpit so manifest has a parent team for branch+socket resolvers.
  const cockpit = cockpitWith([team("atmux", "/srv/atmux")]);
  // Wrap discovery to feed orphans via sockets/cronBlocks fixtures that
  // pre-grace would otherwise hit 30s gate. Use a pre-aged seen-state
  // when calling topo() to bypass.
  const sockets = orphans
    .filter((o) => o.class === "cage-tmux-without-registry")
    .map((o) => ({ socket: `/tmp/atmux-x/epics/${o.ref}/tmux-0/default`, parent: "x", eid: o.ref }));
  const cronBlocks = orphans
    .filter((o) => o.class === "cron-block-without-worktree")
    .map((o) => ({ ref: o.ref, atmux_dir: "/gone", atmux_dir_exists: false }));
  return makeStubIO({ cockpit, sockets, cronBlocks });
}

function pastGraceForKeys(keys: string[]): SeenState {
  const old = new Date("2026-05-22T12:00:00.000Z").toISOString();
  const entries: Record<string, string> = {};
  for (const k of keys) entries[k] = old;
  return { schema_version: 1, generated_at: old, entries };
}

describe("parseTopoArgs — reap flag-chain", () => {
  test("--reap alone is dry-run; sets reap:true apply:false", () => {
    const p = parseTopoArgs(["--reap"]);
    expect(p.reap).toBe(true);
    expect(p.apply).toBe(false);
    expect(p.yes).toBe(false);
  });

  test("--reap --apply sets apply:true", () => {
    const p = parseTopoArgs(["--reap", "--apply"]);
    expect(p.apply).toBe(true);
  });

  test("--reap --apply --yes sets yes:true", () => {
    const p = parseTopoArgs(["--reap", "--apply", "--yes"]);
    expect(p.yes).toBe(true);
  });

  test("--reap --class cron-block-without-worktree sets classFilter", () => {
    const p = parseTopoArgs(["--reap", "--class", "cron-block-without-worktree"]);
    expect(p.classFilter).toBe("cron-block-without-worktree");
  });

  test("--apply without --reap refuses", () => {
    expect(() => parseTopoArgs(["--apply"])).toThrow(UsageError);
  });

  test("--yes without --apply refuses", () => {
    expect(() => parseTopoArgs(["--reap", "--yes"])).toThrow(UsageError);
  });

  test("--class without --reap refuses", () => {
    expect(() => parseTopoArgs(["--class", "cron-block-without-worktree"])).toThrow(UsageError);
  });

  test("--class with unknown class refuses", () => {
    expect(() => parseTopoArgs(["--reap", "--class", "bogus"])).toThrow(UsageError);
  });

  test("--class missing value refuses", () => {
    expect(() => parseTopoArgs(["--reap", "--class"])).toThrow(UsageError);
  });

  test("--class empty value refuses", () => {
    expect(() => parseTopoArgs(["--reap", "--class", ""])).toThrow(UsageError);
  });

  test("--apply --json without --yes refuses (interactive+JSON conflict)", () => {
    expect(() => parseTopoArgs(["--reap", "--apply", "--json"])).toThrow(UsageError);
  });

  test("--apply --json --yes accepted", () => {
    const p = parseTopoArgs(["--reap", "--apply", "--json", "--yes"]);
    expect(p.json).toBe(true);
    expect(p.yes).toBe(true);
  });
});

describe("topo --reap — dry-run", () => {
  test("--reap alone lists what would be reaped via skipped[]", async () => {
    const io = makeIOWithOrphans([{ class: "cron-block-without-worktree", ref: "atmux:team=x" }]);
    const reap = makeStubReapDeps();
    const log = makeLogger();
    const rc = await topo(["--reap"], {
      io,
      seenState: pastGraceForKeys(["cron-block-without-worktree::atmux:team=x"]),
      saveSeenState: async () => {},
      reapDeps: reap.deps,
      logger: log,
    });
    expect(rc).toBe(0);
    expect(reap.cronReaperReapCalls).toEqual([]); // dry-run: no real call
    const out = log.lines.join("\n");
    expect(out).toContain("reap (dry-run)");
    expect(out).toContain("SKIPPED");
  });
});

describe("topo --reap --apply --yes — non-interactive batch", () => {
  test("invokes the primitive for each reapable orphan + writes reap-log", async () => {
    const io = makeIOWithOrphans([
      { class: "cron-block-without-worktree", ref: "atmux:team=a" },
      { class: "cage-tmux-without-registry", ref: "e-x" },
    ]);
    const reap = makeStubReapDeps();
    const log = makeLogger();
    await topo(["--reap", "--apply", "--yes"], {
      callerScope: () => "driver",
      io,
      seenState: pastGraceForKeys([
        "cron-block-without-worktree::atmux:team=a",
        "cage-tmux-without-registry::e-x",
      ]),
      saveSeenState: async () => {},
      reapDeps: reap.deps,
      logger: log,
    });
    expect(reap.cronReaperReapCalls).toEqual(["atmux:team=a"]);
    expect(reap.killCageServerCalls).toContain("/tmp/atmux-atmux/epics/e-x/tmux-0/default");
    expect(reap.reapLog).toHaveLength(2);
    expect(reap.reapLog.every((e) => e.result === "ok")).toBe(true);
  });

  test("--apply --yes --json emits {reaped, skipped, refused, failed, bypassed, summary}", async () => {
    const io = makeIOWithOrphans([{ class: "cron-block-without-worktree", ref: "atmux:team=a" }]);
    const reap = makeStubReapDeps();
    const log = makeLogger();
    await topo(["--reap", "--apply", "--yes", "--json"], {
      callerScope: () => "driver",
      io,
      seenState: pastGraceForKeys(["cron-block-without-worktree::atmux:team=a"]),
      saveSeenState: async () => {},
      reapDeps: reap.deps,
      logger: log,
    });
    const parsed = JSON.parse(log.lines[0] ?? "{}");
    expect(parsed.summary.reaped_count).toBe(1);
    expect(parsed.reaped).toHaveLength(1);
    expect(parsed.reaped[0].primitive).toBe("cronReaperReap");
  });
});

describe("topo --reap --apply — interactive prompt", () => {
  test("[y] confirms, primitive runs", async () => {
    const io = makeIOWithOrphans([{ class: "cron-block-without-worktree", ref: "atmux:team=a" }]);
    const reap = makeStubReapDeps();
    const responses: ReapPromptResponse[] = ["y"];
    let pIdx = 0;
    const prompt = async (): Promise<ReapPromptResponse> =>
      responses[pIdx++] ?? "N";
    const log = makeLogger();
    await topo(["--reap", "--apply"], {
      callerScope: () => "driver",
      io,
      seenState: pastGraceForKeys(["cron-block-without-worktree::atmux:team=a"]),
      saveSeenState: async () => {},
      reapDeps: reap.deps,
      prompt,
      logger: log,
    });
    expect(reap.cronReaperReapCalls).toEqual(["atmux:team=a"]);
  });

  test("[N] declines, primitive does not run", async () => {
    const io = makeIOWithOrphans([{ class: "cron-block-without-worktree", ref: "atmux:team=a" }]);
    const reap = makeStubReapDeps();
    const prompt = async (): Promise<ReapPromptResponse> => "N";
    const log = makeLogger();
    await topo(["--reap", "--apply"], {
      callerScope: () => "driver",
      io,
      seenState: pastGraceForKeys(["cron-block-without-worktree::atmux:team=a"]),
      saveSeenState: async () => {},
      reapDeps: reap.deps,
      prompt,
      logger: log,
    });
    expect(reap.cronReaperReapCalls).toEqual([]);
  });

  test("[a] collapses confirmation for same-class siblings", async () => {
    const io = makeIOWithOrphans([
      { class: "cron-block-without-worktree", ref: "atmux:team=a" },
      { class: "cron-block-without-worktree", ref: "atmux:team=b" },
    ]);
    const reap = makeStubReapDeps();
    const responses: ReapPromptResponse[] = ["a"]; // single prompt
    let pIdx = 0;
    const promptCallCount = { n: 0 };
    const prompt = async (): Promise<ReapPromptResponse> => {
      promptCallCount.n += 1;
      return responses[pIdx++] ?? "N";
    };
    const log = makeLogger();
    await topo(["--reap", "--apply"], {
      callerScope: () => "driver",
      io,
      seenState: pastGraceForKeys([
        "cron-block-without-worktree::atmux:team=a",
        "cron-block-without-worktree::atmux:team=b",
      ]),
      saveSeenState: async () => {},
      reapDeps: reap.deps,
      prompt,
      logger: log,
    });
    expect(reap.cronReaperReapCalls.length).toBe(2);
    expect(promptCallCount.n).toBe(1); // [a] short-circuits 2nd prompt
  });

  test("[q] aborts cascade — no further primitives run", async () => {
    const io = makeIOWithOrphans([
      { class: "cron-block-without-worktree", ref: "atmux:team=a" },
      { class: "cron-block-without-worktree", ref: "atmux:team=b" },
    ]);
    const reap = makeStubReapDeps();
    const prompt = async (): Promise<ReapPromptResponse> => "q";
    const log = makeLogger();
    await topo(["--reap", "--apply"], {
      callerScope: () => "driver",
      io,
      seenState: pastGraceForKeys([
        "cron-block-without-worktree::atmux:team=a",
        "cron-block-without-worktree::atmux:team=b",
      ]),
      saveSeenState: async () => {},
      reapDeps: reap.deps,
      prompt,
      logger: log,
    });
    expect(reap.cronReaperReapCalls).toEqual([]);
  });

  test("[d] details re-prompts; then [y] confirms", async () => {
    const io = makeIOWithOrphans([{ class: "cron-block-without-worktree", ref: "atmux:team=a" }]);
    const reap = makeStubReapDeps();
    const responses: ReapPromptResponse[] = ["d", "y"];
    let pIdx = 0;
    const prompt = async (): Promise<ReapPromptResponse> =>
      responses[pIdx++] ?? "N";
    const log = makeLogger();
    await topo(["--reap", "--apply"], {
      callerScope: () => "driver",
      io,
      seenState: pastGraceForKeys(["cron-block-without-worktree::atmux:team=a"]),
      saveSeenState: async () => {},
      reapDeps: reap.deps,
      prompt,
      logger: log,
    });
    expect(reap.cronReaperReapCalls).toEqual(["atmux:team=a"]);
    // Details line should appear in logger output (class: + ref: rows).
    expect(log.lines.join("\n")).toContain("class:");
  });
});

describe("topo --reap --class — filter", () => {
  test("scopes cascade to one class", async () => {
    const io = makeIOWithOrphans([
      { class: "cron-block-without-worktree", ref: "atmux:team=a" },
      { class: "cage-tmux-without-registry", ref: "e-x" },
    ]);
    const reap = makeStubReapDeps();
    const log = makeLogger();
    await topo(["--reap", "--apply", "--yes", "--class", "cron-block-without-worktree"], {
      callerScope: () => "driver",
      io,
      seenState: pastGraceForKeys([
        "cron-block-without-worktree::atmux:team=a",
        "cage-tmux-without-registry::e-x",
      ]),
      saveSeenState: async () => {},
      reapDeps: reap.deps,
      logger: log,
    });
    expect(reap.cronReaperReapCalls).toEqual(["atmux:team=a"]);
    expect(reap.killCageServerCalls).toEqual([]);
  });
});

describe("topo --reap --apply — Gate failures route to refused[]", () => {
  test("Gate 3 (unmerged branch) refuses + reap-log not appended", async () => {
    const io = makeIOWithOrphans([]);
    // Inject a branch-without-row manifest directly via overriding the
    // `--orphans`-only narrative isn't possible — instead, simulate
    // gate-3 via the unmerged response on isBranchMerged.
    const reap = makeStubReapDeps();
    reap.deps.isBranchMerged = async () => false;
    // Synthesize a branch-without-row orphan via a custom IO with no
    // sockets but a branch enum from the stub IO's `branchesByParent`.
    const cockpit = cockpitWith([team("atmux", "/srv/atmux")]);
    const stubIO = makeStubIO({
      cockpit,
      branch: () => "atmux-geoyws", // non-null so listEpicBranches fires
      branchesByParent: {
        atmux: [{ parent: "atmux", branch: "atmux-geoyws-epic-e-stale", eid: "e-stale" }],
      },
      kanbanEpicRowsByParent: { atmux: [] },
    });
    const log = makeLogger();
    await topo(["--reap", "--apply", "--yes", "--json"], {
      callerScope: () => "driver",
      io: stubIO,
      seenState: pastGraceForKeys(["branch-without-row::atmux-geoyws-epic-e-stale"]),
      saveSeenState: async () => {},
      reapDeps: reap.deps,
      logger: log,
    });
    const parsed = JSON.parse(log.lines[0] ?? "{}");
    expect(parsed.summary.refused_count).toBe(1);
    expect(parsed.refused[0].reason).toContain("gate-3-merge-base");
    expect(reap.reapLog).toHaveLength(0);
  });

  test("Gate 1 (active cage) refuses without --skip-checks (via stub isCageActive)", async () => {
    const io = makeIOWithOrphans([{ class: "cage-tmux-without-registry", ref: "e-x" }]);
    const reap = makeStubReapDeps();
    reap.deps.isCageActive = async () => true;
    const log = makeLogger();
    await topo(["--reap", "--apply", "--yes", "--json"], {
      callerScope: () => "driver",
      io,
      seenState: pastGraceForKeys(["cage-tmux-without-registry::e-x"]),
      saveSeenState: async () => {},
      reapDeps: reap.deps,
      logger: log,
    });
    const parsed = JSON.parse(log.lines[0] ?? "{}");
    expect(parsed.summary.refused_count).toBe(1);
    expect(parsed.refused[0].reason).toContain("gate-1-active-check");
    expect(reap.killCageServerCalls).toEqual([]);
  });
});

describe("topo --reap human render — coverage of refused/failed/bypassed branches", () => {
  test("human render with failed primitive (cron throws)", async () => {
    const io = makeIOWithOrphans([{ class: "cron-block-without-worktree", ref: "atmux:team=a" }]);
    const reap = makeStubReapDeps();
    reap.deps.cronReaperReap = async () => {
      throw new Error("simulated cron failure");
    };
    const log = makeLogger();
    await topo(["--reap", "--apply", "--yes"], {
      callerScope: () => "driver",
      io,
      seenState: pastGraceForKeys(["cron-block-without-worktree::atmux:team=a"]),
      saveSeenState: async () => {},
      reapDeps: reap.deps,
      logger: log,
    });
    const out = log.lines.join("\n");
    expect(out).toContain("FAILED");
    expect(out).toContain("simulated cron failure");
  });

  test("human render with refused (Gate 1 active cage, no --skip-checks)", async () => {
    const io = makeIOWithOrphans([{ class: "cage-tmux-without-registry", ref: "e-x" }]);
    const reap = makeStubReapDeps();
    reap.deps.isCageActive = async () => true;
    const log = makeLogger();
    await topo(["--reap", "--apply", "--yes"], {
      callerScope: () => "driver",
      io,
      seenState: pastGraceForKeys(["cage-tmux-without-registry::e-x"]),
      saveSeenState: async () => {},
      reapDeps: reap.deps,
      logger: log,
    });
    const out = log.lines.join("\n");
    expect(out).toContain("REFUSED");
    expect(out).toContain("gate-1-active-check");
  });

  test("human render with bypassed (--skip-checks bypasses active Gate 1)", async () => {
    const io = makeIOWithOrphans([{ class: "cage-tmux-without-registry", ref: "e-x" }]);
    const reap = makeStubReapDeps();
    reap.deps.isCageActive = async () => true;
    const log = makeLogger();
    await topo(["--reap", "--apply", "--yes", "--skip-checks"], {
      callerScope: () => "driver",
      io,
      seenState: pastGraceForKeys(["cage-tmux-without-registry::e-x"]),
      saveSeenState: async () => {},
      reapDeps: reap.deps,
      logger: log,
    });
    const out = log.lines.join("\n");
    expect(out).toContain("BYPASSED");
    expect(out).toContain("gate-1-active-check");
    expect(reap.killCageServerCalls).toContain("/tmp/atmux-atmux/epics/e-x/tmux-0/default");
  });
});

describe("topo --reap --json — coverage of skipped/failed JSON branches", () => {
  test("--reap (dry-run) --json emits skipped[] with primitive labels", async () => {
    const io = makeIOWithOrphans([{ class: "cron-block-without-worktree", ref: "atmux:team=a" }]);
    const reap = makeStubReapDeps();
    const log = makeLogger();
    await topo(["--reap", "--json"], {
      io,
      seenState: pastGraceForKeys(["cron-block-without-worktree::atmux:team=a"]),
      saveSeenState: async () => {},
      reapDeps: reap.deps,
      logger: log,
    });
    const parsed = JSON.parse(log.lines[0] ?? "{}");
    expect(parsed.skipped).toHaveLength(1);
    expect(parsed.skipped[0].primitive).toBe("cronReaperReap");
    expect(parsed.skipped[0].reason).toBe("dry-run");
  });

  test("--apply --yes --json emits failed[] with error message", async () => {
    const io = makeIOWithOrphans([{ class: "cron-block-without-worktree", ref: "atmux:team=a" }]);
    const reap = makeStubReapDeps();
    reap.deps.cronReaperReap = async () => {
      throw new Error("simulated cron failure");
    };
    const log = makeLogger();
    await topo(["--reap", "--apply", "--yes", "--json"], {
      callerScope: () => "driver",
      io,
      seenState: pastGraceForKeys(["cron-block-without-worktree::atmux:team=a"]),
      saveSeenState: async () => {},
      reapDeps: reap.deps,
      logger: log,
    });
    const parsed = JSON.parse(log.lines[0] ?? "{}");
    expect(parsed.failed).toHaveLength(1);
    expect(parsed.failed[0].error).toContain("simulated cron failure");
  });
});

describe("parseTopoArgs — --skip-checks", () => {
  test("--reap --apply --skip-checks sets skipChecks:true", () => {
    const p = parseTopoArgs(["--reap", "--apply", "--skip-checks"]);
    expect(p.skipChecks).toBe(true);
  });

  test("--skip-checks without --apply refuses", () => {
    expect(() => parseTopoArgs(["--reap", "--skip-checks"])).toThrow(UsageError);
  });
});

