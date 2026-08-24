// ADR-239 — driver roster helpers.
//
// Pure utilities for resolving + classifying drivers per ADR-239 §A1-§A5.
// Used by `src/verbs/start.ts` (spawn loop), `src/abstractions/tmux.ts`
// (send-keys guard), and `src/core/driver-pane-health.ts` (pane probes).
//
// Per ADR-239 §A3: drivers receive NO pre-prompts, NO briefs, NO role
// anchors. The spawn-time launch flows through `tmux new-session` /
// `new-window` `shellCommand` arguments (command-mode); never through
// `pane.sendKeys`. Runtime `pane.sendKeys` is type-banned (ADR-025) +
// runtime-guarded here (ADR-239 §D2 + §A5).

import { join } from "node:path";

/** A single driver pane entry. Mirrors the {@link Team.drivers} Zod
 *  shape in `src/schema/team.ts`. Kept as a structural type (not an
 *  import) so this module stays consumable from schema-free callers. */
export interface DriverSession {
  /** Pane name. driver-1 = `"driver"`; driver-N = `"driver-N"` (N>=2). */
  name: string;
  /** Optional TUI command alias (`"claude"`, `"cursor"`, etc.).
   *  Null / absent leaves the driver in the normal interactive shell. */
  tui?: string | null;
  /** Working directory for the pane. driver = `"."` (team root, trunk);
   *  driver-N = `.atmux/worktrees/driver-N` (per-driver worktree). */
  cwd: string;
  /** Optional per-driver Claude account override (per ADR-024). */
  claudeAccount?: string;
}

/** Input shape for {@link resolveDriversList}. */
interface DriverRosterTeam {
  drivers?: DriverSession[];
}

/**
 * Resolve the effective driver list for a team per ADR-239 §A1.
 *
 *   1. `team.drivers[]` if present + non-empty → return as-is.
 *   2. Otherwise → empty array (caller falls back to the
 *      `__home` placeholder window per existing start.ts behavior).
 *
 * ADR-266 §D2: the ADR-239 §D7 legacy `driverSession` / `driverTui`
 * single-driver synthesis was removed (deprecation window expired) —
 * operator configs still on the legacy fields must migrate to
 * `drivers[]`.
 *
 * Pure. No I/O.
 */
export function resolveDriversList(team: DriverRosterTeam): DriverSession[] {
  if (Array.isArray(team.drivers) && team.drivers.length > 0) {
    return team.drivers;
  }
  return [];
}

/**
 * Resolve the absolute on-disk cwd for a driver entry.
 *
 * Relative `cwd` values are anchored at `projectRoot`; absolute paths
 * pass through verbatim. `"."` resolves to `projectRoot`.
 *
 * Pure. No I/O — caller is responsible for ensuring the path exists
 * (worktree provisioning happens separately via `provisionWorktree`).
 */
export function resolveDriverCwd(driver: DriverSession, projectRoot: string): string {
  const cwd = driver.cwd;
  if (cwd === "." || cwd === "") return projectRoot;
  if (cwd.startsWith("/")) return cwd;
  return join(projectRoot, cwd);
}

/**
 * Test whether a pane name belongs to a driver pane per ADR-239 §D2.
 *
 * Matches `driver` (the original singular driver) and `driver-N` for
 * any positive integer N. Used by the `pane.sendKeys` runtime guard
 * (`src/abstractions/tmux.ts`) to refuse any send-keys whose target
 * resolves to a driver pane.
 *
 * Pure. No I/O. Exported for direct unit-testing.
 */
const DRIVER_PANE_NAME_RE = /^driver(?:-[1-9][0-9]*)?$/;
export function isDriverPaneName(name: string): boolean {
  return DRIVER_PANE_NAME_RE.test(name);
}

/**
 * Per ADR-239 §A1 + §A2: the canonical driver-N naming pattern. Spawn
 * loop uses this when deriving branch names (`<base>-driver-N`) and
 * worktree paths (`.atmux/worktrees/driver-N`). For the original
 * driver (driver-1) the function returns `"driver"` — singular.
 *
 * Pure.
 */
export function canonicalDriverName(index: number): string {
  if (!Number.isInteger(index) || index < 1) {
    throw new RangeError(`canonicalDriverName: index must be a positive integer (got ${index})`);
  }
  return index === 1 ? "driver" : `driver-${index}`;
}

/** True when this driver entry is the trunk driver (driver-1, on team
 *  root + base branch — no worktree provisioning needed). */
export function isTrunkDriver(driver: DriverSession): boolean {
  return driver.name === "driver";
}
