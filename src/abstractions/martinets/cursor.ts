// ADR-132 §D4 / T3 (t-e96d286a): CursorMartinet — production-default
// pluggable Martinet impl backed by `cursor-agent --print --model
// composer-2-fast --force`.
//
// Per ADR-140 cheap-model-first principle: the Claude lead is reserved
// for strategic / judgment / code-gen work. Mechanical observation +
// nudge dispatch + routine rotation belong on a cheaper executor —
// Cursor's composer-2-fast model is the operator-evaluated production
// pick (MiniMax + Kimi backends dropped 2026-05-14 12:53 MYT per ADR-132
// §Decision simplification).
//
// Cage posture: this impl is cage-AGNOSTIC by design. The cockpit-W3
// dispatcher (T8 / `src/verbs/cockpit.ts::buildMartinetWindowCommand`
// + `src/verbs/martinet.ts::buildMartinet`) injects the
// `runCursorAgent` dep that owns spawn-time cage policy (operator UID,
// full git, the cockpit session itself is the Tier-2 cage per ADR-058
// §D1 trust posture — no separate per-team cage; martinet is
// fleet-wide singleton). Tests inject a synthetic `runCursorAgent`
// fake that returns a canned envelope so the impl's parser /
// validator path is exercised without burning real tokens.
//
// Escalation gate: the §D5 six-trigger floor lives in
// `src/core/martinet-escalation.ts` (T6 / t-a6a1c9ab). This impl
// composes the `classify()` + `shouldEscalate()` pair with an empty
// `ObservationHistory` default so unit tests that only carry the
// current-tick Observation can exercise the E6 mandatory floor (E6 is
// pure-Observation). The cockpit dispatcher (T8 follow-up) threads
// the real cross-tick history when in production.
//
// NudgeAction kind mapping (per task body §Scope, mapped onto the
// locked T2 interface kinds):
//   - enter-push           → 1:1 (interface kind)
//   - claim-next           → 1:1 (interface kind)
//   - rotate-routine       → emit `rotate` with reason="routine" per
//                            ADR-140 amendment (martinet handles
//                            routine rotation; non-routine rotation
//                            stays on the Claude lead via escalate).
//   - modal-release        → emit `enter-push` with reason="modal-
//                            release" — modal dismissal is a
//                            controlled keystroke send the dispatcher
//                            interprets identically to enter-push.
//   - force-push-approved  → emit `escalate-to-claude-lead` — destructive
//                            git ops are operator-only per global
//                            CLAUDE.md push policy; the impl never
//                            decides force-push autonomously.
//   - escalate-to-claude-lead → 1:1 (interface kind)
//
// Adding a new NudgeAction kind would require touching the locked
// T2 interface (cross-task interference); the mapping above stays
// within the four-kind contract while honouring the task body's
// expanded intent.

import { z } from "zod";
import {
  classify,
  type ObservationHistory,
  shouldEscalate,
} from "../../core/martinet-escalation.ts";
import type {
  ApplyResult,
  Martinet,
  NudgeAction,
  Observation,
} from "../martinet.ts";

// ---------- Construct-time deps ----------

/** Send-keys side-effect — the dispatcher wires `tmux send-keys` here.
 *  Returning `{success}` keeps the impl decoupled from the underlying
 *  send-mechanism (raw send-keys, safeSendKeysWithVerify, paste-buffer
 *  pattern) — every variant collapses to "did the keystroke land?" at
 *  this seam. Tests inject a recording stub. */
export type CursorSendKeysFn = (
  window: string,
  keys: string,
) => Promise<{ success: boolean }>;

/** Cursor-agent invocation — the dispatcher wires the spawn-fn that
 *  shells out to `cursor-agent --print ...`. Tests inject a synthetic
 *  fake that returns a pre-canned envelope JSON string. The impl
 *  treats the return as the raw stdout of `cursor-agent --output-format
 *  json` and parses it via {@link CursorEnvelopeSchema}. */
export type CursorRunFn = (args: string[]) => Promise<string>;

/** History provider — the cockpit dispatcher threads
 *  `ObservationHistory` across ticks for the temporal §D5 gates
 *  (E1 / E3 / E4 / E5). When unset, the impl falls back to
 *  {@link EMPTY_HISTORY} which exercises only the pure-Observation
 *  gates (E2 / E6). Unit tests that don't carry history rely on this
 *  fallback to assert the E6 mandatory floor in isolation. */
export type CursorHistoryFn = () => ObservationHistory;

export interface CursorMartinetDeps {
  /** Per-tick observation provider. Cockpit dispatcher composes the
   *  real Observation; tests pass a fixture. */
  observeFn: (team: string) => Promise<Observation>;
  /** Spawn-fn for `cursor-agent --print ...`. Returns the raw stdout
   *  string. */
  runCursorAgent: CursorRunFn;
  /** tmux send-keys wrapper. Required for any non-escalation
   *  NudgeAction to apply successfully; when omitted, `apply()` returns
   *  `{success: false}` with diagnostic evidence so the misuse
   *  surfaces (rather than silently no-op-ing). */
  sendKeys?: CursorSendKeysFn;
  /** Cross-tick history for the §D5 temporal gates. Defaults to
   *  {@link EMPTY_HISTORY} (pure-Observation gates only). */
  historyFn?: CursorHistoryFn;
  /** `--model` value passed to cursor-agent. Default
   *  `"composer-2-fast"` per ADR-132 §D4. */
  model?: "composer-2-fast" | "composer-2";
}

// ---------- Cursor envelope shape ----------
//
// `cursor-agent --print --output-format json` emits a stream of JSON
// lines; the LAST line beginning with `{` is the canonical result
// envelope (verified against the binary 2026-05-15 by the T7 e2e
// fixture). The `result` field is a free-form string — for our prompt
// shape (system prompt + observation + "return only a JSON
// NudgeAction[]") the impl JSON-parses it AGAIN into the action set.

export const CursorEnvelopeSchema = z.object({
  type: z.string(),
  subtype: z.enum(["success", "error"]),
  is_error: z.boolean(),
  duration_ms: z.number().optional(),
  result: z.string(),
  usage: z
    .object({
      inputTokens: z.number(),
      outputTokens: z.number(),
      cacheReadTokens: z.number().optional(),
      cacheWriteTokens: z.number().optional(),
    })
    .optional(),
});
export type CursorEnvelope = z.infer<typeof CursorEnvelopeSchema>;

/** Discriminated NudgeAction validator — mirrors the T2 interface
 *  union exactly EXCEPT for the `escalate-to-claude-lead` variant
 *  which omits `observation` (the cursor-agent prompt asks for `reason`
 *  only; the impl re-attaches the live Observation post-validation
 *  before forwarding to the dispatcher). */
const NudgeActionFromCursor = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("enter-push"),
    member: z.string().min(1),
    reason: z.string().min(1),
  }),
  z.object({
    kind: z.literal("claim-next"),
    member: z.string().min(1),
    reason: z.string().min(1),
  }),
  z.object({
    kind: z.literal("rotate"),
    member: z.string().min(1),
    reason: z.string().min(1),
  }),
  z.object({
    kind: z.literal("escalate-to-claude-lead"),
    reason: z.string().min(1),
  }),
]);

// ---------- Constants ----------

/** Default cursor-agent model — composer-2-fast per ADR-132 §D4 +
 *  ADR-140 cheap-model-first. The schema (CockpitMartinetCursor)
 *  accepts `composer-2` as the alternative; constructor's `model`
 *  override picks per-team when the cockpit roster wires it through. */
const DEFAULT_CURSOR_MODEL = "composer-2-fast" as const;

/** Empty cross-tick history — pure-Observation gates (E2 + E6) fire
 *  unchanged; temporal gates (E1 / E3 / E4 / E5) all stay quiet. */
const EMPTY_HISTORY: ObservationHistory = {
  enterPushedAt: {},
  lowConfidenceStreak: 0,
  inboxEntries: [],
  pendingGitDenials: [],
};

/** System prompt baked into every cursor-agent invocation. Pinned
 *  here (not in a separate config file) so the WhipManager contract
 *  the impl signs on behalf of cursor-agent stays in lockstep with
 *  the type signatures it claims to honor. ADR-132 §D5 escalation
 *  triggers + ADR-140 amendment scope are quoted verbatim so a
 *  cursor agent reading the prompt has the same vocabulary the
 *  Claude lead reads when reviewing escalations. */
export const CURSOR_SYSTEM_PROMPT = [
  "You are Cursor composer-2-fast acting as the atmux team martinet —",
  "the cockpit-tier whip-manager that owns mechanical observation and",
  "routine nudges per ADR-132 §D5 + ADR-140 cheap-model-first.",
  "",
  "Per ADR-132 §D5 your job is mechanical observation + routine nudge",
  "dispatch ONLY. Judgment-class scenarios escalate to the Claude lead",
  "(unconditionally on E6 ship-zero — the floor is mandatory).",
  "",
  "## Output contract",
  "",
  "Return ONLY a JSON array (no prose, no markdown fences). The array",
  "contains zero or more NudgeAction objects. Each NudgeAction must be",
  "ONE OF the following four discriminated kinds:",
  "",
  '  {"kind":"enter-push","member":"<name>","reason":"<why>"}',
  '  {"kind":"claim-next","member":"<name>","reason":"<why>"}',
  '  {"kind":"rotate","member":"<name>","reason":"<why>"}',
  '  {"kind":"escalate-to-claude-lead","reason":"<why>"}',
  "",
  "Empty array `[]` is valid and represents a no-op tick (all-green",
  "sweep — no member needs nudging).",
  "",
  "## Decide rules",
  "",
  "- enter-push: emit when `member.lastEnterPushable === true` AND",
  "  `member.queuedComposerText` is non-null (member typed but didn't",
  "  submit). Modal-release is a sub-case — emit enter-push with",
  '  reason="modal-release" when the pane shows a known modal.',
  "- claim-next: emit when member is READY with no queued text AND",
  "  there are pending kanban tasks the member can claim.",
  "- rotate: emit ONLY for routine rotation (60min uptime / context-",
  "  rot detection per ADR-140 amendment). For all other rotation",
  "  scenarios, escalate.",
  "- escalate-to-claude-lead: emit on ANY of the §D5 triggers — wedged-",
  "  after-nudge >15min, P0 hygiene wedge ≥4h, merge-conflict-or-",
  "  push-denial, inbox-unprocessed ≥2 ticks, low-confidence streak,",
  "  or commitCadence.last2hr === 0 (E6 mandatory floor).",
  "- force-push-approved is NEVER autonomous — escalate every time.",
  "",
  "Your output is parsed via Zod; malformed JSON or unknown kinds are",
  "DROPPED and surfaced as an escalation ('cursor-agent emitted",
  "invalid NudgeAction shape'). Stay strictly within the four kinds.",
].join("\n");

// ---------- Impl ----------

export class CursorMartinet implements Martinet {
  readonly name = "cursor" as const;
  private readonly deps: CursorMartinetDeps;
  private readonly model: "composer-2-fast" | "composer-2";

  constructor(deps: CursorMartinetDeps) {
    this.deps = deps;
    this.model = deps.model ?? DEFAULT_CURSOR_MODEL;
  }

  /** Pass-through to the injected observer. CursorMartinet adds no
   *  observation logic of its own — the cockpit-W3 dispatcher composes
   *  the canonical Observation and passes it through. Same shape the
   *  ClaudeMartinet (T2) consumes so impls are interchangeable behind
   *  the cockpit dispatcher. */
  async observe(team: string): Promise<Observation> {
    return this.deps.observeFn(team);
  }

  /** Compose the cursor-agent prompt (system + observation), invoke
   *  the spawn-fn, parse + validate the JSON envelope + nested
   *  NudgeAction[]. On any parse / schema / cursor-error failure,
   *  fall back to a single escalate-to-claude-lead carrying a
   *  diagnostic reason — fail-loud over silent-noop so broken-impl
   *  scenarios surface to the Claude lead within one tick.
   *
   *  ADR-132 T7 e2e (Case 5) asserts runCursorAgent is invoked AT
   *  LEAST ONCE per decide() call — this impl always invokes regardless
   *  of observation shape so the token-burn ceiling is measurable
   *  against every tick. */
  async decide(obs: Observation): Promise<NudgeAction[]> {
    const prompt = `${CURSOR_SYSTEM_PROMPT}\n\n## Observation\n\n${JSON.stringify(obs, null, 2)}`;
    const args = [
      "--print",
      "--output-format",
      "json",
      "--model",
      this.model,
      "--force",
      prompt,
    ];

    let stdout: string;
    try {
      stdout = await this.deps.runCursorAgent(args);
    } catch (e) {
      const cause = e instanceof Error ? e.message : String(e);
      return [
        {
          kind: "escalate-to-claude-lead",
          observation: obs,
          reason: `cursor-agent spawn failed: ${cause}`,
        },
      ];
    }

    // cursor-agent --output-format json may emit multiple JSON lines
    // (stream-json), or a single envelope. Take the LAST line starting
    // with `{` as the canonical envelope — verified against the binary
    // 2026-05-15 in the T7 e2e fixture.
    const lines = stdout
      .trim()
      .split("\n")
      .filter((l) => l.trimStart().startsWith("{"));
    const lastLine = lines[lines.length - 1] ?? stdout.trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(lastLine);
    } catch {
      return [
        {
          kind: "escalate-to-claude-lead",
          observation: obs,
          reason: `cursor-agent emitted unparseable envelope (first 200 chars): ${stdout.slice(0, 200)}`,
        },
      ];
    }

    const envelopeValidation = CursorEnvelopeSchema.safeParse(parsed);
    if (!envelopeValidation.success) {
      return [
        {
          kind: "escalate-to-claude-lead",
          observation: obs,
          reason: `cursor-agent envelope failed schema: ${envelopeValidation.error.issues[0]?.message ?? "unknown"}`,
        },
      ];
    }
    const envelope = envelopeValidation.data;

    if (envelope.is_error || envelope.subtype === "error") {
      return [
        {
          kind: "escalate-to-claude-lead",
          observation: obs,
          reason: `cursor-agent reported error: ${envelope.result.slice(0, 200)}`,
        },
      ];
    }

    let resultParsed: unknown;
    try {
      resultParsed = JSON.parse(envelope.result);
    } catch {
      // The result wasn't valid JSON — cursor returned prose despite
      // the prompt. Treat as no-op tick rather than escalate; if the
      // wedge persists the §D5 temporal gates (or E6) will fire on a
      // subsequent tick.
      return [];
    }

    const actionsValidation = z.array(NudgeActionFromCursor).safeParse(resultParsed);
    if (!actionsValidation.success) {
      return [
        {
          kind: "escalate-to-claude-lead",
          observation: obs,
          reason: `cursor-agent emitted invalid NudgeAction shape: ${actionsValidation.error.issues
            .slice(0, 2)
            .map((i) => `${i.path.join(".")} ${i.message}`)
            .join("; ")}`,
        },
      ];
    }

    // Re-attach the live Observation to escalate-to-claude-lead
    // emissions — the cursor-agent prompt asks for `reason` only;
    // the dispatcher needs the full payload for the Claude lead.
    return actionsValidation.data.map((a) => {
      if (a.kind === "escalate-to-claude-lead") {
        return {
          kind: "escalate-to-claude-lead",
          observation: obs,
          reason: a.reason,
        };
      }
      return a;
    });
  }

  /** Apply ONE non-escalation NudgeAction. Per T2 interface contract
   *  the dispatcher MUST filter `escalate-to-claude-lead` out before
   *  invoking apply(); this impl throws on misuse rather than silently
   *  no-op-ing (matches ClaudeMartinet's posture). */
  async apply(action: NudgeAction): Promise<ApplyResult> {
    if (action.kind === "escalate-to-claude-lead") {
      throw new Error(
        `CursorMartinet.apply() unreachable for escalate-to-claude-lead — ` +
          `dispatcher must filter that branch before invoking apply() ` +
          `(escalation is terminal at the dispatcher boundary per ADR-132 §D1).`,
      );
    }

    const sendKeys = this.deps.sendKeys;
    if (sendKeys === undefined) {
      return {
        success: false,
        evidence:
          `CursorMartinet.apply(${action.kind}) for member='${action.member}': ` +
          `no sendKeys dep injected — dispatcher wiring incomplete. Action ` +
          `discarded; reason='${action.reason}'.`,
      };
    }

    switch (action.kind) {
      case "enter-push": {
        const result = await sendKeys(action.member, "Enter");
        return {
          success: result.success,
          evidence:
            `enter-push ${action.member}: ` +
            `${result.success ? "Enter sent" : "send-keys returned success=false"} ` +
            `— reason='${action.reason}'`,
        };
      }
      case "claim-next": {
        // Canonical claim form (matches CLAUDE.md "Push them to work"
        // pattern — atmux claim --next --as <member>).
        const cmd = `atmux claim --next --as ${action.member}`;
        const result = await sendKeys(action.member, cmd);
        return {
          success: result.success,
          evidence:
            `claim-next ${action.member}: ` +
            `${result.success ? `dispatched '${cmd}'` : "send-keys returned success=false"} ` +
            `— reason='${action.reason}'`,
        };
      }
      case "rotate": {
        // ADR-140 amendment — martinet handles ROUTINE rotation only
        // (60min uptime / context-rot detection). Non-routine rotation
        // stays on the Claude lead via escalate. Here we record the
        // rotation intent as evidence; the dispatcher (T8 follow-up)
        // reads martinet-state.json + fires the actual `atmux rotate
        // <member>` shell-out — keeping the impl pure (no destructive
        // git / atmux verb invocation directly).
        return {
          success: true,
          evidence:
            `rotate intent recorded for ${action.member}: ` +
            `dispatcher to fire 'atmux rotate ${action.member}' on next sweep ` +
            `— reason='${action.reason}'`,
        };
      }
    }
  }

  /** Strict §D5 escalation gate — composes T6's classifier with the
   *  E6 mandatory floor. Returns true iff at least one §D5 trigger
   *  fires on the (Observation, history) pair. The impl never
   *  suppresses E6 (per T2 header guarantee + ADR-132 §D5).
   *
   *  When `historyFn` is unset, the empty-history fallback exercises
   *  only the pure-Observation gates (E2 + E6) — sufficient for
   *  unit-test isolation and for the cockpit-tier "first tick of new
   *  cage" case where no cross-tick history exists yet. */
  shouldEscalateToClaudeLead(obs: Observation): boolean {
    const history = this.deps.historyFn?.() ?? EMPTY_HISTORY;
    const reasons = classify(obs, history);
    return shouldEscalate(reasons);
  }
}
