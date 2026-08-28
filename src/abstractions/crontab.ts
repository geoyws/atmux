// ADR-233 §retired — cron auto-install retired (orchd, the runtime that
// replaced it, was itself retired per ADR-276).
//
// This file is a transitional no-op shim that keeps un-cleaned-up
// importers (src/verbs/{doctor,stop,cockpit,team-rename,...}.ts) compiling
// until ADR-233 §cleanup-EPIC removes them. Every function here is a
// safe-zero return so callers behave as if no crontab existed (which
// is the post-ADR-233 default state on hosts that haven't had `atmux
// cron-install` run since the retire).

/** Crontab IO surface — kept so importers' type annotations resolve. */
export interface CrontabIO {
  /** `true` when `crontab` is on PATH; legacy probe. Always `false`
   *  post-ADR-233 — cron-install never armed, no body to read. */
  available(): Promise<boolean>;
  /** Read current user crontab body. Always `null` post-ADR-233. */
  read(): Promise<string | null>;
  /** Write body to user crontab. No-op post-ADR-233. */
  write(body: string): Promise<void>;
}

/** Default IO — no-op singleton. Importers that previously got a real
 *  IO now get a stub that reports unavailable + reads as empty. */
export function defaultCrontabIO(): CrontabIO {
  return {
    async available() {
      return false;
    },
    async read() {
      return null;
    },
    async write(_body) {
      return;
    },
  };
}
