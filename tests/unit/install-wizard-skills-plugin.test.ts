// Unit tests for the wizard step that installs the /atmux: skills
// plugin (ADR-217 §D5). Surface: src/core/skills-plugin-install.ts +
// the `--skills-only` short-circuit branch of src/verbs/init.ts.
//
// Pairs with t-b16a5386 (the wizard step shipped at commit 3acb8be).
// 100% on the helper's branch set per the t-c00d99cf task body.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  installSkillsPlugin,
  renderSkillsInstallResult,
  renderSkillsTable,
  resolvePluginsDir,
  SKILLS_TABLE,
  writeOptOutMarker,
} from "../../src/core/skills-plugin-install.ts";
import { init } from "../../src/verbs/init.ts";

// ---------- Fixture ----------

interface TestEnv {
  scratch: string;
  home: string;
  source: string; // <fake-atmux>/plugins/atmux
}

let env: TestEnv;

beforeEach(async () => {
  const scratch = await mkdtemp(join(tmpdir(), "atmux-wizard-skills-"));
  const home = join(scratch, "home");
  const source = join(scratch, "atmux-source", "plugins", "atmux");
  await mkdir(home, { recursive: true });
  await mkdir(source, { recursive: true });
  await mkdir(join(source, ".claude-plugin"), { recursive: true });
  await writeFile(
    join(source, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "atmux", skills: [] }),
  );
  env = { scratch, home, source };
});

afterEach(async () => {
  await rm(env.scratch, { recursive: true, force: true });
});

// ---------- installSkillsPlugin (default [Y] branch + flag matrix) ----------

describe("installSkillsPlugin — default install + idempotence", () => {
  test("[Y] default → creates symlink at ~/.claude/plugins/atmux → source", async () => {
    const target = join(env.home, ".claude", "plugins", "atmux");
    const r = await installSkillsPlugin({ home: env.home, source: env.source });
    expect(r.kind).toBe("installed");
    // Verify via readlink — must be a symlink pointing at the source.
    const linkTarget = await readlink(target);
    expect(linkTarget).toBe(env.source);
  });

  test("idempotent re-run → no-op with 'already-installed' result", async () => {
    await installSkillsPlugin({ home: env.home, source: env.source });
    const r2 = await installSkillsPlugin({ home: env.home, source: env.source });
    expect(r2.kind).toBe("already-installed");
    // Render is the operator-facing line.
    expect(renderSkillsInstallResult(r2)).toMatch(/already installed/);
  });
});

// ---------- writeOptOutMarker — [n] branch ----------

describe("writeOptOutMarker — [n] in install prompt", () => {
  test("writes marker at ~/.atmux/state/skills-plugin-opted-out", async () => {
    const r = await writeOptOutMarker({ home: env.home });
    expect(r.kind).toBe("marker-written");
    const markerPath = join(env.home, ".atmux", "state", "skills-plugin-opted-out");
    const st = await stat(markerPath);
    expect(st.isFile()).toBe(true);
  });

  test("subsequent install honours opt-out marker, no symlink created", async () => {
    await writeOptOutMarker({ home: env.home });
    const r = await installSkillsPlugin({ home: env.home, source: env.source });
    expect(r.kind).toBe("opted-out");
    // Verify NO symlink at install path.
    const target = join(env.home, ".claude", "plugins", "atmux");
    await expect(stat(target)).rejects.toThrow(/ENOENT/);
  });

  test("$HOME unset → skipped (defensive — caller probably broken)", async () => {
    const r = await writeOptOutMarker({ home: "" });
    expect(r.kind).toBe("skipped");
  });
});

// ---------- Real-directory override (operator dotfiles win) ----------

describe("installSkillsPlugin — operator-dotfiles override", () => {
  test("existing real directory at install path → preserved + 'real-dir-override' result", async () => {
    const target = join(env.home, ".claude", "plugins", "atmux");
    await mkdir(target, { recursive: true });
    // Write a marker file inside the dir so we can verify it survived.
    await writeFile(join(target, "OPERATOR-OVERRIDE"), "preserve me");

    const r = await installSkillsPlugin({ home: env.home, source: env.source });
    expect(r.kind).toBe("real-dir-override");
    // Marker file untouched.
    const content = await readFile(join(target, "OPERATOR-OVERRIDE"), "utf8");
    expect(content).toBe("preserve me");
    // Render mentions the override.
    expect(renderSkillsInstallResult(r)).toMatch(/operator-dotfiles override/);
  });
});

// ---------- Wrong-target symlink ----------

describe("installSkillsPlugin — wrong-target symlink", () => {
  test("existing wrong-target symlink without --force → 'wrong-target' result", async () => {
    const wrongTarget = join(env.scratch, "some-other-plugin");
    await mkdir(wrongTarget);
    const target = join(env.home, ".claude", "plugins", "atmux");
    await mkdir(join(env.home, ".claude", "plugins"), { recursive: true });
    await symlink(wrongTarget, target);

    const r = await installSkillsPlugin({ home: env.home, source: env.source });
    expect(r.kind).toBe("wrong-target");
    if (r.kind === "wrong-target") {
      expect(r.existingTarget).toBe(wrongTarget);
      expect(r.expectedTarget).toBe(env.source);
    }
    // Render mentions --force hint.
    expect(renderSkillsInstallResult(r)).toMatch(/--force/);
  });

  test("existing wrong-target symlink with --force → replaced + 'wrong-target-replaced' result", async () => {
    const wrongTarget = join(env.scratch, "some-other-plugin");
    await mkdir(wrongTarget);
    const target = join(env.home, ".claude", "plugins", "atmux");
    await mkdir(join(env.home, ".claude", "plugins"), { recursive: true });
    await symlink(wrongTarget, target);

    const r = await installSkillsPlugin({
      home: env.home,
      source: env.source,
      force: true,
    });
    expect(r.kind).toBe("wrong-target-replaced");
    // Verify symlink now points at the source.
    const newLink = await readlink(target);
    expect(newLink).toBe(env.source);
  });
});

describe("renderSkillsInstallResult — remaining branches", () => {
  test("opted-out, marker-written, and wrong-target-replaced render distinct operator lines", () => {
    expect(renderSkillsInstallResult({ kind: "opted-out", markerPath: "/tmp/marker" })).toBe(
      "· skills plugin install skipped — opt-out marker at /tmp/marker\n",
    );
    expect(renderSkillsInstallResult({ kind: "marker-written", markerPath: "/tmp/marker" })).toBe(
      "· skills plugin install opted out (marker: /tmp/marker)\n",
    );
    expect(
      renderSkillsInstallResult({
        kind: "wrong-target-replaced",
        target: "/tmp/target",
        source: "/tmp/source",
        previousTarget: "/tmp/old",
      }),
    ).toBe("✓ skills plugin re-symlinked (was → /tmp/old, now → /tmp/source)\n");
  });
});

// ---------- --no-skills flag ----------

describe("installSkillsPlugin — --no-skills flag", () => {
  test("noSkills: true → skipped with reason '--no-skills passed'", async () => {
    const r = await installSkillsPlugin({
      home: env.home,
      source: env.source,
      noSkills: true,
    });
    expect(r.kind).toBe("skipped");
    if (r.kind === "skipped") {
      expect(r.reason).toMatch(/--no-skills/);
    }
    // No symlink created.
    const target = join(env.home, ".claude", "plugins", "atmux");
    await expect(stat(target)).rejects.toThrow(/ENOENT/);
  });
});

// ---------- init.ts --skills-only short-circuit ----------

describe("init verb — --skills-only flag", () => {
  test("--skills-only short-circuits team.json scaffold + runs install step", async () => {
    // Run init --skills-only on a fresh cwd. Should NOT create .atmux/.
    const cwd = await mkdtemp(join(tmpdir(), "atmux-init-skills-only-"));
    const stdoutBuf: string[] = [];
    const exit = await init(["--skills-only"], {
      cwd,
      env: { HOME: env.home, ATMUX_PLUGINS_DIR: join(env.scratch, "atmux-source", "plugins") },
      stdout: (s) => stdoutBuf.push(s),
    });
    expect(exit).toBe(0);
    // No .atmux/ scaffold under cwd.
    await expect(stat(join(cwd, ".atmux"))).rejects.toThrow(/ENOENT/);
    // Symlink WAS created at ~/.claude/plugins/atmux.
    const target = join(env.home, ".claude", "plugins", "atmux");
    const linkTarget = await readlink(target);
    expect(linkTarget).toBe(env.source);
    // Stdout shows the install result, not the "Next:" lines.
    const stdout = stdoutBuf.join("");
    expect(stdout).toMatch(/skills plugin installed/);
    expect(stdout).not.toMatch(/Next:/);

    await rm(cwd, { recursive: true, force: true });
  });

  test("--no-skills + --skills-only mutually exclusive → UsageError exit 64", async () => {
    // parseInitArgs throws UsageError synchronously. Catch from the
    // promise rejection of init().
    let caught: unknown = null;
    try {
      await init(["--no-skills", "--skills-only"], {
        cwd: env.scratch,
        env: {},
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(String(caught)).toMatch(/cannot be combined/);
  });
});

// ---------- [s]how branch → SKILLS_TABLE + render ----------

describe("SKILLS_TABLE — [s]how reference table", () => {
  test("contains exactly 13 entries — one per §D2 carve set skill", () => {
    expect(SKILLS_TABLE).toHaveLength(13);
  });

  test("each entry has a /atmux:<name> shape + non-empty description", () => {
    for (const s of SKILLS_TABLE) {
      expect(s.name).toMatch(/^\/atmux:/);
      expect(s.desc.length).toBeGreaterThan(0);
    }
  });

  test("table includes the 13 §D2 skill names", () => {
    const names = SKILLS_TABLE.map((s) => s.name);
    expect(names).toContain("/atmux:team");
    expect(names).toContain("/atmux:driver");
    expect(names).toContain("/atmux:session");
    expect(names).toContain("/atmux:tell-lead");
    expect(names).toContain("/atmux:heads-up");
    expect(names).toContain("/atmux:bruh");
    expect(names).toContain("/atmux:bruhloop");
    expect(names).toContain("/atmux:whip");
    expect(names).toContain("/atmux:bau");
    expect(names).toContain("/atmux:ghostbuster");
    expect(names).toContain("/atmux:budget");
    expect(names).toContain("/atmux:sweep");
    expect(names).toContain("/atmux:cockpit-rebuild");
  });

  test("renderSkillsTable returns 13 left-aligned lines with skill+desc", () => {
    const out = renderSkillsTable();
    // Strip trailing newline (helper appends one) but preserve per-line
    // leading-space indent. `.trim()` would eat line 1's indent.
    const lines = out.replace(/\n$/, "").split("\n");
    expect(lines).toHaveLength(13);
    for (const line of lines) {
      expect(line).toMatch(/^  \/atmux:/);
    }
  });
});

// ---------- resolvePluginsDir — env override path ----------

describe("resolvePluginsDir", () => {
  test("ATMUX_PLUGINS_DIR env override honoured verbatim", () => {
    const out = resolvePluginsDir({ ATMUX_PLUGINS_DIR: "/custom/plugins" });
    expect(out).toBe("/custom/plugins");
  });

  test("empty ATMUX_PLUGINS_DIR falls through to dev/installed probe", () => {
    const out = resolvePluginsDir({ ATMUX_PLUGINS_DIR: "" });
    // Falls through — exact result depends on test runtime; just verify
    // it returns a non-empty path that ends with `plugins`.
    expect(out.length).toBeGreaterThan(0);
    expect(out).toMatch(/plugins$/);
  });
});

describe("resolvePluginsDir — installed-mode fallback", () => {
  test("dev probe miss + realpath hit → returns installed-mode plugins dir", () => {
    const devPath = resolve(import.meta.dir, "..", "..", "plugins");
    const execPath = join(env.scratch, "bin", "atmux");
    const installedPath = join(env.scratch, "plugins");
    const existsCalls: string[] = [];
    let realpathArg: string | undefined;
    const out = resolvePluginsDir(
      {},
      {
        execPath,
        existsSync: (p) => {
          existsCalls.push(p);
          return p === installedPath;
        },
        realpathSync: (p) => {
          realpathArg = p;
          return execPath;
        },
      },
    );
    expect(realpathArg).toBe(execPath);
    expect(existsCalls).toEqual([devPath, installedPath]);
    expect(out).toBe(installedPath);
  });

  test("installed-path miss falls back to the dev-mode plugins dir", () => {
    const devPath = resolve(import.meta.dir, "..", "..", "plugins");
    const execPath = join(env.scratch, "missing-bin", "atmux");
    const installedPath = join(env.scratch, "plugins");
    const existsCalls: string[] = [];
    const out = resolvePluginsDir(
      {},
      {
        execPath,
        existsSync: (p) => {
          existsCalls.push(p);
          return false;
        },
        realpathSync: (p) => {
          expect(p).toBe(execPath);
          return execPath;
        },
      },
    );
    expect(existsCalls).toEqual([devPath, installedPath]);
    expect(out).toBe(devPath);
  });
});
