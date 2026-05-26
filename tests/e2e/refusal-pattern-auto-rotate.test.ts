// E2E refusal-pattern auto-rotate walk (ADR-139 §D1-D5) — synthetic
// refusal-injection walked end-to-end through the public scan +
// trigger surfaces. Asserts the full chain: pane capture → classify
// → `refusal_events` write → threshold check → `atmux rotate` spawn →
// rotations log append → complaint file (cap-hit path) → Discord
// template fire.
//
// **Stateful 1x cold-start+walk e2e** per CLAUDE.md testing-discipline
// — each scenario re-seeds its own throwaway tmpdir + in-memory state.db
// so the walks are independent at the test() level but stateful within
// a single test() body (scan-then-trigger consumes the rows the scan
// just wrote).
//
// Mocking shape (per ADR-139 T5 task body's "OR by seeding pre-recorded
// captures into a fake tmux capture-pane shim" carve-out — full live
// tmux is unnecessary for the trigger-chain proof):
//   - `paneCapture` (RefusalScanDeps seam) — returns per-member
//     pre-canned capture strings per beat
//   - `classify` (RefusalScanDeps seam) — default real classifier
//     so the regex layer actually runs on the captures
//   - `openDb` (RefusalScanDeps seam) — pins to an in-memory DB
//     pre-migrated via `openDatabase(":memory:", migrations)`
//   - `spawnAtmux` (RefusalTriggerDeps seam) — recorder
//   - `sendDiscord` (RefusalTriggerDeps seam) — recorder
//
// Scenarios (one per test() per CLAUDE.md "pair runbook beats with
// rehearsal spec steps" rule — runbook matches the eventual ADR-139
// operator notes):
//   1. Threshold trip — 3 soft events → rotate fires + log row + Discord 🟡
//   2. Hard threshold (2 events) → rotate fires with class=hard
//   3. Role instant (1 event) → rotate fires with class=role
//   4. Cap exhaustion — 3 rotations already today → 4th trip files
//      complaint + emits 🚨, NO rotate spawn
//   5. Exempt member — refuser in exemptMembers → events still recorded
//      for audit but rotation skipped
//   6. Backward-compat — `team.json` with NO refusalDetection block
//      → defaults apply + rotate fires on 3 soft events
//
// Cleanup: each beforeEach mkdtemp + afterEach rm — fully self-
// contained per CLAUDE.md "fixture cleanup verified" gate.

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscordSendOpts } from "../../src/abstractions/discord.ts";
import { ensureDir } from "../../src/abstractions/fs.ts";
import { closeDatabase, openDatabase } from "../../src/abstractions/sqlite.ts";
import { migrations } from "../../src/abstractions/sqlite-migrations.ts";
import { scanTeamForRefusals } from "../../src/core/refusal-scan.ts";
import { runRefusalTriggerForTeam } from "../../src/core/refusal-trigger.ts";
import type { Team } from "../../src/schema/team.ts";

interface Env {
  scratch: string;
  atmuxDir: string;
  db: Database;
}
let env: Env;

beforeEach(async () => {
  const scratch = await mkdtemp(join(tmpdir(), "atmux-refusal-e2e-"));
  const atmuxDir = join(scratch, ".atmux");
  await ensureDir(join(atmuxDir, "state"));
  const db = openDatabase(":memory:", migrations);
  env = { scratch, atmuxDir, db };
});
afterEach(async () => {
  closeDatabase(env.db);
  await rm(env.scratch, { recursive: true, force: true });
});

interface Recorder {
  spawnArgs: string[][];
  discord: DiscordSendOpts[];
}

function makeRecorder(): Recorder & {
  spawn: (argv: ReadonlyArray<string>) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
  send: (opts: DiscordSendOpts) => Promise<void>;
} {
  const r: Recorder = { spawnArgs: [], discord: [] };
  return {
    ...r,
    spawn: async (argv) => {
      r.spawnArgs.push([...argv]);
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
    send: async (opts) => {
      r.discord.push(opts);
    },
  };
}

function team(
  name: string,
  members: string[],
  block: Partial<Team["refusalDetection"]> = {},
  omitBlock = false,
): Team {
  const base = {
    name,
    members: members.map((n) => ({ name: n })),
  } as unknown as Team;
  if (omitBlock) return base;
  return { ...base, refusalDetection: { ...block } } as unknown as Team;
}

/** Synthetic captures that cross thresholds when fed sequentially.
 *  Each entry is one tick's pane state. The phrases match the actual
 *  ADR-139 §D1 classifier regex set. */
const SOFT_CAPTURES = [
  "log output ...\nthis is repetitive, leave me alone\n>",
  "another tick ...\nI'm tired of dispatching tasks I can't claim\n>",
  "yet another ...\ndon't poke me\n>",
];

const HARD_CAPTURES = [
  "log output ...\nI refuse to claim this task — stop sending me messages\n>",
  "log output ...\nI will not work on this brief any longer\n>",
];

const ROLE_CAPTURE = "diagnostic ...\nrotate me already; I am not a planner\n>";

const NORMAL_CAPTURE = "log output ...\nworking on T-12345 — claiming next\n>";

/** Run a full scan + trigger cycle for one team. Each call iterates
 *  members once, captures per the provided captureMap, and dispatches
 *  through the trigger module. Mirrors what medic does per tick. */
async function tickOnce(
  testTeam: Team,
  captureMap: Record<string, string>,
  rec: ReturnType<typeof makeRecorder>,
  nowSec: number,
): Promise<void> {
  await scanTeamForRefusals(testTeam, env.atmuxDir, {
    paneCapture: async (target) => {
      const wn = target.includes(":") ? (target.split(":")[1] ?? "") : target;
      for (const [member, cap] of Object.entries(captureMap)) {
        if (wn.includes(member)) return cap;
      }
      return "";
    },
    openDb: () => ({ db: env.db, close: () => {} }),
    nowSec: () => nowSec,
    log: () => {},
  });
  await runRefusalTriggerForTeam(testTeam, {
    db: env.db,
    atmuxDir: env.atmuxDir,
    spawnAtmux: rec.spawn,
    sendDiscord: rec.send,
    nowSec: () => nowSec,
    log: () => {},
  });
}

describe("ADR-139 refusal auto-rotate — e2e walk", () => {
  test("scenario 1: 3 soft events trigger rotate fire + Discord 🟡 + log row", async () => {
    const rec = makeRecorder();
    const t = team("demo", ["alice", "bob"]);
    // 3 ticks 5min apart — all inside the default 30min window
    // and each tick is a distinct minute_bucket so the UNIQUE
    // constraint doesn't collapse them.
    const t0 = 10_000_000;
    for (let i = 0; i < 3; i += 1) {
      await tickOnce(
        t,
        { alice: SOFT_CAPTURES[i] ?? "", bob: NORMAL_CAPTURE },
        rec,
        t0 + i * 300, // +5min per tick
      );
    }
    // Threshold should trip on the 3rd tick — spawnAtmux called
    // exactly once (the prior two ticks were below threshold).
    expect(rec.spawnArgs.length).toBe(1);
    expect(rec.spawnArgs[0]).toEqual(["rotate", "alice"]);
    // Discord template fire on the trip tick — Discord ALSO fires
    // for the every-tick log-pings; filter to rotate-template only.
    const rotateFires = rec.discord.filter((o) => o.template === "member-refusal-rotate");
    expect(rotateFires.length).toBe(1);
    expect(rotateFires[0]?.verdict).toContain("🟡");
    expect(rotateFires[0]?.verdict).toContain("alice");
    // Rotations log gained one row.
    const logPath = join(env.atmuxDir, "state", "refusal-rotations.log");
    const body = await Bun.file(logPath).text();
    const lines = body.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("alice");
    expect(lines[0]).toContain("soft");
  });

  test("scenario 2: 2 hard events trigger rotate with class=hard", async () => {
    const rec = makeRecorder();
    const t = team("demo", ["bob"]);
    const t0 = 20_000_000;
    for (let i = 0; i < 2; i += 1) {
      await tickOnce(t, { bob: HARD_CAPTURES[i] ?? "" }, rec, t0 + i * 60);
    }
    expect(rec.spawnArgs.length).toBe(1);
    expect(rec.spawnArgs[0]).toEqual(["rotate", "bob"]);
    const rotateFires = rec.discord.filter((o) => o.template === "member-refusal-rotate");
    expect(rotateFires[0]?.verdict).toContain("hard");
  });

  test("scenario 3: 1 role event triggers instant rotate", async () => {
    const rec = makeRecorder();
    const t = team("demo", ["carol"]);
    await tickOnce(t, { carol: ROLE_CAPTURE }, rec, 30_000_000);
    expect(rec.spawnArgs.length).toBe(1);
    expect(rec.spawnArgs[0]).toEqual(["rotate", "carol"]);
    const rotateFires = rec.discord.filter((o) => o.template === "member-refusal-rotate");
    expect(rotateFires[0]?.verdict).toContain("role");
  });

  test("scenario 4: cap exhaustion at 3/day → HARD escalation, no spawn", async () => {
    const rec = makeRecorder();
    const t = team("demo", ["dave"], { maxRotationsPerDay: 3 });
    // t0 = 1971-04-08T09:13:20Z. Cycles 0..2 end at t+7800s (~13:23 UTC)
    // and the 4th cycle ends at t+15000s (~13:23 UTC). All four cycles
    // are within the SAME UTC day — required because the rotations cap
    // (src/core/refusal-trigger.ts countTodayRotations) keys on UTC
    // day via `utcDayKey`. The historical value `40_000_000` landed at
    // 23:06 UTC, so cycles 1..4 straddled UTC midnight and the cap-
    // check at cycle 4 only saw 2 same-day prior rotations instead of
    // 3 → cap didn't fire, 4th rotate spawn slipped through.
    const t0 = 39_950_000;
    // Three full threshold-trip cycles — each fires rotate AND
    // appends one log row. After the third, the cap is saturated.
    for (let cycle = 0; cycle < 3; cycle += 1) {
      for (let i = 0; i < 3; i += 1) {
        await tickOnce(
          t,
          { dave: SOFT_CAPTURES[i] ?? "" },
          rec,
          t0 + cycle * 3600 + i * 300, // 1h between cycles
        );
      }
    }
    expect(rec.spawnArgs.length).toBe(3);
    // 4th cycle — same day per UTC, but cap is now saturated.
    for (let i = 0; i < 3; i += 1) {
      await tickOnce(t, { dave: SOFT_CAPTURES[i] ?? "" }, rec, t0 + 4 * 3600 + i * 300);
    }
    // Still 3 spawn calls — the 4th trip did NOT spawn rotate.
    expect(rec.spawnArgs.length).toBe(3);
    // Complaints table gained at least one cap-hit row.
    const complaintRows = env.db.prepare("SELECT incident_summary FROM complaints").all() as Array<{
      incident_summary: string;
    }>;
    expect(complaintRows.length).toBeGreaterThan(0);
    expect(complaintRows.some((r) => r.incident_summary.includes("cap hit"))).toBe(true);
    // Discord saw a 🚨 fire on the cap-hit cycle.
    const hardFires = rec.discord.filter(
      (o) => o.template === "member-refusal-rotate" && (o.verdict ?? "").includes("🚨"),
    );
    expect(hardFires.length).toBeGreaterThan(0);
  });

  test("scenario 5: exempt member — events recorded but no rotation", async () => {
    const rec = makeRecorder();
    const t = team("demo", ["eve"], { exemptMembers: ["eve"] });
    const t0 = 50_000_000;
    for (let i = 0; i < 3; i += 1) {
      await tickOnce(t, { eve: SOFT_CAPTURES[i] ?? "" }, rec, t0 + i * 300);
    }
    // Rotation skipped entirely.
    expect(rec.spawnArgs.length).toBe(0);
    // But events DID land in refusal_events (audit trail).
    const eventRows = env.db
      .prepare("SELECT COUNT(*) AS n FROM refusal_events WHERE member = ?")
      .get("eve") as { n: number };
    expect(eventRows.n).toBe(3);
  });

  test("scenario 6: backward-compat — no refusalDetection block → defaults apply", async () => {
    const rec = makeRecorder();
    // Team WITHOUT the refusalDetection block — resolveRefusalConfig
    // should apply ADR-139 §D3 defaults (enabled=true, soft=3).
    const t = team("demo", ["frank"], {}, true);
    const t0 = 60_000_000;
    for (let i = 0; i < 3; i += 1) {
      await tickOnce(t, { frank: SOFT_CAPTURES[i] ?? "" }, rec, t0 + i * 300);
    }
    // Defaults apply → rotation fires.
    expect(rec.spawnArgs.length).toBe(1);
    expect(rec.spawnArgs[0]).toEqual(["rotate", "frank"]);
  });
});
