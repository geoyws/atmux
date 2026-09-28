// Unit tests for src/verbs/doctor/agent-env.ts (ADR-294) — the
// `tmux-agent-env` doctor probe.
//
// No real tmux here: every tmux call goes through an injected TmuxSpawn
// that records its argv, and socket existence through an injected
// `isSocket` — except the default-`isSocket` block, which binds a real
// unix socket (not a tmux server) to prove `[ -S ]` semantics. The real
// tmux + real CLI walk lives in tests/e2e/doctor-agent-env.test.ts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnResult } from "../../../src/abstractions/spawn.ts";
import type { LoadedCockpit } from "../../../src/core/cockpit.ts";
import type { Team } from "../../../src/schema/team.ts";
import {
  AGENT_SHELL_ENV_MARKERS,
  type AtmuxServerSocket,
  agentEnvRemedy,
  checkAgentShellEnv,
  discoverAtmuxServerSockets,
  findAgentEnvMarkers,
  type TmuxSpawn,
} from "../../../src/verbs/doctor.ts";

const UID = process.getuid?.() ?? 0;

function result(stdout: string, exitCode = 0): SpawnResult {
  return { cmd: "tmux", argv: [], exitCode, signalled: null, stdout, stderr: "", durationMs: 0 };
}

/** Records every argv; answers `has-session` / `show-environment` per socket. */
function fakeTmux(bySocket: Record<string, { alive?: boolean; env?: string; envExit?: number }>): {
  spawn: TmuxSpawn;
  calls: string[][];
} {
  const calls: string[][] = [];
  const spawn: TmuxSpawn = async (argv) => {
    calls.push([...argv]);
    const socket = argv[1] ?? "";
    const s = bySocket[socket] ?? {};
    if (argv[2] === "has-session") return result("", s.alive === false ? 1 : 0);
    return result(s.env ?? "", s.envExit ?? 0);
  };
  return { spawn, calls };
}

// ---------- The marker constant ----------

describe("AGENT_SHELL_ENV_MARKERS", () => {
  test("carries the required markers with the required match rules", () => {
    const byName = new Map(AGENT_SHELL_ENV_MARKERS.map((m) => [m.name, m.values]));
    // Any value.
    expect(byName.has("AGENT")).toBe(true);
    expect(byName.get("AGENT")).toBeUndefined();
    expect(byName.has("CI")).toBe(true);
    expect(byName.get("CI")).toBeUndefined();
    expect(byName.has("NO_COLOR")).toBe(true);
    expect(byName.get("NO_COLOR")).toBeUndefined();
    // Only the harness value.
    expect(byName.get("EDITOR")).toEqual(["true"]);
    expect(byName.get("VISUAL")).toEqual(["true"]);
    expect(byName.get("GIT_EDITOR")).toEqual(["true"]);
  });

  test("never flags CLAUDECODE — atmux sets it on every claude launch", () => {
    expect(AGENT_SHELL_ENV_MARKERS.some((m) => m.name === "CLAUDECODE")).toBe(false);
  });

  test("never flags TERM — inert in panes, and left unscrubbed on purpose", () => {
    expect(AGENT_SHELL_ENV_MARKERS.some((m) => m.name === "TERM")).toBe(false);
  });

  test("is frozen", () => {
    expect(Object.isFrozen(AGENT_SHELL_ENV_MARKERS)).toBe(true);
  });
});

// ---------- findAgentEnvMarkers ----------

describe("findAgentEnvMarkers", () => {
  test("omp's non-interactive env → every marker, in marker order (its TERM=dumb ignored)", () => {
    const out = [
      "SSH_ASKPASS=/usr/bin/false",
      "PAGER=cat",
      "HOME=/Users/x",
      "AGENT=1",
      "CI=true",
      "NO_COLOR=1",
      "TERM=dumb",
      "EDITOR=true",
      "VISUAL=true",
      "GIT_EDITOR=true",
      "GIT_PAGER=cat",
      "GIT_TERMINAL_PROMPT=0",
      "",
    ].join("\n");
    expect(findAgentEnvMarkers(out)).toEqual(AGENT_SHELL_ENV_MARKERS.map((m) => m.name));
  });

  test("a clean human-started server → nothing", () => {
    const out = [
      "COLORTERM=truecolor",
      "EDITOR=nvim",
      "HOME=/Users/x",
      "-NO_COLOR",
      "PAGER=less",
      "SSH_ASKPASS=/opt/homebrew/bin/ssh-askpass",
      "TERM=xterm-256color",
      "",
    ].join("\n");
    expect(findAgentEnvMarkers(out)).toEqual([]);
  });

  test("`-NO_COLOR` (tmux removal mark) is healthy; `NO_COLOR=` set empty is a finding", () => {
    expect(findAgentEnvMarkers("-NO_COLOR\n")).toEqual([]);
    expect(findAgentEnvMarkers("NO_COLOR=\n")).toEqual(["NO_COLOR"]);
  });

  test("any-value markers fire on any value; valued markers only on the harness value", () => {
    expect(findAgentEnvMarkers("CI=1\nAGENT=yes\n")).toEqual(["AGENT", "CI"]);
    expect(findAgentEnvMarkers("GIT_PAGER=cat\n")).toEqual(["GIT_PAGER"]);
    expect(findAgentEnvMarkers("GIT_PAGER=less\n")).toEqual([]);
    expect(findAgentEnvMarkers("SSH_ASKPASS=/bin/false\n")).toEqual(["SSH_ASKPASS"]);
    // TERM is not a marker at all, whatever its value.
    expect(findAgentEnvMarkers("TERM=dumb\n")).toEqual([]);
  });

  test("a value containing `=` is compared whole", () => {
    expect(findAgentEnvMarkers("EDITOR=true=1\n")).toEqual([]);
  });

  test("custom marker list is honoured", () => {
    expect(findAgentEnvMarkers("X=1\nY=2\n", [{ name: "Y", values: ["2"] }])).toEqual(["Y"]);
  });
});

// ---------- agentEnvRemedy ----------

describe("agentEnvRemedy", () => {
  test("one `set-environment -g -u` per variable, plus the running-panes caveat", () => {
    expect(agentEnvRemedy("/tmp/atmux-x/sock", ["AGENT", "CI"])).toBe(
      "tmux -S /tmp/atmux-x/sock set-environment -g -u AGENT; " +
        "tmux -S /tmp/atmux-x/sock set-environment -g -u CI — " +
        "panes already running keep the old environment until their processes restart",
    );
  });
});

// ---------- discoverAtmuxServerSockets ----------

describe("discoverAtmuxServerSockets", () => {
  test("no cockpit, no current team → the cockpit socket path only", async () => {
    const got = await discoverAtmuxServerSockets(null, {
      env: { TMUX_TMPDIR: "/scratch/tt", ATMUX_COCKPIT_SOCKET: "ck" },
      loadCockpitFn: async () => null,
    });
    expect(got).toEqual([{ socket: `/scratch/tt/tmux-${UID}/ck`, owner: "cockpit" }]);
  });

  test("walks groups (disabled too) + every team convention, dedups, then the current team", async () => {
    const cockpit = {
      sessions: [
        {
          type: "group",
          name: "g1",
          enabled: true,
          sessions: [
            {
              type: "team",
              name: "ta",
              enabled: true,
              root: "/r/ta",
              sessions: [{ type: "team", name: "tn", enabled: false, root: "/r/tn", sessions: [] }],
            },
          ],
        },
        { type: "group", name: "g2", enabled: false, sessions: [] },
        { type: "superdriver", name: "_superdriver", enabled: true },
        { type: "team", name: "tb", enabled: true, root: "/r/tb", sessions: [] },
      ],
    } as unknown as LoadedCockpit;
    const rosters: Record<string, Team> = {
      "/r/ta": { name: "ta", tmuxTmpdir: "/r/ta/.atmux/tmux", members: [] } as unknown as Team,
      "/r/tn": { name: "tn", tmuxTmpdir: "/elsewhere/tn", members: [] } as unknown as Team,
    };
    const current = { name: "tb", members: [] } as unknown as Team;
    const got = await discoverAtmuxServerSockets(current, {
      env: { TMUX_TMPDIR: "" },
      loadCockpitFn: async () => cockpit,
      loadTeamForRoot: async (root) => rosters[root] ?? null,
    });
    expect(got).toEqual([
      { socket: `/tmp/tmux-${UID}/atmux-cockpit`, owner: "cockpit" },
      { socket: "/tmp/atmux-grp-g1/sock", owner: "group g1" },
      { socket: "/tmp/atmux-grp-g2/sock", owner: "group g2" },
      // ta: roster path == per-team path, so it appears once.
      { socket: `/r/ta/.atmux/tmux/tmux-${UID}/default`, owner: "team ta" },
      { socket: "/tmp/atmux-ta/sock", owner: "team ta" },
      // tn (disabled, nested under ta): roster tmuxTmpdir differs from the per-team path.
      { socket: `/elsewhere/tn/tmux-${UID}/default`, owner: "team tn" },
      { socket: "/tmp/atmux-tn/sock", owner: "team tn" },
      { socket: `/r/tn/.atmux/tmux/tmux-${UID}/default`, owner: "team tn" },
      // tb: no roster; the current team resolves to its legacy socket — already listed.
      { socket: "/tmp/atmux-tb/sock", owner: "team tb" },
      { socket: `/r/tb/.atmux/tmux/tmux-${UID}/default`, owner: "team tb" },
    ]);
  });

  describe("default loaders (real files)", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "atmux-agentenv-disc-"));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    test("reads cockpit.json via ATMUX_COCKPIT_CONFIG and each root's team.json", async () => {
      const good = join(dir, "good");
      const bad = join(dir, "bad");
      const none = join(dir, "none");
      await mkdir(join(good, ".atmux"), { recursive: true });
      await mkdir(join(bad, ".atmux"), { recursive: true });
      await writeFile(
        join(good, ".atmux", "team.json"),
        JSON.stringify({ name: "good", tmuxTmpdir: join(dir, "tt-good"), members: [] }),
      );
      await writeFile(join(bad, ".atmux", "team.json"), "{ not json");
      const cfg = join(dir, "cockpit.json");
      await writeFile(
        cfg,
        JSON.stringify({
          schemaVersion: 1,
          sessions: [
            { type: "team", name: "good", root: good },
            { type: "team", name: "bad", root: bad },
            { type: "team", name: "none", root: none },
          ],
        }),
      );
      const got = await discoverAtmuxServerSockets(null, {
        env: { ATMUX_COCKPIT_CONFIG: cfg, TMUX_TMPDIR: dir },
      });
      const sockets = got.map((s) => s.socket);
      // team.json honoured for `good` …
      expect(sockets).toContain(join(dir, "tt-good", `tmux-${UID}`, "default"));
      // … and a malformed / absent team.json still leaves the path conventions probed.
      expect(sockets).toContain("/tmp/atmux-bad/sock");
      expect(sockets).toContain(join(bad, ".atmux", "tmux", `tmux-${UID}`, "default"));
      expect(sockets).toContain("/tmp/atmux-none/sock");
      expect(got[0]).toEqual({
        socket: join(dir, `tmux-${UID}`, "atmux-cockpit"),
        owner: "cockpit",
      });
    });

    test("missing cockpit.json → cockpit socket only, no throw", async () => {
      const got = await discoverAtmuxServerSockets(null, {
        env: { ATMUX_COCKPIT_CONFIG: join(dir, "absent.json"), TMUX_TMPDIR: dir },
      });
      expect(got).toEqual([
        { socket: join(dir, `tmux-${UID}`, "atmux-cockpit"), owner: "cockpit" },
      ]);
    });
  });
});

// ---------- checkAgentShellEnv ----------

describe("checkAgentShellEnv", () => {
  const S1: AtmuxServerSocket = { socket: "/s/one", owner: "team one" };
  const S2: AtmuxServerSocket = { socket: "/s/two", owner: "group two" };
  const everySocket = async () => true;

  test("polluted server → one yellow row naming socket + variable NAMES, never values", async () => {
    const { spawn, calls } = fakeTmux({
      "/s/one": { env: "AGENT=1\nCI=sentinel-value-xyz\nEDITOR=true\n-NO_COLOR\nHOME=/h\n" },
    });
    const rows = await checkAgentShellEnv(null, {
      sockets: [S1],
      tmux: spawn,
      isSocket: everySocket,
    });
    expect(rows).toEqual([
      {
        status: "yellow",
        label: "tmux-agent-env",
        detail: "team one server /s/one carries agent-shell env: AGENT, CI, EDITOR",
        hint: agentEnvRemedy("/s/one", ["AGENT", "CI", "EDITOR"]),
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain("sentinel-value-xyz");
    expect(calls).toEqual([
      ["-S", "/s/one", "has-session"],
      ["-S", "/s/one", "show-environment", "-g"],
    ]);
  });

  test("clean server → no row", async () => {
    const { spawn } = fakeTmux({ "/s/one": { env: "-NO_COLOR\nTERM=xterm-256color\n" } });
    expect(
      await checkAgentShellEnv(null, { sockets: [S1], tmux: spawn, isSocket: everySocket }),
    ).toEqual([]);
  });

  test("socket file absent → skipped without running tmux at all", async () => {
    const { spawn, calls } = fakeTmux({});
    const rows = await checkAgentShellEnv(null, {
      sockets: [S1, S2],
      tmux: spawn,
      isSocket: async () => false,
    });
    expect(rows).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("stale socket / no session → skipped before show-environment", async () => {
    const { spawn, calls } = fakeTmux({ "/s/one": { alive: false, env: "AGENT=1\n" } });
    expect(
      await checkAgentShellEnv(null, { sockets: [S1], tmux: spawn, isSocket: everySocket }),
    ).toEqual([]);
    expect(calls).toEqual([["-S", "/s/one", "has-session"]]);
  });

  test("show-environment failing → skipped", async () => {
    const { spawn } = fakeTmux({ "/s/one": { env: "AGENT=1\n", envExit: 1 } });
    expect(
      await checkAgentShellEnv(null, { sockets: [S1], tmux: spawn, isSocket: everySocket }),
    ).toEqual([]);
  });

  test("tmux spawn throwing → that socket skipped, the next still probed", async () => {
    const calls: string[] = [];
    const spawn: TmuxSpawn = async (argv) => {
      calls.push(argv[1] ?? "");
      if (argv[1] === "/s/one") throw new Error("spawn miss");
      return result(argv[2] === "has-session" ? "" : "CI=true\n");
    };
    const rows = await checkAgentShellEnv(null, {
      sockets: [S1, S2],
      tmux: spawn,
      isSocket: everySocket,
    });
    expect(rows.map((r) => r.detail)).toEqual([
      "group two server /s/two carries agent-shell env: CI",
    ]);
    expect(calls).toEqual(["/s/one", "/s/two", "/s/two"]);
  });

  test("without a sockets override, probes what discovery returns", async () => {
    const { spawn } = fakeTmux({ [`/d/tmux-${UID}/ck`]: { env: "PAGER=cat\n" } });
    const probed: string[] = [];
    const rows = await checkAgentShellEnv(null, {
      env: { TMUX_TMPDIR: "/d", ATMUX_COCKPIT_SOCKET: "ck" },
      loadCockpitFn: async () => null,
      tmux: spawn,
      isSocket: async (p) => {
        probed.push(p);
        return true;
      },
    });
    expect(probed).toEqual([`/d/tmux-${UID}/ck`]);
    expect(rows.map((r) => r.detail)).toEqual([
      `cockpit server /d/tmux-${UID}/ck carries agent-shell env: PAGER`,
    ]);
  });

  describe("default isSocket (`[ -S ]`)", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "atmux-agentenv-sock-"));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    test("a real socket file is probed; a regular file and a missing path are not", async () => {
      const sockPath = join(dir, "live.sock");
      const regular = join(dir, "regular");
      await writeFile(regular, "");
      const listener = Bun.listen({ unix: sockPath, socket: { data() {} } });
      try {
        const { spawn, calls } = fakeTmux({ [sockPath]: { env: "GIT_EDITOR=true\n" } });
        const rows = await checkAgentShellEnv(null, {
          sockets: [
            { socket: sockPath, owner: "team live" },
            { socket: regular, owner: "team regular" },
            { socket: join(dir, "missing"), owner: "team missing" },
          ],
          tmux: spawn,
        });
        expect(rows.map((r) => r.detail)).toEqual([
          `team live server ${sockPath} carries agent-shell env: GIT_EDITOR`,
        ]);
        expect(new Set(calls.map((c) => c[1]))).toEqual(new Set([sockPath]));
      } finally {
        listener.stop(true);
      }
    });
  });

  test("default tmux spawn is never reached when no socket file exists", async () => {
    const rows = await checkAgentShellEnv(null, {
      sockets: [{ socket: "/nonexistent/atmux-agentenv/sock", owner: "team ghost" }],
    });
    expect(rows).toEqual([]);
  });
});
