// ADR-005 + ADR-052: Zod schema for `<atmuxDir>/state/eternal-improvement.json`.
//
// Bash-shared schema per the carve-out documented in
// `src/schema/README.md` § "Burn-in compatibility: bash-shared schemas".
// Both `lib/improve.sh` (bash) and `src/core/eternal-improvement.ts` (TS)
// read AND write this file during the burn-in window, so this schema
// OMITS `schemaVersion` per ADR-016 (Phase 6 introduces versioning
// post-bash-decommission).
//
// Source-of-truth for shape: ADR-052 §State-file-schema. Fields:
//
//   - `active`            — false between runs (file persists for audit).
//   - `runId`             — `ei-<8-hex>`, new per `atmux improve` invocation.
//   - `startedAt`         — epoch seconds (UTC); set at run start.
//   - `mode`              — "user-invoked" | "idle-fallback".
//   - `budgetSpec`        — raw spec string as resolved (e.g. "30%-wk").
//   - `budgetTotal`       — tokens, computed at start.
//   - `budgetRemaining`   — tokens, decremented per cycle.
//   - `cycleN`            — cycle counter (1-indexed).
//   - `currentCycle`      — in-flight cycle data, OR null between cycles.
//   - `lastCycleClosedAt` — epoch seconds; null on first cycle.
//   - `history`           — append-only ring; ADR caps at 50 entries.
//
// `.passthrough()` matches the inbox/team/kanban posture — bash may write
// fields the TS port hasn't modeled yet (e.g. `currentCycle.paused: true`
// per ADR-052 §Termination), and strict-rejection would break parity.

import { z } from "zod";

// ---------- Per-cycle shape ----------

/**
 * In-flight cycle. ADR-052 §State-file-schema:
 *   { startedAt, tasksLanded[], tasksDispatched[], tasksDone[], tokensSpent }
 *
 * `tokensSpent` is a running tally finalized when the cycle closes.
 * `paused` is added by §Termination's mid-run preempt path; modeled
 * optional + permissive so bash can flip it without breaking TS parsing.
 */
export const EternalImprovementCurrentCycle = z
  .object({
    /** Epoch seconds (UTC) at cycle start. */
    startedAt: z.number().int().nonnegative(),
    /** Task IDs created by the planner this cycle. */
    tasksLanded: z.array(z.string()),
    /** Task IDs the lead has dispatched to members this cycle. */
    tasksDispatched: z.array(z.string()),
    /** Task IDs completed (`done`) this cycle. */
    tasksDone: z.array(z.string()),
    /** Running tally of tokens spent this cycle (finalized at close). */
    tokensSpent: z.number().int().nonnegative(),
    /** Mid-run preempt flag — true when driver Tasks land mid-cycle.
     *  ADR-052 §Termination "set `currentCycle.paused: true`". */
    paused: z.boolean().optional(),
  })
  .passthrough();
export type EternalImprovementCurrentCycle = z.infer<typeof EternalImprovementCurrentCycle>;

// ---------- Per-history-entry shape ----------

/**
 * One closed-cycle history entry. ADR-052 §State-file-schema:
 *   { cycleN, startedAt, closedAt, tasksLanded, tasksDone, tokensSpent }
 *
 * `tasksLanded` / `tasksDone` are COUNTS in the history ring (not arrays
 * — those live on the active cycle). The array→count compaction keeps
 * the file bounded as the ring grows.
 */
export const EternalImprovementHistoryEntry = z
  .object({
    cycleN: z.number().int().nonnegative(),
    startedAt: z.number().int().nonnegative(),
    closedAt: z.number().int().nonnegative(),
    tasksLanded: z.number().int().nonnegative(),
    tasksDone: z.number().int().nonnegative(),
    tokensSpent: z.number().int().nonnegative(),
  })
  .passthrough();
export type EternalImprovementHistoryEntry = z.infer<typeof EternalImprovementHistoryEntry>;

// ---------- Top-level state file ----------

/**
 * `<atmuxDir>/state/eternal-improvement.json` shape.
 *
 * `mode` accepts the two ADR-052 enum values. Wider strings on read are
 * REJECTED — unlike the kanban/inbox tasks which carry free-form `lane`
 * strings, here the value is closed-set + load-bearing for termination
 * semantics (Mode B fires `atmux stop` on exhaustion; Mode A doesn't).
 *
 * Empty / first-run shape: the file is created at first `atmux improve`
 * start by writeState; before that, callers see ENOENT and `readState`
 * returns `null` (parity with `atmux improve --status` printing `{}`).
 */
export const EternalImprovementState = z
  .object({
    /** True during an active run; false between runs. */
    active: z.boolean(),
    /** `ei-<8-hex>`. */
    runId: z.string().min(1),
    /** Epoch seconds (UTC) at run start. */
    startedAt: z.number().int().nonnegative(),
    /** Two enum values per ADR-052. */
    mode: z.enum(["user-invoked", "idle-fallback"]),
    /** Raw spec string as resolved (e.g. `"30%-wk"`, `"50%"`, `"2000000"`). */
    budgetSpec: z.string().min(1),
    /** Tokens, computed at start. */
    budgetTotal: z.number().int().nonnegative(),
    /** Tokens, decremented per cycle. May go negative briefly during the
     *  fully-built mid-cycle overage window (ADR-052 §Loop mechanics). */
    budgetRemaining: z.number().int(),
    /** Cycle counter (1-indexed). 0 before the first cycle starts. */
    cycleN: z.number().int().nonnegative(),
    /** In-flight cycle, OR null between cycles / pre-first-cycle. */
    currentCycle: EternalImprovementCurrentCycle.nullable(),
    /** Epoch seconds; null until the first cycle closes. */
    lastCycleClosedAt: z.number().int().nonnegative().nullable(),
    /** Append-only ring; ADR-052 caps at 50 entries (oldest dropped). */
    history: z.array(EternalImprovementHistoryEntry),
  })
  .passthrough();
export type EternalImprovementState = z.infer<typeof EternalImprovementState>;
