// Unit tests for src/schema/team.ts.
//
// Post-ADR-263 (the great simplification): the fleet-coordination config
// sub-blocks (whip / report / autoMerge / orchestration / cadence /
// ombudsman / epicTeam / crons / issueSync / fallback / leadStallWatchdog
// / refusalDetection / autoSpawn) were deleted with their verbs/core, so
// their schema cases are gone too. What remains is the harness identity
// (name + panes + tmux knobs) plus the task-feed knobs and forensic
// observability toggles that kept code still reads. This file covers the
// retained schema surface in isolation.

import { describe, expect, test } from "bun:test";
import { ZodError } from "zod";
import {
  DEFAULT_WORKTREE_ROOT,
  TaskSource,
  Team,
  TeamMember,
} from "../../../src/schema/team.ts";

// ---------- driverSession — ADR-044 + ADR-064 §5 ----------

describe("Team schema — driverSession (ADR-044 + ADR-064 §5)", () => {
  test("Team.parse with driverSession.tui parses cleanly (the only wired field)", () => {
    const team = Team.parse({
      name: "demo",
      members: [],
      driverSession: { tui: "shell" },
    });
    expect(team.driverSession).toEqual({ tui: "shell" });
  });

  test("Team.parse with driverSession.model=<str> parses cleanly (loose model pin)", () => {
    const team = Team.parse({
      name: "demo",
      members: [],
      driverSession: { tui: "shell", model: "cursor-fast" },
    });
    expect(team.driverSession).toEqual({ tui: "shell", model: "cursor-fast" });
  });

  test("Team.parse with driverSession.model=null is accepted (explicitly unset)", () => {
    const team = Team.parse({
      name: "demo",
      members: [],
      driverSession: { tui: "shell", model: null },
    });
    expect(team.driverSession).toEqual({ tui: "shell", model: null });
  });

  test("Team.parse with driverSession.model absent is accepted (backward compat)", () => {
    const team = Team.parse({
      name: "demo",
      members: [],
      driverSession: { tui: "shell" },
    });
    // Absent optional is omitted from the parsed output, not coerced to null.
    expect(team.driverSession).toEqual({ tui: "shell" });
    expect(team.driverSession?.model).toBeUndefined();
  });

  test("Team.parse REJECTS non-string driverSession.model (e.g. 123) with ZodError", () => {
    let caught: unknown;
    try {
      // `.parse(data: unknown)` — no compile-time guard on the literal;
      // the 123 is rejected at RUNTIME by the Zod string() schema below.
      Team.parse({
        name: "demo",
        members: [],
        driverSession: { tui: "shell", model: 123 },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ZodError);
    // Pinpoint the failing path so a future loosening can't silently pass.
    expect((caught as ZodError).issues[0]?.path).toEqual(["driverSession", "model"]);
  });

  test("Team.parse with driverSession=null is accepted (explicitly disabled)", () => {
    const team = Team.parse({
      name: "demo",
      members: [],
      driverSession: null,
    });
    expect(team.driverSession).toBeNull();
  });

  test("Team.parse REJECTS dead `command` key (ADR-064 §5/§OQ5 — strict-mode drop)", () => {
    // `command` was on the schema in e624592 but never read by any
    // consumer. Per ADR-064 §OQ5 it's a clean cut, no deprecation
    // cycle — the strict() shape now rejects it.
    expect(() =>
      Team.parse({
        name: "demo",
        members: [],
        driverSession: { tui: "shell", command: "claude" },
      }),
    ).toThrow();
  });

  test("Team.parse rejects unknown key in driverSession sub-shape (general strict guard)", () => {
    expect(() =>
      Team.parse({
        name: "demo",
        members: [],
        driverSession: { tui: "shell", typoField: "x" },
      }),
    ).toThrow();
  });
});

// ---------- worktreeIsolation / worktreeRoot — ADR-082 §2 ----------

describe("Team schema — worktreeIsolation + worktreeRoot (ADR-082 §2)", () => {
  test("legacy team.json (neither field present) parses with both fields undefined", () => {
    // Existing teams pick up the new fields on the next atmux start
    // schema-load with NO team.json migration. Both fields are
    // `.optional()` — read-sites apply the effective defaults
    // (`isolation === true` truthy check; root || DEFAULT_WORKTREE_ROOT)
    // so the schema output stays backwards-compatible with every
    // existing Team-literal in the codebase (`singleSession` pattern).
    const team = Team.parse({ name: "demo", members: [] });
    expect(team.worktreeIsolation).toBeUndefined();
    expect(team.worktreeRoot).toBeUndefined();
  });

  test("explicit worktreeIsolation=true parses; root stays undefined → consumer uses DEFAULT_WORKTREE_ROOT", () => {
    const team = Team.parse({
      name: "demo",
      members: [],
      worktreeIsolation: true,
    });
    expect(team.worktreeIsolation).toBe(true);
    expect(team.worktreeRoot).toBeUndefined();
    expect(team.worktreeRoot ?? DEFAULT_WORKTREE_ROOT).toBe(".atmux/worktrees");
  });

  test("explicit worktreeRoot overrides the effective default", () => {
    const team = Team.parse({
      name: "demo",
      members: [],
      worktreeIsolation: true,
      worktreeRoot: ".worktrees-custom",
    });
    expect(team.worktreeIsolation).toBe(true);
    expect(team.worktreeRoot).toBe(".worktrees-custom");
  });

  test("explicit worktreeIsolation=false parses cleanly (matches default behaviour)", () => {
    const team = Team.parse({
      name: "demo",
      members: [],
      worktreeIsolation: false,
    });
    expect(team.worktreeIsolation).toBe(false);
  });

  test("non-boolean worktreeIsolation rejected (input-time type validation)", () => {
    expect(() =>
      Team.parse({
        name: "demo",
        members: [],
        worktreeIsolation: "true" as unknown as boolean,
      }),
    ).toThrow();
  });

  test("non-string worktreeRoot rejected (input-time type validation)", () => {
    expect(() =>
      Team.parse({
        name: "demo",
        members: [],
        worktreeRoot: 42 as unknown as string,
      }),
    ).toThrow();
  });

  test("DEFAULT_WORKTREE_ROOT exports the canonical relative path", () => {
    // Read-sites (W3 start / W4 stop / W5 doctor) import this constant
    // so the effective default has a single source of truth. Pin the
    // value so a rename in the schema file surfaces here.
    expect(DEFAULT_WORKTREE_ROOT).toBe(".atmux/worktrees");
  });
});

// ---------- TeamMember.label (ADR-136 TR2) ----------

describe("TeamMember — label field (ADR-136 Option B)", () => {
  test("missing label parses successfully — backward compat with existing team.json", () => {
    const m = TeamMember.parse({ name: "up-impl" });
    expect(m.name).toBe("up-impl");
    expect(m.label).toBeUndefined();
  });

  test("plain ASCII label parses successfully", () => {
    const m = TeamMember.parse({ name: "up-impl", label: "My Custom Display" });
    expect(m.label).toBe("My Custom Display");
  });

  test("label with ':' rejected — tmux separator", () => {
    expect(() => TeamMember.parse({ name: "up-impl", label: "name:with:colon" })).toThrow();
  });

  test("label with '.' rejected — tmux separator", () => {
    expect(() => TeamMember.parse({ name: "up-impl", label: "name.with.dot" })).toThrow();
  });

  test("unicode + emoji label parses successfully — freeform allowed", () => {
    const m = TeamMember.parse({ name: "up-impl", label: "🎨 freeform unicode" });
    expect(m.label).toBe("🎨 freeform unicode");
  });
});

// ---------- ADR-159 TR3: TeamMember.role gitter → committer shim ----------

describe("TeamMember — role gitter→committer accept-both shim (ADR-159 TR3)", () => {
  test('legacy `role: "gitter"` value coerces to canonical `"committer"` on parse', () => {
    const m = TeamMember.parse({ name: "g", role: "gitter" });
    expect(m.role).toBe("committer");
  });

  test('canonical `role: "committer"` parses unchanged (idempotent)', () => {
    const m = TeamMember.parse({ name: "c", role: "committer" });
    expect(m.role).toBe("committer");
  });

  test("other role values pass through unchanged (open-string shim — does NOT tighten enum)", () => {
    // Current rosters use a wide variety of roles (docs / devops / dba /
    // unblocker / discorder). Closing the enum here would break them;
    // the shim coerces ONLY the gitter→committer value, leaves
    // everything else alone.
    for (const role of [
      "team-lead",
      "planner",
      "reviewer",
      "ombudsman",
      "docs",
      "devops",
      "dba",
      "unblocker",
      "discorder",
      "member",
      "lead",
    ]) {
      const m = TeamMember.parse({ name: "x", role });
      expect(m.role).toBe(role);
    }
  });

  test("missing role parses successfully (optional field) — backward compat", () => {
    const m = TeamMember.parse({ name: "no-role" });
    expect(m.role).toBeUndefined();
  });
});

// ---------- TeamMember pane fields parse cleanly (ADR-263 flat-pane model) ----------

describe("TeamMember — pane fields (ADR-263 flat panes)", () => {
  test("full pane entry round-trips", () => {
    const m = TeamMember.parse({
      name: "worker-1",
      role: "member",
      tui: "claude",
      model: "claude-opus-4-7",
      cwd: ".",
      lane: "backend",
      emoji: "🛠️",
      command: "claude --permission-mode auto",
    });
    expect(m.name).toBe("worker-1");
    expect(m.role).toBe("member");
    expect(m.tui).toBe("claude");
    expect(m.model).toBe("claude-opus-4-7");
    expect(m.cwd).toBe(".");
    expect(m.lane).toBe("backend");
    expect(m.emoji).toBe("🛠️");
    expect(m.command).toBe("claude --permission-mode auto");
  });

  test("minimal entry (name only) parses — every other pane field optional", () => {
    const m = TeamMember.parse({ name: "solo" });
    expect(m.name).toBe("solo");
    expect(m.tui).toBeUndefined();
    expect(m.cwd).toBeUndefined();
    expect(m.lane).toBeUndefined();
  });

  test("passthrough keeps unknown member keys (operator _comment_ keys etc.)", () => {
    const m = TeamMember.parse({ name: "x", _comment: "note" }) as Record<string, unknown>;
    expect(m._comment).toBe("note");
  });
});

// ---------- Team root identity — kept shape (ADR-263 §D6) ----------

describe("Team schema — lean identity (ADR-263 §D1/§D6)", () => {
  test("minimal team (name + empty members) parses — a team is just a name + panes", () => {
    const team = Team.parse({ name: "demo", members: [] });
    expect(team.name).toBe("demo");
    expect(team.members).toEqual([]);
  });

  test("name + flat member panes + tuiCommands + emojis parses", () => {
    const team = Team.parse({
      name: "demo",
      description: "a lean team",
      members: [
        { name: "a", tui: "claude", cwd: "." },
        { name: "b", tui: "shell", cwd: "." },
      ],
      tuiCommands: { "claude-fresh": "claude --new" },
      emojis: { mode: "static" },
    });
    expect(team.name).toBe("demo");
    expect(team.members).toHaveLength(2);
    expect(team.emojis?.mode).toBe("static");
  });

  test("singleSession + tmuxTmpdir + driverTui parse cleanly (kept tmux knobs)", () => {
    const team = Team.parse({
      name: "demo",
      members: [],
      singleSession: true,
      tmuxTmpdir: "/tmp/atmux-demo",
      driverTui: "claude",
    });
    expect(team.singleSession).toBe(true);
    expect(team.tmuxTmpdir).toBe("/tmp/atmux-demo");
    expect(team.driverTui).toBe("claude");
  });

  test("drivers[] roster parses cleanly (ADR-239 §D7)", () => {
    const team = Team.parse({
      name: "demo",
      members: [],
      drivers: [{ name: "driver", tui: "claude", cwd: "." }],
    });
    expect(team.drivers).toHaveLength(1);
    expect(team.drivers?.[0]?.name).toBe("driver");
  });

  test("missing name rejected (required identity)", () => {
    expect(() => Team.parse({ members: [] })).toThrow();
  });

  test("root passthrough keeps unknown keys — legacy fleet sub-blocks still load (ADR-263)", () => {
    // A pre-ADR-263 team.json carrying retired fleet sub-blocks must
    // still parse — the root schema is `.passthrough()`. The retired
    // blocks land in the parsed output verbatim (unmodeled) rather than
    // being refused.
    const team = Team.parse({
      name: "legacy",
      members: [],
      whip: { intervalMins: 15 },
      orchestration: { mode: "manual" },
      issueSync: { enabled: true, trackers: [] },
    }) as Record<string, unknown>;
    expect(team.name).toBe("legacy");
    expect(team.whip).toEqual({ intervalMins: 15 });
    expect(team.orchestration).toEqual({ mode: "manual" });
  });
});

// ---------- taskSources — ADR-263 §D3 (the git task source) ----------

describe("TaskSource schema (ADR-263 §D3)", () => {
  test("minimal source parses with state/onClose defaults applied", () => {
    const s = TaskSource.parse({ provider: "github", scope: "owner/repo" });
    expect(s.state).toBe("open");
    expect(s.onClose).toBe("done");
    expect(s.labels).toBeUndefined();
  });

  test("full source parses (labels / state / onClose / lane / priority / token)", () => {
    const s = TaskSource.parse({
      provider: "github",
      scope: "o/r",
      labels: ["bug", "p1"],
      state: "all",
      onClose: "leave",
      lane: "be",
      priority: 2,
      token: "ghp_x",
    });
    expect(s).toMatchObject({ state: "all", onClose: "leave", lane: "be", priority: 2 });
  });

  test("rejects an unknown provider", () => {
    expect(() => TaskSource.parse({ provider: "jira", scope: "o/r" })).toThrow(ZodError);
  });

  test("rejects an empty scope", () => {
    expect(() => TaskSource.parse({ provider: "github", scope: "" })).toThrow(ZodError);
  });

  test("strict: an unknown key is rejected (typo catch)", () => {
    expect(() => TaskSource.parse({ provider: "github", scope: "o/r", labelz: ["bug"] })).toThrow(
      ZodError,
    );
  });

  test("rejects an invalid state / onClose enum value", () => {
    expect(() => TaskSource.parse({ provider: "github", scope: "o/r", state: "stale" })).toThrow(
      ZodError,
    );
    expect(() => TaskSource.parse({ provider: "github", scope: "o/r", onClose: "delete" })).toThrow(
      ZodError,
    );
  });
});

describe("Team.taskSources (ADR-263 §D3)", () => {
  test("Team.parse with taskSources applies per-source defaults", () => {
    const team = Team.parse({
      name: "demo",
      members: [],
      taskSources: [{ provider: "github", scope: "owner/repo", labels: ["bug"] }],
    });
    expect(team.taskSources).toHaveLength(1);
    expect(team.taskSources?.[0]).toMatchObject({
      scope: "owner/repo",
      state: "open",
      onClose: "done",
    });
  });

  test("Team.parse without taskSources leaves the field undefined", () => {
    const team = Team.parse({ name: "demo", members: [] });
    expect(team.taskSources).toBeUndefined();
  });

  test("a malformed taskSources entry rejects through Team.parse", () => {
    expect(() =>
      Team.parse({
        name: "demo",
        members: [],
        taskSources: [{ provider: "github" }],
      }),
    ).toThrow();
  });
});
