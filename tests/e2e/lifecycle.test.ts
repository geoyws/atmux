// E2E lifecycle — port of tests/e2e/lifecycle.bats (10 sequenced beats).
//
// **Stateful 1x cold-start+walk e2e — sequenced beats consume seed
// state. Don't streak; don't run-of-N. Per CLAUDE.md testing discipline
// §"Stateful e2e specs are not repeatable smokes." PLAN.md §8.3
// pins the shape: 10 beats matching .bats block-for-block (one `test()`
// per `@test`), with intra-beat sub-actions captured as `step()` helpers
// for atomicity. bun:test ships no native `test.step`, so the helper
// below augments rethrown errors with the step label — same diagnostic
// signal Playwright/Vitest's test.step gives.**
//
// Verbs exercised by the walk: `start`, `send`, `task` (add), `dispatch`,
// `done`, `tell-lead`, `status`, `whip`, `stop`, `report`, `broadcast`
// (== `send --broadcast`). Reviewer can spot a missing-verb regression
// at a glance from this list.
//
// Walks TS atmux directly against a fixture `.atmux/` dir on a private
// tmux socket (`/tmp/atmux-<team>/sock` per ADR-018 cage convention).
// NOT a parity comparison vs bash atmux — that's the parity-harness lane
// (PLAN.md §8.2). Pure TS-side e2e: assertions are on TS atmux's
// behaviour alone.
//
// Beat ↔ @test mapping (verbatim labels per CLAUDE.md "pair runbook
// beats with rehearsal spec steps" rule):
//   1.  start creates tmux session + one window per member
//   2.  start + send puts text into the pane
//   3.  dispatch + claim + done round-trip
//   4.  tell-lead appends to driver-inbox + pings lead pane
//   5.  status reports session=up and correct pane states
//   6.  whip all-clean when session is up and no stale tasks
//   7.  whip flags DOWN after stop
//   8.  stop archives state
//   9.  report produces a shipped section with a completed task
//   10. broadcast message lands in every non-driver member pane
//
// Window names use the post-ADR-017 form (`<emoji><member>`, no
// `__<team>__` prefix). The bash bats source still references the legacy
// prefix; we assert against the current TS form (`🧭lead`, `🔍reviewer`,
// `🌿gitter`, `🐝w1`).

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createTmux, type TmuxNamespace } from "../../src/abstractions/tmux.ts";
import { done as doneVerb } from "../../src/verbs/claim.ts";
import { dispatch as dispatchVerb } from "../../src/verbs/dispatch.ts";
import { poke as whipVerb } from "../../src/verbs/poke.ts";
import { report as reportVerb } from "../../src/verbs/report.ts";
import { send as sendVerb } from "../../src/verbs/send.ts";
import { start as startVerb } from "../../src/verbs/start.ts";
import { status as statusVerb } from "../../src/verbs/status.ts";
import { stop as stopVerb } from "../../src/verbs/stop.ts";
import { task as taskVerb } from "../../src/verbs/task.ts";
import { tellLead as tellLeadVerb } from "../../src/verbs/tell-lead.ts";

// Beat 8's bare `stop` (no --force) sends C-c + sleeps 2s before
// archive/kill. Bun's 5s default trips on machines under load — give the
// walk plenty of headroom.
setDefaultTimeout(30_000);

// ---------- shared fixture state (single cold-start+walk) ----------

let teamDir: string;
let atmuxDir: string;
let socketDir: string;
let socketPath: string;
let teamName: string;
let sessionName: string;
let leadMarkerDir: string; // ~/.claude/teams/<team>/ — whip writes here
let tmux: TmuxNamespace;
const priorEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  // Per-run unique team name so the cage socket path
  // (/tmp/atmux-<team>/sock) and the home-side
  // ~/.claude/teams/<team>/ marker dir don't collide with concurrent
  // test files or stale prior runs.
  teamName = `lc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  sessionName = `atmux-${teamName}`;

  teamDir = await mkdtemp(join(tmpdir(), "atmux-lifecycle-"));
  atmuxDir = join(teamDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  await mkdir(join(atmuxDir, "inboxes"), { recursive: true });
  await mkdir(join(atmuxDir, "logs"), { recursive: true });
  await mkdir(join(atmuxDir, "state"), { recursive: true });
  await mkdir(join(atmuxDir, "archive"), { recursive: true });

  // start.ts defaults to /tmp/atmux-<team>/sock (cage path); pre-create
  // the directory so tmux's first newSession can bind without ENOENT.
  socketDir = `/tmp/atmux-${teamName}`;
  await mkdir(socketDir, { recursive: true });
  socketPath = join(socketDir, "sock");

  // Mirrors the .bats setup: shell-tui members so newWindow doesn't try
  // to launch claude/etc. Roster matches lifecycle.bats line 13-18.
  // **Emoji explicit per member** — start.ts auto-picks a role default
  // when `member.emoji` is unset (defaultEmojiForRole, common.ts:376),
  // but downstream verbs (send/dispatch/tell-lead/stop) read the *static*
  // `member.emoji` field for window resolution. Without persistence,
  // start spawns `🐝w1` while send looks for `w1` → "can't find window".
  // Pin the emoji here so spawn + send + capture all agree.
  const teamJson = {
    name: teamName,
    members: [
      {
        name: "lead",
        role: "team-lead",
        emoji: "🧭",
        tui: "shell",
        model: "default",
        cwd: teamDir,
      },
      {
        name: "reviewer",
        role: "reviewer",
        emoji: "🔍",
        tui: "shell",
        model: "default",
        cwd: teamDir,
      },
      { name: "gitter", role: "gitter", emoji: "🌿", tui: "shell", model: "default", cwd: teamDir },
      { name: "w1", role: "member", emoji: "🐝", tui: "shell", model: "default", cwd: teamDir },
    ],
    whip: { intervalMins: 5, staleMin: 30, leadMaxMin: 60 },
    report: { intervalMins: 30 },
  };
  await writeFile(join(atmuxDir, "team.json"), JSON.stringify(teamJson, null, 2));
  // KanbanSchema requires top-level epics + stories arrays
  // (src/schema/kanban.ts:177-180); a bare `{tasks:[]}` trips zod on
  // first kanban write.
  await writeFile(join(atmuxDir, "kanban.json"), '{"tasks":[],"epics":[],"stories":[]}');
  await writeFile(join(atmuxDir, "driver-inbox.md"), "");

  // Pin envs so verbs resolve to OUR atmux dir + don't think they're
  // already inside tmux (which would short-circuit attach paths).
  // t-e1247699: ATMUX_NO_CRON=1 pinned alongside the resolve envs — start()
  // auto-installs cron (start.ts §11), and `afterAll`'s rm-rf only reaps
  // the on-disk fixture, leaving 4 cron lines per run pointing at the now-
  // deleted /tmp/atmux-lifecycle-XXXXXX/. Mirrors stop.test.ts:35-36 +
  // tests/helpers/setup.bash:47 (bash sandbox parity).
  for (const k of ["ATMUX_DIR", "ATMUX_TEAM_DIR", "ATMUX_SESSION", "TMUX", "ATMUX_NO_CRON"]) {
    priorEnv[k] = process.env[k];
  }
  process.env.ATMUX_DIR = atmuxDir;
  process.env.ATMUX_TEAM_DIR = teamDir;
  process.env.ATMUX_NO_CRON = "1";
  delete process.env.ATMUX_SESSION;
  delete process.env.TMUX;

  // whip writes ~/.claude/teams/<team>/lead-session-start.txt; track
  // the dir so afterAll can rm it. No `--home` CLI flag, so we don't
  // override — the per-team uniqueness keeps it from colliding.
  leadMarkerDir = join(homedir(), ".claude", "teams", teamName);
  // Pre-seed lead-window-name.txt so whip's per-member check resolves
  // the lead window to the post-ADR-017 form (`🧭lead`) rather than
  // falling back to the legacy `__<team>__team-lead` bash convention
  // (whip.ts:441). The writer side is `team rotate-lead` / `team start`
  // (V-26, deferred per ADR-021) — until that ships, whip reads stale
  // unless someone seeds the marker. Beat 6 needs this for "all clean".
  await mkdir(leadMarkerDir, { recursive: true });
  await writeFile(join(leadMarkerDir, "lead-window-name.txt"), "🧭lead\n");

  // Pre-build a tmux handle on the same socket for assertions +
  // post-walk cleanup.
  tmux = createTmux({ socketPath });
});

afterAll(async () => {
  try {
    await tmux.server.killServer();
  } catch {
    // expected: server may already be dead from beat 7/8 stop --force
  }
  for (const [k, v] of Object.entries(priorEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(teamDir, { recursive: true, force: true });
  await rm(socketDir, { recursive: true, force: true });
  await rm(leadMarkerDir, { recursive: true, force: true });
});

// ---------- helpers ----------

/**
 * Run a sub-action with a labelled error message. bun:test 1.3 has no
 * native `test.step` (Playwright/Vitest pattern); this helper rethrows
 * with the step label prepended so a failing assertion inside a beat
 * still tells you which sub-action broke. PLAN.md §8.3 ("intra-beat
 * sub-actions captured as test.step children for atomicity").
 */
async function step(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof Error) e.message = `[step: ${label}] ${e.message}`;
    throw e;
  }
}

/** Capture process.stdout writes for a verb invocation. Verbs print
 *  task IDs / status output / report bodies through `process.stdout`
 *  directly (ADR-020 Writer abstraction is opt-in via opts), so to read
 *  them from the verb-level argv API we redirect the global. */
async function captureStdout<T>(fn: () => Promise<T>): Promise<{ result: T; stdout: string }> {
  let stdout = "";
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: unknown) => boolean }).write = (s) => {
    stdout += typeof s === "string" ? s : new TextDecoder().decode(s as Uint8Array);
    return true;
  };
  try {
    return { result: await fn(), stdout };
  } finally {
    (process.stdout as unknown as { write: typeof orig }).write = orig;
  }
}

/** Build a tmux pane target string for the given member + emoji. */
const win = (member: string, emoji: string) => `${sessionName}:${emoji}${member}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface KanbanTask {
  id: string;
  status?: string;
}

async function readKanbanTask(id: string): Promise<KanbanTask | undefined> {
  const text = await readFile(join(atmuxDir, "kanban.json"), "utf8");
  const k = JSON.parse(text) as { tasks: KanbanTask[] };
  return k.tasks.find((t) => t.id === id);
}

// ---------- 10 sequenced beats ----------

describe("e2e lifecycle (1x cold-start+walk)", () => {
  test("e2e: start creates tmux session + one window per member", async () => {
    const rc = await startVerb([]);
    expect(rc).toBe(0);
    expect(await tmux.session.hasSession(sessionName)).toBe(true);
    const wins = await tmux.window.listWindows(sessionName);
    // Post-ADR-017: bare emoji-prefixed names, no `__<team>__` wrapper.
    const memberNames = new Set(["🧭lead", "🔍reviewer", "🌿gitter", "🐝w1"]);
    const memberWins = wins.filter((w) => memberNames.has(w.name));
    expect(memberWins.length).toBe(4);
  });

  test("e2e: start + send puts text into the pane", async () => {
    await startVerb([]); // idempotent re-entry per .bats line 47
    await sleep(500); // shell startup grace inside the new pane
    const rc = await sendVerb(["--no-verify", "w1", "echo HELLO_FROM_ATMUX_E2E"]);
    expect(rc).toBe(0);
    await sleep(800); // tmux render grace before capture
    const out = await tmux.pane.capturePane({ target: win("w1", "🐝"), start: -30 });
    expect(out).toContain("HELLO_FROM_ATMUX_E2E");
  });

  test("e2e: dispatch + claim + done round-trip", async () => {
    await startVerb([]);
    let id = "";

    await step("task add → id on stdout", async () => {
      const { result, stdout } = await captureStdout(() => taskVerb(["add", "e2e-task-1"]));
      expect(result).toBe(0);
      // Bash uses `tail -1` to grab the id line; mirror.
      id = stdout.trim().split("\n").pop() ?? "";
      expect(id.length).toBeGreaterThan(0);
    });

    await step("dispatch → kanban status=in-progress", async () => {
      const rc = await dispatchVerb(["w1", id, "--no-ping"]);
      expect(rc).toBe(0);
      const t = await readKanbanTask(id);
      expect(t?.status).toBe("in-progress");
    });

    await step("done --as w1 → kanban status=done", async () => {
      const rc = await doneVerb([id, "--as", "w1", "--note", "e2e-ok"]);
      expect(rc).toBe(0);
      const t = await readKanbanTask(id);
      expect(t?.status).toBe("done");
    });
  });

  test("e2e: tell-lead appends to driver-inbox + pings lead pane", async () => {
    await startVerb([]);
    await sleep(500);
    const rc = await tellLeadVerb(["please implement X"]);
    expect(rc).toBe(0);

    await step("driver-inbox.md contains the ask", async () => {
      const inboxText = await readFile(join(atmuxDir, "driver-inbox.md"), "utf8");
      expect(inboxText).toContain("please implement X");
    });

    await step("lead pane sees the heads-up", async () => {
      await sleep(500);
      const leadOut = await tmux.pane.capturePane({ target: win("lead", "🧭"), start: -30 });
      expect(leadOut).toContain("please implement X");
    });
  });

  test("e2e: status reports session=up and correct pane states", async () => {
    await startVerb([]);
    const { result, stdout } = await captureStdout(() => statusVerb([]));
    expect(result).toBe(0);
    expect(stdout).toContain(`session=${sessionName}`);
    expect(stdout).toContain("[up]");
  });

  test("e2e: whip all-clean when session is up and no stale tasks", async () => {
    await startVerb([]);
    const { result, stdout } = await captureStdout(() => whipVerb([]));
    expect(result).toBe(0);
    expect(stdout).toContain("all clean");
  });

  test("e2e: whip flags DOWN after stop", async () => {
    await startVerb([]);
    const rc1 = await stopVerb(["--force"]);
    expect(rc1).toBe(0);
    const { result, stdout } = await captureStdout(() => whipVerb([]));
    expect(result).toBe(0);
    // First-tick suppression ("session DOWN (tick 1/2) — suppressing")
    // OR a confirmed DOWN report after 2 ticks — both contain the
    // substring "DOWN" / "down". Bash bats matches the same pair
    // (lifecycle.bats:102).
    expect(/DOWN|down/.test(stdout)).toBe(true);
  });

  test("e2e: stop archives state", async () => {
    await startVerb([]); // beat 7 left the session DOWN; recreate
    await captureStdout(() => taskVerb(["add", "some-task"])); // id discarded
    // Bare `stop` (no --force) — sends C-c + 2s grace + archive + kill,
    // matching .bats line 108. Slower than --force but parity intent
    // is preserved (bash exercises the graceful path here).
    const rc = await stopVerb([]);
    expect(rc).toBe(0);
    const archives = await readdir(join(atmuxDir, "archive"));
    expect(archives.length).toBeGreaterThan(0);
  });

  test("e2e: report produces a shipped section with a completed task", async () => {
    await startVerb([]); // beat 8 left the session DOWN; recreate
    let id = "";
    await step("task add → id on stdout", async () => {
      const { stdout } = await captureStdout(() => taskVerb(["add", "ship-it"]));
      id = stdout.trim().split("\n").pop() ?? "";
      expect(id.length).toBeGreaterThan(0);
    });
    await step("dispatch + done", async () => {
      await dispatchVerb(["w1", id, "--no-ping"]);
      await doneVerb([id, "--as", "w1", "--note", "done"]);
    });
    await step("report --no-discord prints atmux-report + ship-it", async () => {
      const { result, stdout } = await captureStdout(() => reportVerb(["--no-discord"]));
      expect(result).toBe(0);
      expect(stdout).toContain("atmux-report");
      expect(stdout).toContain("ship-it");
    });
  });

  test("e2e: broadcast message lands in every non-driver member pane", async () => {
    await startVerb([]);
    await sleep(500);
    // `atmux broadcast …` aliases to `send --broadcast …` (cli.ts:108).
    const rc = await sendVerb(["--broadcast", "--no-verify", "echo BROADCAST_E2E"]);
    // broadcastSend returns 0 (all-success) or 1 (any-failed). Bats
    // ignores the status (`run` then no assertion); we accept both.
    // The real assertion is below — at least 3 of 4 panes saw the text.
    expect([0, 1]).toContain(rc);
    await sleep(1000);
    let hits = 0;
    const targets: ReadonlyArray<readonly [string, string]> = [
      ["lead", "🧭"],
      ["reviewer", "🔍"],
      ["gitter", "🌿"],
      ["w1", "🐝"],
    ];
    for (const [m, e] of targets) {
      try {
        const out = await tmux.pane.capturePane({ target: win(m, e), start: -30 });
        if (out.includes("BROADCAST_E2E")) hits += 1;
      } catch {
        // expected: window may not exist if a prior beat killed it.
      }
    }
    // Bash uses `(( hits >= 3 ))` (lifecycle.bats:137) — flake-tolerant
    // since a single pane may swallow input under load.
    expect(hits).toBeGreaterThanOrEqual(3);
  });
});
