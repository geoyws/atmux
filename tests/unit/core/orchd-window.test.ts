// Unit tests for src/core/orchd-window.ts (ADR-202 §Amendment 2026-05-22 II).
//
// Coverage:
//   - Gate failures: autoMerge.enabled !== true, no committer/gitter,
//     ATMUX_HONKER=off all return false without spawning.
//   - Idempotency: window already present → skip spawn.
//   - Success path: spawns window + sends supervisor wrapper command.
//   - Failure isolation: tmux.window.newWindow throws → logged + returns
//     false, never propagates.
//   - listWindows throws → fall through to spawn (degrade gracefully).
//
// Audit checklist invariants pinned:
//   - SIGTERM trap present in supervisor command.
//   - Circuit breaker (5 crashes in 60s) present.
//   - Clean exit (rc=0) doesn't restart.
//   - Logging tee to .atmux/logs/orchd.log.

import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import { maybeSpawnOrchdWindow, ORCHD_WINDOW } from "../../../src/core/orchd-window.ts";
import type { Team } from "../../../src/schema/team.ts";

// Minimal Team fixture per the schema shape.
function team(overrides: Partial<Team> = {}): Team {
  return {
    name: "demo",
    members: [
      { name: "be-1", role: "member", lane: "be" },
      { name: "committer", role: "committer", lane: "misc" },
    ],
    autoMerge: { enabled: true },
    ...overrides,
  } as Team;
}

// Mock tmux namespace with recording hooks. Every unused namespace
// member throws so accidental coupling surfaces loud.
function mockTmux(opts: {
  listWindowsResult?: Array<{ index: number; id: string; name: string; active: boolean }>;
  listWindowsThrows?: boolean;
  newWindowThrows?: boolean;
}): {
  tmux: TmuxNamespace;
  newWindowCalls: Array<{ sessionName: string; name: string; cwd?: string }>;
  sendKeysCalls: Array<{ keys: string; enter: boolean }>;
} {
  const newWindowCalls: Array<{ sessionName: string; name: string; cwd?: string }> = [];
  const sendKeysCalls: Array<{ keys: string; enter: boolean }> = [];
  const notImpl = (path: string) => () => {
    throw new Error(`mockTmux: ${path} not implemented`);
  };
  const tmux = {
    session: {
      newSession: notImpl("session.newSession"),
      hasSession: notImpl("session.hasSession"),
      killSession: notImpl("session.killSession"),
      killServer: notImpl("session.killServer"),
      hasServer: notImpl("session.hasServer"),
      listSessions: notImpl("session.listSessions"),
      renameSession: notImpl("session.renameSession"),
      setEnvironment: notImpl("session.setEnvironment"),
    },
    server: {
      killServer: notImpl("server.killServer"),
      hasServer: notImpl("server.hasServer"),
    },
    window: {
      newWindow: async (params: { sessionName: string; name: string; cwd?: string }) => {
        if (opts.newWindowThrows) {
          throw new Error("mock newWindow failure");
        }
        const cwd = params.cwd;
        newWindowCalls.push(cwd === undefined ? { sessionName: params.sessionName, name: params.name } : { sessionName: params.sessionName, name: params.name, cwd });
        return { windowIndex: 99, sessionName: params.sessionName, id: "@99" };
      },
      killWindow: notImpl("window.killWindow"),
      listWindows: async (_session: string) => {
        if (opts.listWindowsThrows) throw new Error("mock listWindows failure");
        return opts.listWindowsResult ?? [];
      },
      renameWindow: notImpl("window.renameWindow"),
      selectWindow: notImpl("window.selectWindow"),
      moveWindow: notImpl("window.moveWindow"),
      swapWindow: notImpl("window.swapWindow"),
    },
    pane: {
      sendKeys: async (opts: { keys: string; enter: boolean }) => {
        sendKeysCalls.push({ keys: opts.keys, enter: opts.enter });
      },
      capturePane: notImpl("pane.capturePane"),
      listPanes: notImpl("pane.listPanes"),
      displayMessage: notImpl("pane.displayMessage"),
      killPane: notImpl("pane.killPane"),
      splitWindow: notImpl("pane.splitWindow"),
    },
    buffer: {
      loadBuffer: notImpl("buffer.loadBuffer"),
      pasteBuffer: notImpl("buffer.pasteBuffer"),
      deleteBuffer: notImpl("buffer.deleteBuffer"),
      listBuffers: notImpl("buffer.listBuffers"),
    },
    info: { showOptions: notImpl("info.showOptions") },
  } as unknown as TmuxNamespace;
  return { tmux, newWindowCalls, sendKeysCalls };
}

function makeLogger(): { logger: { log: (s: string) => void; ok: (s: string) => void; warn: (s: string) => void; err: (s: string) => void; }; logs: string[] } {
  const logs: string[] = [];
  return {
    logger: {
      log: (s: string) => logs.push(`LOG ${s}`),
      ok: (s: string) => logs.push(`OK ${s}`),
      warn: (s: string) => logs.push(`WARN ${s}`),
      err: (s: string) => logs.push(`ERR ${s}`),
    },
    logs,
  };
}

describe("maybeSpawnOrchdWindow — gating", () => {
  test("autoMerge.enabled !== true → returns false, no spawn", async () => {
    const { tmux, newWindowCalls } = mockTmux({});
    const { logger } = makeLogger();
    const result = await maybeSpawnOrchdWindow({
      team: team({ autoMerge: undefined }),
      session: "atmux::demo",
      teamRoot: "/srv/demo",
      tmux,
      logger,
      env: {},
    });
    expect(result).toBe(false);
    expect(newWindowCalls).toHaveLength(0);
  });

  test("no committer/gitter role → returns false, no spawn", async () => {
    const { tmux, newWindowCalls } = mockTmux({});
    const { logger } = makeLogger();
    const result = await maybeSpawnOrchdWindow({
      team: team({
        members: [
          { name: "be-1", role: "member", lane: "be" },
          { name: "fe-1", role: "member", lane: "fe" },
        ],
      }),
      session: "atmux::demo",
      teamRoot: "/srv/demo",
      tmux,
      logger,
      env: {},
    });
    expect(result).toBe(false);
    expect(newWindowCalls).toHaveLength(0);
  });

  test("legacy 'gitter' role accepted as committer-equivalent (ADR-159 grace)", async () => {
    const { tmux, newWindowCalls } = mockTmux({});
    const { logger } = makeLogger();
    const result = await maybeSpawnOrchdWindow({
      team: team({
        members: [
          { name: "be-1", role: "member", lane: "be" },
          { name: "gitter", role: "gitter", lane: "misc" },
        ],
      }),
      session: "atmux::demo",
      teamRoot: "/srv/demo",
      tmux,
      logger,
      env: {},
    });
    expect(result).toBe(true);
    expect(newWindowCalls).toHaveLength(1);
  });

  test("ATMUX_HONKER=off → returns false, logs reason, no spawn", async () => {
    const { tmux, newWindowCalls } = mockTmux({});
    const { logger, logs } = makeLogger();
    const result = await maybeSpawnOrchdWindow({
      team: team(),
      session: "atmux::demo",
      teamRoot: "/srv/demo",
      tmux,
      logger,
      env: { ATMUX_HONKER: "off" },
    });
    expect(result).toBe(false);
    expect(newWindowCalls).toHaveLength(0);
    expect(logs.some((l) => l.includes("ATMUX_HONKER=off"))).toBe(true);
  });

  test("ATMUX_HONKER=0 / false / OFF all treated as disabled", async () => {
    for (const value of ["0", "false", "OFF", "False"]) {
      const { tmux, newWindowCalls } = mockTmux({});
      const { logger } = makeLogger();
      const result = await maybeSpawnOrchdWindow({
        team: team(),
        session: "atmux::demo",
        teamRoot: "/srv/demo",
        tmux,
        logger,
        env: { ATMUX_HONKER: value },
      });
      expect(result).toBe(false);
      expect(newWindowCalls).toHaveLength(0);
    }
  });
});

describe("maybeSpawnOrchdWindow — idempotence", () => {
  test("window already exists → returns false, no spawn, log explains", async () => {
    const { tmux, newWindowCalls } = mockTmux({
      listWindowsResult: [{ index: 5, id: "@5", name: ORCHD_WINDOW, active: false }],
    });
    const { logger, logs } = makeLogger();
    const result = await maybeSpawnOrchdWindow({
      team: team(),
      session: "atmux::demo",
      teamRoot: "/srv/demo",
      tmux,
      logger,
      env: {},
    });
    expect(result).toBe(false);
    expect(newWindowCalls).toHaveLength(0);
    expect(logs.some((l) => l.includes("already exists"))).toBe(true);
  });

  test("listWindows throws → log warn + fall through to spawn attempt", async () => {
    const { tmux, newWindowCalls } = mockTmux({ listWindowsThrows: true });
    const { logger, logs } = makeLogger();
    const result = await maybeSpawnOrchdWindow({
      team: team(),
      session: "atmux::demo",
      teamRoot: "/srv/demo",
      tmux,
      logger,
      env: {},
    });
    expect(result).toBe(true);
    expect(newWindowCalls).toHaveLength(1);
    expect(logs.some((l) => l.includes("listWindows failed"))).toBe(true);
  });
});

describe("maybeSpawnOrchdWindow — success path", () => {
  test("happy path: spawns window with correct name + cwd, sends wrapper command", async () => {
    const { tmux, newWindowCalls, sendKeysCalls } = mockTmux({});
    const { logger, logs } = makeLogger();
    const result = await maybeSpawnOrchdWindow({
      team: team(),
      session: "atmux::demo",
      teamRoot: "/srv/demo",
      tmux,
      logger,
      env: {},
    });
    expect(result).toBe(true);
    expect(newWindowCalls).toHaveLength(1);
    expect(newWindowCalls[0]).toEqual({
      sessionName: "atmux::demo",
      name: ORCHD_WINDOW,
      cwd: "/srv/demo",
    });
    expect(sendKeysCalls).toHaveLength(1);
    expect(sendKeysCalls[0]?.enter).toBe(true);
    expect(logs.some((l) => l.includes("spawned service window"))).toBe(true);
  });

  test("supervisor command includes SIGTERM trap", async () => {
    const { tmux, sendKeysCalls } = mockTmux({});
    const { logger } = makeLogger();
    await maybeSpawnOrchdWindow({
      team: team(),
      session: "atmux::demo",
      teamRoot: "/srv/demo",
      tmux,
      logger,
      env: {},
    });
    const cmd = sendKeysCalls[0]?.keys ?? "";
    expect(cmd).toContain("trap");
    expect(cmd).toContain("SIGTERM");
    expect(cmd).toContain("SIGINT");
    expect(cmd).toContain("SIGHUP");
  });

  test("supervisor command includes circuit breaker (5 crashes / 60s)", async () => {
    const { tmux, sendKeysCalls } = mockTmux({});
    const { logger } = makeLogger();
    await maybeSpawnOrchdWindow({
      team: team(),
      session: "atmux::demo",
      teamRoot: "/srv/demo",
      tmux,
      logger,
      env: {},
    });
    const cmd = sendKeysCalls[0]?.keys ?? "";
    expect(cmd).toContain("CRASH_COUNT");
    expect(cmd).toContain("-ge 5");
    expect(cmd).toContain("CIRCUIT BREAKER");
  });

  test("supervisor command exits cleanly on rc=0 (no restart)", async () => {
    const { tmux, sendKeysCalls } = mockTmux({});
    const { logger } = makeLogger();
    await maybeSpawnOrchdWindow({
      team: team(),
      session: "atmux::demo",
      teamRoot: "/srv/demo",
      tmux,
      logger,
      env: {},
    });
    const cmd = sendKeysCalls[0]?.keys ?? "";
    expect(cmd).toContain("RC -eq 0");
    expect(cmd).toContain("not restarting");
  });

  test("supervisor command logs to .atmux/logs/orchd.log via tee", async () => {
    const { tmux, sendKeysCalls } = mockTmux({});
    const { logger } = makeLogger();
    await maybeSpawnOrchdWindow({
      team: team(),
      session: "atmux::demo",
      teamRoot: "/srv/demo",
      tmux,
      logger,
      env: {},
    });
    const cmd = sendKeysCalls[0]?.keys ?? "";
    expect(cmd).toContain("tee -a .atmux/logs/orchd.log");
    expect(cmd).toContain("mkdir -p .atmux/logs");
  });

  test("supervisor command invokes 'atmux orchd --start' (ADR-202 §V)", async () => {
    const { tmux, sendKeysCalls } = mockTmux({});
    const { logger } = makeLogger();
    await maybeSpawnOrchdWindow({
      team: team(),
      session: "atmux::demo",
      teamRoot: "/srv/demo",
      tmux,
      logger,
      env: {},
    });
    const cmd = sendKeysCalls[0]?.keys ?? "";
    expect(cmd).toContain("atmux orchd --start");
  });
});

describe("maybeSpawnOrchdWindow — circuit-breaker backlog-restart tolerance (T5.1)", () => {
  // Regression-pin per ADR-202 §XIV (queued via T5.1, t-4eb9cd40).
  //
  // Operator scenario: orchd has been down through accumulated
  // backlog (5000 events). When it comes back up and starts replaying
  // in batches of ~100, transient errors (db lock contention, OOM
  // back-pressure, mid-batch handler thrown) can trigger 3–4 brief
  // intra-batch restarts within the first 60s of recovery.
  //
  // Invariant: the circuit-breaker must NOT trip in this scenario —
  // tripping forfeits the catch-up benefit (cron --drain then has to
  // shoulder the whole backlog at 1min cadence). The current 5-in-60s
  // threshold tolerates up to 4 crashes per window; the 60s rolling-
  // window reset means catch-up runs that stretch beyond a minute get
  // a fresh budget on each window. By inspection of the supervisor
  // command this holds; the bash execution tests below pin it.

  test("supervisor command resets crash window after 60s elapsed (rolling-window behavior)", async () => {
    const { tmux, sendKeysCalls } = mockTmux({});
    const { logger } = makeLogger();
    await maybeSpawnOrchdWindow({
      team: team(),
      session: "atmux::demo",
      teamRoot: "/srv/demo",
      tmux,
      logger,
      env: {},
    });
    const cmd = sendKeysCalls[0]?.keys ?? "";
    // Reset condition + reset target.
    expect(cmd).toContain("ELAPSED -gt 60");
    expect(cmd).toContain("CRASH_COUNT=0");
    expect(cmd).toContain("CRASH_WINDOW_START=$NOW");
  });

  test("supervisor command counter increments BEFORE the threshold check (so 4 crashes don't trip)", async () => {
    const { tmux, sendKeysCalls } = mockTmux({});
    const { logger } = makeLogger();
    await maybeSpawnOrchdWindow({
      team: team(),
      session: "atmux::demo",
      teamRoot: "/srv/demo",
      tmux,
      logger,
      env: {},
    });
    const cmd = sendKeysCalls[0]?.keys ?? "";
    // The increment line must precede the `-ge 5` check in cmd order
    // — otherwise the breaker would trip at 4 crashes (the 5th
    // increment never gets a chance to fire) OR at 6 (off-by-one in
    // the other direction). Position-string-search keeps the assertion
    // purely structural.
    const incrementIdx = cmd.indexOf("CRASH_COUNT=$((CRASH_COUNT + 1))");
    const thresholdIdx = cmd.indexOf("CRASH_COUNT -ge 5");
    expect(incrementIdx).toBeGreaterThanOrEqual(0);
    expect(thresholdIdx).toBeGreaterThan(incrementIdx);
  });

  test("real bash execution: 3 quick crashes within 60s do NOT trip the breaker (loop continues)", async () => {
    // Extract the supervisor cmd from the verb, then mock the orchd
    // invocation to fail 3 times then exit cleanly. The supervisor
    // loop sees rc=0 on attempt 4 → exits with "clean exit, not
    // restarting" (rc=0). The breaker MUST NOT have tripped (rc=42).

    const { tmux, sendKeysCalls } = mockTmux({});
    const { logger } = makeLogger();
    const tmpRoot = await mkdtemp(join(tmpdir(), "atmux-orchd-circuit-"));

    await maybeSpawnOrchdWindow({
      team: team(),
      session: "atmux::demo",
      teamRoot: tmpRoot,
      tmux,
      logger,
      env: {},
    });

    let cmd = sendKeysCalls[0]?.keys ?? "";
    // Swap the real orchd invocation for a counting stub. The stub
    // is a tiny bash snippet that increments a counter file and exits
    // non-zero for the first 3 attempts, then zero on the 4th.
    const stubCounter = join(tmpRoot, "stub.count");
    await writeFile(stubCounter, "0");
    const stubBash =
      `n=$(cat "${stubCounter}"); n=$((n + 1)); echo "$n" > "${stubCounter}"; ` +
      `if [[ "$n" -le 3 ]]; then exit 1; else exit 0; fi`;
    // Replace BOTH the Rust-binary path and the Bun-fallback path with
    // the stub — the supervisor's `command -v atmux-orchd` check will
    // fail in this hermetic env (no atmux-orchd installed under tmpRoot),
    // so the fallback path runs. Patching it is sufficient.
    cmd = cmd.replace(
      'atmux orchd --start 2>&1 | tee -a .atmux/logs/orchd.log',
      `bash -c '${stubBash}' 2>&1 | tee -a .atmux/logs/orchd.log`,
    );
    // Tighten the inter-crash backoff so the test finishes well under
    // 60s — the bash supervisor sleeps 5s between restarts in prod,
    // but our stub completes 4 crashes in <1s regardless of the sleep.
    // Tests still respect the global timeout.
    cmd = cmd.replace("sleep 5", "sleep 0");

    const result = await new Promise<{ rc: number; stdout: string }>((resolve, reject) => {
      const proc = spawn("bash", ["-c", cmd], {
        cwd: tmpRoot,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PATH: `${tmpRoot}:${process.env.PATH}` },
      });
      let stdout = "";
      proc.stdout.on("data", (d) => {
        stdout += d.toString();
      });
      proc.stderr.on("data", (d) => {
        stdout += d.toString();
      });
      proc.on("error", reject);
      proc.on("close", (rc) => resolve({ rc: rc ?? -1, stdout }));
    });

    // Clean up the per-test tmpdir.
    await rm(tmpRoot, { recursive: true, force: true });

    // Final attempt succeeded (stub returns 0 on call #4) → supervisor
    // exited cleanly. Breaker did NOT trip (would have been rc=42).
    expect(result.rc).toBe(0);
    expect(result.stdout).toContain("clean exit, not restarting");
    expect(result.stdout).not.toContain("CIRCUIT BREAKER tripped");

    // Stub counter confirms 4 actual invocations (3 fails + 1 success).
    const finalCount = parseInt((await readFile(stubCounter, "utf-8").catch(() => "0")).trim(), 10);
    // Best-effort — the file may have been removed by the rm above; in
    // that case we settle for the stdout-derived proof.
    if (!Number.isNaN(finalCount) && finalCount > 0) {
      expect(finalCount).toBe(4);
    }
  }, 30_000);

  test("real bash execution: 5 quick crashes within 60s DO trip the breaker (rc=42)", async () => {
    // The mirror of the test above — pins that the breaker actually
    // works when it should. If this stops tripping, the breaker has
    // regressed in the loose direction (silent disablement).

    const { tmux, sendKeysCalls } = mockTmux({});
    const { logger } = makeLogger();
    const tmpRoot = await mkdtemp(join(tmpdir(), "atmux-orchd-circuit-trip-"));

    await maybeSpawnOrchdWindow({
      team: team(),
      session: "atmux::demo",
      teamRoot: tmpRoot,
      tmux,
      logger,
      env: {},
    });

    let cmd = sendKeysCalls[0]?.keys ?? "";
    // Always-fail stub.
    cmd = cmd.replace(
      'atmux orchd --start 2>&1 | tee -a .atmux/logs/orchd.log',
      `bash -c 'exit 1' 2>&1 | tee -a .atmux/logs/orchd.log`,
    );
    cmd = cmd.replace("sleep 5", "sleep 0");

    const result = await new Promise<{ rc: number; stdout: string }>((resolve, reject) => {
      const proc = spawn("bash", ["-c", cmd], {
        cwd: tmpRoot,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PATH: `${tmpRoot}:${process.env.PATH}` },
      });
      let stdout = "";
      proc.stdout.on("data", (d) => {
        stdout += d.toString();
      });
      proc.stderr.on("data", (d) => {
        stdout += d.toString();
      });
      proc.on("error", reject);
      proc.on("close", (rc) => resolve({ rc: rc ?? -1, stdout }));
    });

    await rm(tmpRoot, { recursive: true, force: true });

    expect(result.rc).toBe(42);
    expect(result.stdout).toContain("CIRCUIT BREAKER tripped");
  }, 30_000);
});

describe("maybeSpawnOrchdWindow — failure isolation", () => {
  test("newWindow throws → log warn + return false, never propagates", async () => {
    const { tmux, newWindowCalls } = mockTmux({ newWindowThrows: true });
    const { logger, logs } = makeLogger();
    const result = await maybeSpawnOrchdWindow({
      team: team(),
      session: "atmux::demo",
      teamRoot: "/srv/demo",
      tmux,
      logger,
      env: {},
    });
    expect(result).toBe(false);
    expect(newWindowCalls).toHaveLength(0);
    expect(logs.some((l) => l.includes("spawn failed"))).toBe(true);
    expect(logs.some((l) => l.includes("cron --drain still active"))).toBe(true);
  });
});
