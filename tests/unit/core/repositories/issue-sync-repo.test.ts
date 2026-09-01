// Unit tests for src/core/repositories/issue-sync-repo.ts (ADR-261
// §D4 ledger) + the v16→v17 migration shape it rides on.
//
// Exercises every repo method against a tmp-dir SQLite database wired
// up with the same migrations the production verb uses (harness
// pattern: complaints.test.ts / merger-state-repo.test.ts). Epoch
// seconds are caller-supplied throughout, so the §D4 matrix can be
// walked deterministically without sleeping the test runner. Includes
// the crash-window repair path (a `pending` row stranded by a kill is
// found at the next sync), the per-page cursor round-trip, and
// migration idempotency (re-opening the same DB with the full ladder
// is a no-op).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeDatabase,
  type Database,
  openDatabase,
  readUserVersion,
} from "../../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../../src/abstractions/sqlite-migrations.ts";
import {
  IssueSyncRepo,
  issueSyncFromRow,
  issueSyncToRow,
} from "../../../../src/core/repositories/issue-sync-repo.ts";
import { ISSUE_SYNC_FILING_STATES } from "../../../../src/schema/issue-sync.ts";

let scratch: string;
let dbPath: string;
let db: Database;
let repo: IssueSyncRepo;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atmux-issue-sync-repo-"));
  dbPath = join(scratch, "state.db");
  db = openDatabase(dbPath, migrations);
  repo = new IssueSyncRepo(db);
});

afterEach(async () => {
  closeDatabase(db);
  await rm(scratch, { recursive: true, force: true });
});

// ---------- Fixtures ----------

/** Canonical §D3 sourceId fixtures — one per frozen prefix. */
const GH_SOURCE = "github:geoyws/atmux#123";
const ADO_SOURCE = "ado:ifca/propertyx/42";

function ghPending(overrides: Partial<Parameters<IssueSyncRepo["upsertPending"]>[0]> = {}) {
  return repo.upsertPending({
    sourceId: GH_SOURCE,
    trackerId: "github",
    scope: "geoyws/atmux",
    targetTeam: "atmux",
    upstreamState: "open",
    upstreamUpdatedAtSec: 1_000,
    firstSeenSec: 1_000,
    lastSyncedSec: 1_000,
    extra: { url: "https://github.com/geoyws/atmux/issues/123", labels: ["bug"] },
    ...overrides,
  });
}

// ---------- Schema constants ----------

describe("ISSUE_SYNC_FILING_STATES", () => {
  test("matches the ADR-261 §D4 ledger-first vocabulary", () => {
    expect(ISSUE_SYNC_FILING_STATES).toEqual(["pending", "filed"]);
  });
});

// ---------- v16 → v17 migration shape ----------

describe("v16 → v17: issue_sync (ADR-261 §D4)", () => {
  test("issue_sync table exists with the expected column set + types + nullability", () => {
    const cols = db.prepare("PRAGMA table_info(issue_sync)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;
    const byName = new Map(cols.map((c) => [c.name, c]));

    const expected: ReadonlyArray<readonly [string, string]> = [
      ["source_id", "TEXT"],
      ["tracker_id", "TEXT"],
      ["scope", "TEXT"],
      ["complaint_id", "TEXT"],
      ["target_team", "TEXT"],
      ["upstream_state", "TEXT"],
      ["upstream_updated_at_sec", "INTEGER"],
      ["local_resolution", "TEXT"],
      ["filing_state", "TEXT"],
      ["first_seen_sec", "INTEGER"],
      ["last_synced_sec", "INTEGER"],
      ["extra", "TEXT"],
    ];
    for (const [name, type] of expected) {
      const c = byName.get(name);
      expect(c).toBeDefined();
      expect(c?.type).toBe(type);
    }
    expect(cols).toHaveLength(expected.length);

    // `source_id` is the PK (the canonical §D3 identity).
    expect(byName.get("source_id")?.pk).toBe(1);
    // Required columns NOT NULL; the cross-DB back-pointer + routing +
    // provenance + extra are nullable by design (§D4: complaint_id is
    // NULL through the pending crash window).
    for (const name of [
      "source_id",
      "tracker_id",
      "scope",
      "upstream_state",
      "upstream_updated_at_sec",
      "filing_state",
      "first_seen_sec",
      "last_synced_sec",
    ]) {
      expect(byName.get(name)?.notnull).toBe(1);
    }
    for (const name of ["complaint_id", "target_team", "local_resolution", "extra"]) {
      expect(byName.get(name)?.notnull).toBe(0);
    }
    // `filing_state` defaults to the §D4 crash-window-safe literal.
    expect(byName.get("filing_state")?.dflt_value).toBe("'pending'");
  });

  test("issue_sync indexes cover (tracker_id, scope) + filing_state", () => {
    const indexes = db.prepare("PRAGMA index_list(issue_sync)").all() as Array<{
      name: string;
    }>;
    const names = new Set(indexes.map((i) => i.name));
    expect(names.has("idx_issue_sync_tracker_scope")).toBe(true);
    expect(names.has("idx_issue_sync_filing_state")).toBe(true);

    const scopeCols = db.prepare("PRAGMA index_info(idx_issue_sync_tracker_scope)").all() as Array<{
      seqno: number;
      name: string;
    }>;
    expect(scopeCols.sort((a, b) => a.seqno - b.seqno).map((c) => c.name)).toEqual([
      "tracker_id",
      "scope",
    ]);
  });

  test("issue_sync_cursor table exists with composite PK (tracker_id, scope)", () => {
    const cols = db.prepare("PRAGMA table_info(issue_sync_cursor)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    const byName = new Map(cols.map((c) => [c.name, c]));

    const expected: ReadonlyArray<readonly [string, string]> = [
      ["tracker_id", "TEXT"],
      ["scope", "TEXT"],
      ["cursor", "TEXT"],
      ["updated_at_sec", "INTEGER"],
    ];
    for (const [name, type] of expected) {
      const c = byName.get(name);
      expect(c).toBeDefined();
      expect(c?.type).toBe(type);
    }
    expect(cols).toHaveLength(expected.length);

    // Composite PK ordering: tracker_id first, scope second.
    expect(byName.get("tracker_id")?.pk).toBe(1);
    expect(byName.get("scope")?.pk).toBe(2);
    // `cursor` nullable (NULL = exhausted / fresh walk); timestamp required.
    expect(byName.get("cursor")?.notnull).toBe(0);
    expect(byName.get("updated_at_sec")?.notnull).toBe(1);
  });

  test("source_id is the primary key (rejects duplicate)", () => {
    ghPending();
    expect(() =>
      db
        .prepare(
          `INSERT INTO issue_sync (
              source_id, tracker_id, scope, upstream_state,
              upstream_updated_at_sec, first_seen_sec, last_synced_sec
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(GH_SOURCE, "github", "geoyws/atmux", "open", 1, 1, 1),
    ).toThrow(/UNIQUE constraint failed|PRIMARY KEY/);
  });
});

describe("migration idempotency", () => {
  test("re-opening the same db with the full ladder is a no-op and preserves rows", () => {
    ghPending();
    repo.setCursor("github", "geoyws/atmux", "page-3", 1_500);
    closeDatabase(db);

    // Re-open the SAME file with the SAME ladder — every migration's
    // `from` is below user_version, so nothing re-runs and no
    // duplicate-table error throws.
    db = openDatabase(dbPath, migrations);
    repo = new IssueSyncRepo(db);
    expect(readUserVersion(db)).toBe(17);

    const survived = repo.getBySourceId(GH_SOURCE);
    expect(survived?.sourceId).toBe(GH_SOURCE);
    expect(survived?.filingState).toBe("pending");
    expect(repo.getCursor("github", "geoyws/atmux")?.cursor).toBe("page-3");
  });
});

// ---------- Row ↔ domain bridges ----------

describe("issueSyncFromRow / issueSyncToRow", () => {
  test("round-trips a fully-populated record", () => {
    const row = issueSyncToRow({
      sourceId: ADO_SOURCE,
      trackerId: "azure-devops",
      scope: "ifca/propertyx",
      complaintId: "c-12ab34cd",
      targetTeam: "propertyx",
      upstreamState: "closed",
      upstreamUpdatedAtSec: 2_000,
      localResolution: "tracker:azure-devops",
      filingState: "filed",
      firstSeenSec: 1_000,
      lastSyncedSec: 2_500,
      extra: { url: "https://dev.azure.com/ifca/propertyx/_workitems/edit/42" },
    });
    expect(row.source_id).toBe(ADO_SOURCE);
    expect(row.complaint_id).toBe("c-12ab34cd");
    expect(row.extra).toBe(
      JSON.stringify({ url: "https://dev.azure.com/ifca/propertyx/_workitems/edit/42" }),
    );

    const back = issueSyncFromRow(row);
    expect(back.sourceId).toBe(ADO_SOURCE);
    expect(back.trackerId).toBe("azure-devops");
    expect(back.scope).toBe("ifca/propertyx");
    expect(back.complaintId).toBe("c-12ab34cd");
    expect(back.targetTeam).toBe("propertyx");
    expect(back.upstreamState).toBe("closed");
    expect(back.upstreamUpdatedAtSec).toBe(2_000);
    expect(back.localResolution).toBe("tracker:azure-devops");
    expect(back.filingState).toBe("filed");
    expect(back.firstSeenSec).toBe(1_000);
    expect(back.lastSyncedSec).toBe(2_500);
    expect(back.extra).toEqual({
      url: "https://dev.azure.com/ifca/propertyx/_workitems/edit/42",
    });
  });

  test("empty extra serializes to NULL on disk and parses back to {}", () => {
    const row = issueSyncToRow({
      sourceId: GH_SOURCE,
      trackerId: "github",
      scope: "geoyws/atmux",
      complaintId: null,
      targetTeam: null,
      upstreamState: "open",
      upstreamUpdatedAtSec: 1,
      localResolution: null,
      filingState: "pending",
      firstSeenSec: 1,
      lastSyncedSec: 1,
      extra: {},
    });
    expect(row.extra).toBeNull();
    expect(row.complaint_id).toBeNull();
    expect(row.target_team).toBeNull();
    expect(row.local_resolution).toBeNull();

    const back = issueSyncFromRow(row);
    expect(back.extra).toEqual({});
    expect(back.complaintId).toBeNull();
    expect(back.targetTeam).toBeNull();
    expect(back.localResolution).toBeNull();
  });
});

// ---------- getBySourceId ----------

describe("getBySourceId", () => {
  test("returns null when the sourceId has never been seen", () => {
    expect(repo.getBySourceId("github:nobody/nothing#1")).toBeNull();
  });

  test("returns the persisted record after upsertPending", () => {
    ghPending();
    const rec = repo.getBySourceId(GH_SOURCE);
    expect(rec).not.toBeNull();
    expect(rec?.sourceId).toBe(GH_SOURCE);
    expect(rec?.trackerId).toBe("github");
    expect(rec?.scope).toBe("geoyws/atmux");
    expect(rec?.targetTeam).toBe("atmux");
    expect(rec?.upstreamState).toBe("open");
    expect(rec?.extra.labels).toEqual(["bug"]);
  });
});

// ---------- upsertPending (§D4 step 1) ----------

describe("upsertPending — fresh insert", () => {
  test("lands filing_state='pending' with NULL complaint_id + local_resolution", () => {
    const rec = ghPending();
    expect(rec.filingState).toBe("pending");
    expect(rec.complaintId).toBeNull();
    expect(rec.localResolution).toBeNull();
    expect(rec.firstSeenSec).toBe(1_000);
    expect(rec.lastSyncedSec).toBe(1_000);
  });

  test("targetTeam omitted defaults to NULL (polling team is the target)", () => {
    const rec = repo.upsertPending({
      sourceId: ADO_SOURCE,
      trackerId: "azure-devops",
      scope: "ifca/propertyx",
      upstreamState: "open",
      upstreamUpdatedAtSec: 50,
      firstSeenSec: 50,
      lastSyncedSec: 50,
    });
    expect(rec.targetTeam).toBeNull();
    expect(rec.extra).toEqual({});
  });
});

describe("upsertPending — conflict (existing sourceId)", () => {
  test("refreshes upstream fields + extra and resets filing_state to 'pending'", () => {
    ghPending();
    const ok = repo.markFiled(GH_SOURCE, "c-aa11bb22");
    expect(ok).toBe(true);

    // The §D4 reopen re-file arm comes back through upsertPending.
    const rec = ghPending({
      upstreamState: "open",
      upstreamUpdatedAtSec: 9_000,
      lastSyncedSec: 9_100,
      extra: { url: "https://github.com/geoyws/atmux/issues/123", labels: ["bug", "p0"] },
    });
    expect(rec.filingState).toBe("pending");
    expect(rec.upstreamUpdatedAtSec).toBe(9_000);
    expect(rec.lastSyncedSec).toBe(9_100);
    expect(rec.extra.labels).toEqual(["bug", "p0"]);
  });

  test("preserves first_seen_sec, complaint_id and local_resolution", () => {
    ghPending({ firstSeenSec: 1_000 });
    repo.markFiled(GH_SOURCE, "c-aa11bb22");
    repo.recordLocalResolution(GH_SOURCE, "tracker:github");

    // A later upsertPending (crash-repair retry / reopen re-file) must
    // NOT drop the back-pointer, the original sighting time, or the
    // provenance the reopen-symmetry matrix reads.
    const rec = ghPending({ firstSeenSec: 9_999, lastSyncedSec: 9_999 });
    expect(rec.firstSeenSec).toBe(1_000); // original sighting preserved
    expect(rec.complaintId).toBe("c-aa11bb22"); // back-pointer preserved
    expect(rec.localResolution).toBe("tracker:github"); // provenance preserved
    expect(rec.filingState).toBe("pending"); // re-file in flight again
  });

  test("does not duplicate rows — one row per sourceId after repeated upserts", () => {
    ghPending();
    ghPending();
    ghPending();
    const { n } = db
      .prepare("SELECT COUNT(*) AS n FROM issue_sync WHERE source_id = ?")
      .get(GH_SOURCE) as { n: number };
    expect(n).toBe(1);
  });
});

// ---------- markFiled (§D4 step 3) ----------

describe("markFiled", () => {
  test("flips to 'filed' and records the cross-DB complaint_id back-pointer", () => {
    ghPending();
    expect(repo.markFiled(GH_SOURCE, "c-deadbeef")).toBe(true);
    const rec = repo.getBySourceId(GH_SOURCE);
    expect(rec?.filingState).toBe("filed");
    expect(rec?.complaintId).toBe("c-deadbeef");
  });

  test("returns false when no row matches the sourceId", () => {
    expect(repo.markFiled("github:ghost/repo#1", "c-deadbeef")).toBe(false);
  });
});

// ---------- recordLocalResolution (§D4 reopen-symmetry provenance) ----------

describe("recordLocalResolution", () => {
  test("records tracker-mirror provenance ('tracker:<id>')", () => {
    ghPending();
    expect(repo.recordLocalResolution(GH_SOURCE, "tracker:github")).toBe(true);
    expect(repo.getBySourceId(GH_SOURCE)?.localResolution).toBe("tracker:github");
  });

  test("records lead-authored provenance ('lead') — the never-re-file arm", () => {
    ghPending();
    expect(repo.recordLocalResolution(GH_SOURCE, "lead")).toBe(true);
    expect(repo.getBySourceId(GH_SOURCE)?.localResolution).toBe("lead");
  });

  test("returns false when no row matches the sourceId", () => {
    expect(repo.recordLocalResolution("github:ghost/repo#1", "lead")).toBe(false);
  });
});

// ---------- updateUpstream ----------

describe("updateUpstream", () => {
  test("advances upstream_state + upstream_updated_at_sec + last_synced_sec only", () => {
    ghPending();
    repo.markFiled(GH_SOURCE, "c-deadbeef");

    // The §D4 auto-resolve arm: upstream closed.
    expect(repo.updateUpstream(GH_SOURCE, "closed", 5_000, 5_100)).toBe(true);
    const rec = repo.getBySourceId(GH_SOURCE);
    expect(rec?.upstreamState).toBe("closed");
    expect(rec?.upstreamUpdatedAtSec).toBe(5_000);
    expect(rec?.lastSyncedSec).toBe(5_100);
    // Untouched fields survive.
    expect(rec?.filingState).toBe("filed");
    expect(rec?.complaintId).toBe("c-deadbeef");
    expect(rec?.firstSeenSec).toBe(1_000);
  });

  test("the §D4 no-op arm advances last_synced_sec with unchanged state", () => {
    ghPending();
    expect(repo.updateUpstream(GH_SOURCE, "open", 1_000, 7_777)).toBe(true);
    const rec = repo.getBySourceId(GH_SOURCE);
    expect(rec?.upstreamState).toBe("open");
    expect(rec?.lastSyncedSec).toBe(7_777);
  });

  test("returns false when no row matches the sourceId", () => {
    expect(repo.updateUpstream("github:ghost/repo#1", "open", 1, 1)).toBe(false);
  });
});

// ---------- listPending (crash-window repair scan, §D4) ----------

describe("listPending", () => {
  test("a kill between ledger-write and markFiled strands a 'pending' row the next sync finds", () => {
    // Sync run 1: step 1 lands the ledger row...
    ghPending();
    // ...and the tick is killed before fileDedupedComplaint /
    // markFiled ever run (the 900s hard-kill). No markFiled call.

    // Sync run 2: the repair scan surfaces the stranded row.
    const pending = repo.listPending("github", "geoyws/atmux");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.sourceId).toBe(GH_SOURCE);
    expect(pending[0]?.filingState).toBe("pending");
    expect(pending[0]?.complaintId).toBeNull();

    // Repair completes the file; the row leaves the pending set.
    repo.markFiled(GH_SOURCE, "c-repaired");
    expect(repo.listPending("github", "geoyws/atmux")).toHaveLength(0);
  });

  test("filters by tracker_id + scope — sibling scopes/trackers excluded", () => {
    ghPending();
    repo.upsertPending({
      sourceId: "github:geoyws/other#7",
      trackerId: "github",
      scope: "geoyws/other",
      upstreamState: "open",
      upstreamUpdatedAtSec: 10,
      firstSeenSec: 10,
      lastSyncedSec: 10,
    });
    repo.upsertPending({
      sourceId: ADO_SOURCE,
      trackerId: "azure-devops",
      scope: "ifca/propertyx",
      upstreamState: "open",
      upstreamUpdatedAtSec: 10,
      firstSeenSec: 10,
      lastSyncedSec: 10,
    });

    const pending = repo.listPending("github", "geoyws/atmux");
    expect(pending.map((r) => r.sourceId)).toEqual([GH_SOURCE]);
  });

  test("excludes filed rows and orders oldest-first by first_seen_sec", () => {
    repo.upsertPending({
      sourceId: "github:geoyws/atmux#2",
      trackerId: "github",
      scope: "geoyws/atmux",
      upstreamState: "open",
      upstreamUpdatedAtSec: 300,
      firstSeenSec: 300,
      lastSyncedSec: 300,
    });
    ghPending({ firstSeenSec: 100 }); // GH_SOURCE, older sighting
    repo.upsertPending({
      sourceId: "github:geoyws/atmux#3",
      trackerId: "github",
      scope: "geoyws/atmux",
      upstreamState: "open",
      upstreamUpdatedAtSec: 200,
      firstSeenSec: 200,
      lastSyncedSec: 200,
    });
    repo.markFiled("github:geoyws/atmux#3", "c-filed");

    const pending = repo.listPending("github", "geoyws/atmux");
    expect(pending.map((r) => r.sourceId)).toEqual([GH_SOURCE, "github:geoyws/atmux#2"]);
  });

  test("returns [] when nothing is pending", () => {
    expect(repo.listPending("github", "geoyws/atmux")).toEqual([]);
  });
});

// ---------- getCursor / setCursor (per-page checkpoint, §D4) ----------

describe("cursor round-trip", () => {
  test("getCursor returns null before any checkpoint", () => {
    expect(repo.getCursor("github", "geoyws/atmux")).toBeNull();
  });

  test("setCursor inserts, then getCursor round-trips the opaque token", () => {
    repo.setCursor("github", "geoyws/atmux", "opaque-page-2", 1_111);
    const cur = repo.getCursor("github", "geoyws/atmux");
    expect(cur?.trackerId).toBe("github");
    expect(cur?.scope).toBe("geoyws/atmux");
    expect(cur?.cursor).toBe("opaque-page-2");
    expect(cur?.updatedAtSec).toBe(1_111);
  });

  test("setCursor upserts — a later page checkpoint overwrites the earlier one", () => {
    // The killed-tick resume story: page 1 checkpointed, page 2
    // checkpointed, kill — the next sync resumes from page 2's token.
    repo.setCursor("github", "geoyws/atmux", "page-1", 1_000);
    repo.setCursor("github", "geoyws/atmux", "page-2", 1_060);
    const cur = repo.getCursor("github", "geoyws/atmux");
    expect(cur?.cursor).toBe("page-2");
    expect(cur?.updatedAtSec).toBe(1_060);

    const { n } = db
      .prepare("SELECT COUNT(*) AS n FROM issue_sync_cursor WHERE tracker_id = ? AND scope = ?")
      .get("github", "geoyws/atmux") as { n: number };
    expect(n).toBe(1);
  });

  test("setCursor null marks the listing exhausted and round-trips as null", () => {
    repo.setCursor("github", "geoyws/atmux", "page-9", 2_000);
    repo.setCursor("github", "geoyws/atmux", null, 2_100);
    const cur = repo.getCursor("github", "geoyws/atmux");
    expect(cur).not.toBeNull(); // row exists — distinct from never-checkpointed
    expect(cur?.cursor).toBeNull();
    expect(cur?.updatedAtSec).toBe(2_100);
  });

  test("(tracker_id, scope) pairs checkpoint independently", () => {
    repo.setCursor("github", "geoyws/atmux", "gh-tok", 1);
    repo.setCursor("github", "geoyws/other", "gh-other-tok", 2);
    repo.setCursor("azure-devops", "ifca/propertyx", "ado-tok", 3);

    expect(repo.getCursor("github", "geoyws/atmux")?.cursor).toBe("gh-tok");
    expect(repo.getCursor("github", "geoyws/other")?.cursor).toBe("gh-other-tok");
    expect(repo.getCursor("azure-devops", "ifca/propertyx")?.cursor).toBe("ado-tok");
  });
});
