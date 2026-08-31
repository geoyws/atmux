// Unit tests for src/abstractions/crontab.ts (ADR-233 retired no-op shim).

import { describe, expect, test } from "bun:test";
import type { CrontabIO } from "../../../src/abstractions/crontab.ts";
import { defaultCrontabIO } from "../../../src/abstractions/crontab.ts";
import { installCockpitCronBlock } from "../../../src/core/cron.ts";

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

describe("installCockpitCronBlock", () => {
  test("resolves without touching crontab IO", async () => {
    let availableCalls = 0;
    let readCalls = 0;
    let writeCalls = 0;
    const io: CrontabIO = {
      async available() {
        availableCalls += 1;
        return true;
      },
      async read() {
        readCalls += 1;
        return "body";
      },
      async write(_body) {
        writeCalls += 1;
      },
    };

    await expect(installCockpitCronBlock({ io })).resolves.toBeUndefined();
    expect(availableCalls).toBe(0);
    expect(readCalls).toBe(0);
    expect(writeCalls).toBe(0);
  });
});
