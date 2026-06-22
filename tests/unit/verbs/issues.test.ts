// ADR-263 §D3 (P3): `atmux issues` verb tests.
//
// Pure arg-parsing + dispatch are tested directly. The `sync` happy path
// runs against a temp atmuxDir + team.json with an injected mock tracker
// (the `SyncDeps` DI seam) — no network.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  IssueTracker,
  IssueTrackerPage,
  ListIssuesOptions,
  NormalizedIssue,
} from "../../../src/abstractions/issue-tracker.ts";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import type { SyncDeps } from "../../../src/core/issue-sync.ts";
import { KanbanRepo } from "../../../src/core/repositories/kanban-repo.ts";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import { issues, parseSyncArgs } from "../../../src/verbs/issues.ts";

let teamDir: string;
let atmuxDir: string;

beforeEach(async () => {
  teamDir = await mkdtemp(join(tmpdir(), "atmux-issues-verb-"));
  atmuxDir = join(teamDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
});
afterEach(async () => {
  await rm(teamDir, { recursive: true, force: true });
});

async function writeTeam(extra: Record<string, unknown>): Promise<void> {
  await writeFile(
    join(atmuxDir, "team.json"),
    JSON.stringify({ name: "team", members: [{ name: "alpha" }], ...extra }),
  );
}

function issue(over: Partial<NormalizedIssue> = {}): NormalizedIssue {
  return {
    trackerId: "github",
    sourceId: "github:o/r#1",
    url: "https://github.com/o/r/issues/1",
    title: "Bug one",
    body: "body",
    state: "open",
    labels: [],
    assignee: null,
    author: null,
    createdAtSec: 1_700_000_000,
    updatedAtSec: 1_700_000_100,
    extra: { isPullRequest: false },
    ...over,
  };
}

function mockDeps(pages: NormalizedIssue[][]): SyncDeps {
  const tracker: IssueTracker = {
    id: "github",
    async listIssues(o: ListIssuesOptions): Promise<IssueTrackerPage> {
      const page = o.cursor != null ? Number.parseInt(o.cursor, 10) : 1;
      const idx = page - 1;
      const list = pages[idx] ?? [];
      const nextCursor = idx + 1 < pages.length ? String(page + 1) : null;
      return { issues: list, nextCursor };
    },
    async getIssue(): Promise<NormalizedIssue | null> {
      return null;
    },
  };
  return { resolveTracker: async () => tracker, nowMs: () => 1_700_000_500_000 };
}

async function captureStdout(fn: () => Promise<number>): Promise<{ exit: number; out: string }> {
  let out = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string | Uint8Array) => {
    out += typeof s === "string" ? s : new TextDecoder().decode(s);
    return true;
  }) as typeof process.stdout.write;
  try {
    const exit = await fn();
    return { exit, out };
  } finally {
    process.stdout.write = orig;
  }
}

// ---------- parseSyncArgs ----------

describe("parseSyncArgs", () => {
  test("defaults: no source, dryRun false", () => {
    expect(parseSyncArgs([])).toEqual({ dryRun: false });
  });
  test("--source / --dry-run / --team-dir consumed", () => {
    expect(parseSyncArgs(["--source", "o/r", "--dry-run", "--team-dir", "/p"])).toEqual({
      source: "o/r",
      dryRun: true,
      teamDir: "/p",
    });
  });
  test("--source requires a value", () => {
    expect(() => parseSyncArgs(["--source"])).toThrow(UsageError);
  });
  test("--team-dir requires a value", () => {
    expect(() => parseSyncArgs(["--team-dir"])).toThrow(UsageError);
  });
  test("unknown arg throws", () => {
    expect(() => parseSyncArgs(["--nope"])).toThrow(UsageError);
  });
});

// ---------- dispatch ----------

describe("issues dispatch", () => {
  test("missing subverb throws UsageError", async () => {
    await expect(issues([])).rejects.toThrow(UsageError);
  });
  test("unknown subverb throws UsageError", async () => {
    await expect(issues(["frob"])).rejects.toThrow(/unknown subverb/);
  });
});

// ---------- sync: config errors ----------

describe("issues sync — config", () => {
  test("no taskSources → ConfigError", async () => {
    await writeTeam({});
    await expect(issues(["sync", "--team-dir", teamDir], mockDeps([[]]))).rejects.toThrow(
      /no taskSources configured/,
    );
  });

  test("--source with no matching scope → ConfigError", async () => {
    await writeTeam({ taskSources: [{ provider: "github", scope: "o/r" }] });
    await expect(
      issues(["sync", "--source", "x/y", "--team-dir", teamDir], mockDeps([[]])),
    ).rejects.toThrow(ConfigError);
  });
});

// ---------- sync: happy path ----------

describe("issues sync — happy path", () => {
  test("ingests issues + prints a per-source summary", async () => {
    await writeTeam({ taskSources: [{ provider: "github", scope: "o/r" }] });
    const { exit, out } = await captureStdout(() =>
      issues(
        ["sync", "--team-dir", teamDir],
        mockDeps([[issue(), issue({ sourceId: "github:o/r#2" })]]),
      ),
    );
    expect(exit).toBe(0);
    expect(out).toContain("synced github:o/r");
    expect(out).toContain("fetched 2, created 2");

    const db = openDatabase(join(atmuxDir, "state.db"), migrations);
    try {
      expect(new KanbanRepo(db).listTasks()).toHaveLength(2);
    } finally {
      closeDatabase(db);
    }
  });

  test("--dry-run prints 'would sync' and writes nothing", async () => {
    await writeTeam({ taskSources: [{ provider: "github", scope: "o/r" }] });
    const { out } = await captureStdout(() =>
      issues(["sync", "--dry-run", "--team-dir", teamDir], mockDeps([[issue()]])),
    );
    expect(out).toContain("would sync github:o/r");
    const db = openDatabase(join(atmuxDir, "state.db"), migrations);
    try {
      expect(new KanbanRepo(db).listTasks()).toHaveLength(0);
    } finally {
      closeDatabase(db);
    }
  });

  test("surfaces non-fatal per-source warnings on stderr (still exit 0)", async () => {
    await writeTeam({ taskSources: [{ provider: "github", scope: "o/r" }] });
    // A runaway tracker (always a next page) trips the pagination cap →
    // a non-fatal error that the verb prints as a stderr warning.
    const runaway: IssueTracker = {
      id: "github",
      async listIssues(): Promise<IssueTrackerPage> {
        return { issues: [], nextCursor: "2" };
      },
      async getIssue(): Promise<NormalizedIssue | null> {
        return null;
      },
    };
    let err = "";
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string | Uint8Array) => {
      err += typeof s === "string" ? s : new TextDecoder().decode(s);
      return true;
    }) as typeof process.stderr.write;
    let exit: number;
    try {
      exit = await issues(["sync", "--team-dir", teamDir], {
        resolveTracker: async () => runaway,
        nowMs: () => 1_700_000_500_000,
      });
    } finally {
      process.stderr.write = orig;
    }
    expect(exit).toBe(0);
    expect(err).toContain("pagination cap");
  });

  test("--source selects a single configured source", async () => {
    await writeTeam({
      taskSources: [
        { provider: "github", scope: "o/r" },
        { provider: "github", scope: "a/b" },
      ],
    });
    const { out } = await captureStdout(() =>
      issues(
        ["sync", "--source", "a/b", "--team-dir", teamDir],
        mockDeps([[issue({ sourceId: "github:a/b#1" })]]),
      ),
    );
    expect(out).toContain("synced github:a/b");
    expect(out).not.toContain("synced github:o/r");
  });
});
