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
import { exists } from "../abstractions/fs.ts";
import { closeDatabase, openDatabase } from "../abstractions/sqlite.ts";
import { migrations } from "../abstractions/sqlite-migrations.ts";
import { ConfigError, UsageError } from "../errors.ts";
import type { KanbanEpic, KanbanStory, KanbanTask } from "../schema/kanban.ts";
import { tryLoadTeam } from "./common.ts";
import { nowEpoch } from "./kanban.ts";
import { KanbanRepo } from "./repositories/kanban-repo.ts";

const STATES = ["planning", "ready", "in-progress", "review", "done"] as const;
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

export interface AddEpicOpts {
  title: string;
  body?: string;
  driverRef?: string;
}

/** Append an epic to the kanban; return its generated id. Mirrors bash
 *  `_atmux_epic_add` — `status: "planning"`, `createdAt` stamped now,
 *  `completedAt: null`, empty `stories[]`. */
export async function addEpic(atmuxDir: string, opts: AddEpicOpts): Promise<string> {
  const title = opts.title.trim();
  if (title.length === 0) {
    throw new UsageError({ what: "epic add: <title> required" });
  }
  if (!(await exists(_stateDbPath(atmuxDir)))) {
    throw new ConfigError({
      what: `epic add: ${_stateDbPath(atmuxDir)} not initialized; run \`atmux init\` first`,
    });
  }
  const id = genEpicId();
  const epic: KanbanEpic = {
    id,
    title,
    body: opts.body !== undefined && opts.body.length > 0 ? opts.body : null,
    status: "planning",
    driverRef: opts.driverRef !== undefined && opts.driverRef.length > 0 ? opts.driverRef : null,
    createdAt: nowEpoch(),
    completedAt: null,
    stories: [],
  };
  await _withRepo(atmuxDir, (repo) => repo.upsertEpic(epic));
  return id;
}

export interface ListEpicsFilter {
  status?: string;
}

export async function listEpics(
  atmuxDir: string,
  filter: ListEpicsFilter = {},
): Promise<KanbanEpic[]> {
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
  if (!(await exists(_stateDbPath(atmuxDir)))) {
    throw new ConfigError({ what: `epic advance: no such epic: ${id}` });
  }
  return await _withRepo(atmuxDir, async (repo) => {
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
      summaryTaskId = await dispatchEpicSummary(atmuxDir, repo, id);
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
  const tid = `t-${randomBytes(4).toString("hex")}`;
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
