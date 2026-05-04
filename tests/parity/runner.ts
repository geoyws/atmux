// ADR-009: Test strategy — parity harness runner.
//
// Entry point: takes a verb name + args + fixture path, spawns one side
// (bash or TS atmux), captures the five parity channels (stdout, stderr,
// exit code, post-state fs snapshot, intercepted Discord webhook calls),
// and returns a `ParityRun`. The comparator (`compare.ts`) takes two
// `ParityRun` captures (one bash, one TS) and emits `Divergence[]`.
//
// This file is the harness — it gets the explicit ADR-009 §3.5 carve-out
// for raw `Bun.spawn` (the spawn-wrapper rule applies to `src/`, not to
// test infrastructure).
//
// Phase 0: skeleton. Bodies throw `not-implemented`; the diff pipeline
// shape (types + module boundaries) is the deliverable.

import { resolve } from "node:path"

/**
 * Which atmux binary this run targets.
 * - `"bash"` — `bin/atmux` (frozen reference at HEAD 2aadc3f).
 * - `"ts"`   — `bin/atmux-bun` (port target). For Phase 0, returns a
 *              stub `exit=2`, `stderr="atmux-bun: not implemented"`.
 */
export type ParitySide = "bash" | "ts"

/**
 * Captured filesystem snapshot of `.atmux/` after a verb returns.
 *
 * Per ADR-009 §3:
 *   - JSON files diffed via Zod-canonical form (parsed via the schema
 *     factory under `tests/parity/fixtures/schemas.ts` until ADR-005).
 *   - Markdown / text files byte-equal after timestamp mask.
 *   - Inbox files match by `(member, lineCount, lastMsgID)` tuple to
 *     allow stable append-only ordering without losing append semantics.
 */
export type FsSnapshot = {
	[relativePath: string]: {
		bytes: Uint8Array
		mode: number
		isJson: boolean
		parsed?: unknown
	}
}

/**
 * One Discord webhook call captured by the recording stub.
 *
 * Mechanism (env-override vs script-override) deferred to ADR-008.
 * ADR-009 contracts the SHAPE — both bash and TS sides MUST emit each
 * outbound webhook call as a JSONL line in this form.
 */
export type DiscordCall = {
	/** ISO-8601 timestamp at intercept time. Masked during diff. */
	ts: string
	/** Webhook payload, e.g. `{ content: string, username?: string }`. */
	payload: {
		content: string
		[k: string]: unknown
	}
	/** Which side emitted the call — populated by the runner. */
	runner: ParitySide
}

/**
 * Result of a single bash- or TS-side verb invocation against a fixture.
 *
 * The comparator (`compare.ts`) consumes two `ParityRun` instances and
 * returns `Divergence[]`. Empty array = parity-green for that row.
 */
export type ParityRun = {
	side: ParitySide
	verb: string
	args: ReadonlyArray<string>
	/** Absolute path to the fixture root (the dir containing `.atmux/`). */
	fixturePath: string
	stdout: string
	stderr: string
	exit: number
	fsState: FsSnapshot
	discordCalls: ReadonlyArray<DiscordCall>
	durationMs: number
}

/**
 * Options accepted by `runVerb` — kept extensible for Phase 1 additions
 * (env overrides, working-dir overrides, signal handling).
 */
export type RunVerbOptions = {
	/** Hard timeout in ms. Defaults to 30_000. Caller responsibility on long verbs. */
	timeoutMs?: number
	/** Extra env vars merged on top of the harness's sandbox env. */
	env?: Record<string, string>
}

/**
 * Spawn one side against the fixture and capture the five parity channels.
 *
 * Phase 1 implementation responsibilities (TODO):
 *   1. Resolve binary path: `bash` → `<repo>/bin/atmux`,
 *                            `ts`   → `<repo>/bin/atmux-bun`.
 *   2. Inject the Discord recording stub via env-override per ADR-008.
 *      Both bash and TS MUST honour the same knob; harness writes JSONL
 *      to a tmp sink and reads it back into `discordCalls`.
 *   3. `Bun.spawn({ cmd, cwd: fixturePath, env, stdio: ["ignore", "pipe", "pipe"] })`.
 *   4. Wait with `timeoutMs`. On timeout: kill, throw `TimeoutError`.
 *   5. Capture stdout/stderr decoded UTF-8.
 *   6. Walk `<fixturePath>/.atmux/` post-run; populate `FsSnapshot`.
 *   7. Read JSONL sink into `discordCalls`.
 *   8. Return `ParityRun`.
 *
 * @throws never on nonzero exit (that's a captured channel, not an error)
 * @throws on timeout, missing binary, fixture-path nonexistent
 */
export async function runVerb(
	side: ParitySide,
	verb: string,
	args: ReadonlyArray<string>,
	fixturePath: string,
	_options?: RunVerbOptions,
): Promise<ParityRun> {
	// TODO(phase-1): implement per the responsibilities above.
	const _fixtureAbs = resolve(fixturePath)
	throw new Error(
		`runVerb(${side}, ${verb}, [${args.join(", ")}], ${_fixtureAbs}): not implemented (Phase 0 skeleton — see ADR-009 §3)`,
	)
}
