// ADR-055 §D1: cursor-driven self-heal recipe interface.
//
// Each recipe is `detect → propose → verify` — three pure-ish hooks
// the whip-tick orchestrator calls in sequence. The Cursor invocation
// itself lives in `src/abstractions/cursor.ts::invokeCursor` and is
// orthogonal to the recipe (recipes describe WHAT to fix; the
// abstraction describes HOW to spawn cursor-agent).
//
// Anti-pattern guard (per ADR §"Anti-pattern guard"): NEVER ship an
// open-ended "look for any issues" recipe. Each recipe is a single,
// scoped, allowlist-bound fix.

/** Per-recipe context built by `detect`. Recipes parameterise propose/
 *  verify off this — keep it `unknown` here so each recipe's own type
 *  ladders through its own narrowed shape. */
export type RecipeContext = unknown;

/** Cursor invocation request — composed by `propose`. */
export interface CursorJob {
  /** Prompt fed to cursor-agent's stdin. Recipe author must keep this
   *  scoped to the allowlisted files; cursor's own --cwd flag bounds
   *  filesystem reach. */
  prompt: string;
  /** File path globs cursor's resulting patch is allowed to touch.
   *  `verify` enforces strictly: any patch line referencing a file
   *  outside this list fails verification. Empty array = patch-less
   *  recipe (cursor invokes a verb / shell action; verify checks
   *  external state). */
  fileAllowlist: string[];
  /** Per-job token cap. Default per-recipe is 5_000 (override via
   *  team.json::whip.selfHealTokenCaps.<recipeId>). */
  tokenCap: number;
  /** Working directory for cursor-agent --cwd. Tests inject; production
   *  is the team's project root. */
  cwd: string;
}

/** Patch shape returned by `invokeCursor`. The patch is what cursor
 *  produced; verify decides whether to stage or reject. */
export interface GitPatch {
  /** `git diff` text, including header lines. Empty when cursor
   *  produced no edits. */
  diff: string;
  /** Files cursor touched (from `git status -s` output post-invocation). */
  files: ReadonlyArray<string>;
}

/** Recipe-side verification result. */
export interface VerifyResult {
  /** True iff the patch may proceed to reviewer-stage. */
  ok: boolean;
  /** Human-readable reasons when ok=false. Empty when ok. */
  reasons: ReadonlyArray<string>;
  /** One-line patch summary for Discord + reviewer Task body. */
  patchSummary: string;
}

/** Whip-tick context exposed to recipe `detect`. Recipes only see the
 *  read-only surface they need (atmuxDir + team config + clock). The
 *  full WhipConfig isn't passed — recipes don't need pause/resume
 *  thresholds. */
export interface WhipTickContextForRecipe {
  atmuxDir: string;
  /** Project root (where `cursor-agent --cwd` will fire). */
  projectCwd: string;
  /** Epoch seconds — for log-file naming + dedup state stamping. */
  nowSec: number;
  /** Team name — for Discord + Reviewer-Task body composition. */
  teamName: string;
  /** Tmux session name — for `fix:supervisor-missing`-style recipes. */
  sessionName?: string;
}

/** The full recipe contract. */
export interface CursorRecipe {
  /** Stable id (used as state-file key + Discord bullet text). */
  id: string;
  /** Cheap predicate; null when recipe doesn't apply this tick. */
  detect: (ctx: WhipTickContextForRecipe) => Promise<RecipeContext | null>;
  /** Pure: build the CursorJob from the detect-context. */
  propose: (ctx: RecipeContext, whipCtx: WhipTickContextForRecipe) => Promise<CursorJob>;
  /** Validate cursor's output. Strictly bounded — if any reason
   *  surfaces, the patch is rejected and a P2 flag is raised. */
  verify: (
    job: CursorJob,
    patch: GitPatch,
    whipCtx: WhipTickContextForRecipe,
  ) => Promise<VerifyResult>;
  /** Default token cap. Operator overrides via team.json::whip.
   *  selfHealTokenCaps.<recipeId>. */
  tokenCap: number;
  /** Default file allowlist (recipe spec). `propose` may narrow further. */
  fileAllowlist: ReadonlyArray<string>;
}
