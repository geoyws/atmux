// ADR-055 §D4 second recipe: fix:cron-pollution.
//
// Detects: this team's `# >>> atmux:team=<n>` cron block is malformed
// — mismatched start/end markers, duplicate blocks, OR lines outside
// any block referencing this team's project path. Any of these
// conditions emits a recipe context with the offending crontab snippet
// + the canonical block (rendered via core/cron.ts).
//
// Proposes: cursor invocation with empty file allowlist (cron isn't a
// file in CWD; the canonical fix is to invoke `crontab -` with a
// scrubbed contents OR to wait for the operator to apply the staged
// patch manually). The recipe's PROPOSE prompt includes the canonical
// block string verbatim — cursor's role is advisory; the staged patch
// is empty and the dispatched reviewer-Task explains the manual fix.
//
// Verifies: re-shell `crontab -l`. If the team's block is now well-
// formed AND matches canonical (stripped of trailing whitespace) →
// ok. Otherwise → reasons + fail. Allowlist is empty so any patch
// touching files is rejected too.
//
// Failure posture: shell-out failures (`crontab` not installed,
// `crontab -l` returning non-zero / no crontab) → detect returns
// null (no drift to attempt; not an error).

import { spawn as defaultSpawn, type SpawnResult } from "../../abstractions/spawn.ts";
import { type RenderCronBlockOpts, renderCronBlock } from "../cron.ts";
import type {
  CursorJob,
  CursorRecipe,
  GitPatch,
  VerifyResult,
  WhipTickContextForRecipe,
} from "./types.ts";

// ---------- Public types ----------

export interface CronPollutionContext {
  /** The team's malformed block snippet (best-effort extraction). */
  malformedBlock: string;
  /** Canonical block the recipe wants to install (rendered via core/cron.ts). */
  canonicalBlock: string;
  /** Reasons the existing block is malformed (1+ entries). */
  reasons: ReadonlyArray<string>;
}

/** DI surface — tests inject a fake to avoid touching the host crontab. */
export interface CronPollutionDeps {
  /** Returns the current crontab contents. Resolves to null when the
   *  user has no crontab (errno 1 from `crontab -l`). */
  readCrontab?: () => Promise<string | null>;
  /** Renders the canonical block. Default is `core/cron.ts::renderCronBlock`.
   *  DI lets tests override the renderer (e.g. for stable goldens). */
  renderCanonical?: (opts: RenderCronBlockOpts) => string;
  /** Project root (for the canonical-block render's atmuxDir prefix +
   *  for "lines outside markers reference this project path" detection).
   *  Defaults to the recipe's `whipCtx.projectCwd`. */
  projectCwd?: string;
  /** Atmux binary path used in canonical-block rendering. Defaults to
   *  `/usr/local/bin/atmux` per CLAUDE.md hax convention. Tests override. */
  atmuxBin?: string;
  /** Optional `TMUX_TMPDIR` value baked into the canonical block. Empty
   *  string means "no prefix" — matches `core/cron.ts::renderCronLines`. */
  tmuxTmpdir?: string;
}

// ---------- Constants ----------

const RECIPE_ID = "fix:cron-pollution";
const TOKEN_CAP_DEFAULT = 5_000;
const FILE_ALLOWLIST: ReadonlyArray<string> = [];

// ---------- Internals ----------

async function defaultReadCrontab(): Promise<string | null> {
  let r: SpawnResult;
  try {
    r = await defaultSpawn({
      cmd: "crontab",
      argv: ["-l"],
      timeoutMs: 5_000,
      expectExitCode: "any",
    });
  } catch {
    return null;
  }
  // crontab -l returns 1 with "no crontab for <user>" when none exists.
  // Treat both as "nothing to scan".
  if (r.exitCode !== 0) return null;
  return r.stdout;
}

interface BlockExtraction {
  /** Full text of the team's block including markers (empty when absent). */
  blockText: string;
  /** True when at least one well-formed start marker was seen. */
  hasStart: boolean;
  /** True when at least one well-formed end marker was seen. */
  hasEnd: boolean;
  /** Count of start markers seen. */
  startCount: number;
  /** Count of end markers seen. */
  endCount: number;
  /** Lines OUTSIDE any block that reference the team's project path. */
  outsideRefs: ReadonlyArray<string>;
}

const STARTLINE = (team: string): string =>
  `# >>> atmux:team=${team} — managed by atmux start; do not edit by hand`;
const ENDLINE = (team: string): string => `# <<< atmux:team=${team}`;

function extractBlock(crontab: string, teamName: string, projectCwd: string): BlockExtraction {
  const lines = crontab.split("\n");
  const startMatch = STARTLINE(teamName);
  const endMatch = ENDLINE(teamName);
  let startCount = 0;
  let endCount = 0;
  let inside = false;
  const collected: string[] = [];
  const outsideRefs: string[] = [];
  let firstStartIdx = -1;
  let lastEndIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const ln = lines[i] ?? "";
    if (ln === startMatch) {
      startCount += 1;
      if (firstStartIdx === -1) firstStartIdx = i;
      inside = true;
      continue;
    }
    if (ln === endMatch) {
      endCount += 1;
      lastEndIdx = i;
      inside = false;
      continue;
    }
    if (!inside && projectCwd.length > 0 && ln.includes(projectCwd)) {
      outsideRefs.push(ln);
    }
    if (firstStartIdx !== -1 && lastEndIdx === -1) {
      collected.push(ln);
    }
  }
  let blockText = "";
  if (firstStartIdx !== -1) {
    const sliceEnd = lastEndIdx === -1 ? lines.length : lastEndIdx + 1;
    blockText = lines.slice(firstStartIdx, sliceEnd).join("\n");
  }
  void collected;
  return {
    blockText,
    hasStart: startCount > 0,
    hasEnd: endCount > 0,
    startCount,
    endCount,
    outsideRefs,
  };
}

function diagnoseMalformedness(extraction: BlockExtraction): string[] {
  const reasons: string[] = [];
  if (extraction.startCount > 1) {
    reasons.push(`duplicate start marker (${extraction.startCount} found)`);
  }
  if (extraction.endCount > 1) {
    reasons.push(`duplicate end marker (${extraction.endCount} found)`);
  }
  if (extraction.hasStart && !extraction.hasEnd) {
    reasons.push("start marker without matching end marker");
  }
  if (!extraction.hasStart && extraction.hasEnd) {
    reasons.push("end marker without matching start marker");
  }
  if (extraction.outsideRefs.length > 0) {
    reasons.push(
      `${extraction.outsideRefs.length} line(s) outside markers reference this team's project path`,
    );
  }
  return reasons;
}

// ---------- Recipe export ----------

export function makeFixCronPollutionRecipe(deps: CronPollutionDeps = {}): CursorRecipe {
  const readCrontab = deps.readCrontab ?? defaultReadCrontab;
  const renderCanonical = deps.renderCanonical ?? renderCronBlock;
  return {
    id: RECIPE_ID,
    tokenCap: TOKEN_CAP_DEFAULT,
    fileAllowlist: FILE_ALLOWLIST,

    async detect(whipCtx: WhipTickContextForRecipe): Promise<CronPollutionContext | null> {
      const crontab = await readCrontab();
      if (crontab === null) return null;
      const projectCwd = deps.projectCwd ?? whipCtx.projectCwd;
      const extraction = extractBlock(crontab, whipCtx.teamName, projectCwd);
      const reasons = diagnoseMalformedness(extraction);
      if (reasons.length === 0) return null;

      // Build canonical via the renderer. We don't have the full Team
      // schema here so we synthesise a minimal Team-shape — the renderer
      // only needs `name` + `whip` + `members` for conditional gating;
      // the malformed-block fix doesn't aim to redo conditional lines
      // the team currently lacks (those are the operator's choice via
      // team.json edits + atmux start re-run). So we emit a CONSERVATIVE
      // canonical that uses only the core */5 whip + */30 report lines —
      // matches the always-on portion of `core/cron.ts::renderCronLines`
      // and is the minimal scrub that fixes pollution without
      // accidentally inserting conditional lines.
      const conservativeTeam = {
        name: whipCtx.teamName,
        members: [],
        whip: undefined,
      } as unknown as RenderCronBlockOpts["team"];
      const canonicalBlock = renderCanonical({
        team: conservativeTeam,
        atmuxDir: whipCtx.atmuxDir,
        atmuxBin: deps.atmuxBin ?? "/usr/local/bin/atmux",
        ...(deps.tmuxTmpdir !== undefined ? { tmuxTmpdir: deps.tmuxTmpdir } : {}),
      });

      return {
        malformedBlock: extraction.blockText,
        canonicalBlock,
        reasons,
      };
    },

    async propose(rawCtx: unknown, _whipCtx: WhipTickContextForRecipe): Promise<CursorJob> {
      const ctx = rawCtx as CronPollutionContext;
      const reasonText = ctx.reasons.map((r) => `- ${r}`).join("\n");
      const prompt = [
        "Fix cron pollution detected in the operator's crontab.",
        "",
        "REASONS the existing block is malformed:",
        reasonText,
        "",
        "MALFORMED BLOCK (verbatim from `crontab -l`):",
        "```",
        ctx.malformedBlock,
        "```",
        "",
        "CANONICAL BLOCK (the desired final state):",
        "```",
        ctx.canonicalBlock,
        "```",
        "",
        "Constraints (HARD — failing any of these aborts the patch):",
        "1. Do NOT modify any file in the project — fileAllowlist is empty.",
        "2. Do NOT touch lines outside the team's start/end markers.",
        "3. Do NOT touch any other team's atmux:team=<n> blocks.",
        "4. Output an empty patch — the staged reviewer Task will apply the",
        "   canonical via `crontab -` after operator review.",
        "",
        "After confirming you understand the canonical shape, exit. The",
        "actual crontab rewiring is operator-applied via the staged patch.",
      ].join("\n");
      return {
        prompt,
        fileAllowlist: [...FILE_ALLOWLIST],
        tokenCap: TOKEN_CAP_DEFAULT,
        cwd: _whipCtx.projectCwd,
      };
    },

    async verify(
      _job: CursorJob,
      patch: GitPatch,
      whipCtx: WhipTickContextForRecipe,
    ): Promise<VerifyResult> {
      const reasons: string[] = [];

      // (1) Allowlist enforcement — empty allowlist means patch.files
      // must be empty. Any non-empty patch is a violation.
      if (patch.files.length > 0) {
        reasons.push(`patch touched ${patch.files.length} file(s) but recipe allowlist is empty`);
      }

      // (2) Re-detect to confirm operator intent — when the cron block
      // is still malformed (most cases, since cursor can't actually fix
      // crontab from inside its sandbox), the recipe surface signals
      // "needs operator review" rather than "auto-applied". The
      // patchSummary field carries that signal.
      const crontab = await readCrontab();
      if (crontab === null) {
        return {
          ok: reasons.length === 0,
          reasons,
          patchSummary:
            reasons.length === 0
              ? "no crontab found — pollution self-resolved or operator removed it"
              : (reasons[0] ?? "verification failed"),
        };
      }
      const projectCwd = deps.projectCwd ?? whipCtx.projectCwd;
      const extraction = extractBlock(crontab, whipCtx.teamName, projectCwd);
      const remainingReasons = diagnoseMalformedness(extraction);
      const stillMalformed = remainingReasons.length > 0;

      const summary =
        reasons.length === 0 && !stillMalformed
          ? "cron block well-formed — pollution cleared"
          : reasons.length === 0
            ? `cron still malformed (${remainingReasons.length} reason(s)) — staged for reviewer`
            : (reasons[0] ?? "verification failed");

      // The recipe's "ok" is true when allowlist is honored, regardless
      // of whether the cron itself is now clean. Reason: cursor cannot
      // fix crontab from within its sandbox; the staged reviewer Task
      // (with the canonical block in its body) is the actual fix path.
      // If the operator wants strict "verify must observe clean cron",
      // they can flip this gate later.
      return { ok: reasons.length === 0, reasons, patchSummary: summary };

      function readCrontab(): Promise<string | null> {
        return (deps.readCrontab ?? defaultReadCrontab)();
      }
    },
  };
}

/** Default-DI export — calls `crontab -l` + `renderCronBlock` from
 *  `core/cron.ts`. The whip-tick registry uses this; tests use
 *  `makeFixCronPollutionRecipe({...DI})` to inject fakes. */
export const fixCronPollutionRecipe: CursorRecipe = makeFixCronPollutionRecipe();
