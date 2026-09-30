// ADR-305: `socket-dir` doctor probe — are this uid's tmux socket
// directories private?
//
// Rows:
//   - `socket-dir` green: the team's cage socket directory (and the
//     cockpit's `tmux-<uid>` directory) is private to this uid, or not
//     created yet. The detail carries the stable marker
//     {@link SOCKET_DIR_FEATURE} so a bootstrap can grep for it.
//   - `socket-dir` red: a directory is a symlink, foreign-owned, or has
//     group/world bits, or the socket node belongs to another uid. The
//     createTmux guard refuses that socket, so every cage verb fails
//     until the hint is applied.
//   - `socket-dir-legacy` yellow: a pre-ADR-305 `/tmp/atmux-<team>/sock`
//     that is ours but sits in a shared directory. atmux ignores it;
//     `atmux start` refuses while it is live (a second server would
//     duplicate the cage).
//
// Pure modulo lstat (through the socket-dir seams). Never touches tmux.

import { dirname } from "node:path";
import { resolveTeamSocket } from "../../core/common.ts";
import {
  currentUid,
  legacyCageSocketPath,
  legacySocketState,
  SOCKET_DIR_FEATURE,
  type SocketDirOpts,
  socketPathIssue,
  UnsafeSocketPathError,
} from "../../core/socket-dir.ts";
import { getCockpitSocketPath } from "../../core/tmux-paths.ts";
import type { Team } from "../../schema/team.ts";
import type { DoctorRow } from "./types.ts";

export interface CheckSocketDirsOpts extends SocketDirOpts {
  env?: NodeJS.ProcessEnv;
}

export function checkSocketDirs(team: Team | null, opts: CheckSocketDirsOpts = {}): DoctorRow[] {
  const uid = opts.uid === undefined ? currentUid() : opts.uid;
  if (uid === null) return [];
  const dirOpts = { uid, ...(opts.fs !== undefined ? { fs: opts.fs } : {}) };
  const rows: DoctorRow[] = [];
  const checked: string[] = [];
  const sockets: Array<{ socket: string; owner: string }> = [
    { socket: getCockpitSocketPath(opts.env ?? process.env, uid), owner: "cockpit" },
  ];
  if (team !== null) {
    sockets.push({ socket: resolveTeamSocket(team, dirOpts), owner: `team ${team.name}` });
  }
  for (const { socket, owner } of sockets) {
    const issue = socketPathIssue(socket, dirOpts);
    if (issue === null) {
      checked.push(dirname(socket));
      continue;
    }
    rows.push({
      status: "red",
      label: "socket-dir",
      detail: `${owner} socket ${socket}: ${issue.path} ${issue.detail} — atmux refuses it`,
      hint: issue.hint,
    });
  }
  if (team !== null && (team.tmuxTmpdir ?? "") === "") {
    const legacy = legacyCageSocketPath(team.name);
    if (legacySocketState(legacy, dirOpts) === "shared-dir") {
      const dir = dirname(legacy);
      rows.push({
        status: "yellow",
        label: "socket-dir-legacy",
        detail: `pre-ADR-305 socket ${legacy} is yours but ${dir} is shared — atmux ignores it`,
        hint: `if a cage is live there: chmod 700 ${dir} (atmux adopts it until its next restart); otherwise rm ${legacy}`,
      });
    }
  }
  if (rows.every((r) => r.status !== "red")) {
    rows.unshift({
      status: "green",
      label: "socket-dir",
      detail: `${SOCKET_DIR_FEATURE}: ${checked.join(", ")}`,
    });
  }
  return rows;
}

/** Run a cage-probing doctor check; a socket the ADR-305 guard refuses
 *  yields no rows (the `socket-dir` row already reports it) instead of
 *  aborting the whole doctor run. Other errors propagate unchanged. */
export async function unlessUnsafeSocket(
  check: () => Promise<DoctorRow[]> | DoctorRow[],
): Promise<DoctorRow[]> {
  try {
    return await check();
  } catch (e) {
    if (e instanceof UnsafeSocketPathError) return [];
    throw e;
  }
}
