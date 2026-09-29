// ADR-094 c-alias spawn convention + ADR-167 §Decision wrapper-resolver
// + ADR-243 runtime-configurable accounts table. `claudeAccount.configDir`
// → wrapper-command name. Consumed by `src/verbs/cockpit-rotate.ts` (T4)
// to build the respawn shell command for medic cockpit role.
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
//
// ADR-243: the built-in table is only the absent-file fallback. When
// `~/.atmux/claude-accounts.json` exists it is the source-of-truth,
// loaded once per process and cached. A present-but-malformed file
// refuses with ConfigError (never silent fallback).

import { ConfigError } from "../errors.ts";
import { loadClaudeAccounts } from "./claude-accounts-config.ts";

/** Canonical c-alias wrapper names. Order matches global CLAUDE.md
 *  §Spawn Pattern case-stanza. */
export type ClaudeWrapper = "claude" | "c-u" | "c-ic" | "c-i";

/** Per-process cache of the effective built-in registry (file table
 *  when present, embedded defaults when absent). Lazy: filled on
 *  first lookup so module import stays IO-free. */
let cachedBuiltins: ReadonlyMap<string, string> | null = null;
let warnedAbsentFallback = false;

/** Reset the built-ins cache (test seam — lets file-backed tests
 *  point at a scratch HOME per case). */
export function resetClaudeWrapperCacheForTests(): void {
  cachedBuiltins = null;
  warnedAbsentFallback = false;
}

/** Effective built-in registry: config file when present, embedded
 *  defaults when absent (one-time stderr notice), ConfigError when
 *  present-but-malformed. `process.env.HOME` is read exactly here —
 *  the loader itself takes `home` explicitly. */
function builtInRegistry(): ReadonlyMap<string, string> {
  if (cachedBuiltins !== null) return cachedBuiltins;
  const loaded = loadClaudeAccounts(process.env.HOME);
  cachedBuiltins = loaded.table;
  if (loaded.source === "defaults" && !warnedAbsentFallback) {
    warnedAbsentFallback = true;
    process.stderr.write(
      "[atmux] claude-accounts: ~/.atmux/claude-accounts.json not found; using built-in defaults. " +
        "Run `atmux start` to bootstrap or write the file directly.\n",
    );
  }
  return cachedBuiltins;
}
/** Resolve a `claudeAccount.configDir` string to its wrapper-command
 *  name. Unknown configDir refuses with a ConfigError whose hint
 *  enumerates the registered set so the operator can fix the
 *  cockpit.json entry or register a new wrapper. With no explicit
 *  registry the lookup runs against the effective built-ins (config
 *  file when present, embedded defaults when absent — ADR-243 §D2).
 *
 *  Per ADR-167 §Decision wrapper-resolver: cockpit-rotate respawn for
 *  medic invokes the wrapper by name; team-driver respawn
 *  uses the cage retry-loop (per ADR-162) and does NOT thread through
 *  the wrapper, but callers still validate via this resolver to refuse
 *  unknown configDirs at the verb boundary. */

export function resolveClaudeWrapper(configDir: string): ClaudeWrapper;
export function resolveClaudeWrapper(
  configDir: string,
  registry: ReadonlyMap<string, string>,
): string;
export function resolveClaudeWrapper(
  configDir: string,
  registry: ReadonlyMap<string, string> = builtInRegistry(),
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
 *  records from parsed config. Built-ins are the effective table
 *  (config file when present, embedded defaults when absent). */
export function mergeWrapperRegistries(
  ...registries: ReadonlyArray<Record<string, string> | undefined>
): Map<string, string> {
  const out = new Map<string, string>(builtInRegistry());
  for (const r of registries) {
    if (r === undefined) continue;
    for (const [k, v] of Object.entries(r)) out.set(k, v);
  }
  return out;
}

/** Enumerate registered configDirs. Surfaces in error hints + the
 *  doctor / cockpit-rotate audit telemetry. */
export function knownClaudeConfigDirs(): ReadonlyArray<string> {
  return [...builtInRegistry().keys()];
}
