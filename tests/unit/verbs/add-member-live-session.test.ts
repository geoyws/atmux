import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import type { Logger } from "../../../src/core/tui.ts";
import { addMember } from "../../../src/verbs/add-member.ts";

test("live session probes =session, spawns the member window, and reports success", async () => {
  const teamDir = await mkdtemp(join(tmpdir(), "atmux-add-member-live-"));
  const socketPath = join(teamDir, "sock");
  const sessionName = "atlas";
  const teamName = "team-live";
  const logs: { kind: "log" | "ok" | "warn" | "err"; msg: string }[] = [];
  const hasSessionCalls: string[] = [];
  const newWindowCalls: Array<{
    sessionName: string;
    name?: string;
    cwd?: string;
    detached?: boolean;
  }> = [];
  const factoryCalls: Array<{ socketPath?: string }> = [];

  const logger: Logger = {
    log: (msg) => logs.push({ kind: "log", msg }),
    ok: (msg) => logs.push({ kind: "ok", msg }),
    warn: (msg) => logs.push({ kind: "warn", msg }),
    err: (msg) => logs.push({ kind: "err", msg }),
  };

  const tmux = {
    session: {
      hasSession: async (target: string) => {
        hasSessionCalls.push(target);
        expect(target).toBe(`=${sessionName}`);
        return true;
      },
    },
    window: {
      newWindow: async (opts: {
        sessionName: string;
        name?: string;
        cwd?: string;
        detached?: boolean;
      }) => {
        newWindowCalls.push(opts);
        expect(opts).toEqual({
          sessionName,
          name: "🧭-alpha",
          cwd: teamDir,
          detached: true,
        });
        return { sessionName: opts.sessionName, windowIndex: 7 };
      },
    },
  } as unknown as TmuxNamespace;

  await writeFile(
    join(teamDir, "team.json"),
    `${JSON.stringify(
      {
        name: teamName,
        members: [],
        emojis: { mode: "static" },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  try {
    const exit = await addMember(["alpha", "--role", "team-lead", "--socket-path", socketPath], {
      env: { ...process.env, ATMUX_DIR: teamDir, ATMUX_SESSION: sessionName },
      cwd: teamDir,
      logger,
      rng: () => 0,
      tmuxFactory: (cfg) => {
        factoryCalls.push(cfg);
        expect(cfg).toEqual({ socketPath });
        return tmux;
      },
    });

    expect(exit).toBe(0);
    expect(factoryCalls).toEqual([{ socketPath }]);
    expect(hasSessionCalls).toEqual([`=${sessionName}`]);
    expect(newWindowCalls).toEqual([
      {
        sessionName,
        name: "🧭-alpha",
        cwd: teamDir,
        detached: true,
      },
    ]);
    expect(logs).toEqual([
      {
        kind: "ok",
        msg: "added member '🧭 alpha' (role=team-lead, tui=claude) to team.json",
      },
      {
        kind: "log",
        msg: "  session is up — spawning the member now",
      },
      {
        kind: "ok",
        msg: `spawned alpha in ${sessionName}:🧭-alpha`,
      },
    ]);
  } finally {
    await rm(teamDir, { recursive: true, force: true });
  }
});
