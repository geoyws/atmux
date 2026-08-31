// Unit tests for src/verbs/merge-member.ts (ADR-179 W2 / t-e7724527).
//
// Strategy:
//   - parser tests run pure on the exported `parseMergeMemberArgs`
//   - verb-level tests inject mocks for `primitive`, `git`, `raiseFlag`,
//     and `log` so every decision branch is exercised without spawning
//     real git or writing real flags.md.
//   - Fixture: minimal `<tmp>/.atmux/team.json` so `requireTeam`
//     resolves, plus a `mergerConfig: { enabled: true, baseBranch:
//     "geoyws" }` (so we don't depend on a tmp git repo for branch
//     detection).
//
// The decision tree:
//   (A) parser — missing member, --push, --team-dir, unknown flag
//   (B) conflict → flag raised + exit 1
//   (C) no-op → exit 0
//   (D) merged without --push → exit 0
//   (E) merged with --push (allowed branch) → push runs + exit 0
//   (F) merged with --push (staging branch) → push refused + flag + exit 0
//   (G) merged with --push (allowed) but push fails → flag + exit 1

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MergeMemberOpts, MergeMemberResult } from "../../../src/abstractions/branch-merge.ts";
import { MergeConflictError } from "../../../src/abstractions/branch-merge.ts";
import type { SpawnResult } from "../../../src/abstractions/spawn.ts";
import { UsageError } from "../../../src/errors.ts";
import {
  mergeMember as mergeMemberVerb,
  parseMergeMemberArgs,
} from "../../../src/verbs/merge-member.ts";

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
  teamDir = await mkdtemp(join(tmpdir(), "atmux-mergemember-"));
  atmuxDir = join(teamDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  await writeFile(
    join(atmuxDir, "team.json"),
    JSON.stringify({
      name: "test-team",
      members: [
        { name: "alpha", role: "member" },
        { name: "bob.smith", role: "member" },
      ],
      merger: { enabled: true, baseBranch: "geoyws" },
    }),
  );
});

afterEach(async () => {
  await rm(teamDir, { recursive: true, force: true });
});

// ---------- (A) Parser ----------

describe("parseMergeMemberArgs", () => {
  test("bare <member> parses", () => {
    const a = parseMergeMemberArgs(["alpha"]);
    expect(a.member).toBe("alpha");
    expect(a.push).toBe(false);
    expect(a.teamDir).toBeUndefined();
  });

  test("--push sets push=true", () => {
    expect(parseMergeMemberArgs(["alpha", "--push"]).push).toBe(true);
  });

  test("--team-dir <dir> captured", () => {
    const a = parseMergeMemberArgs(["alpha", "--team-dir", "/srv/repo"]);
    expect(a.teamDir).toBe("/srv/repo");
  });

  test("missing member → UsageError", () => {
    expect(() => parseMergeMemberArgs([])).toThrow(UsageError);
  });

  test("two positionals → UsageError", () => {
    expect(() => parseMergeMemberArgs(["alpha", "bob"])).toThrow(UsageError);
  });

  test("unknown flag → UsageError", () => {
    expect(() => parseMergeMemberArgs(["alpha", "--bogus"])).toThrow(UsageError);
  });

  test("--team-dir without value → UsageError", () => {
    expect(() => parseMergeMemberArgs(["alpha", "--team-dir"])).toThrow(UsageError);
  });

  test("flag order is flexible — --push before member", () => {
    const a = parseMergeMemberArgs(["--push", "alpha"]);
    expect(a.member).toBe("alpha");
    expect(a.push).toBe(true);
  });
});

// ---------- (B) Conflict path ----------

describe("merge-member verb — conflict path", () => {
  test("MergeConflictError → flag raised with severity=high + exit 1", async () => {
    const flagsRaised: Array<{ dir: string; body: string }> = [];
    const logs: string[] = [];
    const primitive = async (
      _base: string,
      wtBranch: string,
      _repoPath: string,
      _opts?: MergeMemberOpts,
    ): Promise<MergeMemberResult> => {
      throw new MergeConflictError({
        wtBranch,
        conflictPaths: ["src/foo.ts", "src/bar.ts"],
      });
    };
    const rc = await mergeMemberVerb(["alpha", "--team-dir", teamDir], {
      primitive,
      raiseFlag: async (dir, body) => {
        flagsRaised.push({ dir, body });
      },
      log: (m) => {
        logs.push(m);
      },
    });
    expect(rc).toBe(1);
    expect(flagsRaised).toHaveLength(1);
    expect(flagsRaised[0]?.body).toContain("merger-conflict");
    expect(flagsRaised[0]?.body).toContain("severity=high");
    expect(flagsRaised[0]?.body).toContain("alpha");
    expect(flagsRaised[0]?.body).toContain("geoyws-alpha");
    expect(flagsRaised[0]?.body).toContain("src/foo.ts");
    expect(logs.join("")).toContain("conflict on geoyws-alpha");
  });

  test("MergeConflictError with empty conflictPaths → '<unknown>' marker in flag body", async () => {
    const flagsRaised: string[] = [];
    const primitive = async (_base: string, wtBranch: string): Promise<MergeMemberResult> => {
      throw new MergeConflictError({ wtBranch, conflictPaths: [] });
    };
    const rc = await mergeMemberVerb(["alpha", "--team-dir", teamDir], {
      primitive,
      raiseFlag: async (_dir, body) => {
        flagsRaised.push(body);
      },
      log: () => {},
    });
    expect(rc).toBe(1);
    expect(flagsRaised[0]).toContain("paths=<unknown>");
  });

  test("non-MergeConflictError throws are propagated to caller", async () => {
    const primitive = async () => {
      throw new Error("filesystem busted");
    };
    await expect(
      mergeMemberVerb(["alpha", "--team-dir", teamDir], {
        primitive,
        raiseFlag: async () => {},
        log: () => {},
      }),
    ).rejects.toThrow(/filesystem busted/);
  });
});

// ---------- (C) No-op path ----------

describe("merge-member verb — no-op path", () => {
  test("status='no-op' → exit 0 + informational stdout, no flag", async () => {
    const flagsRaised: string[] = [];
    const logs: string[] = [];
    const primitive = async (): Promise<MergeMemberResult> => ({
      status: "no-op",
      reason: "no-commits-ahead",
    });
    const rc = await mergeMemberVerb(["alpha", "--team-dir", teamDir], {
      primitive,
      raiseFlag: async (_dir, body) => {
        flagsRaised.push(body);
      },
      log: (m) => {
        logs.push(m);
      },
    });
    expect(rc).toBe(0);
    expect(flagsRaised).toHaveLength(0);
    expect(logs.join("")).toContain("no-op");
    expect(logs.join("")).toContain("alpha");
    expect(logs.join("")).toContain("geoyws-alpha");
  });

  test("status='no-op' with default log → exit 0 and writes stdout", async () => {
    const primitive = async (): Promise<MergeMemberResult> => ({
      status: "no-op",
      reason: "no-commits-ahead",
    });
    const originalWrite = process.stdout.write;
    let captured = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stdout.write;
    try {
      const rc = await mergeMemberVerb(["alpha", "--team-dir", teamDir], {
        primitive,
      });
      expect(rc).toBe(0);
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(captured).toContain("merge-member: no-op");
    expect(captured).toContain("alpha");
    expect(captured).toContain("geoyws-alpha");
  });

  test("no-op does NOT attempt push even with --push flag", async () => {
    let pushAttempted = false;
    const primitive = async (): Promise<MergeMemberResult> => ({
      status: "no-op",
      reason: "no-commits-ahead",
    });
    const git = async (argv: ReadonlyArray<string>) => {
      if (argv.includes("push")) {
        pushAttempted = true;
        return ok("");
      }
      return ok("");
    };
    const rc = await mergeMemberVerb(["alpha", "--push", "--team-dir", teamDir], {
      primitive,
      git,
      raiseFlag: async () => {},
      log: () => {},
    });
    expect(rc).toBe(0);
    expect(pushAttempted).toBe(false);
  });
});

// ---------- (D) Merged without --push ----------

describe("merge-member verb — merged without --push", () => {
  test("status='merged' + no --push → exit 0 + sha in stdout, no push call", async () => {
    const logs: string[] = [];
    let pushAttempted = false;
    const primitive = async (): Promise<MergeMemberResult> => ({
      status: "merged",
      sha: "deadbeefcafe1234",
    });
    const git = async (argv: ReadonlyArray<string>) => {
      if (argv.includes("push")) {
        pushAttempted = true;
      }
      return ok("");
    };
    const rc = await mergeMemberVerb(["alpha", "--team-dir", teamDir], {
      primitive,
      git,
      raiseFlag: async () => {},
      log: (m) => {
        logs.push(m);
      },
    });
    expect(rc).toBe(0);
    expect(pushAttempted).toBe(false);
    expect(logs.join("")).toContain("merged geoyws-alpha → geoyws");
    expect(logs.join("")).toContain("deadbeefcafe1234");
  });
});

// ---------- (E) Merged with --push (allowed) ----------

describe("merge-member verb — merged with --push (allowed branch)", () => {
  test("non-staging base + --push → push fires + exit 0", async () => {
    const logs: string[] = [];
    let pushArgv: ReadonlyArray<string> = [];
    const primitive = async (): Promise<MergeMemberResult> => ({
      status: "merged",
      sha: "abc12300",
    });
    const git = async (argv: ReadonlyArray<string>) => {
      if (argv.includes("push")) {
        pushArgv = argv;
        return ok("");
      }
      return ok("");
    };
    const rc = await mergeMemberVerb(["alpha", "--push", "--team-dir", teamDir], {
      primitive,
      git,
      raiseFlag: async () => {},
      log: (m) => {
        logs.push(m);
      },
    });
    expect(rc).toBe(0);
    expect(pushArgv).toContain("push");
    expect(pushArgv).toContain("origin");
    expect(pushArgv).toContain("geoyws"); // base
    expect(logs.join("")).toContain("pushed geoyws to origin");
  });
});

// ---------- (F) Merged with --push (refused — staging branch) ----------

describe("merge-member verb — push refused by staging policy", () => {
  test("base='<x>-staging' + --push → flag + exit 0 (merge kept; push deferred)", async () => {
    // Re-write team.json with a staging-shaped base.
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({
        name: "test-team",
        members: [{ name: "alpha", role: "member" }],
        merger: { enabled: true, baseBranch: "sopx-staging" },
      }),
    );

    const flagsRaised: string[] = [];
    const logs: string[] = [];
    let pushAttempted = false;
    const primitive = async (): Promise<MergeMemberResult> => ({
      status: "merged",
      sha: "stagingsha01",
    });
    const git = async (argv: ReadonlyArray<string>) => {
      if (argv.includes("push")) {
        pushAttempted = true;
        return ok("");
      }
      return ok("");
    };
    const rc = await mergeMemberVerb(["alpha", "--push", "--team-dir", teamDir], {
      primitive,
      git,
      raiseFlag: async (_dir, body) => {
        flagsRaised.push(body);
      },
      log: (m) => {
        logs.push(m);
      },
    });
    expect(rc).toBe(0);
    expect(pushAttempted).toBe(false);
    expect(flagsRaised).toHaveLength(1);
    expect(flagsRaised[0]).toContain("merger-push-refused");
    expect(flagsRaised[0]).toContain("severity=medium");
    expect(flagsRaised[0]).toContain("base=sopx-staging");
    expect(flagsRaised[0]).toContain("stagingsha01");
    expect(logs.join("")).toContain("push refused");
  });

  test("base='main' + --push → also refused (staging pattern catches main)", async () => {
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({
        name: "test-team",
        members: [{ name: "alpha", role: "member" }],
        merger: { enabled: true, baseBranch: "main" },
      }),
    );
    const flagsRaised: string[] = [];
    const primitive = async (): Promise<MergeMemberResult> => ({
      status: "merged",
      sha: "mainsha000",
    });
    const rc = await mergeMemberVerb(["alpha", "--push", "--team-dir", teamDir], {
      primitive,
      raiseFlag: async (_dir, body) => {
        flagsRaised.push(body);
      },
      log: () => {},
    });
    expect(rc).toBe(0);
    expect(flagsRaised[0]).toContain("merger-push-refused");
    expect(flagsRaised[0]).toContain("base=main");
  });
});

// ---------- (G) Merged with --push (allowed) but push fails ----------

describe("merge-member verb — push failure", () => {
  test("push exit 128 → flag with severity=high + exit 1", async () => {
    const flagsRaised: string[] = [];
    const logs: string[] = [];
    const primitive = async (): Promise<MergeMemberResult> => ({
      status: "merged",
      sha: "shaXYZ001",
    });
    const git = async (argv: ReadonlyArray<string>) => {
      if (argv.includes("push")) {
        return fail("fatal: could not resolve hostname", 128);
      }
      return ok("");
    };
    const rc = await mergeMemberVerb(["alpha", "--push", "--team-dir", teamDir], {
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
    expect(flagsRaised[0]).toContain("merger-push-failed");
    expect(flagsRaised[0]).toContain("severity=high");
    expect(flagsRaised[0]).toContain("base=geoyws");
    expect(flagsRaised[0]).toContain("shaXYZ001");
    expect(flagsRaised[0]).toContain("could not resolve hostname");
    expect(logs.join("")).toContain("push failed");
  });
});

// ---------- wtBranch derivation ----------

describe("merge-member verb — wtBranch derivation", () => {
  test("member name with dots → sanitizeBranchSegment strips them", async () => {
    let observedWtBranch = "";
    const primitive = async (_base: string, wtBranch: string): Promise<MergeMemberResult> => {
      observedWtBranch = wtBranch;
      return { status: "no-op", reason: "no-commits-ahead" };
    };
    await mergeMemberVerb(["bob.smith", "--team-dir", teamDir], {
      primitive,
      raiseFlag: async () => {},
      log: () => {},
    });
    // sanitizeBranchSegment replaces non-alphanum (other than `-_`)
    // with `-` per ADR-082 W1; verify the resulting wtBranch is
    // `geoyws-bob-smith` (not `geoyws-bob.smith`).
    expect(observedWtBranch).toBe("geoyws-bob-smith");
  });
});

// ---------- Default flag-raise (real FS) ----------

describe("merge-member verb — default flag-raise (real flags.md)", () => {
  test("conflict path → flags.md gets a bullet line appended", async () => {
    const primitive = async (_base: string, wtBranch: string): Promise<MergeMemberResult> => {
      throw new MergeConflictError({ wtBranch, conflictPaths: ["x.ts"] });
    };
    const rc = await mergeMemberVerb(["alpha", "--team-dir", teamDir], {
      primitive,
      // Use the DEFAULT raiseFlag (no override) — exercises the
      // real appendText path.
      log: () => {},
    });
    expect(rc).toBe(1);
    const flagsContent = await readFile(join(atmuxDir, "flags.md"), "utf8");
    expect(flagsContent).toContain("- merger-conflict");
    expect(flagsContent).toContain("alpha");
    expect(flagsContent).toContain("x.ts");
  });
});
