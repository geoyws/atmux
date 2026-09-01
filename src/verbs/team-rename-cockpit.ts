// ADR-027 T4: cockpit registry sync (orchestration step 7).
//
// Standalone module per the 2026-05-20 epic-team co-author convention —
// each member's worker-local code lives in its own file so concurrent
// worktree writes can't clobber siblings. The dispatcher in
// `src/verbs/team-rename.ts` (T2) imports `syncCockpitRegistry` from
// here when wiring step 7 into its rollback chain; the RollbackStep
// contract (`team-rename.ts::RollbackStep`) is shared so the reverse-
// walk engine in `team-rename.ts::rollbackWalk` undoes step 7 without
// caring which file produced the closure.
//
// Pattern note (vs `core/cockpit.ts::loadCockpit`): this module calls
// `migrateLegacyShape` directly + parses via the raw `Cockpit` schema,
// BYPASSING `loadCockpit`'s legacy-field ENRICHMENT pass. That keeps
// the round-trip canonical — the file written back contains only the
// ADR-089 `sessions[]` tree, not the synthesized legacy `teams[]` /
// `superdoctor` / `medic` top-level mirrors. Operators on pre-ADR-089
// cockpit.json see a one-time migration to canonical shape on the
// next rename — matches ADR-089's deprecation path.

import { z } from "zod";
import { atomicWrite } from "../abstractions/fs.ts";
import { readJson } from "../abstractions/json.ts";
import { migrateLegacyShape } from "../core/cockpit.ts";
import { ConfigError } from "../errors.ts";
import { Cockpit, type CockpitSessionT } from "../schema/cockpit.ts";
import type { RollbackStep } from "./team-rename.ts";

export interface SyncCockpitRegistryArgs {
  /** Absolute path to the operator's `cockpit.json` — caller resolves
   *  via `core/cockpit.ts::resolveCockpitConfigPath` for the default
   *  `<home>/.atmux/cockpit.json`. */
  cockpitPath: string;
  /** Existing `type: "team"` node name in `sessions[]`. Refuses with
   *  ConfigError when absent (renaming an unregistered team would
   *  leave a ghost entry on the next reload). */
  oldName: string;
  /** New name written into the matched node. */
  newName: string;
  /** New tmux session name — retained for signature symmetry with
   *  ADR-027 §Orchestration step 7's `<new-session>` arg. The current
   *  ADR-089 cockpit schema does NOT store a per-team session-name
   *  (it's derived via `core/cockpit.ts::cageSessionName(teamName)`);
   *  the runtime session-name lives in `<atmuxDir>/state/session.txt`
   *  and is rewritten by T3's `rewriteSessionAnchor`. This field is
   *  captured for log evidence + future schema extension; the on-disk
   *  cockpit.json is mutated only on the team-node `.name`. */
  newSession?: string;
  /** Test seam — defaults to a stderr swallow. Migration shim WARN
   *  messages fire here when the on-disk cockpit is in pre-ADR-089
   *  flat-`teams[]` shape. */
  warn?: (msg: string) => void;
}

/** ADR-027 §Orchestration step 7 — atomic in-place rename of a
 *  `type: "team"` node inside `cockpit.json`'s recursive `sessions[]`
 *  tree (ADR-089 §B).
 *
 *  DFS walks `cockpit.sessions[]`, mirrors `team-rename.ts::collidesWithCockpit`'s
 *  traversal; first match wins. Refuses with ConfigError when
 *  `oldName` is absent — renaming an unregistered team would corrupt
 *  the registry (the post-rename `loadCockpit` would find no node
 *  under the new name and the old name's presence would persist as a
 *  ghost entry until manual cleanup).
 *
 *  Only the FIRST matching node is renamed. Nested child teams
 *  (ADR-089 §Amendment 2026-08-27 §(A)) keep their own `.name` —
 *  renaming a parent mutates only the parent node. An operator
 *  running a rename against a parent with live children should re-run
 *  with the parent paused (`atmux team stop`) and re-sync the children
 *  separately. Out of scope here is any cross-reference sweep
 *  (deferred per ADR-027 §Out of scope).
 *
 *  Legacy back-compat: if the on-disk file is in pre-ADR-089 flat
 *  `teams[]` shape, `migrateLegacyShape` lifts it to the canonical
 *  `sessions[]` form before mutation; the round-trip writes the
 *  canonical form back to disk (legacy top-level `teams[]`,
 *  `superdoctor`, `medic` keys are stripped per the shim).
 *  This is a one-way migration — operators on a fresh rename of a
 *  legacy roster get the canonical shape for free.
 *
 *  Atomic write via `abstractions/fs.ts::atomicWrite` (mktemp + fsync
 *  + rename) so a crash mid-write leaves the on-disk file at the
 *  pre-mutation state.
 *
 *  Returns a `RollbackStep` whose `undo()` swaps `newName` back to
 *  `oldName` via the same code path. Idempotent against the OUTPUT of
 *  this step; if state diverged externally between sync + undo (e.g.
 *  an out-of-band edit renamed the node again), the undo() surfaces a
 *  ConfigError rather than silently no-op'ing — operator inspects. */
export async function syncCockpitRegistry(args: SyncCockpitRegistryArgs): Promise<RollbackStep> {
  const warn = args.warn ?? ((_m: string) => {});
  const cockpit = await readAndMigrateCockpit(args.cockpitPath, warn);
  const found = findAndMutateTeamName(cockpit.sessions ?? [], args.oldName, args.newName);
  if (!found) {
    throw new ConfigError({
      what: `cockpit registry: team '${args.oldName}' not found in sessions[]`,
      hint:
        "rename of an unregistered team would corrupt the registry — " +
        "verify cockpit.json points at the right roster and re-run",
    });
  }
  await atomicWrite(args.cockpitPath, `${JSON.stringify(cockpit, null, 2)}\n`);
  return {
    label: `step 7 — cockpit-sync ${args.oldName} → ${args.newName}`,
    undo: async () => {
      const back = await readAndMigrateCockpit(args.cockpitPath, warn);
      const flipped = findAndMutateTeamName(back.sessions ?? [], args.newName, args.oldName);
      if (!flipped) {
        throw new ConfigError({
          what:
            `cockpit registry rollback: team '${args.newName}' not found in ` +
            "sessions[] — state diverged after sync, manual recovery required",
        });
      }
      await atomicWrite(args.cockpitPath, `${JSON.stringify(back, null, 2)}\n`);
    },
  };
}

/** Read + migrate cockpit.json to the canonical ADR-089 sessions[]
 *  shape, then schema-parse via `Cockpit`. Local helper for
 *  `syncCockpitRegistry` — bypasses `loadCockpit`'s legacy-field
 *  enrichment pass so the round-trip writes back the canonical shape
 *  (no synthesized `teams[]` / `superdoctor` / `medic` mirrors land in
 *  the file). Exported for direct unit-testing. */
export async function readAndMigrateCockpit(
  path: string,
  warn: (msg: string) => void,
): Promise<Cockpit> {
  const raw = await readJson(path, z.unknown());
  const migrated = migrateLegacyShape(raw, path, warn);
  return Cockpit.parse(migrated);
}

/** DFS walk of `nodes` mutating the first `type: "team"` node with
 *  `name === oldName` to `name = newName`. Returns `true` on hit,
 *  `false` if no match exists in the (sub)tree. Recurses into nested
 *  `sessions[]` on every `team` node so ADR-089 children
 *  are reachable, AND through `type: "group"` containers (e-419553c6 —
 *  pre-group, a team registered inside a group was silently unreachable
 *  here, so step 7 of a rename reported success while the registry kept
 *  the old name). A group's own name is never mutated — only `team`
 *  nodes rename. The depth-first short-circuit halts the walk on the
 *  first hit (no need to scan further — the loader rejects duplicate
 *  names at load time, so at most one hit exists). Exported for
 *  direct unit-testing of the walk semantics. */
export function findAndMutateTeamName(
  nodes: CockpitSessionT[],
  oldName: string,
  newName: string,
): boolean {
  for (const n of nodes) {
    if (n.type === "team") {
      if (n.name === oldName) {
        n.name = newName;
        return true;
      }
      if (n.sessions.length > 0 && findAndMutateTeamName(n.sessions, oldName, newName)) {
        return true;
      }
    } else if (n.type === "group") {
      if (n.sessions.length > 0 && findAndMutateTeamName(n.sessions, oldName, newName)) {
        return true;
      }
    }
  }
  return false;
}
