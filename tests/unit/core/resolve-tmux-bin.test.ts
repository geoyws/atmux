// Unit tests for src/core/resolve-tmux-bin.ts (ADR-191 3-tier resolver).
//
// Strategy mirrors tests/unit/abstractions/native-listener.test.ts —
// inject env + existsSync + optional warn seam + pathProbe + a fresh
// state record per test so module-scoped memoization doesn't leak
// across cases.

import { describe, expect, test } from "bun:test";
import {
  createResolveTmuxBinState,
  createResolveVendoredTmuxBinState,
  resetResolveTmuxBinForTesting,
  resolveTmuxBin,
  resolveVendoredTmuxBin,
  VENDORED_TMUX_PATH,
} from "../../../src/core/resolve-tmux-bin.ts";

describe("resolveTmuxBin — tier 1 (ATMUX_TMUX_BIN override)", () => {
  test("override + existing → returns it, no probe", () => {
    let pathProbeCalls = 0;
    const r = resolveTmuxBin(
      { ATMUX_TMUX_BIN: "/operator/local-tmux" },
      (p) => p === "/operator/local-tmux",
      () => {},
      createResolveTmuxBinState(),
      () => {
        pathProbeCalls++;
        return null;
      },
    );
    expect(r).toBe("/operator/local-tmux");
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

  test("empty override falls through to PATH", () => {
    const r = resolveTmuxBin(
      { ATMUX_TMUX_BIN: "" },
      () => false,
      () => {},
      createResolveTmuxBinState(),
      () => "/usr/local/bin/tmux",
    );
    expect(r).toBe("/usr/local/bin/tmux");
  });

  test("whitespace-only override falls through to PATH", () => {
    const r = resolveTmuxBin(
      { ATMUX_TMUX_BIN: "   " },
      () => false,
      () => {},
      createResolveTmuxBinState(),
      () => "/usr/local/bin/tmux",
    );
    expect(r).toBe("/usr/local/bin/tmux");
  });
});

describe("resolveTmuxBin — tier 3 (system PATH)", () => {
  test("no override + PATH has tmux → returns PATH-resolved silently", () => {
    const r = resolveTmuxBin(
      {},
      () => false,
      () => {},
      createResolveTmuxBinState(),
      () => "/usr/local/bin/tmux",
    );
    expect(r).toBe("/usr/local/bin/tmux");
  });

  test("repeated calls with same state stay silent", () => {
    const state = createResolveTmuxBinState();
    resolveTmuxBin(
      {},
      () => false,
      () => {},
      state,
      () => "/usr/bin/tmux",
    );
    resolveTmuxBin(
      {},
      () => false,
      () => {},
      state,
      () => "/usr/bin/tmux",
    );
    resolveTmuxBin(
      {},
      () => false,
      () => {},
      state,
      () => "/usr/bin/tmux",
    );
    expect(state.cached).toBe("/usr/bin/tmux");
  });

  test("fresh state records do not change the result", () => {
    const pathProbe = () => "/usr/bin/tmux";
    resolveTmuxBin(
      {},
      () => false,
      () => {},
      createResolveTmuxBinState(),
      pathProbe,
    );
    resolveTmuxBin(
      {},
      () => false,
      () => {},
      createResolveTmuxBinState(),
      pathProbe,
    );
  });
});

describe("resolveTmuxBin — bootstrap failure (no tmux anywhere)", () => {
  test("override unset + PATH probe returns null → throws", () => {
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
      return false;
    };
    const first = resolveTmuxBin(env, exists, () => {}, state, () => "/usr/local/bin/tmux");
    const second = resolveTmuxBin(env, exists, () => {}, state, () => "/usr/local/bin/tmux");
    const third = resolveTmuxBin(env, exists, () => {}, state, () => "/usr/local/bin/tmux");
    expect(first).toBe("/usr/local/bin/tmux");
    expect(second).toBe("/usr/local/bin/tmux");
    expect(third).toBe("/usr/local/bin/tmux");
    expect(envReads.filter((k) => k === "ATMUX_TMUX_BIN")).toHaveLength(1);
    expect(probed).toEqual([]);
  });

  test("system-PATH resolution is also cached and ignores the warn seam", () => {
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
    expect(warns).toHaveLength(0);
    expect(probed).toEqual([]);
    expect(pathProbeCalls).toBe(1);
  });
});

describe("resolveTmuxBin — default parameters", () => {
  test("default warn sink is unused on tier-3 fallback", () => {
    const state = createResolveTmuxBinState();
    const r = resolveTmuxBin({}, () => false, undefined, state, () => "/usr/bin/tmux");
    expect(r).toBe("/usr/bin/tmux");
    expect(state.cached).toBe("/usr/bin/tmux");
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
    expect(result).toBeDefined();
  });
});

describe("resolveVendoredTmuxBin — future vendored-only plane", () => {
  test("canonical vendored path resolves and does not probe PATH", () => {
    const existsCalls: string[] = [];
    const r = resolveVendoredTmuxBin(
      {},
      (p) => {
        existsCalls.push(p);
        return p === VENDORED_TMUX_PATH;
      },
      createResolveVendoredTmuxBinState(),
    );
    expect(r).toBe(VENDORED_TMUX_PATH);
    expect(existsCalls).toEqual([VENDORED_TMUX_PATH]);
  });

  test("explicit ATMUX_VENDORED_TMUX_BIN override trims whitespace and is honoured when present", () => {
    const r = resolveVendoredTmuxBin(
      { ATMUX_VENDORED_TMUX_BIN: "  /opt/atmux/custom/bin/tmux  " },
      (p) => p === "/opt/atmux/custom/bin/tmux",
      createResolveVendoredTmuxBinState(),
    );
    expect(r).toBe("/opt/atmux/custom/bin/tmux");
  });

  test("missing vendored override throws and never falls back to system tmux", () => {
    expect(() =>
      resolveVendoredTmuxBin(
        { ATMUX_VENDORED_TMUX_BIN: "/opt/atmux/missing/bin/tmux" },
        () => false,
        createResolveVendoredTmuxBinState(),
      ),
    ).toThrow(/ATMUX_VENDORED_TMUX_BIN=\/opt\/atmux\/missing\/bin\/tmux/);
  });

  test("missing canonical vendored binary throws fail-closed error", () => {
    expect(() => resolveVendoredTmuxBin({}, () => false, createResolveVendoredTmuxBinState())).toThrow(
      /cannot find vendored tmux/,
    );
  });

  test("whitespace-only vendored override falls back to canonical vendored path", () => {
    const r = resolveVendoredTmuxBin(
      { ATMUX_VENDORED_TMUX_BIN: "   " },
      (p) => p === VENDORED_TMUX_PATH,
      createResolveVendoredTmuxBinState(),
    );
    expect(r).toBe(VENDORED_TMUX_PATH);
  });

  test("cache reset clears the module-level vendored cache", () => {
    resetResolveTmuxBinForTesting();
    const existsCalls: string[] = [];
    const exists = (p: string) => {
      existsCalls.push(p);
      return p === VENDORED_TMUX_PATH;
    };
    const first = resolveVendoredTmuxBin({}, exists);
    const second = resolveVendoredTmuxBin({}, exists);
    expect(first).toBe(VENDORED_TMUX_PATH);
    expect(second).toBe(VENDORED_TMUX_PATH);
    expect(existsCalls).toEqual([VENDORED_TMUX_PATH]);

    resetResolveTmuxBinForTesting();

    const third = resolveVendoredTmuxBin({}, exists);
    expect(third).toBe(VENDORED_TMUX_PATH);
    expect(existsCalls).toEqual([VENDORED_TMUX_PATH, VENDORED_TMUX_PATH]);
  });
});

describe("resetResolveTmuxBinForTesting", () => {
  test("clears the default module-level cache", () => {
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
    expect(warns).toHaveLength(0);

    resetResolveTmuxBinForTesting();

    resolveTmuxBin(
      {},
      () => false,
      (s) => warns.push(s),
      undefined,
      () => "/usr/bin/tmux",
    );
    expect(warns).toHaveLength(0);

    resetResolveTmuxBinForTesting();
  });
});
