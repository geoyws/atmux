// ADR-250 — orchd stale-epic-team reaper. Closes the spawn-without-reap
// leak: orchd spawns epic-teams on epic.ready/epic.unblocked but only
// dissolves them on the happy path (epic.merged → epic.pushed →
// auto-dissolve). A spawned epic-team that never finishes is never reaped;
// its tmux cage (one `claude` TUI per member) lives forever. Accumulated
// cages were the 2026-05-29 RAM growth (136 claude TUIs ≈ 43.6 GB).
//
// This walker classifies each spawned epic-team by CAGE LIVENESS and acts:
//
//   - dead-cage orphan (cockpit entry present, no live tmux session) →
//     AUTO-REAP via `performDissolveEpic` (safe — no live work to lose).
//   - live-but-idle (live session, no progress ≥ threshold) → ESCALATE
//     to the lead, NEVER auto-kill (doctrine: escalate, don't auto-destroy).
//   - live + active → skip.
//
// **Safety-first defaults** (ADR-250 §D4): every cross-module call is a
// dep-injection seam. The PRODUCTION action seams are real (`dissolve` =
// performDissolveEpic, `escalate` = log). The ENUMERATOR + LIVENESS seams
// default to conservative no-ops:
//   - `listSpawnedEpicTeams` → [] (nothing considered until the real
//     per-epic-socket enumerator is wired — same scaffolding idiom as
//     `orchd-sweep.ts`'s stub seams).
//   - `isCageAlive` → `true` (unknown liveness ⇒ treat as ALIVE ⇒ never
//     reap; a misclassified-dead live cage would be destroyed, so the
//     default fails CLOSED).
//   - `isCageStaleIdle` → `false` (never escalate spuriously).
// Net shipped default = safe no-op; tests inject all seams to exercise
// every branch; the CLI (`atmux orchd --reap-stale`) injects the real
// enumerator + liveness once the per-epic-socket resolution lands.

import { performDissolveEpic } from "./dissolve-epic.ts";

/** One spawned epic-team the reaper may act on. `cageSessionName` is the
 *  tmux session name of the epic's cage (used by `isCageAlive`). */
export interface SpawnedEpicTeam {
  epicId: string;
  cageSessionName: string;
}

export type ReapOutcome =
  | "reaped" // dead-cage orphan dissolved
  | "escalated" // live-but-idle, surfaced to lead (not killed)
  | "skipped-live-active" // live cage, recent progress
  | "skipped-dry-run" // would act, but --dry-run
  | "error"; // per-epic action threw (isolated)

export interface ReapDetail {
  epicId: string;
  outcome: ReapOutcome;
  reason: string;
}

/** Counters surface what the walker SAW + DID, separately, so a `--dry-run`
 *  or log line reads as an honest classification. */
export interface ReapStaleEpicTeamsResult {
  considered: number;
  reaped: number;
  escalated: number;
  skippedActive: number;
  errors: number;
  details: ReapDetail[];
}

interface ReapLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

const NOOP_LOGGER: ReapLogger = { info: () => {}, warn: () => {} };

export interface ReapStaleEpicTeamsDeps {
  /** Enumerate spawned epic-teams for this team. Defaults to the stub `[]`
   *  (real per-epic-socket enumerator injected by the CLI — ADR-250 §D2). */
  listSpawnedEpicTeams?: (atmuxDir: string) => Promise<ReadonlyArray<SpawnedEpicTeam>>;
  /** True iff the epic's cage tmux session is live. Defaults to `true`
   *  (fail-closed: unknown liveness ⇒ never reap). */
  isCageAlive?: (cageSessionName: string) => Promise<boolean>;
  /** For a LIVE cage: true iff it has made no progress past the staleness
   *  threshold. Defaults to `false` (never escalate spuriously). */
  isCageStaleIdle?: (team: SpawnedEpicTeam) => Promise<boolean>;
  /** Dissolve a dead-cage orphan. Defaults to `performDissolveEpic`. */
  dissolve?: (epicId: string) => Promise<void>;
  /** Surface a live-but-idle cage to the lead. Defaults to log-only. */
  escalate?: (team: SpawnedEpicTeam, reason: string) => Promise<void>;
  logger?: ReapLogger;
  /** Classify + report but take no destructive action. */
  dryRun?: boolean;
}

async function defaultListSpawnedEpicTeams(
  _atmuxDir: string,
): Promise<ReadonlyArray<SpawnedEpicTeam>> {
  // ADR-250 §D2 — real enumerator (cockpit epic-team walk + per-epic-socket
  // cage-session resolution) is injected by the `--reap-stale` CLI. Stub
  // returns [] so the shipped default considers nothing — safe no-op.
  return [];
}

async function defaultIsCageAlive(_cageSessionName: string): Promise<boolean> {
  // Fail CLOSED: when liveness can't be determined, treat the cage as ALIVE
  // so it is never reaped. A false-"dead" verdict would destroy a live cage.
  return true;
}

async function defaultIsCageStaleIdle(_team: SpawnedEpicTeam): Promise<boolean> {
  // Conservative: never escalate without a real idleness signal. The
  // live-idle escalation + auto-kill (ATMUX_ORCHD_REAP_LIVE_IDLE) is the
  // gated next phase per ADR-250 §D1.
  return false;
}

async function defaultDissolve(epicId: string): Promise<void> {
  // Reuse the canonical pipeline (ADR-090 / ADR-219). Default checks: a
  // dead cage resolves childTeam=null so the all-tasks-done + clean-worktree
  // gates auto-skip; a dirty worktree is REFUSED (throws), never force-pruned.
  await performDissolveEpic({ epicId, skipChecks: false, forcePrune: false });
}

async function defaultEscalate(team: SpawnedEpicTeam, reason: string): Promise<void> {
  // Log-only until the lead-escalation event wiring lands (ADR-250 §D1).
  // Intentionally inert — surfaces in the orchd pane log.
  process.stderr.write(
    `orchd-reap: ESCALATE epic=${team.epicId} (live-idle) — ${reason}\n`,
  );
}

/**
 * Run one reaper tick. For each spawned epic-team:
 *   - dead cage  → dissolve (or report under dryRun);
 *   - live+idle  → escalate (or report under dryRun);
 *   - live+active→ skip.
 *
 * Failure isolation matches `orchdSweep` (ADR-231 anti-retry-storm): a thrown
 * per-epic action is caught, counted as an error, and the walk continues —
 * never halts, never retries in-loop.
 */
export async function reapStaleEpicTeams(
  atmuxDir: string,
  deps: ReapStaleEpicTeamsDeps = {},
): Promise<ReapStaleEpicTeamsResult> {
  const list = deps.listSpawnedEpicTeams ?? defaultListSpawnedEpicTeams;
  const alive = deps.isCageAlive ?? defaultIsCageAlive;
  const staleIdle = deps.isCageStaleIdle ?? defaultIsCageStaleIdle;
  const dissolve = deps.dissolve ?? defaultDissolve;
  const escalate = deps.escalate ?? defaultEscalate;
  const logger = deps.logger ?? NOOP_LOGGER;
  const dryRun = deps.dryRun ?? false;

  const result: ReapStaleEpicTeamsResult = {
    considered: 0,
    reaped: 0,
    escalated: 0,
    skippedActive: 0,
    errors: 0,
    details: [],
  };

  const teams = await list(atmuxDir);
  for (const team of teams) {
    result.considered += 1;
    try {
      const isAlive = await alive(team.cageSessionName);

      if (!isAlive) {
        // ---------- dead-cage orphan ----------
        if (dryRun) {
          result.details.push({
            epicId: team.epicId,
            outcome: "skipped-dry-run",
            reason: "dead-cage orphan — would reap",
          });
          continue;
        }
        await dissolve(team.epicId);
        result.reaped += 1;
        result.details.push({
          epicId: team.epicId,
          outcome: "reaped",
          reason: "dead-cage orphan (no live tmux session)",
        });
        logger.info(`orchd-reap: reaped dead-cage orphan epic=${team.epicId}`);
        continue;
      }

      // ---------- live cage ----------
      const idle = await staleIdle(team);
      if (idle) {
        if (dryRun) {
          result.details.push({
            epicId: team.epicId,
            outcome: "skipped-dry-run",
            reason: "live-idle — would escalate",
          });
          continue;
        }
        await escalate(team, "live cage idle past staleness threshold");
        result.escalated += 1;
        result.details.push({
          epicId: team.epicId,
          outcome: "escalated",
          reason: "live cage idle past staleness threshold",
        });
        continue;
      }

      result.skippedActive += 1;
      result.details.push({
        epicId: team.epicId,
        outcome: "skipped-live-active",
        reason: "live cage with recent progress",
      });
    } catch (e) {
      result.errors += 1;
      const msg = e instanceof Error ? e.message : String(e);
      result.details.push({ epicId: team.epicId, outcome: "error", reason: msg });
      logger.warn(`orchd-reap: epic=${team.epicId} action threw: ${msg} — isolated, continuing`);
    }
  }

  return result;
}
