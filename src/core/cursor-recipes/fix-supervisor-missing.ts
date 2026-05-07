// ADR-055 §D4 third recipe: fix:supervisor-missing.
//
// Detects: `tmux list-windows -t <session>` shows no `supervisor`
// window. Recipe context carries the full window list at detect time
// (for the dispatched-to-reviewer Task body) + the session name.
//
// Proposes: cursor invocation with empty file allowlist (the canonical
// fix is to invoke `atmux start --re-supervisor-only` OR — when that
// flag isn't yet wired in the bun port — to run `atmux team rotate-
// lead`-equivalent supervisor re-spawn). The recipe's PROPOSE prompt
// asks cursor to confirm the situation; the staged reviewer-Task
// carries the operator instruction.
//
// Verifies: re-list windows; if a `supervisor` window now exists →
// ok. Otherwise → ok=false with reasons (so the failure-ping fires).
// Allowlist empty: any patch touching files is rejected.
//
// Failure posture: tmux missing / session missing / list-windows
// returning non-zero → detect returns null (the supervisor-missing
// pattern doesn't apply when the whole session is gone — that's a
// different recovery path: `atmux up`).

import type {
  CursorJob,
  CursorRecipe,
  GitPatch,
  VerifyResult,
  WhipTickContextForRecipe,
} from "./types.ts";

// ---------- Public types ----------

export interface SupervisorMissingContext {
  /** Tmux session name we probed (must equal whipCtx.sessionName when set). */
  sessionName: string;
  /** Window names present at detect time (for operator triage). */
  presentWindows: ReadonlyArray<string>;
}

/** DI surface — tests inject a fake to avoid touching real tmux. */
export interface SupervisorMissingDeps {
  /** Returns the list of window names for the given session. Resolves
   *  to null when the session itself doesn't exist OR tmux isn't
   *  reachable (in which case the recipe doesn't apply). */
  listWindows?: (sessionName: string) => Promise<ReadonlyArray<string> | null>;
}

// ---------- Constants ----------

const RECIPE_ID = "fix:supervisor-missing";
const TOKEN_CAP_DEFAULT = 1_000;
const FILE_ALLOWLIST: ReadonlyArray<string> = [];
const SUPERVISOR_WINDOW_NAME = "supervisor";

// ---------- Internals ----------

async function defaultListWindows(
  sessionName: string,
): Promise<ReadonlyArray<string> | null> {
  // Direct `tmux list-windows` shell-out — avoids createTmux's socket
  // config requirement. The recipe doesn't need a pinned socket since
  // it operates against whatever socket the operator's tmux is using
  // (the cage-socket pinning happens at supervisor spawn time, not
  // here). Failure modes (tmux missing, session absent, list error)
  // all map to null.
  const { spawn } = await import("../../abstractions/spawn.ts");
  let r;
  try {
    r = await spawn({
      cmd: "tmux",
      argv: ["list-windows", "-t", sessionName, "-F", "#{window_name}"],
      timeoutMs: 5_000,
      expectExitCode: "any",
    });
  } catch {
    return null;
  }
  if (r.exitCode !== 0) return null;
  const lines = r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return lines;
}

// ---------- Recipe export ----------

export function makeFixSupervisorMissingRecipe(
  deps: SupervisorMissingDeps = {},
): CursorRecipe {
  const listWindows = deps.listWindows ?? defaultListWindows;
  return {
    id: RECIPE_ID,
    tokenCap: TOKEN_CAP_DEFAULT,
    fileAllowlist: FILE_ALLOWLIST,

    async detect(
      whipCtx: WhipTickContextForRecipe,
    ): Promise<SupervisorMissingContext | null> {
      const sessionName = whipCtx.sessionName;
      if (sessionName === undefined || sessionName.length === 0) return null;
      const windows = await listWindows(sessionName);
      if (windows === null) return null;
      // Supervisor present → no drift.
      if (windows.includes(SUPERVISOR_WINDOW_NAME)) return null;
      return { sessionName, presentWindows: windows };
    },

    async propose(rawCtx: unknown, whipCtx: WhipTickContextForRecipe): Promise<CursorJob> {
      const ctx = rawCtx as SupervisorMissingContext;
      const presentText =
        ctx.presentWindows.length === 0
          ? "(no other windows)"
          : ctx.presentWindows.map((w) => `- ${w}`).join("\n");
      const prompt = [
        `Supervisor window absent in tmux session \`${ctx.sessionName}\`.`,
        "",
        "WINDOWS PRESENT at detect time:",
        presentText,
        "",
        `EXPECTED: a window named \`${SUPERVISOR_WINDOW_NAME}\` belonging to`,
        `the atmux team \`${whipCtx.teamName}\`.`,
        "",
        "Constraints (HARD — failing any of these aborts the patch):",
        "1. Do NOT modify any file in the project — fileAllowlist is empty.",
        "2. The actual fix is operator-applied: re-run `atmux start` (which",
        "   re-creates the supervisor window via the existing spawn path)",
        "   OR `atmux team rotate-lead` if rotation is the desired path.",
        "3. Output an empty patch — the staged reviewer Task carries the",
        "   operator instruction.",
        "",
        "Exit when you have understood the situation.",
      ].join("\n");
      return {
        prompt,
        fileAllowlist: [...FILE_ALLOWLIST],
        tokenCap: TOKEN_CAP_DEFAULT,
        cwd: whipCtx.projectCwd,
      };
    },

    async verify(
      job: CursorJob,
      patch: GitPatch,
      whipCtx: WhipTickContextForRecipe,
    ): Promise<VerifyResult> {
      const reasons: string[] = [];

      // (1) Allowlist enforcement — empty means patch must be empty.
      if (patch.files.length > 0) {
        reasons.push(
          `patch touched ${patch.files.length} file(s) but recipe allowlist is empty`,
        );
      }

      // (2) Re-list windows. If supervisor is now present → operator
      // already fixed it (or another tick raced ahead). Otherwise,
      // the staged reviewer Task is the operator's cue.
      const sessionName = whipCtx.sessionName;
      let supervisorPresent = false;
      if (sessionName !== undefined && sessionName.length > 0) {
        const windows = await listWindows(sessionName);
        if (windows !== null && windows.includes(SUPERVISOR_WINDOW_NAME)) {
          supervisorPresent = true;
        }
      }

      const summary = supervisorPresent
        ? `supervisor window now present in session \`${sessionName ?? ""}\``
        : reasons.length === 0
          ? `supervisor still absent in session \`${sessionName ?? ""}\` — staged for reviewer`
          : reasons[0] ?? "verification failed";

      return { ok: reasons.length === 0, reasons, patchSummary: summary };
    },
  };
}

/** Default-DI export — calls real tmux. The whip-tick registry uses
 *  this; tests use `makeFixSupervisorMissingRecipe({...DI})`. */
export const fixSupervisorMissingRecipe: CursorRecipe = makeFixSupervisorMissingRecipe();
