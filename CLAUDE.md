# atmux — agent contract

This file is the **canonical agent contract** for anyone running atmux on a codebase. It is what every spawned member — lead, planner, reviewer, lane workers — reads before doing any work in this project. If you're an open-source contributor or downstream user, treat this as the conventions document; agents will pick it up automatically via Claude Code's project-CLAUDE.md mechanism.

## The ADR → docs → context chain

**ADRs are the source of truth.** Every architectural decision lives as a numbered ADR under `docs/adr/`. ADRs are append-only: once accepted, they are not edited except for follow-up annotations. Superseding decisions get a new ADR that references the old one.

**Docs distill ADRs.** Project documentation — `docs/PRD.md`, `docs/ARCHITECTURE.md`, `docs/RUNBOOK-*.md`, `docs/medic.md` (renamed from `docs/superdoctor.md` per ADR-133), `README.md`, `CHANGELOG.md` — are *distillations* of ADR decisions, not independent narratives. When a doc and an ADR disagree, the ADR wins and the doc is updated to match. When writing or updating a doc, reference the ADR(s) that authorized the content (`per ADR-052 §B`, `mirrors ADR-082 W3`).

**Context flows from docs.** Members reading the codebase build context via the docs first, ADRs second, code third. The pull model only works if every claimer has the same vocabulary; the docs are what synchronize that vocabulary.

## Discipline (binding on every agent)

1. **Peruse before working.** On bootstrap and when claiming a Task that touches an unfamiliar area, read the relevant docs FIRST. At minimum: `docs/PRD.md`, `docs/ARCHITECTURE.md`, any `RUNBOOK-*` matching the affected surface, and the ADR(s) named in the Task body. A member surfacing "I didn't know X" when X is documented is a reviewer-flag failure mode.

2. **Same-commit doc updates.** Code change that introduces, removes, or repositions a concept = same-commit doc + ADR-pointer update. This is the same rule as the existing "tests alongside code" discipline — different artifact, identical rationale. Examples of "documented surfaces" where this applies:
   - Verb signature (anything reachable via `atmux <verb> …`)
   - Brief vocabulary (anything in `templates/briefs/*.md`)
   - State-file shape (`.atmux/state/*.json` or SQLite schemas under `.atmux/state.db`)
   - Cron template (`atmux cron-install` output)
   - Kanban / event schema
   - ADR-named invariants (e.g. ADR-029 §F6 "byte-equal bash parity")

3. **Reviewer enforces the gate.** The reviewer blocks code-without-doc-update on documented-surface changes. The block is not advisory — it's a fail-state until the doc lands in the same commit (or sibling commit on the same PR / Story). The reviewer's coverage table includes a "doc-update column" alongside the existing schema / GraphQL / authz / coverage columns.

4. **ADR write-flow.** New decisions get a new ADR before code lands. ADRs follow the existing numbering convention (zero-padded three-digit, monotonic). A new ADR is "proposed" until it has reviewer signoff or an explicit driver/lead `decisions-add` event; only then does it become "accepted". Accepted ADRs are referenced by code via comment links (`// per ADR-052 §B`).

   **Deferred-pending annotation (ADR-085 §2.5 interaction).** An ADR whose acceptance is intentionally held — pending an upstream dep, a parallel decision, an operator review window — MUST carry the annotation `Status: proposed (deferred: <one-line reason>)` rather than bare `Status: proposed`. ADR-085's `needs-approval` whip surfacer treats bare `proposed` as "ping every tick"; the `(deferred: …)` annotation signals "intentionally not-yet-accepted, don't surface". Convention-only — no lint gate today; if rot recurs, formalize as a pre-commit check (out-of-scope per Task t-968416aa).

## Where to look first

When unsure about a topic, the lookup order is:

1. **Grep ADRs**: `rg -i '<topic>' docs/adr/`
2. **Grep docs**: `rg -i '<topic>' docs/ README.md CHANGELOG.md`
3. **Grep brief templates** (for member-facing vocabulary): `rg -i '<topic>' templates/briefs/`
4. **Grep source**: `rg -i '<topic>' src/`

Code is the last resort, not the first. If the topic isn't in ADRs or docs and you have to grep source to learn it, that's a docs gap — file a Task to capture the finding back into the docs.

## Pull model + auto-drain

Members auto-claim Tasks via `atmux claim --next --as <member>`. The lead does NOT dispatch per-Task; the lead routes priority overrides and EPIC-level decomposition to the planner. Workers pull whichever Task is next claimable in their lane.

This means the docs-discipline is **member-enforced first, reviewer-enforced second, lead-enforced third**. Every member is expected to peruse + update docs in their own loop; the reviewer catches what slips through; the lead only intervenes when a pattern emerges.

## When the docs-discipline doesn't apply

- Pure refactors that preserve every documented surface (no vocabulary change, no schema change, no verb-signature change) — no doc update needed; reviewer waives.
- Generated code (e.g. SQL migrations from Zod schemas) — the schema source is documented, the generation is mechanical.
- Test files — tests document themselves; no separate doc update unless the test surfaces a new public test-helper API.

In all other cases, default to "doc update required." If unsure, the reviewer's call governs.

## Trunk integration — merge, not rebase (per [ADR-137](docs/adr/137-merge-over-rebase.md))

When a member's `<base>-<member>` branch falls behind `origin/<base>`, integrate via `git merge`, NOT `git rebase`. Per-member branches are long-lived (ADR-082 + ADR-084); a rebase forces a force-push, trips the harness deny on non-staging branches, and makes sibling members' `git fetch` views inconsistent. Merge keeps the branch in a consistent published state; the criss-cross history is collapsed when gitter (ADR-134) fans the branch back into trunk.

```bash
# CANONICAL
git -C <worktree-root> fetch origin
git -C <worktree-root> merge origin/<base> --no-edit

# FORBIDDEN
git -C <worktree-root> rebase origin/<base>
```

Carve-outs: voluntary history cleanup (squash, fixup), epic-team-base → parent-trunk fan-in (ADR-091 gitter, rebase-then-merge per its pre-flag #4), and final fan-in via gitter (ADR-134, works on any internal shape). See ADR-137 for the full table.

## Related global rules

Agents spawned by atmux also read the user's global `CLAUDE.md` (typically under `~/.claude/`). The global rules cover machine layout, timezone discipline, push policy, model selection, and the broader Driver Mode conventions. This project-local `CLAUDE.md` complements those rules — it does not override them, and where they apply (commit conventions, hook-bypass policy, etc.), the global rule wins for cross-project consistency.
