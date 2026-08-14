// Unit tests for src/abstractions/voice/factory.ts (ADR-272).

import { describe, expect, test } from "bun:test";
import {
  createVoiceProvider,
  defaultModelFor,
  parseProviderKind,
} from "../../../../src/abstractions/voice/factory.ts";
import { openaiRealtimeProvider } from "../../../../src/abstractions/voice/openai-realtime.ts";
import { ConfigError } from "../../../../src/errors.ts";

describe("parseProviderKind", () => {
  test.each<[string, string]>([
    ["openai", "openai-realtime"],
    ["openai-realtime", "openai-realtime"],
    ["gemini", "gemini-live"],
    ["gemini-live", "gemini-live"],
    ["OpenAI", "openai-realtime"],
    ["OPENAI-REALTIME", "openai-realtime"],
    ["  Gemini-Live  ", "gemini-live"],
  ])("%s → %s", (input, expected) => {
    expect(parseProviderKind(input)).toBe(expected as never);
  });

  test("unknown value throws ConfigError with a hint listing valid values", () => {
    let caught: ConfigError | null = null;
    try {
      parseProviderKind("siri");
    } catch (e) {
      if (e instanceof ConfigError) caught = e;
    }
    expect(caught?.tag).toBe("config");
    expect(caught?.message).toContain("unknown voice provider: siri");
    expect(caught?.message).toContain('"openai" | "openai-realtime" | "gemini" | "gemini-live"');
  });
});

describe("defaultModelFor", () => {
  test("openai-realtime → gpt-realtime", () => {
    expect(defaultModelFor("openai-realtime")).toBe("gpt-realtime");
  });

  test("gemini-live → gemini-2.5-flash-native-audio-preview-09-2025", () => {
    expect(defaultModelFor("gemini-live")).toBe("gemini-2.5-flash-native-audio-preview-09-2025");
  });

  test("exhaustiveness guard throws on an impossible kind", () => {
    expect(() => defaultModelFor("bogus" as never)).toThrow("unreachable: bogus");
  });
});

describe("createVoiceProvider", () => {
  test("openai-realtime returns the adapter singleton", () => {
    const provider = createVoiceProvider("openai-realtime");
    expect(provider).toBe(openaiRealtimeProvider);
    expect(provider.kind).toBe("openai-realtime");
  });

  test("gemini-live throws ConfigError until the P6 adapter lands", () => {
    let caught: ConfigError | null = null;
    try {
      createVoiceProvider("gemini-live");
    } catch (e) {
      if (e instanceof ConfigError) caught = e;
    }
    expect(caught?.message).toContain("gemini-live adapter lands in P6");
    expect(caught?.message).toContain("set ATMUX_VOICE_PROVIDER=openai-realtime");
  });

  test("exhaustiveness guard throws on an impossible kind", () => {
    expect(() => createVoiceProvider("bogus" as never)).toThrow("unreachable: bogus");
  });
});
