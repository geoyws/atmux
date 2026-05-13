# ADR-110: tmux window naming — drop `__<team>__` prefix

**Status:** accepted
**Date:** 2026-05-05
**Owner:** porter-foundation-3

## Context

Bash atmux at HEAD `2aadc3f` names every member's tmux window via `lib/common.sh::atmux::window_name`:

```
__<team>__<emoji><member>     # when member.emoji is set
__<team>__<member>            # when no emoji
```

The TS port mirrored this in `src/core/common.ts::buildWindowName(team, member, emoji?)` (shipped in commit `707e4dd`, task #5).

The `__<team>__` prefix was originally added in bash to:

1. **Disambiguate** atmux-spawned windows from operator-created tmux windows on the same session — useful when atmux ran in single-session mode (ADR-106) where the driver, members, and the operator's own working windows could share one tmux session.
2. **Cheap inverse-parse** — `atmux::resolve_caller_scope` (bash) and `isMemberWindowName` (TS) could regex-match the prefix to refuse driver-scope from a member pane.

Operator feedback 2026-05-05 (via memory `feedback_atmux_window_naming_no_prefix.md`):

> just use the team member's names immediately to save space

The pre-amend form burns 8+ characters per window for the prefix (`__atmux__`, `__atmux-bun__`, `__sopx-mvp__`). With 8-12 windows per team and tmux's window-list often constrained to ~80 columns, the prefix dominates available horizontal space and pushes member names off-screen.

## Decision

Drop the `__<team>__` prefix from member-window names. New form:

```
<emoji><member>     # when member.emoji is set    (e.g. 🗺️lead, 📦porter-a1)
<member>            # when no emoji               (e.g. lead, porter-a1)
```

The `team` parameter is dropped from `buildWindowName`'s signature — there is no longer a use for it inside the function, and a phantom param would mislead future callers.

`isMemberWindowName` switches from regex-on-name to **roster-membership** check — the new format has no name-only signal, so the inverse-parse necessarily compares against `team.members[]`. Names that begin with `__` are explicitly rejected (they're either pre-amend artifacts or atmux-internal placeholders like `__<team>__home` from `start.ts`).

### Form chosen — `<emoji><member>` over bare `<member>`

The operator said "save space," which both `<emoji><member>` and pure `<member>` satisfy (the prefix dominates the savings — 8+ chars dropped, 1-2 chars added back at most). We keep the emoji because:

- **Visual disambiguation** when scanning many windows (lead's 🗺️, reviewer's 🔍, porter's 📦 are distinguishable at a glance).
- **Existing role→emoji infrastructure** is already wired (`src/core/common.ts::defaultEmojiForRole`, `lib/emoji.sh`); dropping it loses signal for no further space savings.
- **Lead concurred** when consulted: "if torn, lean (b) — emoji is 1-2 chars, doesn't cost much, and visual signal helps."

A `<member>`-only form remains an option for a future amendment if the emoji actually starts costing something (terminal rendering issues, long teams that exhaust tmux index limits, etc.); the change would be a one-line edit to `buildWindowName`.

### Placeholder windows untouched

`start.ts`'s `__<team>__home` placeholder window — created during `atmux start` to host an empty session before any members spawn — keeps the `__<team>__` prefix. The placeholder is short-lived (killed once a member spawns) and the prefix marks it as atmux-internal vs operator-created. `isMemberWindowName` correctly returns `false` for it (the `__`-prefix early-reject handles the case).

### Bash port-back deferred

Bash atmux at HEAD `2aadc3f` retains the prefixed form. ADR-106 §"Phase 5 deferral" governs cross-language drift while the bash side stays live in production. Port-back to bash piggybacks on the next bash-side window-naming change (no urgency — the prefix still works, just suboptimally).

This is the **first deliberate cross-language behavioural drift** the TS port is introducing in Phase 2. Other Phase 2 verb-level deferrals (TUI launch, doctor preflight, brief paste) are *missing functionality* the TS port will fill in later; the window-naming change is *different functionality* by operator request. Documented here so the parity harness comparator (`tests/parity/compare.ts`) treats window-name divergence as expected, not as a port bug.

## Consequences

### Positive

- **~10 chars saved per window** in tmux's window-list display. With 8-member teams that's ~80 chars reclaimed across the bar — meaningful at typical 100-200 column widths.
- **Cleaner signature** — `buildWindowName(member, emoji?)` is more obvious about what it does than `buildWindowName(team, member, emoji?)`.
- **No information loss** — the emoji still carries role signal; the team-name was always available via `team.json` and never needed to be in the window name.

### Negative / accepted

- **`isMemberWindowName` requires a roster** — callers can no longer name-check in isolation. Acceptable: every realistic caller already has the team loaded (verbs run `loadTeam` early); adding a second arg is cheap.
- **Pre-amend windows from a `707e4dd`-built atmux-bun become orphans** post-amend — they keep the old prefixed name and `isMemberWindowName` returns false for them (they look like non-atmux windows). Recovery: `atmux start --force` (kill the session + recreate) or manual `tmux rename-window`. Not a production concern since atmux-bun has not yet shipped to operators (Phase 2 in-flight).
- **Ad-hoc operator windows that happen to match a member name now match `isMemberWindowName`** — e.g. an operator who creates a tmux window called `lead` for unrelated work. Pre-amend the `__<team>__` prefix made this collision impossible. Mitigation: the collision is operator-induced and rare; member names are constrained (lowercase alnum + `-`/`_`) so they won't accidentally match common ad-hoc names like `Notes` / `tmp` / `repl`.

### Cascade

This commit (`fix(core): buildWindowName — drop team prefix`) updates:

- `src/core/common.ts` — function signature + body + docstring
- `src/verbs/start.ts` (call site at line 324) + `src/verbs/add-member.ts` (call site at line 446)
- `tests/unit/core/common.test.ts` — rewrite the `buildWindowName / isMemberWindowName` describe block
- `tests/unit/verbs/start.test.ts` + `tests/unit/verbs/add-member.test.ts` — update window-name assertions from `__<team>__🦊foo` → `🦊foo`

All in one commit so the test suite stays green from before to after.

## Alternatives considered

### A. Keep the prefix; add `--no-prefix` opt-in flag

Rejected. The operator already chose; an opt-in flag pollutes the surface for a decision that doesn't have a real "both-sides" tradeoff post-decision. If the operator changes their mind, a follow-up amendment is one line.

### B. Pure `<member>` (no emoji)

Considered. Maximally space-saving. Rejected because the emoji is 1-2 chars (negligible) and carries useful role-disambiguation signal. The operator's stated goal ("save space") is satisfied either way; the lead's preference + the existing emoji infrastructure tie-break toward keeping the emoji.

### C. Configurable form via `team.json::windowNameForm`

Considered. Per-team configurability. Rejected as premature — no operator has asked for both forms to coexist. Add this when there's a concrete need; a single static convention is the simpler default.

### D. Port-back to bash atomically

Considered. Keep bash and TS in lockstep by changing both. Rejected per ADR-106 §"Phase 5 deferral" — bash atmux is live in production; a window-naming change requires careful migration of in-flight tmux sessions on operators' machines. The port-back is genuinely non-urgent (the prefix is suboptimal, not broken) and piggybacks on the next bash window-naming change cleanly. Documented as a TODO in `feedback_atmux_window_naming_no_prefix.md`.

## References

- `src/core/common.ts::buildWindowName` (post-amend) + `isMemberWindowName`
- Memory: `feedback_atmux_window_naming_no_prefix.md` (operator decision, 2026-05-05)
- Bash precedent: `lib/common.sh::atmux::window_name` (HEAD `2aadc3f`, retained pre-amend form)
- ADR-096 (module taxonomy — common is the right home for this helper)
- ADR-106 (WIP bash deferral — governs cross-language drift)
- Task #22 (this commit) — blocks #14 start, #15 attach, #16 add-member while landing
