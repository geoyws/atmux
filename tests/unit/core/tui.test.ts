// Unit tests for src/core/tui.ts (ADR-003).

import { describe, expect, test } from "bun:test";
import {
  ANSI,
  CSI,
  NO_COLOR,
  clearAndHome,
  createLogger,
  defaultPalette,
  divider,
  doctorLine,
  padCell,
  padEnd,
  padStart,
  paletteFor,
  renderHeader,
  renderRow,
  truncateGraphemes,
  visualLength,
} from "../../../src/core/tui.ts";
import { ConfigError } from "../../../src/errors.ts";

// ---------- ANSI palette ----------

describe("paletteFor", () => {
  test("ANSI on TTY without NO_COLOR", () => {
    expect(paletteFor({ isTty: true })).toBe(ANSI);
  });

  test("NO_COLOR when forced even on TTY", () => {
    expect(paletteFor({ isTty: true, noColor: true })).toBe(NO_COLOR);
  });

  test("NO_COLOR off-TTY regardless of noColor flag", () => {
    expect(paletteFor({ isTty: false })).toBe(NO_COLOR);
    expect(paletteFor({ isTty: false, noColor: false })).toBe(NO_COLOR);
  });

  test("ANSI palette has actual escape sequences", () => {
    expect(ANSI.red).toBe("\x1b[31m");
    expect(ANSI.rst).toBe("\x1b[0m");
  });

  test("NO_COLOR palette is all empty strings", () => {
    expect(NO_COLOR.red).toBe("");
    expect(NO_COLOR.bld).toBe("");
  });
});

describe("defaultPalette", () => {
  test("explicit isTty + empty NO_COLOR env → ANSI", () => {
    expect(defaultPalette({ isTty: true, env: {} })).toBe(ANSI);
  });

  test("explicit isTty + NO_COLOR=1 → empty palette", () => {
    expect(defaultPalette({ isTty: true, env: { NO_COLOR: "1" } })).toBe(NO_COLOR);
  });

  test("non-TTY → NO_COLOR", () => {
    expect(defaultPalette({ isTty: false, env: {} })).toBe(NO_COLOR);
  });

  test("empty NO_COLOR string treated as unset", () => {
    expect(defaultPalette({ isTty: true, env: { NO_COLOR: "" } })).toBe(ANSI);
  });

  test("no opts → reads process state", () => {
    // Smoke: just ensure it returns one of the two known palettes without
    // throwing (bun test runs typically have isTTY=false → NO_COLOR).
    const got = defaultPalette();
    expect(got === ANSI || got === NO_COLOR).toBe(true);
  });

  test("opts only sets isTty (env defaults to process.env)", () => {
    const got = defaultPalette({ isTty: false });
    expect(got).toBe(NO_COLOR);
  });
});

// ---------- Logger ----------

describe("createLogger", () => {
  test("log/ok/warn/err each emit one newline-terminated line", () => {
    const out: string[] = [];
    const logger = createLogger({
      palette: NO_COLOR,
      sink: (line) => out.push(line),
    });
    logger.log("a");
    logger.ok("b");
    logger.warn("c");
    logger.err("d");
    expect(out).toEqual([
      "🔹 atmux a\n",
      "✅ atmux b\n",
      "⚠️  atmux c\n",
      "💥 atmux d\n",
    ]);
  });

  test("ANSI palette wraps body in color codes", () => {
    const out: string[] = [];
    const logger = createLogger({ palette: ANSI, sink: (l) => out.push(l) });
    logger.ok("done");
    expect(out[0]).toContain(ANSI.grn);
    expect(out[0]).toContain("done");
    expect(out[0]).toContain(ANSI.rst);
  });

  test("default palette + default sink writes to stderr", () => {
    // Capture stderr.write to exercise the default-sink lambda. Restore
    // unconditionally so a failed expect doesn't leak the mock.
    const calls: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (c: unknown) => boolean }).write = (
      chunk: unknown,
    ): boolean => {
      calls.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    };
    try {
      const logger = createLogger({ palette: NO_COLOR });
      logger.log("hello");
    } finally {
      process.stderr.write = orig;
    }
    expect(calls).toEqual(["🔹 atmux hello\n"]);
  });
});

// ---------- CSI / clearAndHome ----------

describe("CSI / clearAndHome", () => {
  test("CSI codes are real escape sequences", () => {
    expect(CSI.clearScreen).toBe("\x1b[2J");
    expect(CSI.cursorHome).toBe("\x1b[H");
    expect(CSI.cursorHide).toBe("\x1b[?25l");
    expect(CSI.cursorShow).toBe("\x1b[?25h");
    expect(CSI.clearLine).toBe("\x1b[2K");
  });

  test("clearAndHome composes home + clear", () => {
    expect(clearAndHome()).toBe("\x1b[H\x1b[2J");
  });
});

// ---------- divider ----------

describe("divider", () => {
  test("default width 30, balanced rules around label", () => {
    const out = divider("recent kanban");
    expect(out).toContain(" recent kanban ");
    expect(out.startsWith("─")).toBe(true);
    expect(out.endsWith("─")).toBe(true);
  });

  test("custom width", () => {
    const out = divider("x", { width: 10 });
    // total visual width: 3 dashes + " x " + 4 dashes (or 4+3) = 10
    expect(visualLength(out)).toBe(10);
  });

  test("custom rule glyph", () => {
    const out = divider("ok", { width: 10, rule: "=" });
    expect(out).toContain("==");
    expect(out).not.toContain("─");
  });

  test("empty label: just the rule line, no surrounding spaces", () => {
    const out = divider("", { width: 10 });
    expect(out).toBe("──────────");
  });

  test("label longer than width: zero rule chars on each side", () => {
    const out = divider("oversized-label", { width: 5 });
    expect(out).toContain(" oversized-label ");
    // Width ran negative → both sides empty
    expect(out.startsWith(" ")).toBe(true);
    expect(out.endsWith(" ")).toBe(true);
  });
});

// ---------- doctorLine ----------

describe("doctorLine", () => {
  test("green status — glyph + label + detail", () => {
    const out = doctorLine({
      status: "green",
      label: "tmux installed",
      detail: "v3.4",
      palette: NO_COLOR,
    });
    expect(out).toContain("✅");
    expect(out).toContain("tmux installed");
    expect(out).toContain("v3.4");
    expect(out.endsWith("\n")).toBe(true);
  });

  test("yellow status uses ⚠️ glyph", () => {
    expect(doctorLine({ status: "yellow", label: "x", palette: NO_COLOR })).toContain("⚠️");
  });

  test("red status uses ❌ glyph", () => {
    expect(doctorLine({ status: "red", label: "x", palette: NO_COLOR })).toContain("❌");
  });

  test("hint adds the dim continuation line", () => {
    const out = doctorLine({
      status: "yellow",
      label: "tmux version old",
      detail: "v2.9",
      hint: "upgrade to ≥ 3.4 for full feature support",
      palette: NO_COLOR,
    });
    expect(out).toContain("→ upgrade to ≥ 3.4");
    expect(out.split("\n").filter((l) => l.length > 0)).toHaveLength(2);
  });

  test("ANSI palette wraps label in color, hint in dim", () => {
    const out = doctorLine({
      status: "red",
      label: "x",
      detail: "broken",
      hint: "fix it",
      palette: ANSI,
    });
    expect(out).toContain(ANSI.red);
    expect(out).toContain(ANSI.dim);
    expect(out).toContain(ANSI.rst);
  });

  test("no detail / no hint → single line, no extra padding", () => {
    const out = doctorLine({ status: "green", label: "ok", palette: NO_COLOR });
    expect(out.split("\n").filter((l) => l.length > 0)).toHaveLength(1);
  });

  test("uses default palette when none passed (smoke, no throw)", () => {
    const out = doctorLine({ status: "green", label: "x" });
    expect(typeof out).toBe("string");
    expect(out).toContain("✅");
  });
});

// ---------- Status-table column padding ----------

describe("padCell / padEnd / padStart", () => {
  test("padCell left-aligns by default", () => {
    expect(padCell("ab", 5)).toBe("ab   ");
  });

  test("padCell right-aligns when align=right", () => {
    expect(padCell("ab", 5, { align: "right" })).toBe("   ab");
  });

  test("exact-fit returns input verbatim", () => {
    expect(padCell("hello", 5)).toBe("hello");
  });

  test("oversize without truncate returns input verbatim (bash %-Ns parity)", () => {
    expect(padCell("longer-than-width", 5)).toBe("longer-than-width");
  });

  test("oversize with truncate clamps to width", () => {
    expect(padCell("longer-than-width", 5, { truncate: true })).toBe("longe");
  });

  test("emoji counts as one grapheme — 4-cell pad after emoji", () => {
    // 🦊 + 4 spaces = 5 total
    expect(padCell("🦊", 5)).toBe("🦊    ");
  });

  test("padEnd: right-pad alias", () => {
    expect(padEnd("ab", 5)).toBe("ab   ");
  });

  test("padStart: left-pad alias", () => {
    expect(padStart("ab", 5)).toBe("   ab");
  });
});

describe("renderRow / renderHeader", () => {
  const cols = [
    { header: "name", width: 10 },
    { header: "role", width: 8 },
    { header: "n", width: 4, align: "right" as const },
  ];

  test("renderRow pads each cell + joins with single space", () => {
    const got = renderRow(["alice", "lead", "3"], cols);
    // alice (5) padded to 10 → 5 trailing spaces, " " join, lead (4) padded
    // to 8 → 4 trailing spaces, " " join, "3" right-padded to 4 → 3 leading
    // spaces. Total visual: 10 + 1 + 8 + 1 + 4 = 24.
    expect(got).toBe("alice      lead        3");
    expect(got.length).toBe(24);
  });

  test("renderRow throws on length mismatch", () => {
    expect(() => renderRow(["a"], cols)).toThrow(ConfigError);
  });

  test("renderHeader emits dim-wrapped column headers", () => {
    const got = renderHeader(cols, ANSI);
    expect(got.startsWith(ANSI.dim)).toBe(true);
    expect(got.endsWith(ANSI.rst)).toBe(true);
    expect(got).toContain("name");
    expect(got).toContain("role");
  });

  test("renderHeader with default palette doesn't throw", () => {
    const got = renderHeader(cols);
    expect(got).toContain("name");
  });
});

// ---------- Grapheme helpers ----------

describe("visualLength / truncateGraphemes", () => {
  test("ASCII counts character-for-character", () => {
    expect(visualLength("hello")).toBe(5);
  });

  test("emoji counts as one cluster", () => {
    expect(visualLength("🦊")).toBe(1);
    expect(visualLength("🟢🔴🟡")).toBe(3);
  });

  test("zero-width-joiner sequences count as one cluster", () => {
    // Family ZWJ sequence: 👨‍👩‍👧 = three person codepoints + ZWJs = 1 grapheme
    expect(visualLength("👨‍👩‍👧")).toBe(1);
  });

  test("empty string → 0", () => {
    expect(visualLength("")).toBe(0);
  });

  test("truncateGraphemes clamps to N graphemes", () => {
    expect(truncateGraphemes("hello world", 5)).toBe("hello");
    expect(truncateGraphemes("🦊🐝🐢", 2)).toBe("🦊🐝");
  });

  test("truncateGraphemes: max=0 returns empty", () => {
    expect(truncateGraphemes("hello", 0)).toBe("");
  });

  test("truncateGraphemes: negative max returns empty", () => {
    expect(truncateGraphemes("hello", -1)).toBe("");
  });

  test("truncateGraphemes: max ≥ length returns full string", () => {
    expect(truncateGraphemes("hi", 100)).toBe("hi");
  });
});
