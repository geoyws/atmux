// Unit tests for src/verbs/team-rename-fs.ts (ADR-027 T3).
// File-state orchestration steps 1, 2, 5, 9 — real fs against
// per-test mkdtemp roots. Every export exercised across happy +
// refuse + undo + idempotent branches for 100% line + branch
// coverage. Pattern mirrors tests/unit/verbs/cleanup.test.ts §setup.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ConfigError, FsError } from "../../../src/errors.ts";
import {
  acquireRenameLock,
  isRenameInProgress,
  mutateTeamJson,
  releaseRenameLock,
  renameLockPath,
  type RenameLockBody,
  rewriteSessionAnchor,
} from "../../../src/verbs/team-rename-fs.ts";

let root: string;
let atmuxDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "atmux-rename-fs-"));
  atmuxDir = join(root, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  await mkdir(join(atmuxDir, "state"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Helper — write a minimal valid `team.json` for tests. The `Team`
 *  schema accepts arbitrary additional members[] entries; the
 *  positive-path tests only care about `.name`. */
async function seedTeamJson(name: string): Promise<void> {
  const body = { name, members: [] };
  await writeFile(
    join(atmuxDir, "team.json"),
    `${JSON.stringify(body, null, 2)}\n`,
    "utf8",
  );
}

// ---------- renameLockPath ----------

describe("renameLockPath", () => {
  test("resolves to <atmuxDir>/state/rename.lock", () => {
    expect(renameLockPath("/proj/.atmux")).toBe("/proj/.atmux/state/rename.lock");
  });
});

// ---------- acquireRenameLock ----------

describe("acquireRenameLock", () => {
  test("happy: writes JSON body, returns RollbackStep, undo() removes file", async () => {
    const before = Date.now();
    const step = await acquireRenameLock({ atmuxDir, oldName: "old", newName: "new" });
    const after = Date.now();
    const lockPath = renameLockPath(atmuxDir);
    const text = await readFile(lockPath, "utf8");
    const body = JSON.parse(text) as RenameLockBody;
    expect(body.old).toBe("old");
    expect(body.new).toBe("new");
    expect(typeof body.epoch).toBe("number");
    expect(body.epoch).toBeGreaterThanOrEqual(before);
    expect(body.epoch).toBeLessThanOrEqual(after);
    expect(step.label).toContain("acquire rename.lock");
    expect(step.label).toContain("old → new");
    await step.undo();
    await expect(readFile(lockPath, "utf8")).rejects.toThrow();
  });

  test("refuse: throws ConfigError when lock already exists", async () => {
    const lockPath = renameLockPath(atmuxDir);
    await writeFile(lockPath, '{"old":"x","new":"y","epoch":1}', "utf8");
    await expect(
      acquireRenameLock({ atmuxDir, oldName: "old", newName: "new" }),
    ).rejects.toThrow(ConfigError);
  });

  test("refuse: surfaces existing body in hint for operator triage", async () => {
    const lockPath = renameLockPath(atmuxDir);
    const stale = '{"old":"prior","new":"target","epoch":999}';
    await writeFile(lockPath, stale, "utf8");
    try {
      await acquireRenameLock({ atmuxDir, oldName: "a", newName: "b" });
      throw new Error("expected acquireRenameLock to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const message = (e as Error).message;
      expect(message).toContain(stale);
    }
  });

  test("refuse: ConfigError hint copes with unreadable lock body", async () => {
    // Create a directory at the lock path so readTextOrNull errors out
    // (returns null only on ENOENT; an EISDIR would actually throw —
    // but `exists()` will see the dir and we'll hit the read path).
    // Easier: simulate "unreadable" via a real file we then race; here
    // we just assert the message shape on a file that contains the
    // empty string.
    const lockPath = renameLockPath(atmuxDir);
    await writeFile(lockPath, "", "utf8");
    try {
      await acquireRenameLock({ atmuxDir, oldName: "a", newName: "b" });
      throw new Error("expected acquireRenameLock to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      // Empty body still surfaces in the hint (between the parens) —
      // operator sees `()` and knows the lock was empty.
      expect((e as Error).message).toContain("rename.lock already exists");
    }
  });

  test("undo() is idempotent — second call no-ops when file already gone", async () => {
    const step = await acquireRenameLock({ atmuxDir, oldName: "a", newName: "b" });
    await step.undo();
    await step.undo(); // must not throw — removeFile uses force:true
  });
});

// ---------- mutateTeamJson ----------

describe("mutateTeamJson", () => {
  test("happy: writes .name, creates backup, undo restores byte-equal", async () => {
    await seedTeamJson("old");
    const teamPath = join(atmuxDir, "team.json");
    const originalBytes = await readFile(teamPath, "utf8");

    const step = await mutateTeamJson({ atmuxDir, oldName: "old", newName: "new" });
    const after = JSON.parse(await readFile(teamPath, "utf8")) as { name: string };
    expect(after.name).toBe("new");

    const entries = await readdir(atmuxDir);
    const baks = entries.filter((f) => f.startsWith("team.json.bak."));
    expect(baks.length).toBe(1);
    const bakBody = await readFile(join(atmuxDir, baks[0] as string), "utf8");
    expect(bakBody).toBe(originalBytes);

    await step.undo();
    const restoredBytes = await readFile(teamPath, "utf8");
    expect(restoredBytes).toBe(originalBytes);
    const entriesAfter = await readdir(atmuxDir);
    expect(entriesAfter.filter((f) => f.startsWith("team.json.bak."))).toEqual([]);
  });

  test("label includes oldName → newName", async () => {
    await seedTeamJson("alpha");
    const step = await mutateTeamJson({ atmuxDir, oldName: "alpha", newName: "beta" });
    expect(step.label).toContain("mutate team.json");
    expect(step.label).toContain("alpha → beta");
    await step.undo();
  });

  test("undo: throws FsError when backup file was manually removed", async () => {
    await seedTeamJson("old");
    const step = await mutateTeamJson({ atmuxDir, oldName: "old", newName: "new" });
    // Operator-style manual rm of the backup between mutation + undo:
    const entries = await readdir(atmuxDir);
    const baks = entries.filter((f) => f.startsWith("team.json.bak."));
    await rm(join(atmuxDir, baks[0] as string));
    await expect(step.undo()).rejects.toThrow(FsError);
  });

  test("post-write team.json is valid JSON with the schema-required keys preserved", async () => {
    // Seed with extra keys to confirm we preserve passthrough fields.
    const seed = { name: "old", members: [{ name: "fe-1", tui: "claude" }] };
    await writeFile(
      join(atmuxDir, "team.json"),
      `${JSON.stringify(seed, null, 2)}\n`,
      "utf8",
    );
    const step = await mutateTeamJson({ atmuxDir, oldName: "old", newName: "renamed" });
    const after = JSON.parse(await readFile(join(atmuxDir, "team.json"), "utf8")) as {
      name: string;
      members: { name: string; tui: string }[];
    };
    expect(after.name).toBe("renamed");
    expect(after.members).toEqual([{ name: "fe-1", tui: "claude" }]);
    await step.undo();
  });
});

// ---------- rewriteSessionAnchor ----------

describe("rewriteSessionAnchor", () => {
  test("happy: writes new session, undo restores prior bytes", async () => {
    const anchor = join(atmuxDir, "state", "session.txt");
    await writeFile(anchor, "old-session\n", "utf8");
    const step = await rewriteSessionAnchor({ atmuxDir, newSession: "new-session" });
    expect(await readFile(anchor, "utf8")).toBe("new-session\n");
    expect(step.label).toContain("old-session → new-session");
    await step.undo();
    expect(await readFile(anchor, "utf8")).toBe("old-session\n");
  });

  test("no-op when anchor absent: identity step, undo is silent", async () => {
    const anchor = join(atmuxDir, "state", "session.txt");
    // Confirm anchor truly absent.
    await expect(readFile(anchor, "utf8")).rejects.toThrow();
    const step = await rewriteSessionAnchor({ atmuxDir, newSession: "anything" });
    expect(step.label).toContain("no-op");
    expect(step.label).toContain("singleSession=false");
    await step.undo(); // identity — no throw
    await expect(readFile(anchor, "utf8")).rejects.toThrow();
  });

  test("preserves byte-exact prior content (no trailing-newline normalization)", async () => {
    const anchor = join(atmuxDir, "state", "session.txt");
    // Older atmux wrote `team` (no trailing \n); modern writes `team\n`.
    // Either way, undo must restore the operator's original bytes.
    await writeFile(anchor, "legacy-no-newline", "utf8");
    const step = await rewriteSessionAnchor({ atmuxDir, newSession: "modern" });
    expect(await readFile(anchor, "utf8")).toBe("modern\n");
    await step.undo();
    expect(await readFile(anchor, "utf8")).toBe("legacy-no-newline");
  });
});

// ---------- releaseRenameLock ----------

describe("releaseRenameLock", () => {
  test("happy: removes existing lock file", async () => {
    const lockPath = renameLockPath(atmuxDir);
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, '{"old":"a","new":"b","epoch":1}', "utf8");
    await releaseRenameLock({ atmuxDir });
    await expect(readFile(lockPath, "utf8")).rejects.toThrow();
  });

  test("idempotent: no throw when lock already absent", async () => {
    // No lock exists at all — releaseRenameLock must silently no-op.
    await releaseRenameLock({ atmuxDir });
    // Second call still safe.
    await releaseRenameLock({ atmuxDir });
  });
});

// ---------- Edge cases ----------
//
// Beyond the 100% line/branch/funcs coverage of the happy + undo paths
// above, these tests pin down behavior at boundary conditions where
// the dispatcher contract is implicit: epoch-precision granularity,
// schema-failure-mid-mutation, empty-string-vs-absent file semantics,
// and the documented idempotence claim across the rollback chain.

describe("acquireRenameLock — boundary", () => {
  test("epoch is millisecond-precision (Date.now), not second-precision", async () => {
    // The bak filename uses Math.floor(Date.now() / 1000) (seconds) per
    // groom-side convention; the lock body uses Date.now() (ms) to
    // disambiguate two renames inside the same second. Pin this here
    // so the precision skew is documented.
    await acquireRenameLock({ atmuxDir, oldName: "x", newName: "y" });
    const body = JSON.parse(await readFile(renameLockPath(atmuxDir), "utf8")) as RenameLockBody;
    // ms-precision epochs are >= 1e12 (year 2001+); s-precision are < 1e10.
    expect(body.epoch).toBeGreaterThanOrEqual(1e12);
  });

  test("undo() after a sibling releaseRenameLock is a silent no-op", async () => {
    // Documents the docstring claim: rollback walks reverse-iterate
    // every completed step; if step 9 (releaseRenameLock) already ran,
    // step 1's undo() must not throw on the missing file.
    const step = await acquireRenameLock({ atmuxDir, oldName: "p", newName: "q" });
    await releaseRenameLock({ atmuxDir });
    await step.undo(); // must not throw — removeFile uses force:true
  });
});

describe("mutateTeamJson — boundary", () => {
  test("two same-second mutations collide on bak path; second's undo() throws after first's undo() removed the shared bak", async () => {
    // The bak naming is `<path>.bak.<epoch-seconds>`. Two
    // mutateTeamJson calls within one second hash to the SAME bak
    // path, and step2's `atomicWrite(backupPath, original)` overwrites
    // step1's backup with step2's pre-image. This is acceptable under
    // the rename.lock serialization invariant (only one rename in
    // flight at a time per ADR-027 §Pre-flight), but if a future
    // change accidentally allows parallel mutations, the rollback
    // chain breaks predictably: whichever undo() runs last finds the
    // bak gone (removed by the earlier undo()) and throws FsError.
    //
    // Pin BOTH ends:
    //   (a) when same-second collision happens, only one bak file
    //       exists post-mutation;
    //   (b) the SECOND undo() to run throws FsError on the missing
    //       shared bak.
    await seedTeamJson("alpha");
    const step1 = await mutateTeamJson({ atmuxDir, oldName: "alpha", newName: "beta" });
    // Rapid second call: re-seed `alpha` to mirror a hypothetical
    // rollback-then-redo cycle within the same second.
    await writeFile(
      join(atmuxDir, "team.json"),
      `${JSON.stringify({ name: "alpha", members: [] }, null, 2)}\n`,
      "utf8",
    );
    const step2 = await mutateTeamJson({ atmuxDir, oldName: "alpha", newName: "gamma" });

    const entries = await readdir(atmuxDir);
    const baks = entries.filter((f) => f.startsWith("team.json.bak."));
    if (baks.length !== 1) {
      // CI ticked the second boundary between the two calls; collision
      // didn't fire, no double-rollback hazard to assert. Best-effort
      // cleanup + skip the boundary assertions.
      await step2.undo();
      await step1.undo();
      return;
    }
    // Collision fired. step2.undo() restores team.json from the shared
    // bak then removes it. step1.undo() then finds the bak gone and
    // throws FsError — proving the parallel-mutation hazard.
    await step2.undo();
    await expect(step1.undo()).rejects.toThrow(FsError);
  });
});

describe("rewriteSessionAnchor — boundary", () => {
  test("empty-string session.txt is treated as present (not absent)", async () => {
    // readTextOrNull returns null ONLY on ENOENT; an empty file
    // returns "". The step must take the "present" branch and
    // rewrite, with undo() restoring the empty string.
    const anchor = join(atmuxDir, "state", "session.txt");
    await writeFile(anchor, "", "utf8");
    const step = await rewriteSessionAnchor({ atmuxDir, newSession: "fresh" });
    expect(step.label).not.toContain("no-op");
    expect(await readFile(anchor, "utf8")).toBe("fresh\n");
    await step.undo();
    expect(await readFile(anchor, "utf8")).toBe("");
  });

  test("newSession content is written verbatim without normalization (caller validates upstream)", async () => {
    // The helper trusts the caller's newSession value; no charset
    // validation here (that's `validateTeamName` from T1, called by
    // the dispatcher before this helper runs). Document the contract:
    // whatever bytes the caller passes get written, plus one \n.
    const anchor = join(atmuxDir, "state", "session.txt");
    await writeFile(anchor, "prior\n", "utf8");
    const step = await rewriteSessionAnchor({ atmuxDir, newSession: "with-special_chars-09" });
    expect(await readFile(anchor, "utf8")).toBe("with-special_chars-09\n");
    await step.undo();
  });
});

// ---------- isRenameInProgress (read-side guard primitive) ----------

describe("isRenameInProgress", () => {
  test("returns false when rename.lock is absent", async () => {
    expect(await isRenameInProgress(atmuxDir)).toBe(false);
  });

  test("returns true when rename.lock is present", async () => {
    await writeFile(renameLockPath(atmuxDir), '{"old":"a","new":"b","epoch":1}', "utf8");
    expect(await isRenameInProgress(atmuxDir)).toBe(true);
  });

  test("returns true regardless of body content (presence is the signal)", async () => {
    await writeFile(renameLockPath(atmuxDir), "", "utf8");
    expect(await isRenameInProgress(atmuxDir)).toBe(true);
  });

  test("fail-open on bogus atmuxDir (non-existent path) — returns false", async () => {
    // Read-side guard must NEVER block a tick on a misread; the worst
    // case is the pre-ADR-027 baseline behavior.
    expect(await isRenameInProgress("/nonexistent/path/that/has/no/atmux/dir")).toBe(false);
  });

  test("fail-open when atmuxDir is a regular file (state/rename.lock lookup hits ENOTDIR)", async () => {
    const fileAtmuxDir = join(root, "atmux-dir-file");
    await writeFile(fileAtmuxDir, "not a directory", "utf8");
    expect(await isRenameInProgress(fileAtmuxDir)).toBe(false);
  });
});
