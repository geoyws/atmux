// Unit tests for src/core/sync-claude-team-json/color-map.ts (ADR-164 T3
// surface — t-312fe824, asserted under T7 t-4329b053).
//
// Pure function: resolveColor(memberName, emoji, sidecar) → string.
// Resolution-order assertions cover all four bands per ADR-164
// §"Color mapping":
//   1. sidecar._byMemberName (highest priority)
//   2. sidecar top-level emoji
//   3. built-in fixed table
//   4. deterministic FNV-1a-seeded pool fallback (member.name seed)

import { describe, expect, test } from "bun:test";
import { resolveColor } from "../../../../src/core/sync-claude-team-json/color-map.ts";
import type { ColorSidecar } from "../../../../src/core/sync-claude-team-json/types.ts";

describe("resolveColor — priority order", () => {
  test("sidecar._byMemberName wins over every other source", () => {
    const sidecar: ColorSidecar = {
      _byMemberName: { alice: "blue" },
      "🌸": "red", // top-level emoji override that would otherwise hit
    };
    // emoji "🌸" is in the fixed table as `orange`, sidecar top-level
    // would re-paint it `red`; _byMemberName beats both → `blue`.
    expect(resolveColor("alice", "🌸", sidecar)).toBe("blue");
  });

  test("sidecar top-level emoji wins over the built-in fixed table", () => {
    const sidecar: ColorSidecar = { "🔍": "blue" };
    // Fixed table maps 🔍 → cyan; sidecar overrides to blue.
    expect(resolveColor("reviewer", "🔍", sidecar)).toBe("blue");
  });

  test("built-in fixed table hits when sidecar absent", () => {
    expect(resolveColor("any", "🔍", null)).toBe("cyan");
    expect(resolveColor("any", "🌸", null)).toBe("orange");
    expect(resolveColor("any", "📦", null)).toBe("green");
    expect(resolveColor("any", "⚖️", null)).toBe("red");
    expect(resolveColor("any", "🦦", null)).toBe("yellow");
    expect(resolveColor("any", "🎯", null)).toBe("magenta");
  });

  test("unknown emoji + no sidecar → deterministic pool fallback (seed = member.name)", () => {
    const first = resolveColor("alice", "🤖", null);
    const second = resolveColor("alice", "🤖", null);
    // Same input → same output (FNV-1a deterministic).
    expect(first).toBe(second);
    // Output is a member of the COLOR_POOL — `white` is excluded by design.
    expect(["red", "orange", "yellow", "green", "cyan", "blue", "magenta"]).toContain(first);
    expect(first).not.toBe("white");
  });

  test("pool fallback differs across different member names (high probability)", () => {
    // FNV-1a + a 7-element pool means collisions exist, but a spread of
    // typical member names should hit at least two distinct colors.
    const colors = new Set<string>();
    for (const n of ["alice", "bob", "carol", "dave", "eve", "frank", "grace", "heidi"]) {
      colors.add(resolveColor(n, "🤖", null));
    }
    expect(colors.size).toBeGreaterThan(1);
  });
});

describe("resolveColor — degenerate inputs", () => {
  test("emoji undefined → seeded pool fallback (no fixed-table lookup attempted)", () => {
    const got = resolveColor("alice", undefined, null);
    expect(["red", "orange", "yellow", "green", "cyan", "blue", "magenta"]).toContain(got);
  });

  test("emoji empty string → seeded pool fallback (treated as no emoji)", () => {
    const got = resolveColor("alice", "", null);
    expect(["red", "orange", "yellow", "green", "cyan", "blue", "magenta"]).toContain(got);
  });

  test("sidecar with empty _byMemberName entry falls through to next band", () => {
    const sidecar: ColorSidecar = { _byMemberName: { alice: "" } };
    // Empty string is falsy; resolution falls through to fixed-table lookup
    // on emoji "🔍" → cyan.
    expect(resolveColor("alice", "🔍", sidecar)).toBe("cyan");
  });

  test("sidecar with non-string emoji value falls through to fixed table", () => {
    // Operator extension: a sidecar with `_byMemberName` populated but
    // top-level emoji set to a Record (not the documented shape) MUST
    // be tolerated — resolveColor's `typeof === string` guard ensures
    // the malformed entry doesn't crash and resolution falls through.
    const sidecar: ColorSidecar = {
      _byMemberName: {},
      "🌸": { nested: "shape" } as unknown as string,
    };
    expect(resolveColor("alice", "🌸", sidecar)).toBe("orange");
  });

  test("by-name override applies even when emoji is undefined", () => {
    const sidecar: ColorSidecar = { _byMemberName: { alice: "magenta" } };
    expect(resolveColor("alice", undefined, sidecar)).toBe("magenta");
  });
});

describe("resolveColor — fixed table band membership", () => {
  // Pin every glyph the built-in table promises. Drift here surfaces as
  // a failing test rather than a silent re-paint.
  test("coordinator band → white", () => {
    expect(resolveColor("x", "🧭", null)).toBe("white");
    expect(resolveColor("x", "⚙️", null)).toBe("white");
    expect(resolveColor("x", "🛠️", null)).toBe("white");
  });
  test("planner band → magenta", () => {
    expect(resolveColor("x", "🎯", null)).toBe("magenta");
    expect(resolveColor("x", "🦊", null)).toBe("magenta");
    expect(resolveColor("x", "🐺", null)).toBe("magenta");
  });
  test("reviewer band → cyan", () => {
    expect(resolveColor("x", "🔍", null)).toBe("cyan");
    expect(resolveColor("x", "🦉", null)).toBe("cyan");
    expect(resolveColor("x", "👁️", null)).toBe("cyan");
  });
  test("BE-impl band → green", () => {
    expect(resolveColor("x", "📦", null)).toBe("green");
    expect(resolveColor("x", "🦔", null)).toBe("green");
    expect(resolveColor("x", "🦫", null)).toBe("green");
  });
  test("FE-impl band → orange", () => {
    expect(resolveColor("x", "🌸", null)).toBe("orange");
    expect(resolveColor("x", "🌷", null)).toBe("orange");
    expect(resolveColor("x", "🎨", null)).toBe("orange");
  });
  test("docs band → yellow", () => {
    expect(resolveColor("x", "🦦", null)).toBe("yellow");
    expect(resolveColor("x", "📚", null)).toBe("yellow");
    expect(resolveColor("x", "📝", null)).toBe("yellow");
  });
  test("gitter/committer band → green", () => {
    expect(resolveColor("x", "🌿", null)).toBe("green");
    expect(resolveColor("x", "🌱", null)).toBe("green");
    expect(resolveColor("x", "🍃", null)).toBe("green");
  });
  test("ombudsman/enforcer band → red", () => {
    expect(resolveColor("x", "⚖️", null)).toBe("red");
    expect(resolveColor("x", "👮", null)).toBe("red");
  });
});
