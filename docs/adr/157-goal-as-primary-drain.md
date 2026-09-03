# ADR-157: `/goal` as primary drain for Claude service-loop roles — lane-tick narrows to backstop

**Status**: accepted (2026-05-16, planner-decomp T1; pending reviewer pre-flag → accepted)
**Date**: 2026-05-16
**Author**: atmux team (planner-decomp / lead re-slot 01:08 MYT; draft by up-impl)
**Parent EPIC**: t-3c1aab98
**Driver-ref**: operator 2026-05-16 00:55 MYT chat-time — *"let's remove the lane tick for claudes then and make sure that we use goal instead"*. Driver-side hedge accepted: *"good idea. go with ur recommendation"* (hybrid `/goal`-primary + lane-tick-backstop). Filed via /bruh sweep continuation 01:02 MYT; lead re-slotted 01:08 MYT (historical decision number 156 (no surviving ADR file) → ADR-157, see §Slot-ledger).
**Relates**: ADR-138 (verified send-keys — load-bearing dep for `/goal` injection), ADR-080 (lane-tick substrate — narrow not remove), ADR-145 (gitter-pattern — `/goal` interaction documented), ADR-134 (in-team auto-merger — cron orthogonality documented), ADR-132 + ADR-140 (martinet `runtime: "cursor"` carve-out), ADR-151 (unblocker — first goal-driven role consumer), ADR-148 (cadence-as-canonical-truth — `/goal` latency informs new cadence baseline).
**Slot-ledger note**: originally drafted as historical decision number 156 (no surviving ADR file); re-slotted to ADR-157 because t-20674483 (medic→canary rename) had pre-existing planner reservation on historical decision number 156 (no surviving ADR file) in the same /bruh-sweep-4 window. Slot-ledger post-resolution: 149 eternal-improvement · 150 cross-team-complaints · 151 unblocker · 152 blockers-list · 153 auto-promotion · 154 inbox-SQLite · 155 pane-state-structured · **156 medic→canary rename (t-20674483)** · **157 `/goal`-as-primary-drain (this ADR)**.

## Context

### The drain bottleneck

Today's drain mechanism for member work-loops is **external cron only**:

- Cron fires `atmux lane-tick` every 2 minutes (`*/2 * * * *`).
- `lane-tick` injects `atmux claim --next --as <member>` via `safeSendKeys` into each idle member's pane.
- Worst-case latency between task-completion and next-claim: **2 minutes** (member finishes a Task seconds after the prior tick → waits the full 119s for the next).
- Across a session of 10–20 task cycles per member, this compounds to **10–20 minutes of fleet-wide wall-clock waste** — drain latency that doesn't reflect actual work, just polling cadence.

### Claude Code v2.1.139+ ships `/goal`

Claude Code v2.1.139 introduced a native `/goal` skill: a per-turn Haiku-evaluator that checks a **completion condition** against the conversation transcript on every model turn. The "no new turn = condition met" semantic flips into something useful for service-loop roles — when the member tries to go idle (no further turn forthcoming), the evaluator fires, recognizes the goal is *not* satisfied, and self-nudges the member back into the work loop with **sub-second latency**.

This is structurally a better drain primitive for service-loop roles than external polling. The trade-off: `/goal` can only fire when the model takes a turn — wedged panes (rate-limited, OAuth-expired, dead claude process) produce no turns and therefore no evaluator fires.

### Why a hybrid, not full replacement

`/goal` is the right primary drain for the **happy path** — a Claude member finishing a task and looking for the next. It is the **wrong** drain for the failure-recovery path — a wedged or dead member that needs an external observer to detect liveness loss and escalate. The decision below adopts `/goal` as primary drain for the happy path and **narrows** lane-tick to a structural backstop for the failure path, rather than removing lane-tick entirely.

## Decision

### (D1) `/goal` is the PRIMARY drain for Claude service-loop roles

Claude-runtime members in service-loop roles (`gitter`, `unblocker`, `reviewer`, `lead`, `ombudsman`) get a per-role unsatisfiable-in-steady-state goal injected via `/goal "${member.goal}"` after every brief lands (cold-spawn + post-rotation). The per-turn Haiku evaluator drives drain: when the member finishes a task and the goal is unsatisfied, the evaluator self-nudges back into the loop.

Lane-tick **stops injecting `claim --next --as <member>`** for these members. Lane-tick **retains** three structural safety nets (see §D5) and runs at relaxed cadence (`*/5` recommended; `*/10` ceiling subject to validation, see §D6).

### (D2) Schema — `team.json.members[].goal: z.string().optional()`

Additive optional field. When present and `runtime !== "cursor"`, the member is goal-driven:

- Lane-tick skip-claim-injection branch detects the goal-active marker via `team.json` (cheap signal, no pane scan needed).
- Rotation + cold-spawn hooks fire `/goal "${member.goal}"` after brief lands.

Resolution chain (§OQ3 resolution): `team.json.members[].goal` (explicit override) takes precedence over `templates/briefs/<role>.md ## Standing Goal` section (brief-source default). The brief-source path keeps the canonical goal text DRY at the role layer; the team.json override gives per-team flexibility.

### (D3) Per-role goal phrasings (unsatisfiable in steady state)

| Role | Goal text |
|---|---|
| `gitter` | "All members' branches are merged to trunk and trunk typechecks green" |
| `unblocker` | "Kanban.status=blocked column is empty" |
| `reviewer` | "No commit in last 24h is unreviewed" |
| `lead` | "All members have a commit in last 30min AND no member is over ctx-threshold" |
| `ombudsman` | "complaints/ sentinel queue is drained" |

**Goal-phrasing rule (load-bearing — see §Decision-anchor #1)**: every per-role goal MUST be a condition that *re-satisfies* if real-world state regresses (a new commit lands, a new complaint files, a new blocked-task appears). Otherwise the evaluator halts the member permanently after first satisfaction — the opposite of desired behaviour. The reviewer pre-flag fires on every new goal addition (see §Decision-anchor #1).

Failure-mode example: gitter goal `"branches merged"` *without* the trailing `"AND trunk typechecks green"` would satisfy once and never re-fire when no merges are pending → gitter halts indefinitely. The "AND trunk typechecks green" tail re-arms the goal whenever a typecheck regression lands.

### (D4) Cursor-CLI carve-out (`runtime: "cursor"` short-circuits)

Members with `team.json.members[].runtime === "cursor"` (currently martinet via ADR-132 + ADR-140; future cursor-unblocker if any) do NOT get `/goal`:

- Cursor CLI has no equivalent skill — the Haiku evaluator is Anthropic-internal.
- Rotation + cold-spawn `/goal` injection hooks short-circuit on `runtime === "cursor"`.
- Lane-tick continues to fire `claim --next --as <cursor-member>` injection unchanged.
- Cron-driven nudge model preserved end-to-end for cursor members.

The runtime-gate is **structural**, not advisory — both the injection hooks AND the lane-tick skip-claim-injection branch read `runtime` and apply the gate.

### (D5) Lane-tick narrowing — three safety nets RETAINED verbatim

For Claude members where `member.goal` is set AND `member.runtime !== "cursor"`, lane-tick **skips** the `claim --next --as <member>` send-keys injection.

It **retains** three structural safety nets verbatim — these continue to fire on the same cadence for the same members:

1. **ADR-080 §B2 auto-done sweep** — commits Tasks where the SHA shipped but `atmux done` was not called (the `git log` ↔ kanban reconciliation surface). Independent of drain mechanism; runs for goal-active members too.
2. **ADR-080 §A2 lead-ctx-rotate nudge** — when the lead crosses the ctx-threshold, lane-tick injects `/team rotate-lead` instead of `claim --next`. Goal-active leads still need this rotation trigger; `/goal` cannot self-rotate the lead.
3. **Dead-pane / rate-limit-lockout detection + logging** — escalation signal for medic / canary. A wedged pane produces no turns → `/goal` evaluator never fires → goal-driven self-nudge never happens. Lane-tick is the external observer that catches this failure mode and surfaces it for downstream remediation.

Reviewer must verify all three preserved branches at code review of T4 (lane-tick narrowing impl) — see §Decision-anchor #3.

### (D6) Cron cadence — `*/2` → `*/5` (target) with `*/10` ceiling

Lane-tick cron cadence relaxes from `*/2 * * * *` to `*/5 * * * *` as the recommended target. `*/10` is the documented ceiling, acceptable iff validation shows `/goal` mean-time-to-detect-failure × 2 ≥ 5min.

The lower-bound floor is `/goal` failure-detection latency: under `*/N` cadence, a member wedged immediately after `/goal` injection has no Haiku evaluator firing and waits up to N minutes for lane-tick to detect dead-pane state. Cadence cannot be relaxed below this floor without sacrificing recovery time.

The cadence-choice criterion is documented explicitly (this paragraph): teams with stricter recovery-time SLAs cap at `*/5`; teams with more tolerance for failure-detection latency may go to `*/10`.

### (D7) Rotation + cold-spawn hooks — `safeSendKeysWithVerify` per ADR-138

Two injection hooks ship `/goal "${member.goal}"`:

- `src/verbs/rotate-member.ts` — post-bootstrap (after the brief lands and the member's pane is at the prompt), inject `/goal "${member.goal}"` via `safeSendKeysWithVerify` per ADR-138. Verification confirms the slash-command was actually accepted by the TUI rather than eaten by a modal or compose-box-already-occupied state.
- `src/verbs/start.ts` — member-bring-up at cold-spawn, same `/goal` injection after brief.

Both hooks NO-OP when `member.goal` is unset OR `member.runtime === "cursor"`.

`safeSendKeysWithVerify` is a structural dep (see §Decision-anchor #5) — raw `tmux send-keys` is forbidden for the `/goal` injection path because un-verified injection silently drops on modal-occupied or rate-limit-banner panes, leaving the member without the goal-driver and without an obvious failure signal.

## Decision-anchor pre-flags (planner-internal; reviewer enforces)

These seven anchors fold into §Decision above as inline guardrails. The reviewer pre-flag is binding for T2–T7 implementers.

1. **Goal-phrasing MUST be unsatisfiable in steady state** — per §D3 above. Reviewer pre-flag fires on every new goal addition: verify the predicate re-satisfies on state regression. Failure-mode: gitter goal `"branches merged"` without the `"AND trunk typechecks green"` tail satisfies once and halts when no merges are pending.

2. **Runtime-gate is structural** — `member.runtime === "cursor"` short-circuits BOTH the `/goal` injection hooks (D7) AND the lane-tick skip-claim-injection branch (D5). Cursor members keep cron-driven nudges unchanged. Schema-loader (T2) MAY refine to a hard error if both `goal` is set and `runtime === "cursor"` (defensive — pick one path); MAY also accept silently and log a warning. Recommend the warn-not-error path so partial migrations don't block startup.

3. **Lane-tick backstop preserves three functions** — auto-done sweep + lead-ctx-rotate nudge + dead-pane detection (D5). Losing claim-injection ONLY for goal-active Claude members. Reviewer must verify all three preserved branches at T4 code review; the test suite for T4 (t-e8ad0db5) MUST include explicit asserts that goal-active members still receive auto-done sweeps + dead-pane logs.

4. **Cadence target `*/5` with `*/10` ceiling** — `*/5` is the recommended cut; `*/10` acceptable iff validation shows `/goal` mean-time-to-detect-failure × 2 ≥ 5min. Lower bound floor is `/goal` failure-detection latency. T5 (cron cadence change) ships `*/5` default with team-config override.

5. **`/goal` injection via `safeSendKeysWithVerify` (ADR-138)** — NOT raw `tmux send-keys`. Verification confirms the `/goal` slash-command was actually accepted by the TUI (not eaten by a modal or compose-box-already-occupied state). ADR-138 verified-send is a structural dep; T3 (rotation + cold-spawn hooks) MUST cite ADR-138 in the impl PR and the test suite MUST include a verify-fails-on-occupied-modal case.

6. **OQ1 (compaction-survives-goal) is LOAD-BEARING** — per lead 01:12 MYT note. If compaction wipes `/goal`, the hybrid backstop becomes MANDATORY (not optional), lane-tick cadence can NOT be relaxed beyond compaction-frequency-mean (typically 10–30min). Verify before committing default. Two branches documented:
   - **Branch A** (compaction *preserves* goal): cadence relaxes to `*/5` default, `*/10` with empirical validation. Backstop is an optional safety net.
   - **Branch B** (compaction *wipes* goal): cadence stays `*/5` mandatory; backstop is structural failover, not optional. Re-fire `/goal` hook on compaction-detection (whip-cycle observation).
   - Default branch chosen based on OQ1 resolution in T1-or-T2 reviewer cycle. Explicit branch-flip ADR ships if the assumption changes post-acceptance.

7. **OQ4 (gitter-goal + ADR-145/ADR-134 cron interaction) — RESOLVED orthogonal** — `/goal` halts the **service-loop** (idle between actions), not the cron-driven action itself. ADR-134 T7 cron `atmux gitter --sweep` runs every N minutes regardless of `/goal` state; gitter wakes on cron, performs sweep, returns to `/goal`-satisfied state. No conflict between `/goal`-as-service-loop-drain and ADR-134/145 cron-driven gitter actions. Documented explicitly here so T6/T7 implementers don't re-litigate.

## Open questions

OQ1 — **Does `/goal` survive Claude Code's auto-compaction (NOT `/clear`, but mid-session ctx compaction)?** *Pending Anthropic verification.* `/clear` wipes the goal (Anthropic-confirmed); compaction is a different mechanic — transcript condense, not full wipe.

- **Hypothesis**: compaction *preserves* `/goal` because the goal lives in the agent system state (an internal evaluator slot), not in the conversation transcript. The transcript condense reshapes the message history; the goal-evaluator slot is orthogonal.
- **Verification path**: empirical — fire `/goal "test condition"` on a Claude member, force compaction (push transcript past the threshold), inspect whether the evaluator continues to fire on subsequent turns. T1-or-T2 reviewer cycle.
- **Branch decision**: see §Decision-anchor #6. If compaction wipes, backstop is mandatory + cadence floor tightens.

OQ2 — **Can the evaluator-fired auto-nudge be observed externally (log line, pane marker, transcript signal)?** If yes, lane-tick can detect "goal fired recently, member is alive" vs "goal never fired, member wedged" and skip more aggressively (or escalate faster on detected-dead). If no, conservative `*/5` cadence is the floor.

- **Recommend**: ship initial impl WITHOUT relying on observability; add the skip-aggressively branch as a follow-up ADR if observability surfaces in a future Claude Code release.

OQ3 — **Per-member goal text — brief-file vs `team.json`?** *Resolved per §D2*: brief-source primary (`templates/briefs/<role>.md ## Standing Goal` section, parsed at `start.ts`); `team.json.members[].goal` explicit override. Loader resolves: `team.json` explicit > brief-parsed. DRY at the role layer + per-team override flexibility. Documented in §Schema (D2).

OQ4 — **gitter-goal + ADR-145/ADR-134 cron interaction?** *Resolved per §Decision-anchor #7* (orthogonal layers; `/goal` halts service-loop; cron-driven `atmux gitter --sweep` is unaffected).

## Acceptance gates

- ADR-157 lands at `docs/adr/157-goal-as-primary-drain.md` with `Status: proposed`.
- Cross-refs: ADR-138 (verified send-keys — load-bearing dep), ADR-080 (lane-tick substrate — narrow not remove), ADR-145 (gitter-pattern — `/goal` interaction), ADR-134 (in-team auto-merger — cron orthogonality), ADR-132 + ADR-140 (martinet `runtime: "cursor"` carve-out), ADR-151 (unblocker — first goal-driven consumer), ADR-148 (cadence as canonical truth — `/goal` latency informs cadence baseline). ✅ (this commit)
- §Schema (D2) documents `member.goal` field + runtime-gate + resolution-chain (brief-source > team.json-explicit). ✅ (this commit)
- §Decision (D1–D7) documents goal-phrasing rule (D3) + 5 per-role example goals + lane-tick narrowing rules (D5) + cadence-choice criterion (D6). ✅ (this commit)
- §Decision-anchors document 4 OQs with branch-flip rationale (OQ1 LOAD-BEARING per lead 01:12 MYT note — Branch A optimistic / Branch B mandatory-backstop). ✅ (this commit)
- §Out-of-scope itemizes T2–T7 + Cursor-side equivalent + cross-team goal-coordination + `/goal`-driven kanban-claim authority. ✅ (this commit)
- Single commit (ADR + CHANGELOG only — no code).
- Reviewer-gated transition `proposed → accepted` after T1 reviewer pre-flag pass.

EPIC-level acceptance (T1 closes only the draft beat; T2–T7 carry the rest):
- `team.json.members[].goal` schema + loader + validator (T2).
- Rotation + cold-spawn hooks `/goal` injection via `safeSendKeysWithVerify` (T3).
- Lane-tick narrow + 3-safety-net preservation (T4).
- Cron cadence `*/2` → `*/5` + per-team override (T5).
- e2e latency benchmark + 3-failure-injection backstop proof (T6).
- Dogfood gated on ADR-151 unblocker EPIC `t-fba73bf8` cross-EPIC dep (T7).

## Out of scope

- **Schema impl** (T2 — `t-b5b0678e`).
- **Rotation + cold-spawn hooks impl** (T3 — `t-c89ead5f`).
- **Lane-tick narrowing impl** (T4 — `t-e8ad0db5`).
- **Cron cadence change** (T5 — `t-e847d0ae`).
- **e2e + failure-injection** (T6 — `t-869a0226`).
- **Dogfood** (T7 — `t-6f8d27e8`, gated on ADR-151 unblocker landing — `t-fba73bf8`).
- **Cursor-side `/goal` equivalent** — Cursor CLI has no upstream skill matching Claude Code's `/goal`. Future ADR if Cursor ships one; until then, `runtime: "cursor"` keeps cron-driven nudges (D4).
- **Cross-team goal-coordination** — single-team scope. A `/goal` set on one team's member does NOT propagate to sibling teams. Cross-team coordination remains operator-driven via cockpit + ADR-150 cross-team complaints.
- **`/goal`-driven kanban-claim authority** — `/goal` nudges the service-loop *back into the work loop*; it does NOT grant new authority to claim Tasks the member couldn't already claim via `atmux claim --next --as <member>`. Members still pull via lane-tick or self-initiated claim; `/goal` is a drain optimization, not an authority change.

## Cross-refs

- [ADR-138](138-verified-send-keys.md) — verified-send-keys; `safeSendKeysWithVerify` is the structural dep for `/goal` injection (D7 + Decision-anchor #5).
- [ADR-080](080-operator-observed-improvements.md) — lane-tick substrate; §B2 auto-done sweep + §A2 lead-ctx-rotate nudge are the two preserved safety nets (D5 #1–#2).
- [ADR-145](145-atmux-adopts-gitter.md) — gitter-pattern; `/goal` interaction with gitter resolved orthogonal (Decision-anchor #7).
- [ADR-134](134-in-team-auto-merger.md) — in-team auto-merger; `gitter --sweep` cron orthogonality documented (Decision-anchor #7).
- [ADR-132](132-pluggable-martinet.SUPERSEDED.md) + [ADR-140](140-cheap-model-first.md) — martinet `runtime: "cursor"` carve-out (D4).
- ADR-151 (unblocker) — first goal-driven role consumer (Out of scope T7 dep).
- [ADR-148](148-commit-cadence-truth-signal.md) — cadence-as-canonical-truth; `/goal` latency informs the new cadence baseline (D6).
- [[feedback_decomp_same_session_with_deps]] — planner-decomp gate honored; T1–T7 filed same-session with populated `deps[]`.


## §Amendment 2026-05-20 — promoted to accepted (status-drift audit T4)

Promoted from `proposed` → `accepted` per [docs/audits/adr-status-drift-audit-2026-05-20.md](../audits/adr-status-drift-audit-2026-05-20.md) (sha=a6f1541). Code-refs + git-log refs both present at audit time confirming shipped + dogfooded status; the `proposed` marker was bookkeeping debt. Original Date preserved verbatim. Append-only — see Status field for the canonical flip; this §Amendment carries the audit traceability.

**Filed via** t-45b401c3 (T4 sweep, 2026-05-20).
