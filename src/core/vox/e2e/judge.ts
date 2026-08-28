// ADR-272 §Supplement — LLM-as-judge for the voice e2e harness.
//
// **The judge is deliberately a different model family from the one under
// test.** The system under test routes through OpenAI Realtime; grading it
// with the same model measures self-consistency, not correctness — a model
// asked whether its own answer was good is a poor witness, and a shared
// failure mode (both models mis-hearing the same word, both inventing the
// same plausible team) would cancel out into a green run. So the judge is
// Claude, via `ANTHROPIC_API_KEY`.
//
// The verdict is STRUCTURED, not a vibe score: one explicit pass/fail plus
// reasoning per named criterion, and a separate list of any team or pane the
// assistant invented. A single 1-to-10 number cannot say *which* property
// broke, and a harness whose failure output is "6/10" is one nobody debugs.
//
// **The judge's own aggregate is not trusted.** `overall_pass` comes back
// from the model and is then RECOMPUTED here from the per-criterion results
// and the hallucination list. A judge that marks three criteria failed and
// then says "overall: pass" is a real failure mode, and the recomputation is
// what stops it becoming a green run.

import { z } from "zod";
import { request } from "../../../abstractions/http.ts";
import { tryParseJsonString } from "../../../abstractions/json.ts";

/** Anthropic messages endpoint. */
export const JUDGE_URL = "https://api.anthropic.com/v1/messages";

/** Wire version header — required on every request. */
export const JUDGE_API_VERSION = "2023-06-01";

/**
 * The judge model. Opus-tier on purpose: the judge has to read a transcript
 * against a ground-truth briefing and spot omissions and inventions, which
 * is exactly the kind of careful comparison a cheaper model gets wrong in
 * the direction that matters (false PASS).
 */
export const JUDGE_MODEL = "claude-opus-5";

export const JUDGE_MAX_TOKENS = 16_000;
export const JUDGE_TIMEOUT_MS = 180_000;

// ---------- Criteria ----------

export interface JudgeCriterion {
  /** Stable id the model must echo back. */
  id: string;
  /** The question, phrased so that `true` means the assistant did well. */
  question: string;
}

/**
 * Criteria every scenario is graded on, whatever it asked. Scenario-specific
 * criteria are appended to these.
 *
 * `no_hallucination` is last in the list but first in importance: an
 * assistant that invents a team is worse than one that misses a pane,
 * because a missed pane is visible on the next sweep while an invented one
 * sends the operator looking for something that was never there.
 */
export const BASE_CRITERIA: ReadonlyArray<JudgeCriterion> = Object.freeze([
  Object.freeze({
    id: "answered_the_question",
    question:
      "Did the assistant actually answer the operator's question, rather than " +
      "deflecting, asking a clarifying question it did not need, or reporting an error?",
  }),
  Object.freeze({
    id: "no_hallucination",
    question:
      "Did the assistant avoid naming ANY team, pane, member, or condition that " +
      "does not exist in the ground truth? Naming something that does not exist is a FAIL.",
  }),
]);

// ---------- Structured verdict ----------

export const CriterionVerdict = z.object({
  id: z.string(),
  pass: z.boolean(),
  reasoning: z.string(),
});

export const JudgeVerdict = z.object({
  criteria: z.array(CriterionVerdict),
  hallucinations: z.array(z.string()),
  overall_pass: z.boolean(),
  summary: z.string(),
});

export type CriterionVerdict = z.infer<typeof CriterionVerdict>;
export type JudgeVerdict = z.infer<typeof JudgeVerdict>;

/**
 * JSON Schema handed to the API's structured-output constraint.
 *
 * Every object carries `additionalProperties: false` and a complete
 * `required` list — both are hard requirements of strict structured
 * outputs, and omitting either makes the request 400 rather than degrade.
 */
export const JUDGE_JSON_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    criteria: {
      type: "array",
      description: "One entry per criterion you were given, echoing its id.",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "The criterion id, verbatim." },
          pass: { type: "boolean" },
          reasoning: {
            type: "string",
            description: "One or two sentences citing the transcript or tool log.",
          },
        },
        required: ["id", "pass", "reasoning"],
        additionalProperties: false,
      },
    },
    hallucinations: {
      type: "array",
      description:
        "Every team / pane / member name the assistant stated that does not exist " +
        "in the ground truth. Empty array when there are none.",
      items: { type: "string" },
    },
    overall_pass: { type: "boolean" },
    summary: { type: "string" },
  },
  required: ["criteria", "hallucinations", "overall_pass", "summary"],
  additionalProperties: false,
});

// ---------- Prompt ----------

export interface JudgeInput {
  /** What the operator said, as text (the harness spoke this). */
  utterance: string;
  /** Ground truth about the fake cage. */
  groundTruth: string;
  /** Tool names actually invoked, in order. */
  toolsInvoked: ReadonlyArray<string>;
  /** The assistant's transcript, concatenated. */
  transcript: string;
  criteria: ReadonlyArray<JudgeCriterion>;
}

export const JUDGE_SYSTEM = [
  "You are grading a voice assistant that answers questions about a fleet of",
  "tmux-based coding-agent sessions. You are given the GROUND TRUTH about that",
  "fleet, the tools the assistant actually invoked, and what it said back.",
  "",
  "Grade strictly and literally against the ground truth.",
  "",
  "- A criterion passes only if the transcript supports it. Do not give credit",
  "  for what the assistant probably meant or would have said next.",
  "- Naming a team, pane, member, or condition absent from the ground truth is a",
  "  hallucination. List every one. Hallucination is the most serious failure",
  "  here: a missed pane shows up on the next sweep, an invented one sends the",
  "  operator hunting for something that never existed.",
  "- The assistant speaks aloud, so phrasing is conversational and approximate.",
  "  Judge SUBSTANCE, not wording: 'the backend one is stuck asking permission'",
  "  correctly reports pane be-1. Paraphrase is fine; wrong facts are not.",
  "- Omitting a pane that genuinely needs attention is a FAIL of the criterion",
  "  that asks about it, even if everything the assistant did say was true.",
].join("\n");

export function buildJudgePrompt(input: JudgeInput): string {
  const tools =
    input.toolsInvoked.length > 0
      ? input.toolsInvoked.map((t) => `  - ${t}`).join("\n")
      : "  (none — the assistant called no tools)";
  const transcript =
    input.transcript.trim().length > 0
      ? input.transcript.trim()
      : "(empty — the assistant said nothing)";
  return [
    "# Ground truth",
    "",
    input.groundTruth,
    "",
    "# What the operator asked (spoken aloud)",
    "",
    input.utterance,
    "",
    "# Tools the assistant actually invoked, in order",
    "",
    tools,
    "",
    "# What the assistant said back",
    "",
    transcript,
    "",
    "# Criteria",
    "",
    ...input.criteria.map((c) => `- ${c.id}: ${c.question}`),
    "",
    "Return one entry per criterion, echoing each id exactly.",
  ].join("\n");
}

// ---------- Response parsing ----------

/** Minimal shape of the Anthropic messages response the judge needs. */
const JudgeResponseEnvelope = z
  .object({
    content: z.array(z.object({ type: z.string() }).passthrough()),
    stop_reason: z.string().nullable().optional(),
    model: z.string().optional(),
    usage: z
      .object({ input_tokens: z.number().optional(), output_tokens: z.number().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type JudgeParse =
  | { ok: true; verdict: JudgeVerdict; model: string | null }
  | { ok: false; reason: string };

/**
 * Parse the API envelope down to a verdict.
 *
 * Handles the two shapes that are not the happy path and that a naive
 * `content[0].text` would get wrong: a `refusal` stop reason (HTTP 200 with
 * no usable content), and a leading `thinking` block pushing the text block
 * off index 0.
 */
export function parseJudgeResponse(raw: string): JudgeParse {
  const env = tryParseJsonString(raw, JudgeResponseEnvelope);
  if (env === null) return { ok: false, reason: "judge response was not the expected JSON shape" };
  if (env.stop_reason === "refusal") {
    return { ok: false, reason: "judge model refused the grading request" };
  }
  const textBlock = env.content.find((b) => b.type === "text") as { text?: unknown } | undefined;
  if (textBlock === undefined || typeof textBlock.text !== "string") {
    return { ok: false, reason: `judge response carried no text block (stop=${env.stop_reason})` };
  }
  const verdict = tryParseJsonString(textBlock.text, JudgeVerdict);
  if (verdict === null) {
    return { ok: false, reason: "judge verdict did not match the required schema" };
  }
  return { ok: true, verdict, model: env.model ?? null };
}

// ---------- Aggregation ----------

export interface JudgeOutcome {
  verdict: JudgeVerdict;
  /** Recomputed here — NOT the model's own `overall_pass`. */
  pass: boolean;
  /** Set when the model's aggregate disagreed with its own criteria. */
  aggregateDisagreement: string | null;
  /** Criteria that were asked for but never came back. */
  missingCriteria: string[];
  model: string | null;
}

/**
 * Decide the run's outcome from the verdict.
 *
 * Three ways to fail, and all three are independent of what the judge said
 * in `overall_pass`: any criterion failed, any hallucination listed, or any
 * requested criterion missing from the response. A criterion the judge
 * silently dropped is treated as a failure, because the alternative is that
 * skipping the hardest question is the cheapest way to pass.
 */
export function decideOutcome(
  verdict: JudgeVerdict,
  asked: ReadonlyArray<JudgeCriterion>,
  model: string | null = null,
): JudgeOutcome {
  const seen = new Set(verdict.criteria.map((c) => c.id));
  const missingCriteria = asked.map((c) => c.id).filter((id) => !seen.has(id));
  const allPassed = verdict.criteria.every((c) => c.pass);
  const pass = allPassed && verdict.hallucinations.length === 0 && missingCriteria.length === 0;
  const aggregateDisagreement =
    verdict.overall_pass !== pass
      ? `judge reported overall_pass=${verdict.overall_pass} but its own criteria imply ${pass}`
      : null;
  return { verdict, pass, aggregateDisagreement, missingCriteria, model };
}

// ---------- Call ----------

export interface JudgeDeps {
  apiKey: string;
  post?: typeof request;
  model?: string;
  log?: (line: string) => void;
}

/** Request body for the judge call. Pure, so a test can assert it. */
export function judgeRequestBody(input: JudgeInput, model: string): Record<string, unknown> {
  return {
    model,
    max_tokens: JUDGE_MAX_TOKENS,
    system: JUDGE_SYSTEM,
    // Structured outputs: the schema is enforced, so the response text is
    // parseable JSON rather than JSON-shaped prose.
    output_config: { format: { type: "json_schema", schema: JUDGE_JSON_SCHEMA } },
    messages: [{ role: "user", content: buildJudgePrompt(input) }],
  };
}

/** Ask the judge. Throws `HttpError` on a non-2xx. */
export async function runJudge(input: JudgeInput, deps: JudgeDeps): Promise<JudgeOutcome> {
  const post = deps.post ?? request;
  const model = deps.model ?? JUDGE_MODEL;
  const log = deps.log ?? ((): void => {});
  const res = await post({
    url: JUDGE_URL,
    method: "POST",
    headers: {
      "x-api-key": deps.apiKey,
      "anthropic-version": JUDGE_API_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify(judgeRequestBody(input, model)),
    timeoutMs: JUDGE_TIMEOUT_MS,
    retry: 1,
  });
  const parsed = parseJudgeResponse(res.body);
  if (!parsed.ok) {
    throw new Error(`judge: ${parsed.reason}`);
  }
  log(`judge: model=${parsed.model ?? model} criteria=${parsed.verdict.criteria.length}`);
  return decideOutcome(parsed.verdict, input.criteria, parsed.model);
}

/** Render the structured verdict for stderr — verbatim, not summarized. */
export function formatOutcome(outcome: JudgeOutcome): string[] {
  const lines = [
    `judge verdict: ${outcome.pass ? "PASS" : "FAIL"} (model ${outcome.model ?? "?"})`,
  ];
  for (const c of outcome.verdict.criteria) {
    lines.push(`  [${c.pass ? "PASS" : "FAIL"}] ${c.id}`);
    lines.push(`         ${c.reasoning}`);
  }
  if (outcome.verdict.hallucinations.length > 0) {
    lines.push(`  hallucinations: ${outcome.verdict.hallucinations.join("; ")}`);
  } else {
    lines.push("  hallucinations: none");
  }
  if (outcome.missingCriteria.length > 0) {
    lines.push(`  MISSING criteria (counted as failures): ${outcome.missingCriteria.join(", ")}`);
  }
  if (outcome.aggregateDisagreement !== null) {
    lines.push(`  NOTE: ${outcome.aggregateDisagreement}`);
  }
  lines.push(`  summary: ${outcome.verdict.summary}`);
  return lines;
}
