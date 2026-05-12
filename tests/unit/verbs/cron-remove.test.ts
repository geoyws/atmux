// Unit tests for src/verbs/cron-remove.ts (ADR-083 follow-up §1).
// Mirrors the cron-install.test.ts test shape — in-memory CrontabIO
// fake, env injection, deterministic resolveBin. Confirms bash parity
// for the strip + idempotence + non-fatal posture.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CrontabIO } from "../../../src/abstractions/crontab.ts";
import { UsageError } from "../../../src/errors.ts";
import {
  cronRemove,
  type CronRemoveOpts,
  parseCronRemoveArgs,
} from "../../../src/verbs/cron-remove.ts";

// ---------- parseCronRemoveArgs ----------

describe("parseCronRemoveArgs", () => {
  test("no args → defaults (quiet=false, no teamDir)", () => {
    expect(parseCronRemoveArgs([])).toEqual({ quiet: false });
  });

  test("--quiet → quiet=true", () => {
    expect(parseCronRemoveArgs(["--quiet"])).toEqual({ quiet: true });
  });

  test("--team-dir <dir> captured", () => {
    expect(parseCronRemoveArgs(["--team-dir", "/srv/demo"])).toEqual({
      quiet: false,
      teamDir: "/srv/demo",
    });
  });

  test("--quiet + --team-dir combined", () => {
    expect(parseCronRemoveArgs(["--quiet", "--team-dir", "/x"])).toEqual({
      quiet: true,
      teamDir: "/x",
    });
  });

  test("--team-dir without value → UsageError", () => {
    expect(() => parseCronRemoveArgs(["--team-dir"])).toThrow(UsageError);
  });

  test("unknown flag → UsageError", () => {
    expect(() => parseCronRemoveArgs(["--bogus"])).toThrow(UsageError);
  });

  test("unexpected positional arg → UsageError", () => {
    expect(() => parseCronRemoveArgs(["positional"])).toThrow(UsageError);
  });
});

// ---------- cronRemove (verb) ----------

interface CapturedIO {
  reads: number;
  writes: string[];
  available: boolean;
}

function makeFakeCrontab(
  initial: string | null,
  opts: { available?: boolean; writeError?: Error } = {},
): { io: CrontabIO; captured: CapturedIO } {
  const captured: CapturedIO = {
    reads: 0,
    writes: [],
    available: opts.available ?? true,
  };
  const io: CrontabIO = {
    read: async () => {
      captured.reads += 1;
      return initial;
    },
    write: async (body) => {
      if (opts.writeError !== undefined) throw opts.writeError;
      captured.writes.push(body);
    },
    available: async () => captured.available,
  };
  return { io, captured };
}

describe("cronRemove — happy path", () => {
  let scratch: string;
  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "atmux-cron-remove-"));
    const atmuxDir = join(scratch, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({ name: "demo", members: [] }),
    );
  });
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test("crontab contains the team's block → block is stripped + write fires", async () => {
    const before = [
      "# unrelated",
      "# >>> atmux:team=demo — managed by atmux start; do not edit by hand",
      "*/5 * * * * /usr/local/bin/atmux whip",
      "# <<< atmux:team=demo",
      "# trailing",
    ].join("\n");
    const { io, captured } = makeFakeCrontab(before);
    const stdoutBuf: string[] = [];
    const stderrBuf: string[] = [];
    const opts: CronRemoveOpts = {
      crontab: io,
      env: {},
      stderr: (s) => stderrBuf.push(s),
      stdout: (s) => stdoutBuf.push(s),
    };
    const code = await cronRemove(["--team-dir", scratch], opts);
    expect(code).toBe(0);
    expect(captured.writes.length).toBe(1);
    const after = captured.writes[0] ?? "";
    expect(after.includes("atmux:team=demo")).toBe(false);
    expect(after.includes("# unrelated")).toBe(true);
    expect(after.includes("# trailing")).toBe(true);
    expect(stdoutBuf.join("").includes("removed cron block for team 'demo'")).toBe(true);
    expect(stderrBuf.join("")).toBe("");
  });

  test("--quiet suppresses the success stdout line", async () => {
    const before = [
      "# >>> atmux:team=demo — managed by atmux start; do not edit by hand",
      "*/5 * * * * /usr/local/bin/atmux whip",
      "# <<< atmux:team=demo",
    ].join("\n");
    const { io } = makeFakeCrontab(before);
    const stdoutBuf: string[] = [];
    await cronRemove(["--quiet", "--team-dir", scratch], {
      crontab: io,
      env: {},
      stderr: () => {},
      stdout: (s) => stdoutBuf.push(s),
    });
    expect(stdoutBuf.join("")).toBe("");
  });

  test("foreign team's block survives untouched", async () => {
    const before = [
      "# >>> atmux:team=demo — managed by atmux start; do not edit by hand",
      "*/5 * * * * ATMUX_DIR=/srv/demo/.atmux /bin/atmux whip",
      "# <<< atmux:team=demo",
      "# >>> atmux:team=other — managed by atmux start; do not edit by hand",
      "*/5 * * * * ATMUX_DIR=/srv/other/.atmux /bin/atmux whip",
      "# <<< atmux:team=other",
    ].join("\n");
    const { io, captured } = makeFakeCrontab(before);
    await cronRemove(["--team-dir", scratch], {
      crontab: io,
      env: {},
      stderr: () => {},
      stdout: () => {},
    });
    const after = captured.writes[0] ?? "";
    expect(after.includes("atmux:team=demo")).toBe(false);
    expect(after.includes("atmux:team=other")).toBe(true);
    expect(after.includes("/srv/other/.atmux")).toBe(true);
  });
});

describe("cronRemove — idempotent / silent no-op paths", () => {
  let scratch: string;
  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "atmux-cron-remove-noop-"));
    const atmuxDir = join(scratch, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({ name: "demo", members: [] }),
    );
  });
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test("crontab has no atmux block → no write, no stdout", async () => {
    const before = "# user content\nMAILTO=ops@example.com\n";
    const { io, captured } = makeFakeCrontab(before);
    const stdoutBuf: string[] = [];
    const stderrBuf: string[] = [];
    const code = await cronRemove(["--team-dir", scratch], {
      crontab: io,
      env: {},
      stderr: (s) => stderrBuf.push(s),
      stdout: (s) => stdoutBuf.push(s),
    });
    expect(code).toBe(0);
    expect(captured.writes.length).toBe(0);
    expect(stdoutBuf.join("")).toBe("");
    expect(stderrBuf.join("")).toBe("");
  });

  test("crontab is empty → no write", async () => {
    const { io, captured } = makeFakeCrontab("");
    await cronRemove(["--team-dir", scratch], {
      crontab: io,
      env: {},
      stderr: () => {},
      stdout: () => {},
    });
    expect(captured.writes.length).toBe(0);
  });

  test("crontab is null (no crontab installed) → no write", async () => {
    const { io, captured } = makeFakeCrontab(null);
    await cronRemove(["--team-dir", scratch], {
      crontab: io,
      env: {},
      stderr: () => {},
      stdout: () => {},
    });
    expect(captured.writes.length).toBe(0);
  });

  test("idempotent: re-remove after first remove is a silent no-op", async () => {
    let storage: string | null = [
      "# >>> atmux:team=demo — managed by atmux start; do not edit by hand",
      "*/5 * * * * /usr/local/bin/atmux whip",
      "# <<< atmux:team=demo",
    ].join("\n");
    const io: CrontabIO = {
      read: async () => storage,
      write: async (b) => {
        storage = b;
      },
      available: async () => true,
    };
    const opts: CronRemoveOpts = {
      crontab: io,
      env: {},
      stderr: () => {},
      stdout: () => {},
    };
    await cronRemove(["--team-dir", scratch], opts); // first remove: strips.
    const afterFirst = storage;
    await cronRemove(["--team-dir", scratch], opts); // second: no-op.
    expect(storage).toBe(afterFirst);
  });
});

describe("cronRemove — non-fatal skip paths", () => {
  let scratch: string;
  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "atmux-cron-remove-skip-"));
    const atmuxDir = join(scratch, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({ name: "demo", members: [] }),
    );
  });
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test("ATMUX_NO_CRON=1 → silent no-op, no read or write", async () => {
    const { io, captured } = makeFakeCrontab("# >>> atmux:team=demo\nbody\n# <<< atmux:team=demo");
    const stderrBuf: string[] = [];
    const code = await cronRemove(["--team-dir", scratch], {
      crontab: io,
      env: { ATMUX_NO_CRON: "1" },
      stderr: (s) => stderrBuf.push(s),
      stdout: () => {},
    });
    expect(code).toBe(0);
    expect(captured.reads).toBe(0);
    expect(captured.writes.length).toBe(0);
    expect(stderrBuf.join("")).toBe("");
  });

  test("ATMUX_NO_CRON=1 + ATMUX_DEBUG → emits debug-only warning", async () => {
    const { io } = makeFakeCrontab(null);
    const stderrBuf: string[] = [];
    await cronRemove(["--team-dir", scratch], {
      crontab: io,
      env: { ATMUX_NO_CRON: "1", ATMUX_DEBUG: "1" },
      stderr: (s) => stderrBuf.push(s),
      stdout: () => {},
    });
    expect(stderrBuf.join("").includes("ATMUX_NO_CRON")).toBe(true);
  });

  test("ATMUX_NO_CRON=0 (falsy) → remove proceeds normally", async () => {
    const before = [
      "# >>> atmux:team=demo — managed by atmux start; do not edit by hand",
      "*/5 * * * * /usr/local/bin/atmux whip",
      "# <<< atmux:team=demo",
    ].join("\n");
    const { io, captured } = makeFakeCrontab(before);
    await cronRemove(["--team-dir", scratch], {
      crontab: io,
      env: { ATMUX_NO_CRON: "0" },
      stderr: () => {},
      stdout: () => {},
    });
    expect(captured.writes.length).toBe(1);
  });

  test("crontab unavailable → silent exit 0 (matches bash 'return 0 without warn')", async () => {
    const { io, captured } = makeFakeCrontab("# >>> atmux:team=demo\nx\n# <<< atmux:team=demo", {
      available: false,
    });
    const stderrBuf: string[] = [];
    const code = await cronRemove(["--team-dir", scratch], {
      crontab: io,
      env: {},
      stderr: (s) => stderrBuf.push(s),
      stdout: () => {},
    });
    expect(code).toBe(0);
    expect(captured.writes.length).toBe(0);
    // Bash returns 0 silently here — no fix to apply on a cronless
    // host. We match that posture (no stderr noise).
    expect(stderrBuf.join("")).toBe("");
  });

  test("write throws → warn to stderr, exit 0 (non-fatal)", async () => {
    const before = [
      "# >>> atmux:team=demo — managed by atmux start; do not edit by hand",
      "*/5 * * * * /usr/local/bin/atmux whip",
      "# <<< atmux:team=demo",
    ].join("\n");
    const { io } = makeFakeCrontab(before, {
      writeError: new Error("crontab: permission denied"),
    });
    const stderrBuf: string[] = [];
    const code = await cronRemove(["--team-dir", scratch], {
      crontab: io,
      env: {},
      stderr: (s) => stderrBuf.push(s),
      stdout: () => {},
    });
    expect(code).toBe(0);
    expect(stderrBuf.join("").includes("crontab swap failed")).toBe(true);
    expect(stderrBuf.join("").includes("permission denied")).toBe(true);
  });
});
