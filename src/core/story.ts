// Story orchestration — bash spec: lib/story.sh @ worktree-frozen.
//
// Per ADR-007 state machine:
//   planning → ready → in-progress → testing → review → merging → done
//
// Gates:
//   - in-progress → testing : all non-test-lane child tasks `done`
//   - testing → review      : all test-lane child tasks `done`, auto-dispatch review
//   - review → merging      : `.reviewSignoff == true`, auto-dispatch merge to gitter
//   - merging → done        : the stamped merge task must itself be `done`
// Side effect: ready → in-progress also flips the parent Epic ready → in-progress
// (atomic — single repo transaction).

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { exists } from "../abstractions/fs.ts";
import { closeDatabase, type Database, openDatabase, transact } from "../abstractions/sqlite.ts";
import { migrations } from "../abstractions/sqlite-migrations.ts";
import { ConfigError, UsageError } from "../errors.ts";
import type { KanbanStory, KanbanTask } from "../schema/kanban.ts";
import { tryLoadTeam } from "./common.ts";
import { nowEpoch } from "./kanban.ts";
import { KanbanRepo } from "./repositories/kanban-repo.ts";

const STATES = [
  "planning",
  "ready",
  "in-progress",
  "testing",
  "review",
  "merging",
  "done",
] as const;
export type StoryState = (typeof STATES)[number];

export function genStoryId(): string {
  return `s-${randomBytes(4).toString("hex")}`;
}

export function storyNextState(s: string): StoryState | null {
  switch (s) {
    case "planning":
      return "ready";
    case "ready":
      return "in-progress";
    case "in-progress":
      return "testing";
    case "testing":
      return "review";
    case "review":
      return "merging";
    case "merging":
      return "done";
    default:
      return null;
  }
}

export function storyLegalTransition(from: string, to: string): boolean {
  if (from === to) return true;
  return storyNextState(from) === to;
}

function _stateDbPath(atmuxDir: string): string {
  return join(atmuxDir, "state.db");
}

async function _withRepo<T>(
  atmuxDir: string,
  fn: (repo: KanbanRepo, db: Database) => T | Promise<T>,
): Promise<T> {
  const db = openDatabase(_stateDbPath(atmuxDir), migrations);
  try {
    return await fn(new KanbanRepo(db), db);
  } finally {
    closeDatabase(db);
  }
}

export interface AddStoryOpts {
  title: string;
  epic: string;
  body?: string;
  acceptanceCriteria?: string;
}

export async function addStory(atmuxDir: string, opts: AddStoryOpts): Promise<string> {
  const title = opts.title.trim();
  if (title.length === 0) {
    throw new UsageError({ what: "story add: <title> required" });
  }
  if (opts.epic.length === 0) {
    throw new UsageError({ what: "story add: --epic <epic-id> required" });
  }
  if (!(await exists(_stateDbPath(atmuxDir)))) {
    throw new ConfigError({
      what: `story add: ${_stateDbPath(atmuxDir)} not initialized; run \`atmux init\` first`,
    });
  }
  return await _withRepo(atmuxDir, (repo) => {
    const parent = repo.getEpic(opts.epic);
    if (parent === null) {
      throw new ConfigError({ what: `story add: no such epic: ${opts.epic}` });
    }
    const sid = genStoryId();
    const story: KanbanStory = {
      id: sid,
      epic: opts.epic,
      title,
      body: opts.body !== undefined && opts.body.length > 0 ? opts.body : null,
      acceptanceCriteria:
        opts.acceptanceCriteria !== undefined && opts.acceptanceCriteria.length > 0
          ? opts.acceptanceCriteria
          : null,
      status: "planning",
      reviewSignoff: false,
      mergeTaskId: null,
      createdAt: nowEpoch(),
      completedAt: null,
    };
    repo.upsertStory(story);
    // Mirror bash's `(.epics[]? | select(.id == $eid) | .stories) //= []
    //                | (...) += [$sid]`. The lazy-init is implicit since
    // we read into an array; we just append + upsert.
    const childList = parent.stories ?? [];
    repo.upsertEpic({ ...parent, stories: [...childList, sid] });
    return sid;
  });
}

export interface ListStoriesFilter {
  epic: string;
  status?: string;
}

export async function listStories(
  atmuxDir: string,
  filter: ListStoriesFilter,
): Promise<KanbanStory[]> {
  if (!(await exists(_stateDbPath(atmuxDir)))) return [];
  return await _withRepo(atmuxDir, (repo) => {
    let stories = repo.listStories({ epic: filter.epic });
    if (filter.status !== undefined) {
      const s = filter.status;
      stories = stories.filter((st) => st.status === s);
    }
    return stories;
  });
}

export interface StoryWithChildren extends KanbanStory {
  tasks: KanbanTask[];
}

export async function showStory(atmuxDir: string, id: string): Promise<StoryWithChildren | null> {
  if (!(await exists(_stateDbPath(atmuxDir)))) return null;
  return await _withRepo(atmuxDir, (repo) => {
    const story = repo.getStory(id);
    if (story === null) return null;
    const tasks = repo.listTasks({ story: id });
    return { ...story, tasks };
  });
}

export interface AdvanceStoryResult {
  from: string;
  to: string;
  /** Set when the transition auto-flipped the parent Epic ready → in-progress. */
  parentEpicFlipped: boolean;
  /** Dispatched verb-name + member when applicable (review entry → reviewer;
   *  merging entry → gitter). */
  dispatchedTaskId: string | null;
  /** Caller-side reporting only. */
  noop: boolean;
}

export async function advanceStory(
  atmuxDir: string,
  id: string,
  target?: string,
): Promise<AdvanceStoryResult> {
  if (!(await exists(_stateDbPath(atmuxDir)))) {
    throw new ConfigError({ what: `story advance: no such story: ${id}` });
  }
  // Look up dispatch recipients up-front so the DB transaction is pure.
  const team = await tryLoadTeam({ teamDir: atmuxDir });
  return await _withRepo(atmuxDir, (repo, db) => {
    const story = repo.getStory(id);
    if (story === null) {
      throw new ConfigError({ what: `story advance: no such story: ${id}` });
    }
    const cur = story.status ?? "planning";
    const eid = story.epic ?? null;
    const resolved = target !== undefined && target.length > 0 ? target : storyNextState(cur);
    if (resolved === null) {
      throw new UsageError({ what: `story advance: ${id} is in terminal state '${cur}'` });
    }
    if (!storyLegalTransition(cur, resolved)) {
      throw new UsageError({
        what:
          `story advance: illegal transition ${cur} → ${resolved} ` +
          `(machine: planning→ready→in-progress→testing→review→merging→done)`,
      });
    }
    if (cur === resolved) {
      return {
        from: cur,
        to: resolved,
        parentEpicFlipped: false,
        dispatchedTaskId: null,
        noop: true,
      };
    }
    // ----- gates -----
    if (resolved === "testing") {
      const blocking = repo
        .listTasks({ story: id })
        .filter((t) => (t.lane ?? "misc") !== "test" && t.status !== "done")
        .map((t) => t.id);
      if (blocking.length > 0) {
        throw new UsageError({
          what:
            `story advance: cannot advance ${id} to testing — ` +
            `non-test-lane tasks still open: ${blocking.join(",")}`,
        });
      }
    } else if (resolved === "review") {
      const blocking = repo
        .listTasks({ story: id })
        .filter((t) => (t.lane ?? "") === "test" && t.status !== "done")
        .map((t) => t.id);
      if (blocking.length > 0) {
        throw new UsageError({
          what:
            `story advance: cannot advance ${id} to review — ` +
            `test-lane tasks still open: ${blocking.join(",")}`,
        });
      }
    } else if (resolved === "merging") {
      if (story.reviewSignoff !== true) {
        throw new UsageError({
          what:
            `story advance: cannot advance ${id} to merging — ` +
            "reviewer signoff missing (.reviewSignoff != true)",
        });
      }
    } else if (resolved === "done") {
      const mergeTid = story.mergeTaskId;
      if (mergeTid === null || mergeTid === undefined || mergeTid.length === 0) {
        throw new UsageError({
          what:
            `story advance: cannot advance ${id} to done — ` +
            "no merge task on record (was the story dispatched to gitter via merging?)",
        });
      }
      const mergeTask = repo.getTask(mergeTid);
      const mergeStatus = mergeTask?.status ?? "";
      if (mergeStatus !== "done") {
        throw new UsageError({
          what:
            `story advance: cannot advance ${id} to done — ` +
            `merge task ${mergeTid} is '${mergeStatus}' (gitter has not completed merge)`,
        });
      }
    }
    const now = nowEpoch();
    let parentEpicFlipped = false;
    let dispatchedTaskId: string | null = null;
    // Apply mutations inside a single DB transaction so concurrent readers
    // see either pre- or post-state, never partial. Bash's lib/story.sh
    // jq_update is a single atomic file write; transact() is the SQL
    // equivalent.
    transact(db, () => {
      const updatedStory: KanbanStory = { ...story, status: resolved, advancedAt: now };
      if (resolved === "done") updatedStory.completedAt = now;
      if (resolved === "merging" && story.mergeTaskId === null) {
        // mergeTaskId is stamped only when we dispatch (below); the post-
        // mutation re-read below picks the value up.
      }
      // ready → in-progress: parent epic auto-flip iff currently `ready`.
      if (cur === "ready" && resolved === "in-progress" && eid !== null) {
        const parent = repo.getEpic(eid);
        if (parent !== null && parent.status === "ready") {
          repo.upsertEpic({ ...parent, status: "in-progress" });
          parentEpicFlipped = true;
        }
      }
      // Post-transition dispatch side effects.
      if (resolved === "review") {
        const reviewer = team?.members.find((m) => m.role === "reviewer");
        if (reviewer === undefined) {
          throw new ConfigError({
            what: "story advance: no member with role=reviewer in team.json",
          });
        }
        const tid = `t-${randomBytes(4).toString("hex")}`;
        const task: KanbanTask = {
          id: tid,
          subject: `review ${id}`,
          body: `Story ${id} is in review state. Source: \`atmux story show ${id}\`.`,
          status: "in-progress",
          owner: reviewer.name,
          deps: [],
          priority: 1,
          lane: "review",
          story: id,
          createdAt: now,
          claimedAt: now,
          completedAt: null,
        };
        repo.addTask(task);
        dispatchedTaskId = tid;
      } else if (resolved === "merging") {
        const gitter = team?.members.find((m) => m.role === "gitter" || m.name === "gitter");
        if (gitter === undefined) {
          throw new ConfigError({
            what: "story advance: no member with role=gitter (or name=gitter) in team.json",
          });
        }
        const tid = `t-${randomBytes(4).toString("hex")}`;
        const task: KanbanTask = {
          id: tid,
          subject: `merge ${id}`,
          body: `Story ${id} is in merging state. Source: \`atmux story show ${id}\`.`,
          status: "in-progress",
          owner: gitter.name,
          deps: [],
          priority: 1,
          lane: "misc",
          story: id,
          createdAt: now,
          claimedAt: now,
          completedAt: null,
        };
        repo.addTask(task);
        updatedStory.mergeTaskId = tid;
        dispatchedTaskId = tid;
      }
      repo.upsertStory(updatedStory);
    });
    return { from: cur, to: resolved, parentEpicFlipped, dispatchedTaskId, noop: false };
  });
}

// Re-export schema types so the verb layer imports stay together.
export type { KanbanStory };
