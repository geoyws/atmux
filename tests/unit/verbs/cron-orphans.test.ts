// Unit tests for src/verbs/cron-orphans.ts (ADR-083 follow-up §DEFERRED
// row 2). In-memory `CrontabIO` + injected `dirExists` — no host
// crontab is touched. Asserts JSON shape compat with bash output.

import { describe, expect, test } from "bun:test";
import type { CrontabIO } from "../../../src/abstractions/crontab.ts";
import { UsageError } from "../../../src/errors.ts";
import {
  type CronOrphansOpts,
  cronOrphans,
  parseCronOrphansArgs,
} from "../../../src/verbs/cron-orphans.ts";

const fakeIO = (body: string | null, opts: { available?: boolean } = {}): CrontabIO => ({
  read: async () => body,
  write: async () => {
    /* not invoked by this verb */
  },
  available: async () => opts.available ?? true,
});

/** t-e1247699: recording IO for `--prune` tests — captures every
 *  `write(body)` call so the test can assert post-strip content. */
const recordingIO = (
  initial: string | null,
  opts: { available?: boolean } = {},
): CrontabIO & { writes: string[]; current: () => string | null } => {
  let current = initial;
  const writes: string[] = [];
  return {
    read: async () => current,
    write: async (body: string) => {
      writes.push(body);
      current = body;
    },
    available: async () => opts.available ?? true,
    writes,
    current: () => current,
  };
};

// ---------- parseCronOrphansArgs ----------

describe("parseCronOrphansArgs", () => {
  test("no args → prune=false", () => {
    expect(parseCronOrphansArgs([])).toEqual({ prune: false });
  });

  test("unknown flag → UsageError", () => {
    expect(() => parseCronOrphansArgs(["--bogus"])).toThrow(UsageError);
  });

  test("unexpected positional arg → UsageError", () => {
    expect(() => parseCronOrphansArgs(["positional"])).toThrow(UsageError);
  });

  test("--prune → prune=true (t-e1247699)", () => {
    expect(parseCronOrphansArgs(["--prune"])).toEqual({ prune: true });
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

// ---------- cronOrphans --prune (t-e1247699) ----------

describe("cronOrphans --prune — recovery flow", () => {
  test("no orphans → no write, same JSON shape as read-only", async () => {
    const body = [
      "# >>> atmux:team=alpha — managed by atmux start; do not edit by hand",
      "*/5 * * * * ATMUX_DIR=/srv/alpha/.atmux /bin/atmux whip",
      "# <<< atmux:team=alpha",
    ].join("\n");
    const io = recordingIO(body);
    const stdoutBuf: string[] = [];
    const code = await cronOrphans(["--prune"], {
      crontab: io,
      dirExists: async () => true,
      stdout: (s) => stdoutBuf.push(s),
    });
    expect(code).toBe(0);
    expect(stdoutBuf.join("")).toBe("[]\n");
    expect(io.writes).toEqual([]);
  });

  test("one orphan → block stripped + JSON reports the pruned target", async () => {
    const body = [
      "# >>> atmux:team=ghost — managed by atmux start; do not edit by hand",
      "*/5 * * * * ATMUX_DIR=/srv/ghost/.atmux /bin/atmux whip",
      "# <<< atmux:team=ghost",
    ].join("\n");
    const io = recordingIO(body);
    const stdoutBuf: string[] = [];
    const code = await cronOrphans(["--prune"], {
      crontab: io,
      dirExists: async () => false,
      stdout: (s) => stdoutBuf.push(s),
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdoutBuf.join("").trim())).toEqual([
      { team: "ghost", atmux_dir: "/srv/ghost/.atmux" },
    ]);
    expect(io.writes.length).toBe(1);
    const after = io.current() ?? "";
    expect(after.includes("atmux:team=ghost")).toBe(false);
  });

  test("mixed orphans + live blocks → only orphan blocks removed, live blocks preserved", async () => {
    const body = [
      "# >>> atmux:team=alpha — managed by atmux start; do not edit by hand",
      "*/5 * * * * ATMUX_DIR=/srv/alpha/.atmux /bin/atmux whip",
      "# <<< atmux:team=alpha",
      "# >>> atmux:team=ghost1 — managed by atmux start; do not edit by hand",
      "*/5 * * * * ATMUX_DIR=/tmp/atmux-lifecycle-AAAAAA/.atmux /bin/atmux whip",
      "# <<< atmux:team=ghost1",
      "# >>> atmux:team=ghost2 — managed by atmux start; do not edit by hand",
      "*/5 * * * * ATMUX_DIR=/tmp/atmux-lifecycle-BBBBBB/.atmux /bin/atmux whip",
      "# <<< atmux:team=ghost2",
    ].join("\n");
    const live = new Set(["/srv/alpha/.atmux"]);
    const io = recordingIO(body);
    const stdoutBuf: string[] = [];
    await cronOrphans(["--prune"], {
      crontab: io,
      dirExists: async (p) => live.has(p),
      stdout: (s) => stdoutBuf.push(s),
    });
    expect(JSON.parse(stdoutBuf.join("").trim())).toEqual([
      { team: "ghost1", atmux_dir: "/tmp/atmux-lifecycle-AAAAAA/.atmux" },
      { team: "ghost2", atmux_dir: "/tmp/atmux-lifecycle-BBBBBB/.atmux" },
    ]);
    expect(io.writes.length).toBe(1);
    const after = io.current() ?? "";
    expect(after.includes("atmux:team=alpha")).toBe(true);
    expect(after.includes("atmux:team=ghost1")).toBe(false);
    expect(after.includes("atmux:team=ghost2")).toBe(false);
  });

  test("null crontab → no write attempted, empty JSON", async () => {
    const io = recordingIO(null);
    const stdoutBuf: string[] = [];
    await cronOrphans(["--prune"], {
      crontab: io,
      dirExists: async () => false,
      stdout: (s) => stdoutBuf.push(s),
    });
    expect(stdoutBuf.join("")).toBe("[]\n");
    expect(io.writes).toEqual([]);
  });

  test("crontab not on PATH → '[]\\n', no read attempted via dirExists, no write", async () => {
    const probedDirs: string[] = [];
    const io = recordingIO(
      [
        "# >>> atmux:team=ghost — managed by atmux start; do not edit by hand",
        "*/5 * * * * ATMUX_DIR=/srv/ghost/.atmux /bin/atmux whip",
        "# <<< atmux:team=ghost",
      ].join("\n"),
      { available: false },
    );
    const stdoutBuf: string[] = [];
    const code = await cronOrphans(["--prune"], {
      crontab: io,
      dirExists: async (p) => {
        probedDirs.push(p);
        return false;
      },
      stdout: (s) => stdoutBuf.push(s),
    });
    expect(code).toBe(0);
    expect(stdoutBuf.join("")).toBe("[]\n");
    expect(probedDirs).toEqual([]);
    expect(io.writes).toEqual([]);
  });
});

// ---------- ADR-027 rename.lock guard ----------

describe("cronOrphans — ADR-027 rename.lock guard", () => {
  test("resolveAtmuxDir → present rename.lock → emit [] + exit 0, no crontab read", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "atmux-cron-orphans-rename-"));
    try {
      const atmuxDir = join(root, ".atmux");
      await mkdir(join(atmuxDir, "state"), { recursive: true });
      await writeFile(join(atmuxDir, "state", "rename.lock"), "{}");

      let crontabReadAttempts = 0;
      const io: CrontabIO = {
        available: async () => {
          crontabReadAttempts += 1;
          return true;
        },
        read: async () => {
          crontabReadAttempts += 1;
          return "";
        },
        write: async () => {},
      };

      const stdoutBuf: string[] = [];
      const code = await cronOrphans([], {
        crontab: io,
        dirExists: async () => true,
        stdout: (s) => stdoutBuf.push(s),
        resolveAtmuxDir: async () => atmuxDir,
      });
      expect(code).toBe(0);
      expect(stdoutBuf.join("")).toBe("[]\n");
      expect(crontabReadAttempts).toBe(0); // guard short-circuited before crontab IO
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("resolveAtmuxDir returns null → guard skipped, regular scan proceeds", async () => {
    // Cockpit-wide invocation (no team cwd) — guard fails open so the
    // regular scan still runs and the .available() check is reached.
    let availableCalls = 0;
    const io: CrontabIO = {
      available: async () => {
        availableCalls += 1;
        return false; // forces early exit at the available() gate
      },
      read: async () => "",
      write: async () => {},
    };

    const stdoutBuf: string[] = [];
    const code = await cronOrphans([], {
      crontab: io,
      stdout: (s) => stdoutBuf.push(s),
      resolveAtmuxDir: async () => null,
    });
    expect(code).toBe(0);
    expect(stdoutBuf.join("")).toBe("[]\n");
    expect(availableCalls).toBe(1); // guard didn't short-circuit
  });

  test("resolveAtmuxDir returns path WITHOUT rename.lock → regular scan proceeds", async () => {
    const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "atmux-cron-orphans-norename-"));
    try {
      const atmuxDir = join(root, ".atmux");
      await mkdir(join(atmuxDir, "state"), { recursive: true });
      // No rename.lock written.

      let availableCalls = 0;
      const io: CrontabIO = {
        available: async () => {
          availableCalls += 1;
          return false;
        },
        read: async () => "",
        write: async () => {},
      };

      const stdoutBuf: string[] = [];
      const code = await cronOrphans([], {
        crontab: io,
        stdout: (s) => stdoutBuf.push(s),
        resolveAtmuxDir: async () => atmuxDir,
      });
      expect(code).toBe(0);
      expect(stdoutBuf.join("")).toBe("[]\n");
      expect(availableCalls).toBe(1); // guard didn't fire (no lock)
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
