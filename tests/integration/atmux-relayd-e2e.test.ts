// End-to-end integration test for the atmux-relayd Rust subprocess
// (t-21dbcc72 — S1 trunk-signoff carve-out #2 follow-up). Mirrors the
// `tests/integration/native-listener-e2e.test.ts` pattern: gate on the
// real Rust binary's presence, spawn it against a synthetic events
// table, observe dispatch behavior.
//
// Validates (per t-21dbcc72 AC):
//   1. Valid TaskUnclaimedPayload → relayd reads payload, dispatches
//      Bun handler with --task-id + --lane (lean per-event dispatch
//      path per ADR-202 §Amendment 2026-05-22 IX-A).
//   2. Payload parse-fail (invalid JSON) → falls back to no-extra-args
//      dispatch + eprintln visible.
//   3. NULL payload → falls back to no-extra-args dispatch (Option::None
//      path in `load_event_payload`).
//   4. Offset advancement on rc=0; no advancement on rc!=0.
//
// Strategy: pre-seed events table BEFORE spawning relayd so the
// initial-drain code path picks up rows synchronously. Cross-process
// Honker NOTIFY/LISTEN is exercised elsewhere (native-listener-e2e);
// here we focus on the read-payload + dispatch-shape + offset
// invariants.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const RELAYD_BIN = join(
  REPO_ROOT,
  "rust",
  "atmux-relayd",
  "target",
  "release",
  "atmux-relayd",
);
const BINARY_AVAILABLE = existsSync(RELAYD_BIN);

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

if (!BINARY_AVAILABLE) {
  test.skip(
    `atmux-relayd-e2e: skipping — binary missing at ${RELAYD_BIN}`,
    () => {},
  );
} else {
  describe("atmux-relayd end-to-end (real subprocess)", () => {
    let scratchDir: string;
    let dbPath: string;
    let fakeAtmuxBin: string;
    let fakeAtmuxLog: string;
    let proc: ReturnType<typeof Bun.spawn> | null = null;

    /** Write a fake-atmux shell stub at `path` that logs argv to
     *  `fakeAtmuxLog` + exits with `rc`. Per-test override enables
     *  the offset-advancement matrix (rc=0 advances; rc!=0 holds). */
    async function writeFakeAtmux(path: string, rc: number): Promise<void> {
      await writeFile(
        path,
        `#!/bin/bash\necho "$@" >> "${fakeAtmuxLog}"\nexit ${rc}\n`,
      );
      await chmod(path, 0o755);
    }

    beforeEach(async () => {
      scratchDir = await mkdtemp(join(tmpdir(), "atmux-relayd-e2e-"));
      dbPath = join(scratchDir, "state.db");
      fakeAtmuxLog = join(scratchDir, "fake-atmux.log");
      fakeAtmuxBin = join(scratchDir, "fake-atmux");
      await writeFakeAtmux(fakeAtmuxBin, 0);

      // Bootstrap schema. NB: production `events.payload` is `TEXT
      // NOT NULL` (per sqlite-migrations.ts); we deliberately drop the
      // NOT NULL constraint here so the NULL-payload test can exercise
      // the `Option<String>` defensive branch in `load_event_payload`.
      // The relayd's read-path treats nullable payload as a runtime
      // shape, not a schema-enforced invariant — this is the seam we
      // want covered.
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE events (
          event_id TEXT PRIMARY KEY NOT NULL,
          topic TEXT NOT NULL,
          payload TEXT,
          emitted_at_sec INTEGER NOT NULL,
          schema_version INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX events_topic_id ON events(topic, event_id);
        CREATE TABLE subscriber_offsets (
          consumer_name TEXT PRIMARY KEY NOT NULL,
          last_event_id TEXT NOT NULL,
          last_processed_at_sec INTEGER NOT NULL
        );
      `);
      db.close();
    });

    afterEach(async () => {
      if (proc !== null) {
        try {
          proc.kill();
        } catch {
          // ignore — already exited
        }
        try {
          await proc.exited;
        } catch {
          // ignore
        }
        proc = null;
      }
      await rm(scratchDir, { recursive: true, force: true });
    });

    function insertEvent(topic: string, eventId: string, payload: string | null): void {
      const db = new Database(dbPath);
      db.prepare(
        "INSERT INTO events (event_id, topic, payload, emitted_at_sec) VALUES (?, ?, ?, ?)",
      ).run(eventId, topic, payload, Math.floor(Date.now() / 1000));
      db.close();
    }

    function spawnRelayd(): ReturnType<typeof Bun.spawn> {
      return Bun.spawn({
        cmd: [RELAYD_BIN],
        env: {
          ...process.env,
          ATMUX_RELAYD_DB: dbPath,
          ATMUX_RELAYD_ATMUX_BIN: fakeAtmuxBin,
          ATMUX_RELAYD_TEAM_DIR: scratchDir,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
    }

    async function readFakeLog(): Promise<string> {
      try {
        return await readFile(fakeAtmuxLog, "utf-8");
      } catch {
        return "";
      }
    }

    async function waitForLogLineContaining(
      needle: string,
      timeoutMs: number,
    ): Promise<string> {
      const deadline = Date.now() + timeoutMs;
      let content = "";
      while (Date.now() < deadline) {
        content = await readFakeLog();
        if (content.includes(needle)) return content;
        await sleep(100);
      }
      return content;
    }

    function readSubscriberOffset(consumer: string): string | null {
      const db = new Database(dbPath);
      try {
        const row = db
          .prepare(
            "SELECT last_event_id FROM subscriber_offsets WHERE consumer_name = ?",
          )
          .get(consumer) as { last_event_id?: string } | null;
        return row?.last_event_id ?? null;
      } finally {
        db.close();
      }
    }

    test("valid TaskUnclaimedPayload → fake atmux invoked with --task-id + --lane (lean dispatch)", async () => {
      insertEvent(
        "task.unclaimed",
        "0190validpayl",
        JSON.stringify({
          topic: "task.unclaimed",
          eventId: "0190validpayl",
          taskId: "t-foo",
          team: "test-team",
          lane: "be",
        }),
      );

      proc = spawnRelayd();
      const content = await waitForLogLineContaining("0190validpayl", 10_000);

      expect(content).toContain("relayd");
      expect(content).toContain("--handle-one");
      expect(content).toContain("--event-id 0190validpayl");
      expect(content).toContain("--topic task.unclaimed");
      expect(content).toContain("--task-id t-foo");
      expect(content).toContain("--lane be");
    }, 30_000);

    test("invalid JSON payload → fake atmux invoked WITHOUT --task-id/--lane (fallback dispatch)", async () => {
      insertEvent("task.unclaimed", "0190badjson01", "not actually json");

      proc = spawnRelayd();
      const content = await waitForLogLineContaining("0190badjson01", 10_000);

      expect(content).toContain("--event-id 0190badjson01");
      expect(content).toContain("--topic task.unclaimed");
      // Fallback path: extra args absent.
      expect(content).not.toContain("--task-id");
      expect(content).not.toContain("--lane");
    }, 30_000);

    test("NULL payload → fake atmux invoked WITHOUT --task-id/--lane (Option::None path)", async () => {
      insertEvent("task.unclaimed", "0190nullpayld", null);

      proc = spawnRelayd();
      const content = await waitForLogLineContaining("0190nullpayld", 10_000);

      expect(content).toContain("--event-id 0190nullpayld");
      expect(content).not.toContain("--task-id");
      expect(content).not.toContain("--lane");
    }, 30_000);

    test("rc=0 dispatch → subscriber_offsets advances to event_id", async () => {
      // Default fake-atmux already returns rc=0 from beforeEach.
      insertEvent(
        "task.unclaimed",
        "0190rcadv0001",
        JSON.stringify({
          topic: "task.unclaimed",
          eventId: "0190rcadv0001",
          taskId: "t-a",
          team: "t",
          lane: "be",
        }),
      );

      proc = spawnRelayd();
      await waitForLogLineContaining("0190rcadv0001", 10_000);

      // Give relayd a moment to advance the offset after spawn-success.
      const deadline = Date.now() + 5_000;
      let offset: string | null = null;
      while (Date.now() < deadline) {
        offset = readSubscriberOffset("atmux:lane-router");
        if (offset === "0190rcadv0001") break;
        await sleep(100);
      }
      expect(offset).toBe("0190rcadv0001");
    }, 30_000);

    test("rc!=0 dispatch → subscriber_offsets does NOT advance (relayd holds the offset for retry)", async () => {
      // Override fake-atmux to exit 42.
      await writeFakeAtmux(fakeAtmuxBin, 42);
      insertEvent(
        "task.unclaimed",
        "0190rchold001",
        JSON.stringify({
          topic: "task.unclaimed",
          eventId: "0190rchold001",
          taskId: "t-b",
          team: "t",
          lane: "be",
        }),
      );

      proc = spawnRelayd();
      // Wait for the dispatch attempt itself (the fake-atmux still
      // logs even when exiting 42 — its first line happens before
      // exit).
      await waitForLogLineContaining("0190rchold001", 10_000);

      // Give relayd a moment in case it would (erroneously) advance.
      await sleep(2_000);
      const offset = readSubscriberOffset("atmux:lane-router");
      // Offset MUST NOT have advanced past the failed event. The
      // legitimate not-yet-seen value is `null` (no row).
      expect(offset).not.toBe("0190rchold001");
    }, 30_000);
  });
}
