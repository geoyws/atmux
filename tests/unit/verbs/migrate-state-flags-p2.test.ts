// Unit tests for e-38 P2 role-state migration (t-66d8c7a4):
//   - modal-history per-member dual-path + dedup map merge
//   - migrate-state --target=state imports role-state sources
//     (modal-history-*, heads-up-cursor, ombudsman-pending, cost-*)
//     and archives them
//
// Same fixture strategy as migrate-state-flags.test.ts (sibling P1 file).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exists } from "../../../src/abstractions/fs.ts";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import {
  loadDedupState,
  loadModalHistory,
  saveDedupState,
  saveModalHistory,
} from "../../../src/core/modal-cycling-state.ts";
import { FlagsRepo } from "../../../src/core/repositories/flags-repo.ts";
import type { Logger } from "../../../src/core/tui.ts";
import { migrateState } from "../../../src/verbs/migrate-state.ts";

let root = "";
let atmuxDir = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "atmux-flags-p2-"));
  atmuxDir = join(root, ".atmux");
  await mkdir(join(atmuxDir, "state"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeLogger(): Logger {
  return {
    log: () => {},
    ok: () => {},
    warn: () => {},
    err: () => {},
  };
}

describe("modal-history dual-path", () => {
  test("no state.db → legacy per-member files", async () => {
    await saveModalHistory(atmuxDir, "driver", []);
    expect(await loadModalHistory(atmuxDir, "driver")).toEqual([]);
    expect(await exists(join(atmuxDir, "state.db"))).toBe(false);
  });

  test("state.db present → kv canonical; dedup map merges", async () => {
    await writeFile(
      join(atmuxDir, "state", "modal-cycling-dedup-state.json"),
      JSON.stringify({ legacy: 1 }),
    );
    const db = openDatabase(join(atmuxDir, "state.db"), migrations);
    closeDatabase(db);
    await saveDedupState(atmuxDir, { fresh: 2 });
    expect(await loadDedupState(atmuxDir)).toEqual({ legacy: 1, fresh: 2 });
  });
});

describe("migrate-state --target=state (P2 sources)", () => {
  test("imports + archives role-state files", async () => {
    await writeFile(
      join(atmuxDir, "state", "modal-history-driver.json"),
      JSON.stringify([{ member: "driver", paneTextHash: "h", detectedAt: 1, modalText: "m", modalClass: "x" }]),
    );
    await writeFile(join(atmuxDir, "state", "heads-up-cursor.json"), JSON.stringify({ "a:b": 9 }));
    await writeFile(
      join(atmuxDir, "state", "ombudsman-pending.json"),
      JSON.stringify({ pending: ["c-1"] }),
    );
    await writeFile(
      join(atmuxDir, "state", "cost-driver.json"),
      JSON.stringify({ member: "driver", usd: 1 }),
    );
    const out: string[] = [];
    const code = await migrateState(
      ["json-to-sqlite", "--target=state", "--team-dir", atmuxDir],
      { logger: makeLogger(), stdout: (m) => out.push(m) },
    );
    expect(code).toBe(0);
    const db = openDatabase(join(atmuxDir, "state.db"), migrations);
    try {
      const repo = new FlagsRepo(db);
      expect(repo.list("modal-history")).toEqual({
        driver: [{ member: "driver", paneTextHash: "h", detectedAt: 1, modalText: "m", modalClass: "x" }],
      });
      expect(repo.get("heads-up-cursor", "a:b")).toBe(9);
      expect(repo.get("ombudsman-pending", "pending")).toEqual(["c-1"]);
      expect(repo.get("cost", "driver")).toEqual({ member: "driver", usd: 1 });
    } finally {
      closeDatabase(db);
    }
    expect(await exists(join(atmuxDir, "state", "modal-history-driver.json"))).toBe(false);
    expect(await exists(join(atmuxDir, "state", "cost-driver.json"))).toBe(false);
  });
});
