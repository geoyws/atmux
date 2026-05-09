// ADR-010: CLI dispatcher — `version` verb.
//
// Prints `atmux <version>` and exits 0. Bash decommissioned per ADR-064;
// version is now sourced from this constant directly. A future ADR will
// ratify a single source-of-truth (generated `src/version.ts` from
// package.json or a root VERSION file) — until then, bump in lockstep
// with package.json::version.

/**
 * The atmux version string. Bump in lockstep with `package.json::version`.
 */
export const ATMUX_VERSION = "0.6.0";

/**
 * `atmux version` — print the version string, exit 0. No state touched,
 * no Discord call, no .atmux/ access. Args are accepted but ignored
 * (matches bash, which doesn't validate args on this verb).
 */
export async function version(_args: ReadonlyArray<string>): Promise<number> {
  console.log(`atmux ${ATMUX_VERSION}`);
  return 0;
}
