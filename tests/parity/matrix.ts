// ADR-009: Test strategy — parity matrix.
//
// One row per (verb, args, fixture-preset) combination the harness
// exercises. `index.test.ts` iterates this array and runs runner+compare
// per row. Phase 0 ships an empty matrix; rows are added incrementally
// as verbs land in Phase 2.

/**
 * Fixture preset names. The factory under `tests/parity/fixtures/`
 * publishes these once it lands (Phase 1, after ADR-005 ratifies schemas).
 *   - `minimal`     — 2-member team, empty kanban, no inboxes
 *   - `lifecycle`   — 4-member template mirroring tests/e2e/lifecycle.bats
 *   - `multi-team`  — state shapes for atmux / sopx-mvp / ifca_aux / unum
 */
export type FixturePreset = "minimal" | "lifecycle" | "multi-team";

/**
 * What the row's authors expect a parity-green outcome to look like.
 * Used by `index.test.ts` to choose between strict-byte-equal and
 * semantic-aware diffing on stdout (ADR-009 §3 timestamp-mask rule).
 */
export type ParityExpectation =
  | "exit-zero-stable-stdout"
  | "exit-zero-timestamped-stdout"
  | "exit-nonzero-stable-stderr";

/**
 * Per-row, per-channel mask config. ADR-027 contract.
 *
 *   - `exitCode: true` skips exit-code comparison entirely (e.g. bash
 *     `exit 1` vs TS `exit 78` BSD-sysexits divergence per ADR-006).
 *   - `stdout` / `stderr`: a `RegExp` or `string` pattern fed straight
 *     to `String.replace(pattern, "")` on BOTH sides before byte-equal.
 *     Patterns lacking a `/g` flag replace only the first match — by
 *     design (anchored masks at line start are common).
 *   - `stateAfter`: glob → regex map. Glob shape `<filename-stem>.<path>`
 *     where `<filename-stem>` matches files like `*<stem>.json` in the
 *     fs snapshot, and `<path>` is a dot-separated JSON path with `[*]`
 *     wildcards for arrays. Matching string/number values are elided
 *     from BOTH sides' parsed JSON before canonicalised diff.
 *
 * Reviewer rule (ADR-027 §4): every mask entry MUST carry an inline
 * `// reason:` comment + ADR class label (`ADR-027 error-rendering
 * class` / `ADR-027 state-after class`). Uncited masks fail review.
 */
export type ChannelMask = {
  exitCode?: true;
  stdout?: RegExp | string;
  stderr?: RegExp | string;
  stateAfter?: Record<string, RegExp>;
};

export type ParityRow = {
  verb: string;
  args: ReadonlyArray<string>;
  fixturePreset: FixturePreset;
  expect: ParityExpectation;
  /**
   * Optional human-readable label for the bun:test row name. Defaults
   * to `<verb> ${args.join(" ")} [${fixturePreset}]` if omitted.
   */
  label?: string;
  /**
   * Optional channel-mask config (ADR-027). Absent = byte-equal /
   * canonical-JSON exact comparison across all channels (existing
   * `version` + `not-a-verb` rows). Present = per-channel mask
   * applied symmetrically before comparison.
   */
  mask?: ChannelMask;
};

/**
 * The parity matrix. Phase 3 iter-1 (per ADR-026) wires the 2 currently
 * parity-green verbs: `version` (happy-path proof) + unknown-verb
 * (`not-a-verb`, exit-code-class divergence proof).
 *
 * The 4 wired-but-`test.todo` skeletons (init/start/send/add-member)
 * stay parked: a probe at `/tmp/parity-probe` (2026-05-05) confirmed
 * real bash↔TS divergence on the no-team error path — bash emits
 * `💥 atmux …`/exit 1, TS emits `atmux: config: …`/exit 78 (BSD
 * sysexits). Reconciliation is per-verb porter work + an open
 * meta-decision (mirror-bash vs parity-mask exit codes); see
 * ADR-026's deferred table for the durable handle.
 */
export const PARITY_MATRIX: ReadonlyArray<ParityRow> = [
  {
    verb: "version",
    args: [],
    fixturePreset: "minimal",
    expect: "exit-zero-stable-stdout",
  },
  {
    verb: "not-a-verb",
    args: [],
    fixturePreset: "minimal",
    expect: "exit-nonzero-stable-stderr",
  },
];
