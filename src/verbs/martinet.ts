// ADR-132 §D3 / T8: martinet verb — cockpit-level fleet-wide tick loop.
//
// Runs in cockpit W3 (sibling of medic at W2 per ADR-132 §D2). Iterates
// every enabled team in cockpit.json::sessions[type=team] per tick;
// resolves the per-team Martinet impl from `team.json::martinet` (or
// `cockpit.defaultMartinet`, or hard-coded `"claude"`); calls
// `observe → decide → apply` per ADR-132 §D1 interface.
//
// Sub-verbs:
//   - `atmux martinet tick`    — one fleet-wide iteration (cron + /loop driver)
//   - `atmux martinet status`  — last-tick snapshot per team (JSON to stdout)
//   - `atmux martinet --once`  — single tick + exit (test / smoke harness)
//
// State snapshot at `~/.atmux/state/martinet-state.json`:
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
// V1 wires the degenerate ClaudeMartinet impl only (T2). Subsequent
// sub-tasks (T3 CursorMartinet, T6 escalation classifier) compose by
// adding to `resolveMartinetImpl` + folding §D5 gates into the apply
// path.

import { join } from "node:path";
import { ensureDir, exists } from "../abstractions/fs.ts";
import { readJson, writeJson } from "../abstractions/json.ts";
import { z } from "zod";
import type { Martinet, Observation } from "../abstractions/martinet.ts";
import { ClaudeMartinet } from "../abstractions/martinets/claude.ts";
import {
  type CursorRunFn,
  type CursorSendKeysFn,
  CursorMartinet,
} from "../abstractions/martinets/cursor.ts";
import { spawn as defaultSpawn } from "../abstractions/spawn.ts";
import { type LoadCockpitOpts, loadCockpit } from "../core/cockpit.ts";
import { createLogger, type Logger } from "../core/tui.ts";
import { UsageError } from "../errors.ts";
import type { Cockpit, CockpitDefaultMartinet } from "../schema/cockpit.ts";

// ---------- Arg parsing ----------

export interface ParsedMartinetArgs {
  /** Sub-verb. `tick` = one fleet-wide iteration; `status` = print JSON
   *  snapshot; `--once` is a synonym for `tick` reserved for the test
   *  harness (kept distinct so future evolution can layer flags onto
   *  `tick` without breaking smoke calls). */
  subverb: "tick" | "status";
  /** Test injection — override the cockpit config path. */
  configPath?: string;
  /** Override the state-file path. Used by tests + by operators who
   *  want martinet state on a different disk (e.g. a tmpfs cage). */
  statePath?: string;
}

export function parseMartinetArgs(args: ReadonlyArray<string>): ParsedMartinetArgs {
  // Default to `tick` when no sub-verb is given (the cron + /loop drivers
  // typically invoke `atmux martinet` bare; explicit `tick` works too).
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
        what: `martinet: unknown sub-verb: ${sub}`,
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
            what: "martinet: --config requires a value",
            hint: "usage: atmux martinet [tick|status] [--config <path>] [--state <path>]",
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
            what: "martinet: --state requires a value",
            hint: "usage: atmux martinet [tick|status] [--config <path>] [--state <path>]",
          });
        }
        statePath = val;
        i += 2;
        break;
      }
      default:
        throw new UsageError({
          what: `martinet: unknown arg: ${a}`,
          hint: "see 'atmux martinet --help'",
        });
    }
  }
  const out: ParsedMartinetArgs = { subverb };
  if (configPath !== undefined) out.configPath = configPath;
  if (statePath !== undefined) out.statePath = statePath;
  return out;
}

// ---------- State snapshot ----------

/** Per-team martinet tick outcome — populated by `martinetTick` for
 *  every enabled team it iterated. Operators consume via
 *  `atmux martinet status` (JSON dump) + the cockpit W3 prompt. */
// Type alias for per-team state declared below the schema (Zod-inferred).
// See MartinetTeamState near the bottom of the schema region.

/** Fleet-wide snapshot — one per `martinet tick`. Operators read via
 *  `atmux martinet status` to debug the loop. */
/** Per-team martinet tick outcome — populated by `martinetTick` for
 *  every enabled team it iterated. Operators consume via
 *  `atmux martinet status` (JSON dump) + the cockpit W3 prompt. */
export type MartinetTeamState = z.infer<typeof MartinetStateSchema>["teams"][string];

/** Fleet-wide snapshot — one per `martinet tick`. Operators read via
 *  `atmux martinet status` to debug the loop. */
export type MartinetState = z.infer<typeof MartinetStateSchema>;

/** Zod schema for the state file — used by `readJson` to validate
 *  on disk so a corrupted state.json surfaces a clear error rather
 *  than silent type drift. */
export const MartinetStateSchema = z.object({
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

/** Default state snapshot path: `<home>/.atmux/state/martinet-state.json`. */
export function defaultMartinetStatePath(home: string): string {
  return join(home, ".atmux", "state", "martinet-state.json");
}

// ---------- Impl resolution (ADR-132 §D6) ----------

/** Resolve which Martinet impl serves a given team. Precedence per
 *  ADR-132 §D6: per-team `team.json::martinet` beats cockpit-level
 *  `cockpit.defaultMartinet` beats hard-coded `"claude"`.
 *
 *  T8 ships the degenerate ClaudeMartinet only — CursorMartinet
 *  ships in T3. When a config selects `"cursor"` on this version,
 *  the resolver falls back to `"claude"` with a warn so the cluster
 *  keeps moving rather than failing closed. T3 deletes the fallback
 *  and adds the real cursor impl. */
export function resolveMartinetImplName(opts: {
  team: { martinet?: CockpitDefaultMartinet | undefined };
  cockpit: { defaultMartinet?: CockpitDefaultMartinet | undefined };
  logger: Logger;
}): CockpitDefaultMartinet {
  const teamPick = opts.team.martinet;
  if (teamPick !== undefined) return teamPick;
  const cockpitPick = opts.cockpit.defaultMartinet;
  if (cockpitPick !== undefined) return cockpitPick;
  return "claude";
}

/** Construct a Martinet instance for a given impl name. T3 (t-e96d286a)
 *  added the CursorMartinet branch — when impl=cursor, the verb wires
 *  the default `cursor-agent --print --output-format json` shell-out
 *  via the `defaultRunCursorAgent` factory below. The factory closes
 *  over `cockpit.martinet.cursorBinPath` (when present) so per-cockpit
 *  binary overrides land without restructuring `buildMartinet`'s
 *  signature.
 *
 *  Send-keys for cursor's apply() is left UNWIRED at this verb-layer
 *  (defaults to absent — apply() returns success=false with diagnostic
 *  evidence). The cockpit-W3 dispatcher (T8 follow-up) wires a real
 *  tmux send-keys closure once it owns the per-team window-target
 *  resolution; for the verb's bare `martinet tick` invocation the
 *  observation+escalation path is the load-bearing surface. */
export function buildMartinet(
  implName: CockpitDefaultMartinet,
  deps: {
    observeFn: (team: string) => Promise<Observation>;
    logger: Logger;
    /** Optional cockpit config — when present and `cockpit.martinet.impl
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
): Martinet {
  if (implName === "claude") {
    return new ClaudeMartinet({ observeFn: deps.observeFn });
  }
  if (implName === "cursor") {
    const cursorCfg =
      deps.cockpit?.martinet?.impl === "cursor" ? deps.cockpit.martinet : undefined;
    const binPath = cursorCfg?.cursorBinPath ?? "/usr/local/bin/cursor-agent";
    const model = cursorCfg?.model ?? "composer-2-fast";
    const runCursorAgent = deps.runCursorAgent ?? defaultRunCursorAgent(binPath);
    const ctorDeps: ConstructorParameters<typeof CursorMartinet>[0] = {
      observeFn: deps.observeFn,
      runCursorAgent,
      model,
    };
    if (deps.sendKeys !== undefined) ctorDeps.sendKeys = deps.sendKeys;
    return new CursorMartinet(ctorDeps);
  }
  // Unknown impl literal — TS narrows this to `never` once `claude` and
  // `cursor` are handled, but keep an exhaustive branch for forward-
  // compat (a future impl literal would land here as `never` and the
  // `as string` cast surfaces the mistake at the warn site rather than
  // crashing the fleet tick).
  deps.logger.warn(
    `martinet: impl "${implName as string}" not recognised on this version; falling back to "claude" (degenerate).`,
  );
  return new ClaudeMartinet({ observeFn: deps.observeFn });
}

/** Default `runCursorAgent` factory — shells out to `cursor-agent
 *  --print --output-format json --model <model> --force <prompt>` via
 *  the shared `spawn()` abstraction. Returns the raw stdout string for
 *  CursorMartinet's envelope parser to consume.
 *
 *  60s timeout — composer-2-fast averages ~6s on a small prompt;
 *  belt-and-braces vs network flap. Non-zero exit codes are surfaced
 *  as a thrown SpawnError; CursorMartinet.decide()'s catch path
 *  re-routes to escalate-to-claude-lead so the broken-binary case
 *  stays observable. */
export function defaultRunCursorAgent(binPath: string): CursorRunFn {
  return async (args: string[]): Promise<string> => {
    const r = await defaultSpawn({
      cmd: binPath,
      argv: args,
      timeoutMs: 60_000,
      // Cursor exits non-zero on any error; let CursorMartinet's
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
 *  ClaudeMartinet wraps this verbatim into its escalate-to-claude-lead
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

export interface MartinetOpts {
  /** Override `process.env`. Tests pass a curated subset. */
  env?: NodeJS.ProcessEnv;
  /** Logger sink override (default: `createLogger()`, stderr). */
  logger?: Logger;
  /** Test seam: override the observation producer. Default uses
   *  `buildStubObservation` (degenerate v1). T7's full wiring
   *  injects a real producer. */
  observeFn?: (team: string) => Promise<Observation>;
  /** Test seam: override `buildMartinet` for impl-construction
   *  customisation. Lets tests pass synthetic Martinet instances
   *  asserting specific decide()/apply() behaviours. */
  buildMartinet?: typeof buildMartinet;
}

/** Top-level dispatch for `atmux martinet <subverb>`. */
export async function martinet(
  args: ReadonlyArray<string>,
  opts: MartinetOpts = {},
): Promise<number> {
  const parsed = parseMartinetArgs(args);
  switch (parsed.subverb) {
    case "tick":
      return await martinetTick(parsed, opts);
    case "status":
      return await martinetStatus(parsed, opts);
  }
}

/** Run one fleet-wide iteration. Iterates every enabled team in the
 *  loaded cockpit roster, resolves the per-team impl, runs
 *  observe → decide → apply (per-team try/catch so one team's failure
 *  doesn't wedge the fleet pass), persists the state snapshot. */
export async function martinetTick(
  parsed: ParsedMartinetArgs,
  opts: MartinetOpts = {},
): Promise<number> {
  const env = opts.env ?? process.env;
  const logger = opts.logger ?? createLogger();
  const observe = opts.observeFn ?? buildStubObservation;
  const build = opts.buildMartinet ?? buildMartinet;

  const loadOpts: LoadCockpitOpts = { env };
  if (parsed.configPath !== undefined) loadOpts.path = parsed.configPath;
  const cockpit = await loadCockpit(loadOpts);

  // Only iterate top-level enabled teams. Nested epic-teams + cockpit-
  // internal singletons (superdriver / medic / martinet itself) are
  // excluded — the martinet observes work-doing teams, not its
  // cockpit-tier siblings (ADR-132 §"Out of scope" — Martinet does NOT
  // observe cockpit-tier surfaces).
  const teams = (cockpit.teams ?? []).filter((t) => t.enabled);
  if (teams.length === 0) {
    logger.warn("martinet: no enabled teams in cockpit.json — tick is a no-op");
    // Still persist the lastTickAt so `status` is honest about when the
    // loop ran (vs "never started").
    await persistState(
      { lastTickAt: Date.now(), teams: {} },
      env,
      parsed.statePath,
    );
    return 0;
  }

  const teamStates: Record<string, MartinetTeamState> = {};
  const tickStarted = Date.now();
  for (const team of teams) {
    const implName = resolveMartinetImplName({
      // The team's `team.json::martinet` field is resolved at impl-side
      // via `loadTeam` per ADR-132 §D6, but T8 ships fleet-default-only
      // resolution to keep the dep graph minimal. T3 wires per-team
      // override read. For now, treat per-team field as undefined.
      team: { martinet: undefined },
      cockpit: { defaultMartinet: cockpit.defaultMartinet },
      logger,
    });
    const m = build(implName, { observeFn: observe, logger, cockpit });

    const actions: string[] = [];
    let escalated = false;
    let error: string | undefined;
    try {
      const obs = await m.observe(team.name);
      const decided = await m.decide(obs);
      escalated = m.shouldEscalateToClaudeLead(obs) ||
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
              `martinet: ${team.name}: apply(${action.kind}) returned success=false — ${result.evidence}`,
            );
          }
        } catch (e) {
          const cause = e instanceof Error ? e.message : String(e);
          logger.warn(`martinet: ${team.name}: apply(${action.kind}) threw — ${cause}`);
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      logger.warn(`martinet: ${team.name}: tick failed — ${error}`);
    }

    const state: MartinetTeamState = {
      impl: implName,
      tickedAt: Date.now(),
      actions,
      escalated,
    };
    if (error !== undefined) state.error = error;
    teamStates[team.name] = state;
  }

  await persistState(
    { lastTickAt: tickStarted, teams: teamStates },
    env,
    parsed.statePath,
  );
  logger.log(
    `martinet: tick completed (${teams.length} team${teams.length === 1 ? "" : "s"}, ${Date.now() - tickStarted}ms)`,
  );
  return 0;
}

/** Print the last-tick state snapshot to stdout as JSON. Exit 0 even
 *  when no state file exists — `status` is a read; absence is one of
 *  the answers ("never run"). */
export async function martinetStatus(
  parsed: ParsedMartinetArgs,
  opts: MartinetOpts = {},
): Promise<number> {
  const env = opts.env ?? process.env;
  const path = resolveStatePath(env, parsed.statePath);
  if (!(await exists(path))) {
    // Emit an empty-shape snapshot so consumers (cockpit dashboard, cron
    // probe) don't have to special-case absence.
    process.stdout.write(`${JSON.stringify({ lastTickAt: 0, teams: {} }, null, 2)}\n`);
    return 0;
  }
  const state = await readJson(path, MartinetStateSchema);
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
  return 0;
}

// ---------- Internals ----------

function resolveStatePath(env: NodeJS.ProcessEnv, override: string | undefined): string {
  if (override !== undefined && override.length > 0) return override;
  const fromEnv = env.ATMUX_MARTINET_STATE;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const home = env.HOME;
  if (home === undefined || home.length === 0) {
    // Fall back to /tmp so the verb doesn't crash on $HOME-less environments
    // (e.g. some CI runners, container init shells).
    return "/tmp/atmux-martinet-state.json";
  }
  return defaultMartinetStatePath(home);
}

async function persistState(
  state: MartinetState,
  env: NodeJS.ProcessEnv,
  override: string | undefined,
): Promise<void> {
  const path = resolveStatePath(env, override);
  await ensureDir(join(path, ".."));
  await writeJson(path, MartinetStateSchema, state);
}
