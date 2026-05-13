// ADR-010: CLI dispatcher — `version` verb.
//
// The version string is read from `package.json::version` at runtime
// via Bun's JSON import. This kills the drift class that prior manual
// lockstep failed to prevent (caught 2026-05-12: hardcoded "0.6.0"
// while package.json had moved to 0.7.2). The TS-side single source
// of truth is package.json — no separate constant to bump.

import pkg from "../../package.json" with { type: "json" };

/**
 * The atmux version string — sourced from `package.json::version` at
 * runtime so bumps land in one place.
 */
export const ATMUX_VERSION: string = pkg.version;

/**
 * `atmux version` — print the version string, exit 0. No state touched,
 * no Discord call, no .atmux/ access. Args are accepted but ignored
 * (matches bash, which doesn't validate args on this verb).
 */
export async function version(_args: ReadonlyArray<string>): Promise<number> {
  console.log(`atmux ${ATMUX_VERSION}`);
  return 0;
}
