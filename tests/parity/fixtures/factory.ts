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
export type FixturePreset = "minimal" | "lifecycle" | "multi-team";

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
