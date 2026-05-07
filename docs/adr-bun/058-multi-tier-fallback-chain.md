# ADR-058: Multi-tier executor fallback chain (Cursor + Kimi + MiniMax) for budget-pause

**Status:** **paused** (2026-05-07 15:41 MYT — driver pause, team stalled mid-T2)
**Date:** 2026-05-07
**Owner:** planner
**Driver-ref:** driver-inbox.md 10:38 MYT 2026-05-07 — "let's do it" sudo-auth granted; build-now (NOT trigger-gated). **Paused 15:41 MYT same day** — driver halt: 5/8 teammates wedged on unsent compose-box text, 1 blocked on Anthropic feedback modal, 2 with skill-invocation errors. Resume gated on (a) team un-stall + re-bootstrap and (b) explicit George re-authorization. T1 (`df3afe8` provision-fallback-user.sh) + T2a (`a15bb80` types + brief composers + path helpers) + T2b (`732f328` createFallbackCage + destroyFallbackCage lifecycle) remain landed and reviewable; **DO NOT advance to T3+ until paused-flag lifted.**
**Release scope:** v1.1.x (post-v1.0.0; aligns with ADR-057 stall-prevention timing)
**Supersedes / extends:** ADR-049 (budget-watcher) + ADR-053 (budget observability) — adds the executor-side of budget-pause beyond per-team kanban-pause

## Context

When all team members hit Claude Max budget (whip's ADR-049 + ADR-053 budget-pause fires), work currently stops dead until 5h/wk window refresh. Budget pressure justifies including lower-tier executors (Cursor → Kimi → MiniMax) in the fallback chain — but Kimi and MiniMax CLIs have shown disturbing git behaviour patterns in prior driver experiments (history rewrites, branch deletes, unauthorised commits).

A PATH-based git shim is insufficient: agents can call `/usr/bin/git` directly, bypassing the wrapper. The threat is not ergonomic (typo a `git push -f`) — it is *adversarial-by-pattern* (model is fine-tuned to "be helpful" and will reach for git ops to clean up its own work). Kernel-enforced isolation via dedicated Linux users + read-only project mount + no git binary in workspace closes the bypass surface entirely.

Driver chat-authorised the full sudo chain at 10:38 MYT: *"let's do it"*. Build-now scope (not gated on a future budget-pause incident) per same chat. Default routing of dependent t-9319a22c (Supergroomer) is re-route to atmux-geoyws bash worker once this lands.

### What this ADR is NOT

- **Not** a re-architecture of supervisor / whip / coordination. Existing primitives (`atmux send / dispatch / claim / done / reply / handoff / pause / resume`) stay; the fallback chain is invoked from the existing budget-pause path, no new coordination model.
- **Not** automatic git-write from Tier 3+. Reconciliation is operator-manual by policy. Tier 1/2 retains mutative-git ownership.
- **Not** container-level isolation. Linux user perms + ACLs sufficient for the threat model (see §D2). Container adds operational complexity for marginal gain (no network isolation needed; no rootfs-escape concern at this trust level).
- **Not** Tier 5+. Chain stops at MiniMax. Future tiers would need their own ADR.

## Decision

### D1 — Fallback chain ladder + per-tier policy table

| Tier | Executor | Model | Linux user | Git access | Write scope | Trust posture |
|------|----------|-------|------------|------------|-------------|---------------|
| 1 | Claude Code | claude-opus-4-7 (xhigh) | operator | Full | Anywhere | Reviewer-gated; auto-push on done |
| 2 | Cursor | composer-2 | operator | Full | Anywhere | Reviewer-gated; same as Tier 1 |
| 3 | Kimi | kimi-cli | `kimi-agent` (dedicated) | **None — no .git in workspace** | **`/home/kimi-agent/cages/<lane>/work/` only** (kernel-enforced) | Operator reviews + reconciles + commits via Tier 1/2 |
| 4 | MiniMax | (CLI when GA) | `minimax-agent` (dedicated) | Same as Tier 3 | Same as Tier 3 | Same as Tier 3 |

**Tier 1 → 2 trust delta:** Composer-2 (Cursor) is fine-tuned for code editing, has shown stable git behaviour in driver e2e (read HANDOFF.md + lane summary in 9s, no rogue commits). Mutative-git stays.

**Tier 2 → 3 trust delta:** Kimi has no Anthropic-grade alignment training around git semantics. Threat is model-pattern, not operator-typo. Kernel isolation eliminates the surface.

### D2 — Isolation strategy: setfacl rX + dedicated user (NOT chroot, NOT container)

**Driver default:** `setfacl -R -m u:<agent>:rX <project-root>` per parent task. Confirmed.

**Considered alternatives:**

| Strategy | Pro | Con | Verdict |
|----------|-----|-----|---------|
| `setfacl rX` + dedicated user (DEFAULT) | precise; per-syscall enforcement; idempotent provision | ACLs survive across rsync / git / tar boundaries — must verify once on each new mount | ✅ chosen |
| Chroot bind-mount | full filesystem isolation | requires root for setup of every cage; bind-mount lifecycle complexity; broken paths in agent's logs | ❌ overkill |
| Container (Docker/podman) | rootfs + network + cgroup isolation | network isolation breaks API egress (Kimi/MiniMax CLIs need outbound); image build/cache layer; daemon dependency | ❌ marginal gain; operational burden |
| PATH-only git shim | zero-privilege | agent calls `/usr/bin/git` directly; no defence | ❌ rejected |
| Read-only bind-mount of project | simple | breaks ACL grain (e.g., `_refs/` must be MORE restricted than `src/`) | ❌ insufficient grain |

**setfacl rX wins because:** (1) the threat surface is "agent attempts git ops or writes outside workspace" — both gated at syscall boundary by user perms, no rootfs escape needed; (2) network egress to Kimi/MiniMax APIs must work — container network isolation would break it; (3) ACL grain matches the asymmetric read policy (project source readable, `.git/credentials` redacted, `_refs/` excluded entirely).

### D3 — Per-spawn cage tmux (Tier 2-4) following ADR-018 pattern

Every Tier 2-4 spawn lives inside a dedicated tmux server: `TMUX_TMPDIR=/tmp/atmux_fallback_<team>_<lane>/...`. Same isolation pattern as ADR-018 cage migration (4-team-per-socket). Reasons:

- Daily-driver tmux blast-radius immune (kill-server in cage cannot touch operator's tmux).
- Tier-specific tmux config (e.g., status-line shows Tier label + cage uid) without polluting operator's `~/.tmux.conf`.
- Reuses existing `atmux-tmux attach` socket-discovery for operator-side review.

### D4 — Brief-generator folded into cage-builder (NOT a separate Task)

Brief composition is tightly coupled to cage identity: the brief embeds the agent's username (kimi-agent vs minimax-agent), the workspace path (`/home/<agent>/cages/<lane>/work/`), and the tier-specific guardrails ("you have full git" vs "no git in your workspace; operator reconciles"). Splitting brief-gen into its own Task introduces an artificial seam — both the brief and the cage know the same tier metadata.

**Decision:** brief-generator lives as exported helpers inside `src/abstractions/fallback-cage.ts` (e.g., `composeTier2Brief()`, `composeTier3Brief()`). One Task ships the cage-builder + the brief composer together. Per-tier templates reference shared blocks (mission, scope guardrails) + diverge on git policy + reconciliation expectations.

### D5 — Reconciliation is operator-manual (no auto-rsync into worktree)

Tier 3+ cages produce file diffs in `/home/<agent>/cages/<lane>/work/`. Reconciliation:

1. `scripts/fallback-reconcile.sh <team> <lane>` runs `diff -rq` between cage workspace and project worktree, prints per-file delta classification (added / modified / deleted).
2. Operator selects which deltas to bring back (interactive prompt OR `--accept <glob>` for scriptability).
3. Selected deltas rsync into operator-owned worktree (operator's UID, group, perms — not agent's).
4. Operator inspects via standard git workflow + commits via Tier 1/2.

**Why operator-manual:** The whole point of Tier 3+ isolation is that the agent's output is not auto-trustworthy. Auto-rsync would re-create the threat surface. Operator inspection is the policy gate.

### D6 — Whip integration: fallback chain wakes from existing budget-pause path

The fallback chain is invoked from `src/core/budget-pause.ts` (or its caller in `src/verbs/whip.ts`) when:

- Budget-pause state-file is active (loaded via `loadBudgetPauseState`).
- Team has `team.json::fallback.enabled === true` (default OFF; opt-in per team).
- A pre-pause snapshot of in-flight Tasks exists (capture on pause-entry).

For each in-flight Task: pick highest-tier executor with available budget (Tier 2 Cursor first; Tier 3 Kimi if Cursor saturated; Tier 4 MiniMax if available). Spawn cage, compose brief, dispatch via existing `atmux send` / pane equivalent. Output captured to `.atmux/<tier>-handoff/<lane>.log`.

On budget-resume: cages torn down, per-lane logs walked, continuity brief composed for original Claude member with summary of fallback work + reconciliation status, pasted via `atmux send <member>`.

**Coordination with ADR-052 Mode B (eternal-improvement):** budget-pause checks BEFORE Mode B kanban-empty check (per ADR-053 §D2 ordering). Fallback chain is a *budget-pause* feature, not a kanban-empty feature — orthogonal to Mode B.

## Consequences

**Adds:**
- `scripts/provision-fallback-user.sh` — idempotent sudo provisioning (lifecycle lane).
- `src/abstractions/fallback-cage.ts` — per-tier cage create/destroy + brief composer (error-class lane).
- `scripts/fallback-reconcile.sh` + `src/core/fallback-resume.ts` — operator-manual reconciliation + resume continuity (state-mutating lane).
- Hook into `src/core/budget-pause.ts` for fallback dispatch (error-class lane).
- `tests/e2e/fallback-cage.test.ts` — Tier 2 spawn + Tier 3 isolation proofs.
- Operator runbook in `docs/RUNBOOK-fallback-chain.md` (docs lane).
- `team.json::fallback` config block (default `{enabled: false}`).

**Changes:**
- `src/core/budget-pause.ts` gains a fallback-dispatch entry point (pure addition; no behavioural change when `fallback.enabled = false`).
- HANDOFF.md gains a "Fallback chain" section.

**Removes:** nothing.

**Breaks:** nothing. Default-OFF config means the existing budget-pause path is unchanged for teams that don't opt in.

**Rollback path:** delete `team.json::fallback.enabled` (or set to false) — existing budget-pause path resumes verbatim. Provisioned Linux users can stay (no harm); cage TMUX_TMPDIRs are ephemeral.

**Out of scope:**
- Tier 5+ (other model CLIs).
- LLM-based git diff review on Tier 3 output (operator manual step per policy).
- Automatic push from Tier 3 work.
- MCP-based fallbacks (e.g. wrapping `minimax-coding-plan-mcp`; future ADR if pursued).
- Container-level isolation (see D2 rationale).
- Bash-side parity in `lib/` (bun-only port per ADR-013 WIP-bash deferral).

## Open questions

1. **Auth-config copy strategy for non-Claude tiers.** Provision script copies `~/.config/<tool>/...` into `/home/<agent>/.config/...` on first run. **Default:** symlink-based with `chown <agent>:<agent>` + `chmod 600`. **Risk:** if operator updates the CLI's auth post-provision, agent's view is stale. **Recommended resolution:** `provision-fallback-user.sh --refresh-auth <agent>` re-syncs; document in runbook. Reversibility: low (config layout change is invisible to teams).

2. **Output-capture path collisions across simultaneous lanes.** `.atmux/<tier>-handoff/<lane>.log` — if two lanes share a tier, append-mode is sufficient. If one lane's fallback runs across multiple cycles (pause → partial-resume → re-pause), do we rotate or append? **Recommended default:** append with cycle-marker headers `=== cycle <epoch> ===`. Reversibility: low.

3. **Should Tier 3+ cage workspaces survive teardown?** Operator might want to inspect a failed cage post-mortem. **Recommended default:** archive to `.atmux/<tier>-handoff/archive/<team>-<lane>-<epoch>/` on destroy; auto-prune at 7d via groom. Reversibility: low.

4. **Reconciliation script: `--accept` glob vs interactive only?** Driver may want CI-runnable `--accept 'src/**'`. **Recommended default:** ship interactive-only in v1; add `--accept <glob>` in v1.1 if asked. Reversibility: low.

5. **`.git/credentials` redaction in Tier 3+ workspace.** rsync excludes `.git/` entirely, but if any submodule's `.git/config` carries a credential helper, ensure exclusion is recursive. **Resolved in D2:** `rsync --exclude='.git' --exclude='.gitmodules-credentials' --exclude='**/credentials*'`. No question; locked.

6. **MiniMax CLI availability gate.** MiniMax CLI is "when available" per parent body. **Recommended:** ship Tier 4 stubs that return `Tier4_NOT_AVAILABLE` until the CLI exists; minimal scaffolding only. Cage builder switches on tier identity; T4 path is `throw new Error("Tier 4 not yet implemented")` with TODO marker. Reversibility: low.

7. **Should the ADR-052 eternal-improvement Mode B path also gain a fallback hook?** Eternal-improvement runs on operator's Claude budget; if that exhausts mid-cycle, Mode B currently terminates. **Recommended default (low-rev):** no — eternal-improvement is opt-in, idle-time work; budget exhaustion is a fine termination signal. Defer to v1.2.x if asked.
