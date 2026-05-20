# ADR-198: driver-inbox.md → lead-inbox.md rename — naming-semantics fix + stale-skill-ref sweep

**Status**: accepted
**Date**: 2026-05-20 (operator chat-time decision — same session)
**Driver-ref**: 2026-05-20 driver session — operator verbatim "tell lead shouldn't be writing to driver-inbox.md and etc... fix it all".
**Parent EPIC**: e-5d1d4038 (parent atmux team) / e-af5650db (this epic-team's local mirror; T1-T8 filed in same session per [[feedback_decomp_same_session_with_deps]]).
**Cross-refs**: ADR-010 (atmux flag — inbox-semantics consumer), ADR-032 (socket pubsub — inbox-write publishes channel event), ADR-042 (superdriver phase-2 — inbox reader), ADR-092 (cross-team tell-lead — naming-confusion root), ADR-138 (verified send-keys — inbox-write surface), ADR-154 (driver-inbox-lead-outbox sqlite migration — rename target). Sibling renames: ADR-133 (superdoctor → medic), ADR-158 (martinet → sentinel), ADR-159 (gitter → committer), ADR-160 (whip → poke).

## Context

### Why this rename now

The `.atmux/driver-inbox.md` file stores **driver → lead** asks. The lead reads it on every cycle (`atmux whip`, `/bruh`, manual ticks). The lead writes to its sibling `lead-outbox.md` for upstream driver consumption. The pairing is asymmetric on purpose: driver writes-asks, lead writes-replies.

The name `driver-inbox.md` reads as "the driver's incoming messages" — i.e. messages addressed TO the driver. It actually contains messages addressed FROM the driver, sitting in the LEAD's reading queue. The semantics are backwards.

Observed cost:
- **Cross-team `tell-lead --team <other>` self-loops** (filed t-fd43d71a) — lead writes to its OWN driver-inbox.md when the verb is supposed to target a sibling team's inbox. The naming hides that the writer IS the lead writing into its OWN reading queue, not a driver writing into a remote inbox. The cwd-walk-up resolution then anchors to the wrong cage. Renaming clarifies the semantic: the lead is writing into ITS OWN `lead-inbox.md`, which is the obvious bug.
- **New-operator confusion** — readers see "driver-inbox" and assume it's where the driver receives messages. The pairing with `lead-outbox.md` (the lead's outgoing channel) makes the asymmetry doubly confusing.

The correct pairing is `lead-inbox.md` (lead reads) ↔ `lead-outbox.md` (lead writes). Both files belong to the lead's view: one inbound, one outbound. The driver is a writer to inbox + a reader from outbox — no driver-side file is needed at all.

### Why this isn't a design change

The semantic of the file is unchanged. The lead still reads it on every cycle. The driver (or any sibling cage's lead via cross-team tell-lead) still writes to it. The socket pubsub channel still fires the same event. Only the filename changes.

### Rename-mechanics precedent

This ADR follows the rename pattern established by ADR-133 (superdoctor → medic) + ADR-158 (martinet → sentinel) + ADR-160 (whip → poke):

1. New ADR documents rationale + supersession.
2. Source code renamed + tests cover new path; one-release back-compat shim on the read side.
3. On-disk migration walker handles existing cages.
4. Docs + briefs + ADR amendments land same-commit as code (per project [CLAUDE.md](../../CLAUDE.md) §Docs Discipline).
5. Doctor probe surfaces residue (any cage still on legacy filename post-grace).

The only delta from ADR-133/158 is that this rename touches a **state file** (per-cage on-disk markdown), not a code symbol — so the migration mechanic is `mv` walker rather than `git mv` + import rewrite.

## Decision

> **§Decision-anchor #1** — **`lead-inbox.md` is the canonical filename going forward.** Every `atmux` verb that previously wrote `.atmux/driver-inbox.md` writes `.atmux/lead-inbox.md` instead (canonical: `tell-lead`; if other verbs write, they migrate too). Every reader supports BOTH filenames for one release; deprecation-warn fires on legacy-read.

> **§Decision-anchor #2** — **One-release back-compat read shim.** During the grace window:
> - Writes go ONLY to `lead-inbox.md`.
> - Reads accept either file; if BOTH exist (mid-rollout race), the reader concat-merges by line-mtime and the migration walker (T2) resolves the residue.
> - Doctor probe `lead-inbox-legacy` warns on any cage still holding `.atmux/driver-inbox.md` after the migration walker has run.
> - After one release cycle, the read-side legacy path is removed; cages still on legacy refuse to read with `ConfigError: rename .atmux/driver-inbox.md → .atmux/lead-inbox.md per ADR-198`.

> **§Decision-anchor #3** — **Per-team on-disk migration walker.** A new code path (extends `atmux doctor --fix` OR new verb `atmux migrate lead-inbox`) walks every cage discoverable from cockpit.json + nested epic-teams + sibling cage dirs. Per-cage: idempotent rename. Both-files case: append-merge by mtime into new + delete legacy + log to `.atmux/logs/migration.log`. Sequential per-cage (CPU+RAM constraint already trivial; sequential keeps logs readable).

> **§Decision-anchor #4** — **Amend, don't rewrite, existing ADRs.** Per ADR append-only convention. ADR-010, ADR-042, ADR-092, ADR-138, ADR-154 each gain a `## Amendment 2026-05-20` paragraph naming the rename + pointing here. The ADR-154 filename itself uses `driver-inbox` in its slug; the file is NOT renamed (append-only also covers filename) — instead the body gains an amendment paragraph clarifying that `driver-inbox` in its title refers to the legacy name, with `lead-inbox` being canonical post-ADR-198.

> **§Decision-anchor #5** — **Skill-side sweep is in-scope (T3); broader stale-skill-ref cleanup is out.** The 7 coordination plugin SKILL.md files (bau, whip, tell-lead, heads-up, superdoctor, bruh, team) get the `driver-inbox` → `lead-inbox` text sweep as part of T3. Broader stale refs (`martinet` ROLE refs, `superdoctor` ROLE refs, `/whip` skill name, missing verb refs `atmux flag`/`atmux decisions`/`atmux task add --epic`) are filed as a follow-up Epic in the parent atmux kanban via T6 — out of this rename's blast radius.

### §Surface inventory — what gets renamed

| Surface | Action | Task |
|---------|--------|------|
| `src/verbs/tell-lead.ts` | write path → `lead-inbox.md`; read path accepts both for one release | T1 |
| `src/core/driver-inbox.ts` (if exists) | `git mv` → `src/core/lead-inbox.ts`; deprecated re-export alias | T1 |
| `src/verbs/tell-lead.spec.ts` (or wherever existing tests live) | extend tests: legacy-only / new-only / both-exist / merge-by-mtime / socket-event-fires | T1 |
| `lib/doctor/*` — new `lead-inbox-legacy` probe | new file | T1 |
| `templates/briefs/lead.md`, `templates/briefs/planner.md` | text sweep of `driver-inbox` references | T1 (same-commit doc-update) |
| `.atmux/driver-inbox.md` (every enabled cage on disk) | sequential walker rename | T2 |
| `docs/RUNBOOK-cockpit.md` (or sibling) | new §Migration runbook section for the walker | T2 (same-commit doc-update) |
| `~/.claude/skills/coordination/*/SKILL.md` (7 files) | text sweep | T3 |
| `docs/adr/010-atmux-flag.md` | §Amendment paragraph | T4 |
| `docs/adr/042-superdriver-phase-2-implementation.md` | §Amendment paragraph | T4 |
| `docs/adr/092-cross-team-tell-lead.md` | §Amendment paragraph (notes naming as contributing root to self-loop bug) | T4 |
| `docs/adr/138-verified-send-keys.md` | §Amendment paragraph | T4 |
| `docs/adr/154-driver-inbox-lead-outbox-sqlite-migration.md` | §Amendment paragraph; FILE NOT RENAMED (append-only covers filename) | T4 |
| `~/.claude-personal/projects/-root-work-src-atmux/memory/**/*.md` | content sweep | T5 |
| Tests for verb rename + walker idempotency | new integration suite | T7 |
| Trunk-signoff bundle | reviewer file under `docs/reviews/e-af5650db-trunk-signoff-*.md` | T8 |

### §Decomp follow-up filing (out of THIS rename)

T6 surfaces to parent atmux planner: file a NEW Epic in parent kanban for stale-skill-refs not caused by this rename — `martinet` ROLE refs (ADR-158 ship sweep gap), `superdoctor` ROLE refs (ADR-133 ship sweep gap), `/whip` skill rename (ADR-160; t-c2bb889f already filed — verify still active), `atmux flag` verb (memory `feedback_atmux_flag_verb_absent_in_084`), `atmux decisions` verb (same memory), `atmux task add --epic/--story/--deliverable` (ADR-193 + memory `feedback_task_add_lost_epic_story_deliverable_flags`).

### §EPIC-done definition

ADR-198 / EPIC e-af5650db completes when ALL of:

1. T1 lands — verb writes to `lead-inbox.md`; read shim accepts both; unit tests green; doctor probe registered; briefs same-commit doc-updated.
2. T2 lands — walker idempotent across all four branches (none/legacy/new/both); per-cage sequential; dry-run flag; RUNBOOK section same-commit.
3. T3 lands — 7 coordination plugin SKILL.md files sweep clean; `rg -i 'driver-inbox' ~/.claude/skills/coordination/` returns 0.
4. T4 lands — ADR-198 (this file) + 5 amendments to ADR-010/042/092/138/154 all on trunk.
5. T7 lands — integration tests green via `bun test --timeout 120000`.
6. T8 lands — reviewer trunk-signoff filed under `docs/reviews/`.

T5 (memory sweep) + T6 (follow-up filing) are non-blocking MISC tasks; they can land in or out of the Epic-done window.

## Consequences

### What this ADR enables

- **Semantic clarity** — readers see `lead-inbox.md` ↔ `lead-outbox.md` and immediately understand the asymmetric pairing (both are the lead's view; one in, one out).
- **Self-loop bug root-cause-fixed** — `tell-lead --team` self-loop (t-fd43d71a) was partly enabled by the naming making the lead-writes-to-own-inbox case feel less wrong. Renaming makes the bug obvious in code review.
- **Sibling-rename narrative complete** — ADR-133/158/159/160 swept role-type identifiers; ADR-161 swept window prefixes; ADR-198 sweeps the file-naming for the inbox pair. Cockpit-vocabulary refresh fully cohered.

### What this ADR does NOT cover

- **Driver-side outbox** — no equivalent on-disk file exists. Out of scope.
- **Member inbox JSON files** (`<member>-inbox.json` per ADR-076) — separate state-shape with established naming. No rename pressure.
- **Cockpit-level inbox** (if it exists; locate via grep) — out of scope; raise as a follow-up if confusion-cost surfaces.

### Rollback path

- **Source rename**: `git revert` the rename commit. The shim still reads both filenames, so a partial revert (e.g. revert the write-path change but keep the shim) keeps the system bilingual indefinitely.
- **On-disk migration**: each cage's walker invocation is logged to `.atmux/logs/migration.log`; reverse with `mv lead-inbox.md driver-inbox.md` per logged entry. Sequential per-cage.
- **Doctor probe**: leave the probe — it's additive; even on rollback the probe surfaces useful state.

### Reuse statement

- Rename mechanic: ADR-133 / ADR-158 / ADR-160 — reused.
- Append-only ADR convention: project [CLAUDE.md](../../CLAUDE.md) §Docs Discipline — reused.
- Same-commit doc-update gate: CLAUDE.md §Docs Discipline §2 — reused.
- NEW abstraction: none. Filename rename + read shim only.

### What breaks (during the one-release grace window)

- Nothing. Read shim accepts both filenames; writes go to new; walker resolves on-disk state.

### What breaks (post-grace-window)

- Cages that skipped migration: read shim removed → next `atmux tell-lead` cycle errors out with a hint naming ADR-198 + the walker invocation. Operator runs the walker; resolved.

## Open questions

1. **Should T2's walker also accept symlinks (legacy → new)?** Per ADR-026 §single-session pattern, some operators may have symlinked their state files; the walker should `realpath` resolve before mv. **Planner recommendation**: yes — `realpath` + handle symlinks. T2 worker implements.

2. **Doctor probe severity — warn vs. info?** **Planner recommendation**: warn during grace; info after grace (informational only — by then the legacy-key error from §Decision-anchor #2 carries the actionability).

3. **Should the walker run automatically at `atmux start`, or only via explicit verb?** Auto-at-start is hands-off; explicit is auditable. **Planner recommendation**: explicit verb (`atmux migrate lead-inbox` OR `atmux doctor --fix` checkbox). Auto-at-start adds startup latency × N cages and surprises operators who haven't read this ADR. Doctor surfaces the to-do; operator runs walker once.

4. **Memory file rename — should `feedback_atmux_tell_lead_team_flag_no_target_switch.md` body get the rename note, or also a filename rewrite?** **Planner recommendation**: body-only update per ADR-158 OQ#2 precedent (preserves git history; filename is internal).

5. **Discord template references** — any Discord templates citing `driver-inbox` by name? Locate via `rg 'driver-inbox' src/abstractions/discord*`. **Planner recommendation**: sweep in T3 along with skill text (text-only change in the same kind of file).

## Cross-references

- [ADR-010](010-atmux-flag.md) — atmux flag verb; consumes inbox semantics.
- [ADR-032](032-socket-pubsub-messaging-layer.md) — inbox-write fires socket event; renaming preserves the channel name.
- [ADR-042](042-superdriver-phase-2-implementation.md) — superdriver phase-2; reads inbox.
- [ADR-092](092-cross-team-tell-lead.md) — cross-team tell-lead; naming-confusion contributing root.
- [ADR-138](138-verified-send-keys.md) — verified send-keys; inbox-write surface.
- [ADR-154](154-driver-inbox-lead-outbox-sqlite-migration.md) — rename target (body-amendment only; file kept on legacy slug per append-only).
- Driver-ref: 2026-05-20 driver session — operator verbatim "fix it all".
- [[feedback_atmux_tell_lead_team_flag_no_target_switch]] — memory; partly motivating this rename.
- Sibling renames: [ADR-133](133-medic-rename.md), [ADR-158](158-martinet-to-sentinel-rename.md), [ADR-159 gitter→committer], [ADR-160](160-whip-to-poke-rename.md), [ADR-161](161-default-member-prefix-and-sort-verbs.md).
- Follow-up Epic (T6) for stale-skill-refs not covered: filed in parent atmux kanban post-Epic-done.
- Project [CLAUDE.md](../../CLAUDE.md) §Docs Discipline §Append-only ADRs.
