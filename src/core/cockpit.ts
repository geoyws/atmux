// ADR-063: cockpit roster loader + topology helpers.
//
// Reads `~/.atmux/cockpit.json` (override `ATMUX_COCKPIT_CONFIG`).
// Provides cage socket / session-name resolvers used by both the
// cockpit verb and downstream consumers.
//
// Pure (path-resolution + parse only) — no tmux IO, no orchestration.
// Tests inject `env` + `home` to drive every branch.

import { join } from "node:path";
import { exists } from "../abstractions/fs.ts";
import { readJson } from "../abstractions/json.ts";
import { ConfigError } from "../errors.ts";
import { Cockpit, type Cockpit as CockpitShape, type CockpitTeam } from "../schema/cockpit.ts";

export interface LoadCockpitOpts {
  /** Environment hash. Defaults to `process.env`. Test injection point. */
  env?: NodeJS.ProcessEnv;
  /** Override config path. Wins over `env.ATMUX_COCKPIT_CONFIG` and the
   *  `$HOME/.atmux/cockpit.json` default. */
  path?: string;
  /** Home dir override (test injection — avoids touching `$HOME`). */
  home?: string;
}

/** Default cockpit config path: `<home>/.atmux/cockpit.json`. */
export function defaultCockpitConfigPath(home: string): string {
  return join(home, ".atmux", "cockpit.json");
}

/** Resolve the cockpit config path. Order: opts.path → env → default. */
export function resolveCockpitConfigPath(opts: LoadCockpitOpts = {}): string {
  if (opts.path !== undefined && opts.path.length > 0) return opts.path;
  const env = opts.env ?? process.env;
  const fromEnv = env.ATMUX_COCKPIT_CONFIG;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const home = opts.home ?? env.HOME;
  if (home === undefined || home.length === 0) {
    throw new ConfigError({
      what: "cannot resolve cockpit config path: HOME unset and no --config / ATMUX_COCKPIT_CONFIG override",
      hint: "set $HOME or pass --config <path>",
    });
  }
  return defaultCockpitConfigPath(home);
}

/** Load + parse `cockpit.json`. Throws ConfigError with seed snippet on
 *  absence; SchemaError on parse failure. */
export async function loadCockpit(opts: LoadCockpitOpts = {}): Promise<CockpitShape> {
  const path = resolveCockpitConfigPath(opts);
  if (!(await exists(path))) {
    throw new ConfigError({
      what: `no cockpit config at ${path}`,
      hint: `seed it with a roster like:\n  {\n    "cockpitSession": "atmux_teams",\n    "teams": [\n      { "name": "<team>", "root": "/abs/path/to/project", "enabled": true }\n    ]\n  }`,
    });
  }
  return await readJson(path, Cockpit);
}

/** Return only the enabled teams in declared order. */
export function enabledTeams(cockpit: CockpitShape): CockpitTeam[] {
  return cockpit.teams.filter((t) => t.enabled);
}

// ---------- Topology helpers ----------
//
// Cage socket + session-name conventions live HERE (not duplicated in
// the verb), so future changes (e.g. a different per-team-cage path) flip
// in one place.

/** Cage socket absolute path: `/tmp/atmux-<team>/sock`. Mirrors
 *  `core/common.ts::getDefaultSocket` — kept as a separate helper so
 *  cockpit topology can diverge from `atmux start`'s default later
 *  without churning unrelated callsites. */
export function cageSocketPath(teamName: string): string {
  return `/tmp/atmux-${teamName}/sock`;
}

/** Cage tmux session name. Special-case: the `atmux` team itself uses a
 *  bare `atmux` session (it's the canonical one); every other team uses
 *  `atmux_<name>`. Matches the historical bash convention so existing
 *  cockpit windows + `atmux attach` flows keep working. */
export function cageSessionName(teamName: string): string {
  return teamName === "atmux" ? "atmux" : `atmux_${teamName}`;
}
