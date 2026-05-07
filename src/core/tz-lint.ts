// ADR-057 §D5d: TZ-explicit timestamp lint.
//
// Scans user-facing-emit source files for bare `HH:MM` literals that
// aren't followed by `MYT` or `+08:00`. Catches developer mistakes
// where a literal like `"emitted at 03:44"` would land in driver-inbox /
// lead-outbox / decisions.md / flags.md as a bare time the operator
// has to mentally TZ-convert.
//
// Reviewer-gate enforces — verbs that emit user-facing timestamps to
// any of the tracked files are required to format via
// `abstractions/time.formatMyt` / `formatMytFull`, never via inline
// templated `HH:MM` literals.
//
// Pure file-content scanner; the CLI wrapper at `scripts/lint-tz.ts`
// reads files from disk and prints findings. Tests drive the pure
// function with in-memory contents.

/** One lint finding — an offending literal in a tracked file. */
export interface TzLintFinding {
  /** File path (as supplied by the caller). */
  file: string;
  /** 1-based line number. */
  line: number;
  /** The offending matched literal (e.g. `"03:44"`). */
  match: string;
  /** Surrounding line for the operator's context. */
  context: string;
}

/** Default tracked files per ADR-057 §D5d brief. Callers may override. */
export const DEFAULT_TRACKED_FILES: ReadonlyArray<string> = [
  "src/verbs/tell-lead.ts",
  "src/verbs/reply.ts",
  "src/verbs/report.ts",
];

// Match `HH:MM` inside double-quoted, single-quoted, or template strings.
// Capture the leading delimiter so we can restrict to string-literal
// contexts (avoid object-key `field: 03:44` non-strings — though those
// don't compile anyway, so the boundary is mostly belt-and-suspenders).
//
// We accept any `\d{2}:\d{2}` shape; negative-lookahead enforces the
// MYT-or-+08:00 suffix. Bare seconds (`HH:MM:SS`) without TZ are also
// flagged — we treat the broader `HH:MM[:SS]` as the same risk class
// per CLAUDE.md "Timezone" rule.
const BARE_HHMM_RE = /(["'`])([^"'`\n]*?\b(\d{2}:\d{2}(?::\d{2})?)\b[^"'`\n]*?)\1/g;

// Exemptions — even inside a string literal, these aren't user-facing
// HH:MM times we care about flagging.
function isExempt(literalBody: string, time: string): boolean {
  // 1. Followed by " MYT" or "+08:00" — explicitly TZ-suffixed.
  const idx = literalBody.indexOf(time);
  const tail = literalBody.slice(idx + time.length);
  if (/^\s*MYT\b/.test(tail)) return true;
  if (/^\+08:00\b/.test(tail)) return true;
  // 2. ISO 8601 timestamp shape — preceded by `T` or `YYYY-MM-DDT`.
  const head = literalBody.slice(0, idx);
  if (/T$/.test(head) || /\d{4}-\d{2}-\d{2}T?$/.test(head)) return true;
  // 3. Cron-expression shape — e.g. `*/5 * * * *` won't match `\d{2}:\d{2}`,
  //    but `0 0 * * *` etc. are out anyway. No special-case needed.
  // 4. Literal is itself a TZ offset (e.g. `+05:30` for India) — the
  //    `+` prefix means the leading capture char isn't a colon-time.
  if (/[-+]$/.test(head)) return true;
  // 5. Looks like a duration / range delimiter (e.g. `00:00 - 23:59`).
  //    Fine to flag those too; they're still bare HH:MM in user output.
  return false;
}

/**
 * Scan one file's contents for bare HH:MM literals lacking TZ suffix.
 * Comments are stripped before scanning to avoid false positives in
 * documentation that mentions example timestamps without TZ.
 */
export function lintFileContent(filePath: string, content: string): TzLintFinding[] {
  const findings: TzLintFinding[] = [];
  const lines = content.split("\n");
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    const stripped = stripComments(raw, inBlockComment);
    inBlockComment = stripped.endsBlockOpen;
    const code = stripped.code;
    if (code.trim().length === 0) continue;
    for (const m of code.matchAll(BARE_HHMM_RE)) {
      const literalBody = m[2] ?? "";
      const time = m[3] ?? "";
      if (isExempt(literalBody, time)) continue;
      findings.push({
        file: filePath,
        line: i + 1,
        match: time,
        context: raw.trim(),
      });
    }
  }
  return findings;
}

/**
 * Strip comments from a single source line. Tracks /\* ... *\/ block
 * state across lines via the inBlockComment flag. Returns the
 * code-only portion + whether the resulting state at line-end is
 * still inside a block comment (so the caller can carry it forward).
 *
 * Conservative — string-literal contents that LOOK like comments
 * (`"// not a comment"`) are not stripped; tracking that without a
 * full TS tokenizer would be over-engineering for a regex-grade lint.
 */
function stripComments(
  line: string,
  startInBlock: boolean,
): { code: string; endsBlockOpen: boolean } {
  let inBlock = startInBlock;
  let inString: '"' | "'" | "`" | null = null;
  let out = "";
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] ?? "";
    const next = line[i + 1] ?? "";
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString !== null) {
      out += ch;
      if (ch === "\\") {
        if (next.length > 0) {
          out += next;
          i += 1;
        }
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      // line comment — drop rest of line
      break;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i += 1;
      continue;
    }
    out += ch;
  }
  return { code: out, endsBlockOpen: inBlock };
}
