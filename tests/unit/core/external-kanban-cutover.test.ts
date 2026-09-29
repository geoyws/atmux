// Unit tests for src/core/external-kanban-cutover.ts (row t-981f2f3f slice 1,
// ADR-254 D3: 100% line coverage on tracked paths, no allowlist).
//
// Strategy: per-test mkdtemp atmux dir, real bun:sqlite / kanban.json sources,
// and a stub KanbanCliAdapter injected via the module's own `adapter` seam
// (cast through unknown — the stub implements only the six methods the
// cutover calls). No live cockpit, no `kanban` binary, no tmux.
// Error assertions use a configError() helper that fails on resolve and
// requires ConfigError, so each throw-path test fails if the guard is removed.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { KanbanCliAdapter } from "../../../src/adapters/kanban-cli.ts";
import {
  activateExternalKanbanCutover,
  type ExternalKanbanCutoverReceipt,
  observeExternalKanbanCutover,
  prepareExternalKanbanCutover,
  rollbackExternalKanbanCutover,
} from "../../../src/core/external-kanban-cutover.ts";
import {
  readKanbanBackendMarker,
  writeKanbanBackendMarker,
} from "../../../src/core/kanban-backend.ts";
import { ConfigError } from "../../../src/errors.ts";

const TASKS = ["t-aaaa1111", "t-bbbb2222"];
const EPICS = ["e-cccc3333", "e-dddd4444"];
const STORIES = ["s-eeee5555", "s-ffff6666"];

type Board = {
  tasks: Array<Record<string, unknown>>;
  epics: Array<Record<string, unknown>>;
  stories: Array<Record<string, unknown>>;
};

function boardFor(
  tasks: string[] = TASKS,
  epics: string[] = EPICS,
  stories: string[] = STORIES,
  subject = "subject",
): Board {
  return {
    tasks: tasks.map((id) => ({ id, subject: `${subject}-${id}`, status: "todo" })),
    epics: epics.map((id) => ({ id, title: `${subject}-${id}` })),
    stories: stories.map((id) => ({ id, title: `${subject}-${id}` })),
  };
}

interface FakeCalls {
  initialize: number;
  importStateReconcile: boolean[];
  importJsonReconcile: boolean[];
  doctor: number;
  backups: string[];
  loadKanban: number;
}

function makeFake(
  board: Board,
  onLoadKanban?: () => void | Promise<void>,
): {
  adapter: KanbanCliAdapter;
  calls: FakeCalls;
} {
  const calls: FakeCalls = {
    initialize: 0,
    importStateReconcile: [],
    importJsonReconcile: [],
    doctor: 0,
    backups: [],
    loadKanban: 0,
  };
  const adapter = {
    initialize: async () => {
      calls.initialize += 1;
    },
    importState: async (_dir: string, _db: string, _actor: string, reconcile: boolean) => {
      calls.importStateReconcile.push(reconcile);
      return { imported: "sqlite", reconcile };
    },
    importJson: async (_dir: string, _json: string, _actor: string, reconcile: boolean) => {
      calls.importJsonReconcile.push(reconcile);
      return { imported: "json", reconcile };
    },
    doctor: async () => {
      calls.doctor += 1;
      return { ok: true };
    },
    backup: async (_dir: string, outputDirectory: string) => {
      calls.backups.push(outputDirectory);
      await mkdir(outputDirectory, { recursive: true });
      return { backedUp: true };
    },
    loadKanban: async () => {
      calls.loadKanban += 1;
      await onLoadKanban?.();
      return board;
    },
  } as unknown as KanbanCliAdapter;
  return { adapter, calls };
}

const scratchDirs: string[] = [];

afterEach(async () => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function makeAtmuxDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "atmux-cutover-"));
  scratchDirs.push(dir);
  return dir;
}

function seedSqlite(
  path: string,
  tasks: string[] = TASKS,
  epics: string[] = EPICS,
  stories: string[] = STORIES,
): void {
  const db = new Database(path);
  try {
    db.exec(
      "CREATE TABLE tasks (id TEXT PRIMARY KEY); CREATE TABLE epics (id TEXT PRIMARY KEY); CREATE TABLE stories (id TEXT PRIMARY KEY);",
    );
    for (const id of tasks) db.prepare("INSERT INTO tasks (id) VALUES (?)").run(id);
    for (const id of epics) db.prepare("INSERT INTO epics (id) VALUES (?)").run(id);
    for (const id of stories) db.prepare("INSERT INTO stories (id) VALUES (?)").run(id);
  } finally {
    db.close();
  }
}

async function seedJson(
  atmuxDir: string,
  tasks: string[] = TASKS,
  epics: string[] = EPICS,
  stories: string[] = STORIES,
): Promise<string> {
  const path = join(atmuxDir, "kanban.json");
  await writeFile(
    path,
    JSON.stringify({
      tasks: tasks.map((id) => ({ id, subject: `seed-${id}` })),
      epics: epics.map((id) => ({ id, title: `seed-${id}` })),
      stories: stories.map((id) => ({ id, title: `seed-${id}` })),
    }),
  );
  return path;
}

async function shaFile(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

/** Rejects unless the promise throws ConfigError; returns the message. */
async function configError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error("expected ConfigError but the call succeeded");
}

/** Craft a valid preparation receipt for an already-on-disk source+backup pair. */
async function craftReceipt(
  atmuxDir: string,
  source: string,
  sourceKind: "sqlite" | "json",
  backup: string,
  receiptName = "receipt.json",
): Promise<string> {
  const sourceSha256 = await shaFile(source);
  const receiptPath = join(atmuxDir, receiptName);
  const receipt: ExternalKanbanCutoverReceipt = {
    version: 1,
    status: "prepared",
    preparedAt: "2026-09-29T00:00:00.000Z",
    source,
    sourceKind,
    sourceBackup: backup,
    sourceSha256,
    sourceIntegrity: sourceKind === "sqlite" ? "ok" : "valid-json",
    boardBackupDirectory: join(atmuxDir, "board-backup"),
    importReceipt: { imported: sourceKind },
    doctorReceipt: { ok: true },
    activation: "not-activated",
    rollback: "crafted receipt for tests",
    receiptPath,
  };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return receiptPath;
}

async function copyFile(from: string, to: string): Promise<void> {
  await writeFile(to, await readFile(from));
}

/** Point an external marker + activation at a crafted receipt with a wrong
 *  fingerprint, so observe/rollback exercise their read paths before failing. */
async function stageActiveWithStaleActivation(
  atmuxDir: string,
  receiptPath: string,
): Promise<string> {
  await writeKanbanBackendMarker(atmuxDir, {
    version: 1,
    backend: "external",
    activatedAt: "2026-09-29T00:00:00.000Z",
    actor: "codex/driver",
    preparationReceipt: receiptPath,
  });
  const activationPath = join(dirname(receiptPath), "activation.json");
  await writeFile(
    activationPath,
    JSON.stringify({
      version: 1,
      status: "activated",
      activatedAt: "2026-09-29T00:00:00.000Z",
      actor: "codex/driver",
      preparationReceipt: receiptPath,
      sourceSha256: "stale",
      sourceWorkStateFingerprint: "stale-fingerprint",
      boardFingerprint: "stale-board",
      counts: { tasks: 0, epics: 0, stories: 0 },
      doctorReceipt: {},
      rollback: "allowed-before-first-external-write",
    }),
  );
  return activationPath;
}

// ---------- prepare ----------

describe("prepareExternalKanbanCutover", () => {
  test("prepares from sqlite (preferred when both sources exist), threading reconcile", async () => {
    const atmuxDir = await makeAtmuxDir();
    seedSqlite(join(atmuxDir, "state.db"));
    await seedJson(atmuxDir);
    const { adapter, calls } = makeFake(boardFor());

    const receipt = await prepareExternalKanbanCutover(atmuxDir, {
      actor: "codex/driver",
      reconcile: true,
      writersStopped: true,
      adapter,
    });

    expect(receipt.version).toBe(1);
    expect(receipt.status).toBe("prepared");
    expect(receipt.sourceKind).toBe("sqlite");
    expect(receipt.source).toBe(join(atmuxDir, "state.db"));
    expect(receipt.sourceIntegrity).toBe("ok");
    expect(receipt.sourceSha256).toBe(await shaFile(join(atmuxDir, "state.db")));
    expect(receipt.sourceSha256).toBe(await shaFile(receipt.sourceBackup));
    expect(receipt.activation).toBe("not-activated");
    expect(calls.initialize).toBe(1);
    expect(calls.importStateReconcile).toEqual([true]);
    expect(calls.importJsonReconcile).toEqual([]);
    expect(calls.doctor).toBe(1);
    expect(calls.backups).toEqual([receipt.boardBackupDirectory]);
    expect(await readFile(receipt.receiptPath, "utf8")).toContain('"status": "prepared"');
  });

  test("prepares from json with a custom receipt root without reconcile", async () => {
    const atmuxDir = await makeAtmuxDir();
    await seedJson(atmuxDir);
    const { adapter, calls } = makeFake(boardFor());

    const receipt = await prepareExternalKanbanCutover(atmuxDir, {
      actor: "codex/driver",
      receiptRoot: join(atmuxDir, "custom-root"),
      adapter,
    });

    expect(receipt.sourceKind).toBe("json");
    expect(receipt.sourceIntegrity).toBe("valid-json");
    expect(receipt.sourceSha256).toBe(await shaFile(join(atmuxDir, "kanban.json")));
    expect(receipt.receiptPath).toContain(join(atmuxDir, "custom-root"));
    expect(calls.importJsonReconcile).toEqual([false]);
    expect(calls.importStateReconcile).toEqual([]);
  });

  test("uses the default backups receipt root when none is given", async () => {
    const atmuxDir = await makeAtmuxDir();
    await seedJson(atmuxDir);
    const { adapter } = makeFake(boardFor());

    const receipt = await prepareExternalKanbanCutover(atmuxDir, {
      actor: "codex/driver",
      adapter,
    });

    expect(receipt.receiptPath).toContain(join(atmuxDir, "backups", "kanban-cutover"));
  });

  test("refuses when neither state.db nor kanban.json exists", async () => {
    const atmuxDir = await makeAtmuxDir();
    const { adapter } = makeFake(boardFor());

    const message = await configError(
      prepareExternalKanbanCutover(atmuxDir, { actor: "codex/driver", adapter }),
    );
    expect(message).toContain("neither");
  });

  test("requires a non-blank actor", async () => {
    const atmuxDir = await makeAtmuxDir();
    await seedJson(atmuxDir);
    const { adapter } = makeFake(boardFor());

    const message = await configError(
      prepareExternalKanbanCutover(atmuxDir, { actor: "   ", adapter }),
    );
    expect(message).toContain("actor is required");
  });

  test("requires stopped writers for reconcile", async () => {
    const atmuxDir = await makeAtmuxDir();
    await seedJson(atmuxDir);
    const { adapter } = makeFake(boardFor());

    const message = await configError(
      prepareExternalKanbanCutover(atmuxDir, {
        actor: "codex/driver",
        reconcile: true,
        adapter,
      }),
    );
    expect(message).toContain("--reconcile requires stopped writers");
  });

  test("rejects a kanban.json without a tasks array", async () => {
    const atmuxDir = await makeAtmuxDir();
    await writeFile(join(atmuxDir, "kanban.json"), JSON.stringify({ epics: [] }));
    const { adapter } = makeFake(boardFor());

    const message = await configError(
      prepareExternalKanbanCutover(atmuxDir, { actor: "codex/driver", adapter }),
    );
    expect(message).toContain("no tasks array");
  });

  test("refuses a corrupt sqlite source via the integrity seam", async () => {
    const atmuxDir = await makeAtmuxDir();
    seedSqlite(join(atmuxDir, "state.db"));
    const { adapter } = makeFake(boardFor());

    const message = await configError(
      prepareExternalKanbanCutover(atmuxDir, {
        actor: "codex/driver",
        adapter,
        integrityCheck: () => "corrupt-page",
      }),
    );
    expect(message).toContain("source integrity is corrupt-page");
  });

  test("falls back to the real adapter when none is injected", async () => {
    const atmuxDir = await makeAtmuxDir();
    seedSqlite(join(atmuxDir, "state.db"));

    // No `kanban` binary on PATH, so adapter.initialize() rejects.
    await expect(prepareExternalKanbanCutover(atmuxDir, { actor: "codex/driver" })).rejects.toThrow(
      "kanban",
    );
  });
});

// ---------- activate ----------

describe("activateExternalKanbanCutover", () => {
  async function chainedSqlite(): Promise<{
    atmuxDir: string;
    receiptPath: string;
    calls: FakeCalls;
    board: Board;
  }> {
    const atmuxDir = await makeAtmuxDir();
    seedSqlite(join(atmuxDir, "state.db"));
    const board = boardFor();
    const { adapter, calls } = makeFake(board);
    const receipt = await prepareExternalKanbanCutover(atmuxDir, {
      actor: "codex/driver",
      adapter,
    });
    return { atmuxDir, receiptPath: receipt.receiptPath, calls, board };
  }

  test("activates a prepared sqlite source end to end", async () => {
    const { atmuxDir, receiptPath } = await chainedSqlite();
    const { adapter } = makeFake(boardFor());

    const activation = await activateExternalKanbanCutover(atmuxDir, {
      actor: "codex/driver",
      preparationReceipt: receiptPath,
      writersStopped: true,
      adapter,
    });

    expect(activation.version).toBe(1);
    expect(activation.status).toBe("activated");
    expect(activation.actor).toBe("codex/driver");
    expect(activation.counts).toEqual({ tasks: 2, epics: 2, stories: 2 });
    expect(activation.sourceWorkStateFingerprint).not.toBe("");
    expect(activation.boardFingerprint).not.toBe("");
    expect(activation.rollback).toBe("allowed-before-first-external-write");
    const marker = await readKanbanBackendMarker(atmuxDir);
    expect(marker?.backend).toBe("external");
    expect(marker?.actor).toBe("codex/driver");
    expect(marker?.preparationReceipt).toBe(receiptPath);
    expect(await readFile(join(dirname(receiptPath), "activation.json"), "utf8")).toContain(
      '"status": "activated"',
    );
  });

  test("activates a prepared json source", async () => {
    const atmuxDir = await makeAtmuxDir();
    await seedJson(atmuxDir);
    const prepared = makeFake(boardFor());
    const receipt = await prepareExternalKanbanCutover(atmuxDir, {
      actor: "codex/driver",
      adapter: prepared.adapter,
    });
    const { adapter } = makeFake(boardFor());

    const activation = await activateExternalKanbanCutover(atmuxDir, {
      actor: "codex/driver",
      preparationReceipt: receipt.receiptPath,
      writersStopped: true,
      adapter,
    });

    expect(activation.counts).toEqual({ tasks: 2, epics: 2, stories: 2 });
    expect((await readKanbanBackendMarker(atmuxDir))?.backend).toBe("external");
  });

  test("activates an empty json board (missing keys default to empty)", async () => {
    const atmuxDir = await makeAtmuxDir();
    const source = join(atmuxDir, "kanban.json");
    await writeFile(source, JSON.stringify({}));
    const backup = join(atmuxDir, "backup.json");
    await copyFile(source, backup);
    const receiptPath = await craftReceipt(atmuxDir, source, "json", backup);
    const { adapter } = makeFake(boardFor([], [], []));

    const activation = await activateExternalKanbanCutover(atmuxDir, {
      actor: "codex/driver",
      preparationReceipt: receiptPath,
      writersStopped: true,
      adapter,
    });

    expect(activation.counts).toEqual({ tasks: 0, epics: 0, stories: 0 });
  });

  test("requires the writers-stopped acknowledgement", async () => {
    const { atmuxDir, receiptPath } = await chainedSqlite();
    const { adapter } = makeFake(boardFor());

    const message = await configError(
      activateExternalKanbanCutover(atmuxDir, {
        actor: "codex/driver",
        preparationReceipt: receiptPath,
        writersStopped: false,
        adapter,
      }),
    );
    expect(message).toContain("writers-stopped acknowledgement is required");
  });

  test("requires a non-blank actor", async () => {
    const { atmuxDir, receiptPath } = await chainedSqlite();
    const { adapter } = makeFake(boardFor());

    const message = await configError(
      activateExternalKanbanCutover(atmuxDir, {
        actor: "  ",
        preparationReceipt: receiptPath,
        writersStopped: true,
        adapter,
      }),
    );
    expect(message).toContain("actor is required");
  });

  test("rejects invalid preparation receipts", async () => {
    const { atmuxDir, receiptPath } = await chainedSqlite();
    const { adapter } = makeFake(boardFor());
    const prepared = JSON.parse(
      await readFile(receiptPath, "utf8"),
    ) as ExternalKanbanCutoverReceipt;

    const cases: Array<{ name: string; mutate: (r: Record<string, unknown>) => void }> = [
      {
        name: "version",
        mutate: (r) => {
          r.version = 2;
        },
      },
      {
        name: "status",
        mutate: (r) => {
          r.status = "activated";
        },
      },
      {
        name: "activation",
        mutate: (r) => {
          r.activation = "activated";
        },
      },
      {
        name: "source",
        mutate: (r) => {
          r.source = join(atmuxDir, "elsewhere.db");
        },
      },
    ];
    for (const { name, mutate } of cases) {
      const raw = { ...prepared } as unknown as Record<string, unknown>;
      mutate(raw);
      const bad = join(atmuxDir, `bad-${name}.json`);
      await writeFile(bad, JSON.stringify(raw));
      const message = await configError(
        activateExternalKanbanCutover(atmuxDir, {
          actor: "codex/driver",
          preparationReceipt: bad,
          writersStopped: true,
          adapter,
        }),
      );
      expect(message).toContain("invalid preparation receipt");
    }
  });

  test("defaults a receipt without sourceKind to sqlite", async () => {
    const { atmuxDir, receiptPath } = await chainedSqlite();
    const { adapter } = makeFake(boardFor());
    const raw = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
    delete raw.sourceKind;
    const legacy = join(atmuxDir, "legacy-receipt.json");
    await writeFile(legacy, JSON.stringify(raw));

    const activation = await activateExternalKanbanCutover(atmuxDir, {
      actor: "codex/driver",
      preparationReceipt: legacy,
      writersStopped: true,
      adapter,
    });

    expect(activation.status).toBe("activated");
  });

  test("refuses when the source backup was tampered with", async () => {
    const { atmuxDir, receiptPath } = await chainedSqlite();
    const { adapter } = makeFake(boardFor());
    const prepared = JSON.parse(
      await readFile(receiptPath, "utf8"),
    ) as ExternalKanbanCutoverReceipt;
    await writeFile(prepared.sourceBackup, "tampered");

    const message = await configError(
      activateExternalKanbanCutover(atmuxDir, {
        actor: "codex/driver",
        preparationReceipt: receiptPath,
        writersStopped: true,
        adapter,
      }),
    );
    expect(message).toContain("source backup hash mismatch");
  });

  test("refuses when the source changed after preparation", async () => {
    const atmuxDir = await makeAtmuxDir();
    const source = await seedJson(atmuxDir);
    const backup = join(atmuxDir, "backup.json");
    await copyFile(source, backup);
    const receiptPath = await craftReceipt(atmuxDir, source, "json", backup);
    const { adapter } = makeFake(boardFor());
    await writeFile(
      source,
      JSON.stringify({
        tasks: [...TASKS, "t-new99999"].map((id) => ({ id })),
        epics: EPICS.map((id) => ({ id })),
        stories: STORIES.map((id) => ({ id })),
      }),
    );

    const message = await configError(
      activateExternalKanbanCutover(atmuxDir, {
        actor: "codex/driver",
        preparationReceipt: receiptPath,
        writersStopped: true,
        adapter,
      }),
    );
    expect(message).toContain("source changed after preparation");
  });

  test("refuses a corrupt sqlite source via the integrity seam", async () => {
    const { atmuxDir, receiptPath } = await chainedSqlite();
    const { adapter } = makeFake(boardFor());

    const message = await configError(
      activateExternalKanbanCutover(atmuxDir, {
        actor: "codex/driver",
        preparationReceipt: receiptPath,
        writersStopped: true,
        adapter,
        integrityCheck: () => "bad-page",
      }),
    );
    expect(message).toContain("source integrity is bad-page");
  });

  test("refuses when external board IDs diverge from the source", async () => {
    const kinds: Array<{
      kind: string;
      board: Board;
    }> = [
      { kind: "task", board: boardFor(["t-aaaa1111", "t-other000"]) },
      { kind: "epic", board: boardFor(TASKS, ["e-cccc3333", "e-other000"]) },
      { kind: "story", board: boardFor(TASKS, EPICS, ["s-eeee5555", "s-other000"]) },
    ];
    for (const { kind, board } of kinds) {
      const atmuxDir = await makeAtmuxDir();
      await seedJson(atmuxDir);
      const prepared = makeFake(boardFor());
      const receipt = await prepareExternalKanbanCutover(atmuxDir, {
        actor: "codex/driver",
        adapter: prepared.adapter,
      });
      const { adapter } = makeFake(board);
      const message = await configError(
        activateExternalKanbanCutover(atmuxDir, {
          actor: "codex/driver",
          preparationReceipt: receipt.receiptPath,
          writersStopped: true,
          adapter,
        }),
      );
      expect(message).toContain(`${kind} IDs do not match`);
    }
  });

  test("refuses when the source changes during preflight", async () => {
    const atmuxDir = await makeAtmuxDir();
    const source = await seedJson(atmuxDir);
    const prepared = makeFake(boardFor());
    const receipt = await prepareExternalKanbanCutover(atmuxDir, {
      actor: "codex/driver",
      adapter: prepared.adapter,
    });
    // A writer that slips in while the board is loading invalidates preflight.
    const { adapter } = makeFake(boardFor(), async () => {
      await writeFile(source, `${await readFile(source, "utf8")}\n`);
    });

    const message = await configError(
      activateExternalKanbanCutover(atmuxDir, {
        actor: "codex/driver",
        preparationReceipt: receipt.receiptPath,
        writersStopped: true,
        adapter,
      }),
    );
    expect(message).toContain("source changed during preflight");
  });

  test("falls back to the real adapter when none is injected", async () => {
    const { atmuxDir, receiptPath } = await chainedSqlite();

    await expect(
      activateExternalKanbanCutover(atmuxDir, {
        actor: "codex/driver",
        preparationReceipt: receiptPath,
        writersStopped: true,
      }),
    ).rejects.toThrow("kanban");
  });
});

// ---------- observe ----------

describe("observeExternalKanbanCutover", () => {
  async function chainedActive(board: Board = boardFor()): Promise<{
    atmuxDir: string;
    receiptPath: string;
  }> {
    const atmuxDir = await makeAtmuxDir();
    await seedJson(atmuxDir);
    const prepared = makeFake(board);
    const receipt = await prepareExternalKanbanCutover(atmuxDir, {
      actor: "codex/driver",
      adapter: prepared.adapter,
    });
    const activating = makeFake(board);
    await activateExternalKanbanCutover(atmuxDir, {
      actor: "codex/driver",
      preparationReceipt: receipt.receiptPath,
      writersStopped: true,
      adapter: activating.adapter,
    });
    return { atmuxDir, receiptPath: receipt.receiptPath };
  }

  test("observes a quiet board with no external or legacy writes", async () => {
    const { atmuxDir } = await chainedActive();
    const { adapter } = makeFake(boardFor());

    const observation = await observeExternalKanbanCutover(atmuxDir, {
      actor: "codex/driver",
      adapter,
    });

    expect(observation.version).toBe(1);
    expect(observation.status).toBe("observed");
    expect(observation.actor).toBe("codex/driver");
    expect(observation.externalWritesObserved).toBe(false);
    expect(observation.legacyWritesObserved).toBe(false);
    expect(observation.receiptPath).toContain("observation-");
    expect(await readFile(observation.receiptPath, "utf8")).toContain('"status": "observed"');
  });

  test("reports external writes when the board moved after activation", async () => {
    const { atmuxDir } = await chainedActive();
    const moved = boardFor(TASKS, EPICS, STORIES, "changed-subject");
    const { adapter } = makeFake(moved);

    const observation = await observeExternalKanbanCutover(atmuxDir, {
      actor: "codex/driver",
      adapter,
    });

    expect(observation.externalWritesObserved).toBe(true);
    expect(observation.legacyWritesObserved).toBe(false);
  });

  test("requires a non-blank actor", async () => {
    const { atmuxDir } = await chainedActive();
    const { adapter } = makeFake(boardFor());

    const message = await configError(
      observeExternalKanbanCutover(atmuxDir, { actor: " ", adapter }),
    );
    expect(message).toContain("actor is required");
  });

  test("refuses when the external backend is not active", async () => {
    const missing = await makeAtmuxDir();
    const { adapter: missingAdapter } = makeFake(boardFor());
    const missingMessage = await configError(
      observeExternalKanbanCutover(missing, { actor: "codex/driver", adapter: missingAdapter }),
    );
    expect(missingMessage).toContain("external backend is not active");

    const legacy = await makeAtmuxDir();
    await seedJson(legacy);
    const legacyReceipt = await craftReceipt(
      legacy,
      join(legacy, "kanban.json"),
      "json",
      join(legacy, "backup.json"),
    );
    await mkdir(join(legacy, "state"), { recursive: true });
    await writeKanbanBackendMarker(legacy, {
      version: 1,
      backend: "legacy",
      activatedAt: new Date().toISOString(),
      actor: "codex/driver",
      preparationReceipt: legacyReceipt,
    });
    const { adapter: legacyAdapter } = makeFake(boardFor());
    const legacyMessage = await configError(
      observeExternalKanbanCutover(legacy, { actor: "codex/driver", adapter: legacyAdapter }),
    );
    expect(legacyMessage).toContain("external backend is not active");
  });

  test("refuses an activation that predates work-state fingerprints", async () => {
    const { atmuxDir, receiptPath } = await chainedActive();
    const activationPath = join(dirname(receiptPath), "activation.json");
    const activation = JSON.parse(await readFile(activationPath, "utf8")) as Record<
      string,
      unknown
    >;
    delete activation.sourceWorkStateFingerprint;
    await writeFile(activationPath, JSON.stringify(activation));
    const { adapter } = makeFake(boardFor());

    const message = await configError(
      observeExternalKanbanCutover(atmuxDir, { actor: "codex/driver", adapter }),
    );
    expect(message).toContain("predates work-state fingerprints");
  });

  test("refuses when legacy work state changed after activation", async () => {
    const { atmuxDir } = await chainedActive();
    await writeFile(
      join(atmuxDir, "kanban.json"),
      JSON.stringify({
        tasks: [...TASKS, "t-sneaky000"].map((id) => ({ id })),
        epics: EPICS.map((id) => ({ id })),
        stories: STORIES.map((id) => ({ id })),
      }),
    );
    const { adapter } = makeFake(boardFor());

    const message = await configError(
      observeExternalKanbanCutover(atmuxDir, { actor: "codex/driver", adapter }),
    );
    expect(message).toContain("legacy work state changed after activation");
  });

  test("reads a sqlite source missing tables when checking legacy drift", async () => {
    // Exercises sourceWorkStateFingerprint's missing-table (`[]`) branch:
    // only the tasks table exists, so epics/stories fingerprint as empty.
    const atmuxDir = await makeAtmuxDir();
    const db = new Database(join(atmuxDir, "state.db"));
    try {
      db.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, note TEXT);");
      db.prepare("INSERT INTO tasks (id, note) VALUES (?, ?)").run("t-aaaa1111", "n");
    } finally {
      db.close();
    }
    const backup = join(atmuxDir, "backup.db");
    await copyFile(join(atmuxDir, "state.db"), backup);
    const receiptPath = await craftReceipt(atmuxDir, join(atmuxDir, "state.db"), "sqlite", backup);
    await stageActiveWithStaleActivation(atmuxDir, receiptPath);
    const { adapter } = makeFake(boardFor());

    const message = await configError(
      observeExternalKanbanCutover(atmuxDir, { actor: "codex/driver", adapter }),
    );
    expect(message).toContain("legacy work state changed after activation");
  });

  test("reads odd-shaped json when checking legacy drift", async () => {
    // Exercises sortedRecords' non-array and missing-id branches: one task
    // has no id, epics is not an array, stories is absent.
    const atmuxDir = await makeAtmuxDir();
    const source = join(atmuxDir, "kanban.json");
    await writeFile(
      source,
      JSON.stringify({
        tasks: [{ id: "t-aaaa1111" }, { orphan: true }],
        epics: "not-an-array",
      }),
    );
    const backup = join(atmuxDir, "backup.json");
    await copyFile(source, backup);
    const receiptPath = await craftReceipt(atmuxDir, source, "json", backup);
    await stageActiveWithStaleActivation(atmuxDir, receiptPath);
    const { adapter } = makeFake(boardFor());

    const message = await configError(
      observeExternalKanbanCutover(atmuxDir, { actor: "codex/driver", adapter }),
    );
    expect(message).toContain("legacy work state changed after activation");
  });

  test("falls back to the real adapter when none is injected", async () => {
    const { atmuxDir } = await chainedActive();

    await expect(observeExternalKanbanCutover(atmuxDir, { actor: "codex/driver" })).rejects.toThrow(
      "kanban",
    );
  });
});

// ---------- rollback ----------

describe("rollbackExternalKanbanCutover", () => {
  async function chainedActive(board: Board = boardFor()): Promise<{
    atmuxDir: string;
    receiptPath: string;
  }> {
    const atmuxDir = await makeAtmuxDir();
    await seedJson(atmuxDir);
    const prepared = makeFake(board);
    const receipt = await prepareExternalKanbanCutover(atmuxDir, {
      actor: "codex/driver",
      adapter: prepared.adapter,
    });
    const activating = makeFake(board);
    await activateExternalKanbanCutover(atmuxDir, {
      actor: "codex/driver",
      preparationReceipt: receipt.receiptPath,
      writersStopped: true,
      adapter: activating.adapter,
    });
    return { atmuxDir, receiptPath: receipt.receiptPath };
  }

  test("rolls back to legacy when the external board is unchanged", async () => {
    const { atmuxDir, receiptPath } = await chainedActive();
    const { adapter } = makeFake(boardFor());

    const marker = await rollbackExternalKanbanCutover(atmuxDir, {
      actor: "codex/driver",
      writersStopped: true,
      adapter,
    });

    expect(marker.backend).toBe("legacy");
    expect(marker.actor).toBe("codex/driver");
    expect(marker.preparationReceipt).toBe(receiptPath);
    expect((await readKanbanBackendMarker(atmuxDir))?.backend).toBe("legacy");
  });

  test("requires the writers-stopped acknowledgement", async () => {
    const { atmuxDir } = await chainedActive();
    const { adapter } = makeFake(boardFor());

    const message = await configError(
      rollbackExternalKanbanCutover(atmuxDir, {
        actor: "codex/driver",
        writersStopped: false,
        adapter,
      }),
    );
    expect(message).toContain("writers-stopped acknowledgement is required");
  });

  test("requires a non-blank actor", async () => {
    const { atmuxDir } = await chainedActive();
    const { adapter } = makeFake(boardFor());

    const message = await configError(
      rollbackExternalKanbanCutover(atmuxDir, {
        actor: "   ",
        writersStopped: true,
        adapter,
      }),
    );
    expect(message).toContain("actor is required");
  });

  test("refuses when the external backend is not active", async () => {
    const missing = await makeAtmuxDir();
    const { adapter: missingAdapter } = makeFake(boardFor());
    const missingMessage = await configError(
      rollbackExternalKanbanCutover(missing, {
        actor: "codex/driver",
        writersStopped: true,
        adapter: missingAdapter,
      }),
    );
    expect(missingMessage).toContain("external backend is not active");

    const { atmuxDir } = await chainedActive();
    const rolledBack = makeFake(boardFor());
    await rollbackExternalKanbanCutover(atmuxDir, {
      actor: "codex/driver",
      writersStopped: true,
      adapter: rolledBack.adapter,
    });
    const { adapter: legacyAdapter } = makeFake(boardFor());
    const legacyMessage = await configError(
      rollbackExternalKanbanCutover(atmuxDir, {
        actor: "codex/driver",
        writersStopped: true,
        adapter: legacyAdapter,
      }),
    );
    expect(legacyMessage).toContain("external backend is not active");
  });

  test("refuses rollback after the external board changed", async () => {
    const { atmuxDir } = await chainedActive();
    const moved = boardFor(TASKS, EPICS, STORIES, "post-activation-write");
    const { adapter } = makeFake(moved);

    const message = await configError(
      rollbackExternalKanbanCutover(atmuxDir, {
        actor: "codex/driver",
        writersStopped: true,
        adapter,
      }),
    );
    expect(message).toContain("rollback refused: external board changed after activation");
    expect((await readKanbanBackendMarker(atmuxDir))?.backend).toBe("external");
  });

  test("falls back to the real adapter when none is injected", async () => {
    const { atmuxDir } = await chainedActive();

    await expect(
      rollbackExternalKanbanCutover(atmuxDir, {
        actor: "codex/driver",
        writersStopped: true,
      }),
    ).rejects.toThrow("kanban");
  });
});
