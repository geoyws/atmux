// The orchestrator, driven entirely through fakes. The test that matters
// most is the ordering one: the isolation gate must refuse BEFORE a server
// is started, a provider dialed, or a word spoken.

import { describe, expect, test } from "bun:test";
import type { TmuxNamespace } from "../../../../../src/abstractions/tmux.ts";
import type { DriveResult } from "../../../../../src/core/voice/e2e/drive.ts";
import { COCKPIT_ENV } from "../../../../../src/core/voice/e2e/isolation.ts";
import type { JudgeOutcome } from "../../../../../src/core/voice/e2e/judge.ts";
import {
  assertKillableSocket,
  computeStaleWaitMs,
  criteriaFor,
  decideScenario,
  extractTeamNames,
  formatHarnessResult,
  HARNESS_TOKEN_MIN,
  type HarnessDeps,
  type HarnessIo,
  runHarness,
} from "../../../../../src/core/voice/e2e/run.ts";
import { SCENARIOS, type Scenario } from "../../../../../src/core/voice/e2e/scenarios.ts";
import { ConfigError } from "../../../../../src/errors.ts";

const TOKEN = "a".repeat(HARNESS_TOKEN_MIN);

function okDrive(over: Partial<DriveResult> = {}): DriveResult {
  return {
    ok: true,
    ready: {},
    transcript: "be-1 is blocked and fe-1 is wedged.",
    tools: [],
    toolNames: ["fleet_attention"],
    frameTypes: ["ready"],
    uplinkFrames: 3,
    downlinkFrames: 1,
    downlinkBytes: 100,
    errors: [],
    closeCode: 1000,
    failure: null,
    ...over,
  };
}

function okJudge(over: Partial<JudgeOutcome> = {}): JudgeOutcome {
  return {
    verdict: { criteria: [], hallucinations: [], overall_pass: true, summary: "ok" },
    pass: true,
    aggregateDisagreement: null,
    missingCriteria: [],
    model: "claude-opus-5",
    ...over,
  };
}

interface Harness {
  deps: HarnessDeps;
  env: NodeJS.ProcessEnv;
  events: string[];
  files: Map<string, string>;
}

function harness(over: Partial<HarnessDeps> = {}, ioOver: Partial<HarnessIo> = {}): Harness {
  const events: string[] = [];
  const files = new Map<string, string>();
  const env: NodeJS.ProcessEnv = { HOME: "/root" };
  const io: HarnessIo = {
    mkdtemp: async (p) => `/tmp/${p}xyz`,
    mkdir: async () => {},
    writeFile: async (path, c) => {
      files.set(path, c);
    },
    writeBytes: async () => {},
    readFile: async (path) => files.get(path) ?? null,
    readBytes: async () => null,
    rm: async () => {
      events.push("rm");
    },
    tmux: () =>
      ({
        session: {
          newSession: async () => {
            events.push("newSession");
          },
          hasSession: async () => true,
          killSession: async () => {
            events.push("killSession");
          },
        },
        window: {
          newWindow: async () => {
            events.push("newWindow");
            return { sessionName: "s", windowIndex: 1 };
          },
        },
      }) as unknown as TmuxNamespace,
    ...ioOver,
  };
  const deps: HarnessDeps = {
    io,
    env,
    uid: 1000,
    openaiKey: "sk-o",
    anthropicKey: "sk-a",
    token: TOKEN,
    scenarios: [SCENARIOS[0] as Scenario],
    now: () => 0,
    sleep: async () => {},
    startServer: async () => {
      events.push("startServer");
      return {
        url: "ws://127.0.0.1:1/ws",
        stop: () => {
          events.push("stopServer");
        },
      };
    },
    tts: async () => {
      events.push("tts");
      return { pcm: new Uint8Array(4), durationMs: 1, cached: true, path: "/c/x.pcm" };
    },
    drive: async () => {
      events.push("drive");
      return okDrive();
    },
    judge: async () => {
      events.push("judge");
      return okJudge();
    },
    ...over,
  };
  return { deps, env, events, files };
}

describe("runHarness — ordering is the safety property", () => {
  test("the isolation gate refuses BEFORE the server starts or anything is spoken to", async () => {
    // A cockpit that names a real team. The gate must fire before
    // `startServer`, `tts`, `drive`, or `judge` ever run.
    const h = harness();
    const original = h.deps.io.writeFile;
    h.deps.io.writeFile = async (path, contents) => {
      const poisoned = path.endsWith("cockpit.json")
        ? JSON.stringify({ sessions: [{ type: "team", name: "px", root: "/root/work" }] })
        : contents;
      await original(path, poisoned);
    };
    await expect(runHarness(h.deps)).rejects.toBeInstanceOf(ConfigError);
    expect(h.events).not.toContain("startServer");
    expect(h.events).not.toContain("tts");
    expect(h.events).not.toContain("drive");
    expect(h.events).not.toContain("judge");
  });

  test("the cage is torn down even when the gate refuses", async () => {
    const h = harness();
    const original = h.deps.io.writeFile;
    h.deps.io.writeFile = async (path, contents) => {
      await original(path, path.endsWith("cockpit.json") ? "{}" : contents);
    };
    await expect(runHarness(h.deps)).rejects.toBeInstanceOf(ConfigError);
    expect(h.events).toContain("killSession");
    expect(h.events).toContain("rm");
  });

  test("HOME and the cockpit override are pinned into the temp dir", async () => {
    const h = harness();
    const seen: { home: string | undefined; cockpit: string | undefined } = {
      home: undefined,
      cockpit: undefined,
    };
    h.deps.startServer = async () => {
      seen.home = h.env.HOME;
      seen.cockpit = h.env[COCKPIT_ENV];
      return { url: "ws://127.0.0.1:1/ws", stop: () => {} };
    };
    await runHarness(h.deps);
    expect(seen.home).toContain("atmux-voice-e2e-");
    expect(seen.cockpit).toContain("atmux-voice-e2e-");
    expect(seen.cockpit).toEndWith("cockpit.json");
  });

  test("the real HOME is restored afterwards", async () => {
    const h = harness();
    await runHarness(h.deps);
    expect(h.env.HOME).toBe("/root");
  });

  test("a happy run passes and stops the server", async () => {
    const h = harness();
    const r = await runHarness(h.deps);
    expect(r.pass).toBe(true);
    expect(r.scenarios.length).toBe(1);
    expect(h.events).toContain("stopServer");
    expect(h.events).toContain("killSession");
    expect(h.events).toContain("rm");
  });

  test("the server is stopped even when a scenario throws", async () => {
    const h = harness({
      drive: async () => {
        throw new Error("provider exploded");
      },
    });
    await expect(runHarness(h.deps)).rejects.toThrow("provider exploded");
    expect(h.events).toContain("stopServer");
    expect(h.events).toContain("killSession");
  });

  test("--keep-temp leaves the temp dir behind", async () => {
    const h = harness({ keepTemp: true });
    await runHarness(h.deps);
    expect(h.events).not.toContain("rm");
  });

  test("the judge is skipped when the session itself failed", async () => {
    const h = harness({ drive: async () => okDrive({ ok: false, failure: "no transcript" }) });
    const r = await runHarness(h.deps);
    expect(h.events).not.toContain("judge");
    expect(r.pass).toBe(false);
    expect(r.scenarios[0]?.failure).toContain("no transcript");
  });

  test("refuses a token shorter than the config gate accepts", async () => {
    const h = harness({ token: "short" });
    await expect(runHarness(h.deps)).rejects.toThrow("at least 32 chars");
  });

  test("tolerates an absent HOME when reading the operator's cockpit", async () => {
    const h = harness();
    h.deps.env = {};
    const r = await runHarness(h.deps);
    expect(r.isolation.realTeamsChecked).toBe(0);
  });

  test("waits for the residue fixture to age before asking", async () => {
    const waits: number[] = [];
    let t = 0;
    const h = harness({
      now: () => t,
      sleep: async (ms) => {
        waits.push(ms);
        t += ms;
      },
    });
    await runHarness(h.deps);
    // 70s required, nothing elapsed ⇒ the full top-up.
    expect(waits).toContain(70_000);
  });

  test("skips the wait when enough time has already passed", async () => {
    const waits: number[] = [];
    let t = 0;
    const h = harness({
      now: () => {
        t += 200_000;
        return t;
      },
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    await runHarness(h.deps);
    expect(waits).toEqual([]);
  });

  test("logs through the injected sink", async () => {
    const lines: string[] = [];
    const h = harness({ log: (l) => lines.push(l) });
    await runHarness(h.deps);
    const text = lines.join("\n");
    expect(text).toContain("isolation: PASS");
    expect(text).toContain("server: ws://127.0.0.1:1/ws");
    expect(text).toContain("--- scenario attention");
  });

  test("runs without a log sink or explicit clock", async () => {
    const h = harness();
    const { log: _l, now: _n, sleep: _s, ...rest } = h.deps;
    // `sleep` omitted would wait 70s of real time, so keep a fast one.
    const r = await runHarness({ ...rest, sleep: async () => {} });
    expect(r.pass).toBe(true);
  });
});

describe("the TTS cache location", () => {
  test("defaults inside the temp root", async () => {
    const seen: string[] = [];
    const h = harness({
      tts: async (_req, d) => {
        seen.push(d.cacheDir);
        return { pcm: new Uint8Array(4), durationMs: 1, cached: true, path: "p" };
      },
    });
    await runHarness(h.deps);
    expect(seen[0]).toContain("atmux-voice-e2e-");
    expect(seen[0]).toEndWith("tts-cache");
  });

  test("honours an override OUTSIDE the temp root, so re-runs do not re-bill", async () => {
    // A cache inside the temp root is deleted with it, so every run would
    // re-synthesize — the opposite of what the cache is for.
    const seen: string[] = [];
    const h = harness({
      ttsCacheDir: "/var/cache/voice-e2e",
      tts: async (_req, d) => {
        seen.push(d.cacheDir);
        return { pcm: new Uint8Array(4), durationMs: 1, cached: true, path: "p" };
      },
    });
    await runHarness(h.deps);
    expect(seen[0]).toBe("/var/cache/voice-e2e");
  });
});

describe("assertKillableSocket — the teardown guard", () => {
  test("allows a socket under the temp root", () => {
    expect(() => assertKillableSocket("/tmp/x", "/tmp/x/sock/a/tmux-0/default")).not.toThrow();
  });

  test("REFUSES a socket outside it — including the default tmux socket", () => {
    // Leaving a stray session on a stray socket is untidy; killing one on
    // the operator's default socket would end live agent sessions.
    expect(() => assertKillableSocket("/tmp/x", "/tmp/tmux-0/default")).toThrow("refusing to kill");
  });

  test("REFUSES a cage socket belonging to a real team", () => {
    expect(() => assertKillableSocket("/tmp/x", "/tmp/atmux-px/sock")).toThrow("outside /tmp/x");
  });
});

describe("the default sleeper", () => {
  test("is used when no sleep seam is injected", async () => {
    // Drives the real `setTimeout` path with a 1ms top-up rather than the
    // full 70s: `now` reports 69.999s elapsed since the panes were painted.
    let call = 0;
    const h = harness({
      now: () => (call++ === 0 ? 0 : 69_999),
    });
    const { sleep: _omit, ...noSleep } = h.deps;
    const r = await runHarness(noSleep);
    expect(r.pass).toBe(true);
  });
});

describe("computeStaleWaitMs", () => {
  test("asks for the full window when nothing has elapsed", () => {
    expect(computeStaleWaitMs(0, 0, 70)).toBe(70_000);
  });

  test("credits time already spent synthesizing and booting", () => {
    expect(computeStaleWaitMs(0, 30_000, 70)).toBe(40_000);
  });

  test("never returns a negative wait", () => {
    expect(computeStaleWaitMs(0, 999_000, 70)).toBe(0);
  });
});

describe("extractTeamNames", () => {
  test("walks the recursive sessions tree", () => {
    const raw = JSON.stringify({
      sessions: [
        { type: "team", name: "a" },
        { type: "superdriver", name: "b", sessions: [{ type: "team", name: "c" }] },
      ],
    });
    expect(extractTeamNames(raw)).toEqual(["a", "b", "c"]);
  });

  test("reads the legacy flat teams array too", () => {
    expect(extractTeamNames(JSON.stringify({ teams: [{ name: "legacy" }] }))).toEqual(["legacy"]);
  });

  test("returns nothing for a missing file", () => {
    expect(extractTeamNames(null)).toEqual([]);
  });

  test("returns nothing for unparseable JSON rather than throwing", () => {
    // A broken operator cockpit must not stop the harness — the structural
    // checks are what guarantee isolation, this only sharpens the evidence.
    expect(extractTeamNames("{{{")).toEqual([]);
  });

  test("skips non-object and unnamed entries", () => {
    const raw = JSON.stringify({ sessions: [null, 7, { root: "/x" }, { name: "ok" }] });
    expect(extractTeamNames(raw)).toEqual(["ok"]);
  });
});

describe("criteriaFor", () => {
  test("prepends the base criteria to the scenario's own", () => {
    const c = criteriaFor(SCENARIOS[0] as Scenario);
    expect(c[0]?.id).toBe("answered_the_question");
    expect(c[1]?.id).toBe("no_hallucination");
    expect(c.map((x) => x.id)).toContain("named_blocked_pane");
  });
});

describe("decideScenario", () => {
  const scenario = SCENARIOS[0] as Scenario;
  const gate = {
    ok: true,
    expected: ["fleet_attention"],
    invoked: ["fleet_attention"],
    reason: null,
  };

  test("passes when both gates hold", () => {
    expect(decideScenario(scenario, okDrive(), gate, okJudge()).pass).toBe(true);
  });

  test("a failed session fails first, before the tool gate is blamed", () => {
    const o = decideScenario(scenario, okDrive({ ok: false, failure: "closed 4401" }), gate, null);
    expect(o.failure).toContain("session failed: closed 4401");
  });

  test("reports an unknown session failure without a message", () => {
    const o = decideScenario(scenario, okDrive({ ok: false, failure: null }), gate, null);
    expect(o.failure).toContain("unknown");
  });

  test("a failed tool gate fails the scenario", () => {
    const o = decideScenario(
      scenario,
      okDrive(),
      { ok: false, expected: ["fleet_attention"], invoked: [], reason: "no tool" },
      okJudge(),
    );
    expect(o.failure).toContain("tool gate: no tool");
  });

  test("reports a tool-gate failure with no reason", () => {
    const o = decideScenario(
      scenario,
      okDrive(),
      { ok: false, expected: [], invoked: [], reason: null },
      okJudge(),
    );
    expect(o.failure).toContain("unknown");
  });

  test("a missing judge verdict fails the scenario", () => {
    expect(decideScenario(scenario, okDrive(), gate, null).failure).toContain("did not return");
  });

  test("names the failed criteria, hallucinations, and missing criteria", () => {
    const judge = okJudge({
      pass: false,
      verdict: {
        criteria: [{ id: "named_blocked_pane", pass: false, reasoning: "omitted" }],
        hallucinations: ["team zeta"],
        overall_pass: false,
        summary: "",
      },
      missingCriteria: ["no_hallucination"],
    });
    const o = decideScenario(scenario, okDrive(), gate, judge);
    expect(o.failure).toContain("failed criteria: named_blocked_pane");
    expect(o.failure).toContain("hallucinations: team zeta");
    expect(o.failure).toContain("missing criteria: no_hallucination");
  });

  test("a judge failure with no failed criteria still reports the hallucination", () => {
    const judge = okJudge({
      pass: false,
      verdict: { criteria: [], hallucinations: ["ghost"], overall_pass: false, summary: "" },
    });
    expect(decideScenario(scenario, okDrive(), gate, judge).failure).toContain(
      "hallucinations: ghost",
    );
  });
});

describe("formatHarnessResult", () => {
  test("prints a per-scenario line and the overall verdict", () => {
    const text = formatHarnessResult({
      isolation: {
        cockpitPath: "",
        tempRoot: "",
        teams: [],
        home: "",
        defaultTmuxSocket: "",
        realTeamsChecked: 0,
      },
      scenarios: [
        {
          scenario: SCENARIOS[0] as Scenario,
          drive: okDrive(),
          toolGate: { ok: true, expected: [], invoked: [], reason: null },
          judge: okJudge(),
          pass: true,
          failure: null,
        },
        {
          scenario: SCENARIOS[1] as Scenario,
          drive: okDrive(),
          toolGate: { ok: true, expected: [], invoked: [], reason: null },
          judge: okJudge(),
          pass: false,
          failure: "judge: nope",
        },
      ],
      pass: false,
    }).join("\n");
    expect(text).toContain("voice-e2e: FAIL");
    expect(text).toContain("PASS  attention");
    expect(text).toContain("FAIL  all_ok");
    expect(text).toContain("judge: nope");
  });
});
