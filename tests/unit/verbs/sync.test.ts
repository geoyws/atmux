// Unit tests for src/verbs/sync.ts (ADR-164 T2 — t-a890648c).
//
// T2 scope is dispatcher-only — bare invocation, unknown sub-verb, and
// the stubbed `claude-team-json` route. T3-T6 add the real core mapping
// + flag-parse surface, and T7 will layer the integrated round-trip
// asserts on top. The cases here lock in:
//
//   1. bare `sync` → UsageError listing known sub-verbs
//   2. unknown sub-verb → UsageError naming the bad sub-verb + list
//   3. `claude-team-json` → stub Error (T3 swaps with real impl);
//      proves the dispatcher routes to it rather than treating it as
//      unknown.

import { describe, expect, test } from "bun:test";
import { UsageError } from "../../../src/errors.ts";
import { dispatchSyncSubverb } from "../../../src/verbs/sync.ts";

describe("dispatchSyncSubverb", () => {
  test("missing subverb throws UsageError listing known sub-verbs", async () => {
    await expect(dispatchSyncSubverb([])).rejects.toThrow(UsageError);
    await expect(dispatchSyncSubverb([])).rejects.toThrow(/claude-team-json/);
  });

  test("empty-string subverb throws UsageError (matches bare invocation)", async () => {
    await expect(dispatchSyncSubverb([""])).rejects.toThrow(UsageError);
  });

  test("unknown subverb throws UsageError naming the bad subverb + list", async () => {
    await expect(dispatchSyncSubverb(["frobnicate"])).rejects.toThrow(UsageError);
    await expect(dispatchSyncSubverb(["frobnicate"])).rejects.toThrow(
      /unknown subverb 'frobnicate'/,
    );
    await expect(dispatchSyncSubverb(["frobnicate"])).rejects.toThrow(/claude-team-json/);
  });

  test("claude-team-json routes to stub (T3 replaces with real impl)", async () => {
    // T2 stub throws plain Error with the "not yet implemented" marker.
    // Asserting the message proves the dispatcher routed correctly —
    // an unknown-subverb path would surface UsageError instead.
    await expect(dispatchSyncSubverb(["claude-team-json"])).rejects.toThrow(
      /not yet implemented.*T3-T6.*ADR-164/,
    );
  });

  test("claude-team-json with trailing args still routes (flag-parse is T3+)", async () => {
    await expect(
      dispatchSyncSubverb(["claude-team-json", "--dry-run", "--overwrite-briefs"]),
    ).rejects.toThrow(/not yet implemented/);
  });
});
