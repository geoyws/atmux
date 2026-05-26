// ADR-142: Modal-cycling detector — catch lead/member modal-soup-stuck
// patterns whip §1c misses (static-stuck is hash-equality across ticks;
// cycling is ≥N distinct hashes within a window + zero commits).
//
// Pure module — no I/O. Detection function is the seam shared by
// lead's whip §1c and any future orchd event consumer (EPIC
// e-a946af69) — the detection function stays put even if the
// call-site moves.
//
// State-file I/O lives in `./modal-cycling-state.ts` so this module is
// trivially unit-testable without touching disk.

import { createHash } from "node:crypto";

// ---------- Types ----------

/** One detected modal event for a single (team, member). Persisted in
 *  per-member history files at `<atmuxDir>/state/modal-history-<member>
 *  .json` (file-per-member to avoid lock contention; see ADR-142 §D1). */
export interface ModalHistoryEntry {
  /** Member name the modal was seen on. Denormalized into the entry so a
   *  cross-member aggregator (deferred) does not have to thread filename
   *  context. */
  member: string;
  /** SHA256 hex digest of the extracted modal-text region. Per ADR-142
   *  §OQ-1 default (B): modal-text-only — NOT full-pane — so incidental
   *  status-line variation does not inflate the distinct-hash count. */
  paneTextHash: string;
  /** Unix epoch seconds at detection time. Caller passes the clock; the
   *  module is clock-agnostic for testability. */
  detectedAt: number;
  /** Modal text excerpt (truncated to {@link MODAL_TEXT_STORE_LIMIT} on
   *  store; the hash is computed over the full extract BEFORE truncation
   *  so two long modals that differ past the truncation boundary still
   *  produce distinct hashes). */
  modalText: string;
  /** Coarse classification — current v1 catalog is `choice-prompt` /
   *  `confirm-prompt` / `enter-prompt` / `numbered-prompt`. Reserved for
   *  the Phase-2 semantic-similarity check; v1 uses hash equality only. */
  modalClass: ModalClass;
}

/** Coarse-grain modal taxonomy. v1 callers only need the label for the
 *  Discord bullet + future cross-class semantic check. */
export type ModalClass = "choice-prompt" | "confirm-prompt" | "enter-prompt" | "numbered-prompt";

/** Output of {@link classifyPaneAsModal} — `isModal: false` is the
 *  common case; `modalText` + `modalClass` populated only on match. */
export interface ClassifyResult {
  isModal: boolean;
  modalText?: string;
  modalClass?: ModalClass;
}

/** Tunables for {@link shouldFireCycleDetection}. Pulled from
 *  `team.json::modalCycling` at the call-site; defaults at the team
 *  load-site per ADR-142 §Configuration. */
export interface CycleDetectionConfig {
  /** Minimum distinct modal-hashes within `windowMin` to trigger. */
  cycleThreshold: number;
  /** Modal-history analysis window in minutes. */
  windowMin: number;
  /** Commits observed for the member's claimed task within
   *  `commitGracePeriodMin`. Caller queries git log and passes the
   *  count; the detector does not touch git. */
  commitsInWindow: number;
  /** Commit-search window in minutes (matches `windowMin` by default at
   *  the load-site). */
  commitGracePeriodMin: number;
}

/** Output of {@link shouldFireCycleDetection}. */
export interface CycleDetectionResult {
  /** `true` when ≥ `cycleThreshold` distinct hashes within `windowMin`
   *  AND `commitsInWindow === 0` within `commitGracePeriodMin`. */
  fire: boolean;
  /** Human-readable line summarizing the fire reason — composed even
   *  when `fire === false` so callers can log the negative verdict for
   *  debug. */
  reason: string;
  /** The history entries that contributed to the verdict (within
   *  `windowMin`). Renderers truncate to last 3 for the Discord bullet
   *  per ADR-142 §D4. */
  modalsSeen: ModalHistoryEntry[];
}

// ---------- Constants ----------

/** Modal text storage cap. Hash is computed over the full extract before
 *  this truncation; the truncated copy is what lives on disk for
 *  human-readable Discord bullets + audit. ADR-142 §D1 says 200 chars. */
export const MODAL_TEXT_STORE_LIMIT = 200;

/** Modal classifier — primary signal is the `❯` (U+276F) marker + a
 *  numbered list. Matches modals like:
 *    ❯ 1. Force-push to origin?
 *      2. Pause and ask
 *      0. Dismiss
 *  Also accepts the legacy `Enter to select` phrasing some Claude Code
 *  variants emit alongside the numbered list. */
const NUMBERED_OPTION_RE = /^[\s│]*\d+\.\s+\S/m;
const CHEVRON_NUMBERED_RE = /❯\s*\d+\.\s+\S/;
const ENTER_TO_SELECT_RE = /Enter to (select|continue|confirm)/i;
const CONFIRM_PROMPT_RE = /\[y\/N\]:?\s*$/m;
const ENTER_PROMPT_RE = /\bPress (enter|return) (to continue|when done)/i;

/** Region extractor — the modal-text portion of the pane capture, from
 *  the `❯` marker (or first numbered line) through the next blank line
 *  or end-of-buffer. Status-line frippery below the modal is excluded so
 *  the hash stays stable under incidental footer variation. */
function extractModalRegion(text: string): string | null {
  // Prefer the chevron marker — sharpest signal.
  const chev = text.indexOf("❯");
  if (chev !== -1) {
    const tail = text.slice(chev);
    // Capture through the first run of >=2 consecutive newlines (blank
    // line) OR end-of-buffer.
    const blankIdx = tail.search(/\n\s*\n/);
    return blankIdx === -1 ? tail : tail.slice(0, blankIdx);
  }
  // Fallback: first numbered-option line + downstream contiguous block.
  const numMatch = NUMBERED_OPTION_RE.exec(text);
  if (numMatch !== null && numMatch.index !== undefined) {
    const tail = text.slice(numMatch.index);
    const blankIdx = tail.search(/\n\s*\n/);
    return blankIdx === -1 ? tail : tail.slice(0, blankIdx);
  }
  return null;
}

/** Count numbered-option lines (`1.`, `2.`, ...) in the extracted modal
 *  region. Used to gate `classifyPaneAsModal` — a single `1. foo` line
 *  is not a choice-prompt; we want ≥2 to filter out incidental matches
 *  in narrative text. */
function countNumberedOptions(region: string): number {
  const lines = region.split("\n");
  let count = 0;
  for (const line of lines) {
    if (/^[\s│❯]*\d+\.\s+\S/.test(line)) count += 1;
  }
  return count;
}

// ---------- Public API ----------

/**
 * Classify a pane capture as a choice-prompt modal. Per ADR-142 §D1 + the
 * task body, the positive signals are:
 *   (a) `❯` marker plus a numbered list, OR
 *   (b) ≥2 numbered options PLUS an "Enter to select" phrase, OR
 *   (c) bare `[y/N]:` confirm prompt at end-of-line.
 *
 * Returns `{ isModal: false }` when the capture does not match — the
 * common case. Free-form narrative text never matches.
 *
 * The function is intentionally stricter than `pane-state.ts ::
 * classifyText`'s MODAL bucket: this detector targets the CYCLING
 * pattern (multiple distinct choice-prompts in sequence), so generic
 * `Do you want Claude to` matches without a numbered list are skipped —
 * those are the static-stuck class whip §1c already covers via the
 * existing classifier.
 */
export function classifyPaneAsModal(paneCapture: string): ClassifyResult {
  if (paneCapture.length === 0) return { isModal: false };

  // (c) Confirm-prompt — `[y/N]:` at end of a line. Cheapest check.
  if (CONFIRM_PROMPT_RE.test(paneCapture)) {
    const lines = paneCapture.split("\n");
    const confirmLine = lines.find((l) => CONFIRM_PROMPT_RE.test(l)) ?? "";
    return { isModal: true, modalText: confirmLine.trim(), modalClass: "confirm-prompt" };
  }

  // (a) + (b) need the region extracted first.
  const region = extractModalRegion(paneCapture);
  if (region === null) {
    // (d) Enter-prompt without a numbered list — `Press enter to continue`.
    if (ENTER_PROMPT_RE.test(paneCapture)) {
      const lines = paneCapture.split("\n");
      const enterLine = lines.find((l) => ENTER_PROMPT_RE.test(l)) ?? "";
      return { isModal: true, modalText: enterLine.trim(), modalClass: "enter-prompt" };
    }
    return { isModal: false };
  }

  const hasChevronNumbered = CHEVRON_NUMBERED_RE.test(region);
  const numCount = countNumberedOptions(region);
  const hasEnterToSelect = ENTER_TO_SELECT_RE.test(region);

  if (hasChevronNumbered && numCount >= 1) {
    return { isModal: true, modalText: region.trim(), modalClass: "choice-prompt" };
  }
  if (numCount >= 2 && hasEnterToSelect) {
    return { isModal: true, modalText: region.trim(), modalClass: "choice-prompt" };
  }
  if (numCount >= 2) {
    // ≥2 numbered options without an explicit Enter-to-select phrase —
    // still a strong cycling-class signal (the operator-observed 2026-05-14
    // whip-impl modals fall here).
    return { isModal: true, modalText: region.trim(), modalClass: "numbered-prompt" };
  }
  return { isModal: false };
}

/**
 * Compute the dedup hash for a modal text. Per ADR-142 §OQ-1 default (B):
 * SHA256 over the modal-text region only (NOT the full pane), so
 * status-line variation does not inflate the distinct-hash count.
 *
 * Caller is responsible for passing the extracted region (typically the
 * `modalText` field of a {@link ClassifyResult}). The function does not
 * re-extract — keeping the hash basis explicit at the call-site makes the
 * dedup behaviour auditable.
 */
export function computeModalHash(modalText: string): string {
  return createHash("sha256").update(modalText).digest("hex");
}

/**
 * Decide whether the cycling-detection trigger should fire this tick.
 *
 * Inputs:
 *   - `history`: full per-member history (the caller filters by member;
 *     this function does NOT cross-filter — pass only the relevant
 *     member's entries).
 *   - `config`: tunables from `team.json::modalCycling`.
 *
 * Logic per ADR-142 §D2 + §D3:
 *   1. Filter entries to those within `windowMin` of "now" (the caller
 *      seeds "now" by passing entries pre-filtered OR by appending a
 *      fresh entry first; either is acceptable — this function picks the
 *      max `detectedAt` from the input as its "now" anchor so a caller
 *      that fed the freshly-detected entry in implicitly anchors to it).
 *   2. Count distinct `paneTextHash` values.
 *   3. Fire when distinct ≥ `cycleThreshold` AND `commitsInWindow === 0`.
 *
 * Returns `fire = false` with a verdict reason on:
 *   - empty history,
 *   - below-threshold distinct count,
 *   - productive ceremony (≥1 commit in window).
 */
export function shouldFireCycleDetection(
  history: ModalHistoryEntry[],
  config: CycleDetectionConfig,
): CycleDetectionResult {
  if (history.length === 0) {
    return { fire: false, reason: "no modal history", modalsSeen: [] };
  }

  // Anchor on the freshest entry — caller's append-then-check pattern
  // means this is "now" without the function needing a clock.
  let anchor = history[0]?.detectedAt ?? 0;
  for (const e of history) {
    if (e.detectedAt > anchor) anchor = e.detectedAt;
  }
  const windowSec = config.windowMin * 60;
  const recent = history.filter((e) => anchor - e.detectedAt <= windowSec);

  const distinctHashes = new Set(recent.map((e) => e.paneTextHash));

  if (distinctHashes.size < config.cycleThreshold) {
    return {
      fire: false,
      reason: `only ${distinctHashes.size} distinct modal-hash(es) in ${config.windowMin}min window (need ${config.cycleThreshold})`,
      modalsSeen: recent,
    };
  }

  if (config.commitsInWindow > 0) {
    return {
      fire: false,
      reason: `${distinctHashes.size} distinct modal-hashes in ${config.windowMin}min, but ${config.commitsInWindow} commit(s) in ${config.commitGracePeriodMin}min — productive ceremony`,
      modalsSeen: recent,
    };
  }

  return {
    fire: true,
    reason: `${distinctHashes.size} distinct modal-classes in ${config.windowMin}min window, 0 commits in ${config.commitGracePeriodMin}min`,
    modalsSeen: recent,
  };
}

/**
 * Append a new entry to the history and prune entries older than
 * `retentionMin * 60` seconds (relative to the freshest `detectedAt`).
 * Pure — caller persists the returned array via
 * {@link saveModalHistory}.
 *
 * Retention bound matches ADR-142 §D1 (`windowMin * 2` default at the
 * caller); the function is generic so callers can tune.
 */
export function appendHistory(
  history: ModalHistoryEntry[],
  entry: ModalHistoryEntry,
  retentionMin: number,
): ModalHistoryEntry[] {
  // Truncate modalText to the storage limit — hash already computed.
  const truncated: ModalHistoryEntry = {
    ...entry,
    modalText:
      entry.modalText.length > MODAL_TEXT_STORE_LIMIT
        ? entry.modalText.slice(0, MODAL_TEXT_STORE_LIMIT)
        : entry.modalText,
  };
  const all = [...history, truncated];
  const anchor = truncated.detectedAt;
  const retSec = retentionMin * 60;
  return all.filter((e) => anchor - e.detectedAt <= retSec);
}
