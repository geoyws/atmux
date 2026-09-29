// Unit tests for src/verbs/migrate-kanban.ts.
//
// Strategy: per-test temp project root (`<root>/.atmux`), `--team-dir`
// injection, stdout capture. A fixture `kanban` stub (selected via KANBAN_BIN,
// which the verb's internally-constructed KanbanCliAdapter reads) serves the
// external CLI calls the cutover core makes, so prepare → activate → observe
// → rollback run end-to-end against the real core with an empty board. No
// mocks of the core: receipts and the durable backend marker are asserted
// from disk and stdout.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import { migrateKanban } from "../../../src/verbs/migrate-kanban.ts";

// ---------- Fixture `kanban` stub ----------

// The stub is POSIX sh (not bun): each cutover call spawns the binary, and a
// full prepare → activate → observe → rollback chain is a dozen spawns. Spawning
// a second bun runtime per call is seconds-slow on a loaded host; sh answers in
// milliseconds. The transport under test (spawn argv → parse stdout JSON) is
// identical either way.
const STUB_FIXTURES: Record<string, string> = {
  initOk: "{}\n",
  importOk: '{"imported":0,"updated":0}\n',
  doctorOk: '{"ok":true}\n',
  backupOk: '{"backedUp":true}\n',
  emptyBoard: "[]\n",
};

let stubRoot = "";
let priorKanbanBin: string | undefined;

beforeAll(async () => {
  stubRoot = await mkdtemp(join(tmpdir(), "atmux-migrate-kanban-stub-"));
  for (const [name, body] of Object.entries(STUB_FIXTURES)) {
    await writeFile(join(stubRoot, name), body);
  }
  await writeFile(
    join(stubRoot, "kanban-stub"),
    `#!/bin/sh\ncase "$1" in\n  init) cat "${stubRoot}/initOk" ;;\n  import) cat "${stubRoot}/importOk" ;;\n  doctor) cat "${stubRoot}/doctorOk" ;;\n  backup) cat "${stubRoot}/backupOk" ;;\n  task) cat "${stubRoot}/emptyBoard" ;;\n  *) echo "no fixture route for $*" >&2; exit 2 ;;\nesac\n`,
  );
  await chmod(join(stubRoot, "kanban-stub"), 0o755);
  priorKanbanBin = process.env.KANBAN_BIN;
  process.env.KANBAN_BIN = join(stubRoot, "kanban-stub");
});

afterAll(async () => {
  if (priorKanbanBin !== undefined) process.env.KANBAN_BIN = priorKanbanBin;
  else delete process.env.KANBAN_BIN;
  await rm(stubRoot, { recursive: true, force: true });
});

// ---------- Per-test project root ----------

let root = "";
let atmuxDir = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "atmux-migrate-kanban-"));
  atmuxDir = join(root, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  await writeFile(join(atmuxDir, "kanban.json"), JSON.stringify({ tasks: [] }));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function run(argv: ReadonlyArray<string>): Promise<{ out: string; result: number }> {
  let out = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string | Uint8Array) => {
    out += typeof s === "string" ? s : new TextDecoder().decode(s);
    return true;
  }) as typeof process.stdout.write;
  try {
    const result = await migrateKanban(argv);
    return { out, result };
  } finally {
    process.stdout.write = orig;
  }
}

/** Prepare via the verb (JSON output) and return the parsed receipt. */
async function prepareJson(extra: ReadonlyArray<string> = []): Promise<{
  status: string;
  activation: string;
  receiptPath: string;
}> {
  const { out, result } = await run([
    "prepare",
    "--as",
    "operator",
    "--team-dir",
    root,
    "--json",
    ...extra,
  ]);
  expect(result).toBe(0);
  return JSON.parse(out);
}
// ---------- status ----------

describe("migrate-kanban status", () => {
  test("text output reports legacy backend with absent marker", async () => {
    const { out, result } = await run(["status", "--team-dir", root]);
    expect(result).toBe(0);
    expect(out).toContain("Kanban backend: legacy");
    expect(out).toContain("Marker: absent");
  });

  test("json output reports the marker path and null override", async () => {
    const { out, result } = await run(["status", "--team-dir", root, "--json"]);
    expect(result).toBe(0);
    const status = JSON.parse(out);
    expect(status.backend).toBe("legacy");
    expect(status.markerPath).toBe(join(atmuxDir, "state", "kanban-backend.json"));
    expect(status.environmentOverride).toBeNull();
  });

  test("environment override wins over the durable marker in text output", async () => {
    const prior = process.env.ATMUX_KANBAN_BACKEND;
    process.env.ATMUX_KANBAN_BACKEND = "external";
    try {
      const { out, result } = await run(["status", "--team-dir", root]);
      expect(result).toBe(0);
      expect(out).toContain("Kanban backend: external");
    } finally {
      if (prior !== undefined) process.env.ATMUX_KANBAN_BACKEND = prior;
      else delete process.env.ATMUX_KANBAN_BACKEND;
    }
  });

  test("text output names the marker path once activated", async () => {
    const receipt = await prepareJson(["--receipt-root", join(root, "receipts")]);
    const activated = await run([
      "activate",
      "--as",
      "operator",
      "--team-dir",
      root,
      "--receipt",
      String(receipt.receiptPath),
      "--writers-stopped",
    ]);
    expect(activated.result).toBe(0);
    const { out, result } = await run(["status", "--team-dir", root]);
    expect(result).toBe(0);
    expect(out).toContain("Kanban backend: external");
    expect(out).toContain(`Marker: ${join(atmuxDir, "state", "kanban-backend.json")}`);
  });

  test("resolves the team dir from cwd when --team-dir is omitted", async () => {
    const priorCwd = process.cwd();
    process.chdir(root);
    try {
      const { out, result } = await run(["status"]);
      expect(result).toBe(0);
      expect(out).toContain("Kanban backend: legacy");
    } finally {
      process.chdir(priorCwd);
    }
  });

  test("unknown flag fails", async () => {
    await expect(run(["status", "--bogus"])).rejects.toThrow(UsageError);
  });

  test("--team-dir without a value fails", async () => {
    await expect(run(["status", "--team-dir"])).rejects.toThrow(UsageError);
  });
});

// ---------- prepare ----------

describe("migrate-kanban prepare", () => {
  test("text output names the source and board backups", async () => {
    const { out, result } = await run(["prepare", "--as", "operator", "--team-dir", root]);
    expect(result).toBe(0);
    expect(out).toContain("External Kanban migration prepared; activation remains disabled.");
    expect(out).toContain("Source backup: ");
    expect(out).toContain("Board backup: ");
  });

  test("json output is the durable receipt", async () => {
    const receipt = await prepareJson(["--receipt-root", join(root, "receipts")]);
    expect(receipt.status).toBe("prepared");
    expect(receipt.activation).toBe("not-activated");
    expect(String(receipt.receiptPath).startsWith(join(root, "receipts"))).toBe(true);
    const onDisk = JSON.parse(await readFile(String(receipt.receiptPath), "utf8"));
    expect(onDisk.status).toBe("prepared");
  });

  test("--reconcile --writers-stopped reuses the receipt root", async () => {
    const first = await prepareJson([
      "--receipt-root",
      join(root, "receipts"),
      "--reconcile",
      "--writers-stopped",
    ]);
    expect(first.status).toBe("prepared");
  });

  test("missing --as fails", async () => {
    await expect(run(["prepare", "--team-dir", root])).rejects.toThrow(UsageError);
  });

  test("--reconcile without --writers-stopped fails", async () => {
    await expect(
      run(["prepare", "--as", "operator", "--team-dir", root, "--reconcile"]),
    ).rejects.toThrow(UsageError);
  });

  test("flag without a value fails", async () => {
    await expect(run(["prepare", "--as"])).rejects.toThrow(UsageError);
  });

  test("unknown flag fails", async () => {
    await expect(
      run(["prepare", "--as", "operator", "--team-dir", root, "--bogus", "x"]),
    ).rejects.toThrow(UsageError);
  });

  test("missing work-state source fails with ConfigError", async () => {
    await rm(join(atmuxDir, "kanban.json"), { force: true });
    await expect(run(["prepare", "--as", "operator", "--team-dir", root])).rejects.toThrow(
      ConfigError,
    );
  });
});

// ---------- activate / rollback ----------

describe("migrate-kanban activate and rollback", () => {
  test("activate json output carries the activation receipt", async () => {
    const receipt = await prepareJson(["--receipt-root", join(root, "receipts")]);
    const { out, result } = await run([
      "activate",
      "--as",
      "operator",
      "--team-dir",
      root,
      "--receipt",
      String(receipt.receiptPath),
      "--writers-stopped",
      "--json",
    ]);
    expect(result).toBe(0);
    const activated = JSON.parse(out);
    expect(activated.status).toBe("activated");
    expect(activated.counts).toEqual({ tasks: 0, epics: 0, stories: 0 });
  });

  test("activate text output names the preparation receipt", async () => {
    const receipt = await prepareJson(["--receipt-root", join(root, "receipts-b")]);
    const { out, result } = await run([
      "activate",
      "--as",
      "operator",
      "--team-dir",
      root,
      "--receipt",
      String(receipt.receiptPath),
      "--writers-stopped",
    ]);
    expect(result).toBe(0);
    expect(out).toContain(`External Kanban activated from ${receipt.receiptPath}.`);
  });

  test("rollback json output restores the legacy marker", async () => {
    const receipt = await prepareJson(["--receipt-root", join(root, "receipts")]);
    const activated = await run([
      "activate",
      "--as",
      "operator",
      "--team-dir",
      root,
      "--receipt",
      String(receipt.receiptPath),
      "--writers-stopped",
    ]);
    expect(activated.result).toBe(0);
    const { out, result } = await run([
      "rollback",
      "--as",
      "operator",
      "--team-dir",
      root,
      "--writers-stopped",
      "--json",
    ]);
    expect(result).toBe(0);
    const marker = JSON.parse(out);
    expect(marker.backend).toBe("legacy");
    const { out: statusOut } = await run(["status", "--team-dir", root, "--json"]);
    expect(JSON.parse(statusOut).backend).toBe("legacy");
  });

  test("rollback text output confirms legacy authority", async () => {
    const receipt = await prepareJson(["--receipt-root", join(root, "receipts")]);
    const activated = await run([
      "activate",
      "--as",
      "operator",
      "--team-dir",
      root,
      "--receipt",
      String(receipt.receiptPath),
      "--writers-stopped",
    ]);
    expect(activated.result).toBe(0);
    const { out, result } = await run([
      "rollback",
      "--as",
      "operator",
      "--team-dir",
      root,
      "--writers-stopped",
    ]);
    expect(result).toBe(0);
    expect(out).toContain("External Kanban rolled back before its first write");
  });

  test("activate without --receipt fails", async () => {
    await expect(
      run(["activate", "--as", "operator", "--team-dir", root, "--writers-stopped"]),
    ).rejects.toThrow(UsageError);
  });

  test("activate without --writers-stopped fails", async () => {
    const receipt = await prepareJson(["--receipt-root", join(root, "receipts")]);
    await expect(
      run([
        "activate",
        "--as",
        "operator",
        "--team-dir",
        root,
        "--receipt",
        String(receipt.receiptPath),
      ]),
    ).rejects.toThrow(UsageError);
  });

  test("rollback without --writers-stopped fails", async () => {
    await expect(run(["rollback", "--as", "operator", "--team-dir", root])).rejects.toThrow(
      UsageError,
    );
  });

  test("activate without --as fails", async () => {
    await expect(run(["activate", "--team-dir", root, "--writers-stopped"])).rejects.toThrow(
      UsageError,
    );
  });

  test("rollback without --as fails", async () => {
    await expect(run(["rollback", "--team-dir", root, "--writers-stopped"])).rejects.toThrow(
      UsageError,
    );
  });

  test("--receipt is unknown on rollback", async () => {
    await expect(
      run([
        "rollback",
        "--as",
        "operator",
        "--team-dir",
        root,
        "--writers-stopped",
        "--receipt",
        "receipt.json",
      ]),
    ).rejects.toThrow(UsageError);
  });

  test("unknown flag fails", async () => {
    await expect(
      run(["activate", "--as", "operator", "--team-dir", root, "--bogus", "x"]),
    ).rejects.toThrow(UsageError);
  });

  test("flag without a value fails", async () => {
    await expect(run(["activate", "--as"])).rejects.toThrow(UsageError);
  });

  test("activate with an unreadable receipt fails", async () => {
    await expect(
      run([
        "activate",
        "--as",
        "operator",
        "--team-dir",
        root,
        "--receipt",
        join(root, "missing", "receipt.json"),
        "--writers-stopped",
      ]),
    ).rejects.toThrow();
  });

  test("rollback while legacy is active fails with ConfigError", async () => {
    await expect(
      run(["rollback", "--as", "operator", "--team-dir", root, "--writers-stopped"]),
    ).rejects.toThrow(ConfigError);
  });
});

// ---------- observe ----------

describe("migrate-kanban observe", () => {
  test("json output records the observation window", async () => {
    const receipt = await prepareJson(["--receipt-root", join(root, "receipts")]);
    const activated = await run([
      "activate",
      "--as",
      "operator",
      "--team-dir",
      root,
      "--receipt",
      String(receipt.receiptPath),
      "--writers-stopped",
    ]);
    expect(activated.result).toBe(0);
    const { out, result } = await run([
      "observe",
      "--as",
      "operator",
      "--team-dir",
      root,
      "--json",
    ]);
    expect(result).toBe(0);
    const observation = JSON.parse(out);
    expect(observation.status).toBe("observed");
    expect(observation.externalWritesObserved).toBe(false);
  });

  test("text output names the observation receipt", async () => {
    const receipt = await prepareJson(["--receipt-root", join(root, "receipts")]);
    const activated = await run([
      "activate",
      "--as",
      "operator",
      "--team-dir",
      root,
      "--receipt",
      String(receipt.receiptPath),
      "--writers-stopped",
    ]);
    expect(activated.result).toBe(0);
    const { out, result } = await run(["observe", "--as", "observer", "--team-dir", root]);
    expect(result).toBe(0);
    expect(out).toContain("External Kanban observation passed; receipt: ");
  });

  test("missing --as fails", async () => {
    await expect(run(["observe", "--team-dir", root])).rejects.toThrow(UsageError);
  });

  test("flag without a value fails", async () => {
    await expect(run(["observe", "--as"])).rejects.toThrow(UsageError);
  });

  test("unknown flag fails", async () => {
    await expect(run(["observe", "--as", "operator", "--bogus", "x"])).rejects.toThrow(UsageError);
  });

  test("observing before activation fails with ConfigError", async () => {
    await expect(run(["observe", "--as", "operator", "--team-dir", root])).rejects.toThrow(
      ConfigError,
    );
  });
});

// ---------- dispatch ----------

describe("migrate-kanban dispatch", () => {
  test("unknown stage fails", async () => {
    await expect(run(["frobnicate", "--team-dir", root])).rejects.toThrow(UsageError);
  });

  test("empty argv fails", async () => {
    await expect(run([])).rejects.toThrow(UsageError);
  });
});
