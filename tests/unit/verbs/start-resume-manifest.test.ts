// e-38 P1 follow-up — `surfaceResumeManifest` paths against a hermetic
// temp atmuxDir (real flags sqlite db + real fs, both under mkdtemp;
// no tmux, no network).

import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exists, readText } from "../../../src/abstractions/fs.ts";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import { FlagsRepo } from "../../../src/core/flags-repo.ts";
import type { Logger } from "../../../src/core/tui.ts";
import { surfaceResumeManifest } from "../../../src/verbs/start.ts";

function makeLogger(): { logger: Logger; logs: string[]; warns: string[] } {
  const logs: string[] = [];
  const warns: string[] = [];
  return {
    logger: {
      log: (m: string) => {
        logs.push(m);
      },
      ok: () => {},
      warn: (m: string) => {
        warns.push(m);
      },
      err: () => {},
    },
    logs,
    warns,
  };
}

function seedRow(atmuxDir: string, text: string): void {
  // openDatabase creates the file, not its parents.
  mkdirSync(atmuxDir, { recursive: true });
  const db = openDatabase(join(atmuxDir, "state.db"), migrations);
  try {
    new FlagsRepo(db).set("resume", text, 1770000000000);
  } finally {
    closeDatabase(db);
  }
}

function rowText(atmuxDir: string): string | null {
  const db = openDatabase(join(atmuxDir, "state.db"), migrations);
  try {
    return new FlagsRepo(db).get("resume");
  } finally {
    closeDatabase(db);
  }
}

const MANIFEST = {
  version: 1,
  ts: 1770000000,
  team: "t",
  reason: "soft-stop",
  members: [
    { name: "alice", lastClaim: "t-aaaaaaaa", claimedAt: 1769999900, windowName: null },
    { name: "bob", lastClaim: null, claimedAt: null, windowName: null },
  ],
};

describe("surfaceResumeManifest", () => {
  test("null (no row, no file) → silent no-op", async () => {
    const dir = await mkdtemp(join(tmpdir(), "resume-null-"));
    try {
      const atmuxDir = join(dir, ".atmux");
      const { logger, logs, warns } = makeLogger();
      await surfaceResumeManifest(atmuxDir, 1770000100, logger);
      expect(logs).toEqual([]);
      expect(warns).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("corrupt row → warn, row left in place", async () => {
    const dir = await mkdtemp(join(tmpdir(), "resume-corrupt-"));
    try {
      const atmuxDir = join(dir, ".atmux");
      seedRow(atmuxDir, "{not-json");
      const { logger, warns } = makeLogger();
      await surfaceResumeManifest(atmuxDir, 1770000100, logger);
      expect(warns.some((w) => w.includes("unparseable"))).toBe(true);
      expect(rowText(atmuxDir)).toBe("{not-json");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ok manifest → summary + breakdown, consumed file written, row cleared", async () => {
    const dir = await mkdtemp(join(tmpdir(), "resume-ok-"));
    try {
      const atmuxDir = join(dir, ".atmux");
      const raw = JSON.stringify(MANIFEST);
      seedRow(atmuxDir, raw);
      const { logger, logs, warns } = makeLogger();
      await surfaceResumeManifest(atmuxDir, 1770000100, logger);
      expect(warns).toEqual([]);
      expect(logs.some((l) => l.includes("1 member had in-flight"))).toBe(true);
      expect(logs.some((l) => l.includes("alice") && l.includes("t-aaaaaaaa"))).toBe(true);
      expect(rowText(atmuxDir)).toBe(null);
      const consumed = join(atmuxDir, "state", "resume.json.1770000100.consumed");
      expect(await exists(consumed)).toBe(true);
      expect(await readText(consumed)).toBe(raw);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("consume failure → warn, row left in place", async () => {
    const dir = await mkdtemp(join(tmpdir(), "resume-noconsume-"));
    try {
      const atmuxDir = join(dir, ".atmux");
      seedRow(atmuxDir, JSON.stringify(MANIFEST));
      // A FILE at state/ makes the consumed-copy write fail (ENOTDIR).
      await writeFile(join(atmuxDir, "state"), "blocker", "utf8");
      const { logger, warns } = makeLogger();
      await surfaceResumeManifest(atmuxDir, 1770000100, logger);
      expect(warns.some((w) => w.includes("could not archive"))).toBe(true);
      expect(rowText(atmuxDir)).toBe(JSON.stringify(MANIFEST));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
