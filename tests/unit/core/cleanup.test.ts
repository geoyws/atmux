// Unit tests for src/core/cleanup.ts (ADR-068 cutover Tier 1, P0).
//
// Strategy: per-test tmpdir, seed `.atmux/logs/*.log` + `.atmux/inboxes/*.json`,
// run helpers with explicit thresholds + clock pin, assert observable
// side-effects. 100% narrowed coverage of every branch.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneInboxes, purgeLegacyInboxes, rotateLogs } from "../../../src/core/cleanup.ts";

const RUN_MS = Date.UTC(2026, 4, 8, 14, 55, 0);

interface Env {
  atmuxDir: string;
  logsDir: string;
  inboxDir: string;
}

let env: Env;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "atmux-cleanup-"));
  const atmuxDir = join(root, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  env = {
    atmuxDir,
    logsDir: join(atmuxDir, "logs"),
    inboxDir: join(atmuxDir, "inboxes"),
  };
});

afterEach(async () => {
  await rm(join(env.atmuxDir, ".."), { recursive: true, force: true });
});

// ---------- rotateLogs ----------

describe("rotateLogs", () => {
  test("returns empty when logs/ absent", async () => {
    const got = await rotateLogs(env.atmuxDir);
    expect(got.rotated).toEqual([]);
    expect(got.skipped).toBe(0);
  });

  test("ignores non-.log files in logs/", async () => {
    await mkdir(env.logsDir, { recursive: true });
    await writeFile(join(env.logsDir, "garbage.txt"), "x".repeat(2 * 1024 * 1024));
    const got = await rotateLogs(env.atmuxDir);
    expect(got.rotated).toEqual([]);
  });

  test("rotates *.log files larger than the cap", async () => {
    await mkdir(env.logsDir, { recursive: true });
    const big = join(env.logsDir, "report.log");
    await writeFile(big, "x".repeat(2 * 1024 * 1024));
    const small = join(env.logsDir, "whip.log");
    await writeFile(small, "y".repeat(100));

    const got = await rotateLogs(env.atmuxDir);
    expect(got.rotated.map((r) => r.path)).toEqual([big]);
    expect(got.skipped).toBe(1);

    // .log.1 has the snapshot; .log is truncated to zero bytes.
    const snapshot = await readFile(`${big}.1`, "utf8");
    expect(snapshot.length).toBe(2 * 1024 * 1024);
    const truncated = await readFile(big, "utf8");
    expect(truncated).toBe("");
  });

  test("re-rotation overwrites the .1 snapshot (one generation)", async () => {
    await mkdir(env.logsDir, { recursive: true });
    const log = join(env.logsDir, "x.log");

    await writeFile(log, "x".repeat(2 * 1024 * 1024));
    await rotateLogs(env.atmuxDir);
    expect((await readFile(`${log}.1`, "utf8")).length).toBe(2 * 1024 * 1024);

    // Refill + re-rotate; .1 now reflects the new content.
    await writeFile(log, "y".repeat(2 * 1024 * 1024));
    await rotateLogs(env.atmuxDir);
    expect((await readFile(`${log}.1`, "utf8"))[0]).toBe("y");
  });

  test("falls back to delete-and-retry when rename fails once", async () => {
    await mkdir(env.logsDir, { recursive: true });
    const log = join(env.logsDir, "retry.log");
    const snapshot = `${log}.1`;
    const body = "x".repeat(2 * 1024 * 1024);
    await writeFile(log, body);
    await writeFile(snapshot, "stale snapshot");

    let calls = 0;
    const got = await rotateLogs(env.atmuxDir, {
      hooks: {
        rename: async (from, to) => {
          calls += 1;
          if (calls === 1) throw new Error("rename blocked");
          await expect(access(to)).rejects.toThrow();
          await rename(from, to);
        },
      },
    });

    expect(calls).toBe(2);
    expect(got.rotated.map((r) => r.path)).toEqual([log]);
    expect((await readFile(snapshot, "utf8")).length).toBe(body.length);
    expect(await readFile(log, "utf8")).toBe("");
  });

  test("--dry-run reports without rotating", async () => {
    await mkdir(env.logsDir, { recursive: true });
    const log = join(env.logsDir, "x.log");
    await writeFile(log, "x".repeat(2 * 1024 * 1024));
    const got = await rotateLogs(env.atmuxDir, { dryRun: true });
    expect(got.rotated).toHaveLength(1);
    const remaining = await readdir(env.logsDir);
    expect(remaining).toEqual(["x.log"]);
  });

  test("readdir rejection yields an unchanged empty result", async () => {
    await mkdir(env.logsDir, { recursive: true });
    const log = join(env.logsDir, "blocked.log");
    await writeFile(log, "x".repeat(2 * 1024 * 1024));

    const got = await rotateLogs(env.atmuxDir, {
      hooks: {
        readdir: async () => {
          throw new Error("readdir blocked");
        },
      },
    });

    expect(got.rotated).toEqual([]);
    expect(got.skipped).toBe(0);
    expect(await readFile(log, "utf8")).toBe("x".repeat(2 * 1024 * 1024));
  });

  test("custom maxBytes", async () => {
    await mkdir(env.logsDir, { recursive: true });
    await writeFile(join(env.logsDir, "tiny.log"), "x".repeat(1000));
    const got = await rotateLogs(env.atmuxDir, { maxBytes: 500 });
    expect(got.rotated).toHaveLength(1);
  });
});

// ---------- pruneInboxes ----------

describe("pruneInboxes", () => {
  test("returns empty when inboxes/ absent", async () => {
    const got = await pruneInboxes(env.atmuxDir);
    expect(got.totalPruned).toBe(0);
    expect(got.totalKept).toBe(0);
  });

  test("ignores non-.json files", async () => {
    await mkdir(env.inboxDir, { recursive: true });
    await writeFile(join(env.inboxDir, "README"), "ignore me");
    const got = await pruneInboxes(env.atmuxDir);
    expect(got.totalPruned).toBe(0);
  });

  test("prunes .done[] entries past cutoff; keeps recent + null-completedAt", async () => {
    await mkdir(env.inboxDir, { recursive: true });
    const oldEpoch = Math.floor(RUN_MS / 1000) - 10 * 86400; // 10d old
    const recentEpoch = Math.floor(RUN_MS / 1000) - 3 * 86400;
    const inbox = {
      pending: [{ task: "t-pp" }],
      inProgress: [{ task: "t-ii" }],
      done: [
        { task: "t-old", completedAt: oldEpoch },
        { task: "t-recent", completedAt: recentEpoch },
        { task: "t-null", completedAt: null },
        { task: "t-zero", completedAt: 0 },
      ],
    };
    await writeFile(join(env.inboxDir, "alice.json"), JSON.stringify(inbox));

    const got = await pruneInboxes(env.atmuxDir, {
      maxAgeDays: 7,
      nowMs: RUN_MS,
    });
    expect(got.totalPruned).toBe(1);
    expect(got.totalKept).toBe(3);
    expect(got.files).toEqual([{ name: "alice.json", pruned: 1, kept: 3 }]);

    const after = JSON.parse(await readFile(join(env.inboxDir, "alice.json"), "utf8"));
    expect(after.pending).toEqual([{ task: "t-pp" }]);
    expect(after.inProgress).toEqual([{ task: "t-ii" }]);
    const ids = (after.done as { task: string }[]).map((d) => d.task).sort();
    expect(ids).toEqual(["t-null", "t-recent", "t-zero"]);
  });

  test("leaves files alone when no entries are stale", async () => {
    await mkdir(env.inboxDir, { recursive: true });
    const recentEpoch = Math.floor(RUN_MS / 1000) - 1 * 86400;
    await writeFile(
      join(env.inboxDir, "x.json"),
      JSON.stringify({ done: [{ completedAt: recentEpoch }] }),
    );
    const got = await pruneInboxes(env.atmuxDir, {
      maxAgeDays: 7,
      nowMs: RUN_MS,
    });
    expect(got.totalPruned).toBe(0);
    expect(got.totalKept).toBe(1);
    expect(got.files).toEqual([]);
  });

  test("dry-run reports counts; never writes", async () => {
    await mkdir(env.inboxDir, { recursive: true });
    const oldEpoch = Math.floor(RUN_MS / 1000) - 60 * 86400;
    const inbox = {
      done: [
        { task: "t-old", completedAt: oldEpoch },
        { task: "t-old2", completedAt: oldEpoch },
      ],
    };
    const path = join(env.inboxDir, "y.json");
    await writeFile(path, JSON.stringify(inbox));
    const before = await readFile(path, "utf8");

    const got = await pruneInboxes(env.atmuxDir, {
      maxAgeDays: 7,
      nowMs: RUN_MS,
      dryRun: true,
    });
    expect(got.totalPruned).toBe(2);
    expect(got.files[0]?.pruned).toBe(2);

    const after = await readFile(path, "utf8");
    expect(after).toBe(before);
  });

  test("malformed JSON is skipped, not propagated", async () => {
    await mkdir(env.inboxDir, { recursive: true });
    await writeFile(join(env.inboxDir, "bad.json"), "{ this is not json");
    await writeFile(
      join(env.inboxDir, "good.json"),
      JSON.stringify({
        done: [{ completedAt: Math.floor(RUN_MS / 1000) - 30 * 86400 }],
      }),
    );
    const got = await pruneInboxes(env.atmuxDir, {
      maxAgeDays: 7,
      nowMs: RUN_MS,
    });
    // bad.json is silently skipped; good.json gets pruned.
    expect(got.totalPruned).toBe(1);
    expect(got.totalKept).toBe(0);
    expect(got.files).toEqual([{ name: "good.json", pruned: 1, kept: 0 }]);
  });

  test("dry-run skips malformed JSON inboxes and keeps walking", async () => {
    await mkdir(env.inboxDir, { recursive: true });
    await writeFile(join(env.inboxDir, "bad.json"), "{ this is not json");
    await writeFile(
      join(env.inboxDir, "good.json"),
      JSON.stringify({
        done: [{ completedAt: Math.floor(RUN_MS / 1000) - 30 * 86400 }],
      }),
    );

    const got = await pruneInboxes(env.atmuxDir, {
      maxAgeDays: 7,
      nowMs: RUN_MS,
      dryRun: true,
      hooks: {
        readdir: async () => ["bad.json", "good.json"],
      },
    });

    expect(got.totalPruned).toBe(1);
    expect(got.totalKept).toBe(0);
    expect(got.files).toEqual([{ name: "good.json", pruned: 1, kept: 0 }]);
  });

  test("readdir rejection yields an unchanged empty result", async () => {
    await mkdir(env.inboxDir, { recursive: true });
    const path = join(env.inboxDir, "blocked.json");
    await writeFile(
      path,
      JSON.stringify({
        done: [{ completedAt: Math.floor(RUN_MS / 1000) - 30 * 86400 }],
      }),
    );

    const got = await pruneInboxes(env.atmuxDir, {
      maxAgeDays: 7,
      nowMs: RUN_MS,
      hooks: {
        readdir: async () => {
          throw new Error("readdir blocked");
        },
      },
    });

    expect(got.totalPruned).toBe(0);
    expect(got.totalKept).toBe(0);
    expect(got.files).toEqual([]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      done: [{ completedAt: Math.floor(RUN_MS / 1000) - 30 * 86400 }],
    });
  });

  test("invalid maxAgeDays throws RangeError", async () => {
    await expect(pruneInboxes(env.atmuxDir, { maxAgeDays: 0 })).rejects.toThrow(RangeError);
    await expect(pruneInboxes(env.atmuxDir, { maxAgeDays: -1 })).rejects.toThrow(RangeError);
    await expect(pruneInboxes(env.atmuxDir, { maxAgeDays: 1.5 })).rejects.toThrow(RangeError);
  });
});

// ---------- purgeLegacyInboxes ----------

describe("purgeLegacyInboxes", () => {
  test("skips when state.db absent", async () => {
    await mkdir(env.inboxDir, { recursive: true });
    await writeFile(join(env.inboxDir, "gitter.json"), "{}");
    const got = await purgeLegacyInboxes(env.atmuxDir);
    expect(got.skipped).toBe(true);
    expect(got.removed).toEqual([]);
    expect(await readdir(env.inboxDir)).toContain("gitter.json");
  });

  test("removes legacy inbox json when state.db exists", async () => {
    await mkdir(env.inboxDir, { recursive: true });
    await writeFile(join(env.atmuxDir, "state.db"), "");
    await writeFile(join(env.inboxDir, "gitter.json"), "{}");
    await writeFile(join(env.inboxDir, "gitter.json.lock"), "");
    const got = await purgeLegacyInboxes(env.atmuxDir);
    expect(got.skipped).toBe(false);
    expect(got.removed.sort()).toEqual(["gitter.json", "gitter.json.lock"]);
    expect(await readdir(env.inboxDir)).toEqual([]);
  });

  test("dry-run lists files without deleting", async () => {
    await mkdir(env.inboxDir, { recursive: true });
    await writeFile(join(env.atmuxDir, "state.db"), "");
    await writeFile(join(env.inboxDir, "alpha.json"), "{}");
    const got = await purgeLegacyInboxes(env.atmuxDir, { dryRun: true });
    expect(got.removed).toEqual(["alpha.json"]);
    expect(await readdir(env.inboxDir)).toContain("alpha.json");
  });

  test("readdir rejection yields an unchanged empty result", async () => {
    await mkdir(env.inboxDir, { recursive: true });
    await writeFile(join(env.atmuxDir, "state.db"), "");
    const legacy = join(env.inboxDir, "legacy.json");
    await writeFile(legacy, "{}");

    const got = await purgeLegacyInboxes(env.atmuxDir, {
      hooks: {
        readdir: async () => {
          throw new Error("readdir blocked");
        },
      },
    });

    expect(got.skipped).toBe(false);
    expect(got.removed).toEqual([]);
    expect(await readFile(legacy, "utf8")).toBe("{}");
  });
});
