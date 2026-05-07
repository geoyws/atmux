# ADR-016: Schema-version rollout deferred to Phase 6

**Status:** accepted
**Date:** 2026-05-05
**Owner:** porter-foundation-2

## Context

ADR-005 commits the port to Zod schemas at every JSON boundary file, with `schemaVersion: z.literal(N)` discriminators "for future migrations". At the time ADR-005 was written, that rule was framed as universal — every schema, every file.

Phase 1 surfaced a conflict between that rule and the side-by-side cutover protocol:

- **PLAN.md §1 mission line 12:** "Ship behind a side-by-side flag, **burn in for ≥2 weeks** across all 4 production teams (atmux, sopx-mvp, ifca_aux, unum), **then promote and decommission bash**."
- **PLAN.md §4.1 line 60:** "Final cutover (Phase 4) renames `atmux-bun` → `atmux` and moves bash to `/usr/local/bin/atmux-legacy` for **4-week rollback window** before deletion."
- **PLAN.md §4.1 line 61:** "Cutover policy: never delete bash until all 4 teams have run TS for **14 consecutive days with zero divergence**."

During the burn-in window (≥14 days pre-cutover) AND the rollback window (28 days post-cutover, before bash deletion), bash and the TS port BOTH read and write the same `.atmux/` JSON files. Bash atmux at parity-target HEAD `2aadc3f` does not write a `schemaVersion` field anywhere — verified empirically by `jq 'keys' /root/work/src/atmux/.atmux/{kanban,team}.json` and the schema docstrings in `lib/epic.sh:11`, `lib/story.sh:21-23`, `lib/kanban.sh:135-148`. If the TS port adds `schemaVersion` to a bash-shared schema:

1. **Bash reads fail.** Bash's jq filters access fields by name; an unexpected field can silently drop on `jq -r '.field // ""'` patterns or surface as schema noise on diagnostics. Either way, parity diverges.
2. **Coordinated bash+TS bump is the only safe alternative.** That requires editing the bash codebase to also write `schemaVersion`, which contradicts the "frozen at HEAD `2aadc3f`" rule (PLAN.md §2, ADR-013) for Phases 1–4 — bash is the parity reference, not a co-evolving codebase.
3. **Rollback safety degrades.** If the TS port writes a v2 schema and the operator rolls back to bash (per the 4-week rollback window in §4.1 line 60), bash hits files with shapes it didn't author — the worst-case rollback fails open.

So bash-shared schemas can't carry `schemaVersion` until bash is gone. Bash is decommissioned at the END of the rollback window, post-Phase-4, which puts the earliest legitimate `schemaVersion` rollout in Phase 6.

The question this ADR answers: **when** does `schemaVersion` actually land, and **with what relationship** to the v2 verb redesign that Phase 6 also ships (per ADR-014)?

## Decision

### `schemaVersion` lands across the whole tree at the start of Phase 6

In a single coordinated commit at the start of Phase 6 — after Phase 4 cutover has shipped, after the 28-day rollback hold has elapsed, and after `/usr/local/bin/atmux-legacy` (the bash binary) has been deleted — every existing schema in `src/schema/` gains a `schemaVersion: z.literal(1)` discriminator. From that commit forward, the existing rule from `src/schema/README.md` "Schema version migrations" applies in full: incompatible schema changes increment `schemaVersion` and add migrators under `src/schema/migrations/<file>-vN-to-vN+1.ts`.

### `schemaVersion` rollout is parallel to ADR-014's v2 verb redesign, NOT part of it

ADR-014 (verb design debt) describes the v2 verb redesign that ships at the end of Phase 6: subcommand structure (`task <sub>`, `member <sub>`), `member rm/rename`, `up`/`reconfigure` deprecation, etc. ADR-014 does NOT mention schemas — verified via `grep -i "schema\|version" docs/adr-bun/014-verb-design-debt.md` (zero matches). The schemaVersion rollout is a parallel concern that ships in the same window because the same precondition unblocks both (bash decommissioned), not because it's part of the verb redesign.

This separation matters: Phase 6 contains two independent decisions (verb redesign + schemaVersion rollout), and conflating them under ADR-014 would route schema-evolution questions to the wrong document. ADR-016 is the home for the schemaVersion-rollout commitment; ADR-014 stays focused on verb-surface redesign.

### Carve-out for bash-shared schemas during Phases 1–4

Until Phase 6 ships the rollout, schemas that write files bash also reads MUST omit `schemaVersion`. The rule is documented in `src/schema/README.md` § "Burn-in compatibility: bash-shared schemas" (added by Task #12, ratified by this ADR). Examples at v1: `team.ts`, `paused.ts`, `kanban.ts`, `inbox.ts`. TS-only schemas (parity-harness fixture shapes, internal TS-side state files bash never reads) DO carry `schemaVersion` per the ADR-005 default rule.

## Consequences

**Positives:**

- Bash compatibility preserved through the entire burn-in + rollback window. Operators can roll back from `atmux-bun` → `atmux-legacy` without hitting unreadable on-disk shapes.
- ADR-014 stays focused on verb-surface redesign; schemaVersion-rollout questions route to ADR-016 instead.
- Phase 6 has a clear pair of independent deliverables (verb redesign + schemaVersion rollout) rather than a single tangled "v2" bag.
- The carve-out's scope is bounded — `src/schema/README.md` documents which schemas it applies to, and the rule auto-sunsets at Phase 6 start.

**Negatives:**

- Two-step migration. Phase 6 ships a coordinated `schemaVersion: z.literal(1)` add across all schemas in one commit. That commit is mechanical (adding one field per file) but touches every schema; it must land before any schema-incompatible change in Phase 6+ ships.
- Schemas that gain `schemaVersion` later have no "v0 → v1" migrator (the v0 shape never had a version field; the migrator is a no-op semantically). Phase 6's coordinated commit can either skip `migrations/<file>-v0-to-v1.ts` files entirely OR ship them as identity functions for symmetry. ADR-014 follow-up will pick one; not load-bearing for v1.
- The schemaVersion rollout commitment is captured in this ADR, but the actual implementation lives in a Phase 6 task. Future reviewers gating Phase 6 schema changes need to find this ADR via the README cross-link to know the constraint exists.

**Follow-up tickets:**

- Phase 6 kickoff task: "Coordinated `schemaVersion: z.literal(1)` add across `src/schema/*` (post-bash-decommission)". Tracked as part of Phase 6 scope at the time it begins — not seeded today since Phase 6 is calendar-distant.
- ADR-014 cross-reference: when Phase 6 starts, ADR-014's References section gains a pointer to ADR-016 ("schemaVersion rollout that ships in the same window — parallel, not part of the verb redesign").
- Architect review: this ADR was authored by porter-foundation-2 during Task #12 review-cycle in response to a missing-ADR cite caught by reviewer-2. Architect should review at next Phase 0 / 6 transition checkpoint.

## Alternatives considered

### A. Add `schemaVersion` to all schemas now; coordinate a bash schema-bump in the same commit

Considered. Would put TS at the canonical Zod discipline immediately. Rejected because:
- Editing bash to add `schemaVersion` violates the "frozen at HEAD `2aadc3f`" rule (PLAN.md §2, ADR-013) for Phases 1–4. The bash side is the parity reference; mutating it during the port invalidates the parity-harness contract.
- Even if we suspended the rule for this one field, every operator running cron-fired bash atmux would write the new field on the next state-file write — but only if their bash binary was upgraded. Heterogeneous deployments (some teams bash-old, some bash-new) hit divergence anyway.
- Rollback safety would still degrade: rolling back from a bash binary that writes `schemaVersion` to one that doesn't is the same problem mirrored.

### B. Add `schemaVersion` only to TS-only schemas now; defer bash-shared schemas indefinitely

Considered. Half this ADR's decision — exactly what `src/schema/README.md` "Burn-in compatibility" carve-out documents. Rejected as a STANDALONE policy because it leaves the "when do bash-shared schemas finally gain `schemaVersion`?" question unanswered, which surfaces as a perpetual TODO. The Phase 6 commitment in this ADR closes that loop.

### C. Bury the rollout decision inside ADR-014 ("v2 verb redesign")

Considered. Would mean adding a paragraph to ADR-014 saying "v2 also adds `schemaVersion` everywhere". Rejected because:
- ADR-014 is verb-design only — adding schema content stretches its scope and dilutes its searchability ("ADR about verbs" should not be the home for schema-evolution policy).
- Future reviewers gating Phase 6 schema changes would land at ADR-014 expecting verb redesign content and have to spelunk for the schemaVersion rule. Separate ADR is more discoverable.
- The two decisions (verb redesign + schemaVersion rollout) are independent — they ship together because of Phase 6 timing, not because of architectural coupling.

### D. Defer the rollout decision until Phase 6 starts (no ADR today)

Considered. The "smallest change" option. Rejected because:
- The schemaVersion-deferral commitment is load-bearing for `src/schema/README.md`'s "Burn-in compatibility" section — it answers the question "what's the sunset?" for the carve-out. Without an ADR, the README's commitment hangs.
- Discovery cost: a future porter wondering "why don't we have schemaVersion?" should find a captured decision, not a TODO. CLAUDE.md "structural honesty" applies — capture the decision when it's made, not when it's executed.

## References

- **PLAN.md** — §1 mission line 12 (burn-in is pre-promotion); §4.1 lines 60–61 (4-week rollback window + 14-day-zero-divergence gate).
- **ADR-005** — JSON + locking model. Original "every schema includes `schemaVersion`" rule that this ADR carves out for bash-shared schemas during Phases 1–4.
- **ADR-013** — WIP-bash deferral. Sister rule: bash side is frozen at HEAD `2aadc3f` for Phases 1–4; mutating bash to co-evolve schemas is forbidden.
- **ADR-014** — Verb design debt — deferred v2 redesign (Phase 6). Adjacent in timing; ships in the same window as the schemaVersion rollout. NOT the source of the schemaVersion-deferral decision (verified: `grep -i "schema\|version" docs/adr-bun/014-verb-design-debt.md` → zero matches).
- **`src/schema/README.md`** §"Burn-in compatibility: bash-shared schemas" — the operator-facing rule this ADR ratifies.
- **`src/schema/paused.ts:8-14`** — canonical deviation comment that pioneered the bash-shared carve-out before this ADR formalized it.
- **bash `lib/kanban.sh:135-148`** — example of a bash-shared writer that doesn't include `schemaVersion`; the empirical reality this ADR captures.
