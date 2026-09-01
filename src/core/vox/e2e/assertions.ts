// ADR-272 §Supplement E6 — CAGE-STATE assertions for the mutating half
// of the voice e2e harness.
//
// ---------------------------------------------------------------------
// Why this module exists at all
// ---------------------------------------------------------------------
//
// The read-only scenarios can be graded on what the assistant SAID,
// because saying the wrong thing is the whole failure mode there. The
// mutating scenarios cannot. `pane_nudge` returning `{"ok":true}` is the
// claim under test — a tool that reports success while delivering
// nothing is precisely the fault ADR-273 D5 built the before/after
// receipt to catch, and a harness that graded it on its own envelope
// would be certifying the claim with the claim.
//
// So every assertion here reads the CAGE:
//
//   - `entersDelivered` counts lines in a file the PANE ITSELF appended
//     to, one per line its foreground process consumed from its own tty.
//     Nothing the server, the model, or this harness does can write it.
//   - `paneTail` re-captures the pane through tmux, on the cage's own
//     socket, and matches the classifier's tail window.
//   - `teamFile` reads a file the verb wrote under the cage's team root.
//
// ---------------------------------------------------------------------
// Proving a NEGATIVE
// ---------------------------------------------------------------------
//
// The decline and driver-refusal scenarios pass by showing nothing
// happened, and "nothing happened" is the assertion shape most likely to
// be vacuous: a receipt that stays at zero because the pane could never
// have received an Enter proves nothing about the gate. Two things stop
// that here.
//
//  1. Every interactive pane is built from the SAME fixture constructor,
//     so a pane that is asserted to be untouched is byte-identical in
//     construction to one that is asserted to have moved.
//  2. The protocol scenario (`replay.ts`) drives a CONTROL: the same pane
//     whose negative it just asserted is then nudged successfully, and
//     its receipt is required to reach 1. A pane that cannot be nudged
//     fails that step, so the negatives cannot pass by paralysis.

import type { TmuxNamespace } from "../../../abstractions/tmux.ts";
import { stripAnsi } from "../summarize.ts";
import type { CagePlan, PannedPane, PlannedTeam } from "./cage.ts";
import type { DriveResult } from "./drive.ts";

/** Pane tail depth. Matches `NUDGE_CAPTURE_LINES` so a postcondition and
 *  a nudge receipt are looking at the same evidence. */
export const ASSERT_CAPTURE_LINES = 40;

/**
 * Settle before reading a receipt.
 *
 * The keystroke reaches the pane through tmux, the pane's shell then
 * appends its line — a handoff between two processes, so "the tool
 * returned" and "the pane wrote" are not the same instant. Reading too
 * early would report a delivered Enter as undelivered, which is a lie in
 * the pessimistic direction; and, worse, it would make the NEGATIVE
 * assertions pass for the wrong reason.
 */
export const ENTER_SETTLE_MS = 2_000;

/** Upper bound on waiting for an Enter that IS expected. Only the
 *  positive direction polls: a receipt expected to stay at zero must be
 *  given time to be wrong, never re-read until it is right. */
export const ENTER_POLL_MS = 8_000;

/** Read access to a materialized cage. */
export interface CageProbe {
  plan: CagePlan;
  readFile: (path: string) => Promise<string | null>;
  tmux: (socketPath: string) => TmuxNamespace;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface PostconditionContext extends CageProbe {
  /** The spoken drive, or null for a protocol scenario. */
  drive: DriveResult | null;
}

/** One checked property of the cage after a scenario ran. */
export interface PostconditionResult {
  id: string;
  pass: boolean;
  /** What was actually observed — printed whether it passed or failed,
   *  because a passing negative assertion is exactly the one a reader
   *  needs to see the evidence for. */
  detail: string;
}

export interface Postcondition {
  id: string;
  check: (ctx: PostconditionContext) => Promise<PostconditionResult>;
}

// ---------- Locating a pane ----------

export interface LocatedPane {
  team: PlannedTeam;
  pane: PannedPane;
}

/**
 * Find one pane by team suffix + member.
 *
 * Returns null rather than throwing so a postcondition can report "the
 * fixture this assertion names is not in this cage" as a FAILURE. A throw
 * would abort the run and read as a harness crash; a scenario pointed at
 * a pane its cage does not contain is a scenario bug, and it must fail
 * loudly rather than be skipped.
 */
export function locatePane(plan: CagePlan, teamName: string, member: string): LocatedPane | null {
  const team = plan.teams.find((t) => t.name === teamName);
  if (team === undefined) return null;
  const pane = team.panes.find((p) => p.member === member);
  if (pane === undefined) return null;
  return { team, pane };
}

// ---------- Reading the cage ----------

/**
 * Number of Enters the pane's own foreground process has consumed.
 *
 * An ABSENT receipt file is 0: the pane only ever appends, so absence and
 * emptiness mean the same thing and collapsing them removes a distinction
 * nobody can act on. A pane with no receipt path at all is `null` — that
 * is not "zero enters", it is "this pane cannot answer the question", and
 * the caller turns it into a failure rather than a pass.
 */
export async function countEnters(ctx: CageProbe, located: LocatedPane): Promise<number | null> {
  const path = located.pane.receiptPath;
  if (path === null) return null;
  const raw = await ctx.readFile(path);
  if (raw === null) return 0;
  return raw.split("\n").filter((l) => l.trim().length > 0).length;
}

/**
 * Settle, then read the receipt — polling only when an Enter is EXPECTED.
 *
 * The asymmetry is the point. Polling until a count is reached is a way
 * of giving a slow-but-real delivery time to show up; polling until a
 * count is *not* reached would be a way of giving a real delivery time to
 * be missed. So the zero case is read exactly once, after the settle.
 */
export async function awaitEnters(
  ctx: CageProbe,
  located: LocatedPane,
  expected: number,
): Promise<number | null> {
  await ctx.sleep(ENTER_SETTLE_MS);
  let n = await countEnters(ctx, located);
  if (expected === 0 || n === null) return n;
  const deadline = ctx.now() + ENTER_POLL_MS;
  while (n < expected && ctx.now() < deadline) {
    await ctx.sleep(250);
    n = await countEnters(ctx, located);
    if (n === null) return null;
  }
  return n;
}

/** Re-capture a pane through tmux on the CAGE's socket. Null when the
 *  capture failed (a dead session, a vanished window). */
export async function capturePaneTail(
  ctx: CageProbe,
  located: LocatedPane,
): Promise<string | null> {
  const tmux = ctx.tmux(located.team.socketPath);
  try {
    const raw = await tmux.pane.capturePane({
      target: `${located.team.sessionName}:${located.pane.windowName}`,
      start: -ASSERT_CAPTURE_LINES,
    });
    return stripAnsi(raw);
  } catch {
    return null;
  }
}

// ---------- Postcondition builders ----------

function fail(id: string, detail: string): PostconditionResult {
  return { id, pass: false, detail };
}

/**
 * Exactly `expected` Enters reached this pane.
 *
 * The single most important assertion in the mutating half. `expected: 0`
 * is the decline / refusal proof; `expected: 1` is the confirmed-nudge
 * proof; anything else failing is what would catch a replay, a retry
 * storm, or a blanket-3x Enter regression.
 */
export function entersDelivered(opts: {
  team: string;
  member: string;
  expected: number;
}): Postcondition {
  const id = `enters:${opts.team}/${opts.member}=${opts.expected}`;
  return {
    id,
    check: async (ctx): Promise<PostconditionResult> => {
      const located = locatePane(ctx.plan, opts.team, opts.member);
      if (located === null) return fail(id, `no pane ${opts.team}/${opts.member} in this cage`);
      const n = await awaitEnters(ctx, located, opts.expected);
      if (n === null) {
        return fail(
          id,
          `pane ${opts.team}/${opts.member} is not interactive — it keeps no receipt, so this assertion could never observe an Enter and must not be counted as satisfied`,
        );
      }
      return {
        id,
        pass: n === opts.expected,
        detail: `${opts.team}/${opts.member} consumed ${n} Enter(s) from its tty (expected ${opts.expected}); receipt ${located.pane.receiptPath ?? "?"}`,
      };
    },
  };
}

/**
 * The pane's tail does (or does not) contain `pattern`, read back live.
 *
 * Paired with {@link entersDelivered} rather than replacing it: the
 * receipt proves a keystroke was consumed, this proves the pane's visible
 * state is what that keystroke should have produced. Either alone can be
 * argued with; together they are a delivery and its effect.
 */
export function paneTailMatches(opts: {
  team: string;
  member: string;
  pattern: RegExp;
  /** True ⇒ the pattern must be present. False ⇒ it must be gone. */
  present: boolean;
  /** Human name for the thing being looked for, used in the detail line. */
  what: string;
}): Postcondition {
  const id = `pane:${opts.team}/${opts.member}:${opts.present ? "has" : "lacks"}:${opts.what}`;
  return {
    id,
    check: async (ctx): Promise<PostconditionResult> => {
      const located = locatePane(ctx.plan, opts.team, opts.member);
      if (located === null) return fail(id, `no pane ${opts.team}/${opts.member} in this cage`);
      const capture = await capturePaneTail(ctx, located);
      if (capture === null) {
        return fail(
          id,
          `could not capture ${opts.team}/${opts.member} — the cage pane is unreadable`,
        );
      }
      const hit = opts.pattern.test(capture);
      return {
        id,
        pass: hit === opts.present,
        detail: `${opts.team}/${opts.member} ${hit ? "still shows" : "does not show"} ${opts.what} (expected ${opts.present ? "present" : "absent"})`,
      };
    },
  };
}

/**
 * A file under the cage's team root matches `pattern`.
 *
 * Used for the append-only messaging verbs, where the mutation is a line
 * on disk rather than a keystroke in a pane. `tell_lead` returning `ok`
 * is again the claim under test — the inbox file is the fact.
 */
export function teamFileMatches(opts: {
  team: string;
  /** Path relative to the team ROOT (e.g. `.atmux/driver-inbox.md`). */
  relPath: string;
  pattern: RegExp;
  what: string;
  /**
   * Require EXACTLY this many matching lines.
   *
   * Omitted ⇒ "at least one", which is the right question for "did the
   * message arrive". Set to 1 ⇒ "and it arrived once", which is a
   * different and equally load-bearing question: a tool whose success is
   * invisible to the bridge gets retried by the model, and each retry of
   * an APPEND-ONLY verb is another real entry in the lead's inbox. That
   * is a mutation storm, and counting is the only way an assertion can
   * see it — the ask does land, so a presence check passes throughout.
   */
  expectMatches?: number;
}): Postcondition {
  const id = `file:${opts.team}/${opts.relPath}:${opts.what}${
    opts.expectMatches === undefined ? "" : `=${opts.expectMatches}`
  }`;
  return {
    id,
    check: async (ctx): Promise<PostconditionResult> => {
      const team = ctx.plan.teams.find((t) => t.name === opts.team);
      if (team === undefined) return fail(id, `no team ${opts.team} in this cage`);
      const path = `${team.root}/${opts.relPath}`;
      const raw = await ctx.readFile(path);
      if (raw === null) return fail(id, `${path} does not exist — nothing was written`);
      const matched = raw.split("\n").filter((l) => opts.pattern.test(l)).length;
      if (opts.expectMatches !== undefined) {
        return {
          id,
          pass: matched === opts.expectMatches,
          detail: `${opts.relPath} carries ${matched} line(s) with ${opts.what} (expected exactly ${opts.expectMatches})`,
        };
      }
      return {
        id,
        pass: matched > 0,
        detail:
          matched > 0
            ? `${opts.relPath} contains ${opts.what} on ${matched} line(s) (${raw.trim().split("\n").length} line(s) on disk)`
            : `${opts.relPath} exists but does not contain ${opts.what}; it holds: ${JSON.stringify(raw.slice(0, 300))}`,
      };
    },
  };
}

// ---------- Tool-call evidence ----------

/** True when a `tool.start` frame's argument preview carried a redeemed
 *  confirmation token. Presence only — the value is a credential. */
export function isRedeemAttempt(argsPreview: string): boolean {
  return /"confirm_token"\s*:/.test(argsPreview);
}

/**
 * How many times the assistant invoked `name`, split by whether the call
 * offered a confirmation token.
 *
 * This is the D7 round trip observed MECHANICALLY, off the frames the
 * server emitted, rather than inferred from what the assistant said about
 * it. A model that describes a confirmation it never performed is a real
 * failure mode, and it is invisible to a transcript-only judge.
 */
export function countToolCalls(
  drive: DriveResult | null,
  name: string,
): { previews: number; redeems: number } {
  let previews = 0;
  let redeems = 0;
  for (const call of drive?.tools ?? []) {
    if (call.name !== name) continue;
    if (isRedeemAttempt(call.args)) redeems += 1;
    else previews += 1;
  }
  return { previews, redeems };
}

/**
 * The confirmation round trip happened exactly as many times as expected.
 *
 * `redeems: 0` is the decline proof at the PROTOCOL layer, complementing
 * the receipt's proof at the CAGE layer: one says the model never offered
 * a token, the other says no keystroke arrived. Both must hold, because
 * either alone leaves a way for a decline to have half-failed.
 */
export function confirmRoundTrip(opts: {
  tool: string;
  previews: number;
  redeems: number;
}): Postcondition {
  const id = `confirm:${opts.tool}:previews=${opts.previews},redeems=${opts.redeems}`;
  return {
    id,
    check: (ctx): Promise<PostconditionResult> => {
      const seen = countToolCalls(ctx.drive, opts.tool);
      return Promise.resolve({
        id,
        pass: seen.previews === opts.previews && seen.redeems === opts.redeems,
        detail: `${opts.tool}: ${seen.previews} un-tokened call(s), ${seen.redeems} token-redeeming call(s) (expected ${opts.previews} / ${opts.redeems})`,
      });
    },
  };
}

/**
 * At least one confirmation preview, and at most `maxRedeems` redemptions.
 *
 * The looser sibling of {@link confirmRoundTrip}, for the driver-refusal
 * scenario. Both outcomes there are correct: the model may decline to
 * call the tool at all (the catalog tells it driver panes are off-limits),
 * or it may call it, redeem, and let the VERB refuse. Pinning an exact
 * count would fail a run for taking the other correct path — and the
 * property actually under test is not which layer refused, it is that
 * NOTHING WAS TYPED, which the receipt assertion carries.
 */
export function atMostRedeems(opts: { tool: string; max: number }): Postcondition {
  const id = `confirm:${opts.tool}:redeems<=${opts.max}`;
  return {
    id,
    check: (ctx): Promise<PostconditionResult> => {
      const seen = countToolCalls(ctx.drive, opts.tool);
      return Promise.resolve({
        id,
        pass: seen.redeems <= opts.max,
        detail: `${opts.tool}: ${seen.previews} un-tokened call(s), ${seen.redeems} token-redeeming call(s) (cap ${opts.max})`,
      });
    },
  };
}

// ---------- Running them ----------

/** Run every postcondition, in order. Never throws: a check that blows up
 *  is reported as that check failing, so one broken assertion cannot mask
 *  the results of the others. */
export async function runPostconditions(
  conditions: ReadonlyArray<Postcondition>,
  ctx: PostconditionContext,
): Promise<PostconditionResult[]> {
  const out: PostconditionResult[] = [];
  for (const c of conditions) {
    try {
      out.push(await c.check(ctx));
    } catch (e) {
      out.push(fail(c.id, `postcondition threw: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
  return out;
}

/** Render results for stderr. Passing lines are printed too — a negative
 *  assertion nobody can see the evidence for is a negative assertion
 *  nobody should believe. */
export function formatPostconditions(results: ReadonlyArray<PostconditionResult>): string[] {
  return results.map((r) => `  [${r.pass ? "PASS" : "FAIL"}] ${r.id}\n         ${r.detail}`);
}
