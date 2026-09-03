# ADR-031: Aggressive parallelisation as the team default

**Status**: accepted
**Date**: 2026-04-27
**Related**: [ADR-021](./021-unblocker-role.md) (unblocker role), [ADR-022](./022-discorder-role.md) (discorder role), pull-kanban claim discipline

## Context

The team default has been **conservative parallelism**: one worker per lane (one BE / one FE / one TEST / one REVIEW), serial Story signoffs, strict lane-respect (no cross-lane fallback unless explicitly authorised). This shape ships work reliably but throttles end-to-end Story velocity behind:

- **Single-reviewer bottleneck**: every Story gates on one reviewer signing off; with 4–8 Stories per Epic, review becomes a serial queue. Even when BE/TEST workers are idle, work piles up at review.
- **Single-BE-worker bottleneck**: priority-1 BE-lane queue runs serial. A worker claims highest-priority Task, ships, claims next — the next Task in the queue waits regardless of independence.
- **Within-Story serial**: BE → TEST → REVIEW often gates on each other even when surface analysis says BE-and-FE-and-TEST could ship in parallel (e.g., Sd's `templates/briefs/superdriver.md` is text-only, independent of `lib/super-attach.sh`).

Driver feedback 2026-04-27 13:20 MYT: *"any parallelisation possible to speed things up... aggressive please and make aggressive the default in atmux."*

The conservative default was sized for v1 reliability; the team has accumulated enough discipline (pull-kanban, claim --next, lane-gate, structured flagging via `atmux flag`) that aggressive parallelism no longer trips on coordination races. Time to flip the default.

## Decision

**Aggressive parallelisation is the new team default.** Codified in three layers:

### Layer 1: Member redundancy in critical lanes (template-level)

Default team scaffolding (`templates/team.json.tmpl`) provisions:
- **2× members per critical lane** (BE, TEST, REVIEW) — duplicates pull from the same kanban, claim --next gives each the highest-priority Task in their lane in parallel.
- **1× FE worker** (FE Stories tend to be lower volume; promote to 2× on demand).
- **1× planner / lead / gitter / unblocker / discorder** — coordination roles don't parallelise cleanly.

Existing teams retroactively scaled via `atmux add-member <name>-2` calls. Driver fires the upgrade when team velocity warrants it; auto-applied to new teams via init wizard.

### Layer 2: Within-Story parallel dispatch (lead/planner discipline)

Lead's whip cycle + planner's Story decomposition explicitly identify Tasks that are **independent** within a Story:
- FE brief / docs Tasks: no code dependency on BE — dispatch in parallel.
- TEST scaffolding Tasks (helpers, fixtures): no dependency on the corresponding BE Task — dispatch when scaffolding alone is sufficient.
- BE / FE Tasks touching different file domains: dispatch in parallel.
- REVIEW Tasks for different Stories: dispatch to multiple reviewers in parallel.

Planner records per-Task `independent: true` field where applicable in Task body; lead honours by dispatching simultaneously (or letting claim --next pull both in same whip tick if multiple workers idle).

### Layer 3: Cross-lane fallback enabled by default (member discipline)

**Cross-lane fallback** (a member whose lane is dry claiming a Task from another lane) becomes the default when:
- Worker's primary lane has zero claimable Tasks (all dep-blocked or empty).
- Cross-lane Task's owner is `null` (no specific assignee).
- Cross-lane Task's body is brief-context-friendly (BE worker can plausibly ship a docs Task, etc.).

Workers no longer decline cross-lane fallback by default (per prior `feedback_reviewer_lane_gate` discipline — that memory still applies to *reactive* roles like reviewer/gitter/lead/planner, which never claim --next regardless of lane state). Standard members opt INTO cross-lane fallback.

Lead's brief carries this nuance: "if your lane is dry, claim --next from any open lane; refuse only if the cross-lane Task explicitly says `--lane-strict` in body".

### Driver-override priority

Driver retains the right to force priority-0 on critical-path Tasks (via direct `kanban.json` edit until `atmux task edit --priority` verb ships). Aggressive default + driver-override = fastest possible queue collapse for critical work.

### REVIEW-lane carve-out

Aggressive cross-lane fallback (the second-pass any-lane filter in `claim --next`) does NOT apply to `lane=review` Tasks. REVIEW signoff is specialty discipline (per [ADR-029](./029-driver-lead-team-scope-superdriver-cross-team.md) audit bar — exhaustive grep + negative-space proof + vulnerability-class widening); a `lane=fe` / `lane=be` / `lane=test` member cannot meaningfully deputize on it. The refuse-gate sits at two sites in `lib/claim.sh`:

- `_atmux_claim_select_next` second-pass any-lane filter — `lane=review` Tasks excluded when caller's `lane != review`.
- `main` `claim` branch (explicit-id form) — explicit `atmux claim <review-task-id>` refuses unless caller is review-shaped.

**Callers refused.** `role == "member"` AND `member.lane != "review"`.

**Callers allowed.** `member.lane == "review"` (e.g. `reviewer`, `reviewer-2`) OR `role IN {team-lead, planner, gitter, reviewer}` OR explicit `--lane review` override on the claim invocation (operator opt-in).

**Origin.** 2026-04-27: `fe-kanban` cross-lane'd into REVIEW Task `t-c88fc825` and `test-kanban` cross-lane'd into `t-5385881d` via the second-pass fallback before self-recognising the lane-purity violation and releasing back. The `feedback_reviewer_lane_gate.md` memory was the discipline rule; this carve-out makes the gate structural rather than relying on member-side judgment.

## Consequences

- **2–3× wall-clock acceleration** per Story end-to-end (parallel BE + REVIEW + within-Story FE/TEST).
- **2–3× concurrent Opus token burn** during active Story work — the cost is real, not hypothetical. Mitigation: members stay idle when kanban is dry (claim --next polls but doesn't burn unless work is available).
- **More coordination surface** for lead — managing 2 BE workers + 2 reviewers means whip cycle + dispatch logic must handle multi-claim contention. Lead's whip already de-dupes claims; no breaking change.
- **Brief drift risk** — adding be-kanban-2 / reviewer-2 means their briefs must mirror their `-1` counterparts. Use `atmux::brief_template` resolution by role-name (already-implemented); no per-instance briefs.
- **Cross-lane fallback risk** — a BE worker grabbing a docs Task may produce sub-par work. Mitigation: lane-strict opt-in flag on Tasks where cross-lane is unsuitable.
- **Existing teams must opt in** by spawning `-2` members. ADR doesn't auto-mutate live team.json files.
- **Conservative carve-out**: tiny teams (≤4 members total) skip the aggressive default — diminishing returns, more coordination overhead than parallelism gain. Lead/planner judges per-team when in doubt.
- **Smoke-test telemetry**: track per-Story end-to-end time pre-vs-post aggressive flip. If wall-clock doesn't improve ≥30% over 5 Stories, revisit.

## References

- Driver feedback 2026-04-27 13:20 MYT — "aggressive please and make aggressive the default"
- [ADR-021](./021-unblocker-role.md) — unblocker role (parallel detect/classify cadence already aggressive)
- [ADR-022](./022-discorder-role.md) — discorder role (offloaded narrative work, freeing lead bandwidth)
- `feedback_reviewer_lane_gate.md` — reactive roles still respect lane (refresher: applies only to reviewer/gitter/lead/planner, NOT standard members)
