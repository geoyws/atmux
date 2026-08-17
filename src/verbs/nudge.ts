// ADR-273 D4/D5: `atmux nudge` — unstick ONE member's pane, and report
// what the pane looked like afterwards.
//
// The allow-list, the after-state classifier and the receipt renderer
// live in `src/core/vox/nudge.ts` (pure, fixture-testable). THIS file
// is the IO half: resolve the member to a tmux window, read the pane,
// deliver the keystroke, read the pane again, print the receipt.
//
// ---------------------------------------------------------------------
// D5 — delivery goes through `atmux send`, never a hand-rolled send-keys
// ---------------------------------------------------------------------
//
// This verb does NOT talk to tmux to deliver anything. It builds an argv
// and calls the `send` VERB, which owns the member lookup, the ADR-135 /
// ADR-161 window-rename shim, the ADR-025 driver-pane type gate, the
// safe-send modal preflight, the bracketed-paste envelope and ADR-138's
// verify-and-retry. Going through it means the nudge path is gated by
// exactly the code the operator's own `atmux send` is gated by, not by a
// parallel implementation that can drift — the same argument ADR-272 §D2
// makes for the whole voice bridge.
//
// This is settled by evidence, not preference: on wedged panes bare
// Enter, triple-Enter, `C-m` and bracketed paste ALL failed, and the
// paste-and-submit path was the only reliable one.
//
// The only tmux this file performs is READ-ONLY — `capture-pane` and
// `display-message` for the before/after observations. Reads are not
// input injection and carry none of the guards above.
//
// ---------------------------------------------------------------------
// Why driver panes are refused UP FRONT
// ---------------------------------------------------------------------
//
// ADR-239 §D2 is absolute: atmux NEVER sends keystrokes into a driver
// pane, and `tmux.pane.sendKeys` throws `DriverSendKeysViolation` at the
// lowest level to enforce it. Most `idle-residue` findings on the live
// fleet sit on `driver` / `driver-N` windows, so this is the FIRST thing
// an operator will try — and a refusal that surfaces as a deep
// abstraction throw reads like a bug rather than like a rule. The check
// below is the same predicate the runtime guard uses, run early so the
// spoken answer is "that pane is yours, I will not type into it".

import { now as nowMs } from "../abstractions/time.ts";
import { createTmux, type TmuxNamespace } from "../abstractions/tmux.ts";
import {
  getSessionName,
  type ResolveDirOpts,
  requireTeam,
  resolveTeamSocket,
} from "../core/common.ts";
import { isDriverPaneName } from "../core/drivers.ts";
import {
  classifyPaneObservation,
  type PaneObservation,
  type PaneVerdict,
} from "../core/vox/fleet.ts";
import {
  classifyAfterNudge,
  isNudgeAction,
  NUDGE_ACTION_SPECS,
  NUDGE_ACTIONS,
  type NudgeAction,
  type NudgeReceipt,
  nudgeDidNotTake,
  renderNudgeReceipt,
} from "../core/vox/nudge.ts";
import { ConfigError, UsageError } from "../errors.ts";
import { parseWindowProbe, WINDOW_PROBE_FORMAT } from "./fleet.ts";
import { resolveMemberTarget, send as sendVerb } from "./send.ts";

const USAGE =
  `atmux nudge --member <name> [--action ${NUDGE_ACTIONS.join("|")}] ` +
  "[--team-dir <dir>] [--socket <path>] [--settle-ms <n>] [--json]";

/** Pane tail captured for the before/after observations. Same depth the
 *  fleet sweep uses, so both classifiers see the same evidence. */
export const NUDGE_CAPTURE_LINES = 40;

/**
 * How long to wait between the delivery returning and the after-read.
 *
 * `atmux send`'s own verify leg already sleeps ~2s and re-captures, so by
 * the time it returns the pane has usually settled. This is the margin on
 * top: a Claude TUI takes a beat to clear its composer and paint the
 * first turn glyph, and reading before that repaint would report a pane
 * that had in fact moved as "unchanged" — the receipt lying in the
 * pessimistic direction, which is less dangerous than the optimistic one
 * but still a lie.
 */
export const NUDGE_SETTLE_MS_DEFAULT = 1_500;

// ---------- Args ----------

export interface NudgeArgs {
  member: string;
  /**
   * RAW action name, deliberately unvalidated by the parser.
   *
   * Validation happens in {@link nudge} against {@link NUDGE_ACTIONS}.
   * Keeping the parser dumb is what makes `--action` a safe `flag-value`
   * argv slot in the ADR-272 D2 §Supplement audit: the parser reads
   * `argv[i + 1]` unconditionally, so a dash-led value is DATA and can
   * never be re-read as a flag. A parser that validated here would throw
   * on the hostile probe instead of carrying it, and the structural gate
   * could no longer prove the slot is safe.
   */
  action: string;
  teamDir?: string;
  socketPath?: string;
  settleMs: number;
  json: boolean;
}

function requireValue(argv: ReadonlyArray<string>, i: number, flag: string): string {
  const v = argv[i + 1];
  if (v === undefined) {
    throw new UsageError({ what: `nudge: ${flag} requires a value`, hint: USAGE });
  }
  return v;
}

/** Pure argv parser. `--action` defaults to `submit`. */
export function parseNudgeArgs(argv: ReadonlyArray<string>): NudgeArgs {
  let member: string | undefined;
  let action = "submit";
  let teamDir: string | undefined;
  let socketPath: string | undefined;
  let settleMs = NUDGE_SETTLE_MS_DEFAULT;
  let json = false;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--member") {
      member = requireValue(argv, i, "--member");
      i += 2;
      continue;
    }
    if (a === "--action") {
      action = requireValue(argv, i, "--action");
      i += 2;
      continue;
    }
    if (a === "--team-dir") {
      teamDir = requireValue(argv, i, "--team-dir");
      i += 2;
      continue;
    }
    if (a === "--socket") {
      socketPath = requireValue(argv, i, "--socket");
      i += 2;
      continue;
    }
    if (a === "--settle-ms") {
      const raw = requireValue(argv, i, "--settle-ms");
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) {
        throw new UsageError({
          what: `nudge: --settle-ms must be a non-negative integer, got '${raw}'`,
          hint: USAGE,
        });
      }
      settleMs = n;
      i += 2;
      continue;
    }
    if (a === "--json") {
      json = true;
      i += 1;
      continue;
    }
    throw new UsageError({ what: `nudge: unknown arg: ${a ?? ""}`, hint: USAGE });
  }
  if (member === undefined || member.length === 0) {
    throw new UsageError({ what: "nudge: --member is required", hint: USAGE });
  }
  const out: NudgeArgs = { member, action, settleMs, json };
  if (teamDir !== undefined) out.teamDir = teamDir;
  if (socketPath !== undefined) out.socketPath = socketPath;
  return out;
}

/**
 * The argv this verb hands to `send`.
 *
 * `--team-dir` and every other flag lead, and the member is the FIRST
 * positional — `parseSendArgs` breaks its flag loop at the first
 * non-flag token, so a flag placed after the member would be swallowed
 * into the message body instead of parsed.
 *
 * `submit` renders `--submit-only` with NO message. `continue` renders
 * the canned constant from {@link NUDGE_ACTION_SPECS}, which is a
 * compile-time string — nothing an operator said reaches this argv.
 */
export function buildSendArgv(opts: {
  member: string;
  action: NudgeAction;
  teamDir?: string;
  socketPath?: string;
}): string[] {
  const spec = NUDGE_ACTION_SPECS[opts.action];
  const flags: string[] = [];
  if (opts.teamDir !== undefined) flags.push("--team-dir", opts.teamDir);
  if (opts.socketPath !== undefined) flags.push("--socket", opts.socketPath);
  if (spec.text === null) return [...flags, "--submit-only", opts.member];
  return [...flags, opts.member, spec.text];
}

// ---------- Deps ----------

export interface NudgeDeps {
  /** The delivery path. Defaults to the `send` VERB — see the file
   *  header for why it is the verb and not `sendToMember`. */
  send?: (argv: ReadonlyArray<string>) => Promise<number>;
  /** Socket-pinned tmux factory (read-only use here). */
  tmux?: (socketPath: string) => TmuxNamespace;
  /** ms clock. */
  now?: () => number;
  /** Settle sleeper (injected so a test need not really wait). */
  sleep?: (ms: number) => Promise<void>;
  /** stdout sink. */
  logger?: { log: (m: string) => void };
}

function realSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function stdoutLog(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Default socket-pinned tmux namespace. Named rather than inlined so
 *  the production wiring is reachable from a test without a tmux server
 *  — `createTmux` only closes over the socket, it starts nothing. */
export function defaultNudgeTmux(socketPath: string): TmuxNamespace {
  return createTmux({ socketPath });
}

/**
 * Read one pane and build the observation the classifier consumes.
 *
 * Identical in shape to the fleet sweep's per-window read (same probe
 * format, same capture depth, same fail-soft posture on the probe), so a
 * nudge receipt and a `fleet_attention` finding cannot describe the same
 * pane in two different vocabularies.
 */
export async function observePane(opts: {
  tmux: TmuxNamespace;
  target: string;
  team: string;
  member: string;
  windowName: string;
  nowSec: number;
}): Promise<PaneObservation> {
  const { tmux, target, nowSec } = opts;
  let probe = { activityAgeSec: null, paneDead: null, currentCommand: null } as ReturnType<
    typeof parseWindowProbe
  >;
  try {
    probe = parseWindowProbe(
      await tmux.pane.displayMessage({ target, format: WINDOW_PROBE_FORMAT }),
      nowSec,
    );
  } catch {
    // A failed probe is not a failed pane — the capture below still
    // classifies, and a null clock makes the classifier fall back on
    // pane text alone, which it is written to tolerate.
  }
  let capture: string | null = null;
  try {
    capture = await tmux.pane.capturePane({ target, start: -NUDGE_CAPTURE_LINES });
  } catch {
    capture = null;
  }
  return {
    team: opts.team,
    member: opts.member,
    windowName: opts.windowName,
    // Both TRUE by construction rather than by observation:
    // `resolveMemberTarget` already threw if neither the canonical nor
    // any legacy window existed, so reaching here means the window was
    // there. If it vanishes between the two reads, `capturePane` throws,
    // `capture` is null, and the classifier reports `unreadable` — so
    // the shortcut can never manufacture a healthy verdict, only lose
    // the more specific `dead` label for a pane that died mid-nudge.
    sessionUp: true,
    windowPresent: true,
    capture,
    paneDead: probe.paneDead,
    currentCommand: probe.currentCommand,
    activityAgeSec: probe.activityAgeSec,
  };
}

// ---------- Verb entry ----------

/**
 * `atmux nudge --member <name> [--action submit|continue]`.
 *
 * Exit codes carry the VERDICT, not merely whether a send was issued:
 *
 * - **0** — delivered, and the pane moved.
 * - **1** — delivered, and the pane is byte-for-byte in the same
 *   classified state it was in before. "I pressed Enter" is a claim;
 *   this is the receipt saying the claim bought nothing, and it must not
 *   read as success in a shell or in a spoken tool envelope.
 * - **`UsageError` (64)** — bad argv, or an action outside the
 *   allow-list.
 * - **`ConfigError` (78)** — a driver pane (ADR-239 §D2) or a member the
 *   roster does not carry.
 *
 * A delivery failure (missing window, tmux error) PROPAGATES rather than
 * being folded into a receipt: a receipt describes a nudge that happened.
 */
export async function nudge(argv: ReadonlyArray<string>, deps: NudgeDeps = {}): Promise<number> {
  const args = parseNudgeArgs(argv);
  if (!isNudgeAction(args.action)) {
    throw new UsageError({
      what: `nudge: unknown action '${args.action}'`,
      hint: `--action must be one of: ${NUDGE_ACTIONS.join(", ")} (the allow-list is fixed in code; nudge never sends free text)`,
    });
  }
  const action: NudgeAction = args.action;

  // ADR-239 §D2 — refused here rather than 4 layers down. See header.
  if (isDriverPaneName(args.member)) {
    throw new ConfigError({
      what: `nudge: refusing to nudge driver pane '${args.member}' — ADR-239 §D2: atmux never sends keystrokes into a driver pane`,
      hint: "driver panes are operator-interactive only; nudge a member or lead pane, or press Enter in that pane yourself",
    });
  }

  const dirOpts: ResolveDirOpts = {};
  if (args.teamDir !== undefined) dirOpts.teamDir = args.teamDir;
  const team = await requireTeam(dirOpts);
  const memberEntry = team.members.find((m) => m.name === args.member);
  if (memberEntry === undefined) {
    throw new ConfigError({
      what: `nudge: no such member in team.json: ${args.member}`,
      hint: "run 'atmux status' to list members — a tmux window the roster never heard of cannot be nudged, because 'atmux send' addresses roster members",
    });
  }

  const now = deps.now ?? nowMs;
  const sleep = deps.sleep ?? realSleep;
  const logger = deps.logger ?? { log: stdoutLog };
  const sendFn = deps.send ?? sendVerb;

  const sessionName = await getSessionName({ ...dirOpts, team });
  const socketPath = args.socketPath ?? resolveTeamSocket(team);
  const tmux = (deps.tmux ?? defaultNudgeTmux)(socketPath);
  const target = await resolveMemberTarget(
    tmux,
    sessionName,
    memberEntry.name,
    memberEntry.emoji,
    memberEntry.label,
    memberEntry.role,
  );
  const windowName = target.slice(sessionName.length + 1);

  const observeOpts = {
    tmux,
    target,
    team: team.name,
    member: memberEntry.name,
    windowName,
  };
  const before: PaneVerdict = classifyPaneObservation(
    await observePane({ ...observeOpts, nowSec: Math.floor(now() / 1000) }),
  );

  const sendArgv = buildSendArgv({
    member: memberEntry.name,
    action,
    ...(args.teamDir !== undefined ? { teamDir: args.teamDir } : {}),
    ...(args.socketPath !== undefined ? { socketPath: args.socketPath } : {}),
  });
  await sendFn(sendArgv);
  await sleep(args.settleMs);

  // `classifyAfterNudge`, NOT the bare fleet classifier: the fresh
  // activity this read sees is OUR paste, and the survey classifier
  // reads fresh-activity-plus-residue as "someone is typing". See its
  // doc comment — this is the difference between a receipt and a lie.
  const after: PaneVerdict = classifyAfterNudge(
    await observePane({ ...observeOpts, nowSec: Math.floor(now() / 1000) }),
  );

  const receipt: NudgeReceipt = {
    team: team.name,
    member: memberEntry.name,
    windowName,
    action,
    before,
    after,
  };
  logger.log(args.json ? JSON.stringify(receipt, null, 2) : renderNudgeReceipt(receipt));
  return nudgeDidNotTake(receipt) ? 1 : 0;
}
