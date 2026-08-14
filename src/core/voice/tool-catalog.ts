// ADR-272: voice operator interface — the frozen v1 tool surface
// (ADR-272 D6: 10 read tools + 4 messaging tools, nothing destructive).
//
// Every tool is an atmux VERB invocation (ADR-272 D2): the entry maps
// validated args to an argv the verb's own `parse*Args` accepts, and
// the verb function itself is INJECTED at boot (P4 lazy-imports the
// verb modules) — core never imports from `src/verbs/**`. Runner-key →
// verb module mapping (what P4 wires):
//
//   topo        → src/verbs/topo.ts::topo
//   status      → src/verbs/status.ts::status
//   health      → src/verbs/health.ts::health
//   task        → src/verbs/task.ts::task
//   paneState   → src/verbs/pane-state.ts::paneState
//   driverInbox → src/verbs/driver-inbox.ts::driverInbox
//   outbox      → src/verbs/reply.ts::outbox   (the collector
//                 dashboard.ts already delegates lead-outbox reads to)
//   cost        → src/verbs/cost.ts::cost
//   blockers    → src/verbs/blockers.ts::blockers
//   tellLead    → src/verbs/tell-lead.ts::tellLead
//   dispatch    → src/verbs/dispatch.ts::dispatch
//   claim       → src/verbs/claim.ts::claim
//
// `list_teams` is the ONE core-direct read: it has NO runner
// (`runnerKey: null`) and is served straight from the team index by the
// bridge.
//
// Params are FLAT scalars/enums only — both provider dialects (OpenAI
// Realtime / Gemini Live) accept flat object schemas without $ref
// support; `toolJsonSchema` enforces the flatness at derive time and a
// unit test pins it over every entry. Confirm-gated entries gain the
// shared optional `confirm_token` param in ONE place
// (`withConfirmToken`) — the bridge strips it before building argv and
// before hashing the confirmation binding.

import { z } from "zod";
import { ConfigError } from "../../errors.ts";

/** Injected-runner keys — see the module-map in the file header. */
export type VoiceRunnerKey =
  | "topo"
  | "status"
  | "health"
  | "task"
  | "paneState"
  | "driverInbox"
  | "outbox"
  | "cost"
  | "blockers"
  | "tellLead"
  | "dispatch"
  | "claim";

/** One catalog entry. `argv` receives the VALIDATED args (post-Zod,
 *  `confirm_token` already stripped) plus the resolved team root
 *  (`null` for fleet-scoped tools). */
export interface VoiceToolEntry {
  name: string;
  description: string;
  params: z.ZodObject<z.ZodRawShape>;
  mutating: boolean;
  confirm: boolean;
  /** `null` ONLY for `list_teams` — served core-direct from the index. */
  runnerKey: VoiceRunnerKey | null;
  argv(args: Record<string, unknown>, teamRoot: string | null): string[];
}

const TEAM_PARAM = z
  .string()
  .min(1)
  .optional()
  .describe("Team name; defaults to the session's current team");

/** ADR-272 D7: the shared optional confirm_token param — the ONE place
 *  it is declared. Applied only to confirm-gated entries. */
function withConfirmToken<T extends z.ZodRawShape>(
  shape: T,
): z.ZodObject<T & { confirm_token: z.ZodOptional<z.ZodString> }> {
  return z.object({
    ...shape,
    confirm_token: z
      .string()
      .optional()
      .describe(
        "Token from a needs_confirmation preview; send it back after the operator says yes",
      ),
  });
}

/** `--team-dir <root>` pair, or nothing when no root is in play. */
function teamDirArgs(teamRoot: string | null): string[] {
  return teamRoot === null ? [] : ["--team-dir", teamRoot];
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : String(v);
}

/**
 * The frozen v1 catalog (ADR-272 D6). `mutating: true` on exactly the
 * 4 messaging tools; `confirm: true` on exactly `dispatch_task` +
 * `claim_task`.
 */
export const VOICE_TOOL_CATALOG: ReadonlyArray<VoiceToolEntry> = Object.freeze([
  {
    name: "list_teams",
    description:
      "List every team in the fleet with its type. Costs nothing; use it before scoping other tools.",
    params: z.object({}),
    mutating: false,
    confirm: false,
    runnerKey: null,
    argv: () => [],
  },
  {
    name: "fleet_overview",
    description: "Fleet-wide topology overview across every team. Slower than the per-team reads.",
    params: z.object({}),
    mutating: false,
    confirm: false,
    runnerKey: "topo",
    argv: () => [],
  },
  {
    name: "team_status",
    description: "Status of one team: session state, member panes, kanban counts.",
    params: z.object({ team: TEAM_PARAM }),
    mutating: false,
    confirm: false,
    runnerKey: "status",
    argv: (_args, teamRoot) => [...teamDirArgs(teamRoot)],
  },
  {
    name: "team_health",
    description: "Health check for one team; surfaces what is stale or down.",
    params: z.object({ team: TEAM_PARAM }),
    mutating: false,
    confirm: false,
    runnerKey: "health",
    argv: (_args, teamRoot) => ["--text", ...teamDirArgs(teamRoot)],
  },
  {
    name: "list_tasks",
    description: "List kanban tasks for a team, newest slice first.",
    params: z.object({
      team: TEAM_PARAM,
      limit: z
        .number()
        .int()
        .min(1)
        .max(25)
        .default(10)
        .describe("How many tasks to keep in the reply"),
    }),
    mutating: false,
    confirm: false,
    runnerKey: "task",
    argv: (_args, teamRoot) => ["list", ...teamDirArgs(teamRoot)],
  },
  {
    name: "member_pane",
    description: "Read one member's pane state (READY, TYPING, RATE-LIMIT, COMPACTING, ...).",
    params: z.object({
      team: TEAM_PARAM,
      member: z.string().min(1).describe("Member name as listed in team status"),
    }),
    mutating: false,
    confirm: false,
    runnerKey: "paneState",
    argv: (args, teamRoot) => ["--member", asString(args.member), ...teamDirArgs(teamRoot)],
  },
  {
    name: "driver_inbox",
    description: "Read the driver inbox — asks the driver has filed for the lead.",
    params: z.object({ team: TEAM_PARAM }),
    mutating: false,
    confirm: false,
    runnerKey: "driverInbox",
    argv: (_args, teamRoot) => ["--all", ...teamDirArgs(teamRoot)],
  },
  {
    name: "lead_outbox",
    description: "Read the lead outbox — replies and notes waiting for the driver.",
    params: z.object({ team: TEAM_PARAM }),
    mutating: false,
    confirm: false,
    runnerKey: "outbox",
    argv: (_args, teamRoot) => [...teamDirArgs(teamRoot)],
  },
  {
    name: "cost_report",
    description: "Per-member AI spend for a team since session start.",
    params: z.object({ team: TEAM_PARAM }),
    mutating: false,
    confirm: false,
    runnerKey: "cost",
    argv: (_args, teamRoot) => [...teamDirArgs(teamRoot)],
  },
  {
    name: "list_blockers",
    description: "List active blockers for a team across all blocker surfaces.",
    params: z.object({ team: TEAM_PARAM }),
    mutating: false,
    confirm: false,
    runnerKey: "blockers",
    argv: (_args, teamRoot) => ["list", ...teamDirArgs(teamRoot)],
  },
  {
    name: "tell_lead",
    description: "Send a short message to the team's lead. Append-only; no confirmation needed.",
    params: z.object({
      team: TEAM_PARAM,
      message: z.string().min(1).max(500).describe("The message to deliver to the lead"),
    }),
    mutating: true,
    confirm: false,
    runnerKey: "tellLead",
    argv: (args, teamRoot) => [...teamDirArgs(teamRoot), "--", asString(args.message)],
  },
  {
    name: "add_task",
    description: "Add a kanban task to a team. Append-only; the task stays visible and editable.",
    params: z.object({
      team: TEAM_PARAM,
      title: z.string().min(1).max(200).describe("Task subject line"),
      body: z.string().max(2000).optional().describe("Optional task body"),
      priority: z.number().int().min(1).max(9).optional().describe("1 is most urgent"),
    }),
    mutating: true,
    confirm: false,
    runnerKey: "task",
    argv: (args, teamRoot) => [
      "add",
      ...teamDirArgs(teamRoot),
      ...(typeof args.body === "string" ? ["--body", args.body] : []),
      ...(typeof args.priority === "number" ? ["--priority", String(args.priority)] : []),
      "--",
      asString(args.title),
    ],
  },
  {
    name: "dispatch_task",
    description: "Assign a task to a named member. Confirmation is required before it runs.",
    params: withConfirmToken({
      team: TEAM_PARAM,
      task_id: z.string().min(1).describe("Task id (full id or as read back)"),
      member: z.string().min(1).optional().describe("Member to dispatch to"),
    }),
    mutating: true,
    confirm: true,
    runnerKey: "dispatch",
    argv: (args, teamRoot) => [
      ...(typeof args.member === "string" ? [args.member] : []),
      asString(args.task_id),
      ...teamDirArgs(teamRoot),
    ],
  },
  {
    name: "claim_task",
    description:
      "Claim a task for a member (changes ownership). Confirmation is required before it runs.",
    params: withConfirmToken({
      team: TEAM_PARAM,
      task_id: z.string().min(1).describe("Task id (full id or as read back)"),
      member: z.string().min(1).describe("Member who takes ownership"),
    }),
    mutating: true,
    confirm: true,
    runnerKey: "claim",
    argv: (args, teamRoot) => [
      asString(args.task_id),
      "--as",
      asString(args.member),
      ...teamDirArgs(teamRoot),
    ],
  },
]);

/** Look up a catalog entry by tool name. */
export function findTool(name: string): VoiceToolEntry | undefined {
  return VOICE_TOOL_CATALOG.find((t) => t.name === name);
}

/** True when the tool takes an (optional) `team` param — i.e. the
 *  bridge must resolve a team root before building argv. */
export function isTeamScoped(entry: VoiceToolEntry): boolean {
  return "team" in entry.params.shape;
}

// ---------- Provider-facing JSON schema ----------

/** Flat scalar property — the ONLY property shape the catalog may
 *  produce (typed locally; P4 asserts assignability against the P2
 *  protocol type when both lanes land). */
export interface FlatToolSchemaProperty {
  type: "string" | "number" | "integer" | "boolean";
  description?: string;
  enum?: string[];
}

/** Flat object schema — no nesting, no $ref, no unions. */
export interface FlatToolSchema {
  type: "object";
  properties: Record<string, FlatToolSchemaProperty>;
  required?: string[];
}

/**
 * Derive the provider-facing flat JSON schema for one entry via zod
 * v4's `z.toJSONSchema` (`io: "input"` so `.default()` params stay
 * optional for the model), post-processed to exactly
 * `{ type, properties, required? }`. Throws `ConfigError` when an
 * entry's param is not a flat scalar — a non-flat catalog entry is a
 * programming error and must fail loudly at wiring time, not surface
 * as a provider-side schema rejection.
 */
export function toolJsonSchema(entry: VoiceToolEntry): FlatToolSchema {
  const raw = z.toJSONSchema(entry.params, { io: "input" }) as Record<string, unknown>;
  const rawProps = (raw.properties ?? {}) as Record<string, Record<string, unknown>>;
  const properties: Record<string, FlatToolSchemaProperty> = {};
  for (const [key, prop] of Object.entries(rawProps)) {
    const t = prop.type;
    if (t !== "string" && t !== "number" && t !== "integer" && t !== "boolean") {
      throw new ConfigError({
        what: `voice tool ${entry.name}: param '${key}' is not a flat scalar (type: ${JSON.stringify(t)})`,
        hint: "ADR-272 D6 — provider dialects require flat scalar/enum params",
      });
    }
    const out: FlatToolSchemaProperty = { type: t };
    if (typeof prop.description === "string") out.description = prop.description;
    if (Array.isArray(prop.enum)) {
      out.enum = prop.enum.filter((v): v is string => typeof v === "string");
    }
    properties[key] = out;
  }
  const required = Array.isArray(raw.required)
    ? raw.required.filter((r): r is string => typeof r === "string")
    : [];
  const schema: FlatToolSchema = { type: "object", properties };
  if (required.length > 0) schema.required = required;
  return schema;
}
