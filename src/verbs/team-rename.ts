// ADR-027 T1 + T2: orchestration helpers, arg parser, and first-cut
// dispatcher for `atmux team rename <new-name> [--from <old>] ...`.
//
// T1 (shipped first) — pure helpers + arg parser (parseTeamRenameArgs,
// validateTeamName, hasInProgressTasks, collidesWithCockpit,
// runRefuseGates, RollbackStep + rollbackWalk).
//
// T2 (this commit) — tmux + cron orchestration steps 3 + 6 + the
// top-level `teamRename` dispatcher. Steps 1, 2, 4, 5, 7, 8, 9 ship
// as injectable stubs (no-op defaults) — T3/T4/T5 each override the
// stub for their slot when wiring real impls. The dispatcher is
// already wired into the rollbackWalk reverse-undo chain so a partial
// failure at step 3 OR step 6 unwinds correctly.
//
// Pattern: mirrors src/verbs/team-repair-rename.ts §Args + §Pure
// helpers + §Apply-with-rollback. Refuse-gate semantics from ADR-027
// §Pre-flight: hard refuses (invalid name, registry collision) are
// not bypassable by --force; soft refuse (in-progress kanban tasks)
// bypasses with --force.
//
// `collidesWithCockpit` walks ADR-089's recursive `sessions[]` tree —
// any `type: "team"` node whose `name` equals the new team-name is a
// collision target. `epic-team` siblings live in a different
// discriminator namespace and are NOT collision sources.
//
// Step 6 (cron re-install) uses the install-new-then-strip-old order
// internally via `installCronBlock`'s `stripByAtmuxDir` pass (single
// atomic crontab swap; per ADR-027 §OQ H3 there's never a zero-cron
// window). Non-fatal env-skip / missing-binary cases are swallowed by
// the inner `cronInstall` (warn + exit 0); the dispatcher proceeds.

import { dirname } from "node:path";
import type { CrontabIO } from "../abstractions/crontab.ts";
import type { TmuxNamespace } from "../abstractions/tmux.ts";
import { loadCockpit } from "../core/cockpit.ts";
import { getAtmuxDir, getDefaultSocket, loadTeam, type ResolveDirOpts } from "../core/common.ts";
import { defaultStderrWrite, defaultStdoutWrite, type Writer } from "../core/io.ts";
import { listTasks } from "../core/kanban.ts";
import { ConfigError, UsageError } from "../errors.ts";
import type { Cockpit, CockpitSessionT } from "../schema/cockpit.ts";
import type { KanbanTask } from "../schema/kanban.ts";
import { cronInstall } from "./cron-install.ts";

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

// ============================================================
// T2 — Step 3 (tmux rename-session) + Step 6 (cron re-install)
// ============================================================

/** Step 3 — `tmux rename-session` on the team's cage socket. Idempotent
 *  when oldSession === newSession (returns a no-op rollback step).
 *  PIDs preserved; cage's claude TUIs keep their sockets open through
 *  the metadata rename. */
export interface RenameTmuxSessionInput {
  tmux: TmuxNamespace;
  oldSession: string;
  newSession: string;
}

export async function renameTmuxSession(input: RenameTmuxSessionInput): Promise<RollbackStep> {
  if (input.oldSession === input.newSession) {
    return {
      label: `step 3 — tmux rename-session: '${input.oldSession}' === '${input.newSession}', skipped`,
      undo: async () => {
        /* no-op */
      },
    };
  }
  await input.tmux.session.renameSession(input.oldSession, input.newSession);
  return {
    label: `step 3 — tmux rename-session '${input.oldSession}' → '${input.newSession}'`,
    undo: async () => {
      await input.tmux.session.renameSession(input.newSession, input.oldSession).catch(() => {
        /* best-effort */
      });
    },
  };
}

/** Step 6 — cron re-install. Captures the original crontab body so
 *  rollback can restore byte-for-byte, then delegates to `cronInstall`
 *  which atomically swaps in a fresh block stripped + re-rendered
 *  under the new team-name (single atomic crontab swap; no zero-cron
 *  window per ADR-027 §OQ H3). Non-fatal posture: when `cronInstall`
 *  returns 0 from a no-op skip path (ATMUX_NO_CRON, crontab absent,
 *  bin resolution failed) the RollbackStep is still returned so the
 *  caller's chain stays coherent — undo restores the snapshot, which
 *  in the no-op case equals the current state. */
export interface ReinstallCronBlockInput {
  teamDir: string;
  oldName: string;
  newName: string;
  crontab: CrontabIO;
  cronInstallFn?: (argv: ReadonlyArray<string>) => Promise<number>;
}

export async function reinstallCronBlock(input: ReinstallCronBlockInput): Promise<RollbackStep> {
  const snapshot = await input.crontab.read();
  const fn = input.cronInstallFn ?? cronInstall;
  await fn(["--quiet", "--team-dir", input.teamDir]);
  return {
    label: `step 6 — cron re-install (block migrated '${input.oldName}' → '${input.newName}')`,
    undo: async () => {
      try {
        await input.crontab.write(snapshot ?? "");
      } catch {
        /* best-effort; surfaced via rollback log */
      }
    },
  };
}

// ============================================================
// T2 — TeamRenameDeps + dispatcher
// ============================================================

/** Injectable orchestration steps. T2 ships defaults that:
 *  - Step 3 (renameTmuxSession) + Step 6 (reinstallCronBlock) → REAL.
 *  - Steps 1, 2, 4, 5, 7, 8, 9 → no-op stubs with labelled RollbackStep
 *    placeholders so the rollback chain stays inspectable.
 *  T3/T4/T5 override the stubs in their respective slots when wiring
 *  real impls. */
export interface TeamRenameDeps {
  /** Step 1 — acquire `.atmux/state/rename.lock`. T3 wires real impl. */
  acquireRenameLock?: (atmuxDir: string) => Promise<RollbackStep>;
  /** Step 2 — `team.json:.name = newName`. T3 wires real impl. */
  mutateTeamJsonName?: (
    atmuxDir: string,
    oldName: string,
    newName: string,
  ) => Promise<RollbackStep>;
  /** Step 4 — window rename on the relevant socket. T5 wires real impl.
   *  TODO(T6 convergence): the ADR-027 §step 3 `__<old>__*` per-pane
   *  rename pattern is pre-ADR-135/162 and dead in current topology
   *  (post-ADR-135 windows are emoji-prefix `🐝-<member>` on the team
   *  cage socket; per-member-pane rename is moot since members are
   *  1-pane-per-window). T5's actual step-4 is the COCKPIT team-viewer
   *  window rename on the `-L atmux-cockpit` socket (different socket
   *  entirely from the cage). This dispatcher slot's signature reflects
   *  the legacy ADR-027 wording; T6 (convergence) is the natural owner
   *  of the signature rework + ADR-027 §Deviations note. T2 ships a
   *  no-op stub so the orchestration chain stays intact. */
  renameMemberWindows?: (
    tmux: TmuxNamespace,
    session: string,
    oldName: string,
    newName: string,
  ) => Promise<RollbackStep>;
  /** Step 5 — `.atmux/state/session.txt` rewrite when present. T3 wires
   *  real impl. */
  rewriteSessionTxt?: (atmuxDir: string, newName: string) => Promise<RollbackStep>;
  /** Step 7 — cockpit.json registry update. T4 wires real impl. */
  updateCockpitRegistry?: (
    oldName: string,
    newName: string,
    newSession: string,
  ) => Promise<RollbackStep>;
  /** Step 8 — per-member branch rename. T5 wires real impl. */
  renameMemberBranches?: (
    atmuxDir: string,
    oldName: string,
    newName: string,
    forceBranches: boolean,
  ) => Promise<RollbackStep>;
  /** Step 9 — release lock. Always runs in `finally`; not on rollback
   *  chain. T3 wires real impl. */
  releaseRenameLock?: (atmuxDir: string) => Promise<void>;

  loadCockpitFn?: () => Promise<Cockpit>;
  loadTasksFn?: (atmuxDir: string) => Promise<ReadonlyArray<KanbanTask>>;
  buildTmuxAtSocket?: (socketPath: string) => TmuxNamespace;
  crontab?: CrontabIO;
  cronInstallFn?: (argv: ReadonlyArray<string>) => Promise<number>;
  stdout?: Writer;
  stderr?: Writer;
}

const stubStep = (label: string): RollbackStep => ({
  label,
  undo: async () => {
    /* no-op stub */
  },
});

/** Production stub registry — every step T3/T4/T5 will own returns a
 *  labelled no-op so the rollback chain still has an entry for that
 *  slot. The label encodes "stub — Tn wires" so observers reading the
 *  rollback log know which Task fills it in. */
function defaultDeps(): Required<
  Pick<
    TeamRenameDeps,
    | "acquireRenameLock"
    | "mutateTeamJsonName"
    | "renameMemberWindows"
    | "rewriteSessionTxt"
    | "updateCockpitRegistry"
    | "renameMemberBranches"
    | "releaseRenameLock"
  >
> {
  return {
    acquireRenameLock: async (_atmuxDir) =>
      stubStep("step 1 — acquire rename.lock (stub — T3 wires real impl)"),
    mutateTeamJsonName: async (_atmuxDir, oldName, newName) =>
      stubStep(`step 2 — team.json:.name '${oldName}' → '${newName}' (stub — T3 wires real impl)`),
    renameMemberWindows: async (_tmux, _session, oldName, newName) =>
      stubStep(
        `step 4 — tmux rename-window __${oldName}__* → __${newName}__* (stub — T5 wires real impl)`,
      ),
    rewriteSessionTxt: async (_atmuxDir, newName) =>
      stubStep(`step 5 — state/session.txt = '${newName}' (stub — T3 wires real impl)`),
    updateCockpitRegistry: async (oldName, newName, newSession) =>
      stubStep(
        `step 7 — cockpit registry: deregister '${oldName}', upsert '${newName}' [session=${newSession}] (stub — T4 wires real impl)`,
      ),
    renameMemberBranches: async (_atmuxDir, oldName, newName, force) =>
      stubStep(
        `step 8 — per-member branch rename '${oldName}-*' → '${newName}-*' (force=${force}) (stub — T5 wires real impl)`,
      ),
    releaseRenameLock: async (_atmuxDir) => {
      /* no-op — T3 wires real impl */
    },
  };
}

/** Render the orchestration plan for `--dry-run`. Numbered 1-9 per the
 *  ADR-027 step renumbering (planner's T2-T5 split). */
export function renderRenamePlan(args: {
  oldName: string;
  newName: string;
  newSession: string;
  forceBranches: boolean;
}): ReadonlyArray<string> {
  const { oldName, newName, newSession, forceBranches } = args;
  return [
    `🪪 atmux team rename — plan for "${oldName}" → "${newName}" (session "${newSession}")`,
    "",
    "  1. acquire .atmux/state/rename.lock",
    `  2. team.json:.name = "${newName}"`,
    `  3. tmux rename-session "${oldName}" → "${newSession}"`,
    `  4. tmux rename-window __${oldName}__* → __${newName}__* (per pane)`,
    `  5. .atmux/state/session.txt = "${newSession}"`,
    `  6. cron-install --quiet (refresh block under '${newName}'; strips old marker)`,
    `  7. cockpit.json registry: deregister '${oldName}', upsert '${newName}' [session=${newSession}]`,
    `  8. per-member branch rename: '${oldName}-*' → '${newName}-*' (force=${forceBranches})`,
    "  9. release rename.lock",
    "",
  ];
}

/** Public verb entry — `atmux team rename <new-name> [...flags]`.
 *  Returns 0 on success / dry-run / no-op (oldName===newName).
 *  Refuse-gate failures throw `ConfigError`; orchestration failures
 *  return 1 after a best-effort rollback walk. */
export async function teamRename(
  argv: ReadonlyArray<string>,
  opts: TeamRenameDeps = {},
): Promise<number> {
  const parsed = parseTeamRenameArgs(argv);
  validateTeamName(parsed.newName);

  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const atmuxDir = await getAtmuxDir(dirOpts);
  const stdout = opts.stdout ?? defaultStdoutWrite;
  const stderr = opts.stderr ?? defaultStderrWrite;

  const teamObj = await loadTeam(dirOpts);
  const oldName = parsed.from ?? teamObj.name;
  const newSession = parsed.session ?? parsed.newName;

  // Idempotent no-op: identical name AND identical session.
  if (oldName === parsed.newName && newSession === oldName) {
    stdout(`team rename: '${oldName}' === '${parsed.newName}' — no-op\n`);
    return 0;
  }

  const loadCockpitFn = opts.loadCockpitFn ?? (() => loadCockpit() as Promise<Cockpit>);
  const loadTasksFn = opts.loadTasksFn ?? ((dir: string) => listTasks(dir));

  const [cockpit, tasks] = await Promise.all([loadCockpitFn(), loadTasksFn(atmuxDir)]);
  const gate = runRefuseGates({
    tasks,
    cockpit,
    newName: parsed.newName,
    force: parsed.force,
  });
  if (gate.refuse) {
    throw new ConfigError({ what: `team rename: ${gate.reason ?? "refused"}` });
  }

  if (parsed.dryRun) {
    for (const line of renderRenamePlan({
      oldName,
      newName: parsed.newName,
      newSession,
      forceBranches: parsed.forceBranches,
    })) {
      stdout(`${line}\n`);
    }
    stdout("team rename: --dry-run — no changes applied\n");
    return 0;
  }

  const stubs = defaultDeps();
  const deps = {
    acquireRenameLock: opts.acquireRenameLock ?? stubs.acquireRenameLock,
    mutateTeamJsonName: opts.mutateTeamJsonName ?? stubs.mutateTeamJsonName,
    renameMemberWindows: opts.renameMemberWindows ?? stubs.renameMemberWindows,
    rewriteSessionTxt: opts.rewriteSessionTxt ?? stubs.rewriteSessionTxt,
    updateCockpitRegistry: opts.updateCockpitRegistry ?? stubs.updateCockpitRegistry,
    renameMemberBranches: opts.renameMemberBranches ?? stubs.renameMemberBranches,
    releaseRenameLock: opts.releaseRenameLock ?? stubs.releaseRenameLock,
    buildTmuxAtSocket: opts.buildTmuxAtSocket,
    crontab: opts.crontab,
    cronInstallFn: opts.cronInstallFn,
  };
  const socketPath = parsed.socketPath ?? getDefaultSocket(oldName);
  let tmux: TmuxNamespace;
  if (deps.buildTmuxAtSocket !== undefined) {
    tmux = deps.buildTmuxAtSocket(socketPath);
  } else {
    const { createTmux } = await import("../abstractions/tmux.ts");
    tmux = createTmux({ socketPath });
  }
  const crontabIo = deps.crontab ?? (await import("../abstractions/crontab.ts")).defaultCrontabIO();
  const teamDir = dirname(atmuxDir);

  const rollback: RollbackStep[] = [];
  let exitCode = 0;

  try {
    rollback.push(await deps.acquireRenameLock(atmuxDir));
    rollback.push(await deps.mutateTeamJsonName(atmuxDir, oldName, parsed.newName));
    rollback.push(await renameTmuxSession({ tmux, oldSession: oldName, newSession }));
    rollback.push(await deps.renameMemberWindows(tmux, newSession, oldName, parsed.newName));
    rollback.push(await deps.rewriteSessionTxt(atmuxDir, newSession));

    const cronStepInput: ReinstallCronBlockInput = {
      teamDir,
      oldName,
      newName: parsed.newName,
      crontab: crontabIo,
    };
    if (deps.cronInstallFn !== undefined) cronStepInput.cronInstallFn = deps.cronInstallFn;
    rollback.push(await reinstallCronBlock(cronStepInput));

    rollback.push(await deps.updateCockpitRegistry(oldName, parsed.newName, newSession));
    rollback.push(
      await deps.renameMemberBranches(atmuxDir, oldName, parsed.newName, parsed.forceBranches),
    );

    stdout(
      `team rename: '${oldName}' → '${parsed.newName}' (session '${newSession}') — ${rollback.length} steps applied\n`,
    );
  } catch (err) {
    const failureReason = err instanceof Error ? err.message : String(err);
    const walk = await rollbackWalk(rollback);
    stderr(`team rename: failed at step ${rollback.length + 1}: ${failureReason}\n`);
    stderr(`team rename: rollback walked ${walk.walked} step(s)`);
    if (walk.failures.length > 0) {
      stderr(`, ${walk.failures.length} undo(s) failed:\n`);
      for (const f of walk.failures) {
        const fmsg = f.error instanceof Error ? f.error.message : String(f.error);
        stderr(`  - ${f.step.label}: ${fmsg}\n`);
      }
    } else {
      stderr("\n");
    }
    exitCode = 1;
  } finally {
    try {
      await deps.releaseRenameLock(atmuxDir);
    } catch (err) {
      const fmsg = err instanceof Error ? err.message : String(err);
      stderr(`team rename: warning — releaseRenameLock failed: ${fmsg}\n`);
    }
  }

  return exitCode;
}
