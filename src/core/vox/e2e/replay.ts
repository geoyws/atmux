// ADR-272 §Supplement E6 — the D7 confirmation gate, driven end to end
// against a live cage.
//
// ---------------------------------------------------------------------
// Why this scenario does NOT go through the model
// ---------------------------------------------------------------------
//
// Every other scenario speaks. This one does not, and the reason is that
// the property under test is not a property of the assistant.
//
// D7 splits the confirmation into two halves and is explicit about which
// is which: the token's existence, its tool/args/session binding, its
// TTL, its single-use burn and the refusal to run a gated tool without a
// valid token are SERVER-ENFORCED; the affirmation — reading the preview
// aloud and judging "yes" — is the model's. A replay is an attack on the
// server half. Asking a language model to attempt one would measure
// whether that model can be talked into trying, which is a different
// question with a non-deterministic answer, and a run where the model
// simply declined to try would go green having tested nothing.
//
// So this drives the REAL `ToolBridge` the running server built — the
// same instance, the same confirm store, the same `pane_nudge` runner,
// against the same throwaway cage — and asserts on the CAGE after each
// step. It costs no provider minutes, which is also why it can afford to
// be the longest scenario in the set.
//
// ---------------------------------------------------------------------
// The one that makes the rest mean anything: the CONTROL
// ---------------------------------------------------------------------
//
// Three of the five steps pass by showing an Enter did NOT arrive. A
// receipt that stays at zero because the pane was never nudgeable in the
// first place would satisfy all three while proving nothing, and that is
// the failure mode this whole file would otherwise have. Step 5 therefore
// nudges `be-2` — the very pane step 4 asserted was untouched — through a
// legitimately-issued token, and REQUIRES its receipt to reach 1. If the
// negatives were passing by paralysis, step 5 fails.
//
// Step 5's token is not minted specially: it is the one step 4's MISMATCH
// handed back. That is the same fact stated a second way — a mismatched
// redemption fails SAFE, into a fresh round trip, rather than failing
// open or failing dead.

import { z } from "zod";
import { tryParseJsonString } from "../../../abstractions/json.ts";
import type { ExecuteToolOutput, ToolBridge } from "../tool-bridge.ts";
import { type CageProbe, countEnters, locatePane, type PostconditionResult } from "./assertions.ts";

/** The tool under test. Chosen because it is the one mutating tool whose
 *  effect is observable in the cage without believing anything the tool
 *  says about itself. */
export const REPLAY_TOOL = "pane_nudge";

/** Envelope shape this module needs. Read tolerantly — the bridge owns
 *  the full schema, and a field we do not read must not make us fail. */
const Envelope = z
  .object({ ok: z.boolean().optional(), error: z.string().optional() })
  .passthrough();

export interface ReplayContext extends CageProbe {
  bridge: ToolBridge;
  /** Stable for the whole scenario — the token binds to it (D7), so a
   *  changing session id would make every redeem a mismatch and the
   *  scenario would pass without exercising anything. */
  sessionId: string;
  /** Cage team the panes live on. */
  team: string;
  log?: (line: string) => void;
}

/** Classify one bridge answer into the three outcomes D7 can produce. */
export type GateOutcome = "executed" | "previewed" | "other";

export function classifyEnvelope(envelopeJson: string): { outcome: GateOutcome; error: string } {
  const env = tryParseJsonString(envelopeJson, Envelope);
  if (env === null) return { outcome: "other", error: "unparseable envelope" };
  if (env.ok === true) return { outcome: "executed", error: "" };
  if (env.error === "needs_confirmation") return { outcome: "previewed", error: "" };
  return { outcome: "other", error: env.error ?? "unknown" };
}

/** Args for one `pane_nudge` call. `action` is spelled out rather than
 *  left to the schema default so the binding this module reasons about is
 *  the binding on the wire. */
export function nudgeArgs(team: string, member: string, token?: string): string {
  const args: Record<string, unknown> = { team, member, action: "submit" };
  if (token !== undefined) args.confirm_token = token;
  return JSON.stringify(args);
}

function pass(id: string, detail: string): PostconditionResult {
  return { id, pass: true, detail };
}
function fail(id: string, detail: string): PostconditionResult {
  return { id, pass: false, detail };
}

/**
 * Read a pane's Enter count, treating "this pane keeps no receipt" as a
 * hard failure rather than as zero. A non-interactive pane cannot answer
 * the question, and answering it anyway is how a negative assertion
 * becomes vacuous.
 */
async function enters(ctx: ReplayContext, member: string): Promise<number | null> {
  const located = locatePane(ctx.plan, ctx.team, member);
  if (located === null) return null;
  return await countEnters(ctx, located);
}

/**
 * Drive the five steps. Returns one {@link PostconditionResult} per
 * assertion; the caller folds them into the scenario's verdict.
 *
 * Runs to completion even after a failure. A gate that failed open at
 * step 2 makes steps 3-5 the most informative output in the run, and
 * stopping at the first red would throw exactly that away.
 */
export async function runConfirmReplay(ctx: ReplayContext): Promise<PostconditionResult[]> {
  const log = ctx.log ?? ((): void => {});
  const out: PostconditionResult[] = [];
  const call = (member: string, token?: string): Promise<ExecuteToolOutput> =>
    ctx.bridge.executeTool({
      name: REPLAY_TOOL,
      argsJson: nudgeArgs(ctx.team, member, token),
      sessionId: ctx.sessionId,
      currentTeam: null,
    });

  // --- 1. An un-tokened gated call previews and does NOT run -----------
  const before = await enters(ctx, "be-1");
  if (before === null) {
    out.push(
      fail("replay:0-precondition", "pane be-1 is missing or keeps no receipt in this cage"),
    );
    return out;
  }
  if (before !== 0) {
    out.push(
      fail(
        "replay:0-precondition",
        `be-1 already shows ${before} Enter(s) before the scenario started`,
      ),
    );
    return out;
  }
  const step1 = await call("be-1");
  const c1 = classifyEnvelope(step1.envelopeJson);
  const token1 = step1.needsConfirmation?.token;
  out.push(
    c1.outcome === "previewed" && token1 !== undefined
      ? pass(
          "replay:1-gate-holds",
          "an un-tokened pane_nudge returned needs_confirmation with a token",
        )
      : fail(
          "replay:1-gate-holds",
          `expected needs_confirmation, got outcome=${c1.outcome} error=${c1.error} token=${token1 === undefined ? "absent" : "present"}`,
        ),
  );
  await ctx.sleep(1_000);
  const afterPreview = await enters(ctx, "be-1");
  out.push(
    afterPreview === 0
      ? pass(
          "replay:1-nothing-ran",
          "be-1 consumed 0 Enters — the preview did not execute the verb",
        )
      : fail(
          "replay:1-nothing-ran",
          `be-1 consumed ${String(afterPreview)} Enter(s) from a call that was only PREVIEWED — the gate failed open`,
        ),
  );
  if (token1 === undefined) return out;

  // --- 2. Redeeming it runs, once --------------------------------------
  log("replay: redeeming the token for be-1");
  const step2 = await call("be-1", token1);
  const c2 = classifyEnvelope(step2.envelopeJson);
  out.push(
    c2.outcome === "executed"
      ? pass("replay:2-redeem-runs", "the redeemed pane_nudge executed")
      : fail(
          "replay:2-redeem-runs",
          `expected the verb to run, got outcome=${c2.outcome} error=${c2.error} envelope=${step2.envelopeJson.slice(0, 300)}`,
        ),
  );
  const afterRedeem = await enters(ctx, "be-1");
  out.push(
    afterRedeem === 1
      ? pass("replay:2-one-enter", "be-1 consumed exactly 1 Enter — the keystroke reached the pane")
      : fail(
          "replay:2-one-enter",
          `be-1 consumed ${String(afterRedeem)} Enter(s), expected exactly 1`,
        ),
  );

  // --- 3. The SAME token again is refused ------------------------------
  log("replay: replaying the SPENT token");
  const step3 = await call("be-1", token1);
  const c3 = classifyEnvelope(step3.envelopeJson);
  out.push(
    c3.outcome === "previewed"
      ? pass(
          "replay:3-spent-token-refused",
          "the spent token did not redeem; the bridge issued a fresh preview instead",
        )
      : fail(
          "replay:3-spent-token-refused",
          `a SPENT confirmation token produced outcome=${c3.outcome} error=${c3.error} — single-use is broken`,
        ),
  );
  await ctx.sleep(1_000);
  const afterReplay = await enters(ctx, "be-1");
  out.push(
    afterReplay === 1
      ? pass(
          "replay:3-no-second-enter",
          "be-1 still shows exactly 1 Enter — the replay delivered nothing",
        )
      : fail(
          "replay:3-no-second-enter",
          `be-1 shows ${String(afterReplay)} Enter(s) after a replay; expected it to stay at 1`,
        ),
  );
  const token3 = step3.needsConfirmation?.token;
  if (token3 === undefined) {
    out.push(
      fail(
        "replay:3-reissued",
        "the refused replay returned no fresh token, so the argument-binding step cannot run",
      ),
    );
    return out;
  }

  // --- 4. A token bound to be-1 cannot redeem be-2 ---------------------
  log("replay: redeeming be-1's token against be-2's arguments");
  const step4 = await call("be-2", token3);
  const c4 = classifyEnvelope(step4.envelopeJson);
  out.push(
    c4.outcome === "previewed"
      ? pass("replay:4-args-bound", "a token minted for be-1 did not redeem a call naming be-2")
      : fail(
          "replay:4-args-bound",
          `a token bound to be-1's arguments produced outcome=${c4.outcome} error=${c4.error} on be-2 — argument binding is broken`,
        ),
  );
  await ctx.sleep(1_000);
  const be2AfterMismatch = await enters(ctx, "be-2");
  const be1AfterMismatch = await enters(ctx, "be-1");
  out.push(
    be2AfterMismatch === 0
      ? pass(
          "replay:4-be2-untouched",
          "be-2 consumed 0 Enters — the mismatched redemption typed nothing",
        )
      : fail(
          "replay:4-be2-untouched",
          `be-2 consumed ${String(be2AfterMismatch)} Enter(s) from a MISMATCHED token`,
        ),
  );
  out.push(
    be1AfterMismatch === 1
      ? pass("replay:4-be1-unchanged", "be-1 still shows exactly 1 Enter")
      : fail(
          "replay:4-be1-unchanged",
          `be-1 shows ${String(be1AfterMismatch)} Enter(s); expected 1`,
        ),
  );

  // --- 5. CONTROL — be-2 IS nudgeable, so its zero meant something -----
  const token4 = step4.needsConfirmation?.token;
  if (token4 === undefined) {
    out.push(
      fail(
        "replay:5-control",
        "the mismatch returned no fresh token, so the control cannot run and the negatives above stand unverified",
      ),
    );
    return out;
  }
  log("replay: control — nudging be-2 with the token its own mismatch minted");
  const step5 = await call("be-2", token4);
  const c5 = classifyEnvelope(step5.envelopeJson);
  out.push(
    c5.outcome === "executed"
      ? pass("replay:5-control-runs", "the freshly-minted be-2 token redeemed and the verb ran")
      : fail(
          "replay:5-control-runs",
          `the control call did not execute: outcome=${c5.outcome} error=${c5.error} envelope=${step5.envelopeJson.slice(0, 300)}`,
        ),
  );
  const be2Final = await enters(ctx, "be-2");
  out.push(
    be2Final === 1
      ? pass(
          "replay:5-control-landed",
          "be-2 consumed exactly 1 Enter — so its earlier 0 was a refusal, not an inert pane",
        )
      : fail(
          "replay:5-control-landed",
          `be-2 consumed ${String(be2Final)} Enter(s) after a legitimate nudge; every 'be-2 was untouched' assertion above is therefore unproven`,
        ),
  );
  return out;
}
