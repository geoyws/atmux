# ADR-138: Verified send-keys — verify-and-retry pattern

**Status**: Accepted (2026-05-15, operator-batch-flip)
**Date**: 2026-05-14
**Driver-ref**: 2026-05-14 driver session — operator: *"we have a problem with send keys not really sending… perhaps Enter has to be hit 3x? or something? to be safe? and we have to check if the enter was truly hit? of course send keys will be done via minimax later"*
**EPIC parent**: `t-5df48a74` · **TR1**: `t-f58c6ccc`
**Reviewer**: gate before T2 (helper impl) lands.

## Context

Across the atmux codebase, `tmux send-keys` is the primitive that drives every cross-pane mutation:

- `atmux send <member> <msg>` (member-inbox surfacing)
- `atmux dispatch` (start-task injection)
- `atmux lane-tick` (claim-loop injection)
- `atmux start` / `atmux rotate` (bootstrap brief paste cascade — ADR-081 §A C-m)
- driver-side helpers releasing modals + nudging lead panes

Field evidence on the 2026-05-14 driver session — and on prior `[[feedback]]` notes — is that `send-keys` is **silently unreliable**:

- Keys swallowed by a mid-think pane (no composer focus during `Cooking…` / `Schlepping…`).
- Permission modal race — Enter selects the wrong default if a second modal pops up between capture-and-send.
- Welcome-screen-gates — Enter fires whatever placeholder text was visible (e.g. `claim --next` typed but never submitted).
- Compacting-conversation drops — keystrokes during the `Compacting conversation` banner are absorbed and lost.

The operator's intuition (*"maybe Enter has to be hit 3x"*) is directionally right — send-keys is unreliable — but the wrong fix.

### Why blanket-3x is wrong

A blind 3× Enter is state-destructive:

- **Composer with text + Enter** → submits, composer clears, agent starts thinking. A second Enter submits an EMPTY prompt; a third compounds.
- **Permission modal (1/2/3/4 choice) + Enter** → selects the highlighted option, modal closes. A second Enter might select the follow-up modal's default — typically the wrong one.
- **Welcome screen + Enter** → fires whatever placeholder text was in the composer. Two more Enters keep doing damage.

Every "extra" Enter is a state mutation, not a no-op. Blanket retry is unsafe at every layer below the application protocol.

## Decision

**Verify-and-retry pattern.** Send once, capture the pane, assert the expected state transition, retry once if no transition observed within `timeoutMs`, escalate if still stuck. The verifier is the per-call contract — the caller knows what state SHOULD exist after the send, and the helper proves it via pane capture.

### New helper: `safeSendKeysWithVerify`

**Placement**: `src/core/safe-send.ts` (alongside the existing `safeSendKeys` peer). Reviewer-signed-off 2026-05-14 (`t-76bed567`) overriding the initial pre-impl framing that named `src/abstractions/tmux.ts`. Rationale — `safeSendKeysWithVerify` is a *policy* (verify-and-retry + escalate-on-fail) that composes three core-layer concerns:

1. The existing `safeSendKeys` preflight gate (`src/core/safe-send.ts:115`) — already core-layer with tmux injected via `opts.capture` + `opts.sendKeys`.
2. The five built-in verifiers (`composerEmpty` / `agentThinking` / `modalClosed` / `contextNonZero` / `paneMatchesRegex`) — pane-classification predicates, semantically siblings to `src/core/pane-state.ts::classifyText`.
3. The escalation log writer — a state-file concern at `~/.atmux/state/send-keys-failures.log`, owned by core.

Placing the surface in `src/abstractions/tmux.ts` would force the abstraction layer to import from `src/core/` (pane-state classification, known-modals, retry policy), inverting the "core consumes abstractions, never the reverse" invariant. tmux remains a *dependency* of `safeSendKeysWithVerify`, injected via `opts.capture` / `opts.sendKeys` — same pattern `safeSendKeys` already uses. Runtime contract is identical between the two placements; only the dependency direction differs, and the core-side placement is the one that keeps the layering honest.

Implementation reference: commit `d588fa8` (geoyws-test-impl) — `safeSendKeysWithVerify` at line 476, 5 verifier factories at lines 551-594, escalation log writer at lines 443+659. T3 caller migrations target `import ... from "../core/safe-send.ts"` (NOT `"../abstractions/tmux.ts"`).

In `src/core/safe-send.ts`:

```ts
export type PaneVerifier = (paneCapture: string) => boolean;

export async function safeSendKeysWithVerify(opts: {
  target: string;                // 'session:window' tmux target
  keys: string;                  // keystroke sequence
  expectVerifier: PaneVerifier;  // returns true when expected state observed
  timeoutMs?: number;            // default 3000
  retries?: number;              // default 1
  onFail?: "escalate" | "throw"; // default "escalate"
}): Promise<{ success: boolean; attempts: number; finalCapture: string }>;
```

Behaviour:

1. Capture pane state pre-send → save baseline.
2. Send keystroke(s) via existing `safeSendKeys` (ADR-081 §A C-m submit cascade).
3. Poll pane every 250 ms for up to `timeoutMs`.
4. On each poll: capture + run `expectVerifier(capture)` — return success if true.
5. If timeout without verifier success: if `retries > 0`, decrement + retry from step 2.
6. If all retries exhausted, per `onFail`:
   - `escalate` (default): write to `~/.atmux/state/send-keys-failures.log` + return `{ success: false, ... }`.
   - `throw`: throw `SafeSendKeysError(target, keys, attempts)`.

### Built-in verifiers

Six common verifiers ship with the helper. Callers pick one or compose a custom verifier:

- **`composerEmpty()`** — pane shows an empty `❯ ` line at the composer (composer text was submitted, agent now thinking or idle).
- **`agentThinking()`** — pane shows a present-tense status indicator: `Cooking…`, `Schlepping…`, `Honking…`, etc. (agent accepted the prompt + started a turn).
- **`modalClosed(modalText: string)`** — pane no longer contains the named modal text (the modal was dismissed by the keystroke).
- **`contextNonZero()`** — pane status line shows non-zero token count (bootstrap completed — per ADR-081 §C the cascade verifier).
- **`paneMatchesRegex(re: RegExp)`** — generic regex matcher for ad-hoc states.
- **caller-provided closure** — pass any `PaneVerifier` for one-off cases that don't fit the canonical six.

## Migration plan

Callers migrate to `safeSendKeysWithVerify` with an appropriate verifier:

| Caller | Verifier |
|---|---|
| `src/verbs/send.ts` (`atmux send <member> <msg>`) | `composerEmpty()` |
| `src/verbs/dispatch.ts` (`atmux dispatch`) | `composerEmpty()` |
| `src/verbs/lane-tick.ts:225` (claim injection) | `composerEmpty()` |
| `src/verbs/start.ts` (bootstrap brief cascade per ADR-081 §C) | `contextNonZero()` |
| `src/verbs/rotate.ts` (post-rotate brief paste) | `contextNonZero()` |
| Driver-side modal-release helpers | `modalClosed("<expected-modal-prefix>")` |

Direct `tmux send-keys` calls REMAIN ONLY for cases where verification is N/A — `tmux rename-window`, layout commands, send-keys to a non-TUI shell pane. Reviewer enforces the migration at commit-review time.

### T3b3 closure (t-06547e2d, 2026-05-15 P0)

The lane-tick claim-injection callsite (`src/verbs/lane-tick.ts:240`) was empirically observed to drop the trailing `Enter` on member panes in the "just finished compose + ← for agents" transition state. 3rd recurrence on 2026-05-15 22:47 MYT triggered driver P0 + this migration.

**Fix shape**: route the text-body payload through `pasteAndSubmit` (`src/core/paste-submit.ts`) — the bundled `loadBuffer + pasteBuffer -d + ≥500ms settle + C-m` cascade. `C-m` (literal carriage return keysym) bypasses the bracketed-paste-mode envelope that swallows the trailing `Enter`.

**Carve-out preserved**: control-key keystrokes (`C-m`, `C-c`, `BTab`, single-digit modal selections) stay on the raw `tmux.pane.sendKeys` path — they don't pass through the bracketed-paste envelope and are correct as-is. The contract is enforced by `tests/unit/core/sendkeys-contract.test.ts` which grep-walks `src/` and asserts that no caller passes a text-body payload to raw `sendKeys` with `enter: true` outside the documented carve-out list (paste-submit / safe-send / launcher commands at shell prompt / `/clear`-class slash-commands / soft-stop's no-submit path).

Audit findings (2026-05-15 — t-06547e2d):
- `src/verbs/start.ts:485` + `:715` — launcher commands at SHELL prompt (pre-claude); no bracketed-paste envelope. **No migration needed.**
- `src/verbs/rotate.ts:309` — `/clear` slash-command via raw keystroke typing (no preceding paste-buffer). **No migration needed.**
- `src/verbs/cockpit.ts:1737` + `:1863` — `/loop /superdoctor` / `/loop /martinet` slash-commands at cockpit pane. **No migration needed.**
- `src/core/soft-stop.ts:235` — explicit `enter: false` (queue-only, never submits). **No migration needed.**
- `src/verbs/ombudsman.ts:297` — safe-send adapter callback; the callback's `enter` is opt-controlled by `safeSendKeys` (the caller). Adapter shape preserved; carve-out file.
- `src/verbs/lane-tick.ts:240` — **MIGRATED** to `pasteAndSubmit` via the default `sendKeysFn` dispatch on text-body payload.

The brief-paste call sites in start.ts + rotate.ts already route through `bootClaudeMember` (ADR-081 §C) which uses paste-submit internally — those were on the correct path pre-T3b3.

## Escalation log

On send-keys failure (all retries exhausted), append to `~/.atmux/state/send-keys-failures.log`:

```
[HH:MM MYT 2026-05-14] target=atmux:🧭-lead keys='claim --next --as lead\nC-m' attempts=2 timeout=3000ms
preCapture: <last 5 lines of pane before send>
postCapture: <last 5 lines after final attempt>
```

The log is append-only, MYT-timestamped, and bounded by an operator-managed rotation (`logrotate` config or similar — out of scope for this ADR).

## Doctor probe + Discord template

**Probe**: `send-keys-failure-recent` — warns when any failures appear in `send-keys-failures.log` within the last 1 hour. Doesn't block; surfaces in `atmux doctor --json` and Discord.

**Template**: `[send-keys-failure]` — verdict-first per CLAUDE.md §Discord:

```
🛑 **[send-keys-failure]** · `<team>` · HH:MM MYT

🔴 Stalled — send-keys failed N times targeting <member>

🛠️ keys: 'claim --next --as <member>\nC-m'
🛠️ verifier: composerEmpty
📍 last capture: <truncated 80-char excerpt>

🙏 Need from George (only when failure spans >5min)
  - A) check pane state manually — likely modal race or compacting
  - B) restart member — kill+respawn
  - Default at HH:MM MYT if silent: A
```

## Forward-compat with ADR-132 (martinet)

ADR-132's `Martinet.apply(NudgeAction)` is the long-term home for this pattern. T3/T4 of ADR-132 (`MinimaxMartinet` + `CursorMartinet` / `KimiMartinet` impls) MUST use `safeSendKeysWithVerify` internally — the contract is baked into the abstraction layer here so all martinet impls inherit it for free.

In the meantime (pre-martinet), driver + lead + whip + dispatch verbs use `safeSendKeysWithVerify` directly. Same helper, no rewrite needed when martinet lands.

## Resolved open questions

- **Verifier failure semantics**: `escalate` is the default — silent failure goes to a durable log + a doctor probe + a Discord ping. `throw` is reserved for callers that NEED the synchronous failure signal (e.g. a CLI entry that should exit non-zero on send-keys timeout).
- **Cross-team cage boundary**: out of scope for v1. Each `safeSendKeysWithVerify` call targets a single team's cage. Cross-team capture-and-verify is a different problem (tmux server connection, socket discovery).
- **Network-failure handling**: assume tmux is live; if dead, atmux doctor's existing cage-down probe handles it. This helper trusts the tmux server.
- **Default retry count**: 1 (i.e. 2 total attempts). More than 2 attempts compounds state-mutation risk faster than it improves success rate; the escalation path is the right response to a genuinely-stuck pane.

## Sub-tasks (per EPIC `t-5df48a74`)

| ID | Subject | Lane | Deps |
|----|---------|------|------|
| T1 (this) | Draft ADR-138 + escalation log + Discord template format | docs/be | — |
| T2 (`t-af007bb2`) | `safeSendKeysWithVerify` + 6 built-in verifiers + 100% line coverage tests | be | T1 |
| T3 (`t-63d0b342`) | Migrate callers + doctor probe `send-keys-failure-recent` + e2e test | be + test | T2 |

## Consequences

**Positive**:

- Eliminates silent send-keys failures across every cross-pane mutation in the codebase. Every send proves its own outcome.
- Operator-visible escalation path (log + doctor + Discord) — failures surface within minutes, not days.
- Martinet abstraction (ADR-132) inherits the pattern for free.

**Negative**:

- Per-call timeout overhead — every send now budgets up to `timeoutMs` waiting for the verifier. Real-world tail latency on a single dispatch grows from ~50 ms to up to ~3 s on a fully-stuck pane. Acceptable: dispatch happens at human-scale cadence (every Nmin), not in a hot loop.
- Verifier-correctness becomes a per-caller concern. A wrong verifier (e.g. `composerEmpty` for a flow that's expected to leave text in the composer) reports false failure. Mitigation: 6 canonical built-in verifiers cover the common cases; ad-hoc verifiers are reviewer-gated.
- Capture-poll loop adds tmux CLI invocation overhead. At 250 ms × ~12 captures-per-failed-send across the whip cadence, this is sub-1% CPU — not a budget concern.

**Reversibility**: high. Each caller migration is independent; reverting one caller doesn't ripple. The helper itself can be removed by reverting the abstraction-layer commit if the pattern proves wrong.

## Out of scope

- Replacing `safeSendKeys` itself (ADR-081 §A) — that's the layer below; this helper adds verification on top.
- Verification of pane state across cage boundaries (cross-team) — defer; single-team scope.
- Network-failure handling (tmux server unresponsive) — assume tmux is live.

## Amendment 2026-05-18 — `detectAndResubmit` downstream consumer (EPIC e-f28c2596)

EPIC e-f28c2596 ("auto-fire Enter on queued worker compose-box + rotate-lead brief-skip") added a new downstream consumer of `safeSendKeysWithVerify`:

- **`src/core/queued-text-resubmit.ts::detectAndResubmit`** (T1 c24ee2b) — pure-of-IO helper that detects stuck queued text in a worker compose box and (when safe) resubmits via an injected `sendKeysFn` closure. Callers wrap `safeSendKeysWithVerify` with `composerEmpty()` verifier; on verifier exhaustion the wrapped helper escalates to `~/.atmux/state/send-keys-failures.log` per ADR-168.

**Wiring sites** (all per-member or per-pane iteration, fire-on-idle-only):

- `src/verbs/poke.ts::checkMember` (T2 + T4 0d69bf3 / 490c0ec) — per-member iteration in the consolidated `runTick` loop (post-ADR-160 the legacy bash `whip.sh` per-member + team-level distinction collapsed into one `for (const member of team.members)`).
- `src/verbs/lane-tick.ts::runLaneTick` (T3 23a33b1) — per-member loop in the cron-fired lane orchestrator. New outcome `injected-queued-resubmit` distinguishes the resubmit-fired case from the legacy `injected` (claim-injection) case.
- `src/verbs/rotate.ts` — does NOT use `detectAndResubmit`. T7 (1b6b111) instead adds `BootClaudeOpts.forceBootPrompt?: boolean` to bypass the already-booted sentinel in `src/core/boot-claude.ts` after `/clear`; the verified-send path inside `bootClaudeMember` already uses `safeSendKeysWithVerify` directly for the C-m submit (the helper's spirit, not its specific entrypoint).

**Failure-log ownership** — `safeSendKeysWithVerify`'s built-in `onFail:"escalate"` path is the canonical writer of `send-keys-failures.log` rows. The helper's `failureLogFn` injection is for verb-stderr re-emission (operator visibility in cron tick logs) — file persistence is NOT duplicated.

**Cross-refs**:

- [ADR-168](168-send-keys-failures-log.md) — escalation log target + rotation policy.
- EPIC e-f28c2596 — auto-fire Enter on queued compose box + rotate-lead brief decouple.
- memory `feedback_atmux_send_for_queued_panes` — pre-fix recovery pattern (driver-side `atmux send <member>`); post-fix the cron-fired verbs auto-unstick, and `atmux send` is the fallback for the rare verify-exhausted case.

## Cross-references

- **ADR-081** ([`docs/adr/081-bootstrap-brief-paste-bug.md`](081-bootstrap-brief-paste-bug.md)) — §A C-m submit cascade; this helper sits on top.
- **ADR-132** — martinet abstraction; long-term home, inherits this helper. Not yet authored at the time of this ADR — forward-reference.
- **CLAUDE.md** §"Always read pane state BEFORE `tmux send-keys`" — the operator-level discipline this helper codifies into an abstraction.


## §Amendment 2026-05-20 — §"Why blanket-3x is wrong" superseded by ADR-188 for text-into-composer scope (t-72f90a08 docs sweep follow-up)

[ADR-188](188-tui-send-keys-canonical-4-step.md) (proposed 2026-05-20) supersedes this ADR's §"Why blanket-3x is wrong" for **text-into-composer callsites only** (`src/core/send.ts`, `src/core/paste-submit.ts`, `src/core/safe-send.ts` message-content sends, plus every verb that invokes those for typing/pasting message content). The new canonical pattern is **scroll → Enter×3 → paste → Enter×3** — wedge-data from 2026-05-19 /bruh fan-out (4-of-5 lead panes wedged) drove the trade-off: empty-turn-fire risk on safe-state callsites is accepted in exchange for the wedge-prevention payoff on popup-prone flows.

**Components of THIS ADR that remain in force** (per ADR-188 §"ADR-138 components that REMAIN in force"):

- `safeSendKeysWithVerify` verifier-after-send pattern (per-call contract)
- Escalation log at `~/.atmux/state/send-keys-failures.log`
- 5 built-in verifiers (`composerEmpty` / `agentThinking` / `modalClosed` / `contextNonZero` / `paneMatchesRegex`)
- `safeSendKeys` preflight gate
- Telemetry + observability surfaces

ADR-188's 4-step pattern is the **outer wrapper** around this ADR's verify-and-retry mechanism: scroll/dismiss-preamble → send → verify (this ADR) → if verify-failed, the 4-step pattern fires from scratch (not just the send step). Single-keystroke control callsites (menu nav, known-modals.ts auto-dismiss with a specific catalog-keystroke, copy-mode commands, raw tmux key passthrough that is NOT message-content) keep this ADR's verify-and-retry discipline without the 4-step preamble/postamble.

This file is the historical baseline — read ADR-188 for the forward direction once impl lands.
