// ADR-231 — Test fixture builders for KanbanEpic + KanbanTask rows
// consumed by Phase 2 handler unit tests (S3.1, t-16-27fdc08b).
//
// Pinned by the AC: "KanbanEpic seeding uses the real Zod schema (T-S1.2)
// — no test-only field shapes." The builders call `KanbanEpic.parse` /
// `KanbanTask.parse` so the output is exactly what production code
// reads back from kanban storage; un-mapped fields (incl. ADR-231 §D3
// `extra.autoSpawn` + the not-yet-named-but-passthrough `spawnedAt`)
// ride through the schema's `.passthrough()` slot, matching the real
// kanban-repo round-trip behaviour.
//
// Conventions:
//   - `seedEpic({ id, autoSpawn, spawnedAt, dependsOn, isReady, ... })`
//     — every field overridable; defaults yield a "ready, opted-in for
//     auto-spawn, no deps, never-spawned" epic that the spawn handler
//     should claim on the next event.
//   - `seedTask({ id, status, owner, ... })` — defaults yield a fresh
//     `todo` task with no owner; suits cron-sweep + claim-injection
//     scenarios. Override `status: "done"` for dissolve-handler tests.

import type { z } from "zod";
import { KanbanEpic, KanbanTask } from "../../src/schema/kanban.ts";

/** ADR-231 §D3 per-epic autoSpawn shape. Rides through KanbanEpic's
 *  passthrough `extra` slot until T-S1.2 lands a typed sub-schema. */
export interface AutoSpawnConfig {
  enabled: boolean;
  /** "solo", "backend-heavy", etc. Falls back to per-team default
   *  then "default" literal at handler-resolution time (ADR-231 §D2). */
  roster?: string;
  /** Pass --force to `atmux team spawn-epic` (bypass ADR-225 predicate). */
  forceSpawn?: boolean;
}

/** Builder input for {@link seedEpic} — every field overridable. */
export interface SeedEpicInput {
  /** Defaults to `e-<8 random hex>`. */
  id?: string;
  title?: string;
  status?: string;
  body?: string | null;
  /** ADR-225: deps array. Empty (no deps) by default. */
  dependsOn?: string[];
  /** ADR-225: explicit ready bit. Defaults to `true` so the handler
   *  defaults-eligible — flip to `false` to test gated behaviour. */
  isReady?: boolean;
  /** ADR-231 §D3 — `extra.autoSpawn` sub-shape (rides through extra). */
  autoSpawn?: AutoSpawnConfig;
  /** ADR-231 §D2 — `epics.spawned_at` dedup column. `null` (default)
   *  means "never spawned"; set to a Unix-epoch seconds value to
   *  exercise the dedup gate. */
  spawnedAt?: number | null;
  /** Epoch seconds; defaults to "now". */
  createdAt?: number;
  /** Free-form pass-through for any other passthrough field
   *  (ADR-091 epic-team naming, etc). */
  extra?: Record<string, unknown>;
}

/** Builder input for {@link seedTask} — every field overridable. */
export interface SeedTaskInput {
  /** Defaults to `t-<8 random hex>`. */
  id?: string;
  subject?: string;
  body?: string | null;
  /** Lifecycle status. Defaults to `"todo"`. */
  status?: string;
  /** Member ID owning the task. `null` (default) = unclaimed. */
  owner?: string | null;
  /** Upstream task IDs. Empty by default. */
  deps?: string[];
  priority?: number | null;
  /** Parent epic ID. */
  epic?: string | null;
  /** Parent story ID. */
  story?: string | null;
  lane?: string | null;
  createdAt?: number;
  claimedAt?: number | null;
  completedAt?: number | null;
  note?: string | null;
}

function randomHex(n: number): string {
  let out = "";
  while (out.length < n) {
    out += Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, "0");
  }
  return out.slice(0, n);
}

/**
 * Build a fully-Zod-validated {@link KanbanEpic} row. Defaults yield a
 * "ready, no deps, never-spawned" epic — caller flips `autoSpawn` to
 * exercise the §D3 opt-in gate, `spawnedAt` to exercise the §D2 dedup
 * gate, `isReady`/`dependsOn` to exercise ADR-225's eligibility.
 *
 * @example
 *   const epic = seedEpic({
 *     autoSpawn: { enabled: true, roster: "solo" },
 *     dependsOn: ["e-deadbeef"],
 *     isReady: false,
 *   });
 */
export function seedEpic(input: SeedEpicInput = {}): z.infer<typeof KanbanEpic> {
  const id = input.id ?? `e-${randomHex(8)}`;
  const now = Math.floor(Date.now() / 1000);

  const base: Record<string, unknown> = {
    id,
    title: input.title ?? `test epic ${id}`,
    body: input.body ?? null,
    status: input.status ?? "ready",
    isReady: input.isReady ?? true,
    dependsOn: input.dependsOn ?? [],
    createdAt: input.createdAt ?? now,
    completedAt: null,
    stories: [],
    epicTeamName: null,
    epicTeamRoot: null,
    prNumber: null,
    prState: null,
    note: null,
    driverRef: null,
  };

  // ADR-231 §D3 — autoSpawn lives under `extra.autoSpawn`. ADR-231 §D2
  // dedup column `spawned_at` lives at the top level (renames to
  // `spawnedAt` in the camelCase JSON shape).
  if (input.autoSpawn !== undefined || input.extra !== undefined) {
    base.extra = {
      ...(input.extra ?? {}),
      ...(input.autoSpawn !== undefined ? { autoSpawn: input.autoSpawn } : {}),
    };
  }
  if (input.spawnedAt !== undefined) {
    base.spawnedAt = input.spawnedAt;
  }

  return KanbanEpic.parse(base);
}

/**
 * Build a fully-Zod-validated {@link KanbanTask} row. Defaults yield a
 * fresh `todo` task with no owner. Override `status: "done"` +
 * `owner: "<member>"` to feed dissolve-handler scenarios.
 *
 * @example
 *   const task = seedTask({
 *     status: "done",
 *     owner: "worker-0",
 *     completedAt: 1779540000,
 *   });
 */
export function seedTask(input: SeedTaskInput = {}): z.infer<typeof KanbanTask> {
  const id = input.id ?? `t-${randomHex(8)}`;
  const now = Math.floor(Date.now() / 1000);

  return KanbanTask.parse({
    id,
    subject: input.subject ?? `test task ${id}`,
    body: input.body ?? null,
    status: input.status ?? "todo",
    owner: input.owner ?? null,
    deps: input.deps ?? [],
    priority: input.priority ?? null,
    epic: input.epic ?? null,
    story: input.story ?? null,
    lane: input.lane ?? null,
    deliverable: null,
    staleMin: null,
    createdAt: input.createdAt ?? now,
    claimedAt: input.claimedAt ?? null,
    completedAt: input.completedAt ?? null,
    claimedFrom: null,
    createdFrom: null,
    note: input.note ?? null,
  });
}
