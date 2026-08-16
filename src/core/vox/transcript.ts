// ADR-272 OQ-4 (resolved 2026-08-15, implemented here) — voice
// transcript retention.
//
// WHAT THIS IS. A transcript is the one voice artifact that turns a
// conversation into a DURABLE RECORD of everything said near the
// operator's microphone. OQ-4 resolved where such a record may live and
// for how long; until this module, nothing implemented it — the ADR
// recorded a decision and owed the code at P7. Clearing
// `ATMUX_VOX_READONLY` without it would mean the mutating surface goes
// live before the rule about recording what the operator says exists in
// code. Hence: a P7 PREREQUISITE, not a P7 feature.
//
// THE FIVE PROPERTIES, each straight out of the resolved OQ-4 text:
//
//   1. LOCATION — `~/.atmux/vox-logs/`. atmux's own state directory,
//      which is not a managed product repo, so ADR-268 holds BY
//      CONSTRUCTION rather than by a rule someone has to remember. There
//      is deliberately NO env override for the directory: an override is
//      exactly how a transcript ends up inside a product checkout where
//      `git add -A` sweeps it up, or on a synced/network path where
//      "local-only" quietly becomes "local-first". The only seam is
//      in-process (`dir`), which tests use and no operator can set.
//
//   2. RETENTION — 7 days, pruned at server start and daily thereafter.
//      Shortest window that still answers "what did I say that made it
//      do that?" the morning after. `ATMUX_VOX_TRANSCRIPT_RETENTION_DAYS`
//      lets the operator SHORTEN it (OQ-4 grants that explicitly).
//
//   3. OFF BY DEFAULT — writing requires `ATMUX_VOX_TRANSCRIPTS=1`.
//      OQ-4 calls off-by-default-with-explicit-opt-in the safest posture
//      and leaves shipping them on as "its own decision to argue"; this
//      does not argue it. The operator chooses to be recorded.
//      PRUNING, by contrast, runs unconditionally — it only ever
//      DELETES, so turning recording off must not leave yesterday's
//      transcripts on disk forever.
//
//   4. LOCAL-ONLY, never local-first. Nothing here ships, syncs,
//      forwards, or uploads. One `appendFileSync` to one path under
//      `$HOME`, mode 0600 in a 0700 directory.
//
//   5. NO SECRETS. A line carries a timestamp, the session id, the role,
//      and the speech. It never carries the voice token, an API key, or
//      a tool argument — the sink's input type has no field they could
//      arrive in. (`src/core/vox/log.ts` is the STDERR sink and carries
//      the opposite payload: protocol events, no speech. The two are
//      disjoint on purpose.)
//
// FINALS ONLY. Providers emit incremental transcript deltas; recording
// each one would write the same sentence a dozen times in pieces and turn
// a per-utterance append into a per-frame one. `final: true` closes an
// utterance id (see `VoiceEvent.transcript`), so finals are the complete
// record with none of the churn — the session layer enforces this and its
// test pins it.
//
// LAZY FILE CREATION. The file appears on the first recorded line, not at
// session open, so a session in which nobody spoke leaves nothing behind.
// One less recording is always the safer default here.

import { appendFileSync, mkdirSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Transcript directory, relative to `$HOME` (ADR-272 OQ-4 §Location). */
export const VOX_TRANSCRIPT_DIR_REL = ".atmux/vox-logs";

/** OQ-4 §Retention. Operators may shorten; lengthening wants a reason. */
export const DEFAULT_TRANSCRIPT_RETENTION_DAYS = 7;

/** Prune cadence after the boot pass — OQ-4's "daily thereafter". */
export const TRANSCRIPT_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** File-name affixes. The session id sits between them. */
export const TRANSCRIPT_FILE_PREFIX = "vox-";
export const TRANSCRIPT_FILE_SUFFIX = ".jsonl";

/**
 * The ONLY names the pruner will delete.
 *
 * A retention sweep runs `rm` inside a directory under the operator's
 * `$HOME`. A blind glob there is one typo away from deleting something
 * that was never ours, so the pruner matches this exact shape — the same
 * shape {@link transcriptFileName} produces, and nothing else. A
 * hand-dropped `notes.md`, an editor backup, or a subdirectory in the
 * same folder is left strictly alone however old it is.
 */
export const TRANSCRIPT_FILE_RE = /^vox-[A-Za-z0-9_-]+\.jsonl$/;

/** Directory mode: owner-only. Speech is not world-readable. */
const TRANSCRIPT_DIR_MODE = 0o700;
/** File mode: owner-only, same reasoning. */
const TRANSCRIPT_FILE_MODE = 0o600;

/** Max session-id characters kept in a file name (ids are uuidv7-sized;
 *  the cap bounds a pathological one rather than trusting the caller). */
const MAX_ID_CHARS = 64;

/** Fallback stem when a session id sanitizes to nothing. */
const FALLBACK_ID = "session";

/**
 * Resolve `~/.atmux/vox-logs`. `$HOME` first (the value every other
 * atmux state path resolves against), `os.homedir()` as the fallback.
 * No env override for the directory itself — see property 1.
 */
export function resolveTranscriptDir(opts: { env?: NodeJS.ProcessEnv } = {}): string {
  const env = opts.env ?? process.env;
  const home = env.HOME !== undefined && env.HOME !== "" ? env.HOME : homedir();
  return join(home, VOX_TRANSCRIPT_DIR_REL);
}

/**
 * `vox-<sanitized-session-id>.jsonl`.
 *
 * Sanitizing is not paranoia about the id source (it is `uuidv7()`); it
 * is what makes the file name a CLOSED shape. Every character outside
 * `[A-Za-z0-9_-]` — `/`, `.`, `..`, a NUL, a space — becomes `_`, so the
 * result can never escape the directory and always matches
 * {@link TRANSCRIPT_FILE_RE}, which is what the pruner keys on. A name
 * the pruner cannot recognise is a file that never ages out.
 */
export function transcriptFileName(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, MAX_ID_CHARS);
  const stem = cleaned.length > 0 ? cleaned : FALLBACK_ID;
  return `${TRANSCRIPT_FILE_PREFIX}${stem}${TRANSCRIPT_FILE_SUFFIX}`;
}

/** One recorded utterance. Speech and its role — nothing else exists on
 *  this type, which is how a tool argument or a token cannot arrive. */
export interface VoxTranscriptEvent {
  role: "user" | "assistant";
  text: string;
}

/** One JSONL row as written. */
export interface TranscriptLine extends VoxTranscriptEvent {
  /** Epoch ms (from the injected clock). */
  ts: number;
  /** ISO-8601 UTC, for reading without a converter. */
  iso: string;
  /** Session id — so concatenated files stay attributable. */
  session: string;
}

/** Per-session transcript sink. `record` NEVER throws. */
export interface VoxTranscriptSink {
  /** Absolute path this sink appends to (created on first record). */
  readonly path: string;
  /** Append one utterance. A write failure is logged once, then silent. */
  record(ev: VoxTranscriptEvent): void;
}

export interface CreateTranscriptSinkOpts {
  sessionId: string;
  /** Directory to write into — {@link resolveTranscriptDir} in production. */
  dir: string;
  /** Epoch-ms clock (injected; fake in tests). Defaults to `Date.now`. */
  clock?: () => number;
  /** Diagnostics sink for the one write-failure line. Defaults to no-op. */
  log?: (line: string) => void;
  /** Byte-append seam. Default creates the dir 0700 and appends 0600. */
  append?: (path: string, text: string) => void;
}

/** Production append: `mkdir -p` (0700) then a synchronous append (0600).
 *  Synchronous for the same reason `appendOrchdPushAuditRow` is — the row
 *  is complete when the call returns, so a crash cannot lose a line that
 *  a queued async write would still be holding. */
function defaultAppend(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: TRANSCRIPT_DIR_MODE });
  appendFileSync(path, text, { encoding: "utf8", mode: TRANSCRIPT_FILE_MODE });
}

/**
 * Build a per-session transcript sink. One file per session, the session
 * id in the name (ADR-272 OQ-4).
 *
 * A write failure — full disk, a read-only `$HOME`, a permission change
 * mid-session — must NEVER reach the caller: this runs inside the
 * provider-event pump, and a throw there would take down a live call to
 * protect a log file. The first failure emits one diagnostic line; later
 * failures are silent (a failing disk would otherwise write a line per
 * utterance) while writes keep being attempted, so a transient fault
 * self-heals.
 */
export function createTranscriptSink(opts: CreateTranscriptSinkOpts): VoxTranscriptSink {
  const clock = opts.clock ?? ((): number => Date.now());
  const log = opts.log ?? ((): void => {});
  const append = opts.append ?? defaultAppend;
  const path = join(opts.dir, transcriptFileName(opts.sessionId));
  let failureLogged = false;
  return {
    path,
    record(ev: VoxTranscriptEvent): void {
      const ts = clock();
      const line: TranscriptLine = {
        ts,
        iso: new Date(ts).toISOString(),
        session: opts.sessionId,
        role: ev.role,
        text: ev.text,
      };
      try {
        append(path, `${JSON.stringify(line)}\n`);
      } catch (e) {
        // expected: a log write must not kill the call it is logging
        if (!failureLogged) {
          failureLogged = true;
          log(`vox: transcript write failed — ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    },
  };
}

// ---------- Retention sweep ----------

/** Filesystem seam for the pruner (injected in tests, defaulted here). */
export interface TranscriptFs {
  /** Directory entries. Throws ENOENT-shaped errors when absent. */
  list(dir: string): Promise<Array<{ name: string; isFile: boolean }>>;
  /** Modification time in epoch ms, or null when the file vanished. */
  mtimeMs(path: string): Promise<number | null>;
  remove(path: string): Promise<void>;
}

function isEnoent(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT";
}

/** Real filesystem implementation of {@link TranscriptFs}. */
export const nodeTranscriptFs: TranscriptFs = {
  async list(dir: string): Promise<Array<{ name: string; isFile: boolean }>> {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, isFile: e.isFile() }));
  },
  async mtimeMs(path: string): Promise<number | null> {
    try {
      return (await stat(path)).mtimeMs;
    } catch (e) {
      if (isEnoent(e)) return null; // expected: raced with another sweep
      throw e;
    }
  },
  async remove(path: string): Promise<void> {
    await rm(path, { force: true });
  },
};

export interface PruneTranscriptsOpts {
  dir: string;
  /** Files older than this are removed. */
  retentionMs: number;
  /** Epoch-ms clock (injected; fake in tests). */
  now: () => number;
  fs?: TranscriptFs;
}

export interface PruneTranscriptsResult {
  /** Files deleted. */
  removed: number;
  /** Matching files left in place (inside the window). */
  kept: number;
  /** Entries skipped because the name is not ours — never touched. */
  skipped: number;
  /** Per-file (or whole-directory) failures. Reported, never thrown. */
  errors: number;
}

/**
 * Delete transcripts older than `retentionMs`. ADR-272 OQ-4 §Retention.
 *
 * **Never throws.** The server calls this at boot and once a day; a
 * retention sweep that could take the voice server down — because `$HOME`
 * is read-only, or one file is owned by root — would trade a private log
 * file for the operator's whole voice interface. Every failure is counted
 * and returned; the caller logs the count.
 *
 * **Never deletes what it does not own.** Directory entries are filtered
 * to regular files whose name matches {@link TRANSCRIPT_FILE_RE} before
 * an age is even read. A missing directory is normal (nothing has been
 * recorded yet) and is not an error.
 *
 * The boundary is `age > retentionMs`: a file exactly `retentionMs` old
 * is INSIDE the window and survives. "7-day retention" means seven full
 * days are kept, not six and a bit.
 */
export async function pruneTranscripts(
  opts: PruneTranscriptsOpts,
): Promise<PruneTranscriptsResult> {
  const fs = opts.fs ?? nodeTranscriptFs;
  const result: PruneTranscriptsResult = { removed: 0, kept: 0, skipped: 0, errors: 0 };
  let entries: Array<{ name: string; isFile: boolean }>;
  try {
    entries = await fs.list(opts.dir);
  } catch (e) {
    // expected: no directory yet = nothing recorded yet, not a fault
    if (!isEnoent(e)) result.errors += 1;
    return result;
  }
  const now = opts.now();
  for (const entry of entries) {
    if (!entry.isFile || !TRANSCRIPT_FILE_RE.test(entry.name)) {
      result.skipped += 1;
      continue;
    }
    const path = join(opts.dir, entry.name);
    try {
      const mtime = await fs.mtimeMs(path);
      if (mtime === null) continue; // vanished under us — nothing to do
      if (now - mtime > opts.retentionMs) {
        await fs.remove(path);
        result.removed += 1;
      } else {
        result.kept += 1;
      }
    } catch {
      // expected: one unreadable/undeletable file must not stop the sweep
      result.errors += 1;
    }
  }
  return result;
}

/** Render a sweep result as the one line the server logs. */
export function formatPruneResult(dir: string, r: PruneTranscriptsResult): string {
  return `vox: transcript prune ${dir} — removed ${r.removed}, kept ${r.kept}, skipped ${r.skipped}, errors ${r.errors}`;
}

/** Days → ms, for the retention knob. */
export function retentionMsForDays(days: number): number {
  return days * 24 * 60 * 60 * 1000;
}

export interface TranscriptPruneLoopOpts {
  /** Timer seam (the session's `VoxTimers`; fake in tests). */
  timers: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
  /** One sweep. Expected not to throw; a throw is still survived. */
  run: () => Promise<void>;
  intervalMs?: number;
}

/**
 * Arm OQ-4's "daily thereafter" sweep. Returns a `stop()` the serve path
 * calls in its `finally`, so a stopped server leaves no armed timer
 * behind (a 24h timer would otherwise hold the event loop open).
 *
 * Re-arms AFTER each sweep rather than on a fixed interval, so a slow
 * sweep can never stack a second one on top of itself.
 */
export function startTranscriptPruneLoop(opts: TranscriptPruneLoopOpts): () => void {
  const intervalMs = opts.intervalMs ?? TRANSCRIPT_PRUNE_INTERVAL_MS;
  let handle: unknown = null;
  let stopped = false;
  const arm = (): void => {
    handle = opts.timers.setTimeout(() => {
      handle = null;
      void tick();
    }, intervalMs);
  };
  const tick = async (): Promise<void> => {
    try {
      await opts.run();
    } catch {
      // expected: pruneTranscripts never throws — belt and braces, so a
      // future caller's bug cannot silently stop the daily sweep
    }
    if (!stopped) arm();
  };
  arm();
  return (): void => {
    stopped = true;
    if (handle !== null) {
      opts.timers.clearTimeout(handle);
      handle = null;
    }
  };
}
