/**
 * Smoke test for the parity fixture factory's `lifecycle` preset.
 *
 * The preset materialises a 4-member team's `.atmux/` shape used by
 * commit 4's state-mutating verb rows (per ADR-026). This test proves
 * the preset:
 *   1. Doesn't throw at materialisation time (Zod validation through
 *      `Team` schema passes — see `tests/parity/fixtures/factory.ts`'s
 *      authoring-side defence-in-depth rationale).
 *   2. Writes the canonical files at the canonical paths.
 *   3. Builds the 4 expected directory shapes (inboxes / logs / state /
 *      archive).
 *   4. Round-trips through cleanup() without leaking the tmpdir.
 *
 * The matrix rows in commit 4 will exercise the preset functionally
 * (running TS + bash atmux against it). This file is the *unit-level*
 * proof that the preset materialises correctly in isolation — drift
 * surfaces here, not via a parity divergence later (CLAUDE.md "verify
 * green from the right path").
 *
 * Pair: `tests/parity/fixtures/factory.ts` (preset implementation);
 *       `tests/e2e/lifecycle.test.ts:104-134` (sister roster shape);
 *       `docs/adr-bun/026-parity-matrix-iter-1-scope.md` (iter-1 scope);
 *       `src/schema/team.ts` (Team Zod schema the preset validates against).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type FixtureHandle, makeFixture } from "./factory.ts";

describe("parity fixture factory — lifecycle preset", () => {
  let fixture: FixtureHandle;

  beforeEach(async () => {
    fixture = await makeFixture({ preset: "lifecycle" });
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  test("materialises 4-member .atmux/ shape with Zod-validated team.json", async () => {
    const atmuxDir = path.join(fixture.path, ".atmux");

    // Directory structure — 4 dirs that lifecycle.bats:23 + the e2e
    // port (lifecycle.test.ts:85-88) both create.
    for (const sub of ["inboxes", "logs", "state", "archive"]) {
      const stat = await fs.stat(path.join(atmuxDir, sub));
      expect(stat.isDirectory()).toBe(true);
    }

    // team.json — 4 members, emoji-pinned, role-mapped.
    const teamRaw = await fs.readFile(path.join(atmuxDir, "team.json"), "utf8");
    const team = JSON.parse(teamRaw);
    expect(team.name).toBe("lifecycle");
    expect(team.members).toHaveLength(4);
    expect(team.members.map((m: { name: string }) => m.name)).toEqual([
      "lead",
      "reviewer",
      "gitter",
      "w1",
    ]);
    expect(team.members.map((m: { emoji: string }) => m.emoji)).toEqual(["🧭", "🔍", "🌿", "🐝"]);
    expect(team.members.every((m: { tui: string }) => m.tui === "shell")).toBe(true);

    // kanban.json — full top-level shape (bare {tasks:[]} trips Zod
    // per src/schema/kanban.ts:177-180; preset writes the full shape).
    const kanban = await fs.readFile(path.join(atmuxDir, "kanban.json"), "utf8");
    expect(JSON.parse(kanban)).toEqual({ tasks: [], epics: [], stories: [] });

    // driver-inbox.md — empty file present.
    const inbox = await fs.readFile(path.join(atmuxDir, "driver-inbox.md"), "utf8");
    expect(inbox).toBe("");
  });

  test("cleanup() removes the tmpdir; idempotent on repeat call", async () => {
    const dirPath = fixture.path;
    expect((await fs.stat(dirPath)).isDirectory()).toBe(true);

    await fixture.cleanup();
    await expect(fs.stat(dirPath)).rejects.toThrow();

    // Idempotent — second cleanup call is a no-op.
    await fixture.cleanup();
  });
});

describe("parity fixture factory — multi-team preset (still deferred per ADR-026)", () => {
  test("throws not-implemented with iter-2 deferral message", async () => {
    await expect(makeFixture({ preset: "multi-team" })).rejects.toThrow(/iter-2 per ADR-026/);
  });
});
