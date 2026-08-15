// Unit tests for src/verbs/nudge.ts — ADR-273 D4/D5.
//
// The load-bearing property, and the one every assertion here is built
// around: **the receipt is a receipt, not a claim.**
//
// A test that asserted only "the send dep was called" would pass on a
// version of this verb that never reads the pane at all and hard-codes
// "the composer cleared" — which is precisely the failure D5 is written
// against ("a voice tool that appears to send and silently does not is
// worse than no tool"). So the suite pins three separate things:
//
//   1. **Ordering** — a call log proves the second pane read happens
//      AFTER the delivery, not before it and not instead of it.
//   2. **Dependence** — the SAME send, against a pane that did not
//      change, produces a DIFFERENT receipt saying so, and a non-zero
//      exit. A hard-coded success line cannot survive both directions.
//   3. **Delivery route** — the argv handed to `send` is asserted, and
//      the injected tmux REFUSES every input-injection method, so a
//      hand-rolled `tmux send-keys` (which D5 forbids by name) fails
//      the suite instead of passing it silently.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import {
  buildSendArgv,
  defaultNudgeTmux,
  NUDGE_CAPTURE_LINES,
  NUDGE_SETTLE_MS_DEFAULT,
  type NudgeDeps,
  nudge,
  observePane,
  parseNudgeArgs,
} from "../../../src/verbs/nudge.ts";
import { parseSendArgs } from "../../../src/verbs/send.ts";
import { captureStdio } from "../../helpers/capture.ts";

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

const CHROME = "  ⏵⏵ auto mode on (shift+tab to cycle)\n  tok 12/900000";
const RESIDUE = `${CHROME}\n❯ claim --next`;
const WORKING = `${CHROME}\n✻ Cooking… (12s · esc to interrupt)`;

const TEAM_NAME = "atmux";
const MEMBER = { name: "be-1", emoji: "⚙" };
/** `buildWindowName("be-1", "⚙", undefined, undefined)` — ADR-135 hyphen
 *  form, because the roster entry carries no default-member role. */
const WINDOW = "⚙-be-1";
const SESSION = "atmux-test-session";

/**
 * Default activity clocks for the two reads, and they are NOT the same
 * on purpose.
 *
 * BEFORE: last output ~400s ago. A wedged pane is by definition one
 * nothing has touched, and the classifier's `RESIDUE_FRESH_SEC` rule
 * (60s) would otherwise read the residue as "someone is typing".
 * AFTER: last output ~1s ago — our own paste, which is exactly the
 * condition `classifyAfterNudge` has to survive.
 */
const DEFAULT_PROBES = ["1786800100\t0\tclaude", "1786800499\t0\tclaude"];

const tempRoots: string[] = [];
let priorSessionEnv: string | undefined;

beforeEach(() => {
  priorSessionEnv = process.env.ATMUX_SESSION;
  delete process.env.ATMUX_SESSION;
});

afterEach(async () => {
  if (priorSessionEnv === undefined) delete process.env.ATMUX_SESSION;
  else process.env.ATMUX_SESSION = priorSessionEnv;
  for (const r of tempRoots.splice(0)) await rm(r, { recursive: true, force: true });
});

/** A real `<root>/.atmux/` tree with a roster and a pinned session
 *  anchor, so the target the verb resolves is deterministic. */
async function makeRoot(
  members: ReadonlyArray<{ name: string; emoji?: string }> = [MEMBER],
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atmux-nudge-"));
  tempRoots.push(root);
  const atmuxDir = join(root, ".atmux");
  await mkdir(join(atmuxDir, "state"), { recursive: true });
  await writeFile(
    join(atmuxDir, "team.json"),
    JSON.stringify({ name: TEAM_NAME, members }),
    "utf8",
  );
  await writeFile(join(atmuxDir, "state", "session.txt"), `${SESSION}\n`, "utf8");
  return root;
}

interface HarnessOpts {
  /** Pane captures, consumed in order (before, then after). */
  captures: string[];
  /** tmux `display-message` payloads, consumed in order. Defaults to
   *  {@link DEFAULT_PROBES}. */
  probes?: string[];
  windows?: string[];
  sendExit?: number;
  sendThrows?: Error;
  captureThrows?: boolean;
  probeThrows?: boolean;
}

interface Harness {
  deps: NudgeDeps;
  calls: string[];
  sendArgvs: string[][];
  out: string[];
}

/**
 * The injected world.
 *
 * Every input-injection method THROWS. ADR-273 D5 forbids a hand-rolled
 * `tmux send-keys` for delivery, and the cheapest way for that rule to
 * rot is for someone to "just press Enter here". This makes that a red
 * test rather than a silent regression.
 */
function harness(opts: HarnessOpts): Harness {
  const calls: string[] = [];
  const sendArgvs: string[][] = [];
  const out: string[] = [];
  const captures = [...opts.captures];
  const probes = [...(opts.probes ?? DEFAULT_PROBES)];
  const banned = (what: string) => () => {
    throw new Error(`ADR-273 D5 violation: nudge must not call tmux ${what} itself`);
  };
  const tmuxNs = {
    session: { hasSession: async () => true },
    window: {
      listWindows: async (session: string) => {
        calls.push(`listWindows:${session}`);
        return (opts.windows ?? [WINDOW]).map((name, i) => ({
          index: i,
          id: `@${i}`,
          name,
          active: i === 0,
        }));
      },
      renameWindow: banned("rename-window"),
    },
    buffer: { loadBuffer: banned("load-buffer"), pasteBuffer: banned("paste-buffer") },
    pane: {
      sendKeys: banned("send-keys"),
      displayMessage: async ({ target }: { target: string }) => {
        calls.push(`probe:${target}`);
        if (opts.probeThrows === true) throw new Error("probe blew up");
        return probes.shift() ?? "1786800499\t0\tclaude";
      },
      capturePane: async ({ target, start }: { target: string; start?: number }) => {
        calls.push(`capture:${target}:${String(start)}`);
        if (opts.captureThrows === true) throw new Error("capture blew up");
        return captures.shift() ?? "";
      },
    },
  } as unknown as TmuxNamespace;

  return {
    calls,
    sendArgvs,
    out,
    deps: {
      tmux: () => tmuxNs,
      send: async (argv) => {
        calls.push("send");
        sendArgvs.push([...argv]);
        if (opts.sendThrows !== undefined) throw opts.sendThrows;
        return opts.sendExit ?? 0;
      },
      sleep: async () => {},
      // Frozen clock: the classifier's frozen / dormant / fresh-residue
      // rules all read the ACTIVITY AGE derived from it, so a moving
      // clock would make the verdicts depend on how fast the test ran.
      now: () => 1_786_800_500_000,
      logger: { log: (m) => out.push(m) },
    },
  };
}

// ---------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------

describe("parseNudgeArgs", () => {
  test("member is required; action defaults to submit", () => {
    expect(parseNudgeArgs(["--member", "be-1"])).toEqual({
      member: "be-1",
      action: "submit",
      settleMs: NUDGE_SETTLE_MS_DEFAULT,
      json: false,
    });
  });

  test("every flag round-trips", () => {
    expect(
      parseNudgeArgs([
        "--member",
        "fe-2",
        "--action",
        "continue",
        "--team-dir",
        "/w/atmux",
        "--socket",
        "/tmp/s",
        "--settle-ms",
        "0",
        "--json",
      ]),
    ).toEqual({
      member: "fe-2",
      action: "continue",
      teamDir: "/w/atmux",
      socketPath: "/tmp/s",
      settleMs: 0,
      json: true,
    });
  });

  test("--member missing → UsageError", () => {
    expect(() => parseNudgeArgs([])).toThrow(UsageError);
    expect(() => parseNudgeArgs(["--member", ""])).toThrow(UsageError);
  });

  test.each([
    ["--member"],
    ["--action"],
    ["--team-dir"],
    ["--socket"],
    ["--settle-ms"],
  ])("%s without a value → UsageError", (flag) => {
    expect(() => parseNudgeArgs([flag])).toThrow(UsageError);
  });

  test("--settle-ms rejects non-integers and negatives", () => {
    expect(() => parseNudgeArgs(["--member", "a", "--settle-ms", "x"])).toThrow(UsageError);
    expect(() => parseNudgeArgs(["--member", "a", "--settle-ms", "-1"])).toThrow(UsageError);
    expect(() => parseNudgeArgs(["--member", "a", "--settle-ms", "1.5"])).toThrow(UsageError);
  });

  test("unknown arg → UsageError", () => {
    expect(() => parseNudgeArgs(["--member", "a", "--wat"])).toThrow(UsageError);
  });

  test("the parser does NOT validate the action — that is what keeps --action a safe slot", () => {
    // ADR-272 D2 §Supplement: `--action` is a flag-value slot, proved
    // safe by the parser reading argv[i + 1] unconditionally. A parser
    // that validated here would throw on the structural gate's hostile
    // probe, and the gate could no longer demonstrate the slot is safe.
    // `nudge()` rejects the value instead — see below.
    expect(parseNudgeArgs(["--member", "be-1", "--action", "--team-dir"]).action).toBe(
      "--team-dir",
    );
  });
});

// ---------------------------------------------------------------------
// The argv handed to `send` — checked against the REAL send parser
// ---------------------------------------------------------------------

describe("buildSendArgv — the delivery argv, validated against parseSendArgs", () => {
  test("submit → --submit-only with NO message body", () => {
    const argv = buildSendArgv({ member: "be-1", action: "submit", teamDir: "/w/atmux" });
    expect(argv).toEqual(["--team-dir", "/w/atmux", "--submit-only", "be-1"]);
    expect(parseSendArgs(argv)).toMatchObject({
      member: "be-1",
      msg: "",
      submitOnly: true,
      teamDir: "/w/atmux",
    });
  });

  test("continue → the canned constant as the message", () => {
    const argv = buildSendArgv({ member: "be-1", action: "continue", teamDir: "/w/atmux" });
    expect(argv).toEqual(["--team-dir", "/w/atmux", "be-1", "continue"]);
    expect(parseSendArgs(argv)).toMatchObject({
      member: "be-1",
      msg: "continue",
      submitOnly: false,
    });
  });

  test("--socket rides along, still ahead of the member positional", () => {
    const argv = buildSendArgv({
      member: "be-1",
      action: "continue",
      teamDir: "/w/a",
      socketPath: "/tmp/s",
    });
    expect(argv).toEqual(["--team-dir", "/w/a", "--socket", "/tmp/s", "be-1", "continue"]);
    expect(parseSendArgs(argv)).toMatchObject({ socketPath: "/tmp/s", member: "be-1" });
  });

  test("no team dir → no --team-dir pair (cwd fallback, same as every other tool)", () => {
    expect(buildSendArgv({ member: "be-1", action: "submit" })).toEqual(["--submit-only", "be-1"]);
  });

  test("the message a `continue` nudge sends is the canned constant and nothing else", () => {
    // The bound that lets pane_nudge ship without ADR-273 OQ-1: no
    // operator-supplied string can reach the pane.
    const argv = buildSendArgv({ member: "be-1", action: "continue" });
    expect(parseSendArgs(argv).msg).toBe("continue");
  });
});

// ---------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------

describe("refusals", () => {
  test("a driver pane is refused UP FRONT, naming ADR-239", async () => {
    const h = harness({ captures: [] });
    for (const name of ["driver", "driver-2", "driver-17"]) {
      await expect(nudge(["--member", name], h.deps)).rejects.toThrow(ConfigError);
    }
    // Nothing was read and nothing was sent — the refusal is before any IO.
    expect(h.calls).toEqual([]);
    expect(h.sendArgvs).toEqual([]);
  });

  test("the driver refusal message quotes the ADR, so the operator hears a rule not a bug", async () => {
    const h = harness({ captures: [] });
    await expect(nudge(["--member", "driver"], h.deps)).rejects.toThrow(/ADR-239/);
  });

  test("a member the roster does not carry is refused (send addresses roster members)", async () => {
    const dir = await makeRoot();
    const h = harness({ captures: [RESIDUE, WORKING] });
    await expect(nudge(["--member", "ghost", "--team-dir", dir], h.deps)).rejects.toThrow(
      ConfigError,
    );
    expect(h.sendArgvs).toEqual([]);
  });

  test("an action outside the allow-list is a UsageError before any IO", async () => {
    const h = harness({ captures: [] });
    await expect(nudge(["--member", "be-1", "--action", "rm -rf /"], h.deps)).rejects.toThrow(
      UsageError,
    );
    expect(h.calls).toEqual([]);
  });

  test("the allow-list refusal names the allowed values and says free text is impossible", async () => {
    const h = harness({ captures: [] });
    await expect(nudge(["--member", "be-1", "--action", "wat"], h.deps)).rejects.toThrow(
      /never sends free text/,
    );
  });

  test("a delivery failure PROPAGATES — a receipt describes a nudge that happened", async () => {
    const dir = await makeRoot();
    const h = harness({
      captures: [RESIDUE, WORKING],
      sendThrows: new ConfigError({ what: "send: no tmux window" }),
    });
    await expect(nudge(["--member", "be-1", "--team-dir", dir], h.deps)).rejects.toThrow(
      ConfigError,
    );
    expect(h.out).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// The receipt — the anti-lie suite
// ---------------------------------------------------------------------

describe("the receipt is VERIFIED, not claimed (ADR-273 D5)", () => {
  test("a nudge that took: reports the after-state read from the pane", async () => {
    const dir = await makeRoot();
    const h = harness({ captures: [RESIDUE, WORKING] });
    const code = await nudge(["--member", "be-1", "--team-dir", dir], h.deps);
    expect(code).toBe(0);
    expect(h.out).toHaveLength(1);
    expect(h.out[0]?.split("\n")).toEqual([
      `NUDGE ${TEAM_NAME}/be-1 (window ${WINDOW}) — pressed Enter to submit what was already in the composer`,
      "before: idle with unsubmitted text — unsubmitted: claim --next",
      "after: working",
      "the composer cleared and the agent is now working",
    ]);
  });

  test("the after-read happens AFTER the send — ordering, not narration", async () => {
    // If the second read were taken before the delivery (or not at all),
    // the receipt would describe a pane that had not yet been nudged.
    const dir = await makeRoot();
    const h = harness({ captures: [RESIDUE, WORKING] });
    await nudge(["--member", "be-1", "--team-dir", dir], h.deps);
    const target = `${SESSION}:${WINDOW}`;
    expect(h.calls).toEqual([
      `listWindows:${SESSION}`,
      `probe:${target}`,
      `capture:${target}:${String(-NUDGE_CAPTURE_LINES)}`,
      "send",
      `probe:${target}`,
      `capture:${target}:${String(-NUDGE_CAPTURE_LINES)}`,
    ]);
  });

  test("SAME send, pane did not move → the receipt says so and the verb exits 1", async () => {
    // The killer. A verb that hard-coded "the composer cleared" would
    // pass the happy-path test above and fail here.
    const dir = await makeRoot();
    const h = harness({ captures: [RESIDUE, RESIDUE] });
    const code = await nudge(["--member", "be-1", "--team-dir", dir], h.deps);
    expect(code).toBe(1);
    expect(h.out[0]).toContain("the pane is unchanged — the nudge did not take");
    expect(h.out[0]).not.toContain("now working");
    // ...and the send genuinely went out, so this is a delivery that
    // achieved nothing, not a delivery that never happened.
    expect(h.sendArgvs).toHaveLength(1);
  });

  test("residue still in the composer after the nudge is NOT reported as idle and clear", async () => {
    // The fresh-activity exemption in the survey classifier would file
    // this pane under `quiet: idle`; `classifyAfterNudge` refuses.
    const dir = await makeRoot();
    // The after-read's clock is deliberately 1s old — our own paste.
    const h = harness({ captures: [RESIDUE, RESIDUE], probes: DEFAULT_PROBES });
    await nudge(["--member", "be-1", "--team-dir", dir], h.deps);
    expect(h.out[0]).toContain("after: idle with unsubmitted text");
    expect(h.out[0]).not.toContain("after: idle and clear");
  });

  test("a nudge that moved the pane into a DIFFERENT problem says so", async () => {
    const dir = await makeRoot();
    const h = harness({
      captures: [RESIDUE, `${CHROME}\nDo you want Claude to run this?`],
    });
    const code = await nudge(["--member", "be-1", "--team-dir", dir], h.deps);
    expect(code).toBe(0);
    expect(h.out[0]).toContain("the pane moved but still needs you — now waiting on a permission");
  });

  test("delivery goes through `send` with exactly the built argv — the D5 route", async () => {
    const dir = await makeRoot();
    const h = harness({ captures: [RESIDUE, WORKING] });
    await nudge(["--member", "be-1", "--team-dir", dir, "--action", "continue"], h.deps);
    expect(h.sendArgvs).toEqual([
      buildSendArgv({ member: "be-1", action: "continue", teamDir: dir }),
    ]);
  });

  test("submit delivers --submit-only, so the residue cannot be concatenated onto", async () => {
    const dir = await makeRoot();
    const h = harness({ captures: [RESIDUE, WORKING] });
    await nudge(["--member", "be-1", "--team-dir", dir], h.deps);
    expect(h.sendArgvs[0]).toContain("--submit-only");
    expect(parseSendArgs(h.sendArgvs[0] ?? []).msg).toBe("");
  });

  test("--json emits the structured receipt instead of the spoken one", async () => {
    const dir = await makeRoot();
    const h = harness({ captures: [RESIDUE, WORKING] });
    await nudge(["--member", "be-1", "--team-dir", dir, "--json"], h.deps);
    const parsed = JSON.parse(h.out[0] ?? "{}") as Record<string, unknown>;
    expect(parsed).toMatchObject({
      team: TEAM_NAME,
      member: "be-1",
      windowName: WINDOW,
      action: "submit",
      before: { bucket: "attention", kind: "idle-residue" },
      after: { bucket: "quiet", kind: "working" },
    });
  });

  test("the socket flag is threaded through to the delivery argv", async () => {
    const dir = await makeRoot();
    const h = harness({ captures: [RESIDUE, WORKING] });
    await nudge(["--member", "be-1", "--team-dir", dir, "--socket", "/tmp/sk"], h.deps);
    expect(h.sendArgvs[0]).toEqual([
      "--team-dir",
      dir,
      "--socket",
      "/tmp/sk",
      "--submit-only",
      "be-1",
    ]);
  });
});

/** The harness minus its `sleep` and `logger` seams, so the production
 *  defaults for both are exercised. */
function bareDeps(h: Harness): NudgeDeps {
  const out: NudgeDeps = {};
  if (h.deps.tmux !== undefined) out.tmux = h.deps.tmux;
  if (h.deps.send !== undefined) out.send = h.deps.send;
  if (h.deps.now !== undefined) out.now = h.deps.now;
  return out;
}

describe("production defaults (no injected sleeper, no injected sink)", () => {
  test("the receipt reaches stdout through the real default logger, after a real settle", async () => {
    // Drives the default `sleep` and `logger` — the two seams every
    // other test replaces. `--settle-ms 1` keeps the real timer path
    // exercised without costing wall-clock.
    const dir = await makeRoot();
    const h = harness({ captures: [RESIDUE, WORKING] });
    const bare = bareDeps(h);
    const { result, stdout } = await captureStdio(() =>
      nudge(["--member", "be-1", "--team-dir", dir, "--settle-ms", "1"], bare),
    );
    expect(result).toBe(0);
    expect(stdout).toContain("the composer cleared and the agent is now working");
  });

  test("a zero settle short-circuits the timer instead of scheduling one", async () => {
    const dir = await makeRoot();
    const h = harness({ captures: [RESIDUE, WORKING] });
    const bare = bareDeps(h);
    const { result } = await captureStdio(() =>
      nudge(["--member", "be-1", "--team-dir", dir, "--settle-ms", "0"], bare),
    );
    expect(result).toBe(0);
  });
});

// ---------------------------------------------------------------------
// observePane
// ---------------------------------------------------------------------

describe("observePane", () => {
  test("carries the tmux activity clock into the observation", async () => {
    const h = harness({ captures: [RESIDUE], probes: ["1786800000\t1\tbash"] });
    const obs = await observePane({
      tmux: h.deps.tmux?.("/tmp/s") as TmuxNamespace,
      target: `${SESSION}:${WINDOW}`,
      team: TEAM_NAME,
      member: "be-1",
      windowName: WINDOW,
      nowSec: 1_786_800_060,
    });
    expect(obs).toMatchObject({
      capture: RESIDUE,
      paneDead: true,
      currentCommand: "bash",
      activityAgeSec: 60,
      sessionUp: true,
      windowPresent: true,
    });
  });

  test("a failed probe leaves a null clock rather than failing the read", async () => {
    const h = harness({ captures: [RESIDUE], probeThrows: true });
    const obs = await observePane({
      tmux: h.deps.tmux?.("/tmp/s") as TmuxNamespace,
      target: `${SESSION}:${WINDOW}`,
      team: TEAM_NAME,
      member: "be-1",
      windowName: WINDOW,
      nowSec: 1_786_800_060,
    });
    expect(obs.activityAgeSec).toBeNull();
    expect(obs.capture).toBe(RESIDUE);
  });

  test("a failed capture yields a null capture, which classifies as unreadable", async () => {
    const h = harness({ captures: [], captureThrows: true });
    const obs = await observePane({
      tmux: h.deps.tmux?.("/tmp/s") as TmuxNamespace,
      target: `${SESSION}:${WINDOW}`,
      team: TEAM_NAME,
      member: "be-1",
      windowName: WINDOW,
      nowSec: 1_786_800_060,
    });
    expect(obs.capture).toBeNull();
  });
});

// ---------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------

describe("defaults", () => {
  test("the settle window is short but non-zero", () => {
    expect(NUDGE_SETTLE_MS_DEFAULT).toBeGreaterThan(0);
    expect(NUDGE_SETTLE_MS_DEFAULT).toBeLessThanOrEqual(5_000);
  });

  test("the default tmux factory pins the socket it is handed", () => {
    const ns = defaultNudgeTmux("/tmp/atmux-nudge-probe/sock");
    expect(typeof ns.pane.capturePane).toBe("function");
    expect(typeof ns.window.listWindows).toBe("function");
  });

  test("the capture depth matches the fleet sweep's, so both classifiers see the same evidence", async () => {
    const { CAPTURE_LINES } = await import("../../../src/verbs/fleet.ts");
    expect(NUDGE_CAPTURE_LINES).toBe(CAPTURE_LINES);
  });
});
