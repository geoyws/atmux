// EPIC e-be01fc89 T4 regression: no team-start path re-spawns sentinel
// from removed config keys.
//
// Phase A (T1-T3) deleted the sentinel src/ surface + dropped the
// schema fields (team.sentinel, team.sentinelOverrides,
// cockpit.sentinel, cockpit.defaultSentinel) + removed the cockpit-W3
// _sentinel window provisioning + the ADR-158 martinet→sentinel
// migration shim. This test guards against silent re-spawn from any
// of those vectors — an operator's old team.json / cockpit.json with
// legacy keys MUST be accepted (passthrough) but MUST NOT trigger
// any sentinel artifact creation.
//
// Probe surface (per lead's T4 brief):
//   1. team.json with legacy `sentinel` + `sentinelOverrides` keys
//      → parses (Team is `.passthrough()`); no sentinel cron line
//      emitted by renderCronLines.
//   2. cockpit.json with top-level legacy `sentinel` + `defaultSentinel`
//      + `martinet` keys → parses; loadCockpit drops them; no W3 entry
//      synthesized into the canonical sessions[] tree; reconcile passes
//      no `_sentinel` window to the cockpit tmux session.
//   3. No `~/.atmux/state/sentinel-state.json` file created.
//
// Scope: schema + emission + reconcile layers (the actual sandwich-
// marker / live-process probe is left to the operator's manual
// `atmux stop && atmux start` per ADR-202 §X). The assertions cover
// every code path through which a sentinel artifact could be re-born.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTmux, type TmuxNamespace } from "../../src/abstractions/tmux.ts";
import { loadCockpit } from "../../src/core/cockpit.ts";
import * as cronModule from "../../src/core/cron.ts";
import { Team } from "../../src/schema/team.ts";
import { reconcileCockpitSession } from "../../src/verbs/cockpit.ts";
import type { Logger } from "../../src/core/tui.ts";

setDefaultTimeout(20_000);

const SENTINEL_PATTERNS = [
  /atmux sentinel/i,
  /sentinel tick/i,
  /buildSentinelWindowCommand/,
  /autoStartSentinelLoop/,
];

const RUNTIME_SENTINEL_ARTIFACTS = ["sentinel-state.json", "sentinel-tick.log"];

let homeDir: string;
let atmuxDir: string;
let cockpitPath: string;
let socketDir: string;
let socketPath: string;
let sessionName: string;
let cockpitTmux: TmuxNamespace;
const priorEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  homeDir = await mkdtemp(join(tmpdir(), `atmux-no-sentinel-${stamp}-`));
  atmuxDir = join(homeDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  await mkdir(join(atmuxDir, "logs"), { recursive: true });
  await mkdir(join(atmuxDir, "state"), { recursive: true });

  // Private cockpit-tmux server on per-test socket so the reconcile
  // probe doesn't touch the real `atmux-cockpit` socket.
  sessionName = `atmux_cockpit_no_sentinel_${stamp}`;
  socketDir = `/tmp/atmux-no-sentinel-${stamp}`;
  await mkdir(socketDir, { recursive: true });
  socketPath = join(socketDir, "sock");
  cockpitTmux = createTmux({ socketPath });

  cockpitPath = join(atmuxDir, "cockpit.json");

  for (const k of ["ATMUX_DIR", "ATMUX_COCKPIT_CONFIG", "HOME"]) {
    priorEnv[k] = process.env[k];
  }
  process.env.ATMUX_DIR = atmuxDir;
  process.env.ATMUX_COCKPIT_CONFIG = cockpitPath;
});

afterAll(async () => {
  try {
    await cockpitTmux.server.killServer();
  } catch {
    // server may already be dead
  }
  for (const [k, v] of Object.entries(priorEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(homeDir, { recursive: true, force: true });
  await rm(socketDir, { recursive: true, force: true });
});

function makeLogger(): { logs: string[]; logger: Logger } {
  const logs: string[] = [];
  const sink = (msg: string): void => {
    logs.push(msg);
  };
  return {
    logs,
    logger: { log: sink, ok: sink, warn: sink, err: sink },
  };
}

describe("e2e: no-sentinel-respawn regression (EPIC e-be01fc89 T4)", () => {
  test("team.json with legacy sentinel keys → schema passthrough, no parse error", () => {
    const legacyTeam = {
      name: "regression-team",
      members: [{ name: "be-1", role: "member" }],
      // Removed-in-T1 keys — schema-side gone but Team is .passthrough()
      // so an operator's stale team.json shouldn't refuse-to-parse.
      sentinel: "claude",
      sentinelOverrides: { cadenceSec: 270, escalationConfidenceThreshold: 0.7 },
    };
    const parsed = Team.parse(legacyTeam);
    expect(parsed.name).toBe("regression-team");
    expect(parsed.members.length).toBe(1);
  });

  test("cron-line emission vector is retired (ADR-233) — no renderCronLines export", () => {
    // ADR-233 deleted the cron-source surface; `src/core/cron.ts` is a
    // no-op shim. The pre-ADR-233 regression guard asserted that
    // `renderCronLines` emitted ZERO sentinel cron lines. Post-retire
    // there is no cron-line renderer at all, so the sentinel-via-cron
    // re-spawn vector is structurally impossible. Assert the renderer
    // is gone (the honest successor to "emits zero sentinel lines").
    expect((cronModule as Record<string, unknown>).renderCronLines).toBeUndefined();
    expect((cronModule as Record<string, unknown>).renderCronBlock).toBeUndefined();
  });

  test("surviving cron shim (stripAtmuxBlock) emits no sentinel artifacts even with legacy keys", () => {
    // Operator's stale team.json carries removed keys via passthrough;
    // the only surviving cron surface is the strip-only no-op shim,
    // which returns its input body unchanged and never synthesizes any
    // sentinel cron line.
    const team = Team.parse({
      name: "regression-team",
      members: [{ name: "be-1", role: "member" }],
      sentinel: "cursor",
      sentinelOverrides: { cadenceSec: 60 },
    });
    expect(team.name).toBe("regression-team");
    const body = "# unrelated existing crontab line\n*/5 * * * * /usr/bin/true\n";
    const stripped = cronModule.stripAtmuxBlock(body, team.name);
    for (const p of SENTINEL_PATTERNS) {
      expect(stripped.split("\n").some((l: string) => p.test(l))).toBe(false);
    }
  });

  test("loadCockpit accepts legacy top-level sentinel/defaultSentinel/martinet keys without spawning W3", async () => {
    // Top-level keys removed in T1 + the martinet→sentinel migration
    // shim deleted. Cockpit schema is `.passthrough()` so an operator's
    // legacy cockpit.json still parses; the loader must NOT synthesize
    // any sentinel session.
    const legacyCockpit = {
      schemaVersion: 1,
      sessions: [
        { type: "team", name: "regression-team", root: homeDir, enabled: true },
      ],
      // EPIC e-be01fc89 removed-keys — kept in legacy operator configs.
      sentinel: { impl: "cursor", enabled: true },
      defaultSentinel: "claude",
      martinet: { impl: "claude", enabled: true },
    };
    await writeFile(cockpitPath, JSON.stringify(legacyCockpit, null, 2));

    const cockpit = await loadCockpit({ home: homeDir });

    // No `type: "sentinel"` entry should have been lifted into sessions[]
    // — the ADR-158 martinet→sentinel migration shim is gone AND the
    // sentinelBlock lift in migrateLegacyShape is gone. Legacy top-level
    // fields survive on the parsed shape via Cockpit.passthrough() as
    // inert data; what matters is the synthesizer no longer produces a
    // sessions[] sentinel entry that would be reconciled into a tmux
    // window.
    const sessionTypes = (cockpit.sessions ?? []).map((s) => s.type);
    expect(sessionTypes).not.toContain("sentinel");
  });

  test("reconcileCockpitSession provisions no _sentinel window even with legacy cockpit.json on disk", async () => {
    // Drive a real cockpit-tmux session reconcile and assert no W3
    // sentinel pane appears — exercises the full reconcile path that
    // would have spawned `_sentinel` pre-T1.
    const cockpit = await loadCockpit({ home: homeDir });
    const { logger } = makeLogger();
    await reconcileCockpitSession(
      cockpitTmux,
      sessionName,
      cockpit.teams,
      logger,
      {},
      cockpit.medic,
      true, // yes — skip the destructive-op gate (none planned anyway)
      {},
    );
    const windows = await cockpitTmux.window.listWindows(sessionName);
    const names = windows.map((w) => w.name);
    expect(names).not.toContain("_sentinel");
    expect(names).not.toContain("sentinel");
  });

  test("no sentinel state files materialize in atmuxDir/state after reconcile", async () => {
    for (const f of RUNTIME_SENTINEL_ARTIFACTS) {
      const p = join(atmuxDir, "state", f);
      let existed = false;
      try {
        await readFile(p);
        existed = true;
      } catch {
        // ENOENT = expected
      }
      expect(existed).toBe(false);
    }
  });
});
