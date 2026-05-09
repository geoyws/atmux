// Unit tests for src/verbs/driver-inbox.ts (ADR-057 §D2b read verb).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCursor } from "../../../src/core/driver-inbox.ts";
import { UsageError } from "../../../src/errors.ts";
import { driverInbox, parseDriverInboxArgs } from "../../../src/verbs/driver-inbox.ts";

const NOW_MS = 1778126400 * 1000; // 2026-05-07 12:00 MYT

const seedTeam = async (atmuxDir: string): Promise<void> => {
  await mkdir(atmuxDir, { recursive: true });
  await writeFile(
    join(atmuxDir, "team.json"),
    JSON.stringify({ name: "t", members: [{ name: "alice" }] }),
  );
  await mkdir(join(atmuxDir, "state"), { recursive: true });
};

const seedInbox = async (atmuxDir: string, body: string): Promise<void> => {
  await writeFile(join(atmuxDir, "driver-inbox.md"), body);
};

// ---------- parseDriverInboxArgs ----------

describe("parseDriverInboxArgs", () => {
  test("default", () => {
    expect(parseDriverInboxArgs([])).toEqual({ showAll: false, ack: false, json: false });
  });
  test("--all", () => {
    expect(parseDriverInboxArgs(["--all"]).showAll).toBe(true);
  });
  test("--ack", () => {
    expect(parseDriverInboxArgs(["--ack"]).ack).toBe(true);
  });
  test("--json", () => {
    expect(parseDriverInboxArgs(["--json"]).json).toBe(true);
  });
  test("--since N", () => {
    expect(parseDriverInboxArgs(["--since", "1000"]).sinceEpoch).toBe(1000);
  });
  test("--since 0 accepted (epoch start)", () => {
    expect(parseDriverInboxArgs(["--since", "0"]).sinceEpoch).toBe(0);
  });
  test("--team-dir captured", () => {
    expect(parseDriverInboxArgs(["--team-dir", "/x"]).teamDir).toBe("/x");
  });
  test("--since without value → UsageError", () => {
    expect(() => parseDriverInboxArgs(["--since"])).toThrow(UsageError);
  });
  test("--since negative → UsageError", () => {
    expect(() => parseDriverInboxArgs(["--since", "-3"])).toThrow(UsageError);
  });
  test("--since non-numeric → UsageError", () => {
    expect(() => parseDriverInboxArgs(["--since", "abc"])).toThrow(UsageError);
  });
  test("--team-dir without value → UsageError", () => {
    expect(() => parseDriverInboxArgs(["--team-dir"])).toThrow(UsageError);
  });
  test("unknown arg → UsageError", () => {
    expect(() => parseDriverInboxArgs(["--bogus"])).toThrow(UsageError);
  });
});

// ---------- public verb ----------

describe("driverInbox()", () => {
  let teamDir: string;
  let atmuxDir: string;
  let stdoutBuf: string;
  const stdout = (s: string): void => {
    stdoutBuf += s;
  };

  beforeEach(async () => {
    teamDir = await mkdtemp(join(tmpdir(), "atmux-driver-inbox-verb-"));
    atmuxDir = join(teamDir, ".atmux");
    await seedTeam(atmuxDir);
    stdoutBuf = "";
  });

  afterEach(async () => {
    await rm(teamDir, { recursive: true, force: true });
  });

  test("UsageError on unknown arg", async () => {
    await expect(driverInbox(["--bogus"])).rejects.toBeInstanceOf(UsageError);
  });

  test("absent file → 'empty / absent' message", async () => {
    const code = await driverInbox(["--team-dir", teamDir], { stdout, now: () => NOW_MS });
    expect(code).toBe(0);
    expect(stdoutBuf).toContain("empty / absent");
  });

  test("file exists, no entries → 'has no entries'", async () => {
    await seedInbox(atmuxDir, "# header\n\nfile preamble (no entries)\n");
    const code = await driverInbox(["--team-dir", teamDir], { stdout, now: () => NOW_MS });
    expect(code).toBe(0);
    expect(stdoutBuf).toContain("has no entries");
  });

  test("--all surfaces every entry", async () => {
    await seedInbox(atmuxDir, "## 09:00 MYT — first\nbody A\n## 11:00 MYT — second\nbody B");
    await driverInbox(["--team-dir", teamDir, "--all"], { stdout, now: () => NOW_MS });
    expect(stdoutBuf).toContain("2 entries");
    expect(stdoutBuf).toContain("first");
    expect(stdoutBuf).toContain("second");
  });

  test("default cursor (none) surfaces all entries with 'entries' header", async () => {
    await seedInbox(atmuxDir, "## 09:00 MYT — only one\nbody");
    await driverInbox(["--team-dir", teamDir], { stdout, now: () => NOW_MS });
    expect(stdoutBuf).toContain("1 entry");
    expect(stdoutBuf).toContain("only one");
  });

  test("--ack updates cursor to tip", async () => {
    await seedInbox(atmuxDir, "## 09:00 MYT — old\nA\n## 11:00 MYT — newer\nB");
    await driverInbox(["--team-dir", teamDir, "--ack"], { stdout, now: () => NOW_MS });
    const cur = await readCursor(atmuxDir);
    // 11:00 MYT today = 1778122800
    expect(cur).toBe(1778122800);
  });

  test("subsequent run after --ack → 'no new entries'", async () => {
    await seedInbox(atmuxDir, "## 09:00 MYT — old\nA\n## 11:00 MYT — newer\nB");
    await driverInbox(["--team-dir", teamDir, "--ack"], { stdout, now: () => NOW_MS });
    stdoutBuf = "";
    await driverInbox(["--team-dir", teamDir], { stdout, now: () => NOW_MS });
    expect(stdoutBuf).toContain("no new entries");
  });

  test("--since overrides on-disk cursor", async () => {
    await seedInbox(atmuxDir, "## 09:00 MYT — old\nA\n## 11:00 MYT — newer\nB");
    // Pre-set a future cursor that would hide all entries.
    await driverInbox(["--team-dir", teamDir, "--ack"], { stdout, now: () => NOW_MS });
    stdoutBuf = "";
    // --since 0 forces all entries to surface.
    await driverInbox(["--team-dir", teamDir, "--since", "0"], { stdout, now: () => NOW_MS });
    expect(stdoutBuf).toContain("2 entries");
  });

  test("--json emits structured payload with cursor metadata", async () => {
    await seedInbox(atmuxDir, "## 09:00 MYT — only\nbody");
    await driverInbox(["--team-dir", teamDir, "--json"], { stdout, now: () => NOW_MS });
    const parsed = JSON.parse(stdoutBuf.trim());
    expect(parsed.entries.length).toBe(1);
    expect(parsed.entries[0].head).toContain("only");
    expect(parsed.entries[0].tsEpochSec).toBe(1778115600);
    expect(parsed.cursorBefore).toBeNull();
    expect(parsed.cursorAfter).toBeNull(); // no --ack → cursor unchanged
    expect(parsed.fileMtimeSec).toBeGreaterThan(0);
  });

  test("--json --ack reflects post-ack cursor in cursorAfter", async () => {
    await seedInbox(atmuxDir, "## 09:00 MYT — only\nbody");
    await driverInbox(["--team-dir", teamDir, "--json", "--ack"], {
      stdout,
      now: () => NOW_MS,
    });
    const parsed = JSON.parse(stdoutBuf.trim());
    expect(parsed.cursorAfter).toBe(1778115600);
  });

  test("default Date.now() branch (no opts.now) succeeds", async () => {
    await seedInbox(atmuxDir, "## 09:00 MYT — old\nbody");
    const code = await driverInbox(["--team-dir", teamDir, "--all"], { stdout });
    expect(code).toBe(0);
  });

  test("--ack on absent file does NOT write cursor (tipTs null)", async () => {
    await driverInbox(["--team-dir", teamDir, "--ack"], { stdout, now: () => NOW_MS });
    const cur = await readCursor(atmuxDir);
    expect(cur).toBeNull();
  });
});
