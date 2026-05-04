// ADR-009 §3 + ADR-008 (forthcoming): Discord recording stub.
//
// Both bash and TS atmux MUST honour the same env-override knob during
// parity runs — instead of POSTing each Discord webhook call to the live
// webhook, they write a JSONL line to a harness-managed sink. The harness
// then reads the sink back as `DiscordCall[]` and feeds it into compare().
//
// The MECHANISM choice (env-override `ATMUX_DISCORD_WEBHOOK_URL=file://...`
// vs script-override `ATMUX_DISCORD_PING_SCRIPT=stub.sh`) belongs to
// ADR-008. This file ratifies the SHAPE bash + TS converge on:
//
//   - One JSONL line per Discord call.
//   - Each line is `{"ts": "<ISO-8601>", "payload": <webhook-body>}`.
//   - The `runner: bash|ts` discriminator is added by the harness on
//     read-back (the binaries themselves don't need to know which side
//     they are — they just write JSONL to the sink path the harness sets).
//
// Phase 0: skeleton. The functions throw `not-implemented`; ADR-008 +
// foundation porter (Phase 1) wire the actual stub script and the
// JSONL-reader.

import type { DiscordCall, ParitySide } from "./runner.ts"

/**
 * Env-override descriptor returned by `prepareInterceptor`. The harness
 * exports these vars on top of the spawn env so both atmux binaries
 * write JSONL to `sinkPath` instead of POSTing to live Discord.
 *
 * `cleanup()` removes the sink file. Caller (`runner.ts`) MUST always
 * `await cleanup()` after reading, even on test failure (handled via
 * `bun:test` `afterEach`).
 */
export type DiscordInterceptor = {
	/** Path to the JSONL sink (one line per call). */
	sinkPath: string
	/** Env vars the harness must export to the spawned atmux process. */
	env: Readonly<Record<string, string>>
	/** Read the sink and return the calls in append order. */
	readCalls: (side: ParitySide) => Promise<DiscordCall[]>
	/** Idempotent. Removes the sink file. */
	cleanup: () => Promise<void>
}

/**
 * Allocate a fresh JSONL sink for one parity-run pair.
 *
 * Phase 1 implementation responsibilities (TODO):
 *   1. `mkdtemp` under `os.tmpdir()/atmux-parity-XXXX/`.
 *   2. Touch `webhook.jsonl`.
 *   3. Build `env` per ADR-008 (knob TBD).
 *   4. Return descriptor.
 */
export async function prepareInterceptor(): Promise<DiscordInterceptor> {
	throw new Error(
		"prepareInterceptor(): not implemented (Phase 0 skeleton — ADR-008 ratifies env-knob choice; see ADR-009 §3)",
	)
}

/**
 * Mask used by the comparator on captured `DiscordCall.ts`. Exported
 * here (not in `compare.ts`) so the recording-stub design can stay
 * close to the call shape — `ts` is the only field the stub fills in
 * with wall-clock data, and it's the only field that's expected to
 * differ between two otherwise-identical bash and TS runs.
 */
export const DISCORD_TS_MASK = "<ts-masked>"
