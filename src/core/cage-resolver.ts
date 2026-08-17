// e-11-446429c9 §S1 — resolveCageForEpic walker.
//
// Walks the loaded cockpit subtree to find the epic-team session whose
// `epicId` matches a given input. Returns enough info for the orchd
// dispatchers' resolveCage hook (CageInfo: name + root + parentBase)
// or for the merge invoker (atmuxDir + epicRepoPath + parentRepoPath).
//
// Pure: cockpit is passed in already-loaded; no IO. Tests construct
// synthetic cockpit shapes and assert on the returned shape.
//
// ADR-089 §F disk layout: epic-team worktree lives at
// `<parentRoot>/.atmux/worktrees/<epicTeamName>/`. ADR-090's sibling
// layout `<parentRoot>-epics/<epicId>/` is a deprecated alternative;
// the current shipping convention is in-parent worktrees (per ADR-082
// + ADR-084). When neither convention's path exists, the resolver
// returns null and the caller's safety net (skipped-not-mine) fires.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Cockpit as CockpitShape, EpicTeamSessionT } from "../schema/cockpit.ts";
import { walkSessions } from "./cockpit.ts";

/** Resolved cage description — mirrors the `CageInfo` shape that the
 *  orchd dispatchers (epic-merge.ts, dissolve-epic.ts, git-push.ts)
 *  consume via their `resolveCage` hook. */
export interface ResolvedCage {
  /** Epic-team's team.json::name — the value `targetCage` carries
   *  through the dispatcher contract. */
  name: string;
  /** Parent team name — the cage's parent in the cockpit tree. */
  parentTeamName: string;
  /** Absolute path to the parent team's worktree (a.k.a. parentRepoPath
   *  in EpicMergeContext). */
  parentRoot: string;
  /** Absolute path to the epic-team's own worktree. Defaults to the
   *  ADR-089 §F convention `<parentRoot>/.atmux/worktrees/<name>`;
   *  falls back to ADR-090's sibling convention `<parentRoot>-epics/
   *  <epicId>` when the in-parent path doesn't exist on disk. */
  epicRoot: string;
  /** epicId — same as the input, surfaced for caller convenience. */
  epicId: string;
  /** Level in the cockpit tree (0 = top-level under root sessions[]). */
  level: number;
}

/**
 * The two on-disk conventions an epic-team's OWN worktree can live at,
 * in precedence order.
 *
 *   1. ADR-089 §F, in-parent — `<parentRoot>/.atmux/worktrees/<name>`
 *   2. ADR-090 §Disk layout, sibling — `<parentRoot>-epics/<epicId>`
 *
 * Both are live on the fleet (the sibling form is what `spawn-epic`
 * actually writes today — see `verbs/team/spawn-epic.ts` §3), so a
 * consumer that knows only one of them silently misses half the cages.
 * The pair lives HERE, once, because three consumers now need it: the
 * dispatcher resolver below, `atmux fleet`'s sweep, and `dissolve-epic`.
 *
 * Pure — returns candidates, touches no disk. {@link resolveEpicCageRoot}
 * is the disk-aware half.
 */
export function epicCageRootCandidates(
  parentRoot: string,
  teamName: string,
  epicId: string,
): [string, string] {
  return [join(parentRoot, ".atmux", "worktrees", teamName), `${parentRoot}-epics/${epicId}`];
}

/**
 * An epic-team's OWN root on disk, or `null` when neither convention's
 * path exists.
 *
 * `null` is a real answer, not a failure: it means the epic-team's cage
 * is GONE while its cockpit entry survives — a stale registration the
 * operator prunes, not a probe that went wrong. Callers must not paper
 * over it with a best-guess path, because probing a guessed path reads
 * the PARENT's cage and reports a confident wrong answer about a team
 * that no longer exists.
 */
export function resolveEpicCageRoot(
  parentRoot: string,
  teamName: string,
  epicId: string,
  opts: { existsSync?: (p: string) => boolean } = {},
): string | null {
  const existsFn = opts.existsSync ?? existsSync;
  for (const candidate of epicCageRootCandidates(parentRoot, teamName, epicId)) {
    if (existsFn(candidate)) return candidate;
  }
  return null;
}

/** Resolve which cage (epic-team) in the loaded cockpit owns `epicId`.
 *  First-match wins on depth-first walk. Returns null when no epic-
 *  team session matches — the caller's dispatcher safety-net handles
 *  this as `skipped-not-mine` (no flag, no event noise per ADR-232
 *  §D3). */
export function resolveCageForEpic(
  cockpit: CockpitShape,
  epicId: string,
  opts: { existsSync?: (p: string) => boolean } = {},
): ResolvedCage | null {
  const exists = opts.existsSync ?? existsSync;
  let found: ResolvedCage | null = null;

  walkSessions(cockpit.sessions ?? [], 0, (node, level, parentRoot) => {
    if (found !== null) return;
    if (node.type !== "epic-team") return;
    const et = node as EpicTeamSessionT;
    if (et.epicId !== epicId) return;
    if (parentRoot === undefined) {
      // Walk invariant: epic-team's `parentRoot` should always be set
      // (the ancestor team's root). Defensive null-skip if the walk
      // somehow produced an orphan node — caller treats as miss.
      return;
    }

    // Resolve epic-team's worktree path through the shared candidate
    // list so this resolver and `atmux fleet`'s sweep can never disagree
    // about where a cage lives.
    const [inParent] = epicCageRootCandidates(parentRoot, et.name, epicId);
    // Disk-layout drift — neither convention's path exists. Caller
    // (dispatcher) treats this as skipped-not-mine; operator diagnoses
    // via `atmux team list` + `ls`. The in-parent form is the best guess
    // for the reason string.
    const epicRoot =
      resolveEpicCageRoot(parentRoot, et.name, epicId, { existsSync: exists }) ?? inParent;

    found = {
      name: et.name,
      parentTeamName: et.parent,
      parentRoot,
      epicRoot,
      epicId,
      level,
    };
  });

  return found;
}
