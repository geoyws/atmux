// Unit tests for src/core/modal-cycling-state.ts (ADR-142 §D1 + §D4
// dedup). Covers read/write roundtrip, corrupt-file fallback, file-per-
// member isolation, and dedup helpers.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModalHistoryEntry } from "../../../src/core/modal-cycling-detector.ts";
import {
  loadDedupState,
  loadModalHistory,
  modalCyclingDedupPath,
  modalHistoryPath,
  recordDedup,
  saveDedupState,
  saveModalHistory,
  shouldFireDedup,
} from "../../../src/core/modal-cycling-state.ts";

describe("modalHistoryPath / modalCyclingDedupPath", () => {
  test("history path includes member name", () => {
    expect(modalHistoryPath("/x/.atmux", "whip-impl")).toBe(
      "/x/.atmux/state/modal-history-whip-impl.json",
    );
  });
  test("dedup path is shared", () => {
    expect(modalCyclingDedupPath("/x/.atmux")).toBe(
      "/x/.atmux/state/modal-cycling-dedup-state.json",
    );
  });
  test("member name with path separator is sanitized", () => {
    expect(modalHistoryPath("/x/.atmux", "../escape")).toBe(
      "/x/.atmux/state/modal-history-.._escape.json",
    );
  });
});

describe("loadModalHistory / saveModalHistory — roundtrip + corrupt fallback", () => {
  let dir: string;
  let atmuxDir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atmux-modalstate-"));
    atmuxDir = join(dir, ".atmux");
    await mkdir(join(atmuxDir, "state"), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("absent file → []", async () => {
    expect(await loadModalHistory(atmuxDir, "whip-impl")).toEqual([]);
  });

  test("corrupt JSON → []", async () => {
    await writeFile(modalHistoryPath(atmuxDir, "whip-impl"), "{not-json", "utf8");
    expect(await loadModalHistory(atmuxDir, "whip-impl")).toEqual([]);
  });

  test("schema-violating JSON → []", async () => {
    await writeFile(
      modalHistoryPath(atmuxDir, "whip-impl"),
      JSON.stringify([{ wrong: "shape" }]),
      "utf8",
    );
    expect(await loadModalHistory(atmuxDir, "whip-impl")).toEqual([]);
  });

  test("save then load roundtrips entries", async () => {
    const history: ModalHistoryEntry[] = [
      {
        member: "whip-impl",
        paneTextHash: "sha256:abc",
        detectedAt: 1_700_000_000,
        modalText: "❯ 1. Force-push?",
        modalClass: "choice-prompt",
      },
    ];
    await saveModalHistory(atmuxDir, "whip-impl", history);
    expect(await loadModalHistory(atmuxDir, "whip-impl")).toEqual(history);
  });

  test("file-per-member isolation — writes one member do not affect another", async () => {
    const a: ModalHistoryEntry[] = [
      {
        member: "alice",
        paneTextHash: "sha256:a",
        detectedAt: 1000,
        modalText: "A",
        modalClass: "choice-prompt",
      },
    ];
    const b: ModalHistoryEntry[] = [
      {
        member: "bob",
        paneTextHash: "sha256:b",
        detectedAt: 2000,
        modalText: "B",
        modalClass: "confirm-prompt",
      },
    ];
    await saveModalHistory(atmuxDir, "alice", a);
    await saveModalHistory(atmuxDir, "bob", b);
    expect(await loadModalHistory(atmuxDir, "alice")).toEqual(a);
    expect(await loadModalHistory(atmuxDir, "bob")).toEqual(b);
    // Confirm separate files exist on disk.
    const aText = await readFile(modalHistoryPath(atmuxDir, "alice"), "utf8");
    expect(aText).toContain("sha256:a");
    expect(aText).not.toContain("sha256:b");
  });
});

describe("dedup state — load/save/shouldFire/record", () => {
  let dir: string;
  let atmuxDir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atmux-modaldedup-"));
    atmuxDir = join(dir, ".atmux");
    await mkdir(join(atmuxDir, "state"), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("absent file → empty map", async () => {
    expect(await loadDedupState(atmuxDir)).toEqual({});
  });

  test("corrupt JSON → empty map", async () => {
    await writeFile(modalCyclingDedupPath(atmuxDir), "<<<not-json", "utf8");
    expect(await loadDedupState(atmuxDir)).toEqual({});
  });

  test("save then load roundtrip", async () => {
    await saveDedupState(atmuxDir, { alice: 1000, bob: 2000 });
    expect(await loadDedupState(atmuxDir)).toEqual({ alice: 1000, bob: 2000 });
  });

  test("shouldFireDedup — never fired → true", () => {
    expect(shouldFireDedup({}, "alice", 5000, 30 * 60)).toBe(true);
  });

  test("shouldFireDedup — within window → false", () => {
    expect(shouldFireDedup({ alice: 5000 }, "alice", 5500, 30 * 60)).toBe(false);
  });

  test("shouldFireDedup — outside window → true", () => {
    expect(shouldFireDedup({ alice: 5000 }, "alice", 5000 + 30 * 60 + 1, 30 * 60)).toBe(true);
  });

  test("recordDedup — pure; new state has member stamped", () => {
    const before = { alice: 100 };
    const after = recordDedup(before, "bob", 200);
    expect(after).toEqual({ alice: 100, bob: 200 });
    expect(before).toEqual({ alice: 100 });
  });
});
