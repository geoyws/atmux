// ADR-090 §`spawn-epic` verb (t-b430b185).
//
// `atmux team spawn-epic <epicId> --from <parentTeam>
//   [--roster <preset> | --roster-file <path>]
//   [--parent-base <branch>] [--parent-epic-kanban-id <eid>]
//   [--no-init-submodules]`
//
// Creates an epic-team child of `<parentTeam>`. The child is an
// ephemeral, shared-worktree team that lives at the sibling path
// `<parentRoot>-epics/<epicId>/` per ADR-090 §Decision-anchor #2
// disk layout. Members share one worktree (HARD CONFLICT carve-out
// vs ADR-084 per §Decision-anchor #3 — structurally enforced by
// the Team schema's superRefine).
//
// Pipeline (single-commit, single-verb):
//
//   1. Resolve caller-scope. Refuses if not driver (ADR-033 caller-
//      scope gate per Task pre-flag #3).
//   2. Resolve parent via cockpit walk. Refuses if parent team not
//      registered in `~/.atmux/cockpit.json::sessions[]`.
//   3. Compute paths: epicRoot = `<parentRoot>-epics/<epicId>`;
//      branch = `<parentBase>-epic-<epicIdNoPrefix>` (post-2026-05-26
//      double-e fix: epicId's leading `e-` stripped before
//      interpolation to avoid `epic-e-` redundancy); cage tmpdir =
//      `/tmp/atmux-<parentTeam>/epics/<epicId>` (ADR-089 §Pillar 1).
//   4. Resolve roster: --roster-file > --roster > default. Mutually
//      exclusive (per ADR-090 §Decision-anchor #4) — refuse if both
//      set.
//   5. provisionWorktree(parentRoot, parentBase, branch, epicRoot,
//      {initSubmodules: true}) — reuses ADR-082/088 primitive
//      verbatim. Side-effect rollback on subsequent failures uses
//      pruneWorktree under the same Provision result handle.
//   6. Synthesize child Team object (roster members + name + tmpdir
//      + epicTeam block) and write `<epicRoot>/.atmux/team.json`.
//      Validate via Team schema BEFORE write — cross-field refusals
//      from superRefine surface as the verb's failure (refuses pre-
//      worktree-cleanup so any partial roster lands without epic-
//      team state.db pollution).
//   7. Initialize child state.db via openDatabase + migrations.
//   8. Register child in parent's cockpit sessions[] (raw read +
//      mutate + write back; loadCockpit's enriched legacy fields
//      would round-trip lossy).
//   9. Log "next: atmux cockpit rebuild" — child cage spawn is the
//      operator's manual step in v1 (matches the existing cockpit
//      verb pattern; auto-spawn lands as a follow-up Task).
//
// Rollback semantics (per Task pre-flag #1, transactional boundary):
// failures in steps 6-8 attempt to undo the worktree (pruneWorktree
// in `--force` mode is acceptable because we authored the worktree
// in step 5 — operator never touched it). Step 9 failure is logged
// + does NOT rollback (the registry append is the LAST mutation;
// the verb exits non-zero with the partial state visible).
//
// Out of scope: child cage start (operator runs cockpit rebuild);
// gh fail-fast assertions for pr-mode (§Decision-anchor #10 — pr-
// mode runtime is deferred per §Decision-anchor #6; the schema
// refuses pr-mode without prTarget.base + prAuthorUser, which
// catches the misconfiguration at schema layer instead).

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { exists, writeText } from "../../abstractions/fs.ts";
import { readJson } from "../../abstractions/json.ts";
import { closeDatabase, type Database, openDatabase } from "../../abstractions/sqlite.ts";
import { migrations } from "../../abstractions/sqlite-migrations.ts";
import {
  defaultGitSpawn,
  type GitSpawn,
  provisionWorktree,
  pruneWorktree,
} from "../../abstractions/worktree.ts";
import { type BudgetProbeState, loadBudgetMap, selectAccount } from "../../core/account-pool.ts";
import { defaultCockpitConfigPath, migrateLegacyShape } from "../../core/cockpit.ts";
import { resolveCallerScope } from "../../core/common.ts";
import { epicIsEligible } from "../../core/epic.ts";
import {
  formatPressureError,
  type HostPressureVerdict,
  type ProbeHostPressureDeps,
  probeHostPressure,
} from "../../core/host-pressure.ts";
import {
  logSpawnOverride as defaultLogSpawnOverride,
  type LogSpawnOverrideOpts,
  type SpawnForceDiscordFn,
  type SpawnOverrideRecord,
} from "../../core/spawn-override.ts";
import { enqueueIfPressured, resolveSpawnQueueLimits } from "../../core/spawn-queue.ts";
import { ConfigError, UsageError } from "../../errors.ts";
import type { ClaudeAccountPoolEntry } from "../../schema/cockpit.ts";
import { Team, type Team as TeamShape } from "../../schema/team.ts";

const USAGE =
  "atmux team spawn-epic <epicId> --from <parentTeam>\n" +
  "  [--roster <preset> | --roster-file <path>]\n" +
  "  [--parent-base <branch>] [--parent-epic-kanban-id <eid>]\n" +
  "  [--merge-mode auto|pr] [--no-init-submodules]\n" +
  "  [--no-auto-dissolve]  (per ADR-227 §D3 — keeps cage post-merge for inspection)\n" +
  "  [--force-spawn]   (bypass host-pressure gate — use sparingly)\n" +
  "  [--no-queue]      (ADR-228 §D1 — refuse-immediately on pressure instead of enqueue)\n" +
  "  [--force]         (bypass ADR-225 eligibility gate — logged + Discord)";

// ---------- Arg parsing ----------

export interface ParsedSpawnEpicArgs {
  epicId: string;
  parentTeam: string;
  roster?: string;
  rosterFile?: string;
  parentBase?: string;
  parentEpicKanbanId?: string;
  mergeMode?: "auto" | "pr";
  initSubmodules: boolean;
  /** `--no-auto-dissolve` — per ADR-227 §D3: keep the epic-team's cage
   *  alive post-merge so operators can grep `.atmux/logs/` or run post-
   *  mortems. Persists to `team.json::epicTeam.autoDissolve = false`;
   *  default is `true` (auto-dissolve on `epic.pushed`). */
  autoDissolve: boolean;
  /** `--force-spawn` — bypass the host-pressure gate. ADR-184 substrate.
   *  Use sparingly: the gate exists to prevent fleet thrash + OOM. */
  forceSpawn: boolean;
  /** `--no-queue` — ADR-228 §D1: refuse-immediately on host-pressure
   *  instead of enqueue. Default is queue-on-pressure (ADR-228 §DA3
   *  HIGH-REV decision). Operator-side escape hatch for one-shot
   *  scripts that need synchronous-failure semantics. */
  noQueue: boolean;
  /** `--force` — bypass the ADR-225 eligibility gate (is_ready + deps-
   *  done). Logged to `~/.atmux/state/spawn-overrides.log` + emits
   *  `[spawn-force]` Discord. Use sparingly — exists for operator
   *  emergencies where the predicate is wrong (e.g. dep recovery
   *  state is stale). Separate from `--force-spawn` (host pressure)
   *  so an operator who wants one isn't forced to take the other. */
  forceEligibility: boolean;
}

export function parseSpawnEpicArgs(argv: ReadonlyArray<string>): ParsedSpawnEpicArgs {
  let epicId: string | undefined;
  let parentTeam: string | undefined;
  let roster: string | undefined;
  let rosterFile: string | undefined;
  let parentBase: string | undefined;
  let parentEpicKanbanId: string | undefined;
  let mergeMode: "auto" | "pr" | undefined;
  let initSubmodules = true;
  let autoDissolve = true;
  let forceSpawn = false;
  let noQueue = false;
  let forceEligibility = false;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--from") {
      parentTeam = requireValue(argv, i, "--from");
      i += 2;
      continue;
    }
    if (a === "--roster") {
      roster = requireValue(argv, i, "--roster");
      i += 2;
      continue;
    }
    if (a === "--roster-file") {
      rosterFile = requireValue(argv, i, "--roster-file");
      i += 2;
      continue;
    }
    if (a === "--parent-base") {
      parentBase = requireValue(argv, i, "--parent-base");
      i += 2;
      continue;
    }
    if (a === "--parent-epic-kanban-id") {
      parentEpicKanbanId = requireValue(argv, i, "--parent-epic-kanban-id");
      i += 2;
      continue;
    }
    if (a === "--merge-mode") {
      const v = requireValue(argv, i, "--merge-mode");
      if (v !== "auto" && v !== "pr") {
        throw new UsageError({
          what: `spawn-epic: --merge-mode must be 'auto' or 'pr' (got: ${v})`,
          hint: USAGE,
        });
      }
      mergeMode = v;
      i += 2;
      continue;
    }
    if (a === "--no-init-submodules") {
      initSubmodules = false;
      i += 1;
      continue;
    }
    if (a === "--no-auto-dissolve") {
      autoDissolve = false;
      i += 1;
      continue;
    }
    if (a === "--force-spawn") {
      forceSpawn = true;
      i += 1;
      continue;
    }
    if (a === "--no-queue") {
      noQueue = true;
      i += 1;
      continue;
    }
    if (a === "--force") {
      forceEligibility = true;
      i += 1;
      continue;
    }
    if (a?.startsWith("-") === true) {
      throw new UsageError({
        what: `spawn-epic: unknown flag: ${a}`,
        hint: USAGE,
      });
    }
    if (epicId === undefined) {
      epicId = a;
      i += 1;
      continue;
    }
    throw new UsageError({
      what: `spawn-epic: unexpected positional: ${a}`,
      hint: USAGE,
    });
  }
  if (epicId === undefined || epicId.length === 0) {
    throw new UsageError({
      what: "spawn-epic: <epicId> required",
      hint: USAGE,
    });
  }
  if (parentTeam === undefined || parentTeam.length === 0) {
    throw new UsageError({
      what: "spawn-epic: --from <parentTeam> required",
      hint: USAGE,
    });
  }
  // ADR-090 §Decision-anchor #4: --roster and --roster-file are
  // mutually exclusive. Refuse early so the operator sees the
  // misconfig before any disk mutation.
  if (roster !== undefined && rosterFile !== undefined) {
    throw new UsageError({
      what: "spawn-epic: --roster and --roster-file are mutually exclusive (ADR-090 §Decision-anchor #4)",
      hint: USAGE,
    });
  }
  const out: ParsedSpawnEpicArgs = {
    epicId,
    parentTeam,
    initSubmodules,
    autoDissolve,
    forceSpawn,
    noQueue,
    forceEligibility,
  };
  if (roster !== undefined) out.roster = roster;
  if (rosterFile !== undefined) out.rosterFile = rosterFile;
  if (parentBase !== undefined) out.parentBase = parentBase;
  if (parentEpicKanbanId !== undefined) out.parentEpicKanbanId = parentEpicKanbanId;
  if (mergeMode !== undefined) out.mergeMode = mergeMode;
  return out;
}

function requireValue(argv: ReadonlyArray<string>, i: number, flag: string): string {
  const v = argv[i + 1];
  if (v === undefined || v === "") {
    throw new UsageError({
      what: `spawn-epic: ${flag} requires a value`,
      hint: USAGE,
    });
  }
  return v;
}

// ---------- Verb dependencies (test injection) ----------

export interface SpawnEpicOpts {
  git?: GitSpawn;
  logger?: { log: (m: string) => void; warn: (m: string) => void };
  openDb?: (path: string) => Database;
  closeDb?: (db: Database) => void;
  /** Override the templates dir for roster resolution. Production
   *  default reads `<atmuxRepoRoot>/templates/epic-rosters/`; tests
   *  inject a scratch dir with a synthetic roster. */
  templatesDir?: string;
  /** Override cockpit config path (test injection). Defaults to
   *  `defaultCockpitConfigPath(home)` per ADR-089. */
  cockpitPath?: string;
  /** Override caller scope (test injection). Defaults to
   *  `resolveCallerScope()`. */
  callerScope?: () => "driver" | "member";
  /** Override `process.env` (test injection — for $HOME resolution). */
  env?: NodeJS.ProcessEnv;
  /** Host-pressure probe injection (test seam). Production default reads
   *  /proc/loadavg + /proc/meminfo + /proc/cpuinfo. ADR-184 substrate. */
  probeHostPressure?: (deps: ProbeHostPressureDeps) => Promise<HostPressureVerdict>;
  /** ADR-225 §Eligibility — predicate injection seam. Defaults to the
   *  live `epicIsEligible` from core/epic. Test harness mocks to assert
   *  the gate logic in isolation. */
  eligibilityProbe?: (
    atmuxDir: string,
    eid: string,
  ) => Promise<{
    eligible: boolean;
    blockers: string[];
  }>;
  /** ADR-225 §Eligibility consumers — Discord `[spawn-force]` ping
   *  emitter (test injection). Default is a noop; the production
   *  cockpit wires this to the Discord publisher used by ADR-144 §T5
   *  test-gate-bypass. */
  sendSpawnForceDiscord?: SpawnForceDiscordFn;
  /** ADR-225 §Eligibility consumers — override log injection seam.
   *  Default writes to `$HOME/.atmux/state/spawn-overrides.log` via
   *  {@link logSpawnOverride}. Tests pin to a scratch homeDir. */
  logSpawnOverride?: (record: SpawnOverrideRecord, opts?: LogSpawnOverrideOpts) => Promise<void>;
  /** ADR-225 §Eligibility consumers — override log opts (homeDir / now)
   *  forwarded to the default logger. Tests pin homeDir to scratch. */
  logSpawnOverrideOpts?: LogSpawnOverrideOpts;
}

// ---------- Top-level dispatch ----------

/** Bare-minimal raw cockpit shape needed for the sessions[] mutation —
 *  passthrough on every other field so unrelated keys round-trip. */
const RawCockpitForMutation = z
  .object({
    sessions: z.array(z.unknown()).optional(),
  })
  .passthrough();

interface SessionEntry {
  type?: string;
  name?: string;
  root?: string;
  enabled?: boolean;
  sessions?: SessionEntry[];
  parent?: string;
  epicId?: string;
}

export async function spawnEpic(
  argv: ReadonlyArray<string>,
  opts: SpawnEpicOpts = {},
): Promise<number> {
  const parsed = parseSpawnEpicArgs(argv);
  const logger = opts.logger ?? {
    log: (m: string) => process.stderr.write(`${m}\n`),
    warn: (m: string) => process.stderr.write(`WARN: ${m}\n`),
  };
  const git = opts.git ?? defaultGitSpawn;
  const env = opts.env ?? process.env;
  const callerScope = opts.callerScope ?? (() => resolveCallerScope({ env }));
  const openDb = opts.openDb ?? ((p: string) => openDatabase(p, migrations));
  const closeDb = opts.closeDb ?? closeDatabase;
  const home = env.HOME ?? "/root";
  const cockpitPath = opts.cockpitPath ?? defaultCockpitConfigPath(home);

  // 1. Caller-scope gate. ADR-033 fail-secure: members can't spawn
  //    epic-teams — they'd race with the parent lead's coordination.
  if (callerScope() !== "driver") {
    throw new ConfigError({
      what: "spawn-epic: refused — caller scope is not 'driver'. Set ATMUX_CALLER_SCOPE=driver in the calling shell (ADR-033 §Caller-scope gate).",
      hint: "from a driver pane: ATMUX_CALLER_SCOPE=driver atmux team spawn-epic ...",
    });
  }

  // 1.5. Host-pressure gate. ADR-184 substrate — refuse spawn when the
  //      host is over load OR RAM threshold. The full ADR-184 EPIC adds
  //      a queue + dormancy audit; this thin gate is the prerequisite
  //      defense-in-depth that prevents fleet thrash + OOM.
  //
  //      Configurable via ATMUX_SPAWN_MAX_LOAD_RATIO (default 0.75) +
  //      ATMUX_SPAWN_MIN_FREE_MB (default 8192). Bypass with
  //      --force-spawn (operator escape hatch, e.g. when you KNOW the
  //      load avg will drop after spawn because workers will idle).
  //      Non-Linux platforms skip the gate (probe returns {skipped:true}).
  if (!parsed.forceSpawn) {
    const probe = opts.probeHostPressure ?? probeHostPressure;
    const verdict = await probe({ env });
    if (!verdict.ok && !verdict.skipped) {
      // ADR-228 §D1 refuse→enqueue path. Operator-side escape via
      // `--no-queue` falls through to the original throw-on-pressure
      // behavior (synchronous failure for one-shot scripts). Default
      // path opens the parent's state.db and enqueues for orchd's
      // pressure-monitor drain loop (`pressureMonitorTick` in
      // `src/core/spawn-queue.ts`).
      if (!parsed.noQueue) {
        // Resolve parent root early via cockpit (same lookup step 2
        // performs on the success path — duplicated here so the rare
        // pressure-refused branch keeps its own scope).
        const cockpitRaw = await readJson(cockpitPath, RawCockpitForMutation);
        const cockpitMigrated = migrateLegacyShape(
          cockpitRaw,
          cockpitPath,
          logger.warn,
        ) as typeof cockpitRaw;
        const parentEntry = findTeamSession(
          (cockpitMigrated.sessions as SessionEntry[] | undefined) ?? [],
          parsed.parentTeam,
        );
        if (parentEntry !== null && parentEntry.root !== undefined && parentEntry.root.length > 0) {
          const parentAtmuxDir = `${parentEntry.root}/.atmux`;
          const parentDbPath = `${parentAtmuxDir}/state.db`;
          const db = openDb(parentDbPath);
          try {
            const limits = resolveSpawnQueueLimits(env);
            const queuedBy = env.ATMUX_CALLER_SCOPE === "driver" ? "driver" : "operator";
            const enqResult = enqueueIfPressured(parsed.epicId, argv, {
              db,
              limits,
              queuedBy,
            });
            if (enqResult.enqueued) {
              logger.log(
                `spawn-epic: host pressure too high — queued ${enqResult.queueId} (depth ${enqResult.depth}/${limits.maxDepth}). orchd will retry when load drops. Override with --no-queue.`,
              );
              return 0;
            }
            // Refused — fall through to throw with reason from
            // admit() (queue full or duplicate epic).
            throw new ConfigError({
              what: `spawn-epic: refused — ${formatPressureError(verdict)} AND ${enqResult.reason}`,
              hint:
                "wait for pressure to drop OR override with --force-spawn (use sparingly) OR " +
                "raise ATMUX_SPAWN_QUEUE_MAX_DEPTH for a larger queue.",
            });
          } finally {
            closeDb(db);
          }
        }
        // Parent missing — fall through to the original throw (no
        // queue available without a parent db).
      }
      throw new ConfigError({
        what: `spawn-epic: refused — ${formatPressureError(verdict)}`,
        hint:
          "wait for pressure to drop OR override with --force-spawn (use sparingly). " +
          "tune thresholds via ATMUX_SPAWN_MAX_LOAD_RATIO + ATMUX_SPAWN_MIN_FREE_MB env.",
      });
    }
  } else {
    logger.warn(
      "spawn-epic: --force-spawn bypasses host-pressure gate (ADR-184) — operator owns the consequences.",
    );
  }

  // 2. Resolve parent via cockpit walk (raw read so we can mutate +
  //    write back later in step 8). Pre-ADR-089 cockpits carry flat
  //    `teams[]` instead of `sessions[]`; run the migrateLegacyShape
  //    shim so the verb works against either shape. The migrated
  //    object is what we mutate + write back in step 8, so post-spawn
  //    the on-disk cockpit.json lands fully on the new sessions[]
  //    shape (operators get a free migration as a side effect).
  const cockpitRaw = await readJson(cockpitPath, RawCockpitForMutation);
  const cockpitMigrated = migrateLegacyShape(
    cockpitRaw,
    cockpitPath,
    logger.warn,
  ) as typeof cockpitRaw;
  const parentEntry = findTeamSession(
    (cockpitMigrated.sessions as SessionEntry[] | undefined) ?? [],
    parsed.parentTeam,
  );
  if (parentEntry === null) {
    throw new ConfigError({
      what: `spawn-epic: parent team '${parsed.parentTeam}' not found in cockpit ${cockpitPath}`,
      hint: "register the parent in cockpit.json::sessions[] first",
    });
  }
  if (parentEntry.root === undefined || parentEntry.root.length === 0) {
    throw new ConfigError({
      what: `spawn-epic: parent team '${parsed.parentTeam}' has no 'root' in cockpit.json`,
      hint: "every team session entry must carry an absolute root path",
    });
  }
  const parentRoot = parentEntry.root;

  // t-54ba3c49 — soft-warn at 20+ concurrent epics under same parent.
  // Per ADR-090 §Amendment 2026-05-20: the per-parent cap is LIFTED;
  // operators can spawn freely. But at high concurrency (>20 epics
  // under one parent), auto-merge queue throughput may saturate. This
  // warn is visibility, not refuse — the spawn proceeds either way.
  // Counts existing epic-team children of the parent's sessions[]
  // (post-migrateLegacyShape so legacy shapes are already lifted).
  const SOFT_WARN_THRESHOLD = 20;
  const parentEpicCount = (parentEntry.sessions ?? []).filter(
    (s) => (s as { type?: string }).type === "epic-team",
  ).length;
  if (parentEpicCount >= SOFT_WARN_THRESHOLD) {
    logger.warn(
      `spawn-epic: ${parentEpicCount} concurrent epic-team(s) already under '${parsed.parentTeam}' — auto-merge queue depth may saturate at this scale. ` +
        `Proceeding (no refuse — per ADR-090 §Amendment 2026-05-20).`,
    );
  }

  // 2.5. ADR-225 eligibility gate (T5 / t-1fbd2aa4). Refuses spawn
  //      when the parent's epic row has is_ready=0 OR any direct dep
  //      is not status='done'. The predicate lives in core/epic.ts
  //      (T3). `--force` bypasses the gate but:
  //        (a) appends a structured override record to
  //            `~/.atmux/state/spawn-overrides.log` BEFORE any spawn-
  //            side work begins (audit trail survives a failed spawn).
  //        (b) emits a `[spawn-force]` Discord ping with the same
  //            payload (parallel to ADR-144 §T5 test-gate-bypass).
  //
  //      The epic row lives in the PARENT team's state.db (the kanban
  //      that owns the epic). `parentEpicKanbanId` defaults to
  //      `e-<epicId>` in step 3; we mirror the same fallback here so
  //      the predicate runs against the same row.
  const parentAtmuxDir = join(parentRoot, ".atmux");
  const eligibilityProbe = opts.eligibilityProbe ?? epicIsEligible;
  const parentEpicKanbanIdForCheck = parsed.parentEpicKanbanId ?? `e-${parsed.epicId}`;
  const eligibility = await eligibilityProbe(parentAtmuxDir, parentEpicKanbanIdForCheck);
  if (!eligibility.eligible) {
    if (!parsed.forceEligibility) {
      throw new UsageError({
        what:
          `spawn-epic: refused — epic ${parentEpicKanbanIdForCheck} is not eligible (ADR-225). ` +
          `Blockers:\n  - ${eligibility.blockers.join("\n  - ")}`,
        hint:
          "fix blockers via `atmux epic ready <eid>` and/or `atmux epic advance` " +
          "on the upstream deps. To override anyway, re-run with --force (logged " +
          "to ~/.atmux/state/spawn-overrides.log + Discord [spawn-force]).",
      });
    }
    // --force was set on an ineligible epic — log + Discord BEFORE the
    // spawn proceeds so the audit trail lands even if the spawn fails
    // downstream. The Discord seam defaults to noop in tests; in
    // production the cockpit wires it to the channel publisher.
    const callerMember =
      env.ATMUX_MEMBER !== undefined && env.ATMUX_MEMBER.length > 0 ? env.ATMUX_MEMBER : "unknown";
    const overrideRecord: SpawnOverrideRecord = {
      epicId: parentEpicKanbanIdForCheck,
      team: parsed.parentTeam,
      blockers: eligibility.blockers,
      callerMember,
      callerScope: callerScope(),
    };
    const logOverride = opts.logSpawnOverride ?? defaultLogSpawnOverride;
    await logOverride(overrideRecord, opts.logSpawnOverrideOpts);
    const sendDiscord = opts.sendSpawnForceDiscord ?? (async () => {});
    await sendDiscord({
      topic: "spawn-force",
      epicId: parentEpicKanbanIdForCheck,
      team: parsed.parentTeam,
      blockers: eligibility.blockers,
      callerMember,
      callerScope: callerScope(),
    });
    logger.warn(
      `spawn-epic: --force bypassed eligibility gate for ${parentEpicKanbanIdForCheck} ` +
        `(blockers: ${eligibility.blockers.join("; ")}). ` +
        "Logged to ~/.atmux/state/spawn-overrides.log + Discord [spawn-force].",
    );
  }

  // 3. Compute paths.
  const epicsDir = `${parentRoot}-epics`;
  const epicRoot = join(epicsDir, parsed.epicId);
  // ADR-090 §Disk layout (§Amendment 2026-05-26 — double-e fix):
  // branch = `<parentBase>-epic-<epicIdNoPrefix>`. The epicId carries
  // its own `e-` prefix (e.g. `e-21-6593dd0f`); the literal `epic-`
  // token already names the branch class, so we strip the `e-` to
  // avoid producing `epic-e-21-...` (the "double-e" form). Legacy
  // branches emitted before this amendment kept the double-e form;
  // the topo-io.ts parser carries a back-compat fallback during the
  // migration window.
  const parentBase = parsed.parentBase ?? (await currentBranch(parentRoot, git));
  const epicIdForBranch = parsed.epicId.replace(/^e-/, "");
  const epicBranch = `${parentBase}-epic-${epicIdForBranch}`;

  // Refuse if the epic-team is already spawned (the worktree exists).
  // Operators who want to re-spawn must dissolve-epic first.
  if (await exists(epicRoot)) {
    throw new ConfigError({
      what: `spawn-epic: epic-team root already exists at ${epicRoot}`,
      hint: `dissolve-epic '${parsed.epicId}' first, OR remove the directory manually`,
    });
  }

  // 4. Resolve roster.
  const templatesDir = opts.templatesDir ?? defaultTemplatesDir();
  const rosterMembers = await resolveRosterMembers(parsed, templatesDir, cockpitPath);

  // 4a. Inherit `claudeAccount` from the parent team's per-member entries
  //     when the roster preset doesn't specify one. Fixes the 401 'Please
  //     run /login' regression caught by the 2026-05-16 dogfood — the
  //     default roster preset (`templates/epic-rosters/default.json`) ships
  //     without `claudeAccount`, so spawned cage members hit unauthenticated
  //     CLAUDE_CONFIG_DIR. Inheritance rule: per-member name match wins, then
  //     fall back to the parent's first-member account as the team-default.
  //     Roster entries that explicitly carry `claudeAccount` are NOT
  //     overwritten — operators retain per-roster override control.
  //
  //     ADR-199: when the cockpit configures `claudeAccountPool[]` AND
  //     the parent has no team-default claudeAccount AND no per-member
  //     match, select an account from the pool (least-loaded by budget
  //     probe). The pool fills the bottom of the inheritance ladder;
  //     explicit roster + parent matches still win.
  const poolFallback = await resolvePoolFallback({
    pool: extractPoolFromCockpit(cockpitMigrated),
    env,
  });
  const rosterMembersWithAccount = await inheritClaudeAccount(
    rosterMembers,
    parentRoot,
    poolFallback,
    logger,
  );

  // 5. provisionWorktree. Side-effect tracker for rollback.
  await mkdir(epicsDir, { recursive: true });
  const provision = await provisionWorktree(parentRoot, parentBase, epicBranch, epicRoot, {
    git,
    initSubmodules: parsed.initSubmodules,
    warn: logger.warn,
  });
  let needsRollback = provision.created;

  try {
    // 6. Synthesize + write child team.json. Validate BEFORE write.
    const childTeam: TeamShape = Team.parse({
      name: parsed.epicId,
      members: rosterMembersWithAccount,
      worktreeIsolation: false,
      worktreeInitSubmodules: parsed.initSubmodules,
      // Per ADR-089 §Pillar 1: child tmpdir nests under parent's
      // cage tmpdir at `/tmp/atmux-<parent>/epics/<epicId>/sock`.
      // The Team schema's `tmuxTmpdir` is the directory (atmux init's
      // pattern: `/tmp/atmux-tmux_<team>`); here we follow the
      // ADR-089 nesting convention literally.
      tmuxTmpdir: `/tmp/atmux-${parsed.parentTeam}/epics/${parsed.epicId}`,
      epicTeam: {
        parent: parsed.parentTeam,
        parentEpicKanbanId: parsed.parentEpicKanbanId ?? `e-${parsed.epicId}`,
        parentBase,
        mergeMode: parsed.mergeMode ?? "auto",
        autoDissolve: parsed.autoDissolve,
      },
    });
    const childAtmuxDir = join(epicRoot, ".atmux");
    await mkdir(childAtmuxDir, { recursive: true });
    await writeText(join(childAtmuxDir, "team.json"), `${JSON.stringify(childTeam, null, 2)}\n`);

    // 7. Init child state.db (creates file + runs migrations).
    const db = openDb(join(childAtmuxDir, "state.db"));
    closeDb(db);

    // 8. Register child in parent's cockpit sessions[]. Write the
    //    MIGRATED object back (not the raw read) so pre-ADR-089
    //    cockpits land on the new sessions[] shape post-spawn —
    //    `parentEntry` is a ref into `cockpitMigrated.sessions[]`
    //    so the mutation is visible through either handle.
    appendChildToSessions(parentEntry, parsed);
    await writeText(cockpitPath, `${JSON.stringify(cockpitMigrated, null, 2)}\n`);

    // 9. Success log + next-step hint.
    logger.log(
      `epic-team spawned: ${parsed.epicId} at ${epicRoot} (parent=${parsed.parentTeam}, branch=${epicBranch})`,
    );
    logger.log(
      "next: `atmux cockpit rebuild` to spawn the child cage (v1 — auto-spawn lands in a follow-up Task)",
    );
    needsRollback = false;
    return 0;
  } finally {
    if (needsRollback) {
      // Best-effort: tear down the worktree we created so the
      // operator's filesystem stays clean. Force-mode is safe here —
      // we authored the worktree this turn; no operator data lives
      // inside it.
      try {
        await pruneWorktree(parentRoot, epicRoot, {
          git,
          dirty: "force",
        });
        logger.warn(`spawn-epic: rolled back worktree at ${epicRoot} after a mid-pipeline failure`);
      } catch (e) {
        logger.warn(
          `spawn-epic: rollback failed for ${epicRoot}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }
}

// ---------- Helpers ----------

function findTeamSession(sessions: ReadonlyArray<SessionEntry>, name: string): SessionEntry | null {
  for (const s of sessions) {
    if (s.type === "team" && s.name === name) return s;
    if (Array.isArray(s.sessions)) {
      const inner = findTeamSession(s.sessions, name);
      if (inner !== null) return inner;
    }
  }
  return null;
}

function appendChildToSessions(parentEntry: SessionEntry, parsed: ParsedSpawnEpicArgs): void {
  const child: SessionEntry = {
    type: "epic-team",
    name: parsed.epicId,
    parent: parsed.parentTeam,
    epicId: parsed.epicId,
  };
  if (parentEntry.sessions === undefined) parentEntry.sessions = [];
  // Refuse if already registered — pipeline already checked exists()
  // on the worktree path, but the cockpit registration is independent.
  const existing = parentEntry.sessions.find(
    (s) => s.type === "epic-team" && s.name === parsed.epicId,
  );
  if (existing !== undefined) {
    throw new ConfigError({
      what: `spawn-epic: cockpit already has epic-team '${parsed.epicId}' under parent '${parsed.parentTeam}'`,
      hint: "remove the entry manually if you intend to re-spawn",
    });
  }
  parentEntry.sessions.push(child);
}

async function currentBranch(repoPath: string, git: GitSpawn): Promise<string> {
  const r = await git(["-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (r.exitCode !== 0) {
    throw new ConfigError({
      what: `spawn-epic: failed to read HEAD branch at ${repoPath} (exit ${r.exitCode})`,
      hint: r.stderr.trim() || "(no stderr)",
    });
  }
  return r.stdout.trim();
}

async function resolveRosterMembers(
  parsed: ParsedSpawnEpicArgs,
  templatesDir: string,
  cockpitPath: string,
): Promise<TeamShape["members"]> {
  // Schema for roster JSON — minimal shape, just `members: [...]`.
  // We parse the file directly without validating against the full
  // Team schema (the Team schema's superRefine fires later on the
  // synthesised team).
  const RosterShape = z
    .object({
      members: z.array(z.unknown()),
    })
    .passthrough();
  let path: string;
  if (parsed.rosterFile !== undefined) {
    path = parsed.rosterFile;
  } else {
    const preset = parsed.roster ?? "default";
    path = join(templatesDir, `${preset}.json`);
  }
  if (!(await exists(path))) {
    throw new ConfigError({
      what: `spawn-epic: roster file not found at ${path}`,
      hint: `cockpit=${cockpitPath} — verify the preset name or use --roster-file <abs-path>`,
    });
  }
  const raw = await readJson(path, RosterShape);
  // Cast through unknown — the Team schema validates each member
  // shape downstream when the full team object is parsed.
  return raw.members as TeamShape["members"];
}

/** Inherit `claudeAccount` from the parent team's per-member entries onto
 *  roster members that don't already specify one. Per-member name match
 *  wins; falls back to the parent's first-member account as the team-
 *  default. Roster entries that already carry `claudeAccount` are NOT
 *  overwritten. Returns members untouched when parent team.json is
 *  unreadable or has no claudeAccount anywhere (downstream schema validation
 *  surfaces the misconfig more clearly than a synthetic error here).
 *
 *  Fixes 2026-05-16 dogfood regression: default roster preset shipped
 *  without `claudeAccount`, so all spawned cage members hit
 *  "Please run /login · API Error: 401" on first bootstrap. */
async function inheritClaudeAccount(
  rosterMembers: TeamShape["members"],
  parentRoot: string,
  poolFallback: ClaudeAccountPoolEntry | null = null,
  logger?: { log: (m: string) => void; warn: (m: string) => void },
): Promise<TeamShape["members"]> {
  const parentTeamPath = join(parentRoot, ".atmux", "team.json");
  let parentMembers: { name?: unknown; claudeAccount?: unknown }[] = [];
  if (await exists(parentTeamPath)) {
    const ParentShape = z.object({ members: z.array(z.unknown()) }).passthrough();
    try {
      const parentParsed = await readJson(parentTeamPath, ParentShape);
      parentMembers = parentParsed.members as typeof parentMembers;
    } catch {
      // Unreadable parent → fall through to pool-fallback if available.
    }
  }
  const byName = new Map<string, unknown>();
  let teamDefault: unknown;
  for (const m of parentMembers) {
    if (
      m !== null &&
      typeof m === "object" &&
      m.claudeAccount !== undefined &&
      typeof m.name === "string"
    ) {
      byName.set(m.name, m.claudeAccount);
      if (teamDefault === undefined) teamDefault = m.claudeAccount;
    }
  }
  // ADR-199: bottom of the inheritance ladder. When no parent default
  // is available AND no per-member match would fill, the pool fallback
  // supplies the team-default. The pool entry's {configDir, label}
  // shape maps 1:1 to claudeAccount.
  if (teamDefault === undefined && poolFallback !== null) {
    teamDefault = {
      configDir: poolFallback.configDir,
      label: poolFallback.label,
    };
    if (logger !== undefined) {
      logger.log(`spawn-epic: claudeAccount drawn from pool — '${poolFallback.label}' (ADR-199)`);
    }
  }
  if (teamDefault === undefined && byName.size === 0) return rosterMembers;
  return rosterMembers.map((m) => {
    const member = m as { name?: unknown; claudeAccount?: unknown };
    if (member.claudeAccount !== undefined) return m;
    const inherited =
      typeof member.name === "string" && byName.has(member.name)
        ? byName.get(member.name)
        : teamDefault;
    if (inherited === undefined) return m;
    return { ...member, claudeAccount: inherited } as TeamShape["members"][number];
  });
}

/** Read the `claudeAccountPool[]` from a cockpit-shaped object. Returns
 *  empty array when the key is absent OR malformed (best-effort —
 *  spawn-epic continues with the existing parent-inheritance path).
 *  ADR-199 minimal slice. */
function extractPoolFromCockpit(cockpit: unknown): readonly ClaudeAccountPoolEntry[] {
  if (cockpit === null || typeof cockpit !== "object") return [];
  const c = cockpit as { claudeAccountPool?: unknown };
  if (!Array.isArray(c.claudeAccountPool)) return [];
  // Defensive coercion: filter to entries matching the {configDir,label}
  // shape. Zod-strict at the cockpit-load layer would normally enforce
  // this; the duck-typed filter here keeps us safe if cockpit was read
  // raw (passthrough) — same defensive pattern as the existing parent
  // member loop above.
  const out: ClaudeAccountPoolEntry[] = [];
  for (const e of c.claudeAccountPool) {
    if (
      e !== null &&
      typeof e === "object" &&
      typeof (e as { configDir?: unknown }).configDir === "string" &&
      typeof (e as { label?: unknown }).label === "string"
    ) {
      const entry = e as { configDir: string; label: string; weight?: number };
      out.push({
        configDir: entry.configDir,
        label: entry.label,
        ...(typeof entry.weight === "number" ? { weight: entry.weight } : {}),
      });
    }
  }
  return out;
}

/** Resolve the pool selection result into a single account entry, or
 *  `null` when the pool is empty / nothing selectable. Loads the
 *  per-label budget probe state from `$HOME/.atmux/state/budget-probe-*.json`. */
async function resolvePoolFallback(deps: {
  pool: readonly ClaudeAccountPoolEntry[];
  env: NodeJS.ProcessEnv;
}): Promise<ClaudeAccountPoolEntry | null> {
  if (deps.pool.length === 0) return null;
  const home = deps.env.HOME ?? "/root";
  const budgetMap = await loadBudgetMap(deps.pool, home);
  const { account } = selectAccount({ pool: deps.pool, budgetByLabel: budgetMap });
  return account;
}

function defaultTemplatesDir(): string {
  // Resolve relative to the source file at compile + runtime. atmux
  // ships templates/ next to src/ in the dev tree; the compiled
  // binary embeds the templates path via a different mechanism (not
  // relevant for this verb's typical cron-free operator invocation).
  // Falls back to process.cwd() + relative path if absolute resolve
  // fails — the dev-tree happy path covers `pnpm dev` / bun run.
  const cwd = process.cwd();
  return join(cwd, "templates", "epic-rosters");
}
