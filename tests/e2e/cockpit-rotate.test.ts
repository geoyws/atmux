// ADR-167 T7 — real-tmux integration coverage for `atmux cockpit rotate`.
//
// Spins a hermetic synthetic cockpit cage under a per-test TMUX_TMPDIR
// + ATMUX_COCKPIT_SOCKET override, seeds a HOME with cockpit.json +
// per-role session-start markers + a stub `claude` wrapper on PATH,
// then invokes `cockpitRotate(...)` directly so each run exercises the
// direct-verb path (gate matrix → handoff write → send-keys seam →
// kill-window → new-window → audit row) against a real tmux server.
//
// Six runs cover the operator-visible round-trip per ADR-167 §Decision
// + §Pre-flight gate matrix + §Per-role respawn matrix + §Ordering
// invariant + T5 handoff-write-failed atomicity (PANE NOT TOUCHED on
// handoff write fail per be-2 T5 057ec5f):
//   1. medic rotation success (Plan A — real resolver, stub claude on PATH)
//   2. gate-4 superdriver-refuse (unconditional; --force has no effect)
//   3. gate-3 uptime refusal + --force bypass
//   4. gate-1 user-typing refusal (cockpit _sd compose box)
//   5. team-driver rotation, cage socket unaffected (cockpit verb scope)
//   6. handoff-write-failed atomicity (Plan B — injected atomicWrite +
//      tmuxFactory recorder asserts killWindow/newWindow/sendKeys
//      NEVER called → recovery-posture proof)
//
// Skipped when tmux binary is absent (CI without tmux).
//
// Pattern adapted from tests/e2e/resolve-team-socket.test.ts (real tmux +
// TMUX_TMPDIR isolation) + cockpit-rotate unit harness for the seam
// shapes (loadCockpit, tmuxFactory, atomicWrite).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TmuxConfig, TmuxNamespace } from "../../src/abstractions/tmux.ts";
import type { LoadedCockpit } from "../../src/core/cockpit.ts";
import {
  type CockpitRotateAuditRow,
  cockpitRotate,
  handoffPayloadPath,
} from "../../src/verbs/cockpit-rotate.ts";
import { CANONICAL_ATMUX_TMUX_CONF_PATH, PORTABLE_KEEPALIVE_COMMAND } from "../helpers/tmux.ts";

// ---------- environment probe ----------

function probeBin(cmd: string[]): boolean {
  try {
    const proc = Bun.spawnSync({ cmd, stdout: "ignore", stderr: "ignore" });
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

const HAS_TMUX = probeBin(["tmux", "-V"]);

const COCKPIT_SOCKET = "atmux-cockpit-rotate-t7";
const COCKPIT_SESSION = "atmux_cockpit";

// ---------- helpers ----------

interface Hermetic {
  workDir: string;
  homeDir: string;
  tmuxTmpdir: string;
  envOverride: NodeJS.ProcessEnv;
  /** Captured stderr from cockpitRotate calls. Reset per run. */
  stderrBuf: string[];
  /** Audit-log path for assertions. */
  auditLogPath: string;
}

/** Run a tmux subcommand against the synthetic cockpit cage. Explicit
 *  env-spread is REQUIRED — Bun.spawnSync without an explicit `env`
 *  caches the parent's env at Bun process start and ignores subsequent
 *  process.env mutations (verified 2026-05-17 with isolation repro).
 *  Spreading process.env at call-site picks up the beforeEach HOME /
 *  TMUX_TMPDIR / ATMUX_COCKPIT_SOCKET overrides so this test's tmux
 *  calls hit the SAME socket the verb's spawn() will hit. Global tmux
 *  flags precede the subcommand so the server starts with the canonical
 *  atmux config file instead of the host default. */
function spawnTmux(
  socketName: string,
  argv: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): {
  exitCode: number | null;
  stdout: string;
  stderr: string;
} {
  const env = { ...process.env, ...extraEnv };
  delete env.TMUX;
  const proc = Bun.spawnSync({
    cmd: ["tmux", "-f", CANONICAL_ATMUX_TMUX_CONF_PATH, "-L", socketName, ...argv],
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout?.toString() ?? "",
    stderr: proc.stderr?.toString() ?? "",
  };
}

function tmuxCage(
  _hermetic: Hermetic,
  argv: string[],
): { exitCode: number | null; stdout: string; stderr: string } {
  return spawnTmux(COCKPIT_SOCKET, argv);
}

/** Seed a hermetic HOME with cockpit.json + per-role session-start
 *  markers (mtime ≥60min so gate-3 passes) + a stub `claude` wrapper on
 *  PATH that execs the shared portable keepalive (Plan A wrapper
 *  exercise — the real resolveClaudeWrapper resolves /root/.claude →
 *  'claude', which then resolves via $PATH to our stub). */
async function setupHermeticHome(hermetic: Hermetic): Promise<void> {
  const { homeDir } = hermetic;
  // Per-role marker dirs + cockpit.json dir + audit-log dir + bin dir.
  for (const role of ["medic", "team-alpha"]) {
    await mkdir(join(homeDir, ".claude/teams/__cockpit__", role), { recursive: true });
  }
  await mkdir(join(homeDir, ".atmux/state"), { recursive: true });
  await mkdir(join(hermetic.workDir, "bin"), { recursive: true });

  // Session-start markers — mtime set to 2h ago with Node fs.utimes.
  // Keep the 2-hour age explicit so the gate-3 threshold stays
  // satisfied on macOS/BSD/Linux without shell-specific date syntax.
  // Role literals per src/verbs/cockpit-rotate.ts::sessionStartMarkerPath:
  // medic, team-driver (NOT team-name). Plus team-alpha dir is created
  // above for handoff payload path symmetry.
  await mkdir(join(homeDir, ".claude/teams/__cockpit__/team-driver"), { recursive: true });
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  for (const role of ["medic", "team-driver"]) {
    const markerPath = join(homeDir, ".claude/teams/__cockpit__", role, "session-start.txt");
    await writeFile(markerPath, "", "utf8");
    await utimes(markerPath, twoHoursAgo, twoHoursAgo);
  }

  // cockpit.json — minimal sessions[] declaring medic + one team
  // (team-alpha) all bound to /root/.claude (→ resolver returns 'claude'
  // → PATH resolves to our stub).
  const cockpitJson = {
    sessions: [
      {
        type: "medic",
        name: "medic",
        claudeAccount: { configDir: "/root/.claude" },
      },
      {
        type: "team",
        name: "team-alpha",
        root: join(hermetic.workDir, "team-alpha-root"),
        cageMode: "autonomous",
        claudeAccount: { configDir: "/root/.claude" },
      },
    ],
  };
  await writeFile(
    join(homeDir, ".atmux/cockpit.json"),
    JSON.stringify(cockpitJson, null, 2),
    "utf8",
  );
  // team-alpha root needs to exist for buildTeamWindowCommand —
  // empty .atmux dir is enough (no .atmux/team.json read by rotate).
  await mkdir(join(hermetic.workDir, "team-alpha-root", ".atmux"), { recursive: true });

  // Stub claude wrapper on PATH — exec the shared portable keepalive so
  // the respawn newWindow's shellCommand persists past the verb's call site.
  const stubClaude = join(hermetic.workDir, "bin", "claude");
  await writeFile(
    stubClaude,
    `#!/bin/sh
exec sh -c '${PORTABLE_KEEPALIVE_COMMAND}'
`,
    { mode: 0o755 },
  );
  await chmod(stubClaude, 0o755);
}

/** Spawn the synthetic cockpit session with the 3 windows the verb
 *  reads/touches: _sd (gate-1 source), _medic, team-alpha
 *  (team-driver target). Each window runs the shared portable
 *  keepalive so they stay alive until the verb's killWindow tears
 *  them down. */
function spawnCockpitSession(hermetic: Hermetic): void {
  const newSess = tmuxCage(hermetic, [
    "new-session",
    "-d",
    "-s",
    COCKPIT_SESSION,
    "-n",
    "_sd",
    "-x",
    "200",
    "-y",
    "50",
    PORTABLE_KEEPALIVE_COMMAND,
  ]);
  expect(newSess.exitCode).toBe(0);
  for (const win of ["_medic", "team-alpha"]) {
    const w = tmuxCage(hermetic, [
      "new-window",
      "-d",
      "-t",
      `${COCKPIT_SESSION}:`,
      "-n",
      win,
      PORTABLE_KEEPALIVE_COMMAND,
    ]);
    expect(w.exitCode).toBe(0);
  }
}

/** Read + parse the last NDJSON audit row from the hermetic audit log.
 *  Returns null when the log doesn't exist yet. */
async function tailAuditRow(hermetic: Hermetic): Promise<CockpitRotateAuditRow | null> {
  try {
    const text = await readFile(hermetic.auditLogPath, "utf8");
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) return null;
    const last = lines.at(-1) ?? "";
    return JSON.parse(last) as CockpitRotateAuditRow;
  } catch {
    return null;
  }
}

/** Common cockpitRotate opts. Env is NOT passed via opts.env — the
 *  test mutates process.env in beforeEach so the tmux subprocesses
 *  spawned by the verb's abstractions inherit TMUX_TMPDIR + PATH +
 *  ATMUX_COCKPIT_SOCKET. opts.env is only honored by the verb's pure
 *  paths (caller-scope, getCockpitSocketName); the shellouts use
 *  Bun.spawn's default env which is process.env.
 *
 *  `safeSendKeysWithVerify` is permissively stubbed by default:
 *  production's verifier loops capturePane against the post-Ctrl-C
 *  pane to confirm the claude TUI is gone. In this fixture the seam
 *  advances directly to the separately asserted killWindow + newWindow
 *  behavior, so the stub returns success and the verb can continue.
 *  Plan B atomicity test (Run 6) doesn't need this stub since it
 *  injects a recording tmuxFactory that captures sendKeys calls but
 *  never propagates to real tmux. */
function rotateOpts(
  hermetic: Hermetic,
  extra: Record<string, unknown> = {},
): Parameters<typeof cockpitRotate>[1] {
  return {
    homeDir: hermetic.homeDir,
    cockpitSessionName: COCKPIT_SESSION,
    cockpitSocketName: COCKPIT_SOCKET,
    stderr: (msg: string) => hermetic.stderrBuf.push(msg),
    // Skip cadence settle — the synthetic cage has no real claude TUI
    // to wait on; autoStart helpers no-op via timeoutMs=0.
    autoStartTimeoutMs: 0,
    // Stub Discord so refusal pings don't escape the hermetic env.
    discordSend: async () => {
      /* recorded via test-local closure when needed */
    },
    // Permissive Ctrl-C send — the injected seam advances directly to
    // the separately asserted killWindow + newWindow path in this
    // fixture. Production still verifies the post-Ctrl-C pane state.
    safeSendKeysWithVerify: async () => ({
      success: true,
      attempts: 1,
      finalCapture: "",
    }),
    ...extra,
  };
}

// ---------- shared lifecycle ----------

/** Snapshot the process.env keys we mutate so afterEach can restore. */
const ENV_KEYS_MUTATED = [
  "HOME",
  "TMUX_TMPDIR",
  "ATMUX_CALLER_SCOPE",
  "ATMUX_COCKPIT_SOCKET",
  "PATH",
] as const;

async function newHermetic(): Promise<Hermetic> {
  // Keep the TMUX_TMPDIR root short enough that the eventual socket
  // path stays under macOS sun_path limits.
  const workDir = await mkdtemp("/tmp/atmux-rot-");
  const homeDir = join(workDir, "home");
  const tmuxTmpdir = join(workDir, "tmux");
  await mkdir(homeDir, { recursive: true });
  await mkdir(tmuxTmpdir, { recursive: true });

  // Snapshot the env keys we'll mutate. teardownHermetic restores.
  const envOverride: NodeJS.ProcessEnv = {};
  for (const k of ENV_KEYS_MUTATED) {
    if (process.env[k] !== undefined) envOverride[k] = process.env[k];
  }

  // Mutate process.env so tmux subprocesses (via spawn() default env)
  // inherit the hermetic config.
  process.env.HOME = homeDir;
  process.env.TMUX_TMPDIR = tmuxTmpdir;
  process.env.ATMUX_CALLER_SCOPE = "driver";
  process.env.ATMUX_COCKPIT_SOCKET = COCKPIT_SOCKET;
  process.env.PATH = `${join(workDir, "bin")}:${process.env.PATH ?? ""}`;

  return {
    workDir,
    homeDir,
    tmuxTmpdir,
    envOverride,
    stderrBuf: [],
    auditLogPath: join(homeDir, ".atmux/state/cockpit-rotate-audit.log"),
  };
}

async function teardownHermetic(hermetic: Hermetic): Promise<void> {
  // Kill the cockpit tmux server (idempotent — "no server" is fine).
  tmuxCage(hermetic, ["kill-server"]);
  await rm(hermetic.workDir, { recursive: true, force: true });
  // Restore the env keys we mutated.
  for (const k of ENV_KEYS_MUTATED) {
    if (hermetic.envOverride[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = hermetic.envOverride[k];
    }
  }
}

// ---------- tests ----------

describe.skipIf(!HAS_TMUX)("integration ADR-167 T7 — atmux cockpit rotate", () => {
  let hermetic: Hermetic;

  beforeEach(async () => {
    hermetic = await newHermetic();
    await setupHermeticHome(hermetic);
  });

  afterEach(async () => {
    await teardownHermetic(hermetic);
  });

  // ----- Run 1: medic rotation success (Plan A) -----

  test("Run 1 — medic rotation success (Plan A: real resolver via stub claude on PATH)", async () => {
    spawnCockpitSession(hermetic);
    // Capture pre-rotation _medic pane id for "pid changed" assertion.
    const preList = tmuxCage(hermetic, [
      "list-windows",
      "-t",
      COCKPIT_SESSION,
      "-F",
      "#{window_name}\t#{window_id}",
    ]);
    expect(preList.exitCode).toBe(0);
    const preMedicId = preList.stdout
      .split("\n")
      .find((l) => l.startsWith("_medic\t"))
      ?.split("\t")[1];
    expect(preMedicId).toBeDefined();

    const exit = await cockpitRotate(["medic"], rotateOpts(hermetic));
    expect(exit).toBe(0);

    // Handoff payload landed at canonical path with the Medic header.
    const handoffPath = handoffPayloadPath(hermetic.homeDir, "medic");
    const handoffText = await readFile(handoffPath, "utf8");
    expect(handoffText).toContain("# Medic handoff");

    // _medic window respawned — same name, new window id.
    const postList = tmuxCage(hermetic, [
      "list-windows",
      "-t",
      COCKPIT_SESSION,
      "-F",
      "#{window_name}\t#{window_id}",
    ]);
    const postMedicId = postList.stdout
      .split("\n")
      .find((l) => l.startsWith("_medic\t"))
      ?.split("\t")[1];
    expect(postMedicId).toBeDefined();
    expect(postMedicId).not.toBe(preMedicId);

    // Audit row outcome=success WITH handoffPath; no refusal stderr.
    const row = await tailAuditRow(hermetic);
    expect(row).not.toBeNull();
    expect(row?.outcome).toBe("success");
    expect(row?.role).toBe("medic");
    expect(row?.sessionName).toBe("medic");
    expect(row?.handoffPath).toBe(handoffPath);
    expect(hermetic.stderrBuf.join("")).not.toMatch(/^gate-\d/m);
  });

  // ----- Run 2: gate-4 superdriver-refuse (unconditional) -----

  test("Run 2 — gate-4 superdriver-refuse is unconditional (--force has NO effect)", async () => {
    spawnCockpitSession(hermetic);

    // Without --force.
    const exit1 = await cockpitRotate(["superdriver"], rotateOpts(hermetic));
    expect(exit1).toBe(65);
    expect(hermetic.stderrBuf.join("")).toMatch(/^gate-4-never-rotate-superdriver: /m);
    let row = await tailAuditRow(hermetic);
    expect(row?.outcome).toBe("gate-4-refused");
    expect(row?.sessionName).toBe("superdriver");

    // With --force — same refusal (gate-4 row 4 §Pre-flight matrix).
    hermetic.stderrBuf.length = 0;
    const exit2 = await cockpitRotate(["superdriver", "--force"], rotateOpts(hermetic));
    expect(exit2).toBe(65);
    expect(hermetic.stderrBuf.join("")).toMatch(/^gate-4-never-rotate-superdriver: /m);
    row = await tailAuditRow(hermetic);
    expect(row?.outcome).toBe("gate-4-refused");

    // _sd window untouched.
    const list = tmuxCage(hermetic, [
      "list-windows",
      "-t",
      COCKPIT_SESSION,
      "-F",
      "#{window_name}",
    ]);
    expect(list.stdout).toContain("_sd");
  });

  // ----- Run 3: gate-3 uptime refusal + --force bypass -----

  test("Run 3 — gate-3 uptime refuses fresh marker; --force bypasses", async () => {
    spawnCockpitSession(hermetic);

    // Re-touch _medic marker to NOW (mtime <60min → gate-3 refuses).
    const markerPath = join(hermetic.homeDir, ".claude/teams/__cockpit__/medic/session-start.txt");
    Bun.spawnSync({ cmd: ["touch", markerPath], stdout: "ignore", stderr: "ignore" });

    const exit1 = await cockpitRotate(["medic"], rotateOpts(hermetic));
    expect(exit1).toBe(65);
    expect(hermetic.stderrBuf.join("")).toMatch(/^gate-3-uptime: /m);
    let row = await tailAuditRow(hermetic);
    expect(row?.outcome).toBe("gate-3-refused");

    // Pre-rotation _medic id (still alive since gate refused).
    const preList = tmuxCage(hermetic, [
      "list-windows",
      "-t",
      COCKPIT_SESSION,
      "-F",
      "#{window_name}\t#{window_id}",
    ]);
    const preMedicId = preList.stdout
      .split("\n")
      .find((l) => l.startsWith("_medic\t"))
      ?.split("\t")[1];

    // --force bypasses gate-3 → rotation proceeds.
    hermetic.stderrBuf.length = 0;
    const exit2 = await cockpitRotate(["medic", "--force"], rotateOpts(hermetic));
    expect(exit2).toBe(0);
    row = await tailAuditRow(hermetic);
    expect(row?.outcome).toBe("success");

    const postList = tmuxCage(hermetic, [
      "list-windows",
      "-t",
      COCKPIT_SESSION,
      "-F",
      "#{window_name}\t#{window_id}",
    ]);
    const postMedicId = postList.stdout
      .split("\n")
      .find((l) => l.startsWith("_medic\t"))
      ?.split("\t")[1];
    expect(postMedicId).not.toBe(preMedicId);
  });

  // ----- Run 4: gate-1 user-typing refusal -----

  test("Run 4 — gate-1 user-typing refuses when _sd compose box has queued text", async () => {
    spawnCockpitSession(hermetic);
    // Replace _sd pane with a fake Claude-Code-shaped TUI
    // that classifyText() classifies as TYPING. The classifier in
    // src/core/pane-state.ts keys off the `❯ <text>` prompt at the
    // bottom of the pane, so we kill the sleep-infinity pane + spawn
    // a tiny shell loop that paints that footer and waits.
    tmuxCage(hermetic, ["kill-window", "-t", `${COCKPIT_SESSION}:_sd`]);
    tmuxCage(hermetic, [
      "new-window",
      "-d",
      "-t",
      `${COCKPIT_SESSION}:`,
      "-n",
      "_sd",
      // pane-state classifier's TYPING regex (src/core/pane-state.ts L109)
      // is /Press up to edit queued messages/i — paint exactly that
      // line so classifyText returns state="TYPING".
      `sh -c 'printf "\\nPress up to edit queued messages\\n"; ${PORTABLE_KEEPALIVE_COMMAND}'`,
    ]);
    // Settle — give tmux time to paint the pane so capturePane sees the footer.
    await new Promise((r) => setTimeout(r, 250));

    const exit = await cockpitRotate(["medic"], rotateOpts(hermetic));
    expect(exit).toBe(65);
    expect(hermetic.stderrBuf.join("")).toMatch(/^gate-1-user-not-typing: /m);
    const row = await tailAuditRow(hermetic);
    expect(row?.outcome).toBe("gate-1-refused");
  });

  // ----- Run 5: team-driver rotation, cage socket unaffected -----

  test("Run 5 — team-driver rotation respawns cockpit window; per-team cage socket unaffected", async () => {
    spawnCockpitSession(hermetic);
    // Spawn a separate per-team "cage" session on a different socket
    // → proves cockpit rotate's tmuxFactory threads cockpit socket
    // only (per ADR-162). We use a second named socket inside the
    // same TMUX_TMPDIR so the assertion is real (not just isolated
    // by accident-of-path).
    const cageSocket = "atmux-team-alpha-cage";
    const cageSpawn = spawnTmux(cageSocket, [
      "new-session",
      "-d",
      "-s",
      "atmux-team-alpha",
      "-n",
      "lead",
      PORTABLE_KEEPALIVE_COMMAND,
    ]);
    expect(cageSpawn.exitCode).toBe(0);

    const preList = tmuxCage(hermetic, [
      "list-windows",
      "-t",
      COCKPIT_SESSION,
      "-F",
      "#{window_name}\t#{window_id}",
    ]);
    const preTeamId = preList.stdout
      .split("\n")
      .find((l) => l.startsWith("team-alpha\t"))
      ?.split("\t")[1];

    const exit = await cockpitRotate(["team-alpha"], rotateOpts(hermetic));
    expect(exit).toBe(0);

    // Cockpit team-alpha window respawned.
    const postList = tmuxCage(hermetic, [
      "list-windows",
      "-t",
      COCKPIT_SESSION,
      "-F",
      "#{window_name}\t#{window_id}",
    ]);
    const postTeamId = postList.stdout
      .split("\n")
      .find((l) => l.startsWith("team-alpha\t"))
      ?.split("\t")[1];
    expect(postTeamId).not.toBe(preTeamId);

    // Cage socket's lead session is UNTOUCHED — list-sessions on the
    // cage socket still shows it. (Cockpit verb scope per ADR-162.)
    const cageList = spawnTmux(cageSocket, ["list-sessions", "-F", "#{session_name}"]);
    expect(cageList.exitCode).toBe(0);
    expect(cageList.stdout?.toString()).toContain("atmux-team-alpha");

    // Audit row outcome=success for team-driver.
    const row = await tailAuditRow(hermetic);
    expect(row?.outcome).toBe("success");
    expect(row?.role).toBe("team-driver");
    expect(row?.sessionName).toBe("team-alpha");

    // Cleanup the cage socket so the afterEach kill-server only has
    // the cockpit socket to tear down (cage is a separate tmux server).
    spawnTmux(cageSocket, ["kill-server"]);
  });

  // ----- Run 6: handoff-write-failed atomicity (Plan B injection) -----

  test("Run 6 — handoff-write-failed: PANE NOT TOUCHED, recovery posture preserved", async () => {
    spawnCockpitSession(hermetic);

    // Record every tmux operation the verb attempts. The atomicity
    // assertion is "nothing destructive fires when handoff-write
    // fails" — killWindow / newWindow / sendKeys must all be ZERO.
    interface OpRecord {
      op: string;
      target: string | undefined;
    }
    const ops: OpRecord[] = [];
    const tmuxRecorder = (_cfg: TmuxConfig): TmuxNamespace =>
      ({
        pane: {
          capturePane: async (opts: { target: string }) => {
            ops.push({ op: "capturePane", target: opts.target });
            return ""; // empty → gate-1 + gate-2 classifiers pass
          },
          sendKeys: async (opts: { target: { target?: string } }) => {
            ops.push({ op: "sendKeys", target: opts.target?.target });
          },
        },
        window: {
          killWindow: async (target: string) => {
            ops.push({ op: "killWindow", target });
          },
          newWindow: async (opts: { name?: string }) => {
            ops.push({ op: "newWindow", target: opts.name });
            return { sessionName: COCKPIT_SESSION, windowIndex: 99 };
          },
        },
        // Unused by the rotate verb — stubs keep TS happy.
        session: {} as TmuxNamespace["session"],
      }) as unknown as TmuxNamespace;

    // Inject a failing atomicWrite — simulates an unwritable handoff dir.
    const exit = await cockpitRotate(
      ["medic"],
      rotateOpts(hermetic, {
        tmuxFactory: tmuxRecorder,
        atomicWrite: async () => {
          throw new Error("synthetic ENOSPC");
        },
        // Also inject loadCockpit so the verb doesn't read real disk
        // (already valid in our hermetic HOME, but Plan B is about
        // deterministic capture — keep IO out of the assertion).
        loadCockpit: async (): Promise<LoadedCockpit> =>
          ({
            sessions: [
              {
                type: "medic",
                name: "medic",
                claudeAccount: { configDir: "/root/.claude" },
              },
            ],
            teams: [],
            medic: {
              type: "medic",
              name: "medic",
              claudeAccount: { configDir: "/root/.claude" },
            },
          }) as unknown as LoadedCockpit,
      }),
    );

    expect(exit).toBe(70);
    expect(hermetic.stderrBuf.join("")).toMatch(/handoff write failed/);

    const row = await tailAuditRow(hermetic);
    expect(row).not.toBeNull();
    expect(row?.outcome).toBe("handoff-write-failed");
    expect(row?.role).toBe("medic");
    expect(row?.handoffPath).toBe(handoffPayloadPath(hermetic.homeDir, "medic"));
    expect(row?.error).toContain("synthetic ENOSPC");

    // ---- ATOMICITY PROOF ----
    // The injected seam does not deliver Ctrl-C in this fixture; the
    // assertion is that no kill or new-window fires when handoff write
    // fails. Capture (gate IO) is allowed; mutations are not.
    const mutations = ops.filter(
      (o) => o.op === "killWindow" || o.op === "newWindow" || o.op === "sendKeys",
    );
    expect(mutations).toEqual([]);
  });
});
