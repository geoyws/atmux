// Unit tests for src/verbs/cron-install.ts (ADR-083 §IN §3).
//
// Strategy: drive the verb with a `--team-dir` flag against a per-test
// mktemp dir + seed team.json, inject a `CrontabIO` fake to capture the
// install body without touching the host crontab, pin `resolveBin` to a
// deterministic path. The verb's NON-FATAL posture (warn + exit 0) is
// exercised by deliberately broken fakes — make sure no path raises.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CrontabIO } from "../../../src/abstractions/crontab.ts";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import {
  CRON_INSTALL_TEMPLATES,
  type CronInstallOpts,
  cronInstall,
  parseCronInstallArgs,
  parseIntervalToMins,
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

// ---------- ADR-088 W7 (t-2f12839e) — --template + --interval ----------

describe("parseCronInstallArgs — --template / --interval", () => {
  test("--template merge-cycle captured", () => {
    const a = parseCronInstallArgs(["--template", "merge-cycle"]);
    expect(a.template).toBe("merge-cycle");
  });

  test("--template with unknown value → UsageError", () => {
    expect(() => parseCronInstallArgs(["--template", "bogus"])).toThrow(UsageError);
  });

  test("--template without value → UsageError", () => {
    expect(() => parseCronInstallArgs(["--template"])).toThrow(UsageError);
  });

  test("--interval 15m + --template merge-cycle captured (15 minutes)", () => {
    const a = parseCronInstallArgs(["--template", "merge-cycle", "--interval", "15m"]);
    expect(a.intervalMins).toBe(15);
  });

  test("--interval 1h → 60 minutes", () => {
    const a = parseCronInstallArgs(["--template", "merge-cycle", "--interval", "1h"]);
    expect(a.intervalMins).toBe(60);
  });

  test("--interval 5m → 5 minutes", () => {
    const a = parseCronInstallArgs(["--template", "merge-cycle", "--interval", "5m"]);
    expect(a.intervalMins).toBe(5);
  });

  test("--interval without --template merge-cycle → UsageError", () => {
    expect(() => parseCronInstallArgs(["--interval", "15m"])).toThrow(UsageError);
  });

  test("--interval missing value → UsageError", () => {
    expect(() => parseCronInstallArgs(["--template", "merge-cycle", "--interval"])).toThrow(
      UsageError,
    );
  });

  test("--interval with no unit → UsageError", () => {
    expect(() => parseCronInstallArgs(["--template", "merge-cycle", "--interval", "15"])).toThrow(
      UsageError,
    );
  });

  test("--interval 0m / negative / non-numeric → UsageError", () => {
    expect(() => parseCronInstallArgs(["--template", "merge-cycle", "--interval", "0m"])).toThrow(
      UsageError,
    );
    expect(() => parseCronInstallArgs(["--template", "merge-cycle", "--interval", "-5m"])).toThrow(
      UsageError,
    );
    expect(() => parseCronInstallArgs(["--template", "merge-cycle", "--interval", "abcm"])).toThrow(
      UsageError,
    );
  });

  test("CRON_INSTALL_TEMPLATES allowlist exports merge-cycle + ombudsman-tick + lane-stall-watch + gitter-sweep + epic-merge (ADR-091 §State machine added)", () => {
    expect(CRON_INSTALL_TEMPLATES).toEqual([
      "merge-cycle",
      "ombudsman-tick",
      "lane-stall-watch",
      "gitter-sweep",
      "epic-merge",
    ]);
  });
});

describe("parseIntervalToMins", () => {
  test("Nm shape parses minutes verbatim", () => {
    expect(parseIntervalToMins("15m")).toBe(15);
    expect(parseIntervalToMins("1m")).toBe(1);
    expect(parseIntervalToMins("60m")).toBe(60);
  });

  test("Nh shape multiplies into minutes", () => {
    expect(parseIntervalToMins("1h")).toBe(60);
    expect(parseIntervalToMins("2h")).toBe(120);
  });

  test("rejects bare numbers (no unit)", () => {
    expect(() => parseIntervalToMins("15")).toThrow(UsageError);
  });

  test("rejects 0 / negative", () => {
    expect(() => parseIntervalToMins("0m")).toThrow(UsageError);
    expect(() => parseIntervalToMins("-1m")).toThrow(UsageError);
    expect(() => parseIntervalToMins("0h")).toThrow(UsageError);
  });

  test("rejects garbage", () => {
    expect(() => parseIntervalToMins("abcm")).toThrow(UsageError);
    expect(() => parseIntervalToMins("xh")).toThrow(UsageError);
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
    await writeFile(join(atmuxDir, "team.json"), JSON.stringify({ name: "demo", members: [] }));
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
    await writeFile(join(atmuxDir, "team.json"), JSON.stringify({ name: "demo", members: [] }));
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
    await writeFile(join(atmuxDir, "team.json"), JSON.stringify({ name: "demo", members: [] }));
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

// ---------- ADR-088 W7 (t-2f12839e) — merge-cycle template integration ----------

describe("cronInstall — --template merge-cycle integration", () => {
  let scratch: string;
  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "atmux-cron-tmpl-"));
    const atmuxDir = join(scratch, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  async function seedTeam(merger?: Record<string, unknown>): Promise<void> {
    const cfg: Record<string, unknown> = { name: "demo", members: [] };
    if (merger !== undefined) cfg.merger = merger;
    await writeFile(join(scratch, ".atmux", "team.json"), JSON.stringify(cfg));
  }

  test("--template merge-cycle + merger.enabled=true → block includes merge-cycle line", async () => {
    await seedTeam({ enabled: true });
    const { io, captured } = makeFakeCrontab(null);
    const opts: CronInstallOpts = {
      crontab: io,
      resolveBin: () => "/usr/local/bin/atmux",
      env: {},
      stderr: () => {},
      stdout: () => {},
    };
    const rc = await cronInstall(["--template", "merge-cycle", "--team-dir", scratch], opts);
    expect(rc).toBe(0);
    const body = captured.writes[0] ?? "";
    // Default cadence is 15 minutes → `*/15`
    expect(body).toMatch(/\*\/15 \* \* \* \* .*atmux merge-cycle --push >> .*\/merge-cycle\.log/);
  });

  test("--template merge-cycle + merger.enabled=false → ConfigError (helpful)", async () => {
    await seedTeam({ enabled: false });
    const { io } = makeFakeCrontab(null);
    await expect(
      cronInstall(["--template", "merge-cycle", "--team-dir", scratch], {
        crontab: io,
        resolveBin: () => "/usr/local/bin/atmux",
        env: {},
        stderr: () => {},
        stdout: () => {},
      }),
    ).rejects.toThrow(ConfigError);
  });

  test("--template merge-cycle + no merger config at all → ConfigError", async () => {
    await seedTeam(); // no merger field
    const { io } = makeFakeCrontab(null);
    await expect(
      cronInstall(["--template", "merge-cycle", "--team-dir", scratch], {
        crontab: io,
        resolveBin: () => "/usr/local/bin/atmux",
        env: {},
        stderr: () => {},
        stdout: () => {},
      }),
    ).rejects.toThrow(/requires team\.merger\.enabled = true/);
  });

  test("--interval 5m overrides default 15min cadence in the rendered line", async () => {
    await seedTeam({ enabled: true });
    const { io, captured } = makeFakeCrontab(null);
    const rc = await cronInstall(
      ["--template", "merge-cycle", "--interval", "5m", "--team-dir", scratch],
      {
        crontab: io,
        resolveBin: () => "/usr/local/bin/atmux",
        env: {},
        stderr: () => {},
        stdout: () => {},
      },
    );
    expect(rc).toBe(0);
    const body = captured.writes[0] ?? "";
    expect(body).toMatch(/\*\/5 \* \* \* \* .*atmux merge-cycle --push/);
  });

  test("--interval 1h overrides cadence to hourly", async () => {
    await seedTeam({ enabled: true });
    const { io, captured } = makeFakeCrontab(null);
    await cronInstall(["--template", "merge-cycle", "--interval", "1h", "--team-dir", scratch], {
      crontab: io,
      resolveBin: () => "/usr/local/bin/atmux",
      env: {},
      stderr: () => {},
      stdout: () => {},
    });
    const body = captured.writes[0] ?? "";
    // 60min == hourly, rendered as "0 * * * *"
    expect(body).toMatch(/0 \* \* \* \* .*atmux merge-cycle --push/);
  });

  test("team.merger.cycleIntervalMins=30 honored when --interval omitted", async () => {
    await seedTeam({ enabled: true, cycleIntervalMins: 30 });
    const { io, captured } = makeFakeCrontab(null);
    await cronInstall(["--team-dir", scratch], {
      crontab: io,
      resolveBin: () => "/usr/local/bin/atmux",
      env: {},
      stderr: () => {},
      stdout: () => {},
    });
    const body = captured.writes[0] ?? "";
    expect(body).toMatch(/\*\/30 \* \* \* \* .*atmux merge-cycle --push/);
  });

  test("bare cron-install (no --template) on merger.enabled=true team STILL emits merge-cycle line", async () => {
    // The merge-cycle line is gated on team.merger.enabled, NOT on the
    // --template flag. The flag is the operator-facing "I want this
    // template" assertion; the schema config is what actually drives
    // the rendered line.
    await seedTeam({ enabled: true });
    const { io, captured } = makeFakeCrontab(null);
    await cronInstall(["--team-dir", scratch], {
      crontab: io,
      resolveBin: () => "/usr/local/bin/atmux",
      env: {},
      stderr: () => {},
      stdout: () => {},
    });
    const body = captured.writes[0] ?? "";
    expect(body).toMatch(/atmux merge-cycle --push/);
  });

  test("merger.enabled=false → block does NOT include merge-cycle line", async () => {
    await seedTeam({ enabled: false });
    const { io, captured } = makeFakeCrontab(null);
    await cronInstall(["--team-dir", scratch], {
      crontab: io,
      resolveBin: () => "/usr/local/bin/atmux",
      env: {},
      stderr: () => {},
      stdout: () => {},
    });
    const body = captured.writes[0] ?? "";
    expect(body).not.toContain("atmux merge-cycle");
  });

  test("idempotent re-install with --template merge-cycle → second write byte-identical", async () => {
    await seedTeam({ enabled: true });
    const { io: io1, captured: cap1 } = makeFakeCrontab(null);
    await cronInstall(["--template", "merge-cycle", "--team-dir", scratch], {
      crontab: io1,
      resolveBin: () => "/usr/local/bin/atmux",
      env: {},
      stderr: () => {},
      stdout: () => {},
    });
    const firstBody = cap1.writes[0] ?? "";
    const { io: io2, captured: cap2 } = makeFakeCrontab(firstBody);
    await cronInstall(["--template", "merge-cycle", "--team-dir", scratch], {
      crontab: io2,
      resolveBin: () => "/usr/local/bin/atmux",
      env: {},
      stderr: () => {},
      stdout: () => {},
    });
    expect(cap2.writes[0]).toBe(firstBody);
  });
});

// ---------- ADR-147 T3: --template ombudsman-tick integration ----------

describe("cronInstall — --template ombudsman-tick integration (ADR-147 T3)", () => {
  let scratch: string;
  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "atmux-cron-omb-"));
    const atmuxDir = join(scratch, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  async function seedTeam(opts: {
    ombudsman?: Record<string, unknown>;
    withOmbudsmanMember?: boolean;
  }): Promise<void> {
    const members: Array<Record<string, unknown>> = [];
    if (opts.withOmbudsmanMember === true) {
      members.push({ name: "ombuds", role: "ombudsman" });
    }
    const cfg: Record<string, unknown> = { name: "demo", members };
    if (opts.ombudsman !== undefined) cfg.ombudsman = opts.ombudsman;
    await writeFile(join(scratch, ".atmux", "team.json"), JSON.stringify(cfg));
  }

  test("--template ombudsman-tick + enabled=true + member role=ombudsman → emits tick line", async () => {
    await seedTeam({
      ombudsman: { enabled: true },
      withOmbudsmanMember: true,
    });
    const { io, captured } = makeFakeCrontab(null);
    const rc = await cronInstall(["--template", "ombudsman-tick", "--team-dir", scratch], {
      crontab: io,
      resolveBin: () => "/usr/local/bin/atmux",
      env: {},
      stderr: () => {},
      stdout: () => {},
    });
    expect(rc).toBe(0);
    const body = captured.writes[0] ?? "";
    // Default 15min cadence → `*/15 * * * *`
    expect(body).toMatch(/\*\/15 \* \* \* \* .*atmux ombudsman tick >> .*\/ombudsman\.log/);
  });

  test("--template ombudsman-tick + enabled=false → ConfigError", async () => {
    await seedTeam({ ombudsman: { enabled: false }, withOmbudsmanMember: true });
    const { io } = makeFakeCrontab(null);
    await expect(
      cronInstall(["--template", "ombudsman-tick", "--team-dir", scratch], {
        crontab: io,
        resolveBin: () => "/usr/local/bin/atmux",
        env: {},
        stderr: () => {},
        stdout: () => {},
      }),
    ).rejects.toThrow(ConfigError);
  });

  test("--template ombudsman-tick + no ombudsman block at all → ConfigError with hint", async () => {
    await seedTeam({});
    const { io } = makeFakeCrontab(null);
    await expect(
      cronInstall(["--template", "ombudsman-tick", "--team-dir", scratch], {
        crontab: io,
        resolveBin: () => "/usr/local/bin/atmux",
        env: {},
        stderr: () => {},
        stdout: () => {},
      }),
    ).rejects.toThrow(/requires team\.ombudsman\.enabled = true/);
  });

  test("--interval 5m overrides default 15min cadence in the rendered line", async () => {
    await seedTeam({
      ombudsman: { enabled: true },
      withOmbudsmanMember: true,
    });
    const { io, captured } = makeFakeCrontab(null);
    const rc = await cronInstall(
      ["--template", "ombudsman-tick", "--interval", "5m", "--team-dir", scratch],
      {
        crontab: io,
        resolveBin: () => "/usr/local/bin/atmux",
        env: {},
        stderr: () => {},
        stdout: () => {},
      },
    );
    expect(rc).toBe(0);
    const body = captured.writes[0] ?? "";
    expect(body).toMatch(/\*\/5 \* \* \* \* .*atmux ombudsman tick/);
  });

  test("--interval transient: team.json on disk is not mutated", async () => {
    await seedTeam({
      ombudsman: { enabled: true },
      withOmbudsmanMember: true,
    });
    const teamJsonPath = join(scratch, ".atmux", "team.json");
    const before = await readFile(teamJsonPath, "utf-8");
    const { io } = makeFakeCrontab(null);
    await cronInstall(["--template", "ombudsman-tick", "--interval", "5m", "--team-dir", scratch], {
      crontab: io,
      resolveBin: () => "/usr/local/bin/atmux",
      env: {},
      stderr: () => {},
      stdout: () => {},
    });
    const after = await readFile(teamJsonPath, "utf-8");
    expect(after).toBe(before);
  });

  test("team.ombudsman.tickIntervalMins=30 honored when --interval omitted", async () => {
    await seedTeam({
      ombudsman: { enabled: true, tickIntervalMins: 30 },
      withOmbudsmanMember: true,
    });
    const { io, captured } = makeFakeCrontab(null);
    await cronInstall(["--team-dir", scratch], {
      crontab: io,
      resolveBin: () => "/usr/local/bin/atmux",
      env: {},
      stderr: () => {},
      stdout: () => {},
    });
    const body = captured.writes[0] ?? "";
    expect(body).toMatch(/\*\/30 \* \* \* \* .*atmux ombudsman tick/);
  });

  test("bare cron-install (no --template) on enabled team + ombudsman member → emits line", async () => {
    // The ombudsman-tick line is gated on team.ombudsman.enabled +
    // member role, NOT the --template flag. The template flag is the
    // operator-facing "I want this template" assertion; the schema
    // config drives the rendered line.
    await seedTeam({
      ombudsman: { enabled: true },
      withOmbudsmanMember: true,
    });
    const { io, captured } = makeFakeCrontab(null);
    await cronInstall(["--team-dir", scratch], {
      crontab: io,
      resolveBin: () => "/usr/local/bin/atmux",
      env: {},
      stderr: () => {},
      stdout: () => {},
    });
    const body = captured.writes[0] ?? "";
    expect(body).toMatch(/atmux ombudsman tick/);
  });

  test("enabled=true but NO member with role=ombudsman → line absent (renderer member-gate)", async () => {
    await seedTeam({ ombudsman: { enabled: true }, withOmbudsmanMember: false });
    const { io, captured } = makeFakeCrontab(null);
    await cronInstall(["--team-dir", scratch], {
      crontab: io,
      resolveBin: () => "/usr/local/bin/atmux",
      env: {},
      stderr: () => {},
      stdout: () => {},
    });
    const body = captured.writes[0] ?? "";
    expect(body).not.toContain("atmux ombudsman tick");
  });

  test("ombudsman.enabled=false → block does NOT include ombudsman-tick line", async () => {
    await seedTeam({ ombudsman: { enabled: false }, withOmbudsmanMember: true });
    const { io, captured } = makeFakeCrontab(null);
    await cronInstall(["--team-dir", scratch], {
      crontab: io,
      resolveBin: () => "/usr/local/bin/atmux",
      env: {},
      stderr: () => {},
      stdout: () => {},
    });
    const body = captured.writes[0] ?? "";
    expect(body).not.toContain("atmux ombudsman tick");
  });

  test("idempotent re-install with --template ombudsman-tick → byte-identical body", async () => {
    await seedTeam({
      ombudsman: { enabled: true },
      withOmbudsmanMember: true,
    });
    const { io: io1, captured: cap1 } = makeFakeCrontab(null);
    await cronInstall(["--template", "ombudsman-tick", "--team-dir", scratch], {
      crontab: io1,
      resolveBin: () => "/usr/local/bin/atmux",
      env: {},
      stderr: () => {},
      stdout: () => {},
    });
    const firstBody = cap1.writes[0] ?? "";
    const { io: io2, captured: cap2 } = makeFakeCrontab(firstBody);
    await cronInstall(["--template", "ombudsman-tick", "--team-dir", scratch], {
      crontab: io2,
      resolveBin: () => "/usr/local/bin/atmux",
      env: {},
      stderr: () => {},
      stdout: () => {},
    });
    expect(cap2.writes[0]).toBe(firstBody);
  });
});

// ---------- ADR-133 TR6: superdoctor → medic cron-line migration ----------

describe("cronInstall — ADR-133 TR6 superdoctor→medic migration", () => {
  let scratch: string;
  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "atmux-cron-install-tr6-"));
    const atmuxDir = join(scratch, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
    await writeFile(join(atmuxDir, "team.json"), JSON.stringify({ name: "demo", members: [] }));
  });
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test("legacy atmux superdoctor line in foreign team block is rewritten", async () => {
    // Foreign team's managed block carries the legacy invocation. The
    // demo team's install pass rewrites it on the way through (managed-
    // block-only migration).
    const existing = [
      "# >>> atmux:team=other — managed by atmux start; do not edit by hand",
      "0 * * * * ATMUX_DIR=/srv/other/.atmux /usr/local/bin/atmux superdoctor --once",
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
    expect(body.includes("/usr/local/bin/atmux medic --once")).toBe(true);
    expect(body.includes("atmux superdoctor")).toBe(false);
  });

  test("operator-manual atmux superdoctor outside managed blocks is PRESERVED", async () => {
    const existing = [
      "# operator's own cron line — DO NOT touch",
      "0 0 * * * /usr/local/bin/atmux superdoctor --my-custom-flag",
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
    // Operator-manual line untouched.
    expect(body.includes("0 0 * * * /usr/local/bin/atmux superdoctor --my-custom-flag")).toBe(true);
  });

  test("no legacy lines → no migration log written (no-op path)", async () => {
    // Default state for every current installation.
    const { io } = makeFakeCrontab(null);
    const stderrBuf: string[] = [];
    await cronInstall(["--team-dir", scratch], {
      crontab: io,
      resolveBin: () => "/usr/local/bin/atmux",
      env: {},
      stderr: (s) => stderrBuf.push(s),
      stdout: () => {},
    });
    // Log file must not exist when no migration fired.
    const fs = await import("node:fs/promises");
    const logPath = join(scratch, ".atmux", "state", "cron-rename-migration.log");
    let logExists = true;
    try {
      await fs.access(logPath);
    } catch {
      logExists = false;
    }
    expect(logExists).toBe(false);
    expect(stderrBuf.join("")).toBe("");
  });

  test("migration writes log to ~/.atmux/state/cron-rename-migration.log when rewrites fire", async () => {
    const existing = [
      "# >>> atmux:team=other — managed by atmux start; do not edit by hand",
      "0 * * * * /usr/local/bin/atmux superdoctor",
      "# <<< atmux:team=other",
    ].join("\n");
    const { io } = makeFakeCrontab(existing);
    await cronInstall(["--team-dir", scratch], {
      crontab: io,
      resolveBin: () => "/usr/local/bin/atmux",
      env: {},
      stderr: () => {},
      stdout: () => {},
    });
    const fs = await import("node:fs/promises");
    const logPath = join(scratch, ".atmux", "state", "cron-rename-migration.log");
    const logContent = await fs.readFile(logPath, "utf-8");
    expect(logContent).toContain("team=demo");
    expect(logContent).toContain("migrated=1");
    expect(logContent).toContain("ADR-133 TR6");
  });
});

// ---------- ADR-134 T7: --template gitter-sweep integration ----------

describe("cronInstall — --template gitter-sweep integration (ADR-134 T7)", () => {
  let scratch: string;
  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "atmux-cron-git-"));
    const atmuxDir = join(scratch, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  async function seedTeam(opts: {
    autoMerge?: Record<string, unknown>;
    withGitterMember?: boolean;
  }): Promise<void> {
    const members: Array<Record<string, unknown>> = [];
    if (opts.withGitterMember === true) {
      members.push({ name: "gitter", role: "gitter" });
    }
    const cfg: Record<string, unknown> = { name: "demo", members };
    if (opts.autoMerge !== undefined) cfg.autoMerge = opts.autoMerge;
    await writeFile(join(scratch, ".atmux", "team.json"), JSON.stringify(cfg));
  }

  test("--template gitter-sweep + enabled=true + member role=gitter → emits sweep line at 10min default", async () => {
    await seedTeam({ autoMerge: { enabled: true }, withGitterMember: true });
    const { io, captured } = makeFakeCrontab(null);
    const rc = await cronInstall(["--template", "gitter-sweep", "--team-dir", scratch], {
      crontab: io,
      resolveBin: () => "/usr/local/bin/atmux",
      env: {},
      stderr: () => {},
      stdout: () => {},
    });
    expect(rc).toBe(0);
    const body = captured.writes[0] ?? "";
    expect(body).toMatch(/\*\/10 \* \* \* \* .*atmux gitter --sweep >> .*\/gitter-sweep\.log/);
  });

  test("--template gitter-sweep + autoMerge.enabled=false → ConfigError", async () => {
    await seedTeam({ autoMerge: { enabled: false }, withGitterMember: true });
    const { io } = makeFakeCrontab(null);
    await expect(
      cronInstall(["--template", "gitter-sweep", "--team-dir", scratch], {
        crontab: io,
        resolveBin: () => "/usr/local/bin/atmux",
        env: {},
        stderr: () => {},
        stdout: () => {},
      }),
    ).rejects.toThrow(ConfigError);
  });

  test("--template gitter-sweep + absent autoMerge block → ConfigError", async () => {
    await seedTeam({ withGitterMember: true });
    const { io } = makeFakeCrontab(null);
    await expect(
      cronInstall(["--template", "gitter-sweep", "--team-dir", scratch], {
        crontab: io,
        resolveBin: () => "/usr/local/bin/atmux",
        env: {},
        stderr: () => {},
        stdout: () => {},
      }),
    ).rejects.toThrow(ConfigError);
  });

  test("--template gitter-sweep + autoMerge.enabled=true but NO gitter member → renders without sweep line (render-time gate)", async () => {
    // ConfigError gate is enabled-only; the renderer enforces the role
    // gate. Install succeeds, but the rendered block has no sweep line.
    await seedTeam({ autoMerge: { enabled: true }, withGitterMember: false });
    const { io, captured } = makeFakeCrontab(null);
    const rc = await cronInstall(["--template", "gitter-sweep", "--team-dir", scratch], {
      crontab: io,
      resolveBin: () => "/usr/local/bin/atmux",
      env: {},
      stderr: () => {},
      stdout: () => {},
    });
    expect(rc).toBe(0);
    const body = captured.writes[0] ?? "";
    expect(body.includes("gitter --sweep")).toBe(false);
  });

  test("--template gitter-sweep --interval 5m overrides 10min default", async () => {
    await seedTeam({ autoMerge: { enabled: true }, withGitterMember: true });
    const { io, captured } = makeFakeCrontab(null);
    await cronInstall(
      ["--template", "gitter-sweep", "--interval", "5m", "--team-dir", scratch],
      {
        crontab: io,
        resolveBin: () => "/usr/local/bin/atmux",
        env: {},
        stderr: () => {},
        stdout: () => {},
      },
    );
    const body = captured.writes[0] ?? "";
    expect(body).toMatch(/\*\/5 \* \* \* \* .*atmux gitter --sweep/);
    expect(body.includes("*/10 * * * *")).toBe(false);
  });

  test("--template gitter-sweep --interval 1h overrides to hourly", async () => {
    await seedTeam({ autoMerge: { enabled: true }, withGitterMember: true });
    const { io, captured } = makeFakeCrontab(null);
    await cronInstall(
      ["--template", "gitter-sweep", "--interval", "1h", "--team-dir", scratch],
      {
        crontab: io,
        resolveBin: () => "/usr/local/bin/atmux",
        env: {},
        stderr: () => {},
        stdout: () => {},
      },
    );
    const body = captured.writes[0] ?? "";
    expect(body).toMatch(/0 \* \* \* \* .*atmux gitter --sweep/);
  });

  test("idempotent re-install: second --template gitter-sweep run is byte-equal", async () => {
    await seedTeam({ autoMerge: { enabled: true }, withGitterMember: true });
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
    await cronInstall(["--template", "gitter-sweep", "--team-dir", scratch], opts);
    const first = storage;
    await cronInstall(["--template", "gitter-sweep", "--team-dir", scratch], opts);
    expect(storage).toBe(first);
  });
});
