// ADR-252 (P0, t-65bec10b) — structural guard against orphaning live
// epic-team children when a removal/probe path wipes a parent team's
// `/tmp/atmux-<parent>/` tmpdir wholesale.
//
// The bug class (2026-05-17 incident): a cleanup/probe found no live tmux
// server at the parent team's OWN expected socket, declared the whole
// `/tmp/atmux-<parent>/` directory an orphan, and `rm -rf`'d it — taking
// its live epic-team CHILDREN with it. Epic cages live at
// `/tmp/atmux-<parent>/epics/<epicId>/tmux-<uid>/default` (ADR-090 §Disk
// layout); the parent dir can exist ONLY because of those children when
// the parent itself uses a legacy project-local socket, so a parent-
// liveness probe is the WRONG signal to gate a wholesale removal on.
//
// This module supplies the structural prevention: `hasLiveEpicChildren`
// enumerates `<parentTmpdir>/epics/*`, resolves each child cage's socket
// the SAME way the rest of the tree resolves epic-cage sockets
// (`<parentTmpdir>/epics/<epicId>/tmux-<uid>/default` — the
// `resolveTeamSocket(tmuxTmpdir)` scheme per ADR-251), and probes the
// tmux server on it. Any removal path that would `rm -rf` a parent
// tmpdir consults this first and refuses when a child is live.
//
// FAIL-SAFE DIRECTION (opposite of the reaper, same safety direction).
// The ADR-250 reaper (`orchd-reap-enum.ts::isCageAliveForTeam`) is fail-
// CLOSED-to-ALIVE: on any uncertainty it returns ALIVE so it never reaps
// a cage it couldn't honestly probe. This guard is the mirror image —
// fail-SAFE-to-TRUE: on genuine UNCERTAINTY (the epics dir errors on
// listing — permission denied, a file where a dir was expected — or a
// per-child probe throws) it returns `true` ("has live children") so the
// caller REFUSES the removal. Both err in the same direction: toward NOT
// destroying. The reaper protects an individual cage; this guard protects
// the shared parent tmpdir that hosts a cage's siblings.
//
// ENOENT carve-out (NOT uncertainty): a missing `<parentTmpdir>/epics`
// directory is the DEFINITIVE "this team has no epic children" signal —
// the overwhelmingly-common case for an ordinary (non-epic-hosting) team
// tmpdir. That reads as `false` (no live children ⇒ removal may proceed),
// NOT as fail-safe-true. Folding absent-epics-dir into the fail-safe
// branch would skip EVERY non-epic tmpdir and defeat the zombie sweep's
// purpose. Only an epics dir that exists-but-cannot-be-honestly-listed
// is uncertainty.
//
// Liveness signal (judgment call, documented per task): we probe whether
// a tmux SERVER is alive on the cage socket via `listSessions().length >
// 0`. We deliberately do NOT use the exact-match `has-session(=<name>)`
// shape that `isCageAliveForTeam` / `defaultCageTeardown` use, because
// this guard only has the parent tmpdir + epicId in hand — it does NOT
// cheaply have each child's authoritative cage session name (that lives
// in the child's `team.json`, which a wholesale-removal probe may not
// have loaded, and which may be absent on a remnant). "Any session alive
// on this cage socket" is the simplest correct liveness signal for the
// question we're answering ("would removing this parent dir orphan a
// running cage?") — a cage tmux server is single-purpose by ADR-018
// (one cage = one server), so a non-empty session list IS a live cage.
// `listSessions()` returns `[]` (not a throw) when the server is down
// (tmux exits 1 with empty stdout — see tmux.ts), so a genuinely-dead
// cage reads as zero sessions, not as an error → not fail-safe-tripped.

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createTmux, type TmuxConfig, type TmuxNamespace } from "../abstractions/tmux.ts";

/** Dependency seams so the guard is filesystem- + tmux-free in tests.
 *  Mirrors the injection style of `orchd-reap-enum.ts` +
 *  `groom.ts::SweepZombieSocketsOpts`. */
export interface HasLiveEpicChildrenDeps {
  /** List the immediate child names of `<parentTmpdir>/epics` (each is an
   *  epicId dir). Default: `node:fs/promises` readdir (names only),
   *  returning `[]` on ENOENT (epics dir absent ⇒ definitively no
   *  children) and RE-THROWING any other error so the fail-safe catch in
   *  `hasLiveEpicChildren` converts it to `true`. */
  listEpicDir?: (epicsDir: string) => Promise<string[]>;
  /** tmux factory keyed by socket path. Default: real `createTmux`. */
  tmuxFactory?: (config: TmuxConfig) => TmuxNamespace;
  /** Override `process.getuid()` for the cage socket path (test
   *  determinism). Default: `process.getuid?.() ?? 0`. */
  uid?: number;
}

/** Default epics-dir lister — names only (each is an epicId dir). ENOENT
 *  (epics dir absent) returns `[]` — the DEFINITIVE "no epic children"
 *  signal for an ordinary team tmpdir, NOT uncertainty. Every OTHER error
 *  (permission denied, a file where a dir was expected) re-throws so the
 *  caller's catch fails SAFE to `true` (refuse removal). */
async function defaultListEpicDir(epicsDir: string): Promise<string[]> {
  try {
    return await readdir(epicsDir);
  } catch (e) {
    if (isEnoent(e)) return []; // absent epics dir ⇒ definitively no children
    throw e; // genuine uncertainty ⇒ caller fails safe to true
  }
}

/** True when the thrown error is an ENOENT (missing path). Local copy —
 *  `fs.ts::isEnoent` is module-private; the shape check is identical. */
function isEnoent(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * True when ANY epic-team child cage under `<parentTmpdir>/epics/*` has a
 * live tmux server, OR when liveness cannot be honestly determined
 * (fail-safe). Callers use this to REFUSE a wholesale removal of
 * `parentTmpdir` that would otherwise orphan live epic children.
 *
 * Resolution per child:
 *   socket = `<parentTmpdir>/epics/<epicId>/tmux-<uid>/default`
 * — the same `<tmuxTmpdir>/tmux-<uid>/default` scheme `resolveTeamSocket`
 * builds (ADR-251), since an epic cage's `tmuxTmpdir` IS
 * `<parentTmpdir>/epics/<epicId>` (ADR-090 §Disk layout / spawn-epic §S2).
 *
 * Fail-SAFE (errs toward NOT deleting — see module header):
 *   - epics dir exists-but-unlistable (permission, not-a-dir) → `true`
 *   - a per-child probe throws                                → `true`
 * In every UNCERTAIN case the verdict is "has live children" so removal
 * is refused. The ENOENT carve-out is NOT uncertainty: an absent epics
 * dir is the definitive "no children" signal and yields `false`.
 *
 * @returns `false` ONLY when the epics dir is absent OR lists cleanly with
 *   no child cage having a live tmux server; `true` on any live child or
 *   any genuine listing/probe uncertainty.
 */
export async function hasLiveEpicChildren(
  parentTmpdir: string,
  deps: HasLiveEpicChildrenDeps = {},
): Promise<boolean> {
  const list = deps.listEpicDir ?? defaultListEpicDir;
  const tmuxFactory = deps.tmuxFactory ?? createTmux;
  const uid = deps.uid ?? process.getuid?.() ?? 0;
  const epicsDir = join(parentTmpdir, "epics");

  let epicIds: string[];
  try {
    epicIds = await list(epicsDir);
  } catch {
    // Can't enumerate the epics dir (absent, permission, a file where a
    // dir was expected, …). Fail SAFE: assume there could be live
    // children ⇒ refuse removal. Contrast with the reaper's fail-closed-
    // to-ALIVE: same safety direction (never destroy on uncertainty).
    return true;
  }

  for (const epicId of epicIds) {
    const socket = join(epicsDir, epicId, `tmux-${uid}`, "default");
    try {
      const tmux = tmuxFactory({ socketPath: socket });
      const sessions = await tmux.session.listSessions();
      // One cage = one server (ADR-018); a non-empty session list ⇒ a
      // live cage server bound to this socket. `listSessions()` returns
      // [] (not a throw) for a down server, so a dead cage reads as 0.
      if (sessions.length > 0) return true;
    } catch {
      // The probe threw (socket garbled, spawn error, …). Fail SAFE:
      // treat THIS child as live ⇒ refuse removal. We do not let one
      // unprobeable sibling mask another that might list cleanly, but a
      // single live/unprobeable child is enough to refuse, so we return
      // immediately.
      return true;
    }
  }

  return false;
}
