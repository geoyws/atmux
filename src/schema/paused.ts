// ADR-005 + ADR-003: Zod schema for `<atmuxDir>/state/paused.json`.
//
// Mirrors bash `lib/pause.sh`'s on-disk shape: a flat map of member name
// → `{ at: epoch_seconds, reason: string }`. Bash atmux writes via
// `atmux::jq_update '.[$m] = {at: $now, reason: $reason}' --argjson now
// "$(date +%s)"` and clears via `del(.[$m])`.
//
// Parity contract (PLAN.md §4.1, ADR-013). The TS port runs side-by-side
// with bash atmux during the burn-in window; both binaries read + write
// the SAME `paused.json`. So the schema deliberately deviates from the
// `src/schema/README.md` "every schema includes `schemaVersion`" guidance:
// bash never wrote a schemaVersion, adding one in TS would make the file
// unreadable to bash. Future migrations are a Phase 6 / ADR-014 concern
// after the bash binary is decommissioned.
//
// `at` is epoch SECONDS — matches bash `date +%s`, not ms. Conversion
// from JS `Date.now()` (ms) happens at the call site in `core/pause.ts`.

import { z } from "zod";

/** A single paused-member entry. Bash shape: `{at: <epoch_sec>, reason: <string>}`. */
export const PauseEntrySchema = z
  .object({
    /** Epoch seconds at the time of pause. Bash `date +%s` → integer. */
    at: z.number().int().nonnegative(),
    /** Free-form reason string. Bash default is `"manual"`. */
    reason: z.string(),
  })
  .strict();

export type PauseEntry = z.infer<typeof PauseEntrySchema>;

/**
 * `.atmux/state/paused.json` shape — flat map keyed by member name.
 * Empty object `{}` is the first-run / all-resumed state; bash creates
 * the file with `echo '{}' > "$state_file"` if absent.
 */
export const PausedMapSchema = z.record(z.string(), PauseEntrySchema);

export type PausedMap = z.infer<typeof PausedMapSchema>;
