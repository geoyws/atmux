# ADR-293: Driver send-keys guard kept as product behaviour after the 2026-09-08 pane-to-pane revocation

**Status**: proposed
**Date**: 2026-09-23
**Driver-ref**: E1-T0 amendment task (kb `atmux` t-d90f05c6) — operator revoked the pane-to-pane send-keys ban 2026-09-08; epic direction chooses (a) keep the in-tree guard.
**Relates**: [ADR-239](239-three-driver-minimum-per-team-and-no-sendkeys-invariant.md) §D2 (no-send-keys-to-drivers invariant + `DriverSendKeysViolation` runtime guard), [ADR-285](285-cooperative-bot-seat-and-superbot-offer-protocol.md) (the `_bot` cooperative seat is the automation-capable target, not a driver)

## Context

From 2026-09-02 to 2026-09-08 a board rule (r-1376df29, on a Consumer-Terms reading) banned pane-to-pane `send-keys` outright. On 2026-09-08 the operator revoked that ban: `tmux send-keys` into a pane is permitted again for lifecycle operations (pause, close, relaunch, resume) and for short pointers at kb rows that already exist — never as the only record of work (`~/.claude/skills/pane-agent/SKILL.md:12-17`).

The revocation is conditional, not blanket. The skill requires a fresh capture before every send (`SKILL.md:91-96`), keeps `dialog` refused because keys would become a menu choice, keeps an existing `draft` refused because text would concatenate onto somebody's typed input, and since 2026-09-15 routes operator-authorized sends through `send --queued`, which widens only `idle`/`busy`/`unknown` — never `dialog` or `draft` (`SKILL.md:98-108`).

Meanwhile the in-tree product guard stands unchanged: `src/abstractions/tmux.ts` `pane.sendKeys` (and symmetrically `buffer.pasteBuffer`) throws `DriverSendKeysViolation` for any serialized target whose window name matches `^driver(-[0-9]+)?$`, before tmux is touched (ADR-239 §D2, §A5). The question is whether the operator-level revocation should relax or remove that product-level refusal.

## Decision

### D1 — Keep the guard: choice (a)

The in-tree `DriverSendKeysViolation` guard stays as product behaviour for every automated send path (`send`, `nudge`, `dispatch`, broadcast, verified-send). No `src/` change; this ADR only records the posture. Reasons:

1. **Different actors, different discipline.** The revocation governs human-driven pane-agent operations, where an operator (or an agent acting on a live screen) captures the pane, reads the composer/footer state, and takes responsibility for the keystrokes. Automated product paths have no capture-before-send step and no reader on the other end — they cannot satisfy the skill's preconditions, so the revocation's conditions do not transfer to them.
2. **The hazard the skill guards against is exactly what automation would do.** Dialog-refused and draft-refused exist because blind keystrokes land in menus and mid-typed input. An automated nudge into a driver pane — the operator's live interactive surface — is blind keystrokes by construction.
3. **Lowest-level coverage is load-bearing.** The refusal lives in the lowest-level helper so every caller is covered without per-call audit (ADR-239 §A5). Any relaxation would trade one checked invariant for an audit of every current and future send-keys callsite.
4. **Automation already has its target.** ADR-285's `_bot` seat exists precisely so automation has a cooperative pane to type into — noting its live activation is held (accepted operator-direct; source implemented, live activation held; verified automated offers limited to the explicit Claude harness). Drivers do not need to double as one.

### D2 — Scope of the revocation (what changed, what did not)

- Operator-driven pane input (lifecycle + short kb-row pointers, capture-first, queued where authorized) is permitted again since 2026-09-08 — including, at operator discretion, into driver windows.
- Product-driven pane input into `driver` / `driver-N` remains refused at the lowest level, for all verbs and all callers — with the guard's name-only reach: serialized numeric targets (e.g. `atmux:1`) pass through by design (`tests/unit/abstractions/tmux-driver-guard.test.ts:119-131`). `send --queued`'s widening applies to the pane-agent helper's state machine, not to the in-tree guard, which still throws before tmux is touched.
- The harness note stands: an auto-mode classifier may still deny `send-keys` at the tool layer regardless of the revocation (`SKILL.md:289-292`) — that is harness behaviour, not policy, and orthogonal to this decision.

## Rejected alternatives

- **(b) Remove the guard to mirror the revocation** — rejected: conflates an operator-policy permission (conditional, human-supervised, capture-first) with a product-behaviour refusal (unconditional, unsupervised); re-opens every automated path to typing into the operator's live panes.
- **(c) Downgrade the guard to warn-and-continue (or narrow it to `send` only)** — rejected: a warning no human is watching is no guard at all, and a narrowed guard just moves the bypass one callsite over while keeping the audit burden D1-3 refuses.

## Consequences

- No code, test, or behaviour change: the guard and its 18 existing tests already assert this posture.
- ADR-239 gains a dated amendment note pointing here; the D2 invariant text is otherwise untouched.
- Drivers remain unusable as automation targets; anything that needs automated pane input addresses a member, `_bot` (subject to ADR-285's held live activation), or service pane.

## Acceptance gates

- `tests/unit/abstractions/tmux-driver-guard.test.ts` stays green unchanged (5 refusal + 4 pass-through + message-shape + 8 parse tests).
- Promotion to `accepted` is the owner's call; this ADR ships as `proposed`.
