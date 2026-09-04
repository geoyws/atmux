# ADR-237: No LLM cadence into Discord — remove hourly whips, medic on-demand only

**Status**: Proposed (operator-fired 2026-05-24 in conversation immediately after [ADR-236](236-three-tier-orchd-supervision.SUPERSEDED.md); ship under driver in a focused commit set since the surface spans member-skill + cockpit + Discord-template layers).

**Date**: 2026-05-24

**Driver-ref**: 2026-05-24 conversation with operator after manual orchd respawn + supervision-tree discussion. Operator's standing position in that session, verbatim:
- *"no hourly whips or crons anymore. remove them all"*
- *"no more /loop /superdoctor startup message for _medic... remov that pleaase"*
- *"what generates the discord messages right now? we want discord messages to boringly come from the kanban itself and not from any LLM anymore because that burns tokens"*
- *"medic LLM -> discord is fine"* (clarification fired after the initial directive — narrows the rule from "no LLM in Discord" to "no LLM-cadence in Discord". LLM-composed output reaching Discord as a side effect of an explicit operator-fired invocation is allowed; the prohibited shape is automatic time-driven LLM cycles whose output happens to land in Discord.)

The token-burn framing is the load-bearing motivation. Every member running `/whip` every 270s = N members × ~24×60×60/270 = N × 320 Claude turns per day per team, plus medic's hourly turn = 24/day per host. For a 5-team setup with 5-10 members each, that's ~10,000+ Claude turns/day spent on orientation + Discord-summary composition, much of which produces "nothing new to report" output. By contrast, an operator-invoked `atmux medic diagnose <team>` produces at most one Claude turn per invocation, with Discord output as a deliberate side effect the operator accepts when firing the verb.

**Cross-refs**:
- [ADR-202](202-honker-in-db-messaging-substrate.md) — Honker substrate; the event-driven primitives that replace whip's poll-and-summarize model.
- [ADR-233](233-cron-auto-install-disabled-trust-orchd.md) — cron retirement. The crons that fired `discorder progress` / `discorder heartbeat` are already not auto-installed; this ADR formalizes that those subverbs are now operator-on-demand or substrate-event-triggered, never cron-fired.
- [ADR-236](236-three-tier-orchd-supervision.SUPERSEDED.md) — the supervision tier this ADR is a sibling to. D3 of ADR-236 depends on D1 of this ADR (Discord template is Rust-composed, deterministic, no LLM).
- [ADR-077](077-superdoctor-cockpit-role.md) — medic's original spec. D2 of this ADR narrows medic's role to operator-on-demand invocation.
- [ADR-133](133-medic-rename.md) — superdoctor → medic rename; storage-layer identifiers preserved.
- ADR-068 (bash to ts cutover — no surviving ADR file) — `atmux discorder` subverb cutover (the deterministic kanban→Discord aggregator that stays).
- [ADR-008](008-decisions-verb.md) — decisions block in whip; its consumer side (`whip-decisions-check.ts`) is in scope for this ADR's deprecation pass.
- `docs/medic.md` — operator-facing reference; picks up "on-demand only" callout in the same commit as D2 lands.

## Context

Discord-message generation in atmux today falls into three buckets, two of which are dead-code-orphans post the **in-flight cron-source removal** (working-tree at the time this ADR is filed shows 14 deleted files including `src/core/cron.ts`, `src/abstractions/crontab.ts`, `src/verbs/cron-install.ts`, `src/verbs/cron-orphans.ts`, `src/verbs/cron-remove.ts`, and their tests — ratifying ADR-233's *"trust orchd to run"* by removing the cron source surface entirely, not just disabling auto-install).

**Bucket A1 — substrate-event-driven, deterministic, no LLM, STILL ACTIVE:**
- `src/core/refusal-trigger.ts` — Discord ping when a member's pane shows a refusal pattern (deterministic regex match). Triggered by pane-watcher, not cron.
- `src/core/account-swap.ts` — Discord ping on member-account-swap success / fail. Triggered by the swap operation itself.
- `src/core/cursor-self-heal.ts` — Cursor-side self-heal events. Triggered when self-heal fires.
- `src/verbs/epic-merge.ts` — Discord on epic merge events. Triggered by the merge verb when invoked (operator or orchd-dispatched).
- `src/verbs/cockpit-rotate.ts` — Discord on cockpit rotation events. Triggered by the rotate verb.

**Bucket A2 — was cron-fired, now DEAD CODE post in-flight cron removal:**
- `src/verbs/discorder.ts` (`progress`, `heartbeat` subverbs) — was cron-fired every 30 min / 60 min. The cron-install side that scheduled these is being deleted in the working-tree refactor. Verbs still dispatchable from CLI but no auto-caller exists.
- `src/verbs/watchdog.ts` — was cron-fired. Same status: dispatchable, no auto-caller.
- `src/verbs/poke.ts` (renamed from `whip` per ADR-160) + `src/verbs/poke-resume-check.ts` — was cron-fired per-member every 270s + every minute respectively.
- `src/verbs/pulse.ts` (cockpit-wide pulse verb) — was cron-fired hourly.
- `src/verbs/report.ts` — was cron-fired.
- `src/verbs/improve.ts` — was cron-fired.

**Bucket B — LLM-cadence (the directly-prohibited shape):**
- **`/whip` (member skill)** — every team member runs `/whip` per `whip.cadence` (default 270s per `src/schema/team.ts` whip block). Skill spends a Claude turn assembling team state + posts to Discord with `[whip-progress]` / `[whip-heartbeat]` template headers (the same prefix discorder uses, because the original bash whip shared the template). Dominant token-burner.
- **`/loop /superdoctor` (medic auto-loop)** — auto-fired by `src/verbs/cockpit.ts::autoStartSuperdoctorLoop` (lines 2104-2200, callsite at lines 1683-1707) on every cockpit rebuild that created a fresh `_medic` window. Medic then runs hourly diagnosis turns and posts Discord summaries. **The auto-loop is the prohibited shape; on-demand medic invocation that posts LLM output to Discord is allowed** per the operator clarification *"medic LLM -> discord is fine"*.
- `src/core/whip-budget-check.ts` — fires inside whip cycle; pings Discord on budget thresholds. Lives in Bucket B because it's gated by whip running.

The operator directive cuts Bucket B's cadence layer entirely. Bucket A1 stays as deterministic substrate-driven Discord. Bucket A2 needs an architectural reframe rather than per-verb deletion — covered in [ADR-238](238-orchd-drives-discord.md), which proposes orchd as the single Discord emitter, subscribing to substrate event topics and rendering deterministic templates from event payload. After ADR-238 lands, most Bucket A2 verbs' Discord-emit logic moves into orchd consumers (with the verbs themselves either deleted or kept as operator-invokable one-shots without Discord side effects).

A second concern surfaces from the template-name collision: today Discord shows `[whip-progress]` for **both** the deterministic discorder output and the LLM-composed whip-skill output. With Bucket B's cadence gone (D1 below) and Bucket A2's callers migrating into orchd consumers (per ADR-238), the template namespace gets a coherent reset — D4 below addresses the rename.

Crontab inspection (2026-05-24, on hax): the atmux-specific cron entries (`atmux orchd --drain`, `atmux lane-tick`, `atmux-cockpit-watchdog`, `cron-resubmit-stuck-queue`, `auto-resurrect-save`) are already commented out per ADR-233's boot-storm cleanup. Live crontab entries are host-level (`hax-alerts`, `db-backup`, `bun-test-reaper`, `tmux-ghost-reaper`, `mosh-orphan-sweep`, `backup-verify`), none atmux-owned. This ADR — combined with the in-flight source-side cron removal — formalizes that no atmux cron lines exist on the install side OR the source side. The cron-install verb itself is being deleted from source, not just disabled (ADR-233 §D5's *"stays callable for explicit operator opt-in"* posture is superseded; the verb is deleted entirely per the in-flight working-tree refactor).

## Decision

### D1 — Discord pipeline is no-LLM. All Bucket-B paths removed.

The Discord-sending surface (`abstractions/discord.send`) stays as-is. The change is in the callers:

1. **Member `/whip` skill cadence is removed.** The skill source at `~/.claude/skills/whip/` (operator dotfiles) is deprecated. `src/schema/team.ts` `whip.cadence` field is dropped from schema validation (back-compat shim warns + ignores for one release). `src/verbs/start.ts` no longer paste-bootstraps `/loop /whip` into member panes on team start (probe the codebase for `loop.*whip` references and strip).
2. **All `whip-*` consumer modules (Bucket B-only callers) are deprecated:**
   - `src/core/whip-budget-check.ts` — Discord-ping path is removed; the budget-pause logic (substrate side, not LLM-side) moves to `src/core/budget-pause.ts` which already exists as the substrate primitive.
   - `src/core/whip-decisions-check.ts` — decisions-block consumer was whip-only. Decisions-block surface stays (operator-readable in `decisions.md`); the auto-check-and-ping logic is removed. If an event-driven equivalent is needed, it lands as a Honker subscriber per ADR-202, not as a polling skill.
   - `src/core/whip-config-drift.ts` — drift detector ran in whip cycle. Move to a one-shot `atmux doctor --config-drift` invocation; remove auto-fire path.
   - `src/core/whip-escalation.ts`, `src/core/whip-strikes.ts`, `src/core/whip-finding-state.ts`, `src/core/stale-anchor.ts` — auxiliary whip-cycle state; deprecate alongside whip itself.
   - `src/core/cursor-self-heal.ts` keeps its Discord path (substrate-event-triggered, deterministic — Bucket A); only the whip-gated invocation is removed.
3. **`src/verbs/whip.ts` and `src/verbs/whip-resume-check.ts`** — deprecated. Verb stays callable for one release with a "removed in next release, see ADR-237" deprecation log line, then deleted. Tests under `tests/unit/verbs/whip*.test.ts` flip to assert the deprecation log path; new tests for the budget-pause primitive (now standalone, not whip-gated) cover the substrate behavior that whip used to host.

**What stays in Bucket A (no change):**
- `atmux discorder progress` / `heartbeat` — operator can fire on-demand; no auto cadence (per D2's cron-removal policy). The aggregator code is healthy + already TS-pure (ADR-068). Future event-driven trigger (e.g. Honker subscriber on `task.done` that calls discorder) is allowed and aligned with ADR-202.
- All other Bucket A modules listed in §Context.

### D2 — Medic auto-loop removed. Medic is on-demand only.

Delete the `/loop /superdoctor` auto-start path in `src/verbs/cockpit.ts`:

- `autoStartSuperdoctorLoop` function (lines 2104-2200) — delete. All polling, send-keys, verification, and bail-marker logic goes with it.
- `SUPERDOCTOR_POLL_INTERVAL_MS`, `SUPERDOCTOR_POST_SEND_VERIFY_MS`, `SUPERDOCTOR_READY_MARKERS`, `SUPERDOCTOR_NOT_READY_MARKERS`, `SUPERDOCTOR_LOOP_LANDED_MARKERS` — delete (no callers remain).
- Callsite at lines 1683-1707 (the `if (mdJustCreated && medic.autoStart !== false && md !== undefined)` block) — delete. `mdJustCreated` tracking can also be removed if no other caller uses it.
- Schema field `medic.autoStart` (and `medic.autoStartTimeoutSec`) in `src/schema/cockpit.ts` — drop from validation, back-compat shim warns + ignores for one release.
- The `paneIsReady` helper if unused elsewhere — delete.
- t-22453c1e references in comments — leave as historical breadcrumbs (the Task ID stays cite-able from `decisions.md`); the *behavior* is the load-bearing change, not the comments.

Medic stays available as a cockpit pane (`_medic` window at cockpit window 2 per ADR-077) provisioned by `atmux cockpit rebuild`. The pane comes up with the `/medic` skill loaded (existing skill-paste path stays — that's a one-shot at pane creation, not a loop) and waits at idle. Operator fires medic by:

- Attaching cockpit window 2 and typing `/medic <subcommand>` (interactive).
- Running `atmux medic diagnose <team>` from any shell (D3 below) — atmux paste-injects the diagnose invocation into the medic pane.

No hourly cadence. **Medic posting LLM-composed output to Discord during an on-demand invocation IS allowed** per the operator clarification *"medic LLM -> discord is fine"* — the prohibited shape is auto-cadence LLM→Discord, not all LLM→Discord. Each operator-fired `atmux medic diagnose <team>` produces at most one Claude turn whose output may include a Discord-posted summary; the cost is bounded to the invocation and the operator deliberately chose to pay it.

`docs/medic.md` updates in the same commit as D2 implementation:
- §"When you want it" — strike "Running ≥2 atmux teams concurrently" justification (no longer auto-loop-driven); add "When the operator spots a dead `__orchd__` pane on cockpit-attach (per ADR-240's drop of superorchd auto-restart), run `atmux medic diagnose <team>` for AI-reasoned post-mortem over `.atmux/logs/orchd.log` + `state.db`." Note: the `[orchd-supervision-failure]` Discord ping and `superdoctor_attempts` supervisor-write paths from the original ADR-236 §D3 were dropped by ADR-240; no automatic ping fires on orchd death.
- §"When you don't want it" — drop the cost-conscious mention ("medic is one extra Opus + xhigh session running a whip cycle every hour") since the always-on cost is gone.
- §"Enabling it" — the `medic` cockpit.json block stays the same shape, but `autoStart` is no longer honored (schema-dropped); add a one-line callout.

### D3 — `atmux medic diagnose <team>` verb

New verb at `src/verbs/medic.ts`, subverb `diagnose <team>`. Operator-invocable from any shell; under the hood it:

1. Validates `<team>` against `~/.atmux/cockpit.json` (must be a registered team).
2. Locates the cockpit's `_medic` window via the existing tmux-resolution path (mirror of `cockpit-rotate.ts:336`'s lookup logic).
3. Composes a brief paste — substrate-only, no LLM in the verb's path itself:
   - `kind: "diagnose-request"`, `team: <name>`, `triggered_by: "operator"`, `triggered_at: <iso8601>`.
   - The last `superdoctor_attempts` row for `<team>` (if any; ADR-236 §D3 escalation payload).
   - Last 200 lines of `<team_root>/.atmux/logs/orchd.log`.
   - `state.db` summary — PRAGMA integrity_check result, recent event row counts per topic.
4. Sends the paste into the medic pane via `safeSendKeysWithVerify` (ADR-138).
5. Logs the invocation to `~/.atmux/state/medic-invocations.log` for operator audit.

Medic (the Claude) then reasons about the paste content and either:
- Writes a structural-fix proposal to `pending-decisions.md` (existing surface per ADR-077).
- Acks the `superdoctor_attempts` row by setting `operator_acked_at_sec` (the schema field added in ADR-236 §D3).
- Asks the operator clarifying questions via cockpit-pane output.

The verb is the only way medic gets fired for diagnosis after D2. There is no other auto-trigger.

### D4 — Discord template header rename for the deterministic discorder

Today `[whip-progress]` and `[whip-heartbeat]` are emitted by both:
- The bash-port discorder TS verb (Bucket A, deterministic).
- The whip skill (Bucket B, LLM-composed — going away in D1).

After D1 lands, only the deterministic discorder side remains. The `[whip-*]` prefix is misleading (no whip exists anymore). Rename:

- `[whip-progress]` → `[progress]` in `src/core/discorder.ts` template emit + the section labels in `aggregateProgress`.
- `[whip-heartbeat]` → `[heartbeat]` in `aggregateHeartbeat`.

Discord-archive search compatibility: downstream consumers (any operator-private dashboard, Discord-export grep scripts) that grep for `[whip-progress]` need to migrate. Migration window: one release with both prefixes emitted (use a `DISCORD_TEMPLATE_DUAL_EMIT` env flag — default off so the rename is the default; flag-on emits both for the operator who needs the parallel-prefix window). Drop the dual-emit shim in the release after.

This is a no-LLM-side change — pure constants update. Cost is zero, risk is dashboard-grep-breakage scoped to the operator's own tooling.

### D5 — Schema-side deprecation + back-compat shims

For each schema field touched by D1-D4, the deprecation pattern is uniform per atmux convention (`feedback_schema_deprecation_one_release_window` if memorialized; otherwise this ADR sets the precedent):

- Field stays parseable for one release.
- Loader warns to stderr on encounter: `atmux: <field> at <path> is deprecated per ADR-237 — runtime ignored, remove from your config to silence`.
- Runtime never reads the field — behavior is identical to "field absent".
- Next release deletes the field from schema; loader rejects on encounter.

Fields covered:
- `team.json::whip.cadence` (D1).
- `cockpit.json::medic.autoStart` (D2).
- `cockpit.json::medic.autoStartTimeoutSec` (D2).
- Any `whip.*` field that's whip-only and not used by Bucket A substrate code (audit during implementation).

### D6 — Cron-install verb stays callable but emits zero whip-related lines

ADR-233 already retired cron auto-install in `atmux start`. The `atmux cron-install` verb stays callable for explicit operator opt-in (ADR-233 §D5). After this ADR:

- `src/core/cron.ts::renderTeamBlock` removes any remaining whip-related cron line emissions (`/loop /whip` paste cron, `whip-resume-check` cron, `whip-budget-check` cron if any exist).
- The cron template's surviving lines (lane-tick, etc.) are themselves up for review in a future ADR — this ADR's scope is whip + medic, not the full cron template.

Crontab grep validation after this ADR lands: `crontab -l 2>/dev/null | grep -E '(whip|superdoctor|medic)'` MUST return zero hits on any host where `atmux start` has run.

## Consequences

- **Token spend drops dramatically.** Per-host baseline: zero Claude turns/day spent on whip cycles or medic hourly diagnosis. A 5-team × 7-members-each setup goes from ~11,000+ daily orientation turns to ~0; medic goes from 24/day to 0/day baseline + N/day on operator invocation.
- **Discord noise drops.** Per-team `[whip-progress]` LLM-summaries (every 270s, every member) go away. Only the deterministic discorder hourly heartbeat + 30-min progress remain — and even those are now operator-on-demand or substrate-event-triggered (no auto cron).
- **Medic becomes a tool, not a service.** `docs/medic.md` updates reflect "on-demand only" framing. `atmux medic diagnose <team>` is the operator-fired entry point. Pane stays warm at idle (skill loaded) for fast invocation.
- **Substrate-event-triggered Discord becomes more important.** With whip's auto-cadence-summary gone, anomaly visibility depends on the deterministic-event paths (refusal-trigger, account-swap, watchdog). Those paths need to be reliable + cover the operator-visible failure modes that whip used to surface incidentally. (Note: the superorchd-escalation path from ADR-236 §D3 was dropped by ADR-240 — orchd death is operator-visible via the dead `__orchd__` pane on cockpit-attach, not via Discord auto-ping.)
- **No Claude-composed CADENCE Discord messages exist after this ADR.** Whip-driven and medic-auto-loop-driven posts go away. On-demand medic posts (operator-fired) may still include LLM-composed Discord output — that is allowed per operator clarification. The architectural shift is "no time-driven LLM→Discord", not "no LLM→Discord at all".
- **Tests update.** Whip-related test files (`tests/unit/core/whip-*.test.ts`, `tests/unit/verbs/whip*.test.ts`, `tests/e2e/whip-*.test.ts`) flip to assert deprecation log paths for one release, then are deleted. New tests for `atmux medic diagnose <team>` cover the diagnose-paste flow. Template-header dual-emit (D4) gets a one-release-window test that asserts both `[whip-progress]` and `[progress]` are emitted under the `DISCORD_TEMPLATE_DUAL_EMIT=1` env path.
- **Doc updates.** `docs/medic.md` (D2). `docs/PRD.md` and `docs/ARCHITECTURE.md` whip sections strike the auto-cadence text. `CHANGELOG.md` calls out the user-visible removal. Same-commit-as-code per atmux convention.
- **Member orientation gap.** Whip historically did orient-and-restate-state work for members at the top of each cadence cycle. Without it, members rely on per-claim brief content (briefs/templates) + decisions.md + driver-inbox for orientation. This is the operator's standing position (*"a pull model for each claude is heavy and wasteful in terms of tokens"* — even self-orientation pulls are wasteful). If the gap proves load-bearing for member coordination, the response is to enrich brief content + decisions surfacing, not to reintroduce a cadence loop.

## Open questions

1. **`/whip` skill source deletion timing.** The skill lives in operator dotfiles (`~/.claude/skills/whip/`), not in the atmux repo. After atmux-side deprecation (D1), the operator runs `dotfiles push` to delete the skill. Question: should the skill emit a "this skill is deprecated, see ADR-237" message for one release, or hard-delete? Recommend hard-delete: the atmux verbs that the skill calls will already log deprecation warnings, so the skill failing to find them is itself a clear signal.
2. **Member orientation replacement.** D6 §Consequences acknowledges the gap. Concrete proposal: brief templates pick up a `## Recent decisions` section that surfaces the last 5 `decisions.md` entries. No new cadence. Out of scope for this ADR — file a follow-up if the gap is felt in practice.
3. **`[heartbeat]` vs `[discorder-heartbeat]` template naming.** D4 picks `[heartbeat]` for brevity. Counterargument: a future non-discorder source could want to emit a `[heartbeat]` template too, leading to a future collision. Recommend `[heartbeat]` for now and revisit if a collision shows up.
4. **`atmux medic diagnose` payload size cap.** D3 §3 includes "last 200 lines of orchd.log". Some logs have very long lines (full event JSON inline). Cap by bytes (e.g. 64 KB) not lines, to keep the paste-size predictable. Implementation detail; spec it during D3 implementation.
5. **Substrate-event Discord coverage audit.** D1's gap-fill assumption is that Bucket A paths (refusal-trigger, account-swap, watchdog, etc.) cover the operator-visible failure modes whip incidentally surfaced. That assumption deserves an audit: list the failure modes whip detected over the last 30 days (medic's `complaints` / `superdoctor_attempts` tables are the data), bucket which are now covered by substrate-events and which are not, file follow-up ADRs for the latter. Out of scope for this ADR — the directive is clear and the audit is a follow-up workstream.

## Reversal

If removing whip + the medic auto-loop proves load-bearing-wrong:

- **Reverting D1** (whip removal): the schema field can be re-introduced; the deprecated modules can be undeleted (preserve via git history if not yet purged). Cost: token spend returns. The whip-skill source in operator dotfiles needs to be restored from a backup or re-authored.
- **Reverting D2** (medic auto-loop removal): the `autoStartSuperdoctorLoop` function + callsite can be restored from git. Cost: hourly medic Opus invocation returns; operator decides whether to flip `medic.autoStart: false` for cost reasons.
- **Reverting D3** (medic diagnose verb): the verb can stay even if D1/D2 are reverted; on-demand diagnosis composes well with auto-loop diagnosis (operator can invoke between hourly cycles). Removal is a verb-delete + tests-delete pass.
- **Reverting D4** (template rename): pure constants change; revert by flipping the constants back. The dual-emit env flag (`DISCORD_TEMPLATE_DUAL_EMIT`) is the operator-controlled mid-migration switch.

Full revert is restoring the whip-skill source + restoring `autoStartSuperdoctorLoop` + restoring schema fields. Token-spend impact returns proportional to whip cadence × member count.
