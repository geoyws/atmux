// Unit tests for scripts/fallback-reconcile.sh (ADR-058 T3 PART A).
//
// Strategy: same shape as provision-fallback-user.test.ts — spawn the
// bash script as a subprocess, mock sudo + diff via PATH stubs.
//
// Test families:
//
//   1. argv + validation — --help, missing args, bad team/lane, bad
//      tier, unknown flags.
//
//   2. Tier 2 fast-path — exits 0 with no-op message (no sudo, no diff).
//
//   3. no-deltas idempotence — empty diff output → exit 0 with
//      "no deltas" message. Re-runnable per ADR-058 T3 acceptance.
//
//   4. classify + interactive flow — feed scripted diff output via
//      mocked diff binary, feed scripted answers via INPUT_SRC, verify
//      the per-delta apply path (cat + chmod) fires for `y` answers
//      only.
//
//   5. abort path — `q` mid-loop short-circuits remaining deltas.
//
//   6. cage-context-file exclusion — _history.log / _status.log /
//      _branch.log are filtered out of the prompt loop.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "../../../scripts/fallback-reconcile.sh");

interface RunResult {
  exit: number;
  stdout: string;
  stderr: string;
}

async function runScript(
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
  stdin?: string,
): Promise<RunResult> {
  const proc = Bun.spawn(["bash", SCRIPT, ...args], {
    env: { ...process.env, ...env },
    stdin: stdin !== undefined ? "pipe" : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdin !== undefined && proc.stdin) {
    const w = proc.stdin as { write?: (b: string) => unknown; end?: () => unknown };
    if (w.write) w.write(stdin);
    if (w.end) w.end();
  }
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exit = await proc.exited;
  return { exit, stdout, stderr };
}

// ---------- argv + validation ----------

describe("fallback-reconcile.sh — argv + validation", () => {
  test("--help prints usage + exits 0", async () => {
    const r = await runScript(["--help"]);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("fallback-reconcile.sh");
    expect(r.stdout).toContain("ADR-058");
    expect(r.stdout).toContain("y");
    expect(r.stdout).toContain("view-diff");
  });

  test("-h is alias for --help", async () => {
    const r = await runScript(["-h"]);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("USAGE");
  });

  test("missing team+lane → exit 2 + usage to stderr", async () => {
    const r = await runScript([]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("USAGE");
  });

  test("missing lane → exit 2", async () => {
    const r = await runScript(["myteam"]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("USAGE");
  });

  test("invalid team name → exit 2 with clear message", async () => {
    const r = await runScript(["BAD!Team", "lane"]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("invalid TEAM");
  });

  test("invalid lane name → exit 2 with clear message", async () => {
    const r = await runScript(["team", "Bad Lane!"]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("invalid LANE");
  });

  test("invalid --tier → exit 2", async () => {
    const r = await runScript(["team", "lane", "--tier", "9"]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("invalid --tier");
  });

  test("--tier without value → exit 2", async () => {
    const r = await runScript(["team", "lane", "--tier"]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("--tier requires a value");
  });

  test("unknown flag → exit 2", async () => {
    const r = await runScript(["--bogus", "team", "lane"]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("unknown flag");
  });

  test("extra positional arg → exit 2", async () => {
    const r = await runScript(["team", "lane", "extra"]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("extra positional");
  });
});

// ---------- Tier 2 fast-path ----------

describe("fallback-reconcile.sh — Tier 2 fast-path", () => {
  test("--tier 2 emits no-op message + exits 0 without sudo/diff", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "reconcile-t2-"));
    try {
      const projectRoot = join(tmp, "project");
      await mkdir(projectRoot, { recursive: true });
      const r = await runScript(["myteam", "mylane", "--tier", "2"], {
        ATMUX_RECONCILE_PROJECT_ROOT: projectRoot,
      });
      expect(r.exit).toBe(0);
      expect(r.stdout).toContain("Tier 2 (operator-UID cage) — no reconcile needed");
      expect(r.stdout).toContain("commits");
      expect(r.stdout).toContain("git log");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

// ---------- mock-env infra (mirrors provision-fallback-user.test.ts setupMockEnv) ----------

interface MockEnv {
  tmp: string;
  bin: string;
  logFile: string;
  projectRoot: string;
  cageRoot: string;
  homePrefix: string;
  agent: string;
  team: string;
  lane: string;
  /** Diff stdout the mocked `diff` binary returns. */
  setDiffStdout: (s: string) => Promise<void>;
  /** Per-class file content the mocked `sudo cat` returns. */
  setCatStdout: (s: string) => Promise<void>;
  env: Record<string, string>;
}

interface MockOpts {
  /** Overrides agent name (default "kimi-agent"). */
  agent?: string;
  /** Pre-populated diff stdout. */
  diffStdout?: string;
  /** Pre-populated cat stdout (single content used for any cat). */
  catStdout?: string;
}

async function setupMockEnv(opts: MockOpts = {}): Promise<MockEnv> {
  const tmp = await mkdtemp(join(tmpdir(), "reconcile-mock-"));
  const bin = join(tmp, "bin");
  await mkdir(bin, { recursive: true });
  const logFile = join(tmp, "calls.log");
  const projectRoot = join(tmp, "project");
  await mkdir(projectRoot, { recursive: true });
  const homePrefix = join(tmp, "home");
  await mkdir(homePrefix, { recursive: true });

  const agent = opts.agent ?? "kimi-agent";
  const team = "myteam";
  const lane = "mylane";

  // Pre-create the cage directory so the existence check passes.
  const cageRoot = join(homePrefix, agent, "cages", `${team}-${lane}`, "work");
  await mkdir(cageRoot, { recursive: true });

  // State files (shared between this process and the mocked binaries).
  const diffStdoutFile = join(tmp, "diff_stdout.txt");
  const catStdoutFile = join(tmp, "cat_stdout.txt");
  await writeFile(diffStdoutFile, opts.diffStdout ?? "");
  await writeFile(catStdoutFile, opts.catStdout ?? "");

  // Mocked `sudo` — passes through cat / stat / test / diff / chmod / ln,
  // logs the invocation, otherwise echoes "sudo not implemented".
  await writeFile(
    join(bin, "sudo"),
    `#!/bin/bash
printf 'sudo %s\\n' "$*" >> "${logFile}"
# argv shape: sudo -u <agent> <cmd> [args...]
shift 2 || true   # drop -u <agent>
case "$1" in
  cat)
    cat "${catStdoutFile}"
    ;;
  test)
    shift
    test "$@"
    ;;
  diff)
    cat "${diffStdoutFile}"
    # diff exits 1 when there are differences; only honor empty-stdout-as-empty.
    if [[ -s "${diffStdoutFile}" ]]; then exit 1; fi
    exit 0
    ;;
  stat)
    # ignore actual file; return canned mode 644
    echo "644"
    ;;
  *)
    "$@"
    ;;
esac
`,
    { mode: 0o755 },
  );

  // Mocked `diff` (used directly without sudo for show_diff path).
  await writeFile(
    join(bin, "diff"),
    `#!/bin/bash
printf 'diff %s\\n' "$*" >> "${logFile}"
cat "${diffStdoutFile}"
exit 0
`,
    { mode: 0o755 },
  );

  return {
    tmp,
    bin,
    logFile,
    projectRoot,
    cageRoot,
    homePrefix,
    agent,
    team,
    lane,
    setDiffStdout: (s: string): Promise<void> => writeFile(diffStdoutFile, s),
    setCatStdout: (s: string): Promise<void> => writeFile(catStdoutFile, s),
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      ATMUX_RECONCILE_PROJECT_ROOT: projectRoot,
      ATMUX_RECONCILE_HOME_PREFIX: homePrefix,
      ATMUX_RECONCILE_SUDO: "sudo", // resolves to mock via PATH
      ATMUX_RECONCILE_DIFF: "diff", // resolves to mock via PATH
      ATMUX_RECONCILE_AGENT: agent,
    },
  };
}

// ---------- no-deltas idempotence ----------

describe("fallback-reconcile.sh — no-deltas idempotence", () => {
  let mock: MockEnv | null = null;

  afterEach(async () => {
    if (mock) {
      await rm(mock.tmp, { recursive: true, force: true });
      mock = null;
    }
  });

  test("empty diff stdout → exits 0 with 'no deltas' message", async () => {
    mock = await setupMockEnv({ diffStdout: "" });
    const r = await runScript([mock.team, mock.lane, "--tier", "3"], mock.env);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("no deltas");
  });

  test("only cage-context-file deltas → exits 0 with 'no actionable deltas'", async () => {
    mock = await setupMockEnv({});
    // diff reports _history.log + _status.log differ — should be filtered.
    const diff =
      `Files ${mock.cageRoot}/_history.log and ${mock.env["ATMUX_RECONCILE_PROJECT_ROOT"]}/_history.log differ\n` +
      `Files ${mock.cageRoot}/_status.log and ${mock.env["ATMUX_RECONCILE_PROJECT_ROOT"]}/_status.log differ\n`;
    await mock.setDiffStdout(diff);
    const r = await runScript([mock.team, mock.lane, "--tier", "3"], mock.env);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("no actionable deltas");
  });
});

// ---------- classify + interactive flow ----------

describe("fallback-reconcile.sh — classify + apply", () => {
  let mock: MockEnv | null = null;

  afterEach(async () => {
    if (mock) {
      await rm(mock.tmp, { recursive: true, force: true });
      mock = null;
    }
  });

  test("ADDED y: writes file under operator UID into project root", async () => {
    mock = await setupMockEnv({
      diffStdout: "", // set below after we have full paths
      catStdout: "hello from kimi-agent\n",
    });
    await mock.setDiffStdout(`Only in ${mock.cageRoot}: newfile.ts\n`);

    const inputFile = join(mock.tmp, "input.txt");
    await writeFile(inputFile, "y\n");
    const r = await runScript([mock.team, mock.lane, "--tier", "3"], {
      ...mock.env,
      ATMUX_RECONCILE_INPUT: inputFile,
    });
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("[ADDED] newfile.ts");
    expect(r.stdout).toContain("applied: ADDED newfile.ts");
    expect(r.stdout).toContain("accepted=1 skipped=0");
    // Verify the file landed in the project tree under the operator UID.
    const wrote = await readFile(join(mock.projectRoot, "newfile.ts"), "utf8");
    expect(wrote).toBe("hello from kimi-agent\n");
  });

  test("MODIFIED n: leaves project file untouched", async () => {
    mock = await setupMockEnv({});
    // Pre-write a project-side file so we can verify it stays intact.
    await writeFile(join(mock.projectRoot, "existing.ts"), "operator-original\n");
    await mock.setDiffStdout(
      `Files ${mock.cageRoot}/existing.ts and ${mock.projectRoot}/existing.ts differ\n`,
    );
    await mock.setCatStdout("agent-version\n");

    const inputFile = join(mock.tmp, "input.txt");
    await writeFile(inputFile, "n\n");
    const r = await runScript([mock.team, mock.lane, "--tier", "3"], {
      ...mock.env,
      ATMUX_RECONCILE_INPUT: inputFile,
    });
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("[MODIFIED] existing.ts");
    expect(r.stdout).toContain("skipped: MODIFIED existing.ts");
    expect(r.stdout).toContain("accepted=0 skipped=1");
    const stillThere = await readFile(join(mock.projectRoot, "existing.ts"), "utf8");
    expect(stillThere).toBe("operator-original\n");
  });

  test("DELETED y: removes file from project tree", async () => {
    mock = await setupMockEnv({});
    // Pre-write the project-side file the agent intends to delete.
    await writeFile(join(mock.projectRoot, "trash.ts"), "to-be-deleted\n");
    await mock.setDiffStdout(`Only in ${mock.projectRoot}: trash.ts\n`);

    const inputFile = join(mock.tmp, "input.txt");
    await writeFile(inputFile, "y\n");
    const r = await runScript([mock.team, mock.lane, "--tier", "3"], {
      ...mock.env,
      ATMUX_RECONCILE_INPUT: inputFile,
    });
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("[DELETED] trash.ts");
    expect(r.stdout).toContain("accepted=1");
    // File should be gone now.
    const exists = await Bun.file(join(mock.projectRoot, "trash.ts")).exists();
    expect(exists).toBe(false);
  });

  test("multiple deltas: each prompts independently; abort short-circuits remainder", async () => {
    mock = await setupMockEnv({});
    await mock.setDiffStdout(
      [
        `Only in ${mock.cageRoot}: a.ts`,
        `Only in ${mock.cageRoot}: b.ts`,
        `Only in ${mock.cageRoot}: c.ts`,
      ].join("\n") + "\n",
    );
    await mock.setCatStdout("body\n");

    // Accept first, abort on second; third should NOT be processed.
    const inputFile = join(mock.tmp, "input.txt");
    await writeFile(inputFile, "y\nq\n");
    const r = await runScript([mock.team, mock.lane, "--tier", "3"], {
      ...mock.env,
      ATMUX_RECONCILE_INPUT: inputFile,
    });
    expect(r.exit).toBe(3);
    expect(r.stdout).toContain("applied: ADDED a.ts");
    expect(r.stdout).toContain("aborted at: ADDED b.ts");
    expect(r.stdout).not.toContain("c.ts");
    // a.ts should have landed; b.ts and c.ts should not.
    expect(await Bun.file(join(mock.projectRoot, "a.ts")).exists()).toBe(true);
    expect(await Bun.file(join(mock.projectRoot, "b.ts")).exists()).toBe(false);
    expect(await Bun.file(join(mock.projectRoot, "c.ts")).exists()).toBe(false);
  });
});
