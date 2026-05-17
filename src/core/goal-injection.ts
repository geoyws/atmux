// ADR-157 T3 (Task t-c89ead5f) — shared `/goal` injection helper.
//
// Called from two sites (deduplicates per Task body §2):
//   - src/verbs/rotate.ts — post-bootstrap injection on rotate-member
//     / rotate-lead (after brief lands + bootClaude completes).
//   - src/verbs/start.ts — cold-spawn injection in the member-bring-up
//     loop (after bootClaudeMember / pasteBriefForMember completes).
//
// Cursor-runtime carve-out (ADR-157 §D4): when `member.runtime ===
// "cursor"`, /goal injection is a NO-OP — Cursor CLI has no /goal
// equivalent. Returns `{ fired: false, reason: "runtime=cursor" }`.
//
// Goal resolution: delegates to `resolveGoalForMember` from
// goal-resolver.ts (ADR-157 T2) — single source of truth. When no
// goal resolves, returns `{ fired: false, reason: "no goal active" }`.
//
// Verifier: `composerEmpty()` from ADR-138 safe-send.ts — the
// universal post-Enter signal for Claude TUI. The TUI clears the
// composer line after consuming a slash command the same way it
// clears it after consuming a prompt; ADR-138 §verifierForTui maps
// `tui: "claude"` to `composerEmpty()` for the same reason. Adding a
// dedicated `goalSet` verifier was considered (Task body §3) but
// composer-empty already covers the slash-command acceptance signal
// without inventing a new pattern.
//
// Failure semantics: injection is BEST-EFFORT — the rotation /
// cold-spawn pipeline does NOT block on goal injection failure (per
// Task body §5 + reviewer pre-flag — lane-tick T4 must still apply
// to goal-set-but-injection-failed members so the drain isn't
// deadlocked). `safeSendKeysWithVerify` is invoked with
// `onFail: "escalate"` so a verification miss writes to the
// send-keys-failures.log per ADR-138 and the helper returns
// `{ fired: false, reason: "verify-failed" }` rather than throwing.

import type { SendTarget, TmuxNamespace } from "../abstractions/tmux.ts";
import type { TeamMember } from "../schema/team.ts";
import { resolveGoalForMember } from "./goal-resolver.ts";
import { composerEmpty, safeSendKeysWithVerify } from "./safe-send.ts";

export interface InjectGoalOpts {
  tmux: TmuxNamespace;
  /** Discriminated send-target (kind=member / kind=lead). Carries the
   *  ADR-025 audit metadata + the tmux pane target string. */
  sendTarget: SendTarget;
  /** Plain `session:window` string for capture-pane (separate from
   *  `sendTarget` because capture-pane doesn't need the audit
   *  metadata). */
  paneTargetString: string;
  /** Member roster entry — `goal` / `runtime` / `name` consumed. */
  member: TeamMember;
  /** Path to the member's role brief — passed to
   *  {@link resolveGoalForMember} so the `## Standing Goal` section
   *  can be parsed when `member.goal` is unset. Optional: omitted
   *  when caller knows no brief is in play (rare). */
  briefPath?: string;
  /** Optional logger — `log` for info-line, `warn` for failure surfaces.
   *  Defaults to no-op. */
  logger?: {
    log: (s: string) => void;
    warn: (s: string) => void;
  };
  /** Sleep override (test injection). */
  sleep?: (ms: number) => Promise<void>;
  /** Time override (test injection). */
  now?: () => number;
}

export interface InjectGoalResult {
  /** `true` iff `/goal "<text>"` keystroke landed AND verifier
   *  observed composer-clear within the ADR-138 retry budget. */
  fired: boolean;
  /** Operator-readable explanation — one of:
   *  - `"runtime=cursor"` — D4 carve-out, skipped silently.
   *  - `"no goal active"` — neither member.goal nor brief Standing
   *    Goal resolved.
   *  - `"verify-failed"` — safeSendKeysWithVerify escalated (entry
   *    written to send-keys-failures.log).
   *  - `"fired"` — happy path; goal text accepted by TUI. */
  reason: string;
  /** Total send attempts (only populated when actually fired). */
  attempts?: number;
  /** Resolved goal text — populated when `fired === true` so callers
   *  can log / report what landed. */
  goalText?: string;
}

/** ADR-157 T3 §1 — fire `/goal "<text>"` against the member's pane
 *  via {@link safeSendKeysWithVerify}. NO-OPs cleanly on the two
 *  documented skip paths (cursor runtime + no goal active). Never
 *  throws — failures escalate via the ADR-138 log path + the caller
 *  proceeds to the next member. */
export async function injectGoalIfActive(opts: InjectGoalOpts): Promise<InjectGoalResult> {
  const logger = opts.logger ?? {
    log: () => {},
    warn: () => {},
  };

  // §D4 — runtime gate. Cursor short-circuits before goal resolution
  // so we don't waste a brief-file read on a member that can't act on
  // the result.
  if (opts.member.runtime === "cursor") {
    logger.log(`${opts.member.name}: /goal injection skipped (runtime=cursor — ADR-157 §D4)`);
    return { fired: false, reason: "runtime=cursor" };
  }

  const resolveOpts: Parameters<typeof resolveGoalForMember>[1] = opts.briefPath;
  const goal = await resolveGoalForMember(opts.member, resolveOpts);
  if (goal === null) {
    logger.log(
      `${opts.member.name}: /goal injection skipped (no goal active — member.goal unset AND brief has no ## Standing Goal)`,
    );
    return { fired: false, reason: "no goal active" };
  }

  // Per ADR-138 + reviewer pre-flag: /goal injection MUST go through
  // safeSendKeysWithVerify, NEVER raw tmux send-keys. The composer-
  // empty verifier confirms the slash command was consumed by the
  // TUI (the compose line clears on Enter).
  const captureFn = (t: string) => opts.tmux.pane.capturePane({ target: t, start: -40 });
  const sendKeysFn = async (_t: string, text: string) => {
    await opts.tmux.pane.sendKeys({
      target: opts.sendTarget,
      keys: text,
      enter: true,
    });
  };

  // /goal payload — quote the goal text so multi-word goals land as a
  // single argument. The TUI consumes everything-after-/goal as the
  // condition; quoting matches the user-facing `/goal "<text>"` form.
  const keys = `/goal "${goal.replace(/"/g, '\\"')}"`;

  const sendOpts: Parameters<typeof safeSendKeysWithVerify>[0] = {
    target: opts.paneTargetString,
    keys,
    expectVerifier: composerEmpty(),
    capture: captureFn,
    sendKeys: sendKeysFn,
    onFail: "escalate",
    log: (m) => logger.log(m),
  };
  if (opts.sleep !== undefined) sendOpts.sleep = opts.sleep;
  if (opts.now !== undefined) sendOpts.now = opts.now;

  const result = await safeSendKeysWithVerify(sendOpts);

  if (result.success) {
    logger.log(`${opts.member.name}: /goal injected (attempts=${result.attempts}; goal="${goal}")`);
    return {
      fired: true,
      reason: "fired",
      attempts: result.attempts,
      goalText: goal,
    };
  }

  // Escalation already happened inside safeSendKeysWithVerify. The
  // pipeline keeps going — lane-tick (T4) is the safety net for
  // members whose /goal didn't land.
  logger.warn(
    `${opts.member.name}: /goal injection escalated after ${result.attempts} attempt(s) — lane-tick backstop must still apply (reviewer pre-flag, T4)`,
  );
  return { fired: false, reason: "verify-failed", attempts: result.attempts };
}
