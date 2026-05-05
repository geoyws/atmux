// ADR-003: src/core/tui.ts — ANSI / TTY helpers for status, dashboard, doctor.
//
// Bash port targets:
//   - lib/common.sh §colors + atmux::log/ok/warn/die  → AnsiPalette + Logger
//   - lib/dashboard.sh §full-screen redraw chrome     → CSI cursor codes
//   - lib/status.sh §column-padded member table       → padding + grapheme helpers
//   - lib/doctor.sh §status-glyph line format         → doctorLine
//
// Pure rendering: every function returns a string the caller writes to
// its sink; the only stateful primitive is the optional `Logger` whose
// sink defaults to `process.stderr.write` (overridable for tests). No
// JSON I/O, no spawn, no fs — keeps tui.ts test-deterministic and lets
// verb code compose the exact output shape it needs.

import { ConfigError } from "../errors.ts";

// ---------- ANSI palette ----------

export interface AnsiPalette {
  readonly red: string;
  readonly grn: string;
  readonly yel: string;
  readonly cyn: string;
  readonly mag: string;
  readonly blu: string;
  readonly dim: string;
  readonly bld: string;
  readonly rst: string;
}

/** Empty palette for pipes / non-TTY contexts / NO_COLOR users. */
export const NO_COLOR: AnsiPalette = {
  red: "",
  grn: "",
  yel: "",
  cyn: "",
  mag: "",
  blu: "",
  dim: "",
  bld: "",
  rst: "",
};

/** Standard 16-color ANSI palette. Mirrors bash lib/common.sh §colors. */
export const ANSI: AnsiPalette = {
  red: "\x1b[31m",
  grn: "\x1b[32m",
  yel: "\x1b[33m",
  cyn: "\x1b[36m",
  mag: "\x1b[35m",
  blu: "\x1b[34m",
  dim: "\x1b[2m",
  bld: "\x1b[1m",
  rst: "\x1b[0m",
};

export interface PaletteOpts {
  /** Whether the output sink is a TTY (typically `process.stdout.isTTY`). */
  isTty: boolean;
  /** Honor https://no-color.org — when true, force NO_COLOR even on TTY. */
  noColor?: boolean;
}

/** Pick a palette: ANSI on TTY without NO_COLOR; NO_COLOR otherwise. */
export function paletteFor(opts: PaletteOpts): AnsiPalette {
  if (opts.noColor === true || !opts.isTty) return NO_COLOR;
  return ANSI;
}

/** Read TTY status + NO_COLOR env to derive the default palette.
 *  Mirrors bash lib/common.sh's `[[ -t 1 ]]` gate. */
export function defaultPalette(
  opts: { isTty?: boolean; env?: NodeJS.ProcessEnv } = {},
): AnsiPalette {
  const env = opts.env ?? process.env;
  const isTty = opts.isTty ?? process.stdout.isTTY === true;
  const noColorRaw = env.NO_COLOR;
  const noColor = noColorRaw !== undefined && noColorRaw.length > 0;
  return paletteFor({ isTty, noColor });
}

// ---------- Logger ----------
//
// Bash atmux::log / atmux::ok / atmux::warn / atmux::die emit to stderr
// with a "🔹/✅/⚠️/💥 atmux" prefix; ok/warn/err layer color on the body.
// die() exits — TS port returns the formatted string and lets the verb
// throw/return so we honor R7 (no process.exit outside cli.ts).

export interface Logger {
  /** Neutral progress message. Equivalent to bash `atmux::log`. */
  log(msg: string): void;
  /** Success. Equivalent to bash `atmux::ok`. */
  ok(msg: string): void;
  /** Warning. Equivalent to bash `atmux::warn`. */
  warn(msg: string): void;
  /** Error. Equivalent to bash `atmux::die` minus the exit (R7). */
  err(msg: string): void;
}

export interface LoggerOpts {
  palette?: AnsiPalette;
  /** Sink for formatted lines. Each call passes one already-newline-terminated
   *  string. Defaults to stderr. */
  sink?: (line: string) => void;
}

/** Construct a logger with the given palette + sink. */
export function createLogger(opts: LoggerOpts = {}): Logger {
  const p = opts.palette ?? defaultPalette();
  const sink = opts.sink ?? defaultLoggerSink;
  return {
    log: (msg) => sink(`${p.cyn}🔹 atmux${p.rst} ${msg}\n`),
    ok: (msg) => sink(`${p.cyn}✅ atmux${p.rst} ${p.grn}${msg}${p.rst}\n`),
    warn: (msg) => sink(`${p.cyn}⚠️  atmux${p.rst} ${p.yel}${msg}${p.rst}\n`),
    err: (msg) => sink(`${p.cyn}💥 atmux${p.rst} ${p.red}${msg}${p.rst}\n`),
  };
}

function defaultLoggerSink(line: string): void {
  process.stderr.write(line);
}

// ---------- Cursor / screen control ----------

export const CSI = {
  /** Clear the entire screen. */
  clearScreen: "\x1b[2J",
  /** Move cursor to row 1, col 1. */
  cursorHome: "\x1b[H",
  /** Hide the cursor (use during full-screen redraws). */
  cursorHide: "\x1b[?25l",
  /** Show the cursor (always emit on exit/restore). */
  cursorShow: "\x1b[?25h",
  /** Clear from cursor to end of line. */
  clearLine: "\x1b[2K",
} as const;

/** Bash dashboard.sh's `\e[H\e[2J` redraw preamble. */
export function clearAndHome(): string {
  return `${CSI.cursorHome}${CSI.clearScreen}`;
}

// ---------- Section divider ----------
//
// Bash dashboard.sh emits `─── recent kanban ───` style separators. Width
// defaults match the bash output (3-char rule + label + 3-char rule).

export interface DividerOpts {
  /** Total approximate width in graphemes. Defaults to 30. */
  width?: number;
  /** Rule glyph. Defaults to U+2500 BOX DRAWINGS LIGHT HORIZONTAL. */
  rule?: string;
}

export function divider(label: string, opts: DividerOpts = {}): string {
  const width = opts.width ?? 30;
  const rule = opts.rule ?? "─";
  const labelLen = visualLength(label);
  const space = label.length === 0 ? 0 : 2; // " label " padding
  const remaining = Math.max(0, width - labelLen - space);
  const half = Math.floor(remaining / 2);
  const left = rule.repeat(half);
  const right = rule.repeat(remaining - half);
  if (label.length === 0) return left + right;
  return `${left} ${label} ${right}`;
}

// ---------- Doctor line (mirror of doctor.sh status-line format) ----------

export type DoctorStatus = "green" | "yellow" | "red";

const DOCTOR_GLYPHS: Readonly<Record<DoctorStatus, string>> = {
  green: "✅",
  yellow: "⚠️ ",
  red: "❌",
};

export interface DoctorLineOpts {
  status: DoctorStatus;
  /** ≤22 graphemes recommended (bash printf %-22s budget); over-budget
   *  labels are right-padded but visually overflow into the detail column. */
  label: string;
  detail?: string;
  hint?: string;
  palette?: AnsiPalette;
}

/** Renders the bash doctor line: `  <glyph> <color><label %-22s><rst> <detail>`
 *  plus an optional `     → <dim><hint><rst>` continuation line. Returns one
 *  newline-terminated block. */
export function doctorLine(opts: DoctorLineOpts): string {
  const p = opts.palette ?? defaultPalette();
  const glyph = DOCTOR_GLYPHS[opts.status];
  const color = colorForDoctorStatus(opts.status, p);
  const labelPad = padEnd(opts.label, 22);
  const detail = opts.detail !== undefined && opts.detail.length > 0 ? ` ${opts.detail}` : "";
  let out = `  ${glyph} ${color}${labelPad}${p.rst}${detail}\n`;
  if (opts.hint !== undefined && opts.hint.length > 0) {
    out += `     ${p.dim}→ ${opts.hint}${p.rst}\n`;
  }
  return out;
}

function colorForDoctorStatus(s: DoctorStatus, p: AnsiPalette): string {
  switch (s) {
    case "green":
      return p.grn;
    case "yellow":
      return p.yel;
    case "red":
      return p.red;
  }
}

// ---------- Status table (column-padded rows) ----------
//
// Bash status.sh prints a fixed-column table; each column has a min
// width and left-alignment, with grapheme-aware padding so emoji-in-name
// doesn't ragged the display.

export interface TableColumn {
  /** Header label (rendered in the dim row above the data). */
  header: string;
  /** Min display width in graphemes. Cells under this get padded;
   *  cells over this overflow visually (we don't truncate by default —
   *  truncation is opt-in via `padCell({ truncate: true })`). */
  width: number;
  /** "left" pads on the right; "right" pads on the left. Default left. */
  align?: "left" | "right";
}

export interface PadOpts {
  align?: "left" | "right";
  /** When true, oversized strings are truncated to `width`. Default false
   *  (matches bash printf %-Ns: oversized cells push the row wider). */
  truncate?: boolean;
}

/** Grapheme-aware pad. Default left-align (right-pad) matches bash %-Ns. */
export function padCell(s: string, width: number, opts: PadOpts = {}): string {
  const align = opts.align ?? "left";
  const truncate = opts.truncate ?? false;
  const len = visualLength(s);
  if (len === width) return s;
  if (len > width) return truncate ? truncateGraphemes(s, width) : s;
  const pad = " ".repeat(width - len);
  return align === "left" ? s + pad : pad + s;
}

/** Convenience right-pad (bash `printf '%-Ns'` parity). */
export function padEnd(s: string, width: number): string {
  return padCell(s, width, { align: "left" });
}

/** Convenience left-pad (bash `printf '%Ns'` parity). */
export function padStart(s: string, width: number): string {
  return padCell(s, width, { align: "right" });
}

/** Render a row from cell values aligned to columns. Cells join with
 *  a single space, matching bash status.sh's column joiner. */
export function renderRow(
  values: ReadonlyArray<string>,
  columns: ReadonlyArray<TableColumn>,
): string {
  if (values.length !== columns.length) {
    throw new ConfigError({
      what: `tui.renderRow: ${values.length} values for ${columns.length} columns`,
      hint: "row width must equal column count",
    });
  }
  return columns
    .map((col, i) => padCell(values[i] ?? "", col.width, { align: col.align ?? "left" }))
    .join(" ");
}

/** Render the dim header row from the column list. */
export function renderHeader(
  columns: ReadonlyArray<TableColumn>,
  palette?: AnsiPalette,
): string {
  const p = palette ?? defaultPalette();
  const headers = columns.map((c) => padCell(c.header, c.width, { align: c.align ?? "left" }));
  return `${p.dim}${headers.join(" ")}${p.rst}`;
}

// ---------- Grapheme helpers ----------
//
// Status table emojis count visually as 1 cluster; naive `.length`
// over-counts their UTF-16 surrogate pairs. We use `Intl.Segmenter`
// with grapheme granularity — close enough to "visual cells" for
// CLI tables, and stable across Bun + Node.

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Count grapheme clusters in `s`. Approximates terminal cell width. */
export function visualLength(s: string): number {
  let n = 0;
  // Iterating via Symbol.iterator avoids materialising the segments array.
  for (const _ of SEGMENTER.segment(s)) {
    n++;
  }
  return n;
}

/** Truncate to at most `max` graphemes. Non-positive `max` returns "". */
export function truncateGraphemes(s: string, max: number): string {
  if (max <= 0) return "";
  let out = "";
  let n = 0;
  for (const seg of SEGMENTER.segment(s)) {
    if (n >= max) break;
    out += seg.segment;
    n++;
  }
  return out;
}
