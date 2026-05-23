// ADR-232 §D1: orchd cross-cage dispatcher — `dispatchGitPush`.
//
// Thin transport layer that adapts a logical push request
// (`{cage, branch, remote?}`) to either:
//
//   - LOCAL cage  → `git push <remote> <branch>` via the shared
//                   `GitSpawn` abstraction (mirrors `auto-push.ts`
//                   pattern: fetch → upstream-advanced check → push).
//   - REMOTE cage → returns `{state: 'skipped-not-mine', reason: ...}`
//                   for v1 (ADR-232 §D2 transport choice deferred to
//                   Story-S0 impl review per OQ-1). The skipped-not-mine
//                   shape is ADR-232 §D3's safety-net contract — the
//                   parent ADR-229 auto-push handler interprets it as a
//                   non-fatal skip + advances the offset.
//
// Cage-not-found (cage param matches neither local nor any entry from
// the injected `listCages` enumeration) → raises `atmux flag add` then
// returns `skipped-not-mine`. Push rejection (non-zero `git push`
// exit) → same pattern. Per ADR-232 OQ-3 + ADR-231 §D5 anti-retry-
// storm rationale, NO retry — operator triage via the flag.
//
// Wiring (this Epic): `bootstrapOrchd({pushDeps: { dispatchGitPush }})`
// closes over the local cage's `team.name`; the inner injection adapts
// the `(parentBase: string) => DispatchGitPushResult` shape that
// `createAutoPushHandler` consumes (`src/core/orchd-push.ts:174`) to
// the public `{cage, branch}` signature here. Sibling dispatchers
// (`dispatchEpicMerge`, `dispatchDissolveEpic`) live in the same
// `src/core/orchd-dispatch/` directory per ADR-232 §Consequences.

import { z } from "zod";
import { spawn as defaultSpawn } from "../../abstractions/spawn.ts";
import { defaultGitSpawn, type GitSpawn } from "../../abstractions/worktree.ts";
import type { DispatchGitPushResult } from "../orchd-push.ts";

// ---------- Input schema ----------

/** Public input shape for {@link dispatchGitPush}. Zod-validated so
 *  callers (sibling-injection from `orchd-bootstrap.ts`) get a clear
 *  error when the shape drifts. `remote` defaults to `'origin'` at
 *  function-body resolution; not in the schema so callers can omit. */
export const DispatchGitPushInputSchema = z.object({
  cage: z.string().min(1, "cage required"),
  branch: z.string().min(1, "branch required"),
  remote: z.string().min(1).optional(),
});
export type DispatchGitPushInput = z.infer<typeof DispatchGitPushInputSchema>;

// ---------- Deps (test-injection seam) ----------

/** Severity literals accepted by `atmux flag add --severity`. Mirrors
 *  `auto-push.ts::AutoPushOpts.raiseFlag` so test fixtures port. */
export type FlagSeverity = "p0" | "p1" | "p2" | "p3";

export interface DispatchGitPushDeps {
  /** Git spawn override (test injection). Default: {@link defaultGitSpawn}. */
  git?: GitSpawn;
  /** Local cage name (matches `team.name` on this host). When
   *  `input.cage === localCageName`, the LOCAL route fires; else the
   *  REMOTE route returns `skipped-not-mine` per ADR-232 §D2 (deferred
   *  — local-only v1). */
  localCageName?: string;
  /** Cage roster — used by the cage-not-found gate. Production hook
   *  wraps `atmux team list` enumeration; v1 default returns
   *  `[localCageName]` when set (so foreign cages classify as
   *  cage-not-found, raising a flag). */
  listCages?: () => Promise<ReadonlyArray<string>>;
  /** Flag-raise hook (test injection). Production default shells out
   *  to `atmux flag add <body> --severity <sev>` best-effort
   *  (swallows subprocess failures — flag-raise must never throw out
   *  of this function). */
  raiseFlag?: (severity: FlagSeverity, body: string) => Promise<void>;
  /** Logger (test seam). Default no-op. */
  log?: (msg: string) => void;
}

/** Best-effort `atmux flag add` shell-out — swallows all subprocess
 *  errors so the dispatcher never throws from the flag path (a failed
 *  flag-raise still returns a structured `skipped-not-mine`). */
const defaultRaiseFlag = async (severity: FlagSeverity, body: string): Promise<void> => {
  try {
    await defaultSpawn({
      cmd: "atmux",
      argv: ["flag", "add", body, "--severity", severity],
      timeoutMs: 10_000,
      expectExitCode: "any",
    });
  } catch {
    /* best-effort — flag-raise failure is not a dispatcher failure */
  }
};

// ---------- Public API ----------

/**
 * Dispatch a `git push <remote> <branch>` for the named cage.
 *
 * - LOCAL cage (`input.cage === localCageName`):
 *   1. `git fetch <remote> <branch>` → on failure, flag + skipped-not-mine.
 *   2. `git rev-list --left-right --count HEAD...<remote>/<branch>` →
 *      if `behind > 0`, returns `upstream-advanced` (consumed by
 *      `orchd-push.ts` as Gate-1 conflict → `epic.push-conflict`).
 *   3. `git push <remote> <branch>` → success → `pushed` with
 *      headSha = post-push `git rev-parse HEAD`. Non-zero exit →
 *      flag + skipped-not-mine (NO retry per ADR-232 OQ-3).
 *
 * - REMOTE cage in roster: stub returns `skipped-not-mine` with reason
 *   `"remote-cage=... route not implemented (ADR-232 §D2 deferred)"`
 *   — local-only v1.
 *
 * - Cage not in roster: flag + skipped-not-mine with reason
 *   `"cage-not-found: <cage>"`.
 */
export async function dispatchGitPush(
  input: DispatchGitPushInput,
  deps: DispatchGitPushDeps = {},
): Promise<DispatchGitPushResult> {
  const parsed = DispatchGitPushInputSchema.parse(input);
  const git = deps.git ?? defaultGitSpawn;
  const remote = parsed.remote ?? "origin";
  const log = deps.log ?? (() => {});
  const raiseFlag = deps.raiseFlag ?? defaultRaiseFlag;
  const localCage = deps.localCageName;
  const listCages =
    deps.listCages ?? (async () => (localCage !== undefined ? [localCage] : []));

  // ---------- Route resolution ----------
  const cages = await listCages();
  const inRoster = cages.includes(parsed.cage);
  const isLocal = parsed.cage === localCage;

  if (!isLocal && !inRoster) {
    const body =
      `dispatchGitPush: cage='${parsed.cage}' not in roster (known: ${cages.join(",") || "<none>"}); ` +
      `branch=${parsed.branch} — refusing to dispatch`;
    await raiseFlag("p1", body);
    log(body);
    return { state: "skipped-not-mine", reason: `cage-not-found: ${parsed.cage}` };
  }

  if (!isLocal) {
    // REMOTE route — deferred per ADR-232 §D2 (transport choice OQ-1).
    const reason = `remote-cage='${parsed.cage}' route not implemented (ADR-232 §D2 deferred); local-only v1`;
    log(`dispatchGitPush: ${reason}`);
    return { state: "skipped-not-mine", reason };
  }

  // ---------- LOCAL route ----------

  // 1. Fetch remote/branch to refresh tracking ref.
  const fetchR = await git(["fetch", remote, parsed.branch]);
  if (fetchR.exitCode !== 0) {
    const stderrTail = fetchR.stderr.trim().slice(-500);
    const body = `dispatchGitPush: cage=${parsed.cage} branch=${parsed.branch} git fetch ${remote} ${parsed.branch} failed: ${stderrTail}`;
    await raiseFlag("p1", body);
    log(body);
    return { state: "skipped-not-mine", reason: `fetch-failed: ${stderrTail}` };
  }

  // 2. Upstream-advanced check via rev-list --left-right --count.
  //    Output shape: "<ahead>\t<behind>" (tab-separated).
  const revListR = await git([
    "rev-list",
    "--left-right",
    "--count",
    `HEAD...${remote}/${parsed.branch}`,
  ]);
  if (revListR.exitCode === 0) {
    const parts = revListR.stdout.trim().split(/\s+/);
    const aheadRaw = parts[0] ?? "0";
    const behindRaw = parts[1] ?? "0";
    const ahead = Number(aheadRaw);
    const behind = Number(behindRaw);
    if (Number.isFinite(behind) && behind > 0) {
      const mbR = await git(["merge-base", "HEAD", `${remote}/${parsed.branch}`]);
      const divergenceSha =
        mbR.exitCode === 0 ? mbR.stdout.trim() : "";
      const result: DispatchGitPushResult = {
        state: "upstream-advanced",
        ahead: Number.isFinite(ahead) ? ahead : 0,
        behind,
      };
      if (divergenceSha !== "") {
        return { ...result, divergenceSha };
      }
      return result;
    }
  }

  // 3. Push.
  const pushR = await git(["push", remote, parsed.branch]);
  if (pushR.exitCode !== 0) {
    const stderrTail = pushR.stderr.trim().slice(-500);
    const body = `dispatchGitPush: cage=${parsed.cage} branch=${parsed.branch} git push ${remote} ${parsed.branch} REJECTED: ${stderrTail}`;
    await raiseFlag("p1", body);
    log(body);
    return { state: "skipped-not-mine", reason: `push-rejected: ${stderrTail}` };
  }

  // 4. Resolve post-push head SHA (informational; orchd-push.ts emits
  //    epic.pushed with headSha).
  const headR = await git(["rev-parse", "HEAD"]);
  const headSha = headR.exitCode === 0 ? headR.stdout.trim() : "";
  return { state: "pushed", headSha };
}
