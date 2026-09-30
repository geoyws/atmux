import { describe, expect, test } from "bun:test";
import {
  type DryRunOp,
  formatDryRunSummary,
  printDryRunPlan,
} from "../../../src/core/tmux-dry-run.ts";
import type { Logger } from "../../../src/core/tui.ts";

function makeLogger(): { logger: Logger; logs: string[] } {
  const logs: string[] = [];
  return {
    logger: {
      log: (m: string) => logs.push(m),
      ok: (m: string) => logs.push(m),
      warn: (m: string) => logs.push(m),
      err: (m: string) => logs.push(m),
    },
    logs,
  };
}

const op = (description: string): DryRunOp => ({ category: "other", description });

describe("printDryRunPlan", () => {
  test("consecutive identical ops collapse with a repeat count", () => {
    const { logger, logs } = makeLogger();
    printDryRunPlan(logger, [
      op("set-option -g prefix F3"),
      op("set-option -g prefix F3"),
      op("set-option -g prefix F3"),
    ]);
    expect(logs[0]).toBe("  · [dry-run] set-option -g prefix F3 (×3)");
  });

  test("non-consecutive repeats stay separate (order preserved)", () => {
    const { logger, logs } = makeLogger();
    printDryRunPlan(logger, [op("a"), op("b"), op("a")]);
    expect(logs.slice(0, 3)).toEqual(["  · [dry-run] a", "  · [dry-run] b", "  · [dry-run] a"]);
  });

  test("single ops print without a count, summary still closes", () => {
    const { logger, logs } = makeLogger();
    printDryRunPlan(logger, [op("kill-server")]);
    expect(logs[0]).toBe("  · [dry-run] kill-server");
    expect(logs[1]).toBe(formatDryRunSummary([{ category: "other", description: "kill-server" }]));
  });
});
