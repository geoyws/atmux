// Unit tests for src/core/release-notes-sweep.ts (ADR-147 T8).
//
// Pure tests for the sweep helpers + stubbed-git integration test for
// the top-level `runReleaseNotesAutoAppend`. The hygiene-tick verb's
// wiring is tested separately (see tests/unit/verbs/hygiene-tick.test.ts).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnResult } from "../../../src/abstractions/spawn.ts";
import type { GitSpawn } from "../../../src/abstractions/worktree.ts";
import {
  entryAlreadyRecorded,
  renderAdrEntry,
  renderMergeEntry,
  renderShippedEntry,
  runReleaseNotesAutoAppend,
  sectionRange,
  startOfMytDayEpochSec,
} from "../../../src/core/release-notes-sweep.ts";
import type { KanbanTask } from "../../../src/schema/kanban.ts";

// ---------- Fixture helpers ----------

/** Construct a `git`-spawn stub. Each entry maps an argv-substring to
 *  a canned `SpawnResult`. The same response is returned on every match
 *  — call-count is unbounded, mirroring real `git log` behavior where
 *  the same query returns the same rows on every invocation (so
 *  idempotency tests can call into the sweep N times). Unmatched
 *  argvs fall through to an empty-stdout success. */
function stubGit(responses: Record<string, SpawnResult>): GitSpawn {
  return async (argv: ReadonlyArray<string>): Promise<SpawnResult> => {
    const joined = argv.join(" ");
    for (const [needle, response] of Object.entries(responses)) {
      if (joined.includes(needle)) return response;
    }
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
      signalled: null,
      durationMs: 0,
      cmd: "git",
      argv: [],
    };
  };
}

function ok(stdout: string): SpawnResult {
  return { exitCode: 0, stdout, stderr: "", signalled: null, durationMs: 0, cmd: "git", argv: [] };
}

const MYT_NOW_2026_05_15 = Date.UTC(2026, 4, 15, 4, 0); // 12:00 MYT

/** Compose a minimal KanbanTask. Permissive defaults; tests override. */
function task(over: Partial<KanbanTask>): KanbanTask {
  return {
    id: over.id ?? "t-stub",
    subject: over.subject ?? "subject",
    status: over.status ?? "done",
    completedAt: over.completedAt ?? Math.floor(MYT_NOW_2026_05_15 / 1000),
    ...over,
  } as KanbanTask;
}

// ---------- sectionRange ----------

describe("sectionRange", () => {
  test("returns header + body range when section is present", () => {
    const body = [
      "# 2026-05-15",
      "",
      "## Shipped (kanban→done)",
      "",
      "- t-aaaa — first",
      "",
      "## Merges (branch→trunk)",
      "",
    ].join("\n");
    const r = sectionRange(body, "Shipped (kanban→done)");
    expect(r).not.toBeNull();
    expect(r?.startIdx).toBe(2);
    // endIdx is the index of the next H2 header (Merges)
    expect(r?.endIdx).toBe(6);
  });

  test("returns null when the section is missing", () => {
    const body = "# 2026-05-15\n\n## Notes (optional)\n\n";
    expect(sectionRange(body, "Shipped (kanban→done)")).toBeNull();
  });

  test("endIdx is EOF when section is the LAST H2 in the file", () => {
    const body = ["# 2026-05-15", "", "## Notes (optional)", "", "- final entry"].join("\n");
    const r = sectionRange(body, "Notes (optional)");
    expect(r?.endIdx).toBe(5);
  });
});

// ---------- entryAlreadyRecorded ----------

describe("entryAlreadyRecorded", () => {
  const seeded = [
    "# 2026-05-15",
    "",
    "## Shipped (kanban→done)",
    "",
    "- t-aaaaaaaa — already shipped task",
    "",
    "## Merges (branch→trunk)",
    "",
    "- abc1234 — merge: foo",
    "",
    "## ADRs landed",
    "",
    "- ADR-099 — Some prior decision (first-add @ deadbee)",
    "",
  ].join("\n");

  test("returns false on null / empty body (caller appends normally)", () => {
    expect(entryAlreadyRecorded(null, "Shipped (kanban→done)", "t-aaaaaaaa")).toBe(false);
    expect(entryAlreadyRecorded("", "Shipped (kanban→done)", "t-aaaaaaaa")).toBe(false);
  });

  test("returns false on empty id marker (defensive)", () => {
    expect(entryAlreadyRecorded(seeded, "Shipped (kanban→done)", "")).toBe(false);
  });

  test("returns true when the id marker substring lives inside the section", () => {
    expect(entryAlreadyRecorded(seeded, "Shipped (kanban→done)", "t-aaaaaaaa")).toBe(true);
    expect(entryAlreadyRecorded(seeded, "Merges (branch→trunk)", "abc1234")).toBe(true);
    expect(entryAlreadyRecorded(seeded, "ADRs landed", "ADR-099")).toBe(true);
  });

  test("returns false when the id marker isn't in the section (even if elsewhere)", () => {
    // `t-aaaaaaaa` lives in Shipped; absent in Merges; the section
    // scope keeps the false-positive away.
    expect(entryAlreadyRecorded(seeded, "Merges (branch→trunk)", "t-aaaaaaaa")).toBe(false);
  });

  test("returns false when the named section is missing entirely", () => {
    const body = "# 2026-05-15\n\n## Notes (optional)\n\n";
    expect(entryAlreadyRecorded(body, "Shipped (kanban→done)", "t-zzz")).toBe(false);
  });
});

// ---------- startOfMytDayEpochSec ----------

describe("startOfMytDayEpochSec", () => {
  test("anchors on MYT-midnight even when UTC clock is in the prior day", () => {
    // 2026-05-14 19:00Z = 03:00 MYT 2026-05-15. The MYT-day is
    // 2026-05-15, so the start of day = 2026-05-15 00:00 MYT =
    // 2026-05-14 16:00Z.
    const justPastMytMidnight = Date.UTC(2026, 4, 14, 19, 0);
    const out = startOfMytDayEpochSec(justPastMytMidnight);
    expect(out).toBe(Math.floor(Date.UTC(2026, 4, 14, 16, 0) / 1000));
  });

  test("anchors on the same MYT-midnight for any time within the MYT-day", () => {
    const a = Date.UTC(2026, 4, 15, 4, 0); // 12:00 MYT
    const b = Date.UTC(2026, 4, 15, 15, 59); // 23:59 MYT
    expect(startOfMytDayEpochSec(a)).toBe(startOfMytDayEpochSec(b));
  });
});

// ---------- renderers ----------

describe("renderers", () => {
  test("renderShippedEntry renders id + subject + note", () => {
    const out = renderShippedEntry(
      task({ id: "t-1234abcd", subject: "Add foo", note: "feat(foo): add" }),
    );
    expect(out).toBe("- t-1234abcd — Add foo — feat(foo): add");
  });

  test("renderShippedEntry omits note section when note is empty", () => {
    const out = renderShippedEntry(task({ id: "t-1234abcd", subject: "Add foo" }));
    expect(out).toBe("- t-1234abcd — Add foo");
  });

  test("renderShippedEntry uses placeholder on empty subject", () => {
    const out = renderShippedEntry(task({ id: "t-1234abcd", subject: "" }));
    expect(out).toBe("- t-1234abcd — (no subject)");
  });

  test("renderMergeEntry renders sha + subject", () => {
    expect(renderMergeEntry({ sha: "abc1234", subject: "merge: foo → bar" })).toBe(
      "- abc1234 — merge: foo → bar",
    );
  });

  test("renderAdrEntry renders id + title + first-add sha", () => {
    expect(
      renderAdrEntry({ id: "ADR-147", title: "Ombudsman role + release-notes", sha: "deadbee" }),
    ).toBe("- ADR-147 — Ombudsman role + release-notes (first-add @ deadbee)");
  });
});

// ---------- runReleaseNotesAutoAppend (integration on tmpdir) ----------

describe("runReleaseNotesAutoAppend", () => {
  let repoRoot: string;
  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "atmux-relnotes-sweep-"));
    // Pre-create docs/adr/ so the listAdrs probe has a real dir to read.
    await writeFile(join(repoRoot, ".keep"), "");
  });
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  const dayFile = (root: string) =>
    join(root, "docs", "release-notes", "2026", "05", "2026-05-15.md");

  test("appends ## Shipped entries for done tasks completed within MYT day", async () => {
    const startOfDaySec = startOfMytDayEpochSec(MYT_NOW_2026_05_15);
    const kanban: KanbanTask[] = [
      task({
        id: "t-aaaaaaaa",
        subject: "Add foo",
        note: "feat(foo): add",
        completedAt: startOfDaySec + 3600,
      }),
      task({
        id: "t-bbbbbbbb",
        subject: "Fix bar",
        note: "fix(bar): patch",
        completedAt: startOfDaySec + 7200,
      }),
    ];
    const git = stubGit({}); // no merges, no ADRs queued
    const out = await runReleaseNotesAutoAppend({
      repoRoot,
      baseBranch: "geoyws",
      kanban,
      git,
      nowMs: MYT_NOW_2026_05_15,
    });

    expect(out.shipped.appended).toEqual(["t-aaaaaaaa", "t-bbbbbbbb"]);
    expect(out.shipped.skipped).toEqual([]);
    const body = await readFile(dayFile(repoRoot), "utf8");
    expect(body).toContain("- t-aaaaaaaa — Add foo — feat(foo): add");
    expect(body).toContain("- t-bbbbbbbb — Fix bar — fix(bar): patch");
    expect(body).toContain("## Shipped (kanban→done)");
    expect(body).toContain("## Merges (branch→trunk)"); // skeleton present
  });

  test("second invocation is a no-op (idempotent re-fire)", async () => {
    const startOfDaySec = startOfMytDayEpochSec(MYT_NOW_2026_05_15);
    const kanban: KanbanTask[] = [
      task({ id: "t-aaaaaaaa", subject: "Add foo", completedAt: startOfDaySec + 3600 }),
    ];
    const git = stubGit({});

    const first = await runReleaseNotesAutoAppend({
      repoRoot,
      baseBranch: "geoyws",
      kanban,
      git,
      nowMs: MYT_NOW_2026_05_15,
    });
    expect(first.shipped.appended).toEqual(["t-aaaaaaaa"]);

    const second = await runReleaseNotesAutoAppend({
      repoRoot,
      baseBranch: "geoyws",
      kanban,
      git,
      nowMs: MYT_NOW_2026_05_15,
    });
    expect(second.shipped.appended).toEqual([]);
    expect(second.shipped.skipped).toEqual(["t-aaaaaaaa"]);
  });

  test("filters tasks done BEFORE the MYT day start (cross-day boundary)", async () => {
    const startOfDaySec = startOfMytDayEpochSec(MYT_NOW_2026_05_15);
    const kanban: KanbanTask[] = [
      // Yesterday — should be filtered.
      task({ id: "t-yesterday", subject: "Old task", completedAt: startOfDaySec - 3600 }),
      // Today — appended.
      task({ id: "t-today", subject: "New task", completedAt: startOfDaySec + 60 }),
    ];
    const git = stubGit({});
    const out = await runReleaseNotesAutoAppend({
      repoRoot,
      baseBranch: "geoyws",
      kanban,
      git,
      nowMs: MYT_NOW_2026_05_15,
    });
    expect(out.shipped.appended).toEqual(["t-today"]);
    expect(out.shipped.skipped).toEqual([]);

    const body = await readFile(dayFile(repoRoot), "utf8");
    expect(body).toContain("t-today");
    expect(body).not.toContain("t-yesterday");
  });

  test("filters non-done tasks (status guard)", async () => {
    const kanban: KanbanTask[] = [
      task({ id: "t-inprog", status: "in-progress" }),
      task({ id: "t-todo", status: "todo" }),
    ];
    const git = stubGit({});
    const out = await runReleaseNotesAutoAppend({
      repoRoot,
      baseBranch: "geoyws",
      kanban,
      git,
      nowMs: MYT_NOW_2026_05_15,
    });
    expect(out.shipped.appended).toEqual([]);
  });

  test("appends ## Merges entries for trunk merge commits", async () => {
    const git = stubGit({
      // first probe — `git log --merges --first-parent <branch>`
      "log --merges": ok("abc1234\tmerge: foo → trunk\ndef5678\tmerge: bar → trunk\n"),
      "log --diff-filter=A": ok(""), // no ADRs
    });
    const out = await runReleaseNotesAutoAppend({
      repoRoot,
      baseBranch: "geoyws",
      kanban: [],
      git,
      nowMs: MYT_NOW_2026_05_15,
    });
    expect(out.merges.appended).toEqual(["abc1234", "def5678"]);
    const body = await readFile(dayFile(repoRoot), "utf8");
    expect(body).toContain("- abc1234 — merge: foo → trunk");
    expect(body).toContain("- def5678 — merge: bar → trunk");
  });

  test("appends ## ADRs landed entries for newly-added ADR files", async () => {
    const git = stubGit({
      "log --merges": ok(""),
      "log --diff-filter=A": ok(
        // Two ADRs added today.
        "deadbee\n" +
          "docs/adr/147-ombudsman-and-release-notes.md\n" +
          "\n" +
          "cafebab\n" +
          "docs/adr/148-some-other-decision.md\n",
      ),
      // `git show HEAD:<path>` for title resolution
      "show HEAD:docs/adr/147-ombudsman-and-release-notes.md": ok(
        "# ADR-147: Ombudsman role + release-notes layout\n\nbody...\n",
      ),
      "show HEAD:docs/adr/148-some-other-decision.md": ok(
        "# ADR-148: Some other decision\n\nbody...\n",
      ),
    });
    const out = await runReleaseNotesAutoAppend({
      repoRoot,
      baseBranch: "geoyws",
      kanban: [],
      git,
      nowMs: MYT_NOW_2026_05_15,
    });
    expect(out.adrsLanded.appended).toEqual(["ADR-147", "ADR-148"]);
    const body = await readFile(dayFile(repoRoot), "utf8");
    expect(body).toContain(
      "- ADR-147 — Ombudsman role + release-notes layout (first-add @ deadbee)",
    );
    expect(body).toContain("- ADR-148 — Some other decision (first-add @ cafebab)");
  });

  test("second invocation of merges + ADRs is no-op (idempotent across sections)", async () => {
    const git = stubGit({
      "log --merges": ok("abc1234\tmerge: foo\n"),
      "log --diff-filter=A": ok("deadbee\ndocs/adr/147-ombudsman.md\n"),
      "show HEAD:docs/adr/147-ombudsman.md": ok("# ADR-147: Ombudsman\n"),
    });
    const first = await runReleaseNotesAutoAppend({
      repoRoot,
      baseBranch: "geoyws",
      kanban: [],
      git,
      nowMs: MYT_NOW_2026_05_15,
    });
    expect(first.merges.appended).toEqual(["abc1234"]);
    expect(first.adrsLanded.appended).toEqual(["ADR-147"]);

    const second = await runReleaseNotesAutoAppend({
      repoRoot,
      baseBranch: "geoyws",
      kanban: [],
      git,
      nowMs: MYT_NOW_2026_05_15,
    });
    expect(second.merges.appended).toEqual([]);
    expect(second.merges.skipped).toEqual(["abc1234"]);
    expect(second.adrsLanded.appended).toEqual([]);
    expect(second.adrsLanded.skipped).toEqual(["ADR-147"]);
  });

  test("multiple sections in one tick all land in one day-file", async () => {
    const startOfDaySec = startOfMytDayEpochSec(MYT_NOW_2026_05_15);
    const kanban: KanbanTask[] = [
      task({ id: "t-aaaaaaaa", subject: "ship me", completedAt: startOfDaySec + 60 }),
    ];
    const git = stubGit({
      "log --merges": ok("abc1234\tmerge: foo\n"),
      "log --diff-filter=A": ok("deadbee\ndocs/adr/147-x.md\n"),
      "show HEAD:docs/adr/147-x.md": ok("# ADR-147: X\n"),
    });
    const out = await runReleaseNotesAutoAppend({
      repoRoot,
      baseBranch: "geoyws",
      kanban,
      git,
      nowMs: MYT_NOW_2026_05_15,
    });
    expect(out.shipped.appended).toEqual(["t-aaaaaaaa"]);
    expect(out.merges.appended).toEqual(["abc1234"]);
    expect(out.adrsLanded.appended).toEqual(["ADR-147"]);

    const body = await readFile(dayFile(repoRoot), "utf8");
    // All three sections + their entries
    expect(body).toContain("# 2026-05-15");
    expect(body).toContain("## Shipped (kanban→done)");
    expect(body).toContain("- t-aaaaaaaa — ship me");
    expect(body).toContain("## Merges (branch→trunk)");
    expect(body).toContain("- abc1234 — merge: foo");
    expect(body).toContain("## ADRs landed");
    expect(body).toContain("- ADR-147 — X (first-add @ deadbee)");
  });

  test("cross-day boundary: writes to today's MYT day-file, not yesterday's", async () => {
    // Anchor `nowMs` at 2026-05-15 00:30 MYT = 2026-05-14 16:30 UTC.
    // The day-file path MUST resolve to 2026-05-15.md (MYT day), not
    // 2026-05-14.md (UTC day).
    const justAfterMytMidnight = Date.UTC(2026, 4, 14, 16, 30);
    const startOfDaySec = startOfMytDayEpochSec(justAfterMytMidnight);
    const kanban: KanbanTask[] = [
      task({ id: "t-aaaaaaaa", subject: "post-midnight", completedAt: startOfDaySec + 60 }),
    ];
    const git = stubGit({});
    const out = await runReleaseNotesAutoAppend({
      repoRoot,
      baseBranch: "geoyws",
      kanban,
      git,
      nowMs: justAfterMytMidnight,
    });
    expect(out.dayFilePath.endsWith("/2026/05/2026-05-15.md")).toBe(true);
  });

  test("git probe failure on merges: returns empty list (no throw)", async () => {
    // `git log --merges` exits non-zero — the helper should swallow
    // and report zero merges. Caller continues with other sections.
    const git: GitSpawn = async (argv) => {
      const joined = argv.join(" ");
      if (joined.includes("log --merges")) {
        return {
          exitCode: 128,
          stdout: "",
          stderr: "fatal: bad revision",
          signalled: null,
          durationMs: 0,
          cmd: "git",
          argv: [],
        };
      }
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        signalled: null,
        durationMs: 0,
        cmd: "git",
        argv: [],
      };
    };
    const out = await runReleaseNotesAutoAppend({
      repoRoot,
      baseBranch: "geoyws",
      kanban: [],
      git,
      nowMs: MYT_NOW_2026_05_15,
    });
    expect(out.merges.appended).toEqual([]);
    expect(out.merges.skipped).toEqual([]);
  });
});
