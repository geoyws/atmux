# ADR-285: Cooperative `_bot` seats and the `_superbot` offer protocol

**Status**: accepted (operator-direct; source implemented, live activation held)
**Date**: 2026-08-28
**Driver-ref**: operator-direct — every persistent team needs an operator-cooperative bot window named exactly `_bot`; the cockpit needs `_superbot` immediately after `_medic`; `_superbot` should scan `/kb` every 30 minutes and offer actionable work to the owning team without preventing the operator from typing directly into `_bot`.
**Relates**: [ADR-239](239-three-driver-minimum-per-team-and-no-sendkeys-invariant.md) (drivers are operator-only and never receive automated send-keys), [ADR-261](261-issue-sync-external-tracker-ingestion.md) (external issue ingestion remains a separate adapter concern), [ADR-275](275-external-private-kanban-authority.md) (Kanban is the sole work/lease authority), [ADR-278](278-nullable-driver-agent-harness.md) (null harness means zsh), [ADR-279](279-declarative-operator-cockpit-windows.md) (cockpit ordering and non-destructive persistence)

## Context

Human drivers and ordinary members do not provide the desired shape. A driver is reserved for direct human interaction and is protected by ADR-239's lowest-level send-keys refusal. An ordinary member is lane-dispatched and brief-driven, while the requested bot must also remain a general-purpose pane the operator can use directly and in tandem with the human driver.

The fleet also needs one deterministic place to discover unattended work. That process must not become another task store, scheduler-specific ownership table, or external-issue scraper. Kanban already exposes atomic leases and the read-only `kb claim --candidates` surface. The installed Kanban 0.3.0 process was verified on 2026-08-28 to return canonically ordered claimable task records without mutating them.

The difficult boundary is input arbitration. `_superbot` may type an offer only when `_bot` is stably idle. It cannot prove that a human will not press a key in the instant after the final pane sample, so the design combines conservative two-sample readiness with an explicit operator hold. Uncertainty always defers; it never broadens eligibility.

## Decision

### D1 — `_bot` is a distinct cooperative seat

Add a typed top-level `team.json::bot` block. It is not a `DriverSession`, is not a member, is not included in lane dispatch, and does not weaken ADR-239.

```json
{
  "bot": {
    "enabled": true,
    "tui": "codex",
    "cwd": ".atmux/worktrees/bot",
    "claudeAccount": null
  }
}
```

The schema accepts `tui?: string | null` for migration parity. Null or omission starts zsh, as with nullable drivers, but makes the seat ineligible for automated offers because atmux cannot prove which harness—if any—the operator later started. Fleet migration must therefore choose an explicit harness alias and, where that harness uses it, an explicit account per team. Credentials and tokens are never stored in team or cockpit configuration. The first automated-offer implementation supports verified readiness only for Claude; other explicit harnesses remain valid for direct use but return `unsupported-verifier` until their real composer shapes are pinned.

V1 applies to persistent parent teams only. Spawned/transient teams do not inherit `_bot`; that would multiply idle harnesses and ownership routes without measured demand.

### D2 — Exact cage identity and lifecycle

The tmux window name is exactly `_bot`, the Kanban actor is exactly `bot@<team>`, the worktree is `<team-root>/.atmux/worktrees/bot`, and the branch is `<base>-bot`.

`atmux start` provisions the long-lived worktree with the existing worktree abstraction and launches the bot in tmux command mode. It creates `_bot` after every driver window and before ordinary member/service windows. A bare-shell bot remains directly usable by the operator but is reported as unroutable by doctor and `_superbot`.

The bot receives a harness-neutral boot contract: operator input is first-class; an offered task must be claimed exactly before its body is read; a refused claim stops; tracked source work uses checkpoints/handoffs; and Jira, GitHub Issues, IFCAX, or another external system is accessed only through its authorized skill/connector.

### D3 — Human input wins

Automated delivery requires all of the following immediately before send:

1. the configured `_bot` pane exists and its process is alive;
2. the configured harness is routable;
3. two bounded pane samples classify as the same idle/ready prompt;
4. the composer is empty, no queued-input marker is visible, and no modal, compaction, rate-limit, or active-turn marker is present;
5. the pane is not operator-held; and
6. `bot@<team>` owns no live Kanban lease.

Any failure returns a reason and defers until a later tick. The delivery path uses the existing verified/safe send abstraction with a defer-now mode; it does not wait for a busy pane to become free within the same tick.

`atmux bot hold [<team>]` and `atmux bot resume [<team>]` set/clear a pane-scoped tmux option. This is an availability interlock, not work state, and therefore does not duplicate Kanban. Operators use hold when they want to reserve an idle-looking bot through a long manual pause. Direct typing needs no mode switch.

### D4 — `_superbot` is deterministic infrastructure, not an agent

Add a typed top-level `cockpit.json::superbot` block:

```json
{
  "superbot": {
    "enabled": false,
    "shadow": true,
    "intervalMins": 30,
    "routes": [
      {
        "board": "atmux",
        "tag": "cockpit",
        "defaultTeam": "atmux",
        "fallbackTeams": []
      }
    ]
  }
}
```

Defaults are `enabled: false`, `shadow: true`, and `intervalMins: 30`. Route identity is `(board, tag)` because tag vocabularies are board-local. Each route names exactly one default team and an ordered, de-duplicated fallback list. Validation rejects duplicate route keys, duplicate teams within a route, unknown teams, non-parent teams, and a fallback equal to the default.

Cockpit order becomes `_superdriver`, optional `_medic`, `_superbot`, declarative operator windows, then parent-team viewers. When enabled, `_superbot` runs `atmux superbot run`: a deterministic scheduler/log surface with a singleton lock, not an LLM TUI. The same fence covers one-shot `tick` invocations so cron/manual overlap cannot reserve the same stale candidate twice. Reconcile preserves matching panes and does not activate the feature merely because the schema exists.

### D5 — Offer-and-pull protocol

Each tick, in declared route order:

1. asks the typed Kanban CLI adapter for `kb claim --candidates --project <board> --as superbot@cockpit --tag <tag> --json`, clearing ambient Kanban selectors first;
2. preserves Kanban's returned ordering and excludes `driverOnly`, non-task/non-todo, leased, dependency-blocked, explicitly incompatible-assignee, draft-ancestor, untagged, and unmapped records;
3. de-duplicates a task that matches multiple routes by `(board, task-id)`; the first declared route wins, which lets specific tags precede general ones;
4. offers a new candidate only to the first default owner;
5. after one complete configured interval, offers to the next not-yet-offered fallback; it never fans out multiple new offers for one task in one tick;
6. re-reads the task and the target bot's lease/readiness state immediately before every delivery; the lease guard covers every active canonical board in Kanban's workspace registry, plus configured route boards, so an operator-directed claim on an unrouted board still suppresses automation; and
7. writes a namespaced pending delivery reservation immediately before send, then converts it to a successful offer timestamp only after verified submission. Shadowed/deferred delivery writes nothing; an interrupted or unverified send leaves the pending marker, retries that same team once after one interval, then advances rather than pretending delivery succeeded.

`_superbot` never claims, assigns, moves, or completes a task. Ownership begins only when `_bot` successfully runs:

```text
kb claim <task-id> --project <board> --as bot@<team> --json
```

The offer contains no task body and no external-system data:

```text
[superbot offer] board=<board> task=<id> tags=<comma-separated-tags>.
FIRST ACTION ONLY: kb claim <id> --project <board> --as bot@<team> --json
If refused, stop. If granted, run kb ctx <id> --project <board>, obey its rules,
checkpoint as you work, and complete or hand off with the lease.
```

Atomic Kanban leasing resolves races: the first bot granted the exact-task lease owns it; every loser stops without reading the task body or touching source. `_superbot` never force-seizes an expired or live lease.

### D6 — Kanban and external issue boundaries

Kanban remains the only authority for atmux work ownership, claims, checkpoints, and handoffs. Offer timestamps are delivery audit/cooldown metadata only; they are not shadow ownership.

An operator may ask `_bot` to inspect Jira, GitHub Issues, IFCAX, or another authorized source before a Kanban task exists. Read-only triage can remain ad hoc. Before tracked source changes begin, the bot claims an existing linked Kanban row or creates/tags/claims one through the applicable project workflow, preserving the stable external key/URL as provenance. External comments, assignments, and status transitions obey that system's own authorization, deployment, and verification gates. `_superbot` does not scrape those systems in V1 and never carries their credentials, session material, issue bodies, or attachments.

### D7 — Held-back rollout phases

The phases are deliberately asymmetric. As of 2026-08-28, phases 1–6 have source/test/preparation receipts; phase 7 remains held:

1. **Contract** — ADR, schema/API shape, and docs. Held back runtime while the invariants were reviewed; now implemented.
2. **Seat** — `_bot` schema/lifecycle/hold/readiness with unit coverage and throwaway-socket ordering coverage. Held back scheduler delivery while the target remained independently reviewable; now implemented.
3. **Scheduler** — `_superbot` schema, installed-Kanban adapter, routing, shadow reports, singleton loop, cockpit placement, and unit/process integration coverage. Held back live defaults; it remains disabled + shadow unless explicitly configured.
4. **Shadow pilot** — process integration crosses the installed Kanban CLI on a disposable board for `cockpit`, `dispatch`, and `team-config`, proving zero sends and zero metadata writes. A read-only current-board receipt may be run separately; no live config is needed or changed.
5. **Isolated offer simulation** — one disposable Kanban board plus one explicit throwaway tmux socket proves hold deferral, manual-composer deferral, one verified multiline offer, the exact claim command, and direct typing after the offer. Unit coverage pins missing/dead/modal/rate-limit/busy/fallback cases, while concurrent real Kanban claims prove exactly one lease winner. Held back: runtime bot blocks and live cages.
6. **Parent-team migration preparation** — a validated, read-only renderer covers all 18 observed persistent teams and 95 exact `(board, tag)` owners while emitting only held JSON patches. Filesystem-only preparation normalized all present driver configs to nullable harnesses, aligned the Gitea and RX account commands with cockpit selectors, and linked RX's existing canonical config into its real root. Five configured roots are absent and remain explicit blockers. The mixed `fmx` board routes product tags to `fmx` and shared `security`/`tooling` tags to `aix`, rather than pretending the board has one repository owner. No `bot`/`superbot` runtime block, live cage, or cockpit was changed.
7. **Live activation** — a separate operator decision after receipts. It may install updated source, reconcile one pilot cage/cockpit, then expand one team at a time. This ADR and its implementation do not authorize that phase.

The holds isolate the three expensive failure classes: typing into human work, creating duplicate ownership, and changing tmux socket/session pointers while atmux itself is under development.

## Consequences

- Every persistent team can have one durable automation-capable worktree without turning a human driver into an automation target.
- The operator can use `_bot` manually before, between, and after automated offers; hold/resume gives a deterministic override for idle-looking pauses.
- Cross-board routing is explicit and auditable. Untagged or unmapped work remains visible as skipped instead of being guessed from titles, lanes, or repository names.
- A scheduler crash loses no ownership state. The next tick reconstructs eligibility from Kanban and delivery metadata.
- The cockpit gains one long-lived deterministic process while the default posture remains disabled/shadow. This is a narrow exception to the manual-orchestration default, not a revival of orchd.
- V1 does not create Jira/GitHub/IFCAX polling adapters, transient-team bots, implicit harness selection, or a second work database.

## Rejected alternatives

- **Send offers to drivers** — violates ADR-239 and collides with the operator's primary panes.
- **Make `_bot` an ordinary member** — incorrectly subjects it to lane dispatch, member briefs, and member lifecycle rules.
- **Let `_superbot` claim then assign** — turns delivery infrastructure into an ownership authority and can strand work when a pane is busy or dead.
- **Immediate fanout** — creates avoidable races and burns multiple harnesses on one task; default-first with one-interval fallback is quieter and inspectable.
- **Infer ownership from titles, paths, or lanes** — those fields are not a board-local subsystem vocabulary. `(board, tag)` is explicit.
- **Poll external trackers directly in `_superbot`** — duplicates issue-sync concerns and risks creating two representations of one issue.

## Acceptance gates

- Unit tests cover schema defaults/refusals, route union/order, cooldowns, offer redaction, hold state, all-registered-board lease suppression, and every readiness defer reason.
- Process integration tests cross the real installed Kanban CLI boundary for candidate discovery and concurrent exact-task claims.
- Isolated-tmux integration tests use throwaway sockets and prove cage/cockpit ordering plus direct typing, hold, and exactly-one-offer behavior. Unit tests cover busy/composer/modal/rate-limit/held/missing/dead refusal and fallback; process integration covers the real Kanban claim race. Driver send-keys protection remains covered by its existing ADR-239 tests and is structurally untouched.
- A process-level shadow receipt classifies every configured candidate without sending keys.
- Static migration validation proves the held plan contains one target `_bot` block for every observed persistent parent team and one default owner for every planned `(board, tag)`; it does not claim those blocks are installed. Transient teams remain excluded.
- No test is described as live E2E unless it crosses the actual live operator/system boundary. Unit, process-integration, and isolated-tmux layers are named as such.
- No install, deploy, cockpit reconcile, cage restart, or live tmux/socket mutation occurs without the separate activation decision in D7 phase 7.

## References

- Kanban roadmap: `e-5620bfc3`
- Protocol phase: `e-c573c5dd`
- Per-team seat phase: `e-b2ad39d0`
- Cockpit scheduler phase: `e-4616c137`
- Pilot/migration phase: `e-4b34332c`
- [`docs/RUNBOOK-cockpit.md`](../RUNBOOK-cockpit.md)
- historical superbot fleet-plan migration note under `docs/migrations/285-superbot-fleet-plan.md` (file not retained)
