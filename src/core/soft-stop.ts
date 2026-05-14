// ADR-087: Soft-stop orchestration — re-usable by `verbs/stop.ts` and
// (future) `verbs/team/dissolve-epic.ts` per ADR-090.
//
// The graceful counterpart to bare `atmux stop`. Where bare stop sends
// `C-c` (interrupt) + 2s grace + archive + kill, soft-stop sends a
// notice-only (comment-prefixed) line per pane, sleeps a longer grace
// (default 5s, configurable via `team.softStopGraceSeconds`), captures
// in-flight kanban state into `<atmuxDir>/state/resume.json`, then kills
// the session WITHOUT pruning worktrees.
//
// Hard-stop concerns (archive, cron-remove, force semantics) stay in
// `verbs/stop.ts` — this module is a pure orchestration helper composed
// in around them. Tests inject `tmux` + `kanban` + `clock` + `sleep` so
// the unit suite runs without a real tmux server.

import { atomicWrite } from "../abstractions/fs.ts";
import {
  buildWindowName,
  defaultEmojiForRole,
} from "./common.ts";
import type { SendTarget, TmuxNamespace } from "../abstractions/tmux.ts";
import { now } from "../abstractions/time.ts";
import { listTasks } from "./kanban.ts";
import type { KanbanTask } from "../schema/kanban.ts";
import {
  RESUME_MANIFEST_VERSION,
  type ResumeManifest,
  type ResumeMember,
  type ResumeReason,
} from "../schema/resume.ts";
import type { Team, TeamMember } from "../schema/team.ts";
import { join } from "node:path";

/** Default grace window between the per-member notify and the manifest
 *  write + session kill. Used when `team.softStopGraceSeconds` is unset.
 *  5 seconds — longer than bare `stop`'s 2s `C-c` grace because soft-stop
 *  is asking members to *finish*, not be interrupted. */
export const DEFAULT_SOFT_STOP_GRACE_SECONDS = 5;

/** One-line notice sent to each non-shell member's pane via `tmux
 *  send-keys`. Comment-prefixed (`#`) so TUI compose boxes show the
 *  text without auto-submitting it on the implicit-Enter after the
 *  send. Members reading the brief know to recognise the marker and
 *  finish their current `atmux done` before the session dies. */
export const SOFT_STOP_NOTICE =
  "# soft-stop incoming — finish current operation, no new claims";

export interface SoftStopOpts {
  /** Team config — needed for the member roster + grace override + the
   *  emoji-based window-name resolution. */
  team: Team;
  /** Atmux dir for the team (`<root>/.atmux`). Manifest lands at
   *  `<atmuxDir>/state/resume.json`. */
  atmuxDir: string;
  /** Tmux session name (e.g. `atmux-<team>`). Used to target send-keys. */
  sessionName: string;
  /** Tmux namespace — already bound to the team's cage socket. */
  tmux: TmuxNamespace;
  /** Why this manifest is being written. `soft-stop` for the verb
   *  path; `dissolve-epic` for the future ADR-090 caller. */
  reason: ResumeReason;
  /** Clock for `ts`. Injected for tests; defaults to {@link now}. */
  clock?: () => number;
  /** Sleep override for the grace window. Defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

/** Result of a soft-stop invocation. Callers (the verb) consume this
 *  to decide whether to proceed with kill/archive. The manifest is
 *  ALREADY written to disk by the time this returns — the result is
 *  primarily for tests + future composability with ADR-090. */
export interface SoftStopResult {
  /** The manifest as written to `<atmuxDir>/state/resume.json`. */
  manifest: ResumeManifest;
  /** Absolute path of the manifest file. */
  manifestPath: string;
  /** Count of members the notice was successfully sent to. Best-effort
   *  — a failure on one pane (member never spawned, window killed by
   *  another verb mid-flight) does not abort the soft-stop. */
  notifiedCount: number;
  /** Count of members with `lastClaim !== null` at stop-time. Surfaced
   *  by the verb as a one-line audit. */
  inFlightCount: number;
}

/**
 * Run the soft-stop orchestration. Does NOT kill the session — the
 * caller (verb or future dissolve-epic) handles the kill step so it
 * can compose with archive / cron-remove around it.
 *
 * Steps (ADR-087 §Decision):
 *   1. Read kanban for `status='in-progress'` tasks; build a per-member
 *      `ResumeMember` map.
 *   2. Send {@link SOFT_STOP_NOTICE} to each non-shell-only member's
 *      pane via `tmux send-keys` (best-effort).
 *   3. Sleep the grace window (`team.softStopGraceSeconds ?? 5` seconds).
 *   4. Atomic-write the manifest to `<atmuxDir>/state/resume.json`.
 */
export async function softStop(opts: SoftStopOpts): Promise<SoftStopResult> {
  const clock = opts.clock ?? now;
  const sleep =
    opts.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));

  // 1. Capture in-flight kanban state — read once, no mutations.
  const tasks = await listTasks(opts.atmuxDir);
  const inFlightByMember = indexInFlightByOwner(tasks);

  // 2. Notify each member's pane. Best-effort — non-shell-only members
  //    only, because shell panes have no compose box for the notice to
  //    show up in. Iterate the roster (NOT the kanban) so even idle
  //    members get the heads-up.
  let notifiedCount = 0;
  for (const member of opts.team.members) {
    const sent = await notifyMember(opts.tmux, opts.sessionName, opts.team, member);
    if (sent) notifiedCount += 1;
  }

  // 3. Grace window. Configurable via `team.softStopGraceSeconds`;
  //    `0` collapses to "no wait" but doesn't disable the rest.
  const graceSeconds = readGraceSeconds(opts.team);
  if (graceSeconds > 0) {
    await sleep(graceSeconds * 1000);
  }

  // 4. Build + write the manifest. Member roster order preserved.
  const manifest: ResumeManifest = {
    version: RESUME_MANIFEST_VERSION,
    ts: Math.floor(clock() / 1000),
    team: opts.team.name,
    reason: opts.reason,
    members: opts.team.members.map((m) => buildResumeMember(m, inFlightByMember)),
  };
  const manifestPath = resumeManifestPath(opts.atmuxDir);
  await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const inFlightCount = manifest.members.filter((m) => m.lastClaim !== null).length;
  return { manifest, manifestPath, notifiedCount, inFlightCount };
}

/** Path to the resume manifest. Exported so the start-side reader uses
 *  the SAME path constant — no risk of writer/reader drift. */
export function resumeManifestPath(atmuxDir: string): string {
  return join(atmuxDir, "state", "resume.json");
}

/** Path the start-side reader renames a consumed manifest to. The `<ts>`
 *  segment is the start-time epoch so a sequence of stops + starts
 *  leaves a readable forensic trail (`resume.json.1778700000.consumed`). */
export function consumedManifestPath(atmuxDir: string, ts: number): string {
  return join(atmuxDir, "state", `resume.json.${ts}.consumed`);
}

// ---------- Internals ----------

/** Group kanban in-progress tasks by `owner`. A member with multiple
 *  in-progress rows (shouldn't happen, but defensive) gets the most
 *  recently claimed one — `claimedAt` ordering with null-last. */
function indexInFlightByOwner(tasks: ReadonlyArray<KanbanTask>): Map<string, KanbanTask> {
  const byOwner = new Map<string, KanbanTask>();
  for (const t of tasks) {
    if (t.status !== "in-progress") continue;
    if (t.owner === null || t.owner === undefined || t.owner.length === 0) continue;
    const prior = byOwner.get(t.owner);
    if (prior === undefined) {
      byOwner.set(t.owner, t);
      continue;
    }
    // Pick the more recently claimed row when there's a tie. `claimedAt`
    // can be null on legacy rows; treat null as "older".
    const priorAt = prior.claimedAt ?? 0;
    const curAt = t.claimedAt ?? 0;
    if (curAt > priorAt) byOwner.set(t.owner, t);
  }
  return byOwner;
}

/** Build a `ResumeMember` for one team-roster entry. */
function buildResumeMember(
  member: TeamMember,
  inFlight: Map<string, KanbanTask>,
): ResumeMember {
  const task = inFlight.get(member.name);
  const emoji = member.emoji ?? defaultEmojiForRole(member.role ?? "member");
  return {
    name: member.name,
    lastClaim: task?.id ?? null,
    claimedAt: task?.claimedAt ?? null,
    windowName: emoji.length > 0 ? buildWindowName(member.name, emoji) : null,
  };
}

/** Read the grace window from `team.softStopGraceSeconds`, falling back
 *  to {@link DEFAULT_SOFT_STOP_GRACE_SECONDS}. The schema validates
 *  the field is `nonnegative integer | undefined`, so this read is
 *  total — no defensive coercion needed. */
function readGraceSeconds(team: Team): number {
  const v = (team as { softStopGraceSeconds?: number }).softStopGraceSeconds;
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return v;
  return DEFAULT_SOFT_STOP_GRACE_SECONDS;
}

/** Send the notice to one member's pane. Returns `true` when the send
 *  succeeded; `false` when the member was shell-only (notice skipped
 *  by design) OR the send failed (best-effort, swallow). */
async function notifyMember(
  tmux: TmuxNamespace,
  sessionName: string,
  team: Team,
  member: TeamMember,
): Promise<boolean> {
  // Shell-only members have no TUI compose box — the notice would just
  // become an unevaluated shell line. Skip cleanly.
  const tuiKind = member.tui;
  if (tuiKind === "shell" || tuiKind === "bash" || tuiKind === "zsh") {
    return false;
  }
  const emoji = member.emoji ?? defaultEmojiForRole(member.role ?? "member");
  if (emoji.length === 0) return false;
  const win = buildWindowName(member.name, emoji);
  const role = typeof member.role === "string" ? member.role : "member";
  const sendTarget: SendTarget =
    role === "team-lead"
      ? { kind: "lead", team: team.name, target: `${sessionName}:${win}` }
      : { kind: "member", member: member.name, team: team.name, target: `${sessionName}:${win}` };
  try {
    // `enter: false` — the notice is a comment-prefixed line that we
    // deliberately do NOT submit. The member reads it in the compose
    // box; they finish their work and then clear or submit as needed.
    // Some TUIs strip leading `#` on submit; the no-Enter contract
    // sidesteps that issue entirely.
    await tmux.pane.sendKeys({
      target: sendTarget,
      keys: SOFT_STOP_NOTICE,
      enter: false,
    });
    return true;
  } catch {
    // expected: window may not exist (member never spawned, or
    // already-killed by a racing verb). Best-effort, swallow.
    return false;
  }
}
