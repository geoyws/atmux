// ADR-272: voice operator interface — per-tool compact envelopes for a
// VOICE surface.
//
// Verb output is terminal-shaped (tables, ANSI color, dozens of rows);
// a realtime speech model needs a compact, line-structural digest.
// Truncation here is STRUCTURAL ONLY: whole trailing lines are dropped
// and a `… (+N more lines)` marker appended — a line is never cut
// mid-way (a half row read aloud is worse than a dropped row). The one
// spec'd carve-out: `member_pane` caps its captured last line at 160
// chars (pane evidence can be one enormous line; the cap is the
// ADR-272 P3 pinned exception).
//
// ANSI escapes are stripped first. The strip regex mirrors the
// module-private `stripAnsi` in `src/core/refusal-classifier.ts`
// (CSI sequences) — kept local because that helper is not exported and
// coupling the voice summarizer to the refusal classifier for one
// regex would be a worse dependency than three shared lines.

/** CSI escape sequences (colors, bold, cursor). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC (0x1B) is the literal start byte of ANSI CSI sequences — stripping them is the intent
const ANSI_ESCAPE_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/** Strip ANSI CSI escape sequences. */
export function stripAnsi(input: string): string {
  return input.replace(ANSI_ESCAPE_RE, "");
}

export interface SummarizeResult {
  data: string;
  /** True when content was cut (trailing lines dropped for budget, or
   *  the `member_pane` last-line cap fired). Per-tool SHAPING (e.g.
   *  team_health keeping only non-ok lines) does not count. */
  truncated: boolean;
  /** Line count of the shaped output BEFORE budget truncation. */
  totalLines?: number;
}

/** Cap `text` to its first `maxLines` lines, appending the standard
 *  structural marker when lines were dropped. Exported for the tool
 *  bridge's `limit`-param cap (list_tasks). */
export function capLinesStructural(
  text: string,
  maxLines: number,
): { text: string; dropped: number } {
  const lines = splitTrimmedLines(text);
  if (maxLines <= 0) {
    return lines.length === 0
      ? { text: "", dropped: 0 }
      : { text: `… (+${lines.length} more lines)`, dropped: lines.length };
  }
  if (lines.length <= maxLines) return { text: lines.join("\n"), dropped: 0 };
  const dropped = lines.length - maxLines;
  return {
    text: `${lines.slice(0, maxLines).join("\n")}\n… (+${dropped} more lines)`,
    dropped,
  };
}

/** Split into lines, dropping trailing blank lines (terminal output
 *  almost always ends with a newline; a trailing "" line is noise). */
function splitTrimmedLines(text: string): string[] {
  const lines = text.replace(/\r/g, "").split("\n");
  while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") lines.pop();
  return lines;
}

/** Greedy structural fit: keep leading whole lines while the joined
 *  text (plus marker) stays within `maxChars`. Never cuts mid-line;
 *  when even one line + marker overflows, returns the marker alone. */
function fitWithinChars(lines: string[], maxChars: number): { data: string; dropped: number } {
  const total = lines.length;
  const full = lines.join("\n");
  if (full.length <= maxChars) return { data: full, dropped: 0 };
  for (let keep = total - 1; keep >= 1; keep -= 1) {
    const dropped = total - keep;
    const candidate = `${lines.slice(0, keep).join("\n")}\n… (+${dropped} more lines)`;
    if (candidate.length <= maxChars) return { data: candidate, dropped };
  }
  return { data: `… (+${total} more lines)`, dropped: total };
}

/** `member_pane` last-line cap (chars). */
export const MEMBER_PANE_LAST_LINE_CAP = 160;

/** Lines that read as problems in `health --text` output: a stale
 *  heartbeat marker or a down session. */
const HEALTH_NON_OK_RE = /STALE|\[down\]/;

/**
 * Shape + budget one tool's captured stdout for the voice envelope.
 *
 * Per-tool shaping:
 *   - `team_health` — keep only non-ok lines; when everything is fine,
 *     a one-line ok summary built from the header line.
 *   - `member_pane` — cap the last line at
 *     {@link MEMBER_PANE_LAST_LINE_CAP} chars (the one mid-line cut).
 *   - `list_tasks` / `list_blockers` / `fleet_overview` — header +
 *     first rows within budget (the default head-lines behaviour:
 *     line 1 of each of those verbs is its header row).
 *   - default — head-lines within budget.
 */
export function summarizeTool(
  tool: string,
  stdout: string,
  opts: { maxChars: number },
): SummarizeResult {
  const lines = splitTrimmedLines(stripAnsi(stdout));

  let shaped = lines;
  let capped = false;

  if (tool === "team_health") {
    const bad = lines.filter((l) => HEALTH_NON_OK_RE.test(l));
    if (bad.length > 0) {
      shaped = bad;
    } else if (lines.length > 0) {
      shaped = [`ok — ${lines[0] ?? ""}`];
    }
  }

  if (tool === "member_pane" && shaped.length > 0) {
    const last = shaped[shaped.length - 1] ?? "";
    if (last.length > MEMBER_PANE_LAST_LINE_CAP) {
      shaped = [...shaped.slice(0, -1), `${last.slice(0, MEMBER_PANE_LAST_LINE_CAP - 1)}…`];
      capped = true;
    }
  }

  const { data, dropped } = fitWithinChars(shaped, opts.maxChars);
  return { data, truncated: dropped > 0 || capped, totalLines: shaped.length };
}
