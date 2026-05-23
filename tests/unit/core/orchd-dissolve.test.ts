// Unit tests for src/core/orchd-dissolve.ts — Phase 4 orchd auto-
// dissolve subscriber (ADR-227 + §Amendment 2026-05-23).
//
// Pins:
//   - Kill-switch off (`ATMUX_HONKER=off`) short-circuits to
//     {processed:0, escalated:0} without touching the events table.
//   - Default (unset env) drains via the no-op stub handler.
//   - Default topic is `["epic.pushed"]` per §Amendment trigger flip
//     (Phase 4 must NOT fire before Phase 6 pushes the merge commit
//     to origin); pre-amendment value `["epic.merged"]` is no longer
//     the default.
//   - Operator opt-out via `autoDissolve: false` → handler returns
//     `skipped-operator-opt-out`, writes opt-out row to audit log,
//     skips dispatch.
//   - Dispatcher outcomes: dissolved → emit `epic.dissolved` + audit
//     row; gate-held → emit `epic.dissolve-blocked` + audit row +
//     return `escalated`; skipped-not-mine → no emit, no audit.
//   - Worker (`w-` prefix) treated identically — no special-casing
//     (per §DA3 closure).
//   - Audit log JSONL roundtrip: each row parseable as JSON; fields
//     present per OrchdDissolveAuditRow contract.
//   - withIdempotency: thrown handler halts drain + offset stays
//     before the failing event.

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainSince, emit, loadOffset } from "../../../src/abstractions/events.ts";
import { openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import {
  type AutoDissolveOutcome,
  appendOrchdDissolveAuditRow,
  createAutoDissolveHandler,
  type DispatchDissolveEpicResult,
  type DissolveTriggerPayload,
  type OrchdDissolveAuditRow,
  orchdDissolveConsume,
} from "../../../src/core/orchd-dissolve.ts";

let scratch: string;
let db: Database;
let auditPath: string;
const HONKER_ON: NodeJS.ProcessEnv = { ATMUX_HONKER: "on" };
const HONKER_OFF: NodeJS.ProcessEnv = { ATMUX_HONKER: "off" };

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atmux-orchd-dissolve-"));
  db = openDatabase(join(scratch, "state.db"), migrations);
  auditPath = join(scratch, "orchd-dissolve.log");
});

afterEach(async () => {
  db.close();
  await rm(scratch, { recursive: true, force: true });
});

function fakeId(n: number): string {
  return `01890000-0000-7000-8000-${String(n).padStart(12, "0")}`;
}

function buildPushedEvent(
  n: number,
  fields: { epicId: string; mergeSha?: string },
): DissolveTriggerPayload {
  // Use the EpicMergedPayload shape today — pre-Phase-6 the EpicPushedPayload
  // doesn't exist; the handler's structural type tolerates either.
  return {
    topic: "epic.merged",
    eventId: fakeId(n),
    emittedAtSec: 1_700_000_000 + n,
    schemaVersion: 1 as const,
    epicId: fields.epicId,
    ...(fields.mergeSha !== undefined
      ? ({ mergeSha: fields.mergeSha } as Record<string, unknown>)
      : {}),
  } as DissolveTriggerPayload;
}

async function readAuditLog(): Promise<OrchdDissolveAuditRow[]> {
  let text: string;
  try {
    text = await readFile(auditPath, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as OrchdDissolveAuditRow);
}

// ---------- appendOrchdDissolveAuditRow ----------

describe("appendOrchdDissolveAuditRow JSONL writer (ADR-227 §D4)", () => {
  test("appends one row per call; rows are valid JSONL", async () => {
    appendOrchdDissolveAuditRow(auditPath, {
      at: "2026-05-23T14:02:11Z",
      epicId: "e-abc12345",
      outcome: "dissolved",
      reason: null,
      mergedSha: "abc1234567",
      dissolvedSha: "def4567890",
    });
    appendOrchdDissolveAuditRow(auditPath, {
      at: "2026-05-23T14:05:22Z",
      epicId: "e-def67890",
      outcome: "blocked",
      reason: "worktree dirty: 3 uncommitted files",
      mergedSha: null,
      dissolvedSha: null,
    });
    const rows = await readAuditLog();
    expect(rows.length).toBe(2);
    expect(rows[0]?.outcome).toBe("dissolved");
    expect(rows[0]?.dissolvedSha).toBe("def4567890");
    expect(rows[1]?.outcome).toBe("blocked");
    expect(rows[1]?.reason).toContain("uncommitted files");
  });

  test("preserves all OrchdDissolveAuditRow fields verbatim (roundtrip)", async () => {
    const row: OrchdDissolveAuditRow = {
      at: "2026-05-23T14:08:33Z",
      epicId: "e-ghi13579",
      outcome: "opt-out",
      reason: "team.json::epicTeam.autoDissolve=false",
      mergedSha: "abc1234567",
      dissolvedSha: null,
    };
    appendOrchdDissolveAuditRow(auditPath, row);
    const rows = await readAuditLog();
    expect(rows.length).toBe(1);
    expect(rows[0]).toEqual(row);
  });
});

// ---------- createAutoDissolveHandler outcome paths ----------

describe("createAutoDissolveHandler (5 outcomes per ADR-227 §D6)", () => {
  test("skipped-operator-opt-out — emits audit row + no dispatch + no emit", async () => {
    let dispatchCount = 0;
    const handler = createAutoDissolveHandler({
      db,
      auditLogPath: auditPath,
      dispatchDissolveEpic: async () => {
        dispatchCount += 1;
        return { state: "dissolved" };
      },
      resolveAutoDissolveSetting: async () => false,
      nowSec: () => 1_700_001_111,
    });
    const event = buildPushedEvent(1, { epicId: "e-aaa", mergeSha: "feed1234" });
    expect(await handler(event)).toBe("skipped-operator-opt-out");
    expect(dispatchCount).toBe(0);

    // No events emitted (epic.dissolved / epic.dissolve-blocked absent).
    const events = drainSince(db, {
      topics: ["epic.dissolved", "epic.dissolve-blocked"],
      lastEventId: "",
    });
    expect(events.length).toBe(0);

    // Audit row recorded.
    const rows = await readAuditLog();
    expect(rows.length).toBe(1);
    expect(rows[0]?.outcome).toBe("opt-out");
    expect(rows[0]?.epicId).toBe("e-aaa");
    expect(rows[0]?.mergedSha).toBe("feed1234");
  });

  test("dissolved → emits epic.dissolved + audit row + returns 'dissolved'", async () => {
    const handler = createAutoDissolveHandler({
      db,
      auditLogPath: auditPath,
      dispatchDissolveEpic: async () => ({
        state: "dissolved",
        dissolvedSha: "deadbeef1234",
      }),
      nowSec: () => 1_700_002_222,
    });
    const event = buildPushedEvent(1, { epicId: "e-bbb", mergeSha: "abc1234" });
    expect(await handler(event)).toBe("dissolved");

    const events = drainSince(db, {
      topics: ["epic.dissolved"],
      lastEventId: "",
    });
    expect(events.length).toBe(1);
    expect(events[0]?.topic).toBe("epic.dissolved");
    expect((events[0] as { epicId: string }).epicId).toBe("e-bbb");
    expect((events[0] as { dissolvedAtSec: number }).dissolvedAtSec).toBe(1_700_002_222);
    expect((events[0] as { dissolvedSha?: string }).dissolvedSha).toBe("deadbeef1234");

    const rows = await readAuditLog();
    expect(rows.length).toBe(1);
    expect(rows[0]?.outcome).toBe("dissolved");
    expect(rows[0]?.dissolvedSha).toBe("deadbeef1234");
    expect(rows[0]?.mergedSha).toBe("abc1234");
    expect(rows[0]?.reason).toBeNull();
  });

  test("dissolved with no dissolvedSha → emit + audit row both have null/absent", async () => {
    const handler = createAutoDissolveHandler({
      db,
      auditLogPath: auditPath,
      dispatchDissolveEpic: async () => ({ state: "dissolved" }),
      nowSec: () => 1_700_003_333,
    });
    const event = buildPushedEvent(1, { epicId: "e-bbb" });
    expect(await handler(event)).toBe("dissolved");

    const events = drainSince(db, {
      topics: ["epic.dissolved"],
      lastEventId: "",
    });
    expect(events.length).toBe(1);
    // dissolvedSha is omitted when null from dispatcher.
    expect((events[0] as { dissolvedSha?: string }).dissolvedSha).toBeUndefined();

    const rows = await readAuditLog();
    expect(rows[0]?.dissolvedSha).toBeNull();
  });

  test("gate-held → emits epic.dissolve-blocked + audit row + returns 'escalated'", async () => {
    const handler = createAutoDissolveHandler({
      db,
      auditLogPath: auditPath,
      dispatchDissolveEpic: async () => ({
        state: "gate-held",
        reason: "worktree dirty: 3 uncommitted files in apps/web",
      }),
      nowSec: () => 1_700_004_444,
    });
    const event = buildPushedEvent(1, { epicId: "e-ccc", mergeSha: "f00dbabe" });
    expect(await handler(event)).toBe("escalated");

    const events = drainSince(db, {
      topics: ["epic.dissolve-blocked"],
      lastEventId: "",
    });
    expect(events.length).toBe(1);
    expect(events[0]?.topic).toBe("epic.dissolve-blocked");
    expect((events[0] as { reason: string }).reason).toContain("worktree dirty");
    expect((events[0] as { blockedAtSec: number }).blockedAtSec).toBe(1_700_004_444);

    const rows = await readAuditLog();
    expect(rows.length).toBe(1);
    expect(rows[0]?.outcome).toBe("blocked");
    expect(rows[0]?.reason).toContain("worktree dirty");
    expect(rows[0]?.mergedSha).toBe("f00dbabe");
    expect(rows[0]?.dissolvedSha).toBeNull();
  });

  test("skipped-not-mine → no emit + no audit row + returns 'skipped-not-mine'", async () => {
    const handler = createAutoDissolveHandler({
      db,
      auditLogPath: auditPath,
      dispatchDissolveEpic: async () => ({
        state: "skipped-not-mine",
        reason: "epic not in this team's roster",
      }),
    });
    const event = buildPushedEvent(1, { epicId: "e-ddd" });
    expect(await handler(event)).toBe("skipped-not-mine");

    const events = drainSince(db, {
      topics: ["epic.dissolved", "epic.dissolve-blocked"],
      lastEventId: "",
    });
    expect(events.length).toBe(0);
    const rows = await readAuditLog();
    expect(rows.length).toBe(0);
  });

  test("default dispatcher (no injection) → skipped-not-mine", async () => {
    const handler = createAutoDissolveHandler({ db, auditLogPath: auditPath });
    const event = buildPushedEvent(1, { epicId: "e-eee" });
    expect(await handler(event)).toBe("skipped-not-mine");
  });

  test("default resolveAutoDissolveSetting returns true (auto-dissolve on)", async () => {
    let dispatchCount = 0;
    const handler = createAutoDissolveHandler({
      db,
      auditLogPath: auditPath,
      dispatchDissolveEpic: async () => {
        dispatchCount += 1;
        return { state: "dissolved" };
      },
    });
    const event = buildPushedEvent(1, { epicId: "e-fff" });
    await handler(event);
    expect(dispatchCount).toBe(1);
  });

  test("logger info/warn invoked appropriately", async () => {
    const infos: string[] = [];
    const warns: string[] = [];
    const handler = createAutoDissolveHandler({
      db,
      auditLogPath: auditPath,
      dispatchDissolveEpic: async () => ({
        state: "gate-held",
        reason: "needs cleanup",
      }),
      logger: {
        info: (msg) => infos.push(msg),
        warn: (msg) => warns.push(msg),
        error: () => {},
      },
    });
    const event = buildPushedEvent(1, { epicId: "e-ggg" });
    await handler(event);
    expect(warns.some((m) => m.includes("blocked"))).toBe(true);
  });
});

// ---------- ADR-227 §DA3 worker fold-in ----------

describe("createAutoDissolveHandler — worker (w- prefix) handled identically", () => {
  test("worker epicId `w-XXX` triggers normal dispatcher + emit + audit (no special-casing)", async () => {
    const dispatchedEpics: string[] = [];
    const handler = createAutoDissolveHandler({
      db,
      auditLogPath: auditPath,
      dispatchDissolveEpic: async (epicId) => {
        dispatchedEpics.push(epicId);
        return { state: "dissolved", dissolvedSha: "workerfinalsha" };
      },
      nowSec: () => 1_700_005_555,
    });
    const event = buildPushedEvent(1, {
      epicId: "w-abcd1234",
      mergeSha: "workerlandsha",
    });
    expect(await handler(event)).toBe("dissolved");
    expect(dispatchedEpics).toEqual(["w-abcd1234"]);

    const events = drainSince(db, {
      topics: ["epic.dissolved"],
      lastEventId: "",
    });
    expect(events.length).toBe(1);
    expect((events[0] as { epicId: string }).epicId).toBe("w-abcd1234");

    const rows = await readAuditLog();
    expect(rows.length).toBe(1);
    expect(rows[0]?.epicId).toBe("w-abcd1234");
    expect(rows[0]?.outcome).toBe("dissolved");
    // Worker rows land in the SAME audit log per ADR-227 §DA4 (single
    // log for epics + workers; tag with epicId prefix on read).
  });
});

// ---------- Consumer surface ----------

function emitPushed(n: number, fields: { epicId: string; mergeSha?: string }): void {
  // Use `epic.merged` topic to populate the events table — the
  // consumer's default topic filter is `["epic.pushed"]` (per §Amendment),
  // so tests injecting custom `topics: ["epic.merged"]` drive the
  // drain. Phase 6 isn't shipped yet; the actual `epic.pushed`
  // emitter lands when ADR-229 T_push_module lands.
  emit(
    db,
    {
      topic: "epic.merged",
      epicId: fields.epicId,
      parentBase: "atmux-geoyws",
      mergeSha: fields.mergeSha ?? "stubmergedsha",
      mergedAtSec: 1_700_000_000 + n,
    },
    { generateId: () => fakeId(n), nowSec: () => 1_700_000_000 + n },
  );
}

describe("orchdDissolveConsume kill-switch behavior", () => {
  test("ATMUX_HONKER off short-circuits to zero totals without draining", async () => {
    emitPushed(1, { epicId: "e-aaa" });
    emitPushed(2, { epicId: "e-bbb" });

    const result = await orchdDissolveConsume({ db, env: HONKER_OFF });

    expect(result).toEqual({ processed: 0, escalated: 0 });
    expect(loadOffset(db, "atmux:orchd-dissolve")).toBe("");
  });

  test("ATMUX_HONKER unset drains via default stub handler", async () => {
    emitPushed(1, { epicId: "e-aaa" });
    // Override topics to use `epic.merged` (only topic with payload in
    // events.ts today); production default is `["epic.pushed"]`.
    const result = await orchdDissolveConsume({
      db,
      env: {},
      topics: ["epic.merged"],
    });
    expect(result).toEqual({ processed: 1, escalated: 0 });
    expect(loadOffset(db, "atmux:orchd-dissolve")).toBe(fakeId(1));
  });

  test("short-circuit logs the fallback path", async () => {
    const lines: string[] = [];
    await orchdDissolveConsume({
      db,
      env: HONKER_OFF,
      logger: {
        info: (msg) => lines.push(msg),
        warn: () => {},
        error: () => {},
      },
    });
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("ATMUX_HONKER=off");
  });
});

describe("orchdDissolveConsume happy path", () => {
  test("drains N events + calls injected handler for each in event_id order", async () => {
    emitPushed(1, { epicId: "e-aaa" });
    emitPushed(2, { epicId: "e-bbb" });
    emitPushed(3, { epicId: "e-ccc" });

    const seen: string[] = [];
    const handler = async (event: DissolveTriggerPayload): Promise<AutoDissolveOutcome> => {
      seen.push(event.epicId);
      return "dissolved";
    };

    const result = await orchdDissolveConsume({
      db,
      env: HONKER_ON,
      handler,
      topics: ["epic.merged"],
    });

    expect(result).toEqual({ processed: 3, escalated: 0 });
    expect(seen).toEqual(["e-aaa", "e-bbb", "e-ccc"]);
    expect(loadOffset(db, "atmux:orchd-dissolve")).toBe(fakeId(3));
  });

  test("counts escalated outcomes separately from processed", async () => {
    emitPushed(1, { epicId: "e-aaa" });
    emitPushed(2, { epicId: "e-bbb" });
    emitPushed(3, { epicId: "e-ccc" });

    const handler = async (event: DissolveTriggerPayload): Promise<AutoDissolveOutcome> => {
      return event.epicId === "e-bbb" ? "escalated" : "dissolved";
    };

    const result = await orchdDissolveConsume({
      db,
      env: HONKER_ON,
      handler,
      topics: ["epic.merged"],
    });

    expect(result).toEqual({ processed: 3, escalated: 1 });
  });

  test("default stub handler returns 'skipped-not-mine' — advances offset", async () => {
    emitPushed(1, { epicId: "e-aaa" });
    emitPushed(2, { epicId: "e-bbb" });

    const result = await orchdDissolveConsume({
      db,
      env: HONKER_ON,
      topics: ["epic.merged"],
    });

    expect(result).toEqual({ processed: 2, escalated: 0 });
    expect(loadOffset(db, "atmux:orchd-dissolve")).toBe(fakeId(2));
  });
});

describe("orchdDissolveConsume failure mode", () => {
  test("handler throws stops at failing event + offset stays before it", async () => {
    emitPushed(1, { epicId: "e-aaa" });
    emitPushed(2, { epicId: "e-bbb" });
    emitPushed(3, { epicId: "e-ccc" });

    const handler = async (event: DissolveTriggerPayload): Promise<AutoDissolveOutcome> => {
      if (event.epicId === "e-bbb") {
        throw new Error("simulated dispatch failure");
      }
      return "dissolved";
    };

    const result = await orchdDissolveConsume({
      db,
      env: HONKER_ON,
      handler,
      topics: ["epic.merged"],
    });

    expect(result).toEqual({ processed: 1, escalated: 0 });
    expect(loadOffset(db, "atmux:orchd-dissolve")).toBe(fakeId(1));
  });
});

describe("orchdDissolveConsume consumer + topic injection", () => {
  test("custom consumerName isolates offset rows", async () => {
    emitPushed(1, { epicId: "e-aaa" });
    await orchdDissolveConsume({
      db,
      env: HONKER_ON,
      consumerName: "atmux:orchd-dissolve-shard-A",
      handler: async () => "dissolved",
      topics: ["epic.merged"],
    });

    expect(loadOffset(db, "atmux:orchd-dissolve-shard-A")).toBe(fakeId(1));
    expect(loadOffset(db, "atmux:orchd-dissolve")).toBe("");
  });

  test("default topics is ['epic.pushed'] per §Amendment 2026-05-23", async () => {
    // Today's events.ts only emits `epic.merged`. Default subscription
    // to `epic.pushed` means consumer drains zero events (Phase 6
    // hasn't shipped). Verifies the §Amendment landed.
    emitPushed(1, { epicId: "e-aaa" });

    const result = await orchdDissolveConsume({
      db,
      env: HONKER_ON,
      handler: async () => "dissolved",
    });

    expect(result).toEqual({ processed: 0, escalated: 0 });
  });
});

// ---------- End-to-end factory + consumer + dispatcher ----------

describe("end-to-end: factory + consumer + dispatcher", () => {
  test("happy path: pushed event → handler → dispatcher → emit epic.dissolved", async () => {
    emitPushed(1, { epicId: "e-aaa", mergeSha: "abcdef0123" });

    const dispatchCalls: string[] = [];
    const handler = createAutoDissolveHandler({
      db,
      auditLogPath: auditPath,
      dispatchDissolveEpic: async (epicId) => {
        dispatchCalls.push(epicId);
        return { state: "dissolved", dissolvedSha: "finalSha" };
      },
      nowSec: () => 1_700_009_999,
    });

    const result = await orchdDissolveConsume({
      db,
      env: HONKER_ON,
      handler,
      topics: ["epic.merged"],
    });

    expect(result).toEqual({ processed: 1, escalated: 0 });
    expect(dispatchCalls).toEqual(["e-aaa"]);
    const events = drainSince(db, {
      topics: ["epic.dissolved"],
      lastEventId: "",
    });
    expect(events.length).toBe(1);

    const rows = await readAuditLog();
    expect(rows.length).toBe(1);
    expect(rows[0]?.outcome).toBe("dissolved");
  });

  test("opt-out path through consumer: handler skips dispatch + writes opt-out audit row", async () => {
    emitPushed(1, { epicId: "e-bbb" });

    const handler = createAutoDissolveHandler({
      db,
      auditLogPath: auditPath,
      dispatchDissolveEpic: async () => ({ state: "dissolved" }),
      resolveAutoDissolveSetting: async () => false,
    });

    const result = await orchdDissolveConsume({
      db,
      env: HONKER_ON,
      handler,
      topics: ["epic.merged"],
    });

    expect(result).toEqual({ processed: 1, escalated: 0 });
    const rows = await readAuditLog();
    expect(rows.length).toBe(1);
    expect(rows[0]?.outcome).toBe("opt-out");
  });
});

// Type-hint keepers — exercise the exported types at compile time.
const _typeHints: DispatchDissolveEpicResult[] = [
  { state: "dissolved" },
  { state: "dissolved", dissolvedSha: "x" },
  { state: "gate-held", reason: "r" },
  { state: "skipped-not-mine" },
];
void _typeHints;
