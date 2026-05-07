// ADR-009 §3 + ADR-005 + ADR-026: Parity fixture factory.
//
// Each parity test starts from a fresh `.atmux/` directory. This factory
// builds presets and materialises them on disk under a fresh tmpdir.
//
// Phase 3 iter-1 implementation surface (per ADR-026):
//   - `minimal` preset: empty fixture (no `.atmux/`). Sufficient for
//     verbs that don't read state, like `version` and `not-a-verb`.
//   - `lifecycle` preset: 4-member team mirroring `tests/e2e/lifecycle.bats`
//     setup() (lead/reviewer/gitter/w1, all `tui:"shell"`,
//     `model:"default"`, emoji-pinned). Materialises team.json /
//     kanban.json / driver-inbox.md + inboxes/logs/state/archive dirs.
//   - `multi-team` preset still throws `not-implemented` — deferred to
//     iter-2 per ADR-026's deferred-row table (re-enables when CI
//     surfaces 4-prod-team divergence demand or a tenant-isolation verb
//     lands).
//
// Why Zod here when the production runtime already validates?
// Defence in depth at the FIXTURE AUTHORING boundary. Hand-written JSON
// drifts; a fixture that accidentally adds a key the runtime doesn't
// read produces a parity test that passes for the wrong reason. Parsing
// fixture inputs through the same schemas as runtime catches authoring
// errors at test-write time, not at parity-divergence time.
// CLAUDE.md "verify green from the right path".

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Team } from "../../../src/schema/team.ts";

/**
 * Fixture preset names. Mirrors `tests/parity/matrix.ts::FixturePreset`
 * — kept in sync there until ADR-005 publishes a single canonical type.
 */
export type FixturePreset =
  | "minimal"
  | "lifecycle"
  | "multi-team"
  | "cron-tasks"
  | "cron-tasks-decisions"
  | "cron-tasks-groom";

/**
 * Handle returned by `makeFixture`. The caller (a `bun:test` `beforeEach`
 * or a parity-runner) holds onto `path` for the duration of the test
 * and `await cleanup()`s in `afterEach` — even on test failure.
 */
export type FixtureHandle = {
  /** Absolute path to the fixture root (the dir that contains `.atmux/`). */
  path: string;
  /** Idempotent. Removes the fixture tmpdir. */
  cleanup: () => Promise<void>;
};

export type MakeFixtureOpts = {
  preset: FixturePreset;
};

/**
 * Allocate a fresh fixture root under `os.tmpdir()` and materialise the
 * preset's `.atmux/` shape (or no shape, for `minimal`). Returns a
 * handle with absolute `path` + `cleanup()`.
 *
 * The `minimal` preset is the only one wired in Phase 1. It exists for
 * verbs that don't read or write `.atmux/` state — `version`, `--help`,
 * `doctor` (read-only path) — where the cheapest correct fixture is
 * "no fixture at all". Both bash and TS atmux MUST tolerate a fresh
 * cwd with no `.atmux/` for these verbs (and the version verb's case
 * statement in `bin/atmux` exits BEFORE the `atmux::maybe_offer_wizard`
 * check, confirming this is a safe shape).
 */
export async function makeFixture(opts: MakeFixtureOpts): Promise<FixtureHandle> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `atmux-parity-${opts.preset}-`));

  switch (opts.preset) {
    case "minimal":
      // No `.atmux/` materialised. The `version` verb (and any other
      // state-free verb) runs against an empty cwd. Both sides must
      // agree this is a valid invocation context.
      break;

    case "lifecycle":
      await materializeLifecyclePreset(dir);
      break;

    case "cron-tasks":
      await materializeLifecyclePreset(dir);
      await materializeCronTasksLayer(dir);
      break;

    case "cron-tasks-decisions":
      await materializeLifecyclePreset(dir);
      await materializeCronTasksDecisionsLayer(dir);
      break;

    case "cron-tasks-groom":
      await materializeLifecyclePreset(dir);
      await materializeCronTasksGroomLayer(dir);
      break;

    case "multi-team":
      // Cleanup the tmpdir before throwing so we don't leak filesystem
      // state on the not-implemented path.
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        // expected: idempotent — best-effort cleanup on the throw path
      }
      throw new Error(
        `makeFixture: preset "multi-team" not yet implemented (deferred to iter-2 per ADR-026 — re-enables when CI surfaces 4-prod-team divergence demand)`,
      );
  }

  let cleaned = false;
  return {
    path: dir,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        // expected: idempotent — tmpdir may already be gone
      }
    },
  };
}

/**
 * Materialise the `lifecycle` preset under `<dir>/.atmux/`.
 *
 * Roster matches `tests/e2e/lifecycle.bats:13-18` 1:1 (lead /
 * reviewer / gitter / w1, all `tui:"shell"`, `model:"default"`).
 *
 * **Emoji is pinned per member** — start.ts auto-picks a role default
 * via `defaultEmojiForRole` (src/core/common.ts:376) when `member.emoji`
 * is unset, but downstream verbs (send / dispatch / tell-lead / stop)
 * read the *static* `member.emoji` field for window resolution. Without
 * persistence, start spawns `🐝w1` while send looks for `w1` — "can't
 * find window". Pin emoji here so spawn + send + capture all agree.
 * Same rationale as `tests/e2e/lifecycle.test.ts:98-103`.
 *
 * Zod-validated through `Team` (src/schema/team.ts) before write —
 * authoring-side defence in depth catches drift between this preset
 * and the runtime schema. If `Team` tightens (e.g. flips
 * `.passthrough()` → `.strict()` in Phase 6), this validator surfaces
 * the drift here, not via a divergent parity test that the operator
 * has to triage.
 *
 * `kanban.json` ships with the full top-level shape
 * `{tasks:[],epics:[],stories:[]}` per src/schema/kanban.ts:177-180 —
 * a bare `{tasks:[]}` trips Zod on the first kanban write through TS
 * atmux. Empty `driver-inbox.md` matches `lifecycle.bats:26`.
 */
async function materializeLifecyclePreset(dir: string): Promise<void> {
  const atmuxDir = path.join(dir, ".atmux");
  await fs.mkdir(atmuxDir, { recursive: true });
  await fs.mkdir(path.join(atmuxDir, "inboxes"), { recursive: true });
  await fs.mkdir(path.join(atmuxDir, "logs"), { recursive: true });
  await fs.mkdir(path.join(atmuxDir, "state"), { recursive: true });
  await fs.mkdir(path.join(atmuxDir, "archive"), { recursive: true });

  const teamJson = {
    name: "lifecycle",
    members: [
      { name: "lead", role: "team-lead", emoji: "🧭", tui: "shell", model: "default", cwd: dir },
      {
        name: "reviewer",
        role: "reviewer",
        emoji: "🔍",
        tui: "shell",
        model: "default",
        cwd: dir,
      },
      { name: "gitter", role: "gitter", emoji: "🌿", tui: "shell", model: "default", cwd: dir },
      { name: "w1", role: "member", emoji: "🐝", tui: "shell", model: "default", cwd: dir },
    ],
    whip: { intervalMins: 5, staleMin: 30, leadMaxMin: 60 },
    report: { intervalMins: 30 },
  };

  // Authoring-side validation. Throws ZodError on drift between this
  // preset shape and the runtime Team schema — the test author finds
  // out at fixture-write time, not via a parity divergence later.
  Team.parse(teamJson);

  await fs.writeFile(path.join(atmuxDir, "team.json"), JSON.stringify(teamJson, null, 2));
  await fs.writeFile(path.join(atmuxDir, "kanban.json"), '{"tasks":[],"epics":[],"stories":[]}\n');
  await fs.writeFile(path.join(atmuxDir, "driver-inbox.md"), "");
}

/**
 * Materialise the `cron-tasks` layer on top of `lifecycle`.
 *
 * Mixed-shape kanban (1 done + 1 in-progress + 1 blocked) + 1 driver-inbox
 * open ask. Exercises all 4 body sections of `report` (Shipped /
 * In-progress / Blocked / Open asks) in a single deterministic invocation.
 *
 * All timestamps are fixed literals so byte-equal post-mask is achievable
 * without per-invocation drift. Task IDs are fixed `t-cron0NNN` literals
 * (NOT random) — the mask vocabulary in matrix.ts already covers
 * `/t-[0-9a-f]{8}/` for runtime-generated ids; deterministic ids here let
 * `kanban.json` compare byte-equal without an extra mask.
 */
async function materializeCronTasksLayer(dir: string): Promise<void> {
  const atmuxDir = path.join(dir, ".atmux");
  const kanban = {
    tasks: [
      {
        id: "t-cron0001",
        subject: "shipped-task",
        status: "done",
        owner: "w1",
        createdAt: 1700000000,
        claimedAt: 1700000100,
        completedAt: 1700000200,
        note: "fix(cron): seed shipped task",
      },
      {
        id: "t-cron0002",
        subject: "in-progress-task",
        status: "in-progress",
        owner: "w1",
        createdAt: 1700000300,
        claimedAt: 1700000400,
      },
      {
        id: "t-cron0003",
        subject: "blocked-task",
        status: "blocked",
        owner: "w1",
        createdAt: 1700000500,
        note: "blocked on upstream review",
      },
    ],
    epics: [],
    stories: [],
  };
  await fs.writeFile(
    path.join(atmuxDir, "kanban.json"),
    `${JSON.stringify(kanban, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(atmuxDir, "driver-inbox.md"),
    "# driver-inbox\n\n## Open\n- [10:00 MYT] **w1**: need clarification on cron-tasks scope\n\n## Archive\n",
  );
}

/**
 * Materialise the `cron-tasks-decisions` layer.
 *
 * Empty `decisions.md` (canonical bash header) + `state/decisions-digest-cursor`
 * at epoch 0 (so any added decision counts as "new since cursor"). Per-row
 * `preState` overrides supply the actual decisions.md content for each
 * scenario (empty / 1-entry / over-threshold).
 *
 * Bash side: `lib/decisions.sh:_decisions_file()` writes/reads
 * `.atmux/decisions.md` directly; cursor lives at
 * `.atmux/state/decisions-digest-cursor` per `_atmux_decisions_digest`.
 */
async function materializeCronTasksDecisionsLayer(dir: string): Promise<void> {
  const atmuxDir = path.join(dir, ".atmux");
  await fs.writeFile(
    path.join(atmuxDir, "decisions.md"),
    "# atmux decisions — append-only log\n\n",
  );
  await fs.writeFile(path.join(atmuxDir, "state", "decisions-digest-cursor"), "0\n");
}

/**
 * Materialise the `cron-tasks-groom` layer.
 *
 * Kanban with old done tasks (createdAt 1700000000 = 2023; well past
 * default --kanban-days 30) + driver-inbox + lead-outbox both with
 * populated `## Archive` tails (groom flushes these to dated archive
 * files) + several `kanban.json.bak.*` and `team.json.bak.*` rotation
 * files (groom culls past `--keep-bak` count, default 5).
 *
 * Per-row `preState` overrides supply specific scenario shapes (clean
 * kanban no-archive / orphaned-task / over-threshold archive tail).
 */
async function materializeCronTasksGroomLayer(dir: string): Promise<void> {
  const atmuxDir = path.join(dir, ".atmux");
  const oldKanban = {
    tasks: [
      {
        id: "t-old0001",
        subject: "ancient-shipped",
        status: "done",
        owner: "w1",
        createdAt: 1700000000,
        claimedAt: 1700000100,
        completedAt: 1700000200,
      },
      {
        id: "t-old0002",
        subject: "ancient-cancelled",
        status: "cancelled",
        owner: "w1",
        createdAt: 1700000300,
      },
    ],
    epics: [],
    stories: [],
  };
  await fs.writeFile(
    path.join(atmuxDir, "kanban.json"),
    `${JSON.stringify(oldKanban, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(atmuxDir, "driver-inbox.md"),
    "# driver-inbox\n\n## Open\n\n## Archive\n- [09:00 MYT] **w1**: ancient archived line 1\n- [09:01 MYT] **w1**: ancient archived line 2\n",
  );
  await fs.writeFile(
    path.join(atmuxDir, "lead-outbox.md"),
    "# lead-outbox\n\n## Open\n\n## Archive\n- [09:02 MYT] **lead**: ancient outbox line 1\n- [09:03 MYT] **lead**: ancient outbox line 2\n",
  );
  // 7 backup files (keep-bak default 5 → 2 culled per type)
  const oldEpoch = 1700000000;
  for (let i = 0; i < 7; i++) {
    await fs.writeFile(
      path.join(atmuxDir, `kanban.json.bak.${oldEpoch + i}`),
      '{"tasks":[],"epics":[],"stories":[]}\n',
    );
    await fs.writeFile(
      path.join(atmuxDir, `team.json.bak.${oldEpoch + i}`),
      '{"name":"old","members":[]}\n',
    );
  }
}
