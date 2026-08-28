// ADR-272 §Supplement (model-pin drift guard) — the OPT-IN live smoke.
//
// `scripts/vox-live-smoke.ts` is a thin shim over this module; the logic
// lives here so it sits inside the `src/**` coverage universe (the same
// split `scripts/vox-probe.ts` → `src/core/vox/probe.ts` uses).
//
// ---------------------------------------------------------------------
// What it proves, and why the drift guard is not enough on its own
// ---------------------------------------------------------------------
//
// `checkModelPin` answers "does this model id exist?". That is the cheap,
// always-on half. It does NOT answer "will a realtime session with this
// model actually open, negotiate, and return audio?" — and the
// 2026-08-15 failure was exactly the second question: `gpt-realtime` was
// a perfectly real model id, and the SHAPE of the session frames was
// retired. A model-list GET would not have caught it. A dial would.
//
// So this dials a REAL provider and asserts two things a broken adapter
// cannot fake: a `session-ready` event, and a non-zero count of DOWNLINK
// AUDIO BYTES. Bytes rather than "an event arrived", because a provider
// that accepts the socket and then says nothing is the exact fault the
// `no session-ready within 12000ms` line was added for.
//
// ---------------------------------------------------------------------
// Why it is opt-in and OUT of the unit suite
// ---------------------------------------------------------------------
//
// It costs money (realtime audio is billed per minute), it needs real
// keys that live only in the operator's git-crypt'd dotfiles, and it
// fails whenever the provider has an outage — which in CI is a red build
// that says nothing about the commit. A test that goes red for reasons
// unrelated to the change is a test people learn to ignore, and that is
// worse than not having it.
//
// The ORCHESTRATION below is unit-tested against an injected fake
// provider, so the logic is covered without a network. Only the shim
// dials.
//
// **When to run it: before a deploy, and after ANY provider or model
// bump.** Those are the two moments the adapter's assumptions can have
// gone stale without a line of atmux changing.

import type {
  VoiceProvider,
  VoiceProviderConfig,
  VoiceSession,
  VoiceSessionOpts,
} from "../../abstractions/voice-provider.ts";

/**
 * The prompt the smoke speaks.
 *
 * Deliberately demands SPOKEN output: the assertion is on downlink audio
 * bytes, and a model that replied only in text would produce a green
 * `session-ready` with zero bytes — which is the shape of a real fault,
 * not of a passing smoke.
 */
export const SMOKE_PROMPT = "Say the single word: ready.";

/** Instructions for the smoke session. No tools: this exercises the
 *  TRANSPORT and the audio negotiation, and a tool round trip would add
 *  a second failure mode to a check whose value is a narrow verdict. */
export const SMOKE_INSTRUCTIONS =
  "You are a connectivity probe. Reply out loud with exactly one word: ready.";

/** Default wall-clock bound for the whole dial + reply. */
export const SMOKE_TIMEOUT_MS_DEFAULT = 30_000;

export interface LiveSmokeResult {
  ok: boolean;
  kind: string;
  model: string;
  /** Did the provider ever reach `session-ready`? */
  sessionReady: boolean;
  /** Downlink PCM bytes received. The half a stalled provider cannot fake. */
  downlinkBytes: number;
  downlinkFrames: number;
  /** Assistant transcript text, if the provider sent any. */
  transcript: string;
  /** ms from `connect()` to the last event consumed. */
  elapsedMs: number;
  /** Populated when `ok` is false. */
  failure: string | null;
}

export interface LiveSmokeDeps {
  provider: VoiceProvider;
  cfg: VoiceProviderConfig;
  /** Overall bound. */
  timeoutMs?: number;
  /** ms clock. */
  clock?: () => number;
  /** Deadline sleeper (injected so a test need not really wait). */
  sleep?: (ms: number) => Promise<void>;
  /** Diagnostic sink (stderr in the shim). Never receives the key. */
  log?: (line: string) => void;
}

/** Session opts the smoke dials with — push-to-talk, no tools. */
export function smokeSessionOpts(): VoiceSessionOpts {
  return {
    instructions: SMOKE_INSTRUCTIONS,
    tools: [],
    turnDetection: { mode: "ptt" },
  };
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as unknown as { unref?: () => void }).unref?.();
  });
}

/**
 * Dial a real provider and assert session-ready + downlink audio.
 *
 * Never throws: a connect failure, a provider error, or a timeout is
 * reported as `ok: false` with a `failure` string. The shim maps `ok` to
 * the exit code, so a red run is always a readable line rather than a
 * stack trace.
 */
export async function runLiveSmoke(deps: LiveSmokeDeps): Promise<LiveSmokeResult> {
  const clock = deps.clock ?? ((): number => Date.now());
  const sleep = deps.sleep ?? realSleep;
  const log = deps.log ?? ((): void => {});
  const timeoutMs = deps.timeoutMs ?? SMOKE_TIMEOUT_MS_DEFAULT;
  const started = clock();
  const out: LiveSmokeResult = {
    ok: false,
    kind: deps.provider.kind,
    model: deps.cfg.model,
    sessionReady: false,
    downlinkBytes: 0,
    downlinkFrames: 0,
    transcript: "",
    elapsedMs: 0,
    failure: null,
  };

  let session: VoiceSession;
  try {
    session = await deps.provider.connect(deps.cfg, smokeSessionOpts());
  } catch (e) {
    out.failure = `connect failed: ${e instanceof Error ? e.message : String(e)}`;
    out.elapsedMs = clock() - started;
    log(out.failure);
    return out;
  }

  const consume = (async (): Promise<void> => {
    for await (const ev of session.events()) {
      switch (ev.type) {
        case "session-ready":
          out.sessionReady = true;
          log("session-ready");
          // The text turn is sent only AFTER the provider says it is
          // configured — asking a session that never negotiated proves
          // nothing about the negotiation.
          session.sendText(SMOKE_PROMPT);
          break;
        case "audio-out":
          out.downlinkFrames += 1;
          out.downlinkBytes += ev.pcm.length;
          break;
        case "transcript":
          if (ev.role === "assistant") out.transcript += ev.text;
          break;
        case "provider-error":
          // Recorded rather than fatal-on-sight: the LAST error is the
          // diagnostic one, and a non-fatal error mid-stream is normal.
          out.failure = `provider error${ev.code === undefined ? "" : ` [${ev.code}]`}: ${ev.message}`;
          log(out.failure);
          break;
        case "closed":
          log(`closed code=${String(ev.code)} reason=${ev.reason}`);
          break;
        default:
          break;
      }
    }
  })();

  // Stop as soon as the verdict is decidable — both halves satisfied —
  // so a passing smoke costs one turn rather than the whole budget.
  const deadline = started + timeoutMs;
  while (clock() < deadline && !(out.sessionReady && out.downlinkBytes > 0)) {
    await sleep(POLL_MS);
  }

  await session.close();
  await consume;
  out.elapsedMs = clock() - started;

  if (!out.sessionReady) {
    out.failure ??= `no session-ready within ${timeoutMs}ms — the socket opened but the provider never negotiated`;
    return out;
  }
  if (out.downlinkBytes === 0) {
    out.failure ??= "session-ready arrived but the provider sent NO downlink audio";
    return out;
  }
  out.ok = true;
  out.failure = null;
  return out;
}

/** Poll interval for the verdict loop. One audio frame's worth. */
export const POLL_MS = 40;

/** Human summary line (stderr). Never contains a credential. */
export function formatLiveSmoke(r: LiveSmokeResult): string {
  const parts = [
    `ok=${r.ok}`,
    `provider=${r.kind}`,
    `model=${r.model}`,
    `sessionReady=${r.sessionReady}`,
    `downlinkFrames=${r.downlinkFrames}`,
    `downlinkBytes=${r.downlinkBytes}`,
    `elapsedMs=${r.elapsedMs}`,
  ];
  if (r.transcript.length > 0)
    parts.push(`transcript=${JSON.stringify(r.transcript.slice(0, 80))}`);
  if (r.failure !== null) parts.push(`failure=${r.failure}`);
  return `vox-live-smoke: ${parts.join(" ")}`;
}
