// Unit tests for src/core/perm-mode-drift-state.ts (ADR-057 §D4a).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_DEDUP_TTL_SEC,
  loadPermModeDriftState,
  type PermModeDriftState,
  parsePermissionMode,
  permModeDriftStatePath,
  recordDrift,
  savePermModeDriftState,
  shouldFireDrift,
} from "../../../src/core/perm-mode-drift-state.ts";

describe("permModeDriftStatePath", () => {
  test("places file under <atmuxDir>/state/perm-mode-drift-state.json", () => {
    expect(permModeDriftStatePath("/x/.atmux")).toBe("/x/.atmux/state/perm-mode-drift-state.json");
  });
});

describe("loadPermModeDriftState", () => {
  let dir: string;
  let atmuxDir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atmux-permdrift-load-"));
    atmuxDir = join(dir, ".atmux");
    await mkdir(join(atmuxDir, "state"), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("absent file → empty map", async () => {
    expect(await loadPermModeDriftState(atmuxDir)).toEqual({});
  });

  test("malformed JSON → empty map", async () => {
    await writeFile(permModeDriftStatePath(atmuxDir), "{not json");
    expect(await loadPermModeDriftState(atmuxDir)).toEqual({});
  });

  test("non-object root → empty map", async () => {
    await writeFile(permModeDriftStatePath(atmuxDir), JSON.stringify(["array"]));
    expect(await loadPermModeDriftState(atmuxDir)).toEqual({});
  });

  test("entries with non-numeric values are skipped", async () => {
    await writeFile(
      permModeDriftStatePath(atmuxDir),
      JSON.stringify({ alpha: 100, bravo: "not-number", charlie: 200 }),
    );
    const state = await loadPermModeDriftState(atmuxDir);
    expect(state).toEqual({ alpha: 100, charlie: 200 });
  });

  test("round-trip via savePermModeDriftState", async () => {
    const seed: PermModeDriftState = { alpha: 1, bravo: 2 };
    await savePermModeDriftState(atmuxDir, seed);
    expect(await loadPermModeDriftState(atmuxDir)).toEqual(seed);
  });
});

describe("shouldFireDrift", () => {
  test("never-fired member → fire", () => {
    expect(shouldFireDrift({}, "alpha", 1000)).toBe(true);
  });

  test("within TTL → no fire", () => {
    const state: PermModeDriftState = { alpha: 1000 };
    expect(shouldFireDrift(state, "alpha", 1000 + DEFAULT_DEDUP_TTL_SEC - 1)).toBe(false);
  });

  test("past TTL → fire", () => {
    const state: PermModeDriftState = { alpha: 1000 };
    expect(shouldFireDrift(state, "alpha", 1000 + DEFAULT_DEDUP_TTL_SEC + 1)).toBe(true);
  });

  test("custom TTL respected", () => {
    const state: PermModeDriftState = { alpha: 1000 };
    expect(shouldFireDrift(state, "alpha", 1100, 50)).toBe(true);
    expect(shouldFireDrift(state, "alpha", 1040, 50)).toBe(false);
  });
});

describe("recordDrift", () => {
  test("inserts new member", () => {
    expect(recordDrift({}, "alpha", 100)).toEqual({ alpha: 100 });
  });

  test("updates existing member without mutating input", () => {
    const before: PermModeDriftState = { alpha: 100, bravo: 200 };
    const after = recordDrift(before, "alpha", 999);
    expect(after).toEqual({ alpha: 999, bravo: 200 });
    expect(before).toEqual({ alpha: 100, bravo: 200 });
  });
});

describe("parsePermissionMode", () => {
  test("auto mode", () => {
    expect(parsePermissionMode("⏵⏵ auto mode on")).toBe("auto");
  });

  test("auto bare", () => {
    expect(parsePermissionMode("⏵⏵ auto on")).toBe("auto");
  });

  test("accept-edits", () => {
    expect(parsePermissionMode("⏵⏵ accept edits on")).toBe("accept-edits");
  });

  test("dont-ask (apostrophe)", () => {
    expect(parsePermissionMode("⏵⏵ don't ask on")).toBe("dont-ask");
  });

  test("plan mode", () => {
    expect(parsePermissionMode("⏵⏵ plan mode on")).toBe("plan");
  });

  test("default mode", () => {
    expect(parsePermissionMode("⏵⏵ default on")).toBe("default");
  });

  test("unknown mode token", () => {
    expect(parsePermissionMode("⏵⏵ banana on")).toBe("unknown");
  });

  test("indicator absent → null", () => {
    expect(parsePermissionMode("just regular pane text")).toBeNull();
  });

  test("indicator at start of line + surrounding text", () => {
    const text = `some pane content
⏵⏵ accept edits on
more lines`;
    expect(parsePermissionMode(text)).toBe("accept-edits");
  });
});
