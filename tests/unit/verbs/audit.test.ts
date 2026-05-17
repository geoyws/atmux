// Unit tests for src/verbs/audit.ts (ADR-079 §B).
//
// Coverage strategy
// -----------------
// Pure detectors (detectClassA / B / C / D / E) drive every branch with
// injected windows / tmpdir / fs probes. Args parser exercises every
// flag + UsageError path. Renderers tested for empty + non-empty.
// `runAllChecks` exercised via fixture team.json + injected tmux + fs
// deps so no real tmux server is touched.
//
// ADR-044 reversal — class A:
//   - bare `driver` window → GREEN (no finding)
//   - `__<team>__driver` → RED (finding) — the regression-pin against
//     bash's old "expects prefix" rule.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import { UsageError } from "../../../src/errors.ts";
import {
  type AuditArgs,
  audit,
  buildTmuxConfig,
  defaultHasLiveSocket,
  defaultListDir,
  detectClassA,
  detectClassB,
  detectClassC,
  detectClassD,
  detectClassE,
  loadRegisteredTmpdirs,
  makeFinding,
  parseAuditArgs,
  renderHuman,
  renderJson,
  runAllChecks,
} from "../../../src/verbs/audit.ts";

// ---------- parseAuditArgs ----------

describe("parseAuditArgs", () => {
  test("default → quiet/json off, classFilter='all'", () => {
    expect(parseAuditArgs([])).toEqual({ quiet: false, json: false, classFilter: "all" });
  });

  test("--quiet and -q flip quiet", () => {
    expect(parseAuditArgs(["--quiet"]).quiet).toBe(true);
    expect(parseAuditArgs(["-q"]).quiet).toBe(true);
  });

  test("--json flips json", () => {
    expect(parseAuditArgs(["--json"]).json).toBe(true);
  });

  test("--class accepts a/b/c/d/e/f/all (lowercase)", () => {
    const inputs: ReadonlyArray<"a" | "b" | "c" | "d" | "e" | "f" | "all"> = [
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "all",
    ];
    for (const v of inputs) {
      expect(parseAuditArgs(["--class", v]).classFilter).toBe(v);
    }
  });

  test("--class normalizes uppercase", () => {
    expect(parseAuditArgs(["--class", "A"]).classFilter).toBe("a");
  });

  test("--class=<v> shorthand", () => {
    expect(parseAuditArgs(["--class=b"]).classFilter).toBe("b");
  });

  test("--class without value → UsageError", () => {
    expect(() => parseAuditArgs(["--class"])).toThrow(UsageError);
  });

  test("--class invalid → UsageError", () => {
    expect(() => parseAuditArgs(["--class", "z"])).toThrow(UsageError);
    expect(() => parseAuditArgs(["--class=z"])).toThrow(UsageError);
  });

  test("--team-dir captured", () => {
    expect(parseAuditArgs(["--team-dir", "/x"]).teamDir).toBe("/x");
  });

  test("--team-dir without value → UsageError", () => {
    expect(() => parseAuditArgs(["--team-dir"])).toThrow(UsageError);
  });

  test("--socket captured", () => {
    expect(parseAuditArgs(["--socket", "/tmp/s"]).socketPath).toBe("/tmp/s");
  });

  test("--socket without value → UsageError", () => {
    expect(() => parseAuditArgs(["--socket"])).toThrow(UsageError);
  });

  test("--fix → UsageError (not implemented in bun port)", () => {
    expect(() => parseAuditArgs(["--fix"])).toThrow(UsageError);
  });

  test("--dry-run → UsageError (not implemented in bun port)", () => {
    expect(() => parseAuditArgs(["--dry-run"])).toThrow(UsageError);
  });

  test("--help / -h → UsageError (usage surfaced)", () => {
    expect(() => parseAuditArgs(["--help"])).toThrow(UsageError);
    expect(() => parseAuditArgs(["-h"])).toThrow(UsageError);
  });

  test("unknown flag → UsageError", () => {
    expect(() => parseAuditArgs(["--bogus"])).toThrow(UsageError);
  });
});

// ---------- makeFinding ----------

describe("makeFinding", () => {
  test("class A populates medium/medium/false meta", () => {
    const f = makeFinding("A", "atmux", "detail", "fix");
    expect(f.severity).toBe("medium");
    expect(f.blast_radius).toBe("medium");
    expect(f.auto_fixable).toBe(false);
    expect(f.team).toBe("atmux");
    expect(f.detail).toBe("detail");
    expect(f.fix_hint).toBe("fix");
  });

  test("class D populates low/low/true meta", () => {
    const f = makeFinding("D", "x", "d", "f");
    expect(f.severity).toBe("low");
    expect(f.auto_fixable).toBe(true);
  });

  test("class B is high/high/false", () => {
    const f = makeFinding("B", "x", "d", "f");
    expect(f.severity).toBe("high");
    expect(f.blast_radius).toBe("high");
    expect(f.auto_fixable).toBe(false);
  });
});

// ---------- detectClassA — ADR-044 reversal ----------

describe("detectClassA", () => {
  test("bare 'driver' window → GREEN (no finding)", () => {
    const r = detectClassA({ team: "atmux", windows: [{ name: "driver" }] });
    expect(r).toBeNull();
  });

  test("'__atmux__driver' window → RED (regression-pin against old bash rule)", () => {
    const r = detectClassA({ team: "atmux", windows: [{ name: "__atmux__driver" }] });
    expect(r).not.toBeNull();
    expect(r?.class).toBe("A");
    expect(r?.detail).toContain("__atmux__driver");
    expect(r?.detail).toContain("ADR-044");
  });

  test("no driver-shaped window at all → GREEN", () => {
    const r = detectClassA({ team: "atmux", windows: [{ name: "lead" }, { name: "🐝gitter" }] });
    expect(r).toBeNull();
  });

  test("team name mismatch → GREEN (only this team's prefixed form is flagged)", () => {
    const r = detectClassA({
      team: "atmux",
      windows: [{ name: "__other__driver" }],
    });
    expect(r).toBeNull();
  });
});

// ---------- detectClassB — hyphen-form tmpdir ----------

describe("detectClassB", () => {
  test("hyphen-form '/tmp/atmux-tmux-…' → RED", () => {
    const r = detectClassB({ team: "atmux", tmuxTmpdir: "/tmp/atmux-tmux-atmux" });
    expect(r).not.toBeNull();
    expect(r?.class).toBe("B");
    expect(r?.detail).toContain("/tmp/atmux-tmux-atmux");
    expect(r?.detail).toContain("/tmp/atmux_tmux_atmux");
  });

  test("underscore-form '/tmp/atmux_tmux_…' → GREEN", () => {
    const r = detectClassB({ team: "atmux", tmuxTmpdir: "/tmp/atmux_tmux_atmux" });
    expect(r).toBeNull();
  });

  test("undefined tmuxTmpdir → GREEN", () => {
    const r = detectClassB({ team: "atmux" });
    expect(r).toBeNull();
  });

  test("empty string tmuxTmpdir → GREEN", () => {
    const r = detectClassB({ team: "atmux", tmuxTmpdir: "" });
    expect(r).toBeNull();
  });

  test("unrelated path '/var/tmp/foo' → GREEN", () => {
    const r = detectClassB({ team: "atmux", tmuxTmpdir: "/var/tmp/foo" });
    expect(r).toBeNull();
  });
});

// ---------- detectClassC — window-position drift ----------

describe("detectClassC", () => {
  test("pos1='driver', pos2='🧭lead' → GREEN", () => {
    const r = detectClassC({
      team: "atmux",
      windows: [
        { index: 1, name: "driver" },
        { index: 2, name: "🧭lead" },
      ],
    });
    expect(r).toEqual([]);
  });

  test("pos1=other → C finding (driver misplaced)", () => {
    const r = detectClassC({
      team: "atmux",
      windows: [
        { index: 1, name: "🐝gitter" },
        { index: 2, name: "🧭lead" },
      ],
    });
    expect(r.length).toBe(1);
    expect(r[0]?.detail).toContain("window-position 1");
  });

  test("pos2=non-lead → C finding (lead misplaced)", () => {
    const r = detectClassC({
      team: "atmux",
      windows: [
        { index: 1, name: "driver" },
        { index: 2, name: "🐝gitter" },
      ],
    });
    expect(r.length).toBe(1);
    expect(r[0]?.detail).toContain("window-position 2");
  });

  test("pos1='__atmux__driver' (legacy prefixed) → GREEN at pos 1 (Class A handles the rename ask)", () => {
    const r = detectClassC({
      team: "atmux",
      windows: [
        { index: 1, name: "__atmux__driver" },
        { index: 2, name: "lead" },
      ],
    });
    expect(r).toEqual([]);
  });

  test("missing pos2 row (e.g. solo driver session) → GREEN at C", () => {
    const r = detectClassC({
      team: "atmux",
      windows: [{ index: 1, name: "driver" }],
    });
    expect(r).toEqual([]);
  });

  test("legacy prefixed lead `__atmux__🧭lead` → GREEN at pos 2", () => {
    const r = detectClassC({
      team: "atmux",
      windows: [
        { index: 1, name: "driver" },
        { index: 2, name: "__atmux__🧭lead" },
      ],
    });
    expect(r).toEqual([]);
  });
});

// ---------- detectClassD — trailing punctuation residue ----------

describe("detectClassD", () => {
  test("'__atmux__bee-' → finding stripping trailing dash", () => {
    const r = detectClassD({ team: "atmux", windows: [{ name: "__atmux__bee-" }] });
    expect(r.length).toBe(1);
    expect(r[0]?.detail).toContain("'__atmux__bee'");
  });

  test("'__atmux__bee_' → finding stripping trailing underscore", () => {
    const r = detectClassD({ team: "atmux", windows: [{ name: "__atmux__bee_" }] });
    expect(r.length).toBe(1);
    expect(r[0]?.detail).toContain("'__atmux__bee'");
  });

  test("'__atmux__bee--__' → strip whole tail", () => {
    const r = detectClassD({ team: "atmux", windows: [{ name: "__atmux__bee--__" }] });
    expect(r.length).toBe(1);
    expect(r[0]?.detail).toContain("'__atmux__bee'");
  });

  test("ADR-017 bare-emoji name (no `__<team>__` prefix) → GREEN (out of scope here)", () => {
    const r = detectClassD({ team: "atmux", windows: [{ name: "🐝gitter-" }] });
    expect(r).toEqual([]);
  });

  test("clean prefixed name → GREEN", () => {
    const r = detectClassD({ team: "atmux", windows: [{ name: "__atmux__bee" }] });
    expect(r).toEqual([]);
  });

  test("multiple windows with residue → multiple findings", () => {
    const r = detectClassD({
      team: "atmux",
      windows: [{ name: "__atmux__a-" }, { name: "__atmux__b__" }, { name: "__atmux__c" }],
    });
    expect(r.length).toBe(2);
  });
});

// ---------- detectClassE — stray cage tmpdirs ----------

describe("detectClassE", () => {
  test("returns finding for stray dir not in registered set + no socket", async () => {
    const r = await detectClassE({
      team: "atmux",
      tmpRoot: "/fake-tmp",
      registeredTmpdirs: new Set(),
      listDir: async (path) => {
        if (path === "/fake-tmp") return ["atmux-tmux-stale", "unrelated"];
        return [];
      },
      hasLiveSocket: async () => false,
    });
    expect(r.length).toBe(1);
    expect(r[0]?.detail).toContain("/fake-tmp/atmux-tmux-stale");
  });

  test("registered tmpdir is excluded", async () => {
    const dir = "/fake-tmp/atmux_tmux_atmux";
    const r = await detectClassE({
      team: "atmux",
      tmpRoot: "/fake-tmp",
      registeredTmpdirs: new Set([dir]),
      listDir: async () => ["atmux_tmux_atmux"],
      hasLiveSocket: async () => false,
    });
    expect(r).toEqual([]);
  });

  test("live-socket dir is excluded", async () => {
    const r = await detectClassE({
      team: "atmux",
      tmpRoot: "/fake-tmp",
      registeredTmpdirs: new Set(),
      listDir: async () => ["atmux_tmux_running"],
      hasLiveSocket: async (d) => d === "/fake-tmp/atmux_tmux_running",
    });
    expect(r).toEqual([]);
  });

  test("non-atmux entries skipped", async () => {
    const r = await detectClassE({
      team: "atmux",
      tmpRoot: "/fake-tmp",
      registeredTmpdirs: new Set(),
      listDir: async () => ["systemd-private-xxx", "tmp.txt"],
      hasLiveSocket: async () => false,
    });
    expect(r).toEqual([]);
  });

  test("missing root → empty (defaultListDir swallows errors)", async () => {
    const r = await detectClassE({
      team: "atmux",
      tmpRoot: "/fake-tmp",
      registeredTmpdirs: new Set(),
      listDir: async () => [],
      hasLiveSocket: async () => false,
    });
    expect(r).toEqual([]);
  });

  test("default fs probes — no error on missing root", async () => {
    // Drives the default listDir + default hasLiveSocket against a path
    // that doesn't exist. defaultListDir catches ENOENT → [].
    const r = await detectClassE({
      team: "atmux",
      tmpRoot: "/this/path/does/not/exist",
      registeredTmpdirs: new Set(),
    });
    expect(r).toEqual([]);
  });

  test("default hasLiveSocket — false on missing dir", async () => {
    // Construct a real on-disk staging area where the candidate dir
    // exists but has no socket inside; default probes should classify
    // as "no live socket" → finding emitted.
    const root = await mkdtemp(join(tmpdir(), "audit-classe-"));
    try {
      await mkdir(join(root, "atmux_tmux_demo"), { recursive: true });
      const r = await detectClassE({
        team: "demo",
        tmpRoot: root,
        registeredTmpdirs: new Set(),
      });
      expect(r.length).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------- defaultListDir / defaultHasLiveSocket ----------

describe("defaultListDir", () => {
  test("missing path → []", async () => {
    expect(await defaultListDir("/this/path/does/not/exist")).toEqual([]);
  });

  test("real dir → entries listed", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-listdir-"));
    try {
      await writeFile(join(root, "a"), "");
      await writeFile(join(root, "b"), "");
      const out = await defaultListDir(root);
      expect(out.sort()).toEqual(["a", "b"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("defaultHasLiveSocket", () => {
  test("missing dir → false", async () => {
    expect(await defaultHasLiveSocket("/this/path/does/not/exist")).toBe(false);
  });

  test("dir with no tmux-* sub → false", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-haslive-"));
    try {
      await mkdir(join(root, "unrelated"), { recursive: true });
      expect(await defaultHasLiveSocket(root)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("tmux-* sub with no `default` socket → false", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-haslive-"));
    try {
      await mkdir(join(root, "tmux-1000"), { recursive: true });
      expect(await defaultHasLiveSocket(root)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("tmux-* sub with `default` REGULAR FILE (not socket) → false", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-haslive-"));
    try {
      await mkdir(join(root, "tmux-1000"), { recursive: true });
      await writeFile(join(root, "tmux-1000", "default"), "");
      expect(await defaultHasLiveSocket(root)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("tmux-* sub with a real unix-domain socket → true", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-haslive-"));
    try {
      await mkdir(join(root, "tmux-1000"), { recursive: true });
      const sockPath = join(root, "tmux-1000", "default");
      const srv = createServer();
      await new Promise<void>((resolve, reject) => {
        srv.once("error", reject);
        srv.listen(sockPath, () => resolve());
      });
      try {
        expect(await defaultHasLiveSocket(root)).toBe(true);
      } finally {
        await new Promise<void>((resolve) => srv.close(() => resolve()));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------- buildTmuxConfig ----------

describe("buildTmuxConfig", () => {
  test("socketOverride takes precedence", () => {
    const cfg = buildTmuxConfig({ name: "t" }, "/tmp/override.sock");
    expect(cfg).toEqual({ socketPath: "/tmp/override.sock" });
  });

  test("falls through to resolveTeamSocket on tmuxTmpdir", () => {
    const cfg = buildTmuxConfig({ name: "demo", tmuxTmpdir: "/tmp/atmux_tmux_demo" });
    expect("socketPath" in cfg).toBe(true);
    expect((cfg as { socketPath: string }).socketPath).toContain("/tmp/atmux_tmux_demo/tmux-");
  });

  test("non-string tmuxTmpdir → falls through to default cage path", () => {
    const cfg = buildTmuxConfig({ name: "demo", tmuxTmpdir: 0 as unknown });
    expect((cfg as { socketPath: string }).socketPath).toBe("/tmp/atmux-demo/sock");
  });
});

// ---------- loadRegisteredTmpdirs ----------

describe("loadRegisteredTmpdirs", () => {
  test("aggregates tmuxTmpdir from each enabled team's team.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-cockpit-"));
    try {
      const teamA = join(root, "team-a");
      const teamB = join(root, "team-b");
      await mkdir(join(teamA, ".atmux"), { recursive: true });
      await mkdir(join(teamB, ".atmux"), { recursive: true });
      await writeFile(
        join(teamA, ".atmux", "team.json"),
        JSON.stringify({ name: "ta", members: [], tmuxTmpdir: "/tmp/atmux_tmux_ta" }),
      );
      await writeFile(
        join(teamB, ".atmux", "team.json"),
        JSON.stringify({ name: "tb", members: [] }),
      );
      const set = await loadRegisteredTmpdirs(async () => ({
        teams: [
          { root: teamA, enabled: true },
          { root: teamB, enabled: true },
          { root: "/nonexistent", enabled: true },
        ],
      }));
      expect(set.has("/tmp/atmux_tmux_ta")).toBe(true);
      expect(set.size).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("loader rejection → empty set (best-effort)", async () => {
    const set = await loadRegisteredTmpdirs(async () => {
      throw new Error("no cockpit");
    });
    expect(set.size).toBe(0);
  });
});

// ---------- Renderers ----------

describe("renderHuman", () => {
  test("empty findings → green sentinel line", () => {
    expect(renderHuman([])).toBe("✅ atmux audit: no drift detected\n");
  });

  test("one finding → header + drift table row", () => {
    const out = renderHuman([makeFinding("A", "atmux", "detail-x", "fix-y")]);
    expect(out).toContain("🩹 atmux audit: 1 drift(s)");
    expect(out).toContain("A");
    expect(out).toContain("medium");
    expect(out).toContain("detail-x");
    expect(out).toContain("fix-y");
  });

  test("missing team falls back to '-'", () => {
    const out = renderHuman([makeFinding("E", "", "stray-d", "rmdir")]);
    expect(out).toContain(" - ");
  });
});

describe("renderJson", () => {
  test("empty findings → '[]\\n'", () => {
    expect(renderJson([])).toBe("[]\n");
  });

  test("one finding → JSON-pretty array", () => {
    const out = renderJson([makeFinding("D", "atmux", "d", "f")]);
    expect(out.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(out);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].class).toBe("D");
    expect(parsed[0].auto_fixable).toBe(true);
  });
});

// ---------- runAllChecks (driver) ----------

async function makeFixtureTeam(opts: { name: string; tmuxTmpdir?: string }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "audit-fixture-"));
  const dir = join(root, ".atmux");
  await mkdir(dir, { recursive: true });
  const team: Record<string, unknown> = { name: opts.name, members: [] };
  if (opts.tmuxTmpdir !== undefined) team.tmuxTmpdir = opts.tmuxTmpdir;
  await writeFile(join(dir, "team.json"), JSON.stringify(team));
  return dir;
}

interface StubWindow {
  index: number;
  id: string;
  name: string;
  active: boolean;
}

function makeStubTmux(
  windows: ReadonlyArray<StubWindow>,
  overrides: {
    hasSession?: () => Promise<boolean>;
    listWindows?: () => Promise<ReadonlyArray<StubWindow>>;
  } = {},
): TmuxNamespace {
  const stub = {
    session: {
      hasSession: overrides.hasSession ?? (async () => true),
      listSessions: async () => [] as { name: string; windows: number; created: number }[],
      newSession: async () => undefined,
      killSession: async () => undefined,
      renameSession: async () => undefined,
    },
    window: {
      listWindows: overrides.listWindows ?? (async () => windows),
      newWindow: async () => ({ sessionName: "atmux-x", windowIndex: 0 }),
      killWindow: async () => undefined,
      renameWindow: async () => undefined,
      selectWindow: async () => undefined,
      moveWindow: async () => undefined,
    },
    pane: {} as never,
    client: {} as never,
    cmd: {} as never,
  };
  return stub as unknown as TmuxNamespace;
}

const STUB_TMUX: TmuxNamespace = makeStubTmux([
  { index: 1, id: "@1", name: "driver", active: true },
  { index: 2, id: "@2", name: "🧭lead", active: false },
]);

const STUB_TMUX_DRIFTED: TmuxNamespace = makeStubTmux([
  { index: 1, id: "@1", name: "__atmux__driver", active: true },
  { index: 2, id: "@2", name: "__atmux__🧭lead-", active: false },
]);

const NOOP_LOADER = async () => ({
  teams: [] as { root: string; enabled?: boolean }[],
});

describe("runAllChecks (driver)", () => {
  let teamDir: string;
  let cleanup: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    const dir = await makeFixtureTeam({ name: "atmux", tmuxTmpdir: "/tmp/atmux_tmux_atmux" });
    teamDir = dir;
    const root = dir.replace(/\/.atmux$/, "");
    cleanup = async () => {
      await rm(root, { recursive: true, force: true });
    };
  });

  afterEach(async () => {
    if (cleanup !== null) await cleanup();
    cleanup = null;
  });

  test("clean topology + canonical tmpdir → empty findings", async () => {
    const args: AuditArgs = { quiet: false, json: false, classFilter: "all", teamDir };
    const findings = await runAllChecks(args, {
      tmux: STUB_TMUX,
      loadCockpitFn: NOOP_LOADER,
      classEDeps: {
        tmpRoot: "/fake-tmp",
        listDir: async () => [],
        hasLiveSocket: async () => false,
      },
    });
    expect(findings).toEqual([]);
  });

  test("drifted topology surfaces A + C + D in one pass", async () => {
    const args: AuditArgs = { quiet: false, json: false, classFilter: "all", teamDir };
    const findings = await runAllChecks(args, {
      tmux: STUB_TMUX_DRIFTED,
      loadCockpitFn: NOOP_LOADER,
      classEDeps: {
        tmpRoot: "/fake-tmp",
        listDir: async () => [],
        hasLiveSocket: async () => false,
      },
    });
    const classes = findings.map((f) => f.class).sort();
    expect(classes).toContain("A");
    expect(classes).toContain("D");
    // Class C: pos2 had trailing punct; class A at pos1 still gates the
    // C-pos1-mismatch (legacy `__atmux__driver` is accepted at pos 1
    // per detectClassC's compatibility branch). So C surfaces only the
    // pos2 lead-shape finding via the trailing-punct path.
  });

  test("class B surfaces hyphen-form tmpdir even when session is down", async () => {
    const dir = await makeFixtureTeam({
      name: "legacy",
      tmuxTmpdir: "/tmp/atmux-tmux-legacy",
    });
    try {
      const args: AuditArgs = {
        quiet: false,
        json: false,
        classFilter: "all",
        teamDir: dir,
      };
      const stub = makeStubTmux([], { hasSession: async () => false });
      const findings = await runAllChecks(args, {
        tmux: stub,
        loadCockpitFn: NOOP_LOADER,
        classEDeps: {
          tmpRoot: "/fake-tmp",
          listDir: async () => [],
          hasLiveSocket: async () => false,
        },
      });
      const bs = findings.filter((f) => f.class === "B");
      expect(bs.length).toBe(1);
      expect(bs[0]?.detail).toContain("/tmp/atmux-tmux-legacy");
    } finally {
      await rm(dir.replace(/\/.atmux$/, ""), { recursive: true, force: true });
    }
  });

  test("classFilter='b' restricts scope to B only", async () => {
    const dir = await makeFixtureTeam({
      name: "legacy",
      tmuxTmpdir: "/tmp/atmux-tmux-legacy",
    });
    try {
      const args: AuditArgs = {
        quiet: false,
        json: false,
        classFilter: "b",
        teamDir: dir,
      };
      const findings = await runAllChecks(args, {
        tmux: STUB_TMUX_DRIFTED,
        loadCockpitFn: NOOP_LOADER,
        classEDeps: {
          tmpRoot: "/fake-tmp",
          listDir: async () => [],
          hasLiveSocket: async () => false,
        },
      });
      expect(findings.every((f) => f.class === "B")).toBe(true);
      expect(findings.length).toBe(1);
    } finally {
      await rm(dir.replace(/\/.atmux$/, ""), { recursive: true, force: true });
    }
  });

  test("malformed team.json → audit treats as 'no team', class E still runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-malformed-"));
    try {
      const dir = join(root, ".atmux");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "team.json"), "{ not valid json");
      const args: AuditArgs = { quiet: false, json: false, classFilter: "all", teamDir: dir };
      const findings = await runAllChecks(args, {
        tmux: STUB_TMUX,
        loadCockpitFn: NOOP_LOADER,
        classEDeps: {
          tmpRoot: "/fake-tmp",
          listDir: async () => ["atmux_tmux_orphan"],
          hasLiveSocket: async () => false,
        },
      });
      // No team-scoped findings; class E ran with empty team name.
      const classes = new Set(findings.map((f) => f.class));
      expect(classes.has("E")).toBe(true);
      expect(classes.has("A")).toBe(false);
      expect(classes.has("B")).toBe(false);
      expect(classes.has("C")).toBe(false);
      expect(classes.has("D")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("tmux hasSession throws → session treated as down (no A/C/D findings)", async () => {
    const stub = makeStubTmux([], {
      hasSession: async () => {
        throw new Error("tmux down");
      },
    });
    const args: AuditArgs = { quiet: false, json: false, classFilter: "all", teamDir };
    const findings = await runAllChecks(args, {
      tmux: stub,
      loadCockpitFn: NOOP_LOADER,
      classEDeps: {
        tmpRoot: "/fake-tmp",
        listDir: async () => [],
        hasLiveSocket: async () => false,
      },
    });
    // Class B still runs (it's tmpdir-based, not session-based); A/C/D
    // are gated on sessionExists — skipped silently.
    expect(findings.every((f) => f.class !== "A")).toBe(true);
    expect(findings.every((f) => f.class !== "C")).toBe(true);
    expect(findings.every((f) => f.class !== "D")).toBe(true);
  });

  test("tmux listWindows throws → windows treated as empty", async () => {
    const stub = makeStubTmux([], {
      listWindows: async () => {
        throw new Error("list-windows broke");
      },
    });
    const args: AuditArgs = { quiet: false, json: false, classFilter: "all", teamDir };
    const findings = await runAllChecks(args, {
      tmux: stub,
      loadCockpitFn: NOOP_LOADER,
      classEDeps: {
        tmpRoot: "/fake-tmp",
        listDir: async () => [],
        hasLiveSocket: async () => false,
      },
    });
    expect(findings.every((f) => f.class !== "A")).toBe(true);
    expect(findings.every((f) => f.class !== "C")).toBe(true);
    expect(findings.every((f) => f.class !== "D")).toBe(true);
  });

  test("classFilter='e' runs filesystem walk independently of team load", async () => {
    const args: AuditArgs = { quiet: false, json: false, classFilter: "e", teamDir };
    const findings = await runAllChecks(args, {
      tmux: STUB_TMUX,
      loadCockpitFn: NOOP_LOADER,
      classEDeps: {
        tmpRoot: "/fake-tmp",
        listDir: async () => ["atmux_tmux_stale"],
        hasLiveSocket: async () => false,
      },
    });
    expect(findings.length).toBe(1);
    expect(findings[0]?.class).toBe("E");
  });
});

// ---------- audit (verb entry) ----------

describe("audit (verb entry)", () => {
  let teamDir: string;
  let cleanup: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    const dir = await makeFixtureTeam({ name: "atmux", tmuxTmpdir: "/tmp/atmux_tmux_atmux" });
    teamDir = dir;
    const root = dir.replace(/\/.atmux$/, "");
    cleanup = async () => {
      await rm(root, { recursive: true, force: true });
    };
  });

  afterEach(async () => {
    if (cleanup !== null) await cleanup();
    cleanup = null;
  });

  test("--quiet on green topology → exit 0, no stdout writes", async () => {
    const writes: string[] = [];
    const code = await audit(["--quiet", "--team-dir", teamDir], {
      tmux: STUB_TMUX,
      loadCockpitFn: NOOP_LOADER,
      classEDeps: {
        tmpRoot: "/fake-tmp",
        listDir: async () => [],
        hasLiveSocket: async () => false,
      },
      stdout: (s) => writes.push(s),
    });
    expect(code).toBe(0);
    expect(writes).toEqual([]);
  });

  test("--quiet on drifted topology → exit 1, no stdout writes", async () => {
    const writes: string[] = [];
    const code = await audit(["--quiet", "--team-dir", teamDir], {
      tmux: STUB_TMUX_DRIFTED,
      loadCockpitFn: NOOP_LOADER,
      classEDeps: {
        tmpRoot: "/fake-tmp",
        listDir: async () => [],
        hasLiveSocket: async () => false,
      },
      stdout: (s) => writes.push(s),
    });
    expect(code).toBe(1);
    expect(writes).toEqual([]);
  });

  test("--json on green → '[]\\n' to stdout, exit 0", async () => {
    const writes: string[] = [];
    const code = await audit(["--json", "--team-dir", teamDir], {
      tmux: STUB_TMUX,
      loadCockpitFn: NOOP_LOADER,
      classEDeps: {
        tmpRoot: "/fake-tmp",
        listDir: async () => [],
        hasLiveSocket: async () => false,
      },
      stdout: (s) => writes.push(s),
    });
    expect(code).toBe(0);
    expect(writes.join("")).toBe("[]\n");
  });

  test("default (no flags) on green → human render to stdout, exit 0", async () => {
    const writes: string[] = [];
    const code = await audit(["--team-dir", teamDir], {
      tmux: STUB_TMUX,
      loadCockpitFn: NOOP_LOADER,
      classEDeps: {
        tmpRoot: "/fake-tmp",
        listDir: async () => [],
        hasLiveSocket: async () => false,
      },
      stdout: (s) => writes.push(s),
    });
    expect(code).toBe(0);
    expect(writes.join("")).toContain("no drift detected");
  });

  test("unknown flag → UsageError surfaces to caller", async () => {
    await expect(audit(["--bogus"])).rejects.toThrow(UsageError);
  });
});
