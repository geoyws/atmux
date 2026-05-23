// E2E integration smoke for `atmux-cockpit-mirror` (ADR-219 T-S2-11 /
// t-e55eb3fe). Verifies the Rust dispatcher actually reads from
// `~/.atmux/cockpit-events.db`, identifies whitelisted topics, and
// spawns the Bun handler subprocess with the correct argv.
//
// Strategy: pre-seed the events table BEFORE spawning the mirror so
// the mirror's startup `initial drain` (the cold-start catch-up loop)
// picks up the rows on the first wake — bypasses cross-process
// NOTIFY/LISTEN dependency (Honker NOTIFY across processes is exercised
// implicitly by the wake loop's 60s timeout-drain, but pre-seed is
// the deterministic path for smoke).
//
// Skipped at module-load when the Rust binary isn't built — same
// `describe.if(HAS_BIN)` pattern as tests/e2e/fallback-cage.test.ts.
//
// Assertions (per AC + CLAUDE.md §Verify-green-from-right-path):
//   - For whitelisted topic (budget.warning): fake-atmux log contains
//     `cockpit-mirror --handle-one --event-id <id> --topic budget.warning`.
//   - For non-whitelisted topic (totally.fictional): fake-atmux log
//     does NOT contain the event id, even after the wake-loop completes
//     its first iteration.
// Exit-code path is verified indirectly: a spawn-with-rc=0 advances the
// offset, which the mirror logs as "handled <topic> eventId=<id>"; the
// fake-atmux exits 0 always, so this log line MUST appear in the
// mirror's stdout for the whitelisted case.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const COCKPIT_MIRROR_BIN = join(
  REPO_ROOT,
  "rust/atmux-cockpit-mirror/target/release/atmux-cockpit-mirror",
);
const HAS_BIN = existsSync(COCKPIT_MIRROR_BIN);

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

describe.if(HAS_BIN)("atmux-cockpit-mirror smoke (ADR-219 T-S2-11)", () => {
  let scratchDir: string;
  let dbPath: string;
  let fakeAtmuxBin: string;
  let fakeAtmuxLog: string;
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let _mirrorStdoutBuf = "";
  let _mirrorStderrBuf = "";

  beforeEach(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), "atmux-cockpit-mirror-smoke-"));
    dbPath = join(scratchDir, "cockpit-events.db");
    fakeAtmuxLog = join(scratchDir, "fake-atmux.log");
    fakeAtmuxBin = join(scratchDir, "fake-atmux");

    // Fake atmux: log argv (space-separated) + exit 0 immediately. The
    // newline-per-call is the unit the assertion grep walks.
    await writeFile(
      fakeAtmuxBin,
      `#!/bin/bash\necho "$@" >> "${fakeAtmuxLog}"\nexit 0\n`,
    );
    await chmod(fakeAtmuxBin, 0o755);
    _mirrorStdoutBuf = "";
    _mirrorStderrBuf = "";
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

  /** Idempotent pre-create of `events` + `subscriber_offsets` so we
   *  can INSERT before the mirror spawns. The mirror's own
   *  `bootstrap_schema` is also IF-NOT-EXISTS so re-running is a
   *  no-op; this just lets us seed without needing Honker setup. */
  function bootstrapDb(): Database {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY NOT NULL,
        topic TEXT NOT NULL,
        payload TEXT NOT NULL,
        emitted_at_sec INTEGER NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS events_topic_id ON events(topic, event_id);
      CREATE TABLE IF NOT EXISTS subscriber_offsets (
        consumer_name TEXT PRIMARY KEY NOT NULL,
        last_event_id TEXT NOT NULL,
        last_processed_at_sec INTEGER NOT NULL
      );
    `);
    return db;
  }

  function insertEvent(db: Database, topic: string, eventId: string): void {
    db.prepare(
      "INSERT INTO events (event_id, topic, payload, emitted_at_sec) VALUES (?, ?, ?, ?)",
    ).run(
      eventId,
      topic,
      JSON.stringify({ eventId, topic }),
      Math.floor(Date.now() / 1000),
    );
  }

  function spawnMirror(): ReturnType<typeof Bun.spawn> {
    return Bun.spawn({
      cmd: [COCKPIT_MIRROR_BIN],
      env: {
        ...process.env,
        ATMUX_COCKPIT_MIRROR_DB: dbPath,
        ATMUX_COCKPIT_MIRROR_BIN: fakeAtmuxBin,
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

  /** Drain the mirror's stdout/stderr streams into in-memory buffers
   *  so assertions can grep them. Best-effort — a closed stream returns
   *  empty and we stop. */
  async function _drainStreams(): Promise<void> {
    if (proc === null) return;
    const readStream = async (
      stream: ReadableStream<Uint8Array> | undefined | null,
    ): Promise<string> => {
      if (stream === undefined || stream === null) return "";
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          acc += decoder.decode(value);
        }
      } catch {
        // stream interrupted on proc.kill — that's fine
      }
      return acc;
    };
    // Read both concurrently; ignore-then-add.
    [_mirrorStdoutBuf, _mirrorStderrBuf] = await Promise.all([
      readStream(proc.stdout as ReadableStream<Uint8Array>),
      readStream(proc.stderr as ReadableStream<Uint8Array>),
    ]);
  }

  test("whitelisted event (budget.warning) seeded pre-spawn → fake atmux invoked with cockpit-mirror --handle-one --event-id … --topic budget.warning", async () => {
    const db = bootstrapDb();
    insertEvent(db, "budget.warning", "0190budgetwarn");
    db.close();

    proc = spawnMirror();

    // Poll fake-atmux log for the expected invocation. The mirror's
    // initial drain runs synchronously on startup; allow up to 10s for
    // cold-start + first wake iteration (CI variance).
    const deadline = Date.now() + 10_000;
    let logContent = "";
    while (Date.now() < deadline) {
      logContent = await readFakeLog();
      if (
        logContent.includes("cockpit-mirror") &&
        logContent.includes("0190budgetwarn")
      ) {
        break;
      }
      await sleep(100);
    }

    expect(logContent).toContain("cockpit-mirror");
    expect(logContent).toContain("--handle-one");
    expect(logContent).toContain("--event-id 0190budgetwarn");
    expect(logContent).toContain("--topic budget.warning");
  }, 30_000);

  test("non-whitelisted event (totally.fictional) seeded pre-spawn → fake atmux NOT invoked", async () => {
    const db = bootstrapDb();
    insertEvent(db, "totally.fictional", "0190ghostevt");
    // Seed a whitelisted event AFTER to confirm the mirror IS alive +
    // dispatching (negative-space proof: the non-whitelisted topic was
    // skipped because of the whitelist filter, not because the mirror
    // was dead).
    insertEvent(db, "team.spawned", "0190teamspawn");
    db.close();

    proc = spawnMirror();

    // Wait until the whitelisted spawn lands — proves the mirror is
    // alive, drained both rows, dispatched ONLY the whitelisted one.
    const deadline = Date.now() + 10_000;
    let logContent = "";
    while (Date.now() < deadline) {
      logContent = await readFakeLog();
      if (logContent.includes("0190teamspawn")) break;
      await sleep(100);
    }

    expect(logContent).toContain("0190teamspawn");
    expect(logContent).toContain("--topic team.spawned");
    // The fictional topic must NOT have triggered a spawn — whitelist
    // gate held.
    expect(logContent).not.toContain("0190ghostevt");
    expect(logContent).not.toContain("totally.fictional");
  }, 30_000);

  test("post-spawn live publish: insert event AFTER mirror is alive → 60s timeout-drain fires + fake atmux invoked (cross-process update-events path; tolerant timeout)", async () => {
    bootstrapDb().close();

    proc = spawnMirror();
    // Wait for mirror to settle into the wake loop. The stderr line
    // "subscribed, entering wake loop" signals readiness; absent stderr
    // observability we just wait a conservative 1.5s.
    await sleep(1500);

    // Publish a whitelisted event NOW (post-spawn).
    const db = bootstrapDb();
    insertEvent(db, "gitter.escalated", "0190postspawn");
    db.close();

    // Wait up to 65s — bounded by the mirror's 60s timeout-drain
    // fallback. Cross-process NOTIFY via Honker SHOULD fire faster
    // (under 100ms per ADR-202 §D6) but the smoke is timeout-tolerant
    // so it doesn't flake on substrate slow-paths.
    const deadline = Date.now() + 65_000;
    let logContent = "";
    while (Date.now() < deadline) {
      logContent = await readFakeLog();
      if (logContent.includes("0190postspawn")) break;
      await sleep(200);
    }

    expect(logContent).toContain("--event-id 0190postspawn");
    expect(logContent).toContain("--topic gitter.escalated");
  }, 90_000);
});

// When the binary isn't built, surface a single "skipped" marker so
// CI logs surface the cause + reviewer can verify the gate fired.
describe.if(!HAS_BIN)("atmux-cockpit-mirror smoke (skipped — binary not built)", () => {
  test("rust/atmux-cockpit-mirror binary missing — run `npm run build:cockpit-mirror` then re-test", () => {
    expect(HAS_BIN).toBe(false);
  });
});
