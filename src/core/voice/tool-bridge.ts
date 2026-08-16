// ADR-272: voice operator interface — the tool-bridge enforcement
// pipeline (D2 verb-only capability, D3 driver grant caution, D6 frozen
// surface, D7 server-enforced confirmation).
//
// `executeTool` NEVER throws: a throw here strands the provider's tool
// turn (the model waits forever for a result that isn't coming), so
// every failure — unknown tool, bad args, team miss, readonly, missing
// confirmation, timeout, verb failure, even an internal bug — renders
// as a typed `{"ok":false,...}` envelope the model can speak.
//
// Serialization: every verb execution goes through the injected
// `VerbMutex` because the capture wrapper monkeypatches
// `process.stdout.write` (see src/core/verb-capture.ts header). The
// tool TIMEOUT bounds the RESPONSE, not the execution: on timeout the
// envelope returns immediately, but the capture is NOT abandoned
// mid-monkeypatch — the mutex slot completes when the verb actually
// finishes (stdout restore is guaranteed by the capture's `finally`),
// and the next tool simply queues behind it.
//
// The wedge, why `health()` exists, and how the lane now RECOVERS. The
// timeout above bounds the RESPONSE, not the EXECUTION — deliberately, so
// a slow verb does not get its stdout capture abandoned mid-monkeypatch.
// The cost is that a verb which NEVER returns holds the mutex: none of
// the wired verbs calls `process.exit`, so the process does not crash.
//
// Voice runs unattended in a detached tmux session, so the service being
// functionally dead while `/healthz` answered `{"ok":true}` was worse than
// having no health check: it actively misled whatever read it. `health()`
// is that honest signal, and it is UNCHANGED — `wedged` still comes from
// how long the holder has held, `stuckTool` still names it.
//
// What changed (ADR-272 §Supplement-P7 §R2) is that reporting is no longer
// the ONLY outcome. The lane's queue is bounded and carries an abandon
// deadline, so:
//   - a caller past the cap is refused immediately, with the stuck verb
//     NAMED — more diagnosis than the bare timeout it used to get;
//   - every `tool_timeout` now carries `reason` + `stuckTool`, so "my verb
//     is slow" and "the lane is stuck" stop looking identical;
//   - a caller whose deadline passed while queued is SKIPPED rather than
//     run late, so the queue drains the moment a stuck verb returns
//     instead of grinding through answers nobody is waiting for. For the
//     mutating tools P7 enables, that also prevents a `dispatch_task`
//     firing minutes after the operator was told it timed out.
// A verb that never returns at all still holds the lane — the capture
// wrapper cannot run two verbs concurrently — so `atmux voice --stop`
// remains the cure for that. Everything behind it now survives.
//
// Logging discipline: nothing in a voice path may write to
// `process.stdout` (it is capture-owned while a verb runs); any
// diagnostics belong on `process.stderr`. This module emits none.
//
// `argsJson` handling: an empty / whitespace-only string reads as `{}`
// (providers send "" for zero-arg tools); anything else must parse as a
// JSON object via `tryParseJsonString` (R3/ADR-006) or it's `bad_args`.

import { z } from "zod";
import { tryParseJsonString } from "../../abstractions/json.ts";
import { VerbMutexError } from "../../errors.ts";
import {
  type CaptureVerbRunResult,
  captureVerbRun,
  type VerbFn,
  type VerbMutex,
  type VerbMutexState,
} from "../verb-capture.ts";
import type { ConfirmStore } from "./confirm.ts";
import { capLinesStructural, summarizeTool } from "./summarize.ts";
import { resolveTeamName, type VoiceTeamIndex } from "./team-context.ts";
import { isTeamScoped, type VoiceRunnerKey, type VoiceToolEntry } from "./tool-catalog.ts";

/** Verb runner — the injected verb function (P4 lazy-imports modules). */
export type VerbRunner = VerbFn;

export interface ToolBridgeDeps {
  catalog: ReadonlyArray<VoiceToolEntry>;
  runners: Partial<Record<VoiceRunnerKey, VerbRunner>>;
  teamIndex: VoiceTeamIndex;
  confirmStore: ConfirmStore;
  mutex: VerbMutex;
  config: { readonly: boolean; toolTimeoutMs: number; maxResultChars: number };
  /** Monotonic-enough ms clock (injected; fake in tests). */
  clock: () => number;
  /** Timeout sleeper (injected; controllable in tests). */
  sleep: (ms: number) => Promise<void>;
  /** Capture override (defaults to {@link captureVerbRun}). */
  capture?: (verb: VerbRunner, args: ReadonlyArray<string>) => Promise<CaptureVerbRunResult>;
}

export interface ExecuteToolInput {
  name: string;
  argsJson: string;
  sessionId: string;
  /** The session's current team NAME (null = none selected yet). */
  currentTeam: string | null;
}

export interface ExecuteToolOutput {
  envelopeJson: string;
  /** Present when the envelope is a `needs_confirmation` — the preview
   *  the model must read aloud verbatim, plus the redeem token. */
  needsConfirmation?: { token: string; preview: string };
}

/**
 * Multiple of `toolTimeoutMs` a verb may hold the mutex before the bridge
 * is called WEDGED.
 *
 * A tool that has held the lock past its own response deadline is merely
 * slow — that case is normal and already reported to the operator as a
 * `tool_timeout`. Holding it three times past that deadline is not slow;
 * nothing in the 14 wired verbs legitimately runs for a minute at the
 * default 20s timeout, and by then every later tool call has already been
 * answering `tool_timeout` for two full deadlines. Low enough to catch a
 * real wedge inside a minute; high enough that a genuinely slow `topo` on
 * a large fleet never trips it.
 */
export const WEDGE_THRESHOLD_MULTIPLE = 3;

/** Liveness of the verb-execution lane behind the bridge. */
export interface ToolBridgeHealth {
  /** The current mutex holder has exceeded {@link wedgeThresholdMs}. */
  wedged: boolean;
  /** The tool whose verb is stuck — null when nothing holds the mutex. */
  stuckTool: string | null;
  /** How long the current holder has held it (ms); null when idle. */
  heldMs: number | null;
  /** Tool calls queued behind the holder. Bounded by
   *  `VERB_MUTEX_MAX_QUEUE` since ADR-272 §Supplement-P7 §R2 — the wedge
   *  verdict above comes from `heldMs`, never from this number, so the
   *  bound costs the signal nothing. */
  queueDepth: number;
  /** The threshold `heldMs` is compared against. */
  wedgeThresholdMs: number;
}

export interface ToolBridge {
  executeTool(input: ExecuteToolInput): Promise<ExecuteToolOutput>;
  /** Is the verb lane healthy? Cheap + synchronous — `/healthz` calls it
   *  per probe. See the file header for what a wedge is. */
  health(): ToolBridgeHealth;
}

/** Error codes — the closed set every failure maps to. */
export type ToolErrorCode =
  | "bad_args"
  | "unknown_team"
  | "ambiguous_team"
  | "no_default_team"
  | "readonly_mode"
  | "needs_confirmation"
  | "confirm_expired"
  | "tool_timeout"
  | "verb_failed"
  | "verb_output_unparseable";

function errorEnvelope(
  tool: string,
  error: ToolErrorCode,
  extras: Record<string, unknown> = {},
): ExecuteToolOutput {
  return { envelopeJson: JSON.stringify({ ok: false, tool, error, ...extras }) };
}

/**
 * Why a `tool_timeout` envelope was produced. All four are the SAME error
 * code — the closed set in {@link ToolErrorCode} is unchanged — because
 * from the model's side they mean one thing: "this did not answer in
 * time". The distinction is for the operator, who needs to know whether
 * his tool is slow or the lane is stuck, and which verb is stuck.
 */
export type ToolTimeoutReason =
  /** Our own verb holds the lane and has not returned yet. */
  | "still_running"
  /** We never started: another tool still holds the lane. */
  | "queued_behind"
  /** The lane was at its queue cap — nothing was run at all. */
  | "queue_full"
  /** We waited past our own deadline and were skipped rather than run late. */
  | "abandoned";

/** Envelope for a lane refusal ({@link VerbMutexError}). The stuck verb is
 *  NAMED — that is the actionable half, and the difference between a
 *  bridge that confesses and one the operator can act on. */
function laneRefusalEnvelope(
  tool: string,
  e: VerbMutexError,
  timeoutMs: number,
): ExecuteToolOutput {
  const message =
    e.reason === "queue_full"
      ? `the verb lane is full (${e.queueDepth}/${e.queueCap} queued${e.blockedBy !== null ? ` behind '${e.blockedBy}'` : ""}) — this tool was NOT run; the lane is stuck, not slow`
      : `waited ${e.waitedMs}ms${e.blockedBy !== null ? ` behind '${e.blockedBy}'` : ""} without starting, so this tool was skipped rather than run after its deadline`;
  return errorEnvelope(tool, "tool_timeout", {
    reason: e.reason satisfies ToolTimeoutReason,
    timeoutMs,
    stuckTool: e.blockedBy,
    waitedMs: e.waitedMs,
    queueDepth: e.queueDepth,
    queueCap: e.queueCap,
    message,
  });
}

/** Envelope for the response deadline elapsing while the call is still
 *  live — either running (ours) or waiting (someone else's). */
function timeoutEnvelope(
  tool: string,
  started: boolean,
  state: VerbMutexState,
  now: number,
  config: { toolTimeoutMs: number },
): ExecuteToolOutput {
  const heldMs = state.heldSince === null ? null : now - state.heldSince;
  const reason: ToolTimeoutReason = started ? "still_running" : "queued_behind";
  const message = started
    ? "the tool is still running — this bounds the response, not the execution; the next tool queues behind it"
    : `never started — '${state.holder ?? "another tool"}' still holds the verb lane${heldMs !== null ? ` (${heldMs}ms)` : ""}; this call will be abandoned rather than run late`;
  return errorEnvelope(tool, "tool_timeout", {
    reason,
    timeoutMs: config.toolTimeoutMs,
    // The stuck verb, NAMED. Never its arguments: this envelope is spoken.
    stuckTool: state.holder,
    heldMs,
    queueDepth: state.queueDepth,
    message,
  });
}

/** Human preview line for a confirm-gated call — the model reads this
 *  aloud VERBATIM (instructions.ts pins that rule). */
export function buildConfirmPreview(
  toolName: string,
  args: Record<string, unknown>,
  team: string | null,
): string {
  const parts = Object.entries(args)
    .filter(([k]) => k !== "team")
    .map(([k, v]) => `${k} ${String(v)}`);
  const teamPart = team !== null ? ` on team ${team}` : "";
  const argsPart = parts.length > 0 ? `: ${parts.join(", ")}` : "";
  return `Confirm ${toolName.replace(/_/g, " ")}${argsPart}${teamPart}. Say yes to proceed.`;
}

/** Fit the whole envelope within `maxChars` by structurally shrinking
 *  `data` (whole trailing lines + marker) — never by corrupting the
 *  JSON. `build` receives the candidate data + a truncated flag. */
function envelopeWithinBudget(
  build: (data: string, truncated: boolean) => Record<string, unknown>,
  data: string,
  alreadyTruncated: boolean,
  maxChars: number,
): string {
  let json = JSON.stringify(build(data, alreadyTruncated));
  if (json.length <= maxChars) return json;
  const lines = data.split("\n");
  for (let keep = lines.length - 1; keep >= 0; keep -= 1) {
    const dropped = lines.length - keep;
    const candidate =
      keep === 0
        ? `… (+${dropped} more lines)`
        : `${lines.slice(0, keep).join("\n")}\n… (+${dropped} more lines)`;
    json = JSON.stringify(build(candidate, true));
    if (json.length <= maxChars) return json;
  }
  // Marker-only data still over budget (tiny maxChars): return the last
  // candidate — valid JSON beats a hard limit nobody can act on.
  return json;
}

/** Create the enforcement pipeline. See file header for the contract. */
export function createToolBridge(deps: ToolBridgeDeps): ToolBridge {
  const capture = deps.capture ?? captureVerbRun;
  const maxChars = deps.config.maxResultChars;

  async function executeToolInner(input: ExecuteToolInput): Promise<ExecuteToolOutput> {
    const { name, sessionId } = input;

    // 1 — tool lookup.
    const entry = deps.catalog.find((t) => t.name === name);
    if (entry === undefined) {
      return errorEnvelope(name, "bad_args", { message: `unknown tool: ${name}` });
    }

    // 2 — argsJson parse ("" reads as {}; see file header). A JSON
    // scalar / array / literal null all read as bad_args — the tool
    // args must be an object.
    const rawText = input.argsJson.trim() === "" ? "{}" : input.argsJson;
    const rawArgs = tryParseJsonString(rawText, z.unknown());
    if (rawArgs === null || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
      return errorEnvelope(name, "bad_args", { message: "arguments are not a JSON object" });
    }

    // 3 — Zod validation against the entry's params.
    const parsed = entry.params.safeParse(rawArgs);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      return errorEnvelope(name, "bad_args", { message: issues });
    }
    const args = parsed.data as Record<string, unknown>;

    // 4 — confirm_token split: strip before argv AND before binding.
    const confirmToken = typeof args.confirm_token === "string" ? args.confirm_token : undefined;
    const strippedArgs: Record<string, unknown> = { ...args };
    delete strippedArgs.confirm_token;

    // 5 — team resolution (team-scoped tools only).
    let teamName: string | null = null;
    let teamRoot: string | null = null;
    if (isTeamScoped(entry)) {
      const spoken = typeof strippedArgs.team === "string" ? strippedArgs.team : input.currentTeam;
      if (spoken === null) {
        return errorEnvelope(name, "no_default_team", {
          message: "no team named and no current team set — say which team",
        });
      }
      const resolved = resolveTeamName(deps.teamIndex, spoken);
      if (!resolved.ok) {
        if (resolved.reason === "ambiguous") {
          return errorEnvelope(name, "ambiguous_team", {
            team: spoken,
            candidates: resolved.candidates,
          });
        }
        return errorEnvelope(name, "unknown_team", { team: spoken });
      }
      teamName = resolved.team.name;
      teamRoot = resolved.team.root;
    }

    // 6 — readonly gate (ADR-272 §Security layer 5).
    if (entry.mutating && deps.config.readonly) {
      return errorEnvelope(name, "readonly_mode", {
        message: "mutations are disabled (readonly mode)",
      });
    }

    // 7 — server-enforced confirmation (ADR-272 D7). The binding hashes
    // the tool + canonicalized args WITH confirm_token stripped + the
    // session id, so a token minted for one action can never redeem
    // another.
    if (entry.confirm) {
      const binding = {
        tool: name,
        argsJson: JSON.stringify(strippedArgs),
        sessionId,
      };
      const issueFresh = (): ExecuteToolOutput => {
        const issued = deps.confirmStore.issue(binding);
        // Per-tool preview when the entry declares one (ADR-273 D4's
        // `pane_nudge` does — a preview that says only "confirm pane
        // nudge" would let a misheard member name through unnoticed);
        // the generic `<key> <value>` rendering otherwise.
        const preview =
          entry.preview?.(strippedArgs, teamName) ??
          buildConfirmPreview(name, strippedArgs, teamName);
        const out = errorEnvelope(name, "needs_confirmation", {
          token: issued.token,
          preview,
        });
        out.needsConfirmation = { token: issued.token, preview };
        return out;
      };
      if (confirmToken === undefined) return issueFresh();
      const redeem = deps.confirmStore.redeem(confirmToken, binding);
      if (!redeem.ok) {
        if (redeem.reason === "expired") {
          return errorEnvelope(name, "confirm_expired", {
            message: "confirmation expired — ask again to get a fresh prompt",
          });
        }
        // unknown / mismatch → fresh confirmation round-trip.
        return issueFresh();
      }
    }

    // 8 — core-direct read: list_teams is served from the index.
    if (entry.runnerKey === null) {
      const data =
        deps.teamIndex.teams.length === 0
          ? "(no teams)"
          : deps.teamIndex.teams.map((t) => `${t.name} (${t.type})`).join("\n");
      const envelopeJson = envelopeWithinBudget(
        (d, truncated) => ({ ok: true, tool: name, team: null, ms: 0, truncated, data: d }),
        data,
        false,
        maxChars,
      );
      return { envelopeJson };
    }

    // 9 — runner lookup + execution under the mutex, raced against the
    // timeout (response-bound only; see file header).
    const runner = deps.runners[entry.runnerKey];
    if (runner === undefined) {
      return errorEnvelope(name, "verb_failed", {
        message: `no runner wired for '${entry.runnerKey}' — voice server wiring bug`,
      });
    }
    const argv = entry.argv(strippedArgs, teamRoot);
    const start = deps.clock();
    // Labelled with the TOOL NAME (not its arguments — a label reaches
    // `/healthz`, and arguments carry what the operator said). This is
    // what lets a wedge be attributed instead of merely detected.
    //
    // `started` distinguishes "our verb is slow" from "we never got the
    // lane", which are different faults and must not share one message.
    let started = false;
    const capturePromise = deps.mutex.run(
      () => {
        started = true;
        return capture(runner, argv);
      },
      name,
      // A call whose response deadline has passed must not run late — see
      // VerbMutexRunOpts.abandonAfterMs.
      { abandonAfterMs: deps.config.toolTimeoutMs },
    );
    const raced = await Promise.race([
      capturePromise.then(
        (r) => ({ kind: "done" as const, r }),
        (e: unknown) => ({ kind: "rejected" as const, e }),
      ),
      deps.sleep(deps.config.toolTimeoutMs).then(() => ({ kind: "timeout" as const })),
    ]);
    if (raced.kind === "rejected") {
      // Only the lane's own refusals are rendered here. Anything else is
      // an internal bug and belongs in the outer catch, which says so.
      if (!(raced.e instanceof VerbMutexError)) throw raced.e;
      return laneRefusalEnvelope(name, raced.e, deps.config.toolTimeoutMs);
    }
    if (raced.kind === "timeout") {
      // Swallow the eventual settle so a late rejection can't surface
      // as an unhandled rejection; the mutex still serializes.
      capturePromise.catch(() => {});
      return timeoutEnvelope(name, started, deps.mutex.state(), deps.clock(), deps.config);
    }
    const result = raced.r;
    const ms = deps.clock() - start;

    // 10 — verb failure (thrown, or nonzero exit).
    if (result.errorMessage !== undefined || result.exitCode !== 0) {
      const summary = summarizeTool(name, result.stdout, { maxChars });
      const extras: Record<string, unknown> = { exitCode: result.exitCode };
      if (result.errorMessage !== undefined) extras.message = result.errorMessage;
      const envelopeJson = envelopeWithinBudget(
        (d, _t) => ({ ok: false, tool: name, error: "verb_failed", ...extras, data: d }),
        summary.data,
        summary.truncated,
        maxChars,
      );
      return { envelopeJson };
    }

    // 11 — generic `limit` cap: entries declaring a numeric `limit`
    // param (list_tasks) cap the captured output to one header line +
    // `limit` rows before summarization, so the spoken slice honours
    // the model's requested size.
    let stdout = result.stdout;
    let limitCut = false;
    if (typeof strippedArgs.limit === "number") {
      const cap = capLinesStructural(stdout, 1 + strippedArgs.limit);
      stdout = cap.text;
      limitCut = cap.dropped > 0;
    }

    // 12 — summarize + budget-fit the success envelope.
    const summary = summarizeTool(name, stdout, { maxChars });
    if (summary.data.trim() === "") {
      return errorEnvelope(name, "verb_output_unparseable", {
        message: "the verb produced no usable output",
      });
    }
    const envelopeJson = envelopeWithinBudget(
      (d, truncated) => ({ ok: true, tool: name, team: teamName, ms, truncated, data: d }),
      summary.data,
      summary.truncated || limitCut,
      maxChars,
    );
    return { envelopeJson };
  }

  const wedgeThresholdMs = deps.config.toolTimeoutMs * WEDGE_THRESHOLD_MULTIPLE;

  return {
    async executeTool(input: ExecuteToolInput): Promise<ExecuteToolOutput> {
      try {
        return await executeToolInner(input);
      } catch (e) {
        // NEVER throw past this boundary (see file header) — an internal
        // bug still answers the provider turn.
        const msg = e instanceof Error ? e.message : String(e);
        return errorEnvelope(input.name, "verb_failed", { message: `internal error: ${msg}` });
      }
    },

    health(): ToolBridgeHealth {
      const state = deps.mutex.state();
      const heldMs = state.heldSince === null ? null : deps.clock() - state.heldSince;
      return {
        wedged: heldMs !== null && heldMs > wedgeThresholdMs,
        stuckTool: state.holder,
        heldMs,
        queueDepth: state.queueDepth,
        wedgeThresholdMs,
      };
    },
  };
}
