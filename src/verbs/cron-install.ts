// ADR-233 §retired — cron auto-install retired (orchd, the runtime that
// replaced it, was itself retired per ADR-276).
//
// No-op shim per the same pattern as src/abstractions/crontab.ts.
// Importers (team-rename.ts, team-repair-rename.ts) call this as a
// non-fatal "refresh crontab block" step; post-retire the no-op
// preserves the rest of their flow without resurrecting the cron path.

export interface CronInstallOpts {
  quiet?: boolean;
  teamDir?: string;
  template?: string;
}

/** Always returns success — ADR-233 removed the underlying install. */
export async function cronInstall(_opts: CronInstallOpts = {}): Promise<number> {
  return 0;
}
