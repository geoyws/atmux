// ADR-027 T1: pure orchestration helpers + arg parser for
// `atmux team rename <new-name> [--from <old>] ...`. Verb-level
// dispatcher + side-effecting steps (tmux / fs / cron / registry)
// land in T2-T5. This file ships ONLY pure helpers + the arg parser
// so its consumers (T2-T5) can fan out in parallel.
//
// Pattern: mirrors src/verbs/team-repair-rename.ts §Args + §Pure
// helpers. Refuse-gate semantics from ADR-027 §Pre-flight:
//   - hard refuse (no --force bypass): invalid name, registry collision.
//   - soft refuse (--force bypasses): in-progress kanban tasks.
//
// `collidesWithCockpit` walks ADR-089's recursive `sessions[]` tree —
// any `type: "team"` node whose `name` equals the new team-name is a
// collision target. `epic-team` siblings live in a different
// discriminator namespace and are NOT collision sources (an epic-team
// is anchored to its parent team's project root; the rename verb
// targets standalone teams).

import { ConfigError, UsageError } from "../errors.ts";
import type { Cockpit, CockpitSessionT } from "../schema/cockpit.ts";
import type { KanbanTask } from "../schema/kanban.ts";

const USAGE =
  "atmux team rename <new-name> [--from <old>] [--session <new-session>] [--dry-run] [--force] [--force-branches] [--socket <path>] [--team-dir <path>]";

const TEAM_NAME_RE = /^[a-z0-9_-]+$/;

// ---------- Args ----------

export interface TeamRenameArgs {
  newName: string;
  from?: string;
  session?: string;
  dryRun: boolean;
  force: boolean;
  forceBranches: boolean;
  socketPath?: string;
  teamDir?: string;
}

export function parseTeamRenameArgs(argv: ReadonlyArray<string>): TeamRenameArgs {
  let newName = "";
  let from: string | undefined;
  let session: string | undefined;
  let dryRun = false;
  let force = false;
  let forceBranches = false;
  let socketPath: string | undefined;
  let teamDir: string | undefined;
  const seen = new Set<string>();

  const markSeen = (flag: string): void => {
    if (seen.has(flag)) {
      throw new UsageError({ what: `team rename: duplicate flag: ${flag}`, hint: USAGE });
    }
    seen.add(flag);
  };
  const requireValue = (flag: string, i: number): string => {
    const v = argv[i + 1];
    if (v === undefined) {
      throw new UsageError({ what: `team rename: ${flag} requires a value`, hint: USAGE });
    }
    return v;
  };

  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--dry-run") {
      markSeen(a);
      dryRun = true;
      i += 1;
      continue;
    }
    if (a === "--force") {
      markSeen(a);
      force = true;
      i += 1;
      continue;
    }
    if (a === "--force-branches") {
      markSeen(a);
      forceBranches = true;
      i += 1;
      continue;
    }
    if (a === "--from") {
      markSeen(a);
      from = requireValue(a, i);
      i += 2;
      continue;
    }
    if (a === "--session") {
      markSeen(a);
      session = requireValue(a, i);
      i += 2;
      continue;
    }
    if (a === "--socket") {
      markSeen(a);
      socketPath = requireValue(a, i);
      i += 2;
      continue;
    }
    if (a === "--team-dir") {
      markSeen(a);
      teamDir = requireValue(a, i);
      i += 2;
      continue;
    }
    if (a?.startsWith("-")) {
      throw new UsageError({ what: `team rename: unknown flag: ${a}`, hint: USAGE });
    }
    if (newName.length === 0) {
      newName = a ?? "";
    } else {
      throw new UsageError({
        what: "team rename: too many positionals (expected one <new-name>)",
        hint: USAGE,
      });
    }
    i += 1;
  }

  if (newName.length === 0) {
    throw new UsageError({ what: USAGE });
  }

  const out: TeamRenameArgs = { newName, dryRun, force, forceBranches };
  if (from !== undefined) out.from = from;
  if (session !== undefined) out.session = session;
  if (socketPath !== undefined) out.socketPath = socketPath;
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

// ---------- validateTeamName ----------

/** Throws ConfigError if `name` is not `[a-z0-9_-]+`. Mirrors ADR-027
 *  §Pre-flight refuse-gate "invalid team-name" condition; the verb-level
 *  dispatcher (T2) calls this BEFORE acquiring the rename.lock so a
 *  bad arg short-circuits with no state mutation. */
export function validateTeamName(name: string): void {
  if (!TEAM_NAME_RE.test(name)) {
    throw new ConfigError({
      what: `invalid team-name '${name}' — accepted charset is [a-z0-9_-]+`,
      hint: "use lowercase letters, digits, underscore, or hyphen",
    });
  }
}

// ---------- Refuse-gate predicates (pure) ----------

/** True iff any task has `status === "in-progress"`. Soft refuse signal
 *  per ADR-027 §Pre-flight — caller bypasses with `--force` if the
 *  operator accepts the indeterminate-naming risk. */
export function hasInProgressTasks(tasks: ReadonlyArray<KanbanTask>): boolean {
  return tasks.some((t) => t.status === "in-progress");
}

/** DFS walk of `cockpit.sessions[]` looking for a `type: "team"` node
 *  whose `name` equals `newName`. Walks into nested `sessions[]` on
 *  every `team` or `epic-team` node so ADR-089 recursive children are
 *  reachable. Returns true on the first hit. */
export function collidesWithCockpit(cockpit: Cockpit, newName: string): boolean {
  const visit = (nodes: ReadonlyArray<CockpitSessionT>): boolean => {
    for (const n of nodes) {
      if (n.type === "team" && n.name === newName) return true;
      if (n.type === "team" || n.type === "epic-team") {
        if (n.sessions.length > 0 && visit(n.sessions)) return true;
      }
    }
    return false;
  };
  return visit(cockpit.sessions ?? []);
}

// ---------- runRefuseGates ----------

export interface RefuseGateInput {
  tasks: ReadonlyArray<KanbanTask>;
  cockpit: Cockpit;
  newName: string;
  force: boolean;
}

export interface RefuseResult {
  refuse: boolean;
  reason?: string;
  /** BSD sysexits code matching `ConfigError`'s exit code (78 = EX_CONFIG). */
  exitCode?: number;
}

/** Aggregates the three ADR-027 pre-flight gates. Order matters: hard
 *  refuses (invalid name, collision) are checked first so they always
 *  surface even with `--force` set. The soft refuse (in-progress tasks)
 *  fires only when `force` is false. */
export function runRefuseGates(input: RefuseGateInput): RefuseResult {
  if (!TEAM_NAME_RE.test(input.newName)) {
    return {
      refuse: true,
      reason: `invalid team-name '${input.newName}' — accepted charset is [a-z0-9_-]+`,
      exitCode: 78,
    };
  }
  if (collidesWithCockpit(input.cockpit, input.newName)) {
    return {
      refuse: true,
      reason: `team '${input.newName}' already exists in cockpit registry — collision`,
      exitCode: 78,
    };
  }
  if (hasInProgressTasks(input.tasks) && !input.force) {
    return {
      refuse: true,
      reason:
        "kanban has in-progress tasks — rename would land mid-flight work in indeterminate naming state (pass --force to override)",
      exitCode: 78,
    };
  }
  return { refuse: false };
}

// ---------- Rollback ----------

export interface RollbackStep {
  /** Human-readable label for the rollback log. */
  label: string;
  /** Idempotent best-effort undo. Throws on failure; `rollbackWalk`
   *  collects throws into `RollbackResult.failures` rather than aborting
   *  the reverse walk so every step gets its chance to undo. */
  undo: () => Promise<void>;
}

export interface RollbackFailure {
  step: RollbackStep;
  error: unknown;
}

export interface RollbackResult {
  walked: number;
  failures: ReadonlyArray<RollbackFailure>;
}

/** Reverse-iterates `completed` and invokes each step's `undo`. Mirrors
 *  the rollback engine in `team-repair-rename.ts::applyRepair`'s inline
 *  reverse-walk — factored out here so T2-T5 share one implementation.
 *  Failures are best-effort: a throw in step N's undo doesn't stop step
 *  N-1 from running. */
export async function rollbackWalk(
  completed: ReadonlyArray<RollbackStep>,
): Promise<RollbackResult> {
  const failures: RollbackFailure[] = [];
  let walked = 0;
  for (let i = completed.length - 1; i >= 0; i--) {
    const step = completed[i];
    if (step === undefined) continue;
    walked += 1;
    try {
      await step.undo();
    } catch (err) {
      failures.push({ step, error: err });
    }
  }
  return { walked, failures };
}
