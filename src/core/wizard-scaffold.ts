// ADR-200 wizard steps for team, account-pool, and skills-plugin setup.
// All side effects are injected so the init verb can own prompting and paths.

import {
  type ClaudeAccountsConfig,
  DEFAULT_CLAUDE_ACCOUNTS,
} from "../abstractions/claude-accounts-config.ts";
import {
  type ClaudeAccountPoolEntry as AccountPoolEntry,
  ClaudeAccountPoolEntry,
} from "../schema/cockpit.ts";
import { Team, type Team as TeamShape } from "../schema/team.ts";
import type { InstallSkillsPluginOpts, SkillsInstallResult } from "./skills-plugin-install.ts";
export interface WizardJsonFsDeps {
  path: string;
  readText: (path: string) => Promise<string | null>;
  writeText: (path: string, content: string) => Promise<void>;
}

export interface WizardDriverAnswer {
  name: string;
  cwd: string;
  tui?: string | null;
  claudeAccount?: string;
}

export interface TeamScaffoldAnswers {
  name: string;
  drivers?: readonly WizardDriverAnswer[];
}

export type JsonStepResult<T> =
  | { kind: "written"; path: string; value: T }
  | { kind: "unchanged"; path: string; value: T };

function jsonDocument(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function parseObject(text: string, path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError(`Expected a JSON object in ${path}`);
  }
  return value as Record<string, unknown>;
}

async function writeIfChanged<T>(deps: WizardJsonFsDeps, value: T): Promise<JsonStepResult<T>> {
  const content = jsonDocument(value);
  const current = await deps.readText(deps.path);
  if (current === content) return { kind: "unchanged", path: deps.path, value };
  await deps.writeText(deps.path, content);
  return { kind: "written", path: deps.path, value };
}

/** Build and persist the smallest useful team.json accepted by Team. */
export async function scaffoldTeamJson(
  deps: WizardJsonFsDeps,
  answers: TeamScaffoldAnswers,
): Promise<JsonStepResult<TeamShape>> {
  const candidate: Record<string, unknown> = {
    name: answers.name,
    members: [],
  };
  if (answers.drivers !== undefined && answers.drivers.length > 0) {
    candidate.drivers = answers.drivers.map((driver) => ({ ...driver }));
  }

  const team = Team.parse(candidate);
  return writeIfChanged(deps, team);
}

/** Replace only cockpit.json::claudeAccountPool, preserving all other keys. */
export async function setupAccountPool(
  deps: WizardJsonFsDeps,
  accounts: readonly AccountPoolEntry[],
): Promise<JsonStepResult<Record<string, unknown>>> {
  const pool = ClaudeAccountPoolEntry.array().parse(accounts);
  const current = await deps.readText(deps.path);
  const cockpit = current === null ? {} : parseObject(current, deps.path);
  const updated = { ...cockpit, claudeAccountPool: pool };
  return writeIfChanged(deps, updated);
}

export interface InstallSkillsPluginStepDeps {
  runner: (options: InstallSkillsPluginOpts) => Promise<SkillsInstallResult>;
  options?: InstallSkillsPluginOpts;
}

/** Delegate ADR-217 §D5 symlink/idempotency behavior to the injected installer. */
export async function installSkillsPlugin(
  deps: InstallSkillsPluginStepDeps,
): Promise<SkillsInstallResult> {
  return deps.runner(deps.options ?? {});
}

/**
 * Bootstrap `~/.atmux/claude-accounts.json` on first run (e-24 T2).
 * Serializes DEFAULT_CLAUDE_ACCOUNTS when the file is absent; an
 * existing file — valid or malformed — is left untouched (malformed
 * refuses downstream per the T1 loader contract, so the wizard must
 * not delete or rewrite it). Never prompts, so `--yes` flows through
 * with no special-casing; `--force` does not change this step (the
 * team.json refusal gate already guards re-runs).
 */
export interface ClaudeAccountsBootstrapResult {
  kind: "written" | "unchanged";
  path: string;
}
export async function scaffoldClaudeAccounts(
  deps: WizardJsonFsDeps,
): Promise<ClaudeAccountsBootstrapResult> {
  const current = await deps.readText(deps.path);
  if (current !== null) return { kind: "unchanged", path: deps.path };
  const value: ClaudeAccountsConfig = DEFAULT_CLAUDE_ACCOUNTS;
  await deps.writeText(deps.path, jsonDocument(value));
  return { kind: "written", path: deps.path };
}
