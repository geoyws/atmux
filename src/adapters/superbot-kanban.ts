// ADR-281 — narrow `/kb` process adapter for `_superbot`.
// Every call addresses an explicit board and clears ambient board selectors.

import { z } from "zod";
import { spawn, type SpawnOpts, type SpawnResult } from "../abstractions/spawn.ts";
import { tryParseJsonString } from "../abstractions/json.ts";
import {
  SUPERBOT_ACTOR,
  SUPERBOT_METADATA_KEY,
  type SuperbotCandidate,
  type SuperbotOfferState,
} from "../core/superbot.ts";

const CandidateSchema = z
  .object({
    id: z.string().min(1),
    type: z.string(),
    status: z.string(),
    tags: z.array(z.string()).default([]),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .passthrough();

const TaskDetailSchema = z
  .object({
    id: z.string().min(1),
    claim: z
      .object({
        agentID: z.string(),
        expiresAt: z.number(),
      })
      .nullable()
      .optional(),
  })
  .passthrough();

export type SuperbotSpawn = (opts: SpawnOpts) => Promise<SpawnResult>;

const BOARD_SELECTOR_ENV = ["KANBAN_PROJECT", "KANBAN_DB", "KANBAN_DATA_DIR"] as const;

async function runJson(argv: ReadonlyArray<string>, spawnFn: SuperbotSpawn): Promise<unknown> {
  const result = await spawnFn({
    cmd: "kb",
    argv,
    unsetEnv: BOARD_SELECTOR_ENV,
    timeoutMs: 30_000,
  });
  const parsed = tryParseJsonString(result.stdout, z.unknown());
  if (parsed === null) throw new Error("kb returned invalid or empty JSON");
  return parsed;
}

export class SuperbotKanbanAdapter {
  constructor(private readonly spawnFn: SuperbotSpawn = spawn) {}

  async candidates(
    board: string,
    tag: string,
    actor: string,
    limit: number,
  ): Promise<SuperbotCandidate[]> {
    const raw = await runJson(
      [
        "claim",
        "--candidates",
        "--project",
        board,
        "--as",
        actor,
        "--tag",
        tag,
        "--limit",
        String(limit),
        "--json",
      ],
      this.spawnFn,
    );
    return z.array(CandidateSchema).parse(raw);
  }

  /** Re-run the same eligibility query immediately before delivery. */
  async isStillCandidate(
    board: string,
    tag: string,
    actor: string,
    taskId: string,
    limit: number,
  ): Promise<boolean> {
    const candidates = await this.candidates(board, tag, actor, limit);
    return candidates.some((candidate) => candidate.id === taskId);
  }

  /** Current Kanban has no actor-indexed lease query. Walk the bounded
   * in-progress list and inspect detail claims; this is read-only and
   * uses the authoritative claim expiry rather than assignee/status. */
  async hasLiveClaim(board: string, actor: string, nowMs: number): Promise<boolean> {
    const rows = z
      .array(z.object({ id: z.string().min(1) }).passthrough())
      .parse(
        await runJson(
          ["task", "list", "--project", board, "--status", "in_progress", "--json"],
          this.spawnFn,
        ),
      );
    for (const row of rows) {
      const detail = TaskDetailSchema.parse(
        await runJson(["task", "show", row.id, "--project", board, "--json"], this.spawnFn),
      );
      if (detail.claim?.agentID === actor && detail.claim.expiresAt > nowMs) return true;
    }
    return false;
  }

  /** Idempotent whole-namespace replacement. No claim/assignment/status
   * fields are touched. */
  async writeOfferState(board: string, taskId: string, state: SuperbotOfferState): Promise<void> {
    await runJson(
      [
        "task",
        "metadata",
        taskId,
        "--project",
        board,
        "--as",
        SUPERBOT_ACTOR,
        "--patch-json",
        JSON.stringify({ [SUPERBOT_METADATA_KEY]: state }),
      ],
      this.spawnFn,
    );
  }
}
