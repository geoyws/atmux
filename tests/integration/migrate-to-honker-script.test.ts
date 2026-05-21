// Integration test — scripts/migrate-to-honker.sh post-restart verifier.
//
// Per t-b2051762 (paired with t-76803578 which shipped the script).
// Asserts the verifier-only contract — script issues NO destructive
// atmux verbs — plus the exit-code matrix from the task body.
//
// Strategy: spin per-test scratch + a fake `atmux` binary on PATH that
// emits canned JSON. Each test runs the script under that PATH so we
// control `atmux doctor --json` / `atmux status --json` output without
// needing a live tmux session. ATMUX_TEAMS_BASE points at the scratch
// dir's mock team cages.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "..", "..", "scripts", "migrate-to-honker.sh");

interface FakeAtmuxOpts {
  /** JSON for `atmux doctor --json`. */
  doctor: object;
  /** JSON for `atmux status --json`. */
  status: object;
}

/** Build a per-team `atmux` shim. Returns the bin-dir absolute path; tests
 *  prepend it to PATH so the shim wins over /usr/local/bin/atmux. */
async function writeFakeAtmux(binDir: string, fakes: FakeAtmuxOpts): Promise<void> {
  await mkdir(binDir, { recursive: true });
  const doctorJson = JSON.stringify(fakes.doctor);
  const statusJson = JSON.stringify(fakes.status);
  const script = `#!/usr/bin/env bash
case "$1 $2" in
  "doctor --json")
    cat <<'JSON'
${doctorJson}
JSON
    ;;
  "status --json")
    cat <<'JSON'
${statusJson}
JSON
    ;;
  "event tail")
    echo '{"id":"e-test"}'
    ;;
  *)
    echo "fake-atmux: unknown verb $*" >&2
    exit 1
    ;;
esac
`;
  const path = join(binDir, "atmux");
  await writeFile(path, script);
  await chmod(path, 0o755);
}

/** Run the script with overrides. Returns {exit, stdout, stderr}. */
function runScript(args: string[], envOverride: Record<string, string>): {
  exit: number;
  stdout: string;
  stderr: string;
} {
  const env = { ...process.env, ...envOverride };
  const r = spawnSync(SCRIPT, args, { env, encoding: "utf8" });
  return {
    exit: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

// ---------- Structural assertions (file body, shebang, exec bit, ADRs) ----------

describe("migrate-to-honker.sh — structural", () => {
  test("has #!/usr/bin/env bash shebang", async () => {
    const body = await readFile(SCRIPT, "utf8");
    const firstLine = body.split("\n")[0];
    expect(firstLine).toBe("#!/usr/bin/env bash");
  });

  test("has executable bit set", async () => {
    const st = await stat(SCRIPT);
    // mode & 0o111 — any of owner/group/other execute.
    expect(st.mode & 0o111).toBeGreaterThan(0);
  });

  test("references ADR-217, ADR-202, and ADR-212 in header comments", async () => {
    const body = await readFile(SCRIPT, "utf8");
    expect(body).toMatch(/ADR-217/);
    expect(body).toMatch(/ADR-202/);
    expect(body).toMatch(/ADR-212/);
  });

  test("body contains no destructive atmux verbs (no 'atmux stop', no 'kill ')", async () => {
    const body = await readFile(SCRIPT, "utf8");
    expect(body).not.toMatch(/atmux stop\b/);
    expect(body).not.toMatch(/atmux team stop\b/);
    // 'kill ' with trailing space — would match `kill -9`, `kill $pid`,
    // etc.  Doesn't match `safe_killing_function` or similar (no trailing
    // space).
    expect(body).not.toMatch(/\bkill /);
  });
});

// ---------- Exit-code matrix + single/all mode behaviour ----------

describe("migrate-to-honker.sh — exit codes + modes", () => {
  let scratch: string;
  let binDir: string;
  let teamsBase: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "migrate-honker-test-"));
    binDir = join(scratch, "bin");
    teamsBase = join(scratch, "teams");
    await mkdir(binDir, { recursive: true });
    await mkdir(teamsBase, { recursive: true });
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  /** Provision a fake team cage at teamsBase/<name>/.atmux + a fake `atmux`. */
  async function provisionTeam(
    name: string,
    honkerStatus: "green" | "yellow" | "red",
    sessionState: "up" | "down" = "up",
  ): Promise<void> {
    const teamDir = join(teamsBase, name);
    await mkdir(join(teamDir, ".atmux", "logs"), { recursive: true });
    await writeFile(join(teamDir, ".atmux", "logs", "honker.log"), "honker loaded ok\n");
    // Fake atmux that returns the canned status. binDir is shared
    // across teams in --all mode (script runs the same atmux for every
    // cd-ed team — fine: we want the same behaviour for the smoke).
    await writeFakeAtmux(binDir, {
      doctor: {
        checks: [{ label: "honker", status: honkerStatus, detail: "test" }],
      },
      status: {
        sessionState,
        members: [{ name: "lead", cageState: "active" }],
      },
    });
  }

  test("missing argument → exit 2 + usage line on stderr", async () => {
    const r = runScript([], { ATMUX_TEAMS_BASE: teamsBase, PATH: process.env.PATH ?? "" });
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/usage:/i);
  });

  test("--help → exit 0 + usage line on stderr", async () => {
    const r = runScript(["--help"], { ATMUX_TEAMS_BASE: teamsBase, PATH: process.env.PATH ?? "" });
    expect(r.exit).toBe(0);
    expect(r.stderr).toMatch(/usage:/i);
  });

  test("single-team mode with all-green fixtures → exit 0", async () => {
    await provisionTeam("alpha", "green");
    const r = runScript(["alpha"], {
      ATMUX_TEAMS_BASE: teamsBase,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });
    expect(r.exit).toBe(0);
    expect(r.stdout).toMatch(/🟢 alpha/);
    expect(r.stdout).toMatch(/doctor honker=green/);
  });

  test("single-team mode with yellow honker row → exit 1", async () => {
    await provisionTeam("alpha", "yellow");
    const r = runScript(["alpha"], {
      ATMUX_TEAMS_BASE: teamsBase,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });
    expect(r.exit).toBe(1);
    expect(r.stdout).toMatch(/🔴 alpha/);
    expect(r.stdout).toMatch(/doctor honker=yellow/);
  });

  test("single-team mode with sessionState=down → exit 1", async () => {
    await provisionTeam("alpha", "green", "down");
    const r = runScript(["alpha"], {
      ATMUX_TEAMS_BASE: teamsBase,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });
    expect(r.exit).toBe(1);
    expect(r.stdout).toMatch(/sessionState=down/);
  });

  test("--all iterates 5 active teams; mixed verdicts → exit 1", async () => {
    // Provision 5 teams — atmux is yellow (drags overall to exit 1),
    // siblings green.
    await provisionTeam("unum", "green");
    await provisionTeam("sopx", "green");
    await provisionTeam("rentx", "green");
    await provisionTeam("ifca-docs", "green");
    // atmux comes last so its yellow doctor wins the shared fake-atmux
    // shim (each provisionTeam rewrites the script with new canned JSON).
    await provisionTeam("atmux", "yellow");

    const r = runScript(["--all"], {
      ATMUX_TEAMS_BASE: teamsBase,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });
    expect(r.exit).toBe(1);
    // All 5 names appear in stdout.
    for (const name of ["atmux", "unum", "sopx", "rentx", "ifca-docs"]) {
      expect(r.stdout).toMatch(new RegExp(`\\b${name}\\b`));
    }
  });

  test("--all + --json emits one valid JSON object per team", async () => {
    await provisionTeam("atmux", "green");
    await provisionTeam("unum", "green");
    await provisionTeam("sopx", "green");
    await provisionTeam("rentx", "green");
    await provisionTeam("ifca-docs", "green");

    const r = runScript(["--all", "--json"], {
      ATMUX_TEAMS_BASE: teamsBase,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });
    expect(r.exit).toBe(0);
    const lines = r.stdout.trim().split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(5);
    for (const line of lines) {
      const obj = JSON.parse(line) as { team: string; passed: boolean };
      expect(typeof obj.team).toBe("string");
      expect(typeof obj.passed).toBe("boolean");
    }
  });

  test("single-team + --json emits one valid JSON object", async () => {
    await provisionTeam("alpha", "green");
    const r = runScript(["alpha", "--json"], {
      ATMUX_TEAMS_BASE: teamsBase,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });
    expect(r.exit).toBe(0);
    const obj = JSON.parse(r.stdout.trim()) as {
      team: string;
      passed: boolean;
      checks: Record<string, string>;
    };
    expect(obj.team).toBe("alpha");
    expect(obj.passed).toBe(true);
    expect(obj.checks.doctor_honker).toMatch(/pass\|/);
  });

  test("unknown flag → exit 2", async () => {
    const r = runScript(["--bogus"], {
      ATMUX_TEAMS_BASE: teamsBase,
      PATH: process.env.PATH ?? "",
    });
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/unknown flag/);
  });

  test("--all + positional team name → exit 2 (mutually exclusive)", async () => {
    const r = runScript(["--all", "alpha"], {
      ATMUX_TEAMS_BASE: teamsBase,
      PATH: process.env.PATH ?? "",
    });
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/cannot combine --all with a positional/);
  });

  test("nonexistent team → exit 1 with skip line", async () => {
    // No team provisioned at teamsBase/missing — resolver fails.
    const r = runScript(["missing-team"], {
      ATMUX_TEAMS_BASE: teamsBase,
      PATH: process.env.PATH ?? "",
    });
    expect(r.exit).toBe(1);
    expect(r.stdout).toMatch(/STATUS=skip/);
  });
});
