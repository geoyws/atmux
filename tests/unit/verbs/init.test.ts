// Unit tests for src/verbs/init.ts (Phase 2 lifecycle MVP — bash port).
//
// Strategy: spin per-test tmpdir as `cwd`, point `templatesDir` at the
// real worktree templates dir, exercise the verb's observable side-
// effects (`.atmux/` scaffold, team.json contents, kanban + driver-inbox
// + per-member inbox seeds), capture the injected logger + stdout sink.
//
// 100% narrowed coverage (ADR-009 §2): every branch of `parseInitArgs`,
// every branch of `init` body — happy path with --name, default-name
// (basename of cwd), --force overwrite, refuse-overwrite, --wizard
// refuse, idempotent re-seeding (kanban / driver-inbox / inbox files
// preserved on --force), missing-name-value, unknown arg, --force when
// no team.json yet, the --force backup best-effort swallow path
// (read-failure on the source).
//
// ADR-288 §D5 (2026-09-03): the shipped template is drivers-only
// (`members: []`, three `drivers[]`, the ADR-285 `bot` block). Tests
// against the real template assert THAT shape; the members-path
// branches of `init` (cwd rewrite, claudeAccount stamp / strip /
// passthrough, per-member inbox seeding + preservation) are exercised
// against `DECLARED_MEMBERS_TEMPLATE`, staged as a custom templates
// dir, so a team that still declares members keeps its contract.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SpawnResult } from "../../../src/abstractions/spawn.ts";
import type { TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import type { GitSpawn } from "../../../src/abstractions/worktree.ts";
import type { Logger } from "../../../src/core/tui.ts";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import { init, parseInitArgs } from "../../../src/verbs/init.ts";
import { start } from "../../../src/verbs/start.ts";
import { createCanonicalAtmuxTmux, setCanonicalAtmuxTmuxHome } from "../../helpers/tmux.ts";

// ---------- Fixture ----------

interface TestEnv {
  /** Per-test cwd that becomes the project root holding `.atmux/`. */
  cwd: string;
  /** Templates dir from the real worktree — the verb reads
   *  `team.example.json` from here. */
  templatesDir: string;
  /** Captured logger output (one entry per call). */
  logs: { kind: "log" | "ok" | "warn" | "err"; msg: string }[];
  logger: Logger;
  /** Captured stdout writes. */
  stdoutBuf: string[];
  /** stdout sink that appends to `stdoutBuf`. */
  stdout: (line: string) => void;
}

let env: TestEnv;
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const REAL_TEMPLATES_DIR = join(REPO_ROOT, "templates");

beforeEach(async () => {
  // Use a per-test `cwd` whose basename is stable so the
  // default-team-name path can assert against it deterministically.
  // mkdtemp's suffix is random, so we wrap a stable child dir.
  const root = await mkdtemp(join(tmpdir(), "atmux-init-"));
  const cwd = join(root, "project");
  await mkdir(cwd, { recursive: true });
  const logs: TestEnv["logs"] = [];
  const logger: Logger = {
    log: (msg) => logs.push({ kind: "log", msg }),
    ok: (msg) => logs.push({ kind: "ok", msg }),
    warn: (msg) => logs.push({ kind: "warn", msg }),
    err: (msg) => logs.push({ kind: "err", msg }),
  };
  const stdoutBuf: string[] = [];
  const stdout = (line: string): void => {
    stdoutBuf.push(line);
  };
  env = {
    cwd,
    templatesDir: REAL_TEMPLATES_DIR,
    logs,
    logger,
    stdoutBuf,
    stdout,
  };
});

afterEach(async () => {
  await rm(env.cwd, { recursive: true, force: true });
  // Strip the parent tmpdir (one level up from the stable `project` dir).
  const parent = resolve(env.cwd, "..");
  await rm(parent, { recursive: true, force: true });
  for (const root of stagedTemplateRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function runInit(
  argv: ReadonlyArray<string>,
  opts: Parameters<typeof init>[1] = {},
): Promise<number> {
  return await init(argv, {
    cwd: env.cwd,
    templatesDir: env.templatesDir,
    env: {},
    logger: env.logger,
    stdout: env.stdout,
    ...opts,
  });
}

/** Shape of the rendered team.json the assertions below read back. */
interface RenderedTeam {
  name: string;
  tmuxTmpdir?: string;
  _comment_members?: string;
  drivers?: { name: string; tui?: string | null; cwd: string; claudeAccount?: string }[];
  bot?: { enabled?: boolean; claudeAccount?: string | null };
  members: { name: string; role?: string; cwd?: string; claudeAccount?: string }[];
}

async function readRendered(): Promise<RenderedTeam> {
  return JSON.parse(await readFile(join(env.cwd, ".atmux", "team.json"), "utf8")) as RenderedTeam;
}

/** ADR-288 §D5: the shipped template declares no members, so the
 *  members-path branches of `init` are exercised against this
 *  explicitly-declared roster (a team that still runs the
 *  lead→planner→member loop). `driver-2` carries a demonstration
 *  `claudeAccount` so driver passthrough / strip is observable too. */
const DECLARED_MEMBERS_TEMPLATE = {
  name: "placeholder",
  drivers: [
    { name: "driver", tui: null, cwd: "." },
    { name: "driver-2", tui: null, cwd: ".atmux/worktrees/driver-2", claudeAccount: "icloud" },
  ],
  members: [
    { name: "lead", role: "team-lead", tui: "claude", cwd: ".", claudeAccount: "personal" },
    { name: "planner", role: "planner", tui: "claude", cwd: "." },
  ],
};

/** Temp roots created by {@link stageTemplate}; swept in afterEach. */
const stagedTemplateRoots: string[] = [];

/** Stage `shape` as `<tmp>/templates/team.example.json` and return the
 *  templates dir to inject via `opts.templatesDir`. */
async function stageTemplate(shape: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atmux-init-tmpls-"));
  stagedTemplateRoots.push(root);
  const dir = join(root, "templates");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "team.example.json"), `${JSON.stringify(shape, null, 2)}\n`);
  return dir;
}

// ---------- parseInitArgs (every branch) ----------

describe("parseInitArgs", () => {
  test("no args → defaults", () => {
    const r = parseInitArgs([]);
    expect(r.name).toBeUndefined();
    expect(r.force).toBe(false);
    expect(r.wizard).toBe(false);
  });

  test("--name <team>", () => {
    expect(parseInitArgs(["--name", "alpha"])).toEqual({
      name: "alpha",
      force: false,
      wizard: false,
      noSkills: false,
      skillsOnly: false,
    });
  });

  test("--force", () => {
    expect(parseInitArgs(["--force"]).force).toBe(true);
  });

  test("-f short flag", () => {
    expect(parseInitArgs(["-f"]).force).toBe(true);
  });

  test("--wizard", () => {
    expect(parseInitArgs(["--wizard"]).wizard).toBe(true);
  });

  test("-w short flag", () => {
    expect(parseInitArgs(["-w"]).wizard).toBe(true);
  });

  test("--name + --force combined", () => {
    expect(parseInitArgs(["--name", "x", "--force"])).toEqual({
      name: "x",
      force: true,
      wizard: false,
      noSkills: false,
      skillsOnly: false,
    });
  });

  test("--name without value → UsageError", () => {
    expect(() => parseInitArgs(["--name"])).toThrow(UsageError);
  });

  // t-3866c5b1 / ADR-094: --claude-account flag
  test("--claude-account <suffix> captured", () => {
    const r = parseInitArgs(["--claude-account", "personal"]);
    expect(r.claudeAccount).toBe("personal");
  });

  test("--claude-account without value → UsageError", () => {
    expect(() => parseInitArgs(["--claude-account"])).toThrow(UsageError);
  });

  test("--claude-account with empty value → UsageError", () => {
    expect(() => parseInitArgs(["--claude-account", ""])).toThrow(UsageError);
  });

  test("--claude-account default literal is captured (verb-side filters)", () => {
    // The parser passes through "default" verbatim; the verb body
    // skips the stamp when the value is literally "default".
    expect(parseInitArgs(["--claude-account", "default"]).claudeAccount).toBe("default");
  });

  test("unknown arg → UsageError with bash-shape what", () => {
    try {
      parseInitArgs(["--bogus"]);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(UsageError);
      expect((e as UsageError).context).toMatchObject({
        what: "init: unknown arg: --bogus",
      });
    }
  });
});

// ---------- init verb — happy path (template) ----------

describe("init — template path (bash lib/init.sh:87-107 parity)", () => {
  test("external backend does not seed a duplicate kanban.json", async () => {
    const initialized: Array<{ atmuxDir: string; name?: string }> = [];
    await init(["--name", "external"], {
      cwd: env.cwd,
      templatesDir: env.templatesDir,
      env: { ATMUX_KANBAN_BACKEND: "external" },
      logger: env.logger,
      stdout: env.stdout,
      kanbanAdapter: {
        initialize: async (atmuxDir, name) => {
          initialized.push({ atmuxDir, ...(name === undefined ? {} : { name }) });
        },
      },
    });
    expect(initialized).toEqual([{ atmuxDir: join(env.cwd, ".atmux"), name: "external" }]);
    expect(await Bun.file(join(env.cwd, ".atmux", "kanban.json")).exists()).toBe(false);
    expect(await Bun.file(join(env.cwd, ".atmux", "driver-inbox.md")).exists()).toBe(true);
  });

  test("creates .atmux/ scaffold + team.json with --name + drivers-only roster + scaffold dirs", async () => {
    const exit = await runInit(["--name", "hello"]);
    expect(exit).toBe(0);

    const dir = join(env.cwd, ".atmux");
    expect((await stat(dir)).isDirectory()).toBe(true);
    expect((await stat(join(dir, "inboxes"))).isDirectory()).toBe(true);
    expect((await stat(join(dir, "logs"))).isDirectory()).toBe(true);
    expect((await stat(join(dir, "state"))).isDirectory()).toBe(true);
    expect((await stat(join(dir, "archive"))).isDirectory()).toBe(true);

    const tj = await readRendered();
    expect(tj.name).toBe("hello");
    // Bash lib/init.sh:104 — tmuxTmpdir set to the per-team cage path.
    expect(tj.tmuxTmpdir).toBe("/tmp/atmux-tmux_hello");
    // Template-shape sanity. Tracks `templates/team.example.json` —
    // bump together when the shipped roster changes. ADR-288
    // (2026-09-03): the default roster is drivers-only — three drivers
    // (ADR-239 floor restored), the ADR-285 bot seat, zero members.
    expect(tj.members).toEqual([]);
    expect(tj.drivers?.map((d) => d.name)).toEqual([
      "driver",
      "driver-2",
      "driver-3",
    ]);
    // Driver cwd is NOT rewritten to PWD (unlike members[].cwd): start.ts
    // anchors the relative path at the project root and keys worktree
    // provisioning off the conventional `.atmux/worktrees/driver-N`.
    expect(tj.drivers?.map((d) => d.cwd)).toEqual([
      ".",
      ".atmux/worktrees/driver-2",
      ".atmux/worktrees/driver-3",
    ]);
    expect(tj.bot?.enabled).toBe(true);
  });

  test("ADR-288: default scaffold is drivers-only — members.length === 0, drivers.length === 3, bot seat enabled, comment cites §D5", async () => {
    // Explicit pin for the ADR-288 template contract: a fresh
    // `atmux init` from the shipped template yields NO member windows
    // (lead / planner / reviewer / member are deprecated as defaults),
    // the three-driver floor ADR-239 restores, and the
    // ADR-285 `_bot` seat. `_comment_members` survives passthrough and
    // must point operators at §D5.
    expect(await runInit(["--name", "solo-drivers"])).toBe(0);
    const tj = await readRendered();
    expect(tj.members.length).toBe(0);
    expect(tj.drivers?.length).toBe(3);
    expect(tj.bot?.enabled).toBe(true);
    expect(tj._comment_members).toContain("ADR-288 §D5");
    expect(tj._comment_members).toContain("drivers-only");
    // No per-member inbox stub can exist for a roster with no members.
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(join(env.cwd, ".atmux", "inboxes"))).toEqual([]);
  });

  // t-3866c5b1 / ADR-094: --claude-account flag end-to-end.
  // ADR-288 §D5: the flag stamps drivers[] as well as members[] — on the
  // drivers-only default template that is the ONLY thing it can stamp.
  test("--claude-account personal stamps every driver on the drivers-only template; bot.claudeAccount stays null", async () => {
    await runInit(["--name", "alpha", "--claude-account", "personal"]);
    const tj = await readRendered();
    expect(tj.members).toEqual([]);
    expect(tj.drivers?.length).toBe(3);
    for (const d of tj.drivers ?? []) {
      expect(d.claudeAccount).toBe("personal");
    }
    // ADR-285: the bot seat's account is an explicit operator choice in
    // the durable team.json — the flag never stamps it. Pinned so a
    // future "team-wide" widening is a deliberate change, not drift.
    expect("claudeAccount" in (tj.bot ?? {})).toBe(true);
    expect(tj.bot?.claudeAccount).toBeNull();
  });

  test("--claude-account personal stamps every member AND every driver on a declared-members template", async () => {
    const templatesDir = await stageTemplate(DECLARED_MEMBERS_TEMPLATE);
    await runInit(["--name", "alpha", "--claude-account", "personal"], { templatesDir });
    const tj = await readRendered();
    // Every member entry carries the field — applied uniformly (no
    // per-member override at init time; that's the `atmux reconfigure`
    // path per ADR-094). Members also get cwd rewritten to PWD.
    expect(tj.members.map((m) => m.name)).toEqual(["lead", "planner"]);
    for (const m of tj.members) {
      expect(m.claudeAccount).toBe("personal");
      expect(m.cwd).toBe(env.cwd);
    }
    // Drivers: the template's `icloud` on driver-2 is overridden too —
    // the flag applies uniformly to every drivers[] and members[] entry
    // (bot.claudeAccount is the one seat it leaves alone; see the
    // drivers-only stamp test above).
    expect(tj.drivers?.map((d) => d.claudeAccount)).toEqual(["personal", "personal"]);
  });

  test("--claude-account default → NO claudeAccount field on disk (schema-default)", async () => {
    await runInit(["--name", "alpha", "--claude-account", "default"]);
    const tj = await readRendered();
    // Per ADR-094 §"Default handling": "default" means "no field on
    // disk; schema-default applies" — don't litter team.json with the
    // implicit default value. Drivers-only template: no driver carries it.
    expect(tj.drivers?.length).toBe(3);
    for (const d of tj.drivers ?? []) {
      expect("claudeAccount" in d).toBe(false);
    }
    // The strip branch is drivers[] + members[] only: the bot block
    // passes through verbatim, template `null` included (ADR-285).
    expect("claudeAccount" in (tj.bot ?? {})).toBe(true);
    expect(tj.bot?.claudeAccount).toBeNull();
  });

  test("--claude-account default STRIPS the declared-members template's lead + driver-2 demonstration values", async () => {
    const templatesDir = await stageTemplate(DECLARED_MEMBERS_TEMPLATE);
    await runInit(["--name", "alpha", "--claude-account", "default"], { templatesDir });
    const tj = await readRendered();
    expect(tj.members.map((m) => m.name)).toEqual(["lead", "planner"]);
    for (const m of tj.members) {
      expect("claudeAccount" in m).toBe(false);
      expect(m.cwd).toBe(env.cwd);
    }
    // Pin the roster first so the loop below cannot pass vacuously if
    // `init` ever dropped `drivers[]` on the strip path.
    expect(tj.drivers?.map((d) => d.name)).toEqual(["driver", "driver-2"]);
    for (const d of tj.drivers ?? []) {
      expect("claudeAccount" in d).toBe(false);
    }
  });

  test("no --claude-account → drivers-only template renders with NO claudeAccount anywhere", async () => {
    await runInit(["--name", "alpha"]);
    const tj = await readRendered();
    expect(tj.members).toEqual([]);
    // Pin the count first so the loop below cannot pass vacuously if
    // `init` ever dropped `drivers[]` on the passthrough path.
    expect(tj.drivers?.length).toBe(3);
    for (const d of tj.drivers ?? []) {
      expect("claudeAccount" in d).toBe(false);
    }
    expect(tj.bot?.claudeAccount).toBeNull();
  });

  test("no --claude-account → declared-members template's values pass through verbatim", async () => {
    const templatesDir = await stageTemplate(DECLARED_MEMBERS_TEMPLATE);
    await runInit(["--name", "alpha"], { templatesDir });
    const tj = await readRendered();
    // When --claude-account is unset, the template's demonstration
    // values pass through verbatim — operator gets the template's
    // example unless they override.
    const lead = tj.members.find((m) => m.name === "lead");
    expect(lead?.claudeAccount).toBe("personal");
    expect(lead?.cwd).toBe(env.cwd);
    const planner = tj.members.find((m) => m.name === "planner");
    expect(planner?.claudeAccount).toBeUndefined();
    expect(planner?.cwd).toBe(env.cwd);
    // Drivers pass through untouched: driver-2 keeps `icloud`, driver
    // stays without the key, and cwd is NOT rewritten.
    expect(tj.drivers).toEqual([
      { name: "driver", tui: null, cwd: "." },
      { name: "driver-2", tui: null, cwd: ".atmux/worktrees/driver-2", claudeAccount: "icloud" },
    ]);
  });

  test("seeds kanban.json + driver-inbox.md (byte-exact); drivers-only template seeds NO per-member inbox", async () => {
    await runInit(["--name", "h"]);
    const dir = join(env.cwd, ".atmux");
    // Bash lib/init.sh:50 emits the literal compact form via `echo`.
    expect(await readFile(join(dir, "kanban.json"), "utf8")).toBe(
      '{"tasks":[],"epics":[],"stories":[]}\n',
    );
    // Bash lib/init.sh:51 — `: > "$di"` produces a zero-byte file.
    expect(await readFile(join(dir, "driver-inbox.md"), "utf8")).toBe("");
    // Bash lib/init.sh:59 — every member.name gets a stub inbox. The
    // ADR-288 §D5 default roster has no members, so the loop runs over
    // an empty list: `inboxes/` exists (scaffold mkdir) and is empty.
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(join(dir, "inboxes"))).toEqual([]);
  });

  test("declared-members template seeds a byte-exact per-member inbox for every member", async () => {
    const templatesDir = await stageTemplate(DECLARED_MEMBERS_TEMPLATE);
    await runInit(["--name", "h"], { templatesDir });
    const dir = join(env.cwd, ".atmux");
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(join(dir, "inboxes"))).sort()).toEqual(["lead.json", "planner.json"]);
    for (const m of ["lead", "planner"]) {
      expect(await readFile(join(dir, "inboxes", `${m}.json`), "utf8")).toBe(
        '{"pending":[],"inProgress":[],"done":[]}\n',
      );
    }
  });

  test("default team name = basename(cwd) when --name absent (bash :25)", async () => {
    const exit = await runInit([]);
    expect(exit).toBe(0);
    const tj = JSON.parse(await readFile(join(env.cwd, ".atmux", "team.json"), "utf8")) as {
      name: string;
    };
    expect(tj.name).toBe("project");
  });

  test("--name '' (empty) falls through to basename(cwd)", async () => {
    const exit = await runInit(["--name", ""]);
    expect(exit).toBe(0);
    const tj = JSON.parse(await readFile(join(env.cwd, ".atmux", "team.json"), "utf8")) as {
      name: string;
    };
    expect(tj.name).toBe("project");
  });

  test("emits success line via logger + 'Next:' instructions to stdout", async () => {
    await runInit(["--name", "hello"]);
    // ok-line carries the team name + dir.
    expect(env.logs.length).toBe(1);
    expect(env.logs[0]).toMatchObject({ kind: "ok" });
    expect(env.logs[0]?.msg).toBe(`initialized atmux team 'hello' at ${join(env.cwd, ".atmux")}`);
    // stdout matches bash :80-84 + the ADR-217 §D5 skills-install render
    // line that precedes it. Test harness passes `env: {}` so the helper
    // short-circuits with `{kind: "skipped", reason: "$HOME unset"}`.
    // ADR-288 §D5: line 3 is drivers-first — the default roster has no
    // team-lead, so the old `atmux tell-lead` hint would fail closed.
    const stdout = env.stdoutBuf.join("");
    expect(stdout).toBe(
      [
        "· skills plugin install skipped ($HOME unset)\n",
        "\n",
        "Next:\n",
        `  1. review ${join(env.cwd, ".atmux", "team.json")}\n`,
        "  2. atmux start\n",
        "  3. attach the cage and drive from a driver window — work state lives on the kb board (ADR-288 §D5)\n",
      ].join(""),
    );
    expect(stdout).not.toContain("tell-lead");
  });
});

// ---------- init verb — refuse-overwrite + --force ----------

describe("init — overwrite gating (bash lib/init.sh:30-32, :40-42)", () => {
  test("second init without --force → ConfigError, name unchanged", async () => {
    await runInit(["--name", "a"]);
    let caught: unknown = null;
    try {
      await runInit(["--name", "b"]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const ce = caught as ConfigError;
    expect(ce.context.what as string).toContain("already initialized");
    // team.json content unchanged.
    const tj = JSON.parse(await readFile(join(env.cwd, ".atmux", "team.json"), "utf8")) as {
      name: string;
    };
    expect(tj.name).toBe("a");
  });

  test("--force overwrites + writes a timestamped backup", async () => {
    await runInit(["--name", "a"]);
    const dir = join(env.cwd, ".atmux");
    const tj = join(dir, "team.json");
    const before = await readFile(tj, "utf8");

    const exit = await runInit(["--name", "b", "--force"]);
    expect(exit).toBe(0);

    // team.json now reflects the new name.
    const after = JSON.parse(await readFile(tj, "utf8")) as { name: string };
    expect(after.name).toBe("b");

    // A backup file with .bak.<epoch> suffix was created carrying the
    // pre-overwrite content. Per bash lib/common.sh:106.
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir);
    const baks = entries.filter((e) => e.startsWith("team.json.bak."));
    expect(baks.length).toBeGreaterThanOrEqual(1);
    const bakContent = await readFile(join(dir, baks[0] ?? ""), "utf8");
    expect(bakContent).toBe(before);
  });

  test("--force on first-ever init (no prior team.json) does NOT write a backup", async () => {
    const exit = await runInit(["--name", "fresh", "--force"]);
    expect(exit).toBe(0);
    const dir = join(env.cwd, ".atmux");
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir);
    expect(entries.filter((e) => e.includes(".bak.")).length).toBe(0);
  });

  test("--force backup tolerates read failure (best-effort swallow)", async () => {
    await runInit(["--name", "a"]);
    const tj = join(env.cwd, ".atmux", "team.json");
    const backupReadCalls: string[] = [];
    const exit = await runInit(["--name", "b", "--force"], {
      backupReadText: async (path) => {
        backupReadCalls.push(path);
        throw new Error("synthetic backup read failure");
      },
    });
    expect(exit).toBe(0);
    expect(backupReadCalls).toEqual([tj]);
    // Overwrite still landed.
    const tj2 = JSON.parse(await readFile(tj, "utf8")) as { name: string };
    expect(tj2.name).toBe("b");
  });

  test("--force preserves existing kanban.json + per-member inbox content", async () => {
    // Declared-members template: the shipped drivers-only template never
    // enters the per-member inbox loop, so the `exists(ib)` → true
    // (preserve) branch is only reachable with a member in the roster.
    const templatesDir = await stageTemplate(DECLARED_MEMBERS_TEMPLATE);
    await runInit(["--name", "a"], { templatesDir });
    const dir = join(env.cwd, ".atmux");
    const k = join(dir, "kanban.json");
    const drv = join(dir, "driver-inbox.md");
    const ib = join(dir, "inboxes", "lead.json");
    // Mutate kanban + driver-inbox + lead's inbox to verify they survive
    // a re-init (bash idempotent guard: `[[ -f ... ]] || ...`).
    await writeFile(k, '{"tasks":[{"id":"t-1"}],"epics":[],"stories":[]}\n');
    await writeFile(drv, "carry-me-over\n");
    await writeFile(ib, '{"pending":[{"id":"x"}],"inProgress":[],"done":[]}\n');

    await runInit(["--name", "b", "--force"], { templatesDir });
    expect(await readFile(k, "utf8")).toBe('{"tasks":[{"id":"t-1"}],"epics":[],"stories":[]}\n');
    expect(await readFile(drv, "utf8")).toBe("carry-me-over\n");
    expect(await readFile(ib, "utf8")).toBe('{"pending":[{"id":"x"}],"inProgress":[],"done":[]}\n');
  });
});

// ---------- init verb — wizard refuse ----------

describe("init — --wizard not yet implemented (deferred)", () => {
  test("--wizard → ConfigError with explicit hint", async () => {
    let caught: unknown = null;
    try {
      await runInit(["--wizard"]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).context.what as string).toContain(
      "--wizard not yet implemented",
    );
  });

  test("-w → same ConfigError (short flag parity)", async () => {
    let caught: unknown = null;
    try {
      await runInit(["-w"]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigError);
  });
});

// ---------- init verb — default templates dir + env override ----------

describe("init — templates dir resolution", () => {
  test("ATMUX_TEMPLATES_DIR env override is consumed when opts.templatesDir absent", async () => {
    // Stage a custom templates dir with a minimal Team-shape JSON.
    const customRoot = await mkdtemp(join(tmpdir(), "atmux-init-tmpls-"));
    const customTemplates = join(customRoot, "templates");
    await mkdir(customTemplates, { recursive: true });
    await writeFile(
      join(customTemplates, "team.example.json"),
      JSON.stringify({ name: "placeholder", members: [{ name: "solo" }] }, null, 2),
    );
    try {
      const exit = await init(["--name", "envteam"], {
        cwd: env.cwd,
        env: { ATMUX_TEMPLATES_DIR: customTemplates },
        logger: env.logger,
        stdout: env.stdout,
      });
      expect(exit).toBe(0);
      const tj = await readRendered();
      // Single-member custom template was honoured.
      expect(tj.members.length).toBe(1);
      expect(tj.members[0]?.name).toBe("solo");
      expect(tj.members[0]?.cwd).toBe(env.cwd);
      // A template with no `drivers[]` renders without the key — init
      // must not litter `drivers: undefined` / `drivers: []` (the schema
      // rejects an empty drivers array on the next load).
      expect("drivers" in tj).toBe(false);
    } finally {
      await rm(customRoot, { recursive: true, force: true });
    }
  });

  test("no templatesDir + no env → defaults to repo's templates/ via import.meta.dir", async () => {
    // No `templatesDir`, no `ATMUX_TEMPLATES_DIR` → the verb resolves
    // the path via `import.meta.dir` (src/verbs/init.ts → repo root).
    // This invocation runs from `env.cwd` which is NOT the worktree, so
    // the default-resolution path is the only thing keeping it green.
    const exit = await init(["--name", "default-tmpls"], {
      cwd: env.cwd,
      env: {},
      logger: env.logger,
      stdout: env.stdout,
    });
    expect(exit).toBe(0);
    const tj = await readRendered();
    expect(tj.name).toBe("default-tmpls");
    // The shipped template is the ADR-287 §D5 drivers-only roster (five
    // ADR-239 drivers, zero members) — sanity-pin tracks
    // `templates/team.example.json`. (This asserts the default-resolved
    // template was loaded, not an injected one: the custom fixtures in
    // this file carry 0 or 2 drivers, never 5.)
    expect(tj.members.length).toBe(0);
    expect(tj.drivers?.length).toBe(5);
  });
});

// ---------- init verb — default stdout sink ----------

describe("init — default stdout sink (no opts.stdout)", () => {
  test("writes the 'Next:' block to process.stdout when no sink injected", async () => {
    // CLAUDE.md "verify green from the right path": the dispatcher in
    // src/cli.ts calls `init(argv)` with no opts, so the default stdout
    // path MUST be exercised in the unit suite or it ships untested.
    let captured = "";
    const orig = process.stdout.write.bind(process.stdout);
    // biome-ignore lint/suspicious/noExplicitAny: monkey-patch needs to match the overloaded signature
    (process.stdout as any).write = ((s: string | Uint8Array) => {
      captured += typeof s === "string" ? s : new TextDecoder().decode(s);
      return true;
    }) as typeof process.stdout.write;
    try {
      const exit = await init(["--name", "stdoutdef"], {
        cwd: env.cwd,
        templatesDir: env.templatesDir,
        env: {},
        logger: env.logger,
        // no `stdout` — exercises defaultStdout()
      });
      expect(exit).toBe(0);
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore overload
      (process.stdout as any).write = orig;
    }
    expect(captured).toContain("Next:");
    expect(captured).toContain("1. review");
    expect(captured).toContain("2. atmux start");
    // ADR-288 §D5 drivers-first hint replaces the `atmux tell-lead` line.
    expect(captured).toContain("3. attach the cage and drive from a driver window");
    expect(captured).toContain("ADR-288 §D5");
    expect(captured).not.toContain("tell-lead");
  });
});

// ---------- init verb — empty-name member skip ----------
//
// (No test here — the `Team` schema enforces `members[].name` is
// non-empty (src/schema/team.ts:27, `z.string().min(1)`), so the bash
// `[[ -z "$m" ]] && continue` defensive branch is statically
// unreachable in the TS port. A template with an empty-name member
// fails at `readJson` schema validation before init's loop runs.
// Coverage doesn't care; the invariant is enforced one layer up.)

// ---------- ADR-288 §D5 — init(shipped template) → `atmux start` ----------
//
// Integration pin (real per-socket tmux server via tests/helpers/tmux.ts,
// fake git; NOT e2e — no real `git worktree add`, no cockpit, no cron).
// ADR-288 §Consequences "New teams have no member windows": `atmux init`
// from the SHIPPED template, then `atmux start` against the rendered
// `.atmux/`, yields driver..driver-3 + `_bot` and nothing else. Because
// `drivers[]` is non-empty the `__<team>__home` placeholder is never
// created (driver is window 1), so start.ts step 9's close-out is a
// no-op and step 9b leaves team.json byte-identical (no emoji fallback
// fired for a roster with no members). Lives here rather than in
// start.test.ts because the subject is the shipped template's runtime
// shape, not start.ts control flow.
//
// Isolation mirrors tests/unit/verbs/start.test.ts: `-S <socketPath>`
// is baked into every tmux call, `TMUX` is unset for the duration,
// `ATMUX_NO_CRON=1` keeps the host crontab untouched, and the tmux HOME
// is a throwaway dir so no `tmux.conf.local` leaks in.

describe("ADR-288 §D5 — init(shipped template) → start", () => {
  let socketDir: string;
  let homeDir: string;
  let socketPath: string;
  let tmux: TmuxNamespace;
  let priorTmux: string | undefined;
  let priorNoCron: string | undefined;
  let restoreHome: (() => void) | null = null;

  beforeEach(async () => {
    socketDir = await mkdtemp(join(tmpdir(), "atmux-init-start-sock-"));
    homeDir = await mkdtemp(join(tmpdir(), "atmux-init-start-home-"));
    socketPath = join(socketDir, "sock");
    priorTmux = process.env.TMUX;
    delete process.env.TMUX;
    priorNoCron = process.env.ATMUX_NO_CRON;
    process.env.ATMUX_NO_CRON = "1";
    restoreHome = setCanonicalAtmuxTmuxHome(homeDir);
    tmux = createCanonicalAtmuxTmux({ socketPath });
  });

  afterEach(async () => {
    try {
      await tmux.server.killServer();
    } catch {
      // expected: server may already be gone (idempotent teardown)
    }
    restoreHome?.();
    restoreHome = null;
    if (priorTmux !== undefined) process.env.TMUX = priorTmux;
    if (priorNoCron !== undefined) process.env.ATMUX_NO_CRON = priorNoCron;
    else delete process.env.ATMUX_NO_CRON;
    await rm(socketDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  function gitResult(exitCode: number, stdout = ""): SpawnResult {
    return { cmd: "git", argv: [], exitCode, signalled: null, stdout, stderr: "", durationMs: 0 };
  }

  /** Healthy repo on `atmux-geoyws`: rev-parse + branch succeed, no
   *  `<base>-driver-N` / `<base>-bot` branch exists yet (`--verify` → 1),
   *  every other git call (`worktree add`, …) succeeds without touching
   *  disk. */
  function healthyGit(calls: ReadonlyArray<string>[]): GitSpawn {
    return async (argv) => {
      calls.push(argv);
      if (argv.includes("--show-toplevel")) return gitResult(0, `${env.cwd}\n`);
      if (argv.includes("--show-current")) return gitResult(0, "atmux-geoyws\n");
      if (argv.includes("--verify")) return gitResult(1);
      return gitResult(0);
    };
  }

  test("drivers-only default scaffold starts superdriver + driver..driver-3 + _bot at windows 1..5, never creates __<team>__home, leaves team.json byte-identical", async () => {
    const team = `i${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    expect(await runInit(["--name", team, "--no-skills"])).toBe(0);
    const atmuxDir = join(env.cwd, ".atmux");
    const tjPath = join(atmuxDir, "team.json");
    const before = await readFile(tjPath, "utf8");
    const tj = JSON.parse(before) as RenderedTeam;
    expect(tj.members).toEqual([]);
    expect(tj.drivers?.map((d) => d.name)).toEqual([
      "driver",
      "driver-2",
      "driver-3",
    ]);
    expect(tj.bot?.enabled).toBe(true);

    // The fake git never runs a real `worktree add`, so stand in for the
    // directories it would have created (tmux refuses a missing cwd).
    for (const d of ["driver-2", "driver-3", "bot"]) {
      await mkdir(join(atmuxDir, "worktrees", d), { recursive: true });
    }

    const calls: ReadonlyArray<string>[] = [];
    const exit = await start(["--socket-path", socketPath], {
      env: { ...process.env, ATMUX_DIR: atmuxDir },
      cwd: env.cwd,
      logger: env.logger,
      loadCockpitFn: async () => null,
      gitSpawn: healthyGit(calls),
    });
    expect(exit).toBe(0);

    const wins = [...(await tmux.window.listWindows(team))].sort((a, b) => a.index - b.index);
    expect(wins.map((w) => w.name)).toEqual([
      "superdriver",
      "driver",
      "driver-2",
      "driver-3",
      "_bot",
    ]);
    expect(wins.map((w) => w.index)).toEqual([1, 2, 3, 4, 5]);
    expect(wins.some((w) => w.name === `__${team}__home`)).toBe(false);
    // Step 9b: no emoji fallback fired → team.json is byte-identical.
    expect(await readFile(tjPath, "utf8")).toBe(before);
    // Nothing errored on the way (init + start share the sink).
    expect(env.logs.filter((l) => l.kind === "err")).toEqual([]);
    // Worktree provisioning was attempted for driver-2..5 + bot off the
    // detected base branch — the drivers-only roster still isolates.
    for (const d of ["driver-2", "driver-3", "bot"]) {
      expect(calls.some((c) => c.includes(`atmux-geoyws-${d}`))).toBe(true);
    }
  });
});
