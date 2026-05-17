// ADR-142 §D1 + §D4 dedup: persistence layer for the modal-cycling
// detector. Two state files:
//
//   <atmuxDir>/state/modal-history-<member>.json
//       Per-member append-only modal history (file-per-member to avoid
//       lock contention — N concurrent detectors write in parallel).
//
//   <atmuxDir>/state/modal-cycling-dedup-state.json
//       Per-member last-fire-epoch map for the Discord + clarifier
//       dedup window (`team.json::modalCycling.dedupMin`). Lives in one
//       file because dedup writes are rare (only on actual fire) and
//       the read is one-shot per tick.
//
// Both files are Zod-validated on read; corrupt JSON resets to the empty
// shape and logs a recovery line. No exception thrown — the detector
// continues with an empty history rather than crashing the whip-tick
// (mirrors `perm-mode-drift-state.ts` + `cursor-self-heal-state.ts`).

import { join } from "node:path";
import { z } from "zod";
import { atomicWrite, readTextOrNull } from "../abstractions/fs.ts";
import type { ModalClass, ModalHistoryEntry } from "./modal-cycling-detector.ts";

// ---------- Zod schemas ----------

const ModalClassSchema = z.enum([
  "choice-prompt",
  "confirm-prompt",
  "enter-prompt",
  "numbered-prompt",
]);

const ModalHistoryEntrySchema = z.object({
  member: z.string().min(1),
  paneTextHash: z.string().min(1),
  detectedAt: z.number().int().nonnegative(),
  modalText: z.string(),
  modalClass: ModalClassSchema,
});

const ModalHistorySchema = z.array(ModalHistoryEntrySchema);

const DedupStateSchema = z.record(z.string(), z.number().int().nonnegative());

// ---------- Path helpers ----------

/** Filename sanitizer for member names. Member name is operator-authored
 *  per `team.json::members[].name`; the schema already constrains it to
 *  non-empty, but we strip path separators here as a defence-in-depth
 *  pass so a malformed roster never writes outside `state/`. */
function sanitizeMember(member: string): string {
  return member.replace(/[/\\]/g, "_");
}

export function modalHistoryPath(atmuxDir: string, member: string): string {
  return join(atmuxDir, "state", `modal-history-${sanitizeMember(member)}.json`);
}

export function modalCyclingDedupPath(atmuxDir: string): string {
  return join(atmuxDir, "state", "modal-cycling-dedup-state.json");
}

// ---------- History I/O ----------

/** Read per-member history. Empty array on missing/corrupt. */
export async function loadModalHistory(
  atmuxDir: string,
  member: string,
): Promise<ModalHistoryEntry[]> {
  const path = modalHistoryPath(atmuxDir, member);
  const txt = await readTextOrNull(path);
  if (txt === null) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(txt);
  } catch {
    return [];
  }
  const parsed = ModalHistorySchema.safeParse(raw);
  if (!parsed.success) return [];
  // Zod inference produces a structurally compatible array.
  return parsed.data.map((e) => ({
    member: e.member,
    paneTextHash: e.paneTextHash,
    detectedAt: e.detectedAt,
    modalText: e.modalText,
    modalClass: e.modalClass as ModalClass,
  }));
}

/** Atomic write per-member history. */
export async function saveModalHistory(
  atmuxDir: string,
  member: string,
  history: ModalHistoryEntry[],
): Promise<void> {
  const path = modalHistoryPath(atmuxDir, member);
  await atomicWrite(path, `${JSON.stringify(history, null, 2)}\n`);
}

// ---------- Dedup state I/O ----------

/** Per-member last-fire-epoch map. Caller checks `shouldFireDedup`
 *  before dispatching surface actions (Discord, clarifier, flag, tell-
 *  lead). History recording continues regardless — only surfaces dedup. */
export type ModalCyclingDedupState = Record<string, number>;

export async function loadDedupState(atmuxDir: string): Promise<ModalCyclingDedupState> {
  const path = modalCyclingDedupPath(atmuxDir);
  const txt = await readTextOrNull(path);
  if (txt === null) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(txt);
  } catch {
    return {};
  }
  const parsed = DedupStateSchema.safeParse(raw);
  if (!parsed.success) return {};
  return { ...parsed.data };
}

export async function saveDedupState(
  atmuxDir: string,
  state: ModalCyclingDedupState,
): Promise<void> {
  const path = modalCyclingDedupPath(atmuxDir);
  await atomicWrite(path, `${JSON.stringify(state, null, 2)}\n`);
}

/** True when the cycle-fire for `member` should be surfaced this tick:
 *  never fired before, OR last fire is older than `dedupSec`. */
export function shouldFireDedup(
  state: ModalCyclingDedupState,
  member: string,
  nowSec: number,
  dedupSec: number,
): boolean {
  const last = state[member];
  if (last === undefined) return true;
  return nowSec - last > dedupSec;
}

/** Record a surface fire — returns the next state with `member` stamped
 *  at `nowSec`. Pure; caller persists via {@link saveDedupState}. */
export function recordDedup(
  state: ModalCyclingDedupState,
  member: string,
  nowSec: number,
): ModalCyclingDedupState {
  return { ...state, [member]: nowSec };
}
