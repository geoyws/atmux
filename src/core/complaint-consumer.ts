// ADR-214 §D2 — complaint consumer.
//
// When `complaint.filed` fires, route to the lead's inbox via
// `atmux tell-lead`. Lead's Claude reads on next idle turn and
// adjudicates (resolve / wontfix / promote-epic / dismiss / escalate
// per the decision matrix in templates/briefs/lead.md).
//
// Cross-team routing: when the complaint's `targetTeam` differs from
// the team whose state.db holds the row (cross-team filing per
// ADR-150), the consumer routes via `atmux tell-lead --team <target>`
// so the right lead receives it. Same-team complaints use the bare
// `atmux tell-lead` for the fast-path.
//
// Dedup-bump suppression: when `bumped: true` (existing OPEN complaint
// re-armed within dedup window), we skip the tell-lead by default —
// lead already saw the original, repeat pings burn context. The
// `bumpRoute` knob lets operators opt in to per-bump pings via env
// (`ATMUX_COMPLAINT_ROUTE_BUMPS=1`) if their lead wants every strike.

import { spawn } from "node:child_process";

import type { ComplaintFiledPayload } from "../schema/events.ts";

/** Test-injection seam — production callers omit. */
export interface ComplaintConsumerDeps {
  /** Spawn an `atmux tell-lead` subprocess. Override in tests to assert
   *  on argv without forking. Default: real `child_process.spawn` against
   *  `atmux` on PATH. Resolves to the subprocess exit code; non-zero is
   *  surfaced to the caller for retry logic. */
  spawnTellLead?: (args: ReadonlyArray<string>) => Promise<number>;
  /** Optional logger. Defaults to `console`. */
  logger?: { log: (msg: string) => void; warn: (msg: string) => void };
  /** Read env for the bump-routing knob. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** Outcome surface — mirrors the orchd-merge / orchd-dissolve pattern
 *  for observability + audit-log consistency. */
export type ComplaintConsumerOutcome = "routed" | "skipped-bump" | "tell-lead-failed";

const NOOP_LOGGER = { log: () => {}, warn: () => {} };

/**
 * Factory — returns a handler for `complaint.filed` events. Registered
 * by `bootstrapOrchd` against consumer-id `atmux:complaint-consumer`.
 *
 * Idempotency: tell-lead is a write to driver-inbox.md (text append).
 * Re-delivery (at-least-once per ADR-203 §D7) appends the same line
 * twice — annoying but not destructive. Lead's adjudication eyeballs
 * the duplicate and resolves once. A future tighter contract could
 * dedup at the inbox layer via `complaintId` substring match before
 * appending, but YAGNI until repeat-delivery is observed in prod.
 */
export function createComplaintConsumerHandler(
  deps: ComplaintConsumerDeps = {},
): (event: ComplaintFiledPayload) => Promise<ComplaintConsumerOutcome> {
  const spawnTellLead = deps.spawnTellLead ?? defaultSpawnTellLead;
  const logger = deps.logger ?? NOOP_LOGGER;
  const env = deps.env ?? process.env;
  const routeBumps = env.ATMUX_COMPLAINT_ROUTE_BUMPS === "1";

  return async (event) => {
    if (event.bumped === true && !routeBumps) {
      logger.log(
        `complaint-consumer: skipped bump complaintId=${event.complaintId} sourceCount=${event.sourceCount} (set ATMUX_COMPLAINT_ROUTE_BUMPS=1 to route bumps)`,
      );
      return "skipped-bump";
    }

    const msg = formatComplaintMessage(event);
    const args = ["tell-lead"];
    // Same-team complaint: omit --team so the bare-cwd resolver fires
    // (matches the existing tell-lead fast-path for operator use). The
    // current process cwd is the team root (set by the orchd Rust
    // dispatcher via ATMUX_ORCHD_TEAM_DIR). Cross-team filings (per
    // ADR-150) get --team <target> so the right lead is pinged.
    //
    // Detection: the targetTeam string differs from the cwd-resolved
    // team. We don't have direct access to the team name here without
    // re-reading team.json; spawning tell-lead with --team is always
    // safe (it resolves the cwd team itself when --team matches the
    // caller). So we always pass --team for explicitness.
    args.push("--team", event.targetTeam, msg);

    const code = await spawnTellLead(args);
    if (code !== 0) {
      logger.warn(
        `complaint-consumer: tell-lead exited rc=${code} for complaintId=${event.complaintId} target=${event.targetTeam}`,
      );
      return "tell-lead-failed";
    }
    logger.log(
      `complaint-consumer: routed complaintId=${event.complaintId} target=${event.targetTeam} bumped=${event.bumped}`,
    );
    return "routed";
  };
}

/** Format a complaint payload into a short lead-inbox line. */
export function formatComplaintMessage(event: ComplaintFiledPayload): string {
  const severity = event.severity ?? "unrated";
  const source = event.sourceKind ?? "unknown";
  const count = event.sourceCount > 1 ? ` (×${event.sourceCount})` : "";
  return (
    `[complaint] ${event.complaintId}${count} severity=${severity} source=${source}: ${event.incidentSummary} ` +
    `— adjudicate: atmux complaints resolve ${event.complaintId} --status resolved|wontfix --note "<why>"`
  );
}

/** Default real-process spawn. Inherits stdio so logs surface in the
 *  orchd pane log. Returns the child's exit code. */
function defaultSpawnTellLead(args: ReadonlyArray<string>): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("atmux", [...args], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", () => resolve(127));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}
