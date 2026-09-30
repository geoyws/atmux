// Exercise the real cockpit CLI output against a scratch fleet. Dry-run is
// intentional: it follows the same reconcile reporting path as aca/aco's
// ensure-up without creating a live tmux server or starting a TUI.
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const hasTmux = Bun.which("tmux") !== null;

describe.skipIf(!hasTmux)(
  `cockpit reconcile output through the CLI${hasTmux ? "" : " (skip: tmux unavailable)"}`,
  () => {
    test("summarizes a scratch fleet while preserving dry-run isolation", async () => {
      const scratch = await mkdtemp(join(tmpdir(), "atmux-aco-output-e2e-"));
      const home = join(scratch, "home");
      const project = join(scratch, "team");
      const tmuxDir = join(scratch, "tmux");
      const config = join(home, ".atmux", "cockpit.json");
      const teamFile = join(project, ".atmux", "team.json");
      await mkdir(dirname(config), { recursive: true });
      await mkdir(dirname(teamFile), { recursive: true });
      await mkdir(tmuxDir);
      await writeFile(
        config,
        JSON.stringify({
          schemaVersion: 1,
          cockpitSession: "output_test_cockpit",
          sessions: [{ type: "team", name: "sample", root: project, enabled: true }],
        }),
      );
      const originalTeam = JSON.stringify({
        name: "sample",
        members: [],
        drivers: [{ name: "driver", tui: null, cwd: "." }],
      });
      await writeFile(teamFile, originalTeam);
      try {
        const run = () =>
          Bun.spawnSync({
            cmd: [
              process.execPath,
              join(repoRoot, "bin", "atmux-bun"),
              "cockpit",
              "reconcile",
              "--dry-run",
              "--no-launch",
            ],
            cwd: project,
            env: {
              HOME: home,
              PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
              TMUX_TMPDIR: tmuxDir,
              ATMUX_COCKPIT_CONFIG: config,
              ATMUX_COCKPIT_SOCKET: `aco-output-${process.pid}`,
              NO_COLOR: "1",
            },
            stdout: "pipe",
            stderr: "pipe",
            timeout: 60_000,
          });
        const proc = run();
        const output = `${proc.stdout?.toString() ?? ""}${proc.stderr?.toString() ?? ""}`;
        expect(proc.exitCode).toBe(0);
        expect(output).toContain("cockpit: 1 team");
        expect(output).toContain("team.json: 1 checked — 1 would change: sample (dry-run)");
        expect(output).toContain("cages: 1 would start (sample) (dry-run)");
        expect(output.match(/⏱/g)).toHaveLength(1);
        expect(output).toMatch(/cockpit-session \d+ms/);
        expect(output).toContain(
          "dry-run: 0 rename, 0 kill, 4 other operations (nothing executed)",
        );
        expect(output).not.toContain("would start cage '");
        expect(await readFile(teamFile, "utf8")).toBe(originalTeam);
        await writeFile(teamFile, "{broken");
        const failed = run();
        expect(failed.exitCode).toBe(0);
        const failedOutput = `${failed.stdout?.toString() ?? ""}${failed.stderr?.toString() ?? ""}`;
        expect(failedOutput).toContain(
          "team.json: 1 checked — 1 would change: sample (unreadable) (dry-run)",
        );
        expect(await readFile(teamFile, "utf8")).toBe("{broken");
        await writeFile(teamFile, originalTeam);
        const recovered = run();
        expect(recovered.exitCode).toBe(0);
        expect(
          `${recovered.stdout?.toString() ?? ""}${recovered.stderr?.toString() ?? ""}`,
        ).toContain("cages: 1 would start (sample) (dry-run)");
        expect(await readFile(teamFile, "utf8")).toBe(originalTeam);
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    });
  },
);
