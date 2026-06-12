# atmux — agent contract

Binding rules for every agent (lead / planner / reviewer / lane workers / driver). Rationale lives in linked ADRs. Global rules at `~/.claude/CLAUDE.md` still apply; this file does not override them.

## Source of truth

ADRs (`docs/adr/`, append-only, numbered, monotonic) → docs (`docs/PRD.md`, `docs/ARCHITECTURE.md`, `docs/RUNBOOK-*.md`, `docs/medic.md`, `README.md`, `CHANGELOG.md`) → code. ADR wins when a doc disagrees; doc writes cite the ADR (`per ADR-052 §B`).

Look-up order: `rg -i '<topic>' docs/adr/` → `rg -i '<topic>' docs/ README.md CHANGELOG.md` → `rg -i '<topic>' templates/briefs/` → `rg -i '<topic>' src/`. Topic in source but not docs → file a Task (docs gap).

## Binding discipline

1. **Peruse before working.** Claiming an unfamiliar Task → read `docs/PRD.md` + `docs/ARCHITECTURE.md` + matching `RUNBOOK-*` + ADRs named in the Task body. "I didn't know X" when X is documented is a reviewer flag.
2. **Same-commit doc + ADR-pointer update** for documented-surface changes: verb sig, brief vocab (`templates/briefs/*.md`), state shape (`.atmux/state/*`), cron template, kanban/event schema, ADR-named invariants.
3. **Reviewer enforces the gate** — code-without-doc-update on documented surfaces is fail-state, blocked until the doc lands in the same or sibling commit on the same PR/Story.
4. **New decisions = new ADR before code lands.** Numbered monotonically, zero-padded. `Status: proposed` → `accepted` only via reviewer signoff or driver/lead `decisions-add`. Intentionally-held → `Status: proposed (deferred: <reason>)` so ADR-085 surfacer doesn't ping (no lint today; if rot recurs see `t-968416aa`).

**Carve-outs (no doc update required):** pure refactors that preserve every documented surface · generated code (e.g. SQL migrations from Zod) · test files (unless adding a public test-helper API). Else default to doc-update-required; reviewer's call governs.

## Pull model

Members auto-claim via `atmux claim --next --as <member>`. Lead routes priority + EPIC decomposition to planner, not per-Task dispatch. Docs discipline is **member-first, reviewer-second, lead-third**.

## Trunk integration — merge, not rebase (ADR-137)

Per-member `<base>-<member>` branches are long-lived (ADR-082 + ADR-084). Falling behind → `git merge origin/<base> --no-edit`, never `git rebase` (forces force-push, trips harness deny, breaks sibling fetches). Carve-outs: voluntary history cleanup, epic-team→parent fan-in via ADR-091 committer (rebase-then-merge per its pre-flag #4), final fan-in via ADR-134 committer.

## Spawning + model selection

- Manual Claude spawn always `--permission-mode auto` (other modes stop on every tool call). Match driver's account: `.claude-unum` → `c-u`, `.claude-icloud` → `c-ic`, `.claude-ifca` → `c-i`, else `claude`. Set `CLAUDE_GUARD_AGENT=1`. Wrong mode after spawn → `tmux send-keys -t <window> BTab`, never kill+respawn. Verify `⏵⏵ auto mode on`.
- Models: team members + driver + lead always Opus (`claude-opus-4-7`) + `CLAUDE_CODE_EFFORT_LEVEL=xhigh`. Never Sonnet for member roles. Sub-agents: Sonnet OK for read-only (Explore, general-purpose); Opus when writing code.

## Tmux + pane discipline

- **Capture pane state before `send-keys`.** `tmux capture-pane -p -t <w> -S -30 | tail -20`. Check for `thinking` / `Compacting` / `Press up to edit queued` / rate-limit / permission prompts. "Text at prompt" ≠ "ready."
- **Rate-limit triage uses API headers, not pane footers** (footers freeze during active turns). Destructive recovery requires BOTH stale budget AND zero `✽`/`✻` markers in last 60s.
- **Ping before touching shared live stack** (walks/runs/e2e/live-URL/bootstrap). Local-only work is autonomous.
- **Watch filters: enumerate anomalous, not exclude noise.** Pair with a known-green smoke probe.

## Reviewer vs auditor

- **Reviewer** = per-commit auto-gate, narrow + deep on diff (schema / GraphQL / authz / secrets / coverage / doc-update). Blocks code-without-tests + code-without-doc-update; fail-state.
- **Auditor** = driver-dispatched, system-wide, read-only. Flags via team-lead. Push back on stub-scaffolds requested purely for demo when a real implementation exists — propose signoff carve-out citing the real mechanism + ADR.

## Test-finding report shape

(1) state-snapshot per step · (2) containment analysis (got-through vs blocked) · (3) fix sketch (file:line + siblings) · (4) residue inventory (leaked rows, test docNos) · (5) severity with context.

Pair runbook beats with e2e step labels — beat name = `test.step()` label verbatim, button labels via `getByRole('button', { name: /.../ })`, customer names / docNos / tenants are shared constants both sides reference.

## Session lifecycle

Preclear at every phase boundary — phase = "shipped X end-to-end" (committed + pushed + smoked/typechecked/deployed green). Memory + handoff + task-list land while context is fresh. Driver itself = no-op preclear (no coordination state); lead in dedicated window preclears at boundaries.

## Migrators

Roster lives at `.atmux/team.json`; sync to legacy `.claude/team.json` via `atmux sync claude-team-json` (see [docs/RUNBOOK-sync.md](docs/RUNBOOK-sync.md) / [ADR-164](docs/adr/164-sync-claude-team-json.md)).

## Spawn timeout — `ATMUX_SPAWN_TIMEOUT_MS`

Default `spawn()` timeout is 30s (`src/abstractions/spawn.ts::DEFAULT_TIMEOUT_MS`). Submodule-heavy projects (e.g. sopx — nested aix-root / std-root chains) regularly need >30s for cold submodule init, surfacing as `SpawnTimeoutError` mid-`spawn-epic` worktree provisioning. Operators export `ATMUX_SPAWN_TIMEOUT_MS=<ms>` (e.g. `120000`) at team-start. Parsing fails closed: non-numeric / non-positive / non-finite → 30_000ms silently. Per-call `opts.timeoutMs` continues to take precedence. Source: t-681e5b91 (sopx cross-repo dispatch, FIX-A3 Gap #1).

`ATMUX_GIT_TIMEOUT_MS` is the **distinct** sibling seam for the shell-out-to-`git` wrappers (`defaultGitSpawn` in `src/abstractions/worktree.ts` / `src/core/auto-done.ts` / `src/core/auto-push.ts`). Default is `src/abstractions/spawn.ts::DEFAULT_GIT_SPAWN_TIMEOUT_MS` (30_000); resolution via `resolveGitTimeoutMs()` with precedence per-call `opts.timeoutMs` > env `ATMUX_GIT_TIMEOUT_MS` > default, both override layers failing closed to the default on non-numeric / non-positive / non-finite values. Bump when cold submodule fetch / large-pack `worktree add` blows past 30s. Source: t-e32bdf73 (e-268447e2 T1). NOT the same knob as `ATMUX_SPAWN_TIMEOUT_MS` — that governs the buffered/tmux-spawn default, this governs only the git plumbing wrappers.

## Cron discipline

Before arming a recurring cadence (OS crontab, Claude Code `CronCreate`, `ScheduleWakeup`-driven `/Xloop`), check whether the same arm exists; skip duplicates. Contract is [ADR-192](docs/adr/192-cron-arm-idempotency-contract.md): (1) pre-arm `CronList` with fuzzy prompt-hash + interval-exact match, (2) Levenshtein-normalized-tokens fuzzy default (operator-configurable threshold), (3) dynamic-paced loops mark `~/.atmux/state/loop-arm-<hash>.json` and re-check at wake-time. Impl ownership for `/Xloop` skills lives in operator dotfiles (claude-skills tree, per memory `feedback_claude_skills_dotfiles_territory`); atmux carries the ADR + cross-refs only. OS-crontab idempotency already covered via `atmux start`'s sandwich markers (`# >>> atmux:team=<name>`).
