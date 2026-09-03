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
import { z } from "zod";

export const DriverSessionSchema = z
  .object({
    name: z.string().min(1),
    tui: z.string().min(1).nullable().optional(),
    cwd: z.string().min(1),
    claudeAccount: z.string().optional(),
  })
  .passthrough();
/** A single driver pane entry. Mirrors the {@link Team.drivers} Zod
 *  shape in `src/schema/team.ts`. Kept schema-inferred so callers get a
 *  single source of truth for the stored contract. */
export type DriverSession = z.infer<typeof DriverSessionSchema>;

/** Parent-team driver roster bounds for the declarative contract. */
export const MIN_PARENT_TEAM_DRIVERS = 3;
export const MAX_PARENT_TEAM_DRIVERS = 10;

/** Canonical worker/attention pair metadata for later tmux materializers. */
export type DriverPairPaneRole = "worker" | "attention";
export type DriverPairPaneSide = "left" | "right";
export type DriverPairPaneWorkflow = "kb-att";
export type DriverPairPaneAuthority = "decision-only";

export const DriverPairWorkerPaneSchema = z
  .object({
    role: z.literal("worker"),
    side: z.literal("left"),
  })
  .strict();
export type DriverPairWorkerPaneSpec = z.infer<typeof DriverPairWorkerPaneSchema>;

export const DriverPairAttentionPaneSchema = z
  .object({
    role: z.literal("attention"),
    side: z.literal("right"),
    workflow: z.literal("kb-att"),
    authority: z.literal("decision-only"),
    command: z.string().min(1).nullable().default(null),
  })
  .strict();
export type DriverPairAttentionPaneSpec = z.infer<typeof DriverPairAttentionPaneSchema>;

export type DriverPairPaneSpec = DriverPairWorkerPaneSpec | DriverPairAttentionPaneSpec;

type DriverPairPresetShape = {
  layout: "horizontal";
  panes: [DriverPairWorkerPaneSpec, DriverPairAttentionPaneSpec];
};

const CANONICAL_ATTENTION_PANE: DriverPairAttentionPaneSpec = Object.freeze({
  role: "attention",
  side: "right",
  workflow: "kb-att",
  authority: "decision-only",
  command: null,
});

const CANONICAL_WORKER_PANE: DriverPairWorkerPaneSpec = Object.freeze({
  role: "worker",
  side: "left",
});

const CANONICAL_DRIVER_PAIR_PANES = Object.freeze([
  CANONICAL_WORKER_PANE,
  CANONICAL_ATTENTION_PANE,
] as [DriverPairWorkerPaneSpec, DriverPairAttentionPaneSpec]);

export const CANONICAL_DRIVER_PAIR_PRESET = Object.freeze({
  layout: "horizontal",
  panes: CANONICAL_DRIVER_PAIR_PANES,
}) as DriverPairPresetShape;

export const DriverPairPresetSchema = z
  .object({
    layout: z.literal("horizontal"),
    panes: z.tuple([DriverPairWorkerPaneSchema, DriverPairAttentionPaneSchema]),
  })
  .strict();
export type DriverPairPreset = z.infer<typeof DriverPairPresetSchema>;

interface DriverPairTeamLike {
  driverPair?: DriverPairPreset | null | undefined;
}

function cloneDriverPairPreset(preset: DriverPairPreset): DriverPairPreset {
  return {
    layout: preset.layout,
    panes: [{ ...preset.panes[0] }, { ...preset.panes[1] }],
  };
}

export const CANONICAL_PARENT_TEAM_DRIVERS: readonly DriverSession[] = Object.freeze([
  Object.freeze({ name: "driver", tui: null, cwd: "." }),
  Object.freeze({ name: "driver-2", tui: null, cwd: ".atmux/worktrees/driver-2" }),
  Object.freeze({ name: "driver-3", tui: null, cwd: ".atmux/worktrees/driver-3" }),
]);

/** Input shape for {@link resolveDriversList}. */
interface DriverRosterTeam {
  drivers?: DriverSession[];
}

/**
 * Resolve the effective driver list for a team per ADR-239 §A1.
 *
 *   1. `team.drivers[]` if present + non-empty → return as-is.
 *   2. Otherwise → the canonical three-driver default roster.
 *
 * The helper encodes the live three-driver floor while preserving
 * explicit rosters up to the cap. Later runtime slices can consume it
 * directly without re-encoding the roster shape.
 *
 * Pure. No I/O.
 */
export function resolveDriversList(team: DriverRosterTeam): DriverSession[] {
  if (Array.isArray(team.drivers) && team.drivers.length > 0) {
    return team.drivers;
  }
  return CANONICAL_PARENT_TEAM_DRIVERS.map((driver) => ({ ...driver }));
}

/**
 * Resolve the canonical worker/attention pair for a team.
 *
 * Stored configs keep `driverPair` optional so existing `Team` literals
 * stay compatible. When the field is absent, callers use this helper to
 * materialize a fresh copy of the canonical preset.
 */
export function resolveDriverPair(team: DriverPairTeamLike): DriverPairPreset {
  if (team.driverPair !== undefined && team.driverPair !== null) {
    return team.driverPair;
  }
  return cloneDriverPairPreset(CANONICAL_DRIVER_PAIR_PRESET);
}

/** Test whether an explicit driver roster length is within the parent-team cap. */
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
