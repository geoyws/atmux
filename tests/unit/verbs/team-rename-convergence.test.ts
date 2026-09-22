// Unit tests for src/verbs/team-rename-convergence.ts (ADR-027 T6
// step 10). Each gap-check has at least one converged-path test +
// one drift-detected test. The full-stack rename → convergence
// happy-path integration is exercised in
// tests/unit/verbs/team-rename.integration.test.ts.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import {
  formatConvergenceHint,
  verifyConvergence,
} from "../../../src/verbs/team-rename-convergence.ts";

// ---------- Fixtures ----------

interface FixtureOpts {
  teamName: string;
  /** Optional .atmux/state/session.txt content. When undefined, no
   *  anchor file is created (singleSession=false case). */
  sessionAnchor?: string;
  /** Whether to leave a stale .atmux/state/rename.lock present. */
  leaveLock?: boolean;
}

async function fixture(opts: FixtureOpts): Promise<{ root: string; atmuxDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "atmux-convergence-"));
  const atmuxDir = join(root, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  await mkdir(join(atmuxDir, "state"), { recursive: true });
  await writeFile(
    join(atmuxDir, "team.json"),
    JSON.stringify({ name: opts.teamName, members: [] }),
  );
  if (opts.sessionAnchor !== undefined) {
    await writeFile(join(atmuxDir, "state", "session.txt"), opts.sessionAnchor);
  }
  if (opts.leaveLock) {
    await writeFile(join(atmuxDir, "state", "rename.lock"), '{"epoch":1}');
  }
  return { root, atmuxDir };
}

async function cockpitFile(
  cockpitDir: string,
  sessions: Array<{ type: string; name: string; root?: string }>,
): Promise<string> {
  const path = join(cockpitDir, "cockpit.json");
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: 1,
      cockpitSession: "atmux_cockpit",
      sessions: sessions.map((s) =>
        s.type === "team"
          ? { type: "team", name: s.name, enabled: true, root: s.root ?? "/r", sessions: [] }
          : s,
      ),
    }),
  );
  return path;
}

function tmuxWithSession(name: string): TmuxNamespace {
  return {
    session: {
      listSessions: async () => [{ id: "$1", name }],
    },
  } as unknown as TmuxNamespace;
}

function tmuxNoSessions(): TmuxNamespace {
  return {
    session: { listSessions: async () => [] },
  } as unknown as TmuxNamespace;
}

function cockpitTmuxWithWindow(windowName: string): TmuxNamespace {
  return {
    window: {
      listWindows: async () => [{ index: 1, id: "@1", name: windowName, active: true }],
    },
  } as unknown as TmuxNamespace;
}

function cockpitTmuxUnreachable(): TmuxNamespace {
  return {
    window: {
      listWindows: async () => {
        throw new Error("cockpit socket missing");
      },
    },
  } as unknown as TmuxNamespace;
}

// ---------- verifyConvergence ----------

describe("verifyConvergence", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    for (const d of tmpDirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  test("converged happy path → gaps=[]", async () => {
    const { root, atmuxDir } = await fixture({
      teamName: "new-team",
      sessionAnchor: "new-team\n",
    });
    tmpDirs.push(root);
    const cockpitDir = await mkdtemp(join(tmpdir(), "atmux-convergence-cockpit-"));
    tmpDirs.push(cockpitDir);
    const cockpitPath = await cockpitFile(cockpitDir, [{ type: "team", name: "new-team" }]);

    const result = await verifyConvergence({
      atmuxDir,
      newName: "new-team",
      newSession: "new-team",
      oldName: "old-team",
      cageTmux: tmuxWithSession("new-team"),
      cockpitTmux: cockpitTmuxWithWindow("new-team"),
      cockpitSession: "atmux_cockpit",
      cockpitPath,
      crontabRead: async () =>
        "# >>> atmux:team=new-team\n*/5 * * * * echo\n# <<< atmux:team=new-team\n",
    });
    expect(result.converged).toBe(true);
    expect(result.gaps).toEqual([]);
  });

  test("team.json drift → 'team-json-name' gap", async () => {
    const { root, atmuxDir } = await fixture({ teamName: "stale-name" });
    tmpDirs.push(root);
    const cockpitDir = await mkdtemp(join(tmpdir(), "atmux-convergence-cockpit-"));
    tmpDirs.push(cockpitDir);
    const cockpitPath = await cockpitFile(cockpitDir, [{ type: "team", name: "new-team" }]);

    const result = await verifyConvergence({
      atmuxDir,
      newName: "new-team",
      newSession: "new-team",
      oldName: "old-team",
      cageTmux: tmuxWithSession("new-team"),
      cockpitTmux: cockpitTmuxWithWindow("new-team"),
      cockpitSession: "atmux_cockpit",
      cockpitPath,
      crontabRead: async () => "",
    });
    expect(result.converged).toBe(false);
    expect(result.gaps.some((g) => g.check === "team-json-name")).toBe(true);
  });

  test("session anchor drift → 'session-anchor' gap", async () => {
    const { root, atmuxDir } = await fixture({
      teamName: "new-team",
      sessionAnchor: "old-team\n",
    });
    tmpDirs.push(root);
    const cockpitDir = await mkdtemp(join(tmpdir(), "atmux-convergence-cockpit-"));
    tmpDirs.push(cockpitDir);
    const cockpitPath = await cockpitFile(cockpitDir, [{ type: "team", name: "new-team" }]);

    const result = await verifyConvergence({
      atmuxDir,
      newName: "new-team",
      newSession: "new-team",
      oldName: "old-team",
      cageTmux: tmuxWithSession("new-team"),
      cockpitTmux: cockpitTmuxWithWindow("new-team"),
      cockpitSession: "atmux_cockpit",
      cockpitPath,
      crontabRead: async () => "",
    });
    expect(result.gaps.some((g) => g.check === "session-anchor")).toBe(true);
  });

  test("cage tmux missing newSession → 'cage-session-alive' gap", async () => {
    const { root, atmuxDir } = await fixture({ teamName: "new-team" });
    tmpDirs.push(root);
    const cockpitDir = await mkdtemp(join(tmpdir(), "atmux-convergence-cockpit-"));
    tmpDirs.push(cockpitDir);
    const cockpitPath = await cockpitFile(cockpitDir, [{ type: "team", name: "new-team" }]);

    const result = await verifyConvergence({
      atmuxDir,
      newName: "new-team",
      newSession: "new-team",
      oldName: "old-team",
      cageTmux: tmuxNoSessions(),
      cockpitTmux: cockpitTmuxWithWindow("new-team"),
      cockpitSession: "atmux_cockpit",
      cockpitPath,
      crontabRead: async () => "",
    });
    expect(result.gaps.some((g) => g.check === "cage-session-alive")).toBe(true);
  });

  test("cockpit registry missing newName → 'cockpit-registry' gap", async () => {
    const { root, atmuxDir } = await fixture({ teamName: "new-team" });
    tmpDirs.push(root);
    const cockpitDir = await mkdtemp(join(tmpdir(), "atmux-convergence-cockpit-"));
    tmpDirs.push(cockpitDir);
    const cockpitPath = await cockpitFile(cockpitDir, [{ type: "team", name: "other-team" }]);

    const result = await verifyConvergence({
      atmuxDir,
      newName: "new-team",
      newSession: "new-team",
      oldName: "old-team",
      cageTmux: tmuxWithSession("new-team"),
      cockpitTmux: cockpitTmuxWithWindow("new-team"),
      cockpitSession: "atmux_cockpit",
      cockpitPath,
      crontabRead: async () => "",
    });
    expect(result.gaps.some((g) => g.check === "cockpit-registry")).toBe(true);
  });

  test("cockpit registry retains oldName → 'cockpit-registry' gap", async () => {
    const { root, atmuxDir } = await fixture({ teamName: "new-team" });
    tmpDirs.push(root);
    const cockpitDir = await mkdtemp(join(tmpdir(), "atmux-convergence-cockpit-"));
    tmpDirs.push(cockpitDir);
    const cockpitPath = await cockpitFile(cockpitDir, [
      { type: "team", name: "new-team" },
      { type: "team", name: "old-team", root: "/r2" },
    ]);

    const result = await verifyConvergence({
      atmuxDir,
      newName: "new-team",
      newSession: "new-team",
      oldName: "old-team",
      cageTmux: tmuxWithSession("new-team"),
      cockpitTmux: cockpitTmuxWithWindow("new-team"),
      cockpitSession: "atmux_cockpit",
      cockpitPath,
      crontabRead: async () => "",
    });
    expect(
      result.gaps.some(
        (g) => g.check === "cockpit-registry" && g.detail.includes("old name='old-team'"),
      ),
    ).toBe(true);
  });

  test("cockpit unreachable → 'cockpit-team-viewer-window' soft gap (orphan-tolerant)", async () => {
    const { root, atmuxDir } = await fixture({ teamName: "new-team" });
    tmpDirs.push(root);
    const cockpitDir = await mkdtemp(join(tmpdir(), "atmux-convergence-cockpit-"));
    tmpDirs.push(cockpitDir);
    const cockpitPath = await cockpitFile(cockpitDir, [{ type: "team", name: "new-team" }]);

    const result = await verifyConvergence({
      atmuxDir,
      newName: "new-team",
      newSession: "new-team",
      oldName: "old-team",
      cageTmux: tmuxWithSession("new-team"),
      cockpitTmux: cockpitTmuxUnreachable(),
      cockpitSession: "atmux_cockpit",
      cockpitPath,
      crontabRead: async () => "",
    });
    expect(result.gaps.some((g) => g.check === "cockpit-team-viewer-window")).toBe(true);
  });

  test("stale rename.lock → 'leftover-rename-lock' gap", async () => {
    const { root, atmuxDir } = await fixture({
      teamName: "new-team",
      leaveLock: true,
    });
    tmpDirs.push(root);
    const cockpitDir = await mkdtemp(join(tmpdir(), "atmux-convergence-cockpit-"));
    tmpDirs.push(cockpitDir);
    const cockpitPath = await cockpitFile(cockpitDir, [{ type: "team", name: "new-team" }]);

    const result = await verifyConvergence({
      atmuxDir,
      newName: "new-team",
      newSession: "new-team",
      oldName: "old-team",
      cageTmux: tmuxWithSession("new-team"),
      cockpitTmux: cockpitTmuxWithWindow("new-team"),
      cockpitSession: "atmux_cockpit",
      cockpitPath,
      crontabRead: async () => "",
    });
    expect(result.gaps.some((g) => g.check === "leftover-rename-lock")).toBe(true);
  });

  test("stale cron block under oldName → 'leftover-cron-block' gap", async () => {
    const { root, atmuxDir } = await fixture({ teamName: "new-team" });
    tmpDirs.push(root);
    const cockpitDir = await mkdtemp(join(tmpdir(), "atmux-convergence-cockpit-"));
    tmpDirs.push(cockpitDir);
    const cockpitPath = await cockpitFile(cockpitDir, [{ type: "team", name: "new-team" }]);

    const result = await verifyConvergence({
      atmuxDir,
      newName: "new-team",
      newSession: "new-team",
      oldName: "old-team",
      cageTmux: tmuxWithSession("new-team"),
      cockpitTmux: cockpitTmuxWithWindow("new-team"),
      cockpitSession: "atmux_cockpit",
      cockpitPath,
      crontabRead: async () =>
        "# >>> atmux:team=old-team\n*/5 * * * * echo\n# <<< atmux:team=old-team\n",
    });
    expect(result.gaps.some((g) => g.check === "leftover-cron-block")).toBe(true);
  });
});

describe("verifyConvergence — residual catches", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    for (const d of tmpDirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  async function convergedCockpitPath(): Promise<{ dir: string; path: string }> {
    const dir = await mkdtemp(join(tmpdir(), "atmux-convergence-cockpit-"));
    tmpDirs.push(dir);
    return { dir, path: await cockpitFile(dir, [{ type: "team", name: "new-team" }]) };
  }

  test("team.json unreadable → 'team-json-name' read-failed gap", async () => {
    const root = await mkdtemp(join(tmpdir(), "atmux-convergence-bare-"));
    tmpDirs.push(root);
    const { path: cockpitPath } = await convergedCockpitPath();

    const result = await verifyConvergence({
      atmuxDir: join(root, ".atmux"),
      newName: "new-team",
      newSession: "new-team",
      oldName: "old-team",
      cageTmux: tmuxWithSession("new-team"),
      cockpitTmux: cockpitTmuxWithWindow("new-team"),
      cockpitSession: "atmux_cockpit",
      cockpitPath,
      crontabRead: async () =>
        "# >>> atmux:team=new-team\n*/5 * * * * echo\n# <<< atmux:team=new-team\n",
    });
    expect(
      result.gaps.some((g) => g.check === "team-json-name" && /read failed/.test(g.detail)),
    ).toBe(true);
  });

  test("cockpit.json unparsable → 'cockpit-registry' read/parse-failed gap", async () => {
    const { root, atmuxDir } = await fixture({ teamName: "new-team" });
    tmpDirs.push(root);
    const cockpitDir = await mkdtemp(join(tmpdir(), "atmux-convergence-cockpit-"));
    tmpDirs.push(cockpitDir);
    const cockpitPath = join(cockpitDir, "cockpit.json");
    await writeFile(cockpitPath, "{not json");

    const result = await verifyConvergence({
      atmuxDir,
      newName: "new-team",
      newSession: "new-team",
      oldName: "old-team",
      cageTmux: tmuxWithSession("new-team"),
      cockpitTmux: cockpitTmuxWithWindow("new-team"),
      cockpitSession: "atmux_cockpit",
      cockpitPath,
      crontabRead: async () =>
        "# >>> atmux:team=new-team\n*/5 * * * * echo\n# <<< atmux:team=new-team\n",
    });
    expect(
      result.gaps.some(
        (g) => g.check === "cockpit-registry" && /read\/parse failed/.test(g.detail),
      ),
    ).toBe(true);
  });

  test("stale oldName team-viewer window → gap", async () => {
    const { root, atmuxDir } = await fixture({ teamName: "new-team" });
    tmpDirs.push(root);
    const { path: cockpitPath } = await convergedCockpitPath();
    const cockpitTmux = {
      window: {
        listWindows: async () => [
          { index: 1, id: "@1", name: "new-team", active: true },
          { index: 2, id: "@2", name: "old-team", active: false },
        ],
      },
    } as unknown as TmuxNamespace;

    const result = await verifyConvergence({
      atmuxDir,
      newName: "new-team",
      newSession: "new-team",
      oldName: "old-team",
      cageTmux: tmuxWithSession("new-team"),
      cockpitTmux,
      cockpitSession: "atmux_cockpit",
      cockpitPath,
      crontabRead: async () =>
        "# >>> atmux:team=new-team\n*/5 * * * * echo\n# <<< atmux:team=new-team\n",
    });
    expect(
      result.gaps.some(
        (g) =>
          g.check === "cockpit-team-viewer-window" &&
          g.detail.includes("still has window named 'old-team'"),
      ),
    ).toBe(true);
  });

  test("crontabRead rejection → 'leftover-cron-block' read-failed gap", async () => {
    const { root, atmuxDir } = await fixture({ teamName: "new-team" });
    tmpDirs.push(root);
    const { path: cockpitPath } = await convergedCockpitPath();

    const result = await verifyConvergence({
      atmuxDir,
      newName: "new-team",
      newSession: "new-team",
      oldName: "old-team",
      cageTmux: tmuxWithSession("new-team"),
      cockpitTmux: cockpitTmuxWithWindow("new-team"),
      cockpitSession: "atmux_cockpit",
      cockpitPath,
      crontabRead: async () => {
        throw new Error("cron exploded");
      },
    });
    expect(
      result.gaps.some((g) => g.check === "leftover-cron-block" && /read failed/.test(g.detail)),
    ).toBe(true);
  });

  test("legacy root atmuxDir exercises parentDirOf fallback", async () => {
    const { root } = await fixture({ teamName: "new-team" });
    tmpDirs.push(root);
    const { path: cockpitPath } = await convergedCockpitPath();

    const result = await verifyConvergence({
      atmuxDir: root,
      newName: "new-team",
      newSession: "new-team",
      oldName: "old-team",
      cageTmux: tmuxWithSession("new-team"),
      cockpitTmux: cockpitTmuxWithWindow("new-team"),
      cockpitSession: "atmux_cockpit",
      cockpitPath,
      crontabRead: async () =>
        "# >>> atmux:team=new-team\n*/5 * * * * echo\n# <<< atmux:team=new-team\n",
    });
    expect(result.converged).toBe(true);
  });

  test("default crontab reader runs without a seam", async () => {
    const { root, atmuxDir } = await fixture({ teamName: "new-team" });
    tmpDirs.push(root);
    const { path: cockpitPath } = await convergedCockpitPath();

    const result = await verifyConvergence({
      atmuxDir,
      newName: "new-team",
      newSession: "new-team",
      oldName: "old-team-never-in-any-crontab",
      cageTmux: tmuxWithSession("new-team"),
      cockpitTmux: cockpitTmuxWithWindow("new-team"),
      cockpitSession: "atmux_cockpit",
      cockpitPath,
    });
    // The real defaultCrontabIO().read() runs here. Two machine
    // outcomes: (a) crontab is available and returns the host table
    // without our never-used marker → no leftover-cron-block gap;
    // (b) crontab is unavailable (CI sandbox) and throws → a single
    // read-failed gap. Either way there must be no false stale-marker gap.
    for (const g of result.gaps) {
      expect(g.check !== "leftover-cron-block" || /read failed/.test(g.detail)).toBe(true);
    }
  });
  test("cage list-sessions failure → 'cage-session-alive' failure gap", async () => {
    const { root, atmuxDir } = await fixture({ teamName: "new-team" });
    tmpDirs.push(root);
    const { path: cockpitPath } = await convergedCockpitPath();
    const cageTmux = {
      session: {
        listSessions: async () => {
          throw new Error("cage socket missing");
        },
      },
    } as unknown as TmuxNamespace;

    const result = await verifyConvergence({
      atmuxDir,
      newName: "new-team",
      newSession: "new-team",
      oldName: "old-team",
      cageTmux,
      cockpitTmux: cockpitTmuxWithWindow("new-team"),
      cockpitSession: "atmux_cockpit",
      cockpitPath,
      crontabRead: async () =>
        "# >>> atmux:team=new-team\n*/5 * * * * echo\n# <<< atmux:team=new-team\n",
    });
    expect(
      result.gaps.some(
        (g) => g.check === "cage-session-alive" && /list-sessions failed/.test(g.detail),
      ),
    ).toBe(true);
  });

  test("cockpit missing newName window → 'cockpit-team-viewer-window' gap", async () => {
    const { root, atmuxDir } = await fixture({ teamName: "new-team" });
    tmpDirs.push(root);
    const { path: cockpitPath } = await convergedCockpitPath();

    const result = await verifyConvergence({
      atmuxDir,
      newName: "new-team",
      newSession: "new-team",
      oldName: "old-team",
      cageTmux: tmuxWithSession("new-team"),
      cockpitTmux: cockpitTmuxWithWindow("some-other-window"),
      cockpitSession: "atmux_cockpit",
      cockpitPath,
      crontabRead: async () =>
        "# >>> atmux:team=new-team\n*/5 * * * * echo\n# <<< atmux:team=new-team\n",
    });
    expect(
      result.gaps.some(
        (g) =>
          g.check === "cockpit-team-viewer-window" &&
          g.detail.includes("has no window named 'new-team'"),
      ),
    ).toBe(true);
  });
  test("cage sessions without newSession lists found names", async () => {
    const { root, atmuxDir } = await fixture({ teamName: "new-team" });
    tmpDirs.push(root);
    const { path: cockpitPath } = await convergedCockpitPath();

    const result = await verifyConvergence({
      atmuxDir,
      newName: "new-team",
      newSession: "new-team",
      oldName: "old-team",
      cageTmux: tmuxWithSession("stale-session"),
      cockpitTmux: cockpitTmuxWithWindow("new-team"),
      cockpitSession: "atmux_cockpit",
      cockpitPath,
      crontabRead: async () => "",
    });
    expect(
      result.gaps.some(
        (g) => g.check === "cage-session-alive" && g.detail.includes("stale-session"),
      ),
    ).toBe(true);
  });

  test("blank session anchor on single-session team → '<null>' gap", async () => {
    const { root, atmuxDir } = await fixture({
      teamName: "new-team",
      sessionAnchor: "\n",
    });
    tmpDirs.push(root);
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({ name: "new-team", members: [], singleSession: true }),
    );
    const { path: cockpitPath } = await convergedCockpitPath();

    const result = await verifyConvergence({
      atmuxDir,
      newName: "new-team",
      newSession: "new-team",
      oldName: "old-team",
      cageTmux: tmuxWithSession("new-team"),
      cockpitTmux: cockpitTmuxWithWindow("new-team"),
      cockpitSession: "atmux_cockpit",
      cockpitPath,
      crontabRead: async () => "",
    });
    expect(
      result.gaps.some((g) => g.check === "session-anchor" && g.detail.includes("anchor='<null>'")),
    ).toBe(true);
  });

  test("legacy flat teams[] cockpit migrates cleanly", async () => {
    const { root, atmuxDir } = await fixture({ teamName: "new-team" });
    tmpDirs.push(root);
    const cockpitDir = await mkdtemp(join(tmpdir(), "atmux-convergence-cockpit-"));
    tmpDirs.push(cockpitDir);
    const cockpitPath = join(cockpitDir, "cockpit.json");
    await writeFile(
      cockpitPath,
      JSON.stringify({
        cockpitSession: "atmux_cockpit",
        teams: [{ name: "new-team", enabled: true, root: "/r", sessions: [] }],
      }),
    );

    const result = await verifyConvergence({
      atmuxDir,
      newName: "new-team",
      newSession: "new-team",
      oldName: "old-team",
      cageTmux: tmuxWithSession("new-team"),
      cockpitTmux: cockpitTmuxWithWindow("new-team"),
      cockpitSession: "atmux_cockpit",
      cockpitPath,
      crontabRead: async () =>
        "# >>> atmux:team=new-team\n*/5 * * * * echo\n# <<< atmux:team=new-team\n",
    });
    expect(result.converged).toBe(true);
  });
});

// ---------- formatConvergenceHint ----------

describe("formatConvergenceHint", () => {
  test("converged → empty string", () => {
    expect(formatConvergenceHint({ converged: true, gaps: [] }, "x")).toBe("");
  });

  test("multi-gap → bulleted block + repair-rename hint", () => {
    const result = {
      converged: false,
      gaps: [
        { check: "team-json-name" as const, detail: "name='wrong'" },
        { check: "session-anchor" as const, detail: "anchor='stale'" },
      ],
    };
    const hint = formatConvergenceHint(result, "new-name");
    expect(hint).toContain("convergence check found gaps");
    expect(hint).toContain("[team-json-name]");
    expect(hint).toContain("[session-anchor]");
    expect(hint).toContain("atmux team repair-rename new-name");
  });
});
