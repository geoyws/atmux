// Unit tests for src/abstractions/json.ts (ADR-005).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  readJson,
  readJsonOr,
  tryReadJson,
  updateJson,
  writeJson,
} from "../../../src/abstractions/json.ts";
import { FsError, SchemaError } from "../../../src/errors.ts";

const Kanban = z
  .object({
    schemaVersion: z.literal(1),
    tasks: z.array(
      z.object({
        id: z.string(),
        subject: z.string().min(1),
        status: z.enum(["todo", "in-progress", "done"]),
      }),
    ),
  })
  .strict();

type Kanban = z.infer<typeof Kanban>;

const empty: Kanban = { schemaVersion: 1, tasks: [] };

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "atmux-json-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("readJson", () => {
  test("parses + validates a well-formed file", async () => {
    const p = join(dir, "kanban.json");
    await writeFile(p, JSON.stringify(empty));
    const got = await readJson(p, Kanban);
    expect(got).toEqual(empty);
  });

  test("throws FsError when file is missing", async () => {
    await expect(readJson(join(dir, "no.json"), Kanban)).rejects.toBeInstanceOf(FsError);
  });

  test("throws SchemaError on invalid JSON syntax", async () => {
    const p = join(dir, "bad.json");
    await writeFile(p, "{ not json");
    await expect(readJson(p, Kanban)).rejects.toBeInstanceOf(SchemaError);
  });

  test("throws SchemaError when shape mismatches", async () => {
    const p = join(dir, "wrong.json");
    await writeFile(p, JSON.stringify({ schemaVersion: 2, tasks: [] }));
    await expect(readJson(p, Kanban)).rejects.toBeInstanceOf(SchemaError);
  });

  test("SchemaError carries file path + issues", async () => {
    const p = join(dir, "wrong.json");
    await writeFile(p, JSON.stringify({ schemaVersion: 1 })); // tasks missing
    try {
      await readJson(p, Kanban);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SchemaError);
      const se = e as SchemaError;
      expect(se.context.file).toBe(p);
      expect(Array.isArray(se.context.issues)).toBe(true);
    }
  });

  test("SchemaError on invalid JSON includes parse-error message", async () => {
    const p = join(dir, "bad.json");
    await writeFile(p, "not json at all");
    try {
      await readJson(p, Kanban);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SchemaError);
      const se = e as SchemaError;
      expect(se.message).toContain("invalid JSON");
    }
  });
});

describe("tryReadJson", () => {
  test("returns null for missing file (expected absence)", async () => {
    expect(await tryReadJson(join(dir, "absent.json"), Kanban)).toBeNull();
  });

  test("returns parsed value for present file", async () => {
    const p = join(dir, "x.json");
    await writeFile(p, JSON.stringify(empty));
    expect(await tryReadJson(p, Kanban)).toEqual(empty);
  });

  test("still throws SchemaError on existing-but-invalid file", async () => {
    const p = join(dir, "x.json");
    await writeFile(p, "garbage");
    await expect(tryReadJson(p, Kanban)).rejects.toBeInstanceOf(SchemaError);
  });
});

describe("readJsonOr", () => {
  test("returns fallback when file is absent", async () => {
    const got = await readJsonOr(join(dir, "no.json"), Kanban, empty);
    expect(got).toEqual(empty);
  });

  test("returns parsed value when file is present", async () => {
    const p = join(dir, "x.json");
    const seeded: Kanban = {
      schemaVersion: 1,
      tasks: [{ id: "t-1", subject: "ship", status: "todo" }],
    };
    await writeFile(p, JSON.stringify(seeded));
    const got = await readJsonOr(p, Kanban, empty);
    expect(got).toEqual(seeded);
  });

  test("still throws SchemaError on existing-but-invalid file", async () => {
    const p = join(dir, "x.json");
    await writeFile(p, "garbage");
    await expect(readJsonOr(p, Kanban, empty)).rejects.toBeInstanceOf(SchemaError);
  });
});

describe("writeJson", () => {
  test("writes pretty-printed JSON with trailing newline", async () => {
    const p = join(dir, "out.json");
    await writeJson(p, Kanban, empty);
    const text = await readFile(p, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('"schemaVersion": 1');
    expect(JSON.parse(text)).toEqual(empty);
  });

  test("validates before writing — invalid input throws SchemaError", async () => {
    const p = join(dir, "bad.json");
    // Cast through `unknown` so TS lets us pass an invalid shape into a typed
    // schema slot — runtime rejection is the test's whole point.
    const invalid = { schemaVersion: 99, tasks: [] } as unknown as Kanban;
    await expect(writeJson(p, Kanban, invalid)).rejects.toBeInstanceOf(SchemaError);
    // file should not be created
    await expect(readFile(p)).rejects.toThrow();
  });

  test("creates parent dir on demand (atomicWrite ensureDir)", async () => {
    const p = join(dir, "deep", "nested", "kanban.json");
    await writeJson(p, Kanban, empty);
    expect(JSON.parse(await readFile(p, "utf8"))).toEqual(empty);
  });
});

describe("updateJson", () => {
  test("read → mutate → write under a lock", async () => {
    const p = join(dir, "kanban.json");
    await writeFile(p, JSON.stringify(empty));
    const out = await updateJson(p, Kanban, (k) => ({
      ...k,
      tasks: [...k.tasks, { id: "t-1", subject: "first", status: "todo" as const }],
    }));
    expect(out.tasks).toHaveLength(1);
    expect(JSON.parse(await readFile(p, "utf8"))).toEqual(out);
  });

  test("uses initial fallback on first run when file is absent", async () => {
    const p = join(dir, "first-run.json");
    const out = await updateJson(
      p,
      Kanban,
      (k) => ({
        ...k,
        tasks: [{ id: "t-1", subject: "init", status: "todo" as const }],
      }),
      { initial: empty },
    );
    expect(out.tasks).toHaveLength(1);
    expect(JSON.parse(await readFile(p, "utf8"))).toEqual(out);
  });

  test("initial value is itself validated", async () => {
    const p = join(dir, "first-run.json");
    await expect(
      updateJson(p, Kanban, (k) => k, {
        initial: { schemaVersion: 99, tasks: [] }, // wrong literal
      }),
    ).rejects.toBeInstanceOf(SchemaError);
  });

  test("without initial, missing file throws FsError via readJson", async () => {
    const p = join(dir, "missing.json");
    await expect(updateJson(p, Kanban, (k) => k)).rejects.toBeInstanceOf(FsError);
  });

  test("re-validates mutator output — bad mutator throws SchemaError", async () => {
    const p = join(dir, "kanban.json");
    await writeFile(p, JSON.stringify(empty));
    const badMutator = (_k: Kanban): Kanban =>
      // Cast: the whole point of the test is to push an invalid shape past
      // the typesystem so the runtime validator catches it.
      ({
        schemaVersion: 1,
        tasks: [{ id: "t-1", subject: "", status: "todo" }], // empty subject violates min(1)
      }) as unknown as Kanban;
    await expect(updateJson(p, Kanban, badMutator)).rejects.toBeInstanceOf(SchemaError);
  });

  test("supports async mutators", async () => {
    const p = join(dir, "kanban.json");
    await writeFile(p, JSON.stringify(empty));
    const out = await updateJson(p, Kanban, async (k) => {
      await Promise.resolve();
      return { ...k, tasks: [{ id: "t-async", subject: "async", status: "done" as const }] };
    });
    expect(out.tasks[0]?.id).toBe("t-async");
  });

  test("serializes concurrent updates — lock prevents lost writes", async () => {
    const p = join(dir, "kanban.json");
    await writeFile(p, JSON.stringify(empty));
    const N = 12;
    const ops = Array.from({ length: N }, (_, i) =>
      updateJson(p, Kanban, (k) => ({
        ...k,
        tasks: [...k.tasks, { id: `t-${i}`, subject: `sub-${i}`, status: "todo" as const }],
      })),
    );
    await Promise.all(ops);
    const final = JSON.parse(await readFile(p, "utf8")) as Kanban;
    expect(final.tasks).toHaveLength(N);
    const ids = new Set(final.tasks.map((t) => t.id));
    expect(ids.size).toBe(N);
  });

  test("threads custom lock options through to acquire()", async () => {
    const p = join(dir, "kanban.json");
    await writeFile(p, JSON.stringify(empty));
    // Use custom options; happy path should still succeed.
    const out = await updateJson(p, Kanban, (k) => k, {
      lock: { timeoutMs: 2_000, retryDelayMs: 10 },
    });
    expect(out).toEqual(empty);
  });
});
