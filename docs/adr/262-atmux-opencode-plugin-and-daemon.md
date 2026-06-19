# ADR-262: atmux as an OpenCode plugin + headless Rust daemon

**Status**: proposed
**Date**: 2026-06-13
**Driver-ref**: George 2026-06-13 — "let's make atmux headless as well instead of TUIs so there's less overhead and less issues. we could make atmux do a plugin as well with opencode so things are more seamless. make the plugin run in rust."
**Relates**: [ADR-258](258-vendor-agnostic-orchestration-agentbackend.md) (the `opencode-server` backend this ADR refines into a plugin+daemon architecture), [ADR-260](260-manual-orchestration-mode-default.md) (manual-mode default — the daemon runs the brain; the plugin is the TUI-side bridge), [ADR-257](257-eternal-improvement-burndown-first-worktree-isolated.md) (eternal-improvement — the daemon consumes idle capacity), [ADR-202](202-honker-in-db-messaging-substrate.md) / [ADR-203](203-event-topic-taxonomy.md) (Honker event substrate — moves into the daemon), [ADR-126](126-sqlite-state-store.md) (SQLite state — owned by the daemon), [ADR-162](162-atmux-owns-tmux-infrastructure.md) (tmux infrastructure — obsoleted by this architecture).
**Supersedes**: ADR-258 §D3.3 (replaces the monolithic `opencode-server` AgentBackend adapter with a split plugin+daemon design).

## Context

ADR-258 planned a vendor-agnostic AgentBackend adapter model, with `opencode-server` as the third backend implementation (Phase 5). That design treats opencode as just another agent runtime behind a uniform interface — one adapter among many.

The operator's 2026-06-13 directive re-architects this: instead of opencode being "one more backend", atmux should feel **native to opencode** — a plugin that registers its verbs as first-class tools, while a Rust daemon owns the heavy state machine. The rationale:

1. **OpenCode's plugin system is richer than a backend adapter needs.** OpenCode exposes 19 lifecycle hooks, an SSE event stream, a full REST API, and a `tool()` registration system. A thin plugin can bridge all of this to a Rust daemon, giving opencode users native `atmux_*` tools without leaving their TUI.
2. **Tmux was always the wrong abstraction.** ADR-258 §Context diagnosed this — "a large share of the machinery exists only to coax a human-oriented TUI." The plugin+daemon model eliminates tmux entirely from the critical path instead of wrapping it.
3. **Rust for the brain, TypeScript for the bridge.** The opencode plugin system is JS/TS only (Bun runtime, no Rust FFI). But the plugin gets a full `OpencodeClient` SDK — it can call a local daemon over HTTP/Unix socket. The daemon (Rust) owns the SQLite state, Honker events, kanban, team config, budget tracking, and session lifecycle. The plugin is a thin proxy.
4. **Headless by default.** The daemon manages agent sessions via `opencode serve`'s REST API — `POST /session/{id}/message` for prompts, SSE `/event` for streaming, `GET /session/status` for health. No tmux panes, no send-keys, no pane scraping. Optional human observability comes from opencode's own TUI or web UI.

## Decision

### (D1) Two-layer architecture

```
┌──────────────────────────────────────────────────────────────┐
│ OPencode TUI / opencode serve                                 │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ atmux OpenCode plugin (TypeScript, ~200 lines)      │    │
│  │                                                      │    │
│  │  tool: {                                            │    │
│  │    atmux_start, atmux_claim, atmux_done,            │    │
│  │    atmux_status, atmux_sync, atmux_push,            │    │
│  │    atmux_whip, atmux_flag, atmux_inbox ...          │    │
│  │  }                                                  │    │
│  │                                                      │    │
│  │  event: session.idle → deliver pending messages     │    │
│  │  event: session.error → classify + escalate         │    │
│  │  permission.ask → git safety + file locks           │    │
│  └──────────────┬───────────────────────────────────────┘    │
│                 │  HTTP calls to localhost:<daemon-port>      │
└─────────────────┼──────────────────────────────────────────────┘
                  │
┌─────────────────┼──────────────────────────────────────────────┐
│ atmux daemon (Rust, single binary)                             │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ HTTP server (axum/actix)                                 │ │
│  │  POST /tools/claim      POST /tools/done                 │ │
│  │  POST /tools/status     POST /tools/sync                 │ │
│  │  GET  /events/stream    (SSE — Honker topics)            │ │
│  │  POST /sessions/spawn   POST /sessions/message           │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐ │
│  │ SQLite state │  │ Honker events│  │ opencode serve client│ │
│  │ (kanban,     │  │ (NOTIFY/     │  │ (REST + SSE —        │ │
│  │  inboxes,    │  │  LISTEN)     │  │  spawn/stream/monitor│ │
│  │  cadence)    │  │              │  │  agent sessions)     │ │
│  └──────────────┘  └──────────────┘  └──────────────────────┘ │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ Session manager                                          │ │
│  │  - spawn member sessions via opencode serve SDK          │ │
│  │  - deliver messages via promptAsync                      │ │
│  │  - monitor health via SSE status/idle/error events       │ │
│  │  - track costs via message.updated events                │ │
│  │  - interrupt/abort/shutdown sessions                     │ │
│  └──────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
```

### (D2) The plugin layer — thin bridge, no business logic

The OpenCode plugin is a TypeScript module (`~200 lines`) that:

1. **Registers atmux verbs as OpenCode tools** via `tool()` — each tool's `execute()` makes an HTTP call to the daemon and returns the daemon's response text to the LLM.

2. **Forwards lifecycle events to the daemon** — `session.idle`, `session.error`, `session.status` hits are POSTed to the daemon so it can trigger message delivery, escalation, or health updates without tmux pane scraping.

3. **Enforces safety gates at the permission layer** — `permission.ask` rejects git-mutating commands (commit, push, merge, rebase, reset, clean, stash) on member sessions, matching the existing `opencode-plugin-orch` pattern.

4. **Supplies env vars** via `shell.env` — `ATMUX_MEMBER`, `ATMUX_TEAM`, `ATMUX_DAEMON_URL` injected into every shell call so the agent knows its role and where to reach the daemon.

The plugin carries **zero business logic** — no kanban, no state machine, no event routing. Every tool call is `fetch(daemonUrl + '/tools/<verb>', { body: JSON.stringify(args) })`.

### (D3) The daemon layer — Rust, all the brain

The Rust daemon (`atmuxd`) is a single binary that:

| Component | What it does |
|-----------|-------------|
| **HTTP server** | Exposes `/tools/*` endpoints for the plugin, `/sessions/*` for session lifecycle, `/events/stream` for SSE |
| **SQLite state** | Kanban (tasks/epics/stories), inboxes, member roster, team config, budget windows, cadence log |
| **Honker events** | In-process NOTIFY/LISTEN (no separate process needed — same SQLite connection); consumers are Tokio tasks |
| **opencode serve client** | REST client talking to `opencode serve` instances — one per worktree. Creates sessions, sends prompts, streams events, monitors health |
| **Session manager** | Lifecycle: spawn → boot (inject role brief) → monitor (SSE status/idle/error) → deliver messages → shutdown. Tracks per-session cost, rate-limit state, refusal patterns |
| **Budget tracker** | Weekly-window token tracking, pause@90%/resume@80%/swap@75% policy (reuses ADR-199 account-pool logic, ported to Rust) |
| **Eternal-improvement engine** | Per ADR-257: selects oldest open backlog items, routes to planner, spawns isolated worktree sessions |

The daemon talks to **multiple** `opencode serve` instances — one per worktree (the base team worktree + epic-team worktrees). Each instance is a separate `opencode serve --port <n>` process the daemon spawned or connected to.

### (D4) Zero tmux dependency

This architecture eliminates tmux from the critical path:

| What tmux did | What replaces it |
|---------------|-----------------|
| `tmux send-keys` to dispatch | `POST /session/{id}/message` (promptAsync) |
| `tmux capture-pane` to read state | SSE `session.status` / `session.idle` events |
| `tmux new-window` to spawn a member | `POST /session` (create session via opencode serve) |
| `tmux kill-window` to shut down | `DELETE /session/{id}` or `POST /session/{id}/abort` |
| Pane-state classification | `session.status` event (`idle` / `busy` / `retry`) |
| Cage socket isolation | opencode serve process isolation (one per worktree) |
| Window naming/ordering | Session title + in-memory roster ordering |
| `--permission-mode auto` / `BTab` dance | Plugin `permission.ask` hook auto-approves safe tools |

Obsoleted modules (matching ADR-258 §D5 + Amendment): `boot-claude.ts`, `safe-send.ts`, `known-modals.ts`, `modal-cycling-detector.ts`, `paste-submit.ts`, `pane-readiness.ts`, `pane-state.ts`, `cage-state.ts`, `tui-cmd.ts` shell-building, `claude-account-wrapper.ts` binary resolution.

### (D5) Dual-harness: same daemon, multiple frontends

The daemon's HTTP API is frontend-agnostic:

- **OpenCode plugin** — calls `/tools/*` from within an opencode session
- **Claude Code plugin** — the existing 13 slash-command skills (`plugins/atmux/.claude-plugin/`) can be re-pointed at the daemon instead of running bash verbs directly
- **CLI** — `atmux claim`, `atmux status` etc. become thin shell wrappers that `curl` the daemon
- **Web dashboard** — `GET /` serves a minimal status page

All four frontends share the same daemon, same SQLite state, same Honker events. A member spawned via opencode is visible to the Claude Code driver and vice versa.

### (D6) Relationship to ADR-258

This ADR **refines** ADR-258 §D3.3 rather than replacing the whole ADR:

- ADR-258's `AgentBackend` interface **survives** — it is the internal seam between the session manager and individual opencode serve instances. The daemon implements `AgentBackend` once (as `opencode-server`), not as one-of-many adapters.
- ADR-258's Phase 1-4 (tmux-claude wrapper → SDK backend → default-flip → delete epicycles) **still runs for Claude Code members**. This ADR adds a parallel track for opencode.
- The `claude-agent-sdk` backend (ADR-258 Phase 2) remains the path for Claude Code members. The daemon can drive BOTH opencode serve AND the Claude Agent SDK — same `AgentBackend` interface, different implementations.

What this ADR changes: `opencode-server` is no longer "just another AgentBackend adapter." It is the **primary integration surface** — a plugin that makes atmux feel native to opencode, backed by a Rust daemon that owns the state.

## Migration path

### Phase A — atmuxd daemon skeleton (this worktree)
- Rust binary with HTTP server (axum), SQLite (rusqlite), opencode serve client (reqwest)
- `/tools/status`, `/tools/claim`, `/tools/done` endpoints — read/write kanban
- `/events/stream` SSE endpoint — Honker topics
- No session spawning yet — CLI verbs work, plugin tools work

### Phase B — opencode plugin (parallel track)
- TypeScript plugin in `plugins/atmux-opencode/`
- Registers `atmux_*` tools, event hooks, permission hooks
- Calls daemon's `/tools/*` endpoints
- Ships as a local-path plugin (`"../../path/to/atmux/plugins/atmux-opencode"`)

### Phase C — session manager
- Daemon spawns opencode serve instances per worktree
- Member sessions created via `POST /session`, booted with role briefs
- Message delivery via `promptAsync`, health via SSE events
- Can run a full epic end-to-end with opencode members

### Phase D — retire tmux-claude (when ready)
- Claude Code members migrate to claude-agent-sdk backend (ADR-258 Phase 2-4)
- opencode members already on the daemon path
- Delete obsoleted TUI machinery
- tmux becomes optional attach-view only (ADR-258 §D4)

## Consequences

- **Net LOC down substantially** — the ~2,000 lines of TUI-control epicycles (safe-send, boot-claude, modals, paste-submit, pane-state, cage-state) deleted once no live backend needs them.
- **Headless by default** — the daemon runs without a terminal. Human operators attach via opencode TUI or web dashboard.
- **Cross-worktree orchestration** — the daemon targets multiple `opencode serve` instances (one per worktree), enabling epic-team fan-out without tmux cage isolation.
- **Rust type safety** — the state machine (kanban transitions, event routing, budget policy) benefits from Rust's ownership model and exhaustive match.
- **Plugin is replaceable** — if opencode's plugin API changes, only the thin TS bridge needs updating; the daemon's HTTP API is stable.
- **Dual-harness from day one** — the daemon serves opencode, Claude Code, and CLI frontends through the same HTTP API.

## Non-goals

- Not rewriting the existing Bun/TS atmux CLI — it continues to work, eventually becoming a thin `curl` wrapper.
- Not dropping Claude Code support — the daemon's `AgentBackend` interface serves both runtimes.
- Not making opencode mandatory — the operator chooses which runtime each member uses.
- Not building the plugin in Rust — opencode plugins are JS/TS only. The *brain* is Rust; the *bridge* is TypeScript. This is the correct separation.

## Open questions

1. Daemon-to-opencode-serve process model: one long-lived `opencode serve` per worktree, or spawn-on-demand per session? (Lean: one per worktree, shared across members of that worktree.)
2. Plugin distribution: ship as an npm package (`@atmux/opencode-plugin`) or as a local-path plugin bundled with the atmux source tree?
3. Daemon discovery: hardcoded `localhost:${ATMUXD_PORT}`, or Unix socket with well-known path?
4. State DB location: shared `~/.atmux/state.db` (one daemon serves all teams), or per-team `.atmux/state.db` as today?
5. orchd consumers: reimplement in Rust as Tokio tasks, or keep the Bun orchd process and have the daemon forward events to it?
