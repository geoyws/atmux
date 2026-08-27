// Per c-8ecd3a61 / t-74273200: canonical 4-state cage-state taxonomy
// shared by `atmux status` + `atmux doctor`.
//
// Before this module landed, status.ts checked `pane_current_command`
// which is empty when a claude TUI is at the welcome screen — so the
// pane reported `(down)` even though `claude` was alive in the pane's
// process tree. The operator + driver got conflicting signals between
// `atmux status` (down) and `atmux doctor` (which already knew better
// via ADR-081 §D's per-member-cage probe).
//
// This module unifies the two probes under a single 4-state vocabulary:
//
//   down          — no tmux session OR pane window missing OR no
//                   `claude` exec in the pane's child-process tree.
//   bootstrapping — claude PID alive in the pane tree, but tokens have
//                   never moved (welcome banner, first-input pending,
//                   or fresh `/clear` mid-render).
//   active        — claude PID alive AND tokens have moved (the pane is
//                   demonstrably running a turn or has produced output).
//   wedged        — claude PID alive AND tokens have moved AT SOME
//                   POINT, but the pane is now stuck: rate-limit
//                   lockout, a heartbeat staler than the 2h ceiling,
//                   or a compaction that hasn't completed inside its
//                   own budget.
//
// `atmux status` surfaces the state per-member (text + JSON). `atmux
// doctor`'s `checkMemberCageStates` delegates to this probe and applies
// its existing yellow/silent row policy (down + wedged always yellow;
// bootstrapping yellow only above the ADR-081 §D staleness threshold;
// active silent).
//
// ---------------------------------------------------------------------
// ADR-273 §Supplement-6 — the SECOND verdict, from the SAME evidence
// ---------------------------------------------------------------------
//
// The taxonomy above answers "is the process there and has it produced
// output". That is a real question, and `down` is exactly what an operator
// wants to hear when a cage has died. It is not, however, the question an
// operator asks out loud: `active` is true of a pane blocked forever on a
// permission prompt, and read aloud "active" means "working fine" to a
// human listener.
//
// So this probe now returns BOTH: `CageHealth.state` (process) and
// `CageHealth.agentState` (behaviour, from
// `classifyPaneObservation` — the classifier `fleet_attention` already
// uses). Both are computed from ONE pane capture and ONE window probe, in
// this function, deliberately: `team_status` and `fleet_attention`
// disagreeing about the same pane was the defect ADR-273 §Supplement-5 W6
// recorded, and two probes over one pane is how that defect comes back.

import type { SpawnResult } from "../abstractions/spawn.ts";
import { spawn as defaultSpawn } from "../abstractions/spawn.ts";
import { now } from "../abstractions/time.ts";
import { createTmux, exactSessionTarget, type TmuxNamespace } from "../abstractions/tmux.ts";
import type { Team, TeamMember } from "../schema/team.ts";
import {
  buildWindowName,
  buildWindowNameLegacy,
  defaultEmojiForRole,
  resolveTeamSocket,
} from "./common.ts";
import { readHeartbeat } from "./heartbeat.ts";
import { classifyText, type PaneState } from "./pane-state.ts";
import {
  classifyPaneObservation,
  type PaneObservation,
  type PaneVerdict,
  parseWindowProbe,
  WINDOW_PROBE_FORMAT,
  type WindowProbe,
} from "./vox/fleet.ts";

// ---------- Public type ----------

/**
 * The canonical 4-state cage-state taxonomy per t-74273200 / c-8ecd3a61.
 *
 * Shared between `atmux status` + `atmux doctor` so the operator never
 * sees the two verbs disagreeing on a member's state. Doctor applies a
 * row-surfacing policy on top of this state (e.g. silent `bootstrapping`
 * for transient panes under the 60s `STARVING_THRESHOLD_S`); the state
 * label itself stays identical.
 */
export type CageState = "down" | "bootstrapping" | "active" | "wedged";

/**
 * Wedged-detection threshold — claude PID alive + tokens moved at some
 * point, but the supervisor's per-member heartbeat hasn't been written
 * (or refreshed) within `WEDGED_HEARTBEAT_STALE_SEC` seconds. Matches
 * the task body's "no whip activity >2h" criterion. When no heartbeat
 * file exists at all, the probe falls back on pane-classifier RATE-LIMIT
 * detection — the heartbeat write path is bash-side today (per
 * `core/heartbeat.ts` header) so the file-absent case is the common one.
 */
export const WEDGED_HEARTBEAT_STALE_SEC = 7200;

/**
 * Staleness threshold for the ADR-081 §D bootstrapping → "starving"
 * sub-state. Doctor still applies this gate when deciding row colour
 * (silent vs yellow). The state taxonomy itself does NOT subdivide
 * bootstrapping by uptime — that policy is doctor-specific, not part
 * of the shared vocabulary.
 *
 * Re-exported from this module (rather than only from doctor.ts) so
 * callers reaching for the canonical constant have one import surface.
 */
export const STARVING_THRESHOLD_S = 60;

export interface CageHealth {
  /** Roster member name (`team.members[].name`). */
  member: string;
  /** Resolved tmux window name (post-ADR-017 + ADR-136). */
  windowName: string;
  /** Classifier verdict. */
  state: CageState;
  /** Pane process uptime in seconds, or `null` when `ps` probe failed.
   *  Drives doctor's bootstrapping → starving surfacing decision. */
  paneUptimeSec: number | null;
  /** Last ≤200 chars of the pane capture. Empty when state === "down"
   *  (no pane to capture). */
  evidence: string;
  /** Heartbeat age (seconds since supervisor write), or `null` when
   *  the heartbeat file is absent or unparseable. Surface this for
   *  the operator-visible "why is it wedged" line. */
  heartbeatAgeSec: number | null;
  /**
   * True when this `state` was read off the pane's RENDER without ever
   * identifying a `claude` process in its tree — the ladder believed the
   * screen because `ps` had nothing to say.
   *
   * This is the probe's own uncertainty, exposed rather than hidden. It is
   * set ONLY on non-`down` rows, and deliberately so: a `down` row is
   * reached when the process probe and the pane render AGREE that nothing
   * is there, which is a confident conclusion, not a hedge. Flagging it
   * would advertise doubt that the probe does not have.
   *
   * Callers that SPEAK their output must surface it. `team_status` is a
   * voice tool: an operator hearing "docs is working" deserves to know
   * whether that was measured or inferred, and a tool with no way to say
   * "I could not tell" is one that eventually gets ignored (ADR-273 §D3).
   *
   * Optional so the many injected probe stubs across the suite stay valid;
   * {@link probeCageState} sets it on every path it applies to. Absent
   * means "this state was not inferred" — never "unknown".
   */
  inferredFromRender?: boolean;
  /**
   * The BEHAVIOURAL verdict for the same pane, from
   * {@link classifyPaneObservation} — the classifier `fleet_attention`
   * speaks. Alongside {@link CageHealth.state}, never instead of it: the
   * two answer different questions and both are worth having.
   *
   * Computed from the SAME capture and the SAME window probe that produced
   * `state`, in {@link probeCageState}. That is the whole point (ADR-273
   * §Supplement-6): one pane, one read, two verdicts that cannot drift,
   * rather than two probes whose answers an operator has to reconcile.
   *
   * Optional so injected probe stubs stay valid. Absent means the caller
   * stubbed the probe or the pane was never observed — never "the pane is
   * fine".
   */
  agentState?: PaneVerdict;
}

// ---------- Public API ----------

/** Spawn injection — defaults to the abstractions/spawn implementation
 *  but tests pass a stub that synthesizes `ps`/`pgrep` output. */
export type ChildExecProbe = (panePid: number) => Promise<boolean>;

export interface ProbeCageStateOpts {
  /** Override the tmux client. Default: `createTmux({ socketPath })`. */
  tmux?: TmuxNamespace;
  /** Test override for `tmux.session.hasSession`. */
  hasSession?: (name: string, socketPath: string) => Promise<boolean>;
  /** Probe override: "is `claude` in this pane PID's child tree?"
   *  Default uses `ps --ppid <panePid> -o comm=` and matches `claude`. */
  paneChildIsClaude?: ChildExecProbe;
  /** Wall-clock injection (seconds). Default: `Math.floor(now()/1000)`. */
  nowSec?: () => number;
  /** Heartbeat read override — defaults to {@link readHeartbeat}.
   *  Allows tests to simulate heartbeat staleness without writing
   *  files. */
  readHeartbeat?: (atmuxDir: string, member: string) => Promise<number | null>;
  /**
   * The team's ACTUAL tmux session name (ADR-273 D3 trap 1).
   *
   * Without it the probe falls back to `atmux-<team.name>`, which is only
   * right for a team that has no `.atmux/state/session.txt` anchor. Teams
   * DO anchor: on the live fleet `unum` anchors to `atmux_unum`
   * (underscore) and `atmux` to bare `atmux`, so the fallback names a
   * session that does not exist and step (1) below reports every member
   * of a healthy team as `down`.
   *
   * Reporting a live team as dead is exactly the failure that trains an
   * operator to ignore the tool, so callers that can resolve the name —
   * `getSessionName` for a single team, `resolveCageSessionName` for a
   * cockpit entry — MUST pass it. The default is kept only so existing
   * callers keep compiling; it is not correct, merely unchanged.
   */
  sessionName?: string;
  /**
   * The window names tmux ACTUALLY reports on `sessionName`.
   *
   * This probe used to SYNTHESIZE its target window name and never check
   * it against reality: it took `member.emoji ?? defaultEmojiForRole(...)`
   * and built `🐝-be-1` for a roster entry carrying no emoji at all. On a
   * cage whose windows are plainly named `be-1` / `fe-1` / `docs`,
   * `list-panes -t <session>:🐝-be-1` answers `can't find window` and step
   * (2) below reports a live, working pane as `down` — on the line under a
   * session it has just called `[up]`.
   *
   * `atmux fleet` never had the bug because it ENUMERATES: it reads the
   * window list off the same socket and uses the names tmux gives it. This
   * seam brings the same discipline here — see
   * {@link resolveCageWindowName} for the resolution order and
   * {@link cageWindowCandidates} for the forms it accepts.
   *
   * Defaults to `tmux.window.listWindows(sessionName)`. Callers probing a
   * whole roster should hoist ONE call and hand the same names to every
   * member rather than paying a `list-windows` per member.
   */
  listWindowNames?: (sessionName: string) => Promise<ReadonlyArray<string>>;
  /**
   * The three independent window signals the BEHAVIOURAL classifier needs
   * (ADR-273 §Supplement-6): tmux's activity clock, `#{pane_dead}`, and
   * `#{pane_current_command}`.
   *
   * Defaults to one `display-message` against the resolved target. Callers
   * that already read those signals for their own columns MUST pass what
   * they read rather than letting this fire a second time — `atmux status`
   * needs `#{pane_current_command}` anyway, so it reads all three once and
   * hands them down. Two reads of one pane is how the two verdicts start
   * disagreeing again.
   *
   * Failure degrades to all-`null`, which the classifier tolerates by
   * design (it falls back on the pane text alone).
   */
  windowProbe?: (target: string) => Promise<WindowProbe>;
}

/**
 * Every window name a member's pane could legitimately be sitting under,
 * most-canonical first.
 *
 * `canonical` is what `start.ts` WOULD have spawned — the roster's pinned
 * emoji when it has one, else the role default — so an unresolvable probe
 * keeps naming the shape the operator would go looking for. `all` adds the
 * forms a window can carry when this process did not create it:
 *
 *   - the roster read VERBATIM. A roster with no `emoji` names a BARE
 *     window (`be-1`), which is what any cage built outside `atmux start`
 *     has — the voice e2e harness, a hand-made session, a team whose
 *     `start.ts` emoji write-back never landed.
 *   - the ADR-135 hyphen form, for default-role members spawned before
 *     ADR-161 flipped them to `_`.
 *   - the pre-ADR-135 no-separator form.
 *   - the bare member id, for a labelled member whose window predates the
 *     ADR-136 label.
 *
 * Pure: this is the whole naming contract in one testable list.
 */
export function cageWindowCandidates(member: TeamMember): {
  canonical: string;
  all: ReadonlyArray<string>;
} {
  const role = member.role ?? "member";
  const rosterEmoji = member.emoji;
  const spawnEmoji = rosterEmoji ?? defaultEmojiForRole(role);
  const label = member.label;
  const canonical = buildWindowName(member.name, spawnEmoji, label, role);
  const all = [
    canonical,
    buildWindowName(member.name, rosterEmoji, label, role),
    buildWindowName(member.name, spawnEmoji, label),
    buildWindowName(member.name, rosterEmoji, label),
    buildWindowNameLegacy(member.name, spawnEmoji),
    buildWindowNameLegacy(member.name, rosterEmoji),
    member.name,
  ];
  // `member.name` is schema-non-empty, so every form above is too — no
  // empty-string filter, which would only ever be dead defensive code.
  return { canonical, all: [...new Set(all)] };
}

/**
 * Pick the window this member's pane is actually in.
 *
 * First candidate present in the live window list wins; ordering therefore
 * only decides ties, and a tie means both an atmux-spawned window and a
 * legacy one exist — in which case the atmux-spawned one is the right
 * answer. When the list cannot be read at all, fall back to `canonical`:
 * the caller is about to report `down` anyway, and naming the form it
 * would have spawned is the message an operator can act on.
 */
export async function resolveCageWindowName(
  sessionName: string,
  member: TeamMember,
  listWindowNames: (sessionName: string) => Promise<ReadonlyArray<string>>,
): Promise<string> {
  const { canonical, all } = cageWindowCandidates(member);
  let live: ReadonlyArray<string>;
  try {
    live = await listWindowNames(sessionName);
  } catch {
    return canonical;
  }
  const set = new Set(live);
  for (const candidate of all) {
    if (set.has(candidate)) return candidate;
  }
  return canonical;
}

/**
 * Probe a single member's cage state. Pure modulo IO — every IO call
 * is gated through `opts` for tests. Returns a `CageHealth` row;
 * callers (status / doctor) decide presentation.
 *
 * Probe order matches the state ladder (cheapest to costliest, fail-
 * fast on the first definitive signal):
 *
 *   1. session missing → `down`
 *   2. pane window missing → `down`
 *   3. no `claude` in pane's child tree → `down`
 *   4. pane classifier text shows RATE-LIMIT → `wedged`
 *   5. tokens NOT moved (no `\d+k tokens` shape) → `bootstrapping`
 *   6. heartbeat age > {@link WEDGED_HEARTBEAT_STALE_SEC} → `wedged`
 *   7. otherwise → `active`
 *
 * The probe deliberately keeps `bootstrapping` undivided by uptime —
 * the doctor-side ADR-081 §D "starving" sub-classification lives in
 * the row-surfacing layer, not here.
 */
export async function probeCageState(
  team: Team,
  member: TeamMember,
  atmuxDir: string,
  opts: ProbeCageStateOpts = {},
): Promise<CageHealth> {
  const socketPath = resolveTeamSocket(team);
  // ADR-273 D3 trap 1 — the anchor-aware name when the caller could
  // resolve one, else the bare-name default (e-419553c6: session names
  // dropped the `atmux-` prefix). See `ProbeCageStateOpts`.
  const sessionName = opts.sessionName ?? team.name;
  const tmux = opts.tmux ?? createTmux({ socketPath });
  const hasSession =
    opts.hasSession ??
    // `=`-anchored: bare session names (e-419553c6) prefix-collide —
    // `-t sopx` would match a `sopx-guild` session (t-0dbfe104 class).
    (async (name: string, _sock: string) => tmux.session.hasSession(exactSessionTarget(name)));
  const childIsClaude = opts.paneChildIsClaude ?? defaultPaneChildIsClaude;
  const nowSec = opts.nowSec ?? (() => Math.floor(now() / 1000));
  const readHb = opts.readHeartbeat ?? readHeartbeat;

  // The spawn-side form (`start.ts` builds the same string) is only a
  // GUESS about a cage this process may not have created. It is the
  // fallback, not the target — see `cageWindowCandidates`.
  const { canonical } = cageWindowCandidates(member);

  /** Behavioural verdict for a pane this probe never got to look at.
   *  Routed through the shared classifier rather than hand-written so the
   *  words match `fleet_attention`'s by construction. */
  const unobserved = (windowName: string, sessionUp: boolean): PaneVerdict =>
    classifyPaneObservation({
      team: team.name,
      member: member.name,
      windowName,
      sessionUp,
      windowPresent: false,
      capture: null,
      paneDead: null,
      currentCommand: null,
      activityAgeSec: null,
    });

  // (1) session present?
  if (!(await hasSession(sessionName, socketPath))) {
    return {
      member: member.name,
      windowName: canonical,
      state: "down",
      paneUptimeSec: null,
      evidence: "",
      heartbeatAgeSec: null,
      agentState: unobserved(canonical, false),
    };
  }

  // The window the member's pane is ACTUALLY in, read off the same socket
  // rather than assumed. Guessing here is what made `atmux status` call
  // live panes `down` one line under a session it called `[up]`.
  const listWindows =
    opts.listWindowNames ??
    (async (s: string) => (await tmux.window.listWindows(s)).map((w) => w.name));
  const windowName = await resolveCageWindowName(sessionName, member, listWindows);
  const target = `${sessionName}:${windowName}`;

  // (2) pane window present + pane PID?
  let panePid: number | null = null;
  try {
    const panes = await tmux.pane.listPanes(target);
    panePid = panes[0]?.pid ?? null;
  } catch {
    return {
      member: member.name,
      windowName,
      state: "down",
      paneUptimeSec: null,
      evidence: "",
      heartbeatAgeSec: null,
      agentState: unobserved(windowName, true),
    };
  }
  if (panePid === null) {
    return {
      member: member.name,
      windowName,
      state: "down",
      paneUptimeSec: null,
      evidence: "",
      heartbeatAgeSec: null,
      agentState: unobserved(windowName, true),
    };
  }

  // (3) claude exec in child tree?
  let hasClaude = false;
  try {
    hasClaude = await childIsClaude(panePid);
  } catch {
    // `ps`/`pgrep` failure → not confirmed. Whether that becomes `down`
    // is decided below, against the pane's own render.
    hasClaude = false;
  }

  // Capture pane text ONCE. It feeds three consumers — the process
  // ladder's `classifyText`, the tokens-moved regex, and the behavioural
  // classifier below. `null` (capture failed) is preserved for the last of
  // those and flattened to `""` for the first two, which is what they have
  // always seen: a failed capture must not silently become "a pane showing
  // nothing", which is a different claim.
  const captured = await tryCapture(tmux, target);
  const text = captured ?? "";
  const paneUptimeSec = await readPaneUptimeSec(panePid);
  const evidence = text.slice(-200);
  const classification = classifyText(text);

  // The independent window signals (activity clock / pane_dead /
  // current command). ONE read, shared — see `ProbeCageStateOpts.windowProbe`.
  const probeWindow = opts.windowProbe ?? ((t: string) => defaultWindowProbe(tmux, t, nowSec()));
  let window: WindowProbe = { activityAgeSec: null, paneDead: null, currentCommand: null };
  try {
    window = await probeWindow(target);
  } catch {
    // A failed signal read is not a failed pane: the classifier is written
    // to fall back on the pane text alone.
  }

  const observation: PaneObservation = {
    team: team.name,
    member: member.name,
    windowName,
    sessionUp: true,
    windowPresent: true,
    capture: captured,
    paneDead: window.paneDead,
    currentCommand: window.currentCommand,
    activityAgeSec: window.activityAgeSec,
  };
  const agentState = classifyPaneObservation(observation);

  // (3b) POSITIVE EVIDENCE OUTRANKS ABSENCE OF EVIDENCE.
  //
  // A failed child probe used to return `down` outright, ahead of every
  // text-based rung below. That let the weakest signal in the ladder veto
  // the strongest ones: `ps` returning nothing is *absence of evidence*
  // (it walks one level of children, it can be denied, and a TUI that
  // `exec`s over its shell leaves no child at all), while a pane
  // rendering a permission modal or a live-turn spinner is *direct
  // evidence* that an agent is sitting there. Every other observer in
  // this codebase — `vox/fleet.ts`, `pane-state.ts`, whip, lane-tick —
  // reads that render and believes it. This probe was the lone dissenter,
  // and it dissented with the most alarming word it has.
  //
  // So `down` now requires the two signals to AGREE: no identifiable
  // claude process AND nothing agent-shaped on screen. When they
  // disagree, the ladder continues and `inferredFromRender` records that
  // the occupant was never identified — see {@link CageHealth}. That is
  // the difference between "I looked and it is dead" and "I could not
  // tell", which a voice tool must be able to say out loud.
  if (!hasClaude && !isAgentPane(classification.state)) {
    return {
      member: member.name,
      windowName,
      state: "down",
      paneUptimeSec,
      evidence,
      heartbeatAgeSec: null,
      agentState,
    };
  }
  const inferredFromRender = !hasClaude;

  // (4) rate-limit pane → wedged. The classifier's RATE-LIMIT pattern
  // hits "hit your limit" / "You've hit your limit" — both are
  // deterministic markers of a stuck claude that won't make forward
  // progress until budget reset.
  if (classification.state === "RATE-LIMIT") {
    const hbEpoch = await readHb(atmuxDir, member.name);
    const heartbeatAgeSec = hbEpoch !== null ? Math.max(0, nowSec() - hbEpoch) : null;
    return {
      member: member.name,
      windowName,
      state: "wedged",
      paneUptimeSec,
      evidence,
      heartbeatAgeSec,
      inferredFromRender,
      agentState,
    };
  }

  // (5) tokens not moved → bootstrapping. Same regex as ADR-081 §C
  // boot-claude module — `<int>k tokens` / `tokens · <int>%`.
  //
  // `TOKENS_MOVED_RE` reads the STATUS-LINE FOOTER, which is one proxy for
  // "this session has produced output" and a leaky one: a permission modal
  // or a long tool trace pushes the footer out of the captured window, and
  // the pane then reads `bootstrapping` — "claude alive but tokens have
  // never moved" — about a session that has demonstrably been working. The
  // classifier holds the other proof: BUSY / MODAL / TYPING / COMPACTING
  // are renderings the TUI only draws AFTER a turn has begun. READY is
  // deliberately excluded — a bare compose prompt is what a genuinely
  // bootstrapping pane looks like.
  //
  // Same principle as (3b): positive evidence outranks a missing proxy.
  if (!TOKENS_MOVED_RE.test(text) && !hasProducedOutput(classification.state)) {
    return {
      member: member.name,
      windowName,
      state: "bootstrapping",
      paneUptimeSec,
      evidence,
      heartbeatAgeSec: null,
      inferredFromRender,
      agentState,
    };
  }

  // (6) heartbeat stale → wedged. Heartbeat write path is bash-side
  // today; when the file is absent we skip the heartbeat ladder
  // entirely (don't false-flag a healthy team as wedged just because
  // the supervisor never wrote heartbeats).
  const hbEpoch = await readHb(atmuxDir, member.name);
  if (hbEpoch !== null) {
    const ageSec = Math.max(0, nowSec() - hbEpoch);
    if (ageSec > WEDGED_HEARTBEAT_STALE_SEC) {
      return {
        member: member.name,
        windowName,
        state: "wedged",
        paneUptimeSec,
        evidence,
        heartbeatAgeSec: ageSec,
        inferredFromRender,
        agentState,
      };
    }
    return {
      member: member.name,
      windowName,
      state: "active",
      paneUptimeSec,
      evidence,
      heartbeatAgeSec: ageSec,
      inferredFromRender,
      agentState,
    };
  }

  // (7) active fallthrough.
  return {
    member: member.name,
    windowName,
    state: "active",
    paneUptimeSec,
    evidence,
    heartbeatAgeSec: null,
    inferredFromRender,
    agentState,
  };
}

// ---------- Internals ----------

/**
 * Does this pane's own render show a Claude Code TUI?
 *
 * `SHELL` (the TUI died back to a prompt) and `UNKNOWN` (nothing matched)
 * are the two states that carry NO agent signal — everything else in the
 * catalog is a shape only the TUI draws. Deliberately expressed as "which
 * states mean no agent" rather than "which mean agent": a new state added
 * to `PaneState` is far more likely to be another TUI rendering than
 * another way of being empty, and this way it defaults to counting as
 * evidence rather than being silently ignored.
 */
export function isAgentPane(state: PaneState): boolean {
  return state !== "SHELL" && state !== "UNKNOWN";
}

/**
 * Does this pane's render prove a turn has already run?
 *
 * These four are drawn only AFTER the session has begun doing something: a
 * spinner or interrupt banner (BUSY), a tool asking permission mid-turn
 * (MODAL), queued follow-up messages (TYPING), a context compaction
 * (COMPACTING — it needs history to compact). Any one of them is direct
 * proof of the thing `TOKENS_MOVED_RE` only infers from a footer that a
 * modal box readily scrolls away.
 *
 * READY is excluded ON PURPOSE, and it is the whole reason this is an
 * allow-list rather than the complement of `isAgentPane`: a bare compose
 * prompt with no token footer is EXACTLY what a bootstrapping pane looks
 * like, and swallowing it here would delete the `bootstrapping` state.
 */
export function hasProducedOutput(state: PaneState): boolean {
  return state === "BUSY" || state === "MODAL" || state === "TYPING" || state === "COMPACTING";
}

/** Matches the `<int>k tokens` / `tokens · <int>%` status-line shape
 *  claude renders once a turn has produced output. Identical to
 *  ADR-081 §C `TOKENS_MOVED_RE` (kept in sync — both flow from the
 *  same TUI rendering contract). */
const TOKENS_MOVED_RE = /(?<![0-9])\d+k\s*(?:tokens|↓)|tokens\s*·\s*\d+%/i;

/** Default child-exec probe: `ps --ppid <panePid> -o comm=` and match
 *  `claude` (or `claude-code`) in the comm column. Pure-ish (single
 *  spawn call), portable across Linux + macOS. */
async function defaultPaneChildIsClaude(panePid: number): Promise<boolean> {
  let r: SpawnResult;
  try {
    r = await defaultSpawn({
      cmd: "ps",
      argv: ["-o", "comm=", "--ppid", String(panePid)],
      expectExitCode: "any",
      timeoutMs: 2_000,
    });
  } catch {
    return false;
  }
  if (r.exitCode !== 0) return false;
  // `comm` is the command name (basename of argv[0]) — typically
  // truncated to 16 chars on Linux but `claude` fits. Match any line
  // whose first token is `claude` (handles `claude-code` variant).
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .some((l) => l === "claude" || l.startsWith("claude") || l === "node");
  // `node` accepted as a Claude Code wrapper exec name on some
  // installs (npm-shim path); the alternative is false-negative
  // `down` reports on dev installs.
}

/**
 * Lines of pane tail this probe captures.
 *
 * Matches `src/verbs/fleet.ts::CAPTURE_LINES` on purpose: the two surfaces
 * now run the SAME behavioural classifier, and feeding it a different
 * amount of scrollback is precisely how two classifiers that share code
 * start disagreeing anyway. The classifier itself only ever looks at the
 * last CLASSIFY_TAIL_LINES (25) of what it is given, so this is headroom,
 * not cost.
 */
const CAPTURE_LINES = 40;

/**
 * Wrap a capture-pane call in a try/catch — the pane may have died between
 * listPanes + capturePane (e.g. operator killed it).
 *
 * Returns `null` on failure rather than `""`. The distinction is what lets
 * the behavioural classifier report `unreadable` ("I could not look")
 * instead of the confident `unresponsive` ("I looked and the pane is
 * blank"). The process ladder above flattens it back to `""`, which is
 * exactly what it always saw.
 */
async function tryCapture(tmux: TmuxNamespace, target: string): Promise<string | null> {
  try {
    return await tmux.pane.capturePane({ target, start: -CAPTURE_LINES });
  } catch {
    return null;
  }
}

/** Default window-signal read: ONE `display-message` rendering
 *  {@link WINDOW_PROBE_FORMAT} against the resolved target. */
async function defaultWindowProbe(
  tmux: TmuxNamespace,
  target: string,
  nowSec: number,
): Promise<WindowProbe> {
  const raw = await tmux.pane.displayMessage({
    target,
    format: WINDOW_PROBE_FORMAT,
    print: true,
  });
  return parseWindowProbe(raw, nowSec);
}

/** Read pane process uptime via `ps -o etimes= -p <pid>`. Mirrors
 *  doctor.ts's `readPaneUptimeSec` — kept local rather than exported
 *  so this module stays self-contained. */
async function readPaneUptimeSec(pid: number): Promise<number | null> {
  let r: SpawnResult;
  try {
    r = await defaultSpawn({
      cmd: "ps",
      argv: ["-o", "etimes=", "-p", String(pid)],
      expectExitCode: "any",
      timeoutMs: 2_000,
    });
  } catch {
    return null;
  }
  if (r.exitCode !== 0) return null;
  const trimmed = r.stdout.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = parseInt(trimmed, 10);
  return Number.isFinite(n) ? n : null;
}
