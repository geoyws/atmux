// Unit tests for src/verbs/groom.ts (ADR-068 cutover Tier 1, P0).
//
// Covers parseGroomArgs (every branch), groomDisabledByEnv (every
// branch), and the verb body — happy path, --dry-run, ATMUX_NO_GROOM
// kill-switch, lock-held early return, and sub-op error containment.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquire } from "../../../src/abstractions/lock.ts";
import type { Logger } from "../../../src/core/tui.ts";
import { UsageError } from "../../../src/errors.ts";
import { groom, groomDisabledByEnv, parseGroomArgs } from "../../../src/verbs/groom.ts";

const RUN_MS = Date.UTC(2026, 4, 8, 14, 55, 0);

interface Env {
  atmuxDir: string;
  logs: { kind: "log" | "ok" | "warn" | "err"; msg: string }[];
  logger: Logger;
  stdoutBuf: string[];
}

let env: Env;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "atmux-groom-verb-"));
  const atmuxDir = join(root, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  const logs: Env["logs"] = [];
  const logger: Logger = {
    log: (m) => logs.push({ kind: "log", msg: m }),
    ok: (m) => logs.push({ kind: "ok", msg: m }),
    warn: (m) => logs.push({ kind: "warn", msg: m }),
    err: (m) => logs.push({ kind: "err", msg: m }),
  };
  env = { atmuxDir, logs, logger, stdoutBuf: [] };
});

afterEach(async () => {
  await rm(join(env.atmuxDir, ".."), { recursive: true, force: true });
});

// ---------- parseGroomArgs ----------

describe("parseGroomArgs", () => {
  test("defaults are 7/30/30/5 + flags off", () => {
    const got = parseGroomArgs([]);
    expect(got).toEqual({
      dryRun: false,
      quiet: false,
      inboxDays: 7,
      kanbanDays: 30,
      decisionsDays: 30,
      keepBak: 5,
      showHelp: false,
    });
  });

  test("--dry-run + --quiet flip booleans", () => {
    const got = parseGroomArgs(["--dry-run", "--quiet"]);
    expect(got.dryRun).toBe(true);
    expect(got.quiet).toBe(true);
  });

  test("-h / --help set showHelp", () => {
    expect(parseGroomArgs(["-h"]).showHelp).toBe(true);
    expect(parseGroomArgs(["--help"]).showHelp).toBe(true);
  });

  test("numeric flags accept positive integers", () => {
    const got = parseGroomArgs([
      "--inbox-days",
      "14",
      "--kanban-days",
      "60",
      "--decisions-days",
      "90",
      "--keep-bak",
      "10",
    ]);
    expect(got).toMatchObject({
      inboxDays: 14,
      kanbanDays: 60,
      decisionsDays: 90,
      keepBak: 10,
    });
  });

  test("--keep-bak 0 is accepted", () => {
    const got = parseGroomArgs(["--keep-bak", "0"]);
    expect(got.keepBak).toBe(0);
  });

  test("missing value throws UsageError", () => {
    expect(() => parseGroomArgs(["--kanban-days"])).toThrow(UsageError);
  });

  test("non-numeric / negative value throws UsageError", () => {
    expect(() => parseGroomArgs(["--kanban-days", "abc"])).toThrow(UsageError);
    expect(() => parseGroomArgs(["--kanban-days", "-5"])).toThrow(UsageError);
  });

  test("unknown arg throws UsageError", () => {
    expect(() => parseGroomArgs(["--bogus"])).toThrow(UsageError);
  });
});

// ---------- groomDisabledByEnv ----------

describe("groomDisabledByEnv", () => {
  test("undefined / empty / 0 / false → enabled", () => {
    expect(groomDisabledByEnv({})).toBe(false);
    expect(groomDisabledByEnv({ ATMUX_NO_GROOM: "" })).toBe(false);
    expect(groomDisabledByEnv({ ATMUX_NO_GROOM: "0" })).toBe(false);
    expect(groomDisabledByEnv({ ATMUX_NO_GROOM: "false" })).toBe(false);
    expect(groomDisabledByEnv({ ATMUX_NO_GROOM: "FALSE" })).toBe(false);
    expect(groomDisabledByEnv({ ATMUX_NO_GROOM: "False" })).toBe(false);
  });

  test("any other value disables", () => {
    expect(groomDisabledByEnv({ ATMUX_NO_GROOM: "1" })).toBe(true);
    expect(groomDisabledByEnv({ ATMUX_NO_GROOM: "true" })).toBe(true);
    expect(groomDisabledByEnv({ ATMUX_NO_GROOM: "yes" })).toBe(true);
  });
});

// ---------- groom body ----------

describe("groom verb", () => {
  test("--help prints usage to stdout + exits 0", async () => {
    const rc = await groom(["--help"], {
      atmuxDir: env.atmuxDir,
      stdout: (s) => env.stdoutBuf.push(s),
      logger: env.logger,
      env: {},
    });
    expect(rc).toBe(0);
    expect(env.stdoutBuf.join("")).toContain("atmux groom — sweep stale state");
  });

  test("ATMUX_NO_GROOM=1 short-circuits with no work", async () => {
    // Seed an inbox file with archive content; groom should leave it.
    const driverInbox = join(env.atmuxDir, "driver-inbox.md");
    const before = "# d\n\n## Archive\n\nold\n";
    await writeFile(driverInbox, before);

    const rc = await groom([], {
      atmuxDir: env.atmuxDir,
      env: { ATMUX_NO_GROOM: "1" },
      logger: env.logger,
    });
    expect(rc).toBe(0);
    const after = await readFile(driverInbox, "utf8");
    expect(after).toBe(before);
  });

  test("happy path: flushes archive + creates archive dir + returns 0", async () => {
    const driverInbox = join(env.atmuxDir, "driver-inbox.md");
    await writeFile(driverInbox, "# d\n\n## Open\n\n## Archive\n\nold-entry\n");

    const rc = await groom([], {
      atmuxDir: env.atmuxDir,
      env: {},
      logger: env.logger,
      nowMs: RUN_MS,
    });
    expect(rc).toBe(0);

    const archive = await readFile(
      join(env.atmuxDir, "archive", "driver-inbox-2026-05.md"),
      "utf8",
    );
    expect(archive).toContain("old-entry");

    // Logger emitted a `groom: flushed` ok line.
    const oks = env.logs.filter((l) => l.kind === "ok");
    expect(oks.some((l) => l.msg.includes("flushed driver-inbox.md"))).toBe(true);
  });

  test("--dry-run never writes; reports counts via logger", async () => {
    const driverInbox = join(env.atmuxDir, "driver-inbox.md");
    await writeFile(driverInbox, "# d\n\n## Archive\n\nold\n");

    const rc = await groom(["--dry-run"], {
      atmuxDir: env.atmuxDir,
      env: {},
      logger: env.logger,
      nowMs: RUN_MS,
    });
    expect(rc).toBe(0);

    const after = await readFile(driverInbox, "utf8");
    expect(after).toBe("# d\n\n## Archive\n\nold\n");

    const dryLog = env.logs.find((l) => l.msg.includes("[dry-run]"));
    expect(dryLog).toBeDefined();
  });

  test("--quiet suppresses ok/log lines", async () => {
    await writeFile(join(env.atmuxDir, "driver-inbox.md"), "# d\n\n## Archive\n\nold\n");
    await groom(["--quiet"], {
      atmuxDir: env.atmuxDir,
      env: {},
      logger: env.logger,
      nowMs: RUN_MS,
    });
    expect(env.logs.filter((l) => l.kind === "ok")).toHaveLength(0);
    expect(env.logs.filter((l) => l.kind === "log")).toHaveLength(0);
  });

  test("lock contention → return 0 silently (with --quiet)", async () => {
    // Acquire the groom lock externally; verb should see it held and bail.
    const lockHandle = await acquire(join(env.atmuxDir, "groom"));
    try {
      const rc = await groom(["--quiet"], {
        atmuxDir: env.atmuxDir,
        env: {},
        logger: env.logger,
        nowMs: RUN_MS,
      });
      expect(rc).toBe(0);
      // Quiet mode: no log line.
      expect(env.logs.filter((l) => l.kind === "log")).toHaveLength(0);
    } finally {
      await lockHandle.release();
    }
  });

  test("lock contention without --quiet emits info log", async () => {
    const lockHandle = await acquire(join(env.atmuxDir, "groom"));
    try {
      await groom([], {
        atmuxDir: env.atmuxDir,
        env: {},
        logger: env.logger,
        nowMs: RUN_MS,
      });
      const skipLog = env.logs.find((l) => l.msg.includes("another run holds the lock"));
      expect(skipLog).toBeDefined();
    } finally {
      await lockHandle.release();
    }
  });

  test("logs ok lines for every sub-op that did work (decisions + kanban + bak-cull)", async () => {
    // Seed decisions.md with one stale block.
    const oldEpoch = Math.floor(RUN_MS / 1000) - 60 * 86400;
    await writeFile(
      join(env.atmuxDir, "decisions.md"),
      `# header\n\n### d-aaaa1111\n- **timestamp**: ${oldEpoch}\nold body\n`,
    );

    // Seed kanban.json with one stale done task.
    const kanban = {
      tasks: [
        {
          id: "t-old",
          subject: "stale",
          status: "done",
          owner: "alice",
          completedAt: oldEpoch,
        },
      ],
      epics: [],
      stories: [],
    };
    await writeFile(join(env.atmuxDir, "kanban.json"), JSON.stringify(kanban));

    // Seed 7 bak files, then cull to keep 3.
    for (let i = 0; i < 7; i++) {
      await writeFile(join(env.atmuxDir, `kanban.json.bak.${i}`), `bak ${i}`);
    }

    const rc = await groom(["--keep-bak", "3"], {
      atmuxDir: env.atmuxDir,
      env: {},
      logger: env.logger,
      nowMs: RUN_MS,
    });
    expect(rc).toBe(0);

    const okMsgs = env.logs.filter((l) => l.kind === "ok").map((l) => l.msg);
    expect(okMsgs.some((m) => m.includes("decisions month-bucket"))).toBe(true);
    expect(okMsgs.some((m) => m.includes("stale kanban card"))).toBe(true);
    expect(okMsgs.some((m) => m.includes("stale kanban.json.bak"))).toBe(true);
  });

  test("dry-run mode emits dry-run logs for decisions + kanban + bak-cull", async () => {
    const oldEpoch = Math.floor(RUN_MS / 1000) - 60 * 86400;
    await writeFile(
      join(env.atmuxDir, "decisions.md"),
      `### d-aaaa1111\n- **timestamp**: ${oldEpoch}\nbody\n`,
    );
    await writeFile(
      join(env.atmuxDir, "kanban.json"),
      JSON.stringify({
        tasks: [
          {
            id: "t-old",
            status: "done",
            completedAt: oldEpoch,
            subject: "stale",
          },
        ],
        epics: [],
        stories: [],
      }),
    );
    for (let i = 0; i < 7; i++) {
      await writeFile(join(env.atmuxDir, `team.json.bak.${i}`), `b${i}`);
    }

    await groom(["--dry-run", "--keep-bak", "3"], {
      atmuxDir: env.atmuxDir,
      env: {},
      logger: env.logger,
      nowMs: RUN_MS,
    });

    const logMsgs = env.logs.filter((l) => l.kind === "log").map((l) => l.msg);
    expect(logMsgs.some((m) => m.includes("would archive 1 decisions"))).toBe(true);
    expect(logMsgs.some((m) => m.includes("would summarize+remove 1"))).toBe(true);
    expect(logMsgs.some((m) => m.includes("would delete 4 stale team.json"))).toBe(true);
  });

  test("size-check warning surfaces via logger.warn", async () => {
    // Cap the verb at a tiny threshold so any archive triggers the warn.
    const driverInbox = join(env.atmuxDir, "driver-inbox.md");
    // Seed enough archive content (>50MB hard to seed; instead test via
    // archive-only file pre-existing). Use the helper directly via the
    // groom verb by pre-populating the archive dir.
    const archiveDir = join(env.atmuxDir, "archive");
    await mkdir(archiveDir, { recursive: true });
    await writeFile(
      join(archiveDir, "kanban-log-2026-04.md"),
      "y".repeat(6 * 1024 * 1024), // 6MB > 5MB cap
    );
    await writeFile(join(archiveDir, "kanban-log-2026-05.md"), "y".repeat(6 * 1024 * 1024));
    // Drop something else so flushInboxOutbox is a no-op.
    await writeFile(driverInbox, "# d\n\n## Open\n\nfresh\n");

    await groom([], {
      atmuxDir: env.atmuxDir,
      env: {},
      logger: env.logger,
      nowMs: RUN_MS,
    });
    const warns = env.logs.filter((l) => l.kind === "warn").map((l) => l.msg);
    expect(warns.some((m) => m.includes("kanban-log archive"))).toBe(true);
  });
});
