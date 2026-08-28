// Unit tests for src/core/vox/env-compat.ts — the ADR-274 D2
// `ATMUX_VOICE_*` → `ATMUX_VOX_*` fallback shim.
//
// WHY THESE TESTS ARE SHAPED THIS WAY. A shim test where both names
// produce the same answer proves nothing — it passes just as happily
// when the fallback has been deleted, because the canonical name alone
// already returns the value. So every case below is built to DISAGREE:
// the legacy-only case asserts a value that exists under NO other name,
// and the both-set case gives the two names DIFFERENT values so
// "precedence" is observable rather than inferred.
//
// Pins (ADR-274 D2):
//   - legacy alone is honoured, and warns  ← the load-bearing case; its
//     absence is the 2am `ATMUX_VOX_TOKEN is required` failure.
//   - canonical alone is silent  ← no warning tax on the correct config.
//   - both set: canonical WINS, and the stale one is called out, louder
//     when the values differ.
//   - empty string is not "set" — an exported-but-empty canonical name
//     must not shadow a real legacy value.

import { describe, expect, test } from "bun:test";
import { resolveVoxConfig, VOX_DEFAULTS } from "../../../../src/core/vox/config.ts";
import {
  LEGACY_VOX_ENV_PREFIX,
  readVoxEnv,
  resetVoxEnvWarnings,
  VOX_ENV_PREFIX,
  warnVoxEnvOnce,
} from "../../../../src/core/vox/env-compat.ts";

/** Collects warnings so a test can assert on them instead of stderr. */
function sink(): { warns: string[]; warn: (m: string) => void } {
  const warns: string[] = [];
  return { warns, warn: (m: string) => warns.push(m) };
}

const env = (o: Record<string, string>): NodeJS.ProcessEnv => o as NodeJS.ProcessEnv;

describe("prefixes", () => {
  test("canonical and legacy prefixes are the ADR-274 D1 pair", () => {
    expect(VOX_ENV_PREFIX).toBe("ATMUX_VOX_");
    expect(LEGACY_VOX_ENV_PREFIX).toBe("ATMUX_VOICE_");
  });
});

describe("readVoxEnv — legacy alone (the case the shim exists for)", () => {
  test("returns the LEGACY value when the canonical name is unset", () => {
    const s = sink();
    // "legacy-only" appears under no other name, so a build with the
    // fallback removed returns undefined here and this test fails.
    expect(readVoxEnv(env({ ATMUX_VOICE_TOKEN: "legacy-only" }), "TOKEN", s.warn)).toBe(
      "legacy-only",
    );
  });

  test("warns, naming BOTH the old name and its replacement", () => {
    const s = sink();
    readVoxEnv(env({ ATMUX_VOICE_TOKEN: "legacy-only" }), "TOKEN", s.warn);
    expect(s.warns).toHaveLength(1);
    expect(s.warns[0]).toContain("ATMUX_VOICE_TOKEN");
    expect(s.warns[0]).toContain("ATMUX_VOX_TOKEN");
    expect(s.warns[0]).toContain("deprecated");
  });

  test("the warning carries the ADR and the sunset release", () => {
    const s = sink();
    readVoxEnv(env({ ATMUX_VOICE_PORT: "5001" }), "PORT", s.warn);
    expect(s.warns[0]).toContain("ADR-274");
    expect(s.warns[0]).toContain("v0.9.1");
  });
});

describe("readVoxEnv — canonical alone", () => {
  test("returns the canonical value", () => {
    const s = sink();
    expect(readVoxEnv(env({ ATMUX_VOX_TOKEN: "fresh" }), "TOKEN", s.warn)).toBe("fresh");
  });

  test("says NOTHING — a correct config pays no warning tax", () => {
    const s = sink();
    readVoxEnv(env({ ATMUX_VOX_TOKEN: "fresh" }), "TOKEN", s.warn);
    expect(s.warns).toEqual([]);
  });
});

describe("readVoxEnv — BOTH set (precedence is observable, not assumed)", () => {
  test("different values: the canonical one wins", () => {
    const s = sink();
    const got = readVoxEnv(
      env({ ATMUX_VOX_TOKEN: "fresh", ATMUX_VOICE_TOKEN: "stale" }),
      "TOKEN",
      s.warn,
    );
    expect(got).toBe("fresh");
    expect(got).not.toBe("stale");
  });

  test("different values: the warning says DIFFERENT and names the ignored one", () => {
    const s = sink();
    readVoxEnv(env({ ATMUX_VOX_TOKEN: "fresh", ATMUX_VOICE_TOKEN: "stale" }), "TOKEN", s.warn);
    expect(s.warns).toHaveLength(1);
    expect(s.warns[0]).toContain("DIFFERENT");
    expect(s.warns[0]).toContain("IGNORING");
    expect(s.warns[0]).toContain("ATMUX_VOICE_TOKEN");
  });

  test("same value: still warns to unset the legacy name, but not as DIFFERENT", () => {
    const s = sink();
    const got = readVoxEnv(
      env({ ATMUX_VOX_TOKEN: "same", ATMUX_VOICE_TOKEN: "same" }),
      "TOKEN",
      s.warn,
    );
    expect(got).toBe("same");
    expect(s.warns).toHaveLength(1);
    expect(s.warns[0]).toContain("Unset the deprecated ATMUX_VOICE_TOKEN");
    expect(s.warns[0]).not.toContain("DIFFERENT");
  });
});

describe("readVoxEnv — a warning never leaks the VALUE", () => {
  // The token and the provider keys come through this function, and
  // `--supervise` runs the server in a tmux pane whose scrollback is
  // captured. A warning is a log line; it may name variables, never values.
  const SECRET = "s3cret-token-value-do-not-print-me-anywhere";

  test("legacy-only: the deprecation notice names the var, not the token", () => {
    const s = sink();
    readVoxEnv(env({ ATMUX_VOICE_TOKEN: SECRET }), "TOKEN", s.warn);
    expect(s.warns).toHaveLength(1);
    expect(s.warns[0]).toContain("ATMUX_VOICE_TOKEN");
    expect(s.warns[0]).not.toContain(SECRET);
  });

  test("both-set-and-DIFFERENT: neither value appears — the tempting case", () => {
    const s = sink();
    const other = "other-secret-value";
    readVoxEnv(env({ ATMUX_VOX_TOKEN: other, ATMUX_VOICE_TOKEN: SECRET }), "TOKEN", s.warn);
    expect(s.warns[0]).toContain("DIFFERENT");
    expect(s.warns[0]).not.toContain(SECRET);
    expect(s.warns[0]).not.toContain(other);
  });
});

describe("readVoxEnv — unset and empty", () => {
  test("neither set → undefined, and silent", () => {
    const s = sink();
    expect(readVoxEnv(env({}), "TOKEN", s.warn)).toBeUndefined();
    expect(s.warns).toEqual([]);
  });

  test("an EMPTY canonical value does not shadow a real legacy value", () => {
    const s = sink();
    // `export ATMUX_VOX_TOKEN=` in a shell is not a configured token; if
    // empty counted as "set" the operator would get the 2am failure the
    // shim exists to prevent, with both variables apparently present.
    expect(
      readVoxEnv(env({ ATMUX_VOX_TOKEN: "", ATMUX_VOICE_TOKEN: "real" }), "TOKEN", s.warn),
    ).toBe("real");
    expect(s.warns[0]).toContain("deprecated");
  });

  test("an EMPTY legacy value is not treated as set", () => {
    const s = sink();
    expect(readVoxEnv(env({ ATMUX_VOICE_TOKEN: "" }), "TOKEN", s.warn)).toBeUndefined();
    expect(s.warns).toEqual([]);
  });

  test("empty legacy alongside a real canonical value warns about nothing", () => {
    const s = sink();
    expect(
      readVoxEnv(env({ ATMUX_VOX_HOST: "0.0.0.0", ATMUX_VOICE_HOST: "" }), "HOST", s.warn),
    ).toBe("0.0.0.0");
    expect(s.warns).toEqual([]);
  });
});

describe("warnVoxEnvOnce — dedupe", () => {
  test("the same message reaches stderr once per process", () => {
    resetVoxEnvWarnings();
    const written: string[] = [];
    const real = process.stderr.write.bind(process.stderr);
    // biome-ignore lint/suspicious/noExplicitAny: narrow stderr stub for one assertion
    (process.stderr as any).write = (chunk: string): boolean => {
      written.push(String(chunk));
      return true;
    };
    try {
      warnVoxEnvOnce("vox: duplicate notice");
      warnVoxEnvOnce("vox: duplicate notice");
      warnVoxEnvOnce("vox: a different notice");
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore the real stderr
      (process.stderr as any).write = real;
      resetVoxEnvWarnings();
    }
    expect(written).toEqual(["vox: duplicate notice\n", "vox: a different notice\n"]);
  });
});

// The shim is only worth having if it reaches the config resolver, which
// is where the missing-token refusal lives.
describe("resolveVoxConfig — the fallback end to end (ADR-274 D2)", () => {
  const LEGACY_TOKEN = "L".repeat(40);
  const FRESH_TOKEN = "F".repeat(40);

  test("ATMUX_VOICE_TOKEN alone BOOTS instead of refusing", () => {
    const s = sink();
    const cfg = resolveVoxConfig(env({ ATMUX_VOICE_TOKEN: LEGACY_TOKEN }), undefined, s.warn);
    expect(cfg.token).toBe(LEGACY_TOKEN);
  });

  test("...and says why, so the operator can fix the dotfiles", () => {
    const s = sink();
    resolveVoxConfig(env({ ATMUX_VOICE_TOKEN: LEGACY_TOKEN }), undefined, s.warn);
    expect(s.warns.some((w) => w.includes("ATMUX_VOICE_TOKEN"))).toBe(true);
  });

  test("both tokens set: the config carries the CANONICAL one", () => {
    const s = sink();
    const cfg = resolveVoxConfig(
      env({ ATMUX_VOX_TOKEN: FRESH_TOKEN, ATMUX_VOICE_TOKEN: LEGACY_TOKEN }),
      undefined,
      s.warn,
    );
    expect(cfg.token).toBe(FRESH_TOKEN);
    expect(cfg.token).not.toBe(LEGACY_TOKEN);
    expect(s.warns.some((w) => w.includes("DIFFERENT"))).toBe(true);
  });

  test("a legacy NON-token knob still resolves — the fallback is not token-only", () => {
    const s = sink();
    const cfg = resolveVoxConfig(
      env({
        ATMUX_VOICE_TOKEN: LEGACY_TOKEN,
        ATMUX_VOICE_PORT: "5099",
        ATMUX_VOICE_READONLY: "1",
        ATMUX_VOICE_ORIGINS: "https://a.example, https://b.example",
      }),
      undefined,
      s.warn,
    );
    expect(cfg.port).toBe(5099);
    expect(cfg.port).not.toBe(VOX_DEFAULTS.port);
    expect(cfg.readonly).toBe(true);
    expect(cfg.origins).toEqual(["https://a.example", "https://b.example"]);
  });

  test("canonical knobs beat legacy knobs one by one", () => {
    const s = sink();
    const cfg = resolveVoxConfig(
      env({
        ATMUX_VOX_TOKEN: FRESH_TOKEN,
        ATMUX_VOX_PORT: "4400",
        ATMUX_VOICE_PORT: "9999",
        ATMUX_VOX_HOST: "0.0.0.0",
        ATMUX_VOICE_HOST: "10.0.0.1",
      }),
      undefined,
      s.warn,
    );
    expect(cfg.port).toBe(4400);
    expect(cfg.host).toBe("0.0.0.0");
  });

  test("an all-canonical config resolves with ZERO warnings", () => {
    const s = sink();
    const cfg = resolveVoxConfig(
      env({ ATMUX_VOX_TOKEN: FRESH_TOKEN, ATMUX_VOX_PORT: "4400" }),
      undefined,
      s.warn,
    );
    expect(cfg.port).toBe(4400);
    expect(s.warns).toEqual([]);
  });
});
