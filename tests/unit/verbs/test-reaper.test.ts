import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnsafeSocketPathError } from "../../../src/core/socket-dir.ts";
import { UsageError } from "../../../src/errors.ts";
import {
  type ReaperResult,
  type TestReaperDeps,
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
  test("keeps a sidecar whose socketDir differs from its directory (ADR-301 D1c)", async () => {
    const root = await mkdtemp(join(tmpdir(), "atmux-test-reaper-"));
    roots.push(root);
    const socketDir = join(root, "fixture-mismatch-old");
    await mkdir(socketDir);
    await writeFile(
      join(socketDir, ".leak-tracker.json"),
      JSON.stringify({
        tmuxSocket: join(socketDir, "sock"),
        socketDir: join(root, "fixture-some-other-dir-old"),
        parentPid: DEAD_PID,
        createdAt: NOW - 2_000,
      }),
      "utf8",
    );
    const killed: string[] = [];
    const warnings: string[] = [];
    const output: string[] = [];
    expect(
      await testReaper(["--max-age-min", "30", "--prefix", "fixture", "--json"], {
        tmpDir: root,
        nowSeconds: () => NOW,
        parentIsDead: () => true,
        killServer: (socket: string) => {
          killed.push(socket);
        },
        stdout: (text) => {
          output.push(text);
        },
        stderr: (text) => {
          warnings.push(text);
        },
      }),
    ).toBe(0);
    expect(statusesByBasename(JSON.parse(output.join("")).results)).toEqual({
      [socketDir.slice(socketDir.lastIndexOf("/") + 1)]: "corrupt-sidecar",
    });
    expect(killed).toEqual([]);
    expect(await pathExists(socketDir)).toBe(true);
    expect(warnings.join("")).toContain("corrupt-sidecar");
  });

  test("skips symlinked dirs without following them (ADR-301 D1d)", async () => {
    const root = await mkdtemp(join(tmpdir(), "atmux-test-reaper-"));
    roots.push(root);
    const outside = await mkdtemp(join(tmpdir(), "atmux-test-reaper-outside-"));
    roots.push(outside);
    const target = join(outside, "real");
    await mkdir(target);
    await writeFile(join(target, "sentinel"), "stay", "utf8");
    const linkName = "fixture-link-old";
    await symlink(target, join(root, linkName));
    const killed: string[] = [];
    const removed: string[] = [];
    const warnings: string[] = [];
    const output: string[] = [];
    expect(
      await testReaper(["--max-age-min", "30", "--prefix", "fixture", "--json"], {
        tmpDir: root,
        nowSeconds: () => NOW,
        parentIsDead: () => true,
        killServer: (socket: string) => {
          killed.push(socket);
        },
        removeDir: (dir: string) => {
          removed.push(dir);
        },
        stdout: (text) => {
          output.push(text);
        },
        stderr: (text) => {
          warnings.push(text);
        },
      }),
    ).toBe(0);
    expect(statusesByBasename(JSON.parse(output.join("")).results)).toEqual({
      [linkName]: "symlink-skipped",
    });
    expect(killed).toEqual([]);
    expect(removed).toEqual([]);
    expect(await pathExists(join(target, "sentinel"))).toBe(true);
    expect(warnings.join("")).toContain("symlink-skipped");
  });

  test("text mode lists only acted-on dirs; dry-run removes nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "atmux-test-reaper-"));
    roots.push(root);
    const oldDead = await fixture(root, "fixture-dead-old", DEAD_PID, NOW - 2_000);
    await fixture(root, "fixture-live-old", LIVE_PID, NOW - 2_000);
    const lines: string[] = [];
    const killed: string[] = [];
    const deps = {
      tmpDir: root,
      nowSeconds: () => NOW,
      parentIsDead: (pid: number) => pid === DEAD_PID,
      killServer: (socket: string) => {
        killed.push(socket);
      },
      stdout: (text: string) => {
        lines.push(text);
      },
      stderr: () => {},
    };
    expect(
      await testReaper(["--max-age-min", "30", "--prefix", "fixture", "--dry-run"], deps),
    ).toBe(0);
    expect(killed).toEqual([]);
    expect(await pathExists(oldDead)).toBe(true);
    expect(lines.join("").split("\n").filter(Boolean)).toEqual([`would-reap\t${oldDead}`]);
    lines.length = 0;
    expect(await testReaper(["--max-age-min", "30", "--prefix", "fixture"], deps)).toBe(0);
    expect(killed).toEqual([join(oldDead, "sock")]);
    expect(lines.join("").split("\n").filter(Boolean)).toEqual([`reaped\t${oldDead}`]);
  });

  test("real-tmux integration: reaps a server the test itself spawned", async () => {
    if (!Bun.which("tmux")) return;
    const root = await mkdtemp(join(tmpdir(), "atmux-test-reaper-"));
    roots.push(root);
    const socketDir = join(root, "fixture-real-old");
    await mkdir(socketDir, { mode: 0o700 });
    const socket = join(socketDir, "sock");
    const env = { ...process.env };
    delete env.TMUX;
    const proc = Bun.spawnSync(["tmux", "-S", socket, "new-session", "-d", "-s", "reaper-probe"], {
      env,
    });
    expect(proc.exitCode).toBe(0);
    const check = Bun.spawnSync(["tmux", "-S", socket, "has-session"], { env });
    expect(check.exitCode).toBe(0);
    await writeFile(
      join(socketDir, ".leak-tracker.json"),
      JSON.stringify({
        tmuxSocket: socket,
        socketDir,
        parentPid: 999_999_937,
        createdAt: Math.floor(Date.now() / 1000) - 3_600,
      }),
      "utf8",
    );
    expect(await testReaper(["--max-age-min", "30", "--prefix", "fixture"], { tmpDir: root })).toBe(
      0,
    );
    expect(await pathExists(socketDir)).toBe(false);
    const after = Bun.spawnSync(["tmux", "-S", socket, "has-session"], { env });
    expect(after.exitCode).not.toBe(0);
  });
});

describe("test-reaper kill-target containment (ADR-301 D1)", () => {
  test.each([
    [
      "an absolute socket outside the dir",
      (_dir: string, root: string) => join(root, "cockpit-sock"),
    ],
    ["a relative escape out of the dir", (dir: string) => join(dir, "..", "cockpit-sock")],
    ["a socket nested below the dir", (dir: string) => join(dir, "nested", "sock")],
  ])("a sidecar pointing at %s is corrupt and never killed", async (_label, socketFor) => {
    const root = await mkdtemp(join(tmpdir(), "atmux-test-reaper-escape-"));
    roots.push(root);
    const socketDir = join(root, "fixture-escape-old");
    await mkdir(socketDir);
    await writeFile(
      join(socketDir, ".leak-tracker.json"),
      JSON.stringify({
        tmuxSocket: socketFor(socketDir, root),
        socketDir,
        parentPid: DEAD_PID,
        createdAt: NOW - 2_000,
      }),
      "utf8",
    );
    const killed: string[] = [];
    const out: string[] = [];
    expect(
      await testReaper(["--prefix", "fixture", "--json"], {
        tmpDir: root,
        nowSeconds: () => NOW,
        parentIsDead: () => true,
        killServer: (socket: string) => {
          killed.push(socket);
        },
        stdout: (text) => {
          out.push(text);
        },
        stderr: () => {},
      }),
    ).toBe(0);
    const { results } = JSON.parse(out.join("")) as { results: ReaperResult[] };
    expect(statusesByBasename(results)).toEqual({ "fixture-escape-old": "corrupt-sidecar" });
    expect(killed).toEqual([]);
    expect(await pathExists(socketDir)).toBe(true);
  });
});

describe("test-reaper ADR-305 ownership (review of a9f96ac2, item 2)", () => {
  async function root(): Promise<string> {
    const r = await mkdtemp(join(tmpdir(), "atmux-test-reaper-305-"));
    roots.push(r);
    return r;
  }

  function run(
    tmpDir: string,
    argv: string[],
    extra: TestReaperDeps = {},
  ): Promise<{ statuses: Record<string, string>; warnings: string }> {
    const out: string[] = [];
    const err: string[] = [];
    return testReaper(["--prefix", "fixture", "--json", ...argv], {
      tmpDir,
      nowSeconds: () => NOW,
      parentIsDead: () => true,
      stdout: (t) => {
        out.push(t);
      },
      stderr: (t) => {
        err.push(t);
      },
      ...extra,
    }).then(() => ({
      statuses: statusesByBasename(
        (JSON.parse(out.join("")) as { results: ReaperResult[] }).results,
      ),
      warnings: err.join(""),
    }));
  }

  test("a shared (0755) fixture dir is unsafe-skipped — in a dry run and for real — and left alone", async () => {
    const r = await root();
    const dir = await fixture(r, "fixture-shared-old", DEAD_PID, NOW - 2_000);
    chmodSync(dir, 0o755);
    const killed: string[] = [];
    const deps = { killServer: (s: string) => void killed.push(s) };
    const dry = await run(r, ["--dry-run"], deps);
    expect(dry.statuses).toEqual({ "fixture-shared-old": "unsafe-skipped" });
    const real = await run(r, [], deps);
    expect(real.statuses).toEqual({ "fixture-shared-old": "unsafe-skipped" });
    expect(real.warnings).toContain(`fixture-shared-old: unsafe-skipped (${dir} has mode 0755`);
    expect(killed).toEqual([]);
    expect(await pathExists(dir)).toBe(true);
  });

  test("a `sock` symlink in our own private dir is unsafe-skipped", async () => {
    const r = await root();
    const dir = await fixture(r, "fixture-link-old", DEAD_PID, NOW - 2_000);
    await symlink(join(r, "elsewhere"), join(dir, "sock"));
    const killed: string[] = [];
    const res = await run(r, [], { killServer: (s: string) => void killed.push(s) });
    expect(res.statuses).toEqual({ "fixture-link-old": "unsafe-skipped" });
    expect(res.warnings).toContain(`${join(dir, "sock")} is a symlink`);
    expect(killed).toEqual([]);
    expect(await pathExists(dir)).toBe(true);
  });

  test("a guard refusal at kill time (a swap after the check) is unsafe-skipped, nothing removed", async () => {
    const r = await root();
    const dir = await fixture(r, "fixture-swap-old", DEAD_PID, NOW - 2_000);
    const removed: string[] = [];
    const res = await run(r, [], {
      killServer: (s: string) => {
        throw new UnsafeSocketPathError(s, {
          path: dir,
          problem: "foreign-owner",
          detail: "is owned by uid 4242, not uid 0",
          hint: "x",
        });
      },
      removeDir: (d: string) => void removed.push(d),
    });
    expect(res.statuses).toEqual({ "fixture-swap-old": "unsafe-skipped" });
    expect(res.warnings).toContain("is owned by uid 4242");
    expect(removed).toEqual([]);
  });

  test("the default removal re-checks the directory right before it runs", async () => {
    const r = await root();
    const dir = await fixture(r, "fixture-late-old", DEAD_PID, NOW - 2_000);
    // The dir turns shared between the check and the removal.
    const res = await run(r, [], { killServer: () => chmodSync(dir, 0o777) });
    expect(res.statuses).toEqual({ "fixture-late-old": "unsafe-skipped" });
    expect(await pathExists(dir)).toBe(true);
  });

  test("an unsafe-skipped warning reaches the default stderr", async () => {
    const r = await root();
    const dir = await fixture(r, "fixture-stderr-old", DEAD_PID, NOW - 2_000);
    chmodSync(dir, 0o777);
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => {
      writes.push(String(s));
      return true;
    }) as typeof process.stderr.write;
    try {
      await testReaper(["--prefix", "fixture", "--dry-run"], {
        tmpDir: r,
        nowSeconds: () => NOW,
        parentIsDead: () => true,
        stdout: () => {},
      });
    } finally {
      process.stderr.write = orig;
    }
    expect(writes.join("")).toContain("fixture-stderr-old: unsafe-skipped");
  });

  test("any other kill error still propagates", async () => {
    const r = await root();
    await fixture(r, "fixture-boom-old", DEAD_PID, NOW - 2_000);
    const boom = new Error("boom");
    await expect(
      run(r, [], {
        killServer: () => {
          throw boom;
        },
      }),
    ).rejects.toBe(boom);
  });
});

describe("test-reaper argument errors", () => {
  test.each([
    [["--max-age-min", "-1"], "--max-age-min requires a non-negative number"],
    [["--max-age-min=abc"], "--max-age-min requires a non-negative number"],
    [["--max-age-min"], "--max-age-min requires a non-negative number"],
    [["--prefix", "../etc"], "--prefix requires a non-empty filename prefix"],
    [["--prefix="], "--prefix requires a non-empty filename prefix"],
    [["--bogus"], "unknown argument: --bogus"],
  ])("%p is refused with a UsageError", async (argv, message) => {
    const err = await testReaper(argv, { tmpDir: "/nonexistent" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect((err as UsageError).message).toContain(message);
  });
});

describe("test-reaper default parent probe (pid-reuse defence)", () => {
  test("a live `bun test` parent is kept; a live non-test pid (reused pid) counts as dead", async () => {
    const root = await mkdtemp(join(tmpdir(), "atmux-test-reaper-pid-"));
    roots.push(root);
    const sleeper = Bun.spawn(["sleep", "30"]);
    try {
      await fixture(root, "fixture-pid-runner", process.pid, NOW - 2_000);
      await fixture(root, "fixture-pid-reused", sleeper.pid, NOW - 2_000);
      const out: string[] = [];
      const killed: string[] = [];
      expect(
        await testReaper(["--prefix", "fixture", "--json"], {
          tmpDir: root,
          nowSeconds: () => NOW,
          killServer: (socket: string) => {
            killed.push(socket);
          },
          removeDir: () => {},
          stdout: (text) => {
            out.push(text);
          },
          stderr: () => {},
        }),
      ).toBe(0);
      const { results } = JSON.parse(out.join("")) as { results: ReaperResult[] };
      expect(statusesByBasename(results)).toEqual({
        "fixture-pid-reused": "reaped",
        "fixture-pid-runner": "parent-alive",
      });
      expect(killed).toEqual([join(root, "fixture-pid-reused", "sock")]);
    } finally {
      sleeper.kill();
    }
  });
});

async function fixture(
  root: string,
  name: string,
  parentPid: number,
  createdAt: number,
): Promise<string> {
  const socketDir = join(root, name);
  // ADR-305: spinTmux socket dirs are mkdtemp'd, i.e. 0700 and ours.
  await mkdir(socketDir, { mode: 0o700 });
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
    results.map((result) => [
      result.socketDir.slice(result.socketDir.lastIndexOf("/") + 1),
      result.status,
    ]),
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
