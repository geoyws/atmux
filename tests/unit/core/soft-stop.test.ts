// Unit tests for src/core/soft-stop.ts (ADR-087).
//
// Pure orchestration tests — no real tmux, no real fs writes outside
// a per-test temp dir. The tmux namespace is mocked via a thin recorder
// so we can verify per-pane notify behaviour without spawning processes.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SendTarget, TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import { addTask, claimTaskForMember } from "../../../src/core/kanban.ts";
import {
  DEFAULT_SOFT_STOP_GRACE_SECONDS,
  resumeManifestPath,
  SOFT_STOP_NOTICE,
  softStop,
} from "../../../src/core/soft-stop.ts";
import { ResumeManifest } from "../../../src/schema/resume.ts";
import type { Team } from "../../../src/schema/team.ts";

let atmuxDir: string;

beforeEach(async () => {
  atmuxDir = await mkdtemp(join(tmpdir(), "atmux-softstop-"));
});

afterEach(async () => {
  await rm(atmuxDir, { recursive: true, force: true });
});

// ---------- Helpers ----------

interface SentKey {
  target: SendTarget;
  keys: string;
  enter: boolean | undefined;
}

/** Recorder tmux: capture every sendKeys call, return success unless
 *  `failWindows` includes the target window name. */
function makeRecorderTmux(opts?: { failWindows?: ReadonlyArray<string> }): {
  tmux: TmuxNamespace;
  sent: SentKey[];
} {
  const sent: SentKey[] = [];
  const fails = new Set(opts?.failWindows ?? []);
  const sendKeys = async (call: { target: SendTarget; keys: string; enter?: boolean }) => {
    const win =
      typeof call.target.target === "string"
        ? call.target.target
        : `${call.target.target.sessionName}:${call.target.target.windowIndex}`;
    if ([...fails].some((f) => win.includes(f))) {
      throw new Error(`window ${win} not found`);
    }
    sent.push({ target: call.target, keys: call.keys, enter: call.enter });
  };
  // Build the minimal TmuxNamespace shape softStop needs — only
  // `pane.sendKeys` is touched. The cast is the same shape the verb
  // tests use for mocking; the unused namespace branches are typed-out
  // via `as unknown as TmuxNamespace` so the assertion stays narrow.
  const tmux = {
    pane: { sendKeys },
  } as unknown as TmuxNamespace;
  return { tmux, sent };
}

function makeTeam(overrides: Partial<Team> = {}): Team {
  return {
    name: "softstop-test",
    members: [
      { name: "lead", role: "team-lead", emoji: "🧭", tui: "claude" },
      { name: "w1", role: "member", emoji: "🐝", tui: "claude" },
      { name: "shell-only", role: "member", emoji: "🛠️", tui: "shell" },
    ],
    ...overrides,
  } as Team;
}

// ---------- softStop ----------

describe("softStop", () => {
  test("writes a v1 manifest with zero in-flight when kanban is empty", async () => {
    const { tmux } = makeRecorderTmux();
    const result = await softStop({
      team: makeTeam(),
      atmuxDir,
      sessionName: "atmux-softstop-test",
      tmux,
      reason: "soft-stop",
      clock: () => 1_778_700_000_000, // fixed epoch (ms)
      sleep: async () => {}, // no real grace
    });

    expect(result.manifestPath).toBe(resumeManifestPath(atmuxDir));
    expect(result.inFlightCount).toBe(0);
    expect(result.manifest.version).toBe(1);
    expect(result.manifest.ts).toBe(1_778_700_000); // seconds
    expect(result.manifest.team).toBe("softstop-test");
    expect(result.manifest.reason).toBe("soft-stop");
    expect(result.manifest.members).toHaveLength(3);
    for (const m of result.manifest.members) {
      expect(m.lastClaim).toBeNull();
      expect(m.claimedAt).toBeNull();
    }
  });

  test("captures in-flight tasks per owner in the manifest", async () => {
    // Seed kanban via the same `addTask` + `claimTaskForMember` path
    // production uses, so the manifest reflects the same shape a real
    // mid-claim member would produce.
    const taskId = await addTask(atmuxDir, { subject: "in flight" });
    await claimTaskForMember(atmuxDir, taskId, "w1");

    const { tmux } = makeRecorderTmux();
    const result = await softStop({
      team: makeTeam(),
      atmuxDir,
      sessionName: "atmux-softstop-test",
      tmux,
      reason: "soft-stop",
      clock: () => 1_778_700_000_000,
      sleep: async () => {},
    });

    expect(result.inFlightCount).toBe(1);
    const w1 = result.manifest.members.find((m) => m.name === "w1");
    expect(w1?.lastClaim).toBe(taskId);
    expect(w1?.claimedAt).toBeGreaterThan(0);
    expect(w1?.windowName).toBe("🐝w1");

    // Lead + shell-only have null lastClaim.
    expect(result.manifest.members.find((m) => m.name === "lead")?.lastClaim).toBeNull();
    expect(result.manifest.members.find((m) => m.name === "shell-only")?.lastClaim).toBeNull();
  });

  test("manifest on disk parses cleanly via the strict Zod schema", async () => {
    const { tmux } = makeRecorderTmux();
    await softStop({
      team: makeTeam(),
      atmuxDir,
      sessionName: "atmux-softstop-test",
      tmux,
      reason: "soft-stop",
      clock: () => 1_778_700_000_000,
      sleep: async () => {},
    });
    const raw = await readFile(resumeManifestPath(atmuxDir), "utf8");
    // Re-parse to confirm we wrote a schema-conforming JSON blob — a
    // .strict() schema catches any drift between writer + reader.
    const parsed = ResumeManifest.parse(JSON.parse(raw));
    expect(parsed.version).toBe(1);
    expect(parsed.members.map((m) => m.name)).toEqual(["lead", "w1", "shell-only"]);
  });

  test("sends soft-stop notice to TUI panes only — shell members skipped", async () => {
    const { tmux, sent } = makeRecorderTmux();
    await softStop({
      team: makeTeam(),
      atmuxDir,
      sessionName: "atmux-softstop-test",
      tmux,
      reason: "soft-stop",
      sleep: async () => {},
    });
    // 2 non-shell members — lead + w1. shell-only skipped.
    expect(sent).toHaveLength(2);
    for (const call of sent) {
      expect(call.keys).toBe(SOFT_STOP_NOTICE);
      // Notice is deliberately NOT submitted — enter must be false so
      // the line sits in the compose box.
      expect(call.enter).toBe(false);
    }
    // Lead pane uses the `kind: "lead"` discriminator; w1 is `member`.
    const kinds = sent.map((c) => c.target.kind);
    expect(kinds).toContain("lead");
    expect(kinds).toContain("member");
  });

  test("notify failures are best-effort — manifest still lands", async () => {
    const { tmux, sent } = makeRecorderTmux({ failWindows: ["lead"] });
    const result = await softStop({
      team: makeTeam(),
      atmuxDir,
      sessionName: "atmux-softstop-test",
      tmux,
      reason: "soft-stop",
      sleep: async () => {},
    });
    // Lead notify threw — 1 successful send (w1 only).
    expect(result.notifiedCount).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.target.kind).toBe("member");
    // Manifest still written despite the per-pane failure.
    await stat(result.manifestPath); // throws if absent
  });

  test("grace window defaults to DEFAULT_SOFT_STOP_GRACE_SECONDS * 1000ms", async () => {
    const { tmux } = makeRecorderTmux();
    const sleepCalls: number[] = [];
    await softStop({
      team: makeTeam(),
      atmuxDir,
      sessionName: "atmux-softstop-test",
      tmux,
      reason: "soft-stop",
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });
    expect(sleepCalls).toEqual([DEFAULT_SOFT_STOP_GRACE_SECONDS * 1000]);
  });

  test("team.softStopGraceSeconds overrides default; 0 skips sleep entirely", async () => {
    const { tmux } = makeRecorderTmux();
    const sleepCalls: number[] = [];

    await softStop({
      team: makeTeam({ softStopGraceSeconds: 10 } as Partial<Team>),
      atmuxDir,
      sessionName: "atmux-softstop-test",
      tmux,
      reason: "soft-stop",
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });
    expect(sleepCalls).toEqual([10_000]);

    // Reset + 0-grace path.
    sleepCalls.length = 0;
    await softStop({
      team: makeTeam({ softStopGraceSeconds: 0 } as Partial<Team>),
      atmuxDir,
      sessionName: "atmux-softstop-test",
      tmux,
      reason: "soft-stop",
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });
    expect(sleepCalls).toEqual([]);
  });

  test("reason='dissolve-epic' tags the manifest for ADR-090 callers", async () => {
    const { tmux } = makeRecorderTmux();
    const result = await softStop({
      team: makeTeam(),
      atmuxDir,
      sessionName: "atmux-softstop-test",
      tmux,
      reason: "dissolve-epic",
      sleep: async () => {},
    });
    expect(result.manifest.reason).toBe("dissolve-epic");
  });

  test("atomic write — partial-write recovery does not leave a half-file", async () => {
    // The atomicWrite helper writes to a temp + rename. After a clean
    // softStop call, no temp files should remain under state/.
    const { tmux } = makeRecorderTmux();
    await softStop({
      team: makeTeam(),
      atmuxDir,
      sessionName: "atmux-softstop-test",
      tmux,
      reason: "soft-stop",
      sleep: async () => {},
    });
    // List state/ and assert no .tmp.* siblings of resume.json.
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(join(atmuxDir, "state"));
    const stragglers = entries.filter((e) => e.startsWith("resume.json.tmp."));
    expect(stragglers).toHaveLength(0);
    expect(entries).toContain("resume.json");
  });
});
