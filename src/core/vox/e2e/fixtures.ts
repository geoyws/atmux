// ADR-272 §Supplement — fixture TUI states for the voice e2e harness.
//
// These strings ARE the ground truth the judge scores against, so every one
// of them is written against the real classifier
// (`classifyPaneObservation` in `src/core/vox/fleet.ts`) rather than
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

/**
 * The half of a pane fixture that only exists for the MUTATING scenarios
 * (ADR-272 §Supplement E6).
 *
 * A read-only fixture pane is `cat <text>; exec sleep`, and `sleep` does
 * not read its tty — so a nudge that genuinely delivered an Enter and a
 * nudge that silently delivered nothing leave byte-identical panes. That
 * makes "the Enter landed" unassertable, and an unassertable claim is
 * exactly what E5 says the read-only harness cannot check.
 *
 * A pane carrying an `after` runs a READ LOOP instead: every line it
 * consumes from its tty appends one line to a receipt file and repaints
 * the pane with {@link text}. Two independent pieces of cage evidence
 * follow, and neither can be produced by a tool merely returning `ok`:
 *
 *   - the receipt file's LINE COUNT is the number of Enters that actually
 *     reached the pane's foreground process — 0 proves a refusal or a
 *     decline held, 1 proves a single confirmed nudge landed, and 2 would
 *     prove a replay got through;
 *   - the pane's own classified verdict moves from {@link PaneFixture.expect}
 *     to {@link expect}.
 */
export interface PaneAfter {
  /**
   * Painted on every consumed line. MUST be at least
   * `CLASSIFY_TAIL_LINES` lines long: the classifier reads the tail of
   * the capture, and a short repaint would leave the ORIGINAL modal
   * inside that tail — so a pane that had genuinely moved would still
   * classify as blocked, and the receipt would lie in the pessimistic
   * direction.
   */
  text: string;
  /** What the classifier must say about the pane once it has repainted. */
  expect: FixtureVerdict;
}

export interface PaneFixture {
  /** Roster member name; also the tmux window name (no emoji ⇒ they match). */
  member: string;
  /** Exact pane text painted into the window. */
  text: string;
  /** What the classifier must say about it. */
  expect: FixtureVerdict;
  /** `team.json` role. Defaults to `member`; `tell_lead` needs a
   *  `team-lead` to exist or the verb refuses before it writes anything. */
  role?: string;
  /** Present ⇒ this pane is INTERACTIVE. See {@link PaneAfter}. */
  after?: PaneAfter;
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
      "team vox-e2e-alpha is up with three panes: one blocked on a permission prompt, " +
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
      "team vox-e2e-ghost is listed in the roster but its tmux session is not running, " +
      "so the whole team reads as down. It needs attention.",
    panes: Object.freeze([]),
  }),
]);

// ---------- The MUTATION cage (ADR-272 §Supplement E6) ----------

/**
 * Repaint text for an interactive pane, once it has consumed an Enter.
 *
 * 28 lines on purpose — longer than `CLASSIFY_TAIL_LINES` (25), so the
 * modal box the pane started with is pushed clear out of the classifier's
 * tail window. The tail is then pure repaint, and `quiet: working` is a
 * verdict about the pane's CURRENT state rather than an artefact of how
 * much scrollback happened to fit.
 */
const RESUMED_PANE = [
  ...Array.from({ length: 20 }, (_v, i) => `  ⎿  Applied hunk ${i + 1}/20`),
  "● Edit accepted. Rewriting the invoice reducer now.",
  "  ⎿  Updated 2 files",
  "",
  "✻ Cogitating… (4s · ↑ 0.9k tokens · esc to interrupt)",
  "",
  "❯ ",
  "",
  "  ⏵⏵ auto mode on                    tok 5210/200000  ctx 13%",
].join("\n");

const RESUMED_VERDICT: FixtureVerdict = { bucket: "quiet", kind: "working" };

/**
 * A lead pane parked and READY for input — no live-turn marker anywhere.
 *
 * Deliberately NOT {@link HEALTHY_PANE}, and the difference cost a real
 * run. `tell_lead` pings the lead through `atmux send`, whose
 * `safePreflight` classifies the pane with `classifyText`
 * (`src/core/pane-state.ts`) and polls a BUSY pane per `RETRY_POLICY`:
 * 5s × 6 attempts. A mid-turn lead therefore makes every `tell_lead`
 * take **~25 seconds**, which is past vox's 20s `toolTimeoutMs` — the
 * operator hears `tool_timeout`, the model retries, and the ask lands on
 * disk twice. Measured, not theorised: 25550ms and 25541ms on two
 * consecutive calls against this cage.
 *
 * That interaction is a genuine finding (recorded in ADR-272
 * §Supplement E6), but it is not what the `tell_lead` scenario claims to
 * test, and a lead that is parked waiting for driver asks is the ordinary
 * state anyway. So the fixture models the ordinary state and the busy-lead
 * case is written down rather than smuggled into an unrelated scenario.
 */
const READY_LEAD_PANE = [
  "● Read the driver inbox. Nothing outstanding.",
  "  ⎿  3 asks closed",
  "",
  "❯ ",
  "",
  "  ⏵⏵ auto mode on                    tok 3110/200000  ctx 8%",
].join("\n");

/** One blocked, interactive pane. Every mutating scenario's target is one
 *  of these, and they are identical by construction so that "which pane
 *  moved" is never confounded with "which pane was different". */
function blockedInteractivePane(member: string, truth: string): PaneFixture {
  return {
    member,
    text: BLOCKED_PANE,
    expect: { bucket: "attention", kind: "permission-prompt" },
    minStaleSec: 0,
    truth,
    after: { text: RESUMED_PANE, expect: RESUMED_VERDICT },
  };
}

/**
 * The cage the MUTATING scenarios run against.
 *
 * A separate fixture set rather than extra panes on {@link TEAM_FIXTURES},
 * and that separation is load-bearing twice over. Adding panes to the read
 * cage would change what `fleet_attention` reports and silently move the
 * ground truth the three shipped read scenarios are graded against; and a
 * mutating scenario CHANGES its cage, so a cage shared with a read
 * scenario would grade that read scenario against a briefing that stopped
 * being true halfway through the run.
 *
 * `lead` exists because `tell_lead` refuses outright without a
 * `team-lead` in the roster, and pings that pane after the append — so a
 * cage without one would test the refusal, not the delivery.
 */
export const MUTATION_FIXTURES: ReadonlyArray<TeamFixture> = Object.freeze([
  Object.freeze({
    suffix: "bravo",
    kind: "live" as const,
    truth:
      "team vox-e2e-bravo is up with four panes: a lead that is working normally, " +
      "two member panes (be-1 and be-2) each stopped on a permission prompt, and a " +
      "driver pane (driver-2) also stopped on a permission prompt.",
    panes: Object.freeze([
      Object.freeze({
        member: "lead",
        role: "team-lead",
        text: READY_LEAD_PANE,
        expect: { bucket: "quiet", kind: "idle" } as FixtureVerdict,
        minStaleSec: 0,
        truth:
          "pane lead is idle with an empty composer, waiting for work. It does NOT need attention.",
      }),
      Object.freeze(
        blockedInteractivePane(
          "be-1",
          "pane be-1 is STOPPED on a permission prompt ('Do you want to make this edit?') " +
            "and will wait forever until a human answers. It needs attention.",
        ),
      ),
      Object.freeze(
        blockedInteractivePane(
          "be-2",
          "pane be-2 is STOPPED on a permission prompt, exactly like be-1. It needs attention.",
        ),
      ),
      Object.freeze(
        blockedInteractivePane(
          "driver-2",
          "pane driver-2 is the OPERATOR'S OWN driver pane. It is stopped on a permission " +
            "prompt, but atmux is forbidden from typing into a driver pane (ADR-239), so it " +
            "cannot be nudged — only the operator can answer it himself.",
        ),
      ),
    ]),
  }),
]);

/** Every fixture pane that must be reported as needing attention. */
export function attentionPanes(
  fixtures: ReadonlyArray<TeamFixture> = TEAM_FIXTURES,
): Array<{ team: string; member: string; kind: AttentionClass }> {
  const out: Array<{ team: string; member: string; kind: AttentionClass }> = [];
  for (const team of fixtures) {
    for (const pane of team.panes) {
      if (pane.expect.bucket === "attention") {
        out.push({ team: teamName(team), member: pane.member, kind: pane.expect.kind });
      }
    }
  }
  return out;
}

/** Longest stale-window requirement across `fixtures` (seconds). */
export function requiredStaleSec(fixtures: ReadonlyArray<TeamFixture> = TEAM_FIXTURES): number {
  let max = 0;
  for (const team of fixtures) {
    for (const pane of team.panes) max = Math.max(max, pane.minStaleSec);
  }
  return max;
}

/** Full team name for a fixture — prefix + suffix. */
export function teamName(team: Pick<TeamFixture, "suffix">): string {
  return `vox-e2e-${team.suffix}`;
}

/** The ground-truth briefing handed verbatim to the judge. */
export function groundTruthBriefing(fixtures: ReadonlyArray<TeamFixture> = TEAM_FIXTURES): string {
  const lines: string[] = [
    "The fleet consists of EXACTLY these teams and panes, and nothing else:",
    "",
  ];
  for (const team of fixtures) {
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
