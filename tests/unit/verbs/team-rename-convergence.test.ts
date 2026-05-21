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
