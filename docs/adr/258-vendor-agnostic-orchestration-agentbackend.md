# ADR-258: Vendor-agnostic orchestration — `AgentBackend` adapter, tmux demoted to an attach view

**Status**: accepted
**Date**: 2026-06-07 (accepted 2026-06-09)
**Driver-ref**: George 2026-06-07 — approved the *atmux v2 — Vendor-Agnostic Orchestration* proposal (drafted 2026-06-05, published to docs.geoy.ws) and directed "file v2 ADR-258 now (Status: proposed) → plan → workflow burndown." **Accepted 2026-06-09** (driver decision): after the Phase-0 SDK parity audit (§Amendment 2026-06-08) returned "Phase 1 safe to start," George directed "Accept ADR-258 + start Phase 1." Status flips proposed→accepted per the binding-discipline (driver/lead decisions-add); the four Phase-3 default-flip gates remain open as recorded in the amendment. Bundled same-session directives folded in: (1) a 5-min orchd member-health check that detects API-overload and nudges work forward; (2) reduce team-member count, members self-commit/push; (3) "learn from how Claude workflows work to make atmux better." The current execution model was confirmed by a code sweep on 2026-06-07 (see Context).
**Relates**: [ADR-162](162-atmux-owns-tmux-infrastructure.md) (tmux-as-infrastructure — this ADR demotes it to an attach view), [ADR-202](202-honker-in-db-messaging-substrate.md) / [ADR-203](203-event-topic-taxonomy.md) (the durable event substrate v2 re-points backends at), [ADR-090](090-epic-team-lifecycle.md) / [ADR-091](091-kanban-driven-auto-merge.md) / [ADR-134](134-in-team-auto-merger.md) / [ADR-137](137-merge-over-rebase.md) (epic teams + verified serialized fan-in — the moat, untouched), [ADR-247](247-lead-stall-watchdog.md) (the designed-but-unbuilt stall watchdog the 5-min health check implements), [ADR-199](199-claude-account-pool-for-epic-team-spawning.md) (account-pool/swap — reused for SDK-side overload), [ADR-138](138-verified-send-keys.md) / [ADR-139](139-refusal-pattern-auto-rotate.md) / [ADR-142](142-modal-cycling-detector.md) / [ADR-148](148-commit-cadence-truth-signal.md) / [ADR-239](239-three-driver-minimum-per-team-and-no-sendkeys-invariant.md) (send-keys-era subsystems that become legacy/fallback-only), [ADR-191](191-vendored-tmux-binary.md) (vendored-tmux — narrows to the attach-view slice only), [ADR-050](050-fallback-chain.md) (the fallback-cage chain — shrinks to attach-only), [ADR-233](233-cron-auto-install-disabled-trust-orchd.md) (orchd-is-the-runtime — the health ticker lives here, not cron), [ADR-237](237-no-llm-discord-and-whip-removal.md) (whip removal — orphaned detectors this ADR re-homes), [ADR-257](257-eternal-improvement-burndown-first-worktree-isolated.md) (backlog burndown — v2 supersedes the TUI-control slice of that backlog).

## Context

atmux's heaviness is concentrated in one place: **the tmux `send-keys` control plane.** A 2026-06-07 code sweep confirmed the current model and quantified the surface.

**Today, definitively, atmux drives interactive coding TUIs over tmux — there is no programmatic/SDK path:**
- `package.json` runtime dependencies = `{ "zod" }` only. No `@anthropic-ai/sdk`, no agent-sdk, no opencode client.
- `docs/ARCHITECTURE.md` Principle #1: *"tmux is the IPC. atmux doesn't speak any AI provider API. It writes shell commands into tmux panes via `tmux send-keys` and reads responses by capturing pane output."*
- Each member is a real interactive `claude` REPL (`src/core/tui-cmd.ts:191`), cold-booted by polling the pane for the `❯`/`tokens` glyph then send-keys'ing a boot prompt (`src/core/boot-claude.ts`, `TUI_READY_RE = /❯|tokens/`).
- Every dispatch/nudge is a verified send-keys round-trip (`src/core/send.ts` → `safeSendKeysWithVerify` → `tmux.ts:622 sendKeys`) with per-pane `flock(2)` serialization (`src/core/safe-send.ts`, the recent composer-wedge fix).

**A large share of the machinery exists only to coax a human-oriented TUI** — epicycles around a fragile control channel, not intrinsic to "running an agent team": `safe-send.ts` (send-keys verify + flock), `boot-claude.ts` (TUI-ready poll / boot-prompt / composer-wedge), `refusal-classifier.ts` + `refusal-threshold.ts`, `modal-cycling-detector.ts` + `known-modals.ts`, `queued-text-resubmit.ts`, `paste-submit.ts`, `pane-readiness.ts`, `pane-state.ts`, `cage-state.ts`, the `--permission-mode auto`/`BTab` spawn dance in `tui-cmd.ts` + `src/abstractions/claude-account-wrapper.ts`, and header-based rate-limit triage (`src/abstractions/budget-probe.ts` scraping the `anthropic-ratelimit-unified-*` headers because pane footers freeze). The recent bug stream (cage-wipe orphaning, socket resolution, composer wedge, fail-closed gates) is largely **atmux maintaining atmux** — a tell that the control plane is the wrong abstraction.

**Claude Code workflows replace one slice of atmux, not the system.** Workflows are *ephemeral, in-process fan-out within a single session* — they cannot run for days, survive a restart, coordinate across repos, or let a human lean into a stuck member. atmux's value is the **persistent, supervised, multi-day team substrate**: durable kanban (`state.db`, ADR-126), the Honker event substrate (ADR-202/203), worktree-isolated epic teams with verified serialized fan-in (ADR-090/091/134/137), budget tracking across the weekly window, and human-attachable panes. The correct response to "Claude has workflows now" is **not** "atmux is obsolete" — it is "drop the parts that duplicate ephemeral fan-out (the TUI-control layer), and double down on the persistent-team moat." Concretely, the workflow tool's programmatic `agent()` call **is** the abstraction this ADR introduces as `AgentBackend` — calling an agent as a first-class API instead of typing into its terminal.

## Decision

### (D1) The principle

> **A team member is an agent *session* behind a uniform programmatic interface — not a TUI we type into. atmux orchestrates sessions; how a session is rendered to a human is a separate, optional concern.**

### (D2) The `AgentBackend` adapter

One interface every backend implements; everything atmux coordinates (dispatch, health nudges, rotation, handoff, budget, refusal handling) is re-expressed in terms of these verbs — **first-class calls, not keystrokes that may or may not land:**

```
interface AgentBackend {
  spawn(opts): Promise<SessionHandle>           // start a session (model, cwd, system brief, tools)
  send(session, message): Promise<void>          // inject a turn (role brief, dispatch, nudge)
  stream(session): AsyncIterable<AgentEvent>     // tokens / tool-calls / turn-complete / idle / error
  interrupt(session): Promise<void>              // stop the current turn (replaces the ESC keystroke)
  status(session): Promise<SessionStatus>        // idle / working / awaiting-input / errored
  cost(session): Promise<CostSnapshot>           // tokens + USD (replaces header scraping)
  shutdown(session, mode): Promise<void>         // graceful / hard
}
```

### (D3) Backends, in priority order

1. **`tmux-claude` (legacy/fallback)** — wraps *today's exact* send-keys behavior behind the interface. Ships first, behavior-neutral; the migration's reversibility anchor.
2. **`claude-agent-sdk`** — wraps the Claude Agent SDK. Must reach parity with today's Claude-member behavior so migration is non-breaking and the pre-paid weekly Claude quota stays fully usable. Becomes default once parity holds.
3. **`opencode-server`** — drives opencode in server mode (HTTP/session API); unlocks model-agnostic members (any provider opencode supports, incl. Kimi).
4. **`openai-compatible`** *(later)* — a thin generic backend for raw provider APIs / local models, for members that don't need a full coding-agent loop.

### (D4) tmux demoted to an attach view

tmux stops being the control channel and becomes an **optional rendering/observability surface**: a pane *attaches* to a session's event stream to show a human what's happening; a human *injects* a turn via the same `send()` the orchestrator uses (a thin input box, not raw keystroke puppeteering). Headless/cron runs skip tmux entirely. This keeps the genuinely valuable "I can watch and talk to a member" without the fragility of being *forced* to. ADR-239 already validated this direction for **driver** panes (command-mode launch + hard `DriverSendKeysViolation` guard); v2 generalizes that pattern to all members.

### (D5) What dies vs what carries forward

**Obsoleted (the payoff — deleted once no live backend needs them):** `safe-send.ts`, `boot-claude.ts`, `refusal-classifier.ts` + `refusal-threshold.ts`, `modal-cycling-detector.ts`, `known-modals.ts`, `queued-text-resubmit.ts`, `paste-submit.ts`, `pane-readiness.ts`, `pane-state.ts`, `cage-state.ts`, header-based rate-limit triage (`budget-probe.ts` scraping — cost/limits come from backend `cost()`/`status()`), the permission-mode/`BTab` spawn dance + `claude-account-wrapper.ts` selection. Cage socket management (`fallback-cage.ts`, ADR-050) shrinks to "only when an attach-view is requested." The send-keys-era ADRs (138/139, parts of 142/148/162/239) become legacy/fallback-only.

**Carried forward (the moat — untouched):** kanban (`src/core/kanban.ts`, ADR-126); the Honker event substrate (`src/abstractions/events.ts`, ADR-202/203); complaints, stories/epics; worktree-isolated epic teams + committers/reviewers + verified fan-in (ADR-090/091/134/137); the Rust `atmux-orchd` daemon (ADR-233/256) — **re-pointed at backend events instead of pane scraping**; budget tracking across the weekly window; the CLI surface and team-of-teams model.

### (D6) The bundled operator directives, folded into v2

These three same-session asks are **cheaper and cleaner under v2**, so they are designed into it rather than bolted onto the TUI architecture:

- **(a) Fewer members + members self-commit/push.** Members *already* self-commit + auto-push their own `<base>-<member>` branch (`templates/briefs/member.md` §Commit-ownership + `src/core/auto-push.ts` wired into `claim.ts::done`). The committer/merger role exists **only for serialized fan-in** to trunk, now run by the no-LLM orchd daemon. Members must **not** self-*merge* to shared trunk (ADR-194 records four shared-index corruptions in three days from concurrent fan-in; ADR-137 forbids the rebase→force-push that breaks sibling fetches; the test-gate-once owner and durable conflict ledger would be lost). The reduction lever is therefore: **relax `src/core/orchd-window.ts` Gate-2** (currently refuses to spawn orchd unless a `committer`/`gitter` member exists) to gate on `autoMerge.enabled` instead → the human committer becomes optional → default rosters shrink (default epic roster is 7; lean presets `backend-heavy`=5 / `solo+committer`=2 / `solo`=1 already exist). Reconcile the live contradiction (`.atmux/team.json` carries a gitter while `member.md` calls modern teams committer-less) in the same change.
- **(b) 5-min member-health check that detects API-overload and nudges work forward.** This is **mostly an integration job, not greenfield.** The detectors already exist as pure modules (`cadence-classifier`, `velocity`, `lane-stall`, `pane-state`, `cage-state`, `modal-cycling-detector`) but are orphaned after ADR-233 (cron removal) + ADR-237 (whip removal). Account-level rate-limit detection + member pause/resume **already runs every 15 min** via orchd's `--scan-budget` ticker (`rust/atmux-orchd/src/main.rs:970,1014` → `runBudgetCheck`, pause@90%/resume@80%, account-swap@75%). The genuinely missing pieces: (i) **ADR-247's lead/member-stall watchdog is designed but has zero implementation** — implement it as a deterministic, no-LLM **orchd consumer + low-frequency backstop** (5-min idle threshold matches ADR-247's default), reusing the existing detectors via a single composed health-snapshot helper rather than a fourth pane-hashing implementation; (ii) **true HTTP 529 `overloaded_error` handling does not exist anywhere** and is *invisible* in the TUI model (buried inside each member's `claude` subprocess) — under v2 it surfaces as a catchable SDK error, emitted as a new `member.rate-limited` / `member.overloaded` event topic (`src/schema/events.ts`) that orchd's existing `watchEvents`/`withIdempotency` machinery consumes (sub-second, in-band) to back off / re-dispatch / account-swap, reusing ADR-199's account-pool/swap policy layer unchanged. **Caveat (ADR-140/247 lesson):** keep the health check deterministic/non-LLM — do not regress to a token-burning LLM polling loop.
- **(c) Learn from Claude workflows.** See Context: the workflow tool's `agent()` is `AgentBackend` generalized. v2 = "Claude-Workflows' programmatic agent model (replacing the TUI-control layer) + atmux's durable coordination moat (kept)."

### (D7) Backlog supersession

v2 supersedes the TUI-control slice of the current backlog (proposal Open Question #5). The **first v2 task is a one-pass backlog triage** tagging each open Task `carry-forward` / `fold-into-v2-requirements` / `retire` — so the ~half of the backlog that is send-keys epicycles is retired against this ADR rather than burned down (per ADR-257, idle capacity should not harden a substrate v2 deletes).

## Migration — incremental, non-breaking, trunk-green throughout

- **Phase 0 — SDK capability/gap audit (gates the default-flip, Open Question #2).** Does the Claude Agent SDK expose everything the send-keys path leans on: mid-turn interrupt, MCP servers, permission policy, structured cost? Produce a parity checklist. Findings may constrain which ❌ deletions can land.
- **Phase 1 — `AgentBackend` interface + `tmux-claude` backend (behavior-neutral).** Define the interface; wrap today's exact send-keys behavior as the internal `tmux-claude` backend; route all dispatch/health/rotation/handoff through the seam. Zero behavior change — the safe, reversible foundation. *(Recommended first burndown target.)*
- **Phase 2 — `claude-agent-sdk` backend to parity**, behind a per-member opt-in flag; validate a full epic end-to-end on it.
- **Phase 3 — flip the default** to `claude-agent-sdk` once the Phase-0 parity bar holds; `tmux-claude` stays as fallback.
- **Phase 4 — delete the ❌ epicycles** no live backend needs (D5).
- **Phase 5 — `opencode-server` backend**; pilot one member, then a whole epic team, on a non-Claude model.
- **Phase 6 — tmux attach-view** as a thin consumer of the event stream + `send()` injection.

The D6 items slot in alongside: (a) orchd Gate-2 relax + lean default roster is independent and can land any time; (b) ADR-247's watchdog can land on the *current* orchd (it is in the moat) — its overload arm (529 topic) lands with Phase 2.

## Consequences

- **Net LOC down**, concentrated in the most-churned, most-recently-bug-fixed corner of the tree; the ❌ bug classes (composer wedge, cage-wipe orphaning, socket resolution, fail-closed send-keys gates) stop recurring in the eternal-improvement loop.
- Model/vendor-agnostic members without rewrites; the pre-paid Claude quota stays the default and fully usable.
- Supervision becomes **more** reliable: `status()`/`stream()`/`cost()` are structured data, not screen-scrapes.
- Real build cost for the adapters, bounded and paid back by the deletions. Risk concentrated at the Phase-3 default-flip, gated by the Phase-0 parity checklist with `tmux-claude` as the standing fallback.

## Open questions

1. Parity bar for the default-flip — which behaviors must `claude-agent-sdk` match exactly before `tmux-claude` is demoted? (Phase 0 output.)
2. Does the Claude Agent SDK expose interrupt-mid-turn / MCP / permission policy / cost? (Phase 0 audit.)
3. Attach-view fidelity: full TUI re-render, or a structured event log + input box? (Lean: structured log first.)
4. Do supervision roles (medic/sentinel/martinet) survive as-is on event streams, or simplify substantially?
5. Backlog triage outcome (D7) — exact carry-forward/fold/retire split.

## Non-goals

- Not abandoning Claude — it stays the default backend; the pre-paid weekly quota is an asset to *use*, not flee.
- Not rebuilding the coordination substrate — kanban/events/epics/committers/orchd are kept and re-pointed.
- Not making opencode/Kimi *mandatory*-primary — first-class *option*, opt-in per member/task, never forced onto load-bearing work.

## Amendment 2026-06-08 — Phase-0 SDK parity audit findings

Phase 0 (the SDK capability/gap audit gated above) ran 2026-06-08 (workflow `wf_87110ec9-b54`: Claude Agent SDK session-control / tools-perms / cost-errors scans + the atmux send-keys dependency map + an opencode server-mode scan + synthesis). **Verdict: Phase 1 is SAFE TO START NOW** — it is a behavior-neutral re-expression of behavior atmux already owns; nothing in it depends on an unproven SDK capability. The audit confirmed the SDK supports persistent sessions (`~/.claude/projects/<cwd>/<id>.jsonl`, resume/fork), multi-turn injection, structured streaming (`includePartialMessages`), **mid-turn `interrupt()`** (Python `ClaudeSDKClient.interrupt()` / TS `Query.interrupt()`, with a drain-before-next-send contract), and MCP/tools. It also corrected three over-claims in this ADR — applied below so the decision record does not assert deletions the audit disproved.

### Corrections to (D5) — three items move OUT of the ❌ obsolete list

- **`budget-probe.ts` / header-based rate-limit triage — RETAINED as a sidecar, NOT deleted (D5 was wrong).** The SDK does **not** surface the `anthropic-ratelimit-unified-5h/7d-*` window-utilization headers to client code (response-only; the SDK exposes per-turn token counts + `error_rate_limit`/`error_max_budget_usd` subtypes, but not rolling-window %). atmux's `pause@90% / resume@80% / swap@75%` weekly-window policy (orchd `--scan-budget`, ADR-199/233) therefore has **no SDK replacement**. `budget-probe.ts` must remain a sidecar on the SDK backend and must **not** be deleted in Phase 4. This is a **blocking gate on the Phase-3 default-flip.**
- **`refusal-classifier.ts` + `refusal-threshold.ts` — KEPT, re-pointed (not obsoleted).** Refusal is a property of the assistant's natural-language output, which exists identically on the SDK path; it is atmux coordination policy (ledger → threshold → rotate), not transport. It carries forward, fed by `stream()` text instead of pane capture. `account-pool.ts` / `account-swap.ts` (ADR-199) likewise carry forward — reused unchanged for the D6b 529 path.
- **`pane-state.ts` / `cage-state.ts` — delete only AFTER a status-wrapper reaches parity (not 1:1).** The SDK has no first-class status field. `status(): SessionStatus` must be **synthesized** by a wrapper tracking `canUseTool` callbacks (awaiting-input), live stream (working), `ResultMessage` (idle/turn-complete), and error subtypes (errored). Deletion is Phase-4-after-parity, gated on the wrapper matching pane-state's classification for the states that matter.

Cleanly obsoleted as D5 stated (Phase-4-after-parity, once `tmux-claude` is retired): `boot-claude.ts`, `safe-send.ts` (verify + flock — the composer-wedge class is structurally eliminated), `known-modals.ts` + `modal-cycling-detector.ts` (TUI modals don't render headless; repeated `canUseTool` callbacks are countable directly), `paste-submit.ts` (no bracketed-paste), the `--permission-mode auto`/`BTab` dance + `tui-cmd.ts` shell-building + `claude-account-wrapper.ts` binary resolution (the account→config *mapping* survives into `spawn()` opts; the wrapper *binary* dies). Cage socket mgmt (`fallback-cage.ts`) shrinks to attach-only per D4, not deleted.

### Refinements to (D2) — the interface, shaped by what the SDK actually exposes (build into Phase 1)

- **`SessionStatus` — extend beyond the 4 states** to `idle | working | awaiting-input | errored | rate-limited | overloaded`, plus an optional `rateLimitStatus?: { h5PctUsed, wkPctUsed, h5ResetEpoch, wkResetEpoch }` (plumbed from the retained budget-probe sidecar — no SDK source). `status()` is a synthesized wrapper, not a passthrough getter.
- **Define `CostSnapshot`** (referenced but never shaped): `{ inputTokens, outputTokens, cacheRead?, cacheWrite?, estimatedUsd?, windowsActive?: { h5: pct, wk: pct }, resetAt?: { h5, wk } }`. `estimatedUsd` is **optional** — the SDK gives token counts, not first-class USD (compute from a provider price table; opencode reports `cost=0` for non-models.dev providers). `windowsActive` comes only from the sidecar on the Claude path.
- **`send()` = queue-a-turn, NOT preempt.** Document two distinct call sequences: `send()` queues the next turn (streaming-input generator); mid-turn replace is `interrupt()` → drain stream (incl. final `ResultMessage`) → `send()`. Surface `ResultMessage.subtype` (`success | error_max_turns | error_rate_limit | error_max_budget_usd`) to the dispatcher so atmux knows *why* a turn stopped.
- **`stream()` → a normalized `AgentEvent` union** (`text_chunk | tool_start | tool_stop | turn_complete{subtype} | idle | permission_request | error{type}`) mapped from raw SDK frames — do not leak SDK-native frames, so the `opencode-server` backend (single multiplexed SSE bus, demux by sessionId) can satisfy the same contract.
- **Event topics added in Phase 1** (before any backend consumer): `member.rate-limited`, `member.overloaded`, `member.usage-snapshot` in `src/schema/events.ts` alongside `member.context-high`. The adapter maps SDK `error.type='rate_limit_error'` → `member.rate-limited`, `'overloaded_error'` → `member.overloaded`, and emits usage per-turn-end (not per-span — avoid Honker spam).
- **Permission strategy** in `spawn()` opts: prefer the **local SDK `canUseTool` callback** (return allow/deny/updatedInput) for true non-interactive auto-approval — the clean replacement for `--permission-mode auto`. Do **not** design the interface around the 2026-04 Managed-Agents beta `always_ask` event loop (it blocks on `user.tool_confirmation`). High-risk requests route to the driver via `atmux ask-user`.
- **`shutdown(mode)`**: the adapter must implement the "graceful-wait-with-timeout then SIGTERM" wrapper itself (the SDK exposes no timeout hard-kill) and fsync/verify the session JSONL post-disconnect (SDK flush-vs-termination race, `claude-agent-sdk-python#625`).
- **`spawn()` opts** carry an account/credentials selector; on `resume`, the adapter must compare `cwd` and refuse/warn on mismatch (the SDK silently creates a *fresh* session on cwd mismatch rather than erroring).

### Phase-3 default-flip gates (all four must clear)

1. `budget-probe.ts` retained as the SDK-backend window-telemetry sidecar (above).
2. **529 `overloaded_error` live-probed** — the SDK docs do not name it as a distinct catchable class vs 429, nor document retry-after/backoff. 529 handling is greenfield (zero today), so this does not block the flip per se, but the **D6b overload benefit cannot be claimed** until probed; Phase 2 must not commit the error-mapping design before this.
3. **Permission surface pinned to local-SDK `canUseTool`** (not Managed-Agents `always_ask`).
4. **`status()` wrapper reaches parity** with pane-state for working/idle/awaiting-input/rate-limited before the SDK backend drives rotation/health decisions.

Open Questions #1 and #2 are partially answered (parity bar = the four gates above; SDK exposes interrupt/MCP/sessions, with the budget-window header gap as the one hard miss). The unverified surfaces (exact 529 class, retry/backoff policy, mid-stream error frames, precise permission surface Phase 2 targets) remain `unknown` and must be live-probed in Phase 2 — do not design the adapter as if they are settled.
