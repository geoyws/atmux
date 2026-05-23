// ADR-232 §D1 + §D2.a — `dispatchEpicMerge` cross-cage dispatcher seam.
//
// Routes an `epicId` to the cage that owns the merge target and runs
// the merge locally (zero-RPC) or dispatches the request to a remote
// cage's orchd per ADR-202 §IX-A lean-dispatch contract (Bun
// subprocess + tmux send-keys per §D2.b path A — OQ-1 transport
// choice deferred). On dispatch failure surfaces `atmux flag add` so
// the operator picks up a stuck epic before its kanban rots.
//
// **§D2.a routing semantics (Amendment 2026-05-23 post-c477954 review):**
// `targetCage` is the child cage's TEAM NAME (`team.json::name`), NEVER
// an epic id. Conflating the two collapses parent's committer into the
// dispatch path — a self-dispatch loop in cages whose `team.json::name`
// happens to equal an epic id (the common case for epic-teams spawned
// via `atmux team spawn-epic <epicId>` per ADR-090 which defaults
// team-name to the epicId). The local-cage-skip guard at step 2 of the
// dispatcher refuses to re-fire local logic when `targetCage ===
// localTeamName`; the anti-pattern guard at step 0 refuses obvious
// epicId-as-cage-name mistakes (`/^e-[0-9a-f]+-/` shape) so a
// misformed caller never silently routes wrong.
//
// Subscriber-facing contract: matches `DispatchEpicMergeResult` from
// `src/core/orchd-merge.ts` (the auto-merge handler's injection seam,
// per ADR-226). Wiring this dispatcher in turns the handler's stubbed
// default `skipped-not-mine` into real routing while ADR-232 §D3's
// fallback guard preserves the safety net if dispatch fails.
//
// Scope (S0, v1): the LOCAL route invokes `performEpicMerge` via an
// `invokeLocal` hook that the caller supplies — the full
// `EpicMergeContext` assembly lives in `verbs/epic-merge.ts` (db open,
// `MergerStateRepo`, gate-fact resolution, test-gate hook wiring) and
// pulling it into `src/core/` would invert the verb → core layering
// per the layering note in `src/core/orchd-merge.ts:182-193`. The
// committer.ts wire-up closes over the local team's epic-team config
// to build the closure inline. The REMOTE route default spawns a
// placeholder `atmux orchd --handle-one` subprocess in the target
// cage's root; transport refinement (path A Bun subprocess vs path B
// cockpit-mirror Rust) lands in a follow-up Task per ADR-232 OQ-1.

import { z } from "zod";
import { spawn as defaultSpawn, type SpawnResult } from "../../abstractions/spawn.ts";
import type { PerformEpicMergeResult } from "../epic-merge.ts";
import type { DispatchEpicMergeResult } from "../orchd-merge.ts";

// ---------- Zod schemas (AC: function exported + Zod-validated input/output) ----------

/** Input shape for {@link dispatchEpicMerge}. Per ADR-232 §D2.a
 *  `targetCage` is the child cage's TEAM NAME (matches `team.json::
 *  name`), NEVER an epic id. The function refuses obvious anti-pattern
 *  values (epicId-shaped strings matching `/^e-\d+-/`) — see
 *  {@link EPIC_ID_ANTI_PATTERN_RE} — to catch caller bugs at parse-
 *  time rather than silently routing wrong.
 *
 *  When `targetCage` is omitted the dispatcher walks `resolveCage` to
 *  derive the owning cage from `epicId`. */
export const DispatchEpicMergeInputSchema = z.object({
  epicId: z.string().min(1),
  targetCage: z.string().min(1).optional(),
});

export type DispatchEpicMergeInput = z.infer<typeof DispatchEpicMergeInputSchema>;

/** Output shape mirrors `DispatchEpicMergeResult` from
 *  `src/core/orchd-merge.ts:45` verbatim. Exported as a schema for
 *  callers that want to validate cross-layer payloads at boundaries
 *  (e.g. JSON ingest from a different process). The dispatcher itself
 *  does NOT `.parse()` its returns — output is already statically
 *  type-enforced by the function's return type, and the Zod parse
 *  adds `| undefined` to optional fields under
 *  `exactOptionalPropertyTypes:true`. Sibling EPICs
 *  (`dispatchDissolveEpic`, `dispatchGitPush`) follow the same
 *  pattern. */
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

/** ADR-232 §D2.a anti-pattern: caller passed an epicId as `targetCage`.
 *  Matches the canonical `e-<digit>-<hex>` shape produced by
 *  `addEpic` (digit prefix = epic counter; hex tail = randomBytes).
 *  Defensive guard — refuses at the dispatcher boundary rather than
 *  letting the wrong identifier propagate into routing decisions. */
const EPIC_ID_ANTI_PATTERN_RE = /^e-\d+-[0-9a-f]+$/;

// ---------- Cage info + per-route deps ----------

/** Metadata for a single cage (epic-team or parent). Surfaced from the
 *  cage-resolution hook so downstream routing logic + the
 *  `mapLocalResult` helper have everything they need without re-
 *  reading the registry. */
export interface CageInfo {
  /** Cage's TEAM NAME, matching `team.json::name`. For an epic-team
   *  spawned via `atmux team spawn-epic <epicId>`, this equals the
   *  epicId per ADR-090 §spawn-epic step 7 — but per ADR-232 §D2.a
   *  the dispatcher treats this field as a NAME not an epic id, and
   *  derives via `resolveCage` rather than aliasing the input epicId. */
  name: string;
  /** Absolute path to the cage's project root (the epic-team's
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
  /** ADR-232 §D2.a: the running cage's team name (matches
   *  `team.json::name`). When the resolved `cage.name === localTeamName`
   *  the dispatcher returns `skipped-not-mine` immediately — local impl
   *  already ran (or will run) via the in-cage handler before the
   *  dispatcher was invoked. When unset, the local-skip check is
   *  disabled (driver-CLI path where the operator already chose
   *  where they are). */
  localTeamName?: string;
  /** Resolve the cage that owns `epicId`. Returns `null` when no cage
   *  in the registry matches — the dispatcher then returns
   *  `skipped-not-mine` WITHOUT raising a flag (no-cage-found is the
   *  expected outcome when running in a normal team with no epic-team
   *  child; per ADR-232 §D2.a + §D3 the local handler's safety net
   *  picks up). Default returns `null`; production wire-up passes a
   *  closure that reads the local team config or parent's state.db. */
  resolveCage?: (epicId: string) => Promise<CageInfo | null>;
  /** Returns `true` iff `cage` is the LOCAL cage. Default compares
   *  `cage.name === localTeamName` per ADR-232 §D2.a (name-based, NOT
   *  path-based — paths drift across symlinks + worktree moves). */
  isLocalCage?: (cage: CageInfo) => boolean;
  /** LOCAL-route invoker: builds `EpicMergeContext` + calls
   *  `performEpicMerge`. **Required for the LOCAL route to merge.**
   *  When absent + LOCAL path taken, the dispatcher returns
   *  `skipped-not-mine` with a clear reason (NOT `gate-held` — wire-
   *  up gap shouldn't flag-spam the subscriber's epic.merge-blocked
   *  emit path). The verb layer (`verbs/epic-merge.ts`) owns the
   *  context-assembly helper and passes it here at wire-up time per
   *  ADR-232 §D1 (layering: the dispatcher stays in `src/core/`; verb
   *  assembly stays in `src/verbs/`). */
  invokeLocal?: (epicId: string, cage: CageInfo) => Promise<PerformEpicMergeResult>;
  /** REMOTE-route transport: ferries the merge request to the target
   *  cage's orchd. Default spawns `atmux orchd --handle-one ...` Bun
   *  subprocess in `cage.root` per ADR-202 §IX-A lean-dispatch path A
   *  (ADR-232 §D2.b). Transport refinement deferred per OQ-1. */
  dispatchRemote?: (epicId: string, cage: CageInfo) => Promise<RemoteAckResult>;
  /** Escalation hook: fires `atmux flag add` on remote-dispatch
   *  failure ONLY (per ADR-232 §D2.a NOT on cage-not-found — that
   *  path returns skipped-not-mine quietly so the subscriber's safety
   *  net handles it without operator noise). Default spawns
   *  `atmux flag add ...`; tests stub. */
  flagAdd?: (input: FlagAddInput) => Promise<void>;
  /** Spawn injection for the default `dispatchRemote` + `flagAdd`
   *  implementations. Tests pass a stub; production accepts the
   *  buffered `spawn` from `src/abstractions/spawn.ts`. */
  spawn?: typeof defaultSpawn;
}

// ---------- Main dispatcher ----------

/**
 * Route a merge request to the cage that owns `epicId`. Per ADR-232
 * §D1 + §D2.a: LOCAL → call `performEpicMerge` directly (zero RPC);
 * REMOTE → dispatch to the target cage's orchd per §D2.b path A;
 * cage-not-found → quiet `skipped-not-mine` (no flag); dispatch
 * failure → `atmux flag add` + `gate-held`.
 *
 * Routing semantics per ADR-232 §D2.a (parent → child only, never
 * self-dispatch):
 *
 *   0. **Anti-pattern guard.** If `input.targetCage` matches the
 *      epicId shape (`/^e-\d+-[0-9a-f]+$/`), refuse — caller bug.
 *   1. Resolve cage from `epicId` (or use explicit `targetCage`).
 *   2. **Local-cage-skip guard.** `cage.name === localTeamName` →
 *      return `skipped-not-mine` with reason `local-cage-already-
 *      owns` (the in-cage handler already executed; dispatcher's job
 *      is parent → child fan-out only).
 *   3. LOCAL path: call `invokeLocal` (must be wired).
 *   4. REMOTE path: emit dispatch + return ack/error.
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
 * Cage-not-found: quiet `skipped-not-mine` with reason — NO flag-add.
 * The subscriber's `skipped-not-mine` switch case is the safety net
 * per ADR-232 §D3 (no event emitted, offset advances, no operator
 * noise). Flag-spam-on-every-event was the c477954 review-fail mode
 * that this fix corrects.
 */
export async function dispatchEpicMerge(
  input: DispatchEpicMergeInput,
  deps: DispatchEpicMergeDeps = {},
): Promise<DispatchEpicMergeResult> {
  const parsed = DispatchEpicMergeInputSchema.parse(input);
  const spawnFn = deps.spawn ?? defaultSpawn;
  const resolve = deps.resolveCage ?? defaultResolveCage;
  const isLocal = deps.isLocalCage ?? makeDefaultIsLocalCage(deps.localTeamName);
  const remoteDispatch = deps.dispatchRemote ?? makeDefaultDispatchRemote(spawnFn);
  const flagAdd = deps.flagAdd ?? makeDefaultFlagAdd(spawnFn);

  // (0) Anti-pattern guard per ADR-232 §D2.a. Refuses obvious
  //     epicId-as-cage-name caller bugs at the dispatcher boundary so
  //     a misformed wire-up never silently routes wrong.
  if (parsed.targetCage !== undefined && EPIC_ID_ANTI_PATTERN_RE.test(parsed.targetCage)) {
    return {
      state: "gate-held",
      reason:
        `dispatchEpicMerge: targetCage='${parsed.targetCage}' looks like an epic id — ` +
        `per ADR-232 §D2.a targetCage must be a child cage TEAM NAME, not an epic id. ` +
        `If the caller has only epicId, omit targetCage so resolveCage maps it.`,
    };
  }

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
    // Per ADR-232 §D2.a + §D3: cage-not-found is QUIET (no flag-add).
    // Reason: this is the expected outcome when running in a normal
    // team with no epic-team child, or before the per-team wire-up
    // injects a real resolveCage. The subscriber's `skipped-not-mine`
    // switch case advances the offset without emitting an event;
    // operator sees nothing because nothing is broken. Pre-amendment
    // c477954 flag-spammed on every event in this state — that was
    // the reviewer's REJECT, fixed here.
    return {
      state: "skipped-not-mine",
      reason: `cage not found for epic ${parsed.epicId} — resolveCage returned null (normal team / unwired)`,
    };
  }

  // (2) ADR-232 §D2.a local-cage-skip guard. If the resolved cage IS
  //     this running cage, the in-cage handler already executed (or
  //     will execute via the same handler before this dispatch path is
  //     hit). Re-firing local logic risks the self-dispatch loop the
  //     amendment explicitly forbids.
  if (deps.localTeamName !== undefined && cage.name === deps.localTeamName) {
    return {
      state: "skipped-not-mine",
      reason: `local-cage-already-owns: cage='${cage.name}' matches localTeamName — per ADR-232 §D2.a, dispatcher refuses self-dispatch`,
    };
  }

  // (3) Route LOCAL vs REMOTE. Explicit overrides (empty root) force
  //     REMOTE — there's no local context to merge against, so trusting
  //     the operator's "ship it remote" intent is the safe call.
  const local = cage.root.length > 0 && isLocal(cage);

  if (local) {
    if (deps.invokeLocal === undefined) {
      // Wire-up gap: skipped-not-mine (NOT gate-held) so the subscriber
      // advances the offset quietly. The operator sees the reason in
      // the audit log when investigating "why didn't this merge?", but
      // no Discord ping fires. Pre-amendment c477954 returned
      // gate-held here too which raised noisy epic.merge-blocked emits
      // — the reviewer's REJECT.
      return {
        state: "skipped-not-mine",
        reason:
          `local invoker not wired for ${cage.name} — verbs/epic-merge.ts owns the EpicMergeContext assembly; ` +
          `pass deps.invokeLocal at wire-up time`,
      };
    }
    const localResult = await deps.invokeLocal(parsed.epicId, cage);
    return mapLocalResult(localResult, cage);
  }

  // (4) REMOTE path — dispatch + ack.
  const ack = await remoteDispatch(parsed.epicId, cage);
  if (!ack.ok) {
    const stderrTail = ack.stderrTail ?? "(no stderr captured)";
    await flagAdd({
      epicId: parsed.epicId,
      targetCage: cage.name,
      stderrTail,
    });
    return {
      state: "gate-held",
      reason: `remote dispatch to cage ${cage.name} failed: ${stderrTail}`,
    };
  }
  // Success — remote cage will run performEpicMerge there and emit
  // `epic.merged` itself. Local handler returns `skipped-not-mine` so
  // the subscriber does NOT emit a duplicate event (per ADR-226 handler
  // switch case for `skipped-not-mine` → no emit).
  return {
    state: "skipped-not-mine",
    reason: `dispatched to remote cage ${cage.name}`,
  };
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

/** Default `resolveCage` — returns `null` (forcing the dispatcher to
 *  route through the quiet skipped-not-mine path per ADR-232 §D2.a +
 *  §D3). Production wire-up passes a closure that reads parent's
 *  `state.db` Epic rows for `epicTeamName === <epicId>` per ADR-090
 *  §spawn-epic step 9, OR (more commonly per ADR-232 §D2.a) reads the
 *  local team's `epicTeam.parentEpicKanbanId` and resolves to the
 *  local cage name when the epicId matches. The registry walker
 *  default is deliberately omitted from `src/core/` to keep this
 *  module dep-free of `KanbanRepo` / `openDatabase` — those imports
 *  belong at the verb layer where `atmuxDir` + team config are
 *  already in scope. */
async function defaultResolveCage(_epicId: string): Promise<CageInfo | null> {
  return null;
}

/** Build the default `isLocalCage` closure bound to `localTeamName`.
 *  Per ADR-232 §D2.a the comparison is NAME-based — paths drift across
 *  symlinks + worktree moves, but `team.json::name` is stable. When
 *  `localTeamName` is unset the closure returns `false` always (no
 *  local cage to compare against — every cage is "remote"; the
 *  dispatcher routes via remote path which the operator can override
 *  with a real `isLocalCage`). */
function makeDefaultIsLocalCage(
  localTeamName: string | undefined,
): (cage: CageInfo) => boolean {
  if (localTeamName === undefined) {
    return (): boolean => false;
  }
  return (cage: CageInfo): boolean => cage.name === localTeamName;
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
 *  has the full receipt. Per ADR-232 §D2.a this fires ONLY on remote-
 *  dispatch failure — NOT on cage-not-found (that path is the quiet
 *  skipped-not-mine handled by the subscriber's safety net). */
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
