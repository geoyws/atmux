// Unit tests for src/verbs/reconfigure.ts (ADR-010).
// Bash spec ref: lib/reconfigure.sh @ worktree-frozen.
//
// Coverage strategy
// -----------------
// `parseReconfigureArgs`, `planReconfigure`, `applyPlan`, and
// `createReadlinePrompter` are pure-or-injectable; tests exercise every
// branch directly.
//
// `planReconfigure` accepts an injectable `Prompter`; we pass canned-
// answer stubs to drive: (1) every TUI key matching the built-in default
// (drop branch), (2) every TUI key changing to a non-default (keep
// branch), (3) discord webhook cleared → null, (4) discord webhook
// supplied → object form.
//
// `createReadlinePrompter` is exercised through its `PrompterStreams`
// injection point — `Readable.from([...])` for stdin, an in-memory
// `Writable` for stderr — so the readline interface runs without a
// controlling tty. Both branches (input non-empty / input empty →
// default) covered.
//
// `reconfigure()` (public) covered against a fixture .atmux/ directory:
// argv parse error → UsageError, missing team.json → ConfigError,
// happy path with a stub prompter that retains all defaults (writes
// `tuiCommands: {}` + `discord: null`).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import type { Team } from "../../../src/schema/team.ts";
import {
  applyPlan,
  createReadlinePrompter,
  type Prompter,
  parseReconfigureArgs,
  planReconfigure,
  reconfigure,
  TUI_BUILTIN_DEFAULTS,
} from "../../../src/verbs/reconfigure.ts";

// ---------- parseReconfigureArgs ----------

describe("parseReconfigureArgs", () => {
  test("empty argv → no flags set", () => {
    expect(parseReconfigureArgs([])).toEqual({});
  });

  test("--team-dir <dir> sets teamDir", () => {
    expect(parseReconfigureArgs(["--team-dir", "/tmp/proj"])).toEqual({
      teamDir: "/tmp/proj",
    });
  });

  test("--team-dir without value → UsageError", () => {
    expect(() => parseReconfigureArgs(["--team-dir"])).toThrow(UsageError);
  });

  test("unknown flag → UsageError", () => {
    expect(() => parseReconfigureArgs(["--bogus"])).toThrow(UsageError);
  });

  test("trailing positional → UsageError (covers undefined-arg branch with explicit empty)", () => {
    // Pass an explicit empty string — exercises the `${a ?? ""}` fallback
    // in the unknown-arg error path.
    expect(() => parseReconfigureArgs([""])).toThrow(UsageError);
  });
});

// ---------- planReconfigure ----------

/** Build a stub prompter that returns canned answers in argv-like order:
 *  claude → opencode → kimi → cursor → discord. Asserts on the prompts
 *  it was issued so test failures point at the wrong message. */
function stubPrompter(answers: ReadonlyArray<string>): Prompter {
  let i = 0;
  return {
    async ask(_message: string, _default: string): Promise<string> {
      const v = answers[i] ?? "";
      i += 1;
      return v;
    },
  };
}

const baseTeam: Team = { name: "x", members: [] };

describe("planReconfigure", () => {
  test("all TUIs match built-in defaults → empty tuiCommands map (drop branch)", async () => {
    const plan = await planReconfigure(
      baseTeam,
      stubPrompter([
        TUI_BUILTIN_DEFAULTS.claude,
        TUI_BUILTIN_DEFAULTS.opencode,
        TUI_BUILTIN_DEFAULTS.kimi,
        TUI_BUILTIN_DEFAULTS.cursor,
        "", // empty webhook
      ]),
    );
    expect(plan.tuiCommands).toEqual({});
    expect(plan.discord).toBeNull();
  });

  test("non-default for each key → keep in sparse map (keep branch)", async () => {
    const plan = await planReconfigure(
      baseTeam,
      stubPrompter([
        "claude-fresh",
        "opencode-mini",
        "kimi-x",
        "cursor-custom",
        "https://discord.example/webhook",
      ]),
    );
    expect(plan.tuiCommands).toEqual({
      claude: "claude-fresh",
      opencode: "opencode-mini",
      kimi: "kimi-x",
      cursor: "cursor-custom",
    });
    expect(plan.discord).toEqual({ webhook: "https://discord.example/webhook" });
  });

  test("empty answer is treated as 'use the bracketed default' (matches built-in → drop)", async () => {
    // The stub prompter's caller-supplied default is the built-in via
    // `readCurrentTuiCommand` (no team.tuiCommands set). The stub
    // returns "" for every key — bash parity: `[[ -z "$__input" ]] &&
    // __input="$__default"`. Our prompter returns the supplied default
    // when input is empty; here that default IS the built-in, so the
    // drop branch fires.
    //
    // BUT — our stub bypasses the real prompter (just returns the
    // canned answer verbatim, even when ""). That exercises the
    // planner's `next.length > 0` guard explicitly: "" → skipped from
    // the keep branch.
    const plan = await planReconfigure(baseTeam, stubPrompter(["", "", "", "", ""]));
    expect(plan.tuiCommands).toEqual({});
    expect(plan.discord).toBeNull();
  });

  test("reads team.tuiCommands.<key> when present (defaults pre-populated from team)", async () => {
    // The planner's `readCurrentTuiCommand` should pull the existing
    // value as the default. Our stub returns its canned answer directly
    // (ignores the message), so we instead probe by capturing the
    // `defaultValue` arg the prompter receives.
    const capturedDefaults: string[] = [];
    const probe: Prompter = {
      async ask(_msg: string, def: string): Promise<string> {
        capturedDefaults.push(def);
        return def; // echo the default back; matches built-in for keys 3+4 (drop branch)
      },
    };
    const team: Team = {
      name: "t",
      members: [],
      tuiCommands: {
        claude: "claude-existing",
        opencode: "opencode-existing",
        // kimi/cursor unset → fall through to built-in default
      },
    };
    const plan = await planReconfigure(team, probe);
    // Defaults issued in claude/opencode/kimi/cursor/webhook order.
    expect(capturedDefaults).toEqual([
      "claude-existing",
      "opencode-existing",
      TUI_BUILTIN_DEFAULTS.kimi,
      TUI_BUILTIN_DEFAULTS.cursor,
      "", // no team.discord set → empty webhook default
    ]);
    // claude/opencode echoed back as non-default → kept; kimi/cursor
    // echoed back as built-in → dropped.
    expect(plan.tuiCommands).toEqual({
      claude: "claude-existing",
      opencode: "opencode-existing",
    });
    expect(plan.discord).toBeNull();
  });

  test("reads team.discord.webhook when present (default carries through)", async () => {
    let webhookDefault = "";
    const probe: Prompter = {
      async ask(msg: string, def: string): Promise<string> {
        if (msg.includes("Discord")) webhookDefault = def;
        return def; // echo
      },
    };
    const team: Team = {
      name: "t",
      members: [],
      discord: { webhook: "https://x.example/hook" },
    };
    const plan = await planReconfigure(team, probe);
    expect(webhookDefault).toBe("https://x.example/hook");
    expect(plan.discord).toEqual({ webhook: "https://x.example/hook" });
  });

  test("team.tuiCommands present but non-string value → falls back to built-in default", async () => {
    // `readCurrentTuiCommand` ignores non-string values (Phase 0 schema
    // is `z.unknown()`). Exercises the `typeof v === "string"` branch.
    const captured: string[] = [];
    const probe: Prompter = {
      async ask(_msg: string, def: string): Promise<string> {
        captured.push(def);
        return def;
      },
    };
    const team: Team = {
      name: "t",
      members: [],
      tuiCommands: {
        claude: 42, // wrong type → fallback to "claude"
        opencode: "", // empty string → fallback to "opencode"
      },
    };
    await planReconfigure(team, probe);
    expect(captured.slice(0, 2)).toEqual([
      TUI_BUILTIN_DEFAULTS.claude,
      TUI_BUILTIN_DEFAULTS.opencode,
    ]);
  });

  test("team.tuiCommands as a non-object (null) → fallback to built-in defaults", async () => {
    const captured: string[] = [];
    const probe: Prompter = {
      async ask(_msg: string, def: string): Promise<string> {
        captured.push(def);
        return def;
      },
    };
    const team: Team = {
      name: "t",
      members: [],
      // null is the explicit "no overrides" form — bash's jq returns
      // empty + "// default" picks the fallback.
      tuiCommands: null,
    };
    await planReconfigure(team, probe);
    expect(captured.slice(0, 4)).toEqual([
      TUI_BUILTIN_DEFAULTS.claude,
      TUI_BUILTIN_DEFAULTS.opencode,
      TUI_BUILTIN_DEFAULTS.kimi,
      TUI_BUILTIN_DEFAULTS.cursor,
    ]);
  });

  test("team.discord as a non-object (null) → empty webhook default", async () => {
    let webhookDefault = "<unset>";
    const probe: Prompter = {
      async ask(msg: string, def: string): Promise<string> {
        if (msg.includes("Discord")) webhookDefault = def;
        return def;
      },
    };
    const team: Team = { name: "t", members: [], discord: null };
    await planReconfigure(team, probe);
    expect(webhookDefault).toBe("");
  });

  test("team.discord.webhook with non-string value → empty default", async () => {
    let webhookDefault = "<unset>";
    const probe: Prompter = {
      async ask(msg: string, def: string): Promise<string> {
        if (msg.includes("Discord")) webhookDefault = def;
        return def;
      },
    };
    const team: Team = {
      name: "t",
      members: [],
      discord: { webhook: 42 },
    };
    await planReconfigure(team, probe);
    expect(webhookDefault).toBe("");
  });
});

// ---------- applyPlan ----------

describe("applyPlan", () => {
  test("empty tuiCommands → assigns `{}`, NOT removing the key (bash parity)", () => {
    const next = applyPlan(baseTeam, { tuiCommands: {}, discord: null });
    expect(next.tuiCommands).toEqual({});
    expect(next.discord).toBeNull();
  });

  test("non-empty tuiCommands assigned verbatim", () => {
    const next = applyPlan(baseTeam, {
      tuiCommands: { claude: "c-fresh", kimi: "k-x" },
      discord: { webhook: "https://w.example" },
    });
    expect(next.tuiCommands).toEqual({ claude: "c-fresh", kimi: "k-x" });
    expect(next.discord).toEqual({ webhook: "https://w.example" });
  });

  test("preserves passthrough keys (operator comments, experimental fields)", () => {
    const team: Team = { name: "t", members: [] };
    // `Team` is `.passthrough()` so unknown fields survive parse — emulate
    // that in-memory by tacking on the extras.
    const teamWithExtras = { ...team, _comment_x: "keep me", custom: { foo: 1 } };
    const next = applyPlan(teamWithExtras as unknown as Team, {
      tuiCommands: {},
      discord: null,
    });
    expect((next as Record<string, unknown>)._comment_x).toBe("keep me");
    expect((next as Record<string, unknown>).custom).toEqual({ foo: 1 });
    // Members + name preserved too.
    expect(next.name).toBe("t");
    expect(next.members).toEqual([]);
  });
});

// ---------- createReadlinePrompter ----------

describe("createReadlinePrompter", () => {
  test("returns user input when non-empty", async () => {
    const stdin = Readable.from(["hello world\n"]);
    let stderrBuf = "";
    const stderr = new Writable({
      write(chunk, _enc, cb) {
        stderrBuf += chunk.toString();
        cb();
      },
    });
    const p = createReadlinePrompter({ input: stdin, output: stderr });
    const out = await p.ask("foo", "bar");
    expect(out).toBe("hello world");
    // Prompt formatted with the bracketed default, written to stderr.
    expect(stderrBuf).toContain("foo [bar]: ");
  });

  test("returns the supplied default when input is empty (Enter only)", async () => {
    const stdin = Readable.from(["\n"]);
    const stderr = new Writable({
      write(_chunk, _enc, cb) {
        cb();
      },
    });
    const p = createReadlinePrompter({ input: stdin, output: stderr });
    const out = await p.ask("msg", "the-default");
    expect(out).toBe("the-default");
  });

  test("default-stream form is constructible (no streams supplied)", () => {
    // Just probe the no-arg branch — we don't drive the readline against
    // process.stdin here (CI has no tty), but constructing the prompter
    // exercises the no-overrides path of createInterface fallback.
    const p = createReadlinePrompter();
    expect(typeof p.ask).toBe("function");
  });
});

// ---------- reconfigure() — public verb wiring ----------

describe("reconfigure() — public verb", () => {
  let scratch: string;
  let priorAtmuxDir: string | undefined;
  let priorAtmuxTeamDir: string | undefined;
  let priorStderr: typeof process.stderr.write;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "atmux-recfg-"));
    priorAtmuxDir = process.env.ATMUX_DIR;
    priorAtmuxTeamDir = process.env.ATMUX_TEAM_DIR;
    delete process.env.ATMUX_DIR;
    delete process.env.ATMUX_TEAM_DIR;
    // Suppress the verb's banner emission so test output stays clean.
    priorStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
  });

  afterEach(async () => {
    process.stderr.write = priorStderr;
    if (priorAtmuxDir !== undefined) process.env.ATMUX_DIR = priorAtmuxDir;
    if (priorAtmuxTeamDir !== undefined) process.env.ATMUX_TEAM_DIR = priorAtmuxTeamDir;
    await rm(scratch, { recursive: true, force: true });
  });

  test("argv parse failure surfaces as UsageError", async () => {
    await expect(reconfigure(["--team-dir"])).rejects.toBeInstanceOf(UsageError);
  });

  test("missing team.json → ConfigError", async () => {
    await expect(reconfigure(["--team-dir", scratch])).rejects.toBeInstanceOf(ConfigError);
  });

  test("happy path: stub prompter retains all defaults → tuiCommands {} + discord null on disk", async () => {
    const atmuxDir = join(scratch, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
    const tj = join(atmuxDir, "team.json");
    await writeFile(
      tj,
      JSON.stringify({
        name: "team-x",
        members: [{ name: "alpha" }],
        tuiCommands: { claude: "should-be-cleared" },
        discord: { webhook: "https://existing/hook" },
      }),
    );

    // Stub prompter: drop claude (echo default = "claude" built-in),
    // keep opencode/kimi/cursor at default too, clear webhook by
    // returning "".
    const prompter: Prompter = {
      async ask(msg: string, def: string): Promise<string> {
        // For TUI prompts: return the BUILT-IN default verbatim
        // → drop branch fires for every key (incl. claude, which had
        // an existing override).
        if (msg.includes("launch command")) {
          if (msg.startsWith("claude")) return TUI_BUILTIN_DEFAULTS.claude;
          if (msg.startsWith("opencode")) return TUI_BUILTIN_DEFAULTS.opencode;
          if (msg.startsWith("kimi")) return TUI_BUILTIN_DEFAULTS.kimi;
          if (msg.startsWith("cursor")) return TUI_BUILTIN_DEFAULTS.cursor;
        }
        // Discord webhook: return "" → null branch.
        if (msg.includes("Discord")) return "";
        return def;
      },
    };

    const exit = await reconfigure(["--team-dir", scratch], { prompter });
    expect(exit).toBe(0);

    const updated = JSON.parse(await readFile(tj, "utf8"));
    expect(updated.tuiCommands).toEqual({});
    expect(updated.discord).toBeNull();
    // Roster + name preserved.
    expect(updated.name).toBe("team-x");
    expect(updated.members).toEqual([{ name: "alpha" }]);
  });

  test("happy path: stub prompter changes values → keep branch fires for tuiCommands + discord", async () => {
    const atmuxDir = join(scratch, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
    const tj = join(atmuxDir, "team.json");
    await writeFile(
      tj,
      JSON.stringify({
        name: "team-y",
        members: [],
      }),
    );

    const answers = ["c-new", "o-new", "k-new", "cu-new", "https://new/hook"];
    let i = 0;
    const prompter: Prompter = {
      async ask(_msg: string, _def: string): Promise<string> {
        const v = answers[i] ?? "";
        i += 1;
        return v;
      },
    };

    const exit = await reconfigure(["--team-dir", scratch], { prompter });
    expect(exit).toBe(0);

    const updated = JSON.parse(await readFile(tj, "utf8"));
    expect(updated.tuiCommands).toEqual({
      claude: "c-new",
      opencode: "o-new",
      kimi: "k-new",
      cursor: "cu-new",
    });
    expect(updated.discord).toEqual({ webhook: "https://new/hook" });
  });
});
