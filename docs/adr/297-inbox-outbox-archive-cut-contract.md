# ADR-297: Inbox/outbox archive-cut contract (e-77)

**Status**: accepted (driver-shipped; adversarial self-review per the drivers-only default — no reviewer seat on this team)
**Date**: 2026-09-28
**Driver-ref**: epic e-774065d6 (inbox + outbox archive verbs); T1 t-875eb305, T2 t-55900b59, T3 t-e0152c3c, T4 t-1c20e76b
**Relates**: [ADR-029](029-driver-lead-team-scope-superdriver-cross-team.md) (driver-inbox/lead-outbox writer protocol, `HH:MM MYT` markers), [ADR-092](092-cross-team-tell-lead.md) (cockpit-walk `--team` resolution reused by OQ2)

## Context

`tell-lead` appends to `driver-inbox.md` and `reply` appends to `lead-outbox.md` on every exchange. Both files grow without bound; before e-77 the only disposal was manual deletion (which loses history) or `outbox --ack` (which collapses `## Open` into `## Archive` in place — fine for the reader, but the file still grows). The epic adds time-based archival to sidecar files, shared by one helper, exposed through two verbs. This ADR records the contract all three pieces implement so a future writer/cron change cannot silently break it.

## Decision

### D1 — Cut boundary: contiguous old block, conservative tail

`planCut` (src/core/inbox-outbox-archive.ts) moves the contiguous block from the first entry older than the cutoff up to (not including) the first recent entry. The header and every non-dated preamble line stay in the live file verbatim; recent entries and trailing lines stay as the live tail. Conservative rule: an inferred-old entry appearing *after* a recent one stays live — the cut never punches holes. No old entries → `cutAt = null` → no-op.

### D2 — Entry dating: clock markers anchored to file mtime

Entries carry `HH:MM MYT` only (ADR-029 §F8; outbox lines `- [HH:MM MYT] **from**: msg` match the same marker). Absolute dates are inferred by `findEntries`: forward pass counts midnight wraps (a clock time not strictly increasing vs the previous entry bumps the relative day; equal minutes count), backward pass anchors the LAST entry to the file-mtime day (shifted one day back when its clock post-dates the mtime clock — entries age, never post-date their last write). MYT is UTC+8 with no DST. Consequence: recency is relative to the file's mtime, not to wall-clock-now — a file untouched for a week has no "recent" entries.

### D3 — Archive naming and placement

One archive file per pass: `<atmuxDir>/archive/<base>.archive-<ts>.md` where `<base>` is the live filename (`driver-inbox.md`, `lead-outbox.md`) and `<ts>` is the pass timestamp in ISO form with `:` → `-` (e.g. `driver-inbox.md.archive-2026-09-28T04-30-07-982Z.md`). The archived block is verbatim lines (header preamble copied atop per the helper header). Archive-first ordering: the archive file is written *before* the live rewrite, so a crash mid-pass duplicates at worst and never loses.

### D4 — Atomicity and writer interaction

The live rewrite is tmpfile+rename under an flock on `<inboxPath>.lock` — the same sidecar the tell-lead/reply append writers honor — so an archive pass never interleaves with an append. Missing or empty live file is a no-op (exit 0), never an error: read-side disposal must never fail a cron tick (epic Decision).

### D5 — Idempotency invariant

Cutoff math is absolute (mtime-anchored), so a re-run after a cut finds only newly-old entries; a second immediate run is a no-op. `entriesArchived` counts moved entry lines; `archivePath` is null when nothing moved. Both verbs emit the same JSON shape `{path, olderThan, entriesArchived, archivePath}` under `--json`.

### D6 — Verb-as-only-AI-mutation-path authority model

AI agents are denied direct writes to both files. `atmux inbox archive` (T2) and `atmux outbox archive` (T3) are the only AI-accessible disposal path; they call the T1 helper under the verb's own write authority. Writers stay append-only.

### D7 — Epic open questions, resolved

- **OQ1 precedence**: the `archive` subcommand keyword wins over positional parsing wherever it appears (first positional occurrence is stripped and routed). A member literally named `archive` is unreachable through `inbox` and refused with a hint (`parseInboxArgs` conflict gate); other `outbox` positionals still die with "unknown arg" (no behavior change).
- **OQ2 `--team`**: resolves via the existing cockpit-walk seam (`loadCockpit` + `findTeamByName`, same as tell-lead `--team`), re-anchored to the target root. No caller-scope gate: archive is local maintenance on files the driver already owns, not a cross-team send.
- **OQ3 durations**: `--older-than` takes `Nm|Nh|Nd` only (`parseDuration`); bare numbers are rejected as ambiguous. Default `48h`.

## Consequences

- Cron/whip-tick disposal calls the verbs, never file edits; a future verb must preserve D1–D5 byte-shape or amend this ADR first.
- Changing the `[HH:MM MYT]` marker format (ADR-029) requires re-verifying `findEntries` anchoring — the two ADRs are coupled at the marker regex.
- T2 deliberately duplicates T3's wiring (~60 lines) instead of sharing a helper: T2 landed green first and the verbs tree duplicates this small shape per verb by convention (noted in src/verbs/reply.ts).

## Cross-refs (same commit)

- src/core/inbox-outbox-archive.ts header → this ADR (contract owner).
- src/verbs/inbox.ts `` `inbox archive` `` section → this ADR (OQ1/OQ2).
- src/verbs/reply.ts `` `outbox archive` `` section → this ADR (mirror rationale).
- `atmux help` usage lines for both verbs.
