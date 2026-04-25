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

---

## S7 Addendum: Whip output noise — dedup, delta, staleMin, BUSY-suppress (added 2026-04-25)

**Driver-ref**: `driver-inbox.md` @ 18:52 MYT 2026-04-25

### Context

Once auto-rotation infrastructure landed (S1–S6), a second-order problem surfaced: whip's Discord output is *too noisy* and almost always *negative* (only complaints, no positive signal). Concretely:

1. **Repeat-firing**: whip re-emits the same finding-set every 5min until the underlying condition resolves. A single stuck task generates 12 identical pings/hour.
2. **No positive signal**: when the team is healthy and shipping, whip is silent. When something is wrong, whip is loud. Net result: the channel correlates "whip ping = bad news" — the driver tunes it out.
3. **Stale-flag false-positives**: claimed-30-min-ago is the old default, but real Tasks (demo walks, e2e rehearsals) legitimately take 60-90 min. The 30min ceiling is wrong for the post-E1 workload.
4. **Queued-msg false-positive**: whip flags 'Press up to edit queued messages' even when the pane is mid-thinking — but a queued msg in a busy pane WILL be submitted when the current turn ends. Not stale, not stuck; just user typing ahead.

S1–S5 made rotation reliable. S7 makes the *signal whip emits* worth reading.

### Decisions

#### D7 — Body-hash dedup via `.atmux/state/whip-last.hash`

After findings array is built, compute sha256 of the bullet content only (NOT the team header + timestamp — those change every tick and would defeat dedup). Compare to `<state>/whip-last.hash`; if identical, skip Discord ping (still write to whip.log + still advance decisions cursor). If different (or absent), ping fires + hash overwrites.

**Why**: A 12x/hour repeat ping for a single condition trains the channel to ignore atmux. One ping per *change* preserves novelty. Hashing bullets only (not header) keeps the hash stable across timestamp churn — a finding that recurs at 18:55, 19:00, 19:05 with identical body collapses to one ping.

**Why not**: Per-finding TTL (e.g. "re-fire after 30min even if same"). Adds two state files instead of one, and the right answer if a finding genuinely persists for 30+ min is "the lead should escalate," not "whip nags harder." The reviewer can lift this constraint if friction surfaces.

#### D8 — Delta section: positive signals since last hash mtime

When `whip-last.hash` exists, append a `📊 **Since last tick**` section with three buckets: commits (`git log --since=@<mtime>`), Tasks marked done (`completedAt > <mtime>`), Stories advanced (deferred — `stories[].advancedAt` is not yet a schema field). Skip the section entirely when all three buckets are empty (no "nothing happened" line — that's noise too).

Max cap: 5 entries per bucket, "+N more" suffix beyond. SHAs trimmed to 7 chars; Task IDs as-is (already 8 chars).

**Why**: Driver wants positive signal. Commits + done Tasks are the cheapest, most-correlated proxies for team productivity. Anchoring on whip-last.hash mtime (set by D7) gets the lookback window for free — no second cursor.

**Why not**: Track per-bucket cursors (e.g. `last-commit-cursor` separate from `last-tasks-cursor`). Single cursor is simpler, and there's no use case for asymmetric lookback windows yet.

#### D9 — staleMin: raise default 30→90 + per-Task `staleMin` field

Two changes, one Task (same lookup site):
- Default `team.json` whip.staleMin → 90 min for fresh inits. Existing teams keep their explicit value.
- `task.staleMin` (number, optional) — per-Task override that takes precedence over team default. Wired via `atmux task add --stale-min N`.

**Why**: 30 min was wrong for the post-E1 reality (demo Tasks routinely run 60-90 min). Raising the default fixes the common case; per-Task override handles outliers (4h+ e2e rehearsals) without forcing the team default to a meaningless ceiling.

**Reversibility**: HIGH — driver might want default=60 (less aggressive) or default=120 (more permissive). Logged as decision d-* via `atmux decisions add` so the override path is on a single channel.

#### D10 — BUSY-suppress for queued-msg flag only

The 'messages queued but not submitted' finding is suppressed when the pane shows BUSY indicators concurrently:
- `Esc to interrupt` (Claude actively running tool calls)
- `tokens` (active inference counter at bottom of pane)
- `thinking with` (extended-thinking mode)

Other findings (rate-limited, Compacting) are NOT gated by BUSY — they're independent error states, not normal operating modes.

**Why**: A queued msg in a busy pane WILL be submitted when current turn ends — that's not stale, it's user-typed-ahead. False-positive flagging trains the channel to ignore the finding in legitimate stuck cases.

**Why not**: Gate all findings by BUSY uniformly. Compacting + rate-limit ARE error states even if pane shows BUSY (compacting is the LLM rotting context; rate-limit is the harness blocking sends). Different signal classes.

### Consequences

**What changes**

- `lib/whip.sh` gains 4 helpers: `_atmux_whip_body_hash`, `_atmux_whip_delta_since`, `_atmux_whip_pane_busy`, `_atmux_whip_stale_anchor`.
- `.atmux/state/whip-last.hash` — new state file (sha256 of last-emitted bullet content).
- `templates/team.example.json` + `lib/init.sh` — `whip.staleMin` default changed to `90`.
- `kanban.json` task schema — optional `staleMin` field per Task (omitted = use team default).
- 4 new bats files: `whip_dedup.bats`, `whip_delta.bats`, `whip_stale.bats`, `whip_busy.bats`.
- ADR-009 §S7 (this addendum) — Status remains `accepted`.
- CHANGELOG v0.5.0 — single bullet alongside E2/E3/E4 entries.

**What breaks**

- Nothing. Dedup is a strict subset of "current behaviour fires every tick"; absent whip-last.hash → ping fires (matches today's behaviour). Default staleMin change only affects fresh inits; explicit values preserved.

**What we give up**

- Per-finding TTL re-fire (D7 alternative). If a finding genuinely persists for 30+ min, that's an escalation problem, not a nagging problem.
- Story-advance tracking in delta section (D8) — deferred until stories[].advancedAt schema field lands.
- BUSY-gating other findings (D10) — Compacting + rate-limit stay independent.

**Cross-Story coordination**

- D7 (dedup hash) is the anchor for D8 (delta section). T1 (`t-96390734`) ships first; T4 (`t-ac42591e`) deps on T1.
- T2 (`t-59ffacfd`, stale-task rotated.epoch anchor) is *separate* from t-7fae99db (lead-uptime check) — different code paths, different lines. Bumping t-7fae99db p2→p1 happens in parallel; not folded.
- T3 (staleMin default + per-Task override) is one Task, two file edits — the lookup site is shared.

### Open questions

- Should D9's `staleMin` override be reusable for *non-stale* Tasks (e.g. `task.maxAttempts`, `task.escalateAfterMin`)? Defer — only one consumer today; broaden when a second use case lands.
- Should the delta section include rotation events (♻️ N rotations since last tick)? Defer — rotation is already a high-signal Discord ping on its own; double-emit feels noisy.
- Should hash dedup respect a max-suppress-window (e.g. force-fire after 60min even if hash matches)? Defer — if a finding persists 60+ min, the lead should be escalating, not waiting for whip to nag again.

---

## S8 Addendum: relocated to ADR-008 §S8

**Relocated 2026-04-25** (driver-inbox @ 22:54 MYT). Decisions Discord gating + digest verb (D11–D14) lives in [`docs/adr/008-decisions-verb.md`](008-decisions-verb.md) §S8 — consolidating decisions-verb evolution under ADR-008. D-numbering preserved.

---

## S10 Addendum: Whip Since-last-tick enrichment + story.advancedAt schema field (added 2026-04-25)

**Driver-ref**: `driver-inbox.md` @ 22:34 MYT 2026-04-25
**Companion to**: ADR-008 §S10 (decisions-side cap removal + section-aware multi-message split).

### Context

S7 D7 introduced the `📊 Since last tick` block in whip's Discord output — a per-tick delta of positive events (commits + done tasks) since the previous body-ping. S7's shape was deliberately spartan: flat IDs for both buckets (`✅ N commits: abc123 def456 …` / `🏁 N tasks done: t-aaa t-bbb …`) and an explicit punt on story-advance tracking ("`story-advance tracking deferred (no .advancedAt schema field yet)`" — `lib/whip.sh:512`).

Driver use during E2 surfaces the limit: from a phone ping, the driver sees "5 commits, 3 tasks done since last tick" but has no idea **which Story** advanced, **who** shipped each commit, or **what** the commit is actually about. Decoding requires attaching to tmux + running `git log` + cross-referencing kanban — exactly the workflow the whip ping is supposed to displace.

S10 enriches each delta bullet with the context the driver needs to read progress at a glance — without inflating the message past Discord's per-bullet ≤80-char budget (per global CLAUDE.md "Discord message format" section).

### Decisions

#### D15 — Per-done-task bullet: `[E#/S#]` + subject + owner

Today (S7):

```
🏁 3 tasks done: t-fe5daf1b t-9a946e44 t-62249136
```

S10:

```
🏁 `t-fe5daf1b` [E2/S10] BE: drop per-field caps … — be-kanban
🏁 `t-9a946e44` [E2/S10] BE: multi-message split … — be-kanban
🏁 `t-62249136` [E2/S10] BE: per-done-task bullet … — be-kanban
```

- `[E#/S#]` prefix: parsed from `task.subject` (worker convention bakes the label into the subject — see existing `[E2/S10]` prefix scheme). Fall back to empty prefix if the task subject doesn't start with `[`.
- Subject: stripped of the leading `[E#/S#]` (avoid double-labeling), ellipsis-truncated so the full bullet stays ≤80 chars.
- Owner: read from `task.owner` field in `kanban.json` (already populated by `claim`).
- Cap: 5 displayed bullets + `+N more` pointer when the bucket holds >5 done tasks since cursor.

Implementation: extend the existing jq projection in `_atmux_whip_delta_since` to pull `subject` + `owner` alongside `id` (single jq pass, not N shell-outs).

**Why**: The driver scans the whip ping in 5-10 seconds on phone. Flat IDs force a context-switch into kanban; enriched bullets fit the same 5-10s scan budget while carrying enough signal to know what landed. ≤80 chars/bullet preserves the global "list-mode" rule.

**Why not**: Render full subject without prefix-strip. Doubles up `[E2/S10]` (whip's own prefix + worker's bake-in) — visual noise.

#### D16 — Per-commit bullet: sha + subject + author

Today (S7):

```
✅ 3 commits: 117c47e f322141 d700f8b
```

S10:

```
✅ `117c47e` feat(decisions): relax caps to 200/500 + 4 new flags … — George Yong
✅ `f322141` test(verify-libs): verify_libs.bats — green/red … — George Yong
✅ `d700f8b` test(flags): flags_discord.bats — p0/p1/p2 gate … — George Yong
```

- `git log --since="@$since" --pretty=tformat:'%h\t%s\t%an'` — `tformat:` (NOT `format:`) preserves the trailing newline fix from `f-3229e152` (S7 self-surfaced flag — `format:` drops the last entry's terminator and `read` skips one commit).
- Author: `%an` (commit author name; matches existing convention).
- Subject: ellipsis-truncated to fit ≤80 chars/bullet alongside `<sha>` + ` — <author>` overhead.
- Cap: 5 displayed + `+N more` pointer (mirrors D15).

**Why**: Same phone-actionability argument as D15. Author + subject is the minimum viable signal for "does this commit answer the question I have?".

#### D17 — `story.advancedAt` schema field, written on every transition

S7 deferred story-advance tracking with the line `story-advance tracking deferred (no .advancedAt schema field yet)`. S10 unblocks it:

- New schema field: `story.advancedAt` (epoch seconds), updated by `lib/story.sh::_atmux_story_advance` on **every** transition (`planning → ready → in-progress → testing → review → merging → done`) — not just terminal moves.
- Tolerant for existing stories: stories without `advancedAt` (predating the schema) are silently skipped by the whip bucket, not errored. Standard atmux additive-schema pattern.
- No backfill — old stories keep `advancedAt: null`. Whip surfaces only stories that moved *after* the schema landed.

`lib/whip.sh::_atmux_whip_delta_since` gains a third bucket alongside commits + done-tasks:

```
📈 `s-a9daade4` [E2] S10: Discord output depth … → in-progress
📈 `s-3196139d` [E2] Whip auto-rotation on threshold → done
```

Bullet shape: `📈 \`<story-id>\` [E#] <title> → <newState>` — ≤80 chars/bullet, ellipsis-truncated. Cap at 5 + `+N more`.

**Why per-transition (not terminal-only)**: The driver wants to see Stories *moving* on phone, not just *finishing*. `in-progress → testing` is the signal "code's ready, tests imminent" — exactly the kind of mid-flight visibility the whip ping is meant to provide. Terminal-only would lose the testing/review/merging beats that matter for E2-style multi-Story Epics.

**Why not prior-state tracking** (`from → to`): Would require an `advanceLog: [{epoch, from, to}]` array per story, plus migration concerns for stories that have already advanced. YAGNI for now — `→ <newState>` carries enough signal; the prior-state can be inferred from the state machine if anyone needs it.

#### D18 — ≤80-char/bullet preserved across all three buckets

The global CLAUDE.md "Discord message format" rule (≤80 chars/bullet, list-mode rendering) survives S10. Long content gets ellipsis-truncated, NOT wrapped onto multiple lines. This is the opposite design choice from ADR-008 §S10's section-aware chunking — and that's deliberate:

| | Whip Since-last-tick | Decision pings |
|--|--|--|
| Surface | Line-oriented scannable list | Document-oriented multi-section template |
| Per-line budget | ≤80 chars (CLAUDE.md global rule) | Unbounded (chunked across messages) |
| Truncation strategy | Ellipsis-cut content | Multi-message split, fall back to drop-fields |

Two different rendering surfaces, two different constraint sets. Same project, same Story, deliberately divergent — see ADR-008 §S9 D2 for the original framing of this dichotomy. S10 simply applies the framing to two more rendering surfaces (commits + advanced-stories).

**Why**: Whip is a list of N findings; cramming long content into one bullet drowns the other N-1 findings. Decisions emit ONE entry as a multi-section block; long content in a section IS the entire point.

### Consequences

**What changes**

- `lib/whip.sh::_atmux_whip_delta_since`: rewrite the rendering path for both existing buckets (commits + done-tasks) + add the third bucket (advanced-stories). Updates the deferred-tracking comment.
- `lib/story.sh::_atmux_story_advance`: writes `advancedAt` epoch on every transition (T5 — `t-ff60d3e8`).
- Schema doc (README or kanban schema reference, if either enumerates story fields): note `advancedAt`. No code-side migration — additive field, tolerant readers.
- `tests/unit/whip_delta.bats`: extend with per-task / per-commit / advanced-story coverage (T7 — `t-416c1b31`).
- `templates/briefs/lead.md` + `templates/briefs/planner.md`: brief callout coordinated with ADR-008 §S10 sibling task (T8 — `t-4f5f0d22`).
- ADR-009 §S10 (this addendum) — Status remains `accepted`.
- CHANGELOG v0.5.0 — single bullet alongside ADR-008 §S10 row (T10 — `t-7db2c3bf`, shared row).

**What breaks**

- Nothing. Schema field is additive (tolerant readers); whip render is additive (third bucket on top of two existing buckets); ≤80-char rule preserved.

**What we give up**

- Flat ID rendering (D15 / D16 alternatives). Cost: jq projection + per-bullet truncation logic. Worth it — driver gets phone-actionable progress signal.
- Prior-state in advanced-story bullet (D17 alternative). Cost: schema complexity (advanceLog array). Not worth it for the marginal "from→to" signal.

### Resolutions to S10 open questions (ADR-009 side)

- **OQ3 (`d-59c3e834`)** — `story.advancedAt` written on every transition, not terminal-only. Reversibility: low. Per-transition is cheap and gives whip mid-flight visibility.
- **OQ4 (`d-111eef7e`)** — Strip leading `[E#/S#]` from `task.subject` in whip enrichment to avoid double-labeling. Reversibility: low. Falls back to raw subject if no prefix present.

### Open questions

- Should `advancedAt` also track **WHO** advanced the story (lead vs gitter vs auto-by-claim-completion)? Defer — current `_atmux_story_advance` callers are all human-issued or gitter-issued; if auto-advance ever lands, surface "by" then.
- Should the advanced-story bullet show `from → to` once an `advanceLog` exists? Defer — ties to D17 alternative; revisit if downstream consumers ask.
- Should whip surface stories that moved **backward** (e.g., review → in-progress because reviewer rejected)? Today: the same `📈` bullet renders regardless of direction — `→ in-progress` reads correctly for either direction. Acceptable; revisit only if directionality becomes a UX issue.
