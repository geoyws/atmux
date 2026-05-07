// ADR-057 t-3e58a605 Path B: known-modals catalog — recognize specific
// Claude Code modal types and auto-dismiss them with the right keystroke
// before the safeSendKeys gate refuses outright.
//
// The pane-state classifier (src/core/pane-state.ts) detects MODAL state
// generically. This module pattern-matches the modal *content* against a
// small catalog where the dismissal keystroke is known + safe to inject,
// so safeSendKeys can dismiss + retry instead of refusing.
//
// Add entries conservatively — every entry is a credential we hand to
// the auto-dismiss path. The pattern must be specific enough that a
// false-positive on real user input is implausible.

export interface KnownModal {
  /** Stable id — used for dedup, telemetry, flag tags. */
  id: string;
  /** Human-readable description for log output. */
  description: string;
  /** Pattern that must match the captured pane text. Use `[\s\S]*` for
   *  multi-line spans (the `s` flag isn't honored uniformly across the
   *  TS targets in this repo, so explicit `[\s\S]` is safer). */
  pattern: RegExp;
  /** Keystroke string passed to tmux send-keys. */
  keys: string;
  /** Whether to press Enter after the keys. The Claude Code feedback
   *  survey takes a single-character answer with NO Enter — pressing
   *  Enter would submit the prompt itself. Default false; opt-in. */
  pressEnter: boolean;
}

export interface KnownModalMatch {
  modal: KnownModal;
  /** Captured-text excerpt that triggered the match. */
  evidence: string;
}

// ---------- Catalog ----------
//
// Order = precedence (first match wins). Keep the catalog short — every
// entry is a regex run on every pane-text capture inside the safeSend
// gate, and a too-permissive entry will dismiss the wrong modal.

export const KNOWN_MODALS: ReadonlyArray<KnownModal> = [
  {
    id: "feedback-survey",
    description:
      "Claude Code per-session feedback survey (1: Bad / 2: Fine / 3: Good / 0: Dismiss)",
    // Anchor on all four answer rows so partial / stale captures don't
    // trip the dismiss path. The "0: Dismiss" row is what ratifies the
    // dismissal keystroke — without it we don't know '0' is safe.
    pattern:
      /How is Claude doing this session[\s\S]*1:\s*Bad[\s\S]*2:\s*Fine[\s\S]*3:\s*Good[\s\S]*0:\s*Dismiss/,
    keys: "0",
    pressEnter: false,
  },
];

// ---------- Public API ----------

/**
 * Scan `text` against the known-modals catalog. Returns the first match
 * (catalog order = priority), or `null` if no entry matches.
 */
export function detectKnownModal(text: string): KnownModalMatch | null {
  for (const modal of KNOWN_MODALS) {
    const match = modal.pattern.exec(text);
    if (match !== null) {
      return { modal, evidence: match[0] };
    }
  }
  return null;
}
