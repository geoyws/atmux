import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { atomicWrite, exists } from "../abstractions/fs.ts";
import { KanbanCliAdapter } from "../adapters/kanban-cli.ts";
import { ConfigError } from "../errors.ts";
import {
  type KanbanBackendMarker,
  readKanbanBackendMarker,
  writeKanbanBackendMarker,
} from "./kanban-backend.ts";

export interface ExternalKanbanCutoverReceipt {
  version: 1;
  status: "prepared";
  preparedAt: string;
  source: string;
  sourceKind: "sqlite" | "json";
  sourceBackup: string;
  sourceSha256: string;
  sourceIntegrity: string;
  boardBackupDirectory: string;
  importReceipt: unknown;
  doctorReceipt: unknown;
  activation: "not-activated";
  rollback: string;
  receiptPath: string;
}

export interface PrepareExternalKanbanOptions {
  actor: string;
  receiptRoot?: string;
  reconcile?: boolean;
  writersStopped?: boolean;
  adapter?: KanbanCliAdapter;
}

export async function prepareExternalKanbanCutover(
  atmuxDir: string,
  options: PrepareExternalKanbanOptions,
): Promise<ExternalKanbanCutoverReceipt> {
  const sqliteSource = resolve(atmuxDir, "state.db");
  const jsonSource = resolve(atmuxDir, "kanban.json");
  const sourceKind = (await exists(sqliteSource)) ? "sqlite" : "json";
  const source = sourceKind === "sqlite" ? sqliteSource : jsonSource;
  if (!(await exists(source))) {
    throw new ConfigError({
      what: `external Kanban prepare: neither ${sqliteSource} nor ${jsonSource} exists`,
    });
  }
  const actor = options.actor.trim();
  if (!actor) throw new ConfigError({ what: "external Kanban prepare: actor is required" });
  if (options.reconcile && !options.writersStopped) {
    throw new ConfigError({
      what: "external Kanban prepare: --reconcile requires stopped writers",
      hint: "stop atmux/orchd writers, then pass --writers-stopped with --reconcile",
    });
  }

  const stamp = new Date().toISOString().replaceAll(":", "-");
  const receiptRoot = resolve(options.receiptRoot ?? join(atmuxDir, "backups", "kanban-cutover"));
  const receiptDirectory = join(receiptRoot, stamp);
  await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
  await chmod(receiptDirectory, 0o700);

  let serialized: Uint8Array;
  let sourceIntegrity: string;
  if (sourceKind === "sqlite") {
    const sourceDatabase = new Database(source, { readonly: true });
    try {
      sourceIntegrity = String(
        (sourceDatabase.query("PRAGMA integrity_check").get() as Record<string, unknown>)
          .integrity_check,
      );
      serialized = sourceDatabase.serialize();
    } finally {
      sourceDatabase.close();
    }
  } else {
    serialized = await readFile(source);
    const parsed = JSON.parse(new TextDecoder().decode(serialized)) as Record<string, unknown>;
    if (!Array.isArray(parsed.tasks)) {
      throw new ConfigError({ what: "external Kanban prepare: kanban.json has no tasks array" });
    }
    sourceIntegrity = "valid-json";
  }
  if (sourceIntegrity !== "ok" && sourceIntegrity !== "valid-json") {
    throw new ConfigError({
      what: `external Kanban prepare: source integrity is ${sourceIntegrity}`,
    });
  }

  const sourceBackup = join(
    receiptDirectory,
    sourceKind === "sqlite" ? "atmux-state.db" : "atmux-kanban.json",
  );
  await writeFile(sourceBackup, serialized, { mode: 0o600 });
  await chmod(sourceBackup, 0o600);
  const sourceSha256 = createHash("sha256").update(serialized).digest("hex");

  const adapter = options.adapter ?? new KanbanCliAdapter();
  await adapter.initialize(atmuxDir);
  const importReceipt =
    sourceKind === "sqlite"
      ? await adapter.importState(atmuxDir, source, actor, options.reconcile === true)
      : await adapter.importJson(atmuxDir, source, actor, options.reconcile === true);
  const doctorReceipt = await adapter.doctor(atmuxDir);
  const boardBackupDirectory = join(receiptDirectory, "kanban-board");
  await adapter.backup(atmuxDir, boardBackupDirectory);
  const receiptPath = join(receiptDirectory, "receipt.json");

  const receipt: ExternalKanbanCutoverReceipt = {
    version: 1,
    status: "prepared",
    preparedAt: new Date().toISOString(),
    source,
    sourceKind,
    sourceBackup,
    sourceSha256,
    sourceIntegrity,
    boardBackupDirectory,
    importReceipt,
    doctorReceipt,
    activation: "not-activated",
    rollback:
      "After activation, run `atmux migrate-kanban rollback --as <actor>` before the first external write. Rollback refuses a changed external board.",
    receiptPath,
  };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  await chmod(receiptPath, 0o600);
  return receipt;
}

export interface ExternalKanbanActivationReceipt {
  version: 1;
  status: "activated";
  activatedAt: string;
  actor: string;
  preparationReceipt: string;
  sourceSha256: string;
  sourceWorkStateFingerprint: string;
  boardFingerprint: string;
  counts: { tasks: number; epics: number; stories: number };
  doctorReceipt: unknown;
  rollback: "allowed-before-first-external-write";
}

export interface ActivateExternalKanbanOptions {
  actor: string;
  preparationReceipt: string;
  writersStopped: boolean;
  adapter?: KanbanCliAdapter;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fileSha256(path: string): Promise<string> {
  return sha256(await readFile(path));
}

function sortedIDs(rows: ReadonlyArray<{ id: string }>): string[] {
  return rows.map((row) => row.id).sort();
}

function assertSameIDs(kind: string, source: string[], external: string[]): void {
  if (JSON.stringify(source) !== JSON.stringify(external)) {
    throw new ConfigError({
      what: `external Kanban activate: ${kind} IDs do not match prepared source`,
      hint: "run `atmux migrate-kanban prepare` again with writers stopped",
    });
  }
}

function boardFingerprint(board: Awaited<ReturnType<KanbanCliAdapter["loadKanban"]>>): string {
  return sha256(
    JSON.stringify({
      tasks: [...board.tasks].sort((a, b) => a.id.localeCompare(b.id)),
      epics: [...board.epics].sort((a, b) => a.id.localeCompare(b.id)),
      stories: [...board.stories].sort((a, b) => a.id.localeCompare(b.id)),
    }),
  );
}

function sortedRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return [...(value as Array<Record<string, unknown>>)].sort((a, b) =>
    String(a.id ?? "").localeCompare(String(b.id ?? "")),
  );
}

async function sourceWorkStateFingerprint(
  source: string,
  sourceKind: "sqlite" | "json",
): Promise<string> {
  if (sourceKind === "json") {
    const parsed = JSON.parse(await readFile(source, "utf8")) as Record<string, unknown>;
    return sha256(
      JSON.stringify({
        tasks: sortedRecords(parsed.tasks),
        epics: sortedRecords(parsed.epics),
        stories: sortedRecords(parsed.stories),
      }),
    );
  }
  const db = new Database(source, { readonly: true });
  try {
    const tables = new Set(
      (
        db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name),
    );
    const rows = (table: "tasks" | "epics" | "stories"): Array<Record<string, unknown>> =>
      tables.has(table)
        ? (db.query(`SELECT * FROM ${table} ORDER BY id`).all() as Array<Record<string, unknown>>)
        : [];
    return sha256(
      JSON.stringify({ tasks: rows("tasks"), epics: rows("epics"), stories: rows("stories") }),
    );
  } finally {
    db.close();
  }
}

export async function activateExternalKanbanCutover(
  atmuxDir: string,
  options: ActivateExternalKanbanOptions,
): Promise<ExternalKanbanActivationReceipt> {
  if (!options.writersStopped) {
    throw new ConfigError({
      what: "external Kanban activate: writers-stopped acknowledgement is required",
      hint: "stop atmux/orchd writers, then pass --writers-stopped",
    });
  }
  const actor = options.actor.trim();
  if (!actor) throw new ConfigError({ what: "external Kanban activate: actor is required" });
  const preparationReceipt = resolve(options.preparationReceipt);
  const prepared = JSON.parse(
    await readFile(preparationReceipt, "utf8"),
  ) as ExternalKanbanCutoverReceipt;
  const sourceKind = prepared.sourceKind ?? "sqlite";
  const source = resolve(atmuxDir, sourceKind === "sqlite" ? "state.db" : "kanban.json");
  if (
    prepared.version !== 1 ||
    prepared.status !== "prepared" ||
    prepared.activation !== "not-activated" ||
    resolve(prepared.source) !== source
  ) {
    throw new ConfigError({ what: "external Kanban activate: invalid preparation receipt" });
  }
  if ((await fileSha256(prepared.sourceBackup)) !== prepared.sourceSha256) {
    throw new ConfigError({ what: "external Kanban activate: source backup hash mismatch" });
  }
  if ((await fileSha256(source)) !== prepared.sourceSha256) {
    throw new ConfigError({
      what: "external Kanban activate: source changed after preparation",
      hint: "keep writers stopped and run `atmux migrate-kanban prepare` again",
    });
  }

  let sourceTasks: string[];
  let sourceEpics: string[];
  let sourceStories: string[];
  if (sourceKind === "sqlite") {
    const sourceDb = new Database(source, { readonly: true });
    try {
      const integrity = String(
        (sourceDb.query("PRAGMA integrity_check").get() as Record<string, unknown>).integrity_check,
      );
      if (integrity !== "ok") {
        throw new ConfigError({
          what: `external Kanban activate: source integrity is ${integrity}`,
        });
      }
      sourceTasks = sortedIDs(
        sourceDb.query("SELECT id FROM tasks").all() as Array<{ id: string }>,
      );
      sourceEpics = sortedIDs(
        sourceDb.query("SELECT id FROM epics").all() as Array<{ id: string }>,
      );
      sourceStories = sortedIDs(
        sourceDb.query("SELECT id FROM stories").all() as Array<{ id: string }>,
      );
    } finally {
      sourceDb.close();
    }
  } else {
    const parsed = JSON.parse(await readFile(source, "utf8")) as {
      tasks?: Array<{ id: string }>;
      epics?: Array<{ id: string }>;
      stories?: Array<{ id: string }>;
    };
    sourceTasks = sortedIDs(parsed.tasks ?? []);
    sourceEpics = sortedIDs(parsed.epics ?? []);
    sourceStories = sortedIDs(parsed.stories ?? []);
  }

  const adapter = options.adapter ?? new KanbanCliAdapter();
  const doctorReceipt = await adapter.doctor(atmuxDir);
  const board = await adapter.loadKanban(atmuxDir);
  assertSameIDs("task", sourceTasks, sortedIDs(board.tasks));
  assertSameIDs("epic", sourceEpics, sortedIDs(board.epics));
  assertSameIDs("story", sourceStories, sortedIDs(board.stories));
  if ((await fileSha256(source)) !== prepared.sourceSha256) {
    throw new ConfigError({ what: "external Kanban activate: source changed during preflight" });
  }

  const activatedAt = new Date().toISOString();
  const receipt: ExternalKanbanActivationReceipt = {
    version: 1,
    status: "activated",
    activatedAt,
    actor,
    preparationReceipt,
    sourceSha256: prepared.sourceSha256,
    sourceWorkStateFingerprint: await sourceWorkStateFingerprint(source, sourceKind),
    boardFingerprint: boardFingerprint(board),
    counts: {
      tasks: board.tasks.length,
      epics: board.epics.length,
      stories: board.stories.length,
    },
    doctorReceipt,
    rollback: "allowed-before-first-external-write",
  };
  const activationPath = join(dirname(preparationReceipt), "activation.json");
  await atomicWrite(activationPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  await chmod(activationPath, 0o600);
  const marker: KanbanBackendMarker = {
    version: 1,
    backend: "external",
    activatedAt,
    actor,
    preparationReceipt,
  };
  await writeKanbanBackendMarker(atmuxDir, marker);
  return receipt;
}

export interface ExternalKanbanObservationReceipt {
  version: 1;
  status: "observed";
  observedAt: string;
  actor: string;
  activationReceipt: string;
  sourceWorkStateFingerprint: string;
  boardFingerprint: string;
  externalWritesObserved: boolean;
  legacyWritesObserved: false;
  doctorReceipt: unknown;
  receiptPath: string;
}

export interface ObserveExternalKanbanOptions {
  actor: string;
  adapter?: KanbanCliAdapter;
}

export async function observeExternalKanbanCutover(
  atmuxDir: string,
  options: ObserveExternalKanbanOptions,
): Promise<ExternalKanbanObservationReceipt> {
  const actor = options.actor.trim();
  if (!actor) throw new ConfigError({ what: "external Kanban observe: actor is required" });
  const marker = await readKanbanBackendMarker(atmuxDir);
  if (marker?.backend !== "external") {
    throw new ConfigError({ what: "external Kanban observe: external backend is not active" });
  }
  const activationReceipt = join(dirname(marker.preparationReceipt), "activation.json");
  const activation = JSON.parse(
    await readFile(activationReceipt, "utf8"),
  ) as ExternalKanbanActivationReceipt;
  if (!activation.sourceWorkStateFingerprint) {
    throw new ConfigError({
      what: "external Kanban observe: activation predates work-state fingerprints",
      hint: "prepare and activate again before beginning the observation window",
    });
  }
  const prepared = JSON.parse(
    await readFile(marker.preparationReceipt, "utf8"),
  ) as ExternalKanbanCutoverReceipt;
  const currentSourceFingerprint = await sourceWorkStateFingerprint(
    prepared.source,
    prepared.sourceKind,
  );
  if (currentSourceFingerprint !== activation.sourceWorkStateFingerprint) {
    throw new ConfigError({
      what: "external Kanban observe: legacy work state changed after activation",
      hint: "a legacy writer is still active; do not delete atmux work-state storage",
    });
  }
  const adapter = options.adapter ?? new KanbanCliAdapter();
  const doctorReceipt = await adapter.doctor(atmuxDir);
  const currentBoardFingerprint = boardFingerprint(await adapter.loadKanban(atmuxDir));
  const observedAt = new Date().toISOString();
  const receiptPath = join(
    dirname(marker.preparationReceipt),
    `observation-${observedAt.replaceAll(":", "-")}.json`,
  );
  const receipt: ExternalKanbanObservationReceipt = {
    version: 1,
    status: "observed",
    observedAt,
    actor,
    activationReceipt,
    sourceWorkStateFingerprint: currentSourceFingerprint,
    boardFingerprint: currentBoardFingerprint,
    externalWritesObserved: currentBoardFingerprint !== activation.boardFingerprint,
    legacyWritesObserved: false,
    doctorReceipt,
    receiptPath,
  };
  await atomicWrite(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  await chmod(receiptPath, 0o600);
  return receipt;
}

export interface RollbackExternalKanbanOptions {
  actor: string;
  writersStopped: boolean;
  adapter?: KanbanCliAdapter;
}

export async function rollbackExternalKanbanCutover(
  atmuxDir: string,
  options: RollbackExternalKanbanOptions,
): Promise<KanbanBackendMarker> {
  if (!options.writersStopped) {
    throw new ConfigError({
      what: "external Kanban rollback: writers-stopped acknowledgement is required",
    });
  }
  const actor = options.actor.trim();
  if (!actor) throw new ConfigError({ what: "external Kanban rollback: actor is required" });
  const marker = await readKanbanBackendMarker(atmuxDir);
  if (marker?.backend !== "external") {
    throw new ConfigError({ what: "external Kanban rollback: external backend is not active" });
  }
  const activation = JSON.parse(
    await readFile(join(dirname(marker.preparationReceipt), "activation.json"), "utf8"),
  ) as ExternalKanbanActivationReceipt;
  const adapter = options.adapter ?? new KanbanCliAdapter();
  const currentFingerprint = boardFingerprint(await adapter.loadKanban(atmuxDir));
  if (currentFingerprint !== activation.boardFingerprint) {
    throw new ConfigError({
      what: "external Kanban rollback refused: external board changed after activation",
      hint: "continue forward; an automatic rollback would discard durable work",
    });
  }
  const rolledBack: KanbanBackendMarker = {
    version: 1,
    backend: "legacy",
    activatedAt: new Date().toISOString(),
    actor,
    preparationReceipt: marker.preparationReceipt,
  };
  await writeKanbanBackendMarker(atmuxDir, rolledBack);
  return rolledBack;
}
