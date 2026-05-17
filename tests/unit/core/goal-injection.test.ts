// Unit tests for src/core/goal-injection.ts (ADR-157 T3 / Task t-c89ead5f).
//
// Exercises the 5-cell injection matrix from the task body verbatim:
//   1. member.goal set + runtime=claude → fires
//   2. member.goal unset + brief Standing Goal + runtime=claude → fires with brief-text
//   3. member.goal set + runtime=cursor → SKIPPED
//   4. member.goal unset + no brief Standing Goal → SKIPPED
//   5. verify timeout (composer never clears) → escalates + returns fired=false
//
// Mocks tmux abstractions + injects sleep/now/log so the test runs
// deterministically without real timers or escalation log writes.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SendTarget, TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import { injectGoalIfActive } from "../../../src/core/goal-injection.ts";
import type { TeamMember } from "../../../src/schema/team.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "atmux-goal-injection-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/** Build a mock tmux namespace whose capture-pane returns whatever
 *  `captures.shift()` yields and whose send-keys records the keys
 *  sent for assertion. The mock is intentionally narrow — only the
 *  two surfaces `injectGoalIfActive` touches are real. */
function buildMockTmux(captures: string[], sendRecord: { keys: string[] }): TmuxNamespace {
  return {
    pane: {
      capturePane: async () => {
        const next = captures.shift();
        return next ?? "❯ "; // tail-default to composer-empty
      },
      sendKeys: async ({ keys }: { keys: string }) => {
        sendRecord.keys.push(keys);
      },
    },
    // The rest of the namespace is unused; cast to any to satisfy the
    // structural type without stubbing the entire surface.
  } as unknown as TmuxNamespace;
}

const baseSendTarget: SendTarget = {
  kind: "member",
  member: "alice",
  team: "atmux",
  target: "atmux:🛠-alice",
};

const baseOpts = {
  sendTarget: baseSendTarget,
  paneTargetString: "atmux:🛠-alice",
  sleep: async () => {}, // zero-latency tests
  now: ((): (() => number) => {
    let t = 1_780_000_000_000;
    return () => {
      t += 1000;
      return t;
    };
  })(),
};

describe("injectGoalIfActive — 5-cell matrix (ADR-157 T3)", () => {
  test("(member.goal set, runtime=claude) → fires with explicit goal", async () => {
    const sendRecord = { keys: [] as string[] };
    // First poll returns composer-empty → verifier passes on attempt 1.
    const tmux = buildMockTmux(["❯ "], sendRecord);
    const member: TeamMember = {
      name: "alice",
      runtime: "claude",
      goal: "All members commit in last 30min",
    };
    const result = await injectGoalIfActive({
      ...baseOpts,
      tmux,
      member,
    });
    expect(result.fired).toBe(true);
    expect(result.reason).toBe("fired");
    expect(result.goalText).toBe("All members commit in last 30min");
    expect(sendRecord.keys).toEqual(['/goal "All members commit in last 30min"']);
  });

  test("(member.goal unset, brief has Standing Goal, runtime=claude) → fires with brief-text", async () => {
    const briefPath = join(tempDir, "lead.md");
    await writeFile(briefPath, "## Standing Goal\n\nKanban.status=blocked is empty\n");
    const sendRecord = { keys: [] as string[] };
    const tmux = buildMockTmux(["❯ "], sendRecord);
    const member: TeamMember = { name: "lead", runtime: "claude" };
    const result = await injectGoalIfActive({
      ...baseOpts,
      tmux,
      member,
      briefPath,
    });
    expect(result.fired).toBe(true);
    expect(result.goalText).toBe("Kanban.status=blocked is empty");
    expect(sendRecord.keys).toEqual(['/goal "Kanban.status=blocked is empty"']);
  });

  test("(member.goal set, runtime=cursor) → SKIPPED (D4 carve-out)", async () => {
    const sendRecord = { keys: [] as string[] };
    const tmux = buildMockTmux([], sendRecord);
    const member: TeamMember = {
      name: "martinet",
      runtime: "cursor",
      goal: "would-be-ignored",
    };
    const result = await injectGoalIfActive({ ...baseOpts, tmux, member });
    expect(result.fired).toBe(false);
    expect(result.reason).toBe("runtime=cursor");
    expect(sendRecord.keys).toEqual([]); // no send-keys fired
  });

  test("(member.goal unset, no brief Standing Goal) → SKIPPED", async () => {
    const briefPath = join(tempDir, "lead.md");
    await writeFile(briefPath, "# brief\n\nno standing goal section\n");
    const sendRecord = { keys: [] as string[] };
    const tmux = buildMockTmux([], sendRecord);
    const member: TeamMember = { name: "alice", runtime: "claude" };
    const result = await injectGoalIfActive({
      ...baseOpts,
      tmux,
      member,
      briefPath,
    });
    expect(result.fired).toBe(false);
    expect(result.reason).toBe("no goal active");
    expect(sendRecord.keys).toEqual([]);
  });

  test("(verify timeout — composer never clears) → escalates + returns fired=false", async () => {
    const sendRecord = { keys: [] as string[] };
    // Captures always show a busy compose box (no ❯ at end-of-line) so
    // composerEmpty() never returns true. ADR-138 default retries=1 →
    // total 2 send attempts; default timeoutMs=3000 + pollIntervalMs=250.
    // We feed enough busy captures to exhaust both attempts.
    const busy = "busy-line-no-prompt-marker\n";
    const tmux = buildMockTmux(
      Array.from({ length: 100 }, () => busy),
      sendRecord,
    );
    const member: TeamMember = {
      name: "alice",
      runtime: "claude",
      goal: "test-goal",
    };
    const result = await injectGoalIfActive({
      ...baseOpts,
      tmux,
      member,
      // suppress escalation log writes during tests
    });
    expect(result.fired).toBe(false);
    expect(result.reason).toBe("verify-failed");
    expect(result.attempts).toBeGreaterThanOrEqual(2); // exhausted retries
    // Send-keys WAS attempted at least once (the failure is verify-side,
    // not send-side).
    expect(sendRecord.keys.length).toBeGreaterThanOrEqual(1);
    expect(sendRecord.keys[0]).toBe('/goal "test-goal"');
  });
});

describe("injectGoalIfActive — opt-out + quoting", () => {
  test("member.goal === '' → skipped (opt-out, no fire)", async () => {
    const sendRecord = { keys: [] as string[] };
    const tmux = buildMockTmux([], sendRecord);
    const member: TeamMember = {
      name: "alice",
      runtime: "claude",
      goal: "",
    };
    const result = await injectGoalIfActive({ ...baseOpts, tmux, member });
    expect(result.fired).toBe(false);
    expect(result.reason).toBe("no goal active");
    expect(sendRecord.keys).toEqual([]);
  });

  test("goal containing embedded quote → escaped in send-keys payload", async () => {
    const sendRecord = { keys: [] as string[] };
    const tmux = buildMockTmux(["❯ "], sendRecord);
    const member: TeamMember = {
      name: "alice",
      runtime: "claude",
      goal: 'condition with "quotes" inside',
    };
    const result = await injectGoalIfActive({ ...baseOpts, tmux, member });
    expect(result.fired).toBe(true);
    expect(sendRecord.keys[0]).toBe('/goal "condition with \\"quotes\\" inside"');
  });
});
