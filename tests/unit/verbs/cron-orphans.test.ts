// Unit tests for src/verbs/cron-orphans.ts (ADR-083 follow-up §DEFERRED
// row 2). In-memory `CrontabIO` + injected `dirExists` — no host
// crontab is touched. Asserts JSON shape compat with bash output.

import { describe, expect, test } from "bun:test";
import type { CrontabIO } from "../../../src/abstractions/crontab.ts";
import { UsageError } from "../../../src/errors.ts";
import {
  cronOrphans,
  type CronOrphansOpts,
  parseCronOrphansArgs,
} from "../../../src/verbs/cron-orphans.ts";

const fakeIO = (
  body: string | null,
  opts: { available?: boolean } = {},
): CrontabIO => ({
  read: async () => body,
  write: async () => {
    /* not invoked by this verb */
  },
  available: async () => opts.available ?? true,
});

// ---------- parseCronOrphansArgs ----------

describe("parseCronOrphansArgs", () => {
  test("no args → ok (returns void)", () => {
    expect(() => parseCronOrphansArgs([])).not.toThrow();
  });

  test("unknown flag → UsageError", () => {
    expect(() => parseCronOrphansArgs(["--bogus"])).toThrow(UsageError);
  });

  test("unexpected positional arg → UsageError", () => {
    expect(() => parseCronOrphansArgs(["positional"])).toThrow(UsageError);
  });
});

// ---------- cronOrphans (verb) ----------

describe("cronOrphans — JSON output", () => {
  const runVerb = async (
    body: string | null,
    dirExists: (p: string) => boolean,
    overrides: Partial<CronOrphansOpts> = {},
  ): Promise<{ code: number; stdout: string }> => {
    const stdoutBuf: string[] = [];
    const opts: CronOrphansOpts = {
      crontab: fakeIO(body),
      dirExists: async (p: string) => dirExists(p),
      stdout: (s: string) => stdoutBuf.push(s),
      ...overrides,
    };
    const code = await cronOrphans([], opts);
    return { code, stdout: stdoutBuf.join("") };
  };

  test("null crontab → '[]\\n' + exit 0", async () => {
    const { code, stdout } = await runVerb(null, () => true);
    expect(code).toBe(0);
    expect(stdout).toBe("[]\n");
  });

  test("empty crontab → '[]\\n' + exit 0", async () => {
    const { code, stdout } = await runVerb("", () => true);
    expect(code).toBe(0);
    expect(stdout).toBe("[]\n");
  });

  test("all blocks live → '[]\\n'", async () => {
    const body = [
      "# >>> atmux:team=alpha — managed by atmux start; do not edit by hand",
      "*/5 * * * * ATMUX_DIR=/srv/alpha/.atmux /bin/atmux whip",
      "# <<< atmux:team=alpha",
    ].join("\n");
    const { code, stdout } = await runVerb(body, () => true);
    expect(code).toBe(0);
    expect(stdout).toBe("[]\n");
  });

  test("one orphan → snake_case JSON (bash compat)", async () => {
    const body = [
      "# >>> atmux:team=ghost — managed by atmux start; do not edit by hand",
      "*/5 * * * * ATMUX_DIR=/srv/ghost/.atmux /bin/atmux whip",
      "# <<< atmux:team=ghost",
    ].join("\n");
    const { code, stdout } = await runVerb(body, () => false);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    // snake_case `atmux_dir` per bash JSON shape — external consumers
    // (cockpit aggregators) rely on this key name.
    expect(parsed).toEqual([{ team: "ghost", atmux_dir: "/srv/ghost/.atmux" }]);
  });

  test("two orphans + one live → only orphans returned", async () => {
    const body = [
      "# >>> atmux:team=alpha — managed by atmux start; do not edit by hand",
      "*/5 * * * * ATMUX_DIR=/srv/alpha/.atmux /bin/atmux whip",
      "# <<< atmux:team=alpha",
      "# >>> atmux:team=beta — managed by atmux start; do not edit by hand",
      "*/5 * * * * ATMUX_DIR=/srv/beta/.atmux /bin/atmux whip",
      "# <<< atmux:team=beta",
      "# >>> atmux:team=gamma — managed by atmux start; do not edit by hand",
      "*/5 * * * * ATMUX_DIR=/srv/gamma/.atmux /bin/atmux whip",
      "# <<< atmux:team=gamma",
    ].join("\n");
    const live = new Set(["/srv/beta/.atmux"]);
    const { stdout } = await runVerb(body, (p: string) => live.has(p));
    const parsed = JSON.parse(stdout.trim());
    expect(parsed).toEqual([
      { team: "alpha", atmux_dir: "/srv/alpha/.atmux" },
      { team: "gamma", atmux_dir: "/srv/gamma/.atmux" },
    ]);
  });
});

describe("cronOrphans — non-fatal posture", () => {
  test("crontab not on PATH → '[]\\n' + exit 0 (no orphan scan)", async () => {
    const probedDirs: string[] = [];
    const code = await cronOrphans([], {
      crontab: fakeIO(
        // body irrelevant — `available()` gate fires first
        [
          "# >>> atmux:team=ghost — managed by atmux start; do not edit by hand",
          "*/5 * * * * ATMUX_DIR=/srv/ghost/.atmux /bin/atmux whip",
          "# <<< atmux:team=ghost",
        ].join("\n"),
        { available: false },
      ),
      dirExists: async (p: string) => {
        probedDirs.push(p);
        return false;
      },
      stdout: () => {
        /* discard */
      },
    });
    expect(code).toBe(0);
    expect(probedDirs).toEqual([]);
  });

  test("unknown flag → throws UsageError (caller maps to exit code)", async () => {
    await expect(
      cronOrphans(["--bogus"], { crontab: fakeIO(null), stdout: () => {} }),
    ).rejects.toThrow(UsageError);
  });
});
