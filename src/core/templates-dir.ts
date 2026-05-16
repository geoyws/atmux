// Templates-dir resolver — single source of truth for the `templates/`
// directory location across init / rotate / start / doctor consumers.
//
// **Why this exists** (c-003a2a4c / t-17d413b1): two resolvers
// previously hard-coded `resolve(import.meta.dir, "..", "..",
// "templates")`:
//   - `src/verbs/init.ts::defaultTemplatesDir` for `team.example.json`
//   - `src/verbs/rotate.ts::defaultBriefsDir` for `briefs/*.md`
//
// Both broke in compiled-mode (`bun --compile` ELF at
// `/opt/atmux/<v>/bin/atmux`): `import.meta.dir` returns a path inside
// bun's internal $bunfs (rooted at `/`), so `resolve(..,"..","..","templates")`
// walks to `/templates` (filesystem root). Result: `atmux init` on the
// installed binary errored with `fs read failed on
// /templates/team.example.json`. Same break would hit every brief read
// from `rotate.ts` + `start.ts`.
//
// **Resolution chain** (in order):
//   1. `ATMUX_TEMPLATES_DIR` env override — operator escape hatch +
//      test injection point. Honoured verbatim if set + non-empty.
//   2. Dev-mode path — `<this-file>/../../../templates` resolved against
//      `import.meta.dir`. Exists in source tree (`<repo>/templates`);
//      probed via `existsSync` so installed-mode (where the path
//      resolves to a missing $bunfs path) falls through.
//   3. Installed-mode path — `<realpath of process.execPath>/../../templates`.
//      For `/opt/atmux/<v>/bin/atmux` (the canonical install topology
//      per `[[project_atmux_install_topology]]` memory + ADR-047),
//      this is `/opt/atmux/<v>/templates/`. Symlinks unwound via
//      `realpathSync` so `/usr/local/bin/atmux` (the public entry
//      point) resolves through `/opt/atmux/current` to the active
//      versioned dir.
//   4. Fallback — return the dev-mode path even if it doesn't exist,
//      so the downstream `readJson` / `readText` surfaces an actionable
//      "fs read failed on <path>" error pointing at the canonical
//      location.
//
// **Companion build:install change**: `package.json::scripts.build:install`
// now copies `templates/` to `/opt/atmux/<v>/templates/` alongside
// `bin/atmux` so step 3 above has a target to find.

import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Resolve the `templates/` directory. See module header for the full
 * resolution chain. Returns a path string (caller probes / reads as
 * needed; this fn does NOT throw on missing).
 */
export function resolveTemplatesDir(env: NodeJS.ProcessEnv = process.env): string {
  // (1) env override
  const override = env.ATMUX_TEMPLATES_DIR;
  if (override !== undefined && override.length > 0) return override;

  // (2) dev-mode — `<repo>/src/core/templates-dir.ts` → up 2 → `<repo>` →
  // `+ templates`. Probe; if exists, return.
  const devPath = resolve(import.meta.dir, "..", "..", "templates");
  if (existsSync(devPath)) return devPath;

  // (3) installed-mode — `/opt/atmux/<v>/bin/atmux` (after realpath
  // unwinds `/usr/local/bin/atmux → /opt/atmux/current/bin/atmux →
  // /opt/atmux/<v>/bin/atmux`) → up 1 → `/opt/atmux/<v>` →
  // `+ templates`. Probe; if exists, return.
  try {
    const real = realpathSync(process.execPath);
    const installedPath = resolve(dirname(real), "..", "templates");
    if (existsSync(installedPath)) return installedPath;
  } catch {
    // realpath can throw on missing execPath (defensive — unreachable
    // in practice). Fall through to (4).
  }

  // (4) fallback — dev-mode path even if missing, so the downstream
  // fs error surfaces the canonical location.
  return devPath;
}

/** Resolve `<templates>/briefs/`. Composed from `resolveTemplatesDir`
 *  + `briefs` suffix; no separate probe — if templates resolves,
 *  briefs is the conventional sibling. */
export function resolveBriefsDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(resolveTemplatesDir(env), "briefs");
}
