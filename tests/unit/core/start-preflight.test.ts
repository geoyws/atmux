// e-22 T2 — ADR-241 preflight wizard matrix. All IO injected; no
// /opt, HOME, or stdio touched (homeDir + prompt + runInstall faked).

import { describe, expect, test } from "bun:test";
import { existsSync as fsExistsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type PreflightDeps,
  parsePreflightFlags,
  probeVendoredDeps,
  runStartPreflight,
} from "../../../src/core/start-preflight.ts";
import { UsageError } from "../../../src/errors.ts";

const VERSION = "0.8.26-test";

function deps(over: Partial<PreflightDeps> = {}): PreflightDeps {
  return {
    existsSync: () => true,
    tmuxVersion: () => "tmux 3.6a",
    readPin: () => "3.6a",
    installPrefix: "/opt/atmux/current/bin",
    homeDir: "/nonexistent-home",
    atmuxVersion: VERSION,
    isTTY: true,
    ...over,
  };
}

describe("parsePreflightFlags", () => {
  test("no flags → all false", () => {
    expect(parsePreflightFlags([])).toEqual({
      skipDeps: false,
      nonInteractive: false,
      noPreflight: false,
    });
  });

  test("each flag sets its bit", () => {
    expect(parsePreflightFlags(["--skip-deps"]).skipDeps).toBe(true);
    expect(parsePreflightFlags(["--non-interactive"]).nonInteractive).toBe(true);
    expect(parsePreflightFlags(["--no-preflight"]).noPreflight).toBe(true);
  });

  test("--skip-deps + --non-interactive → UsageError", () => {
    expect(() => parsePreflightFlags(["--skip-deps", "--non-interactive"])).toThrow(UsageError);
  });

  test("unknown flags ignored here (start parser owns them)", () => {
    expect(parsePreflightFlags(["--force"]).skipDeps).toBe(false);
  });
});

describe("probeVendoredDeps", () => {
  test("all present + tmux pinned", () => {
    const probes = probeVendoredDeps(deps());
    expect(probes.map((p) => p.status)).toEqual(["pinned", "present", "present", "present"]);
  });

  test("absent binary → absent", () => {
    const probes = probeVendoredDeps(deps({ existsSync: (p) => !p.endsWith("/tmux") }));
    expect(probes.find((p) => p.name === "tmux")?.status).toBe("absent");
  });

  test("tmux drift → drifted with installed + expected", () => {
    const probes = probeVendoredDeps(deps({ tmuxVersion: () => "tmux 3.5" }));
    const tmux = probes.find((p) => p.name === "tmux");
    expect(tmux?.status).toBe("drifted");
    expect(tmux?.installed).toBe("3.5");
    expect(tmux?.expected).toBe("3.6a");
  });

  test("tmux -V failure → drifted (prompt, don't silently pass)", () => {
    const probes = probeVendoredDeps(deps({ tmuxVersion: () => null }));
    expect(probes.find((p) => p.name === "tmux")?.status).toBe("drifted");
  });
});

describe("runStartPreflight", () => {
  test("all present → continue, no prompt, no install", async () => {
    let prompted = 0;
    let installed = 0;
    const logs: string[] = [];
    const r = await runStartPreflight(
      parsePreflightFlags([]),
      {},
      deps({
        prompt: async () => {
          prompted += 1;
          return true;
        },
        runInstall: async () => {
          installed += 1;
          return 0;
        },
        log: (s) => {
          logs.push(s);
        },
      }),
    );
    expect(r).toBe("continue");
    expect(prompted).toBe(0);
    expect(installed).toBe(0);
  });

  test("--no-preflight skips probe entirely", async () => {
    let installed = 0;
    const r = await runStartPreflight(
      parsePreflightFlags(["--no-preflight"]),
      {},
      deps({
        existsSync: () => false,
        runInstall: async () => {
          installed += 1;
          return 0;
        },
      }),
    );
    expect(r).toBe("continue");
    expect(installed).toBe(0);
  });

  test("ATMUX_START_NO_PREFLIGHT=1 skips probe entirely", async () => {
    const r = await runStartPreflight(
      parsePreflightFlags([]),
      { ATMUX_START_NO_PREFLIGHT: "1" },
      deps({ existsSync: () => false }),
    );
    expect(r).toBe("continue");
  });

  test("absent + accept → install runs, marker written, continue", async () => {
    const home = await mkdtemp(join(tmpdir(), "preflight-home-"));
    try {
      const present = new Set(["atmux", "atmux-listener", "atmux-cockpit-mirror"]);
      let installed = 0;
      const d = deps({
        homeDir: home,
        existsSync: (p) => present.has(p.split("/").pop() ?? "") || p.includes("preflight-"),
        runInstall: async () => {
          installed += 1;
          present.add("tmux");
          return 0;
        },
        prompt: async () => true,
      });
      // Marker check must miss (no marker yet) but the state dir probe
      // for marker read uses readFileSync — point home at the temp dir.
      const r = await runStartPreflight(parsePreflightFlags([]), {}, d);
      expect(r).toBe("continue");
      expect(installed).toBe(1);
      const markerFile = join(home, ".atmux", "state", `preflight-${VERSION}.json`);
      expect(fsExistsSync(markerFile)).toBe(true);
      const marker = JSON.parse(readFileSync(markerFile, "utf8")) as {
        atmux_version: string;
      };
      expect(marker.atmux_version).toBe(VERSION);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("install failure → halt", async () => {
    const logs: string[] = [];
    const r = await runStartPreflight(
      parsePreflightFlags([]),
      {},
      deps({
        existsSync: () => false,
        prompt: async () => true,
        runInstall: async () => 3,
        log: (s) => {
          logs.push(s);
        },
      }),
    );
    expect(r).toBe("halt");
    expect(logs.some((l) => l.includes("exit 3"))).toBe(true);
  });

  test("decline → continue with one-line warning, no install", async () => {
    const logs: string[] = [];
    let installed = 0;
    const r = await runStartPreflight(
      parsePreflightFlags([]),
      {},
      deps({
        existsSync: () => false,
        prompt: async () => false,
        runInstall: async () => {
          installed += 1;
          return 0;
        },
        log: (s) => {
          logs.push(s);
        },
      }),
    );
    expect(r).toBe("continue");
    expect(installed).toBe(0);
    expect(logs.some((l) => l.includes("continuing with system/fallback"))).toBe(true);
  });

  test("--skip-deps auto-n (no prompt)", async () => {
    let prompted = 0;
    const r = await runStartPreflight(
      parsePreflightFlags(["--skip-deps"]),
      {},
      deps({
        existsSync: () => false,
        prompt: async () => {
          prompted += 1;
          return true;
        },
      }),
    );
    expect(r).toBe("continue");
    expect(prompted).toBe(0);
  });

  test("--non-interactive auto-Y (no prompt)", async () => {
    const home = await mkdtemp(join(tmpdir(), "preflight-ni-"));
    try {
      let prompted = 0;
      let installed = 0;
      const r = await runStartPreflight(
        parsePreflightFlags(["--non-interactive"]),
        {},
        deps({
          existsSync: () => true,
          tmuxVersion: () => "tmux 3.6a",
          prompt: async () => {
            prompted += 1;
            return false;
          },
          runInstall: async () => {
            installed += 1;
            return 0;
          },
          homeDir: home,
        }),
      );
      expect(r).toBe("continue");
      expect(prompted).toBe(0);
      expect(installed).toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("install success but artefacts still missing → halt", async () => {
    const r = await runStartPreflight(
      parsePreflightFlags([]),
      {},
      deps({ existsSync: () => false, prompt: async () => true, runInstall: async () => 0 }),
    );
    expect(r).toBe("halt");
  });

  test("marker fast-path: matching version + all present → silent", async () => {
    const home = await mkdtemp(join(tmpdir(), "preflight-marker-"));
    try {
      mkdirSync(join(home, ".atmux", "state"), { recursive: true });
      writeFileSync(
        join(home, ".atmux", "state", `preflight-${VERSION}.json`),
        JSON.stringify({ atmux_version: VERSION, installed_at: "x", binaries: {} }),
      );
      let tmuxProbed = 0;
      const r = await runStartPreflight(
        parsePreflightFlags([]),
        {},
        deps({
          homeDir: home,
          tmuxVersion: () => {
            tmuxProbed += 1;
            return "tmux 9.9";
          },
        }),
      );
      expect(r).toBe("continue");
      expect(tmuxProbed).toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("marker version mismatch → full probe runs", async () => {
    const home = await mkdtemp(join(tmpdir(), "preflight-stale-"));
    try {
      mkdirSync(join(home, ".atmux", "state"), { recursive: true });
      writeFileSync(
        join(home, ".atmux", "state", `preflight-${VERSION}.json`),
        JSON.stringify({ atmux_version: "0.0.0-old", installed_at: "x", binaries: {} }),
      );
      let prompted = 0;
      const r = await runStartPreflight(
        parsePreflightFlags([]),
        {},
        deps({
          homeDir: home,
          prompt: async () => {
            prompted += 1;
            return false;
          },
        }),
      );
      expect(r).toBe("continue");
      expect(prompted).toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
