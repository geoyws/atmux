// E2E modal-cycling-detector walk (ADR-142 §D1-D5) — synthetic
// 3-modal-cycle scenario walked end-to-end through the public `whip`
// verb. Asserts the full trigger plumbing: history record → cycle-
// check → Discord template fire → clarifier dispatch (via DI seam) →
// flag-add (via DI seam) → dedup behaviour → productive-ceremony
// short-circuit → exempt-member opt-out → backward-compat defaults.
//
// **Stateful 1x cold-start+walk e2e** per CLAUDE.md testing-discipline
// — sequenced beats consume real on-disk modal-history state across
// ticks. Don't streak; don't run-of-N. Each scenario re-seeds its own
// throwaway tmpdir so the walks are independent at the test() level
// but stateful within a single test() body.
//
// Mocking shape:
//   - `discordSend`             — captures `[whip-modal-cycling]` fire
//   - `commitCountInWindow`     — controls productive-ceremony branch
//   - `dispatchModalCyclingClarifier` + `fileModalCyclingFlag` — record
//     the surface-action calls without shelling out to atmux / git
//   - `tmux` via `buildFakeTmux` — pane capture returns the per-beat
//     modal text injected into the test
//
// Beat ↔ scenario mapping (one scenario per test() per CLAUDE.md
// "pair runbook beats with rehearsal spec steps" rule — runbook
// matches `docs/RUNBOOK-stall-recovery.md ::[whip-modal-cycling]`):
//   1. Cycle trip — 3 distinct modals in window + 0 commits → fire
//   2. Dedup — second tick within dedupMin → no re-fire
//   3. Productive commits — same 3 modals + 1 commit → fire=false
//   4. Exempt member — modalCycling.exemptMembers honored
//   5. Backward-compat — no modalCycling block → defaults apply
//   6. Non-modal pane stays silent — narrative output → no history
//      append + no fire

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscordSendOpts } from "../../src/abstractions/discord.ts";
import type { TmuxNamespace } from "../../src/abstractions/tmux.ts";
import { whip } from "../../src/verbs/whip.ts";

// ---------- Fixture builders ----------

interface FakePane {
  paneCmd: string;
  state: string;
  pid: number;
}

function buildFakeTmux(opts: {
  sessionUp: boolean;
  panes: Record<string, FakePane>;
}): TmuxNamespace {
  const tmuxNs: Partial<TmuxNamespace> = {
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
        const p = opts.panes[wn];
        if (o.format.includes("pane_current_path")) return "";
        return p?.paneCmd ?? "";
      },
      listPanes: async (target: unknown) => {
        const wn = String(target).split(":")[1] ?? "";
        const p = opts.panes[wn];
        if (p === undefined) return [];
        return [{ index: 0, pid: p.pid, title: "", width: 80, height: 24 }];
      },
      capturePane: async (o: { target: unknown }) => {
        const wn = String(o.target).split(":")[1] ?? "";
        return opts.panes[wn]?.state ?? "";
      },
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
  return tmuxNs as TmuxNamespace;
}

// ---------- Modal fixtures ----------

const MODAL_A = `❯ 1. Force-push to origin?
  2. Pause and ask
  0. Dismiss`;

const MODAL_B = `❯ 1. Use --force-with-lease?
  2. Use --force?
  0. Cancel`;

const MODAL_C = `❯ 1. Retry from clean?
  2. Unclaim and let another member pick up?
  0. Pause for review`;

const NARRATIVE_PANE = `
Compiling 47 files…
Tests: 12 passed, 0 failed
Coverage: 87%

⏵⏵ auto mode on · tok 67k/100
`;

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function seededEntry(member: string, modalText: string, detectedAt: number): {
  member: string;
  paneTextHash: string;
  detectedAt: number;
  modalText: string;
  modalClass: string;
} {
  return {
    member,
    paneTextHash: hashOf(modalText),
    detectedAt,
    modalText,
    modalClass: "choice-prompt",
  };
}

async function seedTwoPriorEntries(
  atmuxDirPath: string,
  member: string,
  anchorSec: number,
): Promise<void> {
  await mkdir(join(atmuxDirPath, "state"), { recursive: true });
  const entries = [
    seededEntry(member, MODAL_A, anchorSec - 1200),
    seededEntry(member, MODAL_B, anchorSec - 600),
  ];
  await writeFile(
    join(atmuxDirPath, "state", `modal-history-${member}.json`),
    JSON.stringify(entries, null, 2),
    "utf8",
  );
}

async function seedTeam(
  atmuxDirPath: string,
  data: { name: string; members: unknown[]; modalCycling?: unknown },
): Promise<void> {
  await mkdir(atmuxDirPath, { recursive: true });
  await writeFile(join(atmuxDirPath, "team.json"), JSON.stringify(data, null, 2));
}

// ---------- Walk ----------

const NOW_SEC = 1_700_000_000;
const NOW_MS = NOW_SEC * 1000;
const FIVE_MIN_MS = 5 * 60 * 1000;

describe("e2e modal-cycling-detector walk (ADR-142 §D1-D5)", () => {
  let teamDir: string;
  let atmuxDir: string;
  let homeDir: string;
  let stdoutBuf: string;
  let stderrBuf: string;
  const stdout = (s: string): void => {
    stdoutBuf += s;
  };
  const stderr = (s: string): void => {
    stderrBuf += s;
  };

  beforeEach(async () => {
    teamDir = await mkdtemp(join(tmpdir(), "atmux-e2e-modalcycle-"));
    atmuxDir = join(teamDir, ".atmux");
    homeDir = await mkdtemp(join(tmpdir(), "atmux-e2e-modalcycle-home-"));
    stdoutBuf = "";
    stderrBuf = "";
  });

  afterEach(async () => {
    await rm(teamDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  test("Scenario 1 — cycle trip: 3 distinct modals in window + 0 commits → Discord + clarifier + flag fire", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [{ name: "alice", tui: "claude", emoji: "🐝" }],
      modalCycling: { enabled: true, cycleThreshold: 3, windowMin: 30 },
    });
    await seedTwoPriorEntries(atmuxDir, "alice", NOW_SEC);

    const sent: DiscordSendOpts[] = [];
    const clarifierCalls: Array<{ member: string; message: string }> = [];
    const flagCalls: Array<{ subject: string; body: string }> = [];

    await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => NOW_MS,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({
        sessionUp: true,
        panes: { "🐝alice": { paneCmd: "claude", state: MODAL_C, pid: 1234 } },
      }),
      discordSend: async (o) => {
        sent.push(o);
      },
      commitCountInWindow: async () => 0,
      dispatchModalCyclingClarifier: async (member, message) => {
        clarifierCalls.push({ member, message });
      },
      fileModalCyclingFlag: async (subject, body) => {
        flagCalls.push({ subject, body });
      },
    });

    // Discord template fired with the right shape.
    const cycling = sent.find((s) => s.template === "whip-modal-cycling");
    expect(cycling).toBeDefined();
    expect(cycling?.verdict ?? "").toMatch(/Modal-cycling/);
    expect(cycling?.verdict ?? "").toMatch(/alice/);
    expect(cycling?.verdict ?? "").toMatch(/3 modal-classes/);

    // Clarifier + flag surfaces both fired.
    expect(clarifierCalls).toHaveLength(1);
    expect(clarifierCalls[0]?.member).toBe("alice");
    expect(clarifierCalls[0]?.message).toMatch(/modal-cycling detected/);
    expect(flagCalls).toHaveLength(1);
    expect(flagCalls[0]?.subject).toMatch(/modal-cycling detected on alice/);

    // History file now has 3 entries with 3 distinct hashes.
    const historyRaw = await readFile(
      join(atmuxDir, "state", "modal-history-alice.json"),
      "utf8",
    );
    const history = JSON.parse(historyRaw) as Array<{ paneTextHash: string }>;
    expect(history).toHaveLength(3);
    expect(new Set(history.map((e) => e.paneTextHash)).size).toBe(3);

    // Dedup state stamped at NOW_SEC.
    const dedupRaw = await readFile(
      join(atmuxDir, "state", "modal-cycling-dedup-state.json"),
      "utf8",
    );
    const dedup = JSON.parse(dedupRaw) as Record<string, number>;
    expect(dedup.alice).toBe(NOW_SEC);
  });

  test("Scenario 2 — dedup: second tick within dedupMin window does NOT re-fire surfaces", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [{ name: "alice", tui: "claude", emoji: "🐝" }],
      modalCycling: { enabled: true, cycleThreshold: 3, windowMin: 30, dedupMin: 30 },
    });
    await seedTwoPriorEntries(atmuxDir, "alice", NOW_SEC);

    const tmuxNs = buildFakeTmux({
      sessionUp: true,
      panes: { "🐝alice": { paneCmd: "claude", state: MODAL_C, pid: 1234 } },
    });

    const sent: DiscordSendOpts[] = [];
    const clarifierCalls: string[] = [];
    const flagCalls: string[] = [];
    const baseOpts = {
      stdout,
      stderr,
      home: homeDir,
      env: {},
      tmux: tmuxNs,
      discordSend: async (o: DiscordSendOpts) => {
        sent.push(o);
      },
      commitCountInWindow: async () => 0,
      dispatchModalCyclingClarifier: async (m: string) => {
        clarifierCalls.push(m);
      },
      fileModalCyclingFlag: async (s: string) => {
        flagCalls.push(s);
      },
    };

    // Tick 1 — fires.
    await whip(["--team-dir", teamDir], { ...baseOpts, now: () => NOW_MS });
    // Tick 2 — 5min later, still within 30min dedup window → no re-fire.
    await whip(["--team-dir", teamDir], { ...baseOpts, now: () => NOW_MS + FIVE_MIN_MS });

    expect(sent.filter((s) => s.template === "whip-modal-cycling")).toHaveLength(1);
    expect(clarifierCalls).toHaveLength(1);
    expect(flagCalls).toHaveLength(1);

    // History file STILL records the second tick's modal (we appended,
    // even though surface actions were dedup'd).
    const historyRaw = await readFile(
      join(atmuxDir, "state", "modal-history-alice.json"),
      "utf8",
    );
    const history = JSON.parse(historyRaw) as Array<unknown>;
    expect(history.length).toBeGreaterThanOrEqual(3);
  });

  test("Scenario 3 — productive ceremony: 3 modals + 1 commit in window → fire=false (no surfaces)", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [{ name: "alice", tui: "claude", emoji: "🐝" }],
      modalCycling: { enabled: true, cycleThreshold: 3, windowMin: 30 },
    });
    await seedTwoPriorEntries(atmuxDir, "alice", NOW_SEC);

    const sent: DiscordSendOpts[] = [];
    const clarifierCalls: string[] = [];

    await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => NOW_MS,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({
        sessionUp: true,
        panes: { "🐝alice": { paneCmd: "claude", state: MODAL_C, pid: 1234 } },
      }),
      discordSend: async (o) => {
        sent.push(o);
      },
      commitCountInWindow: async () => 1,
      dispatchModalCyclingClarifier: async (m) => {
        clarifierCalls.push(m);
      },
      fileModalCyclingFlag: async () => {},
    });

    expect(sent.filter((s) => s.template === "whip-modal-cycling")).toHaveLength(0);
    expect(clarifierCalls).toHaveLength(0);

    // History recording still happens — the 3rd modal lands on disk;
    // only the SURFACE action was suppressed.
    const historyRaw = await readFile(
      join(atmuxDir, "state", "modal-history-alice.json"),
      "utf8",
    );
    const history = JSON.parse(historyRaw) as Array<unknown>;
    expect(history).toHaveLength(3);
  });

  test("Scenario 4 — exempt member: modalCycling.exemptMembers honored (no detection)", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [{ name: "alice", tui: "claude", emoji: "🐝" }],
      modalCycling: { enabled: true, cycleThreshold: 3, exemptMembers: ["alice"] },
    });
    await seedTwoPriorEntries(atmuxDir, "alice", NOW_SEC);

    const sent: DiscordSendOpts[] = [];
    const clarifierCalls: string[] = [];

    await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => NOW_MS,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({
        sessionUp: true,
        panes: { "🐝alice": { paneCmd: "claude", state: MODAL_C, pid: 1234 } },
      }),
      discordSend: async (o) => {
        sent.push(o);
      },
      commitCountInWindow: async () => 0,
      dispatchModalCyclingClarifier: async (m) => {
        clarifierCalls.push(m);
      },
      fileModalCyclingFlag: async () => {},
    });

    expect(sent.filter((s) => s.template === "whip-modal-cycling")).toHaveLength(0);
    expect(clarifierCalls).toHaveLength(0);

    // History file is NOT updated for exempt members — the per-member
    // detector branch is short-circuited at the enabled+exempt gate.
    const historyRaw = await readFile(
      join(atmuxDir, "state", "modal-history-alice.json"),
      "utf8",
    );
    const history = JSON.parse(historyRaw) as Array<unknown>;
    expect(history).toHaveLength(2); // unchanged from seed
  });

  test("Scenario 5 — backward-compat: no modalCycling block → defaults apply (enabled=true)", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [{ name: "alice", tui: "claude", emoji: "🐝" }],
      // NOTE: no modalCycling block at all.
    });
    await seedTwoPriorEntries(atmuxDir, "alice", NOW_SEC);

    const sent: DiscordSendOpts[] = [];

    await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => NOW_MS,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({
        sessionUp: true,
        panes: { "🐝alice": { paneCmd: "claude", state: MODAL_C, pid: 1234 } },
      }),
      discordSend: async (o) => {
        sent.push(o);
      },
      commitCountInWindow: async () => 0,
      dispatchModalCyclingClarifier: async () => {},
      fileModalCyclingFlag: async () => {},
    });

    // Defaults: enabled=true, cycleThreshold=3, windowMin=30 → fires.
    const cycling = sent.find((s) => s.template === "whip-modal-cycling");
    expect(cycling).toBeDefined();
  });

  test("Scenario 6 — non-modal pane: narrative output → no history append + no fire", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [{ name: "alice", tui: "claude", emoji: "🐝" }],
      modalCycling: { enabled: true, cycleThreshold: 3 },
    });
    // Seed two prior entries so the threshold *would* be met IF a third
    // entry landed — proves the gate is on classifyPaneAsModal.
    await seedTwoPriorEntries(atmuxDir, "alice", NOW_SEC);

    const sent: DiscordSendOpts[] = [];

    await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => NOW_MS,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({
        sessionUp: true,
        panes: {
          "🐝alice": { paneCmd: "claude", state: NARRATIVE_PANE, pid: 1234 },
        },
      }),
      discordSend: async (o) => {
        sent.push(o);
      },
      commitCountInWindow: async () => 0,
      dispatchModalCyclingClarifier: async () => {},
      fileModalCyclingFlag: async () => {},
    });

    expect(sent.filter((s) => s.template === "whip-modal-cycling")).toHaveLength(0);

    // History unchanged — narrative pane never trips classifyPaneAsModal.
    const historyRaw = await readFile(
      join(atmuxDir, "state", "modal-history-alice.json"),
      "utf8",
    );
    const history = JSON.parse(historyRaw) as Array<unknown>;
    expect(history).toHaveLength(2);
  });
});
