// ADR-306: `cockpit attach --live` flag parsing + verb wiring.
//
// Fully isolated: temp-dir cockpit.json, stubbed live seams (no tmux,
// no sockets), TMUX save/restore. Complements
// tests/unit/verbs/cockpit.test.ts (which owns the non-live attach
// matrix) — this file owns only the `--live` path.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LiveProbeSeams, LiveRunResult } from "../../../src/core/cockpit-live-attach.ts";
import type { Logger } from "../../../src/core/tui.ts";
import { UsageError } from "../../../src/errors.ts";
import {
  cockpit,
  cockpitAttach,
  cockpitAttachLive,
  type ParsedCockpitArgs,
  parseCockpitArgs,
} from "../../../src/verbs/cockpit.ts";

function makeLogger(): { logger: Logger; warns: string[] } {
  const warns: string[] = [];
  return {
    warns,
    logger: {
      log: () => {},
      ok: () => {},
      warn: (m: string) => {
        warns.push(m);
      },
      err: () => {},
    },
  };
}

/** Live seams: first candidate socket live, `liveBin` answers. */
function liveSeams(): LiveProbeSeams {
  const run = async (bin: string, argv: ReadonlyArray<string>): Promise<LiveRunResult> => {
    const sub = argv[3] as string; // argv = ["-u", "-S", <sock>, <subcommand>, …]
    if (sub === "has-session") return { ok: bin === "liveBin", stdout: "" };
    if (sub === "list-windows") return { ok: true, stdout: "0: superdriver\n" };
    return { ok: true, stdout: "3.6a\n" };
  };
  return {
    statNode: (p) => (p.endsWith("atmux-cockpit") ? "socket" : "missing"),
    dialSocket: async () => true,
    findServers: async () => [],
    ensureParentDir: () => {},
    sendRebind: () => {},
    sleepMs: async () => {},
    resolveClients: () => ["liveBin"],
    runTmux: run,
    attachTmux: async () => 0,
  };
}

describe("parseCockpitArgs — --live (ADR-306)", () => {
  test("attach accepts --live, defaulting to false", () => {
    expect(parseCockpitArgs(["attach", "--live"]).live).toBe(true);
    expect(parseCockpitArgs(["attach"]).live).toBe(false);
  });
  test("attach accepts --live with --no-ensure (implied, redundant but harmless)", () => {
    const p = parseCockpitArgs(["attach", "--live", "--no-ensure"]);
    expect(p.live).toBe(true);
    expect(p.noEnsure).toBe(true);
  });
  test("attach accepts --live with --human (stdio passthrough)", () => {
    const p = parseCockpitArgs(["attach", "--live", "--human"]);
    expect(p.live).toBe(true);
    expect(p.human).toBe(true);
  });
  test("attach refuses --live with --launch (contradictory: no ensure-up to launch in)", () => {
    expect(() => parseCockpitArgs(["attach", "--live", "--launch"])).toThrow(UsageError);
  });
  test("reconcile / reload / migrate-socket reject --live (attach-only flag)", () => {
    for (const sub of ["reconcile", "reload", "migrate-socket"] as const) {
      expect(() => parseCockpitArgs([sub, "--live"])).toThrow(UsageError);
    }
  });
  test("attach rejection message names --live", () => {
    try {
      parseCockpitArgs(["attach", "--no-cycle"]);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(UsageError);
      expect(String(e)).toContain("--live");
    }
  });
});

describe("cockpitAttach --live wiring", () => {
  let workDir = "";
  let cockpitJson = "";
  let priorTmux: string | undefined;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "atmux-live-verb-"));
    cockpitJson = join(workDir, "cockpit.json");
    await writeFile(
      cockpitJson,
      JSON.stringify({ schemaVersion: 1, cockpitSession: "atx", sessions: [] }),
    );
    priorTmux = process.env.TMUX;
    delete process.env.TMUX;
  });

  afterEach(async () => {
    if (priorTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = priorTmux;
    await rm(workDir, { recursive: true, force: true });
  });

  function liveArgs(overrides: Partial<ParsedCockpitArgs> = {}): ParsedCockpitArgs {
    return {
      subverb: "attach",
      noCycle: false,
      forceCycle: false,
      ackDangerous: false,
      noLaunch: false,
      yes: false,
      dryRun: false,
      keepLegacy: false,
      human: false,
      noEnsure: false,
      launch: false,
      live: true,
      configPath: cockpitJson,
      ...overrides,
    };
  }

  test("--live skips ensure-up (factory never called) and attaches to the live socket", async () => {
    const { warns, logger } = makeLogger();
    const attached: Array<{ bin: string; argv: ReadonlyArray<string> }> = [];
    const exit = await cockpitAttach(liveArgs(), {
      env: { TMUX_TMPDIR: workDir },
      logger,
      tmuxFactory: () => {
        throw new Error("ensure-up must not run on --live");
      },
      cockpitLiveDeps: {
        ...liveSeams(),
        attachTmux: async (bin, argv) => {
          attached.push({ bin, argv });
          return 0;
        },
      },
    });
    expect(exit).toBe(0);
    expect(attached).toHaveLength(1);
    expect(attached[0]?.bin).toBe("liveBin");
    expect(attached[0]?.argv).toContain("attach-session");
    expect(warns).toEqual([]);
  });
  test("--live failure returns 1 with the aca hint (no throw)", async () => {
    const { warns, logger } = makeLogger();
    const exit = await cockpitAttach(liveArgs(), {
      env: { TMUX_TMPDIR: workDir },
      logger,
      tmuxFactory: () => {
        throw new Error("ensure-up must not run on --live");
      },
      cockpitLiveDeps: { ...liveSeams(), statNode: () => "missing" },
    });
    expect(exit).toBe(1);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("aca");
  });
  test("cockpitAttachLive honours --human + liveDeps-owned env/logger", async () => {
    const { logger } = makeLogger();
    const seen: boolean[] = [];
    const exit = await cockpitAttachLive(liveArgs({ human: true }), {
      env: { TMUX_TMPDIR: workDir },
      cockpitLiveDeps: {
        ...liveSeams(),
        env: { TMUX_TMPDIR: workDir },
        logger,
        attachTmux: async (_b, _a, inherit) => {
          seen.push(inherit);
          return 0;
        },
      },
    });
    expect(exit).toBe(0);
    expect(seen).toEqual([true]);
  });
  test("cockpitAttachLive reads the session from cockpit.json + honours ATMUX_COCKPIT_CONFIG", async () => {
    const { logger } = makeLogger();
    const probed: string[] = [];
    const { configPath: _drop, ...noPath } = liveArgs();
    void _drop;
    const exit = await cockpitAttachLive(noPath, {
      env: { TMUX_TMPDIR: workDir, ATMUX_COCKPIT_CONFIG: cockpitJson },
      logger,
      cockpitLiveDeps: {
        ...liveSeams(),
        statNode: (p) => {
          probed.push(p);
          return "missing";
        },
      },
    });
    expect(exit).toBe(1);
    expect(probed.length).toBeGreaterThan(0);
  });
  test("cockpit() dispatches attach --live end to end", async () => {
    const { logger } = makeLogger();
    const exit = await cockpit(["attach", "--live", "--config", cockpitJson], {
      env: { TMUX_TMPDIR: workDir },
      logger,
      tmuxFactory: () => {
        throw new Error("ensure-up must not run on --live");
      },
      cockpitLiveDeps: liveSeams(),
    });
    expect(exit).toBe(0);
  });
  test("cockpitAttachLive without injected seams uses production defaults safely", async () => {
    // No cockpitLiveDeps at all: real stat (missing under the temp
    // TMUX_TMPDIR) + real pgrep (no match) → absent → 1, nothing created.
    const exit = await cockpitAttachLive(liveArgs(), {
      env: { TMUX_TMPDIR: workDir },
    });
    expect(exit).toBe(1);
  });
});
