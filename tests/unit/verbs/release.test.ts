// t-c3f4c418 — release verb unit tests. Covers:
//   - parseReleaseArgs (bump kinds, --dry-run, --allow-dirty, double-bump, unknown args, missing bump)
//   - bumpVersion (semver edge cases, pre-release stripping)
//   - release end-to-end on injected spawn + package.json reader/writer
//
// Spawn injection is critical — these tests never call real git / bun.

import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnOpts, SpawnResult } from "../../../src/abstractions/spawn.ts";
import { UsageError } from "../../../src/errors.ts";
import {
  type BumpKind,
  bumpVersion,
  makeDefaultSpawnFn,
  parseReleaseArgs,
  release,
} from "../../../src/verbs/release.ts";

const bunBinary = "/opt/homebrew/bin/bun";

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

describe("makeDefaultSpawnFn", () => {
  test("wraps the shared spawn helper with release defaults", async () => {
    const observed: Array<unknown> = [];
    const defaultSpawn = async (input: SpawnOpts): Promise<SpawnResult> => {
      observed.push(input);
      return makeSpawnResult("ok");
    };
    const spawn = makeDefaultSpawnFn(defaultSpawn);

    const result = await spawn("git", ["status", "--porcelain"], { cwd: "/tmp/release-test" });

    expect(result.stdout).toBe("ok");
    expect(observed).toEqual([
      {
        cmd: "git",
        argv: ["status", "--porcelain"],
        expectExitCode: "any",
        timeoutMs: 300_000,
        cwd: "/tmp/release-test",
      },
    ]);
  });
});

describe("release", () => {
  test("default manifest reader and writer use the injected package path", async () => {
    const root = await mkdtemp(join(tmpdir(), "atmux-release-"));
    const packageJsonPath = join(root, "package.json");
    await writeFile(packageJsonPath, JSON.stringify({ name: "atmux", version: "0.8.6" }));
    const calls: Array<[string, ReadonlyArray<string>]> = [];
    const spawn = async (cmd: string, argv: ReadonlyArray<string>): Promise<SpawnResult> => {
      calls.push([cmd, argv]);
      if (argv[0] === "rev-parse") return makeSpawnResult("release-test\n");
      return makeSpawnResult("");
    };

    try {
      expect(
        await release(["patch"], {
          spawn,
          packageJsonPath,
          stdout: () => {},
          stderr: () => {},
        }),
      ).toBe(0);
      expect(JSON.parse(await readFile(packageJsonPath, "utf8")).version).toBe("0.8.7");
      expect(calls).toContainEqual(["git", ["add", packageJsonPath]]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
    const spawn = async (_cmd: string, argv: ReadonlyArray<string>): Promise<SpawnResult> => {
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

  test("missing version field returns exit 64", async () => {
    const stderrChunks: string[] = [];
    const rc = await release(["patch"], {
      spawn: async () => makeSpawnResult(""),
      readPackageJson: async () => JSON.stringify({ name: "atmux" }),
      writePackageJson: async () => {},
      stdout: () => {},
      stderr: (m) => {
        stderrChunks.push(m);
      },
    });
    expect(rc).toBe(64);
    expect(stderrChunks.join("")).toContain("missing 'version' field");
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

  test("git status failure returns exit 65 and does not write package.json", async () => {
    const calls: Array<[string, ReadonlyArray<string>]> = [];
    const spawn = async (cmd: string, argv: ReadonlyArray<string>): Promise<SpawnResult> => {
      calls.push([cmd, argv]);
      if (argv[0] === "status") return makeSpawnResult("", 2, "permission denied");
      return makeSpawnResult("");
    };
    let wrote = false;
    const stderrChunks: string[] = [];
    const rc = await release(["patch"], {
      spawn,
      readPackageJson: async () => JSON.stringify({ name: "atmux", version: "0.8.6" }),
      writePackageJson: async () => {
        wrote = true;
      },
      stdout: () => {},
      stderr: (m) => {
        stderrChunks.push(m);
      },
    });
    expect(rc).toBe(65);
    expect(wrote).toBe(false);
    expect(calls).toEqual([["git", ["status", "--porcelain"]]]);
    expect(stderrChunks.join("")).toContain("git status failed (exit 2)");
  });

  test("version substitution failure returns exit 70 without writing", async () => {
    let wrote = false;
    const stderrChunks: string[] = [];
    const rc = await release(["patch", "--allow-dirty"], {
      spawn: async (_cmd, argv) =>
        argv[0] === "rev-parse" ? makeSpawnResult("release-x\n") : makeSpawnResult(""),
      readPackageJson: async () => '{"\\u0076ersion":"0.8.6"}',
      writePackageJson: async () => {
        wrote = true;
      },
      stdout: () => {},
      stderr: (message) => stderrChunks.push(message),
    });
    expect(rc).toBe(70);
    expect(wrote).toBe(false);
    expect(stderrChunks.join("")).toContain("failed to substitute version");
  });

  test("git add failure returns exit 70 before commit", async () => {
    const calls: string[] = [];
    const stderrChunks: string[] = [];
    const rc = await release(["patch"], {
      spawn: async (_cmd, argv) => {
        calls.push(argv[0] ?? "");
        if (argv[0] === "rev-parse") return makeSpawnResult("release-x\n");
        if (argv[0] === "add") return makeSpawnResult("", 1, "index locked");
        return makeSpawnResult("");
      },
      readPackageJson: async () => JSON.stringify({ name: "atmux", version: "0.8.6" }),
      writePackageJson: async () => {},
      stdout: () => {},
      stderr: (message) => stderrChunks.push(message),
    });
    expect(rc).toBe(70);
    expect(calls).toEqual(["status", "rev-parse", "add"]);
    expect(stderrChunks.join("")).toContain("git add failed (exit 1): index locked");
  });

  test("build:install failure surfaces with recovery hint + non-zero exit", async () => {
    const whichSpy = spyOn(Bun, "which").mockImplementation((cmd: string) =>
      cmd === "bun" ? bunBinary : null,
    );
    try {
      const spawn = async (cmd: string, argv: ReadonlyArray<string>): Promise<SpawnResult> => {
        if (argv[0] === "status") return makeSpawnResult("");
        if (argv[0] === "add" || argv[0] === "commit") return makeSpawnResult("");
        if (cmd === "sudo" && argv[0] === bunBinary && argv[1] === "scripts/build-install.ts") {
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
      expect(stderrChunks.join("")).toContain("build:compile failed");
      expect(stderrChunks.join("")).toContain("git reset --soft HEAD~1");
    } finally {
      whichSpy.mockRestore();
    }
  });

  test("missing bun returns exit 69 before build-install", async () => {
    const whichSpy = spyOn(Bun, "which").mockImplementation((cmd: string) =>
      cmd === "bun" ? null : "/usr/bin/not-used",
    );
    try {
      const calls: string[] = [];
      const stderrChunks: string[] = [];
      const rc = await release(["patch"], {
        spawn: async (_cmd, argv) => {
          calls.push(argv[0] ?? "");
          if (argv[0] === "status") return makeSpawnResult("");
          if (argv[0] === "rev-parse" && argv[1] === "--abbrev-ref")
            return makeSpawnResult("release-x");
          if (argv[0] === "add" || argv[0] === "commit") return makeSpawnResult("");
          return makeSpawnResult("");
        },
        readPackageJson: async () => JSON.stringify({ name: "atmux", version: "0.8.6" }),
        writePackageJson: async () => {},
        stdout: () => {},
        stderr: (m) => stderrChunks.push(m),
      });
      expect(rc).toBe(69);
      expect(calls).toEqual(["status", "rev-parse", "add", "commit"]);
      expect(stderrChunks.join("")).toContain("bun not found on PATH");
    } finally {
      whichSpy.mockRestore();
    }
  });

  test("git commit failure returns exit 70 after writing package.json and git add", async () => {
    const calls: Array<[string, ReadonlyArray<string>]> = [];
    const spawn = async (cmd: string, argv: ReadonlyArray<string>): Promise<SpawnResult> => {
      calls.push([cmd, argv]);
      if (argv[0] === "status") return makeSpawnResult("");
      if (argv[0] === "commit") return makeSpawnResult("", 1, "commit rejected");
      if (argv[0] === "rev-parse" && argv[1] === "--abbrev-ref") return makeSpawnResult("geoyws");
      return makeSpawnResult("");
    };
    const written: string[] = [];
    const stderrChunks: string[] = [];
    const rc = await release(["patch"], {
      spawn,
      readPackageJson: async () => JSON.stringify({ name: "atmux", version: "0.8.6" }),
      writePackageJson: async (c) => {
        written.push(c);
      },
      stdout: () => {},
      stderr: (m) => {
        stderrChunks.push(m);
      },
    });
    expect(rc).toBe(70);
    expect(written).toHaveLength(1);
    expect(calls.map((c) => c[1][0])).toEqual(["status", "rev-parse", "add", "commit"]);
    expect(stderrChunks.join("")).toContain("git commit failed (exit 1)");
  });

  test("git push failure keeps the local commit and reports a manual recovery command", async () => {
    const whichSpy = spyOn(Bun, "which").mockImplementation((cmd: string) =>
      cmd === "bun" ? bunBinary : null,
    );
    try {
      const calls: Array<[string, ReadonlyArray<string>]> = [];
      const spawn = async (cmd: string, argv: ReadonlyArray<string>): Promise<SpawnResult> => {
        calls.push([cmd, argv]);
        if (argv[0] === "status") return makeSpawnResult("");
        if (argv[0] === "rev-parse" && argv[1] === "--abbrev-ref")
          return makeSpawnResult("release-x");
        if (argv[0] === "push") return makeSpawnResult("", 1, "remote rejected");
        return makeSpawnResult("");
      };
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      const rc = await release(["minor"], {
        spawn,
        readPackageJson: async () => JSON.stringify({ name: "atmux", version: "0.8.6" }),
        writePackageJson: async () => {},
        stdout: (m) => {
          stdoutChunks.push(m);
        },
        stderr: (m) => {
          stderrChunks.push(m);
        },
      });
      expect(rc).toBe(70);
      expect(calls.map((c) => c[1][0])).toEqual([
        "status",
        "rev-parse",
        "add",
        "commit",
        bunBinary,
        "rev-parse",
        "push",
      ]);
      expect(stdoutChunks.join("")).toContain("✓ commit landed: 0.9.0");
      expect(stderrChunks.join("")).toContain("git push failed (exit 1): remote rejected");
      expect(stderrChunks.join("")).toContain("git push origin release-x");
    } finally {
      whichSpy.mockRestore();
    }
  });

  test("post-build branch probe failure returns exit 70 without pushing", async () => {
    let revParseCalls = 0;
    const calls: string[] = [];
    const stderrChunks: string[] = [];
    const rc = await release(["patch"], {
      spawn: async (_cmd, argv) => {
        calls.push(argv[0] ?? "");
        if (argv[0] === "rev-parse") {
          revParseCalls += 1;
          return revParseCalls === 1
            ? makeSpawnResult("release-x\n")
            : makeSpawnResult("", 128, "no HEAD");
        }
        return makeSpawnResult("");
      },
      readPackageJson: async () => JSON.stringify({ name: "atmux", version: "0.8.6" }),
      writePackageJson: async () => {},
      stdout: () => {},
      stderr: (message) => stderrChunks.push(message),
    });
    expect(rc).toBe(70);
    expect(calls.at(-1)).toBe("rev-parse");
    expect(calls).not.toContain("push");
    expect(stderrChunks.join("")).toContain("git rev-parse failed (exit 128)");
  });

  test("happy path: writes new version + commits + builds + pushes", async () => {
    const whichSpy = spyOn(Bun, "which").mockImplementation((cmd: string) =>
      cmd === "bun" ? bunBinary : null,
    );
    try {
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
      // Verify the spawn chain ran in expected order: status → add → commit → sudo bun scripts/build-install.ts → rev-parse → push
      const argv0 = calls.map((c) => c[1].join(" "));
      expect(argv0).toContain("status --porcelain");
      expect(argv0).toContain("add package.json");
      expect(argv0.some((s) => s.startsWith("commit -m"))).toBe(true);
      expect(calls).toContainEqual(["sudo", [bunBinary, "scripts/build-install.ts"]]);
      expect(argv0).toContain("push origin geoyws");
      expect(stdoutChunks.join("")).toContain("v0.9.0 deployed");
    } finally {
      whichSpy.mockRestore();
    }
  });
});
