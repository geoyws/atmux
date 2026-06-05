// Unit tests for src/core/auto-merge-invoke.ts — ADR-255.
//
// Finding: test-auto-merge-invoke-untested-dispatch. The in-cage
// auto-merge invoker had latent parse bugs that flowed corrupt
// mergeSha/parentBase into emitted `epic.merged` payloads:
//   - `parseTickResult` matched `state=merged` UNQUOTED while the verb
//     printed `state='merged'` QUOTED — merge-detection survived only
//     by an accidental `/MERGED/i` substring fallback that ALSO
//     false-triggered on the word "merged" in the `reason='…'` prose.
//   - `extractMergeSha` read `mergeSha=<sha>` but the verb emits
//     `sha=<sha>` — every merged result carried an empty mergeSha.
//   - `extractParentBase` captured the surrounding quotes.
//
// These tests pin all four dispatch outcomes + the three regression
// guards + the bounded-wait timeout path. The merged fixture is built
// by the SHARED producer `serializeTickResult` — i.e. the EXACT string
// the verb's `logTickResult` prints — so the round-trip is real, not a
// hand-rolled approximation that could silently diverge from the verb.

import { describe, expect, test } from "bun:test";
import type { SpawnOpts, SpawnResult } from "../../../src/abstractions/spawn.ts";
import {
  DEFAULT_TICK_TIMEOUT_MS,
  type TickResultLine,
  defaultSpawnEpicMergeTick,
  invokeAutoMergeInCage,
  parseTickResult,
  serializeTickResult,
} from "../../../src/core/auto-merge-invoke.ts";
import { SpawnError, SpawnTimeoutError } from "../../../src/errors.ts";

// Spawn-result shape the injected `spawnEpicMergeTick` returns.
type SpawnOut = { exitCode: number; stdout: string; stderr: string; timedOut?: boolean };

/** Inject a spawn fn that returns `out` verbatim and records calls. */
function injectSpawn(out: SpawnOut): {
  deps: Parameters<typeof invokeAutoMergeInCage>[1];
  calls: string[];
} {
  const calls: string[] = [];
  return {
    deps: {
      spawnEpicMergeTick: async (teamDir: string): Promise<SpawnOut> => {
        calls.push(teamDir);
        return out;
      },
    },
    calls,
  };
}

// A real merged tick line, produced by the SHARED serializer the verb
// uses. SHA is a realistic 40-hex fan-in commit; parentBase carries the
// `<grandparent>/<base>` worktree-relative shape the verb emits.
const MERGED_SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const MERGED_FIELDS: TickResultLine = {
  team: "atmux-geoyws-epic-a1b2c3d4",
  parentBase: "atmux-geoyws",
  state: "merged",
  verdict: "advanced",
  mergedSha: MERGED_SHA,
  dissolveDispatched: true,
  reason: "fan-in advanced; dissolve dispatched",
};

describe("serializeTickResult / parseTickResult round-trip (ADR-255 §D1)", () => {
  test("merged line round-trips every structured field", () => {
    const line = serializeTickResult(MERGED_FIELDS);
    const parsed = parseTickResult(line);
    expect(parsed).toEqual(MERGED_FIELDS);
  });

  test("no-op line omits sha + dissolve-dispatched and round-trips", () => {
    const fields: TickResultLine = {
      team: "atmux-geoyws-epic-deadbeef",
      parentBase: "atmux-geoyws",
      state: "ready_to_merge",
      verdict: "no-op",
      dissolveDispatched: false,
      reason: "gate held: test-gate pending",
    };
    const line = serializeTickResult(fields);
    expect(line).not.toContain("sha=");
    expect(line).not.toContain("dissolve-dispatched");
    expect(parseTickResult(line)).toEqual(fields);
  });

  test("parseTickResult returns null when no contract line is present", () => {
    expect(parseTickResult("some unrelated log line\nanother\n")).toBeNull();
  });

  test("parseTickResult fails closed on a malformed/truncated contract line", () => {
    // A line carrying the prefix but missing a required quoted field
    // (e.g. the subprocess was killed mid-line so `reason='…'` never
    // flushed) MUST return null, not a half-populated object that could
    // be mistaken for a merged result.
    const truncated = "epic-merge tick: team='atmux-geoyws-epic-abcd' parentBase='atmux-geoyws' state='merged'";
    expect(truncated).not.toContain("reason=");
    expect(parseTickResult(truncated)).toBeNull();
  });

  test("parseTickResult takes the LAST contract line when several are present", () => {
    const first = serializeTickResult({ ...MERGED_FIELDS, state: "merging", verdict: "advanced" });
    const last = serializeTickResult(MERGED_FIELDS);
    const stdout = `prelude\n${first}\nmid log\n${last}\ntrailing log`;
    const parsed = parseTickResult(stdout);
    expect(parsed?.state).toBe("merged");
    expect(parsed?.mergedSha).toBe(MERGED_SHA);
  });
});

describe("invokeAutoMergeInCage — four dispatch outcomes (ADR-255)", () => {
  test("spawn throws ⇒ gate-held (operator-observable, no merge)", async () => {
    const result = await invokeAutoMergeInCage("/cage/teamdir", {
      spawnEpicMergeTick: async (): Promise<SpawnOut> => {
        throw new Error("ENOENT: atmux not on PATH");
      },
    });
    expect(result.state).toBe("gate-held");
    expect(result.state === "gate-held" && result.reason).toContain("spawn failed");
    expect(result.state === "gate-held" && result.reason).toContain("ENOENT");
  });

  test("nonzero exit ⇒ gate-held with stderr tail", async () => {
    const { deps } = injectSpawn({
      exitCode: 7,
      stdout: "",
      stderr: "fatal: not a git repository",
    });
    const result = await invokeAutoMergeInCage("/cage/teamdir", deps);
    expect(result.state).toBe("gate-held");
    expect(result.state === "gate-held" && result.reason).toContain("exit=7");
    expect(result.state === "gate-held" && result.reason).toContain("not a git repository");
  });

  test("merged ⇒ extracted sha + parentBase from a REAL logTickResult string", async () => {
    // stdout interleaves the real merged contract line with other verb
    // output so the parser must locate the contract line, not the head.
    const stdout = [
      "[epic-test-pass] all gates green",
      "epic-team dissolved: atmux-geoyws-epic-a1b2c3d4",
      serializeTickResult(MERGED_FIELDS),
    ].join("\n");
    const { deps } = injectSpawn({ exitCode: 0, stdout, stderr: "" });
    const result = await invokeAutoMergeInCage("/cage/teamdir", deps);
    expect(result.state).toBe("merged");
    // EXACT extracted values — not shape-only.
    expect(result.state === "merged" && result.mergeSha).toBe(MERGED_SHA);
    expect(result.state === "merged" && result.parentBase).toBe("atmux-geoyws");
  });

  test("exit 0 + no merged indicator ⇒ skipped-not-mine (no phantom merge)", async () => {
    const stdout = serializeTickResult({
      team: "atmux-geoyws-epic-cafe",
      parentBase: "atmux-geoyws",
      state: "ready_to_merge",
      verdict: "no-op",
      dissolveDispatched: false,
      reason: "gate held: epic not complete",
    });
    const { deps } = injectSpawn({ exitCode: 0, stdout, stderr: "" });
    const result = await invokeAutoMergeInCage("/cage/teamdir", deps);
    expect(result.state).toBe("skipped-not-mine");
  });
});

describe("invokeAutoMergeInCage — regression guards (ADR-255)", () => {
  test("FALSE-TRIGGER guard: 'merged' substring in reason prose must NOT mark merged", async () => {
    // Catches the old `/MERGED/i` substring bug: the verb is in a NO-OP
    // tick (state='already-merged' is a reason-side word; the real
    // state is a non-merged state) but the reason mentions "merged".
    const stdout = serializeTickResult({
      team: "atmux-geoyws-epic-feed",
      parentBase: "atmux-geoyws",
      state: "ready_to_merge",
      verdict: "no-op",
      dissolveDispatched: false,
      reason: "branch already merged upstream; nothing to do",
    });
    expect(stdout).toContain("merged"); // the trap the old code fell into
    const { deps } = injectSpawn({ exitCode: 0, stdout, stderr: "" });
    const result = await invokeAutoMergeInCage("/cage/teamdir", deps);
    // If the old /MERGED/i substring logic were live, this would be
    // "merged" with an empty/garbage payload. The fix requires
    // state='merged' equality, so this is skipped-not-mine.
    expect(result.state).toBe("skipped-not-mine");
  });

  test("FALSE-TRIGGER guard: state='merging' (contains 'merg') must NOT mark merged", async () => {
    const stdout = serializeTickResult({
      team: "atmux-geoyws-epic-beef",
      parentBase: "atmux-geoyws",
      state: "merging",
      verdict: "advanced",
      dissolveDispatched: false,
      reason: "entered merging",
    });
    const { deps } = injectSpawn({ exitCode: 0, stdout, stderr: "" });
    const result = await invokeAutoMergeInCage("/cage/teamdir", deps);
    expect(result.state).toBe("skipped-not-mine");
  });

  test("EMPTY-SHA regression: a real `sha=` line MUST populate mergeSha", async () => {
    // Catches the old `mergeSha=<sha>` key mismatch — the verb emits
    // `sha=<sha>`, so the old extractor returned null and shipped an
    // empty mergeSha into the epic.merged payload.
    const stdout = serializeTickResult(MERGED_FIELDS);
    const { deps } = injectSpawn({ exitCode: 0, stdout, stderr: "" });
    const result = await invokeAutoMergeInCage("/cage/teamdir", deps);
    expect(result.state).toBe("merged");
    expect(result.state === "merged" && result.mergeSha).not.toBe("");
    expect(result.state === "merged" && result.mergeSha).toBe(MERGED_SHA);
  });

  test("QUOTE-STRIP regression: parentBase must NOT carry surrounding quotes", async () => {
    const stdout = serializeTickResult(MERGED_FIELDS);
    const { deps } = injectSpawn({ exitCode: 0, stdout, stderr: "" });
    const result = await invokeAutoMergeInCage("/cage/teamdir", deps);
    expect(result.state === "merged" && result.parentBase).toBe("atmux-geoyws");
    expect(result.state === "merged" && result.parentBase).not.toContain("'");
  });

  test("merged tick with no fresh commit (no sha=) ⇒ merged with empty mergeSha", async () => {
    // A merged state can legitimately omit `sha=` (no-op merge, nothing
    // ahead). We still report merged, with an empty mergeSha — the
    // handler logs the epicId regardless.
    const stdout = serializeTickResult({
      team: "atmux-geoyws-epic-1234",
      parentBase: "atmux-geoyws",
      state: "merged",
      verdict: "no-op",
      dissolveDispatched: false,
      reason: "already at merged terminal; no commits ahead",
    });
    expect(stdout).not.toContain("sha=");
    const { deps } = injectSpawn({ exitCode: 0, stdout, stderr: "" });
    const result = await invokeAutoMergeInCage("/cage/teamdir", deps);
    expect(result.state).toBe("merged");
    expect(result.state === "merged" && result.mergeSha).toBe("");
    expect(result.state === "merged" && result.parentBase).toBe("atmux-geoyws");
  });
});

describe("invokeAutoMergeInCage — bounded subprocess wait (ADR-255 §D2)", () => {
  test("timed-out tick ⇒ gate-held, NOT merged", async () => {
    // The injected spawn reports a reaped/timed-out child. Even if its
    // (partial) stdout contained a merged line, timedOut wins → the
    // hung tick is treated as gate-held, never merged.
    const { deps } = injectSpawn({
      exitCode: -1,
      stdout: serializeTickResult(MERGED_FIELDS), // partial buffer trap
      stderr: "",
      timedOut: true,
    });
    const result = await invokeAutoMergeInCage("/cage/teamdir", deps);
    expect(result.state).toBe("gate-held");
    expect(result.state === "gate-held" && result.reason).toContain("timed out");
    expect(result.state === "gate-held" && result.reason).toContain(String(DEFAULT_TICK_TIMEOUT_MS));
  });

  test("teamDir is forwarded verbatim to the spawn fn", async () => {
    const { deps, calls } = injectSpawn({ exitCode: 0, stdout: "", stderr: "" });
    await invokeAutoMergeInCage("/some/cage/dir", deps);
    expect(calls).toEqual(["/some/cage/dir"]);
  });
});

describe("defaultSpawnEpicMergeTick — spawn() adapter (ADR-255 §D2)", () => {
  // Fake `spawn()` impl — records the SpawnOpts it received so we can
  // assert the argv + that the bounded timeout is forwarded.
  function fakeSpawn(
    behaviour: (opts: SpawnOpts) => SpawnResult | Promise<SpawnResult> | never,
  ): { impl: (opts: SpawnOpts) => Promise<SpawnResult>; seen: SpawnOpts[] } {
    const seen: SpawnOpts[] = [];
    const impl = async (opts: SpawnOpts): Promise<SpawnResult> => {
      seen.push(opts);
      return behaviour(opts);
    };
    return { impl, seen };
  }

  function spawnResult(over: Partial<SpawnResult>): SpawnResult {
    return {
      cmd: "atmux",
      argv: ["epic-merge", "tick", "--team-dir", "/cage"],
      exitCode: 0,
      signalled: null,
      stdout: "",
      stderr: "",
      durationMs: 1,
      ...over,
    };
  }

  test("forwards argv + bounded timeout + expectExitCode='any' to spawn()", async () => {
    const { impl, seen } = fakeSpawn(() => spawnResult({ exitCode: 0, stdout: "ok" }));
    const out = await defaultSpawnEpicMergeTick("/cage/x", DEFAULT_TICK_TIMEOUT_MS, impl);
    expect(out).toEqual({ exitCode: 0, stdout: "ok", stderr: "" });
    expect(seen).toHaveLength(1);
    const opts = seen[0];
    expect(opts?.cmd).toBe("atmux");
    expect(opts?.argv).toEqual(["epic-merge", "tick", "--team-dir", "/cage/x"]);
    expect(opts?.timeoutMs).toBe(DEFAULT_TICK_TIMEOUT_MS);
    // Nonzero exit must be RETURNED, not thrown — so expectExitCode='any'.
    expect(opts?.expectExitCode).toBe("any");
  });

  test("returns nonzero exit (does not throw) so the caller can gate-hold", async () => {
    const { impl } = fakeSpawn(() => spawnResult({ exitCode: 3, stderr: "boom" }));
    const out = await defaultSpawnEpicMergeTick("/cage/x", 5000, impl);
    expect(out).toEqual({ exitCode: 3, stdout: "", stderr: "boom" });
    expect(out.timedOut).toBeUndefined();
  });

  test("maps SpawnTimeoutError → timedOut:true (child already reaped by spawn())", async () => {
    const { impl } = fakeSpawn(() => {
      throw new SpawnTimeoutError({
        cmd: "atmux",
        argv: ["epic-merge", "tick", "--team-dir", "/cage/x"],
        timeoutMs: 5000,
      });
    });
    const out = await defaultSpawnEpicMergeTick("/cage/x", 5000, impl);
    expect(out.timedOut).toBe(true);
    expect(out.exitCode).toBe(-1);
    expect(out.stderr).toContain("timed out");
  });

  test("rethrows non-timeout spawn failures (e.g. atmux not on PATH)", async () => {
    const { impl } = fakeSpawn(() => {
      throw new SpawnError({ cmd: "atmux", argv: [], exitCode: -1, stderr: "ENOENT", stdout: "" });
    });
    await expect(defaultSpawnEpicMergeTick("/cage/x", 5000, impl)).rejects.toBeInstanceOf(
      SpawnError,
    );
  });
});
