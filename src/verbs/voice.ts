// ADR-272: voice operator interface — the `atmux voice` verb (P4).
//
// `atmux voice [--serve|--supervise|--status|--stop] [flags]`
//
// This is the ONE place the voice feature is wired: config → provider
// kind → API key → team index → tool catalog → verb runners → bridge →
// registry → `Bun.serve`. Core (`src/core/voice/**`) never imports from
// `src/verbs/**`; the verb functions the tool bridge invokes are
// LAZY-imported here and injected downward (ADR-272 §D2).
//
// Boot discipline, in order:
//   1. `resolveVoiceConfig` — refuses without `ATMUX_VOICE_TOKEN` (≥32
//      chars) BEFORE anything binds a port (ADR-272 §Security layer 2).
//   2. `parseProviderKind` + API-key selection — a missing
//      `OPENAI_API_KEY` / `GEMINI_API_KEY` is a `ConfigError` at boot,
//      not a spoken error on the first tool call. Fail closed, early.
//   3. `ATMUX_CALLER_SCOPE=driver` — the D3 privilege grant, applied
//      once at serve time. Whoever reaches the socket IS the driver.
//   4. AFTER the listener binds: the model-pin drift check
//      (`runModelPinCheck`, ADR-272 §Supplement). Deliberately NOT
//      fail-closed like steps 1–2 — a bad model id and an unreachable
//      provider are different faults, and refusing to boot on the second
//      would make an egress hiccup take voice down entirely. It warns
//      loudly and serves.
//
// Logging discipline: EVERY line this verb emits about the running
// server goes to `process.stderr`. `process.stdout` is capture-owned
// while a tool's verb runs (`src/core/verb-capture.ts`), so a stray
// `console.log` here would land inside a spoken tool result. The two
// exceptions are `--print-assets-dir` and `--status`, which are
// one-shot reads that exit before any capture exists.
//
// Secrets: the startup banner prints host, port, provider, model,
// readonly and the assets dir — never the token, never an API key
// (ADR-272 §Security; the `ready`-frame key-set test pins the same
// property on the wire). Beyond the banner, `buildVoiceDeps` builds
// `deps.log` through `createVoiceLogger` with the API key and the voice
// token as known secrets, and EVERY server-side diagnostic line —
// including the per-session provider-dial lines — goes through it. The
// redaction is therefore structural rather than a discipline each
// callsite has to remember.

import { isReachable } from "../abstractions/http.ts";
import { createTmux, type TmuxNamespace } from "../abstractions/tmux.ts";
import { uuidv7 } from "../abstractions/uuidv7.ts";
import {
  createVoiceProvider,
  defaultModelFor,
  parseProviderKind,
} from "../abstractions/voice/factory.ts";
import type {
  VoiceProvider,
  VoiceProviderConfig,
  VoiceProviderKind,
} from "../abstractions/voice-provider.ts";
import { createVerbMutex, type VerbFn } from "../core/verb-capture.ts";
import { resolveVoiceAsset } from "../core/voice/assets.ts";
import { authorizeUpgrade } from "../core/voice/auth.ts";
import { resolveVoiceConfig, type VoiceConfig, type VoiceFlags } from "../core/voice/config.ts";
import { createConfirmStore } from "../core/voice/confirm.ts";
import { createVoiceLogger, type VoiceLog } from "../core/voice/log.ts";
import {
  checkModelPin,
  formatModelCheck,
  type ModelCheckDeps,
  type ModelCheckResult,
} from "../core/voice/model-check.ts";
import {
  createVoiceSession,
  createVoiceSharedState,
  type PhoneLeg,
  type VoiceServerSession,
  type VoiceSharedState,
  type VoiceTimers,
} from "../core/voice/session.ts";
import { buildTeamIndex, type VoiceTeamIndex } from "../core/voice/team-context.ts";
import { createToolBridge, type ToolBridge } from "../core/voice/tool-bridge.ts";
import {
  VOICE_TOOL_CATALOG,
  type VoiceRunnerKey,
  type VoiceToolEntry,
} from "../core/voice/tool-catalog.ts";
import { ConfigError, UsageError } from "../errors.ts";
import { VOICE_CLOSE } from "../schema/voice.ts";

const USAGE =
  "atmux voice [--serve|--supervise|--status|--stop] [--port <n>] [--provider <p>] [--model <m>] [--readonly] [--max-frames <n>] [--print-assets-dir]\n" +
  "  env: ATMUX_VOICE_BIN=<path>  — the atmux binary --supervise re-execs (default: the one on PATH)";

/** Detached tmux session `--supervise` owns (ADR-272 §D10). */
export const VOICE_TMUX_SESSION = "atmux-voice";
/**
 * The OPERATOR'S DEFAULT tmux socket — literally named `default` by tmux
 * itself. `createTmux({ socket })` emits `-L <name>`, which makes the
 * selection independent of an inherited `$TMUX`; passing `"default"`
 * therefore lands on the same socket a bare `tmux` uses, NOT on a cage
 * socket (`atmux-<team>`, path-explicit) and NOT on the cockpit socket
 * (`atmux-cockpit`). ADR-272 §D10 name-collision check.
 */
export const VOICE_TMUX_SOCKET = "default";
/** Crash-loop backoff between restarts (s). */
export const SUPERVISE_BACKOFF_SEC = 5;
/** Circuit breaker: this many restarts inside the window stops respawning. */
export const SUPERVISE_BREAKER_RESTARTS = 5;
/** Circuit-breaker window (s). */
export const SUPERVISE_BREAKER_WINDOW_SEC = 60;
/** Grace between the SIGINT and the `kill-session` in `--stop` (ms). */
export const STOP_GRACE_MS = 750;

// ---------- Args ----------

export type VoiceAction = "serve" | "supervise" | "status" | "stop" | "print-assets-dir";

export interface VoiceArgs {
  action: VoiceAction;
  port?: number;
  provider?: string;
  model?: string;
  readonly?: boolean;
  /** Serve exits 0 after this many binary phone frames (probe/e2e bound). */
  maxFrames?: number;
}

const ACTION_FLAGS: Readonly<Record<string, VoiceAction>> = Object.freeze({
  "--serve": "serve",
  "--supervise": "supervise",
  "--status": "status",
  "--stop": "stop",
  "--print-assets-dir": "print-assets-dir",
});

function requireValue(argv: ReadonlyArray<string>, i: number, flag: string): string {
  const v = argv[i + 1];
  if (v === undefined) {
    throw new UsageError({ what: `voice: ${flag} requires a value`, hint: USAGE });
  }
  return v;
}

function positiveInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new UsageError({
      what: `voice: ${flag} must be a positive integer, got '${raw}'`,
      hint: USAGE,
    });
  }
  return n;
}

/**
 * Pure argv parser. Default action is `serve`. Two action flags in one
 * invocation is a `UsageError` — silently honouring the last one would
 * make `--status --stop` do something the operator did not ask for.
 */
export function parseVoiceArgs(argv: ReadonlyArray<string>): VoiceArgs {
  let action: VoiceAction | undefined;
  let port: number | undefined;
  let provider: string | undefined;
  let model: string | undefined;
  let readonlyFlag: boolean | undefined;
  let maxFrames: number | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i] ?? "";
    const asAction = Object.hasOwn(ACTION_FLAGS, a) ? ACTION_FLAGS[a] : undefined;
    if (asAction !== undefined) {
      if (action !== undefined && action !== asAction) {
        throw new UsageError({
          what: `voice: conflicting actions — '${action}' and '${asAction}'`,
          hint: USAGE,
        });
      }
      action = asAction;
      i += 1;
      continue;
    }
    if (a === "--port") {
      port = positiveInt(requireValue(argv, i, "--port"), "--port");
      i += 2;
      continue;
    }
    if (a === "--provider") {
      provider = requireValue(argv, i, "--provider");
      i += 2;
      continue;
    }
    if (a === "--model") {
      model = requireValue(argv, i, "--model");
      i += 2;
      continue;
    }
    if (a === "--readonly") {
      readonlyFlag = true;
      i += 1;
      continue;
    }
    if (a === "--max-frames") {
      maxFrames = positiveInt(requireValue(argv, i, "--max-frames"), "--max-frames");
      i += 2;
      continue;
    }
    throw new UsageError({ what: `voice: unknown arg: ${a}`, hint: USAGE });
  }
  const out: VoiceArgs = { action: action ?? "serve" };
  if (port !== undefined) out.port = port;
  if (provider !== undefined) out.provider = provider;
  if (model !== undefined) out.model = model;
  if (readonlyFlag !== undefined) out.readonly = readonlyFlag;
  if (maxFrames !== undefined) out.maxFrames = maxFrames;
  return out;
}

/** `VoiceArgs` → the `Partial<VoiceFlags>` config resolution accepts. */
export function voiceArgsToFlags(args: VoiceArgs): Partial<VoiceFlags> {
  const flags: Partial<VoiceFlags> = {};
  if (args.port !== undefined) flags.port = args.port;
  if (args.provider !== undefined) flags.provider = args.provider;
  if (args.model !== undefined) flags.model = args.model;
  if (args.readonly === true) flags.readonly = true;
  return flags;
}

// ---------- Verb runners (lazy, per ADR-272 §D2) ----------

/** Lazy importer per runner key — the module map in `tool-catalog.ts`'s
 *  header, made executable. Dynamic so `src/verbs/**` is only loaded when
 *  a tool actually fires, and so core stays free of verb imports. */
export const VOICE_RUNNER_IMPORTERS: Readonly<Record<VoiceRunnerKey, () => Promise<VerbFn>>> =
  Object.freeze({
    topo: async () => (await import("./topo.ts")).topo,
    fleet: async () => (await import("./fleet.ts")).fleet,
    status: async () => (await import("./status.ts")).status,
    health: async () => (await import("./health.ts")).health,
    task: async () => (await import("./task.ts")).task,
    paneState: async () => (await import("./pane-state.ts")).paneState,
    driverInbox: async () => (await import("./driver-inbox.ts")).driverInbox,
    outbox: async () => (await import("./reply.ts")).outbox,
    cost: async () => (await import("./cost.ts")).cost,
    blockers: async () => (await import("./blockers.ts")).blockers,
    tellLead: async () => (await import("./tell-lead.ts")).tellLead,
    dispatch: async () => (await import("./dispatch.ts")).dispatch,
    claim: async () => (await import("./claim.ts")).claim,
    nudge: async () => (await import("./nudge.ts")).nudge,
  });

/**
 * Wrap every importer in a memoizing runner. The first call to a tool
 * pays the import; later calls reuse the resolved function. A failed
 * import is NOT cached — a transient module error should not poison the
 * runner for the rest of the session.
 */
export function makeLazyRunners(
  importers: Readonly<Record<VoiceRunnerKey, () => Promise<VerbFn>>> = VOICE_RUNNER_IMPORTERS,
): Record<VoiceRunnerKey, VerbFn> {
  const cache = new Map<VoiceRunnerKey, VerbFn>();
  const out = {} as Record<VoiceRunnerKey, VerbFn>;
  for (const key of Object.keys(importers) as VoiceRunnerKey[]) {
    out[key] = async (args: ReadonlyArray<string>): Promise<number> => {
      let fn = cache.get(key);
      if (fn === undefined) {
        fn = await importers[key]();
        cache.set(key, fn);
      }
      return await fn(args);
    };
  }
  return out;
}

// ---------- Boot wiring ----------

/** Which env var carries the API key for a provider kind. */
export function apiKeyEnvVarFor(kind: VoiceProviderKind): "OPENAI_API_KEY" | "GEMINI_API_KEY" {
  return kind === "openai-realtime" ? "OPENAI_API_KEY" : "GEMINI_API_KEY";
}

/**
 * Select the provider API key, failing CLOSED before anything binds a
 * port. The hint names the dotfiles env rather than the value — this
 * message reaches logs and tmux panes.
 */
export function requireApiKey(kind: VoiceProviderKind, env: NodeJS.ProcessEnv): string {
  const varName = apiKeyEnvVarFor(kind);
  const key = env[varName];
  if (key === undefined || key === "") {
    throw new ConfigError({
      what: `${varName} is required for provider '${kind}' — the voice server refuses to start without it`,
      hint: "source it from the git-crypt'd dotfiles env (~/work/journals/.sb/_dotfiles; inventory keys/KEYS.md). Never pass it on argv — tmux pane capture records command lines",
    });
  }
  return key;
}

/**
 * Readonly filter (ADR-272 §Security layer 5): mutating tools are ABSENT
 * from the catalog the model receives, not refused at call time. A tool
 * the model cannot see is a tool it cannot hallucinate having.
 */
export function visibleCatalog(readonly: boolean): VoiceToolEntry[] {
  return VOICE_TOOL_CATALOG.filter((e) => !readonly || !e.mutating);
}

/** Everything one `Bun.serve` instance needs. Every field override-able. */
export interface VoiceServeDeps {
  config: VoiceConfig;
  provider: VoiceProvider;
  providerCfg: VoiceProviderConfig;
  bridge: ToolBridge;
  shared: VoiceSharedState;
  catalog: VoiceToolEntry[];
  teamIndex: VoiceTeamIndex;
  clock: () => number;
  timers: VoiceTimers;
  uuid: () => string;
  assetsDir: string;
  /** Redacting stderr diagnostics sink — see the module header. Every
   *  running-server line (banner, dial story, shutdown) goes through it. */
  log: VoiceLog;
}

export interface BuildVoiceDepsOpts {
  env?: NodeJS.ProcessEnv;
  flags?: Partial<VoiceFlags>;
  /** Test seams — every one defaults to the production wiring. */
  loadTeamIndex?: () => Promise<VoiceTeamIndex>;
  makeProvider?: (kind: VoiceProviderKind) => VoiceProvider;
  runners?: Partial<Record<VoiceRunnerKey, VerbFn>>;
  clock?: () => number;
  timers?: VoiceTimers;
  uuid?: () => string;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Raw byte sink under the redactor (default: `process.stderr`).
   *
   * Deliberately NOT a `log?: (line) => void` seam: a test that could
   * inject a whole logger could inject one that does not redact, and the
   * redaction test would then prove nothing about production. Tests get
   * the sink; the redactor is always in the path.
   */
  logWrite?: (chunk: string) => void;
}

const realTimers: VoiceTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => {
    clearTimeout(h as ReturnType<typeof setTimeout>);
  },
};

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve the PWA assets dir — explicit override, else the templates
 *  resolver's `voice` subdir (dev vs `$bunfs`-compiled; V-1 checks both). */
export function resolveVoiceAssetsDir(config: VoiceConfig): string {
  // `resolveVoiceAsset` owns the default-dir computation; ask it for a
  // route we know exists and strip the filename back off, so there is
  // exactly ONE place the default is derived.
  const probe = resolveVoiceAsset("/index.html", getAssetsDirOpts(config));
  // `/index.html` is a literal key of the frozen VOICE_ROUTES map, so
  // this is non-null by construction.
  const filePath = (probe as { filePath: string }).filePath;
  return filePath.slice(0, filePath.length - "/index.html".length);
}

function getAssetsDirOpts(config: VoiceConfig): { assetsDir?: string } {
  return config.assetsDir !== undefined ? { assetsDir: config.assetsDir } : {};
}

/** Build the full serve dependency graph. See the module header for the
 *  fail-closed boot order. */
export async function buildVoiceDeps(opts: BuildVoiceDepsOpts = {}): Promise<VoiceServeDeps> {
  const env = opts.env ?? process.env;
  const config = resolveVoiceConfig(env, opts.flags);

  const kind = parseProviderKind(config.provider);
  const apiKey = requireApiKey(kind, env);
  const makeProvider = opts.makeProvider ?? createVoiceProvider;
  const provider = makeProvider(kind);
  const providerCfg: VoiceProviderConfig = {
    apiKey,
    model: config.model ?? defaultModelFor(kind),
  };

  const teamIndex = await (opts.loadTeamIndex ?? (() => buildTeamIndex()))();
  const clock = opts.clock ?? ((): number => Date.now());
  const timers = opts.timers ?? realTimers;
  const catalog = visibleCatalog(config.readonly);

  const bridge = createToolBridge({
    catalog,
    runners: opts.runners ?? makeLazyRunners(),
    teamIndex,
    confirmStore: createConfirmStore({ clock, ttlMs: config.confirmTtlMs }),
    // Same `clock` the bridge's `health()` compares `heldSince` against —
    // two different clocks would make the held-duration meaningless.
    mutex: createVerbMutex({ clock }),
    config: {
      readonly: config.readonly,
      toolTimeoutMs: config.toolTimeoutMs,
      maxResultChars: config.maxResultChars,
    },
    clock,
    sleep: opts.sleep ?? realSleep,
  });

  return {
    config,
    provider,
    providerCfg,
    bridge,
    shared: createVoiceSharedState({ clock, graceMs: config.resumeGraceMs }),
    catalog,
    teamIndex,
    clock,
    timers,
    uuid: opts.uuid ?? ((): string => uuidv7()),
    assetsDir: resolveVoiceAssetsDir(config),
    log: createVoiceLogger({
      // Both secrets the server holds. `createVoiceLogger` also applies
      // shape-based patterns for credentials it was never told about.
      secrets: [apiKey, config.token],
      ...(opts.logWrite !== undefined ? { write: opts.logWrite } : {}),
    }),
  };
}

/** Apply the ADR-272 §D3 privilege grant. Separated from `buildVoiceDeps`
 *  so a test can build deps without mutating the ambient environment. */
export function applyDriverScope(env: NodeJS.ProcessEnv = process.env): void {
  env.ATMUX_CALLER_SCOPE = "driver";
}

// ---------- HTTP + WebSocket server ----------

/** Per-connection socket data. The session is created in `open`, which
 *  is the first point a `PhoneLeg` can be adapted onto the socket. */
export interface VoiceConnData {
  session: VoiceServerSession | null;
}

/** The slice of Bun's `ServerWebSocket` this module touches. */
export interface MinimalServerWebSocket {
  data: VoiceConnData;
  send(data: string | Uint8Array): number;
  close(code?: number, reason?: string): void;
  getBufferedAmount(): number;
}

/** Adapt a Bun `ServerWebSocket` onto the session's transport seam. */
export function phoneLegFor(ws: MinimalServerWebSocket): PhoneLeg {
  return {
    send: (text: string): void => {
      ws.send(text);
    },
    sendBinary: (b: Uint8Array): void => {
      ws.send(b);
    },
    close: (code: number, reason: string): void => {
      ws.close(code, reason);
    },
    bufferedAmount: (): number => ws.getBufferedAmount(),
  };
}

/** Machine-readable degradation reasons. One member today; a union so a
 *  later reason lands as a new value rather than a reshaped field. */
export type VoiceDegradedReason = "tool-bridge-wedged";

export interface VoiceHealthzBody {
  /** False whenever the service cannot actually do its job. */
  ok: boolean;
  provider: string;
  readonly: boolean;
  /** Why `ok` is false, or null when healthy. */
  degraded: VoiceDegradedReason | null;
  /** The verb-execution lane behind the tool bridge. */
  bridge: {
    wedged: boolean;
    /** Which tool's verb is stuck — the actionable half of the signal. */
    stuckTool: string | null;
    heldMs: number | null;
    queueDepth: number;
    wedgeThresholdMs: number;
  };
}

/**
 * Body of the `/healthz` response — open by design (nginx exposes it).
 *
 * `ok` used to be the literal `true`, which meant the probe answered
 * green while the tool bridge was wedged and every voice tool call had
 * been failing for minutes. Voice runs unattended in a detached tmux
 * session; a health check that lies is worse than none, because whatever
 * reads it stops looking. `ok` now tracks the one condition that makes
 * the service functionally dead.
 *
 * Shape discipline: `ok` / `provider` / `readonly` keep their meaning and
 * position, so an existing reader does not break; `degraded` and `bridge`
 * are ADDED. The HTTP status stays **200** — `isReachable` (which
 * `--status` uses) treats a non-2xx as "unreachable", and a wedged server
 * that is still listening and still answering is a different fault from
 * one that is gone. The body carries the verdict; the status carries
 * reachability.
 */
export function healthzBody(deps: VoiceServeDeps): VoiceHealthzBody {
  const bridge = deps.bridge.health();
  return {
    ok: !bridge.wedged,
    provider: deps.provider.kind,
    readonly: deps.config.readonly,
    degraded: bridge.wedged ? "tool-bridge-wedged" : null,
    bridge: {
      wedged: bridge.wedged,
      stuckTool: bridge.stuckTool,
      heldMs: bridge.heldMs,
      queueDepth: bridge.queueDepth,
      wedgeThresholdMs: bridge.wedgeThresholdMs,
    },
  };
}

/** The upgrade-refusal response. WS close codes apply POST-upgrade only,
 *  so a pre-upgrade refusal is plain HTTP: 403 origin, 401 token. */
export function upgradeRefusal(closeCode: 4401 | 4403): Response {
  return closeCode === VOICE_CLOSE.ORIGIN
    ? new Response("forbidden origin\n", { status: 403 })
    : new Response("unauthorized\n", { status: 401 });
}

/** Minimal `Bun.serve` server surface used by the fetch handler. */
export interface UpgradableServer {
  upgrade(req: Request, opts: { data: VoiceConnData }): boolean;
}

/**
 * Build the HTTP fetch handler. Returns `undefined` when the request was
 * consumed by a successful WebSocket upgrade (Bun's contract).
 *
 * Route table:
 *   `/healthz` → 200 JSON, NO auth (nginx exposes it for probes)
 *   `/ws`      → authorize, then upgrade
 *   asset route → file from the resolved assets dir, pinned mime + cache
 *   anything else → 404 (including every traversal attempt — the route
 *   map is an exact-key lookup with no filesystem surface, so
 *   `/../etc/passwd` is simply not a key)
 */
export function buildFetchHandler(
  deps: VoiceServeDeps,
): (req: Request, server: UpgradableServer) => Promise<Response | undefined> {
  return async (req, server) => {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") {
      return Response.json(healthzBody(deps));
    }
    if (url.pathname === "/ws") {
      const verdict = authorizeUpgrade({
        headers: req.headers,
        url,
        expectedToken: deps.config.token,
        origins: deps.config.origins,
      });
      if (!verdict.ok) return upgradeRefusal(verdict.closeCode);
      const upgraded = server.upgrade(req, { data: { session: null } });
      if (upgraded) return undefined;
      return new Response("websocket upgrade failed\n", { status: 400 });
    }
    const asset = resolveVoiceAsset(url.pathname, getAssetsDirOpts(deps.config));
    if (asset === null) return new Response("not found\n", { status: 404 });
    const file = Bun.file(asset.filePath);
    if (!(await file.exists())) return new Response("not found\n", { status: 404 });
    return new Response(file, {
      headers: { "Content-Type": asset.mime, "Cache-Control": asset.cacheControl },
    });
  };
}

export interface VoiceServerHandle {
  readonly port: number;
  readonly hostname: string;
  /** Resolves with the exit code once the server is fully stopped. */
  readonly done: Promise<number>;
  stop(): void;
}

export interface StartVoiceServerOpts {
  deps: VoiceServeDeps;
  /** Exit 0 after this many binary phone frames are processed. */
  maxFrames?: number;
  /** Diagnostics-sink override. Defaults to `deps.log` (the redacting
   *  stderr logger) — NOT to a no-op: a silent server is the exact
   *  failure this logging exists to prevent. */
  log?: (line: string) => void;
}

/**
 * Start the voice server. One `VoiceServerSession` per connection, all
 * sharing the single `VoiceSharedState` (the latest-wins registry lives
 * there — ADR-272 §D8).
 */
export function startVoiceServer(opts: StartVoiceServerOpts): VoiceServerHandle {
  const { deps } = opts;
  const log = opts.log ?? deps.log;
  const fetchHandler = buildFetchHandler(deps);
  const { promise: done, resolve: finish } = Promise.withResolvers<number>();
  let binaryFrames = 0;
  let stopped = false;

  const server = Bun.serve<VoiceConnData>({
    hostname: deps.config.host,
    port: deps.config.port,
    fetch: (req, srv) => fetchHandler(req, srv as unknown as UpgradableServer),
    websocket: {
      open(ws): void {
        ws.data.session = createVoiceSession({
          phone: phoneLegFor(ws as unknown as MinimalServerWebSocket),
          provider: deps.provider,
          providerCfg: deps.providerCfg,
          bridge: deps.bridge,
          shared: deps.shared,
          config: deps.config,
          catalog: deps.catalog,
          teamIndex: deps.teamIndex,
          clock: deps.clock,
          timers: deps.timers,
          uuid: deps.uuid,
          log,
        });
      },
      async message(ws, message): Promise<void> {
        const session = ws.data.session;
        if (session === null) return;
        // Bun delivers a binary WS message as a `Buffer`, which IS a
        // `Uint8Array` — pass it through zero-copy. `decodeFrame` reads
        // via `byteOffset`/`byteLength`, so a pooled Buffer is safe.
        const isBinary = typeof message !== "string";
        await session.handlePhoneMessage(isBinary ? (message as Uint8Array) : message);
        if (!isBinary) return;
        binaryFrames += 1;
        if (opts.maxFrames !== undefined && binaryFrames >= opts.maxFrames) {
          log(`voice: --max-frames ${opts.maxFrames} reached — stopping`);
          stopServer(0);
        }
      },
      close(ws, code): void {
        ws.data.session?.handlePhoneClose(code);
      },
    },
  });

  function stopServer(code: number): void {
    if (stopped) return;
    stopped = true;
    server.stop(true);
    finish(code);
  }

  return {
    // `Bun.serve` types both as optional (a unix-socket server has
    // neither); a TCP listener always reports them, so fall back to the
    // configured values rather than widening the handle's contract.
    port: server.port ?? deps.config.port,
    hostname: server.hostname ?? deps.config.host,
    done,
    stop: (): void => {
      stopServer(0);
    },
  };
}

export interface ServeVoiceOpts extends StartVoiceServerOpts {
  /** External cancellation (tests + the `--stop` path in-process). */
  signal?: AbortSignal;
  /** Signal-handler registration seam. */
  onSignal?: (name: "SIGINT" | "SIGTERM", handler: () => void) => void;
  offSignal?: (name: "SIGINT" | "SIGTERM", handler: () => void) => void;
  /** Model-pin drift check seam (ADR-272 §Supplement). Defaults to the
   *  real one; tests inject so the unit suite never dials a provider. */
  checkModel?: (deps: ModelCheckDeps) => Promise<ModelCheckResult>;
}

/**
 * Run the model-pin drift check and log its verdict. ADR-272 §Supplement.
 *
 * **Never throws, never blocks the boot.** The whole point is to turn a
 * mystifying 4500-after-68-seconds into a loud line at startup; a check
 * that could itself refuse the boot would trade a rare loud problem for a
 * common total one (an egress hiccup would stop the server starting).
 * Even an internal bug in the checker degrades to one line here.
 *
 * The API key reaches it as an argument and never reaches a message: it
 * rides an auth HEADER in `model-catalog.ts`, nothing formats it, and
 * `log` is the redacting `createVoiceLogger` on top of that.
 */
export async function runModelPinCheck(
  deps: VoiceServeDeps,
  log: (line: string) => void,
  check: (d: ModelCheckDeps) => Promise<ModelCheckResult> = checkModelPin,
): Promise<void> {
  try {
    const result = await check({
      kind: deps.provider.kind,
      model: deps.providerCfg.model,
      apiKey: deps.providerCfg.apiKey,
    });
    for (const line of formatModelCheck(result)) log(line);
  } catch (e) {
    log(`voice: model check itself failed (${e instanceof Error ? e.message : String(e)})`);
  }
}

/** Startup banner — host/port/provider/model/readonly/assets. NEVER the
 *  token or an API key (ADR-272 §Security). */
export function startupBanner(deps: VoiceServeDeps, handle: VoiceServerHandle): string {
  return [
    `voice: listening on ${handle.hostname}:${handle.port}`,
    `provider=${deps.provider.kind}`,
    `model=${deps.providerCfg.model}`,
    `readonly=${deps.config.readonly}`,
    `assets=${deps.assetsDir}`,
  ].join("  ");
}

/**
 * `--serve`: bind, announce, and run until SIGINT / SIGTERM / abort /
 * the `--max-frames` budget. Graceful teardown closes live phone sockets
 * (which parks or releases each session's provider leg through the
 * normal close path) before the listener stops.
 */
export async function serveVoice(opts: ServeVoiceOpts): Promise<number> {
  const log = opts.log ?? opts.deps.log;
  const handle = startVoiceServer({ ...opts, log });
  log(startupBanner(opts.deps, handle));
  // AFTER the listener is up, so a slow provider never delays binding —
  // and awaited, so its verdict lands next to the banner rather than
  // interleaved with the first session's dial story.
  await runModelPinCheck(opts.deps, log, opts.checkModel ?? checkModelPin);

  const on =
    opts.onSignal ??
    ((name, h): void => {
      process.once(name, h);
    });
  const off =
    opts.offSignal ??
    ((name, h): void => {
      process.off(name, h);
    });
  const shutdown = (): void => {
    log("voice: shutting down");
    handle.stop();
  };
  on("SIGINT", shutdown);
  on("SIGTERM", shutdown);
  opts.signal?.addEventListener("abort", shutdown, { once: true });
  try {
    return await handle.done;
  } finally {
    off("SIGINT", shutdown);
    off("SIGTERM", shutdown);
  }
}

// ---------- Supervise / status / stop ----------

/** Resolve the `atmux` binary the supervisor re-execs. `Bun.which` finds
 *  the installed shim; `process.execPath` is the compiled-binary
 *  fallback (where argv[0] IS atmux). */
export function resolveAtmuxBin(deps?: {
  which?: (cmd: string) => string | null;
  execPath?: string;
}): string {
  const which = deps?.which ?? ((cmd: string): string | null => Bun.which(cmd));
  const found = which("atmux");
  if (found !== null && found.length > 0) return found;
  return deps?.execPath ?? process.execPath;
}

/**
 * The `atmux` binary `--supervise`'s crash-loop wrapper re-execs, with
 * `ATMUX_VOICE_BIN` as the operator override.
 *
 * Why the override has to exist. `resolveAtmuxBin` finds whatever is on
 * `PATH`, which on this box is `/usr/local/bin/atmux` →
 * `/opt/atmux/0.8.30` — an INSTALLED release that predates the `voice`
 * verb. `--supervise` therefore starts a wrapper that runs
 * `/opt/atmux/0.8.30 voice --serve`, gets `unknown verb: voice` and exit
 * 64, and loops: observed live going restart 1/5 → 3/5 before the
 * circuit breaker (correctly) stopped it.
 *
 * The obvious fix — `bun run build:install` — swaps the atmux CLI
 * FLEET-WIDE for every team on the box, which is a release, not a
 * supervision detail. Exposing the already-existing internal `binPath`
 * override as an env var keeps a repo-checkout deploy first-class:
 *
 *     ATMUX_VOICE_BIN=$PWD/bin/atmux-bun atmux voice --supervise
 *
 * Precedence: explicit per-call override > `ATMUX_VOICE_BIN` >
 * {@link resolveAtmuxBin}. Both override layers FAIL CLOSED — an empty or
 * whitespace-only value falls through to the next layer rather than
 * producing a wrapper that execs `'' voice --serve`. This mirrors the
 * `resolveVoiceConfig` / `resolveGitTimeoutMs` posture: a fat-fingered
 * export degrades to the current behaviour, never to a broken one.
 */
export function resolveSuperviseBin(opts: {
  override?: string;
  env?: NodeJS.ProcessEnv;
  resolve?: () => string;
}): string {
  const override = opts.override;
  if (override !== undefined && override.trim().length > 0) return override;
  const fromEnv = (opts.env ?? process.env).ATMUX_VOICE_BIN;
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv;
  return (opts.resolve ?? resolveAtmuxBin)();
}

/**
 * The crash-loop wrapper `--supervise` runs as the tmux session's
 * command (ADR-272 §D10): re-exec with a 5s backoff and a circuit
 * breaker at 5 restarts inside 60s. When the breaker trips it STOPS
 * respawning and drops to a shell, so the real error stays readable in
 * the pane instead of scrolling past in a restart loop.
 */
export function buildCrashLoopScript(binPath: string): string {
  const bin = shellQuote(binPath);
  return [
    "set -u",
    "trap 'exit 0' INT TERM",
    "restarts=0",
    "window_start=$(date +%s)",
    "while :; do",
    `  ${bin} voice --serve`,
    "  code=$?",
    "  now=$(date +%s)",
    `  if [ $(( now - window_start )) -ge ${SUPERVISE_BREAKER_WINDOW_SEC} ]; then`,
    "    restarts=0",
    "    window_start=$now",
    "  fi",
    "  restarts=$(( restarts + 1 ))",
    `  if [ "$restarts" -ge ${SUPERVISE_BREAKER_RESTARTS} ]; then`,
    `    echo "atmux voice: circuit breaker tripped — ${SUPERVISE_BREAKER_RESTARTS} restarts within ${SUPERVISE_BREAKER_WINDOW_SEC}s; last exit $code" >&2`,
    '    echo "atmux voice: NOT respawning. Fix the cause above, then: atmux voice --supervise" >&2',
    "    break",
    "  fi",
    `  echo "atmux voice: exited $code — restarting in ${SUPERVISE_BACKOFF_SEC}s (restart $restarts/${SUPERVISE_BREAKER_RESTARTS})" >&2`,
    `  sleep ${SUPERVISE_BACKOFF_SEC}`,
    "done",
    'exec "${SHELL:-/bin/sh}"',
  ].join("\n");
}

/** Single-quote for POSIX sh (`'` → `'\''`). */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export interface SuperviseDeps {
  tmux: TmuxNamespace;
  binPath: string;
  log: (line: string) => void;
  cwd?: string;
}

/** `--supervise`: idempotent. An existing session is reported, never
 *  recreated — recreating would kill a live call. */
export async function superviseVoice(deps: SuperviseDeps): Promise<number> {
  if (await deps.tmux.session.hasSession(VOICE_TMUX_SESSION)) {
    deps.log(
      `voice: session '${VOICE_TMUX_SESSION}' already running (tmux -L ${VOICE_TMUX_SOCKET})`,
    );
    return 0;
  }
  await deps.tmux.session.newSession({
    name: VOICE_TMUX_SESSION,
    detached: true,
    windowName: "voice",
    shellCommand: buildCrashLoopScript(deps.binPath),
    ...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}),
  });
  deps.log(
    `voice: supervised session '${VOICE_TMUX_SESSION}' started (tmux -L ${VOICE_TMUX_SOCKET} attach -t ${VOICE_TMUX_SESSION})`,
  );
  return 0;
}

export interface VoiceStatusReport {
  sessionExists: boolean;
  healthy: boolean;
  url: string;
  provider: string;
  readonly: boolean;
}

export interface StatusDeps {
  tmux: TmuxNamespace;
  config: VoiceConfig;
  reachable?: (url: string) => Promise<boolean>;
}

/** `--status`: is the supervised session up, and does `/healthz` answer? */
export async function voiceStatus(deps: StatusDeps): Promise<VoiceStatusReport> {
  const url = `http://${deps.config.host}:${deps.config.port}/healthz`;
  const probe = deps.reachable ?? ((u: string): Promise<boolean> => isReachable(u));
  const [sessionExists, healthy] = await Promise.all([
    deps.tmux.session.hasSession(VOICE_TMUX_SESSION),
    probe(url),
  ]);
  return {
    sessionExists,
    healthy,
    url,
    provider: deps.config.provider,
    readonly: deps.config.readonly,
  };
}

/** Render the `--status` report. Stdout: this is a one-shot read that
 *  exits before any verb capture exists. */
export function formatStatusReport(r: VoiceStatusReport): string {
  const session = r.sessionExists ? "up" : "down";
  const health = r.healthy ? "ok" : "unreachable";
  return [
    `voice: session=${session}  healthz=${health}  ${r.url}`,
    `voice: provider=${r.provider}  readonly=${r.readonly}`,
  ].join("\n");
}

export interface StopDeps {
  tmux: TmuxNamespace;
  log: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * `--stop`: graceful. SIGINT the foreground `--serve` first (C-c into the
 * pane — the wrapper's `trap` and the server's own signal handler both
 * fire, so phone sockets and provider legs close cleanly), then take the
 * session down. Killing the session outright would drop every live
 * WebSocket mid-frame and strand the provider leg until its own timeout.
 */
export async function stopVoice(deps: StopDeps): Promise<number> {
  if (!(await deps.tmux.session.hasSession(VOICE_TMUX_SESSION))) {
    deps.log(`voice: no '${VOICE_TMUX_SESSION}' session to stop`);
    return 0;
  }
  await deps.tmux.pane.sendKeys({
    target: { kind: "service", team: VOICE_TMUX_SESSION, target: `${VOICE_TMUX_SESSION}:voice` },
    keys: "C-c",
    enter: false,
  });
  await (deps.sleep ?? realSleep)(STOP_GRACE_MS);
  await deps.tmux.session.killSession(VOICE_TMUX_SESSION);
  deps.log(`voice: stopped '${VOICE_TMUX_SESSION}'`);
  return 0;
}

// ---------- Verb entry ----------

export interface VoiceEntryOverrides {
  buildDeps?: (opts: BuildVoiceDepsOpts) => Promise<VoiceServeDeps>;
  tmux?: TmuxNamespace;
  binPath?: string;
  log?: (line: string) => void;
  out?: (line: string) => void;
  reachable?: (url: string) => Promise<boolean>;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  applyScope?: () => void;
  /** Model-pin drift check seam (ADR-272 §Supplement). Threaded to
   *  `serveVoice`; a test MUST inject it, since the real one issues an
   *  HTTPS GET to the provider's model index. */
  checkModel?: (deps: ModelCheckDeps) => Promise<ModelCheckResult>;
}

/**
 * `atmux voice [flags]`.
 *
 * Throws `UsageError` (bad argv) / `ConfigError` (missing token or API
 * key) BEFORE anything binds a port or spawns a session.
 */
export async function voice(
  argv: ReadonlyArray<string>,
  overrides: VoiceEntryOverrides = {},
): Promise<number> {
  const args = parseVoiceArgs(argv);
  const flags = voiceArgsToFlags(args);
  const log =
    overrides.log ??
    ((line: string): void => {
      process.stderr.write(`${line}\n`);
    });
  const out =
    overrides.out ??
    ((line: string): void => {
      process.stdout.write(`${line}\n`);
    });

  // `--print-assets-dir` resolves config (so `ATMUX_VOICE_ASSETS_DIR` is
  // honoured) but deliberately does NOT require an API key — it is the
  // dev-vs-compiled `$bunfs` verification hook (V-1), not a boot.
  if (args.action === "print-assets-dir") {
    out(resolveVoiceAssetsDir(resolveVoiceConfig(process.env, flags)));
    return 0;
  }

  const tmux = overrides.tmux ?? createTmux({ socket: VOICE_TMUX_SOCKET });

  if (args.action === "supervise") {
    const binOpts: Parameters<typeof resolveSuperviseBin>[0] = {};
    if (overrides.binPath !== undefined) binOpts.override = overrides.binPath;
    return await superviseVoice({
      tmux,
      binPath: resolveSuperviseBin(binOpts),
      log,
    });
  }

  if (args.action === "stop") {
    const stopDeps: StopDeps = { tmux, log };
    if (overrides.sleep !== undefined) stopDeps.sleep = overrides.sleep;
    return await stopVoice(stopDeps);
  }

  if (args.action === "status") {
    const statusDeps: StatusDeps = { tmux, config: resolveVoiceConfig(process.env, flags) };
    if (overrides.reachable !== undefined) statusDeps.reachable = overrides.reachable;
    const report = await voiceStatus(statusDeps);
    out(formatStatusReport(report));
    return report.sessionExists && report.healthy ? 0 : 1;
  }

  // `--serve`.
  (
    overrides.applyScope ??
    ((): void => {
      applyDriverScope();
    })
  )();
  const deps = await (overrides.buildDeps ?? buildVoiceDeps)({ flags });
  // `deps.log` (redacting) is the default for the serve path — the local
  // `log` above is the plain stderr sink the no-secrets actions use.
  const serveOpts: ServeVoiceOpts = { deps };
  if (overrides.log !== undefined) serveOpts.log = overrides.log;
  if (args.maxFrames !== undefined) serveOpts.maxFrames = args.maxFrames;
  if (overrides.signal !== undefined) serveOpts.signal = overrides.signal;
  if (overrides.checkModel !== undefined) serveOpts.checkModel = overrides.checkModel;
  return await serveVoice(serveOpts);
}
