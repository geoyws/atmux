# ADR-275 — External private Kanban is the sole work-state authority

Status: accepted (operator-direct, 2026-08-16)
Date: 2026-08-16
Relates: [ADR-267](267-durable-agent-continuity-contract.md), [ADR-271](271-sqlite-sole-store-rust-orchd-coordinator.md)

## Context

atmux currently owns project work state in each project's `.atmux/state.db`. That couples personal planning and agent continuity to the tmux/team lifecycle, duplicates work-state behavior across tools, and makes one person's cross-project view difficult. The operator has established `/root/work/src/kanban` as a private, SQLite-backed, multi-project work ledger and directed that agent handoffs—especially token-pressure replacement—also flow through it.

The existing atmux state cannot simply be deleted. Task CRUD, epic/story state machines, dispatch, cockpit views, hygiene ticks, approval checks, merge automation, and other secondary readers consume it. Removing the tables before those consumers have parity would lose behavior even if imported rows survived.

## Decision

### D1 — One authority

The external `kanban` repository and its private per-user SQLite registry/boards become the sole authority for epics, stories, tasks, claims, checkpoints, and agent handoffs. atmux becomes a client. It must not define a second authoritative work-state schema after cutover.

### D2 — Process adapter boundary

atmux calls the installed `kanban` CLI through a typed adapter. It does not link to Kanban's database schema or open Kanban board files directly. This keeps schema migrations, locking, privacy permissions, board discovery, and atomic leases owned by Kanban.

Process-boundary tests use only a nonblank `KANBAN_BIN` or a discoverable local `kanban` binary. They never fall back to `kb`, which may be an operator wrapper for the HAX-authoritative board. A missing local binary is reported as an explicit skip; recorded-fixture adapter tests remain runnable.

### D3 — No dual writes

Cutover uses an explicit backend selection. A command invocation reads and writes either legacy atmux state or external Kanban state, never both. Mirrored writes are forbidden because partial failure would create two plausible authorities.

### D4 — Migration stages and receipts

Removal proceeds only through these stages:

1. Inventory every direct and indirect legacy reader/writer.
2. Import `.atmux/state.db` read-only into an attached Kanban board and retain an immutable source backup plus import receipt.
3. Prove task, epic, story, hierarchy, dependency, claim, dispatch, handoff, dashboard, and automation parity against isolated fixtures.
4. Activate the external backend with a durable local marker and a documented rollback command.
5. Observe real use with integrity checks and no legacy writes.
6. Remove atmux Kanban tables, repository code, verbs that merely duplicate Kanban, and compatibility shims only after the observation receipt passes.

The implemented refresh path is deliberately explicit: `migrate-kanban
prepare --reconcile --writers-stopped` atomically refreshes an already imported
board and emits new source/board receipts. After activation and real external
use, `migrate-kanban observe --as <actor>` fingerprints only the legacy
task/epic/story rows, checks the external board, and refuses the deletion gate
if any legacy work-state row changed. Non-Kanban changes elsewhere in
`state.db` do not create a false failure.

The legacy database remains rollback material during stages 2–5. Activation is not authorization to delete it.

### D5 — Handoffs are Kanban records

Token pressure, provider limits, session end, and manual agent replacement create a durable Kanban checkpoint and handoff in the same transaction that releases the outgoing lease. The replacement accepts the handoff to obtain a fresh lease. Markdown or chat summaries may be projections, but are not the continuation authority.

### D6 — Private scope

Boards, registry entries, backups, cutover markers, and receipts are per-user local state and are not committed to project repositories or synchronized to teammates. Source code and ADRs describe the mechanism without containing board contents, lease tokens, credentials, or personal task data.

### D7 — Deletion gate

The old atmux Kanban implementation may be removed only when all of the following are evidenced:

- every inventoried consumer routes through the adapter or has been retired;
- imported record counts and relationships reconcile, with dangling legacy references explicitly reported;
- external-mode unit, integration, and real CLI smoke tests pass;
- the rollback backup reopens and passes SQLite integrity checks;
- an observation run finds no writes to the legacy work-state tables;
- lease tokens are emitted only by claim/accept operations and never by task, dashboard, or context views.

Until then, the feature flag is a development seam, not a production cutover claim.

## Consequences

- Personal work and handoff state becomes available across projects, worktrees, and agent sessions without being shared with developers or teams.
- atmux loses ownership of work-state storage and eventually becomes smaller.
- The migration is intentionally staged; duplicate code remains temporarily as rollback material.
- Some atmux concepts with redundant links or workflow-only statuses must be normalized into Kanban hierarchy and metadata rather than copied as a second schema.
- Operational receipts are required before deletion, so implementation takes longer than a direct table drop but protects active work.

## References

- `/root/work/src/kanban/docs/PRD.md`
- `/root/work/src/kanban/docs/adr/ADR-003-private-sqlite-multi-project-kanban.md`
- `/root/work/src/kanban/docs/adr/ADR-004-atomic-agent-handoffs.md`
- `/root/work/src/kanban/docs/adr/ADR-005-atmux-kanban-migration.md`

## §Amendment 2026-09-05 — `kb` host routing is supplied externally, not by atmux

`kb` host routing is supplied **externally**: the consumer-owned `hosts.tsv`
(`KB_HOSTS_TABLE`), read by the `kb-board`/`kb-host` wrappers from the pinned
public `geoyws/kb-skill` package, per kanban ADR-036. atmux carries **no** kb
host routing table and performs **no** pane injection for kb — board rule
`r-1376df29` bans `send-keys`, and lanes reach the ledger through the wrappers
or the `kb mcp` stdio server (`ssh <home> /root/.local/bin/kb mcp`). The D2
process adapter above calls the installed `kanban` CLI; it does not select a
kb host or route kb commands into panes.

**Cross-refs**: kanban ADR-036 (`hosts.tsv` / `KB_HOSTS_TABLE`); board rule
`r-1376df29` (send-keys ban); pinned public `geoyws/kb-skill` package
(`kb-board` / `kb-host` wrappers).
