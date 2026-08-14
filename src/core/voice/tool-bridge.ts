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
// Logging discipline: nothing in a voice path may write to
// `process.stdout` (it is capture-owned while a verb runs); any
// diagnostics belong on `process.stderr`. This module emits none.
//
// `argsJson` handling: an empty / whitespace-only string reads as `{}`
// (providers send "" for zero-arg tools); anything else must parse as a
// JSON object via `tryParseJsonString` (R3/ADR-006) or it's `bad_args`.

import { z } from "zod";
import { tryParseJsonString } from "../../abstractions/json.ts";
import {
  type CaptureVerbRunResult,
  captureVerbRun,
  type VerbFn,
  type VerbMutex,
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

export interface ToolBridge {
  executeTool(input: ExecuteToolInput): Promise<ExecuteToolOutput>;
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
        const preview = buildConfirmPreview(name, strippedArgs, teamName);
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
    const capturePromise = deps.mutex.run(() => capture(runner, argv));
    const raced = await Promise.race([
      capturePromise.then((r) => ({ kind: "done" as const, r })),
      deps.sleep(deps.config.toolTimeoutMs).then(() => ({ kind: "timeout" as const })),
    ]);
    if (raced.kind === "timeout") {
      // Swallow the eventual settle so a late rejection can't surface
      // as an unhandled rejection; the mutex still serializes.
      capturePromise.catch(() => {});
      return errorEnvelope(name, "tool_timeout", {
        timeoutMs: deps.config.toolTimeoutMs,
        message:
          "the tool is still running — this bounds the response, not the execution; the next tool queues behind it",
      });
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
  };
}
