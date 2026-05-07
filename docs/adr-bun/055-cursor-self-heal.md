# ADR-055: Cursor self-heal — recipe-driven fixups via cursor-agent

**Status:** proposed
**Date:** 2026-05-07
**Owner:** planner

## Context

Driver-inbox 08:38 MYT 2026-05-07 (Ask 5.2): when whip detects a problem class within a whitelisted recipe set, spawn `cursor-agent` (CLI at `/root/.local/bin/cursor-agent` v2026.05.05) headless with a tightly-scoped prompt + file allowlist. Cursor's billing is independent from Claude Max — fixing problems via Cursor doesn't deplete the same budget pool that's at risk in budget-pause scenarios.

Initial driver-proposed recipes:

- `fix:team-json-schema-drift` — restore missing optional fields to documented defaults.
- `fix:cron-pollution` — scrub stale cron entries (converge with ADR-051's `cron_install`).
- `fix:supervisor-missing` — re-spawn supervisor window if `tmux list-windows` shows it absent.

**Hard guardrails per driver brief:**

- Cursor invocations scoped to `.atmux/` and `team.json` only. NOT `lib/` or `bin/`.
- All cursor patches go through `git diff` reviewer-member review before commit. NO autonomous commit-and-push.
- Per-recipe budget cap (default 5k tokens) — abort if exceeded.
- Cursor session log written to `.atmux/logs/cursor-self-heal-<recipe>-<ts>.log`.
- Discord pings at start + result.

## Push-back / scope decisions

### Validation of 3-recipe starting set

Driver asked: "are 3 recipes the right starting set?" Recommended verdict: **yes for v1**, with 3 additional candidates documented but not enabled by default:

**v1 (default-enabled, in code):**
1. `fix:team-json-schema-drift` — drift report from ADR-054 → cursor restores defaults. Highest-leverage; low-risk (schema-bounded edits).
2. `fix:cron-pollution` — orphan/stale entries detected by ADR-051's `cron_install` invariants → cursor prunes. Medium-risk (mistakes affect cron, but cron is already managed by atmux start/stop).
3. `fix:supervisor-missing` — `tmux list-windows` shows supervisor absent → cursor re-spawns via `atmux start` re-run. Low-risk (existing verb, just re-invocation).

**Future candidates (documented in ADR-055 open-questions; require ADR-056-style follow-up to enable):**
4. `fix:lock-stale` — `.atmux/state/*.lock` files held >1h with no live PID → cursor releases. Risk: race with active flock; requires liveness check.
5. `fix:archive-bloat` — `.atmux/archive/` size > 100MB → cursor invokes `atmux groom --aggressive`. Risk: data loss if archive policy is wrong.
6. `fix:phantom-inbox-residual` — ledger entries with no kanban backing → cursor prunes. Already partially handled by whip's phantom-inbox sweep (deferred per ADR-022); cursor-side could fold in.

**Smoke-test path for adding a new recipe (ADR documents the flow):**

1. Author recipe spec in `src/core/cursor-recipes/<recipe>.ts` with: `detect()` predicate, `propose()` returning the cursor prompt + allowlist, `verify()` checking the patch is in-bounds.
2. Land the recipe behind `team.json::whip.selfHealRecipes` opt-in (operator must explicitly enable).
3. Synthetic test in `tests/e2e/cursor-self-heal-<recipe>.test.ts` — seeds the broken state, runs the recipe, asserts patch shape + reviewer-gate path.
4. After 1 week of dogfood with no incidents → flip to default-enabled in a follow-up ADR.

### Anti-pattern guard

ADR explicitly forbids: don't have cursor try to "fix the whole atmux codebase" — recipe-driven scope ONLY. Each recipe is `detect → propose → verify → reviewer-gate`. No open-ended "look for any issues" prompts.

## Decision

### D1 — Recipe interface

```ts
// src/core/cursor-recipes/types.ts
export interface CursorRecipe {
  /** Stable id, e.g. "fix:team-json-schema-drift". */
  id: string;
  /** Cheap predicate run during whip-tick. Returns null when recipe doesn't apply. */
  detect: (ctx: WhipTickContext) => Promise<RecipeContext | null>;
  /** Compose the cursor prompt + file allowlist. Pure function. */
  propose: (ctx: RecipeContext) => Promise<CursorJob>;
  /** Validate cursor's output patch before reviewer-gate. */
  verify: (job: CursorJob, patch: GitPatch) => Promise<VerifyResult>;
  /** Per-recipe token budget cap. Default 5_000. */
  tokenCap: number;
  /** Allowlist file globs cursor may write. Strict — anything else fails verify. */
  fileAllowlist: string[];  // e.g. ["team.json", ".atmux/state/*"]
}

export interface CursorJob {
  prompt: string;
  fileAllowlist: string[];
  tokenCap: number;
}

export interface VerifyResult {
  ok: boolean;
  reasons: string[];     // empty when ok
  patchSummary: string;  // for Discord + reviewer
}
```

### D2 — Whip-tick integration

`src/verbs/whip.ts` per-tick runs the self-heal pass AFTER the main per-member checks (+ AFTER budget-pause check from ADR-053; never invoke cursor during budget-pause). Flow:

```
for each enabled recipe in team.json::whip.selfHealRecipes:
  ctx = await recipe.detect(whipCtx);
  if (ctx === null) continue;

  // Dedup: don't re-fire if same recipe already fired in last 24h
  if (await isRecentSelfHeal(recipe.id, atmuxDir)) continue;

  job = await recipe.propose(ctx);
  fireDiscord("whip-self-heal-attempt", {recipe: recipe.id, ...});

  result = await invokeCursor(job, atmuxDir);
  await writeSelfHealLog(recipe.id, result, atmuxDir);

  verify = await recipe.verify(job, result.patch);
  if (!verify.ok) {
    fireDiscord("whip-self-heal-result", {recipe: recipe.id, ok: false, reasons: verify.reasons});
    await flagsAdd("p2", `cursor self-heal verify failed: ${recipe.id}`);
    continue;
  }

  // Stage patch for reviewer-gate (NOT auto-commit)
  await stagePatchForReviewer(result.patch, atmuxDir);
  fireDiscord("whip-self-heal-result", {recipe: recipe.id, ok: true, patchSummary: verify.patchSummary});
```

`stagePatchForReviewer`: writes the patch to `.atmux/state/cursor-self-heal-pending/<recipe>-<ts>.patch` + creates a kanban Task addressed to `reviewer` member with the patch path in the body. Reviewer reads, applies (or rejects), and commits via existing flow.

`isRecentSelfHeal`: reads `.atmux/state/cursor-self-heal-state.json` → `{"<recipeId>": <last-fire-epoch>}`. 24h dedup window.

### D3 — `invokeCursor` abstraction

```ts
// src/abstractions/cursor.ts
export interface CursorInvokeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  patch: GitPatch;       // computed from cwd's git status post-invocation
  tokensUsed: number;    // parsed from cursor-agent's --json output
  durationMs: number;
}

export async function invokeCursor(
  job: CursorJob,
  atmuxDir: string,
): Promise<CursorInvokeResult>;
```

Invocation:

```bash
cursor-agent --print --model composer-2 --force \
  --max-tokens "$TOKEN_CAP" \
  --output-json \
  --cwd "$PROJECT_CWD" \
  < "$PROMPT_FILE"
```

Spawn via `src/abstractions/spawn.ts` (already exists). Capture stdout (cursor's --json output), parse for token count + tool-use record. Compute patch via `git diff --cached + git status -s` post-invocation. NO `git add -A` from cursor's side; allowlist enforcement via reading the diff file paths and ensuring all match `job.fileAllowlist` globs (strict — any mismatch fails verify).

**Cursor session log** at `.atmux/logs/cursor-self-heal-<recipeId>-<unix-ts>.log` — append the prompt + cursor's stdout + the resulting patch in a single file for postmortem.

### D4 — Three v1 recipes

**`fix:team-json-schema-drift`** (`src/core/cursor-recipes/fix-team-json-schema-drift.ts`):

- `detect`: read latest drift report from `.atmux/state/whip-config-drift-state.json` (per ADR-054). If most-recent drift is < 1h old AND not yet self-healed: emit recipe context with the drift's `issues` list.
- `propose`: prompt cursor to: "Edit `team.json`. Apply Zod schema defaults from `src/schema/team.ts::TeamWhip` for the following missing/invalid fields: <issues>. Do NOT add new keys. Do NOT modify members[]. Output the updated team.json verbatim." File allowlist: `["team.json"]`. Token cap 5k.
- `verify`: re-parse the patched team.json with `Team.safeParse`. Patch verifies iff `success: true` AND no key beyond the issues' paths was modified.

**`fix:cron-pollution`** (`src/core/cursor-recipes/fix-cron-pollution.ts`):

- `detect`: shell out `crontab -l`. If the team's `# >>> atmux:team=<n>` block is malformed (mismatched start/end markers, duplicates, lines outside the block referencing this team's project path) → emit recipe context with the malformed block snippet.
- `propose`: prompt cursor to: "Replace the malformed atmux team=<n> cron block with a clean version. The clean version is exactly: <canonical-block>. Do NOT touch lines outside the markers. Do NOT touch other team blocks." File allowlist: `[]` (cron is not a file in CWD; recipe writes to a temp file + rewires via `atmux team reconfigure --cron-only`). Token cap 5k.
- `verify`: re-shell `crontab -l`; check block exists, is well-formed, matches canonical shape.

**`fix:supervisor-missing`** (`src/core/cursor-recipes/fix-supervisor-missing.ts`):

- `detect`: `tmux list-windows -t <session>` filter for the supervisor window name. If absent → emit recipe context.
- `propose`: prompt cursor to: "Run `atmux start --re-supervisor-only`." File allowlist: `[]`. Token cap 1k (just an invocation; cursor doesn't write code).
- `verify`: re-list windows; check supervisor window now exists.

(Note: `--re-supervisor-only` is a hypothetical flag; if it doesn't exist, the recipe instead invokes `atmux team rotate-lead` or similar existing primitive that respawns the missing window. Recipe author verifies during impl.)

### D5 — Discord templates

Add to `DiscordEventType` union in `src/abstractions/discord.ts`:

```ts
| "whip-self-heal-attempt"
| "whip-self-heal-result"
```

Templates:

```
🔧 [whip-self-heal-attempt] · `<team>` · HH:MM MYT
  • 🛠️ recipe: fix:team-json-schema-drift
  • 📍 reason: 3 invalid keys detected
  • 💰 token cap: 5k

🔧 [whip-self-heal-result] · `<team>` · HH:MM MYT
  • ✅ recipe: fix:team-json-schema-drift — patch staged
  • 💰 tokens used: 1.2k of 5k cap
  • 📜 patch: 3 keys updated; pending reviewer
  • 📍 see: .atmux/logs/cursor-self-heal-fix-team-json-schema-drift-1778120000.log
```

Failure variant:

```
🔧 [whip-self-heal-result] · `<team>` · HH:MM MYT
  • ❌ recipe: fix:supervisor-missing — verify failed
  • 🛑 reasons: tmux list-windows still shows supervisor absent
  • 📍 see: .atmux/logs/cursor-self-heal-fix-supervisor-missing-1778120000.log
  • 🚩 flag: p2 raised — operator triage needed
```

### D6 — Configuration

`team.json::whip.selfHealEnabled` (boolean, default false) gates the entire pass. `team.json::whip.selfHealRecipes` (string array, default `[]`) opts-in specific recipes. Both fields are typed in ADR-054's `TeamWhip` Zod schema.

Per-recipe override of `tokenCap` via `team.json::whip.selfHealTokenCaps: { "fix:team-json-schema-drift": 3000 }`. Optional. If absent, recipe's default applies.

### D7 — Test coverage

Per CLAUDE.md TestingDiscipline:

- `tests/unit/abstractions/cursor.test.ts` — invokeCursor mock-spawn; allowlist enforcement; patch parsing; budget cap abort.
- `tests/unit/core/cursor-recipes/fix-team-json-schema-drift.test.ts` — detect / propose / verify per recipe.
- `tests/unit/core/cursor-recipes/fix-cron-pollution.test.ts` — same.
- `tests/unit/core/cursor-recipes/fix-supervisor-missing.test.ts` — same.
- `tests/unit/verbs/whip.test.ts` (extend) — self-heal pass orchestration; dedup; budget-pause skip.
- `tests/unit/state/cursor-self-heal-state.test.ts` — dedup state.
- `tests/e2e/cursor-self-heal-team-json.test.ts` — synthetic broken team.json → recipe fires → patch staged → reviewer applies → next tick clean.

## Consequences

- **Operator triage burden drops for the three v1 recipe classes.** Drift, cron pollution, missing supervisor become auto-detected + auto-proposed-fix with operator only doing the final commit.
- **Cursor billing path opens up.** First atmux feature using non-Claude executor — establishes pattern for future Cursor-tier work.
- **No autonomous commits.** Reviewer-gate stays in the loop; matches CLAUDE.md "no autoworking" rule.
- **Per-recipe risk isolation.** Each recipe has its own allowlist + budget cap + verify step. A bug in one recipe doesn't enable cursor to touch unrelated files.
- **Discord noise increase.** Each fired recipe = 2 pings (attempt + result). Dedup'd 24h per recipe. Estimate: 0–3 self-heal events per team per day under normal operation; not noisy.
- **Cursor unavailability is graceful.** If `cursor-agent` binary is missing or returns non-zero, recipe fails verify; flag is raised; no crash.

## Considered alternatives

### A. Use Claude (not Cursor) for self-heal recipes

Discarded — defeats the budget-isolation point. The whole reason Cursor is the executor: when whip is in budget-pressure (e.g., budget-pause active), Claude is the wrong tool. Cursor's billing is orthogonal.

### B. Allow `lib/` + `bin/` edits with strict diff review

Discarded — driver explicitly forbade. `.atmux/` + `team.json` only. If a recipe needs to modify code, it's a different feature (not self-heal); needs a separate ADR.

### C. Auto-apply patches without reviewer gate when verify is high-confidence

Discarded — too risky. Reviewer gate is the safety net; high-confidence verify is what gets the recipe ENABLED, but the gate stays.

### D. Five recipes in v1 instead of three

Discarded — documented the 3 future candidates (lock-stale, archive-bloat, phantom-inbox-residual) but kept v1 to 3 to limit blast radius. Add via the documented smoke-test path in §"Push-back / scope decisions".

## Open questions

### OQ-1 — Cursor model selection (low reversibility)

`composer-2` is the current Cursor default. If Cursor releases a smaller/cheaper model better-suited for these constrained recipes, swap via `team.json::whip.selfHealCursorModel`. Document the field; default `composer-2`.

### OQ-2 — Should the first cursor-agent install verification be in `atmux doctor`? (low reversibility)

Recommended yes — `doctor` should warn if `selfHealEnabled: true` but `cursor-agent` not in PATH. Trivial 5-LOC add.

### OQ-3 — Recipe ordering — alphabetic vs priority-tagged? (low reversibility)

Recommended alphabetic for v1. If multi-recipe contention emerges, add priority field to `CursorRecipe` interface. Trivial flip.

### OQ-4 — Reviewer-gate dispatch — direct kanban Task vs flag? (low reversibility)

Recommended kanban Task addressed to `reviewer` member (matches existing dispatch pattern; reviewer claims via `atmux claim --next`). Flag would require a new flag-resolution UX. Trivial flip if reviewer cadence demands different surfacing.

### OQ-5 — Cursor session log retention (low reversibility)

`.atmux/logs/cursor-self-heal-*.log` files accumulate over time. Recommended: groom-side cleans entries > 30 days. Out of scope for this ADR; surface to groom-area follow-up.

### OQ-6 — Per-recipe enable/disable cadence (low reversibility)

If a recipe causes a bad outcome once, operator wants to disable just that one. `team.json::whip.selfHealRecipes` allows this (drop the recipe id from the array). Doctor surfaces the disabled-recipe state on diff. Trivial.

## Termination signals

`proposed → accepted` flip is gated on:

- 3 v1 recipes implemented + unit-tested + e2e-tested.
- Reviewer-gate per commit.
- One synthetic real-fire on a test team showing detect → propose → verify → patch-stage → reviewer-applies → next-tick-clean.
- ADR-054 (Zod whip-config) lands first so the recipe ids + tokenCap config are typed.
