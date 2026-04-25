# ADR-009: Robust auto-rotation infrastructure

**Status**: accepted
**Date**: 2026-04-25
**Epic**: E2 (`e-85786b60`)
**Driver-ref**: `driver-inbox.md` RESUME-2 entry, 15:35 MYT 2026-04-25

## Context

Today `lib/whip.sh` *recommends* lead rotation when uptime ≥ 60 min:

```
findings+=("♻️  lead uptime=${uptime_min}min ≥ ${LEAD_MAX_MIN}min — consider `atmux rotate-lead`")
```

…but never executes the rotation. Worse, uptime is anchored to `.atmux/state/session-start.txt` — which `lib/rotate.sh` does NOT update on completion. So once a lead has been rotated, whip keeps re-flagging "uptime ≥ 60 min" every 5 min forever, because the anchor never moves.

The RESUME-2 incident (2026-04-25) made this concrete:

- Lead ran 4h+ on accumulating context.
- Missed a fe-kanban reply for 20+ min due to stale-context blindness.
- E1 dispatch chain stalled.
- Driver had to manually `/clear` and re-bootstrap the lead.

CLAUDE.md mandates auto-rotation at 60 min. Atmux must enforce it, not just suggest it. But auto-`/clear` is destructive — it wipes a teammate's full conversation context — so it must be **opt-in**, not default.

Banner-driven preclear (Compacting / "approaching usage limit") is a parallel signal: when the harness itself tells us context is rotting, we should act on the signal regardless of uptime.

## Decisions

### D1 — Per-member rotation epoch state file

`lib/rotate.sh` writes `.atmux/state/<member>-rotated.epoch` on every successful rotation. Path follows the existing flat-file convention in `.atmux/state/` (`session-start.txt`, `last-report.epoch`, `decisions-cursor`). No sub-directory.

**Why**: Without this, whip's uptime calc has no anchor to reset. Per-member granularity (instead of one global `last-rotation.epoch`) supports future per-member auto-rotation, not just lead.

### D2 — `team.whip.autoRotate` config flag, default `false`

A boolean in `team.json` under the `whip` key. When `false` (default): whip preserves today's behaviour — emits a "consider rotate-lead" finding, takes no action. When `true`: whip auto-execs `atmux rotate-lead` at uptime threshold AND auto-execs `atmux rotate <member>` on banner detection.

**Why**: `/clear` destroys conversation context. Silent migration is non-negotiable — existing teams must not get auto-`/clear`'d the moment they upgrade. Opt-in framing also makes the flag a deliberate choice the team owner has to make once, with full understanding of the trade-off (context loss vs context rot).

### D3 — Banner preclear gated by the same `autoRotate` flag

One knob, two triggers. When `autoRotate=true`, BOTH uptime threshold AND banner detection (Compacting / approaching usage limit / hit your limit) trigger a rotation.

**Why**: Two flags (`autoRotate` + `autoPreclear`) bloats the mental model. The team owner who opts into automation wants both signals acted on. The team owner who doesn't wants neither. We will revisit if real-world friction surfaces — adding `autoPreclear: bool` later is non-breaking.

### D4 — Banner-preclear debounce: 5 min via rotated.epoch

If a member was rotated <5 min ago (read from `<member>-rotated.epoch`), suppress further banner-preclear for that member until 5 min has passed.

**Why**: A "Compacting conversation" banner can persist across multiple `tmux capture-pane` reads as the pane scrolls. Without a debounce, whip would re-rotate on every 5-min tick. The threshold matches whip's own cron cadence — at most one preclear per cron tick per member.

### D5 — Lead auto-rotate disrupts driver mid-conversation; accepted cost

If the driver is mid-conversation with the lead when auto-rotate fires, the lead pane gets `/clear`'d while the driver is typing. This is disruptive but acceptable: the alternative (silently letting context rot for 4h+) is worse, and the driver gets a Discord ping (`♻️ AUTO-ROTATED lead at <ts>`) so they can resume the thread on the freshly-bootstrapped lead.

Documented in `templates/briefs/lead.md` so future lead instances know what happened to the previous lead's pane.

**Why**: We considered "if driver is mid-send, defer rotation by one tick" but that creates an arbitrarily-long deferral chain (driver could be typing for hours during a long debug session). Hard cutover is simpler and correctly prioritises the team's longevity over the driver's single-tick convenience.

## Consequences

**What changes**

- `lib/rotate.sh` writes one new state file per call (idempotent overwrite).
- `lib/whip.sh` uptime calc switches from session-anchored to rotation-anchored. Existing teams (no `<member>-rotated.epoch` file) fall back to session-start.txt — zero behavioural change for them until the first rotation lands.
- `team.json` schema gains an optional `whip.autoRotate` boolean.
- `templates/team.example.json` documents the flag (commented-out, default false).
- 3 new bats files: `tests/unit/rotate.bats`, `tests/unit/whip_rotate.bats`, `tests/unit/whip_preclear.bats`.
- 1 new e2e: `tests/e2e/rotation.bats`.
- Brief updates: `templates/briefs/lead.md` (rewrite §Auto-rotation), `templates/briefs/member.md` (new §Auto-preclear).

**What breaks**

- Nothing for `autoRotate=false` (default). Pure no-op migration.
- For teams that opt in: the lead pane WILL be `/clear`'d at 60-min uptime without further driver intervention. This is the feature, not a bug, but it's a behavioural break worth documenting in CHANGELOG v0.5.0.

**What we give up**

- Per-banner-type configurability (e.g. "preclear on usage-limit but not Compacting"). Folded into `autoRotate` for MVP simplicity. If team owners want finer control, ADR-009 follow-up.
- Defer-on-driver-typing politeness. See D5.
- Member-level granularity on the autoRotate flag (it's team-wide). If a team wants "auto-rotate the lead but not the planner," that's a follow-up.

**Cross-Epic dependency**

E4 (`atmux flag` verb — t-e75cff7b, member→lead structured issue surfacing) depends on E2: the flag verb needs to know whether a member is currently rotating, otherwise a "flag fired during rotation" gets lost. Item 007 of `/root/.claude/tasks/atmux/` describes the `epic.blockedBy` schema for cross-Epic deps; once E4 is decomposed, its first Story should declare `blockedBy: ["e-85786b60"]`.

## Open questions deferred to future Epics

- Per-banner-type config (`autoPreclearCompacting: true`, `autoPreclearUsageLimit: false`). Defer until real friction surfaces.
- Per-member autoRotate override (`members[].autoRotate`). Defer until a team has heterogeneous rotation needs.
- Defer-on-driver-typing politeness (whip detects driver pane is in typing state, defers one tick). Defer — adds complexity without clear ROI.
- Auto-rotate the driver itself. Out of scope — driver is human. **Addressed via S6 addendum below — atmux can't `/clear` the driver, but it CAN emit a recovery brief on demand.**

---

## S6 Addendum: Driver rotation parity (added 2026-04-25)

**Driver-ref**: `driver-inbox.md` @ 18:20 MYT 2026-04-25

### Context

S1–S5 ship rotation infrastructure for team members + lead. The driver (the human operating atmux + their own Claude session) has no equivalent. atmux can't `/clear` the driver — that's outside atmux's scope — but it CAN emit a structured catch-up brief that a fresh-driver session runs to recover state in <30s. Without this, every fresh driver session re-derives state ad-hoc by reading driver-inbox + lead-outbox + kanban + git log + epic list.

### Decisions

#### D6 — `atmux brief-driver` is single-screen, ≤30 lines, on-demand only

Output is a snapshot: counts, branch ahead, active loop, open driver-inbox entries, latest 3 lead-outbox entries, in-progress Tasks, recovery command sequence. Single-screen so the driver reads it without paging. NOT auto-fired on team start, NOT cron-scheduled — driver runs it when their Claude session compacts/clears or when they return after >2h away.

**Why**: Auto-fire creates noise (driver doesn't need a recovery brief during normal operation). Single-screen forces signal density — if it doesn't fit in 30 lines it's not a recovery brief, it's a status dashboard (different verb). Sub-second runtime (target <500ms) keeps the verb cheap to invoke repeatedly during stale-context recovery.

#### D7 — `.atmux/driver-state.md` lives team-scoped, not driver-private

State file at `.atmux/driver-state.md` (alongside `decisions.md` + `flags.md`), NOT under `~/.claude/`. Team-scoped: visible to lead/planner via `cat`, survives team-`/clear`, picked up by `git status` if driver wants to commit history.

**Why**: Driver-private would hide judgment calls from the team (lead can't read the rationale behind "push hold continues" or "S9 sandbox path option (c)" without driver re-explaining each session). Team-scoped means the lead can read the digest header on any whip turn and match driver intent without round-tripping.

#### D8 — `atmux driver note` mirrors `atmux decisions add` shape; no Discord

Same `### dn-xxxxxxxx` heading + bullet field format as `decisions.md`. Same `--reversibility low|medium|high` flag. Same ≤60-char message ERROR (per d-485b965d). NO Discord ping (driver is human, doesn't need self-ping; lead pings driver via existing channels if action needed).

**Why**: Symmetry with `atmux decisions` keeps the parser pattern + worker mental model unified — anyone who knows `decisions add` instantly knows `driver note`. No Discord because the driver IS the audience; pinging yourself is noise.

### Consequences

**What changes**

- New `lib/driver.sh` (~150-200 LOC) with `brief-driver` verb + `driver` parent verb (`driver note` subcommand).
- New state file `.atmux/driver-state.md` (append-only, scaffold seeded on first `driver note`).
- `bin/atmux` gains `brief-driver` + `driver` dispatcher entries.
- 1 new bats file: `tests/unit/driver.bats`.
- README.md + docs/GETTING_STARTED.md gain §"Driver rotation".
- `templates/briefs/lead.md` gains §"Suggesting brief-driver" (when lead pings driver).

**What breaks**

- Nothing. New verbs, new state file. Existing flows untouched.

**Cross-Story coordination**

- `templates/briefs/lead.md` is touched by S6/T6.6 AND S4/T4.1 (auto-rotation section). Both Tasks edit the same file; gitter sequences commits or fe-kanban stacks edits per Task.
- `bin/atmux` is touched by every BE Task across E2/E3/E4 — already an established merge zone, gitter handles per-commit.

### Deferred

- `atmux brief-driver --json` for tooling consumption. Defer — driver is human-first.
- Auto-export driver-state.md to a remote channel (Discord/Slack) on threshold. Defer until friction.
- Driver-state digest summarisation (LLM-generated TL;DR). Out of scope — atmux is bash, not an LLM caller.
