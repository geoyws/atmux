// ADR-272 §Supplement — the voice e2e harness's SAFETY GATE.
//
// This module exists for one reason: the operator's real fleet is 20+ live
// teams with real agents doing real work, and a behavioural test that
// nudges, dispatches to, or merely wedges one of those panes is far worse
// than no test at all. The harness must therefore be *structurally*
// incapable of addressing them — not careful, incapable.
//
// The seam it leans on is already load-bearing elsewhere:
//   - `ATMUX_COCKPIT_CONFIG` overrides the cockpit path, which otherwise
//     defaults to `$HOME/.atmux/cockpit.json` (`src/core/cockpit.ts`).
//   - Every cockpit entry carries a `root`; the tmux socket for that team
//     is resolved from the team's OWN `.atmux/team.json` `tmuxTmpdir`
//     (`resolveTeamSocket` in `src/core/common.ts`, via `probeTeamLive`).
// So a temp-dir cockpit listing exactly one fake team, whose root is under
// the temp dir, with its own `tmuxTmpdir`, gets its own tmux socket, and
// nothing the harness can say reaches the real fleet.
//
// **Fail closed.** Every check below refuses with a `ConfigError` (BSD
// `EX_CONFIG` 78) rather than returning a boolean, because the only
// correct response to "I cannot prove I am isolated" is to not run. The
// caller invokes {@link assertIsolated} BEFORE creating a session, before
// dialing a provider, and before the first tmux command.
//
// Everything is injected (env, uid, cockpit reader, realpath) so the unit
// suite can drive every refusal branch — including the one that matters
// most: pointed at a real-looking cockpit, this REFUSES.

import { isAbsolute, join, resolve, sep } from "node:path";
import { ConfigError } from "../../../errors.ts";
import { defaultCockpitConfigPath } from "../../cockpit.ts";
import { resolveTeamSocket } from "../../common.ts";

/** Env var that overrides the cockpit path — the isolation seam itself. */
export const COCKPIT_ENV = "ATMUX_COCKPIT_CONFIG";

/**
 * Team names the harness creates. Deliberately prefixed and deliberately
 * ugly: a name collision with a real team would defeat the disjointness
 * check, and `vox-e2e` is not a name an operator would ever pick.
 */
export const FAKE_TEAM_PREFIX = "vox-e2e-";

/** One team entry as the gate needs to see it. */
export interface IsolationTeam {
  name: string;
  root: string;
  /** `tmuxTmpdir` from that team's own `.atmux/team.json`, or null when
   *  absent — which is itself a refusal (an absent tmpdir means
   *  `resolveTeamSocket` falls back to the SHARED `/tmp/atmux-<team>/sock`
   *  cage path, i.e. exactly the socket family the real fleet uses). */
  tmuxTmpdir: string | null;
}

export interface AssertIsolatedInput {
  /** Temp root everything must live under. */
  tempRoot: string;
  /** Teams the harness itself created — the expected set, exactly. */
  expectedTeams: ReadonlyArray<IsolationTeam>;
  /** Team names the cockpit file actually lists (read back from disk). */
  cockpitTeamNames: ReadonlyArray<string>;
  /** Environment to read `HOME` + `ATMUX_COCKPIT_CONFIG` from. */
  env: NodeJS.ProcessEnv;
  /** uid used to build the tmux socket path. Injected for tests. */
  uid: number;
  /**
   * Team names found in the OPERATOR'S REAL cockpit, when one could be
   * read. Empty array means "none found"; the disjointness check then
   * passes vacuously, which is correct — the structural checks above it
   * already carry the proof. This is belt-and-braces evidence, not the
   * primary mechanism.
   */
  realTeamNames?: ReadonlyArray<string>;
  /**
   * Socket resolver seam — defaults to the production
   * {@link resolveTeamSocket}.
   *
   * Injectable for one reason, and it is a coverage-honesty reason: with a
   * `tmuxTmpdir` already proven to be under the temp root, the production
   * resolver *cannot* return a path outside it, so the two checks below
   * that guard against exactly that are unreachable in production. They
   * are still worth having — they are what catches a future change to
   * `resolveTeamSocket` that stops honouring `tmuxTmpdir` — so rather than
   * delete a live safety check or leave it permanently unexecuted, the
   * seam lets the suite drive both refusals directly.
   */
  resolveSocket?: (team: { name: string; tmuxTmpdir: string }, opts: { uid: number }) => string;
}

/** What the gate proved, for printing. Every field is evidence. */
export interface IsolationReport {
  cockpitPath: string;
  tempRoot: string;
  teams: ReadonlyArray<{ name: string; root: string; socketPath: string }>;
  home: string;
  /** The socket the REAL fleet uses, shown so the reader can see ours differs. */
  defaultTmuxSocket: string;
  realTeamsChecked: number;
}

function refuse(what: string, hint: string): never {
  throw new ConfigError({ what: `vox-e2e isolation: ${what}`, hint });
}

/**
 * True when `child` is `parent` itself or lies beneath it.
 *
 * Path-prefix comparison is done on SEPARATOR-TERMINATED strings, so
 * `/tmp/atmux-e2e-evil` does not count as being under `/tmp/atmux-e2e`.
 * That off-by-one is the whole bug class this helper exists to avoid.
 */
export function isUnder(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  if (c === p) return true;
  return c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * The tmux socket the operator's own sessions live on: `$TMUX_TMPDIR` when
 * set, else `/tmp`, plus tmux's own `tmux-<uid>/default` suffix. Our socket
 * must never equal this.
 */
export function defaultTmuxSocketPath(env: NodeJS.ProcessEnv, uid: number): string {
  const base =
    env.TMUX_TMPDIR !== undefined && env.TMUX_TMPDIR.length > 0 ? env.TMUX_TMPDIR : "/tmp";
  return join(base, `tmux-${uid}`, "default");
}

/**
 * Refuse unless the harness is provably pointed at its own throwaway cage.
 *
 * @throws ConfigError on ANY doubt. There is no "warn and continue" path.
 */
export function assertIsolated(input: AssertIsolatedInput): IsolationReport {
  const { env, uid, tempRoot } = input;

  if (!isAbsolute(tempRoot) || tempRoot === "/" || tempRoot.length < 2) {
    refuse(
      `temp root is not a usable absolute path: ${JSON.stringify(tempRoot)}`,
      "the harness creates this itself via mkdtemp; a relative or root path means construction failed",
    );
  }

  // --- 1. HOME is pinned into the temp dir -------------------------------
  // Not cosmetic: `resolveTranscriptDir` and the cockpit default are both
  // derived from $HOME, so an unpinned HOME leaves two paths pointing at
  // the operator's real state directory.
  const home = env.HOME;
  if (home === undefined || home.length === 0) {
    refuse("HOME is unset", "the harness must pin HOME into its temp dir before asserting");
  }
  if (!isUnder(tempRoot, home)) {
    refuse(
      `HOME is not under the temp root (HOME=${home}, tempRoot=${tempRoot})`,
      "pin process.env.HOME into the temp dir; the real HOME must never be visible to the harness",
    );
  }

  // --- 2. The cockpit path is ours, not the operator's -------------------
  const cockpitPath = env[COCKPIT_ENV];
  if (cockpitPath === undefined || cockpitPath.length === 0) {
    refuse(
      `${COCKPIT_ENV} is unset`,
      "without the override the fleet verbs read $HOME/.atmux/cockpit.json — the REAL fleet",
    );
  }
  if (!isUnder(tempRoot, cockpitPath)) {
    refuse(
      `${COCKPIT_ENV} points outside the temp root (${cockpitPath})`,
      `it must live under ${tempRoot}`,
    );
  }
  // Belt-and-braces: name the one path that must never be it, even if a
  // future change to `isUnder` or a symlinked HOME ever let it through.
  const realDefault = defaultCockpitConfigPath(home);
  if (resolve(cockpitPath) === resolve(realDefault)) {
    refuse(
      `${COCKPIT_ENV} resolves to the default cockpit path (${cockpitPath})`,
      "that is the operator's live fleet roster",
    );
  }

  // --- 3. The cockpit lists EXACTLY the fake teams -----------------------
  // Set equality, not a blocklist. A blocklist has to enumerate the real
  // fleet to be safe and silently rots as the fleet grows; equality against
  // the harness's own list cannot rot.
  const expectedNames = input.expectedTeams.map((t) => t.name);
  const dupes = expectedNames.filter((n, i) => expectedNames.indexOf(n) !== i);
  if (dupes.length > 0) {
    refuse(`duplicate fake team names: ${dupes.join(", ")}`, "each fake team needs a unique name");
  }
  if (expectedNames.length === 0) {
    refuse("no fake teams declared", "the harness must create at least one team before asserting");
  }
  for (const name of expectedNames) {
    if (!name.startsWith(FAKE_TEAM_PREFIX)) {
      refuse(
        `fake team ${JSON.stringify(name)} lacks the ${JSON.stringify(FAKE_TEAM_PREFIX)} prefix`,
        "the prefix is what makes a collision with a real team name implausible",
      );
    }
  }
  const actual = [...input.cockpitTeamNames].sort();
  const expected = [...expectedNames].sort();
  if (actual.length !== expected.length || actual.some((n, i) => n !== expected[i])) {
    refuse(
      `cockpit lists [${actual.join(", ")}] but the harness created [${expected.join(", ")}]`,
      "the cockpit must list the harness's teams and nothing else",
    );
  }

  // --- 4. Roots and sockets are ours -------------------------------------
  const defaultSocket = defaultTmuxSocketPath(env, uid);
  const teams: Array<{ name: string; root: string; socketPath: string }> = [];
  for (const team of input.expectedTeams) {
    if (!isUnder(tempRoot, team.root)) {
      refuse(
        `team ${team.name} has root outside the temp dir (${team.root})`,
        `roots must live under ${tempRoot}`,
      );
    }
    if (team.tmuxTmpdir === null || team.tmuxTmpdir.length === 0) {
      refuse(
        `team ${team.name} has no tmuxTmpdir in its team.json`,
        "without it resolveTeamSocket falls back to the shared /tmp/atmux-<team>/sock cage path",
      );
    }
    if (!isUnder(tempRoot, team.tmuxTmpdir)) {
      refuse(
        `team ${team.name} tmuxTmpdir is outside the temp dir (${team.tmuxTmpdir})`,
        `it must live under ${tempRoot}`,
      );
    }
    // Resolve through the SAME function production uses, so the gate proves
    // a property of the real resolver rather than of a local re-derivation.
    const resolveSock = input.resolveSocket ?? resolveTeamSocket;
    const socketPath = resolveSock({ name: team.name, tmuxTmpdir: team.tmuxTmpdir }, { uid });
    if (!isUnder(tempRoot, socketPath)) {
      refuse(
        `team ${team.name} resolves to a socket outside the temp dir (${socketPath})`,
        "resolveTeamSocket did not honour tmuxTmpdir — refusing rather than guessing why",
      );
    }
    if (resolve(socketPath) === resolve(defaultSocket)) {
      refuse(
        `team ${team.name} resolves to the DEFAULT tmux socket (${socketPath})`,
        "that socket carries the operator's live sessions",
      );
    }
    teams.push({ name: team.name, root: team.root, socketPath });
  }

  // --- 5. Disjoint from the real fleet -----------------------------------
  const real = new Set(input.realTeamNames ?? []);
  const collisions = expectedNames.filter((n) => real.has(n));
  if (collisions.length > 0) {
    refuse(
      `fake team name(s) collide with the operator's real fleet: ${collisions.join(", ")}`,
      "rename the harness's teams; a shared name could address a real cage",
    );
  }

  return {
    cockpitPath,
    tempRoot,
    teams,
    home,
    defaultTmuxSocket: defaultSocket,
    realTeamsChecked: real.size,
  };
}

/** Render the gate's evidence for stderr. Printed BEFORE anything starts. */
export function formatIsolationReport(r: IsolationReport): string[] {
  const lines = [
    "isolation: PASS — the harness cannot reach the real fleet",
    `  temp root      ${r.tempRoot}`,
    `  HOME           ${r.home}`,
    `  cockpit        ${r.cockpitPath}`,
    `  default socket ${r.defaultTmuxSocket}  (NOT used — real fleet lives here)`,
  ];
  for (const t of r.teams) {
    lines.push(`  team ${t.name}`);
    lines.push(`    root         ${t.root}`);
    lines.push(`    tmux socket  ${t.socketPath}`);
  }
  lines.push(
    r.realTeamsChecked > 0
      ? `  real fleet     ${r.realTeamsChecked} team(s) read from the operator's cockpit — none listed above`
      : "  real fleet     no operator cockpit readable (structural checks stand alone)",
  );
  return lines;
}
