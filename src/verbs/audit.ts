// ADR-079 §B: audit verb — typed port of
// `.archive-bash-atmux-20260507/lib/audit.sh`.
//
// CLI surface (subset of bash; --fix flow stays in .archive bash and is
// scheduled for deletion alongside this commit):
//
//     atmux audit [--quiet|-q] [--json] [--class <a|b|c|d|e|f|all>]
//                 [--team-dir <path>] [--socket <path>]
//
// --quiet  → suppress output; exit 0 on green, 1 on any drift (whip
//            sub-pass shape per bash `_atmux_whip_check_audit`).
// --json   → emit findings array.
// --class  → narrow detection scope; default "all".
//
// Class taxonomy (ADR-038), with two intentional bun-side semantics
// changes:
//   A — driver-window naming.   ADR-044 reversal: bun expects bare
//                               `driver`; flag presence of the legacy
//                               `__<team>__driver` form. (Bash flagged
//                               the inverse.)
//   B — cage path separator.    Hyphen-form `/tmp/atmux-tmux-*` is
//                               legacy; canonical is underscore-form
//                               `/tmp/atmux_tmux_<team>` (ADR-018,
//                               ADR-027 ADDENDUM 11).
//   C — window-position drift.  pos 1 = driver, pos 2 = lead. Lead
//                               name accepted in ADR-017 form
//                               (`<emoji>lead`) AND legacy prefixed
//                               (`__<team>__<emoji>lead`) AND bare
//                               `lead` — any mismatch is a finding.
//   D — trailing punctuation    Legacy prefixed-form windows
//       residue.                 (`__<team>__*`) with trailing `-`/`_`.
//                               ADR-017 bare-emoji form is not in
//                               scope here; bash-bit-for-bit port.
//   E — stray cage tmpdirs.     Filesystem walk of `<tmpRoot>/atmux*tmux*`
//                               directories with no live socket and no
//                               cockpit-registered team referencing the
//                               path.
//   F — tmux config glyph.      Stub (Sk-deferred per ADR-038
//                               §Consequences); detector emits no
//                               findings, kept here for forward
//                               compatibility with the dispatch table.
//
// All detectors are pure functions on injected inputs (windows list,
// tmpdir, registered set, fs probes), so unit tests drive each branch
// without spinning up tmux or touching `/tmp`.

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { exists } from "../abstractions/fs.ts";
import { tryReadJson } from "../abstractions/json.ts";
import { createTmux, type TmuxConfig, type TmuxNamespace } from "../abstractions/tmux.ts";
import { loadCockpit, type LoadCockpitOpts } from "../core/cockpit.ts";
import {
  getSessionName,
  type ResolveDirOpts,
  resolveTeamSocket,
  tryLoadTeam,
} from "../core/common.ts";
import { defaultStdoutWrite, type Writer } from "../core/io.ts";
import { UsageError } from "../errors.ts";
import { Team } from "../schema/team.ts";

const USAGE =
  "atmux audit [--quiet|-q] [--json] [--class <a|b|c|d|e|f|all>] [--team-dir <path>] [--socket <path>]";

// ---------- Types ----------

export type AuditClass = "A" | "B" | "C" | "D" | "E" | "F";
export type AuditClassFilter = "a" | "b" | "c" | "d" | "e" | "f" | "all";
export type AuditSeverity = "low" | "medium" | "high";
export type AuditBlast = "low" | "medium" | "high";

export interface AuditFinding {
  class: AuditClass;
  severity: AuditSeverity;
  team: string;
  detail: string;
  fix_hint: string;
  auto_fixable: boolean;
  blast_radius: AuditBlast;
}

const CLASS_META: Readonly<
  Record<AuditClass, { severity: AuditSeverity; blast_radius: AuditBlast; auto_fixable: boolean }>
> = {
  A: { severity: "medium", blast_radius: "medium", auto_fixable: false },
  B: { severity: "high", blast_radius: "high", auto_fixable: false },
  C: { severity: "high", blast_radius: "high", auto_fixable: false },
  D: { severity: "low", blast_radius: "low", auto_fixable: true },
  E: { severity: "low", blast_radius: "low", auto_fixable: true },
  F: { severity: "low", blast_radius: "low", auto_fixable: true },
};

export function makeFinding(
  cls: AuditClass,
  team: string,
  detail: string,
  fix_hint: string,
): AuditFinding {
  const meta = CLASS_META[cls];
  return {
    class: cls,
    severity: meta.severity,
    team,
    detail,
    fix_hint,
    auto_fixable: meta.auto_fixable,
    blast_radius: meta.blast_radius,
  };
}

// ---------- Args ----------

export interface AuditArgs {
  quiet: boolean;
  json: boolean;
  classFilter: AuditClassFilter;
  teamDir?: string;
  socketPath?: string;
}

const VALID_CLASS_FILTERS: ReadonlySet<AuditClassFilter> = new Set([
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "all",
]);

function asClassFilter(v: string): AuditClassFilter {
  const lc = v.toLowerCase();
  if (!VALID_CLASS_FILTERS.has(lc as AuditClassFilter)) {
    throw new UsageError({
      what: `audit: --class must be one of {a,b,c,d,e,f,all} (got '${v}')`,
      hint: USAGE,
    });
  }
  return lc as AuditClassFilter;
}

export function parseAuditArgs(argv: ReadonlyArray<string>): AuditArgs {
  let quiet = false;
  let json = false;
  let classFilter: AuditClassFilter = "all";
  let teamDir: string | undefined;
  let socketPath: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--quiet" || a === "-q") {
      quiet = true;
      i += 1;
      continue;
    }
    if (a === "--json") {
      json = true;
      i += 1;
      continue;
    }
    if (a === "--class") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({
          what: "audit: --class requires a value (a|b|c|d|e|f|all)",
          hint: USAGE,
        });
      }
      classFilter = asClassFilter(v);
      i += 2;
      continue;
    }
    if (a?.startsWith("--class=") === true) {
      classFilter = asClassFilter(a.slice("--class=".length));
      i += 1;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "audit: --team-dir requires a value", hint: USAGE });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    if (a === "--socket") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "audit: --socket requires a path", hint: USAGE });
      }
      socketPath = v;
      i += 2;
      continue;
    }
    if (a === "--fix" || a === "--dry-run") {
      throw new UsageError({
        what: `audit: ${a} is not implemented in the bun port (.archive-bash retains the fixer flow)`,
        hint: "report findings via --json + dispatch fixes per the per-class fix_hint",
      });
    }
    if (a === "-h" || a === "--help") {
      throw new UsageError({ what: "audit: usage", hint: USAGE });
    }
    throw new UsageError({ what: `audit: unknown arg: ${a ?? ""}`, hint: USAGE });
  }
  const out: AuditArgs = { quiet, json, classFilter };
  if (teamDir !== undefined) out.teamDir = teamDir;
  if (socketPath !== undefined) out.socketPath = socketPath;
  return out;
}

// ---------- Detectors ----------

/** Class A — driver-window naming (ADR-044 reversal).
 *
 * Bun-side canonical: window-1 is bare `driver`. The pre-amend prefixed
 * form `__<team>__driver` is the drift state we flag. The bash detector
 * flagged the inverse (bare `driver` was the drift); this port reverses
 * the rule per ADR-044 and the test pins the regression.
 */
export function detectClassA(opts: {
  team: string;
  windows: ReadonlyArray<{ name: string }>;
}): AuditFinding | null {
  const old = `__${opts.team}__driver`;
  if (!opts.windows.some((w) => w.name === old)) return null;
  return makeFinding(
    "A",
    opts.team,
    `driver window named '${old}' (expected bare 'driver' per ADR-044)`,
    `tmux rename-window '${old}' driver (after pane-idle gate)`,
  );
}

/** Class B — cage tmpdir hyphen-form. Ports bash bit-for-bit. */
export function detectClassB(opts: {
  team: string;
  tmuxTmpdir?: string;
}): AuditFinding | null {
  const t = opts.tmuxTmpdir;
  if (t === undefined || t.length === 0) return null;
  if (!/^\/tmp\/atmux-tmux-/.test(t)) return null;
  return makeFinding(
    "B",
    opts.team,
    `team.json:.tmuxTmpdir uses hyphen-form '${t}' (canonical: /tmp/atmux_tmux_${opts.team})`,
    `atmux team repair-rename ${opts.team} (atomic mv + session/window rename + cron rewrite)`,
  );
}

/** Class C — window-position drift. */
export function detectClassC(opts: {
  team: string;
  windows: ReadonlyArray<{ index: number; name: string }>;
}): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const team = opts.team;
  const w1 = opts.windows.find((w) => w.index === 1);
  if (w1 !== undefined) {
    if (w1.name !== "driver" && w1.name !== `__${team}__driver`) {
      findings.push(
        makeFinding(
          "C",
          team,
          `window-position 1 is '${w1.name}' (expected driver pane: 'driver')`,
          `tmux swap-window -s :${w1.name} -t :1 (after relocating driver)`,
        ),
      );
    }
  }
  const w2 = opts.windows.find((w) => w.index === 2);
  if (w2 !== undefined) {
    if (!isLeadName(w2.name, team)) {
      findings.push(
        makeFinding(
          "C",
          team,
          `window-position 2 is '${w2.name}' (expected lead pane: '<emoji>lead' per ADR-017)`,
          "tmux swap-window -t :2 (target the lead pane's current index)",
        ),
      );
    }
  }
  return findings;
}

function isLeadName(name: string, team: string): boolean {
  if (name === "lead") return true;
  // pre-amend: __<team>__<glyph>lead
  if (name.startsWith(`__${team}__`) && name.endsWith("lead")) return true;
  // ADR-017 post-amend: <emoji>lead — non-prefixed name ending in 'lead'
  if (!name.startsWith("__") && name.endsWith("lead")) return true;
  return false;
}

/** Class D — trailing punctuation residue on legacy `__<team>__*` windows.
 *  Bash-bit-for-bit port; ADR-017 bare-emoji windows are out of scope
 *  here (their detector would need a different shape). */
export function detectClassD(opts: {
  team: string;
  windows: ReadonlyArray<{ name: string }>;
}): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const prefix = `__${opts.team}__`;
  for (const w of opts.windows) {
    if (!w.name.startsWith(prefix)) continue;
    const tail = w.name.slice(prefix.length);
    if (!/[-_]+$/.test(tail)) continue;
    const stripped = `${prefix}${tail.replace(/[-_]+$/, "")}`;
    findings.push(
      makeFinding(
        "D",
        opts.team,
        `window '${w.name}' has trailing punctuation residue (canonical: '${stripped}')`,
        `tmux rename-window '${w.name}' '${stripped}'`,
      ),
    );
  }
  return findings;
}

// ---------- Class E (filesystem) ----------

const DEFAULT_TMP_ROOT = "/tmp";

export interface ClassEDeps {
  /** Filesystem scan root. Defaults to `/tmp`. Tests inject an isolated
   *  tmpdir (matching the bash `ATMUX_AUDIT_TMP_ROOT` env hook). */
  tmpRoot?: string;
  /** Pre-resolved set of registered team tmuxTmpdir paths. Test
   *  injection point — production callers pass `undefined` so the
   *  driver loads them from the cockpit roster. */
  registeredTmpdirs?: ReadonlySet<string>;
  /** List entries of a directory; defaults to `node:fs/promises.readdir`.
   *  Returns `[]` on missing/unreadable root. */
  listDir?: (path: string) => Promise<string[]>;
  /** True iff `<dir>/tmux-*\/default` exists as a unix-domain socket.
   *  Defaults to a real fs probe. */
  hasLiveSocket?: (dir: string) => Promise<boolean>;
}

export async function detectClassE(
  opts: { team: string } & ClassEDeps,
): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  const tmpRoot = opts.tmpRoot ?? DEFAULT_TMP_ROOT;
  const registered = opts.registeredTmpdirs ?? new Set<string>();
  const listFn = opts.listDir ?? defaultListDir;
  const liveFn = opts.hasLiveSocket ?? defaultHasLiveSocket;

  const entries = await listFn(tmpRoot);
  for (const name of entries) {
    if (!name.startsWith("atmux-tmux-") && !name.startsWith("atmux_tmux_")) continue;
    const dir = join(tmpRoot, name);
    if (registered.has(dir)) continue;
    if (await liveFn(dir)) continue;
    findings.push(
      makeFinding(
        "E",
        opts.team,
        `stray cage tmpdir '${dir}' (no live socket + no registry entry)`,
        `rmdir --ignore-fail-on-non-empty '${dir}' (after manual ls -A check)`,
      ),
    );
  }
  return findings;
}

/** Exported for test injection of the default-path branches. Production
 *  code uses the verb-level dispatch which selects this on `undefined`
 *  `listDir` / `hasLiveSocket` deps. */
export async function defaultListDir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

export async function defaultHasLiveSocket(dir: string): Promise<boolean> {
  let subs: string[];
  try {
    subs = await readdir(dir);
  } catch {
    return false;
  }
  for (const s of subs) {
    if (!s.startsWith("tmux-")) continue;
    const sock = join(dir, s, "default");
    try {
      const st = await stat(sock);
      if (st.isSocket()) return true;
    } catch {
      // ENOENT → no socket at this path; keep walking siblings.
    }
  }
  return false;
}

/** Walk the cockpit roster; for each enabled team, read its team.json,
 *  collect the `tmuxTmpdir` field. Best-effort: missing cockpit, missing
 *  per-team team.json, and parse failures silently drop out of the set
 *  rather than aborting the audit. */
export async function loadRegisteredTmpdirs(
  loader?: (opts?: LoadCockpitOpts) => Promise<{
    teams: ReadonlyArray<{ root: string; enabled?: boolean }>;
  }>,
): Promise<Set<string>> {
  const out = new Set<string>();
  let cockpit: { teams: ReadonlyArray<{ root: string; enabled?: boolean }> };
  try {
    cockpit = loader !== undefined ? await loader() : await loadCockpit();
  } catch {
    return out;
  }
  for (const t of cockpit.teams) {
    const tj = join(t.root, ".atmux", "team.json");
    if (!(await exists(tj))) continue;
    let teamData: unknown = null;
    try {
      teamData = await tryReadJson(tj, Team);
    } catch {
      // Malformed team.json — skip silently per best-effort contract.
      teamData = null;
    }
    if (teamData === null) continue;
    const tmpdir = (teamData as { tmuxTmpdir?: unknown }).tmuxTmpdir;
    if (typeof tmpdir === "string" && tmpdir.length > 0) {
      out.add(tmpdir);
    }
  }
  return out;
}

// ---------- Render ----------

function pad(s: string, n: number): string {
  if (s.length >= n) return s;
  return s + " ".repeat(n - s.length);
}

export function renderHuman(findings: ReadonlyArray<AuditFinding>): string {
  if (findings.length === 0) return "✅ atmux audit: no drift detected\n";
  const lines: string[] = [];
  lines.push(`🩹 atmux audit: ${findings.length} drift(s)`);
  lines.push("");
  lines.push(`  ${pad("CLASS", 5)} ${pad("SEVERITY", 8)} ${pad("TEAM", 12)} DETAIL — FIX-HINT`);
  lines.push(`  ${pad("-----", 5)} ${pad("--------", 8)} ${pad("----", 12)} -----------------`);
  for (const f of findings) {
    lines.push(
      `  ${pad(f.class, 5)} ${pad(f.severity, 8)} ${pad(f.team || "-", 12)} ${f.detail}`,
    );
    lines.push(`  ${pad("", 5)} ${pad("", 8)} ${pad("", 12)}   ↳ ${f.fix_hint}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderJson(findings: ReadonlyArray<AuditFinding>): string {
  if (findings.length === 0) return "[]\n";
  return `${JSON.stringify(findings, null, 2)}\n`;
}

// ---------- Driver ----------

export interface RunAuditDeps {
  /** Pre-resolved tmux namespace. Default constructs from the team's
   *  resolved socket path. Tests inject a fake. */
  tmux?: TmuxNamespace;
  /** Cockpit loader override (test injection). */
  loadCockpitFn?: (opts?: LoadCockpitOpts) => Promise<{
    teams: ReadonlyArray<{ root: string; enabled?: boolean }>;
  }>;
  /** Class E filesystem injection point. */
  classEDeps?: ClassEDeps;
}

export async function runAllChecks(
  args: AuditArgs,
  deps: RunAuditDeps = {},
): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  const resolveOpts: ResolveDirOpts = args.teamDir !== undefined ? { dir: args.teamDir } : {};

  let team: Awaited<ReturnType<typeof tryLoadTeam>> = null;
  try {
    team = await tryLoadTeam(resolveOpts);
  } catch {
    // Malformed team.json — bash audit treated this as "no team context",
    // skipping team-scoped detectors. Class E (filesystem-scope) still
    // runs.
    team = null;
  }

  if (team !== null) {
    const teamName = team.name;

    // Tmux observations: only fire if the session exists; otherwise the
    // pos / window detectors have no input. `team.tmuxTmpdir` is read
    // independently of session liveness.
    const sessionName = await getSessionName({ ...resolveOpts, team });
    const tmux = deps.tmux ?? createTmux(buildTmuxConfig(team, args.socketPath));
    let sessionExists = false;
    try {
      sessionExists = await tmux.session.hasSession(sessionName);
    } catch {
      sessionExists = false;
    }
    let windows: { index: number; name: string }[] = [];
    if (sessionExists) {
      try {
        const ws = await tmux.window.listWindows(sessionName);
        windows = ws.map((w) => ({ index: w.index, name: w.name }));
      } catch {
        windows = [];
      }
    }

    if (sessionExists && (args.classFilter === "a" || args.classFilter === "all")) {
      const r = detectClassA({ team: teamName, windows });
      if (r !== null) findings.push(r);
    }
    if (args.classFilter === "b" || args.classFilter === "all") {
      const tmuxTmpdir = typeof team.tmuxTmpdir === "string" ? team.tmuxTmpdir : undefined;
      const opts: { team: string; tmuxTmpdir?: string } = { team: teamName };
      if (tmuxTmpdir !== undefined) opts.tmuxTmpdir = tmuxTmpdir;
      const r = detectClassB(opts);
      if (r !== null) findings.push(r);
    }
    if (sessionExists && (args.classFilter === "c" || args.classFilter === "all")) {
      findings.push(...detectClassC({ team: teamName, windows }));
    }
    if (sessionExists && (args.classFilter === "d" || args.classFilter === "all")) {
      findings.push(...detectClassD({ team: teamName, windows }));
    }
  }

  if (args.classFilter === "e" || args.classFilter === "all") {
    const teamForRow = team !== null ? team.name : "";
    const registered =
      deps.classEDeps?.registeredTmpdirs ?? (await loadRegisteredTmpdirs(deps.loadCockpitFn));
    const eOpts: { team: string } & ClassEDeps = {
      team: teamForRow,
      registeredTmpdirs: registered,
    };
    if (deps.classEDeps?.tmpRoot !== undefined) eOpts.tmpRoot = deps.classEDeps.tmpRoot;
    if (deps.classEDeps?.listDir !== undefined) eOpts.listDir = deps.classEDeps.listDir;
    if (deps.classEDeps?.hasLiveSocket !== undefined)
      eOpts.hasLiveSocket = deps.classEDeps.hasLiveSocket;
    findings.push(...(await detectClassE(eOpts)));
  }

  // Class F is a stub — no findings emitted.
  return findings;
}

export function buildTmuxConfig(
  team: { name: string; tmuxTmpdir?: unknown },
  socketOverride?: string,
): TmuxConfig {
  if (socketOverride !== undefined && socketOverride.length > 0) {
    return { socketPath: socketOverride };
  }
  return {
    socketPath: resolveTeamSocket({
      name: team.name,
      tmuxTmpdir: typeof team.tmuxTmpdir === "string" ? team.tmuxTmpdir : undefined,
    }),
  };
}

// ---------- Verb entry ----------

export interface AuditDeps extends RunAuditDeps {
  stdout?: Writer;
  stderr?: Writer;
}

export async function audit(argv: ReadonlyArray<string>, deps: AuditDeps = {}): Promise<number> {
  const args = parseAuditArgs(argv);
  const findings = await runAllChecks(args, deps);
  const stdout = deps.stdout ?? defaultStdoutWrite;
  if (args.quiet) {
    return findings.length === 0 ? 0 : 1;
  }
  const out = args.json ? renderJson(findings) : renderHuman(findings);
  stdout(out);
  return 0;
}
