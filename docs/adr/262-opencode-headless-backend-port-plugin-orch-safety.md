# ADR-262: `opencode` headless AgentBackend — flat cheap-model members, capability contract + MCP tool injection; port plugin-orch safety as policy, not code

**Status**: proposed
**Date**: 2026-06-12
**Driver-ref**: George 2026-06-12 — "let's see if we can include the old orch opencode plugin kind of thing together in this repo … we want to be able to run multi agents safely using headless agents." Pain point, verbatim intent: *OpenCode's DeepSeek can't run subagents very well, and subagents may not have access to web search etc.* This ADR is the concrete design for ADR-258 §D3's already-named `opencode-server` backend (its Phase 5), pulled forward and reshaped around that pain point.
**Relates**: [ADR-258](258-vendor-agnostic-orchestration-agentbackend.md) (parent — `AgentBackend` interface, normalized `AgentEvent` union, backend priority list naming `opencode-server` at #3; this ADR concretizes it), [ADR-260](260-manual-orchestration-mode-default.md) (manual default — headless members spawn under either mode), [ADR-203](203-event-topic-taxonomy.md) (member-health topics `member.rate-limited` / `member.overloaded` the adapter must emit), [ADR-028](028-main-master-pr-only-no-agent-push.md) + [ADR-137](137-merge-over-rebase.md) (the git-policy floor the ported deny-list enforces), [ADR-082](082-worktree-isolation-per-member.md) / [ADR-084](084-worktree-per-member-branch-model.md) / [ADR-090](090-epic-team-lifecycle.md) (worktree-per-member isolation — why the plugin's soft file locks are NOT ported), [ADR-237](237-no-llm-discord-and-whip-removal.md) (whip retired — why the plugin's whip-monitor is NOT ported), [ADR-199](199-claude-account-pool-for-epic-team-spawning.md) (account-pool — Claude-specific, inapplicable to third-party providers; budget enforcement replaces it on this backend).

## Context

### The pain point is a capability asymmetry, not a missing feature

Driving a multi-agent tree **from inside** an OpenCode session puts the orchestration burden on the session's model. With a frontier model that mostly works; with cheap models (DeepSeek) it does not: nested subagent spawning demands sustained, reliable tool-calling, and OpenCode's subagent sandbox compounds the problem by handing subagents a reduced toolset (web search availability depends on provider/plugin wiring). The operator's standalone plugin **`geoyws/opencode-plugin-orch`** (public, TypeScript, last pushed 2026-04-18) attacked exactly this: 12 `orch_*` tools giving a lead session a team manager, task board, message bus, soft file locks, work stealing, cost tracking with budget auto-shutdown, model-escalation chains, a git-mutation permission deny-hook for members, and an event-sourced JSONL store.

### Why the plugin cannot be vendored into atmux

The plugin is a parallel implementation of roughly half of atmux's coordination core, frozen two months before atmux's current architecture landed:

| plugin-orch (2026-04) | atmux today | verdict |
|---|---|---|
| `task-board.ts` + work stealing | kanban + `atmux claim --next` (ADR-126) | duplicate |
| `message-bus.ts` / `inbox.ts` / `memo.ts` | Honker substrate + `tell-lead` (ADR-202/203/214) | duplicate |
| JSONL event-sourced `store.ts` | SQLite `state.db` (ADR-169) | duplicate |
| `whip-monitor.ts` | retired (ADR-237) | retired concept |
| `idle-monitor.ts` + `session.idle` wake | orchd consumers + `team.idle` topics (ADR-203/227) | duplicate |
| `file-locks.ts` (soft locks, shared dir) | worktree-per-member (ADR-082/084) | superseded — stronger isolation |
| **headless members in OpenCode sessions** | tmux TUI panes only (ADR-258 Phase 1 wrapper) | **the gap — this ADR** |
| **`permissions.ts` git deny-hook, budget auto-shutdown, `escalation.ts` model chains** | no equivalent on any backend | **port as policy — this ADR** |

Vendoring (or submoduling) it would create two sources of truth for tasks, messages, state, and liveness. The valuable, non-overlapping remainder is two things: **headless member sessions** and the **safety toolkit**.

### Why atmux's shape already answers "DeepSeek can't run subagents"

atmux members are **flat** — no member ever spawns subagents. Decomposition, dispatch, claiming, and fan-in are deterministic atmux code (kanban, Honker consumers, ADR-091/134 committers); judgment sits with the lead. A member needs single-session competence only: read a brief, edit files, run commands, report. That is precisely the envelope cheap models satisfy. The fix for "the model can't orchestrate" is structural: **never ask it to** — atmux supplies the orchestration intelligence the model lacks.

## Decision

### D1 — Port concepts as backend policy; never vendor the plugin

No code import, no submodule, no `.opencode/plugin-orch` revival (the in-repo directory is an empty stub — one `init.log`). The plugin repo stays standalone as prior art; this ADR cites its mechanisms by file (`src/hooks/permissions.ts`, `src/core/escalation.ts`, `src/core/cost-tracker.ts`) and re-derives them inside atmux's architecture.

### D2 — `opencode` backend adapter at `src/abstractions/backends/opencode.ts`

Implements the ADR-258 §D2 `AgentBackend` interface against **OpenCode server mode** (HTTP session API; single multiplexed SSE event bus demuxed by `sessionId`, per the ADR-258 Amendment's `stream()` note). `spawn()` creates a session with the member's configured model/provider; `send()` queues a turn; `stream()` maps provider frames onto the normalized `AgentEvent` union (frames never leak, same rule as ADR-258); `status()` is synthesized; `cost()` reports per-turn token counts (USD optional — OpenCode reports `cost=0` for non-models.dev providers; compute from a price table or leave undefined, never fabricate). All HTTP through `src/abstractions/http.ts` (ADR-003).

### D3 — The flat-member invariant, made explicit and enforced

Headless member sessions are spawned **without subagent-spawning tools**. Orchestration tools are not absent by accident; they are denied by contract. A member that believes it needs decomposition files a kanban ask; the lead decomposes. This is the load-bearing answer to the pain point and is enforced at `spawn()` (tool allowlist), not by prompt.

### D4 — Capability contract at spawn (fail fast, never silently degraded)

The backend declares `REQUIRED_MEMBER_TOOLS` (file read/edit, shell exec, web fetch/search — exact set fixed in Phase 1). At `spawn()`, the adapter verifies the session's effective toolset and **fails fast with a typed error** naming the missing capability — mirroring ADR-258's "a sidecar supplies what the vendor lacks; the interface never fabricates it." No more member sessions that silently cannot research. A capability missing from the provider is satisfied via D5 or the spawn is refused.

### D5 — MCP tool injection: atmux furnishes the tools the provider lacks

OpenCode supports MCP servers. atmux ships an **atmux-owned MCP server** attached to every headless member session, providing at minimum: web search/fetch, and the member verb surface (`claim` / `done` / `tell-lead` / complaints). Capability parity becomes **atmux's guarantee, independent of model/provider** — "LLM of your choice" stops depending on which provider bundled which tools. D4's contract checks the post-injection toolset, so D5 is the primary mechanism and D4 the backstop.

### D6 — The ported safety toolkit (the "safely" in headless-multi-agent)

1. **Git policy deny-list, reshaped for atmux's isolation model.** The plugin denied *all* git mutation because its members shared one working dir and only the lead committed. atmux members own a worktree and a `<base>-<member>` branch and self-commit/push (ADR-258 §D6a) — so the port denies the *forbidden classes*, not mutation per se: push to `main`/`master` (ADR-028), push to `*-staging` (global push policy), force-push / `git rebase` on shared branches (ADR-137), `reset --hard` / `clean` outside the member's own worktree, hook-bypass flags (global CLAUDE.md). Enforced in the backend's permission callback — deterministic, not prompt-level.
2. **Budget enforcement with auto-shutdown.** Per-member and per-team token/USD ceilings in config; the adapter tracks per-turn usage (plugin `cost-tracker.ts::isOverBudget` semantics) and on overrun emits `member.overloaded`-family telemetry, gracefully shuts the member down, and files a complaint (`sourceKind: "medic"`-adjacent vocabulary to be fixed in Phase 1) so the lead adjudicates. ADR-199's account-pool does not apply to third-party providers; this is its replacement on this backend.
3. **Model-escalation chain.** Per-member `escalationChain` (e.g. `deepseek → claude-sonnet → claude-opus`): on turn-error/refusal-threshold trip (the refusal machinery ADR-258's Amendment explicitly kept, fed by `stream()` text), respawn the member at the next chain level with the same brief and worktree (plugin `escalation.ts` semantics: retry-at-level first, then escalate). Cheap-by-default, frontier-on-proof-of-need.

### D7 — Per-member backend selection → mixed fleets

ADR-258 Phase 2's per-member selector does not exist yet; this ADR adds it: an optional per-member `backend` field in `team.json` (strict sub-block style, ADR-260 §D1 precedent) defaulting to `tmux-claude`. The economically interesting configuration becomes first-class: **Claude lead (judgment) + N headless cheap members (parallel grunt work)**, atmux doing the coordination neither model is asked to do. Lean rosters per ADR-258 §D6a apply unchanged.

### D8 — Not ported

Soft file locks (worktree isolation supersedes), task board / message bus / inbox / memo / templates (duplicates per the Context table), whip-monitor (ADR-237), the plugin's 12-tool lead-facing surface (atmux's lead already has the CLI).

## Migration

- **Phase A — OpenCode server API audit** (mirrors ADR-258 Phase 0): session create/resume, turn injection, SSE demux, permission callback surface, MCP attach, tool enumeration (D4 needs it), cost fields per provider, DeepSeek tool-call reliability probe on a fixed member-task set with a measured pass bar. Output: parity checklist + go/no-go.
- **Phase B — adapter + capability contract** behind per-member opt-in (D7 selector), no default change.
- **Phase C — MCP injection server** (D5) + safety policies (D6) + pilot: one headless DeepSeek member inside an otherwise tmux-claude team, then a full epic team.
- Default stays `tmux-claude` throughout; ADR-258's Phase-3 flip gates govern any future default change and are not relitigated here.

## Out of scope

Vendoring/submoduling the plugin; the `claude-agent-sdk` backend (ADR-258 Phase 2's own track); making OpenCode/DeepSeek mandatory for any role (ADR-258 Non-goals: never forced onto load-bearing work); upstream write-back of any kind; an attach-view for headless sessions (ADR-258 Phase 6).

## Open questions

1. OpenCode server API stability — is the session/SSE surface versioned, and which minimum OpenCode version is pinned?
2. The DeepSeek member-competence bar: which probe task set, what pass threshold, measured where? (Phase A output; no member role ships on a model that hasn't cleared it.)
3. Cost truth for non-models.dev providers — price-table maintenance burden vs. token-count-only budgeting.
4. Does the D5 MCP server reuse an existing implementation or land as a new `src/` surface? (Phase C decides; new decisions there get their own ADR if the surface grows.)
