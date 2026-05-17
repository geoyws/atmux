// Unit tests for src/core/pulse-verdict.ts (ADR-086 Phase 1).
//
// 100% branch coverage on `computeVerdict` + `describeVerdict`.

import { describe, expect, test } from "bun:test";
import {
  computeVerdict,
  describeVerdict,
  type PulseInputs,
  type PulseVerdict,
} from "../../../src/core/pulse-verdict.ts";

function baseInputs(over: Partial<PulseInputs> = {}): PulseInputs {
  return {
    commitCount: 0,
    doctorRed: 0,
    inProgressCount: 0,
    todoCount: 0,
    staleDriverInboxCount: 0,
    pendingDecisionsCount: 0,
    windowMin: 30,
    windowAgeMin: 60,
    ...over,
  };
}

describe("computeVerdict — precedence", () => {
  test("🚨 Need you wins on stale driver-ask alone", () => {
    const v = computeVerdict(baseInputs({ staleDriverInboxCount: 1 }));
    expect(v).toBe("🚨 Need you" as PulseVerdict);
  });

  test("🚨 Need you wins on pending decisions alone", () => {
    const v = computeVerdict(baseInputs({ pendingDecisionsCount: 1 }));
    expect(v).toBe("🚨 Need you" as PulseVerdict);
  });

  test("🚨 Need you wins even when commits are landing", () => {
    const v = computeVerdict(
      baseInputs({ commitCount: 5, doctorRed: 0, staleDriverInboxCount: 2 }),
    );
    expect(v).toBe("🚨 Need you" as PulseVerdict);
  });
});

describe("computeVerdict — shipping", () => {
  test("🟢 Shipping when commits + doctor green", () => {
    const v = computeVerdict(baseInputs({ commitCount: 3, doctorRed: 0 }));
    expect(v).toBe("🟢 Shipping" as PulseVerdict);
  });

  test("not 🟢 Shipping when doctor red is non-zero — falls to Idle", () => {
    // Commits landing AND doctor red AND something in-progress: the
    // shipping branch is gated by doctorRed === 0, so we fall through.
    // commits>0 means it's not Stalled either (Stalled requires silence);
    // there's queued work so it's not Cool. Idle is the right answer:
    // "work exists, the green-shipping signal is broken, look at me".
    const v = computeVerdict(baseInputs({ commitCount: 3, doctorRed: 1, inProgressCount: 1 }));
    expect(v).toBe("🟡 Idle" as PulseVerdict);
  });
});

describe("computeVerdict — stalled / idle split", () => {
  test("🔴 Stalled when 0 commits + in-progress >=1 + window aged past windowMin", () => {
    const v = computeVerdict(
      baseInputs({
        commitCount: 0,
        inProgressCount: 2,
        todoCount: 5,
        windowMin: 30,
        windowAgeMin: 60,
      }),
    );
    expect(v).toBe("🔴 Stalled" as PulseVerdict);
  });

  test("🟡 Idle when 0 commits + in-progress >=1 but window too young", () => {
    const v = computeVerdict(
      baseInputs({
        commitCount: 0,
        inProgressCount: 2,
        windowMin: 30,
        windowAgeMin: 10,
      }),
    );
    expect(v).toBe("🟡 Idle" as PulseVerdict);
  });

  test("🟡 Idle when 0 commits + todos exist but no in-progress (independent of age)", () => {
    const v = computeVerdict(
      baseInputs({
        commitCount: 0,
        inProgressCount: 0,
        todoCount: 3,
        windowAgeMin: 999,
      }),
    );
    expect(v).toBe("🟡 Idle" as PulseVerdict);
  });
});

describe("computeVerdict — cool", () => {
  test("🟡 Cool when nothing in flight at all", () => {
    const v = computeVerdict(
      baseInputs({
        commitCount: 0,
        inProgressCount: 0,
        todoCount: 0,
        windowAgeMin: 999,
      }),
    );
    expect(v).toBe("🟡 Cool" as PulseVerdict);
  });
});

describe("describeVerdict — verdict body strings", () => {
  test("🟢 Shipping body singular vs plural", () => {
    const one = describeVerdict(baseInputs({ commitCount: 1 }), "🟢 Shipping");
    expect(one).toContain("1 commit in 30min");
    expect(one).toContain("doctor green");
    const many = describeVerdict(baseInputs({ commitCount: 4 }), "🟢 Shipping");
    expect(many).toContain("4 commits in 30min");
  });

  test("🟡 Cool body cites window", () => {
    const s = describeVerdict(baseInputs({ windowMin: 30 }), "🟡 Cool");
    expect(s).toContain("kanban empty");
    expect(s).toContain("30min");
  });

  test("🟡 Idle body sums todo + in-progress", () => {
    const s = describeVerdict(
      baseInputs({ todoCount: 4, inProgressCount: 2, windowMin: 30 }),
      "🟡 Idle",
    );
    expect(s).toContain("6 task(s) queued");
    expect(s).toContain("0 commits in 30min");
  });

  test("🔴 Stalled body cites in-progress count", () => {
    const s = describeVerdict(baseInputs({ inProgressCount: 3, windowMin: 30 }), "🔴 Stalled");
    expect(s).toContain("3 in-progress");
    expect(s).toContain("0 commits in 30min");
  });

  test("🚨 Need you body — driver asks only", () => {
    const s = describeVerdict(baseInputs({ staleDriverInboxCount: 2 }), "🚨 Need you");
    expect(s).toContain("2 stale driver-ask(s)");
    expect(s).not.toContain("open decision");
  });

  test("🚨 Need you body — decisions only", () => {
    const s = describeVerdict(baseInputs({ pendingDecisionsCount: 1 }), "🚨 Need you");
    expect(s).toContain("1 open decision(s)");
    expect(s).not.toContain("driver-ask");
  });

  test("🚨 Need you body — both", () => {
    const s = describeVerdict(
      baseInputs({ staleDriverInboxCount: 2, pendingDecisionsCount: 1 }),
      "🚨 Need you",
    );
    expect(s).toContain("2 stale driver-ask(s)");
    expect(s).toContain("1 open decision(s)");
  });
});
