// tmux-claude AgentBackend — behavior-neutral wrapper (ADR-258 Phase 1).
//
// This adapter re-expresses atmux's TODAY-exact send-keys behaviour behind
// the vendor-agnostic `AgentBackend` interface (src/abstractions/agent-
// backend.ts). It is a DELEGATING wrapper: every verb calls the existing
// machinery unchanged — it does NOT alter send.ts / boot-claude.ts /
// pane-state.ts behaviour, it wraps them.
//
//   spawn()    → resolveTuiCommand (tui-cmd.ts) + tmux window create + the
//                ADR-081 §C cold-start: bootClaudeMember (TUI-ready poll +
//                single-line boot prompt) + optional awaitClaudePaneReady
//                (brief-consumed). Returns a SessionHandle whose sessionId
//                is the member/window identity; cwd is the worktree.
//   send()     → sendToMember (safeSendKeysWithVerify bracketed-paste +
//                flock + verify). QUEUE semantics — no preempt.
//   interrupt()→ the existing C-c interrupt keystroke (stop.ts /
//                soft-stop teardown path) sent raw, exactly as bare
//                `atmux stop` does.
//   stream()   → tmux has NO token stream. We synthesize COARSE
//                AgentEvents from polling pane-state (classifyText):
//                working / idle / turn_complete + permission_request
//                (MODAL) + error (RATE-LIMIT). We DO NOT fabricate
//                text_chunk token streams — only what pane-state can
//                truthfully observe. This lossiness is expected and is
//                exactly why v2 wants the SDK backend (ADR-258 §Phase 0:
//                "tmux has no token stream").
//   status()   → map the pane-state 8-state machine onto SessionStatusKind;
//                plumb rateLimitStatus from the budget-probe sidecar.
//                There is NO 529/overloaded signal in the TUI, so
//                `overloaded` is UNREACHABLE on this backend (documented).
//   cost()     → the TUI exposes no per-turn token counts; inputTokens /
//                outputTokens are 0; windowsActive / resetAt come from the
//                budget-probe sidecar. estimatedUsd is OMITTED (never
//                fabricated).
//   shutdown() → graceful = soft-stop notice + a grace window (then a
//                timeout-bounded escalation to hard); hard = kill the
//                window. The graceful-wait-with-timeout-then-hard wrapper
//                lives HERE in the adapter — no underlying timeout-kill
//                exists.
//
// NO LIES: where a signal is genuinely unavailable on tmux (token stream,
// per-turn cost, 529 overloaded), this adapter returns empty / omitted /
// documented-unreachable — never fabricated data.

import type { BootResult } from "../../core/boot-claude.ts";
import type {
  AwaitClaudeReadyDeps,
  AwaitClaudeReadyOpts,
  PaneReadinessResult,
} from "../../core/pane-readiness.ts";
import { classifyText, type PaneState } from "../../core/pane-state.ts";
import type { SendOpts, SendOutcome } from "../../core/send.ts";
import type {
  AgentBackend,
  AgentEvent,
  AgentSpawnOptions,
  CostSnapshot,
  RateLimitWindowStatus,
  SessionHandle,
  SessionStatus,
  SessionStatusKind,
  ShutdownMode,
} from "../agent-backend.ts";
import type { BudgetProbeResult } from "../budget-probe.ts";

/** Stable backend id. Surfaces in SessionHandle.backendId for routing +
 *  observability. */
export const TMUX_CLAUDE_BACKEND_ID = "tmux-claude";

// ---------- Injected machinery ----------

/**
 * The existing machinery this adapter delegates to, injected so the unit
 * suite can mock tmux / pane / spawn / budget-probe without a live tmux
 * server (matching the repo's dependency-injection test discipline —
 * send.ts / boot-claude.ts / pane-readiness.ts all take their IO as args).
 *
 * Production wiring binds these to the real functions:
 *   - `createWindow` → tmux.window.newWindow + tmux.pane.sendKeys(cmd)
 *   - `bootMember`   → bootClaudeMember (boot-claude.ts)
 *   - `awaitReady`   → awaitClaudePaneReady (pane-readiness.ts)
 *   - `sendToMember` → sendToMember (send.ts)
 *   - `capturePane`  → tmux.pane.capturePane bound to the target
 *   - `interruptKeys`→ tmux.pane.sendKeys({ keys: "C-c" }) — the bare-stop
 *                      interrupt keystroke, sent raw (NOT through the
 *                      safe-send gate, matching stop.ts's rationale: C-c is
 *                      a control char, not compose-box content).
 *   - `softStopNotify` / `killWindow` → soft-stop notice + tmux.window.killWindow
 *   - `probeBudget`  → budget-probe.ts probeBudget(account)
 */
export interface TmuxClaudeDeps {
  /**
   * Provision the window + launch the configured TUI command. Returns the
   * tmux target string (`<session>:<window>`) used for all subsequent
   * capture / send / interrupt operations on this session. Mirrors
   * start.ts: resolveTuiCommand → newWindow → sendKeys(cmd, enter:true).
   */
  createWindow(opts: {
    sessionId: string;
    cwd: string;
    spawnOpts: AgentSpawnOptions;
  }): Promise<{ paneTargetString: string }>;
  /**
   * The ADR-081 §C cold-start: TUI-ready poll + single-line boot prompt.
   * Production binds this to `bootClaudeMember` (boot-claude.ts) with the
   * tmux namespace + ADR-025 SendTarget already closed over — the adapter
   * owns no tmux client, so it threads only the identity + target string +
   * spawn opts. This keeps the boot machinery (boot-claude.ts) UNCHANGED:
   * the adapter calls it, it does not re-implement the TUI-ready poll.
   */
  bootMember(opts: {
    sessionId: string;
    paneTargetString: string;
    spawnOpts: AgentSpawnOptions;
  }): Promise<BootResult>;
  /**
   * Optional brief-consumed readiness probe (awaitClaudePaneReady). Only
   * wired when the caller owns brief-paste (ADR-081 §C strict mode); when
   * absent, spawn() succeeds on a `booted` boot result alone.
   */
  awaitReady?(
    target: string,
    opts: AwaitClaudeReadyOpts,
    deps: AwaitClaudeReadyDeps,
  ): Promise<PaneReadinessResult>;
  /**
   * The verified-send path (sendToMember — safeSendKeysWithVerify +
   * bracketed-paste + flock). QUEUE semantics; no preempt. Production
   * binds this to `sendToMember` (send.ts) with the tmux namespace +
   * atmuxDir + MemberDeliveryTarget closed over; the adapter supplies the
   * pane target string + message + the verify-path SendOpts so the
   * QUEUE-semantics + verified-send behaviour is identical to `atmux send`
   * today (default-on verify). The adapter does NOT re-implement the
   * bracketed-paste / flock / verify pipeline — it calls send.ts.
   */
  sendToMember(target: string, message: string, opts: SendOpts): Promise<SendOutcome>;
  /** Capture the pane's visible text (tmux.pane.capturePane bound to the
   *  session's target). Used by status() + stream() pane-state polling. */
  capturePane(target: string): Promise<string>;
  /** Send the raw C-c interrupt keystroke to the session's pane. */
  interruptKeys(target: string): Promise<void>;
  /** Graceful teardown grace: send the soft-stop notice to the pane (the
   *  comment-prefixed "finish current op" line). Best-effort. */
  softStopNotify?(target: string): Promise<void>;
  /** Hard teardown: kill the session's tmux window. */
  killWindow(target: string): Promise<void>;
  /**
   * Probe the budget sidecar for the session's account. Returns null when
   * the account is unknown / has no credentials (the adapter then omits
   * window data — never fabricates it).
   */
  probeBudget?(account: string): Promise<BudgetProbeResult | null>;
  /** Sleep injection (tests pass a no-op). Default: setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock injection (tests fast-forward). Returns epoch ms. */
  now?: () => number;
}

// ---------- Tuning constants ----------

/** Default graceful-shutdown grace window before escalating to a hard
 *  kill. Mirrors soft-stop's 5s default (DEFAULT_SOFT_STOP_GRACE_SECONDS).
 *  No underlying timeout-kill exists, so the adapter owns this. */
export const GRACEFUL_SHUTDOWN_GRACE_MS = 5_000;

const defaultSleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((res) => setTimeout(res, ms));
const defaultNow = (): number => Date.now();

// ---------- Pure pane-state → status mapping ----------

/**
 * Map the pane-state classifier's 8-state machine onto the vendor-agnostic
 * SessionStatusKind. Pure — exported for direct unit-testing.
 *
 * Mapping (ADR-258 §status synthesis; pane-state.ts §8 states):
 *   READY      → idle           (prompt visible, no turn in flight)
 *   TYPING     → working        (user/queued text in compose box — a turn is
 *                                being assembled / about to run; treat as
 *                                in-flight so callers don't preempt)
 *   BUSY       → working        (agent mid-think — `✻ Cooking…`, etc. The
 *                                PAST-tense `✻ Cooked for Ns` is IDLE, not
 *                                busy — see pane-state.ts, t-89fc1cf8.)
 *   COMPACTING → working        (context compaction in progress — the
 *                                session is busy and cannot accept input;
 *                                resolves to idle when it finishes)
 *   MODAL      → awaiting-input  (permission / yes-no modal — blocked on a
 *                                decision)
 *   RATE-LIMIT → rate-limited    ("hit your limit" banner — budget cap)
 *   SHELL      → errored         (TUI crashed back to a shell — the session
 *                                is dead from the agent's perspective)
 *   UNKNOWN    → errored         (no pattern matched — conservative; the
 *                                pane is in an unrecognised state)
 *
 * NOTE: `overloaded` (529) is UNREACHABLE on this backend — the TUI never
 * surfaces a 529 capacity signal in pane text, so no pane-state maps to it.
 * This is documented as a known lossiness (ADR-258 §Phase 0). The SDK
 * backend (Phase 2) is the path that observes 529.
 */
export function paneStateToStatusKind(state: PaneState): SessionStatusKind {
  switch (state) {
    case "READY":
      return "idle";
    case "TYPING":
    case "BUSY":
    case "COMPACTING":
      return "working";
    case "MODAL":
      return "awaiting-input";
    case "RATE-LIMIT":
      return "rate-limited";
    case "SHELL":
    case "UNKNOWN":
      return "errored";
    default: {
      // Exhaustiveness guard — a new PaneState added to pane-state.ts
      // forces a compile error here so this mapping stays complete.
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

/**
 * Map a pane-state classification onto the coarse AgentEvent stream() emits.
 * Pure — exported for direct unit-testing.
 *
 * tmux has NO token stream, so we emit only what pane-state can truthfully
 * observe:
 *   BUSY / TYPING / COMPACTING → { type: "working-ish" } proxy:
 *       we surface BUSY/TYPING/COMPACTING as no discrete event of their own
 *       beyond keeping status() at "working"; stream() emits NOTHING for
 *       these (a token stream would, but we will not fabricate one).
 *   READY      → { type: "idle" }            (turn complete / never started)
 *   MODAL      → { type: "permission_request", ... }
 *   RATE-LIMIT → { type: "error", kind: "rate_limit", ... }
 *   SHELL/UNKNOWN → { type: "error", kind: "other", ... }
 *
 * Returns null for the states stream() does not emit a discrete event for
 * (BUSY/TYPING/COMPACTING) — the caller skips emission for those.
 */
export function paneStateToEvent(state: PaneState, evidence: string): AgentEvent | null {
  switch (state) {
    case "READY":
      return { type: "idle" };
    case "MODAL":
      // We cannot truthfully name the tool / call-id from a pane capture —
      // the modal text doesn't expose them. Emit a permission_request with
      // best-effort empty identifiers + the evidence string so consumers
      // can still flip status() → awaiting-input. NOT fabricated tool data.
      return {
        type: "permission_request",
        toolName: "",
        toolCallId: "",
        input: evidence,
      };
    case "RATE-LIMIT":
      return {
        type: "error",
        kind: "rate_limit",
        message: evidence.length > 0 ? evidence : "rate-limit banner observed in pane",
      };
    case "SHELL":
      return {
        type: "error",
        kind: "other",
        message:
          evidence.length > 0
            ? `TUI fell back to shell: ${evidence}`
            : "TUI fell back to shell (crashed)",
      };
    case "UNKNOWN":
      return {
        type: "error",
        kind: "other",
        message: "pane-state UNKNOWN (no pattern matched)",
      };
    case "TYPING":
    case "BUSY":
    case "COMPACTING":
      // No discrete event — a token stream would emit text_chunk here, but
      // tmux cannot observe tokens, so we emit NOTHING rather than fabricate.
      return null;
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

/** Convert a budget-probe sidecar result into the agent-backend
 *  RateLimitWindowStatus shape. Returns null when the probe yielded no
 *  usable credentials/window data (never fabricated). */
export function budgetToRateLimitStatus(
  probe: BudgetProbeResult | null,
): RateLimitWindowStatus | null {
  if (probe === null) return null;
  if (probe.status === "no-credentials") return null;
  return {
    h5PctUsed: probe.h5_pct_used,
    wkPctUsed: probe.wk_pct_used,
    h5ResetEpoch: probe.h5_reset_epoch,
    wkResetEpoch: probe.wk_reset_epoch,
  };
}

// ---------- The backend ----------

/** Options for {@link createTmuxClaudeBackend}. */
export interface TmuxClaudeBackendOpts {
  /** Pane-state stream() poll interval. Default 1000ms — fast enough to
   *  catch turn boundaries without burning capture-pane budget. */
  streamPollIntervalMs?: number;
}

/** Internal default for the stream() poll cadence. */
export const STREAM_POLL_INTERVAL_MS = 1_000;

/**
 * Build a tmux-claude AgentBackend over the injected machinery.
 *
 * The returned backend holds NO mutable session state beyond a
 * per-session "shut down?" flag (so stream() async-iterables terminate on
 * shutdown). Session identity (sessionId / cwd / target) is carried on the
 * SessionHandle the caller passes back into each verb — the adapter derives
 * the pane target from the handle, matching the stateless tmux model.
 */
export function createTmuxClaudeBackend(
  deps: TmuxClaudeDeps,
  opts: TmuxClaudeBackendOpts = {},
): AgentBackend {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? defaultNow;
  const streamPollIntervalMs = opts.streamPollIntervalMs ?? STREAM_POLL_INTERVAL_MS;

  // sessionId → pane target string. Populated by spawn(); read by the
  // other verbs. The handle ALSO carries enough to reconstruct the target
  // (sessionId IS the member/window identity), but we cache the resolved
  // pane-target string from createWindow so verbs don't re-resolve it.
  const targets = new Map<string, string>();
  // sessionId → shutdown flag. stream() iterables observe this to end.
  const shutDown = new Set<string>();
  // sessionId → account (for budget-probe). Threaded from the spawn
  // selector so status()/cost() can probe the right account.
  const accounts = new Map<string, string>();

  function targetFor(session: SessionHandle): string {
    return targets.get(session.sessionId) ?? session.sessionId;
  }

  async function probeFor(session: SessionHandle): Promise<BudgetProbeResult | null> {
    if (deps.probeBudget === undefined) return null;
    const account = accounts.get(session.sessionId) ?? "";
    if (account === "" || account === "default") return null;
    try {
      return await deps.probeBudget(account);
    } catch {
      // Sidecar failure → no window data; never fabricated.
      return null;
    }
  }

  return {
    id: TMUX_CLAUDE_BACKEND_ID,

    async spawn(spawnOpts: AgentSpawnOptions): Promise<SessionHandle> {
      // sessionId is the member/window identity. Prefer an explicit
      // resume id (validate cwd matches — see SessionHandle contract);
      // otherwise the caller-supplied selector account + cwd identify the
      // window. We do not invent ids — the window-orchestration layer owns
      // the canonical `<session>:<window>` naming and threads it via the
      // selector; here we accept the resume id when present.
      const sessionId =
        spawnOpts.resumeSessionId !== undefined && spawnOpts.resumeSessionId.length > 0
          ? spawnOpts.resumeSessionId
          : deriveSessionId(spawnOpts);

      const account = spawnOpts.selector?.account ?? "";
      if (account.length > 0) accounts.set(sessionId, account);

      // 1. Window create + TUI command launch (resolveTuiCommand +
      //    newWindow + sendKeys(cmd)) — delegated, unchanged.
      const { paneTargetString } = await deps.createWindow({
        sessionId,
        cwd: spawnOpts.cwd,
        spawnOpts,
      });
      targets.set(sessionId, paneTargetString);

      // 2. The ADR-081 §C cold-start: TUI-ready poll + single-line boot
      //    prompt (bootClaudeMember). We do NOT build the BootClaudeOpts'
      //    tmux/sendTarget here — production wiring owns that; the adapter
      //    passes through whatever createWindow surfaced via deps.bootMember.
      //    The boot machinery is unchanged.
      const bootResult = await deps.bootMember({ sessionId, paneTargetString, spawnOpts });
      if (bootResult.status === "failed") {
        throw new Error(
          `tmux-claude spawn: boot failed for ${sessionId} after ${bootResult.attempts} attempt(s)` +
            (bootResult.reason !== undefined ? ` (${bootResult.reason})` : ""),
        );
      }

      // 3. Optional brief-consumed readiness probe (awaitClaudePaneReady),
      //    only when wired. Behaviour-neutral: this is the same probe
      //    start.ts/cockpit use to refuse a false-green spawn.
      if (deps.awaitReady !== undefined) {
        const readiness = await deps.awaitReady(
          paneTargetString,
          { requireBriefConsumed: true },
          { capture: deps.capturePane, sleep, now },
        );
        if (readiness.state === "absent" || readiness.state === "timeout") {
          throw new Error(
            `tmux-claude spawn: pane readiness ${readiness.state} for ${sessionId} ` +
              `(paneState=${readiness.paneClassification.state})`,
          );
        }
      }

      return Object.freeze({
        sessionId,
        cwd: spawnOpts.cwd,
        backendId: TMUX_CLAUDE_BACKEND_ID,
      });
    },

    async send(session: SessionHandle, message: string): Promise<void> {
      // QUEUE semantics (ADR-258 §send): this delegates to the verified-
      // send path (sendToMember → safeSendKeysWithVerify). It does NOT
      // preempt an in-flight turn — the underlying pane-state gate retries
      // on BUSY/TYPING and the bracketed-paste lands the next turn in the
      // composer. To replace a turn mid-stream, the caller does
      // interrupt() → drain stream() → send() per the interface contract.
      // Default-on verify (matches `atmux send`) — same opt-shape the verbs
      // pass today; no fabricated knobs.
      await deps.sendToMember(targetFor(session), message, { verify: true });
    },

    async *stream(session: SessionHandle): AsyncIterable<AgentEvent> {
      // tmux has NO token stream. We poll pane-state and emit COARSE
      // synthesized events (paneStateToEvent). We DO NOT fabricate
      // text_chunk / tool_start / tool_stop / turn_complete-with-cost — the
      // pane cannot observe those. De-dup consecutive identical states so we
      // emit one event per state TRANSITION, not one per poll tick.
      const target = targetFor(session);
      let lastState: PaneState | null = null;
      while (!shutDown.has(session.sessionId)) {
        let text: string;
        try {
          text = await deps.capturePane(target);
        } catch {
          // Capture failure → keep polling; a transient tmux IO fault
          // should not end the stream (the session may recover).
          await sleep(streamPollIntervalMs);
          continue;
        }
        const classification = classifyText(text, now);
        if (classification.state !== lastState) {
          lastState = classification.state;
          const event = paneStateToEvent(classification.state, classification.evidence);
          if (event !== null) yield event;
        }
        await sleep(streamPollIntervalMs);
      }
    },

    async interrupt(session: SessionHandle): Promise<void> {
      // The existing C-c interrupt keystroke (bare-stop / soft-stop
      // teardown path). Sent RAW, exactly as stop.ts does — C-c is a
      // control char (works on modal-stuck panes), not compose-box content,
      // so it is intentionally NOT routed through the safe-send gate.
      await deps.interruptKeys(targetFor(session));
    },

    async status(session: SessionHandle): Promise<SessionStatus> {
      const observedAtSec = Math.floor(now() / 1000);
      let kind: SessionStatusKind;
      try {
        const text = await deps.capturePane(targetFor(session));
        kind = paneStateToStatusKind(classifyText(text, now).state);
      } catch {
        // Capture failure → cannot classify; surface errored honestly.
        kind = "errored";
      }
      const rateLimitStatus = budgetToRateLimitStatus(await probeFor(session));
      const out: SessionStatus = { kind, observedAtSec };
      if (rateLimitStatus !== null) out.rateLimitStatus = rateLimitStatus;
      return out;
    },

    async cost(session: SessionHandle): Promise<CostSnapshot> {
      // The TUI exposes no per-turn token counts → 0/0. estimatedUsd is
      // OMITTED (never fabricated). windowsActive / resetAt come from the
      // budget-probe sidecar when available.
      const probe = await probeFor(session);
      const out: CostSnapshot = { inputTokens: 0, outputTokens: 0 };
      if (probe !== null && probe.status !== "no-credentials") {
        out.windowsActive = { h5: probe.h5_pct_used, wk: probe.wk_pct_used };
        out.resetAt = { h5: probe.h5_reset_epoch, wk: probe.wk_reset_epoch };
      }
      return out;
    },

    async shutdown(session: SessionHandle, mode: ShutdownMode): Promise<void> {
      // Mark shut down FIRST so any live stream() iterable terminates.
      shutDown.add(session.sessionId);
      const target = targetFor(session);
      if (mode === "graceful") {
        // Graceful = soft-stop notice + grace window, THEN a hard kill.
        // No underlying timeout-kill exists; the adapter owns the
        // wait-with-timeout-then-hard escalation (interface contract).
        if (deps.softStopNotify !== undefined) {
          try {
            await deps.softStopNotify(target);
          } catch {
            // Best-effort — a failed notice degrades to the bare grace +
            // kill, not worse (matches soft-stop's best-effort notify).
          }
        }
        await sleep(GRACEFUL_SHUTDOWN_GRACE_MS);
      }
      // hard (and the tail of graceful) → kill the window.
      await deps.killWindow(target);
      targets.delete(session.sessionId);
      accounts.delete(session.sessionId);
    },
  };
}

// ---------- Internals ----------

/**
 * Derive a stable sessionId from spawn opts when no resume id is given.
 * The window-orchestration layer owns the canonical `<session>:<window>`
 * naming; absent that, we key on account + cwd so two spawns into the same
 * worktree+account collide deterministically (the resume-vs-fresh contract
 * is the caller's via resumeSessionId). Pure + deterministic.
 */
function deriveSessionId(spawnOpts: AgentSpawnOptions): string {
  const account = spawnOpts.selector?.account ?? "default";
  return `${TMUX_CLAUDE_BACKEND_ID}:${account}:${spawnOpts.cwd}`;
}
