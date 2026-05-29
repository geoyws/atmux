// e-11-446429c9 §S2 — auto-merge invoker for in-cage epic-team scenario.
//
// The orchd auto-merge handler runs in each cage's own orchd process.
// When the cage IS an epic-team (team.json::epicTeam set), its kanban
// task.done events should fire performEpicMerge against this cage's
// own state. ADR-091's in-cage cron tick used to drive this; ADR-233
// retired that cron and orchd inherits the responsibility.
//
// Implementation: spawn `atmux epic-merge tick --team-dir <teamDir>`
// as a one-shot subprocess. The verb already encapsulates the full
// merge flow (gate-resolve → state machine → performEpicMerge → emit
// epic.merged on success). Spawn cost is ~50ms — same order as the
// orchd Bun --handle-one cold start; acceptable.
//
// We don't extract performEpicMerge's context-building into a
// dispatcher-callable function because that builds heavy machinery
// (MergerStateRepo, gate resolution, test-gate hooks) that the verb
// already does; duplicating it would split the implementation across
// two code paths and trigger drift.
//
// Why subprocess vs in-process: epicMergeTickVerb calls process-global
// helpers (createLogger, requireTeam from cwd, env reads). Calling it
// in-process would need cwd manipulation + risk pollution. Subprocess
// gets a clean process per invocation; the dispatcher contract
// already expects this latency budget.

import type { DispatchEpicMergeResult } from "./orchd-merge.ts";

/** Test-injection seam — production callers omit. */
export interface AutoMergeInvokerDeps {
  /** Spawn-and-wait. Returns `{exitCode, stdout, stderr}`. Default uses
   *  `Bun.spawn` against `atmux` on PATH. */
  spawnEpicMergeTick?: (
    teamDir: string,
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** Optional logger. Defaults to console-shape no-op. */
  log?: (msg: string) => void;
}

/**
 * Invoke the in-cage epic-merge tick for the current epic-team. Maps
 * the subprocess outcome to the DispatchEpicMergeResult shape the
 * auto-merge handler consumes.
 *
 * Result mapping:
 *   - exit 0 + stdout contains `merger_state.state=merged` →
 *     `{state: "merged", parentBase, mergeSha}` (parsed from stdout
 *     hints). When parse fails, fall back to a generic merged result
 *     with parentBase/mergeSha placeholders — caller's emit logs the
 *     epicId regardless.
 *   - exit 0 + no merge indicator → `{state: "skipped-not-mine",
 *     reason: "gate-held or no-op tick"}`.
 *   - exit non-zero → `{state: "gate-held", reason}` so the handler
 *     emits epic.merge-blocked (operator-observable, no retry storm).
 */
export async function invokeAutoMergeInCage(
  teamDir: string,
  deps: AutoMergeInvokerDeps = {},
): Promise<DispatchEpicMergeResult> {
  const spawnFn = deps.spawnEpicMergeTick ?? defaultSpawnEpicMergeTick;
  const log = deps.log ?? ((): void => undefined);

  let result: { exitCode: number; stdout: string; stderr: string };
  try {
    result = await spawnFn(teamDir);
  } catch (e) {
    const reason = `invokeAutoMergeInCage: spawn failed — ${e instanceof Error ? e.message : String(e)}`;
    log(reason);
    return { state: "gate-held", reason };
  }

  log(
    `invokeAutoMergeInCage: teamDir=${teamDir} exit=${result.exitCode} stdoutTail=${result.stdout.slice(-200)}`,
  );

  if (result.exitCode !== 0) {
    const tail = (result.stderr || result.stdout).trim().slice(-300);
    return {
      state: "gate-held",
      reason: `atmux epic-merge tick exit=${result.exitCode}: ${tail}`,
    };
  }

  // Success branch: detect whether the tick actually merged (vs. gate-
  // held / no-op). The verb logs `merger_state.state=merged` on
  // successful merge per merger_state.ts conventions. When we can't
  // confirm a merge happened, return skipped-not-mine so the handler
  // doesn't emit a phantom epic.merged event.
  if (/state=merged\b|→ merged\b|MERGED/i.test(result.stdout)) {
    const parentBase = extractParentBase(result.stdout) ?? "";
    const mergeSha = extractMergeSha(result.stdout) ?? "";
    return { state: "merged", parentBase, mergeSha };
  }
  return {
    state: "skipped-not-mine",
    reason: "epic-merge tick ran clean (exit 0) but no merge indicator in stdout — gate-held or no-op",
  };
}

/** Try to extract `parentBase=<branch>` hint from the tick's stdout. */
function extractParentBase(stdout: string): string | null {
  const m = stdout.match(/parentBase[=:]\s*([^\s,;]+)/);
  return m?.[1] ?? null;
}

/** Try to extract `mergeSha=<sha>` hint from the tick's stdout. */
function extractMergeSha(stdout: string): string | null {
  const m = stdout.match(/mergeSha[=:]\s*([0-9a-f]{7,40})/i);
  return m?.[1] ?? null;
}

/** Default subprocess spawn. Uses Bun's process API for buffered
 *  stdio capture — the verb writes one structured line per state-
 *  machine transition; we collect stdout + stderr fully and inspect
 *  on completion. */
async function defaultSpawnEpicMergeTick(
  teamDir: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn({
    cmd: ["atmux", "epic-merge", "tick", "--team-dir", teamDir],
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [stdoutBuf, stderrBuf] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const exitCode = await child.exited;
  return { exitCode, stdout: stdoutBuf, stderr: stderrBuf };
}
