// ADR-063 (legacy) + ADR-089 (recursive sessions[]) — cockpit roster
// loader + topology helpers.
//
// Reads `~/.atmux/cockpit.json` (override `ATMUX_COCKPIT_CONFIG`).
// Provides cage socket / session-name resolvers used by both the
// cockpit verb and downstream consumers.
//
// Pure (path-resolution + parse only) — no tmux IO, no orchestration.
// Tests inject `env` + `home` to drive every branch.

import { join } from "node:path";
import { z } from "zod";
import { exists } from "../abstractions/fs.ts";
import { readJson } from "../abstractions/json.ts";
import { ConfigError } from "../errors.ts";
import {
  Cockpit,
  type Cockpit as CockpitShape,
  type CockpitSessionT,
  type CockpitSuperdoctor,
  type CockpitTeam,
  type TeamSessionT,
} from "../schema/cockpit.ts";
import type { Team as TeamShape } from "../schema/team.ts";
import { getDefaultSocket, loadTeam, resolveTeamSocket } from "./common.ts";

/** Output of `loadCockpit` — same as `Cockpit` but with the legacy
 *  back-compat fields (`teams`, `superdoctor`) narrowed: `teams` is
 *  always populated by `enrichLegacyFields`, and `superdoctor` is
 *  populated when at least one `type: "superdoctor"` entry exists. */
export type LoadedCockpit = CockpitShape & { teams: CockpitTeam[] };

export interface LoadCockpitOpts {
  /** Environment hash. Defaults to `process.env`. Test injection point. */
  env?: NodeJS.ProcessEnv;
  /** Override config path. Wins over `env.ATMUX_COCKPIT_CONFIG` and the
   *  `$HOME/.atmux/cockpit.json` default. */
  path?: string;
  /** Home dir override (test injection — avoids touching `$HOME`). */
  home?: string;
  /** Test seam for migration-shim deprecation warnings. Defaults to
   *  `process.stderr.write` — tests inject a buffer to assert the warn
   *  fires (and only fires for legacy shapes). */
  warn?: (msg: string) => void;
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
 *  absence; SchemaError on parse failure.
 *
 *  ADR-089 §B migration shim: when the on-disk file has flat `teams[]`
 *  (no `sessions[]` / `schemaVersion`), `migrateLegacyShape` lifts it
 *  into the new recursive form before validation. A `stderr` WARN line
 *  fires so operators see the deprecation while their existing rosters
 *  keep loading.
 *
 *  Post-parse, legacy back-compat fields (`teams`, `superdoctor`) are
 *  synthesized from `sessions[]` via DFS — duck-typed consumers in
 *  audit.ts / cockpit verb / status verb keep working without per-call
 *  migration.
 */
export async function loadCockpit(opts: LoadCockpitOpts = {}): Promise<LoadedCockpit> {
  const path = resolveCockpitConfigPath(opts);
  if (!(await exists(path))) {
    throw new ConfigError({
      what: `no cockpit config at ${path}`,
      hint: `seed it with a roster like:\n  {\n    "schemaVersion": 1,\n    "cockpitSession": "atmux_teams",\n    "sessions": [\n      { "type": "team", "name": "<team>", "root": "/abs/path/to/project" }\n    ]\n  }`,
    });
  }
  // Read raw first so the migration shim can inspect the on-disk shape
  // before Zod validation. `z.unknown()` always succeeds; it's a typed
  // raw read that honours the `JSON.parse`-only-in-abstractions/json.ts
  // invariant (R3 per ADR-006).
  const raw = await readJson(path, z.unknown());
  const warn = opts.warn ?? ((msg: string) => process.stderr.write(msg));
  const migrated = migrateLegacyShape(raw, path, warn);
  const parsed = Cockpit.parse(migrated);
  return enrichLegacyFields(parsed);
}

/**
 * ADR-089 §B: detect a legacy flat-`teams[]` cockpit.json and lift it
 * into the new recursive `sessions[]` shape. Idempotent on inputs that
 * already use `sessions[]` — returns them unchanged.
 *
 * Heuristic: presence of `teams[]` on the top-level AND absence of
 * `sessions[]`. A file with both is treated as already-migrated (the
 * post-parse enrichment will overwrite legacy `teams[]` anyway).
 *
 * Warning fires once per load — operators see it during cron ticks /
 * cockpit rebuilds; not aborting because rosters in the wild are
 * operator-managed and may not migrate same-day.
 */
export function migrateLegacyShape(
  raw: unknown,
  path: string,
  warn: (msg: string) => void,
): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj.sessions)) return obj;
  if (!Array.isArray(obj.teams)) return obj;
  warn(
    `atmux: cockpit.json at ${path} uses legacy flat teams[] — auto-lifting ` +
      `to sessions[] (ADR-089). Migrate by setting "schemaVersion": 1 and ` +
      `converting teams[] entries to { "type": "team", ... } under "sessions[]".\n`,
  );
  const sessions: unknown[] = [];
  for (const t of obj.teams) {
    if (typeof t !== "object" || t === null) continue;
    sessions.push({ ...(t as Record<string, unknown>), type: "team" });
  }
  // Legacy singleton superdoctor lifts into sessions[] as its own
  // discriminated entry. Operator's original `enabled: false` carries
  // through; the loader's enrichLegacyFields step also re-surfaces the
  // singleton field for callers reading `cockpit.superdoctor`.
  const sd = obj.superdoctor;
  if (typeof sd === "object" && sd !== null) {
    const sdObj = sd as Record<string, unknown>;
    sessions.push({
      ...sdObj,
      type: "superdoctor",
      name: typeof sdObj.name === "string" ? sdObj.name : "superdoctor",
    });
  }
  // Strip the legacy keys so the new-shape parse doesn't see them — the
  // enrichment pass adds them back from sessions[] post-validation.
  const { teams: _t, superdoctor: _s, ...rest } = obj;
  void _t;
  void _s;
  return { ...rest, schemaVersion: 1, sessions };
}

/**
 * Post-parse synthesis of legacy back-compat fields. Walks `sessions[]`
 * DFS and populates `teams: CockpitTeam[]` (type==="team" entries) +
 * `superdoctor: CockpitSuperdoctor` (first type==="superdoctor" entry).
 * Existing duck-typed consumers in audit.ts / status.ts / verbs/cockpit.ts
 * read these synthesized fields unchanged.
 */
function enrichLegacyFields(cockpit: CockpitShape): LoadedCockpit {
  const teams: CockpitTeam[] = [];
  let superdoctor: CockpitSuperdoctor | undefined;
  walkSessions(cockpit.sessions ?? [], 0, (node) => {
    if (node.type === "team") {
      const t: CockpitTeam = {
        name: node.name,
        root: node.root,
        enabled: node.enabled,
      };
      if (node.claudeAccount !== undefined) t.claudeAccount = node.claudeAccount;
      if (node.tuiOverrides !== undefined) t.tuiOverrides = node.tuiOverrides;
      teams.push(t);
    } else if (node.type === "superdoctor" && superdoctor === undefined) {
      const s: CockpitSuperdoctor = { enabled: node.enabled };
      if (node.claudeAccount !== undefined) s.claudeAccount = node.claudeAccount;
      if (node.tuiOverrides !== undefined) s.tuiOverrides = node.tuiOverrides;
      if (node.autoStart !== undefined) s.autoStart = node.autoStart;
      if (node.autoStartTimeoutSec !== undefined) {
        s.autoStartTimeoutSec = node.autoStartTimeoutSec;
      }
      superdoctor = s;
    }
  });
  return { ...cockpit, teams, ...(superdoctor !== undefined ? { superdoctor } : {}) };
}

/** A flattened team entry — one row per `type: "team"` or `epic-team"`
 *  session in DFS order, annotated with its nesting `level`. Used by
 *  ADR-089 T5 (prefix-chain) consumers to derive per-node prefix keys.
 *
 *  Shape-compatible with legacy `CockpitTeam` for `name` / `root` /
 *  `enabled` access — existing callers iterate without type changes.
 *  `level=0` is the top-level sessions[] (root of the tree); each
 *  nested step adds 1. */
export interface FlattenedTeamEntry {
  type: "team" | "epic-team";
  name: string;
  enabled: boolean;
  /** Present on `team`; for `epic-team` the parent team's root is
   *  inherited at runtime (epic-teams share parent's worktree per
   *  ADR-089). The synthesized value here mirrors the parent for legacy
   *  duck-typed consumers; resolved by the flattener walk. */
  root: string;
  level: number;
  parent?: string;
  epicId?: string;
  claudeAccount?: TeamSessionT["claudeAccount"];
  tuiOverrides?: TeamSessionT["tuiOverrides"];
}

/** Depth-first flattener — ADR-089 §F + T5 prep. Returns enabled
 *  team-shaped entries (both `type: "team"` and `type: "epic-team"`)
 *  with their nesting `level` annotated. `superdriver` /
 *  `superdoctor` entries are excluded — they're cockpit-internal
 *  singletons, not iterable "teams" in the legacy sense.
 *
 *  Legacy callers iterating `enabledTeams(cockpit)` keep working
 *  because the returned shape exposes `.name` / `.root` / `.enabled`
 *  (duck-typed). `.level` is additive for new consumers. */
export function enabledTeams(cockpit: CockpitShape): FlattenedTeamEntry[] {
  const out: FlattenedTeamEntry[] = [];
  walkSessions(cockpit.sessions ?? [], 0, (node, level, parentRoot) => {
    if (node.type === "team" && node.enabled) {
      const e: FlattenedTeamEntry = {
        type: "team",
        name: node.name,
        enabled: node.enabled,
        root: node.root,
        level,
      };
      if (node.claudeAccount !== undefined) e.claudeAccount = node.claudeAccount;
      if (node.tuiOverrides !== undefined) e.tuiOverrides = node.tuiOverrides;
      out.push(e);
    } else if (node.type === "epic-team" && node.enabled) {
      const e: FlattenedTeamEntry = {
        type: "epic-team",
        name: node.name,
        enabled: node.enabled,
        // Epic-teams share parent's worktree; the walker threads
        // `parentRoot` so duck-typed `.root` access keeps resolving.
        root: parentRoot ?? "",
        level,
        parent: node.parent,
        epicId: node.epicId,
      };
      if (node.claudeAccount !== undefined) e.claudeAccount = node.claudeAccount;
      if (node.tuiOverrides !== undefined) e.tuiOverrides = node.tuiOverrides;
      out.push(e);
    }
  });
  return out;
}

/** DFS walk over `sessions[]`. Visitor receives each node + its level +
 *  the nearest ancestor `team.root` (for epic-teams that share a parent
 *  worktree). Public for ADR-089 T5/T6 consumers needing custom walks;
 *  the flattener + enrichment paths use it internally. */
export function walkSessions(
  sessions: ReadonlyArray<CockpitSessionT>,
  level: number,
  visit: (node: CockpitSessionT, level: number, parentRoot: string | undefined) => void,
  parentRoot?: string,
): void {
  for (const node of sessions) {
    visit(node, level, parentRoot);
    if (node.type === "team" || node.type === "epic-team") {
      const childRoot = node.type === "team" ? node.root : parentRoot;
      if (Array.isArray(node.sessions) && node.sessions.length > 0) {
        walkSessions(node.sessions, level + 1, visit, childRoot);
      }
    }
  }
}

// ---------- Topology helpers ----------
//
// Cage socket + session-name conventions live HERE (not duplicated in
// the verb), so future changes (e.g. a different per-team-cage path) flip
// in one place.

/** Options for {@link resolveCageSocket} — DI seams for tests. */
export interface ResolveCageSocketOpts {
  /** Override `loadTeam` (test injection). Default reads
   *  `<cockpitTeam.root>/.atmux/team.json`. */
  loadTeam?: (opts: { teamDir: string }) => Promise<TeamShape>;
  /** Override `process.getuid()` (test injection — controls the
   *  `tmux-<uid>` segment of the `tmuxTmpdir`-derived path). */
  uid?: number;
}

/**
 * Resolve a cockpit roster team's live cage tmux socket. Async because
 * the answer depends on the team's `team.json::tmuxTmpdir`:
 *   - When `tmuxTmpdir` is set, the socket lives at
 *     `<tmuxTmpdir>/tmux-<uid>/default` (the standard tmux short-name
 *     shape — tmux uses `TMUX_TMPDIR` to build its own path).
 *   - Otherwise, falls back to the canonical `/tmp/atmux-<team>/sock`.
 *
 * Delegates to {@link resolveTeamSocket} (core/common.ts) so this is the
 * single source of truth for "where does this team's cage socket live"
 * — cockpit / doctor / status verbs route through here. Bug class fixed
 * by t-b5864443: the pre-fix cockpit hardcoded `/tmp/atmux-<team>/sock`,
 * which reported a live cage as `launched=0 skipped=0` whenever a team
 * declared a project-local tmpdir (repro on the atmux dogfood team on
 * 2026-05-13).
 *
 * On loadTeam failure (missing / unreadable / malformed `team.json`),
 * falls back to the canonical path so the cockpit rebuild stays green
 * even when a member team is misconfigured — mirrors
 * `resolveTeamWindowMode`'s safe-fallback posture (no throw).
 */
export async function resolveCageSocket(
  cockpitTeam: Pick<CockpitTeam, "name" | "root">,
  opts: ResolveCageSocketOpts = {},
): Promise<string> {
  const loader = opts.loadTeam ?? loadTeam;
  try {
    const teamShape = await loader({ teamDir: cockpitTeam.root });
    return resolveTeamSocket(
      teamShape,
      opts.uid !== undefined ? { uid: opts.uid } : {},
    );
  } catch {
    return getDefaultSocket(cockpitTeam.name);
  }
}

/** Cage tmux session name. Special-case: the `atmux` team itself uses a
 *  bare `atmux` session (it's the canonical one); every other team uses
 *  `atmux_<name>`. Matches the historical bash convention so existing
 *  cockpit windows + `atmux attach` flows keep working. */
export function cageSessionName(teamName: string): string {
  return teamName === "atmux" ? "atmux" : `atmux_${teamName}`;
}
