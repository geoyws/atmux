import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  renderSuperbotFleetMigration,
  SuperbotFleetPlan,
} from "../../../src/core/superbot-fleet.ts";

const planPath = join(import.meta.dir, "../../../docs/migrations/281-superbot-fleet-plan.json");

async function loadPlan(): Promise<unknown> {
  return JSON.parse(await readFile(planPath, "utf8")) as unknown;
}

describe("ADR-281 held fleet migration plan", () => {
  test("covers every observed persistent parent team with an explicit routable bot", async () => {
    const plan = SuperbotFleetPlan.parse(await loadPlan());
    expect(plan.persistentTeams.map((team) => team.name)).toEqual([
      "journal",
      "geoyws",
      "atmux",
      "orch",
      "kanban",
      "gitea",
      "dash",
      "unum",
      "aix",
      "ix",
      "mx",
      "prjx",
      "px",
      "hx",
      "hrx",
      "rx",
      "fmx",
      "ifca-docs",
    ]);
    expect(
      plan.persistentTeams.filter((team) => team.teamConfig === "missing").map((team) => team.name),
    ).toEqual(["ix", "mx", "hx", "hrx", "fmx"]);
    expect(
      plan.persistentTeams.every(
        (team) =>
          team.bot.enabled === true &&
          team.bot.tui === "claude" &&
          typeof team.bot.claudeAccount === "string",
      ),
    ).toBe(true);
  });

  test("renders disabled shadow config with one owner for every exact route", async () => {
    const rendered = renderSuperbotFleetMigration(await loadPlan());
    expect(rendered.activation).toBe("held");
    expect(rendered.teamPatches).toHaveLength(18);
    expect(rendered.cockpitPatch.superbot.enabled).toBe(false);
    expect(rendered.cockpitPatch.superbot.shadow).toBe(true);
    expect(rendered.cockpitPatch.superbot.intervalMins).toBe(30);
    expect(rendered.cockpitPatch.superbot.fallbackAfterIntervals).toBe(1);
    expect(rendered.cockpitPatch.superbot.routes).toHaveLength(95);
    expect(
      rendered.cockpitPatch.superbot.routes.find(
        (route) => route.board === "px" && route.tag === "aix-chat",
      ),
    ).toEqual({
      board: "px",
      tag: "aix-chat",
      defaultTeam: "aix",
      fallbackTeams: [],
    });
    expect(
      rendered.cockpitPatch.superbot.routes.find(
        (route) => route.board === "fmx" && route.tag === "ai-chat",
      ),
    ).toEqual({
      board: "fmx",
      tag: "ai-chat",
      defaultTeam: "fmx",
      fallbackTeams: [],
    });
    expect(
      rendered.cockpitPatch.superbot.routes.find(
        (route) => route.board === "fmx" && route.tag === "tooling",
      ),
    ).toEqual({
      board: "fmx",
      tag: "tooling",
      defaultTeam: "aix",
      fallbackTeams: [],
    });
    expect(rendered.activationBlockers).toHaveLength(3);
  });

  test("refuses implicit harness/account and duplicate board-local ownership", () => {
    const base = {
      schemaVersion: 1,
      observedAt: "2026-08-28T00:00:00Z",
      sourceCockpit: "/tmp/cockpit.json",
      sourceCockpitSha256: "a".repeat(64),
      activation: "held",
      persistentTeams: [
        {
          name: "alpha",
          root: "/tmp/alpha",
          teamConfig: "present",
          bot: { enabled: true, cwd: ".atmux/worktrees/bot", tui: null, claudeAccount: null },
        },
      ],
      ownership: [
        { board: "alpha", tags: ["core"], defaultTeam: "alpha" },
        { board: "alpha", tags: ["core"], defaultTeam: "alpha" },
      ],
    };
    expect(() => SuperbotFleetPlan.parse(base)).toThrow();
  });
});
