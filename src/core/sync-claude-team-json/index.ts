// Orchestrator for `atmux sync claude-team-json` — ADR-164 §"Behavior"
// steps 1-4. Reads inputs, computes the mapped Claude-side roster.
//
// T3 scope (per t-312fe824 body): compute path only. Write (step 7),
// drift detection (step 5), brief preservation (step 6), and --dry-run
// (step 8) extend this module in T4-T6 and are intentionally out-of-scope
// here. Callers (T6 dispatcher) compose this compute path with the
// write / drift / preview pieces.

import { join } from "node:path";
import { readTextOrNull } from "../../abstractions/fs.ts";
import type { ResolveDirOpts } from "../common.ts";
import { tryLoadTeam } from "../common.ts";
import { mapRoster } from "./mapping.ts";
import type {
  ClaudeTeam,
  ClaudeTeamMember,
  ColorSidecar,
} from "./types.ts";

/** Repo-root resolution: by default the orchestrator reads `.claude/...`
 *  files relative to `process.cwd()`. Tests + future callers may pin a
 *  different root via `claudeDir`. The atmux-side `.atmux/team.json` is
 *  read via the existing `ResolveDirOpts` chain in `tryLoadTeam`. */
export interface ComputeOpts extends ResolveDirOpts {
  /** Override the directory used to locate `.claude/team.json` +
   *  `.claude/team-colors.json`. Defaults to `<cwd>/.claude`. */
  claudeDir?: string;
}

export interface ComputeResult {
  /** Parsed prior Claude-side file, or null when none existed on disk.
   *  T4 (brief preservation) reads this; T3 returns it untouched so
   *  downstream layers can diff against it. */
  prior: ClaudeTeam | null;
  /** Newly computed mapped roster (no brief-preservation merge yet —
   *  that's T4). The top-level `name` + `description` are propagated
   *  from the atmux-side team. */
  computed: {
    name: string;
    description: string | undefined;
    members: ClaudeTeamMember[];
  };
  /** Resolved sidecar (if present). Pass-through for downstream layers. */
  sidecar: ColorSidecar | null;
}

function claudeDirOf(opts: ComputeOpts): string {
  return opts.claudeDir ?? join(process.cwd(), ".claude");
}

/** Parse a loose JSON file at `path`. Returns null when absent.
 *  Throws SyntaxError on malformed JSON — callers surface this as a
 *  user-facing error rather than swallow it. ADR-164 §Behavior step 2
 *  says "parse loosely (no schema validation)" — that is no Zod, not no
 *  JSON-level validation. */
async function readLooseJson<T>(path: string): Promise<T | null> {
  const text = await readTextOrNull(path);
  if (text === null) return null;
  return JSON.parse(text) as T;
}

/** Read all three inputs + compute the mapped roster. T4-T6 layer write,
 *  brief-preservation, drift-detection, and dry-run on top. */
export async function computeMappedTeam(
  opts: ComputeOpts = {},
): Promise<ComputeResult> {
  const team = await tryLoadTeam(opts);
  if (team === null) {
    throw new Error(
      "atmux sync claude-team-json: no .atmux/team.json — run 'atmux init' first",
    );
  }
  const dir = claudeDirOf(opts);
  const prior = await readLooseJson<ClaudeTeam>(join(dir, "team.json"));
  const sidecar = await readLooseJson<ColorSidecar>(
    join(dir, "team-colors.json"),
  );
  const members = mapRoster(team.members, sidecar);
  return {
    prior,
    computed: {
      name: team.name,
      description: team.description,
      members,
    },
    sidecar,
  };
}
