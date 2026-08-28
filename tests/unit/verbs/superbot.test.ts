import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnOpts, SpawnResult } from "../../../src/abstractions/spawn.ts";
import type { TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import { SuperbotKanbanAdapter } from "../../../src/adapters/superbot-kanban.ts";
import { BOT_HOLD_OPTION } from "../../../src/core/bot.ts";
import type { LoadedCockpit } from "../../../src/core/cockpit.ts";
import { LockTimeoutError, UsageError } from "../../../src/errors.ts";
import type { Team } from "../../../src/schema/team.ts";
import { parseSuperbotArgs, superbot, superbotTick } from "../../../src/verbs/superbot.ts";

function result(stdout: string): SpawnResult {
  return {
    cmd: "kb",
    argv: [],
    exitCode: 0,
    signalled: null,
    stdout,
    stderr: "",
    durationMs: 1,
  };
}

describe("parseSuperbotArgs", () => {
  test("parses run/tick and safety flags", () => {
    expect(parseSuperbotArgs(["run"])).toEqual({ action: "run", forceShadow: false, json: false });
    expect(parseSuperbotArgs(["tick", "--shadow", "--json", "--config", "/tmp/c.json"])).toEqual({
      action: "tick",
      forceShadow: true,
      json: true,
      configPath: "/tmp/c.json",
    });
  });

  test("rejects missing actions and a live override flag", () => {
    expect(() => parseSuperbotArgs([])).toThrow(UsageError);
    expect(() => parseSuperbotArgs(["tick", "--live"])).toThrow(UsageError);
  });
});

describe("superbotTick", () => {
  test("one-shot ticks share the singleton fence with every scheduler invocation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atmux-superbot-verb-lock-"));
    const lockPath = join(dir, "superbot");
    let enterFirst!: () => void;
    let releaseFirst!: () => void;
    const entered = new Promise<void>((resolve) => {
      enterFirst = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstKanban = new SuperbotKanbanAdapter(async (opts) => {
      if (opts.argv?.[0] !== "claim") throw new Error("unexpected kb call");
      enterFirst();
      await released;
      return result("[]");
    });
    const secondKanban = new SuperbotKanbanAdapter(async () => {
      throw new Error("a contending tick must not reach Kanban");
    });
    const cockpit = {
      schemaVersion: 1,
      cockpitSession: "atx",
      sessions: [],
      windows: [],
      teams: [],
      superbot: {
        enabled: true,
        shadow: true,
        intervalMins: 30,
        fallbackAfterIntervals: 1,
        maxOffersPerTick: 20,
        routes: [{ board: "atmux", tag: "dispatch", defaultTeam: "atmux", fallbackTeams: [] }],
      },
    } as LoadedCockpit;
    const first = superbot(["tick"], {
      loadCockpitFn: async () => cockpit,
      kanban: firstKanban,
      lockPath,
      write: () => {},
    });

    try {
      await entered;
      await expect(
        superbot(["tick"], {
          loadCockpitFn: async () => cockpit,
          kanban: secondKanban,
          lockPath,
          lockTimeoutMs: 1,
          write: () => {},
        }),
      ).rejects.toBeInstanceOf(LockTimeoutError);
    } finally {
      releaseFirst();
      await first;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("shadow cycle proves routing/readiness with zero metadata writes and zero send-keys", async () => {
    const spawnCalls: SpawnOpts[] = [];
    const kanban = new SuperbotKanbanAdapter(async (opts) => {
      spawnCalls.push(opts);
      if (opts.argv?.[0] === "claim") {
        return result(
          JSON.stringify([
            { id: "t-1", type: "task", status: "todo", tags: ["dispatch"], metadata: {} },
          ]),
        );
      }
      if (opts.argv?.[0] === "task" && opts.argv[1] === "list") return result("[]");
      throw new Error(`unexpected kb call: ${opts.argv?.join(" ")}`);
    });

    let sends = 0;
    const capture = "completed\n❯ \n⏵⏵ auto mode on";
    const tmux = {
      session: { hasSession: async () => true },
      window: { listWindows: async () => [{ index: 1, id: "@1", name: "_bot", active: true }] },
      option: { showOptions: async () => ({}) },
      pane: {
        displayMessage: async () => "claude\t0",
        capturePane: async () => capture,
        sendKeys: async () => {
          sends += 1;
        },
      },
    } as unknown as TmuxNamespace;
    const team: Team = {
      name: "atmux",
      members: [],
      bot: { enabled: true, tui: "claude", cwd: ".atmux/worktrees/bot" },
    };
    const cockpit = {
      schemaVersion: 1,
      cockpitSession: "atx",
      sessions: [{ type: "team", name: "atmux", enabled: true, root: "/tmp/atmux", sessions: [] }],
      windows: [],
      teams: [{ name: "atmux", enabled: true, root: "/tmp/atmux" }],
      superbot: {
        enabled: true,
        shadow: true,
        intervalMins: 30,
        fallbackAfterIntervals: 1,
        maxOffersPerTick: 20,
        routes: [
          {
            board: "atmux",
            tag: "dispatch",
            defaultTeam: "atmux",
            fallbackTeams: [],
          },
        ],
      },
    } as LoadedCockpit;

    const rows = await superbotTick(cockpit, false, {
      kanban,
      tmuxFactory: () => tmux,
      loadTeamFn: async () => team,
      now: () => 1_000,
      sleep: async () => {},
    });
    expect(rows).toEqual([
      {
        board: "atmux",
        tag: "dispatch",
        task: "t-1",
        team: "atmux",
        outcome: "shadow-offer",
        reason: "default",
      },
    ]);
    expect(sends).toBe(0);
    expect(spawnCalls.some((call) => call.argv?.includes("metadata"))).toBe(false);
    expect(spawnCalls[0]?.argv).toContain("superbot@cockpit");
  });

  test("defensively refuses a non-task candidate before pane inspection", async () => {
    const kanban = new SuperbotKanbanAdapter(async () =>
      result(
        JSON.stringify([
          { id: "e-1", type: "epic", status: "todo", tags: ["dispatch"], metadata: {} },
        ]),
      ),
    );
    let tmuxFactories = 0;
    const cockpit = {
      schemaVersion: 1,
      cockpitSession: "atx",
      sessions: [],
      windows: [],
      teams: [],
      superbot: {
        enabled: true,
        shadow: true,
        intervalMins: 30,
        fallbackAfterIntervals: 1,
        maxOffersPerTick: 20,
        routes: [{ board: "atmux", tag: "dispatch", defaultTeam: "atmux", fallbackTeams: [] }],
      },
    } as LoadedCockpit;

    const rows = await superbotTick(cockpit, false, {
      kanban,
      tmuxFactory: () => {
        tmuxFactories += 1;
        throw new Error("must not inspect tmux");
      },
    });
    expect(rows).toEqual([
      {
        board: "atmux",
        tag: "dispatch",
        task: "e-1",
        outcome: "not-candidate",
        reason: "type-or-status",
      },
    ]);
    expect(tmuxFactories).toBe(0);
  });

  test("live cycle reserves, buffer-pastes, submits once, verifies, then completes", async () => {
    const spawnCalls: SpawnOpts[] = [];
    const kanban = new SuperbotKanbanAdapter(async (opts) => {
      spawnCalls.push(opts);
      if (opts.argv?.[0] === "claim") {
        return result(
          JSON.stringify([
            { id: "t-2", type: "task", status: "todo", tags: ["dispatch"], metadata: {} },
          ]),
        );
      }
      if (opts.argv?.[0] === "task" && opts.argv[1] === "list") return result("[]");
      if (opts.argv?.[0] === "task" && opts.argv[1] === "metadata") return result("{}");
      throw new Error(`unexpected kb call: ${opts.argv?.join(" ")}`);
    });

    let buffer = "";
    let pastes = 0;
    let submits = 0;
    const ready = "completed\n❯ \n⏵⏵ auto mode on";
    const accepted = "accepted offer\n❯ \n⏵⏵ auto mode on";
    const tmux = {
      session: { hasSession: async () => true },
      window: { listWindows: async () => [{ index: 1, id: "@1", name: "_bot", active: true }] },
      option: { showOptions: async () => ({}) },
      buffer: {
        loadBuffer: async (opts: { data: string }) => {
          buffer = opts.data;
        },
        pasteBuffer: async () => {
          pastes += 1;
        },
      },
      pane: {
        displayMessage: async () => "sh\t0",
        capturePane: async () => (submits === 0 ? ready : accepted),
        sendKeys: async (opts: { keys: string; enter?: boolean }) => {
          expect(opts).toMatchObject({ keys: "C-m", enter: false });
          submits += 1;
        },
      },
    } as unknown as TmuxNamespace;
    const team: Team = {
      name: "atmux",
      members: [],
      bot: { enabled: true, tui: "claude", cwd: ".atmux/worktrees/bot" },
    };
    const cockpit = {
      schemaVersion: 1,
      cockpitSession: "atx",
      sessions: [{ type: "team", name: "atmux", enabled: true, root: "/tmp/atmux", sessions: [] }],
      windows: [],
      teams: [{ name: "atmux", enabled: true, root: "/tmp/atmux" }],
      superbot: {
        enabled: true,
        shadow: false,
        intervalMins: 30,
        fallbackAfterIntervals: 1,
        maxOffersPerTick: 20,
        routes: [{ board: "atmux", tag: "dispatch", defaultTeam: "atmux", fallbackTeams: [] }],
      },
    } as LoadedCockpit;

    expect(
      await superbotTick(cockpit, false, {
        kanban,
        tmuxFactory: () => tmux,
        loadTeamFn: async () => team,
        now: () => 1_000,
        sleep: async () => {},
        paneLockDir: join(tmpdir(), `atmux-superbot-unit-lock-${process.pid}`),
      }),
    ).toEqual([
      {
        board: "atmux",
        tag: "dispatch",
        task: "t-2",
        team: "atmux",
        outcome: "offered",
        reason: "default",
      },
    ]);
    expect(buffer).toContain("kb claim t-2 --project atmux --as bot@atmux --json");
    expect(pastes).toBe(1);
    expect(submits).toBe(1);
    expect(spawnCalls.filter((call) => call.argv?.[1] === "metadata")).toHaveLength(2);
  });

  test("locked pre-send gate refuses a newly claimed task, live lease, or operator hold", async () => {
    for (const race of ["candidate", "lease", "hold"] as const) {
      let candidateReads = 0;
      let leaseReads = 0;
      let optionReads = 0;
      let metadataWrites = 0;
      let sends = 0;
      const candidate = {
        id: "t-race",
        type: "task",
        status: "todo",
        tags: ["dispatch"],
        metadata: {},
      };
      const kanban = new SuperbotKanbanAdapter(async (opts) => {
        if (opts.argv?.[0] === "claim") {
          candidateReads += 1;
          return result(
            JSON.stringify(race === "candidate" && candidateReads >= 3 ? [] : [candidate]),
          );
        }
        if (opts.argv?.[0] === "task" && opts.argv[1] === "list") {
          leaseReads += 1;
          return result(
            JSON.stringify(race === "lease" && leaseReads >= 2 ? [{ id: "t-busy" }] : []),
          );
        }
        if (opts.argv?.[0] === "task" && opts.argv[1] === "show") {
          return result(
            JSON.stringify({
              id: "t-busy",
              claim: { agentID: "bot@atmux", expiresAt: 10_000 },
            }),
          );
        }
        if (opts.argv?.[0] === "task" && opts.argv[1] === "metadata") {
          metadataWrites += 1;
          return result("{}");
        }
        throw new Error(`unexpected kb call: ${opts.argv?.join(" ")}`);
      });

      const ready = "completed\n❯ \n⏵⏵ auto mode on";
      const tmux = {
        session: { hasSession: async () => true },
        window: {
          listWindows: async () => [{ index: 1, id: "@1", name: "_bot", active: true }],
        },
        option: {
          showOptions: async () => {
            optionReads += 1;
            return race === "hold" && optionReads >= 2 ? { [BOT_HOLD_OPTION]: "1" } : {};
          },
        },
        buffer: {
          loadBuffer: async () => {
            sends += 1;
          },
          pasteBuffer: async () => {},
        },
        pane: {
          displayMessage: async () => "sh\t0",
          capturePane: async () => ready,
          sendKeys: async () => {
            sends += 1;
          },
        },
      } as unknown as TmuxNamespace;
      const team: Team = {
        name: "atmux",
        members: [],
        bot: { enabled: true, tui: "claude", cwd: ".atmux/worktrees/bot" },
      };
      const cockpit = {
        schemaVersion: 1,
        cockpitSession: "atx",
        sessions: [
          { type: "team", name: "atmux", enabled: true, root: "/tmp/atmux", sessions: [] },
        ],
        windows: [],
        teams: [{ name: "atmux", enabled: true, root: "/tmp/atmux" }],
        superbot: {
          enabled: true,
          shadow: false,
          intervalMins: 30,
          fallbackAfterIntervals: 1,
          maxOffersPerTick: 20,
          routes: [
            {
              board: "atmux",
              tag: "dispatch",
              defaultTeam: "atmux",
              fallbackTeams: [],
            },
          ],
        },
      } as LoadedCockpit;

      const rows = await superbotTick(cockpit, false, {
        kanban,
        tmuxFactory: () => tmux,
        loadTeamFn: async () => team,
        now: () => 1_000,
        sleep: async () => {},
        paneLockDir: join(tmpdir(), `atmux-superbot-race-${race}-${process.pid}`),
      });
      expect(rows, race).toEqual([
        {
          board: "atmux",
          tag: "dispatch",
          task: "t-race",
          team: "atmux",
          outcome: race === "candidate" ? "not-candidate" : "not-ready",
          ...(race === "candidate" ? {} : { reason: race === "lease" ? "live-lease" : "held" }),
        },
      ]);
      expect(sends, race).toBe(0);
      expect(metadataWrites, race).toBe(1);
    }
  });
});
