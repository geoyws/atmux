// ADR-272 §Supplement — the THROWAWAY cage the voice e2e harness talks to.
//
// Split deliberately into a pure planner and a thin executor:
//   - {@link buildCagePlan} computes every path, every file body, and every
//     tmux command from the fixtures. No IO, so the unit suite can assert
//     the whole shape of the cage — including that nothing it plans lands
//     outside the temp root — without laying down a single file.
//   - {@link materializeCage} performs that plan through injected `writeFile`
//     / `mkdir` / tmux seams.
//
// The split is not tidiness: the isolation gate's guarantees are properties
// of the PLAN (roots under temp, per-team `tmuxTmpdir`, its own socket), and
// a property you can only observe after `mkdtemp` and a live tmux server is
// a property you will not test.
//
// Every team gets its OWN `tmuxTmpdir`, hence its own tmux socket. That is
// the entire isolation mechanism — see `isolation.ts`.

import { join } from "node:path";
import type { TmuxNamespace } from "../../../abstractions/tmux.ts";
import { sessionAnchorPath } from "../../common.ts";
import { TEAM_FIXTURES, type TeamFixture, teamName } from "./fixtures.ts";

/** Keeps a fixture pane alive after painting it, so tmux reports a live
 *  window with a stable `pane_current_command` that is neither `tmux` (the
 *  viewer command the sweep skips) nor a shell (which the classifier reads
 *  as corroboration that the agent TUI is gone). */
const HOLD_SECONDS = 100_000;

export interface PannedPane {
  /** tmux window name — equals the roster member (no emoji ⇒ they match). */
  windowName: string;
  member: string;
  /** File the fixture text is written to, then `cat`ed into the pane. */
  textPath: string;
  text: string;
  /** Command tmux runs in the window. */
  shellCommand: string;
}

export interface PlannedTeam {
  name: string;
  kind: "live" | "ghost";
  root: string;
  atmuxDir: string;
  teamJsonPath: string;
  teamJson: string;
  anchorPath: string;
  sessionName: string;
  tmuxTmpdir: string;
  /** Directory tmux's socket file lives in — must exist before `-S` is used. */
  socketDir: string;
  socketPath: string;
  /** Directory the pane fixture texts are written to. */
  textDir: string;
  panes: PannedPane[];
}

export interface CagePlan {
  tempRoot: string;
  home: string;
  cockpitPath: string;
  cockpitJson: string;
  teams: PlannedTeam[];
}

/** POSIX single-quote escape. Local rather than imported from
 *  `src/verbs/vox.ts` because core must not import from verbs. */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * Compute the whole cage from the fixtures. Pure.
 *
 * `uid` participates because the socket path tmux will create is
 * `<tmuxTmpdir>/tmux-<uid>/default` — the shape `resolveTeamSocket`
 * derives, so the planner and the resolver agree by construction.
 */
export function buildCagePlan(opts: {
  tempRoot: string;
  uid: number;
  fixtures?: ReadonlyArray<TeamFixture>;
}): CagePlan {
  const { tempRoot, uid } = opts;
  const fixtures = opts.fixtures ?? TEAM_FIXTURES;
  const home = join(tempRoot, "home");
  const cockpitPath = join(tempRoot, "cockpit.json");

  const teams: PlannedTeam[] = fixtures.map((fixture) => {
    const name = teamName(fixture);
    const root = join(tempRoot, "teams", name);
    const atmuxDir = join(root, ".atmux");
    const tmuxTmpdir = join(tempRoot, "sock", name);
    const socketDir = join(tmuxTmpdir, `tmux-${uid}`);
    const textDir = join(tempRoot, "panes", name);

    const panes: PannedPane[] = fixture.panes.map((pane) => {
      const textPath = join(textDir, `${pane.member}.txt`);
      return {
        windowName: pane.member,
        member: pane.member,
        textPath,
        text: pane.text,
        // `exec` replaces the shell so `pane_current_command` reads `sleep`
        // rather than `sh` — the classifier treats a bare shell as evidence
        // the agent TUI died, which would misclassify every fixture pane.
        shellCommand: `cat ${shellQuote(textPath)}; exec sleep ${HOLD_SECONDS}`,
      };
    });

    const teamJson = `${JSON.stringify(
      {
        name,
        description: "throwaway cage for the voice e2e harness — NOT a real team",
        tmuxTmpdir,
        members: fixture.panes.map((p) => ({ name: p.member, role: "member" })),
      },
      null,
      2,
    )}\n`;

    return {
      name,
      kind: fixture.kind,
      root,
      atmuxDir,
      teamJsonPath: join(atmuxDir, "team.json"),
      teamJson,
      anchorPath: sessionAnchorPath(atmuxDir),
      // Pinned explicitly rather than left to `resolveCageSessionName`'s
      // `atmux-<name>` default, so the harness and the sweep cannot
      // disagree about which session to look for.
      sessionName: `atmux-${name}`,
      tmuxTmpdir,
      socketDir,
      socketPath: join(socketDir, "default"),
      textDir,
      panes,
    };
  });

  const cockpitJson = `${JSON.stringify(
    {
      schemaVersion: 1,
      cockpitSession: "atx",
      sessions: teams.map((t) => ({ type: "team", name: t.name, root: t.root, enabled: true })),
    },
    null,
    2,
  )}\n`;

  return { tempRoot, home, cockpitPath, cockpitJson, teams };
}

/** Every filesystem path the plan will write. Used by the plan test to
 *  assert nothing escapes the temp root. */
export function plannedPaths(plan: CagePlan): string[] {
  const paths = [plan.home, plan.cockpitPath];
  for (const t of plan.teams) {
    paths.push(t.root, t.atmuxDir, t.teamJsonPath, t.anchorPath, t.tmuxTmpdir, t.socketDir);
    paths.push(t.textDir);
    paths.push(t.socketPath);
    for (const p of t.panes) paths.push(p.textPath);
  }
  return paths;
}

// ---------- Execution ----------

export interface CageIo {
  mkdir: (path: string) => Promise<void>;
  writeFile: (path: string, contents: string) => Promise<void>;
  /** Build a tmux namespace pinned to one socket path. */
  tmux: (socketPath: string) => TmuxNamespace;
  log?: (line: string) => void;
}

export interface MaterializedCage {
  plan: CagePlan;
  /** Wall-clock ms at which the last fixture pane was painted — the clock
   *  the residue staleness requirement is measured from. */
  paintedAtMs: number;
}

/**
 * Create the cage on disk and bring the live team's tmux session up.
 *
 * Ghost teams get their roster + cockpit entry and deliberately NO tmux
 * session: that absence is what produces the `dead` verdict.
 */
export async function materializeCage(
  plan: CagePlan,
  io: CageIo,
  now: () => number = () => Date.now(),
): Promise<MaterializedCage> {
  const log = io.log ?? ((): void => {});
  await io.mkdir(plan.home);

  for (const team of plan.teams) {
    await io.mkdir(team.atmuxDir);
    await io.mkdir(join(team.atmuxDir, "state"));
    await io.writeFile(team.teamJsonPath, team.teamJson);
    await io.writeFile(team.anchorPath, `${team.sessionName}\n`);
    await io.mkdir(team.socketDir);
    // The pane texts live outside the team root, so their directory needs
    // creating explicitly — writing into a missing directory is an ENOENT
    // that only shows up on a real filesystem.
    if (team.panes.length > 0) await io.mkdir(team.textDir);
    for (const pane of team.panes) await io.writeFile(pane.textPath, pane.text);
  }

  await io.writeFile(plan.cockpitPath, plan.cockpitJson);

  for (const team of plan.teams) {
    if (team.kind === "ghost") {
      log(`cage: ${team.name} — no tmux session on purpose (exercises the 'dead' verdict)`);
      continue;
    }
    const tmux = io.tmux(team.socketPath);
    const [first, ...rest] = team.panes;
    if (first === undefined) continue;
    await tmux.session.newSession({
      name: team.sessionName,
      detached: true,
      cwd: team.root,
      windowName: first.windowName,
      shellCommand: first.shellCommand,
    });
    for (const pane of rest) {
      await tmux.window.newWindow({
        sessionName: team.sessionName,
        name: pane.windowName,
        cwd: team.root,
        detached: true,
        shellCommand: pane.shellCommand,
      });
    }
    log(`cage: ${team.name} — ${team.panes.length} pane(s) up on ${team.socketPath}`);
  }

  return { plan, paintedAtMs: now() };
}

/**
 * Tear the cage down.
 *
 * Asserts WHICH socket it is killing before killing anything: a stray
 * session on a stray socket is untidy, but a kill aimed at the default
 * socket would be the exact accident this whole harness is built to make
 * impossible. `guard` receives each socket path and must throw to veto.
 */
export async function destroyCage(
  plan: CagePlan,
  io: Pick<CageIo, "tmux" | "log">,
  guard: (socketPath: string) => void,
): Promise<void> {
  const log = io.log ?? ((): void => {});
  for (const team of plan.teams) {
    if (team.kind === "ghost") continue;
    guard(team.socketPath);
    const tmux = io.tmux(team.socketPath);
    try {
      if (await tmux.session.hasSession(team.sessionName)) {
        await tmux.session.killSession(team.sessionName);
        log(`cage: killed ${team.sessionName} on ${team.socketPath}`);
      }
    } catch (e) {
      // Teardown never masks the run's own outcome — a cage that is
      // already gone (or a tmux server that exited with it) is success.
      log(`cage: teardown of ${team.sessionName} failed: ${String(e)}`);
    }
  }
}
