// ADR-027 T6: post-rename convergence check (step 10).
//
// Reads the post-rename state across team.json, session.txt, tmux,
// cockpit.json, the rename lock, and the host crontab; reports gaps
// as a structured `ConvergenceResult.gaps[]` array. The dispatcher
// calls `verifyConvergence` at the tail of `teamRename` and surfaces
// gaps as a 1-paragraph stderr block; standalone `atmux doctor`
// integration (separate Task) will fold the same checks into its
// per-team probe path.
//
// Topology note: the rename verb operates against the post-ADR-135 /
// post-ADR-162 layout. team-viewer windows live on the cockpit socket
// (`tmux -L atmux-cockpit`), NOT the cage socket; the cage hosts
// per-member windows (`🐝-<member>` emoji-prefix, no team-name token
// in the window-name). The convergence check reflects that split:
// the cage probe asserts the session name; the cockpit probe asserts
// the team-viewer window name.

import { join } from "node:path";
import { exists, readTextOrNull } from "../abstractions/fs.ts";
import type { TmuxNamespace } from "../abstractions/tmux.ts";
import { defaultCockpitConfigPath } from "../core/cockpit.ts";
import { getSessionName, loadTeam, sessionAnchorPath, stateDir } from "../core/common.ts";
import { findAndMutateTeamName, readAndMigrateCockpit } from "./team-rename-cockpit.ts";
import { renameLockPath } from "./team-rename-fs.ts";

export interface ConvergenceGap {
  /** Which check failed — stable label for grep + cross-ref. */
  check:
    | "team-json-name"
    | "session-anchor"
    | "cage-session-alive"
    | "cockpit-registry"
    | "cockpit-team-viewer-window"
    | "leftover-rename-lock"
    | "leftover-cron-block";
  /** Human-readable detail (expected vs actual). */
  detail: string;
}

export interface ConvergenceResult {
  converged: boolean;
  gaps: ReadonlyArray<ConvergenceGap>;
}

export interface VerifyConvergenceInput {
  atmuxDir: string;
  newName: string;
  newSession: string;
  /** Cockpit tmux namespace (caller passes
   *  `createTmux({ socket: "atmux-cockpit" })`). */
  cockpitTmux: TmuxNamespace;
  /** Cage tmux namespace pinned to the team's socket. */
  cageTmux: TmuxNamespace;
  /** Cockpit session name (default `"atmux_cockpit"` per ADR-135). */
  cockpitSession: string;
  /** Cockpit.json path; defaults to `<home>/.atmux/cockpit.json`. */
  cockpitPath?: string;
  /** Home dir override (test injection). */
  home?: string;
  /** Original (pre-rename) team name — needed for cron leftover check
   *  + cockpit-registry "should not see old name" assertion. */
  oldName: string;
  /** CrontabIO seam for the leftover-block probe. Defaults to
   *  `defaultCrontabIO()`. */
  crontabRead?: () => Promise<string | null>;
}

/** Walk every convergence check; aggregate gaps. The function never
 *  throws — every failure is captured as a gap. Callers branch on
 *  `result.converged` (===empty gaps) to decide exit code / hint. */
export async function verifyConvergence(input: VerifyConvergenceInput): Promise<ConvergenceResult> {
  const gaps: ConvergenceGap[] = [];

  // 1. team.json:.name === newName.
  try {
    const team = await loadTeam({ teamDir: parentDirOf(input.atmuxDir) });
    if (team.name !== input.newName) {
      gaps.push({
        check: "team-json-name",
        detail: `team.json:.name='${team.name}', expected '${input.newName}'`,
      });
    }
  } catch (err) {
    gaps.push({
      check: "team-json-name",
      detail: `team.json read failed: ${errMsg(err)}`,
    });
  }

  // 2. state/session.txt === newSession (when file present).
  const sessAnchor = sessionAnchorPath(input.atmuxDir);
  if (await exists(sessAnchor)) {
    const captured = await getSessionName({ teamDir: parentDirOf(input.atmuxDir) }).catch(
      () => null,
    );
    if (captured !== input.newSession) {
      gaps.push({
        check: "session-anchor",
        detail: `session.txt anchor='${captured ?? "<null>"}', expected '${input.newSession}'`,
      });
    }
  }

  // 3. Cage tmux session list contains newSession.
  try {
    const sessions = await input.cageTmux.session.listSessions();
    if (!sessions.some((s) => s.name === input.newSession)) {
      gaps.push({
        check: "cage-session-alive",
        detail: `tmux list-sessions on cage socket has no '${input.newSession}'; found: ${
          sessions.map((s) => s.name).join(", ") || "<empty>"
        }`,
      });
    }
  } catch (err) {
    gaps.push({
      check: "cage-session-alive",
      detail: `tmux list-sessions failed on cage socket: ${errMsg(err)}`,
    });
  }

  // 4. Cockpit registry: sessions[] DFS finds team-typed node with
  //    .name === newName, AND no node with .name === oldName remains.
  const cockpitPath =
    input.cockpitPath ?? defaultCockpitConfigPath(input.home ?? process.env.HOME ?? "/root");
  try {
    const cockpit = await readAndMigrateCockpit(cockpitPath, () => {});
    // Probe for newName: clone-walk-and-flip; if findAndMutateTeamName
    // can hit newName, it exists. We don't actually mutate the source;
    // the helper writes to its input by reference, so pass a deep
    // clone via JSON round-trip to keep this read-only.
    const cloneForNew = JSON.parse(JSON.stringify(cockpit.sessions ?? [])) as Parameters<
      typeof findAndMutateTeamName
    >[0];
    if (!findAndMutateTeamName(cloneForNew, input.newName, "__convergence_probe__")) {
      gaps.push({
        check: "cockpit-registry",
        detail: `cockpit.json sessions[] has no type:"team" node with name='${input.newName}'`,
      });
    }
    // Probe for oldName lingering: if findable, that's a gap.
    const cloneForOld = JSON.parse(JSON.stringify(cockpit.sessions ?? [])) as Parameters<
      typeof findAndMutateTeamName
    >[0];
    if (findAndMutateTeamName(cloneForOld, input.oldName, "__convergence_probe__")) {
      gaps.push({
        check: "cockpit-registry",
        detail: `cockpit.json sessions[] still contains type:"team" node with old name='${input.oldName}'`,
      });
    }
  } catch (err) {
    gaps.push({
      check: "cockpit-registry",
      detail: `cockpit.json read/parse failed: ${errMsg(err)}`,
    });
  }

  // 5. Cockpit team-viewer window named `newName` exists (post-ADR-135).
  try {
    const windows = await input.cockpitTmux.window.listWindows(input.cockpitSession);
    if (!windows.some((w) => w.name === input.newName)) {
      gaps.push({
        check: "cockpit-team-viewer-window",
        detail: `cockpit '${input.cockpitSession}' has no window named '${input.newName}'; found: ${
          windows.map((w) => w.name).join(", ") || "<empty>"
        }`,
      });
    }
    if (windows.some((w) => w.name === input.oldName)) {
      gaps.push({
        check: "cockpit-team-viewer-window",
        detail: `cockpit '${input.cockpitSession}' still has window named '${input.oldName}' (stale team-viewer)`,
      });
    }
  } catch (err) {
    // Cockpit unreachable is orphan-tolerant — same posture as step 4
    // in the dispatcher. Surface as a soft gap rather than a hard fail
    // so operators see it in `atmux doctor` but the immediate post-
    // rename success path isn't blocked when cockpit is down.
    gaps.push({
      check: "cockpit-team-viewer-window",
      detail: `cockpit list-windows failed (cockpit unreachable?): ${errMsg(err)}`,
    });
  }

  // 6. No leftover rename.lock.
  const lockPath = renameLockPath(input.atmuxDir);
  if (await exists(lockPath)) {
    const body = await readTextOrNull(lockPath);
    gaps.push({
      check: "leftover-rename-lock",
      detail: `rename.lock still present at ${lockPath} (body=${body ?? "<unreadable>"})`,
    });
  }

  // 7. No leftover cron block referencing oldName. The block marker is
  //    `# >>> atmux:team=<name>`. Read the crontab and grep.
  try {
    const reader =
      input.crontabRead ??
      (async () => {
        const { defaultCrontabIO } = await import("../abstractions/crontab.ts");
        return defaultCrontabIO().read();
      });
    const body = (await reader()) ?? "";
    const stalemarker = `# >>> atmux:team=${input.oldName}`;
    if (body.includes(stalemarker)) {
      gaps.push({
        check: "leftover-cron-block",
        detail: `crontab still has '${stalemarker}' marker (post-rename strip didn't fire)`,
      });
    }
  } catch (err) {
    // Non-fatal — same posture as the rest of the cron path.
    gaps.push({
      check: "leftover-cron-block",
      detail: `crontab read failed: ${errMsg(err)}`,
    });
  }

  return { converged: gaps.length === 0, gaps };
}

// Local utility — `getAtmuxDir` lives one dir up from `<root>/.atmux/`.
// Convergence callers pass in the full atmuxDir; we re-derive the
// project root to satisfy `loadTeam`'s `{ teamDir }` arg shape.
function parentDirOf(atmuxDir: string): string {
  // Trim trailing `/.atmux` (with or without trailing slash).
  const norm = atmuxDir.endsWith("/") ? atmuxDir.slice(0, -1) : atmuxDir;
  if (norm.endsWith("/.atmux")) return norm.slice(0, -"/.atmux".length);
  // Fallback: assume the caller's atmuxDir IS the project root
  // (legacy single-session shape, ADR-016).
  return norm;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Helper exported for the dispatcher's exit-70 hint. Format matches
 *  team-repair-rename's "drifted" surface so operators see one mental
 *  model for rename + repair drift. */
export function formatConvergenceHint(result: ConvergenceResult, newName: string): string {
  if (result.converged) return "";
  const lines = ["team rename: post-rename convergence check found gaps:"];
  for (const g of result.gaps) {
    lines.push(`  - [${g.check}] ${g.detail}`);
  }
  lines.push(`  hint: run \`atmux team repair-rename ${newName}\` to converge`);
  return `${lines.join("\n")}\n`;
}

// Suppress unused-import lint for stateDir + join — kept for future
// gap checks that probe additional state-dir artifacts (planner
// roadmap item, deferred to a separate Task per ADR-027 §Out of scope).
void stateDir;
void join;
