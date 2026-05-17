// E2E ADR-050 §Acceptance gate (t-7c491368) — Tier 2 (Cursor) fallback
// lifecycle walk: opt-in gate → sustain threshold → spawn → brief
// composition → output capture path → resume continuity → idempotent
// teardown.
//
// **Stateful 1x cold-start+walk e2e — sequenced steps consume a fresh
// mkdtemp'd .atmux dir per fixture. Don't streak; don't run-of-N. Per
// CLAUDE.md testing discipline §"Stateful e2e specs are not repeatable
// smokes."** Step 3-5 + 7 are pure-injection (mocked `createCage` +
// `sendBrief` + `destroyCage` deps); no real `cursor-agent` binary,
// no real tmux server. Steps 1-2 are pure-function trigger evaluations.
//
// ---------------------------------------------------------------
// Layering finding (2026-05-15, t-7c491368 ship)
// ---------------------------------------------------------------
//
// ADR-050 was substantially absorbed into ADR-058 (multi-tier
// fallback). The **abstractions** (`src/abstractions/fallback-cage.ts`:
// `createFallbackCage`, `composeTier2Brief`, `cageArchivePath`,
// `cageTmuxTmpdir`, `cageTmuxSocket`) and the **multi-tier
// orchestration** (`src/core/whip-budget-fallback.ts`:
// `dispatchFallbackOnPause`, `walkFallbackOnResume`) live under
// ADR-058. The **ADR-050 v1 narrowed entry path**
// (`spawnFallbackCage`, `teardownFallbackCage`,
// `shouldDispatchFallback`, `fallbackCagesPathV1`) is the single-
// member, Tier-2-only wrapper this e2e walks.
//
// `tests/e2e/fallback-cage.test.ts` (sibling) exercises the ADR-058
// multi-tier surface + real-tmux Tier 2 spawn-and-tear-down with
// env-gated cases. This spec exercises the **ADR-050 v1 acceptance
// gate** verbatim against the v1 wrapper API — different layer, same
// underlying abstractions.
//
// ---------------------------------------------------------------
// Steps 6-7 carve-out (skip-with-pointer)
// ---------------------------------------------------------------
//
// Step 6 (resume continuity) requires `composeResumeBrief` —
// referenced by `src/core/whip-budget-fallback.ts:286` as future
// `src/core/fallback-resume.ts::composeResumeBrief` and not yet
// shipped (t-8ec31d4d still todo at ship-time of this spec). The
// Step 6 beat is included as `test.skip` with the unblock pointer
// inline; flip `.skip` to `.test` when t-8ec31d4d lands.
//
// Step 7 (idempotent teardown) IS shipped via
// `teardownFallbackCage`'s missing-handle no-op + the tmpdir-cleanup
// branch when the cages map empties. Asserted live.
//
// ---------------------------------------------------------------
// 7-step walk per ADR-050 §Acceptance (verbatim cell labels for
// runbook-rehearsal alignment per CLAUDE.md §Testing Discipline)
// ---------------------------------------------------------------
//
//   Step 1 — opt-in gate: enabled=false → no dispatch (reason
//            'fallback-disabled'); enabled=true + threshold met +
//            tasks present → dispatch=true.
//   Step 2 — sustain threshold: pauseSustainedMin < sustainMins →
//            no dispatch (reason 'sustain-not-reached'); ≥ → dispatch.
//   Step 3 — cage spawn: spawnFallbackCage with mocked createCage
//            persists CageHandle to fallback-cages-v1.json + invokes
//            createCage exactly once with the right opts shape.
//   Step 4 — brief composition: composeTier2Brief produces the §D4
//            brief shape (tier-2-specific guardrails + git policy +
//            reconciliation note + Task body + workDir).
//   Step 5 — output capture: archive path resolves to
//            `<atmuxDir>/tier2-handoff/archive/<team>-<lane>-<epoch>`
//            (ADR-058's collision-free per-destroy archive pattern;
//            ADR-050 §Output capture's
//            `<atmuxDir>/logs/fallback-cursor-<member>.log` is
//            superseded by the ADR-058 archive layout — the cage's
//            stdout/stderr land in the archive on teardown).
//   Step 6 — resume continuity: SKIPPED — composeResumeBrief
//            (t-8ec31d4d) not yet shipped. See skip body for unblock
//            checklist.
//   Step 7 — idempotent teardown: second teardownFallbackCage on
//            the same member is a no-op (no throw, no second destroy
//            call); cages-file removed when map empties.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CageHandle,
  type CreateFallbackCageOpts,
  cageArchivePath,
  composeTier2Brief,
  type FallbackTier,
} from "../../src/abstractions/fallback-cage.ts";
import {
  fallbackCagesPathV1,
  shouldDispatchFallback,
  spawnFallbackCage,
  teardownFallbackCage,
} from "../../src/core/whip-budget-fallback.ts";
import type { Team } from "../../src/schema/team.ts";

// ---------- Fixture ----------

interface Fixture {
  atmuxDir: string;
  projectCwd: string;
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "atmux-fb-cursor-"));
  const atmuxDir = join(root, ".atmux");
  await mkdir(join(atmuxDir, "state"), { recursive: true });
  return { atmuxDir, projectCwd: root };
}

let fix: Fixture;

afterEach(async () => {
  if (fix !== undefined) {
    // Clean both atmuxDir + projectCwd parent (mkdtemp root).
    await rm(join(fix.atmuxDir, ".."), { recursive: true, force: true });
  }
});

// ---------- Team factory ----------

interface TeamOpts {
  enabled?: boolean;
  sustainMins?: number;
}

function makeTeam(opts: TeamOpts = {}): Team {
  // Construct a minimal Team-shaped object directly (skip schema parse;
  // the underlying readers walk shape, not zod-instance). Mirrors the
  // pattern in tests/unit/core/whip-budget-fallback.test.ts.
  const enabled = opts.enabled ?? true;
  const sustainMins = opts.sustainMins ?? 30;
  return {
    name: "cursor-cage-e2e",
    members: [{ name: "fe-1", role: "member", lane: "fe" }],
    whip: {
      fallback: {
        enabled,
        sustainMins,
        tier: 2,
        cursorModel: "composer-2",
      },
    },
  } as unknown as Team;
}

// ---------- Mock createCage / sendBrief / destroyCage ----------

interface CageRig {
  /** spy: every createCage invocation. */
  createCalls: CreateFallbackCageOpts[];
  /** spy: every sendBrief invocation. */
  briefSends: Array<{ handle: CageHandle; body: string }>;
  /** spy: every destroyCage invocation. */
  destroyCalls: CageHandle[];
  /** Build a fixture handle for the given opts. */
  makeHandle(opts: CreateFallbackCageOpts): CageHandle;
  /** Pre-built deps for `spawnFallbackCage`. */
  spawnDeps: {
    createCage: (opts: CreateFallbackCageOpts) => Promise<CageHandle>;
    sendBrief: (handle: CageHandle, body: string) => Promise<void>;
  };
  /** Pre-built deps for `teardownFallbackCage`. */
  teardownDeps: {
    destroyCage: (handle: CageHandle) => Promise<void>;
  };
}

function makeRig(): CageRig {
  const createCalls: CreateFallbackCageOpts[] = [];
  const briefSends: Array<{ handle: CageHandle; body: string }> = [];
  const destroyCalls: CageHandle[] = [];
  const makeHandle = (opts: CreateFallbackCageOpts): CageHandle => ({
    tier: opts.tier as FallbackTier,
    team: opts.team,
    lane: opts.lane,
    taskId: opts.taskId,
    agent: "operator",
    tmuxTmpdir: `/tmp/atmux_fallback_${opts.team}_${opts.lane}/`,
    tmuxSocket: `fallback_${opts.team}_${opts.lane}`,
    workDir: opts.projectCwd,
    sessionName: `fallback-${opts.team}-${opts.lane}`,
    windowName: `tier${opts.tier}-${opts.lane}`,
    createdAt: 1_700_000_000,
  });
  return {
    createCalls,
    briefSends,
    destroyCalls,
    makeHandle,
    spawnDeps: {
      createCage: async (opts) => {
        createCalls.push(opts);
        return makeHandle(opts);
      },
      sendBrief: async (handle, body) => {
        briefSends.push({ handle, body });
      },
    },
    teardownDeps: {
      destroyCage: async (handle) => {
        destroyCalls.push(handle);
      },
    },
  };
}

// ============================================================
// Step 1 — opt-in gate
// ============================================================

describe("e2e ADR-050 fallback-cursor-cage Step 1 — opt-in gate", () => {
  test("Step 1 — opt-in gate: enabled=false suppresses dispatch with reason 'fallback-disabled'", () => {
    const team = makeTeam({ enabled: false, sustainMins: 30 });
    const result = shouldDispatchFallback({
      team,
      pauseSustainedMin: 60, // well past sustain
      inProgressTaskCount: 1,
    });
    expect(result.dispatch).toBe(false);
    expect(result.reason).toBe("fallback-disabled");
  });

  test("Step 1 — opt-in gate: enabled=true + threshold met + tasks present → dispatch=true", () => {
    const team = makeTeam({ enabled: true, sustainMins: 30 });
    const result = shouldDispatchFallback({
      team,
      pauseSustainedMin: 30,
      inProgressTaskCount: 1,
    });
    expect(result.dispatch).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});

// ============================================================
// Step 2 — sustain threshold
// ============================================================

describe("e2e ADR-050 fallback-cursor-cage Step 2 — sustain threshold", () => {
  test("Step 2 — sustain threshold: pause < sustainMins → no dispatch (reason 'sustain-not-reached')", () => {
    // Schema enforces sustainMins >= 5; use the floor + a sub-floor pause.
    const team = makeTeam({ enabled: true, sustainMins: 5 });
    const result = shouldDispatchFallback({
      team,
      pauseSustainedMin: 4,
      inProgressTaskCount: 1,
    });
    expect(result.dispatch).toBe(false);
    expect(result.reason).toBe("sustain-not-reached");
  });

  test("Step 2 — sustain threshold: pause ≥ sustainMins → dispatch fires", () => {
    const team = makeTeam({ enabled: true, sustainMins: 5 });
    const result = shouldDispatchFallback({
      team,
      pauseSustainedMin: 5,
      inProgressTaskCount: 1,
    });
    expect(result.dispatch).toBe(true);
  });

  test("Step 2 — sustain threshold: enabled+sustained but no in-progress tasks → no dispatch ('no-in-progress-tasks')", () => {
    const team = makeTeam({ enabled: true, sustainMins: 5 });
    const result = shouldDispatchFallback({
      team,
      pauseSustainedMin: 60,
      inProgressTaskCount: 0,
    });
    expect(result.dispatch).toBe(false);
    expect(result.reason).toBe("no-in-progress-tasks");
  });
});

// ============================================================
// Step 3 — cage spawn (mocked)
// ============================================================

describe("e2e ADR-050 fallback-cursor-cage Step 3 — cage spawn", () => {
  test("Step 3 — cage spawn: spawnFallbackCage persists CageHandle to v1 cages-file + invokes createCage with right opts shape", async () => {
    fix = await makeFixture();
    const team = makeTeam();
    const rig = makeRig();

    const handle = await spawnFallbackCage(
      {
        team,
        atmuxDir: fix.atmuxDir,
        projectCwd: fix.projectCwd,
        member: "fe-1",
        taskId: "t-step3",
      },
      rig.spawnDeps,
    );

    // (a) createCage invoked exactly once with the expected opts.
    expect(rig.createCalls).toHaveLength(1);
    const createOpts = rig.createCalls[0]!;
    expect(createOpts.team).toBe("cursor-cage-e2e");
    expect(createOpts.lane).toBe("fe-1"); // v1 lane resolution = member name
    expect(createOpts.tier).toBe(2);
    expect(createOpts.taskId).toBe("t-step3");
    expect(createOpts.atmuxDir).toBe(fix.atmuxDir);
    expect(createOpts.projectCwd).toBe(fix.projectCwd);

    // (b) returned handle wires through.
    expect(handle.tier).toBe(2);
    expect(handle.team).toBe("cursor-cage-e2e");
    expect(handle.taskId).toBe("t-step3");

    // (c) cages-file persisted at v1 path with the handle keyed by
    // <team>:<member>.
    const cagesPath = fallbackCagesPathV1(fix.atmuxDir);
    const body = await readFile(cagesPath, "utf8");
    const parsed = JSON.parse(body) as {
      schemaVersion: number;
      cages: Record<string, CageHandle>;
    };
    expect(parsed.schemaVersion).toBe(1);
    const persistedKey = "cursor-cage-e2e:fe-1";
    expect(parsed.cages[persistedKey]).toBeDefined();
    expect(parsed.cages[persistedKey]?.taskId).toBe("t-step3");
  });

  test("Step 3 — cage spawn: idempotent — second spawn for same <team>:<member> returns existing handle without re-create", async () => {
    fix = await makeFixture();
    const team = makeTeam();
    const rig = makeRig();
    const opts = {
      team,
      atmuxDir: fix.atmuxDir,
      projectCwd: fix.projectCwd,
      member: "fe-1",
      taskId: "t-step3-idem",
    };
    const first = await spawnFallbackCage(opts, rig.spawnDeps);
    const second = await spawnFallbackCage(opts, rig.spawnDeps);
    expect(rig.createCalls).toHaveLength(1); // second call short-circuited
    expect(second).toEqual(first);
  });
});

// ============================================================
// Step 4 — brief composition
// ============================================================

describe("e2e ADR-050 fallback-cursor-cage Step 4 — brief composition", () => {
  test("Step 4 — brief composition: composeTier2Brief carries §D4 sections (mission + scope + git policy + reconciliation)", () => {
    const brief = composeTier2Brief({
      team: "cursor-cage-e2e",
      lane: "fe-1",
      taskId: "t-step4",
      taskBody: "Implement the Step 4 widget per body.",
      agent: "operator",
      workDir: "/path/to/worktree",
    });
    // Tier-2 identification.
    expect(brief).toContain("Tier 2");
    expect(brief).toContain("Cursor");
    expect(brief).toContain("composer-2");
    // Header fields.
    expect(brief).toContain("Team: `cursor-cage-e2e`");
    expect(brief).toContain("Lane: `fe-1`");
    expect(brief).toContain("Task: `t-step4`");
    expect(brief).toContain("/path/to/worktree");
    // §D4 sections.
    expect(brief).toContain("## Mission");
    expect(brief).toContain("Implement the Step 4 widget per body.");
    expect(brief).toContain("## Scope guardrails");
    expect(brief).toContain("## Git policy");
    expect(brief).toContain("## Reconciliation");
    // Tier-2 git posture.
    expect(brief).toContain("operator UID");
    expect(brief).toContain("full git access");
  });

  test("Step 4 — brief composition: brief is delivered through spawnFallbackCage's sendBrief hook when supplied", async () => {
    fix = await makeFixture();
    const team = makeTeam();
    const rig = makeRig();
    const brief = composeTier2Brief({
      team: "cursor-cage-e2e",
      lane: "fe-1",
      taskId: "t-step4-deliver",
      taskBody: "Mission body for delivery.",
      agent: "operator",
      workDir: fix.projectCwd,
    });
    await spawnFallbackCage(
      {
        team,
        atmuxDir: fix.atmuxDir,
        projectCwd: fix.projectCwd,
        member: "fe-1",
        taskId: "t-step4-deliver",
        brief,
      },
      rig.spawnDeps,
    );
    expect(rig.briefSends).toHaveLength(1);
    expect(rig.briefSends[0]?.body).toBe(brief);
    expect(rig.briefSends[0]?.handle.taskId).toBe("t-step4-deliver");
  });
});

// ============================================================
// Step 5 — output capture (archive path resolution)
// ============================================================

describe("e2e ADR-050 fallback-cursor-cage Step 5 — output capture", () => {
  test("Step 5 — output capture: cage archive path resolves under <atmuxDir>/tier2-handoff/archive/<team>-<lane>-<epoch>", async () => {
    fix = await makeFixture();
    const path = cageArchivePath(fix.atmuxDir, 2, "cursor-cage-e2e", "fe-1", 1_700_000_000);
    expect(path.startsWith(fix.atmuxDir)).toBe(true);
    expect(path).toContain("/tier2-handoff/archive/");
    expect(path.endsWith("/cursor-cage-e2e-fe-1-1700000000")).toBe(true);
  });
});

// ============================================================
// Step 6 — resume continuity (SKIPPED — t-8ec31d4d not shipped)
// ============================================================

describe("e2e ADR-050 fallback-cursor-cage Step 6 — resume continuity", () => {
  test.skip("Step 6 — resume continuity: composeResumeBrief produces 'while you were paused, fallback committed: <commits>' brief and pastes into member pane via safeSendKeys (gated on pane state per ADR-062)", () => {
    // ⚠️ SKIP — ADR-050 §Resume continuity composer is not yet shipped.
    // `src/core/fallback-resume.ts::composeResumeBrief` is the named
    // module; tracked by Task t-8ec31d4d (status=todo at ship-time of
    // this spec — see commit message + lead-outbox surfacing).
    //
    // When t-8ec31d4d lands:
    //   1. Drop `.skip` from this `test.skip`.
    //   2. Import `composeResumeBrief` from
    //      `../../src/core/fallback-resume.ts`.
    //   3. Beat: feed a fixture cage handle + git log diff +
    //      cage-output-log path; assert brief contains "While you were
    //      paused" + commit SHAs + log pointer.
    //   4. Beat: feed brief into a mocked safeSendKeys that gates on a
    //      pane-state classifier returning READY → assert send fires;
    //      returning BUSY → assert send defers.
    //   5. Pair with the Step 7 teardown beat — resume should
    //      `teardownFallbackCage` the resumed member's handle.
    //
    // The ADR-058 multi-tier sibling `walkFallbackOnResume` provides
    // the orchestration shell; v1's resume composer is the missing
    // last mile.
  });
});

// ============================================================
// Step 7 — idempotent teardown
// ============================================================

describe("e2e ADR-050 fallback-cursor-cage Step 7 — idempotent teardown", () => {
  test("Step 7 — idempotent teardown: second teardown on same member is no-op (no throw, no second destroy call), cages-file removed when map empties", async () => {
    fix = await makeFixture();
    const team = makeTeam();
    const rig = makeRig();
    const spawnOpts = {
      team,
      atmuxDir: fix.atmuxDir,
      projectCwd: fix.projectCwd,
      member: "fe-1",
      taskId: "t-step7",
    };
    await spawnFallbackCage(spawnOpts, rig.spawnDeps);

    // First teardown — destroyCage invoked once; cages-file removed
    // (single-cage map empties on the delete).
    await teardownFallbackCage({ team, atmuxDir: fix.atmuxDir, member: "fe-1" }, rig.teardownDeps);
    expect(rig.destroyCalls).toHaveLength(1);
    await expect(stat(fallbackCagesPathV1(fix.atmuxDir))).rejects.toThrow();

    // Second teardown — handle missing → log + no-op. No additional
    // destroyCage call. No throw.
    await teardownFallbackCage({ team, atmuxDir: fix.atmuxDir, member: "fe-1" }, rig.teardownDeps);
    expect(rig.destroyCalls).toHaveLength(1); // still 1
  });
});
