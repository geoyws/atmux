// ADR-010: CLI dispatcher — `version` verb.
// ADR-009: First operational parity-harness verb (smallest state).
//
// Mirrors bash `lib/common.sh::atmux::version` — prints `atmux <version>`
// and exits 0. The version constant is hardcoded here to match bash@HEAD;
// a future ADR will ratify a single source-of-truth for cross-language
// version sync (likely a generated `src/version.ts` from a root VERSION
// file, or read of `package.json` once package.json is bumped to match
// the bash release line).

/**
 * The atmux version string. Must equal bash's `atmux::version` output —
 * the parity harness fails the `version` verb if these drift.
 */
export const ATMUX_VERSION = "0.3.0";

/**
 * `atmux version` — print the version string, exit 0. No state touched,
 * no Discord call, no .atmux/ access. Args are accepted but ignored
 * (matches bash, which doesn't validate args on this verb).
 */
export async function version(_args: ReadonlyArray<string>): Promise<number> {
  console.log(`atmux ${ATMUX_VERSION}`);
  return 0;
}
