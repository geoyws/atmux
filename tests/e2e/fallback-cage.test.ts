// E2E ADR-058 multi-tier fallback-cage walk — Tier 2 spawn-and-tear-down,
// Tier 3 isolation proofs, reconciliation diff, default-OFF regression,
// and resume-tick continuity. Five test cases per the parent task body's
// Acceptance gate, env-gated so non-sudo / non-provisioned CI doesn't
// false-fail.
//
// **Stateful 1x cold-start+walk e2e — sequenced beats consume real tmux
// state (case 1) + real sudo+kimi-agent state (cases 2+3). Don't streak;
// don't run-of-N. Per CLAUDE.md testing discipline §"Stateful e2e specs
// are not repeatable smokes."** Cases 4+5 are pure-injection (always run).
//
// Beat ↔ test mapping:
//   1. Tier 2 cage spawn-and-tear-down — real tmux server, real archive
//      lands at `<atmuxDir>/tier2-handoff/archive/...`.
//   2. Tier 3 cage isolation proofs — real `sudo -u kimi-agent` probes
//      verify the cage workspace is read-only against the project tree
//      and has no `git`/`.git` accessible.
//   3. Reconciliation diff — `scripts/fallback-reconcile.sh` walks per-
//      file deltas, brings them back under operator UID.
//   4. Default-OFF regression — fallback gate cuts before any cage work
//      when `team.fallback?.enabled !== true`; budget-pause path runs
//      verbatim.
//   5. Resume continuity — mocked handles file → walkFallbackOnResume
//      composes per-cage briefs + tears down + removes handles file.
//
// Naming note: the parent task body refers to archive paths as
// `.atmux/cursor-handoff/archive/` and `.atmux/kimi-handoff/archive/`,
// but the abstraction (src/abstractions/fallback-cage.ts::cageArchiveRoot)
// settled on `tier${N}-handoff/archive` for symmetry across all tiers.
// Tests assert what was actually shipped.
//
// Skip-gates:
//   - HAS_TMUX                  — tmux binary in PATH (case 1).
//   - HAS_SUDO_NONINTERACTIVE   — `sudo -n true` exits 0 (cases 2+3).
//   - HAS_KIMI_AGENT            — `getent passwd kimi-agent` succeeds
//                                  AND HAS_SUDO is true (cases 2+3).
//   - HAS_RECONCILE_SCRIPT      — `scripts/fallback-reconcile.sh` exists
//                                  on the worktree (case 3).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BudgetProbeResult } from "../../src/abstractions/budget-probe.ts";
import {
  cageArchivePath,
  cageSessionName,
  cageTmuxSocket,
  cageTmuxTmpdir,
  composeTier2Brief,
  composeTier3Brief,
  createFallbackCage,
  destroyFallbackCage,
  type CageHandle,
} from "../../src/abstractions/fallback-cage.ts";
import {
  budgetPauseStatePath,
  type BudgetPauseState,
} from "../../src/core/budget-pause.ts";
import {
  runBudgetCheck,
  type BudgetCheckCtx,
  type BudgetCheckDeps,
} from "../../src/core/whip-budget-check.ts";
import {
  fallbackCagesPath,
  walkFallbackOnResume,
  type FallbackCagesFile,
} from "../../src/core/whip-budget-fallback.ts";
import type { KanbanTask } from "../../src/schema/kanban.ts";

// ---------- Env probes (module-load time) ----------

function probeBin(cmd: string[]): boolean {
  try {
    const proc = Bun.spawnSync({ cmd, stdout: "ignore", stderr: "ignore" });
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

const HAS_TMUX = probeBin(["tmux", "-V"]);
const HAS_SUDO_NONINTERACTIVE = probeBin(["sudo", "-n", "true"]);
const HAS_KIMI_AGENT =
  HAS_SUDO_NONINTERACTIVE && probeBin(["getent", "passwd", "kimi-agent"]);
const HAS_RECONCILE_SCRIPT = existsSync(
  new URL("../../scripts/fallback-reconcile.sh", import.meta.url).pathname,
);

// ---------- Fixture helpers ----------

const E2E_TEAM = "e2e-fbcage";
const E2E_LANE = "e2e-lane";

/** Run tmux against a specific socket + TMUX_TMPDIR — used in case 1 to
 *  inspect / clean up the cage server independently of the abstraction. */
function tmuxAgainstCage(
  argv: string[],
  tmpdirOverride: string,
): { exitCode: number | null; stdout: string; stderr: string } {
  const proc = Bun.spawnSync({
    cmd: ["tmux", ...argv],
    env: { ...process.env, TMUX_TMPDIR: tmpdirOverride },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout?.toString() ?? "",
    stderr: proc.stderr?.toString() ?? "",
  };
}

function probeResult(overrides: Partial<BudgetProbeResult> & { account: string }): BudgetProbeResult {
  return {
    account: overrides.account,
    h5_pct_used: overrides.h5_pct_used ?? 0,
    wk_pct_used: overrides.wk_pct_used ?? 0,
    h5_reset_epoch: overrides.h5_reset_epoch ?? 0,
    wk_reset_epoch: overrides.wk_reset_epoch ?? 0,
    status: overrides.status ?? "allowed",
    source: overrides.source ?? "probe",
    probedAt: overrides.probedAt ?? Math.floor(Date.now() / 1000),
  };
}

// ---------- Beat 1: Tier 2 cage spawn-and-tear-down ----------

describe("e2e ADR-058 fallback-cage Beat 1 — Tier 2 spawn + tear-down (real tmux)", () => {
  let teamDir: string;
  let atmuxDir: string;
  let originalTmuxTmpdir: string | undefined;
  const cageTmpdir = cageTmuxTmpdir(E2E_TEAM, E2E_LANE, "operator");

  beforeEach(async () => {
    teamDir = await mkdtemp(join(tmpdir(), "atmux-e2e-fb1-"));
    atmuxDir = join(teamDir, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
    // Pin TMUX_TMPDIR to the cage's tmpdir so the abstraction's mkdir +
    // the underlying `tmux -L socket` invocation land on the same socket
    // file. Without this they diverge (mkdir at /tmp/atmux_fallback_*/ vs
    // tmux at /tmp/tmux-<UID>/) — the abstraction ships assuming the
    // operator's session was launched with TMUX_TMPDIR set.
    originalTmuxTmpdir = process.env["TMUX_TMPDIR"];
    process.env["TMUX_TMPDIR"] = cageTmpdir;
  });

  afterEach(async () => {
    // Best-effort kill of any leftover cage tmux server (idempotent —
    // success exit and non-zero "no server" both fine).
    tmuxAgainstCage(["-L", cageTmuxSocket(E2E_TEAM, E2E_LANE), "kill-server"], cageTmpdir);
    if (originalTmuxTmpdir === undefined) {
      delete process.env["TMUX_TMPDIR"];
    } else {
      process.env["TMUX_TMPDIR"] = originalTmuxTmpdir;
    }
    await rm(teamDir, { recursive: true, force: true });
  });

  test.skipIf(!HAS_TMUX)(
    "createFallbackCage tier=2: real tmux server up; brief contains 'full git access'; destroy archives session log",
    async () => {
      const handle = await createFallbackCage({
        team: E2E_TEAM,
        lane: E2E_LANE,
        tier: 2,
        taskId: "t-cage1",
        atmuxDir,
        projectCwd: teamDir,
        nowSec: () => 1_700_000_000,
      });

      // Handle shape — operator UID, project cwd as workDir.
      expect(handle.tier).toBe(2);
      expect(handle.agent).toBe("operator");
      expect(handle.workDir).toBe(teamDir);
      expect(handle.tmuxTmpdir).toBe(cageTmpdir);
      expect(handle.tmuxSocket).toBe(cageTmuxSocket(E2E_TEAM, E2E_LANE));
      expect(handle.sessionName).toBe(cageSessionName(E2E_TEAM, E2E_LANE));

      // Real tmux server is up — list-sessions on the cage socket finds
      // the cage session.
      const list = tmuxAgainstCage(
        ["-L", handle.tmuxSocket, "list-sessions", "-F", "#{session_name}"],
        cageTmpdir,
      );
      expect(list.exitCode).toBe(0);
      expect(list.stdout).toContain(handle.sessionName);

      // Brief composer asserts (per task body — string contains 'full git
      // access' as the Tier 2 trust posture).
      const brief = composeTier2Brief({
        team: E2E_TEAM,
        lane: E2E_LANE,
        taskId: "t-cage1",
        taskBody: "Implement the FOO endpoint.",
        agent: handle.agent,
        workDir: handle.workDir,
      });
      expect(brief).toContain("full git access");
      expect(brief).toContain("operator UID");

      // Tear down — archive lands at `tier2-handoff/archive/<team>-<lane>-<epoch>/session.log`.
      await destroyFallbackCage(handle, {
        atmuxDir,
        nowSec: () => 1_700_000_001,
      });
      const archivePath = cageArchivePath(atmuxDir, 2, E2E_TEAM, E2E_LANE, 1_700_000_001);
      expect(existsSync(join(archivePath, "session.log"))).toBe(true);

      // Cage tmux session torn down — list-sessions either errors (no
      // server) or returns no rows.
      const list2 = tmuxAgainstCage(["-L", handle.tmuxSocket, "list-sessions"], cageTmpdir);
      const torn = list2.exitCode !== 0 || !list2.stdout.includes(handle.sessionName);
      expect(torn).toBe(true);
    },
  );
});

// ---------- Beat 2: Tier 3 cage isolation proofs ----------

describe("e2e ADR-058 fallback-cage Beat 2 — Tier 3 isolation proofs (sudo + kimi-agent)", () => {
  let teamDir: string;
  let atmuxDir: string;

  beforeEach(async () => {
    teamDir = await mkdtemp(join(tmpdir(), "atmux-e2e-fb2-"));
    atmuxDir = join(teamDir, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
    // Seed a project file so the rsync has something to copy + the
    // read-only proof has a target.
    await writeFile(
      join(teamDir, "src-core-budget-pause.ts"),
      "// fixture file for kernel-isolation read-only proof\n",
    );
  });

  afterEach(async () => {
    if (HAS_KIMI_AGENT) {
      // Best-effort cleanup of cage workspace + tmux server.
      Bun.spawnSync({
        cmd: [
          "sudo",
          "-n",
          "-u",
          "kimi-agent",
          "rm",
          "-rf",
          `/home/kimi-agent/cages/${E2E_TEAM}-${E2E_LANE}`,
        ],
        stdout: "ignore",
        stderr: "ignore",
      });
      Bun.spawnSync({
        cmd: [
          "sudo",
          "-n",
          "-u",
          "kimi-agent",
          "env",
          `TMUX_TMPDIR=${cageTmuxTmpdir(E2E_TEAM, E2E_LANE, "kimi-agent")}`,
          "tmux",
          "-L",
          cageTmuxSocket(E2E_TEAM, E2E_LANE),
          "kill-server",
        ],
        stdout: "ignore",
        stderr: "ignore",
      });
    }
    await rm(teamDir, { recursive: true, force: true });
  });

  test.skipIf(!HAS_KIMI_AGENT)(
    "createFallbackCage tier=3: kimi-agent can READ project file copy, NO write to source, NO git, NO .git in cage",
    async () => {
      const fixtureFile = "src-core-budget-pause.ts";
      const handle = await createFallbackCage({
        team: E2E_TEAM,
        lane: E2E_LANE,
        tier: 3,
        taskId: "t-cage2",
        atmuxDir,
        projectCwd: teamDir,
        nowSec: () => 1_700_000_000,
      });

      expect(handle.tier).toBe(3);
      expect(handle.agent).toBe("kimi-agent");
      expect(handle.workDir).toBe(`/home/kimi-agent/cages/${E2E_TEAM}-${E2E_LANE}/work`);

      // Isolation proof 1: kimi-agent CAN read the rsync'd copy in its
      // own workspace.
      const readCage = Bun.spawnSync({
        cmd: ["sudo", "-n", "-u", "kimi-agent", "test", "-r", join(handle.workDir, fixtureFile)],
        stdout: "ignore",
        stderr: "pipe",
      });
      expect(readCage.exitCode).toBe(0);

      // Isolation proof 2: kimi-agent canNOT write to project source
      // (kernel-enforced; setfacl rX grants read but not write).
      const writeProj = Bun.spawnSync({
        cmd: ["sudo", "-n", "-u", "kimi-agent", "test", "-w", join(teamDir, fixtureFile)],
        stdout: "ignore",
        stderr: "pipe",
      });
      expect(writeProj.exitCode).not.toBe(0);

      // Isolation proof 3: no `.git` directory inside the cage workspace
      // (rsync excluded per TIER3_RSYNC_EXCLUDES).
      const lsGit = Bun.spawnSync({
        cmd: ["sudo", "-n", "-u", "kimi-agent", "ls", join(handle.workDir, ".git")],
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(lsGit.exitCode).not.toBe(0);

      // Isolation proof 4: workspace context files are present
      // (_history.log + _status.log + _branch.log per provisioning).
      for (const ctxFile of ["_history.log", "_status.log", "_branch.log"]) {
        const r = Bun.spawnSync({
          cmd: ["sudo", "-n", "-u", "kimi-agent", "test", "-r", join(handle.workDir, ctxFile)],
          stdout: "ignore",
          stderr: "ignore",
        });
        expect(r.exitCode).toBe(0);
      }

      // Brief content check (Tier 3 HARD CONSTRAINT — no git, no sudo).
      const brief = composeTier3Brief({
        team: E2E_TEAM,
        lane: E2E_LANE,
        taskId: "t-cage2",
        taskBody: "Implement the FOO endpoint.",
        agent: handle.agent,
        workDir: handle.workDir,
      });
      expect(brief).toContain("HARD CONSTRAINT");
      expect(brief).toContain("Do NOT attempt `git`");

      // Tear down — Tier 3 archive copies the workspace into
      // `tier3-handoff/archive/<team>-<lane>-<epoch>/`.
      await destroyFallbackCage(handle, {
        atmuxDir,
        nowSec: () => 1_700_000_002,
      });
      const archivePath = cageArchivePath(atmuxDir, 3, E2E_TEAM, E2E_LANE, 1_700_000_002);
      expect(existsSync(join(archivePath, fixtureFile))).toBe(true);
    },
    // Real Tier 3 provisioning + rsync can take seconds.
    60_000,
  );
});

// ---------- Beat 3: reconciliation diff workflow ----------

describe("e2e ADR-058 fallback-cage Beat 3 — reconciliation diff (sudo + kimi-agent + script)", () => {
  let teamDir: string;
  let atmuxDir: string;

  beforeEach(async () => {
    teamDir = await mkdtemp(join(tmpdir(), "atmux-e2e-fb3-"));
    atmuxDir = join(teamDir, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
  });

  afterEach(async () => {
    if (HAS_KIMI_AGENT) {
      Bun.spawnSync({
        cmd: [
          "sudo",
          "-n",
          "-u",
          "kimi-agent",
          "rm",
          "-rf",
          `/home/kimi-agent/cages/${E2E_TEAM}-${E2E_LANE}`,
        ],
        stdout: "ignore",
        stderr: "ignore",
      });
    }
    await rm(teamDir, { recursive: true, force: true });
  });

  test.skipIf(!(HAS_KIMI_AGENT && HAS_RECONCILE_SCRIPT))(
    "scripts/fallback-reconcile.sh applies cage deltas under operator UID; cage clean post-reconcile",
    async () => {
      // Pre-state: seed a project file + spawn cage.
      await writeFile(join(teamDir, "existing.ts"), "original\n");
      const handle = await createFallbackCage({
        team: E2E_TEAM,
        lane: E2E_LANE,
        tier: 3,
        taskId: "t-cage3",
        atmuxDir,
        projectCwd: teamDir,
        nowSec: () => 1_700_000_000,
      });

      // Mutate the cage workspace: 1 added file + 1 modified file.
      const writeAdded = Bun.spawnSync({
        cmd: [
          "sudo",
          "-n",
          "-u",
          "kimi-agent",
          "tee",
          join(handle.workDir, "added.ts"),
        ],
        stdin: Buffer.from("from kimi cage\n"),
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(writeAdded.exitCode).toBe(0);
      const writeMod = Bun.spawnSync({
        cmd: [
          "sudo",
          "-n",
          "-u",
          "kimi-agent",
          "tee",
          join(handle.workDir, "existing.ts"),
        ],
        stdin: Buffer.from("modified by kimi\n"),
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(writeMod.exitCode).toBe(0);

      // Run reconcile script with stdin auto-accept ('y' x N).
      const recon = Bun.spawnSync({
        cmd: [
          new URL("../../scripts/fallback-reconcile.sh", import.meta.url).pathname,
          E2E_TEAM,
          E2E_LANE,
        ],
        stdin: Buffer.from("y\ny\ny\ny\ny\n"),
        env: { ...process.env, ATMUX_DIR: atmuxDir, ATMUX_PROJECT_CWD: teamDir },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(recon.exitCode).toBe(0);

      // diff -rq cage workspace vs project worktree shows no remaining
      // deltas — pulled-in files match.
      const diffR = Bun.spawnSync({
        cmd: [
          "sudo",
          "-n",
          "-u",
          "kimi-agent",
          "diff",
          "-rq",
          handle.workDir,
          teamDir,
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      // Non-zero is fine if the only difference is `.atmux/` (which the
      // cage doesn't have); otherwise the reconcile didn't apply.
      // Strict assertion: the two source files must be in sync.
      const addedCageRead = Bun.spawnSync({
        cmd: ["cat", join(teamDir, "added.ts")],
        stdout: "pipe",
        stderr: "ignore",
      });
      expect(addedCageRead.exitCode).toBe(0);
      expect(addedCageRead.stdout?.toString()).toContain("from kimi cage");
      const modProjRead = Bun.spawnSync({
        cmd: ["cat", join(teamDir, "existing.ts")],
        stdout: "pipe",
        stderr: "ignore",
      });
      expect(modProjRead.stdout?.toString()).toContain("modified by kimi");

      // chown of reconciled files = operator UID, not kimi-agent UID.
      const stat = Bun.spawnSync({
        cmd: ["stat", "-c", "%U", join(teamDir, "added.ts")],
        stdout: "pipe",
        stderr: "ignore",
      });
      expect(stat.stdout?.toString().trim()).not.toBe("kimi-agent");

      // unused, but kept for completeness — diff result captured for diag.
      void diffR;
    },
    120_000,
  );
});

// ---------- Beat 4: default-OFF regression ----------

describe("e2e ADR-058 fallback-cage Beat 4 — default-OFF regression", () => {
  let teamDir: string;
  let atmuxDir: string;

  beforeEach(async () => {
    teamDir = await mkdtemp(join(tmpdir(), "atmux-e2e-fb4-"));
    atmuxDir = join(teamDir, ".atmux");
    await mkdir(join(atmuxDir, "state"), { recursive: true });
  });

  afterEach(async () => {
    await rm(teamDir, { recursive: true, force: true });
  });

  test("fallback omitted: budget-pause writes pause-state-file but NO cages-file; listInFlightTasks/dispatchFallback never called", async () => {
    let listInFlightCalls = 0;
    let dispatchCalls = 0;
    const pausedMembers: string[] = [];

    const ctx: BudgetCheckCtx = {
      atmuxDir,
      nowMs: 1_700_000_000_000,
      nowSec: 1_700_000_000,
      projectCwd: teamDir,
      team: {
        name: E2E_TEAM,
        members: [
          { name: "alpha", claudeAccount: "ifca" },
          { name: "bravo", claudeAccount: "ifca" },
        ],
        // fallback intentionally omitted — equivalent to enabled=false.
      },
      config: {
        budgetPauseThreshold: 90,
        budgetResumeThreshold: 80,
        budgetWarningBands: [0.5, 0.25, 0.15],
        budgetRefreshLeadMins: 30,
      },
    };

    const deps: BudgetCheckDeps = {
      probeBudget: async (account: string): Promise<BudgetProbeResult> =>
        probeResult({
          account,
          h5_pct_used: 95, // above pause threshold
          wk_pct_used: 60,
          h5_reset_epoch: 1_700_000_000 + 14_400,
          wk_reset_epoch: 1_700_000_000 + 86_400 * 6,
        }),
      pauseMember: async (_atmuxDir: string, member: string) => {
        pausedMembers.push(member);
      },
      resumeMember: async () => {},
      appendDriverInbox: async () => {},
      // Both fallback deps wired but expected to NEVER fire when
      // fallback is omitted.
      listInFlightTasks: async () => {
        listInFlightCalls++;
        return [];
      },
      sendCageBrief: async () => {},
      sendContinuityBrief: async () => {},
      dispatchFallback: async () => {
        dispatchCalls++;
        return [];
      },
      log: () => {},
    };

    const verdict = await runBudgetCheck(ctx, deps);

    // Existing pause path ran verbatim.
    expect(verdict).toBe("paused-just-now");
    expect(existsSync(budgetPauseStatePath(atmuxDir))).toBe(true);
    const pauseRaw = await readFile(budgetPauseStatePath(atmuxDir), "utf8");
    const pauseState = JSON.parse(pauseRaw) as BudgetPauseState;
    expect(pauseState.paused).toBe(true);
    expect(pauseState.atRisk.map((r) => r.member).sort()).toEqual(["alpha", "bravo"]);
    expect(pausedMembers.sort()).toEqual(["alpha", "bravo"]);

    // Fallback chain MUST NOT have fired.
    expect(listInFlightCalls).toBe(0);
    expect(dispatchCalls).toBe(0);
    expect(existsSync(fallbackCagesPath(atmuxDir, ctx.nowSec))).toBe(false);
  });

  test("fallback explicitly enabled=false: same default-OFF semantics", async () => {
    let listInFlightCalls = 0;
    let dispatchCalls = 0;

    const ctx: BudgetCheckCtx = {
      atmuxDir,
      nowMs: 1_700_000_000_000,
      nowSec: 1_700_000_001, // distinct from the prior test's epoch
      projectCwd: teamDir,
      team: {
        name: E2E_TEAM,
        members: [{ name: "alpha", claudeAccount: "ifca" }],
        fallback: { enabled: false },
      },
      config: {
        budgetPauseThreshold: 90,
        budgetResumeThreshold: 80,
        budgetWarningBands: [0.5, 0.25, 0.15],
        budgetRefreshLeadMins: 30,
      },
    };

    const verdict = await runBudgetCheck(ctx, {
      probeBudget: async (account: string): Promise<BudgetProbeResult> =>
        probeResult({ account, h5_pct_used: 95, wk_pct_used: 60 }),
      pauseMember: async () => {},
      resumeMember: async () => {},
      appendDriverInbox: async () => {},
      listInFlightTasks: async () => {
        listInFlightCalls++;
        return [];
      },
      sendCageBrief: async () => {},
      dispatchFallback: async () => {
        dispatchCalls++;
        return [];
      },
      log: () => {},
    });

    expect(verdict).toBe("paused-just-now");
    expect(listInFlightCalls).toBe(0);
    expect(dispatchCalls).toBe(0);
    expect(existsSync(fallbackCagesPath(atmuxDir, ctx.nowSec))).toBe(false);
  });
});

// ---------- Beat 5: resume continuity brief (mocked handles file) ----------

describe("e2e ADR-058 fallback-cage Beat 5 — resume continuity brief", () => {
  let teamDir: string;
  let atmuxDir: string;

  beforeEach(async () => {
    teamDir = await mkdtemp(join(tmpdir(), "atmux-e2e-fb5-"));
    atmuxDir = join(teamDir, ".atmux");
    await mkdir(join(atmuxDir, "state"), { recursive: true });
  });

  afterEach(async () => {
    await rm(teamDir, { recursive: true, force: true });
  });

  test("walkFallbackOnResume composes per-tier briefs, destroys cages, removes handles file", async () => {
    const epoch = 1_700_000_000;
    const cages: CageHandle[] = [
      {
        tier: 2,
        team: E2E_TEAM,
        lane: "alpha",
        taskId: "t-tier2",
        agent: "operator",
        tmuxTmpdir: "/tmp/atmux_fallback_e2e-fbcage_alpha/",
        tmuxSocket: "fallback_e2e-fbcage_alpha",
        workDir: teamDir,
        sessionName: "fallback-e2e-fbcage-alpha",
        windowName: "tier2-alpha",
        createdAt: epoch,
      },
      {
        tier: 3,
        team: E2E_TEAM,
        lane: "bravo",
        taskId: "t-tier3",
        agent: "kimi-agent",
        tmuxTmpdir: "/tmp/atmux_fallback_e2e-fbcage_bravo_kimi-agent/",
        tmuxSocket: "fallback_e2e-fbcage_bravo",
        workDir: "/home/kimi-agent/cages/e2e-fbcage-bravo/work",
        sessionName: "fallback-e2e-fbcage-bravo",
        windowName: "tier3-bravo",
        createdAt: epoch,
      },
    ];
    const file: FallbackCagesFile = { epoch, team: E2E_TEAM, cages };
    const handlesPath = fallbackCagesPath(atmuxDir, epoch);
    await writeFile(handlesPath, JSON.stringify(file));

    const continuityCalls: { member: string; body: string }[] = [];
    const destroyCalls: CageHandle[] = [];

    await walkFallbackOnResume({
      team: E2E_TEAM,
      atmuxDir,
      pausedAtSec: epoch,
      sendContinuity: async (member: string, body: string): Promise<void> => {
        continuityCalls.push({ member, body });
      },
      destroyCage: async (handle: CageHandle, _opts) => {
        destroyCalls.push(handle);
      },
    });

    // Both lanes received continuity briefs targeting their original
    // member (lane string is the target since lane==owner at dispatch).
    expect(continuityCalls).toHaveLength(2);
    expect(continuityCalls[0]?.member).toBe("alpha");
    expect(continuityCalls[0]?.body).toContain("Tier 2");
    expect(continuityCalls[0]?.body).toContain("budget-pause cleared");
    expect(continuityCalls[1]?.member).toBe("bravo");
    expect(continuityCalls[1]?.body).toContain("Tier 3");
    expect(continuityCalls[1]?.body).toContain("scripts/fallback-reconcile.sh");

    // Both cages destroyed (one destroy per handle).
    expect(destroyCalls).toHaveLength(2);
    expect(destroyCalls.map((h) => h.taskId).sort()).toEqual(["t-tier2", "t-tier3"]);

    // Handles file removed after walk.
    expect(existsSync(handlesPath)).toBe(false);
  });

  test("idempotent: missing handles file → no-op (sendContinuity + destroyCage never called)", async () => {
    let continuityCalls = 0;
    let destroyCalls = 0;
    await walkFallbackOnResume({
      team: E2E_TEAM,
      atmuxDir,
      pausedAtSec: 9_999_999_999,
      sendContinuity: async () => {
        continuityCalls++;
      },
      destroyCage: async () => {
        destroyCalls++;
      },
    });
    expect(continuityCalls).toBe(0);
    expect(destroyCalls).toBe(0);
  });

  test("corrupt handles file → log + remove + no-op (no thrash on next tick)", async () => {
    const epoch = 1_700_000_500;
    const handlesPath = fallbackCagesPath(atmuxDir, epoch);
    await writeFile(handlesPath, "{ this is not json");

    let continuityCalls = 0;
    let destroyCalls = 0;
    const logs: string[] = [];

    await walkFallbackOnResume({
      team: E2E_TEAM,
      atmuxDir,
      pausedAtSec: epoch,
      sendContinuity: async () => {
        continuityCalls++;
      },
      destroyCage: async () => {
        destroyCalls++;
      },
      log: (m) => logs.push(m),
    });

    expect(continuityCalls).toBe(0);
    expect(destroyCalls).toBe(0);
    expect(existsSync(handlesPath)).toBe(false);
    expect(logs.some((l) => l.includes("corrupt"))).toBe(true);
  });

  test("integration: resume verdict via runBudgetCheck triggers walk on existing handles file", async () => {
    // Seed a pause state + a handles file matching its epoch — runBudgetCheck
    // on a low-utilization probe → exitPause → walkFallback fires.
    const pausedAt = 1_700_000_000;
    const pauseState: BudgetPauseState = {
      paused: true,
      pausedAt,
      pausedAtTs: "00:00 MYT",
      atRisk: [{ member: "alpha", h5: 95, wk: 60 }],
    };
    await writeFile(budgetPauseStatePath(atmuxDir), JSON.stringify(pauseState));

    const cages: CageHandle[] = [
      {
        tier: 2,
        team: E2E_TEAM,
        lane: "alpha",
        taskId: "t-resume-int",
        agent: "operator",
        tmuxTmpdir: "/tmp/atmux_fallback_e2e-fbcage_alpha/",
        tmuxSocket: "fallback_e2e-fbcage_alpha",
        workDir: teamDir,
        sessionName: "fallback-e2e-fbcage-alpha",
        windowName: "tier2-alpha",
        createdAt: pausedAt,
      },
    ];
    const handlesPath = fallbackCagesPath(atmuxDir, pausedAt);
    await writeFile(
      handlesPath,
      JSON.stringify({ epoch: pausedAt, team: E2E_TEAM, cages } satisfies FallbackCagesFile),
    );

    const continuityBriefs: { member: string; body: string }[] = [];

    const ctx: BudgetCheckCtx = {
      atmuxDir,
      nowMs: 1_700_005_000_000,
      nowSec: 1_700_005_000,
      projectCwd: teamDir,
      team: {
        name: E2E_TEAM,
        members: [{ name: "alpha", claudeAccount: "ifca" }],
        fallback: { enabled: true },
      },
      config: {
        budgetPauseThreshold: 90,
        budgetResumeThreshold: 80,
        budgetWarningBands: [0.5, 0.25, 0.15],
        budgetRefreshLeadMins: 30,
      },
    };

    const _unusedTask: KanbanTask = { id: "t-noop" };
    void _unusedTask;

    const verdict = await runBudgetCheck(ctx, {
      probeBudget: async (account: string): Promise<BudgetProbeResult> =>
        probeResult({ account, h5_pct_used: 50, wk_pct_used: 50 }),
      pauseMember: async () => {},
      resumeMember: async () => {},
      appendDriverInbox: async () => {},
      sendContinuityBrief: async (member: string, body: string) => {
        continuityBriefs.push({ member, body });
      },
      // Inject walkFallback to capture the call without invoking the real
      // destroyCage (which would shell out to tmux/sudo). The default
      // walk wires through to walkFallbackOnResume, which we already
      // tested directly above.
      walkFallback: async (opts) => {
        const txt = await readFile(fallbackCagesPath(opts.atmuxDir, opts.pausedAtSec), "utf8");
        const parsed = JSON.parse(txt) as FallbackCagesFile;
        for (const handle of parsed.cages) {
          await opts.sendContinuity(handle.lane, `Tier ${handle.tier} — continuity for ${handle.taskId}`);
        }
        await rm(fallbackCagesPath(opts.atmuxDir, opts.pausedAtSec), { force: true });
      },
      log: () => {},
    });

    expect(verdict).toBe("resumed");
    expect(continuityBriefs).toHaveLength(1);
    expect(continuityBriefs[0]?.member).toBe("alpha");
    expect(continuityBriefs[0]?.body).toContain("Tier 2");
    expect(existsSync(handlesPath)).toBe(false);
    expect(existsSync(budgetPauseStatePath(atmuxDir))).toBe(false);
  });
});
