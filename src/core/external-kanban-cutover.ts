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
  adapter?: KanbanCliAdapter;
}

export async function prepareExternalKanbanCutover(
  atmuxDir: string,
  options: PrepareExternalKanbanOptions,
): Promise<ExternalKanbanCutoverReceipt> {
  const source = resolve(atmuxDir, "state.db");
  if (!(await exists(source))) {
    throw new ConfigError({ what: `external Kanban prepare: ${source} does not exist` });
  }
  const actor = options.actor.trim();
  if (!actor) throw new ConfigError({ what: "external Kanban prepare: actor is required" });

  const stamp = new Date().toISOString().replaceAll(":", "-");
  const receiptRoot = resolve(options.receiptRoot ?? join(atmuxDir, "backups", "kanban-cutover"));
  const receiptDirectory = join(receiptRoot, stamp);
  await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
  await chmod(receiptDirectory, 0o700);

  const sourceDatabase = new Database(source, { readonly: true });
  let serialized: Uint8Array;
  let sourceIntegrity: string;
  try {
    sourceIntegrity = String(
      (sourceDatabase.query("PRAGMA integrity_check").get() as Record<string, unknown>)
        .integrity_check,
    );
    serialized = sourceDatabase.serialize();
  } finally {
    sourceDatabase.close();
  }
  if (sourceIntegrity !== "ok") {
    throw new ConfigError({
      what: `external Kanban prepare: source integrity is ${sourceIntegrity}`,
    });
  }

  const sourceBackup = join(receiptDirectory, "atmux-state.db");
  await writeFile(sourceBackup, serialized, { mode: 0o600 });
  await chmod(sourceBackup, 0o600);
  const sourceSha256 = createHash("sha256").update(serialized).digest("hex");

  const adapter = options.adapter ?? new KanbanCliAdapter();
  await adapter.initialize(atmuxDir);
  const importReceipt = await adapter.importState(atmuxDir, source, actor);
  const doctorReceipt = await adapter.doctor(atmuxDir);
  const boardBackupDirectory = join(receiptDirectory, "kanban-board");
  await adapter.backup(atmuxDir, boardBackupDirectory);
  const receiptPath = join(receiptDirectory, "receipt.json");

  const receipt: ExternalKanbanCutoverReceipt = {
    version: 1,
    status: "prepared",
    preparedAt: new Date().toISOString(),
    source,
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
  const source = resolve(atmuxDir, "state.db");
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

  const sourceDb = new Database(source, { readonly: true });
  let sourceTasks: string[];
  let sourceEpics: string[];
  let sourceStories: string[];
  try {
    const integrity = String(
      (sourceDb.query("PRAGMA integrity_check").get() as Record<string, unknown>).integrity_check,
    );
    if (integrity !== "ok") {
      throw new ConfigError({ what: `external Kanban activate: source integrity is ${integrity}` });
    }
    sourceTasks = sortedIDs(sourceDb.query("SELECT id FROM tasks").all() as Array<{ id: string }>);
    sourceEpics = sortedIDs(sourceDb.query("SELECT id FROM epics").all() as Array<{ id: string }>);
    sourceStories = sortedIDs(
      sourceDb.query("SELECT id FROM stories").all() as Array<{ id: string }>,
    );
  } finally {
    sourceDb.close();
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
