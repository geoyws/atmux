// ADR-052 T7: cycle-loop mechanics for `atmux improve`.
//
// Builds on T1 (verb skeleton + budget resolution) and T2 (state-file
// IO + idempotence). Provides:
//
//   - Pure cycle-state mutations: `openCycle`, `closeCycle`,
//     `pauseCycle`, `resumeCycle`, `recordDispatch/Landed/Done`,
//     `tickTokens`.
//   - Pure predicates against external state: `isCycleClosable` (checks
//     all dispatched tasks have status `done` AND a non-null `completedAt`
//     proxy for "committed"), `shouldTerminate` (budgetRemaining ≤ 0),
//     `isDriverPreempt` (any in-progress kanban task has `epic` ≠ the
//     improvement epic id).
//   - Cycle-arming directive builder: `buildArmMessage(cycleN)` —
//     pure string builder for the lead prompt template per ADR-052
//     §"Loop mechanics" step 1.
//   - File-IO helper: `armCycle(atmuxDir, state, opts)` — writes a
//     dated entry to `.atmux/improve-directives.md` AND returns the
//     same prompt body for an out-of-band ping (the actual `tmux
//     send-keys` lives at the verb's call-site, where the spawn
//     abstraction is wired).
//
// Per ADR-003 layering: imports from src/abstractions/* and
// src/core/{common,eternal-improvement} are fine; never `src/verbs/*`.
//
// "Committed" detection note. T7's brief asks for "committed (commit
// verifiable via git log)". For the LIBRARY layer we use `completedAt`
// as the commit-equivalent proxy: gitter sets `completedAt` only after
// the back-side commit lands per the kanban write convention. A future
// hardening pass (T8 / e2e) can swap this for an explicit `git log`
// probe — the predicate signature is closed-over so call-sites can
// inject a `commitChecker` that does the actual `git log` if desired.

import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir, exists } from "../abstractions/fs.ts";
import { formatMyt } from "../abstractions/time.ts";
import type {
  EternalImprovementCurrentCycle,
  EternalImprovementHistoryEntry,
  EternalImprovementState,
} from "../schema/eternal-improvement.ts";
import type { KanbanTask } from "../schema/kanban.ts";
import { HISTORY_RING_MAX } from "./improve.ts";

// ---------- Constants ----------

/** Epic id reserved for improvement-spawned Tasks (ADR-052 §"Mid-run
 *  preemption" — driver-dispatched tasks lack this epic). */
export const IMPROVEMENT_EPIC_ID = "e-a25968cc";

/** Filename for the directive log the lead reads on each whip turn. */
export const IMPROVE_DIRECTIVES_FILENAME = "improve-directives.md";

// ---------- Path helpers ----------

export function improveDirectivesPath(atmuxDir: string): string {
  return join(atmuxDir, IMPROVE_DIRECTIVES_FILENAME);
}

// ---------- Pure cycle-state mutations ----------

/** Open a new cycle. cycleN increments by 1; currentCycle reset to a
 *  fresh entry with `startedAt = nowSec`. Caller is responsible for
 *  passing a state that does NOT already have an active currentCycle
 *  (closeCycle should run first). */
export function openCycle(state: EternalImprovementState, nowSec: number): EternalImprovementState {
  return {
    ...state,
    cycleN: state.cycleN + 1,
    currentCycle: {
      startedAt: nowSec,
      tasksLanded: [],
      tasksDispatched: [],
      tasksDone: [],
      tokensSpent: 0,
    },
  };
}

/**
 * Close the current cycle. Moves `currentCycle` to `history` (capped at
 * HISTORY_RING_MAX), sets `lastCycleClosedAt = nowSec`, decrements
 * `budgetRemaining` by `tokensSpent`. `currentCycle` is reset to `null`.
 *
 * No-op (returns state unchanged) if `currentCycle` is null — the
 * close-when-already-closed case is tolerated for idempotent ticks.
 */
export function closeCycle(
  state: EternalImprovementState,
  nowSec: number,
): EternalImprovementState {
  const cur = state.currentCycle;
  if (cur === null) return state;
  const entry: EternalImprovementHistoryEntry = {
    cycleN: state.cycleN,
    startedAt: cur.startedAt,
    closedAt: nowSec,
    tasksLanded: cur.tasksLanded.length,
    tasksDone: cur.tasksDone.length,
    tokensSpent: cur.tokensSpent,
  };
  const history = [...state.history, entry];
  const capped = history.length > HISTORY_RING_MAX ? history.slice(-HISTORY_RING_MAX) : history;
  return {
    ...state,
    currentCycle: null,
    history: capped,
    lastCycleClosedAt: nowSec,
    budgetRemaining: state.budgetRemaining - cur.tokensSpent,
  };
}

/** Mark `currentCycle.paused: true`. No-op if no current cycle. */
export function pauseCycle(state: EternalImprovementState): EternalImprovementState {
  if (state.currentCycle === null) return state;
  return {
    ...state,
    currentCycle: { ...state.currentCycle, paused: true },
  };
}

/** Clear `currentCycle.paused`. No-op if no current cycle / not paused. */
export function resumeCycle(state: EternalImprovementState): EternalImprovementState {
  if (state.currentCycle === null) return state;
  if (state.currentCycle.paused !== true) return state;
  // Strip the `paused` key by destructuring it away — keeps the file
  // shape minimal between runs (no `"paused": false` cruft).
  const { paused: _paused, ...rest } = state.currentCycle;
  return {
    ...state,
    currentCycle: rest as EternalImprovementCurrentCycle,
  };
}

/** Append a Task id to `currentCycle.tasksDispatched`. Idempotent on
 *  duplicate ids (no-op if already present). */
export function recordDispatch(
  state: EternalImprovementState,
  taskId: string,
): EternalImprovementState {
  if (state.currentCycle === null) return state;
  if (state.currentCycle.tasksDispatched.includes(taskId)) return state;
  return {
    ...state,
    currentCycle: {
      ...state.currentCycle,
      tasksDispatched: [...state.currentCycle.tasksDispatched, taskId],
    },
  };
}

/** Append a Task id to `currentCycle.tasksLanded` (planner created it).
 *  Idempotent on duplicate ids. */
export function recordLanded(
  state: EternalImprovementState,
  taskId: string,
): EternalImprovementState {
  if (state.currentCycle === null) return state;
  if (state.currentCycle.tasksLanded.includes(taskId)) return state;
  return {
    ...state,
    currentCycle: {
      ...state.currentCycle,
      tasksLanded: [...state.currentCycle.tasksLanded, taskId],
    },
  };
}

/** Append a Task id to `currentCycle.tasksDone` (gitter committed it).
 *  Idempotent on duplicate ids. */
export function recordDone(
  state: EternalImprovementState,
  taskId: string,
): EternalImprovementState {
  if (state.currentCycle === null) return state;
  if (state.currentCycle.tasksDone.includes(taskId)) return state;
  return {
    ...state,
    currentCycle: {
      ...state.currentCycle,
      tasksDone: [...state.currentCycle.tasksDone, taskId],
    },
  };
}

/** Add `delta` tokens to `currentCycle.tokensSpent`. Negative deltas are
 *  rejected (clamped to 0) — token spend never goes backward in a
 *  cycle. */
export function tickTokens(
  state: EternalImprovementState,
  deltaTokens: number,
): EternalImprovementState {
  if (state.currentCycle === null) return state;
  const delta = Math.max(0, deltaTokens);
  return {
    ...state,
    currentCycle: {
      ...state.currentCycle,
      tokensSpent: state.currentCycle.tokensSpent + delta,
    },
  };
}

// ---------- Predicates ----------

/** Per-task commit-checker injected by the verb. Default proxies on
 *  `completedAt` (gitter sets it only after the back-side commit).
 *  T8 / e2e can swap for an explicit `git log` probe. */
export type CommitChecker = (task: KanbanTask) => boolean;

/** Default commit checker — non-null `completedAt` proxies "gitter
 *  committed". */
export const defaultCommitChecker: CommitChecker = (t) =>
  t.completedAt !== null && t.completedAt !== undefined;

/**
 * True when every Task id in `currentCycle.tasksDispatched` is present
 * in `kanbanTasks` AND has `status: 'done'` AND passes `commitChecker`.
 * Returns false if `currentCycle` is null, if `tasksDispatched` is
 * empty (no tasks → no close), or if any dispatched task is missing
 * from the kanban (likely deleted — caller's problem to resolve).
 */
export function isCycleClosable(
  state: EternalImprovementState,
  kanbanTasks: ReadonlyArray<KanbanTask>,
  commitChecker: CommitChecker = defaultCommitChecker,
): boolean {
  const cur = state.currentCycle;
  if (cur === null) return false;
  if (cur.tasksDispatched.length === 0) return false;
  const byId = new Map(kanbanTasks.map((t) => [t.id, t]));
  for (const id of cur.tasksDispatched) {
    const t = byId.get(id);
    if (t === undefined) return false;
    if (t.status !== "done") return false;
    if (!commitChecker(t)) return false;
  }
  return true;
}

/**
 * True when the run should terminate per ADR-052 §Termination:
 *   - budgetRemaining ≤ 0 (mid-cycle overage allowed during a cycle —
 *     this predicate is meant for post-cycle-close checks).
 *
 * Mode B's "kanban-empty" extra check is enforced by the verb, not
 * here — this predicate only models the budget-exhaustion criterion.
 */
export function shouldTerminate(state: EternalImprovementState): boolean {
  return state.budgetRemaining <= 0;
}

/**
 * True when any task in `kanbanTasks` is `status: 'in-progress'` AND
 * NOT part of an improvement run (i.e., `epic !== improvementEpicId`).
 * Caller pauses the loop on `true` per ADR-052 §"Mid-run preemption".
 *
 * `improvementEpicId` defaults to the constant `IMPROVEMENT_EPIC_ID`
 * but is parameterised so test fixtures + future-rename cases
 * (different epic per cage) can swap it.
 */
export function isDriverPreempt(
  kanbanTasks: ReadonlyArray<KanbanTask>,
  improvementEpicId: string = IMPROVEMENT_EPIC_ID,
): boolean {
  for (const t of kanbanTasks) {
    if (t.status !== "in-progress") continue;
    const epic = t.epic ?? null;
    if (epic !== improvementEpicId) return true;
  }
  return false;
}

// ---------- Lead-routing arm helpers ----------

/** One longstanding backlog item the cycle should burn down before any
 *  net-new improvement (ADR-257). Oldest-first; `ageSec` + `priority`
 *  carried for callers/tests (priority: lower = higher per kanban schema). */
export interface LongstandingIssue {
  id: string;
  subject: string;
  ageSec: number;
  priority: number;
}

/**
 * ADR-257 §D1 — burndown-first selection. Rank the team's OPEN backlog
 * (`status: 'todo'`) oldest-first (longstanding = smallest `createdAt`),
 * tie-breaking by priority (lower number = higher priority per the kanban
 * schema). Excludes the improvement loop's OWN net-new Tasks
 * (`epic === improvementEpicId`) so the loop burns down the real backlog
 * rather than its own output, and excludes `driverOnly` Tasks (members
 * working the cycle can't claim driver-scoped work). Returns the top
 * `limit` (default 3, matching ADR-052's "top 1-3"). Pure.
 */
export function selectLongstandingIssues(
  tasks: ReadonlyArray<KanbanTask>,
  nowSec: number,
  opts: { limit?: number; improvementEpicId?: string } = {},
): LongstandingIssue[] {
  const limit = opts.limit ?? 3;
  const improvementEpicId = opts.improvementEpicId ?? IMPROVEMENT_EPIC_ID;
  const candidates = tasks.filter(
    (t) => t.status === "todo" && (t.epic ?? null) !== improvementEpicId && t.driverOnly !== true,
  );
  candidates.sort((a, b) => {
    const ageA = a.createdAt ?? nowSec;
    const ageB = b.createdAt ?? nowSec;
    if (ageA !== ageB) return ageA - ageB; // older (smaller createdAt) first
    // tie-break: lower priority number = higher priority → first.
    const pa = a.priority ?? Number.MAX_SAFE_INTEGER;
    const pb = b.priority ?? Number.MAX_SAFE_INTEGER;
    return pa - pb;
  });
  return candidates.slice(0, limit).map((t) => ({
    id: t.id,
    subject: t.subject ?? "(no subject)",
    ageSec: Math.max(0, nowSec - (t.createdAt ?? nowSec)),
    priority: t.priority ?? -1,
  }));
}

/**
 * Build the lead-prompt body (ADR-052 §"Loop mechanics" step 1, reframed
 * by ADR-257). Burndown-first: when `longstanding` is non-empty the
 * directive names those oldest open Tasks to resolve FIRST (in order);
 * an empty backlog falls back to net-new improvement candidates. Either
 * way the work MUST happen in an isolated improvement worktree and reach
 * trunk only via the verified committer (ADR-257 §D3).
 *
 * ADR-280 stage 3: the isolation clause used to name `atmux team
 * spawn-epic`, a verb that no longer exists. It now names `git worktree`
 * directly — the ISOLATION contract is what ADR-257 §D3 requires; the
 * epic-team was only ever one way of getting it.
 */
export function buildArmMessage(
  cycleN: number,
  longstanding: ReadonlyArray<LongstandingIssue> = [],
): string {
  const head = `🌱 eternal-improvement cycle ${cycleN} requested (ADR-257 burndown-first).`;
  // Standing isolation contract — same every cycle (ADR-257 §D3).
  const worktree =
    ` Do ALL cycle work in an isolated improvement worktree ` +
    `(\`git worktree add\` off the improvement branch — reuse the live one if ` +
    `present; large items get NESTED worktrees branched from that base). Commit ` +
    `to the improvement branch; the ADR-134 committer fans it into trunk LATER, ` +
    `only when verified green — never land unverified work on trunk.`;
  if (longstanding.length > 0) {
    const ids = longstanding.map((i) => i.id).join(", ");
    return (
      `${head} LONGSTANDING ISSUES FIRST — resolve these oldest open Tasks ` +
      `(oldest→newest) before any net-new improvement: ${ids}.${worktree}`
    );
  }
  return (
    `${head} No longstanding backlog — ask each lane member their top ` +
    `improvement candidate; score by impact-vs-cost; land top 1-3.${worktree}`
  );
}

export interface ArmCycleOpts {
  /** Override the timestamp string written to the directives file. */
  timestamp?: string;
  /** ADR-257 burndown-first — the longstanding backlog items the planner
   *  should resolve before net-new improvements. Computed by the caller
   *  (which has the loaded kanban) via {@link selectLongstandingIssues};
   *  defaults to `[]` (net-new fallback directive). */
  longstanding?: ReadonlyArray<LongstandingIssue>;
}

/**
 * Append an arm-cycle directive to `<atmuxDir>/improve-directives.md`.
 * Creates the file with a header on first write. Returns the prompt
 * body so the verb can ALSO ping the lead's pane out-of-band (the
 * actual `tmux send-keys` lives at the verb call-site where the spawn
 * abstraction is wired).
 */
export async function armCycle(
  atmuxDir: string,
  state: EternalImprovementState,
  opts: ArmCycleOpts = {},
): Promise<string> {
  const path = improveDirectivesPath(atmuxDir);
  await ensureDir(atmuxDir);
  const ts = opts.timestamp ?? formatMyt();
  const body = buildArmMessage(state.cycleN, opts.longstanding ?? []);

  if (!(await exists(path))) {
    await appendFile(
      path,
      "# Improve Directives — eternal-improvement cycle prompts\n" +
        "\n" +
        "Lead reads this file at the start of every whip turn to pick up\n" +
        "fresh `atmux improve` cycle prompts. Each entry is timestamped\n" +
        "and references the run's `runId` for cross-correlation with\n" +
        "`.atmux/state/eternal-improvement.json`.\n" +
        "\n" +
        "## Open\n",
    );
  }
  await appendFile(path, `- [${ts}] runId=${state.runId} cycle=${state.cycleN} — ${body}\n`);
  return body;
}
