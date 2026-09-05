// Unit tests for src/abstractions/claude-account-wrapper.ts —
// ADR-094 c-alias + ADR-167 §Decision wrapper resolver. Pure function;
// 100% branch coverage of the table + unknown-configDir refusal.

import { describe, expect, test } from "bun:test";
import {
  type ClaudeWrapper,
  knownClaudeConfigDirs,
  resolveClaudeWrapper,
} from "../../../src/abstractions/claude-account-wrapper.ts";
import { ConfigError } from "../../../src/errors.ts";

describe("resolveClaudeWrapper", () => {
  test("/root/.claude → claude (default operator account)", () => {
    expect(resolveClaudeWrapper("/root/.claude")).toBe<ClaudeWrapper>("claude");
  });

  test("/root/.claude-unum → c-u (unum account)", () => {
    expect(resolveClaudeWrapper("/root/.claude-unum")).toBe<ClaudeWrapper>("c-u");
  });

  test("/root/.claude-icloud → c-ic (icloud account)", () => {
    expect(resolveClaudeWrapper("/root/.claude-icloud")).toBe<ClaudeWrapper>("c-ic");
  });

  test("/root/.claude-ifca → c-i (retired pre-2026-09 ifca identity, resolves via dotfiles c-i alias)", () => {
    expect(resolveClaudeWrapper("/root/.claude-ifca")).toBe<ClaudeWrapper>("c-i");
  });

  test("/root/.claude-ifca2 → c-i2 (current ifca identity)", () => {
    expect(resolveClaudeWrapper("/root/.claude-ifca2")).toBe<ClaudeWrapper>("c-i2");
  });

  test("/root/.claude-gmail → c-g (atmux gmail teams)", () => {
    expect(resolveClaudeWrapper("/root/.claude-gmail")).toBe<ClaudeWrapper>("c-g");
  });

  test("unknown configDir throws ConfigError", () => {
    expect(() => resolveClaudeWrapper("/root/.claude-bogus")).toThrow(ConfigError);
  });

  test("unknown configDir error hint enumerates registered set", () => {
    let captured: ConfigError | undefined;
    try {
      resolveClaudeWrapper("/root/.claude-bogus");
    } catch (e) {
      if (e instanceof ConfigError) captured = e;
    }
    expect(captured).toBeDefined();
    const msg = captured?.message ?? "";
    // Each registered configDir must appear in the hint so operators see
    // the full registered set on refusal.
    for (const d of knownClaudeConfigDirs()) {
      expect(msg).toContain(d);
    }
  });

  test("unknown configDir error references ADR-094", () => {
    let captured: ConfigError | undefined;
    try {
      resolveClaudeWrapper("/no/such/dir");
    } catch (e) {
      if (e instanceof ConfigError) captured = e;
    }
    expect(captured?.message ?? "").toContain("ADR-094");
  });

  test("empty configDir is unknown → refuses", () => {
    expect(() => resolveClaudeWrapper("")).toThrow(ConfigError);
  });

  test("case-sensitive match (/root/.Claude is unknown)", () => {
    // The resolver is exact-string match; .Claude (capital C) is NOT the
    // default — refuse instead of fuzzy-matching, which would silently
    // route to the wrong wrapper.
    expect(() => resolveClaudeWrapper("/root/.Claude")).toThrow(ConfigError);
  });
});

describe("knownClaudeConfigDirs", () => {
  test("returns the canonical six configDirs", () => {
    const set = knownClaudeConfigDirs();
    expect(set).toContain("/root/.claude");
    expect(set).toContain("/root/.claude-unum");
    expect(set).toContain("/root/.claude-icloud");
    expect(set).toContain("/root/.claude-ifca");
    expect(set).toContain("/root/.claude-ifca2");
    expect(set).toContain("/root/.claude-gmail");
  });

  test("returns a stable-ordered array (insertion order)", () => {
    // Tests that rely on display order (doctor hint formatting) need
    // deterministic enumeration; Map preserves insertion order.
    const a = knownClaudeConfigDirs();
    const b = knownClaudeConfigDirs();
    expect(a).toEqual(b);
  });
});
