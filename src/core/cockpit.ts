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
  type CockpitMartinet,
  type CockpitMedic,
  type CockpitSessionT,
  type Cockpit as CockpitShape,
  type CockpitSuperdoctor,
  type CockpitTeam,
  type TeamSessionT,
} from "../schema/cockpit.ts";

/** Output of `loadCockpit` — same as `Cockpit` but with the legacy
 *  back-compat fields (`teams`, `superdoctor`, `medic`, `martinet`)
 *  narrowed: `teams` is always populated by `enrichLegacyFields`;
 *  `superdoctor` / `medic` are populated when at least one
 *  `type: "superdoctor"` OR `type: "medic"` entry exists (the loader
 *  coerces both to medic semantics per ADR-133); `martinet` is
 *  populated when at least one `type: "martinet"` entry exists. */
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
      hint: `seed it with a roster like:\n  {\n    "schemaVersion": 1,\n    "cockpitSession": "atmux_cockpit",\n    "sessions": [\n      { "type": "team", "name": "<team>", "root": "/abs/path/to/project" }\n    ]\n  }`,
    });
  }
  // Read raw first so the migration shims can inspect the on-disk
  // shape before Zod validation. `z.unknown()` always succeeds; it's a
  // typed raw read that honours the `JSON.parse`-only-in-abstractions/
  // json.ts invariant (R3 per ADR-006). Two shims run in order:
  //   1. `migrateLegacyShape` — ADR-089 §B flat `teams[]` → recursive
  //      `sessions[]`.
  //   2. `migrateSuperdoctorBlockToMedic` — ADR-133 TR2 top-level
  //      `superdoctor` key → `medic` with deprecation warning. Both
  //      shims are idempotent on inputs that already use the new shape.
  const raw = await readJson(path, z.unknown());
  const warn = opts.warn ?? ((msg: string) => process.stderr.write(msg));
  const migrated = migrateLegacyShape(raw, path, warn);
  const medicShimmed = migrateSuperdoctorBlockToMedic(migrated, path, warn);
  const sessionShimmed = migrateCockpitSessionLegacyLiteral(medicShimmed, path, warn);
  const parsed = Cockpit.parse(sessionShimmed);
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
  // Legacy singleton superdoctor / canonical medic lift into sessions[]
  // as their own discriminated entry. ADR-133 resolution rule: `medic`
  // wins over `superdoctor` when both present (loader warns + ignores
  // the deprecated key). Operator's original `enabled: false` carries
  // through; the loader's enrichLegacyFields step also re-surfaces the
  // singleton field for callers reading `cockpit.medic` /
  // `cockpit.superdoctor`.
  const medicBlock = obj.medic;
  const sd = obj.superdoctor;
  if (typeof medicBlock === "object" && medicBlock !== null) {
    const mObj = medicBlock as Record<string, unknown>;
    sessions.push({
      ...mObj,
      type: "medic",
      name: typeof mObj.name === "string" ? mObj.name : "medic",
    });
    if (typeof sd === "object" && sd !== null) {
      warn(
        `atmux: cockpit.json at ${path} contains BOTH 'medic' and 'superdoctor' blocks — ` +
          `using 'medic' (canonical per ADR-133); 'superdoctor' block ignored. ` +
          `Drop the legacy 'superdoctor' key to silence this warning.\n`,
      );
    }
  } else if (typeof sd === "object" && sd !== null) {
    const sdObj = sd as Record<string, unknown>;
    sessions.push({
      ...sdObj,
      type: "superdoctor",
      name: typeof sdObj.name === "string" ? sdObj.name : "superdoctor",
    });
    warn(
      `atmux: cockpit.json at ${path} uses deprecated 'superdoctor' block — ` +
        `rename to 'medic' per ADR-133 (medic-rename). Legacy key continues to work ` +
        `during the one-release-cycle deprecation window.\n`,
    );
  }
  // ADR-132 §D6 — top-level `martinet` block lifts into sessions[] as
  // its own discriminated entry.
  const martinetBlock = obj.martinet;
  if (typeof martinetBlock === "object" && martinetBlock !== null) {
    const mObj = martinetBlock as Record<string, unknown>;
    sessions.push({
      ...mObj,
      type: "martinet",
      name: typeof mObj.name === "string" ? mObj.name : "martinet",
    });
  }
  // Strip the legacy keys so the new-shape parse doesn't see them — the
  // enrichment pass adds them back from sessions[] post-validation.
  const {
    teams: _t,
    superdoctor: _s,
    medic: _m,
    martinet: _mt,
    ...rest
  } = obj;
  void _t;
  void _s;
  void _m;
  void _mt;
  return { ...rest, schemaVersion: 1, sessions };
}

/**
 * ADR-133 TR2: pre-parse shim that renames the top-level `superdoctor`
 * block to `medic`. Runs AFTER `migrateLegacyShape` so a fully-legacy
 * config (flat `teams[]` + top-level `superdoctor`) flows through
 * shape-migration first; this shim then only fires for configs that
 * declared `superdoctor` at the top level alongside (or instead of) a
 * `medic` key.
 *
 * Three branches:
 *   1. `medic` set + `superdoctor` set → strip `superdoctor`, warn
 *      operator that the deprecated key is being ignored.
 *   2. Only `superdoctor` set → rename to `medic`, warn operator that
 *      they should rename the key in their cockpit.json.
 *   3. Only `medic` set OR neither set → no-op.
 *
 * Idempotent on already-migrated inputs (no `superdoctor` key). Does
 * NOT auto-migrate the on-disk file — the warning is the call to
 * action. After one release cycle, a follow-up Task flips `superdoctor`
 * to a schema-level reject and removes this shim.
 */
export function migrateSuperdoctorBlockToMedic(
  raw: unknown,
  path: string,
  warn: (msg: string) => void,
): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const obj = raw as Record<string, unknown>;
  if (obj.superdoctor === undefined) return obj;
  if (obj.medic !== undefined) {
    warn(
      `atmux: cockpit.json at ${path} has BOTH deprecated top-level 'superdoctor' AND 'medic' keys ` +
        `— 'medic' wins; remove the 'superdoctor' block per ADR-133. ` +
        `Accepting this release; will fail next release.\n`,
    );
    const { superdoctor: _drop, ...rest } = obj;
    void _drop;
    return rest;
  }
  warn(
    `atmux: cockpit.json at ${path} uses deprecated top-level 'superdoctor' key — ` +
      `rename to 'medic' per ADR-133. ` +
      `Accepting this release; will fail next release.\n`,
  );
  const { superdoctor, ...rest } = obj;
  return { ...rest, medic: superdoctor };
}

/**
 * ADR-135 §D5: pre-parse shim that coerces the legacy
 * `cockpitSession: "atmux_teams"` literal to the canonical
 * `"atmux_cockpit"` value. Runs AFTER the medic-block migration so
 * the input has already been normalized for ADR-133. Only fires when
 * the field is set to the historical literal — operator-chosen
 * arbitrary names (e.g. `geoyws_cockpit`) pass through unchanged.
 *
 * Idempotent on already-canonical inputs. Does NOT auto-migrate the
 * on-disk file — the warning is the call to action. The tmux-side
 * rename of any existing `atmux_teams` session to `atmux_cockpit` is
 * handled by `reconcileCockpitSession` (verbs/cockpit.ts) per ADR-135
 * §D4. After one semver bump, a follow-up Task flips this shim to a
 * schema-level reject.
 */
export function migrateCockpitSessionLegacyLiteral(
  raw: unknown,
  path: string,
  warn: (msg: string) => void,
): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const obj = raw as Record<string, unknown>;
  if (obj.cockpitSession !== "atmux_teams") return obj;
  warn(
    `atmux: cockpit.json at ${path} uses deprecated cockpitSession literal 'atmux_teams' — ` +
      `coercing to canonical 'atmux_cockpit' per ADR-135. ` +
      `Update the on-disk value to silence this warning. ` +
      `Accepting this release; will fail next release.\n`,
  );
  return { ...obj, cockpitSession: "atmux_cockpit" };
}

/**
 * Post-parse synthesis of legacy back-compat fields. Walks `sessions[]`
 * DFS and populates `teams: CockpitTeam[]` (type==="team" entries) +
 * `superdoctor: CockpitSuperdoctor` (first type==="superdoctor" entry).
 * Existing duck-typed consumers in audit.ts / status.ts / verbs/cockpit.ts
 * read these synthesized fields unchanged.
 *
 * ADR-133 TR2: also populates `medic: CockpitMedic` alongside
 * `superdoctor` from the same `type: "superdoctor"` entry. Callers
 * reading the new field (cockpit verb's W2 provisioning, post-TR2)
 * work for sessions[]-based configs without forcing operators to
 * restructure. The session discriminator stays `"superdoctor"` until
 * TR3+ ships the wider rename.
 */
function enrichLegacyFields(cockpit: CockpitShape): LoadedCockpit {
  const teams: CockpitTeam[] = [];
  // ADR-133: medic is the canonical singleton. Loader resolves from
  // either discriminator (`type: "medic"` canonical or `type: "superdoctor"`
  // legacy) — first occurrence wins. `medic` discriminator takes precedence
  // when both exist in the same sessions[] (matches the cockpit.json
  // top-level resolution rule in `migrateLegacyShape`).
  let medicResolved: CockpitMedic | undefined;
  let martinet: CockpitMartinet | undefined;
  // Legacy `superdoctor` synthesis bucket — populated when no canonical
  // `medic` session entry is seen but a `superdoctor` session entry is.
  // ADR-133 second pass coerces this into `medicResolved` if still
  // undefined at end of walk.
  let superdoctor: CockpitSuperdoctor | undefined;
  // First pass: look for canonical `medic` entries.
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
      // ADR-133 canonical entry. Synthesize a claude-shape CockpitMedic
      // (medic shape is structurally identical to legacy superdoctor).
      const m: CockpitMedic = { enabled: node.enabled };
      if (node.claudeAccount !== undefined) m.claudeAccount = node.claudeAccount;
      if (node.tuiOverrides !== undefined) m.tuiOverrides = node.tuiOverrides;
      medicResolved = m;
    } else if (node.type === "martinet" && martinet === undefined) {
      // ADR-132 §D6: synthesize a CockpitMartinet from the ADR-089
      // sessions[] martinet discriminator. MartinetSessionT carries
      // claude-shape fields (claudeAccount + tuiOverrides) only —
      // session-level impl selection isn't currently modelled — so
      // the synthesized config is always the claude variant. To
      // declare a cursor-variant martinet, operators set the
      // top-level `cockpit.martinet: { impl: "cursor", ... }` block
      // directly; that path skips this session-walk synthesis.
      const mt: CockpitMartinet = { impl: "claude", enabled: node.enabled };
      if (node.claudeAccount !== undefined) mt.claudeAccount = node.claudeAccount;
      if (node.tuiOverrides !== undefined) mt.tuiOverrides = node.tuiOverrides;
      martinet = mt;
    } else if (node.type === "superdoctor" && superdoctor === undefined) {
      // Legacy ADR-077 sessions[] entry — preserve the full claude
      // shape (autoStart + autoStartTimeoutSec retained per trunk's
      // shipped fields). ADR-133 second-pass below coerces this to
      // medic semantics when no canonical `medic` was seen.
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
  // ADR-133 §D2 second pass: when no canonical `medic` entry was seen
  // in sessions[] AND no top-level `cockpit.medic` block is declared,
  // coerce the legacy `superdoctor` session entry / top-level field
  // to medic semantics during the deprecation window. After the
  // window closes (v2 schema bump), this fallback is removed.
  if (medicResolved === undefined && superdoctor !== undefined) {
    medicResolved = superdoctor;
  }
  // ADR-133 TR2: when the operator already declared a top-level
  // `medic` (post-shim), it wins over any session-walk synthesis.
  const medic: CockpitMedic | undefined = cockpit.medic ?? medicResolved;
  // Surface BOTH `medic` (canonical) AND `superdoctor` (deprecated
  // alias) so duck-typed consumers reading either field during the
  // deprecation window see the same resolved shape. New code reads
  // `cockpit.medic` directly.
  return {
    ...cockpit,
    teams,
    ...(superdoctor !== undefined
      ? { superdoctor }
      : medic !== undefined
        ? { superdoctor: medic as CockpitSuperdoctor }
        : {}),
    ...(medic !== undefined ? { medic } : {}),
    ...(martinet !== undefined ? { martinet } : {}),
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
 *  `superdoctor` / `medic` / `martinet` entries are excluded —
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
export function findTeamByName(
  cockpit: CockpitShape,
  name: string,
): CockpitTeamLookup | null {
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
 * Mirrors the same widening that landed in claude-skills `bau` socket
 * resolver (790dc4e) — single source of truth for cockpit-side cage
 * socket discovery so the next probe-widening lands in one place.
 */
export async function resolveCageSocket(
  teamName: string,
  teamRoot: string,
  deps: { exists?: (p: string) => Promise<boolean> } = {},
): Promise<string> {
  const existsFn = deps.exists ?? exists;
  const legacy = cageSocketPath(teamName);
  const perTeam = perTeamCageSocketPath(teamRoot);
  const candidates = [legacy, perTeam];
  for (const p of candidates) {
    if (await existsFn(p)) return p;
  }
  return legacy;
}

/** Cage tmux session name. Special-case: the `atmux` team itself uses a
 *  bare `atmux` session (it's the canonical one); every other team uses
 *  `atmux_<name>`. Matches the historical bash convention so existing
 *  cockpit windows + `atmux attach` flows keep working. */
export function cageSessionName(teamName: string): string {
  return teamName === "atmux" ? "atmux" : `atmux_${teamName}`;
}
