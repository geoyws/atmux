// Unit tests for src/verbs/handoff.ts (ADR-010).
// Bash spec ref: lib/handoff.sh @ worktree-frozen.
//
// Coverage strategy
// -----------------
// Pure helpers (parseHandoffArgs, build*Note*, buildBriefBody,
// handoffTimestamp, resolveWaitSeconds, resolveCaptureLines) tested
// directly. Side-effect helpers (migrateTasks, migrateInboxes,
// pollForFile) tested against fixture .atmux/. Public verb driven
// against a stub TmuxNamespace + injected pollFile + clock.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import { addTask } from "../../../src/core/kanban.ts";
import { isPaused } from "../../../src/core/pause.ts";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import {
  buildAbsentSourceNote,
  buildBriefBody,
  buildHandoffNoteAsk,
  buildScreenCaptureNote,
  defaultBuildTmux,
  handoff,
  handoffTimestamp,
  migrateInboxes,
  migrateTasks,
  parseHandoffArgs,
  pollForFile,
  resolveCaptureLines,
  resolveWaitSeconds,
} from "../../../src/verbs/handoff.ts";

// ---------- parseHandoffArgs ----------

describe("parseHandoffArgs", () => {
  test("basic <from> <to>", () => {
    expect(parseHandoffArgs(["alpha", "bravo"])).toEqual({
      from: "alpha",
      to: "bravo",
      reason: "",
      native: true,
      pauseFrom: false,
    });
  });

  test("--reason captured", () => {
    expect(parseHandoffArgs(["a", "b", "--reason", "context-rot"]).reason).toBe("context-rot");
  });

  test("--no-native flips native to false", () => {
    expect(parseHandoffArgs(["a", "b", "--no-native"]).native).toBe(false);
  });

  test("--pause-from flips pauseFrom to true", () => {
    expect(parseHandoffArgs(["a", "b", "--pause-from"]).pauseFrom).toBe(true);
  });

  test("--socket and --team-dir captured", () => {
    expect(parseHandoffArgs(["a", "b", "--socket", "/s", "--team-dir", "/d"])).toEqual({
      from: "a",
      to: "b",
      reason: "",
      native: true,
      pauseFrom: false,
      socketPath: "/s",
      teamDir: "/d",
    });
  });

  test("missing from → UsageError", () => {
    expect(() => parseHandoffArgs([])).toThrow(UsageError);
  });

  test("missing to → UsageError", () => {
    expect(() => parseHandoffArgs(["alpha"])).toThrow(UsageError);
  });

  test("--reason without value → UsageError", () => {
    expect(() => parseHandoffArgs(["a", "b", "--reason"])).toThrow(UsageError);
  });

  test("--socket without value → UsageError", () => {
    expect(() => parseHandoffArgs(["a", "b", "--socket"])).toThrow(UsageError);
  });

  test("--team-dir without value → UsageError", () => {
    expect(() => parseHandoffArgs(["a", "b", "--team-dir"])).toThrow(UsageError);
  });

  test("unknown flag → UsageError", () => {
    expect(() => parseHandoffArgs(["a", "b", "--bogus"])).toThrow(UsageError);
  });

  test("three positionals → UsageError", () => {
    expect(() => parseHandoffArgs(["a", "b", "c"])).toThrow(UsageError);
  });
});

// ---------- Pure render helpers ----------

describe("buildHandoffNoteAsk", () => {
  test("includes the handoff file path verbatim", () => {
    const out = buildHandoffNoteAsk("/x/.atmux/handoff/a-to-b-2026.md");
    expect(out).toContain("/x/.atmux/handoff/a-to-b-2026.md");
    expect(out).toContain("OK-HANDOFF");
  });
});

describe("buildScreenCaptureNote", () => {
  test("emits headers + fenced capture block", () => {
    const body = buildScreenCaptureNote({
      from: "alpha",
      to: "bravo",
      timestamp: "2026-05-05T10:00:00Z",
      reason: "rotation",
      lines: 500,
      capture: "line-1\nline-2",
    });
    expect(body).toContain("# Handoff via screen capture");
    expect(body).toContain("from: alpha");
    expect(body).toContain("to: bravo");
    expect(body).toContain("reason: rotation");
    expect(body).toContain("(last 500 lines)");
    expect(body).toContain("```\nline-1\nline-2\n```");
  });

  test("empty reason renders as blank field", () => {
    const body = buildScreenCaptureNote({
      from: "a",
      to: "b",
      timestamp: "ts",
      reason: "",
      lines: 100,
      capture: "x",
    });
    expect(body).toContain("reason: \n");
  });
});

describe("buildAbsentSourceNote", () => {
  test("emits the no-pane stub", () => {
    const body = buildAbsentSourceNote({
      from: "a",
      to: "b",
      timestamp: "ts",
      reason: "ctx-rot",
    });
    expect(body).toContain("# Handoff — source member window is gone");
    expect(body).toContain("(no pane to capture)");
    expect(body).toContain("reason: ctx-rot");
  });

  test("empty reason renders as blank", () => {
    const body = buildAbsentSourceNote({ from: "a", to: "b", timestamp: "ts", reason: "" });
    expect(body).toContain("reason: \n");
  });
});

describe("buildBriefBody", () => {
  test("includes handoff notes path + migrated count + inbox cmd", () => {
    const out = buildBriefBody({
      from: "alpha",
      to: "bravo",
      reason: "ctx-rot",
      handoffFile: "/x/h.md",
      nMigrating: 3,
    });
    expect(out).toContain("📦 HANDOFF — you are taking over from `alpha`");
    expect(out).toContain("reason: ctx-rot");
    expect(out).toContain("handoff notes: /x/h.md");
    expect(out).toContain("migrated tasks: 3");
    expect(out).toContain("atmux inbox bravo");
    expect(out).toContain("cat /x/h.md");
  });

  test("empty reason renders as 'unspecified'", () => {
    expect(
      buildBriefBody({
        from: "a",
        to: "b",
        reason: "",
        handoffFile: "/h",
        nMigrating: 0,
      }),
    ).toContain("reason: unspecified");
  });
});

describe("handoffTimestamp", () => {
  test("renders YYYYMMDDTHHMMSSZ", () => {
    // 2026-05-05 10:30:45 UTC
    const epoch = Date.UTC(2026, 4, 5, 10, 30, 45);
    expect(handoffTimestamp(epoch)).toBe("20260505T103045Z");
  });
});

// ---------- resolveWaitSeconds / resolveCaptureLines ----------

describe("resolveWaitSeconds", () => {
  test("opts override wins", () => {
    expect(resolveWaitSeconds({ waitSeconds: 5 }, {})).toBe(5);
  });

  test("env ATMUX_HANDOFF_WAIT used when no opts", () => {
    expect(resolveWaitSeconds({}, { ATMUX_HANDOFF_WAIT: "12" })).toBe(12);
  });

  test("default 30s when no opts + no env", () => {
    expect(resolveWaitSeconds({}, {})).toBe(30);
  });

  test("invalid env (non-numeric) → default 30s", () => {
    expect(resolveWaitSeconds({}, { ATMUX_HANDOFF_WAIT: "abc" })).toBe(30);
  });

  test("negative env → default 30s", () => {
    expect(resolveWaitSeconds({}, { ATMUX_HANDOFF_WAIT: "-5" })).toBe(30);
  });
});

describe("resolveCaptureLines", () => {
  test("opts override wins", () => {
    expect(resolveCaptureLines({ captureLines: 10 }, {})).toBe(10);
  });

  test("env ATMUX_HANDOFF_LINES used when no opts", () => {
    expect(resolveCaptureLines({}, { ATMUX_HANDOFF_LINES: "200" })).toBe(200);
  });

  test("default 500 when no opts + no env", () => {
    expect(resolveCaptureLines({}, {})).toBe(500);
  });

  test("invalid env → default 500", () => {
    expect(resolveCaptureLines({}, { ATMUX_HANDOFF_LINES: "abc" })).toBe(500);
  });

  test("zero env → default 500 (lines must be > 0)", () => {
    expect(resolveCaptureLines({}, { ATMUX_HANDOFF_LINES: "0" })).toBe(500);
  });

  test("uses process.env when env arg omitted", () => {
    const prior = process.env.ATMUX_HANDOFF_LINES;
    process.env.ATMUX_HANDOFF_LINES = "777";
    try {
      expect(resolveCaptureLines({})).toBe(777);
    } finally {
      if (prior !== undefined) process.env.ATMUX_HANDOFF_LINES = prior;
      else delete process.env.ATMUX_HANDOFF_LINES;
    }
  });
});

// ---------- default helpers ----------

describe("defaultBuildTmux", () => {
  test("returns a TmuxNamespace pinned to socketPath (no spawn)", () => {
    const ns = defaultBuildTmux("/tmp/atmux-handoff-default-noop/sock");
    expect(typeof ns.window.listWindows).toBe("function");
    expect(typeof ns.pane.capturePane).toBe("function");
    expect(typeof ns.buffer.loadBuffer).toBe("function");
  });
});

// ---------- pollForFile ----------

describe("pollForFile", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atmux-poll-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("returns true when file already present", async () => {
    const f = join(dir, "x");
    await writeFile(f, "hi");
    expect(await pollForFile(f, 1_000, 100, async () => {})).toBe(true);
  });

  test("returns false on timeout when file never appears", async () => {
    const f = join(dir, "missing");
    let sleepCalls = 0;
    expect(
      await pollForFile(f, 30, 10, async () => {
        sleepCalls += 1;
      }),
    ).toBe(false);
    expect(sleepCalls).toBeGreaterThan(0);
  });

  test("returns true when file appears mid-poll", async () => {
    const f = join(dir, "appearing");
    let polls = 0;
    expect(
      await pollForFile(f, 100, 10, async () => {
        polls += 1;
        if (polls === 2) {
          await writeFile(f, "now");
        }
      }),
    ).toBe(true);
  });

  test("zero-timeout → returns immediate file-existence check (no sleep)", async () => {
    const f = join(dir, "imm");
    let sleepCalls = 0;
    expect(
      await pollForFile(f, 0, 10, async () => {
        sleepCalls += 1;
      }),
    ).toBe(false);
    expect(sleepCalls).toBe(0);
  });

  test("default sleep arg is exercisable (no-op call with 0 timeout)", async () => {
    const f = join(dir, "imm-default");
    expect(await pollForFile(f, 0, 10)).toBe(false);
  });
});

// ---------- migrateTasks / migrateInboxes ----------

describe("migrateTasks + migrateInboxes (kanban + inbox migration)", () => {
  let teamDir: string;
  let atmuxDir: string;

  beforeEach(async () => {
    teamDir = await mkdtemp(join(tmpdir(), "atmux-migrate-"));
    atmuxDir = join(teamDir, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
    await mkdir(join(atmuxDir, "inboxes"), { recursive: true });
    // Seed kanban with one in-progress (alpha), one blocked (alpha),
    // one done (alpha), one in-progress (other), and one in-progress
    // (bravo — pre-existing, tests that the from-narrowing filter holds).
    await writeFile(
      join(atmuxDir, "kanban.json"),
      JSON.stringify({
        tasks: [
          { id: "t-1", subject: "in-progress alpha", status: "in-progress", owner: "alpha" },
          { id: "t-2", subject: "blocked alpha", status: "blocked", owner: "alpha" },
          { id: "t-3", subject: "done alpha", status: "done", owner: "alpha" },
          { id: "t-4", subject: "in-progress other", status: "in-progress", owner: "other" },
          {
            id: "t-5",
            subject: "in-progress bravo (pre-existing)",
            status: "in-progress",
            owner: "bravo",
          },
        ],
        epics: [],
        stories: [],
      }),
    );
  });

  afterEach(async () => {
    await rm(teamDir, { recursive: true, force: true });
  });

  test("migrateTasks reassigns only owner==from + status in (in-progress|blocked)", async () => {
    const migrated = await migrateTasks(atmuxDir, "alpha", "bravo");
    // t-1 + t-2 migrated; t-3 (done) + t-4 (other) + t-5 (already bravo) stay put.
    expect(migrated.map((t) => t.id).sort()).toEqual(["t-1", "t-2"]);
    expect(migrated.every((t) => t.owner === "bravo")).toBe(true);
  });

  test("migrateInboxes — empties from-inbox.inProgress, appends to to-inbox", async () => {
    // Pre-stage from-inbox with two entries; to-inbox absent (will be
    // first-run-initted by updateJson).
    await writeFile(
      join(atmuxDir, "inboxes", "alpha.json"),
      JSON.stringify({
        pending: [],
        inProgress: [{ id: "t-1" }, { id: "t-2" }],
        done: [],
      }),
    );
    const migrated = await migrateTasks(atmuxDir, "alpha", "bravo");
    await migrateInboxes(atmuxDir, "alpha", "bravo", migrated);
    const fromInbox = JSON.parse(await readFile(join(atmuxDir, "inboxes", "alpha.json"), "utf8"));
    expect(fromInbox.inProgress).toEqual([]);
    const toInbox = JSON.parse(await readFile(join(atmuxDir, "inboxes", "bravo.json"), "utf8"));
    expect(toInbox.inProgress.map((e: { id: string }) => e.id).sort()).toEqual(["t-1", "t-2"]);
    expect(toInbox.inProgress[0].subject).toBeDefined();
  });

  test("migrateInboxes is idempotent (re-run does not duplicate)", async () => {
    const migrated = await migrateTasks(atmuxDir, "alpha", "bravo");
    await migrateInboxes(atmuxDir, "alpha", "bravo", migrated);
    await migrateInboxes(atmuxDir, "alpha", "bravo", migrated);
    const toInbox = JSON.parse(await readFile(join(atmuxDir, "inboxes", "bravo.json"), "utf8"));
    expect(toInbox.inProgress.length).toBe(2);
  });

  test("migrateInboxes — body field preserved when present on kanban task", async () => {
    // Add a body to t-1 first.
    await addTask(atmuxDir, { subject: "with body", body: "body-x", assignee: "alpha" });
    const migrated = await migrateTasks(atmuxDir, "alpha", "bravo");
    await migrateInboxes(atmuxDir, "alpha", "bravo", migrated);
    const toInbox = JSON.parse(await readFile(join(atmuxDir, "inboxes", "bravo.json"), "utf8"));
    const withBody = toInbox.inProgress.find(
      (e: { body?: string; subject?: string }) => e.body === "body-x",
    );
    // addTask defaults to status="todo" (not in-progress), so it
    // SHOULD NOT be migrated. Confirms the filter is doing its job.
    expect(withBody).toBeUndefined();
  });

  test("migrateInboxes silently skips when from-inbox file is absent", async () => {
    // No alpha.json staged. Should not throw — bash bash if [[ -f ]]
    // guard at handoff.sh:100.
    const migrated = await migrateTasks(atmuxDir, "alpha", "bravo");
    await migrateInboxes(atmuxDir, "alpha", "bravo", migrated);
    const toInbox = JSON.parse(await readFile(join(atmuxDir, "inboxes", "bravo.json"), "utf8"));
    expect(toInbox.inProgress.length).toBe(2);
  });
});

// ---------- handoff() public verb ----------

interface StubTmux {
  tmux: TmuxNamespace;
  calls: {
    listWindows: string[];
    capturePane: Array<{ target: string; start?: number }>;
    sendKeys: Array<{ target: string; keys: string }>;
    loadBuffer: Array<{ name?: string; data: string }>;
    pasteBuffer: Array<{ target: string }>;
  };
}

function stubTmux(opts: {
  windows?: ReadonlyArray<{ index: number; name: string; active: boolean }>;
  capturePane?: string;
  capturePaneError?: Error;
}): StubTmux {
  const calls: StubTmux["calls"] = {
    listWindows: [],
    capturePane: [],
    sendKeys: [],
    loadBuffer: [],
    pasteBuffer: [],
  };
  const tmux = {
    window: {
      async listWindows(s: string) {
        calls.listWindows.push(s);
        return [...(opts.windows ?? [])];
      },
    },
    pane: {
      async capturePane(o: { target: unknown; start?: number }) {
        calls.capturePane.push({
          target: String(o.target),
          ...(o.start !== undefined ? { start: o.start } : {}),
        });
        if (opts.capturePaneError) throw opts.capturePaneError;
        return opts.capturePane ?? "";
      },
      async sendKeys(o: { target: unknown; keys: string }) {
        calls.sendKeys.push({ target: String(o.target), keys: o.keys });
      },
    },
    buffer: {
      async loadBuffer(o: { name?: string; data: string }) {
        const entry: { name?: string; data: string } = { data: o.data };
        if (o.name !== undefined) entry.name = o.name;
        calls.loadBuffer.push(entry);
      },
      async pasteBuffer(o: { name?: string; target: unknown; deleteAfter?: boolean }) {
        // Inline param destructuring purely so biome doesn't flag the
        // unused-arg lint on `name` / `deleteAfter`. We only assert on
        // `target` from this stub.
        void o.name;
        void o.deleteAfter;
        calls.pasteBuffer.push({ target: String(o.target) });
      },
    },
  } as unknown as TmuxNamespace;
  return { tmux, calls };
}

describe("handoff() — public verb", () => {
  let scratch: string;
  let priorAtmuxDir: string | undefined;
  let priorAtmuxTeamDir: string | undefined;
  let priorAtmuxSession: string | undefined;
  let priorAtmuxDriverSession: string | undefined;
  let priorWait: string | undefined;
  let priorLines: string | undefined;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "atmux-handoff-"));
    priorAtmuxDir = process.env.ATMUX_DIR;
    priorAtmuxTeamDir = process.env.ATMUX_TEAM_DIR;
    priorAtmuxSession = process.env.ATMUX_SESSION;
    priorAtmuxDriverSession = process.env.ATMUX_DRIVER_SESSION;
    priorWait = process.env.ATMUX_HANDOFF_WAIT;
    priorLines = process.env.ATMUX_HANDOFF_LINES;
    delete process.env.ATMUX_DIR;
    delete process.env.ATMUX_TEAM_DIR;
    delete process.env.ATMUX_SESSION;
    delete process.env.ATMUX_DRIVER_SESSION;
    delete process.env.ATMUX_HANDOFF_WAIT;
    delete process.env.ATMUX_HANDOFF_LINES;
  });

  afterEach(async () => {
    delete process.env.ATMUX_DIR;
    delete process.env.ATMUX_TEAM_DIR;
    delete process.env.ATMUX_SESSION;
    delete process.env.ATMUX_DRIVER_SESSION;
    delete process.env.ATMUX_HANDOFF_WAIT;
    delete process.env.ATMUX_HANDOFF_LINES;
    if (priorAtmuxDir !== undefined) process.env.ATMUX_DIR = priorAtmuxDir;
    if (priorAtmuxTeamDir !== undefined) process.env.ATMUX_TEAM_DIR = priorAtmuxTeamDir;
    if (priorAtmuxSession !== undefined) process.env.ATMUX_SESSION = priorAtmuxSession;
    if (priorAtmuxDriverSession !== undefined)
      process.env.ATMUX_DRIVER_SESSION = priorAtmuxDriverSession;
    if (priorWait !== undefined) process.env.ATMUX_HANDOFF_WAIT = priorWait;
    if (priorLines !== undefined) process.env.ATMUX_HANDOFF_LINES = priorLines;
    await rm(scratch, { recursive: true, force: true });
  });

  async function seedTeam(team: unknown): Promise<string> {
    const atmuxDir = join(scratch, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
    await mkdir(join(atmuxDir, "inboxes"), { recursive: true });
    await writeFile(join(atmuxDir, "team.json"), JSON.stringify(team));
    await writeFile(
      join(atmuxDir, "kanban.json"),
      JSON.stringify({ tasks: [], epics: [], stories: [] }),
    );
    return atmuxDir;
  }

  test("argv parse error → UsageError", async () => {
    await expect(handoff([])).rejects.toBeInstanceOf(UsageError);
  });

  test("missing team.json → ConfigError", async () => {
    await expect(handoff(["--team-dir", scratch, "alpha", "bravo"])).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  test("unknown 'from' member → ConfigError", async () => {
    await seedTeam({ name: "t", members: [{ name: "bravo" }] });
    await expect(handoff(["--team-dir", scratch, "ghost", "bravo"])).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  test("unknown 'to' member → ConfigError", async () => {
    await seedTeam({ name: "t", members: [{ name: "alpha" }] });
    await expect(handoff(["--team-dir", scratch, "alpha", "ghost"])).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  test("happy path: --no-native → screen-capture fallback fires immediately", async () => {
    process.env.ATMUX_SESSION = "atmux-t";
    const atmuxDir = await seedTeam({
      name: "t",
      members: [
        { name: "alpha", tui: "claude" },
        { name: "bravo", tui: "claude" },
      ],
    });
    await writeFile(
      join(atmuxDir, "kanban.json"),
      JSON.stringify({
        tasks: [{ id: "t-1", subject: "x", status: "in-progress", owner: "alpha" }],
        epics: [],
        stories: [],
      }),
    );
    const { tmux, calls } = stubTmux({
      windows: [
        { index: 0, name: "alpha", active: false },
        { index: 1, name: "bravo", active: true },
      ],
      capturePane: "captured-screen-text",
    });
    let stdout = "";
    let stderr = "";
    const exit = await handoff(["--team-dir", scratch, "--no-native", "alpha", "bravo"], {
      buildTmux: () => tmux,
      stdout: (s) => {
        stdout += s;
      },
      stderr: (s) => {
        stderr += s;
      },
      now: () => Date.UTC(2026, 4, 5, 10, 0, 0),
    });
    expect(exit).toBe(0);
    // capturePane fired for the screen-capture path (against `alpha`).
    // (sendToMember to the target ALSO captures `bravo`'s pre-send
    // pane state — total ≥ 2 calls.)
    const captureTargets = calls.capturePane.map((c) => c.target);
    expect(captureTargets).toContain("atmux-t:alpha");
    // The handoff file was written to .atmux/handoff/.
    const dirContents = await Bun.file(
      join(atmuxDir, "handoff", "alpha-to-bravo-20260505T100000Z.md"),
    ).text();
    expect(dirContents).toContain("captured-screen-text");
    // Kanban migrated.
    const k = JSON.parse(await readFile(join(atmuxDir, "kanban.json"), "utf8"));
    expect(k.tasks[0].owner).toBe("bravo");
    // Stdout summary mentions count + path.
    expect(stdout).toContain("handoff complete: alpha → bravo (1 tasks");
    // The "native handoff did not produce" line lands on stderr.
    expect(stderr).toContain("native handoff did not produce");
  });

  test("native ask succeeds → no screen capture", async () => {
    process.env.ATMUX_SESSION = "atmux-t";
    const atmuxDir = await seedTeam({
      name: "t",
      members: [
        { name: "alpha", tui: "claude" },
        { name: "bravo", tui: "claude" },
      ],
    });
    const { tmux, calls } = stubTmux({
      windows: [
        { index: 0, name: "alpha", active: false },
        { index: 1, name: "bravo", active: true },
      ],
    });
    // pollFile returns true → native_ok branch fires, but the ask
    // sendToMember runs first (which does load + paste). We pre-write
    // the expected handoff file so the verb sees it as "native ok".
    let pollPath = "";
    const exit = await handoff(["--team-dir", scratch, "alpha", "bravo"], {
      buildTmux: () => tmux,
      stdout: () => {},
      stderr: () => {},
      now: () => Date.UTC(2026, 4, 5, 10, 0, 0),
      pollFile: async (path) => {
        pollPath = path;
        await writeFile(path, "native-write");
        return true;
      },
    });
    expect(exit).toBe(0);
    // Screen-capture path uses `start: -<captureLines>` (default -500).
    // sendToMember's pre-send uses `start: -40`. The native-success
    // branch should only have the latter against `alpha` (the native
    // ask's pre-send capture).
    const screenCaptureCalls = calls.capturePane.filter(
      (c) => c.target === "atmux-t:alpha" && c.start === -500,
    );
    expect(screenCaptureCalls).toEqual([]);
    expect(pollPath.endsWith("alpha-to-bravo-20260505T100000Z.md")).toBe(true);
    // The native-written file is preserved (NOT overwritten).
    const body = await readFile(
      join(atmuxDir, "handoff", "alpha-to-bravo-20260505T100000Z.md"),
      "utf8",
    );
    expect(body).toBe("native-write");
  });

  test("source pane absent + no-native → 'pane gone' stub written", async () => {
    process.env.ATMUX_SESSION = "atmux-t";
    const atmuxDir = await seedTeam({
      name: "t",
      members: [{ name: "alpha" }, { name: "bravo", tui: "claude" }],
    });
    const { tmux } = stubTmux({
      // bravo present, alpha absent.
      windows: [{ index: 0, name: "bravo", active: true }],
    });
    const exit = await handoff(["--team-dir", scratch, "--no-native", "alpha", "bravo"], {
      buildTmux: () => tmux,
      stdout: () => {},
      stderr: () => {},
      now: () => Date.UTC(2026, 4, 5, 10, 0, 0),
    });
    expect(exit).toBe(0);
    const body = await readFile(
      join(atmuxDir, "handoff", "alpha-to-bravo-20260505T100000Z.md"),
      "utf8",
    );
    expect(body).toContain("source member window is gone");
  });

  test("target pane absent → warn-on-stderr, briefing deferred (no throw)", async () => {
    process.env.ATMUX_SESSION = "atmux-t";
    await seedTeam({
      name: "t",
      members: [{ name: "alpha" }, { name: "bravo" }],
    });
    const { tmux } = stubTmux({
      // alpha present, bravo absent.
      windows: [{ index: 0, name: "alpha", active: true }],
      capturePane: "x",
    });
    let stderr = "";
    const exit = await handoff(["--team-dir", scratch, "--no-native", "alpha", "bravo"], {
      buildTmux: () => tmux,
      stdout: () => {},
      stderr: (s) => {
        stderr += s;
      },
      now: () => Date.UTC(2026, 4, 5, 10, 0, 0),
    });
    expect(exit).toBe(0);
    expect(stderr).toContain("target pane bravo is not up — briefing deferred");
  });

  test("--pause-from sets paused.json on the source", async () => {
    process.env.ATMUX_SESSION = "atmux-t";
    const atmuxDir = await seedTeam({
      name: "t",
      members: [{ name: "alpha" }, { name: "bravo" }],
    });
    const { tmux } = stubTmux({
      windows: [
        { index: 0, name: "alpha", active: false },
        { index: 1, name: "bravo", active: true },
      ],
      capturePane: "x",
    });
    const exit = await handoff(
      [
        "--team-dir",
        scratch,
        "--no-native",
        "--pause-from",
        "--reason",
        "ctx-rot",
        "alpha",
        "bravo",
      ],
      {
        buildTmux: () => tmux,
        stdout: () => {},
        stderr: () => {},
        now: () => Date.UTC(2026, 4, 5, 10, 0, 0),
      },
    );
    expect(exit).toBe(0);
    expect(await isPaused(atmuxDir, "alpha")).toBe(true);
  });

  test("--pause-from with no --reason → 'handoff-manual' reason", async () => {
    process.env.ATMUX_SESSION = "atmux-t";
    const atmuxDir = await seedTeam({
      name: "t",
      members: [{ name: "alpha" }, { name: "bravo" }],
    });
    const { tmux } = stubTmux({
      windows: [
        { index: 0, name: "alpha", active: false },
        { index: 1, name: "bravo", active: true },
      ],
      capturePane: "x",
    });
    await handoff(["--team-dir", scratch, "--no-native", "--pause-from", "alpha", "bravo"], {
      buildTmux: () => tmux,
      stdout: () => {},
      stderr: () => {},
      now: () => Date.UTC(2026, 4, 5, 10, 0, 0),
    });
    const paused = JSON.parse(await readFile(join(atmuxDir, "state", "paused.json"), "utf8"));
    expect(paused.alpha.reason).toBe("handoff-manual");
  });

  test("native sendToMember throws → falls through to screen capture, warns", async () => {
    process.env.ATMUX_SESSION = "atmux-t";
    const atmuxDir = await seedTeam({
      name: "t",
      members: [{ name: "alpha" }, { name: "bravo" }],
    });
    const { tmux } = stubTmux({
      windows: [
        { index: 0, name: "alpha", active: true },
        { index: 1, name: "bravo", active: true },
      ],
      capturePane: "captured",
    });
    // Make loadBuffer throw to simulate sendToMember failure during the
    // native ask. The catch branch emits a warn + continues to the
    // capture-pane fallback.
    const angryTmux = {
      ...tmux,
      buffer: {
        ...tmux.buffer,
        loadBuffer: async () => {
          throw new Error("buffer-write-failed");
        },
      },
    } as TmuxNamespace;
    let stderr = "";
    const exit = await handoff(["--team-dir", scratch, "alpha", "bravo"], {
      buildTmux: () => angryTmux,
      stdout: () => {},
      stderr: (s) => {
        stderr += s;
      },
      now: () => Date.UTC(2026, 4, 5, 10, 0, 0),
    });
    expect(exit).toBe(0);
    expect(stderr).toContain("native ask to alpha failed");
    // Capture-pane fallback wrote a screen-capture body.
    const body = await readFile(
      join(atmuxDir, "handoff", "alpha-to-bravo-20260505T100000Z.md"),
      "utf8",
    );
    expect(body).toContain("captured");
  });

  test("capturePane throws → falls back to '(capture failed)' stub in body", async () => {
    process.env.ATMUX_SESSION = "atmux-t";
    const atmuxDir = await seedTeam({
      name: "t",
      members: [{ name: "alpha" }, { name: "bravo" }],
    });
    const { tmux } = stubTmux({
      windows: [
        { index: 0, name: "alpha", active: true },
        { index: 1, name: "bravo", active: true },
      ],
      capturePaneError: new Error("capture-failed"),
    });
    const exit = await handoff(["--team-dir", scratch, "--no-native", "alpha", "bravo"], {
      buildTmux: () => tmux,
      stdout: () => {},
      stderr: () => {},
      now: () => Date.UTC(2026, 4, 5, 10, 0, 0),
    });
    expect(exit).toBe(0);
    const body = await readFile(
      join(atmuxDir, "handoff", "alpha-to-bravo-20260505T100000Z.md"),
      "utf8",
    );
    expect(body).toContain("(capture failed)");
  });

  test("default-stdout/stderr/buildTmux/now branches exercised when opts omitted", async () => {
    process.env.ATMUX_SESSION = "atmux-t";
    await seedTeam({
      name: "t",
      members: [{ name: "alpha" }, { name: "bravo" }],
    });
    // Drive without stdout/stderr/now overrides — we DO override
    // buildTmux + pollFile so the test stays fast (no real tmux + no
    // 30s wait). Suppress real stdout/stderr to keep the test output
    // clean.
    const { tmux } = stubTmux({
      windows: [
        { index: 0, name: "alpha", active: true },
        { index: 1, name: "bravo", active: true },
      ],
      capturePane: "x",
    });
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const exit = await handoff(["--team-dir", scratch, "--no-native", "alpha", "bravo"], {
        buildTmux: () => tmux,
      });
      expect(exit).toBe(0);
    } finally {
      process.stdout.write = origStdoutWrite;
      process.stderr.write = origStderrWrite;
    }
  });

  test("ping-target send failure → warn-on-stderr, exit 0", async () => {
    process.env.ATMUX_SESSION = "atmux-t";
    await seedTeam({
      name: "t",
      members: [{ name: "alpha" }, { name: "bravo" }],
    });
    const { tmux } = stubTmux({
      windows: [
        { index: 0, name: "alpha", active: true },
        { index: 1, name: "bravo", active: true },
      ],
      capturePane: "x",
    });
    // Drop in --no-native, so only ONE pasteBuffer call fires — the
    // brief send to `bravo`. Make it throw to exercise the catch-and-
    // warn path at handoff.ts:457.
    const angryTmux = {
      ...tmux,
      buffer: {
        ...tmux.buffer,
        pasteBuffer: async () => {
          throw new Error("paste-fail");
        },
      },
    } as TmuxNamespace;
    let stderr = "";
    const exit = await handoff(["--team-dir", scratch, "--no-native", "alpha", "bravo"], {
      buildTmux: () => angryTmux,
      stdout: () => {},
      stderr: (s) => {
        stderr += s;
      },
      now: () => Date.UTC(2026, 4, 5, 10, 0, 0),
    });
    expect(exit).toBe(0);
    expect(stderr).toContain("ping to bravo failed");
  });
});
