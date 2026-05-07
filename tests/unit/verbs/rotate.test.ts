// Unit tests for src/verbs/rotate.ts (ADR-010).
// Bash spec ref: lib/rotate.sh @ worktree-frozen.
//
// Coverage strategy
// -----------------
// Pure helpers (`parseRotateArgs`, `findLeadMember`, `getBriefPath`,
// `renderBrief`, `windowExists`) are exercised directly. The public
// verb is driven against a stub `TmuxNamespace` injected via
// `opts.buildTmux` — captures every send-keys / loadBuffer /
// pasteBuffer call so we can assert on order + payload without
// spinning a real tmux server.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeSendTarget, type TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import {
  defaultBriefsDir,
  defaultBuildTmux,
  defaultSleep,
  findLeadMember,
  getBriefPath,
  parseRotateArgs,
  renderBrief,
  rotate,
  rotateLead,
  windowExists,
} from "../../../src/verbs/rotate.ts";

// ---------- parseRotateArgs ----------

describe("parseRotateArgs", () => {
  test("empty argv → forLead=false, member empty", () => {
    expect(parseRotateArgs([])).toEqual({ forLead: false, member: "" });
  });

  test("--lead → forLead=true, member empty", () => {
    expect(parseRotateArgs(["--lead"])).toEqual({ forLead: true, member: "" });
  });

  test("positional member → forLead=false, member set", () => {
    expect(parseRotateArgs(["alice"])).toEqual({ forLead: false, member: "alice" });
  });

  test("--socket <path> captured", () => {
    expect(parseRotateArgs(["--socket", "/s", "alice"])).toEqual({
      forLead: false,
      member: "alice",
      socketPath: "/s",
    });
  });

  test("--team-dir <dir> captured", () => {
    expect(parseRotateArgs(["--team-dir", "/d", "alice"])).toEqual({
      forLead: false,
      member: "alice",
      teamDir: "/d",
    });
  });

  test("--socket without value → UsageError", () => {
    expect(() => parseRotateArgs(["--socket"])).toThrow(UsageError);
  });

  test("--team-dir without value → UsageError", () => {
    expect(() => parseRotateArgs(["--team-dir"])).toThrow(UsageError);
  });

  test("unknown flag → UsageError", () => {
    expect(() => parseRotateArgs(["--bogus"])).toThrow(UsageError);
  });

  test("two positionals → UsageError 'too many args'", () => {
    expect(() => parseRotateArgs(["alice", "bob"])).toThrow(UsageError);
  });
});

// ---------- findLeadMember ----------

describe("findLeadMember", () => {
  test("returns the first team-lead in roster order", () => {
    const m = findLeadMember({
      name: "t",
      members: [
        { name: "alpha", role: "member" },
        { name: "lead-1", role: "team-lead" },
        { name: "lead-2", role: "team-lead" },
      ],
    });
    expect(m?.name).toBe("lead-1");
  });

  test("null when no team-lead in roster", () => {
    expect(
      findLeadMember({
        name: "t",
        members: [{ name: "alpha", role: "member" }],
      }),
    ).toBeNull();
  });

  test("null on empty roster", () => {
    expect(findLeadMember({ name: "t", members: [] })).toBeNull();
  });
});

// ---------- getBriefPath ----------

describe("getBriefPath", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atmux-rotate-briefs-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("returns role-specific path when present", async () => {
    await writeFile(join(dir, "reviewer.md"), "rev");
    await writeFile(join(dir, "member.md"), "m");
    expect(await getBriefPath("reviewer", dir)).toBe(join(dir, "reviewer.md"));
  });

  test("falls back to member.md when role file absent", async () => {
    await writeFile(join(dir, "member.md"), "m");
    expect(await getBriefPath("planner", dir)).toBe(join(dir, "member.md"));
  });

  test("returns member.md path even if it doesn't exist (caller checks)", async () => {
    expect(await getBriefPath("foo", dir)).toBe(join(dir, "member.md"));
  });
});

// ---------- renderBrief ----------

describe("renderBrief", () => {
  test("substitutes all four placeholder keys", () => {
    const tpl = "team={{TEAM}} member={{MEMBER}} role={{ROLE}} dir={{ATMUX_DIR}}";
    expect(
      renderBrief(tpl, { team: "alpha", member: "bob", role: "reviewer", atmuxDir: "/x/.atmux" }),
    ).toBe("team=alpha member=bob role=reviewer dir=/x/.atmux");
  });

  test("replaces ALL occurrences (replaceAll, not first-match)", () => {
    expect(
      renderBrief("{{TEAM}}-{{TEAM}}", { team: "x", member: "", role: "", atmuxDir: "" }),
    ).toBe("x-x");
  });

  test("leaves non-matching {{...}} alone (no greedy regex)", () => {
    expect(
      renderBrief("{{UNKNOWN}} kept; {{TEAM}} replaced", {
        team: "x",
        member: "",
        role: "",
        atmuxDir: "",
      }),
    ).toBe("{{UNKNOWN}} kept; x replaced");
  });
});

// ---------- defaultBriefsDir ----------

describe("defaultBriefsDir", () => {
  test("resolves to <repo>/templates/briefs", () => {
    const d = defaultBriefsDir();
    expect(d.endsWith("/templates/briefs")).toBe(true);
  });
});

// ---------- default helper functions ----------

describe("defaultSleep", () => {
  test("resolves after ~0ms (covers the setTimeout path)", async () => {
    await defaultSleep(0);
  });
});

describe("defaultBuildTmux", () => {
  test("returns a TmuxNamespace pinned to the supplied socketPath", () => {
    // We don't drive a real tmux subprocess — just probe the factory
    // returns the expected shape (has .session / .window / .pane /
    // .buffer namespaces). No process spawned.
    const ns = defaultBuildTmux("/tmp/atmux-rotate-defaultbuildtmux-noop/sock");
    expect(typeof ns.window.listWindows).toBe("function");
    expect(typeof ns.pane.sendKeys).toBe("function");
    expect(typeof ns.buffer.loadBuffer).toBe("function");
  });
});

// ---------- windowExists ----------

interface StubTmuxCalls {
  sendKeys: Array<{ target: string; keys: string; enter: boolean | undefined }>;
  loadBuffer: Array<{ name: string | undefined; data: string }>;
  pasteBuffer: Array<{
    name: string | undefined;
    target: string;
    deleteAfter: boolean | undefined;
  }>;
  listWindows: string[];
}

function stubTmux(opts: {
  windows?: ReadonlyArray<{ index: number; name: string; active: boolean }>;
}): { tmux: TmuxNamespace; calls: StubTmuxCalls } {
  const calls: StubTmuxCalls = {
    sendKeys: [],
    loadBuffer: [],
    pasteBuffer: [],
    listWindows: [],
  };
  const tmux = {
    window: {
      async listWindows(session: string) {
        calls.listWindows.push(session);
        return [...(opts.windows ?? [])];
      },
    },
    pane: {
      // ADR-025: o.target is now SendTarget. Unwrap via serializeSendTarget
      // so existing string-equality assertions stay byte-identical.
      async sendKeys(o: {
        target: import("../../../src/abstractions/tmux.ts").SendTarget;
        keys: string;
        enter?: boolean;
      }) {
        calls.sendKeys.push({
          target: serializeSendTarget(o.target),
          keys: o.keys,
          enter: o.enter,
        });
      },
    },
    buffer: {
      async loadBuffer(o: { name?: string; data: string }) {
        calls.loadBuffer.push({ name: o.name, data: o.data });
      },
      async pasteBuffer(o: {
        name?: string;
        target: import("../../../src/abstractions/tmux.ts").SendTarget;
        deleteAfter?: boolean;
      }) {
        calls.pasteBuffer.push({
          name: o.name,
          target: serializeSendTarget(o.target),
          deleteAfter: o.deleteAfter,
        });
      },
    },
  } as unknown as TmuxNamespace;
  return { tmux, calls };
}

describe("windowExists", () => {
  test("true when listWindows yields a matching name", async () => {
    const { tmux } = stubTmux({
      windows: [
        { index: 0, name: "alice", active: false },
        { index: 1, name: "🐝bob", active: true },
      ],
    });
    expect(await windowExists(tmux, "atmux-x", "🐝bob")).toBe(true);
  });

  test("false when no window matches", async () => {
    const { tmux } = stubTmux({ windows: [{ index: 0, name: "alice", active: true }] });
    expect(await windowExists(tmux, "atmux-x", "ghost")).toBe(false);
  });
});

// ---------- rotate() public verb ----------

describe("rotate() — public verb", () => {
  let scratch: string;
  let briefsDir: string;
  let priorAtmuxDir: string | undefined;
  let priorAtmuxTeamDir: string | undefined;
  let priorAtmuxSession: string | undefined;
  let priorAtmuxDriverSession: string | undefined;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "atmux-rotate-"));
    briefsDir = await mkdtemp(join(tmpdir(), "atmux-rotate-briefs-"));
    priorAtmuxDir = process.env.ATMUX_DIR;
    priorAtmuxTeamDir = process.env.ATMUX_TEAM_DIR;
    priorAtmuxSession = process.env.ATMUX_SESSION;
    priorAtmuxDriverSession = process.env.ATMUX_DRIVER_SESSION;
    delete process.env.ATMUX_DIR;
    delete process.env.ATMUX_TEAM_DIR;
    delete process.env.ATMUX_SESSION;
    delete process.env.ATMUX_DRIVER_SESSION;
  });

  afterEach(async () => {
    // Always delete-then-restore: tests in this file SET ATMUX_SESSION
    // for the cross-session-name path, and the prior value may be
    // undefined. Without the delete first, the set leaks to the next
    // test file (causes tell-lead's "atmux-t" assertion to drift).
    delete process.env.ATMUX_DIR;
    delete process.env.ATMUX_TEAM_DIR;
    delete process.env.ATMUX_SESSION;
    delete process.env.ATMUX_DRIVER_SESSION;
    if (priorAtmuxDir !== undefined) process.env.ATMUX_DIR = priorAtmuxDir;
    if (priorAtmuxTeamDir !== undefined) process.env.ATMUX_TEAM_DIR = priorAtmuxTeamDir;
    if (priorAtmuxSession !== undefined) process.env.ATMUX_SESSION = priorAtmuxSession;
    if (priorAtmuxDriverSession !== undefined)
      process.env.ATMUX_DRIVER_SESSION = priorAtmuxDriverSession;
    await rm(scratch, { recursive: true, force: true });
    await rm(briefsDir, { recursive: true, force: true });
  });

  async function seedTeam(team: unknown): Promise<void> {
    const atmuxDir = join(scratch, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
    await writeFile(join(atmuxDir, "team.json"), JSON.stringify(team));
  }

  test("argv parse error → UsageError", async () => {
    await expect(rotate(["--socket"])).rejects.toBeInstanceOf(UsageError);
  });

  test("missing team.json → ConfigError", async () => {
    await expect(rotate(["--team-dir", scratch, "alice"])).rejects.toBeInstanceOf(ConfigError);
  });

  test("--lead with no team-lead in roster → ConfigError", async () => {
    await seedTeam({
      name: "t",
      members: [{ name: "alice", role: "member" }],
    });
    await expect(rotate(["--team-dir", scratch, "--lead"])).rejects.toBeInstanceOf(ConfigError);
  });

  test("bare form with no positional → UsageError", async () => {
    await seedTeam({ name: "t", members: [{ name: "alice" }] });
    await expect(rotate(["--team-dir", scratch])).rejects.toBeInstanceOf(UsageError);
  });

  test("bare form with unknown member → ConfigError", async () => {
    await seedTeam({ name: "t", members: [{ name: "alice" }] });
    await expect(rotate(["--team-dir", scratch, "ghost"])).rejects.toBeInstanceOf(ConfigError);
  });

  test("missing tmux window → ConfigError", async () => {
    await seedTeam({
      name: "t",
      members: [{ name: "alice", tui: "claude" }],
    });
    const { tmux } = stubTmux({ windows: [] });
    await expect(
      rotate(["--team-dir", scratch, "alice"], { buildTmux: () => tmux }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  test("happy path: claude TUI → /clear sent + brief pasted", async () => {
    process.env.ATMUX_SESSION = "atmux-t";
    await seedTeam({
      name: "t",
      members: [{ name: "alice", role: "reviewer", tui: "claude" }],
    });
    await writeFile(
      join(briefsDir, "reviewer.md"),
      "team={{TEAM}} member={{MEMBER}} role={{ROLE}} dir={{ATMUX_DIR}}",
    );
    const { tmux, calls } = stubTmux({
      windows: [{ index: 0, name: "alice", active: true }],
    });
    let stdoutBuf = "";
    let stderrBuf = "";
    const exit = await rotate(["--team-dir", scratch, "alice"], {
      buildTmux: () => tmux,
      briefsDir,
      sleep: async () => {
        /* no-op for tests — bypass real 2s/1s delays */
      },
      stdout: (s) => {
        stdoutBuf += s;
      },
      stderr: (s) => {
        stderrBuf += s;
      },
    });
    expect(exit).toBe(0);
    // First send-keys is /clear.
    expect(calls.sendKeys[0]).toEqual({
      target: "atmux-t:alice",
      keys: "/clear",
      enter: true,
    });
    // Then load + paste the rendered brief.
    expect(calls.loadBuffer.length).toBe(1);
    expect(calls.loadBuffer[0]?.name).toBe("atmux_brief_rot_alice");
    expect(calls.loadBuffer[0]?.data).toBe(
      `team=t member=alice role=reviewer dir=${join(scratch, ".atmux")}`,
    );
    expect(calls.pasteBuffer.length).toBe(1);
    expect(calls.pasteBuffer[0]?.deleteAfter).toBe(true);
    // Trailing Enter to submit the pasted body.
    expect(calls.sendKeys[calls.sendKeys.length - 1]).toEqual({
      target: "atmux-t:alice",
      keys: "Enter",
      enter: false,
    });
    expect(stdoutBuf).toBe("rotated alice (role=reviewer, tui=claude)\n");
    expect(stderrBuf).toBe("");
  });

  test("happy path: --lead resolves the team-lead from roster", async () => {
    process.env.ATMUX_SESSION = "atmux-t";
    await seedTeam({
      name: "t",
      members: [
        { name: "alpha", role: "member", tui: "claude" },
        { name: "lead-x", role: "team-lead", tui: "claude" },
      ],
    });
    const { tmux, calls } = stubTmux({
      windows: [
        { index: 0, name: "alpha", active: false },
        { index: 1, name: "lead-x", active: true },
      ],
    });
    const exit = await rotate(["--team-dir", scratch, "--lead"], {
      buildTmux: () => tmux,
      briefsDir, // no team-lead.md staged → falls through to member.md (also absent → silent skip)
      sleep: async () => {},
      stdout: () => {},
    });
    expect(exit).toBe(0);
    expect(calls.sendKeys[0]?.target).toBe("atmux-t:lead-x");
    // No brief file in briefsDir → no loadBuffer / pasteBuffer.
    expect(calls.loadBuffer).toEqual([]);
    expect(calls.pasteBuffer).toEqual([]);
  });

  test("ADR-057 §D2c: --lead writes pre-rotate handoff file", async () => {
    process.env.ATMUX_SESSION = "atmux-t";
    const atmuxDir = join(scratch, ".atmux");
    await seedTeam({
      name: "t",
      members: [{ name: "lead-x", role: "team-lead", tui: "claude" }],
    });
    await mkdir(join(atmuxDir, "state"), { recursive: true });
    // Seed a minimal kanban so listTasks succeeds.
    await writeFile(
      join(atmuxDir, "kanban.json"),
      JSON.stringify({ version: 1, epics: [], stories: [], tasks: [] }),
    );
    const { tmux } = stubTmux({
      windows: [{ index: 0, name: "lead-x", active: true }],
    });
    let stdoutBuf = "";
    const fixedNowMs = 1778126400 * 1000;
    const exit = await rotate(["--team-dir", scratch, "--lead"], {
      buildTmux: () => tmux,
      briefsDir,
      sleep: async () => {},
      stdout: (s) => {
        stdoutBuf += s;
      },
      now: () => fixedNowMs,
    });
    expect(exit).toBe(0);
    expect(stdoutBuf).toContain("lead handoff written to");
    const handoffPath = join(atmuxDir, "state", "lead-handoff-1778126400.md");
    const md = await readFile(handoffPath, "utf8");
    expect(md).toContain("# Lead handoff — `t`");
    expect(md).toContain("**outgoing lead:** `lead-x`");
  });

  test("ADR-057 §D2c: regular member rotation does NOT write handoff", async () => {
    process.env.ATMUX_SESSION = "atmux-t";
    const atmuxDir = join(scratch, ".atmux");
    await seedTeam({
      name: "t",
      members: [{ name: "alice", role: "member", tui: "claude" }],
    });
    await mkdir(join(atmuxDir, "state"), { recursive: true });
    const { tmux } = stubTmux({
      windows: [{ index: 0, name: "alice", active: true }],
    });
    let stdoutBuf = "";
    await rotate(["--team-dir", scratch, "alice"], {
      buildTmux: () => tmux,
      briefsDir,
      sleep: async () => {},
      stdout: (s) => {
        stdoutBuf += s;
      },
    });
    expect(stdoutBuf).not.toContain("lead handoff");
    // No file in state/ matching the handoff prefix.
    const stateFiles = await readdir(join(atmuxDir, "state"));
    expect(stateFiles.some((f) => f.startsWith("lead-handoff-"))).toBe(false);
  });

  test("ADR-057 §D2c: handoff write failure logs to stderr but does NOT abort", async () => {
    process.env.ATMUX_SESSION = "atmux-t";
    const atmuxDir = join(scratch, ".atmux");
    await seedTeam({
      name: "t",
      members: [{ name: "lead-x", role: "team-lead", tui: "claude" }],
    });
    // Don't create state/ dir AND seed a corrupt kanban.json — the kanban
    // load will fail, propagating up. writeLeadHandoff catches via its
    // try/catch in rotate.ts.
    await writeFile(join(atmuxDir, "kanban.json"), "{ corrupt json");
    const { tmux } = stubTmux({
      windows: [{ index: 0, name: "lead-x", active: true }],
    });
    let stderrBuf = "";
    const exit = await rotate(["--team-dir", scratch, "--lead"], {
      buildTmux: () => tmux,
      briefsDir,
      sleep: async () => {},
      stdout: () => {},
      stderr: (s) => {
        stderrBuf += s;
      },
    });
    // Rotation continues despite handoff failure.
    expect(exit).toBe(0);
    expect(stderrBuf).toContain("lead handoff write failed");
  });

  test("non-claude TUI (opencode) → warn on stderr, no /clear, brief still pasted", async () => {
    process.env.ATMUX_SESSION = "atmux-t";
    await seedTeam({
      name: "t",
      members: [{ name: "bob", role: "member", tui: "opencode" }],
    });
    await writeFile(join(briefsDir, "member.md"), "{{MEMBER}}");
    const { tmux, calls } = stubTmux({
      windows: [{ index: 0, name: "bob", active: true }],
    });
    let stderrBuf = "";
    const exit = await rotate(["--team-dir", scratch, "bob"], {
      buildTmux: () => tmux,
      briefsDir,
      sleep: async () => {},
      stdout: () => {},
      stderr: (s) => {
        stderrBuf += s;
      },
    });
    expect(exit).toBe(0);
    // Only one send-keys — the trailing Enter for the brief paste.
    expect(calls.sendKeys.length).toBe(1);
    expect(calls.sendKeys[0]?.keys).toBe("Enter");
    expect(stderrBuf).toContain("rotate: tui=opencode has no /clear equivalent");
    expect(calls.loadBuffer.length).toBe(1);
    expect(calls.loadBuffer[0]?.data).toBe("bob");
  });

  test("--socket override forwards into the buildTmux factory", async () => {
    process.env.ATMUX_SESSION = "atmux-t";
    await seedTeam({
      name: "t",
      members: [{ name: "alice", tui: "claude" }],
    });
    const { tmux } = stubTmux({
      windows: [{ index: 0, name: "alice", active: true }],
    });
    let receivedSock = "";
    const exit = await rotate(["--team-dir", scratch, "--socket", "/custom/sock", "alice"], {
      buildTmux: (sp) => {
        receivedSock = sp;
        return tmux;
      },
      briefsDir,
      sleep: async () => {},
      stdout: () => {},
    });
    expect(exit).toBe(0);
    expect(receivedSock).toBe("/custom/sock");
  });

  test("default-socket branch hits getDefaultSocket when --socket omitted", async () => {
    process.env.ATMUX_SESSION = "atmux-t";
    await seedTeam({
      name: "team-default",
      members: [{ name: "alice", tui: "claude" }],
    });
    const { tmux } = stubTmux({
      windows: [{ index: 0, name: "alice", active: true }],
    });
    let receivedSock = "";
    const exit = await rotate(["--team-dir", scratch, "alice"], {
      buildTmux: (sp) => {
        receivedSock = sp;
        return tmux;
      },
      briefsDir,
      sleep: async () => {},
      stdout: () => {},
    });
    expect(exit).toBe(0);
    expect(receivedSock).toBe("/tmp/atmux-team-default/sock");
  });

  test("default stdout/stderr/sleep paths exercised when opts omitted", async () => {
    // Drive rotate without overriding sleep / stdout / stderr — covers
    // the `opts.X ?? defaultX` fallback branches. Use opencode tui +
    // missing brief so neither /clear nor brief-paste fires (no real
    // sleep needed); the warn-stderr line still hits defaultStderrWrite.
    process.env.ATMUX_SESSION = "atmux-t";
    await seedTeam({
      name: "t-defaults",
      members: [{ name: "alice", role: "member", tui: "opencode" }],
    });
    const { tmux } = stubTmux({
      windows: [{ index: 0, name: "alice", active: true }],
    });
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const exit = await rotate(["--team-dir", scratch, "alice"], {
        buildTmux: () => tmux,
        briefsDir: join(scratch, "no-such-briefs-dir"),
        // opts.sleep / opts.stdout / opts.stderr DELIBERATELY omitted —
        // verb falls through to the named-default exports.
      });
      expect(exit).toBe(0);
    } finally {
      process.stdout.write = origStdoutWrite;
      process.stderr.write = origStderrWrite;
    }
  });
});

describe("rotateLead", () => {
  test("delegates to rotate with --lead prepended", async () => {
    // rotateLead has no logic of its own — just argv re-prefix. Drive
    // it against a fixture and assert the lead branch fires (resolves
    // the lead role from roster).
    const dir = await mkdtemp(join(tmpdir(), "atmux-rotlead-"));
    const briefs = await mkdtemp(join(tmpdir(), "atmux-rotlead-briefs-"));
    try {
      const atmuxDir = join(dir, ".atmux");
      await mkdir(atmuxDir, { recursive: true });
      await writeFile(
        join(atmuxDir, "team.json"),
        JSON.stringify({
          name: "t",
          members: [{ name: "lead-x", role: "team-lead", tui: "claude" }],
        }),
      );
      const priorSession = process.env.ATMUX_SESSION;
      process.env.ATMUX_SESSION = "atmux-t";
      try {
        const { tmux, calls } = stubTmux({
          windows: [{ index: 0, name: "lead-x", active: true }],
        });
        const exit = await rotateLead(["--team-dir", dir], {
          buildTmux: () => tmux,
          briefsDir: briefs,
          sleep: async () => {},
          stdout: () => {},
        });
        expect(exit).toBe(0);
        expect(calls.sendKeys[0]?.target).toBe("atmux-t:lead-x");
      } finally {
        if (priorSession !== undefined) process.env.ATMUX_SESSION = priorSession;
        else delete process.env.ATMUX_SESSION;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(briefs, { recursive: true, force: true });
    }
  });
});
