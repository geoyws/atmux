// ADR-233 §retired — cron auto-install retired (orchd, the runtime that
// replaced it, was itself retired per ADR-276).
//
// No-op shim. The `stop` verb still calls this for legacy block
// stripping; post-ADR-233 there's no block to strip.

export interface CronRemoveOpts {
  teamDir?: string;
  quiet?: boolean;
  team?: string;
}

/** Always returns success post-ADR-233. */
export async function cronRemove(_opts: CronRemoveOpts = {}): Promise<number> {
  return 0;
}
