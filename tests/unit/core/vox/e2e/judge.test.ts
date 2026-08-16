import { describe, expect, test } from "bun:test";
import type { HttpResponse, request } from "../../../../../src/abstractions/http.ts";
import {
  BASE_CRITERIA,
  buildJudgePrompt,
  decideOutcome,
  formatOutcome,
  JUDGE_API_VERSION,
  JUDGE_JSON_SCHEMA,
  JUDGE_MODEL,
  JUDGE_URL,
  type JudgeCriterion,
  type JudgeInput,
  type JudgeVerdict,
  judgeRequestBody,
  parseJudgeResponse,
  runJudge,
} from "../../../../../src/core/vox/e2e/judge.ts";

const CRITERIA: JudgeCriterion[] = [
  { id: "a", question: "did it a?" },
  { id: "b", question: "did it b?" },
];

const INPUT: JudgeInput = {
  utterance: "What needs my attention?",
  groundTruth: "be-1 is blocked. fe-1 is wedged.",
  toolsInvoked: ["fleet_attention"],
  transcript: "Two panes need you: be-1 and fe-1.",
  criteria: CRITERIA,
};

function verdict(over: Partial<JudgeVerdict> = {}): JudgeVerdict {
  return {
    criteria: [
      { id: "a", pass: true, reasoning: "yes" },
      { id: "b", pass: true, reasoning: "yes" },
    ],
    hallucinations: [],
    overall_pass: true,
    summary: "good",
    ...over,
  };
}

function envelope(v: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: "claude-opus-5",
    stop_reason: "end_turn",
    content: [{ type: "text", text: JSON.stringify(v) }],
    ...extra,
  });
}

function fakeHttp(body: string): { post: typeof request; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const post: typeof request = async (opts) => {
    calls.push(opts as unknown as Record<string, unknown>);
    return {
      url: opts.url,
      method: "POST",
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      body,
      bytes: new TextEncoder().encode(body),
      durationMs: 1,
    } satisfies HttpResponse;
  };
  return { post, calls };
}

describe("the judge is a different model from the one under test", () => {
  test("grades with Claude, not with the OpenAI realtime model under test", () => {
    // Grading OpenAI-realtime with OpenAI-realtime measures self-consistency,
    // not correctness. This assertion is the guard on that.
    expect(JUDGE_MODEL).toContain("claude");
    expect(JUDGE_URL).toContain("api.anthropic.com");
  });

  test("sends the API key as x-api-key with the wire version header", async () => {
    const { post, calls } = fakeHttp(envelope(verdict()));
    await runJudge(INPUT, { apiKey: "sk-ant-x", post });
    const headers = calls[0]?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-x");
    expect(headers["anthropic-version"]).toBe(JUDGE_API_VERSION);
  });
});

describe("the request is a structured-output request", () => {
  test("constrains the response to the verdict schema", () => {
    const body = judgeRequestBody(INPUT, JUDGE_MODEL) as Record<string, unknown>;
    expect(body.output_config).toEqual({
      format: { type: "json_schema", schema: JUDGE_JSON_SCHEMA },
    });
    expect(body.model).toBe(JUDGE_MODEL);
  });

  test("the schema is strict — every object closed with a full required list", () => {
    // Strict structured outputs 400 rather than degrade if either is missing.
    const s = JUDGE_JSON_SCHEMA as unknown as Record<string, unknown>;
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toEqual(["criteria", "hallucinations", "overall_pass", "summary"]);
    const item = (
      (s.properties as Record<string, Record<string, unknown>>).criteria as Record<string, unknown>
    ).items as Record<string, unknown>;
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toEqual(["id", "pass", "reasoning"]);
  });

  test("carries no sampling parameters (removed on current models)", () => {
    const body = judgeRequestBody(INPUT, JUDGE_MODEL) as Record<string, unknown>;
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.top_k).toBeUndefined();
  });
});

describe("buildJudgePrompt", () => {
  test("carries ground truth, utterance, tools, transcript, and criteria", () => {
    const p = buildJudgePrompt(INPUT);
    expect(p).toContain("be-1 is blocked");
    expect(p).toContain("What needs my attention?");
    expect(p).toContain("- fleet_attention");
    expect(p).toContain("Two panes need you");
    expect(p).toContain("a: did it a?");
  });

  test("says so explicitly when no tool was called", () => {
    expect(buildJudgePrompt({ ...INPUT, toolsInvoked: [] })).toContain(
      "the assistant called no tools",
    );
  });

  test("says so explicitly when the assistant said nothing", () => {
    expect(buildJudgePrompt({ ...INPUT, transcript: "   " })).toContain(
      "the assistant said nothing",
    );
  });
});

describe("parseJudgeResponse", () => {
  test("parses the happy path", () => {
    const r = parseJudgeResponse(envelope(verdict()));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verdict.criteria.length).toBe(2);
  });

  test("finds the text block behind a leading thinking block", () => {
    // Thinking is on by default on current models, so `content[0].text` is
    // the wrong place to look.
    const raw = JSON.stringify({
      model: "claude-opus-5",
      stop_reason: "end_turn",
      content: [
        { type: "thinking", thinking: "" },
        { type: "text", text: JSON.stringify(verdict()) },
      ],
    });
    expect(parseJudgeResponse(raw).ok).toBe(true);
  });

  test("reports a refusal rather than reading empty content", () => {
    const raw = JSON.stringify({ stop_reason: "refusal", content: [] });
    const r = parseJudgeResponse(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("refused");
  });

  test("reports a response with no text block", () => {
    const raw = JSON.stringify({ stop_reason: "end_turn", content: [{ type: "thinking" }] });
    const r = parseJudgeResponse(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("no text block");
  });

  test("reports a text block whose text is not a string", () => {
    const raw = JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: 7 }] });
    expect(parseJudgeResponse(raw).ok).toBe(false);
  });

  test("reports non-JSON", () => {
    const r = parseJudgeResponse("not json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("not the expected JSON shape");
  });

  test("reports a verdict that does not match the schema", () => {
    const r = parseJudgeResponse(envelope({ criteria: "nope" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("did not match the required schema");
  });

  test("tolerates a missing model field", () => {
    const raw = JSON.stringify({
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify(verdict()) }],
    });
    const r = parseJudgeResponse(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.model).toBeNull();
  });
});

describe("decideOutcome — the judge's own aggregate is not trusted", () => {
  test("a failed criterion fails the run even when the judge says overall pass", () => {
    // The real failure mode this guards: a judge that marks a criterion
    // failed and then cheerfully reports overall_pass: true.
    const v = verdict({
      criteria: [
        { id: "a", pass: false, reasoning: "no" },
        { id: "b", pass: true, reasoning: "yes" },
      ],
      overall_pass: true,
    });
    const o = decideOutcome(v, CRITERIA);
    expect(o.pass).toBe(false);
    expect(o.aggregateDisagreement).toContain("overall_pass=true");
  });

  test("a hallucination fails the run even with every criterion passing", () => {
    const o = decideOutcome(verdict({ hallucinations: ["team zeta"] }), CRITERIA);
    expect(o.pass).toBe(false);
  });

  test("a silently dropped criterion is a failure, not a pass", () => {
    // Otherwise skipping the hardest question is the cheapest way to pass.
    const v = verdict({ criteria: [{ id: "a", pass: true, reasoning: "yes" }] });
    const o = decideOutcome(v, CRITERIA);
    expect(o.pass).toBe(false);
    expect(o.missingCriteria).toEqual(["b"]);
  });

  test("passes when every criterion passes, nothing is hallucinated, none missing", () => {
    const o = decideOutcome(verdict(), CRITERIA, "claude-opus-5");
    expect(o.pass).toBe(true);
    expect(o.aggregateDisagreement).toBeNull();
    expect(o.model).toBe("claude-opus-5");
  });

  test("notes disagreement in the other direction too", () => {
    const o = decideOutcome(verdict({ overall_pass: false }), CRITERIA);
    expect(o.pass).toBe(true);
    expect(o.aggregateDisagreement).toContain("overall_pass=false");
  });
});

describe("runJudge", () => {
  test("returns the recomputed outcome", async () => {
    const { post } = fakeHttp(envelope(verdict()));
    const o = await runJudge(INPUT, { apiKey: "k", post });
    expect(o.pass).toBe(true);
    expect(o.model).toBe("claude-opus-5");
  });

  test("honours a model override and logs", async () => {
    const lines: string[] = [];
    const { post, calls } = fakeHttp(envelope(verdict()));
    await runJudge(INPUT, {
      apiKey: "k",
      post,
      model: "claude-sonnet-5",
      log: (l) => lines.push(l),
    });
    expect(JSON.parse(String(calls[0]?.body)).model).toBe("claude-sonnet-5");
    expect(lines.join()).toContain("criteria=2");
  });

  test("throws when the verdict cannot be parsed", async () => {
    const { post } = fakeHttp("garbage");
    await expect(runJudge(INPUT, { apiKey: "k", post })).rejects.toThrow("judge:");
  });
});

describe("formatOutcome", () => {
  test("prints every criterion with its reasoning, verbatim", () => {
    const text = formatOutcome(decideOutcome(verdict(), CRITERIA, "claude-opus-5")).join("\n");
    expect(text).toContain("judge verdict: PASS");
    expect(text).toContain("[PASS] a");
    expect(text).toContain("hallucinations: none");
    expect(text).toContain("summary: good");
  });

  test("prints hallucinations, missing criteria, and disagreement when present", () => {
    const v = verdict({
      criteria: [{ id: "a", pass: false, reasoning: "invented a team" }],
      hallucinations: ["team zeta"],
      overall_pass: true,
    });
    const text = formatOutcome(decideOutcome(v, CRITERIA)).join("\n");
    expect(text).toContain("judge verdict: FAIL");
    expect(text).toContain("hallucinations: team zeta");
    expect(text).toContain("MISSING criteria (counted as failures): b");
    expect(text).toContain("NOTE:");
  });

  test("prints an unknown model as ?", () => {
    expect(formatOutcome(decideOutcome(verdict(), CRITERIA)).join("\n")).toContain("model ?");
  });
});

describe("BASE_CRITERIA", () => {
  test("always grades answering and hallucination", () => {
    expect(BASE_CRITERIA.map((c) => c.id)).toEqual(["answered_the_question", "no_hallucination"]);
  });
});
