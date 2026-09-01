import { afterEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type SpawnOpts, type SpawnResult } from "../../src/abstractions/spawn.ts";
import type { TmuxNamespace } from "../../src/abstractions/tmux.ts";
import { SuperbotKanbanAdapter } from "../../src/adapters/superbot-kanban.ts";
import type { LoadedCockpit } from "../../src/core/cockpit.ts";
import type { Team } from "../../src/schema/team.ts";
import { superbotTick } from "../../src/verbs/superbot.ts";

const roots: string[] = [];
const KANBAN_UNSET_ENV = ["KANBAN_PROJECT", "KANBAN_DB", "KANBAN_DATA_DIR"] as const;
type RecordedSpawn = {
  cmd: string;
  argv: ReadonlyArray<string>;
  cwd?: string;
  unsetEnv?: ReadonlyArray<string>;
};

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

function isolatedEnv(dataHome: string): Record<string, string> {
  return { XDG_DATA_HOME: dataHome };
}

async function runKb(
  argv: ReadonlyArray<string>,
  cwd: string,
  dataHome: string,
  recordedCalls?: RecordedSpawn[],
  expectExitCode: number | ReadonlyArray<number> = 0,
): Promise<SpawnResult> {
  const call = {
    cmd: safeKanbanBinary,
    argv,
    cwd,
    env: isolatedEnv(dataHome),
    unsetEnv: KANBAN_UNSET_ENV,
    expectExitCode,
    timeoutMs: 30_000,
  };
  recordedCalls?.push(call);
  return await spawn(call);
}

describe.skipIf(
  installedKanbanBinary === null,
)(
  "_superbot installed-Kanban process boundary (requires a nonblank KANBAN_BIN or kanban on PATH)",
  () => {
  test("shadow-routes real candidates and concurrent exact claims produce one winner", async () => {
    const root = await mkdtemp(join(tmpdir(), "atmux-superbot-kanban-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const dataHome = join(root, "xdg");
    await mkdir(workspace, { recursive: true });
    const board = `superbot-process-${process.pid}-${Date.now()}`;
    const recordedCalls: RecordedSpawn[] = [];

    await runKb(["init", "--name", board, "--as", "fixture", "--json"], workspace, dataHome, recordedCalls);
    const tags = ["cockpit", "dispatch", "team-config"];
    for (const tag of tags) {
      await runKb(
        [
          "tag",
          "add",
          tag,
          "--description",
          `isolated ${tag} routing fixture`,
          "--as",
          "fixture",
          "--json",
        ],
        workspace,
        dataHome,
        recordedCalls,
      );
    }
    const taskIds: Record<string, string> = {};
    for (const tag of tags) {
      const created = await runKb(
        [
          "task",
          "add",
          `isolated ${tag} candidate`,
          "--as",
          "fixture",
          "--tag",
          tag,
          "--json",
        ],
        workspace,
        dataHome,
        recordedCalls,
      );
      taskIds[tag] = (JSON.parse(created.stdout) as { id: string }).id;
    }
    const taskId = taskIds.dispatch;
    if (taskId === undefined) throw new Error("dispatch fixture task missing");

    const adapter = new SuperbotKanbanAdapter(
      async (opts: SpawnOpts): Promise<SpawnResult> =>
        await spawn(
          ((call) => {
            recordedCalls.push(call);
            return call;
          })({
            ...opts,
            cmd: safeKanbanBinary,
            cwd: opts.cwd ?? workspace,
            env: { ...opts.env, XDG_DATA_HOME: dataHome },
          }),
        ),
    );
    const candidates = await adapter.candidates(board, "dispatch", "superbot@cockpit", 20);
    expect(candidates.map((candidate) => candidate.id)).toContain(taskId);

    let sends = 0;
    const capture = "completed\n❯ \n⏵⏵ auto mode on";
    const tmux = {
      session: { hasSession: async () => true },
      window: { listWindows: async () => [{ index: 1, id: "@1", name: "_bot", active: true }] },
      option: { showOptions: async () => ({}) },
      pane: {
        displayMessage: async () => "sh\t0",
        capturePane: async () => capture,
        sendKeys: async () => {
          sends += 1;
        },
      },
    } as unknown as TmuxNamespace;
    const team: Team = {
      name: "alpha",
      members: [],
      bot: { enabled: true, tui: "claude", cwd: ".atmux/worktrees/bot" },
    };
    const cockpit = {
      schemaVersion: 1,
      cockpitSession: "atx",
      sessions: [{ type: "team", name: "alpha", enabled: true, root: workspace, sessions: [] }],
      windows: [],
      teams: [{ name: "alpha", enabled: true, root: workspace }],
      superbot: {
        enabled: true,
        shadow: true,
        intervalMins: 30,
        fallbackAfterIntervals: 1,
        maxOffersPerTick: 20,
        routes: tags.map((tag) => ({
          board,
          tag,
          defaultTeam: "alpha",
          fallbackTeams: [],
        })),
      },
    } as LoadedCockpit;
    const rows = await superbotTick(cockpit, false, {
      kanban: adapter,
      tmuxFactory: () => tmux,
      loadTeamFn: async () => team,
      now: () => 1_000,
      sleep: async () => {},
    });
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => [row.tag, row.outcome]).sort()).toEqual(
      tags.map((tag) => [tag, "shadow-offer"]).sort(),
    );
    expect(sends).toBe(0);
    const afterShadow = await runKb(
      ["task", "show", taskId, "--project", board, "--json"],
      workspace,
      dataHome,
      recordedCalls,
    );
    expect((JSON.parse(afterShadow.stdout) as { metadata: Record<string, unknown> }).metadata).toEqual(
      {},
    );

    const [alpha, beta] = await Promise.all([
      runKb(
        ["claim", taskId, "--project", board, "--as", "bot@alpha", "--json"],
        workspace,
        dataHome,
        recordedCalls,
        [0, 1],
      ),
      runKb(
        ["claim", taskId, "--project", board, "--as", "bot@beta", "--json"],
        workspace,
        dataHome,
        recordedCalls,
        [0, 1],
      ),
    ]);
    expect([alpha.exitCode, beta.exitCode].sort()).toEqual([0, 1]);

    const winner = alpha.exitCode === 0 ? "bot@alpha" : "bot@beta";
    const loser = alpha.exitCode === 0 ? beta : alpha;
    expect(loser.stderr).toContain("already claimed");
    const detail = await runKb(
      ["task", "show", taskId, "--project", board, "--json"],
      workspace,
      dataHome,
      recordedCalls,
    );
    expect((JSON.parse(detail.stdout) as { claim: { agentID: string } }).claim.agentID).toBe(
      winner,
    );

    expect(recordedCalls.length).toBeGreaterThan(0);
    for (const call of recordedCalls) {
      expect(call.cmd).toBe(safeKanbanBinary);
      expect(call.argv.length).toBeGreaterThan(0);
      expect(call.unsetEnv).toEqual([...KANBAN_UNSET_ENV]);
      expect(call.cwd).toBeDefined();
      expect(realpathSync(call.cwd ?? "")).toBe(realpathSync(workspace));
    }
    expect(
      recordedCalls.some((call) => call.argv[0] === "claim" && call.argv[1] === "--candidates"),
    ).toBe(true);
    expect(recordedCalls.some((call) => call.argv[0] === "task" && call.argv[1] === "show")).toBe(
      true,
    );
    expect(recordedCalls.some((call) => call.argv[0] === "workspace" && call.argv[1] === "list")).toBe(
      true,
    );
  });
  },
);
