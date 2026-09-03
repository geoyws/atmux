# ADR-140: Cheap-model-first principle — periodic scans move to martinet; medic event-driven

**Status**: Accepted (2026-05-15, operator-batch-flip)
**Date**: 2026-05-14
**Driver-ref**: 2026-05-14 driver session — operator's progressive 4-message arc settled the framing.
**EPIC**: `t-83dcef6b` · **T1 scope** (this commit). T2 (ADR annotations on ADR-077 / ADR-131 / ADR-132 / ADR-139), T3 (medic verb refactor to event-driven), T4 (martinet `NudgeAction` enum extension) remain open under the EPIC.
**Reviewer**: gate before T3 (medic refactor) lands.

## §Amendment — cron-polling pattern revision (2026-05-20)

Cheap-model-first principle (cursor for observation loops + mechanical nudges + routine rotation) STANDS. The cron-polling delivery pattern for cheap-model invocation is REVISED:

### Decision

Cheap-model invocations under lean-mode topology fire via:

1. On-demand operator verb (`atmux doctor`, `atmux wedges`) — `atmux sentinel tick --once` deleted 2026-05-23 per e-be01fc89 (Sentinel REMOVAL EPIC); orchd substrate (EPIC e-a946af69) absorbs its event-driven equivalent.
2. Event-driven dispatcher hook (escalate-to-claude-lead per `t-ffcbd1dc`)

NOT via continuous cron-polling. The 65-70% Claude-burn reduction projected in this ADR was an EVERY-TICK calculation under cron-polling; under lean-mode, the realized reduction is HIGHER because most ticks no longer fire (no idle-cycle observation cost).

See [ADR-132 §Amendment 2026-05-20](./132-pluggable-martinet.SUPERSEDED.md) + [ADR-189](./189-lean-mode-side-project-topology.md) (the lean-mode pivot anchor) + Epic `e-be01fc89` for the full pivot.

**Filed via** t-4de68474 (docs role, 2026-05-20).

## §Amendment 2026-05-23 — Sentinel deletion per e-be01fc89

The cheap-model-first principle still applies; the *sentinel-tier invocation surface* is gone. Cursor/Opus invocations for observation/nudging now route through:

- `atmux doctor` (on-demand operator audit, code/lint/test classes per the doctor self-diagnostics history (no surviving local ADR file))
- `atmux wedges` (on-demand wedge sweep per [ADR-186](./186-wedge-clearing-mechanism.md))
- orchd event consumers (EPIC e-a946af69) — event-driven escalate-to-claude-lead absorbs the cron-polling shape

The §Amendment 2026-05-20 cron-polling pivot above is now historical context; e-be01fc89 closes the migration entirely (no `atmux sentinel tick --once` verb remaining).

## Context

### Operator's 4-message arc (2026-05-14)

1. *"i think medic shouldn't do a scan… we should reduce loops and scans for those running Claude and pass those to MiniMax (martinet)"*
2. *"let minimax do the unblocking via martinet since claude likes to be reluctant and dodge work"*
3. *"let martinet do the member rotation as well"*
4. *"now let's remove minimax from being martinet because it's unreliable and not smart enough. let's only allow cursor cli (composer 2 fast)"*

Combined: Claude has a documented tendency toward reluctance / dodging on mechanical-but-uncomfortable actions (Enter-push, modal-release, force-push, member rotation on threshold trips). MiniMax + Kimi don't carry that reluctance BUT also don't pass the capability bar (unreliable + not smart enough per operator's evaluation 2026-05-14). **Cursor composer-2-fast** is the sweet spot: cheap (vs Opus xhigh), decisive (no Claude-style hedging), capable enough for the martinet contract.

### Pre-ADR-140 architecture (the problem)

Claude (Opus xhigh) does four things:

| Category | Approx. tokens/hour | Why it's expensive |
|---|---|---|
| **(1) Periodic observation scans** | ~330k | Lead whip 270s × 25k Claude tokens — fires on every team |
| **(2) Mechanical nudges** | ~50k | Enter-push, claim-next-injection, modal-release |
| **(3) Routine member rotation** | ~10k | Per-symptom-class thresholds |
| **(4) Strategic + code-gen + review** | variable | The legitimate Claude work |

Categories (1)–(3) are **mechanical AND Claude hedges on them**. Category (4) is what Claude is uniquely good at. Total mechanical Claude burn pre-ADR-140: **~390k+ tokens/hour**.

## Decision

### Cheap-model-first principle (canonical)

- **Claude (Opus xhigh)** = strategic + judgment + code generation + code review + creative work.
- **Cursor composer-2-fast** (via martinet, Tier 2 cage per ADR-050) = ALL mechanical execution loops + ALL uncomfortable-but-routine actions.
- ~~MiniMax / Kimi~~ = **REJECTED** 2026-05-14 — capability too low for the contract. Cursor is the production-grade tradeoff.

### What MOVES to martinet (Cursor composer-2-fast)

- **Periodic observation scans** — pane state captures, kanban hygiene checks, refusal-pattern detection, commit-cadence verdicts, force-push detection.
- **Mechanical nudges** — Enter-push, claim-next-injection, modal-release on routine choices, `atmux send` keystroke dispatch.
- **Unblocking** — choice-prompt decisions when operator-directive is clear, force-push when operator-authorized (non-staging only per push policy), modal-release on routine variants.
- **Routine member rotation** — fired by martinet on threshold trips (context-token >400k per [[feedback_rotation_threshold_400k]], refusal-pattern, dormancy-window). Medic + lead lose rotation authority on **routine** triggers.

### What STAYS in Claude (Opus xhigh)

- **Strategic dispatch** — lead decides task assignment, deadline routing, priority.
- **Code generation** — members write actual implementation.
- **Code review** — reviewer gates commits.
- **ADR authorship + decisions** — planner-far / planner-near + lead.
- **Operator-escalation calls** — when martinet escalates a judgment-class event back to a Claude-backed role.
- **Code-fix-to-atmux** — medic's narrowed scope when structural failures need source patches.

### Roles + responsibilities matrix (canonical post-ADR-140)

| Role | Cadence | LLM | Scope |
|---|---|---|---|
| `_superdriver` (W1) | on-demand | Claude Opus xhigh | operator's cross-team REPL |
| `_medic` (W2) | **event-driven** | Claude Opus xhigh | code-fix-to-atmux + cage-cycle authority; NO scan loop; NO routine rotation |
| `_martinet` (W3) | 270s per-tick | **Cursor composer-2-fast** (Tier 2 cage) | ALL observation loops; ALL mechanical nudges; ALL unblocking; routine rotation; commit-cadence verdicts |
| per-team viewers (W4+) | on-demand | n/a | nested-attach windows |
| team-lead (per-team W2) | 30–60min strategic | Claude Opus xhigh | dispatch, decisions, Discord, ADR-routing; NO pane scans post-ship; NO routine rotation |
| planner / reviewer / lane workers | per-task | Claude Opus xhigh | strategic + code-gen + review |
| gitter (per-team) | event-driven | Claude Opus xhigh (or cheap if scoped narrow) | auto-merge fan-in per ADR-134 |

### Authority split for rotation

Medic and lead retain **emergency** rotation authority for narrow cases:

- **Medic** keeps rotation authority for code-fix scenarios — when a member's claude proc is genuinely broken and needs `kill+respawn` rather than a graceful threshold-rotation.
- **Lead** keeps rotation authority for per-team strategic emergencies — when a planner is misaligned with operator intent and needs replacement mid-cycle.

**Routine** rotation (context-token >400k, refusal-pattern, dormancy-window) moves entirely to martinet.

## Token-burn projection

Pre-ADR-140 (Claude does everything):

| Layer | Tokens/hour | Cost basis |
|---|---|---|
| Lead whip 270s × 25k | ~330k Claude | Opus xhigh |
| Medic hourly × 50k | ~50k Claude | Opus xhigh |
| Mechanical nudges + rotations × 60k | ~60k Claude | Opus xhigh |
| **TOTAL Claude (mechanical only)** | **~440k tokens/hour** | Opus xhigh |

Post-ADR-140 + Cursor composer-2-fast:

| Layer | Tokens/hour | Cost basis |
|---|---|---|
| Lead reduced whip 30min × 25k | ~50k Claude | Decision-class only |
| Medic event-driven × 10k average | ~10k Claude | Code-fix only |
| Martinet Cursor 270s × ~8k Cursor-tokens | ~107k Cursor | composer-2-fast |
| Mechanical nudges + routine rotations | +~30k Cursor | martinet-handled |
| **TOTAL Claude** | **~60k tokens/hour** | (~86% reduction) |
| **TOTAL Cursor** | **~137k tokens/hour** | composer-2-fast |

Cost ratio: Cursor composer-2-fast is roughly 1/4 the per-token rate of Opus xhigh (per current Anthropic + Cursor pricing as of 2026-05). Net cost reduction: **~65–70% Claude burn replaced by Cursor cost**. Less aggressive than the rejected MiniMax projection, but MiniMax was unreliable; Cursor is the production-grade tradeoff.

## Migration impact on filed EPICs

This ADR is a **principle**; implementation happens via amendments to other ADRs (T2 scope):

- **[ADR-077 medic](077-superdoctor-cockpit-role.md)** — scan-loop deprecated; event-driven listener post-ADR-140; rotation authority narrowed to code-fix scenarios. Annotation header.
- **ADR-131 kanban-hygiene** — EPIC body update: detectors run in martinet (Cursor), not medic. Not yet authored at this ADR's time — forward-reference.
- **ADR-132 martinet** — already updated 2026-05-14 with 2-impl design (Cursor composer-2-fast default + Claude degenerate fallback). Not yet authored at this ADR's time — forward-reference.
- **[ADR-138 verified send-keys](138-verified-send-keys.md)** — martinet (Cursor) is the primary caller of `safeSendKeysWithVerify`. Already authored 2026-05-14.
- **ADR-139 refusal detection** — EPIC body update: runs in martinet (Cursor) only; auto-rotate fires from martinet. Not yet authored — forward-reference.

## Sub-tasks (per EPIC `t-83dcef6b`)

| Task | Subject | Lane |
|---|---|---|
| T1 (this) | Draft ADR-140 + matrix + token-burn projection + operator-directive arc | docs/planner |
| T2 | Annotate ADR-077 medic + cascading EPIC body updates on ADR-131 / ADR-132 / ADR-139 | docs |
| T3 | Refactor `src/verbs/superdoctor.ts` (medic verb) — disable scan-loop; add event-listener reading `~/.atmux/state/medic-events.log`; narrow rotation authority to code-fix path | be |
| T4 | Update `src/abstractions/martinet.ts` `NudgeAction` enum (per ADR-132 T2) — add `modal-release`, `force-push-approved`, `rotate-routine`; differentiate from current `rotate` which becomes `rotate-emergency` (medic-class) | be |

T2–T4 are not yet filed as separate kanban Tasks at the time of this commit. Recommendation: planner-near to decompose the EPIC into 4 leaf Tasks so T2–T4 are claim-able. Without separated Tasks, T2–T4 risk staying invisible to the claim-next algorithm.

## Consequences

**Positive**:

- ~70% Claude token-burn reduction on mechanical work. Strategic Claude spend is preserved.
- Eliminates the Claude-hedging failure mode on mechanical-but-uncomfortable actions. Cursor doesn't hedge.
- Medic becomes event-driven — only runs when something actually broke. No idle hourly tick.
- Lead's whip cadence stretches from 270s to 30min — only fires for decision-class events.

**Negative**:

- Architecturally invasive — touches medic, lead, martinet, and every detector that currently lives in the per-team whip loop. Migration is multi-week.
- Cursor composer-2-fast is verbose vs MiniMax — fewer per-tick tokens but more total volume. Net cheaper than Claude; cost monitoring needed to validate the projection.
- Authority split (routine martinet, emergency medic/lead) adds one decision per rotation event. Mitigation: martinet's threshold-trip detection is unambiguous (numeric thresholds), so the split is mechanical.

**Reversibility**: low. Once detectors move to martinet, reverting requires moving them back AND restoring the per-team whip cadence AND restoring medic's scan loop. Plan migration in waves (ADR-131 first, ADR-132 second, ADR-139 third) so each is independently reversible.

## Out of scope

- MiniMax / Kimi backends — **REJECTED** per operator's evaluation 2026-05-14. Capability bar too low.
- Replacing Claude entirely — out of scope; Claude stays for strategic + code-gen + review.
- Formal per-role cost accounting — back-of-envelope projection here is illustrative; precise accounting deferred to a follow-up budget-monitoring ADR.
- Pre-ADR-132 transition state — until martinet ships with a `CursorMartinet` impl (ADR-132 T3), medic continues its scan-loop + lead continues its per-tick whip. ADR-140 is the **target state**; the transition is sequenced through ADR-131 / ADR-132 / ADR-139 implementations.

## Cross-references

- **[ADR-077](077-superdoctor-cockpit-role.md)** — medic (will be annotated by T2).
- **[ADR-138](138-verified-send-keys.md)** — verified send-keys; Cursor martinet is the primary caller.
- **ADR-050** — Tier 2 cursor cage; proven via `t-90cc66de` (done). Forward-reference.
- **ADR-131** kanban-hygiene — martinet-resident detection (Cursor). Forward-reference.
- **ADR-132** martinet v2 — 2-impl design (Cursor composer-2-fast + Claude degenerate). Forward-reference.
- **ADR-134** auto-merge fan-in (gitter). Forward-reference.
- **ADR-139** refusal detection — martinet-resident (Cursor). Forward-reference.
- `[[feedback_overnight_reddit_stakes]]` (memory) — operator threat on 0-commit overnights; ADR-140 protects against budget-blow on idle Claude scan-loops.
- `[[feedback_rotation_threshold_400k]]` (memory) — operator-set context threshold; ADR-140 routes the routine-trigger rotation through martinet.
- **Operator's 4-message arc 2026-05-14** — the canonical source for §Context.
