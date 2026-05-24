// Unit tests for src/core/orchd-dispatch/git-push.ts — ADR-232 §D1
// cross-cage git-push dispatcher.
//
// Coverage (per Task t-5-047ae9e7 AC):
//   - local-route: fetch + rev-list + push happy path → pushed{headSha}
//   - local-route: upstream-advanced (behind > 0) → upstream-advanced{ahead,behind,divergenceSha}
//   - remote-route: cage in roster but not local → skipped-not-mine (deferred per §D2)
//   - route-failure-flag: fetch fails → flag raised + skipped-not-mine
//   - cage-not-found: cage absent from roster → flag raised + skipped-not-mine
//   - push-rejection-flag: git push non-zero exit → flag raised + skipped-not-mine
//   - input validation: missing cage / branch → ZodError throw
//   - default remote = 'origin' when omitted

import { describe, expect, test } from "bun:test";
import type { SpawnResult } from "../../../../src/abstractions/spawn.ts";
import type { GitSpawn } from "../../../../src/abstractions/worktree.ts";
import {
  dispatchGitPush,
  DispatchGitPushInputSchema,
  type FlagSeverity,
} from "../../../../src/core/orchd-dispatch/git-push.ts";

// ---------- Test helpers ----------

function spawnOk(stdout = "", stderr = ""): SpawnResult {
  return {
    cmd: "git",
    argv: [],
    exitCode: 0,
    signalled: null,
    stdout,
    stderr,
    durationMs: 1,
  };
}

function spawnFail(exitCode: number, stderr: string): SpawnResult {
  return {
    cmd: "git",
    argv: [],
    exitCode,
    signalled: null,
    stdout: "",
    stderr,
    durationMs: 1,
  };
}

interface CallLog {
  argv: ReadonlyArray<string>;
}

function recordingGit(responses: ReadonlyArray<SpawnResult>): {
  git: GitSpawn;
  calls: CallLog[];
} {
  const calls: CallLog[] = [];
  let i = 0;
  const git: GitSpawn = async (argv) => {
    calls.push({ argv });
    const r = responses[i++];
    if (r === undefined) {
      throw new Error(`recordingGit: ran out of responses at call ${i} argv=${argv.join(" ")}`);
    }
    return { ...r, argv };
  };
  return { git, calls };
}

interface FlagCall {
  severity: FlagSeverity;
  body: string;
}

function recordingFlag(): { raiseFlag: (s: FlagSeverity, b: string) => Promise<void>; calls: FlagCall[] } {
  const calls: FlagCall[] = [];
  const raiseFlag = async (severity: FlagSeverity, body: string): Promise<void> => {
    calls.push({ severity, body });
  };
  return { raiseFlag, calls };
}

// ---------- Input schema ----------

describe("DispatchGitPushInputSchema", () => {
  test("accepts { cage, branch } with optional remote", () => {
    expect(DispatchGitPushInputSchema.parse({ cage: "c", branch: "b" })).toEqual({
      cage: "c",
      branch: "b",
    });
    expect(
      DispatchGitPushInputSchema.parse({ cage: "c", branch: "b", remote: "upstream" }),
    ).toEqual({ cage: "c", branch: "b", remote: "upstream" });
  });
  test("rejects empty cage / branch", () => {
    expect(() => DispatchGitPushInputSchema.parse({ cage: "", branch: "b" })).toThrow();
    expect(() => DispatchGitPushInputSchema.parse({ cage: "c", branch: "" })).toThrow();
  });
  test("rejects missing cage / branch", () => {
    expect(() => DispatchGitPushInputSchema.parse({ branch: "b" })).toThrow();
    expect(() => DispatchGitPushInputSchema.parse({ cage: "c" })).toThrow();
  });
});

// ---------- Local route — happy path ----------

describe("local route — happy path", () => {
  test("fetch + rev-list (no behind) + push → pushed{headSha}", async () => {
    const { git, calls } = recordingGit([
      spawnOk("", ""), // fetch
      spawnOk("3\t0", ""), // rev-list (ahead=3, behind=0)
      spawnOk("", ""), // push
      spawnOk("deadbeef0000\n"), // rev-parse HEAD
    ]);
    const flag = recordingFlag();

    const result = await dispatchGitPush(
      { cage: "local-cage", branch: "atmux-geoyws" },
      { git, localCageName: "local-cage", raiseFlag: flag.raiseFlag },
    );

    expect(result).toEqual({ state: "pushed", headSha: "deadbeef0000" });
    expect(calls.length).toBe(4);
    expect(calls[0]?.argv).toEqual(["fetch", "origin", "atmux-geoyws"]);
    expect(calls[1]?.argv).toEqual([
      "rev-list",
      "--left-right",
      "--count",
      "HEAD...origin/atmux-geoyws",
    ]);
    expect(calls[2]?.argv).toEqual(["push", "origin", "atmux-geoyws"]);
    expect(calls[3]?.argv).toEqual(["rev-parse", "HEAD"]);
    expect(flag.calls.length).toBe(0);
  });

  test("custom remote override flows through to git argv", async () => {
    const { git, calls } = recordingGit([
      spawnOk("", ""),
      spawnOk("1\t0", ""),
      spawnOk("", ""),
      spawnOk("cafe1234\n"),
    ]);
    const flag = recordingFlag();

    const result = await dispatchGitPush(
      { cage: "c", branch: "feat-x", remote: "upstream" },
      { git, localCageName: "c", raiseFlag: flag.raiseFlag },
    );

    expect(result.state).toBe("pushed");
    expect(calls[0]?.argv[1]).toBe("upstream");
    expect(calls[1]?.argv[3]).toBe("HEAD...upstream/feat-x");
    expect(calls[2]?.argv[1]).toBe("upstream");
  });
});

// ---------- Local route — upstream-advanced ----------

describe("local route — upstream-advanced (Gate-1 conflict)", () => {
  test("rev-list reports behind > 0 → upstream-advanced{ahead,behind,divergenceSha}", async () => {
    const { git, calls } = recordingGit([
      spawnOk("", ""), // fetch
      spawnOk("1\t4", ""), // rev-list (ahead=1, behind=4)
      spawnOk("abc12345\n"), // merge-base
    ]);
    const flag = recordingFlag();

    const result = await dispatchGitPush(
      { cage: "c", branch: "b" },
      { git, localCageName: "c", raiseFlag: flag.raiseFlag },
    );

    expect(result).toEqual({
      state: "upstream-advanced",
      ahead: 1,
      behind: 4,
      divergenceSha: "abc12345",
    });
    // 3 calls: fetch, rev-list, merge-base — NO push.
    expect(calls.length).toBe(3);
    expect(calls.map((c) => c.argv[0])).toEqual(["fetch", "rev-list", "merge-base"]);
    expect(flag.calls.length).toBe(0);
  });

  test("merge-base failure → omits divergenceSha (still upstream-advanced)", async () => {
    const { git } = recordingGit([
      spawnOk("", ""),
      spawnOk("0\t2", ""),
      spawnFail(128, "merge-base fatal"),
    ]);

    const result = await dispatchGitPush(
      { cage: "c", branch: "b" },
      { git, localCageName: "c" },
    );

    expect(result.state).toBe("upstream-advanced");
    expect((result as { ahead: number }).ahead).toBe(0);
    expect((result as { behind: number }).behind).toBe(2);
    expect("divergenceSha" in result).toBe(false);
  });
});

// ---------- Route — remote cage (deferred per §D2) ----------

describe("remote route — deferred per ADR-232 §D2 (local-only v1)", () => {
  test("cage in roster but not local → skipped-not-mine with deferred reason; no git invocation", async () => {
    const { git, calls } = recordingGit([]);
    const flag = recordingFlag();

    const result = await dispatchGitPush(
      { cage: "cage-B", branch: "b" },
      {
        git,
        localCageName: "cage-A",
        listCages: async () => ["cage-A", "cage-B"],
        raiseFlag: flag.raiseFlag,
      },
    );

    expect(result.state).toBe("skipped-not-mine");
    expect((result as { reason: string }).reason).toContain("ADR-232 §D2 deferred");
    expect((result as { reason: string }).reason).toContain("cage-B");
    expect(calls.length).toBe(0);
    expect(flag.calls.length).toBe(0); // routed but deferred — no flag
  });
});

// ---------- Cage-not-found ----------

describe("cage-not-found gate", () => {
  test("cage absent from roster → flag raised + skipped-not-mine; no git invocation", async () => {
    const { git, calls } = recordingGit([]);
    const flag = recordingFlag();

    const result = await dispatchGitPush(
      { cage: "ghost", branch: "b" },
      {
        git,
        localCageName: "cage-A",
        listCages: async () => ["cage-A"],
        raiseFlag: flag.raiseFlag,
      },
    );

    expect(result.state).toBe("skipped-not-mine");
    expect((result as { reason: string }).reason).toBe("cage-not-found: ghost");
    expect(calls.length).toBe(0);
    expect(flag.calls.length).toBe(1);
    expect(flag.calls[0]?.severity).toBe("p1");
    expect(flag.calls[0]?.body).toContain("ghost");
    expect(flag.calls[0]?.body).toContain("not in roster");
  });

  test("empty roster + no local cage → cage-not-found flag", async () => {
    const flag = recordingFlag();
    const result = await dispatchGitPush(
      { cage: "x", branch: "b" },
      { listCages: async () => [], raiseFlag: flag.raiseFlag },
    );
    expect(result.state).toBe("skipped-not-mine");
    expect(flag.calls.length).toBe(1);
    expect(flag.calls[0]?.body).toContain("known: <none>");
  });
});

// ---------- Route-failure: fetch fails ----------

describe("route-failure-flag — fetch failure", () => {
  test("git fetch non-zero exit → flag raised + skipped-not-mine; no push attempted", async () => {
    const { git, calls } = recordingGit([
      spawnFail(128, "fatal: Could not read from remote repository"),
    ]);
    const flag = recordingFlag();

    const result = await dispatchGitPush(
      { cage: "c", branch: "b" },
      { git, localCageName: "c", raiseFlag: flag.raiseFlag },
    );

    expect(result.state).toBe("skipped-not-mine");
    expect((result as { reason: string }).reason).toContain("fetch-failed");
    expect((result as { reason: string }).reason).toContain("Could not read");
    expect(calls.length).toBe(1); // only fetch fired
    expect(flag.calls.length).toBe(1);
    expect(flag.calls[0]?.severity).toBe("p1");
    expect(flag.calls[0]?.body).toContain("git fetch origin b failed");
    expect(flag.calls[0]?.body).toContain("Could not read");
  });
});

// ---------- Push-rejection ----------

describe("push-rejection-flag", () => {
  test("git push non-zero (deny-hook / network / non-ff) → flag raised + skipped-not-mine", async () => {
    const { git, calls } = recordingGit([
      spawnOk("", ""), // fetch ok
      spawnOk("0\t0", ""), // rev-list 0-behind
      spawnFail(1, "remote: pre-push deny — branch refuses auto-push"),
    ]);
    const flag = recordingFlag();

    const result = await dispatchGitPush(
      { cage: "c", branch: "b" },
      { git, localCageName: "c", raiseFlag: flag.raiseFlag },
    );

    expect(result.state).toBe("skipped-not-mine");
    expect((result as { reason: string }).reason).toContain("push-rejected");
    expect((result as { reason: string }).reason).toContain("deny");
    expect(calls.length).toBe(3); // fetch, rev-list, push — NO rev-parse
    expect(flag.calls.length).toBe(1);
    expect(flag.calls[0]?.severity).toBe("p1");
    expect(flag.calls[0]?.body).toContain("REJECTED");
  });

  test("no retry on push failure — single push call only (ADR-232 OQ-3)", async () => {
    const { git, calls } = recordingGit([
      spawnOk("", ""),
      spawnOk("1\t0", ""),
      spawnFail(1, "fatal"),
    ]);
    const flag = recordingFlag();

    await dispatchGitPush(
      { cage: "c", branch: "b" },
      { git, localCageName: "c", raiseFlag: flag.raiseFlag },
    );

    const pushCalls = calls.filter((c) => c.argv[0] === "push");
    expect(pushCalls.length).toBe(1);
  });
});

// ---------- Local route — rev-list parse fallbacks ----------

describe("rev-list parse — defensive fallbacks", () => {
  test("rev-list exit non-zero → skips upstream-advanced gate, proceeds to push", async () => {
    const { git, calls } = recordingGit([
      spawnOk("", ""), // fetch
      spawnFail(128, "rev-list err"), // rev-list fails
      spawnOk("", ""), // push
      spawnOk("face0001\n"), // rev-parse HEAD
    ]);
    const flag = recordingFlag();

    const result = await dispatchGitPush(
      { cage: "c", branch: "b" },
      { git, localCageName: "c", raiseFlag: flag.raiseFlag },
    );

    expect(result).toEqual({ state: "pushed", headSha: "face0001" });
    expect(calls.length).toBe(4);
    expect(flag.calls.length).toBe(0);
  });

  test("rev-list malformed output → treated as 0 behind, proceeds to push", async () => {
    const { git, calls } = recordingGit([
      spawnOk(""),
      spawnOk("garbage-output", ""),
      spawnOk("", ""),
      spawnOk("babe1234\n"),
    ]);

    const result = await dispatchGitPush(
      { cage: "c", branch: "b" },
      { git, localCageName: "c" },
    );

    expect(result.state).toBe("pushed");
    expect(calls.length).toBe(4);
  });
});
