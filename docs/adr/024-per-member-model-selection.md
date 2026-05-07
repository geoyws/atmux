# ADR-024: Per-member model selection — Sonnet for read-only roles, Opus for writers

**Status**: accepted
**Date**: 2026-04-27
**Revision**: 2026-04-27 07:55 MYT — narrowed Sonnet carve-out from 4 roles to discorder-only after the maintainer's review (decision d-c3f8d980 supersedes d-a26b4211).

## Context

Global `~/.claude/CLAUDE.md` (Model Selection §) reads:

> **Team members always use Opus.** Sonnet is only acceptable for Agent-tool subagents doing read-only work… Anything that writes code, makes judgment calls, or acts on behalf of the user runs on Opus.

The original v1 of this ADR (07:34 MYT) proposed extending Sonnet to four atmux roles (reviewer, discorder, unblocker, auditor) as read-only-judgment carve-outs. the maintainer's 07:55 MYT review reverted: Sonnet-fit is **read-and-summarise WITHOUT judgment-on-correctness**. Of the four originally proposed:

- **discorder** — qualifies. Pure narrative formatter; writes Discord pings only; never makes calls about correctness of others' work.
- **reviewer** — does NOT qualify. Audit-bar judgment (exhaustive grep + negative-space proof + class-widening verdict per global CLAUDE.md §Review/Audit Discipline) is consequential calls on others' work.
- **unblocker** — does NOT qualify. `/team clear` blast-radius + classify-vs-act decisions on others' work are consequential.
- **auditor** — does NOT qualify. Same exhaustive-grep + verdict pattern as reviewer; checks already-committed code.

The global "Team members always use Opus" rule is restored for atmux. The carve-out is narrower — **only the pure narrative formatter discorder**, plus the ad-hoc `lib/llm-judge.sh` helper which is NOT a team member (Sonnet `claude --print` invocation gated on banner presence in lib/whip.sh).

**Final per-role model assignment**:

| Role | Model | Rationale |
|---|---|---|
| **lead** | Opus | Coordination + dispatch + rotation = heavy multi-decision judgment |
| **planner** | Opus | Decomposition + ADR authorship + tradeoff weighing |
| **be-kanban** / **fe-kanban** / **test-kanban** | Opus | Writing code, designing tests, debugging |
| **gitter** | Opus | Commit composition + lint-staged-trap edge cases + scope-check |
| **reviewer** | Opus | Audit-bar judgment on others' work (exhaustive grep + negative-space + class-widening) |
| **unblocker** (NEW E9/Sc) | Opus | `/team clear` blast-radius + classify-and-route on others' work |
| **auditor** (when spawned) | Opus | Exhaustive-grep + verdict pattern on already-committed code |
| **discorder** (NEW E9/Sd) | **Sonnet** | Pure narrative formatter; writes Discord pings only; no judgment-on-correctness |
| `lib/llm-judge.sh` helper (NOT a team member) | **Sonnet** | Ad-hoc `claude --print` invocation from lib/whip.sh SOFT-tier path; ADR-023 |

Reversibility: HIGH. Driver may flip discorder back to Opus if narrative quality drops below bar; override is one `jq` edit + `atmux rotate discorder`.

Three implementation shapes considered:

- **A (chosen)** — per-member `team.json:.members[].model` field already exists in the schema (`lib/start.sh:156` reads it; `lib/tui.sh:86` propagates as `--model <m>` to `claude` CLI). Applied via one-time `jq` edit on `team.json` post-decompose. Default semantics: absent OR `"default"` → claude CLI's default model (currently Opus per `CLAUDE_CODE_EFFORT_LEVEL=xhigh` global env).
- **B (rejected)** — global `team.json:.modelDefaults.<role>` block. More schema; same outcome. Per-member field already covers the use case; per-role default would be syntactic sugar.
- **C (rejected)** — env-var override at spawn (`ATMUX_MODEL_<role>=...`). Less discoverable; team.json is the canonical source-of-truth surface.

## Decision

**Audit `lib/start.sh` + `lib/tui.sh` per-member model propagation.** Verify the chain:

1. `lib/start.sh:156` reads `.model // "default"` from member JSON.
2. `lib/start.sh:175` invokes `atmux::tui_cmd "$tui" "$model" "$cwd" "$member" "$role" "$mj"`.
3. `lib/tui.sh::atmux::tui_claude` (line 83) appends `--model "$model"` when `model != "default"`.
4. Spawn into tmux pane invokes the assembled command.

The chain is intact today; the audit Task confirms end-to-end via a live spawn smoke test (or a bats spec asserting the assembled command string contains the expected `--model claude-sonnet-4-6`).

**Default semantics doc**: in `team.json`, `.members[].model` accepts:

- `"default"` (or field absent) → claude CLI default (currently Opus, per global `CLAUDE_CODE_EFFORT_LEVEL=xhigh`).
- `"claude-opus-4-7"` / `"claude-sonnet-4-6"` / `"claude-haiku-4-5-20251001"` / future model IDs → passed verbatim as `claude --model <id>`.

**`CLAUDE_CODE_EFFORT_LEVEL=xhigh`** stays global per existing tui.sh:91. Sonnet members inherit xhigh effort; this is intentional — read-only roles benefit from full reasoning depth even on the smaller model. Revisit if Sonnet@xhigh proves wasteful relative to Sonnet@medium for narrative roles.

**OPS apply** (post-Sd landing): `jq` edit on `/root/work/src/atmux/.atmux/team.json` to set:

- `discorder.model = "claude-sonnet-4-6"` (after Sd spawns the member)

`lead`, `planner`, `be-kanban`, `fe-kanban`, `test-kanban`, `gitter`, `reviewer`, `unblocker`, `auditor` left at `"default"` (Opus). Restart discorder via `atmux rotate discorder` to re-spawn with the new model — **or** wait for next natural rotation if the running session is mid-work.

**Rate-limit judge helper** (`lib/llm-judge.sh` per ADR-023) is NOT a team member. It's an ad-hoc `claude --print --model claude-sonnet-4-6` invocation called from `lib/whip.sh` SOFT-tier path. No `team.json:.members[]` entry; no spawn pane; no rotate. Sonnet usage there is part of ADR-023's design, not this ADR.

## Consequences

- **`lib/start.sh` + `lib/tui.sh` audit** — confirm propagation; no code change expected (chain works today). If audit finds a gap, fix in same Task.
- **`templates/team.example.json` documentation** — change ONLY the discorder example member from `"default"` to `"claude-sonnet-4-6"` to surface the per-member override pattern. Other example members stay at `"default"` (Opus).
- **`tests/unit/spawn_per_member_model.bats` (new)** — assert assembled spawn command contains `--model claude-sonnet-4-6` when member.model is set; assert no `--model` flag when member.model is `"default"` or absent.
- **OPS Task on live atmux-kanban team.json** — one-shot `jq` edit + `atmux rotate discorder`. Reviewer + unblocker + auditor stay default (Opus); no rotation needed for them.
- **README + briefs** — model selection table documenting the per-role assignment (Opus everywhere except discorder) + driver's narrow carve-out rationale + how to apply per-member override.
- **Cost trade-off accepted**: discorder is the only Sonnet team member. Marginal fleet cost reduction (~3% at 9-member team if discorder is 1/9 of token burn) — but the right call: the carve-out matches actual judgment-shape, not a cost-optimisation grab. Rate-limit judge helper's Sonnet usage is gated on banner presence (typical zero invocations per 5-min tick) — additional but small.
- **Quality risk accepted**: minimal. Discorder writes Discord prose only; tone drift is recoverable (briefs reload). Reviewer + unblocker + auditor stay Opus per audit-bar / blast-radius judgment requirements.
- **Sd dep**: OPS apply Task deps on Sd Story REVIEW landing (discorder member must exist before its `.model` can be set). Sc REVIEW dep DROPPED — unblocker no longer needs the Sonnet override.

## Open questions

1. **OQ F1 (HIGH-rev): override global CLAUDE.md "Opus everywhere" rule for atmux read-only roles?** v1 (d-a26b4211): Sonnet for reviewer+discorder+unblocker+auditor. **SUPERSEDED by d-c3f8d980 (HIGH-rev) @ 07:55 MYT** — narrowed to Sonnet=discorder ONLY; reviewer/unblocker/auditor stay Opus. Reasoning: Sonnet-fit limited to read-and-summarise WITHOUT judgment-on-correctness. Reviewer/unblocker/auditor all make consequential calls on others' work (audit-bar / blast-radius / verdict pattern) — judgment-heavy = Opus.
2. **OQ F2 (medium-rev): gitter model — Sonnet or Opus?** Resolved: Opus. Unchanged — lint-staged-trap edge cases + scope-check warrant careful judgment. (medium-rev — flip on observed safety record.)
3. **OQ F3 (low-rev): default model semantics?** Resolved: `"default"` (or absent) → claude CLI default (Opus today via global xhigh effort env). Explicit model IDs propagate verbatim. (low-rev — schema-stable.)

All resolutions logged to `.atmux/decisions.md`. Both d-a26b4211 (superseded) AND d-c3f8d980 (current) fire Discord pings at HIGH reversibility so driver sees the override + revision land in real time.
