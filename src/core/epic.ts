// Epic orchestration — bash spec: lib/epic.sh @ worktree-frozen.
//
// Per ADR-007 state machine:
//   planning → ready → in-progress → review → done
//
// All CRUD goes through KanbanRepo (SQL-canonical per ADR-060); the
// state-machine + dispatch-summary side-effects live here so the verb
// layer stays thin (parser + display).

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { emit } from "../abstractions/events.ts";
import { exists } from "../abstractions/fs.ts";
import {
  closeDatabase,
  type Database,
  openDatabase,
  transactImmediate,
} from "../abstractions/sqlite.ts";
import { migrations } from "../abstractions/sqlite-migrations.ts";
import { KanbanCliAdapter } from "../adapters/kanban-cli.ts";
import { ConfigError, UsageError } from "../errors.ts";
import type { KanbanEpic, KanbanStory, KanbanTask } from "../schema/kanban.ts";
import { tryLoadTeam } from "./common.ts";
import { nextId } from "./id-sequence.ts";
import { nowEpoch } from "./kanban.ts";
import { externalKanbanEnabled } from "./kanban-backend.ts";
import { KanbanRepo } from "./repositories/kanban-repo.ts";

const STATES = ["planning", "ready", "in-progress", "review", "done"] as const;
const externalKanban = new KanbanCliAdapter();

function externalTaskStatus(status: EpicState): string {
  if (status === "planning") return "backlog";
  if (status === "ready") return "todo";
  return status;
}
export type EpicState = (typeof STATES)[number];

/** Bash `_atmux_epic_gen_id`: `e-<8 hex chars>`. */
export function genEpicId(): string {
  return `e-${randomBytes(4).toString("hex")}`;
}

/** Default forward step in the state machine. Returns null on terminal. */
export function epicNextState(s: string): EpicState | null {
  switch (s) {
    case "planning":
      return "ready";
    case "ready":
      return "in-progress";
    case "in-progress":
      return "review";
    case "review":
      return "done";
    default:
      return null;
  }
}

/** Legal transitions per bash `_atmux_epic_legal_transition`: same-state
 *  (idempotent) OR one forward step. */
export function epicLegalTransition(from: string, to: string): boolean {
  if (from === to) return true;
  return epicNextState(from) === to;
}

function _stateDbPath(atmuxDir: string): string {
  return join(atmuxDir, "state.db");
}

async function _withRepo<T>(
  atmuxDir: string,
  fn: (repo: KanbanRepo) => T | Promise<T>,
): Promise<T> {
  const db = openDatabase(_stateDbPath(atmuxDir), migrations);
  try {
    return await fn(new KanbanRepo(db));
  } finally {
    closeDatabase(db);
  }
}

/** Variant that exposes the raw Database alongside the repo. ADR-202
 *  §VIII consumers need it for `nextId(db, "e")` allocation inside
 *  the open write scope. */
async function _withDbAndRepo<T>(
  atmuxDir: string,
  fn: (db: Database, repo: KanbanRepo) => T | Promise<T>,
): Promise<T> {
  const db = openDatabase(_stateDbPath(atmuxDir), migrations);
  try {
    return await fn(db, new KanbanRepo(db));
  } finally {
    closeDatabase(db);
  }
}

export interface AddEpicOpts {
  title: string;
  body?: string;
  driverRef?: string;
  /** ADR-225 §Decision: upstream epic ids this new epic depends on.
   *  Validated synchronously inside the insert transaction —
   *  self-dep / non-existent / cycle all refuse with UsageError before
   *  the row lands. Defaults to `[]` (no deps). */
  dependsOn?: string[];
  /** ADR-231 §D3: per-epic orchd auto-spawn config. Written into the
   *  inserted row's `extra.autoSpawn` slot per the schema shape (Zod
   *  `KanbanEpic.extra.autoSpawn`, t-7-0ad1dfe3). Absent → no
   *  `autoSpawn` key in `extra` (epic falls back to per-team defaults
   *  match T-S1.3 OR off). Caller (verb-layer parseAddArgs) does the
   *  flag mutex enforcement so the operator sees parse errors before
   *  the DB write. */
  autoSpawn?: {
    enabled: boolean;
    roster?: string;
    forceSpawn?: boolean;
  };
}

/** Append an epic to the kanban; return its generated id. Mirrors bash
 *  `_atmux_epic_add` — `status: "planning"`, `createdAt` stamped now,
 *  `completedAt: null`, empty `stories[]`. */
export async function addEpic(atmuxDir: string, opts: AddEpicOpts): Promise<string> {
  const title = opts.title.trim();
  if (title.length === 0) {
    throw new UsageError({ what: "epic add: <title> required" });
  }
  if (await externalKanbanEnabled(atmuxDir)) {
    const id = await externalKanban.addTask(atmuxDir, {
      type: "epic",
      subject: title,
      ...(opts.body ? { body: opts.body } : {}),
      ...(opts.dependsOn ? { deps: opts.dependsOn } : {}),
    });
    await externalKanban.patchMetadata(atmuxDir, id, "atmux", {
      workflowStatus: "planning",
      isReady: false,
      ...(opts.driverRef ? { driverRef: opts.driverRef } : {}),
      ...(opts.autoSpawn ? { autoSpawn: opts.autoSpawn } : {}),
    });
    return id;
  }
  if (!(await exists(_stateDbPath(atmuxDir)))) {
    throw new ConfigError({
      what: `epic add: ${_stateDbPath(atmuxDir)} not initialized; run \`atmux init\` first`,
    });
  }
  const proposedDeps = opts.dependsOn ?? [];
  // ADR-202 §VIII — running-number ID per-team scoped via id_sequences.
  // Sequence increment + epic row insert run in the same transaction
  // so a rollback drops both.
  let assignedId = "";
  await _withDbAndRepo(atmuxDir, (db, repo) => {
    transactImmediate(db, () => {
      const id = nextId(db, "e");
      // ADR-225 §Validation: refuse self-dep / non-existent / cycle
      // BEFORE the row inserts so partial state never lands.
      _validateDeps(repo, id, proposedDeps, "epic add");
      const epic: KanbanEpic = {
        id,
        title,
        body: opts.body !== undefined && opts.body.length > 0 ? opts.body : null,
        status: "planning",
        driverRef:
          opts.driverRef !== undefined && opts.driverRef.length > 0 ? opts.driverRef : null,
        createdAt: nowEpoch(),
        completedAt: null,
        stories: [],
        dependsOn: proposedDeps,
        isReady: false,
      };
      // ADR-231 §D3 — fold per-epic autoSpawn config into the typed
      // `extra` slot (Zod shape from t-7-0ad1dfe3). KanbanEpic's
      // `.extra` round-trips through the JSON-extra spillover bag in
      // kanban-repo so unknown sibling keys (future per-epic config
      // classes) stay forward-compatible.
      if (opts.autoSpawn !== undefined) {
        const autoSpawn: NonNullable<NonNullable<KanbanEpic["extra"]>["autoSpawn"]> = {
          enabled: opts.autoSpawn.enabled,
        };
        if (opts.autoSpawn.roster !== undefined) autoSpawn.roster = opts.autoSpawn.roster;
        if (opts.autoSpawn.forceSpawn === true) autoSpawn.forceSpawn = true;
        epic.extra = { autoSpawn };
      }
      repo.upsertEpic(epic);
      assignedId = id;
    });
  });
  return assignedId;
}

/** ADR-225 §Validation: shared dep-list validator used by `addEpic`
 *  + `setEpicDependsOn`. Refuses on:
 *    1. **self-dep** — target id appears in `deps`.
 *    2. **non-existent dep** — a `deps` id doesn't resolve to an
 *       epic row (typo protection).
 *    3. **cycle** — walking transitive deps from any proposed dep
 *       reaches the target id.
 *
 *  Runs synchronously against the open repo so it composes inside the
 *  caller's `transactImmediate` and partial state never lands.
 *  `verb` is the verb label used in error messages (`epic add` /
 *  `epic set-depends-on`). */
function _validateDeps(
  repo: KanbanRepo,
  selfId: string,
  deps: readonly string[],
  verb: string,
): void {
  // 1. No self-dep.
  if (deps.includes(selfId)) {
    throw new UsageError({
      what: `${verb}: epic ${selfId} cannot depend on itself`,
    });
  }
  // 2. Each dep must resolve. We tolerate dangling refs at READ time
  // (epicTransitiveDeps), but at WRITE time we refuse — the caller
  // typed a wrong id.
  for (const d of deps) {
    if (repo.getEpic(d) === null) {
      throw new UsageError({
        what: `${verb}: dep ${d} does not exist (typo? deleted epic?)`,
      });
    }
  }
  // 3. No cycles. Walk transitive deps from each proposed dep; if
  // selfId appears in any chain, the new edge closes a cycle.
  for (const d of deps) {
    const chain = _walkTransitiveDeps(repo, d);
    if (chain.has(selfId)) {
      throw new UsageError({
        what:
          `${verb}: dep ${d} would close a cycle through ${selfId} ` +
          `(transitive chain from ${d}: ${[...chain].join(" → ")})`,
      });
    }
  }
}

/** BFS the dep-graph starting from `id`'s `dependsOn` (NOT id itself).
 *  Returns the set of all transitive dep ids. Dangling refs (deps
 *  pointing at missing epics) are skipped — render-side concern, not
 *  walk-time. Visited-set prevents infinite loops on pre-existing
 *  cycles (defense-in-depth; cycles should be impossible thanks to
 *  the eager validator above). */
function _walkTransitiveDeps(repo: KanbanRepo, id: string): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  const root = repo.getEpic(id);
  if (root !== null) queue.push(...(root.dependsOn ?? []));
  while (queue.length > 0) {
    // biome-ignore lint/style/noNonNullAssertion: length-guarded above
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    const e = repo.getEpic(next);
    if (e === null) continue; // dangling — skip, don't throw
    for (const d of e.dependsOn ?? []) queue.push(d);
  }
  // Include the seed id itself in the chain so cycle-error messages
  // are coherent ("e-A → e-B → e-A" instead of "e-B → e-A"). The
  // public `epicTransitiveDeps` API strips the seed (per AC: "excluding
  // `id` itself").
  seen.add(id);
  return seen;
}

/** ADR-225 §Decision — toggle the operator-greenlit bit. Refuses on
 *  `status='done'` epic (a done epic's eligibility is fully expressed
 *  by status; the bit is meaningless there). Does NOT emit
 *  `epic.ready` — event wiring lives in T6's events epic. Returns
 *  `{from, to, noop}` so the verb layer can render a sensible
 *  message + skip downstream side-effects on noop.
 *
 *  Operator-scope (not driver-scope) — decision-support, not
 *  destructive; any caller can flip. */
export async function setEpicReady(
  atmuxDir: string,
  id: string,
  ready: boolean,
): Promise<{ from: boolean; to: boolean; noop: boolean }> {
  if (await externalKanbanEnabled(atmuxDir)) {
    const epic = (await externalKanban.loadKanban(atmuxDir)).epics.find((item) => item.id === id);
    if (!epic) throw new ConfigError({ what: `epic ready: no such epic: ${id}` });
    if (epic.status === "done") {
      throw new UsageError({
        what: `epic ready: is_ready toggle on done epic ${id} is a no-op; refuse`,
      });
    }
    const from = epic.isReady;
    if (from !== ready)
      await externalKanban.patchMetadata(atmuxDir, id, "atmux", { isReady: ready });
    return { from, to: ready, noop: from === ready };
  }
  if (!(await exists(_stateDbPath(atmuxDir)))) {
    throw new ConfigError({ what: `epic ready: no such epic: ${id}` });
  }
  return await _withDbAndRepo(atmuxDir, (db, repo) => {
    let result: { from: boolean; to: boolean; noop: boolean } = {
      from: false,
      to: ready,
      noop: false,
    };
    let shouldEmitReady = false;
    let emitTransitionedAt = 0;
    transactImmediate(db, () => {
      const epic = repo.getEpic(id);
      if (epic === null) {
        throw new ConfigError({ what: `epic ready: no such epic: ${id}` });
      }
      if (epic.status === "done") {
        throw new UsageError({
          what: `epic ready: is_ready toggle on done epic ${id} is a no-op; refuse`,
        });
      }
      const from = epic.isReady;
      if (from === ready) {
        result = { from, to: ready, noop: true };
        return;
      }
      repo.upsertEpic({ ...epic, isReady: ready });
      result = { from, to: ready, noop: false };
      // ADR-225 §Events — emit `epic.ready` on the 0→1 transition
      // only. 1→0 downgrades are silent per the ADR (orchd polls vs.
      // event-driven for the false case). Defer the emit until after
      // the transaction returns so the events INSERT lands outside
      // the parent transaction's lock window (events table is the
      // same db, but BEGIN IMMEDIATE serializes them safely).
      if (from === false && ready === true) {
        shouldEmitReady = true;
        emitTransitionedAt = nowEpoch();
      }
    });
    if (shouldEmitReady) {
      emit(db, {
        topic: "epic.ready",
        epicId: id,
        transitionedAt: emitTransitionedAt,
      });
    }
    return result;
  });
}

/** ADR-225 §Decision — replace the dep list on an existing epic.
 *  Same validation matrix as `addEpic`: self / existence / cycle.
 *  Caller passes the FULL new list (no in-place add/remove at this
 *  layer — the CLI verb owns the merge ergonomics). */
export async function setEpicDependsOn(
  atmuxDir: string,
  id: string,
  deps: readonly string[],
): Promise<void> {
  if (await externalKanbanEnabled(atmuxDir)) {
    const epics = (await externalKanban.loadKanban(atmuxDir)).epics;
    const epic = epics.find((item) => item.id === id);
    if (!epic) throw new ConfigError({ what: `epic set-depends-on: no such epic: ${id}` });
    if (deps.includes(id))
      throw new UsageError({ what: `epic set-depends-on: epic ${id} cannot depend on itself` });
    for (const dependency of deps) {
      if (!epics.some((item) => item.id === dependency)) {
        throw new UsageError({
          what: `epic set-depends-on: dep ${dependency} does not exist (typo? deleted epic?)`,
        });
      }
    }
    await externalKanban.updateTask(atmuxDir, id, "atmux", { dependencies: deps });
    return;
  }
  if (!(await exists(_stateDbPath(atmuxDir)))) {
    throw new ConfigError({ what: `epic set-depends-on: no such epic: ${id}` });
  }
  await _withDbAndRepo(atmuxDir, (db, repo) => {
    transactImmediate(db, () => {
      const epic = repo.getEpic(id);
      if (epic === null) {
        throw new ConfigError({ what: `epic set-depends-on: no such epic: ${id}` });
      }
      _validateDeps(repo, id, deps, "epic set-depends-on");
      repo.upsertEpic({ ...epic, dependsOn: [...deps] });
    });
  });
}

/** ADR-225 §Decision — flattened set of transitive dep ids reachable
 *  from `id`'s `dependsOn` chain. Excludes `id` itself per the AC.
 *  Used by both cycle-detect (internal) AND the `epic deps` render
 *  verb (T4). Dangling refs are silently skipped. */
export async function epicTransitiveDeps(atmuxDir: string, id: string): Promise<string[]> {
  if (await externalKanbanEnabled(atmuxDir)) {
    const epics = (await externalKanban.loadKanban(atmuxDir)).epics;
    const byID = new Map(epics.map((epic) => [epic.id, epic]));
    const seen = new Set<string>();
    const queue = [...(byID.get(id)?.dependsOn ?? [])];
    while (queue.length) {
      const dependency = queue.shift();
      if (!dependency || seen.has(dependency)) continue;
      seen.add(dependency);
      queue.push(...(byID.get(dependency)?.dependsOn ?? []));
    }
    seen.delete(id);
    return [...seen];
  }
  if (!(await exists(_stateDbPath(atmuxDir)))) return [];
  return await _withRepo(atmuxDir, (repo) => {
    const chain = _walkTransitiveDeps(repo, id);
    chain.delete(id); // AC: excluding `id` itself.
    return [...chain];
  });
}

export interface EpicEligibility {
  eligible: boolean;
  blockers: string[];
}

/** ADR-225 §Eligibility — `eligible=true` IFF `isReady=true` AND
 *  every direct dep resolves to a `status='done'` epic. `done` is
 *  the bar (not `review`) because review can roll back via unsignoff;
 *  only done is terminal.
 *
 *  Note: only DIRECT deps are checked (not transitive). The graph is
 *  closed under dep-resolution — if A deps B and B deps C, then B
 *  cannot reach `done` until C is `done` (epic state machine guards
 *  this), so direct-only is sound + cheap. Saves an O(N) walk per
 *  spawn-eligibility tick (hot path for orchd Phase 2).
 *
 *  `blockers[]` is empty when eligible; otherwise enumerates
 *  human-readable refusal reasons so the spawn-epic gate can render
 *  an actionable message. */
export async function epicIsEligible(atmuxDir: string, id: string): Promise<EpicEligibility> {
  if (await externalKanbanEnabled(atmuxDir)) {
    const epics = (await externalKanban.loadKanban(atmuxDir)).epics;
    const epic = epics.find((item) => item.id === id);
    if (!epic) return { eligible: false, blockers: [`epic ${id}: not found`] };
    const blockers: string[] = [];
    if (!epic.isReady) blockers.push("is_ready=0");
    for (const dependency of epic.dependsOn ?? []) {
      const upstream = epics.find((item) => item.id === dependency);
      if (!upstream) blockers.push(`dep ${dependency} missing`);
      else if (upstream.status !== "done")
        blockers.push(`dep ${dependency} not done (status=${upstream.status})`);
    }
    return { eligible: blockers.length === 0, blockers };
  }
  if (!(await exists(_stateDbPath(atmuxDir)))) {
    return { eligible: false, blockers: [`epic ${id}: state.db not initialized`] };
  }
  return await _withRepo(atmuxDir, (repo) => {
    const epic = repo.getEpic(id);
    if (epic === null) {
      return { eligible: false, blockers: [`epic ${id}: not found`] };
    }
    const blockers: string[] = [];
    if (!epic.isReady) blockers.push("is_ready=0");
    for (const d of epic.dependsOn ?? []) {
      const dep = repo.getEpic(d);
      if (dep === null) {
        blockers.push(`dep ${d} missing`);
        continue;
      }
      if (dep.status !== "done") {
        blockers.push(`dep ${d} not done (status=${dep.status ?? "planning"})`);
      }
    }
    return { eligible: blockers.length === 0, blockers };
  });
}

export interface ListEpicsFilter {
  status?: string;
}

export async function listEpics(
  atmuxDir: string,
  filter: ListEpicsFilter = {},
): Promise<KanbanEpic[]> {
  if (await externalKanbanEnabled(atmuxDir)) {
    const epics = (await externalKanban.loadKanban(atmuxDir)).epics;
    return filter.status ? epics.filter((epic) => epic.status === filter.status) : epics;
  }
  if (!(await exists(_stateDbPath(atmuxDir)))) return [];
  return await _withRepo(atmuxDir, (repo) => {
    let epics = repo.listEpics();
    if (filter.status !== undefined) {
      const s = filter.status;
      epics = epics.filter((e) => e.status === s);
    }
    // Bash sort_by(.createdAt // 0) — already covered by KanbanRepo ORDER BY.
    return epics;
  });
}

/** Full epic with joined children (stories + direct tasks). Bash's
 *  `_atmux_epic_show --json` shape mirror. */
export interface EpicWithChildren extends KanbanEpic {
  stories: string[];
  storyRows: KanbanStory[];
  tasks: KanbanTask[];
}

export async function showEpic(atmuxDir: string, id: string): Promise<EpicWithChildren | null> {
  if (await externalKanbanEnabled(atmuxDir)) {
    const board = await externalKanban.loadKanban(atmuxDir);
    const epic = board.epics.find((item) => item.id === id);
    if (!epic) return null;
    const storyRows = board.stories.filter((story) => story.epic === id);
    const tasks = board.tasks.filter((task) => task.epic === id && !task.story);
    return { ...epic, stories: storyRows.map((story) => story.id), storyRows, tasks };
  }
  if (!(await exists(_stateDbPath(atmuxDir)))) return null;
  return await _withRepo(atmuxDir, (repo) => {
    const epic = repo.getEpic(id);
    if (epic === null) return null;
    const storyRows = repo.listStories({ epic: id });
    const tasks = repo.listTasks({ epic: id });
    return {
      ...epic,
      stories: epic.stories ?? [],
      storyRows,
      tasks,
    };
  });
}

/** Comma-joined ids of stories + direct-tasks-with-no-story that are
 *  not yet `done`. Empty string means safe to advance to review/done. */
export async function epicBlockingChildren(atmuxDir: string, id: string): Promise<string[]> {
  if (await externalKanbanEnabled(atmuxDir)) {
    const shown = await showEpic(atmuxDir, id);
    if (!shown) return [];
    return [
      ...shown.storyRows.filter((story) => story.status !== "done").map((story) => story.id),
      ...shown.tasks.filter((task) => task.status !== "done").map((task) => task.id),
    ];
  }
  if (!(await exists(_stateDbPath(atmuxDir)))) return [];
  return await _withRepo(atmuxDir, (repo) => {
    const stories = repo.listStories({ epic: id }).filter((s) => s.status !== "done");
    const directTasks = repo
      .listTasks({ epic: id })
      .filter((t) => (t.story === null || t.story === undefined) && t.status !== "done");
    return [...stories.map((s) => s.id), ...directTasks.map((t) => t.id)];
  });
}

export interface AdvanceEpicResult {
  from: string;
  to: string;
  /** When non-null, a dispatch-summary task was minted (only on review entry). */
  summaryTaskId: string | null;
  /** When true, the call was a no-op (already in target state). */
  noop: boolean;
}

/** Advance an epic by one state (or `--to` if explicit). Mirrors bash
 *  `_atmux_epic_advance`: legal-transition gate, children-clearance gate
 *  on review/done, completedAt stamp on done, summary auto-dispatch on
 *  review entry. */
export async function advanceEpic(
  atmuxDir: string,
  id: string,
  target?: string,
): Promise<AdvanceEpicResult> {
  if (await externalKanbanEnabled(atmuxDir)) {
    const epic = await showEpic(atmuxDir, id);
    if (!epic) throw new ConfigError({ what: `epic advance: no such epic: ${id}` });
    const cur = epic.status ?? "planning";
    const resolved = target?.length ? target : epicNextState(cur);
    if (resolved === null)
      throw new UsageError({ what: `epic advance: ${id} is in terminal state '${cur}'` });
    if (!epicLegalTransition(cur, resolved)) {
      throw new UsageError({
        what: `epic advance: illegal transition ${cur} → ${resolved} (machine: planning→ready→in-progress→review→done)`,
      });
    }
    if (cur === resolved) return { from: cur, to: resolved, summaryTaskId: null, noop: true };
    if (
      (resolved === "review" || resolved === "done") &&
      (await epicBlockingChildren(atmuxDir, id)).length
    ) {
      throw new UsageError({
        what: `epic advance: cannot advance ${id} to ${resolved} — blocking children: ${(await epicBlockingChildren(atmuxDir, id)).join(",")}`,
      });
    }
    await externalKanban.transitionTask(
      atmuxDir,
      id,
      externalTaskStatus(resolved as EpicState),
      "atmux",
      { workflowStatus: resolved },
    );
    return { from: cur, to: resolved, summaryTaskId: null, noop: false };
  }
  if (!(await exists(_stateDbPath(atmuxDir)))) {
    throw new ConfigError({ what: `epic advance: no such epic: ${id}` });
  }
  return await _withDbAndRepo(atmuxDir, async (db, repo) => {
    const epic = repo.getEpic(id);
    if (epic === null) {
      throw new ConfigError({ what: `epic advance: no such epic: ${id}` });
    }
    const cur = epic.status ?? "planning";
    const resolved = target !== undefined && target.length > 0 ? target : epicNextState(cur);
    if (resolved === null) {
      throw new UsageError({ what: `epic advance: ${id} is in terminal state '${cur}'` });
    }
    if (!epicLegalTransition(cur, resolved)) {
      throw new UsageError({
        what:
          `epic advance: illegal transition ${cur} → ${resolved} ` +
          `(machine: planning→ready→in-progress→review→done)`,
      });
    }
    if (cur === resolved) {
      return { from: cur, to: resolved, summaryTaskId: null, noop: true };
    }
    if (resolved === "review" || resolved === "done") {
      const blocking = [
        ...repo
          .listStories({ epic: id })
          .filter((s) => s.status !== "done")
          .map((s) => s.id),
        ...repo
          .listTasks({ epic: id })
          .filter((t) => (t.story === null || t.story === undefined) && t.status !== "done")
          .map((t) => t.id),
      ];
      if (blocking.length > 0) {
        throw new UsageError({
          what:
            `epic advance: cannot advance ${id} to ${resolved} — ` +
            `blocking children: ${blocking.join(",")}`,
        });
      }
    }
    const now = nowEpoch();
    const updated: KanbanEpic = {
      ...epic,
      status: resolved,
    };
    if (resolved === "done") updated.completedAt = now;
    repo.upsertEpic(updated);
    let summaryTaskId: string | null = null;
    if (resolved === "review") {
      summaryTaskId = await dispatchEpicSummary(atmuxDir, repo, db, id);
    }
    // ADR-225 §Events — `epic.unblocked`. Fires when THIS transition
    // (to `done`) clears the LAST unmet dep of any downstream epic.
    // Per ADR-225 OQ §4: fire only on the transition that clears the
    // LAST unmet dep — not on every dep transition. The per-dep
    // transition is still observable via the upstream `epic.advance`
    // chain; we deduplicate by emitting the all-deps-done event once.
    //
    // Scan: every epic where `id` appears in `depends_on`. For each
    // such A, recompute the deps-done predicate post-flip (this epic
    // is now done). If A's deps-done predicate now passes AND it had
    // ≥1 unmet dep before the flip (i.e. this transition is what
    // tipped the balance), emit. The check is "after my flip, A's
    // remaining unmet-deps count would be 0" — since we just landed
    // the flip, query the current state.
    //
    // Critically NOT gated on isReady — per ADR-225, this is the
    // dep-graph event. Consumers (orchd, cockpit-mirror) join with
    // is_ready=1 at read time when they want the combined
    // eligibility predicate.
    if (resolved === "done") {
      const allEpics = repo.listEpics();
      for (const a of allEpics) {
        if (a.id === id) continue;
        const deps = a.dependsOn ?? [];
        if (!deps.includes(id)) continue;
        // A depends on the epic we just flipped. Re-check A's
        // deps-done state.
        const stillUnmet = deps.filter((d) => {
          if (d === id) return false; // we just flipped this one to done
          const depEpic = repo.getEpic(d);
          // Dangling refs are treated as unmet so we don't emit
          // unblocked while A has a typo dep that should refuse the
          // operator at the validator boundary (`setEpicDependsOn`)
          // anyway. Belt-and-suspenders against bad state.
          return depEpic === null || depEpic.status !== "done";
        });
        if (stillUnmet.length === 0) {
          emit(db, {
            topic: "epic.unblocked",
            epicId: a.id,
            byEpicId: id,
            transitionedAt: now,
          });
        }
      }
    }
    return { from: cur, to: resolved, summaryTaskId, noop: false };
  });
}

/** Mint a `draft Epic summary <eid>` in-progress task assigned to the
 *  team-lead. Bash `_atmux_epic_dispatch_summary` mirror. Looks the lead
 *  up by ROLE so a team that named its lead anything other than 'lead'
 *  still routes correctly. */
async function dispatchEpicSummary(
  atmuxDir: string,
  repo: KanbanRepo,
  db: Database,
  eid: string,
): Promise<string> {
  // Per t-85846a0b (cluster 5 of t-2b801707 fix): use `dir: atmuxDir`
  // not `teamDir: atmuxDir`. `teamDir` is the parent-of-.atmux per
  // ResolveDirOpts semantics; passing the .atmux path itself caused
  // a double-`.atmux` lookup that always missed the test fixture's
  // team.json. Sibling fix to story.ts:186.
  const team = await tryLoadTeam({ dir: atmuxDir });
  const leadMember = team?.members.find((m) => m.role === "team-lead");
  if (leadMember === undefined) {
    throw new ConfigError({
      what: "epic dispatch-summary: no member with role=team-lead in team.json",
    });
  }
  // ADR-202 §VIII — running-number task ID.
  const tid = nextId(db, "t");
  const now = nowEpoch();
  const task: KanbanTask = {
    id: tid,
    subject: `draft Epic summary ${eid}`,
    body:
      `Epic ${eid} has entered review. Compose summary: title, child stories, key decisions, deltas. ` +
      `Source: \`atmux epic show ${eid}\`.`,
    status: "in-progress",
    owner: leadMember.name,
    deps: [],
    priority: 1,
    lane: "misc",
    createdAt: now,
    claimedAt: now,
    completedAt: null,
  };
  repo.addTask(task);
  return tid;
}

// Re-export the schema type so verb-layer imports stay together.
export type { KanbanEpic };
