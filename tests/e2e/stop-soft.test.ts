// E2E: `atmux stop --soft` + resume-manifest surfacing (ADR-087).
//
// **Stateful 1x cold-start+walk e2e** per CLAUDE.md testing discipline
// (mirror of `tests/e2e/lifecycle.test.ts` shape). Walks TS atmux
// directly against a fixture `.atmux/` dir on a private tmux socket,
// claims a Task mid-flow, soft-stops, then re-starts and verifies the
// resume hint surfaces.
//
// Beats:
//   1. start the team
//   2. task add + claim → 1 in-flight Task owned by w1
//   3. stop --soft → manifest at state/resume.json, session dead, no
//      worktree prune (worktreeIsolation off here — the assertion is
//      that no `state/resume.json` cleanup ran)
//   4. start again → resume hint logged, manifest renamed to
//      `state/resume.json.<ts>.consumed`
//   5. start a third time → no hint surfaces (consumed marker means
//      the manifest is not re-read)

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createTmux, type TmuxNamespace } from "../../src/abstractions/tmux.ts";
import { buildWindowName } from "../../src/core/common.ts";
import { ResumeManifest } from "../../src/schema/resume.ts";
import { claim as claimVerb } from "../../src/verbs/claim.ts";
import { start as startVerb } from "../../src/verbs/start.ts";
import { stop as stopVerb } from "../../src/verbs/stop.ts";
import { task as taskVerb } from "../../src/verbs/task.ts";

// Soft-stop's default grace is 5s; we override to 0 via `softStopGraceSeconds`
// in the team.json so the beat doesn't block needlessly.
setDefaultTimeout(30_000);

let teamDir: string;
let atmuxDir: string;
let socketDir: string;
let socketPath: string;
let teamName: string;
let sessionName: string;
let leadMarkerDir: string;
let tmux: TmuxNamespace;
const priorEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  teamName = `ss${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  sessionName = `atmux-${teamName}`;

  teamDir = await mkdtemp(join(tmpdir(), "atmux-stopsoft-"));
  atmuxDir = join(teamDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  await mkdir(join(atmuxDir, "inboxes"), { recursive: true });
  await mkdir(join(atmuxDir, "logs"), { recursive: true });
  await mkdir(join(atmuxDir, "state"), { recursive: true });
  await mkdir(join(atmuxDir, "archive"), { recursive: true });

  socketDir = `/tmp/atmux-${teamName}`;
  await mkdir(socketDir, { recursive: true });
  socketPath = join(socketDir, "sock");

  // Shell-only roster so member spawn doesn't try to launch claude/etc.
  // softStopGraceSeconds=0 keeps the beat snappy.
  const teamJson = {
    name: teamName,
    softStopGraceSeconds: 0,
    members: [
      {
        name: "lead",
        role: "team-lead",
        emoji: "🧭",
        tui: "shell",
        model: "default",
        cwd: teamDir,
      },
      { name: "w1", role: "member", emoji: "🐝", tui: "shell", model: "default", cwd: teamDir },
    ],
    whip: { intervalMins: 5, staleMin: 30, leadMaxMin: 60 },
    report: { intervalMins: 30 },
  };
  await writeFile(join(atmuxDir, "team.json"), JSON.stringify(teamJson, null, 2));
  await writeFile(join(atmuxDir, "kanban.json"), '{"tasks":[],"epics":[],"stories":[]}');
  await writeFile(join(atmuxDir, "driver-inbox.md"), "");

  for (const k of ["ATMUX_DIR", "ATMUX_TEAM_DIR", "ATMUX_SESSION", "TMUX", "ATMUX_NO_CRON"]) {
    priorEnv[k] = process.env[k];
  }
  process.env.ATMUX_DIR = atmuxDir;
  process.env.ATMUX_TEAM_DIR = teamDir;
  // Suppress cron auto-install — test env, never write to host crontab.
  process.env.ATMUX_NO_CRON = "1";
  delete process.env.ATMUX_SESSION;
  delete process.env.TMUX;

  leadMarkerDir = join(homedir(), ".claude", "teams", teamName);
  await mkdir(leadMarkerDir, { recursive: true });
  // Post-ADR-135 + ADR-161 canonical: team-lead role → `🧭_lead`
  // (default-member underscore separator). Source: src/core/common.ts::
  // buildWindowName + isDefaultMemberRole.
  await writeFile(
    join(leadMarkerDir, "lead-window-name.txt"),
    `${buildWindowName("lead", "🧭", undefined, "team-lead")}\n`,
  );

  tmux = createTmux({ socketPath });
});

afterAll(async () => {
  try {
    await tmux.server.killServer();
  } catch {
    // expected: server may already be dead from a beat's stop call.
  }
  for (const [k, v] of Object.entries(priorEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(teamDir, { recursive: true, force: true });
  await rm(socketDir, { recursive: true, force: true });
  await rm(leadMarkerDir, { recursive: true, force: true });
});

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

async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  let stderr = "";
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (s: unknown) => boolean }).write = (s) => {
    stderr += typeof s === "string" ? s : new TextDecoder().decode(s as Uint8Array);
    return true;
  };
  try {
    return { result: await fn(), stderr };
  } finally {
    (process.stderr as unknown as { write: typeof orig }).write = orig;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("e2e: stop --soft (ADR-087)", () => {
  test("e2e: stop --soft on idle team writes manifest with 0 in-flight", async () => {
    expect(await startVerb([])).toBe(0);
    expect(await tmux.session.hasSession(sessionName)).toBe(true);

    const { result, stdout } = await captureStdout(() => stopVerb(["--soft"]));
    expect(result).toBe(0);
    expect(stdout).toContain("soft-stop:");
    expect(stdout).toContain("0 in-flight tasks");

    const manifestPath = join(atmuxDir, "state", "resume.json");
    const raw = await readFile(manifestPath, "utf8");
    const parsed = ResumeManifest.parse(JSON.parse(raw));
    expect(parsed.version).toBe(1);
    expect(parsed.reason).toBe("soft-stop");
    expect(parsed.team).toBe(teamName);
    // Every roster member appears, all with lastClaim === null on
    // idle stop.
    expect(parsed.members).toHaveLength(2);
    expect(parsed.members.every((m) => m.lastClaim === null)).toBe(true);

    // Session is dead.
    expect(await tmux.session.hasSession(sessionName)).toBe(false);
  });

  test("e2e: stop --soft captures w1's in-flight Task in the manifest", async () => {
    expect(await startVerb([])).toBe(0);
    await sleep(300);

    // Add + claim a Task as w1 — sets owner=w1, status=in-progress in
    // the kanban (which soft-stop reads).
    const { stdout: addOut } = await captureStdout(() => taskVerb(["add", "soft-flight"]));
    const taskId = addOut.trim().split("\n").pop() ?? "";
    expect(taskId.length).toBeGreaterThan(0);
    expect(await claimVerb([taskId, "--as", "w1"])).toBe(0);

    const { stdout: stopOut } = await captureStdout(() => stopVerb(["--soft"]));
    expect(stopOut).toContain("1 in-flight task");

    const manifestPath = join(atmuxDir, "state", "resume.json");
    const parsed = ResumeManifest.parse(JSON.parse(await readFile(manifestPath, "utf8")));
    const w1 = parsed.members.find((m) => m.name === "w1");
    expect(w1?.lastClaim).toBe(taskId);
    // Post-ADR-135 canonical: role=member → `<emoji>-<name>` (hyphen).
    expect(w1?.windowName).toBe(buildWindowName("w1", "🐝", undefined, "member"));
    expect(parsed.members.find((m) => m.name === "lead")?.lastClaim).toBeNull();
  });

  test("e2e: start consumes the manifest and surfaces a resume hint", async () => {
    // beat 2 left a manifest on disk + session dead. A fresh start
    // should: (a) read the manifest, (b) log a `resume:` hint to
    // stderr (logger.log → stderr by default), (c) rename the
    // manifest to `resume.json.<ts>.consumed`.
    //
    // The hint goes through `createLogger()` which writes to stderr;
    // see src/core/tui.ts. captureStderr surfaces it.
    const { stderr } = await captureStderr(() => startVerb([]));
    expect(stderr).toContain("resume:");
    expect(stderr).toContain("had in-flight Tasks");
    // Per-member detail line for w1.
    expect(stderr).toContain("w1:");

    // Manifest renamed.
    const stateEntries = await readdir(join(atmuxDir, "state"));
    expect(stateEntries.some((e) => e === "resume.json")).toBe(false);
    expect(stateEntries.some((e) => /^resume\.json\.\d+\.consumed$/.test(e))).toBe(true);
  });

  test("e2e: subsequent start without a manifest surfaces no resume hint", async () => {
    // After beat 3 the manifest is consumed. Stop hard (--force) so
    // no new soft-stop manifest is written. Then start: stderr should
    // NOT contain a `resume:` hint line.
    await stopVerb(["--force"]);
    expect(await tmux.session.hasSession(sessionName)).toBe(false);

    const { stderr } = await captureStderr(() => startVerb([]));
    expect(stderr.includes("resume:")).toBe(false);
  });

  test("e2e: --soft + --force together → UsageError", async () => {
    // parseStopArgs gates the combination — verify the verb refuses.
    let threw = false;
    try {
      await stopVerb(["--soft", "--force"]);
    } catch (e) {
      threw = true;
      expect((e as Error).message).toContain("mutually exclusive");
    }
    expect(threw).toBe(true);
  });
});
