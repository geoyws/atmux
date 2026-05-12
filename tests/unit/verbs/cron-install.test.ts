// Unit tests for src/verbs/cron-install.ts (ADR-083 §IN §3).
//
// Strategy: drive the verb with a `--team-dir` flag against a per-test
// mktemp dir + seed team.json, inject a `CrontabIO` fake to capture the
// install body without touching the host crontab, pin `resolveBin` to a
// deterministic path. The verb's NON-FATAL posture (warn + exit 0) is
// exercised by deliberately broken fakes — make sure no path raises.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CrontabIO } from "../../../src/abstractions/crontab.ts";
import { UsageError } from "../../../src/errors.ts";
import {
  cronInstall,
  type CronInstallOpts,
  parseCronInstallArgs,
} from "../../../src/verbs/cron-install.ts";

// ---------- parseCronInstallArgs ----------

describe("parseCronInstallArgs", () => {
  test("no args → defaults (quiet=false, no teamDir)", () => {
    expect(parseCronInstallArgs([])).toEqual({ quiet: false });
  });

  test("--quiet → quiet=true", () => {
    expect(parseCronInstallArgs(["--quiet"])).toEqual({ quiet: true });
  });

  test("--team-dir <dir> captured", () => {
    expect(parseCronInstallArgs(["--team-dir", "/srv/demo"])).toEqual({
      quiet: false,
      teamDir: "/srv/demo",
    });
  });

  test("--quiet + --team-dir combined", () => {
    expect(parseCronInstallArgs(["--quiet", "--team-dir", "/x"])).toEqual({
      quiet: true,
      teamDir: "/x",
    });
  });

  test("--team-dir without value → UsageError", () => {
    expect(() => parseCronInstallArgs(["--team-dir"])).toThrow(UsageError);
  });

  test("unknown flag → UsageError", () => {
    expect(() => parseCronInstallArgs(["--bogus"])).toThrow(UsageError);
  });

  test("unexpected positional arg → UsageError", () => {
    expect(() => parseCronInstallArgs(["positional"])).toThrow(UsageError);
  });
});

// ---------- cronInstall (verb) ----------

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

describe("cronInstall — happy path", () => {
  let scratch: string;
  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "atmux-cron-install-"));
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

  test("fresh install on empty crontab → writes a block + env preamble", async () => {
    const { io, captured } = makeFakeCrontab(null);
    const stderrBuf: string[] = [];
    const stdoutBuf: string[] = [];
    const opts: CronInstallOpts = {
      crontab: io,
      resolveBin: () => "/usr/local/bin/atmux",
      env: {},
      stderr: (s) => stderrBuf.push(s),
      stdout: (s) => stdoutBuf.push(s),
    };
    const code = await cronInstall(["--team-dir", scratch], opts);
    expect(code).toBe(0);
    expect(captured.writes.length).toBe(1);
    const body = captured.writes[0] ?? "";
    expect(body.includes("# >>> atmux:team=demo")).toBe(true);
    expect(body.includes("TERM=xterm-256color")).toBe(true);
    expect(body.includes("ATMUX_DIR=")).toBe(true);
    expect(body.includes("/usr/local/bin/atmux whip")).toBe(true);
    expect(stdoutBuf.join("").includes("installed cron block for team 'demo'")).toBe(true);
    expect(stderrBuf.join("")).toBe("");
  });

  test("--quiet suppresses the success stdout line (kept stderr-clean)", async () => {
    const { io } = makeFakeCrontab(null);
    const stderrBuf: string[] = [];
    const stdoutBuf: string[] = [];
    await cronInstall(["--quiet", "--team-dir", scratch], {
      crontab: io,
      resolveBin: () => "/usr/local/bin/atmux",
      env: {},
      stderr: (s) => stderrBuf.push(s),
      stdout: (s) => stdoutBuf.push(s),
    });
    expect(stdoutBuf.join("")).toBe("");
    expect(stderrBuf.join("")).toBe("");
  });

  test("idempotent re-install: second run produces byte-identical body", async () => {
    let storage: string | null = null;
    const io: CrontabIO = {
      read: async () => storage,
      write: async (body) => {
        storage = body;
      },
      available: async () => true,
    };
    const opts: CronInstallOpts = {
      crontab: io,
      resolveBin: () => "/usr/local/bin/atmux",
      env: {},
      stderr: () => {},
      stdout: () => {},
    };
    await cronInstall(["--team-dir", scratch], opts);
    const first = storage;
    await cronInstall(["--team-dir", scratch], opts);
    expect(storage).toBe(first);
  });
});

describe("cronInstall — non-fatal skip paths", () => {
  let scratch: string;
  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "atmux-cron-install-skip-"));
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

  test("ATMUX_NO_CRON=1 → silent no-op, no crontab read or write", async () => {
    const { io, captured } = makeFakeCrontab(null);
    const stderrBuf: string[] = [];
    const code = await cronInstall(["--team-dir", scratch], {
      crontab: io,
      resolveBin: () => "/usr/local/bin/atmux",
      env: { ATMUX_NO_CRON: "1" },
      stderr: (s) => stderrBuf.push(s),
      stdout: () => {},
    });
    expect(code).toBe(0);
    expect(captured.reads).toBe(0);
    expect(captured.writes.length).toBe(0);
    expect(stderrBuf.join("")).toBe("");
  });

  test("ATMUX_NO_CRON=1 + ATMUX_DEBUG → emits the debug-only warning to stderr", async () => {
    const { io } = makeFakeCrontab(null);
    const stderrBuf: string[] = [];
    await cronInstall(["--team-dir", scratch], {
      crontab: io,
      resolveBin: () => "/usr/local/bin/atmux",
      env: { ATMUX_NO_CRON: "1", ATMUX_DEBUG: "1" },
      stderr: (s) => stderrBuf.push(s),
      stdout: () => {},
    });
    expect(stderrBuf.join("").includes("ATMUX_NO_CRON")).toBe(true);
  });

  test("ATMUX_NO_CRON=0 (falsy) → install proceeds normally", async () => {
    const { io, captured } = makeFakeCrontab(null);
    await cronInstall(["--team-dir", scratch], {
      crontab: io,
      resolveBin: () => "/usr/local/bin/atmux",
      env: { ATMUX_NO_CRON: "0" },
      stderr: () => {},
      stdout: () => {},
    });
    expect(captured.writes.length).toBe(1);
  });

  test("crontab unavailable → warn to stderr, exit 0, no write", async () => {
    const { io, captured } = makeFakeCrontab(null, { available: false });
    const stderrBuf: string[] = [];
    const code = await cronInstall(["--team-dir", scratch], {
      crontab: io,
      resolveBin: () => "/usr/local/bin/atmux",
      env: {},
      stderr: (s) => stderrBuf.push(s),
      stdout: () => {},
    });
    expect(code).toBe(0);
    expect(captured.writes.length).toBe(0);
    expect(stderrBuf.join("").includes("crontab not on PATH")).toBe(true);
  });

  test("resolveBin returns null → warn to stderr, exit 0, no write", async () => {
    const { io, captured } = makeFakeCrontab(null);
    const stderrBuf: string[] = [];
    const code = await cronInstall(["--team-dir", scratch], {
      crontab: io,
      resolveBin: () => null,
      env: {},
      stderr: (s) => stderrBuf.push(s),
      stdout: () => {},
    });
    expect(code).toBe(0);
    expect(captured.writes.length).toBe(0);
    expect(stderrBuf.join("").includes("cannot resolve atmux binary path")).toBe(true);
  });

  test("write throws → warn to stderr, exit 0 (non-fatal)", async () => {
    const { io } = makeFakeCrontab(null, { writeError: new Error("crontab: no permission") });
    const stderrBuf: string[] = [];
    const code = await cronInstall(["--team-dir", scratch], {
      crontab: io,
      resolveBin: () => "/usr/local/bin/atmux",
      env: {},
      stderr: (s) => stderrBuf.push(s),
      stdout: () => {},
    });
    expect(code).toBe(0);
    expect(stderrBuf.join("").includes("crontab swap failed")).toBe(true);
    expect(stderrBuf.join("").includes("no permission")).toBe(true);
  });
});

describe("cronInstall — strip-and-replace semantics", () => {
  let scratch: string;
  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "atmux-cron-install-strip-"));
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

  test("existing block for same team → replaced, not duplicated", async () => {
    const stale = [
      "# >>> atmux:team=demo — managed by atmux start; do not edit by hand",
      "*/5 * * * * ATMUX_DIR=/srv/demo/.atmux /old/atmux whip",
      "# <<< atmux:team=demo",
    ].join("\n");
    const { io, captured } = makeFakeCrontab(stale);
    await cronInstall(["--team-dir", scratch], {
      crontab: io,
      resolveBin: () => "/usr/local/bin/atmux",
      env: {},
      stderr: () => {},
      stdout: () => {},
    });
    const body = captured.writes[0] ?? "";
    // /old/atmux is gone, /usr/local/bin/atmux is present, exactly one block.
    expect(body.includes("/old/atmux")).toBe(false);
    expect(body.includes("/usr/local/bin/atmux")).toBe(true);
    const headerCount = body.split("# >>> atmux:team=demo").length - 1;
    expect(headerCount).toBe(1);
  });

  test("foreign team's block is preserved", async () => {
    const existing = [
      "# >>> atmux:team=other — managed by atmux start; do not edit by hand",
      "*/5 * * * * ATMUX_DIR=/srv/other/.atmux /usr/local/bin/atmux whip",
      "# <<< atmux:team=other",
    ].join("\n");
    const { io, captured } = makeFakeCrontab(existing);
    await cronInstall(["--team-dir", scratch], {
      crontab: io,
      resolveBin: () => "/usr/local/bin/atmux",
      env: {},
      stderr: () => {},
      stdout: () => {},
    });
    const body = captured.writes[0] ?? "";
    expect(body.includes("# >>> atmux:team=other")).toBe(true);
    expect(body.includes("# >>> atmux:team=demo")).toBe(true);
  });
});
