// Unit tests for src/verbs/orchd.ts (ADR-202 §Amendment 2026-05-22 V).
//
// `orchd` is the top-level event-router verb. Body delegates to the
// shared committerDaemonVerb / committerDrainVerb in verbs/committer.ts
// (single source of truth for the multi-topic dispatcher) — these
// tests cover the verb-surface invariants only:
//   - parseOrchdArgs accepts --start / --drain (and bare-word forms)
//   - parseOrchdArgs honors --team-dir / --once / --max-events
//   - parser rejects unknown flags + missing sub-verb
//   - dispatch routes start → committerDaemonVerb, drain → committerDrainVerb

import { describe, expect, test } from "bun:test";
import { UsageError } from "../../../src/errors.ts";
import { parseOrchdArgs } from "../../../src/verbs/orchd.ts";

describe("parseOrchdArgs", () => {
  test("--start parses as start sub-verb", () => {
    expect(parseOrchdArgs(["--start"])).toEqual({ subverb: "start" });
  });

  test("'start' bare form parses identically", () => {
    expect(parseOrchdArgs(["start"])).toEqual({ subverb: "start" });
  });

  test("--drain parses as drain sub-verb", () => {
    expect(parseOrchdArgs(["--drain"])).toEqual({ subverb: "drain" });
  });

  test("'drain' bare form parses identically", () => {
    expect(parseOrchdArgs(["drain"])).toEqual({ subverb: "drain" });
  });

  test("--team-dir captures path", () => {
    expect(parseOrchdArgs(["--start", "--team-dir", "/srv/demo"])).toEqual({
      subverb: "start",
      teamDir: "/srv/demo",
    });
  });

  test("--once flag captured", () => {
    expect(parseOrchdArgs(["--start", "--once"])).toEqual({
      subverb: "start",
      once: true,
    });
  });

  test("--max-events N captured", () => {
    expect(parseOrchdArgs(["--start", "--max-events", "3"])).toEqual({
      subverb: "start",
      maxEvents: 3,
    });
  });

  test("--max-events 0 throws UsageError", () => {
    expect(() => parseOrchdArgs(["--start", "--max-events", "0"])).toThrow(UsageError);
  });

  test("--max-events non-numeric throws UsageError", () => {
    expect(() => parseOrchdArgs(["--start", "--max-events", "abc"])).toThrow(UsageError);
  });

  test("--max-events without value throws", () => {
    expect(() => parseOrchdArgs(["--start", "--max-events"])).toThrow(UsageError);
  });

  test("--team-dir without value throws", () => {
    expect(() => parseOrchdArgs(["--start", "--team-dir"])).toThrow(UsageError);
  });

  test("no sub-verb throws UsageError", () => {
    expect(() => parseOrchdArgs([])).toThrow(UsageError);
    expect(() => parseOrchdArgs(["--team-dir", "/x"])).toThrow(UsageError);
  });

  test("unknown flag throws UsageError", () => {
    expect(() => parseOrchdArgs(["--frobnicate"])).toThrow(UsageError);
  });

  test("unexpected positional arg throws UsageError", () => {
    expect(() => parseOrchdArgs(["--start", "garbage"])).toThrow(UsageError);
  });

  test("combined --start --team-dir --once --max-events all captured", () => {
    expect(
      parseOrchdArgs(["--start", "--team-dir", "/srv/demo", "--once", "--max-events", "5"]),
    ).toEqual({
      subverb: "start",
      teamDir: "/srv/demo",
      once: true,
      maxEvents: 5,
    });
  });

  test("--handle-one with --event-id + --topic parses", () => {
    expect(
      parseOrchdArgs(["--handle-one", "--event-id", "01900xyz", "--topic", "task.done"]),
    ).toEqual({
      subverb: "handle-one",
      eventId: "01900xyz",
      topic: "task.done",
    });
  });

  test("--handle-one without --event-id throws", () => {
    expect(() => parseOrchdArgs(["--handle-one", "--topic", "task.done"])).toThrow(UsageError);
  });

  test("--handle-one without --topic throws", () => {
    expect(() => parseOrchdArgs(["--handle-one", "--event-id", "01900xyz"])).toThrow(UsageError);
  });

  test("--handle-one with --team-dir captured", () => {
    expect(
      parseOrchdArgs([
        "--handle-one",
        "--event-id",
        "e-1",
        "--topic",
        "task.unclaimed",
        "--team-dir",
        "/srv/demo",
      ]),
    ).toEqual({
      subverb: "handle-one",
      eventId: "e-1",
      topic: "task.unclaimed",
      teamDir: "/srv/demo",
    });
  });

  test("--event-id without value throws", () => {
    expect(() => parseOrchdArgs(["--handle-one", "--event-id"])).toThrow(UsageError);
  });

  test("--topic without value throws", () => {
    expect(() => parseOrchdArgs(["--handle-one", "--topic"])).toThrow(UsageError);
  });

  test("--status parses as status sub-verb", () => {
    expect(parseOrchdArgs(["--status"])).toEqual({ subverb: "status" });
  });

  test("'status' bare form parses identically", () => {
    expect(parseOrchdArgs(["status"])).toEqual({ subverb: "status" });
  });

  test("--status with --team-dir captured", () => {
    expect(parseOrchdArgs(["--status", "--team-dir", "/srv/demo"])).toEqual({
      subverb: "status",
      teamDir: "/srv/demo",
    });
  });

  // ADR-202 §Amendment 2026-05-22 IX-A T3 unified contract:
  // --task-id + --lane is the required-pair on `--handle-one --topic
  // task.unclaimed` for the lean per-event dispatch path. --member is
  // an OPTIONAL explicit override (handler/runLaneTickForOne derives
  // member from lane when absent). Mixed (one of pair) rejects; absent
  // both falls through to legacy runLaneTick.
  test("--handle-one + --task-id + --lane parses (no --member)", () => {
    expect(
      parseOrchdArgs([
        "--handle-one",
        "--event-id",
        "01900xyz",
        "--topic",
        "task.unclaimed",
        "--task-id",
        "t-1",
        "--lane",
        "be",
      ]),
    ).toEqual({
      subverb: "handle-one",
      eventId: "01900xyz",
      topic: "task.unclaimed",
      taskId: "t-1",
      lane: "be",
    });
  });

  test("--handle-one + --task-id + --lane + --member (override) all captured", () => {
    expect(
      parseOrchdArgs([
        "--handle-one",
        "--event-id",
        "01900xyz",
        "--topic",
        "task.unclaimed",
        "--task-id",
        "t-1",
        "--lane",
        "be",
        "--member",
        "be-1",
      ]),
    ).toEqual({
      subverb: "handle-one",
      eventId: "01900xyz",
      topic: "task.unclaimed",
      taskId: "t-1",
      lane: "be",
      member: "be-1",
    });
  });

  test("--handle-one without --task-id/--lane falls through (no payload-hint fields)", () => {
    expect(
      parseOrchdArgs([
        "--handle-one",
        "--event-id",
        "01900xyz",
        "--topic",
        "task.unclaimed",
      ]),
    ).toEqual({
      subverb: "handle-one",
      eventId: "01900xyz",
      topic: "task.unclaimed",
    });
  });

  test("--handle-one + --task-id alone (missing --lane) throws UsageError", () => {
    expect(() =>
      parseOrchdArgs([
        "--handle-one",
        "--event-id",
        "01900xyz",
        "--topic",
        "task.unclaimed",
        "--task-id",
        "t-1",
      ]),
    ).toThrow(UsageError);
  });

  test("--handle-one + --lane alone (missing --task-id) throws UsageError", () => {
    expect(() =>
      parseOrchdArgs([
        "--handle-one",
        "--event-id",
        "01900xyz",
        "--topic",
        "task.unclaimed",
        "--lane",
        "be",
      ]),
    ).toThrow(UsageError);
  });

  test("--handle-one + --member alone (no --task-id/--lane) throws UsageError", () => {
    expect(() =>
      parseOrchdArgs([
        "--handle-one",
        "--event-id",
        "01900xyz",
        "--topic",
        "task.unclaimed",
        "--member",
        "be-1",
      ]),
    ).toThrow(UsageError);
  });

  test("--task-id without value throws", () => {
    expect(() =>
      parseOrchdArgs([
        "--handle-one",
        "--event-id",
        "x",
        "--topic",
        "task.unclaimed",
        "--task-id",
      ]),
    ).toThrow(UsageError);
  });

  test("--lane without value throws", () => {
    expect(() =>
      parseOrchdArgs([
        "--handle-one",
        "--event-id",
        "x",
        "--topic",
        "task.unclaimed",
        "--lane",
      ]),
    ).toThrow(UsageError);
  });

  test("--member without value throws", () => {
    expect(() =>
      parseOrchdArgs([
        "--handle-one",
        "--event-id",
        "x",
        "--topic",
        "task.unclaimed",
        "--member",
      ]),
    ).toThrow(UsageError);
  });
});

// ---------- ADR-231 §D4 — --sweep subverb (t-11-84fced39) ----------

describe("parseOrchdArgs — --sweep subverb (ADR-231 §D4)", () => {
  test("--sweep parses as sweep sub-verb", () => {
    expect(parseOrchdArgs(["--sweep"])).toEqual({ subverb: "sweep" });
  });

  test("'sweep' bare form parses identically", () => {
    expect(parseOrchdArgs(["sweep"])).toEqual({ subverb: "sweep" });
  });

  test("--sweep --team-dir captures path", () => {
    expect(parseOrchdArgs(["--sweep", "--team-dir", "/srv/demo"])).toEqual({
      subverb: "sweep",
      teamDir: "/srv/demo",
    });
  });

  test("--sweep --once flag captured (canonical cron-line form)", () => {
    expect(parseOrchdArgs(["--sweep", "--once"])).toEqual({
      subverb: "sweep",
      once: true,
    });
  });

  test("sweep + start mixed (last wins per parser order)", () => {
    // Parser walks left-to-right; last subverb token wins. This pins
    // the existing precedence so a future operator script that
    // accidentally chains sub-verbs doesn't get a surprising verdict.
    expect(parseOrchdArgs(["--sweep", "--start"])).toEqual({ subverb: "start" });
    expect(parseOrchdArgs(["--start", "--sweep"])).toEqual({ subverb: "sweep" });
  });
});

// ---------- ADR-250 §D2 — --reap-stale subverb + --dry-run ----------

describe("parseOrchdArgs — --reap-stale subverb (ADR-250 §D2)", () => {
  test("--reap-stale parses as reap-stale sub-verb", () => {
    expect(parseOrchdArgs(["--reap-stale"])).toEqual({ subverb: "reap-stale" });
  });

  test("'reap-stale' bare form parses identically", () => {
    expect(parseOrchdArgs(["reap-stale"])).toEqual({ subverb: "reap-stale" });
  });

  test("--reap-stale --dry-run captures dryRun", () => {
    expect(parseOrchdArgs(["--reap-stale", "--dry-run"])).toEqual({
      subverb: "reap-stale",
      dryRun: true,
    });
  });

  test("--reap-stale --team-dir + --dry-run all captured", () => {
    expect(parseOrchdArgs(["--reap-stale", "--team-dir", "/srv/demo", "--dry-run"])).toEqual({
      subverb: "reap-stale",
      teamDir: "/srv/demo",
      dryRun: true,
    });
  });

  test("--dry-run omitted ⇒ dryRun absent (not false) — clean exactOptional shape", () => {
    const parsed = parseOrchdArgs(["--reap-stale"]);
    expect("dryRun" in parsed).toBe(false);
  });
});

// ---------- orchd() dispatch — sweep route ----------

describe("orchd() dispatch — --sweep routes through orchdSweep + prints counters JSON", async () => {
  // The dispatch invocation lives in `orchd()` not in `parseOrchdArgs`,
  // and `orchd()` touches the filesystem (getAtmuxDir) + opens a real
  // SQLite db, so we mock at the module-import boundary. Bun's
  // `mock.module` rewires `src/core/orchd-sweep.ts::orchdSweep` to a
  // stub that records its call + returns a fixed counter shape. We
  // also capture stdout to verify the JSON shape.
  const { mock } = await import("bun:test");
  const { mkdtemp, writeFile, mkdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  test("orchd --sweep invokes orchdSweep with resolved atmuxDir + prints JSON counters", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "atmux-orchd-sweep-cli-"));
    const atmuxDir = join(scratch, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({ name: "demo", members: [{ name: "be-1", role: "member", tui: "claude" }] }),
    );

    const sweepCalls: string[] = [];
    mock.module("../../../src/core/orchd-sweep.ts", () => ({
      orchdSweep: async (dir: string) => {
        sweepCalls.push(dir);
        return {
          epicsConsidered: 3,
          epicsSpawned: 1,
          workersConsidered: 2,
          workersDissolved: 0,
        };
      },
    }));

    // Capture stdout writes.
    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: typeof origWrite }).write = ((
      chunk: string | Uint8Array,
    ) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof origWrite;

    try {
      // Late import so module mock is in effect when orchd() runs.
      const { orchd } = await import(
        `../../../src/verbs/orchd.ts?cache=${Date.now()}`
      );
      // `getAtmuxDir({teamDir})` joins `<teamDir>/.atmux`, so pass the
      // scratch root (parent of the .atmux/ dir we created).
      const rc = await orchd(["--sweep", "--team-dir", scratch]);
      expect(rc).toBe(0);
    } finally {
      (process.stdout as unknown as { write: typeof origWrite }).write = origWrite;
    }

    expect(sweepCalls).toHaveLength(1);
    expect(sweepCalls[0]).toBe(atmuxDir);

    const stdout = stdoutChunks.join("");
    expect(stdout.trim()).toBe(
      JSON.stringify({
        epicsConsidered: 3,
        epicsSpawned: 1,
        workersConsidered: 2,
        workersDissolved: 0,
      }),
    );
  });
});
