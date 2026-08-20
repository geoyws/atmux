// The cage-state assertions. These are the gate the mutating scenarios
// are actually decided by, so the tests here are written the same way the
// module is: every builder is driven to BOTH verdicts, and the vacuous
// cases — a pane that keeps no receipt, a pane that is not in the cage —
// are pinned as FAILURES rather than left to pass quietly.

import { describe, expect, test } from "bun:test";
import type { TmuxNamespace } from "../../../../../src/abstractions/tmux.ts";
import {
  atMostRedeems,
  awaitEnters,
  type CageProbe,
  capturePaneTail,
  confirmRoundTrip,
  countEnters,
  countToolCalls,
  ENTER_SETTLE_MS,
  entersDelivered,
  formatPostconditions,
  isRedeemAttempt,
  locatePane,
  type Postcondition,
  type PostconditionContext,
  paneTailMatches,
  runPostconditions,
  teamFileMatches,
} from "../../../../../src/core/vox/e2e/assertions.ts";
import { buildCagePlan } from "../../../../../src/core/vox/e2e/cage.ts";
import type { DriveResult, ToolCall } from "../../../../../src/core/vox/e2e/drive.ts";
import { MUTATION_FIXTURES } from "../../../../../src/core/vox/e2e/fixtures.ts";

const TEMP = "/tmp/atmux-vox-e2e-assert";
const TEAM = "vox-e2e-bravo";
const PLAN = buildCagePlan({ tempRoot: TEMP, uid: 1000, fixtures: MUTATION_FIXTURES });

function ctx(
  over: {
    files?: Record<string, string>;
    capture?: string | (() => string);
    captureThrows?: boolean;
    drive?: DriveResult | null;
  } = {},
): PostconditionContext {
  const files = new Map(Object.entries(over.files ?? {}));
  return {
    plan: PLAN,
    readFile: async (p) => files.get(p) ?? null,
    sleep: async () => {},
    tmux: () =>
      ({
        pane: {
          capturePane: async () => {
            if (over.captureThrows === true) throw new Error("no such window");
            const c = over.capture;
            return typeof c === "function" ? c() : (c ?? "");
          },
        },
      }) as unknown as TmuxNamespace,
    drive: over.drive ?? null,
  };
}

const receipt = (member: string): string => `${TEMP}/panes/${TEAM}/${member}.enters`;

function drive(tools: Array<Partial<ToolCall>>): DriveResult {
  const full: ToolCall[] = tools.map((t, i) => ({
    id: String(i),
    name: t.name ?? "pane_nudge",
    args: t.args ?? "{}",
    ok: null,
    summary: null,
    ms: null,
  }));
  return {
    ok: true,
    ready: {},
    transcript: "",
    tools: full,
    toolNames: full.map((t) => t.name),
    frameTypes: [],
    uplinkFrames: 0,
    downlinkFrames: 0,
    downlinkBytes: 0,
    errors: [],
    closeCode: 1000,
    failure: null,
  };
}

describe("locatePane", () => {
  test("finds a pane by team and member", () => {
    expect(locatePane(PLAN, TEAM, "be-1")?.pane.member).toBe("be-1");
  });

  test("returns null for an unknown team", () => {
    expect(locatePane(PLAN, "vox-e2e-nope", "be-1")).toBeNull();
  });

  test("returns null for an unknown member", () => {
    expect(locatePane(PLAN, TEAM, "nope")).toBeNull();
  });
});

describe("countEnters", () => {
  const located = locatePane(PLAN, TEAM, "be-1") as NonNullable<ReturnType<typeof locatePane>>;

  test("an absent receipt is zero — the pane only ever appends", async () => {
    expect(await countEnters(ctx(), located)).toBe(0);
  });

  test("counts one line per Enter consumed", async () => {
    const c = ctx({ files: { [receipt("be-1")]: "enter\nenter\n" } });
    expect(await countEnters(c, located)).toBe(2);
  });

  test("ignores blank lines so a trailing newline is not an extra Enter", async () => {
    const c = ctx({ files: { [receipt("be-1")]: "enter\n\n  \n" } });
    expect(await countEnters(c, located)).toBe(1);
  });

  test("a pane with no receipt path answers null, NOT zero", async () => {
    // The distinction the negative assertions depend on: "nothing arrived"
    // and "this pane could never have told you" are different facts.
    const lead = locatePane(PLAN, TEAM, "lead") as NonNullable<ReturnType<typeof locatePane>>;
    expect(await countEnters(ctx(), lead)).toBeNull();
  });
});

describe("awaitEnters — the polling asymmetry", () => {
  const located = locatePane(PLAN, TEAM, "be-1") as NonNullable<ReturnType<typeof locatePane>>;

  test("settles before reading", async () => {
    const slept: number[] = [];
    const c = { ...ctx(), sleep: async (ms: number) => void slept.push(ms) };
    await awaitEnters(c, located, 0);
    expect(slept[0]).toBe(ENTER_SETTLE_MS);
  });

  test("polls until an EXPECTED Enter shows up", async () => {
    let reads = 0;
    const c: CageProbe = {
      ...ctx(),
      sleep: async () => {},
      readFile: async () => {
        reads += 1;
        return reads >= 3 ? "enter\n" : null;
      },
    };
    expect(await awaitEnters(c, located, 1)).toBe(1);
  });

  test("does NOT poll when zero is expected — it reads once and reports what it saw", async () => {
    // Polling a negative until it came back right would be a way of
    // giving a real delivery time to be missed.
    let reads = 0;
    const c: CageProbe = {
      ...ctx(),
      sleep: async () => {},
      readFile: async () => {
        reads += 1;
        return "enter\n";
      },
    };
    expect(await awaitEnters(c, located, 0)).toBe(1);
    expect(reads).toBe(1);
  });

  test("gives up at the poll deadline rather than hanging", async () => {
    let t = 0;
    const c: CageProbe = { ...ctx(), sleep: async () => {}, readFile: async () => null };
    expect(
      await awaitEnters(c, located, 1, () => {
        t += 1_000;
        return t;
      }),
    ).toBe(0);
  });

  test("a receipt-less pane short-circuits to null even when Enters are expected", async () => {
    const lead = locatePane(PLAN, TEAM, "lead") as NonNullable<ReturnType<typeof locatePane>>;
    expect(await awaitEnters(ctx(), lead, 1)).toBeNull();
  });

  test("a receipt that vanishes mid-poll reports null rather than a count", async () => {
    const located2 = locatePane(PLAN, TEAM, "be-2") as NonNullable<ReturnType<typeof locatePane>>;
    let reads = 0;
    const c: CageProbe = {
      ...ctx(),
      sleep: async () => {},
      readFile: async () => {
        reads += 1;
        return reads === 1 ? "" : null;
      },
    };
    // First read yields 0 (< expected), so it polls; the pane's receipt
    // path is still non-null so the second read yields 0 again and the
    // loop runs to its deadline.
    let t = 0;
    expect(
      await awaitEnters(c, located2, 1, () => {
        t += 4_000;
        return t;
      }),
    ).toBe(0);
  });
});

describe("entersDelivered", () => {
  test("passes on the expected count and says what it saw", async () => {
    const r = await entersDelivered({ team: TEAM, member: "be-1", expected: 1 }).check(
      ctx({ files: { [receipt("be-1")]: "enter\n" } }),
    );
    expect(r.pass).toBe(true);
    expect(r.detail).toContain("consumed 1 Enter(s)");
  });

  test("FAILS when a decline still delivered a keystroke", async () => {
    // The failure this whole harness exists to catch: a confirmation gate
    // that fails open.
    const r = await entersDelivered({ team: TEAM, member: "be-1", expected: 0 }).check(
      ctx({ files: { [receipt("be-1")]: "enter\n" } }),
    );
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("expected 0");
  });

  test("FAILS on a pane that keeps no receipt rather than passing vacuously", async () => {
    const r = await entersDelivered({ team: TEAM, member: "lead", expected: 0 }).check(ctx());
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("could never observe an Enter");
  });

  test("FAILS on a pane that is not in this cage", async () => {
    const r = await entersDelivered({ team: TEAM, member: "ghost", expected: 0 }).check(ctx());
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("no pane");
  });
});

describe("paneTailMatches", () => {
  const blocked = "│ Do you want to make this edit?  │";

  test("passes when a pattern that must be present is present", async () => {
    const r = await paneTailMatches({
      team: TEAM,
      member: "be-1",
      pattern: /Do you want to make this edit\?/,
      present: true,
      what: "the prompt",
    }).check(ctx({ capture: blocked }));
    expect(r.pass).toBe(true);
    expect(r.detail).toContain("still shows");
  });

  test("passes when a pattern that must be gone is gone", async () => {
    const r = await paneTailMatches({
      team: TEAM,
      member: "be-1",
      pattern: /Do you want to make this edit\?/,
      present: false,
      what: "the prompt",
    }).check(ctx({ capture: "Edit accepted." }));
    expect(r.pass).toBe(true);
    expect(r.detail).toContain("does not show");
  });

  test("FAILS when the pane never moved", async () => {
    const r = await paneTailMatches({
      team: TEAM,
      member: "be-1",
      pattern: /Edit accepted/,
      present: true,
      what: "the repaint",
    }).check(ctx({ capture: blocked }));
    expect(r.pass).toBe(false);
  });

  test("FAILS — never silently passes — when the pane cannot be captured", async () => {
    const r = await paneTailMatches({
      team: TEAM,
      member: "be-1",
      pattern: /anything/,
      present: false,
      what: "x",
    }).check(ctx({ captureThrows: true }));
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("unreadable");
  });

  test("FAILS on a pane that is not in this cage", async () => {
    const r = await paneTailMatches({
      team: TEAM,
      member: "nope",
      pattern: /x/,
      present: true,
      what: "x",
    }).check(ctx());
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("no pane");
  });

  test("capturePaneTail strips ANSI before matching", async () => {
    const located = locatePane(PLAN, TEAM, "be-1") as NonNullable<ReturnType<typeof locatePane>>;
    const text = await capturePaneTail(ctx({ capture: "[31mred[0m" }), located);
    expect(text).toBe("red");
  });
});

describe("teamFileMatches", () => {
  const inbox = `${TEMP}/teams/${TEAM}/.atmux/driver-inbox.md`;

  test("passes when the file carries the word the operator asked to pass on", async () => {
    const r = await teamFileMatches({
      team: TEAM,
      relPath: ".atmux/driver-inbox.md",
      pattern: /rollback/i,
      what: "the word",
    }).check(ctx({ files: { [inbox]: "- 11:00 MYT the Rollback path needs review\n" } }));
    expect(r.pass).toBe(true);
    expect(r.detail).toContain("contains the word");
  });

  test("FAILS when the file exists but says something else, and quotes it", async () => {
    const r = await teamFileMatches({
      team: TEAM,
      relPath: ".atmux/driver-inbox.md",
      pattern: /rollback/i,
      what: "the word",
    }).check(ctx({ files: { [inbox]: "- 11:00 MYT unrelated\n" } }));
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("unrelated");
  });

  test("FAILS when nothing was written at all", async () => {
    const r = await teamFileMatches({
      team: TEAM,
      relPath: ".atmux/driver-inbox.md",
      pattern: /rollback/i,
      what: "the word",
    }).check(ctx());
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("nothing was written");
  });

  test("FAILS for a team not in this cage", async () => {
    const r = await teamFileMatches({
      team: "vox-e2e-nope",
      relPath: "x",
      pattern: /x/,
      what: "x",
    }).check(ctx());
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("no team");
  });

  // `expectMatches` is the arm that catches a MUTATION STORM, and it is
  // the reason the presence check above is not sufficient on its own: on
  // the 2026-08-17 run `tell_lead` succeeded, reported unparseable, and
  // the model retried 34 times — 34 real asks in the lead's inbox, with
  // the presence check green throughout. Both verdicts are pinned here so
  // the counting arm cannot rot into a second presence check.
  test("expectMatches passes when the ask landed EXACTLY the expected number of times", async () => {
    const r = await teamFileMatches({
      team: TEAM,
      relPath: ".atmux/driver-inbox.md",
      pattern: /rollback/i,
      what: "the ask, delivered ONCE",
      expectMatches: 1,
    }).check(ctx({ files: { [inbox]: "- 11:00 MYT the Rollback path needs review\n" } }));
    expect(r.pass).toBe(true);
    expect(r.detail).toContain("1 line(s)");
  });

  test("expectMatches FAILS on a retry storm the presence check would pass", async () => {
    const storm = "- 11:00 MYT the rollback path needs review\n".repeat(34);
    const opts = {
      team: TEAM,
      relPath: ".atmux/driver-inbox.md",
      pattern: /rollback/i,
      what: "the ask, delivered ONCE",
    } as const;
    // Presence alone is blind to it — this is the vacuity being guarded against.
    const presence = await teamFileMatches({ ...opts }).check(ctx({ files: { [inbox]: storm } }));
    expect(presence.pass).toBe(true);
    // Counting sees it.
    const counted = await teamFileMatches({ ...opts, expectMatches: 1 }).check(
      ctx({ files: { [inbox]: storm } }),
    );
    expect(counted.pass).toBe(false);
    expect(counted.detail).toContain("34 line(s)");
    expect(counted.detail).toContain("expected exactly 1");
  });

  test("the id records the count, so two postconditions on one file stay distinct", () => {
    expect(teamFileMatches({ team: TEAM, relPath: "a", pattern: /x/, what: "w" }).id).not.toBe(
      teamFileMatches({ team: TEAM, relPath: "a", pattern: /x/, what: "w", expectMatches: 1 }).id,
    );
  });
});

describe("tool-call evidence", () => {
  test("isRedeemAttempt spots a confirm_token in the argument preview", () => {
    expect(isRedeemAttempt('{"member":"be-1","confirm_token":"abc"}')).toBe(true);
    expect(isRedeemAttempt('{"member":"be-1"}')).toBe(false);
  });

  test("countToolCalls splits previews from redemptions and ignores other tools", () => {
    const d = drive([
      { name: "pane_nudge", args: '{"member":"be-1"}' },
      { name: "pane_nudge", args: '{"member":"be-1","confirm_token":"t"}' },
      { name: "fleet_attention", args: "{}" },
    ]);
    expect(countToolCalls(d, "pane_nudge")).toEqual({ previews: 1, redeems: 1 });
  });

  test("countToolCalls tolerates a null drive (a protocol scenario)", () => {
    expect(countToolCalls(null, "pane_nudge")).toEqual({ previews: 0, redeems: 0 });
  });

  test("confirmRoundTrip passes on the exact shape of a confirmed nudge", async () => {
    const d = drive([
      { args: '{"member":"be-1"}' },
      { args: '{"member":"be-1","confirm_token":"t"}' },
    ]);
    const r = await confirmRoundTrip({ tool: "pane_nudge", previews: 1, redeems: 1 }).check(
      ctx({ drive: d }),
    );
    expect(r.pass).toBe(true);
  });

  test("confirmRoundTrip FAILS when a decline redeemed anyway", async () => {
    const d = drive([
      { args: '{"member":"be-1"}' },
      { args: '{"member":"be-1","confirm_token":"t"}' },
    ]);
    const r = await confirmRoundTrip({ tool: "pane_nudge", previews: 1, redeems: 0 }).check(
      ctx({ drive: d }),
    );
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("expected 1 / 0");
  });

  test("atMostRedeems allows one refusal but not a retry", async () => {
    const one = drive([{ args: '{"confirm_token":"t"}' }]);
    const two = drive([{ args: '{"confirm_token":"t"}' }, { args: '{"confirm_token":"u"}' }]);
    expect(
      (await atMostRedeems({ tool: "pane_nudge", max: 1 }).check(ctx({ drive: one }))).pass,
    ).toBe(true);
    expect(
      (await atMostRedeems({ tool: "pane_nudge", max: 1 }).check(ctx({ drive: two }))).pass,
    ).toBe(false);
  });
});

describe("runPostconditions", () => {
  test("runs every condition, in order", async () => {
    const seen: string[] = [];
    const make = (id: string): Postcondition => ({
      id,
      check: async () => {
        seen.push(id);
        return { id, pass: true, detail: "" };
      },
    });
    const r = await runPostconditions([make("a"), make("b")], ctx());
    expect(seen).toEqual(["a", "b"]);
    expect(r.length).toBe(2);
  });

  test("a condition that THROWS is reported as that condition failing", async () => {
    // One broken assertion must not mask the others' results — least of
    // all in a run whose whole purpose is the other assertions.
    const boom: Postcondition = {
      id: "boom",
      check: () => Promise.reject(new Error("kaboom")),
    };
    const ok: Postcondition = {
      id: "ok",
      check: async () => ({ id: "ok", pass: true, detail: "" }),
    };
    const r = await runPostconditions([boom, ok], ctx());
    expect(r[0]?.pass).toBe(false);
    expect(r[0]?.detail).toContain("kaboom");
    expect(r[1]?.pass).toBe(true);
  });

  test("a non-Error rejection still reports rather than escaping", async () => {
    const boom: Postcondition = { id: "boom", check: () => Promise.reject("plain string") };
    const r = await runPostconditions([boom], ctx());
    expect(r[0]?.detail).toContain("plain string");
  });
});

describe("formatPostconditions", () => {
  test("prints the evidence for passes as well as failures", () => {
    // A negative assertion nobody can see the evidence for is a negative
    // assertion nobody should believe.
    const text = formatPostconditions([
      { id: "a", pass: true, detail: "consumed 0 Enter(s)" },
      { id: "b", pass: false, detail: "consumed 1 Enter(s)" },
    ]).join("\n");
    expect(text).toContain("[PASS] a");
    expect(text).toContain("consumed 0 Enter(s)");
    expect(text).toContain("[FAIL] b");
  });
});
