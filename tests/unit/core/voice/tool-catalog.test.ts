// Unit tests for src/core/voice/tool-catalog.ts — ADR-272 D6 frozen v1
// tool surface.
//
// Pins:
//   - The catalog is EXACTLY the D6 list: 10 read + 4 messaging tools;
//     mutating on exactly the 4 messaging tools; confirm on exactly
//     dispatch_task + claim_task; runnerKey null only for list_teams.
//   - EVERY entry's derived JSON schema is FLAT — scalar/enum property
//     types only, no nested objects/arrays/unions/$ref. This is the one
//     guard keeping both provider dialects happy.
//   - argv shapes parse against the REAL verb parsers (imported from
//     src/verbs/** — allowed in tests; the core fence bans only core →
//     verbs imports).

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  ARGV_PROBE,
  type ArgvSlot,
  auditArgvSlots,
  classifyArgvSlot,
  findTool,
  isTeamScoped,
  positionalParam,
  TERMINATOR_HONOURING_RUNNERS,
  toolJsonSchema,
  VOICE_TOOL_CATALOG,
  type VoiceRunnerKey,
  type VoiceToolEntry,
} from "../../../../src/core/voice/tool-catalog.ts";
import { ConfigError, UsageError } from "../../../../src/errors.ts";
import { parseBlockersArgs } from "../../../../src/verbs/blockers.ts";
import { parseClaimDoneArgs } from "../../../../src/verbs/claim.ts";
import { parseCostArgs } from "../../../../src/verbs/cost.ts";
import { parseDispatchArgs } from "../../../../src/verbs/dispatch.ts";
import { parseDriverInboxArgs } from "../../../../src/verbs/driver-inbox.ts";
import { parseFleetArgs } from "../../../../src/verbs/fleet.ts";
import { parseHealthArgs } from "../../../../src/verbs/health.ts";
import { parsePaneStateArgs } from "../../../../src/verbs/pane-state.ts";
import { parseOutboxArgs } from "../../../../src/verbs/reply.ts";
import { parseStatusArgs } from "../../../../src/verbs/status.ts";
import { parseAddArgs, parseListArgs } from "../../../../src/verbs/task.ts";
import { parseTellLeadArgs } from "../../../../src/verbs/tell-lead.ts";
import { parseTopoArgs } from "../../../../src/verbs/topo.ts";

const ROOT = "/w/atmux";

function entry(name: string): VoiceToolEntry {
  const e = findTool(name);
  if (e === undefined) throw new Error(`catalog miss: ${name}`);
  return e;
}

describe("catalog surface (ADR-272 D6, frozen)", () => {
  test("exactly the 16 tools (D6's 14 + ADR-273's 2), in a stable order", () => {
    expect(VOICE_TOOL_CATALOG.map((t) => t.name)).toEqual([
      "list_teams",
      "fleet_overview",
      "fleet_attention",
      "fleet_quiet",
      "team_status",
      "team_health",
      "list_tasks",
      "member_pane",
      "driver_inbox",
      "lead_outbox",
      "cost_report",
      "list_blockers",
      "tell_lead",
      "add_task",
      "dispatch_task",
      "claim_task",
    ]);
  });

  test("mutating on exactly the 4 messaging tools", () => {
    const mutating = VOICE_TOOL_CATALOG.filter((t) => t.mutating).map((t) => t.name);
    expect(mutating).toEqual(["tell_lead", "add_task", "dispatch_task", "claim_task"]);
  });

  test("confirm on exactly dispatch_task + claim_task", () => {
    const confirm = VOICE_TOOL_CATALOG.filter((t) => t.confirm).map((t) => t.name);
    expect(confirm).toEqual(["dispatch_task", "claim_task"]);
  });

  test("every confirm tool is also mutating", () => {
    for (const t of VOICE_TOOL_CATALOG.filter((t) => t.confirm)) {
      expect(t.mutating).toBe(true);
    }
  });

  test("runnerKey is null ONLY for list_teams", () => {
    const runnerless = VOICE_TOOL_CATALOG.filter((t) => t.runnerKey === null).map((t) => t.name);
    expect(runnerless).toEqual(["list_teams"]);
  });

  test("runner keys map per the header module-map", () => {
    const map = Object.fromEntries(VOICE_TOOL_CATALOG.map((t) => [t.name, t.runnerKey]));
    expect(map).toEqual({
      list_teams: null,
      fleet_overview: "topo",
      fleet_attention: "fleet",
      fleet_quiet: "fleet",
      team_status: "status",
      team_health: "health",
      list_tasks: "task",
      member_pane: "paneState",
      driver_inbox: "driverInbox",
      lead_outbox: "outbox",
      cost_report: "cost",
      list_blockers: "blockers",
      tell_lead: "tellLead",
      add_task: "task",
      dispatch_task: "dispatch",
      claim_task: "claim",
    });
  });

  test("team-scoped = every tool except the four fleet-wide reads", () => {
    // ADR-273 D1: triage is split by ATTENTION, not by team, so neither
    // new tool takes a `team` param — a fleet survey that needed one
    // would be the N x M call pattern the ADR exists to replace.
    const fleetWide = VOICE_TOOL_CATALOG.filter((t) => !isTeamScoped(t)).map((t) => t.name);
    expect(fleetWide).toEqual(["list_teams", "fleet_overview", "fleet_attention", "fleet_quiet"]);
  });

  test("confirm_token is declared on exactly the confirm-gated tools", () => {
    for (const t of VOICE_TOOL_CATALOG) {
      expect("confirm_token" in t.params.shape).toBe(t.confirm);
    }
  });

  test("descriptions are voice-oriented: non-empty, ≤3 sentences", () => {
    // Was ≤2. Raised to 3 for exactly one reason: the two ADR-273 tools
    // must tell the model WHEN to reach for them ("what needs me", "is
    // it really all clear") on top of what they do, and a model that
    // picks `team_status` twenty times instead of `fleet_attention` once
    // has defeated D1. Still a hard cap — a paragraph read aloud is not
    // a tool description.
    for (const t of VOICE_TOOL_CATALOG) {
      expect(t.description.length).toBeGreaterThan(0);
      const sentences = t.description.split(/[.!?]+\s/).filter((s) => s.trim().length > 0);
      expect(sentences.length).toBeLessThanOrEqual(3);
    }
    // The pre-ADR-273 twelve stay at ≤2 — the raise is not a licence to
    // let every description grow.
    for (const t of VOICE_TOOL_CATALOG) {
      if (t.name === "fleet_attention" || t.name === "fleet_quiet") continue;
      const sentences = t.description.split(/[.!?]+\s/).filter((s) => s.trim().length > 0);
      expect(sentences.length, `${t.name} grew past 2 sentences`).toBeLessThanOrEqual(2);
    }
  });

  test("findTool: unknown name → undefined", () => {
    expect(findTool("rm_rf_slash")).toBeUndefined();
  });
});

describe("flat-schema guard — EVERY entry derives a flat provider schema", () => {
  const SCALARS = ["string", "number", "integer", "boolean"];

  test.each(VOICE_TOOL_CATALOG.map((t) => [t.name, t] as const))("%s derives flat", (_name, t) => {
    const schema = toolJsonSchema(t);
    expect(schema.type).toBe("object");
    for (const [key, prop] of Object.entries(schema.properties)) {
      expect(SCALARS).toContain(prop.type);
      // No nesting artifacts of any kind may survive post-processing.
      const keys = Object.keys(prop);
      for (const k of keys) expect(["type", "description", "enum"]).toContain(k);
      if (prop.enum !== undefined) {
        for (const v of prop.enum) expect(typeof v).toBe("string");
      }
      expect(key.length).toBeGreaterThan(0);
    }
    const raw = JSON.stringify(schema);
    expect(raw).not.toContain("$ref");
    expect(raw).not.toContain("anyOf");
    expect(raw).not.toContain("oneOf");
    expect(raw).not.toContain("$schema");
    expect(raw).not.toContain("additionalProperties");
  });

  test("required lists exactly the mandatory params", () => {
    expect(toolJsonSchema(entry("member_pane")).required).toEqual(["member"]);
    expect(toolJsonSchema(entry("claim_task")).required).toEqual(["task_id", "member"]);
    expect(toolJsonSchema(entry("dispatch_task")).required).toEqual(["task_id"]);
    expect(toolJsonSchema(entry("add_task")).required).toEqual(["title"]);
    expect(toolJsonSchema(entry("tell_lead")).required).toEqual(["message"]);
    expect(toolJsonSchema(entry("list_teams")).required).toBeUndefined();
    // `limit` has a default → optional for the model (io: "input").
    expect(toolJsonSchema(entry("list_tasks")).required).toBeUndefined();
  });

  test("enum params survive as string enums", () => {
    const synthetic: VoiceToolEntry = {
      name: "synthetic_enum",
      description: "test-only.",
      params: z.object({ kind: z.enum(["a", "b"]).optional() }),
      mutating: false,
      confirm: false,
      runnerKey: "topo",
      argv: () => [],
    };
    const schema = toolJsonSchema(synthetic);
    expect(schema.properties.kind).toEqual({ type: "string", enum: ["a", "b"] });
  });

  test("a nested-object param throws ConfigError (fails loudly at wiring time)", () => {
    const bad: VoiceToolEntry = {
      name: "bad_tool",
      description: "test-only.",
      params: z.object({ nested: z.object({ x: z.string() }) }),
      mutating: false,
      confirm: false,
      runnerKey: "topo",
      argv: () => [],
    };
    expect(() => toolJsonSchema(bad)).toThrow(ConfigError);
  });

  test("an array param throws ConfigError", () => {
    const bad: VoiceToolEntry = {
      name: "bad_tool",
      description: "test-only.",
      params: z.object({ xs: z.array(z.string()) }),
      mutating: false,
      confirm: false,
      runnerKey: "topo",
      argv: () => [],
    };
    expect(() => toolJsonSchema(bad)).toThrow(ConfigError);
  });
});

describe("argv shapes parse against the REAL verb parsers", () => {
  test("fleet_overview → topo []", () => {
    const argv = entry("fleet_overview").argv({}, null);
    expect(argv).toEqual([]);
    expect(parseTopoArgs(argv)).toMatchObject({ tree: false, reap: false });
  });

  test("list_teams → [] (core-direct, no runner)", () => {
    expect(entry("list_teams").argv({}, null)).toEqual([]);
  });

  test("team_status → status --team-dir", () => {
    const argv = entry("team_status").argv({ team: "atmux" }, ROOT);
    expect(argv).toEqual(["--team-dir", ROOT]);
    expect(parseStatusArgs(argv)).toEqual({ json: false, teamDir: ROOT });
  });

  test("team_health → health --text --team-dir", () => {
    const argv = entry("team_health").argv({}, ROOT);
    expect(argv).toEqual(["--text", "--team-dir", ROOT]);
    expect(parseHealthArgs(argv)).toMatchObject({ text: true, json: false, teamDir: ROOT });
  });

  test("list_tasks → task list --team-dir", () => {
    const argv = entry("list_tasks").argv({ limit: 10 }, ROOT);
    expect(argv).toEqual(["list", "--team-dir", ROOT]);
    expect(argv[0]).toBe("list");
    expect(parseListArgs(argv.slice(1))).toEqual({ json: false, teamDir: ROOT });
  });

  test("member_pane → pane-state --member --team-dir", () => {
    const argv = entry("member_pane").argv({ member: "driver-2" }, ROOT);
    expect(argv).toEqual(["--member", "driver-2", "--team-dir", ROOT]);
    expect(parsePaneStateArgs(argv)).toEqual({ member: "driver-2", json: false, teamDir: ROOT });
  });

  test("driver_inbox → driver-inbox --all --team-dir", () => {
    const argv = entry("driver_inbox").argv({}, ROOT);
    expect(argv).toEqual(["--all", "--team-dir", ROOT]);
    expect(parseDriverInboxArgs(argv)).toEqual({
      showAll: true,
      ack: false,
      json: false,
      teamDir: ROOT,
    });
  });

  test("lead_outbox → outbox --team-dir", () => {
    const argv = entry("lead_outbox").argv({}, ROOT);
    expect(argv).toEqual(["--team-dir", ROOT]);
    expect(parseOutboxArgs(argv)).toEqual({ ack: false, json: false, teamDir: ROOT });
  });

  test("cost_report → cost --team-dir", () => {
    const argv = entry("cost_report").argv({}, ROOT);
    expect(argv).toEqual(["--team-dir", ROOT]);
    expect(parseCostArgs(argv)).toEqual({ json: false, teamDir: ROOT });
  });

  test("list_blockers → blockers list --team-dir (the ADR-152 §Amendment flag)", () => {
    const argv = entry("list_blockers").argv({}, ROOT);
    expect(argv).toEqual(["list", "--team-dir", ROOT]);
    expect(parseBlockersArgs(argv)).toEqual({ subverb: "list", teamDir: ROOT });
  });

  test("tell_lead → tell-lead --team-dir -- <msg>", () => {
    const argv = entry("tell_lead").argv({ message: "deploy is green" }, ROOT);
    expect(argv).toEqual(["--team-dir", ROOT, "--", "deploy is green"]);
    expect(parseTellLeadArgs(argv)).toEqual({ msg: "deploy is green", teamDir: ROOT });
  });

  test("tell_lead message starting with '-' still parses (the -- guard)", () => {
    const argv = entry("tell_lead").argv({ message: "-urgent: check hax" }, ROOT);
    expect(parseTellLeadArgs(argv)).toEqual({ msg: "-urgent: check hax", teamDir: ROOT });
  });

  test("add_task → task add with body + priority, title after --", () => {
    const argv = entry("add_task").argv(
      { title: "check the deploy", body: "see hig", priority: 2 },
      ROOT,
    );
    expect(argv).toEqual([
      "add",
      "--team-dir",
      ROOT,
      "--body",
      "see hig",
      "--priority",
      "2",
      "--",
      "check the deploy",
    ]);
    expect(parseAddArgs(argv.slice(1))).toEqual({
      subject: "check the deploy",
      body: "see hig",
      priority: 2,
      teamDir: ROOT,
    });
  });

  test("add_task minimal: title only, even when it starts with '-'", () => {
    const argv = entry("add_task").argv({ title: "-review the queue" }, ROOT);
    expect(argv).toEqual(["add", "--team-dir", ROOT, "--", "-review the queue"]);
    expect(parseAddArgs(argv.slice(1))).toEqual({
      subject: "-review the queue",
      teamDir: ROOT,
    });
  });

  test("dispatch_task → dispatch <member> <task-id> --team-dir", () => {
    const argv = entry("dispatch_task").argv({ task_id: "t-abc123", member: "driver-2" }, ROOT);
    expect(argv).toEqual(["driver-2", "t-abc123", "--team-dir", ROOT]);
    expect(parseDispatchArgs(argv)).toEqual({
      member: "driver-2",
      id: "t-abc123",
      noPing: false,
      teamDir: ROOT,
    });
  });

  test("dispatch_task without member: the verb's own parser refuses with usage (documented failure mode)", () => {
    const argv = entry("dispatch_task").argv({ task_id: "t-abc123" }, ROOT);
    expect(argv).toEqual(["t-abc123", "--team-dir", ROOT]);
    expect(() => parseDispatchArgs(argv)).toThrow(UsageError);
  });

  test("claim_task → claim <task-id> --as <member> --team-dir", () => {
    const argv = entry("claim_task").argv({ task_id: "t-abc123", member: "driver-3" }, ROOT);
    expect(argv).toEqual(["t-abc123", "--as", "driver-3", "--team-dir", ROOT]);
    expect(parseClaimDoneArgs(argv, "claim")).toEqual({
      id: "t-abc123",
      who: "driver-3",
      teamDir: ROOT,
    });
  });

  test("team-scoped argv with null root omits --team-dir (cwd fallback)", () => {
    expect(entry("team_status").argv({}, null)).toEqual([]);
    expect(entry("lead_outbox").argv({}, null)).toEqual([]);
  });
});

describe("param validation shapes", () => {
  test.each([
    ["tell_lead", { message: "" }, false],
    ["tell_lead", { message: "x".repeat(501) }, false],
    ["tell_lead", { message: "x".repeat(500) }, true],
    ["add_task", { title: "" }, false],
    ["add_task", { title: "x".repeat(201) }, false],
    ["add_task", { title: "ok", body: "x".repeat(2001) }, false],
    ["add_task", { title: "ok", priority: 0 }, false],
    ["add_task", { title: "ok", priority: 10 }, false],
    ["add_task", { title: "ok", priority: 9 }, true],
    ["list_tasks", { limit: 0 }, false],
    ["list_tasks", { limit: 26 }, false],
    ["list_tasks", { limit: 3.5 }, false],
    ["list_tasks", { limit: 25 }, true],
    ["member_pane", {}, false],
    ["claim_task", { task_id: "t-1" }, false],
  ])("%s params %j → success=%p", (name, args, ok) => {
    expect(entry(name as string).params.safeParse(args).success).toBe(ok);
  });

  test("list_tasks fills limit default 10", () => {
    const parsed = entry("list_tasks").params.parse({});
    expect(parsed).toMatchObject({ limit: 10 });
  });
});

describe("argv hygiene — a spoken value may not pose as a CLI flag", () => {
  // ADR-272 D2 promises a transcript never becomes a shell token. A CLI
  // flag is that same problem one layer up: both target parsers treat any
  // `-`-prefixed token as a flag, and NEITHER implements a `--`
  // terminator (verified in src/verbs/dispatch.ts + src/verbs/claim.ts),
  // so the guard has to live in the schema.

  test("claim_task rejects task_id '--next' (would claim the wrong task)", () => {
    const parsed = entry("claim_task").params.safeParse({ task_id: "--next", member: "be-1" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(JSON.stringify(parsed.error.issues)).toContain("CLI flag");
    }
  });

  test("dispatch_task rejects member '--socket' (would retarget the tmux socket)", () => {
    const parsed = entry("dispatch_task").params.safeParse({
      member: "--socket",
      task_id: "/tmp/x",
    });
    expect(parsed.success).toBe(false);
  });

  test("every positional param refuses a leading dash", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["claim_task", { task_id: "--next", member: "be-1" }],
      ["claim_task", { task_id: "t-1234", member: "--as" }],
      ["dispatch_task", { task_id: "--team-dir", member: "be-1" }],
      ["dispatch_task", { task_id: "t-1234", member: "--no-ping" }],
      ["member_pane", { member: "--member" }],
    ];
    for (const [tool, args] of cases) {
      expect(
        entry(tool).params.safeParse(args).success,
        `${tool} accepted ${JSON.stringify(args)}`,
      ).toBe(false);
    }
  });

  test("ordinary ids and member names still pass", () => {
    expect(
      entry("claim_task").params.safeParse({ task_id: "t-4a2f", member: "be-1" }).success,
    ).toBe(true);
    expect(
      entry("dispatch_task").params.safeParse({ task_id: "t-4a2f", member: "fe-2" }).success,
    ).toBe(true);
    expect(entry("member_pane").params.safeParse({ member: "be-1" }).success).toBe(true);
    // dispatch_task.member stays OPTIONAL after the guard.
    expect(entry("dispatch_task").params.safeParse({ task_id: "t-4a2f" }).success).toBe(true);
  });

  test("a dash INSIDE the value is fine — only a LEADING dash is a flag", () => {
    expect(
      entry("claim_task").params.safeParse({ task_id: "t-4a2f", member: "px-crm-1" }).success,
    ).toBe(true);
  });

  test("the guard survives into the provider-facing JSON schema as a plain string", () => {
    // The flat-schema contract admits no regex/pattern key, so the guard
    // must not leak a non-flat property to the provider.
    const schema = toolJsonSchema(entry("claim_task"));
    expect(schema.properties.task_id).toEqual({
      type: "string",
      description: "Task id (full id or as read back)",
    });
  });

  test("NO guarded entry leaks a `pattern` key into any provider schema", () => {
    // Generalizes the pin above across the whole catalog: `.regex()` maps
    // to `pattern` in raw JSON Schema, and a single leak breaks the flat
    // contract both provider dialects depend on.
    for (const t of VOICE_TOOL_CATALOG) {
      expect(JSON.stringify(toolJsonSchema(t))).not.toContain("pattern");
    }
  });

  test("the shared validator itself rejects a dash OR a leading space, and accepts a real id", () => {
    // positionalParam is THE validator the structural gate below demands.
    // If it stopped rejecting, every dependent assertion would be hollow.
    const p = positionalParam("probe");
    expect(p.safeParse("--next").success).toBe(false);
    expect(p.safeParse("-x").success).toBe(false);
    expect(p.safeParse(" --next").success).toBe(false);
    expect(p.safeParse("\t-x").success).toBe(false);
    expect(p.safeParse("").success).toBe(false);
    expect(p.safeParse("t-4a2f").success).toBe(true);
    expect(p.safeParse("px-crm-1").success).toBe(true);
  });

  test("leading whitespace can no longer smuggle a flag past the dash check", () => {
    // Pre-hardening the class was /^[^-]/, so " --next" passed. No parser
    // trims its argv today; this closes the bypass before one does.
    for (const [tool, args] of [
      ["claim_task", { task_id: " --next", member: "be-1" }],
      ["dispatch_task", { task_id: " --socket", member: "be-1" }],
      ["member_pane", { member: " --json" }],
    ] as Array<[string, Record<string, unknown>]>) {
      expect(
        entry(tool).params.safeParse(args).success,
        `${tool} accepted ${JSON.stringify(args)}`,
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------
// Structural gate — the half that stops the NEXT flag-injection, not the
// last one. Every assertion below is DERIVED (from the argv builders, or
// by running the real verb parsers), never from a hand-kept list of
// known-bad strings.
// ---------------------------------------------------------------------

/** One representative arg set per tool. The enumeration guards below
 *  fail if a new tool, or a new string arg on an existing tool, is not
 *  represented here — so the sweep cannot silently go stale. */
const SAMPLES: Record<string, Record<string, unknown>> = {
  list_teams: {},
  fleet_overview: {},
  fleet_attention: { top: 5 },
  fleet_quiet: {},
  team_status: { team: "atmux" },
  team_health: { team: "atmux" },
  list_tasks: { team: "atmux", limit: 5 },
  member_pane: { team: "atmux", member: "be-1" },
  driver_inbox: { team: "atmux" },
  lead_outbox: { team: "atmux" },
  cost_report: { team: "atmux" },
  list_blockers: { team: "atmux" },
  tell_lead: { team: "atmux", message: "deploy is green" },
  add_task: { team: "atmux", title: "check the deploy", body: "see hig", priority: 2 },
  dispatch_task: { team: "atmux", task_id: "t-abc123", member: "be-1" },
  claim_task: { team: "atmux", task_id: "t-abc123", member: "be-1" },
};

/** The bridge strips `confirm_token` BEFORE calling `entry.argv`
 *  (tool-bridge.ts step 4), so it never reaches an argv slot and is
 *  deliberately absent from every sample. */
const NEVER_REACHES_ARGV = new Set(["confirm_token"]);

/** Every argument's real argv slot — the audit table, pinned. A shape
 *  change to any argv builder shows up here as a diff instead of as a
 *  silent new exposure. */
const EXPECTED_SLOTS: Record<string, Record<string, ArgvSlot>> = {
  list_teams: {},
  fleet_overview: {},
  fleet_attention: {},
  fleet_quiet: {},
  team_status: { team: "absent" },
  team_health: { team: "absent" },
  list_tasks: { team: "absent" },
  member_pane: { team: "absent", member: "flag-value" },
  driver_inbox: { team: "absent" },
  lead_outbox: { team: "absent" },
  cost_report: { team: "absent" },
  list_blockers: { team: "absent" },
  tell_lead: { team: "absent", message: "terminated" },
  add_task: { team: "absent", title: "terminated", body: "flag-value" },
  dispatch_task: { team: "absent", task_id: "positional", member: "positional" },
  claim_task: { team: "absent", task_id: "positional", member: "flag-value" },
};

/**
 * Mirror of `task()`'s subverb split (src/verbs/task.ts:214-217) so a
 * probe reaches the same parser a real invocation would, then the real
 * parser for every runner in the map. These are the ACTUAL verb parsers
 * — the point of the gate is that the catalog's safety claims are
 * checked against them, not against a description of them.
 */
const RUNNER_PARSERS: Record<VoiceRunnerKey, (argv: ReadonlyArray<string>) => unknown> = {
  topo: (a) => parseTopoArgs(a),
  fleet: (a) => parseFleetArgs(a),
  status: (a) => parseStatusArgs(a),
  health: (a) => parseHealthArgs(a),
  task: (a) => {
    const first = a[0];
    const isFlag = first?.startsWith("-") === true;
    const rest = first === undefined || isFlag ? a : a.slice(1);
    return first === "add" ? parseAddArgs(rest) : parseListArgs(rest);
  },
  paneState: (a) => parsePaneStateArgs(a),
  driverInbox: (a) => parseDriverInboxArgs(a),
  outbox: (a) => parseOutboxArgs(a),
  cost: (a) => parseCostArgs(a),
  blockers: (a) => parseBlockersArgs(a),
  tellLead: (a) => parseTellLeadArgs(a),
  dispatch: (a) => parseDispatchArgs(a),
  claim: (a) => parseClaimDoneArgs(a, "claim"),
};

/** True when SOME own property of the parse result is EXACTLY `value` —
 *  i.e. the hostile string arrived as data, not as a flag, and was not
 *  mangled, joined, split, or dropped along the way. */
function parsedCarriesExactly(parsed: unknown, value: string): boolean {
  if (typeof parsed !== "object" || parsed === null) return false;
  return Object.values(parsed as Record<string, unknown>).some((v) => v === value);
}

/** String-typed argument names of an entry that can reach argv. */
function stringArgNames(t: VoiceToolEntry): string[] {
  return Object.entries(toolJsonSchema(t).properties)
    .filter(([k, p]) => p.type === "string" && !NEVER_REACHES_ARGV.has(k))
    .map(([k]) => k);
}

describe("structural argv-slot gate (ADR-272 D2 §Supplement)", () => {
  test("the sample table covers EXACTLY the catalog — a new tool fails here first", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(VOICE_TOOL_CATALOG.map((t) => t.name).sort());
    expect(Object.keys(EXPECTED_SLOTS).sort()).toEqual(
      VOICE_TOOL_CATALOG.map((t) => t.name).sort(),
    );
  });

  test("every string argument of every tool is sampled WITH A STRING", () => {
    // Key presence alone is not enough: `auditArgvSlots` skips
    // non-string sample values, so a string argument sampled with a
    // number would silently drop out of the sweep.
    for (const t of VOICE_TOOL_CATALOG) {
      const sample = SAMPLES[t.name] ?? {};
      for (const key of stringArgNames(t)) {
        expect(Object.keys(sample), `${t.name}.${key} is unsampled`).toContain(key);
        expect(typeof sample[key], `${t.name}.${key} sampled with a non-string`).toBe("string");
      }
    }
  });

  test.each(
    VOICE_TOOL_CATALOG.map((t) => [t.name, t] as const),
  )("%s — every argument's argv slot matches the audited table (both with and without a team root)", (name, t) => {
    const sample = SAMPLES[name] ?? {};
    for (const teamRoot of [ROOT, null]) {
      expect(auditArgvSlots(t, sample, teamRoot)).toEqual(EXPECTED_SLOTS[name] ?? {});
    }
  });

  test("EVERY argument reaching a POSITIONAL slot rejects a leading dash", () => {
    // The gate proper. Not a list of known-bad strings: the slot is
    // derived from the entry's own argv builder, so a future entry that
    // routes a new free-text arg into a positional slot without
    // positionalParam fails right here.
    let positionalArgs = 0;
    for (const t of VOICE_TOOL_CATALOG) {
      const slots = auditArgvSlots(t, SAMPLES[t.name] ?? {}, ROOT);
      for (const [key, slot] of Object.entries(slots)) {
        if (slot !== "positional") continue;
        positionalArgs += 1;
        const schema = t.params.shape[key] as z.ZodType | undefined;
        expect(schema, `${t.name}.${key} has no schema`).toBeDefined();
        for (const hostile of ["--next", "-x", " --socket", "\t-y"]) {
          expect(
            schema?.safeParse(hostile).success,
            `${t.name}.${key} accepted ${JSON.stringify(hostile)} into a POSITIONAL argv slot`,
          ).toBe(false);
        }
        // ...and still accepts what an operator actually says.
        expect(schema?.safeParse("t-4a2f").success, `${t.name}.${key} rejects a real id`).toBe(
          true,
        );
      }
    }
    // Ratio pinned so a shrinking sweep is visible: 3 of the catalog's
    // 25 arguments reach a bare positional slot. ADR-273's two tools add
    // ZERO free-text arguments, so the exposed set is unchanged.
    expect(positionalArgs).toBe(3);
  });

  test("coverage ratio: all 16 tools, all 25 arguments, none unclassified", () => {
    let argCount = 0;
    let classified = 0;
    for (const t of VOICE_TOOL_CATALOG) {
      const props = Object.keys(toolJsonSchema(t).properties);
      argCount += props.length;
      const slots = auditArgvSlots(t, SAMPLES[t.name] ?? {}, ROOT);
      // Classified = audited string args + non-string args + the
      // stripped confirm_token, i.e. every declared argument is
      // accounted for by exactly one of the three routes.
      for (const key of props) {
        const isString = toolJsonSchema(t).properties[key]?.type === "string";
        if (NEVER_REACHES_ARGV.has(key)) classified += 1;
        else if (!isString) classified += 1;
        else if (key in slots) classified += 1;
      }
    }
    expect(VOICE_TOOL_CATALOG.length).toBe(16);
    // 24 + `fleet_attention.top` (an integer, so it classifies via the
    // non-string route); `fleet_quiet` declares none.
    expect(argCount).toBe(25);
    expect(classified).toBe(25);
  });

  test("a `--` terminator is emitted ONLY for runners whose real parser honours it", () => {
    for (const t of VOICE_TOOL_CATALOG) {
      const argv = t.argv(SAMPLES[t.name] ?? {}, ROOT);
      if (!argv.includes("--")) continue;
      expect(t.runnerKey, `${t.name} emits -- with no runner`).not.toBeNull();
      expect(
        TERMINATOR_HONOURING_RUNNERS.has(t.runnerKey as VoiceRunnerKey),
        `${t.name} emits -- to runner '${t.runnerKey}', which does not honour it`,
      ).toBe(true);
    }
  });

  test("TERMINATOR_HONOURING_RUNNERS is TRUE of the real parsers, not just asserted", () => {
    // Drives every runner's actual parser with a `--` followed by a
    // dash-led token. Honouring = accepts it and carries it verbatim.
    // If dispatch/claim ever learned `--`, or tell-lead/task-add ever
    // lost it, this flips and the catalog's routing must be revisited.
    const probeArgv: Record<VoiceRunnerKey, string[]> = {
      topo: ["--", "-x"],
      fleet: ["--", "-x"],
      status: ["--", "-x"],
      health: ["--", "-x"],
      task: ["add", "--", "-x"],
      paneState: ["--member", "be-1", "--", "-x"],
      driverInbox: ["--", "-x"],
      outbox: ["--", "-x"],
      cost: ["--", "-x"],
      blockers: ["list", "--", "-x"],
      tellLead: ["--", "-x"],
      dispatch: ["--", "-x"],
      claim: ["--", "-x"],
    };
    for (const [key, argv] of Object.entries(probeArgv) as Array<[VoiceRunnerKey, string[]]>) {
      let honours = false;
      try {
        honours = parsedCarriesExactly(RUNNER_PARSERS[key](argv), "-x");
      } catch {
        honours = false;
      }
      expect(honours, `runner '${key}': observed -- support ${honours}`).toBe(
        TERMINATOR_HONOURING_RUNNERS.has(key),
      );
    }
    expect([...TERMINATOR_HONOURING_RUNNERS].sort()).toEqual(["task", "tellLead"]);
  });

  test.each([
    ["terminated" as ArgvSlot, "after `--` did not arrive as data"],
    ["flag-value" as ArgvSlot, "in a flag-value slot was read as a flag"],
  ])("a %s argument survives a hostile dash-led value through the REAL parser", (slotKind, why) => {
    // Pins the property that makes each safe slot safe — terminated:
    // the parser honours `--`; flag-value: the parser takes argv[i+1]
    // unconditionally. A parser that ever starts peeking at the next
    // token turns these into positional exposures, and this goes red
    // the moment it does.
    //
    // `--no-ping` is the collision-free probe: it is a real boolean flag
    // in `dispatch` and an unknown flag everywhere else, and NO parser
    // field can legitimately hold it as a value — so a parser that mis-
    // read it could not accidentally satisfy the round-trip via some
    // other field. `--team-dir` is probed too because it is the token
    // that reproduces the live dispatch escape.
    for (const t of VOICE_TOOL_CATALOG) {
      const slots = auditArgvSlots(t, SAMPLES[t.name] ?? {}, ROOT);
      for (const [key, slot] of Object.entries(slots)) {
        if (slot !== slotKind) continue;
        for (const hostile of ["--no-ping", "--team-dir"]) {
          const argv = t.argv({ ...SAMPLES[t.name], [key]: hostile }, ROOT);
          const parsed = RUNNER_PARSERS[t.runnerKey as VoiceRunnerKey](argv);
          expect(
            parsedCarriesExactly(parsed, hostile),
            `${t.name}.${key}: '${hostile}' ${why}`,
          ).toBe(true);
        }
      }
    }
  });

  test("the escapes the guard closes are REAL against the live parsers (regression pin)", () => {
    // Proves the bug rather than only the fix: with the guard bypassed,
    // the raw argv these values build really does reach the wrong
    // behaviour in the verb's own parser.
    const claimArgv = entry("claim_task").argv({ task_id: "--next", member: "be-1" }, ROOT);
    expect(parseClaimDoneArgs(claimArgv, "claim")).toMatchObject({ next: true, who: "be-1" });

    const dispatchArgv = entry("dispatch_task").argv({ task_id: "--socket", member: "be-1" }, ROOT);
    const hijacked = parseDispatchArgs(dispatchArgv);
    // --team-dir got eaten as the socket VALUE: the dispatch is aimed at
    // an attacker-named socket AND has lost its team scope entirely.
    expect(hijacked.socketPath).toBe("--team-dir");
    expect(hijacked.teamDir).toBeUndefined();

    // ...and the schema now makes both argvs unbuildable.
    expect(
      entry("claim_task").params.safeParse({ task_id: "--next", member: "be-1" }).success,
    ).toBe(false);
    expect(
      entry("dispatch_task").params.safeParse({ task_id: "--socket", member: "be-1" }).success,
    ).toBe(false);
  });
});

describe("classifyArgvSlot", () => {
  test("absent when the probe never reaches argv", () => {
    expect(classifyArgvSlot(["--team-dir", "/w"], ARGV_PROBE)).toBe("absent");
  });

  test("terminated when any `--` precedes the probe", () => {
    expect(classifyArgvSlot(["--team-dir", "/w", "--", ARGV_PROBE], ARGV_PROBE)).toBe("terminated");
  });

  test("flag-value when the preceding token is a flag", () => {
    expect(classifyArgvSlot(["--member", ARGV_PROBE], ARGV_PROBE)).toBe("flag-value");
  });

  test("positional at index 0 (no preceding token at all)", () => {
    expect(classifyArgvSlot([ARGV_PROBE, "--team-dir", "/w"], ARGV_PROBE)).toBe("positional");
  });

  test("positional when the preceding token is a bare word", () => {
    expect(classifyArgvSlot(["be-1", ARGV_PROBE], ARGV_PROBE)).toBe("positional");
  });

  test("a `--` AFTER the probe does not make it terminated", () => {
    expect(classifyArgvSlot([ARGV_PROBE, "--"], ARGV_PROBE)).toBe("positional");
  });
});

describe("auditArgvSlots — the optional-argument shift it exists to catch", () => {
  test("an optional argument that vanishes promotes the next one to positional", () => {
    // dispatch_task in miniature: with `member` present the probe sits at
    // index 1 behind a bare word; with it absent the probe IS index 0.
    // Auditing only the full arg set would read 'positional' either way
    // here, so use a shape where the full set looks SAFE and the
    // reduced set does not — that is the miss the multi-variant probe
    // exists to prevent.
    const shifty: VoiceToolEntry = {
      name: "shifty",
      description: "test-only.",
      params: z.object({
        flagged: z.string().optional(),
        value: z.string(),
      }),
      mutating: false,
      confirm: false,
      runnerKey: "topo",
      argv: (args) =>
        typeof args.flagged === "string" ? ["--flagged", String(args.value)] : [String(args.value)],
    };
    // Full sample alone would classify `value` as flag-value (safe).
    expect(
      classifyArgvSlot(shifty.argv({ flagged: "y", value: ARGV_PROBE }, null), ARGV_PROBE),
    ).toBe("flag-value");
    // The audit probes the reduced set too and returns the worst.
    expect(auditArgvSlots(shifty, { flagged: "y", value: "v" }, null)).toEqual({
      flagged: "absent",
      value: "positional",
    });
  });

  test("non-string arguments are skipped (they cannot carry a flag)", () => {
    expect(auditArgvSlots(entry("list_tasks"), SAMPLES.list_tasks ?? {}, ROOT)).toEqual({
      team: "absent",
    });
  });
});
