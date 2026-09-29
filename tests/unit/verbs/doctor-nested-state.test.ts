import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageError } from "../../../src/errors.ts";
import type { Team } from "../../../src/schema/team.ts";
import {
  checkNestedStateDb,
  findNestedStateOffenders,
  formatNestedStateBanner,
  type NestedStateDirEntry,
  type NestedStateOffender,
  nestedStateDbRows,
  remediateNestedStateDb,
  runFixNestedStateDb,
} from "../../../src/verbs/doctor/nested-state.ts";
import { doctor, parseDoctorArgs } from "../../../src/verbs/doctor.ts";

const ATMUX = "/t/proj/.atmux";

function team(): Team {
  return { name: "demo", members: [{ name: "alice" }] } as Team;
}

// ---------- In-memory fs fake ----------

interface FakeTree {
  /** dir path → entries. Absent path reads as ENOENT (null). */
  dirs: Map<string, NestedStateDirEntry[]>;
  /** file paths that exist (for existsPath). */
  files: Set<string>;
}

function fakeScanOpts(tree: FakeTree): {
  readDir: (path: string) => Promise<NestedStateDirEntry[] | null>;
  existsPath: (path: string) => Promise<boolean>;
  readCalls: string[];
} {
  const readCalls: string[] = [];
  return {
    readCalls,
    readDir: async (path: string) => {
      readCalls.push(path);
      return tree.dirs.get(path) ?? null;
    },
    existsPath: async (path: string) => tree.files.has(path),
  };
}

function dir(...entries: Array<[string, boolean]>): NestedStateDirEntry[] {
  return entries.map(([name, isDirectory]) => ({ name, isDirectory }));
}

// ---------- findNestedStateOffenders ----------

describe("findNestedStateOffenders", () => {
  test("clean tree (canonical db only, unreadable subdir) → no offenders", async () => {
    const tree: FakeTree = {
      dirs: new Map([
        [ATMUX, dir(["state.db", false], ["state", true], ["worktrees", true])],
        [join(ATMUX, "state"), dir(["session.txt", false])],
        // worktrees/ absent → ENOENT (null) → silent, no isolation in use.
      ]),
      files: new Set([join(ATMUX, "state.db")]),
    };
    const fakes = fakeScanOpts(tree);
    // `state/` listing is missing from the map → null → skipped silently.
    expect(await findNestedStateOffenders(ATMUX, fakes)).toEqual([]);
  });

  test("healthy worktree identity stub (team.json only) → silent", async () => {
    const stub = join(ATMUX, "worktrees", "alice", ".atmux");
    const tree: FakeTree = {
      dirs: new Map([
        [ATMUX, dir(["state.db", false], ["worktrees", true])],
        [join(ATMUX, "worktrees"), dir(["alice", true])],
        [join(ATMUX, "worktrees", "alice"), dir([".atmux", true])],
        [stub, dir(["team.json", false])],
      ]),
      files: new Set([join(ATMUX, "state.db"), join(stub, "team.json")]),
    };
    expect(await findNestedStateOffenders(ATMUX, fakeScanOpts(tree))).toEqual([]);
  });

  test("worktree-stub state.db stays owned by checkWorktreeNestedStateDb → no row here", async () => {
    // One leaked db must never surface as TWO red rows. The ./git.ts
    // probe owns `<atmuxDir>/worktrees/<m>/.atmux/state.db`; this scan
    // excludes exactly that shape.
    const stub = join(ATMUX, "worktrees", "bob", ".atmux");
    const tree: FakeTree = {
      dirs: new Map([
        [ATMUX, dir(["state.db", false], ["worktrees", true])],
        [join(ATMUX, "worktrees"), dir(["bob", true])],
        [join(ATMUX, "worktrees", "bob"), dir([".atmux", true])],
        [stub, dir(["team.json", false], ["state.db", false])],
      ]),
      files: new Set([join(ATMUX, "state.db")]),
    };
    expect(await findNestedStateOffenders(ATMUX, fakeScanOpts(tree))).toEqual([]);
  });

  test("nested .atmux dir directly inside .atmux/ → nested-atmux-dir offender", async () => {
    const nested = join(ATMUX, ".atmux");
    const tree: FakeTree = {
      dirs: new Map([
        [ATMUX, dir(["state.db", false], [".atmux", true])],
        [nested, dir(["team.json", false])],
      ]),
      files: new Set([join(ATMUX, "state.db")]),
    };
    expect(await findNestedStateOffenders(ATMUX, fakeScanOpts(tree))).toEqual([
      { kind: "nested-atmux-dir", path: nested },
    ]);
  });

  test("deep nested .atmux dir + stray state.db → one offender each", async () => {
    const nested = join(ATMUX, "state", "cache", ".atmux");
    const stray = join(ATMUX, "state", "cache", "state.db");
    const tree: FakeTree = {
      dirs: new Map([
        [ATMUX, dir(["state.db", false], ["state", true], ["archive", true])],
        [join(ATMUX, "state"), dir(["cache", true])],
        [join(ATMUX, "state", "cache"), dir([".atmux", true], ["state.db", false])],
        [nested, dir(["team.json", false])],
        // Quarantine subtree never self-flags, even with a state.db inside.
        [join(ATMUX, "archive"), dir(["state.db", false])],
      ]),
      files: new Set([join(ATMUX, "state.db")]),
    };
    const offenders = await findNestedStateOffenders(ATMUX, fakeScanOpts(tree));
    expect(offenders).toEqual([
      { kind: "nested-atmux-dir", path: nested },
      { kind: "stray-state-db", path: stray },
    ]);
  });

  test("ancestor team above the project root → nested-atmux-dir offender", async () => {
    const ancestor = join("/t", ".atmux");
    const tree: FakeTree = {
      dirs: new Map([[ATMUX, dir(["state.db", false])]]),
      // Only the ancestor carries a team.json — the cockpit home
      // (~/.atmux, cockpit.json without team.json) never matches.
      files: new Set([join(ATMUX, "state.db"), join(ancestor, "team.json")]),
    };
    expect(await findNestedStateOffenders(ATMUX, fakeScanOpts(tree))).toEqual([
      { kind: "nested-atmux-dir", path: ancestor },
    ]);
  });
});

// ---------- rows + banner ----------

describe("nestedStateDbRows + formatNestedStateBanner", () => {
  test("no offenders → no rows", () => {
    expect(nestedStateDbRows(ATMUX, [])).toEqual([]);
  });

  test("banner names every offender path", () => {
    const offenders: NestedStateOffender[] = [
      { kind: "nested-atmux-dir", path: join(ATMUX, ".atmux") },
      { kind: "stray-state-db", path: join(ATMUX, "state", "state.db") },
    ];
    const banner = formatNestedStateBanner(ATMUX, offenders);
    expect(banner).toContain(join(ATMUX, ".atmux"));
    expect(banner).toContain(join(ATMUX, "state", "state.db"));
    expect(banner).toContain("2 offender(s)");
    const rows = nestedStateDbRows(ATMUX, offenders);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("red");
    expect(rows[0]?.label).toBe("nested-state-db");
    expect(rows[0]?.detail).toBe(banner);
    expect(rows[0]?.hint).toContain("--fix-nested-state-db archive");
  });

  test("checkNestedStateDb: team null → silent without touching the fs", async () => {
    const tree: FakeTree = { dirs: new Map(), files: new Set() };
    const fakes = fakeScanOpts(tree);
    expect(await checkNestedStateDb(null, ATMUX, fakes)).toEqual([]);
    expect(fakes.readCalls).toEqual([]);
  });

  test("checkNestedStateDb: team present → banner row for scan hits", async () => {
    const stray = join(ATMUX, "state.db.bak", "state.db");
    const tree: FakeTree = {
      dirs: new Map([
        [ATMUX, dir(["state.db", false], ["state.db.bak", true])],
        [join(ATMUX, "state.db.bak"), dir(["state.db", false])],
      ]),
      files: new Set([join(ATMUX, "state.db")]),
    };
    const rows = await checkNestedStateDb(team(), ATMUX, fakeScanOpts(tree));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toContain(stray);
  });
});

// ---------- remediateNestedStateDb ----------

describe("remediateNestedStateDb", () => {
  const ownedDir: NestedStateOffender = {
    kind: "nested-atmux-dir",
    path: join(ATMUX, "cache", ".atmux"),
  };
  const ownedDb: NestedStateOffender = {
    kind: "stray-state-db",
    path: join(ATMUX, "state", "state.db"),
  };
  const ancestor: NestedStateOffender = { kind: "nested-atmux-dir", path: join("/t", ".atmux") };

  test("confirm false → refused, read-only (no fs call)", async () => {
    let calls = 0;
    const result = await remediateNestedStateDb(ATMUX, [ownedDir, ownedDb], {
      mode: "archive",
      confirm: false,
      ensureDir: async () => {
        calls += 1;
      },
      movePath: async () => {
        calls += 1;
      },
      removePath: async () => {
        calls += 1;
      },
    });
    expect(result.status).toBe("refused");
    expect(result.reason).toContain("explicit confirm");
    expect(result.acted).toEqual([]);
    expect(calls).toBe(0);
  });

  test("archive → owned offenders quarantined, ancestor skipped (never touched)", async () => {
    const ensured: string[] = [];
    const moved: Array<[string, string]> = [];
    const destDir = join(ATMUX, "archive", "nested-state-db-nested-atmux-dir__0__cache__.atmux");
    const destDb = join(ATMUX, "archive", "nested-state-db-stray-state-db__1__state__state.db");
    const result = await remediateNestedStateDb(ATMUX, [ownedDir, ownedDb, ancestor], {
      mode: "archive",
      confirm: true,
      ensureDir: async (p) => {
        ensured.push(p);
      },
      movePath: async (src, dest) => {
        moved.push([src, dest]);
      },
      removePath: async () => {
        throw new Error("delete must not run in archive mode");
      },
    });
    expect(result.acted).toEqual([
      { offender: ownedDir, dest: destDir },
      { offender: ownedDb, dest: destDb },
    ]);
    expect(result.skipped).toEqual([ancestor]);
    expect(moved).toEqual([
      [ownedDir.path, destDir],
      [ownedDb.path, destDb],
    ]);
    expect(ensured).toEqual([join(ATMUX, "archive"), join(ATMUX, "archive")]);
  });

  test("delete → owned offenders removed, ancestor skipped (never touched)", async () => {
    const removed: string[] = [];
    const result = await remediateNestedStateDb(ATMUX, [ownedDb, ancestor], {
      mode: "delete",
      confirm: true,
      movePath: async () => {
        throw new Error("move must not run in delete mode");
      },
      removePath: async (p) => {
        removed.push(p);
      },
    });
    expect(result.status).toBe("done");
    expect(result.acted).toEqual([{ offender: ownedDb }]);
    expect(result.skipped).toEqual([ancestor]);
    expect(removed).toEqual([ownedDb.path]);
  });
});

// ---------- runFixNestedStateDb ----------

describe("runFixNestedStateDb", () => {
  test("team null → skip note, scan never runs", async () => {
    const lines: string[] = [];
    let scans = 0;
    await runFixNestedStateDb(ATMUX, null, "archive", {
      stderr: (s) => {
        lines.push(s);
      },
      scan: async () => {
        scans += 1;
        return [];
      },
    });
    expect(scans).toBe(0);
    expect(lines.join("")).toContain("skipped (no team loaded;");
  });

  test("archive mode → banner + archived receipts + skipped lines", async () => {
    const offenders: NestedStateOffender[] = [
      { kind: "stray-state-db", path: join(ATMUX, "state", "state.db") },
      { kind: "nested-atmux-dir", path: join("/t", ".atmux") },
    ];
    const lines: string[] = [];
    await runFixNestedStateDb(ATMUX, team(), "archive", {
      stderr: (s) => {
        lines.push(s);
      },
      scan: async () => offenders,
      remediate: async (dir, found, opts) => {
        expect(dir).toBe(ATMUX);
        expect(opts).toMatchObject({ mode: "archive", confirm: true });
        expect(found).toHaveLength(2);
        const [first, second] = found;
        if (first === undefined || second === undefined) throw new Error("fixture shape");
        return {
          status: "done",
          acted: [{ offender: first, dest: join(dir, "archive", "q") }],
          skipped: [second],
        };
      },
    });
    const out = lines.join("");
    expect(out).toContain(join(ATMUX, "state", "state.db"));
    expect(out).toContain(join("/t", ".atmux"));
    expect(out).toContain(`archived ${join(ATMUX, "state", "state.db")}`);
    expect(out).toContain(`skipped (outside ${ATMUX}, resolve by hand)`);
  });

  test("delete mode → deleted receipt wording", async () => {
    const lines: string[] = [];
    await runFixNestedStateDb(ATMUX, team(), "delete", {
      stderr: (s) => {
        lines.push(s);
      },
      scan: async () => [{ kind: "stray-state-db", path: join(ATMUX, "x", "state.db") }],
      remediate: async (_dir, found) => {
        const [first] = found;
        if (first === undefined) throw new Error("fixture shape");
        return { status: "done", acted: [{ offender: first }], skipped: [] };
      },
    });
    expect(lines.join("")).toContain(`deleted ${join(ATMUX, "x", "state.db")}`);
  });

  test("refused remediation → refused line carrying the reason", async () => {
    const lines: string[] = [];
    await runFixNestedStateDb(ATMUX, team(), "archive", {
      stderr: (s) => {
        lines.push(s);
      },
      scan: async () => [],
      remediate: async () => ({ status: "refused", reason: "no confirm", acted: [], skipped: [] }),
    });
    expect(lines.join("")).toContain("refused — no confirm");
  });
});

// ---------- parseDoctorArgs --fix-nested-state-db ----------

describe("parseDoctorArgs --fix-nested-state-db", () => {
  test("archive + delete parse", () => {
    expect(parseDoctorArgs(["--fix-nested-state-db", "archive"]).fixNestedStateDb).toBe("archive");
    expect(parseDoctorArgs(["--fix-nested-state-db", "delete"]).fixNestedStateDb).toBe("delete");
  });

  test("absent flag → undefined (read-only default)", () => {
    expect(parseDoctorArgs([]).fixNestedStateDb).toBeUndefined();
  });

  test("missing value → UsageError", () => {
    expect(() => parseDoctorArgs(["--fix-nested-state-db"])).toThrow(UsageError);
  });

  test("invalid value → UsageError", () => {
    expect(() => parseDoctorArgs(["--fix-nested-state-db", "quarantine"])).toThrow(UsageError);
  });
});

// ---------- doctor() delegation (read-miss only, no writes) ----------

describe("doctor() --fix-nested-state-db", () => {
  test("no team loaded → skip note, exit 0", async () => {
    const lines: string[] = [];
    const code = await doctor(
      ["--team-dir", "/nonexistent-xyz-nested-state", "--fix-nested-state-db", "archive"],
      {
        runChecks: async () => [],
        stderr: (s) => {
          lines.push(s);
        },
      },
    );
    expect(code).toBe(0);
    expect(lines.join("")).toContain("skipped (no team loaded;");
  });
});

// ---------- production defaults (real temp dir) ----------
//
// The tests above drive every seam with fakes. These two pin the
// DEFAULT seams (`defaultReadDir` + `exists`) end to end so the
// 100% line gate also holds for the production path: success +
// ENOENT arms, plus the non-ENOENT rethrow. Upward-scan assertions
// use arrayContaining — a pre-existing /tmp/.atmux on the host would
// add a legitimate extra row.

describe("findNestedStateOffenders defaults", () => {
  let dir: string;
  let atmuxDir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atmux-nested-state-defaults-"));
    atmuxDir = join(dir, ".atmux");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("nested dir + stray db surface; stub/archive/canonical stay silent", async () => {
    const nested = join(atmuxDir, "cache", ".atmux");
    const stray = join(atmuxDir, "state", "state.db");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "team.json"), "{}");
    await mkdir(join(atmuxDir, "state"), { recursive: true });
    await writeFile(stray, "x");
    await writeFile(join(atmuxDir, "state.db"), "x");
    await mkdir(join(atmuxDir, "worktrees", "m", ".atmux"), { recursive: true });
    await writeFile(join(atmuxDir, "worktrees", "m", ".atmux", "team.json"), "{}");
    await mkdir(join(atmuxDir, "archive", "old"), { recursive: true });
    await writeFile(join(atmuxDir, "archive", "old", "state.db"), "x");
    const offenders = await findNestedStateOffenders(atmuxDir);
    expect(offenders).toEqual(
      expect.arrayContaining([
        { kind: "nested-atmux-dir", path: nested },
        { kind: "stray-state-db", path: stray },
      ]),
    );
    expect(offenders.some((o) => o.path.includes("worktrees"))).toBe(false);
    expect(offenders.some((o) => o.path.includes("archive"))).toBe(false);
    expect(offenders.some((o) => o.path === join(atmuxDir, "state.db"))).toBe(false);
  });

  test("atmuxDir pointing at a file → non-ENOENT rethrows", async () => {
    const file = join(dir, "not-a-dir");
    await writeFile(file, "x");
    await expect(findNestedStateOffenders(file)).rejects.toThrow();
  });

  test("missing atmuxDir → ENOENT reads as empty downward (no offenders beneath it)", async () => {
    const missing = join(dir, "does-not-exist", ".atmux");
    const offenders = await findNestedStateOffenders(missing);
    expect(offenders.every((o) => !o.path.startsWith(dir))).toBe(true);
  });
});
