// Test fixture builder for KanbanTask rows consumed by unit tests.
//
// ADR-264: the Epic / Story tiers are cut — Task is the sole work unit.
// `seedTask` calls the real `KanbanTask.parse` so the output is exactly
// what production code reads back from kanban storage; un-mapped fields
// ride through the schema's `.passthrough()` slot, matching the real
// kanban-repo round-trip behaviour.
//
// Conventions:
//   - `seedTask({ id, status, owner, ... })` — defaults yield a fresh
//     `todo` task with no owner; suits cron-sweep + claim-injection
//     scenarios. Override `status: "done"` for done-handler tests.

import type { z } from "zod";
import { KanbanTask } from "../../src/schema/kanban.ts";

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
 * Build a fully-Zod-validated {@link KanbanTask} row. Defaults yield a
 * fresh `todo` task with no owner. Override `status: "done"` +
 * `owner: "<member>"` to feed done-handler scenarios.
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
