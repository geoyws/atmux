// ADR-027 T3: file-state orchestration steps for `atmux team rename`.
//
// Steps 1, 2, 5, 9 of ADR-027 §Orchestration — the side-effecting fs
// path that the top-level dispatcher (T2, in `team-rename.ts`) calls
// between the pre-flight refuse gates and the tmux/cron/cockpit/
// branch-rename steps (T2/T4/T5):
//
//   1. acquireRenameLock     — atomic-write .atmux/state/rename.lock
//   2. mutateTeamJson        — schema-validated rewrite of team.json:.name
//   5. rewriteSessionAnchor  — singleSession anchor state/session.txt
//   9. releaseRenameLock     — terminal cleanup (no rollback; success step)
//
// Every step (1, 2, 5) returns a `RollbackStep` whose `undo()` reverses
// just its own mutation. The dispatcher pushes each step into the
// `completed[]` array and `rollbackWalk()` (T1) reverse-walks on
// partial failure. Step 9 has no rollback — it's the terminal success
// marker; if anything earlier fails the lock stays held so the
// rolled-back state is consistent with a never-started rename.
//
// This file lives separately from `team-rename.ts` to dissolve the
// shared-worktree commit-race hazard (per
// `feedback_shared_index_commit_race_hazard.md` — 2 parallel members
// staging edits to the same file end up absorbing each other's work).
// `team-rename.ts` is owned by T1 + T2; T3 (this file), T4
// (`team-rename-cockpit.ts`), T5 (`team-rename-step5.ts`) ship in
// parallel without colliding. Dispatcher (T2) imports each by name.
//
// Pattern: mirrors `src/verbs/team-repair-rename.ts` §Apply-with-
// rollback — RollbackStep capture, best-effort undo, ConfigError on
// pre-condition violation. atomicWrite (mktemp + fsync + rename) is
// the only fs primitive used here so an interrupted rename never
// leaves a torn file behind.

import { join } from "node:path";
import { atomicWrite, exists, readText, readTextOrNull, removeFile } from "../abstractions/fs.ts";
import { readJson, writeJson } from "../abstractions/json.ts";
import { sessionAnchorPath, stateDir, teamJsonPath } from "../core/common.ts";
import { ConfigError } from "../errors.ts";
import { Team } from "../schema/team.ts";
import type { RollbackStep } from "./team-rename.ts";

// ---------- rename.lock ----------

/** Body of `.atmux/state/rename.lock`. Operator-readable JSON so a
 *  `cat rename.lock` during a wedged rename surfaces who held it. */
export interface RenameLockBody {
  old: string;
  new: string;
  /** `Date.now()` epoch millis at lock acquisition. */
  epoch: number;
}

/** Resolve `<atmuxDir>/state/rename.lock`. Exported for tests + T6
 *  convergence check (per ADR-027 §Consequences — T6 must verify no
 *  leftover lock after a successful rename). */
export function renameLockPath(atmuxDir: string): string {
  return join(stateDir(atmuxDir), "rename.lock");
}

/** Read-side guard primitive — true iff `acquireRenameLock` has run
 *  but `releaseRenameLock` hasn't (a rename orchestration is in
 *  flight). Cron'd consumers (cron-orphans, pulse, discorder digest)
 *  call this at entry and skip silently when true,
 *  per ADR-027 §Consequences "[[ -f rename.lock ]] && return 0".
 *
 *  Returns false on a missing atmuxDir / fs error — failing-open is
 *  safe for read-side guards (the worst case is a tick that races a
 *  mutation it would have skipped, which is the pre-ADR-027 baseline). */
export async function isRenameInProgress(atmuxDir: string): Promise<boolean> {
  try {
    return await exists(renameLockPath(atmuxDir));
  } catch {
    return false;
  }
}

// ---------- Step 1: acquireRenameLock ----------

export interface AcquireRenameLockInput {
  atmuxDir: string;
  oldName: string;
  newName: string;
}

/** Atomic-write `.atmux/state/rename.lock` with `{old, new, epoch}`.
 *  Refuses (throws `ConfigError`) if the lock file already exists —
 *  signals another rename mid-flight OR a stale lock left by a crashed
 *  prior rename. Operator hint surfaces the existing body so they can
 *  decide whether to rm it.
 *
 *  Returns a `RollbackStep` whose `undo()` removes the lock file. The
 *  removal is idempotent (`removeFile` uses `force: true`), so a
 *  rollback that re-runs after step 9 already released the lock is a
 *  silent no-op rather than an error. */
export async function acquireRenameLock(input: AcquireRenameLockInput): Promise<RollbackStep> {
  const path = renameLockPath(input.atmuxDir);
  if (await exists(path)) {
    const existing = await readTextOrNull(path);
    throw new ConfigError({
      what: `rename.lock already exists at ${path} — another rename mid-flight or stale lockfile`,
      hint: `inspect contents (${existing ?? "<unreadable>"}) and \`rm\` if confirmed stale`,
    });
  }
  const body: RenameLockBody = {
    old: input.oldName,
    new: input.newName,
    epoch: Date.now(),
  };
  await atomicWrite(path, `${JSON.stringify(body, null, 2)}\n`);
  return {
    label: `step 1 — acquire rename.lock (${input.oldName} → ${input.newName})`,
    undo: async () => {
      await removeFile(path);
    },
  };
}

// ---------- Step 2: mutateTeamJson ----------

export interface MutateTeamJsonInput {
  atmuxDir: string;
  oldName: string;
  newName: string;
}

/** Snapshot the raw bytes of `team.json` to `team.json.bak.<epoch>`
 *  (seconds; matches the existing groom-side bak naming so
 *  `cullBakFiles` keeps newest-N per family per ADR-068), then
 *  schema-validated read → mutate `.name` → schema-validated atomic
 *  write back. The backup snapshot captures byte-exact content
 *  (including any operator-added trailing whitespace, key ordering,
 *  etc.) so `undo()` restores byte-equal, not just structurally
 *  equivalent.
 *
 *  Caller (T2 dispatcher) is expected to have already validated
 *  `current.name === oldName` via the pre-flight load — this helper
 *  does not re-check, treating `oldName` purely as a rollback / log
 *  label.
 *
 *  Returns a `RollbackStep` whose `undo()` restores `team.json` from
 *  the backup file then removes the backup. If the backup file has
 *  been manually removed between mutation and undo (operator
 *  intervention), the undo throws `FsError` via `readText`; the
 *  rollback walker collects the failure rather than aborting siblings
 *  (per `rollbackWalk` contract in T1). */
export async function mutateTeamJson(input: MutateTeamJsonInput): Promise<RollbackStep> {
  const path = teamJsonPath(input.atmuxDir);
  const original = await readText(path);
  const epoch = Math.floor(Date.now() / 1000);
  const backupPath = `${path}.bak.${epoch}`;
  await atomicWrite(backupPath, original);

  const current = await readJson(path, Team);
  const next = { ...current, name: input.newName };
  await writeJson(path, Team, next);

  return {
    label: `step 2 — mutate team.json (.name ${input.oldName} → ${input.newName})`,
    undo: async () => {
      const backup = await readText(backupPath);
      await atomicWrite(path, backup);
      await removeFile(backupPath);
    },
  };
}

// ---------- Step 5: rewriteSessionAnchor ----------

export interface RewriteSessionAnchorInput {
  atmuxDir: string;
  newSession: string;
}

/** Rewrite the singleSession-team anchor at
 *  `<atmuxDir>/state/session.txt` (per `sessionAnchorPath` from
 *  `core/common.ts`). When the file is absent (`singleSession=false`
 *  teams never write it; the escape hatch is documented in ADR-016
 *  Phase 1 + ADR-026), this step is a true no-op — it returns an
 *  identity `RollbackStep` so the dispatcher's `completed[]` array
 *  shape stays consistent across both shapes of team.
 *
 *  When the file is present, we capture the prior raw bytes (preserves
 *  the exact trailing-newline shape, since older atmux versions wrote
 *  `team` and newer write `team\n`) and atomic-write
 *  `${newSession}\n`. `undo()` atomic-writes the prior bytes back. */
export async function rewriteSessionAnchor(
  input: RewriteSessionAnchorInput,
): Promise<RollbackStep> {
  const path = sessionAnchorPath(input.atmuxDir);
  const prior = await readTextOrNull(path);
  if (prior === null) {
    return {
      label: "step 5 — rewrite session.txt (no-op — anchor absent, singleSession=false)",
      undo: async () => {
        // Identity. Even if a writer creates the file between capture
        // and undo (extremely unlikely under rename.lock guard), removing
        // it here would be lossy.
      },
    };
  }
  await atomicWrite(path, `${input.newSession}\n`);
  return {
    label: `step 5 — rewrite session.txt (${prior.trim()} → ${input.newSession})`,
    undo: async () => {
      await atomicWrite(path, prior);
    },
  };
}

// ---------- Step 9: releaseRenameLock ----------

export interface ReleaseRenameLockInput {
  atmuxDir: string;
}

/** Terminal cleanup — remove `.atmux/state/rename.lock`. Idempotent:
 *  `removeFile` uses `force: true`, so calling on an already-removed
 *  lock is a silent no-op (matches the `rm -f` semantics the bash
 *  spec inherited from ADR-027 §Orchestration step 9).
 *
 *  No `RollbackStep` returned — this is the success marker, called
 *  AFTER every other step landed. Per ADR-027 §Consequences, the T6
 *  convergence check fails if it sees a leftover lock; calling this
 *  unconditionally at the end of the orchestration chain keeps T6
 *  green on every happy-path rename. */
export async function releaseRenameLock(input: ReleaseRenameLockInput): Promise<void> {
  await removeFile(renameLockPath(input.atmuxDir));
}
