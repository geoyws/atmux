// ADR-222 §D3 — fleet topography aggregator + discovery orchestrator.
//
// Architecture (per lead routing 2026-05-22, refined off the original
// §D3 "io-injected aggregator" sketch):
//
//   discovery = await gatherDiscovery(io)         // ONLY IO entry point
//   manifest  = aggregateTopo(discovery)          // pure transformation
//   orphans   = classifyOrphans(manifest, discovery, seenState)
//
// `Discovery` is the single intermediate state — a typed bag carrying
// the full set of raw probe results (cockpit + per-team + per-epic +
// global sockets + crontab + per-parent worktree/branch/kanban-epic
// enumerations). Both consumers (aggregator AND classifier) read from
// it; neither does IO. This is the lead-mandated Plan-B refinement
// to keep the public `--json` manifest schema free of raw discovery
// scaffolding.
//
// Schema notes:
//   - `TopoManifest` is the public `--json` shape pinned at ADR-222
//     §D2 (`schema_version: 1`). It carries `cockpit + teams[] +
//     orphans[] + summary` only — no `discovery` field.
//   - `Discovery` is INTERNAL scaffolding; not serialized on the
//     manifest. Stable as a TS-level contract between aggregator,
//     classifier, and the verb-layer orchestrator (t-cd382b92).
//   - Per ADR-222 §D5 every IO probe is nullable; gatherDiscovery
//     never throws on per-source failure. Aggregator + classifier
//     narrow nullables to safe defaults (kanban: null, cage_alive:
//     false, ahead/merged: null, etc.).
//
// Determinism: gatherDiscovery records `generated_at` once via
// `io.now()` and computes `elapsed_ms` at the end; aggregateTopo
// formats the timestamp + carries elapsed_ms verbatim into
// summary.elapsed_ms. Teams + epics + sockets + worktrees + branches
// are sorted alphabetically / lexicographically inside aggregateTopo
// so the manifest is byte-stable for any diffing consumer.

import { join } from "node:path";
import { buildGroupTopology, type LoadedCockpit } from "./cockpit.ts";

// ---------- Manifest types (the §D2 public --json contract) ----------

/** Top-level manifest. Shape pinned per ADR-222 §D2, additive-only;
 *  bumped to `schema_version: 2` by t-a14dfe3e, which added the group
 *  tier.
 *
 *  Earlier comments here said the Rust cockpit-mirror crate pins on this
 *  schema. It does not, and did not: `atmux-cockpit-mirror` reads
 *  `~/.atmux/cockpit-events.db` through honker/rusqlite, and the string
 *  `topo` appears nowhere in `rust/`. Verified 2026-09-04 before the v2
 *  bump — that belief was the only stated reason the bump needed a
 *  coordinated crate release, and it was false. Every consumer is
 *  TypeScript: `verbs/topo.ts`, this module, and `core/orphan-detector.ts`. */
export interface TopoManifest {
  schema_version: 2;
  /** Group tier (e-419553c6), sorted by `name`. Empty when
   *  cockpit.json declared no groups, or when it could not be read or
   *  refused validation - see {@link aggregateTopo}. */
  groups: TopoGroup[];
  /** ISO 8601 UTC, 3-digit ms precision. */
  generated_at: string;
  cockpit: TopoCockpit;
  /** Sorted alphabetically by `name`. */
  teams: TopoTeam[];
  /** Empty in the aggregator output — filled by the orphan classifier
   *  via {@link classifyOrphans} (sibling module orphan-detector.ts)
   *  at the verb-layer composer. */
  orphans: TopoOrphan[];
  summary: TopoSummary;
}

/** One group server in the cockpit tree. A group owns a tmux server but
 *  no root and no cage - see `groupSocketPath` (t-a14dfe3e). */
export interface TopoGroup {
  name: string;
  /** Enclosing group, or null for a group whose viewer window lives in
   *  the cockpit session itself. */
  parent_group: string | null;
  /** Nesting depth: 0 for a top-level group, 1 for its child, etc. */
  level: number;
}

/** Cockpit singleton block. */
export interface TopoCockpit {
  /** Cockpit tmux socket absolute path. */
  socket: string;
  /** Result of the cockpit-socket liveness probe. */
  alive: boolean;
  /** Resolved cockpit.json path even when the cockpit read returned
   *  null (lets consumers surface "expected at X but missing"). */
  registry_path: string;
  /** Count of top-level `sessions[]` in cockpit.json. Zero on null. */
  sessions_count: number;
}

/** Parent-team row. */
export interface TopoTeam {
  name: string;
  kind: "parent";
  /** Nearest enclosing group, or null for a team whose viewer window
   *  sits directly in the cockpit session. */
  group: string | null;
  /** Nesting depth of the team's viewer window. 0 when ungrouped. */
  level: number;
  atmux_dir: string;
  worktree: string;
  /** null when the worktree's rev-parse failed (§D5 row 6). */
  branch: string | null;
  cage_socket: string;
  cage_alive: boolean;
  /** null when the per-team `state.db` was missing / locked (§D5
   *  row 2). */
  kanban: KanbanProbe | null;
  /** Always `true` for rows enumerated from cockpit; the classifier
   *  derives `in_cockpit_registry: false` rows from the discovery
   *  block externally. */
  in_cockpit_registry: true;
  /** Max(last-commit, last-kanban-mutation). null when both null. */
  last_activity: string | null;
  /** Inline epic-team children, sorted by `eid` lexicographic. */
  epics: TopoEpic[];
  /** ADR-087 — present only when the cockpit row carries
   *  `soft_stopped_at`. Classifier treats `cage_alive: false` AS-
   *  INTENDED when this flag is true. */
  soft_stopped?: boolean;
}

/** Epic-team row. */
export interface TopoEpic {
  eid: string;
  kind: "epic";
  parent: string;
  atmux_dir: string;
  worktree: string;
  branch: string | null;
  cage_socket: string;
  cage_alive: boolean;
  kanban: KanbanProbe | null;
  in_cockpit_registry: true;
  /** True iff the parent kanban has an epic row for this `eid`.
   *  null when the parent kanban probe failed (cannot tell). */
  in_parent_kanban: boolean | null;
  /** null on §D5 row 5 git-probe failure / timeout. */
  branch_ahead_of_trunk: number | null;
  /** null on §D5 row 5. */
  branch_merged_to_trunk: boolean | null;
  last_activity: string | null;
  soft_stopped?: boolean;
}

/** Kanban probe shape. Surfaces on the manifest's `kanban` field. */
export interface KanbanProbe {
  /** Parent teams only — count of epic rows. Omitted for epic-team
   *  probes (those state.dbs don't store nested epics). */
  epics?: number;
  /** Parent teams only — list of epic ids in the kanban. Used for
   *  the id-precise `in_parent_kanban` join. */
  epic_ids?: string[];
  /** Tasks NOT in a terminal status. */
  tasks_open: number;
  /** Tasks in `done` status. */
  tasks_done: number;
  /** ISO 8601 UTC ms-precision of `MAX(updated_at)`. null when the
   *  table is empty. */
  last_activity: string | null;
}

/** Orphan row — output of {@link classifyOrphans}. Discriminated on
 *  `kind` so the reap orchestrator (ADR-223 §D3 Gate 2) can narrow at
 *  compile time before dispatching destructive primitives. Every
 *  orphan class in §D4 is epic-scoped today; the `kind: "parent"`
 *  branch is a forward-looking guard for any future class that
 *  targets a parent team (`atmux team rm` ownership, not reap's). */
export type TopoOrphan = TopoOrphanBase & {
  /** Topology kind — gates which destructive primitives may run.
   *  Reap dispatches ONLY when `kind === "epic"`; `parent` rows are
   *  refused with `gate-2-parent-kind` per ADR-223 §D3 Gate 2. */
  kind: "epic" | "parent";
};

interface TopoOrphanBase {
  /** Enum literal from ADR-222 §D4. */
  class: string;
  /** Identifier the operator recognizes. */
  ref: string;
  atmux_dir?: string;
  details: string;
  /** ISO 8601 UTC — earliest observation per the §D4 30s grace. */
  first_seen: string;
  reap_hint?: string;
}

/** Summary block. `elapsed_ms` carries gatherDiscovery's wall-time
 *  (the aggregator transform is sub-ms). Classifier + verb-layer
 *  rewrite `orphans_count` after running the classifier. */
export interface TopoSummary {
  teams_count: number;
  epics_count: number;
  cages_alive: number;
  orphans_count: number;
  elapsed_ms: number;
}

// ---------- Discovery types (INTERNAL — not on the public manifest) ----------

/** The single intermediate state passed from {@link gatherDiscovery}
 *  to {@link aggregateTopo} (and re-consumed by `classifyOrphans`).
 *
 *  Carries the full raw IO result for every probe in the §D3 + §D4
 *  sources table. Stable as a TS-level contract among the aggregator,
 *  classifier, and verb-layer composer — NOT serialized on the public
 *  `--json` manifest. */
export interface Discovery {
  /** Wall-clock at gatherDiscovery start. Used by the aggregator to
   *  populate `manifest.generated_at`. */
  generated_at: Date;
  /** Total wall-time gatherDiscovery took (ms). Drives
   *  `manifest.summary.elapsed_ms`. */
  elapsed_ms: number;
  cockpit: CockpitDiscovery;
  /** Per-parent enrichment — keyed by parent name, sorted alphabetic. */
  parents: ParentDiscovery[];
  /** Global probes not joined to a specific parent. */
  global: GlobalDiscovery;
}

export interface CockpitDiscovery {
  socket: string;
  alive: boolean;
  registry_path: string;
  /** null per §D5 row 1 when the cockpit.json read failed. */
  data: LoadedCockpit | null;
}

export interface GlobalDiscovery {
  /** Alive cage tmux sockets enumerated from `/tmp/atmux-<name>/`,
   *  regardless of registry. Class 1 consumes this. */
  sockets_alive: TmuxSocketEntry[];
  /** Marker-fenced cron blocks. null per §D5 row 4 on crontab read
   *  failure. Class 2 consumes this. */
  cron_marker_blocks: CronMarkerBlock[] | null;
}

export interface ParentDiscovery {
  name: string;
  root: string;
  soft_stopped: boolean;
  atmux_dir: string;
  worktree: string;
  cage_socket: string;
  cage_alive: boolean;
  branch: string | null;
  last_commit: string | null;
  kanban: KanbanProbe | null;
  /** Worktree dirs found at `<root>/../atmux-epics/`. Class 3 + 4. */
  worktrees_on_disk: WorktreeOnDisk[];
  /** Branches matching `<base>-epic-*` glob in the parent repo.
   *  Class 4. */
  branches: BranchOnParent[];
  /** Kanban epic rows (eid + status). Class 5. null when the parent
   *  kanban probe failed. */
  kanban_epic_rows: KanbanEpicRow[] | null;
  epics: EpicDiscovery[];
}

export interface EpicDiscovery {
  eid: string;
  session_name: string;
  parent: string;
  soft_stopped: boolean;
  atmux_dir: string;
  worktree: string;
  cage_socket: string;
  cage_alive: boolean;
  branch: string | null;
  last_commit: string | null;
  ahead: number | null;
  merged: boolean | null;
  kanban: KanbanProbe | null;
}

// ---------- Shared discovery sub-shapes ----------

export interface TmuxSocketEntry {
  socket: string;
  /** Team name parsed from `/tmp/atmux-<parent>/...`. */
  parent: string;
  /** Epic id when socket is an epic-team cage; null for a parent. */
  eid: string | null;
}

export interface CronMarkerBlock {
  /** Marker value (e.g. `atmux:team=e-deadbeef`). */
  ref: string;
  atmux_dir: string;
  /** Pre-resolved by the IO so the classifier doesn't double-probe. */
  atmux_dir_exists: boolean;
}

export interface WorktreeOnDisk {
  path: string;
  parent: string;
  eid: string;
}

export interface BranchOnParent {
  parent: string;
  branch: string;
  /** Epic id parsed from the branch suffix. */
  eid: string;
}

export interface KanbanEpicRow {
  eid: string;
  /** Free-form status literal (`todo` / `in-progress` / `done` / etc.). */
  status: string;
}

// ---------- IO shim (single entry point for gatherDiscovery) ----------

/** Every fallible source the discovery orchestrator probes goes
 *  through this shim. Tests stub each method to drive deterministic
 *  per-failure-mode rows; production wires real fs / sqlite / tmux /
 *  git in the verb layer per ADR-007's "subprocess calls live in
 *  abstractions" rule.
 *
 *  Every method that probes a fallible source returns a nullable: null
 *  means "source failed, carry the failure on the row" per ADR-222 §D5.
 *  Methods that don't probe (pure path resolvers, `now`) never return
 *  null.
 *
 *  Aggregator + classifier do NOT take this — they read from {@link
 *  Discovery} only. */
export interface DiscoveryIO {
  /** Read + parse the cockpit registry. null per §D5 row 1 on missing
   *  / unreadable / parse-broken. */
  readCockpit(): Promise<LoadedCockpit | null>;
  cockpitRegistryPath(): string;
  cockpitSocketPath(): string;
  /** Probe tmux liveness at `socket`. 500ms timeout enforced inside
   *  the IO impl per §D5 row 3. */
  cageAlive(socket: string): Promise<boolean>;
  /** Open `<atmuxDir>/state.db` read-only + probe kanban counts +
   *  last mutation. null per §D5 row 2 on missing / locked / corrupt. */
  readKanban(atmuxDir: string, opts: { parent: boolean }): Promise<KanbanProbe | null>;
  /** Current branch via `git rev-parse --abbrev-ref HEAD`. null per
   *  §D5 row 6 on broken worktree. */
  gitCurrentBranch(worktreePath: string): Promise<string | null>;
  /** ISO timestamp of HEAD via `git log -1 --format=%cI`. null on
   *  broken worktree. */
  gitLastCommitAt(worktreePath: string): Promise<string | null>;
  /** Commits on `branch` not on `base`. null per §D5 row 5 on
   *  timeout / failure. */
  gitAheadCount(repoPath: string, base: string, branch: string): Promise<number | null>;
  /** True iff `branch` is merged into `base`. null per §D5 row 5. */
  gitMergedInto(repoPath: string, base: string, branch: string): Promise<boolean | null>;
  /** Walk `/tmp/atmux-<name>/` for alive cage sockets. Pre-filtered alive. */
  listAliveCageSockets(): Promise<TmuxSocketEntry[]>;
  /** Parse `crontab -l` into marker-fenced blocks. Each carries pre-
   *  resolved `atmux_dir_exists`. null per §D5 row 4 on crontab fail. */
  listCronMarkerBlocks(): Promise<CronMarkerBlock[] | null>;
  /** Walk `<parentRoot>/../atmux-epics/` for one parent. Empty array
   *  is "no epics ever spawned" — NOT a failure. */
  listEpicWorktreeDirs(parentRoot: string, parentName: string): Promise<WorktreeOnDisk[]>;
  /** Branches matching `<base>-epic-*` in `repoPath`. Empty on git
   *  probe failure (best-effort — classifier skips class 4 for that
   *  parent rather than false-positiving). */
  listEpicBranches(repoPath: string, base: string, parentName: string): Promise<BranchOnParent[]>;
  /** Kanban epic rows (eid + status). null per §D5 row 2. */
  listKanbanEpicRows(atmuxDir: string): Promise<KanbanEpicRow[] | null>;
  /** Wall-clock. Stubbed in tests for deterministic timestamps. */
  now(): Date;
}

// ---------- Path computation (per ADR-162 socket convention) ----------

export function cageSocketForTeam(teamName: string): string {
  return `/tmp/atmux-${teamName}/sock`;
}

export function cageSocketForEpic(parentName: string, eid: string): string {
  return `/tmp/atmux-${parentName}/epics/${eid}/tmux-0/default`;
}

export function atmuxDirForTeam(teamRoot: string): string {
  return join(teamRoot, ".atmux");
}

export function worktreeForEpic(parentRoot: string, eid: string): string {
  return join(parentRoot, "..", "atmux-epics", eid);
}

export function atmuxDirForEpic(parentRoot: string, eid: string): string {
  return join(worktreeForEpic(parentRoot, eid), ".atmux");
}

// ---------- Time formatting ----------

export function formatIsoMs(d: Date): string {
  return d.toISOString();
}

function maxIso(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
}

// ---------- Cockpit walk ----------

interface CockpitWalkResult {
  parents: Array<{ name: string; root: string; softStopped: boolean }>;
  epicsByParent: Map<string, Array<{ eid: string; sessionName: string; softStopped: boolean }>>;
}

/** Walk the cockpit's recursive `sessions[]` tree and return flat
 *  parent + epic-child lists. Exported for tests + the gatherer.
 *  Defensive on shape — coerces missing fields rather than throwing
 *  so a partially-corrupt cockpit still surfaces what it can. */
export function walkCockpit(cockpit: LoadedCockpit): CockpitWalkResult {
  const parents: CockpitWalkResult["parents"] = [];
  const epicsByParent = new Map<
    string,
    Array<{ eid: string; sessionName: string; softStopped: boolean }>
  >();

  function recurse(node: {
    type: string;
    name: string;
    sessions?: readonly unknown[];
    [k: string]: unknown;
  }): void {
    if (node.type === "team") {
      const root = typeof node.root === "string" ? node.root : "";
      const softStopped =
        typeof node.soft_stopped_at === "string" && node.soft_stopped_at.length > 0;
      parents.push({ name: node.name, root, softStopped });
    } else if (node.type === "epic-team") {
      const parent = typeof node.parent === "string" ? node.parent : "";
      const eid = typeof node.epicId === "string" ? node.epicId : node.name;
      const softStopped =
        typeof node.soft_stopped_at === "string" && node.soft_stopped_at.length > 0;
      const list = epicsByParent.get(parent) ?? [];
      list.push({ eid, sessionName: node.name, softStopped });
      epicsByParent.set(parent, list);
    }
    if (Array.isArray(node.sessions)) {
      for (const child of node.sessions as Array<typeof node>) {
        if (typeof child?.type === "string" && typeof child?.name === "string") {
          recurse(child);
        }
      }
    }
  }

  for (const root of cockpit.sessions) {
    if (typeof (root as { type?: unknown }).type === "string") {
      recurse(root as unknown as Parameters<typeof recurse>[0]);
    }
  }

  return { parents, epicsByParent };
}

// ---------- gatherDiscovery — the ONLY async / IO entry point ----------

/** Probe every source declared in ADR-222 §D3 + §D4, returning a
 *  fully-populated {@link Discovery} the aggregator + classifier
 *  consume as a pure intermediate.
 *
 *  Per ADR-222 §D5 every per-source failure narrows to a nullable on
 *  the appropriate field — gatherDiscovery NEVER throws on per-source
 *  IO failure. Per-team probes parallelize via Promise.all; per-epic
 *  probes parallelize within each team. */
export async function gatherDiscovery(io: DiscoveryIO): Promise<Discovery> {
  const start = io.now();
  const cockpitSocket = io.cockpitSocketPath();
  const cockpitRegistry = io.cockpitRegistryPath();

  const [cockpitData, cockpitAlive, sockets, cronBlocks] = await Promise.all([
    io.readCockpit(),
    io.cageAlive(cockpitSocket),
    io.listAliveCageSockets(),
    io.listCronMarkerBlocks(),
  ]);

  const cockpit: CockpitDiscovery = {
    socket: cockpitSocket,
    alive: cockpitAlive,
    registry_path: cockpitRegistry,
    data: cockpitData,
  };

  let parents: ParentDiscovery[] = [];
  if (cockpitData !== null) {
    const walk = walkCockpit(cockpitData);
    walk.parents.sort((a, b) => a.name.localeCompare(b.name));
    parents = await Promise.all(
      walk.parents.map((p) => gatherOneParent(io, p, walk.epicsByParent.get(p.name) ?? [])),
    );
  }

  const finishedAt = io.now();
  const elapsedMs = Math.max(0, finishedAt.getTime() - start.getTime());

  return {
    generated_at: start,
    elapsed_ms: elapsedMs,
    cockpit,
    parents,
    global: {
      sockets_alive: sockets,
      cron_marker_blocks: cronBlocks,
    },
  };
}

async function gatherOneParent(
  io: DiscoveryIO,
  parent: { name: string; root: string; softStopped: boolean },
  epicEntries: Array<{ eid: string; sessionName: string; softStopped: boolean }>,
): Promise<ParentDiscovery> {
  const atmuxDir = atmuxDirForTeam(parent.root);
  const worktree = parent.root;
  const cageSocket = cageSocketForTeam(parent.name);

  const [kanban, cageAlive, branch, lastCommit, worktreesOnDisk, kanbanEpicRows] =
    await Promise.all([
      io.readKanban(atmuxDir, { parent: true }),
      io.cageAlive(cageSocket),
      io.gitCurrentBranch(worktree),
      io.gitLastCommitAt(worktree),
      io.listEpicWorktreeDirs(parent.root, parent.name),
      io.listKanbanEpicRows(atmuxDir),
    ]);

  // Branch glob hint for `<base>-epic-*` enumeration depends on the
  // parent's current branch. Empty hint → empty branches list (the
  // classifier conservatively skips class-4 detection for this parent
  // rather than false-positiving on every branch).
  const branches =
    branch === null || branch.length === 0
      ? []
      : await io.listEpicBranches(parent.root, branch, parent.name);

  const sortedEpics = [...epicEntries].sort((a, b) => a.eid.localeCompare(b.eid));
  const epics = await Promise.all(sortedEpics.map((e) => gatherOneEpic(io, parent, e, branch)));

  return {
    name: parent.name,
    root: parent.root,
    soft_stopped: parent.softStopped,
    atmux_dir: atmuxDir,
    worktree,
    cage_socket: cageSocket,
    cage_alive: cageAlive,
    branch,
    last_commit: lastCommit,
    kanban,
    worktrees_on_disk: worktreesOnDisk,
    branches,
    kanban_epic_rows: kanbanEpicRows,
    epics,
  };
}

async function gatherOneEpic(
  io: DiscoveryIO,
  parent: { name: string; root: string },
  entry: { eid: string; sessionName: string; softStopped: boolean },
  parentBranch: string | null,
): Promise<EpicDiscovery> {
  const worktree = worktreeForEpic(parent.root, entry.eid);
  const atmuxDir = atmuxDirForEpic(parent.root, entry.eid);
  const cageSocket = cageSocketForEpic(parent.name, entry.eid);
  const epicBranchHint = `${parentBranch ?? ""}-epic-${entry.eid}`;

  const [kanban, cageAlive, branch, lastCommit, ahead, merged] = await Promise.all([
    io.readKanban(atmuxDir, { parent: false }),
    io.cageAlive(cageSocket),
    io.gitCurrentBranch(worktree),
    io.gitLastCommitAt(worktree),
    parentBranch === null
      ? Promise.resolve<number | null>(null)
      : io.gitAheadCount(parent.root, parentBranch, epicBranchHint),
    parentBranch === null
      ? Promise.resolve<boolean | null>(null)
      : io.gitMergedInto(parent.root, parentBranch, epicBranchHint),
  ]);

  return {
    eid: entry.eid,
    session_name: entry.sessionName,
    parent: parent.name,
    soft_stopped: entry.softStopped,
    atmux_dir: atmuxDir,
    worktree,
    cage_socket: cageSocket,
    cage_alive: cageAlive,
    branch,
    last_commit: lastCommit,
    ahead,
    merged,
    kanban,
  };
}

// ---------- aggregateTopo — pure sync transformation ----------

/** Pure transformation of {@link Discovery} → {@link TopoManifest}.
 *
 *  No IO, no clock reads, no side effects. The manifest's `generated_at`
 *  + `summary.elapsed_ms` come verbatim from the discovery (which owns
 *  the wall-clock). `orphans` is emitted empty — the classifier
 *  (`src/core/orphan-detector.ts`) fills it via the verb-layer
 *  orchestrator. */
export function aggregateTopo(discovery: Discovery): TopoManifest {
  const { groups, teamGroup, teamLevel } = deriveGroups(discovery.cockpit.data);
  const teams: TopoTeam[] = discovery.parents.map((p) =>
    parentToTeam(p, teamGroup.get(p.name) ?? null, teamLevel.get(p.name) ?? 0),
  );

  let cagesAlive = discovery.cockpit.alive ? 1 : 0;
  let epicsCount = 0;
  for (const team of teams) {
    if (team.cage_alive) cagesAlive += 1;
    epicsCount += team.epics.length;
    for (const epic of team.epics) {
      if (epic.cage_alive) cagesAlive += 1;
    }
  }

  return {
    schema_version: 2,
    groups,
    generated_at: formatIsoMs(discovery.generated_at),
    cockpit: {
      socket: discovery.cockpit.socket,
      alive: discovery.cockpit.alive,
      registry_path: discovery.cockpit.registry_path,
      sessions_count: discovery.cockpit.data?.sessions.length ?? 0,
    },
    teams,
    orphans: [],
    summary: {
      teams_count: teams.length,
      epics_count: epicsCount,
      cages_alive: cagesAlive,
      orphans_count: 0,
      elapsed_ms: discovery.elapsed_ms,
    },
  };
}


/**
 * Derive the group tier from the loaded cockpit, plus per-team lookups.
 *
 * Degrades to "no groups" on ANY failure, and that is deliberate.
 * `aggregateTopo` is the pure half of a diagnostic whose whole contract
 * (ADR-222 D5) is that every probe is nullable and nothing throws on a
 * bad source — `atmux topo` has to keep reporting when cockpit.json is
 * the very thing that is broken. `buildGroupTopology` legitimately
 * THROWS ConfigError on the collision shapes it refuses (duplicate group
 * names, ambiguous viewer-window names, a `grp-<g>` team beside a group
 * `<g>`), so letting that escape here would make the diagnostic die on
 * exactly the config it exists to diagnose.
 *
 * A team absent from the map is ungrouped, not an error: cockpit.json
 * lists teams the discovery walk may not have reached, and vice versa.
 */
function deriveGroups(cockpit: LoadedCockpit | null): {
  groups: TopoGroup[];
  teamGroup: Map<string, string | null>;
  teamLevel: Map<string, number>;
} {
  const teamGroup = new Map<string, string | null>();
  const teamLevel = new Map<string, number>();
  if (cockpit === null) return { groups: [], teamGroup, teamLevel };
  let topology: ReturnType<typeof buildGroupTopology>;
  try {
    topology = buildGroupTopology(cockpit);
  } catch {
    return { groups: [], teamGroup, teamLevel };
  }
  const groups: TopoGroup[] = topology.groups
    .map((g) => ({
      name: g.name,
      parent_group: g.parentGroup ?? null,
      level: g.level,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const g of topology.groups) {
    for (const child of g.children) {
      if (child.kind === "team") {
        teamGroup.set(child.team.name, g.name);
        teamLevel.set(child.team.name, g.level + 1);
      }
    }
  }
  for (const entry of topology.cockpitEntries) {
    if (entry.kind === "team") {
      teamGroup.set(entry.team.name, null);
      teamLevel.set(entry.team.name, 0);
    }
  }
  return { groups, teamGroup, teamLevel };
}

function parentToTeam(
  p: ParentDiscovery,
  group: string | null,
  level: number,
): TopoTeam {
  const team: TopoTeam = {
    name: p.name,
    kind: "parent",
    group,
    level,
    atmux_dir: p.atmux_dir,
    worktree: p.worktree,
    branch: p.branch,
    cage_socket: p.cage_socket,
    cage_alive: p.cage_alive,
    kanban: p.kanban,
    in_cockpit_registry: true,
    last_activity: maxIso(p.last_commit, p.kanban?.last_activity ?? null),
    epics: p.epics.map((e) => epicToManifestEpic(e, p.kanban)),
  };
  if (p.soft_stopped) team.soft_stopped = true;
  return team;
}

function epicToManifestEpic(e: EpicDiscovery, parentKanban: KanbanProbe | null): TopoEpic {
  // id-precise join against the parent's epic_ids list. When the
  // parent kanban probe failed or the IO didn't populate epic_ids we
  // surface null so the classifier doesn't treat unknown as absent.
  let inParentKanban: boolean | null;
  if (parentKanban === null || parentKanban.epic_ids === undefined) {
    inParentKanban = null;
  } else {
    inParentKanban = parentKanban.epic_ids.includes(e.eid);
  }

  const epic: TopoEpic = {
    eid: e.eid,
    kind: "epic",
    parent: e.parent,
    atmux_dir: e.atmux_dir,
    worktree: e.worktree,
    branch: e.branch,
    cage_socket: e.cage_socket,
    cage_alive: e.cage_alive,
    kanban: e.kanban,
    in_cockpit_registry: true,
    in_parent_kanban: inParentKanban,
    branch_ahead_of_trunk: e.ahead,
    branch_merged_to_trunk: e.merged,
    last_activity: maxIso(e.last_commit, e.kanban?.last_activity ?? null),
  };
  if (e.soft_stopped) epic.soft_stopped = true;
  return epic;
}
