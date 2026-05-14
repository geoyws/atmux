# ADR-132: Pluggable whip-manager — offload pane-capture + nudging from Claude lead to any-LLM impl

**Status**: Proposed
**Date**: 2026-05-14
**Author**: atmux team (planner / t-0a889489)
**Parent EPIC**: t-b9529ea9
**Supersedes (in scope)**: ADR-086 §"Forward pointer (Phase 2)" — MiniMax-as-parallel-pulse-observer. This ADR generalises that forward-pointer to *any* whip-manager impl observing+nudging *any* team, not just pulse-verdict rendering.

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

ADR-086 §"Forward pointer (Phase 2)" already articulates this: a parallel MiniMax-via-OpenCode observer on the pulse-verdict signal catches Claude-shaped rationalisations. The same logic generalises to the whip itself. A same-model lead + same-model whip + same-model superdoctor stacks identical training-bias filters; the team can stay quietly stuck for hours under that stack. A diverse-model whip-manager is an independent observer with independent failure modes — a cheap structural antidote to the "everyone agreed everything was fine" outcome.

## Decision

### (D1) `WhipManager` is a pluggable abstraction, not a hardcoded LLM CLI

A new abstraction at `src/abstractions/whip-manager.ts` (TS interface, **spec only** in this ADR — implementation lands in EPIC sub-tasks T2-T7). Operator picks the impl per team via `team.json::whipManager`; cockpit.json carries the fleet default.

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
  lastWhipTickAt: number;
};

export type NudgeAction =
  | { kind: "enter-push"; member: string; reason: string }
  | { kind: "claim-next"; member: string; reason: string }
  | { kind: "rotate"; member: string; reason: string }
  | { kind: "escalate-to-claude-lead"; observation: Observation; reason: string };

export interface WhipManager {
  name: "claude" | "minimax" | "cursor" | "kimi";
  observe(team: string): Promise<Observation>;
  decide(obs: Observation): Promise<NudgeAction[]>;
  apply(action: NudgeAction): Promise<{ success: boolean; evidence: string }>;
  shouldEscalateToClaudeLead(obs: Observation): boolean;
}
```

`observe` is the data-bundle producer (pane captures + kanban reads + commit-cadence query). `decide` is the policy step that emits zero-or-more `NudgeAction`s. `apply` fires the side-effect via existing atmux verbs (`atmux send`, `atmux task assign`, etc. — same verbs the current whip uses). `shouldEscalateToClaudeLead` is the strict gate (§D3).

### (D2) Four initial impls — `claude` baseline + 3 non-Claude variants

Per the EPIC swap matrix:

| Impl name | LLM CLI | Cage tier (ADR-050 ref) | Default cadence | Use case |
|---|---|---|---|---|
| **claude** | `claude` (operator-user, full git) | Tier 1 (no cage; operator runtime) | 270s | Baseline / degenerate impl / fallback if non-Claude managers fail |
| **minimax** | `minimax-cli` via OpenCode bridge | Tier 3 (dedicated `minimax-agent` Linux user; no git in workspace; ACL read-only on project) | 300s | Cheap routine whip on saturated fleets — primary cost-saver |
| **cursor** | `cursor-agent --model composer-2` | Tier 2 (cage tmux + operator-user; full git for cleanup ops) | 270s | Mid-tier with mutative git for in-line cleanup (lane backfill, ghost-owner reassign via `atmux task assign`) |
| **kimi** | `kimi-cli` | Tier 3 (dedicated `kimi-agent` Linux user) | 600s | Diverse-model observer for model-diversity / blind-spot detection on longer-cadence sanity passes |

**Cage tiering** reuses the existing `src/abstractions/fallback-cage.ts` infrastructure (per ADR-050 §Decision-2 — *"`_atmux_fallback_cage_create <team> <lane> <tier-config>`"*). No new daemon. No new socket-pubsub layer. The whip-manager is a long-running tmux-caged process that the cockpit / `atmux start` provisions alongside team members.

> **Cross-ref note**: The EPIC body cites "ADR-058 (fallback-cage tiering)" — ADR-058 does not exist as a separate ADR; the fallback-cage tiering specification is canonical in **ADR-050** "Multi-tier executor fallback chain". This ADR (132) consistently references ADR-050 from this point forward.

### (D3) Escalation contract — strict gate

`shouldEscalateToClaudeLead(obs)` returns **true** only under these judgment-class conditions:

| # | Trigger | Rationale |
|---|---|---|
| E1 | A member wedged >15min after an `enter-push` nudge | Per global CLAUDE.md "Don't make a dormant team look like a working team" — dormancy past nudge-window = escalate, not re-nudge |
| E2 | Kanban shows ADR-131 hygiene-blocker class on P0 (ghost-owner with zero candidates, lane-mismatch on P0 wedge ≥4h) | ADR-131 §D5 already defines the same threshold for Discord ping; whip-manager mirrors that gate |
| E3 | A member's worktree has a `git merge` conflict OR a force-push permission denial (per CLAUDE.md Push Policy) | Conflicts + permission walls are judgment-class; whip-manager autonomy stops there |
| E4 | Operator chat-time directive sat in `driver-inbox` unprocessed for >2 ticks | Inbox-drift is lead-class accountability; whip-manager surfaces, doesn't action |
| E5 | The non-Claude manager produces low-confidence output (self-reported confidence <`escalationConfidenceThreshold`) on >3 consecutive ticks | Self-distrust gate — when the cheap model isn't sure, hand off |

**Otherwise**, the non-Claude whip-manager handles the action autonomously: Enter-push on queued composer text, `atmux claim --next` re-fire, deterministic-pick lane-tiebreak reassignment via `atmux task assign` (per ADR-131 §D3 deterministic-fix policy — same philosophy: bounded-risk autopilot beats unbounded-dormancy refusal).

### (D4) Config surface — `team.json` + `cockpit.json`

`team.json` gains optional `whipManager` + `whipManagerOverrides` (Zod-extended in EPIC sub-task T5):

```json
{
  "name": "atmux",
  "whipManager": "minimax",
  "whipManagerOverrides": {
    "cadenceSec": 300,
    "escalationConfidenceThreshold": 0.7,
    "cageTier": 3
  }
}
```

`cockpit.json` gains optional fleet-default:

```json
{ "defaultWhipManager": "minimax" }
```

**Resolution order** (per existing cockpit + team-config pattern): per-team override beats cockpit fleet-default beats hard-coded `"claude"` fallback. Backward-compatibility: a team.json with no `whipManager` field auto-resolves to `"claude"` and the existing whip codepath fires unchanged.

### (D5) Cadence + budget interaction

The whip-manager runs in its own cage with its own runtime token budget — **independent of the Claude Max budget** that ADR-049 budget-pause guards. A MiniMax-as-whip-manager team continues whipping during a Claude lead's budget-pause window. This is the load-bearing operational win: **the team's commit cadence becomes decoupled from the Claude lead's budget cycle** for the mechanical-observation tier.

Escalations during a Claude budget-pause window queue in the driver-inbox / lead-inbox and process when the Claude lead's pause resolves. Whip-manager keeps the team moving on mechanical work in the meantime.

### (D6) Same-commit doc updates per atmux CLAUDE.md docs discipline

EPIC sub-task chain enforces same-commit docs (per CLAUDE.md "Docs Discipline" §"Same-commit doc updates"):

- T5 (config schema) lands the `whipManager` field documentation in `README.md` + `docs/HANDOFF.md` + `docs/PRD.md` in the same commit.
- T2 (interface + ClaudeManager) lands the `WhipManager` shape in `docs/ARCHITECTURE.md` in the same commit.
- T7 (e2e) lands the operator-runbook snippet (how to flip a team to MinimaxManager) in `docs/RUNBOOK-*.md` in the same commit.

ADR-132 is itself the spec; further doc updates compose on top per sub-task.

## Tradeoffs

### Bounded vs unbounded — same philosophy as ADR-131

| Choice | Risk shape | Pick? |
|---|---|---|
| Cheap-LLM whip-manager handles mechanical work; escalates judgment-class via strict gate (§D3) | **Bounded**: occasional wrong Enter-push or wrong deterministic-pick costs one tick; self-corrects on next observe | ✅ |
| Stick with Claude-only whip; cap lead context with rotation only | **Unbounded** for budget — every team-hour costs ~300k Opus tokens on mechanical work, exhausting weekly budget windows; team commits stop on budget-pause | ❌ |
| Build cross-model consensus from day 1 (MiniMax + Kimi both observe, vote) | Over-engineering for v1; consensus complexity hides observability of which observer fired which nudge | ❌ deferred to Phase 3 |

### Misdiagnosis blast radius

Wrong Enter-push: the worst case is firing Enter into a queued message that should have been edited first — surfaces as a one-tick rework. Wrong deterministic-pick reassignment: same as ADR-131 §Tradeoffs — bounded load imbalance for one tick. Wrong rotate: more disruptive (loses one member's context window); §D3 E1+E5 keep `rotate` on the Claude-lead escalation path, not the autonomous-action set. Concretely: `decide()` MUST NOT emit `{ kind: "rotate" }` unless explicitly authorised by the cockpit config to do so (sub-task T6 nails this down — recommended default: rotate is escalation-only, never autonomous).

### Cost — token + cage budget

- **Token-side win**: replaces ~300k Opus tokens/hour with ~30k MiniMax / Cursor tokens/hour for the mechanical pass + ~15-30k Opus tokens/hour for escalations only. Order-of-magnitude reduction in Claude budget burn per team.
- **Cage-side cost**: one additional caged tmux server + one dedicated Linux user (Tier 3 impls only) per team running a non-Claude whip-manager. Reuses ADR-050's provisioning script — additive 1 user per impl-tier, not per team. atmux dogfood opt-in costs 1 user (`minimax-agent`) + 1 cage at atmux-team start time.

## Cross-references

- **ADR-050** — Multi-tier executor fallback chain. **Canonical fallback-cage tiering reference** (EPIC body's "ADR-058" should read ADR-050). Tier 2 Cursor cage path is e2e-validated per ADR-050 §"E2E proofs"; ADR-132 reuses the same cage primitive.
- **ADR-086** §"Forward pointer (Phase 2)" — MiniMax-as-parallel-pulse-observer. ADR-132 supersedes that pointer for the whip-manager scope (broader than pulse-verdict — covers full observe+decide+apply loop, not just verdict rendering).
- **ADR-131** — superdoctor kanban-hygiene auto-fix loop. **Same deterministic-tiebreak philosophy** — bounded-risk autopilot beats unbounded-dormancy refusal. WhipManager.decide() implements the same lane-affinity → load → alphabetical resolution rule when emitting `claim-next` / reassign actions.
- **ADR-082** — per-member worktree isolation. WhipManager observations honour worktree boundaries; pane captures are per-worktree.
- **ADR-084** — per-member branch model. WhipManager natural-lane resolution reads `team.members[].lane` introduced in ADR-084's adjacent schema work.
- **ADR-077** — superdoctor cockpit role. Superdoctor (hourly cadence) and WhipManager (270-600s cadence) operate at different tiers: superdoctor diagnoses recurrence + files complaints; whip-manager observes + acts within-tick. No overlap; complementary.
- **ADR-049** — budget-pause. WhipManager runs in its own runtime; non-Claude impls keep the team moving during Claude budget-pause windows (see §D5).
- **CLAUDE.md** "always read pane state BEFORE tmux send-keys" + "push them to work — submit queued member input" — the operator-side rules WhipManager structurally enforces.

## Open questions

**OQ-1 — Hot-swap mid-run vs restart-to-swap?**

Whether `team.json::whipManager` field changes should hot-swap the running manager (kill cage + respawn new tier + transition state) or require an `atmux stop` → flip → `atmux start` cycle.

**Recommended default for v1: restart-to-swap.** Hot-swap requires Observation-state portability across impls (each impl has slightly different internal scratch), and the v1 use case is "operator decides which manager fits the team at start time, sticks with it." Restart cost is one team-cycle (~1min for a 10-member team), tolerable for an opt-in feature flag. **Revisit if pain emerges** — specifically, if operators find themselves frequently flipping managers mid-run to debug an issue, or if the cost of carrying a wrong manager for one team-lifecycle becomes operationally meaningful.

Driver override via decisions log when the use case justifies the impl complexity.

**OQ-2 — Per-member whip-manager vs team-wide?**

Whether each member can be observed by a different manager (e.g. `up-impl` by MinimaxManager for routine, `reviewer` by ClaudeManager for judgment-heavy reviewer-class events).

**Recommended default for v1: team-wide.** Per-member multiplies the cage count (N managers × M teams instead of 1 × M); the implementation complexity is substantial (per-member resolution path through `team.json::members[].whipManager`); and the operational signal of "did MinimaxManager handle this well?" is much harder to read when one team has 3 managers running simultaneously. The team-wide unit is fine for v1 — team observability stays simple; operators can opt entire teams into different managers; cross-team comparison stays clean.

Driver override via decisions log when per-member differentiation surfaces concrete demand (e.g. reviewer-class members need Claude observation even when the rest of the team is on MiniMax).

## Implementation plan

This ADR commits the **specification only**. Implementation lands across the EPIC's seven sub-tasks (per t-b9529ea9 §Sub-tasks):

| T | Sub-task | Deps | Lane |
|---|---|---|---|
| T1 | Draft ADR-132 (this ADR) | — | docs/planner |
| T2 | `src/abstractions/whip-manager.ts` interface + `ClaudeManager` degenerate impl + unit tests | T1 | be |
| T3 | `MinimaxManager` + Tier-3 cage provisioning + unit tests | T2 | be |
| T4 | `CursorManager` + `KimiManager` impls + unit tests | T2 | be (parallelizable with T3) |
| T5 | `team.json` + `cockpit.json` Zod schema + same-commit docs | T2 | be |
| T6 | Formal pane-state → `NudgeAction` classifier (`src/core/whip-manager-classifier.ts`) + tests | T2 | be |
| T7 | e2e — synthetic team with MinimaxManager + 1hr cycle + lead-token-burn assertion (<30k Opus/hr) | T3, T5, T6 | test |

Reviewer flips this ADR Proposed → Accepted in a follow-up commit per the EPIC's acceptance gate.

## Out of scope

- **Cross-model consensus** — multi-observer voting on actions. Defer to Phase 3 if model-diversity in observation surfaces concrete value beyond single-observer (e.g. MiniMax flags a wedge Claude missed AND Kimi confirms it, both within one tick).
- **Hot-swap mid-run** — see OQ-1; v1 ships restart-to-swap; revisit on operational pain.
- **Per-member whip-manager** — see OQ-2; v1 ships team-wide; revisit on concrete demand.
- **WhipManager observation of cockpit-tier surfaces** (superdoctor own loop, superdriver) — out of v1 scope; superdoctor is its own loop tier (ADR-077). The whip-manager observes *teams*; superdoctor observes *the cluster including teams*.
- **Custom whip-manager impls beyond the initial 4** — operator-provided plug-ins via a registry of impl files. Defer to a follow-up ADR if a fifth impl surfaces (e.g. Anthropic Haiku-as-whip-manager when a different cost/latency tradeoff materialises).
- **Discord channel routing per whip-manager** — all whip-manager surfacing routes through the existing `src/abstractions/discord.ts` typed renderers (per CLAUDE.md "All whip / watchdog / team / discorder / improve sends route through…"). No per-manager Discord channel.
