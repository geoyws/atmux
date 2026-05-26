// t-c3f4c418 — release verb unit tests. Covers:
//   - parseReleaseArgs (bump kinds, --dry-run, --allow-dirty, double-bump, unknown args, missing bump)
//   - bumpVersion (semver edge cases, pre-release stripping)
//   - release end-to-end on injected spawn + package.json reader/writer
//
// Spawn injection is critical — these tests never call real git / bun.

import { describe, expect, test } from "bun:test";
import type { SpawnResult } from "../../../src/abstractions/spawn.ts";
import { UsageError } from "../../../src/errors.ts";
import {
  type BumpKind,
  bumpVersion,
  parseReleaseArgs,
  release,
} from "../../../src/verbs/release.ts";

describe("parseReleaseArgs", () => {
  test.each<[string, BumpKind]>([
    ["patch", "patch"],
    ["minor", "minor"],
    ["major", "major"],
  ])("bare '%s' parses as %s bump", (arg, kind) => {
    expect(parseReleaseArgs([arg])).toEqual({ bump: kind, dryRun: false, allowDirty: false });
  });

  test("--dry-run threads through", () => {
    expect(parseReleaseArgs(["patch", "--dry-run"])).toEqual({
      bump: "patch",
      dryRun: true,
      allowDirty: false,
    });
  });

  test("--allow-dirty threads through", () => {
    expect(parseReleaseArgs(["minor", "--allow-dirty"])).toEqual({
      bump: "minor",
      dryRun: false,
      allowDirty: true,
    });
  });

  test("flags can appear before bump kind", () => {
    expect(parseReleaseArgs(["--dry-run", "patch"])).toEqual({
      bump: "patch",
      dryRun: true,
      allowDirty: false,
    });
  });

  test("missing bump kind throws", () => {
    expect(() => parseReleaseArgs([])).toThrow(UsageError);
    expect(() => parseReleaseArgs(["--dry-run"])).toThrow(UsageError);
  });

  test("double bump kind throws", () => {
    expect(() => parseReleaseArgs(["patch", "minor"])).toThrow(UsageError);
  });

  test("unknown arg throws", () => {
    expect(() => parseReleaseArgs(["patch", "--unknown"])).toThrow(UsageError);
  });
});

describe("bumpVersion", () => {
  test.each<[string, BumpKind, string]>([
    ["0.0.1", "patch", "0.0.2"],
    ["0.0.1", "minor", "0.1.0"],
    ["0.0.1", "major", "1.0.0"],
    ["0.8.6", "patch", "0.8.7"],
    ["0.8.6", "minor", "0.9.0"],
    ["0.8.6", "major", "1.0.0"],
    ["1.2.3", "patch", "1.2.4"],
    ["9.9.9", "patch", "9.9.10"],
    ["9.9.9", "minor", "9.10.0"],
    ["1.0.0-rc.1", "patch", "1.0.1"], // pre-release stripped
    ["1.0.0+meta", "patch", "1.0.1"], // build-meta stripped
  ])("bumpVersion(%s, %s) → %s", (current, kind, expected) => {
    expect(bumpVersion(current, kind)).toBe(expected);
  });

  test("non-semver input throws", () => {
    expect(() => bumpVersion("not-a-version", "patch")).toThrow(UsageError);
    expect(() => bumpVersion("1.2", "patch")).toThrow(UsageError);
    expect(() => bumpVersion("", "patch")).toThrow(UsageError);
  });
});

describe("release", () => {
  function makeSpawnResult(stdout: string, exitCode = 0, stderr = ""): SpawnResult {
    return {
      exitCode,
      stdout,
      stderr,
      argv: [],
      cmd: "spawn",
      signalled: null,
      durationMs: 0,
    };
  }

  test("dry-run prints plan without mutating package.json or spawning git mutations", async () => {
    const calls: Array<[string, ReadonlyArray<string>]> = [];
    const spawn = async (cmd: string, argv: ReadonlyArray<string>): Promise<SpawnResult> => {
      calls.push([cmd, argv]);
      if (argv[0] === "status") return makeSpawnResult("");
      return makeSpawnResult("");
    };
    const stdoutChunks: string[] = [];
    const written: string[] = [];
    const rc = await release(["patch", "--dry-run"], {
      spawn,
      readPackageJson: async () => JSON.stringify({ name: "atmux", version: "0.8.6" }),
      writePackageJson: async (c) => {
        written.push(c);
      },
      stdout: (m) => {
        stdoutChunks.push(m);
      },
      stderr: () => {},
    });
    expect(rc).toBe(0);
    expect(written).toEqual([]); // no write in dry-run
    expect(stdoutChunks.join("")).toContain("0.8.6 → 0.8.7");
    expect(stdoutChunks.join("")).toContain("--dry-run set");
    // Only git status was called (clean-tree gate); no commit/build/push.
    expect(calls.filter((c) => c[1][0] === "commit")).toHaveLength(0);
    expect(calls.filter((c) => c[1][0] === "push")).toHaveLength(0);
  });

  test("dirty tree refuses without --allow-dirty (exit 65)", async () => {
    const spawn = async (
      _cmd: string,
      argv: ReadonlyArray<string>,
    ): Promise<SpawnResult> => {
      if (argv[0] === "status") return makeSpawnResult(" M src/foo.ts\n");
      return makeSpawnResult("");
    };
    const stderrChunks: string[] = [];
    const rc = await release(["patch"], {
      spawn,
      readPackageJson: async () => JSON.stringify({ name: "atmux", version: "0.8.6" }),
      writePackageJson: async () => {},
      stdout: () => {},
      stderr: (m) => {
        stderrChunks.push(m);
      },
    });
    expect(rc).toBe(65);
    expect(stderrChunks.join("")).toContain("working tree dirty");
  });

  test("--allow-dirty bypasses the clean-tree gate", async () => {
    const calls: Array<[string, ReadonlyArray<string>]> = [];
    const spawn = async (cmd: string, argv: ReadonlyArray<string>): Promise<SpawnResult> => {
      calls.push([cmd, argv]);
      if (argv[0] === "status") return makeSpawnResult(" M src/foo.ts\n"); // dirty
      if (argv[0] === "rev-parse" && argv[1] === "--abbrev-ref") return makeSpawnResult("main");
      return makeSpawnResult("");
    };
    const written: string[] = [];
    const rc = await release(["patch", "--allow-dirty"], {
      spawn,
      readPackageJson: async () => JSON.stringify({ name: "atmux", version: "0.8.6" }, null, 2),
      writePackageJson: async (c) => {
        written.push(c);
      },
      stdout: () => {},
      stderr: () => {},
    });
    expect(rc).toBe(0);
    expect(written).toHaveLength(1);
    expect(written[0]).toContain('"version": "0.8.7"');
  });

  test("missing package.json returns exit 64", async () => {
    const rc = await release(["patch"], {
      spawn: async () => makeSpawnResult(""),
      readPackageJson: async () => null,
      writePackageJson: async () => {},
      stdout: () => {},
      stderr: () => {},
    });
    expect(rc).toBe(64);
  });

  test("invalid JSON returns exit 64", async () => {
    const rc = await release(["patch"], {
      spawn: async () => makeSpawnResult(""),
      readPackageJson: async () => "{ not json",
      writePackageJson: async () => {},
      stdout: () => {},
      stderr: () => {},
    });
    expect(rc).toBe(64);
  });

  test("build:install failure surfaces with recovery hint + non-zero exit", async () => {
    const spawn = async (
      cmd: string,
      argv: ReadonlyArray<string>,
    ): Promise<SpawnResult> => {
      if (argv[0] === "status") return makeSpawnResult("");
      if (argv[0] === "add" || argv[0] === "commit") return makeSpawnResult("");
      if (cmd === "bun" && argv[0] === "run" && argv[1] === "build:install") {
        return makeSpawnResult("", 1, "build:compile failed");
      }
      return makeSpawnResult("");
    };
    const stderrChunks: string[] = [];
    const rc = await release(["patch"], {
      spawn,
      readPackageJson: async () => JSON.stringify({ name: "atmux", version: "0.8.6" }),
      writePackageJson: async () => {},
      stdout: () => {},
      stderr: (m) => {
        stderrChunks.push(m);
      },
    });
    expect(rc).toBe(70);
    expect(stderrChunks.join("")).toContain("build:install failed");
    expect(stderrChunks.join("")).toContain("git reset --soft HEAD~1");
  });

  test("happy path: writes new version + commits + builds + pushes", async () => {
    const calls: Array<[string, ReadonlyArray<string>]> = [];
    const spawn = async (cmd: string, argv: ReadonlyArray<string>): Promise<SpawnResult> => {
      calls.push([cmd, argv]);
      if (argv[0] === "status") return makeSpawnResult("");
      if (argv[0] === "rev-parse" && argv[1] === "--abbrev-ref") return makeSpawnResult("geoyws");
      return makeSpawnResult("");
    };
    const written: string[] = [];
    const stdoutChunks: string[] = [];
    const rc = await release(["minor"], {
      spawn,
      readPackageJson: async () => JSON.stringify({ name: "atmux", version: "0.8.6" }),
      writePackageJson: async (c) => {
        written.push(c);
      },
      stdout: (m) => {
        stdoutChunks.push(m);
      },
      stderr: () => {},
    });
    expect(rc).toBe(0);
    expect(written).toHaveLength(1);
    expect(written[0]).toContain('"version": "0.9.0"');
    // Verify the spawn chain ran in expected order: status → add → commit → bun run build:install → rev-parse → push
    const argv0 = calls.map((c) => c[1].join(" "));
    expect(argv0).toContain("status --porcelain");
    expect(argv0).toContain("add package.json");
    expect(argv0.some((s) => s.startsWith("commit -m"))).toBe(true);
    expect(argv0).toContain("run build:install");
    expect(argv0).toContain("push origin geoyws");
    expect(stdoutChunks.join("")).toContain("v0.9.0 deployed");
  });
});
