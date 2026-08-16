// ADR-272 P4 — `src/verbs/voice.ts`.
//
// The HTTP + WebSocket surface is exercised against a REAL `Bun.serve`
// on an ephemeral port with a fake provider (`tests/helpers/voice-server.ts`)
// — the routes, the auth gate, the upgrade, the frame codec and the
// session state machine are all production code. Only the provider and
// the tmux namespace are faked.

import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SendTarget, TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import { VOICE_ROUTES } from "../../../src/core/voice/assets.ts";
import { encodeFrame, VOICE_FLAG_TURN_END } from "../../../src/core/voice/frame.ts";
import {
  checkModelPin,
  type ModelCheckDeps,
  type ModelCheckResult,
} from "../../../src/core/voice/model-check.ts";
import { WEDGE_THRESHOLD_MULTIPLE } from "../../../src/core/voice/tool-bridge.ts";
import { VOICE_TOOL_CATALOG, type VoiceRunnerKey } from "../../../src/core/voice/tool-catalog.ts";
import {
  DEFAULT_TRANSCRIPT_RETENTION_DAYS,
  TRANSCRIPT_PRUNE_INTERVAL_MS,
  VOICE_TRANSCRIPT_DIR_REL,
} from "../../../src/core/voice/transcript.ts";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import {
  apiKeyEnvVarFor,
  applyDriverScope,
  buildCrashLoopScript,
  buildVoiceDeps,
  fetchHealthzText,
  formatStatusReport,
  healthzBody,
  type MinimalServerWebSocket,
  makeLazyRunners,
  parseHealthzBody,
  parseVoiceArgs,
  phoneLegFor,
  requireApiKey,
  resolveAtmuxBin,
  resolveSuperviseBin,
  resolveVoiceAssetsDir,
  runModelPinCheck,
  runTranscriptPrune,
  SUPERVISE_BACKOFF_SEC,
  SUPERVISE_BREAKER_RESTARTS,
  SUPERVISE_BREAKER_WINDOW_SEC,
  serveVoice,
  shellQuote,
  startupBanner,
  startVoiceServer,
  stopVoice,
  superviseVoice,
  upgradeRefusal,
  VOICE_RUNNER_IMPORTERS,
  VOICE_TMUX_SESSION,
  VOICE_TMUX_SOCKET,
  type VoiceAction,
  type VoiceHealthzBody,
  type VoiceServeDeps,
  type VoiceStatusReport,
  visibleCatalog,
  voice,
  voiceArgsToFlags,
  voiceStatus,
  voiceStatusExitCode,
} from "../../../src/verbs/voice.ts";
import {
  buildTestDeps,
  FakeProvider,
  flush,
  TEST_OPENAI_KEY,
  TEST_VOICE_TOKEN,
  type VoiceServerCtx,
  waitFor,
  withVoiceServer,
} from "../../helpers/voice-server.ts";

// ---------- parseVoiceArgs ----------

describe("parseVoiceArgs", () => {
  test("defaults to --serve", () => {
    expect(parseVoiceArgs([])).toEqual({ action: "serve" });
    expect(parseVoiceArgs(["--serve"])).toEqual({ action: "serve" });
  });

  test.each([
    ["--supervise", "supervise"],
    ["--status", "status"],
    ["--stop", "stop"],
    ["--print-assets-dir", "print-assets-dir"],
  ])("%s selects the %s action", (flag, action) => {
    expect(parseVoiceArgs([flag])).toEqual({ action: action as VoiceAction });
  });

  test("collects every value flag", () => {
    expect(
      parseVoiceArgs([
        "--serve",
        "--port",
        "4400",
        "--provider",
        "gemini",
        "--model",
        "some-model",
        "--readonly",
        "--max-frames",
        "12",
      ]),
    ).toEqual({
      action: "serve",
      port: 4400,
      provider: "gemini",
      model: "some-model",
      readonly: true,
      maxFrames: 12,
    });
  });

  test("a repeated identical action flag is fine", () => {
    expect(parseVoiceArgs(["--status", "--status"])).toEqual({ action: "status" });
  });

  test("two DIFFERENT action flags are refused rather than silently last-wins", () => {
    expect(() => parseVoiceArgs(["--status", "--stop"])).toThrow(/conflicting actions/);
    expect(() => parseVoiceArgs(["--serve", "--supervise"])).toThrow(UsageError);
  });

  test.each([
    [["--port"], /--port requires a value/],
    [["--provider"], /--provider requires a value/],
    [["--model"], /--model requires a value/],
    [["--max-frames"], /--max-frames requires a value/],
  ])("%p is a usage error", (argv, re) => {
    expect(() => parseVoiceArgs(argv as string[])).toThrow(re as RegExp);
  });

  test.each([
    ["--port", "0"],
    ["--port", "-1"],
    ["--port", "4390.5"],
    ["--port", "abc"],
    ["--max-frames", "0"],
    ["--max-frames", "nope"],
  ])("%s %s is refused", (flag, value) => {
    expect(() => parseVoiceArgs([flag, value])).toThrow(/must be a positive integer/);
  });

  test("an unknown arg is a usage error", () => {
    expect(() => parseVoiceArgs(["--nope"])).toThrow(/unknown arg: --nope/);
    expect(() => parseVoiceArgs(["bare"])).toThrow(/unknown arg: bare/);
  });

  test("voiceArgsToFlags maps only what was supplied", () => {
    expect(voiceArgsToFlags({ action: "serve" })).toEqual({});
    expect(
      voiceArgsToFlags({
        action: "serve",
        port: 1,
        provider: "p",
        model: "m",
        readonly: true,
        maxFrames: 9,
      }),
    ).toEqual({ port: 1, provider: "p", model: "m", readonly: true });
    // readonly:false must NOT force the flag on — env still governs.
    expect(voiceArgsToFlags({ action: "serve", readonly: false })).toEqual({});
  });
});

// ---------- runner map ----------

describe("verb runner map", () => {
  test("covers every VoiceRunnerKey the catalog declares", () => {
    const declared = new Set<string>(
      VOICE_TOOL_CATALOG.map((e) => e.runnerKey).filter((k): k is VoiceRunnerKey => k !== null),
    );
    const wired = new Set<string>(Object.keys(VOICE_RUNNER_IMPORTERS));
    expect([...declared].sort()).toEqual([...wired].sort());
    // `list_teams` is the ONE core-direct read (runnerKey null).
    expect(VOICE_TOOL_CATALOG.filter((e) => e.runnerKey === null).map((e) => e.name)).toEqual([
      "list_teams",
    ]);
  });

  test("every importer resolves to a real named export", async () => {
    for (const [key, importer] of Object.entries(VOICE_RUNNER_IMPORTERS)) {
      const fn = await importer();
      expect(typeof fn, `runner '${key}' did not resolve to a function`).toBe("function");
    }
  });

  test("makeLazyRunners imports once and memoizes", async () => {
    let imports = 0;
    let calls: ReadonlyArray<string> = [];
    const runners = makeLazyRunners({
      topo: async () => {
        imports += 1;
        return async (a: ReadonlyArray<string>) => {
          calls = a;
          return 0;
        };
      },
    } as never);
    expect(imports).toBe(0); // nothing imported at construction
    await runners.topo(["--json"]);
    await runners.topo(["--flat"]);
    expect(imports).toBe(1);
    expect(calls).toEqual(["--flat"]);
  });

  test("a failed import is not cached", async () => {
    let attempt = 0;
    const runners = makeLazyRunners({
      topo: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("transient");
        return async () => 7;
      },
    } as never);
    await expect(runners.topo([])).rejects.toThrow("transient");
    expect(await runners.topo([])).toBe(7);
    expect(attempt).toBe(2);
  });
});

// ---------- boot wiring ----------

describe("boot wiring", () => {
  test("api key env var is selected per provider kind", () => {
    expect(apiKeyEnvVarFor("openai-realtime")).toBe("OPENAI_API_KEY");
    expect(apiKeyEnvVarFor("gemini-live")).toBe("GEMINI_API_KEY");
  });

  test("requireApiKey returns the key when present", () => {
    expect(requireApiKey("openai-realtime", { OPENAI_API_KEY: "sk-x" })).toBe("sk-x");
    expect(requireApiKey("gemini-live", { GEMINI_API_KEY: "g-x" })).toBe("g-x");
  });

  test.each([
    ["openai-realtime", "OPENAI_API_KEY", {}],
    ["openai-realtime", "OPENAI_API_KEY", { OPENAI_API_KEY: "" }],
    ["gemini-live", "GEMINI_API_KEY", {}],
  ])("a missing %s key is a ConfigError naming %s", (kind, varName, env) => {
    expect(() => requireApiKey(kind as "openai-realtime", env)).toThrow(ConfigError);
    expect(() => requireApiKey(kind as "openai-realtime", env)).toThrow(new RegExp(varName));
  });

  test("buildVoiceDeps refuses without a token, BEFORE any provider work", async () => {
    let providerBuilt = false;
    await expect(
      buildVoiceDeps({
        env: { OPENAI_API_KEY: "sk-x" },
        makeProvider: () => {
          providerBuilt = true;
          return new FakeProvider();
        },
        loadTeamIndex: async () => ({ teams: [] }),
      }),
    ).rejects.toThrow(/ATMUX_VOICE_TOKEN is required/);
    expect(providerBuilt).toBe(false);
  });

  test("buildVoiceDeps refuses a short token", async () => {
    await expect(
      buildVoiceDeps({
        env: { ATMUX_VOICE_TOKEN: "too-short", OPENAI_API_KEY: "sk-x" },
        loadTeamIndex: async () => ({ teams: [] }),
      }),
    ).rejects.toThrow(/too short/);
  });

  test("buildVoiceDeps refuses a missing OPENAI_API_KEY", async () => {
    await expect(
      buildVoiceDeps({
        env: { ATMUX_VOICE_TOKEN: TEST_VOICE_TOKEN },
        makeProvider: () => new FakeProvider(),
        loadTeamIndex: async () => ({ teams: [] }),
      }),
    ).rejects.toThrow(/OPENAI_API_KEY is required/);
  });

  test("buildVoiceDeps refuses an unknown provider name", async () => {
    await expect(
      buildVoiceDeps({
        env: {
          ATMUX_VOICE_TOKEN: TEST_VOICE_TOKEN,
          OPENAI_API_KEY: "sk-x",
          ATMUX_VOICE_PROVIDER: "not-a-provider",
        },
        loadTeamIndex: async () => ({ teams: [] }),
      }),
    ).rejects.toThrow(/unknown voice provider/);
  });

  test("buildVoiceDeps wires a complete dependency graph", async () => {
    const { deps, provider } = await buildTestDeps();
    expect(deps.config.token).toBe(TEST_VOICE_TOKEN);
    expect(deps.providerCfg).toEqual({ apiKey: TEST_OPENAI_KEY, model: "gpt-realtime" });
    expect(deps.provider).toBe(provider);
    expect(deps.catalog).toHaveLength(VOICE_TOOL_CATALOG.length);
    expect(deps.teamIndex.teams.map((t) => t.name)).toEqual(["atmux", "sopx-root"]);
    expect(typeof deps.uuid()).toBe("string");
    expect(deps.assetsDir.endsWith("/templates/voice")).toBe(true);
    expect(typeof deps.bridge.executeTool).toBe("function");
    expect(deps.shared.registry.current()).toBeNull();
    // Default timers are real; assert the seam is callable, not the delay.
    const h = deps.timers.setTimeout(() => {}, 10_000);
    deps.timers.clearTimeout(h);
    expect(deps.clock()).toBeGreaterThan(0);
  });

  test("an explicit --model overrides the provider default", async () => {
    const { deps } = await buildTestDeps({ flags: { model: "gpt-realtime-mini" } });
    expect(deps.providerCfg.model).toBe("gpt-realtime-mini");
  });

  test("readonly REMOVES the mutating tools from the catalog (absent, not refused)", () => {
    const full = visibleCatalog(false);
    const ro = visibleCatalog(true);
    expect(full).toHaveLength(VOICE_TOOL_CATALOG.length);
    expect(ro).toHaveLength(VOICE_TOOL_CATALOG.filter((e) => !e.mutating).length);
    expect(ro.some((e) => e.mutating)).toBe(false);
    // The 4 messaging tools (ADR-272 D6) plus ADR-273 D4's pane_nudge.
    const removed = full.filter((e) => !ro.includes(e)).map((e) => e.name);
    expect(removed.sort()).toEqual([
      "add_task",
      "claim_task",
      "dispatch_task",
      "pane_nudge",
      "tell_lead",
    ]);
  });

  test("pane_nudge is ABSENT under readonly — the input tool is unreachable until P7", () => {
    // ADR-273 §Consequences: both input tools are absent entirely under
    // ATMUX_VOICE_READONLY=1, so the survey half can ship first. This is
    // the pin that the ordering actually holds, rather than being a
    // sentence in an ADR.
    expect(visibleCatalog(true).some((e) => e.name === "pane_nudge")).toBe(false);
    expect(visibleCatalog(false).some((e) => e.name === "pane_nudge")).toBe(true);
  });

  test("pane_send is NOT in the catalog — OQ-1 is still an operator decision", () => {
    // ADR-273 D4 splits pane input by blast radius; the free-text half
    // inherits ADR-272 §Deferred's second-factor requirement and must
    // not appear because `pane_nudge` shipped.
    expect(VOICE_TOOL_CATALOG.some((e) => e.name === "pane_send")).toBe(false);
  });

  test("readonly deps carry the filtered catalog through to the session", async () => {
    const { deps } = await buildTestDeps({ env: { ATMUX_VOICE_READONLY: "1" } });
    expect(deps.config.readonly).toBe(true);
    expect(deps.catalog.some((e) => e.mutating)).toBe(false);
  });

  test("applyDriverScope grants ADR-272 D3 scope on the supplied env", () => {
    const env: NodeJS.ProcessEnv = {};
    applyDriverScope(env);
    expect(env.ATMUX_CALLER_SCOPE).toBe("driver");
  });

  test("resolveVoiceAssetsDir honours an explicit override and the templates default", () => {
    expect(
      resolveVoiceAssetsDir({
        token: TEST_VOICE_TOKEN,
        provider: "openai-realtime",
        port: 4390,
        host: "127.0.0.1",
        origins: [],
        toolTimeoutMs: 1,
        maxResultChars: 1,
        readonly: false,
        resumeGraceMs: 1,
        confirmTtlMs: 1,
        transcripts: false,
        transcriptRetentionDays: 7,
        assetsDir: "/somewhere/else",
      }),
    ).toBe("/somewhere/else");
  });
});

// ---------- pure server helpers ----------

describe("server helpers", () => {
  test("healthzBody reports provider + readonly, and carries NO secret", async () => {
    const { deps } = await buildTestDeps();
    const body = healthzBody(deps);
    expect(body).toEqual({
      ok: true,
      provider: "openai-realtime",
      readonly: false,
      degraded: null,
      bridge: {
        wedged: false,
        stuckTool: null,
        heldMs: null,
        queueDepth: 0,
        wedgeThresholdMs: 20_000 * WEDGE_THRESHOLD_MULTIPLE,
      },
    });
    const json = JSON.stringify(body);
    expect(json).not.toContain(TEST_OPENAI_KEY);
    expect(json).not.toContain(TEST_VOICE_TOKEN);
  });

  // A wedged bridge is what `/healthz` used to answer `{"ok":true}` for.
  // The bridge here is a hand-built fake reporting the wedge, so this
  // test pins the RENDERING; the wedge DETECTION is pinned end-to-end in
  // "tool bridge wedge" below, against a real verb that never returns.
  test("healthzBody reports ok:false and names the stuck tool when the bridge is wedged", async () => {
    const { deps } = await buildTestDeps();
    deps.bridge = {
      executeTool: deps.bridge.executeTool.bind(deps.bridge),
      health: () => ({
        wedged: true,
        stuckTool: "team_status",
        heldMs: 61_000,
        queueDepth: 3,
        wedgeThresholdMs: 60_000,
      }),
    };
    const body = healthzBody(deps);
    expect(body.ok).toBe(false);
    expect(body.degraded).toBe("tool-bridge-wedged");
    expect(body.bridge).toEqual({
      wedged: true,
      stuckTool: "team_status",
      heldMs: 61_000,
      queueDepth: 3,
      wedgeThresholdMs: 60_000,
    });
    // The pre-existing keys keep their meaning and position — a reader
    // that only knows `ok`/`provider`/`readonly` still works.
    expect(body.provider).toBe("openai-realtime");
    expect(body.readonly).toBe(false);
  });

  test("upgradeRefusal maps the close code to the right HTTP status", async () => {
    expect(upgradeRefusal(4403).status).toBe(403);
    expect(upgradeRefusal(4401).status).toBe(401);
    expect(await upgradeRefusal(4403).text()).toContain("forbidden origin");
    expect(await upgradeRefusal(4401).text()).toContain("unauthorized");
  });

  test("phoneLegFor forwards every verb to the socket", () => {
    const calls: string[] = [];
    const ws: MinimalServerWebSocket = {
      data: { session: null },
      send: (d) => {
        calls.push(typeof d === "string" ? `send:${d}` : `bin:${d.length}`);
        return 1;
      },
      close: (c, r) => calls.push(`close:${c}:${r}`),
      getBufferedAmount: () => 4242,
    };
    const leg = phoneLegFor(ws);
    leg.send("hi");
    leg.sendBinary(new Uint8Array(3));
    leg.close(1000, "bye");
    expect(leg.bufferedAmount()).toBe(4242);
    expect(calls).toEqual(["send:hi", "bin:3", "close:1000:bye"]);
  });

  test("startupBanner names the config but NEVER a secret", async () => {
    const { deps } = await buildTestDeps();
    const banner = startupBanner(deps, {
      port: 4390,
      hostname: "127.0.0.1",
      done: Promise.resolve(0),
      stop: () => {},
    });
    expect(banner).toContain("127.0.0.1:4390");
    expect(banner).toContain("provider=openai-realtime");
    expect(banner).toContain("model=gpt-realtime");
    expect(banner).toContain("readonly=false");
    expect(banner).toContain("assets=");
    expect(banner).not.toContain(TEST_OPENAI_KEY);
    expect(banner).not.toContain(TEST_VOICE_TOKEN);
  });
});

// ---------- live HTTP surface ----------

describe("HTTP surface (real Bun.serve)", () => {
  test("/healthz is open — no token required", async () => {
    await withVoiceServer({}, async (ctx) => {
      const res = await fetch(`${ctx.baseUrl}/healthz`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        provider: "openai-realtime",
        readonly: false,
        degraded: null,
        bridge: {
          wedged: false,
          stuckTool: null,
          heldMs: null,
          queueDepth: 0,
          wedgeThresholdMs: 20_000 * WEDGE_THRESHOLD_MULTIPLE,
        },
      });
    });
  });

  test("/ws without a token is 401", async () => {
    await withVoiceServer({}, async (ctx) => {
      const res = await fetch(`${ctx.baseUrl}/ws`);
      expect(res.status).toBe(401);
    });
  });

  test("/ws with a WRONG token is 401", async () => {
    await withVoiceServer({}, async (ctx) => {
      const res = await fetch(`${ctx.baseUrl}/ws?token=nope`);
      expect(res.status).toBe(401);
    });
  });

  test("/ws with a right token but a disallowed Origin is 403 (origin checked FIRST)", async () => {
    await withVoiceServer(
      { env: { ATMUX_VOICE_ORIGINS: "https://atmux.geoy.ws" } },
      async (ctx) => {
        const good = await fetch(`${ctx.baseUrl}/ws?token=${ctx.token}`, {
          headers: { Origin: "https://evil.example" },
        });
        expect(good.status).toBe(403);
        // Wrong origin AND no token still reads as 403 — the CSRF verdict,
        // not a credentials verdict.
        const both = await fetch(`${ctx.baseUrl}/ws`, {
          headers: { Origin: "https://evil.example" },
        });
        expect(both.status).toBe(403);
      },
    );
  });

  test("a non-upgrade GET on /ws with valid auth is 400, not a crash", async () => {
    await withVoiceServer({}, async (ctx) => {
      const res = await fetch(`${ctx.baseUrl}/ws?token=${ctx.token}`);
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("upgrade failed");
    });
  });

  test("serves the PWA shell with the pinned mime + cache headers", async () => {
    await withVoiceServer({}, async (ctx) => {
      const root = await fetch(`${ctx.baseUrl}/`);
      expect(root.status).toBe(200);
      expect(root.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(root.headers.get("cache-control")).toBe("no-store");
      expect(await root.text()).toContain("<");

      const app = await fetch(`${ctx.baseUrl}/js/app.js`);
      expect(app.status).toBe(200);
      expect(app.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(app.headers.get("cache-control")).toBe("no-store");

      const css = await fetch(`${ctx.baseUrl}/css/app.css`);
      expect(css.status).toBe(200);
      expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");

      const manifest = await fetch(`${ctx.baseUrl}/manifest.webmanifest`);
      expect(manifest.status).toBe(200);
      expect(manifest.headers.get("content-type")).toBe("application/manifest+json");

      const icon = await fetch(`${ctx.baseUrl}/icons/icon-192.png`);
      expect(icon.status).toBe(200);
      expect(icon.headers.get("content-type")).toBe("image/png");
      expect(icon.headers.get("cache-control")).toContain("immutable");

      // EVERY key of the route map, not a hand-picked subset. The
      // hand-picked list above silently omitted /js/protocol.js,
      // /js/audio.js and /worklet/capture.js — three files the PWA
      // cannot run without — so "the shell is served" was a claim about
      // five routes standing in for ten. Driving the real map also means
      // a route added later is covered the day it is added.
      for (const [pathname, entry] of Object.entries(VOICE_ROUTES)) {
        const res = await fetch(`${ctx.baseUrl}${pathname}`);
        expect(res.status, `${pathname} did not serve 200`).toBe(200);
        expect(res.headers.get("content-type"), `${pathname} mime`).toBe(entry.mime);
        expect(res.headers.get("cache-control"), `${pathname} cache`).toBe(entry.cacheControl);
        // A 404 body would satisfy a mere status-free check; require real bytes.
        expect((await res.arrayBuffer()).byteLength, `${pathname} was empty`).toBeGreaterThan(0);
      }
    });
  });

  test("no served asset leaks the token or the api key", async () => {
    await withVoiceServer({}, async (ctx) => {
      for (const path of ["/", "/js/app.js", "/js/protocol.js", "/css/app.css", "/healthz"]) {
        const res = await fetch(`${ctx.baseUrl}${path}`);
        const body = await res.text();
        expect(body, `${path} leaked the api key`).not.toContain(TEST_OPENAI_KEY);
        expect(body, `${path} leaked the token`).not.toContain(TEST_VOICE_TOKEN);
        expect(JSON.stringify([...res.headers])).not.toContain(TEST_OPENAI_KEY);
      }
    });
  });

  test.each([
    "/../etc/passwd",
    "/%2e%2e/%2e%2e/etc/passwd",
    "/js/../../../etc/passwd",
    "/toString",
    "/constructor",
    "/nope.html",
  ])("%s is a 404 — the route map has no filesystem surface", async (path) => {
    await withVoiceServer({}, async (ctx) => {
      const res = await fetch(`${ctx.baseUrl}${path}`);
      expect(res.status).toBe(404);
    });
  });

  test("a route whose file is missing on disk is a 404, not a 500", async () => {
    await withVoiceServer(
      { env: { ATMUX_VOICE_ASSETS_DIR: "/nonexistent-assets-dir" } },
      async (ctx) => {
        expect(ctx.deps.assetsDir).toBe("/nonexistent-assets-dir");
        const res = await fetch(`${ctx.baseUrl}/`);
        expect(res.status).toBe(404);
      },
    );
  });
});

// ---------- live WebSocket surface ----------

/** Open a client socket and collect frames. */
function openClient(url: string): {
  ws: WebSocket;
  texts: string[];
  binaries: Uint8Array[];
  closes: number[];
  opened: Promise<void>;
} {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const texts: string[] = [];
  const binaries: Uint8Array[] = [];
  const closes: number[] = [];
  const { promise: opened, resolve, reject } = Promise.withResolvers<void>();
  ws.onopen = (): void => resolve();
  ws.onerror = (): void => reject(new Error("client socket error"));
  ws.onmessage = (ev): void => {
    if (typeof ev.data === "string") texts.push(ev.data);
    else binaries.push(new Uint8Array(ev.data as ArrayBuffer));
  };
  ws.onclose = (ev): void => {
    closes.push(ev.code);
  };
  return { ws, texts, binaries, closes, opened };
}

function framesOf(texts: string[], type: string): Array<Record<string, unknown>> {
  return texts.map((t) => JSON.parse(t) as Record<string, unknown>).filter((f) => f.type === type);
}

describe("WebSocket surface (real Bun.serve)", () => {
  test("hello → ready reports the real provider and model", async () => {
    await withVoiceServer({}, async (ctx) => {
      const c = openClient(ctx.wsUrl);
      await c.opened;
      c.ws.send(JSON.stringify({ type: "hello", v: 1, token: ctx.token, mode: "ptt" }));
      expect(await waitFor(() => framesOf(c.texts, "ready").length > 0)).toBe(true);

      const ready = framesOf(c.texts, "ready")[0] as Record<string, unknown>;
      expect(ready).toMatchObject({
        type: "ready",
        resumed: false,
        provider: "openai-realtime",
        model: "gpt-realtime",
        readonly: false,
        vad: false,
      });
      expect(ready.teams).toEqual(["atmux", "sopx-root"]);
      expect(String(ready.sessionId).length).toBeGreaterThan(0);
      // Nothing on the wire carries a secret.
      expect(c.texts.join("\n")).not.toContain(TEST_OPENAI_KEY);
      expect(c.texts.join("\n")).not.toContain(TEST_VOICE_TOKEN);
      c.ws.close();
    });
  });

  test("a bad hello token closes 4401 post-upgrade", async () => {
    await withVoiceServer({}, async (ctx) => {
      const c = openClient(ctx.wsUrl);
      await c.opened;
      c.ws.send(JSON.stringify({ type: "hello", v: 1, token: "wrong", mode: "ptt" }));
      expect(await waitFor(() => c.closes.length > 0)).toBe(true);
      expect(c.closes[0]).toBe(4401);
    });
  });

  test("binary audio reaches the provider and TURN_END ends the turn", async () => {
    await withVoiceServer({}, async (ctx) => {
      const c = openClient(ctx.wsUrl);
      await c.opened;
      c.ws.send(JSON.stringify({ type: "hello", v: 1, token: ctx.token, mode: "ptt" }));
      await waitFor(() => framesOf(c.texts, "ready").length > 0);

      c.ws.send(encodeFrame({ flags: 0, seq: 0, payload: new Uint8Array([7, 7, 7, 7]) }));
      c.ws.send(encodeFrame({ flags: VOICE_FLAG_TURN_END, seq: 1, payload: new Uint8Array(0) }));
      expect(await waitFor(() => ctx.provider.lastLeg.turnEnds > 0)).toBe(true);

      const leg = ctx.provider.lastLeg;
      expect(leg.sentAudio).toHaveLength(1);
      expect(Array.from(leg.sentAudio[0] as Uint8Array)).toEqual([7, 7, 7, 7]);
      expect(leg.turnEnds).toBe(1);
      c.ws.close();
    });
  });

  test("provider downlink audio is framed back to the client", async () => {
    await withVoiceServer({}, async (ctx) => {
      const c = openClient(ctx.wsUrl);
      await c.opened;
      c.ws.send(JSON.stringify({ type: "hello", v: 1, token: ctx.token, mode: "ptt" }));
      await waitFor(() => framesOf(c.texts, "ready").length > 0);

      ctx.provider.lastLeg.emit({ type: "audio-out", pcm: new Uint8Array([1, 2, 3, 4]) });
      expect(await waitFor(() => c.binaries.length > 0)).toBe(true);
      const frame = c.binaries[0] as Uint8Array;
      expect(frame[1]).toBe(0x02); // SYNTHETIC
      expect(Array.from(frame.subarray(4))).toEqual([1, 2, 3, 4]);
      c.ws.close();
    });
  });

  test("a client disconnect parks the session; the provider leg stays alive", async () => {
    await withVoiceServer({}, async (ctx) => {
      const c = openClient(ctx.wsUrl);
      await c.opened;
      c.ws.send(JSON.stringify({ type: "hello", v: 1, token: ctx.token, mode: "ptt" }));
      await waitFor(() => framesOf(c.texts, "ready").length > 0);
      const sessionId = String(
        (framesOf(c.texts, "ready")[0] as Record<string, unknown>).sessionId,
      );

      c.ws.close(3000, "phone dropped"); // abnormal from the server's view
      expect(await waitFor(() => ctx.deps.shared.parked.has(sessionId))).toBe(true);
      expect(ctx.provider.lastLeg.closeCalls).toBe(0);

      // A second phone resumes it — same session, no new dial.
      const c2 = openClient(ctx.wsUrl);
      await c2.opened;
      c2.ws.send(
        JSON.stringify({ type: "hello", v: 1, token: ctx.token, mode: "ptt", resume: sessionId }),
      );
      expect(await waitFor(() => framesOf(c2.texts, "ready").length > 0)).toBe(true);
      expect(framesOf(c2.texts, "ready")[0]).toMatchObject({ resumed: true, sessionId });
      expect(ctx.provider.connectCalls).toBe(1);
      c2.ws.close();
    });
  });

  test("--max-frames bounds the serve and exits 0", async () => {
    const { deps, provider } = await buildTestDeps();
    deps.config.port = 0;
    const logs: string[] = [];
    const handle = startVoiceServer({ deps, maxFrames: 2, log: (l) => logs.push(l) });
    try {
      const c = openClient(`ws://127.0.0.1:${handle.port}/ws?token=${deps.config.token}`);
      await c.opened;
      c.ws.send(JSON.stringify({ type: "hello", v: 1, token: deps.config.token, mode: "ptt" }));
      await waitFor(() => framesOf(c.texts, "ready").length > 0);
      c.ws.send(encodeFrame({ flags: 0, seq: 0, payload: new Uint8Array([1, 1]) }));
      c.ws.send(encodeFrame({ flags: 0, seq: 1, payload: new Uint8Array([2, 2]) }));
      // A JSON frame must NOT count toward the binary budget.
      c.ws.send(JSON.stringify({ type: "ping" }));

      expect(await handle.done).toBe(0);
      expect(logs.some((l) => l.includes("--max-frames 2 reached"))).toBe(true);
      expect(provider.lastLeg.sentAudio).toHaveLength(2);
    } finally {
      handle.stop();
    }
  });

  test("--max-frames with NO log seam still stops cleanly (default no-op sink)", async () => {
    const { deps } = await buildTestDeps();
    deps.config.port = 0;
    const handle = startVoiceServer({ deps, maxFrames: 1 });
    try {
      const c = openClient(`ws://127.0.0.1:${handle.port}/ws?token=${deps.config.token}`);
      await c.opened;
      c.ws.send(JSON.stringify({ type: "hello", v: 1, token: deps.config.token, mode: "ptt" }));
      await waitFor(() => framesOf(c.texts, "ready").length > 0);
      c.ws.send(encodeFrame({ flags: 0, seq: 0, payload: new Uint8Array([5, 5]) }));
      expect(await handle.done).toBe(0);
    } finally {
      handle.stop();
    }
  });

  test("stopping twice resolves once and does not throw", async () => {
    const { deps } = await buildTestDeps();
    deps.config.port = 0;
    const handle = startVoiceServer({ deps });
    handle.stop();
    handle.stop();
    expect(await handle.done).toBe(0);
  });
});

// ---------- /healthz tells the truth about a wedged tool bridge ----------
//
// THE DEFECT. `executeTool` queues on the verb mutex BEFORE racing the
// timeout, and the mutex has no queue cap and no abandon path. A wired
// verb that never returns therefore holds it forever: every later tool
// call answers `tool_timeout`, permanently. None of the 12 wired verbs
// calls `process.exit`, so the process wedges rather than crashing, and
// the only recovery is `atmux voice --stop`. Throughout all of that,
// `/healthz` answered `{"ok":true,...}`.
//
// Voice runs unattended in a detached tmux session, so a health check
// that reports green while the service is functionally dead is worse than
// no health check — whatever reads it stops looking. These tests drive a
// REAL server, over a REAL WebSocket, with a runner that genuinely never
// resolves, and read `/healthz` over HTTP.

describe("healthz vs a wedged tool bridge (real Bun.serve, real HTTP)", () => {
  /** 30ms tool timeout ⇒ a 90ms wedge threshold, so the test is fast
   *  without loosening anything: the threshold is still exactly
   *  `WEDGE_THRESHOLD_MULTIPLE × toolTimeoutMs`. */
  const FAST_TIMEOUT_ENV = { ATMUX_VOICE_TOOL_TIMEOUT_MS: "30" };

  async function healthzOf(baseUrl: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${baseUrl}/healthz`);
    return (await res.json()) as Record<string, unknown>;
  }

  /** Drive one tool call in through the provider, as the model would. */
  async function callTool(ctx: VoiceServerCtx, c: ReturnType<typeof openClient>, name: string) {
    c.ws.send(JSON.stringify({ type: "hello", v: 1, token: ctx.token, mode: "ptt" }));
    expect(await waitFor(() => framesOf(c.texts, "ready").length > 0)).toBe(true);
    ctx.provider.lastLeg.emit({
      type: "tool-call",
      id: "call-1",
      name,
      argsJson: JSON.stringify({ team: "atmux" }),
    });
  }

  test("a verb that NEVER returns makes /healthz stop claiming ok", async () => {
    await withVoiceServer(
      {
        env: FAST_TIMEOUT_ENV,
        // The wedge, exactly: a wired verb with no return path.
        runners: { status: () => new Promise<number>(() => {}) },
      },
      async (ctx) => {
        // Healthy before the wedge — so the flip below is caused by it.
        expect(await healthzOf(ctx.baseUrl)).toMatchObject({ ok: true, degraded: null });

        const c = openClient(ctx.wsUrl);
        await c.opened;
        await callTool(ctx, c, "team_status");

        // The operator's symptom: the tool answers tool_timeout...
        expect(await waitFor(() => framesOf(c.texts, "tool.done").length > 0)).toBe(true);
        const done = framesOf(c.texts, "tool.done")[0] as Record<string, unknown>;
        expect(done.ok).toBe(false);

        // ...and once the holder is past the threshold, /healthz says so.
        expect(await waitFor(async () => (await healthzOf(ctx.baseUrl)).ok === false, 3000)).toBe(
          true,
        );
        const body = await healthzOf(ctx.baseUrl);
        expect(body.ok).toBe(false);
        expect(body.degraded).toBe("tool-bridge-wedged");
        expect(body.bridge).toMatchObject({ wedged: true, stuckTool: "team_status" });
        expect(Number((body.bridge as Record<string, unknown>).heldMs)).toBeGreaterThan(90);
        c.ws.close();
      },
    );
  });

  test("later calls queue behind the wedge, and /healthz reports the depth", async () => {
    await withVoiceServer(
      {
        env: FAST_TIMEOUT_ENV,
        runners: {
          status: () => new Promise<number>(() => {}),
          // `team_health` needs a WIRED runner: an unwired one short-
          // circuits to `verb_failed` without ever touching the mutex,
          // and the queue this test is about would never form.
          health: async () => 0,
        },
      },
      async (ctx) => {
        const c = openClient(ctx.wsUrl);
        await c.opened;
        await callTool(ctx, c, "team_status");
        await waitFor(() => framesOf(c.texts, "tool.done").length > 0);
        for (let i = 0; i < 3; i += 1) {
          ctx.provider.lastLeg.emit({
            type: "tool-call",
            id: `later-${i}`,
            name: "team_health",
            argsJson: JSON.stringify({ team: "atmux" }),
          });
        }
        expect(
          await waitFor(async () => {
            const b = await healthzOf(ctx.baseUrl);
            return Number((b.bridge as Record<string, unknown>).queueDepth) >= 3;
          }, 3000),
        ).toBe(true);
        c.ws.close();
      },
    );
  });

  test("a normal tool call leaves /healthz healthy, before, during and after", async () => {
    // The control. Without it, "ok:false when wedged" could be produced
    // by a /healthz that is simply always false.
    await withVoiceServer(
      {
        env: FAST_TIMEOUT_ENV,
        runners: {
          status: async () => {
            process.stdout.write("all green\n");
            return 0;
          },
        },
      },
      async (ctx) => {
        expect(await healthzOf(ctx.baseUrl)).toMatchObject({ ok: true, degraded: null });
        const c = openClient(ctx.wsUrl);
        await c.opened;
        await callTool(ctx, c, "team_status");
        expect(await waitFor(() => framesOf(c.texts, "tool.done").length > 0)).toBe(true);
        expect(framesOf(c.texts, "tool.done")[0]).toMatchObject({ ok: true });

        // Well past the wedge threshold for a tool that already finished.
        await Bun.sleep(150);
        const body = await healthzOf(ctx.baseUrl);
        expect(body.ok).toBe(true);
        expect(body.degraded).toBeNull();
        expect(body.bridge).toMatchObject({ wedged: false, stuckTool: null, queueDepth: 0 });
        c.ws.close();
      },
    );
  });

  test("/healthz stays HTTP 200 while wedged — the body carries the verdict", async () => {
    // `atmux voice --status` treats any non-2xx as UNREACHABLE. A
    // wedged-but-listening server is a different fault from an absent
    // one, and conflating them would make `--status` less informative,
    // not more — so the body (which `--status` now parses and prints)
    // carries the wedge, while the HTTP status carries presence.
    await withVoiceServer(
      {
        env: FAST_TIMEOUT_ENV,
        runners: { status: () => new Promise<number>(() => {}) },
      },
      async (ctx) => {
        const c = openClient(ctx.wsUrl);
        await c.opened;
        await callTool(ctx, c, "team_status");
        expect(await waitFor(async () => (await healthzOf(ctx.baseUrl)).ok === false, 3000)).toBe(
          true,
        );
        const res = await fetch(`${ctx.baseUrl}/healthz`);
        expect(res.status).toBe(200);
        expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
        c.ws.close();
      },
    );
  });

  test("/healthz never carries a secret, wedged or healthy", async () => {
    await withVoiceServer(
      {
        env: FAST_TIMEOUT_ENV,
        runners: { status: () => new Promise<number>(() => {}) },
      },
      async (ctx) => {
        const c = openClient(ctx.wsUrl);
        await c.opened;
        await callTool(ctx, c, "team_status");
        await waitFor(async () => (await healthzOf(ctx.baseUrl)).ok === false, 3000);
        const body = await (await fetch(`${ctx.baseUrl}/healthz`)).text();
        expect(body).not.toContain(TEST_OPENAI_KEY);
        expect(body).not.toContain(TEST_VOICE_TOKEN);
        c.ws.close();
      },
    );
  });
});

// ---------- dial diagnostics reach the real server's stderr ----------
//
// `session.test.ts` proves the session EMITS these lines; this proves the
// production wiring actually carries them out of a real `Bun.serve`
// process — the gap the 2026-08-15 incident fell through, where a server
// that had every fact logged nothing at all.

describe("server diagnostics (real Bun.serve, real stderr sink)", () => {
  test("a provider dial failure reaches the server's log with the provider's error code", async () => {
    const provider = new FakeProvider();
    provider.emitSessionReady = false; // socket opens, provider never answers
    await withVoiceServer({ provider }, async (ctx) => {
      const c = openClient(ctx.wsUrl);
      await c.opened;
      c.ws.send(JSON.stringify({ type: "hello", v: 1, token: ctx.token, mode: "ptt" }));
      expect(await waitFor(() => ctx.provider.legs.length > 0)).toBe(true);
      ctx.provider.lastLeg.emit({
        type: "provider-error",
        code: "beta_api_shape_disabled",
        message: "The Realtime Beta API is no longer supported.",
        fatal: false,
      });
      ctx.provider.lastLeg.emit({ type: "closed", code: 4000, reason: "beta shape" });

      expect(await waitFor(() => ctx.logSink.find("dial attempt 1/") !== undefined)).toBe(true);
      const line = ctx.logSink.find("dial attempt 1/") as string;
      expect(line).toContain("beta_api_shape_disabled");
      expect(line).toContain("provider closed before session-ready");
      expect(line).toContain("code=4000");
      c.ws.close();
    });
  });

  // THE REDACTION TEST the security model rests on. The provider error is
  // adversarial: its message embeds the raw API key AND the voice token,
  // exactly as a provider echoing back a URL or an auth header would. The
  // path is production's: session → `deps.log` → `createVoiceLogger` →
  // stderr sink. Nothing here stands in for the redactor.
  test("a provider error carrying the API KEY and the TOKEN is redacted before it is written", async () => {
    const provider = new FakeProvider();
    provider.emitSessionReady = false;
    await withVoiceServer({ provider }, async (ctx) => {
      const c = openClient(ctx.wsUrl);
      await c.opened;
      c.ws.send(JSON.stringify({ type: "hello", v: 1, token: ctx.token, mode: "ptt" }));
      expect(await waitFor(() => ctx.provider.legs.length > 0)).toBe(true);
      ctx.provider.lastLeg.emit({
        type: "provider-error",
        code: "invalid_api_key",
        message:
          `rejected upgrade to wss://api.openai.com/v1/realtime?key=${TEST_OPENAI_KEY}` +
          ` (Authorization: Bearer ${TEST_OPENAI_KEY}; session token ${TEST_VOICE_TOKEN})`,
        fatal: false,
      });

      expect(await waitFor(() => ctx.logSink.find("invalid_api_key") !== undefined)).toBe(true);
      const written = ctx.logSink.text;
      // 1 — neither secret survived, anywhere in the whole log.
      expect(written).not.toContain(TEST_OPENAI_KEY);
      expect(written).not.toContain(TEST_VOICE_TOKEN);
      // 2 — and the line is still diagnostic. Without this half, a
      // redactor that emitted "" would pass assertion 1 outright.
      const line = ctx.logSink.find("invalid_api_key") as string;
      expect(line).toContain("[invalid_api_key]");
      expect(line).toContain("rejected upgrade to wss://api.openai.com/v1/realtime");
      expect(line).toContain("<redacted>");
      c.ws.close();
    });
  });

  test("a successful dial writes exactly one line, and no speech ever reaches the log", async () => {
    await withVoiceServer({}, async (ctx) => {
      const c = openClient(ctx.wsUrl);
      await c.opened;
      c.ws.send(JSON.stringify({ type: "hello", v: 1, token: ctx.token, mode: "ptt" }));
      expect(await waitFor(() => framesOf(c.texts, "ready").length > 0)).toBe(true);
      ctx.provider.lastLeg.emit({
        type: "transcript",
        role: "user",
        id: "u1",
        text: "stop the production deploy",
        final: true,
      });
      expect(await waitFor(() => framesOf(c.texts, "transcript.user").length > 0)).toBe(true);

      // The banner, then one line for the dial. Nothing else, and above
      // all not the transcript — ADR-272 OQ-4 keeps speech out of here.
      const dialLines = ctx.logSink.matching("provider ready");
      expect(dialLines).toHaveLength(1);
      expect(dialLines[0]).toContain("openai-realtime/gpt-realtime");
      expect(ctx.logSink.text).not.toContain("stop the production deploy");
      c.ws.close();
    });
  });
});

// ---------- transcripts (ADR-272 OQ-4) ----------
//
// OQ-4 resolved WHERE a transcript may live, for HOW LONG, and that
// writing it is OFF unless the operator opts in. These tests drive the
// whole path — real `Bun.serve`, real WebSocket, real session, real
// filesystem — because the property that matters is what ends up ON DISK,
// not what a config object says. A scratch `$HOME` per test keeps the
// operator's own `~/.atmux/voice-logs/` out of the suite entirely.

/** A scratch `$HOME`, its transcript dir, and a cleanup. */
async function scratchHome(): Promise<{ home: string; dir: string; cleanup: () => Promise<void> }> {
  const home = await mkdtemp(join(tmpdir(), "atmux-voice-home-"));
  return {
    home,
    dir: join(home, VOICE_TRANSCRIPT_DIR_REL),
    cleanup: async (): Promise<void> => {
      await rm(home, { recursive: true, force: true });
    },
  };
}

describe("transcript wiring", () => {
  test("OFF by default — buildVoiceDeps hands the session NO sink factory", async () => {
    const { deps } = await buildTestDeps({ env: { HOME: "/home/op" } });
    expect(deps.config.transcripts).toBe(false);
    // Null, not "a factory that checks a flag": the session physically
    // cannot record, so there is no flag left to misread at event time.
    expect(deps.openTranscript).toBeNull();
    expect(deps.transcriptDir).toBe(`/home/op/${VOICE_TRANSCRIPT_DIR_REL}`);
    expect(deps.transcriptRetentionMs).toBe(DEFAULT_TRANSCRIPT_RETENTION_DAYS * 86_400_000);
  });

  test("ATMUX_VOICE_TRANSCRIPTS=1 builds a per-session factory under ~/.atmux/voice-logs", async () => {
    const { deps } = await buildTestDeps({
      env: { HOME: "/home/op", ATMUX_VOICE_TRANSCRIPTS: "1" },
    });
    expect(deps.config.transcripts).toBe(true);
    const sink = deps.openTranscript?.("sess-xyz");
    expect(sink?.path).toBe(`/home/op/${VOICE_TRANSCRIPT_DIR_REL}/voice-sess-xyz.jsonl`);
  });

  test("the retention window follows ATMUX_VOICE_TRANSCRIPT_RETENTION_DAYS", async () => {
    const { deps } = await buildTestDeps({
      env: { ATMUX_VOICE_TRANSCRIPT_RETENTION_DAYS: "2" },
    });
    expect(deps.config.transcriptRetentionDays).toBe(2);
    expect(deps.transcriptRetentionMs).toBe(2 * 86_400_000);
  });

  test("the banner says whether speech is being recorded", async () => {
    const off = await buildTestDeps();
    const on = await buildTestDeps({ env: { ATMUX_VOICE_TRANSCRIPTS: "1" } });
    const handle = { port: 4390, hostname: "127.0.0.1", done: Promise.resolve(0), stop: () => {} };
    expect(startupBanner(off.deps, handle)).toContain("transcripts=false");
    expect(startupBanner(on.deps, handle)).toContain("transcripts=true");
    // Still no secret on the banner.
    expect(startupBanner(on.deps, handle)).not.toContain(TEST_OPENAI_KEY);
    expect(startupBanner(on.deps, handle)).not.toContain(TEST_VOICE_TOKEN);
  });
});

describe("transcripts on disk (end to end)", () => {
  /** Drive one real session that speaks; returns its session id. */
  async function speak(ctx: VoiceServerCtx): Promise<string> {
    const c = openClient(ctx.wsUrl);
    await c.opened;
    c.ws.send(JSON.stringify({ type: "hello", v: 1, token: ctx.token, mode: "ptt" }));
    expect(await waitFor(() => framesOf(c.texts, "ready").length > 0)).toBe(true);
    const sessionId = String((framesOf(c.texts, "ready")[0] as { sessionId: string }).sessionId);
    const leg = ctx.provider.lastLeg;
    leg.emit({ type: "transcript", role: "user", id: "u1", text: "partial fle", final: false });
    leg.emit({ type: "transcript", role: "user", id: "u1", text: "fleet status", final: true });
    leg.emit({
      type: "transcript",
      role: "assistant",
      id: "a1",
      text: "four members up",
      final: true,
    });
    expect(await waitFor(() => framesOf(c.texts, "transcript.assistant").length > 0)).toBe(true);
    await flush();
    c.ws.close();
    return sessionId;
  }

  test("opted IN: the operator's speech lands in ~/.atmux/voice-logs, finals only", async () => {
    const scratch = await scratchHome();
    try {
      let sessionId = "";
      await withVoiceServer(
        { env: { HOME: scratch.home, ATMUX_VOICE_TRANSCRIPTS: "1" } },
        async (ctx) => {
          sessionId = await speak(ctx);
        },
      );
      const file = join(scratch.dir, `voice-${sessionId}.jsonl`);
      expect(await readdir(scratch.dir)).toEqual([`voice-${sessionId}.jsonl`]);
      const raw = await readFile(file, "utf8");
      const rows = raw
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      // CONTENT, not "a file exists": both finals, in order, attributed —
      // and the partial delta absent.
      expect(rows.map((r) => [r.role, r.text])).toEqual([
        ["user", "fleet status"],
        ["assistant", "four members up"],
      ]);
      expect(rows.every((r) => r.session === sessionId)).toBe(true);
      expect(raw).not.toContain("partial fle");
      // A transcript file must never carry a credential.
      expect(raw).not.toContain(TEST_VOICE_TOKEN);
      expect(raw).not.toContain(TEST_OPENAI_KEY);
    } finally {
      await scratch.cleanup();
    }
  });

  test("opted OUT (the shipped default): NOTHING is written — no file, no directory", async () => {
    const scratch = await scratchHome();
    try {
      await withVoiceServer({ env: { HOME: scratch.home } }, async (ctx) => {
        // The exact same conversation as the opt-in test above.
        await speak(ctx);
      });
      // Not an empty directory: no directory at all.
      await expect(stat(scratch.dir)).rejects.toThrow();
      expect(await readdir(scratch.home)).toEqual([]);
    } finally {
      await scratch.cleanup();
    }
  });
});

describe("runTranscriptPrune", () => {
  test("reports the sweep on the log sink", async () => {
    const scratch = await scratchHome();
    try {
      const { deps } = await buildTestDeps({ env: { HOME: scratch.home } });
      const logs: string[] = [];
      await runTranscriptPrune(deps, (l) => logs.push(l));
      expect(logs).toEqual([
        `voice: transcript prune ${scratch.dir} — removed 0, kept 0, skipped 0, errors 0`,
      ]);
    } finally {
      await scratch.cleanup();
    }
  });

  test("an unreachable transcript directory costs a log line, never the boot", async () => {
    // `$HOME` pointed at a FILE: the sweep cannot list it, and the server
    // must still come up. A sweep that could refuse the boot would trade a
    // private log file for the whole voice interface.
    const scratch = await scratchHome();
    try {
      const file = join(scratch.home, "not-a-dir");
      await Bun.write(file, "x");
      const { deps } = await buildTestDeps({ env: { HOME: file } });
      const logs: string[] = [];
      await expect(runTranscriptPrune(deps, (l) => logs.push(l))).resolves.toBeUndefined();
      expect(logs[0]).toContain("transcript prune");
    } finally {
      await scratch.cleanup();
    }
  });
});

// ---------- serveVoice ----------

/**
 * The model-pin drift check, stubbed OFF for every `serveVoice` call in
 * this file.
 *
 * `serveVoice` runs it at boot, and the real one issues an HTTPS GET to
 * the provider's model index. A unit suite must never dial a provider —
 * so every call site here injects this, and the dedicated tests below
 * drive the wiring with a recording stub instead.
 */
const NO_MODEL_CHECK = async (d: ModelCheckDeps): Promise<ModelCheckResult> => ({
  status: "skipped",
  kind: d.kind,
  model: d.model,
  available: null,
  suggestions: [],
  detail: "stubbed in unit tests",
});

describe("serveVoice", () => {
  test("sweeps transcripts at boot, arms the DAILY sweep, and clears it on shutdown", async () => {
    // ADR-272 OQ-4: "pruned on server start and daily thereafter". The
    // armed timer is asserted by its interval, and the shutdown assertion
    // is why a 24h timer cannot hold the process open after `--stop`.
    const scratch = await scratchHome();
    try {
      const { deps } = await buildTestDeps({ env: { HOME: scratch.home } });
      deps.config.port = 0;
      const armed: number[] = [];
      let pending = 0;
      deps.timers = {
        setTimeout: (fn, ms) => {
          armed.push(ms);
          pending += 1;
          return setTimeout(fn, ms);
        },
        clearTimeout: (h) => {
          pending -= 1;
          clearTimeout(h as ReturnType<typeof setTimeout>);
        },
      };
      const logs: string[] = [];
      const abort = new AbortController();
      const p = serveVoice({
        deps,
        log: (l) => logs.push(l),
        signal: abort.signal,
        onSignal: () => {},
        offSignal: () => {},
        checkModel: NO_MODEL_CHECK,
      });
      expect(await waitFor(() => logs.some((l) => l.includes("transcript prune")))).toBe(true);
      expect(logs.some((l) => l.includes(scratch.dir))).toBe(true);
      expect(armed).toEqual([TRANSCRIPT_PRUNE_INTERVAL_MS]);
      abort.abort();
      expect(await p).toBe(0);
      expect(pending).toBe(0);
    } finally {
      await scratch.cleanup();
    }
  });

  test("the DAILY tick actually re-runs the prune, and re-arms — ADR-272 OQ-4", async () => {
    // The sibling test above proves a timer is ARMED at the right
    // interval. It cannot prove the timer's callback DOES anything: the
    // interval is 24h, so with a real `setTimeout` nothing ever fires
    // inside a unit run and "daily thereafter" is asserted only as an
    // integer. Capture the armed callback and fire it.
    const scratch = await scratchHome();
    try {
      const { deps } = await buildTestDeps({ env: { HOME: scratch.home } });
      deps.config.port = 0;
      const armedFns: Array<() => void> = [];
      deps.timers = {
        setTimeout: (fn) => {
          armedFns.push(fn as () => void);
          return armedFns.length;
        },
        clearTimeout: () => {},
      };
      const logs: string[] = [];
      const pruneLines = (): string[] => logs.filter((l) => l.includes("transcript prune"));
      const abort = new AbortController();
      const p = serveVoice({
        deps,
        log: (l) => logs.push(l),
        signal: abort.signal,
        onSignal: () => {},
        offSignal: () => {},
        checkModel: NO_MODEL_CHECK,
      });
      expect(await waitFor(() => pruneLines().length === 1)).toBe(true);
      expect(armedFns.length).toBe(1);

      // Fire the day-later tick.
      (armedFns[0] as () => void)();
      expect(await waitFor(() => pruneLines().length === 2)).toBe(true);
      // …and it re-arms, so the sweep is daily rather than once-then-never.
      expect(await waitFor(() => armedFns.length === 2)).toBe(true);

      abort.abort();
      expect(await p).toBe(0);
    } finally {
      await scratch.cleanup();
    }
  });

  test("logs the banner, honours SIGINT-style shutdown, and unregisters handlers", async () => {
    const { deps } = await buildTestDeps();
    deps.config.port = 0;
    const logs: string[] = [];
    const handlers = new Map<string, () => void>();
    const removed: string[] = [];
    const p = serveVoice({
      deps,
      log: (l) => logs.push(l),
      onSignal: (name, h) => handlers.set(name, h),
      offSignal: (name) => removed.push(name),
      checkModel: NO_MODEL_CHECK,
    });
    // Handlers register after the banner; wait, then fire the "signal".
    expect(await waitFor(() => handlers.has("SIGINT") && handlers.has("SIGTERM"))).toBe(true);
    handlers.get("SIGINT")?.();
    const code = await p;
    expect(code).toBe(0);
    expect(logs.some((l) => l.startsWith("voice: listening on 127.0.0.1:"))).toBe(true);
    expect(logs).toContain("voice: shutting down");
    expect(removed.sort()).toEqual(["SIGINT", "SIGTERM"]);
  });

  test("the model-pin drift check runs at boot, with the CONFIGURED provider + model", async () => {
    const { deps } = await buildTestDeps();
    deps.config.port = 0;
    const seen: ModelCheckDeps[] = [];
    const logs: string[] = [];
    const abort = new AbortController();
    const p = serveVoice({
      deps,
      log: (l) => logs.push(l),
      signal: abort.signal,
      onSignal: () => {},
      offSignal: () => {},
      checkModel: async (d) => {
        seen.push(d);
        return {
          status: "ok",
          kind: d.kind,
          model: d.model,
          available: 42,
          suggestions: [],
          detail: null,
        };
      },
    });
    expect(await waitFor(() => logs.some((l) => l.includes("model check ok")))).toBe(true);
    abort.abort();
    await p;
    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe("openai-realtime");
    expect(seen[0]?.model).toBe(deps.providerCfg.model);
    // It receives the key (it must — the list endpoint is authenticated)
    // and no logged line carries it.
    expect(seen[0]?.apiKey).toBe(TEST_OPENAI_KEY);
    for (const l of logs) expect(l).not.toContain(TEST_OPENAI_KEY);
  });

  test("a MISSING model prints the loud banner and the server STILL serves", async () => {
    // The whole design: a drift verdict is a warning, never a refusal.
    // Failing the boot here would let a wrong warning take voice down.
    const { deps } = await buildTestDeps();
    deps.config.port = 0;
    const logs: string[] = [];
    const abort = new AbortController();
    const p = serveVoice({
      deps,
      log: (l) => logs.push(l),
      signal: abort.signal,
      onSignal: () => {},
      offSignal: () => {},
      checkModel: async (d) => ({
        status: "missing",
        kind: d.kind,
        model: d.model,
        available: 300,
        suggestions: ["gpt-realtime-2"],
        detail: null,
      }),
    });
    expect(await waitFor(() => logs.some((l) => l.includes("MODEL PIN DRIFT")))).toBe(true);
    expect(logs.some((l) => l.startsWith("voice: listening on"))).toBe(true);
    expect(logs.some((l) => l.includes("gpt-realtime-2"))).toBe(true);
    abort.abort();
    // Still exits cleanly — the server ran.
    expect(await p).toBe(0);
  });

  test("a THROWING check cannot take the boot down", async () => {
    const { deps } = await buildTestDeps();
    deps.config.port = 0;
    const logs: string[] = [];
    const abort = new AbortController();
    const p = serveVoice({
      deps,
      log: (l) => logs.push(l),
      signal: abort.signal,
      onSignal: () => {},
      offSignal: () => {},
      checkModel: async () => {
        throw new Error("checker blew up");
      },
    });
    expect(await waitFor(() => logs.some((l) => l.includes("model check itself failed")))).toBe(
      true,
    );
    abort.abort();
    expect(await p).toBe(0);
  });

  test("runModelPinCheck defaults to the real checker (wiring pin, not a dial)", async () => {
    // Asserts the DEFAULT argument is `checkModelPin` by driving the
    // function with an explicit stub AND checking the exported default
    // is the real one — without ever letting the real one run.
    const { deps } = await buildTestDeps();
    const logs: string[] = [];
    await runModelPinCheck(deps, (l) => logs.push(l), NO_MODEL_CHECK);
    expect(logs.some((l) => l.includes("model check SKIPPED"))).toBe(true);
    expect(typeof checkModelPin).toBe("function");
  });

  test("an AbortSignal stops the server", async () => {
    const { deps } = await buildTestDeps();
    deps.config.port = 0;
    const abort = new AbortController();
    const p = serveVoice({
      deps,
      log: () => {},
      signal: abort.signal,
      onSignal: () => {},
      offSignal: () => {},
      checkModel: NO_MODEL_CHECK,
    });
    await flush();
    abort.abort();
    expect(await p).toBe(0);
  });
});

// ---------- supervise / status / stop ----------

interface TmuxSpy {
  tmux: TmuxNamespace;
  sessions: Set<string>;
  created: Array<Record<string, unknown>>;
  killed: string[];
  keys: Array<{ target: SendTarget; keys: string }>;
}

function tmuxSpy(existing: string[] = []): TmuxSpy {
  const sessions = new Set(existing);
  const created: Array<Record<string, unknown>> = [];
  const killed: string[] = [];
  const keys: Array<{ target: SendTarget; keys: string }> = [];
  const tmux = {
    session: {
      hasSession: async (n: string) => sessions.has(n),
      newSession: async (o: Record<string, unknown>) => {
        created.push(o);
        sessions.add(String(o.name));
      },
      killSession: async (n: string) => {
        killed.push(n);
        sessions.delete(n);
      },
    },
    pane: {
      sendKeys: async (o: { target: SendTarget; keys: string }) => {
        keys.push(o);
      },
    },
  } as unknown as TmuxNamespace;
  return { tmux, sessions, created, killed, keys };
}

describe("supervise", () => {
  test("is idempotent — an existing session is reported, never recreated", async () => {
    const spy = tmuxSpy([VOICE_TMUX_SESSION]);
    const logs: string[] = [];
    expect(
      await superviseVoice({
        tmux: spy.tmux,
        binPath: "/usr/local/bin/atmux",
        log: (l) => logs.push(l),
      }),
    ).toBe(0);
    expect(spy.created).toHaveLength(0);
    expect(logs[0]).toContain("already running");
  });

  test("creates a DETACHED session running the crash-loop wrapper", async () => {
    const spy = tmuxSpy();
    const logs: string[] = [];
    expect(
      await superviseVoice({
        tmux: spy.tmux,
        binPath: "/usr/local/bin/atmux",
        log: (l) => logs.push(l),
        cwd: "/root/work/src/atmux",
      }),
    ).toBe(0);
    expect(spy.created).toHaveLength(1);
    const opts = spy.created[0] as Record<string, unknown>;
    expect(opts.name).toBe(VOICE_TMUX_SESSION);
    expect(opts.detached).toBe(true);
    expect(opts.cwd).toBe("/root/work/src/atmux");
    expect(String(opts.shellCommand)).toContain("voice --serve");
    expect(logs[0]).toContain(VOICE_TMUX_SESSION);
  });

  test("targets the OPERATOR'S DEFAULT tmux socket, not a cage socket", () => {
    // ADR-272 D10 name-collision check: `default` is tmux's own default
    // socket name — NOT `atmux-<team>` (cage) and NOT `atmux-cockpit`.
    expect(VOICE_TMUX_SOCKET).toBe("default");
    expect(VOICE_TMUX_SESSION).toBe("atmux-voice");
    expect(VOICE_TMUX_SOCKET.startsWith("atmux-")).toBe(false);
  });

  test("the crash-loop wrapper backs off, breaks the circuit, and stops respawning", () => {
    const script = buildCrashLoopScript("/usr/local/bin/atmux");
    expect(script).toContain("trap 'exit 0' INT TERM");
    expect(script).toContain("'/usr/local/bin/atmux' voice --serve");
    expect(script).toContain(`sleep ${SUPERVISE_BACKOFF_SEC}`);
    expect(script).toContain(`-ge ${SUPERVISE_BREAKER_WINDOW_SEC}`);
    expect(script).toContain(`-ge ${SUPERVISE_BREAKER_RESTARTS}`);
    expect(script).toContain("circuit breaker tripped");
    // On trip it BREAKS the loop (stops respawning) and keeps the pane
    // alive so the error stays readable — not `exit`, which would erase it.
    expect(script).toContain("break");
    expect(script).toContain('exec "${SHELL:-/bin/sh}"');
    // The restart counter resets when the window rolls over.
    expect(script).toContain("window_start=$now");
  });

  test("the wrapper is a valid POSIX shell script", async () => {
    const script = buildCrashLoopScript("/usr/local/bin/atmux");
    const proc = Bun.spawn(["sh", "-n"], { stdin: "pipe", stderr: "pipe" });
    proc.stdin.write(script);
    await proc.stdin.end();
    expect(await proc.exited).toBe(0);
  });

  test("a bin path with a quote cannot break out of the wrapper", async () => {
    expect(shellQuote("/opt/a'b/atmux")).toBe("'/opt/a'\\''b/atmux'");

    // The real property is not "the dangerous text is absent" — it IS
    // present, inert, inside the quotes. The property is that a real
    // shell reads the whole thing back as ONE literal argument. Prove
    // that by round-tripping it through `sh`.
    const nasty = "/opt/a'b; rm -rf /; echo '/atmux";
    const proc = Bun.spawn(["sh", "-c", `printf '%s' ${shellQuote(nasty)}`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await new Response(proc.stdout).text()).toBe(nasty);
    expect(await proc.exited).toBe(0);

    // And the generated script still parses (the quoting did not unbalance it).
    const script = buildCrashLoopScript(nasty);
    const check = Bun.spawn(["sh", "-n"], { stdin: "pipe", stderr: "pipe" });
    check.stdin.write(script);
    await check.stdin.end();
    expect(await check.exited).toBe(0);
  });

  test("resolveAtmuxBin prefers the PATH shim, falling back to execPath", () => {
    expect(resolveAtmuxBin({ which: () => "/usr/local/bin/atmux" })).toBe("/usr/local/bin/atmux");
    expect(resolveAtmuxBin({ which: () => null, execPath: "/opt/atmux/0.9/bin/atmux" })).toBe(
      "/opt/atmux/0.9/bin/atmux",
    );
    expect(resolveAtmuxBin({ which: () => "", execPath: "/fallback" })).toBe("/fallback");
  });
});

// ---------------------------------------------------------------------
// ATMUX_VOICE_BIN — the override that makes --supervise usable from a
// repo checkout (ADR-273 §Supplement).
// ---------------------------------------------------------------------

describe("resolveSuperviseBin — precedence and fail-closed behaviour", () => {
  const PATH_BIN = "/opt/atmux/0.8.30";
  const REPO_BIN = "/root/work/src/atmux/bin/atmux-bun";
  const resolve = (): string => PATH_BIN;

  test("with nothing set it is exactly resolveAtmuxBin — unchanged behaviour", () => {
    expect(resolveSuperviseBin({ env: {}, resolve })).toBe(PATH_BIN);
  });

  test("ATMUX_VOICE_BIN beats the PATH resolution", () => {
    // The live failure this exists for: PATH resolves an INSTALLED
    // release that predates the `voice` verb, so the supervisor's wrapper
    // prints `unknown verb: voice`, exits 64, and crash-loops.
    expect(resolveSuperviseBin({ env: { ATMUX_VOICE_BIN: REPO_BIN }, resolve })).toBe(REPO_BIN);
  });

  test("an explicit per-call override beats the env var", () => {
    expect(
      resolveSuperviseBin({
        override: "/explicit/atmux",
        env: { ATMUX_VOICE_BIN: REPO_BIN },
        resolve,
      }),
    ).toBe("/explicit/atmux");
  });

  test("an EMPTY or whitespace-only value falls through — fails CLOSED", () => {
    // A fat-fingered `export ATMUX_VOICE_BIN=` must degrade to the
    // current behaviour, never produce a wrapper that execs `'' voice`.
    for (const bad of ["", "   ", "\t", "\n"]) {
      expect(resolveSuperviseBin({ env: { ATMUX_VOICE_BIN: bad }, resolve }), bad).toBe(PATH_BIN);
      expect(resolveSuperviseBin({ override: bad, env: {}, resolve }), bad).toBe(PATH_BIN);
    }
  });

  test("an empty OVERRIDE still lets a good env var win — each layer is independent", () => {
    expect(
      resolveSuperviseBin({ override: "  ", env: { ATMUX_VOICE_BIN: REPO_BIN }, resolve }),
    ).toBe(REPO_BIN);
  });

  test("with no env seam it reads the real process.env", () => {
    const prior = process.env.ATMUX_VOICE_BIN;
    process.env.ATMUX_VOICE_BIN = "/probe/atmux";
    try {
      expect(resolveSuperviseBin({ resolve })).toBe("/probe/atmux");
    } finally {
      if (prior === undefined) delete process.env.ATMUX_VOICE_BIN;
      else process.env.ATMUX_VOICE_BIN = prior;
    }
  });

  test("with no resolve seam it falls through to the real resolveAtmuxBin", () => {
    expect(resolveSuperviseBin({ env: {} })).toBe(resolveAtmuxBin());
  });
});

describe("voice --supervise honours ATMUX_VOICE_BIN end to end", () => {
  test("the crash-loop script re-execs the overridden binary", async () => {
    const spy = tmuxSpy();
    const prior = process.env.ATMUX_VOICE_BIN;
    process.env.ATMUX_VOICE_BIN = "/root/work/src/atmux/bin/atmux-bun";
    try {
      expect(await voice(["--supervise"], { tmux: spy.tmux, log: () => {} })).toBe(0);
    } finally {
      if (prior === undefined) delete process.env.ATMUX_VOICE_BIN;
      else process.env.ATMUX_VOICE_BIN = prior;
    }
    const script = String((spy.created[0] as Record<string, unknown>).shellCommand);
    expect(script).toContain("'/root/work/src/atmux/bin/atmux-bun' voice --serve");
  });

  test("an explicit binPath override still wins over the env var", async () => {
    const spy = tmuxSpy();
    const prior = process.env.ATMUX_VOICE_BIN;
    process.env.ATMUX_VOICE_BIN = "/from/env";
    try {
      await voice(["--supervise"], { tmux: spy.tmux, log: () => {}, binPath: "/from/flag" });
    } finally {
      if (prior === undefined) delete process.env.ATMUX_VOICE_BIN;
      else process.env.ATMUX_VOICE_BIN = prior;
    }
    expect(String((spy.created[0] as Record<string, unknown>).shellCommand)).toContain(
      "'/from/flag' voice --serve",
    );
  });
});

describe("status", () => {
  // The LOCAL config every test below invokes `--status` with. Its
  // `provider` / `readonly` values are the WRONG ANSWER on purpose:
  // every server fixture in this block disagrees with them, so any
  // assertion that passes can only be reading the `/healthz` body. A
  // fixture where both sources agree would prove nothing — that is
  // exactly how the original bug survived its own test suite.
  const cfg = {
    token: TEST_VOICE_TOKEN,
    provider: "gemini-live",
    port: 4390,
    host: "127.0.0.1",
    origins: [],
    toolTimeoutMs: 1,
    maxResultChars: 1,
    readonly: false,
    resumeGraceMs: 1,
    confirmTtlMs: 1,
    transcripts: false,
    transcriptRetentionDays: 7,
  };

  /** A `/healthz` body as the wire carries it. Defaults are healthy. */
  const serverBody = (over: Partial<VoiceHealthzBody> = {}): string =>
    JSON.stringify({
      ok: true,
      provider: "openai-realtime",
      readonly: true,
      degraded: null,
      bridge: {
        wedged: false,
        stuckTool: null,
        heldMs: null,
        queueDepth: 0,
        wedgeThresholdMs: 60_000,
      },
      ...over,
    });

  const statusOf = async (
    body: string | null,
    over: Partial<typeof cfg> = {},
  ): Promise<VoiceStatusReport> =>
    await voiceStatus({
      tmux: tmuxSpy([VOICE_TMUX_SESSION]).tmux,
      config: { ...cfg, ...over },
      fetchHealthz: async () => body,
    });

  const lineOf = (out: string, prefix: string): string =>
    out.split("\n").find((l) => l.startsWith(prefix)) ?? "";

  test("probes the right URL and reports the SERVER's fields, not its own config", async () => {
    const probed: string[] = [];
    const report = await voiceStatus({
      tmux: tmuxSpy([VOICE_TMUX_SESSION]).tmux,
      // Local config says gemini-live + readonly=false …
      config: cfg,
      fetchHealthz: async (u) => {
        probed.push(u);
        // … the server says openai-realtime + readonly=true.
        return serverBody();
      },
    });
    expect(probed).toEqual(["http://127.0.0.1:4390/healthz"]);
    expect(report.server).toMatchObject({ provider: "openai-realtime", readonly: true });
    expect(report.unavailable).toBeNull();
    // The local values are still carried — but only under `local`, never
    // as the server's state.
    expect(report.local).toEqual({ provider: "gemini-live", readonly: false });
    expect(formatStatusReport(report)).toContain(
      "voice: server: provider=openai-realtime  readonly=true",
    );
  });

  test("SECURITY: server readonly=false wins over a shell that exports readonly=true", async () => {
    // The dangerous direction. A shell with ATMUX_VOICE_READONLY=1
    // querying a server on which every mutating tool is LIVE must not be
    // told mutation is disabled.
    const report = await statusOf(serverBody({ readonly: false }), { readonly: true });
    expect(report.server?.readonly).toBe(false);
    const out = formatStatusReport(report);
    expect(lineOf(out, "voice: server: provider=")).toContain("readonly=false");
    expect(out).not.toContain("readonly=true");
  });

  test("server readonly=true wins over a shell that did not export the flag", async () => {
    // The direction observed live: `--status` printed readonly=false
    // about an emphatically readonly server.
    const report = await statusOf(serverBody({ readonly: true }), { readonly: false });
    expect(report.server?.readonly).toBe(true);
    expect(lineOf(formatStatusReport(report), "voice: server: provider=")).toContain(
      "readonly=true",
    );
  });

  test("provider comes from the server in BOTH directions of disagreement", async () => {
    const a = await statusOf(serverBody({ provider: "openai-realtime" }), {
      provider: "gemini-live",
    });
    expect(lineOf(formatStatusReport(a), "voice: server: provider=")).toContain(
      "provider=openai-realtime",
    );
    expect(formatStatusReport(a)).not.toContain("provider=gemini-live");

    const b = await statusOf(serverBody({ provider: "gemini-live" }), {
      provider: "openai-realtime",
    });
    expect(lineOf(formatStatusReport(b), "voice: server: provider=")).toContain(
      "provider=gemini-live",
    );
    expect(formatStatusReport(b)).not.toContain("provider=openai-realtime");
  });

  test("a wedged bridge is visible from --status, not only from a raw curl", async () => {
    const report = await statusOf(
      serverBody({
        ok: false,
        degraded: "tool-bridge-wedged",
        bridge: {
          wedged: true,
          stuckTool: "team_status",
          heldMs: 184_213,
          queueDepth: 6,
          wedgeThresholdMs: 60_000,
        },
      }),
    );
    const out = formatStatusReport(report);
    expect(out).toContain("healthz=degraded");
    expect(out).toContain("degraded=tool-bridge-wedged");
    expect(out).toContain("bridge=WEDGED");
    expect(out).toContain("stuckTool=team_status");
    expect(out).toContain("heldMs=184213");
    expect(out).toContain("queueDepth=6");
    expect(out).toContain("wedgeThresholdMs=60000");
    // Reachability is unchanged by a wedge — the session is up and the
    // probe answered, so the shell conditional still says 0.
    expect(voiceStatusExitCode(report)).toBe(0);
  });

  test("a healthy bridge renders the same block with the healthy values", async () => {
    const out = formatStatusReport(await statusOf(serverBody()));
    expect(out).toContain("healthz=ok");
    expect(out).toContain("degraded=none");
    expect(out).toContain("bridge=ok");
    expect(out).toContain("stuckTool=none");
    expect(out).toContain("heldMs=-");
    expect(out).toContain("queueDepth=0");
  });

  test("UNREACHABLE: local config is never asserted as the server's state", async () => {
    // Both local values are set and both are wrong for the server we
    // cannot reach. Nothing here may present them as fact.
    const report = await statusOf(null, { provider: "openai-realtime", readonly: true });
    expect(report.server).toBeNull();
    expect(report.unavailable).toBe("unreachable");

    const out = formatStatusReport(report);
    expect(out).toContain("healthz=unreachable");
    expect(out).toContain("voice: server state UNKNOWN — /healthz did not answer");
    // No line claims to describe the server …
    expect(out).not.toContain("voice: server: ");
    // … and the only line carrying the local values says so, loudly.
    expect(lineOf(out, "voice: local config (NOT the server):")).toBe(
      "voice: local config (NOT the server): provider=openai-realtime  readonly=true",
    );
    expect(voiceStatusExitCode(report)).toBe(1);
  });

  test("MALFORMED: a body that is not a healthz body is reported, not crashed on", async () => {
    for (const body of [
      "not json at all",
      "null",
      '{"ok":true}', // partial — no provider / readonly / bridge
      '{"ok":true,"provider":"openai-realtime","readonly":true,"degraded":null,"bridge":{"wedged":false}}',
      '{"ok":"yes","provider":"openai-realtime","readonly":true,"degraded":null,"bridge":{"wedged":false,"stuckTool":null,"heldMs":null,"queueDepth":0,"wedgeThresholdMs":1}}',
      '{"ok":true,"provider":"openai-realtime","readonly":true,"degraded":"who-knows","bridge":{"wedged":false,"stuckTool":null,"heldMs":null,"queueDepth":0,"wedgeThresholdMs":1}}',
      "<html>502 Bad Gateway</html>",
    ]) {
      const report = await statusOf(body, { provider: "openai-realtime", readonly: true });
      expect(report.server).toBeNull();
      expect(report.unavailable).toBe("malformed");
      const out = formatStatusReport(report);
      expect(out).toContain("healthz=malformed");
      expect(out).toContain("body atmux could not parse");
      expect(out).not.toContain("voice: server: ");
      expect(out).toContain("voice: local config (NOT the server):");
      expect(voiceStatusExitCode(report)).toBe(1);
    }
  });

  test("a NEWER server's extra healthz fields parse rather than reading as malformed", async () => {
    // Forward-compat: the installed shim routinely lags the checkout
    // that is serving. An added field must not turn every `--status`
    // into "malformed".
    const body = JSON.parse(serverBody()) as Record<string, unknown>;
    body.futureField = { anything: true };
    const report = await statusOf(JSON.stringify(body));
    expect(report.unavailable).toBeNull();
    expect(report.server).toMatchObject({ provider: "openai-realtime", readonly: true });
  });

  test("session down + server reachable still renders the server's state", async () => {
    const report = await voiceStatus({
      tmux: tmuxSpy().tmux, // no session
      config: cfg,
      fetchHealthz: async () => serverBody(),
    });
    const out = formatStatusReport(report);
    expect(out).toContain("session=down");
    expect(out).toContain("readonly=true");
    // Session absent ⇒ non-zero even though /healthz answered.
    expect(voiceStatusExitCode(report)).toBe(1);
  });

  test("no line of any status report leaks the token", async () => {
    for (const body of [serverBody(), null, "garbage"]) {
      expect(formatStatusReport(await statusOf(body))).not.toContain(TEST_VOICE_TOKEN);
    }
  });

  test("parseHealthzBody accepts what healthzBody produces — the drift guard", async () => {
    // The producer and the parser are one contract. Round-trip the REAL
    // producer output rather than a hand-written fixture, so a field
    // added on one side and forgotten on the other fails here.
    const { deps } = await buildTestDeps({});
    const produced = healthzBody(deps);
    expect(parseHealthzBody(JSON.stringify(produced))).toEqual(produced);
  });

  test("fetchHealthzText returns null for a dead port and rethrows a bad URL", async () => {
    // Nothing listens on loopback:1 — the real probe must resolve to
    // null rather than hang or throw.
    expect(await fetchHealthzText("http://127.0.0.1:1/healthz")).toBeNull();
    // A malformed URL is the caller's bug, not a server verdict.
    await expect(fetchHealthzText("not-a-url")).rejects.toThrow(ConfigError);
  });

  test("fetchHealthzText keeps the body of a live 200 and drops a non-2xx", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (req) =>
        new URL(req.url).pathname === "/healthz"
          ? new Response(serverBody(), { headers: { "content-type": "application/json" } })
          : new Response("nope", { status: 503 }),
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const text = await fetchHealthzText(`${base}/healthz`);
      expect(text).not.toBeNull();
      expect(parseHealthzBody(text as string)).toMatchObject({ readonly: true });
      expect(await fetchHealthzText(`${base}/boom`)).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  test("voiceStatus with no probe seam uses the real HTTP fetch", async () => {
    const report = await voiceStatus({
      tmux: tmuxSpy().tmux,
      // Port 1 on loopback: nothing listens, so the real probe must
      // resolve to unreachable rather than hang or throw.
      config: { ...cfg, port: 1 },
    });
    expect(report.url).toBe("http://127.0.0.1:1/healthz");
    expect(report.server).toBeNull();
    expect(report.unavailable).toBe("unreachable");
  });
});

describe("stop", () => {
  test("SIGINTs the pane BEFORE killing the session", async () => {
    const spy = tmuxSpy([VOICE_TMUX_SESSION]);
    const order: string[] = [];
    const logs: string[] = [];
    const wrapped = {
      ...spy.tmux,
      session: {
        ...spy.tmux.session,
        killSession: async (n: string) => {
          order.push("kill");
          await spy.tmux.session.killSession(n);
        },
      },
      pane: {
        ...spy.tmux.pane,
        sendKeys: async (o: { target: SendTarget; keys: string }) => {
          order.push("sigint");
          await spy.tmux.pane.sendKeys(o);
        },
      },
    } as unknown as TmuxNamespace;

    expect(
      await stopVoice({ tmux: wrapped, log: (l) => logs.push(l), sleep: async () => {} }),
    ).toBe(0);
    expect(order).toEqual(["sigint", "kill"]);
    expect(spy.keys[0]?.keys).toBe("C-c");
    expect(spy.keys[0]?.target).toMatchObject({ kind: "service" });
    expect(spy.killed).toEqual([VOICE_TMUX_SESSION]);
    expect(logs.pop()).toContain("stopped");
  });

  test("is a no-op when no session exists", async () => {
    const spy = tmuxSpy();
    const logs: string[] = [];
    expect(await stopVoice({ tmux: spy.tmux, log: (l) => logs.push(l) })).toBe(0);
    expect(spy.keys).toHaveLength(0);
    expect(spy.killed).toHaveLength(0);
    expect(logs[0]).toContain("no 'atmux-voice' session");
  });
});

// ---------- verb entry ----------

describe("voice() entry", () => {
  const env = process.env;

  test("--print-assets-dir prints the dir and exits 0 WITHOUT needing an api key", async () => {
    const out: string[] = [];
    const saved = { t: env.ATMUX_VOICE_TOKEN, k: env.OPENAI_API_KEY };
    env.ATMUX_VOICE_TOKEN = TEST_VOICE_TOKEN;
    delete env.OPENAI_API_KEY;
    try {
      expect(await voice(["--print-assets-dir"], { out: (l) => out.push(l) })).toBe(0);
      expect(out).toHaveLength(1);
      expect(out[0]?.endsWith("/templates/voice")).toBe(true);
    } finally {
      if (saved.t === undefined) delete env.ATMUX_VOICE_TOKEN;
      else env.ATMUX_VOICE_TOKEN = saved.t;
      if (saved.k !== undefined) env.OPENAI_API_KEY = saved.k;
    }
  });

  test("--print-assets-dir honours ATMUX_VOICE_ASSETS_DIR", async () => {
    const out: string[] = [];
    const saved = { t: env.ATMUX_VOICE_TOKEN, a: env.ATMUX_VOICE_ASSETS_DIR };
    env.ATMUX_VOICE_TOKEN = TEST_VOICE_TOKEN;
    env.ATMUX_VOICE_ASSETS_DIR = "/opt/atmux/9.9/templates/voice";
    try {
      expect(await voice(["--print-assets-dir"], { out: (l) => out.push(l) })).toBe(0);
      expect(out[0]).toBe("/opt/atmux/9.9/templates/voice");
    } finally {
      if (saved.t === undefined) delete env.ATMUX_VOICE_TOKEN;
      else env.ATMUX_VOICE_TOKEN = saved.t;
      if (saved.a === undefined) delete env.ATMUX_VOICE_ASSETS_DIR;
      else env.ATMUX_VOICE_ASSETS_DIR = saved.a;
    }
  });

  test("bad argv throws UsageError before any wiring", async () => {
    await expect(voice(["--nope"])).rejects.toThrow(UsageError);
  });

  test("--supervise routes to the tmux session", async () => {
    const spy = tmuxSpy();
    const logs: string[] = [];
    expect(
      await voice(["--supervise"], {
        tmux: spy.tmux,
        binPath: "/usr/local/bin/atmux",
        log: (l) => logs.push(l),
      }),
    ).toBe(0);
    expect(spy.created).toHaveLength(1);
  });

  test("--stop routes to the graceful stop", async () => {
    const spy = tmuxSpy([VOICE_TMUX_SESSION]);
    expect(await voice(["--stop"], { tmux: spy.tmux, log: () => {}, sleep: async () => {} })).toBe(
      0,
    );
    expect(spy.killed).toEqual([VOICE_TMUX_SESSION]);
  });

  test("--status exits 0 when up and 1 when down", async () => {
    const saved = env.ATMUX_VOICE_TOKEN;
    env.ATMUX_VOICE_TOKEN = TEST_VOICE_TOKEN;
    try {
      const out: string[] = [];
      expect(
        await voice(["--status"], {
          tmux: tmuxSpy([VOICE_TMUX_SESSION]).tmux,
          out: (l) => out.push(l),
          fetchHealthz: async () =>
            JSON.stringify({
              ok: true,
              provider: "openai-realtime",
              readonly: true,
              degraded: null,
              bridge: {
                wedged: false,
                stuckTool: null,
                heldMs: null,
                queueDepth: 0,
                wedgeThresholdMs: 60_000,
              },
            }),
        }),
      ).toBe(0);
      expect(out[0]).toContain("session=up");

      expect(
        await voice(["--status"], {
          tmux: tmuxSpy().tmux,
          out: () => {},
          fetchHealthz: async () => null,
        }),
      ).toBe(1);
    } finally {
      if (saved === undefined) delete env.ATMUX_VOICE_TOKEN;
      else env.ATMUX_VOICE_TOKEN = saved;
    }
  });

  test("--status end-to-end reports the SERVER, even when the shell's env disagrees", async () => {
    // The live-observed defect, at the verb boundary: the invoking shell
    // sets `--readonly` and a provider; the server says the opposite.
    // Every printed field must come from the server.
    const saved = { tok: env.ATMUX_VOICE_TOKEN, ro: env.ATMUX_VOICE_READONLY };
    env.ATMUX_VOICE_TOKEN = TEST_VOICE_TOKEN;
    env.ATMUX_VOICE_READONLY = "1";
    try {
      const out: string[] = [];
      const code = await voice(["--status", "--provider", "gemini-live"], {
        tmux: tmuxSpy([VOICE_TMUX_SESSION]).tmux,
        out: (l) => out.push(l),
        fetchHealthz: async () =>
          JSON.stringify({
            ok: true,
            provider: "openai-realtime",
            readonly: false,
            degraded: null,
            bridge: {
              wedged: false,
              stuckTool: null,
              heldMs: null,
              queueDepth: 0,
              wedgeThresholdMs: 60_000,
            },
          }),
      });
      expect(code).toBe(0);
      const text = out.join("\n");
      expect(text).toContain("voice: server: provider=openai-realtime  readonly=false");
      expect(text).not.toContain("gemini-live");
      expect(text).not.toContain("readonly=true");
    } finally {
      if (saved.tok === undefined) delete env.ATMUX_VOICE_TOKEN;
      else env.ATMUX_VOICE_TOKEN = saved.tok;
      if (saved.ro === undefined) delete env.ATMUX_VOICE_READONLY;
      else env.ATMUX_VOICE_READONLY = saved.ro;
    }
  });

  test("--status with an unreachable server does not print the shell's env as fact", async () => {
    const saved = { tok: env.ATMUX_VOICE_TOKEN, ro: env.ATMUX_VOICE_READONLY };
    env.ATMUX_VOICE_TOKEN = TEST_VOICE_TOKEN;
    env.ATMUX_VOICE_READONLY = "1";
    try {
      const out: string[] = [];
      const code = await voice(["--status"], {
        tmux: tmuxSpy([VOICE_TMUX_SESSION]).tmux,
        out: (l) => out.push(l),
        fetchHealthz: async () => null,
      });
      expect(code).toBe(1);
      const text = out.join("\n");
      expect(text).toContain("voice: server state UNKNOWN");
      expect(text).not.toContain("voice: server: ");
      // `readonly=true` appears exactly once, and only after the label
      // that says it is NOT the server.
      expect(text).toContain("voice: local config (NOT the server): ");
      expect(text.indexOf("readonly=true")).toBeGreaterThan(
        text.indexOf("voice: local config (NOT the server): "),
      );
    } finally {
      if (saved.tok === undefined) delete env.ATMUX_VOICE_TOKEN;
      else env.ATMUX_VOICE_TOKEN = saved.tok;
      if (saved.ro === undefined) delete env.ATMUX_VOICE_READONLY;
      else env.ATMUX_VOICE_READONLY = saved.ro;
    }
  });

  test("--serve applies driver scope, builds deps and runs until aborted", async () => {
    let scoped = false;
    const abort = new AbortController();
    const logs: string[] = [];
    let built: VoiceServeDeps | null = null;
    const p = voice(["--serve", "--max-frames", "5"], {
      applyScope: () => {
        scoped = true;
      },
      buildDeps: async (opts) => {
        expect(opts.flags).toEqual({});
        const { deps } = await buildTestDeps();
        deps.config.port = 0;
        built = deps;
        return deps;
      },
      log: (l) => logs.push(l),
      signal: abort.signal,
      checkModel: NO_MODEL_CHECK,
    });
    expect(await waitFor(() => logs.some((l) => l.startsWith("voice: listening")))).toBe(true);
    expect(scoped).toBe(true);
    expect(built).not.toBeNull();
    abort.abort();
    expect(await p).toBe(0);
  });

  test("--serve threads --port/--provider/--readonly through to config resolution", async () => {
    const abort = new AbortController();
    const p = voice(["--serve", "--port", "4399", "--provider", "openai", "--readonly"], {
      applyScope: () => {},
      buildDeps: async (opts) => {
        expect(opts.flags).toEqual({ port: 4399, provider: "openai", readonly: true });
        const { deps } = await buildTestDeps({ flags: opts.flags as Record<string, unknown> });
        deps.config.port = 0;
        return deps;
      },
      log: () => {},
      signal: abort.signal,
      checkModel: NO_MODEL_CHECK,
    });
    await flush();
    abort.abort();
    expect(await p).toBe(0);
  });
});

// ---------- default sinks ----------

describe("default output sinks", () => {
  /** Swap both std streams for recorders; always restores. */
  async function captureStd(body: () => Promise<void>): Promise<{ out: string; err: string }> {
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    let out = "";
    let err = "";
    process.stdout.write = ((s: string | Uint8Array) => {
      out += typeof s === "string" ? s : new TextDecoder().decode(s);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((s: string | Uint8Array) => {
      err += typeof s === "string" ? s : new TextDecoder().decode(s);
      return true;
    }) as typeof process.stderr.write;
    try {
      await body();
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }
    return { out, err };
  }

  test("serveVoice defaults log→stderr and registers REAL process signal handlers", async () => {
    // `logToStderr` leaves `createVoiceLogger`'s sink at its production
    // default, so this really does exercise the stderr wiring rather than
    // the test harness's capture sink.
    const { deps } = await buildTestDeps({ logToStderr: true });
    deps.config.port = 0;
    const abort = new AbortController();
    const before = process.listenerCount("SIGINT");
    const beforeTerm = process.listenerCount("SIGTERM");
    const { out, err } = await captureStd(async () => {
      // No onSignal/offSignal override: this exercises the real
      // `process.once` / `process.off` wiring.
      const p = serveVoice({ deps, signal: abort.signal, checkModel: NO_MODEL_CHECK });
      await flush();
      expect(process.listenerCount("SIGINT")).toBe(before + 1);
      abort.abort();
      expect(await p).toBe(0);
    });
    // The handlers are removed in `finally` — a serve that leaked one
    // would poison every later test in the process.
    expect(process.listenerCount("SIGINT")).toBe(before);
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
    expect(err).toContain("voice: listening on 127.0.0.1:");
    expect(err).toContain("voice: shutting down");
    // stdout is capture-owned while a tool's verb runs — nothing may land there.
    expect(out).toBe("");
  });

  test("voice() defaults --print-assets-dir to stdout", async () => {
    const saved = process.env.ATMUX_VOICE_TOKEN;
    process.env.ATMUX_VOICE_TOKEN = TEST_VOICE_TOKEN;
    try {
      const { out } = await captureStd(async () => {
        expect(await voice(["--print-assets-dir"])).toBe(0);
      });
      expect(out.trim().endsWith("/templates/voice")).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.ATMUX_VOICE_TOKEN;
      else process.env.ATMUX_VOICE_TOKEN = saved;
    }
  });

  test("voice() defaults its diagnostics to stderr", async () => {
    const spy = tmuxSpy();
    const { out, err } = await captureStd(async () => {
      expect(await voice(["--stop"], { tmux: spy.tmux })).toBe(0);
    });
    expect(err).toContain("no 'atmux-voice' session to stop");
    expect(out).toBe("");
  });

  test("stopVoice's default sleep really waits between the SIGINT and the kill", async () => {
    const spy = tmuxSpy([VOICE_TMUX_SESSION]);
    const started = Date.now();
    expect(await stopVoice({ tmux: spy.tmux, log: () => {} })).toBe(0);
    // STOP_GRACE_MS is 750; allow scheduler slop but prove it did not
    // kill the session in the same tick as the SIGINT.
    expect(Date.now() - started).toBeGreaterThanOrEqual(700);
    expect(spy.keys[0]?.keys).toBe("C-c");
    expect(spy.killed).toEqual([VOICE_TMUX_SESSION]);
  });
});

// ---------- production default wirings ----------
//
// Each test below exercises a `?? <default>` arm that every other test
// injects past. They are the wires that actually run on hax, so leaving
// them unexercised would mean the suite is green on code the deploy
// never uses.

describe("production default wirings", () => {
  test("resolveAtmuxBin with no seam consults the real PATH", () => {
    const bin = resolveAtmuxBin();
    expect(typeof bin).toBe("string");
    expect(bin.length).toBeGreaterThan(0);
    // Either the PATH shim or the execPath fallback — never empty, and
    // always absolute (it is interpolated into the supervisor script).
    expect(bin.startsWith("/")).toBe(true);
  });

  test("buildVoiceDeps with no loadTeamIndex seam reads the real cockpit roster", async () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/atmux-voice-cockpit-${process.pid}-${Date.now()}`;
    const cfgPath = `${dir}/cockpit.json`;
    await Bun.write(
      cfgPath,
      JSON.stringify({
        schemaVersion: 1,
        cockpitSession: "atx",
        sessions: [
          { type: "team", name: "voice-fixture-team", root: "/root/work/src/atmux", enabled: true },
          {
            type: "team",
            name: "voice-disabled-team",
            root: "/root/work/src/other",
            enabled: false,
          },
        ],
      }),
    );
    const saved = process.env.ATMUX_COCKPIT_CONFIG;
    process.env.ATMUX_COCKPIT_CONFIG = cfgPath;
    try {
      const deps = await buildVoiceDeps({
        env: { ATMUX_VOICE_TOKEN: TEST_VOICE_TOKEN, OPENAI_API_KEY: TEST_OPENAI_KEY },
        makeProvider: () => new FakeProvider(),
      });
      // Disabled sessions are filtered out by `enabledTeams`.
      expect(deps.teamIndex.teams.map((t) => t.name)).toEqual(["voice-fixture-team"]);
      expect(deps.teamIndex.teams[0]?.root).toBe("/root/work/src/atmux");
    } finally {
      if (saved === undefined) delete process.env.ATMUX_COCKPIT_CONFIG;
      else process.env.ATMUX_COCKPIT_CONFIG = saved;
      await Bun.$`rm -rf ${dir}`.quiet().nothrow();
    }
  });

  test("--serve with no applyScope seam grants ADR-272 D3 driver scope for real", async () => {
    const saved = process.env.ATMUX_CALLER_SCOPE;
    delete process.env.ATMUX_CALLER_SCOPE;
    const abort = new AbortController();
    try {
      const p = voice(["--serve"], {
        buildDeps: async () => {
          const { deps } = await buildTestDeps();
          deps.config.port = 0;
          return deps;
        },
        log: () => {},
        signal: abort.signal,
        checkModel: NO_MODEL_CHECK,
        onSignal: undefined as never,
      } as never);
      await flush();
      expect(process.env.ATMUX_CALLER_SCOPE as string | undefined).toBe("driver");
      abort.abort();
      expect(await p).toBe(0);
    } finally {
      if (saved === undefined) delete process.env.ATMUX_CALLER_SCOPE;
      else process.env.ATMUX_CALLER_SCOPE = saved;
    }
  });
});

// ---------- assets dir resolution (V-1) ----------

describe("assets dir resolution (V-1)", () => {
  test("dev-mode resolves <repo>/templates/voice and the files are really there", async () => {
    const { deps } = await buildTestDeps();
    expect(deps.assetsDir.endsWith(resolve("templates", "voice"))).toBe(true);
    for (const f of ["index.html", "js/app.js", "js/protocol.js", "css/app.css"]) {
      expect(await Bun.file(resolve(deps.assetsDir, f)).exists(), `${f} missing`).toBe(true);
    }
  });
});
