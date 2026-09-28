// Unit tests for src/core/superdriver.ts (ADR-296).
//
// The per-team `superdriver` orchestration seat resolves from the
// optional `team.json::superdriver` block: absent == enabled with
// defaults (legacy team.json files gain the seat without migration),
// `{"enabled": false}` opts out. `tui` passes through verbatim
// (null/absent → zsh floor), `windowName` is always `"superdriver"`,
// `cwd` is always the pinned repo root.

import { describe, expect, test } from "bun:test";
import {
  resolveSuperdriver,
  SUPERDRIVER_LANE,
  SUPERDRIVER_WINDOW_NAME,
} from "../../../src/core/superdriver.ts";

describe("SUPERDRIVER_WINDOW_NAME / SUPERDRIVER_LANE constants", () => {
  test("canonical window name is the bare `superdriver`", () => {
    expect(SUPERDRIVER_WINDOW_NAME).toBe("superdriver");
  });

  test("lane field is `superdriver` with no shortform", () => {
    // `sd` already means the cockpit-tier `_sd` lanes (ADR-290).
    expect(SUPERDRIVER_LANE).toBe("superdriver");
  });
});

describe("resolveSuperdriver — enabled default", () => {
  test("absent block resolves to enabled (legacy team.json gains the seat)", () => {
    const r = resolveSuperdriver({} as never, "/repo");
    expect(r.enabled).toBe(true);
  });

  test("empty block `{}` resolves to enabled", () => {
    const r = resolveSuperdriver({ superdriver: {} }, "/repo");
    expect(r.enabled).toBe(true);
  });

  test("explicit `{enabled: true}` resolves to enabled", () => {
    const r = resolveSuperdriver({ superdriver: { enabled: true } }, "/repo");
    expect(r.enabled).toBe(true);
  });

  test("explicit `{enabled: false}` opts out", () => {
    const r = resolveSuperdriver({ superdriver: { enabled: false } }, "/repo");
    expect(r.enabled).toBe(false);
  });
});

describe("resolveSuperdriver — tui passthrough", () => {
  test("absent tui stays absent (zsh floor)", () => {
    expect(resolveSuperdriver({}, "/repo").tui).toBeUndefined();
    expect(resolveSuperdriver({ superdriver: {} }, "/repo").tui).toBeUndefined();
  });

  test("null tui passes through as null (zsh floor)", () => {
    expect(resolveSuperdriver({ superdriver: { tui: null } }, "/repo").tui).toBeNull();
  });

  test("named tui passes through verbatim", () => {
    expect(resolveSuperdriver({ superdriver: { tui: "codex" } }, "/repo").tui).toBe("codex");
  });

  test("tui passes through even when disabled", () => {
    const r = resolveSuperdriver({ superdriver: { enabled: false, tui: "codex" } }, "/repo");
    expect(r.enabled).toBe(false);
    expect(r.tui).toBe("codex");
  });
});

describe("resolveSuperdriver — seat pinning", () => {
  test("windowName is always `superdriver`", () => {
    expect(resolveSuperdriver({}, "/repo").windowName).toBe("superdriver");
    expect(resolveSuperdriver({ superdriver: { enabled: false } }, "/repo").windowName).toBe(
      "superdriver",
    );
  });

  test("cwd is pinned to the given project root (never a worktree)", () => {
    expect(resolveSuperdriver({}, "/repo").cwd).toBe("/repo");
    expect(resolveSuperdriver({ superdriver: {} }, "/other/root").cwd).toBe("/other/root");
  });

  test("default project root is `.`", () => {
    expect(resolveSuperdriver({}).cwd).toBe(".");
  });
});
