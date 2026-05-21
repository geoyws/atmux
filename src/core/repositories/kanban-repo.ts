// ADR-060 §D3: kanban repository — typed SQLite columns (v11+).
//
// Core kanban entities no longer round-trip through untyped JSON blobs
// (`extra`, JSON-encoded `deps`, etc.). Unknown fields fail at the Zod
// write boundary instead of landing in a catch-all column.

import type { Database } from "bun:sqlite";
import {
  type KanbanEpic,
  KanbanEpic as KanbanEpicSchema,
  type KanbanStory,
  KanbanStory as KanbanStorySchema,
  type KanbanTask,
  KanbanTask as KanbanTaskSchema,
} from "../../schema/kanban.ts";

interface TaskRow {
  id: string;
  subject: string | null;
  body: string | null;
  status: string | null;
  owner: string | null;
  priority: number | null;
  epic: string | null;
  story: string | null;
  lane: string | null;
  deliverable: string | null;
  stale_min: number | null;
  driver_only: number | null;
  created_at: number | null;
  claimed_at: number | null;
  completed_at: number | null;
  note: string | null;
  role: string | null;
  claimed_from_owner: string | null;
  claimed_from_ts: number | null;
  created_from_tag: string | null;
  created_from_parent_task_id: string | null;
  created_from_depth: number | null;
}

interface EpicRow {
  id: string;
  title: string | null;
  body: string | null;
  status: string | null;
  driver_ref: string | null;
  created_at: number | null;
  completed_at: number | null;
  epic_team_name: string | null;
  epic_team_root: string | null;
  pr_number: number | null;
  pr_state: string | null;
  note: string | null;
}

interface StoryRow {
  id: string;
  epic: string | null;
  title: string | null;
  body: string | null;
  acceptance_criteria: string | null;
  status: string | null;
  created_at: number | null;
  completed_at: number | null;
  advanced_at: number | null;
  review_signoff: number | null;
  merge_task_id: string | null;
  merge_mode: string | null;
}

interface SignoffEventRow {
  event_kind: string;
  actor: string | null;
  event_at: number;
  note: string | null;
}

function _claimedFromFromRow(row: TaskRow): KanbanTask["claimedFrom"] {
  if (row.claimed_from_owner !== null && row.claimed_from_ts !== null) {
    return { prevOwner: row.claimed_from_owner, ts: row.claimed_from_ts };
  }
  if (row.claimed_from_owner !== null) return row.claimed_from_owner;
  return undefined;
}

function _createdFromFromRow(row: TaskRow): KanbanTask["createdFrom"] {
  if (row.created_from_parent_task_id !== null) {
    const out: Record<string, unknown> = { parentTaskId: row.created_from_parent_task_id };
    if (row.created_from_depth !== null) out.depth = row.created_from_depth;
    return out;
  }
  if (row.created_from_tag !== null) return row.created_from_tag;
  return undefined;
}

export function taskFromRow(row: TaskRow, deps: ReadonlyArray<string> = []): KanbanTask {
  return KanbanTaskSchema.parse({
    id: row.id,
    subject: row.subject ?? undefined,
    body: row.body,
    status: row.status ?? undefined,
    owner: row.owner,
    deps: [...deps],
    priority: row.priority,
    epic: row.epic,
    story: row.story,
    lane: row.lane,
    deliverable: row.deliverable,
    staleMin: row.stale_min,
    driverOnly: row.driver_only === null ? undefined : row.driver_only === 1,
    createdAt: row.created_at ?? undefined,
    claimedAt: row.claimed_at,
    completedAt: row.completed_at,
    claimedFrom: _claimedFromFromRow(row),
    createdFrom: _createdFromFromRow(row),
    note: row.note,
    role: row.role,
  });
}

export function taskToRow(task: KanbanTask): TaskRow {
  let claimedFromOwner: string | null = null;
  let claimedFromTs: number | null = null;
  const cf = task.claimedFrom;
  if (typeof cf === "string") {
    claimedFromOwner = cf;
  } else if (cf !== null && cf !== undefined && typeof cf === "object") {
    const o = cf as Record<string, unknown>;
    if (typeof o.prevOwner === "string") claimedFromOwner = o.prevOwner;
    if (typeof o.ts === "number") claimedFromTs = o.ts;
  }

  let createdFromTag: string | null = null;
  let createdFromParent: string | null = null;
  let createdFromDepth: number | null = null;
  const cr = task.createdFrom;
  if (typeof cr === "string") {
    createdFromTag = cr;
  } else if (cr !== null && cr !== undefined && typeof cr === "object") {
    const o = cr as Record<string, unknown>;
    if (typeof o.parentTaskId === "string") createdFromParent = o.parentTaskId;
    if (typeof o.depth === "number") createdFromDepth = o.depth;
  }

  return {
    id: task.id,
    subject: task.subject ?? null,
    body: task.body ?? null,
    status: task.status ?? null,
    owner: task.owner ?? null,
    priority: task.priority ?? null,
    epic: task.epic ?? null,
    story: task.story ?? null,
    lane: task.lane ?? null,
    deliverable: task.deliverable ?? null,
    stale_min: task.staleMin ?? null,
    driver_only: task.driverOnly === undefined ? null : task.driverOnly ? 1 : 0,
    created_at: task.createdAt ?? null,
    claimed_at: task.claimedAt ?? null,
    completed_at: task.completedAt ?? null,
    note: task.note ?? null,
    role: task.role ?? null,
    claimed_from_owner: claimedFromOwner,
    claimed_from_ts: claimedFromTs,
    created_from_tag: createdFromTag,
    created_from_parent_task_id: createdFromParent,
    created_from_depth: createdFromDepth,
  };
}

export function epicFromRow(row: EpicRow, stories: ReadonlyArray<string> = []): KanbanEpic {
  return KanbanEpicSchema.parse({
    id: row.id,
    title: row.title ?? undefined,
    body: row.body,
    status: row.status ?? undefined,
    driverRef: row.driver_ref,
    createdAt: row.created_at ?? undefined,
    completedAt: row.completed_at,
    stories: stories.length > 0 ? [...stories] : undefined,
    epicTeamName: row.epic_team_name,
    epicTeamRoot: row.epic_team_root,
    prNumber: row.pr_number,
    prState: row.pr_state,
    note: row.note,
  });
}

export function epicToRow(epic: KanbanEpic): EpicRow {
  return {
    id: epic.id,
    title: epic.title ?? null,
    body: epic.body ?? null,
    status: epic.status ?? null,
    driver_ref: epic.driverRef ?? null,
    created_at: epic.createdAt ?? null,
    completed_at: epic.completedAt ?? null,
    epic_team_name: epic.epicTeamName ?? null,
    epic_team_root: epic.epicTeamRoot ?? null,
    pr_number: epic.prNumber ?? null,
    pr_state: epic.prState ?? null,
    note: epic.note ?? null,
  };
}

function _signoffAuditFromEvents(rows: ReadonlyArray<SignoffEventRow>): KanbanStory["signoffAudit"] {
  if (rows.length === 0) return undefined;
  return rows.map((r) => {
    if (r.event_kind === "unsignoff") {
      return {
        unsignedBy: r.actor ?? "",
        unsignedAt: r.event_at,
        note: r.note,
      };
    }
    return {
      signedOffBy: r.actor ?? "",
      signedOffAt: r.event_at,
      note: r.note,
    };
  });
}

export function storyFromRow(
  row: StoryRow,
  signoffEvents: ReadonlyArray<SignoffEventRow> = [],
): KanbanStory {
  return KanbanStorySchema.parse({
    id: row.id,
    epic: row.epic,
    title: row.title ?? undefined,
    body: row.body,
    acceptanceCriteria: row.acceptance_criteria,
    status: row.status ?? undefined,
    createdAt: row.created_at ?? undefined,
    completedAt: row.completed_at,
    advancedAt: row.advanced_at,
    reviewSignoff: row.review_signoff === null ? undefined : row.review_signoff === 1,
    mergeTaskId: row.merge_task_id,
    mergeMode: row.merge_mode ?? undefined,
    signoffAudit: _signoffAuditFromEvents(signoffEvents),
  });
}

export function storyToRow(story: KanbanStory): StoryRow {
  return {
    id: story.id,
    epic: story.epic ?? null,
    title: story.title ?? null,
    body: story.body ?? null,
    acceptance_criteria: story.acceptanceCriteria ?? null,
    status: story.status ?? null,
    created_at: story.createdAt ?? null,
    completed_at: story.completedAt ?? null,
    advanced_at: story.advancedAt ?? null,
    review_signoff: story.reviewSignoff === undefined ? null : story.reviewSignoff ? 1 : 0,
    merge_task_id: story.mergeTaskId ?? null,
    merge_mode: story.mergeMode ?? null,
  };
}

type BindValue = string | number | null;
function bind(row: TaskRow | EpicRow | StoryRow): Record<string, BindValue> {
  const out: Record<string, BindValue> = {};
  for (const [k, v] of Object.entries(row)) out[`$${k}`] = v as BindValue;
  return out;
}

const TASK_COLS = `
  id, subject, body, status, owner, priority, epic, story, lane, deliverable,
  stale_min, driver_only, created_at, claimed_at, completed_at, note, role,
  claimed_from_owner, claimed_from_ts, created_from_tag, created_from_parent_task_id,
  created_from_depth
`;

const TASK_INSERT = `
  INSERT INTO tasks (${TASK_COLS})
  VALUES ($id, $subject, $body, $status, $owner, $priority, $epic, $story, $lane,
          $deliverable, $stale_min, $driver_only, $created_at, $claimed_at, $completed_at,
          $note, $role, $claimed_from_owner, $claimed_from_ts, $created_from_tag,
          $created_from_parent_task_id, $created_from_depth)
`;

const TASK_UPSERT = `
  ON CONFLICT(id) DO UPDATE SET
    subject=excluded.subject, body=excluded.body, status=excluded.status,
    owner=excluded.owner, priority=excluded.priority, epic=excluded.epic,
    story=excluded.story, lane=excluded.lane, deliverable=excluded.deliverable,
    stale_min=excluded.stale_min, driver_only=excluded.driver_only,
    created_at=excluded.created_at, claimed_at=excluded.claimed_at,
    completed_at=excluded.completed_at, note=excluded.note, role=excluded.role,
    claimed_from_owner=excluded.claimed_from_owner, claimed_from_ts=excluded.claimed_from_ts,
    created_from_tag=excluded.created_from_tag,
    created_from_parent_task_id=excluded.created_from_parent_task_id,
    created_from_depth=excluded.created_from_depth
`;

export interface TaskFilter {
  owner?: string;
  status?: string;
  lane?: string;
  epic?: string;
  story?: string;
}

export class KanbanRepo {
  constructor(private db: Database) {}

  private _listTaskDeps(taskId: string): string[] {
    const rows = this.db
      .query("SELECT dep_id FROM task_deps WHERE task_id = $id ORDER BY ord ASC, dep_id ASC")
      .all({ $id: taskId }) as Array<{ dep_id: string }>;
    return rows.map((r) => r.dep_id);
  }

  private _writeTaskDeps(taskId: string, deps: ReadonlyArray<string> | undefined): void {
    this.db.query("DELETE FROM task_deps WHERE task_id = $id").run({ $id: taskId });
    if (deps === undefined) return;
    deps.forEach((depId, ord) => {
      this.db
        .query("INSERT INTO task_deps (task_id, dep_id, ord) VALUES ($taskId, $depId, $ord)")
        .run({ $taskId: taskId, $depId: depId, $ord: ord });
    });
  }

  private _taskFromDbRow(row: TaskRow): KanbanTask {
    return taskFromRow(row, this._listTaskDeps(row.id));
  }

  private _listEpicStoryIds(epicId: string): string[] {
    const rows = this.db
      .query("SELECT id FROM stories WHERE epic = $epic ORDER BY created_at ASC, id ASC")
      .all({ $epic: epicId }) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  private _listSignoffEvents(storyId: string): SignoffEventRow[] {
    return this.db
      .query(
        `SELECT event_kind, actor, event_at, note FROM story_signoff_events
         WHERE story_id = $id ORDER BY event_at ASC, id ASC`,
      )
      .all({ $id: storyId }) as SignoffEventRow[];
  }

  private _writeSignoffEvents(
    storyId: string,
    audit: KanbanStory["signoffAudit"],
  ): void {
    this.db.query("DELETE FROM story_signoff_events WHERE story_id = $id").run({ $id: storyId });
    if (!Array.isArray(audit)) return;
    for (const entry of audit) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.signedOffBy === "string" && typeof e.signedOffAt === "number") {
        this.db
          .query(
            `INSERT INTO story_signoff_events (story_id, event_kind, actor, event_at, note)
             VALUES ($storyId, 'signoff', $actor, $eventAt, $note)`,
          )
          .run({
            $storyId: storyId,
            $actor: e.signedOffBy,
            $eventAt: e.signedOffAt,
            $note: typeof e.note === "string" ? e.note : null,
          });
      } else if (typeof e.unsignedBy === "string" && typeof e.unsignedAt === "number") {
        this.db
          .query(
            `INSERT INTO story_signoff_events (story_id, event_kind, actor, event_at, note)
             VALUES ($storyId, 'unsignoff', $actor, $eventAt, $note)`,
          )
          .run({
            $storyId: storyId,
            $actor: e.unsignedBy,
            $eventAt: e.unsignedAt,
            $note: typeof e.note === "string" ? e.note : null,
          });
      }
    }
  }

  addTask(task: KanbanTask): void {
    const row = taskToRow(task);
    this.db.query(`${TASK_INSERT}`).run(bind(row));
    if (task.deps !== undefined) {
      this._writeTaskDeps(task.id, task.deps);
    }
  }

  upsertTask(task: KanbanTask): void {
    const row = taskToRow(task);
    this.db.query(`${TASK_INSERT} ${TASK_UPSERT}`).run(bind(row));
    if (task.deps !== undefined) {
      this._writeTaskDeps(task.id, task.deps);
    }
  }

  getTask(id: string): KanbanTask | null {
    const row = this.db
      .query(`SELECT ${TASK_COLS} FROM tasks WHERE id = $id`)
      .get({ $id: id }) as TaskRow | null;
    return row ? this._taskFromDbRow(row) : null;
  }

  listTasks(filter: TaskFilter = {}): KanbanTask[] {
    const where: string[] = [];
    const params: Record<string, string> = {};
    if (filter.owner !== undefined) {
      where.push("owner = $owner");
      params.$owner = filter.owner;
    }
    if (filter.status !== undefined) {
      where.push("status = $status");
      params.$status = filter.status;
    }
    if (filter.lane !== undefined) {
      where.push("lane = $lane");
      params.$lane = filter.lane;
    }
    if (filter.epic !== undefined) {
      where.push("epic = $epic");
      params.$epic = filter.epic;
    }
    if (filter.story !== undefined) {
      where.push("story = $story");
      params.$story = filter.story;
    }
    const sql = `SELECT ${TASK_COLS} FROM tasks${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at ASC, id ASC`;
    const rows = this.db.query(sql).all(params) as TaskRow[];
    return rows.map((row) => this._taskFromDbRow(row));
  }

  deleteTask(id: string): boolean {
    this.db.query("DELETE FROM task_deps WHERE task_id = $id").run({ $id: id });
    const result = this.db.query("DELETE FROM tasks WHERE id = $id").run({ $id: id });
    return result.changes > 0;
  }

  upsertEpic(epic: KanbanEpic): void {
    const row = epicToRow(epic);
    this.db
      .query(
        `INSERT INTO epics (id, title, body, status, driver_ref, created_at, completed_at,
                            epic_team_name, epic_team_root, pr_number, pr_state, note)
         VALUES ($id, $title, $body, $status, $driver_ref, $created_at, $completed_at,
                 $epic_team_name, $epic_team_root, $pr_number, $pr_state, $note)
         ON CONFLICT(id) DO UPDATE SET
           title=excluded.title, body=excluded.body, status=excluded.status,
           driver_ref=excluded.driver_ref, created_at=excluded.created_at,
           completed_at=excluded.completed_at, epic_team_name=excluded.epic_team_name,
           epic_team_root=excluded.epic_team_root, pr_number=excluded.pr_number,
           pr_state=excluded.pr_state, note=excluded.note`,
      )
      .run(bind(row));
  }

  getEpic(id: string): KanbanEpic | null {
    const row = this.db
      .query(
        `SELECT id, title, body, status, driver_ref, created_at, completed_at,
                epic_team_name, epic_team_root, pr_number, pr_state, note
         FROM epics WHERE id = $id`,
      )
      .get({ $id: id }) as EpicRow | null;
    return row ? epicFromRow(row, this._listEpicStoryIds(id)) : null;
  }

  listEpics(): KanbanEpic[] {
    const rows = this.db
      .query(
        `SELECT id, title, body, status, driver_ref, created_at, completed_at,
                epic_team_name, epic_team_root, pr_number, pr_state, note
         FROM epics ORDER BY created_at ASC, id ASC`,
      )
      .all() as EpicRow[];
    return rows.map((row) => epicFromRow(row, this._listEpicStoryIds(row.id)));
  }

  upsertStory(story: KanbanStory): void {
    const row = storyToRow(story);
    this.db
      .query(
        `INSERT INTO stories (id, epic, title, body, acceptance_criteria, status,
                              created_at, completed_at, advanced_at, review_signoff,
                              merge_task_id, merge_mode)
         VALUES ($id, $epic, $title, $body, $acceptance_criteria, $status,
                 $created_at, $completed_at, $advanced_at, $review_signoff,
                 $merge_task_id, $merge_mode)
         ON CONFLICT(id) DO UPDATE SET
           epic=excluded.epic, title=excluded.title, body=excluded.body,
           acceptance_criteria=excluded.acceptance_criteria, status=excluded.status,
           created_at=excluded.created_at, completed_at=excluded.completed_at,
           advanced_at=excluded.advanced_at, review_signoff=excluded.review_signoff,
           merge_task_id=excluded.merge_task_id, merge_mode=excluded.merge_mode`,
      )
      .run(bind(row));
    this._writeSignoffEvents(story.id, story.signoffAudit);
  }

  getStory(id: string): KanbanStory | null {
    const row = this.db
      .query(
        `SELECT id, epic, title, body, acceptance_criteria, status, created_at,
                completed_at, advanced_at, review_signoff, merge_task_id, merge_mode
         FROM stories WHERE id = $id`,
      )
      .get({ $id: id }) as StoryRow | null;
    return row ? storyFromRow(row, this._listSignoffEvents(id)) : null;
  }

  listStories(filter: { epic?: string } = {}): KanbanStory[] {
    const sql = filter.epic
      ? `SELECT id, epic, title, body, acceptance_criteria, status, created_at,
                completed_at, advanced_at, review_signoff, merge_task_id, merge_mode
         FROM stories WHERE epic = $epic ORDER BY created_at ASC, id ASC`
      : `SELECT id, epic, title, body, acceptance_criteria, status, created_at,
                completed_at, advanced_at, review_signoff, merge_task_id, merge_mode
         FROM stories ORDER BY created_at ASC, id ASC`;
    const params = filter.epic ? { $epic: filter.epic } : {};
    const rows = this.db.query(sql).all(params) as StoryRow[];
    return rows.map((row) => storyFromRow(row, this._listSignoffEvents(row.id)));
  }
}
