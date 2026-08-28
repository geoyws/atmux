// Unit tests for src/core/vox/transcript.ts — ADR-272 OQ-4 (resolved
// 2026-08-15): voice transcript retention.
//
// Assertion posture (repo NO-LIES rule). A transcript file is the one
// artifact that turns a voice session into a durable record of everything
// said near the operator's microphone, so "a file was written" is NOT the
// property under test. Every write test asserts the file's CONTENT — its
// exact key set, its exact values — and the off-by-default tests assert
// ABSENCE on disk, not merely that a flag read false. The prune tests use
// REAL files with REAL mtimes (`utimes`) against an INJECTED clock, so the
// 7-day boundary is measured, not modelled.
//
// Pins:
//   - Location is `$HOME/.atmux/vox-logs` and has no env override.
//   - One file per session, session id in the name, name sanitized into a
//     closed shape the pruner can recognise.
//   - Line content: ts / iso / session / role / text — and nothing else.
//   - Lazy creation: a sink with nothing recorded leaves no file.
//   - A write failure never propagates and never floods the log.
//   - The pruner deletes ONLY its own name pattern, keeps a 7-day-old
//     file, removes an 8-day-old one, and survives every failure mode.

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createTranscriptSink,
  DEFAULT_TRANSCRIPT_RETENTION_DAYS,
  formatPruneResult,
  nodeTranscriptFs,
  pruneTranscripts,
  resolveTranscriptDir,
  retentionMsForDays,
  startTranscriptPruneLoop,
  TRANSCRIPT_FILE_RE,
  TRANSCRIPT_PRUNE_INTERVAL_MS,
  type TranscriptFs,
  transcriptFileName,
  VOX_TRANSCRIPT_DIR_REL,
} from "../../../../src/core/vox/transcript.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = DEFAULT_TRANSCRIPT_RETENTION_DAYS * DAY_MS;

async function scratch(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "atmux-vox-transcript-"));
}

/** Write a file and stamp its mtime to `ageMs` before `now`. */
async function agedFile(dir: string, name: string, now: number, ageMs: number): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, "x\n", "utf8");
  const seconds = (now - ageMs) / 1000;
  await utimes(path, seconds, seconds);
  return path;
}

// ---------- location + naming ----------

describe("resolveTranscriptDir", () => {
  test("resolves $HOME/.atmux/vox-logs — atmux's own state dir (ADR-268)", () => {
    expect(resolveTranscriptDir({ env: { HOME: "/home/op" } })).toBe(
      `/home/op/${VOX_TRANSCRIPT_DIR_REL}`,
    );
    expect(VOX_TRANSCRIPT_DIR_REL).toBe(".atmux/vox-logs");
  });

  test.each([
    ["unset", {}],
    ["empty", { HOME: "" }],
  ])("falls back to os.homedir() when $HOME is %s", (_name, env) => {
    expect(resolveTranscriptDir({ env })).toBe(join(homedir(), VOX_TRANSCRIPT_DIR_REL));
  });

  test("reads process.env when no env is injected", () => {
    // The production call passes `env`; this covers the default arm and
    // proves it lands in the same place.
    expect(resolveTranscriptDir()).toBe(
      join(process.env.HOME ?? homedir(), VOX_TRANSCRIPT_DIR_REL),
    );
  });

  test("there is NO directory override — the only knobs are boolean + retention", async () => {
    // A path override is how a transcript ends up inside a product
    // checkout (ADR-268) or on a synced path. Assert the module exports no
    // way to point the directory anywhere but $HOME: same env, same dir,
    // whatever else is set.
    const noisy = {
      HOME: "/home/op",
      ATMUX_VOX_TRANSCRIPT_DIR: "/repo/product/logs",
      ATMUX_VOX_LOG_DIR: "/repo/product/logs",
    };
    expect(resolveTranscriptDir({ env: noisy })).toBe(`/home/op/${VOX_TRANSCRIPT_DIR_REL}`);
    // Resolved from this file, not from the cwd — the suite must not
    // depend on being launched from the repo root.
    const source = await readFile(
      resolve(import.meta.dir, "../../../../src/core/vox/transcript.ts"),
      "utf8",
    );
    expect(source).not.toContain("ATMUX_VOX_TRANSCRIPT_DIR");
  });
});

describe("transcriptFileName", () => {
  test("carries the session id, prefixed and suffixed", () => {
    expect(transcriptFileName("01920af7-c0de")).toBe("vox-01920af7-c0de.jsonl");
  });

  test.each([
    ["../../etc/passwd", "vox-______etc_passwd.jsonl"],
    ["a/b", "vox-a_b.jsonl"],
    ["with space", "vox-with_space.jsonl"],
    ["dots.and.dots", "vox-dots_and_dots.jsonl"],
  ])("sanitizes %s so it cannot escape the directory", (id, expected) => {
    const name = transcriptFileName(id);
    expect(name).toBe(expected);
    expect(name).not.toContain("/");
    expect(TRANSCRIPT_FILE_RE.test(name)).toBe(true);
  });

  test("an id that sanitizes to nothing still yields a prunable name", () => {
    expect(transcriptFileName("")).toBe("vox-session.jsonl");
    expect(TRANSCRIPT_FILE_RE.test(transcriptFileName("///"))).toBe(true);
  });

  test("a pathological id is capped at 64 characters and stays prunable", () => {
    const name = transcriptFileName("z".repeat(500));
    expect(name).toBe(`vox-${"z".repeat(64)}.jsonl`);
    expect(TRANSCRIPT_FILE_RE.test(name)).toBe(true);
  });
});

// ---------- the sink ----------

describe("createTranscriptSink", () => {
  test("writes ONE file per session with the id in its name, and the exact line content", async () => {
    const dir = await scratch();
    try {
      const sink = createTranscriptSink({
        sessionId: "sess-abc",
        dir,
        clock: () => 1_755_000_000_000,
      });
      expect(sink.path).toBe(join(dir, "vox-sess-abc.jsonl"));
      sink.record({ role: "user", text: "what is the fleet doing" });

      const text = await readFile(sink.path, "utf8");
      expect(text.endsWith("\n")).toBe(true);
      const rows = text.trim().split("\n");
      expect(rows).toHaveLength(1);
      const row = JSON.parse(rows[0] as string) as Record<string, unknown>;
      // EXACT key set — the same posture as the `ready`-frame test. A
      // superset check would pass while a new field leaked speech-adjacent
      // data (tool arguments, a confirm token) into the record.
      expect(Object.keys(row).sort()).toEqual(["iso", "role", "session", "text", "ts"]);
      expect(row).toEqual({
        ts: 1_755_000_000_000,
        iso: "2025-08-12T12:00:00.000Z",
        session: "sess-abc",
        role: "user",
        text: "what is the fleet doing",
      });
      expect(await readdir(dir)).toEqual(["vox-sess-abc.jsonl"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("appends — a second utterance never overwrites the first", async () => {
    const dir = await scratch();
    try {
      let now = 1_000;
      const sink = createTranscriptSink({ sessionId: "s2", dir, clock: () => now });
      sink.record({ role: "user", text: "status of atmux" });
      now = 2_000;
      sink.record({ role: "assistant", text: "four members up" });
      const rows = (await readFile(sink.path, "utf8"))
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(rows.map((r) => [r.ts, r.role, r.text])).toEqual([
        [1_000, "user", "status of atmux"],
        [2_000, "assistant", "four members up"],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("creates the file LAZILY — a session where nobody spoke leaves nothing behind", async () => {
    const dir = await scratch();
    try {
      const nested = join(dir, "vox-logs");
      const sink = createTranscriptSink({ sessionId: "silent", dir: nested });
      expect(sink.path).toBe(join(nested, "vox-silent.jsonl"));
      // Not even the directory: one less recording is the safer default.
      await expect(stat(nested)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the file is owner-only (0600) inside an owner-only directory (0700)", async () => {
    const dir = await scratch();
    try {
      const nested = join(dir, "vox-logs");
      const sink = createTranscriptSink({ sessionId: "modes", dir: nested });
      sink.record({ role: "user", text: "private" });
      // eslint-disable-next-line no-bitwise -- permission bits
      expect((await stat(sink.path)).mode & 0o777).toBe(0o600);
      expect((await stat(nested)).mode & 0o777).toBe(0o700);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("uses the real clock when none is injected", async () => {
    const dir = await scratch();
    try {
      const before = Date.now();
      const sink = createTranscriptSink({ sessionId: "clock", dir });
      sink.record({ role: "assistant", text: "ok" });
      const row = JSON.parse((await readFile(sink.path, "utf8")).trim()) as { ts: number };
      expect(row.ts).toBeGreaterThanOrEqual(before);
      expect(row.ts).toBeLessThanOrEqual(Date.now());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a write failure NEVER propagates, logs once, and keeps trying", async () => {
    const logs: string[] = [];
    let attempts = 0;
    const sink = createTranscriptSink({
      sessionId: "s3",
      dir: "/nowhere",
      log: (l) => logs.push(l),
      append: () => {
        attempts += 1;
        throw new Error("ENOSPC: no space left on device");
      },
    });
    // A throw here would come out of the provider-event pump and take down
    // a live call to protect a log file.
    expect(() => sink.record({ role: "user", text: "one" })).not.toThrow();
    expect(() => sink.record({ role: "user", text: "two" })).not.toThrow();
    expect(() => sink.record({ role: "user", text: "three" })).not.toThrow();
    expect(attempts).toBe(3); // still attempted — a transient fault self-heals
    expect(logs).toHaveLength(1); // one line, not one per utterance
    expect(logs[0]).toContain("transcript write failed");
    expect(logs[0]).toContain("ENOSPC");
    // The failure line must not quote what was said.
    expect(logs[0]).not.toContain("one");
  });

  test("a non-Error throw is still rendered, and still swallowed", () => {
    const logs: string[] = [];
    const sink = createTranscriptSink({
      sessionId: "s4",
      dir: "/nowhere",
      log: (l) => logs.push(l),
      append: () => {
        const v: unknown = 42;
        throw v;
      },
    });
    sink.record({ role: "user", text: "x" });
    expect(logs[0]).toContain("42");
  });

  test("a write failure with no log sink is silent, not fatal", () => {
    const sink = createTranscriptSink({
      sessionId: "s5",
      dir: "/nowhere",
      append: () => {
        throw new Error("boom");
      },
    });
    expect(() => sink.record({ role: "user", text: "x" })).not.toThrow();
  });
});

// ---------- retention ----------

describe("pruneTranscripts — the 7-day boundary", () => {
  test("keeps a file EXACTLY at the retention edge and removes one past it", async () => {
    const dir = await scratch();
    const now = Date.parse("2026-08-15T00:00:00.000Z");
    try {
      const atEdge = await agedFile(dir, "vox-edge.jsonl", now, RETENTION_MS);
      const pastEdge = await agedFile(dir, "vox-past.jsonl", now, RETENTION_MS + 1000);
      const result = await pruneTranscripts({ dir, retentionMs: RETENTION_MS, now: () => now });
      expect(result).toEqual({ removed: 1, kept: 1, skipped: 0, errors: 0 });
      // Seven full days are KEPT — "7-day retention" is not "six and a bit".
      expect(await stat(atEdge)).toBeDefined();
      await expect(stat(pastEdge)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a 7-day-old file survives and an 8-day-old file is deleted", async () => {
    const dir = await scratch();
    const now = Date.parse("2026-08-15T00:00:00.000Z");
    try {
      const sevenDays = await agedFile(dir, "vox-seven.jsonl", now, 7 * DAY_MS);
      const eightDays = await agedFile(dir, "vox-eight.jsonl", now, 8 * DAY_MS);
      const fresh = await agedFile(dir, "vox-fresh.jsonl", now, 60_000);
      const result = await pruneTranscripts({ dir, retentionMs: RETENTION_MS, now: () => now });
      expect(result).toMatchObject({ removed: 1, kept: 2, errors: 0 });
      expect(await readdir(dir)).toEqual(
        expect.arrayContaining(["vox-seven.jsonl", "vox-fresh.jsonl"]),
      );
      expect(await readdir(dir)).not.toContain("vox-eight.jsonl");
      expect(await stat(sevenDays)).toBeDefined();
      expect(await stat(fresh)).toBeDefined();
      await expect(stat(eightDays)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the window follows the CONFIGURED retention, not a hardcoded 7 days", async () => {
    const dir = await scratch();
    const now = Date.parse("2026-08-15T00:00:00.000Z");
    try {
      await agedFile(dir, "vox-two-days.jsonl", now, 2 * DAY_MS);
      const result = await pruneTranscripts({
        dir,
        retentionMs: retentionMsForDays(1),
        now: () => now,
      });
      expect(result).toMatchObject({ removed: 1, kept: 0 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("pruneTranscripts — deletes ONLY what it owns", () => {
  test("ancient non-transcript entries in the same directory are untouched", async () => {
    const dir = await scratch();
    const now = Date.parse("2026-08-15T00:00:00.000Z");
    const ancient = 400 * DAY_MS;
    try {
      // Everything here is far past retention. Only the first is ours.
      await agedFile(dir, "vox-mine.jsonl", now, ancient);
      await agedFile(dir, "notes.txt", now, ancient);
      await agedFile(dir, "vox-abc.jsonl.bak", now, ancient);
      await agedFile(dir, "vox-.jsonl", now, ancient); // no id → not ours
      await agedFile(dir, "vox-abc.json", now, ancient);
      await agedFile(dir, "vox-bad name.jsonl", now, ancient);
      // ADR-274: pre-rename transcripts are `voice-*.jsonl`. They are NOT
      // ours any more, so the pruner leaves them — asserted rather than
      // assumed, because "the sweep silently stopped collecting the old
      // names" is exactly the kind of rename fallout that goes unnoticed.
      // They also live in the old `~/.atmux/voice-logs/` dir, which this
      // pruner never opens; this row pins the file-name half.
      await agedFile(dir, "voice-legacy.jsonl", now, ancient);
      const subdir = join(dir, "vox-subdir.jsonl"); // a DIRECTORY named like one
      await mkdir(subdir);

      const result = await pruneTranscripts({ dir, retentionMs: RETENTION_MS, now: () => now });
      expect(result).toMatchObject({ removed: 1, kept: 0, skipped: 7, errors: 0 });
      const left = (await readdir(dir)).sort();
      expect(left).toEqual([
        "notes.txt",
        "voice-legacy.jsonl",
        "vox-.jsonl",
        "vox-abc.json",
        "vox-abc.jsonl.bak",
        "vox-bad name.jsonl",
        "vox-subdir.jsonl",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("TRANSCRIPT_FILE_RE matches exactly the names the sink produces", () => {
    expect(TRANSCRIPT_FILE_RE.test(transcriptFileName("01920af7c0de"))).toBe(true);
    for (const bad of [
      "vox-.jsonl",
      "vox-a.jsonl.bak",
      "notes.txt",
      "vox-a b.jsonl",
      "../vox-a.jsonl",
      "vox-a.json",
    ]) {
      expect(TRANSCRIPT_FILE_RE.test(bad)).toBe(false);
    }
  });
});

describe("pruneTranscripts — never takes the server down", () => {
  test("a missing directory is normal, not an error", async () => {
    const result = await pruneTranscripts({
      dir: join(tmpdir(), "atmux-vox-does-not-exist-ever"),
      retentionMs: RETENTION_MS,
      now: () => 0,
    });
    expect(result).toEqual({ removed: 0, kept: 0, skipped: 0, errors: 0 });
  });

  test("a non-ENOENT listing failure is counted and swallowed", async () => {
    const fs: TranscriptFs = {
      list: async () => {
        throw new Error("EACCES: permission denied");
      },
      mtimeMs: async () => 0,
      remove: async () => {},
    };
    const result = await pruneTranscripts({
      dir: "/x",
      retentionMs: RETENTION_MS,
      now: () => 0,
      fs,
    });
    expect(result).toEqual({ removed: 0, kept: 0, skipped: 0, errors: 1 });
  });

  test("one undeletable file is counted and the sweep continues to the next", async () => {
    const removed: string[] = [];
    const fs: TranscriptFs = {
      list: async () => [
        { name: "vox-a.jsonl", isFile: true },
        { name: "vox-b.jsonl", isFile: true },
      ],
      mtimeMs: async () => 0,
      remove: async (path) => {
        if (path.endsWith("vox-a.jsonl")) throw new Error("EPERM");
        removed.push(path);
      },
    };
    const result = await pruneTranscripts({
      dir: "/x",
      retentionMs: 1,
      now: () => 10_000,
      fs,
    });
    expect(result).toMatchObject({ removed: 1, errors: 1 });
    expect(removed).toEqual(["/x/vox-b.jsonl"]);
  });

  test("a file that vanishes mid-sweep is neither removed nor an error", async () => {
    const fs: TranscriptFs = {
      list: async () => [{ name: "vox-gone.jsonl", isFile: true }],
      mtimeMs: async () => null,
      remove: async () => {
        throw new Error("must not be called");
      },
    };
    const result = await pruneTranscripts({ dir: "/x", retentionMs: 1, now: () => 1, fs });
    expect(result).toEqual({ removed: 0, kept: 0, skipped: 0, errors: 0 });
  });
});

describe("nodeTranscriptFs", () => {
  test("lists files vs directories, stats mtimes, and removes", async () => {
    const dir = await scratch();
    try {
      await writeFile(join(dir, "f.jsonl"), "x", "utf8");
      await mkdir(join(dir, "d"));
      const entries = (await nodeTranscriptFs.list(dir)).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      expect(entries).toEqual([
        { name: "d", isFile: false },
        { name: "f.jsonl", isFile: true },
      ]);
      expect(await nodeTranscriptFs.mtimeMs(join(dir, "f.jsonl"))).toBeGreaterThan(0);
      await nodeTranscriptFs.remove(join(dir, "f.jsonl"));
      expect(await readdir(dir)).toEqual(["d"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("mtimeMs answers null for a missing file and rethrows anything else", async () => {
    expect(await nodeTranscriptFs.mtimeMs(join(tmpdir(), "atmux-vox-absent-file"))).toBeNull();
    const dir = await scratch();
    try {
      // A path whose PARENT is a file yields ENOTDIR, not ENOENT — the
      // arm that must propagate rather than read as "absent".
      await writeFile(join(dir, "file"), "x", "utf8");
      await expect(nodeTranscriptFs.mtimeMs(join(dir, "file", "child"))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("formatPruneResult + retentionMsForDays", () => {
  test("renders every counter and the directory", () => {
    expect(
      formatPruneResult("/home/op/.atmux/vox-logs", {
        removed: 2,
        kept: 5,
        skipped: 1,
        errors: 0,
      }),
    ).toBe(
      "vox: transcript prune /home/op/.atmux/vox-logs — removed 2, kept 5, skipped 1, errors 0",
    );
  });

  test("retention days convert to ms; the shipped default is 7 days", () => {
    expect(retentionMsForDays(7)).toBe(7 * DAY_MS);
    expect(retentionMsForDays(1)).toBe(DAY_MS);
    expect(DEFAULT_TRANSCRIPT_RETENTION_DAYS).toBe(7);
  });
});

// ---------- the daily loop ----------

describe("startTranscriptPruneLoop", () => {
  class FakeTimers {
    private seq = 0;
    readonly pending = new Map<number, { at: number; fn: () => void }>();
    now = 0;

    setTimeout(fn: () => void, ms: number): unknown {
      this.seq += 1;
      this.pending.set(this.seq, { at: this.now + ms, fn });
      return this.seq;
    }

    clearTimeout(handle: unknown): void {
      this.pending.delete(handle as number);
    }

    /** Fire every timer due at or before `now + ms`, settling between. */
    async advance(ms: number): Promise<void> {
      const target = this.now + ms;
      for (;;) {
        const due = [...this.pending.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        this.pending.delete(due[0]);
        this.now = due[1].at;
        due[1].fn();
        await new Promise<void>((r) => setTimeout(r, 0));
      }
      this.now = target;
    }
  }

  test("sweeps once a day and re-arms after each sweep", async () => {
    const timers = new FakeTimers();
    let sweeps = 0;
    const stop = startTranscriptPruneLoop({
      timers,
      run: async () => {
        sweeps += 1;
      },
    });
    expect(sweeps).toBe(0); // the BOOT sweep is the caller's, not the loop's
    await timers.advance(TRANSCRIPT_PRUNE_INTERVAL_MS);
    expect(sweeps).toBe(1);
    await timers.advance(TRANSCRIPT_PRUNE_INTERVAL_MS);
    expect(sweeps).toBe(2);
    stop();
  });

  test("honours an interval override", async () => {
    const timers = new FakeTimers();
    let sweeps = 0;
    const stop = startTranscriptPruneLoop({
      timers,
      intervalMs: 50,
      run: async () => {
        sweeps += 1;
      },
    });
    await timers.advance(150);
    expect(sweeps).toBe(3);
    stop();
  });

  test("stop() clears the armed timer — a 24h timer must not outlive the server", async () => {
    const timers = new FakeTimers();
    let sweeps = 0;
    const stop = startTranscriptPruneLoop({
      timers,
      run: async () => {
        sweeps += 1;
      },
    });
    expect(timers.pending.size).toBe(1);
    stop();
    expect(timers.pending.size).toBe(0);
    await timers.advance(10 * TRANSCRIPT_PRUNE_INTERVAL_MS);
    expect(sweeps).toBe(0);
  });

  test("stop() during an in-flight sweep does not re-arm", async () => {
    const timers = new FakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let sweeps = 0;
    const stop = startTranscriptPruneLoop({
      timers,
      run: async () => {
        sweeps += 1;
        await gate;
      },
    });
    await timers.advance(TRANSCRIPT_PRUNE_INTERVAL_MS);
    expect(sweeps).toBe(1);
    stop(); // stops while the sweep is still running
    release();
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(timers.pending.size).toBe(0);
  });

  test("stop() is idempotent", () => {
    const timers = new FakeTimers();
    const stop = startTranscriptPruneLoop({ timers, run: async () => {} });
    stop();
    stop();
    expect(timers.pending.size).toBe(0);
  });

  test("a sweep that THROWS does not stop the daily cadence", async () => {
    const timers = new FakeTimers();
    let sweeps = 0;
    const stop = startTranscriptPruneLoop({
      timers,
      intervalMs: 10,
      run: async () => {
        sweeps += 1;
        throw new Error("prune blew up");
      },
    });
    await timers.advance(30);
    // A caller bug must not silently end retention — the loop keeps going.
    expect(sweeps).toBe(3);
    stop();
  });
});
