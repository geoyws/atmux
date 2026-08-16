#!/usr/bin/env bun
// ADR-272 §Supplement — OPT-IN end-to-end behavioural gate for voice
// (RUNBOOK-vox §6.8).
//
// Real TTS speech in → a real provider → a THROWAWAY fake atmux cage → an
// LLM-as-judge verdict on whether the assistant actually answered correctly.
//
// **This is deliberately NOT part of `bun test`.** It costs money (realtime
// audio, TTS, and a judge call per scenario), it needs three real keys that
// live only in the operator's git-crypt'd dotfiles, and it goes red on any
// provider outage — a CI failure that says nothing about the commit. Same
// reasoning that keeps `vox-live-smoke.ts` out. The orchestration it
// drives (`src/core/vox/e2e/**`) IS unit-tested against fakes, so the
// logic is covered without a network.
//
// **Safety.** The harness builds its own cockpit in a temp dir, listing only
// teams it created, each with its own `tmuxTmpdir` and therefore its own
// tmux socket. `assertIsolated` refuses to proceed unless it can prove all
// of that — see `src/core/vox/e2e/isolation.ts`. It never touches the
// operator's real fleet, and never dials `atmux.geoy.ws`: the server it
// talks to is bound here, on an ephemeral loopback port.
//
// Usage — every key comes from the ENVIRONMENT, never argv (a tmux pane
// capture records command lines):
//
//   ENV=~/work/journals/.sb/_dotfiles/.devcontainer/env/shared.env
//   # NOTE the [^ #] class: these lines carry trailing "# [PERSONAL]"
//   # comments, and a naive `cut -d= -f2-` swallows the comment into the
//   # value, producing a malformed key and a mystifying failure.
//   export OPENAI_API_KEY=$(sed -n 's/^OPENAI_API_KEY=\([^ #][^ #]*\).*/\1/p' "$ENV")
//   export ANTHROPIC_API_KEY=$(sed -n 's/^ANTHROPIC_API_KEY=\([^ #][^ #]*\).*/\1/p' "$ENV")
//   bun scripts/vox-e2e.ts                    # every scenario
//   bun scripts/vox-e2e.ts --scenario attention
//   bun scripts/vox-e2e.ts --list
//   bun scripts/vox-e2e.ts --keep-temp        # leave the cage for inspection
//
// Exit 0 iff every scenario passed BOTH its mechanical tool gate and its
// judge verdict. All output is on stderr; stdout stays clean.

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { reportError } from "../src/cli.ts";
import { createTmux } from "../src/abstractions/tmux.ts";
import { UsageError } from "../src/errors.ts";
import {
  formatHarnessResult,
  type HarnessIo,
  runHarness,
  type ServerHandle,
} from "../src/core/vox/e2e/run.ts";
import { formatOutcome } from "../src/core/vox/e2e/judge.ts";
import { formatDriveResult } from "../src/core/vox/e2e/drive.ts";
import { SCENARIOS, scenarioById, scenarioIds } from "../src/core/vox/e2e/scenarios.ts";
import { VOX_DEFAULTS } from "../src/core/vox/config.ts";
import { applyDriverScope, buildVoxDeps, startVoxServer } from "../src/verbs/vox.ts";

const USAGE = "bun scripts/vox-e2e.ts [--scenario <id>] [--keep-temp] [--list]";

interface Args {
  scenario?: string;
  keepTemp: boolean;
  list: boolean;
}

function parseArgs(argv: ReadonlyArray<string>): Args {
  const out: Args = { keepTemp: false, list: false };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--keep-temp") {
      out.keepTemp = true;
      i += 1;
      continue;
    }
    if (a === "--list") {
      out.list = true;
      i += 1;
      continue;
    }
    if (a === "--scenario") {
      const v = argv[i + 1];
      if (v === undefined) throw new UsageError({ what: "--scenario requires a value", hint: USAGE });
      out.scenario = v;
      i += 2;
      continue;
    }
    throw new UsageError({ what: `vox-e2e: unknown arg: ${a ?? ""}`, hint: USAGE });
  }
  return out;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.length === 0) {
    throw new UsageError({
      what: `vox-e2e: ${name} is not set`,
      hint: "export it from the git-crypt'd dotfiles env file — see the header of this script",
    });
  }
  return v;
}

/**
 * Ask the kernel for a free TCP port by binding one and immediately letting
 * it go. Racy in principle; in practice the window is microseconds and the
 * alternative — `port: 0` through the config layer — silently lands on the
 * operator's live server (see the call site).
 */
function pickFreePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port ?? 0;
  probe.stop(true);
  return port;
}

/** Real filesystem + tmux wiring. */
const io: HarnessIo = {
  mkdtemp: (prefix) => mkdtemp(join(tmpdir(), prefix)),
  mkdir: async (path) => {
    await mkdir(path, { recursive: true, mode: 0o700 });
  },
  writeFile: async (path, contents) => {
    await writeFile(path, contents, "utf8");
  },
  writeBytes: async (path, bytes) => {
    await writeFile(path, bytes);
  },
  readFile: async (path) => {
    try {
      return await readFile(path, "utf8");
    } catch {
      return null;
    }
  },
  readBytes: async (path) => {
    try {
      return new Uint8Array(await readFile(path));
    } catch {
      return null;
    }
  },
  rm: async (path) => {
    await rm(path, { recursive: true, force: true });
  },
  tmux: (socketPath) => createTmux({ socketPath }),
  log: (line) => {
    process.stderr.write(`vox-e2e: ${line}\n`);
  },
};

async function main(argv: ReadonlyArray<string>): Promise<number> {
  const args = parseArgs(argv);
  if (args.list) {
    for (const s of SCENARIOS) process.stderr.write(`${s.id}\t${s.utterance}\n`);
    return 0;
  }

  const scenarios = (() => {
    if (args.scenario === undefined) return SCENARIOS;
    const one = scenarioById(args.scenario);
    if (one === null) {
      throw new UsageError({
        what: `vox-e2e: unknown scenario '${args.scenario}'`,
        hint: `known: ${scenarioIds().join(", ")}`,
      });
    }
    return [one];
  })();

  const openaiKey = requireEnv("OPENAI_API_KEY");
  const anthropicKey = requireEnv("ANTHROPIC_API_KEY");

  // Never inherit the outer tmux: every tmux call the harness makes is
  // socket-pinned, but an inherited $TMUX makes `new-session` complain about
  // nesting and would otherwise need `-d` semantics to be relied upon.
  delete process.env.TMUX;

  // A fresh per-run token — long enough for the config gate, and never
  // reused across runs, so a leaked one is worthless.
  const token = randomBytes(24).toString("hex");

  const log = (line: string): void => {
    process.stderr.write(`vox-e2e: ${line}\n`);
  };

  const startServer = async (opts: {
    cockpitPath: string;
    home: string;
    token: string;
  }): Promise<ServerHandle> => {
    // The env is already pinned by `runHarness`; assert rather than re-pin,
    // so a future reordering surfaces here instead of silently reading the
    // operator's real cockpit.
    if (process.env.ATMUX_COCKPIT_CONFIG !== opts.cockpitPath) {
      throw new Error("vox-e2e: cockpit env drifted before server start — refusing");
    }
    process.env.ATMUX_VOX_TOKEN = opts.token;
    // Pick a concrete free port rather than passing `port: 0`.
    //
    // `resolveVoxConfig`'s `resolveNumber` accepts a flag only when it is
    // `> 0`, so a literal 0 is treated as UNSET and silently falls back to
    // the 4390 default — which on this box is the operator's LIVE voice
    // server. That surfaced as an opaque `Bun.serve` throw on the first real
    // run; binding a throwaway listener on port 0 and reading back the
    // kernel's choice keeps the harness off any port anyone else is using.
    const port = pickFreePort();
    if (port === VOX_DEFAULTS.port) {
      throw new Error(`vox-e2e: refusing to bind the default voice port ${port}`);
    }
    // ADR-272 §D3: whoever reaches the socket IS the driver. Without this
    // the driver-scoped fleet verbs refuse and every scenario fails for a
    // reason that has nothing to do with the model.
    applyDriverScope(process.env);
    const deps = await buildVoxDeps({
      env: process.env,
      // Port 0 ⇒ the kernel picks a free one. Never the real deployment.
      flags: { port, host: "127.0.0.1", readonly: true },
    });
    const handle = startVoxServer({ deps });
    return {
      url: `ws://127.0.0.1:${handle.port}/ws`,
      stop: () => {
        handle.stop();
      },
    };
  };

  const result = await runHarness({
    io,
    env: process.env,
    uid: process.getuid?.() ?? 0,
    openaiKey,
    anthropicKey,
    startServer,
    scenarios,
    token,
    log,
    // OUTSIDE the temp root on purpose: the temp root is deleted on exit,
    // so a cache inside it would re-synthesize (and re-bill) every run.
    ttsCacheDir: join(tmpdir(), "atmux-vox-e2e-tts"),
    keepTemp: args.keepTemp,
  });

  for (const s of result.scenarios) {
    process.stderr.write(`\n=== ${s.scenario.id} ===\n`);
    process.stderr.write(`${formatDriveResult(s.drive)}\n`);
    process.stderr.write(`transcript: ${s.drive.transcript}\n`);
    if (s.judge !== null) {
      for (const line of formatOutcome(s.judge)) process.stderr.write(`${line}\n`);
    }
  }
  for (const line of formatHarnessResult(result)) process.stderr.write(`${line}\n`);
  return result.pass ? 0 : 1;
}

let code: number;
try {
  code = await main(process.argv.slice(2));
} catch (e) {
  code = reportError(e);
}
process.exit(code);
