// ADR-232 §D1 — `dispatchEpicMerge` cross-cage dispatcher seam.
//
// Routes an `epicId` to the cage that owns the merge target and runs
// the merge locally (zero-RPC) or dispatches the request to a remote
// cage's orchd per ADR-202 §IX-A lean-dispatch contract (Bun
// subprocess + tmux send-keys per §D2 path A — OQ-1 transport choice
// deferred). On dispatch failure surfaces `atmux flag add` so the
// operator picks up a stuck epic before its kanban rots.
//
// Subscriber-facing contract: matches `DispatchEpicMergeResult` from
// `src/core/orchd-merge.ts` (the auto-merge handler's injection seam,
// per ADR-226). Wiring this dispatcher in turns the handler's
// stubbed-default `skipped-not-mine` into real routing while ADR-232
// §D3's fallback guard preserves the safety net if dispatch fails.
//
// Scope (S0, v1): the LOCAL route invokes `performEpicMerge` via an
// `invokeLocal` hook that the caller supplies — the full
// `EpicMergeContext` assembly lives in `verbs/epic-merge.ts` (db open,
// `MergerStateRepo`, gate-fact resolution, test-gate hook wiring) and
// pulling it into `src/core/` would invert the verb → core layering
// per the layering note in `src/core/orchd-merge.ts:182-193`. The
// REMOTE route default spawns a placeholder `atmux orchd --handle-one`
// subprocess in the target cage's root; transport refinement (path A
// Bun subprocess vs path B cockpit-mirror Rust) lands in a follow-up
// Task per ADR-232 OQ-1.

import { z } from "zod";
import { spawn as defaultSpawn, type SpawnResult } from "../../abstractions/spawn.ts";
import type { PerformEpicMergeResult } from "../epic-merge.ts";
import type { DispatchEpicMergeResult } from "../orchd-merge.ts";

// ---------- Zod schemas (AC: function exported + Zod-validated input/output) ----------

/** Input shape for {@link dispatchEpicMerge}. `targetCage` lets the
 *  caller override the registry lookup — useful when the caller already
 *  knows the cage (e.g. an explicit `atmux orchd dispatch` invocation
 *  from the operator) and wants to skip the resolution probe. */
export const DispatchEpicMergeInputSchema = z.object({
  epicId: z.string().min(1),
  targetCage: z.string().min(1).optional(),
});

export type DispatchEpicMergeInput = z.infer<typeof DispatchEpicMergeInputSchema>;

/** Output shape mirrors `DispatchEpicMergeResult` from
 *  `src/core/orchd-merge.ts:45` verbatim — keeping the discriminated
 *  union in lockstep means the subscriber switch in
 *  `createAutoMergeHandler` consumes our return without an adapter.
 *  Sibling EPICs (`dispatchDissolveEpic`, `dispatchGitPush`) re-use
 *  this pattern with their own per-subscriber result type. */
export const DispatchEpicMergeResultSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("merged"),
    parentBase: z.string(),
    mergeSha: z.string(),
  }),
  z.object({ state: z.literal("merge-conflict"), reason: z.string() }),
  z.object({ state: z.literal("gate-held"), reason: z.string() }),
  z.object({ state: z.literal("already-merged") }),
  z.object({
    state: z.literal("skipped-not-mine"),
    reason: z.string().optional(),
  }),
]);

// ---------- Cage info + per-route deps ----------

/** Metadata for a single cage (epic-team or parent). Surfaced from the
 *  cage-resolution hook so downstream routing logic + the
 *  `mapLocalResult` helper have everything they need without re-
 *  reading the registry. */
export interface CageInfo {
  /** Cage / epic-team name (equals `epicId` for spawn-epic'd cages per
   *  ADR-090 §spawn-epic step 7 — the cage's `team.name` is the
   *  epicId). */
  name: string;
  /** Absolute path to the cage's project root (`team.epicTeam` cage's
   *  worktree, NOT the parent's worktree). */
  root: string;
  /** Parent base branch (ADR-090 `epicTeam.parentBase`). Needed to
   *  surface in the `merged` result variant. */
  parentBase: string;
}

/** Result of one remote-dispatch attempt. `ok=true` means the dispatch
 *  message was emitted successfully — the actual merge runs async on
 *  the remote cage; `epic.merged` flows back via the normal event
 *  stream. `ok=false` means we couldn't even get the message out; the
 *  dispatcher escalates via `flagAdd`. */
export interface RemoteAckResult {
  ok: boolean;
  /** Last ≤500 chars of stderr from the dispatch transport. Folded
   *  into the flag body so the operator has the receipt without
   *  spelunking logs. */
  stderrTail?: string;
}

/** Side-effecting fields the dispatcher hands to the `flagAdd` hook on
 *  failure paths. Mirrors the `atmux flag add` argv surface. */
export interface FlagAddInput {
  epicId: string;
  targetCage: string;
  stderrTail: string;
}

// ---------- Injectable deps ----------

export interface DispatchEpicMergeDeps {
  /** Resolve the cage that owns `epicId`. Returns `null` when no cage
   *  in the registry matches — the dispatcher then escalates via
   *  `flagAdd`. Default reads the local team's state.db for an Epic
   *  row whose `epicTeamName` matches; production wire-up should pass
   *  a real registry walker. */
  resolveCage?: (epicId: string) => Promise<CageInfo | null>;
  /** Returns `true` iff `cage` is the LOCAL cage. Default compares
   *  `cage.root` against `process.cwd()`'s ancestor chain via simple
   *  prefix match. Production wire-up should pass a real
   *  `team.json`-aware comparator. */
  isLocalCage?: (cage: CageInfo) => boolean;
  /** LOCAL-route invoker: builds `EpicMergeContext` + calls
   *  `performEpicMerge`. **Required for the LOCAL route to merge.**
   *  When absent + LOCAL path taken, the dispatcher returns
   *  `gate-held` with a clear reason. The verb layer
   *  (`verbs/epic-merge.ts`) owns the context-assembly helper and
   *  passes it here at wire-up time per ADR-232 §D1 (layering: the
   *  dispatcher stays in `src/core/`; verb assembly stays in
   *  `src/verbs/`). */
  invokeLocal?: (epicId: string, cage: CageInfo) => Promise<PerformEpicMergeResult>;
  /** REMOTE-route transport: ferries the merge request to the target
   *  cage's orchd. Default spawns `atmux orchd --handle-one ...` Bun
   *  subprocess in `cage.root` per ADR-202 §IX-A lean-dispatch path A
   *  (ADR-232 §D2). Transport refinement deferred per OQ-1. */
  dispatchRemote?: (epicId: string, cage: CageInfo) => Promise<RemoteAckResult>;
  /** Escalation hook: fires `atmux flag add` on cage-not-found OR
   *  remote-dispatch failure. Default spawns the verb; tests stub. */
  flagAdd?: (input: FlagAddInput) => Promise<void>;
  /** Spawn injection for the default `dispatchRemote` + `flagAdd`
   *  implementations. Tests pass a stub; production accepts the
   *  buffered `spawn` from `src/abstractions/spawn.ts`. */
  spawn?: typeof defaultSpawn;
}

// ---------- Main dispatcher ----------

/**
 * Route a merge request to the cage that owns `epicId`. Per ADR-232
 * §D1: LOCAL → call `performEpicMerge` directly (zero RPC); REMOTE →
 * dispatch to the target cage's orchd per §D2 path A; failure →
 * `atmux flag add` + return `gate-held` so the upstream subscriber
 * escalates per ADR-226 handler's `merge-blocked` emit path.
 *
 * Result mapping (LOCAL path):
 *   - `performEpicMerge` → `merged` (with SHA)  → `{ merged, parentBase, mergeSha }`
 *   - `performEpicMerge` → `merged` (no-op SHA) → `{ already-merged }`
 *   - `performEpicMerge` → `conflict`           → `{ merge-conflict, reason }`
 *   - everything else (in-flight / gate held)   → `{ gate-held, reason }`
 *
 * Result mapping (REMOTE path):
 *   - dispatch ok=true  → `{ skipped-not-mine, reason: "dispatched to <cage>" }`
 *     (local handler steps back; remote cage emits `epic.merged` when
 *     its own performEpicMerge finishes — ADR-232 §D3 fallback guard).
 *   - dispatch ok=false → flag-add + `{ gate-held, reason: "..." }`.
 *
 * Cage-not-found: flag-add + `{ gate-held, reason: "..." }`. The
 * subscriber's `merge-blocked` emit gives the operator a Discord ping
 * to fix the registry.
 */
export async function dispatchEpicMerge(
  input: DispatchEpicMergeInput,
  deps: DispatchEpicMergeDeps = {},
): Promise<DispatchEpicMergeResult> {
  const parsed = DispatchEpicMergeInputSchema.parse(input);
  const spawnFn = deps.spawn ?? defaultSpawn;
  const resolve = deps.resolveCage ?? defaultResolveCage;
  const isLocal = deps.isLocalCage ?? defaultIsLocalCage;
  const remoteDispatch = deps.dispatchRemote ?? makeDefaultDispatchRemote(spawnFn);
  const flagAdd = deps.flagAdd ?? makeDefaultFlagAdd(spawnFn);

  // (1) Resolve cage. Explicit `targetCage` short-circuits the registry
  //     walk — operator supplied the cage; the dispatcher trusts it
  //     (synthesise a CageInfo with empty root + parentBase, since the
  //     LOCAL branch's mapping needs parentBase; cage-name-only
  //     overrides force the REMOTE path).
  let cage: CageInfo | null;
  if (parsed.targetCage !== undefined) {
    cage = { name: parsed.targetCage, root: "", parentBase: "" };
  } else {
    cage = await resolve(parsed.epicId);
  }

  if (cage === null) {
    const reason = `cage not found for epic ${parsed.epicId} — registry walk returned no match`;
    await flagAdd({
      epicId: parsed.epicId,
      targetCage: "(unresolved)",
      stderrTail: reason,
    });
    return DispatchEpicMergeResultSchema.parse({ state: "gate-held", reason });
  }

  // (2) Route LOCAL vs REMOTE. Explicit overrides (empty root +
  //     parentBase) force REMOTE — there's no local context to merge
  //     against, so trusting the operator's "ship it remote" intent is
  //     the safe call.
  const local = cage.root.length > 0 && isLocal(cage);

  if (local) {
    if (deps.invokeLocal === undefined) {
      const reason =
        `local invoker not wired for ${cage.name} — verbs/epic-merge.ts owns the EpicMergeContext assembly; ` +
        `pass deps.invokeLocal at wire-up time`;
      // Not a flag-add condition — wire-up gap, not a routing failure.
      // The gate-held return escalates via the subscriber's
      // epic.merge-blocked emit so the operator notices the missing
      // wire-up at the next epic.merged-expecting event.
      return DispatchEpicMergeResultSchema.parse({ state: "gate-held", reason });
    }
    const localResult = await deps.invokeLocal(parsed.epicId, cage);
    return DispatchEpicMergeResultSchema.parse(mapLocalResult(localResult, cage));
  }

  // (3) REMOTE path — dispatch + ack.
  const ack = await remoteDispatch(parsed.epicId, cage);
  if (!ack.ok) {
    const stderrTail = ack.stderrTail ?? "(no stderr captured)";
    await flagAdd({
      epicId: parsed.epicId,
      targetCage: cage.name,
      stderrTail,
    });
    const reason = `remote dispatch to cage ${cage.name} failed: ${stderrTail}`;
    return DispatchEpicMergeResultSchema.parse({ state: "gate-held", reason });
  }
  // Success — remote cage will run performEpicMerge there and emit
  // `epic.merged` itself. Local handler returns `skipped-not-mine` so
  // the subscriber does NOT emit a duplicate event (per ADR-226 handler
  // switch case for `skipped-not-mine` → no emit).
  return DispatchEpicMergeResultSchema.parse({
    state: "skipped-not-mine",
    reason: `dispatched to remote cage ${cage.name}`,
  });
}

// ---------- Result mapping (LOCAL path) ----------

/** Translate a `PerformEpicMergeResult` from `performEpicMerge` into
 *  the subscriber-facing `DispatchEpicMergeResult`. Pure — no I/O.
 *  ADR-232 §D3 fallback note: states the dispatcher cannot meaningfully
 *  map (e.g. `rebasing`, `merging` mid-flight) fall through to
 *  `gate-held` so the subscriber's `merge-blocked` emit gives the
 *  operator visibility rather than silently dropping. */
export function mapLocalResult(
  r: PerformEpicMergeResult,
  cage: CageInfo,
): DispatchEpicMergeResult {
  if (r.state === "merged") {
    // `mergedSha` set when there were commits to fan in; absent when
    // the merge was a no-op (HEAD === parentBase already, per
    // epic-merge.ts:865-870). No-op-merge maps to `already-merged`
    // since the handler should not re-emit `epic.merged` (no fresh
    // SHA to publish).
    if (r.mergedSha !== undefined && r.mergedSha.length > 0) {
      return {
        state: "merged",
        parentBase: cage.parentBase,
        mergeSha: r.mergedSha,
      };
    }
    return { state: "already-merged" };
  }
  if (r.state === "conflict") {
    return { state: "merge-conflict", reason: r.reason };
  }
  // open / in_progress / ready_to_merge / rebasing / merging / tested /
  // test_failed — all surface as gate-held so the subscriber emits
  // epic.merge-blocked with the reason. `epic-merge` cron's next tick
  // re-evaluates the row's state.
  return { state: "gate-held", reason: r.reason };
}

// ---------- Default cage-resolution ----------

/** Default `resolveCage` — placeholder that returns `null` (forcing
 *  the caller to inject a real registry walker). Production wire-up
 *  passes a closure that reads parent's `state.db` Epic rows for
 *  `epicTeamName === <epicId>` per ADR-090 §spawn-epic step 9. The
 *  registry-walker default is deliberately omitted from `src/core/`
 *  to keep this module dep-free of `KanbanRepo` / `openDatabase` —
 *  those imports belong at the verb layer where the `atmuxDir` is
 *  already in scope. */
async function defaultResolveCage(_epicId: string): Promise<CageInfo | null> {
  return null;
}

/** Default `isLocalCage` — compares `cage.root` to `process.cwd()`
 *  prefix-style. Returns `true` when the cage root is the current
 *  process's cwd or an ancestor (the orchd daemon's cwd is the cage
 *  root per `src/core/orchd-window.ts:163`). Production wire-up may
 *  pass a stricter comparator that resolves symlinks. */
function defaultIsLocalCage(cage: CageInfo): boolean {
  if (cage.root.length === 0) return false;
  const cwd = process.cwd();
  return cwd === cage.root || cwd.startsWith(`${cage.root}/`);
}

// ---------- Default remote-dispatch transport (ADR-202 §IX-A path A) ----------

/** Build the default `dispatchRemote` hook bound to a spawn impl.
 *  Spawns `atmux orchd --handle-one --topic epic.merge-request
 *  --epic-id <id>` with `cwd = cage.root` so the receiving orchd in
 *  that cage picks up the request in its own context. The handler-one
 *  receiver topic + arg surface is a transport detail (OQ-1 may
 *  collapse this into cockpit-mirror Rust direct call); the
 *  dispatcher's contract is "fire and observe ack/error", not "drive
 *  the receiver's argv surface". */
function makeDefaultDispatchRemote(
  spawnFn: typeof defaultSpawn,
): (epicId: string, cage: CageInfo) => Promise<RemoteAckResult> {
  return async (epicId, cage) => {
    let result: SpawnResult;
    try {
      result = await spawnFn({
        cmd: "atmux",
        argv: [
          "orchd",
          "--handle-one",
          "--topic",
          "epic.merge-request",
          "--epic-id",
          epicId,
        ],
        cwd: cage.root,
        expectExitCode: "any",
        timeoutMs: 30_000,
      });
    } catch (e) {
      return {
        ok: false,
        stderrTail: `spawn threw: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (result.exitCode === 0) return { ok: true };
    return {
      ok: false,
      stderrTail: tail500(result.stderr || result.stdout),
    };
  };
}

// ---------- Default flag-add escalation ----------

/** Build the default `flagAdd` hook bound to a spawn impl. Fires
 *  `atmux flag add` with severity p1 + needs=unblock — surface on the
 *  team-lead pane so the operator routes to the right owner. The flag
 *  body carries the epicId + target cage + stderr tail so the receiver
 *  has the full receipt. */
function makeDefaultFlagAdd(
  spawnFn: typeof defaultSpawn,
): (input: FlagAddInput) => Promise<void> {
  return async (input) => {
    const body =
      `dispatchEpicMerge failed for epic=${input.epicId} ` +
      `targetCage=${input.targetCage}\n` +
      `stderr tail:\n${input.stderrTail}`;
    try {
      await spawnFn({
        cmd: "atmux",
        argv: ["flag", "add", body, "--severity", "p1", "--needs", "unblock"],
        expectExitCode: "any",
        timeoutMs: 10_000,
      });
    } catch {
      // flagAdd is a best-effort side effect — the dispatcher's return
      // already escalates via gate-held + the subscriber's merge-
      // blocked emit, so swallowing a flag-add failure does NOT silence
      // the operator. Stderr-write here would dirty the orchd log
      // without giving the operator any new actionable info beyond the
      // already-emitted event.
    }
  };
}

// ---------- helpers ----------

function tail500(s: string): string {
  if (s.length <= 500) return s;
  return s.slice(-500);
}
