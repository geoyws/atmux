// Unit tests for src/abstractions/crontab.ts (ADR-233 retired no-op shim).

import { describe, expect, test } from "bun:test";
import { defaultCrontabIO } from "../../../src/abstractions/crontab.ts";

describe("defaultCrontabIO", () => {
  test("reports unavailable", async () => {
    const io = defaultCrontabIO();
    await expect(io.available()).resolves.toBe(false);
  });

  test("reads as null", async () => {
    const io = defaultCrontabIO();
    await expect(io.read()).resolves.toBeNull();
  });

  test("write() resolves for a non-empty body", async () => {
    const io = defaultCrontabIO();
    await expect(io.write("* * * * * echo noop")).resolves.toBeUndefined();
  });
});
