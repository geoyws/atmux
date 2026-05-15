# ADR-133: Rename superdoctor → medic (supersedes ADR-077 naming only)

**Status**: Accepted (2026-05-15, operator-batch-flip)
**Date**: 2026-05-14
**Author**: atmux team (planner / t-e587104e)
**Parent EPIC**: t-d25ff629
**Supersedes (naming only)**: ADR-077 §title + every codebase / config / skill / cron surface that names the role. Design decisions in ADR-077 remain canonical for the role.

## Context

### The "superdoctor" name was awkward + verb-adjacent

ADR-077 named the cockpit-tier self-healing role **superdoctor**. Two problems surfaced in operator usage between 2026-05-08 (ADR-077 ship) and 2026-05-14 (this rename):

1. **`atmux doctor` verb already exists** (ADR-019, `src/verbs/doctor.ts`). Operators routinely confused *"is doctor the verb or the cockpit process?"* — the disambiguation cost is real, and shows up in tickets, Discord pings, and runbook prose. Sample failure mode: an operator typing `atmux superdoctor --json` (expecting a verb to query the cockpit process) when the verb is actually `atmux doctor` and the cockpit process is observed via `atmux cockpit status`.
2. **"superdoctor" is two-word + prefix-modified.** Single-word identifiers read cleaner in log lines, Discord pings, brief templates, and config keys. Compare `[superdoctor]` vs `[medic]` in a verdict-first 2-second triage scan on mobile — the medic prefix is faster to register.

### Path A vs Path B — operator picked B

On 2026-05-14 the operator floated two paths:

- **Path A**: Rename `superdoctor` → `doctor` and accept the verb-vs-process naming collision. Simpler grep-replace; banks on operator muscle-memory to disambiguate.
- **Path B**: Rename `superdoctor` → a collision-free single-word like `medic`. Slightly wider grep surface; zero residual ambiguity.

Operator picked **Path B** with rationale *"medic is good path B"* — collision avoidance outweighs the marginal grep-cost. Medic is clinical, short, single-word, semantically tight for a cockpit-fleet-healer role, and carries no namespace overlap with any existing atmux verb / table / file.

### Why a separate ADR (not amend ADR-077)

`docs/adr/` follows append-only convention per atmux CLAUDE.md "Docs Discipline" §"Single ADR tree per project". Rename via amendment of ADR-077 would rewrite history; the supported mechanism is **new ADR + annotation header on the original**. This ADR is the new entry; ADR-077 gains a top-of-file annotation pointing here.

## Decision

### (D1) Rename `superdoctor` → `medic` across operator-facing surfaces

The rename is **naming-only**. Design decisions in ADR-077 (cockpit topology, cadence, authority bounds, inbox + messaging shape, complaint box residency) remain canonical for the role under its new name.

Surfaces in scope:

| Surface | Before | After |
|---|---|---|
| Cockpit window | W2 named `superdoctor` | W2 named `medic` |
| `cockpit.json` block key | `superdoctor: { enabled, claudeAccount, tuiOverrides }` | `medic: { enabled, claudeAccount, tuiOverrides }` |
| Verb | `src/verbs/superdoctor.ts` (if shipped) | `src/verbs/medic.ts` |
| Skill (operator dotfiles) | `~/.claude/skills/superdoctor/` + `superdoctor-prompt.md` | `~/.claude/skills/medic/` + `medic-prompt.md` |
| Cron line | `atmux superdoctor` (cron-install emitted) | `atmux medic` |
| Cockpit inbox key | `__superdoctor__` (ADR-077 §D4) | `__medic__` |
| Tests | `tests/unit/verbs/superdoctor*.ts` (if shipped) | `tests/unit/verbs/medic*.ts` |
| Templates | `templates/briefs/superdoctor.md` (if shipped) | `templates/briefs/medic.md` |
| Docs cross-refs | "superdoctor" in 077/086/081/079, PRD, README, CHANGELOG | "medic" (with optional historical-note pointer back to 077) |

### (D2) Backward-compat shim — one-release-cycle deprecation window

`cockpit.json` schema (`src/schema/cockpit.ts`, Zod) accepts **both** keys during one release cycle:

- `medic: { … }` — canonical.
- `superdoctor: { … }` — deprecated alias.

Resolution rules:

1. **Both present** → `medic` block wins. `atmux cockpit rebuild` emits a warning: *"ignoring deprecated superdoctor block; medic block in effect (ADR-133)"*.
2. **Only `superdoctor` present** → schema-load coerces to `medic` semantics. Warning emitted: *"deprecated key `superdoctor`, rename to `medic` per ADR-133"*. No functional regression.
3. **Only `medic` present** → canonical path; no warning.
4. **Neither present** → role disabled (same as today's `superdoctor.enabled !== true` path).

After one semantic-version bump (timeline in `docs/CHANGELOG.md` per EPIC §Acceptance), the `superdoctor` key is **dropped** from the schema. Schema-load on a config with the deprecated key then **soft-fails** the cockpit rebuild with an actionable error message pointing at this ADR.

Same pattern for `__superdoctor__` inbox key in `inbox_messages` SQLite table: both accepted during deprecation; `__medic__` canonical going forward; existing rows queryable via a small read-side coalesce (`COALESCE(sender_key_v2, sender_key) = '__medic__'` or equivalent — exact form left to TR2 schema impl).

### (D3) Skill rename is canonical at the dotfiles source, plugin-cache resyncs out of band

The skill source-of-truth lives at `/root/work/journals/.sb/claude-skills/plugins/coordination/skills/superdoctor/` (operator's personal dotfiles submodule). Rename happens there:

- Directory: `…/skills/superdoctor/` → `…/skills/medic/`
- Frontmatter (`SKILL.md`): `name: superdoctor` → `name: medic`; `description` updated to reference medic terminology.
- Prompt file: `superdoctor-prompt.md` → `medic-prompt.md` (body grep-replace).

The plugin-cache at `~/.claude/plugins/cache/…/coordination/0.1.0/skills/superdoctor/` and the operator workspace at `~/.claude/skills/superdoctor/` resync via the plugin manager at next install / cockpit rebuild. **Out of band for this ADR's commit**; EPIC §"PLUGIN SOURCE (DRIVER scope)" carries the operator-side step.

### (D4) Cron migration via idempotent rewrite (Path Z)

`atmux cron-install --cockpit` is the only place the role's cron line is emitted in atmux source. On rebuild, the verb:

1. Detects existing `atmux superdoctor` lines inside the marker-fenced cron block.
2. Rewrites to `atmux medic` lines in the same block.
3. Idempotent — re-running produces no diff once migrated.

Operators do **not** need to `crontab -e` by hand. EPIC sub-task TR6 implements this.

### (D5) Out of scope

- **Renaming ADR-077 the file itself** — append-only convention; the annotation header is the supported mechanism.
- **Renaming database tables** that may currently be `superdoctor_*`. The rename is naming-only at the operator/config/process surface, not at storage. If storage tables exist with the old name, a follow-up schema migration ADR handles them; this ADR's deprecation window does not touch storage.
- **Operator-side plugin-cache resync** — plugin manager handles on next install; not driven by atmux source.
- **Renaming `cockpit superdriver`** — the sibling role at W1 keeps its name. Superdriver and medic are distinct roles; the rename is scoped to ADR-077's role only.

## Tradeoffs

### Why one-release-cycle window, not hard cutover

Hard cutover would require every operator to re-author `cockpit.json` simultaneously with the atmux release ship. Operators run heterogeneous atmux versions across machines (local + hax + ephemeral cdev boxes); a hard cutover guarantees at least one machine breaks. One-cycle shim costs ~50 LOC of Zod + a warning string in the rebuild path — negligible against the value of zero forced operator action on day 1.

### Why warn-not-fail during the deprecation window

The warning is the operator-side signal to migrate. Forcing fail-on-deprecated-key during the window achieves the same end-state earlier but breaks `cockpit rebuild` for any operator who hasn't migrated yet, which gates *all* their cockpit work on a config-edit before they can do anything else. Warn-then-fail-later trades a small delay in migration completion for zero migration-time downtime.

### Why "medic" specifically over other clinical terms

Considered alternatives during the rename discussion:

- `doctor` — Path A; rejected for verb collision.
- `nurse` — semantically reasonable but reads soft for a self-healing role that has full action authority per ADR-077 §D3.
- `surgeon` — too escalation-heavy; the role does routine recurrence-prevention, not crisis-only.
- `medic` — picked. Clinical, short, single-word, action-oriented (a medic acts on what they see; matches the role's authority bound), no namespace overlap.

## Cross-references

- **[ADR-077](077-superdoctor-cockpit-role.md)** — Origin role definition. Annotated with a top-of-file rename-pointer to this ADR (see TR1 commit). Design decisions remain canonical under the new name.
- **[ADR-131](131-superdoctor-kanban-hygiene.md)** — Kanban-hygiene auto-fix loop. ADR-131 body text references "superdoctor" throughout; EPIC sub-task TR4 propagates the rename to ADR-131's body refs. **Caveat**: ADR-131 is itself proposed and not yet reviewer-accepted; TR4 may compose with a single reviewer-pass.
- **[ADR-132](132-pluggable-martinet.md)** — Pluggable Martinet (cockpit W3 sibling). ADR-132 already references the W2 role with the new "medic" name in its window-topology table (§D2), assuming this rename ships before ADR-132 is reviewer-accepted. If TR1 lands after ADR-132 acceptance, no edits needed there.
- **ADR-063** — Cockpit verb port + window topology. EPIC sub-task TR5 propagates the rename to ADR-063's cockpit-topology section (sibling to ADR-132 T8's W3 update).
- **ADR-086** — `atmux pulse`. ADR-086 mentions superdoctor as a sibling layer; TR4 grep-replaces the body text.
- **ADR-081** §E — supervisor recovery. References superdoctor in the recovery flow; TR4 propagates.
- **ADR-079** — Discord noise drainage. References superdoctor surfacing; TR4 propagates.
- **atmux CLAUDE.md** (project-root) "Docs Discipline" §"Same-commit doc updates" — this ADR composes with TR2-TR7 to keep code + docs + brief edits in matched commits.

## Open questions

Both already resolved at file time; no driver decisions pending.

**OQ-1 — Path A vs Path B (`doctor` rename vs collision-free `medic`)** — **Resolved 2026-05-14: Path B (medic).** Operator chose; rationale captured in §Context. Reversibility: HIGH only during this ADR's pre-acceptance window; once the deprecation cycle begins, reverting requires another ADR + cycle.

**OQ-2 — Edit ADR-077 body or annotate top-of-file?** — **Resolved 2026-05-14: annotate top-of-file.** ADRs are append-only per atmux CLAUDE.md. The annotation is the supported mechanism; this ADR commits the annotation alongside the new ADR file (TR1 single-commit per EPIC).

## Implementation plan

Single-commit per the EPIC's TR1 acceptance:

1. New file: `docs/adr/133-medic-rename.md` (this file).
2. Edit: `docs/adr/077-superdoctor-cockpit-role.md` — add the top-of-file annotation header (no body edits).

Both files land in **one commit on `geoyws-planner`** per the EPIC's TR1 scope.

Downstream TR2-TR7 land the codebase cascade (schema shim, source rename, doc cross-ref propagation, template + cron migration, integration smoke). Reviewer-gated per CLAUDE.md "Docs Discipline" — same-commit doc updates on every TR.

## Acceptance gates (per EPIC §Acceptance)

For TR1 specifically:

- [x] `docs/adr/133-medic-rename.md` exists with `Status: Proposed`.
- [x] `docs/adr/077-superdoctor-cockpit-role.md` carries the rename-annotation header (body unchanged).
- [x] Both files in a single commit on `geoyws-planner`.
- [ ] Reviewer-gated commit on the EPIC chain.

The wider EPIC acceptance (codebase rename, schema shim, cron migration, smoke green) gates on TR2-TR7 landing; TR1 is the docs-anchor that authorizes them.
