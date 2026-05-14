// Unit tests for src/verbs/complaints.ts (ADR-077 §F2).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

async function captureStdout<T>(fn: () => Promise<T>): Promise<{ out: string; result: T }> {
  let out = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string | Uint8Array) => {
    out += typeof s === "string" ? s : new TextDecoder().decode(s);
    return true;
  }) as typeof process.stdout.write;
  try {
    const result = await fn();
    return { out, result };
  } finally {
    process.stdout.write = orig;
  }
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

// ---------- migration v2 ----------

describe("complaints migration v2 — schema present", () => {
  test("opening a fresh state.db materialises the complaints table at the ladder tip", async () => {
    const path = join(atmuxDir, "state.db");
    const db = openDatabase(path, migrations);
    try {
      const v = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
      // Ladder tip drifts as new migrations land (v3: superdoctor_attempts
      // per ADR-077 §F6). Assert v ≥ 2 + table presence — that's the
      // invariant complaints depends on, not the literal version.
      expect(v).toBeGreaterThanOrEqual(2);
      const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>;
      const names = tables.map((t) => t.name);
      expect(names).toContain("complaints");
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
