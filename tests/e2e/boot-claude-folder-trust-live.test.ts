// Live e2e for booting a Claude member through the first-run
// folder-trust modal.
//
// Default mode is skipped at module load. Set ATMUX_E2E_LIVE=1 to run
// against a real claude binary + tmux server.

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { createTmux, type TmuxConfig, type TmuxNamespace } from "../../src/abstractions/tmux.ts";
import { bootSignalLive, isClaudeCodeFolderTrustModal } from "../../src/core/boot-claude.ts";
import { getAtmuxTmuxConfPath } from "../../src/core/tmux-paths.ts";
import type { Logger } from "../../src/core/tui.ts";
import { start } from "../../src/verbs/start.ts";

setDefaultTimeout(240_000);

const LIVE_MODE = process.env.ATMUX_E2E_LIVE === "1";

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

interface LogEntry {
  kind: "log" | "ok" | "warn" | "err";
  msg: string;
}

if (!LIVE_MODE) {
  test.skip("live mode skipped (set ATMUX_E2E_LIVE=1 to opt in)", () => {});
} else {
  describe("boot-claude folder-trust live e2e", () => {
    test("start() clears the Claude Code folder-trust modal once and boots the member", async () => {
      const tempRoot = await mkdtemp(join(tmpdir(), "atmux-boot-claude-folder-trust-live-"));
      const projectRoot = join(tempRoot, "project");
      const atmuxDir = join(projectRoot, ".atmux");
      const socketPath = join(tempRoot, "sock");
      const cockpitConfigPath = join(tempRoot, "cockpit.json");
      const teamName = `bt${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const teamJson = {
        name: teamName,
        members: [{ name: "member", role: "member", tui: "claude", cwd: projectRoot }],
      };

      const priorEnv: Record<string, string | undefined> = {
        TMUX: process.env.TMUX,
        ATMUX_DIR: process.env.ATMUX_DIR,
        ATMUX_COCKPIT_CONFIG: process.env.ATMUX_COCKPIT_CONFIG,
        ATMUX_NO_CRON: process.env.ATMUX_NO_CRON,
        ATMUX_CLAUDE_PLUGIN_DIR: process.env.ATMUX_CLAUDE_PLUGIN_DIR,
        ATMUX_CLAUDE_EFFORT: process.env.ATMUX_CLAUDE_EFFORT,
      };

      let bareTrustEnterCount = 0;
      let sawFolderTrustModalBeforeEnter = false;
      let sawBootSignal = false;

      const loggerLines: LogEntry[] = [];
      const logger: Logger = {
        log: (msg) => loggerLines.push({ kind: "log", msg }),
        ok: (msg) => loggerLines.push({ kind: "ok", msg }),
        warn: (msg) => loggerLines.push({ kind: "warn", msg }),
        err: (msg) => loggerLines.push({ kind: "err", msg }),
      };

      const tmuxFactory = (cfg: TmuxConfig): TmuxNamespace => {
        const real = createTmux(cfg);
        return {
          ...real,
          pane: {
            ...real.pane,
            async capturePane(opts) {
              const captured = await real.pane.capturePane(opts);
              if (!sawFolderTrustModalBeforeEnter && bareTrustEnterCount === 0) {
                sawFolderTrustModalBeforeEnter = isClaudeCodeFolderTrustModal(captured);
              }
              if (!sawBootSignal) {
                sawBootSignal = bootSignalLive(captured);
              }
              return captured;
            },
            async sendKeys(opts) {
              if (opts.keys === "Enter" && opts.enter === false) {
                bareTrustEnterCount += 1;
              }
              return await real.pane.sendKeys(opts);
            },
          },
        };
      };

      try {
        delete process.env.TMUX;
        process.env.ATMUX_DIR = atmuxDir;
        process.env.ATMUX_COCKPIT_CONFIG = cockpitConfigPath;
        process.env.ATMUX_NO_CRON = "1";
        process.env.ATMUX_CLAUDE_PLUGIN_DIR = "";
        process.env.ATMUX_CLAUDE_EFFORT = "low";

        const env: NodeJS.ProcessEnv = { ...process.env };
        await mkdir(atmuxDir, { recursive: true });
        await writeFile(
          join(atmuxDir, "team.json"),
          `${JSON.stringify(teamJson, null, 2)}\n`,
          "utf8",
        );

        const claudeBin = Bun.which("claude");
        const tmuxBin = Bun.which("tmux");
        expect(claudeBin, "claude binary missing from PATH").not.toBeNull();
        expect(tmuxBin, "tmux binary missing from PATH").not.toBeNull();

        const exit = await start(["--doctor=skip", "--socket-path", socketPath], {
          env,
          cwd: projectRoot,
          logger,
          loadCockpitFn: async () => null,
          tmuxFactory,
        });

        expect(exit).toBe(0);
        expect(sawFolderTrustModalBeforeEnter).toBe(true);
        expect(bareTrustEnterCount).toBe(1);
        expect(sawBootSignal).toBe(true);
        expect(
          loggerLines.some(
            (entry) => entry.kind === "log" && entry.msg.includes("member: bootstrapped"),
          ),
        ).toBe(true);
      } finally {
        process.env.TMUX = priorEnv.TMUX ?? "";
        if (priorEnv.TMUX === undefined) delete process.env.TMUX;

        process.env.ATMUX_DIR = priorEnv.ATMUX_DIR ?? "";
        if (priorEnv.ATMUX_DIR === undefined) delete process.env.ATMUX_DIR;

        process.env.ATMUX_COCKPIT_CONFIG = priorEnv.ATMUX_COCKPIT_CONFIG ?? "";
        if (priorEnv.ATMUX_COCKPIT_CONFIG === undefined) delete process.env.ATMUX_COCKPIT_CONFIG;

        process.env.ATMUX_NO_CRON = priorEnv.ATMUX_NO_CRON ?? "";
        if (priorEnv.ATMUX_NO_CRON === undefined) delete process.env.ATMUX_NO_CRON;

        process.env.ATMUX_CLAUDE_PLUGIN_DIR = priorEnv.ATMUX_CLAUDE_PLUGIN_DIR ?? "";
        if (priorEnv.ATMUX_CLAUDE_PLUGIN_DIR === undefined)
          delete process.env.ATMUX_CLAUDE_PLUGIN_DIR;

        process.env.ATMUX_CLAUDE_EFFORT = priorEnv.ATMUX_CLAUDE_EFFORT ?? "";
        if (priorEnv.ATMUX_CLAUDE_EFFORT === undefined) delete process.env.ATMUX_CLAUDE_EFFORT;

        if (isWithin(tempRoot, socketPath)) {
          try {
            await createTmux({
              socketPath,
              configFile: getAtmuxTmuxConfPath(),
            }).server.killServer();
          } catch {
            // best-effort cleanup for the private test socket.
          }
        }

        if (isWithin(tmpdir(), tempRoot)) {
          await rm(tempRoot, { recursive: true, force: true });
        }
      }
    });
  });
}
