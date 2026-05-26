// ADR-177: Whip Velocity-Gate — strike counter state file.
//
// Pure module — IO is the only side effect, isolated behind two
// readers (`readStrikes`, `readStrikeRecord`) + one writer
// (`writeStrikeRecord`). State lives at
// `<atmuxDir>/state/whip-strikes-<team>.json`. Format is JSON object
// keyed by symptom hash (per Task body §6 + the sibling-T2 spec at
// t-e91fec98 §2), with `count` + `firstStrikeSec` + `lastStrikeSec`
// fields per hash so the T2 superdoctor-escalation Task can render a
// "strikes 0→3 over Δt" timeline without re-deriving anything.
//
// Why per-symptom hash (not a single global counter): different
// failure modes (eta-lied vs classifier-swallow vs process-frozen
// per t-e91fec98 §2) need independent strike sequences. A team that
// alternates eta-lied → classifier-swallow → eta-lied shouldn't
// trip the same complaint as one that hits classifier-swallow three
// times in a row; the symptoms tell different stories. T2 uses the
// hash as the complaint's source_id for dedup.
//
// V1 ships with a single symptom hash from the velocity classifier
// (verdict=BAD reason). Additional symptom hashes (eta-lied,
// classifier-swallow) ship under the sibling T2 Task t-e91fec98 once
// reply validation lands.

import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWrite, readTextOrNull } from "../abstractions/fs.ts";
import { stateDir } from "./common.ts";

/** Per-symptom strike record. */
export interface StrikeRecord {
  /** Current consecutive strike count. Reset to 0 on next OK / STANDBY
   *  verdict OR on explicit `resetStrikeRecord` (called by T2 after
   *  filing a complaint — see Task body §6 "Reset strike counter
   *  after complaint filed"). */
  count: number;
  /** Epoch seconds of the first strike in the current run. Null when
   *  count == 0. Lets T2 render "strikes 0→3 over Δt" without
   *  tracking ticks. */
  firstStrikeSec: number | null;
  /** Epoch seconds of the most recent strike. Null when count == 0.
   *  T2 uses this to dedup complaints (re-file within 1h of an open
   *  same-hash complaint = bump existing row). */
  lastStrikeSec: number | null;
  /** Last verdict reason that incremented the counter — surfaced as
   *  "observable-evidence" in the eventual complaint body. */
  lastReason: string | null;
  /** ADR-177 §"What V1 defers" (Task t-5d85dddb §3 reply validation):
   *  epoch seconds when the action-menu was last delivered to the lead
   *  pane via `safeSendKeys`. Null when no menu is pending. Next tick
   *  uses this to decide whether to enforce the `^[ABCD]:` reply marker
   *  + whether to strike on missed-ETA / classifier-swallow.
   *
   *  Stored as an optional field for backward-compat with v1 strike files
   *  written before the wire-up landed — readers default missing to null. */
  menuSentAtSec?: number | null;
  /** ADR-177 §"What V1 defers" (Task t-5d85dddb §3 reply validation):
   *  sha-256 hash of the lead-pane capture text taken at menu-send
   *  time. Lets the next tick distinguish "lead replied (pane changed,
   *  inspect reply for marker)" from "classifier-swallow (pane
   *  unchanged — keystroke dropped)" without re-capturing the original
   *  text. Truncated to {@link HASH_HEX_LEN} hex chars for storage
   *  economy. */
  menuPaneHash?: string | null;
}

/** Full strikes file shape. Keyed by symptom hash. */
export interface StrikesFile {
  /** Per-symptom-hash records. */
  records: Record<string, StrikeRecord>;
  /** Schema version — bumps on incompatible shape changes. v1 is the
   *  shape this commit lands. */
  schemaVersion: 1;
}

/** Build the per-team strike file path. Exported so callers (whip.ts
 *  + tests + T2) share one resolver. */
export function strikesPath(atmuxDir: string, teamName: string): string {
  return join(stateDir(atmuxDir), `whip-strikes-${teamName}.json`);
}

/** Initial empty file. Used by readers when the file doesn't exist yet
 *  (first tick on a fresh team) — the read returns this in-memory, no
 *  write happens until the first strike. */
function emptyStrikesFile(): StrikesFile {
  return { records: {}, schemaVersion: 1 };
}

/** Initial empty record. */
function emptyStrikeRecord(): StrikeRecord {
  return {
    count: 0,
    firstStrikeSec: null,
    lastStrikeSec: null,
    lastReason: null,
    menuSentAtSec: null,
    menuPaneHash: null,
  };
}

/** Pane-hash truncation length (hex chars). 16 chars = 64 bits — collision
 *  probability negligible at the per-team-tick volume the menu state
 *  sees (≤1 hash write per 5min tick). Storage economy: full sha256 hex
 *  is 64 chars; truncating to 16 keeps the JSON file small without
 *  meaningful collision risk for the pane-change-detection use case. */
const HASH_HEX_LEN = 16;

/** Compute a stable, short hash of a lead-pane capture text. Used by the
 *  poke velocity-gate wiring (Task t-5d85dddb §3) to detect whether the
 *  lead pane changed between the menu-send tick and the next tick:
 *  - hash matches stored `menuPaneHash` → pane unchanged → classifier-
 *    swallow (keystroke dropped, lead never saw the menu);
 *  - hash differs → lead reacted (look for `^[ABCD]:` marker in the new
 *    capture to decide whether the reply was compliant). */
export function computePaneHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, HASH_HEX_LEN);
}

/** Read the whole strikes file. Returns an empty in-memory record
 *  when the file is missing or unreadable (sub-op error containment —
 *  whip should never crash on a transient strikes-file read failure;
 *  worst case the counter resets, which is benign vs. a hard crash). */
export async function readStrikesFile(atmuxDir: string, teamName: string): Promise<StrikesFile> {
  const path = strikesPath(atmuxDir, teamName);
  const text = await readTextOrNull(path);
  if (text === null || text === "") return emptyStrikesFile();
  try {
    const parsed = JSON.parse(text) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "records" in parsed &&
      typeof (parsed as { records: unknown }).records === "object"
    ) {
      const records = (parsed as { records: Record<string, unknown> }).records;
      const out: Record<string, StrikeRecord> = {};
      for (const [k, v] of Object.entries(records)) {
        if (typeof v === "object" && v !== null) {
          const rec = v as Partial<StrikeRecord>;
          out[k] = {
            count: typeof rec.count === "number" ? rec.count : 0,
            firstStrikeSec: typeof rec.firstStrikeSec === "number" ? rec.firstStrikeSec : null,
            lastStrikeSec: typeof rec.lastStrikeSec === "number" ? rec.lastStrikeSec : null,
            lastReason: typeof rec.lastReason === "string" ? rec.lastReason : null,
            menuSentAtSec: typeof rec.menuSentAtSec === "number" ? rec.menuSentAtSec : null,
            menuPaneHash: typeof rec.menuPaneHash === "string" ? rec.menuPaneHash : null,
          };
        }
      }
      return { records: out, schemaVersion: 1 };
    }
  } catch {
    // Malformed JSON — treat as empty. Worst case: one strike's worth
    // of history is lost, which is correct behavior (we'd rather lose
    // history than crash the whip tick).
  }
  return emptyStrikesFile();
}

/** Read a single symptom-hash record. */
export async function readStrikeRecord(
  atmuxDir: string,
  teamName: string,
  symptomHash: string,
): Promise<StrikeRecord> {
  const file = await readStrikesFile(atmuxDir, teamName);
  return file.records[symptomHash] ?? emptyStrikeRecord();
}

/** Write the whole strikes file. Atomic — uses the project's standard
 *  mktemp + rename pattern via `atomicWrite`. */
export async function writeStrikesFile(
  atmuxDir: string,
  teamName: string,
  file: StrikesFile,
): Promise<void> {
  const path = strikesPath(atmuxDir, teamName);
  await mkdir(dirname(path), { recursive: true });
  await atomicWrite(path, `${JSON.stringify(file, null, 2)}\n`);
}

/** Bump the counter for `symptomHash` and persist. Returns the new
 *  record (post-bump) so the caller can decide whether to escalate
 *  (count >= strikeThreshold). */
export async function incrementStrike(
  atmuxDir: string,
  teamName: string,
  symptomHash: string,
  reason: string,
  nowSec: number,
): Promise<StrikeRecord> {
  const file = await readStrikesFile(atmuxDir, teamName);
  const existing = file.records[symptomHash] ?? emptyStrikeRecord();
  // Bumping the counter must NOT wipe a pending menu — `recordMenuSent`
  // owns the menu fields. Preserve `menuSentAtSec` + `menuPaneHash` so a
  // sequence of (sendMenu → strikeOnNextTickForNoMarker) reads the same
  // pending-menu state the caller stored on the prior tick.
  const next: StrikeRecord = {
    count: existing.count + 1,
    firstStrikeSec: existing.count === 0 ? nowSec : existing.firstStrikeSec,
    lastStrikeSec: nowSec,
    lastReason: reason,
    menuSentAtSec: existing.menuSentAtSec ?? null,
    menuPaneHash: existing.menuPaneHash ?? null,
  };
  file.records[symptomHash] = next;
  await writeStrikesFile(atmuxDir, teamName, file);
  return next;
}

/** Reset a single symptom-hash record to zero — called by T2 after
 *  filing a complaint (Task body §6 "Reset strike counter after
 *  complaint filed; don't re-strike immediately"). Also called by
 *  the whip tick when verdict transitions BAD → OK/STANDBY (per Task
 *  body §1-2 — the strike counter only tracks CONSECUTIVE BAD ticks). */
export async function resetStrikeRecord(
  atmuxDir: string,
  teamName: string,
  symptomHash: string,
): Promise<void> {
  const file = await readStrikesFile(atmuxDir, teamName);
  if (!(symptomHash in file.records)) return;
  delete file.records[symptomHash];
  await writeStrikesFile(atmuxDir, teamName, file);
}

/** Record that the action-menu was just delivered to the lead pane —
 *  stores `menuSentAtSec` + `menuPaneHash` on the existing strike record
 *  (or creates one with count=0 if no prior strike). Called by the poke
 *  velocity-gate after `safeSendKeys` returns `sent`, so the next tick
 *  can validate the reply via `^[ABCD]:` marker check + pane-change
 *  detection (Task t-5d85dddb §3). Does NOT increment the counter —
 *  strike accounting is `incrementStrike`'s responsibility. */
export async function recordMenuSent(
  atmuxDir: string,
  teamName: string,
  symptomHash: string,
  paneHash: string,
  nowSec: number,
): Promise<void> {
  const file = await readStrikesFile(atmuxDir, teamName);
  const existing = file.records[symptomHash] ?? emptyStrikeRecord();
  file.records[symptomHash] = {
    ...existing,
    menuSentAtSec: nowSec,
    menuPaneHash: paneHash,
  };
  await writeStrikesFile(atmuxDir, teamName, file);
}

/** Clear the pending-menu fields on a strike record without touching
 *  the count. Called by the poke velocity-gate AFTER it has consumed
 *  the prior tick's pending-menu state (compliant reply found, OR
 *  missing-marker strike fired, OR classifier-swallow strike fired) so
 *  subsequent ticks don't re-validate the same delivery. Idempotent —
 *  no-op when the record has no menu state OR no record exists. */
export async function clearPendingMenu(
  atmuxDir: string,
  teamName: string,
  symptomHash: string,
): Promise<void> {
  const file = await readStrikesFile(atmuxDir, teamName);
  const existing = file.records[symptomHash];
  if (existing === undefined) return;
  if (existing.menuSentAtSec === null && existing.menuPaneHash === null) return;
  file.records[symptomHash] = {
    ...existing,
    menuSentAtSec: null,
    menuPaneHash: null,
  };
  await writeStrikesFile(atmuxDir, teamName, file);
}

/** Stable hash for the velocity-gate's "stalled" symptom. V1 has one
 *  symptom; T2 (t-e91fec98) extends with eta-lied / classifier-swallow
 *  / process-frozen variants. Centralized so the hash string is
 *  defined once + reused by tests + T2's complaint source_id. */
export function velocityStalledSymptomHash(teamName: string): string {
  return `whip-${teamName}-velocity-stalled`;
}

// ---------- ADR-177 §T2 (Task t-e91fec98 §2) symptom hash variants ----------
//
// Three failure modes the whip can recognize that warrant distinct
// complaint rows — each gets its own dedup key so an alternating
// pattern (eta-lied → classifier-swallow → eta-lied) doesn't trip the
// same complaint as a sustained run of the same symptom. Documented
// at Task t-e91fec98 §2; the strings are the literal contract the
// superdoctor consumer reads.

/** Symptom hash for the "eta-lied" failure mode (Task t-e91fec98 §2):
 *  lead picked D=Standby N times without the promised ETA ever
 *  hitting. Distinguishable from process-frozen by the fact that lead
 *  IS responding — just not delivering. */
export function etaLiedSymptomHash(teamName: string): string {
  return `whip-${teamName}-eta-lied`;
}

/** Symptom hash for the "classifier-swallow" failure mode (Task
 *  t-e91fec98 §2): queued-but-unsubmitted compose text persists across
 *  ≥2 ticks — auto-mode swallowed the keystroke, the menu reply never
 *  reached the model. Distinguishable from eta-lied by the queued
 *  text being visible in the pane but never submitted. */
export function classifierSwallowSymptomHash(teamName: string): string {
  return `whip-${teamName}-classifier-swallow`;
}

/** Symptom hash for the "process-frozen" failure mode (Task t-e91fec98
 *  §2): token count unchanged across 3+ ticks AND last commit > 2h.
 *  Distinct from eta-lied (lead is producing tokens but not shipping)
 *  and classifier-swallow (compose text is stuck but tokens may be
 *  moving) — this one is the catatonic case where nothing's happening
 *  at all. */
export function processFrozenSymptomHash(teamName: string): string {
  return `whip-${teamName}-process-frozen`;
}

/** Render a human-readable strike timeline for the complaint body —
 *  "strikes 0→N over Δt=Xmin; last reason: <reason>". Used by T2's
 *  complaint-body builder (Task t-e91fec98 §4 "Body: timeline of
 *  strikes"); kept here so the rendering stays colocated with the
 *  record shape. `nowSec` is injected so tests pin the clock.
 *
 *  Degenerate cases:
 *  - count=0 OR firstStrikeSec=null → "no strikes recorded" (defensive;
 *    the caller should not be rendering a timeline for an empty
 *    record, but T2's error paths shouldn't crash on one). */
export function renderStrikeTimeline(record: StrikeRecord, nowSec: number): string {
  if (record.count === 0 || record.firstStrikeSec === null) {
    return "no strikes recorded";
  }
  const deltaSec = nowSec - record.firstStrikeSec;
  // Floor to whole minutes; clamp to ≥1 so "Δt=0min" never appears
  // (would read as a typo even on sub-60s windows in tests).
  const deltaMin = Math.max(1, Math.floor(deltaSec / 60));
  const reason = record.lastReason ?? "<no reason>";
  return `strikes 0→${record.count} over Δt=${deltaMin}min; last reason: ${reason}`;
}
