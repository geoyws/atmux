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
  findTool,
  isTeamScoped,
  toolJsonSchema,
  VOICE_TOOL_CATALOG,
  type VoiceToolEntry,
} from "../../../../src/core/voice/tool-catalog.ts";
import { ConfigError, UsageError } from "../../../../src/errors.ts";
import { parseBlockersArgs } from "../../../../src/verbs/blockers.ts";
import { parseClaimDoneArgs } from "../../../../src/verbs/claim.ts";
import { parseCostArgs } from "../../../../src/verbs/cost.ts";
import { parseDispatchArgs } from "../../../../src/verbs/dispatch.ts";
import { parseDriverInboxArgs } from "../../../../src/verbs/driver-inbox.ts";
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
  test("exactly the 14 v1 tools, in a stable order", () => {
    expect(VOICE_TOOL_CATALOG.map((t) => t.name)).toEqual([
      "list_teams",
      "fleet_overview",
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

  test("team-scoped = every tool except list_teams + fleet_overview", () => {
    const fleet = VOICE_TOOL_CATALOG.filter((t) => !isTeamScoped(t)).map((t) => t.name);
    expect(fleet).toEqual(["list_teams", "fleet_overview"]);
  });

  test("confirm_token is declared on exactly the confirm-gated tools", () => {
    for (const t of VOICE_TOOL_CATALOG) {
      expect("confirm_token" in t.params.shape).toBe(t.confirm);
    }
  });

  test("descriptions are voice-oriented: non-empty, ≤2 sentences", () => {
    for (const t of VOICE_TOOL_CATALOG) {
      expect(t.description.length).toBeGreaterThan(0);
      const sentences = t.description.split(/[.!?]+\s/).filter((s) => s.trim().length > 0);
      expect(sentences.length).toBeLessThanOrEqual(2);
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
});
