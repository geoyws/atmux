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
import { emit } from "../abstractions/events.ts";
import { exists } from "../abstractions/fs.ts";
import {
  closeDatabase,
  type Database,
  openDatabase,
  transact,
  transactImmediate,
} from "../abstractions/sqlite.ts";
import { migrations } from "../abstractions/sqlite-migrations.ts";
import { KanbanCliAdapter } from "../adapters/kanban-cli.ts";
import { ConfigError, UsageError } from "../errors.ts";
import type { KanbanStory, KanbanTask } from "../schema/kanban.ts";
import { tryLoadTeam } from "./common.ts";
import { nextId } from "./id-sequence.ts";
import { nowEpoch } from "./kanban.ts";
import { externalKanbanEnabled } from "./kanban-backend.ts";
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
const externalKanban = new KanbanCliAdapter();

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
  /** ADR-175 GAP 2: how this Story integrates onto trunk. Omitted →
   *  `'feature-branch'` (current behaviour). */
  mergeMode?: "feature-branch" | "trunk-direct";
}

export async function addStory(atmuxDir: string, opts: AddStoryOpts): Promise<string> {
  const title = opts.title.trim();
  if (title.length === 0) {
    throw new UsageError({ what: "story add: <title> required" });
  }
  if (opts.epic.length === 0) {
    throw new UsageError({ what: "story add: --epic <epic-id> required" });
  }
  if (await externalKanbanEnabled(atmuxDir)) {
    const parent = (await externalKanban.loadKanban(atmuxDir)).epics.find(
      (epic) => epic.id === opts.epic,
    );
    if (!parent) throw new ConfigError({ what: `story add: no such epic: ${opts.epic}` });
    const id = await externalKanban.addTask(atmuxDir, {
      type: "story",
      subject: title,
      epic: opts.epic,
      ...(opts.body ? { body: opts.body } : {}),
    });
    await externalKanban.patchMetadata(atmuxDir, id, "atmux", {
      workflowStatus: "planning",
      acceptanceCriteria: opts.acceptanceCriteria ?? null,
      reviewSignoff: false,
      mergeMode: opts.mergeMode ?? "feature-branch",
    });
    return id;
  }
  if (!(await exists(_stateDbPath(atmuxDir)))) {
    throw new ConfigError({
      what: `story add: ${_stateDbPath(atmuxDir)} not initialized; run \`atmux init\` first`,
    });
  }
  return await _withRepo(atmuxDir, (repo, db) => {
    // ADR-202 §VIII — running-number ID per-team scoped via id_sequences.
    // Sequence increment + story insert + epic.stories append all run
    // inside the same transactImmediate so the trio is atomic.
    let sid = "";
    transactImmediate(db, () => {
      const parent = repo.getEpic(opts.epic);
      if (parent === null) {
        throw new ConfigError({ what: `story add: no such epic: ${opts.epic}` });
      }
      sid = nextId(db, "s");
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
        mergeMode: opts.mergeMode ?? "feature-branch",
        createdAt: nowEpoch(),
        completedAt: null,
      };
      repo.upsertStory(story);
      // Mirror bash's `(.epics[]? | select(.id == $eid) | .stories) //= []
      //                | (...) += [$sid]`. The lazy-init is implicit since
      // we read into an array; we just append + upsert.
      const childList = parent.stories ?? [];
      repo.upsertEpic({ ...parent, stories: [...childList, sid] });
    });
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
  if (await externalKanbanEnabled(atmuxDir)) {
    const stories = (await externalKanban.loadKanban(atmuxDir)).stories.filter(
      (story) => story.epic === filter.epic,
    );
    return filter.status ? stories.filter((story) => story.status === filter.status) : stories;
  }
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
  if (await externalKanbanEnabled(atmuxDir)) {
    const board = await externalKanban.loadKanban(atmuxDir);
    const story = board.stories.find((item) => item.id === id);
    return story ? { ...story, tasks: board.tasks.filter((task) => task.story === id) } : null;
  }
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
  if (await externalKanbanEnabled(atmuxDir)) {
    const team = await tryLoadTeam({ dir: atmuxDir });
    const reviewer = team?.members.find((member) => member.role === "reviewer")?.name;
    const committer = team?.members.find(
      (member) =>
        member.role === "committer" || member.role === "gitter" || member.name === "gitter",
    )?.name;
    const result = await externalKanban.advanceStory(atmuxDir, id, "atmux", {
      ...(target ? { target } : {}),
      ...(reviewer ? { reviewer } : {}),
      ...(committer ? { committer } : {}),
    });
    return {
      from: result.from,
      to: result.to,
      parentEpicFlipped: result.parentEpicFlipped,
      dispatchedTaskId: result.dispatchedTaskID,
      noop: result.noop,
    };
  }
  if (!(await exists(_stateDbPath(atmuxDir)))) {
    throw new ConfigError({ what: `story advance: no such story: ${id}` });
  }
  // Look up dispatch recipients up-front so the DB transaction is pure.
  // Per t-85846a0b (cluster 4/5 of t-2b801707 fix): use `dir: atmuxDir`
  // not `teamDir: atmuxDir`. `teamDir` is the parent-of-.atmux (gets
  // ".atmux" appended via getAtmuxDir); passing the .atmux/ path itself
  // double-appends and reads `<atmuxDir>/.atmux/team.json` (wrong).
  // The advanceStory caller already has the canonical atmuxDir; use it
  // directly via the `dir` option which is "explicit .atmux path,
  // overrides every other source" per ResolveDirOpts.
  const team = await tryLoadTeam({ dir: atmuxDir });
  return await _withRepo(atmuxDir, (repo, db) => {
    const story = repo.getStory(id);
    if (story === null) {
      throw new ConfigError({ what: `story advance: no such story: ${id}` });
    }
    const cur = story.status ?? "planning";
    const eid = story.epic ?? null;
    // ADR-175 GAP 2: trunk-direct stories take the shorter machine
    //   planning → ready → in-progress → testing → review → done
    // (skipping `merging`). Compute mode here so both `storyNextState`
    // fallback and the legal-transition gate respect the chosen path.
    const mergeMode = story.mergeMode ?? "feature-branch";
    const trunkDirect = mergeMode === "trunk-direct";
    const resolved =
      target !== undefined && target.length > 0
        ? target
        : trunkDirect && cur === "review"
          ? "done"
          : storyNextState(cur);
    if (resolved === null) {
      throw new UsageError({ what: `story advance: ${id} is in terminal state '${cur}'` });
    }
    // Trunk-direct carve-out: `review → done` legal in addition to the
    // feature-branch machine. Every other transition still goes through
    // the canonical gate so e.g. `review → merging` on a trunk-direct
    // story would refuse here (no merging phase) before hitting the
    // merging-specific signoff gate below — but we want a clearer
    // error for that explicit foot-gun, so the merging branch checks
    // mergeMode too.
    const trunkDirectReviewToDone = trunkDirect && cur === "review" && resolved === "done";
    if (!trunkDirectReviewToDone && !storyLegalTransition(cur, resolved)) {
      throw new UsageError({
        what:
          `story advance: illegal transition ${cur} → ${resolved} ` +
          `(machine: planning→ready→in-progress→testing→review→` +
          `${trunkDirect ? "done [trunk-direct]" : "merging→done"})`,
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
      if (trunkDirect) {
        throw new UsageError({
          what:
            `story advance: cannot advance ${id} to merging — ` +
            "mergeMode='trunk-direct' has no merging phase; use --to done after signoff",
        });
      }
      if (story.reviewSignoff !== true) {
        throw new UsageError({
          what:
            `story advance: cannot advance ${id} to merging — ` +
            "reviewer signoff missing (.reviewSignoff != true)",
        });
      }
    } else if (resolved === "done") {
      if (trunkDirectReviewToDone) {
        // ADR-175 GAP 2: trunk-direct review→done skips merging
        // entirely. Signoff bit STILL required (review gate intact —
        // we're bypassing the merge phase, not the review phase).
        if (story.reviewSignoff !== true) {
          throw new UsageError({
            what:
              `story advance: cannot advance ${id} to done — ` +
              "reviewer signoff missing (.reviewSignoff != true)",
          });
        }
      } else {
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
    }
    const now = nowEpoch();
    let parentEpicFlipped = false;
    let dispatchedTaskId: string | null = null;
    // ADR-247 §D1: fire `story.ready` ONCE on the `planning → ready`
    // transition (the planner's hand-off edge). Captured here, emitted
    // after the transaction returns — mirrors the `epic.ready` precedent
    // in `src/core/epic.ts` (events INSERT lands outside the parent
    // transaction's lock window; BEGIN IMMEDIATE serializes them safely).
    // Guarded on cur === "planning" so a `--to ready` no-op re-issue on an
    // already-ready story never re-fires (the cur === resolved early-return
    // above already handles the pure no-op; this is belt-and-suspenders for
    // any future non-canonical entry into ready).
    const shouldEmitStoryReady = cur === "planning" && resolved === "ready";
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
        // ADR-159 TR3: accept `committer` (canonical) AND `gitter`
        // (legacy alias) during the grace cycle. Schema transforms
        // `gitter → committer` at parse; Zod-bypassed in-memory
        // fixtures may still carry the legacy value.
        const gitter = team?.members.find(
          (m) => m.role === "committer" || m.role === "gitter" || m.name === "gitter",
        );
        if (gitter === undefined) {
          throw new ConfigError({
            what: "story advance: no member with role=committer (or legacy role=gitter / name=gitter) in team.json",
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
    // ADR-247 §D1: emit `story.ready` on the planning→ready edge, after
    // the transaction commits. Best-effort — a missing events table
    // (pre-migration cage) or a Zod hiccup must NOT break `story advance`;
    // the kanban row is the load-bearing side effect (same contract as
    // `tryEmitTaskLifecycle` in src/core/kanban.ts). Honker NOTIFY fires
    // inside emit() automatically when the substrate is loaded
    // (getHonkerState auto-detect per ADR-202 §Amendment 2026-05-24).
    if (shouldEmitStoryReady) {
      try {
        // Stories have no first-class `lane` column; the lane hint rides
        // the passthrough `extra` JSON when set (ADR-247 §OQ3 makes this
        // advisory — the watchdog re-derives the authoritative lane from
        // kanban at ping-time). Fall back to "misc" when unset.
        const storyExtra = story as Record<string, unknown>;
        const laneHint = typeof storyExtra.lane === "string" ? storyExtra.lane : "misc";
        const assigneeHint =
          typeof storyExtra.owner === "string" && storyExtra.owner.length > 0
            ? storyExtra.owner
            : undefined;
        emit(db, {
          topic: "story.ready",
          team: team?.name ?? "",
          epicId: eid ?? "",
          storyId: id,
          lane: laneHint,
          ...(assigneeHint !== undefined ? { assigneeHint } : {}),
          body: story.title ?? story.body ?? "",
          emittedAtSec: now,
        });
      } catch {
        // Best-effort: missing events table or programmer-introduced Zod
        // failure must not break `story advance`. The kanban row already
        // committed above is the load-bearing side effect.
      }
    }
    return { from: cur, to: resolved, parentEpicFlipped, dispatchedTaskId, noop: false };
  });
}

// ---------- ADR-175 GAP 1: signoff / unsignoff ----------

export interface SignoffOpts {
  /** Operator override — attribute signoff to this member regardless of
   *  caller's actual role. When set, the caller-role gate is bypassed
   *  (cross-cage workflows, off-hours reviewer-pane-dormant). The audit
   *  entry's `signedOffBy` (or `unsignedBy`) field carries this value. */
  as?: string;
  /** Free-form note appended to the audit entry. */
  note?: string;
  /** Pane-effective member identity, normally `$ATMUX_MEMBER` injected at
   *  the verb layer. Consulted only when `--as` is NOT passed: the role
   *  check looks this member up in `team.json` and refuses unless their
   *  role is `reviewer`. */
  callerMember?: string;
}

export interface SignoffResult {
  storyId: string;
  signedOffBy: string;
  signedOffAt: number;
  noteApplied: string | null;
}

export interface UnsignoffResult {
  storyId: string;
  unsignedBy: string;
  unsignedAt: number;
  noteApplied: string | null;
}

function _resolveSignoffMember(
  team: Awaited<ReturnType<typeof tryLoadTeam>>,
  opts: SignoffOpts,
  verbLabel: string,
): string {
  const effective = opts.as ?? opts.callerMember;
  if (effective === undefined || effective.length === 0) {
    throw new UsageError({
      what: `${verbLabel}: need --as <member> or $ATMUX_MEMBER to attribute the signoff`,
    });
  }
  // Operator override: --as bypasses the caller-role gate but still
  // requires the named member to exist in team.json so audit entries
  // can't carry made-up names. If team.json itself is absent we trust
  // the caller (tests / one-off cages).
  if (opts.as !== undefined) {
    if (team !== null) {
      const target = team.members.find((m) => m.name === opts.as);
      if (target === undefined) {
        throw new ConfigError({
          what: `${verbLabel}: --as ${opts.as}: no such member in team.json`,
        });
      }
    }
    return effective;
  }
  // No --as: caller MUST be role=reviewer per team.json.
  if (team === null) {
    throw new ConfigError({
      what: `${verbLabel}: no team.json — pass --as <reviewer-member> for operator-side invocation`,
    });
  }
  const caller = team.members.find((m) => m.name === opts.callerMember);
  if (caller === undefined) {
    throw new ConfigError({
      what: `${verbLabel}: $ATMUX_MEMBER=${opts.callerMember} not found in team.json`,
    });
  }
  if (caller.role !== "reviewer") {
    throw new UsageError({
      what:
        `${verbLabel}: role=${caller.role ?? "(unset)"} cannot sign off — ` +
        "must be role=reviewer or pass --as <reviewer-member>",
    });
  }
  return effective;
}

export async function storySignoff(
  atmuxDir: string,
  id: string,
  opts: SignoffOpts = {},
): Promise<SignoffResult> {
  if (await externalKanbanEnabled(atmuxDir)) {
    const team = await tryLoadTeam({ dir: atmuxDir });
    const member = _resolveSignoffMember(team, opts, "story signoff");
    const result = await externalKanban.setStorySignoff(atmuxDir, id, member, true, opts.note);
    return {
      storyId: result.storyID,
      signedOffBy: result.actor,
      signedOffAt: result.at,
      noteApplied: result.note,
    };
  }
  if (!(await exists(_stateDbPath(atmuxDir)))) {
    throw new ConfigError({ what: `story signoff: no such story: ${id}` });
  }
  const team = await tryLoadTeam({ dir: atmuxDir });
  const member = _resolveSignoffMember(team, opts, "story signoff");
  return await _withRepo(atmuxDir, (repo, db) => {
    const story = repo.getStory(id);
    if (story === null) {
      throw new ConfigError({ what: `story signoff: no such story: ${id}` });
    }
    if ((story.status ?? "") !== "review") {
      throw new UsageError({
        what:
          `story signoff: ${id} is in '${story.status ?? "(unset)"}' state — ` +
          "signoff is only valid in 'review' (advance the story to review first)",
      });
    }
    const ts = Date.now();
    const note = opts.note !== undefined && opts.note.length > 0 ? opts.note : null;
    const auditEntry: Record<string, unknown> = {
      signedOffBy: member,
      signedOffAt: ts,
      note,
    };
    const prior = Array.isArray(story.signoffAudit) ? story.signoffAudit : [];
    let result: SignoffResult = {
      storyId: id,
      signedOffBy: member,
      signedOffAt: ts,
      noteApplied: note,
    };
    transact(db, () => {
      const updated: KanbanStory = {
        ...story,
        reviewSignoff: true,
        signoffAudit: [...prior, auditEntry],
      };
      repo.upsertStory(updated);
      result = {
        storyId: id,
        signedOffBy: member,
        signedOffAt: ts,
        noteApplied: note,
      };
    });
    return result;
  });
}

export async function storyUnsignoff(
  atmuxDir: string,
  id: string,
  opts: SignoffOpts = {},
): Promise<UnsignoffResult> {
  if (await externalKanbanEnabled(atmuxDir)) {
    const team = await tryLoadTeam({ dir: atmuxDir });
    const member = _resolveSignoffMember(team, opts, "story unsignoff");
    const result = await externalKanban.setStorySignoff(atmuxDir, id, member, false, opts.note);
    return {
      storyId: result.storyID,
      unsignedBy: result.actor,
      unsignedAt: result.at,
      noteApplied: result.note,
    };
  }
  if (!(await exists(_stateDbPath(atmuxDir)))) {
    throw new ConfigError({ what: `story unsignoff: no such story: ${id}` });
  }
  const team = await tryLoadTeam({ dir: atmuxDir });
  const member = _resolveSignoffMember(team, opts, "story unsignoff");
  return await _withRepo(atmuxDir, (repo, db) => {
    const story = repo.getStory(id);
    if (story === null) {
      throw new ConfigError({ what: `story unsignoff: no such story: ${id}` });
    }
    if ((story.status ?? "") !== "review") {
      throw new UsageError({
        what:
          `story unsignoff: ${id} is in '${story.status ?? "(unset)"}' state — ` +
          "unsignoff is only valid in 'review' (signoff has not been consumed yet)",
      });
    }
    if (story.mergeTaskId !== null && story.mergeTaskId !== undefined) {
      throw new UsageError({
        what:
          `story unsignoff: ${id} already has mergeTaskId=${story.mergeTaskId} — ` +
          "signoff has been consumed by gitter dispatch; use the merge-task abort flow instead",
      });
    }
    const ts = Date.now();
    const note = opts.note !== undefined && opts.note.length > 0 ? opts.note : null;
    const auditEntry: Record<string, unknown> = {
      unsignedBy: member,
      unsignedAt: ts,
      note,
    };
    const prior = Array.isArray(story.signoffAudit) ? story.signoffAudit : [];
    let result: UnsignoffResult = {
      storyId: id,
      unsignedBy: member,
      unsignedAt: ts,
      noteApplied: note,
    };
    transact(db, () => {
      const updated: KanbanStory = {
        ...story,
        reviewSignoff: false,
        signoffAudit: [...prior, auditEntry],
      };
      repo.upsertStory(updated);
      result = {
        storyId: id,
        unsignedBy: member,
        unsignedAt: ts,
        noteApplied: note,
      };
    });
    return result;
  });
}

// ---------- e-407c6d53: story update — body / acceptanceCriteria edit ----------

export interface UpdateStoryOpts {
  /** New body prose. `null` clears the body (`--body ''` at the verb layer);
   *  `undefined` leaves the existing value untouched. */
  body?: string | null;
  /** New acceptance-criteria prose. `null` clears it (`--ac ''`);
   *  `undefined` leaves the existing value untouched. */
  acceptanceCriteria?: string | null;
}

/** Edit a Story's `body` / `acceptanceCriteria` in place. Mirrors the
 *  `advanceStory` / `storySignoff` `_withRepo` + `repo.upsertStory` pattern.
 *  Throws `ConfigError` on a missing story id (or absent state.db). Only the
 *  fields whose opt is not `undefined` are mutated; `null` clears the field. */
export async function updateStory(
  atmuxDir: string,
  id: string,
  opts: UpdateStoryOpts,
): Promise<void> {
  if (await externalKanbanEnabled(atmuxDir)) {
    const story = await showStory(atmuxDir, id);
    if (!story) throw new ConfigError({ what: `story update: no such story: ${id}` });
    if (opts.body !== undefined) {
      await externalKanban.updateTask(atmuxDir, id, "atmux", { body: opts.body ?? "" });
    }
    if (opts.acceptanceCriteria !== undefined) {
      await externalKanban.patchMetadata(atmuxDir, id, "atmux", {
        acceptanceCriteria: opts.acceptanceCriteria,
      });
    }
    return;
  }
  if (!(await exists(_stateDbPath(atmuxDir)))) {
    throw new ConfigError({ what: `story update: no such story: ${id}` });
  }
  await _withRepo(atmuxDir, (repo, db) => {
    const story = repo.getStory(id);
    if (story === null) {
      throw new ConfigError({ what: `story update: no such story: ${id}` });
    }
    transact(db, () => {
      const updated: KanbanStory = { ...story };
      if (opts.body !== undefined) updated.body = opts.body;
      if (opts.acceptanceCriteria !== undefined) {
        updated.acceptanceCriteria = opts.acceptanceCriteria;
      }
      repo.upsertStory(updated);
    });
  });
}

// Re-export schema types so the verb layer imports stay together.
export type { KanbanStory };
