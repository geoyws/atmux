// e-22 T2 — ADR-241 preflight wizard matrix. All IO injected; no
// /opt, HOME, or stdio touched (homeDir + prompt + runInstall faked).

import { describe, expect, mock, test } from "bun:test";
import { existsSync as fsExistsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
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

// e-22 T3 — close the 100% line/function/branch gate (ADR-009 §2) on the
// production defaults: real-fs prefix + script shims for defaultTmuxVersion,
// injected streams for defaultPrompt, mock.module child_process for
// defaultRunInstall. No network, no /opt, no real installer runs.

describe("runStartPreflight production defaults", () => {
  function discardOutput(): Writable {
    return new Writable({
      write(_chunk, _encoding, cb) {
        cb();
      },
    });
  }

  async function scriptPrefix(script: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "preflight-bin-"));
    await writeFile(join(dir, "tmux"), `#!/bin/sh\n${script}\n`, "utf8");
    await chmod(join(dir, "tmux"), 0o755);
    return dir;
  }

  test("drifted tmux with unparsable -V renders installed unknown", async () => {
    const logs: string[] = [];
    const r = await runStartPreflight(
      parsePreflightFlags([]),
      {},
      deps({
        tmuxVersion: () => null,
        prompt: async () => false,
        log: (s) => {
          logs.push(s);
        },
      }),
    );
    expect(r).toBe("continue");
    expect(logs.some((l) => l.includes("installed unknown"))).toBe(true);
  });

  test("--non-interactive accepts with no prompt seam and no isTTY seam", async () => {
    const home = await mkdtemp(join(tmpdir(), "preflight-nidef-"));
    try {
      const present = new Set(["atmux", "atmux-listener", "atmux-cockpit-mirror"]);
      let installed = 0;
      const d: PreflightDeps = {
        homeDir: home,
        atmuxVersion: VERSION,
        existsSync: (p) => present.has(p.split("/").pop() ?? ""),
        tmuxVersion: () => "tmux 3.6a",
        readPin: () => "3.6a",
        runInstall: async () => {
          installed += 1;
          present.add("tmux");
          return 0;
        },
        log: () => {},
      };
      const r = await runStartPreflight(parsePreflightFlags(["--non-interactive"]), {}, d);
      expect(r).toBe("continue");
      expect(installed).toBe(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("isTTY:false auto-Y with no prompt seam", async () => {
    let installed = 0;
    const r = await runStartPreflight(
      parsePreflightFlags([]),
      {},
      deps({
        existsSync: () => false,
        isTTY: false,
        runInstall: async () => {
          installed += 1;
          return 1;
        },
      }),
    );
    expect(r).toBe("halt");
    expect(installed).toBe(1);
  });

  test.each(["y", "", "yes"])("default prompt accepts on %p via injected input", async (answer) => {
    const home = await mkdtemp(join(tmpdir(), "preflight-din-"));
    try {
      const present = new Set(["atmux", "atmux-listener", "atmux-cockpit-mirror"]);
      let installed = 0;
      const d: PreflightDeps = {
        homeDir: home,
        atmuxVersion: VERSION,
        existsSync: (p) => present.has(p.split("/").pop() ?? ""),
        tmuxVersion: () => "tmux 3.6a",
        readPin: () => "3.6a",
        isTTY: true,
        promptInput: Readable.from([`${answer}\n`]),
        promptOutput: discardOutput(),
        runInstall: async () => {
          installed += 1;
          present.add("tmux");
          return 0;
        },
        log: () => {},
      };
      const r = await runStartPreflight(parsePreflightFlags([]), {}, d);
      expect(r).toBe("continue");
      expect(installed).toBe(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("default prompt declines on n via injected input, output seam omitted", async () => {
    const logs: string[] = [];
    const r = await runStartPreflight(
      parsePreflightFlags([]),
      {},
      deps({
        existsSync: () => false,
        isTTY: true,
        promptInput: Readable.from(["n\n"]),
        log: (s) => {
          logs.push(s);
        },
      }),
    );
    expect(r).toBe("continue");
    expect(logs.some((l) => l.includes("continuing with system/fallback"))).toBe(true);
  });

  test("corrupt marker JSON falls through to the probe", async () => {
    const home = await mkdtemp(join(tmpdir(), "preflight-corrupt-"));
    try {
      mkdirSync(join(home, ".atmux", "state"), { recursive: true });
      writeFileSync(join(home, ".atmux", "state", `preflight-${VERSION}.json`), "not-json{{{");
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

  test.each([
    { atmux_version: 5 },
    { atmux_version: VERSION },
  ])("marker wrong shape %p falls through to the probe", async (shape) => {
    const home = await mkdtemp(join(tmpdir(), "preflight-shape-"));
    try {
      mkdirSync(join(home, ".atmux", "state"), { recursive: true });
      writeFileSync(
        join(home, ".atmux", "state", `preflight-${VERSION}.json`),
        JSON.stringify({ ...shape, installed_at: "x", binaries: "oops" }),
      );
      const r = await runStartPreflight(parsePreflightFlags([]), {}, deps({ homeDir: home }));
      expect(r).toBe("continue");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("valid marker with a binary gone falls through to the wizard", async () => {
    const home = await mkdtemp(join(tmpdir(), "preflight-inval-"));
    try {
      mkdirSync(join(home, ".atmux", "state"), { recursive: true });
      writeFileSync(
        join(home, ".atmux", "state", `preflight-${VERSION}.json`),
        JSON.stringify({ atmux_version: VERSION, installed_at: "x", binaries: {} }),
      );
      let prompted = 0;
      const r = await runStartPreflight(
        parsePreflightFlags([]),
        {},
        deps({
          homeDir: home,
          existsSync: (p) => !p.endsWith("/tmux"),
          prompt: async () => {
            prompted += 1;
            return false;
          },
        }),
      );
      expect(r).toBe("continue");
      expect(prompted).toBe(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("unwritable marker location still continues after install", async () => {
    const dir = await mkdtemp(join(tmpdir(), "preflight-nowrite-"));
    const fileHome = join(dir, "file-not-dir");
    try {
      await writeFile(fileHome, "x", "utf8");
      const present = new Set(["atmux", "atmux-listener", "atmux-cockpit-mirror"]);
      let installed = 0;
      const r = await runStartPreflight(
        parsePreflightFlags([]),
        {},
        deps({
          homeDir: fileHome,
          existsSync: (p) => present.has(p.split("/").pop() ?? ""),
          prompt: async () => true,
          runInstall: async () => {
            installed += 1;
            present.add("tmux");
            return 0;
          },
        }),
      );
      expect(r).toBe("continue");
      expect(installed).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("default tmuxVersion + readPin + existsSync via script shim (drifted)", async () => {
    const dir = await scriptPrefix('echo "tmux 9.9"');
    const home = await mkdtemp(join(tmpdir(), "preflight-shim-"));
    try {
      const logs: string[] = [];
      const r = await runStartPreflight(
        parsePreflightFlags([]),
        {},
        {
          installPrefix: dir,
          homeDir: home,
          atmuxVersion: VERSION,
          isTTY: true,
          prompt: async () => false,
          log: (s) => {
            logs.push(s);
          },
        },
      );
      expect(r).toBe("continue");
      expect(logs.some((l) => l.includes("installed 9.9") && l.includes("expected 3.6a"))).toBe(
        true,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test("default tmuxVersion null on nonzero exit (script exits 3)", async () => {
    const dir = await scriptPrefix("exit 3");
    const home = await mkdtemp(join(tmpdir(), "preflight-exit3-"));
    try {
      const logs: string[] = [];
      const r = await runStartPreflight(
        parsePreflightFlags([]),
        {},
        {
          installPrefix: dir,
          homeDir: home,
          atmuxVersion: VERSION,
          isTTY: true,
          prompt: async () => false,
          log: (s) => {
            logs.push(s);
          },
        },
      );
      expect(r).toBe("continue");
      expect(logs.some((l) => l.includes("installed unknown"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test("default tmuxVersion null on garbage output", async () => {
    const dir = await scriptPrefix('echo "not tmux at all"');
    const home = await mkdtemp(join(tmpdir(), "preflight-garbage-"));
    try {
      const r = await runStartPreflight(
        parsePreflightFlags([]),
        {},
        {
          installPrefix: dir,
          homeDir: home,
          atmuxVersion: VERSION,
          isTTY: true,
          prompt: async () => false,
          log: () => {},
        },
      );
      expect(r).toBe("continue");
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test("default tmuxVersion null on spawn throw (exists, not executable)", async () => {
    const logs: string[] = [];
    const d: PreflightDeps = {
      installPrefix: "/nonexistent-preflight-dir-xyz",
      homeDir: "/nonexistent-home",
      atmuxVersion: VERSION,
      existsSync: () => true,
      isTTY: true,
      prompt: async () => false,
      log: (s) => {
        logs.push(s);
      },
    };
    const r = await runStartPreflight(parsePreflightFlags([]), {}, d);
    expect(r).toBe("continue");
    expect(logs.some((l) => l.includes("installed unknown"))).toBe(true);
  });

  test("default runInstall via mocked child_process: success installs, marker stamped", async () => {
    const realCp = await import("node:child_process");
    const spawns: Array<{ bin: string; args: ReadonlyArray<string> }> = [];
    mock.module("node:child_process", () => ({
      ...realCp,
      spawnSync: (bin: string, args: ReadonlyArray<string>) => {
        spawns.push({ bin, args });
        if (bin === "bun") return { status: 0, stdout: "", stderr: "" };
        return { status: 0, stdout: "tmux 3.6a\n", stderr: "" };
      },
    }));
    const home = await mkdtemp(join(tmpdir(), "preflight-mock-"));
    try {
      const present = new Set(["atmux", "atmux-listener", "atmux-cockpit-mirror"]);
      const d: PreflightDeps = {
        homeDir: home,
        atmuxVersion: VERSION,
        existsSync: (p) => present.has(p.split("/").pop() ?? ""),
        isTTY: true,
        prompt: async () => {
          present.add("tmux");
          return true;
        },
        log: () => {},
      };
      const r = await runStartPreflight(parsePreflightFlags([]), {}, d);
      expect(r).toBe("continue");
      expect(spawns.some((s) => s.bin === "bun" && s.args.includes("build:install"))).toBe(true);
      expect(spawns.some((s) => s.args.includes("-V"))).toBe(true);
      expect(fsExistsSync(join(home, ".atmux", "state", `preflight-${VERSION}.json`))).toBe(true);
    } finally {
      mock.restore();
      await rm(home, { recursive: true, force: true });
    }
  });

  test("default runInstall via mocked child_process: null status halts bringup", async () => {
    const realCp = await import("node:child_process");
    const logs: string[] = [];
    mock.module("node:child_process", () => ({
      ...realCp,
      spawnSync: () => ({ status: null, stdout: "", stderr: "" }),
    }));
    try {
      const r = await runStartPreflight(
        parsePreflightFlags([]),
        {},
        deps({
          existsSync: () => false,
          prompt: async () => true,
          log: (s) => {
            logs.push(s);
          },
        }),
      );
      expect(r).toBe("halt");
      expect(logs.some((l) => l.includes("exit 1"))).toBe(true);
    } finally {
      mock.restore();
    }
  });

  test("default tmuxVersion catch on spawn throw (mocked child_process)", async () => {
    const realCp = await import("node:child_process");
    const logs: string[] = [];
    mock.module("node:child_process", () => ({
      ...realCp,
      spawnSync: () => {
        throw new Error("spawn ENOENT (test double)");
      },
    }));
    try {
      const d: PreflightDeps = {
        homeDir: "/nonexistent-home",
        atmuxVersion: VERSION,
        existsSync: () => true,
        isTTY: true,
        prompt: async () => false,
        log: (s) => {
          logs.push(s);
        },
      };
      const r = await runStartPreflight(parsePreflightFlags([]), {}, d);
      expect(r).toBe("continue");
      expect(logs.some((l) => l.includes("installed unknown"))).toBe(true);
    } finally {
      mock.restore();
    }
  });
});
