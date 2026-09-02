// ADR-205 contract test: bracketed-paste-as-default for message bodies +
// the `opts.rawSendKeys = true` per-call escape hatch (§D2).
//
// `sendToMember` (src/core/send.ts) is the single per-member delivery
// pipeline every body-send verb (tell-lead / send / dispatch / stop)
// routes through. ADR-205 Option 2 made the bracketed-paste envelope
// (`tmux load-buffer + tmux paste-buffer -d + ≥500ms settle + send-keys
// C-m`) the DEFAULT body-delivery shape so slash-leading bodies stop
// triggering the compose-box popup (the 2026-05-21 wedge). The escape
// hatch flips a single send back to the legacy literal `send-keys -l`
// keystroke shape for callers that need control-sequence semantics.
//
// Strategy: record the exact tmux call sequence via a recorder-backed
// mock `TmuxNamespace`. We assert the *wire shape*, not just an outcome
// — which path fired (envelope vs literal), in which order, with which
// keysyms. A test that only checked `out.kind === "ok"` would stay green
// even if the body never left the buffer; this one watches the bytes.

import { describe, expect, test } from "bun:test";
import type { SendTarget, TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import { sendToMember } from "../../../src/core/send.ts";

const NO_SLEEP = (_ms: number): Promise<void> => Promise.resolve();

/** One recorded tmux operation, tagged by which primitive fired.
 *  Optional fields carry `| undefined` explicitly so the recorder can
 *  forward the abstraction's optional opts verbatim under the repo's
 *  `exactOptionalPropertyTypes: true`. */
type Recorded =
  | { op: "loadBuffer"; name: string | undefined; data: string }
  | {
      op: "pasteBuffer";
      name: string | undefined;
      target: SendTarget;
      deleteAfter: boolean | undefined;
    }
  | {
      op: "sendKeys";
      target: SendTarget;
      keys: string;
      literal: boolean | undefined;
      enter: boolean | undefined;
    }
  | { op: "capturePane"; target: string };

interface MockTmux {
  tmux: TmuxNamespace;
  calls: Recorded[];
}

/**
 * Recorder-backed mock implementing only the primitives `sendToMember`
 * touches: pane.capturePane / pane.sendKeys, buffer.loadBuffer /
 * buffer.pasteBuffer. `capturePane` returns "" so the pre-send
 * classifier sees a calm pane and `looksLikeNotConsumed` never trips.
 * Everything else throws if hit — surfacing an unexpected code path
 * rather than silently passing.
 */
function makeMockTmux(): MockTmux {
  const calls: Recorded[] = [];
  const notImpl = (name: string) => () => {
    throw new Error(`mock tmux: ${name} should not be called by sendToMember`);
  };
  const tmux = {
    pane: {
      async capturePane(opts: { target: string }) {
        calls.push({ op: "capturePane", target: opts.target });
        return "";
      },
      async sendKeys(opts: {
        target: SendTarget;
        keys: string;
        literal?: boolean;
        enter?: boolean;
      }) {
        calls.push({
          op: "sendKeys",
          target: opts.target,
          keys: opts.keys,
          literal: opts.literal,
          enter: opts.enter,
        });
      },
      listPanes: notImpl("pane.listPanes"),
      displayMessage: notImpl("pane.displayMessage"),
      killPane: notImpl("pane.killPane"),
      splitWindow: notImpl("pane.splitWindow"),
    },
    buffer: {
      async loadBuffer(opts: { name?: string; data: string }) {
        calls.push({ op: "loadBuffer", name: opts.name, data: opts.data });
      },
      async pasteBuffer(opts: { name?: string; target: SendTarget; deleteAfter?: boolean }) {
        calls.push({
          op: "pasteBuffer",
          name: opts.name,
          target: opts.target,
          deleteAfter: opts.deleteAfter,
        });
      },
    },
    server: {} as Record<string, unknown>,
    session: {} as Record<string, unknown>,
    window: {} as Record<string, unknown>,
  } as unknown as TmuxNamespace;
  return { tmux, calls };
}

const TARGET = { target: "sess:0.0", member: "alice", team: "test-team" };
const ATMUX_DIR = "/tmp/atmux-bracketed-paste-test-noop";

describe("ADR-205 — bracketed-paste as the default body-delivery shape", () => {
  test("default send emits load-buffer + paste-buffer -d + C-m submit (the envelope)", async () => {
    const { tmux, calls } = makeMockTmux();
    const out = await sendToMember(tmux, ATMUX_DIR, TARGET, "/whip do the thing", {
      sleep: NO_SLEEP,
      verify: false,
    });
    expect(out.kind).toBe("ok");

    const load = calls.find((c) => c.op === "loadBuffer");
    const paste = calls.find((c) => c.op === "pasteBuffer");
    const submit = calls.find((c) => c.op === "sendKeys");

    // 1. Body staged into a buffer verbatim (envelope carries it).
    expect(load).toBeDefined();
    expect(load?.op === "loadBuffer" && load.data).toBe("/whip do the thing");

    // 2. paste-buffer fires with -d (deleteAfter) into the SAME named
    //    buffer — this is the ESC[200~ … ESC[201~ envelope at the
    //    tmux layer (paste-buffer wraps content in bracketed-paste).
    expect(paste?.op === "pasteBuffer" && paste.deleteAfter).toBe(true);
    expect(
      load?.op === "loadBuffer" && paste?.op === "pasteBuffer" && load.name === paste.name,
    ).toBe(true);

    // 3. Submit is the literal carriage-return keysym `C-m`, NOT the
    //    `Enter` token (ADR-081 §A: Enter gets swallowed as a newline
    //    inside the bracketed-paste envelope; C-m bypasses it).
    expect(submit?.op === "sendKeys" && submit.keys).toBe("C-m");
    expect(submit?.op === "sendKeys" && submit.enter).toBe(false);

    // 4. The body NEVER went through a literal text-body send-keys —
    //    if it had, the slash-leading "/whip" would trigger the popup.
    const literalBody = calls.find(
      (c) => c.op === "sendKeys" && c.literal === true && c.keys === "/whip do the thing",
    );
    expect(literalBody).toBeUndefined();

    // 5. Ordering: load BEFORE paste BEFORE submit.
    const idx = (op: Recorded["op"]) => calls.findIndex((c) => c.op === op);
    expect(idx("loadBuffer")).toBeLessThan(idx("pasteBuffer"));
    expect(idx("pasteBuffer")).toBeLessThan(idx("sendKeys"));
  });

  test("plain (non-slash) body still routes through the envelope — regression parity", async () => {
    const { tmux, calls } = makeMockTmux();
    await sendToMember(tmux, ATMUX_DIR, TARGET, "hello world", {
      sleep: NO_SLEEP,
      verify: false,
    });
    const load = calls.find((c) => c.op === "loadBuffer");
    expect(load?.op === "loadBuffer" && load.data).toBe("hello world");
    expect(calls.some((c) => c.op === "pasteBuffer")).toBe(true);
    // No literal text-body send-keys for the plain body either.
    expect(
      calls.some((c) => c.op === "sendKeys" && c.literal === true && c.keys === "hello world"),
    ).toBe(false);
  });
});

describe("ADR-205 §D2 — rawSendKeys per-call escape hatch", () => {
  test("rawSendKeys:true sends body via literal send-keys -l + Enter, NO buffer/paste", async () => {
    const { tmux, calls } = makeMockTmux();
    const out = await sendToMember(tmux, ATMUX_DIR, TARGET, "C-x literal body", {
      sleep: NO_SLEEP,
      verify: false,
      rawSendKeys: true,
    });
    expect(out.kind).toBe("ok");

    // The escape hatch must NOT touch the buffer machinery at all.
    expect(calls.some((c) => c.op === "loadBuffer")).toBe(false);
    expect(calls.some((c) => c.op === "pasteBuffer")).toBe(false);

    // Exactly one body send-keys, in literal mode, carrying the body
    // verbatim, with the trailing Enter (it submits, not C-m — the
    // literal path is outside the bracketed-paste envelope so Enter is
    // safe).
    const bodySends = calls.filter((c) => c.op === "sendKeys");
    expect(bodySends.length).toBe(1);
    const send = bodySends[0];
    expect(send?.op === "sendKeys" && send.keys).toBe("C-x literal body");
    expect(send?.op === "sendKeys" && send.literal).toBe(true);
    expect(send?.op === "sendKeys" && send.enter).toBe(true);
  });

  test("rawSendKeys:true + noSubmit leaves body typed with NO Enter (queued)", async () => {
    const { tmux, calls } = makeMockTmux();
    const out = await sendToMember(tmux, ATMUX_DIR, TARGET, "draft body", {
      sleep: NO_SLEEP,
      verify: false,
      rawSendKeys: true,
      noSubmit: true,
    });
    expect(out.kind).toBe("queued");
    const bodySends = calls.filter((c) => c.op === "sendKeys");
    expect(bodySends.length).toBe(1);
    const send = bodySends[0];
    expect(send?.op === "sendKeys" && send.literal).toBe(true);
    expect(send?.op === "sendKeys" && send.enter).toBe(false);
    expect(calls.some((c) => c.op === "loadBuffer")).toBe(false);
  });

  test("default (no rawSendKeys) and raw paths differ — guards against a no-op flag", async () => {
    // If `rawSendKeys` were ignored, both calls would produce identical
    // call streams. Asserting they diverge proves the flag is wired.
    const def = makeMockTmux();
    await sendToMember(def.tmux, ATMUX_DIR, TARGET, "body", { sleep: NO_SLEEP, verify: false });
    const raw = makeMockTmux();
    await sendToMember(raw.tmux, ATMUX_DIR, TARGET, "body", {
      sleep: NO_SLEEP,
      verify: false,
      rawSendKeys: true,
    });
    const ops = (m: MockTmux) => m.calls.map((c) => c.op);
    expect(ops(def)).toContain("loadBuffer");
    expect(ops(raw)).not.toContain("loadBuffer");
    expect(ops(def)).not.toEqual(ops(raw));
  });
});
