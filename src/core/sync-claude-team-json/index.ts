// Orchestrator for `atmux sync claude-team-json` — ADR-164 §"Behavior".
//
// Two entry points:
//   - computeMappedTeam (T3+T4): pure compute — read inputs, map roster,
//     merge briefs. No side effects. Used by --dry-run (T6) and as the
//     first half of the write path.
//   - writeSync (T5, t-c2b757c1): compute → detect drift → emit warning +
//     log event → abort or proceed → atomic write of `.claude/team.json`
//     with a fresh `_atmuxSync` marker. Implements ADR-164 §Behavior
//     steps 5 + 7 + §"File shape after sync" + §OQ-1 + §OQ-5.

import { join } from "node:path";
import { atomicWrite, readTextOrNull } from "../../abstractions/fs.ts";
import type { ResolveDirOpts } from "../common.ts";
import { getAtmuxDir, tryLoadTeam } from "../common.ts";
import type { Writer } from "../io.ts";
import { defaultStderrWrite } from "../io.ts";
import {
  DriftAbortError,
  type DriftDetection,
  detectDrift,
  driftWarning,
  logSyncEvent,
  nextMarker,
  SYNC_MARKER_KEY,
  type SyncEvent,
} from "./drift.ts";
import { mapRoster, mergeBriefs } from "./mapping.ts";
import type { ClaudeTeam, ClaudeTeamMember, ColorSidecar } from "./types.ts";

/** Repo-root resolution: by default the orchestrator reads `.claude/...`
 *  files relative to `process.cwd()`. Tests + future callers may pin a
 *  different root via `claudeDir`. The atmux-side `.atmux/team.json` is
 *  read via the existing `ResolveDirOpts` chain in `tryLoadTeam`. */
export interface ComputeOpts extends ResolveDirOpts {
  /** Override the directory used to locate `.claude/team.json` +
   *  `.claude/team-colors.json`. Defaults to `<cwd>/.claude`. */
  claudeDir?: string;
  /** Brief-preservation override per ADR-164 §"Behavior" step 6 + §OQ-4.
   *  Default false → preserve non-empty Claude-side `role` text. True →
   *  replace every member's `role` with the atmux-side role-enum. */
  overwriteBriefs?: boolean;
}

export interface ComputeResult {
  /** Parsed prior Claude-side file, or null when none existed on disk.
   *  T4 (brief preservation) reads this; T3 returns it untouched so
   *  downstream layers can diff against it. */
  prior: ClaudeTeam | null;
  /** Newly computed mapped roster (no brief-preservation merge yet —
   *  that's T4). The top-level `name` + `description` are propagated
   *  from the atmux-side team. */
  computed: {
    name: string;
    description: string | undefined;
    members: ClaudeTeamMember[];
  };
  /** Resolved sidecar (if present). Pass-through for downstream layers. */
  sidecar: ColorSidecar | null;
}

function claudeDirOf(opts: ComputeOpts): string {
  return opts.claudeDir ?? join(process.cwd(), ".claude");
}

/** Parse a loose JSON file at `path`. Returns null when absent.
 *  Throws SyntaxError on malformed JSON — callers surface this as a
 *  user-facing error rather than swallow it. ADR-164 §Behavior step 2
 *  says "parse loosely (no schema validation)" — that is no Zod, not no
 *  JSON-level validation. */
async function readLooseJson<T>(path: string): Promise<T | null> {
  const text = await readTextOrNull(path);
  if (text === null) return null;
  return JSON.parse(text) as T;
}

/** Read all three inputs + compute the mapped roster. T4-T6 layer write,
 *  brief-preservation, drift-detection, and dry-run on top. */
export async function computeMappedTeam(opts: ComputeOpts = {}): Promise<ComputeResult> {
  const team = await tryLoadTeam(opts);
  if (team === null) {
    throw new Error("atmux sync claude-team-json: no .atmux/team.json — run 'atmux init' first");
  }
  const dir = claudeDirOf(opts);
  const prior = await readLooseJson<ClaudeTeam>(join(dir, "team.json"));
  const sidecar = await readLooseJson<ColorSidecar>(join(dir, "team-colors.json"));
  const mapped = mapRoster(team.members, sidecar);
  const members = mergeBriefs(prior, mapped, team.members, {
    overwriteBriefs: opts.overwriteBriefs ?? false,
  });
  return {
    prior,
    computed: {
      name: team.name,
      description: team.description,
      members,
    },
    sidecar,
  };
}

/** Options for {@link writeSync}. Composes {@link ComputeOpts} so callers
 *  pass one shape; adds the T5-specific `force` flag + a `stderr` sink for
 *  the drift warning + a `now` injection point for deterministic marker
 *  timestamps. */
export interface WriteSyncOpts extends ComputeOpts {
  /** Override drift abort per ADR-164 §OQ-5. When true, drift is logged as
   *  `drift-forced` and the write proceeds anyway. Default false → abort
   *  with {@link DriftAbortError}. */
  force?: boolean;
  /** Stderr sink for the drift warning. Defaults to `process.stderr`. */
  stderr?: Writer;
  /** Injection point for marker `lastSyncedAt`. Tests pin a fixed value;
   *  production paths omit + take the wall clock. */
  now?: () => Date;
}

export interface WriteSyncResult {
  /** Path that was written (the `.claude/team.json` resolved from opts). */
  path: string;
  /** True when drift was observed AND `--force` overrode it. False on the
   *  clean path (no prior marker, or marker matched). */
  forced: boolean;
}

/** Apply the sync to disk. Composes:
 *    1. computeMappedTeam (compute the mapped roster from inputs)
 *    2. detectDrift on the prior file vs its stored fingerprint
 *    3. on drift: emit one-line stderr warning + log SyncEvent
 *       - without `force`: throw DriftAbortError (caller exits 65)
 *       - with `force`: log action=drift-forced and proceed
 *    4. compose write payload — prior's unknown top-level fields PRESERVED,
 *       `name`/`description`/`members` REPLACED with computed values, and
 *       `_atmuxSync` stamped with a fresh fingerprint of the post-sync
 *       member roster (per ADR-164 §"File shape after sync" + §OQ-1).
 *    5. atomic write + log action=synced.
 *
 *  The atomic write goes through `abstractions/fs.atomicWrite` (mktemp +
 *  rename) so partial-write races leave the prior file untouched. */
export async function writeSync(opts: WriteSyncOpts = {}): Promise<WriteSyncResult> {
  const { prior, computed } = await computeMappedTeam(opts);
  const stderr = opts.stderr ?? defaultStderrWrite;
  const atmuxDir = await getAtmuxDir(opts);

  const drift = detectDrift(prior);
  let forced = false;
  if (drift !== null) {
    stderr(`${driftWarning(drift)}\n`);
    if (opts.force === true) {
      await logSyncEvent(atmuxDir, buildEvent("drift-forced", drift, opts.now));
      forced = true;
    } else {
      await logSyncEvent(atmuxDir, buildEvent("drift-abort", drift, opts.now));
      throw new DriftAbortError(drift);
    }
  }

  const path = join(claudeDirOf(opts), "team.json");
  const payload = composeWritePayload(prior, computed, opts.now);
  await atomicWrite(path, `${JSON.stringify(payload, null, 2)}\n`);
  await logSyncEvent(atmuxDir, buildEvent("synced", undefined, opts.now));
  return { path, forced };
}

/** Merge prior unknown top-level fields with the freshly-computed
 *  `name`/`description`/`members` + a fresh `_atmuxSync` marker. The
 *  marker's fingerprint covers the POST-sync roster per ADR-164 §"File
 *  shape after sync" — so the next run reads the file, recomputes the
 *  same fingerprint, and matches (no drift) unless the file was touched
 *  in between. */
function composeWritePayload(
  prior: ClaudeTeam | null,
  computed: ComputeResult["computed"],
  now: WriteSyncOpts["now"],
): ClaudeTeam {
  const ts = (now ?? defaultNow)().toISOString();
  const marker = nextMarker(computed.members, ts);
  const base: ClaudeTeam = prior !== null ? { ...prior } : {};
  base.name = computed.name;
  if (computed.description !== undefined) {
    base.description = computed.description;
  } else {
    delete base.description;
  }
  base.members = computed.members;
  base[SYNC_MARKER_KEY] = marker;
  return base;
}

function buildEvent(
  action: SyncEvent["action"],
  detection: DriftDetection | undefined,
  now: WriteSyncOpts["now"],
): SyncEvent {
  const ts = (now ?? defaultNow)().toISOString();
  const event: SyncEvent = {
    ts,
    verb: "sync.claude-team-json",
    action,
  };
  if (detection !== undefined) event.detection = detection;
  return event;
}

function defaultNow(): Date {
  return new Date();
}
