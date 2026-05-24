// ADR-231 §D4: orchd `--sweep` walker (cron backstop). Closes the
// at-least-once delivery gap for the two-trigger model — event-driven
// handlers (`epic.ready` / `epic.unblocked` for spawn, `task.done` for
// solo-worker dissolve) are the PRIMARY trigger; this sweep is the
// SECONDARY backstop that catches missed events (Honker offset
// rollback, restart-mid-handler, transient host-pressure deferrals).
// Mirrors ADR-134 §Triggers' event-driven + cron-backstop pattern
// verbatim.
//
// **Handler-reuse invariant** (AC line: "Reuses handlers — does NOT
// duplicate eligibility/dedup/autoSpawn logic"): the walker walks
// candidate rows + applies the cheap pre-filter predicates (dedup
// gate per §D2, autoSpawn gate per §D3, ADR-225 eligibility), then
// **invokes the canonical handler** for every survivor. It does NOT
// re-implement spawn / dissolve logic. The handlers are themselves
// defensive (they re-check dedup + autoSpawn + eligibility) — the
// pre-filter exists only to avoid spinning up the handler on every
// epic when the answer is statically "no".
//
// Scaffolding scope (this Task, t-10-ab3815cf, Story S2.1):
//   - Walker shape + dep-injection seam.
//   - Real call into `epicIsEligible()` (ADR-225, already on trunk).
//   - **STUB** imports for the spawn-side machinery still pending:
//       * `effectiveAutoSpawn(epic)` — §D3 resolver; lands T-S2.5.
//       * `spawnEpicHandler(atmuxDir, epic)` — §D2 spawn handler;
//          lands T-S2.5.
//   - **REAL** import for the dissolve-side: `dissolveSoloWorkerHandler`
//      shipped via t-15-6a65eadb (per ADR-231 §D6) — used directly
//      below; no stub needed.
//   - **STUB** import for `resolveSoloWorkerMembers(atmuxDir)` —
//      enumerates `w-<taskId>` worker-teams from the cockpit-registry
//      walk (per ADR-221 §v2 naming); lands T-S2.6.
//
// Caller wiring (out of scope here, lands in T-S2.2 / T-S2.3):
//   - `atmux orchd --sweep` CLI subverb (T-S2.2).
//   - cron-line emission `*/N * * * * atmux orchd --sweep` (T-S2.3).
//
// Dep-injection: every cross-module call goes through `OrchdSweepDeps`
// so tests can stub each surface independently. Production callers
// pass `{}` and accept the defaults (real `listEpics` + real
// `epicIsEligible` + stub spawn/dissolve seam until T-S2.5 / T-S2.6).

import { epicIsEligible, listEpics } from "./epic.ts";
import type { KanbanEpic } from "../schema/kanban.ts";

// ---------- Stub seams (T-S2.5 / T-S2.6 land the real impls) ----------

/**
 * §D3 resolver — returns the effective auto-spawn decision for one
 * epic. Reads per-epic `extra.autoSpawn.enabled` (explicit wins) →
 * falls back to per-team `team.json::autoSpawn.defaults[].match`
 * regex against `epic.title` (T-S1.3 shipped this Zod shape).
 *
 * **STUB until T-S2.5** (`src/core/orchd-spawn.ts::effectiveAutoSpawn`).
 * Returning `false` here means the walker skips every epic — safe no-
 * op pre-T-S2.5. Tests inject a real resolver via
 * {@link OrchdSweepDeps.effectiveAutoSpawn}.
 */
function defaultEffectiveAutoSpawn(_epic: KanbanEpic): boolean {
  // T-S2.5 IMPL TODO: resolve from epic.extra.autoSpawn.enabled (per-
  // epic explicit) → fall back to per-team
  // `team.json::autoSpawn.defaults[].match` regex match against
  // epic.title → final fallback `false`. Documented in ADR-231 §D3
  // step-list. Lands at `src/core/orchd-spawn.ts::effectiveAutoSpawn`.
  return false;
}

/**
 * §D2 spawn handler — invokes `atmux team spawn-epic <epicId>` with
 * the resolved roster + `--force` per `extra.autoSpawn.forceSpawn`.
 * On exit 0 stamps `epics.spawned_at = unixepoch()` per the dedup
 * gate (column shipped via t-6-8db78adf v15→v16 migration). On exit
 * non-zero classifies via `classifySpawnFailure` (already shipped,
 * t-13) → emits a flag (HARD / HOST-PRESSURE) or silent skip
 * (ELIGIBILITY-RACE).
 *
 * **STUB until T-S2.5** (`src/core/orchd-spawn.ts::spawnEpicHandler`).
 * Returns `"skipped"` here so the walker reports the right counter
 * shape — production callers (cron) get zero `epicsSpawned` until
 * T-S2.5 lands, but the dispatch path is exercised so smoke tests
 * stay meaningful.
 */
async function defaultSpawnEpicHandler(
  _atmuxDir: string,
  _epic: KanbanEpic,
): Promise<"spawned" | "skipped" | "flag-raised"> {
  // T-S2.5 IMPL TODO: build spawn-epic argv from epic.extra.autoSpawn
  // (resolve roster fallback chain; pass --force on
  // extra.autoSpawn.forceSpawn); spawn via abstractions/spawn.ts;
  // classify exit via classifySpawnFailure; on success stamp
  // `UPDATE epics SET spawned_at = unixepoch() WHERE id = ?`. Lands
  // at `src/core/orchd-spawn.ts::spawnEpicHandler`.
  return "skipped";
}

/**
 * Worker enumeration — returns the list of `w-<taskId>` team names
 * registered in cockpit-json (per ADR-221 §v2 naming convention).
 * Solo-workers are distinguished from regular teams by the `w-`
 * prefix per `isSoloWorkerTeamName()` (`src/core/solo-worker.ts`, be-1
 * t-15).
 *
 * **STUB until T-S2.6** (`src/core/orchd-spawn.ts::resolveSoloWorkerMembers`
 * or wherever T-S2.6 lands the cockpit-walk). Returns empty list
 * here so the walker reports zero `workersConsidered` pre-T-S2.6 —
 * safe no-op.
 */
async function defaultResolveSoloWorkerMembers(_atmuxDir: string): Promise<ReadonlyArray<string>> {
  // T-S2.6 IMPL TODO: walk cockpit.json sessions[] tree; collect
  // entries where `isSoloWorkerTeamName(session.name) === true`; return
  // their names. Solo-workers are top-level cockpit entries (not
  // epic-team children) per ADR-221 §v2 deployment shape.
  return [];
}

/**
 * Per-worker dissolve dispatcher — invokes the canonical
 * `dissolveSoloWorkerHandler` (be-1 t-15, ADR-231 §D6) for the worker
 * if its remaining tasks are all done. Returns the handler outcome
 * directly so the walker's counters reflect handler verdicts (no
 * duplicate eligibility logic in the walker).
 *
 * **STUB until T-S2.6** for the actual all-tasks-done check + handler
 * invocation. The dissolve handler itself is REAL (shipped) — the
 * stub is just for the walker-side wiring (per-worker task
 * enumeration + handler factory bind).
 */
async function defaultConsiderSoloWorker(
  _atmuxDir: string,
  _workerTeamName: string,
): Promise<"dissolved" | "skipped" | "escalated"> {
  // T-S2.6 IMPL TODO: open the worker's state.db; query for any task
  // status != done; if zero, build createDissolveSoloWorkerHandler({db})
  // + synthesize a TaskDonePayload for the last-done task + invoke
  // handler. Map outcome → walker counter.
  return "skipped";
}

// ---------- Public surface ----------

/** Result shape of one `orchdSweep` tick. Counters are walker-side
 *  observations — what the walker SAW, not just what the handler did.
 *  `*Considered` counts every row the walker visited (post-filter);
 *  `*Spawned` / `*Dissolved` count rows where the handler reported
 *  a positive outcome. The delta surfaces operator-visible "considered
 *  but skipped" cases (handler refused at its defensive re-check). */
export interface OrchdSweepResult {
  epicsConsidered: number;
  epicsSpawned: number;
  workersConsidered: number;
  workersDissolved: number;
}

/** Test-injection seam. Production callers pass `{}` and accept the
 *  defaults (real `listEpics` + real `epicIsEligible` + stubbed spawn /
 *  dissolve seams until T-S2.5 / T-S2.6 land). Tests pin each surface
 *  for deterministic counter assertions. */
export interface OrchdSweepDeps {
  /** Override the epic enumeration (test seam — production uses the
   *  real `listEpics(atmuxDir)`). */
  listEpics?: typeof listEpics;
  /** Override the ADR-225 eligibility check. Production uses the real
   *  `epicIsEligible` (already on trunk via parent fan-in 4870833). */
  epicIsEligible?: typeof epicIsEligible;
  /** §D3 resolver — `effectiveAutoSpawn(epic)`. Defaults to the stub
   *  ({@link defaultEffectiveAutoSpawn}) until T-S2.5. */
  effectiveAutoSpawn?: (epic: KanbanEpic) => boolean;
  /** §D2 spawn handler — `spawnEpicHandler(atmuxDir, epic)`. Defaults
   *  to the stub ({@link defaultSpawnEpicHandler}) until T-S2.5. */
  spawnEpicHandler?: (
    atmuxDir: string,
    epic: KanbanEpic,
  ) => Promise<"spawned" | "skipped" | "flag-raised">;
  /** Worker enumeration. Defaults to the stub
   *  ({@link defaultResolveSoloWorkerMembers}) until T-S2.6. */
  resolveSoloWorkerMembers?: (atmuxDir: string) => Promise<ReadonlyArray<string>>;
  /** Per-worker dissolve dispatcher. Defaults to
   *  {@link defaultConsiderSoloWorker} until T-S2.6. */
  considerSoloWorker?: (
    atmuxDir: string,
    workerTeamName: string,
  ) => Promise<"dissolved" | "skipped" | "escalated">;
}

/**
 * Run one sweep tick. Algorithm per ADR-231 §D4:
 *
 *   1. Walk every epic via `listEpics(atmuxDir)`.
 *   2. Pre-filter (CHEAP — all walker-side):
 *        a. Dedup gate (§D2): skip rows where `spawnedAt` is set.
 *        b. autoSpawn gate (§D3): skip rows where
 *           `effectiveAutoSpawn(epic) === false`.
 *        c. Eligibility (ADR-225): skip rows where
 *           `epicIsEligible(atmuxDir, epic.id).eligible === false`.
 *   3. Invoke `spawnEpicHandler(atmuxDir, epic)` for survivors. The
 *      handler is the canonical impl — walker does NOT duplicate its
 *      logic.
 *   4. Walk every solo-worker team via `resolveSoloWorkerMembers`.
 *   5. Invoke `considerSoloWorker(atmuxDir, workerTeamName)` for each.
 *      The handler is the canonical `dissolveSoloWorkerHandler`
 *      (be-1 t-15, ADR-231 §D6) — walker does NOT duplicate its logic.
 *
 * Counters surface the walker's observations + the handler's verdicts
 * separately. Operators read these from the cron-line log + structured
 * Discord summary (lands via T-S2.3).
 *
 * Failure isolation: a thrown handler does NOT halt the walk — it's
 * caught + logged, walker continues with the next candidate. Per
 * ADR-231 anti-retry-storm doctrine, escalation is via flag (handler
 * owns) not retry-loop (walker stays silent on errors beyond counter
 * accounting).
 */
export async function orchdSweep(
  atmuxDir: string,
  deps: OrchdSweepDeps = {},
): Promise<OrchdSweepResult> {
  const list = deps.listEpics ?? listEpics;
  const eligible = deps.epicIsEligible ?? epicIsEligible;
  const autoSpawn = deps.effectiveAutoSpawn ?? defaultEffectiveAutoSpawn;
  const spawnHandler = deps.spawnEpicHandler ?? defaultSpawnEpicHandler;
  const resolveWorkers = deps.resolveSoloWorkerMembers ?? defaultResolveSoloWorkerMembers;
  const considerWorker = deps.considerSoloWorker ?? defaultConsiderSoloWorker;

  let epicsConsidered = 0;
  let epicsSpawned = 0;
  let workersConsidered = 0;
  let workersDissolved = 0;

  // ---------- Epic walk ----------

  const epics = await list(atmuxDir);
  for (const epic of epics) {
    epicsConsidered += 1;

    // (a) Dedup gate per §D2 — `spawnedAt` set means orchd (or an
    //     operator backfill) already spawned this epic-team. Skip.
    if (epic.spawnedAt !== null && epic.spawnedAt !== undefined) continue;

    // (b) autoSpawn gate per §D3 — resolver checks per-epic explicit
    //     setting + per-team defaults fallback.
    if (!autoSpawn(epic)) continue;

    // (c) Eligibility per ADR-225 — predicate is dep-walk + isReady
    //     check.
    const elig = await eligible(atmuxDir, epic.id);
    if (!elig.eligible) continue;

    // Handler is canonical — walker just invokes + counts.
    try {
      const outcome = await spawnHandler(atmuxDir, epic);
      if (outcome === "spawned") epicsSpawned += 1;
    } catch {
      // Per ADR-231 anti-retry-storm: handler errors do NOT halt the
      // walk + do NOT trigger walker-side retry. Handler owns its own
      // flag/escalation; walker stays silent beyond the counter
      // omission (this epic's row simply isn't counted as `spawned`).
    }
  }

  // ---------- Solo-worker walk ----------

  const workers = await resolveWorkers(atmuxDir);
  for (const workerTeamName of workers) {
    workersConsidered += 1;
    try {
      const outcome = await considerWorker(atmuxDir, workerTeamName);
      if (outcome === "dissolved") workersDissolved += 1;
    } catch {
      // Same isolation as the epic walk — see comment above.
    }
  }

  return { epicsConsidered, epicsSpawned, workersConsidered, workersDissolved };
}
