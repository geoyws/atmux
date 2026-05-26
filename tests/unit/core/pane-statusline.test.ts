// Unit tests for src/core/pane-statusline.ts (e-13-04c8b3bf).

import { describe, expect, test } from "bun:test";
import { parseContextPercent } from "../../../src/core/pane-statusline.ts";

describe("parseContextPercent", () => {
  test("extracts percent from canonical Claude statusline", () => {
    const sample = `geoyws@proton.me max  │  Opus 4.7 ·1M ·xhigh  │  ████░░░░░░ 43%  │  5h 21% ↻3h29m · wk 21% ↻5d6h39m  │  tok 431.0k/855`;
    const r = parseContextPercent(sample);
    expect(r).not.toBeNull();
    expect(r!.percent).toBe(43);
    expect(r!.matchedSegment).toContain("43%");
  });

  test("matches when context bar is at high saturation (≥90%)", () => {
    const sample = `… │  ██████████ 97%  │ 5h 80% ↻30m │ …`;
    const r = parseContextPercent(sample);
    expect(r!.percent).toBe(97);
  });

  test("matches when context bar is low (≤10%)", () => {
    const sample = `…  │  █░░░░░░░░░ 7%  │ …`;
    const r = parseContextPercent(sample);
    expect(r!.percent).toBe(7);
  });

  test("returns null when no bar-pattern in capture (e.g. bash pane)", () => {
    expect(parseContextPercent("root@hax:~# ls -la\ntotal 0")).toBeNull();
  });

  test("returns null when bar present but no % digit", () => {
    expect(parseContextPercent("████░░░░░░ pending")).toBeNull();
  });

  test("ignores other percentages outside bar segment (5h 21% / wk 21%)", () => {
    // No bar — should not pick up the 21% from rate-limit segment.
    const sample = `5h 21% ↻3h29m · wk 21% ↻5d6h39m`;
    expect(parseContextPercent(sample)).toBeNull();
  });

  test("ignores 3-digit values >100 (defensive — clamps via Number range)", () => {
    // Hypothetical garbage statusline; ensure no false positive emit.
    const sample = `████░░░░ 150%`;
    expect(parseContextPercent(sample)).toBeNull();
  });

  test("returns the raw capture so callers can include in event payload", () => {
    const sample = `pre\n│ ███ 33% │\npost`;
    const r = parseContextPercent(sample);
    expect(r!.rawCapture).toBe(sample);
  });
});
