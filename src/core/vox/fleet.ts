// ADR-273 D1/D2/D3: fleet triage — "what needs my attention across
// everything, and what doesn't?"
//
// This module is the CLASSIFIER and the RENDERER. It performs no IO: the
// sweep (`src/verbs/fleet.ts`) hands it observations, it hands back a
// ranked verdict and the spoken shape. That split is what makes the three
// traps below testable against fixtures rather than against the live
// fleet.
//
// ---------------------------------------------------------------------
// D3 — attention is classified HERE, from evidence, and says why
// ---------------------------------------------------------------------
//
// Classification does not belong in the model: "does this need George" is
// a judgment that must be reproducible and auditable, not re-litigated
// per conversation. Every attention item therefore carries the evidence
// that produced it — the marker matched plus the pane gist — because an
// item the operator cannot verify from the spoken reason is a black box,
// and a black box that cries wolf gets ignored.
//
// ---------------------------------------------------------------------
// The three traps (ADR-273 D3), and how each is closed here
// ---------------------------------------------------------------------
//
// TRAP 1 — `pane-state=down` false positive. `src/core/cage-state.ts`
//   hard-coded `atmux-<team>` as the session name instead of resolving
//   the anchor, so every team whose `.atmux/state/session.txt` holds a
//   different name (the underscore form `atmux_<team>` among them) probed
//   as `down` while alive. Closed OUTSIDE this module — the sweep
//   resolves session names through `resolveCageSessionName`
//   (`src/core/cockpit.ts`), the anchor-aware helper — and the underlying
//   helper gained a `sessionName` override in the same commit. What this
//   module contributes is the posture: `dead` requires the SESSION to be
//   absent under its RESOLVED name, and `unreadable` (never `dead`) is
//   what a failed read reports.
//
// TRAP 2 — the in-flight-turn regex matches PAST-TENSE glyphs.
//   `src/core/pane-state.ts::PATTERNS` classifies BUSY on a bare `✻ \w+`,
//   which matches the COMPLETED-turn marker `✻ Worked for 22s` just as
//   readily as a live spinner — and BUSY is tested before TYPING, so a
//   pane with unsubmitted residue in its composer AND a stale completed-
//   turn glyph reads as busy. That is the wedge class hiding inside the
//   healthy class, i.e. exactly the thing the operator most needs
//   surfaced. This module does NOT use that classifier for the
//   working/idle axis. It uses {@link ACTIVE_TURN_RE}, lifted from
//   `src/core/queued-text-resubmit.ts` where the same bug was already
//   found and fixed (t-408a3c75 / the 2026-05-19 unum 7/7-wedged
//   incident): present-tense verbs and the live elapsed marker ONLY, no
//   bare glyphs. The rate-limit / compaction / modal markers are still
//   taken from the shared classifier — those patterns are unambiguous and
//   have no past-tense twin.
//
// TRAP 3 — silence is not health. A pane that has printed nothing for an
//   hour is either thinking or dead. Two rules follow. (a) A pane enters
//   the QUIET set only on POSITIVE evidence — a live-turn marker, a
//   compaction banner, or agent chrome with an empty composer. Absence of
//   anything bad is never enough; a capture with no recognizable agent
//   chrome is `unresponsive`, an attention class. (b) A live-turn marker
//   is corroborated against the window's tmux ACTIVITY CLOCK, which is
//   not derived from the pane text at all: a spinner that has not
//   repainted in {@link FROZEN_ACTIVITY_SEC} is not working, it is
//   `frozen`. Distinguishing thinking from dead by something other than
//   absence of output is the whole point.

import { classifyRefusal } from "../refusal-classifier.ts";
import { paneGist, stripAnsi } from "./summarize.ts";

// ---------- Vocabulary ----------

/**
 * Why a pane needs the operator. Ordered most-urgent first; the numeric
 * rank in {@link ATTENTION_RANK} is derived from this list so the two can
 * never drift.
 */
export const ATTENTION_CLASSES = [
  "permission-prompt",
  "rate-limited",
  "refusal",
  "dead",
  "crashed",
  "frozen",
  "unresponsive",
  "idle-residue",
  "lead-ask",
  "dormant",
  "unreadable",
] as const;

export type AttentionClass = (typeof ATTENTION_CLASSES)[number];

/** One-clause spoken reason per class. The operator hears this, so it
 *  says what is WRONG, not what the state machine calls it. */
export const ATTENTION_REASON: Readonly<Record<AttentionClass, string>> = Object.freeze({
  "permission-prompt": "waiting on a permission prompt",
  "rate-limited": "rate-limited",
  refusal: "refusing the work",
  dead: "session is down",
  crashed: "no agent running in the pane",
  frozen: "spinner stalled",
  unresponsive: "no agent output at all",
  "idle-residue": "idle with unsubmitted text",
  "lead-ask": "asks waiting for you",
  dormant: "parked with nothing queued",
  unreadable: "could not be read",
});

/**
 * Attention classes that describe a STANDING condition rather than an
 * event. `fleet_quiet` counts them separately so a fleet that is merely
 * parked still reports as nominal — see {@link renderQuiet}.
 */
export const CHRONIC_CLASSES: ReadonlySet<AttentionClass> = new Set<AttentionClass>(["dormant"]);

/** Rank 0 is most urgent. Derived from {@link ATTENTION_CLASSES}. */
export const ATTENTION_RANK: Readonly<Record<AttentionClass, number>> = Object.freeze(
  Object.fromEntries(ATTENTION_CLASSES.map((c, i) => [c, i])) as Record<AttentionClass, number>,
);

/** Why a pane does NOT need the operator. Aggregated, never enumerated
 *  (D2) — `fleet_quiet` reports counts of these and nothing else. */
export const QUIET_CLASSES = ["working", "compacting", "starting", "idle"] as const;

export type QuietClass = (typeof QUIET_CLASSES)[number];

/** Plural noun for each quiet class, as spoken in the rollup. */
export const QUIET_LABEL: Readonly<Record<QuietClass, string>> = Object.freeze({
  working: "working",
  compacting: "compacting",
  starting: "starting up",
  idle: "idle and clear",
});

// ---------- Observations (what the sweep collects) ----------

/** One member pane, as observed. Every field is what the SWEEP could
 *  see; the classifier adds no IO of its own. */
export interface PaneObservation {
  team: string;
  member: string;
  /** tmux window name the sweep targeted (evidence for a `dead` item). */
  windowName: string;
  /** Is the team's tmux session present under its RESOLVED name? */
  sessionUp: boolean;
  /** Is the member's window present in that session? */
  windowPresent: boolean;
  /** Captured pane text; `null` when the capture itself failed. */
  capture: string | null;
  /** tmux `#{pane_dead}` — the process behind the pane has exited. */
  paneDead: boolean | null;
  /** tmux `#{pane_current_command}` — `claude`, `bash`, … */
  currentCommand: string | null;
  /** Seconds since tmux last saw output in this window. NOT derived from
   *  the pane text — this is the independent clock trap 3 needs. */
  activityAgeSec: number | null;
}

/** A team-level ask: unread driver-inbox entries and/or open lead flags.
 *  Team-scoped rather than pane-scoped, so it carries no member. */
export interface TeamAsks {
  team: string;
  /** Unread driver-inbox entries (entries past the stored cursor). */
  driverInboxUnread: number;
  /** Open (unresolved) `flags.md` rows. */
  openFlags: number;
  /** Newest ask's first line, for evidence. */
  gist: string;
}

/** A team the sweep could not read at all. Reported, NEVER omitted —
 *  a survey that quietly drops a team is a survey that lies
 *  (ADR-273 §Consequences). */
export interface UnreadableTeam {
  team: string;
  /** Why: timeout, tmux failure, missing roster, … */
  reason: string;
}

/** Everything one sweep produced. */
export interface FleetSweep {
  panes: PaneObservation[];
  asks: TeamAsks[];
  unreadable: UnreadableTeam[];
  /** Teams the sweep set out to read (readable + unreadable). */
  teamsSurveyed: number;
  /** Wall-clock the sweep took, ms. */
  elapsedMs: number;
  /** Age of the answer when served from cache, ms. `0` when fresh.
   *  ADR-273 OQ-3: a cached answer MUST report its age. */
  ageMs: number;
}

// ---------- Verdicts ----------

export interface AttentionItem {
  team: string;
  /** `null` for a team-level item (`lead-ask` / `unreadable`). */
  member: string | null;
  kind: AttentionClass;
  /** The marker that fired — the auditable half of the evidence. */
  marker: string;
  /** Last meaningful line(s) of the pane, stripped and truncated. */
  gist: string;
}

export interface QuietItem {
  team: string;
  member: string;
  kind: QuietClass;
}

export interface FleetVerdict {
  attention: AttentionItem[];
  quiet: QuietItem[];
  unreadable: UnreadableTeam[];
  /** Panes actually observed. NOT `attention.length + quiet.length` —
   *  `lead-ask` items are team-level, so counting items as panes would
   *  quietly inflate the denominator the operator is told. */
  paneCount: number;
  teamsSurveyed: number;
  elapsedMs: number;
  ageMs: number;
}

// ---------- Detection patterns ----------

/**
 * Live-turn markers ONLY — present-tense thinking verbs and the live
 * elapsed marker. Lifted verbatim from
 * `src/core/queued-text-resubmit.ts::ACTIVE_TURN_RE`, where matching bare
 * spinner glyphs was found to be a real bug: `✻`/`✶`/`✽` persist in the
 * PAST-tense idle display (`✻ Brewed for 1m 56s`), so matching them made
 * idle-with-residue panes read as busy. See the file header, TRAP 2.
 *
 * Deliberately NOT imported from that module: this is a voice-surface
 * classification contract that ADR-273 pins independently, and a future
 * tweak there for the resubmit loop must not silently retune what the
 * operator is told is "working". The duplication is 1 regex; a test
 * asserts the two agree on the past-tense case that matters.
 */
export const ACTIVE_TURN_RE =
  /(?:Cooking|Schlepping|Honking|Crunching|Cogitating|Brewing|Effecting|Imagining|Sautéeing|Kneading|Misting|Puttering|Grooving|Ruminating)(?:\.{3}|…)|… \(\d+m?s\)|esc to interrupt/i;

/**
 * Rate-limit banner.
 *
 * NOT the `src/core/pane-state.ts` pattern (`/hit your limit/i`), which
 * is a substring of Claude Code's own STANDING TIP — "If you hit your
 * limit, you can continue on Fable 5 with usage credits" — printed on
 * perfectly healthy panes. It put all five `mx` drivers in the
 * rate-limited bucket on the first live run. The banner is assertive; the
 * tip is conditional, and {@link HYPOTHETICAL_RE} drops the conditional
 * line before the match is believed.
 */
const RATE_LIMIT_RE =
  /You(?:'ve| have)\s+hit your (?:usage )?limit|usage limit reached|approaching (?:your )?usage limit/i;

/** A line that merely SPECULATES about a condition rather than reporting
 *  it. Claude Code's tips and the models' own prose both do this. */
const HYPOTHETICAL_RE = /\b(?:if|when|unless|whether)\s+you\b/i;

/** Compaction banner. */
const COMPACTING_RE = /Compacting conversation/i;

/**
 * Permission / decision modal — the agent has STOPPED and waits forever.
 *
 * `Enter to confirm` and the `❯ 1. …` selection cursor are here on
 * EVIDENCE, not on theory: on the live fleet the entire `dash` team sat
 * blocked on Claude Code's trust-this-folder modal, whose text contains
 * neither "Do you want" nor "[y/N]" — the ADR-057 pattern catalog would
 * have called all five panes healthy. That is the single most expensive
 * miss this class can make (a blocked agent waits forever), so the
 * catalog is widened by what was actually observed.
 */
const MODAL_RE =
  /Do you want (?:Claude )?to|Allow this tool to proceed|How is Claude doing this session|Enter to confirm|\[y\/N\]:?\s*$/i;

/**
 * Agent chrome — POSITIVE evidence that a Claude TUI is rendering.
 *
 * Deliberately NOT `[>❯]\s`: a zsh powerline prompt also renders `❯`, so
 * that alone proves a terminal, not an agent. Each alternative here is a
 * Claude Code frame element observed live: the permission-mode footer,
 * the token/context footer, the agents hint, and the interrupt banner.
 */
const AGENT_CHROME_RE =
  /⏵⏵\s+(?:auto mode|accept edits|don't ask|plan mode)|\btok\s+\d+\/|\bctx\s+(?:--|\d)|← for agents|esc to interrupt|\? for shortcuts/i;

/**
 * Chrome of the OTHER agent TUIs atmux spawns (`team.json:.tui` —
 * Codex, Cursor, Kimi, …). Claude is not the only inhabitant of a cage,
 * and a Claude-only chrome test reported every Codex pane on the fleet as
 * "no agent running": `kanban` and `ifca-docs` were live Codex sessions
 * showing `gpt-5.6-sol medium · kanban · main · No changes · Ready` and
 * `agent · deepseek-v4-pro`. Each alternative below was read off one of
 * those panes.
 */
const ALT_AGENT_CHROME_RE =
  /·\s*(?:Ready|Approve for me)\b|\bagent\s+·\s+\S|^\s*›\s|\bctrl\+c to (?:quit|interrupt)\b|\bthinking:\s*(?:high|medium|low)\b/im;

/** A fresh pane whose token counter has never moved (`ctx --`, `tok
 *  0/0`) — booting, not stuck. */
const FRESH_PANE_RE = /\bctx\s+--|\btok\s+0\/0\b/i;

/**
 * Claude Code's composer PLACEHOLDER — dim hint text, not operator input.
 *
 * Without this, every freshly-cleared pane on the fleet reads as
 * "idle with unsubmitted text": the live `aix` drivers all render
 * `❯ Try "fix lint errors"`, which is a suggestion the TUI drew, not a
 * command anyone typed. Crying wolf on an idle pane is precisely how a
 * triage tool trains its operator to ignore it.
 */
const COMPOSER_PLACEHOLDER_RE = /^(?:Try\s+["“]|Ask\s|Type\s|Write\s|Edit\s+files)/i;

/** Shell commands a pane shows when the TUI is gone. Used ONLY as
 *  corroboration once agent chrome is already absent: `pane_current_command`
 *  reads `sh` for perfectly healthy Claude panes (they are spawned through
 *  `sh -c`), so on its own it proves nothing. */
const SHELL_COMMANDS: ReadonlySet<string> = new Set([
  "bash",
  "zsh",
  "sh",
  "fish",
  "dash",
  "ksh",
  "tcsh",
]);

/**
 * Lines from the END of a capture that classification looks at.
 *
 * `capture-pane -S -N` returns N lines of scrollback PLUS the whole
 * visible screen, so a capture routinely runs past a hundred lines of
 * finished work. Classifying over all of it means an agent that merely
 * PRINTED the word "Error:" an hour ago, or quoted a refusal phrase while
 * discussing one, is reported as broken. The pane's CURRENT state is what
 * the operator is asking about, and that is the tail.
 */
export const CLASSIFY_TAIL_LINES = 25;

/**
 * Last {@link CLASSIFY_TAIL_LINES} NON-BLANK-TERMINATED lines of `text`.
 *
 * Trailing blanks are dropped FIRST. A tmux capture routinely ends with
 * the unpainted rows below a short TUI, and slicing the raw tail then
 * yields 25 empty lines — which classified a live Kimi pane as "blank"
 * while the gist, scanning bottom-up for meaningful content, printed its
 * footer. A classifier and its own evidence contradicting each other is
 * the worst possible output.
 */
export function tailWindow(text: string, lines = CLASSIFY_TAIL_LINES): string {
  const all = text.split("\n");
  while (all.length > 0 && (all[all.length - 1] ?? "").trim() === "") all.pop();
  return all.slice(Math.max(0, all.length - lines)).join("\n");
}

/**
 * A live-turn marker older than this is not a working agent — it is a
 * frozen render (TRAP 3b). Claude Code repaints its spinner every few
 * hundred ms, so five minutes of no window activity while a spinner is on
 * screen cannot be a healthy turn. Generous on purpose: the cost of a
 * false `frozen` is a wasted glance, and the operator can verify it from
 * the gist.
 */
export const FROZEN_ACTIVITY_SEC = 300;

/**
 * A pane with agent chrome, an empty composer, and no activity for this
 * long is `dormant` — an agent parked with nothing queued, which the
 * operator is entitled to know about but which is not an emergency.
 *
 * This is trap 3 applied honestly in BOTH directions: silence is not
 * health, so the pane does not enter the quiet bucket; but silence with
 * live chrome is also not a crash, so it is ranked near the bottom and
 * normally reaches the operator as part of the "+N more" count rather
 * than as a spoken item. Chronic state must not crowd out news.
 */
export const SILENT_IDLE_SEC = 3600;

/** Composer line — the live compose box. Mirrors
 *  `queued-text-resubmit.ts::COMPOSER_LINE_RE`. */
const COMPOSER_LINE_RE = /❯\s*(.*?)\s*$/;

/**
 * Text sitting in the composer that was never submitted — the wedge class.
 * Scans bottom-up for the last `❯` line (earlier glyphs are scrollback).
 * Returns `null` when there is no composer, the composer is empty, or it
 * holds the TUI's own placeholder hint.
 */
export function extractComposerResidue(capture: string): string | null {
  const lines = stripAnsi(capture).split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? "";
    if (!line.includes("❯")) continue;
    const match = COMPOSER_LINE_RE.exec(line);
    if (match === null) continue;
    const text = (match[1] ?? "").trim();
    if (text === "" || COMPOSER_PLACEHOLDER_RE.test(text)) return null;
    return text;
  }
  return null;
}

/**
 * Residue younger than this is someone TYPING, not a wedge.
 *
 * The distinction is the activity clock, not the text: a wedged composer
 * is by definition one nothing has touched, while the operator mid-
 * sentence has a window tmux saw output in seconds ago. Without this the
 * survey reports the pane the operator is literally typing into.
 */
export const RESIDUE_FRESH_SEC = 60;

// ---------- Pane classification ----------

export type PaneVerdict =
  | { bucket: "attention"; kind: AttentionClass; marker: string }
  | { bucket: "quiet"; kind: QuietClass };

/**
 * Find the LINE that fires `re`, skipping lines that merely speculate.
 *
 * Two properties in one pass, both learned from the first live run:
 *
 * 1. The evidence returned is the whole LINE, not the match. A bare match
 *    is often useless as evidence, while its line reads as the thing the
 *    operator would have seen. Evidence he cannot act on is the black box
 *    D3 forbids.
 * 2. A line matching {@link HYPOTHETICAL_RE} does not count as a firing.
 *    "If you hit your limit…" is a tip, not a rate-limit; believing it
 *    reported five healthy panes as throttled.
 *
 * Returns `null` when nothing fires on a non-speculative line.
 */
export function findMarkerLine(text: string, re: RegExp): string | null {
  for (const line of text.split("\n")) {
    if (!re.test(line)) continue;
    if (HYPOTHETICAL_RE.test(line)) continue;
    return line.trim();
  }
  return null;
}

/** Longest speakable evidence marker. */
const MARKER_MAX_CHARS = 70;

/** Cap an evidence string to something speakable. */
function cap(raw: string): string {
  return raw.length > MARKER_MAX_CHARS ? `${raw.slice(0, MARKER_MAX_CHARS - 1)}…` : raw;
}

/** Capped, speakable evidence line for a pattern. */
function markerOf(re: RegExp, text: string, fallback: string): string {
  return cap(findMarkerLine(text, re) ?? fallback);
}

/**
 * Classify one pane. Pure. The ladder is ordered by what BLOCKS hardest:
 * a stopped agent outranks a slow one, and every terminal verdict names
 * the marker that produced it.
 *
 * Ordering note — the modal check runs BEFORE the live-turn check, the
 * opposite of `src/core/pane-state.ts` (which ranks BUSY above MODAL on
 * the theory that the turn will resolve the modal). For triage the
 * opposite is right: a permission prompt means the agent has stopped and
 * will wait forever, which is precisely what the operator must be told,
 * and a stale spinner above it must not hide that.
 */
export function classifyPaneObservation(obs: PaneObservation): PaneVerdict {
  if (!obs.sessionUp) {
    return { bucket: "attention", kind: "dead", marker: "tmux session absent" };
  }
  if (!obs.windowPresent) {
    return { bucket: "attention", kind: "dead", marker: `window ${obs.windowName} absent` };
  }
  if (obs.capture === null) {
    return { bucket: "attention", kind: "unreadable", marker: "pane capture failed" };
  }
  if (obs.paneDead === true) {
    return { bucket: "attention", kind: "crashed", marker: "pane process exited" };
  }

  const text = tailWindow(stripAnsi(obs.capture));

  // Both of these use `findMarkerLine` as the PREDICATE, not merely to
  // build the evidence: a hit on a speculative line is not a hit at all.
  const rateLimit = findMarkerLine(text, RATE_LIMIT_RE);
  if (rateLimit !== null) {
    return { bucket: "attention", kind: "rate-limited", marker: cap(rateLimit) };
  }
  const modal = findMarkerLine(text, MODAL_RE);
  if (modal !== null) {
    return { bucket: "attention", kind: "permission-prompt", marker: cap(modal) };
  }
  const refusal = classifyRefusal(text);
  if (refusal.detected) {
    return {
      bucket: "attention",
      kind: "refusal",
      marker: `${refusal.severity} refusal: ${refusal.phrases[0]?.phrase ?? "refusal"}`,
    };
  }
  if (COMPACTING_RE.test(text)) {
    return { bucket: "quiet", kind: "compacting" };
  }

  const live = ACTIVE_TURN_RE.test(text);
  const stale = obs.activityAgeSec !== null && obs.activityAgeSec > FROZEN_ACTIVITY_SEC;
  if (live && stale) {
    // TRAP 3b — a spinner that has not repainted is not a working agent.
    return {
      bucket: "attention",
      kind: "frozen",
      marker: `no repaint in ${formatAge(obs.activityAgeSec ?? 0)} while showing ${markerOf(ACTIVE_TURN_RE, text, "a live turn")}`,
    };
  }
  if (live) {
    return { bucket: "quiet", kind: "working" };
  }

  // TRAP 3a — the quiet bucket requires POSITIVE evidence of a live TUI,
  // and this check precedes the composer scan because a shell prompt also
  // renders `❯`: without agent chrome, composer text is a shell command
  // line, not unsubmitted agent input.
  if (!AGENT_CHROME_RE.test(text) && !ALT_AGENT_CHROME_RE.test(text)) {
    const cmd = obs.currentCommand;
    if (cmd !== null && SHELL_COMMANDS.has(cmd)) {
      return {
        bucket: "attention",
        kind: "crashed",
        marker: `no agent TUI — pane is running ${cmd}`,
      };
    }
    return {
      bucket: "attention",
      kind: "unresponsive",
      marker: text.trim() === "" ? "pane is blank" : "no agent chrome in the pane",
    };
  }

  // TRAP 2 — reached only when NO live-turn marker fired, so a completed-
  // turn glyph (`✻ Worked for 22s`) can no longer mask residue sitting in
  // the composer. This is the wedge class the ADR-057 catalog buries
  // inside BUSY.
  const residue = extractComposerResidue(text);
  if (residue !== null) {
    const beingTyped = obs.activityAgeSec !== null && obs.activityAgeSec <= RESIDUE_FRESH_SEC;
    if (!beingTyped) {
      return {
        bucket: "attention",
        kind: "idle-residue",
        marker: `unsubmitted: ${residue.length > 60 ? `${residue.slice(0, 59)}…` : residue}`,
      };
    }
    return { bucket: "quiet", kind: "idle" };
  }

  if (obs.activityAgeSec !== null && obs.activityAgeSec > SILENT_IDLE_SEC) {
    return {
      bucket: "attention",
      kind: "dormant",
      marker: `no output for ${formatAge(obs.activityAgeSec)}`,
    };
  }
  // Chrome present but the token counter has never moved — booting, which
  // is nominal rather than a problem.
  if (FRESH_PANE_RE.test(text)) {
    return { bucket: "quiet", kind: "starting" };
  }
  return { bucket: "quiet", kind: "idle" };
}

/** Compact spoken duration: `45s`, `12m`, `3h`. No day units (global
 *  convention). */
export function formatAge(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

// ---------- Sweep → verdict ----------

/** Chars of pane gist carried per attention item. Two short lines of
 *  speech; the drill-in read (`member_pane`) is where detail belongs. */
export const GIST_MAX_CHARS = 160;

/** Lines of pane tail considered when building the gist. */
export const GIST_MAX_LINES = 2;

/**
 * Turn a sweep into a ranked verdict. Sorting is total and deterministic
 * — class rank, then team, then member — so the same fleet always speaks
 * in the same order and a test can pin it.
 */
export function buildVerdict(sweep: FleetSweep): FleetVerdict {
  const attention: AttentionItem[] = [];
  const quiet: QuietItem[] = [];

  for (const obs of sweep.panes) {
    const verdict = classifyPaneObservation(obs);
    if (verdict.bucket === "quiet") {
      quiet.push({ team: obs.team, member: obs.member, kind: verdict.kind });
      continue;
    }
    attention.push({
      team: obs.team,
      member: obs.member,
      kind: verdict.kind,
      marker: verdict.marker,
      gist: paneGist(obs.capture ?? "", { maxLines: GIST_MAX_LINES, maxChars: GIST_MAX_CHARS }),
    });
  }

  for (const ask of sweep.asks) {
    if (ask.driverInboxUnread === 0 && ask.openFlags === 0) continue;
    const parts: string[] = [];
    if (ask.driverInboxUnread > 0) parts.push(`${ask.driverInboxUnread} unread driver-inbox`);
    if (ask.openFlags > 0)
      parts.push(`${ask.openFlags} open flag${ask.openFlags === 1 ? "" : "s"}`);
    attention.push({
      team: ask.team,
      member: null,
      kind: "lead-ask",
      marker: parts.join(", "),
      gist: ask.gist,
    });
  }

  // Unreadable TEAMS deliberately do NOT become attention items: they get
  // their own rendered line (and their own `--json` field), so pushing
  // them here too would report each one twice and inflate the pane count
  // with things that are not panes. They are reported, never omitted —
  // just reported once.

  attention.sort((a, b) => {
    const byKind = ATTENTION_RANK[a.kind] - ATTENTION_RANK[b.kind];
    if (byKind !== 0) return byKind;
    const byTeam = a.team.localeCompare(b.team);
    if (byTeam !== 0) return byTeam;
    return (a.member ?? "").localeCompare(b.member ?? "");
  });
  quiet.sort((a, b) => a.team.localeCompare(b.team) || a.member.localeCompare(b.member));

  return {
    attention,
    quiet,
    unreadable: [...sweep.unreadable],
    paneCount: sweep.panes.length,
    teamsSurveyed: sweep.teamsSurveyed,
    elapsedMs: sweep.elapsedMs,
    ageMs: sweep.ageMs,
  };
}

// ---------- Rendering (the spoken shape) ----------

/** Default and bounds for the spoken item budget (ADR-273 D2). */
export const ATTENTION_TOP_DEFAULT = 5;
export const ATTENTION_TOP_MIN = 1;
export const ATTENTION_TOP_MAX = 15;

/** `"three rate-limited, one refusing the work"` — the remainder
 *  breakdown, most-urgent class first. */
export function summarizeRemainder(items: ReadonlyArray<AttentionItem>): string {
  const counts = new Map<AttentionClass, number>();
  for (const i of items) counts.set(i.kind, (counts.get(i.kind) ?? 0) + 1);
  const ordered = [...counts.entries()].sort((a, b) => ATTENTION_RANK[a[0]] - ATTENTION_RANK[b[0]]);
  return ordered.map(([kind, n]) => `${n} ${ATTENTION_REASON[kind]}`).join(", ");
}

function who(item: AttentionItem): string {
  return item.member === null ? item.team : `${item.team}/${item.member}`;
}

/** Members named in a collapsed group before the rest become a count. */
export const GROUP_MEMBERS_SPOKEN = 3;

/** One rendered entry: either a single item or a whole team's worth of
 *  the same problem. */
export interface AttentionGroup {
  items: AttentionItem[];
  /** Spoken subject — one pane, or the team plus how many of its panes. */
  subject: string;
}

/**
 * Collapse the ranked list into spoken entries, one per (class, team).
 *
 * Five panes on one team blocked by the SAME modal is ONE fact the
 * operator acts on once, and spending five of his five slots on it would
 * push every other team's findings into the remainder count. Rank order
 * is preserved: a group takes the position of its first (most urgent)
 * member, so collapsing never promotes anything.
 */
export function groupAttention(items: ReadonlyArray<AttentionItem>): AttentionGroup[] {
  const order: string[] = [];
  const byKey = new Map<string, AttentionItem[]>();
  for (const item of items) {
    const key = `${item.kind} ${item.team}`;
    const bucket = byKey.get(key);
    if (bucket === undefined) {
      byKey.set(key, [item]);
      order.push(key);
    } else {
      bucket.push(item);
    }
  }
  return order.map((key) => {
    const group = byKey.get(key) ?? [];
    const first = group[0] as AttentionItem;
    if (group.length === 1) return { items: group, subject: who(first) };
    const named = group
      .slice(0, GROUP_MEMBERS_SPOKEN)
      .map((i) => i.member ?? i.team)
      .join(", ");
    const extra = group.length - Math.min(group.length, GROUP_MEMBERS_SPOKEN);
    return {
      items: group,
      subject: `${first.team} — ${group.length} panes (${named}${extra > 0 ? ` +${extra}` : ""})`,
    };
  });
}

/**
 * `fleet_attention` output. Line-structural so the voice summarizer's
 * budget truncation drops WHOLE trailing lines — and because the list is
 * ranked most-urgent first, what it drops is always the least urgent.
 *
 * Shape:
 *   ATTENTION 7 of 62 panes across 19 teams (1.4s)
 *   1. atmux/be-1 — waiting on a permission prompt: Do you want Claude to
 *      > Bash(rm -rf build)
 *   …
 *   + 2 more: 1 idle with unsubmitted text, 1 asks waiting for you
 *   UNREADABLE 1 team: sopx — sweep deadline exceeded
 *   quiet: 55 panes — 40 working, 3 compacting, 12 idle and clear
 */
export function renderAttention(verdict: FleetVerdict, top: number): string {
  const total = verdict.attention.length;
  const head: string[] = [];
  const age =
    verdict.ageMs > 0 ? `, cached ${formatAge(Math.round(verdict.ageMs / 1000))} ago` : "";
  head.push(
    `ATTENTION ${total} findings across ${verdict.paneCount} panes in ${verdict.teamsSurveyed} teams (${(verdict.elapsedMs / 1000).toFixed(1)}s${age})`,
  );
  if (total === 0) {
    head.push("nothing needs you right now");
  }
  const groups = groupAttention(verdict.attention);
  const shown = groups.slice(0, Math.max(0, top));
  shown.forEach((group, idx) => {
    const first = group.items[0] as AttentionItem;
    head.push(`${idx + 1}. ${group.subject} — ${ATTENTION_REASON[first.kind]}: ${first.marker}`);
    if (first.gist.length > 0) head.push(`   > ${first.gist.replace(/\n/g, " / ")}`);
  });
  const rest = groups.slice(shown.length).flatMap((g) => g.items);
  if (rest.length > 0) {
    head.push(`+ ${rest.length} more: ${summarizeRemainder(rest)}`);
  }
  if (verdict.unreadable.length > 0) head.push(renderUnreadable(verdict.unreadable));
  head.push(`quiet: ${verdict.quiet.length} panes — ${quietBreakdown(verdict.quiet)}`);
  return head.join("\n");
}

/** Names spoken per unreadable REASON before the rest become a count. */
export const UNREADABLE_NAMES_SPOKEN = 3;

/**
 * The unreadable line, grouped by REASON rather than one row per team.
 *
 * Five dissolved epic-teams sharing one cause is one fact, not five, and
 * five identical clauses would eat the speech budget that the actual
 * findings need. Grouping keeps every team NAMED (nothing is dropped in
 * silence — ADR-273 §Consequences) while costing one clause per cause.
 */
export function renderUnreadable(items: ReadonlyArray<UnreadableTeam>): string {
  const byReason = new Map<string, string[]>();
  for (const u of items) {
    const list = byReason.get(u.reason) ?? [];
    list.push(u.team);
    byReason.set(u.reason, list);
  }
  const groups = [...byReason.entries()].map(([reason, teams]) => {
    const shown = teams.slice(0, UNREADABLE_NAMES_SPOKEN).join(", ");
    const extra = teams.length - Math.min(teams.length, UNREADABLE_NAMES_SPOKEN);
    return `${shown}${extra > 0 ? ` and ${extra} more` : ""} — ${reason}`;
  });
  return `UNREADABLE ${items.length} team${items.length === 1 ? "" : "s"}: ${groups.join("; ")}`;
}

/** `"40 working, 3 compacting, 12 idle and clear"`. Zero classes are
 *  omitted; an all-zero fleet renders `"none"`. */
export function quietBreakdown(items: ReadonlyArray<QuietItem>): string {
  const parts: string[] = [];
  for (const kind of QUIET_CLASSES) {
    const n = items.filter((i) => i.kind === kind).length;
    if (n > 0) parts.push(`${n} ${QUIET_LABEL[kind]}`);
  }
  return parts.length === 0 ? "none" : parts.join(", ");
}

/**
 * `fleet_quiet` output — counts and TEAM-LEVEL rollups only, never a pane
 * enumeration (D2). It exists so an empty attention list is CHECKABLE
 * rather than indistinguishable from a silently broken sweep, which is
 * why it leads with how much was actually surveyed.
 *
 * Shape:
 *   QUIET 17 of 19 teams nominal, 55 of 62 panes
 *   40 working, 3 compacting, 12 idle and clear
 *   needing you: 2 teams, 7 panes
 *   unreadable: 1 team — sopx
 */
export function renderQuiet(verdict: FleetVerdict): string {
  // A `dormant` pane is a CHRONIC state, not news: an agent parked with
  // nothing queued. Counting it against a team's nominal status would
  // make the all-clear read "0 of 20 teams nominal" on a fleet that is
  // simply idle — technically true, useless as reassurance, and it would
  // hide the teams with a real problem among the ones with none. So
  // nominal means "no ACUTE finding", and the parked count is spoken
  // separately rather than folded away.
  const acute = verdict.attention.filter((a) => !CHRONIC_CLASSES.has(a.kind));
  const parked = verdict.attention.filter((a) => CHRONIC_CLASSES.has(a.kind));
  const acuteTeams = new Set(acute.map((a) => a.team));
  // An unreadable team is not nominal either — unknown is not fine — but
  // it is NOT counted into "needing you", which reports findings.
  const troubled = new Set(acuteTeams);
  for (const u of verdict.unreadable) troubled.add(u.team);
  const nominal = Math.max(0, verdict.teamsSurveyed - troubled.size);
  const age =
    verdict.ageMs > 0 ? `, cached ${formatAge(Math.round(verdict.ageMs / 1000))} ago` : "";
  const lines: string[] = [
    `QUIET ${nominal} of ${verdict.teamsSurveyed} teams nominal, ${verdict.quiet.length} of ${verdict.paneCount} panes (${(verdict.elapsedMs / 1000).toFixed(1)}s${age})`,
    quietBreakdown(verdict.quiet),
  ];
  if (parked.length > 0) {
    const parkedTeams = new Set(parked.map((a) => a.team)).size;
    lines.push(
      `parked: ${parked.length} pane${parked.length === 1 ? "" : "s"} across ${parkedTeams} team${parkedTeams === 1 ? "" : "s"}`,
    );
  }
  if (acute.length > 0) {
    lines.push(
      `needing you: ${acute.length} finding${acute.length === 1 ? "" : "s"} across ${acuteTeams.size} team${acuteTeams.size === 1 ? "" : "s"}`,
    );
  }
  if (verdict.unreadable.length > 0) {
    lines.push(
      `unreadable: ${verdict.unreadable.length} team${verdict.unreadable.length === 1 ? "" : "s"} — ${verdict.unreadable.map((u) => u.team).join(", ")}`,
    );
  }
  return lines.join("\n");
}
