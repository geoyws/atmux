// Unit tests for src/core/tui-cmd.ts — ADR-063 TUI launch resolver.

import { describe, expect, test } from "bun:test";
import { envPrefix, posixQuote, resolveTuiCommand } from "../../../src/core/tui-cmd.ts";
import { UsageError } from "../../../src/errors.ts";
import type { TeamMember, Team as TeamShape } from "../../../src/schema/team.ts";

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

  // ---------- ADR-094 / t-d0c8b758 (T6) coverage matrix ----------
  //
  // The T6 §Unit tests bullets map onto tests below:
  //   • baseline-all-defaults                 → "priority 3: built-in claude with default env knobs"
  //   • ATMUX_CLAUDE_GUARD_AGENT=0 disabled    → "ADR-094: ATMUX_CLAUDE_GUARD_AGENT=0 disables..."
  //   • ATMUX_CLAUDE_PLUGIN_DIR='' skip flag   → "ADR-094: ATMUX_CLAUDE_PLUGIN_DIR='' SKIPS..."
  //   • ATMUX_CLAUDE_PERMISSION=dontAsk        → "priority 3: built-in claude honors ATMUX_CLAUDE..."
  //   • claudeAccount=personal regression      → "priority 3: built-in claude with claudeAccount..."
  //
  // Init wizard tests (T5) — DEFERRED. The wizard path remains a
  // ConfigError-on-invoke stub (see init.test.ts "init — --wizard not yet
  // implemented (deferred)"). Once T5 ships the wizard prompt, the
  // claudeAccount-prompt tests fold in there, not here.
  //
  // E2E `spawn-fresh-tui-auth.test.ts` — DEFERRED per t-d0c8b758 reviewer
  // pre-flag: real-spawn coverage is heavy + bun-test cage-safety guard
  // (memory: `feedback_pause_bun_tests.md`) makes it hard to land in the
  // cage. The four unit-test bullets above provide structural coverage;
  // e2e refile follows once the bun-test cage guard's escape-hatch lands.

  test("priority 3: built-in claude with default env knobs (ADR-094 defaults)", () => {
    // ADR-094 §A/B/C bakes GUARD_AGENT=1, --plugin-dir=$HOME/.claude/
    // plugins, --permission-mode auto into the default spawn. HOME is
    // required for plugin-dir resolution; absent HOME suppresses the flag.
    const m = mkMember({ name: "x", tui: "claude", cwd: "/p", model: "default" });
    expect(resolveTuiCommand(m, baseTeam, { env: { HOME: "/root" } })).toBe(
      "export ATMUX_MEMBER=x && cd /p && env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CONFIG_DIR CLAUDECODE=1 CLAUDE_CODE_EFFORT_LEVEL=xhigh CLAUDE_GUARD_AGENT=1 claude --plugin-dir=/root/.claude/plugins --permission-mode auto",
    );
  });

  test("priority 3: built-in claude honors ATMUX_CLAUDE_BIN/EFFORT/PERMISSION", () => {
    const m = mkMember({ name: "x", tui: "claude", cwd: "/p" });
    const env = {
      HOME: "/root",
      ATMUX_CLAUDE_BIN: "claude-canary",
      ATMUX_CLAUDE_EFFORT: "high",
      ATMUX_CLAUDE_PERMISSION: "dontAsk",
    };
    expect(resolveTuiCommand(m, baseTeam, { env })).toBe(
      "export ATMUX_MEMBER=x && cd /p && env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CONFIG_DIR CLAUDECODE=1 CLAUDE_CODE_EFFORT_LEVEL=high CLAUDE_GUARD_AGENT=1 claude-canary --plugin-dir=/root/.claude/plugins --permission-mode dontAsk",
    );
  });

  test("priority 3: built-in claude appends --model when explicit", () => {
    const m = mkMember({ name: "x", tui: "claude", cwd: "/p", model: "claude-opus-4-7" });
    expect(resolveTuiCommand(m, baseTeam, { env: { HOME: "/root" } })).toBe(
      "export ATMUX_MEMBER=x && cd /p && env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CONFIG_DIR CLAUDECODE=1 CLAUDE_CODE_EFFORT_LEVEL=xhigh CLAUDE_GUARD_AGENT=1 claude --plugin-dir=/root/.claude/plugins --permission-mode auto --model claude-opus-4-7",
    );
  });

  test("priority 3: built-in claude with claudeAccount adds CLAUDE_CONFIG_DIR AFTER env -u strip", () => {
    const m = {
      name: "x",
      tui: "claude",
      cwd: "/p",
      model: "default",
      claudeAccount: "ifca",
    } as unknown as TeamMember;
    // The env -u CLAUDE_CONFIG_DIR strip comes FIRST; the per-process
    // CLAUDE_CONFIG_DIR=... assignment comes AFTER and wins per POSIX
    // semantics (`env -u FOO BAR=baz cmd` first strips, then assigns).
    expect(resolveTuiCommand(m, baseTeam, { env: { HOME: "/root" } })).toBe(
      "export ATMUX_MEMBER=x && cd /p && env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CONFIG_DIR CLAUDE_CONFIG_DIR=/root/.claude-ifca CLAUDECODE=1 CLAUDE_CODE_EFFORT_LEVEL=xhigh CLAUDE_GUARD_AGENT=1 claude --plugin-dir=/root/.claude/plugins --permission-mode auto",
    );
  });

  test("priority 3: claudeAccount=default suppresses CLAUDE_CONFIG_DIR assignment (env -u strip still fires)", () => {
    const m = {
      name: "x",
      tui: "claude",
      cwd: "/p",
      model: "default",
      claudeAccount: "default",
    } as unknown as TeamMember;
    // No CLAUDE_CONFIG_DIR=... assignment, but the env -u strip still
    // protects against a stale operator-shell CLAUDE_CONFIG_DIR leaking.
    expect(resolveTuiCommand(m, baseTeam, { env: { HOME: "/root" } })).toBe(
      "export ATMUX_MEMBER=x && cd /p && env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CONFIG_DIR CLAUDECODE=1 CLAUDE_CODE_EFFORT_LEVEL=xhigh CLAUDE_GUARD_AGENT=1 claude --plugin-dir=/root/.claude/plugins --permission-mode auto",
    );
  });

  // ADR-094 §A: GUARD_AGENT knob.
  test("ADR-094: ATMUX_CLAUDE_GUARD_AGENT=0 disables the guard env", () => {
    const m = mkMember({ name: "x", tui: "claude", cwd: "/p", model: "default" });
    const got = resolveTuiCommand(m, baseTeam, {
      env: { HOME: "/root", ATMUX_CLAUDE_GUARD_AGENT: "0" },
    });
    expect(got).toContain("CLAUDE_GUARD_AGENT=0");
    expect(got).not.toContain("CLAUDE_GUARD_AGENT=1");
  });

  // ADR-094 §B: --plugin-dir knob.
  test("ADR-094: ATMUX_CLAUDE_PLUGIN_DIR override threads through", () => {
    const m = mkMember({ name: "x", tui: "claude", cwd: "/p", model: "default" });
    const got = resolveTuiCommand(m, baseTeam, {
      env: { HOME: "/root", ATMUX_CLAUDE_PLUGIN_DIR: "/srv/custom-plugins" },
    });
    expect(got).toContain("--plugin-dir=/srv/custom-plugins");
    expect(got).not.toContain("/root/.claude/plugins");
  });

  test("ADR-094: ATMUX_CLAUDE_PLUGIN_DIR='' SKIPS the --plugin-dir flag", () => {
    const m = mkMember({ name: "x", tui: "claude", cwd: "/p", model: "default" });
    const got = resolveTuiCommand(m, baseTeam, {
      env: { HOME: "/root", ATMUX_CLAUDE_PLUGIN_DIR: "" },
    });
    expect(got).not.toContain("--plugin-dir");
  });

  test("ADR-094: plugin-dir with spaces gets POSIX-quoted", () => {
    const m = mkMember({ name: "x", tui: "claude", cwd: "/p", model: "default" });
    const got = resolveTuiCommand(m, baseTeam, {
      env: { HOME: "/root", ATMUX_CLAUDE_PLUGIN_DIR: "/path with spaces/plugins" },
    });
    // posixQuote single-quotes when the value contains whitespace
    expect(got).toContain("--plugin-dir='/path with spaces/plugins'");
  });

  test("ADR-094: HOME unset → plugin-dir defaults to empty (flag skipped)", () => {
    // Defensive — operators with empty HOME (containers, init scripts)
    // shouldn't get a malformed `--plugin-dir=/.claude/plugins`.
    const m = mkMember({ name: "x", tui: "claude", cwd: "/p", model: "default" });
    const got = resolveTuiCommand(m, baseTeam, { env: {} });
    expect(got).not.toContain("--plugin-dir");
  });

  test("priority 3: bug t-4d2936ac — env -u scrub prefix lands BEFORE per-process assignments", () => {
    // Regression test for the 2026-05-14 OAuth-account "Do you want to
    // use this API key?" dialog: operator-shell ANTHROPIC_API_KEY leaked
    // through tuiClaude unchanged. The env -u prefix MUST cover all
    // three target vars in the documented order.
    const m = mkMember({ name: "x", tui: "claude", cwd: "/p" });
    const out = resolveTuiCommand(m, baseTeam, { env: {} });
    expect(out).toContain("env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CONFIG_DIR");
    // env -u prefix sits between the ATMUX_MEMBER/cd preamble and the
    // CLAUDECODE=1 marker (i.e. immediately before any per-process
    // assignments).
    const envIdx = out.indexOf("env -u");
    const claudecodeIdx = out.indexOf("CLAUDECODE=1");
    expect(envIdx).toBeGreaterThan(-1);
    expect(claudecodeIdx).toBeGreaterThan(envIdx);
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

  test("cursor built-in defaults to composer-2 with --force and --approve-mcps", () => {
    const m = mkMember({ name: "x", tui: "cursor", cwd: "/p", model: "default" });
    expect(resolveTuiCommand(m, baseTeam, { env: {} })).toBe(
      "export ATMUX_MEMBER=x && cd /p && cursor-agent --force --approve-mcps --model composer-2",
    );
  });

  test("cursor built-in honors force/mcp disable env overrides", () => {
    const m = mkMember({ name: "x", tui: "cursor", cwd: "/p", model: "default" });
    expect(
      resolveTuiCommand(m, baseTeam, {
        env: { ATMUX_CURSOR_FORCE: "0", ATMUX_CURSOR_APPROVE_MCPS: "0" },
      }),
    ).toBe("export ATMUX_MEMBER=x && cd /p && cursor-agent --model composer-2");
  });

  test("cursor built-in honors ATMUX_CURSOR_ARGS_EXTRA", () => {
    const m = mkMember({ name: "x", tui: "cursor", cwd: "/p", model: "default" });
    expect(
      resolveTuiCommand(m, baseTeam, { env: { ATMUX_CURSOR_ARGS_EXTRA: "--sandbox disabled" } }),
    ).toBe(
      "export ATMUX_MEMBER=x && cd /p && cursor-agent --force --approve-mcps --model composer-2 --sandbox disabled",
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
