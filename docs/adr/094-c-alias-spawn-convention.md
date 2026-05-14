# ADR-094: c-alias spawn convention as first-class — bake defaults into `atmux::tui_claude`

**Status**: proposed
**Date**: 2026-05-13
**Driver-ref**: `.atmux/driver-inbox.md` 12:59 MYT 2026-05-07 (line 649) — driver asked to make the `c-alias` shell-wrapper conventions (`CLAUDE_GUARD_AGENT=1`, `--plugin-dir`, `--permission-mode auto`, `CLAUDE_CODE_EFFORT_LEVEL=xhigh`) first-class atmux defaults instead of per-team `tuiCommands.claude` overrides.
**Parent Task**: t-43b22e92 (c-alias chain head). **Authored under**: t-1a574d27 (Seq 1/6).

## Context

### What the c-alias gives you today

George's local + hax shell defines a `c-alias` (and `c-u` / `c-ic` per-account variants) that wraps the `claude` CLI with the canonical autonomous-team-member spawn shape. Per global `CLAUDE.md` §Spawn Pattern, the canonical invocation is:

```bash
CLAUDE_GUARD_AGENT=1 ${DRIVER_WRAPPER} --permission-mode auto --model claude-opus-4-7
```

with `CLAUDECODE=1` and `CLAUDE_CODE_EFFORT_LEVEL=xhigh` in the env, and the plugin directory available via `--plugin-dir` so global skills resolve in spawned panes. The c-alias bundles four orthogonal-but-co-occurring concerns:

1. **`CLAUDE_GUARD_AGENT=1`** — marks the process as a guarded agent (suppresses interactive permission prompts that would otherwise wedge an autonomous loop).
2. **`--plugin-dir <path>`** — extends the plugin/skill search path so a centrally-managed plugin directory (e.g. `$HOME/.claude/plugins`) is visible to every spawned member.
3. **`--permission-mode auto`** — continuous autonomous execution per Claude Code's "Auto Mode Active" system-prompt branch. Members in `dontAsk` / `acceptEdits` stop on every tool call and require driver intervention; that defeats parallelisation. This is the **canonical default** per global `CLAUDE.md` §Spawn Pattern.
4. **`CLAUDE_CODE_EFFORT_LEVEL=xhigh`** — already baked into `atmux::tui_claude` today (`src/core/tui-cmd.ts:108`).

### Current state — `tui_claude` only bakes 1 of 4

`src/core/tui-cmd.ts:99-121` currently emits:

```
[CLAUDE_CONFIG_DIR=…] CLAUDECODE=1 CLAUDE_CODE_EFFORT_LEVEL=xhigh claude --permission-mode dontAsk[ --model X]
```

Of the four c-alias concerns above, only `CLAUDE_CODE_EFFORT_LEVEL=xhigh` (item 4) is baked. The other three (`CLAUDE_GUARD_AGENT=1`, `--plugin-dir`, `--permission-mode auto`) require a per-team `tuiCommands.claude` override — typically an 80+ char literal that drifts from `CLAUDE.md` §Spawn Pattern over time. Two failure modes observed:

- **Drift**: teams written before a `CLAUDE.md` §Spawn Pattern update carry stale flag sets; nobody re-reads the override to compare.
- **Copy-paste burden**: every new team begins with the same 80-char incantation; minor typos (missing `=` between env-key and value, wrong quoting around `--plugin-dir` paths with `$HOME` interpolation) silently degrade spawn behaviour.

### Why now

Demo-week 2026-05-13 added two new teams under the cockpit (sopx-guild, atmux). Both required per-team `tuiCommands.claude` overrides; one already drifted relative to the canonical c-alias mid-week. Baking the defaults closes the drift loop and lets `team.json` stay short.

### Out-of-scope ask "D" — orthogonal

The driver-inbox ask also flagged a fourth concern (here labelled **D**): `atmux init` should prompt for `claudeAccount` per-member with a sensible default. That is a wizard / interactive-shell concern, not a tui-spawn-line concern; it composes with this ADR but is filed separately (see §Cross-references → T5).

## Decision

Three cohesive changes (asks **A → B → C**, in the order they appear in driver-inbox 12:59 MYT 2026-05-07) plus one orthogonal cross-reference (**D**, separate Task).

### Ask A — `atmux::tui_claude` bakes the c-alias defaults

Target form (mirrors global `CLAUDE.md` §Spawn Pattern):

```
[CLAUDE_CONFIG_DIR=…] CLAUDECODE=1 CLAUDE_CODE_EFFORT_LEVEL=xhigh CLAUDE_GUARD_AGENT=1 \
  claude --plugin-dir=$HOME/.claude/plugins --permission-mode auto
```

Concretely in `src/core/tui-cmd.ts:99-121` `tuiClaude()`:

- **Add** `CLAUDE_GUARD_AGENT=${guard}` env (gated on new knob `ATMUX_CLAUDE_GUARD_AGENT`).
- **Add** `--plugin-dir=${pluginDir}` flag (gated on new knob `ATMUX_CLAUDE_PLUGIN_DIR`; empty string skips the flag entirely).
- **Flip** `--permission-mode` default `dontAsk` → `auto` (existing knob `ATMUX_CLAUDE_PERMISSION` retains override path).

Three env knobs govern the bake. All have rollback-friendly defaults; setting any knob to its "disable" value reverts that specific bit of the c-alias bake without touching the others:

| Env knob | Default | Override semantics |
|---|---|---|
| `ATMUX_CLAUDE_GUARD_AGENT` | `1` | Set to `0` (or any value coercible to `0`) to omit the `CLAUDE_GUARD_AGENT=…` env entirely from the spawn line. |
| `ATMUX_CLAUDE_PLUGIN_DIR` | `$HOME/.claude/plugins` | **Empty string** skips the `--plugin-dir=…` flag entirely. Non-empty values are quoted + interpolated relative to the runtime `$HOME` (so a literal `$HOME/.claude/plugins` works whether passed via cron or shell). Operators who keep plugins elsewhere (`$HOME/work/journals/.sb/claude-skills` for George's personal infra) override here. |
| `ATMUX_CLAUDE_PERMISSION` | `auto` (was `dontAsk` pre-bake) | Same shape as today; arbitrary value passed verbatim. Operators who deliberately want manual-permission flow (debug runs, single-step audit) set `dontAsk`. |

**Defensive defaults** (per reviewer pre-flag): the plugin-dir default is `$HOME/.claude/plugins` (Claude Code's documented plugin path), **not** George's personal `$HOME/work/journals/.sb/claude-skills`. George's own teams continue to override via `team.json:.env.ATMUX_CLAUDE_PLUGIN_DIR` or a per-shell export. Baking a personal-infra path as the cross-team default would force every downstream user to override on first contact.

### Ask B — document `claudeAccount` in `templates/team.example.json`

The per-member `claudeAccount` field exists today as a schema passthrough (`TeamMember` is `.passthrough()` so the field rides through Zod) and is consumed by `src/core/tui-cmd.ts:111-119` to prefix the spawn line with `CLAUDE_CONFIG_DIR=$HOME/.claude-<account>` when non-`default`. The field is **operational** but **undocumented in the example template** — new teams discover it only by grepping source or reading ADR-024.

Add to `templates/team.example.json` at the `members[]` member-entry level:

```jsonc
{
  "name": "…",
  "role": "…",
  // _comment_claudeAccount: optional per-member claude account isolation
  // (ADR-024). Valid values: "default" ($HOME/.claude), "personal", "icloud",
  // "ifca", "unum". Non-"default" values prefix the spawn line with
  // CLAUDE_CONFIG_DIR=$HOME/.claude-<account>. Match the driver's account
  // (no cross-account spawns).
  "claudeAccount": "default"
}
```

The `_comment_claudeAccount` convention is borrowed from the existing template's `_comment_*` pattern (Zod `.passthrough()` ignores unknown `_comment_*` keys, so they survive `schema.parse` round-trips). Brief, single-paragraph rationale citing ADR-024 — not a tutorial.

### Ask C — `atmux doctor` row warns on explicit-default `CLAUDE_CONFIG_DIR` override

New doctor check `doctor-config-claude-account-tcoverride` (anomaly class: warning / yellow). Logic:

- Read each member's `team.json:.members[].tuiCommands.claude` (when present).
- If the override string contains `CLAUDE_CONFIG_DIR=$HOME/.claude` OR `CLAUDE_CONFIG_DIR=/root/.claude` (= the explicit-default config dir): emit warning row.
- Hint: `tuiCommands.claude carries CLAUDE_CONFIG_DIR=$HOME/.claude — this BREAKS fresh-spawn TUI auth (the TUI auths against the default config dir; explicit-set forces re-auth flow in every new shell). Either drop the explicit-set (use 'env -u CLAUDE_CONFIG_DIR' if you need a clean env) or pin claudeAccount: "personal" in the member entry to let atmux compute the right CLAUDE_CONFIG_DIR.`

Severity is **warning** (not error) because the override is operational — it just thrashes auth state. Operators who deliberately want this (rare; usually accidental) can `atmux doctor --suppress doctor-config-claude-account-tcoverride` to silence per-team.

### Ask D — orthogonal, separate Task T5

`atmux init` should prompt `claudeAccount` per-member during the wizard, defaulting to `default` for the first member and offering "use same for all? [Y/n]" for subsequent members. Per-member override path via `atmux reconfigure`.

D is **not part of this ADR's A+B+C cohesive scope**. Filed as `t-43b22e92` chain's T5 (orthogonal — init wizard / interactive shell concern, not tui-spawn-line). Cross-link only.

## Consequences

- **Caller migration**: existing `team.json` files with `tuiCommands.claude` overrides keep working — overrides remain authoritative. New teams written post-A get a shorter `team.json` (no override needed for the canonical c-alias shape).
- **Behaviour change at default**: spawned members under the new defaults are `--permission-mode auto` (was `dontAsk`). This is the intended canonical behaviour per global `CLAUDE.md` §Spawn Pattern. Operators who deliberately want `dontAsk` for a specific team set `ATMUX_CLAUDE_PERMISSION=dontAsk` in the team's env (or per-member `tuiCommands.claude` override).
- **Plugin-dir default**: `$HOME/.claude/plugins` exists for every Claude Code install. Spawning into a host where the directory is missing degrades gracefully — the `--plugin-dir` flag just yields a "no plugins found" warning at TUI startup. Operators with plugins elsewhere set `ATMUX_CLAUDE_PLUGIN_DIR` accordingly.
- **No schema change**: the three knobs are env-only (read at spawn-time via `process.env`). No `team.json` Zod field additions, no migration. `ATMUX_CLAUDE_PERMISSION` already exists — only the default flips.
- **Doctor surface**: one new check + one new hint string; no new doctor severity tier. Existing `atmux doctor --suppress <slug>` mechanism handles per-team silencing.
- **Reversibility**: each ask has independent rollback. **A** reverts by setting all three knobs to disable values (`ATMUX_CLAUDE_GUARD_AGENT=0`, `ATMUX_CLAUDE_PLUGIN_DIR=""`, `ATMUX_CLAUDE_PERMISSION=dontAsk`). **B** reverts by removing the `_comment_claudeAccount` block from the example. **C** reverts by removing the doctor check. No data migration, no schema migration, no commit-time coordination required.

## Open questions

- **OQ-1**: Should the `--plugin-dir` flag default to a hard `$HOME/.claude/plugins` literal OR a probed-default that picks the first of `$HOME/.claude/plugins`, `$HOME/.claude-plugins`, `$HOME/.config/claude/plugins`? **Resolved default**: hard literal `$HOME/.claude/plugins`. Probing adds doctor-time complexity for a corner case — operators with non-standard layouts override via `ATMUX_CLAUDE_PLUGIN_DIR`. Driver may override via `atmux decisions add`.
- **OQ-2**: Should the doctor check (Ask C) ALSO warn on `CLAUDE_GUARD_AGENT=` set to anything other than `1` in an override? **Resolved default**: no — out of scope for this ADR. If `CLAUDE_GUARD_AGENT=0` overrides become a recurring footgun, file a follow-up. Today the bigger drift surface is the `--permission-mode` flag and the missing `--plugin-dir`, both addressed by Ask A bake.

## Cross-references

- Global `CLAUDE.md` §Spawn Pattern — the motivating canonical contract. This ADR makes the bash recipe a TS-emitted default.
- `/CLAUDE.md` (project root) §The ADR → docs → context chain — ADR-first decision recording.
- ADR-024 — per-member Claude account isolation (consumed by `src/core/tui-cmd.ts:111-119`; the `claudeAccount` field this ADR documents in Ask B).
- `src/core/tui-cmd.ts:99-121` — current `tuiClaude()` implementation; the change site for Ask A.
- `templates/team.example.json` — change site for Ask B.
- `src/verbs/doctor.ts` — change site for Ask C.
- **Chain Tasks** (per parent `t-43b22e92`): T1 = this ADR (`t-1a574d27`); T2 = Ask A impl (`t-6ec56572`); T3 = Ask B docs (`t-bd618833`); T4 = Ask C doctor (`t-589145dc`); T5 = Ask D init wizard (orthogonal, separate filing); T6 = tests for A+B+C (`t-d0c8b758`).
