// Unit tests for src/core/resolve-tmux-bin.ts (ADR-191 3-tier resolver).
//
// Strategy mirrors tests/unit/abstractions/native-listener.test.ts —
// inject env + existsSync + warn sink + pathProbe + a fresh state
// record per test so module-scoped memoization doesn't leak across
// cases.

import { describe, expect, test } from "bun:test";
import {
  createResolveTmuxBinState,
  resetResolveTmuxBinForTesting,
  resolveTmuxBin,
  VENDORED_TMUX_PATH,
} from "../../../src/core/resolve-tmux-bin.ts";

describe("resolveTmuxBin — tier 1 (ATMUX_TMUX_BIN override)", () => {
  test("override + existing → returns it, no probe + no warn", () => {
    const warns: string[] = [];
    let pathProbeCalls = 0;
    const r = resolveTmuxBin(
      { ATMUX_TMUX_BIN: "/operator/local-tmux" },
      (p) => p === "/operator/local-tmux",
      (s) => warns.push(s),
      createResolveTmuxBinState(),
      () => {
        pathProbeCalls++;
        return null;
      },
    );
    expect(r).toBe("/operator/local-tmux");
    expect(warns).toEqual([]);
    expect(pathProbeCalls).toBe(0);
  });

  test("override with surrounding whitespace is trimmed before existsSync", () => {
    const probed: string[] = [];
    const r = resolveTmuxBin(
      { ATMUX_TMUX_BIN: "  /padded/path  " },
      (p) => {
        probed.push(p);
        return p === "/padded/path";
      },
      () => {},
      createResolveTmuxBinState(),
    );
    expect(r).toBe("/padded/path");
    expect(probed).toEqual(["/padded/path"]);
  });

  test("override set but missing → throws operator-actionable error", () => {
    expect(() =>
      resolveTmuxBin(
        { ATMUX_TMUX_BIN: "/operator/missing-tmux" },
        () => false,
        () => {},
        createResolveTmuxBinState(),
        () => "/usr/local/bin/tmux",
      ),
    ).toThrow(/ATMUX_TMUX_BIN=\/operator\/missing-tmux but no such file/);
  });

  test("empty override falls through to vendored tier", () => {
    const r = resolveTmuxBin(
      { ATMUX_TMUX_BIN: "" },
      (p) => p === VENDORED_TMUX_PATH,
      () => {},
      createResolveTmuxBinState(),
    );
    expect(r).toBe(VENDORED_TMUX_PATH);
  });

  test("whitespace-only override falls through to vendored tier", () => {
    const r = resolveTmuxBin(
      { ATMUX_TMUX_BIN: "   " },
      (p) => p === VENDORED_TMUX_PATH,
      () => {},
      createResolveTmuxBinState(),
    );
    expect(r).toBe(VENDORED_TMUX_PATH);
  });
});

describe("resolveTmuxBin — tier 2 (vendored binary at /opt/atmux/current)", () => {
  test("no override + vendored present → returns vendored, no warn, no PATH probe", () => {
    const warns: string[] = [];
    let pathProbeCalls = 0;
    const r = resolveTmuxBin(
      {},
      (p) => p === VENDORED_TMUX_PATH,
      (s) => warns.push(s),
      createResolveTmuxBinState(),
      () => {
        pathProbeCalls++;
        return null;
      },
    );
    expect(r).toBe(VENDORED_TMUX_PATH);
    expect(warns).toEqual([]);
    expect(pathProbeCalls).toBe(0);
  });
});

describe("resolveTmuxBin — tier 3 (system PATH with warn-once)", () => {
  test("vendored absent + PATH has tmux → returns PATH-resolved + emits one warning", () => {
    const warns: string[] = [];
    const r = resolveTmuxBin(
      {},
      () => false,
      (s) => warns.push(s),
      createResolveTmuxBinState(),
      () => "/usr/local/bin/tmux",
    );
    expect(r).toBe("/usr/local/bin/tmux");
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain(VENDORED_TMUX_PATH);
    expect(warns[0]).toContain("/usr/local/bin/tmux");
    expect(warns[0]).toContain("ADR-191");
    expect(warns[0]).toContain("ATMUX_TMUX_BIN");
  });

  test("warn fires ONCE — repeated calls with same state are silent", () => {
    const warns: string[] = [];
    const state = createResolveTmuxBinState();
    resolveTmuxBin(
      {},
      () => false,
      (s) => warns.push(s),
      state,
      () => "/usr/bin/tmux",
    );
    resolveTmuxBin(
      {},
      () => false,
      (s) => warns.push(s),
      state,
      () => "/usr/bin/tmux",
    );
    resolveTmuxBin(
      {},
      () => false,
      (s) => warns.push(s),
      state,
      () => "/usr/bin/tmux",
    );
    expect(warns).toHaveLength(1);
  });

  test("warn fires AGAIN when state record is fresh — no global side-channel", () => {
    const warns: string[] = [];
    const pathProbe = () => "/usr/bin/tmux";
    resolveTmuxBin(
      {},
      () => false,
      (s) => warns.push(s),
      createResolveTmuxBinState(),
      pathProbe,
    );
    resolveTmuxBin(
      {},
      () => false,
      (s) => warns.push(s),
      createResolveTmuxBinState(),
      pathProbe,
    );
    expect(warns).toHaveLength(2);
  });
});

describe("resolveTmuxBin — bootstrap failure (no tmux anywhere)", () => {
  test("override unset + vendored absent + PATH probe returns null → throws", () => {
    expect(() =>
      resolveTmuxBin(
        {},
        () => false,
        () => {},
        createResolveTmuxBinState(),
        () => null,
      ),
    ).toThrow(/cannot find tmux/);
  });

  test("bootstrap-failure message names every tier so operator can act", () => {
    let captured = "";
    try {
      resolveTmuxBin(
        {},
        () => false,
        () => {},
        createResolveTmuxBinState(),
        () => null,
      );
    } catch (e) {
      captured = (e as Error).message;
    }
    expect(captured).toContain("ATMUX_TMUX_BIN");
    expect(captured).toContain(VENDORED_TMUX_PATH);
    expect(captured).toContain("PATH");
    expect(captured).toContain("build:install");
  });
});

describe("resolveTmuxBin — memoization", () => {
  test("first resolution cached — subsequent calls skip env + filesystem probes", () => {
    const envReads: string[] = [];
    const probed: string[] = [];
    const state = createResolveTmuxBinState();
    const env = new Proxy({} as NodeJS.ProcessEnv, {
      get(_t, key: string) {
        envReads.push(key);
        return undefined;
      },
    });
    const exists = (p: string) => {
      probed.push(p);
      return p === VENDORED_TMUX_PATH;
    };
    const first = resolveTmuxBin(env, exists, () => {}, state);
    const second = resolveTmuxBin(env, exists, () => {}, state);
    const third = resolveTmuxBin(env, exists, () => {}, state);
    expect(first).toBe(VENDORED_TMUX_PATH);
    expect(second).toBe(VENDORED_TMUX_PATH);
    expect(third).toBe(VENDORED_TMUX_PATH);
    expect(envReads.filter((k) => k === "ATMUX_TMUX_BIN")).toHaveLength(1);
    expect(probed).toEqual([VENDORED_TMUX_PATH]);
  });

  test("system-PATH resolution is also cached + warn-once survives cache hits", () => {
    const warns: string[] = [];
    const probed: string[] = [];
    let pathProbeCalls = 0;
    const state = createResolveTmuxBinState();
    const exists = (p: string) => {
      probed.push(p);
      return false;
    };
    const pathProbe = () => {
      pathProbeCalls++;
      return "/usr/local/bin/tmux";
    };
    resolveTmuxBin({}, exists, (s) => warns.push(s), state, pathProbe);
    resolveTmuxBin({}, exists, (s) => warns.push(s), state, pathProbe);
    expect(state.cached).toBe("/usr/local/bin/tmux");
    expect(warns).toHaveLength(1);
    expect(probed).toEqual([VENDORED_TMUX_PATH]);
    expect(pathProbeCalls).toBe(1);
  });
});

describe("resolveTmuxBin — default parameters", () => {
  test("default warn sink (process.stderr.write) is invoked on tier-3 fallback", () => {
    const captured: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = ((s: string | Uint8Array) => {
      captured.push(typeof s === "string" ? s : Buffer.from(s).toString());
      return true;
    }) as typeof process.stderr.write;
    try {
      const state = createResolveTmuxBinState();
      const r = resolveTmuxBin(
        {},
        () => false,
        undefined,
        state,
        () => "/usr/bin/tmux",
      );
      expect(r).toBe("/usr/bin/tmux");
      expect(captured.some((s) => s.includes("vendored tmux not found"))).toBe(true);
    } finally {
      (process.stderr as { write: typeof originalWrite }).write = originalWrite;
    }
  });

  test("default pathProbe runs `which tmux` on the real PATH", () => {
    // On any environment with tmux installed (cage / dev box / CI),
    // the default pathProbe returns the resolved absolute path.
    // Skip if no tmux on PATH (we don't control CI shape).
    const state = createResolveTmuxBinState();
    let result: string;
    try {
      result = resolveTmuxBin(
        {},
        () => false,
        () => {},
        state,
      );
    } catch {
      // No tmux on PATH at all — defaultPathProbe returned null,
      // resolver threw bootstrap-failure. Acceptable result; assertion
      // skipped.
      return;
    }
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toBe(VENDORED_TMUX_PATH);
  });
});

describe("resetResolveTmuxBinForTesting", () => {
  test("clears the default module-level cache + warn-once flag", () => {
    resetResolveTmuxBinForTesting();
    const warns: string[] = [];
    resolveTmuxBin(
      {},
      () => false,
      (s) => warns.push(s),
      undefined,
      () => "/usr/bin/tmux",
    );
    resolveTmuxBin(
      {},
      () => false,
      (s) => warns.push(s),
      undefined,
      () => "/usr/bin/tmux",
    );
    expect(warns).toHaveLength(1);

    resetResolveTmuxBinForTesting();

    resolveTmuxBin(
      {},
      () => false,
      (s) => warns.push(s),
      undefined,
      () => "/usr/bin/tmux",
    );
    expect(warns).toHaveLength(2);

    resetResolveTmuxBinForTesting();
  });
});
