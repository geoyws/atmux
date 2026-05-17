# atmux — agent contract

Binding rules for every agent (lead / planner / reviewer / lane workers / driver). Rationale lives in the linked ADRs. Global rules at `~/.claude/CLAUDE.md` still apply; this file does not override them.

## Source-of-truth chain

ADRs (`docs/adr/`, append-only, numbered, monotonic) → docs (`docs/PRD.md`, `docs/ARCHITECTURE.md`, `docs/RUNBOOK-*.md`, `docs/medic.md`, `README.md`, `CHANGELOG.md`) → code. When a doc disagrees with an ADR, the ADR wins and the doc is updated. Doc writes cite the ADR (`per ADR-052 §B`).

## Binding discipline

1. **Peruse before working.** Claiming an unfamiliar Task → read `docs/PRD.md` + `docs/ARCHITECTURE.md` + matching `RUNBOOK-*` + ADRs named in the Task body. "I didn't know X" when X is documented is a reviewer flag.
2. **Same-commit doc + ADR-pointer update** for any change to a documented surface: verb signature (`atmux <verb> …`), brief vocabulary (`templates/briefs/*.md`), state-file shape (`.atmux/state/*.json`, `.atmux/state.db`), cron template, kanban / event schema, ADR-named invariants (e.g. ADR-029 §F6 byte-equal bash parity).
3. **Reviewer enforces the gate** — code-without-doc-update on documented surfaces is fail-state, blocked until the doc lands in the same or sibling commit on the same PR/Story.
4. **New decisions = new ADR before code lands.** Numbered monotonically, zero-padded. `Status: proposed` becomes `accepted` only via reviewer signoff or driver/lead `decisions-add`. Intentionally-held ADRs use `Status: proposed (deferred: <reason>)` so ADR-085 surfacer doesn't ping (no lint today; if rot recurs, see `t-968416aa`).

## Carve-outs (no doc update required)

Pure refactors that preserve every documented surface · generated code (e.g. SQL migrations from Zod) · test files (unless adding a public test-helper API). Else default to doc-update-required; reviewer's call governs.

## Where to look first

`rg -i '<topic>' docs/adr/` → `rg -i '<topic>' docs/ README.md CHANGELOG.md` → `rg -i '<topic>' templates/briefs/` → `rg -i '<topic>' src/`. Topic not in ADRs/docs but findable in source = docs gap; file a Task.

## Pull model

Members auto-claim via `atmux claim --next --as <member>`. Lead routes priority + EPIC decomposition to planner, not per-Task dispatch. Docs discipline is **member-first, reviewer-second, lead-third**.

## Trunk integration — merge, not rebase (ADR-137)

Per-member `<base>-<member>` branches are long-lived (ADR-082 + ADR-084). Falling behind → `git merge origin/<base> --no-edit`, never `git rebase` (forces force-push, trips harness deny, breaks sibling fetches). Carve-outs: voluntary history cleanup, epic-team→parent fan-in via ADR-091 committer (rebase-then-merge per its pre-flag #4), final fan-in via ADR-134 committer.

## Manual Claude spawn pattern

Always `--permission-mode auto` (other modes stop on every tool call):

```bash
case "${CLAUDE_CONFIG_DIR:-$(realpath ~/.claude 2>/dev/null)}" in
  */.claude-unum*)    DRIVER_WRAPPER="c-u" ;;
  */.claude-icloud*)  DRIVER_WRAPPER="c-ic" ;;
  *)                  DRIVER_WRAPPER="claude" ;;
esac
CLAUDE_GUARD_AGENT=1 ${DRIVER_WRAPPER} --permission-mode auto --model claude-opus-4-7
```

Wrong mode after spawn → `tmux send-keys -t <window> BTab` to cycle, never kill+respawn. Verify `⏵⏵ auto mode on` in the footer.

## Model selection

- Team members: Opus (`claude-opus-4-7`) + `CLAUDE_CODE_EFFORT_LEVEL=xhigh`. Never Sonnet.
- Subagents reading only (Explore, general-purpose): Sonnet OK.
- Subagents writing code: Opus.
- Driver / lead: Opus always.

## Tmux + pane discipline

- **Capture pane state before `send-keys`.** `tmux capture-pane -p -t <w> -S -30 | tail -20`. Check `thinking with` / `Compacting` / `Press up to edit queued` / `Now using extra usage` / rate-limit / permission prompts / queued compose. "Text at prompt" ≠ "ready for input."
- **Rate-limit triage uses API headers, not pane footers.** Footers freeze during active turns. Curl Anthropic Messages API for `anthropic-ratelimit-*`. Never invoke destructive recovery (rotate / kill+respawn / /clear) on footer numbers alone — require BOTH stale-looking budget AND zero `✽`/`✻` turn markers in last 60s of capture.
- **Ping before touching shared live stack** (walks / runs / e2e / live-URL probes / bootstrap). Local-only work is autonomous.
- **Watch filters: enumerate anomalous, not exclude noise.** Pair with a known-green smoke probe; >0 anomalies under no load means the filter is wrong.

## Reviewer vs auditor

- **Reviewer** = per-commit auto-gate, narrow + deep on the diff (schema / GraphQL / authz / secrets / coverage / doc-update). Blocks code-without-tests and code-without-doc-update; fail-state.
- **Auditor** = driver-dispatched, system-wide, read-only. Flags via team-lead. Push back on stub-scaffolds requested purely for demo when a real implementation exists — propose a signoff carve-out citing the real mechanism + ADR.

## Test-finding report shape

(1) state-snapshot per step · (2) containment analysis (got-through vs blocked) · (3) fix sketch (file:line + siblings) · (4) residue inventory (leaked rows, test docNos) · (5) severity with context.

Pair runbook beats with e2e step labels — beat name = `test.step()` label verbatim, button labels via `getByRole('button', { name: /.../ })`, customer names / docNos / tenants are shared constants both sides reference.

## Session lifecycle

Preclear at every phase boundary — phase = "shipped X end-to-end" (committed + pushed + smoked/typechecked/deployed green). Memory + handoff + task-list land while context is fresh. Driver itself = no-op preclear (no coordination state); lead in dedicated window preclears at boundaries.

## Migrators (from Claude `/team` skill family)

atmux owns the canonical roster at `.atmux/team.json`. Legacy `.claude/team.json` is consumed by Claude skills and drifts on every `add-member` / `rotate` / `member rename`. Preview: `atmux sync claude-team-json --dry-run`. Write: `atmux sync claude-team-json` (preserves hand-authored `role` text; refuses on drift with exit `65` unless `--force`). Flow: [`docs/RUNBOOK-sync.md`](docs/RUNBOOK-sync.md) ([ADR-164](docs/adr/164-sync-claude-team-json.md)).
