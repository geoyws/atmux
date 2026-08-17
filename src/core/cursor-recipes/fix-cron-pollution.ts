// ADR-233 §retired — cron auto-install retired; orchd is the runtime.
//
// No-op shim recipe. The cron-pollution self-heal was built for the
// pre-ADR-233 era where atmux managed crontab blocks; post-retire
// `detect` never matches so the rest of the recipe surface is unused.

import type { CursorRecipe } from "./types.ts";

export const fixCronPollutionRecipe: CursorRecipe = {
  id: "fix-cron-pollution",
  tokenCap: 0,
  fileAllowlist: [],
  async detect() {
    return null;
  },
  async propose() {
    throw new Error("ADR-233: fix-cron-pollution recipe retired");
  },
  async verify() {
    return {
      ok: false,
      reasons: ["ADR-233: fix-cron-pollution recipe retired"],
      patchSummary: "",
    };
  },
};
