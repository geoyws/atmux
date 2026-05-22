// ADR-222 §D3 — pure-function fleet topography aggregator.
//
// `aggregateTopo(io)` walks the cockpit-anchored fleet (cockpit →
// parent teams → epic-teams) and returns a `TopoManifest` matching the
// stable JSON shape pinned at ADR-222 §D2 (`schema_version: 1`). The
// classifier at `src/core/orphan-detector.ts` (sibling task t-4b1c831d)
// is the consumer that fills `orphans[]` — this aggregator emits the
// raw cockpit-anchored view with `orphans: []` empty and a fully
// populated `cockpit` + `teams[]` + `summary` block.
//
// Per ADR-222 §D5 the aggregator NEVER throws on a per-source failure
// — every probe in `TopoIO` is typed to a nullable return, and the
// aggregator narrows the null to a manifest-row state (`cage_alive:
// false`, `kanban: null`, `branch: null`, etc.). The verb-level
// formatter renders the failure shape; downstream consumers (cockpit-
// mirror Rust crate, doctor probes, ADR-223 reap) pin on it.
//
// Pure: deterministic for a given `io`. Tests inject a stub IO whose
// methods return canned shapes; production wires the IO in the verb
// layer (sibling task t-cd382b92). No `Bun.spawn`, no `Database`, no
// fs reads inside this module — that's R4-style separation per
// ADR-007 + the §D3 "aggregator NEVER reads sources directly" rule
// the reviewer enforces.
//
// Performance: each parent team's probes run in parallel
// (`Promise.all`); each parent's epics are then probed in parallel
// against each other. The IO shim is expected to enforce per-probe
// timeouts (500ms for tmux, 1s for git per §D5) — the aggregator
// itself does not race timers; it trusts the IO contract.
//
// Stable ordering (§D5 "Determinism"): teams sorted alphabetically by
// `name`; epics within each team sorted by `eid` lexicographic.
// `generated_at` formatted to 3-digit ms precision UTC. The cockpit-
// mirror Rust crate pins on this ordering for diff stability.

import { join } from "node:path";
import type { LoadedCockpit } from "./cockpit.ts";

// ---------- Manifest types (the §D2 contract) ----------

/** Top-level manifest. Output of {@link aggregateTopo}; consumed by
 *  cockpit-mirror, doctor probes, ADR-223 reap, operator dotfiles.
 *  Stable shape per ADR-222 §D2 — additive-only on `schema_version: 1`. */
export interface TopoManifest {
  schema_version: 1;
  /** ISO 8601 UTC, 3-digit ms precision (e.g. `2026-05-22T13:54:00.123Z`). */
  generated_at: string;
  cockpit: TopoCockpit;
  /** Sorted alphabetically by `name`. */
  teams: TopoTeam[];
  /** Empty in the aggregator output — filled by the orphan-detector
   *  classifier (sibling t-4b1c831d). The verb-layer composer wires
   *  both together. */
  orphans: TopoOrphan[];
  summary: TopoSummary;
}

/** Cockpit singleton block. */
export interface TopoCockpit {
  /** Cockpit tmux socket absolute path (e.g. `/tmp/.tmux-1000/atmux-cockpit`). */
  socket: string;
  /** Result of the cockpit-socket liveness probe. */
  alive: boolean;
  /** Resolved cockpit.json path even when {@link TopoIO.readCockpit}
   *  returned null (so consumers can surface "registry expected at X
   *  but missing"). */
  registry_path: string;
  /** Count of top-level `sessions[]` entries in cockpit.json. Zero when
   *  the cockpit read returned null. */
  sessions_count: number;
}

/** Parent-team row. Each row carries its own epic-team children inline. */
export interface TopoTeam {
  name: string;
  kind: "parent";
  atmux_dir: string;
  worktree: string;
  /** Current branch at the worktree; null when the worktree is not a
   *  git repo / the rev-parse probe failed. */
  branch: string | null;
  cage_socket: string;
  cage_alive: boolean;
  /** Kanban counts. Null when the per-team `state.db` was missing or
   *  locked (§D5 row 2). */
  kanban: KanbanProbe | null;
  /** Always `true` for rows enumerated from cockpit; the orphan-
   *  detector identifies disk-only teams missing from cockpit
   *  separately. Kept on the row so the classifier can short-circuit
   *  on `in_cockpit_registry: false` once it joins disk + cockpit
   *  views. */
  in_cockpit_registry: true;
  /** Max(last-commit, last-kanban-mutation). Null when both probes
   *  returned null. */
  last_activity: string | null;
  /** Inline epic-team children, sorted by `eid` lexicographic. */
  epics: TopoEpic[];
  /** ADR-087 — present only when the cockpit row carries
   *  `soft_stopped_at`. The aggregator surfaces the flag; orphan
   *  classifier treats `cage_alive: false` AS-INTENDED when this is
   *  true. */
  soft_stopped?: boolean;
}

/** Epic-team row. Always nested under its parent in {@link TopoTeam.epics}. */
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
  /** True iff the parent team's kanban has an epic row for this `eid`.
   *  False when the parent kanban probe succeeded and the row was
   *  absent. Null when the parent kanban probe failed (cannot tell). */
  in_parent_kanban: boolean | null;
  /** Count of commits on the epic-team branch ahead of trunk. Null on
   *  git probe failure / timeout per §D5 row 5. */
  branch_ahead_of_trunk: number | null;
  /** True iff the epic-team branch is fully merged into trunk. Null on
   *  git probe failure / timeout per §D5 row 5. */
  branch_merged_to_trunk: boolean | null;
  last_activity: string | null;
  soft_stopped?: boolean;
}

/** Kanban probe shape. Per ADR-222 §D3, the IO returns counts derived
 *  from `<atmuxDir>/state.db` opened read-only. Additive on
 *  `schema_version: 1` — surfaces in the manifest's `kanban` field. */
export interface KanbanProbe {
  /** Parent teams only — count of epic rows in the kanban. Omitted for
   *  epic-team kanban probes (epic-team state.db doesn't store nested
   *  epics). */
  epics?: number;
  /** Parent teams only — every epic id present in the kanban. Internal
   *  to the join that computes {@link TopoEpic.in_parent_kanban}; the
   *  manifest carries it for downstream consumers that want the same
   *  join without re-querying. Omitted for epic-team probes. */
  epic_ids?: string[];
  /** Count of tasks NOT in a terminal status (todo / in-progress / blocked). */
  tasks_open: number;
  /** Count of tasks in `done` status. */
  tasks_done: number;
  /** `MAX(updated_at)` across the kanban tables, formatted as ISO 8601
   *  UTC with 3-digit ms precision. Null when the table is empty. */
  last_activity: string | null;
}

/** Orphan-detector output row (consumed by the manifest's `orphans[]`
 *  array; aggregator emits empty + the verb-level composer fills). */
export interface TopoOrphan {
  /** Enum literal from ADR-222 §D4 (e.g. `cage-tmux-without-registry`). */
  class: string;
  /** Identifier the operator recognizes (eid / team name / cron marker). */
  ref: string;
  /** Filesystem hint when applicable. */
  atmux_dir?: string;
  details: string;
  /** ISO 8601 UTC — first observation timestamp per ADR-222 §D4 carve-out. */
  first_seen: string;
  /** Operator-facing suggested next command. */
  reap_hint?: string;
}

/** Summary block — counts + wall-time. `elapsed_ms` is the aggregator's
 *  own runtime (orphan classifier + render add their own time on top
 *  in the verb layer). */
export interface TopoSummary {
  teams_count: number;
  epics_count: number;
  cages_alive: number;
  /** Always zero in the aggregator output; verb-layer composer rewrites
   *  this after the orphan-detector runs. */
  orphans_count: number;
  elapsed_ms: number;
}

// ---------- IO shim (the §D3 data-source injection contract) ----------

/** Every data source the aggregator consumes goes through this shim.
 *  Tests stub each method to drive deterministic per-failure-mode rows;
 *  production impl wires real fs / sqlite / tmux / git in the verb
 *  layer per ADR-007's "subprocess calls live in abstractions" rule.
 *
 *  Every method that probes a fallible source returns a nullable: null
 *  means "source failed, carry the failure on the row" per ADR-222 §D5.
 *  Methods that don't probe (pure path resolvers, `now`) never return
 *  null. */
export interface TopoIO {
  /** Read + parse the cockpit registry. Returns null per ADR-222 §D5
   *  row 1 when cockpit.json is missing / unreadable / parse-broken.
   *  Aggregator emits the minimal manifest in that case. */
  readCockpit(): Promise<LoadedCockpit | null>;

  /** Resolved cockpit registry path. Returned even when readCockpit()
   *  yielded null so the manifest's `cockpit.registry_path` field
   *  always carries the expected path. */
  cockpitRegistryPath(): string;

  /** Resolved cockpit tmux socket path. Stable regardless of liveness. */
  cockpitSocketPath(): string;

  /** Probe `tmux -S <socket> list-sessions`. Returns true on success,
   *  false on any failure (timeout, missing socket, spawn error) per
   *  ADR-222 §D5 row 3. The 500ms per-socket timeout is enforced
   *  inside the IO impl, not here. */
  cageAlive(socket: string): Promise<boolean>;

  /** Open `<atmuxDir>/state.db` read-only and probe kanban counts +
   *  last mutation. Returns null per ADR-222 §D5 row 2 when the file
   *  is missing / locked / corrupt. `opts.parent` toggles inclusion of
   *  the `epics` count (parent kanban has epics; epic-team kanban
   *  doesn't). */
  readKanban(atmuxDir: string, opts: { parent: boolean }): Promise<KanbanProbe | null>;

  /** Resolve the worktree's current branch via `git rev-parse
   *  --abbrev-ref HEAD`. Returns null per ADR-222 §D5 row 6 when the
   *  worktree is not a git repo or the rev-parse failed. */
  gitCurrentBranch(worktreePath: string): Promise<string | null>;

  /** ISO timestamp of the worktree's HEAD commit
   *  (`git log -1 --format=%cI`). Returns null when the probe failed
   *  (broken worktree) — `last_activity` falls back to kanban-only. */
  gitLastCommitAt(worktreePath: string): Promise<string | null>;

  /** Count commits on `branch` not on `base`
   *  (`git rev-list --count <base>..<branch>`). 1s per-branch timeout
   *  per ADR-222 §D5 row 5; null on timeout / failure. */
  gitAheadCount(repoPath: string, base: string, branch: string): Promise<number | null>;

  /** True iff `branch` is fully merged into `base`
   *  (`git merge-base --is-ancestor <branch> <base>`). 1s timeout per
   *  ADR-222 §D5 row 5; null on timeout / failure. */
  gitMergedInto(repoPath: string, base: string, branch: string): Promise<boolean | null>;

  /** Wall-clock at aggregation start. Stubbed in tests for stable
   *  `generated_at`. */
  now(): Date;
}

// ---------- Path computation (cage socket convention per ADR-162) ----------

/** Parent team cage socket: `/tmp/atmux-<team>/sock` per ADR-162. */
export function cageSocketForTeam(teamName: string): string {
  return `/tmp/atmux-${teamName}/sock`;
}

/** Epic-team cage socket:
 *  `/tmp/atmux-<parent>/epics/<eid>/tmux-0/default` per ADR-162. */
export function cageSocketForEpic(parentName: string, eid: string): string {
  return `/tmp/atmux-${parentName}/epics/${eid}/tmux-0/default`;
}

/** Parent team atmux dir = `<root>/.atmux`. */
export function atmuxDirForTeam(teamRoot: string): string {
  return join(teamRoot, ".atmux");
}

/** Epic-team worktree = `<parentRoot>/../atmux-epics/<eid>` per the
 *  convention `atmux team spawn-epic` uses (sibling to the parent
 *  worktree, not nested under it — keeps git operations on the parent
 *  worktree clean). */
export function worktreeForEpic(parentRoot: string, eid: string): string {
  return join(parentRoot, "..", "atmux-epics", eid);
}

/** Epic-team atmux dir = `<epicWorktree>/.atmux`. */
export function atmuxDirForEpic(parentRoot: string, eid: string): string {
  return join(worktreeForEpic(parentRoot, eid), ".atmux");
}

// ---------- Time formatting (deterministic ISO with 3-digit ms) ----------

/** Format a Date to ISO 8601 UTC with 3-digit ms precision. Bun's
 *  `Date.toISOString()` already conforms; this helper exists as the
 *  single canonical format site so any future shift (e.g. ns precision)
 *  lands here, not at N call sites. */
export function formatIsoMs(d: Date): string {
  return d.toISOString();
}

/** Return the later of two ISO timestamps; null when both are null. */
function maxIso(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
}

// ---------- Cockpit walk helpers ----------

/** Walk a {@link LoadedCockpit} and yield the parent-team rows in the
 *  shape the aggregator iterates over. Epic-teams nested under each
 *  parent come out as a separate list keyed by parent name (we walk
 *  every level of `sessions[]` because epic-teams can sit under
 *  arbitrarily-deep team nodes per ADR-089 §B). */
interface CockpitWalkResult {
  parents: Array<{ name: string; root: string; softStopped: boolean }>;
  epicsByParent: Map<string, Array<{ eid: string; sessionName: string; softStopped: boolean }>>;
}

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

// ---------- Aggregator entry ----------

/** Per ADR-222 §D3 — pure fleet aggregator. Walks cockpit → teams →
 *  epics, gathers per-source probes in parallel, returns the §D2
 *  manifest with `orphans: []` empty (classifier sibling t-4b1c831d
 *  fills that block in the verb-level composer). Never throws on
 *  per-source failure: every probe nullable is narrowed to a manifest-
 *  row failure state. */
export async function aggregateTopo(io: TopoIO): Promise<TopoManifest> {
  const start = io.now();
  const cockpitSocket = io.cockpitSocketPath();
  const cockpitRegistry = io.cockpitRegistryPath();

  const [cockpit, cockpitAlive] = await Promise.all([
    io.readCockpit(),
    io.cageAlive(cockpitSocket),
  ]);

  if (cockpit === null) {
    return finalize({
      generatedAt: start,
      cockpit: {
        socket: cockpitSocket,
        alive: cockpitAlive,
        registry_path: cockpitRegistry,
        sessions_count: 0,
      },
      teams: [],
      io,
      startedAt: start,
    });
  }

  const { parents, epicsByParent } = walkCockpit(cockpit);
  parents.sort((a, b) => a.name.localeCompare(b.name));

  const teams = await Promise.all(
    parents.map((p) => aggregateOneTeam(io, p, epicsByParent.get(p.name) ?? [])),
  );

  return finalize({
    generatedAt: start,
    cockpit: {
      socket: cockpitSocket,
      alive: cockpitAlive,
      registry_path: cockpitRegistry,
      sessions_count: cockpit.sessions.length,
    },
    teams,
    io,
    startedAt: start,
  });
}

interface FinalizeInput {
  generatedAt: Date;
  cockpit: TopoCockpit;
  teams: TopoTeam[];
  io: TopoIO;
  startedAt: Date;
}

function finalize(input: FinalizeInput): TopoManifest {
  const { cockpit, teams, io, startedAt } = input;
  const finishedAt = io.now();
  const elapsedMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());

  let cagesAlive = cockpit.alive ? 1 : 0;
  let epicsCount = 0;
  for (const team of teams) {
    if (team.cage_alive) cagesAlive += 1;
    epicsCount += team.epics.length;
    for (const epic of team.epics) {
      if (epic.cage_alive) cagesAlive += 1;
    }
  }

  return {
    schema_version: 1,
    generated_at: formatIsoMs(input.generatedAt),
    cockpit,
    teams,
    orphans: [],
    summary: {
      teams_count: teams.length,
      epics_count: epicsCount,
      cages_alive: cagesAlive,
      orphans_count: 0,
      elapsed_ms: elapsedMs,
    },
  };
}

async function aggregateOneTeam(
  io: TopoIO,
  parent: { name: string; root: string; softStopped: boolean },
  epicEntries: Array<{ eid: string; sessionName: string; softStopped: boolean }>,
): Promise<TopoTeam> {
  const atmuxDir = atmuxDirForTeam(parent.root);
  const worktree = parent.root;
  const cageSocket = cageSocketForTeam(parent.name);

  const [kanban, cageAlive, branch, lastCommit] = await Promise.all([
    io.readKanban(atmuxDir, { parent: true }),
    io.cageAlive(cageSocket),
    io.gitCurrentBranch(worktree),
    io.gitLastCommitAt(worktree),
  ]);

  const sortedEpics = [...epicEntries].sort((a, b) => a.eid.localeCompare(b.eid));
  // Trunk branch for ahead/merged probes = the parent's current branch.
  // When the parent branch probe failed, we surface null on both per-
  // epic gates (we can't do a meaningful base comparison without a base).
  const epics = await Promise.all(
    sortedEpics.map((e) => aggregateOneEpic(io, parent, e, branch, kanban)),
  );

  const team: TopoTeam = {
    name: parent.name,
    kind: "parent",
    atmux_dir: atmuxDir,
    worktree,
    branch,
    cage_socket: cageSocket,
    cage_alive: cageAlive,
    kanban,
    in_cockpit_registry: true,
    last_activity: maxIso(lastCommit, kanban?.last_activity ?? null),
    epics,
  };
  if (parent.softStopped) team.soft_stopped = true;
  return team;
}

async function aggregateOneEpic(
  io: TopoIO,
  parent: { name: string; root: string },
  entry: { eid: string; sessionName: string; softStopped: boolean },
  parentBranch: string | null,
  parentKanban: KanbanProbe | null,
): Promise<TopoEpic> {
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

  // `in_parent_kanban`: id-precise join against the parent kanban
  // probe's `epic_ids` list. When the parent kanban returned null we
  // can't tell — surface null so the classifier doesn't treat unknown
  // as absent. When the parent kanban omitted `epic_ids` (older IO
  // impl without the additive field) we conservatively return null
  // for the same reason.
  let inParentKanban: boolean | null;
  if (parentKanban === null || parentKanban.epic_ids === undefined) {
    inParentKanban = null;
  } else {
    inParentKanban = parentKanban.epic_ids.includes(entry.eid);
  }

  const epic: TopoEpic = {
    eid: entry.eid,
    kind: "epic",
    parent: parent.name,
    atmux_dir: atmuxDir,
    worktree,
    branch,
    cage_socket: cageSocket,
    cage_alive: cageAlive,
    kanban,
    in_cockpit_registry: true,
    in_parent_kanban: inParentKanban,
    branch_ahead_of_trunk: ahead,
    branch_merged_to_trunk: merged,
    last_activity: maxIso(lastCommit, kanban?.last_activity ?? null),
  };
  if (entry.softStopped) epic.soft_stopped = true;
  return epic;
}
