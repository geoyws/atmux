// ADR-281 — deterministic cockpit `_superbot` process.
// No LLM runs here. The loop reads exact Kanban candidates, verifies an
// idle `_bot`, and sends a claim-first offer. It never claims or assigns.

import { homedir } from "node:os";
import { join } from "node:path";
import { withLock } from "../abstractions/lock.ts";
import { createTmux, type TmuxNamespace } from "../abstractions/tmux.ts";
import { SuperbotKanbanAdapter } from "../adapters/superbot-kanban.ts";
import {
  BOT_HOLD_OPTION,
  BOT_WINDOW_NAME,
  botActor,
  botSendTarget,
  isBotRoutable,
} from "../core/bot.ts";
import {
  enabledTeams,
  type LoadedCockpit,
  loadCockpit,
  resolveCageSessionName,
  resolveCageSocket,
} from "../core/cockpit.ts";
import { loadTeam } from "../core/common.ts";
import { agentThinking, safeSendKeysWithVerify } from "../core/safe-send.ts";
import {
  assessBotReadiness,
  type BotReadinessReason,
  botComposerEmpty,
  chooseSuperbotTarget,
  completeSuperbotOffer,
  formatSuperbotOffer,
  readSuperbotOfferState,
  reserveSuperbotOffer,
  SUPERBOT_ACTOR,
  type SuperbotCandidate,
} from "../core/superbot.ts";
import { getAtmuxTmuxConfPath } from "../core/tmux-paths.ts";
import { ConfigError, UsageError } from "../errors.ts";
import type { CockpitSuperbotRoute } from "../schema/cockpit.ts";
import type { Team } from "../schema/team.ts";

const USAGE = "atmux superbot <run|tick> [--config <path>] [--shadow] [--json]";
const READINESS_SETTLE_MS = 500;

export interface SuperbotArgs {
  action: "run" | "tick";
  configPath?: string;
  forceShadow: boolean;
  json: boolean;
}

export function parseSuperbotArgs(argv: ReadonlyArray<string>): SuperbotArgs {
  const action = argv[0];
  if (action !== "run" && action !== "tick") {
    throw new UsageError({ what: "superbot: expected run or tick", hint: USAGE });
  }
  let configPath: string | undefined;
  let forceShadow = false;
  let json = false;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--shadow") forceShadow = true;
    else if (arg === "--json") json = true;
    else if (arg === "--config") {
      const value = argv[i + 1];
      if (value === undefined || value.length === 0) {
        throw new UsageError({ what: "superbot: --config requires a value", hint: USAGE });
      }
      configPath = value;
      i += 1;
    } else {
      throw new UsageError({ what: `superbot: unknown argument: ${arg ?? ""}`, hint: USAGE });
    }
  }
  return {
    action,
    forceShadow,
    json,
    ...(configPath !== undefined ? { configPath } : {}),
  };
}

export type SuperbotTickOutcome =
  | "shadow-offer"
  | "offered"
  | "cooldown"
  | "not-candidate"
  | "unroutable"
  | "not-ready";

export interface SuperbotTickRow {
  board: string;
  tag: string;
  task: string;
  team?: string;
  outcome: SuperbotTickOutcome;
  reason?: string;
}

export interface SuperbotTickDeps {
  kanban?: SuperbotKanbanAdapter;
  tmuxFactory?: typeof createTmux;
  loadTeamFn?: typeof loadTeam;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Disposable per-pane lock namespace for tests/isolated pilots. */
  paneLockDir?: string;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function actorHasAnyLiveClaim(
  kanban: SuperbotKanbanAdapter,
  boards: ReadonlyArray<string>,
  actor: string,
  nowMs: number,
): Promise<boolean> {
  for (const board of boards) {
    if (await kanban.hasLiveClaim(board, actor, nowMs)) return true;
  }
  return false;
}

async function teamRuntime(
  cockpit: LoadedCockpit,
  teamName: string,
  loadTeamFn: typeof loadTeam,
): Promise<{ team: Team; sessionName: string; socketPath: string } | null> {
  const entry = enabledTeams(cockpit).find((team) => team.name === teamName);
  if (entry === undefined) return null;
  const team = await loadTeamFn({ teamDir: entry.root });
  if (!isBotRoutable(team.bot)) return null;
  return {
    team,
    sessionName: await resolveCageSessionName(entry),
    socketPath: await resolveCageSocket(entry.name, entry.root),
  };
}

async function inspectBotReadiness(opts: {
  tmux: TmuxNamespace;
  team: Team;
  sessionName: string;
  hasLiveLease: boolean;
  sleep: (ms: number) => Promise<void>;
}): Promise<{ reason: ReturnType<typeof assessBotReadiness>; secondCapture: string }> {
  const target = `${opts.sessionName}:${BOT_WINDOW_NAME}`;
  if (!(await opts.tmux.session.hasSession(opts.sessionName))) {
    return { reason: "dead", secondCapture: "" };
  }
  const windows = await opts.tmux.window.listWindows(opts.sessionName);
  if (!windows.some((window) => window.name === BOT_WINDOW_NAME)) {
    return { reason: "dead", secondCapture: "" };
  }
  const options = await opts.tmux.option.showOptions({ target, window: true });
  const pane = await opts.tmux.pane.displayMessage({
    target,
    format: "#{pane_current_command}\t#{pane_dead}",
  });
  const [paneCurrentCommand = "", dead = "0"] = pane.split("\t");
  const firstCapture = await opts.tmux.pane.capturePane({ target, start: -40 });
  await opts.sleep(READINESS_SETTLE_MS);
  const secondCapture = await opts.tmux.pane.capturePane({ target, start: -40 });
  return {
    reason: assessBotReadiness({
      tui: opts.team.bot?.tui,
      held: options[BOT_HOLD_OPTION] === "1",
      hasLiveLease: opts.hasLiveLease,
      paneDead: dead === "1",
      paneCurrentCommand,
      firstCapture,
      secondCapture,
    }),
    secondCapture,
  };
}

async function deliverOffer(opts: {
  tmux: TmuxNamespace;
  team: Team;
  sessionName: string;
  message: string;
  beforeCapture: string;
  preSendCheck: (capture: string) => Promise<BotReadinessReason | "not-candidate">;
  sleep: (ms: number) => Promise<void>;
  paneLockDir?: string;
}): Promise<{ success: boolean; reason?: BotReadinessReason | "not-candidate" }> {
  const target = `${opts.sessionName}:${BOT_WINDOW_NAME}`;
  const sendTarget = botSendTarget(opts.team.name, opts.sessionName);
  const thinking = agentThinking();
  const bufferName = `atmux-superbot-${process.pid}-${Date.now()}`;
  let refusalReason: BotReadinessReason | "not-candidate" | undefined;
  const result = await safeSendKeysWithVerify({
    target,
    keys: opts.message,
    capture: async (t) => await opts.tmux.pane.capturePane({ target: t, start: -40 }),
    sendKeys: async (_target, keys) => {
      await opts.tmux.buffer.loadBuffer({ name: bufferName, data: keys });
      await opts.tmux.buffer.pasteBuffer({
        name: bufferName,
        target: sendTarget,
        deleteAfter: true,
      });
      await opts.tmux.pane.sendKeys({ target: sendTarget, keys: "C-m", enter: false });
    },
    expectVerifier: (capture) =>
      capture !== opts.beforeCapture &&
      (thinking(capture) || botComposerEmpty(opts.team.bot?.tui, capture)),
    preSendVerifier: async (capture) => {
      if (capture !== opts.beforeCapture) {
        refusalReason = "unstable";
        return false;
      }
      const readiness = await opts.preSendCheck(capture);
      if (readiness !== "ready") {
        refusalReason = readiness;
        return false;
      }
      refusalReason = undefined;
      return true;
    },
    retries: 0,
    onFail: "escalate",
    sleep: opts.sleep,
    ...(opts.paneLockDir !== undefined ? { paneLockDir: opts.paneLockDir } : {}),
  });
  return {
    success: result.success,
    ...(refusalReason !== undefined ? { reason: refusalReason } : {}),
  };
}

async function processCandidate(opts: {
  cockpit: LoadedCockpit;
  route: CockpitSuperbotRoute;
  candidate: SuperbotCandidate;
  shadow: boolean;
  deps: Required<Pick<SuperbotTickDeps, "tmuxFactory" | "loadTeamFn" | "now" | "sleep">> & {
    kanban: SuperbotKanbanAdapter;
    leaseBoards: () => Promise<ReadonlyArray<string>>;
    paneLockDir?: string;
  };
}): Promise<SuperbotTickRow> {
  const nowMs = opts.deps.now();
  const base = { board: opts.route.board, tag: opts.route.tag, task: opts.candidate.id };
  if (opts.candidate.type !== "task" || opts.candidate.status !== "todo") {
    return { ...base, outcome: "not-candidate", reason: "type-or-status" };
  }
  const decision = chooseSuperbotTarget({
    route: opts.route,
    candidate: opts.candidate,
    nowMs,
    intervalMs: opts.cockpit.superbot.intervalMins * 60_000,
    fallbackAfterIntervals: opts.cockpit.superbot.fallbackAfterIntervals,
  });
  if (decision === null) return { ...base, outcome: "cooldown" };

  const runtime = await teamRuntime(opts.cockpit, decision.team, opts.deps.loadTeamFn);
  if (runtime === null) {
    return { ...base, team: decision.team, outcome: "unroutable", reason: "bot-config" };
  }
  const actor = botActor(decision.team);
  const leaseBoards = await opts.deps.leaseBoards();
  const hasLiveLease = await actorHasAnyLiveClaim(opts.deps.kanban, leaseBoards, actor, nowMs);
  const tmux = opts.deps.tmuxFactory({
    socketPath: runtime.socketPath,
    configFile: getAtmuxTmuxConfPath(),
  });
  const readiness = await inspectBotReadiness({
    tmux,
    team: runtime.team,
    sessionName: runtime.sessionName,
    hasLiveLease,
    sleep: opts.deps.sleep,
  });
  if (readiness.reason !== "ready") {
    return {
      ...base,
      team: decision.team,
      outcome: "not-ready",
      reason: readiness.reason,
    };
  }

  // Shadow proves the full candidate/route/runtime/readiness decision but
  // performs zero metadata writes and zero send-keys.
  if (opts.shadow) {
    return { ...base, team: decision.team, outcome: "shadow-offer", reason: decision.reason };
  }

  if (
    !(await opts.deps.kanban.isStillCandidate(
      opts.route.board,
      opts.route.tag,
      actor,
      opts.candidate.id,
      opts.cockpit.superbot.maxOffersPerTick,
    ))
  ) {
    return { ...base, team: decision.team, outcome: "not-candidate" };
  }

  const previous = readSuperbotOfferState(opts.candidate, opts.route);
  const reserved = reserveSuperbotOffer({
    previous,
    route: opts.route,
    team: decision.team,
    attempt: decision.attempt,
    nowMs,
  });
  await opts.deps.kanban.writeOfferState(opts.route.board, opts.candidate.id, reserved);
  const delivered = await deliverOffer({
    tmux,
    team: runtime.team,
    sessionName: runtime.sessionName,
    beforeCapture: readiness.secondCapture,
    sleep: opts.deps.sleep,
    preSendCheck: async (capture) => {
      if (
        !(await opts.deps.kanban.isStillCandidate(
          opts.route.board,
          opts.route.tag,
          actor,
          opts.candidate.id,
          opts.cockpit.superbot.maxOffersPerTick,
        ))
      ) {
        return "not-candidate";
      }
      const freshLease = await actorHasAnyLiveClaim(
        opts.deps.kanban,
        leaseBoards,
        actor,
        opts.deps.now(),
      );
      const target = `${runtime.sessionName}:${BOT_WINDOW_NAME}`;
      if (!(await tmux.session.hasSession(runtime.sessionName))) return "dead";
      const windows = await tmux.window.listWindows(runtime.sessionName);
      if (!windows.some((window) => window.name === BOT_WINDOW_NAME)) return "dead";
      const options = await tmux.option.showOptions({ target, window: true });
      const pane = await tmux.pane.displayMessage({
        target,
        format: "#{pane_current_command}\t#{pane_dead}",
      });
      const [paneCurrentCommand = "", dead = "0"] = pane.split("\t");
      return assessBotReadiness({
        tui: runtime.team.bot?.tui,
        held: options[BOT_HOLD_OPTION] === "1",
        hasLiveLease: freshLease,
        paneDead: dead === "1",
        paneCurrentCommand,
        firstCapture: readiness.secondCapture,
        secondCapture: capture,
      });
    },
    ...(opts.deps.paneLockDir !== undefined ? { paneLockDir: opts.deps.paneLockDir } : {}),
    message: formatSuperbotOffer({
      board: opts.route.board,
      taskId: opts.candidate.id,
      tags: opts.candidate.tags,
      team: decision.team,
    }),
  });
  if (!delivered.success) {
    if (delivered.reason === "not-candidate") {
      return { ...base, team: decision.team, outcome: "not-candidate" };
    }
    return {
      ...base,
      team: decision.team,
      outcome: "not-ready",
      reason: delivered.reason ?? "send-unverified",
    };
  }
  await opts.deps.kanban.writeOfferState(
    opts.route.board,
    opts.candidate.id,
    completeSuperbotOffer(reserved),
  );
  return { ...base, team: decision.team, outcome: "offered", reason: decision.reason };
}

/** One deterministic scheduler cycle. Config order resolves tasks that
 * match more than one route: first declared route wins for that tick. */
export async function superbotTick(
  cockpit: LoadedCockpit,
  forceShadow = false,
  deps: SuperbotTickDeps = {},
): Promise<SuperbotTickRow[]> {
  let leaseBoardsPromise: Promise<ReadonlyArray<string>> | undefined;
  const kanban = deps.kanban ?? new SuperbotKanbanAdapter();
  const resolved = {
    kanban,
    tmuxFactory: deps.tmuxFactory ?? createTmux,
    loadTeamFn: deps.loadTeamFn ?? loadTeam,
    now: deps.now ?? Date.now,
    sleep: deps.sleep ?? defaultSleep,
    leaseBoards: () => {
      leaseBoardsPromise ??= (async () => {
        const registered = await kanban.registeredBoards();
        return [
          ...new Set([...registered, ...cockpit.superbot.routes.map((route) => route.board)]),
        ];
      })();
      return leaseBoardsPromise;
    },
    ...(deps.paneLockDir !== undefined ? { paneLockDir: deps.paneLockDir } : {}),
  };
  const shadow = forceShadow || cockpit.superbot.shadow;
  const rows: SuperbotTickRow[] = [];
  const seen = new Set<string>();
  for (const route of cockpit.superbot.routes) {
    const candidates = await resolved.kanban.candidates(
      route.board,
      route.tag,
      SUPERBOT_ACTOR,
      cockpit.superbot.maxOffersPerTick,
    );
    for (const candidate of candidates) {
      const globalKey = `${route.board}/${candidate.id}`;
      if (seen.has(globalKey)) continue;
      seen.add(globalKey);
      rows.push(await processCandidate({ cockpit, route, candidate, shadow, deps: resolved }));
      if (rows.length >= cockpit.superbot.maxOffersPerTick) return rows;
    }
  }
  return rows;
}

export interface SuperbotVerbOpts extends SuperbotTickDeps {
  loadCockpitFn?: typeof loadCockpit;
  maxTicks?: number;
  write?: (text: string) => void;
  lockPath?: string;
  /** Test/isolated-pilot override; production intentionally fails fast. */
  lockTimeoutMs?: number;
}

function emit(rows: SuperbotTickRow[], json: boolean, write: (text: string) => void): void {
  if (json) {
    write(`${JSON.stringify(rows)}\n`);
    return;
  }
  if (rows.length === 0) {
    write("_superbot: no actionable candidates\n");
    return;
  }
  for (const row of rows) {
    write(
      `_superbot: ${row.outcome} board=${row.board} tag=${row.tag} task=${row.task}` +
        `${row.team !== undefined ? ` team=${row.team}` : ""}` +
        `${row.reason !== undefined ? ` reason=${row.reason}` : ""}\n`,
    );
  }
}

export async function superbot(
  argv: ReadonlyArray<string>,
  opts: SuperbotVerbOpts = {},
): Promise<number> {
  const parsed = parseSuperbotArgs(argv);
  const cockpit = await (opts.loadCockpitFn ?? loadCockpit)(
    parsed.configPath !== undefined ? { path: parsed.configPath } : {},
  );
  if (!cockpit.superbot.enabled) {
    throw new ConfigError({
      what: "superbot is disabled in cockpit.json",
      hint: "enable it only for a reviewed shadow pilot; live activation is a separate operation",
    });
  }
  const write = opts.write ?? ((text: string) => process.stdout.write(text));
  const runTick = async (): Promise<void> => {
    const rows = await superbotTick(cockpit, parsed.forceShadow, opts);
    emit(rows, parsed.json, write);
  };
  const lockPath = opts.lockPath ?? join(homedir(), ".atmux", "state", "superbot");
  const lockOpts = { timeoutMs: opts.lockTimeoutMs ?? 1_000 };
  if (parsed.action === "tick") {
    // Manual/cron ticks share the same singleton fence as the long-lived
    // runner. Without this, two one-shot invocations could reserve and
    // offer the same stale candidate concurrently.
    await withLock(lockPath, runTick, lockOpts);
    return 0;
  }

  const sleep = opts.sleep ?? defaultSleep;
  await withLock(
    lockPath,
    async () => {
      let ticks = 0;
      while (opts.maxTicks === undefined || ticks < opts.maxTicks) {
        try {
          await runTick();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          write(`_superbot: tick-error ${message}\n`);
        }
        ticks += 1;
        if (opts.maxTicks !== undefined && ticks >= opts.maxTicks) break;
        await sleep(cockpit.superbot.intervalMins * 60_000);
      }
    },
    lockOpts,
  );
  return 0;
}
