# ADR-309: Reconcile the driver send-keys revocation with the shipped guard

**Status:** superseded by [ADR-293](293-driver-send-keys-guard-kept-after-2026-09-08-revocation.md) — never accepted (drafted as Proposed; recorded here for trace only)
**Date:** 2026-09-23
**Deciders:** Operator, reviewer
**Numbering note (2026-10-02, t-8030039a)**: drafted as ADR-290 at d1219b79; renumbered to 309 on landing — trunk ADR-290 is the superdriver-lane shortform decision. The draft's option-(a) outcome is already recorded, accepted, in ADR-293 (2026-09-28); the ARCHITECTURE.md and ADR-239 pointer edits proposed alongside the draft were never applied, and trunk carries the ADR-293 equivalents instead. The `Amends` line below is draft history only and never took effect. Decision text below is otherwise verbatim from the draft.
**Amends (draft history only — never effective):** [ADR-239](239-three-driver-minimum-per-team-and-no-sendkeys-invariant.md) §D2 and §A5

## Context

ADR-239 made driver panes operator-interactive only and installed a product-level
ban on sending keystrokes to them. The lowest-level tmux abstraction enforces
that ban with `DriverSendKeysViolation`, so in-tree `send`, `nudge`, and
`dispatch` paths cannot inject input into a window named `driver` or
`driver-N`.

The operator revoked the broader pane-to-pane send-keys ban on 2026-09-08.
That revocation did not ask the shipped atmux binary to gain a driver-input
surface. It established a separate operator workflow in
`/Users/geoyws/.agents/skills/pane-agent/SKILL.md`: capture the target pane
before every send, act on the captured state, and use pane input only for
lifecycle operations or a short pointer to an already-durable board row.
Since 2026-09-15, an explicit operator instruction to send while a pane is
working uses `send --queued` rather than waiting for idle.

The two policies therefore govern different surfaces, but ADR-239's absolute
wording makes them appear contradictory. This amendment records the boundary.

## Decision

Choose **option (a): retain `DriverSendKeysViolation` as shipped product
behaviour**.

1. The in-tree guard remains unchanged for `send`, `nudge`, and `dispatch`.
   atmux product code continues to refuse send-keys and paste-buffer operations
   targeting driver windows.
2. The operator override lives outside the shipped binary, in the pane-agent
   path cited above. It does not weaken, bypass, or configure the in-tree guard.
3. The override's scope is **driver windows only**. Every send requires a fresh
   capture-before-send inspection. On an explicit operator instruction,
   `send --queued` may accept the states documented by pane-agent, but a dialog
   or an existing draft is always refused.
4. ADR-239 §D2 and §A5 remain the product contract. Their absolute language is
   read as applying to atmux's shipped send/nudge/dispatch surfaces, not to the
   operator-owned pane-agent workflow.

This is a documentation-only reconciliation. Option (a) requires no `src/` or
test changes.

## Rejected options

- **(b) Narrow the guard with a logged operator override:** rejected because it
  would duplicate operator policy inside the product and create a bypassable,
  state-dependent guard around a surface the operator already controls externally.
- **(c) Lift the guard entirely:** rejected because it would expose driver
  injection through general product verbs, broader than the narrowly
  controlled operator workflow.

## Consequences

- The tree and the operator rule no longer disagree: the product refuses driver
  input, while the external operator tool may perform it under its stricter
  capture and state-refusal discipline.
- Existing guard behaviour and tests remain authoritative for the shipped
  binary.
- Future changes that permit an in-tree verb to target a driver window require
  a new ADR and corresponding source/test changes; this amendment grants no
  such permission.
