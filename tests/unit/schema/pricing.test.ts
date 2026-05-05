// Unit tests for src/schema/pricing.ts (ADR-005, V-22 cost-tracking).
//
// Coverage map:
//   - PricingEntry: minimal valid shape, rejects negative numbers
//   - Pricing: requires `default`, accepts arbitrary model keys via passthrough
//   - DEFAULT_PRICING: shape parity with lib/pricing.json
//   - pricingFor: model-found, model-missing, null/undefined/garbage model

import { describe, expect, test } from "bun:test";
import { DEFAULT_PRICING, Pricing, PricingEntry, pricingFor } from "../../../src/schema/pricing.ts";

// ---------- PricingEntry ----------

describe("PricingEntry", () => {
  test("parses a minimal valid shape", () => {
    expect(PricingEntry.parse({ input: 1, output: 2, cacheWrite: 3, cacheRead: 4 })).toEqual({
      input: 1,
      output: 2,
      cacheWrite: 3,
      cacheRead: 4,
    });
  });

  test("rejects negative numbers", () => {
    expect(() =>
      PricingEntry.parse({ input: -1, output: 0, cacheWrite: 0, cacheRead: 0 }),
    ).toThrow();
  });

  test("passthrough preserves unknown keys", () => {
    const got = PricingEntry.parse({
      input: 1,
      output: 2,
      cacheWrite: 3,
      cacheRead: 4,
      _comment: "demo",
    });
    expect((got as Record<string, unknown>)._comment).toBe("demo");
  });
});

// ---------- Pricing ----------

describe("Pricing", () => {
  test("requires default entry; rejects when missing", () => {
    expect(() => Pricing.parse({})).toThrow();
  });

  test("accepts default-only", () => {
    const got = Pricing.parse({
      default: { input: 1, output: 1, cacheWrite: 1, cacheRead: 1 },
    });
    expect(got.default.input).toBe(1);
  });

  test("passthrough preserves model entries + annotation strings", () => {
    const got = Pricing.parse({
      default: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
      "claude-opus-4-7": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
      _comment: "USD per million tokens",
    });
    expect((got as Record<string, unknown>)["claude-opus-4-7"]).toBeDefined();
    expect((got as Record<string, unknown>)._comment).toBe("USD per million tokens");
  });
});

// ---------- DEFAULT_PRICING ----------

describe("DEFAULT_PRICING", () => {
  test("validates against the Pricing schema", () => {
    expect(() => Pricing.parse(DEFAULT_PRICING)).not.toThrow();
  });

  test("contains the model ids shipped in lib/pricing.json", () => {
    expect(DEFAULT_PRICING["claude-opus-4-7"]).toBeDefined();
    expect(DEFAULT_PRICING["claude-opus-4-6"]).toBeDefined();
    expect(DEFAULT_PRICING["claude-sonnet-4-6"]).toBeDefined();
    expect(DEFAULT_PRICING["claude-sonnet-4-5"]).toBeDefined();
    expect(DEFAULT_PRICING["claude-haiku-4-5"]).toBeDefined();
    expect(DEFAULT_PRICING.default).toBeDefined();
  });

  test("opus 4.7 priced at the published $15 / $75 / $18.75 / $1.5 per million", () => {
    expect(DEFAULT_PRICING["claude-opus-4-7"]).toEqual({
      input: 15,
      output: 75,
      cacheWrite: 18.75,
      cacheRead: 1.5,
    });
  });
});

// ---------- pricingFor ----------

describe("pricingFor", () => {
  test("returns the model entry when present", () => {
    expect(pricingFor(DEFAULT_PRICING, "claude-opus-4-7")).toBe(
      DEFAULT_PRICING["claude-opus-4-7"] as PricingEntry,
    );
  });

  test("falls back to default when model id is unknown", () => {
    expect(pricingFor(DEFAULT_PRICING, "non-existent-model")).toBe(DEFAULT_PRICING.default);
  });

  test("falls back to default for null model", () => {
    expect(pricingFor(DEFAULT_PRICING, null)).toBe(DEFAULT_PRICING.default);
  });

  test("falls back to default for undefined model", () => {
    expect(pricingFor(DEFAULT_PRICING, undefined)).toBe(DEFAULT_PRICING.default);
  });

  test("falls back to default when key value isn't a PricingEntry shape", () => {
    // Pricing.passthrough lets weird shapes through; pricingFor's runtime
    // shape-check on `"input" in entry` rejects them and uses default.
    const map = {
      ...DEFAULT_PRICING,
      "weird-model": "annotation string, not an entry",
    } as unknown as Pricing;
    expect(pricingFor(map, "weird-model")).toBe(DEFAULT_PRICING.default);
  });
});
