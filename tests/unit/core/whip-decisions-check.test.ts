// SPEC-063: unit tests for `whip-decisions-check.ts` — bun port of
// bash `_atmux_whip_check_decisions` (.archive-bash-atmux-20260507/
// lib/whip.sh:376-435, ADR-008 §S8 D13).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advanceDecisionsCursor,
  checkDecisions,
  countEntriesSince,
  readDecisionsCursor,
} from "../../../src/core/whip-decisions-check.ts";

let atmuxDir: string;

beforeEach(async () => {
  atmuxDir = await mkdtemp(join(tmpdir(), "atmux-decisions-test-"));
  await mkdir(join(atmuxDir, "state"), { recursive: true });
});

afterEach(async () => {
  await rm(atmuxDir, { recursive: true, force: true });
});

/** Build a decisions.md entry block for fixture content. */
function entry(id: string, ts: number, q: string, def: string): string {
  return `### d-${id} — ${q} [high] (00:00 MYT)

- **timestamp**: ${ts}
- **question**: ${q}
- **default**: ${def}
- **reversibility**: high
- **decided-by**: planner
- **override**: \`atmux send lead "override d-${id}: <new>"\`
`;
}

describe("countEntriesSince — pure scanner mirroring bash awk filter", () => {
  test("empty file returns 0", () => {
    expect(countEntriesSince("", 0)).toBe(0);
  });

  test("prose-only content returns 0", () => {
    const body = "# atmux decisions — append-only log\n\nLead/planner notes.\n";
    expect(countEntriesSince(body, 0)).toBe(0);
  });

  test("one entry with timestamp > cursor counts", () => {
    const body = entry("aaaaaaaa", 1000, "Q1?", "D1");
    expect(countEntriesSince(body, 0)).toBe(1);
    expect(countEntriesSince(body, 999)).toBe(1);
    expect(countEntriesSince(body, 1000)).toBe(0); // strictly greater
    expect(countEntriesSince(body, 1001)).toBe(0);
  });

  test("multiple entries — counts only those past cursor", () => {
    const body = [
      entry("aaaaaaaa", 1000, "Q1?", "D1"),
      entry("bbbbbbbb", 2000, "Q2?", "D2"),
      entry("cccccccc", 3000, "Q3?", "D3"),
    ].join("\n");
    expect(countEntriesSince(body, 0)).toBe(3);
    expect(countEntriesSince(body, 1500)).toBe(2);
    expect(countEntriesSince(body, 2999)).toBe(1);
    expect(countEntriesSince(body, 3000)).toBe(0);
  });

  test("stray `- **timestamp**:` lines in prose don't trigger a count", () => {
    // Defends against the AWK filter's "must follow ### d- header" rule.
    const body = `# Notes\n\nSomeone wrote about a fake field: \`- **timestamp**: 9999\` in prose.\n`;
    expect(countEntriesSince(body, 0)).toBe(0);
  });

  test("missing/malformed timestamp inside an entry doesn't crash", () => {
    const body = `### d-xx — q [high] (00:00 MYT)\n\n- **timestamp**: not-a-number\n`;
    expect(countEntriesSince(body, 0)).toBe(0);
  });

  test("two timestamp lines after one header — only the first attaches", () => {
    const body = `### d-aa — q [high] (00:00 MYT)\n- **timestamp**: 100\n- **timestamp**: 200\n`;
    // First timestamp triggers count, but inEntry flips off — second line
    // is treated as orphan prose (correct: a real entry has exactly one
    // timestamp field).
    expect(countEntriesSince(body, 50)).toBe(1);
    expect(countEntriesSince(body, 150)).toBe(0);
  });
});

describe("readDecisionsCursor — bash dcursor_old=0 default semantics", () => {
  test("missing file returns 0", async () => {
    expect(await readDecisionsCursor(atmuxDir)).toBe(0);
  });

  test("empty file returns 0", async () => {
    await writeFile(join(atmuxDir, "state", "decisions-cursor"), "");
    expect(await readDecisionsCursor(atmuxDir)).toBe(0);
  });

  test("malformed file returns 0", async () => {
    await writeFile(join(atmuxDir, "state", "decisions-cursor"), "not-a-number\n");
    expect(await readDecisionsCursor(atmuxDir)).toBe(0);
  });

  test("valid integer (with trailing newline) parses", async () => {
    await writeFile(join(atmuxDir, "state", "decisions-cursor"), "1715290000\n");
    expect(await readDecisionsCursor(atmuxDir)).toBe(1715290000);
  });
});

describe("advanceDecisionsCursor — atomic write", () => {
  test("writes the cursor value then round-trips through read", async () => {
    await advanceDecisionsCursor(atmuxDir, 1715290000);
    expect(await readDecisionsCursor(atmuxDir)).toBe(1715290000);
    const raw = await readFile(join(atmuxDir, "state", "decisions-cursor"), "utf8");
    expect(raw).toBe("1715290000\n");
  });

  test("overwrites an existing cursor", async () => {
    await advanceDecisionsCursor(atmuxDir, 100);
    await advanceDecisionsCursor(atmuxDir, 200);
    expect(await readDecisionsCursor(atmuxDir)).toBe(200);
  });
});

describe("checkDecisions — end-to-end verdict", () => {
  test("decisions.md absent → fire=false, no bullet, no cursor", async () => {
    const v = await checkDecisions({ atmuxDir });
    expect(v.fire).toBe(false);
    expect(v.bullet).toBeNull();
    expect(v.newCursor).toBeNull();
    expect(v.newCount).toBe(0);
  });

  test("file present + no new entries since cursor → fire=false", async () => {
    const path = join(atmuxDir, "decisions.md");
    await writeFile(path, entry("aaaaaaaa", 1000, "Q1?", "D1"));
    await advanceDecisionsCursor(atmuxDir, Math.floor(Date.now() / 1000) + 60);
    const v = await checkDecisions({ atmuxDir });
    expect(v.fire).toBe(false);
  });

  test("file present + 1 new entry → fire=true + flag-only pointer bullet", async () => {
    const path = join(atmuxDir, "decisions.md");
    await writeFile(path, entry("aaaaaaaa", 1000, "Q1?", "D1"));
    // Cursor=0 → fresh team
    const v = await checkDecisions({ atmuxDir });
    expect(v.fire).toBe(true);
    expect(v.newCount).toBe(1);
    expect(v.bullet).toBe("📋 1 new decision — atmux decisions list");
    expect(v.newCursor).not.toBeNull();
  });

  test("file present + 3 new entries → bullet pluralises", async () => {
    const path = join(atmuxDir, "decisions.md");
    const body = [
      entry("a1", 1000, "Q1?", "D1"),
      entry("a2", 2000, "Q2?", "D2"),
      entry("a3", 3000, "Q3?", "D3"),
    ].join("\n");
    await writeFile(path, body);
    const v = await checkDecisions({ atmuxDir });
    expect(v.fire).toBe(true);
    expect(v.newCount).toBe(3);
    expect(v.bullet).toBe("📋 3 new decisions — atmux decisions list");
  });

  test("mtime advance but no entries past cursor → fire=false (prose-only edit)", async () => {
    const path = join(atmuxDir, "decisions.md");
    await writeFile(path, entry("aaaaaaaa", 1000, "Q1?", "D1"));
    // Persist a high cursor that's past the entry timestamp.
    await advanceDecisionsCursor(atmuxDir, 5000);
    // Touch the file (newer mtime) but the entry inside doesn't change.
    const future = Date.now();
    await Bun.write(path, entry("aaaaaaaa", 1000, "Q1?", "D1") + "\n<!-- prose edit -->\n");
    // Force mtime ahead of cursor for the test. (File ops above already
    // bump mtime; readDecisionsCursor reads our cursor=5000; mtime is
    // current Date.now() > cursor unless the suite races, which we
    // tolerate via the strict-greater entry filter.)
    void future;
    const v = await checkDecisions({ atmuxDir });
    // Entry timestamp 1000 ≤ cursor 5000 → no new entries → fire false.
    expect(v.fire).toBe(false);
  });

  test("cursor advance after fire — re-check returns fire=false", async () => {
    const path = join(atmuxDir, "decisions.md");
    await writeFile(path, entry("aaaaaaaa", 1000, "Q1?", "D1"));
    const first = await checkDecisions({ atmuxDir });
    expect(first.fire).toBe(true);
    expect(first.newCursor).not.toBeNull();
    await advanceDecisionsCursor(atmuxDir, first.newCursor as number);
    const second = await checkDecisions({ atmuxDir });
    expect(second.fire).toBe(false);
  });
});
