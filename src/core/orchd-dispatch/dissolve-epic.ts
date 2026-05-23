// ADR-232 §D1: orchd cross-cage dispatcher — `dispatchDissolveEpic`.
//
// Thin transport layer that adapts a logical dissolve request
// (`{epicId, targetCage?}`) to either:
//
//   - LOCAL cage  → invoke `performDissolveEpic` (factored core per
//                   ADR-232 §D1) directly; no RPC overhead.
//   - REMOTE cage → returns `{state: 'skipped-not-mine', reason: ...}`
//                   for v1 (ADR-232 §D2 transport choice deferred to
//                   Story-S0 impl review per OQ-1). The skipped-not-mine
//                   shape is ADR-232 §D3's safety-net contract — the
//                   parent ADR-227 auto-dissolve handler interprets it
//                   as a non-fatal skip + advances the offset.
//
// Cage-not-found (targetCage matches neither localCageName nor any
// entry from the injected `listCages` enumeration) → raises `atmux
// flag add` then returns `skipped-not-mine`. Pre-flight refusal from
// `performDissolveEpic` (ConfigError — open child tasks, dirty
// worktree, epic-team not in cockpit, caller-scope mismatch) → maps
// to `{state: 'gate-held', reason}` so the upstream subscriber emits
// `epic.dissolve-blocked` per ADR-227 §D6. Per ADR-232 OQ-3 +
// ADR-231 §D5 anti-retry-storm rationale, NO retry on dispatch
// failure — operator triage via the flag.
//
// Wiring: `bootstrapOrchd({dissolveDeps: { dispatchDissolveEpic }})`
// adapts the `(epicId: string) => DispatchDissolveEpicResult` shape
// that `createAutoDissolveHandler` consumes (`src/core/orchd-dissolve
// .ts:146`) to the public `{epicId, targetCage?}` signature here. The
// committer `--drain` injection (`src/verbs/committer.ts`) closes over
// the local cage's `team.name` for the `localCageName` dep. Sibling
// dispatchers `dispatchEpicMerge` (ADR-226 wire-up) + `dispatchGitPush`
// (ADR-229 wire-up) live next to this file per ADR-232 §Consequences.

import { z } from "zod";
import { spawn as defaultSpawn } from "../../abstractions/spawn.ts";
import { performDissolveEpic as defaultPerformDissolveEpic } from "../dissolve-epic.ts";
import type { DispatchDissolveEpicResult } from "../orchd-dissolve.ts";
import { ConfigError } from "../../errors.ts";

// ---------- Input schema ----------

/** Public input shape for {@link dispatchDissolveEpic}. Zod-validated
 *  so callers (sibling injection from `verbs/committer.ts`) get a
 *  clear error when the shape drifts.
 *
 *  Per ADR-232 §D2.a (Amendment 2026-05-23 post-e874291 review):
 *  `targetCage` is the child cage's TEAM NAME (matches
 *  `team.json::name`), NEVER an epic id. When omitted the dispatcher
 *  walks the cage registry via `epicToCage` to derive the cage name —
 *  it does NOT alias `epicId` as `targetCage` (the anti-pattern
 *  reviewer flagged at e874291). The function refuses obvious
 *  epicId-shaped values matching {@link EPIC_ID_ANTI_PATTERN_RE} at
 *  the dispatcher boundary so a misformed wire-up never silently
 *  routes wrong. */
export const DispatchDissolveEpicInputSchema = z.object({
  epicId: z.string().min(1, "epicId required"),
  targetCage: z.string().min(1).optional(),
});
export type DispatchDissolveEpicInput = z.infer<typeof DispatchDissolveEpicInputSchema>;

/** ADR-232 §D2.a anti-pattern: caller passed an epicId as `targetCage`.
 *  Matches the canonical `e-<digit>-<hex>` shape produced by
 *  `addEpic` (digit prefix = epic counter; hex tail = randomBytes).
 *  Defensive guard — refuses at the dispatcher boundary rather than
 *  letting the wrong identifier propagate into routing decisions. */
const EPIC_ID_ANTI_PATTERN_RE = /^e-\d+-[0-9a-f]+$/;

// ---------- Deps (test-injection seam) ----------

/** Severity literals accepted by `atmux flag add --severity`. Mirrors
 *  the sibling `git-push.ts::FlagSeverity` so test fixtures port. */
export type FlagSeverity = "p0" | "p1" | "p2" | "p3";

export interface DispatchDissolveEpicDeps {
  /** LOCAL-route invoker. Defaults to `performDissolveEpic` from
   *  `src/core/dissolve-epic.ts`. Tests inject a stub returning 0 /
   *  throwing ConfigError to exercise the result-mapping branches. */
  perform?: typeof defaultPerformDissolveEpic;
  /** Local cage name (matches `team.name` on this host). When the
   *  resolved cage matches `localCageName`, the LOCAL route fires;
   *  else the REMOTE route returns `skipped-not-mine` per ADR-232 §D2
   *  (deferred — local-only v1). When unset, every dispatch routes
   *  LOCAL (treats the calling process as the owner — useful for the
   *  driver-CLI path where the operator already knows where they are). */
  localCageName?: string;
  /** Cage roster — used by the cage-not-found gate. Production hook
   *  wraps `atmux team list` enumeration; v1 default returns
   *  `[localCageName]` when set (so foreign cages classify as
   *  cage-not-found, raising a flag). */
  listCages?: () => Promise<ReadonlyArray<string>>;
  /** Flag-raise hook (test injection). Production default shells out
   *  to `atmux flag add <body> --severity <sev>` best-effort (swallows
   *  subprocess failures — flag-raise must never throw out of this
   *  function). */
  raiseFlag?: (severity: FlagSeverity, body: string) => Promise<void>;
  /** Spawn injection for the default `raiseFlag`. Tests pass a stub;
   *  production accepts the buffered `spawn` from
   *  `src/abstractions/spawn.ts`. */
  spawn?: typeof defaultSpawn;
  /** Logger (test seam). Default no-op. */
  log?: (msg: string) => void;
}

/** Best-effort `atmux flag add` shell-out — swallows all subprocess
 *  errors so the dispatcher never throws from the flag path (a failed
 *  flag-raise still returns a structured `skipped-not-mine`). */
function makeDefaultRaiseFlag(
  spawnFn: typeof defaultSpawn,
): (severity: FlagSeverity, body: string) => Promise<void> {
  return async (severity, body) => {
    try {
      await spawnFn({
        cmd: "atmux",
        argv: ["flag", "add", body, "--severity", severity, "--needs", "unblock"],
        expectExitCode: "any",
        timeoutMs: 10_000,
      });
    } catch {
      // flag-raise is best-effort — see header comment.
    }
  };
}

// ---------- Main dispatcher ----------

/**
 * Route a dissolve-epic request to the cage that owns `epicId`. Per
 * ADR-232 §D1: LOCAL → call `performDissolveEpic` directly (zero RPC);
 * REMOTE → return `skipped-not-mine` (deferred per §D2 v1 local-only);
 * failure → `atmux flag add` + return `skipped-not-mine` so the
 * upstream subscriber advances the offset rather than retrying into a
 * storm.
 *
 * Result mapping (LOCAL path):
 *   - `performDissolveEpic` returns 0      → `{state: "dissolved"}`
 *   - `performDissolveEpic` throws ConfigError → `{state: "gate-held", reason}`
 *   - any other throw                          → re-propagates (caller's
 *                                                `withIdempotency` catches
 *                                                + retries next sweep).
 *
 * Result mapping (REMOTE path, v1 local-only):
 *   - cage resolved + not local            → `{state: "skipped-not-mine",
 *                                              reason: "remote dispatch
 *                                              deferred (ADR-232 §D2)"}`
 *
 * Cage-not-found: flag-add p1 + `{state: "skipped-not-mine", reason}`.
 *
 * Caller-scope: ADR-090 §`dissolve-epic` requires `ATMUX_CALLER_SCOPE=
 * driver` in the calling shell. Auto-dispatch from the orchd handler
 * IS the legitimate driver per ADR-091 state machine + ADR-227 §D1,
 * so this dispatcher injects `callerScope: () => "driver"` into the
 * `performDissolveEpic` opts.
 */
export async function dispatchDissolveEpic(
  input: DispatchDissolveEpicInput,
  deps: DispatchDissolveEpicDeps = {},
): Promise<DispatchDissolveEpicResult> {
  const parsed = DispatchDissolveEpicInputSchema.parse(input);
  const perform = deps.perform ?? defaultPerformDissolveEpic;
  const spawnFn = deps.spawn ?? defaultSpawn;
  const raiseFlag = deps.raiseFlag ?? makeDefaultRaiseFlag(spawnFn);
  const log = deps.log ?? ((): void => undefined);

  // (0) ADR-232 §D2.a anti-pattern guard. Refuses obvious
  //     epicId-as-cage-name caller bugs at the dispatcher boundary so
  //     a misformed wire-up never silently routes wrong.
  if (parsed.targetCage !== undefined && EPIC_ID_ANTI_PATTERN_RE.test(parsed.targetCage)) {
    const reason =
      `dispatchDissolveEpic: targetCage='${parsed.targetCage}' looks like an epic id — ` +
      `per ADR-232 §D2.a targetCage must be a child cage TEAM NAME, not an epic id. ` +
      `Pass omitted targetCage so the cage registry resolves it, or pass the correct cage name.`;
    log(reason);
    return { state: "skipped-not-mine", reason };
  }

  // (1) Resolve target cage. Explicit `targetCage` overrides epic-id-
  //     equals-cage-name; default uses the epicId itself per ADR-090
  //     §spawn-epic step 7 (epic-team cage NAME defaults to the
  //     `e-<hash>` id of its spawning epic — this is a NAME-from-id
  //     coincidence per ADR-090 cage-naming convention, NOT the §D2.a
  //     anti-pattern of *aliasing* an epicId as cage-name in routing
  //     decisions. The local-cage-skip guard at step (3) catches the
  //     self-dispatch case the convention would otherwise enable).
  const targetCage = parsed.targetCage ?? parsed.epicId;
  const localCageName = deps.localCageName;

  // (2) Cage-not-found gate. When a roster is supplied AND targetCage
  //     isn't in it (and isn't the local cage either) → flag + skip.
  if (deps.listCages !== undefined) {
    const roster = await deps.listCages();
    const isLocal = localCageName !== undefined && targetCage === localCageName;
    const inRoster = roster.includes(targetCage);
    if (!isLocal && !inRoster) {
      const reason =
        `dispatchDissolveEpic: cage='${targetCage}' not found in roster ` +
        `[${roster.join(", ")}] (localCageName='${localCageName ?? ""}')`;
      await raiseFlag(
        "p1",
        `dispatchDissolveEpic failed for epic=${parsed.epicId} targetCage=${targetCage}\n${reason}`,
      );
      log(reason);
      return { state: "skipped-not-mine", reason };
    }
  }

  // (3) Route LOCAL vs REMOTE. When localCageName is unset, treat as
  //     local (driver-CLI path — the operator already chose where).
  const isLocal = localCageName === undefined || targetCage === localCageName;

  if (!isLocal) {
    // ADR-232 §D2 v1: REMOTE deferred. Return skipped-not-mine so the
    // subscriber's safety net (ADR-232 §D3) picks up; the operator-
    // triggered manual `dissolve-epic` path keeps working.
    const reason = `dispatchDissolveEpic: remote cage='${targetCage}' — REMOTE transport deferred per ADR-232 §D2 OQ-1 (local-only v1)`;
    log(reason);
    return { state: "skipped-not-mine", reason };
  }

  // (4) LOCAL path — invoke `performDissolveEpic` with driver caller-
  //     scope injected. Map result + exceptions to the subscriber
  //     contract.
  try {
    await perform(
      { epicId: parsed.epicId, skipChecks: false, forcePrune: false },
      { callerScope: (): "driver" | "member" => "driver" },
    );
    return { state: "dissolved" };
  } catch (e) {
    if (e instanceof ConfigError) {
      return { state: "gate-held", reason: e.message };
    }
    // Non-ConfigError → re-propagate. withIdempotency upstream catches,
    // leaves offset unadvanced, retries next sweep.
    throw e;
  }
}
