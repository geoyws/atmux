// E2E ADR-081 §D + t-74273200 → t-581ee81f: full cage-state taxonomy
// gate across the four shipped states (down / bootstrapping / active /
// wedged) with `atmux status` AND `atmux doctor` agreement assertions.
//
// **Stateful 1x cold-start+walk e2e — sequenced beats consume real
// tmux + a real `node` child-process per member (chosen because the
// production `defaultPaneChildIsClaude` probe accepts `node` as a
// Claude Code wrapper exec name, per `src/core/cage-state.ts:322`).
// Don't streak; don't run-of-N.** Per CLAUDE.md testing discipline
// §"Stateful e2e specs are not repeatable smokes."
//
// Why `node` as the claude stand-in: real `claude` would require the
// Anthropic API + an interactive TUI session per test, which is hostile
// to CI. The cage-state probe ladder asks one question — *"is there a
// process named claude/claude-*/node under the pane's shell PID?"* —
// and `node -e 'process.stdin.resume()'` answers yes deterministically.
// All other ladder steps (rate-limit text, tokens-moved regex,
// heartbeat staleness) are driven by `tmux send-keys` text + heartbeat
// file writes, no claude binary needed.
//
// Members in the team fixture (one per state, all `tui: "claude"` so
// `atmux status` runs the cage-state probe — we skip `atmux start` and
// manually wire the tmux session/windows because `start` would try to
// spawn the real claude TUI):
//
//   - down-mbr           bare shell, no node — ps probe sees no
//                        claude-like child → state="down".
//   - bootstrapping-mbr  pane shows welcome banner; node child alive,
//                        but tokens never moved → state="bootstrapping".
//                        Doctor row gated by STARVING_THRESHOLD_S (60s
//                        uptime); we exercise both branches:
//                          * statusVerb CLI assertion runs against the
//                            real ps-uptime probe.
//                          * checkMemberCageStates() direct-call asserts
//                            the row would fire by passing
//                            `starvingThresholdSec: 0`, bypassing the
//                            60s sleep needed at CLI level.
//   - active-mbr         pane shows "5k tokens" (matches TOKENS_MOVED_RE
//                        `/(?<![0-9])\d+k\s*(?:tokens|↓)|tokens\s*·\s*\d+%/i`)
//                        + node child → state="active". Doctor stays
//                        silent (no row).
//   - wedged-rl-mbr      pane shows "You've hit your limit" + node child
//                        → state="wedged" (rate-limit branch fires
//                        before tokens-moved check).
//   - wedged-hb-mbr      pane shows "5k tokens" (active path) + node
//                        child + a heartbeat file stamped >7200s in the
//                        past → state="wedged" (heartbeat-stale branch).
//                        Two wedged sub-causes exercised because doctor
//                        renders distinct detail text for each ("rate-
//                        limit / TUI hang" vs "no whip activity for Nmin
//                        (heartbeat stale)").
//
// All five members live in a single cold-start fixture, so the
// describe-block runs sequentially against the same tmux server. Each
// `test()` asserts ONE state-class against BOTH verbs at the same time;
// no inter-test pane mutation.
//
// Skip-gates (module-load time):
//   - HAS_TMUX  — tmux binary on PATH.
//   - HAS_NODE  — node binary on PATH (the claude-child stand-in).
//   - NOT_IN_CAGE — `process.env.TMUX` MUST be unset; running this
//                   inside an atmux cage's tmux server collides with
//                   the test's spawned server. Skip with hint when
//                   detected.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTmux, type TmuxNamespace } from "../../src/abstractions/tmux.ts";
import {
  probeCageState,
  STARVING_THRESHOLD_S,
  WEDGED_HEARTBEAT_STALE_SEC,
} from "../../src/core/cage-state.ts";
import { writeHeartbeat } from "../../src/core/heartbeat.ts";
import type { Team } from "../../src/schema/team.ts";
import { checkMemberCageStates, doctor as doctorVerb } from "../../src/verbs/doctor.ts";
import { status as statusVerb } from "../../src/verbs/status.ts";

// ---------- Env probes (module-load time) ----------

function probeBin(cmd: string[]): boolean {
  try {
    const proc = Bun.spawnSync({ cmd, stdout: "ignore", stderr: "ignore" });
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

const HAS_TMUX = probeBin(["tmux", "-V"]);
const HAS_NODE = probeBin(["node", "--version"]);
const NOT_IN_CAGE = Bun.env.TMUX === undefined || Bun.env.TMUX === "";

const SKIP_REASON: string = !HAS_TMUX
  ? "tmux binary missing"
  : !HAS_NODE
    ? "node binary missing"
    : !NOT_IN_CAGE
      ? "running inside a tmux server (export TMUX=''; or run via `unset TMUX && bun test ...`)"
      : "";

if (SKIP_REASON !== "") {
  // eslint-disable-next-line no-console
  console.warn(`[cage-state-transitions.e2e] SKIPPED — ${SKIP_REASON}`);
}

// Beat assertions wait on tmux + node startup; 30s headroom matches
// lifecycle.test.ts's setDefaultTimeout posture (we override to 60s
// because beforeAll spawns five panes + five node children).
setDefaultTimeout(60_000);

// ---------- shared fixture state ----------

let teamDir: string;
let atmuxDir: string;
let socketDir: string;
let socketPath: string;
let teamName: string;
let sessionName: string;
let tmux: TmuxNamespace;
let team: Team;
const priorEnv: Record<string, string | undefined> = {};

// Per-state members. Each member name is its emoji + bare name so the
// post-ADR-017 + ADR-136 window-name convention (`${emoji}${name}`)
// resolves cleanly.
const MEMBERS = [
  { name: "down-mbr", emoji: "💀" },
  { name: "bootstrap-mbr", emoji: "🌱" },
  { name: "active-mbr", emoji: "🟢" },
  { name: "wedged-rl-mbr", emoji: "🚫" },
  { name: "wedged-hb-mbr", emoji: "⏱" },
] as const;

const winFor = (memberName: string, emoji: string) => `${sessionName}:${emoji}${memberName}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  if (SKIP_REASON !== "") return;

  teamName = `cs${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  sessionName = `atmux-${teamName}`;

  teamDir = await mkdtemp(join(tmpdir(), "atmux-cagestate-"));
  atmuxDir = join(teamDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  await mkdir(join(atmuxDir, "heartbeats"), { recursive: true });
  await mkdir(join(atmuxDir, "state"), { recursive: true });
  await mkdir(join(atmuxDir, "inboxes"), { recursive: true });

  socketDir = `/tmp/atmux-${teamName}`;
  await mkdir(socketDir, { recursive: true });
  socketPath = join(socketDir, "sock");

  // `tui: "claude"` is the load-bearing field — status.ts:269 + doctor.ts
  // checkMemberCageStates only probe members whose tui is "claude" (the
  // cage taxonomy is claude-specific). The actual claude binary is never
  // launched here — we use `tui: "claude"` purely to enable the probe
  // chain, then manually spawn shell panes via the tmux abstraction +
  // run `node` inside them as the claude stand-in.
  const teamJson = {
    name: teamName,
    members: MEMBERS.map((m) => ({
      name: m.name,
      role: "member",
      emoji: m.emoji,
      tui: "claude",
      model: "default",
      cwd: teamDir,
    })),
    whip: { intervalMins: 15, staleMin: 30, leadMaxMin: 60 },
    report: { intervalMins: 30 },
  };
  await writeFile(join(atmuxDir, "team.json"), JSON.stringify(teamJson, null, 2));
  await writeFile(join(atmuxDir, "kanban.json"), '{"tasks":[],"epics":[],"stories":[]}');
  team = teamJson as Team;

  for (const k of ["ATMUX_DIR", "ATMUX_TEAM_DIR", "ATMUX_SESSION", "TMUX", "ATMUX_NO_CRON"]) {
    priorEnv[k] = process.env[k];
  }
  process.env.ATMUX_DIR = atmuxDir;
  process.env.ATMUX_TEAM_DIR = teamDir;
  process.env.ATMUX_NO_CRON = "1";
  delete process.env.ATMUX_SESSION;
  delete process.env.TMUX;

  tmux = createTmux({ socketPath });

  // Create the tmux session + per-member shell window. We skip
  // `atmux start` because it would try to spawn the real claude TUI;
  // bare-shell windows preserve the probe-friendly state (pane.pid =
  // shell pid; child processes attach via send-keys).
  const firstMember = MEMBERS[0];
  if (firstMember === undefined) throw new Error("MEMBERS empty");
  await tmux.session.newSession({
    name: sessionName,
    windowName: `${firstMember.emoji}${firstMember.name}`,
    detached: true,
  });
  for (let i = 1; i < MEMBERS.length; i += 1) {
    const m = MEMBERS[i];
    if (m === undefined) continue;
    await tmux.window.newWindow({
      sessionName,
      name: `${m.emoji}${m.name}`,
    });
  }
  // Shell startup grace before send-keys lands on a settled prompt.
  await sleep(800);

  // Per-state pane setup.
  //
  // For every non-down member, run an `echo <state-text>; node -e ...`
  // combo so the pane shows the classifier-relevant text AND has a
  // node child the probe will accept. The `process.stdin.resume()`
  // call keeps node in the foreground so it stays attached to the
  // shell as a child for the rest of the test.

  // (1) down-mbr — leave the pane as bare shell. ps probe will find no
  // claude/node/claude-* child → state=down.
  // (no-op)

  // (2) bootstrap-mbr — welcome banner + node, no tokens.
  await tmux.pane.sendKeys({
    target: {
      kind: "member",
      member: "bootstrap-mbr",
      team: teamName,
      target: winFor("bootstrap-mbr", "🌱"),
    },
    keys: "clear; echo 'Welcome to Claude. How can I help?'",
    enter: true,
  });
  await sleep(300);
  await tmux.pane.sendKeys({
    target: {
      kind: "member",
      member: "bootstrap-mbr",
      team: teamName,
      target: winFor("bootstrap-mbr", "🌱"),
    },
    keys: "node -e 'process.stdin.resume()'",
    enter: true,
  });

  // (3) active-mbr — tokens-moved text + node.
  await tmux.pane.sendKeys({
    target: {
      kind: "member",
      member: "active-mbr",
      team: teamName,
      target: winFor("active-mbr", "🟢"),
    },
    keys: "clear; echo '↑ 5k tokens · 12%'",
    enter: true,
  });
  await sleep(300);
  await tmux.pane.sendKeys({
    target: {
      kind: "member",
      member: "active-mbr",
      team: teamName,
      target: winFor("active-mbr", "🟢"),
    },
    keys: "node -e 'process.stdin.resume()'",
    enter: true,
  });

  // (4) wedged-rl-mbr — rate-limit banner + node. RATE-LIMIT pattern
  // fires step 4 in the probe ladder, BEFORE tokens-moved check.
  await tmux.pane.sendKeys({
    target: {
      kind: "member",
      member: "wedged-rl-mbr",
      team: teamName,
      target: winFor("wedged-rl-mbr", "🚫"),
    },
    keys: 'clear; echo "You\'ve hit your limit. Try again in 5h."',
    enter: true,
  });
  await sleep(300);
  await tmux.pane.sendKeys({
    target: {
      kind: "member",
      member: "wedged-rl-mbr",
      team: teamName,
      target: winFor("wedged-rl-mbr", "🚫"),
    },
    keys: "node -e 'process.stdin.resume()'",
    enter: true,
  });

  // (5) wedged-hb-mbr — tokens-moved text (so the active path is
  // reached) + node + a heartbeat file >7200s old.
  await tmux.pane.sendKeys({
    target: {
      kind: "member",
      member: "wedged-hb-mbr",
      team: teamName,
      target: winFor("wedged-hb-mbr", "⏱"),
    },
    keys: "clear; echo '↑ 8k tokens · 35%'",
    enter: true,
  });
  await sleep(300);
  await tmux.pane.sendKeys({
    target: {
      kind: "member",
      member: "wedged-hb-mbr",
      team: teamName,
      target: winFor("wedged-hb-mbr", "⏱"),
    },
    keys: "node -e 'process.stdin.resume()'",
    enter: true,
  });
  const staleEpoch = Math.floor(Date.now() / 1000) - (WEDGED_HEARTBEAT_STALE_SEC + 60);
  await writeHeartbeat(atmuxDir, "wedged-hb-mbr", staleEpoch);

  // Final grace — let every node child fully fork + every pane render
  // before the first probe.
  await sleep(1_500);
});

afterAll(async () => {
  if (SKIP_REASON !== "") return;
  try {
    await doctorVerb(["--quiet"]); // last-look smoke, swallows errors
  } catch {
    // best-effort
  }
  // Teardown via atmux stop --force per task body. Use the verb
  // directly so the cron-remove + archive paths exercise too.
  try {
    const { stop } = await import("../../src/verbs/stop.ts");
    await stop(["--force"]);
  } catch {
    // expected: session may already be gone if a beat went sideways.
  }
  try {
    await tmux.server.killServer();
  } catch {
    // expected.
  }
  for (const [k, v] of Object.entries(priorEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(teamDir, { recursive: true, force: true });
  await rm(socketDir, { recursive: true, force: true });
});

// ---------- Helpers ----------

interface StatusJson {
  members: {
    name: string;
    cageState: string | null;
  }[];
}

async function captureStdout<T>(fn: () => Promise<T>): Promise<{ result: T; stdout: string }> {
  let stdout = "";
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: unknown) => boolean }).write = (s) => {
    stdout += typeof s === "string" ? s : new TextDecoder().decode(s as Uint8Array);
    return true;
  };
  try {
    return { result: await fn(), stdout };
  } finally {
    (process.stdout as unknown as { write: typeof orig }).write = orig;
  }
}

async function readStatusJson(): Promise<StatusJson> {
  const { stdout } = await captureStdout(() => statusVerb(["--json"]));
  return JSON.parse(stdout.trim()) as StatusJson;
}

function findMember(json: StatusJson, name: string): { name: string; cageState: string | null } {
  const found = json.members.find((m) => m.name === name);
  if (found === undefined) throw new Error(`status JSON missing member ${name}`);
  return found;
}

async function readStatusText(): Promise<string> {
  const { stdout } = await captureStdout(() => statusVerb([]));
  return stdout;
}

async function readDoctorJson(): Promise<{
  rows: { label: string; status: string; detail?: string }[];
}> {
  const { stdout } = await captureStdout(() => doctorVerb(["--json"]));
  // doctor --json emits an array of rows; tolerate either shape.
  try {
    const parsed = JSON.parse(stdout.trim()) as unknown;
    if (Array.isArray(parsed)) {
      return { rows: parsed as { label: string; status: string; detail?: string }[] };
    }
    if (typeof parsed === "object" && parsed !== null && "rows" in parsed) {
      return parsed as { rows: { label: string; status: string; detail?: string }[] };
    }
  } catch {
    /* fallthrough */
  }
  return { rows: [] };
}

async function readDoctorText(): Promise<string> {
  // doctor's human-mode renders to STDERR (doctor.ts:2164 — only
  // --json mode routes to stdout). Capture both so the matchers can
  // run against the human-readable rows regardless of mode.
  let captured = "";
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: unknown) => boolean }).write = (s) => {
    captured += typeof s === "string" ? s : new TextDecoder().decode(s as Uint8Array);
    return true;
  };
  (process.stderr as unknown as { write: (s: unknown) => boolean }).write = (s) => {
    captured += typeof s === "string" ? s : new TextDecoder().decode(s as Uint8Array);
    return true;
  };
  try {
    await doctorVerb([]);
  } finally {
    (process.stdout as unknown as { write: typeof origOut }).write = origOut;
    (process.stderr as unknown as { write: typeof origErr }).write = origErr;
  }
  return captured;
}

// ---------- Beats ----------

describe.skipIf(SKIP_REASON !== "")(
  "cage-state transitions — all 4 states + status/doctor agreement (t-581ee81f)",
  () => {
    test("Beat 1 — down: pane without claude-like child → status='down' + doctor row 'pane down'", async () => {
      const json = await readStatusJson();
      const m = findMember(json, "down-mbr");
      expect(m.cageState).toBe("down");

      // Status text mode names the state in the per-member row.
      const text = await readStatusText();
      expect(text).toContain("down-mbr");
      expect(text).toContain("down");

      // Doctor at CLI level — verify the per-member down row fires
      // unconditionally (no uptime gate for `down`).
      const doctorText = await readDoctorText();
      expect(doctorText).toMatch(/member-cage-state:down-mbr/);
      expect(doctorText).toMatch(/pane down/i);

      // Direct-API call for shape parity — same row text via the
      // checkMemberCageStates helper that doctor wraps.
      const rows = await checkMemberCageStates(team, atmuxDir);
      const downRow = rows.find((r) => r.label === "member-cage-state:down-mbr");
      expect(downRow).toBeDefined();
      expect(downRow?.detail).toMatch(/pane down/i);
    });

    test("Beat 2 — bootstrapping: node child + welcome banner (no tokens) → status='bootstrapping' + doctor row (threshold-bypassed)", async () => {
      const json = await readStatusJson();
      const m = findMember(json, "bootstrap-mbr");
      expect(m.cageState).toBe("bootstrapping");

      // Status text mode names the state.
      const text = await readStatusText();
      expect(text).toContain("bootstrap-mbr");
      expect(text).toContain("bootstrapping");

      // Doctor at CLI level: with real ps-etimes uptime under
      // STARVING_THRESHOLD_S (60s), the row is intentionally silent —
      // doctor distinguishes transient bootstrap from starving via
      // the uptime gate. We verify the silent path here and
      // separately exercise the threshold-bypassed row via the
      // direct-API call below.
      const doctorText = await readDoctorText();
      // Either silent (uptime < 60s) OR row present with the
      // welcome-banner detail (test ran slowly). Both are valid for
      // the bootstrapping vocabulary.
      if (doctorText.includes("member-cage-state:bootstrap-mbr")) {
        expect(doctorText).toMatch(/welcome banner persistent/i);
      }

      // Direct-API: pass `starvingThresholdSec: 0` so the row fires
      // regardless of pane uptime. Asserts the row's detail vocabulary
      // matches what the CLI WOULD emit after a 60s sleep.
      const rows = await checkMemberCageStates(team, atmuxDir, { starvingThresholdSec: 0 });
      const row = rows.find((r) => r.label === "member-cage-state:bootstrap-mbr");
      expect(row).toBeDefined();
      expect(row?.detail).toMatch(/welcome banner persistent/i);
    });

    test("Beat 3 — active: node child + tokens-moved text → status='active' + doctor silent (no row)", async () => {
      const json = await readStatusJson();
      const m = findMember(json, "active-mbr");
      expect(m.cageState).toBe("active");

      // Status text mode names the state.
      const text = await readStatusText();
      expect(text).toContain("active-mbr");
      expect(text).toContain("active");

      // Doctor at CLI level: active panes emit NO row. We assert the
      // text body doesn't carry an `active-mbr` row label.
      const doctorText = await readDoctorText();
      expect(doctorText).not.toMatch(/member-cage-state:active-mbr/);

      // Direct-API: even with the threshold relaxed, active stays silent.
      const rows = await checkMemberCageStates(team, atmuxDir, { starvingThresholdSec: 0 });
      const row = rows.find((r) => r.label === "member-cage-state:active-mbr");
      expect(row).toBeUndefined();
    });

    test("Beat 4a — wedged via rate-limit: node child + 'You've hit your limit' → status='wedged' + doctor row names rate-limit cause", async () => {
      const json = await readStatusJson();
      const m = findMember(json, "wedged-rl-mbr");
      expect(m.cageState).toBe("wedged");

      const text = await readStatusText();
      expect(text).toContain("wedged-rl-mbr");
      expect(text).toContain("wedged");

      // Doctor at CLI level — wedged fires unconditionally.
      const doctorText = await readDoctorText();
      expect(doctorText).toMatch(/member-cage-state:wedged-rl-mbr/);
      // detail mentions rate-limit (vs heartbeat-stale below).
      expect(doctorText).toMatch(/rate-limit|hit your limit/i);

      // Direct-API parity.
      const rows = await checkMemberCageStates(team, atmuxDir);
      const row = rows.find((r) => r.label === "member-cage-state:wedged-rl-mbr");
      expect(row).toBeDefined();
      expect(row?.detail).toMatch(/wedged/i);
      expect(row?.detail).toMatch(/rate-limit/i);
    });

    test("Beat 4b — wedged via heartbeat-stale: tokens-moved + node + heartbeat > 2h old → status='wedged' + doctor row names heartbeat cause", async () => {
      const json = await readStatusJson();
      const m = findMember(json, "wedged-hb-mbr");
      expect(m.cageState).toBe("wedged");

      const text = await readStatusText();
      expect(text).toContain("wedged-hb-mbr");
      expect(text).toContain("wedged");

      const doctorText = await readDoctorText();
      expect(doctorText).toMatch(/member-cage-state:wedged-hb-mbr/);
      // detail mentions heartbeat / "no whip activity" (vs rate-limit).
      expect(doctorText).toMatch(/heartbeat stale|no whip activity/i);

      const rows = await checkMemberCageStates(team, atmuxDir);
      const row = rows.find((r) => r.label === "member-cage-state:wedged-hb-mbr");
      expect(row).toBeDefined();
      expect(row?.detail).toMatch(/wedged/i);
      expect(row?.detail).toMatch(/heartbeat stale|no whip activity/i);
    });

    test("Status + doctor agreement — every cage-state member resolves to the same state class on both verbs", async () => {
      // The task body's central assertion: for each tested member,
      // both verbs report the SAME state class. We capture the union
      // of status-side cageState + doctor-side detail text and
      // verify the vocabulary doesn't diverge.
      const statusJson = await readStatusJson();
      const doctorText = await readDoctorText();

      const stateToken: Record<string, RegExp> = {
        down: /pane down/i,
        bootstrapping: /welcome banner persistent/i,
        active: /^$/, // active = silent (no row)
        wedged: /wedged/i,
      };

      for (const m of MEMBERS) {
        const memberRow = statusJson.members.find((row) => row.name === m.name);
        if (memberRow === undefined) throw new Error(`status missing ${m.name}`);
        const state = memberRow.cageState;
        if (state === null) {
          throw new Error(`cageState null for ${m.name} — probe failed; check fixture spawn`);
        }
        const tokenRe = stateToken[state];
        if (tokenRe === undefined) {
          throw new Error(`unknown cage-state vocabulary: ${state} for ${m.name}`);
        }
        const doctorRowMatcher = new RegExp(`member-cage-state:${m.name}\\b`);
        const hasDoctorRow = doctorRowMatcher.test(doctorText);
        if (state === "active") {
          // Active panes MUST be silent in doctor.
          expect(hasDoctorRow).toBe(false);
          continue;
        }
        if (state === "bootstrapping") {
          // Bootstrapping at CLI level is uptime-gated; either silent
          // OR the row matches the welcome-banner vocabulary. Both
          // are agreement-preserving.
          if (hasDoctorRow) {
            expect(doctorText).toMatch(tokenRe);
          }
          continue;
        }
        // down + wedged — row MUST be present + detail MUST match the
        // vocabulary the status JSON labelled.
        expect(hasDoctorRow).toBe(true);
        expect(doctorText).toMatch(tokenRe);
      }
    });

    test("Pure-probe sanity — probeCageState() called directly returns the same state class for each member", async () => {
      // Belt-and-braces — confirms the production-path probe and the
      // status-verb-internal probe agree on the same fixture. If
      // these ever diverge, status's pane-text capture or its tmux
      // handle is the regression site.
      for (const m of MEMBERS) {
        const health = await probeCageState(
          team,
          { name: m.name, role: "member", emoji: m.emoji } as Team["members"][number],
          atmuxDir,
        );
        const expectedState =
          m.name === "down-mbr"
            ? "down"
            : m.name === "bootstrap-mbr"
              ? "bootstrapping"
              : m.name === "active-mbr"
                ? "active"
                : "wedged";
        expect(health.state).toBe(expectedState);
      }
      // STARVING_THRESHOLD_S sanity — the constant is the contract
      // between cage-state and doctor's row policy; assertion catches
      // accidental drift.
      expect(STARVING_THRESHOLD_S).toBe(60);
    });
  },
);
