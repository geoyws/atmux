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
//   fleet       → src/verbs/fleet.ts::fleet   (ADR-273 D1 triage sweep)
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
//   nudge       → src/verbs/nudge.ts::nudge   (ADR-273 D4 pane input)
//   hostPressure→ src/verbs/host-pressure.ts::hostPressure
//                                            (ADR-273 §Supplement)
//   tokenBudget → src/verbs/token-budget.ts::tokenBudget
//                                            (ADR-273 §Supplement)
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
import { NUDGE_ACTIONS, nudgeConfirmPreview } from "./nudge.ts";
import { BUDGET_PROVIDERS } from "./token-budget.ts";

/** Injected-runner keys — see the module-map in the file header. */
export type VoxRunnerKey =
  | "topo"
  | "fleet"
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
  | "claim"
  | "nudge"
  | "hostPressure"
  | "tokenBudget";

/** One catalog entry. `argv` receives the VALIDATED args (post-Zod,
 *  `confirm_token` already stripped) plus the resolved team root
 *  (`null` for fleet-scoped tools). */
export interface VoxToolEntry {
  name: string;
  description: string;
  params: z.ZodObject<z.ZodRawShape>;
  mutating: boolean;
  confirm: boolean;
  /** `null` ONLY for `list_teams` — served core-direct from the index. */
  runnerKey: VoxRunnerKey | null;
  argv(args: Record<string, unknown>, teamRoot: string | null): string[];
  /**
   * Optional per-tool confirm preview (ADR-272 D7), used INSTEAD of the
   * bridge's generic `buildConfirmPreview` when present.
   *
   * The generic line renders each argument as `<key> <value>`, which is
   * adequate for `dispatch_task` (the arguments ARE the action) and
   * inadequate for a tool whose danger is in what the action MEANS —
   * ADR-273 D4 requires the preview to name the exact target and the
   * exact action, because the failure it guards is a misheard member
   * name nudging the wrong agent. Receives the validated args with
   * `confirm_token` already stripped, plus the resolved team name.
   */
  preview?(args: Record<string, unknown>, team: string | null): string;
}

const TEAM_PARAM = z
  .string()
  .min(1)
  .optional()
  .describe("Team name; defaults to the session's current team");

/**
 * A value that lands in a POSITIONAL argv slot must not be able to pose
 * as a flag (ADR-272 D2 §Supplement — a transcript must never become a
 * shell token, and a CLI flag is that same problem one layer up).
 *
 * Two concrete escapes this closes, both reachable from a spoken phrase:
 *   claim_task(task_id: "--next", member: "x")
 *     → argv ["--next", "--as", "x"] → `parseClaimDoneArgs` sets
 *       next=true and `claim` routes to `claimNext()` — it claims
 *       whatever is NEXT in the lane, not the task the operator named.
 *   dispatch_task(member: "be-1", task_id: "--socket")
 *     → argv ["be-1", "--socket", "--team-dir", "<root>"] →
 *       `parseDispatchArgs` eats "--team-dir" as the socket VALUE, so
 *       the dispatch runs against an attacker-named tmux socket AND
 *       loses its `--team-dir`, silently retargeting the voice server's
 *       cwd team instead of the team the operator named.
 *
 * Why a regex and not a `--` terminator — RE-VERIFIED 2026-08-15 by
 * reading both parsers, not by inheriting the prior claim:
 *   - `parseDispatchArgs` (src/verbs/dispatch.ts:92) and
 *     `parseClaimDoneArgs` (src/verbs/claim.ts:137) each end their flag
 *     chain with `if (a?.startsWith("-")) throw UsageError` and neither
 *     has a `--` case. A `--` we appended would not be inert — it would
 *     HARD-FAIL every call with `unknown flag: --`.
 *   - Teaching those two parsers `--` is a change to verbs the whole
 *     team system drives (`claim --next` is the pull model's core loop),
 *     so the regression risk dominates the redundancy it would buy.
 *     Decision: keep the schema guard as the complete fix for these two
 *     parsers; do NOT touch them. See ADR-272 D2 §Supplement.
 *   - `parseTellLeadArgs` (src/verbs/tell-lead.ts:96) and `parseAddArgs`
 *     (src/verbs/task.ts:810) DO honour `--`, which is why `tell_lead`
 *     and `add_task` route their free text through it and may keep
 *     accepting a leading dash (an operator genuinely says "-urgent").
 *     {@link TERMINATOR_HONOURING_RUNNERS} pins that set; the catalog
 *     test proves it by running the real parsers.
 *
 * The head class is `[^\s-]`, not `[^-]`: leading whitespace is never a
 * spoken id or member name, and admitting it would hand any parser that
 * ever learns to `.trim()` its argv a way straight around the dash
 * check. No parser trims today — this closes the bypass before one does.
 */
const ARGV_SAFE_HEAD = /^[^\s-]/;

/**
 * THE shared validator for a free-text catalog argument that reaches a
 * bare positional argv slot. Every such argument must carry it; the
 * catalog test enumerates the catalog, derives each argument's real
 * argv slot via {@link auditArgvSlots}, and fails if a positional one
 * does not reject a leading dash.
 *
 * The guard is a `.regex()`, and `pattern` is NOT a legal key in the
 * flat provider schema — {@link toolJsonSchema} drops it in its
 * whitelist post-pass, and the flat-schema test pins that for every
 * entry. Adding a guard here can never widen the provider-facing shape.
 */
export function positionalParam(description: string): z.ZodString {
  return z
    .string()
    .min(1)
    .regex(ARGV_SAFE_HEAD, "must not start with '-' or whitespace (it would be read as a CLI flag)")
    .describe(description);
}

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
export const VOX_TOOL_CATALOG: ReadonlyArray<VoxToolEntry> = Object.freeze([
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
    // ADR-273 D1 — the two triage tools, split by ATTENTION rather than
    // by team. Both are read-only, so both survive
    // `ATMUX_VOX_READONLY=1`; that is why the survey half ships first.
    name: "fleet_attention",
    description:
      "What needs the operator across the WHOLE fleet, most urgent first, with the evidence for each. Use this for 'what needs me', 'anything stuck', 'how is everything'. One call replaces a per-team sweep.",
    // `top` is an integer, so it cannot carry a flag into the argv it
    // renders into (`auditArgvSlots` skips non-string args by
    // construction, and `String(3)` can never start with a dash). The
    // tool declares NO free-text argument at all — deliberately: a fleet
    // survey has nothing an operator's transcript needs to name.
    params: z.object({
      top: z
        .number()
        .int()
        .min(1)
        .max(15)
        .default(5)
        .describe("How many items to speak in full before the rest become a count (1-15)"),
    }),
    mutating: false,
    confirm: false,
    runnerKey: "fleet",
    argv: (args) => [
      "--attention",
      ...(typeof args.top === "number" ? ["--top", String(args.top)] : []),
    ],
  },
  {
    name: "fleet_quiet",
    description:
      "The complement of fleet_attention: an aggregated all-clear across the fleet — team and pane counts only, never a list. Use it to confirm an empty attention list actually means everything is fine.",
    params: z.object({}),
    mutating: false,
    confirm: false,
    runnerKey: "fleet",
    argv: () => ["--quiet"],
  },
  {
    // ADR-273 §Supplement — the two INFRASTRUCTURE reads. Neither is
    // team-scoped: a host and a provider quota belong to the whole
    // fleet, and asking "which team is hax in" is a category error.
    //
    // `host_pressure` declares NO parameters at all. A per-host filter
    // was considered and dropped: the spoken question is "how is the box
    // holding up", which means every box, and a tool with no free-text
    // argument has no flag-injection surface to reason about.
    name: "host_pressure",
    description:
      "CPU, memory and disk headroom for every host the fleet runs on (hax and hig), where a host that cannot be reached is reported as UNREACHABLE rather than healthy. Use this for 'how is the box holding up', 'are we out of disk', 'is hig up'.",
    params: z.object({}),
    mutating: false,
    confirm: false,
    runnerKey: "hostPressure",
    argv: () => [],
  },
  {
    // `provider` is an enum over the frozen in-code list, so a
    // transcript SELECTS a provider and can never author one; the value
    // lands in a `--provider` FLAG-VALUE slot, which the verb's parser
    // reads as data. `cache_only` is a boolean and renders to a bare
    // flag we emit ourselves — no operator string reaches argv here at
    // all, which is why neither argument carries `positionalParam`.
    name: "token_budget",
    description:
      "AI account quota headroom across Codex, Claude, Z.ai and Kimi — how much of each budget is CONSUMED (not how much remains), and exactly when each window resets. Use this for 'how much budget have I got left', 'am I rate limited', 'when does my quota reset'; set cache_only for an instant answer from the last snapshot instead of a live probe.",
    params: z.object({
      provider: z
        .enum(BUDGET_PROVIDERS)
        .default("all")
        .describe("Which provider to report; 'all' covers every account"),
      cache_only: z
        .boolean()
        .default(false)
        .describe(
          "Read the last snapshot instead of probing live. Much faster; the answer is explicitly labelled CACHED with its age",
        ),
    }),
    mutating: false,
    confirm: false,
    runnerKey: "tokenBudget",
    argv: (args) => [
      ...(typeof args.provider === "string" ? ["--provider", args.provider] : []),
      ...(args.cache_only === true ? ["--cache-only"] : []),
    ],
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
    // `member` lands in a `--member` VALUE slot, which
    // `parsePaneStateArgs` consumes unconditionally, so this guard is
    // defence in depth rather than a closed escape — the honest reading
    // of the 2026-08-15 audit, which found no live flag-injection here.
    // Kept because a leading dash is never a real member name and the
    // slot is one argv-shape change away from becoming positional.
    params: z.object({
      team: TEAM_PARAM,
      member: positionalParam("Member name as listed in team status"),
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
    // `title` lands AFTER `--` and `body` lands in a `--body` VALUE
    // slot, both of which `parseAddArgs` reads as data — so neither is
    // dash-guarded on purpose ("-- rewrite the seed script" is a real
    // thing an operator says). The catalog test re-derives both slots
    // from this argv builder and drives `parseAddArgs` for real, so a
    // shape change here that moves either into a positional slot fails
    // the gate instead of shipping.
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
    // `member` is REQUIRED (ADR-272 D6 §Supplement-2026-08-16). It was
    // `.optional()`, and that was a schema promising something the verb
    // cannot deliver: `parseDispatchArgs` demands BOTH positionals, so a
    // call that omitted `member` slid `task_id` into the member slot,
    // left the id empty, and threw `UsageError` — a guaranteed
    // `verb_failed` for a call the model had every reason to believe was
    // legal, and whose spoken error names a member the operator never
    // said. Required makes the same mistake a clean `bad_args` at
    // validation, before any argv exists.
    params: withConfirmToken({
      team: TEAM_PARAM,
      task_id: positionalParam("Task id (full id or as read back)"),
      member: positionalParam("Member to dispatch to"),
    }),
    mutating: true,
    confirm: true,
    runnerKey: "dispatch",
    // Both positionals are unconditional now that `member` is required.
    // The old `typeof args.member === "string" ? … : []` shape is gone
    // with the optionality it existed for: keeping it would leave a
    // branch that can only fire on args the schema has already rejected.
    argv: (args, teamRoot) => [
      asString(args.member),
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
      task_id: positionalParam("Task id (full id or as read back)"),
      member: positionalParam("Member who takes ownership"),
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
  {
    // ADR-273 D4/D5 — the BOUNDED half of pane input. `pane_send` (free
    // text) is NOT here and cannot be added without ADR-272 §Deferred's
    // second-factor decision (ADR-273 OQ-1).
    //
    // `action` is a zod ENUM over the frozen in-code allow-list
    // (`NUDGE_ACTION_SPECS`), so a transcript SELECTS an action, never
    // authors one. The word actually pasted is a compile-time constant
    // the verb looks up from that name; the enum value itself lands in a
    // `--action` FLAG-VALUE slot, which every parser in the runner map
    // reads as data (`auditArgvSlots` derives and the catalog test pins
    // both facts). `member` carries `positionalParam` as defence in
    // depth for the same reason `member_pane` does — it is one argv
    // shape change away from becoming positional, and a leading dash is
    // never a real member name.
    name: "pane_nudge",
    description:
      "Unstick ONE member's pane: press Enter on the text already in its composer, or send one canned resume word. Confirmation is required, and no operator-supplied text is ever typed into the pane.",
    params: withConfirmToken({
      team: TEAM_PARAM,
      member: positionalParam(
        "Member whose pane to nudge, as named by fleet_attention. Driver panes (driver, driver-2, ...) cannot be nudged — ADR-239 forbids atmux typing into them.",
      ),
      action: z
        .enum(NUDGE_ACTIONS)
        .default("submit")
        .describe(
          "submit = press Enter on whatever is already in the composer (the wedged-pane case, and permission prompts); continue = type the single word 'continue' and submit it (a pane that stopped with an empty composer)",
        ),
    }),
    mutating: true,
    confirm: true,
    runnerKey: "nudge",
    preview: nudgeConfirmPreview,
    argv: (args, teamRoot) => [
      "--member",
      asString(args.member),
      "--action",
      asString(args.action),
      ...teamDirArgs(teamRoot),
    ],
  },
]);

/** Look up a catalog entry by tool name. */
export function findTool(name: string): VoxToolEntry | undefined {
  return VOX_TOOL_CATALOG.find((t) => t.name === name);
}

/** True when the tool takes an (optional) `team` param — i.e. the
 *  bridge must resolve a team root before building argv. */
export function isTeamScoped(entry: VoxToolEntry): boolean {
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
export function toolJsonSchema(entry: VoxToolEntry): FlatToolSchema {
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

// ---------- argv-slot audit (ADR-272 D2 §Supplement) ----------
//
// The structural half of the flag-injection guard. A reject-list of
// today's known-bad strings stops today's bug and nothing else; what
// stops the NEXT one is deriving, from the argv builder itself, WHERE a
// given argument actually lands — and then demanding the guard of every
// argument that lands somewhere a flag would be read.
//
// This is why `member_pane` was found: nobody reported it, but a
// slot-by-slot sweep names it without being told to look.

/**
 * Where an argument's value lands in the argv an entry builds:
 *
 * - `positional` — a bare token. Every parser in the runner map treats
 *   a `-`-prefixed bare token as a FLAG, so this slot demands
 *   {@link positionalParam}.
 * - `flag-value` — the token right after a `-`-prefixed flag. Every
 *   parser in the runner map takes `argv[i + 1]` unconditionally, so a
 *   dash-led value here is read as the VALUE, not a flag. Safe — and
 *   the catalog test re-proves it against the real parsers rather than
 *   trusting this sentence.
 * - `terminated` — after a `--` token. Safe only when the runner's
 *   parser honours `--`; see {@link TERMINATOR_HONOURING_RUNNERS}.
 * - `absent` — never reaches argv (e.g. `team`, which resolves through
 *   the team index into a trusted root, and `limit`, which the bridge
 *   consumes to cap output lines).
 */
export type ArgvSlot = "positional" | "flag-value" | "terminated" | "absent";

/** Sentinel substituted for one argument at a time when probing. NUL
 *  padding so it can never collide with a real spoken value. */
export const ARGV_PROBE = "\u0000atmux-argv-probe\u0000";

/**
 * Runners whose verb parser implements a `--` terminator, so an argument
 * placed after `--` is read as data no matter what it starts with.
 *
 * Verified in-source: `parseTellLeadArgs` (src/verbs/tell-lead.ts:96)
 * and `parseAddArgs` (src/verbs/task.ts:810). Every OTHER runner throws
 * `unknown flag: --` on the token, so emitting `--` for them would break
 * the call outright — the catalog test drives the real parsers to keep
 * this set honest.
 */
export const TERMINATOR_HONOURING_RUNNERS: ReadonlySet<VoxRunnerKey> = new Set<VoxRunnerKey>([
  "tellLead",
  "task",
]);

/** Worst-first ranking — an argument is judged by the most dangerous
 *  slot it can reach across the arg combinations probed. */
const SLOT_RANK: Record<ArgvSlot, number> = {
  absent: 0,
  terminated: 1,
  "flag-value": 2,
  positional: 3,
};

/** Classify where {@link ARGV_PROBE} (or any sentinel) sits in an argv. */
export function classifyArgvSlot(argv: ReadonlyArray<string>, probe: string): ArgvSlot {
  const idx = argv.indexOf(probe);
  if (idx === -1) return "absent";
  if (argv.slice(0, idx).includes("--")) return "terminated";
  // At idx 0 there is no preceding token, so `argv[-1]` is undefined and
  // the value is a bare positional — the most dangerous slot.
  if (argv[idx - 1]?.startsWith("-") === true) return "flag-value";
  return "positional";
}

/**
 * Derive the real argv slot of every STRING argument of an entry, by
 * substituting a sentinel and reading the argv the entry itself builds.
 *
 * Probed across several arg combinations, because an OPTIONAL argument
 * that is absent SHIFTS the positional slots after it — `dispatch_task`
 * is exactly that shape (`[member?, task_id, ...]`), so `task_id` sits
 * at index 1 with a member and index 0 without. Judging only the full
 * arg set would misread a slot that a real call can still reach. The
 * strictest verdict across variants wins.
 *
 * Non-string arguments are skipped: they cannot carry a flag (`limit`
 * and `priority` are bounded integers, rendered via `String()`).
 */
export function auditArgvSlots(
  entry: VoxToolEntry,
  sampleArgs: Readonly<Record<string, unknown>>,
  teamRoot: string | null,
): Record<string, ArgvSlot> {
  const required = new Set(toolJsonSchema(entry).required ?? []);
  const keys = Object.keys(sampleArgs);
  const optional = keys.filter((k) => !required.has(k));
  const out: Record<string, ArgvSlot> = {};
  for (const key of keys) {
    if (typeof sampleArgs[key] !== "string") continue;
    // Variants: the full sample; the sample minus each OTHER optional
    // argument (one at a time); and the required-only floor.
    const variants: Array<Record<string, unknown>> = [{ ...sampleArgs }];
    for (const drop of optional) {
      if (drop === key) continue;
      const variant = { ...sampleArgs };
      delete variant[drop];
      variants.push(variant);
    }
    const floor: Record<string, unknown> = {};
    for (const k of keys) {
      if (required.has(k) || k === key) floor[k] = sampleArgs[k];
    }
    variants.push(floor);

    let worst: ArgvSlot = "absent";
    for (const variant of variants) {
      const slot = classifyArgvSlot(
        entry.argv({ ...variant, [key]: ARGV_PROBE }, teamRoot),
        ARGV_PROBE,
      );
      if (SLOT_RANK[slot] > SLOT_RANK[worst]) worst = slot;
    }
    out[key] = worst;
  }
  return out;
}
