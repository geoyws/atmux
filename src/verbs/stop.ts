// ADR-010: CLI dispatcher — `stop` verb.
// ADR-004 amend: socket-pinned tmux factory.
// ADR-017: member windows no longer carry the `__<team>__` prefix.
// Bash spec: lib/stop.sh @ worktree-frozen.
//
// Behaviour (1:1 parity with bash, with the ADR-017 drift fix):
//
//   1. Resolve session name via getSessionName.
//   2. If session does not exist → warn + return 0 (bash:19-22).
//   3. Unless --force: send C-c to each member's window, sleep 2s
//      (bash:25-33). Bash filters windows by `^__<team>__` prefix —
//      that prefix was dropped in ADR-017, so the bash filter would
//      match zero windows in the post-ADR-017 world. The TS port
//      iterates team.members[] explicitly + builds window names via
//      buildWindowName(name, emoji).
//   4. Unless --no-archive: archive `inboxes/`, `kanban.json`,
//      `driver-inbox.md` to `<atmuxDir>/archive/<UTC-ts>/` (bash:43-51).
//   5. Kill the session.
//
// Concurrency: no kanban/inbox writes here, just file copies + tmux
// kill. No locking needed beyond what `core/inbox.ts` already provides
// for the in-flight writes that may be racing. Archive is best-effort
// — if a writer is mid-flock the snapshot may be stale; bash's `cp`
// has the same race.

import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { exists } from "../abstractions/fs.ts";
import { createTmux } from "../abstractions/tmux.ts";
import {
  archiveDir,
  buildWindowName,
  driverInboxPath,
  getAtmuxDir,
  getSessionName,
  inboxDir,
  kanbanJsonPath,
  type ResolveDirOpts,
  requireTeam,
} from "../core/common.ts";
import type { Team } from "../schema/team.ts";
import { UsageError } from "../errors.ts";
import { defaultSocketPath } from "./start.ts";

const USAGE = "atmux stop [--force|-f] [--no-archive]";

/** Parsed `stop` argv. */
export interface StopArgs {
  force: boolean;
  archive: boolean;
  socketPath?: string;
  teamDir?: string;
}

/** Pure parser. Throws `UsageError` on unknown args. */
export function parseStopArgs(argv: ReadonlyArray<string>): StopArgs {
  let force = false;
  let archive = true;
  let socketPath: string | undefined;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--force" || a === "-f") {
      force = true;
      i += 1;
      continue;
    }
    if (a === "--no-archive") {
      archive = false;
      i += 1;
      continue;
    }
    if (a === "--socket") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "stop: --socket requires a path", hint: USAGE });
      }
      socketPath = v;
      i += 2;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "stop: --team-dir requires a value", hint: USAGE });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    throw new UsageError({ what: `stop: unknown arg: ${a ?? ""}`, hint: USAGE });
  }
  const out: StopArgs = { force, archive };
  if (socketPath !== undefined) out.socketPath = socketPath;
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

/**
 * Build a UTC timestamp matching bash `date -u +%Y%m%dT%H%M%SZ`.
 * Exported for direct unit-testing without freezing time globally.
 */
export function archiveTimestamp(epochMs: number): string {
  const d = new Date(epochMs);
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  const hh = d.getUTCHours().toString().padStart(2, "0");
  const mi = d.getUTCMinutes().toString().padStart(2, "0");
  const ss = d.getUTCSeconds().toString().padStart(2, "0");
  return `${yyyy}${mm}${dd}T${hh}${mi}${ss}Z`;
}

/** `atmux stop [--force] [--no-archive]`. Returns 0. */
export async function stop(argv: ReadonlyArray<string>): Promise<number> {
  const parsed = parseStopArgs(argv);
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const team: Team = await requireTeam(dirOpts);
  const sessionName = await getSessionName({ ...dirOpts, team });
  const atmuxDir = await getAtmuxDir(dirOpts);
  const socketPath = parsed.socketPath ?? defaultSocketPath(team.name);
  const tmux = createTmux({ socketPath });

  if (!(await tmux.session.hasSession(`=${sessionName}`))) {
    process.stderr.write(`atmux: warn: session ${sessionName} does not exist — nothing to stop\n`);
    return 0;
  }

  if (!parsed.force) {
    await sendCancelToMembers(tmux, sessionName, team);
    await sleep(2000);
  }

  if (parsed.archive) {
    await archiveState(atmuxDir);
  }

  // Bash uses `kill-session ... 2>/dev/null || true` — best-effort.
  try {
    await tmux.session.killSession(`=${sessionName}`);
  } catch {
    // expected: session may have died between has-session and kill
    // (race on a parallel `atmux stop`). Safe to swallow.
  }
  process.stdout.write(`session ${sessionName} stopped\n`);
  return 0;
}

// ---------- Internals ----------

async function sendCancelToMembers(
  tmux: ReturnType<typeof createTmux>,
  sessionName: string,
  team: Team,
): Promise<void> {
  // ADR-017: window names are bare member names (or emoji+name); no
  // `__<team>__` prefix. Iterate roster + build window names directly.
  for (const m of team.members) {
    const win = buildWindowName(m.name, m.emoji);
    const target = `${sessionName}:${win}`;
    try {
      await tmux.pane.sendKeys({ target, keys: "C-c", enter: false });
    } catch {
      // expected: window may not exist (member never spawned, or
      // already-killed). Bash uses `2>/dev/null || true` here.
    }
  }
}

/**
 * Copy `.atmux/inboxes/`, `.atmux/kanban.json`, `.atmux/driver-inbox.md`
 * to `.atmux/archive/<ts>/` if present. Best-effort — bash mirrors
 * the same `2>/dev/null || true` pattern (lib/stop.sh:47-49).
 */
async function archiveState(atmuxDir: string): Promise<void> {
  const ts = archiveTimestamp(Date.now());
  const dest = join(archiveDir(atmuxDir), ts);
  await mkdir(dest, { recursive: true });

  // inboxes/ → archive/<ts>/inboxes/
  const srcInboxes = inboxDir(atmuxDir);
  if (await exists(srcInboxes)) {
    const destInboxes = join(dest, "inboxes");
    await mkdir(destInboxes, { recursive: true });
    for (const entry of await readdir(srcInboxes)) {
      try {
        await copyFile(join(srcInboxes, entry), join(destInboxes, entry));
      } catch {
        // expected: race or transient failure; archive is best-effort.
      }
    }
  }

  // kanban.json → archive/<ts>/kanban.json
  const srcKanban = kanbanJsonPath(atmuxDir);
  if (await exists(srcKanban)) {
    try {
      await copyFile(srcKanban, join(dest, "kanban.json"));
    } catch {
      // expected: best-effort.
    }
  }

  // driver-inbox.md → archive/<ts>/driver-inbox.md
  const srcDriver = driverInboxPath(atmuxDir);
  if (await exists(srcDriver)) {
    try {
      await copyFile(srcDriver, join(dest, "driver-inbox.md"));
    } catch {
      // expected: best-effort.
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
