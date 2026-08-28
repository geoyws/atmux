// Unit tests for src/core/session-migrate.ts — e-419553c6 bare-name
// in-place migration — plus the live `=`-anchoring probe the whole
// bare-name change rests on.
//
// Two layers, deliberately:
//   1. Stub-based branch coverage of `migrateLegacySessionName` (every
//      outcome, including the rename-failure soft path).
//   2. A REAL tmux server on a private socket proving (a) the tmux
//      prefix-match hazard is real (`has-session -t journal` matches a
//      session named `journalism`), (b) `exactSessionTarget` closes it,
//      and (c) the migration renames a live legacy session in place.
// Layer 2 follows the tests/unit/abstractions/tmux.test.ts isolation
// pattern: `-S <socketPath>` baked into every argv + `-f /dev/null`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTmux, exactSessionTarget, type TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import {
  type LegacySessionMigration,
  migrateLegacySessionName,
} from "../../../src/core/session-migrate.ts";

// ---------- Layer 1: stub-based branch coverage ----------

interface StubCalls {
  hasSession: string[];
  renames: Array<{ from: string; to: string }>;
}

function stubTmux(opts: {
  present: ReadonlySet<string>;
  renameThrows?: boolean;
  calls: StubCalls;
}): TmuxNamespace {
  return {
    session: {
      hasSession: async (name: string) => {
        opts.calls.hasSession.push(name);
        // The stub honours the `=` anchor the way tmux does for an
        // exact name: strip it before the lookup.
        const bare = name.startsWith("=") ? name.slice(1) : name;
        return opts.present.has(bare);
      },
      renameSession: async (from: string, to: string) => {
        if (opts.renameThrows === true) throw new Error("rename boom");
        opts.calls.renames.push({ from, to });
      },
    },
  } as unknown as TmuxNamespace;
}

describe("migrateLegacySessionName — branch coverage (stub tmux)", () => {
  let calls: StubCalls;
  beforeEach(() => {
    calls = { hasSession: [], renames: [] };
  });

  test("not-applicable when the resolved session is not the bare default (anchor pin)", async () => {
    const tmux = stubTmux({ present: new Set(["atmux-unum"]), calls });
    const out = await migrateLegacySessionName({
      tmux,
      teamName: "unum",
      resolvedSession: "atmux_unum", // anchored — operator intent, untouched
    });
    expect(out).toBe("not-applicable" satisfies LegacySessionMigration);
    expect(calls.hasSession).toEqual([]); // never even probes
    expect(calls.renames).toEqual([]);
  });

  test("noop when no legacy session exists", async () => {
    const tmux = stubTmux({ present: new Set(["sopx"]), calls });
    const out = await migrateLegacySessionName({
      tmux,
      teamName: "sopx",
      resolvedSession: "sopx",
    });
    expect(out).toBe("noop");
    expect(calls.hasSession).toEqual(["=atmux-sopx"]); // `=`-anchored probe
    expect(calls.renames).toEqual([]);
  });

  test("renames a live legacy session in place, `=`-anchored on the source", async () => {
    const logs: string[] = [];
    const tmux = stubTmux({ present: new Set(["atmux-sopx"]), calls });
    const out = await migrateLegacySessionName({
      tmux,
      teamName: "sopx",
      resolvedSession: "sopx",
      log: (m) => logs.push(m),
    });
    expect(out).toBe("renamed");
    expect(calls.renames).toEqual([{ from: "=atmux-sopx", to: "sopx" }]);
    expect(logs.join("\n")).toContain("atmux-sopx");
  });

  test("idempotent: a second run after the rename is a noop", async () => {
    const present = new Set(["atmux-x"]);
    const tmux = stubTmux({ present, calls });
    expect(
      await migrateLegacySessionName({ tmux, teamName: "x", resolvedSession: "x" }),
    ).toBe("renamed");
    // Simulate the rename having landed.
    present.delete("atmux-x");
    present.add("x");
    expect(
      await migrateLegacySessionName({ tmux, teamName: "x", resolvedSession: "x" }),
    ).toBe("noop");
    expect(calls.renames).toHaveLength(1);
  });

  test("ambiguous when BOTH legacy and bare exist — warns, renames nothing", async () => {
    const warns: string[] = [];
    const tmux = stubTmux({ present: new Set(["atmux-x", "x"]), calls });
    const out = await migrateLegacySessionName({
      tmux,
      teamName: "x",
      resolvedSession: "x",
      warn: (m) => warns.push(m),
    });
    expect(out).toBe("ambiguous");
    expect(calls.renames).toEqual([]);
    expect(warns.join("\n")).toContain("atmux-x");
    expect(warns.join("\n")).toContain("ambiguous");
  });

  test("rename failure degrades to noop with a warning, never throws", async () => {
    const warns: string[] = [];
    const tmux = stubTmux({ present: new Set(["atmux-x"]), renameThrows: true, calls });
    const out = await migrateLegacySessionName({
      tmux,
      teamName: "x",
      resolvedSession: "x",
      warn: (m) => warns.push(m),
    });
    expect(out).toBe("noop");
    expect(warns.join("\n")).toContain("rename boom");
  });

  test("probe failure (no server on the socket) collapses to noop", async () => {
    const tmux = {
      session: {
        hasSession: async () => {
          throw new Error("no server running");
        },
      },
    } as unknown as TmuxNamespace;
    expect(
      await migrateLegacySessionName({ tmux, teamName: "x", resolvedSession: "x" }),
    ).toBe("noop");
  });
});

// ---------- Layer 2: real tmux server on a private socket ----------

describe("bare-name anchoring + migration against a real tmux server", () => {
  let socketDir: string;
  let socketPath: string;
  let priorTmux: string | undefined;
  let tmux: TmuxNamespace;

  beforeEach(async () => {
    socketDir = await mkdtemp(join(tmpdir(), "atmux-session-migrate-"));
    socketPath = join(socketDir, "sock");
    priorTmux = process.env.TMUX;
    delete process.env.TMUX;
    tmux = createTmux({ socketPath, configFile: "/dev/null" });
  });

  afterEach(async () => {
    try {
      await tmux.server.killServer();
    } catch {
      // expected: server may already be gone
    }
    if (priorTmux !== undefined) process.env.TMUX = priorTmux;
    await rm(socketDir, { recursive: true, force: true });
  });

  test("tmux prefix-matches session names; `=` closes the hole (journal vs journalism)", async () => {
    await tmux.session.newSession({ name: "journalism", detached: true });
    // The hazard, demonstrated live: an unanchored probe for `journal`
    // is satisfied by `journalism`. If this ever starts failing, tmux
    // changed its matching rules and the `=` anchors are merely
    // redundant, not wrong.
    expect(await tmux.session.hasSession("journal")).toBe(true);
    // The fix: exact-match anchor.
    expect(await tmux.session.hasSession(exactSessionTarget("journal"))).toBe(false);
    expect(await tmux.session.hasSession(exactSessionTarget("journalism"))).toBe(true);
  });

  test("migrates a live legacy `atmux-<team>` session to the bare name in place", async () => {
    await tmux.session.newSession({ name: "atmux-demo", detached: true, windowName: "driver" });
    const out = await migrateLegacySessionName({
      tmux,
      teamName: "demo",
      resolvedSession: "demo",
    });
    expect(out).toBe("renamed");
    expect(await tmux.session.hasSession(exactSessionTarget("demo"))).toBe(true);
    expect(await tmux.session.hasSession(exactSessionTarget("atmux-demo"))).toBe(false);
    // Windows (and with them panes/PIDs) survive a rename-session.
    const windows = await tmux.window.listWindows("demo");
    expect(windows.map((w) => w.name)).toEqual(["driver"]);
    // Idempotent on the live server too.
    expect(
      await migrateLegacySessionName({ tmux, teamName: "demo", resolvedSession: "demo" }),
    ).toBe("noop");
  });

  test("leaves BOTH sessions untouched when legacy and bare coexist", async () => {
    await tmux.session.newSession({ name: "atmux-dup", detached: true });
    await tmux.session.newSession({ name: "dup", detached: true });
    const warns: string[] = [];
    const out = await migrateLegacySessionName({
      tmux,
      teamName: "dup",
      resolvedSession: "dup",
      warn: (m) => warns.push(m),
    });
    expect(out).toBe("ambiguous");
    expect(await tmux.session.hasSession(exactSessionTarget("atmux-dup"))).toBe(true);
    expect(await tmux.session.hasSession(exactSessionTarget("dup"))).toBe(true);
    expect(warns).toHaveLength(1);
  });
});
