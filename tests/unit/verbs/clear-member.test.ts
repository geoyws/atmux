// e-cc3728bf T3 — `atmux clear-member` verb: kill + recreate bare.
// Destructive: --force gate. Own minimal tmux stub (kill/new/rename).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import { clearMember, parseClearMemberArgs } from "../../../src/verbs/clear-member.ts";

interface Calls {
  listWindows: string[];
  killWindow: string[];
  newWindow: Array<{ sessionName: string; name?: string; cwd?: string }>;
  renameWindow: string[];
}

function stubTmux(windows: Array<{ index: number; name: string; active: boolean }>): {
  tmux: TmuxNamespace;
  calls: Calls;
} {
  const calls: Calls = { listWindows: [], killWindow: [], newWindow: [], renameWindow: [] };
  const tmux = {
    window: {
      async listWindows(session: string) {
        calls.listWindows.push(session);
        return [...windows];
      },
      async killWindow(target: string) {
        calls.killWindow.push(target);
      },
      async newWindow(o: { sessionName: string; name?: string; cwd?: string }) {
        const row: { sessionName: string; name?: string; cwd?: string } = { sessionName: o.sessionName };
        if (o.name !== undefined) row.name = o.name;
        if (o.cwd !== undefined) row.cwd = o.cwd;
        calls.newWindow.push(row);
        return `${o.sessionName}:${o.name ?? ""}:0`;
      },
      async renameWindow(target: string) {
        calls.renameWindow.push(target);
      },
    },
  } as unknown as TmuxNamespace;
  return { tmux, calls };
}

describe("parseClearMemberArgs", () => {
  test("--force + member parsed", () => {
    expect(parseClearMemberArgs(["alice", "--force"])).toEqual({ member: "alice", force: true });
  });
  test("-f shorthand", () => {
    expect(parseClearMemberArgs(["-f", "alice"]).force).toBe(true);
  });
  test("missing member rejected", () => {
    expect(() => parseClearMemberArgs(["--force"])).toThrow(UsageError);
  });
  test("unknown flag rejected", () => {
    expect(() => parseClearMemberArgs(["alice", "--force", "--frobnicate"])).toThrow(UsageError);
  });
});

describe("clearMember", () => {
  let scratch: string;
  let priorSession: string | undefined;
  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "atmux-clear-member-"));
    priorSession = process.env.ATMUX_SESSION;
    process.env.ATMUX_SESSION = "atmux-t";
    const atmuxDir = join(scratch, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
    await writeFile(join(atmuxDir, "team.json"), JSON.stringify({ name: "t", members: [{ name: "alice", role: "member" }] }));
  });
  afterEach(async () => {
    if (priorSession !== undefined) process.env.ATMUX_SESSION = priorSession;
    else delete process.env.ATMUX_SESSION;
    await rm(scratch, { recursive: true, force: true });
  });

  test("refuses without --force (destructive gate)", async () => {
    const { tmux } = stubTmux([{ index: 0, name: "alice", active: true }]);
    await expect(clearMember(["--team-dir", scratch, "alice"], { buildTmux: () => tmux })).rejects.toThrow(/without --force/);
  });
  test("unknown member → ConfigError", async () => {
    const { tmux } = stubTmux([]);
    await expect(clearMember(["--team-dir", scratch, "--force", "ghost"], { buildTmux: () => tmux })).rejects.toThrow(ConfigError);
  });
  test("missing window → ConfigError, nothing killed", async () => {
    const { tmux, calls } = stubTmux([]);
    await expect(clearMember(["--team-dir", scratch, "--force", "alice"], { buildTmux: () => tmux })).rejects.toThrow(ConfigError);
    expect(calls.killWindow).toHaveLength(0);
    expect(calls.newWindow).toHaveLength(0);
  });
  test("happy path kills + recreates bare, output names window", async () => {
    const { tmux, calls } = stubTmux([{ index: 0, name: "alice", active: true }]);
    let out = "";
    const exit = await clearMember(["--team-dir", scratch, "--force", "alice"], {
      buildTmux: () => tmux,
      stdout: (s) => { out += s; },
    });
    expect(exit).toBe(0);
    expect(calls.killWindow).toEqual(["atmux-t:alice"]);
    expect(calls.newWindow).toHaveLength(1);
    expect(calls.newWindow[0]?.name).toBe("alice");
    expect(calls.newWindow[0]?.cwd).toBe(scratch);
    expect(calls.renameWindow).toHaveLength(0);
    expect(out).toContain("cleared alice (window=alice)");
    expect(out).toContain("re-brief by hand");
  });
});
