// Unit tests for src/core/sync-claude-team-json/diff.ts (ADR-164 T6 — t-fe4a570e).
//
// Pure-function tests — no fs / tmux / cwd state. The renderer is the
// heart of the --dry-run preview: it must be deterministic, correctly
// classify add / remove / modify / unchanged at both top-level and
// per-member scope, and survive the fresh-file case (prior === null).

import { describe, expect, test } from "bun:test";
import { renderDiff } from "../../../../src/core/sync-claude-team-json/diff.ts";
import type {
  ClaudeTeam,
  ClaudeTeamMember,
} from "../../../../src/core/sync-claude-team-json/types.ts";

function member(over: Partial<ClaudeTeamMember> & { name: string }): ClaudeTeamMember {
  return { ...over };
}

describe("renderDiff — fresh file (prior === null)", () => {
  test("emits + prefix on every line, fresh-file header", () => {
    const out = renderDiff(null, {
      name: "fixture",
      description: "test",
      members: [
        member({
          name: "team-lead",
          agentType: "team-lead",
          color: "white",
          model: "claude-opus-4-7",
        }),
        member({ name: "planner", color: "magenta", model: "claude-opus-4-7" }),
      ],
    });
    expect(out).toContain("fresh file");
    expect(out).toMatch(/^\+ {2}name: fixture/m);
    expect(out).toMatch(/^\+ {2}description: test/m);
    expect(out).toContain("+  [member: team-lead]");
    expect(out).toContain("+    name: team-lead");
    expect(out).toContain("+    agentType: team-lead");
    expect(out).toContain("+    color: white");
    expect(out).toContain("+    model: claude-opus-4-7");
    expect(out).toContain("+  [member: planner]");
    // No - lines on fresh file
    expect(out.split("\n").filter((l) => l.startsWith("-"))).toHaveLength(0);
  });

  test("ends in a newline (caller-writes-to-stdout-without-padding contract)", () => {
    const out = renderDiff(null, {
      name: "x",
      description: undefined,
      members: [],
    });
    expect(out.endsWith("\n")).toBe(true);
  });

  test("undefined description is suppressed (no `+  description:` line)", () => {
    const out = renderDiff(null, {
      name: "x",
      description: undefined,
      members: [],
    });
    expect(out).not.toContain("description:");
  });
});

describe("renderDiff — vs prior file", () => {
  const prior: ClaudeTeam = {
    name: "fixture",
    description: "old",
    members: [
      member({ name: "team-lead", agentType: "team-lead", color: "white" }),
      member({ name: "planner", color: "magenta", role: "hand-authored brief" }),
      member({ name: "removed-one", color: "red" }),
    ],
  };

  test("added member → + prefix block", () => {
    const out = renderDiff(prior, {
      name: "fixture",
      description: "old",
      members: [
        member({ name: "team-lead", agentType: "team-lead", color: "white" }),
        member({ name: "planner", color: "magenta" }),
        member({ name: "removed-one", color: "red" }),
        member({ name: "fresh-be", color: "green" }),
      ],
    });
    expect(out).toContain("+  [member: fresh-be]");
    expect(out).toContain("+    name: fresh-be");
    expect(out).toContain("+    color: green");
  });

  test("removed member → - prefix block", () => {
    const out = renderDiff(prior, {
      name: "fixture",
      description: "old",
      members: [
        member({ name: "team-lead", agentType: "team-lead", color: "white" }),
        member({ name: "planner", color: "magenta" }),
        // removed-one dropped from computed roster
      ],
    });
    expect(out).toContain("-  [member: removed-one]");
    expect(out).toContain("-    color: red");
  });

  test("modified field → paired -/+ lines, unchanged fields → space prefix", () => {
    const out = renderDiff(prior, {
      name: "fixture",
      description: "old",
      members: [
        member({ name: "team-lead", agentType: "team-lead", color: "cyan" }), // color changed
        member({ name: "planner", color: "magenta", role: "hand-authored brief" }),
        member({ name: "removed-one", color: "red" }),
      ],
    });
    expect(out).toContain("-    color: white");
    expect(out).toContain("+    color: cyan");
    // unchanged name field on team-lead stays as space prefix
    expect(out).toMatch(/^ {5}name: team-lead/m);
  });

  test("identical roster → space-prefix everywhere (member headers retained for grep)", () => {
    const out = renderDiff(prior, {
      name: "fixture",
      description: "old",
      members: [
        member({ name: "team-lead", agentType: "team-lead", color: "white" }),
        member({ name: "planner", color: "magenta", role: "hand-authored brief" }),
        member({ name: "removed-one", color: "red" }),
      ],
    });
    // Each member's header rendered with space prefix
    expect(out).toMatch(/^ {3}\[member: team-lead\]/m);
    expect(out).toMatch(/^ {3}\[member: planner\]/m);
    expect(out).toMatch(/^ {3}\[member: removed-one\]/m);
    // No +/- lines anywhere
    const lines = out.split("\n");
    expect(lines.filter((l) => l.startsWith("+"))).toHaveLength(0);
    expect(lines.filter((l) => l.startsWith("-"))).toHaveLength(0);
  });

  test("field added on computed side only → single + line", () => {
    const out = renderDiff(prior, {
      name: "fixture",
      description: "old",
      members: [
        member({
          name: "team-lead",
          agentType: "team-lead",
          color: "white",
          model: "claude-opus-4-7",
        }),
        member({ name: "planner", color: "magenta" }),
        member({ name: "removed-one", color: "red" }),
      ],
    });
    expect(out).toContain("+    model: claude-opus-4-7");
    // No -    model: line because prior had no model
    expect(out).not.toContain("-    model:");
  });

  test("field dropped on computed side only → single - line", () => {
    const out = renderDiff(prior, {
      name: "fixture",
      description: "old",
      members: [
        member({ name: "team-lead", agentType: "team-lead" }), // color dropped
        member({ name: "planner", color: "magenta" }),
        member({ name: "removed-one", color: "red" }),
      ],
    });
    expect(out).toContain("-    color: white");
    // No +    color: line because computed has no color
    const colorPlus = out.split("\n").filter((l) => /^\+ {4}color:/.test(l));
    expect(colorPlus).toHaveLength(0);
  });

  test("top-level name change → -/+ pair", () => {
    const out = renderDiff(prior, {
      name: "renamed-team",
      description: "old",
      members: prior.members ?? [],
    });
    expect(out).toContain("-  name: fixture");
    expect(out).toContain("+  name: renamed-team");
  });

  test("description added when prior had none → single + line", () => {
    const out = renderDiff(
      { name: "x", members: [] },
      { name: "x", description: "now-described", members: [] },
    );
    expect(out).toContain("+  description: now-described");
  });

  test("description removed when computed omits it → single - line", () => {
    const out = renderDiff(
      { name: "x", description: "was-described", members: [] },
      { name: "x", description: undefined, members: [] },
    );
    expect(out).toContain("-  description: was-described");
    expect(out).not.toContain("+  description:");
  });

  test("malformed known member field falls back to JSON text", () => {
    const out = renderDiff(
      {
        name: "x",
        members: [
          member({
            name: "json-field",
            color: { nested: true } as unknown as string,
          }),
        ],
      },
      {
        name: "x",
        description: undefined,
        members: [
          member({
            name: "json-field",
            color: { nested: true } as unknown as string,
          }),
        ],
      },
    );
    expect(out).toContain('     color: {"nested":true}');
  });

  test("members header counts the computed roster", () => {
    const out = renderDiff(null, {
      name: "x",
      description: undefined,
      members: [
        member({ name: "a", color: "white" }),
        member({ name: "b", color: "green" }),
        member({ name: "c", color: "red" }),
      ],
    });
    expect(out).toContain("members (3):");
  });

  test("malformed prior member (non-string name) is skipped in the index", () => {
    // Operator extensions might land non-string in a `name` field; the
    // renderer must not crash + must not match those entries to computed
    // members. Result: every computed member is treated as fresh-add (+).
    const malformed: ClaudeTeam = {
      members: [
        { name: 42 as unknown as string, color: "white" },
        { name: "", color: "green" },
      ],
    };
    const out = renderDiff(malformed, {
      name: "x",
      description: undefined,
      members: [member({ name: "real-one", color: "magenta" })],
    });
    expect(out).toContain("+  [member: real-one]");
  });
});
