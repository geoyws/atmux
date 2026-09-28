// ADR-287 §D7 — two advisory nesting / roster probes for `atmux doctor`.
//
//   team-inside-team          — one yellow row per `team` nested DIRECTLY
//                               under a `team` in cockpit.json. Deprecated
//                               per ADR-287 §D3: groups are the branch
//                               nodes, teams are leaf cages; move the
//                               child under a group.
//   deprecated-member-windows — one yellow row per team whose team.json
//                               still declares one or more members[].
//                               The default roster is drivers-only per
//                               ADR-287 §D5; the lead / planner /
//                               reviewer / member windows are deprecated,
//                               not removed. Follow-up (d) of that ADR:
//                               this row is how the operator finds which
//                               teams still declare members.
//
// Both are advisory — yellow only — so neither changes the exit code
// beyond the existing yellow accounting WHILE cockpit.json loads. The one
// red row this module owns is deliberate (ADR-287 §D7): a cockpit.json
// that is PRESENT but refused at load — the §D4 depth refusal, an invalid
// prefixChain, a schema mismatch, malformed JSON — surfaces once as a red
// `cockpit.json` row carrying the loader's message, emitted from
// `checkTeamInsideTeam`'s loader seam. Every other verb that loads the
// cockpit stops on that error; the diagnostic verb must show it rather
// than hide it. An ABSENT cockpit.json stays silent (a cage need not be
// on any cockpit), and the roster probe then reads the current team
// alone.
//
// Each probe splits into a pure row builder (unit-tested on parsed
// objects, no IO) and an async wrapper that obtains real data in
// production through injectable loader seams — the same `loadCockpitFn`
// / `loadTeamForRoot` pattern as `checkLegacyWindowNameFormat` in
// ./cockpit.ts.

import { exists } from "../../abstractions/fs.ts";
import {
  findTeamInsideTeamPairs,
  type LoadedCockpit,
  loadCockpit,
  resolveCockpitConfigPath,
} from "../../core/cockpit.ts";
import { tryLoadTeam } from "../../core/common.ts";
import type { CockpitSessionT } from "../../schema/cockpit.ts";
import type { Team } from "../../schema/team.ts";
import type { DoctorRow } from "./types.ts";

/** Default cockpit reader — `~/.atmux/cockpit.json` (or
 *  `ATMUX_COCKPIT_CONFIG`). `null` ONLY when the file is absent (or its
 *  path cannot be resolved at all — no override and no `$HOME`). A file
 *  that exists but is refused at load (ADR-287 §D4 depth refusal,
 *  invalid prefixChain, schema mismatch, malformed JSON) throws the
 *  loader's own error, so `checkTeamInsideTeam` can render it as the red
 *  `cockpit.json` row instead of hiding the error that stops every other
 *  cockpit-loading verb. */
async function defaultLoadCockpit(): Promise<LoadedCockpit | null> {
  let path: string;
  try {
    path = resolveCockpitConfigPath();
  } catch {
    return null;
  }
  if (!(await exists(path))) return null;
  return await loadCockpit();
}

/** Default per-root team reader — `<root>/.atmux/team.json`. `null` on
 *  absence (tryLoadTeam's ENOENT arm) AND on malformed JSON (its throw
 *  arm) so one broken cockpit entry does not hide the rows for the
 *  others. */
async function defaultLoadTeamForRoot(root: string): Promise<Team | null> {
  try {
    return await tryLoadTeam({ teamDir: root });
  } catch {
    return null;
  }
}

// ---------- team-inside-team (ADR-287 §D3 / §D7) ----------

export interface CheckTeamInsideTeamOpts {
  /** Cockpit reader override (test injection). `null` → no rows (absent
   *  cockpit); a throw → one red `cockpit.json` row carrying the error
   *  message (present but refused at load). */
  loadCockpitFn?: () => Promise<LoadedCockpit | null>;
}

/** Pure row builder: one yellow `team-inside-team` row per deprecated
 *  `team` → `team` edge, naming parent and child (parents in DFS
 *  pre-order, each parent's pairs together). Shares
 *  {@link findTeamInsideTeamPairs} with the `loadCockpit` warning so the
 *  probe and the loader can never disagree on what counts as nested. */
export function teamInsideTeamRows(cockpit: {
  sessions?: ReadonlyArray<CockpitSessionT>;
}): DoctorRow[] {
  return findTeamInsideTeamPairs(cockpit).map((pair) => ({
    status: "yellow",
    label: "team-inside-team",
    detail: `team '${pair.child}' is nested inside team '${pair.parent}' in cockpit.json`,
    hint: "move it under a group — team-inside-team is deprecated per ADR-287 §D3 (groups are branches, teams are leaf cages)",
  }));
}

/** Pure: the red `cockpit.json` row for a cockpit config that is present
 *  but refused at load (ADR-287 §D7). Carries the loader's message
 *  verbatim — the §D4 refusal already names the node, its depth, the
 *  rung it needs and the chain length, plus its own hint; a SchemaError
 *  names the file and the first failing path. */
export function cockpitLoadRefusedRow(err: unknown): DoctorRow {
  const message = err instanceof Error ? err.message : String(err);
  return {
    status: "red",
    label: "cockpit.json",
    detail: `refused at load — ${message}`,
    hint: "every verb that loads the cockpit stops on this until the file loads (ADR-287 §D4 / §D7) — fix cockpit.json; for a depth refusal lengthen prefixChain or reduce nesting depth",
  };
}

/** ADR-287 §D7 probe 1. Silent when the cockpit config is absent or when
 *  no team nests directly under a team. A cockpit config that is present
 *  but refused at load is one red `cockpit.json` row (never swallowed —
 *  this is the one place `atmux doctor` shows the refusal every other
 *  cockpit-loading verb stops on). */
export async function checkTeamInsideTeam(
  opts: CheckTeamInsideTeamOpts = {},
): Promise<DoctorRow[]> {
  let cockpit: LoadedCockpit | null;
  try {
    cockpit = await (opts.loadCockpitFn ?? defaultLoadCockpit)();
  } catch (err) {
    return [cockpitLoadRefusedRow(err)];
  }
  if (cockpit === null) return [];
  return teamInsideTeamRows(cockpit);
}

// ---------- deprecated-member-windows (ADR-287 §D5 / §D7) ----------

export interface CheckDeprecatedMemberWindowsOpts {
  /** Cockpit reader override (test injection). `null` (absent) OR a
   *  throw (present but refused) → current team only; the refusal's red
   *  row belongs to `checkTeamInsideTeam` and is not duplicated here. */
  loadCockpitFn?: () => Promise<LoadedCockpit | null>;
  /** Load `team.json` from a cockpit team's root dir (test injection).
   *  `null` skips that entry. */
  loadTeamForRoot?: (root: string) => Promise<Team | null>;
}

/** Pure row builder: one yellow `deprecated-member-windows` row per team
 *  that declares one or more `members[]`, in the given order, listing
 *  the member names and their count. Drivers-only teams emit nothing. */
export function deprecatedMemberWindowsRows(
  teams: ReadonlyArray<Pick<Team, "name" | "members">>,
): DoctorRow[] {
  const rows: DoctorRow[] = [];
  for (const team of teams) {
    if (team.members.length === 0) continue;
    const names = team.members.map((m) => m.name).join(", ");
    rows.push({
      status: "yellow",
      label: "deprecated-member-windows",
      detail: `team '${team.name}' declares ${team.members.length} member window(s): ${names}`,
      hint: "default roster is drivers-only per ADR-287 §D5; drop members[] when the lead/planner/reviewer loop is not in use",
    });
  }
  return rows;
}

/** ADR-287 §D7 probe 2. Target set is every cockpit team whose
 *  `team.json` loads, plus `currentTeam`, de-duplicated by team name
 *  (cockpit entries first, current team last) — the same fleet walk as
 *  `checkLegacyWindowNameFormat`, so a doctor run inside one cage still
 *  answers "which teams on the fleet still declare members?" (ADR-287
 *  follow-up d). Silent when nothing declares `members[]`. A cockpit
 *  config that is absent OR refused at load degrades to the current
 *  team alone — the refusal is already `checkTeamInsideTeam`'s red row,
 *  so the roster answer is kept and the red row is not duplicated. */
export async function checkDeprecatedMemberWindows(
  currentTeam: Team | null,
  opts: CheckDeprecatedMemberWindowsOpts = {},
): Promise<DoctorRow[]> {
  const loadCockpitFn = opts.loadCockpitFn ?? defaultLoadCockpit;
  const loadTeamForRoot = opts.loadTeamForRoot ?? defaultLoadTeamForRoot;
  const targets: Team[] = [];
  const seenNames = new Set<string>();
  let cockpit: LoadedCockpit | null;
  try {
    cockpit = await loadCockpitFn();
  } catch {
    cockpit = null;
  }
  if (cockpit !== null) {
    for (const ct of cockpit.teams) {
      const t = await loadTeamForRoot(ct.root);
      if (t === null) continue;
      if (seenNames.has(t.name)) continue;
      seenNames.add(t.name);
      targets.push(t);
    }
  }
  if (currentTeam !== null && !seenNames.has(currentTeam.name)) {
    targets.push(currentTeam);
  }
  return deprecatedMemberWindowsRows(targets);
}
