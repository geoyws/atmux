// Unit tests for src/core/agent-pane.ts — the two-stage agent-pane
// lifecycle (operator directive 2026-09-22).
//
// Three properties are load-bearing and each of them can break while
// leaving every other suite green, so each gets a direct test:
//
//  1. Every input op is pinned to the IMMUTABLE PaneId handed in, and
//     the capture that proves readiness is read from that same pane. A
//     regression to a window target would silently type into whichever
//     pane happens to be active.
//  2. The readiness token never appears literally on the command line,
//     so `capture-pane` can only match EXECUTED output — never an
//     unevaluated command line sitting in a TUI composer.
//  3. A pane that never executes the probe returns `no-prompt` and the
//     TUI command is not sent at all.
//
// Plus the startup-race property: the probe is re-sent inside the poll
// budget with a fresh token each time, and a launch happens only once
// the NEWEST probe has been observed — which is what proves no probe is
// still queued when the TUI command goes out.

import { describe, expect, test } from "bun:test";
import type { PaneId, SendTarget, Target, TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import { serializeTarget } from "../../../src/abstractions/tmux.ts";
import { launchAgentInPane, resolveOnlyPane } from "../../../src/core/agent-pane.ts";

const PANE: PaneId = { sessionName: "cage", windowIndex: 7, paneIndex: 0 };
const TUI_COMMAND = "env -u NO_COLOR cd /w && claude --model sonnet";

interface Send {
  sendTarget: SendTarget;
  target: Target;
  keys: string;
  literal: boolean;
}

interface Harness {
  tmux: TmuxNamespace;
  sends: Send[];
  captures: Target[];
}

/** Decode the token out of `printf '\\101\\102...\\n'`, i.e. exactly what
 *  the pane's shell would print when it EXECUTES the probe. Returns null
 *  for anything that is not a probe. */
function executeProbe(keys: string): string | null {
  if (!keys.startsWith("printf '")) return null;
  const octal = keys.slice("printf '".length, -3);
  return octal.replace(/\\([0-7]{3})/g, (_m, digits: string) =>
    String.fromCharCode(Number.parseInt(digits, 8)),
  );
}

/** Fake pane namespace. `screen(sends, nth)` decides what capture-pane
 *  returns on the nth poll, given every keystroke sent so far — which is
 *  how a real pane behaves: output exists only for lines it executed. */
function makeHarness(screen: (sends: ReadonlyArray<Send>, nth: number) => string): Harness {
  const sends: Send[] = [];
  const captures: Target[] = [];
  const tmux = {
    pane: {
      sendKeys: async (opts: { target: SendTarget; keys: string; literal?: boolean }) => {
        sends.push({
          sendTarget: opts.target,
          target: opts.target.target,
          keys: opts.keys,
          literal: opts.literal ?? false,
        });
      },
      capturePane: async (opts: { target: Target }) => {
        captures.push(opts.target);
        return screen(sends, captures.length - 1);
      },
      listPanes: async () => [{ index: 0, pid: 1, title: "zsh", width: 80, height: 24 }],
    },
  } as unknown as TmuxNamespace;
  return { tmux, sends, captures };
}

/** A healthy pane: every probe it has been sent has already run, so all
 *  their tokens are on screen. */
function liveShell(sends: ReadonlyArray<Send>): string {
  return sends
    .map((s) => executeProbe(s.keys))
    .filter((t): t is string => t !== null)
    .join("\n");
}

function probeSends(sends: ReadonlyArray<Send>): Send[] {
  return sends.filter((s) => executeProbe(s.keys) !== null);
}

async function launch(
  h: Harness,
  extra: Partial<Parameters<typeof launchAgentInPane>[0]> = {},
): Promise<"launched" | "no-prompt"> {
  return await launchAgentInPane({
    tmux: h.tmux,
    paneId: PANE,
    intent: { kind: "service", team: "__cockpit__" },
    command: TUI_COMMAND,
    sleep: async () => {},
    ...extra,
  });
}

describe("resolveOnlyPane", () => {
  test("returns the sole pane of the window under the caller's session/index", async () => {
    const h = makeHarness(() => "");
    const paneId = await resolveOnlyPane(
      h.tmux,
      { sessionName: "cage", windowIndex: 7 },
      "cage",
      7,
    );
    expect(paneId).toEqual({ sessionName: "cage", windowIndex: 7, paneIndex: 0 });
  });

  test("refuses a split window rather than guessing which pane gets input", async () => {
    const tmux = {
      pane: {
        listPanes: async () => [
          { index: 0, pid: 1, title: "zsh", width: 80, height: 12 },
          { index: 1, pid: 2, title: "zsh", width: 80, height: 12 },
        ],
      },
    } as unknown as TmuxNamespace;
    await expect(
      resolveOnlyPane(tmux, { sessionName: "cage", windowIndex: 7 }, "cage", 7),
    ).rejects.toThrow("must contain exactly one pane (found 2)");
  });

  test("refuses a window that reports no panes", async () => {
    const tmux = { pane: { listPanes: async () => [] } } as unknown as TmuxNamespace;
    await expect(
      resolveOnlyPane(tmux, { sessionName: "cage", windowIndex: 7 }, "cage", 7),
    ).rejects.toThrow("(found 0)");
  });
});

describe("launchAgentInPane — exact-pane pinning", () => {
  test("probes, captures and launches on the one immutable PaneId given", async () => {
    const h = makeHarness(liveShell);
    expect(await launch(h)).toBe("launched");

    // Every keystroke — probe, submit, TUI command, submit — addressed
    // the exact pane, never a window or a name.
    expect(h.sends.length).toBeGreaterThan(0);
    for (const send of h.sends) {
      expect(send.target).toEqual(PANE);
    }
    // …and readiness was read off that same pane.
    expect(h.captures.length).toBeGreaterThan(0);
    for (const target of h.captures) {
      expect(serializeTarget(target)).toBe("cage:7.0");
    }
  });

  test("the TUI command is the last thing sent, submitted with C-m", async () => {
    const h = makeHarness(liveShell);
    expect(await launch(h)).toBe("launched");
    expect(h.sends.at(-2)?.keys).toBe(TUI_COMMAND);
    expect(h.sends.at(-2)?.literal).toBe(true);
    expect(h.sends.at(-1)?.keys).toBe("C-m");
  });
});

describe("launchAgentInPane — readiness token", () => {
  test("the token is absent from the command line and present only in its output", async () => {
    const h = makeHarness(liveShell);
    expect(await launch(h, { readinessToken: () => "ATMUX_READY_FIXED" })).toBe("launched");

    const probes = probeSends(h.sends);
    expect(probes.length).toBeGreaterThan(0);
    for (const probe of probes) {
      // The literal token must never be typeable-visible: were it on the
      // command line, a TUI composer echoing the line back would satisfy
      // the capture match and the pane would look ready when it is not.
      expect(probe.keys).not.toContain("ATMUX_READY_FIXED");
      expect(executeProbe(probe.keys)).toBe("ATMUX_READY_FIXED");
    }
  });

  test("token absence over the whole budget → no-prompt and NO TUI send", async () => {
    const h = makeHarness(() => "❯ some unrelated pane content");
    expect(await launch(h, { timeoutMs: 1_000, pollMs: 250 })).toBe("no-prompt");

    expect(h.sends.some((s) => s.keys === TUI_COMMAND)).toBe(false);
    expect(h.sends.every((s) => executeProbe(s.keys) !== null || s.keys === "C-m")).toBe(true);
    // The budget was actually spent polling rather than bailing early.
    expect(h.captures.length).toBe(4);
  });

  test("a capture error does not abort the launch — polling continues in budget", async () => {
    let calls = 0;
    const h = makeHarness((sends) => {
      calls += 1;
      if (calls <= 2) throw new Error("no such pane (yet)");
      return liveShell(sends);
    });
    expect(await launch(h, { timeoutMs: 2_000, pollMs: 250 })).toBe("launched");
    expect(h.sends.at(-2)?.keys).toBe(TUI_COMMAND);
  });
});

describe("launchAgentInPane — startup-race retry", () => {
  test("re-sends the probe inside the budget when the first one is lost", async () => {
    // The pane swallows everything typed at it for the first 2s (it is
    // still exec'ing its shell), then starts executing. Only a re-send
    // can recover this; a single-shot probe would burn the whole budget.
    const lostBefore = 8; // polls, at 250ms = 2s
    const h = makeHarness((sends, nth) =>
      // `slice(2)` drops the first probe+submit pair: those keystrokes
      // went into the void, so their output never appears.
      nth < lostBefore ? "" : liveShell(sends.slice(2)),
    );
    expect(await launch(h, { timeoutMs: 15_000, pollMs: 250, reprobeMs: 2_000 })).toBe("launched");

    expect(probeSends(h.sends).length).toBeGreaterThan(1);
    expect(h.sends.at(-2)?.keys).toBe(TUI_COMMAND);
  });

  test("every retry uses a fresh token", async () => {
    const h = makeHarness(() => "");
    expect(await launch(h, { timeoutMs: 4_000, pollMs: 250, reprobeMs: 1_000 })).toBe("no-prompt");

    const tokens = probeSends(h.sends).map((s) => executeProbe(s.keys));
    expect(tokens.length).toBe(4);
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  test("a stale token on screen never launches — only the newest probe counts", async () => {
    // This is the no-queued-probe-leak invariant: launching on an older
    // token would mean the probes sent after it are still unexecuted and
    // would land inside the TUI once it starts.
    let firstToken: string | null = null;
    const h = makeHarness((sends, nth) => {
      firstToken ??= executeProbe(sends[0]?.keys ?? "");
      // Only the FIRST probe ever executed; the screen keeps showing its
      // token while later probes sit unexecuted in the tty queue.
      return nth < 4 ? "" : (firstToken ?? "");
    });
    expect(await launch(h, { timeoutMs: 4_000, pollMs: 250, reprobeMs: 1_000 })).toBe("no-prompt");
    expect(h.sends.some((s) => s.keys === TUI_COMMAND)).toBe(false);
  });

  test("no probe is sent after the TUI command", async () => {
    const h = makeHarness(liveShell);
    expect(await launch(h, { timeoutMs: 15_000, pollMs: 250, reprobeMs: 2_000 })).toBe("launched");

    const commandIndex = h.sends.findIndex((s) => s.keys === TUI_COMMAND);
    expect(commandIndex).toBeGreaterThanOrEqual(0);
    expect(probeSends(h.sends.slice(commandIndex)).length).toBe(0);
  });
});
