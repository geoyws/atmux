// AgentBackend — the vendor-agnostic orchestration seam (ADR-258).
//
// A team member is an agent *session* behind this uniform programmatic
// interface, NOT a TUI we type into. atmux orchestrates sessions through
// these verbs; how a session is rendered to a human (tmux attach view) is a
// separate, optional concern (ADR-258 §D4).
//
// This file is types-only — the interface plus the in-process value shapes it
// trades in. Backends implement it:
//   - `tmux-claude` (ADR-258 Phase 1) wraps today's exact send-keys behavior
//     behind this interface (behavior-neutral; src/abstractions/backends/).
//   - `claude-agent-sdk` (Phase 2) wraps the Claude Agent SDK.
//   - `opencode-server` / `openai-compatible` (Phase 5+) follow.
//
// Shapes are informed by the Phase-0 SDK parity audit (ADR-258 §Amendment
// 2026-06-08): SessionStatus carries rate-limited/overloaded + an optional
// window-utilization field plumbed from the retained budget-probe sidecar;
// CostSnapshot's USD is optional (the SDK gives tokens, not first-class USD);
// AgentEvent is a NORMALIZED union so backends do not leak provider-native
// frames to consumers (orchd, refusal-classifier, the stall watchdog).

/** How a turn-injection relates to the session's current turn. */
export type SessionStatusKind =
  | "idle" // session alive, no turn in flight (turn-complete / never started)
  | "working" // a turn is actively streaming
  | "awaiting-input" // blocked on a permission/tool-confirmation or user prompt
  | "errored" // the last turn ended on an error subtype
  | "rate-limited" // 429 / rejected — budget cap; back off / account-swap
  | "overloaded"; // 529 overloaded_error — transient capacity; bounded re-dispatch

/**
 * Rolling rate-limit window utilization, plumbed from the budget-probe sidecar
 * (`src/abstractions/budget-probe.ts`) — NOT from the backend. The Phase-0
 * audit confirmed the Claude Agent SDK does not surface the
 * `anthropic-ratelimit-unified-5h/7d-*` headers to client code, so this is
 * sidecar-sourced on the Claude path and absent on backends that cannot
 * supply it. Percentages are 0..100; resets are epoch seconds.
 */
export interface RateLimitWindowStatus {
  h5PctUsed: number;
  wkPctUsed: number;
  h5ResetEpoch: number;
  wkResetEpoch: number;
}

/**
 * A point-in-time status verdict for a session. `kind` is SYNTHESIZED by the
 * backend's status-wrapper (the SDK has no first-class status field — it is
 * derived from canUseTool callbacks → awaiting-input, live stream → working,
 * terminal ResultMessage → idle, error subtypes → errored). `rateLimitStatus`
 * is present only when a sidecar can supply window data.
 */
export interface SessionStatus {
  kind: SessionStatusKind;
  /** Present iff the last turn ended on an error; the backend's native reason. */
  errorSubtype?: string;
  /** Window utilization from the budget-probe sidecar, when available. */
  rateLimitStatus?: RateLimitWindowStatus;
  /** Epoch seconds this verdict was observed. */
  observedAtSec: number;
}

/**
 * Token + cost accounting for a session. USD is OPTIONAL: the Claude Agent SDK
 * surfaces token counts (via ResultMessage), not a first-class USD figure — it
 * must be computed from a provider price table; opencode reports cost=0 for
 * non-models.dev providers. `windowsActive`/`resetAt` come only from the
 * budget-probe sidecar on the Claude path.
 */
export interface CostSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Computed from a provider price table; absent when no table applies. */
  estimatedUsd?: number;
  /** ISO-4217 (e.g. "USD"); present iff estimatedUsd is. */
  currencyCode?: string;
  /** Window utilization %, sidecar-sourced (Claude path only). */
  windowsActive?: { h5: number; wk: number };
  resetAt?: { h5: number; wk: number };
}

/**
 * Normalized agent event — backends map their provider-native frames
 * (SDK StreamEvent/AssistantMessage/ResultMessage, opencode SSE frames,
 * tmux pane captures) onto this union. Consumers (orchd, refusal-classifier,
 * stall watchdog) see only normalized events, so every backend satisfies one
 * contract.
 */
export type AgentEvent =
  | { type: "text_chunk"; text: string }
  | { type: "tool_start"; toolName: string; toolCallId: string; input?: unknown }
  | { type: "tool_stop"; toolCallId: string; ok: boolean }
  | {
      // The turn finished. `subtype` carries WHY it stopped, mapped from the
      // backend (SDK ResultMessage.subtype: success | error_max_turns |
      // error_rate_limit | error_max_budget_usd | ...).
      type: "turn_complete";
      subtype: string;
      cost?: CostSnapshot;
    }
  | { type: "idle" }
  | {
      // The session needs a decision before it can proceed (a permission /
      // tool-confirmation request). Drives status() → awaiting-input.
      type: "permission_request";
      toolName: string;
      toolCallId: string;
      input?: unknown;
    }
  | {
      // A transport/provider error. `kind` distinguishes the budget cap
      // (rate_limit, 429) from transient capacity (overloaded, 529) so the
      // orchestrator can pick the right reaction (account-swap vs re-dispatch).
      type: "error";
      kind: "rate_limit" | "overloaded" | "other";
      message: string;
      retryAfterSec?: number;
      httpStatus?: number;
    };

/** Permission strategy passed at spawn (ADR-258 §Amendment). */
export type PermissionStrategy =
  | {
      // Non-interactive auto-approval — the clean replacement for
      // `--permission-mode auto`. On the Claude path this maps to the local
      // SDK `canUseTool` callback returning allow. Do NOT route this through
      // the Managed-Agents `always_ask` loop (it blocks on confirmations).
      mode: "auto";
    }
  | {
      // Auto-approve, but escalate requests matching `escalateMatching` to the
      // driver via `atmux ask-user`. `canUseTool` returns allow for the rest.
      mode: "auto-with-escalation";
      escalateMatching: (toolName: string, input: unknown) => boolean;
    }
  | {
      // Deny-by-default; only `allow`-listed tools are auto-approved.
      mode: "allowlist";
      allow: readonly string[];
    };

/** A reference to a backend that can launch a session (account/credentials). */
export interface BackendAccountSelector {
  /** atmux account label (c-u / c-ic / c-i / claude). The wrapper *binary* dies
   *  in v2; this account→config mapping survives into spawn(). */
  account: string;
  /** Optional explicit config/credentials dir override. */
  configDir?: string;
}

/** Options for starting a session. */
export interface AgentSpawnOptions {
  /** The role brief / system prompt — preset name or literal text. */
  systemPrompt: { preset: string } | { text: string };
  /** Working directory for the session (the member's worktree). */
  cwd: string;
  /** Model id, or undefined to use the backend/account default. */
  model?: string;
  /** MCP servers to register for the session. */
  mcpServers?: readonly string[];
  /** Tool allow/deny policy beyond the permission strategy, if the backend supports it. */
  tools?: { allow?: readonly string[]; deny?: readonly string[] };
  /** Permission strategy (default: { mode: "auto" }). */
  permission?: PermissionStrategy;
  /** Account/credentials selection. */
  selector?: BackendAccountSelector;
  /** Resume a prior session by id (validate cwd matches — see SessionHandle). */
  resumeSessionId?: string;
}

/** A live (or resumable) session handle. */
export interface SessionHandle {
  /** Backend-assigned session id; persist to `.atmux/state/agent-sessions.json`. */
  readonly sessionId: string;
  /** The cwd the session was spawned/resumed against. On resume the adapter
   *  MUST compare this to the requested cwd and refuse/warn on mismatch — the
   *  Claude SDK silently creates a FRESH session on cwd mismatch rather than
   *  erroring (ADR-258 §Amendment). */
  readonly cwd: string;
  /** Which backend owns this session (for routing + observability). */
  readonly backendId: string;
}

/** Graceful drains in-flight work + flushes session state; hard force-kills. */
export type ShutdownMode = "graceful" | "hard";

/**
 * The vendor-agnostic orchestration interface. Every backend implements it;
 * everything atmux coordinates (dispatch, health nudges, rotation, handoff,
 * budget, refusal handling) is re-expressed in terms of these verbs — first-
 * class calls, not keystrokes that may or may not land.
 */
export interface AgentBackend {
  /** Stable id for this backend implementation ("tmux-claude", "claude-agent-sdk", ...). */
  readonly id: string;

  /** Start (or resume) a session. */
  spawn(opts: AgentSpawnOptions): Promise<SessionHandle>;

  /**
   * Queue the next turn for the session — the role brief, a dispatch, a nudge.
   * SEMANTICS (ADR-258 §Amendment): this QUEUES a turn (processed after the
   * current turn). It does NOT preempt an in-flight turn. To replace a turn
   * mid-stream, call interrupt() → drain stream() → send().
   */
  send(session: SessionHandle, message: string): Promise<void>;

  /**
   * Stream normalized events for the session. The async iterable ends when the
   * session is shut down. Consumers must tolerate interleaving across turns.
   */
  stream(session: SessionHandle): AsyncIterable<AgentEvent>;

  /**
   * Stop the current turn (replaces the ESC keystroke). The caller MUST drain
   * the remaining stream (including the final turn_complete event) before the
   * next send() — see send() semantics.
   */
  interrupt(session: SessionHandle): Promise<void>;

  /** Synthesized status verdict (see SessionStatus). */
  status(session: SessionHandle): Promise<SessionStatus>;

  /** Token + cost accounting (USD optional — see CostSnapshot). */
  cost(session: SessionHandle): Promise<CostSnapshot>;

  /**
   * Shut a session down. `graceful` drains + flushes (and the adapter must
   * implement a wait-with-timeout-then-hard wrapper itself — no backend
   * exposes a timeout hard-kill); `hard` force-kills with the drain caveat.
   */
  shutdown(session: SessionHandle, mode: ShutdownMode): Promise<void>;
}
