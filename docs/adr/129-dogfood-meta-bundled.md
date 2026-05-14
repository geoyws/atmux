# ADR-129: Dogfood-meta — complaints lane, cross-team targeting, nomenclature taxonomy fix, hot-reload, live-status, rename-safe identity (bundled)

**Status**: accepted (George 14:13 MYT 2026-05-08 — *"accept it now and implement it now"*)
**Date**: 2026-05-08

## Context

Driver-inbox entry block at `.atmux/driver-inbox.md` 11:41–12:50 MYT 2026-05-08 ("dogfood-meta: complaints lane + cross-team targeting + nomenclature taxonomy fix"). George chat 11:30–12:43 MYT bundled five hard constraints + 11 components into a single planner-routable ADR. Auth: George 12:14 MYT (*"approve all the work and get started immediately"*) + 12:14 MYT (*"yes let's fold it into one ADR…"*).

**Why bundle.** The components are not independent — nomenclature, identity-IDs, and hot-reload all touch reference durability (file paths, member/team names, schema migrations). Shipping them sequentially would either ship the new complaints lane into the still-confused naming or force a rename migration twice. Single atomic landing avoids double migration churn. The "(b) drop inbox entirely" rename direction has cross-team blast radius that must be settled before the new complaints lane stamps any new file.

PR#2 (geoyws→main merge) closed 2026-05-07; v1.0.0 / v1.1.x bucketing is moot. All 11 components are trunk; planner sequences by dependency, not release-bucket.

### Hard constraints (driver, non-negotiable acceptance criteria)

- **HC#1 — Zero ambiguity nomenclature.** A fresh reader sees any `.atmux/` filename and immediately knows what it contains, with zero possible second interpretation. Two readers cannot plausibly disagree on what a filename means. (George 11:43 MYT)
- **HC#2 — Every complaint logged + addressed + answered in release notes.** Release-cut blocks if any complaint open during the release window lacks a documented response (fixed / deferred / declined / open-tracked). (George 11:45 MYT)
- **HC#3 — Hot-reload support.** No `atmux team stop` + `start` required to pick up new verb, schema add, renamed-file compat shim, or groom logic update. (George 11:46 MYT)
- **HC#4 — Live-not-cached status / uptime / activity.** `atmux status` / `dashboard` / lead-events reflect actual state, not stale cache. False-green stale status is the dominant cognitive-tax on driver+lead coordination right now. (George 12:13 MYT)
- **HC#5 — Rename-safe identity.** Members + teams have surrogate IDs (`m-XXXXXXXX` / `T-XXXXXXXX`); rename never triggers migration; alias table covers deprecation window. (George 12:08+12:13 MYT)

### Cross-references (existing ADRs this ADR amends or extends)

- **ADR-104 (hot-reload)** — partial supersession + extension. Existing `brief-reload` / `config-reload` / `verify-libs` infra is sufficient for verb-table refresh; this ADR adds schema-migration-on-touch + read-side compat-shim infra. `brief-versions.json` convention preserved.
- **ADR-bun/021 (coordination-runtime-contract)** — direct rename blast radius. The HC#1 rename targets the verb-contract path constants (`driver-inbox.md` / `lead-outbox.md`). ADR-114 is **amended** (not superseded): verb names + path constants update; verb behaviour preserved. ADR-114's mode matrix (driver / solo / lead / no-team) untouched.
- **ADR-bun/060 (sqlite-state-store)** — schema extension. New `complaints` table per ADR-126 migration discipline (PRAGMA `user_version`; idempotent INSERT-IF-NOT-EXISTS).
- **ADR-100 (pull-kanban)** — preserved. Per-member task-queue shape continues; only the file-name word changes (`inboxes/<name>.json` → `tasks/<m-id>.json`). Lane semantics + `claim --next` cross-lane fallback untouched.
- **ADR-120 (team rename verb + topology invariant)** — extended. New `atmux team rename-member <old> <new>` extends ADR-120's atomic-rename-or-rollback model with member scope. Archive-don't-rewrite discipline applies.
- **ADR-053 (flag-add dedup)** — pattern reference. `atmux complain` reuses the `_flags_dedup_open_within` 5-min TTL on (filer, sha256(message)) tuple.
- **ADR-bun/044 (driverSession)** + **ADR-bun/064 (driver role port)** — extended. Driver pane gets reserved sentinel `m-driver` (special-cased outside `members[]`); driver-pane health probe surfaces driver in live-status surfaces.
- **ADR/032 (socket-pubsub-messaging-layer)** — *proposed, NOT a hard pre-req*. Cross-team complaints (#3) initially use a simple file-write substrate; future migration to socket-pubsub is non-breaking (registry-keyed routing the same either way). See OQ-3.

## Decision

### D1 — Nomenclature direction: option (b), drop "inbox" entirely

Drop `inbox` as a load-bearing word. Type-suffix replaces it:

| Old | New | Behaviour |
|-----|-----|-----------|
| `driver-inbox.md` | **`driver-asks.md`** | Asks from driver to lead; triage markers inline. |
| `lead-outbox.md` | **`lead-events.md`** | Lead's append-only broadcast. |
| `lead-queue.md` | (kept) | Already type-suffix style. |
| `inboxes/<name>.json` | **`tasks/<m-id>.json`** | Per-member dispatched-task pickup queue. |
| `planner-inbox.md` | **`planner-asks.md`** | Lead → planner ask queue. |
| (new) | **`complaints/<host-team>.md`** | Free-form pain-report intake (see D3). |

Verbs renamed in lockstep:

| Old | New |
|-----|-----|
| `atmux inbox <member>` | `atmux tasks <member>` (read pending tasks queued for member) |
| `atmux outbox` | `atmux events` (read lead-events.md) |
| `atmux tell-lead` | (unchanged — verb name doesn't carry "inbox") |

Rationale: (a) and (c) leave "inbox" in place and the confusion can recur as new file types are added. (b) clears the load-bearing word completely. HC#1 zero-ambiguity bar is the rule; (b) is the only direction that satisfies it in the strong sense.

### D2 — Surrogate-ID identity model

`team.json` schema additions:

```json
{
  "id": "T-XXXXXXXX",
  "name": "atmux",
  "displayName": "atmux",
  "members": [
    { "id": "m-XXXXXXXX", "name": "lead", "role": "team-lead", ... }
  ]
}
```

- `id` immutable, assigned at create time, never edited.
- `name` and `displayName` freely editable.
- Runtime resolver (id ← name) reads team.json on every CLI entry — cheap at this scale, no caching layer.
- All internal storage routes by ID:
  - `tasks/<m-id>.json` (was `inboxes/<name>.json`)
  - `kanban.tasks.owner` → `m-id`
  - Cron supervisor refs → `m-id`
- Cross-team filer recorded as `<m-id>@<T-id>` or `external:<host-team>:driver`.
- Display layer prints `displayName` (fallback to `name`); archive markdown is **not rewritten** (per ADR-120 archive-don't-rewrite discipline). Live refs follow the ID.

`~/.claude/teams/registry.json` schema additions:

```json
{
  "teams": [
    {
      "id": "T-XXXXXXXX",
      "name": "atmux",
      "displayName": "atmux",
      "aliases": [{ "name": "atmuxbun", "deprecatedAt": 1778243000 }],
      "members": [
        {
          "id": "m-XXXXXXXX",
          "name": "lead",
          "aliases": [{ "name": "team-lead", "deprecatedAt": 1778243000 }]
        }
      ]
    }
  ]
}
```

Old CLI args (`atmux send up-impl ...`) keep resolving for a 30-day deprecation window via alias table (see OQ-1).

**Driver pane**: reserved sentinel `m-driver` (not assigned a fresh `m-XXXXXXXX`). At most one driver per team; the literal sentinel is clearer for status code paths than a UUID.

**New verb**: `atmux team rename-member <old> <new>` — atomic, alias-augmenting, no migration. Extends ADR-120's transactional shape (rename-lock → team.json → registry alias append → lock clear; rollback in reverse on partial failure).

Existing `atmux team rename <old> <new>` (ADR-120) extends the same way: registry alias append on top of the existing flow.

### D3 — SQLite complaints schema

New table in `.atmux/state.db` per ADR-126 migration discipline:

```sql
CREATE TABLE IF NOT EXISTS complaints (
  id              TEXT PRIMARY KEY,         -- c-XXXXXXXX
  filer           TEXT NOT NULL,            -- <m-id>@<T-id> or external:<host>:driver
  filer_team      TEXT NOT NULL,            -- T-id of the host team filing
  target_team     TEXT NOT NULL,            -- T-id of the team this is filed against
  message         TEXT NOT NULL,
  message_hash    TEXT NOT NULL,            -- sha256 for dedup gate
  severity        TEXT NOT NULL,            -- p0 | p1 | p2 (default p2)
  status          TEXT NOT NULL,            -- open | triaged | fixed | deferred | declined
  closes_sha      TEXT,                     -- closing commit SHA when status=fixed
  triaged_into    TEXT,                     -- task id (t-XXX) when status=triaged
  defer_target    TEXT,                     -- target version when status=deferred
  decline_reason  TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS complaints_status_idx ON complaints(status);
CREATE INDEX IF NOT EXISTS complaints_target_idx ON complaints(target_team);
CREATE INDEX IF NOT EXISTS complaints_dedup_idx ON complaints(filer, message_hash, created_at);
```

PRAGMA `user_version` bumped per ADR-126 OQ-3. Schema-add via idempotent migration on next state-touching `atmux` invocation (HC#3 hot-reload).

### D4 — `atmux complain` verb + cross-team targeting

```
atmux complain "<message>"
  [--severity p0|p1|p2]      # default p2
  [--team <other-team-name>] # default: caller's host team
  [--filer <m-id>]           # default: caller identity (driver-pane = external:<host>:driver; member = <m-id>@<T-id>)
```

- **Filer resolution**: pane lookup (tmux session/window) → member identity from team.json. Driver-pane = `external:<host-team>:driver`.
- **Target resolution**: `--team <name>` → registry.json lookup → target team's `cwd` + `T-id`. Single-host trust model: registry-listed teams freely write each other's complaints (matches the archived bash port's `lib/socket-pubsub.sh` pattern).
- **Dedup gate**: 5-min TTL on (filer, sha256(message)) tuple per ADR-053. Re-fire within window is silently absorbed; no duplicate row.
- **Two writes** per complaint:
  1. INSERT row into target team's `state.db.complaints`.
  2. APPEND 1-line summary to target team's `complaints/<filer-team-name>.md` for greppable surface (`[HH:MM MYT] c-XXXX p2 from m-id@T-id: <message>`).
- **Verb output**: `📋 c-XXXXXXXX filed against T-id (target team)`.

### D5 — Cron-groom complaints triage sweep

Existing cron-groom (parity-cron-impl lane) gains a per-tick triage step:

1. Enumerate `state.db.complaints WHERE status='open'`.
2. For each open complaint, append (idempotent — keyed by `c-id`) one ask to `driver-asks.md` under `## Open`:

   ```md
   ## HH:MM MYT 2026-05-08 — 🆕 complaint c-XXXXXXXX (severity:p2, filer:<m-id>@<T-id>)

   <message>

   Triage: lead converts to task with `Closes-complaint: c-XXXXXXXX` in body, OR marks declined/deferred via `atmux complain triage c-XXXXXXXX --decline "<reason>"`.
   ```

3. Lead reads ask in normal whip cycle; converts to task (status flips `triaged` automatically when commit lands with the trailer) or runs explicit triage verb.

**Triage cadence**: every groom tick (daily). Hourly is too noisy; daily is the rhythm complaints actually arrive at. See OQ-4.

**New verb**: `atmux complain triage <c-id> [--decline "<reason>" | --defer "<target>" | --convert <task-id>]` — explicit state transitions for declines/defers. The `Closes-complaint:` trailer handles the fixed transition automatically.

### D6 — Release-notes trailer + every-complaint-answered guarantee

**Trailer convention**: any commit fixing a complaint includes a trailer line in the commit body:

```
Complaint-status: c-XXXXXXXX/fixed
Complaint-status: c-XXXXXXXX/deferred:v1.1.x
Complaint-status: c-XXXXXXXX/declined:not-reproducible
```

`atmux done <task-id>` parses the task body for `Closes-complaint: c-XXXX` and auto-injects the trailer into the commit-Task body emitted to gitter.

**Generator**: `atmux release-notes [--since <ref>] [--until <ref>] [--format md|json]` enumerates every complaint open at any point during the window and emits one entry per complaint regardless of disposition:

- **fixed** → `- c-XXXX: <message-summary> — fixed in <closes-sha> (<commit-subject>)`
- **deferred** → `- c-XXXX: <message-summary> — deferred to <target-version> (reason: <decline_reason>)`
- **declined** → `- c-XXXX: <message-summary> — declined (reason: <decline_reason>)`
- **open-at-cut** → `- c-XXXX: <message-summary> — STILL OPEN at cut, tracked-as <task-id-if-any>`

**Release-cut check**: `atmux release-cut --check [--since <ref>] [--until <ref>]` returns non-zero exit if any complaint in the window lacks a documented response. CI hooks this in. See OQ-7 (hard non-zero exit vs soft warning).

Generator is re-runnable on demand against current state (HC#3 hot-reload).

### D7 — Hot-reload extension

Building on ADR-104's existing `brief-reload` / `config-reload` / `verify-libs` infra:

- **Schema-migration-on-touch**: every state-touching atmux invocation runs migrations idempotently. Backward-compat reads of pre-migration shape via versioned read paths in `src/abstractions/sqlite-migrations.ts`.
- **Renamed-file compat shims**: read-side fallback to old paths for the 30-day deprecation window (OQ-1). Writes always go to new paths immediately. Implementation: `src/core/path-resolver.ts` returns `{ canonical, legacy[] }`; readers check legacy if canonical absent; writers ignore legacy.
- **Cron-groom logic update**: cron re-execs the script on every tick — no respawn needed. Logic lands at HEAD and is live on next tick.
- **`atmux complain` + `atmux release-notes` verbs**: available immediately on next CLI invocation (no member-pane restart required).
- **Identity alias updates**: registry.json edits picked up on next CLI entry (resolver re-reads on every call; no caching).

ADR-104's deferred verbs (`swap-tui`, per-claim brief snapshot) remain deferred — not load-bearing for this ADR.

### D8 — Live-not-cached status / activity

Four mitigations, all baked as success criteria of HC#4:

1. **Auto-append `atmux send` + `atmux dispatch` to `lead-events.md`**.
   - Every `send` / `dispatch` call appends a 1-line entry: `[HH:MM MYT] dispatch → <m-display-name>: <subject-or-first-80-chars>`.
   - Closes the largest blind spot (currently dispatches via `atmux send` are invisible to lead-events readers).
   - Implementation: hook in `src/verbs/send.ts` + `src/verbs/dispatch.ts` after the keystroke fire; idempotent under retries.

2. **Replace cached status with live-probe at read time.**
   - `atmux status` and `atmux dashboard` re-probe pane state via `tmux list-windows` + `tmux capture-pane -p` per call.
   - Pay the latency (~50-200ms per pane); gain truth.
   - Removes the post-budget-pause stale-cache bug (driver-inbox `## Open` P3 entry 13:21 MYT 2026-05-07).

3. **As-of timestamp on every status output.**
   - `atmux status` header: `# atmux status — as of HH:MM:SS MYT`.
   - Caller can detect staleness even if it sneaks back in.

4. **Compose-box / queued-message visibility in `atmux status`.**
   - `tmux capture-pane -J -p -S -3 -t <window>` over the bottom 3 lines surfaces queued-but-not-sent compose-box content.
   - Shown as `📝 queued: <preview-up-to-60-chars>` per pane that has any non-empty compose-box content.
   - Detection: bottom line starts with `>` or `│` (Claude Code compose-box markers) AND is non-empty AND no recent send-key reply.

**Lead session uptime**: source from `tmux display-message -p '#{session_created}'` (or `tmux display-message -p '#{window_active_time}'`), NOT a stale `lead-session-start.txt` file. The .txt file becomes a fallback only.

### D9 — Glossary discipline (dual-tone, corporate-satire wink)

Single glossary at `docs/glossary.md`. Referenced from this ADR + from `atmux help` footer.

Each entry: dual-tone — `**Tone:**` line (italics, one short sentence) + canonical behaviour body. Earnest enterprise reader skims tone; everyone else gets the wink. If a doc needs to be tone-stripped (e.g., enterprise pitch material), the behaviour body alone is self-sufficient.

Initial 16 entries (driver supplied 11 in 12:48 MYT addendum; planner adds 5 — `ask`, `event`, `task`, `handoff`, `preclear` — for the new vocabulary):

| Term | Tone | Behaviour |
|------|------|-----------|
| `whip` | The manager who drives idle workers back to their desks. | Cron-fired supervisor pinging members every N min if pane idle past threshold. |
| `cage` | The isolated workspace each team gets, complete with its own door. | Per-team tmux session under unique `tmuxTmpdir` socket (ADR-111). |
| `lead` | The manager who never does the work, only routes it. | Coordinator role — reads driver-asks, dispatches, writes status to lead-events. Never claims tasks itself. |
| `driver` | The manager-of-managers, steering the whole thing. | Operator/George — the human-in-the-loop relay. |
| `complaints` | HR's polite name for "things that piss us off." | Free-form pain-report intake lane (this very feature). |
| `groom` | The cron that tidies your mess so you don't have to. | Daily archive sweep — driver-asks/lead-events/kanban tails into dated archives. |
| `flag` | The polite escalation to a higher-up. | Severity-tagged operator-attention signal with dedup-gating (ADR-053). |
| `dispatch` | The impersonal handoff. | Push a task to a member's task-queue with a pane-ping. |
| `claim` | "I'll take this one, boss." | Member pulls a task from todo, marks in-progress + assigns to self (ADR-100). |
| `done` | The mandatory status update. | Mark claimed task complete; auto-dispatches commit-Task to gitter (ADR-106/057). |
| `bootstrap` | The corporate onboarding deck nobody reads. | First-spawn brief paste into a fresh pane — role + context + canonical conventions. |
| `handoff` | The "I'm leaving the team but here's everything you need" doc. | Per-member context-preservation file written on rotation/clear. |
| `preclear` | The save-before-close prompt. | Phase-end ritual flushing memory + handoff + tasks to disk before `/clear`. |
| `ask` | The directed request awaiting triage. | Inbound work-shaped item; written to driver-asks.md or planner-asks.md. |
| `event` | The append-only broadcast. | Lead's lead-events.md entries; readers self-serve. |
| `task` | The triaged unit of work with owner + lifecycle. | Kanban card with state machine (todo → in-progress → done/blocked). |

**Ambiguous-pair disambiguations**:

- **ask** vs **task** — ask = directed request awaiting triage; task = triaged unit of work with owner + lifecycle. Triage flow: ask → triaged_into task.
- **event** vs **broadcast** vs **log** — collapse to `event`. All three were append-only, reader-discretion streams.
- **complaint** vs **ask** — complaint = unstructured pain-report from a filer; ask = structured directed request. Complaints triage *into* asks or tasks (one-way, never the reverse).
- **queue** vs **deferral** vs **pickup** — `queue` = ordered work-to-pull; `deferral` = personal mid-turn stash; `pickup` = dispatched-to-me. One word per concept; no overlap.

**Tone discipline**: never let satire obscure utility. Tone-line is one short sentence. Behaviour body is canonical reference. If satire ever gets in the way, keep the behaviour body and strip the tone.

## Consequences

**What changes**:
- Every existing reference to `driver-inbox.md` / `lead-outbox.md` / `inboxes/<name>.json` / `planner-inbox.md` in code, docs, briefs, CLAUDE.md, ADR bodies, templates is updated to new names. Read-side compat shims preserve old paths for 30 days. Largest cost item — cross-cutting rename diff.
- `team.json` schema bumps to include `id` per team + per member (Zod schema in `src/schema/team.ts`).
- `registry.json` gains `aliases` array per team + per member.
- `.atmux/state.db` gains `complaints` table.
- New verbs: `atmux complain`, `atmux complain triage`, `atmux release-notes`, `atmux release-cut --check`, `atmux team rename-member`, `atmux tasks` (replacing `atmux inbox`), `atmux events` (replacing `atmux outbox`).
- `atmux send` / `atmux dispatch` auto-append to `lead-events.md`.
- `atmux status` / `atmux dashboard` switch from cached to live-probe; UI gains as-of header + queued-message visibility.

**What it gives up**:
- Stale-cache speed in `atmux status` (now live-probe, +50-200ms latency per call). Acceptable — staleness is the dominant cognitive-tax.
- Single-step memorability of "inbox" — readers learn 3 distinct words (asks/events/tasks). Worth it for HC#1.
- The `--lane`/`--epic`/`--story`/`--priority`/`--deliverable` flags on `task add` (planner-brief lists them but bun port doesn't expose) remain unimplemented — out of scope for this ADR; planner emits a follow-up improvement task.

**Rollback path**:
- Git revert per commit (commit-per-component discipline; driver α from 12:43 MYT). Each component lands as its own commit + push, not a stacked WIP push.
- DB migration is idempotent + backward-compat-read; rollback is a forward migration with explicit `DROP TABLE complaints` if needed.
- Compat shims keep the legacy paths readable for 30 days, so any partial revert during the window is self-containing.

**Reviewer gate**:
- Per-commit reviewer cycle (existing discipline; CLAUDE.md Review/Audit Discipline).
- Each of HC#1–5 is an acceptance-blocker; reviewer verifies each before this ADR's Status flips to `accepted`. Reviewer's HC checklist:
  - HC#1: rename audit complete (zero `inbox` references in non-archive files); compat shims tested.
  - HC#2: `atmux release-cut --check` blocks on at least one synthetic open complaint in window.
  - HC#3: full e2e walk picks up new verb + schema + rename without team stop/start.
  - HC#4: `atmux status` live-probe verified; lead-events auto-append seen on `atmux send`.
  - HC#5: `atmux team rename-member` round-trip passes; old name resolves via alias.

## Open questions

(All resolved via `atmux decisions add` for trace; reversibility tier indicates override window.)

- **OQ-1 (medium)**: Compat-shim deprecation window length. → **30 days from rename land**. Extendable cheaply if real consumers surface.
- **OQ-2 (low)**: Driver pane identity — `m-driver` reserved sentinel vs random `m-XXXXXXXX`. → **`m-driver` reserved sentinel**. Code-shape only; no functional difference.
- **OQ-3 (low)**: Cross-team complaints initial substrate — file-write vs ADR-125 socket-pubsub. → **file-write substrate; socket-pubsub migration is non-breaking** (registry-keyed routing the same either way).
- **OQ-4 (low)**: Triage cadence — every groom tick (daily) vs hourly. → **daily (every groom tick)**. Hourly is too noisy.
- **OQ-5 (medium)**: Generalized `--team`/`--member` flag (driver-component #7) and member-targeted complaints (#8) — fold into this ADR or follow-up? → **follow-up; this ADR ships v1; planner emits decomp tasks once v1 closes**. Keeps this ADR landable; the generalized surface is its own design problem.
- **OQ-6 (low)**: Cron-groom triage default action — auto-create-ask vs require-lead-explicit. → **auto-create ask in driver-asks.md `## Open`; lead converts to task in normal triage flow**.
- **OQ-7 (high)**: Release-cut block teeth — soft warning vs hard non-zero exit. → **hard non-zero exit on `atmux release-cut --check`; CI gate**. Driver may want soft-warning at first ramp; flagged HIGH for explicit override.

— planner, 2026-05-08
