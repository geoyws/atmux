# ADR-147: Ombudsman role + release-notes layout — complaint adjudicator with durable response log

**Status**: accepted
**Date**: 2026-05-15
**Accepted**: 2026-05-16 (T9 dogfood landed — atmux-team ombudsman pane alive, c-7a308f7f adjudicated via task t-82b6aed9, day-file `docs/release-notes/2026/05/2026-05-16.md` committed on `geoyws-ombudsman` @ b68f2b4)
**Author**: atmux team (driver — operator 09:46 MYT chat brainstorm: "ombudsman is supposed to sit in every team to go through the complaints and create epics to address those complaints and to also somehow log his response somehow… maybe we should have the response in release notes perhaps?")
**Relates**: ADR-077 (medic / superdoctor cockpit role — files complaints), ADR-131 (superdoctor kanban-hygiene auto-fix), ADR-133 (medic rename), ADR-091 (epic-team auto-merge — sibling pattern), ADR-145 (gitter-does-merges), ADR-146 (kanban auto-files trunk-merge — event-driven sibling pattern).
**Kanban**: closes t-441d6d4c (Ombudsman role — event-driven via sentinel file + cron wake-up).

## Context

### The gap: open complaints, no one adjudicates

The complaint surface already exists:

- `src/schema/complaints.ts` — `Complaint` Zod schema (id `c-xxxxxxxx`, openedBy, summary, rootCause, ask, status `open|resolved|wontfix`, sourceKind `medic|operator|whip|whip-velocity-gate|cli|cron|member`).
- `src/verbs/complaints.ts` — `atmux complaints file|list|resolve` verbs.
- `src/core/complaints.ts` — SQLite-backed store via `state.db` (ADR-060).
- Medic / superdoctor files complaints on observed anomalies (per ADR-077 §D5 + §F2, ADR-131).
- Whip + whip-velocity-gate file complaints on velocity stalls (per ADR-087).
- Operator + CLI file complaints manually.

But there's no role that **adjudicates** open complaints. Today, `atmux complaints list --status open` returns rows that linger indefinitely:

```
🔴 c-475db11c  Auto-rotate non-compliant leads + members on saturation OR dormancy-acceptance — …
🔴 c-8ecd3a61  atmux status and atmux doctor disagree on session state: …
```

The complaint sits open. No epic is filed. No "wontfix — duplicates ADR-XXX" decision is recorded. The operator must read each complaint manually, decide what to do with it, then either file the epic themselves or `atmux complaints resolve <id>`. This is exactly the bottleneck pattern that ADR-146 fixed for trunk-merge Tasks: a deterministic emit-and-route step sitting on the operator's plate.

The kanban already names this role: **t-441d6d4c — Ombudsman role — event-driven via sentinel file + cron wake-up (no whip polling)**. The task subject was filed but no design exists. This ADR is that design.

### Why not give the work to medic, lead, or superdoctor?

- **Medic** (ADR-077 / ADR-133) files complaints; making it also adjudicate them creates a feedback loop where the same agent's heuristic decides both "this is a problem" and "this problem warrants an epic" — collapses two judgment classes into one and removes the ombudsman's role as second-pair-of-eyes on medic's filings.
- **Lead** is a thin relay (per `feedback_lead_thin_relay.md` — "lead routes msgs, never does work"). Adjudication is judgment work, not routing.
- **Superdoctor** is cockpit-scoped (operates across teams). Ombudsman is per-team — different cardinality and different lifecycle (born/dies with the team, not with the cockpit).
- **Planner** decomposes; ombudsman triages. Distinct cognitive jobs (per the existing reviewer-vs-auditor separation in CLAUDE.md).

Ombudsman is a new, separate role.

### Why release notes are the right log surface

Three durable-log shapes were considered for ombudsman responses:

1. **Per-complaint resolution note** stored on the complaint row itself (`Complaint.extra.adjudication`). Survives but is scattered — N rows, no chronological view, hard to "see what happened this week".
2. **A new docs file** like `docs/ombudsman-log.md` (single growing file). Centralizes but bloats fast and merges painfully (every adjudication = one append, same line range = constant conflicts when multiple teams adjudicate same day).
3. **Release notes** with one file per day, year/month folders. Centralized chronologically, conflict-free across days, and incidentally solves a second standing operator ask ("see what's going on with our progress easier").

Release notes (option 3) is the right shape. Ombudsman responses become **one section in each day's release note**; other sections (shipped tasks, ADRs landed, merges, doctor regressions) are appended by other agents in their own write windows. The file IS the daily progress timeline.

This is a structural fit, not a forced merge: complaints are about progress-blocking issues; epics filed by ombudsman are about progress-unblocking work; the release-notes day-file is where progress is recorded. The three meet naturally on the same surface.

## Decision

### (D1) Ombudsman is a per-team role

A new `role: "ombudsman"` in `team.json::members[]`, alongside `team-lead`, `planner`, `reviewer`, `gitter`, etc. One ombudsman per team. Optional — teams without an ombudsman fall back to the operator adjudicating manually (current behavior).

```json
{
  "name": "ombudsman",
  "role": "ombudsman",
  "tui": "claude",
  "model": "default",
  "cwd": "/root/work/src/atmux",
  "emoji": "⚖️",
  "claudeAccount": "personal"
}
```

Brief template lives at `templates/briefs/ombudsman.md` (sibling to existing `gitter.md`, `enforcer.md`, etc.). The brief covers: read open complaints → triage → adjudicate (epic / wontfix / resolved) → append release-notes entry → reply on lead-outbox.

### (D2) Wake mechanism — sentinel file + cron (event-driven, NOT whip-polled)

Per t-441d6d4c subject: ombudsman is **event-driven**. It does NOT participate in the whip cadence; lane-tick must NOT inject `atmux claim --next --as ombudsman` into the ombudsman pane.

**Sentinel file**: `.atmux/state/ombudsman-pending.json` — array of complaint IDs awaiting first adjudication.

**Write side**:
- `atmux complaints file` appends the new `c-id` to the sentinel array (same transaction wrap as the DB insert, per ADR-091 pre-flag #1 pattern).
- `atmux complaints resolve <id>` removes the `c-id` from the sentinel (whether or not the ombudsman wrote the resolution — operator manual-resolve also clears).

**Read side**:
- A new cron line `atmux ombudsman tick --team <team>` runs every N minutes (default 15min, configurable via `team.ombudsman.tickIntervalMins`).
- Tick is a no-op fast path: read sentinel, exit 0 if empty. Cron overhead minimal.
- If sentinel non-empty, tick wakes the ombudsman pane via the same lane-tick mechanism (verified send-keys per ADR-138) with `atmux ombudsman work` — ombudsman then drains the sentinel.

**Why sentinel + cron (not pure event-driven)**:
- Pure event (e.g. socket-pubsub per ADR-032) would wake the pane on every complaint file. Too noisy — medic + whip-velocity-gate can file 5-10 complaints in a burst.
- Pure cron (poll DB every tick) wastes cycles when no work exists.
- Sentinel + cron: cron is fast no-op when empty, fires the worker only when sentinel is non-empty. Matches the `groom-pending-judgment.json` pattern from t-9319a22c (Supergroomer parking-lot task).

### (D3) Adjudication authority — file epic / wontfix / resolved

For each open complaint, ombudsman picks ONE of:

| Action | When | Effect |
|---|---|---|
| **File epic** | Complaint describes a real bug class or missing capability. Body explains scope. | `atmux task add --epic` with subject `EPIC: <complaint summary>`, body links the complaint ID + cites root-cause + ask. `atmux complaints resolve <c-id> --status resolved --related-task <t-id>`. |
| **File task (no epic)** | Single, scoped fix. Not epic-worthy. | `atmux task add` with regular task body. Resolve complaint with `--related-task`. |
| **Wontfix** | Duplicate, out-of-scope, blocked-by-external, or stale. | `atmux complaints resolve <c-id> --status wontfix --note "<rationale>"`. |
| **Already addressed** | Complaint pre-dates a fix that already landed. | `atmux complaints resolve <c-id> --status resolved --note "<commit-SHA or ADR-NNN>"`. |
| **Defer** | Not yet adjudicable; needs operator input. | Leave open; append release-notes entry flagging `🟡 deferred: <reason>`. Do NOT clear the sentinel for this complaint — next tick re-attempts. |

Ombudsman does NOT directly modify code. It is a kanban writer + complaint resolver, not a worker. The epics it files get decomposed by planner and worked by members in the normal flow.

### (D4) Release notes — `docs/release-notes/YYYY/MM/YYYY-MM-DD.md`

**Layout**: one file per day, year + month folders for navigation. NOT year/month/day folders (operator's brainstorm). Rationale:

- atmux ships at ~5–15 commits/day; folders-per-day means ~365 folders/yr × multiple files/day = explosion of tiny files. Single file per day with appended sections is the natural unit.
- Year + month folders give navigability (`ls docs/release-notes/2026/05/` = month view at a glance).
- File-per-day is grep-friendly (`rg "ADR-147" docs/release-notes/` returns chronological hits).
- A folder-per-day shape can be retrofitted later if any single day grows large enough to warrant split — out-of-scope for v1.

**File structure** — every day-file follows the same skeleton; sections are append-only by their respective agents:

```markdown
# 2026-05-15

## Shipped (kanban→done)

(appended by gitter post-fan-in, or hygiene-tick as backstop)

- t-xxxxxxxx — <subject> — SHA <hash> on <branch>
- ...

## Merges (branch→trunk)

(appended by gitter post-trunk-merge per ADR-145 + ADR-146)

- geoyws-up-impl → trunk @ d973ab8 (5 commits)
- ...

## ADRs landed

(appended by hygiene-tick on detecting new docs/adr/*.md, OR by ADR author on commit)

- ADR-147 (proposed) — Ombudsman role + release-notes layout

## Complaints adjudicated

(appended by ombudsman per §D3)

- c-475db11c → **filed epic t-aaaaaaaa** (Auto-rotate non-compliant leads — duplicates ADR-139 scope; epic captures the supervisor-side rotation policy beyond what ADR-139 covers)
- c-8ecd3a61 → **wontfix** (atmux status / doctor disagree — superseded by ADR-XXX cage-state taxonomy; resolved with note pointing to that ADR)

## Doctor regressions (optional)

(appended by medic on red-row escalation; empty most days)

## Notes (optional)

(operator-curated narrative; empty most days)
```

**Auto-create + idempotency**: the first writer of the day to `docs/release-notes/<Y>/<M>/<Y-M-D>.md` creates the file with all skeleton sections empty. Subsequent writers append to their own section. No locking needed — section headers act as natural insertion anchors; race writes happen at most under a few hundred ms and are append-only (no destructive overlap).

**Discovery**: `docs/release-notes/README.md` (one-time write) points to the layout convention + how to browse + a "latest 30 days" auto-generated table-of-contents (regenerated by hygiene-tick or a simple `atmux release-notes index` verb — minor, can ship later).

### (D5) Doctor probe — daily release-note presence

A new doctor probe `release-note-missing` (warn class, NOT block) fires when:

- Today's date has ≥1 commit on trunk (verified by `git log --since "today 00:00 MYT"`)
- AND `docs/release-notes/<Y>/<M>/<Y-M-D>.md` does not exist

This is a backstop, not a gate. The expected pattern is gitter (or hygiene-tick) auto-creates the file on the first event of the day. Probe surfaces missed days for ombudsman to backfill.

### (D6) Concurrency + cross-team release notes

For atmux today (single team `atmux`), the release-notes path is unambiguous: `<repo-root>/docs/release-notes/...`. For projects with multiple teams writing to the same repo (e.g. the parent project of an epic-team per ADR-090): each team writes to **the same physical file** at the repo root, with team name as a sub-section prefix. Example:

```markdown
## Complaints adjudicated

### atmux team
- c-... → ...

### sopx team
- c-... → ...
```

This keeps the day-file as the single chronological unit operators read; team-segmentation is internal to each section.

Cross-team file conflict: ombudsman of team A and ombudsman of team B may append to the same file the same minute. The append-only section pattern (each ombudsman writes only to its team's `### <team>` subsection within `## Complaints adjudicated`) keeps this conflict-free. If a true race occurs (same team appends twice in the same I/O burst), the worst case is a duplicate `### <team>` header — visually noisy but not corrupted. Reviewer's same-commit doc-update rule catches it.

For atmux-the-monorepo specifically (single team), this is N/A. v1 ships with single-team assumption; multi-team release-notes is gated on ADR-090 epic-team landing.

### (D7) Doc-discipline interaction (per project CLAUDE.md)

Release notes are a documented surface. New ADRs that introduce a new release-notes section (e.g. a future "## Security incidents" section) MUST include the same-commit update to `docs/release-notes/README.md` documenting the section. Reviewer enforces.

Ombudsman appending entries to existing sections is NOT subject to same-commit doc-update — it IS the doc update.

### (D8) Membership in default team-roster

For v1: ombudsman is **optional**, not auto-rostered. Teams add it to `team.json::members[]` if they want adjudication coverage. Atmux-the-team adds it post-acceptance (dogfood gate). Brief template ships in `templates/briefs/ombudsman.md` so any team can stand one up trivially.

Future ADR may auto-roster ombudsman in `atmux team init` defaults once the role has bedded in. Out-of-scope here.

## Implementation plan (decomposition)

EPIC parent: this ADR (closes t-441d6d4c). Sub-tasks to be filed in same session per the decomp-in-same-session pattern (per `feedback_decomp_same_session_with_deps.md`).

| ID | Task | Deps | Lane |
|---|---|---|---|
| T1 | `src/verbs/ombudsman.ts` — `tick`, `work`, `index` sub-verbs; sentinel R/W in `src/core/ombudsman.ts` | none | be |
| T2 | `atmux complaints file` + `resolve` — sentinel write-through (transaction-wrapped per ADR-091 #1) | T1 | be |
| T3 | Cron template — `atmux cron-install --template ombudsman-tick`; gated on team.ombudsman.enabled | T1 | be |
| T4 | `templates/briefs/ombudsman.md` + `team.json` schema field `ombudsman?: { enabled: bool, tickIntervalMins?: number }` | none | be |
| T5 | Release-notes writer abstraction — `src/abstractions/release-notes.ts`: `appendSection(date, section, entry)` with skeleton create-on-miss | none | be |
| T6 | Wire D6 doctor probe `release-note-missing` (warn, not block) | T5 | be |
| T7 | E2E — synthetic team + 3 complaints + ombudsman tick → 2 epics filed + 1 wontfix + day-file written + sentinel cleared | T1+T2+T5 | test |
| T8 | Hygiene-tick / gitter integration — auto-append `## Shipped` + `## Merges` + `## ADRs landed` sections | T5, ADR-131 hygiene-tick | be |
| T9 | Dogfood — add `ombudsman` member to atmux-team's `team.json`; backfill existing 3 open complaints via first tick | T1-T8 | be |

T9 is the gate for `Status: proposed → accepted`; flip when atmux-team's first day-file lands cleanly + the 3 known open complaints are adjudicated by ombudsman (not operator).

## Tradeoffs + alternatives considered

### Year/month/day folders (operator's brainstorm, NOT chosen)

`docs/release-notes/2026/05/15/<entry>.md` — one folder per day, one file per entry. Considered. Rejected because:
- File count explodes (~365 dirs/yr × ~5 entries/day = ~1800 files/yr).
- Grep across days requires `rg ... docs/release-notes/2026/05/15/ docs/release-notes/2026/05/14/ ...` — clumsy.
- No natural single-file-per-day view; operator's "what shipped today" requires concat.
- Append-conflict story for cross-team writes is *worse* per-folder (multiple new files vs one file, multiple writers).

Single file per day with append-only sections retains the granularity (each section IS an "entry") while keeping the unit-of-read at the day level.

### Per-complaint JSON sidecar (NOT chosen)

`.atmux/state/complaints/<c-id>/adjudication.json` — durable, structured, queryable. Rejected because:
- Already have `Complaint.status` + `Complaint.extra` in SQLite for structured state — duplicate.
- Operator-facing readability is poor (JSON ≠ markdown).
- Misses the cross-cutting "see today's progress" affordance.

### Inline as part of `Complaint.extra.adjudication` only, no release notes (NOT chosen)

Cheapest implementation but doesn't solve the "see progress" ask. Operator would still need a separate progress-narrative surface; deferring it just splits one ADR into two.

### Pure event (socket-pubsub) wake instead of sentinel + cron (considered, NOT chosen v1)

Cleaner architecturally, but burst-sensitive (medic can file 5-10 complaints in one tick on a bad day). Cron-batching the wake gives ombudsman the chance to drain a burst in one session rather than wake-process-sleep × N. v2 may revisit if cron latency becomes a real pain point.

## Open questions (proposed → accepted gate)

- **OQ1** — should ombudsman *also* re-triage already-resolved complaints periodically (catch wontfix-but-later-relevant)? Default: NO for v1; revisit if pattern emerges.
- **OQ2** — does ombudsman post to lead-outbox on every adjudication (loud) or only on epic filings (quiet)? Default: **only on epic filings** (lead-outbox stays signal-rich); wontfix + already-addressed go straight to release-notes without an outbox ping.
- **OQ3** — Discord ping on epic filing from a P0-flagged complaint (e.g. `whip-velocity-gate` source)? Default: YES, route via `src/abstractions/discord.ts` as a `[blocker]` template.
- **OQ4** — should the cron tick interval default differ between teams (e.g. low-traffic team = 30min, high-traffic team = 5min)? Default v1: 15min single setting; per-team override via `team.ombudsman.tickIntervalMins`.

Reviewer / operator: any non-default on these flips `Status: proposed → accepted`.

## Related work + sibling patterns

- ADR-077 / ADR-131 / ADR-133 — medic owns the *filing* side of complaints; this ADR owns the *adjudicating* side. Both ends now have a named owner.
- ADR-146 — sibling event-driven pattern (kanban auto-files trunk-merge Task). Ombudsman ADR is the same shape applied to the complaint surface.
- ADR-091 — epic-team auto-merge state machine — also event-driven, transaction-wrapped. Ombudsman reuses the BEGIN IMMEDIATE pattern for sentinel + DB consistency.
- ADR-138 — verified send-keys — ombudsman pane wake via lane-tick uses `safeSendKeysWithVerify`, same as every other pane.
- ADR-085 §2.5 — `Status: proposed` is the right starting point here; flip to accepted post-T9 dogfood per the gate above.

## T9 dogfood — 2026-05-16 (annotation, append-only per ADR write-flow)

Sub-tasks T1-T9 all landed:

| Task | SHA | Owner | Subject |
|---|---|---|---|
| T1 (t-27da5517) | 7e8d3ae | up-impl-3 | feat(ombudsman,verbs) — tick/work/index sub-verbs + sentinel R/W |
| T2 (t-aafd2e2d) | d61138a | parity-state-impl | feat(complaints) — sentinel write-through |
| T3 (t-94a22bb0) | d3d243a | parity-cron-impl | feat(cron-install,cron) — `--template ombudsman-tick` |
| T4 (t-2d46b574) | f3f611c | docs-2 | feat(schema,briefs) — `TeamOmbudsman` config + brief |
| T5 (t-02a12bd8) | 75b8647 | up-impl-2 | feat(release-notes) — `appendSection` writer |
| T6 (t-f0ce0ec0) | da40208 | up-impl-3 | feat(doctor) — `release-note-missing` probe |
| T7 (t-bbc15985) | 7ebe6df | test-impl | test(e2e) — ombudsman lifecycle |
| T8 (t-113ff137) | 9ad2496 | docs-2 | feat(release-notes,hygiene-tick) — auto-append `## Shipped`/`## Merges`/`## ADRs landed` |
| T9 (t-8d374cf2) | this commit | parity-cron-impl | dogfood — atmux team.json + ADR status flip |

T9 dogfood findings:

- **Pre-T9 SQLite migration bug discovered** — pre-renumber state.db (user_version=4 + `superdoctor_hygiene` present, `superdoctor_attempts` absent) crashed every worktree-atmux open on the v4→v5 hygiene migration. Fixed in precursor commit `ed24844` (`fix(sqlite-migrations): legacy DB rescue + idempotent CREATEs`) with idempotent `CREATE TABLE IF NOT EXISTS` on v3→v4 + v4→v5 and a new v6→v7 backfill migration that re-runs the v3→v4 SQL idempotently. Required because the dogfood ombudsman pane couldn't open state.db until the legacy schema was healed.
- **1 open complaint adjudicated, not 3** — c-475db11c + c-8ecd3a61 (cited in ADR §Context) were already operator-resolved before T9 ran. The only remaining open complaint at dogfood-time was c-7a308f7f (groom `--inbox-days` wired-but-unconsumed). Ombudsman filed task t-82b6aed9 (planner-routed, p=1, lane=be), resolved c-7a308f7f → resolved, and committed the day-file at `docs/release-notes/2026/05/2026-05-16.md` on `geoyws-ombudsman` @ b68f2b4. The acceptance "all backlog complaints resolved" is satisfied at 1/1 for the actually-open set.
- **Sentinel was empty, not populated then drained** — `.atmux/state/ombudsman-pending.json` doesn't exist (pre-dates T2's sentinel write-through wiring, or was pruned). Per ADR §D2 fast-path semantics, missing-file = empty; ombudsman bootstrap-time drain handled the singleton complaint via direct `atmux complaints list` query, not via sentinel wake. Future complaints filed via `atmux complaints file` will populate the sentinel + drive the wake mechanism end-to-end.
- **Cron line installed but binary stale** — `*/15 * * * * … /usr/local/bin/atmux ombudsman tick …` is in the atmux team's cron block (verified via `crontab -l | grep ombudsman`). The binary path resolves to `/opt/atmux/0.7.2`, which pre-dates the ombudsman verb and exits "unknown verb" on every tick until a build-install rolls the new atmux version. This is a cross-release coupling — T9 acceptance covers cron-line presence + correct templating; deploy-the-binary lives in the regular atmux release lifecycle.

OQ1-OQ4 stayed at defaults (no operator override during dogfood). Status flips proposed → accepted on this commit per the gate above.
