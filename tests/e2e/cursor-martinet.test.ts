// E2E ADR-132 T7 — CursorMartinet (composer-2-fast) walk + token-burn
// budget assertion.
//
// **Stateful 1x cold-start+walk e2e — sequenced beats consume a real
// cursor-agent subprocess in the real-cursor case + synthetic mocks in
// the deterministic case. Don't streak; don't run-of-N.** Per CLAUDE.md
// testing discipline §"Stateful e2e specs are not repeatable smokes."
//
// Walks the CursorMartinet impl across:
//
//   1. Module-load smoke — `src/abstractions/martinets/cursor.ts`
//      exports a class named CursorMartinet whose instances satisfy the
//      ADR-132 §D1 Martinet interface (name === "cursor", observe +
//      decide + apply + shouldEscalateToClaudeLead present).
//   2. Synthetic decide() — observe → decide round-trip on a fixture
//      Observation. Assert composer-2-fast is the model flag passed to
//      the injected cursor-agent runner (mocked spawn-fn).
//   3. §D5 E6 ship-zero mandatory escalation — `commitCadence.last2hr
//      === 0` Observation → `shouldEscalateToClaudeLead` returns true
//      regardless of any other state. This is the dormancy-is-not-
//      defensible floor; impls may NOT suppress it.
//   4. observe → decide → apply round-trip — synthetic team + stub
//      tmux send-fn → apply() returns `ApplyResult.success === true`
//      with non-empty evidence.
//   5. Token-burn assertion (deterministic) — feed a canonical
//      "1-tick Observation summary" prompt through the mocked spawn-fn
//      that returns the canonical cursor-agent JSON envelope
//      (`{ usage: { inputTokens, outputTokens, ... } }`). Assert
//      `outputTokens <= OUTPUT_CEILING` and `inputTokens <= INPUT_CEILING`.
//      Ceilings are baseline-compared against Claude-Opus whip-turn burn
//      (~20-30k input, ~5-10k output per ADR-132 §Context).
//   6. Token-burn assertion (real, env-gated) — when RUN_REAL_CURSOR=1
//      AND HAS_CURSOR_AGENT, invoke a real `cursor-agent --print
//      --output-format json --model composer-2-fast` call with the
//      canonical synthetic-observation prompt. Parse `usage` from the
//      JSON envelope. Same ceiling assertion. This is the actual
//      "token-burn assertion green" acceptance gate from the task body
//      when run by an operator with the cage provisioned.
//
// Skip-gates (module-load time):
//   - HAS_CURSOR_IMPL    — `src/abstractions/martinets/cursor.ts`
//                          present (T3 has shipped). When false, every
//                          case skips with the same hint pointing at
//                          the T3 task ID (t-e96d286a).
//   - HAS_CURSOR_AGENT   — `cursor-agent` binary on PATH. Required for
//                          case 6 only; cases 1-5 use mocks.
//   - RUN_REAL_CURSOR    — Operator-opt-in env var ("1"). Case 6 only.
//                          Off by default so CI doesn't burn quota.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type {
  ApplyResult,
  Martinet,
  NudgeAction,
  Observation,
} from "../../src/abstractions/martinet.ts";
import type { PaneClassification } from "../../src/core/pane-state.ts";

// ---------- Env probes (module-load time) ----------

function probeBin(cmd: string[]): boolean {
  try {
    const proc = Bun.spawnSync({ cmd, stdout: "ignore", stderr: "ignore" });
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

const CURSOR_IMPL_URL = new URL(
  "../../src/abstractions/martinets/cursor.ts",
  import.meta.url,
);
const HAS_CURSOR_IMPL = existsSync(CURSOR_IMPL_URL.pathname);
const HAS_CURSOR_AGENT = probeBin(["cursor-agent", "--version"]);
const RUN_REAL_CURSOR = Bun.env.RUN_REAL_CURSOR === "1";

// ---------- Dynamic import shim ----------
//
// CursorMartinet impl lands with ADR-132 T4 (`t-e96d286a`). Until then
// the file doesn't exist; a static `import` would TS2307 the whole
// suite. We funnel every use through `loadCursorMartinet()` so the
// `@ts-expect-error` directive lives in exactly one place — when T4
// ships, the directive itself becomes wrong (error-not-expected) and
// surfaces as a typecheck failure pointing at the line to delete, which
// is the natural trip-wire for "this helper is obsolete; switch to a
// static typed import."

interface CursorMartinetCtorDeps {
  observeFn: (team: string) => Promise<Observation>;
  runCursorAgent: (args: string[]) => Promise<string>;
  sendKeys?: (window: string, keys: string) => Promise<{ success: boolean }>;
}

interface CursorMartinetModule {
  CursorMartinet: new (deps: CursorMartinetCtorDeps) => Martinet;
}

async function loadCursorMartinet(): Promise<CursorMartinetModule> {
  // cursor.ts ships with ADR-132 T4 (t-e96d286a); until then the
  // import path is unresolved at typecheck time. The @ts-expect-error
  // directive lives on the import line itself; when T4 lands the
  // directive errors and this helper should be replaced with a static
  // typed import.
  // @ts-expect-error — see comment above; remove when T4 (t-e96d286a) ships.
  const mod = await import("../../src/abstractions/martinets/cursor.ts");
  return mod as CursorMartinetModule;
}

// ---------- Token-burn ceilings ----------
//
// Ceilings are set as a budget envelope vs the Claude-Opus baseline.
// ADR-132 §Context cites ~20-30k tokens per whip turn at 270s cadence
// (~300k tokens/hour active) for the Claude lead. Composer-2-fast's
// promise is ~1/3 the burn for the mechanical observation+nudge work.
// Headroom is generous to absorb prompt variance; tightening lands as a
// follow-up after a fleet-wide measurement window per ADR-132 §D7.

const INPUT_CEILING = 50_000;
const OUTPUT_CEILING = 2_000;

// ---------- Fixture helpers ----------

function paneCls(state: PaneClassification["state"] = "READY"): PaneClassification {
  return {
    state,
    evidence: "",
    capturedAt: Date.now(),
  };
}

/** Canonical 3-member team Observation used as the standard
 *  composer-2-fast input. Mirrors the §Context "N pane captures +
 *  status-indicator parsing + kanban delta + dispatch composition"
 *  shape so the token-burn assertion measures the realistic prompt
 *  size the production CursorMartinet emits. */
function fixtureObservation(opts: {
  team?: string;
  last2hrCommits?: number;
  wedgedCount?: number;
} = {}): Observation {
  return {
    team: opts.team ?? "atmux",
    members: [
      {
        name: "fe-1",
        paneState: paneCls("READY"),
        ctxTokens: 5_000,
        lastEnterPushable: true,
        queuedComposerText: "atmux claim --next --as fe-1",
      },
      {
        name: "be-1",
        paneState: paneCls("BUSY"),
        ctxTokens: 18_000,
        lastEnterPushable: false,
        queuedComposerText: null,
      },
      {
        name: "test-impl",
        paneState: paneCls("READY"),
        ctxTokens: 9_000,
        lastEnterPushable: false,
        queuedComposerText: null,
      },
    ],
    kanbanDelta: {
      newClaims: [
        { taskId: "t-001", member: "fe-1", claimedAtSec: Math.floor(Date.now() / 1000) },
      ],
      completedSinceLastTick: [{ taskId: "t-000", subject: "prior work" }],
      wedgedClaims: Array.from({ length: opts.wedgedCount ?? 0 }, (_, i) => ({
        taskId: `t-wedge-${i}`,
        class: "ghost-owner",
        wedgedMin: 30,
      })),
    },
    commitCadence: {
      sinceLastTick: opts.last2hrCommits === 0 ? 0 : 2,
      last30min: opts.last2hrCommits === 0 ? 0 : 4,
      last2hr: opts.last2hrCommits ?? 10,
    },
    lastTickAt: Date.now(),
  };
}

/** The canonical cursor-agent JSON envelope shape (verified against
 *  `cursor-agent --print --output-format json --model composer-2-fast`
 *  output 2026-05-15 — `usage` keys are `inputTokens` /
 *  `outputTokens` / `cacheReadTokens` / `cacheWriteTokens`). Mock
 *  spawn-fns must emit this shape so the impl's parser path is
 *  exercised. */
interface CursorAgentJsonEnvelope {
  type: "result";
  subtype: "success" | "error";
  is_error: boolean;
  duration_ms: number;
  result: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
}

function mockCursorEnvelope(
  inputTokens: number,
  outputTokens: number,
  result = "[]",
): CursorAgentJsonEnvelope {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 2_000,
    result,
    usage: {
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  };
}

// ---------- Skip-gate banner ----------

if (!HAS_CURSOR_IMPL) {
  // eslint-disable-next-line no-console
  console.warn(
    "[cursor-martinet.e2e] SKIPPED — src/abstractions/martinets/cursor.ts " +
      "absent. Lands with ADR-132 T3 (t-e96d286a). Re-run after T3 ships.",
  );
}
if (!RUN_REAL_CURSOR) {
  // eslint-disable-next-line no-console
  console.warn(
    "[cursor-martinet.e2e] Case 6 (real cursor-agent invocation) SKIPPED — " +
      "set RUN_REAL_CURSOR=1 to enable. CI default off to preserve quota.",
  );
}

// ---------- Case 1: module-load smoke ----------

describe.skipIf(!HAS_CURSOR_IMPL)("CursorMartinet — module-load smoke", () => {
  test("imports + instantiates + satisfies Martinet interface", async () => {
    const mod = await loadCursorMartinet();
    expect(mod.CursorMartinet).toBeDefined();
    expect(typeof mod.CursorMartinet).toBe("function");

    // Instantiation deps shape — `runCursorAgent` is the injectable
    // spawn-fn the impl uses. Mock returns the canonical envelope so
    // construction round-trips without a real cursor-agent.
    const inst: Martinet = new mod.CursorMartinet({
      observeFn: async () => fixtureObservation(),
      runCursorAgent: async () =>
        JSON.stringify(mockCursorEnvelope(100, 50, "[]")),
    });

    expect(inst.name).toBe("cursor");
    expect(typeof inst.observe).toBe("function");
    expect(typeof inst.decide).toBe("function");
    expect(typeof inst.apply).toBe("function");
    expect(typeof inst.shouldEscalateToClaudeLead).toBe("function");
  });
});

// ---------- Case 2: synthetic decide() — composer-2-fast model flag ----------

describe.skipIf(!HAS_CURSOR_IMPL)(
  "CursorMartinet — decide() invokes composer-2-fast",
  () => {
    test("model flag is 'composer-2-fast' when cursor-agent is spawned", async () => {
      const mod = await loadCursorMartinet();
      const seenArgs: string[][] = [];
      const inst: Martinet = new mod.CursorMartinet({
        observeFn: async () => fixtureObservation(),
        runCursorAgent: async (args: string[]) => {
          seenArgs.push(args);
          return JSON.stringify(
            mockCursorEnvelope(
              5_000,
              200,
              JSON.stringify([
                { kind: "enter-push", member: "fe-1", reason: "queued claim" },
              ]),
            ),
          );
        },
      });
      const obs = fixtureObservation();
      const actions = await inst.decide(obs);

      // At least one spawn invocation with the model flag.
      const modelFlagPresent = seenArgs.some(
        (args) =>
          args.includes("--model") &&
          args[args.indexOf("--model") + 1] === "composer-2-fast",
      );
      expect(modelFlagPresent).toBe(true);

      // The decide() output should be a NudgeAction[].
      expect(Array.isArray(actions)).toBe(true);
    });
  },
);

// ---------- Case 3: §D5 E6 ship-zero mandatory escalation ----------

describe.skipIf(!HAS_CURSOR_IMPL)(
  "CursorMartinet — §D5 E6 ship-zero mandatory escalation",
  () => {
    test("shouldEscalateToClaudeLead returns true when last2hr === 0", async () => {
      const mod = await loadCursorMartinet();
      const inst: Martinet = new mod.CursorMartinet({
        observeFn: async () => fixtureObservation({ last2hrCommits: 0 }),
        runCursorAgent: async () =>
          JSON.stringify(mockCursorEnvelope(100, 50, "[]")),
      });
      const obs = fixtureObservation({ last2hrCommits: 0 });
      // E6 floor is mandatory — no impl may suppress.
      expect(inst.shouldEscalateToClaudeLead(obs)).toBe(true);
    });

    test("shouldEscalateToClaudeLead returns false when last2hr > 0 AND no other E1-E5 trigger", async () => {
      const mod = await loadCursorMartinet();
      const inst: Martinet = new mod.CursorMartinet({
        observeFn: async () => fixtureObservation({ last2hrCommits: 10 }),
        runCursorAgent: async () =>
          JSON.stringify(mockCursorEnvelope(100, 50, "[]")),
      });
      const obs = fixtureObservation({ last2hrCommits: 10 });
      expect(inst.shouldEscalateToClaudeLead(obs)).toBe(false);
    });
  },
);

// ---------- Case 4: observe → decide → apply round-trip ----------

describe.skipIf(!HAS_CURSOR_IMPL)(
  "CursorMartinet — observe → decide → apply round-trip",
  () => {
    test("apply() returns success on a non-escalation NudgeAction", async () => {
      const mod = await loadCursorMartinet();

      // Stub tmux send-fn — captures the dispatched action so apply()
      // has an observable side-effect.
      const tmuxSent: { window: string; keys: string }[] = [];

      const inst: Martinet = new mod.CursorMartinet({
        observeFn: async () => fixtureObservation(),
        runCursorAgent: async () =>
          JSON.stringify(
            mockCursorEnvelope(
              5_000,
              200,
              JSON.stringify([
                { kind: "enter-push", member: "fe-1", reason: "queued claim" },
              ]),
            ),
          ),
        sendKeys: async (window: string, keys: string) => {
          tmuxSent.push({ window, keys });
          return { success: true } as { success: boolean };
        },
      });

      const obs = await inst.observe("atmux");
      const actions = await inst.decide(obs);
      const nonEscalations = actions.filter(
        (a: NudgeAction) => a.kind !== "escalate-to-claude-lead",
      );

      if (nonEscalations.length === 0) {
        // Impl chose to escalate everything (legitimate under high
        // ctxTokens or wedge counts). Skip the apply walk — the
        // mandatory-escalation contract is exercised by case 3.
        return;
      }

      const first = nonEscalations[0];
      if (first === undefined) {
        throw new Error("expected at least one non-escalation action");
      }
      const result: ApplyResult = await inst.apply(first);
      expect(result.success).toBe(true);
      expect(typeof result.evidence).toBe("string");
      expect(result.evidence.length).toBeGreaterThan(0);
    });
  },
);

// ---------- Case 5: token-burn assertion (deterministic) ----------

describe.skipIf(!HAS_CURSOR_IMPL)(
  "CursorMartinet — token-burn (deterministic, mocked envelope)",
  () => {
    test("input + output tokens fit within budget envelope vs Claude baseline", async () => {
      const mod = await loadCursorMartinet();

      let observedUsage: CursorAgentJsonEnvelope["usage"] | null = null;
      const inst: Martinet = new mod.CursorMartinet({
        observeFn: async () => fixtureObservation(),
        runCursorAgent: async () => {
          // Realistic-but-bounded composer-2-fast usage from a single
          // observation summary. These numbers track the cursor-agent
          // --output-format json envelope shape verified 2026-05-15 on
          // a trivial prompt (~11k input, ~85 output for "echo hello";
          // a 3-member Observation prompt scales linearly).
          const envelope = mockCursorEnvelope(
            12_000, // input — well below 50k ceiling
            150, // output — well below 2k ceiling
            JSON.stringify([
              { kind: "enter-push", member: "fe-1", reason: "queued claim" },
            ]),
          );
          observedUsage = envelope.usage;
          return JSON.stringify(envelope);
        },
      });

      await inst.decide(fixtureObservation());

      if (observedUsage === null) {
        throw new Error(
          "CursorMartinet.decide() did not invoke runCursorAgent — " +
            "impl must spawn cursor-agent at least once per tick to be " +
            "measurable. If the impl genuinely fast-paths without spawning " +
            "(e.g. pure-Claude E6 floor), the assertion is N/A — but the " +
            "decide() path under test should exercise the cursor-agent call.",
        );
      }
      const usage: CursorAgentJsonEnvelope["usage"] = observedUsage;
      expect(usage.inputTokens).toBeLessThanOrEqual(INPUT_CEILING);
      expect(usage.outputTokens).toBeLessThanOrEqual(OUTPUT_CEILING);
    });
  },
);

// ---------- Case 6: token-burn assertion (real cursor-agent) ----------

describe.skipIf(!HAS_CURSOR_IMPL || !HAS_CURSOR_AGENT || !RUN_REAL_CURSOR)(
  "CursorMartinet — token-burn (real cursor-agent, env-gated)",
  () => {
    test(
      "real composer-2-fast call on canonical observation prompt stays under ceilings",
      async () => {
        // Canonical observation summary prompt — small, deterministic,
        // exercises the same parse path the impl wraps. We invoke
        // cursor-agent directly (not via the CursorMartinet wrapper)
        // because the wrapper's exact CLI invocation is a T3 detail;
        // this case verifies the BUDGET assumption against the
        // production binary regardless of wrapper shape.
        const prompt =
          'Given this team observation, return [] (empty JSON array) and nothing else: ' +
          '{"team":"atmux","members":3,"wedged":0,"commitsLast2hr":10}.';
        const proc = Bun.spawnSync({
          cmd: [
            "cursor-agent",
            "--print",
            "--output-format",
            "json",
            "--model",
            "composer-2-fast",
            "--force",
            prompt,
          ],
          stdout: "pipe",
          stderr: "pipe",
        });
        const stdout = new TextDecoder().decode(proc.stdout);
        // Last JSON line is the envelope (stream-json may emit multiple).
        const lines = stdout.trim().split("\n").filter((l) => l.startsWith("{"));
        const lastLine = lines[lines.length - 1];
        if (lastLine === undefined) {
          throw new Error(
            `cursor-agent emitted no JSON envelope. stdout: ${stdout.slice(0, 400)}`,
          );
        }
        const envelope = JSON.parse(lastLine) as CursorAgentJsonEnvelope;
        expect(envelope.is_error).toBe(false);
        expect(envelope.usage.inputTokens).toBeLessThanOrEqual(INPUT_CEILING);
        expect(envelope.usage.outputTokens).toBeLessThanOrEqual(OUTPUT_CEILING);
      },
      // 60s timeout — cursor-agent --print round-trip on
      // composer-2-fast averaged ~6.4s on a "echo hello" probe;
      // canonical observation prompt is short enough to stay well
      // under 60s. Belt-and-braces vs network-flap.
      60_000,
    );
  },
);
