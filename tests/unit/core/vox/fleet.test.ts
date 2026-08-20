// Unit tests for src/core/vox/fleet.ts — ADR-273 D1/D2/D3 fleet triage.
//
// The classifier is the whole value of the feature, so it is tested
// against FIXTURES representing every attention class AND every quiet
// class, plus the three traps ADR-273 D3 names. Fixtures are real pane
// shapes (several lifted verbatim from the live fleet on 2026-08-15),
// not invented strings that happen to satisfy the regexes.
//
// The question asked of every test here: if the classifier were entirely
// broken — if it returned `idle` for everything — would this still pass?
// Each assertion below names a specific bucket AND its evidence, so no.

import { describe, expect, test } from "bun:test";
import {
  ACTIVE_TURN_RE,
  ATTENTION_CLASSES,
  ATTENTION_RANK,
  ATTENTION_REASON,
  ATTENTION_TOP_DEFAULT,
  ATTENTION_TOP_MAX,
  ATTENTION_TOP_MIN,
  buildVerdict,
  CHRONIC_CLASSES,
  CLASSIFY_TAIL_LINES,
  classifyPaneObservation,
  extractComposerResidue,
  type FleetSweep,
  FROZEN_ACTIVITY_SEC,
  findMarkerLine,
  formatAge,
  GROUP_MEMBERS_SPOKEN,
  groupAttention,
  type PaneObservation,
  QUIET_CLASSES,
  quietBreakdown,
  RESIDUE_FRESH_SEC,
  renderAttention,
  renderQuiet,
  renderUnreadable,
  SILENT_IDLE_SEC,
  paneVerdictGlyph,
  paneVerdictPhrase,
  QUIET_LABEL,
  summarizeRemainder,
  tailWindow,
} from "../../../../src/core/vox/fleet.ts";

// ---------------------------------------------------------------------
// Fixtures — real pane shapes.
// ---------------------------------------------------------------------

/** The Claude Code footer, verbatim from a live `aix` driver pane. */
const CLAUDE_FOOTER = [
  "  Fable 5 ·xhigh  │  ctx 34%  │  5h 12%  │  wk 4%  │  tok 21400/1000000",
  "  claude2@ifca.com.my max",
  "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
].join("\n");

/** A fresh pane's footer — token counter has never moved. */
const CLAUDE_FOOTER_FRESH = [
  "  Fable 5 ·xhigh  │  ctx --  │  5h -- · wk --  │  tok 0/0",
  "  geoyws@gmail.com max",
  "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
].join("\n");

function pane(over: Partial<PaneObservation> = {}): PaneObservation {
  return {
    team: "atmux",
    member: "be-1",
    windowName: "🔧-be-1",
    sessionUp: true,
    windowPresent: true,
    capture: `● Done.\n\n❯ \n${CLAUDE_FOOTER}`,
    paneDead: false,
    currentCommand: "claude",
    activityAgeSec: 12,
    ...over,
  };
}

// ---------------------------------------------------------------------
// Vocabulary invariants
// ---------------------------------------------------------------------

describe("vocabulary", () => {
  test("every attention class has a spoken reason and a distinct rank", () => {
    const ranks = new Set<number>();
    for (const c of ATTENTION_CLASSES) {
      expect(ATTENTION_REASON[c].length, `${c} has no reason`).toBeGreaterThan(0);
      expect(ranks.has(ATTENTION_RANK[c]), `${c} shares a rank`).toBe(false);
      ranks.add(ATTENTION_RANK[c]);
    }
    expect(ranks.size).toBe(ATTENTION_CLASSES.length);
  });

  test("permission-prompt outranks everything — a stopped agent waits forever", () => {
    for (const c of ATTENTION_CLASSES) {
      if (c === "permission-prompt") continue;
      expect(ATTENTION_RANK["permission-prompt"]).toBeLessThan(ATTENTION_RANK[c]);
    }
  });

  test("the chronic class ranks below every acute one", () => {
    for (const chronic of CHRONIC_CLASSES) {
      for (const c of ATTENTION_CLASSES) {
        if (CHRONIC_CLASSES.has(c) || c === "unreadable") continue;
        expect(
          ATTENTION_RANK[chronic],
          `${chronic} must not outrank the acute ${c}`,
        ).toBeGreaterThan(ATTENTION_RANK[c]);
      }
    }
  });

  test("the spoken budget bounds are the ADR-273 D2 numbers", () => {
    expect(ATTENTION_TOP_DEFAULT).toBe(5);
    expect(ATTENTION_TOP_MIN).toBe(1);
    expect(ATTENTION_TOP_MAX).toBe(15);
  });
});

// ---------------------------------------------------------------------
// TRAP 1 — a live team must never read as dead
// ---------------------------------------------------------------------

describe("TRAP 1 — dead requires the session to be absent, not merely unnamed", () => {
  test("sessionUp=false is the ONLY pane-text-independent route to `dead`", () => {
    const v = classifyPaneObservation(pane({ sessionUp: false }));
    expect(v).toEqual({ bucket: "attention", kind: "dead", marker: "tmux session absent" });
  });

  test("a healthy pane in a session the sweep RESOLVED is not dead", () => {
    // The trap-1 bug reported exactly this pane as down, because the
    // probe rebuilt `atmux-<team>` instead of reading the anchor. The
    // classifier's contract is that `sessionUp` is an INPUT it trusts —
    // the sweep owns resolving the name (see src/verbs/fleet.ts).
    expect(classifyPaneObservation(pane()).bucket).toBe("quiet");
  });

  test("a missing WINDOW is dead and names the window as its evidence", () => {
    const v = classifyPaneObservation(pane({ windowPresent: false, windowName: "🔧-be-9" }));
    expect(v).toEqual({
      bucket: "attention",
      kind: "dead",
      marker: "window 🔧-be-9 absent",
    });
  });

  test("a failed CAPTURE is `unreadable`, never `dead` — not-read is not not-there", () => {
    const v = classifyPaneObservation(pane({ capture: null }));
    expect(v).toEqual({
      bucket: "attention",
      kind: "unreadable",
      marker: "pane capture failed",
    });
  });
});

// ---------------------------------------------------------------------
// TRAP 2 — the wedge hiding inside the healthy class
// ---------------------------------------------------------------------

describe("TRAP 2 — a past-tense turn glyph must not mask composer residue", () => {
  const WEDGED = [
    "● Read(src/core/vox/fleet.ts)",
    "✻ Worked for 22s",
    "",
    "❯ claim --next --as be-1",
    CLAUDE_FOOTER,
  ].join("\n");

  test("the wedge fixture IS the trap: it carries a spinner glyph AND unsubmitted text", () => {
    // Guard on the fixture itself — if it stopped containing both halves
    // the test below would pass for the wrong reason.
    expect(WEDGED).toContain("✻ Worked for 22s");
    expect(extractComposerResidue(WEDGED)).toBe("claim --next --as be-1");
  });

  test("classified as idle-residue, NOT working — the whole point of the trap", () => {
    const v = classifyPaneObservation(pane({ capture: WEDGED, activityAgeSec: 900 }));
    expect(v.bucket).toBe("attention");
    expect(v.bucket === "attention" && v.kind).toBe("idle-residue");
    expect(v.bucket === "attention" && v.marker).toContain("claim --next --as be-1");
  });

  test("ACTIVE_TURN_RE rejects every past-tense marker that carries the glyph", () => {
    // The regexes that made this bug: `/✻\s+\w+/` in
    // src/core/pane-state.ts matches all four of these.
    for (const past of [
      "✻ Worked for 22s",
      "✻ Brewed for 1m 56s",
      "✽ Cooked for 12s",
      "✶ Honked for 3s",
    ]) {
      expect(ACTIVE_TURN_RE.test(past), `${past} read as an active turn`).toBe(false);
    }
  });

  test("ACTIVE_TURN_RE still fires on genuinely live markers", () => {
    for (const live of [
      "✻ Cogitating… (12s · ↑ 1.2k tokens · esc to interrupt)",
      "Brewing...",
      "Honking…",
      "… (45s)",
      "esc to interrupt",
    ]) {
      expect(ACTIVE_TURN_RE.test(live), `${live} did not read as an active turn`).toBe(true);
    }
  });

  test("a live turn WITH residue stays working — residue is only read once the turn is over", () => {
    const midTurn = ["✻ Cogitating… (12s · esc to interrupt)", "❯ next thing", CLAUDE_FOOTER].join(
      "\n",
    );
    expect(classifyPaneObservation(pane({ capture: midTurn, activityAgeSec: 2 }))).toEqual({
      bucket: "quiet",
      kind: "working",
    });
  });
});

// ---------------------------------------------------------------------
// TRAP 3 — silence is not health
// ---------------------------------------------------------------------

describe("TRAP 3a — the quiet bucket requires POSITIVE evidence of an agent", () => {
  test("a pane with no agent chrome is never quiet, even when nothing looks wrong", () => {
    const v = classifyPaneObservation(
      pane({ capture: "some stray output\nnothing else here\n", currentCommand: "node" }),
    );
    expect(v.bucket).toBe("attention");
    expect(v.bucket === "attention" && v.kind).toBe("unresponsive");
  });

  test("a BLANK pane says so in its evidence", () => {
    const v = classifyPaneObservation(pane({ capture: "\n\n   \n", currentCommand: "node" }));
    expect(v).toEqual({
      bucket: "attention",
      kind: "unresponsive",
      marker: "pane is blank",
    });
  });

  test("no chrome + a shell command = crashed, and the command is the evidence", () => {
    const v = classifyPaneObservation(
      pane({
        capture: "  ~/work/src/atmux   atmux-geoyws ⇡12\n❯ ",
        currentCommand: "zsh",
      }),
    );
    expect(v).toEqual({
      bucket: "attention",
      kind: "crashed",
      marker: "no agent TUI — pane is running zsh",
    });
  });

  test("`sh` alone never means crashed — live Claude panes report `sh`", () => {
    // The live fleet's healthy `aix` drivers all report
    // pane_current_command=sh (spawned through `sh -c`). Trusting that
    // signal put 36 healthy panes in the crashed bucket on the first run.
    const v = classifyPaneObservation(
      pane({ capture: `❯ \n${CLAUDE_FOOTER}`, currentCommand: "sh" }),
    );
    expect(v.bucket).toBe("quiet");
  });

  test("a NON-Claude agent TUI counts as chrome (Codex / Kimi panes are agents too)", () => {
    for (const alt of [
      "› Improve documentation in @filename\ngpt-5.6-sol medium · kanban · main · No changes · Ready · Approve for me",
      "auto  K3 thinking: high  …/.atmux/worktrees/driver-5  unum-geoyws-driver-5",
    ]) {
      const v = classifyPaneObservation(pane({ capture: alt, currentCommand: "sh" }));
      expect(v.bucket, `alt-TUI pane misread: ${alt.slice(0, 30)}`).toBe("quiet");
    }
  });
});

describe("TRAP 3b — a stalled spinner is not a working agent", () => {
  const SPINNING = `✻ Cogitating… (12s · esc to interrupt)\n${CLAUDE_FOOTER}`;

  test("fresh activity + a live marker = working", () => {
    expect(classifyPaneObservation(pane({ capture: SPINNING, activityAgeSec: 3 }))).toEqual({
      bucket: "quiet",
      kind: "working",
    });
  });

  test("the SAME text with a stale activity clock = frozen", () => {
    // Identical pane text — only the independent clock differs. That is
    // the point: the distinction cannot come from the pane's output.
    const v = classifyPaneObservation(
      pane({ capture: SPINNING, activityAgeSec: FROZEN_ACTIVITY_SEC + 1 }),
    );
    expect(v.bucket).toBe("attention");
    expect(v.bucket === "attention" && v.kind).toBe("frozen");
    expect(v.bucket === "attention" && v.marker).toContain("no repaint in");
  });

  test("exactly at the threshold is still working (strict >)", () => {
    expect(
      classifyPaneObservation(pane({ capture: SPINNING, activityAgeSec: FROZEN_ACTIVITY_SEC })),
    ).toEqual({ bucket: "quiet", kind: "working" });
  });

  test("an unknown clock does not manufacture a frozen verdict", () => {
    expect(classifyPaneObservation(pane({ capture: SPINNING, activityAgeSec: null }))).toEqual({
      bucket: "quiet",
      kind: "working",
    });
  });

  test("an idle pane silent past the ceiling is dormant, not idle", () => {
    const v = classifyPaneObservation(pane({ activityAgeSec: SILENT_IDLE_SEC + 1 }));
    expect(v.bucket).toBe("attention");
    expect(v.bucket === "attention" && v.kind).toBe("dormant");
    expect(v.bucket === "attention" && v.marker).toBe("no output for 1h");
  });
});

// ---------------------------------------------------------------------
// Every attention class, one fixture each
// ---------------------------------------------------------------------

describe("attention classes — one real fixture each", () => {
  test("permission-prompt: Claude Code's trust-folder modal (live `dash`, 2026-08-15)", () => {
    const modal = [
      " Quick safety check: Is this a project you created or one you trust?",
      "",
      " ❯ 1. Yes, I trust this folder",
      "   2. No, exit",
      "",
      " Enter to confirm · Esc to cancel",
    ].join("\n");
    const v = classifyPaneObservation(pane({ capture: modal }));
    expect(v).toEqual({
      bucket: "attention",
      kind: "permission-prompt",
      marker: "Enter to confirm · Esc to cancel",
    });
  });

  test("permission-prompt: the classic tool-permission modal", () => {
    const v = classifyPaneObservation(
      pane({ capture: `Do you want Claude to run this command?\n${CLAUDE_FOOTER}` }),
    );
    expect(v.bucket === "attention" && v.kind).toBe("permission-prompt");
  });

  test("rate-limited: the assertive banner", () => {
    const v = classifyPaneObservation(
      pane({ capture: `You've hit your limit — resets at 3pm\n${CLAUDE_FOOTER}` }),
    );
    expect(v).toEqual({
      bucket: "attention",
      kind: "rate-limited",
      marker: "You've hit your limit — resets at 3pm",
    });
  });

  test("rate-limited does NOT fire on the standing tip that merely mentions the limit", () => {
    // Live regression: `/hit your limit/i` (the src/core/pane-state.ts
    // pattern) matches Claude Code's own tip and put all five `mx`
    // drivers in the rate-limited bucket.
    const tip = `▎ If you hit your limit, you can continue on Fable 5 with usage credits\n${CLAUDE_FOOTER}`;
    expect(classifyPaneObservation(pane({ capture: tip })).bucket).toBe("quiet");
  });

  test("refusal: an ADR-139 refusal phrase in the tail", () => {
    const v = classifyPaneObservation(
      pane({ capture: `I refuse to continue with this task.\n${CLAUDE_FOOTER}` }),
    );
    expect(v.bucket).toBe("attention");
    expect(v.bucket === "attention" && v.kind).toBe("refusal");
    expect(v.bucket === "attention" && v.marker).toContain("refusal");
  });

  test("crashed: tmux reports the pane process has exited", () => {
    expect(classifyPaneObservation(pane({ paneDead: true }))).toEqual({
      bucket: "attention",
      kind: "crashed",
      marker: "pane process exited",
    });
  });

  test("idle-residue only when the residue is STALE — fresh residue is someone typing", () => {
    const withResidue = `● Done.\n\n❯ atmux claim --next\n${CLAUDE_FOOTER}`;
    expect(
      classifyPaneObservation(pane({ capture: withResidue, activityAgeSec: RESIDUE_FRESH_SEC })),
    ).toEqual({ bucket: "quiet", kind: "idle" });
    const stale = classifyPaneObservation(
      pane({ capture: withResidue, activityAgeSec: RESIDUE_FRESH_SEC + 1 }),
    );
    expect(stale.bucket === "attention" && stale.kind).toBe("idle-residue");
  });

  test("residue with an UNKNOWN clock surfaces — the survey fails toward telling you", () => {
    const v = classifyPaneObservation(
      pane({ capture: `❯ atmux claim --next\n${CLAUDE_FOOTER}`, activityAgeSec: null }),
    );
    expect(v.bucket === "attention" && v.kind).toBe("idle-residue");
  });
});

describe("quiet classes — one fixture each", () => {
  test("compacting", () => {
    expect(
      classifyPaneObservation(pane({ capture: `Compacting conversation…\n${CLAUDE_FOOTER}` })),
    ).toEqual({ bucket: "quiet", kind: "compacting" });
  });

  test("working", () => {
    expect(
      classifyPaneObservation(pane({ capture: `✻ Brewing... (4s)\n${CLAUDE_FOOTER}` })),
    ).toEqual({ bucket: "quiet", kind: "working" });
  });

  test("starting — chrome present, token counter never moved", () => {
    expect(classifyPaneObservation(pane({ capture: `❯ \n${CLAUDE_FOOTER_FRESH}` }))).toEqual({
      bucket: "quiet",
      kind: "starting",
    });
  });

  test("idle — chrome, empty composer, tokens moved, recent activity", () => {
    expect(classifyPaneObservation(pane())).toEqual({ bucket: "quiet", kind: "idle" });
  });

  test("every quiet class is reachable — none is dead vocabulary", () => {
    const reached = new Set<string>();
    for (const capture of [
      `Compacting conversation…\n${CLAUDE_FOOTER}`,
      `✻ Brewing... (4s)\n${CLAUDE_FOOTER}`,
      `❯ \n${CLAUDE_FOOTER_FRESH}`,
      `❯ \n${CLAUDE_FOOTER}`,
    ]) {
      const v = classifyPaneObservation(pane({ capture }));
      if (v.bucket === "quiet") reached.add(v.kind);
    }
    expect([...reached].sort()).toEqual([...QUIET_CLASSES].sort());
  });
});

// ---------------------------------------------------------------------
// Composer + placeholder
// ---------------------------------------------------------------------

describe("extractComposerResidue", () => {
  test("reads the LAST composer line, not an older one from scrollback", () => {
    expect(extractComposerResidue("❯ old command\n● output\n❯ pending text\n")).toBe(
      "pending text",
    );
  });

  test("an empty composer is not residue", () => {
    expect(extractComposerResidue("● output\n❯ \n")).toBeNull();
  });

  test("no composer at all is not residue", () => {
    expect(extractComposerResidue("just some output\n")).toBeNull();
  });

  test("Claude Code's PLACEHOLDER hint is not residue (live `aix` regression)", () => {
    // Every freshly-cleared pane renders `❯ Try "..."`. Reporting it as
    // unsubmitted text made 5 idle panes look wedged on the first run.
    expect(extractComposerResidue('❯ Try "fix lint errors"')).toBeNull();
    expect(extractComposerResidue('❯ Try "fix typecheck errors"')).toBeNull();
    expect(extractComposerResidue("❯ Ask anything")).toBeNull();
  });

  test("real text that merely starts with a similar word still counts", () => {
    expect(extractComposerResidue("❯ Trying the migration again")).toBe(
      "Trying the migration again",
    );
  });

  test("strips ANSI before scanning", () => {
    expect(extractComposerResidue("[32m❯[0m claim --next")).toBe("claim --next");
  });
});

// ---------------------------------------------------------------------
// Tail window + marker lines
// ---------------------------------------------------------------------

describe("tailWindow", () => {
  test("keeps only the last N lines", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const tail = tailWindow(text).split("\n");
    expect(tail.length).toBe(CLASSIFY_TAIL_LINES);
    expect(tail[tail.length - 1]).toBe("line 99");
  });

  test("drops TRAILING BLANKS first, so an unpainted TUI is not read as blank", () => {
    // The live Kimi regression: 25 unpainted rows below the footer made
    // the classifier say "pane is blank" while the gist printed content.
    const text = `${CLAUDE_FOOTER}${"\n".repeat(40)}`;
    expect(tailWindow(text).trim()).not.toBe("");
    expect(tailWindow(text)).toContain("auto mode on");
  });

  test("an all-blank capture still yields empty", () => {
    expect(tailWindow("\n\n   \n")).toBe("");
  });

  test("scrollback older than the window cannot classify the pane", () => {
    // An `Error:` printed a hundred lines ago is finished work, not a
    // crash — classifying over the whole capture reported the driver
    // pane (mid-successful-work) as crashed.
    const old = [
      "Error: something failed long ago",
      ...Array.from({ length: 60 }, () => "ok"),
    ].join("\n");
    expect(tailWindow(old)).not.toContain("Error:");
  });
});

describe("findMarkerLine", () => {
  test("returns the whole LINE, so the evidence is actionable", () => {
    expect(findMarkerLine("noise\n ❯ 1. Yes, I trust this folder\nmore", /Yes, I trust/)).toBe(
      "❯ 1. Yes, I trust this folder",
    );
  });

  test("skips a SPECULATIVE line — a tip is not a report", () => {
    expect(findMarkerLine("If you hit your limit, buy credits", /hit your limit/)).toBeNull();
  });

  test("finds a real hit even when a speculative line precedes it", () => {
    const text = "If you hit your limit, buy credits\nYou've hit your limit — resets 3pm";
    expect(findMarkerLine(text, /hit your limit/)).toBe("You've hit your limit — resets 3pm");
  });

  test("returns null when nothing matches", () => {
    expect(findMarkerLine("all fine here", /catastrophe/)).toBeNull();
  });
});

describe("formatAge", () => {
  test("seconds, minutes, hours — and never a day unit", () => {
    expect(formatAge(0)).toBe("0s");
    expect(formatAge(59)).toBe("59s");
    expect(formatAge(60)).toBe("1m");
    expect(formatAge(3599)).toBe("59m");
    expect(formatAge(3600)).toBe("1h");
    expect(formatAge(200_000)).toBe("55h");
  });

  test("a negative clock skew reads as zero, not as a negative age", () => {
    expect(formatAge(-5)).toBe("0s");
  });
});

// ---------------------------------------------------------------------
// Verdict assembly
// ---------------------------------------------------------------------

function sweep(over: Partial<FleetSweep> = {}): FleetSweep {
  return {
    panes: [],
    asks: [],
    unreadable: [],
    teamsSurveyed: 0,
    elapsedMs: 120,
    ageMs: 0,
    ...over,
  };
}

describe("buildVerdict", () => {
  test("ranks most-urgent first across teams, then by team, then by member", () => {
    const v = buildVerdict(
      sweep({
        teamsSurveyed: 2,
        panes: [
          pane({ team: "zz", member: "m2", activityAgeSec: SILENT_IDLE_SEC + 1 }),
          pane({ team: "aa", member: "m1", sessionUp: false }),
          pane({ team: "aa", member: "m2", capture: "You've hit your limit\n" }),
          pane({ team: "aa", member: "m0", capture: "You've hit your limit\n" }),
        ],
      }),
    );
    expect(v.attention.map((a) => `${a.kind}:${a.team}/${a.member}`)).toEqual([
      "rate-limited:aa/m0",
      "rate-limited:aa/m2",
      "dead:aa/m1",
      "dormant:zz/m2",
    ]);
  });

  test("paneCount counts PANES, not findings — team-level asks never inflate it", () => {
    const v = buildVerdict(
      sweep({
        teamsSurveyed: 1,
        panes: [pane()],
        asks: [{ team: "atmux", driverInboxUnread: 3, openFlags: 1, gist: "please review" }],
      }),
    );
    expect(v.paneCount).toBe(1);
    expect(v.attention.length).toBe(1);
    expect(v.quiet.length).toBe(1);
  });

  test("a team ask becomes ONE member-less item carrying both counts", () => {
    const v = buildVerdict(
      sweep({
        teamsSurveyed: 1,
        asks: [{ team: "atmux", driverInboxUnread: 3, openFlags: 1, gist: "please review" }],
      }),
    );
    expect(v.attention).toEqual([
      {
        team: "atmux",
        member: null,
        kind: "lead-ask",
        marker: "3 unread driver-inbox, 1 open flag",
        gist: "please review",
      },
    ]);
  });

  test("an ask with nothing outstanding produces no item", () => {
    const v = buildVerdict(
      sweep({ asks: [{ team: "atmux", driverInboxUnread: 0, openFlags: 0, gist: "" }] }),
    );
    expect(v.attention).toEqual([]);
  });

  test("plural agreement on the flag count", () => {
    const v = buildVerdict(
      sweep({ asks: [{ team: "a", driverInboxUnread: 0, openFlags: 2, gist: "" }] }),
    );
    expect(v.attention[0]?.marker).toBe("2 open flags");
  });

  test("unreadable teams are carried through WITHOUT becoming attention items", () => {
    // Reported once, on their own line — never dropped, never doubled.
    const v = buildVerdict(
      sweep({ teamsSurveyed: 2, unreadable: [{ team: "sopx", reason: "deadline" }] }),
    );
    expect(v.unreadable).toEqual([{ team: "sopx", reason: "deadline" }]);
    expect(v.attention).toEqual([]);
  });

  test("each attention item carries the gist that produced it (D3 evidence rule)", () => {
    const v = buildVerdict(
      sweep({
        teamsSurveyed: 1,
        panes: [pane({ capture: "You've hit your limit\nresets at 3pm\n" })],
      }),
    );
    expect(v.attention[0]?.gist).toBe("You've hit your limit / resets at 3pm");
  });

  test("sweep timing and cache age pass through untouched", () => {
    const v = buildVerdict(sweep({ elapsedMs: 4321, ageMs: 90_000, teamsSurveyed: 7 }));
    expect(v.elapsedMs).toBe(4321);
    expect(v.ageMs).toBe(90_000);
    expect(v.teamsSurveyed).toBe(7);
  });
});

// ---------------------------------------------------------------------
// Grouping + rendering (the speech budget, ADR-273 D2)
// ---------------------------------------------------------------------

describe("groupAttention", () => {
  const item = (team: string, member: string, kind: (typeof ATTENTION_CLASSES)[number]) => ({
    team,
    member,
    kind,
    marker: "m",
    gist: "g",
  });

  test("collapses same-class items of the SAME team into one entry", () => {
    const groups = groupAttention([
      item("dash", "a", "permission-prompt"),
      item("dash", "b", "permission-prompt"),
      item("dash", "c", "permission-prompt"),
      item("dash", "d", "permission-prompt"),
    ]);
    expect(groups.length).toBe(1);
    expect(groups[0]?.subject).toBe("dash — 4 panes (a, b, c +1)");
  });

  test("names at most GROUP_MEMBERS_SPOKEN members", () => {
    const many = Array.from({ length: 9 }, (_, i) => item("t", `m${i}`, "dormant"));
    expect(groupAttention(many)[0]?.subject).toContain(`+${9 - GROUP_MEMBERS_SPOKEN}`);
  });

  test("does NOT merge across teams or across classes", () => {
    const groups = groupAttention([
      item("a", "1", "dead"),
      item("b", "1", "dead"),
      item("a", "2", "dormant"),
    ]);
    expect(groups.map((g) => g.subject)).toEqual(["a/1", "b/1", "a/2"]);
  });

  test("a single item keeps the plain team/member subject", () => {
    expect(groupAttention([item("a", "1", "dead")])[0]?.subject).toBe("a/1");
  });

  test("rank order survives collapsing — a group never gets promoted", () => {
    const groups = groupAttention([
      item("a", "1", "permission-prompt"),
      item("b", "1", "dormant"),
      item("b", "2", "dormant"),
      item("a", "2", "permission-prompt"),
    ]);
    // Team `a`'s two permission prompts collapse into the FIRST entry
    // (its rank position), and team `b`'s dormants follow — collapsing
    // never lifts a lower-ranked group above a higher-ranked one.
    expect(groups.map((g) => `${g.items[0]?.kind}:${g.items[0]?.team}:${g.items.length}`)).toEqual([
      "permission-prompt:a:2",
      "dormant:b:2",
    ]);
  });
});

describe("renderAttention — the spoken shape", () => {
  const many = (n: number, kind: (typeof ATTENTION_CLASSES)[number]) =>
    Array.from({ length: n }, (_, i) => pane({ team: `t${i}`, member: "d", ...fixtureFor(kind) }));

  function fixtureFor(kind: (typeof ATTENTION_CLASSES)[number]): Partial<PaneObservation> {
    if (kind === "rate-limited") return { capture: "You've hit your limit\n" };
    if (kind === "dead") return { sessionUp: false };
    return { activityAgeSec: SILENT_IDLE_SEC + 1 };
  }

  test("speaks at most `top` entries and counts the remainder BY REASON", () => {
    const v = buildVerdict(
      sweep({ teamsSurveyed: 9, panes: [...many(3, "dead"), ...many(6, "rate-limited")] }),
    );
    const out = renderAttention(v, 2);
    const numbered = out.split("\n").filter((l) => /^\d+\. /.test(l));
    expect(numbered.length).toBe(2);
    expect(out).toContain("+ 7 more:");
    expect(out).toContain("rate-limited");
  });

  test("the remainder breakdown is ordered most-urgent class first", () => {
    expect(
      summarizeRemainder([
        { team: "a", member: "1", kind: "dormant", marker: "", gist: "" },
        { team: "b", member: "1", kind: "rate-limited", marker: "", gist: "" },
        { team: "c", member: "1", kind: "rate-limited", marker: "", gist: "" },
      ]),
    ).toBe("2 rate-limited, 1 parked with nothing queued");
  });

  test("an empty fleet says so instead of rendering an empty list", () => {
    const out = renderAttention(buildVerdict(sweep({ teamsSurveyed: 12 })), 5);
    expect(out).toContain("ATTENTION 0 findings across 0 panes in 12 teams");
    expect(out).toContain("nothing needs you right now");
  });

  test("every spoken item carries reason AND marker AND gist", () => {
    const v = buildVerdict(
      sweep({
        teamsSurveyed: 1,
        panes: [pane({ capture: "You've hit your limit\nresets at 3pm\n" })],
      }),
    );
    const out = renderAttention(v, 5);
    expect(out).toContain("1. atmux/be-1 — rate-limited: You've hit your limit");
    expect(out).toContain("   > You've hit your limit / resets at 3pm");
  });

  test("the quiet rollup rides along so an empty list is checkable", () => {
    const v = buildVerdict(sweep({ teamsSurveyed: 1, panes: [pane(), pane({ member: "b" })] }));
    expect(renderAttention(v, 5)).toContain("quiet: 2 panes — 2 idle and clear");
  });

  test("cache age is spoken when the answer is not fresh (OQ-3)", () => {
    const v = buildVerdict(sweep({ teamsSurveyed: 1, ageMs: 45_000 }));
    expect(renderAttention(v, 5)).toContain("cached 45s ago");
  });

  test("a fresh answer says nothing about caching", () => {
    expect(renderAttention(buildVerdict(sweep({ teamsSurveyed: 1 })), 5)).not.toContain("cached");
  });

  test("top=0 speaks no items but still reports the count", () => {
    const v = buildVerdict(sweep({ teamsSurveyed: 1, panes: many(2, "dead") }));
    const out = renderAttention(v, 0);
    expect(out.split("\n").filter((l) => /^\d+\. /.test(l))).toEqual([]);
    expect(out).toContain("+ 2 more:");
  });

  test("an item with no gist renders no evidence line", () => {
    const v = buildVerdict(
      sweep({ teamsSurveyed: 1, panes: [pane({ sessionUp: false, capture: null })] }),
    );
    expect(renderAttention(v, 5)).not.toContain("   > ");
  });
});

describe("renderUnreadable — reported, never dropped, never five identical clauses", () => {
  test("groups by REASON and names the teams", () => {
    const out = renderUnreadable([
      { team: "e1", reason: "epic-team root" },
      { team: "e2", reason: "epic-team root" },
      { team: "sopx", reason: "timeout" },
    ]);
    expect(out).toBe("UNREADABLE 3 teams: e1, e2 — epic-team root; sopx — timeout");
  });

  test("caps the names spoken but keeps the count exact", () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ team: `t${i}`, reason: "same" }));
    const out = renderUnreadable(items);
    expect(out).toContain("t0, t1, t2 and 3 more — same");
    expect(out).toContain("UNREADABLE 6 teams");
  });

  test("singular for one team", () => {
    expect(renderUnreadable([{ team: "a", reason: "x" }])).toContain("UNREADABLE 1 team:");
  });

  test("renderAttention includes the unreadable line — a dropped team would be a lie", () => {
    const v = buildVerdict(
      sweep({ teamsSurveyed: 2, unreadable: [{ team: "sopx", reason: "deadline" }] }),
    );
    expect(renderAttention(v, 5)).toContain("UNREADABLE 1 team: sopx — deadline");
  });
});

describe("renderQuiet — aggregated, NEVER enumerated (D2)", () => {
  test("counts and rollups only: no member name appears anywhere", () => {
    const v = buildVerdict(
      sweep({
        teamsSurveyed: 3,
        panes: [
          pane({ team: "a", member: "alpha-1" }),
          pane({ team: "b", member: "beta-2", capture: `✻ Brewing... (2s)\n${CLAUDE_FOOTER}` }),
        ],
      }),
    );
    const out = renderQuiet(v);
    expect(out).not.toContain("alpha-1");
    expect(out).not.toContain("beta-2");
    expect(out).toContain("QUIET 3 of 3 teams nominal, 2 of 2 panes");
    expect(out).toContain("1 working, 1 idle and clear");
  });

  test("a PARKED fleet still reports its teams as nominal, counted separately", () => {
    // Chronic state must not swallow the all-clear: 3 dormant panes are
    // worth saying, but they do not make a team troubled.
    const v = buildVerdict(
      sweep({
        teamsSurveyed: 2,
        panes: [
          pane({ team: "a", member: "1", activityAgeSec: SILENT_IDLE_SEC + 1 }),
          pane({ team: "b", member: "1", activityAgeSec: SILENT_IDLE_SEC + 1 }),
        ],
      }),
    );
    const out = renderQuiet(v);
    expect(out).toContain("QUIET 2 of 2 teams nominal");
    expect(out).toContain("parked: 2 panes across 2 teams");
    expect(out).not.toContain("needing you");
  });

  test("an ACUTE finding removes its team from nominal", () => {
    const v = buildVerdict(
      sweep({ teamsSurveyed: 4, panes: [pane({ team: "a", sessionUp: false })] }),
    );
    const out = renderQuiet(v);
    expect(out).toContain("QUIET 3 of 4 teams nominal");
    expect(out).toContain("needing you: 1 finding across 1 team");
  });

  test("an UNREADABLE team is not nominal either — unknown is not fine", () => {
    const v = buildVerdict(
      sweep({ teamsSurveyed: 4, unreadable: [{ team: "sopx", reason: "deadline" }] }),
    );
    const out = renderQuiet(v);
    expect(out).toContain("QUIET 3 of 4 teams nominal");
    expect(out).toContain("unreadable: 1 team — sopx");
  });

  test("cache age is spoken here too", () => {
    expect(renderQuiet(buildVerdict(sweep({ teamsSurveyed: 1, ageMs: 120_000 })))).toContain(
      "cached 2m ago",
    );
  });

  test("plural agreement across every count", () => {
    const v = buildVerdict(
      sweep({
        teamsSurveyed: 1,
        panes: [pane({ sessionUp: false })],
        unreadable: [{ team: "x", reason: "r" }],
      }),
    );
    const out = renderQuiet(v);
    expect(out).toContain("needing you: 1 finding across 1 team");
    expect(out).toContain("unreadable: 1 team");
  });
});

describe("quietBreakdown", () => {
  test("omits zero classes and orders by the QUIET_CLASSES list", () => {
    expect(
      quietBreakdown([
        { team: "a", member: "1", kind: "idle" },
        { team: "a", member: "2", kind: "working" },
        { team: "a", member: "3", kind: "working" },
      ]),
    ).toBe("2 working, 1 idle and clear");
  });

  test("an empty quiet set reads as none, not as an empty string", () => {
    expect(quietBreakdown([])).toBe("none");
  });
});

// ---------------------------------------------------------------------
// ADR-273 §Supplement-6 — one vocabulary, spoken by every surface
// ---------------------------------------------------------------------
//
// `team_status` and `fleet_attention` describing the same pane in
// different words was the W6 defect. These two helpers are what makes
// that unrepresentable: both surfaces render THROUGH them, so a clause
// can only drift by drifting for everybody at once.

describe("paneVerdictPhrase — the one-clause reason, whichever bucket", () => {
  test("an attention verdict speaks its ATTENTION_REASON clause", () => {
    expect(paneVerdictPhrase({ bucket: "attention", kind: "permission-prompt", marker: "m" })).toBe(
      ATTENTION_REASON["permission-prompt"],
    );
    expect(paneVerdictPhrase({ bucket: "attention", kind: "permission-prompt", marker: "m" })).toBe(
      "waiting on a permission prompt",
    );
  });

  test("a quiet verdict speaks its QUIET_LABEL", () => {
    expect(paneVerdictPhrase({ bucket: "quiet", kind: "working" })).toBe(QUIET_LABEL.working);
    expect(paneVerdictPhrase({ bucket: "quiet", kind: "idle" })).toBe("idle and clear");
  });

  test("EVERY class in both vocabularies has a non-empty clause", () => {
    // The property, not a sample: a class added without a reason would
    // otherwise render as an empty string on a spoken surface.
    for (const kind of ATTENTION_CLASSES) {
      expect(paneVerdictPhrase({ bucket: "attention", kind, marker: "" }).length).toBeGreaterThan(
        0,
      );
    }
    for (const kind of QUIET_CLASSES) {
      expect(paneVerdictPhrase({ bucket: "quiet", kind }).length).toBeGreaterThan(0);
    }
  });
});

describe("paneVerdictGlyph — three levels, because chronic is not news", () => {
  test("quiet is green", () => {
    expect(paneVerdictGlyph({ bucket: "quiet", kind: "working" })).toBe("🟢");
    expect(paneVerdictGlyph({ bucket: "quiet", kind: "idle" })).toBe("🟢");
  });

  test("an ACUTE attention class is red", () => {
    expect(paneVerdictGlyph({ bucket: "attention", kind: "permission-prompt", marker: "" })).toBe(
      "🛑",
    );
    expect(paneVerdictGlyph({ bucket: "attention", kind: "dead", marker: "" })).toBe("🛑");
  });

  test("a CHRONIC attention class is amber, not red", () => {
    // `dormant` is a standing condition. Stamping it with the same glyph
    // as a wedged pane is how a triage surface trains its reader to
    // ignore the glyph — the same call renderQuiet already makes.
    for (const kind of CHRONIC_CLASSES) {
      expect(paneVerdictGlyph({ bucket: "attention", kind, marker: "" })).toBe("🟡");
    }
    expect(paneVerdictGlyph({ bucket: "attention", kind: "dormant", marker: "" })).toBe("🟡");
  });

  test("every class maps to exactly one of the three glyphs", () => {
    const allowed = new Set(["🟢", "🟡", "🛑"]);
    for (const kind of ATTENTION_CLASSES) {
      expect(allowed.has(paneVerdictGlyph({ bucket: "attention", kind, marker: "" }))).toBe(true);
    }
    for (const kind of QUIET_CLASSES) {
      expect(allowed.has(paneVerdictGlyph({ bucket: "quiet", kind }))).toBe(true);
    }
  });
});
