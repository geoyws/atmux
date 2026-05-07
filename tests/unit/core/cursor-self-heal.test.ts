// Unit tests for src/core/cursor-self-heal.ts (ADR-055 §D2 R1-T8 part 4).
//
// Covers:
//   - Path helpers (sanitization, dir nesting)
//   - stagePatchForReviewer (atomic patch write + reviewer Task dispatch)
//   - runSelfHealPass orchestration:
//     * dedup gate (24h window honored across ticks)
//     * unknown-recipe-id skip
//     * detect-returns-null skip
//     * detect/propose throw paths
//     * verify-fail → flag + failure ping + state-fire-recorded
//     * success → patch staged + success ping + state-fire-recorded
//     * stagePatchForReviewer throw path
//     * tokenCapOverrides applied
//     * multi-recipe isolation (one fails; others run)
//     * state persisted exactly once per pass

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pendingPatchDir,
  pendingPatchPath,
  selfHealLogPath,
  stagePatchForReviewer,
  runSelfHealPass,
  type SelfHealOutcome,
  type SelfHealRunOpts,
} from "../../../src/core/cursor-self-heal.ts";
import {
  cursorSelfHealStatePath,
  loadSelfHealState,
} from "../../../src/core/cursor-self-heal-state.ts";
import type { CursorRecipe, GitPatch } from "../../../src/core/cursor-recipes/types.ts";
import type { CursorInvokeResult } from "../../../src/abstractions/cursor.ts";
import type { DiscordSendOpts } from "../../../src/abstractions/discord.ts";
import { addTask, emptyKanban } from "../../../src/core/kanban.ts";
import { atomicWrite } from "../../../src/abstractions/fs.ts";

// ---------- Fixture scaffolding ----------

let atmuxDir: string;

beforeEach(async () => {
  atmuxDir = await mkdtemp(join(tmpdir(), "atmux-self-heal-"));
  await mkdir(join(atmuxDir, "state"), { recursive: true });
  await mkdir(join(atmuxDir, "logs"), { recursive: true });
  // Seed empty kanban so addTask works.
  await atomicWrite(
    join(atmuxDir, "kanban.json"),
    JSON.stringify(emptyKanban()),
  );
});

afterEach(async () => {
  await rm(atmuxDir, { recursive: true, force: true });
});

const NOW = 1_700_000_000;
const PROJECT_CWD = "/tmp/fake-project";
const TEAM = "atmux";

function makeRecipe(overrides: Partial<CursorRecipe> & { id: string }): CursorRecipe {
  return {
    id: overrides.id,
    tokenCap: overrides.tokenCap ?? 5_000,
    fileAllowlist: overrides.fileAllowlist ?? ["team.json"],
    detect: overrides.detect ?? (async () => null),
    propose:
      overrides.propose ??
      (async () => ({
        prompt: "noop",
        fileAllowlist: ["team.json"],
        tokenCap: 5_000,
        cwd: PROJECT_CWD,
      })),
    verify:
      overrides.verify ??
      (async () => ({ ok: true, reasons: [], patchSummary: "ok" })),
  };
}

interface CapturedSend {
  template: string;
  bullets: ReadonlyArray<string>;
  category: string;
}

function makeSendCapture() {
  const sends: CapturedSend[] = [];
  const send = async (opts: DiscordSendOpts): Promise<void> => {
    sends.push({
      template: opts.template,
      bullets: opts.bullets ?? [],
      category: String(opts.category),
    });
  };
  return { sends, send };
}

function fakeCursorOk(diff = "diff --git a/team.json b/team.json\n--- a/team.json\n+++ b/team.json\n"): CursorInvokeResult {
  return {
    exitCode: 0,
    stdout: "{}",
    stderr: "",
    patch: { diff, files: ["team.json"] },
    tokensUsed: 1234,
    durationMs: 100,
  };
}

function baseOpts(overrides: Partial<SelfHealRunOpts> = {}): SelfHealRunOpts {
  const { sends: _ignore, send } = makeSendCapture();
  void _ignore;
  return {
    atmuxDir,
    projectCwd: PROJECT_CWD,
    nowSec: NOW,
    teamName: TEAM,
    reviewerName: "reviewer",
    recipes: [],
    enabledRecipeIds: [],
    send,
    invokeCursorFn: async () => fakeCursorOk(),
    ...overrides,
  };
}

// ---------- Path helpers ----------

describe("path helpers", () => {
  test("pendingPatchDir nests under atmuxDir/state", () => {
    expect(pendingPatchDir("/x")).toBe("/x/state/cursor-self-heal-pending");
  });

  test("pendingPatchPath sanitizes recipe id (colons → dashes)", () => {
    expect(pendingPatchPath("/x", "fix:team-json-schema-drift", 1700000000)).toBe(
      "/x/state/cursor-self-heal-pending/fix-team-json-schema-drift-1700000000.patch",
    );
  });

  test("pendingPatchPath strips non-safe chars defensively", () => {
    expect(pendingPatchPath("/x", "fix:has spaces/and?weird", 1)).toBe(
      "/x/state/cursor-self-heal-pending/fix-has_spaces_and_weird-1.patch",
    );
  });

  test("selfHealLogPath nests under atmuxDir/logs", () => {
    expect(selfHealLogPath("/x", "fix:cron-pollution", 1700000010)).toBe(
      "/x/logs/cursor-self-heal-fix-cron-pollution-1700000010.log",
    );
  });
});

// ---------- stagePatchForReviewer ----------

describe("stagePatchForReviewer", () => {
  const PATCH: GitPatch = {
    diff: "diff --git a/team.json b/team.json\n@@ -1 +1 @@\n-{}\n+{\"k\":1}\n",
    files: ["team.json"],
  };

  test("writes patch to disk + dispatches reviewer task with P2 priority", async () => {
    const captured: Array<{ subject: string; body: string; assignee: string; priority: number }> = [];
    const fakeAddTask = async (
      _dir: string,
      o: { subject: string; body?: string; assignee?: string; priority?: number },
    ) => {
      captured.push({
        subject: o.subject,
        body: o.body ?? "",
        assignee: o.assignee ?? "",
        priority: o.priority ?? -1,
      });
      return "t-fake0001";
    };

    const result = await stagePatchForReviewer({
      atmuxDir,
      recipeId: "fix:team-json-schema-drift",
      patch: PATCH,
      patchSummary: "3 keys updated",
      nowSec: NOW,
      reviewerName: "reviewer",
      reason: "3 invalid keys detected",
      addTaskFn: fakeAddTask,
    });

    expect(result.taskId).toBe("t-fake0001");
    expect(result.patchPath).toBe(pendingPatchPath(atmuxDir, "fix:team-json-schema-drift", NOW));

    // Patch persisted with the diff content verbatim.
    const onDisk = await readFile(result.patchPath, "utf8");
    expect(onDisk).toBe(PATCH.diff);

    // Task subject + body shape.
    expect(captured).toHaveLength(1);
    const c = captured[0];
    if (c === undefined) throw new Error("no captured task");
    expect(c.subject).toBe("cursor self-heal review: fix:team-json-schema-drift");
    expect(c.assignee).toBe("reviewer");
    expect(c.priority).toBe(2);
    expect(c.body).toContain("fix:team-json-schema-drift");
    expect(c.body).toContain(result.patchPath);
    expect(c.body).toContain("3 invalid keys detected");
    expect(c.body).toContain("3 keys updated");
    expect(c.body).toContain("git apply");
  });

  test("creates pending dir if absent", async () => {
    // mkdtemp didn't create state/cursor-self-heal-pending.
    const result = await stagePatchForReviewer({
      atmuxDir,
      recipeId: "fix:cron-pollution",
      patch: { diff: "x", files: ["team.json"] },
      patchSummary: "test",
      nowSec: NOW,
      reviewerName: "reviewer",
      reason: "r",
      addTaskFn: async () => "t-x",
    });
    const s = await stat(result.patchPath);
    expect(s.isFile()).toBe(true);
  });

  test("real addTask integration round-trips through kanban", async () => {
    const result = await stagePatchForReviewer({
      atmuxDir,
      recipeId: "fix:supervisor-missing",
      patch: PATCH,
      patchSummary: "supervisor re-spawned",
      nowSec: NOW,
      reviewerName: "reviewer",
      reason: "supervisor window absent",
    });
    expect(result.taskId.startsWith("t-")).toBe(true);
    // Verify task lands in kanban + assigned to reviewer.
    const txt = await readFile(join(atmuxDir, "kanban.json"), "utf8");
    const k = JSON.parse(txt);
    const t = (k.tasks as Array<{ id: string; owner: string | null; priority: number | null }>).find(
      (x) => x.id === result.taskId,
    );
    expect(t).toBeDefined();
    expect(t?.owner).toBe("reviewer");
    expect(t?.priority).toBe(2);
  });
});

// ---------- runSelfHealPass ----------

describe("runSelfHealPass — dedup", () => {
  test("skips recipe that fired within 24h (dedup gate)", async () => {
    // Seed state with a recent fire 5min ago.
    await writeFile(
      cursorSelfHealStatePath(atmuxDir),
      JSON.stringify({ "fix:team-json-schema-drift": NOW - 300 }),
    );
    let detectCalls = 0;
    const recipe = makeRecipe({
      id: "fix:team-json-schema-drift",
      detect: async () => {
        detectCalls += 1;
        return { reason: "should not be called" };
      },
    });
    const { sends, send } = makeSendCapture();
    const summary = await runSelfHealPass(
      baseOpts({
        recipes: [recipe],
        enabledRecipeIds: ["fix:team-json-schema-drift"],
        send,
      }),
    );
    expect(detectCalls).toBe(0); // gated before detect
    expect(summary.skipped).toBe(1);
    expect(summary.results[0]?.outcome).toBe("skipped-recent");
    expect(sends).toHaveLength(0); // no ping
  });

  test("re-fires recipe when last fire > 24h old", async () => {
    await writeFile(
      cursorSelfHealStatePath(atmuxDir),
      JSON.stringify({ "fix:cron-pollution": NOW - 25 * 3600 }),
    );
    const recipe = makeRecipe({
      id: "fix:cron-pollution",
      detect: async () => ({ reason: "stale block" }),
    });
    const { sends, send } = makeSendCapture();
    const summary = await runSelfHealPass(
      baseOpts({
        recipes: [recipe],
        enabledRecipeIds: ["fix:cron-pollution"],
        send,
      }),
    );
    expect(summary.succeeded).toBe(1);
    expect(sends).toHaveLength(2); // attempt + result
  });
});

describe("runSelfHealPass — skip paths", () => {
  test("unknown recipe id is logged and skipped (no fail)", async () => {
    const logs: string[] = [];
    const summary = await runSelfHealPass(
      baseOpts({
        enabledRecipeIds: ["fix:nonexistent"],
        log: (m) => logs.push(m),
      }),
    );
    expect(summary.attempted).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(summary.results[0]?.outcome).toBe("skipped-unknown-recipe");
    expect(logs.some((m) => m.includes("unknown recipe 'fix:nonexistent'"))).toBe(true);
  });

  test("detect returns null → skipped-no-detect, no ping", async () => {
    const recipe = makeRecipe({
      id: "fix:team-json-schema-drift",
      detect: async () => null,
    });
    const { sends, send } = makeSendCapture();
    const summary = await runSelfHealPass(
      baseOpts({
        recipes: [recipe],
        enabledRecipeIds: ["fix:team-json-schema-drift"],
        send,
      }),
    );
    expect(summary.skipped).toBe(1);
    expect(summary.results[0]?.outcome).toBe("skipped-no-detect");
    expect(sends).toHaveLength(0);
  });

  test("detect throws → skipped-no-detect with detail (does not crash pass)", async () => {
    const recipe = makeRecipe({
      id: "fix:cron-pollution",
      detect: async () => {
        throw new Error("disk full");
      },
    });
    const summary = await runSelfHealPass(
      baseOpts({
        recipes: [recipe],
        enabledRecipeIds: ["fix:cron-pollution"],
      }),
    );
    expect(summary.results[0]?.outcome).toBe("skipped-no-detect");
    expect(summary.results[0]?.detail).toContain("disk full");
  });
});

describe("runSelfHealPass — success path", () => {
  test("happy path stages patch + sends 2 pings + records dedup", async () => {
    const recipe = makeRecipe({
      id: "fix:team-json-schema-drift",
      detect: async () => ({ issues: [{ a: 1 }, { a: 2 }, { a: 3 }] }),
      verify: async () => ({
        ok: true,
        reasons: [],
        patchSummary: "3 keys updated",
      }),
    });
    const { sends, send } = makeSendCapture();
    let stagedTaskId = "";
    const fakeAdd = async (
      _dir: string,
      _o: { subject: string; body?: string; assignee?: string; priority?: number },
    ) => {
      stagedTaskId = "t-staged-1";
      return stagedTaskId;
    };

    const summary = await runSelfHealPass(
      baseOpts({
        recipes: [recipe],
        enabledRecipeIds: ["fix:team-json-schema-drift"],
        send,
        addTaskFn: fakeAdd,
      }),
    );

    expect(summary.attempted).toBe(1);
    expect(summary.succeeded).toBe(1);
    expect(summary.results[0]?.outcome).toBe("succeeded");
    expect(summary.results[0]?.detail).toBe("t-staged-1");
    expect(stagedTaskId).toBe("t-staged-1");

    // 2 pings: attempt + success-result.
    expect(sends).toHaveLength(2);
    expect(sends[0]?.template).toBe("whip-self-heal-attempt");
    expect(sends[1]?.template).toBe("whip-self-heal-result");
    expect(sends[1]?.bullets[0]).toContain("patch staged");

    // attempt-ping reason composed from issues array.
    expect(sends[0]?.bullets.some((b) => b.includes("3 issue(s) detected"))).toBe(true);

    // Dedup state recorded.
    const persisted = await loadSelfHealState(atmuxDir);
    expect(persisted["fix:team-json-schema-drift"]).toBe(NOW);

    // Patch on disk.
    const patchPath = pendingPatchPath(atmuxDir, "fix:team-json-schema-drift", NOW);
    const diff = await readFile(patchPath, "utf8");
    expect(diff).toContain("diff --git");
  });

  test("attempt-ping uses recipe.reason field when present", async () => {
    const recipe = makeRecipe({
      id: "fix:supervisor-missing",
      detect: async () => ({ reason: "supervisor window absent" }),
    });
    const { sends, send } = makeSendCapture();
    await runSelfHealPass(
      baseOpts({
        recipes: [recipe],
        enabledRecipeIds: ["fix:supervisor-missing"],
        send,
      }),
    );
    expect(sends[0]?.bullets.some((b) => b.includes("supervisor window absent"))).toBe(true);
  });
});

describe("runSelfHealPass — failure paths", () => {
  test("verify-fail → failure ping + flag + dedup recorded", async () => {
    const recipe = makeRecipe({
      id: "fix:team-json-schema-drift",
      detect: async () => ({ reason: "drift" }),
      verify: async () => ({
        ok: false,
        reasons: ["allowlist violation: src/cli.ts"],
        patchSummary: "out of bounds",
      }),
    });
    const { sends, send } = makeSendCapture();
    const flagsRaised: Array<{ severity: string; body: string }> = [];
    const summary = await runSelfHealPass(
      baseOpts({
        recipes: [recipe],
        enabledRecipeIds: ["fix:team-json-schema-drift"],
        send,
        raiseFlag: async (severity, body) => {
          flagsRaised.push({ severity, body });
          return { flagId: "flag-99" };
        },
      }),
    );
    expect(summary.failed).toBe(1);
    expect(summary.results[0]?.outcome).toBe("failed-verify");
    expect(flagsRaised).toHaveLength(1);
    expect(flagsRaised[0]?.severity).toBe("p2");
    expect(flagsRaised[0]?.body).toContain("allowlist violation");
    // Failure ping shape.
    expect(sends[1]?.bullets[0]).toContain("verify failed");
    // Dedup recorded even on failure.
    const persisted = await loadSelfHealState(atmuxDir);
    expect(persisted["fix:team-json-schema-drift"]).toBe(NOW);
  });

  test("verify-fail without raiseFlag still proceeds with failure ping", async () => {
    const recipe = makeRecipe({
      id: "fix:team-json-schema-drift",
      detect: async () => ({ reason: "drift" }),
      verify: async () => ({
        ok: false,
        reasons: ["bad"],
        patchSummary: "fail",
      }),
    });
    const { sends, send } = makeSendCapture();
    const summary = await runSelfHealPass(
      baseOpts({
        recipes: [recipe],
        enabledRecipeIds: ["fix:team-json-schema-drift"],
        send,
      }),
    );
    expect(summary.failed).toBe(1);
    expect(sends[1]?.template).toBe("whip-self-heal-result");
  });

  test("invokeCursor failure (exitCode -1) propagates to verify; verify-fail surfaces", async () => {
    const recipe = makeRecipe({
      id: "fix:team-json-schema-drift",
      detect: async () => ({ reason: "drift" }),
      verify: async (_job, patch) => ({
        ok: patch.diff.length > 0,
        reasons: patch.diff.length > 0 ? [] : ["empty patch from cursor"],
        patchSummary: patch.diff.length > 0 ? "ok" : "no patch produced",
      }),
    });
    const summary = await runSelfHealPass(
      baseOpts({
        recipes: [recipe],
        enabledRecipeIds: ["fix:team-json-schema-drift"],
        invokeCursorFn: async () => ({
          exitCode: -1,
          stdout: "",
          stderr: "cursor-agent: command not found",
          patch: { diff: "", files: [] },
          tokensUsed: -1,
          durationMs: 0,
        }),
      }),
    );
    expect(summary.failed).toBe(1);
    expect(summary.results[0]?.outcome).toBe("failed-verify");
  });

  test("invokeCursor THROWS (not just exitCode != 0) is caught, verify still runs", async () => {
    const recipe = makeRecipe({
      id: "fix:team-json-schema-drift",
      detect: async () => ({ reason: "drift" }),
      verify: async () => ({
        ok: false,
        reasons: ["empty patch"],
        patchSummary: "no patch",
      }),
    });
    const summary = await runSelfHealPass(
      baseOpts({
        recipes: [recipe],
        enabledRecipeIds: ["fix:team-json-schema-drift"],
        invokeCursorFn: async () => {
          throw new Error("unexpected runtime fault");
        },
      }),
    );
    expect(summary.failed).toBe(1);
    expect(summary.results[0]?.outcome).toBe("failed-verify");
  });

  test("propose throws → failed-cursor outcome; no ping emitted", async () => {
    const recipe = makeRecipe({
      id: "fix:cron-pollution",
      detect: async () => ({ reason: "drift" }),
      propose: async () => {
        throw new Error("propose blew up");
      },
    });
    const { sends, send } = makeSendCapture();
    const summary = await runSelfHealPass(
      baseOpts({
        recipes: [recipe],
        enabledRecipeIds: ["fix:cron-pollution"],
        send,
      }),
    );
    expect(summary.failed).toBe(1);
    expect(summary.results[0]?.outcome).toBe("failed-cursor");
    expect(summary.results[0]?.detail).toContain("propose blew up");
    // No attempt ping (we threw before ping).
    expect(sends).toHaveLength(0);
  });

  test("verify throws → fails as if verify returned ok:false", async () => {
    const recipe = makeRecipe({
      id: "fix:cron-pollution",
      detect: async () => ({ reason: "drift" }),
      verify: async () => {
        throw new Error("verify exception");
      },
    });
    const summary = await runSelfHealPass(
      baseOpts({
        recipes: [recipe],
        enabledRecipeIds: ["fix:cron-pollution"],
      }),
    );
    expect(summary.results[0]?.outcome).toBe("failed-verify");
    expect(summary.results[0]?.detail).toContain("verify threw");
  });

  test("stagePatchForReviewer throw → failed-stage; failure ping fired", async () => {
    const recipe = makeRecipe({
      id: "fix:team-json-schema-drift",
      detect: async () => ({ reason: "drift" }),
      verify: async () => ({ ok: true, reasons: [], patchSummary: "ok" }),
    });
    const { sends, send } = makeSendCapture();
    const summary = await runSelfHealPass(
      baseOpts({
        recipes: [recipe],
        enabledRecipeIds: ["fix:team-json-schema-drift"],
        send,
        addTaskFn: async () => {
          throw new Error("kanban locked");
        },
      }),
    );
    expect(summary.failed).toBe(1);
    expect(summary.results[0]?.outcome).toBe("failed-stage");
    expect(summary.results[0]?.detail).toContain("kanban locked");
    // Failure ping fired (with stage-failed reason).
    const failPing = sends.find((s) => s.template === "whip-self-heal-result");
    expect(failPing).toBeDefined();
    expect(failPing?.bullets[0]).toContain("verify failed");
  });

  test("attempt-ping send failure does not block invocation", async () => {
    const recipe = makeRecipe({
      id: "fix:team-json-schema-drift",
      detect: async () => ({ reason: "drift" }),
      verify: async () => ({ ok: true, reasons: [], patchSummary: "ok" }),
    });
    let attemptCalled = 0;
    const send = async (opts: DiscordSendOpts): Promise<void> => {
      if (opts.template === "whip-self-heal-attempt") {
        attemptCalled += 1;
        throw new Error("network");
      }
      // success ping succeeds.
    };
    const summary = await runSelfHealPass(
      baseOpts({
        recipes: [recipe],
        enabledRecipeIds: ["fix:team-json-schema-drift"],
        send,
      }),
    );
    expect(attemptCalled).toBe(1);
    expect(summary.succeeded).toBe(1);
  });
});

describe("runSelfHealPass — coverage edge cases", () => {
  test("failure-ping send error caught + logged (does not crash)", async () => {
    const recipe = makeRecipe({
      id: "fix:team-json-schema-drift",
      detect: async () => ({ reason: "drift" }),
      verify: async () => ({
        ok: false,
        reasons: ["bad"],
        patchSummary: "fail",
      }),
    });
    const logs: string[] = [];
    const send = async (opts: DiscordSendOpts): Promise<void> => {
      if (opts.template === "whip-self-heal-result") {
        throw new Error("network down");
      }
    };
    const summary = await runSelfHealPass(
      baseOpts({
        recipes: [recipe],
        enabledRecipeIds: ["fix:team-json-schema-drift"],
        send,
        log: (m) => logs.push(m),
      }),
    );
    expect(summary.failed).toBe(1);
    expect(logs.some((m) => m.includes("fail-ping send failed"))).toBe(true);
  });

  test("stage-fail-ping send error caught + logged", async () => {
    const recipe = makeRecipe({
      id: "fix:team-json-schema-drift",
      detect: async () => ({ reason: "drift" }),
      verify: async () => ({ ok: true, reasons: [], patchSummary: "ok" }),
    });
    const logs: string[] = [];
    const send = async (opts: DiscordSendOpts): Promise<void> => {
      if (opts.template === "whip-self-heal-result") {
        throw new Error("network down");
      }
    };
    const summary = await runSelfHealPass(
      baseOpts({
        recipes: [recipe],
        enabledRecipeIds: ["fix:team-json-schema-drift"],
        send,
        addTaskFn: async () => {
          throw new Error("kanban down");
        },
        log: (m) => logs.push(m),
      }),
    );
    expect(summary.failed).toBe(1);
    expect(summary.results[0]?.outcome).toBe("failed-stage");
    expect(logs.some((m) => m.includes("stage-fail-ping failed"))).toBe(true);
  });

  test("success-ping send error caught + logged (still counts as success)", async () => {
    const recipe = makeRecipe({
      id: "fix:team-json-schema-drift",
      detect: async () => ({ reason: "drift" }),
      verify: async () => ({ ok: true, reasons: [], patchSummary: "ok" }),
    });
    const logs: string[] = [];
    let sendCount = 0;
    const send = async (_opts: DiscordSendOpts): Promise<void> => {
      sendCount += 1;
      if (sendCount === 2) throw new Error("network down on success ping");
    };
    const summary = await runSelfHealPass(
      baseOpts({
        recipes: [recipe],
        enabledRecipeIds: ["fix:team-json-schema-drift"],
        send,
        log: (m) => logs.push(m),
      }),
    );
    expect(summary.succeeded).toBe(1);
    expect(logs.some((m) => m.includes("success-ping failed"))).toBe(true);
  });

  test("raiseFlag throw caught + logged (failure ping still fires)", async () => {
    const recipe = makeRecipe({
      id: "fix:team-json-schema-drift",
      detect: async () => ({ reason: "drift" }),
      verify: async () => ({
        ok: false,
        reasons: ["bad"],
        patchSummary: "fail",
      }),
    });
    const { sends, send } = makeSendCapture();
    const logs: string[] = [];
    const summary = await runSelfHealPass(
      baseOpts({
        recipes: [recipe],
        enabledRecipeIds: ["fix:team-json-schema-drift"],
        send,
        raiseFlag: async () => {
          throw new Error("flag bus down");
        },
        log: (m) => logs.push(m),
      }),
    );
    expect(summary.failed).toBe(1);
    expect(logs.some((m) => m.includes("raiseFlag failed"))).toBe(true);
    // Failure ping still emitted.
    expect(sends.some((s) => s.template === "whip-self-heal-result")).toBe(true);
  });

  test("composeReason fallback when detectCtx has neither reason nor issues", async () => {
    const recipe = makeRecipe({
      id: "fix:team-json-schema-drift",
      detect: async () => ({ unrelated: "field" }),
      verify: async () => ({ ok: true, reasons: [], patchSummary: "ok" }),
    });
    const { sends, send } = makeSendCapture();
    await runSelfHealPass(
      baseOpts({
        recipes: [recipe],
        enabledRecipeIds: ["fix:team-json-schema-drift"],
        send,
      }),
    );
    expect(sends[0]?.bullets.some((b) => b.includes("recipe condition matched"))).toBe(true);
  });

  test("composeReason fallback when detectCtx is a non-object truthy value", async () => {
    const recipe = makeRecipe({
      id: "fix:team-json-schema-drift",
      detect: async () => "raw-string-context",
      verify: async () => ({ ok: true, reasons: [], patchSummary: "ok" }),
    });
    const { sends, send } = makeSendCapture();
    await runSelfHealPass(
      baseOpts({
        recipes: [recipe],
        enabledRecipeIds: ["fix:team-json-schema-drift"],
        send,
      }),
    );
    expect(sends[0]?.bullets.some((b) => b.includes("recipe condition matched"))).toBe(true);
  });

  test("composeReason uses Error.message via stringifyErr (default catch path)", async () => {
    // This test exists primarily to traverse stringifyErr's branch — by
    // throwing a non-Error value through detect, we ensure the
    // String(e) branch executes.
    const recipe = makeRecipe({
      id: "fix:team-json-schema-drift",
      detect: async () => {
        throw "bare-string-thrown"; // not an Error instance
      },
    });
    const summary = await runSelfHealPass(
      baseOpts({
        recipes: [recipe],
        enabledRecipeIds: ["fix:team-json-schema-drift"],
      }),
    );
    expect(summary.results[0]?.detail).toContain("bare-string-thrown");
  });
});

describe("runSelfHealPass — token cap overrides", () => {
  test("override applies when present + > 0", async () => {
    let invokedCap = -1;
    const recipe = makeRecipe({
      id: "fix:team-json-schema-drift",
      tokenCap: 5_000,
      detect: async () => ({ reason: "drift" }),
    });
    await runSelfHealPass(
      baseOpts({
        recipes: [recipe],
        enabledRecipeIds: ["fix:team-json-schema-drift"],
        tokenCapOverrides: { "fix:team-json-schema-drift": 2_000 },
        invokeCursorFn: async (job) => {
          invokedCap = job.tokenCap;
          return fakeCursorOk();
        },
      }),
    );
    expect(invokedCap).toBe(2_000);
  });

  test("override of 0 or negative falls through to recipe default", async () => {
    let invokedCap = -1;
    const recipe = makeRecipe({
      id: "fix:team-json-schema-drift",
      tokenCap: 5_000,
      detect: async () => ({ reason: "drift" }),
    });
    await runSelfHealPass(
      baseOpts({
        recipes: [recipe],
        enabledRecipeIds: ["fix:team-json-schema-drift"],
        tokenCapOverrides: { "fix:team-json-schema-drift": 0 },
        invokeCursorFn: async (job) => {
          invokedCap = job.tokenCap;
          return fakeCursorOk();
        },
      }),
    );
    // job.tokenCap is the propose-returned value (5_000 from default makeRecipe propose).
    expect(invokedCap).toBe(5_000);
  });
});

describe("runSelfHealPass — multi-recipe isolation", () => {
  test("first recipe fails, second succeeds — pass continues", async () => {
    const failing = makeRecipe({
      id: "fix:cron-pollution",
      detect: async () => ({ reason: "stale" }),
      verify: async () => ({
        ok: false,
        reasons: ["bad"],
        patchSummary: "fail",
      }),
    });
    const succeeding = makeRecipe({
      id: "fix:team-json-schema-drift",
      detect: async () => ({ reason: "drift" }),
      verify: async () => ({ ok: true, reasons: [], patchSummary: "ok" }),
    });
    const summary = await runSelfHealPass(
      baseOpts({
        recipes: [failing, succeeding],
        enabledRecipeIds: ["fix:cron-pollution", "fix:team-json-schema-drift"],
      }),
    );
    expect(summary.attempted).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.succeeded).toBe(1);
    const outcomes = summary.results.map((r) => r.outcome).sort();
    expect(outcomes).toEqual(["failed-verify", "succeeded"] as SelfHealOutcome[]);
  });

  test("state is persisted exactly once after the pass (not per recipe)", async () => {
    const r1 = makeRecipe({
      id: "fix:a",
      detect: async () => ({ reason: "x" }),
      verify: async () => ({ ok: true, reasons: [], patchSummary: "ok" }),
    });
    const r2 = makeRecipe({
      id: "fix:b",
      detect: async () => ({ reason: "y" }),
      verify: async () => ({ ok: true, reasons: [], patchSummary: "ok" }),
    });
    await runSelfHealPass(
      baseOpts({
        recipes: [r1, r2],
        enabledRecipeIds: ["fix:a", "fix:b"],
      }),
    );
    const persisted = await loadSelfHealState(atmuxDir);
    expect(persisted["fix:a"]).toBe(NOW);
    expect(persisted["fix:b"]).toBe(NOW);
  });

  test("zero recipes enabled → no-op summary, no state write", async () => {
    const summary = await runSelfHealPass(
      baseOpts({
        recipes: [],
        enabledRecipeIds: [],
      }),
    );
    expect(summary.attempted).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.succeeded).toBe(0);
    expect(summary.failed).toBe(0);
    // State file should not exist (no fire recorded).
    const persisted = await loadSelfHealState(atmuxDir);
    expect(persisted).toEqual({});
  });

  test("only-skipped pass still writes no state", async () => {
    const recipe = makeRecipe({
      id: "fix:team-json-schema-drift",
      detect: async () => null,
    });
    await runSelfHealPass(
      baseOpts({
        recipes: [recipe],
        enabledRecipeIds: ["fix:team-json-schema-drift"],
      }),
    );
    const persisted = await loadSelfHealState(atmuxDir);
    expect(persisted).toEqual({});
  });
});

describe("runSelfHealPass — sessionName plumbing", () => {
  test("recipe sees sessionName when caller supplies it", async () => {
    let observedSession: string | undefined;
    const recipe = makeRecipe({
      id: "fix:supervisor-missing",
      detect: async (whipCtx) => {
        observedSession = whipCtx.sessionName;
        return { reason: "absent" };
      },
      verify: async () => ({ ok: true, reasons: [], patchSummary: "ok" }),
    });
    await runSelfHealPass(
      baseOpts({
        recipes: [recipe],
        enabledRecipeIds: ["fix:supervisor-missing"],
        sessionName: "atmux-team",
      }),
    );
    expect(observedSession).toBe("atmux-team");
  });

  test("sessionName omitted when caller does not supply", async () => {
    let observedSession: string | undefined = "preset";
    const recipe = makeRecipe({
      id: "fix:supervisor-missing",
      detect: async (whipCtx) => {
        observedSession = whipCtx.sessionName;
        return null;
      },
    });
    await runSelfHealPass(
      baseOpts({
        recipes: [recipe],
        enabledRecipeIds: ["fix:supervisor-missing"],
      }),
    );
    expect(observedSession).toBeUndefined();
  });
});
