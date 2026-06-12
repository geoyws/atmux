# ADR-204: `_jury` role + acceptance-criteria contract — adversarial cursor-based gate that ratifies planner ACs pre-work and judges deliverables post-test

> **⚠ SUPERSEDED by [ADR-213](213-retire-jury-reviewer-absorbs-acceptance-criteria.md) — 2026-05-21. Read ADR-213 instead; this file is kept for trace only.**

**Status**: SUPERSEDED 2026-05-21 by [ADR-213](./213-retire-jury-reviewer-absorbs-acceptance-criteria.md) — jury role retires entirely; reviewer absorbs Acceptance-Criteria verification per ADR-213 §D2. AC schema decision (`stories.extra.acceptance_criteria[]` per §D2 of this ADR) PERSISTS via reviewer. ADR-204 §Amendment 2026-05-21 (jury runs Opus not cursor) becomes moot — the role itself retires. ADR-144 §Amendment 2026-05-21 (jury state-machine extension) reverted per ADR-213 §D4. e-5a5110d0 EPIC dissolved 2026-05-21 same session. File preserved for historical lineage; impl-EPIC never ships.
**Date**: 2026-05-21
**Driver-ref**: 2026-05-20 evening operator design session — *"i now want u to create a new _jury as a default member for all atmux teams. this _jury will be using cursor-cli and it will judge the work after the reviewer to see if common sense acceptance criterias are met."* — and *"the planner writes the AC, jury ratifies BEFORE work begins; ping pong 3x → lead."*
**Cross-refs**: [ADR-144](144-epic-team-test-gate.md) (state-machine extension — see ADR-144 §Amendment 2026-05-21 in the same commit set), [ADR-202](202-honker-in-db-messaging-substrate.md) §D5 (substrate wake mechanism), [ADR-203](203-event-topic-taxonomy.md) §D2 (`story.tested` consumer, `story.jury.*` emitter), [ADR-145](145-atmux-adopts-gitter.md) (gitter refuses to merge until `jury-approved`), [ADR-132](132-pluggable-martinet.SUPERSEDED.md) (cursor-as-sentinel — cursor-CLI integration precedent), [ADR-161](161-default-member-prefix-and-sort-verbs.md) (underscore-prefix for default members), [ADR-136](136-hot-rename-member-labels.md) (member id immutability — `_jury` id stays even if label/emoji changes), [ADR-091](091-kanban-driven-auto-merge.md) (epic-team spawn — `_jury` rides on every spawn), [ADR-201](201-cursor-cli-composer-25-as-first-class-member-tui.md) (cursor TUI integration — jury extends to cockpit tier; member-tier uses composer-2.5, jury uses composer-2.5-fast as smaller observation-tier sibling).

## Context

The pain point that motivated this ADR (operator 2026-05-20 evening): *"claude keeps skipping over work that should be done e.g. full CRUD and full e2e.. it's always full of holes."*

Today's review chain has three gates between planner-Task and merged-trunk:

1. **Reviewer** (Opus) — reads the diff, checks code quality, security, doc-update discipline, coverage thresholds. Same model family + similar blind spots as the member that wrote the code.
2. **ADR-144 test-gate** — runs e2e against branch-staging or cage; pass/fail on observed behavior.
3. **Gitter (committer)** — merges to trunk if reviewer + test-gate both green.

Neither reviewer nor test-gate asks the question: *"does this actually meet what was asked?"* Reviewer reads code-against-diff; test-gate verifies tests pass. **Coverage gaps** — the holes that Claude consistently leaves (shipped CRUD missing Update + Delete; happy-path tests but no error-path; UI built without keyboard nav) — slip through because:

- The reviewer reads what's there, not what's missing.
- Tests passing means "the code that was written, works" — not "the right code was written."
- The planner's intent is captured in prose Task bodies that Claude interprets generously toward the easy slice.

The reframe: **a different LLM, judging the diff against an explicit acceptance-criteria contract**, catches what the same-LLM-family reviewer misses. The adversarial-LLM-diversity principle that motivated cursor-as-sentinel (ADR-132) and cursor-as-first-class-member (ADR-201) applies here at the judgment tier: cursor reads the same diff Opus shipped, against criteria Opus's planner wrote, and disagrees where the diff doesn't actually satisfy the criteria.

**The acceptance-criteria contract is the load-bearing piece.** A jury without written AC degenerates into vibes — "this looks incomplete" doesn't give the epic-team anything to fix. A jury with written AC has discrete items to grade: AC #3 says "delete handler with confirmation dialog" — diff has no deleteHandler — fail AC #3 with that specific suggestion.

**Why planner writes the AC and jury ratifies BEFORE work begins:**

- AC is the contract both sides agreed to before the work. No "moving the goalposts" — jury can't invent new criteria post-hoc.
- Planner gets a sanity-check on AC completeness from cursor (a different model) before decomposition — catches "too vague" / "missing edge case" at the cheapest point.
- Epic-team knows what they're being judged on upfront, not after they've shipped.

The 3-strike ping-pong cap exists for both phases (ratify + verdict) because both sides can be wrong: planner writes incomplete AC, or jury is too pedantic, or epic-team can't actually meet a reasonable AC. Lead arbitrates at strike-3; never the driver (per the operator's directive 2026-05-20: *"escalation to the lead. never escalate to driver"*).

## Decision

### D1 — `_jury` as a default member on every team

Every team (parent + epic-team) gains an `_jury` default member at bootstrap. Mirrors the existing `_committer` / `_gitter` underscore-prefix pattern per ADR-161:

```jsonc
// .atmux/team.json — default roster
{
  "members": [
    { "id": "lead", "type": "claude", "label": "lead", "emoji": "🧭" },
    { "id": "planner", "type": "claude", "label": "planner", "emoji": "📋" },
    { "id": "reviewer", "type": "claude", "label": "reviewer", "emoji": "🔍" },
    { "id": "_gitter", "type": "claude", "label": "gitter", "emoji": "🐇" },
    { "id": "_jury", "type": "cursor", "label": "jury", "emoji": "⚖️", "cursorModel": "composer-2.5-fast" },
    // ... member workers ...
  ]
}
```

**`type: "cursor"`** is the load-bearing field per ADR-201 D1 — `_jury` is the first cockpit-tier role that's mandatorily cursor, not claude. **Model: `composer-2.5-fast`** (smaller/cheaper variant than the member-tier `composer-2.5`) because jury work is judgment-against-checklist, not codegen — speed matters more than depth.

Rollout for existing teams: one-shot roster injection on next `atmux start` (matches ADR-159 committer rollout pattern). Teams pre-dating this ADR have `_jury` added; existing rosters round-trip unchanged via Zod schema `.default()` semantics on the member list.

Epic-teams ride on the parent spawn → their own `_jury` inherits cursor-model + emoji from the parent's roster on `spawn-epic`.

### D2 — Acceptance criteria contract at Story-level

AC lives at the **Story** level, not Task or Epic. Story is the granularity that already gates reviewer signoff (per ADR-144 §"reviewer-signoff at story-level on cumulative diff") and test-gate.

Storage: `stories.extra.acceptance_criteria[]` via Zod `.passthrough()` — same pattern as kanban round-trip (memory `reference_kanbantask_passthrough_extra_json`). No schema migration; new field rides on the existing JSON column.

```ts
// src/schema/story.ts (extension)
const AcceptanceCriterion = z.object({
  id: z.string(),                                       // stable per criterion (`ac-01`, `ac-02`, ...)
  text: z.string(),                                     // human-readable criterion
  status: z.enum(["proposed", "ratified", "pass", "fail"]).default("proposed"),
  notes: z.string().optional(),                         // jury's notes per status transition
});

const Story = z.object({
  // ... existing fields ...
  extra: z.object({
    acceptance_criteria: z.array(AcceptanceCriterion).optional(),
    jury_rounds: z.object({
      ratify: z.number().default(0),
      verdict: z.number().default(0),
    }).optional(),
    jury_verdicts: z.array(JuryVerdictEntry).optional(),
  }).passthrough(),
});
```

**AC lifecycle:** `proposed` (planner just wrote it) → `ratified` (jury approved AC pre-work) → `pass` or `fail` (jury verdict post-work). `fail` cycles back to `proposed` on next iteration when planner revises.

**Stable `id`** per criterion enables verdict references like *"AC `ac-03` failed: delete handler missing"* — no free-text grep, no fuzzy match.

### D3 — Two-phase jury verb: `ratify` + `verdict`

```bash
atmux jury ratify <story-id>           # pre-work: judges planner AC completeness
atmux jury verdict <story-id>           # post-work: judges diff against AC
```

Both verbs spawn a cursor-cli composer-2.5-fast TUI in the `_jury` pane, reading the story's current state from `state.db` + the AC list + (for verdict) the most recent diff + test-gate result. Cursor produces structured output (JSON-parsable verdict) which the verb captures into `stories.extra.jury_*` fields.

**`ratify` mode:**

1. Read story body + AC list.
2. Prompt cursor: *"these are the acceptance criteria for this story. evaluate completeness, ambiguity, testability. respond `approve` if AC is complete + testable, or `reject` with structured per-AC feedback."*
3. On approve: set every AC to `status: ratified`; emit `story.jury.ratified` event (per ADR-203 §D2); story state machine transitions ratify-gate to passed (per ADR-144 amendment).
4. On reject: store cursor's per-AC feedback in `notes`; increment `stories.extra.jury_rounds.ratify`; planner is signaled to revise (emit `story.jury.ratify-rejected`); story stays in pre-work state.
5. On `jury_rounds.ratify >= 3`: emit `story.jury.escalated` to lead; verb refuses further `ratify` calls until lead intervenes.

**`verdict` mode:**

1. Read story diff (cumulative across all child tasks) + AC list (must be `ratified`) + test-gate result (must be `pass` per ADR-144 amendment state-machine).
2. Prompt cursor: *"these AC items were ratified before work began. judge the diff + test results against each AC. respond per AC: `pass` (meets), `fail` (missing/incomplete) with structured suggestion. respond overall: `approve` if all pass, `reject` if any fail."*
3. On approve: every AC `status: pass`; emit `story.jury.verdict { verdict: "pass" }`; story transitions to `jury-approved` (per ADR-144 amendment); gitter wakes on the event.
4. On reject: failed AC list `status: fail` + cursor's suggestions in `notes`; emit `story.jury.verdict { verdict: "reject", failed_acs: [...], suggestions: ... }`; increment `stories.extra.jury_rounds.verdict`; story cycles back to `in-progress` for re-work.
5. On `jury_rounds.verdict >= 3`: emit `story.jury.escalated`; verb refuses further `verdict` calls until lead intervenes.

**`stories.extra.jury_verdicts[]`** is an append-only log of every verdict cycle:

```ts
const JuryVerdictEntry = z.object({
  round: z.number(),                                    // 1, 2, 3 (matches jury_rounds.verdict counter)
  commitSha: z.string(),                                // `git rev-parse HEAD` at verdict time
  verdict: z.enum(["pass", "reject"]),
  failed_acs: z.array(z.string()),                      // AC ids that failed this round
  suggestions: z.string(),                              // cursor's structured suggestions
  timestamp: z.number(),                                // epoch seconds
});
```

Operator can `atmux jury history <story-id>` to read the full verdict log; useful for retrospectives + lead arbitration at strike-3.

### D4 — State machine extension (ADR-144 amendment)

Story state machine (from ADR-144) becomes:

```
planning → ready → in-progress → testing → tested
                                         ↘ test-failed → in-progress
tested → jury-pending → jury-approved → merge-ready (gitter)
                     ↘ jury-rejected → in-progress
```

New states added by this ADR:

- **`jury-pending`** — test-gate passed; awaiting jury verdict. Entry: `story.tested` event. Exit: `story.jury.verdict`.
- **`jury-approved`** — jury verdict pass. Gitter consumes via `story.jury.verdict { verdict: "pass" }` and proceeds to merge-ready.
- **`jury-rejected`** — jury verdict reject; story re-enters in-progress for re-work.

**Pre-work AC ratification gate** doesn't get a separate story-state — it's a pre-condition on `planning → ready` transition. Planner can't move story to `ready` (unblocking member claim) until AC is ratified by jury. If `jury_rounds.ratify` is 0 + AC is present + AC status is all `proposed`, the move-to-ready verb auto-fires `atmux jury ratify` first.

**Gitter refusal:** gitter refuses to merge unless story state is `jury-approved`. Same kill-switch shape as test-gate refusal (per ADR-144); operator bypass via `--bypass-jury` driver-scope-only flag, mirrors `--bypass-test-gate`.

ADR-144 gets an inline §Amendment (in this commit set) documenting the new states + the gitter refusal change.

### D5 — Lead escalation surface (3-strike ping-pong)

Strike count is per-story-per-phase:

- `stories.extra.jury_rounds.ratify` increments on every ratify-reject.
- `stories.extra.jury_rounds.verdict` increments on every verdict-reject.

At strike 3 (the 4th call would be the 4th attempt), the verb:

1. Refuses with structured error: *"jury ratify (or verdict) refused — strike 3 of 3. escalating to lead. resolve via `atmux jury arbitrate <story-id>`."*
2. Emits `story.jury.escalated` event (per ADR-203 §D2 sibling, added in ADR-204's contribution to the topic taxonomy).
3. Lead's inbox gets the escalation row (consumer of `story.jury.escalated`).

**Lead arbitration verb**: `atmux jury arbitrate <story-id> [approve|reject|reset]`:

- `approve` — overrides jury, force-transitions story to `jury-approved`. Lead's call; logged in `jury_verdicts[]` with `verdict: "lead-approved"`.
- `reject` — overrides jury in the other direction, force-transitions to `in-progress`. Used when lead agrees AC is unmet.
- `reset` — zeros the ping-pong counter, gives both sides another N attempts. Used when lead thinks the disagreement is resolvable.

**No escalation to driver.** Driver is operator-only; jury disputes don't propagate that far. Lead has rotation power (per `feedback` memory pattern) to swap out a too-pedantic jury or an under-performing epic-team.

### D6 — Epic-team and parent-team jury both exist

Epic-team has its own `_jury` for internal Stories. Parent-team's `_jury` runs **only** at:

- **Planner AC ratification** — parent planner's AC for parent-team Stories.
- **Epic-merge fan-in** — when epic-team finishes its EPIC and gitter (per ADR-091 epic-merge cron-backstop or its event-driven successor) wants to fan-in to parent trunk, parent `_jury` re-checks the EPIC's high-level AC (the contract the parent planner wrote at EPIC-decomposition time).

Epic-team `_jury` does not check parent-team Stories. Parent `_jury` does not check epic-team internal Stories. Single-responsibility per role tier.

The scope clarification matters because epic-teams can be deep (parent → epic-team → grand-epic-team in pathological cases). Each layer's `_jury` only checks the AC at its own layer; cross-layer disputes flow up the lead hierarchy (per the team-of-teams ADR-091 model).

### D7 — Dogfooding: Stage 0 manual jury via `--manual` flag

Bootstrap problem: the very first Story `_jury` ratifies = "implement `atmux jury` verb." But the verb doesn't exist yet to ratify its own AC.

Resolution: substrate EPIC ships a `--manual` flag on `atmux jury ratify` and `atmux jury verdict`:

```bash
atmux jury ratify <story-id> --manual              # operator types the verdict
atmux jury verdict <story-id> --manual --pass --notes "AC #3 manually verified"
```

`--manual` writes the verdict row without spawning cursor. Operator acts as jury for the first 1-2 Stories of the e-honker-jury EPIC. Once Story 3+ passes self-validation against the cursor-driven path, default switches to autonomous (cursor) and `--manual` becomes the emergency-override surface (e.g. cursor down + lead needs to unblock).

Same pattern as sentinel did during ADR-132 dev (manual nudges during dev → autonomous post-handoff). The pattern memory `project_martinet_pattern` documents the precedent.

### D8 — Cursor permissions matrix for `_jury`

Jury runs cursor in read-mostly mode. Permissions tighter than member-tier (which writes code):

- **Allow**: `git log`, `git diff`, `git show`, `git rev-parse`, `cat`, `rg`, `bun test --watch=false`, `atmux` verbs (story show, kanban verbs, internal emit-event).
- **Deny**: `git commit`, `git push`, `git checkout`, `rm -rf`, `bun run build`, any verb that mutates state outside the `stories.extra.jury_*` JSON column.

Jury permissions ship in `templates/cursor-cli-permissions-jury.json` (sibling to the existing member-tier `templates/cursor-cli-permissions.json` from the cursor TUI commit `11c21c3`). Layered: member-tier permissions are the floor; jury narrows from there.

`--force` flag (cursor auto-run) is **off** for jury — judgment work should never run multi-step autonomy chains; one prompt → one structured response → write-and-exit. `ATMUX_CURSOR_FORCE=0` is the jury-specific env override at spawn time.

## Consequences

**Becomes easier:**

- Coverage gaps caught at the gate, not in production. Operator pain (Claude shipping holes) addressed at its source: explicit AC contract + adversarial-LLM judgment.
- Planner discipline improves — knowing the AC will be ratified by a different model forces clearer + more complete acceptance specs.
- Epic-team work has a quality signal beyond reviewer + test-gate. Verdict log per story is a retrospective tool.
- Lead arbitration concentrates disputes at strike-3, not every disagreement. Most ping-pongs (1 or 2 rounds) resolve without lead involvement.
- Stage 0 manual mode is a free bootstrap — no chicken-and-egg blocker for jury's own implementation.

**Becomes harder:**

- Latency added between test-gate and merge — every story has a jury cycle (typically 1 round → ~30s cursor turn). Acceptable trade-off for the coverage win.
- AC discipline is mandatory — planner must write testable AC for every Story. Stories with empty AC auto-fail ratify by jury (per AC schema requiring non-empty `text`).
- Two LLMs in the gate path is more moving parts — cursor outages or rate-limits block merges. Mitigated by `--manual` fallback + lead override + cron-backstop in substrate (jury is event-driven post-substrate but cron-backstop sweeps stale `jury-pending`).
- Default-member rollout adds one pane per team (`_jury` cursor session). Resource overhead is small (cursor TUI is light) but non-zero.

**Risks + mitigations:**

- **Risk**: Jury is too pedantic — rejects ACs that are reasonable. **Mitigation**: lead `arbitrate reset` zeros the counter; lead-rotation of jury (operator manual or future doctor-driven) swaps out misbehaving jury impls.
- **Risk**: Jury rubber-stamps because cursor composer-2.5-fast is too small. **Mitigation**: smoke test in e-honker-jury EPIC validates jury catches synthetic holes (e.g. "AC says delete handler exists; diff has no deleteHandler" — must fail). Failure to catch = model swap or amendment to `composer-2.5` (full-size).
- **Risk**: 3-strike cap fires too often, jamming lead inbox. **Mitigation**: ping-pong counter is per-story; lead arbitrate is cheap (one verb call). If escalation rate exceeds threshold, doctor probe surfaces; lead can `arbitrate reset` in bulk.
- **Risk**: Ping-pong loop where planner revises AC and jury still rejects with same complaint → strike-3 → lead resets → repeat. **Mitigation**: lead `arbitrate reset` requires explicit reason; second reset on same story without code change requires lead-and-driver agreement. Pathological loops surface as a documented anti-pattern in lead's hygiene drain.
- **Risk**: Cursor downtime blocks every team's merge pipeline. **Mitigation**: `--manual` flag + lead override + cron-backstop sweep (after substrate stable, jury can run as event-driven; cron retains as defense-in-depth per ADR-202 §D6).
- **Risk**: AC drift over time — planner's first-ratified AC for a long-running Story becomes stale; what verdict judges is no longer what the EPIC actually needs. **Mitigation**: `atmux jury reratify <story-id>` verb allows planner to amend AC mid-flight; jury re-ratifies (counts against ratify ping-pong cap). Story is rejected on verdict if AC drifted but wasn't re-ratified.

## Out of scope (deferred)

- **AC at Task level** — Story-level only per D2. Task-level AC would 5x the planner-jury overhead; declined.
- **Multi-jury consensus** — single jury per team per story. No multi-jury voting. Lead arbitration is the only override.
- **AI-suggested AC drafts** — planner writes AC by hand. Future ADR may add a "jury suggests initial AC from EPIC body" mode but not v1.
- **Jury for non-Story work** — chores, refactors, hotfixes that lack Story scaffolding bypass jury. Reviewer + test-gate still apply.
- **External AC sources** (e.g. GitHub issue body, Linear ticket) — jury reads `stories.extra.acceptance_criteria[]` only. Integration with issue trackers is out of scope.
- **Per-criterion partial-pass with merge** — verdict is all-or-nothing per Story. Splitting partial pass would require story-decomposition mid-cycle; declined.

## References

- ADR-144 — epic-team test-gate (state-machine extension via §Amendment in the same commit set)
- ADR-202 — Honker substrate (jury wake mechanism)
- ADR-203 — event topic taxonomy (`story.tested` consumer, `story.jury.*` emitter, `story.jury.escalated` for lead)
- ADR-091 — kanban-driven auto-merge (epic-team spawn — `_jury` rides on every spawn)
- ADR-132 — pluggable sentinel (cursor-CLI integration precedent at cockpit tier)
- ADR-145 — atmux adopts gitter (gitter consumer of `story.jury.verdict`)
- ADR-161 — default-member prefix (underscore-prefix for `_jury`)
- ADR-201 — cursor-cli composer-2.5 as first-class member (cursor abstraction)
- memory `project_martinet_pattern` — Stage 0 manual-bootstrap precedent
- memory `reference_kanbantask_passthrough_extra_json` — Zod `.passthrough()` precedent for D2
- memory `project_honker_pubsub_rehaul_design` — full design state (decisions locked)

## §Amendment 2026-05-21 — `_jury` runs Opus, not cursor (per ADR-201 rejection)

Driver rejected ADR-201 on 2026-05-21 with the direction: *"REMOVE cursor in favor of Opus across atmux — not just decline to add at member tier, but unwind cursor at sentinel (ADR-132) + cancel forthcoming jury cursor path."* The adversarial-LLM-diversity reframe that justified cursor for `_jury` in the original ADR §D1 is overridden by the operator's preference for Opus consistency across every tier (member, sentinel, jury). Memory `feedback_opus_all_for_agile_flow` was refreshed with the 2026-05-21 reaffirmation date in the same commit set.

**Changes to the ADR-204 design as originally drafted:**

- **§D1 (default-member roster)** — `_jury` is now `type: "claude"` (not `"cursor"`), `claudeAccount: <pool entry>` (via ADR-199 once that ships), `model: "claude-opus-4-7"`, `CLAUDE_CODE_EFFORT_LEVEL=xhigh`. Drops the `cursorModel: "composer-2.5-fast"` field.
- **§D7 (Dogfooding Stage 0)** — `--manual` flag still valid; once autonomous, the cursor-cli spawn is replaced by a Claude Opus spawn following the same conventions as every other Opus member-role pane (ADR-094 spawn defaults — `--permission-mode auto`, `CLAUDE_GUARD_AGENT=1`, plugin-dir, etc.).
- **§D8 (Cursor permissions matrix)** — entire section becomes inapplicable. Jury permissions are governed by the existing Claude TUI cage discipline + same tool-allowlist Claude operates under. The `templates/cursor-cli-permissions-jury.json` sibling file is **no longer needed**; the existing `templates/cursor-cli-permissions.json` member-tier file persists for the (now-rejected) ADR-201 path's separate cleanup.

**The rest of ADR-204 stands** — the AC contract (§D2-D3), state-machine extension (§D4 + ADR-144 §Amendment 2026-05-21), ping-pong cap + lead escalation (§D5), epic-team + parent jury scoping (§D6) are LLM-agnostic. The cursor-versus-Opus choice is purely a spawn-layer detail; the acceptance-criteria judgment contract is unchanged.

**Adversarial-LLM-diversity is preserved differently** — the value of a different judgment perspective is still present, but it now lives in the **role separation** (planner writes AC; jury judges; reviewer signs off; gitter merges) rather than in the **model separation** (Opus + cursor). Opus run with `xhigh` effort on a different role + a different prompt + a different role-brief is the operator's stated equivalent.

**Reviewer surface (sibling to ADR-201's rejection follow-ups):** if a `_jury` member or epic-team's `_jury` is spawned as `type: "cursor"` in any team.json, file `atmux flag add --severity high --subject "[jury] cursor-typed _jury violates ADR-204 §Amendment 2026-05-21 — must be type: claude"`.

**Filed via** same commit set as memory `feedback_opus_all_for_agile_flow` refresh + ADR-207 (Opus-sentinel supersession of ADR-132).
