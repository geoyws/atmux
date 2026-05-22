// Unit tests for src/verbs/relayd.ts (ADR-202 §Amendment 2026-05-22 V).
//
// `relayd` is the top-level event-router verb. Body delegates to the
// shared committerDaemonVerb / committerDrainVerb in verbs/committer.ts
// (single source of truth for the multi-topic dispatcher) — these
// tests cover the verb-surface invariants only:
//   - parseRelaydArgs accepts --start / --drain (and bare-word forms)
//   - parseRelaydArgs honors --team-dir / --once / --max-events
//   - parser rejects unknown flags + missing sub-verb
//   - dispatch routes start → committerDaemonVerb, drain → committerDrainVerb

import { describe, expect, test } from "bun:test";
import { UsageError } from "../../../src/errors.ts";
import { parseRelaydArgs } from "../../../src/verbs/relayd.ts";

describe("parseRelaydArgs", () => {
  test("--start parses as start sub-verb", () => {
    expect(parseRelaydArgs(["--start"])).toEqual({ subverb: "start" });
  });

  test("'start' bare form parses identically", () => {
    expect(parseRelaydArgs(["start"])).toEqual({ subverb: "start" });
  });

  test("--drain parses as drain sub-verb", () => {
    expect(parseRelaydArgs(["--drain"])).toEqual({ subverb: "drain" });
  });

  test("'drain' bare form parses identically", () => {
    expect(parseRelaydArgs(["drain"])).toEqual({ subverb: "drain" });
  });

  test("--team-dir captures path", () => {
    expect(parseRelaydArgs(["--start", "--team-dir", "/srv/demo"])).toEqual({
      subverb: "start",
      teamDir: "/srv/demo",
    });
  });

  test("--once flag captured", () => {
    expect(parseRelaydArgs(["--start", "--once"])).toEqual({
      subverb: "start",
      once: true,
    });
  });

  test("--max-events N captured", () => {
    expect(parseRelaydArgs(["--start", "--max-events", "3"])).toEqual({
      subverb: "start",
      maxEvents: 3,
    });
  });

  test("--max-events 0 throws UsageError", () => {
    expect(() => parseRelaydArgs(["--start", "--max-events", "0"])).toThrow(UsageError);
  });

  test("--max-events non-numeric throws UsageError", () => {
    expect(() => parseRelaydArgs(["--start", "--max-events", "abc"])).toThrow(UsageError);
  });

  test("--max-events without value throws", () => {
    expect(() => parseRelaydArgs(["--start", "--max-events"])).toThrow(UsageError);
  });

  test("--team-dir without value throws", () => {
    expect(() => parseRelaydArgs(["--start", "--team-dir"])).toThrow(UsageError);
  });

  test("no sub-verb throws UsageError", () => {
    expect(() => parseRelaydArgs([])).toThrow(UsageError);
    expect(() => parseRelaydArgs(["--team-dir", "/x"])).toThrow(UsageError);
  });

  test("unknown flag throws UsageError", () => {
    expect(() => parseRelaydArgs(["--frobnicate"])).toThrow(UsageError);
  });

  test("unexpected positional arg throws UsageError", () => {
    expect(() => parseRelaydArgs(["--start", "garbage"])).toThrow(UsageError);
  });

  test("combined --start --team-dir --once --max-events all captured", () => {
    expect(
      parseRelaydArgs(["--start", "--team-dir", "/srv/demo", "--once", "--max-events", "5"]),
    ).toEqual({
      subverb: "start",
      teamDir: "/srv/demo",
      once: true,
      maxEvents: 5,
    });
  });

  test("--handle-one with --event-id + --topic parses", () => {
    expect(
      parseRelaydArgs(["--handle-one", "--event-id", "01900xyz", "--topic", "task.done"]),
    ).toEqual({
      subverb: "handle-one",
      eventId: "01900xyz",
      topic: "task.done",
    });
  });

  test("--handle-one without --event-id throws", () => {
    expect(() => parseRelaydArgs(["--handle-one", "--topic", "task.done"])).toThrow(UsageError);
  });

  test("--handle-one without --topic throws", () => {
    expect(() => parseRelaydArgs(["--handle-one", "--event-id", "01900xyz"])).toThrow(UsageError);
  });

  test("--handle-one with --team-dir captured", () => {
    expect(
      parseRelaydArgs([
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
    expect(() => parseRelaydArgs(["--handle-one", "--event-id"])).toThrow(UsageError);
  });

  test("--topic without value throws", () => {
    expect(() => parseRelaydArgs(["--handle-one", "--topic"])).toThrow(UsageError);
  });
});
