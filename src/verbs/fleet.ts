// ADR-273 D1/D2/D3: `atmux fleet --attention | --quiet` — the fleet
// triage sweep behind the `fleet_attention` / `fleet_quiet` voice tools.
//
// The classifier and the spoken shape live in `src/core/vox/fleet.ts`
// (pure, fixture-testable). THIS file is the IO half: enumerate teams
// from the cockpit, read every pane, and hand the observations over.
//
// ---------------------------------------------------------------------
// Why windows, not the roster, are the unit of enumeration
// ---------------------------------------------------------------------
//
// A roster-driven sweep asks `.atmux/team.json` who exists and probes
// those names. On the live fleet that returns NOTHING: 14 of 15 teams
// carry `members: []` (they decomposed to driver-only per
// `project_atmux_team_decomposed_to_core`), while their tmux sessions
// hold live `driver` / `driver-2` / `driver-3` windows doing the actual
// work. A survey that reported "0 panes, all clear" across a fleet of
// working agents would be the exact failure ADR-273 is written against.
//
// So tmux is the source of truth for what exists, and the roster is used
// only to enrich (labels). A window the roster never heard of is still a
// pane the operator owns.
//
// Viewer windows are the one exclusion: an ADR-089 epic-team viewer runs
// `tmux attach` into ANOTHER session, so capturing it would double-count
// a pane that the child team's own sweep already reports. They are
// identified structurally (`pane_current_command === "tmux"`), not by
// name. That exclusion is load-bearing precisely BECAUSE epic-teams are
// now swept directly (see {@link resolveEpicEntry}) — without it, a live
// epic-team's panes would be reported twice, once through its own cage
// and once through the parent's 🌳 viewer.
//
// ---------------------------------------------------------------------
// Bounding (ADR-273 §Consequences)
// ---------------------------------------------------------------------
//
// This is the most expensive read in the catalog. Teams are swept
// CONCURRENTLY with a cap, the whole sweep is bounded by a wall-clock
// deadline, and a team that cannot be read inside it is reported as
// UNREADABLE — never silently omitted, because a survey that quietly
// drops a team is a survey that lies.
//
// ---------------------------------------------------------------------
// Trap 1 (ADR-273 D3) — the session name
// ---------------------------------------------------------------------
//
// `atmux-<team>` is NOT the session name. Teams anchor their session in
// `.atmux/state/session.txt`, and on the live fleet `unum` anchors to
// `atmux_unum` (underscore) and `atmux` to bare `atmux` — neither of
// which `atmux-<team>` produces. Every session name here resolves through
// `resolveCageSessionName`, the anchor-aware helper. The underlying
// `probeCageState` bug that hard-coded the wrong form is fixed in the
// same commit (it gained a `sessionName` override, and `status` passes
// the resolved name).

import { now as nowMs } from "../abstractions/time.ts";
import { createTmux, type TmuxNamespace } from "../abstractions/tmux.ts";
import { readOpenFlagsMd } from "../core/blockers.ts";
import { resolveEpicCageRoot } from "../core/cage-resolver.ts";
import {
  enabledTeams,
  type FlattenedTeamEntry,
  loadCockpit,
  resolveCageSessionName,
  resolveCageSocket,
} from "../core/cockpit.ts";
import { buildWindowName, resolveTeamSocket, tryLoadTeam } from "../core/common.ts";
import { readDriverInbox } from "../core/driver-inbox.ts";
import {
  ATTENTION_TOP_DEFAULT,
  ATTENTION_TOP_MAX,
  ATTENTION_TOP_MIN,
  buildVerdict,
  type FleetSweep,
  type PaneObservation,
  renderAttention,
  renderQuiet,
  type TeamAsks,
  type UnreadableTeam,
} from "../core/vox/fleet.ts";
import { paneGist } from "../core/vox/summarize.ts";
import { UsageError } from "../errors.ts";

const USAGE =
  "atmux fleet [--attention|--quiet] [--top <n>] [--json] [--timeout-ms <n>] [--concurrency <n>]";

// ---------- Tunables ----------

/** Default wall-clock bound for a whole sweep. Conversational latency:
 *  past this the operator is waiting on a silent phone, and a partial
 *  answer that names what it could not read beats a complete one that
 *  arrives too late to be an answer. */
export const SWEEP_TIMEOUT_MS_DEFAULT = 15_000;

/** Teams read in parallel. Each team costs `2 + 2N` short-lived tmux
 *  invocations; eight at a time keeps the fleet under a couple of
 *  seconds without spawning a hundred processes at once on a box whose
 *  gating throttle is CPU. */
export const SWEEP_CONCURRENCY_DEFAULT = 8;

/** Lines of pane tail captured per window. Enough for a modal, a
 *  rate-limit banner and the composer; small enough that a hundred
 *  captures stay cheap. */
export const CAPTURE_LINES = 40;

/** `pane_current_command` of an ADR-089 viewer window. */
const VIEWER_COMMAND = "tmux";

// ---------- Args ----------

export type FleetView = "attention" | "quiet";

export interface FleetArgs {
  view: FleetView;
  top: number;
  json: boolean;
  timeoutMs: number;
  concurrency: number;
}

function positiveInt(raw: string | undefined, flag: string): number {
  if (raw === undefined) {
    throw new UsageError({ what: `fleet: ${flag} requires a value`, hint: USAGE });
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new UsageError({
      what: `fleet: ${flag} must be a positive integer, got '${raw}'`,
      hint: USAGE,
    });
  }
  return n;
}

/** Pure argv parser. `--attention` is the default view. */
export function parseFleetArgs(argv: ReadonlyArray<string>): FleetArgs {
  let view: FleetView = "attention";
  let top = ATTENTION_TOP_DEFAULT;
  let json = false;
  let timeoutMs = SWEEP_TIMEOUT_MS_DEFAULT;
  let concurrency = SWEEP_CONCURRENCY_DEFAULT;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--attention") {
      view = "attention";
      i += 1;
      continue;
    }
    if (a === "--quiet") {
      view = "quiet";
      i += 1;
      continue;
    }
    if (a === "--json") {
      json = true;
      i += 1;
      continue;
    }
    if (a === "--top") {
      const n = positiveInt(argv[i + 1], "--top");
      if (n < ATTENTION_TOP_MIN || n > ATTENTION_TOP_MAX) {
        throw new UsageError({
          what: `fleet: --top must be between ${ATTENTION_TOP_MIN} and ${ATTENTION_TOP_MAX}, got ${n}`,
          hint: USAGE,
        });
      }
      top = n;
      i += 2;
      continue;
    }
    if (a === "--timeout-ms") {
      timeoutMs = positiveInt(argv[i + 1], "--timeout-ms");
      i += 2;
      continue;
    }
    if (a === "--concurrency") {
      concurrency = positiveInt(argv[i + 1], "--concurrency");
      i += 2;
      continue;
    }
    throw new UsageError({ what: `fleet: unknown arg: ${a ?? ""}`, hint: USAGE });
  }
  return { view, top, json, timeoutMs, concurrency };
}

// ---------- Per-team probe ----------

/** What one team's probe produced. `unreadable` is set INSTEAD of the
 *  other two when the team could not be read at all. */
export interface TeamProbeResult {
  panes: PaneObservation[];
  asks: TeamAsks | null;
  unreadable: UnreadableTeam | null;
}

export interface FleetDeps {
  /** Cockpit roster loader (tests inject a canned fleet). */
  listTeams?: () => Promise<FlattenedTeamEntry[]>;
  /** Per-team probe (tests inject canned observations). Signature matches
   *  {@link probeTeamLive} so the default needs no wrapper closure. */
  probeTeam?: (team: FlattenedTeamEntry, nowSec: number) => Promise<TeamProbeResult>;
  /** ms clock. */
  now?: () => number;
  /** Deadline sleeper (injected so a test need not really wait). */
  sleep?: (ms: number) => Promise<void>;
  /** Rewrite an `epic-team` cockpit entry to its OWN cage root, or
   *  `null` when that cage is gone from disk. Defaults to
   *  {@link resolveEpicEntry}; tests inject to drive both branches
   *  without laying down worktrees. */
  resolveEpicEntry?: (entry: FlattenedTeamEntry) => FlattenedTeamEntry | null;
  /** stdout sink. */
  logger?: { log: (m: string) => void };
}

/** Split `#{window_activity}\t#{pane_dead}\t#{pane_current_command}`. */
export function parseWindowProbe(
  raw: string,
  nowSec: number,
): { activityAgeSec: number | null; paneDead: boolean | null; currentCommand: string | null } {
  const [activity, dead, cmd] = raw.trim().split("\t");
  const activityEpoch = Number(activity);
  const activityAgeSec =
    activity !== undefined && activity !== "" && Number.isFinite(activityEpoch)
      ? Math.max(0, nowSec - activityEpoch)
      : null;
  const paneDead = dead === undefined || dead === "" ? null : dead === "1";
  const currentCommand = cmd === undefined || cmd === "" ? null : cmd;
  return { activityAgeSec, paneDead, currentCommand };
}

/** tmux format string for the one-call-per-window liveness probe. The
 *  activity clock is what trap 3 needs: it is maintained by tmux, not
 *  derived from the pane text, so a frozen render cannot forge it. */
export const WINDOW_PROBE_FORMAT = "#{window_activity}\t#{pane_dead}\t#{pane_current_command}";

/**
 * Production per-team probe. Resolves the socket + the ANCHOR-AWARE
 * session name, enumerates windows, then reads each one.
 *
 * A team whose session is absent yields ONE `dead` observation rather
 * than N: the operator needs to hear "sopx is down", not six identical
 * clauses. When the roster is known the lead's name is used as the
 * subject, otherwise the team stands in for itself.
 */
export async function probeTeamLive(
  team: FlattenedTeamEntry,
  nowSec: number,
  deps: { tmux?: (socketPath: string) => TmuxNamespace } = {},
): Promise<TeamProbeResult> {
  const roster = await tryLoadTeam({ teamDir: team.root });
  const socketPath =
    roster !== null ? resolveTeamSocket(roster) : await resolveCageSocket(team.name, team.root);
  const sessionName = await resolveCageSessionName({ name: team.name, root: team.root });
  const tmux = (deps.tmux ?? ((s: string) => createTmux({ socketPath: s })))(socketPath);

  const asks = await readTeamAsks(team, nowSec);

  const sessionUp = await tmux.session.hasSession(sessionName);
  if (!sessionUp) {
    return {
      panes: [
        {
          team: team.name,
          member: roster?.members[0]?.name ?? "cage",
          windowName: sessionName,
          sessionUp: false,
          windowPresent: false,
          capture: null,
          paneDead: null,
          currentCommand: null,
          activityAgeSec: null,
        },
      ],
      asks,
      unreadable: null,
    };
  }

  const windows = await tmux.window.listWindows(sessionName);
  // Roster labels, keyed by the window name the member would occupy.
  const labelByWindow = new Map<string, string>();
  for (const m of roster?.members ?? []) {
    labelByWindow.set(buildWindowName(m.name, m.emoji, m.label, m.role), m.name);
  }

  const panes: PaneObservation[] = [];
  for (const w of windows) {
    const target = `${sessionName}:${w.name}`;
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
      // classifies. Leaving the clock null makes the classifier fall
      // back on pane text alone, which it is written to tolerate.
    }
    if (probe.currentCommand === VIEWER_COMMAND) continue;
    let capture: string | null = null;
    try {
      capture = await tmux.pane.capturePane({ target, start: -CAPTURE_LINES });
    } catch {
      capture = null;
    }
    panes.push({
      team: team.name,
      member: labelByWindow.get(w.name) ?? w.name,
      windowName: w.name,
      sessionUp: true,
      windowPresent: true,
      capture,
      paneDead: probe.paneDead,
      currentCommand: probe.currentCommand,
      activityAgeSec: probe.activityAgeSec,
    });
  }

  return { panes, asks, unreadable: null };
}

/** Injectable readers behind {@link readTeamAsks} — both default to the
 *  production parsers; tests use them to drive the failure path. */
export interface TeamAsksDeps {
  readInbox?: typeof readDriverInbox;
  readFlags?: typeof readOpenFlagsMd;
}

/**
 * Unread driver-inbox entries + open lead flags for one team. Both are
 * plain file reads — no tmux, no db.
 *
 * Each read is independently fail-soft: an unreadable or malformed inbox
 * must not cost the operator the team's PANE report, which is the more
 * urgent half. Losing an ask is a smaller failure than losing a wedged
 * agent, so the two are not coupled.
 */
export async function readTeamAsks(
  team: FlattenedTeamEntry,
  nowSec: number,
  deps: TeamAsksDeps = {},
): Promise<TeamAsks | null> {
  const atmuxDir = `${team.root.replace(/\/+$/, "")}/.atmux`;
  const readInbox = deps.readInbox ?? readDriverInbox;
  const readFlags = deps.readFlags ?? readOpenFlagsMd;
  const [inbox, flags] = await Promise.all([
    readInbox(atmuxDir, nowSec).catch(() => null),
    readFlags(atmuxDir, nowSec).catch(() => []),
  ]);
  const unread = inbox?.delta.length ?? 0;
  const openFlags = flags.length;
  if (unread === 0 && openFlags === 0) return null;
  // The entry HEAD, not its body: the head is the one-line "what this ask
  // is", which is what an operator needs spoken. The body's last line is
  // whatever prose happened to end the entry.
  const newest = inbox?.delta[inbox.delta.length - 1]?.head ?? flags[0]?.summary ?? "";
  return {
    team: team.name,
    driverInboxUnread: unread,
    openFlags,
    gist: paneGist(newest, { maxLines: 1, maxChars: 120 }),
  };
}

// ---------- Sweep ----------

/**
 * The ONE thing about an epic-team the cockpit entry cannot tell you.
 *
 * A cockpit `epic-team` node carries the PARENT's root (the flattener
 * threads `parentRoot` into `.root` so duck-typed consumers keep
 * working), so probing the entry as-is reads the parent's cage and
 * reports a confident wrong answer. That is why the first cut of this
 * sweep reported every epic-team as unreadable.
 *
 * It is not, however, unresolvable — it is resolvable one level down.
 * `spawn-epic` writes the epic-team a root of its own, with its own
 * `team.json` (carrying `tmuxTmpdir`, hence its own socket) and its own
 * session anchor, at one of two conventions that
 * {@link resolveEpicCageRoot} owns. Resolve that root and the entry
 * becomes an ordinary team: {@link probeTeamLive} needs no epic-specific
 * branch, because everything it reads (`tryLoadTeam`,
 * `resolveTeamSocket`, `resolveCageSessionName`, {@link readTeamAsks})
 * already keys off the root.
 *
 * Only when NEITHER convention exists on disk is there nothing to read —
 * and that is a different fact than "could not be read": the cage is
 * gone while its cockpit entry survives. See
 * {@link EPIC_TEAM_STALE_REASON}.
 */
export function resolveEpicEntry(
  entry: FlattenedTeamEntry,
  existsSync?: (p: string) => boolean,
): FlattenedTeamEntry | null {
  const opts = existsSync === undefined ? {} : { existsSync };
  const own = resolveEpicCageRoot(entry.root, entry.name, entry.epicId ?? entry.name, opts);
  return own === null ? null : { ...entry, root: own };
}

/**
 * Why an epic-team is reported unreadable once its cage has been sought.
 *
 * Deliberately not the old "its own cage is not resolvable from the
 * cockpit entry" text, which was true of EVERY epic-team, fired on every
 * sweep, and named no action — the "cries wolf" failure ADR-273 D3 is
 * written against. This one fires only when the epic-team has no live
 * cage, and the action it names removes the entry PERMANENTLY.
 *
 * ONE shared constant rather than a per-case string, deliberately: it is
 * what lets `renderUnreadable`'s group-by-reason collapse the whole set
 * into a single spoken clause. Both cases it covers are the same fact to
 * an operator — "this epic-team is not running and its entry outlived
 * it" — and both take the same action, so splitting the wording would
 * buy a second clause and no second decision.
 *
 * **The trade-off, stated rather than hidden.** An epic-team whose cage
 * is not running lands HERE rather than as a `dead` attention item, which
 * is where a top-level team in the same state lands. That asymmetry is
 * deliberate and rests on what the two cockpit entries MEAN. A top-level
 * entry is a standing declaration that the team should be up (`atmux
 * start` maintains it, cron re-arms it), so its session being absent is
 * news. An epic-team is ephemeral by construction — spawned per epic,
 * `autoDissolve` on fan-in — so its cage ending is its NORMAL terminal
 * state, and its entry outliving it is chronic bookkeeping, not an
 * incident. Ranking chronic state below news is the same call ADR-273
 * §S3.3 already made for `dormant`, for the same reason: on the live
 * fleet these are long-dissolved epics, and letting them hold spoken
 * slots on every sweep would push acute findings on other teams into the
 * remainder count forever.
 *
 * What this costs: an epic-team that SHOULD be running right now and
 * whose cage just died is reported on this line instead of as an acute
 * `dead` item. It is still named on every sweep — never omitted — but it
 * is ranked as bookkeeping. A live epic cage is swept in full, so
 * everything short of total cage death (wedged, rate-limited, crashed
 * panes) still reaches the operator through the normal classes.
 */
export const EPIC_TEAM_NO_CAGE_REASON =
  "epic-team has no live cage — an ephemeral team that ended; prune with 'atmux team dissolve-epic <name>'";

/**
 * True when the probe found the team's tmux SESSION absent.
 *
 * Recognised by shape rather than by a flag: {@link probeTeamLive}
 * reports a cage that is not running as exactly one synthetic
 * observation carrying `sessionUp: false`, and never mixes that row with
 * real panes. Reading the probe's own evidence keeps this decision on the
 * same footing as every other classification in ADR-273 — no second
 * source of truth about whether a cage is up.
 */
export function cageIsAbsent(result: TeamProbeResult): boolean {
  return result.panes.length > 0 && result.panes.every((p) => !p.sessionUp);
}

/** Outcome of one team's raced probe. */
type RaceOutcome = { ok: true; result: TeamProbeResult } | { ok: false; reason: string };

/**
 * The deadline sleeper.
 *
 * `unref()` is load-bearing, not hygiene: the deadline timer loses its
 * race on every team that answers in time, and a plain `setTimeout` then
 * keeps the event loop alive for the FULL remaining budget afterwards.
 * In the CLI that is masked by `process.exit`; in the voice server, where
 * the verb runs in-process, twenty orphaned 15-second timers per sweep
 * would pin the loop and make every sweep look like it took the whole
 * budget.
 */
function realSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}

/** Default team enumeration — every enabled cockpit session. */
async function defaultListTeams(): Promise<FlattenedTeamEntry[]> {
  return enabledTeams(await loadCockpit());
}

/** Default stdout sink for the verb. */
function stdoutLog(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * Sweep the whole fleet, concurrently and wall-clock bounded.
 *
 * The deadline is enforced per team AND overall: a team still running
 * when the budget expires is recorded as unreadable with the reason, and
 * the sweep returns what it has. Nothing is dropped in silence.
 */
export async function sweepFleet(
  deps: FleetDeps = {},
  args: { timeoutMs: number; concurrency: number } = {
    timeoutMs: SWEEP_TIMEOUT_MS_DEFAULT,
    concurrency: SWEEP_CONCURRENCY_DEFAULT,
  },
): Promise<FleetSweep> {
  const now = deps.now ?? nowMs;
  const sleep = deps.sleep ?? realSleep;
  const started = now();
  const listTeams = deps.listTeams ?? defaultListTeams;
  const probe = deps.probeTeam ?? probeTeamLive;
  const resolveEpic = deps.resolveEpicEntry ?? ((e: FlattenedTeamEntry) => resolveEpicEntry(e));
  const teams = await listTeams();
  const nowSec = Math.floor(started / 1000);

  const panes: PaneObservation[] = [];
  const asks: TeamAsks[] = [];
  const unreadable: UnreadableTeam[] = [];

  async function runOne(team: FlattenedTeamEntry): Promise<RaceOutcome> {
    const remaining = args.timeoutMs - (now() - started);
    if (remaining <= 0) {
      return { ok: false, reason: "sweep deadline reached before this team was read" };
    }
    try {
      const raced = await Promise.race([
        probe(team, nowSec).then((result): RaceOutcome => ({ ok: true, result })),
        sleep(remaining).then(
          (): RaceOutcome => ({ ok: false, reason: `not read within ${args.timeoutMs}ms` }),
        ),
      ]);
      return raced;
    } catch (e) {
      return { ok: false, reason: `probe failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = cursor;
      cursor += 1;
      const team = teams[idx];
      if (team === undefined) return;
      // An epic-team's cockpit entry points at the PARENT's root, so it
      // is rewritten to the epic-team's OWN root before probing. A live
      // epic cage is then swept exactly like any other team; only one
      // with no cage at all falls through to the unreadable line.
      const isEpic = team.type === "epic-team";
      let target = team;
      if (isEpic) {
        const resolved = resolveEpic(team);
        if (resolved === null) {
          unreadable.push({ team: team.name, reason: EPIC_TEAM_NO_CAGE_REASON });
          continue;
        }
        target = resolved;
      }
      const outcome = await runOne(target);
      if (!outcome.ok) {
        unreadable.push({ team: team.name, reason: outcome.reason });
        continue;
      }
      if (isEpic && cageIsAbsent(outcome.result)) {
        unreadable.push({ team: team.name, reason: EPIC_TEAM_NO_CAGE_REASON });
        continue;
      }
      panes.push(...outcome.result.panes);
      if (outcome.result.asks !== null) asks.push(outcome.result.asks);
      if (outcome.result.unreadable !== null) unreadable.push(outcome.result.unreadable);
    }
  };

  const lanes = Math.max(1, Math.min(args.concurrency, Math.max(1, teams.length)));
  await Promise.all(Array.from({ length: lanes }, () => worker()));

  unreadable.sort((a, b) => a.team.localeCompare(b.team));
  return {
    panes,
    asks,
    unreadable,
    teamsSurveyed: teams.length,
    elapsedMs: now() - started,
    ageMs: 0,
  };
}

// ---------- Verb entry ----------

/**
 * `atmux fleet [--attention|--quiet] [--top n] [--json]`.
 *
 * Read-only: no tmux writes, no state writes, no git. Returns 0 whatever
 * the fleet looks like — "seven panes need you" is a successful answer,
 * not a failure.
 */
export async function fleet(argv: ReadonlyArray<string>, deps: FleetDeps = {}): Promise<number> {
  const args = parseFleetArgs(argv);
  const logger = deps.logger ?? { log: stdoutLog };
  const sweep = await sweepFleet(deps, {
    timeoutMs: args.timeoutMs,
    concurrency: args.concurrency,
  });
  const verdict = buildVerdict(sweep);
  if (args.json) {
    logger.log(JSON.stringify({ view: args.view, top: args.top, ...verdict }, null, 2));
    return 0;
  }
  logger.log(args.view === "quiet" ? renderQuiet(verdict) : renderAttention(verdict, args.top));
  return 0;
}
