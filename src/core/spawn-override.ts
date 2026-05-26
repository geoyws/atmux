// ADR-225 §spawn-epic gate + --force override (T5 / t-1fbd2aa4):
// append-only audit log for `atmux team spawn-epic <eid> --force`
// driver-scope overrides of the eligibility gate.
//
// Why an audit log: --force bypasses the predicate (`epicIsEligible`)
// that protects against accidental auto-spawn on draft epics or epics
// with unmet deps. A bypass is auditable + Discord-surfaced
// (`[spawn-force]` template, parallel to ADR-144 §T5 test-gate-bypass)
// so it can't land silently. The log lives under `$HOME/.atmux/state/`
// (fleet-level, not per-team) per the same precedent ADR-144 sets —
// siblings to `test-gate-bypasses.log` and ADR-138 §"Escalation log".
//
// Format mirrors test-gate-bypasses.log: one JSONL line per override
// with epoch-seconds + UTC ISO timestamp + structured payload.

import { homedir } from "node:os";
import { join } from "node:path";
import { appendText } from "../abstractions/fs.ts";

/** Relative path under `$HOME`. ADR-225 §Eligibility consumers §
 *  spawn-epic. Sibling to test-gate-bypasses.log. */
export const DEFAULT_SPAWN_OVERRIDES_LOG_REL = ".atmux/state/spawn-overrides.log";

/** One override-event payload. Records the eligibility blockers that
 *  the operator overrode, the epic + parent team they overrode for,
 *  and caller identity (member + scope) for the audit trail. */
export interface SpawnOverrideRecord {
  /** Epic-team kanban id (`e-XXXXXXXX` or `e-N-XXXXXXXX`) targeted. */
  epicId: string;
  /** Parent team name (`team.json:.name` of the parent the operator
   *  is spawning the epic under). */
  team: string;
  /** Eligibility blockers as returned by `epicIsEligible(...).blockers`
   *  at the moment of override. Stored verbatim so a later auditor can
   *  reconstruct what the operator chose to ignore. */
  blockers: string[];
  /** Caller member identity (e.g. `$ATMUX_MEMBER` if set; `"unknown"`
   *  when invoked outside an atmux pane). */
  callerMember: string;
  /** Caller scope per ADR-033 — typically `"driver"` since the
   *  spawn-epic verb refuses non-driver scopes upstream. Captured here
   *  for the audit trail. */
  callerScope: string;
}

/** Defaults + test-injection seam. Mirrors LogTestGateBypassOpts. */
export interface LogSpawnOverrideOpts {
  /** Override `$HOME` — default `os.homedir()`. Tests pass a `mkdtemp`
   *  scratch path so the production log is never touched. */
  homeDir?: string;
  /** Override `Date.now()` — default `Date.now()`. Tests pin to a
   *  fixed value for reproducible `ts` columns. */
  now?: () => number;
}

/** One JSONL line. epoch-seconds first for cheap `awk`/`jq` filtering,
 *  then ISO timestamp for human scan, then the structured payload. */
interface OverrideLogLine extends SpawnOverrideRecord {
  ts: number;
  iso: string;
}

/**
 * Append one override record to `$HOME/.atmux/state/spawn-overrides.log`
 * as a JSONL line. Creates the file + parent dir on first call
 * (`appendText` ensures-parent-dir). Idempotent — bash `>> file`
 * semantics; no read-modify-write race.
 *
 * Why JSONL: matches ADR-138 + ADR-144 logger precedent. The
 * `[spawn-force]` Discord template (operator-side) reads recent lines
 * for cross-event dedup; structured JSON keeps the parse trivial.
 *
 * Errors propagate via appendText's typed-error wrapping — disk-full
 * / permission-denied surface up the call stack. The override MUST
 * NOT silently succeed if the audit trail fails to record.
 */
export async function logSpawnOverride(
  record: SpawnOverrideRecord,
  opts: LogSpawnOverrideOpts = {},
): Promise<void> {
  const home = opts.homeDir ?? homedir();
  const now = opts.now ?? Date.now;
  const t = now();
  const ts = Math.floor(t / 1000);
  const iso = new Date(t).toISOString();
  const line: OverrideLogLine = {
    ts,
    iso,
    epicId: record.epicId,
    team: record.team,
    blockers: record.blockers,
    callerMember: record.callerMember,
    callerScope: record.callerScope,
  };
  const path = join(home, DEFAULT_SPAWN_OVERRIDES_LOG_REL);
  await appendText(path, `${JSON.stringify(line)}\n`);
}

/** Discord payload contract for the `[spawn-force]` ping. Operator
 *  side renders this into the Discord channel via the same plumbing
 *  ADR-144 §T5 uses for `[test-gate-bypass]`. Kept here so the verb's
 *  injection seam has a typed value (vs. `unknown`). */
export interface SpawnForceDiscordPayload {
  topic: "spawn-force";
  epicId: string;
  team: string;
  blockers: string[];
  callerMember: string;
  callerScope: string;
}

/** Discord injection seam — production caller wires in the real
 *  channel publisher; tests pass a mock to assert the call shape. */
export type SpawnForceDiscordFn = (payload: SpawnForceDiscordPayload) => Promise<void>;
