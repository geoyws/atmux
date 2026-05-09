// Unit tests for src/core/heads-up-cursor.ts (t-bf09aec0).
//
// Verifies the per-(source, target) mtime cursor primitives that
// gate heads-up emits. The dedup is best-effort: corruption / race
// conditions degrade to "one extra ping," never to wrong-routing.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cursorKey,
  headsUpCursorPath,
  loadHeadsUpCursor,
  recordHeadsUp,
  shouldEmitHeadsUp,
  writeHeadsUpCursor,
} from "../../../src/core/heads-up-cursor.ts";

let atmuxDir: string;

beforeEach(async () => {
  atmuxDir = await mkdtemp(join(tmpdir(), "atmux-headsup-"));
});

afterEach(async () => {
  await rm(atmuxDir, { recursive: true, force: true });
});

describe("cursorKey", () => {
  test("composes <source>:<target>", () => {
    expect(cursorKey("driver-inbox.md", "lead")).toBe("driver-inbox.md:lead");
  });

  test("preserves separator chars in source path", () => {
    // Real callers pass file paths; the colon separator is retained
    // in keys even when the source contains slashes.
    expect(cursorKey("/atmux/state/x.md", "alice")).toBe("/atmux/state/x.md:alice");
  });
});

describe("headsUpCursorPath", () => {
  test("places file under <atmuxDir>/state/heads-up-cursor.json", () => {
    expect(headsUpCursorPath("/x")).toBe("/x/state/heads-up-cursor.json");
  });
});

describe("loadHeadsUpCursor", () => {
  test("missing file → empty map", async () => {
    const cursor = await loadHeadsUpCursor(atmuxDir);
    expect(cursor).toEqual({});
  });

  test("malformed JSON → empty map (corruption is non-fatal)", async () => {
    await writeFile(headsUpCursorPath(atmuxDir), "{not valid json", "utf8").catch(() =>
      writeFile(join(atmuxDir, "state"), ""),
    );
    // statOrNull: ensure dir exists before write
    const dir = join(atmuxDir, "state");
    await rm(dir, { recursive: true, force: true });
    const fs = await import("node:fs/promises");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(headsUpCursorPath(atmuxDir), "{not valid json", "utf8");
    const cursor = await loadHeadsUpCursor(atmuxDir);
    expect(cursor).toEqual({});
  });

  test("non-object JSON (array) → empty map", async () => {
    const fs = await import("node:fs/promises");
    await fs.mkdir(join(atmuxDir, "state"), { recursive: true });
    await fs.writeFile(headsUpCursorPath(atmuxDir), "[1,2,3]", "utf8");
    const cursor = await loadHeadsUpCursor(atmuxDir);
    expect(cursor).toEqual({});
  });

  test("filters non-finite + non-number values", async () => {
    const fs = await import("node:fs/promises");
    await fs.mkdir(join(atmuxDir, "state"), { recursive: true });
    await fs.writeFile(
      headsUpCursorPath(atmuxDir),
      JSON.stringify({
        "a:b": 100,
        "c:d": "not a number",
        "e:f": null,
        "g:h": Number.NaN, // serializes as null but exercise defense
      }),
      "utf8",
    );
    const cursor = await loadHeadsUpCursor(atmuxDir);
    expect(cursor).toEqual({ "a:b": 100 });
  });
});

describe("writeHeadsUpCursor", () => {
  test("creates state dir if missing + atomically writes", async () => {
    await writeHeadsUpCursor(atmuxDir, { "a:b": 12345 });
    const txt = await readFile(headsUpCursorPath(atmuxDir), "utf8");
    expect(JSON.parse(txt)).toEqual({ "a:b": 12345 });
  });
});

describe("shouldEmitHeadsUp", () => {
  test("first time (cursor missing) → true", async () => {
    const ok = await shouldEmitHeadsUp({
      atmuxDir,
      source: "/x.md",
      target: "lead",
      sourceMtimeMs: 1000,
    });
    expect(ok).toBe(true);
  });

  test("source mtime > cursor → true (novel revision)", async () => {
    await writeHeadsUpCursor(atmuxDir, { "/x.md:lead": 1000 });
    const ok = await shouldEmitHeadsUp({
      atmuxDir,
      source: "/x.md",
      target: "lead",
      sourceMtimeMs: 2000,
    });
    expect(ok).toBe(true);
  });

  test("source mtime == cursor → false (dedup hit)", async () => {
    await writeHeadsUpCursor(atmuxDir, { "/x.md:lead": 1000 });
    const ok = await shouldEmitHeadsUp({
      atmuxDir,
      source: "/x.md",
      target: "lead",
      sourceMtimeMs: 1000,
    });
    expect(ok).toBe(false);
  });

  test("source mtime < cursor → false (stale revision; cursor never regresses)", async () => {
    await writeHeadsUpCursor(atmuxDir, { "/x.md:lead": 5000 });
    const ok = await shouldEmitHeadsUp({
      atmuxDir,
      source: "/x.md",
      target: "lead",
      sourceMtimeMs: 1000,
    });
    expect(ok).toBe(false);
  });

  test("non-finite mtime → false (defensive — bad mtime can't dedup later)", async () => {
    const ok = await shouldEmitHeadsUp({
      atmuxDir,
      source: "/x.md",
      target: "lead",
      sourceMtimeMs: Number.NaN,
    });
    expect(ok).toBe(false);
  });

  test("different (source, target) pairs are independent", async () => {
    await writeHeadsUpCursor(atmuxDir, {
      "/x.md:lead": 5000,
      "/y.md:lead": 1000,
    });
    expect(
      await shouldEmitHeadsUp({
        atmuxDir,
        source: "/x.md",
        target: "lead",
        sourceMtimeMs: 4000,
      }),
    ).toBe(false);
    expect(
      await shouldEmitHeadsUp({
        atmuxDir,
        source: "/y.md",
        target: "lead",
        sourceMtimeMs: 4000,
      }),
    ).toBe(true);
  });

  test("same source different target are independent", async () => {
    await writeHeadsUpCursor(atmuxDir, { "/x.md:lead-a": 5000 });
    expect(
      await shouldEmitHeadsUp({
        atmuxDir,
        source: "/x.md",
        target: "lead-b",
        sourceMtimeMs: 1000,
      }),
    ).toBe(true);
  });
});

describe("recordHeadsUp", () => {
  test("first record creates cursor entry", async () => {
    await recordHeadsUp({
      atmuxDir,
      source: "/x.md",
      target: "lead",
      sourceMtimeMs: 1000,
    });
    const cursor = await loadHeadsUpCursor(atmuxDir);
    expect(cursor["/x.md:lead"]).toBe(1000);
  });

  test("subsequent record advances cursor when mtime newer", async () => {
    await recordHeadsUp({
      atmuxDir,
      source: "/x.md",
      target: "lead",
      sourceMtimeMs: 1000,
    });
    await recordHeadsUp({
      atmuxDir,
      source: "/x.md",
      target: "lead",
      sourceMtimeMs: 2000,
    });
    const cursor = await loadHeadsUpCursor(atmuxDir);
    expect(cursor["/x.md:lead"]).toBe(2000);
  });

  test("never regresses cursor (older mtime is no-op)", async () => {
    await recordHeadsUp({
      atmuxDir,
      source: "/x.md",
      target: "lead",
      sourceMtimeMs: 5000,
    });
    await recordHeadsUp({
      atmuxDir,
      source: "/x.md",
      target: "lead",
      sourceMtimeMs: 1000,
    });
    const cursor = await loadHeadsUpCursor(atmuxDir);
    expect(cursor["/x.md:lead"]).toBe(5000);
  });

  test("equal-mtime is no-op (idempotent re-record)", async () => {
    await recordHeadsUp({
      atmuxDir,
      source: "/x.md",
      target: "lead",
      sourceMtimeMs: 1000,
    });
    await recordHeadsUp({
      atmuxDir,
      source: "/x.md",
      target: "lead",
      sourceMtimeMs: 1000,
    });
    const cursor = await loadHeadsUpCursor(atmuxDir);
    expect(cursor["/x.md:lead"]).toBe(1000);
  });

  test("non-finite mtime is silently ignored", async () => {
    await recordHeadsUp({
      atmuxDir,
      source: "/x.md",
      target: "lead",
      sourceMtimeMs: Number.NaN,
    });
    const cursor = await loadHeadsUpCursor(atmuxDir);
    expect(cursor).toEqual({});
  });
});

// ---------- End-to-end dedup scenario (replicates the screenshot) ----------

describe("integration: 10 mtime touches in 5s should produce 1 emit, not 10", () => {
  test("first emit fires + records; subsequent (same mtime) all suppressed", async () => {
    const opts = {
      atmuxDir,
      source: "/driver-inbox.md",
      target: "lead",
      sourceMtimeMs: 1000,
    };
    // 1st: novel mtime → emit allowed.
    expect(await shouldEmitHeadsUp(opts)).toBe(true);
    await recordHeadsUp(opts);
    // 2nd–10th: same mtime → all suppressed.
    let emits = 1; // count includes the first emit
    for (let i = 2; i <= 10; i += 1) {
      if (await shouldEmitHeadsUp(opts)) {
        emits += 1;
        await recordHeadsUp(opts);
      }
    }
    expect(emits).toBe(1);
  });

  test("3rd touch at newer mtime → fires (not just first revision)", async () => {
    const base = {
      atmuxDir,
      source: "/driver-inbox.md",
      target: "lead",
    };
    // 1st mtime — fires
    expect(await shouldEmitHeadsUp({ ...base, sourceMtimeMs: 1000 })).toBe(true);
    await recordHeadsUp({ ...base, sourceMtimeMs: 1000 });
    // 2nd touch same mtime — suppressed
    expect(await shouldEmitHeadsUp({ ...base, sourceMtimeMs: 1000 })).toBe(false);
    // 3rd touch newer mtime — fires (real new content)
    expect(await shouldEmitHeadsUp({ ...base, sourceMtimeMs: 2000 })).toBe(true);
    await recordHeadsUp({ ...base, sourceMtimeMs: 2000 });
    // confirm cursor advanced
    const cursor = await loadHeadsUpCursor(atmuxDir);
    expect(cursor["/driver-inbox.md:lead"]).toBe(2000);
  });
});
