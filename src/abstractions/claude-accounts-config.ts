// ADR-243 D1/D2: runtime-configurable claude accounts.
//
// `~/.atmux/claude-accounts.json` is the source-of-truth for the
// configDir → wrapper-name mapping; the table that used to live as a
// literal in `claude-account-wrapper.ts` is now the embedded-defaults
// fallback served when the file is absent.
//
// This module owns the schema + file loading. It never touches
// `process.env` — callers pass `home` explicitly (production callers
// forward `process.env.HOME`; tests pass a mkdtemp scratch dir), so
// the logic stays deterministic under test.
//
// Schema (v1, frozen per ADR-243 §D1):
//   { "schemaVersion": 1,
//     "accounts": [{ "configDir": "/root/.claude", "wrapper": "claude" }, …] }
// Rules: schemaVersion must be 1 (unknown → ConfigError refusal);
// configDir + wrapper must be non-empty strings; duplicate configDir
// → ConfigError. Paths/wrappers are NOT existence-checked at load
// time (lazy at first spawn, per ADR-243 §D1).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "../errors.ts";

/** Frozen schema version. Future versions arrive with a migration
 *  helper per ADR-243 §D5 — until then any other number refuses. */
export const CLAUDE_ACCOUNTS_SCHEMA_VERSION = 1;

/** Single `{ configDir, wrapper }` account entry. */
export interface ClaudeAccountEntry {
  configDir: string;
  wrapper: string;
}

/** Parsed v1 config file shape. */
export interface ClaudeAccountsConfig {
  schemaVersion: 1;
  accounts: ClaudeAccountEntry[];
}

/** Embedded defaults — the pre-ADR-243 literal table, served when
 *  the config file is absent (ADR-243 §D2 step 2). Order is the
 *  canonical enumeration order for `knownClaudeConfigDirs()`. */
export const DEFAULT_CLAUDE_ACCOUNTS: ClaudeAccountsConfig = {
  schemaVersion: 1,
  accounts: [
    { configDir: "/root/.claude", wrapper: "claude" },
    { configDir: "/root/.claude-unum", wrapper: "c-u" },
    { configDir: "/root/.claude-icloud", wrapper: "c-ic" },
    { configDir: "/root/.claude-ifca", wrapper: "c-i" },
  ],
};

/** Resolve the config file path under an explicit home dir. */
export function claudeAccountsConfigPath(home: string): string {
  return join(home, ".atmux", "claude-accounts.json");
}

/** Validate a parsed-JSON value against the v1 schema. Throws
 *  ConfigError (quoting `path` + the offending detail) on any
 *  mismatch — callers refuse to start, never silently fall back. */
export function parseClaudeAccountsConfig(raw: unknown, path: string): ClaudeAccountsConfig {
  const where = `claude-accounts config at ${path}`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError({
      what: `${where}: expected an object with schemaVersion + accounts`,
      hint: `write the v1 shape per ADR-243 §D1 or delete the file to use built-in defaults`,
    });
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion !== CLAUDE_ACCOUNTS_SCHEMA_VERSION) {
    throw new ConfigError({
      what: `${where}: unknown schemaVersion ${JSON.stringify(obj.schemaVersion)} — expected ${CLAUDE_ACCOUNTS_SCHEMA_VERSION}`,
      hint: `set "schemaVersion": ${CLAUDE_ACCOUNTS_SCHEMA_VERSION} (only v1 exists; a future v2 ships a migrate helper per ADR-243 §D5)`,
    });
  }
  if (!Array.isArray(obj.accounts)) {
    throw new ConfigError({
      what: `${where}: 'accounts' must be an array of { configDir, wrapper } entries`,
      hint: `write the v1 shape per ADR-243 §D1 or delete the file to use built-in defaults`,
    });
  }
  const seen = new Set<string>();
  const accounts: ClaudeAccountEntry[] = obj.accounts.map((entry: unknown, i: number) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ConfigError({
        what: `${where}: accounts[${i}] must be an object with configDir + wrapper`,
        hint: `each entry needs { "configDir": "<abs path>", "wrapper": "<name on PATH>" }`,
      });
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.configDir !== "string" || e.configDir.length === 0) {
      throw new ConfigError({
        what: `${where}: accounts[${i}].configDir must be a non-empty string`,
        hint: `each entry needs { "configDir": "<abs path>", "wrapper": "<name on PATH>" }`,
      });
    }
    if (typeof e.wrapper !== "string" || e.wrapper.length === 0) {
      throw new ConfigError({
        what: `${where}: accounts[${i}].wrapper must be a non-empty string`,
        hint: `each entry needs { "configDir": "<abs path>", "wrapper": "<name on PATH>" }`,
      });
    }
    if (seen.has(e.configDir)) {
      throw new ConfigError({
        what: `${where}: duplicate configDir '${e.configDir}' (accounts[${i}]) — mapping is ambiguous`,
        hint: `keep exactly one entry per configDir`,
      });
    }
    seen.add(e.configDir);
    return { configDir: e.configDir, wrapper: e.wrapper };
  });
  return { schemaVersion: 1, accounts };
}

export type ClaudeAccountsSource = "file" | "defaults";

/** Loaded table + provenance. `path` is null when `home` was
 *  unresolvable (no location to even probe). */
export interface LoadedClaudeAccounts {
  source: ClaudeAccountsSource;
  config: ClaudeAccountsConfig;
  table: Map<string, string>;
  path: string | null;
}

function defaultsResult(path: string | null): LoadedClaudeAccounts {
  return {
    source: "defaults",
    config: DEFAULT_CLAUDE_ACCOUNTS,
    table: new Map(DEFAULT_CLAUDE_ACCOUNTS.accounts.map((a) => [a.configDir, a.wrapper])),
    path,
  };
}

/** Load + validate the config for `home`. File absent (or `home`
 *  unset/empty) → embedded defaults. File present but unreadable or
 *  malformed → ConfigError refusal (never silent fallback — a present
 *  file is operator intent that needs fixing, per ADR-243 §D2 step 3).
 *
 *  Sync (readFileSync) because the wrapper resolver it feeds is a
 *  sync pure function; the result is cached per process at the call
 *  site, so this runs at most once per home value in practice. */
export function loadClaudeAccounts(home: string | undefined): LoadedClaudeAccounts {
  if (home === undefined || home.length === 0) return defaultsResult(null);
  const path = claudeAccountsConfigPath(home);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return defaultsResult(path);
    throw new ConfigError({
      what: `claude-accounts config at ${path} is unreadable: ${e instanceof Error ? e.message : String(e)}`,
      hint: `fix the file's permissions or delete it to use built-in defaults`,
      cause: e,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ConfigError({
      what: `claude-accounts config at ${path} is malformed JSON: ${e instanceof Error ? e.message : String(e)}`,
      hint: `fix the JSON or delete the file to use built-in defaults`,
      cause: e,
    });
  }
  const config = parseClaudeAccountsConfig(parsed, path);
  return {
    source: "file",
    config,
    table: new Map(config.accounts.map((a) => [a.configDir, a.wrapper])),
    path,
  };
}
