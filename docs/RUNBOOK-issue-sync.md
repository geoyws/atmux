# RUNBOOK — issue-sync (git task source)

Operator-facing reference for **`atmux issues sync`** — polling a watched git repo's issues/PRs into the task feed. See [ADR-263 §D3](adr/263-great-simplification-tmux-harness-and-task-feed.md) for the live design and [ADR-261](adr/261-issue-sync-external-tracker-ingestion.md) for the original ingestion seam (its complaints-routed downstream was retired by ADR-263; the `IssueTracker` seam survives).

> **Re-pointed 2026-06-19 (ADR-263 §D3).** The old contract was `poll → complaint → lead adjudication`. The new contract is **`poll → upsert Task`** — feed-only. There is no complaints substrate, no Honker, no lead, no auto-dispatch. A task lands in the feed; a Claude pane (or you) picks it up via `atmux claim --next`.

> **Name discipline:** the feature is `issue-sync` — never "bugbot". [ADR-184](adr/184-host-wide-epic-team-cap-queue-and-dormancy-audit.md) lists `bugbot` as a separate project on the hax host; reusing the name is forbidden ambiguity.

## §1 — What issue-sync is

A deterministic **poll → upsert** pipeline (no LLM in the loop; no daemon):

1. **Poll** the configured repos' REST APIs through `src/abstractions/http.ts` (no inbound HTTP, no webhooks, no `gh`/`az` shell-outs) via the vendor-agnostic `IssueTracker` adapter (`src/abstractions/issue-tracker.ts` + `src/abstractions/trackers/github.ts`).
2. **Upsert** each matching issue/PR as a task in the team's `state.db`, deduped on the canonical `sourceId` (`github:owner/repo#123`). Re-polls update the same row; they never duplicate. A per-source watermark (max upstream `updatedAt`) is checkpointed in `state_kv` so subsequent polls are incremental.
3. **Reconcile closes** (when `state: "all"`/`"closed"` and `onClose: "done"`): a still-`todo` task whose issue closed upstream is moved to `done`. An in-progress / blocked / already-done task a pane owns is never yanked.

That's it. The task is now in the feed; the work loop (`atmux claim --next` → work → `atmux done`) takes over. issue-sync never spawns a pane, never assigns work, never writes back to the tracker.

**Phasing** (ADR-263 §D3):

| Phase | Ships | Status |
|---|---|---|
| 1 | GitHub adapter + `atmux issues sync` verb + dedup + watermark + close-reconcile | **landed (P3)** |
| 2 | Azure DevOps adapter (the `TrackerId` union + `ado:` prefix are already reserved in the seam) | not landed |
| 3 | Upstream write-back (close/comment on the tracker) | **deferred — own future ADR** |

## §2 — Configuration

### `team.json::taskSources` (optional, strict per-entry)

Absent ⇒ no git source (sqlite tasks only); every existing `team.json` parses unchanged. Schema: `TaskSource` in `src/schema/team.ts`. Unknown keys are refused, not ignored.

```json
"taskSources": [
  {
    "provider": "github",
    "scope": "owner/repo",
    "labels": ["bug"],
    "state": "open",
    "onClose": "done",
    "lane": "be",
    "priority": 2
  }
]
```

| Field | Meaning |
|---|---|
| `provider` | Tracker adapter. `github` only today (the seam is vendor-agnostic). |
| `scope` | `owner/repo`. |
| `labels` | Optional. Only issues carrying **all** of these labels (GitHub's native `labels` AND filter). Omit for all matching-state issues + PRs. The common case is one label. |
| `state` | `open` (default), `closed`, or `all`. Use `all` to see closes (for `onClose`). |
| `onClose` | `done` (default): move a still-`todo` task to `done` when its issue closes (requires a state that sees closes). `leave`: never auto-mutate. |
| `lane` | Optional lane stamped on created tasks. |
| `priority` | Optional integer priority stamped on created tasks (lower = higher). |
| `token` | Optional GitHub token literal (least-preferred tier — see below). |

### GitHub token (optional)

Public repos work unauthenticated (60 req/hr). A token raises the limit to 5000/hr and reads private repos. A **read-only fine-grained token** (Issues: read) is sufficient. Resolution order (first hit wins):

1. `ATMUX_GITHUB_TOKEN` environment variable;
2. `team.json::taskSources[].token` literal;
3. `~/.config/atmux/github-token` (or `$XDG_CONFIG_HOME/atmux/github-token`), contents trimmed.

Tokens are **never** passed on argv (tmux pane capture records command lines).

## §3 — Running

No daemon — run it by hand or from cron (OS crontab; see [ADR-192](adr/192-cron-arm-idempotency-contract.md) for arm idempotency).

```bash
atmux issues sync                      # poll every configured source
atmux issues sync --source owner/repo  # poll just one (by scope)
atmux issues sync --dry-run            # fetch + report counts, write NOTHING
atmux issues sync --team-dir /path     # explicit project root
```

Output is one summary line per source:

```
synced github:owner/repo — fetched 12, created 3, updated 1, closed 2
```

`--dry-run` prints `would sync …` and persists nothing (no task rows, no watermark) — the safe first pass.

### Cron example (every 15 min)

```cron
*/15 * * * * cd /path/to/project && /root/.bun/bin/atmux issues sync >> ~/.atmux/issue-sync.log 2>&1
```

## §4 — Behavior details

- **Dedup** is keyed on `sourceId` (`github:owner/repo#123`), backed by the partial-unique `idx_tasks_source_id` index (sqlite-migrations v16→v17). The index binds only sourced tasks; manual tasks (NULL `source_id`) are unconstrained.
- **Created** tasks start `todo`, unowned, with `sourceKind`/`sourceId` set and a body that carries provenance (url, labels, author) plus the upstream body fenced under an `UNTRUSTED` banner.
- **Refresh:** an open issue whose title/body changed upstream refreshes the task's subject/body. Status, owner, lane, and priority are preserved — your claim is authoritative. A `done` task is never refreshed or re-opened.
- **Closes** are reconciled only when the configured `state` lets the poll see closed issues (`all` / `closed`) and `onClose: "done"`. Only `todo` tasks are auto-closed.
- **PRs** are kept (a GitHub PR is an issue with a `pull_request` marker) and flagged `pull-request` in the task body.
- **Per-issue errors** (e.g. a corrupt pre-existing row) are non-fatal: the sync records the error, prints it as a stderr `! …` warning, and continues. The verb still exits 0 on a completed run.
- **Pagination** walks every page (GitHub `Link` header), capped at 500 pages as a runaway backstop (a cap hit is reported as a warning).

## §5 — Security: prompt injection (residual risk)

Public issue/PR bodies are **attacker-controllable text** that flows into task bodies a Claude pane will read (ADR-263 §D3). The sync engine fences the upstream body under an explicit `UNTRUSTED` banner — it is data, not instructions — but a pane's prompt must treat ingested bodies accordingly. This is a **documented, unsolved residual risk**. Point `taskSources` at public repos with that in mind; a follow-up ADR may harden it.

## §6 — Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `issues sync: no taskSources configured` | Add a `taskSources` array to `team.json`. |
| `no taskSource with scope "X"` | `--source` must match a configured `scope` exactly. |
| `HTTP 401` / `403` rate-limit | Set `ATMUX_GITHUB_TOKEN` (or the file). 403 with a reset header = rate limit; 401 = bad token. |
| `invalid scope "…"` | `scope` must be `owner/repo` (no extra slashes). |
| Closes not reconciled | `state` must be `all` or `closed` to see closed issues; `onClose` must be `done`; only `todo` tasks auto-close. |
| Re-runs re-fetch everything | Expected on the first run (no watermark); subsequent runs are incremental via the `state_kv` watermark. Deleting the watermark row forces a full walk. |
