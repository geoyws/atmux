// ADR-132 §D4 / T2 (t-2791cf60): ClaudeSentinel — degenerate
// baseline impl + fallback when non-Claude managers fail.
//
// Behaviour: this impl IS the existing whip §1a loop wrapped in
// the Sentinel interface contract. observe() returns the
// canonical Observation shape so T3+ impls have a baseline to
// compose against. decide() always emits a single
// `escalate-to-claude-lead` — the Claude lead's whip-prompt.md
// §1a continues to do ALL the mechanical work in the
// `name === "claude"` configuration (this is the "degenerate"
// part — no behaviour change for teams running on the default
// sentinel). apply() is unreachable for this impl (decide() only
// emits the escalation terminal). shouldEscalateToClaudeLead()
// is unconditionally true.
//
// The cost-saving promise of ADR-132 lands when teams flip to
// `sentinel: "cursor"` (T3); ClaudeSentinel preserves zero-
// regression for the legacy default config.

import type { ApplyResult, NudgeAction, Observation, Sentinel } from "../sentinel.ts";

/** Construct-time dependencies. Test suites inject fakes; the
 *  T7 cockpit tick verb (sibling Task) wires the real impls. */
export interface ClaudeSentinelDeps {
  /** Observation provider — called per-team per-tick. The
   *  degenerate impl delegates entirely to whatever the
   *  dispatcher passes in; the dispatcher in turn reads pane
   *  state + kanban state via existing whip primitives.
   *
   *  Default (production): cockpit-level T7 dispatcher composes
   *  a real Observation from `tmux.pane.capturePane` over
   *  `team.members[]` + `HygieneRepo.listUnfixed()` + git-log
   *  commit cadence sweep. Tests pass a synthetic fixture. */
  observeFn: (team: string) => Promise<Observation>;
}

export class ClaudeSentinel implements Sentinel {
  readonly name = "claude" as const;
  private readonly deps: ClaudeSentinelDeps;

  constructor(deps: ClaudeSentinelDeps) {
    this.deps = deps;
  }

  /** Pass-through to the injected observer. ClaudeSentinel adds
   *  no observation logic of its own — the existing whip-prompt
   *  §1a loop already runs in the Claude lead's pane and reads
   *  the same surfaces. Returning the dispatcher's Observation
   *  unchanged keeps the T3/T6 evolution path straightforward. */
  async observe(team: string): Promise<Observation> {
    return await this.deps.observeFn(team);
  }

  /** Degenerate decision: escalate-to-claude-lead, always. The
   *  Claude lead's whip-prompt.md §1a takes the actual action
   *  set; the Sentinel just hands the observation across.
   *
   *  The emitted action carries the full observation in its
   *  payload so the cockpit dispatcher can route it into the
   *  team's driver-inbox / lead pane verbatim. */
  async decide(obs: Observation): Promise<NudgeAction[]> {
    return [
      {
        kind: "escalate-to-claude-lead",
        observation: obs,
        reason: "claude sentinel — degenerate impl, all judgment defers to lead",
      },
    ];
  }

  /** Unreachable for ClaudeSentinel. decide() only emits the
   *  escalate-to-claude-lead terminal — the cockpit dispatcher
   *  filters that branch out before invoking apply(). Throwing
   *  surfaces the misuse loudly rather than silently no-op-ing,
   *  matching the discriminated-union exhaustive-check posture
   *  in the rest of the codebase (e.g. boot-claude.ts's
   *  defensive paths). */
  async apply(action: NudgeAction): Promise<ApplyResult> {
    throw new Error(
      `ClaudeSentinel.apply() is unreachable — decide() only emits 'escalate-to-claude-lead'; ` +
        `dispatcher must not invoke apply() for this impl. Received: ${action.kind}`,
    );
  }

  /** Unconditionally true. The degenerate impl escalates every
   *  tick — there's no autonomous-action surface to gate. T3's
   *  CursorSentinel will override this with the real §D5
   *  six-trigger gate. */
  shouldEscalateToClaudeLead(_obs: Observation): boolean {
    return true;
  }
}
