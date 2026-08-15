// ADR-250 §D2 + ADR-251 — PRODUCTION enumerator + liveness seams for the
// stale-epic-team reaper (`src/core/orchd-reap.ts`). The reaper core ships
// safe no-op defaults (`listSpawnedEpicTeams → []`, `isCageAlive → true`);
// THIS module supplies the real implementations that `atmux orchd
// --reap-stale` injects.
//
//   listSpawnedEpicTeamsForTeam(atmuxDir) — walk the parent team's cockpit
//     sessions[] for `type:"epic-team"` children, read each child's
//     team.json (`<parentRoot>-epics/<epicId>/.atmux/team.json`) for the
//     authoritative `tmuxTmpdir`, and resolve the cage socket via
//     `resolveTeamSocket` — NEVER `resolveCageSocket`, which reports a live
//     epic cage as dead (ADR-251). The session name + exact-match `=` probe
//     mirror `dissolve-epic.ts::defaultCageTeardown` so the reaper's liveness
//     verdict matches the teardown path's.
//
//   isCageAliveForTeam(team) — fail-closed per ADR-251: when the epic's
//     `tmuxTmpdir` is unknown (team.json absent/unreadable ⇒ `cageSocket`
//     is ""), or the tmux probe throws, return ALIVE so a cage we cannot
//     probe is NEVER reaped. Only a real socket with no live session
//     (tmux `has-session` exits 1) yields `false` ⇒ dead-cage orphan.

import { join } from "node:path";
import { exists } from "../abstractions/fs.ts";
import { readJson } from "../abstractions/json.ts";
import { createTmux, type TmuxConfig, type TmuxNamespace } from "../abstractions/tmux.ts";
import { Team } from "../schema/team.ts";
import { loadCockpit, type LoadedCockpit, resolveCageSessionName, walkSessions } from "./cockpit.ts";
import { resolveTeamSocket } from "./common.ts";
import type { SpawnedEpicTeam } from "./orchd-reap.ts";

/** Strip a trailing `/.atmux` (and any trailing slashes) so an atmuxDir
 *  resolves to the team's repo root — the key the cockpit walk matches on. */
function teamRootFromAtmuxDir(atmuxDir: string): string {
  const noSlash = atmuxDir.replace(/\/+$/, "");
  return noSlash.endsWith("/.atmux") ? noSlash.slice(0, -"/.atmux".length) : noSlash;
}

function normalizeRoot(p: string): string {
  return p.replace(/\/+$/, "");
}

/** Minimal child-team.json view the enumerator needs. */
interface EpicTeamJsonView {
  name: string;
  tmuxTmpdir?: string;
}

export interface ListSpawnedEpicTeamsDeps {
  /** Load the cockpit roster. Default: real `loadCockpit`. */
  loadCockpitFn?: () => Promise<LoadedCockpit>;
  /** Read an epic's child team.json → `{name, tmuxTmpdir}` (or `null` when
   *  absent/unreadable — a fully-cleaned remnant). Default: fs-backed. */
  readEpicTeamJson?: (childTeamPath: string) => Promise<EpicTeamJsonView | null>;
  /** Resolve the cage tmux session name from the epic's root anchor.
   *  Default: `resolveCageSessionName` (mirrors `defaultCageTeardown`). */
  resolveSessionName?: (team: { name: string; root: string }) => Promise<string>;
  /** Override `process.getuid()` for the socket path (test determinism). */
  uid?: number;
}

async function defaultReadEpicTeamJson(childTeamPath: string): Promise<EpicTeamJsonView | null> {
  if (!(await exists(childTeamPath))) return null;
  try {
    const t = await readJson(childTeamPath, Team);
    const view: EpicTeamJsonView = { name: t.name };
    if (typeof t.tmuxTmpdir === "string" && t.tmuxTmpdir.length > 0) {
      view.tmuxTmpdir = t.tmuxTmpdir;
    }
    return view;
  } catch {
    // Corrupted/partial team.json — treat as unreadable (fail-closed:
    // cageSocket "" ⇒ isCageAliveForTeam returns ALIVE ⇒ never reaped).
    return null;
  }
}

/**
 * Enumerate the spawned epic-teams registered under the team rooted at
 * `atmuxDir`. Walks the cockpit `sessions[]` tree for `type:"epic-team"`
 * nodes whose nearest-ancestor team root equals this team's repo root,
 * then resolves each cage's socket + session name from its child team.json.
 *
 * Returns one `SpawnedEpicTeam` per registered epic-team. `cageSocket` is
 * "" when the child team.json is absent/unreadable or carries no
 * `tmuxTmpdir` — the liveness probe treats that as ALIVE (fail-closed,
 * ADR-251), so an unprobeable cage is never auto-reaped.
 */
export async function listSpawnedEpicTeamsForTeam(
  atmuxDir: string,
  deps: ListSpawnedEpicTeamsDeps = {},
): Promise<SpawnedEpicTeam[]> {
  const load = deps.loadCockpitFn ?? (() => loadCockpit());
  const readEpic = deps.readEpicTeamJson ?? defaultReadEpicTeamJson;
  const resolveSession = deps.resolveSessionName ?? resolveCageSessionName;

  const parentRoot = teamRootFromAtmuxDir(atmuxDir);
  const cockpit = await load();

  // Collect epic-team nodes whose parent team is the one rooted here.
  const epicNodes: Array<{ epicId: string }> = [];
  walkSessions(cockpit.sessions ?? [], 0, (node, _level, nodeParentRoot) => {
    if (node.type !== "epic-team") return;
    if (nodeParentRoot === undefined) return;
    if (normalizeRoot(nodeParentRoot) !== normalizeRoot(parentRoot)) return;
    // epic-team `name` IS the epicId (dissolve-epic matches on `s.name ===
    // epicId`); pass the same id so performDissolveEpic can find it.
    epicNodes.push({ epicId: node.name });
  });

  const out: SpawnedEpicTeam[] = [];
  for (const { epicId } of epicNodes) {
    const epicRoot = join(`${parentRoot}-epics`, epicId);
    const childTeamPath = join(epicRoot, ".atmux", "team.json");
    const childTeam = await readEpic(childTeamPath);

    const childName = childTeam?.name ?? epicId;
    const tmpdir = childTeam?.tmuxTmpdir;
    const cageSocket =
      typeof tmpdir === "string" && tmpdir.length > 0
        ? resolveTeamSocket(
            { name: childName, tmuxTmpdir: tmpdir },
            deps.uid !== undefined ? { uid: deps.uid } : {},
          )
        : ""; // unknown tmpdir → fail-closed ALIVE in the liveness probe

    const cageSessionName = await resolveSession({ name: childName, root: epicRoot });
    out.push({ epicId, cageSessionName, cageSocket });
  }
  return out;
}

export interface IsCageAliveDeps {
  /** tmux factory keyed by socket path. Default: real `createTmux`. */
  tmuxFactory?: (config: TmuxConfig) => TmuxNamespace;
}

/**
 * Liveness probe for the reaper's `isCageAlive` seam. Fail-closed per
 * ADR-251: an empty `cageSocket` (unknown `tmuxTmpdir`) ⇒ ALIVE; a tmux
 * probe error ⇒ ALIVE. Only a resolvable socket with no live session
 * (`has-session` exits 1) returns `false` — the dead-cage-orphan signal.
 *
 * The exact-match `=` prefix + session-name shape mirror
 * `dissolve-epic.ts::defaultCageTeardown`, so the reaper and the teardown
 * path agree on what "alive" means for the same cage.
 */
export async function isCageAliveForTeam(
  team: SpawnedEpicTeam,
  deps: IsCageAliveDeps = {},
): Promise<boolean> {
  if (team.cageSocket === "") return true; // unknown socket → never reap
  const tmux = (deps.tmuxFactory ?? createTmux)({ socketPath: team.cageSocket });
  try {
    return await tmux.session.hasSession(`=${team.cageSessionName}`);
  } catch {
    // Unexpected probe failure (exit >1, spawn error) — fail closed to
    // ALIVE so a cage we couldn't honestly probe is never destroyed.
    return true;
  }
}
