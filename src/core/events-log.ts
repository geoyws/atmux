// Events log — one JSONL line per verb invocation at
// `<atmuxDir>/logs/<YYYY>/<MM>/events.jsonl`. Single observability surface
// for atmux-dashboard / forensics / superdoctor velocity sweeps.
//
// Refs: kanban t-91cd050f. Driver chat 2026-05-09 — "good recommendations
// for logging n monitoring? maybe we can build that into the atmux-dashboard"
// + "logs filed into year/month folders for ease of archiving as well and
// truncating".
//
// V1 SCOPE (this commit):
//   ✅ `VerbEvent` shape + `appendVerbEvent(atmuxDir, event)` writer
//   ✅ Year/month bucket resolution + idempotent mkdir-p
//   ✅ JSONL line atomicity via single appendFile call (node fs guarantees
//      atomic for writes ≤ PIPE_BUF, typically 4096 bytes — well above the
//      ~300-byte typical event payload)
//   ✅ `wrapDispatchWithEventLog(main, dispatch)` helper for cli.ts —
//      times the dispatch, builds the event, fires append (best-effort)
//   ✅ Soft-degrade: any append failure → caller-supplied stderr WARN +
//      verb still completes. Events are observability, not load-bearing
//      state.
//   ✅ Skip when atmuxDir resolves to a path that does NOT exist on disk
//      (no team yet — first run / `init` against an empty cwd).
//
// V1 OUT OF SCOPE (separate follow-up tasks):
//   ⏸  `atmux groom --archive` gzip step — folds into t-8287b37d (archival
//      stack). V1 leaves uncompressed monthly files; gzip lands later.
//   ⏸  Dashboard reads (tail -F + jq aggregations) — t-91cd050f task body
//      defers UI changes to a separate follow-up.
//   ⏸  Schema versioning — JSONL is forward-compatible; readers ignore
//      unknown fields. Add a `schemaVersion` field only when a breaking
//      shape change ships.
//   ⏸  Per-verb `extra` field injection — schema accepts the field but no
//      verb populates it yet. Verb-side enrichment hooks land per-verb.

import { join } from "node:path";
import { appendText } from "../abstractions/fs.ts";
import { logsDir } from "./common.ts";

/**
 * Single event-log record. JSONL serialization shape matches the schema
 * documented in t-91cd050f task body verbatim:
 *
 * ```jsonc
 * {
 *   "ts": 1715290000,           // epoch seconds
 *   "verb": "dispatch",
 *   "args": ["alpha", "..."],   // argv POST flag-parsing (caller-supplied)
 *   "outcome": "ok",            // ok | error | warn
 *   "duration_ms": 142,
 *   "exit": 0,
 *   "member": "alpha",          // optional
 *   "team": "atmux",
 *   "extra": {}                 // verb-specific; absent when empty
 * }
 * ```
 *
 * `ts` is epoch seconds (NOT milliseconds) to match the bash convention
 * used elsewhere in atmux state files (see `core/heartbeat.ts`,
 * `core/budget-history.ts`). `durationMs` carries the sub-second
 * resolution separately.
 */
export interface VerbEvent {
  /** Epoch seconds at verb completion. */
  ts: number;
  /** Top-level verb name as dispatched (`"task"`, `"claim"`, `"team"`, etc.).
   *  Sub-verbs (e.g. `task add`) land in `args[0]`, not concatenated here. */
  verb: string;
  /** argv slice AFTER the verb name — what the dispatcher would slice off
   *  for the verb's own parser. */
  args: ReadonlyArray<string>;
  /** Three-state verdict: `"ok"` (exit 0), `"warn"` (non-zero exit, no
   *  throw), `"error"` (threw). Mirrors the dispatch outcome lattice. */
  outcome: "ok" | "warn" | "error";
  /** Wall-clock duration `dispatch()` took, milliseconds. */
  durationMs: number;
  /** BSD sysexit code (0, 64, 78, etc.). */
  exit: number;
  /** Optional — populated when the verb operates on a specific member
   *  (`dispatch <member>`, `claim --as <member>`, etc.). Caller supplies
   *  via the verb-side enrichment hook (not auto-derived in V1). */
  member?: string;
  /** Team name from team.json. Empty string when atmuxDir exists but
   *  team.json doesn't (pre-init partial state) — schema-tolerant. */
  team: string;
  /** Verb-specific structured fields. Absent in V1; reserved for later
   *  per-verb enrichment. */
  extra?: Record<string, unknown>;
}

// ---------- Bucket resolution ----------

/** Map epoch milliseconds → `<atmuxDir>/logs/<YYYY>/<MM>/events.jsonl`.
 *  Pure function — exported so tests can pin time without invoking the
 *  writer.
 *
 *  Bucket boundaries use **UTC** (not local time) so cross-machine logs
 *  agree on which monthly file a near-midnight event belongs to. Local-
 *  time would race on DST transitions + machine-timezone changes. */
export function eventsLogPathFor(atmuxDir: string, epochMs: number): string {
  const d = new Date(epochMs);
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return join(logsDir(atmuxDir), yyyy, mm, "events.jsonl");
}

// ---------- Serialization ----------

/** Pure: stringify a `VerbEvent` to its single-line JSONL form (with
 *  trailing newline). Schema field order matches the task-body example;
 *  json field order doesn't matter for forward-compat (readers consume
 *  by key) but keeping it stable makes greps + diffs predictable.
 *
 *  Fields with the conventional snake_case spec name (`duration_ms`) are
 *  emitted snake-case on the wire even when the TS shape uses camelCase
 *  (`durationMs`). Spec parity is on the wire format. */
export function serializeEvent(event: VerbEvent): string {
  const out: Record<string, unknown> = {
    ts: event.ts,
    verb: event.verb,
    args: [...event.args],
    outcome: event.outcome,
    duration_ms: event.durationMs,
    exit: event.exit,
    team: event.team,
  };
  if (typeof event.member === "string" && event.member.length > 0) {
    out.member = event.member;
  }
  if (event.extra !== undefined && Object.keys(event.extra).length > 0) {
    out.extra = event.extra;
  }
  return `${JSON.stringify(out)}\n`;
}

// ---------- Append (side-effect) ----------

/**
 * Append a single JSONL line to the current month's events file. Creates
 * the year/month folder if absent (via `appendText`'s `ensureDir`).
 *
 * `epochMsForBucket` defaults to `Date.now()` — exported as an opt so
 * tests can pin a deterministic bucket without monkey-patching Date.
 *
 * Throws `FsError` on disk failure (caller decides whether to swallow).
 * `safeAppendVerbEvent` is the soft-degrade wrapper that callers should
 * use unless they specifically need to propagate the error.
 */
export async function appendVerbEvent(
  atmuxDir: string,
  event: VerbEvent,
  opts: { epochMsForBucket?: number } = {},
): Promise<void> {
  const epochMs = opts.epochMsForBucket ?? Date.now();
  const path = eventsLogPathFor(atmuxDir, epochMs);
  await appendText(path, serializeEvent(event));
}

/**
 * Soft-degrade wrapper for `appendVerbEvent`. Any append failure (disk
 * full, permissions, parent dir creation race) emits a single stderr
 * WARN line and resolves — the calling verb still completes.
 *
 * Mirrors the `safeFireDiscord` pattern in `verbs/improve.ts` — best-
 * effort observability sites should never block the verb's exit path.
 */
export async function safeAppendVerbEvent(
  atmuxDir: string,
  event: VerbEvent,
  stderr: (s: string) => unknown = (s) => process.stderr.write(s),
  opts: { epochMsForBucket?: number } = {},
): Promise<void> {
  try {
    await appendVerbEvent(atmuxDir, event, opts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    stderr(`atmux: events-log: append skipped (best-effort): ${msg}\n`);
  }
}
