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

import { walkSessions } from "./cockpit.ts";
import type { Cockpit as CockpitShape, EpicTeamSessionT } from "../schema/cockpit.ts";

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

    // Resolve epic-team's worktree path. ADR-089 §F places it inside
    // the parent at `.atmux/worktrees/<name>`. ADR-090's deprecated
    // sibling convention `<parentRoot>-epics/<epicId>` is the fallback
    // when the in-parent path is missing — covers older cages that
    // haven't migrated yet.
    const inParent = join(parentRoot, ".atmux", "worktrees", et.name);
    const sibling = `${parentRoot}-epics/${epicId}`;
    let epicRoot: string;
    if (exists(inParent)) {
      epicRoot = inParent;
    } else if (exists(sibling)) {
      epicRoot = sibling;
    } else {
      // Disk-layout drift — neither convention's path exists. Caller
      // (dispatcher) treats this as skipped-not-mine; operator
      // diagnoses via `atmux team list` + `ls`.
      epicRoot = inParent; // best guess for the reason string
    }

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
