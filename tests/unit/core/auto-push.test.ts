// Unit tests for src/core/auto-push.ts (ADR-057 §D7 R57-T7).
//
// Coverage:
//   - isPushAllowed policy (staging patterns + per-team overrides).
//   - getCurrentBranch (success + detached HEAD + non-repo).
//   - runAutoPush flow: skipped-disabled / skipped-staging / fail-fetch
//     / abort-rebase-conflict / fail-push / success.
//   - Audit log appended per attempt.
//   - readAutoPushOptsFromTeam (defaults + overrides).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnResult } from "../../../src/abstractions/spawn.ts";
import {
  type AutoPushAuditEntry,
  appendAuditEntry,
  autoPushLogPath,
  defaultGitSpawn,
  type GitSpawn,
  getCurrentBranch,
  isPushAllowed,
  readAutoPushOptsFromTeam,
  runAutoPush,
  STAGING_PATTERNS,
} from "../../../src/core/auto-push.ts";

let atmuxDir: string;

beforeEach(async () => {
  atmuxDir = await mkdtemp(join(tmpdir(), "atmux-auto-push-"));
});

afterEach(async () => {
  await rm(atmuxDir, { recursive: true, force: true });
});

// ---------- Helpers ----------

function gitSpawnReturning(byArgv: Record<string, SpawnResult>): GitSpawn {
  return async (argv): Promise<SpawnResult> => {
    const key = argv.join(" ");
    const r = byArgv[key];
    if (r === undefined) {
      // Default: success with empty stdout/stderr.
      return ok();
    }
    return r;
  };
}

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

function fail(stderr: string, code = 1): SpawnResult {
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

// ---------- Constants + STAGING_PATTERNS ----------

describe("STAGING_PATTERNS", () => {
  test("matches *-staging branches", () => {
    expect(STAGING_PATTERNS.some((re) => re.test("sopx-staging"))).toBe(true);
    expect(STAGING_PATTERNS.some((re) => re.test("aix-staging"))).toBe(true);
    expect(STAGING_PATTERNS.some((re) => re.test("foo-bar-staging"))).toBe(true);
  });

  test("matches main, master, production", () => {
    expect(STAGING_PATTERNS.some((re) => re.test("main"))).toBe(true);
    expect(STAGING_PATTERNS.some((re) => re.test("master"))).toBe(true);
    expect(STAGING_PATTERNS.some((re) => re.test("production"))).toBe(true);
  });

  test("rejects non-staging branches", () => {
    expect(STAGING_PATTERNS.some((re) => re.test("worktree-atmux-bun"))).toBe(false);
    expect(STAGING_PATTERNS.some((re) => re.test("feature/foo"))).toBe(false);
    expect(STAGING_PATTERNS.some((re) => re.test("staging-something"))).toBe(false); // no -staging suffix
  });
});

// ---------- isPushAllowed ----------

describe("isPushAllowed", () => {
  test("non-staging branches allowed by default", () => {
    expect(isPushAllowed("worktree-atmux-bun")).toBe(true);
    expect(isPushAllowed("feature/x")).toBe(true);
  });

  test("staging-shaped branches refused by default", () => {
    expect(isPushAllowed("sopx-staging")).toBe(false);
    expect(isPushAllowed("main")).toBe(false);
    expect(isPushAllowed("master")).toBe(false);
    expect(isPushAllowed("production")).toBe(false);
  });

  test("override allowlist re-permits a staging-shaped branch", () => {
    expect(isPushAllowed("main", ["main"])).toBe(true);
    expect(isPushAllowed("sopx-staging", ["sopx-staging", "other"])).toBe(true);
  });

  test("override doesn't accidentally permit unrelated staging branches", () => {
    expect(isPushAllowed("main", ["sopx-staging"])).toBe(false);
  });
});

// ---------- getCurrentBranch ----------

describe("getCurrentBranch", () => {
  test("returns trimmed branch name on success", async () => {
    const git = gitSpawnReturning({
      "symbolic-ref --short HEAD": ok("worktree-atmux-bun\n"),
    });
    expect(await getCurrentBranch(git)).toBe("worktree-atmux-bun");
  });

  test("returns null on detached HEAD (non-zero exit)", async () => {
    const git = gitSpawnReturning({
      "symbolic-ref --short HEAD": fail("HEAD is detached"),
    });
    expect(await getCurrentBranch(git)).toBeNull();
  });

  test("returns null on empty stdout", async () => {
    const git = gitSpawnReturning({
      "symbolic-ref --short HEAD": ok(""),
    });
    expect(await getCurrentBranch(git)).toBeNull();
  });

  test("default git spawner exists (sanity check; not invoked here)", () => {
    expect(typeof defaultGitSpawn).toBe("function");
  });
});

// ---------- Audit log ----------

describe("appendAuditEntry", () => {
  test("creates logs/auto-push.jsonl with one JSON line per entry", async () => {
    const e1: AutoPushAuditEntry = { ts: 1, branch: "x", outcome: "success" };
    const e2: AutoPushAuditEntry = {
      ts: 2,
      branch: "main",
      outcome: "skipped-staging",
      detail: "staging policy",
    };
    await appendAuditEntry(atmuxDir, e1);
    await appendAuditEntry(atmuxDir, e2);
    const text = await readFile(autoPushLogPath(atmuxDir), "utf8");
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual(e1);
    expect(JSON.parse(lines[1]!)).toEqual(e2);
  });

  test("autoPushLogPath resolves under <atmuxDir>/logs", () => {
    expect(autoPushLogPath("/tmp/foo")).toBe("/tmp/foo/logs/auto-push.jsonl");
  });
});

// ---------- runAutoPush — disabled ----------

describe("runAutoPush — enabled=false", () => {
  test("short-circuits to skipped-disabled + audit-logs", async () => {
    const result = await runAutoPush(atmuxDir, { enabled: false });
    expect(result.outcome).toBe("skipped-disabled");
    expect(result.branch).toBeNull();
    const text = await readFile(autoPushLogPath(atmuxDir), "utf8");
    const entry = JSON.parse(text.trim());
    expect(entry.outcome).toBe("skipped-disabled");
  });
});

// ---------- runAutoPush — branch-resolve failure ----------

describe("runAutoPush — branch-resolve failure", () => {
  test("detached HEAD → fail-branch-resolve audit + early return", async () => {
    const git = gitSpawnReturning({
      "symbolic-ref --short HEAD": fail("not a git repo"),
    });
    const result = await runAutoPush(atmuxDir, { git });
    expect(result.outcome).toBe("fail-branch-resolve");
    expect(result.branch).toBeNull();
    const entry = JSON.parse((await readFile(autoPushLogPath(atmuxDir), "utf8")).trim());
    expect(entry.outcome).toBe("fail-branch-resolve");
  });
});

// ---------- runAutoPush — staging policy refusal ----------

describe("runAutoPush — staging-policy refusal", () => {
  test("main branch → skipped-staging audit + no fetch / push attempted", async () => {
    let fetchCalls = 0;
    let pushCalls = 0;
    const git: GitSpawn = async (argv) => {
      const key = argv.join(" ");
      if (key === "symbolic-ref --short HEAD") return ok("main\n");
      if (key.startsWith("fetch")) fetchCalls += 1;
      if (key.startsWith("push")) pushCalls += 1;
      return ok();
    };
    const result = await runAutoPush(atmuxDir, { git });
    expect(result.outcome).toBe("skipped-staging");
    expect(result.branch).toBe("main");
    expect(fetchCalls).toBe(0);
    expect(pushCalls).toBe(0);
  });

  test("override allowlist permits a staging-shaped branch", async () => {
    let pushArgv = "";
    const git: GitSpawn = async (argv) => {
      const key = argv.join(" ");
      if (key === "symbolic-ref --short HEAD") return ok("main\n");
      if (key.startsWith("push")) pushArgv = key;
      return ok();
    };
    const result = await runAutoPush(atmuxDir, {
      git,
      allowedPushBranches: ["main"],
    });
    expect(result.outcome).toBe("success");
    expect(pushArgv).toBe("push origin main");
  });
});

// ---------- runAutoPush — rebase failures ----------

describe("runAutoPush — rebase failures", () => {
  test("fetch failure → fail-fetch + flag P3 + abort", async () => {
    const git: GitSpawn = async (argv) => {
      const key = argv.join(" ");
      if (key === "symbolic-ref --short HEAD") return ok("worktree-atmux-bun\n");
      if (key.startsWith("fetch")) return fail("network down");
      return ok();
    };
    const flags: Array<{ severity: string; body: string }> = [];
    const result = await runAutoPush(atmuxDir, {
      git,
      raiseFlag: async (severity, body) => {
        flags.push({ severity, body });
        return { flagId: "f-fetch1" };
      },
    });
    expect(result.outcome).toBe("fail-fetch");
    expect(flags).toHaveLength(1);
    expect(flags[0]?.severity).toBe("p3");
    const entry = JSON.parse((await readFile(autoPushLogPath(atmuxDir), "utf8")).trim());
    expect(entry.outcome).toBe("fail-fetch");
    expect(entry.flagId).toBe("f-fetch1");
  });

  test("rebase conflict → abort-rebase-conflict + flag P1 + git rebase --abort fired", async () => {
    let abortFired = false;
    const git: GitSpawn = async (argv) => {
      const key = argv.join(" ");
      if (key === "symbolic-ref --short HEAD") return ok("worktree-atmux-bun\n");
      if (key.startsWith("fetch")) return ok();
      if (key === "rebase origin/worktree-atmux-bun") return fail("CONFLICT in foo.ts");
      if (key === "rebase --abort") {
        abortFired = true;
        return ok();
      }
      return ok();
    };
    const flags: Array<{ severity: string; body: string }> = [];
    const result = await runAutoPush(atmuxDir, {
      git,
      raiseFlag: async (severity, body) => {
        flags.push({ severity, body });
        return { flagId: "f-rebase1" };
      },
    });
    expect(result.outcome).toBe("abort-rebase-conflict");
    expect(abortFired).toBe(true);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.severity).toBe("p1");
  });

  test("rebase=false skips fetch + rebase entirely", async () => {
    let fetchCalls = 0;
    let rebaseCalls = 0;
    const git: GitSpawn = async (argv) => {
      const key = argv.join(" ");
      if (key === "symbolic-ref --short HEAD") return ok("worktree-atmux-bun\n");
      if (key.startsWith("fetch")) fetchCalls += 1;
      if (key.startsWith("rebase")) rebaseCalls += 1;
      return ok();
    };
    await runAutoPush(atmuxDir, { git, rebase: false });
    expect(fetchCalls).toBe(0);
    expect(rebaseCalls).toBe(0);
  });
});

// ---------- runAutoPush — push failures ----------

describe("runAutoPush — push failures", () => {
  test("push failure → fail-push + flag P3 + audit", async () => {
    const git: GitSpawn = async (argv) => {
      const key = argv.join(" ");
      if (key === "symbolic-ref --short HEAD") return ok("worktree-atmux-bun\n");
      if (key.startsWith("fetch")) return ok();
      if (key.startsWith("rebase")) return ok();
      if (key.startsWith("push")) return fail("authentication failed");
      return ok();
    };
    const flags: Array<{ severity: string; body: string }> = [];
    const result = await runAutoPush(atmuxDir, {
      git,
      raiseFlag: async (severity, body) => {
        flags.push({ severity, body });
        return { flagId: "f-push1" };
      },
    });
    expect(result.outcome).toBe("fail-push");
    expect(flags).toHaveLength(1);
    expect(flags[0]?.severity).toBe("p3");
  });

  test("flag-raise itself failing is non-fatal (best-effort)", async () => {
    const git: GitSpawn = async (argv) => {
      const key = argv.join(" ");
      if (key === "symbolic-ref --short HEAD") return ok("worktree-atmux-bun\n");
      if (key.startsWith("fetch")) return ok();
      if (key.startsWith("rebase")) return ok();
      if (key.startsWith("push")) return fail("err");
      return ok();
    };
    // raiseFlag throws; runAutoPush must still complete with a logged outcome.
    const result = await runAutoPush(atmuxDir, {
      git,
      raiseFlag: async () => {
        throw new Error("flag-svc down");
      },
    });
    expect(result.outcome).toBe("fail-push");
  });
});

// ---------- runAutoPush — happy path ----------

describe("runAutoPush — happy path", () => {
  test("non-staging branch + clean rebase → success audit", async () => {
    const git: GitSpawn = async (argv) => {
      const key = argv.join(" ");
      if (key === "symbolic-ref --short HEAD") return ok("worktree-atmux-bun\n");
      return ok(); // fetch / rebase / push all succeed
    };
    const result = await runAutoPush(atmuxDir, { git });
    expect(result.outcome).toBe("success");
    expect(result.branch).toBe("worktree-atmux-bun");
    const entry = JSON.parse((await readFile(autoPushLogPath(atmuxDir), "utf8")).trim());
    expect(entry.outcome).toBe("success");
  });
});

// ---------- readAutoPushOptsFromTeam ----------

describe("readAutoPushOptsFromTeam", () => {
  test("no whip block → defaults (enabled=true, rebase=true, no overrides)", () => {
    expect(readAutoPushOptsFromTeam({})).toEqual({
      enabled: true,
      rebase: true,
      allowedPushBranches: [],
    });
  });

  test("whip.stallPrevention.autoPushOnDone=false disables", () => {
    expect(
      readAutoPushOptsFromTeam({
        whip: { stallPrevention: { autoPushOnDone: false } },
      }),
    ).toMatchObject({ enabled: false });
  });

  test("whip.stallPrevention.rebaseBeforePush=false skips rebase", () => {
    expect(
      readAutoPushOptsFromTeam({
        whip: { stallPrevention: { rebaseBeforePush: false } },
      }),
    ).toMatchObject({ rebase: false });
  });

  test("allowedPushBranches array preserved (string-filtered)", () => {
    expect(
      readAutoPushOptsFromTeam({
        whip: {
          stallPrevention: {
            allowedPushBranches: ["main", "production", 42, null],
          },
        },
      }).allowedPushBranches,
    ).toEqual(["main", "production"]);
  });

  test("non-array allowedPushBranches → empty list (defensive)", () => {
    expect(
      readAutoPushOptsFromTeam({
        whip: { stallPrevention: { allowedPushBranches: "main" } },
      }).allowedPushBranches,
    ).toEqual([]);
  });
});
