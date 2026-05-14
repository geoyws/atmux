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
  // ADR-089 §Decision-anchor #4: validate operator-supplied prefixChain
  // (length ≥ MAX_NESTING_LEVEL + uniqueness) at load time. Failing here
  // is preferable to a runtime KeyError when resolvePrefix is called
  // from a deeply-nested cage and the chain doesn't reach that level.
  if (parsed.prefixChain !== undefined) {
    const v = validatePrefixChain(parsed.prefixChain);
    if (!v.ok) {
      throw new ConfigError({
        what: `cockpit.json at ${path}: invalid prefixChain — ${v.reason ?? "unknown"}`,
      });
    }
  }
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

// ---------- ADR-089 §C: F-key prefix chain + ATMUX_NESTING_LEVEL ----------

/** Default F-key prefix chain. Twelve entries (F1..F12) cover every
 *  level the schema's max-depth cap (6) allows plus headroom for any
 *  future super-cockpit / multi-epic chains. Operator override via
 *  `cockpit.prefixChain` flips the whole chain (per-level overrides
 *  are out of scope per ADR-089 §C). */
export const DEFAULT_PREFIX_CHAIN: ReadonlyArray<string> = [
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
];

/** ADR-089 §Decision-anchor #6 — max nesting depth cockpit.json may
 *  declare. Computed as L1-L4 reserved (cockpit + team + epic-team +
 *  one chain step) + 2 headroom. Used by validatePrefixChain (the
 *  chain must be long enough to assign a prefix per level) and by
 *  loadCockpit's depth check. */
export const MAX_NESTING_LEVEL = 6;

/** ADR-089 §D — env-var name carrying the cage's own nesting level.
 *  Centralised constant so callers don't drift on the spelling. */
export const ATMUX_NESTING_LEVEL_ENV = "ATMUX_NESTING_LEVEL";

/**
 * ADR-089 §D — read the nesting level from `env`. Missing /
 * malformed / non-positive values fall back to **1** (top-level
 * operation; cockpit / standalone `atmux start` case). 1-indexed
 * for human readability — L1 = outermost cage.
 *
 * Pure. Exported for direct unit-testing.
 */
export function readNestingLevel(env: NodeJS.ProcessEnv): number {
  const raw = env[ATMUX_NESTING_LEVEL_ENV];
  if (raw === undefined || raw === "") return 1;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}

/**
 * ADR-089 §C — resolve the tmux prefix for a given nesting level
 * from the (optional) operator-supplied chain, falling back to the
 * default F-key chain. Level is 1-indexed; an out-of-range level
 * (level > chain.length) is treated as a logic error from the
 * caller — throws `ConfigError` to fail loud rather than silently
 * collapsing to a possibly-colliding prefix.
 *
 * Pure. Validation of the chain itself (length + uniqueness) lives
 * in `validatePrefixChain` and is invoked once at `loadCockpit` time
 * so callers can rely on a pre-validated chain when calling this.
 */
export function resolvePrefix(level: number, chain?: ReadonlyArray<string>): string {
  const effective = chain !== undefined && chain.length > 0 ? chain : DEFAULT_PREFIX_CHAIN;
  if (!Number.isInteger(level) || level < 1) {
    throw new ConfigError({
      what: `resolvePrefix: level must be a positive integer, got ${level}`,
    });
  }
  if (level > effective.length) {
    throw new ConfigError({
      what: `resolvePrefix: level ${level} exceeds prefix chain length ${effective.length}`,
      hint: `add more entries to cockpit.prefixChain or reduce nesting depth (max ${MAX_NESTING_LEVEL})`,
    });
  }
  return effective[level - 1] as string;
}

/** Result of `validatePrefixChain`. `ok: false` carries a `reason`
 *  string suitable for direct surfacing in a `ConfigError`. */
export interface PrefixChainValidation {
  ok: boolean;
  reason?: string;
}

/**
 * ADR-089 §Decision-anchor #4 — validate a prefix chain at
 * `loadCockpit` time:
 *   1. Length MUST be ≥ {@link MAX_NESTING_LEVEL} so every reachable
 *      level has a slot.
 *   2. Entries MUST be unique. Duplicates collide: `["F1","F2","F2"]`
 *      means child + grand-child cages both bind `F2`, and tmux can't
 *      route the prefix unambiguously.
 *   3. Entries MUST be non-empty strings.
 *
 * Pure — no IO. Loader uses this once at parse time then trusts the
 * chain everywhere downstream.
 */
export function validatePrefixChain(chain: ReadonlyArray<string>): PrefixChainValidation {
  if (chain.length < MAX_NESTING_LEVEL) {
    return {
      ok: false,
      reason:
        `prefixChain has ${chain.length} entries but must have ≥${MAX_NESTING_LEVEL} ` +
        `(one per level up to the max-depth cap). Add ${MAX_NESTING_LEVEL - chain.length} ` +
        `more entries or omit the field to use the default F-key chain.`,
    };
  }
  for (let i = 0; i < chain.length; i += 1) {
    const entry = chain[i];
    if (typeof entry !== "string" || entry.length === 0) {
      return {
        ok: false,
        reason: `prefixChain[${i}] is empty or non-string — every entry must be a tmux key spec like "F1" or "C-q"`,
      };
    }
  }
  const seen = new Set<string>();
  for (let i = 0; i < chain.length; i += 1) {
    const entry = chain[i] as string;
    if (seen.has(entry)) {
      return {
        ok: false,
        reason:
          `prefixChain[${i}] = "${entry}" is duplicated — every entry must be unique so ` +
          `nested cages bind orthogonal prefixes (a duplicate would collide between levels).`,
      };
    }
    seen.add(entry);
  }
  return { ok: true };
}

/**
 * ADR-089 §Decision-anchor #5 — build the env mutations a parent
 * cage applies when spawning a child cage. Returns a plain object
 * suitable for spread onto `process.env` clones (or passed to a
 * spawner that takes `env`). The contract is:
 *
 *   1. UNSET inherited `ATMUX_NESTING_LEVEL` (callers spread
 *      `{ [ATMUX_NESTING_LEVEL_ENV]: undefined }` and remove the key).
 *   2. SET own level = `parentLevel + 1`.
 *
 * Concretely the return value contains the SET step; the UNSET step
 * is "delete the key from the cloned env before spread". Callers
 * compose like:
 *
 *   const childEnv = { ...parentEnv };
 *   delete childEnv[ATMUX_NESTING_LEVEL_ENV];
 *   Object.assign(childEnv, childNestingEnv(parentLevel));
 *
 * Pure helper — no IO. Exported for direct unit-testing of the
 * contract.
 */
export function childNestingEnv(parentLevel: number): Record<string, string> {
  if (!Number.isInteger(parentLevel) || parentLevel < 1) {
    throw new ConfigError({
      what: `childNestingEnv: parentLevel must be a positive integer, got ${parentLevel}`,
    });
  }
  const childLevel = parentLevel + 1;
  if (childLevel > MAX_NESTING_LEVEL) {
    throw new ConfigError({
      what: `childNestingEnv: would exceed max depth ${MAX_NESTING_LEVEL} (parent=${parentLevel}, child=${childLevel})`,
      hint: "reduce the nesting depth in cockpit.json",
    });
  }
  return { [ATMUX_NESTING_LEVEL_ENV]: String(childLevel) };
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
