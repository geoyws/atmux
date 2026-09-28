// e-cc3728bf T4 — rotation flow proof: observer → consumer → nudge,
// end to end through a real state.db in a scratch team dir. No tmux,
// no git, no kanban: snapshots ride injected fns (unit-covered seams),
// while sqlite, event validation, offset advance and message rendering
// are all real. The suggested verb string is parsed back through the
// real rotate arg parser to prove it names an executable command.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../src/abstractions/sqlite.ts";
import { migrations } from "../../src/abstractions/sqlite-migrations.ts";
import { consumeTeam } from "../../src/core/rotation-consumer.ts";
import { DEFAULT_ROTATION_THRESHOLDS, observeTeam } from "../../src/core/rotation-observer.ts";
import { parseRotateArgs } from "../../src/verbs/rotate.ts";

const MIN = 60_000;
const NOW = 1_787_000_200_000;
const STUCK_TEXT = "✻ Baked for 22m 10s\nprior output\n❯\n";

describe("rotation flow (e-cc3728bf T4)", () => {
  let dir = "";
  let db: Database | null = null;
  const sent: string[] = [];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atmux-rotation-flow-"));
    const atmuxDir = join(dir, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
    await writeFile(join(atmuxDir, "team.json"), JSON.stringify({ name: "flow", members: [{ name: "m1", role: "member" }] }));
    db = openDatabase(join(atmuxDir, "state.db"), migrations);
    sent.length = 0;
  });
  afterEach(async () => {
    if (db !== null) closeDatabase(db);
    db = null;
    await rm(dir, { recursive: true, force: true });
  });

  test("stuck pane + stale claim → high suggestion → nudge names runnable rotate", async () => {
    const d = db as Database;
    const observed = await observeTeam("flow", DEFAULT_ROTATION_THRESHOLDS, {
      capturePanes: () => [{ member: "m1", text: STUCK_TEXT, lastActivityMs: NOW - 25 * MIN }],
      readActivity: () => ({ member: "m1", lastCommitMs: NOW - 31 * MIN, claims: [{ taskId: "t-9", claimedAtMs: NOW - 61 * MIN }] }),
      readLoad: () => ({ cpuPressure: 0.1, memPressure: 0.1 }),
      nowMs: () => NOW,
    }, d);
    expect(observed.stuck.map((s) => s.member)).toEqual(["m1"]);
    expect(observed.noProgress.map((n) => n.member)).toEqual(["m1"]);

    const consumed = await consumeTeam(d, "flow", {
      sendToLead: (_team, message) => { sent.push(message); },
      nowMs: () => NOW,
    });
    expect(consumed.suggestions).toHaveLength(1);
    expect(consumed.suggestions[0]?.confidence).toBe("high");
    expect(consumed.nudged).toBe(1);
    expect(sent).toHaveLength(1);

    // The nudge names an executable command: extract `atmux <args>`
    // from the suggested line and run it through the real parser.
    const line = (sent[0] ?? "").split("\n").find((l) => l.startsWith("suggested: ")) ?? "";
    const argv = line.replace(/^suggested: `atmux \w+ /, "").replace(/`$/, "").split(" ");
    const parsed = parseRotateArgs(argv);
    expect(parsed.member).toBe("m1");
    expect(parsed.reason).toBe("stuck-pane");
  });

  test("re-run over drained backlog stays silent (no double nudge)", async () => {
    const d = db as Database;
    const deps = {
      capturePanes: () => [{ member: "m1", text: STUCK_TEXT, lastActivityMs: NOW - 25 * MIN }],
      readActivity: () => ({ member: "m1", lastCommitMs: NOW - 31 * MIN, claims: [{ taskId: "t-9", claimedAtMs: NOW - 61 * MIN }] }),
      readLoad: () => ({ cpuPressure: 0.1, memPressure: 0.1 }),
      nowMs: () => NOW,
    };
    await observeTeam("flow", DEFAULT_ROTATION_THRESHOLDS, deps, d);
    await consumeTeam(d, "flow", { sendToLead: (t, m) => { sent.push(m); }, nowMs: () => NOW });
    expect(sent).toHaveLength(1);
    const again = await consumeTeam(d, "flow", { sendToLead: () => { throw new Error("double nudge"); }, nowMs: () => NOW });
    expect(again.suggestions).toHaveLength(0);
  });
});
