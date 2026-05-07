// Unit tests for src/abstractions/fallback-cage.ts (ADR-058 §D3+§D4).
//
// Sub-commit (a) coverage: types + errors + path helpers + brief
// composers. Lifecycle tests (createFallbackCage / destroyFallbackCage)
// land in sub-commit (b) alongside the impl.

import { describe, expect, test } from "bun:test";
import {
  cageArchivePath,
  cageArchiveRoot,
  cageSessionName,
  cageTmuxSocket,
  cageTmuxTmpdir,
  composeTier2Brief,
  composeTier3Brief,
  composeTier4Brief,
  FallbackUserMissingError,
  TIER3_RSYNC_EXCLUDES,
  TIER_AGENT,
  Tier4NotAvailableError,
  tier3WorkDir,
  type ComposeBriefOpts,
  type FallbackAgent,
  type FallbackTier,
} from "../../../src/abstractions/fallback-cage.ts";

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
    expect(tier3WorkDir("kimi-agent", "alpha", "fe")).toBe(
      "/home/kimi-agent/cages/alpha-fe/work",
    );
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
  test("error message references ADR-058 §OQ6", () => {
    const e = new Tier4NotAvailableError();
    expect(e.message).toContain("Tier 4 (MiniMax)");
    expect(e.message).toContain("ADR-058");
    expect(e.message).toContain("OQ6");
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
