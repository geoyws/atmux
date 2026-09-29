// ADR-243 §Consequences: `claude-accounts` doctor probe.
//
// Surfaces the state of `~/.atmux/claude-accounts.json`:
//   - file absent   → yellow (informational — embedded defaults work)
//   - file malformed → red (operator must fix; the loader refuses)
//   - file valid    → silent (no row)
// $HOME-unset → silent (same defensive policy as checkSkillsPlugin).

import {
  claudeAccountsConfigPath,
  parseClaudeAccountsConfig,
} from "../../abstractions/claude-accounts-config.ts";
import { readTextOrNull } from "../../abstractions/fs.ts";
import { ConfigError } from "../../errors.ts";
import type { DoctorRow } from "./types.ts";

/** Inputs the pure state-mapper resolves to doctor rows. Exported so
 *  tests exercise every branch without filesystem I/O. */
export type ClaudeAccountsConfigState =
  | { kind: "absent"; path: string }
  | { kind: "malformed"; path: string; reason: string }
  | { kind: "valid"; path: string; accountCount: number };

/** Pure mapping. Silent on valid — a healthy config needs no row. */
export function claudeAccountsConfigStateRows(state: ClaudeAccountsConfigState): DoctorRow[] {
  switch (state.kind) {
    case "absent":
      return [
        {
          status: "yellow",
          label: "claude-accounts",
          detail: `claude-accounts config absent at ${state.path}; using built-in defaults`,
          hint: "run `atmux start` to bootstrap or write the file directly (ADR-243)",
        },
      ];
    case "malformed":
      return [
        {
          status: "red",
          label: "claude-accounts",
          detail: `claude-accounts config malformed at ${state.path} — ${state.reason}`,
          hint: "fix the JSON per ADR-243 §D1 or delete the file to use built-in defaults",
        },
      ];
    case "valid":
      return [];
  }
}

export interface CheckClaudeAccountsConfigOpts {
  /** Override $HOME for tests. */
  home?: string;
  /** Override the process env for tests. */
  env?: NodeJS.ProcessEnv;
}

/** I/O wrapper. Reads + validates the config file; maps the outcome
 *  to rows via `claudeAccountsConfigStateRows`. */
export async function checkClaudeAccountsConfig(
  opts: CheckClaudeAccountsConfigOpts = {},
): Promise<DoctorRow[]> {
  const home = opts.home ?? opts.env?.HOME ?? process.env.HOME;
  if (home === undefined || home.length === 0) return [];
  const path = claudeAccountsConfigPath(home);
  const raw = await readTextOrNull(path);
  if (raw === null) {
    return claudeAccountsConfigStateRows({ kind: "absent", path });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return claudeAccountsConfigStateRows({
      kind: "malformed",
      path,
      reason: `malformed JSON: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
  try {
    const config = parseClaudeAccountsConfig(parsed, path);
    return claudeAccountsConfigStateRows({
      kind: "valid",
      path,
      accountCount: config.accounts.length,
    });
  } catch (e) {
    const reason = e instanceof ConfigError ? e.message : String(e);
    return claudeAccountsConfigStateRows({ kind: "malformed", path, reason });
  }
}
