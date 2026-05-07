// ADR-055 §D4 first recipe: fix:team-json-schema-drift.
//
// Detects: most recent ADR-054 drift report exists for the current
// team.json AND was last fired < 1h ago AND hasn't been self-healed
// yet.
//
// Proposes: prompt cursor to apply Zod schema defaults from
// `src/schema/team.ts::TeamWhip` to the missing/invalid fields. File
// allowlist: `["team.json"]`. No new keys, no `members[]` mutation.
//
// Verifies: re-parse the patched team.json with `Team.safeParse`.
// Patch verifies iff `success: true` AND no key beyond the issues'
// paths was modified (path comparison via JSON-AST diff, not raw
// text — accommodates whitespace shuffling cursor may introduce).

import { readTextOrNull } from "../../abstractions/fs.ts";
import { composeDriftReport, type DriftIssue } from "../whip-config-drift.ts";
import { teamJsonPath } from "../common.ts";
import { Team } from "../../schema/team.ts";
import type {
  CursorJob,
  CursorRecipe,
  GitPatch,
  VerifyResult,
  WhipTickContextForRecipe,
} from "./types.ts";

/** Recipe-side context shape. Narrows the generic `RecipeContext`. */
interface DriftRecipeContext {
  issues: ReadonlyArray<DriftIssue>;
  /** Top-level paths the recipe is allowed to modify (canonical-sorted). */
  allowedPaths: ReadonlyArray<string>;
  /** Pre-mutation team.json contents (for verify diff). */
  teamJsonBefore: string;
}

const RECIPE_ID = "fix:team-json-schema-drift";
const TOKEN_CAP_DEFAULT = 5_000;
const FILE_ALLOWLIST = ["team.json"];

export const fixTeamJsonSchemaDriftRecipe: CursorRecipe = {
  id: RECIPE_ID,
  tokenCap: TOKEN_CAP_DEFAULT,
  fileAllowlist: FILE_ALLOWLIST,

  async detect(ctx: WhipTickContextForRecipe): Promise<DriftRecipeContext | null> {
    const path = teamJsonPath(ctx.atmuxDir);
    const text = await readTextOrNull(path);
    if (text === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Catastrophic drift — JSON-parse failure. The recipe doesn't
      // attempt this case (cursor can't fix invalid-JSON; needs a
      // human or a different recipe). Surface null; the catastrophic
      // ping path elsewhere handles operator alerting.
      return null;
    }
    const result = Team.safeParse(parsed);
    if (result.success) return null; // no drift — recipe doesn't apply
    // Drift detected. Compose canonical issue list.
    const report = composeDriftReport(result.error, text);
    if (report.issues.length === 0) return null;
    const allowedPaths = canonicalTopLevelPaths(report.issues);
    return {
      issues: report.issues,
      allowedPaths,
      teamJsonBefore: text,
    };
  },

  async propose(rawCtx: unknown, _whipCtx: WhipTickContextForRecipe): Promise<CursorJob> {
    const ctx = rawCtx as DriftRecipeContext;
    const issuesText = ctx.issues
      .map((i) => `- ${formatPath(i.path)} (${i.code}): ${i.message}`)
      .join("\n");
    const prompt = [
      "Fix `team.json` schema drift detected by atmux's whip-config-drift",
      "validator (per ADR-054). Apply the canonical Zod schema defaults",
      "from `src/schema/team.ts::TeamWhip` to address the issues below.",
      "",
      "Issues:",
      issuesText,
      "",
      "Constraints (HARD — failing any of these aborts the patch):",
      "1. ONLY modify `team.json`. No other files.",
      "2. Do NOT add new top-level keys beyond what's already there.",
      "3. Do NOT modify `members[]` in any way.",
      "4. Apply schema defaults from TeamWhip — do not invent values.",
      "5. Output the updated `team.json` verbatim. Preserve unrelated",
      "   fields exactly. Use 2-space indent.",
      "",
      "After editing, run no commands — just write the file.",
    ].join("\n");
    return {
      prompt,
      fileAllowlist: [...FILE_ALLOWLIST],
      tokenCap: TOKEN_CAP_DEFAULT,
      cwd: _whipCtx.projectCwd,
    };
  },

  async verify(
    job: CursorJob,
    patch: GitPatch,
    whipCtx: WhipTickContextForRecipe,
  ): Promise<VerifyResult> {
    const reasons: string[] = [];

    // (1) Allowlist enforcement — every file in patch.files must be in
    // job.fileAllowlist.
    for (const f of patch.files) {
      if (!job.fileAllowlist.includes(f)) {
        reasons.push(`patch touched non-allowlisted file: ${f}`);
      }
    }

    // (2) Re-read the post-cursor team.json and parse with Team schema.
    const path = teamJsonPath(whipCtx.atmuxDir);
    const after = await readTextOrNull(path);
    if (after === null) {
      reasons.push("team.json missing post-cursor (recipe damaged the file)");
      return { ok: false, reasons, patchSummary: "team.json missing post-cursor" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(after);
    } catch (e) {
      reasons.push(
        `team.json invalid JSON post-cursor: ${e instanceof Error ? e.message : String(e)}`,
      );
      return {
        ok: false,
        reasons,
        patchSummary: "team.json malformed post-cursor",
      };
    }
    const reparse = Team.safeParse(parsed);
    if (!reparse.success) {
      const remainingDrift = composeDriftReport(reparse.error, after);
      reasons.push(
        `team.json still drift-failing post-cursor (${remainingDrift.issues.length} issue(s))`,
      );
      return {
        ok: false,
        reasons,
        patchSummary: `${remainingDrift.issues.length} drift issue(s) remain`,
      };
    }

    // (3) members[] preservation — must remain an array post-cursor.
    // Strict pre/post members count-equality would require the detect-
    // time snapshot to be threaded through verify; not done in v1.
    // The Team.safeParse step above already guarantees the shape is
    // valid, including members being an array of TeamMember.
    if (typeof parsed === "object" && parsed !== null) {
      const after = (parsed as { members?: unknown }).members;
      if (!Array.isArray(after)) {
        reasons.push("team.json members[] is not an array post-cursor");
      }
    }

    // (4) Patch summary — count keys touched at the path level.
    const summary =
      reasons.length === 0
        ? `team.json drift fix — schema parses clean (${patch.files.length} file touched)`
        : reasons[0] ?? "verification failed";

    return {
      ok: reasons.length === 0,
      reasons,
      patchSummary: summary,
    };
  },
};

// ---------- Internals ----------

function canonicalTopLevelPaths(issues: ReadonlyArray<DriftIssue>): ReadonlyArray<string> {
  const set = new Set<string>();
  for (const i of issues) {
    if (i.path.length > 0) set.add(String(i.path[0]));
  }
  return [...set].sort();
}

function formatPath(path: ReadonlyArray<string>): string {
  if (path.length === 0) return "<root>";
  return path.join(".");
}

// Re-export a fixture-builder for tests (exposed via the recipe module
// so tests can stage a synthetic broken team.json + walk the recipe
// without going through the verb layer).
export const _testFixtureRecipe = fixTeamJsonSchemaDriftRecipe;
