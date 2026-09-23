import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ReaperResult,
  testReaper,
} from "../../../src/verbs/test-reaper.ts";

const NOW = 10_000;
const DEAD_PID = 900_001;
const LIVE_PID = 900_002;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("test-reaper", () => {
  test("dry-run reports every fixture without acting; apply reaps only the stale dead parent", async () => {
    const root = await mkdtemp(join(tmpdir(), "atmux-test-reaper-"));
    roots.push(root);

    const oldDead = await fixture(root, "fixture-dead-old", DEAD_PID, NOW - 2_000);
    const youngDead = await fixture(root, "fixture-dead-young", DEAD_PID, NOW - 60);
    const oldLive = await fixture(root, "fixture-live-old", LIVE_PID, NOW - 2_000);
    const missing = join(root, "fixture-missing-sidecar");
    const corrupt = join(root, "fixture-corrupt-old");
    await mkdir(missing);
    await mkdir(corrupt);
    await writeFile(join(corrupt, ".leak-tracker.json"), "{not-json", "utf8");

    const dryOutput: string[] = [];
    const warnings: string[] = [];
    const killed: string[] = [];
    const sharedDeps = {
      tmpDir: root,
      nowSeconds: () => NOW,
      parentIsDead: (pid: number) => pid === DEAD_PID,
      killServer: (socket: string) => {
        killed.push(socket);
      },
      stderr: (text: string) => {
        warnings.push(text);
      },
    };

    expect(
      await testReaper(["--max-age-min", "30", "--prefix", "fixture", "--dry-run", "--json"], {
        ...sharedDeps,
        stdout: (text) => {
          dryOutput.push(text);
        },
      }),
    ).toBe(0);

    const dryRun = JSON.parse(dryOutput.join("")) as {
      dryRun: boolean;
      results: ReaperResult[];
    };
    expect(dryRun.dryRun).toBe(true);
    expect(statusesByBasename(dryRun.results)).toEqual({
      "fixture-corrupt-old": "corrupt-sidecar",
      "fixture-dead-old": "would-reap",
      "fixture-dead-young": "too-young",
      "fixture-live-old": "parent-alive",
      "fixture-missing-sidecar": "missing-sidecar",
    });
    expect(killed).toEqual([]);
    expect(await readFile(join(oldDead, ".leak-tracker.json"), "utf8")).toContain("parentPid");
    expect(warnings.join("")).toContain("missing-sidecar");
    expect(warnings.join("")).toContain("corrupt-sidecar");

    const applyOutput: string[] = [];
    expect(
      await testReaper(["--max-age-min=30", "--prefix=fixture", "--json"], {
        ...sharedDeps,
        stdout: (text) => {
          applyOutput.push(text);
        },
      }),
    ).toBe(0);

    const applied = JSON.parse(applyOutput.join("")) as { results: ReaperResult[] };
    expect(statusesByBasename(applied.results)).toEqual({
      "fixture-corrupt-old": "corrupt-sidecar",
      "fixture-dead-old": "reaped",
      "fixture-dead-young": "too-young",
      "fixture-live-old": "parent-alive",
      "fixture-missing-sidecar": "missing-sidecar",
    });
    expect(killed).toEqual([join(oldDead, "sock")]);
    expect(await pathExists(oldDead)).toBe(false);
    expect(await pathExists(youngDead)).toBe(true);
    expect(await pathExists(oldLive)).toBe(true);
    expect(await pathExists(missing)).toBe(true);
    expect(await pathExists(corrupt)).toBe(true);
  });
});

async function fixture(
  root: string,
  name: string,
  parentPid: number,
  createdAt: number,
): Promise<string> {
  const socketDir = join(root, name);
  await mkdir(socketDir);
  await writeFile(
    join(socketDir, ".leak-tracker.json"),
    JSON.stringify({
      tmuxSocket: join(socketDir, "sock"),
      socketDir,
      parentPid,
      createdAt,
      testFile: import.meta.path,
      testName: name,
      prefix: "fixture",
    }),
    "utf8",
  );
  return socketDir;
}

function statusesByBasename(results: ReaperResult[]): Record<string, string> {
  return Object.fromEntries(
    results.map((result) => [result.socketDir.slice(result.socketDir.lastIndexOf("/") + 1), result.status]),
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
