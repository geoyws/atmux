// ADR-231 §D2 + §D3 — orchd auto-spawn handler + per-epic/per-team
// autoSpawn resolver.
//
// Subscribes to `epic.ready` + `epic.unblocked` (per ADR-225 §Events)
// via the orchd-bootstrap registry. On each event, runs the §D2
// 5-step algorithm:
//
//   1. Load epic by id; row-missing → silent skip.
//   2. Dedup gate: `spawned_at IS NOT NULL` → silent skip
//      (orchd or operator already spawned this epic-team).
//   3. autoSpawn gate: `effectiveAutoSpawn(epic, team)` returns
//      `{ enabled: false }` → silent skip.
//   4. Eligibility gate: `epicIsEligible(atmuxDir, epicId).eligible`
//      false → silent skip (ADR-225 predicate held, e.g. unmet deps).
//   5. Spawn: `atmux team spawn-epic <epicId> --from <parentTeam>
//      [--roster <r>] [--force-spawn]` subprocess.
//      - exit 0 → `UPDATE epics SET spawned_at = unixepoch()` +
//        return `"spawned"`.
//      - non-zero → classify via `classifySpawnFailure` (t-13):
//        - `hard`            → write `extra.spawnFailed` + flag p1 +
//                              return `"flag-raised"`.
//        - `host-pressure`   → increment `extra.spawnPressureDeferred`;
//                              if ≥3 emit `host-pressure-deferred` flag
//                              p1; return `"skipped"` (cron --sweep
//                              re-attempts; NO retry here per ADR-231
//                              anti-retry-storm doctrine).
//        - `eligibility-race` → silent skip; next event re-fires
//                               (common case: operator flipped
//                               is_ready=1 then 0 in rapid succession).
//
// effectiveAutoSpawn (§D3) precedence:
//   1. Per-epic explicit `epic.extra.autoSpawn.enabled` (true OR false)
//      wins — explicit false defeats per-team auto-spawn.
//   2. If per-epic absent, walk per-team `team.json::autoSpawn.defaults[]`
//      first-match-wins (regex `match` against `epic.title`).
//   3. Otherwise → `{ enabled: false }` (default off).
//
// Cross-refs:
//   - ADR-231 §D2 (algorithm); §D3 (config + precedence); §D5 (3-way
//     failure classifier consumed via classifySpawnFailure t-13).
//   - ADR-225 §Events (epic.ready + epic.unblocked emit semantics);
//     `epicIsEligible` predicate (src/core/epic.ts:341+).
//   - ADR-184 host-pressure refusal signature (transient class).
//   - ADR-090 §spawn-epic (verb signature: `<epicId> --from <parent>`).
//   - t-13-2f8b0d92 (classifier); t-3-bfbda5d8 dispatcher seam pattern.

import type { Database } from "bun:sqlite";
import { spawn as defaultSpawn, type SpawnResult } from "../abstractions/spawn.ts";
import { epicIsEligible as defaultEpicIsEligible } from "./epic.ts";
import { classifySpawnFailure, type SpawnFailureClass } from "./orchd-spawn-classify.ts";
import { KanbanRepo } from "./repositories/kanban-repo.ts";
import type { KanbanEpic } from "../schema/kanban.ts";
import type { Team, TeamAutoSpawnDefault } from "../schema/team.ts";

// ---------- effectiveAutoSpawn (§D3) ----------

/** Resolved auto-spawn decision per ADR-231 §D3 precedence rule.
 *  `enabled` is the final gate; `roster` + `forceSpawn` are passed
 *  through to the `atmux team spawn-epic` argv when `enabled === true`.
 *
 *  When the per-epic explicit `enabled: false` wins, the resolved
 *  shape carries `enabled: false` and the spawn handler short-
 *  circuits at step 3 before touching the eligibility predicate. */
export interface AutoSpawnDecision {
  enabled: boolean;
  /** Roster preset name to pass to `--roster`. Absent → spawn-epic
   *  applies its own default per ADR-090 §Decision-anchor #4. */
  roster?: string;
  /** True iff `--force-spawn` should be passed (bypasses ADR-184
   *  host-pressure gate per the per-epic / per-team config). */
  forceSpawn?: boolean;
}

/**
 * Resolve the effective autoSpawn decision for `epic` against the
 * running cage's `team` config. Pure — no I/O.
 *
 * Precedence per ADR-231 §D3:
 *   1. **Per-epic explicit** (`epic.extra.autoSpawn.enabled`) wins
 *      regardless of value. Explicit `false` defeats per-team match
 *      so an operator who typed `--no-auto-spawn` isn't overridden by
 *      a wildcard default.
 *   2. **Per-team `defaults[]` first-match-wins.** Each entry's
 *      `match` is compiled via `new RegExp(match)` (schema-validated
 *      at parse time per t-8) and tested against `epic.title`.
 *      First hit returns `{ enabled: true, roster, forceSpawn }`.
 *   3. **Default off** — no per-epic explicit, no per-team match →
 *      `{ enabled: false }`.
 *
 * Returns the resolved shape; callers gate on `.enabled`.
 */
export function effectiveAutoSpawn(epic: KanbanEpic, team?: Team): AutoSpawnDecision {
  // (1) Per-epic explicit wins (true OR false).
  const epicConfig = epic.extra?.autoSpawn;
  if (epicConfig !== undefined) {
    const decision: AutoSpawnDecision = { enabled: epicConfig.enabled };
    if (epicConfig.roster !== undefined) decision.roster = epicConfig.roster;
    if (epicConfig.forceSpawn !== undefined) decision.forceSpawn = epicConfig.forceSpawn;
    return decision;
  }

  // (2) Per-team defaults[] first-match-wins. Match against epic.title
  //     (the operator-facing label; subject/id are less stable).
  const defaults = team?.autoSpawn?.defaults;
  const title = epic.title ?? "";
  if (defaults !== undefined && defaults.length > 0 && title.length > 0) {
    for (const entry of defaults) {
      if (matchesEntry(title, entry)) {
        const decision: AutoSpawnDecision = { enabled: true, roster: entry.roster };
        if (entry.forceSpawn !== undefined) decision.forceSpawn = entry.forceSpawn;
        return decision;
      }
    }
  }

  // (3) Default off.
  return { enabled: false };
}

/** Compile + test one defaults entry. The schema already validates the
 *  regex source at parse time (t-8 z.string().refine(new RegExp)), so
 *  this just re-compiles per call. A try/catch defends against a
 *  schema bypass (e.g. team.json loaded via a non-Zod path) — never
 *  throws out of effectiveAutoSpawn. */
function matchesEntry(title: string, entry: TeamAutoSpawnDefault): boolean {
  try {
    return new RegExp(entry.match).test(title);
  } catch {
    return false;
  }
}

// ---------- spawnEpicHandler (§D2) ----------

/** Outcome categories the handler returns + the orchd-bootstrap
 *  wrapper drops on the floor (per the registry contract). Surfaces
 *  here for tests + future per-outcome observability hooks. */
export type SpawnEpicHandlerOutcome =
  | "spawned"
  | "skipped-row-missing"
  | "skipped-already-spawned"
  | "skipped-autospawn-off"
  | "skipped-eligibility-race"
  | "skipped-host-pressure"
  | "flag-raised";

/** Logger surface mirroring sibling handler modules. */
export interface Logger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}
const noopLog: Logger["info"] = () => {};
const NOOP_LOGGER: Logger = { info: noopLog, warn: noopLog, error: noopLog };

/** Test-injection seam for {@link createSpawnEpicHandler}. */
export interface SpawnEpicHandlerDeps {
  /** Open per-team Database (state.db) — handler uses it for the dedup
   *  gate read AND the spawn-success UPDATE. */
  db: Database;
  /** Absolute path to the team's `.atmux/` dir — required for the
   *  eligibility probe and surfaced into `--team-dir` if needed. */
  atmuxDir: string;
  /** Running cage's Team config — surfaces `team.name` for
   *  `--from <parentTeam>` AND `team.autoSpawn.defaults[]` for the
   *  effectiveAutoSpawn fallback. */
  team: Team;
  /** Spawn fn for `atmux team spawn-epic` + `atmux flag add`. Default
   *  uses the buffered abstraction. */
  spawn?: typeof defaultSpawn;
  /** Eligibility predicate override (test seam). Default uses
   *  {@link defaultEpicIsEligible} from `src/core/epic.ts`. */
  epicIsEligible?: typeof defaultEpicIsEligible;
  /** effectiveAutoSpawn override (test seam). Default uses the pure
   *  helper above with `(epic, team)` bound. */
  effectiveAutoSpawn?: (epic: KanbanEpic) => AutoSpawnDecision;
  /** Classifier override (test seam). Default
   *  {@link classifySpawnFailure} from `src/core/orchd-spawn-classify.ts`. */
  classifyFailure?: (stderr: string) => SpawnFailureClass;
  /** Logger (info/warn/error). Defaults to a no-op shim. */
  logger?: Logger;
  /** Clock — unix epoch seconds. Default wall clock. */
  nowSec?: () => number;
}

/** Threshold for emitting the `host-pressure-deferred` flag per ADR-231
 *  §D5 ("if counter ≥3 across consecutive attempts"). Exported for tests
 *  + future per-team tuning. */
export const HOST_PRESSURE_DEFERRED_FLAG_THRESHOLD = 3;

/**
 * Build the spawn-epic handler bound to `deps`. Returns the
 * `(event) => Promise<SpawnEpicHandlerOutcome>` closure that the
 * orchd-bootstrap wrapper adapts to the registry's
 * `(event: EventPayload) => Promise<void>` contract.
 *
 * The handler is the canonical impl for both event-driven primary
 * (subscriber) AND cron-driven backstop (`orchd --sweep` walker via
 * the `spawnEpicHandler` dep — same factory, different invoker).
 */
export function createSpawnEpicHandler(
  deps: SpawnEpicHandlerDeps,
): (event: { epicId: string }) => Promise<SpawnEpicHandlerOutcome> {
  const spawnFn = deps.spawn ?? defaultSpawn;
  const eligibilityCheck = deps.epicIsEligible ?? defaultEpicIsEligible;
  const classify = deps.classifyFailure ?? classifySpawnFailure;
  const resolveAutoSpawn =
    deps.effectiveAutoSpawn ?? ((epic: KanbanEpic) => effectiveAutoSpawn(epic, deps.team));
  const logger = deps.logger ?? NOOP_LOGGER;
  const nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));

  return async (event) => {
    const repo = new KanbanRepo(deps.db);

    // (1) Load epic.
    const epic = repo.getEpic(event.epicId);
    if (epic === null) {
      logger.info(`orchd-spawn: epic=${event.epicId} row missing — skip`);
      return "skipped-row-missing";
    }

    // (2) Dedup gate.
    if (epic.spawnedAt !== null && epic.spawnedAt !== undefined) {
      logger.info(
        `orchd-spawn: epic=${event.epicId} already spawned at ${epic.spawnedAt} — skip`,
      );
      return "skipped-already-spawned";
    }

    // (3) autoSpawn gate.
    const decision = resolveAutoSpawn(epic);
    if (!decision.enabled) {
      logger.info(`orchd-spawn: epic=${event.epicId} autoSpawn disabled — skip`);
      return "skipped-autospawn-off";
    }

    // (4) Eligibility gate (ADR-225 predicate). Per-epic forceSpawn
    //     bypasses this in the underlying spawn-epic verb via
    //     `--force` (ADR-225 §predicate), so we still call spawn-epic
    //     when forceSpawn === true — but we DON'T skip here. The
    //     verb's own `--force` handler logs the bypass per ADR-225.
    if (decision.forceSpawn !== true) {
      const eligibility = await eligibilityCheck(deps.atmuxDir, event.epicId);
      if (!eligibility.eligible) {
        logger.info(
          `orchd-spawn: epic=${event.epicId} eligibility predicate held (${eligibility.blockers.join("; ")}) — skip (next event re-fires)`,
        );
        return "skipped-eligibility-race";
      }
    }

    // (5) Spawn. Build argv per ADR-090 §spawn-epic verb signature.
    const argv: string[] = [
      "team",
      "spawn-epic",
      event.epicId,
      "--from",
      deps.team.name,
    ];
    if (decision.roster !== undefined && decision.roster.length > 0) {
      argv.push("--roster", decision.roster);
    }
    if (decision.forceSpawn === true) {
      // ADR-184 host-pressure bypass — exposed as `--force-spawn` on
      // the verb (NOT `--force` which is the ADR-225 eligibility
      // bypass; both are separate flags per the verb's parser).
      argv.push("--force-spawn");
    }

    let result: SpawnResult;
    try {
      result = await spawnFn({
        cmd: "atmux",
        argv,
        cwd: deps.atmuxDir,
        expectExitCode: "any",
        timeoutMs: 120_000, // submodule init + worktree provision can
                           // take >30s on sopx-style trees per
                           // ATMUX_SPAWN_TIMEOUT_MS rationale.
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`orchd-spawn: epic=${event.epicId} spawn threw: ${msg} — raising hard flag`);
      await writeSpawnFailedExtra(repo, epic, nowSec(), `spawn threw: ${msg}`);
      await raiseHardFlag(spawnFn, event.epicId, `spawn threw: ${msg}`);
      return "flag-raised";
    }

    if (result.exitCode === 0) {
      // (6a) Stamp `spawned_at = unixepoch()` per ADR-231 §D2 dedup
      //      gate. Bun:sqlite parameter is the unix-epoch-seconds
      //      computed from `nowSec()` for test reproducibility.
      const t = nowSec();
      deps.db.prepare("UPDATE epics SET spawned_at = ? WHERE id = ?").run(t, event.epicId);
      logger.info(`orchd-spawn: epic=${event.epicId} spawned at ${t}`);
      return "spawned";
    }

    // Non-zero exit — classify via t-13's pure helper.
    const stderrTail = tail500(result.stderr || result.stdout);
    const failClass = classify(result.stderr);
    if (failClass === "eligibility-race") {
      logger.info(
        `orchd-spawn: epic=${event.epicId} eligibility-race transient — silent skip (next event re-fires)`,
      );
      return "skipped-eligibility-race";
    }

    if (failClass === "host-pressure") {
      // (6b) Increment spawnPressureDeferred counter; emit flag at ≥3.
      const counter = await incrementSpawnPressureDeferred(repo, epic);
      logger.info(
        `orchd-spawn: epic=${event.epicId} host-pressure deferred (counter=${counter}/${HOST_PRESSURE_DEFERRED_FLAG_THRESHOLD}); cron --sweep retries`,
      );
      if (counter >= HOST_PRESSURE_DEFERRED_FLAG_THRESHOLD) {
        await raiseHostPressureDeferredFlag(spawnFn, event.epicId, counter, stderrTail);
      }
      return "skipped-host-pressure";
    }

    // (6c) Hard failure — write spawnFailed extra + flag + NO retry.
    await writeSpawnFailedExtra(repo, epic, nowSec(), stderrTail);
    await raiseHardFlag(spawnFn, event.epicId, stderrTail);
    logger.warn(
      `orchd-spawn: epic=${event.epicId} HARD failure (exit=${result.exitCode}) — flag raised, no retry`,
    );
    return "flag-raised";
  };
}

// ---------- Helpers: extra-column persistence + flag emission ----------

/** Persist `extra.spawnFailed = { at, stderrTail }` per ADR-231 §D5
 *  hard-failure column. Reads + merges the existing `extra` object to
 *  preserve sibling keys (`autoSpawn`, future per-epic config). */
async function writeSpawnFailedExtra(
  repo: KanbanRepo,
  epic: KanbanEpic,
  atSec: number,
  stderrTail: string,
): Promise<void> {
  const nextExtra = {
    ...(epic.extra ?? {}),
    spawnFailed: { at: atSec, stderrTail },
  };
  repo.upsertEpic({ ...epic, extra: nextExtra });
}

/** Persist `extra.spawnPressureDeferred += 1` per ADR-231 §D5
 *  transient-host-pressure counter. Returns the post-increment value
 *  so callers can compare against the flag threshold. */
async function incrementSpawnPressureDeferred(
  repo: KanbanRepo,
  epic: KanbanEpic,
): Promise<number> {
  const existing = epic.extra ?? {};
  const existingCounter =
    typeof existing.spawnPressureDeferred === "number" ? existing.spawnPressureDeferred : 0;
  const nextCounter = existingCounter + 1;
  const nextExtra = { ...existing, spawnPressureDeferred: nextCounter };
  repo.upsertEpic({ ...epic, extra: nextExtra });
  return nextCounter;
}

/** Emit `atmux flag add --severity p1 --needs unblock` for a hard
 *  failure. Best-effort — swallows spawn errors (handler outcome
 *  already says flag-raised; redundant exception would dirty logs). */
async function raiseHardFlag(
  spawnFn: typeof defaultSpawn,
  epicId: string,
  stderrTail: string,
): Promise<void> {
  const body =
    `orchd-spawn: HARD failure for epic=${epicId} — see extra.spawnFailed for receipt\n` +
    `stderr tail:\n${stderrTail}`;
  try {
    await spawnFn({
      cmd: "atmux",
      argv: ["flag", "add", body, "--severity", "p1", "--needs", "unblock"],
      expectExitCode: "any",
      timeoutMs: 10_000,
    });
  } catch {
    // best-effort
  }
}

/** Emit `atmux flag add --severity p1 --needs context` for host-
 *  pressure deferred ≥ threshold. ADR-231 §D5: distinct from hard-
 *  failure flag so operator triage stays separated ("wait for capacity
 *  OR raise the cap" vs "look at the config"). */
async function raiseHostPressureDeferredFlag(
  spawnFn: typeof defaultSpawn,
  epicId: string,
  counter: number,
  stderrTail: string,
): Promise<void> {
  const body =
    `orchd-spawn: host-pressure-deferred for epic=${epicId} (counter=${counter}) — wait for capacity OR raise ADR-184 host-wide cap\n` +
    `stderr tail:\n${stderrTail}`;
  try {
    await spawnFn({
      cmd: "atmux",
      argv: ["flag", "add", body, "--severity", "p1", "--needs", "context"],
      expectExitCode: "any",
      timeoutMs: 10_000,
    });
  } catch {
    // best-effort
  }
}

function tail500(s: string): string {
  if (s.length <= 500) return s;
  return s.slice(-500);
}
