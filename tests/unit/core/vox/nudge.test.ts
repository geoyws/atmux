// Unit tests for src/core/vox/nudge.ts — ADR-273 D4/D5.
//
// What these pin, and why each matters:
//
//   - The allow-list is a CLOSED, in-code table. `pane_nudge` shipping
//     without ADR-273 OQ-1 rests entirely on there being no free-text
//     path; a test that only checked "submit works" would not notice one
//     appearing.
//   - The confirm preview names the exact TARGET and the exact ACTION.
//     The failure D4 guards is a misheard member name nudging the wrong
//     agent, which a generic preview would not surface.
//   - `classifyAfterNudge` refuses the survey classifier's
//     fresh-residue-is-someone-typing exemption. That exemption is right
//     for a sweep and would make a failed nudge report "idle and clear",
//     i.e. announce success for a failure. This is THE lie D5 warns
//     about, so it gets its own test driving the exact fixture that
//     produces it.
//   - The outcome sentence is derived from before/after evidence only,
//     never from the fact that a send was issued.

import { describe, expect, test } from "bun:test";
import type { PaneObservation, PaneVerdict } from "../../../../src/core/vox/fleet.ts";
import {
  classifyAfterNudge,
  describeVerdict,
  isNudgeAction,
  NUDGE_ACTION_SPECS,
  NUDGE_ACTIONS,
  type NudgeReceipt,
  nudgeConfirmPreview,
  nudgeDidNotTake,
  nudgeOutcomeLine,
  renderNudgeReceipt,
} from "../../../../src/core/vox/nudge.ts";

/** Claude Code chrome — without it every capture classifies as
 *  `unresponsive` (the fleet classifier's positive-evidence rule). */
const CHROME = "  ⏵⏵ auto mode on (shift+tab to cycle)\n  tok 12/900000";

/** A composer holding text nobody submitted — the wedge fixture. */
const RESIDUE = `${CHROME}\n❯ claim --next`;

/** The same pane after a successful submit: composer clear. */
const CLEARED = `${CHROME}\n❯ `;

/** A pane with a live turn in flight. */
const WORKING = `${CHROME}\n✻ Cooking… (12s · esc to interrupt)`;

function obs(over: Partial<PaneObservation> = {}): PaneObservation {
  return {
    team: "atmux",
    member: "be-1",
    windowName: "be-1",
    sessionUp: true,
    windowPresent: true,
    capture: CHROME,
    paneDead: false,
    currentCommand: "claude",
    activityAgeSec: 1,
    ...over,
  };
}

const RESIDUE_VERDICT: PaneVerdict = {
  bucket: "attention",
  kind: "idle-residue",
  marker: "unsubmitted: claim --next",
};

// ---------------------------------------------------------------------
// The allow-list
// ---------------------------------------------------------------------

describe("the action allow-list is closed and in-code (ADR-273 D4)", () => {
  test("exactly two actions, in a stable order", () => {
    expect(NUDGE_ACTIONS).toEqual(["submit", "continue"]);
  });

  test("every action has a spec, and every spec's text is a CONSTANT or null", () => {
    for (const a of NUDGE_ACTIONS) {
      const spec = NUDGE_ACTION_SPECS[a];
      expect(spec).toBeDefined();
      expect(spec.text === null || typeof spec.text === "string").toBe(true);
      expect(spec.preview.length).toBeGreaterThan(0);
      expect(spec.did.length).toBeGreaterThan(0);
      expect(spec.answers.length).toBeGreaterThan(0);
    }
  });

  test("submit pastes NOTHING — the wedge case cannot be corrupted by the fix", () => {
    // If this ever became a string, `submit` would concatenate onto the
    // residue it is meant to submit and the pane would run a garbled
    // command. That is the single most damaging regression this tool has.
    expect(NUDGE_ACTION_SPECS.submit.text).toBeNull();
  });

  test("continue's canned text is exactly one word — no free text got in", () => {
    expect(NUDGE_ACTION_SPECS.continue.text).toBe("continue");
    expect((NUDGE_ACTION_SPECS.continue.text ?? "").split(/\s+/)).toHaveLength(1);
  });

  test("no spec's text is longer than a single short word", () => {
    // A blanket bound: an allow-list entry carrying a sentence is a
    // free-text hatch wearing a table's clothes.
    for (const a of NUDGE_ACTIONS) {
      const t = NUDGE_ACTION_SPECS[a].text;
      if (t === null) continue;
      expect(t.length).toBeLessThanOrEqual(16);
      expect(t).not.toContain(" ");
    }
  });

  test("isNudgeAction accepts the allow-list and rejects everything else", () => {
    expect(isNudgeAction("submit")).toBe(true);
    expect(isNudgeAction("continue")).toBe(true);
    expect(isNudgeAction("rm -rf /")).toBe(false);
    expect(isNudgeAction("")).toBe(false);
    expect(isNudgeAction("Submit")).toBe(false);
  });
});

// ---------------------------------------------------------------------
// Confirm preview (ADR-272 D7 / ADR-273 D4)
// ---------------------------------------------------------------------

describe("nudgeConfirmPreview", () => {
  test("names the team, the member and the action — all three", () => {
    const line = nudgeConfirmPreview({ member: "be-1", action: "submit" }, "atmux");
    expect(line).toContain("be-1");
    expect(line).toContain("atmux");
    expect(line).toContain("press Enter");
    expect(line).toContain("nothing is typed");
    expect(line.endsWith("Say yes to proceed.")).toBe(true);
  });

  test("the continue preview quotes the exact word that will be typed", () => {
    const line = nudgeConfirmPreview({ member: "fe-2", action: "continue" }, "unum");
    expect(line).toContain('"continue"');
    expect(line).toContain("fe-2");
    expect(line).toContain("unum");
  });

  test("submit and continue previews are DIFFERENT — the action is audible", () => {
    // A preview that read the same for both would let the operator
    // confirm a paste believing he had confirmed a keystroke.
    expect(nudgeConfirmPreview({ member: "be-1", action: "submit" }, "atmux")).not.toBe(
      nudgeConfirmPreview({ member: "be-1", action: "continue" }, "atmux"),
    );
  });

  test("a different member yields a different preview (the misheard-name case)", () => {
    expect(nudgeConfirmPreview({ member: "be-1", action: "submit" }, "atmux")).not.toBe(
      nudgeConfirmPreview({ member: "be-2", action: "submit" }, "atmux"),
    );
  });

  test("no team resolved → still names the member rather than going vague", () => {
    expect(nudgeConfirmPreview({ member: "be-1", action: "submit" }, null)).toContain(
      "member be-1",
    );
  });

  test("degrades instead of throwing on malformed args (a throw would strand the tool turn)", () => {
    const line = nudgeConfirmPreview({ member: 7, action: 9 }, "atmux");
    expect(line).toContain("unnamed");
    expect(line).toContain("press Enter");
  });

  test("an out-of-allow-list action name falls back to submit's wording", () => {
    expect(nudgeConfirmPreview({ member: "be-1", action: "nuke" }, "atmux")).toBe(
      nudgeConfirmPreview({ member: "be-1", action: "submit" }, "atmux"),
    );
  });
});

// ---------------------------------------------------------------------
// After-state classification — the anti-lie
// ---------------------------------------------------------------------

describe("classifyAfterNudge (ADR-273 D5 — the survey classifier is NOT reused verbatim)", () => {
  test("residue STILL in the composer reads as idle-residue even though activity is 1s old", () => {
    // This is the whole point. `classifyPaneObservation` would call this
    // pane `quiet: idle` because the window was active within
    // RESIDUE_FRESH_SEC — which here is our own paste, not a human
    // typing. If this test went green on `quiet`, the tool would report
    // "idle and clear" for a nudge that changed nothing.
    const v = classifyAfterNudge(obs({ capture: RESIDUE, activityAgeSec: 1 }));
    expect(v.bucket).toBe("attention");
    expect(v.kind).toBe("idle-residue");
    if (v.bucket === "attention") expect(v.marker).toContain("still unsubmitted: claim --next");
  });

  test("...and the bare survey classifier really does disagree (the bug is real, not hypothetical)", async () => {
    const { classifyPaneObservation } = await import("../../../../src/core/vox/fleet.ts");
    const survey = classifyPaneObservation(obs({ capture: RESIDUE, activityAgeSec: 1 }));
    expect(survey).toEqual({ bucket: "quiet", kind: "idle" });
  });

  test("a cleared composer reads as quiet — the override does not fire on success", () => {
    expect(classifyAfterNudge(obs({ capture: CLEARED, activityAgeSec: 1 }))).toEqual({
      bucket: "quiet",
      kind: "idle",
    });
  });

  test("a working pane is left alone — the override never demotes a live turn", () => {
    expect(classifyAfterNudge(obs({ capture: WORKING, activityAgeSec: 1 }))).toEqual({
      bucket: "quiet",
      kind: "working",
    });
  });

  test("an attention verdict passes through untouched", () => {
    const v = classifyAfterNudge(obs({ capture: `${CHROME}\nYou've hit your usage limit` }));
    expect(v.kind).toBe("rate-limited");
  });

  test("a null capture passes through as unreadable rather than being re-judged", () => {
    const v = classifyAfterNudge(obs({ capture: null }));
    expect(v).toEqual({ bucket: "attention", kind: "unreadable", marker: "pane capture failed" });
  });

  test("a long residue line is capped so the receipt stays speakable", () => {
    const long = "x".repeat(300);
    const v = classifyAfterNudge(obs({ capture: `${CHROME}\n❯ ${long}`, activityAgeSec: 1 }));
    if (v.bucket !== "attention") throw new Error("expected an attention verdict");
    expect(v.marker.length).toBeLessThanOrEqual(70);
    expect(v.marker.endsWith("…")).toBe(true);
  });

  test("a starting pane (fresh token counter) is not re-read as residue", () => {
    const v = classifyAfterNudge(
      obs({ capture: "  ⏵⏵ auto mode on\n  ctx --\n❯ ", activityAgeSec: 1 }),
    );
    expect(v).toEqual({ bucket: "quiet", kind: "starting" });
  });
});

// ---------------------------------------------------------------------
// Verdict rendering
// ---------------------------------------------------------------------

describe("describeVerdict", () => {
  test("an attention verdict carries its evidence", () => {
    expect(describeVerdict(RESIDUE_VERDICT)).toBe(
      "idle with unsubmitted text — unsubmitted: claim --next",
    );
  });

  test("a quiet verdict is a plain label", () => {
    expect(describeVerdict({ bucket: "quiet", kind: "working" })).toBe("working");
    expect(describeVerdict({ bucket: "quiet", kind: "idle" })).toBe("idle and clear");
  });
});

describe("nudgeOutcomeLine — derived from evidence, never from 'a send was issued'", () => {
  test("residue → working: the composer cleared and the agent is working", () => {
    expect(nudgeOutcomeLine(RESIDUE_VERDICT, { bucket: "quiet", kind: "working" })).toBe(
      "the composer cleared and the agent is now working",
    );
  });

  test("residue → idle: the composer cleared, pane idle", () => {
    expect(nudgeOutcomeLine(RESIDUE_VERDICT, { bucket: "quiet", kind: "idle" })).toBe(
      "the composer cleared and the pane is now idle and clear",
    );
  });

  test("dormant → working: no false claim that a composer cleared", () => {
    const line = nudgeOutcomeLine(
      { bucket: "attention", kind: "dormant", marker: "no output for 2h" },
      { bucket: "quiet", kind: "working" },
    );
    expect(line).toBe("the agent is now working");
    expect(line).not.toContain("composer");
  });

  test("dormant → compacting: names the quiet class it actually landed in", () => {
    expect(
      nudgeOutcomeLine(
        { bucket: "attention", kind: "dormant", marker: "no output for 2h" },
        { bucket: "quiet", kind: "compacting" },
      ),
    ).toBe("the pane is now compacting");
  });

  test("UNCHANGED is a reachable, spoken outcome — the nudge did not take", () => {
    expect(
      nudgeOutcomeLine(RESIDUE_VERDICT, { ...RESIDUE_VERDICT, marker: "different marker" }),
    ).toBe("the pane is unchanged — the nudge did not take");
  });

  test("moved into a DIFFERENT problem is reported as still needing you", () => {
    expect(
      nudgeOutcomeLine(RESIDUE_VERDICT, {
        bucket: "attention",
        kind: "permission-prompt",
        marker: "Do you want Claude to",
      }),
    ).toBe("the pane moved but still needs you — now waiting on a permission prompt");
  });

  test("quiet → quiet of a different kind still counts as movement", () => {
    expect(
      nudgeOutcomeLine({ bucket: "quiet", kind: "idle" }, { bucket: "quiet", kind: "working" }),
    ).toBe("the agent is now working");
  });
});

describe("nudgeDidNotTake", () => {
  const base: NudgeReceipt = {
    team: "atmux",
    member: "be-1",
    windowName: "be-1",
    action: "submit",
    before: RESIDUE_VERDICT,
    after: RESIDUE_VERDICT,
  };

  test("true when the classified state is identical", () => {
    expect(nudgeDidNotTake(base)).toBe(true);
  });

  test("false once the pane moved", () => {
    expect(nudgeDidNotTake({ ...base, after: { bucket: "quiet", kind: "working" } })).toBe(false);
  });

  test("marker text alone does not count as movement", () => {
    // Two captures of the same wedged pane rarely match byte-for-byte;
    // comparing markers would make every failed nudge read as success.
    expect(
      nudgeDidNotTake({ ...base, after: { ...RESIDUE_VERDICT, marker: "unsubmitted: claim" } }),
    ).toBe(true);
  });
});

describe("renderNudgeReceipt", () => {
  const receipt: NudgeReceipt = {
    team: "atmux",
    member: "be-1",
    windowName: "⚙be-1",
    action: "submit",
    before: RESIDUE_VERDICT,
    after: { bucket: "quiet", kind: "working" },
  };

  test("four lines: what was done, before, after, and the verdict", () => {
    expect(renderNudgeReceipt(receipt)).toBe(
      [
        "NUDGE atmux/be-1 (window ⚙be-1) — pressed Enter to submit what was already in the composer",
        "before: idle with unsubmitted text — unsubmitted: claim --next",
        "after: working",
        "the composer cleared and the agent is now working",
      ].join("\n"),
    );
  });

  test("names the tmux WINDOW, not only the member — the resolution is evidence too", () => {
    expect(renderNudgeReceipt(receipt)).toContain("(window ⚙be-1)");
  });

  test("a failed nudge renders the failure, not a success line", () => {
    const failed = renderNudgeReceipt({ ...receipt, after: RESIDUE_VERDICT });
    expect(failed).toContain("the pane is unchanged — the nudge did not take");
    expect(failed).not.toContain("now working");
  });

  test("the continue action says what it typed", () => {
    expect(renderNudgeReceipt({ ...receipt, action: "continue" })).toContain(
      'typed "continue" and submitted it',
    );
  });
});
