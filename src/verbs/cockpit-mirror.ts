// ADR-219: `atmux cockpit-mirror` Bun verb — cockpit-scope event
// dispatcher. The Rust `atmux-cockpit-mirror` binary owns the long-
// lived subscription against `~/.atmux/cockpit-events.db`; this Bun
// verb is the per-event handler spawned by the Rust binary once per
// arriving event (mirror of `atmux relayd --handle-one`).
//
// Wire-format (Rust → Bun): `atmux cockpit-mirror --handle-one
// --event-id <id> --topic <t>`. Exit 0 advances the Rust caller's
// offset; non-zero exit holds it (next wake retries).
//
// Topic switch routes to one of:
//   - epic.merge_ready   — parent-gitter dispatcher hook
//   - epic.spawn_blocked — operator-visibility ping
//   - team.spawned       — cockpit registry rebuild trigger
//   - team.dissolved     — cockpit registry rebuild + cron-reaper
//   - budget.warning     — claude account-pool reroute (ADR-199 D6)
//   - budget.recovered   — re-enable rerouted accounts
//   - gitter.escalated   — flag-add + Discord webhook
//   - unknown            — log-warn, return 0 (do NOT block the
//                          Rust drain on unknown-topic noise)
//
// MVP-stub status: each topic handler logs + no-ops below. Real
// handler wiring is per-topic follow-up Tasks under sibling Epics
// (gitter dispatcher, registry rebuilder, account-pool reroute,
// Discord+flag helpers). The dispatcher SHAPE is committed here so
// the Rust dispatcher has a real exit-code-emitting child to spawn.

import { ConfigError, UsageError } from "../errors.ts";

const USAGE =
  "atmux cockpit-mirror <--handle-one|--status> [--event-id ID --topic T]";

export interface ParsedCockpitMirrorArgs {
  subverb: "handle-one" | "status";
  /** `--event-id ID`: required when subverb is `handle-one`. */
  eventId?: string;
  /** `--topic T`: required when subverb is `handle-one`. */
  topic?: string;
}

export function parseCockpitMirrorArgs(
  argv: ReadonlyArray<string>,
): ParsedCockpitMirrorArgs {
  let subverb: "handle-one" | "status" | undefined;
  let eventId: string | undefined;
  let topic: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--handle-one" || a === "handle-one") {
      subverb = "handle-one";
      i += 1;
      continue;
    }
    if (a === "--status" || a === "status") {
      subverb = "status";
      i += 1;
      continue;
    }
    if (a === "--event-id") {
      const v = argv[i + 1];
      if (v === undefined || v === "") {
        throw new UsageError({
          what: "cockpit-mirror: --event-id requires a value",
          hint: USAGE,
        });
      }
      eventId = v;
      i += 2;
      continue;
    }
    if (a === "--topic") {
      const v = argv[i + 1];
      if (v === undefined || v === "") {
        throw new UsageError({
          what: "cockpit-mirror: --topic requires a value",
          hint: USAGE,
        });
      }
      topic = v;
      i += 2;
      continue;
    }
    if (a?.startsWith("-") === true) {
      throw new UsageError({
        what: `cockpit-mirror: unknown flag: ${a}`,
        hint: USAGE,
      });
    }
    throw new UsageError({
      what: `cockpit-mirror: unexpected arg: ${a}`,
      hint: USAGE,
    });
  }
  if (subverb === undefined) {
    throw new UsageError({
      what: "cockpit-mirror: no sub-verb specified (--handle-one or --status)",
      hint: USAGE,
    });
  }
  if (subverb === "handle-one") {
    if (eventId === undefined) {
      throw new UsageError({
        what: "cockpit-mirror --handle-one: --event-id required",
        hint: USAGE,
      });
    }
    if (topic === undefined) {
      throw new UsageError({
        what: "cockpit-mirror --handle-one: --topic required",
        hint: USAGE,
      });
    }
  }
  const out: ParsedCockpitMirrorArgs = { subverb };
  if (eventId !== undefined) out.eventId = eventId;
  if (topic !== undefined) out.topic = topic;
  return out;
}

/** Injectable handler-dispatch + log seam for tests — production
 *  default in {@link cockpitMirror} wires to the real per-topic stubs
 *  + stderr; tests inject recorders to assert the right handler fires
 *  for the right topic without spinning real Discord / kanban IO. */
export interface CockpitMirrorDeps {
  log?: (msg: string) => void;
  handlers?: Partial<Record<string, (eventId: string) => Promise<void>>>;
}

const DEFAULT_HANDLERS: Record<string, (eventId: string, log: (m: string) => void) => Promise<void>> =
  {
    "epic.merge_ready": async (eventId, log) => {
      // TODO(follow-up): wire to parent-gitter dispatcher hook per
      // ADR-091 — fan-in pre-flag #4. Current MVP scaffold logs only;
      // dispatch is implemented in the per-team gitter consumer.
      log(`cockpit-mirror: epic.merge_ready eventId=${eventId} — log-only (handler follow-up)`);
    },
    "epic.spawn_blocked": async (eventId, log) => {
      // TODO(follow-up): emit operator-visibility ping (Discord +
      // cockpit dashboard). MVP scaffold logs only.
      log(
        `cockpit-mirror: epic.spawn_blocked eventId=${eventId} — log-only (handler follow-up)`,
      );
    },
    "team.spawned": async (eventId, log) => {
      // TODO(follow-up): registry-rebuild trigger (cockpit.json
      // sessions[] auto-lift). MVP scaffold logs only.
      log(`cockpit-mirror: team.spawned eventId=${eventId} — log-only (handler follow-up)`);
    },
    "team.dissolved": async (eventId, log) => {
      // TODO(follow-up): registry-rebuild + cron-reaper. MVP scaffold
      // logs only.
      log(`cockpit-mirror: team.dissolved eventId=${eventId} — log-only (handler follow-up)`);
    },
    "budget.warning": async (eventId, log) => {
      // TODO(follow-up): wire to account-pool reroute per ADR-199 §D6
      // (least-loaded selector subscriber) + Discord webhook via
      // src/abstractions/discord.ts::send. MVP scaffold logs only.
      log(`cockpit-mirror: budget.warning eventId=${eventId} — log-only (handler follow-up)`);
    },
    "budget.recovered": async (eventId, log) => {
      // TODO(follow-up): re-enable rerouted accounts per ADR-199 §D6.
      // MVP scaffold logs only.
      log(`cockpit-mirror: budget.recovered eventId=${eventId} — log-only (handler follow-up)`);
    },
    "gitter.escalated": async (eventId, log) => {
      // TODO(follow-up): flag-add + Discord webhook. MVP scaffold logs
      // only — the per-team flag escalation already lands; cockpit-side
      // is the fleet-wide aggregator.
      log(`cockpit-mirror: gitter.escalated eventId=${eventId} — log-only (handler follow-up)`);
    },
  };

/** Topics this dispatcher knows. Non-whitelisted topics return 0 with
 *  a warn — Rust caller still advances offset (anti-stick on a topic
 *  that landed via wiring drift). */
const KNOWN_TOPICS = new Set(Object.keys(DEFAULT_HANDLERS));

/**
 * `atmux cockpit-mirror` top-level dispatch. Delegates to per-topic
 * handlers for `handle-one`, or surfaces a status block for `status`.
 */
export async function cockpitMirror(
  argv: ReadonlyArray<string>,
  deps: CockpitMirrorDeps = {},
): Promise<number> {
  const parsed = parseCockpitMirrorArgs(argv);
  const log =
    deps.log ??
    ((msg: string): void => {
      process.stderr.write(`${msg}\n`);
    });

  if (parsed.subverb === "status") {
    return cockpitMirrorStatus(log);
  }

  // handle-one path.
  const eventId = parsed.eventId;
  const topic = parsed.topic;
  if (eventId === undefined || topic === undefined) {
    // Parser guarantees both; defensive check for ts narrowing.
    throw new UsageError({
      what:
        "cockpit-mirror --handle-one: parser invariant violated (missing event-id or topic)",
    });
  }

  if (!KNOWN_TOPICS.has(topic)) {
    log(`cockpit-mirror: unknown topic '${topic}' eventId=${eventId} — log-warn, return 0`);
    return 0;
  }

  // Resolve handler: caller-injected > default.
  const injected = deps.handlers?.[topic];
  const handler: (eventId: string) => Promise<void> = injected
    ?? ((evId): Promise<void> => DEFAULT_HANDLERS[topic]!(evId, log));

  try {
    await handler(eventId);
    return 0;
  } catch (e) {
    log(
      `cockpit-mirror: handler threw on topic=${topic} eventId=${eventId}: ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
    return 1;
  }
}

/** `atmux cockpit-mirror --status` — single-shot diagnostic. Surfaces
 *  the topic whitelist + handler-resolution state so operators can
 *  grep + understand wiring without diving into source. */
function cockpitMirrorStatus(log: (msg: string) => void): number {
  log("# atmux cockpit-mirror --status");
  log(`known-topics\t${KNOWN_TOPICS.size}`);
  for (const t of [...KNOWN_TOPICS].sort()) {
    log(`topic\t${t}\tstub (handler follow-up pending)`);
  }
  return 0;
}

// Re-export error types so `cli.ts`'s dispatch surface sees the right
// shape on import without round-tripping through errors.ts.
export { ConfigError, UsageError };
