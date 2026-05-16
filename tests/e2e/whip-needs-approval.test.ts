// E2E walk for ADR-085 §Three surfaces #2 — whip's §2.5 needs-approval
// scan. Runs the public `whip` verb end-to-end with all three
// approval-debt buckets seeded; asserts the Discord ping + lead-events
// JSONL emission per CLAUDE.md testing discipline §"Pair runbook beats
// with rehearsal spec steps."
//
// **Stateful 1x cold-start+walk e2e — sequenced beats consume the
// needs-approval state delta. Don't streak past beat 4; the JSONL is
// append-only and the re-fire policy in HC#4 is by-design. Matches the
// budget-pause.test.ts shape (also walks the whip surface via WhipOpts
// injection — no live tmux, no live Discord, no flaky network).**
//
// Beat ↔ AC mapping (t-3516d73a):
//   1. Cron-fired 5min tick on a team with 1 proposed ADR + 1 stale
//      inbox heading + 1 blocked task → exactly 1 Discord ping with the
//      `whip-needs-approval` template.
//   2. Same fixture → lead-events JSONL has 1 row with
//      `kind: "needs-approval-snapshot"` and `report.total === 3`.
//   3. Re-run tick: still 1 ping (per tick — live-not-cached re-fire
//      is by design per ADR-068 §HC#4; ADR-085 doesn't cache).
//
// Mocking:
//   - `discordSend` injected to capture template firings.
//   - tmux session UP via `buildFakeTmux` (whip's per-member checks
//     pass cleanly so the run reaches §2.5).
//   - ATMUX_DIR / ATMUX_TEAM_DIR pinned in `env` so `scanNeedsApproval`
//     resolves to our per-test fixture, not the operator's real repo.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscordSendOpts } from "../../src/abstractions/discord.ts";
import type { TmuxNamespace } from "../../src/abstractions/tmux.ts";
import { poke as whip } from "../../src/verbs/poke.ts";

// ---------- Fixture builders ----------

/** Minimal TmuxNamespace stub matching the surface used by whip's
 *  per-member checks. Mirrors tests/e2e/budget-pause.test.ts so the
 *  shape stays consistent across e2e specs in this lane. */
function buildFakeTmux(opts: { sessionUp: boolean; panes: Record<string, string> }): TmuxNamespace {
  const ns: Partial<TmuxNamespace> = {
    session: {
      hasSession: async () => opts.sessionUp,
      newSession: async () => {},
      killSession: async () => {},
      listSessions: async () => [],
      renameSession: async () => {},
      setEnvironment: async () => {},
    },
    window: {
      listWindows: async () =>
        Object.keys(opts.panes).map((name, i) => ({
          index: i,
          id: `@${i}`,
          name,
          active: false,
        })),
      newWindow: async () => ({ sessionName: "x", windowIndex: 0 }),
      killWindow: async () => {},
      renameWindow: async () => {},
      selectWindow: async () => {},
      moveWindow: async () => {},
    },
    pane: {
      displayMessage: async (o: { target: unknown; format: string }) => {
        const wn = String(o.target).split(":")[1] ?? "";
        return opts.panes[wn] ?? "";
      },
      listPanes: async (target: unknown) => {
        const wn = String(target).split(":")[1] ?? "";
        if (opts.panes[wn] === undefined) return [];
        return [{ index: 0, pid: 10000, title: "", width: 80, height: 24 }];
      },
      capturePane: async () => "",
      sendKeys: async () => {},
      killPane: async () => {},
      splitWindow: async () => ({ sessionName: "x", windowIndex: 0, paneIndex: 0 }),
    },
    buffer: {
      loadBuffer: async () => {},
      pasteBuffer: async () => {},
      deleteBuffer: async () => {},
    },
    client: {
      attachSession: async () => {},
      switchClient: async () => {},
      listClients: async () => [],
    },
    server: {
      hasServer: async () => true,
      killServer: async () => {},
    },
  };
  return ns as TmuxNamespace;
}

const TEAM_FIXTURE = {
  name: "demo",
  members: [
    {
      name: "alpha",
      role: "team-lead",
      tui: "claude",
      emoji: "🧭",
      claudeAccount: "ifca",
    },
  ],
  whip: {
    // Default needsApprovalEnabled=true via schema default; left implicit.
    intervalMins: 5,
    staleMin: 30,
    leadMaxMin: 60,
  },
};

/** Format an MYT `HH:MM` for an epoch-seconds offset from now. */
function mytHHMM(nowMs: number, agoMin: number): string {
  const ts = Math.floor(nowMs / 1000) - agoMin * 60;
  const d = new Date((ts + 8 * 3600) * 1000); // shift UTC → MYT
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

// ---------- Walk ----------

describe("e2e whip §2.5 needs-approval (ADR-085, t-3516d73a)", () => {
  let teamDir: string;
  let atmuxDir: string;
  let homeDir: string;
  let stdoutBuf: string;
  let stderrBuf: string;
  let discordSent: DiscordSendOpts[];

  const stdout = (s: string): void => {
    stdoutBuf += s;
  };
  const stderr = (s: string): void => {
    stderrBuf += s;
  };
  const discordSend = async (opts: DiscordSendOpts): Promise<void> => {
    discordSent.push(opts);
  };

  /** Single whip tick against the per-test fixture. `scanNeedsApproval`
   *  is called with no DI inside whip §2.5; it walks
   *  `getAtmuxDir()` which reads `process.env.ATMUX_DIR` directly.
   *  Mutating WhipOpts.env doesn't reach the lib (whip uses opts.env
   *  for its own config reads only), so we pin process.env around
   *  the whip call. Restore in `finally` to keep tests isolated. */
  async function tick(nowMs: number): Promise<number> {
    discordSent = [];
    stdoutBuf = "";
    stderrBuf = "";
    const priorAtmuxDir = process.env.ATMUX_DIR;
    const priorAtmuxTeamDir = process.env.ATMUX_TEAM_DIR;
    process.env.ATMUX_DIR = atmuxDir;
    process.env.ATMUX_TEAM_DIR = teamDir;
    try {
      return await whip(["--team-dir", teamDir], {
        stdout,
        stderr,
        now: () => nowMs,
        home: homeDir,
        env: process.env,
        tmux: buildFakeTmux({
          sessionUp: true,
          panes: { "🧭alpha": "claude" },
        }),
        discordSend,
      });
    } finally {
      if (priorAtmuxDir !== undefined) process.env.ATMUX_DIR = priorAtmuxDir;
      else delete process.env.ATMUX_DIR;
      if (priorAtmuxTeamDir !== undefined) process.env.ATMUX_TEAM_DIR = priorAtmuxTeamDir;
      else delete process.env.ATMUX_TEAM_DIR;
    }
  }

  beforeEach(async () => {
    teamDir = await mkdtemp(join(tmpdir(), "atmux-e2e-needs-approval-"));
    atmuxDir = join(teamDir, ".atmux");
    homeDir = await mkdtemp(join(tmpdir(), "atmux-e2e-needs-approval-home-"));
    await mkdir(atmuxDir, { recursive: true });
    await mkdir(join(atmuxDir, "state"), { recursive: true });
    await mkdir(join(atmuxDir, "logs"), { recursive: true });
    await writeFile(join(atmuxDir, "team.json"), JSON.stringify(TEAM_FIXTURE));

    // Pre-seed `state/whip-last-hash.txt` so the first tick isn't gated
    // on the bootstrap heuristic (some whip preflights skip work on
    // first-ever invocation). Empty file is enough — whip writes a
    // fresh hash mid-tick.
    await writeFile(join(atmuxDir, "state", "whip-last-hash.txt"), "");

    // ---------- Bucket A seed: 1 proposed ADR ----------
    const adrDir = join(teamDir, "docs", "adr");
    await mkdir(adrDir, { recursive: true });
    await writeFile(
      join(adrDir, "999-test-fixture.md"),
      "# Test fixture ADR\n\n**Status**: proposed\n",
    );
  });

  afterEach(async () => {
    await rm(teamDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  test("Beat 1 — single tick with all 3 buckets seeded → exactly 1 whip-needs-approval Discord ping", async () => {
    const nowMs = 1_700_000_000_000;

    // ---------- Bucket B seed: 1 stale untriaged inbox heading ----------
    // 45 min ago — past the 30-min ADR-085 threshold; no ✅/📤/⏳/❌
    // marker so it surfaces.
    await writeFile(
      join(atmuxDir, "driver-inbox.md"),
      `## ${mytHHMM(nowMs, 45)} MYT — fixture ask\nbody line one\n`,
    );

    // ---------- Bucket C seed: 1 blocked task >2h via kanban.json ----------
    // moveTask doesn't set claimedAt; writing kanban.json directly
    // keeps the JSON-fallback path live (state.db absent → JSON read).
    const aged = Math.floor(nowMs / 1000) - 3 * 3600; // 3h ago
    await writeFile(
      join(atmuxDir, "kanban.json"),
      JSON.stringify({
        tasks: [
          {
            id: "t-block01",
            subject: "fixture blocked task",
            body: "",
            status: "blocked",
            owner: null,
            deps: [],
            priority: null,
            lane: null,
            createdAt: aged,
            claimedAt: aged,
            completedAt: null,
          },
        ],
        epics: [],
        stories: [],
      }),
    );

    const exit = await tick(nowMs);
    expect(exit).toBe(0);

    // Exactly one `whip-needs-approval` ping fired this tick.
    const needsApprovalPings = discordSent.filter(
      (d) => d.template === "whip-needs-approval",
    );
    expect(needsApprovalPings.length).toBe(1);
    // Verdict line follows the ADR-085 grammar: "📋 3 items awaiting triage".
    expect(needsApprovalPings[0]?.verdict).toContain("3 items awaiting triage");
  });

  test("Beat 2 — lead-events JSONL contains 1 'needs-approval-snapshot' row with total=3", async () => {
    const nowMs = 1_700_000_000_000;
    // Same seeds as Beat 1.
    await writeFile(
      join(atmuxDir, "driver-inbox.md"),
      `## ${mytHHMM(nowMs, 45)} MYT — fixture ask\nbody line one\n`,
    );
    const aged = Math.floor(nowMs / 1000) - 3 * 3600;
    await writeFile(
      join(atmuxDir, "kanban.json"),
      JSON.stringify({
        tasks: [
          {
            id: "t-block02",
            subject: "fixture blocked task",
            body: "",
            status: "blocked",
            owner: null,
            deps: [],
            priority: null,
            lane: null,
            createdAt: aged,
            claimedAt: aged,
            completedAt: null,
          },
        ],
        epics: [],
        stories: [],
      }),
    );

    await tick(nowMs);

    const jsonlPath = join(atmuxDir, "logs", "lead-events.jsonl");
    const body = await readFile(jsonlPath, "utf8");
    const rows = body
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
    const snapshots = rows.filter(
      (r) => r.kind === "needs-approval-snapshot" || r.extra?.kind === "needs-approval-snapshot",
    );
    expect(snapshots.length).toBe(1);
    // The report payload nests under whichever envelope the lead-events
    // writer uses. Both shapes (top-level `report` and `extra.report`)
    // surface the same total — find whichever's present.
    const row = snapshots[0];
    const report = row.report ?? row.extra?.report;
    expect(report).toBeDefined();
    expect(report.total).toBe(3);
    expect(report.adr.length).toBe(1);
    expect(report.inbox.length).toBe(1);
    expect(report.kanban.length).toBe(1);
  });

  test("Beat 3 — re-run tick fires another ping (no de-dup; HC#4 live-not-cached)", async () => {
    const nowMs = 1_700_000_000_000;
    // Same fixture seed.
    await writeFile(
      join(atmuxDir, "driver-inbox.md"),
      `## ${mytHHMM(nowMs, 45)} MYT — fixture ask\nbody line one\n`,
    );
    const aged = Math.floor(nowMs / 1000) - 3 * 3600;
    await writeFile(
      join(atmuxDir, "kanban.json"),
      JSON.stringify({
        tasks: [
          {
            id: "t-block03",
            subject: "fixture blocked task",
            body: "",
            status: "blocked",
            owner: null,
            deps: [],
            priority: null,
            lane: null,
            createdAt: aged,
            claimedAt: aged,
            completedAt: null,
          },
        ],
        epics: [],
        stories: [],
      }),
    );

    // First tick → 1 ping.
    await tick(nowMs);
    // Capture first-tick count BEFORE the next tick (which resets the buf).
    // We assert below that the SECOND tick also fires a ping — the
    // known-gap that ADR-085 captures (no whip-side dedup yet).

    // Second tick — bump clock by 5min (cron interval). Same fixture.
    const exit2 = await tick(nowMs + 5 * 60 * 1000);
    expect(exit2).toBe(0);
    const second = discordSent.filter((d) => d.template === "whip-needs-approval");
    // Re-fire is by design — ADR-085 §Decision pin "live-not-cached per
    // ADR-068 §HC#4" + ADR-085 OQ2 "no de-dup yet — captured as known-
    // gap." If a future dedup ladder lands (e.g. ADR-086 §Phase 1.5 for
    // pulse), update this assertion to reflect the new contract.
    expect(second.length).toBe(1);
  });

  test("Beat 4 — empty fixture (total=0) skips the Discord ping entirely", async () => {
    // No driver-inbox stale entries, no blocked tasks. Only Bucket A's
    // 1 proposed ADR remains (seeded in beforeEach) so total=1. To
    // hit total=0 we'd need to delete that too — but the ADR-085
    // policy is "skip ping only when total===0", and 1 still surfaces.
    // Drop the ADR fixture for this beat.
    await rm(join(teamDir, "docs", "adr", "999-test-fixture.md"));
    const nowMs = 1_700_000_000_000;
    await tick(nowMs);
    const pings = discordSent.filter((d) => d.template === "whip-needs-approval");
    expect(pings.length).toBe(0);
    // But the JSONL row still appends — observability stays on at zero
    // (so dashboards can spot the "fell silent" pattern per ADR-085
    // §Three surfaces #3 + whip.ts:986 inline comment).
    const jsonlPath = join(atmuxDir, "logs", "lead-events.jsonl");
    const body = await readFile(jsonlPath, "utf8");
    const rows = body
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
    const snapshots = rows.filter(
      (r) => r.kind === "needs-approval-snapshot" || r.extra?.kind === "needs-approval-snapshot",
    );
    expect(snapshots.length).toBe(1);
    const report = snapshots[0].report ?? snapshots[0].extra?.report;
    expect(report.total).toBe(0);
  });
});
