// Unit tests for e-48 config-driven wrapper registry (t-e6ebc77b):
//   - mergeWrapperRegistries precedence (built-ins → cockpit → team)
//   - resolveClaudeWrapper against custom registries + ConfigError hint
//   - checkClaudeWrappers red/green paths
//   - Cockpit + Team schema accept `wrappers` records
//
// Imports team.ts directly (not the doctor.ts barrel — the barrel
// pulls ./doctor/nesting.ts, lane-untracked sibling WIP).

import { describe, expect, test } from "bun:test";
import {
  mergeWrapperRegistries,
  resolveClaudeWrapper,
} from "../../../src/abstractions/claude-account-wrapper.ts";
import { ConfigError } from "../../../src/errors.ts";
import { Cockpit } from "../../../src/schema/cockpit.ts";
import { Team } from "../../../src/schema/team.ts";
import { checkClaudeWrappers } from "../../../src/verbs/doctor/team.ts";

describe("mergeWrapperRegistries", () => {
  test("built-ins survive; cockpit then team win", () => {
    const m = mergeWrapperRegistries(
      { "/root/.claude": "custom-claude", "/x": "x-wrap" },
      { "/x": "x-team" },
    );
    expect(m.get("/root/.claude")).toBe("custom-claude");
    expect(m.get("/x")).toBe("x-team");
    expect(m.get("/root/.claude-unum")).toBe("c-u");
  });

  test("undefined registries are skipped", () => {
    const m = mergeWrapperRegistries(undefined, undefined);
    expect(m.get("/root/.claude")).toBe("claude");
  });
});

describe("resolveClaudeWrapper with registry", () => {
  test("custom entry resolves", () => {
    const m = mergeWrapperRegistries({ "/root/.opencode": "od" });
    expect(resolveClaudeWrapper("/root/.opencode", m)).toBe("od");
  });

  test("unknown entry throws ConfigError naming the registry", () => {
    const m = mergeWrapperRegistries({ "/root/.opencode": "od" });
    let message = "";
    try {
      resolveClaudeWrapper("/nope", m);
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      if (e instanceof Error) message = e.message;
    }
    expect(message).toContain("/root/.opencode");
  });
});
describe("checkClaudeWrappers", () => {
  function teamWith(driverAccount: string | null | undefined, botAccount?: string | null): Team {
    return Team.parse({
      name: "t",
      members: [{ name: "m0" }],
      drivers: [{ name: "driver", cwd: "/tmp", claudeAccount: driverAccount }],
      ...(botAccount !== undefined ? { bot: { claudeAccount: botAccount } } : {}),
    });
  }

  test("all-known → no rows", () => {
    expect(checkClaudeWrappers(teamWith("/root/.claude", null))).toEqual([]);
  });

  test("unknown dir → single red row naming holder", () => {
    const rows = checkClaudeWrappers(teamWith("/nope/dir"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("red");
    expect(rows[0]?.label).toBe("claude-wrappers");
    expect(rows[0]?.detail).toMatch(/driver:driver:\/nope\/dir/);
  });

  test("team override registers a custom dir", () => {
    const team = Team.parse({
      name: "t",
      members: [{ name: "m0" }],
      drivers: [{ name: "driver", cwd: "/tmp", claudeAccount: "/root/.opencode" }],
      wrappers: { "/root/.opencode": "od" },
    });
    expect(checkClaudeWrappers(team)).toEqual([]);
  });
});

describe("wrappers schema fields", () => {
  test("Cockpit accepts wrappers record", () => {
    const c = Cockpit.parse({ wrappers: { "/root/.opencode": "od" } });
    expect(c.wrappers).toEqual({ "/root/.opencode": "od" });
  });

  test("Team accepts wrappers record", () => {
    const t = Team.parse({ name: "t", members: [], wrappers: { "/x": "y" } });
    expect(t.wrappers).toEqual({ "/x": "y" });
  });
});
