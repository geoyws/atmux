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
export type FixturePreset = "minimal" | "lifecycle" | "multi-team"

/**
 * What the row's authors expect a parity-green outcome to look like.
 * Used by `index.test.ts` to choose between strict-byte-equal and
 * semantic-aware diffing on stdout (ADR-009 §3 timestamp-mask rule).
 */
export type ParityExpectation =
	| "exit-zero-stable-stdout"
	| "exit-zero-timestamped-stdout"
	| "exit-nonzero-stable-stderr"

export type ParityRow = {
	verb: string
	args: ReadonlyArray<string>
	fixturePreset: FixturePreset
	expect: ParityExpectation
	/**
	 * Optional human-readable label for the bun:test row name. Defaults
	 * to `<verb> ${args.join(" ")} [${fixturePreset}]` if omitted.
	 */
	label?: string
}

/**
 * The parity matrix. Empty in Phase 0; Phase 2 porters add one row per
 * verb invocation they're porting.
 *
 * Reviewer rule: every new verb in `src/verbs/**` MUST add at least one
 * matrix row in the same commit. The reviewer's 8-check gate enforces
 * this via `tests/e2e/PORT-MAP.md` cross-reference (ADR-009 §4).
 */
export const PARITY_MATRIX: ReadonlyArray<ParityRow> = []
