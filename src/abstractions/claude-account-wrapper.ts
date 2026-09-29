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
// New wrapper aliases register via config (cockpit.json `wrappers` +
// team.json `wrappers` override); the table below is built-in defaults.

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
export function resolveClaudeWrapper(configDir: string): ClaudeWrapper;
export function resolveClaudeWrapper(configDir: string, registry: ReadonlyMap<string, string>): string;
export function resolveClaudeWrapper(
  configDir: string,
  registry: ReadonlyMap<string, string> = WRAPPER_TABLE,
): string {
  const w = registry.get(configDir);
  if (w === undefined) {
    throw new ConfigError({
      what: `unknown claudeAccount.configDir '${configDir}' — no wrapper registered (ADR-094 c-alias convention)`,
      hint: `register the wrapper in cockpit.json \`wrappers\` (or team.json \`wrappers\` override) OR pick one of: ${[...registry.keys()].join(", ")}`,
    });
  }
  return w;
}

/** Merge registries left-to-right (later wins): built-ins →
 *  cockpit.json `wrappers` → team.json `wrappers`. Accepts plain
 *  records from parsed config. */
export function mergeWrapperRegistries(
  ...registries: ReadonlyArray<Record<string, string> | undefined>
): Map<string, string> {
  const out = new Map<string, string>(WRAPPER_TABLE);
  for (const r of registries) {
    if (r === undefined) continue;
    for (const [k, v] of Object.entries(r)) out.set(k, v);
  }
  return out;
}

 /** Enumerate registered configDirs. Surfaces in error hints + the
  *  doctor / cockpit-rotate audit telemetry. */
 export function knownClaudeConfigDirs(): ReadonlyArray<string> {
   return [...WRAPPER_TABLE.keys()];
 }
