// Unit tests for src/core/window-id.ts (ADR-057 §D5b).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import {
  readCache,
  resolveTarget,
  resolveWindowId,
  windowIdCachePath,
  writeCache,
  type WindowIdCache,
} from "../../../src/core/window-id.ts";

// ---------- Test helpers ----------

interface FakeTmuxOpts {
  /** Window list returned by listWindows. */
  windows?: ReadonlyArray<{ index: number; id: string; name: string; active: boolean }>;
  /** session_created epoch returned by displayMessage. */
  sessionStartedAt?: number;
  /** Make displayMessage throw (simulates session-down). */
  failDisplay?: boolean;
  /** Make listWindows throw. */
  failListWindows?: boolean;
}

function fakeTmux(o: FakeTmuxOpts = {}): TmuxNamespace {
  const ns: Partial<TmuxNamespace> = {
    window: {
      listWindows: async () => {
        if (o.failListWindows) throw new Error("list-windows boom");
        return [...(o.windows ?? [])];
      },
      // unused stubs
      newWindow: async () => ({ sessionName: "x", windowIndex: 0 }),
      killWindow: async () => {},
      renameWindow: async () => {},
      selectWindow: async () => {},
      moveWindow: async () => {},
    },
    pane: {
      displayMessage: async () => {
        if (o.failDisplay) throw new Error("display boom");
        return String(o.sessionStartedAt ?? 1_000);
      },
      // unused stubs
      sendKeys: async () => {},
      capturePane: async () => "",
      listPanes: async () => [],
      killPane: async () => {},
      splitWindow: async () => ({ sessionName: "x", windowIndex: 0, paneIndex: 0 }),
    },
  };
  return ns as TmuxNamespace;
}

// ---------- Cache I/O ----------

describe("window-id cache I/O", () => {
  let dir: string;
  let atmuxDir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atmux-winid-"));
    atmuxDir = join(dir, ".atmux");
    await mkdir(join(atmuxDir, "state"), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("readCache absent → empty", async () => {
    expect(await readCache(atmuxDir)).toEqual({});
  });

  test("readCache corrupt JSON → empty", async () => {
    await Bun.write(windowIdCachePath(atmuxDir), "{not-json");
    expect(await readCache(atmuxDir)).toEqual({});
  });

  test("readCache shape-invalid → empty", async () => {
    await Bun.write(windowIdCachePath(atmuxDir), JSON.stringify({ team: "wrong-shape" }));
    expect(await readCache(atmuxDir)).toEqual({});
  });

  test("writeCache then readCache round-trip", async () => {
    const c: WindowIdCache = {
      atmux: { sessionStartedAt: 1234, windows: { lead: "@5", alpha: "@7" } },
    };
    await writeCache(atmuxDir, c);
    expect(await readCache(atmuxDir)).toEqual(c);
  });
});

// ---------- resolveWindowId ----------

describe("resolveWindowId", () => {
  let dir: string;
  let atmuxDir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atmux-winid-resolve-"));
    atmuxDir = join(dir, ".atmux");
    await mkdir(join(atmuxDir, "state"), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("first lookup: cache miss → listWindows → cache populated → returns @N", async () => {
    const tmux = fakeTmux({
      windows: [{ index: 0, id: "@3", name: "🧭lead", active: true }],
      sessionStartedAt: 9999,
    });
    const r = await resolveWindowId({
      atmuxDir,
      team: "atmux",
      sessionName: "atmux-atmux",
      member: "lead",
      windowName: "🧭lead",
      tmux,
    });
    expect(r).toEqual({ kind: "ok", windowId: "@3", cacheHit: false });
    const written = await readCache(atmuxDir);
    expect(written.atmux?.windows.lead).toBe("@3");
    expect(written.atmux?.sessionStartedAt).toBe(9999);
  });

  test("second lookup hits cache (cacheHit=true)", async () => {
    const tmux = fakeTmux({
      windows: [{ index: 0, id: "@3", name: "🧭lead", active: true }],
      sessionStartedAt: 9999,
    });
    await resolveWindowId({
      atmuxDir,
      team: "atmux",
      sessionName: "s",
      member: "lead",
      windowName: "🧭lead",
      tmux,
    });
    // Second call. Inject a tmux that returns NO windows — cache must serve it.
    const empty = fakeTmux({ windows: [], sessionStartedAt: 9999 });
    const r = await resolveWindowId({
      atmuxDir,
      team: "atmux",
      sessionName: "s",
      member: "lead",
      windowName: "🧭lead",
      tmux: empty,
    });
    expect(r).toEqual({ kind: "ok", windowId: "@3", cacheHit: true });
  });

  test("window rename → cache hit returns same @N (resilience property)", async () => {
    // First lookup with the emoji-prefix name.
    const tmux1 = fakeTmux({
      windows: [{ index: 0, id: "@7", name: "🧭lead", active: true }],
      sessionStartedAt: 100,
    });
    await resolveWindowId({
      atmuxDir,
      team: "atmux",
      sessionName: "s",
      member: "lead",
      windowName: "🧭lead",
      tmux: tmux1,
    });
    // Window renamed to bare 'lead'. Caller's windowName is now stale.
    // Cache MUST still resolve to @7 by (team, member) key — independent of name.
    const tmux2 = fakeTmux({
      windows: [{ index: 0, id: "@7", name: "lead", active: true }],
      sessionStartedAt: 100,
    });
    const r = await resolveWindowId({
      atmuxDir,
      team: "atmux",
      sessionName: "s",
      member: "lead",
      windowName: "🧭lead", // stale!
      tmux: tmux2,
    });
    expect(r).toEqual({ kind: "ok", windowId: "@7", cacheHit: true });
  });

  test("session restart (sessionStartedAt mismatch) → cache invalidated, re-list", async () => {
    // Seed cache with old sessionStartedAt.
    await writeCache(atmuxDir, {
      atmux: { sessionStartedAt: 100, windows: { lead: "@7" } },
    });
    // New session → new sessionStartedAt + new @N.
    const tmux = fakeTmux({
      windows: [{ index: 0, id: "@9", name: "🧭lead", active: true }],
      sessionStartedAt: 200,
    });
    const r = await resolveWindowId({
      atmuxDir,
      team: "atmux",
      sessionName: "s",
      member: "lead",
      windowName: "🧭lead",
      tmux,
    });
    expect(r).toEqual({ kind: "ok", windowId: "@9", cacheHit: false });
    const written = await readCache(atmuxDir);
    expect(written.atmux?.sessionStartedAt).toBe(200);
    expect(written.atmux?.windows.lead).toBe("@9");
  });

  test("window not present → not-found", async () => {
    const tmux = fakeTmux({
      windows: [{ index: 0, id: "@5", name: "other", active: true }],
      sessionStartedAt: 100,
    });
    const r = await resolveWindowId({
      atmuxDir,
      team: "atmux",
      sessionName: "s",
      member: "lead",
      windowName: "🧭lead",
      tmux,
    });
    expect(r).toEqual({ kind: "not-found" });
  });

  test("displayMessage failure → sessionStartedAt=0 (treated as fresh)", async () => {
    const tmux = fakeTmux({
      windows: [{ index: 0, id: "@5", name: "🧭lead", active: true }],
      failDisplay: true,
    });
    const r = await resolveWindowId({
      atmuxDir,
      team: "atmux",
      sessionName: "s",
      member: "lead",
      windowName: "🧭lead",
      tmux,
    });
    expect(r.kind).toBe("ok");
  });

  test("custom getSessionStartedAt override", async () => {
    const tmux = fakeTmux({
      windows: [{ index: 0, id: "@5", name: "🧭lead", active: true }],
    });
    const r = await resolveWindowId({
      atmuxDir,
      team: "atmux",
      sessionName: "s",
      member: "lead",
      windowName: "🧭lead",
      tmux,
      getSessionStartedAt: async () => 42,
    });
    expect(r.kind).toBe("ok");
    const written = await readCache(atmuxDir);
    expect(written.atmux?.sessionStartedAt).toBe(42);
  });

  test("multiple members under same team share the cache slot", async () => {
    const tmux = fakeTmux({
      windows: [
        { index: 0, id: "@1", name: "lead", active: true },
        { index: 1, id: "@2", name: "alpha", active: false },
      ],
      sessionStartedAt: 555,
    });
    await resolveWindowId({
      atmuxDir,
      team: "atmux",
      sessionName: "s",
      member: "lead",
      windowName: "lead",
      tmux,
    });
    await resolveWindowId({
      atmuxDir,
      team: "atmux",
      sessionName: "s",
      member: "alpha",
      windowName: "alpha",
      tmux,
    });
    const c = await readCache(atmuxDir);
    expect(c.atmux?.windows).toEqual({ lead: "@1", alpha: "@2" });
  });

  test("multi-team cache: different teams are independent", async () => {
    const tmux = fakeTmux({
      windows: [{ index: 0, id: "@1", name: "lead", active: true }],
      sessionStartedAt: 100,
    });
    await resolveWindowId({
      atmuxDir,
      team: "team-a",
      sessionName: "s",
      member: "lead",
      windowName: "lead",
      tmux,
    });
    await resolveWindowId({
      atmuxDir,
      team: "team-b",
      sessionName: "s",
      member: "lead",
      windowName: "lead",
      tmux,
    });
    const c = await readCache(atmuxDir);
    expect(Object.keys(c).sort()).toEqual(["team-a", "team-b"]);
  });

  test("matching window with empty id → not-found (defensive)", async () => {
    const tmux = fakeTmux({
      windows: [{ index: 0, id: "", name: "lead", active: true }],
      sessionStartedAt: 100,
    });
    const r = await resolveWindowId({
      atmuxDir,
      team: "atmux",
      sessionName: "s",
      member: "lead",
      windowName: "lead",
      tmux,
    });
    expect(r).toEqual({ kind: "not-found" });
  });
});

// ---------- resolveTarget ----------

describe("resolveTarget", () => {
  let dir: string;
  let atmuxDir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atmux-winid-target-"));
    atmuxDir = join(dir, ".atmux");
    await mkdir(join(atmuxDir, "state"), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("hit → returns @N", async () => {
    const tmux = fakeTmux({
      windows: [{ index: 0, id: "@3", name: "lead", active: true }],
      sessionStartedAt: 100,
    });
    const t = await resolveTarget({
      atmuxDir,
      team: "atmux",
      sessionName: "s",
      member: "lead",
      windowName: "lead",
      tmux,
    });
    expect(t).toBe("@3");
  });

  test("miss → falls back to <session>:<windowName>", async () => {
    const tmux = fakeTmux({ windows: [], sessionStartedAt: 100 });
    const t = await resolveTarget({
      atmuxDir,
      team: "atmux",
      sessionName: "atmux-atmux",
      member: "lead",
      windowName: "🧭lead",
      tmux,
    });
    expect(t).toBe("atmux-atmux:🧭lead");
  });
});

// ---------- windowIdCachePath ----------

describe("windowIdCachePath", () => {
  test("places file under <atmuxDir>/state/window-id-cache.json", () => {
    expect(windowIdCachePath("/x/.atmux")).toBe("/x/.atmux/state/window-id-cache.json");
  });
});

// File-write path (sanity, atomic via writeText).
describe("writeCache (file effects)", () => {
  test("creates file with pretty-printed JSON ending in newline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atmux-winid-write-"));
    const atmuxDir = join(dir, ".atmux");
    await mkdir(join(atmuxDir, "state"), { recursive: true });
    try {
      await writeCache(atmuxDir, {
        atmux: { sessionStartedAt: 1, windows: { lead: "@1" } },
      });
      const txt = await readFile(windowIdCachePath(atmuxDir), "utf8");
      expect(txt.endsWith("\n")).toBe(true);
      expect(JSON.parse(txt)).toEqual({
        atmux: { sessionStartedAt: 1, windows: { lead: "@1" } },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
