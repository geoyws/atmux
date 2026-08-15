// ADR-272: voice operator interface — provider kind parsing + construction.
//
// The single place operator input (`ATMUX_VOICE_PROVIDER`) becomes a
// `VoiceProviderKind`, per-kind default models live, and adapters are
// constructed.

import { assertNever, ConfigError } from "../../errors.ts";
import type { VoiceProvider, VoiceProviderKind } from "../voice-provider.ts";
import { geminiLiveProvider } from "./gemini-live.ts";
import { openaiRealtimeProvider } from "./openai-realtime.ts";

/**
 * Parse an operator-supplied provider name. Accepts the short aliases
 * (`openai`, `gemini`) and the canonical kinds, case-insensitively.
 * @throws ConfigError (hint lists valid values) on anything else.
 */
export function parseProviderKind(s: string): VoiceProviderKind {
  switch (s.trim().toLowerCase()) {
    case "openai":
    case "openai-realtime":
      return "openai-realtime";
    case "gemini":
    case "gemini-live":
      return "gemini-live";
    default:
      throw new ConfigError({
        what: `unknown voice provider: ${s}`,
        hint: 'valid values: "openai" | "openai-realtime" | "gemini" | "gemini-live"',
      });
  }
}

/** Default model per provider kind (`VoiceProviderConfig.model` when the
 *  operator doesn't pin one). */
export function defaultModelFor(kind: VoiceProviderKind): string {
  switch (kind) {
    case "openai-realtime":
      return "gpt-realtime";
    case "gemini-live":
      return "gemini-2.5-flash-native-audio-preview-09-2025";
    default:
      return assertNever(kind);
  }
}

/** Construct the adapter for a kind. */
export function createVoiceProvider(kind: VoiceProviderKind): VoiceProvider {
  switch (kind) {
    case "openai-realtime":
      return openaiRealtimeProvider;
    case "gemini-live":
      return geminiLiveProvider;
    default:
      return assertNever(kind);
  }
}
