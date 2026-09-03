# ADR-151: `unblocker` — in-team kanban-blocked drainer, martinet-routed, Opus-authoritative

**Status**: accepted
**Date**: 2026-05-16
**Author**: atmux team (driver-claude-sopx /bruh sweep 2026-05-16 00:14 MYT; operator-authorized 00:08–00:15 MYT; name confirmed `unblocker` 00:15 MYT)
**Relates**: [ADR-152](./152-blockers-list-unified-verb.md) (`atmux blockers list` — the inventory verb unblocker queries), [ADR-153](./153-auto-promotion-rules.md) (auto-promotion freshness signal — gives unblocker a queryable threshold-crossed surface), [ADR-154](./154-driver-inbox-lead-outbox-sqlite-migration.md) (SQLite storage layer — the coordination_messages table unblocker reads), [ADR-155](./155-pane-state-structured-verb.md) (`atmux pane-state` — the reanimation-decision primitive), [ADR-150] (cross-team coordination helpers — sentinel-routing + complaint filing path), [ADR-147](./147-ombudsman-and-release-notes.md) (ombudsman complaints substrate — boundary partner), [ADR-077](./077-superdoctor-cockpit-role.md) (medic substrate — provides the in-team pane infra unblocker spawns into), [ADR-133](./133-medic-rename.md) (medic naming — sibling cockpit-W2 pattern unblocker inverts into the team), [ADR-132](./132-pluggable-martinet.SUPERSEDED.md) (martinet — primary sentinel-router into unblocker), [ADR-148](./148-commit-cadence-truth-signal.md) (cadence-as-truth; pane-state is proxy — unblocker honors both signals), [ADR-140](./140-cheap-model-first.md) (cheap-model-first — unblocker is the documented carve-out for judgment work), [ADR-090] (epic-team carve-outs — unblocker is per-team singleton; epic-teams reuse parent's), [ADR-135](./135-cockpit-naming-convention.md) (window naming — unblocker pane name follows convention), [ADR-005] (kanban-source-of-truth — unblocker mutates kanban under controlled rules), [ADR-010] (`atmux flag` — surfaces unblocker resolves), [ADR-085](./085-whip-approvals-watcher.md) (`Status: proposed (deferred: …)` annotation convention — unblocker does not auto-action proposed-deferred ADRs).
**Kanban**: closes EPIC `t-fba73bf8`; T1-of-N decomposition (this commit drafts only). Integrates the four sibling /bruh-sweep drafts (ADR-152 / ADR-153 / ADR-154 / ADR-155) into a coherent in-team role contract.

## Context

### The four siblings produce signals; nobody drains them

The /bruh sweep on 2026-05-16 produced four sibling ADRs that each solved one part of the coordination-state problem:

- **ADR-152** unified the seven blocker surfaces behind `atmux blockers list` — operators and lead can now see "what is blocked" in one query.
- **ADR-153** added deterministic auto-promotion rules (R1 / R2 / R3) — stale blockers cross visibility thresholds and surface into higher-attention places.
- **ADR-154** flipped the coordination_messages table from markdown to SQLite — queries are now indexable, agings are now first-class.
- **ADR-155** structured the pane-state read — observers can ask `is this pane dead? working? has-residue?` and get a closed-enum answer.

Together they make blockers visible, queryable, age-aware, and structurally inspectable. **None of them act.** A 24h stale blocker now produces a complaint (ADR-153 R1), a dead pane (ADR-155 `runtime_state=dead`) is queryable, but no role in the team is responsible for *picking either up and resolving it*.

The lead is the wrong owner: lead is thin per CLAUDE.md, never codes/claims/plans, and any drain loop wedged into the lead's whip cycle competes for the lead's cognitive budget with dispatch + status + rotation. The members are the wrong owner: members claim from `lane=<their-lane> status=todo`, and a Task at `status=blocked` is *intentionally invisible* to the pull-model (per ADR-007). The planner is the wrong owner: planner decomposes Tasks; it does not unblock them.

What's missing is a **role whose entire job is to drain `status=blocked`** — read the auto-promotion signals, classify the blocker, take the kanban-side or pane-side action that frees the row to move back to `todo`, then return to the loop.

### Why now

ADR-152 / ADR-153 / ADR-154 / ADR-155 land **proposed in the same sweep**. Each is a single-commit ADR draft today; execution slices follow. Without a designated consumer for their structured outputs, each ADR risks being a half-built primitive — visible surface, no caller. The unblocker role's draft closes the loop: each sibling ADR's §Consumers section now has a named in-team role that will integrate with its surface during T2+ impl slices.

Beyond the structural fit, the in-team Blocked column has been accumulating in atmux's own team for weeks. The dogfood path (§D8) back-drains it as soon as the role lands.

### Why in-team, not cockpit

The operator's framing on 2026-05-16 00:09 MYT was direct: *"busy + triage + has to live within teams."* The reasoning, expanded:

- **Blocker context is team-local.** A blocker in atmux/`whip-impl` lane is *about* atmux's worktrees, atmux's kanban schema, atmux's sibling members. A cockpit-W4 role would pay the round-trip cost of cross-team context shuttling for every action.
- **Reanimation authority needs cage-local access.** Driving `/team rotate-member <m>` or raw `tmux send-keys` on a sibling pane is cheap when you're in the same tmux session; expensive when you're in `atmux_cockpit:_unblocker` reaching across to `atmux:🩹-unblocker:🛠-whip-impl`. Cockpit-layer reanimation is what martinet already does (ADR-132); duplicating it for unblocker buys nothing.
- **Cross-team routing is already martinet's job.** When unblocker can't resolve in-team (the root cause is in a sibling team's lane), the right escalation is *via complaint* to the right team's ombudsman (ADR-147) — same path operators already use. Martinet handles the cross-team sentinel-write (ADR-132 + ADR-150 helpers).

So unblocker lives in the team cage, sibling to lead / planner / reviewer / docs / gitter / qa. The cockpit layer keeps its existing residents (superdriver / medic / martinet); ADR-151 does not add to that floor.

### Why Opus, not the cheap-model tier

ADR-140 codified cheap-model-first: Claude is reserved for strategic / judgment / code-gen work; observation loops and mechanical nudges go to the cheap tier. Unblocker is the **documented carve-out** to that rule (planner-anchor #2; `[[feedback_opus_all_for_agile_flow]]` memory):

- Classification — "member-stuck vs tooling-broken vs cross-lane-WIP" — is judgment work, not pattern-match work. The cheap tier reliably distinguishes "spinner present" from "spinner absent"; it does not reliably distinguish "real progress slow" from "stuck on a bug it can't see."
- Authority — moving a kanban row from `blocked → todo`, filing a complaint with the right `blocker_class` and `target-team`, deciding whether to reanimate or wait — is a write-side action whose cost-of-error is high. Cheap-tier write-side actions cluster in the "filing-clerk wrong-bin" failure mode that the operator flagged on 2026-05-13 (Reddit-receipts stake on overnight 0-commit excuses — wrong action is worse than no action).

Martinet (cheap-tier) **observes**; unblocker (Opus) **acts**. The two compose: martinet writes the sentinel, unblocker reads it and decides. Cost-shape stays cheap because martinet handles the high-frequency observation loop; unblocker fires only on sentinel-write or whip-backstop trigger.

## Decision

### (D1) `unblocker` becomes a required in-team role

`team.json::requiredRoles` is extended (additively) to include `"unblocker"`. New teams created post-ADR-151 default-include it. Existing teams without it on first-start log a warn-class deprecation message (`team has no unblocker — required role per ADR-151; falling back to lead-drains-Blocked manual mode`) for one release; the cut-over release (per historical decision number 076 (no surviving ADR file) / ADR-154 deprecation-window pattern, per planner-anchor #9) flips warn → hard-error and refuses `loadTeam` until the role is added.

`team.json::requiredRoles` is itself the load-bearing list-of-required-role-keys. Today's enforcement is roster-completeness at `loadTeam` time (refuse if a member named in `requiredRoles` is absent from the roster). ADR-151 does not change the enforcement shape; it just adds one entry. Per planner-anchor #1.

**Epic-team carve-out** — per ADR-090, epic-teams reuse the parent team's role pool rather than spawning their own. `loadTeam` refuses `requiredRoles` declared on epic-team configs and continues to honor the parent's unblocker via cross-team complaint path. Documented in §Tradeoffs.

### (D2) Brief template at `templates/briefs/unblocker.md`

New file, sibling to the existing brief set (`lead.md` / `planner.md` / `reviewer.md` / `ombudsman.md` / `gitter.md` / `merger.md` etc.). The brief anchors the role's mission, scope, drain-loop semantics, authority boundaries, and the explicit *don't-do* list (no code claims; no cross-team reanimation; no `blocked → done` direct moves; no proposed-deferred ADR auto-action per ADR-085).

Brief structure mirrors `ombudsman.md` (closest sibling pattern):

```
# Role: unblocker

## Mission
…drain kanban.status=blocked rows…

## Drain loop (event-driven primary + whip backstop)
…sentinel file path, query, classify, act…

## Authority matrix
…what unblocker MAY do / MUST NOT do…

## Boundary with ombudsman / lead / planner / members
…the four siblings whose surfaces overlap and how unblocker stays disjoint…

## Don't-do
…the explicit no-list…
```

The brief is the single source of role-vocabulary; the ADR's §Decision is the source of role-decisions. Per CLAUDE.md ADR-doc chain.

### (D3) Drain loop — hybrid (martinet sentinel primary + whip-cycle backstop)

Per planner-anchor #4 + EPIC §OQ1. Neither pure-event-driven nor pure-polling.

**Primary path — martinet sentinel-routed**:

1. Martinet (ADR-132, cockpit-W3) observes the team's panes + kanban state per its observe loop. On detecting a member-stuck / tooling-broken / dead-pane pattern, it writes `.atmux/state/unblocker-pending.json` with:
   ```json
   {
     "filedAt":   <epoch-seconds>,
     "taskId":    "t-xxxxxxxx" | null,
     "fromTeam":  "<team-name>",
     "reason":    "member-stuck" | "tooling-broken" | "dead-pane" | "stale-claim" | "cross-lane-WIP",
     "evidence":  "<one-line summary; e.g. pane-state runtime_state=dead pid=12345>"
   }
   ```
2. Unblocker (Opus, in-team cage) watches the sentinel via filesystem-watch (chokidar or equivalent) + a 60-second polling fallback (filesystem-watch is unreliable across some tmux+ssh setups).
3. On sentinel-fire, unblocker reads ADR-152 `atmux blockers list --class <reason> --source kanban,complaints --task <taskId>` for full context, classifies, acts.
4. Sentinel is consumed (renamed to `.atmux/state/unblocker-pending.<epoch>.json` and moved to `.atmux/state/unblocker-history/`). Idempotent re-fire by martinet writes a new sentinel; the history file is forensic-only.

**Backstop path — whip-cycle poll**:

1. The whip cycle (15min default cadence per existing config) runs `atmux blockers list --class member-stuck,stale-claim,tooling-broken --source kanban,complaints --order oldest` and picks the oldest entry unclaimed by sentinel-write within the last 30 minutes.
2. Backstop fires only when sentinel did not — covers the case where martinet missed the pattern (paused / rate-limited / mid-rotation) or the operator added a blocker manually without tripping martinet's heuristics.
3. Unblocker dedups via a `.atmux/state/unblocker-drains.json` row (`{ taskId, drainedAt, source: 'sentinel' | 'whip-backstop' }`) — same kind of `(taskId, firedAt)` dedup the lane-stall verb uses.

**Not self-polling without backstop** — pure self-polling would either spike CPU (frequent ticks) or miss latency-sensitive blockers (infrequent ticks). The hybrid keeps sentinel-fast on the common case + whip-slow on the rare case martinet missed. Per the operator's "event-driven primary" framing on 2026-05-16 00:13 MYT.

### (D4) Authority matrix

Per EPIC §OQ2 + §OQ3.

| Action | MAY | MUST NOT |
|--------|-----|----------|
| **Triage / diagnose** | Read pane-state (ADR-155 verb) on blocked-task owner's pane; classify; consult cadence (ADR-148); inspect ADR-152 blocker context | Modify pane-state's read shape; bypass the verb to scrape `tmux capture-pane` directly |
| **Reanimate dead panes** | Drive `/team rotate-member <m>` OR raw `tmux send-keys` (via ADR-138 verified send-keys) **within its own team** when `runtime_state=dead` per ADR-155 | Reanimate cross-team panes (martinet handles cross-team via ADR-132's sentinel-router) |
| **Mutate kanban** | Move `blocked → todo` with audit note `"unblocked by unblocker @ <ts>: <reason>"`; reassign owner if the original owner's pane is dead and a sibling claims | Move `blocked → done` (the original owner ships after fix); move `todo → in-progress` (that's the claimer's transition); delete tasks |
| **File complaints** | Use `atmux complaints file --target-team <root-cause-team> --summary "<…>" --severity P<n> --related-task <t-id> --blocker-class <class>` (per ADR-147 + ADR-150 cross-team path) | Escalate to martinet directly (the complaint *is* the escalation surface); file complaints inside its own team for itself (would loop) |
| **Update task body** | Add a `## Unblocker note` section to the body documenting the resolution path | Rewrite the body / change the deps / change the priority |
| **Spawn cross-team work** | Via complaint to the root-cause team's ombudsman (which may file an EPIC there) | Directly add Tasks in sibling teams' kanbans |
| **Touch reviewer-gated commits** | Surface a reviewer-flag complaint when a commit appears to have skipped a reviewer-gate | Approve / reject commits; revert commits |

The `blocked → done` exclusion is load-bearing per ADR-005 (kanban-source-of-truth): the original owner ships after fix because they have the full Task context. Unblocker resolves the *blocker*, not the *task*.

### (D5) Boundary with ombudsman — disjoint surfaces

Per EPIC §pre-flag #6.

- **Unblocker domain**: `tasks WHERE status='blocked'` (any source) + the auto-promotion-derived complaints filed by ADR-153 R1.
- **Ombudsman domain**: `complaints WHERE status='open'` (any blocker class, any source).

These overlap on the R1-promoted complaints (a 24h stale kanban-blocked Task gets a complaint by R1). The overlap is **resolved by ownership of the artifact**:

- The **complaint** is owned by ombudsman (adjudicates: file epic / file task / wontfix / already-addressed / defer per ADR-147 §D3).
- The **blocked kanban Task** is owned by unblocker (drains: move blocked→todo, file cross-team complaint, reanimate, or surface-to-driver).

When a R1-promoted complaint exists and unblocker resolves the underlying blocker (kanban row moves to todo), the complaint's `auto-resolve` trigger (ADR-153 R1) fires on the next groom tick and closes the complaint automatically. Ombudsman's `## Complaints adjudicated` log entry will show `auto-resolved by R1 (kanban unblocked)`. No coordination handoff between the two roles; the SQL view does the work.

**The two roles never compete on the same artifact** — unblocker touches kanban rows, ombudsman touches complaints rows. When a complaint adjudication results in "this is a member-stuck blocker, route to unblocker," ombudsman files / re-files the kanban Task at `status=blocked` (or surfaces a complaint with `blocker_class=member-stuck`); the unblocker picks it up on the next sentinel-write or backstop poll.

### (D6) Concurrency with members — lane-respect window

Per EPIC §OQ4 + planner-anchor #7.

When a Task transitions to `status=blocked` whose owner's lane could plausibly fix the blocker (e.g. `be` lane Task with a dep on another `be` Task), unblocker **waits `team.unblocker.laneRespectMinutes ?? 30` minutes** before acting. Two reasons:

1. **Avoid stealing work** — a `be`-lane member who saw the blocker land may pick it back up via `claim`-cycle once the dep ships.
2. **Avoid double-claiming** — a member mid-investigation of the blocker shouldn't have unblocker file a duplicate complaint underneath them.

**Forced-pickup override**: when ADR-153 R1 fires (24h kanban-blocked → complaint), unblocker is allowed to pick up *without* the 30min wait. R1's threshold IS the "members' lane gave up on it" signal — the 24h floor is already past the lane-respect window. The override is documented per planner-anchor #7.

Default 30min is an empirical guess from atmux's own Blocked column history; tunable via `team.json::unblocker.laneRespectMinutes`. The §D8 dogfood plan tracks the parameter for the first month and revisits.

### (D7) Spawn-time integration

Per planner-anchor #6 + #8.

- **`start.ts`** provisions the unblocker pane during team start when the role appears in `requiredRoles` — same code path as every other required role. No special-casing.
- **`rotate-member` / `clear` / `bootstrap` verbs** work transparently on the unblocker member (no special-case; the role is a regular team member with a different brief).
- **Window naming** follows ADR-135 convention: `🩹-unblocker` (emoji-hyphen-member). The emoji 🩹 is chosen for visual distinction from gitter (🌿), reviewer (🛡), lead (🧭), planner (🗺), ombudsman (⚖), medic (🩺) — per planner-anchor #8. Operator can override via `member.emoji` per ADR-135.
- **Brief loading** — `boot-claude.ts` reads `templates/briefs/unblocker.md` at spawn, same path as other roles.
- **Model selection** — Opus per ADR-140 carve-out (default Opus for required-role members; the planner-anchor #2 reasoning lands in the brief's `## Why Opus` section).

### (D8) Dogfood path

Per planner-anchor #5 + the global "atmux dogfoods itself" memory.

1. **T2-T7 impl slices ship** (filed same-session per the decomp pattern): brief template + start.ts wiring + sentinel reader + whip backstop + reanimate authority gate + complaint-file path + 100%-coverage unit tests.
2. **Add unblocker to atmux team's `.atmux/team.json`** as the first dogfood team. Pre-impl, the Blocked column on atmux's kanban is back-drained manually by lead / operator; post-impl, unblocker drains it.
3. **Metric**: track `blocked-column-mean-age` weekly. Target: `<12h` mean age after one month of dogfood, down from the current uncapped tail. Dogfood gate (T9): unblocker's first week resolves ≥3 known blockers without operator intervention, AND no false-positive blocked→todo moves (where a member objects "I wasn't done with that").

**Status flip gate**: ADR-151 stays `Status: proposed` until the T9 dogfood gate passes; then `Status: accepted`. Per ADR-085 §2.5 the ADR is **not** annotated `(deferred: …)` because the deferral is short-window and tied to a specific gate.

### (D9) Cross-team escalation BOUNDARY

Per the in-team framing of §Context + EPIC §pre-flag #5.

Unblocker stays **strictly in-team**. When the root cause of a blocker is in a sibling team's lane (e.g. atmux blocks on a sopx schema change), unblocker:

1. Files a complaint via `atmux complaints file --target-team sopx --summary "atmux blocked on sopx schema X" --severity P2 --related-task t-xxx --blocker-class cross-team-dep` (ADR-150 cross-team helpers provide the `lookupTeamAtmuxDir` + `walkAllTeamAtmuxDirs` lookup; same path operators use).
2. Updates the local kanban Task body with a `## Unblocker note` pointing to the cross-team complaint.
3. Returns to its drain loop. The blocker stays `status=blocked` locally until the cross-team complaint resolves (ombudsman in the target team picks up; unblocker in the target team may pick up the underlying Task there).

**Martinet may re-route cross-team via sentinel** — when martinet observes that team A's blocker is being filed against team B's unblocker repeatedly, it can write a sentinel directly to team B's `.atmux/state/unblocker-pending.json` (ADR-150 walker locates B's `.atmux` dir). This skips the complaint round-trip for high-frequency cross-team patterns. The complaint path stays canonical for audit; the sentinel path is the fast lane.

Per planner-anchor #5.

### (D10) Per-team singleton; concurrency-with-self via tmux window-name uniqueness

Each team has at most one unblocker. The constraint is enforced via the existing tmux window-name uniqueness on `🩹-unblocker` — `start.ts` refuses to spawn a second window of the same name, same way every required role gets singleton enforcement today. No new locking primitive.

Cross-team concurrency (two siblings' unblockers acting simultaneously) is intentional and safe — each operates on its own team's kanban + cage. No shared mutex needed.

## Tradeoffs + alternatives considered

### Cockpit-W4 unblocker (cross-team from the start), NOT chosen

Considered. Rejected per (§Context "Why in-team") rationale + operator's 00:09 MYT framing:

- Team-local context cost would dominate every decision.
- Reanimation authority across teams duplicates martinet's existing responsibility.
- Cross-team failures already have a path (complaint → sibling ombudsman); a cockpit-W4 role would compete with that path rather than complement it.

### Lead drains Blocked (no new role), NOT chosen

Considered. Rejected:

- Conflicts with CLAUDE.md "lead is thin, never plans/codes/claims." Draining Blocked is judgment + write-side work; the lead would either pass it through (no value-add) or violate the thin-lead rule.
- Lead's cognitive budget is dispatch / status / rotation / Discord; adding "drain Blocked" pushes lead past 60min rotation faster, accelerating the rotation-thrash failure mode.

### Cheap-tier unblocker (Cursor composer-2-fast), NOT chosen

Considered. Rejected per planner-anchor #2 + ADR-140 carve-out:

- Classification is judgment work; cheap tier mis-classifies write-side decisions in the documented filing-clerk failure mode.
- Authority cost-of-error is too high for cheap-tier write-side actions (kanban mutations, complaint filings, reanimation).
- Martinet (cheap-tier) handles the *observation* loop into the sentinel; unblocker (Opus) handles the *action* loop out. The two compose; both at cheap-tier would either be unsafe or under-classified.

### Pure event-driven drain (no whip backstop), NOT chosen

Considered for simplicity. Rejected per EPIC §OQ1 + (D3):

- Martinet can miss (paused, rate-limited, mid-rotation).
- Operator-filed blockers (manual `status=blocked`) wouldn't trip martinet's heuristics until the next observe pass.
- The 15min whip backstop is cheap (one `atmux blockers list` query) and closes the latency tail.

### Pure polling (no sentinel), NOT chosen

Considered for simplicity. Rejected:

- Frequent polling spikes CPU at idle.
- Infrequent polling misses latency-sensitive blockers.
- The sentinel-write is martinet's existing observe-loop write; reusing it costs nothing.

### Unblocker writes its own complaints inbox (separate from ombudsman), NOT chosen

Considered briefly when sketching the boundary. Rejected per (D5):

- Two complaints surfaces fragment the cross-team escalation path operators already learned.
- Ombudsman's `## Complaints adjudicated` log is the canonical audit trail.
- Unblocker filing into the existing complaints table preserves that trail.

## Open questions (proposed → accepted gate)

- **OQ1** — should unblocker honor a "do-not-touch" annotation on Task bodies (e.g. `[unblocker:hold]`) for blockers the operator wants to handle manually? Default v1: NO; the operator can move the row out of `blocked` to signal hold. If the pattern recurs, T-future ADR.
- **OQ2** — should the lane-respect window default vary per lane (e.g. `be` lane gets 30min; `docs` lane gets 60min because docs members ship slower)? Default v1: single team-wide default; per-lane overrides via `team.json::unblocker.laneRespectMinutesByLane.<lane>` *only when* operator data justifies it. Document the override path; don't ship per-lane defaults until evidence appears.
- **OQ3** — should unblocker's brief include a section authorizing it to *paste* (not Enter-push) a starter command into a stuck member's compose box for the operator to review? Default v1: NO; ADR-138 verified send-keys with the `paste-only` policy is enough authority for write-side action. Adding paste-without-Enter creates a third mode (Enter / refuse / paste-only) the role doesn't need.
- **OQ4** — should the `dead-pane → reanimate` decision include a cooldown (e.g. don't reanimate more than once per 30min for the same member)? Default v1: YES — 30min hard cooldown per member; tracked in `.atmux/state/unblocker-reanimates.json`. Prevents reanimation loops on a chronically-crashing pane (escalate via complaint instead).
- **OQ5** — should unblocker's auto-fired complaints (cross-team escalations) include a `requires-driver-ack: true` marker that suppresses ombudsman auto-adjudication until the driver sees them? Default v1: NO; ombudsman's existing adjudication path is the right gate. If the pattern shows ombudsman auto-closing things the driver wanted to see, future ADR.
- **OQ6** — should unblocker emit a Discord ping on every drain action? Default v1: NO; whip's existing `[progress]` and `[blocker]` templates already cover the cases the operator cares about. Unblocker actions surface via the next whip cycle's commit cadence + status output. Reduces ping noise.

Reviewer / operator: any non-default flips `Status: proposed → accepted`.

## Acceptance (T1 commit)

- [x] ADR-151 Status: `proposed`, ready for reviewer pre-flag
- [x] Cross-refs all four sibling /bruh-sweep ADRs (152 / 153 / 154 / 155) + cross-team substrate (ADR-150) + ombudsman boundary (ADR-147) + medic / martinet substrate (ADR-077 / ADR-133 / ADR-132) + cadence (ADR-148) + cheap-model-first carve-out (ADR-140) + epic-team carve-out (ADR-090) + naming convention (ADR-135) + kanban truth (ADR-005) + flag surface (ADR-010) + proposed-deferred annotation (ADR-085)
- [x] §Schema documents `requiredRoles += "unblocker"` + brief template path + `team.unblocker.laneRespectMinutes` opt-in
- [x] §Decision documents drain-loop hybrid (D3) + authority matrix (D4) + ombudsman boundary (D5) + lane-respect (D6) + spawn integration (D7) + cross-team boundary (D9) + singleton enforcement (D10)
- [x] §Tradeoffs documents the five rejected alternatives
- [x] §OQ1-6 default routing — reviewer flips on dissent
- [x] §Out-of-scope: cross-team unblocker (martinet handles); cockpit-level fleet view (different layer); proposed-deferred ADR auto-action (per ADR-085); reviewer-gate enforcement (reviewer owns; unblocker surfaces only)
- [x] Single commit (ADR only)
- [x] CHANGELOG `[Unreleased]` entry under `📋 Proposed` (the doc + structural ADR; impl T2-T7 deferred per scope below)

## Out of scope

- Cross-team unblocker concurrency (martinet domain per ADR-132 + ADR-150)
- Cockpit-level fleet view of all teams' unblocker activity (different layer; not in this ADR's scope)
- Proposed-deferred ADR auto-action (per ADR-085 §2.5 — unblocker reads `Status: proposed (deferred: …)` as "intentionally not-ready" and does not file complaints on stale-deferred ADRs)
- Reviewer-gate enforcement (reviewer owns commit gates; unblocker surfaces violations via complaint, doesn't enforce directly)
- Execution slices T2-T7 — brief template ship, start.ts wiring, sentinel reader, whip backstop, reanimate authority gate, complaint-file path, 100%-coverage unit tests, dogfood gate. Each filed as a separate Task post-acceptance per the same-session decomp pattern (per `[[feedback_decomp_same_session_with_deps]]`); the staged carve-out is operator-decided.
- `atmux unblocker tick` cron template (sibling to ombudsman-tick / lane-stall-watch / gitter-sweep templates per ADR-134 T7) — filed under T-future; v1 ships sentinel + whip-backstop only, no dedicated cron line. Backstop runs as part of the existing whip cycle.

## Related work + sibling patterns

- **ADR-152** — blockers list verb. Unblocker is the named primary consumer (ADR-152 §Consumers names ADR-151 explicitly). The 7-surface fan-out gives unblocker a single read path; the `blocker_class` taxonomy is the routing key.
- **ADR-153** — auto-promotion rules. R1 (kanban-blocked → complaint at 24h) is unblocker's "members' lane gave up" signal — drives the forced-pickup override on the lane-respect window. R2 + R3 surface upstream pressure (driver-inbox aging, lead-outbox unacked) that unblocker reads as context but doesn't directly drain.
- **ADR-154** — SQLite storage. The `coordination_messages` table is what unblocker's read queries hit; the `extra` JSON forward-compat slot may carry `related_unblocker_action` fields in T-future.
- **ADR-155** — pane-state verb. The `runtime_state=dead` signal is unblocker's reanimation trigger; `residue_class` informs the "real-stuck vs auto-mode-residue" classification.
- **ADR-147 ombudsman** — direct boundary partner. The ombudsman-unblocker partition (complaints rows vs kanban rows) is the load-bearing simplification; without it, the two roles would compete.
- **ADR-132 martinet** — sentinel-router into unblocker. Martinet observes; unblocker acts. ADR-140's cheap-model-first principle composes through their division of labor.
- **ADR-150 cross-team coordination** — helper functions (`lookupTeamAtmuxDir`, `walkAllTeamAtmuxDirs`) handle unblocker's cross-team complaint filing path. Reuse, no new abstractions.
- **ADR-005 kanban-source-of-truth** — the kanban is canonical; unblocker mutates it under controlled rules (blocked → todo only, never blocked → done). The kanban-truth invariant survives.
- **ADR-148 cadence-truth-signal** — cadence is the verdict; pane-state is the proxy. Unblocker honors both: cadence tells it "this member isn't shipping"; pane-state tells it "this member's pane is dead." The two compose in the classification step.
- **`[[feedback_lead_thin_relay]]` memory** — lead stays thin; unblocker absorbs the drain-Blocked work that would otherwise pile on the lead's cognitive budget. The thin-lead invariant survives.
- **`[[project_martinet_pattern]]` + `[[project_medic_rename_adr_133]]` memories** — cockpit-W2 medic + cockpit-W3 martinet stay where they are; unblocker is the in-team mirror of "self-healing" that closes the cockpit-in-team symmetry.
- **`[[feedback_opus_all_for_agile_flow]]` memory** — every role in the agile flow runs Opus; unblocker is the documented cheap-model-first carve-out (per ADR-140 + planner-anchor #2).


## §Amendment 2026-05-20 — promoted to accepted (status-drift audit T4)

Promoted from `proposed` → `accepted` per [docs/audits/adr-status-drift-audit-2026-05-20.md](../audits/adr-status-drift-audit-2026-05-20.md) (sha=a6f1541). Code-refs + git-log refs both present at audit time confirming shipped + dogfooded status; the `proposed` marker was bookkeeping debt. Original Date preserved verbatim. Append-only — see Status field for the canonical flip; this §Amendment carries the audit traceability.

**Filed via** t-45b401c3 (T4 sweep, 2026-05-20).
