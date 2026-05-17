// Unit tests for src/verbs/complaints.ts (ADR-077 §F2).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import { ComplaintsRepo } from "../../../src/core/repositories/complaints-repo.ts";
import { UsageError } from "../../../src/errors.ts";
import { complaints, parseComplaintsArgs } from "../../../src/verbs/complaints.ts";

let teamDir: string;
let atmuxDir: string;

beforeEach(async () => {
  teamDir = await mkdtemp(join(tmpdir(), "atmux-complaints-team-"));
  atmuxDir = join(teamDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  await writeFile(
    join(atmuxDir, "team.json"),
    JSON.stringify({ name: "test-team", members: [{ name: "alpha" }] }),
  );
});

afterEach(async () => {
  await rm(teamDir, { recursive: true, force: true });
});

// AsyncLocalStorage-based capture: each captureStdout call gets an
// isolated buffer routed via async-context propagation, so concurrent
// callers under Promise.all don't trample each other's stdout (the
// prior monkey-patch-restore version observed an ~33% flake at the
// `file + file concurrent` sentinel test — t-5d04bddb root cause).
// The install is idempotent and global; when no captureStorage scope
// is active, writes fall through to the real stdout (so non-captured
// test output still surfaces).
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

// ---------- parseComplaintsArgs ----------

describe("parseComplaintsArgs", () => {
  test("rejects empty argv", () => {
    expect(() => parseComplaintsArgs([])).toThrow(UsageError);
  });

  test("rejects unknown sub-verb", () => {
    expect(() => parseComplaintsArgs(["frobnicate"])).toThrow(UsageError);
  });

  test("list (bare) parses with no flags", () => {
    const a = parseComplaintsArgs(["list"]);
    expect(a.subverb).toBe("list");
    expect(a.status).toBeUndefined();
    expect(a.all).toBeUndefined();
    expect(a.json).toBeUndefined();
  });

  test("list --status open|resolved|wontfix accepted", () => {
    expect(parseComplaintsArgs(["list", "--status", "open"]).status).toBe("open");
    expect(parseComplaintsArgs(["list", "--status", "resolved"]).status).toBe("resolved");
    expect(parseComplaintsArgs(["list", "--status", "wontfix"]).status).toBe("wontfix");
  });

  test("list --status with invalid value rejected", () => {
    expect(() => parseComplaintsArgs(["list", "--status", "bogus"])).toThrow(UsageError);
  });

  test("list --all + --status mutually exclusive", () => {
    expect(() => parseComplaintsArgs(["list", "--all", "--status", "open"])).toThrow(UsageError);
  });

  test("list --json sets json=true", () => {
    expect(parseComplaintsArgs(["list", "--json"]).json).toBe(true);
  });

  test("file requires --summary", () => {
    expect(() => parseComplaintsArgs(["file"])).toThrow(UsageError);
    expect(() => parseComplaintsArgs(["file", "--root-cause", "x"])).toThrow(UsageError);
  });

  test("file with --summary parses; root-cause/ask/by/related-task/kind optional", () => {
    const a = parseComplaintsArgs([
      "file",
      "--summary",
      "cage cycled",
      "--root-cause",
      "tests inside cage",
      "--ask",
      "use isolated cage",
      "--by",
      "superdoctor",
      "--related-task",
      "t-aaaaaaaa",
      "--kind",
      "incident",
    ]);
    expect(a.subverb).toBe("file");
    expect(a.summary).toBe("cage cycled");
    expect(a.rootCause).toBe("tests inside cage");
    expect(a.ask).toBe("use isolated cage");
    expect(a.by).toBe("superdoctor");
    expect(a.relatedTask).toBe("t-aaaaaaaa");
    expect(a.kind).toBe("incident");
  });

  test("resolve <id> required as first positional", () => {
    expect(() => parseComplaintsArgs(["resolve"])).toThrow(UsageError);
    expect(() => parseComplaintsArgs(["resolve", "--note", "x"])).toThrow(UsageError);
  });

  test("resolve <id> defaults status to 'resolved'", () => {
    const a = parseComplaintsArgs(["resolve", "c-aaaaaaaa"]);
    expect(a.subverb).toBe("resolve");
    expect(a.id).toBe("c-aaaaaaaa");
    expect(a.resolveStatus).toBe("resolved");
  });

  test("resolve --wontfix alias flips status", () => {
    const a = parseComplaintsArgs(["resolve", "c-aaaaaaaa", "--wontfix"]);
    expect(a.resolveStatus).toBe("wontfix");
  });

  test("resolve --status resolved|wontfix accepted", () => {
    expect(parseComplaintsArgs(["resolve", "c-x", "--status", "wontfix"]).resolveStatus).toBe(
      "wontfix",
    );
    expect(parseComplaintsArgs(["resolve", "c-x", "--status", "resolved"]).resolveStatus).toBe(
      "resolved",
    );
  });

  test("resolve --status with invalid value rejected", () => {
    expect(() => parseComplaintsArgs(["resolve", "c-x", "--status", "bogus"])).toThrow(UsageError);
  });

  test("resolve --note + --by + --related-task captured", () => {
    const a = parseComplaintsArgs([
      "resolve",
      "c-aaaaaaaa",
      "--by",
      "superdoctor",
      "--note",
      "ADR-079 implements the ask",
      "--related-task",
      "t-bbbbbbbb",
    ]);
    expect(a.by).toBe("superdoctor");
    expect(a.note).toBe("ADR-079 implements the ask");
    expect(a.relatedTask).toBe("t-bbbbbbbb");
  });
});

// ---------- complaints migration ----------

describe("complaints migration — schema present", () => {
  test("opening a fresh state.db materialises the complaints table at the ladder tip", async () => {
    const path = join(atmuxDir, "state.db");
    const db = openDatabase(path, migrations);
    try {
      const v = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
      // Ladder tip drifts as new migrations land. complaints landed at
      // v2; provenance columns added v2→v3 (t-e5e5d576);
      // superdoctor_attempts table added v3→v4 (ADR-077 §F6,
      // renumbered at 2026-05-14 trunk-merge). The invariant this
      // test depends on is "complaints table present after migration
      // completes", not the literal user_version.
      expect(v).toBeGreaterThanOrEqual(3);
      const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>;
      const names = tables.map((t) => t.name);
      expect(names).toContain("complaints");
    } finally {
      closeDatabase(db);
    }
  });

  test("v3 added source_kind / source_id / target_team columns + the two indexes", async () => {
    const path = join(atmuxDir, "state.db");
    const db = openDatabase(path, migrations);
    try {
      const cols = db.query("PRAGMA table_info(complaints)").all() as Array<{ name: string }>;
      const colNames = new Set(cols.map((c) => c.name));
      expect(colNames.has("source_kind")).toBe(true);
      expect(colNames.has("source_id")).toBe(true);
      expect(colNames.has("target_team")).toBe(true);

      const indexes = db
        .query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='complaints'")
        .all() as Array<{ name: string }>;
      const idxNames = new Set(indexes.map((i) => i.name));
      expect(idxNames.has("idx_complaints_source_kind")).toBe(true);
      expect(idxNames.has("idx_complaints_target_team")).toBe(true);
    } finally {
      closeDatabase(db);
    }
  });
});

// ---------- ComplaintsRepo ----------

describe("ComplaintsRepo — typed CRUD", () => {
  test("insert + getById round-trip", async () => {
    const path = join(atmuxDir, "state.db");
    const db = openDatabase(path, migrations);
    try {
      const repo = new ComplaintsRepo(db);
      repo.insert({
        id: "c-aaaaaaaa",
        openedAt: 1700000000,
        openedBy: "superdoctor",
        incidentSummary: "cage cycled itself",
        rootCause: "tests inside cage",
        preventiveAsk: "isolated cage flag",
        status: "open",
        resolvedAt: null,
        resolvedBy: null,
        relatedTaskId: null,
        sourceKind: null,
        sourceId: null,
        targetTeam: null,
        extra: { kind: "incident" },
      });
      const got = repo.getById("c-aaaaaaaa");
      expect(got).not.toBeNull();
      expect(got?.incidentSummary).toBe("cage cycled itself");
      expect(got?.extra.kind).toBe("incident");
      expect(got?.status).toBe("open");
    } finally {
      closeDatabase(db);
    }
  });

  test("list with status filter returns matching rows ordered desc by opened_at", async () => {
    const path = join(atmuxDir, "state.db");
    const db = openDatabase(path, migrations);
    try {
      const repo = new ComplaintsRepo(db);
      repo.insert({
        id: "c-1",
        openedAt: 100,
        openedBy: null,
        incidentSummary: "a",
        rootCause: null,
        preventiveAsk: null,
        status: "open",
        resolvedAt: null,
        resolvedBy: null,
        relatedTaskId: null,
        sourceKind: null,
        sourceId: null,
        targetTeam: null,
        extra: {},
      });
      repo.insert({
        id: "c-2",
        openedAt: 200,
        openedBy: null,
        incidentSummary: "b",
        rootCause: null,
        preventiveAsk: null,
        status: "resolved",
        resolvedAt: 250,
        resolvedBy: null,
        relatedTaskId: null,
        sourceKind: null,
        sourceId: null,
        targetTeam: null,
        extra: {},
      });
      repo.insert({
        id: "c-3",
        openedAt: 300,
        openedBy: null,
        incidentSummary: "c",
        rootCause: null,
        preventiveAsk: null,
        status: "open",
        resolvedAt: null,
        resolvedBy: null,
        relatedTaskId: null,
        sourceKind: null,
        sourceId: null,
        targetTeam: null,
        extra: {},
      });
      const open = repo.list({ status: "open" });
      expect(open.map((c) => c.id)).toEqual(["c-3", "c-1"]);
      const all = repo.list();
      expect(all).toHaveLength(3);
    } finally {
      closeDatabase(db);
    }
  });

  test("resolve flips status, stamps resolved_at + resolved_by + note in extra", async () => {
    const path = join(atmuxDir, "state.db");
    const db = openDatabase(path, migrations);
    try {
      const repo = new ComplaintsRepo(db);
      repo.insert({
        id: "c-aaaaaaaa",
        openedAt: 100,
        openedBy: null,
        incidentSummary: "a",
        rootCause: null,
        preventiveAsk: null,
        status: "open",
        resolvedAt: null,
        resolvedBy: null,
        relatedTaskId: null,
        sourceKind: null,
        sourceId: null,
        targetTeam: null,
        extra: {},
      });
      const ok = repo.resolve({
        id: "c-aaaaaaaa",
        status: "resolved",
        resolvedAt: 999,
        resolvedBy: "operator",
        note: "ADR-079 ships",
      });
      expect(ok).toBe(true);
      const got = repo.getById("c-aaaaaaaa");
      expect(got?.status).toBe("resolved");
      expect(got?.resolvedAt).toBe(999);
      expect(got?.resolvedBy).toBe("operator");
      expect(got?.extra.resolution_note).toBe("ADR-079 ships");
    } finally {
      closeDatabase(db);
    }
  });

  test("resolve on missing id returns false", async () => {
    const path = join(atmuxDir, "state.db");
    const db = openDatabase(path, migrations);
    try {
      const repo = new ComplaintsRepo(db);
      const ok = repo.resolve({
        id: "c-missing",
        status: "resolved",
        resolvedAt: 1,
      });
      expect(ok).toBe(false);
    } finally {
      closeDatabase(db);
    }
  });
});

// ---------- complaints verb — integration ----------

describe("complaints verb — integration", () => {
  test("file emits id; list shows it; resolve flips status", async () => {
    const { out: fileOut } = await captureStdout(() =>
      complaints([
        "file",
        "--summary",
        "cage cycled itself",
        "--root-cause",
        "tests inside cage",
        "--ask",
        "use isolated cage",
        "--by",
        "superdoctor",
        "--team-dir",
        teamDir,
      ]),
    );
    const newId = fileOut.trim();
    expect(newId).toMatch(/^c-[a-f0-9]{8}$/);

    const { out: listOut } = await captureStdout(() => complaints(["list", "--team-dir", teamDir]));
    expect(listOut).toContain(newId);
    expect(listOut).toContain("cage cycled itself");
    expect(listOut).toContain("🔴"); // open status emoji
    expect(listOut).toContain("isolated cage");

    const { out: resolveOut } = await captureStdout(() =>
      complaints([
        "resolve",
        newId,
        "--note",
        "F2 shipped",
        "--by",
        "operator",
        "--team-dir",
        teamDir,
      ]),
    );
    expect(resolveOut).toContain(newId);
    expect(resolveOut).toContain("→ resolved");

    // Default list filter = open → newly-resolved row should NOT appear.
    const { out: listOpenOut } = await captureStdout(() =>
      complaints(["list", "--team-dir", teamDir]),
    );
    expect(listOpenOut).not.toContain(newId);

    // --status resolved → DOES appear with ✅
    const { out: listResolvedOut } = await captureStdout(() =>
      complaints(["list", "--status", "resolved", "--team-dir", teamDir]),
    );
    expect(listResolvedOut).toContain(newId);
    expect(listResolvedOut).toContain("✅");
  });

  test("list --json emits parseable array", async () => {
    await captureStdout(() => complaints(["file", "--summary", "x", "--team-dir", teamDir]));
    const { out } = await captureStdout(() =>
      complaints(["list", "--json", "--team-dir", teamDir]),
    );
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].incidentSummary).toBe("x");
    expect(parsed[0].status).toBe("open");
  });

  test("resolve on missing id → exit 1 + stderr message", async () => {
    let stderrBuf = "";
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string | Uint8Array) => {
      stderrBuf += typeof s === "string" ? s : new TextDecoder().decode(s);
      return true;
    }) as typeof process.stderr.write;
    try {
      const exit = await complaints(["resolve", "c-deadbeef", "--team-dir", teamDir]);
      expect(exit).toBe(1);
      expect(stderrBuf).toContain("no such id: c-deadbeef");
    } finally {
      process.stderr.write = origStderr;
    }
  });

  test("file --kind stashes kind in extra", async () => {
    const { out } = await captureStdout(() =>
      complaints([
        "file",
        "--summary",
        "P0 send-keys bypass",
        "--kind",
        "p0",
        "--team-dir",
        teamDir,
      ]),
    );
    const id = out.trim();
    const { out: jsonOut } = await captureStdout(() =>
      complaints(["list", "--json", "--team-dir", teamDir]),
    );
    const parsed = JSON.parse(jsonOut);
    const found = parsed.find((c: { id: string }) => c.id === id);
    expect(found).toBeDefined();
    expect(found.extra.kind).toBe("p0");
  });

  test("list with no matching rows prints (no complaints …) sentinel", async () => {
    const { out } = await captureStdout(() => complaints(["list", "--team-dir", teamDir]));
    expect(out).toContain("(no complaints");
  });
});

// ---------- ADR-147 T2: ombudsman sentinel write-through ----------

describe("complaints verb — ADR-147 T2 sentinel write-through", () => {
  async function writeOmbudsmanTeam(enabled: boolean): Promise<void> {
    const teamJson = {
      name: "test-team",
      members: enabled
        ? [{ name: "alpha" }, { name: "ombud", role: "ombudsman" }]
        : [{ name: "alpha" }],
      ombudsman: enabled ? { enabled: true } : undefined,
    };
    await writeFile(join(atmuxDir, "team.json"), JSON.stringify(teamJson));
  }

  async function readSentinelPending(): Promise<string[]> {
    const { readSentinel } = await import("../../../src/core/ombudsman.ts");
    return (await readSentinel(atmuxDir)).pending;
  }

  test("file with ombudsman enabled → sentinel grows by 1 with the new id", async () => {
    await writeOmbudsmanTeam(true);
    const before = await readSentinelPending();
    expect(before).toEqual([]);
    const { out } = await captureStdout(() =>
      complaints(["file", "--summary", "incident A", "--team-dir", teamDir]),
    );
    const id = out.trim();
    const after = await readSentinelPending();
    expect(after).toEqual([id]);
  });

  test("file with ombudsman disabled (default) → sentinel untouched", async () => {
    // No `ombudsman` field on team.json — the default seed in beforeEach
    // matches this case, but write it explicitly to make the assertion
    // intent unambiguous.
    await writeOmbudsmanTeam(false);
    const { sentinelPath } = await import("../../../src/core/ombudsman.ts");
    const path = sentinelPath(atmuxDir);
    const { exists } = await import("../../../src/abstractions/fs.ts");
    await captureStdout(() =>
      complaints(["file", "--summary", "incident B", "--team-dir", teamDir]),
    );
    // Sentinel file should NOT exist — addToSentinel was never called.
    expect(await exists(path)).toBe(false);
  });

  test("file with explicit `ombudsman: { enabled: false }` → sentinel untouched", async () => {
    // Operator-disabled-after-enabled path: the field is present but the
    // master switch is off. Skip-gate must still suppress the write.
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({
        name: "test-team",
        members: [{ name: "alpha" }],
        ombudsman: { enabled: false },
      }),
    );
    const { sentinelPath } = await import("../../../src/core/ombudsman.ts");
    const { exists } = await import("../../../src/abstractions/fs.ts");
    await captureStdout(() =>
      complaints(["file", "--summary", "incident C", "--team-dir", teamDir]),
    );
    expect(await exists(sentinelPath(atmuxDir))).toBe(false);
  });

  test("resolve with id present in sentinel → sentinel shrinks by 1", async () => {
    await writeOmbudsmanTeam(true);
    const { out: fileOut } = await captureStdout(() =>
      complaints(["file", "--summary", "incident D", "--team-dir", teamDir]),
    );
    const id = fileOut.trim();
    expect(await readSentinelPending()).toEqual([id]);
    await captureStdout(() => complaints(["resolve", id, "--team-dir", teamDir]));
    expect(await readSentinelPending()).toEqual([]);
  });

  test("resolve with id absent from sentinel → idempotent no-op (operator-manual-resolve path)", async () => {
    // Manual-resolve scenario: a complaint was filed BEFORE ombudsman
    // was enabled, then operator resolves AFTER enable. The sentinel
    // never had the id; removeFromSentinel is set-semantic and must
    // not throw.
    await writeOmbudsmanTeam(false);
    const { out: fileOut } = await captureStdout(() =>
      complaints(["file", "--summary", "incident E", "--team-dir", teamDir]),
    );
    const id = fileOut.trim();
    // Now flip ombudsman ON for the resolve.
    await writeOmbudsmanTeam(true);
    expect(await readSentinelPending()).toEqual([]); // sentinel empty
    const exit = await captureStdout(() => complaints(["resolve", id, "--team-dir", teamDir]));
    expect(exit.result).toBe(0);
    expect(await readSentinelPending()).toEqual([]);
  });

  test("resolve on missing complaint id → exit 1, sentinel still empty (no spurious write)", async () => {
    await writeOmbudsmanTeam(true);
    let stderrBuf = "";
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string | Uint8Array) => {
      stderrBuf += typeof s === "string" ? s : new TextDecoder().decode(s);
      return true;
    }) as typeof process.stderr.write;
    try {
      const exit = await complaints(["resolve", "c-deadbeef", "--team-dir", teamDir]);
      expect(exit).toBe(1);
      expect(stderrBuf).toContain("no such id");
    } finally {
      process.stderr.write = origStderr;
    }
    expect(await readSentinelPending()).toEqual([]);
  });

  test("concurrent file + resolve → transaction-isolated, no torn writes", async () => {
    // File 5 complaints, then concurrently resolve them all. The DB
    // transaction-wrap + sentinel flock+atomic-rename together
    // guarantee the final state is consistent — sentinel is empty,
    // every complaint is resolved. The set-semantic
    // addToSentinel/removeFromSentinel idempotency tolerates the
    // milliseconds-of-drift the ombudsman-loop reconcile step is
    // designed for.
    await writeOmbudsmanTeam(true);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { out } = await captureStdout(() =>
        complaints(["file", "--summary", `incident-${i}`, "--team-dir", teamDir]),
      );
      ids.push(out.trim());
    }
    expect(await readSentinelPending()).toEqual(ids);
    // Fire all 5 resolves in parallel. flock + atomic-rename
    // serializes the sentinel writes; BEGIN IMMEDIATE serializes the
    // DB writes. End-state: sentinel empty, all rows resolved.
    await Promise.all(
      ids.map((id) => captureStdout(() => complaints(["resolve", id, "--team-dir", teamDir]))),
    );
    expect(await readSentinelPending()).toEqual([]);
    // Verify every complaint hit `status='resolved'` in the DB.
    const db = openDatabase(join(atmuxDir, "state.db"), migrations);
    try {
      const repo = new ComplaintsRepo(db);
      for (const id of ids) {
        const row = repo.getById(id);
        expect(row?.status).toBe("resolved");
      }
    } finally {
      closeDatabase(db);
    }
  });

  test("file + file concurrent → both ids land in sentinel (set-semantic, no torn write)", async () => {
    await writeOmbudsmanTeam(true);
    const [a, b] = await Promise.all([
      captureStdout(() => complaints(["file", "--summary", "concurrent-1", "--team-dir", teamDir])),
      captureStdout(() => complaints(["file", "--summary", "concurrent-2", "--team-dir", teamDir])),
    ]);
    const idA = a.out.trim();
    const idB = b.out.trim();
    expect(idA).not.toBe(idB);
    const pending = await readSentinelPending();
    expect(pending).toContain(idA);
    expect(pending).toContain(idB);
    expect(pending).toHaveLength(2);
  });
});

// ---------- v3 provenance: parser ----------

describe("parseComplaintsArgs — v3 provenance flags", () => {
  test("file --source-kind / --source-id / --target-team captured", () => {
    const a = parseComplaintsArgs([
      "file",
      "--summary",
      "x",
      "--source-kind",
      "superdoctor",
      "--source-id",
      "sweep-1715290000",
      "--target-team",
      "sopx",
    ]);
    expect(a.sourceKind).toBe("superdoctor");
    expect(a.sourceId).toBe("sweep-1715290000");
    expect(a.targetTeam).toBe("sopx");
  });

  test("file --source-kind allowlist accepts known values", () => {
    for (const kind of ["superdoctor", "member", "operator", "cli", "cron"]) {
      const a = parseComplaintsArgs(["file", "--summary", "x", "--source-kind", kind]);
      expect(a.sourceKind).toBe(kind);
    }
  });

  test("file --source-kind allowlist rejects unknown values", () => {
    expect(() => parseComplaintsArgs(["file", "--summary", "x", "--source-kind", "bogus"])).toThrow(
      UsageError,
    );
  });

  test("list --source-kind / --target-team captured", () => {
    const a = parseComplaintsArgs([
      "list",
      "--source-kind",
      "superdoctor",
      "--target-team",
      "sopx",
    ]);
    expect(a.sourceKind).toBe("superdoctor");
    expect(a.targetTeam).toBe("sopx");
  });

  test("list --source-kind allowlist rejects unknown values", () => {
    expect(() => parseComplaintsArgs(["list", "--source-kind", "bogus"])).toThrow(UsageError);
  });

  test("source-kind / source-id / target-team unset → undefined", () => {
    const a = parseComplaintsArgs(["file", "--summary", "x"]);
    expect(a.sourceKind).toBeUndefined();
    expect(a.sourceId).toBeUndefined();
    expect(a.targetTeam).toBeUndefined();
  });
});

// ---------- v3 provenance: schema ----------

describe("Complaint schema — v3 provenance fields", () => {
  test("optional fields default to null when absent", async () => {
    const path = join(atmuxDir, "state.db");
    const db = openDatabase(path, migrations);
    try {
      const repo = new ComplaintsRepo(db);
      repo.insert({
        id: "c-v3-1",
        openedAt: 100,
        openedBy: null,
        incidentSummary: "a",
        rootCause: null,
        preventiveAsk: null,
        status: "open",
        resolvedAt: null,
        resolvedBy: null,
        relatedTaskId: null,
        sourceKind: null,
        sourceId: null,
        targetTeam: null,
        extra: {},
      });
      const got = repo.getById("c-v3-1");
      expect(got?.sourceKind).toBeNull();
      expect(got?.sourceId).toBeNull();
      expect(got?.targetTeam).toBeNull();
    } finally {
      closeDatabase(db);
    }
  });
});

// ---------- v3 provenance: ComplaintsRepo round-trip + filters ----------

describe("ComplaintsRepo — v3 provenance", () => {
  test("insert + getById round-trip preserves source_kind / source_id / target_team", async () => {
    const path = join(atmuxDir, "state.db");
    const db = openDatabase(path, migrations);
    try {
      const repo = new ComplaintsRepo(db);
      repo.insert({
        id: "c-prov",
        openedAt: 100,
        openedBy: "superdoctor",
        incidentSummary: "cross-team incident",
        rootCause: null,
        preventiveAsk: null,
        status: "open",
        resolvedAt: null,
        resolvedBy: null,
        relatedTaskId: null,
        sourceKind: "superdoctor",
        sourceId: "sweep-1715290000",
        targetTeam: "sopx",
        extra: {},
      });
      const got = repo.getById("c-prov");
      expect(got?.sourceKind).toBe("superdoctor");
      expect(got?.sourceId).toBe("sweep-1715290000");
      expect(got?.targetTeam).toBe("sopx");
    } finally {
      closeDatabase(db);
    }
  });

  test("list filters by sourceKind", async () => {
    const path = join(atmuxDir, "state.db");
    const db = openDatabase(path, migrations);
    try {
      const repo = new ComplaintsRepo(db);
      repo.insert({
        id: "c-sd",
        openedAt: 100,
        openedBy: null,
        incidentSummary: "a",
        rootCause: null,
        preventiveAsk: null,
        status: "open",
        resolvedAt: null,
        resolvedBy: null,
        relatedTaskId: null,
        sourceKind: "superdoctor",
        sourceId: null,
        targetTeam: null,
        extra: {},
      });
      repo.insert({
        id: "c-op",
        openedAt: 200,
        openedBy: null,
        incidentSummary: "b",
        rootCause: null,
        preventiveAsk: null,
        status: "open",
        resolvedAt: null,
        resolvedBy: null,
        relatedTaskId: null,
        sourceKind: "operator",
        sourceId: null,
        targetTeam: null,
        extra: {},
      });
      const sd = repo.list({ sourceKind: "superdoctor" });
      expect(sd.map((c) => c.id)).toEqual(["c-sd"]);
      const op = repo.list({ sourceKind: "operator" });
      expect(op.map((c) => c.id)).toEqual(["c-op"]);
    } finally {
      closeDatabase(db);
    }
  });

  test("list filters by targetTeam", async () => {
    const path = join(atmuxDir, "state.db");
    const db = openDatabase(path, migrations);
    try {
      const repo = new ComplaintsRepo(db);
      repo.insert({
        id: "c-tx",
        openedAt: 100,
        openedBy: null,
        incidentSummary: "a",
        rootCause: null,
        preventiveAsk: null,
        status: "open",
        resolvedAt: null,
        resolvedBy: null,
        relatedTaskId: null,
        sourceKind: "superdoctor",
        sourceId: null,
        targetTeam: "sopx",
        extra: {},
      });
      repo.insert({
        id: "c-ty",
        openedAt: 200,
        openedBy: null,
        incidentSummary: "b",
        rootCause: null,
        preventiveAsk: null,
        status: "open",
        resolvedAt: null,
        resolvedBy: null,
        relatedTaskId: null,
        sourceKind: "superdoctor",
        sourceId: null,
        targetTeam: "atmux",
        extra: {},
      });
      const sopx = repo.list({ targetTeam: "sopx" });
      expect(sopx.map((c) => c.id)).toEqual(["c-tx"]);
      const atmuxRows = repo.list({ targetTeam: "atmux" });
      expect(atmuxRows.map((c) => c.id)).toEqual(["c-ty"]);
    } finally {
      closeDatabase(db);
    }
  });

  test("list combines status + sourceKind filters", async () => {
    const path = join(atmuxDir, "state.db");
    const db = openDatabase(path, migrations);
    try {
      const repo = new ComplaintsRepo(db);
      // two open superdoctor rows
      repo.insert({
        id: "c-a",
        openedAt: 100,
        openedBy: null,
        incidentSummary: "a",
        rootCause: null,
        preventiveAsk: null,
        status: "open",
        resolvedAt: null,
        resolvedBy: null,
        relatedTaskId: null,
        sourceKind: "superdoctor",
        sourceId: null,
        targetTeam: null,
        extra: {},
      });
      repo.insert({
        id: "c-b",
        openedAt: 200,
        openedBy: null,
        incidentSummary: "b",
        rootCause: null,
        preventiveAsk: null,
        status: "resolved",
        resolvedAt: 250,
        resolvedBy: null,
        relatedTaskId: null,
        sourceKind: "superdoctor",
        sourceId: null,
        targetTeam: null,
        extra: {},
      });
      // one open operator row (different source_kind)
      repo.insert({
        id: "c-c",
        openedAt: 300,
        openedBy: null,
        incidentSummary: "c",
        rootCause: null,
        preventiveAsk: null,
        status: "open",
        resolvedAt: null,
        resolvedBy: null,
        relatedTaskId: null,
        sourceKind: "operator",
        sourceId: null,
        targetTeam: null,
        extra: {},
      });
      const openSd = repo.list({ status: "open", sourceKind: "superdoctor" });
      expect(openSd.map((c) => c.id)).toEqual(["c-a"]);
    } finally {
      closeDatabase(db);
    }
  });
});

// ---------- v3 provenance: verb integration ----------

describe("complaints verb — v3 integration", () => {
  test("file --source-kind + --source-id + --target-team persists via repo + list filter recovers", async () => {
    const { out } = await captureStdout(() =>
      complaints([
        "file",
        "--summary",
        "cross-team bug",
        "--source-kind",
        "superdoctor",
        "--source-id",
        "sweep-1715290000",
        "--target-team",
        "sopx",
        "--team-dir",
        teamDir,
      ]),
    );
    const id = out.trim();
    const { out: jsonOut } = await captureStdout(() =>
      complaints([
        "list",
        "--source-kind",
        "superdoctor",
        "--target-team",
        "sopx",
        "--json",
        "--team-dir",
        teamDir,
      ]),
    );
    const parsed = JSON.parse(jsonOut);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe(id);
    expect(parsed[0].sourceKind).toBe("superdoctor");
    expect(parsed[0].sourceId).toBe("sweep-1715290000");
    expect(parsed[0].targetTeam).toBe("sopx");
  });

  test("file --source-kind=bogus → UsageError surface", async () => {
    let stderrBuf = "";
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string | Uint8Array) => {
      stderrBuf += typeof s === "string" ? s : new TextDecoder().decode(s);
      return true;
    }) as typeof process.stderr.write;
    try {
      await expect(
        complaints(["file", "--summary", "x", "--source-kind", "bogus", "--team-dir", teamDir]),
      ).rejects.toThrow(UsageError);
    } finally {
      process.stderr.write = origStderr;
    }
    void stderrBuf;
  });
});

// ---------- t-7bd53cba — whip-velocity-gate compat (--title / --body / --severity / source-kind allowlist / default target_team) ----------

describe("parseComplaintsArgs — t-7bd53cba flag-vocab compat", () => {
  test("file --title is an alias for --summary", () => {
    const a = parseComplaintsArgs([
      "file",
      "--title",
      "team-a: eta-lied · 3 picks · whip-tried-2-menus",
    ]);
    expect(a.summary).toBe("team-a: eta-lied · 3 picks · whip-tried-2-menus");
  });

  test("file --body is an alias for --root-cause", () => {
    const a = parseComplaintsArgs([
      "file",
      "--summary",
      "x",
      "--body",
      "Whip-velocity-gate strike threshold 3 reached for team atmux",
    ]);
    expect(a.rootCause).toBe("Whip-velocity-gate strike threshold 3 reached for team atmux");
  });

  test("file --severity captured as free-form string", () => {
    const a = parseComplaintsArgs(["file", "--summary", "x", "--severity", "high"]);
    expect(a.severity).toBe("high");
  });

  test("file --severity accepts any string (no allowlist)", () => {
    const a = parseComplaintsArgs(["file", "--summary", "x", "--severity", "P0-emergency"]);
    expect(a.severity).toBe("P0-emergency");
  });

  test("file --source-kind allowlist now includes 'whip'", () => {
    const a = parseComplaintsArgs(["file", "--summary", "x", "--source-kind", "whip"]);
    expect(a.sourceKind).toBe("whip");
  });

  test("file --source-kind allowlist now includes 'whip-velocity-gate'", () => {
    const a = parseComplaintsArgs([
      "file",
      "--summary",
      "x",
      "--source-kind",
      "whip-velocity-gate",
    ]);
    expect(a.sourceKind).toBe("whip-velocity-gate");
  });

  test("file --title + --summary both passed → last one wins (single canonical field)", () => {
    // Sanity: when both forms passed, the later argv value overrides.
    // Same behavior as any other duplicate-flag case in the parser.
    const a = parseComplaintsArgs(["file", "--summary", "first", "--title", "second"]);
    expect(a.summary).toBe("second");
  });
});

describe("complaints verb — t-7bd53cba target_team default + severity stashing", () => {
  test("file with --target-team omitted defaults to current team name", async () => {
    // Team config in beforeEach() has name: "test-team"
    const { out } = await captureStdout(() =>
      complaints(["file", "--summary", "x", "--team-dir", teamDir]),
    );
    const id = out.trim();
    const path = join(atmuxDir, "state.db");
    const db = openDatabase(path, migrations);
    try {
      const repo = new ComplaintsRepo(db);
      const c = repo.getById(id);
      expect(c?.targetTeam).toBe("test-team");
    } finally {
      closeDatabase(db);
    }
  });

  test("file with explicit --target-team wins over default", async () => {
    const { out } = await captureStdout(() =>
      complaints([
        "file",
        "--summary",
        "x",
        "--target-team",
        "different-team",
        "--team-dir",
        teamDir,
      ]),
    );
    const id = out.trim();
    const path = join(atmuxDir, "state.db");
    const db = openDatabase(path, migrations);
    try {
      const repo = new ComplaintsRepo(db);
      const c = repo.getById(id);
      expect(c?.targetTeam).toBe("different-team");
    } finally {
      closeDatabase(db);
    }
  });

  test("file --severity stashes value in extra.severity", async () => {
    const { out } = await captureStdout(() =>
      complaints(["file", "--summary", "x", "--severity", "high", "--team-dir", teamDir]),
    );
    const id = out.trim();
    const path = join(atmuxDir, "state.db");
    const db = openDatabase(path, migrations);
    try {
      const repo = new ComplaintsRepo(db);
      const c = repo.getById(id);
      expect(c?.extra.severity).toBe("high");
    } finally {
      closeDatabase(db);
    }
  });

  test("file --severity omitted leaves extra.severity unset", async () => {
    const { out } = await captureStdout(() =>
      complaints(["file", "--summary", "x", "--team-dir", teamDir]),
    );
    const id = out.trim();
    const path = join(atmuxDir, "state.db");
    const db = openDatabase(path, migrations);
    try {
      const repo = new ComplaintsRepo(db);
      const c = repo.getById(id);
      expect(c?.extra.severity).toBeUndefined();
    } finally {
      closeDatabase(db);
    }
  });

  test("smoke — whip-velocity-gate's exact CLI invocation lands a row", async () => {
    // Mirrors the call shape in /root/.atmux/bin/whip-velocity-gate.sh
    // verbatim. Acceptance bullet from Task t-7bd53cba: "Smoke test:
    // simulate velocity-gate's exact CLI invocation, verify row lands."
    const { out } = await captureStdout(() =>
      complaints([
        "file",
        "--target-team",
        "atmux",
        "--severity",
        "high",
        "--kind",
        "heads-up",
        "--source-kind",
        "whip-velocity-gate",
        "--source-id",
        "whip-atmux-velocity-stalled",
        "--title",
        "atmux: velocity-stalled · 0 commits in 60min · whip-tried-3-menus",
        "--body",
        "Whip-velocity-gate strike threshold 3 reached for team atmux. Symptom: 0 commits in last 60min, lead pane idle/wedged/saturated, action-menu injections produced no commit-shaped reply.",
        "--team-dir",
        teamDir,
      ]),
    );
    const id = out.trim();
    expect(id).toMatch(/^c-[0-9a-f]{8}$/);

    // Verify the row lands with every field the script intended
    const { out: jsonOut } = await captureStdout(() =>
      complaints([
        "list",
        "--source-kind",
        "whip-velocity-gate",
        "--target-team",
        "atmux",
        "--json",
        "--team-dir",
        teamDir,
      ]),
    );
    const parsed = JSON.parse(jsonOut);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe(id);
    expect(parsed[0].sourceKind).toBe("whip-velocity-gate");
    expect(parsed[0].sourceId).toBe("whip-atmux-velocity-stalled");
    expect(parsed[0].targetTeam).toBe("atmux");
    expect(parsed[0].incidentSummary).toContain("atmux: velocity-stalled");
    expect(parsed[0].rootCause).toContain("Whip-velocity-gate strike threshold");
    expect(parsed[0].extra.kind).toBe("heads-up");
    expect(parsed[0].extra.severity).toBe("high");
  });
});
