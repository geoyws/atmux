// ADR-239 — driver roster helpers.
//
// Pure utilities for resolving and classifying drivers per ADR-239 §A1.
// Driver panes now follow the shared two-stage lifecycle: create an
// interactive shell, verify it is idle, then launch the TUI by sending
// the command to that immutable pane target.

import { join } from "node:path";
import { z } from "zod";

/** A single driver pane entry. Mirrors the {@link Team.drivers} Zod
 *  shape in `src/schema/team.ts`. Kept as a structural type (not an
 *  import) so this module stays consumable from schema-free callers. */
export interface DriverSession {
  /** Pane name. driver-1 = `"driver"`; driver-N = `"driver-N"` (N>=2). */
  name: string;
  /** Optional TUI command alias (`"claude"`, `"cursor"`, etc.).
   *  Null / absent leaves the driver in the normal interactive shell. */
  tui?: string | null | undefined;
  /** Working directory for the pane. driver = `"."` (team root, trunk);
   *  driver-N = `.atmux/worktrees/driver-N` (per-driver worktree). */
  cwd: string;
  /** Optional per-driver Claude account override (per ADR-024). */
  claudeAccount?: string;
}

export const DriverSessionSchema = z
  .object({
    name: z.string().min(1),
    tui: z.string().min(1).nullable().optional(),
    cwd: z.string().min(1),
    claudeAccount: z.string().optional(),
  })
  .passthrough();
export type DriverSessionSchema = z.infer<typeof DriverSessionSchema>;

export const MIN_PARENT_TEAM_DRIVERS = 1;
export const MAX_PARENT_TEAM_DRIVERS = 10;

export const DriverPairWorkerPaneSchema = z
  .object({
    role: z.literal("worker"),
    side: z.literal("left"),
  })
  .strict();
export type DriverPairWorkerPane = z.infer<typeof DriverPairWorkerPaneSchema>;

export const DriverPairAttentionPaneSchema = z
  .object({
    role: z.literal("attention"),
    side: z.literal("right"),
    workflow: z.literal("kb-att"),
    authority: z.literal("decision-only"),
    tui: z.string().min(1).nullable().default(null),
    command: z.string().min(1).nullable().default(null),
  })
  .strict();
export type DriverPairAttentionPane = z.infer<typeof DriverPairAttentionPaneSchema>;

export const DriverPairPresetSchema = z
  .object({
    layout: z.literal("horizontal"),
    panes: z.tuple([DriverPairWorkerPaneSchema, DriverPairAttentionPaneSchema]),
    /** ROLLOUT GATE (ADR-288 amendment 2026-09-29): pair
     *  materialization in start/reconcile runs ONLY when true.
     *  Optional so existing team literals stay compatible; absent
     *  means false (see `isDriverPairMaterialized`). Row t-d1f18085
     *  owns flipping the default. */
    materialize: z.boolean().optional(),
  })
  .strict();
export type DriverPairPreset = z.infer<typeof DriverPairPresetSchema>;

export const CANONICAL_PARENT_TEAM_DRIVERS = Object.freeze([
  { name: "driver", tui: null, cwd: "." },
  { name: "driver-2", tui: null, cwd: ".atmux/worktrees/driver-2" },
  { name: "driver-3", tui: null, cwd: ".atmux/worktrees/driver-3" },
] satisfies DriverSession[]);

export const CANONICAL_DRIVER_PAIR_PRESET = Object.freeze({
  layout: "horizontal",
  panes: [
    { role: "worker", side: "left" },
    {
      role: "attention",
      side: "right",
      workflow: "kb-att",
      authority: "decision-only",
      tui: null,
      command: null,
    },
  ],
  materialize: false,
} satisfies DriverPairPreset);

/** Input shape for {@link resolveDriverPair}. */
export interface DriverPairTeamLike {
  driverPair?: DriverPairPreset | null | undefined;
}

/**
 * Resolve the canonical worker/attention pair for a team.
 *
 * Stored configs keep `driverPair` optional so existing `Team` literals
 * stay compatible. When the field is absent, callers materialize a fresh
 * copy of the canonical preset (which carries `materialize: false`).
 */
export function resolveDriverPair(team: DriverPairTeamLike): DriverPairPreset {
  if (team.driverPair !== undefined && team.driverPair !== null) {
    return team.driverPair;
  }
  const canonical = CANONICAL_DRIVER_PAIR_PRESET;
  return {
    layout: canonical.layout,
    panes: [{ ...canonical.panes[0] }, { ...canonical.panes[1] }],
    materialize: canonical.materialize,
  };
}

/** ROLLOUT GATE (ADR-288 amendment 2026-09-29): true only when the team
 *  explicitly opts into pair materialization. Absent/null driverPair
 *  means today's single-pane behaviour. */
export function isDriverPairMaterialized(team: DriverPairTeamLike): boolean {
  return resolveDriverPair(team).materialize === true;
}

/** Input shape for {@link resolveDriversList}. */
interface DriverRosterTeam {
  drivers?: ReadonlyArray<DriverSession>;
}

/**
 * Resolve the effective driver list for a team per ADR-239 §A1.
 *
 *   1. `team.drivers[]` if present + non-empty → return as-is.
 *   2. Otherwise → the canonical three-driver parent-team roster.
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
  return CANONICAL_PARENT_TEAM_DRIVERS.map((driver) => ({ ...driver }));
}

export function isSupportedDriverCount(count: number): boolean {
  return (
    Number.isInteger(count) && count >= MIN_PARENT_TEAM_DRIVERS && count <= MAX_PARENT_TEAM_DRIVERS
  );
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
