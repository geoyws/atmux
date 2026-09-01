// ADR-177 §"What V1 defers" — whip velocity-gate orchestrator.
//
// Wires the V1 kernel (src/core/velocity.ts classifier +
// src/core/whip-strikes.ts state file) into the live whip tick.
// Sibling to V1 (t-289119f2 — classifier + strikes file + schema).
// This is the wiring half (T2 of ADR-177 §What V1 defers).
//
// Task t-5d85dddb covers §1 (runTick wiring), §2 (action-menu prompt
// text), §3 (reply validation). T2 (sibling t-e91fec98) extends with
// the complaint-escalation surface; classifier-swallow / eta-lied /
// process-frozen variants of the symptom hash live there. This
// module's symptom-hash usage is intentionally narrow — only the
// velocity-stalled hash from whip-strikes.ts is consumed here.
//
// Pure helpers live in this module so the velocity-gate decision tree
// is testable WITHOUT spinning up a full poke.ts tick context. The
// orchestrator function {@link runVelocityGateCheck} takes injected
// side-effect callbacks (commit count, kanban probe, pane capture,
// keystroke injector) so unit tests pin deterministic responders.

import {
  classifyVelocity,
  type PaneSignal,
  shouldIncrementStrike,
  shouldNudgeLeadPane,
  type VelocityClassification,
} from "./velocity.ts";
import {
  clearPendingMenu,
  computePaneHash,
  incrementStrike,
  readStrikeRecord,
  recordMenuSent,
  resetStrikeRecord,
  velocityStalledSymptomHash,
} from "./whip-strikes.ts";

// ---------- Pure helpers ----------

/** Map a {@link PaneState} (pane-state.ts taxonomy) → {@link PaneSignal}
 *  (velocity.ts thin classification). Only three concepts matter to the
 *  velocity-gate: is the lead pane (a) ready for keystrokes, (b) busy
 *  but reachable, or (c) unreachable. The full pane-state taxonomy
 *  (TYPING / MODAL / RATE-LIMIT / COMPACTING / SHELL / UNKNOWN)
 *  collapses to BUSY for the gate — it doesn't strike differently on
 *  each variant. Wedge escalation per state lives in `checkMember`,
 *  not here. */
export function paneStateToSignal(
  state: "READY" | "TYPING" | "BUSY" | "MODAL" | "RATE-LIMIT" | "COMPACTING" | "SHELL" | "UNKNOWN",
): PaneSignal {
  if (state === "READY") return "READY";
  if (state === "SHELL" || state === "UNKNOWN") return "UNREACHABLE";
  return "BUSY";
}

/** Build the action-menu prompt text injected into the lead pane on
 *  BAD verdict + READY pane. Per Task body §2 the menu has 4 options:
 *
 *    A: paste-tmux-send-keys command
 *    B: paste-reassign-dispatch
 *    C: one-line-blocker
 *    D: SHA+ETA
 *
 *  Plus the honesty preamble (§5): "If you're about to write making
 *  progress / thinking through / analyzing — STOP and pick A or B.
 *  Verbs not nouns. SHA or no SHA."
 *
 *  The reason string (from the velocity classifier) is interpolated so
 *  the lead sees WHICH facts triggered the menu. Format is plain
 *  text — the next tick reads pane capture + regex-matches `^[ABCD]:`
 *  in the reply. */
export function buildActionMenuPrompt(reason: string): string {
  return [
    `[whip:velocity-gate] ${reason}`,
    "",
    "If you're about to write 'making progress' / 'thinking through' / 'analyzing' — STOP and pick A or B. Verbs not nouns. SHA or no SHA.",
    "",
    "A: paste a tmux send-keys command to nudge the stuck member",
    "B: paste a reassign-dispatch (atmux dispatch <member> <task-id>)",
    "C: one-line blocker (why is the team not committing?)",
    "D: SHA + ETA — name the commit you'll ship + when",
    "",
    "Reply with `A:` / `B:` / `C:` / `D:` then the payload. No marker = strike.",
  ].join("\n");
}

/** Parse a lead-pane capture for a `^[ABCD]:` reply marker. Searches
 *  the last 200 lines of the capture (recent output only — the menu
 *  fired at the bottom of the pane, so a fresh reply lives near the
 *  tail). Returns the first match's choice + payload; subsequent
 *  matches in older scrollback are ignored. */
export function parseLeadReplyMarker(
  capture: string,
): { choice: "A" | "B" | "C" | "D"; payload: string } | null {
  // Scan tail-to-head so the most recent reply wins on the rare case
  // where the lead replied to multiple menus in one capture.
  const lines = capture.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line === undefined) continue;
    // Marker pattern: optional whitespace, then exactly one of A/B/C/D,
    // then `:`, then optional payload. The strict A/B/C/D set keeps
    // adjacent prose ("A: I think we should...") from being false-
    // positive captured — but we DO want that case to count as
    // compliance, so the parse is lenient on payload content.
    const m = line.match(/^\s*([ABCD]):\s*(.*)$/);
    if (m === null) continue;
    return { choice: m[1] as "A" | "B" | "C" | "D", payload: (m[2] ?? "").trim() };
  }
  return null;
}

// ---------- Orchestrator ----------

/** Test-friendly result tuple from {@link runVelocityGateCheck}. The
 *  field set covers every observable side effect so tests assert on
 *  the result instead of poking the strike file directly. */
export interface VelocityGateResult {
  /** Final classifier verdict for this tick. */
  classification: VelocityClassification;
  /** Final pane signal as the gate saw it. */
  paneSignal: PaneSignal;
  /** True iff the gate sent the action menu to the lead pane this
   *  tick. False on BAD+non-READY (classifier-swallow guard) AND on
   *  OK / STANDBY. */
  menuSent: boolean;
  /** True iff the gate incremented the strike counter this tick. */
  strikeIncremented: boolean;
  /** Reply-validation outcome from the prior-tick menu — `null` when
   *  no menu was pending. Otherwise:
   *   - `"compliant"`: pane capture contained an `^[ABCD]:` marker.
   *   - `"no-marker"`: pane changed but no marker found → strike.
   *   - `"classifier-swallow"`: pane unchanged (hash matches) →
   *     strike (the keystroke was dropped). */
  replyValidation: "compliant" | "no-marker" | "classifier-swallow" | null;
}

/** Construction-time deps for the velocity-gate orchestrator. All
 *  side-effecting probes are injectable; the verb layer (`src/verbs/
 *  poke.ts::runTick`) wires the production responders. */
export interface VelocityGateDeps {
  /** Absolute path to the team's `.atmux` directory — threaded into
   *  strikes file reads/writes. */
  atmuxDir: string;
  /** Team name — symptom hash uses this to namespace the strike file. */
  teamName: string;
  /** Epoch seconds for the current tick — used for timestamps. */
  nowSec: number;
  /** Sliding-window minute count for the commit query. Comes from
   *  `team.whip.velocityGate.windowMin` (default 60 per ADR-177). */
  windowMin: number;
  /** Standby grace window — `team.whip.velocityGate.standbyGraceMin`
   *  (default 30). */
  standbyGraceMin: number;
  /** Probe: count ground-truth commits in the last `windowMin`
   *  minutes across the team's git repo. Returns the count + the
   *  most-recent commit age in minutes (null when the repo has zero
   *  commits in the window OR git probe failed). */
  probeCommits: (windowMin: number) => Promise<{ count: number; lastAgeMin: number | null }>;
  /** Probe: count kanban tasks with status = `in-progress` across
   *  the team. Pure-of-injected-IO — caller handles the kanban open. */
  probeInProgress: () => Promise<number>;
  /** Probe: capture the lead pane text. Returns `null` when the lead
   *  pane is unreachable (no tmux window, no `claude` in pane). */
  probeLeadPane: () => Promise<string | null>;
  /** Classify a lead-pane capture into a PaneSignal. Defaulted at
   *  the verb layer to a `classifyText` → `paneStateToSignal`
   *  composition; tests inject deterministic responders. */
  classifyLeadCapture: (capture: string) => PaneSignal;
  /** Inject the action-menu prompt into the lead pane. Returns
   *  `"sent"` on success, `"busy"` when the pane refused (safeSend's
   *  busy-skip), `"unreachable"` when the window is missing,
   *  `"fail"` on any other error. Production wires
   *  `safeSendKeysWithVerify`; tests inject a recorder. */
  sendToLeadPane: (text: string) => Promise<"sent" | "busy" | "unreachable" | "fail">;
  /** Stderr-style log sink for tick-evidence lines. */
  log: (msg: string) => void;
}

/**
 * One velocity-gate sub-op per whip tick. Returns the observable
 * tuple without throwing — every probe failure collapses to a
 * conservative default (count=0, signal=UNREACHABLE, no menu) so a
 * transient git / tmux glitch never blocks the rest of the tick.
 *
 * Decision tree (matches ADR-177 §Spec):
 *
 *   1. Reply validation pass — if the prior tick recorded a pending
 *      menu (menuSentAtSec set on the strike record), capture the
 *      lead pane again and validate:
 *        - same pane hash → classifier-swallow → strike, clear menu;
 *        - different hash, marker present → compliant, clear menu;
 *        - different hash, no marker → no-marker → strike, clear menu.
 *      The classification + nudge below STILL runs after the
 *      validation pass — a compliant reply doesn't excuse a fresh
 *      BAD tick (the team's still 0-commit until a commit lands).
 *
 *   2. Read ground-truth signals (commits + kanban + pane).
 *
 *   3. Classify via `classifyVelocity`.
 *
 *   4. If `shouldIncrementStrike` → `incrementStrike`. If
 *      `shouldNudgeLeadPane` → send menu + `recordMenuSent`. BUSY
 *      pane + BAD verdict → strike but NO menu send (classifier-
 *      swallow guard).
 *
 *   5. If verdict is OK / STANDBY → `resetStrikeRecord` +
 *      `clearPendingMenu`. The reset clears any pending menu state
 *      because the team's healthy — no reason to enforce a marker
 *      on the next tick.
 *
 * Kill-switch: caller gates on `team.crons?.whipVelocityGateEnabled
 * !== false` BEFORE invoking this function. When disabled, this
 * function is never called → zero strike-file writes, zero pane
 * captures, zero classifyVelocity invocations. The gate at the
 * call site means the function itself doesn't need to re-check.
 */
export async function runVelocityGateCheck(deps: VelocityGateDeps): Promise<VelocityGateResult> {
  const symptomHash = velocityStalledSymptomHash(deps.teamName);

  // ---------- §3 Reply validation pass ----------
  let replyValidation: VelocityGateResult["replyValidation"] = null;
  // readStrikeRecord returns an empty record (count=0, all null fields)
  // when the symptom hash hasn't fired yet — null-record sentinel
  // isn't used. The pending-menu check below is the gate: only fires
  // when the prior tick actually wrote menuSentAtSec + menuPaneHash.
  const priorRecord = await readStrikeRecord(deps.atmuxDir, deps.teamName, symptomHash);
  if (
    priorRecord.menuSentAtSec !== null &&
    priorRecord.menuSentAtSec !== undefined &&
    priorRecord.menuPaneHash !== null &&
    priorRecord.menuPaneHash !== undefined
  ) {
    try {
      const capture = await deps.probeLeadPane();
      if (capture !== null) {
        const currentHash = computePaneHash(capture);
        if (currentHash === priorRecord.menuPaneHash) {
          // Classifier-swallow: pane didn't change between tick — the
          // keystroke was dropped (lead pane was wedged / compacting).
          await incrementStrike(
            deps.atmuxDir,
            deps.teamName,
            symptomHash,
            "classifier-swallow: keystroke dropped (pane unchanged since menu send)",
            deps.nowSec,
          );
          replyValidation = "classifier-swallow";
          deps.log("whip-velocity-gate: classifier-swallow strike (pane unchanged)\n");
        } else {
          const marker = parseLeadReplyMarker(capture);
          if (marker !== null) {
            replyValidation = "compliant";
            deps.log(`whip-velocity-gate: compliant reply (choice=${marker.choice})\n`);
          } else {
            await incrementStrike(
              deps.atmuxDir,
              deps.teamName,
              symptomHash,
              "no-marker: lead replied without ^[ABCD]: marker",
              deps.nowSec,
            );
            replyValidation = "no-marker";
            deps.log("whip-velocity-gate: no-marker strike (lead replied without marker)\n");
          }
        }
      }
    } catch (e) {
      deps.log(`whip-velocity-gate: reply-validation probe failed: ${String(e)}\n`);
    }
    // Clear menu state regardless of outcome — consumed.
    await clearPendingMenu(deps.atmuxDir, deps.teamName, symptomHash);
  }

  // ---------- §1+§2 Classify + act ----------
  let commitFacts = { count: 0, lastAgeMin: null as number | null };
  try {
    commitFacts = await deps.probeCommits(deps.windowMin);
  } catch (e) {
    deps.log(`whip-velocity-gate: commit probe failed (treating as 0): ${String(e)}\n`);
  }
  let inProgressTaskCount = 0;
  try {
    inProgressTaskCount = await deps.probeInProgress();
  } catch (e) {
    deps.log(`whip-velocity-gate: kanban probe failed (treating as 0): ${String(e)}\n`);
  }
  let paneSignal: PaneSignal = "UNREACHABLE";
  try {
    const capture = await deps.probeLeadPane();
    if (capture !== null) {
      paneSignal = deps.classifyLeadCapture(capture);
    }
  } catch (e) {
    deps.log(
      `whip-velocity-gate: lead-pane probe failed (treating as UNREACHABLE): ${String(e)}\n`,
    );
  }

  const classification = classifyVelocity({
    commitsInWindow: commitFacts.count,
    lastCommitAgeMin: commitFacts.lastAgeMin,
    inProgressTaskCount,
    paneSignal,
    windowMin: deps.windowMin,
    standbyGraceMin: deps.standbyGraceMin,
  });
  deps.log(
    `whip-velocity-gate: verdict=${classification.verdict} signal=${paneSignal} reason='${classification.reason}'\n`,
  );

  let menuSent = false;
  let strikeIncremented = false;

  if (shouldIncrementStrike(classification)) {
    await incrementStrike(
      deps.atmuxDir,
      deps.teamName,
      symptomHash,
      classification.reason,
      deps.nowSec,
    );
    strikeIncremented = true;
    if (shouldNudgeLeadPane(classification, paneSignal)) {
      // Re-capture the pane immediately before sending so the hash we
      // store reflects the pre-send state (so next tick's classifier-
      // swallow check compares apples-to-apples).
      try {
        const preSendCapture = await deps.probeLeadPane();
        const result = await deps.sendToLeadPane(buildActionMenuPrompt(classification.reason));
        if (result === "sent" && preSendCapture !== null) {
          await recordMenuSent(
            deps.atmuxDir,
            deps.teamName,
            symptomHash,
            computePaneHash(preSendCapture),
            deps.nowSec,
          );
          menuSent = true;
          deps.log("whip-velocity-gate: menu sent + pending-state recorded\n");
        } else {
          deps.log(
            `whip-velocity-gate: menu send returned '${result}' — skipping pending-state record\n`,
          );
        }
      } catch (e) {
        deps.log(`whip-velocity-gate: menu-send threw: ${String(e)}\n`);
      }
    } else {
      deps.log(
        `whip-velocity-gate: BAD verdict but pane signal '${paneSignal}' — skipping menu send (strike still counted)\n`,
      );
    }
  } else {
    // OK or STANDBY — reset the strike counter + clear any pending
    // menu (the team's healthy, no marker enforcement needed).
    await resetStrikeRecord(deps.atmuxDir, deps.teamName, symptomHash);
    await clearPendingMenu(deps.atmuxDir, deps.teamName, symptomHash);
  }

  return { classification, paneSignal, menuSent, strikeIncremented, replyValidation };
}
