// ADR-094 c-alias spawn convention + ADR-167 §Decision wrapper-resolver
// table. Pure function — `claudeAccount.configDir` → wrapper-command
// name. Consumed by `src/verbs/cockpit-rotate.ts` (T4) to build the
// respawn shell command for medic cockpit role.
//
// The c-alias wrappers live on the operator's PATH (per global
// CLAUDE.md §Spawn Pattern); each wrapper exports the per-account
// CLAUDE_CONFIG_DIR + the canonical c-alias flags (CLAUDECODE=1,
// CLAUDE_CODE_EFFORT_LEVEL=xhigh, CLAUDE_GUARD_AGENT=1, --plugin-dir,
// --permission-mode auto) before exec'ing claude. Invoking the wrapper
// by name therefore yields the canonical bake-by-default shape per
// ADR-094 Ask A without requiring atmux to assemble the env+flags
// inline.
//
// Behaviour:
//   - Known configDir → wrapper-name string.
//   - Unknown configDir → ConfigError with the hint listing every
//     registered configDir.
//
// New wrapper aliases register by extending `WRAPPER_TABLE` here.

import { ConfigError } from "../errors.ts";

/** Canonical c-alias wrapper names. Order matches global CLAUDE.md
 *  §Spawn Pattern case-stanza. */
export type ClaudeWrapper = "claude" | "c-u" | "c-ic" | "c-i";

/** Resolution table per ADR-167 §Decision (claudeAccount wrapper
 *  resolver). Operator-side wrappers MUST be on PATH for the resolved
 *  name to actually exec. */
const WRAPPER_TABLE: ReadonlyMap<string, ClaudeWrapper> = new Map([
  ["/root/.claude", "claude"],
  ["/root/.claude-unum", "c-u"],
  ["/root/.claude-icloud", "c-ic"],
  ["/root/.claude-ifca", "c-i"],
]);

/** Resolve a `claudeAccount.configDir` string to its wrapper-command
 *  name. Pure — no IO. Unknown configDir refuses with a ConfigError
 *  whose hint enumerates the registered set so the operator can fix the
 *  cockpit.json entry or register a new wrapper.
 *
 *  Per ADR-167 §Decision wrapper-resolver: cockpit-rotate respawn for
 *  medic invokes the wrapper by name; team-driver respawn
 *  uses the cage retry-loop (per ADR-162) and does NOT thread through
 *  the wrapper, but callers still validate via this resolver to refuse
 *  unknown configDirs at the verb boundary. */
export function resolveClaudeWrapper(configDir: string): ClaudeWrapper {
  const w = WRAPPER_TABLE.get(configDir);
  if (w === undefined) {
    throw new ConfigError({
      what: `unknown claudeAccount.configDir '${configDir}' — no wrapper registered (ADR-094 c-alias convention)`,
      hint: `register a shell wrapper for this configDir under your shell init (see global CLAUDE.md §Spawn Pattern) OR pick one of: ${[...WRAPPER_TABLE.keys()].join(", ")}`,
    });
  }
  return w;
}

/** Enumerate registered configDirs. Surfaces in error hints + the
 *  doctor / cockpit-rotate audit telemetry. */
export function knownClaudeConfigDirs(): ReadonlyArray<string> {
  return [...WRAPPER_TABLE.keys()];
}
