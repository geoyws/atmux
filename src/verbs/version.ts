// ADR-010: CLI dispatcher — `version` verb.
//
// The version string is read from `package.json::version` at runtime
// via Bun's JSON import. This kills the drift class that prior manual
// lockstep failed to prevent (caught 2026-05-12: hardcoded "0.6.0"
// while package.json had moved to 0.7.2). The TS-side single source
// of truth is package.json — no separate constant to bump.

import pkg from "../../package.json" with { type: "json" };
import { SOCKET_DIR_FEATURE } from "../core/socket-dir.ts";

/**
 * The atmux version string — sourced from `package.json::version` at
 * runtime so bumps land in one place.
 */
export const ATMUX_VERSION: string = pkg.version;

/**
 * Capability markers `atmux version --features` prints, one per line,
 * after the version line (ADR-305 §D5). Each is a stable token a
 * bootstrap can `grep -qx`; an older build prints only the version line,
 * so the grep fails closed.
 */
export const ATMUX_FEATURES: ReadonlyArray<string> = Object.freeze([SOCKET_DIR_FEATURE]);

/**
 * `atmux version [--features]` — print the version string, exit 0. No
 * state touched, no Discord call, no .atmux/ access. With `--features`,
 * also print each {@link ATMUX_FEATURES} marker on its own line. Other
 * args are accepted but ignored (matches bash, which doesn't validate
 * args on this verb).
 */
export async function version(args: ReadonlyArray<string>): Promise<number> {
  console.log(`atmux ${ATMUX_VERSION}`);
  if (args.includes("--features")) {
    for (const feature of ATMUX_FEATURES) console.log(feature);
  }
  return 0;
}
