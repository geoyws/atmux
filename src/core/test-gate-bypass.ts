// ADR-144 §Operator bypass T2 (t-49bd4fe1): append-only audit log
// for `atmux epic-merge advance --to merging --skip-test-gate` driver-
// scope overrides.
//
// Why an audit log: the bypass refuses the test-gate that protects
// parent-trunk integrity (per ADR-144 §Decision). A bypass is
// auditable + Discord-surfaced (`[test-gate-bypass]` template, T5)
// so it can't land silently. The log lives under `$HOME/.atmux/state/`
// (fleet-level, not per-team) per ADR-144 §Operator bypass — siblings
// to ADR-138 §"Escalation log" (`send-keys-failures.log`) and ADR-077
// auditing primitives.
//
// Format mirrors `send-keys-failures.log`: one JSONL line per bypass
// with epoch-seconds + UTC timestamp + structured payload. Operators
// inspect via `jq`. Caller (T5 Discord template) reads the JSONL via
// the same `appendText` primitive's friend `readText`.

import { homedir } from "node:os";
import { join } from "node:path";
import { appendText } from "../abstractions/fs.ts";

/** Relative path under `$HOME` per ADR-144 §Operator bypass. Sibling
 *  to {@link DEFAULT_SEND_KEYS_FAILURES_LOG_REL} from ADR-138 — both
 *  live in the fleet-level `.atmux/state/` directory rather than any
 *  per-team `state.db` so cross-team `gh pr create` bypass attempts
 *  for ADR-090 future pr-mode runtime accumulate to one canonical
 *  audit trail. */
export const DEFAULT_TEST_GATE_BYPASSES_LOG_REL = ".atmux/state/test-gate-bypasses.log";

/** One bypass-event payload. Captures who fired the bypass, against
 *  which epic, target state, and a reason string operators are
 *  required to provide (UX-level — the verb refuses without a
 *  non-empty `--reason <text>` to deter silent bypasses).
 *
 *  `targetState` is captured as a free-form string so this module
 *  stays decoupled from {@link BranchMergeState} — the only valid
 *  target today is `"merging"` (ADR-144 §Operator bypass), but a
 *  future ADR may introduce a bypass for `tested → merged` skip-test-
 *  result-record, etc. The string round-trip keeps the schema flexible. */
export interface TestGateBypassRecord {
  /** Epic-team kanban id (`e-XXXXXXXX`). Matches the `epicId` field
   *  on the `EpicMergeContext` passed to {@link performEpicMerge}. */
  epicId: string;
  /** Epic-team's shared branch name (`<parentBase>-epic-<epicId>`).
   *  PRIMARY KEY into `merger_state` — operators inspecting the log
   *  paired with `atmux status` can correlate via this string. */
  epicBranch: string;
  /** Target state the bypass moved the row to. Today the only valid
   *  target is `"merging"` per ADR-144 §Operator bypass. */
  targetState: string;
  /** Caller-supplied reason (`--reason "<text>"`). Required at the
   *  verb layer — recorded verbatim so the audit trail names the
   *  emergency. */
  reason: string;
  /** Caller identity. Defaults to `$USER` when invoked from a shell;
   *  test-harness injection passes `"test"`. */
  by: string;
}

/** Defaults & test-injection seam. Production callers pass nothing;
 *  unit tests pin `homeDir` to a scratch path + `now` to a fixed
 *  epoch second so the JSONL output is deterministic. */
export interface LogTestGateBypassOpts {
  /** Override `$HOME` — default `os.homedir()`. Tests pass a
   *  `mkdtemp` scratch path so the production log is never touched. */
  homeDir?: string;
  /** Override `Date.now()` — default `Date.now()`. Tests pin to a
   *  fixed value for reproducible `timestamp` columns. */
  now?: () => number;
}

/** One JSONL line. Field order matches the {@link TestGateBypassRecord}
 *  shape — epoch-seconds first for cheap `awk`/`jq` filtering, then
 *  ISO timestamp for human-readable scan, then the structured payload.
 *  Trailing newline is mandatory; appending without it would corrupt
 *  the JSONL frame on the next bypass. */
interface BypassLogLine extends TestGateBypassRecord {
  /** Unix epoch seconds (integer). Frame anchor. */
  ts: number;
  /** ISO 8601 UTC timestamp (e.g. `2026-05-17T09:42:13.000Z`). Human-
   *  scan column. */
  iso: string;
}

/**
 * Append one bypass record to `$HOME/.atmux/state/test-gate-bypasses.log`
 * as a JSONL line. Creates the file + parent dir on first call
 * (`appendText` ensures-parent-dir). Idempotent: bash `>> file` semantics
 * — no read-modify-write race.
 *
 * Why JSONL not free-text: bypass events flow into the Discord
 * `[test-gate-bypass]` template (T5) which reads the last-N lines for
 * the cross-event dedup; structured JSON keeps the parse trivial
 * (vs. regex-extracting fields from a free-text format). Also matches
 * ADR-138 §"Escalation log" format precedent.
 *
 * Errors propagate via `appendText`'s typed-error wrapping — disk-
 * full / permission-denied flow up the call stack so the verb can
 * surface usage-level guidance ("check disk space" / "fix log
 * permissions"). The bypass MUST NOT silently succeed if its audit
 * trail fails to record — the operator's accountability depends on
 * the log landing.
 */
export async function logTestGateBypass(
  record: TestGateBypassRecord,
  opts: LogTestGateBypassOpts = {},
): Promise<void> {
  const home = opts.homeDir ?? homedir();
  const now = opts.now ?? Date.now;
  const t = now();
  const ts = Math.floor(t / 1000);
  const iso = new Date(t).toISOString();
  const line: BypassLogLine = {
    ts,
    iso,
    epicId: record.epicId,
    epicBranch: record.epicBranch,
    targetState: record.targetState,
    reason: record.reason,
    by: record.by,
  };
  const path = join(home, DEFAULT_TEST_GATE_BYPASSES_LOG_REL);
  await appendText(path, `${JSON.stringify(line)}\n`);
}
