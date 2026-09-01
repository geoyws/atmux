import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type SpawnOpts, type SpawnResult } from "../../src/abstractions/spawn.ts";
import { createTmux, type TmuxNamespace } from "../../src/abstractions/tmux.ts";
import { SuperbotKanbanAdapter } from "../../src/adapters/superbot-kanban.ts";
import { BOT_HOLD_OPTION, botSendTarget } from "../../src/core/bot.ts";
import type { LoadedCockpit } from "../../src/core/cockpit.ts";
import { getAtmuxTmuxConfPath } from "../../src/core/tmux-paths.ts";
import type { Team } from "../../src/schema/team.ts";
import { superbotTick } from "../../src/verbs/superbot.ts";

const roots: string[] = [];

function resolveInstalledKanbanBinary(): string | null {
  const explicit = process.env.KANBAN_BIN?.trim();
  if (explicit) return explicit;
  return Bun.which("kanban");
}

const installedKanbanBinary = resolveInstalledKanbanBinary();
const safeKanbanBinary = installedKanbanBinary ?? "kanban";

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

async function runKb(
  argv: ReadonlyArray<string>,
  cwd: string,
  dataHome: string,
): Promise<SpawnResult> {
  return await spawn({
    cmd: safeKanbanBinary,
    argv,
    cwd,
    env: { XDG_DATA_HOME: dataHome },
    unsetEnv: ["KANBAN_PROJECT", "KANBAN_DB", "KANBAN_DATA_DIR"],
    timeoutMs: 30_000,
  });
}

async function waitFor(
  tmux: TmuxNamespace,
  target: string,
  pattern: string,
): Promise<string> {
  let capture = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    capture = await tmux.pane.capturePane({ target, start: -80 });
    if (capture.includes(pattern)) return capture;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`isolated pane never displayed ${JSON.stringify(pattern)}: ${capture}`);
}

describe.skipIf(installedKanbanBinary === null)(
  "_superbot isolated live-offer simulation (requires a nonblank KANBAN_BIN or kanban on PATH)",
  () => {
  test("hold and manual typing defer; one offer uses the exact claim command", async () => {
    const root = await mkdtemp(join(tmpdir(), "atmux-superbot-offer-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const dataHome = join(root, "xdg");
    const socketPath = join(root, "tmux", "superbot.sock");
    const fakeTui = join(root, "fake-claude.ts");
    await mkdir(workspace, { recursive: true });
    await mkdir(join(root, "tmux"), { recursive: true });
    await writeFile(
      fakeTui,
      [
        "#!/usr/bin/env bun",
        "process.stdout.write('● isolated bot ready\\n\\n⏵⏵ auto mode on\\n❯ ');",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => {",
        "  for (const line of String(chunk).split(/[\\r\\n]+/).filter(Boolean)) {",
        "    process.stdout.write(`accepted:${line}\\n⏵⏵ auto mode on\\n❯ `);",
        "  }",
        "});",
        "process.stdin.resume();",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakeTui, 0o700);

    const board = `superbot-offer-${process.pid}-${Date.now()}`;
    await runKb(["init", "--name", board, "--as", "fixture", "--json"], workspace, dataHome);
    await runKb(
      ["tag", "add", "dispatch", "--as", "fixture", "--json"],
      workspace,
      dataHome,
    );
    const created = await runKb(
      [
        "task",
        "add",
        "isolated live offer",
        "--as",
        "fixture",
        "--tag",
        "dispatch",
        "--json",
      ],
      workspace,
      dataHome,
    );
    const taskId = (JSON.parse(created.stdout) as { id: string }).id;

    const tmux = createTmux({ socketPath, configFile: getAtmuxTmuxConfPath() });
    try {
      await tmux.session.newSession({
        name: "alpha",
        detached: true,
        windowName: "_bot",
        cwd: workspace,
        shellCommand: fakeTui,
      });
      const target = "alpha:_bot";
      await waitFor(tmux, target, "isolated bot ready");

      const adapter = new SuperbotKanbanAdapter(
        async (opts: SpawnOpts): Promise<SpawnResult> =>
          await spawn({
            ...opts,
            cmd: safeKanbanBinary,
            cwd: workspace,
            env: { ...opts.env, XDG_DATA_HOME: dataHome },
          }),
      );
      const team: Team = {
        name: "alpha",
        members: [],
        bot: { enabled: true, tui: "claude", cwd: ".atmux/worktrees/bot" },
      };
      const cockpit = {
        schemaVersion: 1,
        cockpitSession: "atx",
        sessions: [
          { type: "team", name: "alpha", enabled: true, root: workspace, sessions: [] },
        ],
        windows: [],
        teams: [{ name: "alpha", enabled: true, root: workspace }],
        superbot: {
          enabled: true,
          shadow: false,
          intervalMins: 30,
          fallbackAfterIntervals: 1,
          maxOffersPerTick: 20,
          routes: [
            { board, tag: "dispatch", defaultTeam: "alpha", fallbackTeams: [] },
          ],
        },
      } as LoadedCockpit;
      const deps = {
        kanban: adapter,
        tmuxFactory: () => tmux,
        loadTeamFn: async () => team,
        now: () => 1_000,
        sleep: async () => {},
        paneLockDir: join(root, "locks"),
      };

      await tmux.option.setOption({
        window: true,
        target,
        name: BOT_HOLD_OPTION,
        value: "1",
      });
      expect((await superbotTick(cockpit, false, deps))[0]).toMatchObject({
        task: taskId,
        outcome: "not-ready",
        reason: "held",
      });
      await tmux.option.setOption({
        window: true,
        target,
        name: BOT_HOLD_OPTION,
        value: "0",
      });

      await tmux.pane.sendKeys({
        target: botSendTarget("alpha", "alpha"),
        keys: "operator draft",
        literal: true,
        enter: false,
      });
      await waitFor(tmux, target, "operator draft");
      expect((await superbotTick(cockpit, false, deps))[0]).toMatchObject({
        task: taskId,
        outcome: "not-ready",
        reason: "composer-not-empty",
      });
      await tmux.pane.sendKeys({
        target: botSendTarget("alpha", "alpha"),
        keys: "C-u",
        enter: false,
      });

      const offered = await superbotTick(cockpit, false, deps);
      expect(offered).toEqual([
        {
          board,
          tag: "dispatch",
          task: taskId,
          team: "alpha",
          outcome: "offered",
          reason: "default",
        },
      ]);
      const after = await waitFor(
        tmux,
        target,
        `accepted:kb claim ${taskId}`,
      );
      const dewrapped = after.replaceAll("\n", "");
      expect(dewrapped).toContain(
        `kb claim ${taskId} --project ${board} --as bot@alpha --json`,
      );
      expect(dewrapped).toContain("If the claim is refused, stop immediately");

      const detail = await runKb(
        ["task", "show", taskId, "--project", board, "--json"],
        workspace,
        dataHome,
      );
      const metadata = (JSON.parse(detail.stdout) as { metadata: Record<string, unknown> }).metadata;
      expect(metadata.atmuxSuperbot).toMatchObject({ pending: null });

      await tmux.pane.sendKeys({
        target: botSendTarget("alpha", "alpha"),
        keys: "operator after offer",
        literal: true,
        enter: false,
      });
      expect(await waitFor(tmux, target, "operator after offer")).toContain(
        "operator after offer",
      );
    } finally {
      try {
        await tmux.server.killServer();
      } catch {}
    }
  });
  },
);
