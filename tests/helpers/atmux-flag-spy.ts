// ADR-231 §D2/§D5 — `atmux flag add` capture for Phase 2 handler unit
// tests (S3.1, t-16-27fdc08b).
//
// Per ADR-231 §D5:
//   - Hard failure → handler calls `atmux flag add "orchd: spawn failed
//     for epic <eid>: <stderrTail>"`.
//   - Host-pressure deferred ≥3 times → handler emits a SEPARATE
//     `host-pressure-deferred` flag so operator triage diverges from
//     hard-failure triage.
//   - Eligibility-race → silent (no flag).
//
// Tests inject this spy as the production handler's `flagAdd` seam,
// then assert on call count / arguments to verify the right flag was
// (or wasn't) emitted for each scenario.

/** Severity tier used by `atmux flag add`. Member-brief §When to flag
 *  documents p0 (Discord ping) / p1+p2 (kanban-visible). */
export type FlagSeverity = "p0" | "p1" | "p2";

/** "Needs" classifier passed via `--needs` — operator-triage hint. */
export type FlagNeeds = "unblock" | "decision" | "context" | string;

/** Recorded flag-add call — every field the production caller passed. */
export interface FlagCall {
  /** The flag message body. */
  readonly message: string;
  /** Severity tier. `undefined` when caller omitted `--severity`. */
  readonly severity?: FlagSeverity;
  /** `--needs <tag>` classifier; `undefined` when omitted. */
  readonly needs?: FlagNeeds;
  /** `--task <id>` linkage; `undefined` when omitted. Used by the
   *  `host-pressure-deferred` path which links the affected epic's
   *  spawn task per the future spawn-epic Task linkage in ADR-231 §D2. */
  readonly taskId?: string;
  /** Sequence (1-based) in invocation order. */
  readonly sequence: number;
}

/** Argument shape passed by the production handler — mirrors the
 *  `atmux flag` CLI surface so the spy can be a drop-in seam. */
export interface FlagAddArgs {
  readonly message: string;
  readonly severity?: FlagSeverity;
  readonly needs?: FlagNeeds;
  readonly taskId?: string;
}

/** The spy. Construct with {@link createFlagSpy}. */
export interface FlagSpy {
  /** Production seam — handler calls `await flagAdd({ message, ... })`
   *  in place of shelling out to `atmux flag add`. Returns a resolved
   *  promise (matches the real CLI's success path); throw-on-error
   *  is not modeled here because the production handler treats
   *  flag-add failures as best-effort (mirrors the same posture as
   *  the events emit path in src/abstractions/events.ts). */
  add(args: FlagAddArgs): Promise<void>;
  /** Read-only list of every recorded call, in invocation order. */
  readonly calls: ReadonlyArray<FlagCall>;
  /** Find calls whose message matches `predicate`. Sugar for
   *  `spy.calls.filter(c => c.message.includes("..."))`. */
  findByMessage(predicate: string | RegExp): ReadonlyArray<FlagCall>;
  /** Drop every recorded call. */
  reset(): void;
}

/**
 * Construct a fresh flag spy. Defaults to a no-throw `.add()` that
 * records the call + returns immediately.
 *
 * @example
 *   const flags = createFlagSpy();
 *   await spawnEpicHandler({ epicId: "e-x" }, { flagAdd: flags.add });
 *   expect(flags.calls).toHaveLength(1);
 *   expect(flags.calls[0].message).toMatch(/orchd: spawn failed/);
 */
export function createFlagSpy(): FlagSpy {
  const calls: FlagCall[] = [];

  return {
    calls,

    async add(args: FlagAddArgs): Promise<void> {
      calls.push({
        message: args.message,
        severity: args.severity,
        needs: args.needs,
        taskId: args.taskId,
        sequence: calls.length + 1,
      });
    },

    findByMessage(predicate: string | RegExp): ReadonlyArray<FlagCall> {
      if (predicate instanceof RegExp) {
        return calls.filter((c) => predicate.test(c.message));
      }
      return calls.filter((c) => c.message.includes(predicate));
    },

    reset(): void {
      calls.length = 0;
    },
  };
}
