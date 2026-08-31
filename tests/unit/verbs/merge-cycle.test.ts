// Unit tests for src/verbs/merge-cycle.ts (ADR-179 W3 / t-d78127c7).
//
// Strategy mirrors merge-member.test.ts:
//   - Parser tests run pure on `parseMergeCycleArgs`.
//   - `parseBranchList` tested directly for prefix-filter correctness.
//   - Verb tests inject `primitive`, `git`, `raiseFlag`, `log` so every
//     iteration path and end-of-cycle behavior is exercised.
//
// Decision tree:
//   (A) parser — flags, mutual exclusion, missing team-dir value
//   (B) parseBranchList — happy-path, current-branch marker, blanks
//   (C) empty candidate list → exit 0 with empty summary
//   (D) all branches no-op → exit 0
//   (E) some merges, some conflicts → exit 1, all continue
//   (F) --dry-run → no primitive calls, wouldMerge populated
//   (G) --push on success → cycle-end push fires
//   (H) --push on staging base → refused + flag + exit 0
//   (I) --push fails after merges → flag + exit 1
//   (J) --push not attempted when zero merges landed

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MergeMemberOpts, MergeMemberResult } from "../../../src/abstractions/branch-merge.ts";
import { MergeConflictError } from "../../../src/abstractions/branch-merge.ts";
import type { SpawnResult } from "../../../src/abstractions/spawn.ts";
import { UsageError } from "../../../src/errors.ts";
import {
  mergeCycle,
  parseBranchList,
  parseMergeCycleArgs,
} from "../../../src/verbs/merge-cycle.ts";

let teamDir: string;
let atmuxDir: string;

function ok(stdout = ""): SpawnResult {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    argv: [],
    cmd: "git",
    signalled: null,
    durationMs: 0,
  };
}

function fail(stderr: string, code = 128): SpawnResult {
  return {
    exitCode: code,
    stdout: "",
    stderr,
    argv: [],
    cmd: "git",
    signalled: null,
    durationMs: 0,
  };
}

beforeEach(async () => {
  teamDir = await mkdtemp(join(tmpdir(), "atmux-mergecycle-"));
  atmuxDir = join(teamDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  await writeFile(
    join(atmuxDir, "team.json"),
    JSON.stringify({
      name: "test-team",
      members: [{ name: "alpha", role: "member" }],
      merger: { enabled: true, baseBranch: "geoyws" },
    }),
  );
});

afterEach(async () => {
  await rm(teamDir, { recursive: true, force: true });
});

// ---------- (A) Parser ----------

describe("parseMergeCycleArgs", () => {
  test("bare args parse with all-false defaults", () => {
    const a = parseMergeCycleArgs([]);
    expect(a.push).toBe(false);
    expect(a.dryRun).toBe(false);
    expect(a.teamDir).toBeUndefined();
  });

  test("--push sets push=true", () => {
    expect(parseMergeCycleArgs(["--push"]).push).toBe(true);
  });

  test("--dry-run sets dryRun=true", () => {
    expect(parseMergeCycleArgs(["--dry-run"]).dryRun).toBe(true);
  });

  test("--team-dir <dir> captured", () => {
    expect(parseMergeCycleArgs(["--team-dir", "/srv"]).teamDir).toBe("/srv");
  });

  test("--push + --dry-run mutual exclusion", () => {
    expect(() => parseMergeCycleArgs(["--push", "--dry-run"])).toThrow(UsageError);
  });

  test("unknown flag → UsageError", () => {
    expect(() => parseMergeCycleArgs(["--bogus"])).toThrow(UsageError);
  });

  test("--team-dir without value → UsageError", () => {
    expect(() => parseMergeCycleArgs(["--team-dir"])).toThrow(UsageError);
  });
});

// ---------- (B) parseBranchList ----------

describe("parseBranchList", () => {
  test("filters to <base>-* prefix; skips current-branch marker leading", () => {
    const out = parseBranchList(
      ["* geoyws", "  geoyws-alpha", "  geoyws-bob", "  unrelated"].join("\n"),
      "geoyws",
    );
    expect(out.map((e) => e.member)).toEqual(["alpha", "bob"]);
    expect(out.map((e) => e.wtBranch)).toEqual(["geoyws-alpha", "geoyws-bob"]);
  });

  test("excludes the base branch itself", () => {
    const out = parseBranchList("* geoyws\n  geoyws-alpha", "geoyws");
    expect(out.map((e) => e.wtBranch)).not.toContain("geoyws");
    expect(out.map((e) => e.wtBranch)).toContain("geoyws-alpha");
  });

  test("excludes bare '<base>-' shape (no member suffix)", () => {
    const out = parseBranchList("  geoyws-\n  geoyws-alpha", "geoyws");
    expect(out.map((e) => e.member)).toEqual(["alpha"]);
  });

  test("blank lines tolerated", () => {
    const out = parseBranchList("\n  geoyws-alpha\n\n  geoyws-bob\n\n", "geoyws");
    expect(out).toHaveLength(2);
  });

  test("preserves git's emission order", () => {
    const out = parseBranchList(
      ["  geoyws-charlie", "  geoyws-alpha", "  geoyws-bob"].join("\n"),
      "geoyws",
    );
    expect(out.map((e) => e.member)).toEqual(["charlie", "alpha", "bob"]);
  });

  test("empty stdout → empty array", () => {
    expect(parseBranchList("", "geoyws")).toEqual([]);
  });

  test("member name preserved verbatim (no sanitization applied here)", () => {
    // parseBranchList trusts the branch list — sanitization is the
    // caller's responsibility (sanitizeBranchSegment is applied at
    // wtBranch construction time, NOT at branch-list parse time).
    const out = parseBranchList("  geoyws-bob.smith", "geoyws");
    expect(out[0]?.member).toBe("bob.smith");
  });
});

// ---------- (C) Empty candidate list ----------

describe("mergeCycle — empty candidate list", () => {
  test("no <base>-* branches → exit 0, no primitive calls", async () => {
    let primitiveCalls = 0;
    const primitive = async () => {
      primitiveCalls += 1;
      return { status: "no-op", reason: "no-commits-ahead" } as MergeMemberResult;
    };
    const git = async (argv: ReadonlyArray<string>): Promise<SpawnResult> => {
      if (argv.includes("fetch")) return ok("");
      if (argv.includes("branch") && argv.includes("--list")) return ok(""); // empty
      return ok("");
    };
    const logs: string[] = [];
    const rc = await mergeCycle(["--team-dir", teamDir], {
      primitive,
      git,
      log: (m) => {
        logs.push(m);
      },
    });
    expect(rc).toBe(0);
    expect(primitiveCalls).toBe(0);
    expect(logs.join("")).toContain("merged:    0");
    expect(logs.join("")).toContain("no-op:     0");
    expect(logs.join("")).toContain("conflicts: 0");
  });

  test("no <base>-* branches → default stdout summary still reports zero counts", async () => {
    const git = async (argv: ReadonlyArray<string>): Promise<SpawnResult> => {
      if (argv.includes("fetch")) return ok("");
      if (argv.includes("branch") && argv.includes("--list")) return ok("");
      return ok("");
    };
    const chunks: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const rc = await mergeCycle(["--team-dir", teamDir], { git });
      expect(rc).toBe(0);
    } finally {
      process.stdout.write = originalWrite;
    }
    const text = chunks.join("");
    expect(text).toContain("merged:    0");
    expect(text).toContain("no-op:     0");
    expect(text).toContain("conflicts: 0");
  });
});

// ---------- (D) All no-op ----------

describe("mergeCycle — all branches no-op", () => {
  test("zero commits ahead on every branch → no primitive calls + exit 0", async () => {
    let primitiveCalls = 0;
    const primitive = async () => {
      primitiveCalls += 1;
      return { status: "merged", sha: "deadbeef" } as MergeMemberResult;
    };
    const git = async (argv: ReadonlyArray<string>): Promise<SpawnResult> => {
      if (argv.includes("fetch")) return ok("");
      if (argv.includes("branch") && argv.includes("--list")) {
        return ok("  geoyws-alpha\n  geoyws-bob\n");
      }
      if (argv.includes("rev-list")) return ok("0\n"); // zero ahead
      return ok("");
    };
    const logs: string[] = [];
    const rc = await mergeCycle(["--team-dir", teamDir], {
      primitive,
      git,
      log: (m) => {
        logs.push(m);
      },
    });
    expect(rc).toBe(0);
    expect(primitiveCalls).toBe(0);
    expect(logs.join("")).toContain("no-op:     2");
    expect(logs.join("")).toContain("geoyws-alpha");
    expect(logs.join("")).toContain("geoyws-bob");
  });
});

// ---------- (E) Mixed: merges + conflicts ----------

describe("mergeCycle — mixed outcomes", () => {
  test("merges + conflicts both surface; cycle continues past conflict; exit 1", async () => {
    const primitive = async (
      _base: string,
      wtBranch: string,
      _repoPath: string,
      _opts?: MergeMemberOpts,
    ): Promise<MergeMemberResult> => {
      if (wtBranch === "geoyws-alpha") {
        return { status: "merged", sha: "sha-alpha" };
      }
      if (wtBranch === "geoyws-bob") {
        throw new MergeConflictError({
          wtBranch,
          conflictPaths: ["src/foo.ts"],
        });
      }
      if (wtBranch === "geoyws-charlie") {
        return { status: "merged", sha: "sha-charlie" };
      }
      throw new Error("unexpected branch");
    };
    const git = async (argv: ReadonlyArray<string>): Promise<SpawnResult> => {
      if (argv.includes("fetch")) return ok("");
      if (argv.includes("branch") && argv.includes("--list")) {
        return ok("  geoyws-alpha\n  geoyws-bob\n  geoyws-charlie\n");
      }
      if (argv.includes("rev-list")) return ok("1\n");
      return ok("");
    };
    const flagsRaised: string[] = [];
    const logs: string[] = [];
    const rc = await mergeCycle(["--team-dir", teamDir], {
      primitive,
      git,
      raiseFlag: async (_dir, body) => {
        flagsRaised.push(body);
      },
      log: (m) => {
        logs.push(m);
      },
    });
    expect(rc).toBe(1);
    // Both merges landed
    expect(logs.join("")).toContain("merged:    2");
    expect(logs.join("")).toContain("sha-alpha");
    expect(logs.join("")).toContain("sha-charlie");
    // Conflict surfaced
    expect(logs.join("")).toContain("conflicts: 1");
    expect(logs.join("")).toContain("geoyws-bob");
    expect(logs.join("")).toContain("src/foo.ts");
    // Flag raised for the conflict
    expect(flagsRaised).toHaveLength(1);
    expect(flagsRaised[0]).toContain("merger-conflict");
    expect(flagsRaised[0]).toContain("geoyws-bob");
  });

  test("non-MergeConflictError throws propagate (don't get swallowed)", async () => {
    const primitive = async () => {
      throw new Error("disk full");
    };
    const git = async (argv: ReadonlyArray<string>): Promise<SpawnResult> => {
      if (argv.includes("fetch")) return ok("");
      if (argv.includes("branch") && argv.includes("--list")) return ok("  geoyws-alpha\n");
      if (argv.includes("rev-list")) return ok("1\n");
      return ok("");
    };
    await expect(
      mergeCycle(["--team-dir", teamDir], {
        primitive,
        git,
        raiseFlag: async () => {},
        log: () => {},
      }),
    ).rejects.toThrow(/disk full/);
  });
});

// ---------- (F) --dry-run ----------

describe("mergeCycle — --dry-run", () => {
  test("--dry-run lists prospective merges + does NOT call primitive", async () => {
    let primitiveCalls = 0;
    const primitive = async () => {
      primitiveCalls += 1;
      return { status: "merged", sha: "shouldnt-fire" } as MergeMemberResult;
    };
    const git = async (argv: ReadonlyArray<string>): Promise<SpawnResult> => {
      if (argv.includes("fetch")) return ok("");
      if (argv.includes("branch") && argv.includes("--list")) {
        return ok("  geoyws-alpha\n  geoyws-bob\n");
      }
      if (argv.includes("rev-list")) {
        // Different commit counts so summary distinguishes them.
        return argv.some((a) => a.includes("alpha")) ? ok("3\n") : ok("5\n");
      }
      return ok("");
    };
    const logs: string[] = [];
    const rc = await mergeCycle(["--dry-run", "--team-dir", teamDir], {
      primitive,
      git,
      log: (m) => {
        logs.push(m);
      },
    });
    expect(rc).toBe(0);
    expect(primitiveCalls).toBe(0);
    const log = logs.join("");
    expect(log).toContain("--dry-run: would merge 2 branch(es)");
    expect(log).toContain("geoyws-alpha (3 commit(s) ahead)");
    expect(log).toContain("geoyws-bob (5 commit(s) ahead)");
  });

  test("--dry-run skips 0-ahead branches from wouldMerge", async () => {
    let primitiveCalls = 0;
    const primitive = async () => {
      primitiveCalls += 1;
      return { status: "merged", sha: "x" } as MergeMemberResult;
    };
    const git = async (argv: ReadonlyArray<string>): Promise<SpawnResult> => {
      if (argv.includes("fetch")) return ok("");
      if (argv.includes("branch") && argv.includes("--list")) {
        return ok("  geoyws-alpha\n  geoyws-bob\n");
      }
      if (argv.includes("rev-list")) {
        return argv.some((a) => a.includes("alpha")) ? ok("0\n") : ok("2\n");
      }
      return ok("");
    };
    const logs: string[] = [];
    await mergeCycle(["--dry-run", "--team-dir", teamDir], {
      primitive,
      git,
      log: (m) => {
        logs.push(m);
      },
    });
    expect(primitiveCalls).toBe(0);
    const log = logs.join("");
    expect(log).toContain("would merge 1 branch(es)");
    expect(log).toContain("geoyws-bob");
    expect(log).not.toContain("geoyws-alpha (");
  });
});

// ---------- (G) --push success ----------

describe("mergeCycle — --push on success", () => {
  test("--push + merges + non-staging base → ONE cycle-end push fires", async () => {
    let pushCalls = 0;
    const primitive = async () => ({ status: "merged", sha: "shaX" }) as MergeMemberResult;
    const git = async (argv: ReadonlyArray<string>): Promise<SpawnResult> => {
      if (argv.includes("fetch")) return ok("");
      if (argv.includes("branch") && argv.includes("--list")) {
        return ok("  geoyws-alpha\n  geoyws-bob\n");
      }
      if (argv.includes("rev-list")) return ok("1\n");
      if (argv.includes("push")) {
        pushCalls += 1;
        return ok("");
      }
      return ok("");
    };
    const logs: string[] = [];
    const rc = await mergeCycle(["--push", "--team-dir", teamDir], {
      primitive,
      git,
      raiseFlag: async () => {},
      log: (m) => {
        logs.push(m);
      },
    });
    expect(rc).toBe(0);
    expect(pushCalls).toBe(1); // ONE push regardless of N merges
    expect(logs.join("")).toContain("push:      ok");
  });
});

// ---------- (H) --push staging refusal ----------

describe("mergeCycle — --push on staging base refused", () => {
  test("staging-shaped base + --push → refused + flag + exit 0", async () => {
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({
        name: "test-team",
        members: [{ name: "alpha", role: "member" }],
        merger: { enabled: true, baseBranch: "sopx-staging" },
      }),
    );
    let pushAttempted = false;
    const primitive = async () => ({ status: "merged", sha: "stagingSHA" }) as MergeMemberResult;
    const git = async (argv: ReadonlyArray<string>): Promise<SpawnResult> => {
      if (argv.includes("fetch")) return ok("");
      if (argv.includes("branch") && argv.includes("--list")) {
        return ok("  sopx-staging-alpha\n");
      }
      if (argv.includes("rev-list")) return ok("1\n");
      if (argv.includes("push")) {
        pushAttempted = true;
        return ok("");
      }
      return ok("");
    };
    const flagsRaised: string[] = [];
    const rc = await mergeCycle(["--push", "--team-dir", teamDir], {
      primitive,
      git,
      raiseFlag: async (_dir, body) => {
        flagsRaised.push(body);
      },
      log: () => {},
    });
    expect(rc).toBe(0);
    expect(pushAttempted).toBe(false);
    expect(flagsRaised).toHaveLength(1);
    expect(flagsRaised[0]).toContain("merger-push-refused");
    expect(flagsRaised[0]).toContain("base=sopx-staging");
    expect(flagsRaised[0]).toContain("cycle-merges=1");
  });
});

// ---------- (I) --push fails ----------

describe("mergeCycle — --push fails", () => {
  test("push command non-zero rc → flag + exit 1", async () => {
    const primitive = async () => ({ status: "merged", sha: "shaABC" }) as MergeMemberResult;
    const git = async (argv: ReadonlyArray<string>): Promise<SpawnResult> => {
      if (argv.includes("fetch")) return ok("");
      if (argv.includes("branch") && argv.includes("--list")) {
        return ok("  geoyws-alpha\n");
      }
      if (argv.includes("rev-list")) return ok("1\n");
      if (argv.includes("push")) return fail("fatal: auth required", 128);
      return ok("");
    };
    const flagsRaised: string[] = [];
    const rc = await mergeCycle(["--push", "--team-dir", teamDir], {
      primitive,
      git,
      raiseFlag: async (_dir, body) => {
        flagsRaised.push(body);
      },
      log: () => {},
    });
    expect(rc).toBe(1);
    expect(flagsRaised[0]).toContain("merger-push-failed");
    expect(flagsRaised[0]).toContain("severity=high");
    expect(flagsRaised[0]).toContain("auth required");
  });
});

// ---------- (J) --push not attempted when no merges ----------

describe("mergeCycle — --push skipped when zero merges", () => {
  test("all no-op + --push → no push attempted; pushOutcome='skipped'", async () => {
    let pushAttempted = false;
    const primitive = async () => {
      throw new Error("should not be called when 0 ahead");
    };
    const git = async (argv: ReadonlyArray<string>): Promise<SpawnResult> => {
      if (argv.includes("fetch")) return ok("");
      if (argv.includes("branch") && argv.includes("--list")) {
        return ok("  geoyws-alpha\n");
      }
      if (argv.includes("rev-list")) return ok("0\n");
      if (argv.includes("push")) {
        pushAttempted = true;
        return ok("");
      }
      return ok("");
    };
    const logs: string[] = [];
    const rc = await mergeCycle(["--push", "--team-dir", teamDir], {
      primitive,
      git,
      log: (m) => {
        logs.push(m);
      },
    });
    expect(rc).toBe(0);
    expect(pushAttempted).toBe(false);
    expect(logs.join("")).toContain("push:      skipped");
  });
});

// ---------- Fetch/Branch list error surfaces ----------

describe("mergeCycle — pre-iteration error surfaces", () => {
  test("git fetch fail → ConfigError", async () => {
    const git = async (argv: ReadonlyArray<string>): Promise<SpawnResult> => {
      if (argv.includes("fetch")) return fail("network down", 128);
      return ok("");
    };
    await expect(
      mergeCycle(["--team-dir", teamDir], {
        primitive: async () => ({ status: "merged", sha: "x" }),
        git,
        log: () => {},
      }),
    ).rejects.toThrow(/'git fetch origin' failed/);
  });

  test("git branch --list fail → ConfigError", async () => {
    const git = async (argv: ReadonlyArray<string>): Promise<SpawnResult> => {
      if (argv.includes("fetch")) return ok("");
      if (argv.includes("branch") && argv.includes("--list")) return fail("oops", 128);
      return ok("");
    };
    await expect(
      mergeCycle(["--team-dir", teamDir], {
        primitive: async () => ({ status: "merged", sha: "x" }),
        git,
        log: () => {},
      }),
    ).rejects.toThrow(/'git branch --list geoyws-\*' failed/);
  });

  test("rev-list count failure → ConfigError", async () => {
    const git = async (argv: ReadonlyArray<string>): Promise<SpawnResult> => {
      if (argv.includes("fetch")) return ok("");
      if (argv.includes("branch") && argv.includes("--list")) return ok("  geoyws-alpha\n");
      if (argv.includes("rev-list")) return fail("bad rev", 128);
      return ok("");
    };
    await expect(
      mergeCycle(["--team-dir", teamDir], {
        primitive: async () => ({ status: "merged", sha: "x" }),
        git,
        log: () => {},
      }),
    ).rejects.toThrow(/'git rev-list --count geoyws\.\.geoyws-alpha' failed/);
  });
});

// ---------- Race: primitive returns no-op despite pre-filter saying ahead ----------

describe("mergeCycle — race: primitive returns no-op", () => {
  test("pre-filter said ahead but primitive returns no-op → recorded as no-op", async () => {
    // Simulates a concurrent merge of the same branch between
    // pre-filter rev-list and the primitive call. The primitive's
    // own commits-ahead recheck wins; we record as no-op.
    const primitive = async () =>
      ({ status: "no-op", reason: "no-commits-ahead" }) as MergeMemberResult;
    const git = async (argv: ReadonlyArray<string>): Promise<SpawnResult> => {
      if (argv.includes("fetch")) return ok("");
      if (argv.includes("branch") && argv.includes("--list")) return ok("  geoyws-alpha\n");
      if (argv.includes("rev-list")) return ok("3\n"); // pre-filter says ahead
      return ok("");
    };
    const logs: string[] = [];
    const rc = await mergeCycle(["--team-dir", teamDir], {
      primitive,
      git,
      log: (m) => {
        logs.push(m);
      },
    });
    expect(rc).toBe(0);
    expect(logs.join("")).toContain("no-op:     1");
    expect(logs.join("")).toContain("merged:    0");
  });
});
