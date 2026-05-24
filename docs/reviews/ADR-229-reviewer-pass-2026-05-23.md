# ADR-229 reviewer-pass — orchd auto-push subscriber (Phase 6) + 7 safety gates

**Reviewer**: be-1 (BE lane, epic-team e-a946af69)
**Task**: t-2-944dfc1c — `[e-0da3845c Phase 6] ADR-229 auto-push semantics + safety gates — write + reviewer-pass`
**Date**: 2026-05-23
**ADR under review**: `docs/adr/229-orchd-auto-push-and-safety-gates.md` (Status: proposed)
**Prior reviewer pass**: committer §Amendment 2026-05-23 (BLOCKER + 3 flags + 2 nits, all absorbed inline — see ADR §Amendment block).

## Verdict

**CONDITIONAL SIGN-OFF** — ADR-229 covers the canonical 7-gate roster, the CLAUDE.md push-policy intersection is honored via `isPushAllowed` reuse, all six committer-amendment items are reflected in the body, and the topic taxonomy + ADR-227 §D1 amendment plumbing is internally consistent. **Two minor §Amendments remain before planner flips Status: accepted** — both single-edit fixes (no design rework, no module-impl ripple):

1. **FIRE-ORDER PARITY FIX** — `7` (in-memory cooldown lookup) is cheaper than `3a` (subprocess `git status --porcelain`); the §D2 fire order should swap them so cheapest-first is internally consistent. Same class as committer FLAG-3.
2. **GREP ENFORCEMENT GAP** — §D2.1 item #1's regex list omits `--no-verify`. Global CLAUDE.md §"Hooks, Commits, Tooling" forbids hook-bypass universally; orchd-push.ts as a write-path push must not silently skip the pre-push hook chain. Add `--no-verify` to the disallowed-flag regex.

Both are documented inline below with the exact patch. Planner can fold them into the same single-line edit that flips Status: proposed → accepted.

## Reviewer DoD checklist (per t-2-944dfc1c body)

### 1. 7-safety-gate set exhaustive — ✅ PASS (with one nit, see FLAG-B)

| Gate | Class | Coverage in §D2 |
|---|---|---|
| **§DA-Gate-1** | NEVER force-push / never-mirror / never-tags / never-delete / never-prune | ✅ Prose at line 88 + grep enforcement §D2.1 #1 |
| **§DA-Gate-2** | Staging/main/master/production refuse via `isPushAllowed` | ✅ Prose at line 90 + ADR-028 cross-ref + §DA8 anchor + §D2.1 #2 no-inline-regex + §D2.1 #3-4 regression test cells |
| **§DA-Gate-3** | Pre-flight cleanliness (working-tree / tsc / remote-ahead) | ✅ 3-subcheck split at lines 96-101 with cost-tiered fire order |
| **§DA-Gate-4** | Opt-in `team.json::autoPush.enabled` default-false | ✅ Prose at lines 103-111 + canonical name `autoPush.typecheckCmd` (post-FLAG-2 fix) |
| **§DA-Gate-5** | Kill-switch `ATMUX_AUTOPUSH_OFF` | ✅ Prose at line 113 + precedence-over-Gate-4 codified |
| **§DA-Gate-6** | Audit trail `.atmux/logs/orchd-push.jsonl` | ✅ Prose + 4-sample JSONL block + sibling-extension alignment (post-NIT-2 fix) |
| **§DA-Gate-7** | Cooldown (30s in-memory per-base per-daemon) | ✅ Prose at line 124 + cooldownSec config field + reason text |

**Missing-class scan** (covered by §D2.1 #1 grep + ADR scope):

| Candidate class | Coverage |
|---|---|
| `git push --force` / `--force-with-lease` | ✅ Gate-1 prose + grep enforcement |
| `git push --mirror` / `--all` | ✅ Grep enforcement |
| `git push --tags` (tag-push) | ✅ Grep enforcement (`--tags` in regex) |
| `git push --delete` (branch-delete) | ✅ Grep enforcement (`--delete` in regex) |
| `git push --prune` | ✅ Grep enforcement |
| `git push --no-verify` (hook-bypass) | ❌ **NOT in grep enforcement — see FLAG-B** |
| `git push <wrong-remote>` | ✅ §OQ3 scopes to `origin` only |
| `git push --recurse-submodules=on-demand` | ⚪ Out of scope (not a mutation gate concern; submodule pushes are an independent surface — defer to v2) |
| Stale-ref / behind-remote | ✅ Gate-1 + Gate-3c defense-in-depth |
| Submodule-only commits without parent update | ⚪ Out of scope (orthogonal to fan-in surface) |

**Verdict**: gate-roster is exhaustive for the v1 charter. The one observed gap is `--no-verify` — see FLAG-B below.

### 2. Gate ordering fail-fast + cheapest-first — ⚠️ MINOR FLAG (see FLAG-A)

Stated fire-order at §D2 line 73-84:

```
5 (env read)
  → 4 (team.json read)
    → 2 (string match via isPushAllowed)
      → 3a (working-tree stat via git status --porcelain)
        → 7 (in-memory cooldown lookup)
          → 1 (network: git fetch + rev-list HEAD..origin/<base>)
            → 3b (subprocess: tsc / bun run typecheck — costliest, last)
              → push dispatcher
```

Cost-class analysis:

| Position | Gate | Cost class | Order-correctness |
|---|---|---|---|
| 1st | 5 (env read) | microseconds (in-process env lookup) | ✅ cheapest |
| 2nd | 4 (team.json read) | ~1-3ms (file read + JSON parse) | ✅ cheap |
| 3rd | 2 (`isPushAllowed`) | microseconds (4 regex tests) | ⚠️ technically cheaper than Gate-4 (could swap to 5 → 2 → 4) but acceptable — both <5ms |
| 4th | 3a (`git status --porcelain`) | **~10-100ms (subprocess spawn + fs walk)** | ⚠️ subprocess cost, see below |
| 5th | 7 (cooldown lookup) | microseconds (in-memory Map.get) | ⚠️ **CHEAPER than 3a — should fire BEFORE** |
| 6th | 1 (`git fetch + rev-list`) | ~500ms-3s (network) | ✅ correct (network last before tsc) |
| 7th | 3b (tsc) | ~3-15s (subprocess + type-check) | ✅ correctly last |

**FLAG-A (minor)**: Gate-7 (in-memory) is cheaper than Gate-3a (subprocess), so the cheapest-first ordering should swap them. Corrected order:

```
5 → 4 → 2 → 7 → 3a → 1 → 3b
```

This is the same class as the committer's FLAG-3 fix (which corrected the original §DA-Gate-N numeric ordering against cheapest-first); the swap here finishes that refactor. Cost: one-line edit in §D2 fire-order block.

### 3. ADR-227 §D1 amendment correctly cross-cited — ✅ PASS

- §D1 line 57-65: explicit amendment statement (`Phase 4 trigger: BEFORE epic.merged / AFTER epic.pushed`).
- §DA3 anchor codifies the flip.
- §Amendment NIT-1 (line 228) requires the ADR-227 §Amendment block to explicitly state Phase 4 does NOT fire on `epic.push-blocked` / `epic.push-conflict`.
- Actual ADR-227 edit lives in t-7-29631cdc (todo); ADR-229's forward declaration is sufficient as the §D1 amendment record. ✅ Same-commit landing convention preserved (T_push_module commit includes the ADR-227 amendment per §Amendment NIT-1 fix).

### 4. CLAUDE.md push policy honored — ✅ PASS

CLAUDE.md global push-policy excerpt:
> Non-staging branches → auto-push. `origin/${product}-staging` → **George-manual only**; refuse by default — tracking config isn't a license. Pre-push resolve `@{u}`; target `origin/<product>-staging` → abort + surface. Once authorized: `scripts/push-staging.sh staging`. `geoy.ws` exempt.

Coverage in ADR-229:

| CLAUDE.md clause | ADR-229 coverage |
|---|---|
| "Non-staging branches → auto-push" | ✅ Gate-2 via `isPushAllowed` — non-staging passes the regex |
| "`origin/${product}-staging` → George-manual only; refuse by default" | ✅ Gate-2 STAGING_PATTERNS `/-staging$/` matches `<product>-staging`; refuse + cite `scripts/push-staging.sh` in reason text (line 92) |
| "tracking config isn't a license" | ✅ Refusal happens regardless of `branch.<base>.remote` — Gate-2 is regex-on-name, not tracking-config-derived |
| "scripts/push-staging.sh staging" authorization gate | ✅ Reason text at line 92 cites it; operator's manual path is preserved |
| "`geoy.ws` exempt" | ✅ §Consequences line 180 ("`geoy.ws` carve-out explicit — operator enrolls via allowlist") + `pushPolicy.allowedBases` escape hatch (line 94) |
| ADR-028 main/master/production fleet invariant | ✅ §DA-Gate-2 + §DA8 + §D2.1 #3-4 regression-test cells |

No drift. Reuse of `isPushAllowed` from `src/core/auto-push.ts:47` is the load-bearing primitive choice; the operator-configurable layer is additive (refusedBases) + escape-hatch (allowedBases) on top. ✅

### 5. Opt-in default-false is loud — ✅ PASS

- Schema (§D2 line 106): `enabled: z.boolean().default(false)`.
- Refusal reason (§DA-Gate-4 line 103): `"team.json::autoPush.enabled not set (opt-in only)"`.
- §DA5 anchor: "loud opt-in. No silent auto-push pre-dogfood."
- Consequences line 181: "loud opt-in".
- No silent-enable path. Default schema value is the refusal-by-default; operator MUST set `enabled: true` explicitly per team.

✅ Loud-opt-in invariant intact.

### 6. 3 off-switches independent — ✅ PASS

- **substrate-off**: `ATMUX_HONKER=off` (Gate-0 implicit — substrate kill-switch short-circuits the consumer before any gate runs)
- **cockpit-wide**: `ATMUX_AUTOPUSH_OFF=1` (§DA-Gate-5)
- **per-team**: `team.json::autoPush.enabled=false` (§DA-Gate-4)

§DA6 codifies independence: "each disables Phase 6 independently." Three orthogonal axes; flipping any one disables. No coupling — operator can leave HONKER on while temporarily killing AUTOPUSH cockpit-wide while still letting one team opt-in if they ship a one-off fix. ✅

## Committer amendment verification (per ADR §Amendment 2026-05-23 verifier clause)

Per ADR-229 line 232: `Verifier: t-2-944dfc1c (ADR-229 reviewer-pass) confirms all 6 corrections landed before flipping Status: accepted.`

| Committer item | Landed | Site |
|---|---|---|
| **BLOCKER** — §DA-Gate-2 mandates `isPushAllowed` import | ✅ | Line 90 + §DA8 line 212 |
| **FLAG-1** — ADR-145 primitives-vs-policy enforced via grep + anchor | ✅ | §D2.1 #1 line 130 + §DA8 line 212 |
| **FLAG-2** — `autoPush.typecheckCmd` canonical (NOT `push.typecheckCmd`) | ✅ | Line 103 + Gate-3b prose line 98 cites canonical field |
| **FLAG-3** — Semantic IDs vs fire-order distinction | ✅ | Line 71-84 + §DA9 line 214 |
| **NIT-1** — ADR-227 §Amendment explicit non-fire clause for blocked/conflict | ✅ | Line 228 + carried via t-7-29631cdc |
| **NIT-2** — `.jsonl` extension alignment | ✅ | Line 115 + sibling-cite to ADR-194 + audit-log family consistency |

All 6 verified. ✅

## Findings (this pass)

### FLAG-A (minor — fire-order parity fix)

**Issue**: §D2 fire-order block (lines 73-84) places Gate-3a (subprocess `git status --porcelain`) BEFORE Gate-7 (in-memory cooldown map lookup). Cost-wise this contradicts the §D2 statement "chosen cheapest-first to fail fast without paying network/disk cost on the unhappy path" — Gate-7 is microseconds (in-memory `Map.get`), Gate-3a is ~10-100ms (subprocess fork + filesystem walk).

**Why it matters**: when a 10-Task backlog drains and 3 epics complete in <30s, every cascade burns one `git status` subprocess per cooldown-blocked attempt. Tiny but compounds.

**Patch** (single line edit in §D2 fire-order block):

```diff
 5 (env read)
   → 4 (team.json read)
     → 2 (string match via isPushAllowed)
-      → 3a (working-tree stat via git status --porcelain)
-        → 7 (in-memory cooldown lookup)
+      → 7 (in-memory cooldown lookup)
+        → 3a (working-tree stat via git status --porcelain)
           → 1 (network: git fetch + rev-list HEAD..origin/<base>)
             → 3b (subprocess: tsc / bun run typecheck — costliest, last)
               → push dispatcher
```

§DA9 anchor body (line 214) needs the matching update — change `(5 → 4 → 2 → 3a → 7 → 1 → 3b)` to `(5 → 4 → 2 → 7 → 3a → 1 → 3b)`.

T_push_module test-trace ordering test (§DA9 reviewer audit clause) verifies on a happy-path test case — the `gatesPassed` array in the audit log on success path should be `["5","4","2","7","3a","1","3b"]` post-fix.

### FLAG-B (minor — grep enforcement gap)

**Issue**: §D2.1 item #1's grep regex is:

```
rg -nP '(--mirror|--all|--tags|--delete|--prune|--force|--force-with-lease|forcePush)' src/core/orchd-push.ts
```

Missing `--no-verify`. Per CLAUDE.md global §"Hooks, Commits, Tooling":

> Hook-bypass = any of `--no-verify` / `--no-gpg-sign` / `core.hooksPath=/dev/null` / `HUSKY=0` / `LEFTHOOK=0` / removing `.git/hooks/pre-commit`. Env-broken → fix env. Hook-broken → escalate + `Approved bypass: <reason>` in commit body.

`git push --no-verify` skips the `pre-push` hook chain. orchd-push.ts is a write-path that bypasses operator-direct push — if it silently skips pre-push hooks, the team's pre-push gate (e.g. CI smoke-test, signoff verifier) is bypassed too. CLAUDE.md says no hook-bypass anywhere; orchd-push should honor that rule.

**Patch**:

```diff
-rg -nP '(--mirror|--all|--tags|--delete|--prune|--force|--force-with-lease|forcePush)' src/core/orchd-push.ts
+rg -nP '(--mirror|--all|--tags|--delete|--prune|--force|--force-with-lease|forcePush|--no-verify|--no-gpg-sign)' src/core/orchd-push.ts
```

§DA-Gate-1 prose (line 88) is already comprehensive ("not even an env-flag opt-in"); adding `--no-verify` + `--no-gpg-sign` to the grep regex is the matching enforcement. `--no-gpg-sign` is bundled in the patch since CLAUDE.md groups them as the same hook-bypass class.

T_push_module test-trace addition: one regression test asserting `git push` invocations from orchd-push do NOT include either flag. Reviewer DoD addendum: include both in the grep regex.

## Side-finding: kanban-data corruption (separate flag to lead)

While inspecting this Task I observed that **4 Phase 6 tasks were moved to status=done WITHOUT being claimed and WITHOUT shipped work**:

- `t-5-4e51a90e` (ADR-229 reviewer-pass) — status=done, `owner=null`, `claimedAt=null`
- `t-6-29c0fc92` (team.json::autoPush schema) — same shape
- `t-8-c75876e2` (`src/core/orchd-push.ts` push handler) — same shape; file does NOT exist in worktree or git
- `t-9-4db4ccd3` (Phase 6 trunk-signoff) — same shape

These appear to duplicate the canonical Phase 6 task IDs (`t-1-fc0368cb`, `t-2-944dfc1c`, `t-3-2bb5c6e6`, `t-4-decb4114`) and were likely files+done together as a no-op kanban operation. The "done" status creates a false-positive for any auto-groom / orchd-merge / committer sweep that reads task status as a completion signal.

**Recommended action**: lead to inspect + decide between (a) marking them blocked/wontfix with a note pointing at the real Task IDs, or (b) deleting them outright. **Out of scope for this reviewer-pass**; surfaced via parallel reply to lead.

## Sign-off conditions

| Item | Status | Required for `Status: accepted` flip? |
|---|---|---|
| Committer §Amendment items 1-6 | ✅ All landed | N/A (already verified) |
| 7-gate exhaustiveness | ✅ Pass | Yes (passed) |
| Fire-order cheapest-first | ⚠️ FLAG-A (3a/7 swap) | **Required** — one-line patch |
| ADR-227 §D1 amendment cross-citation | ✅ Pass | Yes (passed) |
| CLAUDE.md push policy honor | ✅ Pass | Yes (passed) |
| Opt-in default-false loud | ✅ Pass | Yes (passed) |
| 3 off-switches independent | ✅ Pass | Yes (passed) |
| Grep enforcement covers `--no-verify` | ⚠️ FLAG-B (regex extension) | **Required** — one-line patch |

**Recommendation**: planner folds FLAG-A + FLAG-B patches into the Status-flip commit (both edits are <5 LOC total) → flip Status: accepted. Both flags can also be deferred to a follow-up §Amendment if planner judges they don't block dogfood, but landing them in the same single-line edit is the cheaper path.

T_push_module implementer (t-1-fc0368cb claimant) reads this review for the fire-order swap + grep extension before opening the impl. T_push_review claimant (t-3-2bb5c6e6 trunk-signoff) verifies the patches landed at impl-time.

## Cross-refs

- ADR-229 (this review): `docs/adr/229-orchd-auto-push-and-safety-gates.md`
- ADR-226 (Phase 3 sibling — emits `epic.merged`): `docs/adr/226-orchd-auto-merge-subscriber.md`
- ADR-227 (Phase 4 — trigger amended by §DA3): `docs/adr/227-orchd-auto-dissolve-subscriber.md`
- ADR-202 + ADR-203: Honker substrate + topic taxonomy
- ADR-194: sibling auto-push (per-member-branch on `task.done`; `.atmux/logs/auto-push.jsonl`)
- ADR-028: main/master/production PR-only fleet invariant
- ADR-145: primitives-vs-policy
- Global CLAUDE.md §Push Policy + §Hooks, Commits, Tooling

— be-1, 2026-05-23
