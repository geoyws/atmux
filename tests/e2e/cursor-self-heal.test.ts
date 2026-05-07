// E2E cursor self-heal pass walk (ADR-055 R1-T8 part 6).
//
// **Stateful 1x cold-start+walk e2e — sequenced beats consume probe
// outcomes + dedup state. Don't streak; don't run-of-N.** Per CLAUDE.md
// testing discipline §"Stateful e2e specs are not repeatable smokes."
//
// Walks the orchestrator (`core/cursor-self-heal::runSelfHealPass`)
// across realistic beats. Mocks the cursor-agent subprocess (no real
// Composer 2 invocation) — the orchestrator's wiring + state-file
// dedup + Discord template firings + reviewer-Task dispatch are
// what's under test.
//
// The whip-verb-level wiring (whip.ts::Check 7 selfHeal-enabled gate)
// is unit-tested via tests/unit/verbs/whip.test.ts default-config
// fixtures; this spec covers the orchestration layer end-to-end with
// the 3 v1 recipes (fix:team-json-schema-drift, fix:cron-pollution,
// fix:supervisor-missing) participating in synthetic broken-state
// scenarios.
//
// Beat ↔ test mapping (one beat per test() per CLAUDE.md "pair
// runbook beats with rehearsal spec steps" rule):
//   1. Cold start — no drift in any recipe → empty summary, no pings,
//      no state file written.
//   2. team.json schema drift — recipe fires, patch staged, reviewer
//      Task dispatched (priority p2, assignee=reviewer), 2 Discord
//      pings (attempt + success-result), dedup recorded.
//   3. Same-tick replay — dedup gate honored, no new pings, no new
//      Task, summary shows skipped-recent.
//   4. 25h-later replay — recipe re-fires; new patch path (different
//      ts), new reviewer Task, fresh dedup stamp.
//   5. Multi-recipe drift — team.json AND cron AND supervisor all
//      malformed; ALL three fire in a single pass; dedup state has
//      3 recipe ids; 6 pings (3 attempts + 3 results); 3 reviewer
//      Tasks dispatched.
//   6. Sad-path — recipe verify fails; failure-ping fires; flag
//      callback invoked; dedup STILL recorded (don't thrash on a
//      known-failing recipe within 24h).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pendingPatchDir,
  pendingPatchPath,
  runSelfHealPass,
} from "../../src/core/cursor-self-heal.ts";
import {
  cursorSelfHealStatePath,
  loadSelfHealState,
} from "../../src/core/cursor-self-heal-state.ts";
import { fixTeamJsonSchemaDriftRecipe } from "../../src/core/cursor-recipes/fix-team-json-schema-drift.ts";
import { makeFixCronPollutionRecipe } from "../../src/core/cursor-recipes/fix-cron-pollution.ts";
import { makeFixSupervisorMissingRecipe } from "../../src/core/cursor-recipes/fix-supervisor-missing.ts";
import { atomicWrite, ensureDir } from "../../src/abstractions/fs.ts";
import { emptyKanban } from "../../src/core/kanban.ts";
import type { CursorInvokeResult } from "../../src/abstractions/cursor.ts";
import type { CursorJob, GitPatch } from "../../src/core/cursor-recipes/types.ts";
import type { DiscordSendOpts } from "../../src/abstractions/discord.ts";

// ---------- Fixture builders ----------

const TEAM = "atmux-demo";
const NOW = 1_700_000_000;
const PROJECT_CWD = "/tmp/atmux-e2e-self-heal-cwd";

function validTeamJson(): string {
  return JSON.stringify({
    name: TEAM,
    members: [{ name: "alpha", role: "team-lead", tui: "claude", emoji: "🧭" }],
    whip: { staleMin: 90, leadMaxMin: 60 },
  });
}

function driftedTeamJson(): string {
  // Strict schema rejects unknown keys → drift fires.
  return JSON.stringify({
    name: TEAM,
    members: [{ name: "alpha", role: "team-lead", tui: "claude", emoji: "🧭" }],
    whip: { staleMin: 90, leadMaxMin: 60, mysteriousNewField: 42 },
  });
}

function malformedCron(): string {
  return [
    `# >>> atmux:team=${TEAM} — managed by atmux start; do not edit by hand`,
    `*/5 * * * * /usr/local/bin/atmux whip`,
    `# <<< atmux:team=${TEAM}`,
    `# <<< atmux:team=${TEAM}`, // duplicate end marker → triggers detect
  ].join("\n");
}

interface FakeCursorOpts {
  /** When true, return a non-empty patch touching team.json. */
  patchTeamJson?: boolean;
  /** When true, return an empty patch (matches cron + supervisor recipes). */
  emptyPatch?: boolean;
}

function fakeCursorInvoke(
  variant: FakeCursorOpts,
): (job: CursorJob) => Promise<CursorInvokeResult> {
  return async (job: CursorJob): Promise<CursorInvokeResult> => {
    let diff = "";
    let files: string[] = [];
    if (variant.patchTeamJson === true) {
      // Synthesise a clean team.json patch (the cursor-agent's output
      // simulated). The recipe's verify reads team.json from disk
      // post-cursor; for this beat we need the file on disk to be
      // schema-valid AFTER this fake "invocation" — that's done by
      // the test driver via writeFile before the verify step. Here
      // we just shape the patch return value.
      diff = "diff --git a/team.json b/team.json\n@@ -1 +1 @@\n-{}\n+{...}\n";
      files = ["team.json"];
    } else if (variant.emptyPatch === true) {
      diff = "";
      files = [];
    }
    void job;
    return {
      exitCode: 0,
      stdout: "{}",
      stderr: "",
      patch: { diff, files },
      tokensUsed: 1234,
      durationMs: 50,
    };
  };
}

interface CapturedSend {
  template: string;
  bullets: ReadonlyArray<string>;
}

// ---------- Walk ----------

describe("e2e cursor-self-heal pass walk (ADR-055 §D2)", () => {
  let atmuxDir: string;
  let projectCwd: string;
  let sends: CapturedSend[];
  let flags: Array<{ severity: string; body: string; flagId: string }>;
  const send = async (opts: DiscordSendOpts): Promise<void> => {
    sends.push({
      template: opts.template,
      bullets: opts.bullets ?? [],
    });
  };
  const raiseFlag = async (severity: "p2", body: string): Promise<{ flagId: string }> => {
    const flagId = `flag-${flags.length + 1}`;
    flags.push({ severity, body, flagId });
    return { flagId };
  };

  beforeEach(async () => {
    projectCwd = await mkdtemp(join(tmpdir(), "atmux-e2e-self-heal-"));
    atmuxDir = join(projectCwd, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
    await mkdir(join(atmuxDir, "state"), { recursive: true });
    await mkdir(join(atmuxDir, "logs"), { recursive: true });
    // Seed empty kanban so addTask works during stagePatchForReviewer.
    await atomicWrite(join(atmuxDir, "kanban.json"), JSON.stringify(emptyKanban()));
    sends = [];
    flags = [];
  });

  afterEach(async () => {
    await rm(projectCwd, { recursive: true, force: true });
  });

  // ---------- Beat 1: cold start, no drift ----------

  test("beat 1 — cold start with valid state → empty summary, no pings", async () => {
    await writeFile(join(atmuxDir, "team.json"), validTeamJson());

    const summary = await runSelfHealPass({
      atmuxDir,
      projectCwd,
      nowSec: NOW,
      teamName: TEAM,
      reviewerName: "reviewer",
      recipes: [
        fixTeamJsonSchemaDriftRecipe,
        makeFixCronPollutionRecipe({
          readCrontab: async () => null, // no crontab installed
          atmuxBin: "/usr/local/bin/atmux",
        }),
        makeFixSupervisorMissingRecipe({
          listWindows: async () => null, // tmux unreachable
        }),
      ],
      enabledRecipeIds: [
        "fix:team-json-schema-drift",
        "fix:cron-pollution",
        "fix:supervisor-missing",
      ],
      send,
      raiseFlag,
    });

    expect(summary.attempted).toBe(0);
    expect(summary.succeeded).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.skipped).toBe(3); // 3 recipes, all skipped-no-detect
    expect(sends).toHaveLength(0);
    expect(flags).toHaveLength(0);

    // No state file written (no fires happened).
    const persisted = await loadSelfHealState(atmuxDir);
    expect(persisted).toEqual({});
  });

  // ---------- Beat 2: team.json drift fires ----------

  test("beat 2 — team.json drift triggers schema-drift recipe end-to-end", async () => {
    await writeFile(join(atmuxDir, "team.json"), driftedTeamJson());

    const summary = await runSelfHealPass({
      atmuxDir,
      projectCwd,
      nowSec: NOW,
      teamName: TEAM,
      reviewerName: "reviewer",
      recipes: [fixTeamJsonSchemaDriftRecipe],
      enabledRecipeIds: ["fix:team-json-schema-drift"],
      send,
      raiseFlag,
      // Cursor "fixes" team.json — write the post-cursor file shape
      // before verify reads it back from disk.
      invokeCursorFn: async (job: CursorJob): Promise<CursorInvokeResult> => {
        await writeFile(join(atmuxDir, "team.json"), validTeamJson());
        void job;
        return {
          exitCode: 0,
          stdout: "{}",
          stderr: "",
          patch: {
            diff: "diff --git a/team.json b/team.json\n@@ -1 +1 @@\n-old\n+new\n",
            files: ["team.json"],
          },
          tokensUsed: 1500,
          durationMs: 60,
        };
      },
    });

    expect(summary.attempted).toBe(1);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(0);

    // Discord: 1 attempt + 1 success-result.
    expect(sends).toHaveLength(2);
    expect(sends[0]?.template).toBe("whip-self-heal-attempt");
    expect(sends[1]?.template).toBe("whip-self-heal-result");
    expect(sends[1]?.bullets[0]).toContain("patch staged");

    // Patch on disk at expected path.
    const patchPath = pendingPatchPath(atmuxDir, "fix:team-json-schema-drift", NOW);
    const patchContent = await readFile(patchPath, "utf8");
    expect(patchContent).toContain("diff --git a/team.json");

    // Reviewer Task in kanban with priority p2 + assignee=reviewer.
    const kanbanText = await readFile(join(atmuxDir, "kanban.json"), "utf8");
    const kanban = JSON.parse(kanbanText);
    const tasks = kanban.tasks as Array<{
      subject: string;
      owner: string | null;
      priority: number | null;
      body: string;
    }>;
    const reviewerTask = tasks.find((t) => t.subject.includes("fix:team-json-schema-drift"));
    expect(reviewerTask).toBeDefined();
    expect(reviewerTask?.owner).toBe("reviewer");
    expect(reviewerTask?.priority).toBe(2);
    expect(reviewerTask?.body).toContain(patchPath);

    // Dedup state recorded.
    const persisted = await loadSelfHealState(atmuxDir);
    expect(persisted["fix:team-json-schema-drift"]).toBe(NOW);

    // No flag raised on success.
    expect(flags).toHaveLength(0);
  });

  // ---------- Beat 3: same-tick replay — dedup gate ----------

  test("beat 3 — same-tick replay skipped by 24h dedup", async () => {
    await writeFile(join(atmuxDir, "team.json"), driftedTeamJson());
    // Pre-seed dedup state with a fire 5min ago (well within 24h).
    await atomicWrite(
      cursorSelfHealStatePath(atmuxDir),
      JSON.stringify({ "fix:team-json-schema-drift": NOW - 300 }),
    );

    const summary = await runSelfHealPass({
      atmuxDir,
      projectCwd,
      nowSec: NOW,
      teamName: TEAM,
      reviewerName: "reviewer",
      recipes: [fixTeamJsonSchemaDriftRecipe],
      enabledRecipeIds: ["fix:team-json-schema-drift"],
      send,
      raiseFlag,
      invokeCursorFn: fakeCursorInvoke({ patchTeamJson: true }),
    });

    expect(summary.attempted).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(summary.results[0]?.outcome).toBe("skipped-recent");
    expect(sends).toHaveLength(0);

    // No new patch on disk (dedup gate skipped before invocation).
    const dir = pendingPatchDir(atmuxDir);
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      entries = [];
    }
    expect(entries).toEqual([]);
  });

  // ---------- Beat 4: 25h-later replay — re-fires ----------

  test("beat 4 — re-fires after 24h dedup window elapses", async () => {
    await writeFile(join(atmuxDir, "team.json"), driftedTeamJson());
    // Pre-seed dedup state with a fire 25h ago.
    const oldFire = NOW - 25 * 3600;
    await atomicWrite(
      cursorSelfHealStatePath(atmuxDir),
      JSON.stringify({ "fix:team-json-schema-drift": oldFire }),
    );

    const summary = await runSelfHealPass({
      atmuxDir,
      projectCwd,
      nowSec: NOW,
      teamName: TEAM,
      reviewerName: "reviewer",
      recipes: [fixTeamJsonSchemaDriftRecipe],
      enabledRecipeIds: ["fix:team-json-schema-drift"],
      send,
      raiseFlag,
      invokeCursorFn: async (job: CursorJob): Promise<CursorInvokeResult> => {
        await writeFile(join(atmuxDir, "team.json"), validTeamJson());
        void job;
        return {
          exitCode: 0,
          stdout: "{}",
          stderr: "",
          patch: {
            diff: "diff --git a/team.json b/team.json\n@@ -1 +1 @@\n-old\n+new\n",
            files: ["team.json"],
          },
          tokensUsed: 1500,
          durationMs: 60,
        };
      },
    });

    expect(summary.succeeded).toBe(1);
    expect(sends).toHaveLength(2); // attempt + result

    // Dedup state restamped to NOW.
    const persisted = await loadSelfHealState(atmuxDir);
    expect(persisted["fix:team-json-schema-drift"]).toBe(NOW);
    expect(persisted["fix:team-json-schema-drift"]).not.toBe(oldFire);
  });

  // ---------- Beat 5: multi-recipe drift in one pass ----------

  test("beat 5 — all 3 recipes fire in a single pass; state + dispatches all land", async () => {
    // Drift in team.json.
    await writeFile(join(atmuxDir, "team.json"), driftedTeamJson());

    const summary = await runSelfHealPass({
      atmuxDir,
      projectCwd,
      nowSec: NOW,
      teamName: TEAM,
      sessionName: "atmux-session",
      reviewerName: "reviewer",
      recipes: [
        fixTeamJsonSchemaDriftRecipe,
        makeFixCronPollutionRecipe({
          readCrontab: async () => malformedCron(),
          atmuxBin: "/usr/local/bin/atmux",
        }),
        makeFixSupervisorMissingRecipe({
          // Session exists, lead present, supervisor missing.
          listWindows: async () => ["lead", "alpha"],
        }),
      ],
      enabledRecipeIds: [
        "fix:team-json-schema-drift",
        "fix:cron-pollution",
        "fix:supervisor-missing",
      ],
      send,
      raiseFlag,
      invokeCursorFn: async (job: CursorJob): Promise<CursorInvokeResult> => {
        // For the team.json recipe, fix the file on disk so verify
        // sees a clean post-cursor state. For the empty-allowlist
        // recipes (cron + supervisor), return empty patch.
        const isTeamJsonRecipe = job.fileAllowlist.includes("team.json");
        if (isTeamJsonRecipe) {
          await writeFile(join(atmuxDir, "team.json"), validTeamJson());
          return {
            exitCode: 0,
            stdout: "{}",
            stderr: "",
            patch: {
              diff: "diff --git a/team.json b/team.json\n@@ -1 +1 @@\n-old\n+new\n",
              files: ["team.json"],
            },
            tokensUsed: 1500,
            durationMs: 60,
          };
        }
        return {
          exitCode: 0,
          stdout: "{}",
          stderr: "",
          patch: { diff: "", files: [] },
          tokensUsed: 200,
          durationMs: 30,
        };
      },
    });

    expect(summary.attempted).toBe(3);
    expect(summary.succeeded).toBe(3);
    expect(summary.failed).toBe(0);

    // 6 Discord pings: 3 attempts + 3 results (one per recipe).
    expect(sends.filter((s) => s.template === "whip-self-heal-attempt")).toHaveLength(3);
    expect(sends.filter((s) => s.template === "whip-self-heal-result")).toHaveLength(3);

    // Dedup state has all 3 recipe ids.
    const persisted = await loadSelfHealState(atmuxDir);
    expect(persisted["fix:team-json-schema-drift"]).toBe(NOW);
    expect(persisted["fix:cron-pollution"]).toBe(NOW);
    expect(persisted["fix:supervisor-missing"]).toBe(NOW);

    // 3 reviewer Tasks dispatched.
    const kanbanText = await readFile(join(atmuxDir, "kanban.json"), "utf8");
    const kanban = JSON.parse(kanbanText);
    const tasks = kanban.tasks as Array<{
      subject: string;
      owner: string | null;
      priority: number | null;
    }>;
    const reviewTasks = tasks.filter((t) => t.subject.startsWith("cursor self-heal review:"));
    expect(reviewTasks).toHaveLength(3);
    for (const t of reviewTasks) {
      expect(t.owner).toBe("reviewer");
      expect(t.priority).toBe(2);
    }
  });

  // ---------- Beat 6: sad-path — verify fails ----------

  test("beat 6 — recipe verify fails → flag raised + failure-ping + dedup recorded", async () => {
    await writeFile(join(atmuxDir, "team.json"), driftedTeamJson());

    const summary = await runSelfHealPass({
      atmuxDir,
      projectCwd,
      nowSec: NOW,
      teamName: TEAM,
      reviewerName: "reviewer",
      recipes: [fixTeamJsonSchemaDriftRecipe],
      enabledRecipeIds: ["fix:team-json-schema-drift"],
      send,
      raiseFlag,
      // Fake cursor: claim a patch but DON'T write valid team.json on
      // disk → verify will re-parse the still-broken file and fail.
      invokeCursorFn: async (job: CursorJob): Promise<CursorInvokeResult> => {
        // Touch a non-allowlisted file — verify catches via allowlist
        // check (file: "src/cli.ts" not in ["team.json"]).
        void job;
        return {
          exitCode: 0,
          stdout: "{}",
          stderr: "",
          patch: {
            diff: "diff --git a/src/cli.ts b/src/cli.ts\n@@ -1 +1 @@\n-x\n+y\n",
            files: ["src/cli.ts"],
          },
          tokensUsed: 800,
          durationMs: 40,
        };
      },
    });

    expect(summary.failed).toBe(1);
    expect(summary.results[0]?.outcome).toBe("failed-verify");

    // Failure-ping fired (no success ping).
    const successPings = sends.filter(
      (s) =>
        s.template === "whip-self-heal-result" && s.bullets[0]?.includes("patch staged") === true,
    );
    expect(successPings).toHaveLength(0);
    const failPings = sends.filter(
      (s) =>
        s.template === "whip-self-heal-result" && s.bullets[0]?.includes("verify failed") === true,
    );
    expect(failPings).toHaveLength(1);

    // Flag raised at p2 with the verify reason.
    expect(flags).toHaveLength(1);
    expect(flags[0]?.severity).toBe("p2");
    expect(flags[0]?.body).toContain("fix:team-json-schema-drift");

    // Dedup STILL recorded (don't thrash on a known-failing recipe).
    const persisted = await loadSelfHealState(atmuxDir);
    expect(persisted["fix:team-json-schema-drift"]).toBe(NOW);

    // No reviewer Task dispatched (failure path skips stagePatch).
    const kanbanText = await readFile(join(atmuxDir, "kanban.json"), "utf8");
    const kanban = JSON.parse(kanbanText);
    const tasks = kanban.tasks as Array<{ subject: string }>;
    const reviewTasks = tasks.filter((t) => t.subject.startsWith("cursor self-heal review:"));
    expect(reviewTasks).toHaveLength(0);
  });
});
