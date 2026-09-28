// e-cc3728bf T2 (ADR-212 §D3) — rotation consumer core.
//
// Reads observer signals (pane.stuck, member.no-progress, cage.starving)
// from the event log, correlates them per (team, member), emits
// coordination.rotate-suggested, and nudges the lead via an injected
// sender for high-confidence findings. Lead-gated throughout: NOTHING
// here rotates, clears, or dispatches — the consumer suggests, the lead
// judges (ADR-212 §D2).
//
// Correlation rule (epic §D3.1): pane.stuck + member.no-progress on the
// same (team, member) with observed times within CORRELATION_WINDOW_MS
// = high confidence. A lone signal = medium. Mediums are emitted to
// the log (the lead sees them) but do NOT trigger a tell-lead nudge —
// composer spam for every lone stuck pane would train the operator to
// ignore the high-confidence ones.

import type { Database } from "bun:sqlite";
import { drainSince, emit, loadOffset, saveOffset } from "../abstractions/events.ts";
import type {
  CageStarvingPayload,
  EventPayload,
  MemberNoProgressPayload,
  PaneStuckPayload,
} from "../schema/events.ts";

export const CONSUMER_NAME = "rotation-consumer";
export const CORRELATION_WINDOW_MS = 5 * 60_000;
export const OBSERVED_TOPICS = ["pane.stuck", "member.no-progress", "cage.starving"] as const;

export type SuggestionConfidence = "high" | "medium";

/** A correlated rotation suggestion (pre-emit shape). */
export interface RotationSuggestion {
  team: string;
  member: string;
  confidence: SuggestionConfidence;
  reasons: string[];
  evidence: string;
  observedAtMs: number;
}

interface Signal {
  kind: "stuck" | "no-progress";
  atMs: number;
  detail: string;
}

/**
 * Correlate drained observer events into per-(team, member)
 * suggestions. Pure: no IO, deterministic over the input list.
 * cage.starving is team-level and does not join member correlation
 * (returned separately for the caller to log/route as it sees fit).
 */
export function correlateSignals(
  events: EventPayload[],
  nowMs = Date.now(),
): { suggestions: RotationSuggestion[]; starving: CageStarvingPayload[] } {
  const byMember = new Map<string, { team: string; member: string; signals: Signal[] }>();
  const starving: CageStarvingPayload[] = [];
  for (const e of events) {
    if (e.topic === "pane.stuck") {
      const p = e as PaneStuckPayload;
      const key = `${p.team}\u0000${p.member}`;
      let slot = byMember.get(key);
      if (slot === undefined) {
        slot = { team: p.team, member: p.member, signals: [] };
        byMember.set(key, slot);
      }
      slot.signals.push({
        kind: "stuck",
        atMs: p.observedAtSec * 1000,
        detail: `pane idle since ${p.lastActivitySec}s (${p.captureExcerpt})`,
      });
    } else if (e.topic === "member.no-progress") {
      const p = e as MemberNoProgressPayload;
      const key = `${p.team}\u0000${p.member}`;
      let slot = byMember.get(key);
      if (slot === undefined) {
        slot = { team: p.team, member: p.member, signals: [] };
        byMember.set(key, slot);
      }
      slot.signals.push({
        kind: "no-progress",
        atMs: p.observedAtSec * 1000,
        detail: `claim idle ${p.hoursIdle.toFixed(1)}h (last commit ${p.lastCommitSec ?? "never"})`,
      });
    } else if (e.topic === "cage.starving") {
      starving.push(e as CageStarvingPayload);
    }
  }
  const suggestions: RotationSuggestion[] = [];
  for (const slot of byMember.values()) {
    const kinds = new Set(slot.signals.map((s) => s.kind));
    const latest = Math.max(...slot.signals.map((s) => s.atMs));
    const span = Math.max(...slot.signals.map((s) => s.atMs)) - Math.min(...slot.signals.map((s) => s.atMs));
    const confidence: SuggestionConfidence =
      kinds.has("stuck") && kinds.has("no-progress") && span <= CORRELATION_WINDOW_MS ? "high" : "medium";
    suggestions.push({
      team: slot.team,
      member: slot.member,
      confidence,
      reasons: slot.signals.map((s) => `${s.kind}: ${s.detail}`),
      evidence: slot.signals.map((s) => s.detail).join(" | "),
      observedAtMs: Math.min(latest, nowMs),
    });
  }
  return { suggestions, starving };
}

/**
 * Render the tell-lead nudge for a high-confidence suggestion. Carries
 * the verbatim verb to run (rotate-member; clear-member stays a human
 * call — rotation restarts the worker, clearing wipes its state).
 */
export function renderSuggestionMessage(s: RotationSuggestion): string {
  const lines = [
    `rotation suggestion [${s.confidence}] — ${s.team}/${s.member} looks stuck:`,
    ...s.reasons.map((r) => `- ${r}`),
    `suggested: \`atmux rotate-member ${s.member} --reason stuck-pane\``,
    `lead-gated: verify before running; reply here to dismiss.`,
  ];
  return lines.join("\n");
}

/** Injected IO for one consume pass. */
export interface ConsumeDeps {
  sendToLead: (team: string, message: string) => void | Promise<void>;
  nowMs?: () => number;
}

/** One consume pass over a team's signal backlog. */
export interface ConsumeResult {
  suggestions: RotationSuggestion[];
  nudged: number;
}

/**
 * Drain observer signals since the consumer offset, correlate, emit
 * one coordination.rotate-suggested per (team, member), nudge the lead
 * for high-confidence findings, and advance the offset past the last
 * drained event. Offset advances even when nothing correlates (the
 * events were seen — re-draining them next tick would double-suggest).
 */
export async function consumeTeam(db: Database, team: string, deps: ConsumeDeps): Promise<ConsumeResult> {
  const now = deps.nowMs ?? Date.now;
  const nowMs = now();
  const lastId = loadOffset(db, CONSUMER_NAME);
  const drained = drainSince(db, { topics: [...OBSERVED_TOPICS], lastEventId: lastId });
  const mine = drained.filter((e) => (e as { team?: string }).team === team);
  const { suggestions } = correlateSignals(mine, nowMs);
  const observedAtSec = Math.floor(nowMs / 1000);
  for (const s of suggestions) {
    emit(db, {
      topic: "coordination.rotate-suggested",
      team: s.team,
      member: s.member,
      confidence: s.confidence,
      reasons: s.reasons,
      evidence: s.evidence.slice(0, 500),
      observedAtSec,
    });
    if (s.confidence === "high") {
      await deps.sendToLead(s.team, renderSuggestionMessage(s));
    }
  }
  if (drained.length > 0) {
    const last = drained[drained.length - 1] as { eventId: string };
    saveOffset(db, CONSUMER_NAME, last.eventId);
  }
  return { suggestions, nudged: suggestions.filter((s) => s.confidence === "high").length };
}
