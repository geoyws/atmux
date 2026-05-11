// Unit tests for src/verbs/team-repair-rename.ts (ADR-027 ADDENDUM 11).
// Bash spec ref: lib/team-repair-rename.sh @ worktree-frozen (380 LOC).
//
// V1 scope: explicit-team mode, steps 1-4 + 6, rollback on failure.
// See verb header for deferred items.
//
// Coverage strategy
// -----------------
// Pure helpers (parse, newTmpdirFor, windowRenameTarget, evaluateDrift,
// isConverged, renderPlan) exercised directly. Side-effect helpers
// (probeDrift, applyRepair, teamRepairRename) driven against stub
// TmuxNamespace via opts.buildTmux. Filesystem state lives under a
// per-test mkdtemp dir so steps 1 (rename) + 4 (team.json) + 6
// (state.txt) can be inspected before/after without touching /tmp.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import {
  applyRepair,
  type DriftFlags,
  type DriftSnapshot,
  defaultBuildTmux,
  evaluateDrift,
  isConverged,
  newTmpdirFor,
  parseRepairRenameArgs,
  probeDrift,
  renderPlan,
  teamRepairRename,
  windowRenameTarget,
} from "../../../src/verbs/team-repair-rename.ts";

// ---------- parseRepairRenameArgs ----------

describe("parseRepairRenameArgs", () => {
  test("positional <team> only", () => {
    expect(parseRepairRenameArgs(["acme"])).toEqual({ team: "acme", dryRun: false });
  });

  test("--dry-run + team", () => {
    expect(parseRepairRenameArgs(["--dry-run", "acme"])).toEqual({
      team: "acme",
      dryRun: true,
    });
  });

  test("--socket + --team-dir captured", () => {
    expect(parseRepairRenameArgs(["--socket", "/s", "--team-dir", "/d", "acme"])).toEqual({
      team: "acme",
      dryRun: false,
      socketPath: "/s",
      teamDir: "/d",
    });
  });

  test("missing team → UsageError", () => {
    expect(() => parseRepairRenameArgs([])).toThrow(UsageError);
    expect(() => parseRepairRenameArgs(["--dry-run"])).toThrow(UsageError);
  });

  test("too many positionals → UsageError (V1 has no fleet auto-detect)", () => {
    expect(() => parseRepairRenameArgs(["a", "b"])).toThrow(UsageError);
  });

  test("--force rejected (reserved for deferred fleet auto-detect)", () => {
    expect(() => parseRepairRenameArgs(["--force", "acme"])).toThrow(UsageError);
  });

  test("unknown flag → UsageError", () => {
    expect(() => parseRepairRenameArgs(["--nope", "acme"])).toThrow(UsageError);
  });

  test("--socket without value → UsageError", () => {
    expect(() => parseRepairRenameArgs(["--socket"])).toThrow(UsageError);
  });

  test("--team-dir without value → UsageError", () => {
    expect(() => parseRepairRenameArgs(["--team-dir"])).toThrow(UsageError);
  });
});

// ---------- newTmpdirFor ----------

describe("newTmpdirFor", () => {
  test("ADR-027 ADDENDUM 11 form — /tmp/atmux_tmux_<team>", () => {
    expect(newTmpdirFor("acme")).toBe("/tmp/atmux_tmux_acme");
  });

  test("preserves hyphens + underscores in team name", () => {
    expect(newTmpdirFor("sopx-staging")).toBe("/tmp/atmux_tmux_sopx-staging");
    expect(newTmpdirFor("a_b")).toBe("/tmp/atmux_tmux_a_b");
  });
});

// ---------- windowRenameTarget ----------

describe("windowRenameTarget", () => {
  test("__<old>__<member> → __<team>__<member>", () => {
    expect(windowRenameTarget("__old__alice", "new")).toBe("__new__alice");
  });

  test("preserves emoji + suffix after second __", () => {
    expect(windowRenameTarget("__old__🐝alice", "new")).toBe("__new__🐝alice");
  });

  test("preserves nested underscores in suffix (greedy on second __ only)", () => {
    expect(windowRenameTarget("__old__foo_bar_baz", "new")).toBe("__new__foo_bar_baz");
  });

  test("hyphens + digits in old prefix accepted", () => {
    expect(windowRenameTarget("__my-team-1__alice", "new")).toBe("__new__alice");
  });

  test("returns input verbatim when no __<x>__ prefix (defensive)", () => {
    expect(windowRenameTarget("plain", "new")).toBe("plain");
    expect(windowRenameTarget("__nodbl", "new")).toBe("__nodbl");
  });
});

// ---------- evaluateDrift + isConverged ----------

describe("evaluateDrift", () => {
  function snap(overrides: Partial<DriftSnapshot>): DriftSnapshot {
    return {
      oldTmpdir: "/tmp/atmux_tmux_new",
      newTmpdir: "/tmp/atmux_tmux_new",
      oldSess: null,
      staleWindows: [],
      oldStateContent: null,
      cageAlive: false,
      ...overrides,
    };
  }

  test("all match target → converged (all flags false)", () => {
    const flags = evaluateDrift(snap({}), "new");
    expect(flags).toEqual({
      needsTmpdirMv: false,
      needsSessionRename: false,
      needsWindowRename: false,
      needsStateSync: false,
    });
    expect(isConverged(flags)).toBe(true);
  });

  test("tmpdir mismatch → needsTmpdirMv only", () => {
    const flags = evaluateDrift(
      snap({ oldTmpdir: "/tmp/atmux_tmux_old", newTmpdir: "/tmp/atmux_tmux_new" }),
      "new",
    );
    expect(flags.needsTmpdirMv).toBe(true);
    expect(isConverged(flags)).toBe(false);
  });

  test("cage-alive + session != team → needsSessionRename", () => {
    const flags = evaluateDrift(snap({ cageAlive: true, oldSess: "old" }), "new");
    expect(flags.needsSessionRename).toBe(true);
  });

  test("cage-alive but session == team → no session-rename", () => {
    const flags = evaluateDrift(snap({ cageAlive: true, oldSess: "new" }), "new");
    expect(flags.needsSessionRename).toBe(false);
  });

  test("cage-down → no session-rename regardless of name", () => {
    const flags = evaluateDrift(snap({ cageAlive: false, oldSess: "anything" }), "new");
    expect(flags.needsSessionRename).toBe(false);
  });

  test("stale windows → needsWindowRename", () => {
    const flags = evaluateDrift(snap({ staleWindows: ["__old__a"] }), "new");
    expect(flags.needsWindowRename).toBe(true);
  });

  test("state content != team → needsStateSync", () => {
    const flags = evaluateDrift(snap({ oldStateContent: "old" }), "new");
    expect(flags.needsStateSync).toBe(true);
  });

  test("state content matches → no state sync", () => {
    const flags = evaluateDrift(snap({ oldStateContent: "new" }), "new");
    expect(flags.needsStateSync).toBe(false);
  });

  test("state content null → no state sync (no file to drift against)", () => {
    const flags = evaluateDrift(snap({ oldStateContent: null }), "new");
    expect(flags.needsStateSync).toBe(false);
  });
});

// ---------- renderPlan ----------

describe("renderPlan", () => {
  function fullDriftSnap(): DriftSnapshot {
    return {
      oldTmpdir: "/tmp/atmux_tmux_old",
      newTmpdir: "/tmp/atmux_tmux_new",
      oldSess: "old",
      staleWindows: ["__old__alice", "__old__bob"],
      oldStateContent: "old",
      cageAlive: true,
    };
  }

  test("all 6 steps render with mv + rename + window list + state sync", () => {
    const snap = fullDriftSnap();
    const flags: DriftFlags = {
      needsTmpdirMv: true,
      needsSessionRename: true,
      needsWindowRename: true,
      needsStateSync: true,
    };
    const lines = renderPlan(snap, flags, "new");
    const text = lines.map((l) => l.body).join("\n");
    expect(text).toContain("mv  /tmp/atmux_tmux_old → /tmp/atmux_tmux_new");
    expect(text).toContain("tmux rename-session  old → new");
    expect(text).toContain("__old__alice → __new__alice");
    expect(text).toContain("__old__bob → __new__bob");
    expect(text).toContain("team.json:.tmuxTmpdir = /tmp/atmux_tmux_new");
    expect(text).toContain("cron-block install DEFERRED");
    expect(text).toContain(".atmux/state/session.txt: old → new");
  });

  test("converged state — renders ✅ markers per step", () => {
    const snap: DriftSnapshot = {
      oldTmpdir: "/tmp/atmux_tmux_new",
      newTmpdir: "/tmp/atmux_tmux_new",
      oldSess: "new",
      staleWindows: [],
      oldStateContent: "new",
      cageAlive: true,
    };
    const flags: DriftFlags = {
      needsTmpdirMv: false,
      needsSessionRename: false,
      needsWindowRename: false,
      needsStateSync: false,
    };
    const lines = renderPlan(snap, flags, "new");
    const text = lines.map((l) => l.body).join("\n");
    expect(text).toContain("tmpdir already at /tmp/atmux_tmux_new ✅");
    expect(text).toContain('cage session already "new" ✅');
    expect(text).toContain("no stale __<old>__* windows ✅");
    expect(text).toContain('state/session.txt already "new" ✅');
  });

  test("cage down — step 2 marks 'no live cage'", () => {
    const snap: DriftSnapshot = {
      oldTmpdir: "/tmp/atmux_tmux_new",
      newTmpdir: "/tmp/atmux_tmux_new",
      oldSess: null,
      staleWindows: [],
      oldStateContent: null,
      cageAlive: false,
    };
    const flags: DriftFlags = {
      needsTmpdirMv: false,
      needsSessionRename: false,
      needsWindowRename: false,
      needsStateSync: false,
    };
    const lines = renderPlan(snap, flags, "new");
    const text = lines.map((l) => l.body).join("\n");
    expect(text).toContain("no live cage");
  });
});

// ---------- Stub tmux factory ----------

interface StubTmuxCalls {
  renameSession: Array<{ socketPath: string; old: string; current: string }>;
  renameWindow: Array<{ socketPath: string; target: string; name: string }>;
  listSessionsCalls: number;
  listWindowsCalls: string[];
}

interface StubTmuxOpts {
  /** Listed sessions keyed by socketPath. Default: empty list. */
  sessionsBySocket?: Record<string, ReadonlyArray<{ name: string }>>;
  /** Listed windows keyed by socketPath + sessionName. */
  windowsBySocket?: Record<
    string,
    ReadonlyArray<{ index: number; id: string; name: string; active: boolean }>
  >;
  /** Fail rename-session — emit a TmuxError on call. */
  failRenameSession?: boolean;
  /** Fail rename-window for a specific target window name. */
  failRenameWindowFor?: string;
}

function buildStubFactory(opts: StubTmuxOpts): {
  factory: (socketPath: string) => TmuxNamespace;
  calls: StubTmuxCalls;
} {
  const calls: StubTmuxCalls = {
    renameSession: [],
    renameWindow: [],
    listSessionsCalls: 0,
    listWindowsCalls: [],
  };
  const factory = (socketPath: string): TmuxNamespace =>
    ({
      session: {
        async listSessions() {
          calls.listSessionsCalls += 1;
          return [...(opts.sessionsBySocket?.[socketPath] ?? [])].map((s) => ({
            name: s.name,
            windows: 0,
            created: 0,
          }));
        },
        async renameSession(oldName: string, newName: string) {
          if (opts.failRenameSession) {
            throw new Error("rename-session boom");
          }
          calls.renameSession.push({ socketPath, old: oldName, current: newName });
        },
      },
      window: {
        async listWindows(sessionName: string) {
          calls.listWindowsCalls.push(`${socketPath}:${sessionName}`);
          return [...(opts.windowsBySocket?.[socketPath] ?? [])];
        },
        async renameWindow(target: string, name: string) {
          if (opts.failRenameWindowFor !== undefined && opts.failRenameWindowFor === name) {
            throw new Error(`rename-window boom for ${name}`);
          }
          calls.renameWindow.push({ socketPath, target: String(target), name });
        },
      },
    }) as unknown as TmuxNamespace;
  return { factory, calls };
}

// ---------- Filesystem fixture ----------

interface Fixture {
  atmuxDir: string;
  teamJsonPath: string;
  stateFile: string;
  oldTmpdir: string;
  cleanup: () => Promise<void>;
}

async function buildFixture(opts: {
  teamName: string;
  oldTmpdir: string;
  /** Pre-create the old tmpdir so step 1's rename has a source. */
  createOldTmpdir?: boolean;
  /** Initial state/session.txt content. */
  stateContent?: string;
}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "atmux-repair-rename-"));
  const atmuxDir = join(root, ".atmux");
  await mkdir(join(atmuxDir, "state"), { recursive: true });
  const teamJsonPath = join(atmuxDir, "team.json");
  const team = {
    name: opts.teamName,
    members: [],
    tmuxTmpdir: opts.oldTmpdir,
  };
  await writeFile(teamJsonPath, JSON.stringify(team, null, 2));
  if (opts.createOldTmpdir === true) {
    await mkdir(opts.oldTmpdir, { recursive: true });
  }
  const stateFile = join(atmuxDir, "state", "session.txt");
  if (opts.stateContent !== undefined) {
    await writeFile(stateFile, opts.stateContent);
  }
  return {
    atmuxDir,
    teamJsonPath,
    stateFile,
    oldTmpdir: opts.oldTmpdir,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
      // Best-effort cleanup of newTmpdir if step 1 ran.
      const newTmpdir = newTmpdirFor(opts.teamName);
      await rm(newTmpdir, { recursive: true, force: true });
      await rm(opts.oldTmpdir, { recursive: true, force: true });
    },
  };
}

// ---------- probeDrift ----------

describe("probeDrift", () => {
  let fixture: Fixture;
  afterEach(async () => {
    await fixture?.cleanup();
  });

  test("team.json missing → ConfigError", async () => {
    const root = await mkdtemp(join(tmpdir(), "atmux-repair-probe-missing-"));
    fixture = {
      atmuxDir: join(root, ".atmux"),
      teamJsonPath: join(root, ".atmux", "team.json"),
      stateFile: "",
      oldTmpdir: "",
      async cleanup() {
        await rm(root, { recursive: true, force: true });
      },
    };
    await mkdir(fixture.atmuxDir, { recursive: true });
    const { factory } = buildStubFactory({});
    await expect(
      probeDrift(fixture.atmuxDir, "acme", {
        tmux: factory("/x"),
        buildTmuxAtSocket: factory,
      }),
    ).rejects.toThrow(ConfigError);
  });

  test("team.json:.name mismatch vs arg → ConfigError", async () => {
    fixture = await buildFixture({
      teamName: "real",
      oldTmpdir: `/tmp/atmux_tmux_repair_test_${Date.now()}_a`,
    });
    const { factory } = buildStubFactory({});
    await expect(
      probeDrift(fixture.atmuxDir, "wrong", {
        tmux: factory("/x"),
        buildTmuxAtSocket: factory,
      }),
    ).rejects.toThrow(/team\.json:\.name='real' but arg says 'wrong'/);
  });

  test("team.json:.tmuxTmpdir empty → ConfigError (bun-native team)", async () => {
    fixture = await buildFixture({ teamName: "acme", oldTmpdir: "" });
    const { factory } = buildStubFactory({});
    await expect(
      probeDrift(fixture.atmuxDir, "acme", {
        tmux: factory("/x"),
        buildTmuxAtSocket: factory,
      }),
    ).rejects.toThrow(/has no \.tmuxTmpdir/);
  });

  test("no live cage + matching state → snapshot with cageAlive=false", async () => {
    const oldTmpdir = `/tmp/atmux_tmux_repair_test_${Date.now()}_nocage`;
    fixture = await buildFixture({
      teamName: "acme",
      oldTmpdir,
      createOldTmpdir: false,
      stateContent: "acme\n",
    });
    const { factory } = buildStubFactory({});
    const snap = await probeDrift(fixture.atmuxDir, "acme", {
      tmux: factory("/x"),
      buildTmuxAtSocket: factory,
    });
    expect(snap.cageAlive).toBe(false);
    expect(snap.oldSess).toBeNull();
    expect(snap.staleWindows).toEqual([]);
    expect(snap.oldTmpdir).toBe(oldTmpdir);
    expect(snap.newTmpdir).toBe("/tmp/atmux_tmux_acme");
    expect(snap.oldStateContent).toBe("acme");
  });

  test("live cage with stale session + windows → captures both", async () => {
    const oldTmpdir = `/tmp/atmux_tmux_repair_test_${Date.now()}_live`;
    fixture = await buildFixture({
      teamName: "new",
      oldTmpdir,
      createOldTmpdir: true,
    });
    // Pre-create the tmux-<uid>/default socket-path so probeDrift's
    // `exists` check passes — we use a regular file as a placeholder.
    const uid = process.getuid?.() ?? 0;
    const sockDir = join(oldTmpdir, `tmux-${uid}`);
    await mkdir(sockDir, { recursive: true });
    await writeFile(join(sockDir, "default"), "");
    const oldSocketPath = join(sockDir, "default");

    const { factory } = buildStubFactory({
      sessionsBySocket: { [oldSocketPath]: [{ name: "old" }] },
      windowsBySocket: {
        [oldSocketPath]: [
          { index: 0, id: "@0", name: "__old__alice", active: false },
          { index: 1, id: "@1", name: "__old__bob", active: false },
          { index: 2, id: "@2", name: "__new__keeper", active: false },
          { index: 3, id: "@3", name: "plain", active: false },
        ],
      },
    });

    const snap = await probeDrift(fixture.atmuxDir, "new", {
      tmux: factory("/x"),
      buildTmuxAtSocket: factory,
    });
    expect(snap.cageAlive).toBe(true);
    expect(snap.oldSess).toBe("old");
    expect(snap.staleWindows).toEqual(["__old__alice", "__old__bob"]);
  });
});

// ---------- applyRepair ----------

describe("applyRepair", () => {
  let fixture: Fixture;
  afterEach(async () => {
    await fixture?.cleanup();
  });

  test("happy path — all 4 mutating steps applied + commit recorded", async () => {
    const oldTmpdir = `/tmp/atmux_tmux_repair_test_${Date.now()}_happy`;
    fixture = await buildFixture({
      teamName: "new",
      oldTmpdir,
      createOldTmpdir: true,
      stateContent: "old\n",
    });
    const newTmpdir = "/tmp/atmux_tmux_new";
    const uid = process.getuid?.() ?? 0;
    const newSocketPath = join(newTmpdir, `tmux-${uid}`, "default");
    const { factory, calls } = buildStubFactory({
      windowsBySocket: {
        [newSocketPath]: [{ index: 0, id: "@10", name: "__old__alice", active: false }],
      },
    });
    const snap: DriftSnapshot = {
      oldTmpdir,
      newTmpdir,
      oldSess: "old",
      staleWindows: ["__old__alice"],
      oldStateContent: "old",
      cageAlive: true,
    };
    const flags: DriftFlags = {
      needsTmpdirMv: true,
      needsSessionRename: true,
      needsWindowRename: true,
      needsStateSync: true,
    };
    const stderrCalls: string[] = [];
    const result = await applyRepair(fixture.atmuxDir, "new", snap, flags, {
      tmux: factory("/x"),
      buildTmuxAtSocket: factory,
      stderr: (s) => {
        stderrCalls.push(s);
        return true;
      },
    });
    expect(result.rolledBack).toBe(false);
    expect(result.appliedSteps).toEqual([1, 2, 3, 4, 6]);
    // Step 1: dir moved.
    expect(await dirExists(newTmpdir)).toBe(true);
    expect(await dirExists(oldTmpdir)).toBe(false);
    // Step 2: rename-session called.
    expect(calls.renameSession).toHaveLength(1);
    expect(calls.renameSession[0]).toMatchObject({ old: "old", current: "new" });
    // Step 3: rename-window called with the windowId from listWindows.
    expect(calls.renameWindow).toHaveLength(1);
    expect(calls.renameWindow[0]).toMatchObject({
      target: "@10",
      name: "__new__alice",
    });
    // Step 4: team.json updated.
    const updated = JSON.parse(await readFile(fixture.teamJsonPath, "utf8"));
    expect(updated.tmuxTmpdir).toBe(newTmpdir);
    // Step 5: warn emitted to stderr.
    expect(stderrCalls.some((s) => s.includes("DEFERRED"))).toBe(true);
    // Step 6: state file rewritten.
    expect(await readFile(fixture.stateFile, "utf8")).toBe("new\n");
  });

  test("no-op when no flags set — emits step-5 warn only", async () => {
    const oldTmpdir = `/tmp/atmux_tmux_repair_test_${Date.now()}_noop`;
    fixture = await buildFixture({ teamName: "acme", oldTmpdir });
    const { factory } = buildStubFactory({});
    const snap: DriftSnapshot = {
      oldTmpdir: "/tmp/atmux_tmux_acme",
      newTmpdir: "/tmp/atmux_tmux_acme",
      oldSess: null,
      staleWindows: [],
      oldStateContent: null,
      cageAlive: false,
    };
    const flags: DriftFlags = {
      needsTmpdirMv: false,
      needsSessionRename: false,
      needsWindowRename: false,
      needsStateSync: false,
    };
    // The flags ARE all false here, but applyRepair still runs step 4
    // (team.json:.tmuxTmpdir = newTmpdir) unconditionally since the
    // declarative state should converge regardless of flags — mirrors
    // bash spec line 283-287. This is "always-write" semantics.
    const stderrCalls: string[] = [];
    const result = await applyRepair(fixture.atmuxDir, "acme", snap, flags, {
      tmux: factory("/x"),
      buildTmuxAtSocket: factory,
      stderr: (s) => {
        stderrCalls.push(s);
        return true;
      },
    });
    expect(result.rolledBack).toBe(false);
    expect(result.appliedSteps).toEqual([4]);
  });

  test("step 1 refuses to clobber existing target → no rollback (pre-step-1 abort)", async () => {
    const oldTmpdir = `/tmp/atmux_tmux_repair_test_${Date.now()}_clobber`;
    fixture = await buildFixture({
      teamName: "new",
      oldTmpdir,
      createOldTmpdir: true,
    });
    // Pre-create the target so step 1 trips the clobber-guard.
    const newTmpdir = "/tmp/atmux_tmux_new";
    await mkdir(newTmpdir, { recursive: true });
    try {
      const { factory } = buildStubFactory({});
      const snap: DriftSnapshot = {
        oldTmpdir,
        newTmpdir,
        oldSess: null,
        staleWindows: [],
        oldStateContent: null,
        cageAlive: false,
      };
      const flags: DriftFlags = {
        needsTmpdirMv: true,
        needsSessionRename: false,
        needsWindowRename: false,
        needsStateSync: false,
      };
      const result = await applyRepair(fixture.atmuxDir, "new", snap, flags, {
        tmux: factory("/x"),
        buildTmuxAtSocket: factory,
        stderr: () => true,
      });
      expect(result.rolledBack).toBe(false);
      expect(result.appliedSteps).toEqual([]);
      expect(result.reason).toContain("already exists");
      // Old tmpdir untouched.
      expect(await dirExists(oldTmpdir)).toBe(true);
    } finally {
      await rm(newTmpdir, { recursive: true, force: true });
    }
  });

  test("step 2 failure rolls back step 1 (mv reverses)", async () => {
    const oldTmpdir = `/tmp/atmux_tmux_repair_test_${Date.now()}_rb_s2`;
    fixture = await buildFixture({
      teamName: "new",
      oldTmpdir,
      createOldTmpdir: true,
    });
    const newTmpdir = "/tmp/atmux_tmux_new";
    const { factory } = buildStubFactory({ failRenameSession: true });
    const snap: DriftSnapshot = {
      oldTmpdir,
      newTmpdir,
      oldSess: "old",
      staleWindows: [],
      oldStateContent: null,
      cageAlive: true,
    };
    const flags: DriftFlags = {
      needsTmpdirMv: true,
      needsSessionRename: true,
      needsWindowRename: false,
      needsStateSync: false,
    };
    const result = await applyRepair(fixture.atmuxDir, "new", snap, flags, {
      tmux: factory("/x"),
      buildTmuxAtSocket: factory,
      stderr: () => true,
    });
    expect(result.rolledBack).toBe(true);
    // mv was rolled back — old tmpdir back, new tmpdir gone.
    expect(await dirExists(oldTmpdir)).toBe(true);
    expect(await dirExists(newTmpdir)).toBe(false);
  });

  test("step 3 missing window-id → rollback fires", async () => {
    const oldTmpdir = `/tmp/atmux_tmux_repair_test_${Date.now()}_rb_s3`;
    fixture = await buildFixture({
      teamName: "new",
      oldTmpdir,
      createOldTmpdir: true,
    });
    const newTmpdir = "/tmp/atmux_tmux_new";
    const uid = process.getuid?.() ?? 0;
    const newSocketPath = join(newTmpdir, `tmux-${uid}`, "default");
    // listWindows returns NOTHING — declared stale window has vanished.
    const { factory } = buildStubFactory({
      windowsBySocket: { [newSocketPath]: [] },
    });
    const snap: DriftSnapshot = {
      oldTmpdir,
      newTmpdir,
      oldSess: null,
      staleWindows: ["__old__alice"],
      oldStateContent: null,
      cageAlive: true,
    };
    const flags: DriftFlags = {
      needsTmpdirMv: true,
      needsSessionRename: false,
      needsWindowRename: true,
      needsStateSync: false,
    };
    const result = await applyRepair(fixture.atmuxDir, "new", snap, flags, {
      tmux: factory("/x"),
      buildTmuxAtSocket: factory,
      stderr: () => true,
    });
    expect(result.rolledBack).toBe(true);
    expect(result.reason).toContain("vanished mid-rename");
    expect(await dirExists(oldTmpdir)).toBe(true);
    expect(await dirExists(newTmpdir)).toBe(false);
  });

  test("step 1 mv failure when source absent → no rollback, reason captures mv error", async () => {
    const oldTmpdir = `/tmp/atmux_tmux_repair_test_${Date.now()}_nosrc`;
    fixture = await buildFixture({
      teamName: "new",
      oldTmpdir,
      // createOldTmpdir omitted → ENOENT on mv.
    });
    const newTmpdir = "/tmp/atmux_tmux_new";
    const { factory } = buildStubFactory({});
    const snap: DriftSnapshot = {
      oldTmpdir,
      newTmpdir,
      oldSess: null,
      staleWindows: [],
      oldStateContent: null,
      cageAlive: false,
    };
    const flags: DriftFlags = {
      needsTmpdirMv: true,
      needsSessionRename: false,
      needsWindowRename: false,
      needsStateSync: false,
    };
    const result = await applyRepair(fixture.atmuxDir, "new", snap, flags, {
      tmux: factory("/x"),
      buildTmuxAtSocket: factory,
      stderr: () => true,
    });
    expect(result.rolledBack).toBe(false);
    expect(result.appliedSteps).toEqual([]);
    expect(result.reason).toMatch(/mv .* failed/);
  });

  test("step 4 team.json failure rolls back tmpdir + session + windows", async () => {
    const oldTmpdir = `/tmp/atmux_tmux_repair_test_${Date.now()}_rb_s4`;
    fixture = await buildFixture({
      teamName: "new",
      oldTmpdir,
      createOldTmpdir: true,
    });
    // Replace team.json with a directory to cause readTextOrNull to
    // return null inside mutateTeamJsonTmpdir → throws.
    await rm(fixture.teamJsonPath);
    await mkdir(fixture.teamJsonPath, { recursive: true });
    try {
      const newTmpdir = "/tmp/atmux_tmux_new";
      const uid = process.getuid?.() ?? 0;
      const newSocketPath = join(newTmpdir, `tmux-${uid}`, "default");
      const { factory, calls } = buildStubFactory({
        windowsBySocket: {
          [newSocketPath]: [{ index: 0, id: "@10", name: "__old__alice", active: false }],
        },
      });
      const snap: DriftSnapshot = {
        oldTmpdir,
        newTmpdir,
        oldSess: "old",
        staleWindows: ["__old__alice"],
        oldStateContent: null,
        cageAlive: true,
      };
      const flags: DriftFlags = {
        needsTmpdirMv: true,
        needsSessionRename: true,
        needsWindowRename: true,
        needsStateSync: false,
      };
      const result = await applyRepair(fixture.atmuxDir, "new", snap, flags, {
        tmux: factory("/x"),
        buildTmuxAtSocket: factory,
        stderr: () => true,
      });
      expect(result.rolledBack).toBe(true);
      expect(result.reason).toContain("team.json:.tmuxTmpdir update failed");
      // Rollback ran: window + session + tmpdir all reverted.
      const renames = calls.renameWindow.map((c) => c.name);
      expect(renames).toContain("__old__alice"); // window revert (line 391-394)
      const sessRenames = calls.renameSession.map((c) => c.current);
      expect(sessRenames).toContain("old"); // session revert (line 386-389)
      expect(await dirExists(oldTmpdir)).toBe(true);
      expect(await dirExists(newTmpdir)).toBe(false);
    } finally {
      // Restore team.json (dir) so cleanup rm -rf works.
      await rm(fixture.teamJsonPath, { recursive: true, force: true });
    }
  });

  test("step 6 state-file failure rolls back team.json + tmpdir", async () => {
    const oldTmpdir = `/tmp/atmux_tmux_repair_test_${Date.now()}_rb_s6`;
    fixture = await buildFixture({
      teamName: "new",
      oldTmpdir,
      createOldTmpdir: true,
      stateContent: "old\n",
    });
    // Replace state file with a directory to make atomicWrite fail.
    await rm(fixture.stateFile);
    await mkdir(fixture.stateFile, { recursive: true });
    try {
      const newTmpdir = "/tmp/atmux_tmux_new";
      const { factory } = buildStubFactory({});
      const snap: DriftSnapshot = {
        oldTmpdir,
        newTmpdir,
        oldSess: null,
        staleWindows: [],
        oldStateContent: "old",
        cageAlive: false,
      };
      const flags: DriftFlags = {
        needsTmpdirMv: true,
        needsSessionRename: false,
        needsWindowRename: false,
        needsStateSync: true,
      };
      const result = await applyRepair(fixture.atmuxDir, "new", snap, flags, {
        tmux: factory("/x"),
        buildTmuxAtSocket: factory,
        stderr: () => true,
      });
      expect(result.rolledBack).toBe(true);
      expect(result.reason).toContain("state/session.txt write failed");
      // team.json reverted (line 396-400 hit).
      const tj = JSON.parse(await readFile(fixture.teamJsonPath, "utf8"));
      expect(tj.tmuxTmpdir).toBe(oldTmpdir);
      // tmpdir reverted.
      expect(await dirExists(oldTmpdir)).toBe(true);
      expect(await dirExists(newTmpdir)).toBe(false);
    } finally {
      await rm(fixture.stateFile, { recursive: true, force: true });
    }
  });

  test("step 3 rename-window failure → window already-renamed reverts + tmpdir mv reverts", async () => {
    const oldTmpdir = `/tmp/atmux_tmux_repair_test_${Date.now()}_rb_s3b`;
    fixture = await buildFixture({
      teamName: "new",
      oldTmpdir,
      createOldTmpdir: true,
    });
    const newTmpdir = "/tmp/atmux_tmux_new";
    const uid = process.getuid?.() ?? 0;
    const newSocketPath = join(newTmpdir, `tmux-${uid}`, "default");
    const { factory, calls } = buildStubFactory({
      windowsBySocket: {
        [newSocketPath]: [
          { index: 0, id: "@10", name: "__old__alice", active: false },
          { index: 1, id: "@11", name: "__old__bob", active: false },
        ],
      },
      // Fail on the second rename — first one (alice) succeeds.
      failRenameWindowFor: "__new__bob",
    });
    const snap: DriftSnapshot = {
      oldTmpdir,
      newTmpdir,
      oldSess: null,
      staleWindows: ["__old__alice", "__old__bob"],
      oldStateContent: null,
      cageAlive: true,
    };
    const flags: DriftFlags = {
      needsTmpdirMv: true,
      needsSessionRename: false,
      needsWindowRename: true,
      needsStateSync: false,
    };
    const result = await applyRepair(fixture.atmuxDir, "new", snap, flags, {
      tmux: factory("/x"),
      buildTmuxAtSocket: factory,
      stderr: () => true,
    });
    expect(result.rolledBack).toBe(true);
    // Two renames recorded: alice forward, alice rollback (best-effort).
    const renames = calls.renameWindow.map((c) => c.name);
    expect(renames).toContain("__new__alice");
    expect(renames).toContain("__old__alice"); // rollback step
    // mv reverted.
    expect(await dirExists(oldTmpdir)).toBe(true);
  });
});

// ---------- teamRepairRename (top-level verb) ----------

describe("teamRepairRename", () => {
  let fixture: Fixture;
  afterEach(async () => {
    await fixture?.cleanup();
  });

  test("missing team arg → UsageError", async () => {
    await expect(teamRepairRename([])).rejects.toThrow(UsageError);
  });

  test("converged team → no-op exit 0", async () => {
    fixture = await buildFixture({
      teamName: "acme",
      // Pretend already converged: tmpdir IS the V1 target.
      oldTmpdir: "/tmp/atmux_tmux_acme",
      stateContent: "acme\n",
    });
    const { factory } = buildStubFactory({});
    const outStr: string[] = [];
    const errStr: string[] = [];
    const code = await teamRepairRename(["--team-dir", join(fixture.atmuxDir, ".."), "acme"], {
      buildTmux: factory,
      stdout: (s) => {
        outStr.push(s);
        return true;
      },
      stderr: (s) => {
        errStr.push(s);
        return true;
      },
    });
    expect(code).toBe(0);
    expect(outStr.join("")).toContain("already converged");
  });

  test("--dry-run prints plan and exits 0 without mutation", async () => {
    const oldTmpdir = `/tmp/atmux_tmux_repair_dryrun_${Date.now()}`;
    fixture = await buildFixture({
      teamName: "new",
      oldTmpdir,
      createOldTmpdir: true,
      stateContent: "old\n",
    });
    const { factory } = buildStubFactory({});
    const outStr: string[] = [];
    const errStr: string[] = [];
    const code = await teamRepairRename(
      ["--team-dir", join(fixture.atmuxDir, ".."), "--dry-run", "new"],
      {
        buildTmux: factory,
        stdout: (s) => {
          outStr.push(s);
          return true;
        },
        stderr: (s) => {
          errStr.push(s);
          return true;
        },
      },
    );
    expect(code).toBe(0);
    expect(outStr.join("")).toContain("--dry-run — no changes applied");
    expect(errStr.join("")).toContain("plan for");
    // Old tmpdir untouched.
    expect(await dirExists(oldTmpdir)).toBe(true);
    expect(await dirExists("/tmp/atmux_tmux_new")).toBe(false);
    // team.json untouched.
    const tj = JSON.parse(await readFile(fixture.teamJsonPath, "utf8"));
    expect(tj.tmuxTmpdir).toBe(oldTmpdir);
  });

  test("full apply path — exit 0, state files mutated, success message emitted", async () => {
    const oldTmpdir = `/tmp/atmux_tmux_repair_apply_${Date.now()}`;
    fixture = await buildFixture({
      teamName: "new",
      oldTmpdir,
      createOldTmpdir: true,
      stateContent: "old\n",
    });
    // Listing the new socket returns empty windows — no stale-window
    // probe drift; just tmpdir + state-sync drift.
    const { factory } = buildStubFactory({});
    const outStr: string[] = [];
    const code = await teamRepairRename(["--team-dir", join(fixture.atmuxDir, ".."), "new"], {
      buildTmux: factory,
      stdout: (s) => {
        outStr.push(s);
        return true;
      },
      stderr: () => true,
    });
    expect(code).toBe(0);
    expect(outStr.join("")).toContain("converged");
    // Side-effects landed.
    expect(await dirExists("/tmp/atmux_tmux_new")).toBe(true);
    expect(await dirExists(oldTmpdir)).toBe(false);
    const tj = JSON.parse(await readFile(fixture.teamJsonPath, "utf8"));
    expect(tj.tmuxTmpdir).toBe("/tmp/atmux_tmux_new");
    expect(await readFile(fixture.stateFile, "utf8")).toBe("new\n");
  });

  test("apply failure → exit 1, reason on stderr", async () => {
    const oldTmpdir = `/tmp/atmux_tmux_repair_failure_${Date.now()}`;
    fixture = await buildFixture({
      teamName: "new",
      oldTmpdir,
      createOldTmpdir: true,
    });
    // Pre-occupy target so step 1 trips clobber guard.
    await mkdir("/tmp/atmux_tmux_new", { recursive: true });
    try {
      const { factory } = buildStubFactory({});
      const errStr: string[] = [];
      const code = await teamRepairRename(["--team-dir", join(fixture.atmuxDir, ".."), "new"], {
        buildTmux: factory,
        stdout: () => true,
        stderr: (s) => {
          errStr.push(s);
          return true;
        },
      });
      expect(code).toBe(1);
      expect(errStr.join("")).toContain("already exists");
    } finally {
      await rm("/tmp/atmux_tmux_new", { recursive: true, force: true });
    }
  });
});

// ---------- defaultBuildTmux ----------

describe("defaultBuildTmux", () => {
  test("returns a TmuxNamespace pinned to the supplied socketPath", () => {
    const ns = defaultBuildTmux("/tmp/atmux-team-repair-rename-defaultbuildtmux-noop/sock");
    expect(typeof ns.window.listWindows).toBe("function");
    expect(typeof ns.session.renameSession).toBe("function");
    expect(typeof ns.window.renameWindow).toBe("function");
  });
});

// ---------- helpers ----------

async function dirExists(path: string): Promise<boolean> {
  try {
    const { stat } = await import("node:fs/promises");
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}
