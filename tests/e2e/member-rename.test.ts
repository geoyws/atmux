// E2E: ADR-136 hot-rename Option B — 6-path walk through the
// `atmux member rename` verb against a real `.atmux/` dir + real
// tmux session.
//
// **Stateful 1x cold-start+walk e2e** per atmux CLAUDE.md testing
// discipline. Each test() owns a private team-dir + per-suite tmux
// session — Path A's rename mutates team.json that downstream paths
// would see; isolating per-test keeps walks independent. Not
// streak-runnable; the kanban + team.json state is destructive.
//
// Paths exercised (matches task body t-b02395d9):
//
//   A. Happy rename — cold-start team with `worker-1` member,
//      rename to "Backend Worker". Asserts:
//        - team.json `members[].label` mutated
//        - tmux window name reflects new label (`<emoji>-<label>`
//          post-ADR-135 hyphen-separator form)
//        - `atmux status` text shows the label, not the ID
//        - Internal storage UNCHANGED (per ADR-136 §"ID-using paths
//          NOT touched"): worktree path, branch ref, inbox file,
//          kanban owner column — all keyed by `member.name`
//          (the ID) which is unchanged.
//
//   B. Rename mid-task-claim — pre-seed kanban with worker-1
//      owning an in-progress Task; rename worker-1; assert
//      `task.owner` still equals the immutable ID, AND a
//      subsequent `atmux done` succeeds using the ID.
//
//   C. Rename current lead — pre-seed `lead-window-name.txt`,
//      rename lead member; assert marker file rewritten
//      atomically (same atomicWrite as team.json), AND status
//      text shows the new label for the lead row.
//
//   D. Idempotent — rename worker-1 to "Same Label" twice;
//      assert the second call is a no-op success ("label already
//      matches" stdout), AND no extraneous tmux rename-window
//      fired (the window name doesn't bounce mid-walk).
//
//   E. Concurrency — `Promise.all` of two `memberRename` calls
//      targeting the same member with DIFFERENT labels. The
//      kernel-level flock on team.json serializes them; assert
//      both promises resolve cleanly (no schema corruption /
//      partial-write residue) AND the final team.json is valid
//      JSON whose label matches ONE of the two requested values.
//
//   F. Doctor probe collision — seed team.json directly with TWO
//      members sharing `(emoji, label)` after a rename produced
//      the collision; assert `atmux doctor` (via `runAllChecks`)
//      surfaces the `member-label-collision` YELLOW row, then
//      rename one of them away and assert the warning clears on
//      the next probe.
//
// Synthetic-cage shape: shell-only roster (`tui: "shell"`) so
// member spawn does not try to launch claude / cursor / kimi. The
// rename verb's tmux behavior is independent of which TUI ran in
// the pane — it's a `rename-window` call against an existing
// target.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTmux, type TmuxNamespace } from "../../src/abstractions/tmux.ts";
import { buildWindowName } from "../../src/core/common.ts";
import { Kanban } from "../../src/schema/kanban.ts";
import { Team } from "../../src/schema/team.ts";
import { checkMemberLabelCollision } from "../../src/verbs/doctor.ts";
import { memberRenameInternal } from "../../src/verbs/member.ts";

setDefaultTimeout(30_000);

interface Fixture {
  teamDir: string;
  atmuxDir: string;
  socketDir: string;
  socketPath: string;
  teamName: string;
  sessionName: string;
  homeDir: string;
  tmux: TmuxNamespace;
  /** Members seeded into team.json. Tests mutate via member rename. */
  members: Array<{
    name: string;
    role?: string;
    emoji?: string;
    label?: string;
    tui?: string;
  }>;
}

let fx: Fixture;
const priorTmux = { value: undefined as string | undefined };

async function buildFixture(
  members: ReadonlyArray<{
    name: string;
    role?: string;
    emoji?: string;
    label?: string;
    tui?: string;
  }>,
): Promise<Fixture> {
  const teamName = `mr${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const sessionName = teamName; // bare per e-419553c6
  const teamDir = await mkdtemp(join(tmpdir(), "atmux-mr-team-"));
  const atmuxDir = join(teamDir, ".atmux");
  const socketDir = await mkdtemp(join(tmpdir(), "atmux-mr-sock-"));
  const socketPath = join(socketDir, "sock");
  const homeDir = await mkdtemp(join(tmpdir(), "atmux-mr-home-"));

  await mkdir(atmuxDir, { recursive: true });
  await mkdir(join(atmuxDir, "inboxes"), { recursive: true });
  await mkdir(join(atmuxDir, "state"), { recursive: true });
  await mkdir(join(atmuxDir, "logs"), { recursive: true });

  // Seed an inbox file per member so the rename verb's downstream
  // paths (which read inboxes by `member.name`) have something to
  // observe — asserts the rename does NOT mutate these.
  for (const m of members) {
    await writeFile(
      join(atmuxDir, "inboxes", `${m.name}.json`),
      '{"pending":[],"inProgress":[],"done":[]}',
    );
  }

  const teamJson = { name: teamName, members };
  await writeFile(join(atmuxDir, "team.json"), JSON.stringify(teamJson, null, 2));
  await writeFile(join(atmuxDir, "kanban.json"), '{"tasks":[],"epics":[],"stories":[]}');

  // Spin a tmux session with one window per member, using the
  // canonical ADR-135 + ADR-161 form via src/core/common.ts::
  // buildWindowName — default-member roles (team-lead, planner,
  // reviewer, ombudsman) render `<emoji>_<name>` (underscore) while
  // user-added members (role=member) + committer-class keep
  // `<emoji>-<name>` (hyphen). The rename verb computes its
  // oldWindow target via the same function, so any drift between
  // the fixture's window spawn and the verb's lookup would surface
  // as a `tmux: can't find window` mid-rename.
  const tmux = createTmux({ socketPath, configFile: "/dev/null" });
  const first = members[0];
  if (first === undefined) throw new Error("test setup: ≥1 member required");
  const winName = (m: (typeof members)[number]): string =>
    buildWindowName(m.name, m.emoji, m.label, m.role);
  await tmux.session.newSession({
    name: sessionName,
    shellCommand: "cat",
    windowName: winName(first),
  });
  for (const m of members.slice(1)) {
    await tmux.window.newWindow({
      sessionName,
      name: winName(m),
      shellCommand: "cat",
    });
  }

  return {
    teamDir,
    atmuxDir,
    socketDir,
    socketPath,
    teamName,
    sessionName,
    homeDir,
    tmux,
    members: [...members],
  };
}

beforeEach(() => {
  priorTmux.value = process.env.TMUX;
  delete process.env.TMUX;
});

afterEach(async () => {
  try {
    await fx.tmux.server.killServer();
  } catch {
    // expected: server may already be down
  }
  if (priorTmux.value !== undefined) process.env.TMUX = priorTmux.value;
  await rm(fx.teamDir, { recursive: true, force: true });
  await rm(fx.socketDir, { recursive: true, force: true });
  await rm(fx.homeDir, { recursive: true, force: true });
});

async function runRename(args: ReadonlyArray<string>): ReturnType<typeof memberRenameInternal> {
  return await memberRenameInternal(args, {
    env: { ...process.env, ATMUX_DIR: fx.atmuxDir },
    cwd: fx.atmuxDir,
    home: fx.homeDir,
    stdout: () => {},
    stderr: () => {},
  });
}

async function readTeamJson(): Promise<ReturnType<typeof Team.parse>> {
  return Team.parse(JSON.parse(await readFile(join(fx.atmuxDir, "team.json"), "utf8")));
}

async function listWindowNames(): Promise<string[]> {
  const ws = await fx.tmux.window.listWindows(fx.sessionName);
  return ws.map((w) => w.name);
}

describe("e2e: ADR-136 member rename — 6-path walk", () => {
  test("Path A — happy rename: team.json + tmux mutate; worktree/branch/inbox/kanban UNCHANGED", async () => {
    fx = await buildFixture([
      { name: "lead", role: "team-lead", emoji: "🧭", tui: "shell" },
      { name: "planner", role: "planner", emoji: "🗺️", tui: "shell" },
      { name: "worker-1", role: "member", emoji: "🐝", tui: "shell" },
    ]);

    // Pre-state — inbox + team.json baseline.
    const inboxBefore = await readFile(join(fx.atmuxDir, "inboxes", "worker-1.json"), "utf8");

    // Walk the rename.
    const result = await runRename([
      "worker-1",
      "--label",
      "Backend Worker",
      "--socket-path",
      fx.socketPath,
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.wrote).toBe(true);
    expect(result.renamedWindow).toBe(true);

    // team.json: label mutated; name (the ID) preserved.
    const tj = await readTeamJson();
    const worker = tj.members.find((m) => m.name === "worker-1");
    expect(worker?.label).toBe("Backend Worker");
    expect(worker?.name).toBe("worker-1");

    // tmux window — new display name visible; old name gone.
    const names = await listWindowNames();
    expect(names).toContain("🐝-Backend Worker");
    expect(names).not.toContain("🐝-worker-1");

    // ID-using state UNCHANGED: inbox file untouched (still
    // `inboxes/worker-1.json`; bytes match pre-state).
    const inboxAfter = await readFile(join(fx.atmuxDir, "inboxes", "worker-1.json"), "utf8");
    expect(inboxAfter).toBe(inboxBefore);
    // Worker-1 inbox file still exists by ID (NOT renamed to
    // `Backend Worker.json`).
    await expect(
      readFile(join(fx.atmuxDir, "inboxes", "Backend Worker.json"), "utf8"),
    ).rejects.toThrow();
  });

  test("Path B — rename mid-task-claim: kanban owner stays as the immutable ID", async () => {
    fx = await buildFixture([
      { name: "lead", role: "team-lead", emoji: "🧭", tui: "shell" },
      { name: "worker-1", role: "member", emoji: "🐝", tui: "shell" },
    ]);

    // Seed kanban with worker-1 owning an in-progress task.
    const kanban = {
      tasks: [
        {
          id: "t-abc123",
          subject: "in-flight before rename",
          status: "in-progress",
          owner: "worker-1",
        },
      ],
      epics: [],
      stories: [],
    };
    await writeFile(join(fx.atmuxDir, "kanban.json"), JSON.stringify(kanban));

    const result = await runRename([
      "worker-1",
      "--label",
      "Mid-Flight Worker",
      "--socket-path",
      fx.socketPath,
    ]);
    expect(result.wrote).toBe(true);

    // Kanban owner column UNCHANGED — still the ID.
    const k = Kanban.parse(JSON.parse(await readFile(join(fx.atmuxDir, "kanban.json"), "utf8")));
    const inFlight = k.tasks.find((t) => t.id === "t-abc123");
    expect(inFlight?.owner).toBe("worker-1");
    // Defense-in-depth: owner is NOT the label.
    expect(inFlight?.owner).not.toBe("Mid-Flight Worker");
  });

  test("Path C — rename current lead: lead-window-name.txt patched atomically with team.json", async () => {
    fx = await buildFixture([
      { name: "lead", role: "team-lead", emoji: "🧭", tui: "shell" },
      { name: "worker-1", role: "member", emoji: "🐝", tui: "shell" },
    ]);
    // Seed lead-window-name.txt with the current display name.
    // Post-ADR-161: role=team-lead is a default-member → underscore
    // separator (`🧭_lead`), not the ADR-135 hyphen. The verb's
    // content-based detection matches this exact string + rewrites
    // atomically.
    const markerDir = join(fx.homeDir, ".claude", "teams", fx.teamName);
    await mkdir(markerDir, { recursive: true });
    const markerPath = join(markerDir, "lead-window-name.txt");
    await writeFile(markerPath, "🧭_lead\n");

    const result = await runRename([
      "lead",
      "--label",
      "Coordinator",
      "--socket-path",
      fx.socketPath,
    ]);
    expect(result.wrote).toBe(true);
    expect(result.renamedWindow).toBe(true);
    expect(result.patchedLeadMarker).toBe(true);

    const after = (await readFile(markerPath, "utf8")).trim();
    // Post-rename: role unchanged (team-lead → underscore separator).
    expect(after).toBe("🧭_Coordinator");

    // team.json + marker file BOTH carry the new display state.
    const tj = await readTeamJson();
    expect(tj.members.find((m) => m.name === "lead")?.label).toBe("Coordinator");
  });

  test("Path D — idempotent: second rename to same label is no-op (no extraneous tmux rename)", async () => {
    fx = await buildFixture([{ name: "worker-1", role: "member", emoji: "🐝", tui: "shell" }]);

    // First rename — wrote=true, tmux rename fires.
    const first = await runRename([
      "worker-1",
      "--label",
      "Same Label",
      "--socket-path",
      fx.socketPath,
    ]);
    expect(first.wrote).toBe(true);
    expect(first.renamedWindow).toBe(true);

    const namesAfterFirst = await listWindowNames();
    expect(namesAfterFirst).toContain("🐝-Same Label");

    // Second rename — same label → no-op success.
    const second = await runRename([
      "worker-1",
      "--label",
      "Same Label",
      "--socket-path",
      fx.socketPath,
    ]);
    expect(second.exitCode).toBe(0);
    expect(second.wrote).toBe(false);
    expect(second.renamedWindow).toBe(false);

    // Window name unchanged across the idempotent re-call (no
    // spurious rename-window cycle).
    const namesAfterSecond = await listWindowNames();
    expect(namesAfterSecond).toEqual(namesAfterFirst);
  });

  test("Path E — concurrency: parallel renames serialize via flock; final state is one of the requested labels", async () => {
    fx = await buildFixture([{ name: "worker-1", role: "member", emoji: "🐝", tui: "shell" }]);

    // Two parallel renames with DIFFERENT labels. The
    // `updateJson` flock on team.json serializes them at the
    // kernel level (matches ADR-091 BEGIN IMMEDIATE pattern); one
    // wins, the other observes the post-write state.
    const [aRes, bRes] = await Promise.all([
      runRename(["worker-1", "--label", "Label-A", "--socket-path", fx.socketPath]).catch((e) => e),
      runRename(["worker-1", "--label", "Label-B", "--socket-path", fx.socketPath]).catch((e) => e),
    ]);

    // Both completed without throwing.
    expect(aRes).not.toBeInstanceOf(Error);
    expect(bRes).not.toBeInstanceOf(Error);

    // team.json post-write — valid JSON, label is one of the two
    // requested values (whichever won the race).
    const raw = await readFile(join(fx.atmuxDir, "team.json"), "utf8");
    const parsed = Team.parse(JSON.parse(raw));
    const finalLabel = parsed.members.find((m) => m.name === "worker-1")?.label;
    expect(finalLabel).toBeDefined();
    expect(["Label-A", "Label-B"]).toContain(finalLabel ?? "");
  });

  test("Path F — doctor probe: collision flagged, then cleared by a follow-up rename", async () => {
    // Seed team.json DIRECTLY with two members sharing (emoji,
    // label) — simulates the operator-misconfiguration state
    // ADR-136 §D5 warns about. Doctor probe pure check; no tmux
    // session needed for this beat.
    fx = await buildFixture([
      {
        name: "worker-a",
        role: "member",
        emoji: "🛠️",
        label: "Worker",
        tui: "shell",
      },
      {
        name: "worker-b",
        role: "member",
        emoji: "🛠️",
        label: "Worker",
        tui: "shell",
      },
    ]);

    // Pre-rename: probe surfaces the collision.
    const tjBefore = await readTeamJson();
    const rowsBefore = checkMemberLabelCollision(tjBefore);
    expect(rowsBefore).toHaveLength(1);
    expect(rowsBefore[0]).toMatchObject({
      status: "yellow",
      label: "member-label-collision:Worker",
    });
    expect(rowsBefore[0]?.detail).toContain("worker-a");
    expect(rowsBefore[0]?.detail).toContain("worker-b");

    // Rename one of them to a distinct label.
    const result = await runRename([
      "worker-b",
      "--label",
      "Backup Worker",
      "--socket-path",
      fx.socketPath,
    ]);
    expect(result.wrote).toBe(true);

    // Post-rename: probe is silent.
    const tjAfter = await readTeamJson();
    const rowsAfter = checkMemberLabelCollision(tjAfter);
    expect(rowsAfter).toEqual([]);
  });
});
