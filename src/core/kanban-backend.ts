import { chmod, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite, exists } from "../abstractions/fs.ts";

export type KanbanBackend = "legacy" | "external";

export interface KanbanBackendMarker {
  version: 1;
  backend: KanbanBackend;
  activatedAt: string;
  actor: string;
  preparationReceipt: string;
}

export function kanbanBackendMarkerPath(atmuxDir: string): string {
  return join(atmuxDir, "state", "kanban-backend.json");
}

export async function readKanbanBackendMarker(
  atmuxDir: string,
): Promise<KanbanBackendMarker | null> {
  try {
    const value = JSON.parse(
      await readFile(kanbanBackendMarkerPath(atmuxDir), "utf8"),
    ) as Partial<KanbanBackendMarker>;
    if (
      value.version !== 1 ||
      (value.backend !== "legacy" && value.backend !== "external") ||
      typeof value.activatedAt !== "string" ||
      typeof value.actor !== "string" ||
      typeof value.preparationReceipt !== "string"
    ) {
      throw new Error("invalid marker shape");
    }
    return value as KanbanBackendMarker;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Environment selection is retained as an explicit development/test
 *  override. Normal invocations follow the durable private marker. */
export async function externalKanbanEnabled(
  atmuxDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (env.ATMUX_KANBAN_BACKEND === "external") return true;
  if (env.ATMUX_KANBAN_BACKEND === "legacy") return false;
  return (await readKanbanBackendMarker(atmuxDir))?.backend === "external";
}

/** True when a work-state authority is configured without creating a
 * legacy JSON stub as a side effect of a read-only probe. */
export async function kanbanWorkStateAvailable(
  atmuxDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (await externalKanbanEnabled(atmuxDir, env)) return true;
  return (
    (await exists(join(atmuxDir, "state.db"))) || (await exists(join(atmuxDir, "kanban.json")))
  );
}

export async function writeKanbanBackendMarker(
  atmuxDir: string,
  marker: KanbanBackendMarker,
): Promise<void> {
  const path = kanbanBackendMarkerPath(atmuxDir);
  await atomicWrite(path, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}
