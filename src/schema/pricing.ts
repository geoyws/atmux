// ADR-005 + ADR-003: Zod schema for the cost-tracking pricing map.
//
// Mirrors `lib/pricing.json` from the bash atmux source — USD per million
// tokens for input / output / cache-write / cache-read, keyed by Claude
// model id with a `default` fallback for unknown models.
//
// Resolution at runtime (`src/verbs/cost.ts::loadPricing`):
//   1. `$ATMUX_PRICING_FILE` if set + readable → parse + validate via this schema.
//   2. Otherwise the inline `DEFAULT_PRICING` constant — the bun port's
//      bundled fallback equivalent to bash's `$ATMUX_ROOT/lib/pricing.json`.
//
// Permissive (`.passthrough()`) so operator-authored override files can
// add new model ids without losing them on parse. The `default` entry is
// REQUIRED — `cost.ts` falls back to it when a model id is missing from
// the map.

import { z } from "zod";

/** Per-model pricing — USD per million tokens for each token class. */
export const PricingEntry = z
  .object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cacheWrite: z.number().nonnegative(),
    cacheRead: z.number().nonnegative(),
  })
  .passthrough();
export type PricingEntry = z.infer<typeof PricingEntry>;

/** Top-level pricing map. `default` is required so any unknown model
 *  has a fallback; bash `_atmux_cost_claude` does the same `$pr.default`
 *  lookup. Other keys are model-id strings holding `PricingEntry` shapes.
 *  `.passthrough()` so operator-authored override files can include
 *  annotation keys (`_comment`, etc.) without losing validation; the
 *  per-model lookup in `pricingFor` does shape-checking for unknown keys
 *  rather than the schema, since `_comment`-typed values are strings. */
export const Pricing = z
  .object({
    default: PricingEntry,
  })
  .passthrough();
export type Pricing = z.infer<typeof Pricing>;

/** Bundled defaults — matches `lib/pricing.json` at HEAD `2aadc3f`. USD
 *  per MILLION tokens. Override per-deployment by setting
 *  `$ATMUX_PRICING_FILE` to a path holding a JSON file matching `Pricing`. */
export const DEFAULT_PRICING: Pricing = {
  "claude-opus-4-7": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-opus-4-6": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 1.0, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  default: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
};

/** Resolve a per-model pricing entry, falling back to `default` when
 *  the model id isn't in the map. Pure helper — `cost.ts` uses this in
 *  the per-block math loop. */
export function pricingFor(map: Pricing, model: string | undefined | null): PricingEntry {
  if (model !== undefined && model !== null) {
    const entry = (map as Record<string, unknown>)[model];
    if (entry !== undefined && typeof entry === "object" && entry !== null && "input" in entry) {
      return entry as PricingEntry;
    }
  }
  return map.default;
}
