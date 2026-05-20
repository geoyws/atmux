# ADR-188: TUI send-keys canonical 4-step pattern (scroll → Enter×3 → paste → Enter×3)

**Status**: proposed
**Date**: 2026-05-20

## Context

Operator directive 2026-05-20 07:50 MYT, surfaced by driver after the 2026-05-19 `/bruh` cockpit fan-out wedge incident: **4 of 5 lead panes wedged in slash-popup state where single-`Enter` silently dropped the dispatched message.** Recovery required manual pane-by-pane inspection + key-pattern escalation across multiple Claude accounts.

This ADR documents the new canonical 4-step pattern for typing into any TUI pane, and supersedes ADR-138 §"Why blanket-3x is wrong" *for text-into-composer callsites* (verify-and-retry from ADR-138 remains in force; see §Decision below).

### Wedge data (2026-05-19)

- 5 lead panes targeted by `/bruh` cockpit fan-out
- 4 wedged in slash-popup state ("← for agents" overlay) on first dispatch
- single-`Enter` after paste-buffer silently dropped on each wedged pane — pane appeared to accept the input but message never reached compose box
- recovery: manual `tmux send-keys ... q` (to exit copy-mode where applicable), then triple-Enter, then re-paste, then triple-Enter again, per-pane
- empirically reliable across all 4 wedged panes

### Failure-mode taxonomy this resolves

1. **Copy-mode siphon** — pane in copy-mode interprets keystrokes as scroll/copy commands, not compose-box input. `q` (or Escape) drops out; if not in copy-mode, `q` is a benign no-op in most claude-TUI contexts (validated empirically; if a future claude-TUI version starts treating `q` as a meaningful submit-key on the compose box, escape via `Escape` instead — see §Open questions OQ2).
2. **Slash-popup / modal overlay** — popups absorb the next `Enter` as "dismiss popup" rather than "submit message." A single `Enter` is consumed by the popup; the second reaches the compose box but only if the popup was the ONLY overlay. Defensive Enter×3 dismisses popup-stacks.
3. **Bracketed-paste-envelope eating Enter** — per ADR-081 §A, `tmux paste-buffer -d` followed by `tmux send-keys ... Enter` makes the trailing `Enter` get interpreted as "newline inside the pasted message" rather than "submit." `C-m` (carriage return) bypasses the envelope; firing 3× defensively closes the remaining gap where intermittent settle-timing or partial-paste state still eats the first `C-m`.
4. **Queued-message confirmation overlay** — when a prior message is still mid-flight, the compose box may show a "queued — confirm to send" overlay that absorbs the first Enter as confirm. Defensive Enter×3 covers this.

ADR-138 §"Why blanket-3x is wrong" framed unconditional triple-Enter as state-destructive (empty submit, wrong modal default, welcome-screen placeholder fire). That analysis was correct for **safe-state callsites** (compose box known-empty + no overlays). The 2026-05-19 wedge data shows the wedge rate in **unsafe-state callsites** (fan-out across heterogeneous panes, popup-class overlays present on 80%+ of targets) exceeds the double-submit damage rate, by a wide margin.

The reconciliation: the new 4-step pattern explicitly handles the unsafe-state callsites; ADR-138's verify-and-retry pattern remains the in-force discipline for the post-send observability layer.

## Decision

### The 4-step canonical pattern

For any TUI send-keys callsite that **types or pastes message content into a composer**:

```
Step 1: Scroll-to-bottom (drop out of copy-mode if applicable)
  - If `tmux display-message -p '#{?pane_in_mode,yes,no}'` == "yes":
      send "q" (or Escape — see OQ2)
      re-check; if still in mode, send Escape; re-check
  - Idempotent: no-op when pane is already in bottom/non-copy-mode state

Step 2: Enter × 3 (defensive popup/overlay dismissal)
  - Three discrete `tmux send-keys -t <target> C-m` calls with brief settle between (≥50ms)
  - Dismisses: slash-popup ("← for agents"), modal overlays, queued-message
    confirmation, welcome-screen banners
  - On a clean compose box, three Enter on empty composer is either no-op
    (claude-TUI behaviour) or fires three empty turns (some TUIs); the
    empty-turn-fire is the cost we accept per the wedge-data trade-off

Step 3: Type / paste content
  - Existing flow: tmux load-buffer + tmux paste-buffer -d (paste-submit.ts path)
    OR tmux send-keys for typed input (send.ts path)
  - Bracketed-paste envelope per ADR-081 §A handling

Step 4: Enter × 3 (defensive submit)
  - Three discrete `tmux send-keys -t <target> C-m` calls with ≥500ms initial
    settle (ADR-081 §A floor) + ≥50ms between subsequent Enters
  - First C-m: primary submit; bypasses bracketed-paste envelope
  - Second + third: defense against partial-paste settle race + queued-confirm
    overlay that surfaces after first submit
```

Each `Enter` is a literal `C-m` (carriage return) — never `Enter` keysym — per ADR-081 §A bracketed-paste-mode envelope contract. This is unchanged from current behaviour.

### Supersession scope

ADR-138 §"Why blanket-3x is wrong" is **SUPERSEDED for text-into-composer callsites**. Specifically:

- **SUPERSEDED**: `src/core/send.ts`, `src/core/paste-submit.ts`, `src/core/safe-send.ts` (the safeSendKeys + safeSendKeysWithVerify wrappers when sending message content)
- **SUPERSEDED**: every `src/verbs/*` callsite that invokes the above for typing/pasting message content (poke.ts, lane-tick.ts, rotate.ts, boot-claude.ts, goal-injection.ts, send.ts the verb, dispatch.ts the verb, tell-lead.ts, reply.ts when wiring through to pane-injection, etc.)
- **NOT SUPERSEDED**: single-keystroke control callsites (menu nav, known-modals.ts auto-dismiss with a specific catalog-keystroke, copy-mode commands, raw tmux key passthrough that is NOT message-content). Those keep ADR-138's verify-and-retry discipline without the 4-step preamble/postamble — the failure modes the 4-step addresses don't apply.

### ADR-138 components that REMAIN in force

- `safeSendKeysWithVerify` verifier-after-send pattern (per-call contract — caller knows what state SHOULD exist post-send)
- Escalation log at `~/.atmux/state/send-keys-failures.log`
- 5 built-in verifiers (`composerEmpty` / `agentThinking` / `modalClosed` / `contextNonZero` / `paneMatchesRegex`)
- `safeSendKeys` preflight gate
- Telemetry + observability surfaces

The 4-step pattern is the **outer wrapper** around the verify-and-retry mechanism: scroll/dismiss-preamble → send → verify (ADR-138) → if verify-failed, the 4-step retry pattern fires from scratch (not just the send step).

### known-modals.ts interaction

`known-modals.ts` catalog handles specific known-pattern modals (feedback-survey, Claude Code permission modals, etc.) with the precise dismiss-keystroke per catalog entry. The new Step 2 Enter×3 is a **conservative supplement** for unknown / un-catalogued popups (slash-popup, queued-confirm, future modal classes).

Order of operations in the merged flow:
1. New Step 1 (scroll/copy-mode escape)
2. known-modals catalog match attempt — if match, fire catalog-specific dismiss key (pre-empts the Enter×3)
3. New Step 2 (Enter×3) — fires only if no catalog match (else it's redundant + risks double-dismiss of the catalogued modal)
4. New Steps 3 + 4 (paste + Enter×3 submit)
5. ADR-138 verify-after-send

This ordering preserves known-modals' single-keystroke precision where it applies + falls back to the conservative Enter×3 elsewhere.

### Shared helper placement

New helper `applyTuiSendKeysPattern` in `src/core/safe-send.ts` (alongside existing `safeSendKeys` + `safeSendKeysWithVerify`):

```ts
export interface TuiSendKeysOpts {
  target: SendTarget;                // 'session:window' tmux target
  content: string;                   // message body to type / paste
  mode: "paste" | "type";            // paste-buffer envelope vs direct send-keys
  knownModalsCatalog?: KnownModal[]; // default: KNOWN_MODALS export from known-modals.ts
  preambleSettleMs?: number;         // default 50ms between Enter×3 strokes
  pasteSettleMs?: number;            // default PASTE_SUBMIT_SETTLE_FLOOR_MS (500ms)
  postambleSettleMs?: number;        // default 50ms between submit Enter×3 strokes
  verifier?: PaneVerifier;           // ADR-138 post-send verification hook
  retries?: number;                  // default 1; ADR-138 retry-on-verify-fail
}

export async function applyTuiSendKeysPattern(opts: TuiSendKeysOpts):
  Promise<{ success: boolean; attempts: number; finalCapture: string; }>;
```

All callsites converge through this helper. ADR-081 §A `submitAfterPaste` becomes an internal step of the new helper rather than a directly-called surface from verb call sites (preserved as exported for backward-compat during the migration window).

## Consequences

### What changes for which lanes

**BE lane** — invasive refactor:
- `src/core/safe-send.ts` — add `applyTuiSendKeysPattern` + threading through existing wrappers
- `src/core/send.ts` — rewire to call the new helper instead of direct paste/send
- `src/core/paste-submit.ts` — `submitAfterPaste` becomes an internal step of the new helper; preserved exported for transition
- `src/core/known-modals.ts` — no signature change; helper consumes the catalog
- `src/core/boot-claude.ts` — boot-brief paste path uses the new helper
- `src/verbs/*.ts` — every callsite of safeSendKeys / paste-submit for text-into-composer migrates to the new helper

**TEST lane** — large impact:
- existing `src/**/__tests__/*.test.ts` mocks have specific send-keys sequence assertions (single `Enter`, single `C-m`, etc.) — update to expect the new 3x sequences
- new test class: 4-step pattern coverage on the helper itself (copy-mode escape path, popup-stack dismissal path, paste-envelope-defense path, postamble verification path)
- integration tests against synthetic wedged-pane fixtures (slash-popup + queued-confirm + bracketed-paste-eat scenarios)

**DOCS lane** — sweep:
- `CLAUDE.md` (atmux project) §"Tmux + pane discipline" — reference ADR-188 as the canonical pattern, link superseded ADR-138 §"Why blanket-3x is wrong" header
- `docs/adr/138-verified-send-keys.md` — append §Amendment header at top pointing to ADR-188 supersession; the body remains for historical context
- `docs/RUNBOOK-*.md` — any runbook that documents send-keys flow updates to the 4-step pattern
- `templates/briefs/*.md` — member briefs that reference "send-keys discipline" cross-link ADR-188

**REVIEW lane** — gate-class:
- reviewer enforces 4-step pattern adoption at every text-into-composer callsite during code-merge gate
- regression-guard test in CI ensures no future callsite reverts to bare `Enter`/`C-m` for message-content sends

### What we give up

- Steady-state keystroke efficiency — 6 extra `tmux send-keys` calls per message-send (3 preamble + 3 postamble). At lane-tick cadence (5min cron) this is negligible; at high-frequency callsites (none currently exist), it would be measurable.
- Empty-turn-fire risk on safe-state callsites — clean compose box receiving Enter×3 may fire 3 empty turns on some TUI variants. Wedge-data trade-off accepted per operator.
- ADR-138 §"Why blanket-3x is wrong" prescription — the analysis remains historically valid for the safe-state case; the SUPERSESSION is scoped to wedge-prone text-into-composer flows.

### Rollback path

If empty-turn-fire damage exceeds wedge-prevention benefit in steady-state observation (post-merge), rollback options in order:

1. **Tighten scope** — restrict 4-step to only the explicitly-popup-prone callsites (fan-out paths: rotate, boot, dispatch), keep cron-fired lane-tick on the existing ADR-138 path. Single-config switch on the helper.
2. **Drop Step 2** — keep scroll-to-bottom (Step 1) + paste (Step 3) + Enter×3 submit (Step 4). The wedge data attributes most failures to bracketed-paste-envelope-eat (Step 4 mitigates), not popup-stack (Step 2 mitigates). This rollback preserves the highest-leverage protection.
3. **Drop Step 4 to single C-m** — keep Steps 1+2+3 + single C-m submit. Inverse of (2). Wedge-data does NOT support this — bracketed-paste-eat is the dominant failure.

Full rollback to ADR-138 is the nuclear option; only fire if both partial rollbacks fail to bound the damage.

## Open questions

1. **(RESOLVED — planner default LOW reversibility) Supersession scope**: Apply the 4-step uniformly to all text-into-composer callsites (NOT to single-keystroke control callsites). Reasoning: the wedge-data (80% wedge rate on /bruh fan-out) exceeds the empty-turn-fire damage rate on safe-state callsites by a wide margin. Driver framed this as planner's call; locked default uniform application across text-into-composer with the scope carve-out for single-keystroke control flows. If empirical post-merge data flips this trade-off, rollback option 1 (scope tightening) is the prescribed fall-back.

2. **(LOW reversibility) Copy-mode escape keystroke — `q` vs Escape**: Current claude-TUI treats `q` in copy-mode as exit-to-bottom; outside copy-mode `q` is a benign no-op on the compose box. If a future claude-TUI version starts treating `q` as a meaningful compose-box keystroke (e.g. quick-quit), the 4-step preamble would type a stray `q` into composer. Default: `q` (matches operator-stated pattern). Fallback: Escape (which has the same exit-copy-mode effect AND is universally benign on compose boxes). Switch is one-line in the helper; flag this as a regression-guard in the test suite (catch a future claude-TUI version change before it ships).

3. **(LOW reversibility) Per-callsite override flag for Step 2 + Step 4 multiplier**: Some callsites (boot-brief which fires once-per-rotate; goal-injection which is interactive) may benefit from Enter×5 instead of Enter×3 on the postamble — the bracketed-paste-eat rate scales with content size. Default: Enter×3 universally per operator-stated pattern. Helper accepts `submitEnterCount` opt for future per-callsite tuning; never go below 3.

4. **(LOW reversibility) Backward-compat for `submitAfterPaste` callers**: `paste-submit.ts::submitAfterPaste` becomes an internal step of the new helper. External callers (none expected after impl Epic lands) keep the exported symbol with a deprecation-warn-in-test path; remove the export one release after impl Epic ships.

5. **(LOW reversibility) Integration with `modal-cycling-detector.ts`**: the modal-cycling detector (ADR-142) catches lead/member modal-soup-stuck patterns. The new 4-step Step 2 may PRE-EMPT some modal-cycling patterns by dismissing them at the source. Default: no change to modal-cycling-detector; let the new 4-step reduce its trigger rate organically. Reviewer to flag if false-negative rate climbs in post-merge observation.

## Cross-refs

- ADR-138 (verified-send-keys — verify-and-retry pattern; §"Why blanket-3x is wrong" superseded for text-into-composer scope)
- ADR-081 (bootstrap brief-paste reliability — §A C-m vs Enter contract preserved + reinforced)
- ADR-057 (known-modals catalog — flow-merged into new helper)
- ADR-142 (modal-cycling-detector — sibling observability surface; flagged for post-merge interaction observation)
- ADR-168 (send-keys-log rotation policy — ADR-138 escalation log; format unchanged)
- Operator directive 2026-05-20 07:50 MYT (driver-inbox)
- Memory `feedback_tui_send_keys_canonical_pattern.md` (lead-saved operator feedback)
- 2026-05-19 `/bruh` cockpit fan-out wedge data (4 of 5 lead panes wedged)
