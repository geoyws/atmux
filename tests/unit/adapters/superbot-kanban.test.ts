import { describe, expect, test } from "bun:test";
import type { SpawnOpts, SpawnResult } from "../../../src/abstractions/spawn.ts";
import { SuperbotKanbanAdapter } from "../../../src/adapters/superbot-kanban.ts";

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

describe("SuperbotKanbanAdapter", () => {
  test("lists each active canonical registered board and strips ambient selectors", async () => {
    const calls: SpawnOpts[] = [];
    const adapter = new SuperbotKanbanAdapter(async (opts) => {
      calls.push(opts);
      return result(
        JSON.stringify([
          {
            name: "atmux",
            boardPath: "/boards/atmux.db",
            canonical: true,
            archived: false,
          },
          {
            name: "atmux",
            boardPath: "/boards/atmux.db",
            canonical: false,
            archived: false,
          },
          {
            name: "old",
            boardPath: "/boards/old.db",
            canonical: true,
            archived: true,
          },
        ]),
      );
    });

    expect(await adapter.registeredBoards()).toEqual(["atmux"]);
    expect(calls[0]?.argv).toEqual(["workspace", "list", "--json"]);
    expect(calls[0]?.unsetEnv).toEqual(["KANBAN_PROJECT", "KANBAN_DB", "KANBAN_DATA_DIR"]);
  });

  test("uses explicit board/tag/actor and strips ambient board selectors", async () => {
    const calls: SpawnOpts[] = [];
    const adapter = new SuperbotKanbanAdapter(async (opts) => {
      calls.push(opts);
      return result(
        JSON.stringify([
          {
            id: "t-1",
            type: "task",
            status: "todo",
            tags: ["dispatch"],
            metadata: { keep: true },
          },
        ]),
      );
    });
    const rows = await adapter.candidates("atmux", "dispatch", "superbot@cockpit", 3);
    expect(rows[0]).toMatchObject({ id: "t-1", tags: ["dispatch"] });
    expect(calls[0]?.argv).toEqual([
      "claim",
      "--candidates",
      "--project",
      "atmux",
      "--as",
      "superbot@cockpit",
      "--tag",
      "dispatch",
      "--limit",
      "3",
      "--json",
    ]);
    expect(calls[0]?.unsetEnv).toEqual(["KANBAN_PROJECT", "KANBAN_DB", "KANBAN_DATA_DIR"]);
  });

  test("finds an unexpired claim by actor from task detail", async () => {
    const adapter = new SuperbotKanbanAdapter(async (opts) => {
      if (opts.argv?.[1] === "list") return result(JSON.stringify([{ id: "t-1" }]));
      return result(
        JSON.stringify({
          id: "t-1",
          claim: { agentID: "bot@atmux", expiresAt: 2_000 },
        }),
      );
    });
    expect(await adapter.hasLiveClaim("atmux", "bot@atmux", 1_000)).toBe(true);
    expect(await adapter.hasLiveClaim("atmux", "bot@other", 1_000)).toBe(false);
  });

  test("writes only the namespaced scheduler metadata", async () => {
    const calls: SpawnOpts[] = [];
    const adapter = new SuperbotKanbanAdapter(async (opts) => {
      calls.push(opts);
      return result("{}");
    });
    await adapter.writeOfferState("atmux", "t-1", {
      routeKey: "atmux/dispatch",
      firstOfferedAt: 1,
      lastOfferedAt: 1,
      offeredTeams: {},
      pending: { team: "atmux", at: 1, attempts: 1 },
    });
    const argv = calls[0]?.argv ?? [];
    expect(argv.slice(0, 7)).toEqual([
      "task",
      "metadata",
      "t-1",
      "--project",
      "atmux",
      "--as",
      "superbot@cockpit",
    ]);
    const patch = JSON.parse(argv[argv.indexOf("--patch-json") + 1] ?? "{}") as Record<
      string,
      unknown
    >;
    expect(Object.keys(patch)).toEqual(["atmuxSuperbot"]);
  });
});
