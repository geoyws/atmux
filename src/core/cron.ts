// ADR-233 §retired — cron auto-install retired (orchd, the runtime that
// replaced it, was itself retired per ADR-276).
//
// No-op shim per the same pattern as src/abstractions/crontab.ts.
// Removed in ADR-233 §cleanup-EPIC once the importers are migrated
// to either drop the call entirely or replace with event-driven wakes.

import type { CrontabIO } from "../abstractions/crontab.ts";

/** Legacy block-target shape — kept so doctor.ts type annotations resolve. */
export interface CronBlockTarget {
  team: string;
  atmuxDir: string;
}

export interface CronOrphan {
  team: string;
  atmuxDir: string;
}

export interface FindCronOrphansDeps {
  io: CrontabIO;
  dirExists: (path: string) => Promise<boolean>;
}

/** Always returns empty post-ADR-233 — no managed blocks exist when
 *  the cron-install path is gone. */
export async function findCronOrphans(_deps: FindCronOrphansDeps): Promise<CronOrphan[]> {
  return [];
}

/** Strip atmux-marker block from a crontab body. No-op post-ADR-233
 *  (no managed blocks expected) — returns body unchanged. */
export function stripAtmuxBlock(body: string, _team?: string): string {
  return body;
}

/** Install a cockpit cron block — no-op post-ADR-233. */
export async function installCockpitCronBlock(_opts: {
  io: CrontabIO;
  marker?: string;
  body?: string;
}): Promise<void> {
  return;
}
