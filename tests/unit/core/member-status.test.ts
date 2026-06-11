// Unit tests for src/core/member-status.ts (ADR-260 §D3).
//
// Self-reported member-status write/read primitives — the manual-mode
// counterpart to the ADR-057 heartbeat family.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  isMemberSelfStatus,
  MEMBER_SELF_STATUS_VALUES,
  MEMBER_STATUS_DIRNAME,
  memberStatusDir,
  memberStatusPath,
  readAllMemberStatuses,
  readMemberStatus,
  writeMemberStatus,
} from "../../../src/core/member-status.ts";

let atmuxDir: string;

beforeEach(async () => {
  atmuxDir = await mkdtemp(join(tmpdir(), "atmux-member-status-"));
});

afterEach(async () => {
  await rm(atmuxDir, { recursive: true, force: true });
});

// ---------- Constants + paths + vocabulary ----------

describe("constants + paths + vocabulary", () => {
  test("MEMBER_SELF_STATUS_VALUES is the ADR-260 §D3 closed set", () => {
    expect(MEMBER_SELF_STATUS_VALUES).toEqual(["idle", "working", "blocked", "rate-limited"]);
  });

  test("isMemberSelfStatus accepts every legal value", () => {
    for (const v of MEMBER_SELF_STATUS_VALUES) {
      expect(isMemberSelfStatus(v)).toBe(true);
    }
  });

  test("isMemberSelfStatus rejects unknown / probe-derived values", () => {
    // `awaiting-input` / `errored` are ADR-258 probe-derived statuses,
    // explicitly NOT self-reportable per ADR-260 §D3.
    for (const v of ["awaiting-input", "errored", "busy", "", "WORKING"]) {
      expect(isMemberSelfStatus(v)).toBe(false);
    }
  });

  test("memberStatusDir appends state/member-status/ to atmuxDir", () => {
    expect(memberStatusDir("/tmp/foo")).toBe(`/tmp/foo/state/${MEMBER_STATUS_DIRNAME}`);
  });

  test("memberStatusPath appends state/member-status/<member>.json", () => {
    expect(memberStatusPath("/tmp/foo", "be-1")).toBe("/tmp/foo/state/member-status/be-1.json");
  });
});

// ---------- writeMemberStatus ----------

describe("writeMemberStatus", () => {
  test("creates the dir + writes a parseable strict record", async () => {
    const rec = await writeMemberStatus(atmuxDir, {
      member: "be-1",
      status: "working",
      note: "wiring ADR-260",
      taskId: "t-12345678",
      updatedAtSec: 1700000000,
    });
    expect(rec.updatedAtSec).toBe(1700000000);
    const text = await readFile(memberStatusPath(atmuxDir, "be-1"), "utf8");
    expect(JSON.parse(text)).toEqual({
      member: "be-1",
      status: "working",
      note: "wiring ADR-260",
      taskId: "t-12345678",
      updatedAtSec: 1700000000,
    });
    expect(text.endsWith("\n")).toBe(true);
  });

  test("default updatedAtSec uses the real clock (within 2s of now)", async () => {
    const before = Math.floor(Date.now() / 1000);
    const rec = await writeMemberStatus(atmuxDir, { member: "be-1", status: "idle" });
    const after = Math.floor(Date.now() / 1000);
    expect(rec.updatedAtSec).toBeGreaterThanOrEqual(before);
    expect(rec.updatedAtSec).toBeLessThanOrEqual(after + 2);
  });

  test("optional fields omitted from disk when absent", async () => {
    await writeMemberStatus(atmuxDir, { member: "be-1", status: "idle", updatedAtSec: 1 });
    const parsed = JSON.parse(await readFile(memberStatusPath(atmuxDir, "be-1"), "utf8"));
    expect(Object.keys(parsed).sort()).toEqual(["member", "status", "updatedAtSec"]);
  });

  test("overwrite replaces the prior record (one file per member)", async () => {
    await writeMemberStatus(atmuxDir, { member: "be-1", status: "working", updatedAtSec: 1 });
    await writeMemberStatus(atmuxDir, { member: "be-1", status: "idle", updatedAtSec: 2 });
    const rec = await readMemberStatus(atmuxDir, "be-1");
    expect(rec).toEqual({ member: "be-1", status: "idle", updatedAtSec: 2 });
  });
});

// ---------- readMemberStatus ----------

describe("readMemberStatus", () => {
  test("absent file → null", async () => {
    expect(await readMemberStatus(atmuxDir, "ghost")).toBe(null);
  });

  test("round-trips a written record", async () => {
    await writeMemberStatus(atmuxDir, {
      member: "fe-1",
      status: "blocked",
      note: "waiting on reviewer",
      updatedAtSec: 1700000123,
    });
    expect(await readMemberStatus(atmuxDir, "fe-1")).toEqual({
      member: "fe-1",
      status: "blocked",
      note: "waiting on reviewer",
      updatedAtSec: 1700000123,
    });
  });

  test("unparseable JSON → null (fail-soft, matches readHeartbeat)", async () => {
    const p = memberStatusPath(atmuxDir, "be-1");
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, "{not json", "utf8");
    expect(await readMemberStatus(atmuxDir, "be-1")).toBe(null);
  });

  test("schema-invalid record → null (unknown status)", async () => {
    const p = memberStatusPath(atmuxDir, "be-1");
    await mkdir(dirname(p), { recursive: true });
    await writeFile(
      p,
      JSON.stringify({ member: "be-1", status: "vibing", updatedAtSec: 1 }),
      "utf8",
    );
    expect(await readMemberStatus(atmuxDir, "be-1")).toBe(null);
  });

  test("strict schema: extra key → null (typo'd hand-edit surfaces as no-signal)", async () => {
    const p = memberStatusPath(atmuxDir, "be-1");
    await mkdir(dirname(p), { recursive: true });
    await writeFile(
      p,
      JSON.stringify({ member: "be-1", status: "idle", updatedAtSec: 1, notee: "typo" }),
      "utf8",
    );
    expect(await readMemberStatus(atmuxDir, "be-1")).toBe(null);
  });
});

// ---------- readAllMemberStatuses ----------

describe("readAllMemberStatuses", () => {
  test("returns only members with readable records (key-presence convention)", async () => {
    await writeMemberStatus(atmuxDir, { member: "be-1", status: "working", updatedAtSec: 10 });
    await writeMemberStatus(atmuxDir, { member: "fe-1", status: "idle", updatedAtSec: 20 });
    const badPath = memberStatusPath(atmuxDir, "db-1");
    await writeFile(badPath, "torn{", "utf8");

    const map = await readAllMemberStatuses(atmuxDir, ["be-1", "fe-1", "db-1", "ghost"]);
    expect([...map.keys()].sort()).toEqual(["be-1", "fe-1"]);
    expect(map.get("be-1")?.status).toBe("working");
    expect(map.get("fe-1")?.updatedAtSec).toBe(20);
  });

  test("empty member list → empty map", async () => {
    const map = await readAllMemberStatuses(atmuxDir, []);
    expect(map.size).toBe(0);
  });
});
