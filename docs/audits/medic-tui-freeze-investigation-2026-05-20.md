# Medic TUI Freeze Investigation — 2026-05-20

**Task**: t-b5cf6cf6 · **Auditor**: docs (🦦) · **Status**: scoping (impl mitigations cross-lane / dotfiles-territory)

Recurring TUI-wedge cycle observed on cockpit `_medic` pane: rotate → ~10–15min productive turn → re-wedge → another rotation. Three manual rotation cycles on 2026-05-20 (driver-inbox 17:34, 18:04, then this filing). This doc captures the symptom inventory, the working-hypothesis trigger, the 4-step repro plan, and the mitigation routing — including which mitigations live where so the impl path doesn't stall waiting for the wrong owner.

## Symptom inventory

- `claude` process alive: `Ssl+` sleep state, no exit signal in `ps`, no abnormal RSS growth.
- TUI not redrawing: `tmux capture-pane -p` returns *new bytes* each invocation, but the headroom timer (`5h ↻NhNm`) freezes at the same value across 15+ minutes of wall-clock — deterministic dead-TUI evidence (the timer updates would prove the redraw loop is alive).
- Token-throughput readout (`Sautéed for Ns + tok/N`) frozen identically alongside the headroom timer.
- The shell process layer is fine — `atmux send` / `tmux send-keys` / `tmux capture-pane` all complete without error against the pane. The TUI is the wedged layer, not the shell.

## Working-hypothesis trigger

Slash-popup interaction at the compose box leaves state corruption that surfaces at end of *next* turn. Specifically: typing `/superdoctor` or `@<member>` into compose without submitting registers some popup state that the TUI's next-turn render leaks into a redraw-loop hang. Evidence:

- All three observed wedges had `/superdoctor once -- bruh-sweep rotate-stale-leads` queued in the compose box at re-wedge time (per the 17:34 driver-inbox capture).
- ADR-138 §"Why blanket-3x is wrong" calls out slash-popup / queued-confirm overlays as the dominant wedge class for text-into-composer flows; ADR-188 (proposed 2026-05-20) is the canonical 4-step pattern that mitigates this at the *sender* side (Step 2 Enter×3 dismisses popup-stack before paste). Sender-side mitigation does not help the medic pane, which is the *receiver* of its own keyboard input via Claude Code's compose UI.

## 4-step repro hypothesis (operator-driven; not runnable from docs cage)

1. Spawn fresh medic via `/bruh §3.5` canonical spawn pattern (`c-u` wrapper + opus-4-7).
2. Queue `/superdoctor` in compose box. **Do NOT submit.**
3. Wait for next `/bruh` cron tick to fire a directive into the pane.
4. Observe headroom timer over the next 15 min wall-clock. Frozen timer = repro confirmed.

This needs operator-level cockpit access + manual interaction; cannot run from a member cage.

## Mitigation paths + owner routing

| # | Mitigation | Owner | Status |
|---|---|---|---|
| **1** | Medic prompt rewrite — fire `/superdoctor` inline via `Skill` tool call within the same turn instead of self-queuing at compose. Same pattern for `atmux` verbs (use `Bash` tool, not type-then-submit). | **dotfiles** (claude-skills) — operator-managed per memory `feedback_claude_skills_dotfiles_territory`. atmux team MUST NOT author skill code. | Surfacing to operator; awaiting dotfiles flow. |
| **2** | `atmux cockpit-rotate <session-name>` verb — clean TUI restart (kill-then-respawn the claude process within the pane), not just `/clear`. Replaces the manual `/bruh §3a Status:` fallback (3 keystroke steps + brief paste). | **BE-lane** — atmux source. Currently in backlog per the task body's "cockpit-rotate verb (atmux backlog, not shipped)" note. | Filed; not yet decomposed. |
| 3 | Cron-fired liveness probe — sentinel observes headroom-timer drift via `tmux capture-pane` diff over a 5-min window; auto-rotates via mitigation #2 when timer freezes ≥10min. | **BE-lane** — sentinel scope extension (ADR-185 territory). | Future; depends on mitigation #2 shipping first. |
| 4 | `known-modals.ts` catalog entry — explicit dismiss-keystroke for the slash-popup pattern; pre-empts the wedge at the sender side (per ADR-188 ordering, known-modals match fires *before* the Enter×3 fallback). | **BE-lane** — atmux source. | Possible follow-up; less leveraged than #2 since it only catches the *sender* side. |

## Cross-refs (existing observations)

- Memory `project_atmux_status_pane_state_false_down` — `cage-state.ts:145` hardcodes `atmux-<team>`; `atmux status` mis-reports pane-state. Tangentially related (both surface "is this pane alive" answers wrong); fix is t-646b6450. Cross-verify medic liveness via direct `capture-pane`, not `atmux status`.
- Memory `project_detect_and_resubmit_skip_on_past_tense_glyph` (t-846d2540 P1) — `ACTIVE_TURN_RE` matches both active + past-tense `[✻✶✽]` glyphs; cron-poke residue accumulates on idle panes. Different failure-class (sender-side glyph false-positive), but sibling in the "wedge surface" cluster.
- Memory `feedback_residue_use_cm_not_enter` — `atmux send` (via `pasteAndSubmit`) is the empirically-validated stuck-residue recovery path; bare `Enter` / `C-m` / bracketed-paste-end + `C-m` all failed on 5 wedged panes 2026-05-19. If mitigation #2 is shipped but its restart step relies on bare `tmux send-keys C-m`, expect it to fail on the dead-TUI class observed here — the restart must be process-level (kill + respawn), not keystroke-level.
- ADR-138 §"Why blanket-3x is wrong" (superseded for text-into-composer scope per ADR-188 / b0ec250 §Amendment) — wedge taxonomy reference for the popup-stack failure class.
- ADR-188 (proposed) — 4-step canonical send-keys pattern; mitigates sender-side wedges. Receiver-side wedges (this investigation) are NOT in scope.
- e-b84c4d48 — cockpit recovery hardening Epic; mitigation #2 likely folds here as a sub-Task. Recommended: file the verb as a new sub-Task under e-b84c4d48 rather than as a standalone P1.

## Scope-out (deferred / not investigated)

- **Root-cause Claude Code TUI patch** — out of scope; we don't ship Claude Code. If reproducible at the TUI level, file upstream via the standard Anthropic feedback path.
- **Process-state forensics** (gdb attach, strace, /proc/<pid>/stack) — possible deeper investigation, but expensive in operator cycles and likely yields a Claude Code-internal symbol. Defer until mitigation #1 + #2 fail empirically.
- **Cockpit hardware/load contributors** — RAM at 128GB on hax per `feedback_hax_128gb_ram_throttling`; CPU is the gating throttle but `Ssl+` state indicates the wedge is not CPU-starved. Out of scope.

## Recommended next step

Operator picks up mitigation #1 in the dotfiles workflow (claude-skills medic skill body — replace `/superdoctor` self-queue with inline Skill-tool call). Mitigation #2 is filed as a sub-Task under e-b84c4d48 (atmux cockpit recovery hardening) rather than rolled into this investigation's closure. Mitigations #3 + #4 stay deferred behind #2's ship.

Repro hypothesis stays open until operator runs the 4 steps (or until mitigation #1 ships and the wedge cycle stops on its own — both close the investigation).

## Filed by

t-b5cf6cf6 — docs (🦦), 2026-05-20.
