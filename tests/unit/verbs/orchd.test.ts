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

// ---------- ADR-280 stage 3 — the three removed sub-verbs fail LOUD ----------
//
// `--sweep` (ADR-231 §D4), `--reap-stale` (ADR-250 §D2) and
// `--sweep-merges` (ADR-134) all walked epic-teams; stage 3 removed
// them along with `orchd-sweep.ts` / `orchd-reap.ts` and both
// `dispatchEpicMerge` providers, so `--sweep-merges` has no possible
// implementation left. Three describes covering their arg-parsing —
// and one that mocked `orchd-sweep.ts` to drive the dispatch route —
// went with them.
//
// What replaces those cases is the property that actually matters
// after a removal, and that none of them asserted: an operator or cron
// line still passing a retired sub-verb must get a UsageError naming
// the flag, NOT a silent no-op. This is ADR-266 §D2's expired-contract
// precedent, and it is the failure mode ADR-280 §D6 describes — a
// removed verb shelled from inside a loop that tolerates non-zero
// exits disappears without a trace unless it fails loud here.

describe("parseOrchdArgs — retired sub-verbs fail loud (ADR-280 stage 3)", () => {
  test.each([["--sweep"], ["--reap-stale"], ["--sweep-merges"]])(
    "%s is refused with a UsageError naming the flag",
    (flag) => {
      expect(() => parseOrchdArgs([flag])).toThrow(UsageError);
      try {
        parseOrchdArgs([flag]);
        throw new Error("expected a throw");
      } catch (e) {
        expect(String((e as Error).message)).toContain(flag);
      }
    },
  );

  test.each([["sweep"], ["reap-stale"], ["sweep-merges"]])(
    "the bare form %j is refused too — no silent fall-through to another sub-verb",
    (bare) => {
      expect(() => parseOrchdArgs([bare])).toThrow(UsageError);
    },
  );

  test("a retired flag paired with a live one is still refused, not absorbed", () => {
    // The old parser walked left-to-right and let a later sub-verb win,
    // so `--sweep --start` used to resolve to `start`. It must now
    // refuse instead of quietly accepting a line the operator wrote for
    // the removed behaviour.
    expect(() => parseOrchdArgs(["--sweep", "--start"])).toThrow(UsageError);
    expect(() => parseOrchdArgs(["--start", "--sweep"])).toThrow(UsageError);
    expect(() => parseOrchdArgs(["--reap-stale", "--team-dir", "/srv/demo"])).toThrow(UsageError);
  });

  test("the surviving sub-verbs are untouched by the removal", () => {
    expect(parseOrchdArgs(["--start"])).toEqual({ subverb: "start" });
    expect(parseOrchdArgs(["--drain"])).toEqual({ subverb: "drain" });
    expect(parseOrchdArgs(["--status"])).toEqual({ subverb: "status" });
  });
});
