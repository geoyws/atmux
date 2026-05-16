// Unit tests for src/core/tmux-paths.ts — central resolver for atmux-
// owned tmux infrastructure paths.
//
// Per ADR-162 §Decision-anchor #1: cockpit binds the dedicated
// `atmux-cockpit` named socket (operator-discoverable via `tmux -L
// atmux-cockpit attach`). `ATMUX_COCKPIT_SOCKET` env var is the legacy
// escape hatch for operators staying on the default socket for one
// more cycle.

import { describe, expect, test } from "bun:test";
import {
  COCKPIT_SOCKET_DEFAULT,
  getCockpitSocketName,
} from "../../../src/core/tmux-paths.ts";

describe("getCockpitSocketName", () => {
  test("returns canonical 'atmux-cockpit' when env unset", () => {
    expect(getCockpitSocketName({})).toBe("atmux-cockpit");
    expect(getCockpitSocketName({})).toBe(COCKPIT_SOCKET_DEFAULT);
  });

  test("returns canonical default when env key explicitly undefined", () => {
    expect(getCockpitSocketName({ ATMUX_COCKPIT_SOCKET: undefined })).toBe("atmux-cockpit");
  });

  test("returns canonical default on empty-string env (treated as unset)", () => {
    expect(getCockpitSocketName({ ATMUX_COCKPIT_SOCKET: "" })).toBe("atmux-cockpit");
  });

  test("env override honoured verbatim — 'default' opts back to legacy socket", () => {
    expect(getCockpitSocketName({ ATMUX_COCKPIT_SOCKET: "default" })).toBe("default");
  });

  test("env override honoured verbatim — arbitrary custom name", () => {
    expect(getCockpitSocketName({ ATMUX_COCKPIT_SOCKET: "my-cockpit" })).toBe("my-cockpit");
  });

  test("default parameter falls through to process.env (smoke — value depends on env)", () => {
    // Calling with no arg should not throw + should return a non-empty
    // string. Exact value depends on the test process's env; under
    // bun-test we don't set ATMUX_COCKPIT_SOCKET so the default wins.
    const r = getCockpitSocketName();
    expect(typeof r).toBe("string");
    expect(r.length).toBeGreaterThan(0);
  });
});

describe("COCKPIT_SOCKET_DEFAULT constant", () => {
  test("equals 'atmux-cockpit' per ADR-162 §Decision-anchor #1", () => {
    expect(COCKPIT_SOCKET_DEFAULT).toBe("atmux-cockpit");
  });
});
