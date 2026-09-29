// ADR-200 §D5 — unit tests for the wizard TUI renderers (pure, no IO).

import { describe, expect, test } from "bun:test";
import {
  renderWizardHeader,
  renderWizardStep,
  shouldUseWizardColor,
  WIZARD_GLYPHS,
  WIZARD_STEP_COUNT,
  WIZARD_STEP_TITLES,
} from "../../../src/core/wizard-ui.ts";

describe("renderWizardHeader", () => {
  test("brands the wizard with version", () => {
    const line = renderWizardHeader({ version: "0.0.0-test", color: false });
    expect(line).toContain("atmux init --wizard");
    expect(line).toContain("0.0.0-test");
    expect(line).toContain("guided first-run setup");
  });

  test("plain mode carries no ANSI escapes", () => {
    const line = renderWizardHeader({ version: "1.2.3", color: false });
    expect(line).not.toContain("\u001b");
  });

  test("color mode wraps the same text in ANSI", () => {
    const plain = renderWizardHeader({ version: "1.2.3", color: false });
    const colored = renderWizardHeader({ version: "1.2.3", color: true });
    expect(colored).toContain("\u001b[");
    expect(colored).toContain(plain);
  });
});

describe("renderWizardStep", () => {
  test("numbers steps as Step N/M", () => {
    expect(renderWizardStep(2, 5, "Cockpit init", { color: false })).toBe(
      "Step 2/5 — Cockpit init",
    );
  });

  test("wizard step count is five with matching titles", () => {
    expect(WIZARD_STEP_COUNT).toBe(5);
    expect(WIZARD_STEP_TITLES).toHaveLength(5);
    expect(renderWizardStep(5, WIZARD_STEP_COUNT, WIZARD_STEP_TITLES[4], { color: false })).toBe(
      "Step 5/5 — Skills plugin",
    );
  });

  test("plain mode carries no ANSI escapes", () => {
    expect(renderWizardStep(1, 5, "Prereq probe", { color: false })).not.toContain("\u001b");
  });
});

describe("shouldUseWizardColor", () => {
  test("TTY without overrides → color", () => {
    expect(shouldUseWizardColor({ TERM: "xterm-256color" }, true)).toBe(true);
  });

  test("no TTY degrades to plain", () => {
    expect(shouldUseWizardColor({ TERM: "xterm-256color" }, false)).toBe(false);
  });

  test("NO_COLOR degrades to plain even on a TTY", () => {
    expect(shouldUseWizardColor({ NO_COLOR: "1", TERM: "xterm-256color" }, true)).toBe(false);
  });

  test("dumb terminal degrades to plain even on a TTY", () => {
    expect(shouldUseWizardColor({ TERM: "dumb" }, true)).toBe(false);
  });
});

describe("WIZARD_GLYPHS", () => {
  test("covers the ADR-200 §D5 per-line vocabulary", () => {
    expect(WIZARD_GLYPHS).toEqual({
      done: "✓",
      active: "→",
      failed: "✗",
      skipped: "⏭",
      prompt: "?",
    });
  });
});
