// Unit tests for src/core/vox/summarize.ts — ADR-272 per-tool compact
// envelopes for a voice surface.
//
// Pins:
//   - Truncation is STRUCTURAL: whole trailing lines dropped + a
//     `… (+N more lines)` marker; a line is NEVER cut mid-way. The one
//     carve-out: member_pane caps its last line at 160 chars.
//   - ANSI CSI escapes stripped before shaping.
//   - team_health keeps only non-ok lines (STALE / [down]); an all-ok
//     snapshot collapses to a one-line ok summary.
//   - Default shaping = head-lines within budget (which keeps the
//     header + first rows of every tabular verb).

import { describe, expect, test } from "bun:test";
import {
  capLinesStructural,
  MEMBER_PANE_LAST_LINE_CAP,
  paneGist,
  stripAnsi,
  summarizeTool,
} from "../../../../src/core/vox/summarize.ts";

const BUDGET = { maxChars: 2000 };

describe("stripAnsi", () => {
  test.each([
    ["plain", "hello", "hello"],
    ["bold", "\x1b[1mhello\x1b[0m", "hello"],
    ["color", "\x1b[31mred\x1b[0m ok", "red ok"],
    ["cursor home", "\x1b[H\x1b[2Jtop", "top"],
    ["empty", "", ""],
  ])("%s", (_name, input, expected) => {
    expect(stripAnsi(input)).toBe(expected);
  });
});

describe("default shaping — head-lines within budget", () => {
  test("under budget: data intact, truncated false, totalLines set", () => {
    const out = summarizeTool("team_status", "line1\nline2\nline3\n", BUDGET);
    expect(out).toEqual({ data: "line1\nline2\nline3", truncated: false, totalLines: 3 });
  });

  test("over budget: drops whole trailing lines + appends the marker", () => {
    const lines = Array.from(
      { length: 50 },
      (_, i) => `row-${String(i).padStart(3, "0")}-xxxxxxxxxx`,
    );
    const out = summarizeTool("team_status", lines.join("\n"), { maxChars: 200 });
    expect(out.truncated).toBe(true);
    expect(out.totalLines).toBe(50);
    expect(out.data.length).toBeLessThanOrEqual(200);
    const outLines = out.data.split("\n");
    const marker = outLines[outLines.length - 1] ?? "";
    expect(marker).toMatch(/^… \(\+\d+ more lines\)$/);
    // NEVER mid-line: every kept line is byte-identical to its source.
    for (const l of outLines.slice(0, -1)) {
      expect(lines).toContain(l);
    }
    // Marker count is exact: kept + dropped = total.
    const dropped = Number(/\+(\d+)/.exec(marker)?.[1]);
    expect(outLines.length - 1 + dropped).toBe(50);
  });

  test("keeps the header + first rows of tabular output (list_tasks shape)", () => {
    const stdout = ["ID  STATUS  SUBJECT", "t-1 todo    a", "t-2 todo    b", "t-3 todo    c"].join(
      "\n",
    );
    const out = summarizeTool("list_tasks", stdout, { maxChars: 45 });
    const outLines = out.data.split("\n");
    expect(outLines[0]).toBe("ID  STATUS  SUBJECT");
    expect(outLines[outLines.length - 1]).toMatch(/more lines\)$/);
  });

  test("even one line + marker over budget → marker alone (never a cut line)", () => {
    const out = summarizeTool("list_blockers", `${"x".repeat(500)}\nsecond`, { maxChars: 40 });
    expect(out.data).toBe("… (+2 more lines)");
    expect(out.truncated).toBe(true);
  });

  test("ANSI is stripped before the budget math", () => {
    const out = summarizeTool("fleet_overview", "\x1b[1mheader\x1b[0m\nrow", BUDGET);
    expect(out.data).toBe("header\nrow");
  });

  test("CRLF input normalizes; trailing blank lines dropped", () => {
    const out = summarizeTool("team_status", "a\r\nb\r\n\r\n\r\n", BUDGET);
    expect(out).toEqual({ data: "a\nb", truncated: false, totalLines: 2 });
  });

  test("empty stdout → empty data, zero lines, not truncated", () => {
    expect(summarizeTool("team_status", "", BUDGET)).toEqual({
      data: "",
      truncated: false,
      totalLines: 0,
    });
  });
});

describe("team_health shaping", () => {
  const HEALTHY = [
    "team=atmux  session=atmux [up]",
    "kanban  todo=3  in-progress=1  done=9  blocked=0  driver-inbox=0",
    "",
    "  lead        role=team-lead  hb=12s",
    "  driver-2    role=member     hb=30s",
  ].join("\n");

  test("all ok → one-line ok summary built from the header", () => {
    const out = summarizeTool("team_health", HEALTHY, BUDGET);
    expect(out.data).toBe("ok — team=atmux  session=atmux [up]");
    expect(out.truncated).toBe(false);
    expect(out.totalLines).toBe(1);
  });

  test("keeps only non-ok lines (STALE + [down])", () => {
    const sick = [
      "team=atmux  session=atmux [down]",
      "kanban  todo=3  in-progress=1  done=9  blocked=2  driver-inbox=1",
      "  lead        role=team-lead  hb=12s",
      "  driver-2    role=member     hb=never STALE",
    ].join("\n");
    const out = summarizeTool("team_health", sick, BUDGET);
    expect(out.data).toBe(
      ["team=atmux  session=atmux [down]", "  driver-2    role=member     hb=never STALE"].join(
        "\n",
      ),
    );
    expect(out.truncated).toBe(false);
  });

  test("filtering alone does not set truncated (shaping ≠ truncation)", () => {
    const out = summarizeTool("team_health", HEALTHY, BUDGET);
    expect(out.truncated).toBe(false);
  });

  test("empty health output stays empty", () => {
    expect(summarizeTool("team_health", "", BUDGET).data).toBe("");
  });
});

describe("member_pane last-line cap (the ONE mid-line carve-out)", () => {
  test("last line over the cap is cut to exactly 160 chars ending in …", () => {
    const long = "E".repeat(400);
    const out = summarizeTool("member_pane", `READY\n${long}`, BUDGET);
    const lines = out.data.split("\n");
    expect(lines[0]).toBe("READY");
    expect(lines[1]?.length).toBe(MEMBER_PANE_LAST_LINE_CAP);
    expect(lines[1]?.endsWith("…")).toBe(true);
    expect(out.truncated).toBe(true);
  });

  test("last line at the cap is untouched", () => {
    const exact = "E".repeat(MEMBER_PANE_LAST_LINE_CAP);
    const out = summarizeTool("member_pane", exact, BUDGET);
    expect(out.data).toBe(exact);
    expect(out.truncated).toBe(false);
  });

  test("other tools never get the mid-line cap", () => {
    const long = "E".repeat(400);
    const out = summarizeTool("team_status", long, BUDGET);
    expect(out.data).toBe(long);
    expect(out.truncated).toBe(false);
  });
});

describe("capLinesStructural (the bridge's limit cap)", () => {
  test.each([
    ["under the cap", "a\nb", 5, "a\nb", 0],
    ["exact fit", "a\nb\nc", 3, "a\nb\nc", 0],
    ["drops + marks", "a\nb\nc\nd", 2, "a\nb\n… (+2 more lines)", 2],
    ["header+1", "H\nr1\nr2\nr3", 2, "H\nr1\n… (+2 more lines)", 2],
  ])("%s", (_name, text, maxLines, expectedText, expectedDropped) => {
    expect(capLinesStructural(text, maxLines)).toEqual({
      text: expectedText,
      dropped: expectedDropped,
    });
  });

  test("maxLines ≤ 0 with content → marker only", () => {
    expect(capLinesStructural("a\nb", 0)).toEqual({ text: "… (+2 more lines)", dropped: 2 });
  });

  test("maxLines ≤ 0 with empty text → empty", () => {
    expect(capLinesStructural("", 0)).toEqual({ text: "", dropped: 0 });
  });

  test("trailing newline does not count as a line", () => {
    expect(capLinesStructural("a\nb\n", 2)).toEqual({ text: "a\nb", dropped: 0 });
  });
});

// ---------------------------------------------------------------------
// paneGist — ADR-273 D2's "a gist per pane, not a transcript dump"
// ---------------------------------------------------------------------

describe("paneGist", () => {
  test("takes the LAST meaningful lines, in reading order", () => {
    expect(paneGist("first\nsecond\nthird\nfourth", { maxLines: 2, maxChars: 200 })).toBe(
      "third / fourth",
    );
  });

  test("skips blank lines rather than counting them as content", () => {
    expect(paneGist("real line\n\n   \n\n", { maxLines: 2, maxChars: 200 })).toBe("real line");
  });

  test("strips ANSI, box borders, the composer glyph and spinner glyphs", () => {
    const capture = "[32m│ ❯ [0mclaim --next\n│  ✻ Worked for 22s  │";
    expect(paneGist(capture, { maxLines: 2, maxChars: 200 })).toBe("claim --next / Worked for 22s");
  });

  test("hard-truncates past maxChars with an ellipsis", () => {
    const gist = paneGist("x".repeat(500), { maxLines: 1, maxChars: 20 });
    expect(gist.length).toBe(20);
    expect(gist.endsWith("…")).toBe(true);
  });

  test("a capture with nothing meaningful yields the empty string", () => {
    // The caller decides whether that absence is itself the finding —
    // paneGist does not invent evidence.
    expect(paneGist("\n\n  │  \n", { maxLines: 2, maxChars: 200 })).toBe("");
    expect(paneGist("", { maxLines: 2, maxChars: 200 })).toBe("");
  });

  test("maxLines is a ceiling, not a requirement", () => {
    expect(paneGist("only one", { maxLines: 5, maxChars: 200 })).toBe("only one");
  });

  test("maxChars 0 collapses to the ellipsis rather than throwing", () => {
    expect(paneGist("something", { maxLines: 1, maxChars: 0 })).toBe("…");
  });
});
