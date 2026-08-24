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
import { exists, readTextOrNull } from "../abstractions/fs.ts";
import { readJson } from "../abstractions/json.ts";
import { ConfigError, SchemaError } from "../errors.ts";
import {
  Cockpit,
  type CockpitMedic,
  type CockpitSessionT,
  type Cockpit as CockpitShape,
  type CockpitTeam,
  type TeamSessionT,
} from "../schema/cockpit.ts";
import { sessionAnchorPath } from "./common.ts";

/** Output of `loadCockpit` — same as `Cockpit` but with the legacy
 *  back-compat fields (`teams`, `medic`)
 *  narrowed: `teams` is always populated by `enrichLegacyFields`;
 *  `medic` is populated when a top-level `medic` block OR at least one
 *  `type: "medic"` entry exists. */
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
 *  Post-parse, the legacy back-compat field `teams` is synthesized from
 *  `sessions[]` via DFS (and `medic` resolved from the top-level block
 *  or a `type: "medic"` session entry) — duck-typed consumers in
 *  audit.ts / cockpit verb / status verb keep working without per-call
 *  migration.
 */
export async function loadCockpit(opts: LoadCockpitOpts = {}): Promise<LoadedCockpit> {
  const path = resolveCockpitConfigPath(opts);
  if (!(await exists(path))) {
    throw new ConfigError({
      what: `no cockpit config at ${path}`,
      hint: `seed it with a roster like:\n  {\n    "schemaVersion": 1,\n    "cockpitSession": "atx",\n    "sessions": [\n      { "type": "team", "name": "<team>", "root": "/abs/path/to/project" }\n    ]\n  }`,
    });
  }
  // Read raw first so the migration shims can inspect the on-disk
  // shape before Zod validation. `z.unknown()` always succeeds; it's a
  // typed raw read that honours the `JSON.parse`-only-in-abstractions/
  // json.ts invariant (R3 per ADR-006). Steps run in order:
  //   1. `rejectSuperdoctorConfig` — ADR-266 §D2: the ADR-133
  //      superdoctor→medic shims expired; any `superdoctor` block
  //      (top-level key, legacy flat-block, or sessions[] entry) is a
  //      hard, actionable error.
  //   2. `migrateLegacyShape` — ADR-089 §B flat `teams[]` → recursive
  //      `sessions[]`.
  // Explicit `cockpitSession` values are authoritative per ADR-279. New
  // configs still default to `atx` in the schema, but loading an operator's
  // persisted literal must never rename a live session as a side effect of a
  // later reconcile.
  const raw = await readJson(path, z.unknown());
  const warn = opts.warn ?? ((msg: string) => process.stderr.write(msg));
  rejectSuperdoctorConfig(raw, path);
  const migrated = migrateLegacyShape(raw, path, warn);
  // ADR-005 boundary uniformity: Zod errors at the loadCockpit boundary
  // wrap as SchemaError so catch-by-tag callers (and the JSDoc contract
  // above — "SchemaError on parse failure") observe the same error
  // class as every other readJson-style boundary. Bare `Cockpit.parse`
  // throws Zod's native error class; that bypasses the wrap and breaks
  // both the JSDoc contract + 4+ existing tests asserting `SchemaError`.
  const result = Cockpit.safeParse(migrated);
  if (!result.success) {
    throw new SchemaError({
      file: path,
      issues: result.error.issues,
      cause: result.error,
    });
  }
  const parsed = result.data;
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
  validateOperatorWindowNames(parsed);
  return enrichLegacyFields(parsed);
}

/** ADR-279: operator windows share the cockpit tmux namespace with role
 * windows and team viewers, so every name must be globally unambiguous. */
function validateOperatorWindowNames(cockpit: CockpitShape): void {
  const occupied = new Set(["_superdriver", "superdriver", "_medic", "medic", "superdoctor"]);
  walkSessions(cockpit.sessions ?? [], 0, (node) => {
    if (node.type === "team" || node.type === "epic-team") occupied.add(node.name);
  });
  const seen = new Set<string>();
  for (const window of cockpit.windows) {
    if (occupied.has(window.name)) {
      throw new ConfigError({
        what: `cockpit operator window '${window.name}' conflicts with a reserved role or team name`,
        hint: "choose a unique windows[].name; operator workspaces and team viewers share one tmux session",
      });
    }
    if (seen.has(window.name)) {
      throw new ConfigError({
        what: `cockpit operator window '${window.name}' is declared more than once`,
        hint: "keep exactly one windows[] entry for each cockpit window name",
      });
    }
    seen.add(window.name);
  }
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
  // Legacy singleton medic block lifts into sessions[] as its own
  // discriminated entry. The operator's original `enabled: false`
  // carries through; the loader's enrichLegacyFields step also
  // re-surfaces the singleton field for callers reading `cockpit.medic`.
  // A legacy `superdoctor` block never reaches here — loadCockpit's
  // `rejectSuperdoctorConfig` step (ADR-266 §D2) hard-fails on it first;
  // the destructure below just keeps the key out of the lifted shape.
  const medicBlock = obj.medic;
  if (typeof medicBlock === "object" && medicBlock !== null) {
    const mObj = medicBlock as Record<string, unknown>;
    sessions.push({
      ...mObj,
      type: "medic",
      name: typeof mObj.name === "string" ? mObj.name : "medic",
    });
  }
  // Strip the legacy keys so the new-shape parse doesn't see them — the
  // enrichment pass adds them back from sessions[] post-validation.
  const { teams: _t, superdoctor: _s, medic: _m, ...rest } = obj;
  void _t;
  void _s;
  void _m;
  return { ...rest, schemaVersion: 1, sessions };
}

/**
 * ADR-266 §D2 (replaces the ADR-133 TR2 `migrateSuperdoctorBlockToMedic`
 * shim, whose "accepting this release; will fail next release" contract
 * expired ~25 releases ago): hard-fail any cockpit.json that still
 * carries a `superdoctor` block — as a top-level key (either shape) OR
 * as a `type: "superdoctor"` entry anywhere in `sessions[]`. The error
 * is actionable: rename the block to `medic`.
 */
export function rejectSuperdoctorConfig(raw: unknown, path: string): void {
  if (typeof raw !== "object" || raw === null) return;
  const obj = raw as Record<string, unknown>;
  if (obj.superdoctor !== undefined) {
    throw new ConfigError({
      what: `cockpit.json at ${path} still carries a 'superdoctor' block — the ADR-133 rename window expired and the legacy key was removed per ADR-266 §D2`,
      hint: `rename the top-level 'superdoctor' block to 'medic' in ${path} (same fields; naming-only per ADR-133)`,
    });
  }
  const check = (sessions: unknown): boolean => {
    if (!Array.isArray(sessions)) return false;
    for (const s of sessions) {
      if (typeof s !== "object" || s === null) continue;
      const o = s as Record<string, unknown>;
      if (o.type === "superdoctor") return true;
      if (check(o.sessions)) return true;
    }
    return false;
  };
  if (check(obj.sessions)) {
    throw new ConfigError({
      what: `cockpit.json at ${path} has a sessions[] entry with type "superdoctor" — the ADR-133 rename window expired and the legacy discriminator was removed per ADR-266 §D2`,
      hint: `change the entry's "type" to "medic" in ${path} (same fields; naming-only per ADR-133)`,
    });
  }
}

/**
 * Post-parse synthesis of legacy back-compat fields. Walks `sessions[]`
 * DFS and populates `teams: CockpitTeam[]` (type==="team" entries) +
 * resolves `medic: CockpitMedic` (top-level `medic` block wins; else
 * the first `type: "medic"` entry). Existing duck-typed consumers in
 * audit.ts / status.ts / verbs/cockpit.ts read these synthesized fields
 * unchanged.
 *
 * ADR-266 §D2: the legacy `superdoctor` synthesis was removed with the
 * ADR-133 shims — `type: "superdoctor"` entries no longer parse (the
 * schema rejects them) and `rejectSuperdoctorConfig` hard-fails on the
 * legacy key before parse.
 */
function enrichLegacyFields(cockpit: CockpitShape): LoadedCockpit {
  const teams: CockpitTeam[] = [];
  // ADR-133: medic is the canonical singleton. First `type: "medic"`
  // session entry wins when no top-level block is declared.
  let medicResolved: CockpitMedic | undefined;
  walkSessions(cockpit.sessions ?? [], 0, (node) => {
    if (node.type === "team") {
      const t: CockpitTeam = {
        name: node.name,
        root: node.root,
        enabled: node.enabled,
      };
      if (node.claudeAccount !== undefined) t.claudeAccount = node.claudeAccount;
      if (node.tuiOverrides !== undefined) t.tuiOverrides = node.tuiOverrides;
      // t-72a6b7d7: propagate operator-intent flag to the synthesized
      // legacy roster so duck-typed consumers (medic sweep) see it
      // without walking `sessions[]`.
      if (node.cageMode !== undefined) t.cageMode = node.cageMode;
      teams.push(t);
    } else if (node.type === "medic" && medicResolved === undefined) {
      // ADR-133 canonical entry. Preserve the full claude shape
      // (autoStart + autoStartTimeoutSec retained per trunk's shipped
      // fields — the reconcile-side auto-start check reads them).
      const m: CockpitMedic = { enabled: node.enabled };
      if (node.claudeAccount !== undefined) m.claudeAccount = node.claudeAccount;
      if (node.tuiOverrides !== undefined) m.tuiOverrides = node.tuiOverrides;
      if (node.autoStart !== undefined) m.autoStart = node.autoStart;
      if (node.autoStartTimeoutSec !== undefined) {
        m.autoStartTimeoutSec = node.autoStartTimeoutSec;
      }
      medicResolved = m;
    }
  });
  // When the operator declared a top-level `medic` block, it wins over
  // any session-walk synthesis.
  const medic: CockpitMedic | undefined = cockpit.medic ?? medicResolved;
  return {
    ...cockpit,
    teams,
    ...(medic !== undefined ? { medic } : {}),
  };
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
 *  `superdoctor` / `medic` entries are excluded —
 *  they're cockpit-internal singletons, not iterable "teams" in the
 *  legacy sense.
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

// ---------- ADR-092: cross-team tell-lead lookup + caller-scope gate ----------

/** Result of `findTeamByName` — narrowed view of the matched cockpit
 *  node. Only `team` / `epic-team` nodes match (other session types
 *  don't host a backing team cage). `root` resolves to the node's own
 *  root for `type: "team"` and to the nearest ancestor `team.root` for
 *  `type: "epic-team"` (epic-teams share parent's worktree per ADR-089
 *  §F). Per ADR-092 §D2 Decision-anchor #2 — first match wins on name
 *  collision; cockpit-validation flags dupes at load time. */
export interface CockpitTeamLookup {
  type: "team" | "epic-team";
  name: string;
  root: string;
  level: number;
  /** Populated for `type: "epic-team"` — references the parent team
   *  name; consumers (caller-scope gate) join on this to drive the
   *  parent ↔ child policy table. */
  parent?: string;
}

/** ADR-092 §D2 — depth-first match on `node.name` across `cockpit.sessions[]`.
 *  Returns the first matching `team` / `epic-team` node, or `null` when
 *  no match. Pure (no IO); reuses {@link walkSessions} for the DFS walk
 *  so traversal-order matches every other cockpit consumer (`enabledTeams`
 *  / synthesis paths). */
export function findTeamByName(cockpit: CockpitShape, name: string): CockpitTeamLookup | null {
  let found: CockpitTeamLookup | null = null;
  walkSessions(cockpit.sessions ?? [], 0, (node, level, parentRoot) => {
    if (found !== null) return;
    if (node.type !== "team" && node.type !== "epic-team") return;
    if (node.name !== name) return;
    const out: CockpitTeamLookup = {
      type: node.type,
      name: node.name,
      root: node.type === "team" ? node.root : (parentRoot ?? ""),
      level,
    };
    if (node.type === "epic-team") out.parent = node.parent;
    found = out;
  });
  return found;
}

/** ADR-092 §D3 — symmetric caller-scope gate. Allowed transitions:
 *
 *   1. `ATMUX_CALLER_SCOPE === "driver"` — master override (cockpit
 *      driver pane). Always allowed.
 *   2. `sourceName === targetName` — degenerate same-team case; allowed
 *      (no cross-team boundary crossed).
 *   3. Source is `epic-team` with `parent === targetName` — child → parent.
 *   4. Target is `epic-team` with `parent === sourceName` — parent → child.
 *
 *  Everything else (siblings, unrelated teams) refuses. Refusal in
 *  caller responsibility — this function returns the boolean; the
 *  verb wraps refusal in a ConfigError with both names per D6
 *  Decision-anchor #5.
 *
 *  Pure (no IO). Unknown source/target names (not present in cockpit)
 *  fall through to `false` — the caller's lookup will fail first with
 *  a clearer message, but the gate's conservative posture is
 *  refuse-on-unknown rather than allow-by-default. */
export function callerScopeAllowed(
  cockpit: CockpitShape,
  sourceName: string,
  targetName: string,
  callerScope: string | undefined,
): boolean {
  if (callerScope === "driver") return true;
  if (sourceName === targetName) return true;
  const src = findTeamByName(cockpit, sourceName);
  const tgt = findTeamByName(cockpit, targetName);
  if (src === null || tgt === null) return false;
  if (src.type === "epic-team" && src.parent === tgt.name) return true;
  if (tgt.type === "epic-team" && tgt.parent === src.name) return true;
  return false;
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
 * malformed / non-positive values fall back to **2** (standalone
 * `atmux start` invokes a top-level team cage, which per ADR-089
 * §C is L2 — the cockpit itself is L1). 1-indexed for human
 * readability per the §C table: L1 = Cockpit, L2 = top-level team
 * cage, L3 = epic-team cage, L4+ = reserved.
 *
 * The default shifted from 1 to 2 on 2026-05-24 (operator directive
 * — "Fix code to match ADR §C table + my mental model"). Pre-shift
 * default treated L1 as "outermost cage" which collapsed cockpit
 * and top-level team into the same chain slot (F1), relying on
 * tmux-socket separation to avoid physical collision. Post-shift
 * each level has its own distinct slot: cockpit=F1, team=F2,
 * epic-team=F3.
 *
 * Pure. Exported for direct unit-testing.
 */
export function readNestingLevel(env: NodeJS.ProcessEnv): number {
  const raw = env[ATMUX_NESTING_LEVEL_ENV];
  if (raw === undefined || raw === "") return 2;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 2;
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

/** Per-team cage socket absolute path under team-root convention:
 *  `<teamRoot>/.atmux/tmux/tmux-<uid>/default`. Used by teams with
 *  `team.tmuxTmpdir` set (sopx / unum / atmux dogfood). The uid suffix
 *  matches tmux's own `default` socket naming under `TMUX_TMPDIR` — see
 *  `core/common.ts::resolveTeamSocket` for the parallel resolver on the
 *  team-level side. */
export function perTeamCageSocketPath(teamRoot: string): string {
  const uid = process.getuid?.() ?? 0;
  return `${teamRoot}/.atmux/tmux/tmux-${uid}/default`;
}

/** ADR-089 §Pillar 1 §Amendment (t-2ea3bdb9, 2026-05-16): the epic-team
 *  retains its own nested tmux server, but the PARENT atmux cage gains
 *  a viewer-window that auto-attaches into the epic-team. Operators page
 *  through the parent's window list and the epic-team appears as a
 *  sibling node alongside other role-members at the end of the parent's
 *  windows — same agile-tree pattern as cockpit's per-team viewer
 *  windows but one level deeper. Mirrors {@link cageRetryLoop} in
 *  `verbs/cockpit.ts` so the attach command form is symmetric.
 *
 *  Idempotent: skips if a viewer window for this epic already exists
 *  in the parent session. Soft-fails if the parent session isn't running
 *  (e.g. epic spawned while parent stopped) — logs a warn and exits 0;
 *  the operator can re-invoke after starting the parent cage.
 *
 *  Window-name convention: `🌳-<epicId>`. The 🌳 emoji distinguishes
 *  the viewer from regular member windows (which use member-role emojis
 *  like 🧭/🎯/🔍 + sometimes 🐝).
 *
 *  Returns the index of the added window (or `null` on idempotent skip /
 *  soft-fail). */
/** Resolve the parent cage's live socket + session name. Handles both
 *  conventions: parents with `team.tmuxTmpdir` set (per-team-cage at
 *  `<root>/.atmux/tmux/tmux-<uid>/default`) AND parents with null
 *  `tmuxTmpdir` running on the legacy `/tmp/atmux-<team>/sock`. The
 *  session name is read from `<parentRoot>/.atmux/state/session.txt`
 *  (the same anchor `getSessionName` uses) so this matches reality for
 *  non-standard names like `atmux_<team>` — `parentName` is only a
 *  fallback when the anchor is missing. */
async function resolveParentCageHandle(opts: {
  parentRoot: string;
  parentName: string;
  /** Optional liveness probe — passed through to {@link resolveCageSocket}
   *  to prefer a tmux-responding candidate when both legacy + per-team
   *  sockets exist. See resolveCageSocket's "Liveness preference" note for
   *  the stale-socket case this guards against. */
  tmuxFactory?: (config: { socketPath: string }) => {
    session: { listSessions(): Promise<ReadonlyArray<{ name: string }>> };
  };
}): Promise<{ socket: string; session: string }> {
  const resolverDeps: Parameters<typeof resolveCageSocket>[2] = {};
  if (opts.tmuxFactory !== undefined) {
    const factory = opts.tmuxFactory;
    resolverDeps.isLive = async (p) => {
      try {
        await factory({ socketPath: p }).session.listSessions();
        return true;
      } catch {
        return false;
      }
    };
  }
  const socket = await resolveCageSocket(opts.parentName, opts.parentRoot, resolverDeps);
  const anchor = await readTextOrNull(sessionAnchorPath(join(opts.parentRoot, ".atmux")));
  const session =
    anchor !== null && anchor.trim().length > 0 ? anchor.trim() : `atmux-${opts.parentName}`;
  return { socket, session };
}

export async function addEpicViewerToParentCage(opts: {
  parentRoot: string;
  parentName: string;
  epicId: string;
  epicSocket: string;
  epicSession: string;
  tmuxFactory: (config: { socketPath: string }) => {
    session: { listSessions(): Promise<ReadonlyArray<{ name: string }>> };
    window: {
      listWindows(sessionName: string): Promise<ReadonlyArray<{ name: string; index: number }>>;
      newWindow(args: {
        sessionName: string;
        name: string;
        detached: boolean;
        shellCommand: string;
      }): Promise<{ windowIndex: number }>;
    };
  };
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
}): Promise<number | null> {
  const log = opts.log ?? (() => {});
  const warn = opts.warn ?? (() => {});
  const { socket: parentSocket, session: parentSession } = await resolveParentCageHandle({
    parentRoot: opts.parentRoot,
    parentName: opts.parentName,
    tmuxFactory: opts.tmuxFactory,
  });
  const tmux = opts.tmuxFactory({ socketPath: parentSocket });
  let parentAlive = false;
  try {
    const sessions = await tmux.session.listSessions();
    parentAlive = sessions.some((s) => s.name === parentSession);
  } catch {
    parentAlive = false;
  }
  if (!parentAlive) {
    warn(
      `epic-viewer: parent session '${parentSession}' not running on ${parentSocket} — skipping viewer add (re-run after parent start)`,
    );
    return null;
  }
  const windowName = `🌳-${opts.epicId}`;
  const windows = await tmux.window.listWindows(parentSession);
  const existing = windows.find((w) => w.name === windowName);
  if (existing !== undefined) {
    log(`  · epic-viewer '${windowName}' already present in parent cage (idx ${existing.index})`);
    return existing.index;
  }
  // Mirror cockpit's cageRetryLoop pattern: attach in a 1s-retry loop so
  // a transient epic-cage death doesn't permanently disconnect the viewer.
  const attachCmd = `while true; do tmux -S ${opts.epicSocket} attach -t ${opts.epicSession} 2>/dev/null; sleep 1; done`;
  const created = await tmux.window.newWindow({
    sessionName: parentSession,
    name: windowName,
    detached: true,
    shellCommand: attachCmd,
  });
  log(`  ✓ added epic-viewer '${windowName}' to parent cage (idx ${created.windowIndex})`);
  return created.windowIndex;
}

/** Counterpart to {@link addEpicViewerToParentCage} — removes the
 *  parent-cage viewer window when an epic-team is dissolved. Soft-fails
 *  if the parent session isn't running or the window doesn't exist
 *  (idempotent — re-invoking dissolve-epic without a leftover viewer
 *  must not error). */
export async function removeEpicViewerFromParentCage(opts: {
  parentRoot: string;
  parentName: string;
  epicId: string;
  tmuxFactory: (config: { socketPath: string }) => {
    session: { listSessions(): Promise<ReadonlyArray<{ name: string }>> };
    window: {
      listWindows(sessionName: string): Promise<ReadonlyArray<{ name: string; index: number }>>;
      killWindow(target: string): Promise<void>;
    };
  };
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
}): Promise<boolean> {
  const log = opts.log ?? (() => {});
  const warn = opts.warn ?? (() => {});
  const { socket: parentSocket, session: parentSession } = await resolveParentCageHandle({
    parentRoot: opts.parentRoot,
    parentName: opts.parentName,
    tmuxFactory: opts.tmuxFactory,
  });
  const tmux = opts.tmuxFactory({ socketPath: parentSocket });
  let parentAlive = false;
  try {
    const sessions = await tmux.session.listSessions();
    parentAlive = sessions.some((s) => s.name === parentSession);
  } catch {
    parentAlive = false;
  }
  if (!parentAlive) {
    warn(
      `epic-viewer: parent session '${parentSession}' not running on ${parentSocket} — skipping viewer remove (no-op)`,
    );
    return false;
  }
  const windowName = `🌳-${opts.epicId}`;
  const windows = await tmux.window.listWindows(parentSession);
  const existing = windows.find((w) => w.name === windowName);
  if (existing === undefined) {
    log(`  · epic-viewer '${windowName}' already absent from parent cage`);
    return false;
  }
  try {
    await tmux.window.killWindow(`${parentSession}:${windowName}`);
    log(`  ✓ removed epic-viewer '${windowName}' from parent cage`);
    return true;
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    warn(
      `epic-viewer: kill-window '${windowName}' failed (${cause}) — manual cleanup may be needed`,
    );
    return false;
  }
}

/**
 * ADR-063 follow-up (driver-inbox 2026-05-14): probe BOTH socket
 * conventions used by atmux cages and return the first that exists.
 * Order:
 *   1. Legacy `/tmp/atmux-<team>/sock` (ADR-063 era; back-compat first).
 *   2. Per-team `<teamRoot>/.atmux/tmux/tmux-<uid>/default` (current
 *      convention used by teams with `team.tmuxTmpdir` set).
 *
 * Falls through to the legacy path when neither exists, so downstream
 * error messages reference a canonical location. Pure modulo `exists`;
 * tests inject `deps.exists` to drive every branch.
 *
 * **Liveness preference (2026-05-18, observed 10:55 CEST):** when `isLive`
 * is provided AND multiple candidates exist, prefer the one with a
 * responding tmux server. Stale socket files on the legacy path persist
 * across reinstalls (e.g. atmux 0.8.4→0.8.5 left `/tmp/atmux-atmux/sock`
 * as a zero-byte file with no listener), breaking callers that resolve
 * the legacy socket first and then fail their session probe. With
 * `isLive`, the resolver picks the live socket instead of giving up at
 * the caller. Callers without `isLive` keep the original exists-only
 * behaviour for back-compat (and because liveness probes have a tmux
 * dependency the resolver shouldn't take unconditionally).
 *
 * Mirrors the same widening that landed in claude-skills `bau` socket
 * resolver (790dc4e) — single source of truth for cockpit-side cage
 * socket discovery so the next probe-widening lands in one place.
 */
export async function resolveCageSocket(
  teamName: string,
  teamRoot: string,
  deps: {
    exists?: (p: string) => Promise<boolean>;
    /** Optional liveness probe — returns true if a tmux server is
     *  responding on the socket. When provided, the resolver picks the
     *  first LIVE candidate (regardless of order), falling back to the
     *  first that merely exists if none are live. */
    isLive?: (p: string) => Promise<boolean>;
  } = {},
): Promise<string> {
  const existsFn = deps.exists ?? exists;
  const legacy = cageSocketPath(teamName);
  const perTeam = perTeamCageSocketPath(teamRoot);
  const candidates = [legacy, perTeam];
  // Fast path: no liveness preference — preserve byte-equal pre-fix
  // behaviour (walk in order, return first that exists, probe stops
  // at first hit — observable to tests that assert call count).
  if (deps.isLive === undefined) {
    for (const p of candidates) {
      if (await existsFn(p)) return p;
    }
    return legacy;
  }
  // Liveness-preferred path: walk all candidates, prefer live-and-existing
  // over merely-existing. Guards against the stale-socket case where a
  // prior install left a zero-byte legacy socket file with no listener.
  const existingCandidates: string[] = [];
  for (const p of candidates) {
    if (await existsFn(p)) existingCandidates.push(p);
  }
  if (existingCandidates.length > 1) {
    for (const p of existingCandidates) {
      if (await deps.isLive(p)) return p;
    }
  }
  if (existingCandidates.length > 0) return existingCandidates[0]!;
  return legacy;
}

/** Cage tmux session name — LEGACY synchronous fallback.
 *
 *  @deprecated Use {@link resolveCageSessionName} instead. The sync form
 *  returns `atmux_<name>` which only matches reality for teams whose
 *  `state/session.txt` anchor happens to be in the same form. For teams
 *  with no anchor, `start.ts` creates a session named `atmux-<name>`
 *  (hyphen, per `getSessionName` in common.ts) — the underscore form
 *  here mismatches, causing cockpit retry-loops + doctor probes to fail
 *  silently for any dash-bearing or fresh-start team. Kept here for
 *  back-compat callers; new code MUST use the async resolver below. */
export function cageSessionName(teamName: string): string {
  return teamName === "atmux" ? "atmux" : `atmux_${teamName}`;
}

/** Cage tmux session name — anchor-aware async resolver.
 *
 *  Resolution order (mirrors `common.ts::getSessionName`):
 *    1. `<root>/.atmux/state/session.txt` anchor (when present)
 *    2. Special-case: `team.name === "atmux"` → bare `"atmux"`
 *    3. Default: `atmux-<name>` (hyphen — matches what `start.ts` creates
 *       for any unanchored team via `getSessionName` fallback)
 *
 *  Use this from any cockpit / dissolve / doctor code path that needs
 *  to target a cage's tmux session — `hasSession`, `send-keys`,
 *  retry-loop attaches, etc. — so the name resolved here matches the
 *  name `start.ts` actually creates. */
export async function resolveCageSessionName(team: {
  name: string;
  root: string;
}): Promise<string> {
  const anchor = await readTextOrNull(sessionAnchorPath(join(team.root, ".atmux")));
  if (anchor !== null) {
    const trimmed = anchor.trim();
    if (trimmed.length > 0) return trimmed;
  }
  if (team.name === "atmux") return "atmux";
  return `atmux-${team.name}`;
}
