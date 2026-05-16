// Unit tests for src/core/goal-resolver.ts (ADR-157 T2 / Task t-b5b0678e).
//
// Exercises the 5-cell resolution matrix from the task body verbatim
// (explicit-wins / brief-parsed / brief-missing-section / graceful-degrade
// / empty-string-opt-out) + the runtime-gate WARN helper.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseStandingGoalFromBrief,
  resolveGoalForMember,
  validateGoalRuntime,
} from "../../../src/core/goal-resolver.ts";
import type { TeamMember } from "../../../src/schema/team.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "atmux-goal-resolver-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ---------- parseStandingGoalFromBrief ----------

describe("parseStandingGoalFromBrief", () => {
  test("captures single-line goal text after the heading", () => {
    const md = `# preamble

## Standing Goal

All members' branches are merged to trunk and trunk typechecks green

## Other Section

something else
`;
    expect(parseStandingGoalFromBrief(md)).toBe(
      "All members' branches are merged to trunk and trunk typechecks green",
    );
  });

  test("captures multi-line goal until next heading", () => {
    const md = `## Standing Goal

Kanban.status=blocked is empty
AND no member is over ctx-threshold

## Discipline
`;
    const got = parseStandingGoalFromBrief(md);
    expect(got).toContain("Kanban.status=blocked is empty");
    expect(got).toContain("AND no member is over ctx-threshold");
    expect(got).not.toContain("## Discipline");
  });

  test("returns null when no Standing Goal section exists", () => {
    expect(parseStandingGoalFromBrief("# preamble\n\nbody\n")).toBeNull();
  });

  test("case-sensitive match — `## standing goal` (lowercase) does NOT hit", () => {
    expect(
      parseStandingGoalFromBrief("## standing goal\n\nbody\n"),
    ).toBeNull();
  });

  test("rejects trailing colon variant — `## Standing Goal:` does NOT match", () => {
    expect(
      parseStandingGoalFromBrief("## Standing Goal:\n\nbody\n"),
    ).toBeNull();
  });
});

// ---------- resolveGoalForMember — 5-cell matrix ----------

describe("resolveGoalForMember — resolution chain (ADR-157 §D2 / §OQ3)", () => {
  test("(member.goal set, brief has Standing Goal) → explicit wins", async () => {
    const briefPath = join(tempDir, "brief.md");
    await writeFile(briefPath, "## Standing Goal\n\nfrom-brief\n");
    const member: TeamMember = {
      name: "alice",
      goal: "explicit-override",
    };
    expect(await resolveGoalForMember(member, briefPath)).toBe(
      "explicit-override",
    );
  });

  test("(member.goal unset, brief has Standing Goal) → brief-parsed text", async () => {
    const briefPath = join(tempDir, "brief.md");
    await writeFile(briefPath, "## Standing Goal\n\nfrom-brief\n");
    const member: TeamMember = { name: "alice" };
    expect(await resolveGoalForMember(member, briefPath)).toBe("from-brief");
  });

  test("(member.goal unset, brief has no Standing Goal section) → null", async () => {
    const briefPath = join(tempDir, "brief.md");
    await writeFile(briefPath, "# brief\n\nno goal here\n");
    const member: TeamMember = { name: "alice" };
    expect(await resolveGoalForMember(member, briefPath)).toBeNull();
  });

  test("(member.goal set, brief unreadable) → graceful degrade to explicit", async () => {
    const member: TeamMember = {
      name: "alice",
      goal: "still-works",
    };
    expect(
      await resolveGoalForMember(member, "/nonexistent/path/brief.md"),
    ).toBe("still-works");
  });

  test("(member.goal explicitly empty string) → null (opt-out signal)", async () => {
    const briefPath = join(tempDir, "brief.md");
    await writeFile(briefPath, "## Standing Goal\n\nshould-not-fire\n");
    const member: TeamMember = {
      name: "alice",
      goal: "",
    };
    // Explicit empty MUST NOT fall through to brief parsing — that's
    // the opt-out contract. Result is null + brief is not consulted.
    expect(await resolveGoalForMember(member, briefPath)).toBeNull();
  });

  test("(briefPath omitted, member.goal unset) → null", async () => {
    expect(await resolveGoalForMember({ name: "alice" })).toBeNull();
  });

  test("(briefPath omitted, member.goal set) → explicit", async () => {
    expect(
      await resolveGoalForMember({ name: "alice", goal: "direct" }),
    ).toBe("direct");
  });
});

// ---------- validateGoalRuntime — WARN-not-refuse ----------

describe("validateGoalRuntime (ADR-157 §D4)", () => {
  test("cursor runtime + goal set → WARN string", () => {
    const member: TeamMember = {
      name: "martinet",
      runtime: "cursor",
      goal: "irrelevant",
    };
    const warn = validateGoalRuntime(member);
    expect(warn).not.toBeNull();
    expect(warn).toContain("martinet");
    expect(warn).toContain("cursor");
    expect(warn).toContain("ADR-157 §D4");
  });

  test("cursor runtime + goal unset → null (no warn)", () => {
    expect(
      validateGoalRuntime({ name: "martinet", runtime: "cursor" }),
    ).toBeNull();
  });

  test("cursor runtime + goal empty string → null (opt-out, no warn)", () => {
    expect(
      validateGoalRuntime({ name: "martinet", runtime: "cursor", goal: "" }),
    ).toBeNull();
  });

  test("claude runtime + goal set → null (happy path)", () => {
    expect(
      validateGoalRuntime({ name: "lead", runtime: "claude", goal: "x" }),
    ).toBeNull();
  });

  test("runtime unset + goal set → null (TUI-derived runtime; T3 hooks gate)", () => {
    expect(
      validateGoalRuntime({ name: "lead", goal: "x" }),
    ).toBeNull();
  });
});

// ---------- Back-compat smoke — schema accepts goal field ----------

describe("TeamMember schema back-compat (ADR-157 T2 acceptance gate)", () => {
  test("existing TeamMember without goal/runtime parses unchanged", async () => {
    const { TeamMember: TeamMemberSchema } = await import(
      "../../../src/schema/team.ts"
    );
    const parsed = TeamMemberSchema.parse({ name: "alice", role: "member" });
    expect(parsed.name).toBe("alice");
    expect(parsed.goal).toBeUndefined();
    expect(parsed.runtime).toBeUndefined();
  });

  test("TeamMember with goal + runtime parses + round-trips", async () => {
    const { TeamMember: TeamMemberSchema } = await import(
      "../../../src/schema/team.ts"
    );
    const parsed = TeamMemberSchema.parse({
      name: "lead",
      role: "team-lead",
      runtime: "claude",
      goal: "All members commit in last 30min",
    });
    expect(parsed.goal).toBe("All members commit in last 30min");
    expect(parsed.runtime).toBe("claude");
  });
});
