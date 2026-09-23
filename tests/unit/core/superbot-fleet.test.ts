import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  renderSuperbotFleetMigration,
  SuperbotFleetOwnership,
  SuperbotFleetPlan,
  SuperbotFleetTeam,
} from "../../../src/core/superbot-fleet.ts";

const planPath = join(import.meta.dir, "../../../docs/migrations/285-superbot-fleet-plan.json");

async function loadPlan(): Promise<unknown> {
  return JSON.parse(await readFile(planPath, "utf8")) as unknown;
}

describe("ADR-285 held fleet migration plan", () => {
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

describe("fleet validation refinements (t-4de30439)", () => {
  const validBot = { enabled: true, tui: "claude", claudeAccount: "c-acc" };

  function validPlan(): Record<string, unknown> {
    return {
      schemaVersion: 1,
      observedAt: "2026-08-28T00:00:00Z",
      sourceCockpit: "/tmp/cockpit.json",
      sourceCockpitSha256: "a".repeat(64),
      activation: "held",
      persistentTeams: [
        { name: "alpha", root: "/tmp/alpha", teamConfig: "present", bot: { ...validBot } },
      ],
      ownership: [],
    };
  }

  test("team bot disabled is refused", () => {
    const r = SuperbotFleetTeam.safeParse({
      name: "alpha",
      root: "/tmp/alpha",
      teamConfig: "present",
      bot: { ...validBot, enabled: false },
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.map((i) => i.message)).toContain("fleet bot must be enabled");
  });

  test("duplicate ownership tag is refused", () => {
    const r = SuperbotFleetOwnership.safeParse({
      board: "alpha",
      tags: ["core", "core"],
      defaultTeam: "alpha",
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.map((i) => i.message)).toContain("duplicate tag 'core'");
  });

  test("duplicate ownership teams are refused", () => {
    const r = SuperbotFleetOwnership.safeParse({
      board: "alpha",
      tags: ["core"],
      defaultTeam: "alpha",
      fallbackTeams: ["alpha"],
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.map((i) => i.message)).toContain("ownership teams must be unique");
  });

  test("duplicate persistent team is refused", () => {
    const plan = validPlan();
    plan.persistentTeams = [
      { name: "alpha", root: "/tmp/alpha", teamConfig: "present", bot: { ...validBot } },
      { name: "alpha", root: "/tmp/alpha-2", teamConfig: "present", bot: { ...validBot } },
    ];
    const r = SuperbotFleetPlan.safeParse(plan);
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.map((i) => i.message)).toContain("duplicate persistent team 'alpha'");
  });

  test("ownership naming an unknown persistent team is refused", () => {
    const plan = validPlan();
    plan.ownership = [{ board: "alpha", tags: ["core"], defaultTeam: "ghost" }];
    const r = SuperbotFleetPlan.safeParse(plan);
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.map((i) => i.message)).toContain(
      "ownership names unknown persistent team 'ghost'",
    );
  });
});
