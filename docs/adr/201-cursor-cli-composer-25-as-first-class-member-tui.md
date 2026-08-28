# ADR-201: First-class cursor-cli composer-2.5 member TUI — epic-team members can spawn as cursor instead of Claude, enabling adversarial-LLM-diversity within a team

**Status**: Rejected — driver verdict 2026-05-21 (re-affirming Opus-only stance per memory `feedback_opus_all_for_agile_flow`). Direction: REMOVE cursor in favor of Opus across atmux — not just decline to add at member tier, but unwind cursor at sentinel (ADR-132) + cancel forthcoming jury (ADR-203) cursor path. Reasoning: adversarial-LLM-diversity reframe is overridden by operator preference for Opus consistency across the chain. Follow-up Tasks: (a) supersede ADR-132 with Opus-sentinel equivalent, (b) cancel ADR-203 cursor-jury path before drafting, (c) refresh memory `feedback_opus_all_for_agile_flow` with the 2026-05-21 reaffirmation date.
**Date**: 2026-05-21
**Driver-ref**: 2026-05-21 operator request "first class support for spawning cursor cli composer 2.5 model. right now epic teams spawn claude tuis only" — extends the cursor-CLI integration already shipping for sentinel (ADR-132) + queued for jury (forthcoming ADR-203) to the member-spawn surface.
**Supersedes (in part)**: memory `feedback_opus_all_for_agile_flow` (2026-05-14 "every role in the agile chain runs Opus; cursor-agent OUT of the chain") — the trust posture has shifted with the adversarial-LLM-diversity reframe (operator 2026-05-20 on jury: *"we need llm model diversity, so let's use composer 2.5 fast. adversarial is good."*). Cursor is now permitted in the member tier with explicit opt-in, not blanket-forbidden.
**Cross-refs**: [ADR-132](132-pluggable-martinet.SUPERSEDED.md) (cursor-as-sentinel abstraction — the cursor TUI integration precedent + `src/abstractions/sentinels/cursor.ts` impl), [ADR-136](136-hot-rename-member-labels.md) (per-member id+label+emoji split — same field shape extends with `type`), [ADR-138](138-verified-send-keys.md) (send-keys verification — needs cursor-aware verifiers), [ADR-159](159-gitter-to-committer-rename.md) (member role rename precedent for schema migration shape), [ADR-161](161-default-member-prefix-and-sort-verbs.md) (default-member spawn surface), [ADR-091](091-kanban-driven-auto-merge.md) (epic-team spawn — the verb that this extends), [ADR-199](199-claude-account-pool-for-epic-team-spawning.md) (pool extension for cursor accounts — see D9), forthcoming ADR-203 (`_jury` cursor role — sibling pattern in the cockpit tier).

## Context

atmux spawns Claude TUI panes for every member of every team. The spawn path (`src/verbs/start.ts` + `src/core/boot-claude.ts` + `src/abstractions/spawn.ts`) is implicitly Claude-only — there's no `member.type` field on the roster schema, and the boot helper is named `boot-claude` because nothing else is currently spawnable as a member.

Cursor-CLI is already integrated in atmux **at the cockpit tier**, not the member tier:

- **Sentinel** (ADR-132) runs as `cursor composer-2-fast` in cockpit W3, doing pane-capture + nudge + escalation observation work. `src/abstractions/sentinels/cursor.ts` is the impl; `src/abstractions/sentinel.ts` is the pluggable abstraction.
- **Jury** (forthcoming ADR-203) will run as `cursor composer-2.5-fast` post-test-gate / post-reviewer, judging acceptance-criteria match.

Both of those are **observation/judgment** roles, not code-writing. Member-tier (be-1, fe-1, test-1, etc.) does code-writing — and currently that's Opus-only by stance + by implementation. The 2026-05-14 stance was "every role in the agile chain runs Opus + xhigh; cursor-agent OUT of the chain" (memory `feedback_opus_all_for_agile_flow`).

That stance has shifted. The adversarial-LLM-diversity reframe (operator on jury design 2026-05-20: *"reviewer/planner/members all share Opus blind spots, so a different model as the final gate catches what Claude consistently leaves"*) generalizes naturally to the member tier: **a be-2 running cursor composer-2.5 alongside a be-1 running Claude Opus is a stronger team than two Opus members**, because the two LLMs have different failure patterns and one's blind spot is usually not the other's. The pain point that drove the jury reframe (Claude shipping holes — partial CRUD, missing e2e) is the same pain point that justifies cursor at the member tier.

Today the operator has no way to do this. Per-member CLI choice is hard-coded to Claude at the spawn boundary. The shape of the fix is a `team.members[].type: 'claude' | 'cursor'` field threaded through the spawn pipeline, with cursor-specific bootstrap, send-keys, and account-handling alongside the existing Claude paths.

### What already exists vs what's missing

| Surface | Claude path (today) | Cursor path (today) | Cursor path (this ADR) |
|---|---|---|---|
| Boot helper | `src/core/boot-claude.ts` | absent for members | new `src/core/boot-cursor.ts` (or merge into one polymorphic helper) |
| Spawn abstraction | `src/abstractions/spawn.ts` | sentinel-only via `sentinels/cursor.ts` | extended for member-tier spawning |
| Roster schema | implicit claude on every `team.members[]` | no `type` field | `member.type: 'claude' \| 'cursor'` (default `claude` for back-compat) |
| Send-keys verifier | claude-pane patterns (ADR-138) | sentinel cursor verifier exists | member-cursor verifier extends ADR-138 with cursor TUI patterns |
| Brief reader | `templates/briefs/<role>.md` parsed by claude | same path used by sentinel cursor | same path — briefs are LLM-agnostic markdown |
| Account abstraction | `src/abstractions/claude-account-wrapper.ts` | sentinel uses cursor's own auth | cursor-account-wrapper sibling OR generalized agent-account abstraction |
| Pool config (ADR-199) | `claudeAccountPool[]` cockpit-level | n/a | extended to `agentAccountPool[]` with `type` field — see D9 |
| Permission mode | `--permission-mode auto` (CLAUDE.md cage discipline) | cursor has its own non-interactive mode | cursor's equivalent flag identified + wired |
| Pull-model verbs (`atmux claim`, etc.) | LLM-agnostic — invoked from pane shell | same | same (no change — atmux verbs don't care which LLM is driving the pane) |

The "pull-model verbs" row is the load-bearing observation: **atmux's pull-model is LLM-agnostic at the contract layer**. Workers pull via `atmux claim --next`, send via `atmux send`, commit via the committer role — all shell-level. Whatever drives the pane just needs to read the brief, produce output, and call the atmux verbs. Claude and cursor both do this. The only LLM-specific concern is the *pane bootstrap* (which binary, which auth, which TUI keystroke patterns) — not the work loop.

## Decision

### D1 — `member.type` field on the roster schema

Extend `team.members[]` Zod schema (`src/schema/team.ts`) with a new discriminator:

```ts
members: z.array(z.object({
  id: z.string(),               // unchanged (ADR-136 immutable)
  label: z.string(),            // unchanged (ADR-136 hot-renameable)
  emoji: z.string(),            // unchanged (ADR-136)
  type: z.enum(['claude', 'cursor']).default('claude'),  // NEW
  // type-conditional fields:
  claudeAccount: z.string().optional(),    // required when type=claude
  cursorAccount: z.string().optional(),    // required when type=cursor — see D4
  cursorModel: z.literal('composer-2.5').default('composer-2.5'),  // see D2
  // ... existing fields
}))
```

`type` defaults to `'claude'` for back-compat — existing team.json files round-trip unchanged.

Validation: when `type=cursor`, `cursorAccount` must be populated; when `type=claude`, `claudeAccount` must be populated. Schema-level `.refine()` enforces the type-conditional requirement.

### D2 — Cursor model: composer-2.5 only (member tier)

Member-tier cursor spawns use **composer-2.5** exclusively (the model the operator named in this ADR's request). Other cursor models (composer-2-fast used by sentinel; future composer-3) are not member-tier eligible — the cheaper/faster cursor variants are for observation/judgment roles, not code-writing.

Hardcoded as `cursorModel: z.literal('composer-2.5').default('composer-2.5')` in the schema (D1). Future cursor models for members would need an ADR amendment, not a config flip — keeps the decision surface explicit.

### D3 — Spawn-layer dispatch: polymorphic by `type`

The current spawn path is hardcoded to Claude. Refactor:

- **`src/core/boot-claude.ts`** stays as the Claude-specific bootstrap.
- **New `src/core/boot-cursor.ts`** — cursor-specific bootstrap (binary path, model flag `--model composer-2.5`, env vars including the cursor-account selection from D4, permission-mode equivalent).
- **`src/core/spawn-member.ts` (new dispatcher)** — reads `member.type`, delegates to the right boot helper. The verb-level `start.ts` calls `spawn-member` for each member regardless of type.

Cursor binary path is resolved via `cursor-cli` on PATH first, falling back to the same lookup-chain pattern as the Claude binary. The exact cursor flags (model, non-interactive / permission-mode equivalent, account selection) are encoded in the boot helper — operator-overridable via env (`ATMUX_CURSOR_BIN`, `ATMUX_CURSOR_ARGS_EXTRA`) for future cursor-CLI flag drift.

### D4 — Cursor account handling

Cursor-CLI uses its own auth (separate from Claude OAuth — typically API-key-based or device-flow signin). The new `cursorAccount` field on the member roster identifies which cursor login profile to use.

Operator manages cursor accounts via existing `cursor` CLI commands (signin/signout); atmux references the resulting profile by name. Future ADR may extend `atmux pool` verbs to manage cursor accounts symmetrically with Claude accounts (see D9), but the initial cut keeps cursor-account-management external to atmux.

If `cursorAccount` doesn't resolve to a valid cursor profile, spawn refuses with a structured error (`atmux: member <id> — cursor account '<name>' not signed in; run \`cursor login\` first`) instead of failing at first-call 401 (matches the ADR-199 pattern of pre-spawn account validation).

### D5 — Send-keys verifier: cursor TUI patterns

ADR-138 specifies `safeSendKeysWithVerify` with 6 built-in verifiers tuned to Claude TUI patterns. Cursor TUI has different idle/active glyphs, different scrollback shape, different rate-limit footer. Extend ADR-138's verifier set:

- **`verifyCursorIdle`** — detects cursor-CLI's idle prompt (cursor's equivalent of Claude's `⏵⏵` or readline `> `).
- **`verifyCursorActive`** — detects cursor's "thinking" / generation marker.
- **`verifyCursorPermissionPrompt`** — cursor may have its own permission prompts; detect + auto-accept analogous to claude's `BTab` workaround when applicable.

The send-keys core remains the same: scroll-to-end → Enter×3 → paste → Enter×3 (per memory `feedback_tui_send_keys_canonical_pattern`); only the verifiers change. Verifier selection is `member.type`-conditional in the send call.

Sentinel's existing `src/abstractions/sentinels/cursor.ts` already classifies cursor-pane state for observation purposes; D5 reuses those classifiers in the verifier path (single source of truth for cursor pane patterns).

### D6 — Brief compatibility: LLM-agnostic

`templates/briefs/<role>.md` files are markdown — no LLM-specific tokens, no Claude-only system prompts. Cursor reads the same brief files. No new templates required; no per-LLM forking of the brief tree.

If a brief needs to call out LLM-specific behavior (rare — would only happen for atmux-verb-level differences that arise from cursor TUI quirks discovered post-ship), the brief uses a `## When you are <type>` conditional section. Default: no conditional, single shared brief.

### D7 — Mixed-LLM epic-team is supported (and is the point)

An epic-team's roster can mix types:

```jsonc
// .atmux/team.json
{
  "members": [
    { "id": "be-1", "type": "claude", "claudeAccount": "c-u" },
    { "id": "be-2", "type": "cursor", "cursorAccount": "main" },
    { "id": "fe-1", "type": "claude", "claudeAccount": "c-ic" },
    { "id": "fe-2", "type": "cursor", "cursorAccount": "main" },
    { "id": "test-1", "type": "claude", "claudeAccount": "c-u" }
  ]
}
```

This is the configuration shape that delivers adversarial-LLM-diversity per task — be-1 and be-2 claim sibling tasks; their work is independently reviewed; holes one LLM consistently leaves are caught when the other LLM does the sibling.

`atmux team spawn-epic <eid>` accepts a new optional flag:

- `--cursor <count>` / `--claude <count>` — populate the epic-team roster with the given mix (e.g. `--claude 2 --cursor 2` for a 4-member team with 2 of each).
- Default (no flag) — falls back to the cockpit-level default mix at `~/.atmux/cockpit.json::epicSpawnDefaults::typeMix` (operator-configured; defaults to all-claude for back-compat).
- Explicit per-member type via the brief / planner decomp can override the auto-mix at decomp time.

### D8 — Pull-model + atmux integration: unchanged

The pull-model verbs (`atmux claim`, `atmux send`, `atmux task move`, `atmux flag`, etc.) are shell-level — they don't care which LLM is driving the pane. Cursor-driven members invoke them the same way Claude-driven members do. No verb-side changes required.

The only contract the LLM must honor: read the brief at boot, produce output as conventional commit + diff, call the atmux verbs at the documented surface. Cursor composer-2.5 does this natively (it's a coding-agent CLI by design).

### D9 — Pool extension: agent-account pool (ADR-199 amendment)

ADR-199 introduces `~/.atmux/cockpit.json::claudeAccountPool[]` for Claude accounts. Extending this for cursor:

Option-A — **separate pools**: `claudeAccountPool[]` + `cursorAccountPool[]`, parallel surfaces. Spawn-time picks from the pool matching the member's type.

Option-B — **unified `agentAccountPool[]`**: each entry has `type: 'claude' | 'cursor'`, `account`, `weight`, `enabled`. Spawn-time filters by type.

Lean: **Option-B** — single pool surface keeps the operator-facing `atmux pool` verbs (add/remove/enable/disable/list) symmetric across both LLMs. ADR-199 D1 becomes an amendment with the unified shape; existing `claudeAccountPool[]` field accepted as a deprecated alias for one release (Zod transform shim).

Pool-selector (ADR-199 D2) filters by `member.type` before applying the least-loaded-by-budget logic. For cursor entries, "budget" maps to the cursor-CLI's own rate-limit / usage signal (cursor exposes this via its own CLI commands; pool-selector caches it analogously to the Claude budget probe).

### D10 — Hot-rename + type-flip via existing verbs

ADR-136 hot-rename verb (`atmux member rename`) operates on `label` + `emoji` without touching `id`. Extending to support `type` flip is non-trivial because flipping `claude → cursor` mid-flight requires:

- Killing the current pane (Claude TUI).
- Re-spawning the pane with the cursor boot path.
- Brief + claimed task carry over.

This ADR specifies the hot-flip path as a new verb `atmux member retype <id> --to cursor` (driver-scope only, per ADR-033 + ADR-199 D5 precedent). Member's currently-claimed task remains claimed; pane respawns; new LLM reads the brief + resumes. Send-keys verifier auto-switches per `member.type`.

Rollback path is symmetric: `atmux member retype <id> --to claude`.

## Consequences

**Becomes easier:**

- Adversarial-LLM-diversity at the member tier — operator can configure 2-claude + 2-cursor epic-teams without manual per-pane setup.
- Onboarding cursor users: existing cursor signins are referenced directly; no new auth dance.
- Mixed-LLM A/B observation: same Story claimed by sibling members of different types surfaces LLM-specific blind spots in PR diffs.
- Cost diversification: cursor pricing model is different from Claude's 5h/weekly windows; mixing reduces single-account-pool exhaustion risk (ADR-199 D3 refuse-on-exhaustion fires less often when the pool spans two LLMs).
- Cursor-as-sentinel + cursor-as-jury + cursor-as-member share a single abstraction surface; future cursor-CLI flag/auth drift fixes apply to all three tiers in one commit.

**Becomes harder:**

- Test surface doubles for any LLM-specific path — both Claude and cursor TUI patterns need fixture coverage in send-keys verifiers, spawn helpers, send-keys idempotency.
- Brief discipline tightens — any brief that drifts toward Claude-specific phrasing degrades cursor-driven member work silently. Reviewer flag-class: "brief assumes Claude reader."
- Schema migration — existing team.json files (no `type` field) need the `.default('claude')` to round-trip, but every fresh team.json gen needs to write the field explicitly so future schema-version checks aren't fooled by "absent means claude."
- Operator mental model: per-member type is one more axis of team config to track.

**Risks + mitigations:**

- **Risk**: Cursor composer-2.5 produces output that doesn't match the conventional-commit + diff shape atmux verbs expect, blocking the pull-model loop. **Mitigation**: smoke-test a cursor-driven epic-team end-to-end on a non-production Story before promoting the feature beyond `proposed`. Brief includes explicit format requirements; cursor-driven member's first commit is verified against the format-gate by reviewer.
- **Risk**: Cursor-CLI flag drift (cursor changes `--model` syntax in a future release) breaks the spawn path silently. **Mitigation**: smoke-test step in the install wizard (ADR-200 D6's Honker verification has a sibling here — cursor-binary version-pin probe). Spawn refuses if cursor-CLI version is outside the supported window.
- **Risk**: Cursor's permission-mode equivalent doesn't exist or behaves differently, causing every tool call to halt the pane. **Mitigation**: spike step before impl-EPIC — confirm cursor's non-interactive mode + auto-accept semantics; encode findings in `boot-cursor.ts`. If cursor doesn't support a clean equivalent, ADR amendment carves out the workaround pattern (e.g. configured tool allowlist instead of permission-mode auto).
- **Risk**: Mixed-LLM teams produce inconsistent commit cadence (cursor faster on small tasks, claude faster on large) — velocity-gate (per [[project_cheap_model_first_adr_140]]) misclassifies. **Mitigation**: velocity-gate becomes `member.type`-aware in a follow-up; until then, mixed-LLM teams may show false-positive stall flags. Acceptable trade-off given the gate is a hint, not a block.
- **Risk**: Memory `feedback_opus_all_for_agile_flow` (2026-05-14 distrust stance) reflects a concern that hasn't fully gone away — cursor may still ship more holes than Claude on some task classes. **Mitigation**: ADR is opt-in, not opt-out — default remains `type=claude`. Operator chooses cursor per member, not by fleet default. If cursor-driven members underperform on observed Story metrics, individual `retype --to claude` rollback exists per D10.

## Out of scope (deferred)

- **Other cursor models for members** — composer-2.5 only per D2. Future model adoption requires ADR amendment, not config flip.
- **Other LLM CLIs (kimi, minimax, etc.)** — claude + cursor only per the current pluggable abstraction. Per memory `project_martinet_pattern`, MiniMax + Kimi were dropped at the sentinel tier 2026-05-14; same exclusion stands for the member tier.
- **Per-task LLM routing** (e.g. "this Task is BE-heavy, prefer cursor") — routing is `member.type`-static at spawn time; per-task routing would need a planner-side decision layer, separately ADR'd.
- **Cursor-account auto-provisioning** — atmux references existing cursor signins by name; doesn't sign users into cursor. ADR-200 install wizard may add a "cursor login" prompt step but doesn't take over auth.
- **Cursor-driven sentinel + jury staying at composer-2-fast / composer-2.5-fast** — different model selection for different tier roles is intentional. The fast variants are cheaper and tuned for observation/judgment; member tier needs composer-2.5 for code-writing throughput + quality.
- **Hot-flip while pane is mid-turn** — `atmux member retype` requires the current task to be in a quiescent state (claimed but not currently generating). Mid-generation flip is out of scope.

## References

- ADR-132 — pluggable sentinel (cursor TUI integration precedent + `src/abstractions/sentinels/cursor.ts` impl)
- ADR-136 — hot-rename member labels (schema-shape precedent for `type` field addition)
- ADR-138 — verified send-keys (verifier extension for cursor TUI patterns)
- ADR-159 — gitter → committer rename (schema-migration shape precedent)
- ADR-161 — default-member prefix (spawn-surface precedent)
- ADR-091 — kanban-driven auto-merge / epic-team spawn (verb surface this extends)
- ADR-199 — Claude account pool (D9 amendment to unified `agentAccountPool[]`)
- ADR-200 — install wizard (cursor-CLI prereq probe + version-pin in Layer 1)
- ADR-203 (forthcoming) — `_jury` cursor role (sibling cockpit-tier pattern)
- memory `feedback_opus_all_for_agile_flow` — 2026-05-14 stance partially superseded by this ADR
- memory `project_martinet_pattern` / `project_sentinel_rename_adr_158` — sentinel cursor integration precedent + MiniMax/Kimi drop rationale
- memory `feedback_tui_send_keys_canonical_pattern` — send-keys core (verifier-only changes for cursor)
- memory `project_cheap_model_first_adr_140` — diversity-of-models rationale; this ADR's adversarial-diversity argument extends that ADR's cost rationale into the member tier
