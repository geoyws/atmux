// Unit tests for src/verbs/sync.ts (ADR-164 T2 base + T4 flag-parse).
//
// Original T2 scope (t-a890648c) was dispatcher-only. T4 (t-87e81c8e)
// added --overwrite-briefs flag parsing + unknown-flag refusal; the
// tests below reflect the post-T4 contract. T5 + T6 will swap the stub
// for the real write path and add --force / --dry-run; T7 layers the
// integrated round-trip asserts.

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

  test("claude-team-json routes to stub (T5-T6 replace with real impl)", async () => {
    // The stub throws plain Error with the "not yet implemented" marker.
    // Asserting the message proves the dispatcher routed correctly —
    // an unknown-subverb path would surface UsageError instead.
    await expect(dispatchSyncSubverb(["claude-team-json"])).rejects.toThrow(
      /not yet implemented.*T5-T6.*ADR-164/,
    );
  });

  test("claude-team-json --overwrite-briefs parses + routes (T4 flag-parse)", async () => {
    // T4 (t-87e81c8e) adds --overwrite-briefs parsing. The flag is parsed
    // and discarded; the stub still throws not-yet-implemented because T5
    // (drift) + T6 (write/dry-run wiring) ship the dispatcher body.
    await expect(
      dispatchSyncSubverb(["claude-team-json", "--overwrite-briefs"]),
    ).rejects.toThrow(/not yet implemented/);
  });

  test("claude-team-json unknown flag throws UsageError (T4 flag-parse)", async () => {
    // --dry-run is T6 work; today it's an unknown flag and the parser
    // refuses with UsageError rather than swallowing it silently. Locks
    // in the typo-protection promise of the flag-parse surface.
    await expect(
      dispatchSyncSubverb(["claude-team-json", "--dry-run"]),
    ).rejects.toThrow(UsageError);
    await expect(
      dispatchSyncSubverb(["claude-team-json", "--dry-run"]),
    ).rejects.toThrow(/unknown flag.*--dry-run/);
  });

  test("claude-team-json refuses positional args (T4 flag-parse)", async () => {
    await expect(
      dispatchSyncSubverb(["claude-team-json", "stray-positional"]),
    ).rejects.toThrow(UsageError);
    await expect(
      dispatchSyncSubverb(["claude-team-json", "stray-positional"]),
    ).rejects.toThrow(/unexpected positional/);
  });
});
