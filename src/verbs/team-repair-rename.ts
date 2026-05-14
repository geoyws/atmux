// ADR-103: CLI dispatcher — `team repair-rename` sub-verb.
// Bash spec: lib/team-repair-rename.sh @ worktree-frozen (380 LOC).
//
// Idempotent recovery verb for teams where `atmux team rename` mutated
// declarative state (team.json:.name + registry) but the imperative
// live world (cage tmpdir basename, cage internal tmux session name,
// __<old>__* window prefixes, .atmux/state/session.txt) stayed on the
// old name. ADR-027 ADDENDUM 11 (t-2a25f7bd) carves this out as the
// recovery path until planner folds it back into rename's main flow.
//
// ────────────────────────────────────────────────────────────────────
// V1 SCOPE (this commit) — explicit-team mode + 5/6 steps + rollback:
//   ✅ Step 1: mv <tmpdir> → /tmp/atmux_tmux_<team>
//   ✅ Step 2: tmux rename-session <old> → <team>           (cage internal)
//   ✅ Step 3: tmux rename-window __<old>__* → __<team>__*  (per-window)
//   ✅ Step 4: team.json:.tmuxTmpdir = /tmp/atmux_tmux_<team>
//   ⏸  Step 5: cron-block install                            DEFERRED
//   ✅ Step 6: .atmux/state/session.txt = <team>
//   ✅ Convergence check + idempotent no-op
//   ✅ --dry-run plan render
//   ✅ Rollback on partial failure (reverse-walk recorded ops)
//
// DEFERRED (not in V1, follow-up tasks under lead's open queue):
//   ⏸  Fleet auto-detect — bash scans `atmux::registry_list --json` for
//      drifted teams when no team arg given. Bun registry abstraction
//      not yet ported (only `src/verbs/audit.ts` + start.ts reference it
//      via TODO). V1 requires explicit `<team>` positional.
//   ⏸  Step 5 cron install — bash calls `atmux::cron_install` which
//      rewrites the crontab block from team.json. Bun's cron.ts has the
//      render helpers (renderCronBlock/Lines) but no install function.
//      V1 emits a stderr WARN telling the operator to re-run start /
//      future `atmux cron-install` to refresh the cron block.
//   ⏸  `--force` flag — only meaningful for fleet auto-detect mode
//      (forces repair of multiple drifted teams). Unused without auto-
//      detect; omitted in V1.
//
// Target tmpdir is hardcoded to `/tmp/atmux_tmux_<team>` per ADR-027
// ADDENDUM 11 (final form; transitional `/tmp/atmux-tmux_<team>` is
// dead). Teams on bun-native `tmuxTmpdir=""` (defaulting to
// `/tmp/atmux-<team>/sock`) or project-local tmpdirs will read as
// "drifted" against the bash-era target — those use-cases are out of
// scope until ADR-027 is reissued for the bun-port era.
//
// Pane-preserving: cage tmpdir mv keeps the tmux server's socket fd
// valid across rename of the containing directory on Linux (verified
// in bash spec). Window-rename + session-rename are tmux metadata ops;
// running TUIs in panes don't notice. New `tmux -S <new-path>`
// connections succeed; old paths fail (caller updates state files).

import { rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type CrontabIO, defaultCrontabIO } from "../abstractions/crontab.ts";
import { atomicWrite, exists, readTextOrNull } from "../abstractions/fs.ts";
import { createTmux, type TmuxNamespace } from "../abstractions/tmux.ts";
import {
  getAtmuxDir,
  getDefaultSocket,
  loadTeam,
  type ResolveDirOpts,
  sessionAnchorPath,
  stateDir,
  teamJsonPath,
} from "../core/common.ts";
import { installCronBlock } from "../core/cron.ts";
import { defaultStderrWrite, defaultStdoutWrite, type Writer } from "../core/io.ts";
import { ConfigError, UsageError } from "../errors.ts";
import { Team } from "../schema/team.ts";

const USAGE = "atmux team repair-rename <team> [--dry-run]";

// ---------- Args ----------

export interface RepairRenameArgs {
  team: string;
  dryRun: boolean;
  socketPath?: string;
  teamDir?: string;
}

export function parseRepairRenameArgs(argv: ReadonlyArray<string>): RepairRenameArgs {
  let team = "";
  let dryRun = false;
  let socketPath: string | undefined;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--dry-run") {
      dryRun = true;
      i += 1;
      continue;
    }
    if (a === "--socket") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({
          what: "team repair-rename: --socket requires a path",
          hint: USAGE,
        });
      }
      socketPath = v;
      i += 2;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({
          what: "team repair-rename: --team-dir requires a value",
          hint: USAGE,
        });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    if (a === "--force") {
      // V1 has no fleet auto-detect; --force is meaningless. Reject
      // explicitly so operators know to wait for the auto-detect port
      // rather than silently treating it as a passthrough.
      throw new UsageError({
        what: "team repair-rename: --force is reserved for fleet auto-detect mode (deferred — V1 requires explicit <team>)",
        hint: USAGE,
      });
    }
    if (a?.startsWith("-")) {
      throw new UsageError({
        what: `team repair-rename: unknown flag: ${a}`,
        hint: USAGE,
      });
    }
    if (team.length === 0) {
      team = a ?? "";
    } else {
      throw new UsageError({
        what: "team repair-rename: too many args (V1 requires exactly one <team>; fleet auto-detect deferred)",
        hint: USAGE,
      });
    }
    i += 1;
  }
  if (team.length === 0) {
    throw new UsageError({ what: USAGE });
  }
  const out: RepairRenameArgs = { team, dryRun };
  if (socketPath !== undefined) out.socketPath = socketPath;
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

// ---------- Pure helpers ----------

/** Bash spec line 150 — target tmpdir per ADR-027 ADDENDUM 11. */
export function newTmpdirFor(team: string): string {
  return `/tmp/atmux_tmux_${team}`;
}

/** Bash spec `_atmux_team_repair_rename_window_target` — strip leading
 *  `__<old>__` prefix and emit `__<team>__<rest>`. The bash regex is
 *  `__*__` (shell glob, greedy through the second `__`); preserves the
 *  full suffix after the second `__` including any nested underscores.
 *  Returns the input verbatim if the window name has no `__<x>__`
 *  prefix shape (defensive). */
export function windowRenameTarget(win: string, team: string): string {
  const m = win.match(/^__[a-z0-9_-]+?__(.*)$/);
  if (m === null) return win;
  return `__${team}__${m[1]}`;
}

/** Bash spec lines 101-128 — drift signals. Pure: pure-evaluates the
 *  snapshot of (declared tmpdir, live cage, state file) against the
 *  V1 target convention. Returns `null` for a converged team (caller
 *  exits as no-op). */
export interface DriftSnapshot {
  oldTmpdir: string;
  newTmpdir: string;
  oldSess: string | null;
  staleWindows: ReadonlyArray<string>;
  oldStateContent: string | null;
  cageAlive: boolean;
}

export interface DriftFlags {
  needsTmpdirMv: boolean;
  needsSessionRename: boolean;
  needsWindowRename: boolean;
  needsStateSync: boolean;
}

export function evaluateDrift(snap: DriftSnapshot, team: string): DriftFlags {
  return {
    needsTmpdirMv: snap.oldTmpdir !== snap.newTmpdir,
    needsSessionRename:
      snap.cageAlive && snap.oldSess !== null && snap.oldSess.length > 0 && snap.oldSess !== team,
    needsWindowRename: snap.staleWindows.length > 0,
    needsStateSync:
      snap.oldStateContent !== null &&
      snap.oldStateContent.length > 0 &&
      snap.oldStateContent !== team,
  };
}

export function isConverged(d: DriftFlags): boolean {
  return !d.needsTmpdirMv && !d.needsSessionRename && !d.needsWindowRename && !d.needsStateSync;
}

// ---------- Plan render ----------

export interface PlanLine {
  step: number;
  body: string;
}

export function renderPlan(
  snap: DriftSnapshot,
  flags: DriftFlags,
  team: string,
): ReadonlyArray<PlanLine> {
  const lines: PlanLine[] = [];
  if (flags.needsTmpdirMv) {
    lines.push({ step: 1, body: `mv  ${snap.oldTmpdir} → ${snap.newTmpdir}` });
  } else {
    lines.push({ step: 1, body: `tmpdir already at ${snap.newTmpdir} ✅` });
  }
  if (flags.needsSessionRename) {
    lines.push({
      step: 2,
      body: `tmux rename-session  ${snap.oldSess} → ${team}  (on cage socket)`,
    });
  } else if (snap.cageAlive) {
    lines.push({ step: 2, body: `cage session already "${team}" ✅` });
  } else {
    lines.push({ step: 2, body: "no live cage — session-rename skipped" });
  }
  if (flags.needsWindowRename) {
    lines.push({
      step: 3,
      body: `tmux rename-window (${snap.staleWindows.length} window(s)):`,
    });
    for (const w of snap.staleWindows) {
      const next = windowRenameTarget(w, team);
      lines.push({ step: 3, body: `    ${w} → ${next}` });
    }
  } else {
    lines.push({ step: 3, body: "no stale __<old>__* windows ✅" });
  }
  lines.push({ step: 4, body: `team.json:.tmuxTmpdir = ${snap.newTmpdir}` });
  lines.push({
    step: 5,
    body: "cron-block install DEFERRED (V1) — re-run `atmux start` to refresh cron",
  });
  if (flags.needsStateSync) {
    lines.push({
      step: 6,
      body: `.atmux/state/session.txt: ${snap.oldStateContent} → ${team}`,
    });
  } else {
    lines.push({ step: 6, body: `state/session.txt already "${team}" ✅` });
  }
  return lines;
}

// ---------- Probe ----------

export interface ProbeDeps {
  tmux: TmuxNamespace;
  /** Resolves to the team's tmux socket path for live cage probes. The
   *  bun socket abstraction is configured per-namespace, so the probe
   *  builds one namespace at the OLD tmpdir's socket path. Caller
   *  provides the resolver via this dep. */
  buildTmuxAtSocket: (socketPath: string) => TmuxNamespace;
}

/** Bash spec lines 152-168 — capture pre-state. Reads team.json for
 *  declared tmpdir; if a live tmux socket exists at the old tmpdir's
 *  `tmux-<uid>/default` shape, list sessions + windows to detect any
 *  stale `__<old>__*` window prefix. */
export async function probeDrift(
  atmuxDir: string,
  team: string,
  deps: ProbeDeps,
  uid: number = process.getuid?.() ?? 0,
): Promise<DriftSnapshot> {
  const tj = teamJsonPath(atmuxDir);
  if (!(await exists(tj))) {
    throw new ConfigError({ what: `team repair-rename: team.json missing at ${tj}` });
  }
  const teamObj = await loadTeam({ teamDir: dirname(atmuxDir) });
  if (teamObj.name !== team) {
    throw new ConfigError({
      what: `team repair-rename: team.json:.name='${teamObj.name}' but arg says '${team}' — fix declarative state first`,
      hint: "either rename the arg or edit team.json:.name before repair",
    });
  }
  const oldTmpdir = teamObj.tmuxTmpdir ?? "";
  if (oldTmpdir.length === 0) {
    throw new ConfigError({
      what: `team repair-rename: team.json has no .tmuxTmpdir — bun-native teams use the canonical socket ${getDefaultSocket(team)} and don't need this verb`,
    });
  }
  const newTmpdir = newTmpdirFor(team);

  // Probe live cage if socket present at old tmpdir.
  const oldSocketPath = join(oldTmpdir, `tmux-${uid}`, "default");
  let cageAlive = false;
  let oldSess: string | null = null;
  const staleWindows: string[] = [];
  if (await exists(oldSocketPath)) {
    cageAlive = true;
    const probe = deps.buildTmuxAtSocket(oldSocketPath);
    const sessions = await probe.session.listSessions().catch(() => []);
    if (sessions.length > 0) {
      const first = sessions[0];
      oldSess = first?.name ?? null;
      if (oldSess !== null && oldSess.length > 0) {
        const windows = await probe.window.listWindows(oldSess).catch(() => []);
        for (const w of windows) {
          if (w.name.startsWith(`__${team}__`)) continue;
          if (/^__[a-z0-9_-]+__/.test(w.name)) staleWindows.push(w.name);
        }
      }
    }
  }

  const stateFile = sessionAnchorPath(atmuxDir);
  const oldStateContent = (await readTextOrNull(stateFile))?.trim() ?? null;

  return {
    oldTmpdir,
    newTmpdir,
    oldSess,
    staleWindows,
    oldStateContent:
      oldStateContent === null || oldStateContent.length === 0 ? null : oldStateContent,
    cageAlive,
  };
}

// ---------- Apply (with rollback) ----------

/** Internal: tagged record of an applied step, used to drive reverse
 *  rollback on failure. */
type RollbackOp =
  | { kind: "tmpdir"; old: string; current: string }
  | { kind: "session"; socketPath: string; old: string; current: string }
  | { kind: "window"; socketPath: string; windowId: string; old: string; current: string }
  | { kind: "teamjson"; path: string; oldValue: string }
  | { kind: "statetxt"; path: string; oldContent: string };

export interface ApplyDeps extends ProbeDeps {
  stderr: Writer;
  /** ADR-083 follow-up §DEFERRED row 3: crontab IO seam for Step 5
   *  cron-block refresh. Defaults to `defaultCrontabIO()` at the verb
   *  entry point. */
  crontab?: CrontabIO;
  /** Returns the atmux binary path baked into cron lines. Defaults to
   *  `process.env.ATMUX_BIN ?? Bun.which("atmux")`. Tests pin a
   *  deterministic value. */
  resolveBin?: () => string | null;
  /** Defaults to `process.env`. Tests pin `ATMUX_NO_CRON`. */
  env?: Readonly<Record<string, string | undefined>>;
}

export interface ApplyResult {
  appliedSteps: ReadonlyArray<number>;
  rolledBack: boolean;
  reason?: string;
}

/** Bash spec lines 230-316. Executes the repair plan, recording each
 *  reversible op into a rollback log. On any step failure, walks the
 *  log in reverse and best-effort undoes. */
export async function applyRepair(
  atmuxDir: string,
  team: string,
  snap: DriftSnapshot,
  flags: DriftFlags,
  deps: ApplyDeps,
  uid: number = process.getuid?.() ?? 0,
): Promise<ApplyResult> {
  const ops: RollbackOp[] = [];
  const appliedSteps: number[] = [];
  const tjPath = teamJsonPath(atmuxDir);
  const stateFile = sessionAnchorPath(atmuxDir);

  const rollback = async (): Promise<void> => {
    for (let i = ops.length - 1; i >= 0; i--) {
      const op = ops[i];
      if (op === undefined) continue;
      try {
        switch (op.kind) {
          case "tmpdir":
            if ((await exists(op.current)) && !(await exists(op.old))) {
              await rename(op.current, op.old);
            }
            break;
          case "session": {
            const t = deps.buildTmuxAtSocket(op.socketPath);
            await t.session.renameSession(op.current, op.old).catch(() => {});
            break;
          }
          case "window": {
            const t = deps.buildTmuxAtSocket(op.socketPath);
            await t.window.renameWindow(op.windowId, op.old).catch(() => {});
            break;
          }
          case "teamjson":
            await mutateTeamJsonTmpdir(op.path, op.oldValue).catch(() => {});
            break;
          case "statetxt":
            await atomicWrite(op.path, op.oldContent).catch(() => {});
            break;
        }
      } catch {
        // Best-effort; continue walking.
      }
    }
  };

  // Step 1: tmpdir mv.
  if (flags.needsTmpdirMv) {
    if (await exists(snap.newTmpdir)) {
      return {
        appliedSteps: [],
        rolledBack: false,
        reason: `target ${snap.newTmpdir} already exists — refusing to clobber (inspect manually)`,
      };
    }
    try {
      await rename(snap.oldTmpdir, snap.newTmpdir);
      ops.push({ kind: "tmpdir", old: snap.oldTmpdir, current: snap.newTmpdir });
      appliedSteps.push(1);
    } catch (e) {
      return {
        appliedSteps: [],
        rolledBack: false,
        reason: `mv '${snap.oldTmpdir}' → '${snap.newTmpdir}' failed: ${errMsg(e)}`,
      };
    }
  }

  const newSocketPath = join(snap.newTmpdir, `tmux-${uid}`, "default");

  // Step 2: rename cage session.
  if (flags.needsSessionRename && snap.oldSess !== null) {
    try {
      const t = deps.buildTmuxAtSocket(newSocketPath);
      await t.session.renameSession(snap.oldSess, team);
      ops.push({
        kind: "session",
        socketPath: newSocketPath,
        old: snap.oldSess,
        current: team,
      });
      appliedSteps.push(2);
    } catch (e) {
      await rollback();
      return {
        appliedSteps: [],
        rolledBack: true,
        reason: `tmux rename-session '${snap.oldSess}' → '${team}' failed: ${errMsg(e)}`,
      };
    }
  }

  // Step 3: per-window rename.
  if (flags.needsWindowRename && snap.staleWindows.length > 0) {
    const t = deps.buildTmuxAtSocket(newSocketPath);
    const liveWindows = await t.window.listWindows(team).catch(() => []);
    // Map by name → id so a literal-name-match resolves to a stable
    // window-id (immune to tmux prefix-match bugs in `-t <name>`).
    const idByName = new Map<string, string>();
    for (const w of liveWindows) idByName.set(w.name, w.id);
    for (const w of snap.staleWindows) {
      const wid = idByName.get(w);
      if (wid === undefined) {
        await rollback();
        return {
          appliedSteps: [],
          rolledBack: true,
          reason: `window '${w}' vanished mid-rename (cage racing?)`,
        };
      }
      const next = windowRenameTarget(w, team);
      try {
        await t.window.renameWindow(wid, next);
        ops.push({
          kind: "window",
          socketPath: newSocketPath,
          windowId: wid,
          old: w,
          current: next,
        });
      } catch (e) {
        await rollback();
        return {
          appliedSteps: [],
          rolledBack: true,
          reason: `rename-window '${w}' → '${next}' failed: ${errMsg(e)}`,
        };
      }
    }
    appliedSteps.push(3);
  }

  // Step 4: team.json:.tmuxTmpdir update.
  try {
    await mutateTeamJsonTmpdir(tjPath, snap.newTmpdir);
    ops.push({ kind: "teamjson", path: tjPath, oldValue: snap.oldTmpdir });
    appliedSteps.push(4);
  } catch (e) {
    await rollback();
    return {
      appliedSteps: [],
      rolledBack: true,
      reason: `team.json:.tmuxTmpdir update failed: ${errMsg(e)}`,
    };
  }

  // Step 5: cron install — DEFERRED in V1. Emit warn.
  deps.stderr(
    "  · step 5 cron-block install DEFERRED in V1 — re-run `atmux start` to refresh the cron block\n",
  );

  // Step 6: state/session.txt sync.
  if (flags.needsStateSync) {
    try {
      const oldContent = snap.oldStateContent ?? "";
      await atomicWrite(stateFile, `${team}\n`);
      ops.push({ kind: "statetxt", path: stateFile, oldContent: `${oldContent}\n` });
      appliedSteps.push(6);
    } catch (e) {
      await rollback();
      return {
        appliedSteps: [],
        rolledBack: true,
        reason: `state/session.txt write failed: ${errMsg(e)}`,
      };
    }
  }

  return { appliedSteps, rolledBack: false };
}

/** team.json mutation helper — preserves all other fields, atomic
 *  write. Mirrors bash `atmux::jq_update` for `.tmuxTmpdir = $p`. */
async function mutateTeamJsonTmpdir(path: string, value: string): Promise<void> {
  const text = await readTextOrNull(path);
  if (text === null) throw new Error(`team.json missing at ${path}`);
  const obj = JSON.parse(text);
  const next = Team.parse({ ...obj, tmuxTmpdir: value });
  await atomicWrite(path, `${JSON.stringify(next, null, 2)}\n`);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------- Verb entry ----------

export interface TeamRepairRenameOpts {
  buildTmux?: (socketPath: string) => TmuxNamespace;
  stdout?: Writer;
  stderr?: Writer;
}

export function defaultBuildTmux(socketPath: string): TmuxNamespace {
  return createTmux({ socketPath });
}

export async function teamRepairRename(
  argv: ReadonlyArray<string>,
  opts: TeamRepairRenameOpts = {},
): Promise<number> {
  const parsed = parseRepairRenameArgs(argv);
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const atmuxDir = await getAtmuxDir(dirOpts);
  const stdout = opts.stdout ?? defaultStdoutWrite;
  const stderr = opts.stderr ?? defaultStderrWrite;
  const buildTmuxAtSocket = opts.buildTmux ?? defaultBuildTmux;

  // Build a primary tmux ns to satisfy the deps shape (probe + apply
  // operate on the cage-local socket path). The primary ns itself is
  // unused except as a sentinel — every actual call goes through
  // buildTmuxAtSocket(...) since the socket moves mid-verb.
  const primarySocket = parsed.socketPath ?? getDefaultSocket(parsed.team);
  const deps: ApplyDeps = {
    tmux: buildTmuxAtSocket(primarySocket),
    buildTmuxAtSocket,
    stderr,
  };

  const snap = await probeDrift(atmuxDir, parsed.team, deps);
  const flags = evaluateDrift(snap, parsed.team);

  if (isConverged(flags)) {
    stdout(`team repair-rename: '${parsed.team}' already converged — no-op\n`);
    return 0;
  }

  // Plan rendering — always emit, --dry-run stops here.
  stderr(`\n🩹 atmux team repair-rename — plan for "${parsed.team}"\n\n`);
  for (const line of renderPlan(snap, flags, parsed.team)) {
    stderr(`  ${line.step}. ${line.body}\n`);
  }
  stderr("\n");

  if (parsed.dryRun) {
    stdout("team repair-rename: --dry-run — no changes applied\n");
    return 0;
  }

  await ensureStateDir(atmuxDir);
  const result = await applyRepair(atmuxDir, parsed.team, snap, flags, deps);

  if (result.reason !== undefined) {
    const tag = result.rolledBack ? "rolled back" : "aborted pre-step-1";
    stderr(`team repair-rename: ${result.reason} — ${tag}\n`);
    return 1;
  }

  stdout(
    `team repair-rename: '${parsed.team}' converged (steps applied: ${result.appliedSteps.join(",")})\n`,
  );
  return 0;
}

async function ensureStateDir(atmuxDir: string): Promise<void> {
  const dir = stateDir(atmuxDir);
  if (!(await exists(dir))) {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
  }
}
