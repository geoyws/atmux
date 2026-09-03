// Unit tests for src/verbs/dashboard.ts (ADR-010).
// Tracked under the ADR-009 §2 narrowed denominator (`src/verbs/**/*.ts`)
// — 100% line/function/branch coverage required.
//
// Strategy. The render LOOP never terminates against a real `setTimeout`
// clock; we follow `attach.ts`'s pattern of extracting a pure
// `dashboardLoop` that takes injectable deps (`collect`, `sleep`,
// `write`, `signal`, `maxFrames`). Tests drive the loop with stubs +
// `maxFrames` to assert frame composition, abort handling, and arg
// parsing without needing a real terminal or real subprocesses.
//
// The public `dashboard()` verb is exercised against a fixture .atmux/
// directory: precondition-failure (no team.json), happy path with
// `signal` aborted before the first frame (so the loop returns
// immediately and we still cover the team-load + collect-wiring code).
// The happy-path wiring test injects lightweight verbs/probe hooks so
// it exercises the collector closure without contacting the default
// tmux socket.

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import {
  buildDriverInboxReader,
  buildLoopDeps,
  CLEAR,
  CLEAR_AND_HOME,
  captureVerbStdout,
  collectDashboardOpenLines,
  composeFrame,
  dashboard,
  dashboardLoop,
  type FrameSnapshot,
  makeRealCollect,
  parseDashboardArgs,
  realSleep,
  takeFirstLines,
} from "../../../src/verbs/dashboard.ts";

// ---------- parseDashboardArgs ----------

describe("parseDashboardArgs", () => {
  test("no args → default 5s interval", () => {
    expect(parseDashboardArgs([])).toEqual({ intervalSec: 5 });
  });

  test("--interval N → numeric interval", () => {
    expect(parseDashboardArgs(["--interval", "12"])).toEqual({ intervalSec: 12 });
  });

  test("-n N alias → same numeric interval (bash watch-style)", () => {
    expect(parseDashboardArgs(["-n", "3"])).toEqual({ intervalSec: 3 });
  });

  test("--team-dir <dir> → captured", () => {
    expect(parseDashboardArgs(["--team-dir", "/tmp/x"])).toEqual({
      intervalSec: 5,
      teamDir: "/tmp/x",
    });
  });

  test("--interval without value → UsageError", () => {
    expect(() => parseDashboardArgs(["--interval"])).toThrow(UsageError);
  });

  test("-n without value → UsageError (alias path)", () => {
    expect(() => parseDashboardArgs(["-n"])).toThrow(UsageError);
  });

  test("--team-dir without value → UsageError", () => {
    expect(() => parseDashboardArgs(["--team-dir"])).toThrow(UsageError);
  });

  test("--interval with non-numeric → UsageError", () => {
    expect(() => parseDashboardArgs(["--interval", "abc"])).toThrow(UsageError);
  });

  test("--interval with zero or negative → UsageError", () => {
    expect(() => parseDashboardArgs(["--interval", "0"])).toThrow(UsageError);
    expect(() => parseDashboardArgs(["--interval", "-1"])).toThrow(UsageError);
  });

  test("unknown arg → UsageError", () => {
    expect(() => parseDashboardArgs(["--bogus"])).toThrow(UsageError);
  });
});

// ---------- takeFirstLines ----------

describe("takeFirstLines (head -N parity)", () => {
  test("empty input → empty output regardless of N", () => {
    expect(takeFirstLines("", 10)).toBe("");
    expect(takeFirstLines("", 0)).toBe("");
  });

  test("N=0 → empty (defensive bound; not currently used)", () => {
    expect(takeFirstLines("a\nb\n", 0)).toBe("");
    expect(takeFirstLines("a\nb\n", -3)).toBe("");
  });

  test("N >= line count + trailing newline → original string", () => {
    // Five-line input (with trailing newline) under head -10 stays
    // unchanged. `head` doesn't add or strip newlines when input has
    // ≤N lines.
    const src = "a\nb\nc\nd\ne\n";
    expect(takeFirstLines(src, 10)).toBe(src);
  });

  test("N >= line count, no trailing newline → original string preserved", () => {
    // `printf 'a\\nb\\nc' | head -10` outputs "a\\nb\\nc" without
    // appending a trailing newline.
    const src = "a\nb\nc";
    expect(takeFirstLines(src, 10)).toBe(src);
  });

  test("N < line count → first N + trailing newline", () => {
    // `printf 'a\\nb\\nc\\nd\\n' | head -2` → "a\\nb\\n".
    expect(takeFirstLines("a\nb\nc\nd\n", 2)).toBe("a\nb\n");
  });

  test("N < line count, source had no trailing newline → still adds one at the cut", () => {
    // `printf 'a\\nb\\nc' | head -2` → "a\\nb\\n" (head boundary
    // implies a newline at the cut).
    expect(takeFirstLines("a\nb\nc", 2)).toBe("a\nb\n");
  });
});

// ---------- collectDashboardOpenLines ----------

describe("collectDashboardOpenLines (looser '- ' than reply.collectOpenEntries)", () => {
  test("no '## Open' section → []", () => {
    expect(collectDashboardOpenLines("## Other\n- foo\n")).toEqual([]);
  });

  test("collects '- ...' lines under '## Open' until next '## ' heading", () => {
    const body = [
      "# Driver inbox",
      "",
      "## Open",
      "- entry one",
      "- entry two with [bracket]",
      "  not a list line",
      "- entry three",
      "",
      "## Archive",
      "- archived foo",
    ].join("\n");
    expect(collectDashboardOpenLines(body)).toEqual([
      "- entry one",
      "- entry two with [bracket]",
      "- entry three",
    ]);
  });

  test("matches '- ' loose-form (NOT just '- [' as collectOpenEntries does)", () => {
    // Verify the bash dashboard parity divergence from outbox: a
    // raw `- foo` line under `## Open` IS captured; the outbox-side
    // helper would skip it.
    const body = "## Open\n- foo without bracket\n- [bracketed]\n";
    expect(collectDashboardOpenLines(body)).toEqual(["- foo without bracket", "- [bracketed]"]);
  });
});

// ---------- composeFrame ----------

describe("composeFrame (bash dashboard.sh:25-38 parity)", () => {
  const baseSnap: FrameSnapshot = {
    intervalSec: 5,
    status: "🟢 TEAM x  session=atmux-x [up]\n",
    recentKanban: "task#1 todo\ntask#2 todo\n",
    driverInbox: "- ask one\n- ask two\n",
    outbox: "📭 outbox empty\n",
  };

  test("emits all four section labels in order", () => {
    const out = composeFrame(baseSnap);
    const idxStatus = out.indexOf("🎛️  atmux dashboard");
    const idxKanban = out.indexOf("─── recent kanban ───");
    const idxInbox = out.indexOf("─── driver-inbox open ───");
    const idxOutbox = out.indexOf("─── lead-outbox open ───");
    expect(idxStatus).toBeGreaterThanOrEqual(0);
    expect(idxKanban).toBeGreaterThan(idxStatus);
    expect(idxInbox).toBeGreaterThan(idxKanban);
    expect(idxOutbox).toBeGreaterThan(idxInbox);
  });

  test("header carries the supplied intervalSec", () => {
    const out = composeFrame({ ...baseSnap, intervalSec: 12 });
    expect(out).toContain("(refresh 12s — ctrl-c to exit)");
  });

  test("status block ends with blank line before kanban heading", () => {
    const out = composeFrame(baseSnap);
    // The status content + ensureNewline + extra '\n' yields a blank
    // line BEFORE the kanban heading.
    expect(out).toContain("session=atmux-x [up]\n\n─── recent kanban ───\n");
  });

  test("status without trailing newline still gets one before the next section", () => {
    const snap = { ...baseSnap, status: "no newline at end" };
    const out = composeFrame(snap);
    expect(out).toContain("no newline at end\n\n─── recent kanban ───\n");
  });

  test("empty inbox section just emits heading + blank line (bash branch)", () => {
    const snap = { ...baseSnap, driverInbox: "" };
    const out = composeFrame(snap);
    // The driver-inbox heading is followed by no body, then the blank
    // line, then the lead-outbox heading.
    expect(out).toContain("─── driver-inbox open ───\n\n─── lead-outbox open ───\n");
  });

  test("empty outbox → frame still ends with a newline (last heading)", () => {
    const snap = { ...baseSnap, outbox: "" };
    const out = composeFrame(snap);
    expect(out.endsWith("─── lead-outbox open ───\n")).toBe(true);
  });
});

// ---------- dashboardLoop ----------

describe("dashboardLoop (signal + maxFrames + ANSI clear)", () => {
  function makeDeps(overrides: Partial<Parameters<typeof dashboardLoop>[0]> = {}) {
    const writes: string[] = [];
    const sleeps: number[] = [];
    return {
      writes,
      sleeps,
      deps: {
        collect: async () => ({
          status: "STATUS\n",
          recentKanban: "K\n",
          driverInbox: "",
          outbox: "OB\n",
        }),
        sleep: async (ms: number) => {
          sleeps.push(ms);
        },
        write: (s: string) => {
          writes.push(s);
        },
        ...overrides,
      },
    };
  }

  test("aborts BEFORE first frame when signal already aborted → no clear emitted", async () => {
    const ac = new AbortController();
    ac.abort();
    const { writes, deps } = makeDeps({ signal: ac.signal });
    const exit = await dashboardLoop(deps, 5);
    expect(exit).toBe(0);
    expect(writes).toEqual([]);
  });

  test("renders maxFrames=1 then exits — emits CLEAR + one CLEAR_AND_HOME frame", async () => {
    const { writes, sleeps, deps } = makeDeps({ maxFrames: 1 });
    const exit = await dashboardLoop(deps, 7);
    expect(exit).toBe(0);
    // First write: pre-loop CLEAR. Second: clear-and-home + frame.
    expect(writes[0]).toBe(CLEAR);
    expect(writes[1]?.startsWith(CLEAR_AND_HOME)).toBe(true);
    // No sleep after the final frame — maxFrames hit.
    expect(sleeps).toEqual([]);
    // Frame body carries the supplied intervalSec.
    expect(writes[1]).toContain("(refresh 7s — ctrl-c to exit)");
  });

  test("renders maxFrames=2 → two frames, one sleep between them", async () => {
    const { writes, sleeps, deps } = makeDeps({ maxFrames: 2 });
    const exit = await dashboardLoop(deps, 4);
    expect(exit).toBe(0);
    // CLEAR + frame1 + frame2 = 3 writes.
    expect(writes.length).toBe(3);
    // One sleep between frames (4_000 ms).
    expect(sleeps).toEqual([4_000]);
  });

  test("aborts mid-loop on signal between frames", async () => {
    const ac = new AbortController();
    let frameCount = 0;
    const writes: string[] = [];
    const exit = await dashboardLoop(
      {
        collect: async () => {
          frameCount += 1;
          if (frameCount === 1) ac.abort();
          return {
            status: "S\n",
            recentKanban: "",
            driverInbox: "",
            outbox: "",
          };
        },
        sleep: async () => {
          /* no-op */
        },
        write: (s) => writes.push(s),
        signal: ac.signal,
      },
      3,
    );
    expect(exit).toBe(0);
    // CLEAR + 1 frame written before the next-iteration abort check.
    expect(writes.length).toBe(2);
  });
});

// ---------- captureVerbStdout ----------

describe("captureVerbStdout", () => {
  test("captures process.stdout.write + console.log output", async () => {
    const fakeVerb = async () => {
      process.stdout.write("a\n");
      console.log("b");
      process.stdout.write(new TextEncoder().encode("c\n"));
      return 0;
    };
    const out = await captureVerbStdout(fakeVerb, [], "fake");
    expect(out).toBe("a\nb\nc\n");
  });

  test("swallows verb errors and re-renders as a single line (parity with bash || true)", async () => {
    const angryVerb = async () => {
      throw new Error("boom");
    };
    const out = await captureVerbStdout(angryVerb, [], "myverb");
    expect(out).toBe("myverb: boom\n");
  });

  test("non-Error throw is stringified", async () => {
    const angryVerb = async () => {
      // Deliberate non-Error throw — exercises the `String(e)` fallback.
      const v: unknown = "stringly";
      throw v;
    };
    const out = await captureVerbStdout(angryVerb, [], "x");
    expect(out).toBe("x: stringly\n");
  });
});

// ---------- makeRealCollect ----------

describe("makeRealCollect (orchestrates four parallel reads + truncation)", () => {
  test("composes status + first-10 task list + first-5 inbox + first-10 outbox", async () => {
    const longKanban = `${Array.from({ length: 25 }, (_, i) => `t${i}`).join("\n")}\n`;
    const longOutbox = `${Array.from({ length: 25 }, (_, i) => `o${i}`).join("\n")}\n`;
    const inbox = [
      "# header",
      "## Open",
      "- one",
      "- two",
      "- three",
      "- four",
      "- five",
      "- six (will be truncated)",
      "## Archive",
    ].join("\n");
    const collect = makeRealCollect(
      async () => "STATUS_OK\n",
      async () => longKanban,
      async () => longOutbox,
      async () => inbox,
    );
    const out = await collect();
    expect(out.status).toBe("STATUS_OK\n");
    // First 10 lines of kanban + cut newline.
    expect(out.recentKanban.split("\n").filter((l) => l.length > 0).length).toBe(10);
    // First 5 of inbox open lines.
    const inboxLines = out.driverInbox.split("\n").filter((l) => l.length > 0);
    expect(inboxLines).toEqual(["- one", "- two", "- three", "- four", "- five"]);
    expect(out.outbox.split("\n").filter((l) => l.length > 0).length).toBe(10);
  });

  test("driver-inbox null (no file) → empty driverInbox section", async () => {
    const collect = makeRealCollect(
      async () => "S\n",
      async () => "K\n",
      async () => "O\n",
      async () => null,
    );
    const out = await collect();
    expect(out.driverInbox).toBe("");
  });

  test("driver-inbox present but no '## Open' section → empty driverInbox", async () => {
    const collect = makeRealCollect(
      async () => "S\n",
      async () => "",
      async () => "",
      async () => "# only a header, no open section\n",
    );
    const out = await collect();
    expect(out.driverInbox).toBe("");
  });
});

// ---------- realSleep + buildDriverInboxReader (extracted helpers) ----------

describe("realSleep", () => {
  test("resolves after ~ms via setTimeout (0ms tick)", async () => {
    // Just ensures the promise resolves; we don't assert timing
    // (`bun:test`'s default Date.now precision is the bottleneck).
    await realSleep(0);
  });
});

describe("buildDriverInboxReader", () => {
  test("returns null when driver-inbox.md is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atmux-dash-no-di-"));
    const atmuxDir = join(dir, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
    const reader = buildDriverInboxReader(atmuxDir);
    expect(await reader()).toBeNull();
  });

  test("returns file contents when present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atmux-dash-di-"));
    const atmuxDir = join(dir, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
    const body = "## Open\n- one\n";
    await writeFile(join(atmuxDir, "driver-inbox.md"), body);
    const reader = buildDriverInboxReader(atmuxDir);
    expect(await reader()).toBe(body);
  });
});

// ---------- buildLoopDeps (wiring layer) ----------

describe("buildLoopDeps (wires real collect + sleep + write closures)", () => {
  test("returned deps invoke their bound verbs and forward to stdout", async () => {
    // Stage a temp .atmux/ with an empty driver-inbox.md so the
    // collect closure exercises the file-present branch.
    const dir = await mkdtemp(join(tmpdir(), "atmux-dash-deps-"));
    const atmuxDir = join(dir, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
    await writeFile(join(atmuxDir, "driver-inbox.md"), "## Open\n- alpha\n");

    const calls: string[] = [];
    const fakeStatus = async () => {
      calls.push("status");
      process.stdout.write("STATUS_OK\n");
      return 0;
    };
    const fakeTask = async (a: ReadonlyArray<string>) => {
      calls.push(`task:${a.join(",")}`);
      process.stdout.write("t1\nt2\n");
      return 0;
    };
    const fakeOutbox = async () => {
      calls.push("outbox");
      process.stdout.write("📭\n");
      return 0;
    };

    const ac = new AbortController();
    const deps = buildLoopDeps(atmuxDir, fakeStatus, fakeTask, fakeOutbox, ac.signal);
    expect(deps.signal).toBe(ac.signal);

    // Suppress the write closure's real stdout side effect — and
    // verify it forwards the input string.
    let stdoutBuf = "";
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string | Uint8Array) => {
      stdoutBuf += typeof s === "string" ? s : new TextDecoder().decode(s);
      return true;
    }) as typeof process.stdout.write;
    try {
      // collect() drives the four closures + truncation.
      const data = await deps.collect();
      expect(data.status).toBe("STATUS_OK\n");
      expect(data.recentKanban).toBe("t1\nt2\n");
      expect(data.outbox).toBe("📭\n");
      expect(data.driverInbox).toBe("- alpha\n");
      expect(calls.sort()).toEqual(["outbox", "status", "task:list"]);

      // sleep() resolves (we use 0ms — already covered by realSleep
      // test, but this exercises the deps.sleep wiring path too).
      await deps.sleep(0);

      // write() forwards to process.stdout.write.
      stdoutBuf = "";
      deps.write("hello\n");
      expect(stdoutBuf).toBe("hello\n");
    } finally {
      process.stdout.write = orig;
    }
  });
});

// ---------- dashboard() — public verb entry ----------

describe("dashboard() — public verb wiring", () => {
  test("UsageError on unknown arg propagates from parseDashboardArgs", async () => {
    await expect(dashboard(["--bogus"])).rejects.toBeInstanceOf(UsageError);
  });

  test("ConfigError when no team.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atmux-dash-"));
    await expect(dashboard(["--team-dir", dir])).rejects.toBeInstanceOf(ConfigError);
  });

  test("happy path: renders ONE real frame (driver-pane collector closure runs) then exits on SIGINT", async () => {
    // Covers the dashboard collect wiring that hands a driver-pane
    // probe into the frame builder. The injected verbs keep the test
    // off the default tmux socket while still proving the collector
    // closure runs and renders one frame.
    const dir = await mkdtemp(join(tmpdir(), "atmux-dash-frame-"));
    const atmuxDir = join(dir, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
    await writeFile(join(atmuxDir, "team.json"), JSON.stringify({ name: "x", members: [] }));

    let probeCalled = false;
    const hooks = {
      statusVerb: async () => {
        process.stdout.write("🟢 TEAM atmux  session=atmux-x [up]\n");
        return 0;
      },
      taskVerb: async () => {
        process.stdout.write("t-1 todo  test\n");
        return 0;
      },
      outboxVerb: async () => {
        process.stdout.write("[lead → driver] hello\n");
        return 0;
      },
      probeDriverPane: async () => {
        probeCalled = true;
        return {
          configured: true,
          windowExists: false,
          state: null,
          evidence: "probe-hook",
        };
      },
    };

    let sigintHandler: (() => void) | null = null;
    const origOnce = process.once.bind(process);
    process.once = ((event: string | symbol, handler: (...a: unknown[]) => void) => {
      if (event === "SIGINT" && sigintHandler === null) sigintHandler = handler;
      return origOnce(event, handler);
    }) as typeof process.once;

    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    let frames = 0;
    process.stdout.write = ((s: string | Uint8Array) => {
      if (typeof s === "string" && s.startsWith(CLEAR_AND_HOME)) {
        frames += 1;
        // Abort after the first rendered frame; the loop's next
        // isAborted() check returns 0.
        sigintHandler?.();
      }
      return true;
    }) as typeof process.stdout.write;
    try {
      const exit = await dashboard(["--team-dir", dir, "--interval", "0.001"], hooks);
      expect(exit).toBe(0);
      expect(frames).toBe(1);
      expect(probeCalled).toBe(true);
    } finally {
      process.stdout.write = origStdoutWrite;
      process.once = origOnce;
    }
  });

  test("happy path: signal pre-aborted → returns 0 without rendering", async () => {
    // Stage a minimal .atmux/team.json so requireTeam succeeds. We
    // then mock global setTimeout so the loop's sleep resolves
    // instantly — but signal abort runs first, so sleep isn't even
    // reached. The objective is to cover the verb's wiring code:
    // arg parse → requireTeam → makeRealCollect construction →
    // signal handler registration.
    //
    // Because dashboard() registers SIGINT/SIGTERM handlers and
    // wires its own AbortController, we can't pass an external
    // signal in. Instead we stub `process.once` to immediately
    // invoke the SIGINT handler the verb registers — which calls
    // `abort.abort()`, and the loop's first `isAborted()` check
    // returns 0.
    const dir = await mkdtemp(join(tmpdir(), "atmux-dash-ok-"));
    const atmuxDir = join(dir, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({
        name: "x",
        members: [],
      }),
    );

    // Capture the first 'SIGINT' handler the verb registers and
    // invoke it immediately to abort before any frame renders.
    const origOnce = process.once.bind(process);
    let invokedHandler = false;
    process.once = ((event: string | symbol, handler: (...a: unknown[]) => void) => {
      if (event === "SIGINT" && !invokedHandler) {
        invokedHandler = true;
        // Invoke the abort-handler synchronously before continuing
        // registration — the verb's loop will see signal.aborted on
        // its first isAborted() check.
        handler();
      }
      return origOnce(event, handler);
    }) as typeof process.once;

    // Suppress the verb's "dashboard: exit\n" emission.
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      const exit = await dashboard(["--team-dir", dir, "--interval", "60"]);
      expect(exit).toBe(0);
      expect(invokedHandler).toBe(true);
    } finally {
      process.stdout.write = origStdoutWrite;
      process.once = origOnce;
    }
  });
});
