// ADR-200 §D5 — init-wizard TUI styling: branded header + Step N/M lines.
//
// Pure renderers (no IO) so unit tests pin the contract. Color degrades
// gracefully: ANSI only when the sink is a TTY, NO_COLOR is unset, and
// TERM is not "dumb" — piped / CI runs get plain text.

/** Number of numbered wizard steps (verification is an unnumbered finale). */
export const WIZARD_STEP_COUNT = 5;

/** Canonical step titles, in order. */
export const WIZARD_STEP_TITLES = [
  "Prereq probe",
  "Cockpit init",
  "team.json",
  "Account pool",
  "Skills plugin",
] as const;

/** Per-line glyphs per ADR-200 §D5. */
export const WIZARD_GLYPHS = {
  done: "✓",
  active: "→",
  failed: "✗",
  skipped: "⏭",
  prompt: "?",
} as const;

export type WizardGlyphKind = keyof typeof WIZARD_GLYPHS;

export interface WizardColorEnv {
  NO_COLOR?: string | undefined;
  TERM?: string | undefined;
}

/**
 * ANSI iff the sink is a TTY, NO_COLOR is unset, and TERM is not "dumb".
 * Pure so tests pin the degrade matrix without a terminal.
 */
export function shouldUseWizardColor(env: WizardColorEnv, isTty: boolean): boolean {
  if (!isTty) return false;
  if (env.NO_COLOR !== undefined) return false;
  if (env.TERM === "dumb") return false;
  return true;
}

const ANSI_BOLD_CYAN = "\u001b[1;36m";
const ANSI_BOLD = "\u001b[1m";
const ANSI_RESET = "\u001b[0m";

/** Branded header: `atmux init --wizard <version> — guided first-run setup`. */
export function renderWizardHeader(opts: { version: string; color: boolean }): string {
  const line = `atmux init --wizard ${opts.version} — guided first-run setup`;
  return opts.color ? `${ANSI_BOLD_CYAN}${line}${ANSI_RESET}` : line;
}

/** Numbered step line: `Step N/M — <title>`. */
export function renderWizardStep(
  n: number,
  total: number,
  title: string,
  opts: { color: boolean },
): string {
  const line = `Step ${n}/${total} — ${title}`;
  return opts.color ? `${ANSI_BOLD}${line}${ANSI_RESET}` : line;
}
