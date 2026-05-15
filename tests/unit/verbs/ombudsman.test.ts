// Unit tests for src/verbs/ombudsman.ts (ADR-147 §D2 / §D3 / §D4 — T1).
//
// Covers:
//   - parseOmbudsmanArgs — sub-verb routing + validation
//   - statusForAction / actionLabel — action→status + label mapping
//   - tick — empty sentinel = no-op exit 0; non-empty fires verified
//     send-keys via injected mock
//   - work --id --action — adjudication paths for epic / wontfix /
//     already-addressed; release-notes entry appended; complaint
//     resolved; sentinel cleared
//   - work (bare) — JSON listing of pending complaints
//   - spliceUnderSection / formatEntryLine — pure formatters
//   - resolveDayFilePath — MYT-anchored day-file path

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import { addToSentinel, readSentinel } from "../../../src/core/ombudsman.ts";
import { ComplaintsRepo } from "../../../src/core/repositories/complaints-repo.ts";
import { UsageError } from "../../../src/errors.ts";
import type { Complaint } from "../../../src/schema/complaints.ts";
import {
  actionLabel,
  appendComplaintAdjudication,
  formatEntryLine,
  type OmbudsmanDeps,
  ombudsman,
  parseOmbudsmanArgs,
  resolveDayFilePath,
  spliceUnderSection,
  statusForAction,
} from "../../../src/verbs/ombudsman.ts";

let teamDir: string;
let atmuxDir: string;

beforeEach(async () => {
  teamDir = await mkdtemp(join(tmpdir(), "atmux-ombudsman-verb-"));
  atmuxDir = join(teamDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  await writeFile(
    join(atmuxDir, "team.json"),
    JSON.stringify({
      name: "test-team",
      members: [
        { name: "alpha", role: "member", lane: "be" },
        { name: "ombudsman", role: "ombudsman", emoji: "⚖️" },
      ],
    }),
  );
});

afterEach(async () => {
  await rm(teamDir, { recursive: true, force: true });
});

// ---------- Helpers ----------

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

function seedComplaint(opts: { id: string; summary?: string; status?: string }): Complaint {
  return {
    id: opts.id,
    openedAt: 1_715_000_000,
    openedBy: "medic",
    incidentSummary: opts.summary ?? `synthetic complaint ${opts.id}`,
    rootCause: null,
    preventiveAsk: null,
    status: opts.status ?? "open",
    resolvedAt: null,
    resolvedBy: null,
    relatedTaskId: null,
    sourceKind: "medic",
    sourceId: null,
    targetTeam: "test-team",
    extra: {},
  };
}

async function withComplaints(setup: (repo: ComplaintsRepo) => void): Promise<void> {
  const db = openDatabase(join(atmuxDir, "state.db"), migrations);
  try {
    setup(new ComplaintsRepo(db));
  } finally {
    closeDatabase(db);
  }
}

// ---------- parseOmbudsmanArgs ----------

describe("parseOmbudsmanArgs", () => {
  test("rejects empty argv", () => {
    expect(() => parseOmbudsmanArgs([])).toThrow(UsageError);
  });

  test("rejects unknown sub-verb", () => {
    expect(() => parseOmbudsmanArgs(["frobnicate"])).toThrow(UsageError);
  });

  test("bare 'tick' parses", () => {
    expect(parseOmbudsmanArgs(["tick"])).toEqual({ subverb: "tick" });
  });

  test("bare 'work' parses (list mode)", () => {
    expect(parseOmbudsmanArgs(["work"])).toEqual({ subverb: "work" });
  });

  test("'index' parses", () => {
    expect(parseOmbudsmanArgs(["index"])).toEqual({ subverb: "index" });
  });

  test("'work --id X --action wontfix' parses", () => {
    expect(parseOmbudsmanArgs(["work", "--id", "c-abc12345", "--action", "wontfix"])).toEqual({
      subverb: "work",
      id: "c-abc12345",
      action: "wontfix",
    });
  });

  test("'work --id X --action epic --related-task t-yyy' parses", () => {
    expect(
      parseOmbudsmanArgs([
        "work",
        "--id",
        "c-abc12345",
        "--action",
        "epic",
        "--related-task",
        "t-yyy11111",
      ]),
    ).toEqual({
      subverb: "work",
      id: "c-abc12345",
      action: "epic",
      relatedTask: "t-yyy11111",
    });
  });

  test("'work --id X' without --action throws", () => {
    expect(() => parseOmbudsmanArgs(["work", "--id", "c-abc12345"])).toThrow(UsageError);
  });

  test("'work --id X --action epic' without --related-task throws", () => {
    expect(() => parseOmbudsmanArgs(["work", "--id", "c-abc12345", "--action", "epic"])).toThrow(
      UsageError,
    );
  });

  test("'work --id X --action task' without --related-task throws", () => {
    expect(() => parseOmbudsmanArgs(["work", "--id", "c-abc12345", "--action", "task"])).toThrow(
      UsageError,
    );
  });

  test("rejects unknown --action value", () => {
    expect(() =>
      parseOmbudsmanArgs(["work", "--id", "c-abc12345", "--action", "frobnicate"]),
    ).toThrow(UsageError);
  });

  test("--team-dir threads through", () => {
    expect(parseOmbudsmanArgs(["tick", "--team-dir", "/tmp/x"])).toEqual({
      subverb: "tick",
      teamDir: "/tmp/x",
    });
  });

  test("--note threads through", () => {
    expect(
      parseOmbudsmanArgs([
        "work",
        "--id",
        "c-abc12345",
        "--action",
        "wontfix",
        "--note",
        "duplicates ADR-077",
      ]),
    ).toEqual({
      subverb: "work",
      id: "c-abc12345",
      action: "wontfix",
      note: "duplicates ADR-077",
    });
  });

  test("--json threads through", () => {
    expect(parseOmbudsmanArgs(["work", "--json"])).toEqual({
      subverb: "work",
      json: true,
    });
  });
});

// ---------- statusForAction + actionLabel ----------

describe("statusForAction", () => {
  test("epic → resolved", () => {
    expect(statusForAction("epic")).toBe("resolved");
  });
  test("task → resolved", () => {
    expect(statusForAction("task")).toBe("resolved");
  });
  test("already-addressed → resolved", () => {
    expect(statusForAction("already-addressed")).toBe("resolved");
  });
  test("wontfix → wontfix", () => {
    expect(statusForAction("wontfix")).toBe("wontfix");
  });
  test("defer → null (leaves complaint open)", () => {
    expect(statusForAction("defer")).toBeNull();
  });
});

describe("actionLabel", () => {
  test("epic with related task → 'filed epic t-yyy'", () => {
    expect(actionLabel("epic", "t-yyy11111")).toBe("filed epic t-yyy11111");
  });
  test("task with related task → 'filed task t-yyy'", () => {
    expect(actionLabel("task", "t-yyy11111")).toBe("filed task t-yyy11111");
  });
  test("wontfix → 'wontfix'", () => {
    expect(actionLabel("wontfix", null)).toBe("wontfix");
  });
  test("already-addressed → 'already addressed'", () => {
    expect(actionLabel("already-addressed", null)).toBe("already addressed");
  });
  test("defer → 'deferred'", () => {
    expect(actionLabel("defer", null)).toBe("deferred");
  });
  test("epic without related task → 'filed epic' (no id)", () => {
    expect(actionLabel("epic", null)).toBe("filed epic");
  });
});

// ---------- formatEntryLine ----------

describe("formatEntryLine", () => {
  test("wontfix entry uses note as rationale", () => {
    expect(
      formatEntryLine({
        complaintId: "c-abc12345",
        action: "wontfix",
        relatedTask: null,
        note: "duplicates ADR-077",
        summary: "team-a frozen",
      }),
    ).toBe("- c-abc12345 → **wontfix** (duplicates ADR-077)");
  });

  test("epic entry uses note as rationale + 'filed epic' label", () => {
    expect(
      formatEntryLine({
        complaintId: "c-abc12345",
        action: "epic",
        relatedTask: "t-yyy11111",
        note: "class hits 4 teams",
        summary: "team-a frozen",
      }),
    ).toBe("- c-abc12345 → **filed epic t-yyy11111** (class hits 4 teams)");
  });

  test("falls back to summary when note is absent", () => {
    expect(
      formatEntryLine({
        complaintId: "c-abc12345",
        action: "wontfix",
        relatedTask: null,
        note: null,
        summary: "team-a frozen",
      }),
    ).toBe("- c-abc12345 → **wontfix** (team-a frozen)");
  });
});

// ---------- spliceUnderSection ----------

describe("spliceUnderSection", () => {
  test("inserts under existing section header (skeleton case)", () => {
    const body = [
      "# 2026-05-15",
      "",
      "## Shipped (kanban→done)",
      "",
      "## Complaints adjudicated",
      "",
      "## Notes",
      "",
    ].join("\n");
    const next = spliceUnderSection(body, "## Complaints adjudicated", "- c-abc → **wontfix** (x)");
    expect(next).toContain("## Complaints adjudicated\n- c-abc → **wontfix** (x)\n");
    // Section ordering preserved.
    expect(next.indexOf("## Complaints adjudicated")).toBeLessThan(next.indexOf("## Notes"));
  });

  test("appends below existing entry under the same section", () => {
    const body = [
      "# 2026-05-15",
      "",
      "## Complaints adjudicated",
      "",
      "- c-aaa → **wontfix** (first)",
      "",
      "## Notes",
      "",
    ].join("\n");
    const next = spliceUnderSection(
      body,
      "## Complaints adjudicated",
      "- c-bbb → **wontfix** (second)",
    );
    const idxA = next.indexOf("- c-aaa");
    const idxB = next.indexOf("- c-bbb");
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(idxA);
  });

  test("appends section + entry when header is absent (defensive)", () => {
    const body = "# 2026-05-15\n\n## Notes\n\n";
    const next = spliceUnderSection(body, "## Complaints adjudicated", "- c-xxx → **wontfix** (y)");
    expect(next).toContain("## Complaints adjudicated");
    expect(next).toContain("- c-xxx → **wontfix** (y)");
  });

  test("does not match '##' inside text — only proper h2 headers", () => {
    const body = [
      "## Complaints adjudicated",
      "",
      "- earlier — note about 'foo##bar'",
      "",
      "## Notes",
      "",
    ].join("\n");
    const next = spliceUnderSection(body, "## Complaints adjudicated", "- c-new → **wontfix** (z)");
    // The inserted line should land before "## Notes", after the prior entry.
    expect(next.indexOf("- c-new")).toBeGreaterThan(next.indexOf("- earlier"));
    expect(next.indexOf("- c-new")).toBeLessThan(next.indexOf("## Notes"));
  });
});

// ---------- resolveDayFilePath ----------

describe("resolveDayFilePath", () => {
  test("formats path as <root>/docs/release-notes/YYYY/MM/YYYY-MM-DD.md (MYT)", () => {
    // 2026-05-15 14:00 MYT = 2026-05-15 06:00 UTC
    const epochMs = Date.UTC(2026, 4, 15, 6, 0, 0);
    expect(resolveDayFilePath("/repo", epochMs)).toBe(
      "/repo/docs/release-notes/2026/05/2026-05-15.md",
    );
  });

  test("rolls cleanly across the UTC midnight / MYT next-day boundary", () => {
    // 2026-05-15 19:30 UTC = 2026-05-16 03:30 MYT (next MYT day).
    const epochMs = Date.UTC(2026, 4, 15, 19, 30, 0);
    expect(resolveDayFilePath("/repo", epochMs)).toBe(
      "/repo/docs/release-notes/2026/05/2026-05-16.md",
    );
  });

  test("rolls year cleanly across Dec-31 MYT 23:00 = Jan-1 UTC", () => {
    // 2026-12-31 16:00 UTC = 2027-01-01 00:00 MYT
    const epochMs = Date.UTC(2026, 11, 31, 16, 0, 0);
    expect(resolveDayFilePath("/repo", epochMs)).toBe(
      "/repo/docs/release-notes/2027/01/2027-01-01.md",
    );
  });
});

// ---------- appendComplaintAdjudication (e2e fs round-trip) ----------

describe("appendComplaintAdjudication", () => {
  test("creates day-file with skeleton + appends entry on first write", async () => {
    // Use MYT-anchored fixed time to make path deterministic.
    const epochMs = Date.UTC(2026, 4, 15, 6, 0, 0); // 2026-05-15 14:00 MYT
    await appendComplaintAdjudication(teamDir, epochMs, {
      complaintId: "c-abc12345",
      action: "wontfix",
      relatedTask: null,
      note: "duplicates ADR-077",
      summary: "team-a frozen",
    });
    const path = resolveDayFilePath(teamDir, epochMs);
    const body = await readFile(path, "utf8");
    // Skeleton sections all present.
    expect(body).toContain("# 2026-05-15");
    expect(body).toContain("## Shipped");
    expect(body).toContain("## Merges");
    expect(body).toContain("## ADRs landed");
    expect(body).toContain("## Complaints adjudicated");
    expect(body).toContain("## Doctor regressions");
    expect(body).toContain("## Notes");
    // Entry present under the adjudication section.
    expect(body).toContain("- c-abc12345 → **wontfix** (duplicates ADR-077)");
  });

  test("appends second entry under the existing section without re-creating skeleton", async () => {
    const epochMs = Date.UTC(2026, 4, 15, 6, 0, 0);
    await appendComplaintAdjudication(teamDir, epochMs, {
      complaintId: "c-aaaaaaaa",
      action: "wontfix",
      relatedTask: null,
      note: "first",
      summary: "x",
    });
    await appendComplaintAdjudication(teamDir, epochMs, {
      complaintId: "c-bbbbbbbb",
      action: "epic",
      relatedTask: "t-yyy11111",
      note: "second",
      summary: "y",
    });
    const path = resolveDayFilePath(teamDir, epochMs);
    const body = await readFile(path, "utf8");
    // Only one set of skeleton sections.
    expect(body.match(/## Complaints adjudicated/g)?.length).toBe(1);
    // Both entries present in insertion order.
    const idxA = body.indexOf("- c-aaaaaaaa");
    const idxB = body.indexOf("- c-bbbbbbbb");
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(idxA);
  });
});

// ---------- tick ----------

describe("ombudsman tick", () => {
  test("empty sentinel → no-op exit 0; does NOT call sendKeys", async () => {
    let sendCalls = 0;
    const deps: OmbudsmanDeps = {
      capture: async () => "❯ ",
      sendKeys: async () => {
        sendCalls += 1;
      },
      log: () => {},
    };
    const exit = await ombudsman(["tick", "--team-dir", teamDir], deps);
    expect(exit).toBe(0);
    expect(sendCalls).toBe(0);
  });

  test("non-empty sentinel → fires verified send-keys with 'atmux ombudsman work'", async () => {
    await addToSentinel(atmuxDir, "c-abc12345");
    let sentKeys: { target: string; text: string } | null = null;
    const captures: string[] = [
      // Pre-capture (READY) + post-capture (composer empty after submit).
      "❯ ",
      "❯ ",
    ];
    let captureIdx = 0;
    const deps: OmbudsmanDeps = {
      capture: async () => captures[Math.min(captureIdx++, captures.length - 1)] ?? "",
      sendKeys: async (target: string, text: string) => {
        sentKeys = { target, text };
      },
      log: () => {},
    };
    const exit = await ombudsman(["tick", "--team-dir", teamDir], deps);
    expect(exit).toBe(0);
    expect(sentKeys).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: just asserted not-null
    expect(sentKeys!.text).toBe("atmux ombudsman work");
    // Target should include the team session + ombudsman window with hyphen+emoji.
    // biome-ignore lint/style/noNonNullAssertion: just asserted not-null
    expect(sentKeys!.target).toMatch(/ombudsman$/);
  });

  test("non-empty sentinel + no ombudsman member → returns 0 with warning log", async () => {
    // Rewrite team.json without the ombudsman role.
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({
        name: "test-team",
        members: [{ name: "alpha", role: "member", lane: "be" }],
      }),
    );
    await addToSentinel(atmuxDir, "c-abc12345");
    let sendCalls = 0;
    let lastLog = "";
    const deps: OmbudsmanDeps = {
      capture: async () => "❯ ",
      sendKeys: async () => {
        sendCalls += 1;
      },
      log: (m: string) => {
        lastLog = m;
      },
    };
    const exit = await ombudsman(["tick", "--team-dir", teamDir], deps);
    expect(exit).toBe(0);
    expect(sendCalls).toBe(0);
    expect(lastLog).toContain("no role=ombudsman member");
  });
});

// ---------- work — adjudication paths ----------

describe("ombudsman work — adjudication", () => {
  test("wontfix: appends release-notes + flips complaint status + clears sentinel", async () => {
    await withComplaints((repo) =>
      repo.insert(seedComplaint({ id: "c-wontfix1", summary: "team-a frozen" })),
    );
    await addToSentinel(atmuxDir, "c-wontfix1");

    const epochMs = Date.UTC(2026, 4, 15, 6, 0, 0);
    const exit = await ombudsman(
      [
        "work",
        "--id",
        "c-wontfix1",
        "--action",
        "wontfix",
        "--note",
        "duplicates ADR-077",
        "--team-dir",
        teamDir,
      ],
      { now: () => epochMs, log: () => {} },
    );
    expect(exit).toBe(0);

    // Complaint flipped to wontfix.
    await withComplaints((repo) => {
      const got = repo.getById("c-wontfix1");
      expect(got).not.toBeNull();
      expect(got!.status).toBe("wontfix");
      expect(got!.resolvedBy).toBe("ombudsman");
    });

    // Sentinel cleared.
    expect((await readSentinel(atmuxDir)).pending).toEqual([]);

    // Release-notes entry appended.
    const dayPath = resolveDayFilePath(teamDir, epochMs);
    const body = await readFile(dayPath, "utf8");
    expect(body).toContain("- c-wontfix1 → **wontfix** (duplicates ADR-077)");
  });

  test("epic: appends release-notes with task id + resolves complaint with related-task link", async () => {
    await withComplaints((repo) =>
      repo.insert(seedComplaint({ id: "c-epic1111", summary: "lead rotation gap" })),
    );
    await addToSentinel(atmuxDir, "c-epic1111");

    const epochMs = Date.UTC(2026, 4, 15, 6, 0, 0);
    const exit = await ombudsman(
      [
        "work",
        "--id",
        "c-epic1111",
        "--action",
        "epic",
        "--related-task",
        "t-yyy11111",
        "--note",
        "class hits 4 teams",
        "--team-dir",
        teamDir,
      ],
      { now: () => epochMs, log: () => {} },
    );
    expect(exit).toBe(0);

    await withComplaints((repo) => {
      const got = repo.getById("c-epic1111");
      expect(got).not.toBeNull();
      expect(got!.status).toBe("resolved");
      expect(got!.relatedTaskId).toBe("t-yyy11111");
    });

    expect((await readSentinel(atmuxDir)).pending).toEqual([]);

    const dayPath = resolveDayFilePath(teamDir, epochMs);
    const body = await readFile(dayPath, "utf8");
    expect(body).toContain("- c-epic1111 → **filed epic t-yyy11111** (class hits 4 teams)");
  });

  test("already-addressed → status=resolved with note", async () => {
    await withComplaints((repo) =>
      repo.insert(seedComplaint({ id: "c-resolv1", summary: "fix already landed" })),
    );
    await addToSentinel(atmuxDir, "c-resolv1");

    const epochMs = Date.UTC(2026, 4, 15, 6, 0, 0);
    const exit = await ombudsman(
      [
        "work",
        "--id",
        "c-resolv1",
        "--action",
        "already-addressed",
        "--note",
        "ADR-131 already addresses this",
        "--team-dir",
        teamDir,
      ],
      { now: () => epochMs, log: () => {} },
    );
    expect(exit).toBe(0);

    await withComplaints((repo) => {
      const got = repo.getById("c-resolv1");
      expect(got).not.toBeNull();
      expect(got!.status).toBe("resolved");
    });

    expect((await readSentinel(atmuxDir)).pending).toEqual([]);

    const dayPath = resolveDayFilePath(teamDir, epochMs);
    const body = await readFile(dayPath, "utf8");
    expect(body).toContain("- c-resolv1 → **already addressed** (ADR-131 already addresses this)");
  });

  test("defer: leaves complaint open + keeps id in sentinel", async () => {
    await withComplaints((repo) =>
      repo.insert(seedComplaint({ id: "c-defer11", summary: "needs operator" })),
    );
    await addToSentinel(atmuxDir, "c-defer11");

    const epochMs = Date.UTC(2026, 4, 15, 6, 0, 0);
    const exit = await ombudsman(
      [
        "work",
        "--id",
        "c-defer11",
        "--action",
        "defer",
        "--note",
        "needs operator input",
        "--team-dir",
        teamDir,
      ],
      { now: () => epochMs, log: () => {} },
    );
    expect(exit).toBe(0);

    // Complaint stays open.
    await withComplaints((repo) => {
      const got = repo.getById("c-defer11");
      expect(got).not.toBeNull();
      expect(got!.status).toBe("open");
    });

    // Sentinel still carries the id (defer re-attempts next tick).
    expect((await readSentinel(atmuxDir)).pending).toEqual(["c-defer11"]);

    // Release-notes entry still recorded.
    const dayPath = resolveDayFilePath(teamDir, epochMs);
    const body = await readFile(dayPath, "utf8");
    expect(body).toContain("- c-defer11 → **deferred** (needs operator input)");
  });

  test("unknown complaint id → exit 1", async () => {
    let stderr = "";
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string | Uint8Array) => {
      stderr += typeof s === "string" ? s : new TextDecoder().decode(s);
      return true;
    }) as typeof process.stderr.write;
    try {
      const exit = await ombudsman(
        ["work", "--id", "c-nosuch1", "--action", "wontfix", "--team-dir", teamDir],
        { log: () => {} },
      );
      expect(exit).toBe(1);
      expect(stderr).toContain("no such complaint");
    } finally {
      process.stderr.write = origErr;
    }
  });
});

// ---------- work — bare listing ----------

describe("ombudsman work (bare, list mode)", () => {
  test("empty sentinel prints '(no pending complaints)' on stdout", async () => {
    const { out, result } = await captureStdout(() =>
      ombudsman(["work", "--team-dir", teamDir], { log: () => {} }),
    );
    expect(result).toBe(0);
    expect(out).toContain("no pending complaints");
  });

  test("--json prints sentinel + open complaints as JSON", async () => {
    await withComplaints((repo) =>
      repo.insert(seedComplaint({ id: "c-listing", summary: "needs reading" })),
    );
    await addToSentinel(atmuxDir, "c-listing");
    const { out, result } = await captureStdout(() =>
      ombudsman(["work", "--json", "--team-dir", teamDir], { log: () => {} }),
    );
    expect(result).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.sentinel).toEqual(["c-listing"]);
    expect(parsed.pending).toHaveLength(1);
    expect(parsed.pending[0].id).toBe("c-listing");
    expect(parsed.pending[0].incidentSummary).toBe("needs reading");
  });

  test("text mode prints emoji + summary lines per complaint", async () => {
    await withComplaints((repo) =>
      repo.insert(seedComplaint({ id: "c-textmod", summary: "see this" })),
    );
    await addToSentinel(atmuxDir, "c-textmod");
    const { out } = await captureStdout(() =>
      ombudsman(["work", "--team-dir", teamDir], { log: () => {} }),
    );
    expect(out).toContain("c-textmod");
    expect(out).toContain("see this");
  });
});

// ---------- index (T1 stub) ----------

describe("ombudsman index", () => {
  test("returns 0 with a deferred-to-T8 message", async () => {
    const { out, result } = await captureStdout(() =>
      ombudsman(["index", "--team-dir", teamDir], { log: () => {} }),
    );
    expect(result).toBe(0);
    expect(out).toContain("deferred to ADR-147 T8");
  });
});
