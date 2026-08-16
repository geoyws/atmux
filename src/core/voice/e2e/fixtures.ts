// ADR-272 §Supplement — fixture TUI states for the voice e2e harness.
//
// These strings ARE the ground truth the judge scores against, so every one
// of them is written against the real classifier
// (`classifyPaneObservation` in `src/core/voice/fleet.ts`) rather than
// against a mental model of it. `fixtures.test.ts` runs each fixture
// through that classifier and asserts the declared verdict — so a fixture
// that stops meaning what it claims fails the unit suite rather than
// silently making the judge grade against a lie.
//
// Each pane's text is deliberately unambiguous: a human reading it should
// reach the same verdict the classifier does, because the judge is asked to
// check whether the assistant reported the panes that GENUINELY need
// attention, and a borderline fixture would make a wrong answer look right.
//
// Constraints encoded here (see the classifier's ladder):
//   - `permission-prompt` needs a MODAL_RE line that is not hypothetical.
//   - `idle-residue` needs agent chrome, NO live-turn marker, a non-empty
//     non-placeholder composer line, AND a window whose tmux activity clock
//     is older than RESIDUE_FRESH_SEC (60s) — hence `minStaleSec`.
//   - `working` needs a live-turn marker and activity newer than
//     FROZEN_ACTIVITY_SEC (300s).
//   - `dead` needs no tmux session at all — which is why the ghost team
//     exists rather than a fourth pane.

import type { AttentionClass, QuietClass } from "../fleet.ts";

/** Declared verdict for a fixture pane — mirrors `PaneVerdict` minus the
 *  marker (which is evidence text, not contract). */
export type FixtureVerdict =
  | { bucket: "attention"; kind: AttentionClass }
  | { bucket: "quiet"; kind: QuietClass };

export interface PaneFixture {
  /** Roster member name; also the tmux window name (no emoji ⇒ they match). */
  member: string;
  /** Exact pane text painted into the window. */
  text: string;
  /** What the classifier must say about it. */
  expect: FixtureVerdict;
  /**
   * Seconds the window's activity clock must have aged before this pane
   * classifies as declared. Non-zero only for `idle-residue`: residue in a
   * freshly-touched window is someone TYPING, and the classifier correctly
   * calls that `quiet/idle`.
   */
  minStaleSec: number;
  /** One clause the judge is given as ground truth. Plain English. */
  truth: string;
}

export interface TeamFixture {
  /** Suffix appended to `FAKE_TEAM_PREFIX`. */
  suffix: string;
  /** `live` gets a tmux session; `ghost` deliberately gets none. */
  kind: "live" | "ghost";
  panes: ReadonlyArray<PaneFixture>;
  truth: string;
}

// ---------- Pane texts ----------
//
// Written as arrays-of-lines so the shape is visible in review and a stray
// trailing space cannot hide inside a template literal.

const BLOCKED_PANE = [
  "● Reading src/core/billing/invoice.ts",
  "  ⎿  Read 240 lines",
  "",
  "● I need to edit the invoice reducer to fix the rounding bug.",
  "",
  "╭──────────────────────────────────────────────────────────╮",
  "│ Edit file                                                │",
  "│   src/core/billing/invoice.ts                            │",
  "│                                                          │",
  "│ Do you want to make this edit?                           │",
  "│                                                          │",
  "│ ❯ 1. Yes                                                 │",
  "│   2. Yes, and don't ask again this session               │",
  "│   3. No, and tell Claude what to do differently          │",
  "╰──────────────────────────────────────────────────────────╯",
].join("\n");

// The composer line is rendered WITHOUT a right-hand border on purpose:
// `COMPOSER_LINE_RE` captures to end-of-line, so a trailing `│` would be
// swallowed into the residue text and then read back to the operator as
// part of what they supposedly typed.
const WEDGED_PANE = [
  "● Ran the migration and the suite is green.",
  "  ⎿  47 pass, 0 fail",
  "",
  "✻ Worked for 22s",
  "",
  "❯ also add the rollback path before you push",
  "",
  "  ⏵⏵ auto mode on                    tok 4821/200000  ctx 12%",
].join("\n");

const HEALTHY_PANE = [
  "● Refactoring the scheduler into src/core/sched/.",
  "  ⎿  Updated 3 files",
  "",
  "✻ Cogitating… (12s · ↑ 1.4k tokens · esc to interrupt)",
  "",
  "❯ ",
  "",
  "  ⏵⏵ auto mode on                    tok 9102/200000  ctx 21%",
].join("\n");

// ---------- The cage ----------

/**
 * The fake fleet: one live team with three panes covering the three
 * classifier outcomes that a live session can produce, plus one team whose
 * session is deliberately absent so `dead` is exercised too.
 *
 * Adding a pane is a data edit here; nothing downstream enumerates them.
 */
export const TEAM_FIXTURES: ReadonlyArray<TeamFixture> = Object.freeze([
  Object.freeze({
    suffix: "alpha",
    kind: "live" as const,
    truth:
      "team voice-e2e-alpha is up with three panes: one blocked on a permission prompt, " +
      "one idle with unsubmitted text in its composer, and one actively working.",
    panes: Object.freeze([
      Object.freeze({
        member: "be-1",
        text: BLOCKED_PANE,
        expect: { bucket: "attention", kind: "permission-prompt" } as FixtureVerdict,
        minStaleSec: 0,
        truth:
          "pane be-1 is STOPPED on a permission prompt ('Do you want to make this edit?') " +
          "and will wait forever until a human answers. It needs attention.",
      }),
      Object.freeze({
        member: "fe-1",
        text: WEDGED_PANE,
        expect: { bucket: "attention", kind: "idle-residue" } as FixtureVerdict,
        minStaleSec: 70,
        truth:
          "pane fe-1 finished its turn and has unsubmitted text sitting in the composer " +
          "('also add the rollback path before you push') that was never sent. " +
          "It is wedged and needs attention.",
      }),
      Object.freeze({
        member: "docs",
        text: HEALTHY_PANE,
        expect: { bucket: "quiet", kind: "working" } as FixtureVerdict,
        minStaleSec: 0,
        truth: "pane docs is mid-turn and working normally. It does NOT need attention.",
      }),
    ]),
  }),
  Object.freeze({
    suffix: "ghost",
    kind: "ghost" as const,
    truth:
      "team voice-e2e-ghost is listed in the roster but its tmux session is not running, " +
      "so the whole team reads as down. It needs attention.",
    panes: Object.freeze([]),
  }),
]);

/** Every fixture pane that must be reported as needing attention. */
export function attentionPanes(): Array<{ team: string; member: string; kind: AttentionClass }> {
  const out: Array<{ team: string; member: string; kind: AttentionClass }> = [];
  for (const team of TEAM_FIXTURES) {
    for (const pane of team.panes) {
      if (pane.expect.bucket === "attention") {
        out.push({ team: teamName(team), member: pane.member, kind: pane.expect.kind });
      }
    }
  }
  return out;
}

/** Longest stale-window requirement across all fixtures (seconds). */
export function requiredStaleSec(): number {
  let max = 0;
  for (const team of TEAM_FIXTURES) {
    for (const pane of team.panes) max = Math.max(max, pane.minStaleSec);
  }
  return max;
}

/** Full team name for a fixture — prefix + suffix. */
export function teamName(team: Pick<TeamFixture, "suffix">): string {
  return `voice-e2e-${team.suffix}`;
}

/** The ground-truth briefing handed verbatim to the judge. */
export function groundTruthBriefing(): string {
  const lines: string[] = [
    "The fleet consists of EXACTLY these teams and panes, and nothing else:",
    "",
  ];
  for (const team of TEAM_FIXTURES) {
    lines.push(`- ${team.truth}`);
    for (const pane of team.panes) {
      lines.push(`  - ${pane.truth}`);
    }
  }
  lines.push("");
  lines.push(
    "No other team, pane, or member exists. Any team or pane named in the " +
      "assistant's answer that does not appear above is a hallucination.",
  );
  return lines.join("\n");
}
