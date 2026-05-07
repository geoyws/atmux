// ADR-060 §D3: kanban repository. SQL is owned here; verbs + core/
// modules see a typed CRUD surface that mirrors the existing
// `core/kanban.ts` API. Zod stays at the row↔domain bridge so DB
// constraints + Zod parse are belt-and-suspenders.
//
// Field naming convention: SQL columns are snake_case; domain
// objects (TS types) are camelCase. `taskFromRow` / `taskToRow`
// own the conversion. Future schema work folds into row helpers.

import type { Database } from "bun:sqlite";
import {
  type KanbanEpic,
  KanbanEpic as KanbanEpicSchema,
  type KanbanStory,
  KanbanStory as KanbanStorySchema,
  type KanbanTask,
  KanbanTask as KanbanTaskSchema,
} from "../../schema/kanban.ts";

// ---------- Row shapes (SQL columns; raw bun:sqlite output) ----------

interface TaskRow {
  id: string;
  subject: string | null;
  body: string | null;
  status: string | null;
  owner: string | null;
  deps: string | null;
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
  claimed_from: string | null;
  created_from: string | null;
  note: string | null;
  extra: string | null;
}

interface EpicRow {
  id: string;
  title: string | null;
  body: string | null;
  status: string | null;
  driver_ref: string | null;
  created_at: number | null;
  completed_at: number | null;
  stories: string | null;
  extra: string | null;
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
  extra: string | null;
}

// ---------- Row ↔ domain bridges ----------

const KNOWN_TASK_FIELDS = new Set([
  "id",
  "subject",
  "body",
  "status",
  "owner",
  "deps",
  "priority",
  "epic",
  "story",
  "lane",
  "deliverable",
  "staleMin",
  "driverOnly",
  "createdAt",
  "claimedAt",
  "completedAt",
  "claimedFrom",
  "createdFrom",
  "note",
]);

export function taskFromRow(row: TaskRow): KanbanTask {
  const extra = row.extra ? (JSON.parse(row.extra) as Record<string, unknown>) : {};
  const candidate: Record<string, unknown> = {
    id: row.id,
    subject: row.subject ?? undefined,
    body: row.body,
    status: row.status ?? undefined,
    owner: row.owner,
    deps: row.deps ? JSON.parse(row.deps) : undefined,
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
    claimedFrom: row.claimed_from,
    createdFrom: row.created_from,
    note: row.note,
    ...extra,
  };
  return KanbanTaskSchema.parse(candidate);
}

export function taskToRow(task: KanbanTask): TaskRow {
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(task)) {
    if (!KNOWN_TASK_FIELDS.has(k)) extra[k] = v;
  }
  return {
    id: task.id,
    subject: task.subject ?? null,
    body: task.body ?? null,
    status: task.status ?? null,
    owner: task.owner ?? null,
    deps: task.deps ? JSON.stringify(task.deps) : null,
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
    claimed_from: task.claimedFrom ?? null,
    created_from: task.createdFrom ?? null,
    note: task.note ?? null,
    extra: Object.keys(extra).length > 0 ? JSON.stringify(extra) : null,
  };
}

const KNOWN_EPIC_FIELDS = new Set([
  "id",
  "title",
  "body",
  "status",
  "driverRef",
  "createdAt",
  "completedAt",
  "stories",
]);

export function epicFromRow(row: EpicRow): KanbanEpic {
  const extra = row.extra ? (JSON.parse(row.extra) as Record<string, unknown>) : {};
  return KanbanEpicSchema.parse({
    id: row.id,
    title: row.title ?? undefined,
    body: row.body,
    status: row.status ?? undefined,
    driverRef: row.driver_ref,
    createdAt: row.created_at ?? undefined,
    completedAt: row.completed_at,
    stories: row.stories ? JSON.parse(row.stories) : undefined,
    ...extra,
  });
}

export function epicToRow(epic: KanbanEpic): EpicRow {
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(epic)) {
    if (!KNOWN_EPIC_FIELDS.has(k)) extra[k] = v;
  }
  return {
    id: epic.id,
    title: epic.title ?? null,
    body: epic.body ?? null,
    status: epic.status ?? null,
    driver_ref: epic.driverRef ?? null,
    created_at: epic.createdAt ?? null,
    completed_at: epic.completedAt ?? null,
    stories: epic.stories ? JSON.stringify(epic.stories) : null,
    extra: Object.keys(extra).length > 0 ? JSON.stringify(extra) : null,
  };
}

const KNOWN_STORY_FIELDS = new Set([
  "id",
  "epic",
  "title",
  "body",
  "acceptanceCriteria",
  "status",
  "createdAt",
  "completedAt",
  "advancedAt",
  "reviewSignoff",
  "mergeTaskId",
]);

export function storyFromRow(row: StoryRow): KanbanStory {
  const extra = row.extra ? (JSON.parse(row.extra) as Record<string, unknown>) : {};
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
    ...extra,
  });
}

export function storyToRow(story: KanbanStory): StoryRow {
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(story)) {
    if (!KNOWN_STORY_FIELDS.has(k)) extra[k] = v;
  }
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
    extra: Object.keys(extra).length > 0 ? JSON.stringify(extra) : null,
  };
}

// ---------- Bind-param helper ----------

/** bun:sqlite named-bind expects keys prefixed with `$` (matches the SQL
 *  placeholder syntax `$col`). Row interfaces use bare column names; this
 *  helper prefixes at the call site. Return type narrowed to the
 *  `SQLQueryBindings` value union bun:sqlite accepts. */
type BindValue = string | number | null;
function bind(row: TaskRow | EpicRow | StoryRow): Record<string, BindValue> {
  const out: Record<string, BindValue> = {};
  for (const [k, v] of Object.entries(row)) out[`$${k}`] = v as BindValue;
  return out;
}

// ---------- Repository ----------

export interface TaskFilter {
  owner?: string;
  status?: string;
  lane?: string;
  epic?: string;
  story?: string;
}

export class KanbanRepo {
  constructor(private db: Database) {}

  // ----- task CRUD -----

  addTask(task: KanbanTask): void {
    const row = taskToRow(task);
    this.db
      .query(
        `INSERT INTO tasks (id, subject, body, status, owner, deps, priority,
				                    epic, story, lane, deliverable, stale_min, driver_only,
				                    created_at, claimed_at, completed_at, claimed_from,
				                    created_from, note, extra)
				 VALUES ($id, $subject, $body, $status, $owner, $deps, $priority,
				         $epic, $story, $lane, $deliverable, $stale_min, $driver_only,
				         $created_at, $claimed_at, $completed_at, $claimed_from,
				         $created_from, $note, $extra)`,
      )
      .run(bind(row));
  }

  upsertTask(task: KanbanTask): void {
    const row = taskToRow(task);
    this.db
      .query(
        `INSERT INTO tasks (id, subject, body, status, owner, deps, priority,
				                    epic, story, lane, deliverable, stale_min, driver_only,
				                    created_at, claimed_at, completed_at, claimed_from,
				                    created_from, note, extra)
				 VALUES ($id, $subject, $body, $status, $owner, $deps, $priority,
				         $epic, $story, $lane, $deliverable, $stale_min, $driver_only,
				         $created_at, $claimed_at, $completed_at, $claimed_from,
				         $created_from, $note, $extra)
				 ON CONFLICT(id) DO UPDATE SET
				   subject=excluded.subject, body=excluded.body, status=excluded.status,
				   owner=excluded.owner, deps=excluded.deps, priority=excluded.priority,
				   epic=excluded.epic, story=excluded.story, lane=excluded.lane,
				   deliverable=excluded.deliverable, stale_min=excluded.stale_min,
				   driver_only=excluded.driver_only, created_at=excluded.created_at,
				   claimed_at=excluded.claimed_at, completed_at=excluded.completed_at,
				   claimed_from=excluded.claimed_from, created_from=excluded.created_from,
				   note=excluded.note, extra=excluded.extra`,
      )
      .run(bind(row));
  }

  getTask(id: string): KanbanTask | null {
    const row = this.db
      .query("SELECT * FROM tasks WHERE id = $id")
      .get({ $id: id }) as TaskRow | null;
    return row ? taskFromRow(row) : null;
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
    const sql = `SELECT * FROM tasks${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at ASC, id ASC`;
    const rows = this.db.query(sql).all(params) as TaskRow[];
    return rows.map(taskFromRow);
  }

  deleteTask(id: string): boolean {
    const result = this.db.query("DELETE FROM tasks WHERE id = $id").run({ $id: id });
    return result.changes > 0;
  }

  // ----- epic CRUD -----

  upsertEpic(epic: KanbanEpic): void {
    const row = epicToRow(epic);
    this.db
      .query(
        `INSERT INTO epics (id, title, body, status, driver_ref, created_at,
				                    completed_at, stories, extra)
				 VALUES ($id, $title, $body, $status, $driver_ref, $created_at,
				         $completed_at, $stories, $extra)
				 ON CONFLICT(id) DO UPDATE SET
				   title=excluded.title, body=excluded.body, status=excluded.status,
				   driver_ref=excluded.driver_ref, created_at=excluded.created_at,
				   completed_at=excluded.completed_at, stories=excluded.stories,
				   extra=excluded.extra`,
      )
      .run(bind(row));
  }

  getEpic(id: string): KanbanEpic | null {
    const row = this.db
      .query("SELECT * FROM epics WHERE id = $id")
      .get({ $id: id }) as EpicRow | null;
    return row ? epicFromRow(row) : null;
  }

  listEpics(): KanbanEpic[] {
    const rows = this.db
      .query("SELECT * FROM epics ORDER BY created_at ASC, id ASC")
      .all() as EpicRow[];
    return rows.map(epicFromRow);
  }

  // ----- story CRUD -----

  upsertStory(story: KanbanStory): void {
    const row = storyToRow(story);
    this.db
      .query(
        `INSERT INTO stories (id, epic, title, body, acceptance_criteria, status,
				                      created_at, completed_at, advanced_at, review_signoff,
				                      merge_task_id, extra)
				 VALUES ($id, $epic, $title, $body, $acceptance_criteria, $status,
				         $created_at, $completed_at, $advanced_at, $review_signoff,
				         $merge_task_id, $extra)
				 ON CONFLICT(id) DO UPDATE SET
				   epic=excluded.epic, title=excluded.title, body=excluded.body,
				   acceptance_criteria=excluded.acceptance_criteria, status=excluded.status,
				   created_at=excluded.created_at, completed_at=excluded.completed_at,
				   advanced_at=excluded.advanced_at, review_signoff=excluded.review_signoff,
				   merge_task_id=excluded.merge_task_id, extra=excluded.extra`,
      )
      .run(bind(row));
  }

  getStory(id: string): KanbanStory | null {
    const row = this.db
      .query("SELECT * FROM stories WHERE id = $id")
      .get({ $id: id }) as StoryRow | null;
    return row ? storyFromRow(row) : null;
  }

  listStories(filter: { epic?: string } = {}): KanbanStory[] {
    const sql = filter.epic
      ? "SELECT * FROM stories WHERE epic = $epic ORDER BY created_at ASC, id ASC"
      : "SELECT * FROM stories ORDER BY created_at ASC, id ASC";
    const params = filter.epic ? { $epic: filter.epic } : {};
    const rows = this.db.query(sql).all(params) as StoryRow[];
    return rows.map(storyFromRow);
  }
}
