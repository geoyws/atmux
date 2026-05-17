// ADR-091 §State machine: epic-merge tick CLI verb.
//
// `atmux epic-merge tick [--team-dir <path>]` — one-shot cron entry-
// point that runs a single state-machine tick for the current
// epic-team. Composes the epic-team's kanban + git probes into the
// `EpicMergeContext` shape and dispatches `performEpicMerge`
// (`src/core/epic-merge.ts`).
//
// Designed to be invoked from cron (per-epic-team cron block emitted
// by `cron.ts` when `team.epicTeam !== undefined`). Bare invocation
// outside cron also works — the verb is idempotent on an unchanged
// state.db row + clean git tree.
//
// Sister verb to `atmux gitter --sweep` (ADR-134 T4 intra-team
// sweep). Both consume the same MergerStateRepo + branch-merge-state
// shared module; the epic-merge tick is single-row-per-invocation
// (one row per epic-team, since the epic-team has one shared branch
// per ADR-090 §Decision-anchor #3) where the gitter sweep iterates
// the whole team's per-member-branch fanout.
//
// Out of scope (v1): cross-epic batch ticks (one verb run per epic-
// team is the cron contract); pr-mode runtime (deferred per ADR-090
// §Decision-anchor #6 — verb still validates pr-mode configs and
// short-circuits at `ready_to_merge`); auto-dispatch of `dissolve-
// epic --auto` lands as a stderr log until T9 (`t-b430b185`) ships
// the verb.

import { join } from "node:path";
import { closeDatabase, type Database, openDatabase } from "../abstractions/sqlite.ts";
import { migrations } from "../abstractions/sqlite-migrations.ts";
import { defaultGitSpawn, type GitSpawn } from "../abstractions/worktree.ts";
import type { PreMergeGateInput } from "../core/branch-merge-state.ts";
import {
  BRANCH_MERGE_STATES,
  type BranchMergeState,
  canEnterMerging,
  isValidTransition,
} from "../core/branch-merge-state.ts";
import {
  getAtmuxDir,
  type ResolveDirOpts,
  requireTeam,
  resolveCallerScope,
} from "../core/common.ts";
import {
  type EpicMergeContext,
  type PerformEpicMergeResult,
  performEpicMerge,
} from "../core/epic-merge.ts";
import { expandCagePath, runCageTestGate } from "../core/epic-test-cage.ts";
import { composeStagingUrl, runDeployedTestGate } from "../core/epic-test-deploy.ts";
import { MergerStateRepo } from "../core/repositories/merger-state-repo.ts";
import { logTestGateBypass } from "../core/test-gate-bypass.ts";
import { createLogger, type Logger } from "../core/tui.ts";
import { UsageError } from "../errors.ts";
import { dissolveEpic } from "./team/dissolve-epic.ts";

const USAGE =
  "atmux epic-merge {tick | advance --to <state> [--skip-test-gate --reason <text>]} [--team-dir <path>]";

// ---------- Arg parsing ----------

export interface ParsedEpicMergeArgs {
  /** Sub-verb dispatch:
   *   - `tick` — cron-fired one-shot state-machine tick (v1, existing).
   *   - `advance` — operator manual transition with optional test-gate
   *     bypass per ADR-144 §Operator bypass (v1, ADR-144 T2 t-49bd4fe1).
   *   Future sub-verbs (e.g. `status` for read-only state-row
   *   inspection) would land here. */
  subverb: "tick" | "advance";
  /** Override the team-dir for `requireTeam` (test injection +
   *  cross-team operator invocation). */
  teamDir?: string;
  /** advance: target state literal (e.g. `"merging"`, `"in_progress"`).
   *  Validated against {@link BRANCH_MERGE_STATES} at parse time. */
  to?: BranchMergeState;
  /** advance: ADR-144 §Operator bypass flag — refuses the test-gate
   *  guard on `tested → merging` and writes `test_outcome="bypass"` to
   *  the row. Driver-scope only per ADR-033 — refused for member
   *  callers. Requires `--reason "<text>"`. */
  skipTestGate?: boolean;
  /** advance: caller-supplied reason for the transition. Required
   *  when `--skip-test-gate` is set (no silent bypasses); also
   *  recorded in `merger_state.note` for the regular path. */
  reason?: string;
}

/** Pure parser. Throws `UsageError` on bad invocation. */
export function parseEpicMergeArgs(argv: ReadonlyArray<string>): ParsedEpicMergeArgs {
  let subverb: "tick" | "advance" | undefined;
  let teamDir: string | undefined;
  let to: BranchMergeState | undefined;
  let skipTestGate = false;
  let reason: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "tick" || a === "--tick") {
      subverb = "tick";
      i += 1;
      continue;
    }
    if (a === "advance") {
      subverb = "advance";
      i += 1;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined || v === "") {
        throw new UsageError({
          what: "epic-merge: --team-dir requires a value",
          hint: USAGE,
        });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    if (a === "--to") {
      const v = argv[i + 1];
      if (v === undefined || v === "") {
        throw new UsageError({
          what: "epic-merge: --to requires a value",
          hint: USAGE,
        });
      }
      if (!(BRANCH_MERGE_STATES as readonly string[]).includes(v)) {
        throw new UsageError({
          what: `epic-merge: --to '${v}' is not a valid BranchMergeState (valid: ${BRANCH_MERGE_STATES.join(", ")})`,
          hint: USAGE,
        });
      }
      to = v as BranchMergeState;
      i += 2;
      continue;
    }
    if (a === "--skip-test-gate") {
      skipTestGate = true;
      i += 1;
      continue;
    }
    if (a === "--reason") {
      const v = argv[i + 1];
      if (v === undefined || v === "") {
        throw new UsageError({
          what: "epic-merge: --reason requires a value",
          hint: USAGE,
        });
      }
      reason = v;
      i += 2;
      continue;
    }
    if (a?.startsWith("-") === true) {
      throw new UsageError({
        what: `epic-merge: unknown flag: ${a}`,
        hint: USAGE,
      });
    }
    throw new UsageError({
      what: `epic-merge: unexpected arg: ${a}`,
      hint: USAGE,
    });
  }
  if (subverb === undefined) {
    throw new UsageError({
      what: "epic-merge: no sub-verb specified",
      hint: USAGE,
    });
  }
  if (subverb === "advance" && to === undefined) {
    throw new UsageError({
      what: "epic-merge advance: --to <state> required",
      hint: USAGE,
    });
  }
  if (subverb === "advance" && skipTestGate && (reason === undefined || reason.length === 0)) {
    throw new UsageError({
      what: "epic-merge advance: --skip-test-gate requires --reason <text> (ADR-144 §Operator bypass — bypasses must be auditable)",
      hint: USAGE,
    });
  }
  const out: ParsedEpicMergeArgs = { subverb };
  if (teamDir !== undefined) out.teamDir = teamDir;
  if (to !== undefined) out.to = to;
  if (skipTestGate) out.skipTestGate = true;
  if (reason !== undefined) out.reason = reason;
  return out;
}

// ---------- Verb dependencies (test injection) ----------

export interface EpicMergeOpts {
  logger?: Logger;
  git?: GitSpawn;
  openDb?: (path: string) => Database;
  closeDb?: (db: Database) => void;
  /** Test injection — override the gate-fact resolver. Production
   *  default reads kanban + runs git probes. Tests pin a fixed
   *  {@link PreMergeGateInput} + signoff bool to drive deterministic
   *  state-machine ticks. */
  resolveGate?: (deps: {
    db: Database;
    epicRepoPath: string;
    parentRepoPath: string;
    parentBase: string;
    git: GitSpawn;
  }) => Promise<{
    gate: PreMergeGateInput;
    hasReviewerTrunkSignoff: boolean;
  }>;
  /** Test injection — override the parent-repo path resolver. */
  resolveParentRepo?: (epicRepoPath: string) => string;
  /** Test injection — override `resolveCallerScope` for the
   *  `advance --skip-test-gate` driver-only gate (ADR-033). Production
   *  default reads `process.env.ATMUX_CALLER_SCOPE`. */
  callerScope?: () => "driver" | "member";
  /** Test injection — override `homeDir` for the bypass log path.
   *  Production default uses `os.homedir()`. */
  homeDir?: string;
  /** Test injection — override the bypass-log clock. */
  now?: () => number;
  /** Test injection — override `$USER` reader for `by` attribution. */
  user?: string;
}

// ---------- Top-level dispatch ----------

export async function epicMerge(
  argv: ReadonlyArray<string>,
  opts: EpicMergeOpts = {},
): Promise<number> {
  const parsed = parseEpicMergeArgs(argv);
  switch (parsed.subverb) {
    case "tick":
      return await epicMergeTickVerb(parsed, opts);
    case "advance":
      return await epicMergeAdvanceVerb(parsed, opts);
  }
}

// ---------- Tick sub-verb ----------

/** Run one state-machine tick for the current epic-team. Returns 0
 *  on success (including no-op ticks when the team isn't an epic-
 *  team or when the gate held). Non-zero only on hard errors
 *  (USAGE / config-load failures propagate via thrown errors per the
 *  standard verb contract). */
export async function epicMergeTickVerb(
  parsed: ParsedEpicMergeArgs,
  opts: EpicMergeOpts = {},
): Promise<number> {
  const logger = opts.logger ?? createLogger();
  const git = opts.git ?? defaultGitSpawn;
  const openDb = opts.openDb ?? ((p: string) => openDatabase(p, migrations));
  const closeDb = opts.closeDb ?? closeDatabase;
  const resolveGate = opts.resolveGate ?? defaultResolveGate;
  const resolveParentRepo = opts.resolveParentRepo ?? defaultResolveParentRepo;

  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const team = await requireTeam(dirOpts);
  const atmuxDir = await getAtmuxDir(dirOpts);

  // Honor the ADR-090 epic-team gate: bare invocation against a
  // normal team is a fast no-op + log + exit 0 (matches gitter
  // --sweep's `autoMerge.enabled !== true` posture).
  if (team.epicTeam === undefined) {
    logger.log(`epic-merge tick: team '${team.name}' has no epicTeam block — no-op`);
    return 0;
  }
  const epicTeam = team.epicTeam;

  // Derive the epic-team's root (cwd-of-team) + parent repo path.
  // ADR-090 §Decision-anchor #2 fixes the disk layout sibling
  // convention (`<projectRoot>-epics/<epicId>/`); resolveParentRepo
  // applies the inverse transform.
  const epicRepoPath = atmuxDir.endsWith("/.atmux")
    ? atmuxDir.slice(0, -"/.atmux".length)
    : join(atmuxDir, "..");
  const parentRepoPath = resolveParentRepo(epicRepoPath);

  // The epic-team's branch is `<parentBase>-epic-<epicId>` per
  // ADR-090 §Disk layout. We don't synthesize the name from
  // `<parentBase>-epic-<team.name>` because the spawn-epic verb
  // (T9 t-b430b185) is the canonical naming authority — it writes
  // the synthesized branch to the team's worktree at provision
  // time. For v1 (cron-tick BEFORE T9 lands), we read the worktree's
  // current branch via `git -C <epicRepoPath> rev-parse --abbrev-ref
  // HEAD`. Once T9 lands, an explicit `team.epicTeam.branch`
  // schema field would replace this probe — out of scope here.
  const epicBranch = await currentBranch(epicRepoPath, git);

  const db = openDb(join(atmuxDir, "state.db"));
  try {
    const repo = new MergerStateRepo(db);
    // Resolve gate facts from kanban + git.
    const { gate, hasReviewerTrunkSignoff } = await resolveGate({
      db,
      epicRepoPath,
      parentRepoPath,
      parentBase: epicTeam.parentBase,
      git,
    });
    // ADR-144 §Cage mode (T3 t-8cba0705): when the team configures
    // `testGateMode: "cage"`, wire the production cage runner hook.
    // The hook expands the cage tmpdir template, runs the test command
    // with `env -u TMUX TMUX_TMPDIR=<cage>` per [[feedback_pause_bun_tests]],
    // retries on flake per `retryOnFlake`, and returns the outcome.
    // T4 wires the deployed-mode runner in a sibling closure.
    const testGateMode = epicTeam.testGateMode ?? "skip";
    const ctx: EpicMergeContext = {
      epicBranch,
      parentBase: epicTeam.parentBase,
      parentRepoPath,
      gate,
      hasReviewerTrunkSignoff,
      mergeMode: epicTeam.mergeMode,
      epicId: epicTeam.parentEpicKanbanId,
      repo,
      git,
      by: "epic-cron",
      // ADR-090↔ADR-091 wire-up (t-9a8b0e4e): on `merging → merged`
      // success, invoke the dissolve-epic verb directly. The cron-fired
      // auto-merger IS the legitimate dispatcher per ADR-091 state
      // machine, so `callerScope: "driver"` is injected at the call-
      // site rather than relying on the cron's ATMUX_CALLER_SCOPE env.
      // Production default per t-9a8b0e4e Task body — operator can
      // still dissolve manually if this fails (the merger_state.note
      // carries the merge SHA + epicId for traceability).
      dispatchDissolve: defaultDispatchDissolve,
      testGateMode,
    };
    if (testGateMode === "cage" && epicTeam.cageTmpdir !== null) {
      const cageTmpdir = epicTeam.cageTmpdir;
      const testCommand = epicTeam.testCommand;
      const retryOnFlake = epicTeam.retryOnFlake;
      const testTimeoutMin = epicTeam.testTimeoutMin;
      ctx.testGate = async () => {
        const cagePath = expandCagePath(cageTmpdir, team.name, epicTeam.parentEpicKanbanId);
        const result = await runCageTestGate({
          cagePath,
          testCommand,
          cwd: epicRepoPath,
          timeoutMs: testTimeoutMin * 60_000,
          retryOnFlake,
        });
        const passSpec = result.outcome === "pass" ? "passed" : "failed";
        const note = `cage tests ${passSpec} (attempts=${result.attempts}, exit=${result.last.exitCode}, durationMs=${result.totalDurationMs})`;
        return { outcome: result.outcome, note };
      };
    }
    // ADR-144 §Deployed mode (T4 t-66a237cd): sibling of the cage
    // branch above. When `testGateMode: "deployed"`, compose the
    // branch-staging URL from `stagingUrlTemplate` + the epic-team's
    // identity (product = parentBase before first `-`, devSuffix =
    // parentBase after last `-`, epicName = parentEpicKanbanId without
    // the `e-` prefix) and run the test command against
    // `E2E_BASE_URL=https://<composed-url>`. Deploy + teardown
    // lifecycle hooks fire at spawn-epic / dissolve-epic respectively
    // (per ADR-144 §Mode-A-deployed lifecycle) — out of scope for the
    // per-merge test-gate, which assumes the URL is already serving.
    // Schema-level superRefine on `TeamEpic` guarantees
    // `stagingUrlTemplate !== null` when `testGateMode === "deployed"`,
    // so the null check below is a runtime defense for the type
    // narrower rather than an operator-recoverable path.
    if (testGateMode === "deployed" && epicTeam.stagingUrlTemplate !== null) {
      const stagingUrlTemplate = epicTeam.stagingUrlTemplate;
      const testCommand = epicTeam.testCommand;
      const retryOnFlake = epicTeam.retryOnFlake;
      const testTimeoutMin = epicTeam.testTimeoutMin;
      const parentBase = epicTeam.parentBase;
      const epicKanbanId = epicTeam.parentEpicKanbanId;
      ctx.testGate = async () => {
        const dashIdx = parentBase.indexOf("-");
        const product = dashIdx >= 0 ? parentBase.slice(0, dashIdx) : parentBase;
        const lastDash = parentBase.lastIndexOf("-");
        const devSuffix = lastDash >= 0 ? parentBase.slice(lastDash + 1) : parentBase;
        const epicName = epicKanbanId.startsWith("e-") ? epicKanbanId.slice(2) : epicKanbanId;
        const host = composeStagingUrl(stagingUrlTemplate, { product, devSuffix, epicName });
        const baseUrl = host.startsWith("http://") || host.startsWith("https://")
          ? host
          : `https://${host}`;
        const result = await runDeployedTestGate({
          baseUrl,
          testCommand,
          cwd: epicRepoPath,
          timeoutMs: testTimeoutMin * 60_000,
          retryOnFlake,
        });
        const passSpec = result.outcome === "pass" ? "passed" : "failed";
        const note = `deployed tests ${passSpec} on ${result.baseUrl} (attempts=${result.attempts}, exit=${result.last.exitCode}, durationMs=${result.totalDurationMs})`;
        return { outcome: result.outcome, note };
      };
    }
    const result = await performEpicMerge(ctx);
    logTickResult(result, logger, team.name, epicTeam.parentBase);
    return 0;
  } finally {
    closeDb(db);
  }
}

// ---------- Advance sub-verb (ADR-144 §Operator bypass) ----------

/**
 * Operator-driven manual transition for the epic-team's `merger_state`
 * row. Covers two flows per ADR-144 §Decision T2:
 *
 *   1. **Recovery transitions** (`--to in-progress` from `test_failed`
 *      or `conflict`): no test-gate involvement. Just validates the
 *      transition + writes the new state.
 *   2. **Bypass transition** (`--to merging --skip-test-gate --reason
 *      "<text>"`): ADR-033 driver-scope gate. Writes
 *      `test_outcome="bypass"` to the row + appends a record to
 *      `~/.atmux/state/test-gate-bypasses.log`. T5 wires the Discord
 *      `[test-gate-bypass]` template on top of the log tail.
 *
 * Refusals:
 *   - Caller scope is not `driver` AND `--skip-test-gate` is set →
 *     ADR-033 refuse. Member panes can't bypass the test-gate even
 *     for an emergency.
 *   - Transition is not valid per {@link isValidTransition} →
 *     usage error with the current state + reachable next states.
 *   - Transition would land in `merging` from `tested` AND the row's
 *     `test_outcome` is not `"pass"` or `"bypass"` AND
 *     `--skip-test-gate` was NOT passed → refuse. Caller must either
 *     wait for the test to record PASS or pass `--skip-test-gate
 *     --reason "<text>"`.
 */
export async function epicMergeAdvanceVerb(
  parsed: ParsedEpicMergeArgs,
  opts: EpicMergeOpts = {},
): Promise<number> {
  if (parsed.to === undefined) {
    throw new UsageError({
      what: "epic-merge advance: --to <state> required",
      hint: USAGE,
    });
  }
  const target = parsed.to;
  const logger = opts.logger ?? createLogger();
  const git = opts.git ?? defaultGitSpawn;
  const openDb = opts.openDb ?? ((p: string) => openDatabase(p, migrations));
  const closeDb = opts.closeDb ?? closeDatabase;
  const callerScope = opts.callerScope ?? (() => resolveCallerScope());
  const nowMs = opts.now ?? Date.now;

  // ADR-033 driver-scope gate — only refuses when --skip-test-gate is
  // set. Plain recovery transitions (e.g. `--to in-progress` from
  // `test_failed`) can be fired by member panes (planner-near, etc.)
  // because they don't bypass any safety check; they just consume
  // a manual-recovery edge already permitted by isValidTransition.
  if (parsed.skipTestGate === true && callerScope() !== "driver") {
    throw new UsageError({
      what: "epic-merge advance --skip-test-gate: refused — caller scope is not 'driver' (ADR-033 §Caller-scope gate).",
      hint: 'from a driver pane: ATMUX_CALLER_SCOPE=driver atmux epic-merge advance --to merging --skip-test-gate --reason "<text>"',
    });
  }

  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const team = await requireTeam(dirOpts);
  const atmuxDir = await getAtmuxDir(dirOpts);

  if (team.epicTeam === undefined) {
    throw new UsageError({
      what: `epic-merge advance: team '${team.name}' has no epicTeam block — sub-verb scoped to epic-teams only`,
      hint: USAGE,
    });
  }

  // Derive epic-team's branch via the same probe as `tick`.
  const epicRepoPath = atmuxDir.endsWith("/.atmux")
    ? atmuxDir.slice(0, -"/.atmux".length)
    : join(atmuxDir, "..");
  const epicBranch = await currentBranch(epicRepoPath, git);

  const db = openDb(join(atmuxDir, "state.db"));
  try {
    const repo = new MergerStateRepo(db);
    const row = repo.getState(epicBranch);
    const currentState: BranchMergeState = row?.state ?? "open";

    // Validate the transition shape per {@link isValidTransition}
    // (handles the operator-driven manual resets from terminals).
    if (!isValidTransition(currentState, target)) {
      throw new UsageError({
        what: `epic-merge advance: illegal transition '${currentState}' → '${target}'`,
        hint: `current state '${currentState}' — see docs/adr/091-kanban-driven-auto-merge.md §State machine for the legal graph`,
      });
    }

    // ADR-144 §Decision test-gate check: refuse `tested → merging`
    // unless prior outcome is PASS or --skip-test-gate is passed.
    const testOutcome = row?.testOutcome ?? null;
    if (!canEnterMerging(currentState, target, testOutcome) && parsed.skipTestGate !== true) {
      throw new UsageError({
        what: `epic-merge advance: refused 'tested → merging' — test_outcome on row is '${testOutcome ?? "null"}', not 'pass' (ADR-144 §Decision test-gate)`,
        hint: 'to bypass: --skip-test-gate --reason "<text>" (driver-only ADR-033 — logged to ~/.atmux/state/test-gate-bypasses.log)',
      });
    }

    // Compose the transition.
    const t = Math.floor(nowMs() / 1000);
    const by = opts.user ?? process.env.USER ?? "operator";
    const reasonText =
      parsed.reason ??
      (parsed.skipTestGate === true ? "operator bypass" : `operator advance --to ${target}`);
    const transition: Parameters<MergerStateRepo["transition"]>[0] = {
      memberBranch: epicBranch,
      next: target,
      note: reasonText,
      by,
      transitionedAt: t,
    };
    if (parsed.skipTestGate === true) {
      transition.testOutcome = "bypass";
    } else if (target === "in_progress") {
      // Recovery from test_failed / conflict — clear stale outcome so
      // the next test cycle starts clean.
      transition.testOutcome = null;
    } else if (testOutcome !== null) {
      // Preserve the prior outcome across non-test transitions (e.g.
      // tested → merging with PASS should keep the PASS record on the
      // row for audit trail).
      transition.testOutcome = testOutcome;
    }
    repo.transition(transition);

    // ADR-144 §Operator bypass: durable audit log + Discord surface
    // (T5 reads this log via tail-N).
    if (parsed.skipTestGate === true) {
      await logTestGateBypass(
        {
          epicId: team.epicTeam.parentEpicKanbanId,
          epicBranch,
          targetState: target,
          reason: reasonText,
          by,
        },
        {
          ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
          now: nowMs,
        },
      );
      logger.log(
        `epic-merge advance: bypass written — ${epicBranch} '${currentState}' → '${target}' by=${by} reason='${reasonText}'`,
      );
    } else {
      logger.log(
        `epic-merge advance: ${epicBranch} '${currentState}' → '${target}' by=${by} reason='${reasonText}'`,
      );
    }
    return 0;
  } finally {
    closeDb(db);
  }
}

// ---------- Default gate resolver ----------

/** Production default — pulls gate facts from the epic-team's kanban
 *  (via the open Database handle) + per-branch git probes. The
 *  signature mirrors {@link EpicMergeOpts.resolveGate} so test
 *  injections drop in cleanly. */
async function defaultResolveGate(deps: {
  db: Database;
  epicRepoPath: string;
  parentRepoPath: string;
  parentBase: string;
  git: GitSpawn;
}): Promise<{
  gate: PreMergeGateInput;
  hasReviewerTrunkSignoff: boolean;
}> {
  // 1. ownerOpenTaskCount — count Tasks NOT in `done` state. The
  // epic-team's kanban lives at `<epicRepoPath>/.atmux/state.db` —
  // the same DB handle the verb opened above (caller passed it in).
  const openTasksRow = deps.db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM tasks WHERE status NOT IN ('done', 'wontfix')`,
    )
    .get();
  const ownerOpenTaskCount = openTasksRow?.n ?? 0;

  // 2. hasReviewerTrunkSignoff — is there a done Task with
  // role='reviewer-trunk-signoff'? §Decision-anchor #1 + #5.
  const signoffRow = deps.db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM tasks
       WHERE status = 'done' AND role = 'reviewer-trunk-signoff'`,
    )
    .get();
  const hasReviewerTrunkSignoff = (signoffRow?.n ?? 0) > 0;

  // 3. worktreeIsClean — `git -C parentRepoPath status --porcelain`
  // empty? Run on PARENT's worktree because that's where the merge
  // lands; an unclean parent would refuse the merge regardless of
  // the epic-team's own cleanliness. GitSpawn is cwd-less; use
  // `-C <path>` argv form to scope.
  const cleanResult = await deps.git(["-C", deps.parentRepoPath, "status", "--porcelain"]);
  const worktreeIsClean = cleanResult.exitCode === 0 && cleanResult.stdout.trim() === "";

  // 4. isAheadOfBase — does the epic-team's worktree have commits
  // not yet on parentBase? Run on epic-team's worktree (where the
  // epic-team's branch HEAD lives).
  const aheadResult = await deps.git([
    "-C",
    deps.epicRepoPath,
    "rev-list",
    "--count",
    `${deps.parentBase}..HEAD`,
  ]);
  const aheadCount = parseInt(aheadResult.stdout.trim(), 10);
  const isAheadOfBase = aheadResult.exitCode === 0 && Number.isFinite(aheadCount) && aheadCount > 0;

  // 5. baseHasMoved — has parentBase advanced past the merge-base?
  // `git merge-base parentBase HEAD` returns the divergence point;
  // if that's NOT the same as parentBase's tip, parentBase moved.
  const mbResult = await deps.git(["-C", deps.epicRepoPath, "merge-base", deps.parentBase, "HEAD"]);
  const baseTipResult = await deps.git(["-C", deps.epicRepoPath, "rev-parse", deps.parentBase]);
  const mbSha = mbResult.stdout.trim();
  const baseTipSha = baseTipResult.stdout.trim();
  const baseHasMoved =
    mbResult.exitCode === 0 &&
    baseTipResult.exitCode === 0 &&
    mbSha.length > 0 &&
    baseTipSha.length > 0 &&
    mbSha !== baseTipSha;

  return {
    gate: {
      ownerOpenTaskCount,
      worktreeIsClean,
      isAheadOfBase,
      baseHasMoved,
    },
    hasReviewerTrunkSignoff,
  };
}

// ---------- Default parent-repo resolver ----------

/** Production default — derives parent's repo path from the epic-
 *  team's repo path via the ADR-090 §Decision-anchor #2 sibling
 *  layout convention: `<projectRoot>-epics/<epicId>/` ⇒ parent at
 *  `<projectRoot>`. Throws if the path doesn't match the layout
 *  (operator's `team.json` has gone non-canonical or the verb is
 *  invoked outside an epic-team's worktree).
 *
 *  Example: `/root/work/ifca/src/sopx-epics/checkout-flow` ⇒
 *           `/root/work/ifca/src/sopx`. */
function defaultResolveParentRepo(epicRepoPath: string): string {
  // Strip trailing slash for stable basename math.
  const trimmed = epicRepoPath.replace(/\/$/, "");
  // Two levels up: epicRepoPath → epicsDir → grandparent.
  const lastSlash = trimmed.lastIndexOf("/");
  if (lastSlash <= 0) {
    throw new Error(
      `epic-merge: cannot derive parent repo from epicRepoPath '${epicRepoPath}' — path too shallow`,
    );
  }
  const epicsDir = trimmed.slice(0, lastSlash);
  const epicsDirSlash = epicsDir.lastIndexOf("/");
  if (epicsDirSlash < 0) {
    throw new Error(
      `epic-merge: cannot derive parent repo from epicRepoPath '${epicRepoPath}' — epicsDir has no parent`,
    );
  }
  const epicsBasename = epicsDir.slice(epicsDirSlash + 1);
  if (!epicsBasename.endsWith("-epics")) {
    throw new Error(
      `epic-merge: epicRepoPath '${epicRepoPath}' parent dir '${epicsBasename}' does not end with '-epics' (ADR-090 §Decision-anchor #2 violation)`,
    );
  }
  const parentBasename = epicsBasename.slice(0, -"-epics".length);
  const grandparent = epicsDir.slice(0, epicsDirSlash);
  return `${grandparent}/${parentBasename}`;
}

// ---------- Default current-branch resolver ----------

async function currentBranch(repoPath: string, git: GitSpawn): Promise<string> {
  const r = await git(["-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (r.exitCode !== 0) {
    throw new Error(
      `epic-merge: failed to read HEAD branch at ${repoPath} (exit ${r.exitCode}): ${r.stderr.trim()}`,
    );
  }
  return r.stdout.trim();
}

// ---------- ADR-090↔ADR-091 dispatch hook (t-9a8b0e4e) ----------

/** Production default for {@link EpicMergeContext.dispatchDissolve}.
 *  Invokes the dissolve-epic verb directly with `callerScope: "driver"`
 *  injected — the cron-fired auto-merger IS the legitimate dispatcher
 *  per ADR-091's state machine, so the ATMUX_CALLER_SCOPE env is
 *  bypassed at the call-site.
 *
 *  Wraps the call in try/catch so any throw from dissolveEpic (caller-
 *  scope refusal, missing cockpit entry, dirty-worktree refuse) returns
 *  `false` rather than propagating — the merge ALREADY succeeded; the
 *  dissolve gap is operator-recoverable. The error reason is surfaced
 *  via stderr (cron log capture) by {@link tryDispatchDissolve}'s
 *  catch block, so the failure stays visible without aborting the
 *  cron tick. */
async function defaultDispatchDissolve(epicId: string, by: string): Promise<boolean> {
  const rc = await dissolveEpic([epicId], {
    callerScope: () => "driver",
    // Default logger writes to process.stderr — fits the cron log
    // capture path. The verb's success log ("epic-team dissolved: …")
    // joins the same stream as the tick result line.
    logger: {
      log: (m: string) => process.stderr.write(`${m}\n`),
      warn: (m: string) => process.stderr.write(`epic-merge[${by}] dissolve-epic warn: ${m}\n`),
    },
  });
  return rc === 0;
}

// ---------- Result logging ----------

function logTickResult(
  result: PerformEpicMergeResult,
  logger: Logger,
  teamName: string,
  parentBase: string,
): void {
  const verdict = result.changed ? "advanced" : "no-op";
  const sha = result.mergedSha !== undefined ? ` sha=${result.mergedSha}` : "";
  const dispatched = result.dissolveDispatched ? " dissolve-dispatched" : "";
  logger.log(
    `epic-merge tick: team='${teamName}' parentBase='${parentBase}' state='${result.state}' ${verdict}${sha}${dispatched} reason='${result.reason}'`,
  );
}
