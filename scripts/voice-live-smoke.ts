#!/usr/bin/env bun
// ADR-272 §Supplement — OPT-IN live provider smoke (RUNBOOK-voice §6.7).
//
// Dials a REAL provider with real credentials and asserts two things:
// a `session-ready` event, and a non-zero count of downlink audio bytes.
//
// **This is deliberately NOT part of `bun test`.** It costs money
// (realtime audio is billed per minute), it needs keys that live only in
// the operator's git-crypt'd dotfiles, and it goes red on a provider
// outage — a CI failure that says nothing about the commit. The
// orchestration it drives (`src/core/voice/live-smoke.ts`) IS unit-tested
// against a fake provider, so the logic is covered without a network.
//
// **Run it before a deploy, and after ANY provider or model bump.**
//
// Usage — the key comes from the ENVIRONMENT, never argv (a tmux pane
// capture records command lines):
//
//   OPENAI_API_KEY=… bun scripts/voice-live-smoke.ts
//   GEMINI_API_KEY=… bun scripts/voice-live-smoke.ts --provider gemini
//   GEMINI_API_KEY=… bun scripts/voice-live-smoke.ts --provider gemini \
//                      --model gemini-2.5-flash-native-audio-latest
//
// Exit 0 iff session-ready arrived AND downlink bytes > 0. All output is
// on stderr; stdout stays clean.

import { reportError } from "../src/cli.ts";
import {
  createVoiceProvider,
  defaultModelFor,
  parseProviderKind,
} from "../src/abstractions/voice/factory.ts";
import { formatLiveSmoke, runLiveSmoke } from "../src/core/voice/live-smoke.ts";
import { checkModelPin, formatModelCheck } from "../src/core/voice/model-check.ts";
import { apiKeyEnvVarFor, requireApiKey } from "../src/verbs/voice.ts";
import { UsageError } from "../src/errors.ts";

const USAGE =
  "bun scripts/voice-live-smoke.ts [--provider openai|gemini] [--model <id>] [--timeout-ms <n>]";

interface Args {
  provider: string;
  model?: string;
  timeoutMs?: number;
}

function parseArgs(argv: ReadonlyArray<string>): Args {
  const out: Args = { provider: process.env.ATMUX_VOICE_PROVIDER ?? "openai-realtime" };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--provider" && v !== undefined) {
      out.provider = v;
      i += 2;
      continue;
    }
    if (a === "--model" && v !== undefined) {
      out.model = v;
      i += 2;
      continue;
    }
    if (a === "--timeout-ms" && v !== undefined) {
      out.timeoutMs = Number(v);
      i += 2;
      continue;
    }
    throw new UsageError({ what: `voice-live-smoke: unknown or incomplete arg: ${a ?? ""}`, hint: USAGE });
  }
  return out;
}

async function main(argv: ReadonlyArray<string>): Promise<number> {
  const args = parseArgs(argv);
  const kind = parseProviderKind(args.provider);
  const apiKey = requireApiKey(kind, process.env);
  const model = args.model ?? process.env.ATMUX_VOICE_MODEL ?? defaultModelFor(kind);
  const log = (line: string): void => {
    process.stderr.write(`voice-live-smoke: ${line}\n`);
  };
  log(`provider=${kind} model=${model} key=${apiKeyEnvVarFor(kind)} (value never printed)`);

  // The cheap check first: if the id does not exist, say so plainly
  // rather than letting the dial fail in the interesting-looking way.
  for (const line of formatModelCheck(await checkModelPin({ kind, model, apiKey }))) {
    process.stderr.write(`${line}\n`);
  }

  const result = await runLiveSmoke({
    provider: createVoiceProvider(kind),
    cfg: { apiKey, model },
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
    log,
  });
  process.stderr.write(`${formatLiveSmoke(result)}\n`);
  return result.ok ? 0 : 1;
}

let code: number;
try {
  code = await main(process.argv.slice(2));
} catch (e) {
  code = reportError(e);
}
process.exit(code);
