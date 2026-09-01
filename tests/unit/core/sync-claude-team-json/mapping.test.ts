// Unit tests for src/core/sync-claude-team-json/mapping.ts (ADR-164 T3 +
// T4 surfaces — t-312fe824 / t-87e81c8e, asserted under T7 t-4329b053).
//
// Covers:
//   - mapMember: per-member transform — name verbatim (+ team-lead rewrite),
//     color via resolveColor, agentType emitted for team-lead only,
//     model default-expansion, dropped atmux-runtime fields (lane, tui,
//     cwd, command, label, claudeAccount).
//   - mapRoster: 1:1 input-order preservation.
//   - mergeBriefs: brief-preservation policy (T4 surface) — preserve
//     non-empty prior role text by default, replace on --overwrite-briefs.

import { describe, expect, test } from "bun:test";
import {
  mapMember,
  mapRoster,
  mergeBriefs,
} from "../../../../src/core/sync-claude-team-json/mapping.ts";
import type {
  ClaudeTeam,
  ClaudeTeamMember,
} from "../../../../src/core/sync-claude-team-json/types.ts";
import type { TeamMember } from "../../../../src/schema/team.ts";

// Test helper: build a minimal TeamMember satisfying the Zod-inferred
// shape. Only `name` is required by the schema; the rest are optional
// extensions the mapper may consume.
function tm(over: Partial<TeamMember> & { name: string }): TeamMember {
  return { ...over } as TeamMember;
}

// ---------- mapMember ----------

describe("mapMember", () => {
  test("non-lead member: name verbatim, color resolved, no agentType, no model when atmux model unset", () => {
    const got = mapMember(tm({ name: "fe-1", role: "member", emoji: "🌸" }), null);
    expect(got.name).toBe("fe-1");
    expect(got.color).toBe("orange"); // 🌸 → orange in fixed table
    expect(got.agentType).toBeUndefined();
    expect(got.model).toBeUndefined();
    // role is NOT emitted by mapMember (mergeBriefs handles brief preservation)
    expect(got.role).toBeUndefined();
  });

  test("lead member: name rewritten to 'team-lead' + agentType='team-lead'", () => {
    const got = mapMember(tm({ name: "lead", role: "team-lead", emoji: "🧭" }), null);
    expect(got.name).toBe("team-lead");
    expect(got.agentType).toBe("team-lead");
    expect(got.color).toBe("white"); // 🧭 → white
  });

  test("model='default' → expanded to 'claude-opus-4-7' (ADR-094 default-expansion)", () => {
    const got = mapMember(tm({ name: "be-1", role: "member", model: "default" }), null);
    expect(got.model).toBe("claude-opus-4-7");
  });

  test("model passthrough for non-default values", () => {
    const got = mapMember(
      tm({ name: "be-1", role: "member", model: "claude-haiku-4-5-20251001" }),
      null,
    );
    expect(got.model).toBe("claude-haiku-4-5-20251001");
  });

  test("atmux-runtime fields (lane, tui, cwd, command, label) are DROPPED", () => {
    const got = mapMember(
      tm({
        name: "fe-1",
        role: "member",
        lane: "fe",
        tui: "claude",
        cwd: "/srv/whatever",
        command: "claude --foo",
        label: "Display Name",
        emoji: "🌸",
      }),
      null,
    );
    // The mapper emits only the documented Claude-side fields. Index-
    // signature inheritance from ClaudeTeamMember tolerates arbitrary
    // operator extensions on the type, but the mapper's output must
    // not include atmux-runtime keys.
    expect(got).not.toHaveProperty("lane");
    expect(got).not.toHaveProperty("tui");
    expect(got).not.toHaveProperty("cwd");
    expect(got).not.toHaveProperty("command");
    expect(got).not.toHaveProperty("label");
    expect(got).not.toHaveProperty("claudeAccount");
  });

  test("agentType is only emitted for the literal role 'team-lead'", () => {
    expect(mapMember(tm({ name: "planner", role: "planner" }), null).agentType).toBeUndefined();
    expect(mapMember(tm({ name: "reviewer", role: "reviewer" }), null).agentType).toBeUndefined();
    expect(mapMember(tm({ name: "be-1", role: "committer" }), null).agentType).toBeUndefined();
  });

  test("emoji-less member still resolves color via name-seeded pool fallback", () => {
    const got = mapMember(tm({ name: "loner", role: "member" }), null);
    expect(typeof got.color).toBe("string");
    expect((got.color as string).length).toBeGreaterThan(0);
  });
});

// ---------- mapRoster ----------

describe("mapRoster", () => {
  test("preserves input order 1:1", () => {
    const got = mapRoster(
      [
        tm({ name: "lead", role: "team-lead", emoji: "🧭" }),
        tm({ name: "planner", role: "planner", emoji: "🎯" }),
        tm({ name: "fe-1", role: "member", lane: "fe", emoji: "🌸" }),
      ],
      null,
    );
    expect(got).toHaveLength(3);
    expect(got[0]?.name).toBe("team-lead"); // rewritten
    expect(got[1]?.name).toBe("planner");
    expect(got[2]?.name).toBe("fe-1");
  });

  test("empty roster → empty array", () => {
    expect(mapRoster([], null)).toEqual([]);
  });

  test("sidecar threaded through to every mapMember call", () => {
    const sidecar = { _byMemberName: { "fe-1": "blue" } };
    const got = mapRoster([tm({ name: "fe-1", role: "member", emoji: "🌸" })], sidecar);
    expect(got[0]?.color).toBe("blue");
  });
});

// ---------- mergeBriefs (T4 surface) ----------

describe("mergeBriefs — preserve-by-default (overwriteBriefs=false)", () => {
  test("preserves prior non-empty Claude-side role text", () => {
    const prior: ClaudeTeam = {
      members: [
        { name: "team-lead", role: "long-form hand-authored brief text…" },
        { name: "planner", role: "another hand-authored brief" },
      ],
    };
    const computed: ClaudeTeamMember[] = [
      { name: "team-lead", agentType: "team-lead", color: "white" },
      { name: "planner", color: "magenta" },
    ];
    const atmuxMembers: TeamMember[] = [
      tm({ name: "lead", role: "team-lead" }),
      tm({ name: "planner", role: "planner" }),
    ];
    const got = mergeBriefs(prior, computed, atmuxMembers, { overwriteBriefs: false });
    expect(got[0]?.role).toBe("long-form hand-authored brief text…");
    expect(got[1]?.role).toBe("another hand-authored brief");
  });

  test("seeds atmux role-enum for new members (only on atmux side, no prior match)", () => {
    const prior: ClaudeTeam = { members: [] };
    const computed: ClaudeTeamMember[] = [{ name: "fresh-be", color: "green" }];
    const atmuxMembers: TeamMember[] = [tm({ name: "fresh-be", role: "member" })];
    const got = mergeBriefs(prior, computed, atmuxMembers, { overwriteBriefs: false });
    expect(got[0]?.role).toBe("member");
  });

  test("prior===null → seeds every member's role from atmux role-enum (first-sync path)", () => {
    const computed: ClaudeTeamMember[] = [
      { name: "team-lead", agentType: "team-lead", color: "white" },
      { name: "fe-1", color: "orange" },
    ];
    const atmuxMembers: TeamMember[] = [
      tm({ name: "lead", role: "team-lead" }),
      tm({ name: "fe-1", role: "member" }),
    ];
    const got = mergeBriefs(null, computed, atmuxMembers, { overwriteBriefs: false });
    expect(got[0]?.role).toBe("team-lead");
    expect(got[1]?.role).toBe("member");
  });

  test("prior member with empty-string role falls through to atmux seed", () => {
    const prior: ClaudeTeam = { members: [{ name: "fe-1", role: "" }] };
    const computed: ClaudeTeamMember[] = [{ name: "fe-1", color: "orange" }];
    const atmuxMembers: TeamMember[] = [tm({ name: "fe-1", role: "member" })];
    const got = mergeBriefs(prior, computed, atmuxMembers, { overwriteBriefs: false });
    expect(got[0]?.role).toBe("member");
  });

  test("matches by post-rewrite Claude-side name (lead → team-lead alignment)", () => {
    const prior: ClaudeTeam = {
      members: [{ name: "team-lead", role: "preserved-brief" }],
    };
    const computed: ClaudeTeamMember[] = [
      { name: "team-lead", agentType: "team-lead", color: "white" },
    ];
    // atmux side has name="lead" but the computed roster carries the
    // post-rewrite "team-lead" name; preservation must match that.
    const atmuxMembers: TeamMember[] = [tm({ name: "lead", role: "team-lead" })];
    const got = mergeBriefs(prior, computed, atmuxMembers, { overwriteBriefs: false });
    expect(got[0]?.role).toBe("preserved-brief");
  });

  test("malformed prior member (non-string name) is skipped in the index", () => {
    const prior: ClaudeTeam = {
      members: [
        { name: 42 as unknown as string, role: "ignored" },
        { name: "", role: "also-ignored" },
      ],
    };
    const computed: ClaudeTeamMember[] = [{ name: "fe-1", color: "orange" }];
    const atmuxMembers: TeamMember[] = [tm({ name: "fe-1", role: "member" })];
    const got = mergeBriefs(prior, computed, atmuxMembers, { overwriteBriefs: false });
    // Falls through to atmux role-enum seed.
    expect(got[0]?.role).toBe("member");
  });
});

describe("mergeBriefs — overwriteBriefs=true", () => {
  test("replaces prior role with atmux role-enum", () => {
    const prior: ClaudeTeam = {
      members: [{ name: "team-lead", role: "previously-handauthored" }],
    };
    const computed: ClaudeTeamMember[] = [
      { name: "team-lead", agentType: "team-lead", color: "white" },
    ];
    const atmuxMembers: TeamMember[] = [tm({ name: "lead", role: "team-lead" })];
    const got = mergeBriefs(prior, computed, atmuxMembers, { overwriteBriefs: true });
    expect(got[0]?.role).toBe("team-lead");
  });

  test("atmux member with undefined role → leaves field undefined (NOT seeded)", () => {
    const prior: ClaudeTeam = { members: [{ name: "fe-1", role: "prior-text" }] };
    const computed: ClaudeTeamMember[] = [{ name: "fe-1", color: "orange" }];
    const atmuxMembers: TeamMember[] = [tm({ name: "fe-1" })]; // no role
    const got = mergeBriefs(prior, computed, atmuxMembers, { overwriteBriefs: true });
    // Overwrite-with-undefined branch: prior is dropped, computed has no role,
    // result has no role.
    expect(got[0]?.role).toBeUndefined();
  });

  test("atmux member with empty-string role → also leaves field undefined", () => {
    const prior: ClaudeTeam = { members: [{ name: "fe-1", role: "prior-text" }] };
    const computed: ClaudeTeamMember[] = [{ name: "fe-1", color: "orange" }];
    const atmuxMembers: TeamMember[] = [tm({ name: "fe-1", role: "" })];
    const got = mergeBriefs(prior, computed, atmuxMembers, { overwriteBriefs: true });
    expect(got[0]?.role).toBeUndefined();
  });
});

describe("mergeBriefs — degenerate inputs", () => {
  test("empty computed array → empty result regardless of prior", () => {
    const prior: ClaudeTeam = { members: [{ name: "old", role: "x" }] };
    expect(mergeBriefs(prior, [], [], { overwriteBriefs: false })).toEqual([]);
    expect(mergeBriefs(prior, [], [], { overwriteBriefs: true })).toEqual([]);
  });

  test("atmuxMembers length mismatch (shorter than computed) → atmuxMember undefined, fallback to no-role", () => {
    // Defensive: mapRoster always emits 1:1, but defend the contract anyway.
    const prior: ClaudeTeam = { members: [] };
    const computed: ClaudeTeamMember[] = [{ name: "fe-1", color: "orange" }];
    const got = mergeBriefs(prior, computed, [], { overwriteBriefs: false });
    // No prior match, no atmuxMember at index 0 → role left unset.
    expect(got[0]?.role).toBeUndefined();
  });
});
