// ADR-217 §D5 — install the bundled /atmux: skills plugin.
//
// Source: <atmux-source>/plugins/atmux/  (scaffold from t-aff014ed)
// Target: ~/.claude/plugins/atmux/        (Claude Code's plugin discovery)
//
// Install is a symlink target → source. Reasoning per ADR-217 §D5:
//   - Symlink auto-refreshes on atmux upgrade (operator picks up new
//     SKILL.md bodies without re-running atmux init).
//   - Real-directory override preserved when operator dotfiles
//     materialized their own directory at the install path.
//   - Opt-out marker at ~/.atmux/state/skills-plugin-opted-out wins
//     over everything (user said [n] in wizard).

import { existsSync, realpathSync } from "node:fs";
import { mkdir as fsMkdir, readlink, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { exists, statOrNull } from "../abstractions/fs.ts";

// ---------- Plugins-dir resolver (mirrors resolveTemplatesDir) ----------

/** Resolve `<atmux-source>/plugins/`. Same dev/installed dual-path
 *  pattern as resolveTemplatesDir — compiled bun ELF's `import.meta.dir`
 *  sits inside $bunfs (rooted at `/`), so the dev probe falls through
 *  to a realpath-on-execPath installed-mode lookup. */
export function resolvePluginsDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ATMUX_PLUGINS_DIR;
  if (override !== undefined && override.length > 0) return override;

  const devPath = resolve(import.meta.dir, "..", "..", "plugins");
  if (existsSync(devPath)) return devPath;

  try {
    const real = realpathSync(process.execPath);
    const installedPath = resolve(dirname(real), "..", "plugins");
    if (existsSync(installedPath)) return installedPath;
  } catch {
    // realpath can throw on missing execPath; fall through.
  }

  return devPath;
}

// ---------- State model ----------

export type SkillsInstallResult =
  | { kind: "installed"; target: string; source: string }
  | { kind: "already-installed"; target: string; source: string }
  | { kind: "real-dir-override"; target: string }
  | { kind: "wrong-target"; target: string; existingTarget: string; expectedTarget: string }
  | { kind: "wrong-target-replaced"; target: string; source: string; previousTarget: string }
  | { kind: "opted-out"; markerPath: string }
  | { kind: "marker-written"; markerPath: string }
  | { kind: "skipped"; reason: string };

export interface InstallSkillsPluginOpts {
  source?: string;
  target?: string;
  optOutMarker?: string;
  force?: boolean;
  noSkills?: boolean;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

/** Idempotent install. All filesystem I/O via node:fs/promises; injection
 *  seams via opts so unit tests can run without touching $HOME. */
export async function installSkillsPlugin(
  opts: InstallSkillsPluginOpts = {},
): Promise<SkillsInstallResult> {
  if (opts.noSkills === true) {
    return { kind: "skipped", reason: "--no-skills passed" };
  }

  const env = opts.env ?? process.env;
  const home = opts.home ?? env.HOME;
  if (home === undefined || home.length === 0) {
    return { kind: "skipped", reason: "$HOME unset" };
  }

  const optOutMarker =
    opts.optOutMarker ?? join(home, ".atmux", "state", "skills-plugin-opted-out");
  if (await exists(optOutMarker)) {
    return { kind: "opted-out", markerPath: optOutMarker };
  }

  const source = opts.source ?? join(resolvePluginsDir(env), "atmux");
  const target = opts.target ?? join(home, ".claude", "plugins", "atmux");

  const st = await statOrNull(target);
  if (st === null) {
    await fsMkdir(dirname(target), { recursive: true });
    await symlink(source, target);
    return { kind: "installed", target, source };
  }

  let existingTarget: string | null = null;
  try {
    existingTarget = await readlink(target);
  } catch {
    existingTarget = null;
  }

  if (existingTarget === null) {
    // Real directory — operator dotfiles override per §D5.
    return { kind: "real-dir-override", target };
  }

  const expected = resolve(source);
  const actual = resolve(dirname(target), existingTarget);
  if (expected === actual) {
    return { kind: "already-installed", target, source };
  }

  if (opts.force === true) {
    await unlink(target);
    await symlink(source, target);
    return {
      kind: "wrong-target-replaced",
      target,
      source,
      previousTarget: actual,
    };
  }
  return {
    kind: "wrong-target",
    target,
    existingTarget: actual,
    expectedTarget: expected,
  };
}

/** Render a SkillsInstallResult into operator-facing lines (trailing
 *  `\n`). Caller pipes to its configured stdout writer. */
export function renderSkillsInstallResult(r: SkillsInstallResult): string {
  switch (r.kind) {
    case "installed":
      return `✓ skills plugin installed: ${r.target} → ${r.source}\n`;
    case "already-installed":
      return `✓ skills plugin already installed\n`;
    case "real-dir-override":
      return `⚠ ${r.target} exists as real directory — operator-dotfiles override preserved; bundled plugin not installed\n`;
    case "wrong-target":
      return (
        `✗ skills plugin path occupied by symlink to ${r.existingTarget}\n` +
        `  expected → ${r.expectedTarget}\n` +
        `  rerun with --force to replace\n`
      );
    case "wrong-target-replaced":
      return `✓ skills plugin re-symlinked (was → ${r.previousTarget}, now → ${r.source})\n`;
    case "opted-out":
      return `· skills plugin install skipped — opt-out marker at ${r.markerPath}\n`;
    case "marker-written":
      return `· skills plugin install opted out (marker: ${r.markerPath})\n`;
    case "skipped":
      return `· skills plugin install skipped (${r.reason})\n`;
  }
}

/** Write the opt-out marker — used by the deferred wizard branch when
 *  operator answers [n] to the install prompt. Idempotent. */
export async function writeOptOutMarker(
  opts: { home?: string; optOutMarker?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<SkillsInstallResult> {
  const env = opts.env ?? process.env;
  const home = opts.home ?? env.HOME;
  if (home === undefined || home.length === 0) {
    return { kind: "skipped", reason: "$HOME unset" };
  }
  const markerPath =
    opts.optOutMarker ?? join(home, ".atmux", "state", "skills-plugin-opted-out");
  await fsMkdir(dirname(markerPath), { recursive: true });
  await writeFile(markerPath, "", { flag: "w" });
  return { kind: "marker-written", markerPath };
}

// ---------- 12-skill reference table for the [s]how branch ----------

/** Source of truth: ADR-217 §D2 carve set. Surface used by the deferred
 *  interactive wizard prompt + plugins/atmux/README.md cross-link. */
export const SKILLS_TABLE: ReadonlyArray<{ name: string; desc: string }> = [
  { name: "/atmux:team", desc: "unified team lifecycle (start/stop/add/clear/cleanup/bootstrap/rotate)" },
  { name: "/atmux:session", desc: "session continuity (cont/preclear/handoff/stop)" },
  { name: "/atmux:tell-lead", desc: "driver→lead durable message" },
  { name: "/atmux:heads-up", desc: "lightweight teammate ping" },
  { name: "/atmux:bruh", desc: "sweep blockers/flags/worktrees in one pass" },
  { name: "/atmux:bruhloop", desc: "hands-off /loop wrapper around bruh" },
  { name: "/atmux:whip", desc: "autonomous-work nudge loop" },
  { name: "/atmux:bau", desc: "business-as-usual status sweep" },
  { name: "/atmux:ghostbuster", desc: "mergeable-branch sweeper (scoped to calling team)" },
  { name: "/atmux:budget", desc: "rate-limit probe across Claude accounts" },
  { name: "/atmux:sweep", desc: "cockpit-level fleet health sweep (was: superdoctor)" },
  { name: "/atmux:cockpit-rebuild", desc: "deterministic cockpit rebuild" },
];

/** Render SKILLS_TABLE for [s]how. Padded left-column for alignment. */
export function renderSkillsTable(): string {
  const nameWidth = Math.max(...SKILLS_TABLE.map((s) => s.name.length));
  return SKILLS_TABLE.map((s) => `  ${s.name.padEnd(nameWidth)}  ${s.desc}`).join("\n") + "\n";
}
