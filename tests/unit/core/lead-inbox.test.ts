// Unit tests for src/core/lead-inbox.ts (ADR-057 §D2 entry parsing +
// cursor primitives; ADR-198 read-shim merging legacy driver-inbox.md +
// canonical lead-inbox.md).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// ADR-198 grace window — assert the back-compat shim at
// `src/core/driver-inbox.ts` still re-exports the same symbols so
// external imports survive one release.
import { lastDriverInboxReadPath, readDriverInbox } from "../../../src/core/driver-inbox.ts";
import {
  entriesSince,
  isEntryHead,
  lastLeadInboxReadPath,
  lastNEntries,
  parseEntries,
  parseEntryTimestamp,
  readCursor,
  readLeadInbox,
  writeCursor,
} from "../../../src/core/lead-inbox.ts";

// Pin a deterministic "now" so resolveTodayMyt rolls predictably.
// 2026-05-07 12:00 MYT = 2026-05-07 04:00 UTC = epoch 1778126400.
const NOW_EPOCH_SEC = 1778126400;

describe("isEntryHead", () => {
  test("section head with MYT", () => {
    expect(isEntryHead("## 12:34 MYT — header")).toBe(true);
  });
  test("section head with date", () => {
    expect(isEntryHead("## 09:00 MYT 2026-05-07 — header")).toBe(true);
  });
  test("bullet head", () => {
    expect(isEntryHead("- [12:34 MYT] body")).toBe(true);
  });
  test("plain text → false", () => {
    expect(isEntryHead("plain line")).toBe(false);
  });
  test("section without MYT → false", () => {
    expect(isEntryHead("## general header")).toBe(false);
  });
  test("bullet without MYT → false", () => {
    expect(isEntryHead("- plain bullet")).toBe(false);
  });
});

describe("parseEntryTimestamp", () => {
  // Reference now: 2026-05-07 12:00 MYT (epoch 1778126400). Today's
  // MYT epochs: 09:00=1778115600, 10:00=1778119200, 11:00=1778122800,
  // 18:00=1778148000. Yesterday's 18:00 MYT = 1778061600.
  test("section head with date returns absolute epoch", () => {
    const ts = parseEntryTimestamp("## 09:00 MYT 2026-05-07 — x", NOW_EPOCH_SEC);
    expect(ts).toBe(1778115600);
  });
  test("section head undated rolls to today", () => {
    const ts = parseEntryTimestamp("## 09:00 MYT — x", NOW_EPOCH_SEC);
    expect(ts).toBe(1778115600);
  });
  test("section head undated future-of-now rolls back one day", () => {
    // now is 12:00 MYT today. 18:00 MYT today is 6h in future → roll back.
    const ts = parseEntryTimestamp("## 18:00 MYT — x", NOW_EPOCH_SEC);
    expect(ts).toBe(1778061600);
  });
  test("bullet head returns today's epoch", () => {
    const ts = parseEntryTimestamp("- [10:00 MYT] body", NOW_EPOCH_SEC);
    expect(ts).toBe(1778119200);
  });
  test("non-matching head → null", () => {
    expect(parseEntryTimestamp("plain text", NOW_EPOCH_SEC)).toBeNull();
  });
});

describe("parseEntries", () => {
  test("empty body → []", () => {
    expect(parseEntries("", NOW_EPOCH_SEC)).toEqual([]);
  });
  test("single section entry preserves body lines", () => {
    const text = "## 09:00 MYT — first\nbody line 1\nbody line 2";
    const entries = parseEntries(text, NOW_EPOCH_SEC);
    expect(entries.length).toBe(1);
    expect(entries[0]?.head).toBe("## 09:00 MYT — first");
    expect(entries[0]?.body).toContain("body line 1");
    expect(entries[0]?.body).toContain("body line 2");
    expect(entries[0]?.tsEpochSec).toBe(1778115600);
  });
  test("mixed section + bullet entries", () => {
    const text = `## 09:00 MYT — section A
section A body
## 09:05 MYT — section B

- [09:10 MYT] **driver**: bullet ask`;
    const entries = parseEntries(text, NOW_EPOCH_SEC);
    expect(entries.length).toBe(3);
    expect(entries[0]?.head).toContain("section A");
    expect(entries[1]?.head).toContain("section B");
    expect(entries[2]?.head).toContain("bullet ask");
  });
  test("pre-first-entry text dropped", () => {
    const text = `# header\n\nfile preamble\n\n## 09:00 MYT — first\nbody`;
    const entries = parseEntries(text, NOW_EPOCH_SEC);
    expect(entries.length).toBe(1);
    expect(entries[0]?.head).toContain("first");
  });
});

describe("entriesSince", () => {
  const buildEntry = (ts: number | null) => ({
    head: ts === null ? "undated" : `## ${ts}`,
    body: "",
    tsEpochSec: ts,
  });
  test("null cursor → all entries", () => {
    const all = [buildEntry(100), buildEntry(200)];
    expect(entriesSince(all, null)).toEqual(all);
  });
  test("cursor filters to newer", () => {
    const all = [buildEntry(100), buildEntry(200), buildEntry(300)];
    expect(entriesSince(all, 150).length).toBe(2);
    expect(entriesSince(all, 200).length).toBe(1);
    expect(entriesSince(all, 300).length).toBe(0);
  });
  test("undated entries always surface", () => {
    const all = [buildEntry(100), buildEntry(null), buildEntry(300)];
    expect(entriesSince(all, 200).length).toBe(2); // null + 300
  });
});

describe("lastNEntries", () => {
  const e = (i: number) => ({ head: `e${i}`, body: "", tsEpochSec: i });
  test("n <= 0 → []", () => {
    expect(lastNEntries([e(1), e(2)], 0)).toEqual([]);
    expect(lastNEntries([e(1)], -3)).toEqual([]);
  });
  test("entries.length <= n → all", () => {
    expect(lastNEntries([e(1), e(2)], 5).length).toBe(2);
  });
  test("trims to last n", () => {
    const arr = [e(1), e(2), e(3), e(4), e(5)];
    const last3 = lastNEntries(arr, 3);
    expect(last3.length).toBe(3);
    expect(last3.map((x) => x.tsEpochSec)).toEqual([3, 4, 5]);
  });
});

describe("cursor I/O + readDriverInbox (legacy alias — ADR-198)", () => {
  let teamDir: string;
  let atmuxDir: string;

  beforeEach(async () => {
    teamDir = await mkdtemp(join(tmpdir(), "atmux-lead-inbox-"));
    atmuxDir = join(teamDir, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
    await mkdir(join(atmuxDir, "state"), { recursive: true });
  });
  afterEach(async () => {
    await rm(teamDir, { recursive: true, force: true });
  });

  test("readCursor: absent → null", async () => {
    expect(await readCursor(atmuxDir)).toBeNull();
  });
  test("readCursor: empty file → null", async () => {
    await writeFile(lastDriverInboxReadPath(atmuxDir), "");
    expect(await readCursor(atmuxDir)).toBeNull();
  });
  test("readCursor: non-numeric → null", async () => {
    await writeFile(lastDriverInboxReadPath(atmuxDir), "abc");
    expect(await readCursor(atmuxDir)).toBeNull();
  });
  test("writeCursor + readCursor round-trip", async () => {
    await writeCursor(atmuxDir, 1_000_000);
    expect(await readCursor(atmuxDir)).toBe(1_000_000);
  });

  test("readDriverInbox: absent file → empty result", async () => {
    const result = await readDriverInbox(atmuxDir, NOW_EPOCH_SEC);
    expect(result.all).toEqual([]);
    expect(result.delta).toEqual([]);
    expect(result.tipTs).toBeNull();
    expect(result.fileMtimeSec).toBeNull();
  });

  test("readDriverInbox: parses + applies cursor", async () => {
    const text = `## 09:00 MYT — old
old body
## 11:00 MYT — newer
newer body`;
    await writeFile(join(atmuxDir, "driver-inbox.md"), text);
    await writeCursor(atmuxDir, 1778119200); // 10:00 MYT today
    const result = await readDriverInbox(atmuxDir, NOW_EPOCH_SEC);
    expect(result.all.length).toBe(2);
    expect(result.delta.length).toBe(1); // only 11:00 (after 10:00 cursor)
    expect(result.delta[0]?.head).toContain("newer");
    expect(result.tipTs).toBe(1778122800); // 11:00 MYT today
    expect(result.fileMtimeSec).not.toBeNull();
  });

  test("readDriverInbox: cursorOverride wins over on-disk cursor", async () => {
    const text = `## 09:00 MYT — old
## 11:00 MYT — newer`;
    await writeFile(join(atmuxDir, "driver-inbox.md"), text);
    await writeCursor(atmuxDir, 1778126400); // future cursor → would hide all
    const result = await readDriverInbox(atmuxDir, NOW_EPOCH_SEC, 0);
    expect(result.delta.length).toBe(2); // override 0 → all surface
  });
});

describe("ADR-198 read-shim + deprecated aliases", () => {
  let teamDir: string;
  let atmuxDir: string;

  beforeEach(async () => {
    teamDir = await mkdtemp(join(tmpdir(), "atmux-adr198-shim-"));
    atmuxDir = join(teamDir, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
    await mkdir(join(atmuxDir, "state"), { recursive: true });
  });
  afterEach(async () => {
    await rm(teamDir, { recursive: true, force: true });
  });

  test("lastDriverInboxReadPath shim → same path as lastLeadInboxReadPath", () => {
    expect(lastDriverInboxReadPath(atmuxDir)).toBe(lastLeadInboxReadPath(atmuxDir));
  });

  test("readDriverInbox shim is the same function reference as readLeadInbox", () => {
    // Verifies the deprecated re-export at `src/core/driver-inbox.ts`
    // points at the canonical implementation — no wrapper drift.
    expect(readDriverInbox).toBe(readLeadInbox);
  });

  test("both files absent → empty result + legacyPresent=false", async () => {
    const result = await readLeadInbox(atmuxDir, NOW_EPOCH_SEC);
    expect(result.all).toEqual([]);
    expect(result.delta).toEqual([]);
    expect(result.tipTs).toBeNull();
    expect(result.fileMtimeSec).toBeNull();
    expect(result.legacyPresent).toBe(false);
  });

  test("(a) legacy-only driver-inbox.md → parsed + legacyPresent=true", async () => {
    const text = `## 09:00 MYT — legacy ask
legacy body`;
    await writeFile(join(atmuxDir, "driver-inbox.md"), text);
    const result = await readLeadInbox(atmuxDir, NOW_EPOCH_SEC);
    expect(result.all.length).toBe(1);
    expect(result.all[0]?.head).toContain("legacy ask");
    expect(result.legacyPresent).toBe(true);
    // mtime falls back to legacy file when canonical is absent.
    expect(result.fileMtimeSec).not.toBeNull();
  });

  test("(b) canonical-only lead-inbox.md → parsed + legacyPresent=false", async () => {
    const text = `## 10:00 MYT — fresh ask`;
    await writeFile(join(atmuxDir, "lead-inbox.md"), text);
    const result = await readLeadInbox(atmuxDir, NOW_EPOCH_SEC);
    expect(result.all.length).toBe(1);
    expect(result.all[0]?.head).toContain("fresh ask");
    expect(result.legacyPresent).toBe(false);
  });

  test("(c) both files exist → concat-merge by tsEpochSec asc + legacyPresent=true", async () => {
    // Legacy file holds two entries (one before, one after the canonical
    // window); canonical holds two newer-than-legacy-A but older-than-
    // legacy-B. After merge the order is chronological across both.
    const legacyText = `## 08:00 MYT — legacy A
## 11:30 MYT — legacy B`;
    const canonicalText = `## 09:00 MYT — canonical A
## 11:00 MYT — canonical B`;
    await writeFile(join(atmuxDir, "driver-inbox.md"), legacyText);
    await writeFile(join(atmuxDir, "lead-inbox.md"), canonicalText);
    const result = await readLeadInbox(atmuxDir, NOW_EPOCH_SEC);
    expect(result.all.length).toBe(4);
    expect(result.all[0]?.head).toContain("legacy A"); // 08:00
    expect(result.all[1]?.head).toContain("canonical A"); // 09:00
    expect(result.all[2]?.head).toContain("canonical B"); // 11:00
    expect(result.all[3]?.head).toContain("legacy B"); // 11:30
    expect(result.legacyPresent).toBe(true);
    expect(result.tipTs).toBe(1778124600); // 11:30 MYT today (12:00 - 30min)
  });

  test("(d) both files + cursor → delta drawn from merged set", async () => {
    const legacyText = `## 08:00 MYT — legacy old
## 11:30 MYT — legacy newest`;
    const canonicalText = `## 11:00 MYT — canonical middle`;
    await writeFile(join(atmuxDir, "driver-inbox.md"), legacyText);
    await writeFile(join(atmuxDir, "lead-inbox.md"), canonicalText);
    await writeCursor(atmuxDir, 1778119200); // 10:00 MYT today
    const result = await readLeadInbox(atmuxDir, NOW_EPOCH_SEC);
    // Only entries after 10:00 surface: canonical 11:00 + legacy 11:30.
    expect(result.delta.length).toBe(2);
    expect(result.delta[0]?.head).toContain("canonical middle");
    expect(result.delta[1]?.head).toContain("legacy newest");
  });

  test("(e) mtime preference — canonical mtime wins even when legacy is fresher", async () => {
    // The reported fileMtimeSec feeds the heads-up dedup cursor + the
    // operator-facing freshness check; both are about the post-ADR-198
    // write surface, so canonical mtime is authoritative whenever
    // canonical exists.
    const fs = await import("node:fs/promises");
    await writeFile(join(atmuxDir, "driver-inbox.md"), `## 08:00 MYT — old`);
    const farFuture = new Date(Date.now() + 24 * 3600 * 1000);
    await fs.utimes(join(atmuxDir, "driver-inbox.md"), farFuture, farFuture);
    await writeFile(join(atmuxDir, "lead-inbox.md"), `## 10:00 MYT — fresh`);
    const result = await readLeadInbox(atmuxDir, NOW_EPOCH_SEC);
    const canonStat = await fs.stat(join(atmuxDir, "lead-inbox.md"));
    expect(result.fileMtimeSec).toBe(Math.floor(canonStat.mtimeMs / 1000));
  });

  test("(f) bullet-style + section-style entries merge across files", async () => {
    // Verifies the merger handles BOTH entry-head patterns (bullet from
    // tell-lead one-liners + section from longer-form lead asks) across
    // legacy and canonical files. Real-world cages can have either or
    // both styles in either file during the grace window.
    await writeFile(
      join(atmuxDir, "driver-inbox.md"),
      `- [08:30 MYT] legacy bullet ask\n## 09:00 MYT — legacy section ask`,
    );
    await writeFile(
      join(atmuxDir, "lead-inbox.md"),
      `- [10:30 MYT] canonical bullet ask\n## 11:00 MYT — canonical section ask`,
    );
    const result = await readLeadInbox(atmuxDir, NOW_EPOCH_SEC);
    expect(result.all.length).toBe(4);
    expect(result.all[0]?.head).toContain("legacy bullet ask"); // 08:30
    expect(result.all[1]?.head).toContain("legacy section ask"); // 09:00
    expect(result.all[2]?.head).toContain("canonical bullet ask"); // 10:30
    expect(result.all[3]?.head).toContain("canonical section ask"); // 11:00
    expect(result.legacyPresent).toBe(true);
  });
});
