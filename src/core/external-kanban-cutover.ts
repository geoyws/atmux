import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { exists } from "../abstractions/fs.ts";
import { KanbanCliAdapter } from "../adapters/kanban-cli.ts";
import { ConfigError } from "../errors.ts";

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
    rollback: `Restore ${sourceBackup} to ${source} only after stopping atmux writers; external mode remains disabled.`,
  };
  const receiptPath = join(receiptDirectory, "receipt.json");
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  await chmod(receiptPath, 0o600);
  return receipt;
}
