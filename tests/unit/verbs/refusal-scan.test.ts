// Unit tests for src/verbs/refusal-scan.ts (ADR-139 §D2 / T3, t-841049e4).
//
// The verb is a thin orchestration wrapper around
// `scanTeamForRefusals` from `src/core/refusal-scan.ts` (which has its
// own deep unit coverage in tests/unit/core/refusal-scan.test.ts).
// These tests pin the verb-layer contract:
//   - `parseRefusalScanArgs` honours every documented flag combination
//     and surfaces UsageError on bad input
//   - `refusalScan` resolves the team via `--team-dir`, threads deps
//     through to the core scanner, emits the JSON one-liner on stdout,
//     and returns exit code 0 on the happy path
//   - `--json` is accepted (forward-compat reservation per the verb
//     header comment) but does not currently alter the output shape
//
// The core scanner's `RefusalScanDeps` seam lets us pin the DB to an
// in-memory bun:sqlite handle + pin clock + classifier, so there is
// no tmux dependency in the test path.

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import type { RefusalDetectionResult } from "../../../src/core/refusal-classifier.ts";
import type { RefusalScanDeps, RefusalScanResult } from "../../../src/core/refusal-scan.ts";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import { parseRefusalScanArgs, refusalScan } from "../../../src/verbs/refusal-scan.ts";

// ---------- parseRefusalScanArgs ----------

describe("parseRefusalScanArgs", () => {
  test("no args → defaults (json=false, no teamDir)", () => {
    expect(parseRefusalScanArgs([])).toEqual({ json: false });
  });

  test("--json → json=true", () => {
    expect(parseRefusalScanArgs(["--json"])).toEqual({ json: true });
  });

  test("--team-dir <dir> captured", () => {
    expect(parseRefusalScanArgs(["--team-dir", "/srv/demo"])).toEqual({
      json: false,
      teamDir: "/srv/demo",
    });
  });

  test("--team-dir + --json combined (team-dir first)", () => {
    expect(parseRefusalScanArgs(["--team-dir", "/x", "--json"])).toEqual({
      json: true,
      teamDir: "/x",
    });
  });

  test("--json + --team-dir combined (json first)", () => {
    expect(parseRefusalScanArgs(["--json", "--team-dir", "/x"])).toEqual({
      json: true,
      teamDir: "/x",
    });
  });

  test("--team-dir without value → UsageError", () => {
    expect(() => parseRefusalScanArgs(["--team-dir"])).toThrow(UsageError);
  });

  test("unknown flag → UsageError", () => {
    expect(() => parseRefusalScanArgs(["--bogus"])).toThrow(UsageError);
  });

  test("positional arg → UsageError", () => {
    expect(() => parseRefusalScanArgs(["positional"])).toThrow(UsageError);
  });

  test("--team-dir consumed before trailing unknown flag still raises on unknown", () => {
    expect(() => parseRefusalScanArgs(["--team-dir", "/x", "--bogus"])).toThrow(UsageError);
  });
});

// ---------- refusalScan (verb orchestration) ----------
//
// Per the codebase pattern in tests/unit/verbs/complaints.test.ts:
// AsyncLocalStorage-scoped stdout capture so concurrent test cases
// don't trample each other when bun:test parallelises.

const captureStorage = new AsyncLocalStorage<{ chunks: string[] }>();
let capturePatched = false;
function installStdoutCapture(): void {
  if (capturePatched) return;
  capturePatched = true;
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string | Uint8Array, ...rest: unknown[]) => {
    const store = captureStorage.getStore();
    if (store !== undefined) {
      store.chunks.push(typeof s === "string" ? s : new TextDecoder().decode(s));
      return true;
    }
    return (orig as (...args: unknown[]) => boolean)(s, ...rest);
  }) as typeof process.stdout.write;
}

async function captureStdout<T>(fn: () => Promise<T>): Promise<{ out: string; result: T }> {
  installStdoutCapture();
  const store = { chunks: [] as string[] };
  const result = await captureStorage.run(store, fn);
  return { out: store.chunks.join(""), result };
}

function openMem(): { db: Database; close: () => void } {
  const db = openDatabase(":memory:", migrations);
  return { db, close: () => closeDatabase(db) };
}

function noneDetection(): RefusalDetectionResult {
  return { detected: false, severity: "none", confidence: 0, phrases: [] };
}

function softDetection(): RefusalDetectionResult {
  return {
    detected: true,
    severity: "soft",
    confidence: 0.9,
    phrases: [{ phrase: "I cannot help", class: "soft" }],
  };
}

let scratch: string;
let atmuxDir: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atmux-refusal-scan-verb-"));
  atmuxDir = join(scratch, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("refusalScan (verb)", () => {
  test("empty team + no state.db → JSON one-liner with zero counters, exit 0", async () => {
    // No state.db file: core short-circuits to a fully no-op result
    // without ever invoking tmux. The verb still emits the JSON
    // summary so cron tail can distinguish a no-op tick from a crash.
    await writeFile(join(atmuxDir, "team.json"), JSON.stringify({ name: "demo", members: [] }));

    const { out, result } = await captureStdout(() => refusalScan(["--team-dir", scratch]));

    expect(result).toBe(0);
    expect(out.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(out.trim()) as RefusalScanResult;
    expect(parsed).toEqual({
      scanned: 0,
      detected: 0,
      recorded: 0,
      deduped: 0,
      perMember: [],
    });
  });

  test("--json flag accepted; output shape identical (forward-compat reservation)", async () => {
    await writeFile(join(atmuxDir, "team.json"), JSON.stringify({ name: "demo", members: [] }));

    const { out, result } = await captureStdout(() =>
      refusalScan(["--team-dir", scratch, "--json"]),
    );

    expect(result).toBe(0);
    const parsed = JSON.parse(out.trim()) as RefusalScanResult;
    expect(parsed).toEqual({
      scanned: 0,
      detected: 0,
      recorded: 0,
      deduped: 0,
      perMember: [],
    });
  });

  test("members with injected deps (no tmux): per-member outcomes flow through to JSON", async () => {
    // Two members: alpha returns a soft refusal, bravo returns clean.
    // Injected `openDb` keeps the write to an in-memory DB; injected
    // `paneCapture` keeps tmux out of the test path entirely.
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({
        name: "demo",
        members: [
          { name: "alpha", role: "member" },
          { name: "bravo", role: "member" },
        ],
      }),
    );

    const captures: string[] = [];
    const deps: RefusalScanDeps = {
      openDb: openMem,
      paneCapture: async (target: string) => {
        captures.push(target);
        return target.includes("alpha") ? "alpha-pane-body" : "bravo-pane-body";
      },
      classify: (capture: string) =>
        capture.startsWith("alpha") ? softDetection() : noneDetection(),
      nowSec: () => 1_700_000_000,
      log: () => {
        /* swallow stderr noise */
      },
    };

    const { out, result } = await captureStdout(() => refusalScan(["--team-dir", scratch], deps));

    expect(result).toBe(0);
    expect(captures).toHaveLength(2);
    const parsed = JSON.parse(out.trim()) as RefusalScanResult;
    expect(parsed.scanned).toBe(2);
    expect(parsed.detected).toBe(1);
    expect(parsed.recorded).toBe(1);
    expect(parsed.deduped).toBe(0);
    expect(parsed.perMember).toHaveLength(2);
    const alpha = parsed.perMember.find((m) => m.member === "alpha");
    const bravo = parsed.perMember.find((m) => m.member === "bravo");
    expect(alpha?.severity).toBe("soft");
    expect(alpha?.recorded).toBe(true);
    expect(bravo?.severity).toBe("none");
    expect(bravo?.recorded).toBe(false);
  });

  test("missing team.json → ConfigError (requireTeam contract)", async () => {
    // atmuxDir exists but no team.json inside — requireTeam should fail
    // closed so the cron tick surfaces config rot rather than silently
    // recording a no-op.
    await expect(refusalScan(["--team-dir", scratch])).rejects.toThrow(ConfigError);
  });

  test("--team-dir resolution routes through the supplied directory", async () => {
    // Seed two distinct team.json files in sibling temp dirs; verify
    // that --team-dir actually picks the one we point to (verb returns
    // 0 and emits a JSON summary for the chosen team).
    const otherScratch = await mkdtemp(join(tmpdir(), "atmux-refusal-scan-other-"));
    try {
      const otherAtmuxDir = join(otherScratch, ".atmux");
      await mkdir(otherAtmuxDir, { recursive: true });
      await writeFile(
        join(atmuxDir, "team.json"),
        JSON.stringify({ name: "demo-primary", members: [] }),
      );
      await writeFile(
        join(otherAtmuxDir, "team.json"),
        JSON.stringify({ name: "demo-other", members: [] }),
      );

      const { result: r1 } = await captureStdout(() => refusalScan(["--team-dir", scratch]));
      const { result: r2 } = await captureStdout(() => refusalScan(["--team-dir", otherScratch]));

      expect(r1).toBe(0);
      expect(r2).toBe(0);
    } finally {
      await rm(otherScratch, { recursive: true, force: true });
    }
  });

  test("invalid argv surfaces UsageError before any team resolution", async () => {
    // No team.json on disk, but the unknown-flag check should fire
    // first — `parseRefusalScanArgs` runs before `requireTeam`.
    await expect(refusalScan(["--bogus"])).rejects.toThrow(UsageError);
  });
});
