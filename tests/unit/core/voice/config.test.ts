// Unit tests for src/core/voice/config.ts — ADR-272 env/flag config
// resolution.
//
// Pins:
//   - Precedence per knob: flag > env > default.
//   - Numeric knobs fail CLOSED to defaults on non-numeric /
//     non-positive / non-finite values (resolveGitTimeoutMs mirror) —
//     the bad flag falls through to the env layer, the bad env falls
//     through to the default.
//   - ATMUX_VOICE_TOKEN is REQUIRED and ≥32 chars → ConfigError with
//     the openssl hint; every other knob degrades, never refuses.
//   - Origins comma-split trims + drops empties; readonly accepts only
//     "1"/"true" case-insensitively.

import { describe, expect, test } from "bun:test";
import {
  parseBooleanEnv,
  parseOriginsList,
  resolveVoiceConfig,
  VOICE_DEFAULTS,
  VOICE_TOKEN_MIN_CHARS,
} from "../../../../src/core/voice/config.ts";
import { ConfigError } from "../../../../src/errors.ts";

const TOKEN = "t".repeat(40);

/** Minimal env with a valid token plus overrides. */
function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ATMUX_VOICE_TOKEN: TOKEN, ...extra } as NodeJS.ProcessEnv;
}

describe("token (required, ≥32 chars)", () => {
  test("missing token → ConfigError with openssl hint", () => {
    expect(() => resolveVoiceConfig({} as NodeJS.ProcessEnv)).toThrow(ConfigError);
    try {
      resolveVoiceConfig({} as NodeJS.ProcessEnv);
    } catch (e) {
      expect((e as Error).message).toContain("openssl rand -hex 32");
      expect((e as Error).message).toContain("ATMUX_VOICE_TOKEN");
    }
  });

  test("empty-string env token reads as missing", () => {
    expect(() => resolveVoiceConfig({ ATMUX_VOICE_TOKEN: "" } as NodeJS.ProcessEnv)).toThrow(
      ConfigError,
    );
  });

  test.each([[1], [16], [VOICE_TOKEN_MIN_CHARS - 1]])("%d-char token → ConfigError", (n) => {
    expect(() =>
      resolveVoiceConfig({ ATMUX_VOICE_TOKEN: "x".repeat(n) } as NodeJS.ProcessEnv),
    ).toThrow(ConfigError);
  });

  test("exactly 32 chars is accepted", () => {
    const cfg = resolveVoiceConfig({
      ATMUX_VOICE_TOKEN: "x".repeat(VOICE_TOKEN_MIN_CHARS),
    } as NodeJS.ProcessEnv);
    expect(cfg.token).toBe("x".repeat(VOICE_TOKEN_MIN_CHARS));
  });

  test("flag token wins over env token", () => {
    const flagToken = "f".repeat(48);
    const cfg = resolveVoiceConfig(env(), { token: flagToken });
    expect(cfg.token).toBe(flagToken);
  });

  test("a too-short FLAG token also refuses (flag is not a bypass)", () => {
    expect(() => resolveVoiceConfig(env(), { token: "short" })).toThrow(ConfigError);
  });
});

describe("defaults (no env, no flags)", () => {
  test("every knob lands on its shipped default", () => {
    const cfg = resolveVoiceConfig(env());
    expect(cfg.provider).toBe("openai-realtime");
    expect(cfg.port).toBe(4390);
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.origins).toEqual([]);
    expect(cfg.toolTimeoutMs).toBe(20_000);
    expect(cfg.maxResultChars).toBe(2000);
    expect(cfg.readonly).toBe(false);
    expect(cfg.resumeGraceMs).toBe(90_000);
    expect(cfg.confirmTtlMs).toBe(120_000);
    expect(cfg.model).toBeUndefined();
    expect(cfg.assetsDir).toBeUndefined();
    expect("model" in cfg).toBe(false);
    expect("assetsDir" in cfg).toBe(false);
    expect(VOICE_DEFAULTS.provider).toBe("openai-realtime");
  });
});

describe("env layer", () => {
  test("string + numeric env vars override defaults", () => {
    const cfg = resolveVoiceConfig(
      env({
        ATMUX_VOICE_PROVIDER: "gemini-live",
        ATMUX_VOICE_MODEL: "gpt-realtime-mini",
        ATMUX_VOICE_PORT: "5000",
        ATMUX_VOICE_HOST: "0.0.0.0",
        ATMUX_VOICE_ORIGINS: "https://a.example, https://b.example",
        ATMUX_VOICE_TOOL_TIMEOUT_MS: "5000",
        ATMUX_VOICE_MAX_RESULT_CHARS: "900",
        ATMUX_VOICE_READONLY: "1",
        ATMUX_VOICE_RESUME_GRACE_MS: "1000",
        ATMUX_VOICE_CONFIRM_TTL_MS: "2000",
        ATMUX_VOICE_ASSETS_DIR: "/opt/assets",
      }),
    );
    expect(cfg.provider).toBe("gemini-live");
    expect(cfg.model).toBe("gpt-realtime-mini");
    expect(cfg.port).toBe(5000);
    expect(cfg.host).toBe("0.0.0.0");
    expect(cfg.origins).toEqual(["https://a.example", "https://b.example"]);
    expect(cfg.toolTimeoutMs).toBe(5000);
    expect(cfg.maxResultChars).toBe(900);
    expect(cfg.readonly).toBe(true);
    expect(cfg.resumeGraceMs).toBe(1000);
    expect(cfg.confirmTtlMs).toBe(2000);
    expect(cfg.assetsDir).toBe("/opt/assets");
  });

  test.each([
    ["abc"],
    ["-5"],
    ["0"],
    ["Infinity"],
    ["NaN"],
    [""],
  ])("numeric env %j fails closed to defaults", (bad) => {
    const cfg = resolveVoiceConfig(
      env({
        ATMUX_VOICE_PORT: bad,
        ATMUX_VOICE_TOOL_TIMEOUT_MS: bad,
        ATMUX_VOICE_MAX_RESULT_CHARS: bad,
        ATMUX_VOICE_RESUME_GRACE_MS: bad,
        ATMUX_VOICE_CONFIRM_TTL_MS: bad,
      }),
    );
    expect(cfg.port).toBe(4390);
    expect(cfg.toolTimeoutMs).toBe(20_000);
    expect(cfg.maxResultChars).toBe(2000);
    expect(cfg.resumeGraceMs).toBe(90_000);
    expect(cfg.confirmTtlMs).toBe(120_000);
  });

  test("empty-string provider/host env reads as unset", () => {
    const cfg = resolveVoiceConfig(env({ ATMUX_VOICE_PROVIDER: "", ATMUX_VOICE_HOST: "" }));
    expect(cfg.provider).toBe("openai-realtime");
    expect(cfg.host).toBe("127.0.0.1");
  });
});

describe("flag layer (wins over env)", () => {
  test("every flag beats its env counterpart", () => {
    const cfg = resolveVoiceConfig(
      env({
        ATMUX_VOICE_PROVIDER: "gemini-live",
        ATMUX_VOICE_MODEL: "env-model",
        ATMUX_VOICE_PORT: "5000",
        ATMUX_VOICE_HOST: "10.0.0.1",
        ATMUX_VOICE_ORIGINS: "https://env.example",
        ATMUX_VOICE_TOOL_TIMEOUT_MS: "5000",
        ATMUX_VOICE_MAX_RESULT_CHARS: "900",
        ATMUX_VOICE_READONLY: "1",
        ATMUX_VOICE_RESUME_GRACE_MS: "1000",
        ATMUX_VOICE_CONFIRM_TTL_MS: "2000",
        ATMUX_VOICE_ASSETS_DIR: "/env/assets",
      }),
      {
        provider: "openai-realtime",
        model: "flag-model",
        port: 6001,
        host: "127.0.0.2",
        origins: [" https://flag.example ", ""],
        toolTimeoutMs: 7000,
        maxResultChars: 1500,
        readonly: false,
        resumeGraceMs: 3000,
        confirmTtlMs: 4000,
        assetsDir: "/flag/assets",
      },
    );
    expect(cfg.provider).toBe("openai-realtime");
    expect(cfg.model).toBe("flag-model");
    expect(cfg.port).toBe(6001);
    expect(cfg.host).toBe("127.0.0.2");
    expect(cfg.origins).toEqual(["https://flag.example"]);
    expect(cfg.toolTimeoutMs).toBe(7000);
    expect(cfg.maxResultChars).toBe(1500);
    expect(cfg.readonly).toBe(false);
    expect(cfg.resumeGraceMs).toBe(3000);
    expect(cfg.confirmTtlMs).toBe(4000);
    expect(cfg.assetsDir).toBe("/flag/assets");
  });

  test.each([
    [0],
    [-1],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
  ])("invalid numeric flag %p falls through to the env layer", (bad) => {
    const cfg = resolveVoiceConfig(env({ ATMUX_VOICE_PORT: "5000" }), { port: bad });
    expect(cfg.port).toBe(5000);
  });

  test("invalid numeric flag with no env lands on the default", () => {
    const cfg = resolveVoiceConfig(env(), { toolTimeoutMs: -1 });
    expect(cfg.toolTimeoutMs).toBe(20_000);
  });

  test("empty-string flag strings fall through to env", () => {
    const cfg = resolveVoiceConfig(env({ ATMUX_VOICE_PROVIDER: "gemini-live" }), {
      provider: "",
      model: "",
      assetsDir: "",
    });
    expect(cfg.provider).toBe("gemini-live");
    expect("model" in cfg).toBe(false);
    expect("assetsDir" in cfg).toBe(false);
  });
});

describe("parseOriginsList", () => {
  test.each([
    ["undefined", undefined, []],
    ["empty", "", []],
    ["one", "https://a", ["https://a"]],
    ["spaces + empties dropped", " https://a , ,https://b,, ", ["https://a", "https://b"]],
    ["only commas", ",,,", []],
  ])("%s", (_name, raw, expected) => {
    expect(parseOriginsList(raw)).toEqual(expected);
  });
});

describe("parseBooleanEnv (readonly)", () => {
  test.each([
    ["1", true],
    ["true", true],
    ["TRUE", true],
    ["True", true],
    [" true ", true],
    ["0", false],
    ["false", false],
    ["yes", false],
    ["", false],
  ])("%j → %p", (raw, expected) => {
    expect(parseBooleanEnv(raw)).toBe(expected);
  });

  test("undefined → false", () => {
    expect(parseBooleanEnv(undefined)).toBe(false);
  });

  test("readonly flag=true wins even when env unset", () => {
    const cfg = resolveVoiceConfig(env(), { readonly: true });
    expect(cfg.readonly).toBe(true);
  });

  test("readonly flag=false beats env=1", () => {
    const cfg = resolveVoiceConfig(env({ ATMUX_VOICE_READONLY: "1" }), { readonly: false });
    expect(cfg.readonly).toBe(false);
  });
});
