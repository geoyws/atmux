# ADR-081: Bootstrap brief-paste reliability — bracketed-paste Enter, role aliasing, supervisor-side recovery

**Status**: accepted
**Date**: 2026-05-12
**Incident**: 2026-05-12 ~06:57–07:25 MYT atmux team starvation diagnosis + manual recovery (cockpit BAU surfaced; driver re-bootstrapped 11/12 panes via `tmux load-buffer + paste-buffer + C-m`).

> **Naming note 2026-05-14**: the cockpit-tier self-healing role referenced in §E supervisor-side recovery (`superdoctor`) is now called **medic** per [ADR-133](133-medic-rename.md). The starvation-detection rule + complaint-resolution hook described under §E remain canonical under the new name; supersession is naming-only.

## Context

### 2026-05-12 incident — 20h+ atmux team dormancy

The atmux team's last commit was `d899f9e` (`feat(doctor): cursor-plugin-cache parity check`) at 10:27 MYT 2026-05-11. Cockpit-side `/bau 8` at 06:57 MYT 2026-05-12 surfaced:

- 0 commits in 8h window (last was 20h30m ago)
- 0 task completions in window
- 9 of 12 members at the Claude welcome screen with `ctx --` / `0 tokens` — claude TUI **alive in every pane** but **never received its bootstrap brief**
- Lead (window 2) at 10% ctx, idle, asking *"What did you want this to do?"* — clear sign the lead itself had taken keystrokes that landed at its compose box without context to act on
- Three open superdoctor complaints (`c-7193c689`, `c-8ecd3a61`, `c-368c375b`) already documenting the pathology

Manual recovery (`atmux stop --force && atmux start`) **reproduced the same starving state** — fresh cage, all 12 claude TUIs running, none with a brief. The bug is in the spawn-then-brief pipeline, not in any specific cage state.

### Three stacked sub-bugs surfaced under investigation

**(1) `atmux start` defers brief-paste entirely.** `src/verbs/start.ts` header comment (lines 60-93) marks the bootstrap-brief-paste as `DEFERRED` — Phase 2 follow-up to the TS port; the bash equivalent at `.archive-bash-atmux-20260507/lib/start.sh:451-461` (`_atmux_paste_brief` — `tmux load-buffer` + `tmux paste-buffer -d` + `sleep 1` + `tmux send-keys Enter`) was not ported. The MVP intentionally spawns claude TUIs and **stops there**; the operator was expected to attach + manually fire briefs. In practice nobody does — fresh cages are silently starved on every `atmux start`.

**(2) `atmux rotate-lead` had a role→file aliasing gap.** `src/verbs/rotate.ts::getBriefPath()` resolved `team-lead` → `templates/briefs/team-lead.md`, which historically contained only a deprecation tombstone redirecting to `lead.md`. `member.md` exists as the documented fallback, but the deprecated tombstone for `team-lead` shadowed the canonical brief whenever it existed. Discovered during this incident's investigation. **Fixed in-flight by the team** in commit `7aa7cf2` (`fix(rotate): team-lead role aliases to lead.md (briefs deprecation)`) — a `BRIEF_ALIASES: Record<string,string>` map resolves aliases BEFORE existence check, plus a regression test that explicitly references "observed 2026-05-12 after a 20h+ dormancy rebuild." The fix landed within ~15 min of the bootstrap-paste itself, demonstrating §E recovery works.

**(3) Trailing `Enter` after paste-buffer is unreliable on claude TUIs.** `src/verbs/rotate.ts:312` calls `tmux.pane.sendKeys({ keys: "Enter", enter: false })` — which produces `tmux send-keys -t <target> Enter`. On a plain shell this submits. On a claude TUI **immediately after `tmux paste-buffer -d`** (bracketed-paste envelope), the trailing `Enter` is interpreted as newline-in-message rather than submit; the brief lands in the compose box but is never sent. Workaround: send `C-m` (literal carriage return) as a SEPARATE `tmux send-keys` call after a short settle — proven during this incident's manual recovery, fired across 11 panes successfully.

### Supervisor-side blind spot (cross-cuts complaints c-7193c689 + c-8ecd3a61)

The `whip` skill has a documented §4a `auto-bootstrap-starving-members` step, but it lives on the **lead's** side. A stuck/confused lead can't fire whip; chicken-and-egg. From `c-7193c689` root cause:

> "whip's lead-side §4a auto-bootstrap-starving-members must re-read the prompt every tick OR be implemented inside cockpit autolaunch, not lead's whip — since a stuck lead can't fire whip in the first place."

Compounded by `c-8ecd3a61`: `atmux status` checks `pane_current_command` (empty when a claude TUI is at the welcome screen), so it reports `sessionState=down` regardless of whether claude is alive but starved. Doctor can't tell the difference between "no claude process" and "claude alive at welcome screen with no brief," so its auto-fix branches skip starving teams thinking they're already torn down.

### Stash-collision side-incident (relevant to ADR-082 worktree task)

During the writing of THIS ADR, the cockpit driver's untracked `docs/adr/081-*.md` file was **swept off the working tree** between the Write tool call and the next `git status` check — exactly the failure mode that `t-eee0a7f6` (Git worktree per-member isolation) is filed to prevent. The team's commit + auxiliary `git reset` operations during the same window touched untracked-file state in a way that vanished the file (no stash entry retained it, no hooks ran, no git clean was logged in reflog — likely a member's pre-commit auto-cleanup or a manual `rm` ran from another pane). The ADR was re-authored from memory and committed immediately on the second attempt. Documenting it here because the failure shape is the live demonstration of why per-member worktrees matter at 30+ concurrent worker scale.

## Decision

Five narrowly-scoped fixes; (B) already landed in `7aa7cf2`.

### (A) Brief-paste submit uses `C-m`, not the literal `Enter` token

Every paste-buffer-then-submit call site switches the trailing submit from `tmux send-keys ... Enter` to `tmux send-keys ... C-m` as a SEPARATE call AFTER a ≥500ms settle. Rationale: `Enter` semantics drift under claude's bracketed-paste mode (the envelope eats the following Enter as a multi-line continuation). `C-m` is the literal carriage return — bypasses the bracketed-paste interpretation entirely.

Concretely in `src/verbs/rotate.ts:312`:
```ts
// Before
await tmux.pane.sendKeys({ target: sendTarget, keys: "Enter", enter: false });
// After
await sleep(500);
await tmux.pane.sendKeys({ target: sendTarget, keys: "C-m", enter: false });
```

Same pattern applies wherever paste-buffer is followed by a submit (audit: `src/core/send.ts`, the about-to-be-ported start.ts brief-paste, and any future paste-buffer call site).

### (B) Role-name → brief-filename alias map — LANDED in `7aa7cf2`

`BRIEF_ALIASES: Readonly<Record<string,string>>` resolves `team-lead → lead` before the existence check; tombstone `templates/briefs/team-lead.md` is now a symlink to `lead.md`. Regression tests in `tests/unit/verbs/rotate.test.ts` enumerate every role used in shipped team.json templates and assert each resolves to a non-empty file.

### (C) Port deferred brief-paste into `src/verbs/start.ts`

Lift `.archive-bash-atmux-20260507/lib/start.sh:418-487` (`_atmux_spawn_member` + `_atmux_paste_brief`) into the TS spawn path. After each member-window is created + claude is launched + `ATMUX_SPAWN_WAIT` (default 6s) elapses:

1. Resolve brief via `getBriefPath(role, briefsDir)` (uses §B alias map).
2. Render `{{TEAM}}`/`{{MEMBER}}`/`{{ROLE}}`/`{{ATMUX_DIR}}` placeholders.
3. `tmux load-buffer` + `tmux paste-buffer -d -t <target>`.
4. `sleep(500)` settle.
5. `tmux send-keys C-m` (per §A).

Lead spawns first; lead's brief lands first; teammate briefs follow. Failure surface: if any brief paste throws, log per-member + continue (so a partial-fail-during-spawn doesn't wedge the whole team).

**Completion update (2026-05-14, t-94d7ad60).** The §C port above was insufficient for the recurrence-class of undead-pane fingerprint observed 3rd+ time (operator memory `feedback_member_pane_no_atmux_member.md`): the fixed `ATMUX_SPAWN_WAIT` sleep races against claude TUI's variable cold-start (5-15s observed under load), so the paste can land BEFORE the compose box exists and bytes scroll past startup output silently. For **claude TUI specifically**, the spawn path now switches to a poll-and-send mechanism:

- **`src/core/boot-claude.ts`** — `bootClaudeMember()` orchestrates: (a) capture-pane sentinel check for already-booted (tokens count > 0); (b) poll capture-pane up to 30s for TUI ready (`❯` glyph or `tokens` footer); (c) `tmux send-keys` a single-line boot prompt (`"Read /tmp/atmux-brief-generic-{team}.md and your role brief if your role appears in templates/briefs/, then bootstrap as that team member. Your role is {member}."`) with `enter:true`; (d) poll for tokens-moved sentinel up to 30s; (e) retry the send-keys once on first-attempt miss; (f) on full failure, surface to `lead-outbox.md` via `renderBootFailureNotice` so the operator sees the undead pane on next review.
- `src/verbs/start.ts` + `src/verbs/rotate.ts` route claude-TUI members through `bootClaudeMember`. **Non-claude TUIs** (kimi, cursor, opencode) keep the §C-original paste-buffer + C-m flow — different welcome rendering, no bracketed-paste-newline hazard.
- The boot prompt is **single-line** (Reviewer pre-flag confirmed: bracketed-paste with newlines silently fails to submit, same trap as `clear-member.sh`).
- The brief CONTENT is no longer pasted at start time — claude reads `templates/briefs/<role>.md` itself on first turn per the boot prompt's instruction. The original render-and-paste of the brief body becomes redundant once the boot prompt fires.

Tests in `tests/unit/core/boot-claude.test.ts` pin sentinel / ready-poll / retry / both-attempts-fail / send-keys-verb-failure / capture-error scenarios.

### (D) `atmux doctor` learns the `starving-claude` state (per c-8ecd3a61)

Add a fourth cage state alongside `down` / `bootstrapping` / `active`:

- `down` — no tmux server OR no claude process in pane
- `starving` — claude PID alive, `ctx --` (token count 0, banner shows "Welcome to Claude Code"), uptime > `STARVING_THRESHOLD_S` (default 60s). Yellow.
- `bootstrapping` — claude PID alive, ctx==0 but uptime < threshold. Silent (transient).
- `active` — claude PID alive, ctx > 0 OR token-count > 0. Green.

Detection probe: query each pane's child PID via `tmux list-panes -F '#{pane_pid}'` → `pstree -p $PID` → look for `claude` executable. Capture last 20 lines of pane for welcome banner pattern (`Welcome to Claude Code`, `Try "..."` placeholder). Both signals → `starving`.

Doctor's `--fix` for `starving` state: paste the brief (same path as §C) and verify ctx > 0 within 30s. Falls through to `--force` flag for the rare case where a member should genuinely remain at welcome screen.

### (E) Move starving-bootstrap recovery to the cockpit/supervisor (per c-7193c689)

The lead's whip §4a `auto-bootstrap-starving-members` step is removed and the equivalent logic lives in `cockpit autolaunch` (or `superdoctor`'s starvation-detection rule). Rationale: a stuck lead cannot fire whip; supervisor-side recovery breaks the chicken-and-egg. `superdoctor` already has the authority (ADR-077 §D3 — rotate leads, clear members, cycle cages) and the cross-team scope; adding "if a team has ≥1 starving member AND lead has been idle ≥5min, paste briefs to starving members" is a narrow extension.

### (F) First-turn precedence over residue-discard memory rules

**Date added**: 2026-05-13. **Driver-ref**: `.atmux/driver-inbox.md` 17:52 MYT 2026-05-13.

**Symptom**: fresh leads/members (typically after `atmux team rebuild` / cockpit-driven cage cycle) discard their FIRST `atmux claim --next --as <role>` keystroke because operator-memory rules like `feedback_atmux_claim_next_as_role_residue.md` win precedence on the first turn after a brief lands. Brief pastes cleanly (ctx 7% / 69900 tokens observed), but the pane idles *"Standing by for a real prompt"* instead of starting its loop — blocks dormant-team revival via auto-rotation + cockpit-rebuild flows.

**Root cause**: the residue-discard memory rule is correct in steady-state (lane-tick re-injects `atmux claim --next --as <role>` into members already mid-task), but wrongly fires on bootstrap kick-off too. `templates/briefs/lead.md` + `templates/briefs/member.md` do not pre-empt the memory rule for the first turn → memory beats brief.

**Decision**: brief-template language explicitly anchors first-turn precedence above operator memory. Both `templates/briefs/lead.md` and `templates/briefs/member.md` carry a §"Bootstrap kick-off precedence" landing BEFORE §"Your loop", reading:

> If any memory entry tells you to discard `atmux claim --next --as <role>` (or similar bootstrap keystrokes) as auto-loop residue, that rule **does not apply to your FIRST turn after this brief lands**. The first auto-claim is your legitimate kick-off — accept it, start the loop. The residue-discard rule scopes to REPEATED identical injections AFTER work is already in flight.

**Consequences**:

- Future memory entries authored against bootstrap-keystroke noise MUST scope to "AFTER work is in flight" or carry an explicit first-turn carve-out. The brief is authoritative.
- §C (start.ts brief-paste port) reliability is unaffected — the keystroke lands; the issue was the fresh pane's first-turn interpretation of WHEN to apply discard rules.
- **§F renderer preamble DEFERRED**. A one-line preamble in `src/verbs/start.ts` `pasteBriefForMember` / `renderBrief` ("BOOTSTRAP — this is your first turn. Read the brief fully BEFORE applying memory-based discard rules.") was considered but deferred. **Unblock condition**: if any team reports kick-off discard within 14 days of this commit landing, file a follow-up task to add the renderer preamble. Until then, template §F is sufficient.
- **Out of scope**: sopx-side `feedback_atmux_claim_next_as_role_residue.md` memory shape — driver surfaces to the sopx operator separately. atmux's job is to make the brief authoritative regardless of downstream memory.

**Reversibility**: low — revert both template § + the ADR §F entry + the proposed-status; one commit.

**Cross-references**: §A–§E above; project CLAUDE.md §Same-commit doc updates (brief vocabulary IS documented surface — this fix lands ADR + brief-template edit in ONE commit).

## Consequences

- **One round of edits across `src/verbs/start.ts`, `src/abstractions/tmux.ts` callsites, and `src/verbs/doctor.ts`.** §B already landed in `7aa7cf2`. Remaining estimate: ~100 LOC additions + ~30 LOC modifications + ~50 LOC of regression tests.
- **`templates/briefs/team-lead.md` is now a symlink to `lead.md`** (landed in `7aa7cf2`).
- **Existing teams with starving members get auto-recovered on the next superdoctor tick** rather than waiting on lead-side whip §4a. Acceptable: superdoctor cadence is hourly (cron); the bar is "not 20h dormant," not "<1 min recovery."
- **Reversibility**: each of (A)–(E) is independently reversible. (A) is a one-line revert. (B) drops the alias map. (C) reverts to deferred state (regression). (D) drops the new doctor state. (E) re-adds the whip §4a step.
- **Open superdoctor complaints to close on landing**: `c-7193c689` (starving-bootstrap, addressed by §C + §E — resolved manually for this incident; structural fix tracked here). `c-8ecd3a61` (doctor blind spot, addressed by §D). Keep `c-368c375b` (phantom-inbox residue) open — different bug class, not addressed here.

## Cross-references

- ADR-077 — superdoctor cockpit-level self-healing (the §E recovery hook lives here).
- ADR-052 — eternal-improvement loop (the auto-detect-then-fix pattern §E extends).
- ADR-018 — per-team tmux socket isolation (the cage topology this incident occurred inside).
- `t-eee0a7f6` — Git worktree per-member isolation (concurrent stash-collision-prevention, related but distinct concern).
- Memory `feedback_read_pane_state_before_send.md` (global CLAUDE.md L182) — the operator-side rule that mirrors §A's "settle then C-m" discipline.
- Bash port reference: `.archive-bash-atmux-20260507/lib/start.sh:418-487` (the canonical brief-paste flow).
- Commit `7aa7cf2` — landed §B's BRIEF_ALIASES patch.

## Audit trail of the 2026-05-12 manual recovery

For posterity — the exact sequence the cockpit driver fired to recover the team, used as the proof-of-concept for §A's `C-m` workaround:

```bash
# Per pane (windows 2-12), for the 11 non-driver members:
tmux -S /tmp/atmux-atmux/sock load-buffer -b atmux_boot_<member>_$$ /tmp/atmux-rotate-brief-<member>.md
tmux -S /tmp/atmux-atmux/sock paste-buffer -b atmux_boot_<member>_$$ -d -t atmux:<window>
sleep 0.8
tmux -S /tmp/atmux-atmux/sock send-keys -t atmux:<window> C-m
```

Result: 11/12 panes registered briefs (54k–117k tokens within 15s). Window 1 (cage driver) deliberately left untouched. Members began claiming kanban tasks within 5 minutes; one teammate independently picked up §B's `BRIEF_ALIASES` patch within ~15 min of bootstrap and committed it as `7aa7cf2` (closing the loop on §E's "team can self-heal once it's awake" hypothesis).
