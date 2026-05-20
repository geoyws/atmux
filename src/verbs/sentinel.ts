// ADR-132 §D3 / T8: sentinel verb — cockpit-level fleet-wide tick loop.
//
// Runs in cockpit W3 (sibling of medic at W2 per ADR-132 §D2). Iterates
// every enabled team in cockpit.json::sessions[type=team] per tick;
// resolves the per-team Sentinel impl from `team.json::sentinel` (or
// `cockpit.defaultSentinel`, or hard-coded `"claude"`); calls
// `observe → decide → apply` per ADR-132 §D1 interface.
//
// Sub-verbs:
//   - `atmux sentinel tick`    — one fleet-wide iteration (cron + /loop driver)
//   - `atmux sentinel status`  — last-tick snapshot per team (JSON to stdout)
//   - `atmux sentinel --once`  — single tick + exit (test / smoke harness)
//
// State snapshot at `~/.atmux/state/sentinel-state.json`:
//   {
//     "lastTickAt": <epoch-ms>,
//     "teams": {
//       "<team>": {
//         "impl": "claude" | "cursor",
//         "tickedAt": <epoch-ms>,
//         "actions": ["enter-push", ...],
//         "escalated": <bool>,
//         "error": "<message>"  // optional
//       }
//     }
//   }
//
// V1 wires the degenerate ClaudeSentinel impl only (T2). Subsequent
// sub-tasks (T3 CursorSentinel, T6 escalation classifier) compose by
// adding to `resolveSentinelImpl` + folding §D5 gates into the apply
// path.

import { join } from "node:path";
import { z } from "zod";
import { ensureDir, exists } from "../abstractions/fs.ts";
import { readJson, writeJson } from "../abstractions/json.ts";
import type { Observation, Sentinel } from "../abstractions/sentinel.ts";
import { ClaudeSentinel } from "../abstractions/sentinels/claude.ts";
import {
  type CursorRunFn,
  type CursorSendKeysFn,
  CursorSentinel,
} from "../abstractions/sentinels/cursor.ts";
import { spawn as defaultSpawn } from "../abstractions/spawn.ts";
import { enabledTeams, type LoadCockpitOpts, loadCockpit } from "../core/cockpit.ts";
import { createLogger, type Logger } from "../core/tui.ts";
import { UsageError } from "../errors.ts";
import type { Cockpit, CockpitDefaultSentinel } from "../schema/cockpit.ts";

// ---------- Arg parsing ----------

export interface ParsedSentinelArgs {
  /** Sub-verb. `tick` = one fleet-wide iteration; `status` = print JSON
   *  snapshot; `--once` is a synonym for `tick` reserved for the test
   *  harness (kept distinct so future evolution can layer flags onto
   *  `tick` without breaking smoke calls). */
  subverb: "tick" | "status";
  /** Test injection — override the cockpit config path. */
  configPath?: string;
  /** Override the state-file path. Used by tests + by operators who
   *  want sentinel state on a different disk (e.g. a tmpfs cage). */
  statePath?: string;
}

export function parseSentinelArgs(args: ReadonlyArray<string>): ParsedSentinelArgs {
  // Default to `tick` when no sub-verb is given (the cron + /loop drivers
  // typically invoke `atmux sentinel` bare; explicit `tick` works too).
  let subverb: "tick" | "status" = "tick";
  let configPath: string | undefined;
  let statePath: string | undefined;
  let i = 0;
  if (args.length > 0 && args[0] !== undefined && !args[0].startsWith("-")) {
    const sub = args[0];
    if (sub === "tick" || sub === "status") {
      subverb = sub;
      i = 1;
    } else {
      throw new UsageError({
        what: `sentinel: unknown sub-verb: ${sub}`,
        hint: "supported: 'tick' (default) or 'status'. `--once` is a flag on `tick`.",
      });
    }
  }
  while (i < args.length) {
    const a = args[i] ?? "";
    switch (a) {
      case "--once":
        // `--once` is an explicit-single-tick marker; behaviourally
        // identical to bare `tick`. Surfaces in tests + cron lines that
        // want self-documenting semantics.
        i += 1;
        break;
      case "--config": {
        const val = args[i + 1];
        if (val === undefined || val.length === 0) {
          throw new UsageError({
            what: "sentinel: --config requires a value",
            hint: "usage: atmux sentinel [tick|status] [--config <path>] [--state <path>]",
          });
        }
        configPath = val;
        i += 2;
        break;
      }
      case "--state": {
        const val = args[i + 1];
        if (val === undefined || val.length === 0) {
          throw new UsageError({
            what: "sentinel: --state requires a value",
            hint: "usage: atmux sentinel [tick|status] [--config <path>] [--state <path>]",
          });
        }
        statePath = val;
        i += 2;
        break;
      }
      default:
        throw new UsageError({
          what: `sentinel: unknown arg: ${a}`,
          hint: "see 'atmux sentinel --help'",
        });
    }
  }
  const out: ParsedSentinelArgs = { subverb };
  if (configPath !== undefined) out.configPath = configPath;
  if (statePath !== undefined) out.statePath = statePath;
  return out;
}

// ---------- State snapshot ----------

/** Per-team sentinel tick outcome — populated by `sentinelTick` for
 *  every enabled team it iterated. Operators consume via
 *  `atmux sentinel status` (JSON dump) + the cockpit W3 prompt. */
// Type alias for per-team state declared below the schema (Zod-inferred).
// See SentinelTeamState near the bottom of the schema region.

/** Fleet-wide snapshot — one per `sentinel tick`. Operators read via
 *  `atmux sentinel status` to debug the loop. */
/** Per-team sentinel tick outcome — populated by `sentinelTick` for
 *  every enabled team it iterated. Operators consume via
 *  `atmux sentinel status` (JSON dump) + the cockpit W3 prompt. */
export type SentinelTeamState = z.infer<typeof SentinelStateSchema>["teams"][string];

/** Fleet-wide snapshot — one per `sentinel tick`. Operators read via
 *  `atmux sentinel status` to debug the loop. */
export type SentinelState = z.infer<typeof SentinelStateSchema>;

/** Zod schema for the state file — used by `readJson` to validate
 *  on disk so a corrupted state.json surfaces a clear error rather
 *  than silent type drift. */
export const SentinelStateSchema = z.object({
  lastTickAt: z.number(),
  teams: z.record(
    z.string(),
    z.object({
      impl: z.enum(["claude", "cursor"]),
      tickedAt: z.number(),
      actions: z.array(z.string()),
      escalated: z.boolean(),
      error: z.string().optional(),
    }),
  ),
});

/** Default state snapshot path: `<home>/.atmux/state/sentinel-state.json`. */
export function defaultSentinelStatePath(home: string): string {
  return join(home, ".atmux", "state", "sentinel-state.json");
}

// ---------- Impl resolution (ADR-132 §D6) ----------

/** Resolve which Sentinel impl serves a given team. Precedence per
 *  ADR-132 §D6: per-team `team.json::sentinel` beats cockpit-level
 *  `cockpit.defaultSentinel` beats hard-coded `"claude"`.
 *
 *  T8 ships the degenerate ClaudeSentinel only — CursorSentinel
 *  ships in T3. When a config selects `"cursor"` on this version,
 *  the resolver falls back to `"claude"` with a warn so the cluster
 *  keeps moving rather than failing closed. T3 deletes the fallback
 *  and adds the real cursor impl. */
export function resolveSentinelImplName(opts: {
  team: { sentinel?: CockpitDefaultSentinel | undefined };
  cockpit: { defaultSentinel?: CockpitDefaultSentinel | undefined };
  logger: Logger;
}): CockpitDefaultSentinel {
  const teamPick = opts.team.sentinel;
  if (teamPick !== undefined) return teamPick;
  const cockpitPick = opts.cockpit.defaultSentinel;
  if (cockpitPick !== undefined) return cockpitPick;
  return "claude";
}

/** Construct a Sentinel instance for a given impl name. T3 (t-e96d286a)
 *  added the CursorSentinel branch — when impl=cursor, the verb wires
 *  the default `cursor-agent --print --output-format json` shell-out
 *  via the `defaultRunCursorAgent` factory below. The factory closes
 *  over `cockpit.sentinel.cursorBinPath` (when present) so per-cockpit
 *  binary overrides land without restructuring `buildSentinel`'s
 *  signature.
 *
 *  Send-keys for cursor's apply() is left UNWIRED at this verb-layer
 *  (defaults to absent — apply() returns success=false with diagnostic
 *  evidence). The cockpit-W3 dispatcher (T8 follow-up) wires a real
 *  tmux send-keys closure once it owns the per-team window-target
 *  resolution; for the verb's bare `sentinel tick` invocation the
 *  observation+escalation path is the load-bearing surface. */
export function buildSentinel(
  implName: CockpitDefaultSentinel,
  deps: {
    observeFn: (team: string) => Promise<Observation>;
    logger: Logger;
    /** Optional cockpit config — when present and `cockpit.sentinel.impl
     *  === "cursor"`, the cursor binary path + model are sourced from
     *  the resolved discriminated-union variant. Omit for tests + the
     *  hardcoded-default path. */
    cockpit?: Cockpit;
    /** Test injection — override the cursor-agent spawn-fn. Defaults to
     *  the shell-out factory below. */
    runCursorAgent?: CursorRunFn;
    /** Test / dispatcher injection — wire tmux send-keys for cursor's
     *  apply() side-effect. */
    sendKeys?: CursorSendKeysFn;
  },
): Sentinel {
  if (implName === "claude") {
    return new ClaudeSentinel({ observeFn: deps.observeFn });
  }
  if (implName === "cursor") {
    const cursorCfg = deps.cockpit?.sentinel?.impl === "cursor" ? deps.cockpit.sentinel : undefined;
    const binPath = cursorCfg?.cursorBinPath ?? "/usr/local/bin/cursor-agent";
    const model = cursorCfg?.model ?? "composer-2-fast";
    const runCursorAgent = deps.runCursorAgent ?? defaultRunCursorAgent(binPath);
    const ctorDeps: ConstructorParameters<typeof CursorSentinel>[0] = {
      observeFn: deps.observeFn,
      runCursorAgent,
      model,
    };
    if (deps.sendKeys !== undefined) ctorDeps.sendKeys = deps.sendKeys;
    return new CursorSentinel(ctorDeps);
  }
  // Unknown impl literal — TS narrows this to `never` once `claude` and
  // `cursor` are handled, but keep an exhaustive branch for forward-
  // compat (a future impl literal would land here as `never` and the
  // `as string` cast surfaces the mistake at the warn site rather than
  // crashing the fleet tick).
  deps.logger.warn(
    `sentinel: impl "${implName as string}" not recognised on this version; falling back to "claude" (degenerate).`,
  );
  return new ClaudeSentinel({ observeFn: deps.observeFn });
}

/** Default `runCursorAgent` factory — shells out to `cursor-agent
 *  --print --output-format json --model <model> --force <prompt>` via
 *  the shared `spawn()` abstraction. Returns the raw stdout string for
 *  CursorSentinel's envelope parser to consume.
 *
 *  60s timeout — composer-2-fast averages ~6s on a small prompt;
 *  belt-and-braces vs network flap. Non-zero exit codes are surfaced
 *  as a thrown SpawnError; CursorSentinel.decide()'s catch path
 *  re-routes to escalate-to-claude-lead so the broken-binary case
 *  stays observable. */
export function defaultRunCursorAgent(binPath: string): CursorRunFn {
  return async (args: string[]): Promise<string> => {
    const r = await defaultSpawn({
      cmd: binPath,
      argv: args,
      timeoutMs: 60_000,
      // Cursor exits non-zero on any error; let CursorSentinel's
      // envelope parser route via the is_error / unparseable paths
      // instead of throwing here (which would short-circuit the
      // fail-loud escalation path inside decide()).
      expectExitCode: "any",
    });
    return r.stdout;
  };
}

// ---------- Observation stub (T6/T7 wiring deferred) ----------

/** Degenerate Observation producer — T8 ships a minimal shape that
 *  carries through the `team` name + a `lastTickAt` timestamp.
 *  ClaudeSentinel wraps this verbatim into its escalate-to-claude-lead
 *  payload; the Claude lead's whip-prompt §1a continues to do all the
 *  real observation work in the degenerate config.
 *
 *  T6's escalation classifier + T7's full observation wiring replace
 *  this with the real pane-capture + kanban + commit-cadence read.
 *  Exposed for test injection. */
export function buildStubObservation(team: string): Promise<Observation> {
  return Promise.resolve(buildStubObservationSync(team));
}

function buildStubObservationSync(team: string): Observation {
  return {
    team,
    members: [],
    kanbanDelta: {
      newClaims: [],
      completedSinceLastTick: [],
      wedgedClaims: [],
    },
    commitCadence: {
      sinceLastTick: 0,
      last30min: 0,
      last2hr: 0,
    },
    lastTickAt: Date.now(),
  };
}

// ---------- Verb entry ----------

export interface SentinelOpts {
  /** Override `process.env`. Tests pass a curated subset. */
  env?: NodeJS.ProcessEnv;
  /** Logger sink override (default: `createLogger()`, stderr). */
  logger?: Logger;
  /** Test seam: override the observation producer. Default uses
   *  `buildStubObservation` (degenerate v1). T7's full wiring
   *  injects a real producer. */
  observeFn?: (team: string) => Promise<Observation>;
  /** Test seam: override `buildSentinel` for impl-construction
   *  customisation. Lets tests pass synthetic Sentinel instances
   *  asserting specific decide()/apply() behaviours. */
  buildSentinel?: typeof buildSentinel;
}

/** Top-level dispatch for `atmux sentinel <subverb>`. */
export async function sentinel(
  args: ReadonlyArray<string>,
  opts: SentinelOpts = {},
): Promise<number> {
  const parsed = parseSentinelArgs(args);
  switch (parsed.subverb) {
    case "tick":
      return await sentinelTick(parsed, opts);
    case "status":
      return await sentinelStatus(parsed, opts);
  }
}

/** Run one fleet-wide iteration. Iterates every enabled team in the
 *  loaded cockpit roster, resolves the per-team impl, runs
 *  observe → decide → apply (per-team try/catch so one team's failure
 *  doesn't wedge the fleet pass), persists the state snapshot. */
export async function sentinelTick(
  parsed: ParsedSentinelArgs,
  opts: SentinelOpts = {},
): Promise<number> {
  const env = opts.env ?? process.env;
  const logger = opts.logger ?? createLogger();
  const observe = opts.observeFn ?? buildStubObservation;
  const build = opts.buildSentinel ?? buildSentinel;

  const loadOpts: LoadCockpitOpts = { env };
  if (parsed.configPath !== undefined) loadOpts.path = parsed.configPath;
  const cockpit = await loadCockpit(loadOpts);

  // Iterate every enabled team-shape session (type: "team" OR
  // "epic-team"). The epic-team extension is ADR-183 §D1 — supersedes
  // ADR-132 §"Out of scope" §item-2 (was: "nested epic-teams excluded").
  // Cockpit-internal singletons (superdriver / medic / sentinel itself)
  // remain excluded; `enabledTeams` filters them by discriminator.
  //
  // Why the rollback: post-ADR-091 epic-team proliferation (12+ live
  // epic-teams across atmux/sopx/rentx at the change date) means the
  // original §"Out of scope" carve-out leaves silent-member-death holes
  // exactly in the layer that ships P0 work. The cursor-impl observe
  // path is `tmux capture-pane`-based, identical machinery for team +
  // epic-team panes — the exclusion was nomenclature-driven, not
  // capability-driven.
  //
  // Per-team override via `team.json::sentinel` (ADR-132 §D6) still
  // honoured downstream — an epic-team can opt out by setting its
  // sentinel field to "disabled" once T3 wires the per-team read path.
  const teams = enabledTeams(cockpit);
  if (teams.length === 0) {
    logger.warn("sentinel: no enabled teams in cockpit.json — tick is a no-op");
    // Still persist the lastTickAt so `status` is honest about when the
    // loop ran (vs "never started").
    await persistState({ lastTickAt: Date.now(), teams: {} }, env, parsed.statePath);
    return 0;
  }

  const teamStates: Record<string, SentinelTeamState> = {};
  const tickStarted = Date.now();
  for (const team of teams) {
    const implName = resolveSentinelImplName({
      // The team's `team.json::sentinel` field is resolved at impl-side
      // via `loadTeam` per ADR-132 §D6, but T8 ships fleet-default-only
      // resolution to keep the dep graph minimal. T3 wires per-team
      // override read. For now, treat per-team field as undefined.
      team: { sentinel: undefined },
      cockpit: { defaultSentinel: cockpit.defaultSentinel },
      logger,
    });
    const m = build(implName, { observeFn: observe, logger, cockpit });

    const actions: string[] = [];
    let escalated = false;
    let error: string | undefined;
    try {
      const obs = await m.observe(team.name);
      const decided = await m.decide(obs);
      escalated =
        m.shouldEscalateToClaudeLead(obs) ||
        decided.some((a) => a.kind === "escalate-to-claude-lead");
      for (const action of decided) {
        actions.push(action.kind);
        // Escalation is terminal at the dispatcher; never call apply()
        // for it (the impl interface contract per ADR-132 §D1).
        if (action.kind === "escalate-to-claude-lead") continue;
        try {
          const result = await m.apply(action);
          if (!result.success) {
            logger.warn(
              `sentinel: ${team.name}: apply(${action.kind}) returned success=false — ${result.evidence}`,
            );
          }
        } catch (e) {
          const cause = e instanceof Error ? e.message : String(e);
          logger.warn(`sentinel: ${team.name}: apply(${action.kind}) threw — ${cause}`);
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      logger.warn(`sentinel: ${team.name}: tick failed — ${error}`);
    }

    const state: SentinelTeamState = {
      impl: implName,
      tickedAt: Date.now(),
      actions,
      escalated,
    };
    if (error !== undefined) state.error = error;
    teamStates[team.name] = state;
  }

  await persistState({ lastTickAt: tickStarted, teams: teamStates }, env, parsed.statePath);
  logger.log(
    `sentinel: tick completed (${teams.length} team${teams.length === 1 ? "" : "s"}, ${Date.now() - tickStarted}ms)`,
  );
  return 0;
}

/** Print the last-tick state snapshot to stdout as JSON. Exit 0 even
 *  when no state file exists — `status` is a read; absence is one of
 *  the answers ("never run"). */
export async function sentinelStatus(
  parsed: ParsedSentinelArgs,
  opts: SentinelOpts = {},
): Promise<number> {
  const env = opts.env ?? process.env;
  const path = resolveStatePath(env, parsed.statePath);
  if (!(await exists(path))) {
    // Emit an empty-shape snapshot so consumers (cockpit dashboard, cron
    // probe) don't have to special-case absence.
    process.stdout.write(`${JSON.stringify({ lastTickAt: 0, teams: {} }, null, 2)}\n`);
    return 0;
  }
  const state = await readJson(path, SentinelStateSchema);
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
  return 0;
}

// ---------- Internals ----------

function resolveStatePath(env: NodeJS.ProcessEnv, override: string | undefined): string {
  if (override !== undefined && override.length > 0) return override;
  const fromEnv = env.ATMUX_SENTINEL_STATE;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const home = env.HOME;
  if (home === undefined || home.length === 0) {
    // Fall back to /tmp so the verb doesn't crash on $HOME-less environments
    // (e.g. some CI runners, container init shells).
    return "/tmp/atmux-sentinel-state.json";
  }
  return defaultSentinelStatePath(home);
}

async function persistState(
  state: SentinelState,
  env: NodeJS.ProcessEnv,
  override: string | undefined,
): Promise<void> {
  const path = resolveStatePath(env, override);
  await ensureDir(join(path, ".."));
  await writeJson(path, SentinelStateSchema, state);
}
