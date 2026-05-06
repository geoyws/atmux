/**
 * Harness self-tests for `compare.ts` — ADR-027 channel-mask logic.
 *
 * These tests live under `tests/parity/` and are excluded from the
 * lcov-gate denominator per ADR-009 §2 (`tests/**` exclusion). They
 * exist for behavioural correctness — catching mask-logic bugs before
 * they cause silent false-greens or false-reds at matrix-row evaluation
 * time. Drift surfaces here, not via a mysterious parity divergence
 * later (CLAUDE.md "verify green from the right path").
 *
 * Pair: `tests/parity/compare.ts` (mask implementation);
 *       `tests/parity/matrix.ts` (`ChannelMask` + `ParityRow.mask`);
 *       `docs/adr-bun/027-parity-channel-mask.md` (contract).
 */

import { describe, expect, test } from "bun:test";
import {
  compare,
  compareGolden,
  maskChannel,
  STATE_AFTER_MASKED_SENTINEL,
} from "./compare.ts";
import type { ChannelMask } from "./matrix.ts";
import type { FsSnapshot, ParityRun } from "./runner.ts";

const encoder = new TextEncoder();

function jsonFile(value: unknown): FsSnapshot[string] {
  const text = JSON.stringify(value);
  return {
    bytes: encoder.encode(text),
    mode: 0o644,
    isJson: true,
    parsed: value,
  };
}

function textFile(text: string): FsSnapshot[string] {
  return {
    bytes: encoder.encode(text),
    mode: 0o644,
    isJson: false,
  };
}

function makeRun(overrides: Partial<ParityRun>): ParityRun {
  return {
    side: "bash",
    verb: "task",
    args: ["add", "test"],
    fixturePath: "/tmp/fake",
    stdout: "",
    stderr: "",
    exit: 0,
    fsState: {},
    discordCalls: [],
    durationMs: 0,
    ...overrides,
  };
}

describe("compare — ADR-027 channel-mask", () => {
  describe("no mask (regression)", () => {
    test("identical runs produce empty divergences", () => {
      const bash = makeRun({});
      const ts = makeRun({ side: "ts" });
      expect(compare(bash, ts)).toEqual([]);
    });

    test("exit-code mismatch flagged when no mask present", () => {
      const bash = makeRun({ exit: 1 });
      const ts = makeRun({ side: "ts", exit: 78 });
      const divergences = compare(bash, ts);
      expect(divergences).toHaveLength(1);
      expect(divergences[0]?.channel).toBe("exit");
    });

    test("stdout mismatch flagged when no mask present", () => {
      const bash = makeRun({ stdout: "💥 atmux init no team.json" });
      const ts = makeRun({ side: "ts", stdout: "atmux: config: no team.json" });
      const divergences = compare(bash, ts);
      expect(divergences).toHaveLength(1);
      expect(divergences[0]?.channel).toBe("stdout");
    });
  });

  describe("mask.exitCode", () => {
    test("skips exit-code channel when true", () => {
      const bash = makeRun({ exit: 1 });
      const ts = makeRun({ side: "ts", exit: 78 });
      const mask: ChannelMask = { exitCode: true };
      expect(compare(bash, ts, mask)).toEqual([]);
    });

    test("undefined exitCode leaves exit channel active", () => {
      const bash = makeRun({ exit: 1 });
      const ts = makeRun({ side: "ts", exit: 78 });
      const mask: ChannelMask = {};
      const divergences = compare(bash, ts, mask);
      expect(divergences).toHaveLength(1);
      expect(divergences[0]?.channel).toBe("exit");
    });
  });

  describe("mask.stdout / mask.stderr", () => {
    test("regex mask strips first match before byte-equal (stdout)", () => {
      const bash = makeRun({ stdout: "💥 atmux task done!" });
      const ts = makeRun({ side: "ts", stdout: "atmux: task: done!" });
      // reason: bash emoji-tag vs TS structured-tag prefix (ADR-027 error-rendering class)
      const mask: ChannelMask = { stdout: /^(💥 atmux \S+ |atmux: \S+: )/ };
      expect(compare(bash, ts, mask)).toEqual([]);
    });

    test("string mask removes first occurrence", () => {
      const bash = makeRun({ stderr: "PREFIX-bash done" });
      const ts = makeRun({ side: "ts", stderr: "PREFIX-ts done" });
      // The string mask only strips one literal — both sides need to converge.
      const mask: ChannelMask = { stderr: "PREFIX-bash" };
      // After mask: bash="" + " done", ts unchanged. Still divergent — string
      // masks must match BOTH sides' surface to be useful in practice.
      const divergences = compare(bash, ts, mask);
      expect(divergences).toHaveLength(1);
      expect(divergences[0]?.channel).toBe("stderr");
    });

    test("regex without /g replaces only first occurrence (by design)", () => {
      const bash = makeRun({ stderr: "AAA done AAA" });
      const ts = makeRun({ side: "ts", stderr: "BBB done AAA" });
      const mask: ChannelMask = { stderr: /^[A-Z]{3}/ };
      // Both sides: first 3 caps stripped → " done AAA" on both → green.
      expect(compare(bash, ts, mask)).toEqual([]);
    });

    test("absent mask leaves channel byte-exact (post timestamp mask)", () => {
      const bash = makeRun({ stderr: "diverge-bash" });
      const ts = makeRun({ side: "ts", stderr: "diverge-ts" });
      const divergences = compare(bash, ts);
      expect(divergences).toHaveLength(1);
      expect(divergences[0]?.channel).toBe("stderr");
    });
  });

  describe("mask.stateAfter — JSON field elision", () => {
    const bashKanban = {
      tasks: [
        { id: "t-abcd1234", title: "test", createdAt: 1700000000 },
        { id: "t-deadbeef", title: "two", createdAt: 1700000001 },
      ],
    };
    const tsKanban = {
      tasks: [
        { id: "t-11112222", title: "test", createdAt: 1800000000 },
        { id: "t-33334444", title: "two", createdAt: 1800000001 },
      ],
    };

    test("elides matching string + number fields with [*] wildcard", () => {
      const bash = makeRun({
        fsState: { ".atmux/kanban.json": jsonFile(bashKanban) },
      });
      const ts = makeRun({
        side: "ts",
        fsState: { ".atmux/kanban.json": jsonFile(tsKanban) },
      });
      const mask: ChannelMask = {
        stateAfter: {
          // reason: 8-hex random per invocation (ADR-027 state-after class)
          "kanban.tasks[*].id": /^t-[0-9a-f]{8}$/,
          // reason: Unix epoch per invocation (ADR-027 state-after class)
          "kanban.tasks[*].createdAt": /^\d{10,}$/,
        },
      };
      expect(compare(bash, ts, mask)).toEqual([]);
    });

    test("non-matching values still flag divergence", () => {
      const bash = makeRun({
        fsState: {
          ".atmux/kanban.json": jsonFile({ tasks: [{ id: "t-abcd1234", title: "diff-bash" }] }),
        },
      });
      const ts = makeRun({
        side: "ts",
        fsState: {
          ".atmux/kanban.json": jsonFile({ tasks: [{ id: "t-11112222", title: "diff-ts" }] }),
        },
      });
      // Mask elides .id (8-hex) but title isn't masked → divergence on title.
      const mask: ChannelMask = {
        stateAfter: { "kanban.tasks[*].id": /^t-[0-9a-f]{8}$/ },
      };
      const divergences = compare(bash, ts, mask);
      expect(divergences).toHaveLength(1);
      expect(divergences[0]?.channel).toBe("fs");
    });

    test("glob with non-matching filename stem is a no-op", () => {
      const bash = makeRun({
        fsState: { ".atmux/team.json": jsonFile({ name: "x" }) },
      });
      const ts = makeRun({
        side: "ts",
        fsState: { ".atmux/team.json": jsonFile({ name: "y" }) },
      });
      // Mask targets `kanban.*` but file is `team.json` → unchanged → divergence.
      const mask: ChannelMask = {
        stateAfter: { "kanban.tasks[*].id": /^t-[0-9a-f]{8}$/ },
      };
      const divergences = compare(bash, ts, mask);
      expect(divergences).toHaveLength(1);
      expect(divergences[0]?.channel).toBe("fs");
    });

    test("glob with non-existent path is a no-op (no crash, no false-green)", () => {
      const bash = makeRun({
        fsState: { ".atmux/kanban.json": jsonFile({ tasks: [{ title: "a" }] }) },
      });
      const ts = makeRun({
        side: "ts",
        fsState: { ".atmux/kanban.json": jsonFile({ tasks: [{ title: "b" }] }) },
      });
      const mask: ChannelMask = {
        stateAfter: { "kanban.tasks[*].id": /^t-[0-9a-f]{8}$/ },
      };
      const divergences = compare(bash, ts, mask);
      // Path `.id` doesn't exist on either side — mask is no-op; title differs → divergence.
      expect(divergences).toHaveLength(1);
      expect(divergences[0]?.channel).toBe("fs");
    });

    test("malformed glob (no dot) is silently skipped", () => {
      const bash = makeRun({
        fsState: { ".atmux/kanban.json": jsonFile({ tasks: [{ id: "x" }] }) },
      });
      const ts = makeRun({
        side: "ts",
        fsState: { ".atmux/kanban.json": jsonFile({ tasks: [{ id: "y" }] }) },
      });
      // No dot → invalid glob → no-op. Mask doesn't apply; divergence still flagged.
      const mask: ChannelMask = { stateAfter: { malformed: /.*/ } };
      const divergences = compare(bash, ts, mask);
      expect(divergences).toHaveLength(1);
      expect(divergences[0]?.channel).toBe("fs");
    });

    test("malformed path token (empty segment) is silently skipped", () => {
      const bash = makeRun({
        fsState: { ".atmux/kanban.json": jsonFile({ a: 1 }) },
      });
      const ts = makeRun({
        side: "ts",
        fsState: { ".atmux/kanban.json": jsonFile({ a: 2 }) },
      });
      // Empty path segment → parseStateAfterPath returns []
      const mask: ChannelMask = { stateAfter: { "kanban..a": /.*/ } };
      const divergences = compare(bash, ts, mask);
      expect(divergences).toHaveLength(1);
    });

    test("filename without .json extension still resolves stem", () => {
      const bash = makeRun({
        fsState: { ".atmux/kanban": jsonFile({ tasks: [{ id: "t-abcd1234" }] }) },
      });
      const ts = makeRun({
        side: "ts",
        fsState: { ".atmux/kanban": jsonFile({ tasks: [{ id: "t-11112222" }] }) },
      });
      const mask: ChannelMask = {
        stateAfter: { "kanban.tasks[*].id": /^t-[0-9a-f]{8}$/ },
      };
      expect(compare(bash, ts, mask)).toEqual([]);
    });

    test("wildcard against non-array is a no-op", () => {
      // .tasks is an object, not an array — wildcard navigation must not crash.
      const bash = makeRun({
        fsState: { ".atmux/kanban.json": jsonFile({ tasks: { id: "t-abcd1234" } }) },
      });
      const ts = makeRun({
        side: "ts",
        fsState: { ".atmux/kanban.json": jsonFile({ tasks: { id: "t-11112222" } }) },
      });
      const mask: ChannelMask = {
        stateAfter: { "kanban.tasks[*].id": /^t-[0-9a-f]{8}$/ },
      };
      // Wildcard can't iterate an object — mask becomes no-op → divergence.
      const divergences = compare(bash, ts, mask);
      expect(divergences).toHaveLength(1);
    });

    test("sentinel is literal-distinct enough to not coincide with real values", () => {
      // Defensive: if a verb actually emitted the sentinel, that would itself
      // be wildly anomalous, but check the sentinel string is recognisable.
      expect(STATE_AFTER_MASKED_SENTINEL).toBe("__ADR_027_MASKED__");
    });
  });

  describe("mask.stateAfter — non-JSON byte content elision (ADR-028)", () => {
    test("elides matching epoch in plain-text file when full basename matches glob stem", () => {
      const bash = makeRun({
        fsState: { ".atmux/state/last-report.epoch": textFile("1700000001\n") },
      });
      const ts = makeRun({
        side: "ts",
        fsState: { ".atmux/state/last-report.epoch": textFile("1700000002\n") },
      });
      const mask: ChannelMask = {
        stateAfter: { "last-report.epoch.value": /^\d{10,}\n?$/ },
      };
      expect(compare(bash, ts, mask)).toEqual([]);
    });

    test("non-matching content still flags fs divergence", () => {
      const bash = makeRun({
        fsState: { ".atmux/state/last-report.epoch": textFile("not-a-number\n") },
      });
      const ts = makeRun({
        side: "ts",
        fsState: { ".atmux/state/last-report.epoch": textFile("also-not\n") },
      });
      const mask: ChannelMask = {
        stateAfter: { "last-report.epoch.value": /^\d{10,}\n?$/ },
      };
      expect(compare(bash, ts, mask)).toHaveLength(1);
    });

    test("pre-dot prefix matches glob stem (foo.txt → stem foo)", () => {
      const bash = makeRun({ fsState: { ".atmux/state/foo.txt": textFile("123\n") } });
      const ts = makeRun({
        side: "ts",
        fsState: { ".atmux/state/foo.txt": textFile("456\n") },
      });
      const mask: ChannelMask = { stateAfter: { "foo.value": /^\d+\n?$/ } };
      expect(compare(bash, ts, mask)).toEqual([]);
    });

    test("malformed glob (no dot) is silently skipped — divergence stands", () => {
      const bash = makeRun({
        fsState: { ".atmux/state/last-report.epoch": textFile("1700000001\n") },
      });
      const ts = makeRun({
        side: "ts",
        fsState: { ".atmux/state/last-report.epoch": textFile("1700000002\n") },
      });
      const mask: ChannelMask = { stateAfter: { malformed: /.*/ } };
      expect(compare(bash, ts, mask)).toHaveLength(1);
    });

    test("glob stem matching a different file is a no-op — divergence stands", () => {
      const bash = makeRun({
        fsState: { ".atmux/state/last-report.epoch": textFile("1700000001\n") },
      });
      const ts = makeRun({
        side: "ts",
        fsState: { ".atmux/state/last-report.epoch": textFile("1700000002\n") },
      });
      const mask: ChannelMask = { stateAfter: { "other-file.value": /^\d+\n?$/ } };
      expect(compare(bash, ts, mask)).toHaveLength(1);
    });

    test("regex non-match leaves bytes unmasked — real divergence still flagged", () => {
      const bash = makeRun({
        fsState: { ".atmux/state/last-report.epoch": textFile("alpha\n") },
      });
      const ts = makeRun({
        side: "ts",
        fsState: { ".atmux/state/last-report.epoch": textFile("beta\n") },
      });
      // Regex demands digits but content is letters — fail-open path leaves
      // bytes unmasked, so the byte-differ surfaces normally.
      const mask: ChannelMask = {
        stateAfter: { "last-report.epoch.value": /^\d{10,}\n?$/ },
      };
      expect(compare(bash, ts, mask)).toHaveLength(1);
    });
  });
});

describe("compareGolden — ADR-028 golden-file harness mode", () => {
  test("byte-equal post-mask passes", () => {
    const bash = makeRun({ stdout: "hello world\n" });
    const divergences = compareGolden(bash, "hello world\n");
    expect(divergences).toEqual([]);
  });

  test("mismatch surfaces 1 stdout divergence", () => {
    const bash = makeRun({ stdout: "actual\n" });
    const divergences = compareGolden(bash, "expected\n");
    expect(divergences).toHaveLength(1);
    expect(divergences[0]?.channel).toBe("stdout");
    expect(divergences[0]?.detail).toContain("golden mismatch");
  });

  test("per-row stdout mask runs BEFORE comparison", () => {
    const bash = makeRun({ stdout: "prefix t-deadbeef trailer 14:30 MYT\n" });
    // Strip the random task id; timestamp mask handled by global path.
    const mask: ChannelMask = { stdout: /t-[0-9a-f]{8}/ };
    const divergences = compareGolden(bash, "prefix  trailer HH:MM MYT\n", mask);
    expect(divergences).toEqual([]);
  });

  test("global timestamp mask runs after per-row mask", () => {
    const bash = makeRun({ stdout: "header 09:00 MYT\nbody\n" });
    // No per-row mask; global `\d{2}:\d{2} MYT` mask should normalise.
    const divergences = compareGolden(bash, "header HH:MM MYT\nbody\n");
    expect(divergences).toEqual([]);
  });

  test("stderr / fs / discord channels are NOT compared (bash-only contract)", () => {
    // Even with stderr divergence on the bash run, golden mode only looks
    // at stdout — that's the documented bash-only contract per ADR-028.
    const bash = makeRun({ stdout: "ok\n", stderr: "bash-internal-warning\n" });
    const divergences = compareGolden(bash, "ok\n");
    expect(divergences).toEqual([]);
  });
});

describe("maskChannel — exported helper for capture path", () => {
  test("applies per-row + timestamp masks symmetrically with compare/compareGolden", () => {
    expect(maskChannel("hello 14:30 MYT")).toBe("hello HH:MM MYT");
  });

  test("per-row mask runs first", () => {
    expect(maskChannel("prefix t-deadbeef trailer\n", /t-[0-9a-f]{8}/)).toBe(
      "prefix  trailer\n",
    );
  });

  test("absent per-row mask is a no-op for the per-row layer", () => {
    expect(maskChannel("no-changes-needed\n")).toBe("no-changes-needed\n");
  });
});
