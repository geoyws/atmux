import { dirname, join } from "node:path";
import { exists, removeFile, statOrNull, writeText } from "../../abstractions/fs.ts";
import { tryReadJson } from "../../abstractions/json.ts";
import { createTmux } from "../../abstractions/tmux.ts";
import { resolveCageSessionName } from "../../core/cockpit.ts";
import {
  buildWindowName,
  kanbanJsonPath,
  resolveTeamSocket,
  tryLoadTeam,
} from "../../core/common.ts";
import { loadInbox } from "../../core/inbox.ts";
import { listTasks } from "../../core/kanban.ts";
import { externalKanbanEnabled } from "../../core/kanban-backend.ts";
import { findPhantomInProgressClaims } from "../../core/phantom-prune.ts";
import { Kanban } from "../../schema/kanban.ts";
import type { Team } from "../../schema/team.ts";
import type { DoctorRow } from "./types.ts";

// ---------- Check 4b: nested-state-db (e-39 item 4; t-a20da986) ----------

/** One orphaned nested-state artefact: a `.atmux` dir nested inside the
 *  team's own `.atmux/`, or a stub `state.db` outside the canonical
 *  `<atmuxDir>/state.db`. `rel` is relative to `atmuxDir`. */
export interface NestedStateOffender {
  rel: string;
  kind: "nested-atmux-dir" | "stub-state-db";
}

/** Depth cap for the subtree walk — worktree stubs sit 2-3 levels down
 *  (`.atmux/worktrees/<m>/.atmux`); deeper trees are operator data. */
const NESTED_SCAN_MAX_DEPTH = 4;

/** Scan `atmuxDir` for nested-state orphans (t-62/t-63 class). Green-path
 *  returns [] — T3 (t-b7c55f07) measured zero orphans 2026-09-23, so the
 *  check is a guard, not a migration. Pure readdir walk; no DB opens. */
export async function findNestedStateDb(atmuxDir: string): Promise<NestedStateOffender[]> {
  const { readdir } = await import("node:fs/promises");
  const out: NestedStateOffender[] = [];
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > NESTED_SCAN_MAX_DEPTH) return;
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      // Quarantine zone written by archiveNestedStateDb — archived
      // orphans are contained, not live; never re-report them.
      if (rel === "" && name === "archives") continue;
      const childRel = rel === "" ? name : `${rel}/${name}`;
      if (name === ".atmux" && rel !== "") {
        out.push({ rel: childRel, kind: "nested-atmux-dir" });
        continue; // do not descend into the nested dir itself
      }
      if (name === "state.db" && rel !== "") {
        out.push({ rel: childRel, kind: "stub-state-db" });
        continue;
      }
      if (name === "state.db" && rel === "") continue; // canonical DB
      const st = await statOrNull(join(dir, name));
      if (st !== null && st.isDirectory === true) await walk(join(dir, name), childRel, depth + 1);
    }
  };
  await walk(atmuxDir, "", 0);
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

export async function checkNestedStateDb(atmuxDir: string): Promise<DoctorRow[]> {
  const offenders = await findNestedStateDb(atmuxDir);
  if (offenders.length === 0) return [];
  const sample = offenders
    .slice(0, 3)
    .map((o) => o.rel)
    .join(", ");
  const more = offenders.length > 3 ? ` (+${offenders.length - 3} more)` : "";
  return [
    {
      status: "red",
      label: "nested-state-db",
      detail: `${offenders.length} nested-state orphan(s) under ${atmuxDir}: ${sample}${more}`,
      hint: "atmux doctor --fix archives them under <atmuxDir>/archives/nested-state-db-<ts>/ (t-62/t-63 class)",
    },
  ];
}

/** Archive every offender under `<atmuxDir>/archives/nested-state-db-<ts>/`,
 *  preserving relative paths. Returns archived rel paths. Uses node:fs
 *  rename directly (abstractions/fs.ts has no move primitive). */
export async function archiveNestedStateDb(
  atmuxDir: string,
  offenders: ReadonlyArray<NestedStateOffender>,
  nowMs = Date.now(),
): Promise<string[]> {
  const { rename, mkdir } = await import("node:fs/promises");
  const dest = join(atmuxDir, "archives", `nested-state-db-${nowMs}`);
  await mkdir(dest, { recursive: true });
  const archived: string[] = [];
  for (const o of offenders) {
    const src = join(atmuxDir, o.rel);
    const dst = join(dest, o.rel);
    await mkdir(join(dest, o.rel.split("/").slice(0, -1).join("/")), { recursive: true }).catch(
      () => {},
    );
    await rename(src, dst);
    archived.push(o.rel);
  }
  return archived;
}

// ---------- Check 4: state-dir ----------

export async function checkStateDir(atmuxDir: string): Promise<DoctorRow[]> {
  const s = await statOrNull(atmuxDir);
  if (s === null) {
    // Not yet created — check parent writability.
    const parent = atmuxDir.endsWith("/.atmux") ? atmuxDir.slice(0, -7) : atmuxDir;
    const parentStat = await statOrNull(parent);
    if (parentStat !== null) {
      return [
        {
          status: "yellow",
          label: "state-dir",
          detail: `not yet created at ${atmuxDir}`,
          hint: "will be created on init/start",
        },
      ];
    }
    return [
      {
        status: "red",
        label: "state-dir",
        detail: `parent ${parent} does not exist`,
        hint: "chown or pick a different cwd",
      },
    ];
  }
  // Probe writability via a temp marker file write, then clean it up so the
  // final fs state matches bash's `[[ -w ]]` check (lib/doctor.sh:208) which
  // leaves no artefact. Without the cleanup the parity harness sees a
  // `.doctor-write-probe` file present in TS but absent in bash and flags an
  // fs-channel divergence (ADR-030 commit-B probe finding).
  const probe = join(atmuxDir, ".doctor-write-probe");
  try {
    await writeText(probe, "");
    return [{ status: "green", label: "state-dir", detail: `writable at ${atmuxDir}` }];
  } catch {
    return [
      {
        status: "red",
        label: "state-dir",
        detail: `${atmuxDir} exists but is not writable`,
        hint: `chown -R $USER ${atmuxDir}`,
      },
    ];
  } finally {
    await removeFile(probe).catch(() => {});
  }
}

// ---------- Check 6: phantom-inboxes ----------

/** Per-member, find inbox.inProgress entries whose IDs aren't in
 *  kanban.tasks[]. These are "phantoms" — claim/done sequences that
 *  failed mid-write or kanban entries deleted out from under the
 *  inbox. Bash equivalent: atmux::find_phantom_inbox_ids. */
export interface PhantomEntry {
  member: string;
  id: string;
  subject: string;
}

export async function findPhantomInboxes(atmuxDir: string): Promise<PhantomEntry[]> {
  const stateDb = join(atmuxDir, "state.db");
  // Malformed team.json → SchemaError out of tryLoadTeam. checkTeam already
  // surfaces the red row; phantom-inbox scan has no team roster to walk, so
  // treat unparseable identically to absent (return []). Without this catch,
  // `atmux doctor` crashes on a malformed team.json instead of emitting red.
  let team: Awaited<ReturnType<typeof tryLoadTeam>>;
  try {
    team = await tryLoadTeam({ dir: atmuxDir });
  } catch {
    return [];
  }
  if (team === null) return [];

  const liveIds = new Set<string>();
  if ((await externalKanbanEnabled(atmuxDir)) || (await exists(stateDb))) {
    for (const task of await listTasks(atmuxDir)) liveIds.add(task.id);
  } else {
    const kanban = await tryReadJson(kanbanJsonPath(atmuxDir), Kanban);
    if (kanban === null) return [];
    for (const t of kanban.tasks) liveIds.add(t.id);
  }

  const phantoms: PhantomEntry[] = [];
  for (const m of team.members) {
    const inbox = await loadInbox(atmuxDir, m.name);
    for (const e of inbox.inProgress) {
      if (!liveIds.has(e.id)) {
        phantoms.push({ member: m.name, id: e.id, subject: e.subject ?? "" });
      }
    }
  }
  return phantoms;
}

/** Legacy ADR-076 JSON inbox files on SQL-canonical teams mislead tools
 *  that read the path directly. Surface for `atmux cleanup inboxes --purge-legacy`. */
export async function findLegacyInboxJson(atmuxDir: string): Promise<string[]> {
  const stateDb = join(atmuxDir, "state.db");
  if (!(await exists(stateDb))) return [];
  const ibDir = join(atmuxDir, "inboxes");
  if (!(await exists(ibDir))) return [];
  const { readdir } = await import("node:fs/promises");
  const names: string[] = [];
  for (const name of await readdir(ibDir).catch(() => [] as string[])) {
    if (name.endsWith(".json")) names.push(name);
  }
  return names.sort();
}

export async function checkLegacyInboxJson(atmuxDir: string): Promise<DoctorRow[]> {
  const files = await findLegacyInboxJson(atmuxDir);
  if (files.length === 0) return [];
  const sample = files.slice(0, 3).join(", ");
  const more = files.length > 3 ? ` (+${files.length - 3} more)` : "";
  return [
    {
      status: "yellow",
      label: "legacy-inbox-json",
      detail: `${files.length} stale .atmux/inboxes/*.json file(s) on SQL-canonical team (e.g. ${sample}${more})`,
      hint: "atmux cleanup inboxes --purge-legacy  (canonical inbox is state.db tasks + `atmux inbox <member>`)",
    },
  ];
}

export async function checkPhantomInboxes(atmuxDir: string): Promise<DoctorRow[]> {
  const phantoms = await findPhantomInboxes(atmuxDir);
  return phantoms.map((p) => ({
    status: "yellow" as const,
    label: "phantom-inbox",
    detail: `${p.member} inbox.inProgress contains phantom ${p.id} ("${p.subject}")`,
    hint: "atmux doctor --fix prunes; whip auto-prune sweep also handles in-flight",
  }));
}

// ---------- Check 6b: phantom in-progress claims (t-af159454) ----------

/** Resolve the set of member names with a live tmux window in the
 *  team's cage. Returns an empty set on session-down / probe failure
 *  — caller treats that as "no live members", which means ALL
 *  in-progress claims get flagged as phantoms. Conservative bias
 *  matches the auto-prune use case (operator wants the stale rows
 *  surfaced loudly so the next session boot is clean).
 *
 *  Cage-only — singleSession teams short-circuit at the caller per
 *  ADR-026 (the deprecated mode isn't the prune target). */
export async function probeLiveMembers(team: Team, atmuxDir: string): Promise<ReadonlySet<string>> {
  try {
    const tmux = createTmux({ socketPath: resolveTeamSocket(team) });
    const session = await resolveCageSessionName({ name: team.name, root: dirname(atmuxDir) });
    if (!(await tmux.session.hasSession(session))) return new Set();
    const windows = await tmux.window.listWindows(session);
    const liveNames = new Set(windows.map((w) => w.name));
    const live = new Set<string>();
    for (const m of team.members) {
      // ADR-161 TR2: thread member.role so the expected name picks up
      // `_-prefix` for default members (team-lead / planner / reviewer
      // / ombudsman).
      const expected = buildWindowName(m.name, m.emoji, m.label, m.role);
      if (liveNames.has(expected)) live.add(m.name);
    }
    return live;
  } catch {
    return new Set();
  }
}

/** Doctor check: surface kanban in-progress rows whose owner has no
 *  live tmux window in the cage. These are the rows `atmux doctor
 *  --fix` and `atmux stop` prune. */
export async function checkPhantomInProgressClaims(
  atmuxDir: string,
  team: Team | null,
): Promise<DoctorRow[]> {
  if (team === null) return [];
  if (team.singleSession === true) return [];
  const phantoms = await findPhantomInProgressClaims({
    atmuxDir,
    team,
    liveMembers: () => probeLiveMembers(team, atmuxDir),
  });
  return phantoms.map((p) => ({
    status: "yellow" as const,
    label: "phantom-in-progress",
    detail: `${p.id} ("${p.subject}") owned by ${p.owner} but no live pane`,
    hint: "atmux doctor --fix flips it to blocked; atmux stop teardown does the same",
  }));
}
