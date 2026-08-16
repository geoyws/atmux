import { resolve } from "node:path";
import { getAtmuxDir, type ResolveDirOpts } from "../core/common.ts";
import {
  activateExternalKanbanCutover,
  prepareExternalKanbanCutover,
  rollbackExternalKanbanCutover,
} from "../core/external-kanban-cutover.ts";
import { kanbanBackendMarkerPath, readKanbanBackendMarker } from "../core/kanban-backend.ts";
import { UsageError } from "../errors.ts";

export async function migrateKanban(argv: ReadonlyArray<string>): Promise<number> {
  if (argv[0] === "status") {
    let teamDir: string | undefined;
    let json = false;
    for (let index = 1; index < argv.length; index += 1) {
      const flag = argv[index];
      if (flag === "--json") {
        json = true;
        continue;
      }
      if (flag !== "--team-dir" || !argv[index + 1]) {
        throw new UsageError({ what: `migrate-kanban status: unknown or incomplete flag ${flag}` });
      }
      teamDir = argv[index + 1];
      index += 1;
    }
    const atmuxDir = await getAtmuxDir(teamDir ? { teamDir } : {});
    const marker = await readKanbanBackendMarker(atmuxDir);
    const status = {
      backend: marker?.backend ?? "legacy",
      durableMarker: marker,
      markerPath: kanbanBackendMarkerPath(atmuxDir),
      environmentOverride: process.env.ATMUX_KANBAN_BACKEND ?? null,
    };
    process.stdout.write(
      json
        ? `${JSON.stringify(status, null, 2)}\n`
        : `Kanban backend: ${status.environmentOverride ?? status.backend}\nMarker: ${marker ? status.markerPath : "absent"}\n`,
    );
    return 0;
  }
  if (argv[0] === "activate" || argv[0] === "rollback") {
    const stage = argv[0];
    let actor: string | undefined;
    let teamDir: string | undefined;
    let preparationReceipt: string | undefined;
    let writersStopped = false;
    let json = false;
    for (let index = 1; index < argv.length; index += 1) {
      const flag = argv[index];
      if (flag === "--json") {
        json = true;
        continue;
      }
      if (flag === "--writers-stopped") {
        writersStopped = true;
        continue;
      }
      const value = argv[index + 1];
      if (!value)
        throw new UsageError({ what: `migrate-kanban ${stage}: ${flag} requires a value` });
      if (flag === "--as") actor = value;
      else if (flag === "--team-dir") teamDir = value;
      else if (flag === "--receipt" && stage === "activate") preparationReceipt = resolve(value);
      else throw new UsageError({ what: `migrate-kanban ${stage}: unknown flag ${flag}` });
      index += 1;
    }
    if (!actor) throw new UsageError({ what: `migrate-kanban ${stage}: --as <actor> is required` });
    if (stage === "activate" && !preparationReceipt) {
      throw new UsageError({
        what: "migrate-kanban activate: --receipt <receipt.json> is required",
      });
    }
    if (!writersStopped) {
      throw new UsageError({
        what: `migrate-kanban ${stage}: --writers-stopped is required`,
        hint: "stop atmux and orchd writers before changing the durable authority marker",
      });
    }
    const atmuxDir = await getAtmuxDir(teamDir ? { teamDir } : {});
    const result =
      stage === "activate"
        ? await activateExternalKanbanCutover(atmuxDir, {
            actor,
            preparationReceipt: preparationReceipt as string,
            writersStopped,
          })
        : await rollbackExternalKanbanCutover(atmuxDir, { actor, writersStopped });
    process.stdout.write(
      json
        ? `${JSON.stringify(result, null, 2)}\n`
        : stage === "activate"
          ? `External Kanban activated from ${preparationReceipt}. Restart atmux/orchd before admitting work.\n`
          : "External Kanban rolled back before its first write; legacy authority restored.\n",
    );
    return 0;
  }
  if (argv[0] !== "prepare") {
    throw new UsageError({
      what: "migrate-kanban: available stages are 'prepare', 'activate', 'status', and 'rollback'",
      hint: "atmux migrate-kanban status [--team-dir <root>] [--json]",
    });
  }
  let actor: string | undefined;
  let teamDir: string | undefined;
  let receiptRoot: string | undefined;
  let json = false;
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--json") {
      json = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value) throw new UsageError({ what: `migrate-kanban prepare: ${flag} requires a value` });
    if (flag === "--as") actor = value;
    else if (flag === "--team-dir") teamDir = value;
    else if (flag === "--receipt-root") receiptRoot = resolve(value);
    else throw new UsageError({ what: `migrate-kanban prepare: unknown flag ${flag}` });
    index += 1;
  }
  if (!actor) throw new UsageError({ what: "migrate-kanban prepare: --as <actor> is required" });
  const dirOptions: ResolveDirOpts = teamDir ? { teamDir } : {};
  const atmuxDir = await getAtmuxDir(dirOptions);
  const receipt = await prepareExternalKanbanCutover(atmuxDir, {
    actor,
    ...(receiptRoot ? { receiptRoot } : {}),
  });
  if (json) process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  else {
    process.stdout.write(`External Kanban migration prepared; activation remains disabled.\n`);
    process.stdout.write(`Source backup: ${receipt.sourceBackup}\n`);
    process.stdout.write(`Board backup: ${receipt.boardBackupDirectory}\n`);
  }
  return 0;
}
