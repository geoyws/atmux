import { resolve } from "node:path";
import { getAtmuxDir, type ResolveDirOpts } from "../core/common.ts";
import { prepareExternalKanbanCutover } from "../core/external-kanban-cutover.ts";
import { UsageError } from "../errors.ts";

export async function migrateKanban(argv: ReadonlyArray<string>): Promise<number> {
  if (argv[0] !== "prepare") {
    throw new UsageError({
      what: "migrate-kanban: only the non-activating 'prepare' stage is currently available",
      hint: "atmux migrate-kanban prepare --as <actor> [--team-dir <root>] [--receipt-root <path>] [--json]",
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
