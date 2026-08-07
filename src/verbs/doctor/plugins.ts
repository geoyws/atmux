import { join } from "node:path";
import { exists, readTextOrNull, statOrNull } from "../../abstractions/fs.ts";
import type { DoctorRow } from "./types.ts";

// ---------- atmux-skills-plugin probe (ADR-217 §D5) ----------

/** Inputs the pure state-mapper resolves to a doctor row. Exported so
 *  tests exercise every branch without filesystem I/O. */
export type SkillsPluginState =
  | { kind: "opted-out" }
  | { kind: "symlink-missing" }
  | { kind: "plugin-json-missing"; installPath: string }
  | { kind: "plugin-json-malformed"; installPath: string; reason: string }
  | { kind: "plugin-json-schema-fail"; installPath: string; reason: string }
  | { kind: "green"; installPath: string; pluginName: string };

/** Pure mapping. Same shape as `honkerStateRows` — keep the wrapper +
 *  state mapper paired so unit tests can hit every branch. */
export function skillsPluginStateRows(state: SkillsPluginState): DoctorRow[] {
  switch (state.kind) {
    case "opted-out":
      return [
        {
          status: "info",
          label: "atmux-skills-plugin",
          detail:
            "user opted out via wizard (marker present at ~/.atmux/state/skills-plugin-opted-out)",
        },
      ];
    case "symlink-missing":
      return [
        {
          status: "yellow",
          label: "atmux-skills-plugin",
          detail: "skills plugin not installed at ~/.claude/plugins/atmux/",
          hint: "atmux init --skills-only  (or rerun the install wizard)",
        },
      ];
    case "plugin-json-missing":
      return [
        {
          status: "yellow",
          label: "atmux-skills-plugin",
          detail: `plugin.json missing at ${state.installPath}/.claude-plugin/plugin.json`,
          hint: "atmux init --skills-only --force  (re-installs the bundled plugin)",
        },
      ];
    case "plugin-json-malformed":
      return [
        {
          status: "yellow",
          label: "atmux-skills-plugin",
          detail: `plugin.json malformed at ${state.installPath} — ${state.reason}`,
          hint: "atmux init --skills-only --force  (overwrites with bundled manifest)",
        },
      ];
    case "plugin-json-schema-fail":
      return [
        {
          status: "yellow",
          label: "atmux-skills-plugin",
          detail: `plugin.json schema validation failed at ${state.installPath} — ${state.reason}`,
          hint: "atmux init --skills-only --force  (re-installs the bundled plugin)",
        },
      ];
    case "green":
      return [
        {
          status: "green",
          label: "atmux-skills-plugin",
          detail: `skills plugin installed at ${state.installPath} (plugin=${state.pluginName})`,
        },
      ];
  }
}

export interface CheckSkillsPluginOpts {
  /** Override $HOME for tests. */
  home?: string;
}

/** I/O wrapper. Resolves the install path under $HOME, probes for the
 *  opt-out marker first, then verifies the symlink + plugin.json. Returns
 *  the empty array when $HOME is unset (defensive — caller probably has
 *  bigger issues, no point emitting a doctor row about it). */
export async function checkSkillsPlugin(opts: CheckSkillsPluginOpts = {}): Promise<DoctorRow[]> {
  const home = opts.home ?? process.env.HOME;
  if (home === undefined || home.length === 0) return [];

  const optOutMarker = join(home, ".atmux", "state", "skills-plugin-opted-out");
  if (await exists(optOutMarker)) {
    return skillsPluginStateRows({ kind: "opted-out" });
  }

  // Canonical install path: real dir (operator dotfiles override) or
  // symlink to <atmux-source>/plugins/atmux/. Both count as "installed"
  // for the probe; the wizard step distinguishes for UX purposes.
  const installPath = join(home, ".claude", "plugins", "atmux");
  const st = await statOrNull(installPath);
  if (st === null || !st.isDirectory) {
    return skillsPluginStateRows({ kind: "symlink-missing" });
  }

  const manifestPath = join(installPath, ".claude-plugin", "plugin.json");
  const raw = await readTextOrNull(manifestPath);
  if (raw === null) {
    return skillsPluginStateRows({ kind: "plugin-json-missing", installPath });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return skillsPluginStateRows({
      kind: "plugin-json-malformed",
      installPath,
      reason: e instanceof Error ? e.message : String(e),
    });
  }
  // Minimal shape check on the keys the probe's green path depends on.
  // The Claude Code plugin-schema pin lives in the sibling integration
  // test (t-e57fe51e) — this probe stays cheap + tolerant of additive
  // schema fields so a CC schema bump doesn't flip every operator's row
  // yellow.
  if (parsed === null || typeof parsed !== "object") {
    return skillsPluginStateRows({
      kind: "plugin-json-schema-fail",
      installPath,
      reason: "manifest is not an object",
    });
  }
  const m = parsed as Record<string, unknown>;
  if (typeof m.name !== "string" || m.name.length === 0) {
    return skillsPluginStateRows({
      kind: "plugin-json-schema-fail",
      installPath,
      reason: "missing or empty 'name' field",
    });
  }
  if (!Array.isArray(m.skills)) {
    return skillsPluginStateRows({
      kind: "plugin-json-schema-fail",
      installPath,
      reason: "'skills' field is not an array",
    });
  }
  return skillsPluginStateRows({
    kind: "green",
    installPath,
    pluginName: m.name,
  });
}

// ---------- Check 7a: cursor-plugin-cache ----------
//
// Cursor-agent ignores Claude's runtime `--plugin-dir` flag and only
// discovers plugins it finds in `~/.claude/plugins/cache/<marketplace>/
// <plugin>/<version>/`. For marketplace entries whose source.type is
// `directory` (e.g. a user's own plugin tree at /root/work/.../plugins),
// `claude plugin install` registers the install in
// `installed_plugins.json` WITHOUT materialising the cache path — the
// source dir stays canonical. claude-side this is fine (claude resolves
// from the marketplace install location). cursor-side it means every
// claude plugin is invisible.
//
// This check emits a yellow row per missing cache entry, with a hint
// that produces the symlink directly. Only runs when `cursor-agent` is
// on PATH — otherwise the check is irrelevant and we stay silent.

export interface CheckCursorPluginCacheOpts {
  /** PATH lookup for `cursor-agent`. Test injection. */
  which?: (cmd: string) => string | null;
  /** Override $HOME for tests. */
  home?: string;
}

interface MissingCacheEntry {
  marketplace: string;
  plugin: string;
  version: string;
  /** Absolute path of the cache-dir symlink we'd create. */
  cachePath: string;
  /** Absolute path of the canonical plugin source — symlink target. */
  sourcePath: string;
}

export async function checkCursorPluginCache(
  opts: CheckCursorPluginCacheOpts = {},
): Promise<DoctorRow[]> {
  const whichFn = opts.which ?? ((cmd: string) => Bun.which(cmd));
  if (whichFn("cursor-agent") === null) return [];

  const home = opts.home ?? process.env.HOME;
  if (home === undefined || home.length === 0) return [];

  // Read both JSONs without zod — they're claude-side files we don't own
  // the schema for. Manual parse with permissive shape; fail-soft to [].
  const installedRaw = await readTextOrNull(
    join(home, ".claude", "plugins", "installed_plugins.json"),
  );
  if (installedRaw === null) return [];
  let installedJson: {
    plugins?: Record<string, ReadonlyArray<{ installPath: string; version: string }>>;
  };
  try {
    installedJson = JSON.parse(installedRaw);
  } catch {
    return [];
  }
  if (installedJson.plugins === undefined) return [];

  const marketplacesRaw = await readTextOrNull(
    join(home, ".claude", "plugins", "known_marketplaces.json"),
  );
  let marketplacesJson: Record<
    string,
    { source?: { source?: string }; installLocation?: string }
  > | null = null;
  if (marketplacesRaw !== null) {
    try {
      marketplacesJson = JSON.parse(marketplacesRaw);
    } catch {
      marketplacesJson = null;
    }
  }

  const missing: MissingCacheEntry[] = [];
  for (const [key, entries] of Object.entries(installedJson.plugins)) {
    // key format: `<plugin>@<marketplace>`
    const at = key.lastIndexOf("@");
    if (at === -1) continue;
    const plugin = key.slice(0, at);
    const marketplace = key.slice(at + 1);

    // Only auto-suggest for directory-source marketplaces — git/github
    // sources do materialise the cache themselves.
    const mInfo = marketplacesJson?.[marketplace];
    if (mInfo?.source?.source !== "directory") continue;
    const installLocation = mInfo.installLocation;
    if (installLocation === undefined || installLocation.length === 0) continue;
    // Marketplace convention: plugins live at <installLocation>/plugins/<plugin>.
    // Confirmed in marketplace.json `source: ./plugins/<plugin>`.
    const sourcePath = join(installLocation, "plugins", plugin);
    const srcStat = await statOrNull(sourcePath);
    if (srcStat === null) continue; // can't symlink to something missing

    for (const e of entries) {
      const expected = join(home, ".claude", "plugins", "cache", marketplace, plugin, e.version);
      const st = await statOrNull(expected);
      if (st !== null) continue;
      missing.push({
        marketplace,
        plugin,
        version: e.version,
        cachePath: expected,
        sourcePath,
      });
    }
  }

  return missing.map((m) => ({
    status: "yellow" as const,
    label: "cursor-plugin-cache",
    detail: `${m.plugin}@${m.marketplace} not materialised at ${m.cachePath} — cursor-agent can't discover it`,
    hint: `mkdir -p ${join(m.cachePath, "..")} && ln -sfn ${m.sourcePath} ${m.cachePath}`,
  }));
}
