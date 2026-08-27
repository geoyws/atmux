// ADR-252 (P0, t-65bec10b) — structural guard against orphaning live
// CHILD cages when a removal/probe path wipes a parent team's
// `/tmp/atmux-<parent>/` tmpdir wholesale.
//
// ADR-280 stage 3 GENERALISED this module. It was `epic-cage-children.ts`
// and globbed exactly one hardcoded group directory, `<parent>/epics/*`,
// because epic-teams were the only nested cage that existed. Epic-teams
// are retired; nested cages are NOT — ADR-089 §Amendment 2026-08-27 §(A)
// makes arbitrary-depth nesting the general model, so the INVARIANT this
// guard encodes outlives the epic-shaped instance that motivated it.
// The glob is therefore structural (any nested cage socket under the
// parent tmpdir) rather than name-based.
//
// The bug class (2026-05-17 incident): a cleanup/probe found no live tmux
// server at the parent team's OWN expected socket, declared the whole
// `/tmp/atmux-<parent>/` directory an orphan, and `rm -rf`'d it — taking
// its live CHILD cages with it. A child cage's socket lives at
// `<childTmpdir>/tmux-<uid>/default` (the `resolveTeamSocket(tmuxTmpdir)`
// scheme per ADR-251), and `<childTmpdir>` sits UNDER the parent tmpdir —
// historically `<parent>/epics/<epicId>` (ADR-090 §Disk layout), in the
// general model any nested path. The parent dir can exist ONLY because of
// those children when the parent itself uses a legacy project-local
// socket, so a parent-liveness probe is the WRONG signal to gate a
// wholesale removal on.
//
// This module supplies the structural prevention: `hasLiveChildCages`
// enumerates candidate child tmpdirs under `<parentTmpdir>` (one and two
// levels down — the two shapes the tree produces), resolves each one's
// socket the same way the rest of the tree resolves a cage socket from a
// `tmuxTmpdir`, and probes the tmux server on it. Any removal path that
// would `rm -rf` a parent tmpdir consults this first and refuses when a
// child is live.
//
// The parent's OWN socket artefacts are skipped by name: `sock` (the
// `/tmp/atmux-<team>/sock` default-cage convention) and `tmux-<uid>`
// (`resolveTeamSocket` with an explicit `team.tmuxTmpdir`). Everything
// else under the parent tmpdir is a candidate child. Probing a directory
// that is NOT a cage is harmless — `listSessions()` on a socket path with
// no server returns `[]` (tmux exits 1 with empty stdout, see tmux.ts),
// which reads as "not live", not as an error.
//
// FAIL-SAFE DIRECTION (opposite of the reaper, same safety direction).
// The ADR-250 reaper was fail-CLOSED-to-ALIVE: on any uncertainty it
// returned ALIVE so it never reaped a cage it couldn't honestly probe.
// This guard is the mirror image — fail-SAFE-to-TRUE: on genuine
// UNCERTAINTY (the parent dir errors on listing — permission denied, a
// file where a dir was expected — or a per-child probe throws) it returns
// `true` ("has live children") so the caller REFUSES the removal. Both
// err in the same direction: toward NOT destroying.
//
// ENOENT carve-out (NOT uncertainty): a missing directory is the
// DEFINITIVE "nothing nested here" signal, not an unlistable one. An
// absent parent tmpdir reads as `false` (no live children ⇒ removal may
// proceed); an absent second-level dir simply contributes no candidates.
// Folding absent-dir into the fail-safe branch would skip EVERY ordinary
// team tmpdir and defeat the zombie sweep's purpose. Only a directory
// that exists-but-cannot-be-honestly-listed is uncertainty.
//
// Liveness signal (judgment call, documented per task): we probe whether
// a tmux SERVER is alive on the cage socket via `listSessions().length >
// 0`. We deliberately do NOT use the exact-match `has-session(=<name>)`
// shape a teardown path uses, because this guard only has the parent
// tmpdir + the child's directory name in hand — it does NOT cheaply have
// each child's authoritative cage session name (that lives in the child's
// `team.json`, which a wholesale-removal probe may not have loaded, and
// which may be absent on a remnant). "Any session alive on this cage
// socket" is the simplest correct liveness signal for the question we're
// answering ("would removing this parent dir orphan a running cage?") — a
// cage tmux server is single-purpose by ADR-018 (one cage = one server),
// so a non-empty session list IS a live cage. `listSessions()` returns
// `[]` (not a throw) when the server is down, so a genuinely-dead cage
// reads as zero sessions, not as an error → not fail-safe-tripped.

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createTmux, type TmuxConfig, type TmuxNamespace } from "../abstractions/tmux.ts";

/** Names directly under a parent tmpdir that belong to the PARENT's own
 *  cage, not to a child. `sock` is the `/tmp/atmux-<team>/sock` default;
 *  `tmux-<uid>` is `resolveTeamSocket`'s explicit-tmuxTmpdir shape. */
const PARENT_OWN_SOCKET_ENTRY = /^(sock|tmux-\d+)$/;

/** Dependency seams so the guard is filesystem- + tmux-free in tests.
 *  Mirrors the injection style of `groom.ts::SweepZombieSocketsOpts`. */
export interface HasLiveChildCagesDeps {
  /** List the immediate child names of `dir`. Called for the parent
   *  tmpdir and then once per surviving first-level entry (to reach the
   *  historical `<parent>/<group>/<child>` shape, e.g. `epics/<epicId>`).
   *  Default: `node:fs/promises` readdir (names only), returning `[]` on
   *  ENOENT / ENOTDIR (nothing nested there — definitive, not uncertain)
   *  and RE-THROWING any other error so the fail-safe catch in
   *  {@link hasLiveChildCages} converts it to `true`. */
  listDir?: (dir: string) => Promise<string[]>;
  /** tmux factory keyed by socket path. Default: real `createTmux`. */
  tmuxFactory?: (config: TmuxConfig) => TmuxNamespace;
  /** Override `process.getuid()` for the cage socket path (test
   *  determinism). Default: `process.getuid?.() ?? 0`. */
  uid?: number;
}

/** Default directory lister — names only. ENOENT / ENOTDIR (absent, or a
 *  file where a dir was expected at the second level) returns `[]` — the
 *  DEFINITIVE "nothing nested here" signal, NOT uncertainty. Every OTHER
 *  error (permission denied, …) re-throws so the caller's catch fails
 *  SAFE to `true` (refuse removal). */
async function defaultListDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (e) {
    if (isEnoent(e) || isEnotdir(e)) return []; // definitively no children here
    throw e; // genuine uncertainty ⇒ caller fails safe to true
  }
}

/** True when the thrown error is an ENOENT (missing path). Local copy —
 *  `fs.ts::isEnoent` is module-private; the shape check is identical. */
function isEnoent(e: unknown): boolean {
  return hasCode(e, "ENOENT");
}

/** True when the thrown error is an ENOTDIR (a file where a directory was
 *  expected — a plain file sitting beside the child cage dirs). */
function isEnotdir(e: unknown): boolean {
  return hasCode(e, "ENOTDIR");
}

function hasCode(e: unknown, code: string): boolean {
  return (
    typeof e === "object" && e !== null && "code" in e && (e as { code?: unknown }).code === code
  );
}

/**
 * True when ANY nested child cage under `parentTmpdir` has a live tmux
 * server, OR when liveness cannot be honestly determined (fail-safe).
 * Callers use this to REFUSE a wholesale removal of `parentTmpdir` that
 * would otherwise orphan live children.
 *
 * Candidate child tmpdirs, both shapes the tree produces:
 *   - `<parentTmpdir>/<child>`          (directly-nested child cage)
 *   - `<parentTmpdir>/<group>/<child>`  (grouped — the historical
 *                                        `epics/<epicId>` layout)
 * Entries matching the parent's own socket artefacts (`sock`,
 * `tmux-<uid>`) are skipped; they are the parent, not a child.
 *
 * Resolution per candidate:
 *   socket = `<candidate>/tmux-<uid>/default`
 * — the same `<tmuxTmpdir>/tmux-<uid>/default` scheme `resolveTeamSocket`
 * builds (ADR-251), since a nested cage's `tmuxTmpdir` IS its directory
 * under the parent tmpdir.
 *
 * Fail-SAFE (errs toward NOT deleting — see module header):
 *   - parent tmpdir exists-but-unlistable (permission)  → `true`
 *   - a per-child probe throws                          → `true`
 * In every UNCERTAIN case the verdict is "has live children" so removal
 * is refused. The ENOENT/ENOTDIR carve-out is NOT uncertainty: an absent
 * directory is the definitive "no children" signal.
 *
 * @returns `false` ONLY when the parent tmpdir is absent OR lists cleanly
 *   with no candidate child cage having a live tmux server; `true` on any
 *   live child or any genuine listing/probe uncertainty.
 */
export async function hasLiveChildCages(
  parentTmpdir: string,
  deps: HasLiveChildCagesDeps = {},
): Promise<boolean> {
  const list = deps.listDir ?? defaultListDir;
  const tmuxFactory = deps.tmuxFactory ?? createTmux;
  const uid = deps.uid ?? process.getuid?.() ?? 0;

  let topLevel: string[];
  try {
    topLevel = await list(parentTmpdir);
  } catch (e) {
    // ENOENT / ENOTDIR is the DEFINITIVE "nothing nested here" signal,
    // not uncertainty — an absent parent tmpdir has no children to
    // orphan. (`defaultListDir` already absorbs these; the check is
    // repeated here so an INJECTED lister that re-throws them lands on
    // the same verdict as the default one.) Any OTHER failure —
    // permission denied and friends — is genuine uncertainty: fail SAFE,
    // assume there could be live children, refuse removal.
    return !(isEnoent(e) || isEnotdir(e));
  }

  for (const entry of topLevel) {
    if (PARENT_OWN_SOCKET_ENTRY.test(entry)) continue; // the parent's own socket
    const candidate = join(parentTmpdir, entry);

    // Shape 1 — `<parentTmpdir>/<child>` is itself a nested cage tmpdir.
    if (await probeCageSocket(candidate, uid, tmuxFactory)) return true;

    // Shape 2 — `<parentTmpdir>/<group>/<child>`; the historical
    // `epics/<epicId>` layout is exactly this with `group === "epics"`.
    let nested: string[];
    try {
      nested = await list(candidate);
    } catch (e) {
      // Same split as above: an absent / not-a-directory entry simply
      // contributes no candidates; anything else is uncertainty and
      // fails SAFE to "has live children".
      if (isEnoent(e) || isEnotdir(e)) continue;
      return true;
    }
    for (const child of nested) {
      if (PARENT_OWN_SOCKET_ENTRY.test(child)) continue;
      if (await probeCageSocket(join(candidate, child), uid, tmuxFactory)) return true;
    }
  }

  return false;
}

/** Probe `<tmuxTmpdir>/tmux-<uid>/default` for a live tmux server.
 *  Returns `true` on a live server AND on a thrown probe (fail SAFE —
 *  treat an unprobeable candidate as live ⇒ refuse removal). A path that
 *  is not a cage at all yields `[]` from `listSessions()` (tmux exits 1
 *  with empty stdout), i.e. `false`, so non-cage directories under the
 *  parent do not produce false refusals. */
async function probeCageSocket(
  tmuxTmpdir: string,
  uid: number,
  tmuxFactory: (config: TmuxConfig) => TmuxNamespace,
): Promise<boolean> {
  const socket = join(tmuxTmpdir, `tmux-${uid}`, "default");
  try {
    const tmux = tmuxFactory({ socketPath: socket });
    const sessions = await tmux.session.listSessions();
    // One cage = one server (ADR-018); a non-empty session list ⇒ a live
    // cage server bound to this socket.
    return sessions.length > 0;
  } catch {
    // The probe threw (socket garbled, spawn error, …). Fail SAFE.
    return true;
  }
}
