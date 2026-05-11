// Unit tests for src/core/send.ts (ADR-003 + ADR-004 amend).
//
// Strategy: spin a real tmux server on a unique per-test socket via
// `createTmux({ socketPath, configFile: "/dev/null" })` — same isolation
// discipline as `tests/unit/abstractions/tmux.test.ts` (Task #1 amend).
// All `sleep` calls inside `sendToMember` are stubbed to no-op; we
// don't want test-suite latency from the bash-faithful 0.3s + 2s
// delays, and they have no observable effect on outcome correctness
// when the cat-pane round-trip happens locally.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTmux, type TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import { classifyPaneState, logsDir } from "../../../src/core/common.ts";
import { isPreSendWarn, looksLikeNotConsumed, sendToMember } from "../../../src/core/send.ts";

const NO_SLEEP = (_ms: number): Promise<void> => Promise.resolve();

let socketDir: string;
let socketPath: string;
let atmuxDir: string;
let priorTmux: string | undefined;
let tmux: TmuxNamespace;
let sessionPrefix: string;

beforeEach(async () => {
  socketDir = await mkdtemp(join(tmpdir(), "atmux-send-sock-"));
  socketPath = join(socketDir, "sock");
  atmuxDir = await mkdtemp(join(tmpdir(), "atmux-send-dir-"));
  await mkdir(join(atmuxDir, "logs"), { recursive: true });
  sessionPrefix = `s${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  priorTmux = process.env.TMUX;
  delete process.env.TMUX;
  tmux = createTmux({ socketPath, configFile: "/dev/null" });
});

afterEach(async () => {
  try {
    await tmux.server.killServer();
  } catch {
    // expected: server may already be gone (idempotent teardown)
  }
  if (priorTmux !== undefined) process.env.TMUX = priorTmux;
  await rm(socketDir, { recursive: true, force: true });
  await rm(atmuxDir, { recursive: true, force: true });
});

/** Spin a tmux session running `cat` so paste-buffer + Enter has a
 *  consumer that echoes the body back to the pane (so capture-pane
 *  can observe it). Returns the target string + session name. */
async function spinCatSession(prefix: string): Promise<{ session: string; target: string }> {
  const session = `${prefix}_${Math.random().toString(36).slice(2, 6)}`;
  await tmux.session.newSession({ name: session, shellCommand: "cat" });
  return { session, target: `${session}:0.0` };
}

describe("sendToMember — happy path", () => {
  test("delivers msg + writes log + returns ok", async () => {
    const { target } = await spinCatSession(`${sessionPrefix}_a`);
    const out = await sendToMember(
      tmux,
      atmuxDir,
      { target, member: "alice", team: "test-team" },
      "hello-from-test",
      { sleep: NO_SLEEP, verify: false },
    );
    expect(out.kind).toBe("ok");
    expect(out.preWarn).toBe(false);
    // Cat echoes the pasted body back; capture-pane should see it.
    await new Promise((r) => setTimeout(r, 100));
    const captured = await tmux.pane.capturePane({ target, start: -10 });
    expect(captured).toContain("hello-from-test");
  });

  test("log file contains a bash-shape entry", async () => {
    const { target } = await spinCatSession(`${sessionPrefix}_b`);
    await sendToMember(
      tmux,
      atmuxDir,
      { target, member: "bob", team: "test-team" },
      "line1\nline2",
      { sleep: NO_SLEEP, verify: false },
    );
    const logPath = join(logsDir(atmuxDir), "send-bob.log");
    const log = await readFile(logPath, "utf8");
    // Header line shape: `[ISO-8601-Z] sent:`
    expect(log).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\] sent:\n/);
    // Indented body lines: "  | <line>"
    expect(log).toContain("  | line1\n  | line2\n");
    // Trailing blank line separates entries
    expect(log).toMatch(/\n\n$/);
  });

  test("multiple sends append (do not truncate)", async () => {
    const { target } = await spinCatSession(`${sessionPrefix}_c`);
    await sendToMember(tmux, atmuxDir, { target, member: "carol", team: "test-team" }, "first", {
      sleep: NO_SLEEP,
      verify: false,
    });
    await sendToMember(tmux, atmuxDir, { target, member: "carol", team: "test-team" }, "second", {
      sleep: NO_SLEEP,
      verify: false,
    });
    const logPath = join(logsDir(atmuxDir), "send-carol.log");
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("  | first\n");
    expect(log).toContain("  | second\n");
    // Two header lines = two entries
    expect((log.match(/sent:\n/g) ?? []).length).toBe(2);
  });

  test("custom buffer name is respected", async () => {
    const { target } = await spinCatSession(`${sessionPrefix}_d`);
    const out = await sendToMember(
      tmux,
      atmuxDir,
      { target, member: "dave", team: "test-team" },
      "x",
      { sleep: NO_SLEEP, verify: false, bufferName: "my-named-buffer" },
    );
    expect(out.kind).toBe("ok");
    // Buffer was deleted via `deleteAfter: true`; deleting again throws.
    await expect(tmux.buffer.deleteBuffer("my-named-buffer")).rejects.toThrow();
  });
});

describe("sendToMember — noSubmit", () => {
  test("returns 'queued' and does NOT submit", async () => {
    const { target } = await spinCatSession(`${sessionPrefix}_q`);
    const out = await sendToMember(
      tmux,
      atmuxDir,
      { target, member: "queued", team: "test-team" },
      "uncommitted-line",
      { sleep: NO_SLEEP, verify: false, noSubmit: true },
    );
    expect(out.kind).toBe("queued");
    // Log file should NOT exist — bash also skips logging on --no-submit
    // path (lib/send.sh:111-114 returns before _atmux_log_send).
    const logPath = join(logsDir(atmuxDir), "send-queued.log");
    let logExists = true;
    try {
      await readFile(logPath, "utf8");
    } catch {
      logExists = false;
    }
    expect(logExists).toBe(false);
  });
});

describe("sendToMember — verify path", () => {
  test("ok when pane consumed the message (cat echoes + scrolls)", async () => {
    const { target } = await spinCatSession(`${sessionPrefix}_v`);
    // Send several lines to push the cat-echoed snippet out of the
    // last-3 window. With cat as the consumer, each Enter echoes a
    // blank line, so the snippet gets pushed back fast.
    const out = await sendToMember(
      tmux,
      atmuxDir,
      { target, member: "ver", team: "test-team" },
      "small",
      { sleep: NO_SLEEP, verify: true },
    );
    // cat-driven pane has no "shell prompt" pattern → not-consumed
    // heuristic returns false (the trailing-prompt check fails). Result:
    // outcome is "ok" regardless of snippet visibility. This is the
    // intended bash semantic — the heuristic is *both* conditions, so a
    // non-shell consumer never trips it.
    expect(out.kind).toBe("ok");
  });

  test("ok when no shell prompt visible (heuristic both-conditions guard)", async () => {
    const { target } = await spinCatSession(`${sessionPrefix}_v2`);
    const out = await sendToMember(
      tmux,
      atmuxDir,
      { target, member: "v2", team: "test-team" },
      "msg-without-prompt",
      { sleep: NO_SLEEP, verify: true },
    );
    expect(out.kind).toBe("ok");
  });
});

describe("sendToMember — pre-send classifier", () => {
  test("preWarn=false on a fresh pane", async () => {
    const { target } = await spinCatSession(`${sessionPrefix}_pre`);
    const out = await sendToMember(
      tmux,
      atmuxDir,
      { target, member: "pre", team: "test-team" },
      "msg",
      { sleep: NO_SLEEP, verify: false },
    );
    expect(out.preWarn).toBe(false);
    expect(out.preSnapshot.compacting).toBe(false);
    expect(out.preSnapshot.queuedMessages).toBe(false);
    expect(out.preSnapshot.rateLimit).toBe("none");
  });

  test("preWarn=true when pane shows 'Compacting conversation' marker", async () => {
    // Spin a session whose pane shows the marker. Easiest: launch
    // a process that prints the line and stays alive. Use `sh -c`
    // with `printf` + `sleep`.
    const session = `${sessionPrefix}_warn_${Math.random().toString(36).slice(2, 6)}`;
    await tmux.session.newSession({
      name: session,
      shellCommand: "sh -c \"printf 'Compacting conversation…\\n' && cat\"",
    });
    const target = `${session}:0.0`;
    await new Promise((r) => setTimeout(r, 200));
    const out = await sendToMember(
      tmux,
      atmuxDir,
      { target, member: "compact", team: "test-team" },
      "msg",
      { sleep: NO_SLEEP, verify: false },
    );
    expect(out.preWarn).toBe(true);
    expect(out.preSnapshot.compacting).toBe(true);
    // sendToMember still proceeds (bash semantic: warn but don't refuse)
    expect(out.kind).toBe("ok");
  });

  test("preWarn=true when pane shows 'hit your limit' (hard rate-limit)", async () => {
    const session = `${sessionPrefix}_rl_${Math.random().toString(36).slice(2, 6)}`;
    await tmux.session.newSession({
      name: session,
      shellCommand: "sh -c \"printf 'You hit your limit, retry later\\n' && cat\"",
    });
    const target = `${session}:0.0`;
    await new Promise((r) => setTimeout(r, 200));
    const out = await sendToMember(
      tmux,
      atmuxDir,
      { target, member: "rl", team: "test-team" },
      "msg",
      { sleep: NO_SLEEP, verify: false },
    );
    expect(out.preWarn).toBe(true);
    expect(out.preSnapshot.rateLimit).toBe("hard");
  });
});

describe("sendToMember — safe-send preflight (t-06e7209d)", () => {
  test("preflight result surfaces on SendOutcome (READY pane)", async () => {
    const { target } = await spinCatSession(`${sessionPrefix}_pf_ok`);
    // Get the cat pane to a Claude-like ready state by feeding the
    // ready-banner. Capture-pane sees the line + classifies READY.
    // Pre-ADR-080 §C this fixture was "3.4k tokens · esc to interrupt"
    // — that phrase now classifies BUSY (only renders during an active
    // turn). The canonical post-§C READY footer is the tok-counter +
    // auto-mode indicator.
    await tmux.pane.sendKeys({
      target: { kind: "member", member: "x", team: "t", target },
      keys: "tok 67k/100  ⏵⏵ auto mode on",
      enter: true,
    });
    await new Promise((r) => setTimeout(r, 200));
    const out = await sendToMember(
      tmux,
      atmuxDir,
      { target, member: "ok", team: "test-team" },
      "msg",
      { sleep: NO_SLEEP, verify: false },
    );
    expect(out.preflight).toBeDefined();
    expect(out.preflight.ready).toBe(true);
    expect(out.preflight.dismissals).toBe(0);
    expect(out.preflight.finalClassification.state).toBe("READY");
    // Send still landed (warn-and-proceed semantic preserved).
    expect(out.kind).toBe("ok");
  });

  test("preflight dismisses CC feedback survey before paste (t-06e7209d core scenario)", async () => {
    // Pane is showing the feedback survey — typical stuck-pane class.
    // Without preflight, our paste body lands inside the survey's
    // input slot. With preflight, "0" is sent first to dismiss.
    const session = `${sessionPrefix}_modal_${Math.random().toString(36).slice(2, 6)}`;
    await tmux.session.newSession({
      name: session,
      shellCommand:
        "sh -c \"printf '● How is Claude doing this session? (optional)\\n  1: Bad    2: Fine   3: Good   0: Dismiss\\n' && cat\"",
    });
    const target = `${session}:0.0`;
    await new Promise((r) => setTimeout(r, 200));
    const out = await sendToMember(
      tmux,
      atmuxDir,
      { target, member: "modal", team: "test-team" },
      "msg",
      { sleep: NO_SLEEP, verify: false },
    );
    // Preflight detected the feedback survey + dismissed at least once.
    // (May dismiss multiple times if the cat pane keeps showing survey
    // text in capture window after echoing "0".)
    expect(out.preflight).toBeDefined();
    expect(out.preflight.dismissals).toBeGreaterThanOrEqual(1);
    // Send still proceeded (warn-and-proceed semantics — refusal does
    // not abort paste; that would leave queued asks undelivered).
    expect(out.kind).toBe("ok");
  });
});

describe("sendToMember — sleep injection", () => {
  test("default sleep is no-op when ms <= 0", async () => {
    // Cover the `if (ms <= 0) return Promise.resolve()` branch in
    // defaultSleep by overriding the delays to 0 without overriding
    // the sleep function itself.
    const { target } = await spinCatSession(`${sessionPrefix}_sl`);
    const out = await sendToMember(
      tmux,
      atmuxDir,
      { target, member: "sl", team: "test-team" },
      "msg",
      { preSubmitDelayMs: 0, verifyDelayMs: 0, verify: true },
    );
    expect(out.kind).toBe("ok");
  });

  test("default sleep actually delays when ms > 0", async () => {
    // Cover the `setTimeout` branch of defaultSleep with a tiny but
    // measurable delay. We assert elapsed ≥ delay to prove the sleep
    // happened, without depending on the exact value.
    const { target } = await spinCatSession(`${sessionPrefix}_sl2`);
    const t0 = Date.now();
    await sendToMember(tmux, atmuxDir, { target, member: "sl2", team: "test-team" }, "msg", {
      preSubmitDelayMs: 50,
      verifyDelayMs: 50,
      verify: true,
    });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100); // pre + verify
  });
});

describe("looksLikeNotConsumed — pure heuristic", () => {
  // Direct test of the verify heuristic without staging tmux state.
  // Both bash conditions must hold (snippet in last-3 AND prompt-like
  // last line); either alone returns false.

  test("true when snippet in last-3 AND last line looks like `$ ` prompt", () => {
    const post = "got: tracer-XYZ\n$ ";
    expect(looksLikeNotConsumed(post, "tracer-XYZ")).toBe(true);
  });

  test("true on `❯` prompt char", () => {
    expect(looksLikeNotConsumed("foo bar baz\n❯ ", "bar")).toBe(true);
  });

  test("true on `>` prompt char", () => {
    expect(looksLikeNotConsumed("foo bar baz\n> ", "bar")).toBe(true);
  });

  test("true on `›` prompt char", () => {
    expect(looksLikeNotConsumed("foo bar baz\n› ", "bar")).toBe(true);
  });

  test("true on `#` (root prompt) char", () => {
    expect(looksLikeNotConsumed("foo bar\n# ", "bar")).toBe(true);
  });

  test("false when snippet not visible in last-3 lines", () => {
    const post = "old-content\nl1\nl2\nl3\n$ ";
    expect(looksLikeNotConsumed(post, "old-content")).toBe(false);
  });

  test("false when last line is not prompt-like", () => {
    const post = "tracer\nstill-running";
    expect(looksLikeNotConsumed(post, "tracer")).toBe(false);
  });

  test("snippet is capped to first 50 chars (matches bash head -c 50)", () => {
    const long = "x".repeat(60);
    // Pane shows only the first 50 chars + prompt → still warns
    expect(looksLikeNotConsumed(`${"x".repeat(50)}\n$ `, long)).toBe(true);
  });

  test("strips trailing newline before splitting (matches bash sed behavior)", () => {
    const post = "tracer\n$ \n";
    expect(looksLikeNotConsumed(post, "tracer")).toBe(true);
  });
});

describe("isPreSendWarn — pure classifier", () => {
  test("false on a fresh pane snapshot", () => {
    expect(isPreSendWarn(classifyPaneState(""))).toBe(false);
    expect(isPreSendWarn(classifyPaneState("$ \n"))).toBe(false);
  });

  test("true on `Compacting conversation` marker", () => {
    expect(isPreSendWarn(classifyPaneState("Compacting conversation…\n$ "))).toBe(true);
  });

  test("true on `Press up to edit queued messages` marker", () => {
    expect(isPreSendWarn(classifyPaneState("Press up to edit queued messages\n$ "))).toBe(true);
  });

  test("true on hard rate-limit (`hit your limit`)", () => {
    expect(isPreSendWarn(classifyPaneState("you hit your limit, retry later\n$ "))).toBe(true);
  });

  test("true on soft rate-limit (`approaching usage limit`)", () => {
    expect(isPreSendWarn(classifyPaneState("approaching usage limit\n$ "))).toBe(true);
  });

  test("false on busy alone (busy is NOT in bash warn-list)", () => {
    expect(isPreSendWarn(classifyPaneState("Esc to interrupt\n"))).toBe(false);
  });

  test("false on contextCleared alone (NOT in bash warn-list)", () => {
    expect(isPreSendWarn(classifyPaneState("Context cleared. Ready for input\n"))).toBe(false);
  });
});
