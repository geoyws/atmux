# ADR-050: Multi-tier executor fallback chain — Tier 2 Cursor v1, Tier 3+ deferred

**Status**: Accepted (2026-05-15, operator-batch-flip)
**Date**: 2026-05-14

## Context

`atmux whip` enforces historical decision number 049 (no surviving ADR file) budget-pause when the team's Claude Max account hits its 5h or weekly rate-limit window. Pause halts every member; work resumes only when the window refreshes (5min–7days latency). Driver feedback (multiple sessions, 2026-04 onward) — losing 4–8h to a single budget event is the dominant failure mode of long-running teams.

The natural mitigation is a **multi-tier executor fallback chain**: when Tier 1 (Claude Opus) is rate-limited, spawn lower-tier executors (Cursor, Kimi, MiniMax) into per-pane cages and let them carry the lane until the budget window reopens. Parent task `t-706655ee` drafts the full chain (4 tiers, dedicated Linux users, ACL-isolated workspaces, manual reconciliation).

The full chain is week-scale work. Multiple constraints push for a smaller v1:

- **Operator trust** ([[feedback_opus_all_for_agile_flow]]): the operator's standing position is *"every role in the agile chain runs Opus 4.7+xhigh; cursor-agent OUT of agile chain — i don't trust other LLMs"*. That bias is about **agile flow** (planning, decomposition, code authorship). The **fallback chain is recovery-only** — it fires only when Tier 1 is blocked, lives until the budget window reopens, and submits work for reviewer-gated reconciliation before merge. Different threat model, but the operator's distrust still warrants a narrow v1 + explicit override path.
- **Tier 3+ git behavior** (parent task): Kimi and MiniMax have shipped history rewrites, branch deletes, unauthorized commits in prior driver sessions. Mitigation requires OS-level isolation — dedicated Linux user, ACL-restricted workspace, no `git` binary in cage. Provisioning is sudo-bound; this is **operator-only** work, NOT member-claimable.
- **Cursor's mutative-git path is e2e-validated** (parent task §E2E proofs): `cursor-agent --print --model composer-2 --force` inside a TMUX_TMPDIR cage produced a clean per-lane summary in 9s. Tier 2 cage path is well-trodden.
- **Sequencing cost**: Tier 3+ requires the provisioning script AND a reconciliation pipeline before any e2e can fire. Tier 2 only needs cage + brief generator + resume continuity. Time-to-first-fallback is ~4× shorter for Tier 2-only scope.

Convergence: ship **Tier 2 Cursor v1**, defer Tier 3+ to a future ADR fold-in once Tier 2 is observed in production for ≥2 sustained-pause cycles and the operator authorizes wider tier inclusion.

## Decision

### Tier ordering (v1 scope locked)

| Tier | Executor | Model | Linux user | Git access | v1 scope |
|---|---|---|---|---|---|
| 1 | Claude Code | claude-opus-4-7 (xhigh) | operator | Full | **In scope** — default path |
| 2 | Cursor | composer-2 | operator | Full | **In scope** — fallback target |
| 3 | Kimi | kimi-cli | `kimi-agent` (dedicated) | None | **DEFERRED to future ADR-050b fold-in** |
| 4 | MiniMax | (CLI when available) | `minimax-agent` (dedicated) | None | **DEFERRED to future ADR-050b fold-in** |

Tier 2 runs as the operator user (no sudo, no ACL setup). Tier 2 has full git access; commits land directly to the member's branch, subject to the same reviewer-gate as Tier 1 work. No reconciliation pipeline needed for Tier 2.

### Trigger semantics

Fallback fires when ALL of the following are true on a sustained budget-pause:

1. `whip` historical decision number 049 (no surviving ADR file) budget-pause has been active continuously for ≥**`team.whip.fallback.sustainMins`** (default **30**). One-off rate-limit blips that resolve <30min do NOT spawn a fallback cage — the pause-resume hot path is cheaper than the fallback round-trip.
2. `team.whip.fallback.enabled === true` (opt-in, default `false` on `atmux init`). Operator opts in per-team.
3. The paused member has at least one Task in `in-progress` claimed-by them; idle members get no fallback.

Failing any: no cage spawn. `whip` logs the suppress reason on each tick.

### Fallback cage spec

Per `team.json::whip.fallback.tier === 2` (only valid value in v1; refuse-at-load otherwise):

- **Cage tmpdir**: `/tmp/atmux-fallback-<team>-<member>/`. Single tmux server, single window, single pane running `cursor-agent --print --model composer-2 --force`. Same isolation pattern as ADR-018 per-team tmux socket.
- **Cwd**: the original member's worktree (full git access; Tier 2 commits directly).
- **No claudeAccount substitution** — Cursor runs against its own auth (`~/.config/cursor-agent/`).
- **One cage per paused member** — single cage per active in-progress Task.

### Brief generator

The cage receives a **fallback brief** composed at spawn time:

1. The member's pre-pause in-progress Task body (read from `state.db` via `atmux task show`)
2. The member's brief template (`templates/briefs/<role>.md`) — same context the original member had
3. Tier-2-specific guardrails inserted at top:
   - "You are a Tier 2 fallback executor running as `cursor-agent`. The original member (`<name>`, model=claude-opus-4-7) is paused on a budget window."
   - "Commit your work to the SAME branch the original member was on. Use the SAME conventional-commit prefix. Reviewer will gate."
   - "When you finish or hit a natural commit boundary, run `atmux reply '[fallback-cursor] <one-line summary>'` and exit cleanly. Do NOT continue past the natural boundary."
   - "If the original member resumes mid-work, your cage will be torn down; commit early + often."
4. Recent `git log --oneline -10` of the branch (read-only context)
5. Recent `.atmux/lead-outbox.md` tail (last 50 lines) for cross-team context

Brief written to `<atmuxDir>/state/fallback-brief-<member>.md`; cage spawn pipes it as the initial prompt to `cursor-agent --print`.

### Output capture

Cage stdout/stderr captured to `<atmuxDir>/logs/fallback-cursor-<member>.log`. Lead reads on budget-resume tick.

### Resume continuity

When the budget window reopens (whip historical decision number 049 (no surviving ADR file) fires resume):

1. For each member with an active fallback cage:
   - Read the cage's output log
   - Compose a **resume continuity brief**: "While you were paused, fallback Tier 2 (Cursor) committed: <commit summaries from git log since cage spawn>. Output log: `<atmuxDir>/logs/fallback-cursor-<member>.log`. Status: <fresh-or-mid-task>."
   - Paste to the original member's pane via `safeSendKeys` (gated on pane state per ADR-127 §2)
2. Tear down fallback cage: `tmux kill-server -L <cage-tmpdir>/sock`; archive log to `<atmuxDir>/logs/fallback-archive/<member>-<epoch>.log`.
3. Resume member continues from natural commit boundary.

### Tier 3+ deferral

ADR-050b (future) will fold in Tier 3 (Kimi) and Tier 4 (MiniMax). Pre-conditions for that ADR:

- ≥2 production sustained-pause cycles observed under ADR-050 v1 (Tier 2 only)
- Operator explicit authorization in a driver-inbox entry citing this ADR
- `scripts/provision-fallback-user.sh` + `lib/fallback-cage-tier3.sh` + `scripts/fallback-reconcile.sh` filed as operator-only (`--driver-only`) Tasks (placeholder filed in this decomp under T6)
- Reviewer audit of OS-isolation gate (useradd + ACL + `setfacl -R -m u:<agent>:rX` + workspace `rsync --exclude=.git`)

## Consequences

**FE/docs lane**: new `docs/RUNBOOK-fallback-chain.md` documents (a) operator opt-in flow, (b) observability via `<atmuxDir>/logs/fallback-cursor-*.log`, (c) override path (`team.whip.fallback.enabled=false` disables; `tier=2` is the only v1 value). Brief templates (`lead.md`, `member.md`) gain a "Fallback executor takeover" section explaining that mid-pause work may show Cursor-authored commits in the branch history.

**BE lane**: three new modules — `src/core/fallback-cage.ts` (Tier 2 cage spawn + teardown), `src/core/fallback-brief.ts` (brief composer), `src/verbs/whip.ts` extension (sustained-pause detection + fallback trigger in §0.4 or new §0.4.5). Resume-continuity composer lives in the whip resume handler.

**DB lane**: no schema change. `team.whip.fallback.{enabled,sustainMins,tier}` are passthrough fields on the existing `WhipConfig` Zod schema (`team.whip` is `.passthrough()`).

**OPS lane**: cage tmpdirs in `/tmp/atmux-fallback-*` — same `/tmp` namespace already used by per-team sockets. Cleanup via existing tmux server teardown on resume. No cron addition (Tier 2 runs synchronously inside the whip tick).

**TEST lane**: e2e test in `tests/e2e/fallback-cursor-cage.test.ts` covering: opt-in gate, sustained-pause threshold, cage spawn + brief composition + cursor-agent invocation, output capture, resume teardown. Unit tests for brief composer + sustained-pause detector.

**REVIEW lane**: this ADR + every sub-task is reviewer-gated. Reviewer enforces same-commit doc-discipline on the new RUNBOOK + brief-template updates.

**What we give up.** Tiers 3+ (Kimi, MiniMax) are NOT available in v1; budget-pause windows >30min still cost lane velocity beyond the Tier 2 ceiling. We pay that cost intentionally to ship v1 in days, not weeks, and to preserve the operator's standing approval gate on non-Opus LLM trust scope.

**Rollback path.** `team.whip.fallback.enabled=false` disables fallback per-team without uninstalling. No state migration. If Cursor proves unreliable, flip the team flag, accept the budget-pause downtime, then file ADR-050c to retire or replace.

## §Acceptance gate — e2e landed (t-7c491368)

`tests/e2e/fallback-cursor-cage.test.ts` walks the v1 narrowed entry-path (`shouldDispatchFallback` + `spawnFallbackCage` + `teardownFallbackCage` + `composeTier2Brief`) per the §Acceptance gate's 7-step shape:

| Step | Asserts | Status |
|---|---|---|
| 1 | Opt-in gate — `enabled=false` → `dispatch=false` reason `'fallback-disabled'`; `enabled=true` + sustain met + tasks present → `dispatch=true` | ✅ |
| 2 | Sustain threshold — pause `< sustainMins` → `'sustain-not-reached'`; `≥` → dispatch; `inProgressTaskCount=0` → `'no-in-progress-tasks'` | ✅ |
| 3 | Cage spawn — `spawnFallbackCage` invokes `createCage` once with the right opts shape (team / lane=member / tier=2 / taskId / atmuxDir / projectCwd) and persists `CageHandle` to `fallback-cages-v1.json` keyed `<team>:<member>`; second spawn for the same key is idempotent (no second `createCage` call) | ✅ |
| 4 | Brief composition — `composeTier2Brief` carries §D4 sections (Tier 2 / Cursor / composer-2 identification + Mission + Scope guardrails + Git policy + Reconciliation + operator-UID full-git posture); `spawnFallbackCage` delivers the brief through `sendBrief` when supplied | ✅ |
| 5 | Output capture — `cageArchivePath(atmuxDir, 2, team, lane, epoch)` resolves under `<atmuxDir>/tier2-handoff/archive/<team>-<lane>-<epoch>` (ADR-050 archive layout supersedes the §Output capture's draft `<atmuxDir>/logs/fallback-cursor-<member>.log` path; cage stdout/stderr land in the archive on teardown) | ✅ |
| 6 | Resume continuity — `composeResumeBrief` produces "while you were paused, fallback committed: <commits>" brief + paste via `safeSendKeys` gated on pane state | ⏭️ **`test.skip` — t-8ec31d4d (composeResumeBrief) not yet shipped** |
| 7 | Idempotent teardown — second `teardownFallbackCage` on the same member is a no-op (no throw, no second `destroyCage` call); cages-file removed when the cages map empties on the delete | ✅ |

**Layering note (ADR-050 ↔ ADR-050)**. ADR-050 v1 was substantially absorbed into ADR-050's multi-tier abstractions (`createFallbackCage` + `composeTier2Brief` + `cageArchivePath` in `src/abstractions/fallback-cage.ts`; multi-tier orchestration `dispatchFallbackOnPause` + `walkFallbackOnResume` in `src/core/whip-budget-fallback.ts`). The ADR-050 v1 narrowed wrappers (`spawnFallbackCage` + `teardownFallbackCage` + `shouldDispatchFallback` + `fallbackCagesPathV1`) sit on top, single-member + Tier-2-only. The sibling `tests/e2e/fallback-cage.test.ts` exercises the ADR-050 multi-tier surface with env-gated real-tmux probes; this spec is the **ADR-050 v1 acceptance gate** verbatim against the v1 wrapper API.

**Step 6 carve-out**. `composeResumeBrief` lives in the unshipped `src/core/fallback-resume.ts` (referenced by `whip-budget-fallback.ts:286` as future work). When t-8ec31d4d lands, drop `.skip` from the Step 6 beat in the spec and wire the import + assertions per the inline TODO checklist in the spec body.

Result: 11 pass / 1 skip / 0 fail. Typecheck green. Single commit per docs-discipline. Reviewer-gated.

## Open questions

Resolved at decompose-time. Override path = driver edits inline in `.atmux/driver-inbox.md` OR replies via Discord to the ADR-050 ping.

1. **OQ1 (HIGH) — Tier 2 Cursor inclusion vs operator's "no non-Opus in agile chain" stance** (per [[feedback_opus_all_for_agile_flow]]).
   **Default**: include Tier 2 Cursor in fallback chain as the v1 scope. The operator memory governs the **agile chain** (planner, lead, members during normal authoring). The **fallback chain is recovery-only**, fires only on sustained budget-pause, and submits work for reviewer-gate before any merge. Different threat model; standing position does NOT veto fallback Tier 2.
   *Override surface*: if the operator confirms the distrust extends to fallback, this ADR retires with no v1 path and the team waits out budget windows.

2. **OQ2 (MEDIUM) — Sustained-pause threshold for fallback trigger**. **Default**: 30min. Rationale: typical 5h-window blips clear in 5-15min; 30min is past the noise floor without burning operator-attention. Tunable via `team.whip.fallback.sustainMins`; reviewer flags if 30min produces too-frequent or too-infrequent fires in production.

3. **OQ3 (MEDIUM) — Fire mode: auto-on-sustained-pause vs explicit operator authorization per pause event**. **Default**: auto-fire on sustained-pause WHEN `team.whip.fallback.enabled === true`. Per-pause authorization would re-introduce the very interrupt that fallback aims to eliminate. The team-level opt-in flag IS the operator's standing authorization.

4. **OQ4 (LOW) — Cursor model selection**. **Default**: `composer-2` per parent-task e2e proof. Tunable via `team.whip.fallback.cursorModel` (passthrough field; default `composer-2`). Future composer versions flip via team.json edit; no ADR change.

5. **OQ5 (LOW) — Output log location**. **Default**: `<atmuxDir>/logs/fallback-cursor-<member>.log`. Archive on resume to `<atmuxDir>/logs/fallback-archive/<member>-<epoch>.log`. Same dir as existing whip logs.

6. **OQ6 (HIGH) — Tier 3+ deferral mechanism: future ADR-050b fold-in vs each tier its own ADR**.
   **Default**: ADR-050b folds in Tiers 3+4 together (Kimi + MiniMax share OS-isolation requirements; one ADR covers both, separate impl Tasks per tier). Defers complexity without scattering policy across multiple ADRs.
   *Override surface*: operator may prefer each tier its own ADR for finer trust gating; cheap to pivot before ADR-050b lands.

## Related

- historical decision number 049 (no surviving ADR file): budget-pause foundation (this ADR depends on)
- ADR-018: per-team tmux socket isolation (fallback cage reuses pattern)
- ADR-024: spawn-account-matching (Tier 2 Cursor uses its own auth, NOT operator's claude-account)
- historical decision number 062 (no surviving ADR file): pane-state classifier (resume brief paste gated on member's pane state === READY)
- [[feedback_opus_all_for_agile_flow]] — operator memory governing agile-chain trust scope; ADR-050 carves out a fallback-chain exception with explicit reasoning
- Parent: `t-706655ee` (multi-tier fallback chain, originally full-chain scope — now narrowed to Tier 2 v1)
- Decompose Task: `t-71629309`
