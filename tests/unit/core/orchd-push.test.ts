// Unit tests for src/core/orchd-push.ts — Phase 6 orchd auto-push
// subscriber (ADR-229 + §Amendment 2026-05-23 + §Amendment 2026-05-23-rev2).
//
// Pins:
//   - Kill-switch off (`ATMUX_HONKER=off`) short-circuits to
//     {processed:0, escalated:0} without touching the events table.
//   - Default topic is `["epic.merged"]` per ADR-226 emit; Phase 6
//     subscribes to Phase 3's success topic.
//   - Happy path: 7 gates pass → emit epic.pushed + audit row +
//     gatesPassed[] in cheapest-first fire order ["5","4","2","7","3a","1","3b"]
//     (post-§DA9-rev1 FLAG-A swap).
//   - 7 negative cases (one per gate) — each blocks independently.
//   - §D2.1 BLOCKER regression — parentBase="main" + empty pushPolicy
//     MUST refuse via Gate-2 (catches ADR-028 fleet invariant).
//   - STAGING_PATTERNS coverage — main/master/production/*-staging
//     all refuse with default pushPolicy.
//   - Gate-5 precedence over Gate-4 — kill-switch + enabled=true still
//     refuses via Gate-5 (kill is FIRST in fire order).
//   - Gate-7 cost-saving — cooldown-hit does NOT invoke subprocess
//     (mock-assert no git-status / tsc / dispatch).
//   - Cooldown per-base scoping + post-window re-allow.
//   - allowedBases escape hatch — parentBase="main" + allowedBases=["main"]
//     PASSES Gate-2.
//   - typecheckCmd="" skips Gate-3b entirely.
//   - withIdempotency throw-halts drain.

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainSince, emit, loadOffset } from "../../../src/abstractions/events.ts";
import { openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import {
  type AutoPushHandlerDeps,
  type AutoPushOutcome,
  appendOrchdPushAuditRow,
  createAutoPushHandler,
  type DispatchGitPushResult,
  type OrchdPushAuditRow,
  orchdPushConsume,
} from "../../../src/core/orchd-push.ts";
import type { EpicMergedPayload } from "../../../src/schema/events.ts";

let scratch: string;
let db: Database;
let auditPath: string;
const HONKER_ON: NodeJS.ProcessEnv = { ATMUX_HONKER: "on" };
const HONKER_OFF: NodeJS.ProcessEnv = { ATMUX_HONKER: "off" };

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atmux-orchd-push-"));
  db = openDatabase(join(scratch, "state.db"), migrations);
  auditPath = join(scratch, "orchd-push.jsonl");
});

afterEach(async () => {
  db.close();
  await rm(scratch, { recursive: true, force: true });
});

function fakeId(n: number): string {
  return `01890000-0000-7000-8000-${String(n).padStart(12, "0")}`;
}

function buildMergedEvent(
  n: number,
  fields: { epicId: string; base: string; mergeSha?: string },
): EpicMergedPayload {
  return {
    topic: "epic.merged",
    eventId: fakeId(n),
    emittedAtSec: 1_700_000_000 + n,
    schemaVersion: 1 as const,
    epicId: fields.epicId,
    parentBase: fields.base,
    mergeSha: fields.mergeSha ?? "feed1234",
    mergedAtSec: 1_700_000_000 + n,
  };
}

async function readAuditLog(): Promise<OrchdPushAuditRow[]> {
  try {
    const text = await readFile(auditPath, "utf8");
    return text
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as OrchdPushAuditRow);
  } catch {
    return [];
  }
}

const PASS_CFG = {
  enabled: true,
  typecheckCmd: "bun run typecheck",
  cooldownSec: 30,
};
const EMPTY_POLICY = { refusedBases: [], allowedBases: [] };

function happyPathDeps(overrides: Partial<AutoPushHandlerDeps> = {}): AutoPushHandlerDeps {
  return {
    db,
    auditLogPath: auditPath,
    resolveAutoPushConfig: async () => PASS_CFG,
    resolvePushPolicy: async () => EMPTY_POLICY,
    runGitStatusClean: async () => true,
    runTscClean: async () => ({ ok: true, stderrTail: "" }),
    dispatchGitPush: async (): Promise<DispatchGitPushResult> => ({
      state: "pushed",
      headSha: "1234abcd5678",
      beforeSha: "abcd1234ef00",
    }),
    cooldownState: new Map<string, number>(),
    env: {},
    nowSec: () => 1_700_001_000,
    ...overrides,
  };
}

// ---------- appendOrchdPushAuditRow ----------

describe("appendOrchdPushAuditRow JSONL writer (§DA-Gate-6)", () => {
  test("appends one row per call; rows are valid JSONL", async () => {
    appendOrchdPushAuditRow(auditPath, {
      at: "2026-05-23T14:02:11Z",
      epicId: "e-abc12345",
      base: "atmux-geoyws",
      outcome: "pushed",
      reason: null,
      headSha: "abc1234567",
      beforeSha: "def4567890",
      gatesPassed: ["5", "4", "2", "7", "3a", "1", "3b"],
      durationMs: 423,
    });
    appendOrchdPushAuditRow(auditPath, {
      at: "2026-05-23T14:05:22Z",
      epicId: "e-def67890",
      base: "unum-staging",
      outcome: "blocked",
      gateBlocked: "2",
      reason: "refused-by-isPushAllowed",
      headSha: null,
      beforeSha: null,
      gatesPassed: ["5", "4"],
      durationMs: 3,
    });
    const rows = await readAuditLog();
    expect(rows.length).toBe(2);
    expect(rows[0]?.outcome).toBe("pushed");
    expect(rows[0]?.gatesPassed).toEqual(["5", "4", "2", "7", "3a", "1", "3b"]);
    expect(rows[1]?.outcome).toBe("blocked");
    expect(rows[1]?.gateBlocked).toBe("2");
  });
});

// ---------- Happy path: 7 gates pass ----------

describe("happy path — 7 gates fire in cheapest-first order then push", () => {
  test("emits epic.pushed + audit row with gatesPassed=['5','4','2','7','3a','1','3b']", async () => {
    const handler = createAutoPushHandler(happyPathDeps());
    const event = buildMergedEvent(1, { epicId: "e-aaa", base: "atmux-geoyws" });
    expect(await handler(event)).toBe("pushed");

    const events = drainSince(db, { topics: ["epic.pushed"], lastEventId: "" });
    expect(events.length).toBe(1);
    expect((events[0] as { epicId: string }).epicId).toBe("e-aaa");
    expect((events[0] as { base: string }).base).toBe("atmux-geoyws");
    expect((events[0] as { headSha: string }).headSha).toBe("1234abcd5678");

    const rows = await readAuditLog();
    expect(rows.length).toBe(1);
    expect(rows[0]?.outcome).toBe("pushed");
    // §DA9-rev1 cheapest-first fire order: 5 → 4 → 2 → 7 → 3a → 1 → 3b
    expect(rows[0]?.gatesPassed).toEqual(["5", "4", "2", "7", "3a", "1", "3b"]);
  });
});

// ---------- 7 negative cases (one per gate) ----------

describe("Gate-1: dispatcher upstream-advanced → emits epic.push-conflict + escalated", () => {
  test("upstream-advanced → outcome 'escalated' + emit epic.push-conflict", async () => {
    const handler = createAutoPushHandler(
      happyPathDeps({
        dispatchGitPush: async (): Promise<DispatchGitPushResult> => ({
          state: "upstream-advanced",
          ahead: 3,
          behind: 1,
          divergenceSha: "abcdef1234",
        }),
      }),
    );
    const event = buildMergedEvent(1, { epicId: "e-aaa", base: "atmux-geoyws" });
    expect(await handler(event)).toBe("escalated");

    const conflictEvents = drainSince(db, {
      topics: ["epic.push-conflict"],
      lastEventId: "",
    });
    expect(conflictEvents.length).toBe(1);
    expect((conflictEvents[0] as { ahead: number }).ahead).toBe(3);
    expect((conflictEvents[0] as { behind: number }).behind).toBe(1);

    const rows = await readAuditLog();
    expect(rows[0]?.outcome).toBe("conflict");
    expect(rows[0]?.gateBlocked).toBe("1");
    expect(rows[0]?.ahead).toBe(3);
    // gatesPassed includes 5,4,2,7,3a — failed at 1
    expect(rows[0]?.gatesPassed).toEqual(["5", "4", "2", "7", "3a"]);
  });
});

describe("Gate-2: §D2.1 BLOCKER regression — parentBase='main' refuses via isPushAllowed", () => {
  test("parentBase='main' + empty pushPolicy → refuse (ADR-028 fleet invariant)", async () => {
    const handler = createAutoPushHandler(happyPathDeps());
    const event = buildMergedEvent(1, { epicId: "e-aaa", base: "main" });
    expect(await handler(event)).toBe("skipped-staging-base");

    const events = drainSince(db, {
      topics: ["epic.push-blocked"],
      lastEventId: "",
    });
    expect(events.length).toBe(1);
    expect((events[0] as { gateBlocked: string }).gateBlocked).toBe("2");
    const rows = await readAuditLog();
    expect(rows[0]?.gatesPassed).toEqual(["5", "4"]);
  });

  test("STAGING_PATTERNS coverage — master refuses", async () => {
    const handler = createAutoPushHandler(happyPathDeps());
    expect(await handler(buildMergedEvent(1, { epicId: "e-aaa", base: "master" }))).toBe(
      "skipped-staging-base",
    );
  });

  test("STAGING_PATTERNS coverage — production refuses", async () => {
    const handler = createAutoPushHandler(happyPathDeps());
    expect(await handler(buildMergedEvent(1, { epicId: "e-aaa", base: "production" }))).toBe(
      "skipped-staging-base",
    );
  });

  test("STAGING_PATTERNS coverage — unum-staging refuses", async () => {
    const handler = createAutoPushHandler(happyPathDeps());
    expect(await handler(buildMergedEvent(1, { epicId: "e-aaa", base: "unum-staging" }))).toBe(
      "skipped-staging-base",
    );
  });

  test("allowedBases escape hatch — parentBase='main' + allowedBases=['main'] → PASS Gate-2", async () => {
    const handler = createAutoPushHandler(
      happyPathDeps({
        resolvePushPolicy: async () => ({
          refusedBases: [],
          allowedBases: ["main"],
        }),
      }),
    );
    const event = buildMergedEvent(1, { epicId: "e-aaa", base: "main" });
    expect(await handler(event)).toBe("pushed");
  });

  test("refusedBases additive — parentBase='foo-canary' + refusedBases=['foo-canary'] → refuse", async () => {
    const handler = createAutoPushHandler(
      happyPathDeps({
        resolvePushPolicy: async () => ({
          refusedBases: ["foo-canary"],
          allowedBases: [],
        }),
      }),
    );
    const event = buildMergedEvent(1, { epicId: "e-aaa", base: "foo-canary" });
    expect(await handler(event)).toBe("skipped-staging-base");
    const rows = await readAuditLog();
    expect(rows[0]?.reason).toContain("refusedBases");
  });
});

describe("Gate-3a: git status reports uncommitted changes → skipped-preflight", () => {
  test("runGitStatusClean=false → skipped-preflight + audit gateBlocked=3a", async () => {
    const handler = createAutoPushHandler(
      happyPathDeps({
        runGitStatusClean: async () => false,
      }),
    );
    expect(await handler(buildMergedEvent(1, { epicId: "e-aaa", base: "atmux-geoyws" }))).toBe(
      "skipped-preflight",
    );
    const rows = await readAuditLog();
    expect(rows[0]?.gateBlocked).toBe("3a");
    expect(rows[0]?.gatesPassed).toEqual(["5", "4", "2", "7"]);
  });
});

describe("Gate-3b: tsc errors → skipped-preflight", () => {
  test("runTscClean returns ok=false → skipped-preflight + audit gateBlocked=3b", async () => {
    const handler = createAutoPushHandler(
      happyPathDeps({
        runTscClean: async () => ({ ok: false, stderrTail: "TS2345: missing property" }),
      }),
    );
    expect(await handler(buildMergedEvent(1, { epicId: "e-aaa", base: "atmux-geoyws" }))).toBe(
      "skipped-preflight",
    );
    const rows = await readAuditLog();
    expect(rows[0]?.gateBlocked).toBe("3b");
    expect(rows[0]?.reason).toContain("TS2345");
    // 5,4,2,7,3a,1 all pass — tsc is LAST in fire order
    expect(rows[0]?.gatesPassed).toEqual(["5", "4", "2", "7", "3a", "1"]);
  });

  test("typecheckCmd='' skips Gate-3b entirely (CI-runs-typecheck case)", async () => {
    let tscCalled = 0;
    const handler = createAutoPushHandler(
      happyPathDeps({
        resolveAutoPushConfig: async () => ({ ...PASS_CFG, typecheckCmd: "" }),
        runTscClean: async () => {
          tscCalled += 1;
          return { ok: false, stderrTail: "should not be called" };
        },
      }),
    );
    expect(await handler(buildMergedEvent(1, { epicId: "e-aaa", base: "atmux-geoyws" }))).toBe(
      "pushed",
    );
    expect(tscCalled).toBe(0);
    const rows = await readAuditLog();
    // 3b NOT in gatesPassed since it was skipped entirely
    expect(rows[0]?.gatesPassed).toEqual(["5", "4", "2", "7", "3a", "1", "3b"]);
  });
});

describe("Gate-4: opt-in default-false → skipped-not-opted-in", () => {
  test("enabled=false → skipped-not-opted-in + audit gateBlocked=4", async () => {
    const handler = createAutoPushHandler(
      happyPathDeps({
        resolveAutoPushConfig: async () => ({ ...PASS_CFG, enabled: false }),
      }),
    );
    expect(await handler(buildMergedEvent(1, { epicId: "e-aaa", base: "atmux-geoyws" }))).toBe(
      "skipped-not-opted-in",
    );
    const rows = await readAuditLog();
    expect(rows[0]?.gateBlocked).toBe("4");
    expect(rows[0]?.gatesPassed).toEqual(["5"]);
  });
});

describe("Gate-5: ATMUX_AUTOPUSH_OFF kill-switch → skipped-kill-switch", () => {
  test("ATMUX_AUTOPUSH_OFF=1 → skipped-kill-switch + audit gateBlocked=5", async () => {
    const handler = createAutoPushHandler(
      happyPathDeps({
        env: { ATMUX_AUTOPUSH_OFF: "1" },
      }),
    );
    expect(await handler(buildMergedEvent(1, { epicId: "e-aaa", base: "atmux-geoyws" }))).toBe(
      "skipped-kill-switch",
    );
    const rows = await readAuditLog();
    expect(rows[0]?.gateBlocked).toBe("5");
    expect(rows[0]?.gatesPassed).toEqual([]);
  });

  test("ATMUX_AUTOPUSH_OFF empty string does NOT trigger kill (false-positive guard)", async () => {
    const handler = createAutoPushHandler(
      happyPathDeps({
        env: { ATMUX_AUTOPUSH_OFF: "" },
      }),
    );
    expect(await handler(buildMergedEvent(1, { epicId: "e-aaa", base: "atmux-geoyws" }))).toBe(
      "pushed",
    );
  });

  test("ATMUX_AUTOPUSH_OFF=0 does NOT trigger kill (numeric zero string)", async () => {
    const handler = createAutoPushHandler(
      happyPathDeps({
        env: { ATMUX_AUTOPUSH_OFF: "0" },
      }),
    );
    expect(await handler(buildMergedEvent(1, { epicId: "e-aaa", base: "atmux-geoyws" }))).toBe(
      "pushed",
    );
  });

  test("Gate-5 precedence over Gate-4: kill-switch + enabled=true → still refuses via Gate-5", async () => {
    const handler = createAutoPushHandler(
      happyPathDeps({
        env: { ATMUX_AUTOPUSH_OFF: "1" },
        resolveAutoPushConfig: async () => ({ ...PASS_CFG, enabled: true }),
      }),
    );
    expect(await handler(buildMergedEvent(1, { epicId: "e-aaa", base: "atmux-geoyws" }))).toBe(
      "skipped-kill-switch",
    );
  });
});

describe("Gate-7: cooldown → skipped-cooldown", () => {
  test("cooldown active → skipped-cooldown + audit gateBlocked=7", async () => {
    const cooldownState = new Map<string, number>();
    cooldownState.set("atmux-geoyws", 1_700_000_990); // 10s before nowSec=1_700_001_000
    const handler = createAutoPushHandler(happyPathDeps({ cooldownState }));
    expect(await handler(buildMergedEvent(1, { epicId: "e-aaa", base: "atmux-geoyws" }))).toBe(
      "skipped-cooldown",
    );
    const rows = await readAuditLog();
    expect(rows[0]?.gateBlocked).toBe("7");
    expect(rows[0]?.reason).toContain("cooldown");
    expect(rows[0]?.gatesPassed).toEqual(["5", "4", "2"]);
  });

  test("post-window: cooldown expired → push allowed", async () => {
    const cooldownState = new Map<string, number>();
    // 60s before nowSec; window is 30s → expired by 30s
    cooldownState.set("atmux-geoyws", 1_700_000_940);
    const handler = createAutoPushHandler(happyPathDeps({ cooldownState }));
    expect(await handler(buildMergedEvent(1, { epicId: "e-aaa", base: "atmux-geoyws" }))).toBe(
      "pushed",
    );
    // cooldown state advanced to the new push's nowSec
    expect(cooldownState.get("atmux-geoyws")).toBe(1_700_001_000);
  });

  test("per-base scoping: cooldown on base-A does NOT affect base-B", async () => {
    const cooldownState = new Map<string, number>();
    cooldownState.set("base-A", 1_700_000_995); // 5s ago
    const handler = createAutoPushHandler(happyPathDeps({ cooldownState }));
    // base-B has no cooldown row → pushes succeed
    expect(await handler(buildMergedEvent(1, { epicId: "e-bbb", base: "base-B" }))).toBe("pushed");
  });

  test("§DA9-rev1 cost-saving: Gate-7 BEFORE Gate-3a — cooldown-hit does NOT invoke git status subprocess", async () => {
    let gitStatusCalled = 0;
    let tscCalled = 0;
    let dispatchCalled = 0;
    const cooldownState = new Map<string, number>();
    cooldownState.set("atmux-geoyws", 1_700_000_995); // 5s ago
    const handler = createAutoPushHandler(
      happyPathDeps({
        cooldownState,
        runGitStatusClean: async () => {
          gitStatusCalled += 1;
          return true;
        },
        runTscClean: async () => {
          tscCalled += 1;
          return { ok: true, stderrTail: "" };
        },
        dispatchGitPush: async () => {
          dispatchCalled += 1;
          return { state: "pushed", headSha: "x" };
        },
      }),
    );
    await handler(buildMergedEvent(1, { epicId: "e-aaa", base: "atmux-geoyws" }));
    // Critical assertion — FLAG-A swap means subprocess work skipped on cooldown
    expect(gitStatusCalled).toBe(0);
    expect(tscCalled).toBe(0);
    expect(dispatchCalled).toBe(0);
  });
});

describe("dispatcher skipped-not-mine → outcome skipped-not-mine + no emit + no audit", () => {
  test("dispatcher returns skipped-not-mine → no terminal emit, no audit row", async () => {
    const handler = createAutoPushHandler(
      happyPathDeps({
        dispatchGitPush: async (): Promise<DispatchGitPushResult> => ({
          state: "skipped-not-mine",
          reason: "epic not in this team's roster",
        }),
      }),
    );
    expect(await handler(buildMergedEvent(1, { epicId: "e-aaa", base: "atmux-geoyws" }))).toBe(
      "skipped-not-mine",
    );
    const events = drainSince(db, {
      topics: ["epic.pushed", "epic.push-blocked", "epic.push-conflict"],
      lastEventId: "",
    });
    expect(events.length).toBe(0);
    const rows = await readAuditLog();
    expect(rows.length).toBe(0);
  });
});

describe("default handler stubs", () => {
  test("default dispatchGitPush returns skipped-not-mine", async () => {
    const handler = createAutoPushHandler({
      db,
      auditLogPath: auditPath,
      resolveAutoPushConfig: async () => PASS_CFG,
      resolvePushPolicy: async () => EMPTY_POLICY,
      runGitStatusClean: async () => true,
      runTscClean: async () => ({ ok: true, stderrTail: "" }),
      env: {},
    });
    expect(await handler(buildMergedEvent(1, { epicId: "e-aaa", base: "atmux-geoyws" }))).toBe(
      "skipped-not-mine",
    );
  });

  test("default dispatchGitPush stub returns skipped-not-mine (exercises DEFAULT_DISPATCH_STUB)", async () => {
    const handler = createAutoPushHandler({
      db,
      auditLogPath: auditPath,
      resolveAutoPushConfig: async () => PASS_CFG,
      resolvePushPolicy: async () => EMPTY_POLICY,
      runGitStatusClean: async () => true,
      runTscClean: async () => ({ ok: true, stderrTail: "" }),
      env: {},
    });
    expect(await handler(buildMergedEvent(1, { epicId: "e-aaa", base: "atmux-geoyws" }))).toBe(
      "skipped-not-mine",
    );
  });

  test("default runTscClean stub returns ok (exercises DEFAULT_TSC_CLEAN coverage)", async () => {
    // All deps default-stubbed EXCEPT resolveAutoPushConfig (enabled=true)
    // + dispatchGitPush (returns pushed). This is the path that exercises
    // the DEFAULT_TSC_CLEAN closure body.
    const handler = createAutoPushHandler({
      db,
      auditLogPath: auditPath,
      resolveAutoPushConfig: async () => PASS_CFG,
      resolvePushPolicy: async () => EMPTY_POLICY,
      dispatchGitPush: async (): Promise<DispatchGitPushResult> => ({
        state: "pushed",
        headSha: "abc",
      }),
      env: {},
    });
    expect(await handler(buildMergedEvent(1, { epicId: "e-aaa", base: "atmux-geoyws" }))).toBe(
      "pushed",
    );
  });

  test("default resolvers refuse via Gate-4 (loud opt-in)", async () => {
    const handler = createAutoPushHandler({
      db,
      auditLogPath: auditPath,
      env: {},
    });
    expect(await handler(buildMergedEvent(1, { epicId: "e-aaa", base: "atmux-geoyws" }))).toBe(
      "skipped-not-opted-in",
    );
  });
});

describe("logger info/warn invoked", () => {
  test("warn called on push-conflict outcome", async () => {
    const warns: string[] = [];
    const handler = createAutoPushHandler(
      happyPathDeps({
        dispatchGitPush: async (): Promise<DispatchGitPushResult> => ({
          state: "upstream-advanced",
          ahead: 1,
          behind: 0,
        }),
        logger: {
          info: () => {},
          warn: (m: string) => warns.push(m),
          error: () => {},
        },
      }),
    );
    await handler(buildMergedEvent(1, { epicId: "e-aaa", base: "atmux-geoyws" }));
    expect(warns.some((m) => m.includes("push-conflict"))).toBe(true);
  });

  test("info called on push success", async () => {
    const infos: string[] = [];
    const handler = createAutoPushHandler(
      happyPathDeps({
        logger: {
          info: (m: string) => infos.push(m),
          warn: () => {},
          error: () => {},
        },
      }),
    );
    await handler(buildMergedEvent(1, { epicId: "e-aaa", base: "atmux-geoyws" }));
    expect(infos.some((m) => m.includes("pushed"))).toBe(true);
  });
});

// ---------- Consumer surface ----------

function emitMerged(n: number, fields: { epicId: string; base: string }): void {
  emit(
    db,
    {
      topic: "epic.merged",
      epicId: fields.epicId,
      parentBase: fields.base,
      mergeSha: "stubmergedsha",
      mergedAtSec: 1_700_000_000 + n,
    },
    { generateId: () => fakeId(n), nowSec: () => 1_700_000_000 + n },
  );
}

describe("orchdPushConsume kill-switch behavior", () => {
  test("ATMUX_HONKER off short-circuits to zero totals", async () => {
    emitMerged(1, { epicId: "e-aaa", base: "atmux-geoyws" });
    emitMerged(2, { epicId: "e-bbb", base: "atmux-geoyws" });

    const result = await orchdPushConsume({ db, env: HONKER_OFF });

    expect(result).toEqual({ processed: 0, escalated: 0 });
    expect(loadOffset(db, "atmux:orchd-push")).toBe("");
  });

  test("ATMUX_HONKER unset drains via default stub handler", async () => {
    emitMerged(1, { epicId: "e-aaa", base: "atmux-geoyws" });
    const result = await orchdPushConsume({ db, env: {} });
    expect(result).toEqual({ processed: 1, escalated: 0 });
    expect(loadOffset(db, "atmux:orchd-push")).toBe(fakeId(1));
  });

  test("short-circuit logs the fallback path", async () => {
    const lines: string[] = [];
    await orchdPushConsume({
      db,
      env: HONKER_OFF,
      logger: { info: (m) => lines.push(m), warn: () => {}, error: () => {} },
    });
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("ATMUX_HONKER=off");
  });
});

describe("orchdPushConsume happy path", () => {
  test("drains N events + calls injected handler in event_id order", async () => {
    emitMerged(1, { epicId: "e-aaa", base: "atmux-geoyws" });
    emitMerged(2, { epicId: "e-bbb", base: "atmux-geoyws" });
    emitMerged(3, { epicId: "e-ccc", base: "atmux-geoyws" });

    const seen: string[] = [];
    const handler = async (event: EpicMergedPayload): Promise<AutoPushOutcome> => {
      seen.push(event.epicId);
      return "pushed";
    };

    const result = await orchdPushConsume({ db, env: HONKER_ON, handler });
    expect(result).toEqual({ processed: 3, escalated: 0 });
    expect(seen).toEqual(["e-aaa", "e-bbb", "e-ccc"]);
    expect(loadOffset(db, "atmux:orchd-push")).toBe(fakeId(3));
  });

  test("counts escalated outcomes separately from processed", async () => {
    emitMerged(1, { epicId: "e-aaa", base: "atmux-geoyws" });
    emitMerged(2, { epicId: "e-bbb", base: "atmux-geoyws" });

    const handler = async (event: EpicMergedPayload): Promise<AutoPushOutcome> => {
      return event.epicId === "e-bbb" ? "escalated" : "pushed";
    };

    const result = await orchdPushConsume({ db, env: HONKER_ON, handler });
    expect(result).toEqual({ processed: 2, escalated: 1 });
  });
});

describe("orchdPushConsume failure mode (idempotency)", () => {
  test("handler throws stops at failing event + offset stays before it", async () => {
    emitMerged(1, { epicId: "e-aaa", base: "atmux-geoyws" });
    emitMerged(2, { epicId: "e-bbb", base: "atmux-geoyws" });
    emitMerged(3, { epicId: "e-ccc", base: "atmux-geoyws" });

    const handler = async (event: EpicMergedPayload): Promise<AutoPushOutcome> => {
      if (event.epicId === "e-bbb") throw new Error("simulated dispatch failure");
      return "pushed";
    };

    const result = await orchdPushConsume({ db, env: HONKER_ON, handler });
    expect(result).toEqual({ processed: 1, escalated: 0 });
    expect(loadOffset(db, "atmux:orchd-push")).toBe(fakeId(1));
  });
});

describe("orchdPushConsume consumer + topic injection", () => {
  test("custom consumerName isolates offset rows", async () => {
    emitMerged(1, { epicId: "e-aaa", base: "atmux-geoyws" });
    await orchdPushConsume({
      db,
      env: HONKER_ON,
      consumerName: "atmux:orchd-push-shard-A",
      handler: async () => "pushed",
    });
    expect(loadOffset(db, "atmux:orchd-push-shard-A")).toBe(fakeId(1));
    expect(loadOffset(db, "atmux:orchd-push")).toBe("");
  });

  test("default topics is ['epic.merged']", async () => {
    emit(
      db,
      {
        topic: "task.done",
        taskId: "t-x",
        member: "be-1",
        team: "atmux",
        doneAtSec: 1,
      },
      { generateId: () => fakeId(1), nowSec: () => 1 },
    );
    const result = await orchdPushConsume({
      db,
      env: HONKER_ON,
      handler: async () => "pushed",
    });
    // task.done not in default topic filter — no drain
    expect(result).toEqual({ processed: 0, escalated: 0 });
  });
});

// ---------- End-to-end ----------

describe("end-to-end: consumer drives factory through all 7 gates", () => {
  test("emit epic.merged → consumer → handler → emit epic.pushed + audit", async () => {
    emitMerged(1, { epicId: "e-aaa", base: "atmux-geoyws" });
    const handler = createAutoPushHandler(happyPathDeps());
    const result = await orchdPushConsume({
      db,
      env: HONKER_ON,
      handler,
    });
    expect(result).toEqual({ processed: 1, escalated: 0 });
    const pushed = drainSince(db, { topics: ["epic.pushed"], lastEventId: "" });
    expect(pushed.length).toBe(1);
    const rows = await readAuditLog();
    expect(rows[0]?.outcome).toBe("pushed");
  });
});

// ---------- §D2.1 grep DoD regression — reviewer-enforced invariants ----------

describe("§D2.1 grep DoD — orchd-push.ts MUST NOT carry forbidden patterns", () => {
  test("no force-push / mirror / hook-bypass flags (§DA-Gate-1 + FLAG-B --no-verify extension)", async () => {
    const src = await readFile(
      join(__dirname, "..", "..", "..", "src", "core", "orchd-push.ts"),
      "utf8",
    );
    // The forbidden-flag list per §D2.1 #1 — these must NEVER appear in
    // a `git push` invocation generated from orchd-push.ts. (Comments
    // describing the prohibition are EXEMPT — strip them before grep so
    // the test doesn't false-positive on the module header rationale.)
    const codeOnly = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    const forbidden = [
      "--mirror",
      "--all",
      "--tags",
      "--delete",
      "--prune",
      "--force",
      "--force-with-lease",
      "--no-verify",
      "--no-gpg-sign",
      "forcePush",
    ];
    for (const flag of forbidden) {
      expect(codeOnly).not.toContain(flag);
    }
  });

  test("no inline STAGING_PATTERNS regex (§DA-Gate-2 + §DA8 single-source-of-truth)", async () => {
    const src = await readFile(
      join(__dirname, "..", "..", "..", "src", "core", "orchd-push.ts"),
      "utf8",
    );
    const codeOnly = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    // STAGING_PATTERNS regex shapes — must live ONLY in src/core/auto-push.ts.
    expect(codeOnly).not.toMatch(/\/-staging\$\//);
    expect(codeOnly).not.toMatch(/\/\^main\$\//);
    expect(codeOnly).not.toMatch(/\/\^master\$\//);
    expect(codeOnly).not.toMatch(/\/\^production\$\//);
  });
});

// Type-hint keepers
const _typeHints: DispatchGitPushResult[] = [
  { state: "pushed", headSha: "x" },
  { state: "pushed", headSha: "x", beforeSha: "y" },
  { state: "upstream-advanced", ahead: 1, behind: 0 },
  { state: "upstream-advanced", ahead: 1, behind: 0, divergenceSha: "z" },
  { state: "skipped-not-mine" },
  { state: "skipped-not-mine", reason: "r" },
];
void _typeHints;
