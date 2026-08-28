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
  /** Home dir override (test injection — avoids touching `$HOME`).
   *  Outranks `env.ATMUX_COCKPIT_CONFIG`: programmatic injection beats
   *  ambient environment (a-e0199c53). */
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

/** Resolve the cockpit config path. Order: opts.path → opts.home →
 *  env.ATMUX_COCKPIT_CONFIG → env.HOME.
 *
 *  Programmatic injection outranks ambient environment (kanban
 *  a-e0199c53, found 2026-08-27): every atmux cage exports
 *  `ATMUX_COCKPIT_CONFIG`, so when that env var was consulted BEFORE
 *  `opts.home`, the documented test-injection point silently lost to
 *  the operator's real cockpit — a deleted test file changed which
 *  tests saw the live 20-session roster. A caller that passes `home`
 *  (or `path`) has said which config it means; only callers that pass
 *  neither fall through to the ambient env. */
export function resolveCockpitConfigPath(opts: LoadCockpitOpts = {}): string {
  if (opts.path !== undefined && opts.path.length > 0) return opts.path;
  if (opts.home !== undefined && opts.home.length > 0) {
    return defaultCockpitConfigPath(opts.home);
  }
  const env = opts.env ?? process.env;
  const fromEnv = env.ATMUX_COCKPIT_CONFIG;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const home = env.HOME;
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
    // Groups occupy the cockpit window namespace too (e-419553c6 true
    // containment: a top-level group gets a cockpit viewer window
    // embedding its server).
    if (node.type === "team" || node.type === "group") occupied.add(node.name);
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

/** A flattened team entry — one row per `type: "team"` session in DFS
 *  order, annotated with its nesting `level`. Used by ADR-089 T5
 *  (prefix-chain) consumers to derive per-node prefix keys.
 *
 *  Shape-compatible with legacy `CockpitTeam` for `name` / `root` /
 *  `enabled` access — existing callers iterate without type changes.
 *  `level=0` is the top-level sessions[] (root of the tree); each
 *  nested step adds 1.
 *
 *  ADR-280 stage 3 dropped the `epic-team` row shape and its `epicId`.
 *  `parent` SURVIVES and is now populated for any nested team (it was
 *  previously epic-only) — ADR-089 §Amendment 2026-08-27 §(A) makes a
 *  team nested under a team the general case, and the parent↔child
 *  policy table in {@link callerScopeAllowed} joins on this field. */
export interface FlattenedTeamEntry {
  type: "team";
  name: string;
  enabled: boolean;
  /** The team's own project root. */
  root: string;
  level: number;
  /** Nearest ancestor `team` name, when this entry is nested. Absent at
   *  `level === 0`. */
  parent?: string;
  /** Nearest ancestor `group` name (e-419553c6). Absent when no group
   *  sits above this team. Groups never appear as team entries
   *  themselves; this is how their name reaches consumers. Since the
   *  2026-08-28 true-containment decision this field also decides WHERE
   *  the team's viewer window lives: grouped teams embed in their
   *  group's server (see `buildGroupTopology` + the group reconcile in
   *  verbs/cockpit.ts), ungrouped teams embed in the cockpit session. */
  group?: string;
  claudeAccount?: TeamSessionT["claudeAccount"];
  tuiOverrides?: TeamSessionT["tuiOverrides"];
}

/** Depth-first flattener — ADR-089 §F + T5 prep. Returns enabled
 *  `type: "team"` entries with their nesting `level` annotated.
 *  `superdriver` / `superdoctor` / `medic` entries are excluded —
 *  they're cockpit-internal singletons, not iterable "teams" in the
 *  legacy sense.
 *
 *  Legacy callers iterating `enabledTeams(cockpit)` keep working
 *  because the returned shape exposes `.name` / `.root` / `.enabled`
 *  (duck-typed). `.level` is additive for new consumers. */
export function enabledTeams(cockpit: CockpitShape): FlattenedTeamEntry[] {
  const out: FlattenedTeamEntry[] = [];
  // Groups never yield an entry of their own (`type === "team"` filter),
  // and a DISABLED group's children never reach the visitor at all —
  // walkSessions prunes that subtree (e-419553c6).
  walkSessions(cockpit.sessions ?? [], 0, (node, level, _parentRoot, parentName, parentGroup) => {
    if (node.type === "team" && node.enabled) {
      out.push(flattenTeamNode(node, level, parentName, parentGroup));
    }
  });
  return out;
}

/** Shared row-builder for the flattened-team shape — used by both
 *  {@link enabledTeams} and {@link buildGroupTopology} so the two walks
 *  can never disagree on which fields survive flattening. */
function flattenTeamNode(
  node: TeamSessionT,
  level: number,
  parentName: string | undefined,
  parentGroup: string | undefined,
): FlattenedTeamEntry {
  const e: FlattenedTeamEntry = {
    type: "team",
    name: node.name,
    enabled: node.enabled,
    root: node.root,
    level,
  };
  if (parentName !== undefined) e.parent = parentName;
  if (parentGroup !== undefined) e.group = parentGroup;
  if (node.claudeAccount !== undefined) e.claudeAccount = node.claudeAccount;
  if (node.tuiOverrides !== undefined) e.tuiOverrides = node.tuiOverrides;
  return e;
}

/** DFS walk over `sessions[]`. Visitor receives each node + its level +
 *  the nearest ancestor `team.root` + the nearest ancestor `team.name` +
 *  the nearest ancestor `group.name`. Public for ADR-089 T5/T6
 *  consumers needing custom walks; the flattener + enrichment paths use
 *  it internally.
 *
 *  ADR-280 stage 3 added `parentName`. It replaces the `epic-team`
 *  node's own `.parent` back-pointer, which was the only way a consumer
 *  could reach its parent before nesting became general — the ancestry
 *  is now derived from the walk itself and works for any nested team.
 *  Visitors that ignore the extra argument are unaffected.
 *
 *  e-419553c6 added `parentGroup` the same way, plus the group
 *  recursion rules: a group's children are walked one level DOWN
 *  (groups run real tmux servers and consume a prefix rung — see the
 *  inline comment), and a disabled group's subtree is skipped
 *  entirely. */
export function walkSessions(
  sessions: ReadonlyArray<CockpitSessionT>,
  level: number,
  visit: (
    node: CockpitSessionT,
    level: number,
    parentRoot: string | undefined,
    parentName: string | undefined,
    parentGroup: string | undefined,
  ) => void,
  parentRoot?: string,
  parentName?: string,
  parentGroup?: string,
): void {
  for (const node of sessions) {
    visit(node, level, parentRoot, parentName, parentGroup);
    if (node.type === "team") {
      if (Array.isArray(node.sessions) && node.sessions.length > 0) {
        walkSessions(node.sessions, level + 1, visit, node.root, node.name, parentGroup);
      }
    } else if (node.type === "group") {
      // Groups DO increment `level` — the ADR-089 §Amendment 2026-08-27
      // §(B) F2→F3 shift is in effect for groups. The prefix-neutral
      // reading (groups transparent to the chain because they ran no
      // tmux server) lasted exactly one commit (49af4a59): the operator
      // chose TRUE CONTAINMENT on 2026-08-28, so every enabled group
      // now backs a REAL tmux server (`groupSocketPath` / the group
      // reconcile in verbs/cockpit.ts) whose prefix rung is
      // `resolvePrefix(level + 2, …)` — F2 for a top-level group — and
      // the teams beneath it shift one rung down (F3). The group stays
      // transparent to team ancestry (parentRoot / parentName pass
      // through unchanged) — it only becomes the nearest-ancestor
      // `parentGroup` for everything beneath it.
      //
      // A disabled group prunes its WHOLE subtree from the walk —
      // unlike a disabled team, whose children are still visited (a
      // team is one cage's flag; a group is a declaration that the
      // subtree is off).
      if (node.enabled && Array.isArray(node.sessions) && node.sessions.length > 0) {
        walkSessions(node.sessions, level + 1, visit, parentRoot, parentName, node.name);
      }
    }
  }
}

// ---------- ADR-092: cross-team tell-lead lookup + caller-scope gate ----------

/** Result of `findTeamByName` — narrowed view of the matched cockpit
 *  node. Only `team` nodes match (other session types don't host a
 *  backing team cage). Per ADR-092 §D2 Decision-anchor #2 — first match
 *  wins on name collision; cockpit-validation flags dupes at load time.
 *
 *  ADR-280 stage 3: `epic-team` is retired, so the union narrows; but
 *  `parent` is KEPT and is now derived from the DFS walk's ancestry
 *  rather than an `epic-team`-only back-pointer, so the ADR-092 §D3
 *  parent↔child gate keeps working for the general nesting model
 *  ADR-089 §Amendment 2026-08-27 §(A) blesses. */
export interface CockpitTeamLookup {
  type: "team";
  name: string;
  root: string;
  level: number;
  /** Nearest ancestor team name when this node is nested; absent at the
   *  top level. Consumers (caller-scope gate) join on this to drive the
   *  parent ↔ child policy table. Groups are transparent here — a team
   *  under `team A → group G → team B` still reports `parent: "A"`. */
  parent?: string;
  /** Nearest ancestor `group` name (e-419553c6); absent when no group
   *  sits above this team. Mirrors {@link FlattenedTeamEntry.group}. */
  group?: string;
}

/** ADR-092 §D2 — depth-first match on `node.name` across `cockpit.sessions[]`.
 *  Returns the first matching `team` node, or `null` when no match. Pure
 *  (no IO); reuses {@link walkSessions} for the DFS walk so
 *  traversal-order matches every other cockpit consumer (`enabledTeams`
 *  / synthesis paths). */
export function findTeamByName(cockpit: CockpitShape, name: string): CockpitTeamLookup | null {
  let found: CockpitTeamLookup | null = null;
  walkSessions(cockpit.sessions ?? [], 0, (node, level, _parentRoot, parentName, parentGroup) => {
    if (found !== null) return;
    if (node.type !== "team") return;
    if (node.name !== name) return;
    const out: CockpitTeamLookup = {
      type: node.type,
      name: node.name,
      root: node.root,
      level,
    };
    if (parentName !== undefined) out.parent = parentName;
    if (parentGroup !== undefined) out.group = parentGroup;
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
 *   3. Source is a NESTED team with `parent === targetName` — child → parent.
 *   4. Target is a NESTED team with `parent === sourceName` — parent → child.
 *
 *  Rules 3/4 read `parent` off {@link findTeamByName}. Before ADR-280
 *  stage 3 that field existed only on `epic-team` nodes; it is now the
 *  walk-derived ancestry of any nested team, so the gate covers the
 *  general nesting model instead of the retired epic-shaped instance.
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
  if (src.parent !== undefined && src.parent === tgt.name) return true;
  if (tgt.parent !== undefined && tgt.parent === src.name) return true;
  return false;
}

// ---------- e-419553c6: group-server topology (true containment) ----------

/** One enabled `type: "group"` node, annotated for the group-server
 *  reconcile (e-419553c6, operator decision 2026-08-28). Every enabled
 *  group backs a REAL tmux server on {@link groupSocketPath} whose
 *  session (named after the group, bare) hosts one viewer window per
 *  child — the same attach-retry-loop containment the cockpit uses for
 *  ungrouped teams. */
export interface GroupTopologyNode {
  type: "group";
  name: string;
  /** Nesting depth on the SAME scale as {@link FlattenedTeamEntry.level}
   *  (0 = top-level `sessions[]`; both team and group ancestors count),
   *  so the group server's prefix is `resolvePrefix(level + 2, …)` —
   *  F2 for a top-level group, exactly like a top-level team cage. */
  level: number;
  /** Nearest ancestor group, when this group nests under another group.
   *  Absent for a top-level group (or one hosted only under teams) —
   *  those get their viewer window in the cockpit session. */
  parentGroup?: string;
  /** DFS-ordered viewer windows this group's server hosts: direct child
   *  groups, plus every enabled team whose NEAREST ancestor group is
   *  this group (teams nested under teams inside the group included —
   *  mirroring the cockpit session, which always gave nested teams
   *  their own viewer windows too). */
  children: GroupChildRef[];
}

/** One viewer window inside a group server. */
export type GroupChildRef =
  | { kind: "group"; name: string }
  | { kind: "team"; team: FlattenedTeamEntry };

/** One viewer window inside the COCKPIT session: an enabled team with
 *  no group ancestor (nested teams included, DFS pre-order — unchanged
 *  behaviour), or an enabled group with no group ancestor (its window
 *  attach-loops to the group's own server). */
export type CockpitViewerEntry =
  | { kind: "group"; group: GroupTopologyNode }
  | { kind: "team"; team: FlattenedTeamEntry };

/** First team root reachable inside a group (DFS: own teams, then child
 *  groups) — the natural `cwd` for that group's viewer windows. A viewer
 *  pane whose shell sits in an unrelated directory makes the operator's
 *  cwd-guard paint `root != root` on the status bar; spawning the pane at
 *  a real member root keeps the guard truthful (found live 2026-08-28 on
 *  the first group-server rollout, where every embed pane inherited the
 *  reconcile invoker's cwd). Undefined only for a group with no teams
 *  anywhere beneath it — callers then omit cwd, the pre-fix behaviour. */
export function firstTeamRoot(topology: GroupedTopology, groupName: string): string | undefined {
  const byName = new Map(topology.groups.map((g) => [g.name, g]));
  const walk = (name: string, seen: Set<string>): string | undefined => {
    if (seen.has(name)) return undefined;
    seen.add(name);
    const g = byName.get(name);
    if (g === undefined) return undefined;
    for (const c of g.children) if (c.kind === "team") return c.team.root;
    for (const c of g.children) {
      if (c.kind === "group") {
        const r = walk(c.name, seen);
        if (r !== undefined) return r;
      }
    }
    return undefined;
  };
  return walk(groupName, new Set());
}

/** Output of {@link buildGroupTopology}. */
export interface GroupedTopology {
  /** Every enabled group, DFS order (parents before children). */
  groups: GroupTopologyNode[];
  /** DFS-ordered cockpit-session viewer entries — what the cockpit's
   *  team-viewer slots should hold once groups own their teams. */
  cockpitEntries: CockpitViewerEntry[];
}

/**
 * Walk the cockpit tree once and derive the full three-tier viewer
 * topology (e-419553c6 true containment):
 *
 *   L1 cockpit session — one window per {@link GroupedTopology.cockpitEntries}
 *   L2 group servers   — one per enabled group, windows per `children`
 *   L3 team cages      — unchanged; only their viewers move
 *
 * Refuses (ConfigError) two config shapes that would produce silently
 * colliding tmux state rather than a wrong-but-visible layout:
 *
 *   1. duplicate enabled group names — two groups named `x` would share
 *      `/tmp/atmux-grp-x/sock` AND session `x`;
 *   2. duplicate viewer-window names inside one namespace (the cockpit
 *      entry list, or one group's children) — tmux windows are addressed
 *      by name during reconcile, so a `unum` group next to an ungrouped
 *      `unum` team at the same tier is ambiguous. (A `unum` TEAM inside
 *      the `unum` GROUP is fine — different namespaces.)
 *
 * Pure — no IO. The reconcile in verbs/cockpit.ts consumes this.
 */
export function buildGroupTopology(cockpit: CockpitShape): GroupedTopology {
  const groups: GroupTopologyNode[] = [];
  const byName = new Map<string, GroupTopologyNode>();
  const cockpitEntries: CockpitViewerEntry[] = [];
  walkSessions(cockpit.sessions ?? [], 0, (node, level, _parentRoot, parentName, parentGroup) => {
    if (node.type === "group") {
      // Disabled groups run no server; walkSessions already prunes
      // their whole subtree from the walk.
      if (!node.enabled) return;
      if (byName.has(node.name)) {
        throw new ConfigError({
          what: `cockpit.json declares two enabled groups named '${node.name}' — they would share tmux socket ${groupSocketPath(node.name)} and session '${node.name}'`,
          hint: "rename one of the groups (or disable one); group names must be unique across the tree",
        });
      }
      const g: GroupTopologyNode = { type: "group", name: node.name, level, children: [] };
      if (parentGroup !== undefined) g.parentGroup = parentGroup;
      groups.push(g);
      byName.set(node.name, g);
      if (parentGroup === undefined) {
        cockpitEntries.push({ kind: "group", group: g });
      } else {
        // Parent group precedes its children in DFS order, so the map
        // lookup can only miss on a walk-order bug — fail loud.
        const parent = byName.get(parentGroup);
        if (parent === undefined) {
          throw new ConfigError({
            what: `buildGroupTopology: group '${node.name}' visited before its ancestor group '${parentGroup}' — DFS invariant broken`,
          });
        }
        parent.children.push({ kind: "group", name: node.name });
      }
    } else if (node.type === "team" && node.enabled) {
      const team = flattenTeamNode(node, level, parentName, parentGroup);
      if (parentGroup === undefined) {
        cockpitEntries.push({ kind: "team", team });
      } else {
        const parent = byName.get(parentGroup);
        if (parent === undefined) {
          throw new ConfigError({
            what: `buildGroupTopology: team '${node.name}' visited before its ancestor group '${parentGroup}' — DFS invariant broken`,
          });
        }
        parent.children.push({ kind: "team", team });
      }
    }
  });
  // Per-namespace window-name uniqueness (refusal 2 in the JSDoc).
  const assertUniqueNames = (names: ReadonlyArray<string>, where: string): void => {
    const seen = new Set<string>();
    for (const n of names) {
      if (seen.has(n)) {
        throw new ConfigError({
          what: `cockpit.json viewer-window name '${n}' appears twice in ${where} — tmux windows are addressed by name during reconcile, so the layout would be ambiguous`,
          hint: "rename one of the colliding entries (a team and a group may share a name only when they live in DIFFERENT namespaces, e.g. the team inside that very group)",
        });
      }
      seen.add(n);
    }
  };
  assertUniqueNames(
    cockpitEntries.map((e) => (e.kind === "group" ? e.group.name : e.team.name)),
    "the cockpit session",
  );
  for (const g of groups) {
    assertUniqueNames(
      g.children.map((c) => (c.kind === "group" ? c.name : c.team.name)),
      `group '${g.name}'`,
    );
  }
  return { groups, cockpitEntries };
}

/** Walk a group's `parentGroup` chain up to the group with no group
 *  ancestor — the one whose viewer window lives in the COCKPIT session.
 *  Returns `name` itself when it is already top-level, and `null` when
 *  `name` names no enabled group in the topology (caller decides how
 *  loud to be). Cycle-safe: the chain is bounded by the group count. */
export function resolveTopLevelGroup(topology: GroupedTopology, name: string): string | null {
  const byName = new Map(topology.groups.map((g) => [g.name, g]));
  let cur = byName.get(name);
  if (cur === undefined) return null;
  for (let hops = 0; hops <= topology.groups.length; hops += 1) {
    if (cur.parentGroup === undefined) return cur.name;
    const next = byName.get(cur.parentGroup);
    if (next === undefined) return cur.name;
    cur = next;
  }
  return cur.name;
}

// ---------- ADR-089 §C: F-key prefix chain + ATMUX_NESTING_LEVEL ----------

/** Default F-key prefix chain. Twelve entries (F1..F12) cover every
 *  level the schema's max-depth cap (6) allows plus headroom for any
 *  future super-cockpit / deep-nesting chains. Operator override via
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
 *  declare. Computed as L1-L4 reserved (cockpit + team + nested team +
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
 * cage, L3 = nested child cage, L4+ = reserved.
 *
 * The default shifted from 1 to 2 on 2026-05-24 (operator directive
 * — "Fix code to match ADR §C table + my mental model"). Pre-shift
 * default treated L1 as "outermost cage" which collapsed cockpit
 * and top-level team into the same chain slot (F1), relying on
 * tmux-socket separation to avoid physical collision. Post-shift
 * each level has its own distinct slot: cockpit=F1, team=F2,
 * nested child cage=F3.
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

/** Group tmux-server socket absolute path: `/tmp/atmux-grp-<group>/sock`
 *  (e-419553c6 true containment, 2026-08-28). The `-grp-` infix is
 *  deliberate: group sockets live in a namespace team sockets
 *  (`/tmp/atmux-<team>/sock`) can only reach by a team literally naming
 *  itself `grp-<something>` — a group and a team may share a name (the
 *  live fleet has both a `unum` group and a `unum` team) without their
 *  servers colliding. (`ponytail:` the `grp-`-prefixed-team collision is
 *  not load-guarded; a team named `grp-x` next to a group named `x`
 *  would share a socket. No such team exists and the naming convention
 *  makes one unlikely; a loader refusal is the upgrade path.) */
export function groupSocketPath(groupName: string): string {
  return `/tmp/atmux-grp-${groupName}/sock`;
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
 *    2. Default: bare `<name>` (e-419553c6 — the `atmux-` prefix was
 *       dropped from SESSION names to save horizontal space; socket
 *       paths keep it. The old `team.name === "atmux"` special case
 *       collapsed into the default: bare is now universal.)
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
  return team.name;
}
