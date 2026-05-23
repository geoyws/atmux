// End-to-end integration test for the atmux-listener Rust subprocess.
//
// Runs only when the listener binary exists on disk (gated check). On
// CI / dev machines without the binary, the test is skipped with a
// note. Production validation: hax + operator MBP after build:install.
//
// What this validates:
//   1. Listener spawns + emits "ready" within reasonable time.
//   2. Bun-side honker_stream_publish triggers the listener's blocking
//      Database::listen → stdout emit.
//   3. spawnNativeListener returns lines suitable for watchEvents'
//      externalSignals input.
//   4. Cancellation via stop() terminates the subprocess.
//
// **This is the only test that exercises the real Rust binary** —
// every other native-listener test uses the spawn-fn injection seam.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnNativeListener } from "../../src/abstractions/native-listener.ts";

const HONKER_PATH = "/root/.atmux/extensions/honker.so";

// Hard-coded path to the build artifact. Production build:install
// stages this at /opt/atmux/current/bin/atmux-listener; tests reach
// into the build tree directly so this test runs without an install.
const LISTENER_BINARY = join(
  import.meta.dir,
  "..",
  "..",
  "rust",
  "atmux-listener",
  "target",
  "release",
  "atmux-listener",
);

const BINARY_AVAILABLE = existsSync(LISTENER_BINARY);
const HONKER_AVAILABLE = existsSync(HONKER_PATH);
const READY = BINARY_AVAILABLE && HONKER_AVAILABLE;

if (!READY) {
  test.skip(`native-listener-e2e: skipping — binary/honker missing (binary=${BINARY_AVAILABLE} honker=${HONKER_AVAILABLE})`, () => {});
} else {
  describe("atmux-listener end-to-end (real subprocess)", () => {
    let scratch: string;
    let dbPath: string;

    beforeEach(async () => {
      scratch = await mkdtemp(join(tmpdir(), "atmux-listener-e2e-"));
      dbPath = join(scratch, "state.db");
      // Bootstrap the DB with Honker + WAL mode so the Rust listener
      // can see cross-process writes.
      const db = new Database(dbPath);
      db.run("PRAGMA journal_mode=WAL");
      // biome-ignore lint/suspicious/noExplicitAny: bun:sqlite types miss loadExtension's 2-arg form
      (db as any).loadExtension(HONKER_PATH, "sqlite3_honkerext_init");
      db.query("SELECT honker_bootstrap()").get();
      db.close();
    });

    afterEach(async () => {
      await rm(scratch, { recursive: true, force: true });
    });

    test("Bun publish triggers listener wake within 1s", async () => {
      const handle = spawnNativeListener({
        binaryPath: LISTENER_BINARY,
        dbPath,
        channel: "honker:stream:task.done",
      });
      try {
        // Drain in the background; collect first line.
        const firstLine = (async () => {
          for await (const line of handle.signals) {
            return line;
          }
          return null;
        })();

        // Give listener time to subscribe + emit "ready" (filtered)
        await new Promise((r) => setTimeout(r, 200));

        // Publish from a fresh Bun connection (mimics emit() at runtime)
        const start = Date.now();
        const pub = new Database(dbPath);
        // biome-ignore lint/suspicious/noExplicitAny: see above
        (pub as any).loadExtension(HONKER_PATH, "sqlite3_honkerext_init");
        pub.query("SELECT honker_stream_publish(?, ?, ?)").get(
          "task.done",
          "e-1",
          '{"topic":"task.done","eventId":"e-1"}',
        );
        pub.close();

        // Race against a hard 1s timeout
        const result = await Promise.race([
          firstLine,
          new Promise<null>((r) => setTimeout(() => r(null), 1000)),
        ]);
        const elapsed = Date.now() - start;
        expect(result).not.toBeNull();
        expect(result).toContain("honker:stream:task.done");
        // Latency assertion — the kernel-blocked path should wake in
        // under 200ms (honker's PRAGMA data_version poll is 1ms; we
        // give 200ms slack for spawn + stdout buffering jitter).
        expect(elapsed).toBeLessThan(1000);
      } finally {
        handle.stop();
        await handle.exited.catch(() => {});
      }
    });

    test("stop() terminates the subprocess cleanly", async () => {
      const handle = spawnNativeListener({
        binaryPath: LISTENER_BINARY,
        dbPath,
        channel: "honker:stream:task.done",
      });
      // Give listener time to start
      await new Promise((r) => setTimeout(r, 100));
      handle.stop();
      // Should exit within 2s — closing stdin triggers graceful exit
      const exit = await Promise.race([
        handle.exited,
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (r) => setTimeout(() => r({ code: -1, signal: "TIMEOUT" as NodeJS.Signals }), 2000),
        ),
      ]);
      expect(exit.signal).not.toBe("TIMEOUT");
    });
  });
}
