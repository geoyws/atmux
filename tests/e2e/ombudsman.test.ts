// API-level integration ADR-147 T7 (t-bbc15985) — ombudsman lifecycle: complaint file →
// sentinel write → cron tick wakes pane → adjudication round-trip →
// release-notes day-file written → sentinel cleared.
//
// **Stateful 1x cold-start+walk API-level integration — Path A walks a sequenced 3-
// complaint adjudication chain against a fresh mkdtemp'd state.db +
// release-notes tree per fixture. Don't streak; don't run-of-N.** Per
// CLAUDE.md testing discipline §"Stateful e2e specs are not repeatable
// smokes." The cage tear-down is implicit — `afterEach` rm's the temp
// dir; no tmux cage is bootstrapped because the tick wake is verified
// via injected `sendKeys` + `capture` deps (the production wake path is
// the real `safeSendKeysWithVerify` → real tmux; the verb-side
// mock-injection keeps this API-level integration coverage off the
// user-terminal flow while still exercising the verb's tick→sendKeys →
// release-notes write chain without standing up a tmux server).
//
// ---------------------------------------------------------------
// Scope vs T1's unit coverage
// ---------------------------------------------------------------
//
// `tests/unit/verbs/ombudsman.test.ts` covers parser + each helper
// (sentinel R/W, formatEntryLine, spliceUnderSection,
// resolveDayFilePath, statusForAction, actionLabel) at the function
// level. This API-level integration tests the LAYER ABOVE — the `complaints file` →
// sentinel append → `ombudsman tick` wake → `ombudsman work` adjudicate
// → `complaints resolve` flip → release-notes day-file write chain
// driven by the verb entry points themselves, against a real
// state.db (migrations applied) + a real release-notes file tree on
// disk.
//
// ---------------------------------------------------------------
// Paths (per ADR-147 T7 task body)
// ---------------------------------------------------------------
//
//   Path A — happy adjudication:
//     A1. Cold-start synthetic team (ombudsman.enabled=true, ombudsman
//         member rostered).
//     A2. File 3 complaints via `atmux complaints file`. Sentinel grows
//         to 3 ids.
//     A3. `atmux ombudsman tick` — sentinel non-empty → mocked sendKeys
//         observed with `atmux ombudsman work` keystroke.
//     A4. Adjudicate: c1=epic (file epic Task first, then work --action
//         epic --related-task), c2=wontfix, c3=already-addressed.
//     A5. Verify: epic Task in kanban; complaint statuses
//         resolved/wontfix/resolved with notes + related-task; day-file
//         exists with skeleton + 3 entries under `## Complaints
//         adjudicated`; sentinel empty.
//
//   Path B — defer + retry next tick:
//     B1. File 1 complaint.
//     B2. Tick — wake observed.
//     B3. Adjudicate `defer` → complaint stays open, sentinel retains
//         id, day-file gets `**deferred**` entry.
//     B4. Tick again — wake observed AGAIN (sentinel still non-empty).
//
//   Path C — disabled team is no-op:
//     C1. team.ombudsman.enabled=false; file 3 complaints.
//     C2. Sentinel never written (file absent or empty).
//     C3. Tick — fast no-op exit 0; mocked sendKeys NEVER called.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../src/abstractions/sqlite.ts";
import { migrations } from "../../src/abstractions/sqlite-migrations.ts";
import { addTask, listTasks } from "../../src/core/kanban.ts";
import { isSentinelEmpty, readSentinel } from "../../src/core/ombudsman.ts";
import { ComplaintsRepo } from "../../src/core/repositories/complaints-repo.ts";
import { complaints } from "../../src/verbs/complaints.ts";
import { ombudsman, resolveDayFilePath } from "../../src/verbs/ombudsman.ts";

// ---------- Fixture ----------

interface Fixture {
  teamDir: string;
  atmuxDir: string;
  statePath: string;
}

interface FixtureOpts {
  /** Master switch. Default true (Path A/B). Path C overrides to false. */
  ombudsmanEnabled?: boolean;
}

async function makeFixture(opts: FixtureOpts = {}): Promise<Fixture> {
  const teamDir = await mkdtemp(join(tmpdir(), "atmux-ombudsman-e2e-"));
  const atmuxDir = join(teamDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });

  const ombudsmanEnabled = opts.ombudsmanEnabled ?? true;
  const team = {
    name: "ombudsman-e2e",
    members: [
      { name: "be-1", role: "member", lane: "be" },
      { name: "ombudsman", role: "ombudsman", emoji: "⚖️" },
    ],
    ombudsman: { enabled: ombudsmanEnabled },
  };
  await writeFile(join(atmuxDir, "team.json"), JSON.stringify(team, null, 2));

  const statePath = join(atmuxDir, "state.db");
  const db = openDatabase(statePath, migrations);
  closeDatabase(db);

  return { teamDir, atmuxDir, statePath };
}

// ---------- Mock send-keys recorder ----------

interface SendKeysCall {
  target: string;
  text: string;
}

interface MockTmuxRig {
  /** Pass to ombudsman deps. */
  sendKeys: (target: string, text: string) => Promise<void>;
  capture: (target: string) => Promise<string>;
  /** Recorded sendKeys calls (in order). */
  calls: SendKeysCall[];
}

function makeTmuxRig(): MockTmuxRig {
  const calls: SendKeysCall[] = [];
  return {
    calls,
    sendKeys: async (target, text) => {
      calls.push({ target, text });
    },
    // Return a "composer empty" capture — `composerEmpty()` regex is
    // `/❯\s*$/m`; the trailing `❯ ` line passes the verifier on the
    // first poll, keeping the verify loop fast (~250ms).
    capture: async (_target) => "some prior pane content\n❯ ",
  };
}

// ---------- Verb-call helpers ----------

async function fileComplaint(
  fix: Fixture,
  args: { summary: string; rootCause?: string; ask?: string },
): Promise<string> {
  const argv = ["file", "--team-dir", fix.teamDir, "--summary", args.summary];
  if (args.rootCause !== undefined) argv.push("--root-cause", args.rootCause);
  if (args.ask !== undefined) argv.push("--ask", args.ask);
  // `complaints file` writes the new id to stdout — capture it.
  let out = "";
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout.write as unknown as (s: string | Uint8Array) => boolean) = ((
    s: string | Uint8Array,
  ) => {
    out += typeof s === "string" ? s : new TextDecoder().decode(s);
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await complaints(argv);
    expect(code).toBe(0);
  } finally {
    process.stdout.write = orig;
  }
  const id = out.trim();
  expect(id).toMatch(/^c-[0-9a-f]{8}$/);
  return id;
}

function readComplaint(fix: Fixture, id: string) {
  const db = openDatabase(fix.statePath, migrations);
  try {
    return new ComplaintsRepo(db).getById(id);
  } finally {
    closeDatabase(db);
  }
}

// ---------- Lifecycle ----------

let fix: Fixture;

afterEach(async () => {
  if (fix !== undefined) {
    await rm(fix.teamDir, { recursive: true, force: true });
  }
});

// ---------- Path A: happy adjudication ----------

describe("API-level integration ombudsman — Path A happy adjudication (3-complaint walk)", () => {
  test("A1-A5: file 3 complaints → tick wakes → epic+wontfix+already-addressed → day-file with 3 entries → sentinel empty", async () => {
    // A1: cold-start fixture with ombudsman.enabled=true.
    fix = await makeFixture();

    // A2: file 3 complaints. Sentinel grows to 3.
    const c1 = await fileComplaint(fix, {
      summary: "auto-rotate non-compliant leads on dormancy",
      rootCause: "lead acceptance of dormancy = no commits but green status",
      ask: "supervisor-side rotation policy",
    });
    const c2 = await fileComplaint(fix, {
      summary: "duplicate of existing c-prior — same dormancy class",
      rootCause: "filed by medic before dedup landed",
    });
    const c3 = await fileComplaint(fix, {
      summary: "atmux status / doctor cage-state disagreement",
      rootCause: "pre-ADR-XXX cage-state taxonomy",
    });

    {
      const sentinel = await readSentinel(fix.atmuxDir);
      expect(sentinel.pending).toEqual([c1, c2, c3]);
    }

    // A3: tick — sentinel non-empty, mocked sendKeys observed.
    {
      const rig = makeTmuxRig();
      const code = await ombudsman(["tick", "--team-dir", fix.teamDir], {
        capture: rig.capture,
        sendKeys: rig.sendKeys,
      });
      expect(code).toBe(0);
      // Verified-send-keys may fire >1 attempt if the verifier fails on
      // the pre-capture; with our composer-empty rig the first attempt
      // succeeds, so exactly one sendKeys call lands.
      expect(rig.calls).toHaveLength(1);
      expect(rig.calls[0]?.text).toBe("atmux ombudsman work");
      // Window target is `<team.name>:<emoji>_<role>`. Production emits
      // a bare `team.name` session, not an `atmux-`-prefixed one.
      expect(rig.calls[0]?.target).toBe("ombudsman-e2e:⚖️_ombudsman");
    }

    // A4: adjudicate. c1 = epic (file the EPIC Task first, then work
    // --action epic --related-task <epic-id>); c2 = wontfix; c3 =
    // already-addressed.

    // c1 → epic
    const epicId = await addTask(fix.atmuxDir, {
      subject: "EPIC: auto-rotate non-compliant leads on dormancy",
      body: `Filed from complaint ${c1}. Captures fleet-wide rotation policy.`,
      lane: "be",
      priority: 2,
    } as never);
    {
      const code = await ombudsman(
        [
          "work",
          "--id",
          c1,
          "--action",
          "epic",
          "--related-task",
          epicId,
          "--team-dir",
          fix.teamDir,
        ],
        // repoRoot pinned to teamDir so day-file lands under
        // <teamDir>/docs/release-notes/<Y>/<M>/<Y-M-D>.md (we don't
        // need to seed a `.git` walk-up for this test).
        { repoRoot: fix.teamDir },
      );
      expect(code).toBe(0);
    }

    // c2 → wontfix
    {
      const code = await ombudsman(
        [
          "work",
          "--id",
          c2,
          "--action",
          "wontfix",
          "--note",
          "duplicate of c-prior — same dormancy class, fold into the c1 epic scope",
          "--team-dir",
          fix.teamDir,
        ],
        { repoRoot: fix.teamDir },
      );
      expect(code).toBe(0);
    }

    // c3 → already-addressed
    {
      const code = await ombudsman(
        [
          "work",
          "--id",
          c3,
          "--action",
          "already-addressed",
          "--note",
          "ADR-081 cage-state taxonomy shipped 2026-05-01; doctor + status now share enum",
          "--team-dir",
          fix.teamDir,
        ],
        { repoRoot: fix.teamDir },
      );
      expect(code).toBe(0);
    }

    // A5: assertions.

    // (a) epic Task is in kanban.
    {
      const tasks = await listTasks(fix.atmuxDir);
      const epic = tasks.find((t) => t.id === epicId);
      expect(epic).toBeDefined();
      expect(epic?.subject).toContain("EPIC: auto-rotate");
      expect(epic?.body ?? "").toContain(c1);
    }

    // (b) complaint statuses.
    {
      const r1 = readComplaint(fix, c1);
      expect(r1?.status).toBe("resolved");
      expect(r1?.relatedTaskId).toBe(epicId);
      expect(r1?.resolvedBy).toBe("ombudsman");

      const r2 = readComplaint(fix, c2);
      expect(r2?.status).toBe("wontfix");
      // Resolution note lands in `extra.resolution_note` per
      // ComplaintsRepo.resolve (note → extra mapping is the canonical
      // storage path; Complaint schema has no first-class `note` field).
      expect((r2?.extra?.resolution_note as string | undefined) ?? "").toContain(
        "duplicate of c-prior",
      );

      const r3 = readComplaint(fix, c3);
      expect(r3?.status).toBe("resolved");
      expect((r3?.extra?.resolution_note as string | undefined) ?? "").toContain(
        "ADR-081 cage-state taxonomy",
      );
    }

    // (c) day-file exists with skeleton + 3 entries.
    {
      const dayPath = resolveDayFilePath(fix.teamDir, Date.now());
      const body = await readFile(dayPath, "utf8");
      // Skeleton sections present (skeleton-create-on-miss preserves
      // every section so other agents — gitter, hygiene-tick — can
      // append their own).
      for (const section of [
        "## Shipped (kanban→done)",
        "## Merges (branch→trunk)",
        "## ADRs landed",
        "## Complaints adjudicated",
        "## Doctor regressions",
        "## Notes",
      ]) {
        expect(body).toContain(section);
      }
      // 3 entries under `## Complaints adjudicated`.
      const complaintsSection = body.split("## Complaints adjudicated")[1] ?? "";
      const entryRegex = /^- c-[0-9a-f]{8} → \*\*[^*]+\*\*/gm;
      const matches = complaintsSection.match(entryRegex) ?? [];
      expect(matches).toHaveLength(3);
      // Spot-check action labels per §D3 §formatEntryLine.
      expect(complaintsSection).toContain(`- ${c1} → **filed epic ${epicId}**`);
      expect(complaintsSection).toContain(`- ${c2} → **wontfix**`);
      expect(complaintsSection).toContain(`- ${c3} → **already addressed**`);
    }

    // (d) sentinel is empty (every adjudication except `defer` removes
    // its id; we walked epic + wontfix + already-addressed, all clear).
    {
      const sentinel = await readSentinel(fix.atmuxDir);
      expect(sentinel.pending).toEqual([]);
      expect(await isSentinelEmpty(fix.atmuxDir)).toBe(true);
    }
  });
});

// ---------- Path B: defer + retry next tick ----------

describe("API-level integration ombudsman — Path B defer + retry", () => {
  test("B1-B4: file 1 complaint → tick → defer → sentinel retains id → next tick wakes again", async () => {
    fix = await makeFixture();

    // B1: file 1 complaint.
    const c = await fileComplaint(fix, {
      summary: "needs operator input — affects shared infra config",
      rootCause: "ambiguous fix path; operator must pick branch policy",
    });
    {
      const sentinel = await readSentinel(fix.atmuxDir);
      expect(sentinel.pending).toEqual([c]);
    }

    // B2: tick #1 — wake observed.
    {
      const rig = makeTmuxRig();
      const code = await ombudsman(["tick", "--team-dir", fix.teamDir], {
        capture: rig.capture,
        sendKeys: rig.sendKeys,
      });
      expect(code).toBe(0);
      expect(rig.calls).toHaveLength(1);
      expect(rig.calls[0]?.text).toBe("atmux ombudsman work");
    }

    // B3: defer.
    {
      const code = await ombudsman(
        [
          "work",
          "--id",
          c,
          "--action",
          "defer",
          "--note",
          "needs operator branch-policy decision before adjudication",
          "--team-dir",
          fix.teamDir,
        ],
        { repoRoot: fix.teamDir },
      );
      expect(code).toBe(0);
    }

    // (a) complaint is still open (defer leaves status intact).
    {
      const r = readComplaint(fix, c);
      expect(r?.status).toBe("open");
    }

    // (b) sentinel still has the id (defer does NOT clear).
    {
      const sentinel = await readSentinel(fix.atmuxDir);
      expect(sentinel.pending).toEqual([c]);
    }

    // (c) day-file shows the deferred entry.
    {
      const dayPath = resolveDayFilePath(fix.teamDir, Date.now());
      const body = await readFile(dayPath, "utf8");
      expect(body).toContain(`- ${c} → **deferred**`);
    }

    // B4: tick #2 — sentinel still non-empty → wake fires AGAIN.
    {
      const rig = makeTmuxRig();
      const code = await ombudsman(["tick", "--team-dir", fix.teamDir], {
        capture: rig.capture,
        sendKeys: rig.sendKeys,
      });
      expect(code).toBe(0);
      expect(rig.calls).toHaveLength(1);
    }
  });
});

// ---------- Path C: disabled team is no-op ----------

describe("API-level integration ombudsman — Path C disabled team is no-op", () => {
  test("C1-C3: ombudsman.enabled=false → sentinel never written → tick is silent no-op (sendKeys never called)", async () => {
    // C1: cold-start with ombudsman.enabled=false (override).
    fix = await makeFixture({ ombudsmanEnabled: false });

    // File 3 complaints. Each succeeds at the DB layer; the sentinel
    // skip-gate (verbs/complaints.ts §"ADR-147 T2 skip-gate") suppresses
    // the sentinel write because team.ombudsman.enabled !== true.
    await fileComplaint(fix, { summary: "complaint 1", rootCause: "x" });
    await fileComplaint(fix, { summary: "complaint 2", rootCause: "y" });
    await fileComplaint(fix, { summary: "complaint 3", rootCause: "z" });

    // C2: sentinel was never written. `isSentinelEmpty` returns true
    // both for absent file (no first-write happened) and empty
    // `{ pending: [] }`.
    expect(await isSentinelEmpty(fix.atmuxDir)).toBe(true);

    // C3: tick is a fast no-op. `ombudsmanTick` short-circuits on the
    // sentinel-empty check BEFORE touching tmux deps; mocked sendKeys
    // is never called.
    const rig = makeTmuxRig();
    const code = await ombudsman(["tick", "--team-dir", fix.teamDir], {
      capture: rig.capture,
      sendKeys: rig.sendKeys,
    });
    expect(code).toBe(0);
    expect(rig.calls).toHaveLength(0);
  });
});
