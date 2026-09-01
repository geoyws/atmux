import { readTextOrNull } from "../../abstractions/fs.ts";
import { resolveWorktreePath } from "../../abstractions/worktree.ts";
import { DEFAULT_SEND_KEYS_FAILURES_LOG_REL } from "../../core/safe-send.ts";
import type { Team } from "../../schema/team.ts";
import { type DoctorRow, defaultGitSpawn, type GitSpawn } from "./types.ts";

// ---------- ADR-137: member-forcepush-recent probe ----------

export interface CheckMemberForcePushRecentOpts {
  /** Git spawn override (test injection). Default uses the local
   *  `defaultGitSpawn` shared with the other doctor probes. */
  gitSpawn?: GitSpawn;
  /** Epoch-seconds clock override. Default `Date.now() / 1000`. Tests
   *  pin this to make `reflog --date=unix` matching deterministic. */
  now?: () => number;
  /** Time window in seconds. Default 3600 (1h). Reflog entries older
   *  than `now - windowSec` are skipped — the probe only fires on
   *  recent force-pushes; ancient history doesn't ping.
   *
   *  Operators who want a wider window can override via the `--`
   *  command-line wiring (deferred — not in this Task's scope). */
  windowSec?: number;
}

/**
 * ADR-137 §D3 — surface force-push events on per-member branches within
 * the last hour as YELLOW (warn-class, not block-class). The probe is
 * advisory: the harness force-push deny rule remains the actual gate;
 * this probe is the post-hoc surface for cases where the operator
 * authorized the force-push and the team-lead wants to know it
 * happened so the team can be nudged toward the ADR-137 merge-over-
 * rebase convention.
 *
 * Mechanism — for each member with a worktree under `<atmuxDir>/worktrees/`:
 *
 *   1. Resolve the worktree path (skipped if `worktreeIsolation !== true`
 *      — single-trunk teams don't have per-member branches to probe).
 *   2. Resolve the worktree's current branch via `git -C <wt>
 *      branch --show-current`. Skip if unresolvable (detached HEAD,
 *      missing worktree, broken git state — `checkWorktreeIsolation`
 *      already surfaces those).
 *   3. Read the reflog for that branch with `git -C <wt> reflog show
 *      <branch> --date=unix --format='%gd %gs' -n 30`. Entries arrive
 *      newest-first.
 *   4. Parse each line for `@{<unix>}` timestamp + reflog message.
 *      Filter: timestamp must be within `windowSec` of `now`, AND
 *      message must match `/forced/i` (covers `update by push
 *      (forced)`, `forced-update`, and the older `non-fast forward`
 *      reflog wordings).
 *   5. One YELLOW row per member with at least one matching event.
 *      Multiple force-pushes in the window collapse to a single row
 *      (the hint is the same regardless of count).
 *
 * Returns `[]` when no force-push events found or when the team's
 * worktree-isolation isn't on. Probe failures (git missing, worktree
 * unreadable) collapse to `[]` rather than throw — the team's own
 * doctor surface must stay green even when this probe can't run.
 */

export async function checkMemberForcePushRecent(
  team: Team | null,
  atmuxDir: string,
  opts: CheckMemberForcePushRecentOpts = {},
): Promise<DoctorRow[]> {
  if (team === null) return [];
  if (team.worktreeIsolation !== true) return [];
  const git = opts.gitSpawn ?? defaultGitSpawn;
  const nowFn = opts.now ?? ((): number => Math.floor(Date.now() / 1000));
  const windowSec = opts.windowSec ?? 3600;
  const now = nowFn();
  const cutoff = now - windowSec;

  const rows: DoctorRow[] = [];
  for (const member of team.members) {
    const wt = resolveWorktreePath(team, member.name, atmuxDir);
    let branch: string;
    try {
      const branchR = await git(["-C", wt, "branch", "--show-current"]);
      if (branchR.exitCode !== 0) continue;
      branch = branchR.stdout.trim();
      if (branch.length === 0) continue; // detached HEAD
    } catch {
      continue; // worktree gone, git missing, etc. — skip silently
    }

    let reflog: string;
    try {
      const reflogR = await git([
        "-C",
        wt,
        "reflog",
        "show",
        branch,
        "--date=unix",
        "-n",
        "30",
        "--format=%gd %gs",
      ]);
      if (reflogR.exitCode !== 0) continue;
      reflog = reflogR.stdout;
    } catch {
      continue;
    }

    let matchedMsg: string | null = null;
    for (const line of reflog.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const m = /@\{(\d+)\}:?\s*(.*)$/.exec(trimmed);
      if (m === null) continue;
      const ts = Number.parseInt(m[1] ?? "", 10);
      const msg = m[2] ?? "";
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      if (/forced/i.test(msg)) {
        matchedMsg = msg;
        break;
      }
    }
    if (matchedMsg !== null) {
      const short = matchedMsg.length > 60 ? `${matchedMsg.slice(0, 60)}…` : matchedMsg;
      rows.push({
        status: "yellow",
        label: `member-forcepush-recent:${member.name}`,
        detail: `${branch} reflog within ${windowSec}s: ${short}`,
        hint: "did you mean to merge instead of rebase? see ADR-137 §D1 — `git merge origin/<base>` keeps the branch in a consistent published state",
      });
    }
  }
  return rows;
}

// ---------- ADR-138 T3: send-keys-failure-recent probe ----------

export interface CheckSendKeysFailureRecentOpts {
  /** Override the `$HOME` used to resolve the escalation log path.
   *  Defaults to `process.env.HOME ?? ""`. Tests pin this so the probe
   *  reads from a sandbox directory. */
  home?: string;
  /** Direct override of the escalation log path. Wins over `home` when
   *  set. */
  logPath?: string;
  /** Epoch-seconds clock override (test injection). Defaults to
   *  `Date.now() / 1000`. */
  now?: () => number;
  /** Time window in seconds. Default 3600 (1h). Entries older than
   *  `now - windowSec` are not counted. */
  windowSec?: number;
}

/**
 * ADR-138 §"Doctor probe" — surfaces send-keys verification failures
 * (entries appended to `~/.atmux/state/send-keys-failures.log` by
 * `safeSendKeysWithVerify`'s escalation path) within the last hour
 * as a single YELLOW row.
 *
 * Warn-class because:
 *   - The escalation log is post-hoc evidence; the calling verb has
 *     already decided "this send-keys didn't verify" and returned its
 *     own non-zero or `success: false`.
 *   - The fix is operator-side (investigate stuck member, check budget,
 *     rotate-lead, etc.); the probe's role is surfacing, not blocking.
 *
 * Returns `[]` when the log is absent, empty, or has zero entries
 * within the window. Log-parse failures (corrupt file, permission
 * error, decode error) collapse to `[]` — the team's own doctor
 * surface must stay green even when this probe can't run. The log is
 * append-only + operator-managed; the probe doesn't truncate or
 * rewrite.
 *
 * Log entry shape (per `writeEscalationLog` in `src/core/safe-send.ts`):
 *
 *   [HH:MM MYT YYYY-MM-DD] target=<tgt> keys='<keys>' attempts=N timeout=Nms
 *   preCapture: <last 5 lines>
 *   postCapture: <last 5 lines>
 *   ---
 *
 * Parser anchors on the leading `[HH:MM MYT YYYY-MM-DD]` timestamp;
 * every other line is body and ignored. MYT is `+08:00` per global
 * CLAUDE.md §Timezone — the timestamp is parsed as a literal
 * `YYYY-MM-DDTHH:MM:00+08:00` ISO string.
 */

export async function checkSendKeysFailureRecent(
  opts: CheckSendKeysFailureRecentOpts = {},
): Promise<DoctorRow[]> {
  const nowFn = opts.now ?? ((): number => Math.floor(Date.now() / 1000));
  const windowSec = opts.windowSec ?? 3600;
  const now = nowFn();
  const cutoff = now - windowSec;

  const logPath =
    opts.logPath ??
    (() => {
      const home = opts.home ?? process.env.HOME ?? "";
      return home === ""
        ? DEFAULT_SEND_KEYS_FAILURES_LOG_REL
        : `${home}/${DEFAULT_SEND_KEYS_FAILURES_LOG_REL}`;
    })();

  const text = await readTextOrNull(logPath).catch(() => null);
  if (text === null || text.length === 0) return [];

  // Anchor on `[HH:MM MYT YYYY-MM-DD]` at line start. The MYT marker
  // disambiguates the timestamp shape from any timestamps that might
  // appear inside the `preCapture` / `postCapture` body lines.
  const tsRe = /^\[(\d{2}):(\d{2}) MYT (\d{4}-\d{2}-\d{2})\]/gm;
  let recentCount = 0;
  let mostRecentTs = 0;
  let mostRecentTarget = "";
  let m: RegExpExecArray | null = tsRe.exec(text);
  while (m !== null) {
    const [, hh, mm, ymd] = m;
    const epoch = Math.floor(Date.parse(`${ymd}T${hh}:${mm}:00+08:00`) / 1000);
    if (Number.isFinite(epoch) && epoch >= cutoff && epoch <= now) {
      recentCount += 1;
      if (epoch > mostRecentTs) {
        mostRecentTs = epoch;
        // Pull the `target=<tgt>` from the rest of the matched line for
        // the hint. `target` field is always present on entries written
        // by `writeEscalationLog` — defensive null on a malformed line.
        const lineEnd = text.indexOf("\n", m.index);
        const rest = text.slice(m.index, lineEnd === -1 ? text.length : lineEnd);
        const tm = /target=(\S+)/.exec(rest);
        mostRecentTarget = tm?.[1] ?? "";
      }
    }
    m = tsRe.exec(text);
  }

  if (recentCount === 0) return [];

  const ageMin = Math.max(1, Math.floor((now - mostRecentTs) / 60));
  const targetHint = mostRecentTarget.length > 0 ? ` (last: ${mostRecentTarget})` : "";
  return [
    {
      status: "yellow",
      label: "send-keys-failure-recent",
      detail: `${recentCount} send-keys failure${recentCount === 1 ? "" : "s"} in last hour${targetHint} — most recent ${ageMin}min ago`,
      hint: "send-keys failed N times in last hour; check ADR-138 escalation log at ~/.atmux/state/send-keys-failures.log",
    },
  ];
}
