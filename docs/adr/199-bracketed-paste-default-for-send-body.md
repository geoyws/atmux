# ADR-199: Bracketed-paste mode as default for send-keys body content — slash-leading wedge fix

**Status**: proposed
**Date**: 2026-05-21
**Driver-ref**: 2026-05-21 10:36 MYT — literal slash-leading body wedge observed across unum + ifca-docs leads; operator manual recovery required (C-u to clear → retype → Enter); `/bruh`-via-cron unreliable; cron-only operator observability blind. Filed via Epic `e-2ba5ae45` (P1 SILENT KILLER wake-up wedge).
**Cross-refs**: [ADR-081](081-bootstrap-brief-paste-bug.md) §A (bracketed-paste-mode envelope + C-m submit contract — primary substrate), [ADR-138](138-verified-send-keys.md) (verify-and-retry pattern — outer layer; this ADR refines its send-method default), [ADR-188](188-tui-send-keys-canonical-4-step.md) (4-step canonical pattern for text-into-composer — preserves the popup-stack mitigation as the outer flow), commit `2456678` (`fix(send-keys): honour team.tmuxTmpdir in tell-lead/send/dispatch/stop`) — socket-resolution alignment that this ADR's send-path inherits.

## Context

`atmux send <member> "<body>"` (the verb that drives `atmux tell-lead`, `atmux dispatch`, `atmux reply`, `atmux send`, `/bruh` cron-injected messages, and the supervisor's keystroke injections per ADR-032) defaults to `tmux send-keys -l -- "<body>"` for the body content. The `-l` (literal) flag treats characters as input rather than tmux key-table lookups — generally correct for free-text body. But under claude-TUI's slash-popup interaction, a body whose first character is `/` triggers the slash-command popup ON THE FIRST CHARACTER, before the rest of the body lands.

### Failure-mode trace (2026-05-21 10:36 MYT incident)

1. `/bruh` cron fires; supervisor calls `tmux send-keys -l -- "/bruh you are sentinel, make all teams work, unblock everyone"`.
2. The leading `/` opens claude's slash-command popup (autocomplete dropdown with skills + built-ins).
3. The rest of the body — `bruh you are sentinel, make all teams work, unblock everyone` — types into the **popup's filter input**, not the compose box.
4. Popup narrows-then-discards because no skill matches "bruh you are sentinel..." (the operator's intent — `/bruh` is a skill, but the typing landed in the filter, not as a literal slash-command invocation).
5. Composer ends up: empty (or with stale text from a prior cycle). Submit Enter doesn't fire anything actionable. The lead pane LOOKS responsive (no error, no wedge banner) but the directive never landed.
6. Operator observability: zero. Cron logs success, the pane has no visible failure, the lead's next idle turn doesn't know a directive was injected. **Silent killer**.

Operator recovery: C-u (clear composer) → retype `/bruh ...` directly in the TUI (the human typing path triggers slash-popup-confirm by waiting for the dropdown to settle then pressing Enter, which atomically commits + invokes the skill) → Enter.

### Why this is a SILENT KILLER class

- **Pre-existing observability is mute.** Doctor probes the pane shell, not the popup state. Sentinel observes for thinking-glyphs but not slash-popup-residue. The wedge bypasses every existing detection surface.
- **Cron-only operator observability is blind.** The cron job logs `success` because `tmux send-keys` exits 0. The wedge happens in the TUI render layer downstream of tmux's IO boundary.
- **Repros across every lead pane that receives a slash-leading body.** Not bound to one team or one operator action — observed simultaneously on unum + ifca-docs leads during the same 10:36 MYT `/bruh` fire.
- **No retry semantics recover.** ADR-138's verify-and-retry checks for composer state; an empty composer post-popup-collapse passes the empty-composer verifier, so retry doesn't fire.

### Why bracketed-paste mode prevents this

`tmux paste-buffer -d` wraps body content in `ESC[200~ ... ESC[201~` envelope per VT100 bracketed-paste-mode spec. Claude TUI interprets the envelope as "this is a single paste blob, treat as literal text, do NOT interpret the first character as a command-keystroke." The leading `/` lands as text in the compose box — no popup triggered, no filter-input redirect, no silent loss.

ADR-081 §A documented this same envelope behavior for the brief-paste path. The same property applies to general body sends; nothing about the envelope's correctness is bootstrap-specific. The current divergence (bootstrap uses bracketed-paste, general body sends don't) is historical, not principled.

## Decision

### §D1 — 4-option fork (enumerated; default = Option 2)

| # | Option | Pro | Con | Verdict |
|---|---|---|---|---|
| **1** | **Status quo** — keep `tmux send-keys -l` default; require callers to switch to paste-buffer manually when they need bracketed envelope. | Zero diff; preserves every existing call site's literal-keystroke semantics. | Continues to repro the 2026-05-21 wedge on every slash-leading body. Every new caller has to remember which path to use. Documentation gap is the silent killer. | **REJECT** — bug-reproducing default. |
| **2** | **Bracketed-paste default** — `tmux load-buffer <body> + tmux paste-buffer -d + ≥500ms settle + tmux send-keys C-m` becomes the canonical send-body path. `opts.rawSendKeys = true` per-call escape for callers that need literal-keystroke semantics (control sequences, single keystroke nav, etc.). | Closes the slash-leading wedge class. Aligns the body-send path with the bootstrap path (one mental model). Per-call escape preserves the legacy-keystroke surface. | One additional `load-buffer` IO per send. Settle adds ~500ms latency to every send (currently 0ms). Existing tests that assert `tmux send-keys -l` invocation shape need to update to assert paste-buffer + C-m. | **DEFAULT** — closes the failure class with bounded latency cost. |
| 3 | **Auto-detect slash-leading** — if `body[0] === "/"`, switch to bracketed-paste; else use `send-keys -l`. Heuristic. | Surgical — only the failing class pays the latency cost. | Heuristic is a false-negative trap: e.g. ` /bruh` (leading space) wouldn't trip the switch but still wedges the popup if a TUI variant strips leading whitespace. Future TUI variants may add new trigger keys (`@`, `#`, `!`). Each new variant = another heuristic-update + another wedge cycle before discovery. | **REJECT** — heuristic-as-defense is brittle. |
| 4 | **Per-callsite opt-in** — keep `send-keys -l` default; verbs that fire user-content bodies (tell-lead, reply, send, dispatch, /bruh) opt-in via `opts.bracketed = true`. | No global behavior change. Callers explicitly assert their need for the envelope. | Same problem as Option 1 — new callers default-wrong, slash-leading wedges continue until each callsite is found and migrated. Manual migration is the slow attrition path. | **REJECT** — defers the fix indefinitely. |

Default = **Option 2** (bracketed-paste default + `opts.rawSendKeys` escape).

### §D2 — Implementation contract

```ts
// src/abstractions/tmux.ts (or equivalent)
export interface SendKeysOpts {
  target: SendTarget;
  /** Body content. Bracketed-paste envelope is applied by default
   *  (Option 2 per ADR-199). */
  body: string;
  /** Per-call escape — bypass bracketed-paste, use literal
   *  `tmux send-keys -l` instead. Required for control sequences,
   *  single-keystroke nav, copy-mode commands, raw key passthrough.
   *  Default: false (bracketed-paste applies). */
  rawSendKeys?: boolean;
  // ... existing fields preserved
}

export async function sendKeys(opts: SendKeysOpts): Promise<void> {
  if (opts.rawSendKeys === true) {
    // Legacy literal-keystroke path
    await tmux.sendKeys({ target: opts.target, keys: opts.body, literal: true });
    return;
  }
  // Default — bracketed-paste envelope
  await tmux.loadBuffer({ content: opts.body });
  await tmux.pasteBuffer({ target: opts.target, deleteBuffer: true });
  await sleep(PASTE_SUBMIT_SETTLE_FLOOR_MS); // ≥500ms per ADR-081 §A
  await tmux.sendKeys({ target: opts.target, keys: "C-m", literal: false });
}
```

### §D3 — Safe-skip — existing plain-text body callsites get the same default; no breakage

The migration is observation-equivalent for non-slash-leading bodies: a plain "hello world" body sent via bracketed-paste lands identically to one sent via `send-keys -l` (just slower by the settle). No call site that worked before this ADR breaks after. The only behavior changes are:

1. Slash-leading bodies stop triggering the popup (the bug fix).
2. All sends are ~500ms slower (the latency cost).
3. Tests that assert the wire-shape of the tmux invocation (`send-keys -l ...`) update to assert the new shape (`load-buffer + paste-buffer + send-keys C-m`).

Callers requiring literal-keystroke semantics (notably `known-modals.ts` catalog dismiss-keystrokes, copy-mode commands, single-key nav like `BTab` for the auto-mode toggle) MUST set `opts.rawSendKeys = true`. The escape is explicit and grep-able — reviewer enforces during code-review.

### §D4 — Discord template — no change

The send path doesn't surface to Discord. ADR-086 vocabulary unchanged. Implementation lands silently; the only operator-visible signal is "the slash-leading wedge stopped happening."

### What we give up

- **~500ms latency on every body send.** At `/bruh` cron cadence (15 min) negligible; at lane-tick cadence (5 min × N teams) measurable but bounded by `N` (typically <20 ticks/min host-wide). For high-frequency synthetic-test send loops, callers opt into `rawSendKeys = true` if the latency matters.
- **One tmux IO call extra per send** (load-buffer). Negligible — tmux buffer IO is sub-ms.
- **Tests that assert wire-shape need an update.** Counted ~15 test files in `tests/unit/verbs/` + `tests/unit/core/` that reference `send-keys -l` invocation shape; impl Task T2 migrates them.

### Rollback path

If Option 2 surfaces problems in production (e.g. settle interferes with a high-frequency send loop nobody noticed):

1. **Per-callsite override** — set `opts.rawSendKeys = true` at the offending site. Surgical bypass.
2. **Global env disable** — `ATMUX_BRACKETED_PASTE_DEFAULT=0` reverts global default to `send-keys -l`. Last-resort while the offender is found.
3. **Full revert** — drop §D2 default flip; ship §D3 safe-skip wording as docs-only guidance. ADR stays as historical record of the failure class.

## Sub-tasks (decomposed by planner; impl Tasks land downstream)

- **T1** — ADR-199 draft (this file). Lane=`misc`, deps=none, priority=1. (← *this Task is t-7debe6e1*)
- **T2** — `src/abstractions/tmux.ts::sendKeys` (or equivalent canonical surface) — flip default to bracketed-paste + add `rawSendKeys` opt + thread through every caller. Same-commit migration of ~15 wire-shape tests. Lane=`be`, deps=T1, priority=1.
- **T3** — Audit + migrate raw-keystroke call sites — `known-modals.ts` catalog dismisses, copy-mode commands, single-key nav (`BTab` etc.) all set `opts.rawSendKeys = true` explicitly. Lane=`be`, deps=T2, priority=1.
- **T4** — Integration test: synthetic slash-leading body → assert popup NOT triggered + body lands in compose box. Lane=`test`, deps=T2, priority=1.
- **T5** — Docs sweep: CLAUDE.md §"Tmux + pane discipline" — note the bracketed-paste default + `rawSendKeys` escape; ADR-138 + ADR-188 cross-link to this ADR; brief templates that reference send-keys discipline. Status flip to `accepted` lands here once T2-T4 ship. Lane=`misc` (docs), deps=T2+T3+T4, priority=2.

## Open questions

1. **(LOW reversibility) Settle floor 500ms vs 250ms**: ADR-081 §A established 500ms as the bracketed-paste-Enter-swallow mitigation floor for the BOOTSTRAP path. The general-body send path might tolerate 250ms (the wedge mechanism is the slash-popup, not the bracketed-paste-Enter-swallow). Recommend keep 500ms in v1 (parity with ADR-081 + safer); audit empirically in v2 once instrumentation lands. Constant lives in `PASTE_SUBMIT_SETTLE_FLOOR_MS` per ADR-081.

2. **(LOW reversibility) Settle policy under high-frequency send**: at N>10 sends/sec the 500ms × N serializes badly. Should the helper batch sends within a window? Recommend NO — high-frequency sends today are all synthetic-test territory; those callers opt into `rawSendKeys = true`. If real production traffic hits high-frequency, file as new ADR.

3. **(LOW reversibility) `rawSendKeys` naming**: alternatives considered — `literal: true`, `noBracketedPaste: true`, `keystrokeMode: true`. Recommend `rawSendKeys` — emphasizes the "raw tmux send-keys without envelope" semantic, grep-able, doesn't double-negate.

4. **(LOW reversibility) Escape for OTHER trigger characters (`@`, `#`, `!`)**: should the §D1 Option-2 default also cover non-slash trigger characters if claude TUI adds them in the future? Recommend YES — bracketed-paste covers ANY leading trigger character by design (the envelope says "literal text" regardless of the body's first byte). The default protects against future-TUI variants for free.

5. **(MEDIUM reversibility) Interaction with ADR-188 4-step pattern**: ADR-188 ships scroll → Enter×3 → paste → Enter×3 as canonical for text-into-composer. This ADR's bracketed-paste default already aligns with Step 3 (paste); Steps 1/2/4 are unchanged. ADR-188 §"Order of operations in the merged flow" stays valid — this ADR refines the Step 3 semantics from `paste-buffer` to `paste-buffer-with-explicit-bracketed-envelope`, which is the same surface. No conflict; T5 docs sweep cross-links both ADRs.

## Cross-refs

- [ADR-081 §A](081-bootstrap-brief-paste-bug.md) — bracketed-paste-Enter-swallow + C-m submit contract; this ADR's `PASTE_SUBMIT_SETTLE_FLOOR_MS` + C-m submit pattern are inherited verbatim.
- [ADR-138](138-verified-send-keys.md) — verify-and-retry pattern; this ADR refines the send-method default that ADR-138 wraps. ADR-138 §Amendment 2026-05-20 (forward-ref to ADR-188) extends to forward-ref ADR-199 once accepted.
- [ADR-188](188-tui-send-keys-canonical-4-step.md) — 4-step canonical pattern for text-into-composer; this ADR's bracketed-paste default IS the Step 3 mechanism, refined.
- Commit `2456678` — `fix(send-keys): honour team.tmuxTmpdir in tell-lead/send/dispatch/stop`; this ADR inherits the socket-resolution path established there.
- Complaint chain — Epic `e-2ba5ae45` (P1 SILENT KILLER wake-up wedge) is the parent; t-7debe6e1 is its T1 anchor.
- Memory `feedback_residue_use_cm_not_enter` — empirically validated stuck-residue recovery via `atmux send` (uses `pasteAndSubmit` → bracketed envelope); this ADR generalizes that path to be the default.
- Memory `feedback_tui_send_keys_canonical_pattern` — 4-of-5 lead panes wedged 2026-05-19; ADR-188 + this ADR are the joint resolution (popup-stack via Enter×3, leading-trigger via envelope).
