// e-cc3728bf — rotation consumer (ADR-212 §D2).
//
// Wakes on observation events from orchd's scanners + emits a
// tell-lead message so the lead's Claude adjudicates the rotation
// decision. Lead-gated per ADR-212: detection is automated (events),
// destructive action (rotate / preclear / clear) is lead's call.
//
// v1 topic: member.context-high (from e-13-04c8b3bf context-scan).
// Future v2 topics layer on as their observers ship:
//   pane.stuck             (from pane-classifier observer)
//   member.no-progress     (from member-no-progress observer)
//   cage.starving          (from cage-state observer)
//
// Same lead-gated pattern as src/core/complaint-consumer.ts; the
// dispatch shape is identical (spawn `atmux tell-lead --team <t>
// "<msg>"`). Dedup-bumps (re-arm within window) suppressed by
// default; override via ATMUX_ROTATION_ROUTE_BUMPS=1.

import { spawn } from "node:child_process";

import type { MemberContextHighPayload } from "../schema/events.ts";

export interface RotationConsumerDeps {
  /** Spawn-wait. Default: real `atmux` subprocess. */
  spawnTellLead?: (args: ReadonlyArray<string>) => Promise<number>;
  /** Optional logger. */
  logger?: { log: (msg: string) => void; warn: (msg: string) => void };
}

export type RotationConsumerOutcome =
  | "routed"
  | "tell-lead-failed";

const NOOP_LOGGER = { log: () => {}, warn: () => {} };

/**
 * Factory — returns a handler for `member.context-high` events.
 * Registered by bootstrapOrchd against consumer-id
 * `atmux:rotation-consumer`.
 */
export function createRotationConsumerHandler(
  deps: RotationConsumerDeps = {},
): (event: MemberContextHighPayload) => Promise<RotationConsumerOutcome> {
  const spawnTellLead = deps.spawnTellLead ?? defaultSpawnTellLead;
  const logger = deps.logger ?? NOOP_LOGGER;

  return async (event) => {
    const msg = formatRotationMessage(event);
    const args = ["tell-lead", "--team", event.team, msg];
    const code = await spawnTellLead(args);
    if (code !== 0) {
      logger.warn(
        `rotation-consumer: tell-lead exited rc=${code} for member=${event.member} team=${event.team}`,
      );
      return "tell-lead-failed";
    }
    logger.log(
      `rotation-consumer: routed ctx-high member=${event.member} team=${event.team} pct=${event.percent}`,
    );
    return "routed";
  };
}

/** Build the lead-inbox line. Spec out the decision matrix inline so
 *  the lead's Claude has the adjudication hint without reading docs.
 *  Member name + percent + threshold + suggested actions. */
export function formatRotationMessage(event: MemberContextHighPayload): string {
  return (
    `📊 [ctx-high] member=${event.member} at ${event.percent}% context (≥${event.threshold}%). ` +
    `Decide: (a) /preclear (compact + reset, keeps role + brief); ` +
    `(b) atmux rotate-member ${event.member} (rotate to fresh window with same role); ` +
    `(c) leave-alone (member is mid-turn or near-end; recheck next scan). ` +
    `Statusline: ${event.matchedSegment.trim()}`
  );
}

function defaultSpawnTellLead(args: ReadonlyArray<string>): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("atmux", [...args], { stdio: "inherit", env: process.env });
    child.on("error", () => resolve(127));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}
