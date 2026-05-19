// Unit tests for src/core/sync-claude-team-json/name-rewrite.ts (ADR-164 T3
// surface — t-312fe824, asserted under T7 t-4329b053).
//
// Pure function: rewriteClaudeName(atmuxName, atmuxRole) → string.
// Unconditional `team-lead` rewrite when role === "team-lead" per
// ADR-164 §"Name rewrite" + §OQ-2; pass-through otherwise.

import { describe, expect, test } from "bun:test";
import { rewriteClaudeName } from "../../../../src/core/sync-claude-team-json/name-rewrite.ts";

describe("rewriteClaudeName", () => {
  test("role === 'team-lead' → 'team-lead' regardless of atmux name", () => {
    expect(rewriteClaudeName("lead", "team-lead")).toBe("team-lead");
    expect(rewriteClaudeName("alice", "team-lead")).toBe("team-lead");
    expect(rewriteClaudeName("_lead", "team-lead")).toBe("team-lead");
  });

  test("non-lead role → name verbatim", () => {
    expect(rewriteClaudeName("planner", "planner")).toBe("planner");
    expect(rewriteClaudeName("fe-1", "member")).toBe("fe-1");
    expect(rewriteClaudeName("be-2", "committer")).toBe("be-2");
    expect(rewriteClaudeName("reviewer", "reviewer")).toBe("reviewer");
  });

  test("role undefined → name verbatim", () => {
    expect(rewriteClaudeName("planner", undefined)).toBe("planner");
    expect(rewriteClaudeName("ad-hoc", undefined)).toBe("ad-hoc");
  });

  test("legacy bare role 'lead' (not yet zod-coerced) is NOT rewritten — function trusts post-transform input", () => {
    // The Zod transform on TeamMember.role rewrites legacy `gitter` →
    // `committer`, but `lead` itself is NOT coerced upstream — the
    // atmux-side convention is `role: "team-lead"` for the lead member.
    // This test pins the no-coerce contract: callers MUST pass the
    // post-transform role; a stray `"lead"` will pass through unchanged.
    expect(rewriteClaudeName("lead", "lead")).toBe("lead");
  });

  test("empty string name + team-lead role → still rewritten", () => {
    expect(rewriteClaudeName("", "team-lead")).toBe("team-lead");
  });
});
