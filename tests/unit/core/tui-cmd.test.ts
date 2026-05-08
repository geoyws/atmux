// Unit tests for src/core/tui-cmd.ts — ADR-063 TUI launch resolver.

import { describe, expect, test } from "bun:test";
import type { Team as TeamShape, TeamMember } from "../../../src/schema/team.ts";
import { envPrefix, posixQuote, resolveTuiCommand } from "../../../src/core/tui-cmd.ts";
import { UsageError } from "../../../src/errors.ts";

const baseTeam: TeamShape = {
  name: "t",
  members: [],
  // schema uses .passthrough(); empty object satisfies Team typing
} as unknown as TeamShape;

function mkMember(over: Partial<TeamMember> & { name: string }): TeamMember {
  return {
    name: over.name,
    role: over.role,
    tui: over.tui,
    model: over.model,
    cwd: over.cwd,
    emoji: over.emoji,
    command: over.command,
  } as TeamMember;
}

describe("posixQuote", () => {
  test("plain identifier passes through unchanged", () => {
    expect(posixQuote("hello")).toBe("hello");
    expect(posixQuote("/abs/path/to/x.ts")).toBe("/abs/path/to/x.ts");
    expect(posixQuote("v1.2.3")).toBe("v1.2.3");
  });
  test("strings with spaces or special chars get wrapped", () => {
    expect(posixQuote("hello world")).toBe("'hello world'");
    expect(posixQuote("a&b")).toBe("'a&b'");
  });
  test("embedded single quote uses '\\''  escape", () => {
    expect(posixQuote("it's")).toBe("'it'\\''s'");
  });
  test("empty string becomes ''", () => {
    expect(posixQuote("")).toBe("''");
  });
});

describe("envPrefix", () => {
  test("emits ATMUX_MEMBER export with shell-quoted name", () => {
    expect(envPrefix("lead")).toBe("export ATMUX_MEMBER=lead &&");
    expect(envPrefix("fe-chat")).toBe("export ATMUX_MEMBER=fe-chat &&");
    expect(envPrefix("name with space")).toBe("export ATMUX_MEMBER='name with space' &&");
  });
});

describe("resolveTuiCommand priority chain", () => {
  test("priority 1: member.command override is used verbatim", () => {
    const m = mkMember({ name: "x", cwd: "/proj", command: "vim README.md" });
    expect(resolveTuiCommand(m, baseTeam, { env: {} })).toBe(
      "export ATMUX_MEMBER=x && cd /proj && vim README.md",
    );
  });

  test("priority 2: team.tuiCommands[<tui>] prefix wins over built-in", () => {
    const team = {
      ...baseTeam,
      tuiCommands: { claude: "MYENV=1 claude --plugin-dir=/p --permission-mode auto" },
    } as TeamShape;
    const m = mkMember({ name: "lead", tui: "claude", cwd: "/p", model: "default" });
    expect(resolveTuiCommand(m, team, { env: {} })).toBe(
      "export ATMUX_MEMBER=lead && cd /p && MYENV=1 claude --plugin-dir=/p --permission-mode auto",
    );
  });

  test("priority 2: explicit model is appended unless prefix has --model", () => {
    const team = {
      ...baseTeam,
      tuiCommands: { claude: "claude --permission-mode auto" },
    } as TeamShape;
    const m = mkMember({ name: "lead", tui: "claude", cwd: "/p", model: "claude-opus-4-7" });
    expect(resolveTuiCommand(m, team, { env: {} })).toBe(
      "export ATMUX_MEMBER=lead && cd /p && claude --permission-mode auto --model claude-opus-4-7",
    );
  });

  test("priority 2: prefix with --model already → no flag appended", () => {
    const team = {
      ...baseTeam,
      tuiCommands: { claude: "claude --model claude-haiku-4-5 --permission-mode auto" },
    } as TeamShape;
    const m = mkMember({ name: "x", cwd: "/p", model: "claude-opus-4-7" });
    expect(resolveTuiCommand(m, team, { env: {} })).toBe(
      "export ATMUX_MEMBER=x && cd /p && claude --model claude-haiku-4-5 --permission-mode auto",
    );
  });

  test("priority 3: built-in claude with default env knobs", () => {
    const m = mkMember({ name: "x", tui: "claude", cwd: "/p", model: "default" });
    expect(resolveTuiCommand(m, baseTeam, { env: {} })).toBe(
      "export ATMUX_MEMBER=x && cd /p && CLAUDECODE=1 CLAUDE_CODE_EFFORT_LEVEL=xhigh claude --permission-mode dontAsk",
    );
  });

  test("priority 3: built-in claude honors ATMUX_CLAUDE_BIN/EFFORT/PERMISSION", () => {
    const m = mkMember({ name: "x", tui: "claude", cwd: "/p" });
    const env = {
      ATMUX_CLAUDE_BIN: "claude-canary",
      ATMUX_CLAUDE_EFFORT: "high",
      ATMUX_CLAUDE_PERMISSION: "auto",
    };
    expect(resolveTuiCommand(m, baseTeam, { env })).toBe(
      "export ATMUX_MEMBER=x && cd /p && CLAUDECODE=1 CLAUDE_CODE_EFFORT_LEVEL=high claude-canary --permission-mode auto",
    );
  });

  test("priority 3: built-in claude appends --model when explicit", () => {
    const m = mkMember({ name: "x", tui: "claude", cwd: "/p", model: "claude-opus-4-7" });
    expect(resolveTuiCommand(m, baseTeam, { env: {} })).toBe(
      "export ATMUX_MEMBER=x && cd /p && CLAUDECODE=1 CLAUDE_CODE_EFFORT_LEVEL=xhigh claude --permission-mode dontAsk --model claude-opus-4-7",
    );
  });

  test("priority 3: built-in claude with claudeAccount adds CLAUDE_CONFIG_DIR", () => {
    const m = {
      name: "x",
      tui: "claude",
      cwd: "/p",
      model: "default",
      claudeAccount: "ifca",
    } as unknown as TeamMember;
    expect(resolveTuiCommand(m, baseTeam, { env: { HOME: "/root" } })).toBe(
      "export ATMUX_MEMBER=x && cd /p && CLAUDE_CONFIG_DIR=/root/.claude-ifca CLAUDECODE=1 CLAUDE_CODE_EFFORT_LEVEL=xhigh claude --permission-mode dontAsk",
    );
  });

  test("priority 3: claudeAccount=default suppresses CLAUDE_CONFIG_DIR", () => {
    const m = {
      name: "x",
      tui: "claude",
      cwd: "/p",
      model: "default",
      claudeAccount: "default",
    } as unknown as TeamMember;
    expect(resolveTuiCommand(m, baseTeam, { env: { HOME: "/root" } })).toBe(
      "export ATMUX_MEMBER=x && cd /p && CLAUDECODE=1 CLAUDE_CODE_EFFORT_LEVEL=xhigh claude --permission-mode dontAsk",
    );
  });

  test("default tui is claude when member.tui is unset", () => {
    const m = mkMember({ name: "x", cwd: "/p" });
    const out = resolveTuiCommand(m, baseTeam, { env: {} });
    expect(out).toContain("CLAUDECODE=1");
  });

  test("opencode built-in honors default-model env override", () => {
    const m = mkMember({ name: "x", tui: "opencode", cwd: "/p", model: "default" });
    expect(
      resolveTuiCommand(m, baseTeam, { env: { ATMUX_OPENCODE_DEFAULT_MODEL: "minimax-m2" } }),
    ).toBe("export ATMUX_MEMBER=x && cd /p && opencode --model minimax-m2");
  });

  test("kimi built-in with explicit model", () => {
    const m = mkMember({ name: "x", tui: "kimi", cwd: "/p", model: "kimi-k1" });
    expect(resolveTuiCommand(m, baseTeam, { env: {} })).toBe(
      "export ATMUX_MEMBER=x && cd /p && kimi --model kimi-k1",
    );
  });

  test("cursor built-in defaults to composer-2", () => {
    const m = mkMember({ name: "x", tui: "cursor", cwd: "/p", model: "default" });
    expect(resolveTuiCommand(m, baseTeam, { env: {} })).toBe(
      "export ATMUX_MEMBER=x && cd /p && cursor-agent --model composer-2",
    );
  });

  test("shell tui execs $SHELL", () => {
    const m = mkMember({ name: "x", tui: "shell", cwd: "/p" });
    expect(resolveTuiCommand(m, baseTeam, { env: {} })).toBe(
      "export ATMUX_MEMBER=x && cd /p && exec $SHELL",
    );
    const m2 = mkMember({ name: "x", tui: "bash", cwd: "/p" });
    expect(resolveTuiCommand(m2, baseTeam, { env: {} })).toBe(
      "export ATMUX_MEMBER=x && cd /p && exec $SHELL",
    );
  });

  test("unknown tui without team override throws UsageError", () => {
    const m = mkMember({ name: "x", tui: "exotic", cwd: "/p" });
    expect(() => resolveTuiCommand(m, baseTeam, { env: {} })).toThrow(UsageError);
  });

  test("unknown tui with team override is fine (priority 2)", () => {
    const team = { ...baseTeam, tuiCommands: { exotic: "exotic-bin --foo" } } as TeamShape;
    const m = mkMember({ name: "x", tui: "exotic", cwd: "/p" });
    expect(resolveTuiCommand(m, team, { env: {} })).toBe(
      "export ATMUX_MEMBER=x && cd /p && exotic-bin --foo",
    );
  });

  test("opts.cwd overrides member.cwd", () => {
    const m = mkMember({ name: "x", tui: "shell", cwd: "/from-member" });
    expect(resolveTuiCommand(m, baseTeam, { env: {}, cwd: "/from-opts" })).toBe(
      "export ATMUX_MEMBER=x && cd /from-opts && exec $SHELL",
    );
  });
});
