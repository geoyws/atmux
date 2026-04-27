# E15 Signoff — Gitter brief race-staging fix

**Reviewer**: reviewer-2
**Date**: 2026-04-27
**Task**: t-c5297af1 (REVIEW)
**Epic**: e-0e8eb4b9 (E15)
**Refs**: memory `feedback_path_restricted_commit.md`

**Verdict**: ✅ APPROVED — within process-fix scope. One follow-up nit flagged (non-blocking).

## Deps verified done

- t-52770b98 FE — `templates/briefs/gitter.md` updated (commit `d525f2b`).
- t-bf9bd197 TEST — `tests/unit/gitter_path_restricted_commit.bats` (commit `f64b344`).

## 1. Brief verification — `templates/briefs/gitter.md`

| Audit item | Brief location | Status |
|------------|----------------|--------|
| Canonical commit recipe uses `git commit -m "..." -- <files>` form | lines 49-58 (§2e) | ✅ |
| Argument order documented (`-m` BEFORE `--`) | line 61 (after recipe) + line 107 (§Path-restricted) | ✅ doubly stated |
| §Path-restricted commits subsection present | lines 99-116 | ✅ |
| References `feedback_path_restricted_commit.md` memory | line 107 | ✅ |
| Mm worktree-state nuance documented | lines 109-116 ("Critical `Mm` nuance.") | ✅ |
| Curated-patch workaround spelled out | lines 110-114 (steps 1-4: skip → diff → apply --cached → plain commit + verify) | ✅ |
| Post-commit verification rule (`git show --stat`) | lines 65-75 (§2g) | ✅ |
| `atmux flag add` on wider-than-expected | lines 73-75 (steps 1-3 with `tell-lead` + reset/carve-out branches) | ✅ |

The §Path-restricted (lines 99-116) and §2e/g recipe loop are mutually reinforcing — the recipe IS the path-restricted form by default; the §Path-restricted prose is the "why" + Mm carve-out + memory reference.

✅ All five required brief items present.

## 2. Test coverage — `tests/unit/gitter_path_restricted_commit.bats`

| AC | Test name | Maps to brief item | Status |
|----|-----------|--------------------|--------|
| AC1 | Race-staging defense (path-restricted scopes commit to A when B concurrently staged) | §Path-restricted lines 101-107 | ✅ |
| AC2 | Argument order — `commit -- A -m msg` rejected by git | brief line 61 + 107 | ✅ |
| AC3 | Mm worktree-state — `commit -- A` records BOTH staged + unstaged | brief lines 109-116 | ✅ |
| AC4 | Curated-patch workaround — `apply --cached` + plain commit lands ONLY filtered hunks | brief lines 110-114 (steps 1-4) | ✅ |
| AC5 | Post-commit verification — wider-than-expected → mock `atmux flag add` invoked | brief lines 65-75 | ✅ |
| AC6 (bonus) | Inverse-pin — narrow-as-expected does NOT invoke flag (false-positive guard) | implicit at brief line 75 | ✅ |

All 5 required ACs PASS; bonus AC6 is the negative-space proof per ADR-029 audit-bar discipline (catches a regression where post-commit stat-check mis-classifies clean narrow commits → operator noise).

**Local run**: `bats tests/unit/gitter_path_restricted_commit.bats` → 6/6 PASS.

The Task body promised an `atmux flag add` shim mock — AC5 implements it via PATH override + NUL-RS argv recovery (mirrors `tests/unit/decisions.bats` curl-shim pattern). Verb assertion (`flag` + `add` are first two argv) + severity assertion + 7-hex SHA regex on subject are all pinned.

✅ Coverage table complete; AC6 is bonus negative-space proof; bats green.

## 3. Vulnerability widening — adjacent classes

**Question**: are there OTHER gitter commit recipes (merge commits per Story end, persist-deferred final-Task hook) that bypass the path-restricted rule?

- **§3 Story merge (lines 84-89)**: "Stories are linear chains in this repo. … `atmux story advance s-xxx --to done`" — no commit fires here, just a kanban transition. Rule doesn't apply.
- **§4 persist-deferred final-Task (lines 91-97)**: line 96 says "The Task body should also include any in-repo metadata changes (e.g. CHANGELOG note); commit those normally."
  - "normally" is mildly ambiguous — by reading the brief top-down, "normally" should mean §2e (the canonical path-restricted recipe). But a literal reader could interpret it as "bare `git commit -m '…'`" since §4 doesn't restate the recipe.
  - **Severity**: low. Final-Task hook is one-shot per ADR-007; the gitter has the rest of the brief loaded by the time §4 fires; race-staging is far less likely on a one-shot final-Task than on the parallel worker stream §2 covers.
  - **Recommendation**: future patch — change line 96 to "commit those via the canonical §2e form (path-restricted with explicit pathspec)". Open a follow-up Task only if a real persist-deferred run shows widening; otherwise carry as documentation polish.
- **§Hard rules (lines 122-131)**: covers push policy, hooks-bypass, amend-after-hook, one-commit-per-Task, lint-staged Mm. Line 128 cross-links the §Path-restricted defense ("Path-restricted commits — see §Path-restricted commits — are the upstream defense; this `Mm`-trap is the downstream pitfall when path-restricted form is itself unsafe."). ✅ Reinforces the rule once more.

**Adjacent classes covered**: parallel commit stream (§2), Story-end merge (§3 — N/A no commit).
**Adjacent classes NOT fully covered**: persist-deferred final-Task (§4) — wording polish only.

## 4. Final verdict

**✅ APPROVED** within process-fix scope.

Brief carries the rule, the Mm exception, and the post-commit verification + flag-raise discipline. Tests pin all five required ACs plus a bonus negative-space proof; 6/6 PASS locally.

**Follow-up nit (non-blocking)**: §4 line 96 ("commit those normally") could explicitly cross-link §2e canonical recipe. Low severity — final-Task hook is one-shot, race surface is minimal; documentation polish, not a refuse-gate.

## Artifacts

- Brief: `templates/briefs/gitter.md` (commit `d525f2b`).
- Tests: `tests/unit/gitter_path_restricted_commit.bats` (commit `f64b344`).
- Memory: `feedback_path_restricted_commit.md` (linked from brief line 107).
