// Unit tests for src/abstractions/fallback-cage.ts (ADR-058 §D3+§D4).
//
// Sub-commit (a) shipped: types + errors + path helpers + brief composers.
// Sub-commit (b) adds: createFallbackCage + destroyFallbackCage lifecycle
// + Tier 4 stub guard. Tests below at "Lifecycle —" describe blocks.

import { describe, expect, test } from "bun:test";
import {
  type CageHandle,
  type ComposeBriefOpts,
  cageArchivePath,
  cageArchiveRoot,
  cageSessionName,
  cageTmuxSocket,
  cageTmuxTmpdir,
  composeTier2Brief,
  composeTier3Brief,
  composeTier4Brief,
  createFallbackCage,
  destroyFallbackCage,
  type FallbackAgent,
  type FallbackTier,
  FallbackTierDroppedError,
  FallbackUserMissingError,
  TIER_AGENT,
  TIER3_RSYNC_EXCLUDES,
  Tier4NotAvailableError,
  tier3WorkDir,
} from "../../../src/abstractions/fallback-cage.ts";
import type { SpawnOpts, SpawnResult } from "../../../src/abstractions/spawn.ts";
import type { TmuxConfig, TmuxNamespace } from "../../../src/abstractions/tmux.ts";

describe("TIER_AGENT mapping", () => {
  test("Tier 2 → operator", () => {
    expect(TIER_AGENT[2]).toBe("operator");
  });

  test("Tier 3 → kimi-agent", () => {
    expect(TIER_AGENT[3]).toBe("kimi-agent");
  });

  test("Tier 4 → minimax-agent", () => {
    expect(TIER_AGENT[4]).toBe("minimax-agent");
  });

  test("covers all FallbackTier values", () => {
    const tiers: FallbackTier[] = [2, 3, 4];
    for (const t of tiers) expect(TIER_AGENT[t]).toBeDefined();
  });
});

describe("TIER3_RSYNC_EXCLUDES", () => {
  test("excludes .git directory", () => {
    expect(TIER3_RSYNC_EXCLUDES).toContain(".git");
  });

  test("excludes credential files (recursive glob)", () => {
    expect(TIER3_RSYNC_EXCLUDES).toContain("**/credentials*");
    expect(TIER3_RSYNC_EXCLUDES).toContain(".gitmodules-credentials");
  });

  test("excludes _refs frozen reference material", () => {
    expect(TIER3_RSYNC_EXCLUDES).toContain("_refs/");
  });

  test("excludes .atmux/state transient state", () => {
    expect(TIER3_RSYNC_EXCLUDES).toContain(".atmux/state");
  });
});

describe("cageTmuxTmpdir", () => {
  test("operator agent → no agent suffix", () => {
    expect(cageTmuxTmpdir("alpha", "fe", "operator")).toBe("/tmp/atmux_fallback_alpha_fe/");
  });

  test("kimi-agent → agent suffix appended", () => {
    expect(cageTmuxTmpdir("alpha", "fe", "kimi-agent")).toBe(
      "/tmp/atmux_fallback_alpha_fe_kimi-agent/",
    );
  });

  test("minimax-agent → agent suffix appended", () => {
    expect(cageTmuxTmpdir("alpha", "fe", "minimax-agent")).toBe(
      "/tmp/atmux_fallback_alpha_fe_minimax-agent/",
    );
  });

  test("trailing slash always present (ADR-018 path convention)", () => {
    const all: FallbackAgent[] = ["operator", "kimi-agent", "minimax-agent"];
    for (const a of all) {
      expect(cageTmuxTmpdir("t", "l", a).endsWith("/")).toBe(true);
    }
  });
});

describe("cageTmuxSocket", () => {
  test("formats as fallback_<team>_<lane>", () => {
    expect(cageTmuxSocket("alpha", "fe")).toBe("fallback_alpha_fe");
  });

  test("preserves underscores in team/lane (no further escaping)", () => {
    expect(cageTmuxSocket("team_one", "lane_two")).toBe("fallback_team_one_lane_two");
  });
});

describe("cageSessionName", () => {
  test("formats as fallback-<team>-<lane> (hyphens, not underscores)", () => {
    expect(cageSessionName("alpha", "fe")).toBe("fallback-alpha-fe");
  });

  test("hyphens preserved in team/lane", () => {
    expect(cageSessionName("team-one", "fe-lane")).toBe("fallback-team-one-fe-lane");
  });
});

describe("tier3WorkDir", () => {
  test("kimi-agent path", () => {
    expect(tier3WorkDir("kimi-agent", "alpha", "fe")).toBe("/home/kimi-agent/cages/alpha-fe/work");
  });

  test("minimax-agent path", () => {
    expect(tier3WorkDir("minimax-agent", "alpha", "fe")).toBe(
      "/home/minimax-agent/cages/alpha-fe/work",
    );
  });

  test("operator agent (Tier 2 doesn't use this path) — produces a path under /home/operator anyway", () => {
    expect(tier3WorkDir("operator", "alpha", "fe")).toBe("/home/operator/cages/alpha-fe/work");
  });
});

describe("cageArchiveRoot", () => {
  test("Tier 2 archive root", () => {
    expect(cageArchiveRoot("/p/.atmux", 2)).toBe("/p/.atmux/tier2-handoff/archive");
  });

  test("Tier 3 archive root", () => {
    expect(cageArchiveRoot("/p/.atmux", 3)).toBe("/p/.atmux/tier3-handoff/archive");
  });

  test("Tier 4 archive root", () => {
    expect(cageArchiveRoot("/p/.atmux", 4)).toBe("/p/.atmux/tier4-handoff/archive");
  });
});

describe("cageArchivePath", () => {
  test("includes epoch suffix for collision-free re-spawn within seconds", () => {
    const a = cageArchivePath("/p/.atmux", 3, "alpha", "fe", 1700000000);
    const b = cageArchivePath("/p/.atmux", 3, "alpha", "fe", 1700000005);
    expect(a).not.toBe(b);
    expect(a).toBe("/p/.atmux/tier3-handoff/archive/alpha-fe-1700000000");
    expect(b).toBe("/p/.atmux/tier3-handoff/archive/alpha-fe-1700000005");
  });

  test("nests under archive root", () => {
    expect(cageArchivePath("/p/.atmux", 2, "t", "l", 100)).toBe(
      "/p/.atmux/tier2-handoff/archive/t-l-100",
    );
  });
});

describe("Tier4NotAvailableError", () => {
  test("error message references the ADR-050 v1 scope reduction", () => {
    // Class is @deprecated post-ADR-050 v1 + Task t-706655ee
    // (2026-05-14): Tier 4 (MiniMax) is permanently dropped, not
    // "not GA". Message rewritten to cite the dropping ADR; the
    // older ADR-058 §OQ6 reference no longer applies. t-475f9571
    // sibling-F.
    const e = new Tier4NotAvailableError();
    expect(e.message).toContain("Tier 4 (MiniMax)");
    expect(e.message).toContain("ADR-050");
    expect(e.message).toContain("permanently dropped");
  });

  test("name property is 'Tier4NotAvailableError'", () => {
    expect(new Tier4NotAvailableError().name).toBe("Tier4NotAvailableError");
  });

  test("instanceof Error", () => {
    expect(new Tier4NotAvailableError() instanceof Error).toBe(true);
  });
});

describe("FallbackUserMissingError", () => {
  test("error message names the agent + provisioning script", () => {
    const e = new FallbackUserMissingError("kimi-agent");
    expect(e.message).toContain("kimi-agent");
    expect(e.message).toContain("scripts/provision-fallback-user.sh");
  });

  test("agent property exposes which user is missing", () => {
    const e = new FallbackUserMissingError("minimax-agent");
    expect(e.agent).toBe("minimax-agent");
  });

  test("name property is 'FallbackUserMissingError'", () => {
    expect(new FallbackUserMissingError("kimi-agent").name).toBe("FallbackUserMissingError");
  });

  test("instanceof Error", () => {
    expect(new FallbackUserMissingError("kimi-agent") instanceof Error).toBe(true);
  });
});

describe("composeTier2Brief", () => {
  const opts: ComposeBriefOpts = {
    team: "alpha",
    lane: "fe",
    taskId: "t-abc123",
    taskBody: "Implement the FOO endpoint with rate-limit guard.",
    agent: "operator",
    workDir: "/proj/fe",
  };

  test("includes team / lane / taskId in header", () => {
    const out = composeTier2Brief(opts);
    expect(out).toContain("`alpha`");
    expect(out).toContain("`fe`");
    expect(out).toContain("`t-abc123`");
  });

  test("declares operator UID + full git access", () => {
    const out = composeTier2Brief(opts);
    expect(out).toContain("operator UID");
    expect(out).toContain("full git access");
  });

  test("embeds task body verbatim", () => {
    const out = composeTier2Brief(opts);
    expect(out).toContain("Implement the FOO endpoint with rate-limit guard.");
  });

  test("conventional-commits subject + co-author trailer reminders present", () => {
    const out = composeTier2Brief(opts);
    expect(out).toContain("Conventional-commits");
    expect(out).toContain("co-author trailer");
  });

  test("calls out _refs/ exclusion + path-restricted commits in scope guardrails", () => {
    const out = composeTier2Brief(opts);
    expect(out).toContain("_refs/");
    expect(out).toContain("path-restrict");
  });

  test("reconciliation note: SHAs are the handoff record (no manual reconcile)", () => {
    const out = composeTier2Brief(opts);
    expect(out).toContain("SHAs");
    expect(out).toContain("handoff record");
  });
});

describe("composeTier3Brief", () => {
  const opts: ComposeBriefOpts = {
    team: "alpha",
    lane: "fe",
    taskId: "t-abc123",
    taskBody: "Implement the FOO endpoint.",
    agent: "kimi-agent",
    workDir: "/home/kimi-agent/cages/alpha-fe/work",
  };

  test("addresses agent by name (kernel-isolated user)", () => {
    const out = composeTier3Brief(opts);
    expect(out).toContain("kimi-agent");
    expect(out).toContain("kernel-isolated");
  });

  test("HARD CONSTRAINT — no git, no sudo", () => {
    const out = composeTier3Brief(opts);
    expect(out).toContain("HARD CONSTRAINT");
    expect(out).toContain("Do NOT attempt `git`");
    expect(out).toContain("Do NOT attempt `sudo`");
  });

  test("workspace context references _history.log / _status.log / _branch.log", () => {
    const out = composeTier3Brief(opts);
    expect(out).toContain("_history.log");
    expect(out).toContain("_status.log");
    expect(out).toContain("_branch.log");
  });

  test("reconciliation expectation names scripts/fallback-reconcile.sh + team + lane", () => {
    const out = composeTier3Brief(opts);
    expect(out).toContain("scripts/fallback-reconcile.sh alpha fe");
  });

  test("workspace path is the only writeable surface", () => {
    const out = composeTier3Brief(opts);
    expect(out).toContain("/home/kimi-agent/cages/alpha-fe/work");
    expect(out).toContain("only writeable path");
  });

  test("embeds task body verbatim", () => {
    const out = composeTier3Brief(opts);
    expect(out).toContain("Implement the FOO endpoint.");
  });
});

describe("composeTier4Brief", () => {
  const opts: ComposeBriefOpts = {
    team: "alpha",
    lane: "fe",
    taskId: "t-abc123",
    taskBody: "Implement the FOO endpoint.",
    agent: "minimax-agent",
    workDir: "/home/minimax-agent/cages/alpha-fe/work",
  };

  test("references CLI-may-be-unavailable guard per ADR-058 §OQ6", () => {
    const out = composeTier4Brief(opts);
    expect(out).toContain("MiniMax CLI may be unavailable");
    expect(out).toContain("ADR-058 §OQ6");
  });

  test("HARD CONSTRAINT mirrors Tier 3 (no git, no sudo)", () => {
    const out = composeTier4Brief(opts);
    expect(out).toContain("HARD CONSTRAINT");
    expect(out).toContain("Do NOT attempt `git`");
    expect(out).toContain("Do NOT attempt `sudo`");
  });

  test("addresses agent by name", () => {
    const out = composeTier4Brief(opts);
    expect(out).toContain("minimax-agent");
  });

  test("reconciliation routes to scripts/fallback-reconcile.sh same as Tier 3", () => {
    const out = composeTier4Brief(opts);
    expect(out).toContain("scripts/fallback-reconcile.sh alpha fe");
  });

  test("embeds task body verbatim", () => {
    const out = composeTier4Brief(opts);
    expect(out).toContain("Implement the FOO endpoint.");
  });
});

// ---------- Lifecycle — createFallbackCage / destroyFallbackCage ----------

interface SpawnCall {
  cmd: string;
  argv: ReadonlyArray<string>;
  cwd?: string;
  stdin?: string;
}

function makeSpawnRecorder(
  responses: ReadonlyArray<{
    matchCmd?: string;
    matchArgvIncludes?: string;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
  }> = [],
): {
  fn: (opts: SpawnOpts) => Promise<SpawnResult>;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const fn = async (opts: SpawnOpts): Promise<SpawnResult> => {
    const stdin = typeof opts.stdin === "string" ? opts.stdin : undefined;
    const call: SpawnCall = {
      cmd: opts.cmd,
      argv: opts.argv ?? [],
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(stdin !== undefined ? { stdin } : {}),
    };
    calls.push(call);
    const matched = responses.find((r) => {
      if (r.matchCmd !== undefined && r.matchCmd !== opts.cmd) return false;
      if (r.matchArgvIncludes !== undefined) {
        const argv = opts.argv ?? [];
        if (!argv.some((a) => a.includes(r.matchArgvIncludes ?? ""))) return false;
      }
      return true;
    });
    return {
      cmd: opts.cmd,
      argv: opts.argv ?? [],
      exitCode: matched?.exitCode ?? 0,
      signalled: null,
      stdout: matched?.stdout ?? "",
      stderr: matched?.stderr ?? "",
      durationMs: 1,
    };
  };
  return { fn, calls };
}

interface FakeTmuxState {
  newSessionCalls: { name: string; cwd?: string; windowName?: string }[];
  killSessionCalls: string[];
  killSessionShouldThrow: boolean;
  /** Records every TmuxConfig the fake was constructed with — used by
   *  ADR-162 TR4 follow-up tests to assert `-f` threading. */
  factoryConfigs: TmuxConfig[];
}

function makeFakeTmuxFactory(state: FakeTmuxState): (config: TmuxConfig) => TmuxNamespace {
  return (config: TmuxConfig): TmuxNamespace => {
    state.factoryConfigs.push(config);
    return {
      session: {
        async newSession(opts: {
          name: string;
          detached?: boolean;
          cwd?: string;
          windowName?: string;
          shellCommand?: string;
        }) {
          const entry: { name: string; cwd?: string; windowName?: string } = {
            name: opts.name,
            ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
            ...(opts.windowName !== undefined ? { windowName: opts.windowName } : {}),
          };
          state.newSessionCalls.push(entry);
        },
        async hasSession() {
          return false;
        },
        async killSession(name: string) {
          if (state.killSessionShouldThrow) throw new Error("session not found");
          state.killSessionCalls.push(name);
        },
        async listSessions() {
          return [];
        },
        async renameSession() {
          // no-op
        },
      },
      // Other namespaces unused by fallback-cage; cast through unknown
      // for the test fake (we never call them).
    } as unknown as TmuxNamespace;
  };
}

describe("Lifecycle — createFallbackCage Tier 2 (Cursor)", () => {
  test("happy path returns CageHandle with operator agent + project cwd as workDir", async () => {
    const spawn = makeSpawnRecorder();
    const tmuxState: FakeTmuxState = {
      newSessionCalls: [],
      killSessionCalls: [],
      killSessionShouldThrow: false,
      factoryConfigs: [],
    };
    const handle = await createFallbackCage({
      team: "alpha",
      lane: "fe",
      tier: 2,
      taskId: "t-x",
      atmuxDir: "/p/.atmux",
      projectCwd: "/p",
      spawnFn: spawn.fn,
      tmuxFactory: makeFakeTmuxFactory(tmuxState),
      nowSec: () => 1700_000_000,
    });
    expect(handle.tier).toBe(2);
    expect(handle.agent).toBe("operator");
    expect(handle.workDir).toBe("/p");
    expect(handle.tmuxSocket).toBe("fallback_alpha_fe");
    expect(handle.tmuxTmpdir).toBe("/tmp/atmux_fallback_alpha_fe/");
    expect(handle.sessionName).toBe("fallback-alpha-fe");
    expect(handle.windowName).toBe("tier2-fe");
    expect(handle.createdAt).toBe(1700_000_000);
  });

  test("Tier 2 spawns session via tmux factory (NOT sudo)", async () => {
    const spawn = makeSpawnRecorder();
    const tmuxState: FakeTmuxState = {
      newSessionCalls: [],
      killSessionCalls: [],
      killSessionShouldThrow: false,
      factoryConfigs: [],
    };
    await createFallbackCage({
      team: "alpha",
      lane: "fe",
      tier: 2,
      taskId: "t-x",
      atmuxDir: "/p/.atmux",
      projectCwd: "/p",
      spawnFn: spawn.fn,
      tmuxFactory: makeFakeTmuxFactory(tmuxState),
    });
    expect(tmuxState.newSessionCalls.length).toBe(1);
    expect(tmuxState.newSessionCalls[0]?.cwd).toBe("/p");
    // Tier 2 must NEVER invoke sudo.
    expect(spawn.calls.some((c) => c.cmd === "sudo")).toBe(false);
  });

  test("ADR-162 TR4: Tier 2 threads canonical atmux.conf via configFile", async () => {
    const spawn = makeSpawnRecorder();
    const tmuxState: FakeTmuxState = {
      newSessionCalls: [],
      killSessionCalls: [],
      killSessionShouldThrow: false,
      factoryConfigs: [],
    };
    await createFallbackCage({
      team: "alpha",
      lane: "fe",
      tier: 2,
      taskId: "t-x",
      atmuxDir: "/p/.atmux",
      projectCwd: "/p",
      spawnFn: spawn.fn,
      tmuxFactory: makeFakeTmuxFactory(tmuxState),
    });
    expect(tmuxState.factoryConfigs.length).toBe(1);
    const cfg = tmuxState.factoryConfigs[0];
    expect(cfg?.configFile).toBeDefined();
    expect(cfg?.configFile?.endsWith("/templates/tmux/atmux.conf")).toBe(true);
    // Socket flag still set alongside configFile (TmuxConfig discriminator).
    expect(cfg?.socket).toBe("fallback_alpha_fe");
  });

  test("ADR-162 TR4: ATMUX_TMUX_CONF env override propagates to factory", async () => {
    const originalEnv = process.env.ATMUX_TMUX_CONF;
    process.env.ATMUX_TMUX_CONF = "/etc/atmux/custom.conf";
    try {
      const spawn = makeSpawnRecorder();
      const tmuxState: FakeTmuxState = {
        newSessionCalls: [],
        killSessionCalls: [],
        killSessionShouldThrow: false,
        factoryConfigs: [],
      };
      await createFallbackCage({
        team: "alpha",
        lane: "fe",
        tier: 2,
        taskId: "t-x",
        atmuxDir: "/p/.atmux",
        projectCwd: "/p",
        spawnFn: spawn.fn,
        tmuxFactory: makeFakeTmuxFactory(tmuxState),
      });
      expect(tmuxState.factoryConfigs[0]?.configFile).toBe("/etc/atmux/custom.conf");
    } finally {
      if (originalEnv === undefined) delete process.env.ATMUX_TMUX_CONF;
      else process.env.ATMUX_TMUX_CONF = originalEnv;
    }
  });

  test("Tier 2 mkdir's the cage TMUX_TMPDIR", async () => {
    const spawn = makeSpawnRecorder();
    const tmuxState: FakeTmuxState = {
      newSessionCalls: [],
      killSessionCalls: [],
      killSessionShouldThrow: false,
      factoryConfigs: [],
    };
    await createFallbackCage({
      team: "alpha",
      lane: "fe",
      tier: 2,
      taskId: "t-x",
      atmuxDir: "/p/.atmux",
      projectCwd: "/p",
      spawnFn: spawn.fn,
      tmuxFactory: makeFakeTmuxFactory(tmuxState),
    });
    const mkdirCall = spawn.calls.find(
      (c) => c.cmd === "mkdir" && c.argv.includes("/tmp/atmux_fallback_alpha_fe/"),
    );
    expect(mkdirCall).toBeDefined();
  });
});

// ADR-050 v1 + Task t-706655ee (2026-05-14 operator scope reduction):
// `createFallbackCage` refuses every tier !== 2. Tier 3 (Kimi) and
// Tier 4 (MiniMax) are PERMANENTLY OUT of scope for the create path.
// The tests below assert the hard-refuse contract; the legacy
// Tier 3 happy-path / Tier 3 git-context-dump / Tier 3
// FallbackUserMissingError / Tier 4 MINIMAX_CLI_AVAILABLE-env-flag
// tests are deleted because their behaviour is now unreachable.

describe("Lifecycle — createFallbackCage Tier 3+ refused (ADR-050 v1)", () => {
  test("Tier 3 (Kimi) → throws FallbackTierDroppedError, no side effects", async () => {
    const spawn = makeSpawnRecorder();
    const tmuxState: FakeTmuxState = {
      newSessionCalls: [],
      killSessionCalls: [],
      killSessionShouldThrow: false,
      factoryConfigs: [],
    };
    let caught: unknown = null;
    try {
      await createFallbackCage({
        team: "alpha",
        lane: "fe",
        tier: 3,
        taskId: "t-x",
        atmuxDir: "/p/.atmux",
        projectCwd: "/p",
        spawnFn: spawn.fn,
        tmuxFactory: makeFakeTmuxFactory(tmuxState),
      });
    } catch (e) {
      caught = e;
    }
    expect(caught instanceof FallbackTierDroppedError).toBe(true);
    expect((caught as FallbackTierDroppedError).tier).toBe(3);
    // Hard gate must abort BEFORE any side effect (no getent, no
    // sudo, no rsync, no tmux). Previous behaviour ran the
    // kimi-agent provisioning chain; the gate hoists the refusal
    // above all of it.
    expect(spawn.calls.length).toBe(0);
    expect(tmuxState.newSessionCalls.length).toBe(0);
  });

  test("Tier 4 (MiniMax) → throws FallbackTierDroppedError regardless of MINIMAX_CLI_AVAILABLE", async () => {
    // The legacy env flag is intentionally ignored — Task t-706655ee
    // §scope says "permanently out", which is stronger than the prior
    // "not GA" framing.
    const ORIG_ENV = process.env.MINIMAX_CLI_AVAILABLE;
    process.env.MINIMAX_CLI_AVAILABLE = "1";
    try {
      const spawn = makeSpawnRecorder();
      const tmuxState: FakeTmuxState = {
        newSessionCalls: [],
        killSessionCalls: [],
        killSessionShouldThrow: false,
        factoryConfigs: [],
      };
      let caught: unknown = null;
      try {
        await createFallbackCage({
          team: "alpha",
          lane: "fe",
          tier: 4,
          taskId: "t-x",
          atmuxDir: "/p/.atmux",
          projectCwd: "/p",
          spawnFn: spawn.fn,
          tmuxFactory: makeFakeTmuxFactory(tmuxState),
        });
      } catch (e) {
        caught = e;
      }
      expect(caught instanceof FallbackTierDroppedError).toBe(true);
      expect((caught as FallbackTierDroppedError).tier).toBe(4);
      expect(spawn.calls.length).toBe(0);
    } finally {
      if (ORIG_ENV === undefined) delete process.env.MINIMAX_CLI_AVAILABLE;
      else process.env.MINIMAX_CLI_AVAILABLE = ORIG_ENV;
    }
  });

  test("Tier 4 without MINIMAX_CLI_AVAILABLE → also FallbackTierDroppedError (not legacy Tier4NotAvailableError)", async () => {
    const ORIG_ENV = process.env.MINIMAX_CLI_AVAILABLE;
    delete process.env.MINIMAX_CLI_AVAILABLE;
    try {
      const spawn = makeSpawnRecorder();
      const tmuxState: FakeTmuxState = {
        newSessionCalls: [],
        killSessionCalls: [],
        killSessionShouldThrow: false,
        factoryConfigs: [],
      };
      let caught: unknown = null;
      try {
        await createFallbackCage({
          team: "alpha",
          lane: "fe",
          tier: 4,
          taskId: "t-x",
          atmuxDir: "/p/.atmux",
          projectCwd: "/p",
          spawnFn: spawn.fn,
          tmuxFactory: makeFakeTmuxFactory(tmuxState),
        });
      } catch (e) {
        caught = e;
      }
      // The new hard gate supersedes the old MINIMAX_CLI_AVAILABLE
      // check — both env states route through FallbackTierDroppedError.
      expect(caught instanceof FallbackTierDroppedError).toBe(true);
      // And the legacy Tier4NotAvailableError class is NOT thrown by
      // createFallbackCage anymore (still exported for in-flight
      // instanceof checks at call sites that haven't migrated yet).
      expect(caught instanceof Tier4NotAvailableError).toBe(false);
      expect(spawn.calls.length).toBe(0);
    } finally {
      if (ORIG_ENV === undefined) delete process.env.MINIMAX_CLI_AVAILABLE;
      else process.env.MINIMAX_CLI_AVAILABLE = ORIG_ENV;
    }
  });
});

describe("FallbackTierDroppedError", () => {
  test("message names the refused tier + ADR-050 + Task t-706655ee", () => {
    const e = new FallbackTierDroppedError(3);
    expect(e.message).toContain("Tier 3");
    expect(e.message).toContain("ADR-050");
    expect(e.message).toContain("t-706655ee");
  });
  test("tier property pinned for catch-site routing", () => {
    expect(new FallbackTierDroppedError(3).tier).toBe(3);
    expect(new FallbackTierDroppedError(4).tier).toBe(4);
  });
  test("instanceof Error", () => {
    expect(new FallbackTierDroppedError(4) instanceof Error).toBe(true);
  });
  test("name property is 'FallbackTierDroppedError'", () => {
    expect(new FallbackTierDroppedError(3).name).toBe("FallbackTierDroppedError");
  });
});

describe("Lifecycle — destroyFallbackCage Tier 2", () => {
  test("captures pane content + writes session.log + kills session", async () => {
    const spawn = makeSpawnRecorder([
      {
        matchCmd: "tmux",
        matchArgvIncludes: "capture-pane",
        exitCode: 0,
        stdout: "captured pane content",
      },
    ]);
    const tmuxState: FakeTmuxState = {
      newSessionCalls: [],
      killSessionCalls: [],
      killSessionShouldThrow: false,
      factoryConfigs: [],
    };
    const handle: CageHandle = {
      tier: 2,
      team: "alpha",
      lane: "fe",
      taskId: "t-x",
      agent: "operator",
      tmuxTmpdir: "/tmp/atmux_fallback_alpha_fe/",
      tmuxSocket: "fallback_alpha_fe",
      workDir: "/p",
      sessionName: "fallback-alpha-fe",
      windowName: "tier2-fe",
      createdAt: 1700_000_000,
    };
    await destroyFallbackCage(handle, {
      atmuxDir: "/p/.atmux",
      spawnFn: spawn.fn,
      tmuxFactory: makeFakeTmuxFactory(tmuxState),
      nowSec: () => 1700_000_100,
    });
    expect(spawn.calls.some((c) => c.cmd === "tmux" && c.argv.includes("capture-pane"))).toBe(true);
    const teeCall = spawn.calls.find(
      (c) =>
        c.cmd === "tee" &&
        c.argv.includes("/p/.atmux/tier2-handoff/archive/alpha-fe-1700000100/session.log"),
    );
    expect(teeCall).toBeDefined();
    expect(teeCall?.stdin).toBe("captured pane content");
    expect(tmuxState.killSessionCalls).toContain("fallback-alpha-fe");
  });

  test("idempotent: kill-session error swallowed", async () => {
    const spawn = makeSpawnRecorder();
    const tmuxState: FakeTmuxState = {
      newSessionCalls: [],
      killSessionCalls: [],
      killSessionShouldThrow: true,
      factoryConfigs: [],
    };
    const handle: CageHandle = {
      tier: 2,
      team: "alpha",
      lane: "fe",
      taskId: "t-x",
      agent: "operator",
      tmuxTmpdir: "/tmp/atmux_fallback_alpha_fe/",
      tmuxSocket: "fallback_alpha_fe",
      workDir: "/p",
      sessionName: "fallback-alpha-fe",
      windowName: "tier2-fe",
      createdAt: 1700_000_000,
    };
    // Should NOT throw even though killSession throws.
    await destroyFallbackCage(handle, {
      atmuxDir: "/p/.atmux",
      spawnFn: spawn.fn,
      tmuxFactory: makeFakeTmuxFactory(tmuxState),
    });
  });
});

describe("Lifecycle — destroyFallbackCage Tier 3", () => {
  test("rsyncs workspace into archive + sudo kill-session + sudo rm -rf cage tree", async () => {
    const spawn = makeSpawnRecorder();
    const tmuxState: FakeTmuxState = {
      newSessionCalls: [],
      killSessionCalls: [],
      killSessionShouldThrow: false,
      factoryConfigs: [],
    };
    const handle: CageHandle = {
      tier: 3,
      team: "alpha",
      lane: "fe",
      taskId: "t-x",
      agent: "kimi-agent",
      tmuxTmpdir: "/tmp/atmux_fallback_alpha_fe_kimi-agent/",
      tmuxSocket: "fallback_alpha_fe",
      workDir: "/home/kimi-agent/cages/alpha-fe/work",
      sessionName: "fallback-alpha-fe",
      windowName: "tier3-fe",
      createdAt: 1700_000_000,
    };
    await destroyFallbackCage(handle, {
      atmuxDir: "/p/.atmux",
      spawnFn: spawn.fn,
      tmuxFactory: makeFakeTmuxFactory(tmuxState),
      nowSec: () => 1700_000_100,
    });
    // Archive rsync from cage dir into archive path.
    const archiveRsync = spawn.calls.find(
      (c) =>
        c.cmd === "sudo" &&
        c.argv.includes("rsync") &&
        c.argv.some((a) => a.includes("/p/.atmux/tier3-handoff/archive/alpha-fe-1700000100/")),
    );
    expect(archiveRsync).toBeDefined();
    // Sudo tmux kill-session.
    expect(
      spawn.calls.some(
        (c) => c.cmd === "sudo" && c.argv.includes("tmux") && c.argv.includes("kill-session"),
      ),
    ).toBe(true);
    // rm -rf the cage root.
    expect(
      spawn.calls.some(
        (c) =>
          c.cmd === "sudo" &&
          c.argv.includes("rm") &&
          c.argv.includes("-rf") &&
          c.argv.some((a) => a.includes("/home/kimi-agent/cages/alpha-fe")),
      ),
    ).toBe(true);
    // Tier 3 path must NOT use the operator-side tmuxFactory's killSession.
    expect(tmuxState.killSessionCalls.length).toBe(0);
  });
});
