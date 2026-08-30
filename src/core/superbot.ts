// ADR-285 — deterministic `_superbot` routing and readiness primitives.
// Pure policy lives here; Kanban/tmux process IO is owned by the verb.

import { botActor } from "./bot.ts";
import { classifyText } from "./pane-state.ts";
import { verifierForTui } from "./safe-send.ts";
import type { CockpitSuperbotRoute } from "../schema/cockpit.ts";

export const SUPERBOT_METADATA_KEY = "atmuxSuperbot";
export const SUPERBOT_PENDING_RETRY_LIMIT = 2;
export const SUPERBOT_ACTOR = "superbot@cockpit";

export interface SuperbotCandidate {
  id: string;
  type: string;
  status: string;
  tags: string[];
  metadata: Record<string, unknown>;
}

export interface SuperbotPendingOffer {
  team: string;
  at: number;
  attempts: number;
}

/** Entire value persisted under task.metadata.atmuxSuperbot. */
export interface SuperbotOfferState {
  routeKey: string;
  firstOfferedAt: number;
  lastOfferedAt: number;
  offeredTeams: Record<string, number>;
  pending: SuperbotPendingOffer | null;
}

export interface SuperbotTargetDecision {
  team: string;
  reason: "default" | "pending-retry" | "fallback";
  attempt: number;
}

export function superbotRouteKey(route: CockpitSuperbotRoute): string {
  return `${route.board}/${route.tag}`;
}

/** Parse only the scheduler namespace. Malformed/mismatched metadata is
 * treated as absent; no other task metadata is interpreted. */
export function readSuperbotOfferState(
  candidate: SuperbotCandidate,
  route: CockpitSuperbotRoute,
): SuperbotOfferState | null {
  const raw = candidate.metadata[SUPERBOT_METADATA_KEY];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.routeKey !== superbotRouteKey(route)) return null;
  if (
    typeof value.firstOfferedAt !== "number" ||
    typeof value.lastOfferedAt !== "number" ||
    typeof value.offeredTeams !== "object" ||
    value.offeredTeams === null ||
    Array.isArray(value.offeredTeams)
  ) {
    return null;
  }
  const offeredTeams: Record<string, number> = {};
  for (const [team, at] of Object.entries(value.offeredTeams as Record<string, unknown>)) {
    if (typeof at === "number" && Number.isFinite(at)) offeredTeams[team] = at;
  }
  let pending: SuperbotPendingOffer | null = null;
  if (
    typeof value.pending === "object" &&
    value.pending !== null &&
    !Array.isArray(value.pending)
  ) {
    const p = value.pending as Record<string, unknown>;
    if (typeof p.team === "string" && typeof p.at === "number" && typeof p.attempts === "number") {
      pending = { team: p.team, at: p.at, attempts: p.attempts };
    }
  }
  return {
    routeKey: value.routeKey,
    firstOfferedAt: value.firstOfferedAt,
    lastOfferedAt: value.lastOfferedAt,
    offeredTeams,
    pending,
  };
}

/** Default-first, then one ordered fallback per cooldown interval. A
 * pre-send reservation that never completed retries the same team once
 * after an interval; after the bounded retry it advances. */
export function chooseSuperbotTarget(opts: {
  route: CockpitSuperbotRoute;
  candidate: SuperbotCandidate;
  nowMs: number;
  intervalMs: number;
  fallbackAfterIntervals: number;
}): SuperbotTargetDecision | null {
  const state = readSuperbotOfferState(opts.candidate, opts.route);
  if (state === null) {
    return { team: opts.route.defaultTeam, reason: "default", attempt: 1 };
  }
  const cooldownMs = opts.intervalMs * opts.fallbackAfterIntervals;
  if (opts.nowMs - state.lastOfferedAt < cooldownMs) return null;

  if (state.pending !== null && state.pending.attempts < SUPERBOT_PENDING_RETRY_LIMIT) {
    return {
      team: state.pending.team,
      reason: "pending-retry",
      attempt: state.pending.attempts + 1,
    };
  }

  const owners = [opts.route.defaultTeam, ...opts.route.fallbackTeams];
  const next = owners.find(
    (team) => state.offeredTeams[team] === undefined && team !== state.pending?.team,
  );
  return next === undefined ? null : { team: next, reason: "fallback", attempt: 1 };
}

export function reserveSuperbotOffer(opts: {
  previous: SuperbotOfferState | null;
  route: CockpitSuperbotRoute;
  team: string;
  attempt: number;
  nowMs: number;
}): SuperbotOfferState {
  return {
    routeKey: superbotRouteKey(opts.route),
    firstOfferedAt: opts.previous?.firstOfferedAt ?? opts.nowMs,
    lastOfferedAt: opts.nowMs,
    offeredTeams: { ...(opts.previous?.offeredTeams ?? {}) },
    pending: { team: opts.team, at: opts.nowMs, attempts: opts.attempt },
  };
}

export function completeSuperbotOffer(state: SuperbotOfferState): SuperbotOfferState {
  if (state.pending === null) return state;
  return {
    ...state,
    offeredTeams: { ...state.offeredTeams, [state.pending.team]: state.lastOfferedAt },
    pending: null,
  };
}

/** The offer contains routing identity and exact claim/context commands,
 * never the task title or body. Kanban's atomic exact claim decides the
 * winner; a refusal tells a later bot to stop. */
export function formatSuperbotOffer(opts: {
  board: string;
  taskId: string;
  tags: ReadonlyArray<string>;
  team: string;
}): string {
  const actor = botActor(opts.team);
  return [
    "[atmux _superbot offer]",
    `board: ${opts.board}`,
    `task: ${opts.taskId}`,
    `tags: ${[...opts.tags].sort().join(",")}`,
    "",
    "Claim this exact task first:",
    `kb claim ${opts.taskId} --project ${opts.board} --as ${actor} --json`,
    "If the claim succeeds, read its rules and context:",
    `kb ctx ${opts.taskId} --project ${opts.board} --json`,
    "If the claim is refused, stop immediately; another bot owns it.",
    "Manual operator input always outranks this offer.",
  ].join("\n");
}

export type BotReadinessReason =
  | "ready"
  | "held"
  | "live-lease"
  | "dead"
  | "shell"
  | "unsupported-verifier"
  | "unstable"
  | "not-idle"
  | "composer-not-empty";

export interface BotReadinessInput {
  tui: string | null | undefined;
  held: boolean;
  hasLiveLease: boolean;
  paneDead: boolean;
  paneCurrentCommand: string;
  firstCapture: string;
  secondCapture: string;
}

// biome-ignore lint/complexity/useRegexLiterals: the literal form trips the control-character safety rule.
const ANSI_ESCAPE_RE = new RegExp("\\x1B\\[[0-?]*[ -/]*[@-~]", "g");
const CLAUDE_PLACEHOLDER_RE = /^(?:Try\s+["“]|Ask\s|Type\s|Write\s|Edit\s+files)/i;

/** Inspect the bottom-most Claude composer, never an older prompt in
 * scrollback. Placeholder hint text is UI chrome, not operator input. */
export function botComposerEmpty(tui: string | null | undefined, capture: string): boolean {
  if (tui !== "claude") return false;
  const lines = capture.replace(ANSI_ESCAPE_RE, "").split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? "";
    const marker = line.lastIndexOf("❯");
    if (marker < 0) continue;
    const text = line.slice(marker + 1).trim();
    return text === "" || CLAUDE_PLACEHOLDER_RE.test(text);
  }
  return false;
}

/** Conservative two-capture readiness gate. Direct operator typing needs
 * no mode toggle: it makes the composer non-empty or the capture unstable,
 * so the scheduler defers. `bot hold` covers longer operator pauses. */
export function assessBotReadiness(input: BotReadinessInput): BotReadinessReason {
  if (input.held) return "held";
  if (input.hasLiveLease) return "live-lease";
  if (input.paneDead) return "dead";
  const verifier = verifierForTui(input.tui ?? undefined);
  if (verifier === null) return "unsupported-verifier";
  if (input.firstCapture !== input.secondCapture) return "unstable";
  const firstState = classifyText(input.firstCapture).state;
  const secondState = classifyText(input.secondCapture).state;
  if (firstState === "SHELL" && secondState === "SHELL") return "shell";
  if (firstState !== "READY" || secondState !== "READY") {
    return "not-idle";
  }
  if (
    !botComposerEmpty(input.tui, input.firstCapture) ||
    !botComposerEmpty(input.tui, input.secondCapture)
  ) {
    return "composer-not-empty";
  }
  return "ready";
}
