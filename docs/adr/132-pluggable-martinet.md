# ADR-132: Pluggable Martinet — cockpit-level pane-capture + nudging offload from Claude lead to any-LLM impl

**Status**: Accepted (2026-05-15, operator-batch-flip)
**Date**: 2026-05-14
**Author**: atmux team (planner / t-0a889489)
**Parent EPIC**: t-b9529ea9
**Supersedes (in scope)**: ADR-086 §"Forward pointer (Phase 2)" — MiniMax-as-parallel-pulse-observer. This ADR generalises that forward-pointer to *any* Martinet impl observing+nudging *any* team's loop, not just pulse-verdict rendering.

> **Reshape note (2026-05-14 10:13 MYT)**: Driver renamed `WhipManager` → `Martinet` (semantic fit: martinet = strict disciplinarian enforcing rules; single-word identifier reads cleaner) and relocated the abstraction from per-team spawn at `atmux start` to a **cockpit-level role at window W3**, sibling of medic[^medic-rename] at W2.

[^medic-rename]: The cockpit self-healing role was renamed `superdoctor` → `medic` on 2026-05-14 per [ADR-133](./133-medic-rename.md). All references to "medic" below originally read "superdoctor" pre-rename. The fleet-wide single process iterates every enabled team per tick; per-team backend selection still lives in `team.json::martinet`. This ADR reflects the reshape; sub-task set expanded T1-T7 → T1-T8 (T8 = cockpit integration).

> **Reshape note 2 (2026-05-14, late afternoon)**: Operator dropped MiniMax + Kimi impls — *"unreliable and not smart enough"*. Current canonical impl set is **2-impl: `claude` (degenerate/baseline) + `cursor` (composer-2-fast, primary cost-saver)** per [ADR-140] §Decision + `[[project_martinet_pattern]]` memory. MiniMax/Kimi references in §D4 / §D6 / §D7 / §Tradeoffs / §Implementation plan / §Out of scope are preserved in §Historical alternatives below for audit-trail and superseded by the 2-impl set everywhere they appear. EPIC sub-task table reflects the drop: T3 (MinimaxMartinet) and T4's Kimi half are NO-OP / removed; T4 becomes Cursor-only. ADR-140 is the load-bearing forward-pointer for the cheap-model-first principle that justified MiniMax/Kimi originally and now justifies their replacement with Cursor.

> **Implementation note (2026-05-15)**: `CursorMartinet` ships in `src/abstractions/martinets/cursor.ts` per Task **t-e96d286a** (the kanban EPIC's repurposed T3 slot — slid up from the original T4 line in §"Implementation plan" below to absorb the dropped MiniMax T3). The verb-layer wiring in `src/verbs/martinet.ts::buildMartinet` constructs the impl when `team.martinet === "cursor"` (or `cockpit.defaultMartinet === "cursor"`); `src/verbs/cockpit.ts::buildMartinetWindowCommand` emits a `while true; do atmux martinet tick; sleep 270; done` loop for the cursor variant (no Claude TUI — cursor-agent is a `--print` CLI; the loop owns cadence). Cage posture: the cockpit W3 window itself runs as operator UID with full git access — the W3 window IS the Tier-2 cage in trust posture per ADR-058 §D1, so no separate `/tmp/atmux_cursor_martinet_<team>/sock` carve-out is provisioned (martinet is fleet-wide singleton; per-team cage paths in the original t-e96d286a body predated the §D2 fleet-singleton reshape).

## §Amendment — cost-curve realization + cron-polling deprecation (2026-05-20)

Cron-polling pattern documented in this ADR was load-bearing during fleet-bootstrap (4 teams, 27s/tick, ~5% CPU/cycle). At 18-team fleet observed 2026-05-20, the same pattern scaled to 2min/tick + 40% CPU/cycle on empty epic-team observations. Operator killed sentinel cron at 11:15 MYT.

### Decision

Cron-polling is DEPRECATED under lean-mode side-project topology (new [ADR-189](./189-lean-mode-side-project-topology-preset.md)). The `atmux sentinel tick --once` verb is PRESERVED as on-demand audit invocation; identical observe→decide→apply loop, single tick exit.

Event-driven escalate-to-claude-lead from dispatcher (`t-ffcbd1dc` anchor) replaces cron-polling for wedge-detection. See Epic `e-be01fc89` for the full lean-mode pivot.

ADR-132 §D2 (sentinel load-bearing safety gate) REMAINS in force as the substrate for the on-demand verb + event-driven dispatcher escalation. Only the cron-polling integration is deprecated.

**Filed via** t-4de68474 (docs role, 2026-05-20).

## Context

### The lead's whip burns Opus-grade tokens on mechanical work

Lead's per-turn `/whip` cycle burns ~20–30k tokens (N pane captures + status-indicator parsing + kanban delta + dispatch composition + nudge fire). At the canonical 270s cadence that's **~300k tokens/hour active**. Empirically, ~80% of those turns are pure mechanical observation+action:

- Capture pane via `tmux capture-pane -p -t <window>` and parse the status-indicator strip at the bottom (`thinking with`, `Compacting conversation`, `auto mode on`, `Now using extra usage`, etc.).
- Detect queued-but-unsubmitted composer text (e.g. `claim T<N>`, `atmux claim --next --as <role>`) and decide whether `tmux send-keys -t <window> Enter` is safe (per global "always read pane state BEFORE tmux send-keys" + "push them to work — submit queued member input").
- Walk kanban delta — new claims since last tick, completed Tasks, wedge fingerprints (per ADR-131).
- Compose dispatch / nudge messages from formulaic templates (per `~/.claude/skills/whip/whip-prompt.md` §6 + §7).
- Fire `atmux send` / `atmux dispatch` / `atmux task assign`.

None of those steps require Opus-grade reasoning. They require pane-state discipline + deterministic-policy compliance — both encodable in cheaper or model-diverse runtimes.

### Lead context bloats fast; mechanical work is the load-bearing offload target

At 400k-token rotation threshold (per [[feedback_rotation_threshold_400k]]), the lead rotates roughly every 80min of active whipping. Most of the consumed context is repeated pane captures + status snapshots — high-entropy in the prompt cache but low-value for judgment. Offloading mechanical observation to a cheap or diverse LLM keeps the Claude lead's context budget reserved for **genuine judgment-class decisions**: rotation calls, complaint-box authoring, structural-fix decisions, cross-team correlation.

### Model-diversity catches blind spots same-model loops rationalise away

ADR-086 §"Forward pointer (Phase 2)" already articulates this: a parallel MiniMax-via-OpenCode observer on the pulse-verdict signal catches Claude-shaped rationalisations. The same logic generalises to the whip loop itself. A same-model lead + same-model whip + same-model medic stacks identical training-bias filters; the team can stay quietly stuck for hours under that stack. A diverse-model Martinet is an independent observer with independent failure modes — a cheap structural antidote to the "everyone agreed everything was fine" outcome.

### Why cockpit-level, not per-team

Per-team spawn would multiply Martinet processes by team count (N teams × 1 Martinet = N cages). Cockpit-level single-process iteration over `cockpit.json::teams` matches **medic's existing precedent** (ADR-077 §D1 — hourly fleet-wide loop over every enabled team): one cage to provision/destroy at cockpit rebuild, fleet-wide visibility for cross-team correlation, single inbox surface for escalations. Per-team configuration (which CLI backend to dispatch on which team) is preserved via `team.json::martinet` — the fleet-wide loop just reads each team's config on its iteration.

## Decision

### (D1) Martinet is a pluggable abstraction at `src/abstractions/martinet.ts`

A new abstraction (TS interface, **spec only** in this ADR — implementation lands in EPIC sub-tasks T2-T8). The interface name `Martinet` (strict disciplinarian / drill instructor) captures the role precisely: this is the loop that **enforces shipping cadence**, fires Enter-pushes on stalled composers, surfaces wedges, escalates judgment-class to Claude lead.

Interface shape (per EPIC body):

```ts
export type Observation = {
  team: string;
  members: {
    name: string;
    paneState: PaneStateSnapshot;           // status-indicator, last-output-age, etc.
    ctxTokens: number;                       // approximate; cheap to compute
    lastEnterPushable: boolean;              // safe to fire tmux Enter?
    queuedComposerText: string | null;       // typed-but-not-submitted
  }[];
  kanbanDelta: {
    newClaims: ClaimEvent[];
    completedSinceLastTick: TaskRef[];
    wedgedClaims: WedgeFingerprint[];
  };
  commitCadence: {
    sinceLastTick: number;
    last30min: number;
    last2hr: number;
  };
  lastTickAt: number;
};

export type NudgeAction =
  | { kind: "enter-push"; member: string; reason: string }
  | { kind: "claim-next"; member: string; reason: string }
  | { kind: "rotate"; member: string; reason: string }
  | { kind: "escalate-to-claude-lead"; observation: Observation; reason: string };

export interface Martinet {
  name: "claude" | "cursor";  // post-2026-05-14: MiniMax + Kimi dropped per Reshape note 2
  observe(team: string): Promise<Observation>;
  decide(obs: Observation): Promise<NudgeAction[]>;
  apply(action: NudgeAction): Promise<{ success: boolean; evidence: string }>;
  shouldEscalateToClaudeLead(obs: Observation): boolean;
}
```

`observe` is the data-bundle producer (pane captures + kanban reads + commit-cadence query). `decide` is the policy step that emits zero-or-more `NudgeAction`s. `apply` fires the side-effect via existing atmux verbs. `shouldEscalateToClaudeLead` is the strict gate (§D5).

Impls live in `src/abstractions/martinets/{claude,cursor}.ts` post-2026-05-14 drop (MiniMax + Kimi removed). Escalation classifier (formal pane-state → NudgeAction mapping) lives in `src/core/martinet-escalation.ts` — load-bearing safety gate per `[[project_martinet_pattern]]`. Fleet-wide tick loop lives in `src/verbs/martinet.ts`.

**Cross-ref: ADR-139 refusal-pattern scan (2026-05-16 / T3 t-841049e4)** — every martinet tick MUST invoke `atmux refusal-scan --team-dir <path>` once per enabled team as part of (or alongside) its `observe()` pass. The verb captures each member's pane via tmux, classifies via `classifyRefusal` (ADR-139 T2), and records positive results to the per-team `refusal_events` SQLite table (migration v6→v7). Martinet is the **primary detector** at 270s cadence; medic (ADR-077 §F7) is the hourly backstop running the same verb. Both writers share the same `UNIQUE(member, minute_bucket, severity)` idempotency contract so concurrent ticks collapse cleanly. T8 (cockpit wiring) picks up the verb-invocation hook from `templates/briefs/martinet.md`; until martinet's skill prompt lands, medic carries the load alone.

### (D2) Cockpit-level placement at W3 — new window topology

Cockpit window order updates as follows:

| Window | Role | Status |
|---|---|---|
| W1 | superdriver (cross-team aggregator) | existing |
| W2 | medic (fleet self-healing per ADR-077; formerly `superdoctor`, renamed per ADR-133) | existing |
| **W3** | **martinet (NEW — pluggable per-team whip-manager, fleet-wide iterator)** | **NEW** |
| W4+ | per-team viewers | **shifted from W3+** |

**Backward compatibility**: when `cockpit.martinet.enabled !== true`, W3 is **not provisioned** and per-team viewers stay at W3+ (existing behaviour). The schema field `cockpit.martinet.enabled` defaults `false` on cockpit.json schema-load so existing rosters carry no breaking change. Opt-in by adding the `martinet` block to `cockpit.json`.

**ADR-063 cross-ref update (in T8)**: ADR-063 §"Cockpit topology" enumerates W1+W2+W3+... window naming. T8 lands the doc update there to include the W3=martinet entry alongside the existing W1/W2/W4+ documentation.

### (D3) Fleet-wide tick loop — runs in cockpit W3

`src/verbs/martinet.ts` (lands in T2 / T8 wiring):

```ts
async function martinetTick(cockpitCfg: Cockpit) {
  for (const team of cockpitCfg.teams.filter((t) => t.enabled)) {
    const impl = await resolveMartinetImpl(team);    // reads team.json.martinet
    const obs = await impl.observe(team.name);
    const actions = await impl.decide(obs);
    for (const a of actions) await impl.apply(a);
  }
}
```

`resolveMartinetImpl` resolves the backend per team via the resolution order in §D6 (team override → fleet default → hard-coded `claude`).

**Cadence**: per-team via `team.json::martinetOverrides.cadenceSec` (per-impl defaults: claude=270, cursor=270 — post-2026-05-14 2-impl set). Fleet-wide tick runs at `min(per-team cadence)` — typically 270s. The tick loop is fired from cockpit W3 via `/loop /martinet` (same skill-driven pattern medic uses in W2).

**Cage sharing**: the Martinet cage is provisioned at cockpit rebuild (not per-team `atmux start`). One cage per unique `martinet` value across enabled teams — i.e. if every team is `cursor`, one shared CursorMartinet cage handles all teams in W3. Mixed-backend fleets (some teams `claude`, others `cursor`) instantiate one cage per backend; the fleet-wide tick loop dispatches the right impl on each team's iteration.

### (D4) Two initial impls — `claude` baseline + `cursor` primary

Post-2026-05-14 simplification (per Reshape note 2 + [ADR-140]):

| Impl name | LLM CLI | Cage tier (ADR-050 ref) | Default cadence | Use case |
|---|---|---|---|---|
| **claude** | `claude` (operator-user, full git) | Tier 1 (no cage; operator runtime) | 270s | Baseline / degenerate impl / fallback when Cursor cage is provisioning or down |
| **cursor** | `cursor-agent --model composer-2-fast` | Tier 2 (cage tmux + operator-user; full git for cleanup ops) | 270s | **Primary cost-saver** — cheap (vs Opus xhigh), decisive (no Claude-style hedging on mechanical-but-uncomfortable actions), capable enough for the martinet contract. Tier 2 cursor cage proven via `t-90cc66de` (done) per [ADR-140] §Cross-references. |

**Cage tiering** reuses the existing `src/abstractions/fallback-cage.ts` infrastructure (per ADR-050 §Decision-2 — *"`_atmux_fallback_cage_create <team> <lane> <tier-config>`"*). No new daemon. No new socket-pubsub layer. The Martinet cage is a long-running tmux-caged process that the cockpit rebuild provisions in W3.

> **Historical alternatives (rejected 2026-05-14)**: MiniMax-via-OpenCode (Tier 3, `minimax-agent` user, 300s) and Kimi (Tier 3, `kimi-agent` user, 600s) were specified in the original 4-impl design. Operator dropped both: *"unreliable and not smart enough"*. Cursor composer-2-fast became the production-grade tradeoff. See `[[project_martinet_pattern]]` + `[[project_cheap_model_first_adr_140]]` memory for full context.

> **Cross-ref note**: The EPIC body cites "ADR-058 (fallback-cage tiering)" — ADR-058 does not exist as a separate ADR; the fallback-cage tiering specification is canonical in **ADR-050** "Multi-tier executor fallback chain". This ADR (132) consistently references ADR-050 from this point forward.

### (D5) Escalation contract — strict gate (six triggers, E6 is MANDATORY)

`shouldEscalateToClaudeLead(obs)` returns **true** only under these judgment-class conditions:

| # | Trigger | Rationale |
|---|---|---|
| E1 | A member wedged >15min after an `enter-push` nudge | Per global CLAUDE.md "Don't make a dormant team look like a working team" — dormancy past nudge-window = escalate, not re-nudge |
| E2 | Kanban shows ADR-131 hygiene-blocker class on P0 (ghost-owner with zero candidates, lane-mismatch on P0 wedge ≥4h) | ADR-131 §D5 already defines the same threshold for Discord ping; Martinet mirrors that gate |
| E3 | A member's worktree has a `git merge` conflict OR a force-push permission denial (per CLAUDE.md Push Policy) | Conflicts + permission walls are judgment-class; Martinet autonomy stops there |
| E4 | Operator chat-time directive sat in `driver-inbox` unprocessed for >2 ticks | Inbox-drift is lead-class accountability; Martinet surfaces, doesn't action |
| E5 | The non-Claude Martinet produces low-confidence output (self-reported confidence <`escalationConfidenceThreshold`) on >3 consecutive ticks | Self-distrust gate — when the cheap model isn't sure, hand off |
| **E6** | **Ship-zero window — 0 commits across root + submodules >2hr (whip §0.05 / [[feedback_overnight_reddit_stakes]] territory)** | **MANDATORY regardless of Martinet impl.** This is the dormancy-is-not-defensible escalation. No impl may suppress it; the formal classifier (T6) hardcodes E6 as `shouldEscalateToClaudeLead === true` unconditionally above the per-impl override surface. |

**Otherwise**, the non-Claude Martinet handles the action autonomously: Enter-push on queued composer text, `atmux claim --next` re-fire, deterministic-pick lane-tiebreak reassignment via `atmux task assign` (per ADR-131 §D3 deterministic-fix policy — same philosophy: bounded-risk autopilot beats unbounded-dormancy refusal).

**`rotate` action is escalation-only**: `decide()` MUST NOT emit `{ kind: "rotate" }` autonomously. Rotation crosses the judgment-class threshold (loses one member's context window). T6 hard-codes the constraint in the classifier; `rotate` actions in `decide()` output are rewritten to `escalate-to-claude-lead` with `reason: "rotation-class action — judgment required"`.

### (D6) Config surface — `team.json` + `cockpit.json`

`team.json` gains optional `martinet` + `martinetOverrides` (Zod-extended in EPIC sub-task T5):

```json
{
  "name": "atmux",
  "martinet": "cursor",
  "martinetOverrides": {
    "cadenceSec": 270,
    "escalationConfidenceThreshold": 0.7,
    "cageTier": 2
  }
}
```

`cockpit.json` gains `martinet` block + fleet-default top-level field (Zod-extended in T5 + wired in T8):

```json
{
  "defaultMartinet": "cursor",
  "martinet": {
    "enabled": true,
    "claudeAccount": { "configDir": "/root/.claude-unum", "label": "unum" },
    "tuiOverrides": { "effortLevel": "xhigh", "permissionMode": "auto" }
  }
}
```

The `cockpit.martinet.{claudeAccount, tuiOverrides}` pair re-uses `CockpitClaudeAccount` and `CockpitTuiOverrides` from ADR-077 §D2 verbatim (same struct pattern as medic) — drift detection via ADR-054 §D3 `.strict()` Zod stays consistent.

**Resolution order** (per existing cockpit + team-config pattern): per-team `team.json::martinet` beats `cockpit.json::defaultMartinet` beats hard-coded `"claude"` fallback. Backward-compatibility: a team.json with no `martinet` field auto-resolves to `"claude"` and the existing whip codepath fires unchanged (Martinet impl `claude` is the degenerate impl wrapping the current whip prompt).

### (D7) Cadence + budget interaction

The Martinet runs in its own cage with its own runtime token budget — **independent of the Claude Max budget** that ADR-049 budget-pause guards. A team with `martinet: "cursor"` continues whipping during a Claude lead's budget-pause window. This is the load-bearing operational win: **the team's commit cadence becomes decoupled from the Claude lead's budget cycle** for the mechanical-observation tier.

Escalations during a Claude budget-pause window queue in the driver-inbox and process when the Claude lead's pause resolves. Martinet keeps the team moving on mechanical work in the meantime.

### (D8) Same-commit doc updates per atmux CLAUDE.md docs discipline

EPIC sub-task chain enforces same-commit docs (per CLAUDE.md "Docs Discipline" §"Same-commit doc updates"):

- **T5** (config schema) lands `martinet` field documentation in `README.md` + `docs/HANDOFF.md` + `docs/PRD.md` in the same commit.
- **T2** (interface + ClaudeMartinet) lands the `Martinet` shape in `docs/ARCHITECTURE.md` in the same commit.
- **T7** (e2e) lands the operator-runbook snippet (how to flip a team to CursorMartinet) in `docs/RUNBOOK-*.md` in the same commit.
- **T8** (cockpit integration) lands the W3=martinet entry in ADR-063 §"Cockpit topology" + cross-ref note in ADR-077 §D1 + same-commit `templates/briefs/lead.md` update noting *"your whip loop may be replaced by the cockpit-level martinet per team config; you still get escalations via the E1-E6 contract — see ADR-132 §D5"*.

ADR-132 is itself the spec; further doc updates compose on top per sub-task.

## Tradeoffs

### Bounded vs unbounded — same philosophy as ADR-131

| Choice | Risk shape | Pick? |
|---|---|---|
| Cheap-LLM Martinet handles mechanical work; escalates judgment-class via strict gate (§D5) | **Bounded**: occasional wrong Enter-push or wrong deterministic-pick costs one tick; self-corrects on next observe | ✅ |
| Stick with Claude-only per-team whip; cap lead context with rotation only | **Unbounded** for budget — every team-hour costs ~300k Opus tokens on mechanical work, exhausting weekly budget windows; team commits stop on budget-pause | ❌ |
| Build cross-model consensus from day 1 (multiple cheap LLMs both observe, vote) | Over-engineering for v1; consensus complexity hides observability of which observer fired which nudge. Originally framed around MiniMax + Kimi; both dropped 2026-05-14 per Reshape note 2. | ❌ deferred to Phase 3 |

### Cockpit-level vs per-team — why one not the other

| Choice | Risk shape | Pick? |
|---|---|---|
| Cockpit-level single-process fleet-wide iteration (this ADR) | **Bounded**: one cage to manage, matches medic precedent (ADR-077 §D1), shared cage cost across teams with same backend | ✅ |
| Per-team Martinet spawn at `atmux start` | N cages on N teams; provisioning + teardown per team-lifecycle; no cross-team correlation surface | ❌ |

### Misdiagnosis blast radius

Wrong Enter-push: worst case is firing Enter into a queued message that should have been edited first — surfaces as a one-tick rework. Wrong deterministic-pick reassignment: same as ADR-131 §Tradeoffs — bounded load imbalance for one tick. Wrong rotate: more disruptive (loses one member's context window); §D5 keeps `rotate` on the Claude-lead escalation path, not the autonomous-action set (T6 hard-codes this in the classifier).

### Cost — token + cage budget

- **Token-side win**: replaces ~300k Opus tokens/hour/team with ~30k Cursor (composer-2-fast) tokens/hour/team for the mechanical pass + ~15-30k Opus tokens/hour for escalations only. Order-of-magnitude reduction in Claude budget burn per team. With cockpit-level shared cages, the per-fleet (not per-team) Cursor cost is amortised across all teams using `cursor` backend. Net projection: ~65-70% Claude burn replaced by Cursor cost per [ADR-140] §Token-burn projection.
- **Cage-side cost**: one cage per unique martinet backend in cockpit W3. Tier 2 cursor cage runs as operator-user with mutative git for in-line cleanup ops — no dedicated Linux user needed (vs Tier 3 alternatives, dropped). atmux dogfood opt-in costs 1 W3 cage at cockpit rebuild time.

## Cross-references

- **ADR-050** — Multi-tier executor fallback chain. **Canonical fallback-cage tiering reference** (EPIC body's "ADR-058" should read ADR-050). Tier 2 Cursor cage path is e2e-validated per ADR-050 §"E2E proofs"; ADR-132 reuses the same cage primitive.
- **ADR-063** — Cockpit verb port + window topology. T8 updates §"Cockpit topology" to include W3=martinet.
- **ADR-077** — medic cockpit role (formerly `superdoctor`, renamed per ADR-133). Martinet at W3 is the sibling cockpit-level role to medic at W2. Same iteration model (fleet-wide single process), different cadence (270s tactical vs hourly recurrence-prevention). T8 updates §D1 cross-ref to acknowledge W3.
- **ADR-086** §"Forward pointer (Phase 2)" — MiniMax-as-parallel-pulse-observer. ADR-132 supersedes that pointer for the Martinet scope (broader than pulse-verdict — covers full observe+decide+apply loop, not just verdict rendering).
- **ADR-131** — medic kanban-hygiene auto-fix loop. **Same deterministic-tiebreak philosophy** — bounded-risk autopilot beats unbounded-dormancy refusal. Martinet.decide() implements the same lane-affinity → load → alphabetical resolution rule when emitting `claim-next` / reassign actions.
- **ADR-082** — per-member worktree isolation. Martinet observations honour worktree boundaries; pane captures are per-worktree.
- **ADR-084** — per-member branch model. Martinet natural-lane resolution reads `team.members[].lane` introduced in ADR-084's adjacent schema work.
- **ADR-049** — budget-pause. Martinet runs in its own runtime; non-Claude impls keep the team moving during Claude lead's budget-pause windows (see §D7).
- **ADR-054** §D3 — `.strict()` Zod pattern for cockpit.json. Martinet block uses the same pattern.
- **CLAUDE.md** "always read pane state BEFORE tmux send-keys" + "push them to work — submit queued member input" + whip §0.05 — the operator-side rules Martinet structurally enforces.
- **[ADR-138](138-verified-send-keys.md)** — verified send-keys; CursorMartinet's `apply()` MUST call `safeSendKeysWithVerify` per ADR-138 §"Forward-compat with ADR-132". The verified send-keys helper is the primitive every Martinet impl inherits for free.
- **[ADR-140](140-cheap-model-first.md)** — cheap-model-first principle. Canonical justification for routing mechanical observation + nudges + routine rotation to Cursor martinet, reserving Claude (Opus xhigh) for strategic + code-gen + code review. MiniMax/Kimi drop (Reshape note 2) is anchored to ADR-140 §Decision.
- **ADR-139** (forward-reference; file not yet authored) — refusal-pattern detection; runs **inside** the martinet tick loop post-ADR-140 (martinet absorbs the detector + auto-rotate-on-trigger). See `[[project_refusal_detection_adr_139]]` memory until the file lands.
- **[ADR-143](143-external-lead-rotation.md)** — external cron-fired lead-rotation enforcer (stopgap until this ADR's CursorMartinet ships T3/T4 of ADR-140). ADR-143's cron-rotate is deprecated-once-martinet-lands.

## Open questions

**OQ-1 — Hot-swap mid-run vs restart-to-swap?**

Whether `team.json::martinet` field changes should hot-swap the running backend (e.g. flip a team from `claude` to `cursor` without rebuilding cockpit) or require an `atmux cockpit rebuild` cycle.

**Recommended default for v1: restart-to-swap (cockpit rebuild).** Hot-swap requires Observation-state portability across impls (each impl has slightly different internal scratch), and the v1 use case is "operator decides which Martinet fits the team at cockpit-rebuild time, sticks with it." Restart cost is one cockpit rebuild (~1min), tolerable for an opt-in feature flag. **Revisit if pain emerges** — specifically, if operators find themselves frequently flipping backends mid-run to debug an issue.

Driver override via decisions log when the use case justifies the impl complexity.

**OQ-2 — Per-member Martinet vs team-wide?**

Whether each member can be observed by a different Martinet backend (e.g. `up-impl` by CursorMartinet for routine, `reviewer` by ClaudeMartinet for judgment-heavy reviewer-class events).

**Recommended default for v1: team-wide.** Per-member multiplies the cage count beyond the shared-cage optimisation (N members × M teams instead of one cage per backend across the fleet); the implementation complexity is substantial (per-member resolution path through `team.json::members[].martinet`); and the operational signal of "did CursorMartinet handle this well?" is much harder to read when one team has multiple backends running simultaneously. The team-wide unit is fine for v1 — team observability stays simple; operators can opt entire teams into different backends; cross-team comparison stays clean.

Driver override via decisions log when per-member differentiation surfaces concrete demand (e.g. reviewer-class members need Claude observation even when the rest of the team is on Cursor).

## Implementation plan

This ADR commits the **specification only**. Implementation lands across the EPIC's eight sub-tasks (per t-b9529ea9 §Sub-tasks):

| T | Sub-task | Deps | Lane |
|---|---|---|---|
| T1 | Draft ADR-132 (this ADR) | — | docs/planner |
| T2 | `src/abstractions/martinet.ts` interface + `ClaudeMartinet` degenerate impl + unit tests | T1 | be |
| ~~T3~~ | ~~`src/abstractions/martinets/minimax.ts` + Tier-3 cage provisioning + unit tests~~ | ~~T2~~ | **DROPPED 2026-05-14 — MiniMax rejected** |
| T4 | `src/abstractions/martinets/cursor.ts` (composer-2-fast, Tier 2 cage) + unit tests. **Landed 2026-05-15** (Task `t-e96d286a` — repurposed-and-renumbered to T3 in the kanban after MiniMax T3 drop; ADR T-numbering preserved here for append-only audit trail). | T2 | be |
| T5 | `team.json` + `cockpit.json` Zod schema for martinet config + same-commit docs | T2 | be |
| T6 | `src/core/martinet-escalation.ts` — formal pane-state → `NudgeAction` classifier + `rotate`-rewrite + E6 hardcoded gate + tests | T2 | be |
| T7 | e2e — synthetic cockpit with CursorMartinet + 1hr cycle + lead-token-burn assertion (<30k Opus/hr). **Spec landed (t-838288c0) at `tests/e2e/cursor-martinet.test.ts`** — six cases (module-load smoke, decide-invokes-composer-2-fast, §D5 E6 mandatory escalation, observe→decide→apply round-trip, token-burn deterministic, token-burn real env-gated). Skip-gates on `src/abstractions/martinets/cursor.ts` existence (lands with T4) + `cursor-agent` binary + `RUN_REAL_CURSOR=1` operator opt-in. Token-burn ceilings: input ≤ 50k, output ≤ 2k per the `composer-2-fast` envelope (`{ usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } }`). | T4, T5, T6 | test |
| **T8** | **Cockpit W3 wiring** — `src/verbs/cockpit.ts` provisions W3 when `cockpit.martinet.enabled === true`, `src/verbs/martinet.ts` fleet-wide tick loop, ADR-063 §"Cockpit topology" + ADR-077 §D1 cross-ref updates, `templates/briefs/lead.md` note | **T5** | **be** |

Sub-task IDs: T1 = `t-0a889489` (this Task); T8 = `t-fb5e4c1f` (added 2026-05-14 reshape). T2-T7 IDs land alongside in the EPIC sub-task block. **T3 (MinimaxMartinet) and T4's Kimi half are no-op / removed per Reshape note 2** — leaf-task closure logged in EPIC.

Reviewer flips this ADR Proposed → Accepted in a follow-up commit per the EPIC's acceptance gate.

## Out of scope

- **Cross-model consensus** — multi-Martinet voting on actions (originally framed as one MiniMax + one Kimi for divergence detection; both dropped 2026-05-14 per Reshape note 2). Defer to Phase 3 if model-diversity in observation surfaces concrete value beyond single-observer; if revisited, the post-drop replacements would be e.g. Cursor composer-2-fast + Claude-Haiku, not MiniMax/Kimi.
- **Hot-swap mid-run** — see OQ-1; v1 ships restart-to-swap via cockpit rebuild; revisit on operational pain.
- **Per-member Martinet** — see OQ-2; v1 ships team-wide; revisit on concrete demand.
- **Martinet observation of cockpit-tier surfaces** (medic own loop, superdriver) — out of v1 scope; medic is its own loop tier (ADR-077). Martinet observes *teams*; medic observes *the cluster including teams*.
- **Custom Martinet impls beyond the initial 2** (claude + cursor post-2026-05-14 simplification) — operator-provided plug-ins via a registry of impl files. Defer to a follow-up ADR if a third impl surfaces (e.g. Anthropic Haiku-as-martinet when a different cost/latency tradeoff materialises, or reinstatement of MiniMax/Kimi if their capability bar materially improves).
- **Discord channel routing per Martinet** — all Martinet surfacing routes through the existing `src/abstractions/discord.ts` typed renderers (per CLAUDE.md "All whip / watchdog / team / discorder / improve sends route through…"). No per-backend Discord channel.


## Amendments

### 2026-05-16 — Role-type identifier renamed `martinet` → `sentinel` (ADR-158)

The role type identified as "martinet" throughout this ADR is renamed to "sentinel" per [ADR-158](158-martinet-to-sentinel-rename.md) — SV/Reddit-eng register sweep, supersedes nomenclature only. Design preserved verbatim. Cockpit window `_martinet` → `_sentinel` via ADR-135 §D4 in-place rename (preserves PID + claude-process state). Schema JSON-shim in `src/core/cockpit.ts::migrateMartinetBlockToSentinel` accepts both `martinet:` and `sentinel:` keys for one release cycle (deprecation-warn on the legacy key). Source identifiers renamed in TR2: `src/abstractions/martinet.ts` → `src/abstractions/sentinel.ts`, `src/verbs/martinet.ts` → `src/verbs/sentinel.ts`, `src/core/martinet-escalation.ts` → `src/core/sentinel-escalation.ts`. See ADR-158 for the rename mechanic + rationale; the §Decision section of this ADR remains the canonical pluggable-impl design (now under the new name).

### 2026-05-19 — Scope confirmed: pane-liveness + mechanical nudges (boundary with medic)

**Driver finding 2026-05-19 06:00 MYT** (mechanism audit finding #2 against EPIC e-35dd6274). Boundary text added in tandem with [[ADR-077 §Amendment 2026-05-19]] to close the "who-owns-pane-death" seam exposed by today's silent gitter/committer death (TUI wedged but process alive; medic wouldn't probe because nothing was broken in the code sense). Without explicit text in both ADRs, future agents would keep falling into "medic should have caught that" / "I thought sentinel did that" arguments.

**Sentinel scope (this ADR — confirmed):**

- Pane liveness: claude TUI dead / wedged / rate-limited / refusing role.
- Mechanical nudges: enter-push, claim-next, modal-release, force-push-approved.
- Routine + emergency rotation (firing `atmux rotate <member>`) — preserves the cadence + authority narrowing per §D5 + ADR-140.
- Member compose-box unstick + observation per [ADR-140](./140-cheap-model-first.md) cheap-model-first.
- **Not scoped to**: code health, test failures, build/lint state, repository invariants. Those are medic scope per [[ADR-077 §Amendment 2026-05-19]].

**Out-of-scope clarification.** The original §"Out of scope" entry "Martinet observation of cockpit-tier surfaces (medic own loop, superdriver) — out of v1 scope" is preserved verbatim. EPIC e-35dd6274 §Part C (sentinel epic-team scope extension, codified in [ADR-185](./185-sentinel-epic-team-scope.md) per [t-2bbb828f](#)) extends sentinel observation to epic-team cages without dissolving this medic/sentinel boundary — sentinel still does not observe medic; medic still does not observe pane-liveness.

**Sentinel ↔ medic cross-invocation:**

- Sentinel observe-pass invokes doctor probes for code-class findings (read-only) and routes structural-fix asks to medic via escalate-to-claude-lead.
- Medic invokes doctor for liveness-class findings via the shared probe library (no medic owns sentinel's loop — both consume the same probe substrate per [ADR-027](./027-doctor-self-diagnostics.md)).

Cross-refs: ADR-077 §Amendment 2026-05-19 (medic boundary side), ADR-027 (doctor framework — shared probe substrate), ADR-140 (cheap-model-first justification), ADR-184 (host-cap epic-team gate — sentinel iteration scope), ADR-185 (sentinel epic-team scope extension), EPIC e-35dd6274 (wedge-clearing mechanism), t-186d5910 (sentinel deploy — landing makes the boundary observable in production cockpit telemetry).

### 2026-05-21 — Sentinel role retired entirely per ADR-211 (pluggable abstraction interface preserved one release)

**Driver-ref 2026-05-21** — operator question *"do we really need the sentinel?"* after Honker substrate (ADR-202 + ADR-203) ships and event-driven wake replaces the polling-era observation premise. Decision: **the Sentinel role retires entirely**; observation functions distribute to Honker event consumers per [ADR-211](./211-retire-sentinel-role-distribute-to-honker-consumers.md) §D2.

**What retires from this ADR:**

- §D1 backend selection (`claude` baseline vs `cursor` composer-2-fast vs the broader pluggable enum) becomes moot — no role is shipped against the abstraction at the cockpit W3 tier.
- §D2 pluggable abstraction interface is **preserved one release for back-compat** per ADR-211 §Status header — the Zod schema + `team.json::sentinel` field still parse during the grace cycle so existing rosters don't break on boot; cleanup-EPIC purges `src/abstractions/sentinel.ts` + `src/verbs/sentinel.ts` + the sentinel verb + sentinel-related cron entries after ≥30 days observed-stable.
- §D6 (`team.sentinel` config field) + companion `team.sentinelOverrides` + `cockpit.json::sentinel` block: same one-release grace then removed.
- Sibling sentinel-extension ADRs become **historical context only** per ADR-211 §Status header: ADR-158 (martinet→sentinel rename), ADR-183 (sentinel scope to epic-teams), ADR-185 (sentinel epic-team scope extension), ADR-206 (sentinel dynamic discovery), ADR-207 (Opus-sentinel supersedes cursor-sentinel — also gets its own §Amendment).

**What persists:**

- The **pluggable-impl design pattern** (Zod-validated backend interface + per-team config override + one-release migration shim) stands as design precedent for future role abstractions — the interface is preserved structurally, just unused.
- §Amendment 2026-05-19's sentinel↔medic seam (pane-liveness vs code-health) is also reshaped by ADR-212 (medic retirement) — both observation functions land on Honker consumers under the lead-gated execution pattern per ADR-212 §D2.
- ADR-186 wedge-clearing mechanism splits: probe-library half persists; sentinel-runner half migrates to a Honker consumer per ADR-211 §D2.

**Sequencing:** substrate landing (ADR-202 Phase 1, shipped 2026-05-21) → sentinel-eventized consumer EPIC → ≥30 days observed-stable → cleanup-EPIC purges sentinel code surfaces. The `team.json::sentinel` / `cockpit.json::sentinel` configs continue to parse during the grace cycle; doctor probe `cockpit-has-w3-sentinel` (P1) is retired alongside the cleanup-EPIC.

Cross-refs: [ADR-211](./211-retire-sentinel-role-distribute-to-honker-consumers.md) §D2 (Honker-consumer distribution of observation functions), [ADR-212](./212-retire-medic-lead-gated-rotation-simplify-honker-consumer-set.md) §D4 (1-EPIC `e-honker-observation-watchdogs` collapse absorbing sentinel + medic functions), [ADR-202](./202-honker-in-db-messaging-substrate.md) §D12 (consumer EPIC sequence — amended by ADR-211/212), [ADR-186](./186-wedge-clearing-mechanism.md) (wedge-clearing — probe-library half persists), memory `feedback_opus_all_for_agile_flow` (operator stance — refreshed 2026-05-21).

