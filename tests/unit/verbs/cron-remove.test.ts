// Unit tests for src/verbs/cron-remove.ts.
// No-op shim retained for stop() compatibility after ADR-233.

import { describe, expect, test } from "bun:test";
import { cronRemove } from "../../../src/verbs/cron-remove.ts";

describe("verbs/cron-remove", () => {
  test("returns 0 with default options", async () => {
    await expect(cronRemove()).resolves.toBe(0);
  });

  test("returns 0 with explicit options", async () => {
    await expect(
      cronRemove({
        teamDir: "/tmp/atmux-cron-remove",
        quiet: true,
        team: "alpha",
      }),
    ).resolves.toBe(0);
  });
});
