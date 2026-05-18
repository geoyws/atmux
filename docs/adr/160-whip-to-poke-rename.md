# ADR-160: whip → poke rename — SV register sweep, atmux-internal scope

**Status**: proposed
**Date**: 2026-05-16
**Driver-ref**: 2026-05-16 driver session — SV/Reddit-eng register sweep; `whip` carries punitive overtone (worker-with-a-lash); `poke` is engineer-vernacular for the periodic-nudge action the role actually performs.
**Parent EPIC**: t-827d3072 (this ADR is the umbrella; TR1-TR4 filed in same session per [[feedback_decomp_same_session_with_deps]]).
**Cross-refs**: ADR-079 / ADR-085 / ADR-132 / ADR-139 / ADR-140 / ADR-149 / ADR-157 (all reference `whip` in prose; get `§Amendments` annotations — no supersession, design unchanged), ADR-133 / ADR-158 / ADR-159 (rename mechanics precedents), ADR-136 (hot-rename label split — `whip-impl` label updates, id stays), ADR-161 (`_-prefix` — `whip-impl` is user-added, does NOT get `_-prefix`).

## Context

### Why this rename now

`whip` is the atmux-internal name for the periodic-nudge action the role performs against dormant lanes. The word's literal meaning (a leather lash for striking) carries a punitive overtone — "whip the workers into shape." Even in metaphorical use, the register is hostile.

The actual behavior is gentle: detect a dormant lane (no commit in N min), capture pane state, send a nudge. `poke` reads accurately — engineer-vernacular for "send a small signal that wakes something up." The candidate before `poke` was `reconcile` (k8s-flavored — observer detects drift between desired + actual state, brings them back in sync). Operator picked `poke` for honesty: the action isn't a full reconcile, just a periodic nudge.

This ADR is the third sibling vocabulary rename in the same release cycle:
- ADR-158: martinet → sentinel.
- ADR-159: gitter → committer.
- ADR-160 (this): whip → poke.

Plus ADR-161 (`_-prefix` convention) lands the same cycle.

### Scope — atmux-internal ONLY

**⚠️ claude-skills is dotfiles territory** (per [[feedback_claude_skills_dotfiles_territory]]). The `~/.claude/skills/whip/` skill directory + `whip-prompt.md` rename is **OPERATOR-MANAGED via the dotfiles flow** — atmux team must NOT escalate that rename as an OPERATOR-ACTION-NEEDED item. This EPIC's scope is atmux-internal references only:

- `src/verbs/whip.ts` and any `src/abstractions/whip*.ts` files.
- Cron templates referencing `atmux whip`.
- Doctor probes referencing whip-marker files.
- Debug log prefixes + error-message strings.
- ADRs that name `whip` in body — get `§Amendments` annotations pointing here.

The `~/.claude/skills/whip/` skill (operator-side) renames under a separate dotfiles workflow when operator decides. atmux's `atmux poke` verb interoperates with `~/.claude/skills/whip/` invocation paths during the grace cycle (alias retained).

### Why design stays unchanged

`whip-cadence` design (per ADR-079 / ADR-085 / ADR-132 / ADR-139 / ADR-140) is unchanged. The role observes commit-cadence + lane-state, fires nudges on threshold breaches, escalates on refusal patterns. Renaming the identifier doesn't change semantics. All cited ADRs get annotation headers (NOT supersession).

### Why bruh stays

`bruh` is the operator-yolo-vernacular sweep skill — register fits SV/Reddit-eng natively. Not subject to rename. Bruh is operator-triggered (typing `/bruh`); poke is cron-fired (automatic periodic nudges). Different loops; different vocabularies; only `whip` has the punitive overtone.

### Member rename

The current atmux team includes `whip-impl` (a user-added member, lane=`error-class`). Per ADR-136 id-vs-label split:
- `id: "whip-impl"` STAYS (branch + worktree + kanban owner stability).
- `label: "whip-impl"` → `"poke-impl"` (display update).
- `whip-impl` is `role: "member"` (user-added, NOT a default per ADR-161) → does NOT get `_-prefix`. Renders as `<emoji>-poke-impl` (existing hyphen format per ADR-135 D3).

## Decision

Four §Decision-anchor lines first, then prose.

> **§Decision-anchor #1** — **`poke` is the canonical atmux-internal identifier going forward.** `atmux poke` verb replaces `atmux whip` (legacy alias retained one release with deprecation-warn). Source files renamed; doctor probes renamed (`whip-stale` → `poke-stale`); debug-log + error-message strings rewritten. Claude-skills `~/.claude/skills/whip/` is OUT OF SCOPE per [[feedback_claude_skills_dotfiles_territory]] — operator-managed via dotfiles flow.

> **§Decision-anchor #2** — **Cron template legacy alias one release.** `atmux whip` cron-line entries continue invoking the `poke` handler via an alias for one release cycle. Deprecation-warn fires on every invocation. After cycle, alias removed; operators with stale cron lines get refusal hint citing ADR-160.

> **§Decision-anchor #3** — **ADRs naming `whip` get `§Amendments` annotations — NOT supersessions.** Affected ADRs (per EPIC body grep): ADR-079, ADR-085, ADR-132, ADR-139, ADR-140, ADR-149, ADR-157. Each gains a one-line annotation: "The `whip` identifier in this ADR's prose is renamed to `poke` per ADR-160. Design unchanged." Bodies stay verbatim per append-only convention. Each annotation is identical (template-copy).

> **§Decision-anchor #4** — **`whip-impl` member rename — label only.** Per ADR-136: `id: "whip-impl"` stays immutable; `label` updates to `"poke-impl"`. Branch `<base>-whip-impl` stays. Worktree path stays. Kanban owner field stays. Display label is the only mutation — operator runs `atmux member rename whip-impl --label poke-impl` OR atmux applies on next `atmux start` reconciliation. `whip-impl` is `role: "member"` (user-added, lane=error-class), NOT a default per ADR-161 — renders with hyphen format, not `_-prefix`.

### §Surface inventory

| Surface | Action |
|---------|--------|
| `src/verbs/whip.ts` | `git mv` → `src/verbs/poke.ts`; rewrite imports + help.ts entry |
| `src/abstractions/whip*.ts` (if any; grep `src/abstractions/whip`) | `git mv` if found; rewrite imports |
| Cron templates referencing `atmux whip` | `atmux whip` → `atmux poke`; legacy alias retained one release |
| Doctor probes (`whip-stale`, `whip-marker-missing`, etc.; locate via grep `probe.*whip`) | rename to `poke-*` |
| Debug log prefixes (`[whip]` etc.; grep `\\[whip\\]`) | rewrite to `[poke]` |
| Error-message strings citing "whip" | rewrite to "poke" |
| `templates/briefs/whip*.md` (if any; locate via grep) | `git mv` if exists; body rewrite |
| ADR-079 / ADR-085 / ADR-132 / ADR-139 / ADR-140 / ADR-149 / ADR-157 — body cites of `whip` | append `§Amendments` annotation (TEMPLATE — same one-line text in all 7) |
| `CLAUDE.md` (global + project) — `whip` references | rewrite to `poke`; global goes via dotfiles-flow propose |
| `README.md` | rewrite (preserve any "whip cadence" → "poke cadence" prose carefully — phrase is in operator vocabulary) |
| `CHANGELOG.md` | add [Unreleased] bullet under 🔤 Vocabulary refresh (groups with 158/159) |
| Memory entries citing `whip` | body updates (filenames preserved per [[feedback_decomp_same_session_with_deps]] precedent) |
| `~/.claude/skills/whip/` | **OUT OF SCOPE** — dotfiles territory, operator-managed |
| `~/.claude/skills/whip/whip-prompt.md` | **OUT OF SCOPE** — same |

### §Cron alias mechanism

The legacy alias works via a verb-dispatcher level shim:

```ts
// src/verbs/dispatch.ts (sketch)
const VERB_ALIASES: Record<string, string> = {
  "whip": "poke",    // ADR-160 legacy alias; removed after one release cycle
  "gitter": "committer",  // ADR-159 alias
};

function resolveVerbAlias(verb: string): string {
  const canonical = VERB_ALIASES[verb];
  if (canonical !== undefined) {
    // Deprecation-warn: emit to stderr
    process.stderr.write(`🟡 'atmux ${verb}' deprecated; use 'atmux ${canonical}' (ADR-160).\n`);
    return canonical;
  }
  return verb;
}
```

Cron lines emitted by cron-install during the grace window can use either name; the dispatcher resolves transparently. After the cycle, alias map entries removed.

### §EPIC-done definition

ADR-160 completes when:
1. TR1 lands — this ADR commits.
2. TR2 lands — source rename (`src/verbs/whip.ts` mv + import rewrites) + verb alias shim + doctor probe renames + cron template updates + tests.
3. TR3 lands — `whip-impl` member label rename via existing `atmux member rename` (per ADR-136); verify branch/worktree invariants hold.
4. TR4 lands — briefs + 7 ADR §Amendments + CHANGELOG + README + ARCHITECTURE + CLAUDE.md project + global CLAUDE.md propose + memory updates.

## Consequences

### Enables

- Less hostile vocabulary; matches engineer-vernacular for the periodic-nudge action.
- Joins ADR-158/159 in same-cycle SV register sweep.
- Operator-side `~/.claude/skills/whip/` rename can follow asynchronously via dotfiles flow without blocking atmux release.

### Does NOT cover

- `~/.claude/skills/whip/` skill rename (dotfiles territory).
- `bruh` skill rename (different register; stays).
- Behavior changes to whip-cadence semantics — pure identifier rename per ADR-079/085/132/139/140 design.
- Removal of `whip` references in OLDER ADRs (append-only).

### Rollback path

- Source rename: `git revert` the rename commit.
- Verb alias: stays in place (additive); operators using `atmux whip` keep working.
- Cron lines: legacy works during alias grace.
- Member label: `atmux member rename poke-impl --label whip-impl` reverts display.

### Reuse statement

- Rename mechanic: ADR-133 / ADR-158 / ADR-159 — reused.
- ADR-136 label-vs-id split: consumed.
- Verb-dispatcher alias pattern: new (introduced this ADR; will likely consumer by sibling renames going forward).
- ADR-079 / ADR-085 / ADR-132 / ADR-139 / ADR-140 / ADR-149 / ADR-157 — all preserved bodies + annotated.

### What breaks (during grace)

- Nothing. Alias resolves `atmux whip` → `atmux poke`; deprecation-warn surfaces but doesn't block.

### What breaks (post-grace)

- Cron lines + operator scripts invoking `atmux whip` refuse with hint citing ADR-160.

## Open questions

1. **Should `~/.claude/skills/whip/` be flagged in the §Acceptance with a propose-via-dotfiles tracking item?** The operator owns that flow. **Planner recommendation**: YES — TR4 stages a proposed-diff for the operator-side rename + replies to lead. Operator decides timing; atmux doesn't gate on it.

2. **`whip-impl` member's lane = "error-class"** — does the lane rename to "poke-class"? Atmux's lane enum is `fe|be|db|ops|test|review|misc|git|docs`; `error-class` doesn't appear in the enum at all. **Planner recommendation**: investigate — if `error-class` is a custom lane in team.json, it's outside the canonical enum; if standard, the rename doesn't apply. Reviewer can flip.

3. **`bruh` vs `poke` semantic overlap**? bruh is operator-triggered sweep; poke is cron-fired periodic nudge. **Planner recommendation**: keep both. Different invocation paths; different vocab.

4. **Should the 7 ADR §Amendments be templated identically or per-ADR-customized?** **Planner recommendation**: identical template-copy. Each is a 1-line annotation pointing here for rename rationale. Custom per-ADR text wastes signoff effort.

## §Amendment 2026-05-18 — EPIC e-f28c2596 T2+T4 collapse

EPIC e-f28c2596 (auto-fire Enter on queued worker compose-box) decomposed
the queued-text resubmit wiring into:

- **T2** — wire into `src/verbs/poke.ts` per-member iteration
- **T4** — wire into `src/verbs/whip.ts` team-level loop

Post-ADR-160 these collapse into a SINGLE wiring at
`src/verbs/poke.ts::checkMember`. The legacy bash `whip.sh` distinguished a
"team-level loop" from per-member checks; the TS port consolidated both into
one `for (const member of team.members)` in `runTick` that calls
`checkMember` per entry — the per-member wiring IS the team-level wiring.
Coverage spans every role in `team.json::members[]` (lead / planner /
reviewer / workers / ombudsman when present) because no role filtering
happens upstream of the call.

T4 lands as a doc-only annotation (this §Amendment + a code-comment block
at the T2 insertion point in `checkMember`) referencing the T2 commit
(`0d69bf3`) as the canonical wiring site. No additional code change is
required to satisfy T4's acceptance criteria; the team-level coverage
property is structurally preserved by the consolidated runTick loop.

## Cross-references

- [ADR-079](079-discord-noise-drainage.md) — whip-cadence Discord notification gating; gets §Amendment.
- [ADR-085](085-whip-approvals-watcher.md) — whip-cadence approval-detection extension; gets §Amendment.
- [ADR-132](132-pluggable-martinet.md) — pluggable observer (sentinel post-ADR-158); reads whip-cadence state; gets §Amendment.
- [ADR-133](133-medic-rename.md) — rename-mechanics precedent.
- [ADR-136](136-hot-rename-member-labels.md) — `whip-impl` label rename lives in label layer.
- [ADR-139](139-refusal-pattern-auto-rotate.md) — refusal-pattern detection during whip-cadence; gets §Amendment.
- [ADR-140](140-cheap-model-first.md) — cheap-model-first principle (sentinel handles whip-cadence under ADR-158); gets §Amendment.
- [ADR-149](149-*.md) — whip-related (per EPIC body); gets §Amendment.
- [ADR-157](157-goal-as-primary-drain.md) — `/goal` as primary drain for whip-cadence; gets §Amendment.
- [ADR-158](158-martinet-to-sentinel-rename.md) — sibling vocabulary rename.
- [ADR-159](159-gitter-to-committer-rename.md) — sibling vocabulary rename.
- [ADR-161](161-default-member-prefix-and-sort-verbs.md) — `_-prefix` does NOT apply to `whip-impl`/`poke-impl` (user-added, not default).
- Driver-ref: 2026-05-16 driver session.
- Memory [[feedback_claude_skills_dotfiles_territory]] — `~/.claude/skills/whip/` rename is OUT OF SCOPE.
- Project [CLAUDE.md](../../CLAUDE.md) §Docs Discipline.
