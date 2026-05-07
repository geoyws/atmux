// Unit tests for scripts/provision-fallback-user.sh (ADR-058 T1).
//
// Strategy: spawn the bash script as a subprocess. Two test families:
//
//   1. argv + validation — exercise --help, missing-agent, bad-name,
//      unsupported-agent, unknown-flag. Pure script logic; no sudo.
//
//   2. --dry-run flow — assert step 1-4 messages emit in order for both
//      kimi-agent and minimax-agent, and that the side-effect lines all
//      carry the `DRY-RUN:` prefix. No actual sudo invocation.
//
//   3. mocked-sudo idempotence — stub `sudo` and `getent` on PATH.
//      First run (user-absent): sudo log contains useradd. Second run
//      (user-present, simulated via env-toggle): sudo log does NOT
//      contain useradd, and re-running cp/setfacl is intrinsically a
//      no-op (rewrites same ACL / same-mtime file). This is the
//      "zero side effects on re-run" proof per ADR-058 T1 acceptance.
//
//   4. --refresh-auth — requires existing user (errors if user absent),
//      and on the happy path skips steps 1-3 and only re-runs step 4.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "../../../scripts/provision-fallback-user.sh");

interface RunResult {
  exit: number;
  stdout: string;
  stderr: string;
}

async function runScript(
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
): Promise<RunResult> {
  const proc = Bun.spawn(["bash", SCRIPT, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exit = await proc.exited;
  return { exit, stdout, stderr };
}

// ---------- argv + validation ----------

describe("provision-fallback-user.sh — argv + validation", () => {
  test("--help prints usage + exits 0", async () => {
    const r = await runScript(["--help"]);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("provision-fallback-user.sh");
    expect(r.stdout).toContain("kimi-agent");
    expect(r.stdout).toContain("minimax-agent");
  });

  test("-h is alias for --help", async () => {
    const r = await runScript(["-h"]);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("USAGE");
  });

  test("missing agent → exit 2 + prints usage to stderr", async () => {
    const r = await runScript([]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("USAGE");
  });

  test("invalid agent name (bad chars) → exit 2 with clear message", async () => {
    const r = await runScript(["--dry-run", "BadName!!"]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("invalid agent name");
  });

  test("invalid agent name (too short) → exit 2", async () => {
    const r = await runScript(["--dry-run", "ab"]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("invalid agent name");
  });

  test("well-formed but unsupported agent → exit 2 with allow-list message", async () => {
    const r = await runScript(["--dry-run", "claude-agent"]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("unsupported agent");
    expect(r.stderr).toContain("kimi-agent");
    expect(r.stderr).toContain("minimax-agent");
  });

  test("unknown flag → exit 2", async () => {
    const r = await runScript(["--bogus", "kimi-agent"]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("unknown flag");
  });

  test("extra positional arg → exit 2", async () => {
    const r = await runScript(["--dry-run", "kimi-agent", "extra"]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("extra positional");
  });
});

// ---------- --dry-run flow ----------

describe("provision-fallback-user.sh — --dry-run flow", () => {
  test("kimi-agent dry-run: all 4 steps + DRY-RUN sudo lines", async () => {
    const r = await runScript(["--dry-run", "kimi-agent"], {
      // Force auth source absent → step 4 takes the "skip" branch and the
      // assertion is deterministic regardless of the test machine's $HOME.
      ATMUX_PROVISION_SOURCE_HOME: "/nonexistent-tmp-source-home-xyz",
    });
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("step 1: useradd");
    expect(r.stdout).toContain("DRY-RUN: sudo useradd");
    expect(r.stdout).toContain("step 2: install -d");
    expect(r.stdout).toContain("DRY-RUN: sudo install -d");
    expect(r.stdout).toContain("step 3: setfacl");
    expect(r.stdout).toContain("DRY-RUN: sudo setfacl -R -m u:kimi-agent:rX");
    expect(r.stdout).toContain("step 4: kimi-cli config absent");
    expect(r.stdout).toContain("provision-fallback-user: OK (kimi-agent)");
  });

  test("kimi-agent dry-run with auth source present: emits cp/chown/chmod DRY-RUN lines", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "provision-test-"));
    try {
      const cfg = join(tmp, ".config", "kimi-cli");
      await mkdir(cfg, { recursive: true });
      await writeFile(join(cfg, "config.json"), '{"k":"v"}\n');
      const r = await runScript(["--dry-run", "kimi-agent"], {
        ATMUX_PROVISION_SOURCE_HOME: tmp,
      });
      expect(r.exit).toBe(0);
      expect(r.stdout).toContain(`step 4: copy ${cfg} → /home/kimi-agent/.config/kimi-cli`);
      expect(r.stdout).toContain("DRY-RUN: sudo cp -au");
      expect(r.stdout).toContain("DRY-RUN: sudo chown -R kimi-agent:kimi-agent");
      expect(r.stdout).toContain("DRY-RUN: sudo chmod -R u=rwX,g=,o=");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("minimax-agent dry-run: emits Tier 4 stub message + still runs steps 1-3", async () => {
    const r = await runScript(["--dry-run", "minimax-agent"]);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("DRY-RUN: sudo useradd");
    expect(r.stdout).toContain("DRY-RUN: sudo setfacl -R -m u:minimax-agent:rX");
    expect(r.stdout).toContain("step 4: Tier 4 CLI not yet GA — auth-copy skipped");
    expect(r.stdout).toContain("provision-fallback-user: OK (minimax-agent)");
  });

  test("dry-run honors ATMUX_PROVISION_HOME_PREFIX override", async () => {
    const r = await runScript(["--dry-run", "kimi-agent"], {
      ATMUX_PROVISION_HOME_PREFIX: "/var/tmp/fake-home",
      ATMUX_PROVISION_SOURCE_HOME: "/nonexistent",
    });
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("/var/tmp/fake-home/kimi-agent");
    expect(r.stdout).toContain("/var/tmp/fake-home/kimi-agent/cages");
  });

  test("dry-run honors ATMUX_PROVISION_PROJECT_ROOT override", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "provision-pr-"));
    try {
      const r = await runScript(["--dry-run", "kimi-agent"], {
        ATMUX_PROVISION_PROJECT_ROOT: tmp,
        ATMUX_PROVISION_SOURCE_HOME: "/nonexistent",
      });
      expect(r.exit).toBe(0);
      expect(r.stdout).toContain(`setfacl -R -m u:kimi-agent:rX ${tmp}`);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("project-root not a directory → die with clear message", async () => {
    const r = await runScript(["--dry-run", "kimi-agent"], {
      ATMUX_PROVISION_PROJECT_ROOT: "/nonexistent-project-root-xyz",
    });
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toContain("PROJECT_ROOT=/nonexistent-project-root-xyz not a directory");
  });
});

// ---------- mocked-sudo idempotence ----------

interface MockEnv {
  /** tmpdir root */
  tmp: string;
  /** path to fake bin/ on PATH */
  bin: string;
  /** sudo invocation log */
  logFile: string;
  /** project-root tmpdir (must exist) */
  projectRoot: string;
  /** override env to pass to runScript */
  env: {
    PATH: string;
    ATMUX_PROVISION_PROJECT_ROOT: string;
    ATMUX_PROVISION_HOME_PREFIX: string;
    ATMUX_PROVISION_SOURCE_HOME: string;
  };
}

async function setupMockEnv(opts: { userExists: boolean }): Promise<MockEnv> {
  const tmp = await mkdtemp(join(tmpdir(), "provision-mock-"));
  const bin = join(tmp, "bin");
  await mkdir(bin, { recursive: true });
  const logFile = join(tmp, "calls.log");
  const projectRoot = join(tmp, "project");
  await mkdir(projectRoot, { recursive: true });

  // Mock sudo: log invocation + exit 0 (no passthrough — we record what
  // would be called, not actually run it).
  await writeFile(
    join(bin, "sudo"),
    `#!/bin/bash\nprintf 'sudo %s\\n' "$*" >> "${logFile}"\nexit 0\n`,
    { mode: 0o755 },
  );

  // Mock getent: env-driven existence toggle.
  const exists = opts.userExists ? "0" : "2";
  const echoLine = opts.userExists ? 'echo "$2:x:1001:1001::/home/$2:/bin/false"' : "true";
  await writeFile(
    join(bin, "getent"),
    `#!/bin/bash
printf 'getent %s\\n' "$*" >> "${logFile}"
${echoLine}
exit ${exists}
`,
    { mode: 0o755 },
  );

  return {
    tmp,
    bin,
    logFile,
    projectRoot,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      ATMUX_PROVISION_PROJECT_ROOT: projectRoot,
      ATMUX_PROVISION_HOME_PREFIX: join(tmp, "home"),
      ATMUX_PROVISION_SOURCE_HOME: join(tmp, "src-home"),
    },
  };
}

describe("provision-fallback-user.sh — mocked-sudo idempotence (ADR-058 T1 acceptance)", () => {
  let mock: MockEnv | null = null;

  afterEach(async () => {
    if (mock) {
      await rm(mock.tmp, { recursive: true, force: true });
      mock = null;
    }
  });

  test("first run (user absent): sudo log contains useradd + install + setfacl", async () => {
    mock = await setupMockEnv({ userExists: false });
    const r = await runScript(["kimi-agent"], mock.env);
    expect(r.exit).toBe(0);
    const calls = await readFile(mock.logFile, "utf8");
    expect(calls).toMatch(/sudo useradd -m -s \/bin\/false/);
    expect(calls).toMatch(/sudo install -d -m 755 -o kimi-agent/);
    expect(calls).toMatch(/sudo setfacl -R -m u:kimi-agent:rX/);
  });

  test("re-run (user present): sudo log does NOT contain useradd; setfacl still re-runs (idempotent rewrite)", async () => {
    mock = await setupMockEnv({ userExists: true });
    const r = await runScript(["kimi-agent"], mock.env);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("user kimi-agent exists; skipping useradd");
    const calls = await readFile(mock.logFile, "utf8");
    expect(calls).not.toMatch(/sudo useradd/);
    // setfacl re-runs but is idempotent — same ACL, no fs delta.
    expect(calls).toMatch(/sudo setfacl -R -m u:kimi-agent:rX/);
    // install -d also re-runs (mkdir -p semantics — idempotent).
    expect(calls).toMatch(/sudo install -d -m 755 -o kimi-agent/);
  });

  test("two consecutive runs produce identical post-step-1 sudo log (idempotence proof)", async () => {
    mock = await setupMockEnv({ userExists: true });
    const r1 = await runScript(["kimi-agent"], mock.env);
    expect(r1.exit).toBe(0);
    const log1 = await readFile(mock.logFile, "utf8");

    // Truncate log; run again under the same "user-exists" mock.
    await writeFile(mock.logFile, "");
    const r2 = await runScript(["kimi-agent"], mock.env);
    expect(r2.exit).toBe(0);
    const log2 = await readFile(mock.logFile, "utf8");

    // Both runs should issue the same sequence — same ACL re-applied,
    // same install -d (mkdir -p), same getent check.
    expect(log2).toBe(log1);
  });

  test("auth-config copy fires when source dir present", async () => {
    mock = await setupMockEnv({ userExists: true });
    // Populate fake source $HOME with a kimi-cli config dir.
    const cfg = join(mock.env.ATMUX_PROVISION_SOURCE_HOME, ".config", "kimi-cli");
    await mkdir(cfg, { recursive: true });
    await writeFile(join(cfg, "config.json"), '{"a":1}\n');

    const r = await runScript(["kimi-agent"], mock.env);
    expect(r.exit).toBe(0);
    const calls = await readFile(mock.logFile, "utf8");
    expect(calls).toMatch(/sudo install -d -m 700 -o kimi-agent.*\.config\/kimi-cli/);
    expect(calls).toMatch(/sudo cp -au .*kimi-cli\/\. .*\/kimi-cli\//);
    expect(calls).toMatch(/sudo chown -R kimi-agent:kimi-agent/);
    expect(calls).toMatch(/sudo chmod -R u=rwX,g=,o=/);
  });
});

// ---------- --refresh-auth path ----------

describe("provision-fallback-user.sh — --refresh-auth", () => {
  let mock: MockEnv | null = null;

  afterEach(async () => {
    if (mock) {
      await rm(mock.tmp, { recursive: true, force: true });
      mock = null;
    }
  });

  test("--refresh-auth on absent user → die with clear message", async () => {
    mock = await setupMockEnv({ userExists: false });
    const r = await runScript(["--refresh-auth", "kimi-agent"], mock.env);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toContain("--refresh-auth requires existing user");
  });

  test("--refresh-auth on existing user: skips useradd/install/setfacl, only step 4 runs", async () => {
    mock = await setupMockEnv({ userExists: true });
    // Populate auth source so step 4 has work to do.
    const cfg = join(mock.env.ATMUX_PROVISION_SOURCE_HOME, ".config", "kimi-cli");
    await mkdir(cfg, { recursive: true });
    await writeFile(join(cfg, "config.json"), '{"refresh":true}\n');

    const r = await runScript(["--refresh-auth", "kimi-agent"], mock.env);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("refresh-auth path: skipping steps 1-3");
    expect(r.stdout).toContain("provision-fallback-user: OK (kimi-agent, --refresh-auth)");

    const calls = await readFile(mock.logFile, "utf8");
    // Critical: NONE of the steps-1-3 sudo calls fired.
    expect(calls).not.toMatch(/sudo useradd/);
    expect(calls).not.toMatch(/sudo setfacl/);
    expect(calls).not.toMatch(/sudo install -d -m 755/); // step 2's cages dir
    // Step 4 DID fire.
    expect(calls).toMatch(/sudo cp -au .*kimi-cli/);
    expect(calls).toMatch(/sudo chown -R kimi-agent:kimi-agent/);
  });

  test("--refresh-auth on minimax-agent (Tier 4 stub): emits skip message + exits 0", async () => {
    mock = await setupMockEnv({ userExists: true });
    const r = await runScript(["--refresh-auth", "minimax-agent"], mock.env);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("Tier 4 CLI not yet GA");
    const calls = await readFile(mock.logFile, "utf8");
    expect(calls).not.toMatch(/sudo cp/);
  });
});
