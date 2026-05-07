// ADR-009 §3 + ADR-008 §"Test interception": Discord recording stub.
//
// Both bash and TS atmux honour `ATMUX_DISCORD_RECORDER` — instead of
// POSTing each Discord webhook call to the live webhook, they append a
// JSONL line to the file at that path. The harness reads the sink back
// as `DiscordCall[]` and feeds it into compare().
//
// MECHANISM (ADR-008 §"Test interception"):
//   - Env var `ATMUX_DISCORD_RECORDER=<sink-path>`
//   - Each call appends one JSONL line: `{ts: ISO-8601, payload: <body>}`
//   - The `runner: bash|ts` discriminator is added by the harness on
//     read-back (binaries don't need to know which side they are).
//
// Bash-side support for `ATMUX_DISCORD_RECORDER` is a porter-B Phase 2
// follow-up per ADR-008's references. Until that lands, the bash side
// will emit zero calls when `ATMUX_DISCORD_WEBHOOK=""` (the harness sets
// this as a belt-and-suspenders no-pong guard) — both sides produce empty
// `DiscordCall[]` and parity-green is honest. Verbs that emit Discord
// (whip, report, ...) need the bash-side recorder support before they
// become parity-testable.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { DiscordCall, ParitySide } from "./runner.ts";

/**
 * Env-override descriptor returned by `prepareInterceptor`. The harness
 * exports these vars on top of the spawn env so both atmux binaries
 * write JSONL to `sinkPath` instead of POSTing to live Discord.
 *
 * `cleanup()` removes the sink file. Caller (`runner.ts`) MUST always
 * `await cleanup()` after reading, even on test failure (handled via
 * try/finally in `runner.ts`).
 */
export type DiscordInterceptor = {
  /** Path to the JSONL sink (one line per call). */
  sinkPath: string;
  /** Env vars the harness must export to the spawned atmux process. */
  env: Readonly<Record<string, string>>;
  /** Read the sink and return the calls in append order. */
  readCalls: (side: ParitySide) => Promise<DiscordCall[]>;
  /** Idempotent. Removes the sink file. */
  cleanup: () => Promise<void>;
};

/**
 * Allocate a fresh JSONL sink for one parity-run pair.
 *
 * Steps:
 *   1. `mkdtemp` under `os.tmpdir()/atmux-parity-discord-XXXX/`.
 *   2. Touch `webhook.jsonl` (so empty-call runs read back `[]` cleanly).
 *   3. Build `env` per ADR-008 §"Test interception".
 *   4. Return descriptor.
 */
export async function prepareInterceptor(): Promise<DiscordInterceptor> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atmux-parity-discord-"));
  const sinkPath = path.join(dir, "webhook.jsonl");
  await fs.writeFile(sinkPath, "");

  let cleaned = false;
  return {
    sinkPath,
    env: {
      ATMUX_DISCORD_RECORDER: sinkPath,
    },
    readCalls: async (side: ParitySide): Promise<DiscordCall[]> => {
      let raw: string;
      try {
        raw = await fs.readFile(sinkPath, "utf8");
      } catch (err) {
        if (err instanceof Error && "code" in err && (err as { code?: string }).code === "ENOENT") {
          return [];
        }
        throw err;
      }
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      const calls: DiscordCall[] = [];
      for (const line of lines) {
        // tests/parity/ has the explicit JSON.parse carve-out (ADR-009
        // §3.5 rule applies to src/**, not tests/**). Each malformed
        // line surfaces as a synthetic record so the comparator emits
        // a divergence rather than the harness throwing.
        let parsed: { ts?: unknown; payload?: unknown };
        try {
          parsed = JSON.parse(line) as { ts?: unknown; payload?: unknown };
        } catch {
          calls.push({
            ts: "<unparseable>",
            payload: { content: line },
            runner: side,
          });
          continue;
        }
        const ts = typeof parsed.ts === "string" ? parsed.ts : "<missing-ts>";
        const payload =
          parsed.payload && typeof parsed.payload === "object"
            ? (parsed.payload as { content: string; [k: string]: unknown })
            : { content: line };
        calls.push({ ts, payload, runner: side });
      }
      return calls;
    },
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        // expected: idempotent — already removed by another teardown path
      }
    },
  };
}

/**
 * Mask used by the comparator on captured `DiscordCall.ts`. Exported
 * here (not in `compare.ts`) so the recording-stub design can stay
 * close to the call shape — `ts` is the only field the stub fills in
 * with wall-clock data, and it's the only field that's expected to
 * differ between two otherwise-identical bash and TS runs.
 */
export const DISCORD_TS_MASK = "<ts-masked>";
