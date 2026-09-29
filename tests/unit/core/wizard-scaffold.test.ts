import { describe, expect, test } from "bun:test";
import { selectAccount } from "../../../src/core/account-pool.ts";
import {
  installSkillsPlugin,
  scaffoldTeamJson,
  setupAccountPool,
  type WizardJsonFsDeps,
} from "../../../src/core/wizard-scaffold.ts";
import { Team } from "../../../src/schema/team.ts";

function memoryFile(path: string, initial: string | null = null) {
  let content = initial;
  const writes: string[] = [];
  const deps: WizardJsonFsDeps = {
    path,
    readText: async () => content,
    writeText: async (_path, next) => {
      content = next;
      writes.push(next);
    },
  };
  return { deps, writes, read: () => content };
}

describe("scaffoldTeamJson", () => {
  test("writes a drivers-only roster that parses against Team", async () => {
    const file = memoryFile("/repo/.atmux/team.json");

    const result = await scaffoldTeamJson(file.deps, {
      name: "alpha",
      drivers: [
        { name: "driver", cwd: ".", tui: null },
        { name: "driver-2", cwd: ".atmux/worktrees/driver-2", tui: "claude" },
      ],
    });

    expect(result.kind).toBe("written");
    const persisted = JSON.parse(file.read()!);
    // Parses clean (no throw) and keeps the drivers-only roster contract
    // (ADR-287 §D5): members [] with the supplied canonical drivers.
    const team = Team.parse(persisted);
    expect(team.name).toBe("alpha");
    expect(team.members).toEqual([]);
    expect(team.drivers?.map((d) => d.name)).toEqual(["driver", "driver-2"]);
  });

  test("omitted drivers fall back to the canonical drivers default", async () => {
    const file = memoryFile("/repo/.atmux/team.json");

    await scaffoldTeamJson(file.deps, { name: "alpha" });

    const team = Team.parse(JSON.parse(file.read()!));
    expect(team.members).toEqual([]);
    expect(team.drivers?.map((d) => d.name)).toEqual(["driver", "driver-2", "driver-3"]);
  });

  test("an identical re-run is a no-op", async () => {
    const file = memoryFile("/repo/.atmux/team.json");
    const answers = { name: "alpha", drivers: [{ name: "driver", cwd: "." }] };

    await scaffoldTeamJson(file.deps, answers);
    const second = await scaffoldTeamJson(file.deps, answers);

    expect(second.kind).toBe("unchanged");
    expect(file.writes).toHaveLength(1);
  });
});

describe("setupAccountPool", () => {
  test("stores exactly the shape consumed by the account selector and preserves cockpit keys", async () => {
    const file = memoryFile(
      "/home/user/.atmux/cockpit.json",
      JSON.stringify({ version: 1, sessions: [] }, null, 2) + "\n",
    );
    const accounts = [
      { label: "ifca", configDir: "/home/user/.claude-ifca", weight: 1 },
      { label: "personal", configDir: "/home/user/.claude-personal", weight: 0.8 },
    ];

    await setupAccountPool(file.deps, accounts);

    const persisted = JSON.parse(file.read()!);
    expect(persisted).toEqual({ version: 1, sessions: [], claudeAccountPool: accounts });
    const picked = selectAccount({
      pool: persisted.claudeAccountPool,
      budgetByLabel: new Map(),
      now: 0,
    });
    if (picked.account === null) throw new Error("expected the pool head to be selected");
    expect(picked.account).toEqual({
      label: "ifca",
      configDir: "/home/user/.claude-ifca",
      weight: 1,
    });
  });

  test("an identical re-run is a no-op", async () => {
    const file = memoryFile("/home/user/.atmux/cockpit.json");
    const accounts = [{ label: "ifca", configDir: "/home/user/.claude-ifca" }];

    await setupAccountPool(file.deps, accounts);
    const second = await setupAccountPool(file.deps, accounts);

    expect(second.kind).toBe("unchanged");
    expect(file.writes).toHaveLength(1);
  });
});

describe("installSkillsPlugin", () => {
  test("invokes the ADR-217 installer with the supplied paths and flags", async () => {
    const calls: unknown[] = [];
    const options = {
      source: "/opt/atmux/plugins/atmux",
      target: "/home/user/.claude/plugins/atmux",
      force: true,
    };

    const result = await installSkillsPlugin({
      options,
      runner: async (received) => {
        calls.push(received);
        return { kind: "installed", source: received.source!, target: received.target! };
      },
    });

    expect(calls).toEqual([options]);
    expect(result).toEqual({ kind: "installed", source: options.source, target: options.target });
  });
});
