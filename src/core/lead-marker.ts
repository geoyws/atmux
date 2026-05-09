// Lead-window + lead-session-start markers (I-1 + I-2).
//
// Originally embedded in `src/verbs/whip.ts`; extracted here so verbs
// other than `whip` (e.g. `pane-state`, ADR-062 §Decision (2)) can read
// the lead window name without crossing the verbs/* import boundary
// (ADR-003 §"Verbs MUST NOT import from another verb").
//
// `whip.ts` still re-exports these symbols so existing callers + the
// whip unit-test imports keep working unchanged.

import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { ensureDir, exists, readTextOrNull, writeText } from "../abstractions/fs.ts";

/** Override `~` for tests. Defaults to `os.homedir()`. */
export interface SkillsTeamPathsOpts {
  home?: string;
}

export function leadSessionStartPath(team: string, opts: SkillsTeamPathsOpts = {}): string {
  const home = opts.home ?? homedir();
  return join(home, ".claude", "teams", team, "lead-session-start.txt");
}

export function leadWindowNamePath(team: string, opts: SkillsTeamPathsOpts = {}): string {
  const home = opts.home ?? homedir();
  return join(home, ".claude", "teams", team, "lead-window-name.txt");
}

/** Force-write the I-1 marker (used by whip's `--init-lead-marker`). */
export async function writeLeadSessionStart(
  team: string,
  epochSec: number,
  opts: SkillsTeamPathsOpts = {},
): Promise<void> {
  const path = leadSessionStartPath(team, opts);
  await ensureDir(dirname(path));
  await writeText(path, `${epochSec}\n`);
}

/** Auto-init the I-1 marker iff missing — keeps the lead-uptime read
 *  from failing on the first tick of a fresh team. Returns true on a
 *  write. */
export async function ensureLeadSessionStart(
  team: string,
  epochSec: number,
  opts: SkillsTeamPathsOpts = {},
): Promise<boolean> {
  const path = leadSessionStartPath(team, opts);
  if (await exists(path)) return false;
  await writeLeadSessionStart(team, epochSec, opts);
  return true;
}

export async function readLeadSessionStart(
  team: string,
  opts: SkillsTeamPathsOpts = {},
): Promise<number | null> {
  const text = await readTextOrNull(leadSessionStartPath(team, opts));
  if (text === null) return null;
  const n = Number.parseInt(text.trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** I-2 read side. The marker file (when present) carries the
 *  authoritative current lead-window name — written by `team rotate-lead`
 *  / `team start` when the lead pane is renamed mid-cycle (auto-rotate).
 *
 *  Fallback when the marker is absent or empty:
 *  - Caller-supplied `fallback` wins. The whip per-member loop passes the
 *    ADR-017-style `<emoji><name>` derived from the team-lead member's
 *    schema entry — that matches what `start.ts::buildWindowName` actually
 *    spawns, so whip stops emitting false `🛑 lead: window missing`
 *    findings on freshly-started teams that haven't rotated yet.
 *  - When no fallback is supplied, default to the legacy bash convention
 *    `__<team>__team-lead`. Pre-bun callers + the unit tests rely on this
 *    behaviour; tightening would be a wider migration. */
export async function readLeadWindowName(
  team: string,
  opts: SkillsTeamPathsOpts & { fallback?: string } = {},
): Promise<string> {
  const text = await readTextOrNull(leadWindowNamePath(team, opts));
  if (text !== null) {
    const trimmed = text.trim();
    if (trimmed.length > 0) return trimmed;
  }
  if (opts.fallback !== undefined && opts.fallback.length > 0) return opts.fallback;
  return `__${team}__team-lead`;
}
