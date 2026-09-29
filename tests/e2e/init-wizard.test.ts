// T3 (e-b545b70c) — scripted `atmux init --wizard` run through the REAL CLI.
//
// Spawns `bin/atmux-bun init --wizard` with a scratch HOME + a scratch
// project dir, pipes answers on stdin, and asserts the written team.json
// and cockpit.json contents (per ADR-200 §D2).
//
// Hermeticity (no live estate touched):
//   - `HOME` points at the scratch dir, so the cockpit scaffold lands at
//     `<scratch>/.atmux/cockpit.json`, never the operator's real one.
//   - `--no-skills` skips the ~/.claude plugin-symlink step (ADR-217 §D5).
//   - The wizard never starts tmux — the prereq probe only checks binary
//     presence via PATH lookup; no server, socket, crontab, or network is
//     touched anywhere on this path.
//   - Env is built from scratch (not merged onto the runner's), so no
//     live `ATMUX_*` / `TMUX` pointer can steer the CLI at a real team.
//
// Skipped when any probed prereq binary is absent (the wizard would
// refuse; there is nothing scriptable to assert) — same skip discipline
// as the tmux-gated e2e specs.

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Team } from "../../src/schema/team.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");

const REQUIRED_BINS = ["tmux", "git", "jq", "sqlite3"] as const;
const MISSING = REQUIRED_BINS.filter((bin) => Bun.which(bin) === null);

function runWizard(projectDir: string, homeDir: string, stdin: string, extraArgs: string[] = []) {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, join(REPO_ROOT, "bin", "atmux-bun"), "init", "--wizard", ...extraArgs],
    cwd: projectDir,
    stdin: Buffer.from(stdin),
    env: {
      PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
      HOME: homeDir,
      NO_COLOR: "1",
      TERM: "xterm-256color",
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: proc.stdout?.toString() ?? "",
    stderr: proc.stderr?.toString() ?? "",
  };
}

describe.skipIf(MISSING.length > 0)(
  `e2e: atmux init --wizard scripted run${MISSING.length > 0 ? ` (skip: missing ${MISSING.join(", ")})` : ""}`,
  () => {
    test("scratch HOME + piped answers → team.json + cockpit entry", async () => {
      const work = await mkdtemp(join(tmpdir(), "atmux-wiz-e2e-"));
      const home = join(work, "home");
      const project = join(work, "proj");
      await mkdir(home, { recursive: true });
      await mkdir(project, { recursive: true });
      try {
        const result = runWizard(project, home, "e2e-wiz\n\n", ["--no-skills"]);
        expect(`${result.stdout}\n${result.stderr}`).toContain("wizard complete");
        expect(result.exitCode).toBe(0);

        const team = Team.parse(
          JSON.parse(await readFile(join(project, ".atmux", "team.json"), "utf8")),
        );
        expect(team.name).toBe("e2e-wiz");
        // Drivers-only roster default (ADR-287 §D5): members [] + canonical drivers.
        expect(team.members).toEqual([]);
        expect(team.drivers?.map((d) => d.name)).toEqual(["driver", "driver-2", "driver-3"]);

        const cockpit = JSON.parse(await readFile(join(home, ".atmux", "cockpit.json"), "utf8"));
        expect(JSON.stringify(cockpit.sessions)).toContain(project);
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    });

    test("second run without --force refuses (idempotency gate)", async () => {
      const work = await mkdtemp(join(tmpdir(), "atmux-wiz-e2e-"));
      const home = join(work, "home");
      const project = join(work, "proj");
      await mkdir(home, { recursive: true });
      await mkdir(project, { recursive: true });
      try {
        const first = runWizard(project, home, "e2e-wiz\n\n", ["--no-skills"]);
        expect(first.exitCode).toBe(0);

        const cockpitPath = join(home, ".atmux", "cockpit.json");
        await writeFile(cockpitPath, '{"schemaVersion":1,"sessions":[]}\n');
        const second = runWizard(project, home, "e2e-wiz\n\n", ["--no-skills"]);
        expect(second.exitCode).toBe(78);
        expect(`${second.stdout}\n${second.stderr}`).toContain("already initialized");
        // The refusal happens before any side effect: cockpit.json is untouched.
        expect(await readFile(cockpitPath, "utf8")).toBe('{"schemaVersion":1,"sessions":[]}\n');
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    });
  },
);
