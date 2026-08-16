// Unit tests for src/core/voice/tool-bridge.ts — ADR-272 enforcement
// pipeline (D2 verb-only, D3 caution, D6 surface, D7 confirmation).
//
// Pins:
//   - executeTool NEVER throws — every failure (including an internal
//     bug in an injected dep) renders as a typed envelope.
//   - EVERY error code is driven: bad_args, unknown_team,
//     ambiguous_team, no_default_team, readonly_mode,
//     needs_confirmation, confirm_expired, tool_timeout, verb_failed,
//     verb_output_unparseable.
//   - Confirm lifecycle: issue → redeem-ok → replay (fresh token) →
//     expired, via fake clock; the binding hashes the args WITH
//     confirm_token stripped, so same-args-±-token redeems and
//     changed-args re-issues.
//   - Mutex: two executeTool calls never interleave their captures; the
//     timeout bounds the RESPONSE, not the execution — the next tool
//     queues behind the still-running one.
//   - Lane recovery (ADR-272 §Supplement-P7 §R2): the queue is bounded,
//     every tool_timeout NAMES the stuck verb, and a wedge DRAINS when
//     its holder returns instead of executing a backlog of expired
//     calls.
//   - The WHOLE envelope stays ≤ maxResultChars, JSON always valid.

import { describe, expect, test } from "bun:test";
import { createVerbMutex, VERB_MUTEX_MAX_QUEUE } from "../../../../src/core/verb-capture.ts";
import { createConfirmStore } from "../../../../src/core/voice/confirm.ts";
import type { VoiceTeamIndex } from "../../../../src/core/voice/team-context.ts";
import {
  buildConfirmPreview,
  createToolBridge,
  type ToolBridgeDeps,
  WEDGE_THRESHOLD_MULTIPLE,
} from "../../../../src/core/voice/tool-bridge.ts";
import { VOICE_TOOL_CATALOG } from "../../../../src/core/voice/tool-catalog.ts";

const INDEX: VoiceTeamIndex = {
  teams: [
    { name: "atmux", root: "/w/atmux", type: "team" },
    { name: "alpha-one", root: "/w/a1", type: "team" },
    { name: "alpha-two", root: "/w/a2", type: "team" },
  ],
};

interface Harness {
  bridge: ReturnType<typeof createToolBridge>;
  deps: ToolBridgeDeps;
  setNow: (ms: number) => void;
  calls: Array<{ key: string; argv: ReadonlyArray<string> }>;
}

/** Build a bridge with recording runners + fake clock. Overrides merge
 *  into the default deps. */
function makeHarness(overrides: Partial<ToolBridgeDeps> = {}): Harness {
  let now = 1_000;
  const calls: Array<{ key: string; argv: ReadonlyArray<string> }> = [];
  const mkRunner =
    (key: string, out = `${key}-output\n`, exit = 0) =>
    async (argv: ReadonlyArray<string>) => {
      calls.push({ key, argv });
      process.stdout.write(out);
      return exit;
    };
  const deps: ToolBridgeDeps = {
    catalog: VOICE_TOOL_CATALOG,
    runners: {
      topo: mkRunner("topo"),
      status: mkRunner("status"),
      health: mkRunner("health"),
      task: mkRunner("task"),
      paneState: mkRunner("paneState"),
      driverInbox: mkRunner("driverInbox"),
      outbox: mkRunner("outbox"),
      cost: mkRunner("cost"),
      blockers: mkRunner("blockers"),
      tellLead: mkRunner("tellLead"),
      dispatch: mkRunner("dispatch"),
      claim: mkRunner("claim"),
      nudge: mkRunner("nudge"),
    },
    teamIndex: INDEX,
    confirmStore: createConfirmStore({ clock: () => now, ttlMs: 120_000 }),
    // Same fake clock the bridge uses, so `health()`'s held-duration is
    // driveable from `setNow` (a real clock here would make it untestable).
    mutex: createVerbMutex({ clock: () => now }),
    config: { readonly: false, toolTimeoutMs: 20_000, maxResultChars: 2000 },
    clock: () => now,
    // Default: the timeout never fires (tests that need it inject one).
    sleep: () => new Promise<never>(() => {}),
    ...overrides,
  };
  return { bridge: createToolBridge(deps), deps, setNow: (ms) => (now = ms), calls };
}

function parseEnvelope(json: string): Record<string, unknown> {
  return JSON.parse(json) as Record<string, unknown>;
}

const SESSION = { sessionId: "sess-1", currentTeam: null as string | null };

describe("bad_args", () => {
  test("unknown tool", async () => {
    const { bridge } = makeHarness();
    const out = await bridge.executeTool({ ...SESSION, name: "rm_rf", argsJson: "{}" });
    expect(parseEnvelope(out.envelopeJson)).toMatchObject({
      ok: false,
      tool: "rm_rf",
      error: "bad_args",
    });
  });

  test("malformed argsJson", async () => {
    const { bridge } = makeHarness();
    const out = await bridge.executeTool({ ...SESSION, name: "list_teams", argsJson: "{nope" });
    expect(parseEnvelope(out.envelopeJson)).toMatchObject({ ok: false, error: "bad_args" });
  });

  test.each([
    ["[1,2]"],
    ['"str"'],
    ["null"],
    ["42"],
  ])("non-object argsJson %s", async (argsJson) => {
    const { bridge } = makeHarness();
    const out = await bridge.executeTool({ ...SESSION, name: "list_teams", argsJson });
    expect(parseEnvelope(out.envelopeJson)).toMatchObject({ ok: false, error: "bad_args" });
  });

  test("Zod reject carries a short issue summary naming the field", async () => {
    const { bridge } = makeHarness();
    const out = await bridge.executeTool({
      ...SESSION,
      name: "member_pane",
      currentTeam: "atmux",
      argsJson: "{}",
    });
    const env = parseEnvelope(out.envelopeJson);
    expect(env).toMatchObject({ ok: false, tool: "member_pane", error: "bad_args" });
    expect(String(env.message)).toContain("member");
  });

  test("empty argsJson reads as {} (provider dialects send it)", async () => {
    const { bridge } = makeHarness();
    const out = await bridge.executeTool({ ...SESSION, name: "list_teams", argsJson: "" });
    expect(parseEnvelope(out.envelopeJson)).toMatchObject({ ok: true, tool: "list_teams" });
  });
});

describe("team resolution", () => {
  test("no_default_team: team-scoped tool, no team arg, currentTeam null", async () => {
    const { bridge, calls } = makeHarness();
    const out = await bridge.executeTool({ ...SESSION, name: "team_status", argsJson: "{}" });
    expect(parseEnvelope(out.envelopeJson)).toMatchObject({
      ok: false,
      tool: "team_status",
      error: "no_default_team",
    });
    expect(calls).toEqual([]);
  });

  test("unknown_team echoes the spoken name", async () => {
    const { bridge } = makeHarness();
    const out = await bridge.executeTool({
      ...SESSION,
      name: "team_status",
      argsJson: '{"team":"zzzzzzzz"}',
    });
    expect(parseEnvelope(out.envelopeJson)).toMatchObject({
      ok: false,
      error: "unknown_team",
      team: "zzzzzzzz",
    });
  });

  test("ambiguous_team carries the candidates", async () => {
    const { bridge } = makeHarness();
    const out = await bridge.executeTool({
      ...SESSION,
      name: "team_status",
      argsJson: '{"team":"alpha"}',
    });
    expect(parseEnvelope(out.envelopeJson)).toMatchObject({
      ok: false,
      error: "ambiguous_team",
      team: "alpha",
      candidates: ["alpha-one", "alpha-two"],
    });
  });

  test("currentTeam is the default; explicit team arg wins over it", async () => {
    const { bridge, calls } = makeHarness();
    const a = await bridge.executeTool({
      name: "team_status",
      argsJson: "{}",
      sessionId: "s",
      currentTeam: "atmux",
    });
    expect(parseEnvelope(a.envelopeJson)).toMatchObject({ ok: true, team: "atmux" });
    expect(calls[0]).toEqual({ key: "status", argv: ["--team-dir", "/w/atmux"] });
    const b = await bridge.executeTool({
      name: "team_status",
      argsJson: '{"team":"alpha-one"}',
      sessionId: "s",
      currentTeam: "atmux",
    });
    expect(parseEnvelope(b.envelopeJson)).toMatchObject({ ok: true, team: "alpha-one" });
    expect(calls[1]).toEqual({ key: "status", argv: ["--team-dir", "/w/a1"] });
  });

  test("ASR-tolerant: spoken 'ATMUX' resolves to atmux", async () => {
    const { bridge } = makeHarness();
    const out = await bridge.executeTool({
      ...SESSION,
      name: "team_status",
      argsJson: '{"team":"ATMUX"}',
    });
    expect(parseEnvelope(out.envelopeJson)).toMatchObject({ ok: true, team: "atmux" });
  });
});

describe("list_teams (core-direct, no runner)", () => {
  test("served from the index — names + types, runner map may be empty", async () => {
    const { bridge } = makeHarness({ runners: {} });
    const out = await bridge.executeTool({ ...SESSION, name: "list_teams", argsJson: "{}" });
    const env = parseEnvelope(out.envelopeJson);
    expect(env).toMatchObject({ ok: true, tool: "list_teams", team: null, truncated: false });
    expect(env.data).toBe("atmux (team)\nalpha-one (team)\nalpha-two (team)");
  });

  test("empty index reads as (no teams)", async () => {
    const { bridge } = makeHarness({ runners: {}, teamIndex: { teams: [] } });
    const out = await bridge.executeTool({ ...SESSION, name: "list_teams", argsJson: "{}" });
    expect(parseEnvelope(out.envelopeJson)).toMatchObject({ ok: true, data: "(no teams)" });
  });
});

describe("readonly gate", () => {
  test("mutating tool in readonly → readonly_mode, runner untouched", async () => {
    const { bridge, calls } = makeHarness({
      config: { readonly: true, toolTimeoutMs: 20_000, maxResultChars: 2000 },
    });
    const out = await bridge.executeTool({
      ...SESSION,
      name: "tell_lead",
      currentTeam: "atmux",
      argsJson: '{"message":"hi"}',
    });
    expect(parseEnvelope(out.envelopeJson)).toMatchObject({
      ok: false,
      tool: "tell_lead",
      error: "readonly_mode",
    });
    expect(calls).toEqual([]);
  });

  test("read tools still work in readonly", async () => {
    const { bridge } = makeHarness({
      config: { readonly: true, toolTimeoutMs: 20_000, maxResultChars: 2000 },
    });
    const out = await bridge.executeTool({
      ...SESSION,
      name: "team_status",
      currentTeam: "atmux",
      argsJson: "{}",
    });
    expect(parseEnvelope(out.envelopeJson)).toMatchObject({ ok: true });
  });
});

describe("per-tool confirm preview (ADR-273 D4)", () => {
  const NUDGE = {
    name: "pane_nudge",
    argsJson: '{"member":"be-1","action":"submit"}',
    sessionId: "sess-1",
    currentTeam: "atmux",
  };

  test("pane_nudge uses its OWN preview, not the generic key/value rendering", async () => {
    const { bridge, calls } = makeHarness();
    const out = await bridge.executeTool(NUDGE);
    const env = parseEnvelope(out.envelopeJson);
    expect(env).toMatchObject({ ok: false, tool: "pane_nudge", error: "needs_confirmation" });
    const preview = String(env.preview);
    // Names the exact target AND the exact action — ADR-273 D4.
    expect(preview).toContain("be-1");
    expect(preview).toContain("atmux");
    expect(preview).toContain("press Enter");
    expect(preview).toContain("nothing is typed");
    // ...and is NOT what the generic builder would have produced.
    expect(preview).not.toBe(
      buildConfirmPreview("pane_nudge", { member: "be-1", action: "submit" }, "atmux"),
    );
    expect(calls).toEqual([]);
  });

  test("a different action yields a different preview, so the operator hears which one", async () => {
    const { bridge } = makeHarness();
    const submit = await bridge.executeTool(NUDGE);
    const cont = await bridge.executeTool({
      ...NUDGE,
      argsJson: '{"member":"be-1","action":"continue"}',
    });
    expect(submit.needsConfirmation?.preview).not.toBe(cont.needsConfirmation?.preview);
    expect(String(cont.needsConfirmation?.preview)).toContain('"continue"');
  });

  test("the token still binds the ARGS — a submit token cannot redeem a continue", async () => {
    const { bridge, calls } = makeHarness();
    const issued = await bridge.executeTool(NUDGE);
    const token = issued.needsConfirmation?.token ?? "";
    const swapped = await bridge.executeTool({
      ...NUDGE,
      argsJson: `{"member":"be-1","action":"continue","confirm_token":"${token}"}`,
    });
    expect(parseEnvelope(swapped.envelopeJson)).toMatchObject({ error: "needs_confirmation" });
    expect(calls).toEqual([]);
  });

  test("redeeming runs the nudge verb with the flag argv the catalog builds", async () => {
    const { bridge, calls } = makeHarness();
    const issued = await bridge.executeTool(NUDGE);
    const token = issued.needsConfirmation?.token ?? "";
    const out = await bridge.executeTool({
      ...NUDGE,
      argsJson: `{"member":"be-1","action":"submit","confirm_token":"${token}"}`,
    });
    expect(parseEnvelope(out.envelopeJson)).toMatchObject({ ok: true, tool: "pane_nudge" });
    expect(calls).toEqual([
      {
        key: "nudge",
        argv: ["--member", "be-1", "--action", "submit", "--team-dir", "/w/atmux"],
      },
    ]);
  });

  test("readonly hides it from the catalog the bridge is built with", async () => {
    const { bridge } = makeHarness({
      catalog: VOICE_TOOL_CATALOG.filter((e) => !e.mutating),
    });
    const out = await bridge.executeTool(NUDGE);
    expect(parseEnvelope(out.envelopeJson)).toMatchObject({
      ok: false,
      error: "bad_args",
      message: "unknown tool: pane_nudge",
    });
  });
});

describe("confirm lifecycle (ADR-272 D7)", () => {
  const DISPATCH = {
    name: "dispatch_task",
    argsJson: '{"task_id":"t-abc12345","member":"driver-2"}',
    sessionId: "sess-1",
    currentTeam: "atmux",
  };

  test("no token → needs_confirmation with token + preview; runner untouched", async () => {
    const { bridge, calls } = makeHarness();
    const out = await bridge.executeTool(DISPATCH);
    const env = parseEnvelope(out.envelopeJson);
    expect(env).toMatchObject({ ok: false, tool: "dispatch_task", error: "needs_confirmation" });
    expect(String(env.token)).toMatch(/^[0-9a-f]{32}$/);
    expect(String(env.preview)).toContain("dispatch task");
    expect(String(env.preview)).toContain("t-abc12345");
    expect(String(env.preview)).toContain("driver-2");
    expect(String(env.preview)).toContain("atmux");
    expect(out.needsConfirmation).toEqual({
      token: String(env.token),
      preview: String(env.preview),
    });
    expect(calls).toEqual([]);
  });

  test("issue → redeem-ok executes (same args ± confirm_token binding)", async () => {
    const { bridge, calls } = makeHarness();
    const issued = await bridge.executeTool(DISPATCH);
    const token = issued.needsConfirmation?.token ?? "";
    const out = await bridge.executeTool({
      ...DISPATCH,
      argsJson: `{"task_id":"t-abc12345","member":"driver-2","confirm_token":"${token}"}`,
    });
    expect(parseEnvelope(out.envelopeJson)).toMatchObject({ ok: true, tool: "dispatch_task" });
    // confirm_token stripped before argv: the verb sees only its args.
    expect(calls).toEqual([
      { key: "dispatch", argv: ["driver-2", "t-abc12345", "--team-dir", "/w/atmux"] },
    ]);
  });

  test("replay of a redeemed token → needs_confirmation with a FRESH token", async () => {
    const { bridge, calls } = makeHarness();
    const issued = await bridge.executeTool(DISPATCH);
    const token = issued.needsConfirmation?.token ?? "";
    const withToken = {
      ...DISPATCH,
      argsJson: `{"task_id":"t-abc12345","member":"driver-2","confirm_token":"${token}"}`,
    };
    await bridge.executeTool(withToken); // redeems + executes
    const replay = await bridge.executeTool(withToken);
    const env = parseEnvelope(replay.envelopeJson);
    expect(env).toMatchObject({ ok: false, error: "needs_confirmation" });
    expect(String(env.token)).not.toBe(token);
    expect(calls.length).toBe(1); // no second execution
  });

  test("changed args under a valid token → fresh needs_confirmation (mismatch burns)", async () => {
    const { bridge, calls } = makeHarness();
    const issued = await bridge.executeTool(DISPATCH);
    const token = issued.needsConfirmation?.token ?? "";
    const out = await bridge.executeTool({
      ...DISPATCH,
      argsJson: `{"task_id":"t-abc12345","member":"driver-3","confirm_token":"${token}"}`,
    });
    expect(parseEnvelope(out.envelopeJson)).toMatchObject({
      ok: false,
      error: "needs_confirmation",
    });
    expect(calls).toEqual([]);
  });

  test("expired token → confirm_expired (fake clock)", async () => {
    const h = makeHarness();
    const issued = await h.bridge.executeTool(DISPATCH);
    const token = issued.needsConfirmation?.token ?? "";
    h.setNow(1_000 + 120_000); // at TTL boundary → expired
    const out = await h.bridge.executeTool({
      ...DISPATCH,
      argsJson: `{"task_id":"t-abc12345","member":"driver-2","confirm_token":"${token}"}`,
    });
    expect(parseEnvelope(out.envelopeJson)).toMatchObject({
      ok: false,
      tool: "dispatch_task",
      error: "confirm_expired",
    });
    expect(h.calls).toEqual([]);
  });

  test("claim_task is confirm-gated too", async () => {
    const { bridge, calls } = makeHarness();
    const first = await bridge.executeTool({
      name: "claim_task",
      argsJson: '{"task_id":"t-9","member":"driver-4"}',
      sessionId: "s",
      currentTeam: "atmux",
    });
    expect(parseEnvelope(first.envelopeJson)).toMatchObject({ error: "needs_confirmation" });
    const token = first.needsConfirmation?.token ?? "";
    const second = await bridge.executeTool({
      name: "claim_task",
      argsJson: `{"task_id":"t-9","member":"driver-4","confirm_token":"${token}"}`,
      sessionId: "s",
      currentTeam: "atmux",
    });
    expect(parseEnvelope(second.envelopeJson)).toMatchObject({ ok: true });
    expect(calls).toEqual([
      { key: "claim", argv: ["t-9", "--as", "driver-4", "--team-dir", "/w/atmux"] },
    ]);
  });

  test("a token from another session cannot redeem (binding includes sessionId)", async () => {
    const { bridge } = makeHarness();
    const issued = await bridge.executeTool(DISPATCH);
    const token = issued.needsConfirmation?.token ?? "";
    const out = await bridge.executeTool({
      ...DISPATCH,
      sessionId: "sess-EVIL",
      argsJson: `{"task_id":"t-abc12345","member":"driver-2","confirm_token":"${token}"}`,
    });
    expect(parseEnvelope(out.envelopeJson)).toMatchObject({
      ok: false,
      error: "needs_confirmation",
    });
  });

  test("buildConfirmPreview: no team + no args degrade cleanly", () => {
    expect(buildConfirmPreview("claim_task", {}, null)).toBe(
      "Confirm claim task. Say yes to proceed.",
    );
  });
});

describe("execution + failure envelopes", () => {
  test("ok envelope shape: exactly ok/tool/team/ms/truncated/data; ms from clock delta", async () => {
    let now = 5_000;
    const h = makeHarness({
      clock: () => now,
      capture: async () => {
        now += 123;
        return { stdout: "fine\n", exitCode: 0 };
      },
    });
    const out = await h.bridge.executeTool({
      ...SESSION,
      name: "team_status",
      currentTeam: "atmux",
      argsJson: "{}",
    });
    const env = parseEnvelope(out.envelopeJson);
    expect(Object.keys(env).sort()).toEqual(["data", "ms", "ok", "team", "tool", "truncated"]);
    expect(env).toEqual({
      ok: true,
      tool: "team_status",
      team: "atmux",
      ms: 123,
      truncated: false,
      data: "fine",
    });
  });

  test("missing runner → verb_failed naming the key", async () => {
    const { bridge } = makeHarness({ runners: {} });
    const out = await bridge.executeTool({
      ...SESSION,
      name: "team_status",
      currentTeam: "atmux",
      argsJson: "{}",
    });
    const env = parseEnvelope(out.envelopeJson);
    expect(env).toMatchObject({ ok: false, error: "verb_failed" });
    expect(String(env.message)).toContain("status");
  });

  test("nonzero exit → verb_failed with exitCode + summarized output", async () => {
    const h = makeHarness();
    h.deps.runners.status = async () => {
      process.stdout.write("boom table\n");
      return 2;
    };
    const out = await h.bridge.executeTool({
      ...SESSION,
      name: "team_status",
      currentTeam: "atmux",
      argsJson: "{}",
    });
    expect(parseEnvelope(out.envelopeJson)).toMatchObject({
      ok: false,
      error: "verb_failed",
      exitCode: 2,
      data: "boom table",
    });
  });

  test("thrown verb → verb_failed with errorMessage, exitCode null", async () => {
    const h = makeHarness();
    h.deps.runners.status = async () => {
      throw new Error("no team.json found");
    };
    const out = await h.bridge.executeTool({
      ...SESSION,
      name: "team_status",
      currentTeam: "atmux",
      argsJson: "{}",
    });
    expect(parseEnvelope(out.envelopeJson)).toMatchObject({
      ok: false,
      error: "verb_failed",
      exitCode: null,
      message: "no team.json found",
    });
  });

  test("verb_output_unparseable: exit 0 with empty output", async () => {
    const h = makeHarness();
    h.deps.runners.status = async () => 0;
    const out = await h.bridge.executeTool({
      ...SESSION,
      name: "team_status",
      currentTeam: "atmux",
      argsJson: "{}",
    });
    expect(parseEnvelope(out.envelopeJson)).toMatchObject({
      ok: false,
      tool: "team_status",
      error: "verb_output_unparseable",
    });
  });

  test("internal dep bug still answers the turn (never throws)", async () => {
    const h = makeHarness({
      capture: async () => {
        throw new Error("kaboom in capture");
      },
    });
    const out = await h.bridge.executeTool({
      ...SESSION,
      name: "team_status",
      currentTeam: "atmux",
      argsJson: "{}",
    });
    const env = parseEnvelope(out.envelopeJson);
    expect(env).toMatchObject({ ok: false, error: "verb_failed" });
    expect(String(env.message)).toContain("kaboom in capture");
  });

  test("list_tasks caps output to header + limit rows before summarizing", async () => {
    const h = makeHarness();
    h.deps.runners.task = async () => {
      const rows = Array.from({ length: 20 }, (_, i) => `t-${i} todo row`);
      process.stdout.write(`ID STATUS SUBJECT\n${rows.join("\n")}\n`);
      return 0;
    };
    const out = await h.bridge.executeTool({
      ...SESSION,
      name: "list_tasks",
      currentTeam: "atmux",
      argsJson: '{"limit":3}',
    });
    const env = parseEnvelope(out.envelopeJson);
    expect(env).toMatchObject({ ok: true, truncated: true });
    const lines = String(env.data).split("\n");
    expect(lines[0]).toBe("ID STATUS SUBJECT");
    expect(lines.length).toBe(5); // header + 3 rows + marker
    expect(lines[4]).toBe("… (+17 more lines)");
  });
});

describe("timeout (response-bound, execution continues)", () => {
  test("tool_timeout envelope returns; the verb finishes later and the next tool queues behind it", async () => {
    const log: string[] = [];
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((r) => (releaseFirst = r));
    let sleepFired = false;
    const h = makeHarness({
      sleep: async () => {
        sleepFired = true; // fires immediately → instant timeout
      },
      capture: async (_verb, argv) => {
        log.push(`start:${argv.join(" ")}`);
        await firstDone;
        log.push(`end:${argv.join(" ")}`);
        return { stdout: "late\n", exitCode: 0 };
      },
    });
    const out = await h.bridge.executeTool({
      ...SESSION,
      name: "team_status",
      currentTeam: "atmux",
      argsJson: "{}",
    });
    expect(sleepFired).toBe(true);
    const env = parseEnvelope(out.envelopeJson);
    expect(env).toMatchObject({ ok: false, tool: "team_status", error: "tool_timeout" });
    expect(env.timeoutMs).toBe(20_000);
    expect(log).toEqual(["start:--team-dir /w/atmux"]);

    // Second tool queues BEHIND the still-running capture: give it a
    // non-firing sleep and a fast capture; it must not start until the
    // first releases its mutex slot.
    h.deps.sleep = () => new Promise<never>(() => {});
    const secondDone = h.bridge.executeTool({
      ...SESSION,
      name: "lead_outbox",
      currentTeam: "atmux",
      argsJson: "{}",
    });
    await Bun.sleep(10);
    expect(log).toEqual(["start:--team-dir /w/atmux"]); // second not started
    releaseFirst();
    const second = await secondDone;
    expect(parseEnvelope(second.envelopeJson)).toMatchObject({ ok: true, tool: "lead_outbox" });
    expect(log).toEqual([
      "start:--team-dir /w/atmux",
      "end:--team-dir /w/atmux",
      "start:--team-dir /w/atmux",
      "end:--team-dir /w/atmux",
    ]);
  });
});

describe("late rejection after timeout", () => {
  test("a capture that REJECTS after the timeout is swallowed (no unhandled rejection)", async () => {
    let rejectLate!: (e: Error) => void;
    const h = makeHarness({
      sleep: async () => {}, // instant timeout
      capture: () =>
        new Promise((_resolve, reject) => {
          rejectLate = reject;
        }),
    });
    const out = await h.bridge.executeTool({
      ...SESSION,
      name: "team_status",
      currentTeam: "atmux",
      argsJson: "{}",
    });
    expect(parseEnvelope(out.envelopeJson)).toMatchObject({ ok: false, error: "tool_timeout" });
    // The late rejection must be swallowed by the bridge's catch guard —
    // reaching the end of the test without an unhandled-rejection crash
    // is the assertion.
    rejectLate(new Error("late failure"));
    await Bun.sleep(5);
  });
});

describe("mutex serialization", () => {
  test("two executeTool calls interleave nothing", async () => {
    const log: string[] = [];
    const gate = { release: () => {} };
    const h = makeHarness({
      capture: async (_verb, argv) => {
        const tag = argv.includes("--text") ? "health" : "status";
        log.push(`${tag}-start`);
        if (tag === "status") await new Promise<void>((r) => (gate.release = r));
        log.push(`${tag}-end`);
        return { stdout: `${tag}\n`, exitCode: 0 };
      },
    });
    const p1 = h.bridge.executeTool({
      ...SESSION,
      name: "team_status",
      currentTeam: "atmux",
      argsJson: "{}",
    });
    const p2 = h.bridge.executeTool({
      ...SESSION,
      name: "team_health",
      currentTeam: "atmux",
      argsJson: "{}",
    });
    await Bun.sleep(0);
    expect(log).toEqual(["status-start"]);
    gate.release();
    await Promise.all([p1, p2]);
    expect(log).toEqual(["status-start", "status-end", "health-start", "health-end"]);
  });
});

describe("envelope budget", () => {
  test("whole envelope ≤ maxResultChars via structural re-truncation; JSON stays valid", async () => {
    const h = makeHarness({
      config: { readonly: false, toolTimeoutMs: 20_000, maxResultChars: 300 },
    });
    h.deps.runners.status = async () => {
      for (let i = 0; i < 200; i += 1) process.stdout.write(`row-${i}-abcdefghijklmnop\n`);
      return 0;
    };
    const out = await h.bridge.executeTool({
      ...SESSION,
      name: "team_status",
      currentTeam: "atmux",
      argsJson: "{}",
    });
    expect(out.envelopeJson.length).toBeLessThanOrEqual(300);
    const env = parseEnvelope(out.envelopeJson);
    expect(env).toMatchObject({ ok: true, truncated: true });
    const lines = String(env.data).split("\n");
    expect(lines[lines.length - 1]).toMatch(/^… \(\+\d+ more lines\)$/);
    for (const l of lines.slice(0, -1)) expect(l).toMatch(/^row-\d+-abcdefghijklmnop$/);
  });

  test("verb_failed envelope also respects the budget", async () => {
    const h = makeHarness({
      config: { readonly: false, toolTimeoutMs: 20_000, maxResultChars: 250 },
    });
    h.deps.runners.status = async () => {
      for (let i = 0; i < 100; i += 1) process.stdout.write(`err-${i}-xxxxxxxxxxxxxxxx\n`);
      return 1;
    };
    const out = await h.bridge.executeTool({
      ...SESSION,
      name: "team_status",
      currentTeam: "atmux",
      argsJson: "{}",
    });
    expect(out.envelopeJson.length).toBeLessThanOrEqual(250);
    expect(parseEnvelope(out.envelopeJson)).toMatchObject({ ok: false, error: "verb_failed" });
  });

  test("tiny budget degrades to marker-only data, still valid JSON", async () => {
    const h = makeHarness({
      config: { readonly: false, toolTimeoutMs: 20_000, maxResultChars: 90 },
    });
    h.deps.runners.status = async () => {
      process.stdout.write(`${"x".repeat(500)}\n${"y".repeat(500)}\n`);
      return 0;
    };
    const out = await h.bridge.executeTool({
      ...SESSION,
      name: "team_status",
      currentTeam: "atmux",
      argsJson: "{}",
    });
    const env = parseEnvelope(out.envelopeJson);
    expect(env.ok).toBe(true);
    expect(String(env.data)).toMatch(/^… \(\+\d+ more lines\)$/);
  });
});

// ---------- bridge health (the wedge) ----------
//
// THE DEFECT THIS PINS. `executeTool` queues on the verb mutex BEFORE
// racing the timeout, and the mutex has no queue cap and no abandon path.
// So a wired verb that never returns holds the lock forever: every later
// tool call answers `tool_timeout`, permanently, and none of the 12 wired
// verbs calls `process.exit` — the server wedges rather than crashing.
// `/healthz` answered `{"ok":true}` throughout, which for an unattended
// detached-tmux service is worse than having no health check at all.
//
// Every test below drives a verb that genuinely never resolves and
// asserts the health signal changed. A test that only exercised the happy
// path would not cover the defect at all.

describe("bridge health", () => {
  /** A verb that never returns — the wedge, reproduced exactly. */
  function neverReturns(): () => Promise<number> {
    return () => new Promise<number>(() => {});
  }

  test("an idle bridge is healthy, with nothing held and nothing queued", () => {
    const h = makeHarness();
    expect(h.bridge.health()).toEqual({
      wedged: false,
      stuckTool: null,
      heldMs: null,
      queueDepth: 0,
      wedgeThresholdMs: 20_000 * WEDGE_THRESHOLD_MULTIPLE,
    });
  });

  test("a briefly-running tool is NOT wedged — slow is not stuck", async () => {
    const h = makeHarness();
    h.deps.runners.status = neverReturns();
    void h.bridge.executeTool({
      ...SESSION,
      name: "team_status",
      currentTeam: "atmux",
      argsJson: "{}",
    });
    await Bun.sleep(0); // let it acquire the mutex
    h.setNow(1_000 + 20_000); // exactly the tool timeout — still just slow
    const health = h.bridge.health();
    expect(health.heldMs).toBe(20_000);
    expect(health.wedged).toBe(false);
  });

  test("holding exactly the threshold is not wedged; one ms past it is", async () => {
    const h = makeHarness();
    h.deps.runners.status = neverReturns();
    void h.bridge.executeTool({
      ...SESSION,
      name: "team_status",
      currentTeam: "atmux",
      argsJson: "{}",
    });
    await Bun.sleep(0);
    const threshold = 20_000 * WEDGE_THRESHOLD_MULTIPLE;
    h.setNow(1_000 + threshold);
    expect(h.bridge.health().wedged).toBe(false);
    h.setNow(1_000 + threshold + 1);
    expect(h.bridge.health().wedged).toBe(true);
  });

  test("a verb that never returns wedges the bridge and NAMES the stuck tool", async () => {
    // `sleep` resolves immediately, so every call answers `tool_timeout` —
    // the observable symptom the operator actually got.
    const h = makeHarness({ sleep: async () => {} });
    h.deps.runners.status = neverReturns();

    const first = await h.bridge.executeTool({
      ...SESSION,
      name: "team_status",
      currentTeam: "atmux",
      argsJson: "{}",
    });
    expect(parseEnvelope(first.envelopeJson)).toMatchObject({ error: "tool_timeout" });

    h.setNow(1_000 + 20_000 * WEDGE_THRESHOLD_MULTIPLE + 1);
    const health = h.bridge.health();
    expect(health.wedged).toBe(true);
    expect(health.stuckTool).toBe("team_status");
    expect(health.heldMs).toBe(20_000 * WEDGE_THRESHOLD_MULTIPLE + 1);
  });

  test("later tool calls pile up behind the stuck verb, and health reports the depth", async () => {
    const h = makeHarness({ sleep: async () => {} });
    h.deps.runners.status = neverReturns();
    void h.bridge.executeTool({
      ...SESSION,
      name: "team_status",
      currentTeam: "atmux",
      argsJson: "{}",
    });
    await Bun.sleep(0);
    expect(h.bridge.health().queueDepth).toBe(0); // the holder is not queued

    for (let i = 0; i < 4; i += 1) {
      void h.bridge.executeTool({
        ...SESSION,
        name: "team_health",
        currentTeam: "atmux",
        argsJson: "{}",
      });
    }
    await Bun.sleep(0);
    expect(h.bridge.health().queueDepth).toBe(4);
    // The wedge verdict comes from the HOLDER, never from the depth —
    // which is why bounding the queue (below) costs this signal nothing.
    expect(h.bridge.health().stuckTool).toBe("team_status");
    h.setNow(1_000 + 20_000 * WEDGE_THRESHOLD_MULTIPLE + 1);
    expect(h.bridge.health().wedged).toBe(true);
  });

  test("a tool that COMPLETES leaves the bridge healthy — the signal is not sticky", async () => {
    const h = makeHarness();
    await h.bridge.executeTool({
      ...SESSION,
      name: "team_status",
      currentTeam: "atmux",
      argsJson: "{}",
    });
    h.setNow(1_000 + 10 * 60_000); // long after, in case anything latched
    expect(h.bridge.health()).toMatchObject({
      wedged: false,
      stuckTool: null,
      heldMs: null,
      queueDepth: 0,
    });
  });

  test("the threshold derives from the CONFIGURED tool timeout, not a constant", () => {
    const h = makeHarness({
      config: { readonly: false, toolTimeoutMs: 5_000, maxResultChars: 2000 },
    });
    expect(h.bridge.health().wedgeThresholdMs).toBe(5_000 * WEDGE_THRESHOLD_MULTIPLE);
  });

  test("the mutex label is the tool NAME — never its arguments (they reach /healthz)", async () => {
    const h = makeHarness({ sleep: async () => {} });
    h.deps.runners.tellLead = neverReturns();
    void h.bridge.executeTool({
      ...SESSION,
      name: "tell_lead",
      currentTeam: "atmux",
      argsJson: JSON.stringify({ message: "revert the production deploy now" }),
    });
    await Bun.sleep(0);
    expect(h.bridge.health().stuckTool).toBe("tell_lead");
    // Arguments carry what the operator SAID; a label is served publicly.
    expect(JSON.stringify(h.bridge.health())).not.toContain("revert the production deploy");
  });
});

describe("end-to-end through the REAL capture (no injected capture)", () => {
  test("runner stdout is captured, not printed; envelope carries it", async () => {
    const h = makeHarness();
    const out = await h.bridge.executeTool({
      ...SESSION,
      name: "cost_report",
      currentTeam: "atmux",
      argsJson: "{}",
    });
    const env = parseEnvelope(out.envelopeJson);
    expect(env).toMatchObject({ ok: true, tool: "cost_report", team: "atmux" });
    expect(env.data).toBe("cost-output");
    expect(h.calls).toEqual([{ key: "cost", argv: ["--team-dir", "/w/atmux"] }]);
  });
});

// ---------- lane recovery (ADR-272 §Supplement-P7 §R2) ----------
//
// `/healthz` made a wedge VISIBLE; these pin that it is now SURVIVABLE.
// The distinction each test draws is the one the operator needs: "my verb
// is slow" and "the lane is stuck behind someone else's verb" used to
// produce the identical bare `tool_timeout`.

describe("tool_timeout names the stuck verb", () => {
  function neverReturns(): () => Promise<number> {
    return () => new Promise<number>(() => {});
  }

  test("our OWN slow verb reports still_running and names itself", async () => {
    const h = makeHarness({ sleep: async () => {} });
    h.deps.runners.status = neverReturns();
    const out = await h.bridge.executeTool({
      ...SESSION,
      name: "team_status",
      currentTeam: "atmux",
      argsJson: "{}",
    });
    const env = parseEnvelope(out.envelopeJson);
    expect(env).toMatchObject({
      ok: false,
      error: "tool_timeout",
      reason: "still_running",
      stuckTool: "team_status",
      timeoutMs: 20_000,
      queueDepth: 0,
    });
    expect(env.heldMs).toBe(0); // clock has not moved in this harness
  });

  test("a call that never STARTED reports queued_behind and names the holder", async () => {
    const h = makeHarness({ sleep: async () => {} });
    h.deps.runners.status = neverReturns();
    void h.bridge.executeTool({
      ...SESSION,
      name: "team_status",
      currentTeam: "atmux",
      argsJson: "{}",
    });
    await Bun.sleep(0);
    h.setNow(1_000 + 45_000);

    const out = await h.bridge.executeTool({
      ...SESSION,
      name: "team_health",
      currentTeam: "atmux",
      argsJson: "{}",
    });
    const env = parseEnvelope(out.envelopeJson);
    // The whole point: the operator learns WHICH verb is stuck and for how
    // long, from a call that is not the stuck one.
    expect(env).toMatchObject({
      error: "tool_timeout",
      reason: "queued_behind",
      stuckTool: "team_status",
      heldMs: 45_000,
    });
    expect(String(env.message)).toContain("team_status");
  });

  test("the envelope carries the tool NAME and never its arguments", async () => {
    const h = makeHarness({ sleep: async () => {} });
    h.deps.runners.tellLead = neverReturns();
    void h.bridge.executeTool({
      ...SESSION,
      name: "tell_lead",
      currentTeam: "atmux",
      argsJson: JSON.stringify({ message: "revert the production deploy now" }),
    });
    await Bun.sleep(0);
    const out = await h.bridge.executeTool({
      ...SESSION,
      name: "team_health",
      currentTeam: "atmux",
      argsJson: "{}",
    });
    // A tool_timeout envelope is SPOKEN. Arguments carry what the operator
    // said about a different tool call entirely.
    expect(out.envelopeJson).toContain("tell_lead");
    expect(out.envelopeJson).not.toContain("revert the production deploy");
  });
});

describe("bounded queue", () => {
  function neverReturns(): () => Promise<number> {
    return () => new Promise<number>(() => {});
  }

  /** Wedge the lane and fill the queue to its cap. */
  async function wedgeAndFill(h: Harness): Promise<void> {
    h.deps.runners.status = neverReturns();
    void h.bridge.executeTool({
      ...SESSION,
      name: "team_status",
      currentTeam: "atmux",
      argsJson: "{}",
    });
    await Bun.sleep(0);
    for (let i = 0; i < VERB_MUTEX_MAX_QUEUE; i += 1) {
      void h.bridge.executeTool({
        ...SESSION,
        name: "team_health",
        currentTeam: "atmux",
        argsJson: "{}",
      });
    }
    await Bun.sleep(0);
  }

  test("past the cap the call is REFUSED without running, and says which verb is stuck", async () => {
    const h = makeHarness({ sleep: async () => {} });
    await wedgeAndFill(h);
    expect(h.bridge.health().queueDepth).toBe(VERB_MUTEX_MAX_QUEUE);
    const before = h.calls.length;

    const out = await h.bridge.executeTool({
      ...SESSION,
      name: "lead_outbox",
      currentTeam: "atmux",
      argsJson: "{}",
    });
    const env = parseEnvelope(out.envelopeJson);
    expect(env).toMatchObject({
      ok: false,
      tool: "lead_outbox",
      error: "tool_timeout",
      reason: "queue_full",
      stuckTool: "team_status",
      queueDepth: VERB_MUTEX_MAX_QUEUE,
      queueCap: VERB_MUTEX_MAX_QUEUE,
      waitedMs: 0,
    });
    expect(String(env.message)).toContain("NOT run");
    // Refused means refused: the verb never fired.
    expect(h.calls.length).toBe(before);
  });

  test("the queue does not grow without limit, however many calls arrive", async () => {
    const h = makeHarness({ sleep: async () => {} });
    await wedgeAndFill(h);
    for (let i = 0; i < 40; i += 1) {
      await h.bridge.executeTool({
        ...SESSION,
        name: "team_health",
        currentTeam: "atmux",
        argsJson: "{}",
      });
    }
    expect(h.bridge.health().queueDepth).toBe(VERB_MUTEX_MAX_QUEUE);
    // Still honestly wedged — the cap did not silence the signal.
    h.setNow(1_000 + 20_000 * WEDGE_THRESHOLD_MULTIPLE + 1);
    expect(h.bridge.health()).toMatchObject({ wedged: true, stuckTool: "team_status" });
  });
});

describe("the wedge DRAINS instead of persisting", () => {
  test("expired calls are skipped and the lane is usable again", async () => {
    // This is the recovery claim, driven end to end through the REAL
    // capture: one verb wedges, the operator keeps talking, and when the
    // verb finally returns the backlog is discarded rather than executed —
    // then the very next thing he says works.
    const h = makeHarness({ sleep: async () => {} });
    let releaseStuck!: () => void;
    const stuck = new Promise<void>((r) => {
      releaseStuck = r;
    });
    const ran: string[] = [];
    h.deps.runners.status = async () => {
      ran.push("status");
      await stuck;
      process.stdout.write("late status\n");
      return 0;
    };
    h.deps.runners.health = async () => {
      ran.push("health");
      process.stdout.write("health ok\n");
      return 0;
    };

    const first = await h.bridge.executeTool({
      ...SESSION,
      name: "team_status",
      currentTeam: "atmux",
      argsJson: "{}",
    });
    expect(parseEnvelope(first.envelopeJson)).toMatchObject({ error: "tool_timeout" });

    // Three more tool calls while it is stuck; each answers tool_timeout.
    for (let i = 0; i < 3; i += 1) {
      const out = await h.bridge.executeTool({
        ...SESSION,
        name: "team_health",
        currentTeam: "atmux",
        argsJson: "{}",
      });
      expect(parseEnvelope(out.envelopeJson)).toMatchObject({ error: "tool_timeout" });
    }
    expect(h.bridge.health().queueDepth).toBe(3);

    // Time passes well beyond every queued call's own deadline...
    h.setNow(1_000 + 300_000);
    releaseStuck();
    await Bun.sleep(5);

    // ...and NOT ONE of them ran. Before this change all three would have
    // executed here, minutes after the operator was told they timed out.
    expect(ran).toEqual(["status"]);
    expect(h.bridge.health()).toMatchObject({ queueDepth: 0, stuckTool: null, wedged: false });

    // The lane works for the next thing he says — no --stop required.
    h.setNow(1_000);
    h.deps.sleep = () => new Promise<never>(() => {});
    const after = await h.bridge.executeTool({
      ...SESSION,
      name: "team_health",
      currentTeam: "atmux",
      argsJson: "{}",
    });
    expect(parseEnvelope(after.envelopeJson)).toMatchObject({
      ok: true,
      tool: "team_health",
      data: "ok — health ok",
    });
    expect(ran).toEqual(["status", "health"]);
  });

  test("a non-lane rejection is still an internal error, not a lane refusal", async () => {
    // The `instanceof VerbMutexError` guard: only the lane's own refusals
    // render as tool_timeout. Anything else must keep reporting as a bug.
    const h = makeHarness({
      capture: () => Promise.reject(new Error("capture exploded")),
    });
    const out = await h.bridge.executeTool({
      ...SESSION,
      name: "team_status",
      currentTeam: "atmux",
      argsJson: "{}",
    });
    const env = parseEnvelope(out.envelopeJson);
    expect(env).toMatchObject({ ok: false, error: "verb_failed" });
    expect(String(env.message)).toContain("internal error: capture exploded");
  });
});
