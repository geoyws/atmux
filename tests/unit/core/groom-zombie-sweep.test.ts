// Unit tests for `sweepZombieTmuxSockets` sub-op (t-0027eec3,
// c-4698c603 arm b). Defense-in-depth for SIGKILL'd bun-test orphans
// that bypass the (a) primary fix (afterAll + process.on('exit')
// hooks shipped in t-88b60ca7).

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultKillServer,
  sweepZombieTmuxSockets,
  type ZombieSweepResult,
} from "../../../src/core/groom.ts";

// Pin clock at 2026-05-16 12:00 UTC; 6h default threshold means
// anything mtime'd at or before 06:00 UTC is sweep-eligible.
const RUN_MS = Date.UTC(2026, 4, 16, 12, 0, 0);
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

interface Env {
  /** Scratch tmpdir mimicking `os.tmpdir()` so the sweep walks fixture
   *  dirs instead of the host's real /tmp. */
  fakeTmp: string;
  /** Records every `killServer` call from the sub-op. */
  killCalls: string[];
}

let env: Env;

beforeEach(async () => {
  env = {
    fakeTmp: await mkdtemp(join(tmpdir(), "atmux-groom-zombie-test-host-")),
    killCalls: [],
  };
});

afterEach(async () => {
  await rm(env.fakeTmp, { recursive: true, force: true });
});

async function makeFixtureDir(
  name: string,
  opts: { ageMs: number; sock?: "direct" | "tmux-uid" | "none" } = { ageMs: 0 },
): Promise<string> {
  const dir = join(env.fakeTmp, name);
  await mkdir(dir, { recursive: true });
  const sock = opts.sock ?? "direct";
  if (sock === "direct") {
    await writeFile(join(dir, "sock"), "");
  } else if (sock === "tmux-uid") {
    const uidDir = join(dir, "tmux-1000");
    await mkdir(uidDir, { recursive: true });
    await writeFile(join(uidDir, "default"), "");
  }
  // Backdate parent dir mtime so the age gate triggers.
  const mtime = new Date(RUN_MS - opts.ageMs);
  await utimes(dir, mtime, mtime);
  return dir;
}

const stubKill = (env: Env) => async (sock: string) => {
  env.killCalls.push(sock);
};

describe("sweepZombieTmuxSockets", () => {
  test("removes stale fixture dir matching atmux-* pattern", async () => {
    const dir = await makeFixtureDir("atmux-e2e-cockpit-rebuild-AbCdEf", {
      ageMs: SIX_HOURS_MS + 1000,
    });

    const r = await sweepZombieTmuxSockets({
      tmpDir: env.fakeTmp,
      nowMs: RUN_MS,
      killServer: stubKill(env),
    });

    expect(r.scanned).toBe(1);
    expect(r.killed).toBe(1);
    expect(r.removed).toBe(1);
    expect(r.errors).toEqual([]);
    expect(env.killCalls).toEqual([join(dir, "sock")]);
    expect(await stat(dir).catch(() => null)).toBeNull();
  });

  test("matches atmux-cockpit-* nested fixture shape (c-4698c603)", async () => {
    const dir = await makeFixtureDir("atmux-cockpit-cockpit-reb-sd-XYZ123", {
      ageMs: SIX_HOURS_MS + 1000,
    });

    const r = await sweepZombieTmuxSockets({
      tmpDir: env.fakeTmp,
      nowMs: RUN_MS,
      killServer: stubKill(env),
    });

    expect(r.scanned).toBe(1);
    expect(r.removed).toBe(1);
    expect(await stat(dir).catch(() => null)).toBeNull();
  });

  test("skips fixture dirs younger than minAgeMs (default 6h)", async () => {
    const dir = await makeFixtureDir("atmux-e2e-fresh-AAA", {
      ageMs: SIX_HOURS_MS - 60 * 1000, // 5h59m old
    });

    const r = await sweepZombieTmuxSockets({
      tmpDir: env.fakeTmp,
      nowMs: RUN_MS,
      killServer: stubKill(env),
    });

    expect(r.scanned).toBe(0);
    expect(r.removed).toBe(0);
    expect(env.killCalls).toEqual([]);
    expect(await stat(dir)).toBeDefined();
  });

  test("skips production-shape dirs (no trailing mkdtemp suffix)", async () => {
    // `/tmp/atmux-<teamname>/sock` is the production cage convention
    // (no trailing hyphen-suffix). Even if stale, it must NOT match.
    const dir = await makeFixtureDir("atmux-atmux", {
      ageMs: SIX_HOURS_MS + 24 * 60 * 60 * 1000, // 30h old
    });

    const r = await sweepZombieTmuxSockets({
      tmpDir: env.fakeTmp,
      nowMs: RUN_MS,
      killServer: stubKill(env),
    });

    expect(r.scanned).toBe(0);
    expect(r.removed).toBe(0);
    expect(await stat(dir)).toBeDefined();
  });

  test("skips unrelated /tmp entries (non atmux-* prefix)", async () => {
    const dir = await makeFixtureDir("totally-unrelated-XXX", {
      ageMs: SIX_HOURS_MS * 10,
    });

    const r = await sweepZombieTmuxSockets({
      tmpDir: env.fakeTmp,
      nowMs: RUN_MS,
      killServer: stubKill(env),
    });

    expect(r.scanned).toBe(0);
    expect(await stat(dir)).toBeDefined();
  });

  test("finds tmux-<uid>/default socket shape (team.tmuxTmpdir convention)", async () => {
    const dir = await makeFixtureDir("atmux-e2e-tmpdir-team-QQQ", {
      ageMs: SIX_HOURS_MS + 1000,
      sock: "tmux-uid",
    });

    const r = await sweepZombieTmuxSockets({
      tmpDir: env.fakeTmp,
      nowMs: RUN_MS,
      killServer: stubKill(env),
    });

    expect(r.scanned).toBe(1);
    expect(r.killed).toBe(1);
    expect(env.killCalls).toEqual([join(dir, "tmux-1000", "default")]);
  });

  test("removes dir with no socket inside (cleanup-only path)", async () => {
    const dir = await makeFixtureDir("atmux-e2e-nosock-FFF", {
      ageMs: SIX_HOURS_MS + 1000,
      sock: "none",
    });

    const r = await sweepZombieTmuxSockets({
      tmpDir: env.fakeTmp,
      nowMs: RUN_MS,
      killServer: stubKill(env),
    });

    expect(r.scanned).toBe(1);
    expect(r.killed).toBe(0);
    expect(r.removed).toBe(1);
    expect(env.killCalls).toEqual([]);
    expect(await stat(dir).catch(() => null)).toBeNull();
  });

  test("dryRun reports counts but does NOT touch fs or call killServer", async () => {
    const dir = await makeFixtureDir("atmux-e2e-dry-DRY", {
      ageMs: SIX_HOURS_MS + 1000,
    });

    const r = await sweepZombieTmuxSockets({
      tmpDir: env.fakeTmp,
      nowMs: RUN_MS,
      dryRun: true,
      killServer: stubKill(env),
    });

    expect(r.scanned).toBe(1);
    expect(r.killed).toBe(0);
    expect(r.removed).toBe(0);
    expect(env.killCalls).toEqual([]);
    expect(await stat(dir)).toBeDefined();
  });

  test("idempotent — second run finds nothing", async () => {
    await makeFixtureDir("atmux-e2e-repeat-AAA", {
      ageMs: SIX_HOURS_MS + 1000,
    });

    const first = await sweepZombieTmuxSockets({
      tmpDir: env.fakeTmp,
      nowMs: RUN_MS,
      killServer: stubKill(env),
    });
    expect(first.removed).toBe(1);

    const second = await sweepZombieTmuxSockets({
      tmpDir: env.fakeTmp,
      nowMs: RUN_MS,
      killServer: stubKill(env),
    });
    expect(second.scanned).toBe(0);
    expect(second.killed).toBe(0);
    expect(second.removed).toBe(0);
  });

  test("tolerates 'no server running' errors from killServer (expected)", async () => {
    await makeFixtureDir("atmux-e2e-noserv-NOS", {
      ageMs: SIX_HOURS_MS + 1000,
    });
    const r = await sweepZombieTmuxSockets({
      tmpDir: env.fakeTmp,
      nowMs: RUN_MS,
      killServer: async () => {
        throw new Error("no server running on /tmp/...");
      },
    });
    expect(r.scanned).toBe(1);
    expect(r.killed).toBe(0); // attemptedKill==false (every kill threw before flipping the flag)
    expect(r.removed).toBe(1);
    expect(r.errors).toEqual([]); // expected-class errors are swallowed
  });

  test("surfaces unexpected kill errors on result.errors", async () => {
    const dir = await makeFixtureDir("atmux-e2e-permerr-PRM", {
      ageMs: SIX_HOURS_MS + 1000,
    });
    const r = await sweepZombieTmuxSockets({
      tmpDir: env.fakeTmp,
      nowMs: RUN_MS,
      killServer: async () => {
        throw new Error("permission denied");
      },
    });
    expect(r.scanned).toBe(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.path).toBe(join(dir, "sock"));
    expect(r.errors[0]?.message).toContain("permission denied");
  });

  test("custom minAgeMs (1h) catches fresher fixtures", async () => {
    const dir = await makeFixtureDir("atmux-e2e-shortwin-SHW", {
      ageMs: 70 * 60 * 1000, // 1h10m
    });

    const r = await sweepZombieTmuxSockets({
      tmpDir: env.fakeTmp,
      nowMs: RUN_MS,
      minAgeMs: 60 * 60 * 1000, // 1h
      killServer: stubKill(env),
    });

    expect(r.scanned).toBe(1);
    expect(r.removed).toBe(1);
    expect(await stat(dir).catch(() => null)).toBeNull();
  });

  test("missing tmpDir returns clean empty result (cold-start safety)", async () => {
    const r = await sweepZombieTmuxSockets({
      tmpDir: join(env.fakeTmp, "does-not-exist"),
      nowMs: RUN_MS,
      killServer: stubKill(env),
    });
    expect(r).toEqual({ scanned: 0, killed: 0, removed: 0, skippedLiveChildren: 0, errors: [] });
  });

  test("skips file entries at tmpDir top (only directories matched)", async () => {
    await writeFile(join(env.fakeTmp, "atmux-e2e-not-a-dir-NAD"), "");

    const r = await sweepZombieTmuxSockets({
      tmpDir: env.fakeTmp,
      nowMs: RUN_MS,
      killServer: stubKill(env),
    });
    expect(r.scanned).toBe(0);
  });

  // ADR-252 (t-65bec10b) — structural live-epic-children guard.
  test("SKIPS removal + bumps skippedLiveChildren when guard reports live children", async () => {
    const dir = await makeFixtureDir("atmux-e2e-haslivekids-LIVE", {
      ageMs: SIX_HOURS_MS + 1000,
    });

    const guardCalls: string[] = [];
    const r = await sweepZombieTmuxSockets({
      tmpDir: env.fakeTmp,
      nowMs: RUN_MS,
      killServer: stubKill(env),
      hasLiveChildren: async (parentTmpdir) => {
        guardCalls.push(parentTmpdir);
        return true; // live epic child ⇒ refuse removal
      },
    });

    // Counted as scanned (age + pattern matched) but neither killed nor
    // removed — only skippedLiveChildren bumps.
    expect(r.scanned).toBe(1);
    expect(r.killed).toBe(0);
    expect(r.removed).toBe(0);
    expect(r.skippedLiveChildren).toBe(1);
    expect(r.errors).toEqual([]);
    // No kill attempted, and the dir survives untouched.
    expect(env.killCalls).toEqual([]);
    expect(await stat(dir)).toBeDefined();
    // Guard was consulted with the parent tmpdir path.
    expect(guardCalls).toEqual([dir]);
  });

  test("guard returning false ⇒ normal kill + remove (skippedLiveChildren stays 0)", async () => {
    const dir = await makeFixtureDir("atmux-e2e-nokids-DEAD", {
      ageMs: SIX_HOURS_MS + 1000,
    });

    const r = await sweepZombieTmuxSockets({
      tmpDir: env.fakeTmp,
      nowMs: RUN_MS,
      killServer: stubKill(env),
      hasLiveChildren: async () => false, // no live children ⇒ sweep proceeds
    });

    expect(r.scanned).toBe(1);
    expect(r.killed).toBe(1);
    expect(r.removed).toBe(1);
    expect(r.skippedLiveChildren).toBe(0);
    expect(await stat(dir).catch(() => null)).toBeNull();
  });

  test("dryRun never consults the guard (no removal to gate)", async () => {
    await makeFixtureDir("atmux-e2e-dry-noguard-DRY", {
      ageMs: SIX_HOURS_MS + 1000,
    });

    let guardCalled = false;
    const r = await sweepZombieTmuxSockets({
      tmpDir: env.fakeTmp,
      nowMs: RUN_MS,
      dryRun: true,
      killServer: stubKill(env),
      hasLiveChildren: async () => {
        guardCalled = true;
        return true;
      },
    });

    expect(r.scanned).toBe(1);
    expect(r.skippedLiveChildren).toBe(0);
    expect(guardCalled).toBe(false);
  });

  test("real default guard (no injection): plain fixture dir has no epics/ ⇒ removed", async () => {
    // No `hasLiveChildren` injection ⇒ the real hasLiveEpicChildren runs.
    // The fixture dir has no `epics/` subdir → ENOENT → [] → false →
    // removal proceeds. Guards against the default fail-safing the whole
    // sweep into a no-op.
    const dir = await makeFixtureDir("atmux-e2e-realdefault-RDF", {
      ageMs: SIX_HOURS_MS + 1000,
    });

    const r = await sweepZombieTmuxSockets({
      tmpDir: env.fakeTmp,
      nowMs: RUN_MS,
      killServer: stubKill(env),
    });

    expect(r.scanned).toBe(1);
    expect(r.skippedLiveChildren).toBe(0);
    expect(r.removed).toBe(1);
    expect(await stat(dir).catch(() => null)).toBeNull();
  });

  test("unremovable fixture dir → error row, never silent (t-b618e465)", async () => {
    // chmod-based removal denial is a no-op for uid 0 — same guard as
    // the lock audit-silence test.
    if (process.getuid?.() === 0) return;
    const dir = await makeFixtureDir("atmux-e2e-unremovable-URM", {
      ageMs: SIX_HOURS_MS + 1000,
      sock: "none",
    });
    // An unwritable child makes `rm -rf <full>` fail EACCES while
    // readdir/stat on <full> itself still succeed.
    const sub = join(dir, "sub");
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, "f"), "x");
    await chmod(sub, 0o555);
    // Creating sub/ refreshed the parent mtime — backdate again so the
    // age gate triggers (utimes needs parent-write, unaffected by sub).
    const { utimes } = await import("node:fs/promises");
    const old = new Date(RUN_MS - (6 * 60 * 60 * 1000 + 1000));
    await utimes(dir, old, old);

    let r: ZombieSweepResult | undefined;
    try {
      r = await sweepZombieTmuxSockets({
        tmpDir: env.fakeTmp,
        nowMs: RUN_MS,
        killServer: stubKill(env),
        // Pin the guard false: the real hasLiveChildCages could take
        // the skip path on the sub/ fixture and the rm catch under
        // test would never execute.
        hasLiveChildren: async () => false,
      });
    } finally {
      await chmod(sub, 0o755).catch(() => {});
    }
    expect(r?.scanned).toBe(1);
    expect(r?.removed).toBe(0);
    expect(r?.errors).toHaveLength(1);
    expect(r?.errors[0]?.path).toBe(dir);
    expect(typeof r?.errors[0]?.message).toBe("string");
  });

  test("non-Error killServer throw surfaces via String(e) (t-b618e465)", async () => {
    const dir = await makeFixtureDir("atmux-e2e-strthrow-STT", {
      ageMs: SIX_HOURS_MS + 1000,
      sock: "direct",
    });
    const r = await sweepZombieTmuxSockets({
      tmpDir: env.fakeTmp,
      nowMs: RUN_MS,
      killServer: async () => {
        throw "string-failure";
      },
    });
    expect(r.scanned).toBe(1);
    expect(r.killed).toBe(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.path).toBe(join(dir, "sock"));
    expect(r.errors[0]?.message).toBe("string-failure");
  });
  test("defaultKillServer delegates socketPath to the tmux server namespace (t-b618e465)", async () => {
    // Static import (groom.ts imports createTmux statically), so
    // mock.module reliably intercepts — unlike the lazy dynamic spawn
    // import that burned the vox seam test. No subprocess runs.
    const killCalls: string[] = [];
    const realTmux = await import("../../../src/abstractions/tmux.ts");
    const mockCreateTmux = (opts: { socketPath: string }) => ({
      server: {
        killServer: async () => {
          killCalls.push(opts.socketPath);
        },
      },
    });
    mock.module("../../../src/abstractions/tmux.ts", () => ({
      ...realTmux,
      createTmux: mockCreateTmux,
    }));
    try {
      await defaultKillServer(join(env.fakeTmp, "some-sock"));
      expect(killCalls).toEqual([join(env.fakeTmp, "some-sock")]);
    } finally {
      mock.restore();
    }
  });
});
