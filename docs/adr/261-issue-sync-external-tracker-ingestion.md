# ADR-261: issue-sync — external issue-tracker ingestion (GitHub / Azure DevOps) via poll → complaints → lead adjudication

> **Re-pointed 2026-06-19 by [ADR-263](263-great-simplification-tmux-harness-and-task-feed.md) §D3.** The ingestion **seam** here survives — the types-only `IssueTracker` interface, the poll-not-webhook stance, the `github`/`azure-devops` adapter house pattern, the `team.json` config block. The **downstream is replaced**: `poll → fileDedupedComplaint → complaint.filed (Honker) → consumer → tell-lead → lead adjudication` is cut along with the complaints + Honker substrate (ADR-263 §D4). New contract: **`poll → upsert Task`** (dedup keyed on `sourceId`; no complaints, no Honker, no lead, no auto-dispatch — feed-only). Read ADR-263 §D3/§D4/§D7 for the live design; the sections below describe the now-superseded complaints-routed downstream.

**Status**: proposed (downstream superseded by ADR-263 §D3; ingestion seam retained)
**Date**: 2026-06-12
**Driver-ref**: George 2026-06-12 — approved the issue-sync design direction: poll (no inbound HTTP), vendor-agnostic tracker adapter per the ADR-258 house pattern, intake through the existing complaints substrate, dual runtime home (manual verb on every team + orchd ticker for orchd-mode teams), lead adjudication unchanged, upstream write-back explicitly deferred. **Feature name is `issue-sync` — never "bugbot"**: [ADR-184](184-host-wide-epic-team-cap-queue-and-dormancy-audit.md) §Context lists `bugbot` as a separate project on the hax host (`atmux / unum / sopx / rentx / bugbot / fixer / mmx`); reusing the name for an atmux feature is forbidden load-bearing ambiguity (global CLAUDE.md §Language).
**Relates**: [ADR-258](258-vendor-agnostic-orchestration-agentbackend.md) (the vendor-agnostic adapter house pattern this ADR mirrors), [ADR-214](214-retire-ombudsman-lead-absorbs-complaint-adjudication-via-honker.md) (lead-gated complaint adjudication — the unchanged downstream), [ADR-150](150-cross-team-complaints-routing.md) (cross-team complaint storage residency — D1 one-row-one-DB, D5 refuse-on-ambiguous, D7 open-permission caveat), [ADR-203](203-event-topic-taxonomy.md) (closed topic set — deliberately NOT amended in v1), [ADR-202](202-honker-in-db-messaging-substrate.md) (the event substrate `complaint.filed` rides), [ADR-260](260-manual-orchestration-mode-default.md) (manual mode is the fleet default; orchd opt-in — why the runtime home is dual), [ADR-233](233-cron-auto-install-disabled-trust-orchd.md) ("orchd is the runtime, not cron" — why no OS crontab), [ADR-237](237-no-llm-discord-and-whip-removal.md) §D1 (no time-driven LLM cycles — the poll tick is deterministic), [ADR-192](192-cron-arm-idempotency-contract.md) / [ADR-197](197-cron-reaper-teardown-contract.md) (cron arm/teardown discipline — moot here because no crontab entry exists), [ADR-153](153-auto-promotion-rules.md) (the signal→complaint promotion family this joins), [ADR-028](028-main-master-pr-only-no-agent-push.md) (outbound-write gating spirit — governs the deferred Phase-3 write-back), superseded ADR-204 §Out-of-scope (the one prior mention: "Integration with issue trackers is out of scope" — this ADR is that integration).

## Context

Operators track bugs and feature asks in external trackers (GitHub Issues today; Azure DevOps work items for IFCA products). atmux has no path from "issue filed upstream" to "a team's lead sees it" — the relay is a human reading two tools. The 2026-06-12 research sweep (4-agent workflow, file:line evidence) established the ground truth this design builds on:

- **atmux has zero inbound HTTP surface.** A repo-wide grep for `createServer | Bun.serve | TcpListener | axum | warp | hyper | express | fastify` across `src/`, `scripts/`, `rust/` returns no server code; the only "listener" is the SQLite NOTIFY wake subprocess (`src/abstractions/native-listener.ts`, `rust/atmux-listener`). The single external integration is **outbound** Discord webhooks. A webhook receiver would be a brand-new surface class.
- **The complaints substrate is the designed intake for "things wrong that need adjudication"** and already has most of the right seams: provenance fields `sourceKind` / `sourceId` / `targetTeam` (`src/schema/complaints.ts:80-90`), the forward-compat `extra` JSON bag, the dedup-aware programmatic filer `fileDedupedComplaint` (`src/core/complaints.ts:98-170`, dedup keyed on `sourceId`), the `complaint.filed` event (`src/schema/events.ts:372-387`), and the registered consumer `atmux:complaint-consumer` (`src/core/orchd-bootstrap.ts:305-311` → `src/core/complaint-consumer.ts:57-100`) that routes to the target team's lead via `atmux tell-lead --team`. The lead adjudicates per ADR-214 §D2. **One advertised seam is design-only:** ADR-150 §D1's target-DB storage routing (`lookupTeamAtmuxDir` cockpit walk, `origin_team` column) was never implemented — issue-sync builds it as net-new Phase 1 code (D9).
- **The gaps an ingester must close**, none of which the substrate covers today:
  1. The dedup window is 1h (`DEFAULT_DEDUP_WINDOW_SEC = 3600`, `src/core/complaints.ts:30`) — tuned for whip strike-coalescing. A still-open external issue re-polled daily would insert a duplicate row per sync.
  2. orchd tick subverbs are hard-killed at `ATMUX_ORCHD_TICK_TIMEOUT_SECS` (default 900s, `rust/atmux-orchd/src/main.rs:74`, `run_tick_bounded` at `main.rs:1112`) — a paginating sync over a large repo must checkpoint and resume, not restart.
  3. ADR-233 made orchd the runtime, but ADR-260 (accepted today) makes **manual** mode the fleet-wide default — an orchd-only poller would be dormant on every current team.
  4. ADR-214 §D2 specifies a 1 complaint/min/team rate limit at the consumer, but the shipped consumer implements only bump suppression (`src/core/complaint-consumer.ts:63-71`) — a naive backfill of N open issues fires N `tell-lead` spawns.
  5. ADR-150 §D7's open permission model assumed a single-operator trust boundary; public GitHub issue bodies are attacker-controllable text flowing toward lead inboxes — a prompt-injection surface the complaints substrate has never had.
- **No prior decision exists.** The only mention in the ADR tree is superseded ADR-204's explicit punt. This ADR is the design-before-code record the binding discipline requires.

## Decision

### D1 — Poll, not webhook; all HTTP through `src/abstractions/http.ts`

v1 ingestion **polls** tracker REST APIs (GitHub REST, Azure DevOps REST). No inbound HTTP listener, no webhook receiver, no tunnel. All requests go through the house HTTP abstraction `src/abstractions/http.ts` (the ADR-003 typed-fetch wrapper — its header contract: "Domain code never calls `fetch` directly"; built-in timeout, 5xx-retry, status validation). No raw `fetch`, and **no `gh` / `az` CLI shell-outs** — the abstraction gates (fetch only in `http.ts`; `Bun.spawn` only in `src/abstractions/spawn.ts`) are reviewer-enforced, and a CLI dependency would add an external binary + auth-state surface for zero gain over REST.

### D2 — Vendor-agnostic `IssueTracker` adapter, per the ADR-258 house pattern

Mirror `AgentBackend` (ADR-258 §D2; `src/abstractions/agent-backend.ts` + `src/abstractions/backends/<id>.ts`) exactly:

- **Types-only interface file** `src/abstractions/issue-tracker.ts` defining the `IssueTracker` interface and a **`NormalizedIssue`** shape. Consumers see only normalized values — **provider-native frames never leak** past the adapter (same rule as ADR-258's normalized `AgentEvent` union).
- **Concrete adapters** land later in `src/abstractions/trackers/<id>.ts`, each with a **stable `readonly id`**: `"github"`, `"azure-devops"`. Jira et al are future adapters of the same interface — no interface change anticipated.

Indicative shape (Phase 0 fixes the exact types):

```ts
// Indicative — Phase 0 fixes the exact type. Per-adapter scope string:
// 'owner/repo' (github) | 'org/project' (azure-devops).
type TrackerScope = string;

interface NormalizedIssue {
  readonly trackerId: string;       // adapter id: 'github' | 'azure-devops'
  readonly sourceId: string;        // canonical identity (D3): 'github:owner/repo#123'
  readonly title: string;
  readonly body: string | null;     // UNTRUSTED (D7)
  readonly url: string;
  readonly state: "open" | "closed"; // normalized upstream state
  readonly labels: readonly string[];
  readonly author: string | null;
  readonly updatedAtSec: number;    // upstream last-modified, epoch sec
}

interface IssueTracker {
  readonly id: string;
  listIssues(scope: TrackerScope, cursor: string | null):
    Promise<{ issues: readonly NormalizedIssue[]; nextCursor: string | null }>;
}
```

### D3 — Intake = the existing complaints substrate; reuse `complaint.filed`

Ingested issues become **complaints**, filed programmatically via `fileDedupedComplaint` (`src/core/complaints.ts:98`) — not via the CLI verb (which has no dedup, `src/verbs/complaints.ts:308-393`):

- **`sourceId` = canonical external identity**: `github:owner/repo#123`, `ado:org/project/42`. One string format, used identically in the complaints row, the issue_sync ledger (D4), and event payloads. **The sourceId prefix is NOT required to equal the adapter id** (`azure-devops` adapter → `ado:` prefix), but the prefix↔adapter-id mapping is **1:1, frozen, and pinned in Phase 0** alongside the types — no adapter may mint a second prefix and no prefix may map to two adapters.
- **`sourceKind`**: new literals `"github"` and `"azure-devops"` appended to `COMPLAINT_SOURCE_KINDS` (`src/schema/complaints.ts:40-49`) in Phase 1. The DB column is free-form TEXT by design, so no migration; the allowlist append is verb-layer + documented-surface only (same-commit doc update per the binding discipline).
- **`extra` JSON bag** carries the tracker metadata: issue URL, labels, author, normalized upstream state, sync timestamps. `extra.severity` follows the existing `info | warn | urgent | critical` convention read by `extractSeverity` (`src/core/complaints.ts:174-178`), populated from the label→severity map (D10).
- **Event topic: REUSE `complaint.filed`.** No new topic, therefore **no ADR-203 amendment in v1** — the closed-set rule (ADR-203: "Adding a domain or topic requires ADR amendment") is satisfied by adding nothing. The consumer chain already exists end-to-end.

### D4 — Long-horizon idempotency: the `issue_sync` ledger table

The built-in 1h dedup window (`DEFAULT_DEDUP_WINDOW_SEC`, `src/core/complaints.ts:30`) only handles intra-burst coalescing. Long-horizon idempotency lives in a new **`issue_sync` ledger table** in the **POLLING team's** `state.db` (Phase 1 migration via `src/abstractions/sqlite-migrations.ts`), keyed on the canonical `sourceId`:

- **Residency, pinned:** the polling team's `state.db` owns the ledger AND the poll cursor; the complaint row goes to the **target** team's `state.db` per ADR-150 §D1. When D9/D10 set `targetTeam` ≠ polling team, these are **two different databases with no shared transaction**, and the `complaint_id` back-pointer crosses DBs — the matrix's refresh-extra and auto-resolve actions write into the target's DB from the poller.
- **Cross-DB write ordering (crash window):** filing is **ledger-first with a pending flag**: (1) INSERT the ledger row with `complaint_id = NULL`, state `pending`, in the poller's DB; (2) INSERT the complaint in the target's DB via `fileDedupedComplaint`; (3) UPDATE the ledger row to `filed` with the `complaint_id`. A tick kill (900s) or verb kill between steps leaves a `pending` ledger row, NOT an absent one — the next sync sees `pending`, looks up the target DB by `sourceId`, and either records the existing complaint's id or completes the file. This converts the crash window from "duplicate row + duplicate tell-lead whenever the 1h dedup window has lapsed" (an on-demand manual verb trivially exceeds 1h between runs) into a deterministic repair path.

- Columns (indicative): `source_id` PK, `tracker_id`, `complaint_id` (back-pointer to the filed row), `upstream_updated_at`, `upstream_state`, `local_resolution`, `last_synced_at` — plus a per-tracker/per-scope **poll cursor** row, **checkpointed per page**. orchd ticks are hard-killed at `ATMUX_ORCHD_TICK_TIMEOUT_SECS` (default 900s); a killed paginating sync must **RESUME from the last checkpoint, not restart** (the same lesson as buffered-spawn timeouts: failures are swallowed at the tick layer, so progress must be durable).
- Sync state matrix:

  | Ledger | Upstream | Action |
  |---|---|---|
  | absent | open | file via `fileDedupedComplaint` + record ledger row with `complaint_id` (write order: ledger-first `pending` → complaint → ledger `filed`, per the crash-window bullet above) |
  | absent | closed | record ledger row only — never file a complaint for an already-closed issue |
  | present, complaint open | open, unchanged `updatedAt` | no-op (advance `last_synced_at`) |
  | present, complaint open | open, newer `updatedAt` | refresh the existing row's `extra` via the `complaint_id` back-pointer — no new row, no new tell-lead |
  | present, complaint open | closed | **auto-resolve** the complaint, `resolvedBy = "tracker:<id>"` |
  | present, complaint auto-resolved by the tracker mirror (`local_resolution` provenance: `resolvedBy = "tracker:<id>"`) | open (upstream REOPENED) | **re-file** (or reopen the same complaint) + tell-lead — the mirror must be symmetric: what it auto-closed on upstream-close it surfaces again on upstream-reopen; otherwise a tracker reopen is buried forever |
  | present, complaint resolved/wontfix by the LEAD (`local_resolution` provenance: lead-authored `resolve`/`wontfix`) | open | **do NOT re-file** — the ledger records the lead-authored resolution; the lead's wontfix is not re-litigated by every poll |

The auto-resolve is a deterministic state mirror, not adjudication — it closes the loop downward only (upstream→atmux); the reverse direction is Phase 3 / deferred (D11).

### D5 — Runtime home is DUAL: manual verb + orchd ticker; no OS crontab

The ADR-233 ("orchd is the runtime, not cron") vs ADR-260 (manual mode default; orchd opt-in) tension is resolved by shipping both homes:

- **(a) Manual one-shot verb `atmux issues sync`** — works on **every** team regardless of orchestration mode. In manual mode the orchestrating LLM (lead/driver) or the operator runs it on demand; this is itself manual fleet management per ADR-260 §D2's carve-out for explicit invocation.
  - **Manual-mode delivery leg — the verb routes inline.** The `atmux:complaint-consumer` is registered only by `bootstrapOrchd` (`src/core/orchd-bootstrap.ts:305-311`); on a manual-mode team `complaint.filed` is emitted but **nothing consumes it** (ADR-260 §Consequences). So the verb performs the consumer-equivalent routing itself: after the ledger reconcile, for each NEWLY-filed (non-bumped) complaint whose **target team** is not running orchd (`orchestration.mode !== "orchd"`), the verb spawns `atmux tell-lead --team <target>` directly — same message shape as `src/core/complaint-consumer.ts::formatComplaintMessage`, and subject to the same D8 flood rules (a backfill-sized sync sends ONE summary tell-lead, never N). When the target team IS orchd-mode, the verb skips inline delivery and lets the event-driven consumer fire — never both, so no double-ping.
- **(b) orchd in-process ticker subverb `--poll-issues`** (Phase 2) — a new `run_tick_bounded` ticker in `rust/atmux-orchd/src/main.rs` (pattern: the existing 5-min sweep / 15-min budget-scan tickers at `main.rs:936-1018`) firing `atmux orchd --poll-issues --team-dir <dir>` (Bun subverb modeled on `orchdScanBudgetCli`, `src/verbs/orchd.ts:868`). Runs only for `mode: "orchd"` teams, gated like every other orchd consumer (ADR-260 §D2). **Gate coupling caveat:** the orchd window itself only spawns when `orchestration.mode === "orchd"` AND `autoMerge.enabled === true` AND `ATMUX_HONKER` is not off (`src/core/orchd-window.ts:93-127`, per ADR-259/260) — so orchd-driven issue polling silently inherits the auto-merge requirement. Phase 2 must either document this coupling as accepted or relax the `autoMerge` gate for the ticker.
- **NO OS crontab entry.** ADR-233 disabled cron AUTO-INSTALL only (its §D3/§D5 explicitly kept the cron-install verb callable); the deletion of the cron source surface itself is recorded in ADR-237 §Context (superseding ADR-233 §D5's stays-callable posture). With the source surface gone, ADR-192/197 discipline never engages — the ticker dies with the orchd process, and the manual verb has no cadence to arm.
- **Deterministic end-to-end** per ADR-237 §D1: the poll tick is fetch → ledger reconcile → file → tell-lead, all deterministic code. **No time-driven LLM cycles, ever** — the only LLM in the loop is the lead reading its inbox on its own turn (D6).

### D6 — Adjudication unchanged: the lead decides

On orchd-mode teams, ingested issues ride the existing chain untouched: `complaint.filed` → `atmux:complaint-consumer` → `atmux tell-lead --team <target>`. On manual-mode teams (where that consumer is never registered), the verb's inline routing leg (D5a) delivers the identical `tell-lead --team <target>` ping. Either way the LEAD's Claude decides **promote-epic / file-task / wontfix / already-addressed / escalate** (`templates/briefs/lead.md` §Complaint-adjudication). ADR-214's explicit rejection of LLM auto-adjudication is **preserved** — issue-sync never auto-converts an external issue into a kanban epic/task; conversion is a lead judgment recorded via `relatedTaskId`, exactly as for every other complaint source.

### D7 — Security: external issue bodies are UNTRUSTED input

A public GitHub issue body is attacker-controllable text on a path that terminates in a lead's inbox — a prompt-injection surface (and the trigger ADR-150 §D7 anticipated when it called its open permission model single-operator-only). Mitigations, all v1:

1. **The tell-lead line carries only a truncated, sanitized title + the complaint id** (+ severity/source). The body rides only in `extra` — the lead reads it deliberately via `atmux complaints list --json` / `show`, never as injected inbox prose.
2. **Per-repo/per-project allowlist** in `team.json` (D10): issue-sync polls only explicitly configured repos/projects; there is no "discover everything the token can see" mode.
3. **Read-only token scopes** required (GitHub: a **fine-grained** token with read-only Issues permission — classic-token scopes are coarse `repo`/`public_repo` with no read-only issues variant, so classic tokens are discouraged; ADO: work-items read). v1 has no write path to protect, and a leaked read-only token caps the blast radius.
4. **Token resolution via the house 3-tier cascade** (pattern: `resolveWebhookUrl`, `src/abstractions/discord.ts:630-671`): env `ATMUX_GITHUB_TOKEN` / `ATMUX_ADO_TOKEN` → `team.json` field → `${XDG_CONFIG_HOME:-~/.config}/atmux/<tracker>-token` file.
5. **Tokens NEVER on argv** — tmux pane capture records command lines, and pane-state redaction (`src/core/pane-state.ts:223-233`) is observability, not a security boundary. Tokens pass via env or config file only.

### D8 — Backfill flood control (Phase 1 — ships WITH the verb, not after it)

First sync of a repo with N open issues must not fire N tell-leads against ADR-214's 1-complaint/min/team intent (the shipped consumer has **no** rate limiter — only bump suppression, `src/core/complaint-consumer.ts:63-71`, so the flood is real). Because the GitHub adapter + `atmux issues sync` land in Phase 1, the flood control **must land in the same phase** — the first sync of any nontrivial repo IS the backfill case, and phasing the guard after the verb would ship exactly the gap Context #4 names. Two pieces, both Phase 1:

- **First-sync guard (default-on):** the verb refuses to file more than K new complaints in one sync without `--backfill` (K configurable via `issueSync`, default 10) — it prints the count and exits non-zero, so an unguarded first run can never flood.
- A `--backfill` quiet mode:
  - files the complaint rows + ledger entries normally, but with **event-routing suppression** — the bumped-suppression mechanic at `src/core/complaint-consumer.ts:63` is the hook (backfill-filed events are marked so the consumer skips per-row tell-lead, exactly as `bumped: true` events are skipped today); the D5a inline leg applies the same suppression on manual-mode targets;
  - sends **ONE summary tell-lead** at the end ("issue-sync backfill: N issues from <repo> filed as complaints — `atmux complaints list --source-kind github`").

### D9 — Cross-team routing per ADR-150: one row, one DB, refuse-on-ambiguous

The complaint row for an ingested issue lives in **EXACTLY ONE** `state.db` — the target team's (ADR-150 §D1 no-dual-write invariant). The tracker→team routing config (D10) must resolve each polled repo/project to exactly one team; ambiguity (a repo mapped to two teams, or a target-team name with multiple cockpit matches) is a **refusal with a clear error**, never a silent first-pick (ADR-150 §D5 lock-in). Cross-team delivery then rides the existing consumer's `tell-lead --team <target>` unchanged (on orchd-mode targets; manual-mode targets get the D5a inline leg).

**ADR-150's storage-routing leg is accepted DESIGN, not shipped code — issue-sync builds it.** A grep of `src/` finds no `lookupTeamAtmuxDir`, no `origin_team` column, and no target-DB write routing; today `atmux complaints file` writes the **cwd team's** DB and merely stamps `targetTeam` (`src/verbs/complaints.ts:308-393`). Only the consumer-side `tell-lead --team` leg exists (`src/core/complaint-consumer.ts:74-86`). The target-team `atmuxDir` resolution (cockpit-registry walk + refuse-on-ambiguous, per ADR-150 §D5 semantics) is therefore a **net-new Phase 1 deliverable** (D11), not substrate to look up and find.

Refuse-on-ambiguous is **per-team-config only**: nothing stops two DIFFERENT teams' `issueSync` blocks from each polling the same repo (same or different `targetTeam`), double-filing the same `sourceId` across two ledgers. v1 accepts this as an operator-config responsibility; a fleet-wide doctor probe ("same repo in >1 team's `issueSync`") is a cheap future add.

### D10 — `team.json::issueSync` strict sub-block

Configuration follows the ADR-260 §D1 strict-sub-block precedent (siblings: `orchestration` / `autoMerge` / `whip` / `leadStallWatchdog`). **Optional** — absent block ⇒ issue-sync disabled; every existing `team.json` parses unchanged. Indicative shape (Phase 0 fixes the Zod schema):

```jsonc
"issueSync": {
  "trackers": [
    {
      "id": "github",                       // adapter id (D2)
      "repos": ["geoyws/atmux"],            // allowlist (D7.2)
      "targetTeam": "atmux"                 // routing (D9) — must resolve unambiguously
    }
  ],
  "labelSeverity": { "p0": "critical", "bug": "warn" },  // → extra.severity (D3)
  "poll": { "intervalSec": 900 }            // orchd ticker cadence (D5b)
}
```

### D11 — Phasing

- **Phase 0** — this ADR + the types-only `src/abstractions/issue-tracker.ts` interface + the `issueSync` config schema + `docs/RUNBOOK-issue-sync.md`. No behavior.
- **Phase 1** — GitHub adapter (`src/abstractions/trackers/github.ts`) + `atmux issues sync` verb (with the D5a inline tell-lead leg for manual-mode targets) + **D8 flood control (`--backfill` quiet mode + the first-sync K-guard — same phase as the verb that causes the flood)** + **target-team `atmuxDir` resolution (cockpit-registry walk + refuse-on-ambiguous per ADR-150 §D5 semantics — net-new code; the ADR-150 helper was never implemented, see D9)** + the `issue_sync` ledger migration + `COMPLAINT_SOURCE_KINDS` append + tests (same-commit, per house rules).
- **Phase 2** — Azure DevOps adapter + orchd `--poll-issues` ticker.
- **Phase 3** — upstream **WRITE-BACK** (close/comment on the tracker when the lead resolves) — **explicitly DEFERRED to its own future ADR.** Writing to an external system the operator's stakeholders read is a different risk class; it gets explicit outbound-write gates in the spirit of ADR-028 (agents never push `main` / never merge PRs without per-action human authorization). Until then, `resolve` emits no event and issue-sync is strictly downstream (upstream→atmux).

## Out of scope

- **Webhooks / any inbound HTTP surface** — rejected for v1 (see Alternatives); revisit only via a new ADR if poll latency ever matters.
- **Upstream write-back** (closing/commenting/labeling tracker issues from atmux) — Phase 3, own ADR (D11).
- **LLM auto-triage** of ingested issues (auto-promote to epic/task, LLM severity scoring) — contradicts ADR-214's ratified rejection; the lead-gated path is the design.
- **Jira (and other trackers)** — future adapters of the D2 interface; no interface change anticipated, no v1 work.
- **New event topics** (`issue.ingested`, `issue.synced`, `complaint.resolved`) — v1 reuses `complaint.filed`; the ADR-203 closed set is untouched.

## Alternatives considered

1. **Webhook listener** (GitHub/ADO push to an atmux HTTP endpoint) — **rejected.** atmux has zero inbound HTTP surface today (Context); a listener is a brand-new surface class dragging in traefik routing, wildcard-TLS, host exposure, endpoint auth, and replay protection — for latency v1 doesn't need. Polling fits the existing infra exactly.
2. **`gh` / `az` CLI shell-out** — **rejected.** Violates the abstraction gates (fetch only in `http.ts`; spawns only via `spawn.ts` — the ADR-003 lineage), adds an external binary dependency with its own auth state, and the REST APIs through `http.ts` (typed, timeout, retry) cost the same to call. The only in-tree `gh` precedent is PR-mode preflight assertions (ADR-090 §10), a different concern.
3. **New `issue.ingested` topic + dedicated consumer** — **rejected for v1.** ADR-203's closed set requires an amendment ADR for any new topic, and `complaint.filed` already carries everything needed (`sourceKind` / `sourceId` / severity / bumped) with a production consumer wired end-to-end. A new topic buys nothing in v1; if write-back (Phase 3) needs `complaint.resolved`, that future ADR mints it.
4. **Vendoring an external tracker client library** (octokit, azure-devops-node-api) — **rejected.** atmux's runtime dependency set is `{ zod }` (ADR-258 §Context); the polled surface is a handful of paginated GET endpoints that `http.ts` covers, and a vendored client would leak provider frames the D2 adapter exists to contain.

## Consequences

**Positive**

- External issues reach the right team's lead with zero human relay — via the event consumer on orchd-mode teams, via the verb's inline tell-lead leg (D5a) on manual-mode teams. Net-new code is one interface, adapters, a ledger, a verb, **and the ADR-150 §D5 target-team resolution helper (cockpit walk + refuse-on-ambiguous), which ADR-150 designed but never shipped** (D9).
- The adapter seam makes Jira/Linear future-cheap, mirroring the ADR-258 pattern reviewers already know.
- The ledger gives exactly-once *filing* semantics over an at-least-once event substrate, and survives tick kills (page-checkpointed cursor).
- Manual-mode teams (the fleet default per ADR-260) get full functionality from day one via the verb — including lead notification, because the verb carries the inline tell-lead leg (D5a) that substitutes for the orchd-only `atmux:complaint-consumer`; orchd-mode teams get hands-off polling in Phase 2.

**Negative / risks**

- Poll latency (minutes, not the ~1ms webhook ideal) — acceptable: complaint adjudication is lead-turn-paced anyway.
- Two new lead-inbox traffic sources; mitigation is D8 backfill quiet mode + the ledger's no-re-file rules (a noisy repo bumps `extra`, it does not re-ping).
- Severity mapping is convention-only (`extra.severity` is not a column, and three vocabularies coexist in-tree); D10's `labelSeverity` map documents the binding one (`info|warn|urgent|critical` per `extractSeverity`).
- The auto-resolve path (`resolvedBy: "tracker:<id>"`) writes complaint status without lead involvement — deliberate (it mirrors upstream fact, not judgment), but it is the first non-actor `resolvedBy`; the runbook must say so. `docs/RUNBOOK-issue-sync.md` must also note the race: the tell-lead inbox line from filing survives a later tracker auto-resolve, so a lead may open an already-resolved complaint — harmless (resolve is idempotent; `complaints show` displays the current status), but worth a sentence so leads aren't surprised.

**Reversibility: HIGH.** Yanking issue-sync = remove the verb + ticker + adapters + config block; the `issue_sync` table is leaf-additive; filed complaints remain ordinary complaint rows (`sourceKind: github` is just TEXT) and adjudicate normally. No event-schema or topic changes to unwind.

## Open questions

1. Per-page checkpoint granularity vs API rate budgets (GitHub 5k req/h authed) — Phase 1 measures before fixing the cursor shape.
2. Does `--backfill` suppression reuse the `bumped` field or a sibling `suppressRouting` payload field? (Payload is `.passthrough()`, so additive either way; Phase 1 decides — `--backfill` ships with the verb per D8 — no topic change in either case.)
3. Should the manual verb print a lead-actionable digest (mini-D8) even for small non-backfill syncs? Lean: yes, stdout only, no extra tell-lead.
