// Drift detection + _atmuxSync marker stamping — ADR-164 §"Behavior" step 5
// + §"File shape after sync" + §OQ-1 (top-level passthrough field) + §OQ-5
// (refuse-without-force). T5 (t-c2b757c1).
//
// Drift = the on-disk `.claude/team.json` carries an `_atmuxSync` marker
// whose `sourceFingerprint` no longer matches the file's current member
// roster. That signals a hand-edit between syncs; without `--force` the
// verb refuses (exit 65 / EX_DATAERR) so operators don't silently
// overwrite intentional manual changes. The same pattern as
// ADR-054 §"drift detection" — pattern reuse, not new mechanism.
//
// This module exposes the primitives; the verb dispatcher
// (src/verbs/sync.ts) composes them around the write path. The
// `--dry-run` preview (T6) deliberately does NOT call detectDrift —
// previewing should never abort.

import { createHash } from "node:crypto";
import { join } from "node:path";
import { appendText } from "../../abstractions/fs.ts";
import type { AtmuxSyncMarker, ClaudeTeam, ClaudeTeamMember } from "./types.ts";

/** Top-level passthrough key per ADR-164 §"File shape after sync". */
export const SYNC_MARKER_KEY = "_atmuxSync" as const;

/** Schema revision stamped into the marker on each write. Bumping this
 *  is its own coordination event — the deferred-pending convention in
 *  CLAUDE.md applies (annotated ADR + a migration note). */
export const CURRENT_SCHEMA_REV = "v1" as const;

/** Exit code per ADR-164 §"Behavior" step 5 — EX_DATAERR (BSD sysexits
 *  convention). The CLI dispatcher catches DriftAbortError and routes to
 *  this code. */
export const EX_DATAERR = 65;

/** Canonical JSON serializer — deterministic key order so the fingerprint
 *  is stable across runs / platforms. Recurses into objects + arrays;
 *  primitives serialize the same as JSON.stringify.
 *
 *  Members ARE sorted as the input array — the spec says "post-sync
 *  member roster" which preserves intent order. Within each member,
 *  keys sort lexicographically. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
  return `{${parts.join(",")}}`;
}

/** sha256 hex of the canonical-serialized member roster — `_atmuxSync`
 *  block is OUT of scope per ADR-164 §"Behavior" step 5 (otherwise the
 *  fingerprint would always match the just-stamped marker, defeating
 *  drift detection). */
export function computeFingerprint(members: ReadonlyArray<ClaudeTeamMember>): string {
  const canonical = canonicalize(members);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/** Build a fresh marker block. `lastSyncedAt` is the caller-supplied
 *  ISO-8601 string so tests can pin a deterministic value; production
 *  paths pass `new Date().toISOString()`. */
export function nextMarker(
  members: ReadonlyArray<ClaudeTeamMember>,
  lastSyncedAt: string,
): AtmuxSyncMarker {
  return {
    lastSyncedAt,
    schemaRev: CURRENT_SCHEMA_REV,
    sourceFingerprint: computeFingerprint(members),
  };
}

export interface DriftDetection {
  /** The marker found on disk. */
  priorMarker: AtmuxSyncMarker;
  /** The fingerprint we just computed against the on-disk roster. */
  currentFingerprint: string;
}

/** Compare the on-disk marker to the on-disk roster. Returns:
 *  - `null` when no prior marker exists (fresh-file or never-synced).
 *    Drift is not defined in this case — caller proceeds without
 *    aborting. The first write stamps the initial marker.
 *  - DriftDetection when the marker exists AND the fingerprint
 *    mismatches the file's current roster. */
export function detectDrift(prior: ClaudeTeam | null): DriftDetection | null {
  if (prior === null) return null;
  const marker = prior[SYNC_MARKER_KEY] as AtmuxSyncMarker | undefined;
  if (marker === undefined || typeof marker.sourceFingerprint !== "string") {
    return null;
  }
  const members = Array.isArray(prior.members) ? prior.members : [];
  const currentFingerprint = computeFingerprint(members);
  if (marker.sourceFingerprint === currentFingerprint) return null;
  return { priorMarker: marker, currentFingerprint };
}

/** Thrown by the dispatcher when drift is detected without `--force`.
 *  Carries enough context that the CLI surface can render the 3-line
 *  diff hint per ADR-164 §Behavior step 5. */
export class DriftAbortError extends Error {
  readonly detection: DriftDetection;
  readonly hint: string;
  constructor(detection: DriftDetection) {
    const hint = formatDriftHint(detection);
    super(`drift detected — refusing without --force\n${hint}`);
    this.name = "DriftAbortError";
    this.detection = detection;
    this.hint = hint;
  }
}

/** Three-line diff hint surfaced on the abort path. Operators see
 *  enough to decide whether `--force` is appropriate without us emitting
 *  the full file. */
export function formatDriftHint(detection: DriftDetection): string {
  return [
    `  prior fingerprint:   ${detection.priorMarker.sourceFingerprint}`,
    `  current fingerprint: ${detection.currentFingerprint}`,
    `  last synced at:      ${detection.priorMarker.lastSyncedAt}`,
  ].join("\n");
}

/** One-line stderr warning per ADR-164 §Behavior step 5. The dispatcher
 *  emits this whether the abort is taken or `--force` overrides it. */
export function driftWarning(detection: DriftDetection): string {
  return `🔧 [sync-claude-team-json] drift detected — prior=${detection.priorMarker.sourceFingerprint.slice(7, 19)}… current=${detection.currentFingerprint.slice(7, 19)}…`;
}

/** Event shape for `.atmux/logs/sync-events.jsonl`. One JSON line per
 *  event; tests + audit tooling can grep without parsing the whole file. */
export interface SyncEvent {
  ts: string;
  verb: "sync.claude-team-json";
  action: "drift-abort" | "drift-forced" | "synced";
  detection?: DriftDetection;
}

export function syncEventsLogPath(atmuxDir: string): string {
  return join(atmuxDir, "logs", "sync-events.jsonl");
}

/** Append one event line. Caller supplies `atmuxDir` (resolved via
 *  `getAtmuxDir` from `src/core/common.ts`) so we don't re-walk the
 *  filesystem here. */
export async function logSyncEvent(atmuxDir: string, event: SyncEvent): Promise<void> {
  await appendText(syncEventsLogPath(atmuxDir), `${JSON.stringify(event)}\n`);
}
