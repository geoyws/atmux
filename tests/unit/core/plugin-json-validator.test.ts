// Unit tests for src/core/plugin-json-validator.ts (ADR-217 §D8 +
// t-dcf4f970 — covers the 5 cases in the Task body verbatim).

import { describe, expect, test } from "bun:test";
import { validatePluginJson } from "../../../src/core/plugin-json-validator.ts";

describe("validatePluginJson — Task t-dcf4f970 acceptance cases", () => {
  // ---- Case 1: Valid plugin.json (ADR-217 §D8 shape) → validator returns OK
  test("Case 1: valid ADR-217 §D8 manifest → ok true with skillCount", () => {
    const result = validatePluginJson({
      name: "atmux",
      version: "0.1.0",
      description: "Atmux skills — cockpit-tier workflows",
      atmuxCompat: ">=0.8.10",
      skills: [
        { name: "team", path: "skills/team/SKILL.md" },
        { name: "session", path: "skills/session/SKILL.md" },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.skillCount).toBe(2);
      expect("warning" in result).toBe(false);
    }
  });

  test("Case 1b: real plugins/atmux/.claude-plugin/plugin.json shape (12 skills) → ok true", () => {
    const result = validatePluginJson({
      name: "atmux",
      version: "0.1.0",
      description: "Atmux skills bundle",
      atmuxCompat: ">=0.8.10",
      skills: [
        { name: "team", path: "skills/team/SKILL.md" },
        { name: "session", path: "skills/session/SKILL.md" },
        { name: "tell-lead", path: "skills/tell-lead/SKILL.md" },
        { name: "heads-up", path: "skills/heads-up/SKILL.md" },
        { name: "bruh", path: "skills/bruh/SKILL.md" },
        { name: "bruhloop", path: "skills/bruhloop/SKILL.md" },
        { name: "whip", path: "skills/whip/SKILL.md" },
        { name: "bau", path: "skills/bau/SKILL.md" },
        { name: "ghostbuster", path: "skills/ghostbuster/SKILL.md" },
        { name: "budget", path: "skills/budget/SKILL.md" },
        { name: "sweep", path: "skills/sweep/SKILL.md" },
        { name: "cockpit-rebuild", path: "skills/cockpit-rebuild/SKILL.md" },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.skillCount).toBe(12);
  });

  // ---- Case 2: Missing required field (name/version/description/skills) → error with field name
  test("Case 2a: missing name → ok false with field name", () => {
    const result = validatePluginJson({
      version: "0.1.0",
      description: "no name",
      skills: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("name");
  });

  test("Case 2b: missing version → ok false with field name", () => {
    const result = validatePluginJson({
      name: "x",
      description: "no version",
      skills: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("version");
  });

  test("Case 2c: missing description → ok false with field name", () => {
    const result = validatePluginJson({
      name: "x",
      version: "0.0.1",
      skills: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("description");
  });

  test("Case 2d: missing skills → ok false with field name", () => {
    const result = validatePluginJson({
      name: "x",
      version: "0.0.1",
      description: "no skills key",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("skills");
  });

  test("Case 2e: empty string name → treated as missing", () => {
    const result = validatePluginJson({
      name: "",
      version: "0.0.1",
      description: "blank name",
      skills: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("name");
  });

  test("Case 2f: empty string version → treated as missing", () => {
    const result = validatePluginJson({
      name: "x",
      version: "",
      description: "blank version",
      skills: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("version");
  });

  // ---- Case 3: Wrong type (skills as string instead of array) → error
  test("Case 3a: skills as string → ok false 'not an array'", () => {
    const result = validatePluginJson({
      name: "x",
      version: "0.0.1",
      description: "wrong skills type",
      skills: "not-an-array",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not an array");
  });

  test("Case 3b: skills as object → ok false 'not an array'", () => {
    const result = validatePluginJson({
      name: "x",
      version: "0.0.1",
      description: "skills as object",
      skills: { foo: "bar" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not an array");
  });

  test("Case 3c: name as number → ok false (missing string)", () => {
    const result = validatePluginJson({
      name: 42,
      version: "0.0.1",
      description: "wrong name type",
      skills: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("name");
  });

  // ---- Case 4: Skills entry missing name/path → error
  test("Case 4a: skills entry missing name → ok false with index + 'name'", () => {
    const result = validatePluginJson({
      name: "x",
      version: "0.0.1",
      description: "skill missing name",
      skills: [{ path: "skills/orphan/SKILL.md" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("skills[0]");
      expect(result.error).toContain("name");
    }
  });

  test("Case 4b: skills entry missing path → ok false with index + 'path'", () => {
    const result = validatePluginJson({
      name: "x",
      version: "0.0.1",
      description: "skill missing path",
      skills: [{ name: "orphan" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("skills[0]");
      expect(result.error).toContain("path");
    }
  });

  test("Case 4c: second skill entry malformed → error names the index", () => {
    const result = validatePluginJson({
      name: "x",
      version: "0.0.1",
      description: "second skill broken",
      skills: [
        { name: "good", path: "skills/good/SKILL.md" },
        { name: "bad" },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("skills[1]");
  });

  test("Case 4d: null skill entry → ok false 'not an object'", () => {
    const result = validatePluginJson({
      name: "x",
      version: "0.0.1",
      description: "null skill",
      skills: [null],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not an object");
  });

  // ---- Case 5: Empty skills array → WARNING (not error)
  test("Case 5: empty skills array → ok true with warning channel populated", () => {
    const result = validatePluginJson({
      name: "x",
      version: "0.0.1",
      description: "no skills declared",
      skills: [],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect("warning" in result).toBe(true);
      if ("warning" in result) expect(result.warning).toMatch(/empty/i);
      expect(result.skillCount).toBe(0);
    }
  });

  // ---- Defensive cases (non-AC, structural)
  test("non-object input (null) → ok false 'not an object'", () => {
    const result = validatePluginJson(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not an object");
  });

  test("non-object input (array) → ok false 'not an object'", () => {
    const result = validatePluginJson([1, 2, 3]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not an object");
  });

  test("non-object input (string) → ok false 'not an object'", () => {
    const result = validatePluginJson("plugin.json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not an object");
  });

  test("additional properties beyond ADR-217 §D8 do not break validation", () => {
    const result = validatePluginJson({
      name: "x",
      version: "0.0.1",
      description: "extra fields OK",
      skills: [{ name: "s", path: "p" }],
      author: { name: "operator" },
      homepage: "https://example.com",
      keywords: ["a", "b"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.skillCount).toBe(1);
  });
});
