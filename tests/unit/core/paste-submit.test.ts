// Unit tests for src/core/paste-submit.ts (ADR-081 §A — t-e7de08c7).
//
// Pin the §A contract: sleep ≥500ms then `tmux send-keys ... C-m` as a
// SEPARATE call. Three regression vectors covered: the keys value (must
// be "C-m" not "Enter"), the settle floor clamping (sub-500ms requested
// values are clamped UP), and the call ordering (sleep happens BEFORE
// sendKeys — out-of-order resurrects the bracketed-paste swallow bug).

import { describe, expect, test } from "bun:test";
import {
  PASTE_SUBMIT_SETTLE_FLOOR_MS,
  pasteAndSubmit,
  submitAfterPaste,
} from "../../../src/core/paste-submit.ts";
import type { SendTarget, TmuxNamespace } from "../../../src/abstractions/tmux.ts";

type Event = { kind: "sleep"; ms: number } | { kind: "sendKeys"; keys: string; enter: boolean | undefined };

function buildFakeTmux(): {
  tmux: TmuxNamespace;
  timeline: Event[];
} {
  const timeline: Event[] = [];
  const tmux = {
    pane: {
      async sendKeys(o: { target: SendTarget; keys: string; enter?: boolean }) {
        timeline.push({ kind: "sendKeys", keys: o.keys, enter: o.enter });
      },
    },
  } as unknown as TmuxNamespace;
  return { tmux, timeline };
}

const TARGET: SendTarget = { kind: "member", member: "alice", team: "demo", target: "demo:0" };

describe("submitAfterPaste — ADR-081 §A contract", () => {
  test("submits with keys='C-m' (NOT Enter) and enter=false", async () => {
    const { tmux, timeline } = buildFakeTmux();
    const sleeps: number[] = [];
    await submitAfterPaste(tmux, TARGET, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    // The send-keys event has the literal C-m keysym, not Enter.
    const send = timeline.find((e) => e.kind === "sendKeys");
    expect(send).toBeDefined();
    if (send?.kind === "sendKeys") {
      expect(send.keys).toBe("C-m");
      // `enter: false` matters — the wrapper would otherwise append a
      // second Enter, producing `send-keys -t <target> C-m Enter` and
      // re-resurrecting the bracketed-paste failure mode.
      expect(send.enter).toBe(false);
    }
  });

  test("default settle is the §A floor (500ms)", async () => {
    const { tmux } = buildFakeTmux();
    const sleeps: number[] = [];
    await submitAfterPaste(tmux, TARGET, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps).toEqual([PASTE_SUBMIT_SETTLE_FLOOR_MS]);
    expect(PASTE_SUBMIT_SETTLE_FLOOR_MS).toBe(500);
  });

  test("settleMs above the floor passes through verbatim (rotate uses 1000ms)", async () => {
    const { tmux } = buildFakeTmux();
    const sleeps: number[] = [];
    await submitAfterPaste(tmux, TARGET, {
      settleMs: 1_000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps).toEqual([1_000]);
  });

  test("settleMs BELOW the floor is clamped up to 500ms (regression guard)", async () => {
    // Bash precedent at lib/send.sh:117 was `sleep 0.3` (300ms) — that
    // worked when the trailing submit was bare Enter (no bracketed-paste
    // swallow at the time). Under ADR-081 §A's C-m model the paste needs
    // ≥500ms to fully land in the compose box; sub-floor values are
    // clamped UP rather than honored so callers that haven't been
    // re-audited can't accidentally re-introduce the bug.
    const { tmux } = buildFakeTmux();
    const sleeps: number[] = [];
    await submitAfterPaste(tmux, TARGET, {
      settleMs: 300,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps).toEqual([PASTE_SUBMIT_SETTLE_FLOOR_MS]);
  });

  test("settleMs exactly at the floor (500ms) is honored as-is", async () => {
    const { tmux } = buildFakeTmux();
    const sleeps: number[] = [];
    await submitAfterPaste(tmux, TARGET, {
      settleMs: 500,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps).toEqual([500]);
  });

  test("sleep happens BEFORE send-keys (order pinned via timeline)", async () => {
    const { tmux, timeline } = buildFakeTmux();
    await submitAfterPaste(tmux, TARGET, {
      sleep: async (ms) => {
        timeline.push({ kind: "sleep", ms });
      },
    });
    // Exactly two events: sleep then sendKeys, in that order.
    expect(timeline).toHaveLength(2);
    expect(timeline[0]?.kind).toBe("sleep");
    expect(timeline[1]?.kind).toBe("sendKeys");
  });

  test("pasteAndSubmit composes loadBuffer + pasteBuffer + submitAfterPaste in order (ADR-138 T3b3)", async () => {
    // Build a fuller mock that records buffer ops too. timeline order
    // is the contract — load → paste → sleep → C-m send.
    type BufEvent =
      | { kind: "loadBuffer"; name: string; data: string }
      | { kind: "pasteBuffer"; name: string; deleteAfter: boolean }
      | Event;
    const events: BufEvent[] = [];
    const tmux = {
      buffer: {
        async loadBuffer(o: { name: string; data: string }) {
          events.push({ kind: "loadBuffer", name: o.name, data: o.data });
        },
        async pasteBuffer(o: { name?: string; deleteAfter?: boolean }) {
          events.push({
            kind: "pasteBuffer",
            name: o.name ?? "",
            deleteAfter: o.deleteAfter ?? false,
          });
        },
      },
      pane: {
        async sendKeys(o: { target: SendTarget; keys: string; enter?: boolean }) {
          events.push({ kind: "sendKeys", keys: o.keys, enter: o.enter });
        },
      },
    } as unknown as TmuxNamespace;
    const sleeps: number[] = [];
    await pasteAndSubmit(tmux, TARGET, "atmux claim --next --as alpha", {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    // Order: load, paste, send (sleep fires inside submitAfterPaste,
    // which we override).
    expect(events.length).toBe(3);
    expect(events[0]?.kind).toBe("loadBuffer");
    expect(events[1]?.kind).toBe("pasteBuffer");
    expect(events[2]?.kind).toBe("sendKeys");
    // Body lands in load-buffer verbatim.
    if (events[0]?.kind === "loadBuffer") {
      expect(events[0].data).toBe("atmux claim --next --as alpha");
    }
    // paste-buffer uses delete-after.
    if (events[1]?.kind === "pasteBuffer") {
      expect(events[1].deleteAfter).toBe(true);
    }
    // The trailing submit IS C-m (not Enter) — bracketed-paste mode.
    if (events[2]?.kind === "sendKeys") {
      expect(events[2].keys).toBe("C-m");
      expect(events[2].enter).toBe(false);
    }
    // Settle delay honored (≥ floor).
    expect(sleeps.length).toBe(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(PASTE_SUBMIT_SETTLE_FLOOR_MS);
  });

  test("pasteAndSubmit uses the same buffer name for load + paste (no cross-buffer leak)", async () => {
    type BufEvent =
      | { kind: "loadBuffer"; name: string }
      | { kind: "pasteBuffer"; name: string }
      | Event;
    const events: BufEvent[] = [];
    const tmux = {
      buffer: {
        async loadBuffer(o: { name: string; data: string }) {
          events.push({ kind: "loadBuffer", name: o.name });
        },
        async pasteBuffer(o: { name?: string }) {
          events.push({ kind: "pasteBuffer", name: o.name ?? "" });
        },
      },
      pane: {
        async sendKeys() {},
      },
    } as unknown as TmuxNamespace;
    await pasteAndSubmit(tmux, TARGET, "hello", { sleep: async () => {} });
    const load = events.find((e) => e.kind === "loadBuffer");
    const paste = events.find((e) => e.kind === "pasteBuffer");
    if (load?.kind === "loadBuffer" && paste?.kind === "pasteBuffer") {
      expect(load.name).toBe(paste.name);
      expect(load.name.length).toBeGreaterThan(0);
    }
  });

  test("pasteAndSubmit honors custom bufferName + settleMs overrides", async () => {
    const events: Array<{ kind: string; bufferName?: string | undefined; settleMs?: number }> = [];
    const tmux = {
      buffer: {
        async loadBuffer(o: { name: string; data: string }) {
          events.push({ kind: "loadBuffer", bufferName: o.name });
        },
        async pasteBuffer(o: { name?: string }) {
          events.push({ kind: "pasteBuffer", bufferName: o.name });
        },
      },
      pane: {
        async sendKeys() {
          events.push({ kind: "sendKeys" });
        },
      },
    } as unknown as TmuxNamespace;
    const sleeps: number[] = [];
    await pasteAndSubmit(tmux, TARGET, "x", {
      bufferName: "custom_buf",
      settleMs: 800,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(events.find((e) => e.kind === "loadBuffer")?.bufferName).toBe("custom_buf");
    expect(sleeps[0]).toBe(800);
  });

  test("uses real setTimeout when no sleep override provided (smoke)", async () => {
    // No timeline assertion — we just verify the function resolves
    // against the real timer with a tiny settle. The settleMs clamp
    // still fires, so the actual wait is 500ms; pass a higher floor-
    // bypass via the helper API to keep test time bounded? No — the
    // floor is intentionally non-bypassable. Use a small settle below
    // the floor to verify it's clamped up and the await resolves.
    const { tmux } = buildFakeTmux();
    const t0 = Date.now();
    await submitAfterPaste(tmux, TARGET);
    const elapsed = Date.now() - t0;
    // Allow some slack on either side — Node timers aren't precise to
    // the ms, but the 500ms floor MUST have been honored.
    expect(elapsed).toBeGreaterThanOrEqual(450);
  });
});
