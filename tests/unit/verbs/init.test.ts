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

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Logger } from "../../../src/core/tui.ts";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import { init, parseInitArgs } from "../../../src/verbs/init.ts";

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

  test("creates .atmux/ scaffold + team.json with --name + members + scaffold dirs", async () => {
    const exit = await runInit(["--name", "hello"]);
    expect(exit).toBe(0);

    const dir = join(env.cwd, ".atmux");
    expect((await stat(dir)).isDirectory()).toBe(true);
    expect((await stat(join(dir, "inboxes"))).isDirectory()).toBe(true);
    expect((await stat(join(dir, "logs"))).isDirectory()).toBe(true);
    expect((await stat(join(dir, "state"))).isDirectory()).toBe(true);
    expect((await stat(join(dir, "archive"))).isDirectory()).toBe(true);

    const tj = JSON.parse(await readFile(join(dir, "team.json"), "utf8")) as {
      name: string;
      tmuxTmpdir?: string;
      drivers: { name: string; tui?: string | null; cwd?: string }[];
      driverPair: {
        layout: string;
        panes: Array<{
          role: string;
          side: string;
          workflow?: string;
          authority?: string;
          command?: string | null;
        }>;
      };
      members: { name: string; role?: string; cwd?: string }[];
    };
    expect(tj.name).toBe("hello");
    // Bash lib/init.sh:104 — tmuxTmpdir set to the per-team cage path.
    expect(tj.tmuxTmpdir).toBe("/tmp/atmux-tmux_hello");
    expect(tj.drivers.length).toBe(3);
    expect(tj.drivers.map((d) => d.name)).toEqual(["driver", "driver-2", "driver-3"]);
    expect(tj.drivers.every((d) => d.tui === null)).toBe(true);
    expect(tj.driverPair).toEqual({
      layout: "horizontal",
      panes: [
        { role: "worker", side: "left" },
        {
          role: "attention",
          side: "right",
          workflow: "kb-att",
          authority: "decision-only",
          command: null,
        },
      ],
    });
    // Bash lib/init.sh:105 — every member's cwd rewritten to PWD.
    for (const m of tj.members) {
      expect(m.cwd).toBe(env.cwd);
    }
    // Template-shape sanity. Tracks `templates/team.example.json` —
    // bump together when the shipped roster changes. ADR-239 §A2
    // (amendment 2026-05-26) trimmed every parent team to the strict
    // 5-name roster {lead, planner, docs, reviewer, gitter}; the
    // specialist seats (fe-auth/be-auth/db-auth/dba/ombudsman/…) were
    // swept out in commit 5198e12.
    expect(tj.members.length).toBe(5);
    expect(tj.members.filter((m) => m.role === "team-lead").length).toBe(1);
    expect(tj.members.filter((m) => m.role === "planner").length).toBe(1);
    expect(tj.members.filter((m) => m.role === "docs").length).toBe(1);
    expect(tj.members.filter((m) => m.role === "reviewer").length).toBe(1);
    // ADR-159 TR3: the `gitter` member carries the canonical
    // `role: "committer"` (the template ships the canonical value; a
    // legacy `role: "gitter"` would also coerce to "committer" via the
    // TeamMember schema transform on load).
    expect(tj.members.filter((m) => m.role === "committer").length).toBe(1);
    // The 5-name roster is exactly {lead, planner, docs, reviewer, gitter}
    // — assert the named set so a future roster drift is caught.
    expect(tj.members.map((m) => m.name).sort()).toEqual([
      "docs",
      "gitter",
      "lead",
      "planner",
      "reviewer",
    ]);
  });

  // t-3866c5b1 / ADR-094: --claude-account flag end-to-end
  test("--claude-account personal stamps every member with claudeAccount field", async () => {
    await runInit(["--name", "alpha", "--claude-account", "personal"]);
    const tj = JSON.parse(await readFile(join(env.cwd, ".atmux", "team.json"), "utf8")) as {
      members: { name: string; claudeAccount?: string }[];
    };
    // Every member entry carries the field — applied uniformly (no
    // per-member override at init time; that's the `atmux reconfigure`
    // path per ADR-094).
    for (const m of tj.members) {
      expect(m.claudeAccount).toBe("personal");
    }
  });

  test("--claude-account default → NO claudeAccount field on disk (schema-default)", async () => {
    await runInit(["--name", "alpha", "--claude-account", "default"]);
    const tj = JSON.parse(await readFile(join(env.cwd, ".atmux", "team.json"), "utf8")) as {
      members: { name: string; claudeAccount?: string }[];
    };
    // Per ADR-094 §"Default handling": "default" means "no field on
    // disk; schema-default applies" — don't litter team.json with the
    // implicit default value.
    for (const m of tj.members) {
      expect(m.claudeAccount).toBeUndefined();
    }
  });

  test("no --claude-account → NO claudeAccount field on disk (preserves template)", async () => {
    await runInit(["--name", "alpha"]);
    const tj = JSON.parse(await readFile(join(env.cwd, ".atmux", "team.json"), "utf8")) as {
      members: { name: string; claudeAccount?: string }[];
    };
    // The lead entry in templates/team.example.json carries a
    // demonstration `claudeAccount: "personal"` field (added by
    // t-bd618833). When --claude-account is unset, the template's
    // value passes through verbatim — operator gets the template's
    // example unless they override.
    const lead = tj.members.find((m) => m.name === "lead");
    expect(lead?.claudeAccount).toBe("personal");
    // Other members in the template don't carry the field, so they
    // stay undefined post-init.
    const planner = tj.members.find((m) => m.name === "planner");
    expect(planner?.claudeAccount).toBeUndefined();
  });

  test("seeds kanban.json + driver-inbox.md + per-member inbox files (byte-exact)", async () => {
    await runInit(["--name", "h"]);
    const dir = join(env.cwd, ".atmux");
    // Bash lib/init.sh:50 emits the literal compact form via `echo`.
    expect(await readFile(join(dir, "kanban.json"), "utf8")).toBe(
      '{"tasks":[],"epics":[],"stories":[]}\n',
    );
    // Bash lib/init.sh:51 — `: > "$di"` produces a zero-byte file.
    expect(await readFile(join(dir, "driver-inbox.md"), "utf8")).toBe("");
    // Bash lib/init.sh:59 — every member.name gets a stub inbox. Roster
    // is the ADR-239 §A2 strict 5-name set {lead, planner, docs,
    // reviewer, gitter}; assert every one of them gets a stub.
    for (const m of ["lead", "planner", "docs", "reviewer", "gitter"]) {
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
    const stdout = env.stdoutBuf.join("");
    expect(stdout).toBe(
      [
        "· skills plugin install skipped ($HOME unset)\n",
        "\n",
        "Next:\n",
        `  1. review ${join(env.cwd, ".atmux", "team.json")}\n`,
        "  2. atmux start\n",
        "  3. atmux tell-lead 'build feature X'\n",
      ].join(""),
    );
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
    await runInit(["--name", "a"]);
    const dir = join(env.cwd, ".atmux");
    const k = join(dir, "kanban.json");
    const drv = join(dir, "driver-inbox.md");
    const ib = join(dir, "inboxes", "lead.json");
    // Mutate kanban + driver-inbox + lead's inbox to verify they survive
    // a re-init (bash idempotent guard: `[[ -f ... ]] || ...`).
    await writeFile(k, '{"tasks":[{"id":"t-1"}],"epics":[],"stories":[]}\n');
    await writeFile(drv, "carry-me-over\n");
    await writeFile(ib, '{"pending":[{"id":"x"}],"inProgress":[],"done":[]}\n');

    await runInit(["--name", "b", "--force"]);
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
      const tj = JSON.parse(await readFile(join(env.cwd, ".atmux", "team.json"), "utf8")) as {
        members: { name: string; cwd: string }[];
      };
      // Single-member custom template was honoured.
      expect(tj.members.length).toBe(1);
      expect(tj.members[0]?.name).toBe("solo");
      expect(tj.members[0]?.cwd).toBe(env.cwd);
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
    const tj = JSON.parse(await readFile(join(env.cwd, ".atmux", "team.json"), "utf8")) as {
      name: string;
      members: unknown[];
    };
    expect(tj.name).toBe("default-tmpls");
    // The shipped template has the ADR-239 §A2 strict 5-name roster —
    // sanity-pin tracks `templates/team.example.json`. (This asserts the
    // default-resolved template was loaded, not the injected one, since
    // it carries the full shipped roster size.)
    expect(tj.members.length).toBe(5);
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
    expect(captured).toContain("3. atmux tell-lead");
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
