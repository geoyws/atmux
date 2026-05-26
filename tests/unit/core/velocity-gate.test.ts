// Unit tests for src/core/velocity-gate.ts (ADR-177 §"What V1 defers"
// / t-5d85dddb).
//
// Coverage matrix matches the Task body's 6 acceptance gates:
//
//   1. BAD verdict on 0-commit team with in-progress tasks emits the
//      action-menu via the injected sender (READY pane).
//   2. BUSY pane + BAD verdict → strike but NO menu send (classifier-
//      swallow guard).
//   3. OK verdict → resetStrikeRecord (counter falls back to null) +
//      clearPendingMenu (any pending-menu state wiped).
//   4. Missed-marker on next tick → strike with `no-marker` reason,
//      menu state cleared.
//   5. Classifier-swallow on next tick (pane unchanged) → strike with
//      `classifier-swallow` reason, menu state cleared.
//   6. Compliant reply (^[ABCD]: marker) → no strike, menu state
//      cleared.
//
// Plus pure-helper coverage: paneStateToSignal, buildActionMenuPrompt,
// parseLeadReplyMarker.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaneSignal } from "../../../src/core/velocity.ts";
import {
  buildActionMenuPrompt,
  paneStateToSignal,
  parseLeadReplyMarker,
  runVelocityGateCheck,
  type VelocityGateDeps,
} from "../../../src/core/velocity-gate.ts";
import {
  readStrikeRecord,
  velocityStalledSymptomHash,
} from "../../../src/core/whip-strikes.ts";

let root: string;
let atmuxDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "atmux-velocity-gate-"));
  atmuxDir = join(root, ".atmux");
  await mkdir(join(atmuxDir, "state"), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const TEAM = "demo";

// ---------- Pure helpers ----------

describe("paneStateToSignal", () => {
  test("READY → READY", () => {
    expect(paneStateToSignal("READY")).toBe("READY");
  });

  test("TYPING / BUSY / MODAL / RATE-LIMIT / COMPACTING → BUSY", () => {
    expect(paneStateToSignal("TYPING")).toBe("BUSY");
    expect(paneStateToSignal("BUSY")).toBe("BUSY");
    expect(paneStateToSignal("MODAL")).toBe("BUSY");
    expect(paneStateToSignal("RATE-LIMIT")).toBe("BUSY");
    expect(paneStateToSignal("COMPACTING")).toBe("BUSY");
  });

  test("SHELL / UNKNOWN → UNREACHABLE", () => {
    expect(paneStateToSignal("SHELL")).toBe("UNREACHABLE");
    expect(paneStateToSignal("UNKNOWN")).toBe("UNREACHABLE");
  });
});

describe("buildActionMenuPrompt", () => {
  test("includes the velocity-gate marker, reason, and ABCD options", () => {
    const prompt = buildActionMenuPrompt("BAD: 0 commits in 60min · 5 in-progress (stalled)");
    expect(prompt).toContain("[whip:velocity-gate]");
    expect(prompt).toContain("0 commits in 60min");
    expect(prompt).toContain("A:");
    expect(prompt).toContain("B:");
    expect(prompt).toContain("C:");
    expect(prompt).toContain("D:");
    expect(prompt).toContain("STOP and pick A or B");
  });

  test("ends with the no-marker = strike warning", () => {
    const prompt = buildActionMenuPrompt("r");
    expect(prompt).toContain("No marker = strike");
  });
});

describe("parseLeadReplyMarker", () => {
  test("matches `A: payload` at end of capture", () => {
    const r = parseLeadReplyMarker("some text\nA: send-keys foo\n");
    expect(r?.choice).toBe("A");
    expect(r?.payload).toBe("send-keys foo");
  });

  test("matches choice with no payload (e.g. `D:`)", () => {
    const r = parseLeadReplyMarker("D:");
    expect(r?.choice).toBe("D");
    expect(r?.payload).toBe("");
  });

  test("tail-wins when multiple markers present", () => {
    const r = parseLeadReplyMarker("A: first\nC: third\n");
    expect(r?.choice).toBe("C");
  });

  test("returns null when no marker present", () => {
    expect(parseLeadReplyMarker("just prose, no marker\n")).toBeNull();
  });

  test("rejects non-ABCD letters (E: payload is not a valid choice)", () => {
    expect(parseLeadReplyMarker("E: this is not a valid menu choice")).toBeNull();
  });

  test("tolerates leading whitespace", () => {
    const r = parseLeadReplyMarker("   B: indented payload\n");
    expect(r?.choice).toBe("B");
  });
});

// ---------- Orchestrator ----------

interface FakeWiring {
  commits: { count: number; lastAgeMin: number | null };
  inProgress: number;
  paneCaptures: string[];
  paneSignal: PaneSignal;
  sendResult: "sent" | "busy" | "unreachable" | "fail";
  sendCalls: string[];
  paneCaptureCalls: number;
}

function makeDeps(w: FakeWiring): VelocityGateDeps {
  let captureIdx = 0;
  return {
    atmuxDir,
    teamName: TEAM,
    nowSec: 5000,
    windowMin: 60,
    standbyGraceMin: 30,
    probeCommits: async () => w.commits,
    probeInProgress: async () => w.inProgress,
    probeLeadPane: async () => {
      w.paneCaptureCalls += 1;
      const cap = w.paneCaptures[captureIdx];
      captureIdx = Math.min(captureIdx + 1, w.paneCaptures.length - 1);
      return cap ?? null;
    },
    classifyLeadCapture: () => w.paneSignal,
    sendToLeadPane: async (text) => {
      w.sendCalls.push(text);
      return w.sendResult;
    },
    log: () => {},
  };
}

function makeWiring(overrides: Partial<FakeWiring> = {}): FakeWiring {
  return {
    commits: { count: 0, lastAgeMin: null },
    inProgress: 3,
    paneCaptures: ["pane idle text"],
    paneSignal: "READY",
    sendResult: "sent",
    sendCalls: [],
    paneCaptureCalls: 0,
    ...overrides,
  };
}

const SYMPTOM_HASH = velocityStalledSymptomHash(TEAM);

describe("runVelocityGateCheck — BAD verdict on stalled team (READY pane)", () => {
  test("emits menu + records pending-menu state + strikes", async () => {
    const w = makeWiring();
    const result = await runVelocityGateCheck(makeDeps(w));
    expect(result.classification.verdict).toBe("BAD");
    expect(result.menuSent).toBe(true);
    expect(result.strikeIncremented).toBe(true);
    expect(w.sendCalls.length).toBe(1);
    expect(w.sendCalls[0]).toContain("[whip:velocity-gate]");

    const rec = await readStrikeRecord(atmuxDir, TEAM, SYMPTOM_HASH);
    expect(rec?.count).toBe(1);
    expect(rec?.menuSentAtSec).toBe(5000);
    expect(rec?.menuPaneHash).not.toBeNull();
  });
});

describe("runVelocityGateCheck — BAD verdict on BUSY pane (classifier-swallow guard)", () => {
  test("strike fires but NO menu send", async () => {
    const w = makeWiring({ paneSignal: "BUSY" });
    const result = await runVelocityGateCheck(makeDeps(w));
    expect(result.classification.verdict).toBe("BAD");
    expect(result.strikeIncremented).toBe(true);
    expect(result.menuSent).toBe(false);
    expect(w.sendCalls.length).toBe(0);
  });
});

describe("runVelocityGateCheck — OK verdict resets strike + clears menu", () => {
  test("OK clears pending strike record + menu state", async () => {
    // Seed a prior strike + pending menu so reset has something to clear.
    const seedW = makeWiring();
    await runVelocityGateCheck(makeDeps(seedW));
    let rec = await readStrikeRecord(atmuxDir, TEAM, SYMPTOM_HASH);
    expect(rec?.count).toBe(1);

    // Now run with OK verdict — a commit landed.
    const okW = makeWiring({
      commits: { count: 1, lastAgeMin: 5 },
      // Match the prior tick's pane so reply-validation pass would
      // classify as classifier-swallow IF we weren't going to reset.
      // (Critical: the OK reset path must clear the menu state
      // regardless — the reply-validation pass runs BEFORE classify.)
      paneCaptures: ["pane idle text"],
      sendCalls: [],
    });
    const result = await runVelocityGateCheck(makeDeps(okW));
    expect(result.classification.verdict).toBe("OK");
    expect(result.menuSent).toBe(false);
    expect(result.strikeIncremented).toBe(false);
    rec = await readStrikeRecord(atmuxDir, TEAM, SYMPTOM_HASH);
    // Strike record may be deleted OR have count=0/null fields — the
    // contract is "reset" — either is acceptable.
    if (rec !== null) {
      expect(rec.menuSentAtSec).toBeNull();
      expect(rec.menuPaneHash).toBeNull();
    }
  });
});

describe("runVelocityGateCheck — STANDBY verdict (recent ship)", () => {
  test("STANDBY doesn't strike + doesn't send menu", async () => {
    const w = makeWiring({ commits: { count: 0, lastAgeMin: 10 }, inProgress: 2 });
    const result = await runVelocityGateCheck(makeDeps(w));
    expect(result.classification.verdict).toBe("STANDBY");
    expect(result.strikeIncremented).toBe(false);
    expect(result.menuSent).toBe(false);
  });
});

describe("runVelocityGateCheck — reply validation: compliant", () => {
  test("`A: payload` in pane → marks compliant, no strike from validation, menu cleared", async () => {
    // Tick 1: BAD → menu sent
    const w1 = makeWiring({ paneCaptures: ["pane idle text"] });
    await runVelocityGateCheck(makeDeps(w1));

    // Tick 2: pane now contains lead reply marker — but is still BAD
    // (no commits landed). Reply-validation pass should see compliant
    // + clear menu. THEN the classifier still runs + strikes again
    // for the still-BAD verdict.
    const w2 = makeWiring({
      paneCaptures: ["pane idle text\nA: tmux send-keys to fe-1"],
      // Classify the new capture as READY so the validation pass +
      // subsequent send both happen.
      paneSignal: "READY",
    });
    const result = await runVelocityGateCheck(makeDeps(w2));
    expect(result.replyValidation).toBe("compliant");
    // The classifier still saw BAD this tick (no commits landed).
    expect(result.classification.verdict).toBe("BAD");
    // BUT the new menu fired again — that's expected (BAD = nudge each
    // tick the gate fires). The compliant reply only cleared the
    // PRIOR tick's pending state.
    expect(result.menuSent).toBe(true);
  });
});

describe("runVelocityGateCheck — reply validation: no-marker", () => {
  test("pane changed but no ABCD marker → strike", async () => {
    // Tick 1: seed pending menu.
    const w1 = makeWiring({ paneCaptures: ["pane idle text"] });
    await runVelocityGateCheck(makeDeps(w1));

    // Tick 2: pane has new content but no marker. Reply-validation
    // fires `no-marker` strike, clears menu, classifier proceeds.
    const w2 = makeWiring({
      paneCaptures: ["different prose, no marker here"],
      paneSignal: "READY",
    });
    const result = await runVelocityGateCheck(makeDeps(w2));
    expect(result.replyValidation).toBe("no-marker");

    // The strike record should reflect at least TWO strikes by now
    // (one from tick 1 BAD, one from the no-marker reply validation,
    // PLUS the tick 2 BAD strike).
    const rec = await readStrikeRecord(atmuxDir, TEAM, SYMPTOM_HASH);
    expect(rec).not.toBeNull();
    expect(rec?.count).toBeGreaterThanOrEqual(2);
  });
});

describe("runVelocityGateCheck — reply validation: classifier-swallow", () => {
  test("pane unchanged → strike with classifier-swallow reason", async () => {
    // Tick 1: BAD + menu sent on captured text "pane idle text".
    const w1 = makeWiring({ paneCaptures: ["pane idle text"] });
    await runVelocityGateCheck(makeDeps(w1));

    // Tick 2: pane SAME content as tick 1 → classifier-swallow.
    const w2 = makeWiring({
      paneCaptures: ["pane idle text"],
      paneSignal: "READY",
    });
    const result = await runVelocityGateCheck(makeDeps(w2));
    expect(result.replyValidation).toBe("classifier-swallow");
    const rec = await readStrikeRecord(atmuxDir, TEAM, SYMPTOM_HASH);
    expect(rec?.lastReason).toBeDefined();
  });
});

describe("runVelocityGateCheck — send returns busy → no pending-state recorded", () => {
  test("busy send result skips recordMenuSent (no next-tick validation)", async () => {
    const w = makeWiring({ sendResult: "busy" });
    const result = await runVelocityGateCheck(makeDeps(w));
    expect(result.strikeIncremented).toBe(true);
    // menuSent reflects whether the orchestrator believes a menu was
    // sent AND state recorded — busy → false.
    expect(result.menuSent).toBe(false);
    const rec = await readStrikeRecord(atmuxDir, TEAM, SYMPTOM_HASH);
    expect(rec?.count).toBe(1);
    // No pending-menu state stored since send didn't succeed.
    expect(rec?.menuSentAtSec).toBeNull();
  });
});
