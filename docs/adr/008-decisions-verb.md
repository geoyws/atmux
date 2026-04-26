# ADR-008: `atmux decisions` verb — first-class decision log + Discord ping

**Status**: accepted
**Date**: 2026-04-25

## Context

Per global CLAUDE.md, the lead is supposed to make recommended decisions autonomously and surface them to driver via `pending-decisions.md` under "🟡 Auto-mode resolutions" with **"override by replying — cheap now, expensive once merged"** framing. The driver wants those resolutions ALSO pinged to Discord so they can override on phone without attaching to tmux.

Today the lead/planner does this with a hand-rolled `bash + ping-discord.sh` dance — error-prone, easy to skip, and not visible to other team members. The new pull-based kanban model (ADR-007) amplifies this need: with workers pulling from the kanban, the lead's explicit decisions on ambiguous Stories/Tasks become the **only synchronous signal the driver gets**. Discord is the right channel — async, mobile, already wired (`lib/discord.sh`, `report.sh`, `whip.sh`).

This ADR captures the design + driver-resolved open questions. Folded into the in-flight pull-kanban Epic as Story S10 (NOT a separate Epic).

## Decision

### New verb suite

```
atmux decisions add <question> --default <answer> [--reversibility low|medium|high] [--note <txt>]
atmux decisions list [--since <when>] [--reversibility <level>]
atmux decisions show <id>
```

`add` writes to `.atmux/decisions.md` AND immediately pings Discord with the `[atmux-decisions]` template (per global CLAUDE.md Discord format spec).

### State file

`.atmux/decisions.md` — team-scoped, per-team. Append-only log. One entry per decision with: id, timestamp (MYT), question, recommended default, reversibility, optional note, optional override deadline. Markdown for human-readability + git-diffability (consistent with kanban.json's choice in ADR-007).

### Discord template

Per global CLAUDE.md format (header + bulleted body + per-bullet emoji, ≤80 chars/bullet):

```
📋 **[atmux-decisions]** · `{team}` · HH:MM MYT

🔵 <question — ≤80 chars>
✅ default: <answer — ≤80 chars>
🟢/🟡/🔴 reversibility: low|medium|high
📍 atmux decisions show <id> · override: atmux send lead "override <id>: <new>"
```

Send code reuses `lib/discord.sh::atmux::discord_ping` — no reinvented `curl`. Webhook resolution unchanged: `team.discord.webhook` → `ATMUX_DISCORD_WEBHOOK` env → silent no-op if unset (preserves no-webhook flow).

### Whip integration

When `whip` detects new decision entries since last tick (mtime on `.atmux/decisions.md` + cursor file `.atmux/state/decisions-cursor`), include a one-liner pointer in the whip Discord ping:

```
📋 N new decisions — atmux decisions list
```

Whip does NOT duplicate decision bodies. Whip flags; the decisions verb announces.

### Brief integration

- **lead.md brief**: lead calls `atmux decisions add` for every auto-resolution instead of free-form pending-decisions.md edits.
- **planner.md brief**: planner calls `atmux decisions add` for every resolved open question during Epic decomposition.
- These changes are baked into the existing S6 brief rewrites (T6.1 lead.md + T6.2 planner.md). A separate S10 follow-up Task (T10.4) adds the verb-usage section to BOTH briefs after the S6 rewrites land — single commit, no concurrency conflict with S6.

## Resolutions to driver-flagged open questions

The driver pre-resolved these in the addendum entry:

1. **`.atmux/decisions.md` vs reuse global `pending-decisions.md`?** → **NEW `.atmux/decisions.md`**. Team-scoped state belongs under `.atmux/`. `pending-decisions.md` is a project-level driver-facing doc per global CLAUDE.md; atmux's per-team log is a different concern. Symlink or include-by-reference if a project wants both visible.

2. **Per-add ping vs batch-on-whip?** → **IMMEDIATE per-add ping**. Decisions are low-volume and time-sensitive — driver wants the override window NOW, not in 5min. Whip adds the "N new since last tick" pointer for missed pings; it does not replace immediate sends.

3. **`--severity` P0/P1/P2 flag?** → **NO for MVP**. `--reversibility` already captures the "do I need to override fast?" signal. Add severity in a follow-up Epic if friction emerges.

## Dogfood / meta-test

Once T10.1 ships (the verb is callable), planner uses `atmux decisions add` to record THESE THREE resolutions as the verb's first three real entries. This eats its own dogfood + provides a real Discord-render smoke test of the template before Epic verification §2 runs.

## Consequences

### What we gain

- **Autonomy with override visibility.** Lead/planner make the call; driver sees it within seconds on Discord.
- **Audit trail.** `.atmux/decisions.md` is committed alongside the Epic; future readers see what was decided and when.
- **Standardised template.** No more freelance ping formatting — one template, one verb.
- **Reused Discord plumbing.** No new webhook / curl / retry logic. Failure modes inherited from `lib/discord.sh`.

### What we give up

- **One more lib file** to maintain (`lib/decisions.sh`).
- **One more whip-tick check** (`mtime` + cursor read on `.atmux/decisions.md`). Cost: <1ms per tick.
- **Discord noise risk** if a planner spams `decisions add` for trivial calls. Mitigation: brief explicitly says "use ONLY for genuine recommended-default applications, not free-form notes — that's what `--note` on `task add` is for."

### Alternatives considered

- **Reuse global `pending-decisions.md`** — Rejected per OQ1: scope mismatch, cross-project pollution.
- **Batch-on-whip Discord pings** — Rejected per OQ2: defeats the time-sensitive override window.
- **Generalise into `atmux ping <template> <args>`** — Considered. Rejected: premature abstraction. Each template has different fields (decisions vs progress vs blocker); flat-verb sub-templates are clearer than a meta-verb. Revisit if 3+ similar templates emerge.

## Scope boundary

S10 ships ONLY the verb + state file + Discord wiring + whip pointer + brief supplement + tests. **Out of scope** for this Epic (defer to follow-ups):

- Override-via-Discord-reply integration (driver replies in Discord thread → atmux picks up the override). Today: driver still types `atmux send lead "override ..."` on phone or laptop.
- Decision expiry / auto-archive (>7 days old → move to `.atmux/decisions-archive.md`).
- `--severity` (per OQ3 deferral).
- Aggregation in `atmux epic show` (show resolved decisions per Epic).

These can be a follow-up Epic; not blocking ship.

---

## S8 Addendum: Decisions Discord gating — reversibility gate + whip inline preview + digest verb (added 2026-04-25)

**Driver-ref**: `driver-inbox.md` @ 19:47 MYT 2026-04-25
**Provenance**: Originally authored in `docs/adr/009-auto-rotation.md §S8`; relocated 2026-04-25 (driver-inbox @ 22:54 MYT) to consolidate decisions-verb evolution under ADR-008. D-numbering preserved (D11–D14) — pre-relocation cross-references resolve as-is.

### Context

ADR-008 (`atmux decisions add`) ships per-add Discord ping for every recorded decision. After S7's noise sweep on whip, the same noise pattern surfaced for decisions: each per-add ping is valuable for HIGH-reversibility calls (driver may want to override mid-flight) but floods the channel for LOW/MED calls (planner judgment, not driver-actionable in real time).

Counts from today alone: 8 decisions logged across S7 decomposition + earlier sessions. Of those, 1 was reversibility=high (driver-actionable), 7 were low/med (planner judgment). The Discord channel got 8 pings; the channel-reader cared about ~1.

S8 makes Discord visibility a function of *whether the driver should care now*, not *whether a decision was logged*.

### Decisions

#### D11 — Reversibility gates Discord ping

In `_atmux_decisions_add` (lib/decisions.sh), the `atmux::discord_ping` call is conditional on `reversibility == "high"`. Low/medium still write to `.atmux/decisions.md` (markdown log unchanged) but skip the per-add Discord ping. High preserves today's behaviour — immediate ping, override channel intact.

**Why**: Driver-override likelihood maps cleanly to reversibility tier. Low = planner can't be wrong in a way that hurts; med = planner default with documented trade-off; high = potentially-irreversible / driver-actionable. Gating on tier matches the actual signal class.

**Why not**: Per-decision opt-out flag (`--no-ping`). Adds knob bloat; reversibility tier already encodes the right answer. Reviewer can lift this if a real use case for "high-reversibility but quiet" surfaces.

#### D12 — `atmux decisions digest` verb consolidates skipped pings

New verb. Reads `.atmux/state/decisions-digest-cursor`, lists decisions with `timestamp > cursor`, posts ONE consolidated Discord message (with [N/M] split if > 2000 chars), advances cursor on completion. Empty window → no ping (cron-friendly silence). Cron snippet in README documents hourly cadence.

**Why**: Low/med decisions are still useful to surface to the driver — just not in real time. Hourly batch is the right cadence: low-frequency enough that the channel doesn't churn, frequent enough that decisions don't pile up before the driver can override (within the override window most low/med decisions implicitly carry).

**Why not**: Email/RSS/file-only audit trail. Discord is already the team's primary low-friction notification surface; routing low/med decisions through a *second* channel splits attention. Same surface, different cadence.

#### D13 — Digest cursor is separate from whip's decisions-cursor

Two cursors:
- `.atmux/state/decisions-cursor` — whip's per-tick check (S7/D7-aware, advances on every whip tick that fires a body-ping).
- `.atmux/state/decisions-digest-cursor` — `atmux decisions digest`'s per-run cursor (advances only on hourly digest run).

Independent state files, independent advancement.

**Why**: The two consumers have different windows. Whip wants "since last 5min tick" (count + inline preview); digest wants "since last hour-mark" (consolidated body). Sharing one cursor would mean each consumer steals the window from the other — whip's tick advances the cursor, digest then has nothing to consolidate.

#### D14 — 2000-char split: chunk by-decision with [N/M] continuation marker

Discord webhook hard limit is 2000 chars per message. When digest body > 2000:
- Chunk by-decision (never split mid-decision — each chunk's last bullet is a complete decision).
- Prepend `[N/M]` to each chunk's header (e.g. `📋 **[atmux-digest]** [2/3] · ...`).
- Sleep 1s between chunks (Discord per-webhook rate limit is 30/min; 1s is a safe margin).
- Cursor advance happens after the LAST chunk pings (fire-and-warn — `discord_ping` swallows rc, so cursor advances regardless of partial-failure; matches existing whip decisions-cursor semantics).

**Why**: 2000-char limit is real and atmux must handle it. Chunk-by-decision (vs split-mid-bullet) keeps each chunk human-readable. [N/M] makes ordering recoverable if Discord delivery is out-of-order.

**Why not**: Truncate at 2000 with "+N more — see decisions show". Loses information in a domain (decisions log) where information loss has compliance cost. Split is strictly more transparent.

### Cross-Story note: E4 inherits this pattern

E4 (`atmux flag` verb, `e-186a469d`) ships a similar per-add Discord ping pattern (per Task t-5b96b9ee — `flag add --severity p0 → [atmux-flags] Discord template`). The same noise/signal trade-off applies: p0 should ping immediately, p1/p2 should batch. When E4 enters planning, the planner should:
- Mirror D11 (severity=p0 pings, p1/p2 skip).
- Add `atmux flag digest` verb mirroring D12.
- Reuse the chunking helper from D14 (extract to `lib/discord.sh::atmux::discord_chunk_post` if both verbs need it — out of scope for S8, defer until E4 planner re-touches it).

NOT folded into S8 because E4 is its own Epic with separate ADR-010. Logged here so the E4 planner has the context.

### Consequences

**What changes**

- `lib/decisions.sh` gains the gate (D11) + new `digest` verb (D12).
- `bin/atmux` dispatcher gains `decisions digest` route.
- `lib/whip.sh` `_atmux_whip_check_decisions` gains inline preview of latest 3 (T4).
- `.atmux/state/decisions-digest-cursor` — new state file.
- `templates/briefs/lead.md` + `templates/briefs/planner.md` — reversibility ladder section.
- `README.md` — cron snippet for digest.
- 2 new bats files: `decisions_gating.bats`, `decisions_digest.bats`.
- ADR-008 §S8 (this addendum) — Status remains `accepted`.
- CHANGELOG v0.5.0 — single bullet alongside S7 + E2/E3/E4 entries.

**What breaks**

- For teams that relied on per-add Discord ping for low/med decisions: behavioural break. Mitigation: digest verb runs hourly via cron (documented). Override window for high-reversibility calls is unchanged.
- decisions.md log shape unchanged — no migration needed.

**What we give up**

- Real-time visibility for low/med decisions. Trade is: noise reduction on the channel vs immediate driver awareness for non-driver-actionable calls. D12's hourly digest narrows the gap.
- Per-decision opt-out flag (D11 alternative). Defer until friction.

### Open questions

- Should digest run on `atmux team start` to flush stale decisions from a long quiet period? Defer — cron handles steady state; manual `atmux decisions digest` covers warm-up.
- Should E4's flag-digest reuse the same cursor as decisions-digest? Defer to E4 planner — likely no (different audiences) but the call belongs at E4-planning-time.
- Should the chunking helper be hoisted to `lib/discord.sh` for reuse by E4? Defer — premature abstraction with one consumer; revisit when E4 lands.

---

## S9 Addendum: Richer template — relax field length, context/options/impact/decided-by, backwards-compat (added 2026-04-25)

**Driver-ref**: `driver-inbox.md` @ 21:55 MYT 2026-04-25
**Companion to**: §S8 (gating + digest verb) — co-located in this ADR per the relocation noted in §S8 Provenance.

### Context

ADR-008's original spec capped question/default/note at 60 chars each — a deliberate constraint to keep each Discord bullet under the global ≤80-char-per-bullet template budget (per global CLAUDE.md "Discord message format" section). This was right for a one-bullet-per-field rendering surface where decisions sat alongside whip findings in a scannable list.

Driving force for S9: actual usage during E2 decomposition surfaced that a 60-char question or default routinely *can't* capture the call faithfully. Examples from this Epic alone:

- "E2/S7: dedup hash includes timestamp?" — terse but loses the rationale (defeats dedup if true).
- "E2/S8: gate Discord on reversibility=high?" — fits, but the *implication* (low/med skip Discord) is lost.

A driver overriding from phone can't tell whether the default is right without the rationale. Today they have to attach to tmux + read decisions.md or Epic context. That's a phone-actionability fail.

S9 makes high-reversibility decision pings standalone-actionable: enough fields to override (or confirm) without re-attaching.

### Decisions

#### D1 — Relax field caps (60 → 200/500/80)

- `question`, `default`: 60 → 200 chars
- `note`, `context`, `impact`: 500 chars (note keeps existing; context + impact new)
- `option` (new, repeatable): 200 chars per occurrence, max 5 occurrences
- `decided-by` (new): 80 chars (still short — it's a person/role name, not prose)

ERROR (not silent-truncate) on overflow — preserves the reviewer-flagged "rewrite tighter" semantics from the original ADR-008 §3.

**Why**: Real decisions need real context. 200 chars holds a one-sentence question; 500 holds a paragraph of impact analysis. Going wider than 500 hits the Discord 2000-char cap quickly when all fields are populated; the cap is calibrated to "all fields full ≈ 2000 chars worst case."

**Why not**: Unbounded fields. Discord 2000-char hard limit doesn't go away; pushing the cost into render-time chunking (S8/D14 pattern) for every decision feels like punishing the common case. Bounded fields keep the common case to one Discord post.

#### D2 — Why decision pings escape the 60-char whip-bullet cap

Two different rendering surfaces, two different constraint sets:

| | Whip findings | Decision pings |
|--|--|--|
| Surface | Line-oriented scannable list | Document-oriented multi-section template |
| Reading mode | Skim ≥10 bullets, pick what's actionable | Read 1 entry end-to-end, decide override y/n |
| Per-line budget | ≤80 chars (CLAUDE.md global rule) | ≤200/500 (per-field, but field IS the bullet) |
| Visual feel | List entry | Card / form |

Whip emits N findings as N bullets; cramming long content into a bullet drowns the list. Decisions emit ONE entry as a multi-section block; long content in a section is the entire point. The 60-char cap was a category error for decisions — it applied a list-mode rule to a card-mode rendering. S9 fixes the category.

#### D3 — Skip empty optional sections in Discord render

The 4 new fields (context, option, impact, decided-by) are all optional. When absent, the renderer SKIPS the section entirely (no `🌐 context: ` empty line, no `⚖️ options:` header followed by zero bullets).

**Why**: Backwards-compat (a 4-field call renders bit-identical to today's template) + signal density (empty section headers are noise).

**Why not**: Always render headers with `(none)` body. Adds noise, no information.

#### D4 — Backwards-compat strategy

- **Old calls**: `atmux decisions add "q" --default "d" [--reversibility ...] [--note ...]` work unchanged. Fields not passed → empty string → skipped in render + omitted from .md persistence.
- **Old .md entries**: parsed via the same `_decisions_to_json_array` awk; new fields are tolerant (missing → null in JSON). No migration script needed.
- **Old JSON consumers** (whip inline preview from S8/T4, digest from S8/T3): see new fields as null and either ignore or surface as empty — both safe.

**Why**: Migration scripts on per-team state files are operationally expensive (every team owner has to run them at upgrade time). Tolerant parsing is free.

#### D5 — Discord 2000-char overflow strategy for single decisions

When the rendered body of a SINGLE decision exceeds 2000 chars (rare — all-max ≈ 2100):

Truncation order: `note` → `impact` → `options` (drop excess opts beyond 2) → `context`. Append `↳ atmux decisions show <id> for full` to the truncated post.

NOT chunked across multiple Discord posts (S8/D14's chunk-by-decision pattern is for digest, where multiple decisions are the chunk boundary; a single decision doesn't have a natural chunk boundary). Single-decision overflow is rare enough that graceful truncation is the right pattern.

**Why**: Single-decision >2000 chars is an edge case. Truncation preserves the most-load-bearing fields (question + default + reversibility + decided-by always survive); the overflow pointer gives the driver an escape hatch to read the full entry. Multi-post-per-decision would fragment the override action ("which post do I reply to?").

### Consequences

**What changes**

- `lib/decisions.sh` `_atmux_decisions_add`: 4 new flag handlers + cap validators.
- `lib/decisions.sh` `_decisions_append`: emit new optional fields when non-empty.
- `lib/decisions.sh` `_decisions_to_json_array`: parse new fields including options sub-list.
- `lib/decisions.sh` `_decisions_render_discord`: full template rewrite with skip-empty-section logic + truncation order for >2000-char overflow.
- `templates/briefs/lead.md` + `templates/briefs/planner.md`: 'When to provide each optional field' section + worked example. Coordinated with S8's reversibility-ladder edit (same files; gitter ships ONE commit covering both Stories' brief deltas to avoid lint-staged MM trap).
- `tests/unit/decisions.bats`: extended with old + new + mixed-field combos.
- ADR-008 §S9 (this addendum) — Status remains `accepted`.
- CHANGELOG v0.5.0 — single bullet alongside S7+S8 rows.

**What breaks**

- Nothing. All changes are additive + tolerant. Existing 4-field calls + old .md entries continue to work bit-identically.

**What we give up**

- Bounded field caps (D1 alternative). Cost: render-time chunking for the common case. Not worth it.
- Always-render-headers (D3 alternative). Cost: signal density. Not worth it.

**Cross-Story coordination**

- Brief edits in T4 (`t-9ea2302c`) touch the SAME files as S8/T6 (`t-aa471a63`). Workers should coordinate via gitter — ONE commit per brief file, not two. Avoids the lint-staged-MM trap (per global CLAUDE.md).
- §S8 addendum is now co-located in this ADR (was originally in `docs/adr/009-auto-rotation.md §S8`; relocated 2026-04-25 to consolidate decisions-verb evolution under ADR-008). D-numbering preserved (D11–D14). Pre-relocation cross-refs (e.g. `S8/D14`) resolve as-is.

### Open questions

- Should `--decided-by` accept multiple names (comma-list or repeated flag) for joint calls? Defer — single name is the common case; revisit if a real joint-call surfaces.
- Should `--option` support a `--default-option <N>` flag pointing at the chosen option (avoids re-stating the default verbatim)? Defer — small UX win, not worth a flag.
- Should `--context` support a file/PR link as first-class field (`--context-link <url>` separate from `--context <text>`)? Defer — Markdown URLs in context render fine in Discord.

---

## S10 Addendum: Drop per-field caps + section-aware multi-message split (added 2026-04-25)

**Driver-ref**: `driver-inbox.md` @ 22:34 MYT 2026-04-25
**Companion to**: ADR-009 §S10 (whip-side `Since-last-tick` enrichment + `story.advancedAt` schema field — co-located with the auto-rotation/whip ADR family per the §S8/§S9 pattern).

### Context

S9 relaxed field caps from 60 → 200/500/80 + added 4 optional fields (context/options/impact/decided-by). It was a half-step. Real driver use during the next batch of decompositions surfaced that 200-char questions and 500-char context blocks still get clipped — often the very content that makes a high-reversibility call standalone-actionable on phone.

S9 also baked single-decision overflow into a **drop-fields-with-marker** pattern (D5: note → impact → options → context, then `↳ atmux decisions show <id> for full`). That works for the rare case where one decision happens to overflow 2000 chars, but it's the wrong default once long-context decisions become the common case — the driver loses exactly the fields they need to override without re-attaching.

S10 ships now because S9's caps just landed (commits `117c47e`, `f322141`) and authors haven't yet started filling the new fields under those caps. Migration is cheap today (zero decision entries written under the 200/500/80 regime are at the cap); a week from now, planner+lead would be rewriting prose to fit caps that the renderer has since learned to handle gracefully.

### Decisions

#### D6 — Drop per-field byte caps; constraint moves to compose layer

Remove the explicit length validators in `_atmux_decisions_add`:

- `question`, `default`: 200 → unbounded
- `note`, `context`, `impact`: 500 → unbounded
- `decided-by`: 80 → unbounded
- `option` (per occurrence): 200 → unbounded
- `--option` max **5 occurrences** is preserved — that's a *structural* constraint on the options-list shape (decisions with >5 options are usually really 2+ decisions), not a byte cap.
- `_decisions_oneline` (newline flattening) is preserved — chunking is line-aware downstream.

The Discord 2000-char hard limit doesn't go away. It's now enforced by the renderer (D7), not the data layer. ERROR-on-overflow at the data layer was a category error: the data is fine, the *transport* has a limit; push the constraint where the limit lives.

**Why**: Real decisions need real context. Bounded byte caps push the friction onto the wrong side of the system — the planner/lead writes the call, then has to truncate it themselves to fit a per-field budget that doesn't even map to Discord's actual constraint (a per-message body cap, not per-field). Render-time chunking (D7) converts the constraint into "transport-aware presentation," which is where it belongs.

**Why not**: Keep the 200/500/80 caps as soft warnings (warn but allow). Adds knob bloat with no behavioural value — if the renderer can chunk gracefully, the warning is just noise.

#### D7 — Section-aware multi-message split with [N/M] header

When `_decisions_render_discord` composes a body that exceeds 1900 chars (the existing 2000-char Discord cap minus 100 chars of headroom for the `[N/M]` prefix + safety margin), the renderer chunks **section-by-section** into ≤5 Discord messages:

- **Chunk 1** ALWAYS contains the **required fields**: question, default, decided-by (if set), reversibility, `📍 atmux decisions show <id>` pointer, `↪ override` pointer. These are the signoff-relevant fields that survive every truncation strategy — the driver can override without seeing chunks 2-5.
- **Chunks 2-5** carry the **optional sections** in this priority order: `context` → `options` → `impact` → `note`. Each section is *atomic* — an options list never splits across chunks (renders weirdly: orphan bullets out of context).
- **Header per chunk**: `📋 **[atmux-decisions]** [N/M] · \`{team}\` · HH:MM MYT` (mirrors the digest verb's `[N/M]` pattern from §S8 D14). Single-message case (≤1900 chars) keeps today's header — no `[N/M]` clutter for the common path.
- **1s sleep** between chunks (matches digest verb — Discord webhook rate limit is 30/min; 1s is a safe margin).
- **Reversibility gate unchanged** — still only fires for `high`. Low/med skip the per-add ping regardless of body length.

Implementation: factor a section-aware chunker `_decisions_render_chunks_for_discord` (sibling of `_decisions_chunk_for_discord` from §S8 D14). Same `[N/M]` header semantics, different atomicity rule (sections vs bullets). The two helpers can coexist in `lib/decisions.sh` until E4's `flag` verb lands a third consumer; if at that point all three want chunking, hoist the shared header/sleep/cursor logic to `lib/discord.sh::atmux::discord_chunk_post` (deferred per §S8 cross-Story note).

**Why**: Section atomicity preserves human-readability — each chunk is a complete unit of the decision, not a jagged textual cut. `[N/M]` makes ordering recoverable when Discord delivers out-of-order. 5-msg ceiling is calibrated against worst-case all-fields-max body (~10k chars) with margin; if a real decision's body needs 6+ chunks, the decision should split into multiple decisions anyway.

**Why not**: Mid-section split (cut at any byte boundary). Cheap to implement, miserable to read — orphaned half-bullets, sentence fragments, lost emoji prefixes.

#### D8 — Beyond 5-chunk ceiling: fall back to S9 truncation marker (last resort, not first)

If the body still overflows after 5-chunk planning (extreme edge case — a single decision where every optional field is at typical-max + multiple options at max), fall back to the §S9 D5 pattern:

- Drop optional sections in this order: `note` → `impact` → `options` → `context`.
- Append `↳ atmux decisions show <id> for full` to the last surviving chunk.
- Required fields (question, default, reversibility, decided-by, show, override) are NEVER dropped.

§S9 D5 is **superseded as the default** for over-2000-char single decisions. It's now the **last-resort** fallback for over-5-chunk single decisions. The user-visible behavior change: 99% of long decisions now ship as 2-4 chunks instead of being silently truncated; only the 0.01% pathological case still triggers the truncation marker.

**Why**: Two-tier overflow — chunking handles the common case, truncation handles the pathological case. Each layer's failure mode is graceful and the marker gives the driver an escape hatch.

**Why not**: Unbounded chunk count. Discord rate-limits at 30 messages/min/webhook; even 5 chunks/decision × 6 decisions/min would saturate the channel. 5 is conservative.

### Consequences

**What changes**

- `lib/decisions.sh` `_atmux_decisions_add`: cap validators removed (T1 — `t-fe5daf1b`). Structural `--option` max-5 preserved.
- `lib/decisions.sh` `_decisions_render_discord`: rewritten to compose full body, then route to single-msg path or chunker based on length (T2 — `t-9a946e44`).
- `lib/decisions.sh` gains `_decisions_render_chunks_for_discord` helper (sibling of `_decisions_chunk_for_discord`).
- `tests/unit/decisions.bats` extended (T6 — `t-82311800`): drop-caps + multi-message split + ceiling fallback.
- `templates/briefs/lead.md` + `templates/briefs/planner.md` Discord-output-depth callout (T8 — `t-4f5f0d22`). Coordinates with S8/T6 + S9/T4 — gitter ships ONE commit per brief file across S8+S9+S10 deltas to avoid the lint-staged-MM trap.
- ADR-008 §S10 (this addendum) — Status remains `accepted`.
- ADR-009 §S10 (companion) — whip enrichment side.
- CHANGELOG v0.5.0 — single bullet alongside S7+S8+S9 rows (T10 — `t-7db2c3bf`).

**What breaks**

- Nothing in the success path. All changes are additive + tolerant.
- Behavioural break for any external grep against the old "ERROR: question exceeds 200 chars" message — that error path is gone. Mitigation: error-text contracts on internal validators are not API surface; no migration.

**What we give up**

- Per-field byte caps (D6 alternative). Cost: render-time chunking complexity (~50 LOC). Worth it — converts a UX papercut (rewrite-to-fit) into a transport-aware presentation layer.
- Drop-fields-as-default (§S9 D5). Cost: chunking complexity. Worth it — drop-fields was hurting the driver's override window in exactly the case (long context) where override is most warranted.

### Resolutions to S10 open questions

Per ADR-007 OQ-resolution pattern, recorded via `atmux decisions add`:

- **OQ1 (`d-613a71c1`)** — Multi-message ceiling at 5 messages. Reversibility: medium. Beyond-5 falls back to D8.
- **OQ2 (`d-12231d51`)** — Section-by-section chunking (vs digest-style bullets). Reversibility: medium. Section atomicity matters for single-decision rendering.
- **OQ5 (`d-46e7daf3`)** — Split addenda: ADR-008 §S10 (decisions side), ADR-009 §S10 (whip side). Reversibility: low. Matches §S8/§S9 co-location pattern.

(OQ3/OQ4 belong to ADR-009 §S10 — whip side.)

### Open questions

- Should the section-aware chunker be invoked for `low`/`medium` reversibility entries too, even though they don't ping per-add (only via digest)? Today: chunker fires inside `_decisions_render_discord`, which is only called from the high-rev path + the digest path. Digest already chunks bullets (decisions-as-bullets). Verdict: out of scope — digest's bullet chunker is bounded by per-decision body, not per-field; if a single decision's bullet exceeds 1900 chars in a digest, that's a separate issue (revisit if surfaced).
- Should the `[N/M]` chunks share a thread-id / common identifier so Discord clients can group them visually? Defer — Discord webhooks don't support thread continuation natively. Revisit if a downstream consumer (Discord→Slack bridge, etc.) wants it.

---

## staleMin Resolution Chain (cross-ref: ADR-009 §S7 D9)

Several places in this ADR cite `$ATMUX_STALE_MIN=90` as if it were a fixed knob. The actual lookup is a four-level chain, highest-precedence first:

1. **per-Task `task.staleMin`** — optional integer field on the Task itself (`atmux task add --stale-min N`, persisted in `kanban.json`). Wins for this Task only. Consumed inline by the jq filter in `lib/whip.sh:194` (`((.staleMin // $default_min) * 60) as $task_s`).
2. **`$ATMUX_STALE_MIN` env override** — process-scoped, applies to every Task that didn't set its own. Consumed at `lib/whip.sh:58` (`local STALE_MIN="${ATMUX_STALE_MIN:-$TEAM_STALE_MIN}"`).
3. **team.json `whip.staleMin`** — durable team-wide default. Read at `lib/whip.sh:56` (`jq -r '.whip.staleMin // 90'`).
4. **default 90 minutes** — applies when team.json omits the field entirely. Hard-coded both in the jq fallback at `lib/whip.sh:56-57` and in the fresh-init template at `lib/init.sh:332` (`whip: {intervalMins: 5, staleMin: 90, leadMaxMin: 60}`).

Verify via `grep -rn staleMin lib/` — the matches in `lib/whip.sh` (lines 50–58, 194), `lib/kanban.sh` (lines 123, 134, 147), and `lib/init.sh:332` cover the entire chain.

When this ADR (or downstream prose) says "$ATMUX_STALE_MIN=90", read it as "the effective staleMin, which today resolves to 90 by default but is overridable at three levels above".
