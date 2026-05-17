// Unit tests for src/abstractions/member-roles.ts —
// ADR-161 §Decision-anchor #1 closed-set of default member roles.

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MEMBER_ROLES,
  isDefaultMemberRole,
} from "../../../src/abstractions/member-roles.ts";

describe("DEFAULT_MEMBER_ROLES constant", () => {
  test("contains the 4 ADR-161 default roles (committer/gitter pending ADR-159 rename)", () => {
    expect(DEFAULT_MEMBER_ROLES).toEqual(["team-lead", "planner", "reviewer", "ombudsman"]);
  });

  test("is readonly tuple of length 4", () => {
    expect(DEFAULT_MEMBER_ROLES.length).toBe(4);
  });
});

describe("isDefaultMemberRole", () => {
  test("returns true for every literal in DEFAULT_MEMBER_ROLES", () => {
    for (const role of DEFAULT_MEMBER_ROLES) {
      expect(isDefaultMemberRole(role)).toBe(true);
    }
  });

  test("returns false for 'member' (user-added role)", () => {
    expect(isDefaultMemberRole("member")).toBe(false);
  });

  test("returns false for legacy 'gitter' (pending ADR-159 rename)", () => {
    expect(isDefaultMemberRole("gitter")).toBe(false);
  });

  test("returns false for unrelated string", () => {
    expect(isDefaultMemberRole("driver")).toBe(false);
    expect(isDefaultMemberRole("manager")).toBe(false);
    expect(isDefaultMemberRole("")).toBe(false);
  });

  test("returns false for undefined", () => {
    expect(isDefaultMemberRole(undefined)).toBe(false);
  });

  test("narrows type for default role literals (compile-time)", () => {
    const role = "planner";
    if (isDefaultMemberRole(role)) {
      // TypeScript narrows `role` to `DefaultMemberRole` here.
      const narrowed: "team-lead" | "planner" | "reviewer" | "ombudsman" = role;
      expect(narrowed).toBe("planner");
    } else {
      throw new Error("expected isDefaultMemberRole(planner) to narrow");
    }
  });
});
