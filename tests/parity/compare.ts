// ADR-009: Test strategy — parity-run comparator.
//
// Takes two `ParityRun` captures (one bash, one TS) against the same
// fixture and verb invocation, and returns `Divergence[]`. Empty array
// = parity-green. Any non-empty array is a hard fail (no warning tier;
// no soft-divergence allowlist — see ADR-009 §3 "strict, no warning tier").
//
// Diff strategy per channel (ADR-009 §3):
//   - exit: byte-equal int, no coalescing of "both nonzero".
//   - stdout/stderr: byte-equal after masking only `\d{2}:\d{2} MYT`.
//   - fs: JSON via canonical form; non-JSON byte-equal after mask;
//         inbox files match by `(member, lineCount, lastMsgID)` tuple.
//   - discord: ordered-array semantic equality with `ts` masked.

import type { ChannelMask } from "./matrix.ts";
import type { DiscordCall, FsSnapshot, ParityRun } from "./runner.ts";

/**
 * Channels the comparator inspects. One divergence row per anomaly per
 * channel — multi-channel divergences emit multiple rows so triage can
 * see the full picture without re-running.
 */
export type DivergenceChannel = "stdout" | "stderr" | "exit" | "fs" | "discord";

/**
 * One observable difference between bash and TS runs.
 *
 * `bashSide` and `tsSide` carry the channel-specific representation:
 *   - exit:   `number`
 *   - stdout: `string` (post-mask)
 *   - stderr: `string` (post-mask)
 *   - fs:     `{ path: string, expected: unknown, actual: unknown }`
 *   - discord:`DiscordCall | DiscordCall[]` (one row per missing/extra/diff call)
 *
 * `detail` is human-readable — file path, json-pointer, byte offset, etc.
 */
export type Divergence = {
  verb: string;
  channel: DivergenceChannel;
  bashSide: unknown;
  tsSide: unknown;
  /** Human-readable diff: file path, json-pointer, masked byte range, ... */
  detail: string;
};

/**
 * Mask used by `compare`. The only timestamp shape masked is the
 * documented user-facing one (`HH:MM MYT`). Other timestamp shapes
 * (`HH:MM:SS`, ISO-8601 inside JSON, etc.) are NOT masked — they're
 * either internal (validate via schema) or signal real divergence.
 */
export const TIMESTAMP_MASK_REGEX = /\d{2}:\d{2} MYT/g;
export const TIMESTAMP_MASK_PLACEHOLDER = "HH:MM MYT";

/**
 * Apply the documented timestamp mask. Exported for unit-tested fairness
 * with `compare` itself.
 */
export function maskTimestamps(input: string): string {
  return input.replace(TIMESTAMP_MASK_REGEX, TIMESTAMP_MASK_PLACEHOLDER);
}

/**
 * Sentinel value substituted into parsed JSON when a `stateAfter` mask
 * matches. Identical on both sides so `canonicaliseJson` produces the
 * same byte-string post-elision. Distinct enough that a real verb
 * emitting this literal would be a wildly unusual divergence in itself.
 */
export const STATE_AFTER_MASKED_SENTINEL = "__ADR_027_MASKED__";

/**
 * Compare two `ParityRun` captures and return `Divergence[]`.
 *
 * Contract:
 *   - Empty array IFF every channel is byte-equal post-mask.
 *   - Non-empty array = hard fail. Caller `expect`s length === 0;
 *     bun:test reports the array as the failure detail.
 *   - Optional `mask` argument (ADR-027): per-row channel-mask config.
 *     Absent = existing exact comparison stands. Present = each channel
 *     branch consults its mask key:
 *       - `mask.exitCode === true` → skip exit-code branch entirely.
 *       - `mask.stdout` / `mask.stderr` → applied via `String.replace`
 *         on BOTH sides before timestamp mask + byte-equal.
 *       - `mask.stateAfter` → JSON-path glob → regex map applied
 *         symmetrically to parsed JSON in `fsState` before canonical diff.
 *
 * Per CLAUDE.md test-finding 5-element pattern, this function emits
 * #1 (state-snapshot) + #2 (containment) inline; the test harness owns
 * #3 (fix sketch via runtime context), #4 (residue), #5 (severity).
 */
export function compare(bash: ParityRun, ts: ParityRun, mask?: ChannelMask): Divergence[] {
  if (bash.verb !== ts.verb || bash.args.join(" ") !== ts.args.join(" ")) {
    // Sanity guard — caller wired the runner wrong.
    return [
      {
        verb: bash.verb,
        channel: "exit",
        bashSide: { verb: bash.verb, args: bash.args },
        tsSide: { verb: ts.verb, args: ts.args },
        detail: "compare: bash and ts ParityRun describe different invocations",
      },
    ];
  }

  const divergences: Divergence[] = [];

  // 1. exit code — strict byte-equal int, no coalescing. Skipped iff
  //    ADR-027 mask explicitly opts out (e.g. bash exit 1 vs TS exit 78).
  if (mask?.exitCode !== true && bash.exit !== ts.exit) {
    divergences.push({
      verb: bash.verb,
      channel: "exit",
      bashSide: bash.exit,
      tsSide: ts.exit,
      detail: `exit code differs: bash=${bash.exit} ts=${ts.exit}`,
    });
  }

  // 2. stdout — ADR-027 mask first (if any), then timestamp mask, then byte-equal.
  const bashStdout = maskTimestamps(applyChannelMask(bash.stdout, mask?.stdout));
  const tsStdout = maskTimestamps(applyChannelMask(ts.stdout, mask?.stdout));
  if (bashStdout !== tsStdout) {
    divergences.push({
      verb: bash.verb,
      channel: "stdout",
      bashSide: bashStdout,
      tsSide: tsStdout,
      detail: `stdout byte-mismatch (post-mask). bash=${bashStdout.length}b vs ts=${tsStdout.length}b`,
    });
  }

  // 3. stderr — same mask order. Reviewer rule §9.5 means stderr is contract.
  const bashStderr = maskTimestamps(applyChannelMask(bash.stderr, mask?.stderr));
  const tsStderr = maskTimestamps(applyChannelMask(ts.stderr, mask?.stderr));
  if (bashStderr !== tsStderr) {
    divergences.push({
      verb: bash.verb,
      channel: "stderr",
      bashSide: bashStderr,
      tsSide: tsStderr,
      detail: `stderr byte-mismatch (post-mask). bash=${bashStderr.length}b vs ts=${tsStderr.length}b`,
    });
  }

  // 4. fs state — per-path diff. JSON canonicalised (with optional ADR-027
  //    state-after mask elision), non-JSON masked.
  divergences.push(...diffFs(bash.verb, bash.fsState, ts.fsState, mask?.stateAfter));

  // 5. Discord calls — ordered, payload byte-equal after `ts` mask.
  divergences.push(...diffDiscord(bash.verb, bash.discordCalls, ts.discordCalls));

  return divergences;
}

/**
 * Per-path filesystem diff. JSON files compare via canonicalised JSON;
 * non-JSON files compare byte-exact after timestamp mask.
 *
 * Inbox files (matching `inboxes/<member>.{md,json}`) follow the
 * `(member, lineCount, lastMsgID)` tuple rule per ADR-009 §3 to allow
 * stable append-only ordering — Phase 2 expansion when inbox-emitting
 * verbs land. For Phase 1 (version verb), no inboxes exist so the rule
 * is unreachable; the regular byte-equal path applies.
 */
function diffFs(
  verb: string,
  bashFs: FsSnapshot,
  tsFs: FsSnapshot,
  stateAfterMasks?: Record<string, RegExp>,
): Divergence[] {
  const divergences: Divergence[] = [];
  const allPaths = new Set<string>([...Object.keys(bashFs), ...Object.keys(tsFs)]);
  const sortedPaths = [...allPaths].sort();

  for (const relPath of sortedPaths) {
    const b = bashFs[relPath];
    const t = tsFs[relPath];

    if (!b) {
      // ADR-057 §D7 R57-T7: TS-side `atmux done` writes
      // `.atmux/logs/auto-push.jsonl` audit entries. Bash done has no
      // auto-push step (bash port doesn't ship the feature). Treat the
      // TS-only artifact as expected divergence — same posture as
      // `.lock` files below.
      if (relPath === ".atmux/logs/auto-push.jsonl") continue;
      divergences.push({
        verb,
        channel: "fs",
        bashSide: null,
        tsSide: { path: relPath, present: true },
        detail: `fs: file present in ts but missing in bash: ${relPath}`,
      });
      continue;
    }
    if (!t) {
      divergences.push({
        verb,
        channel: "fs",
        bashSide: { path: relPath, present: true },
        tsSide: null,
        detail: `fs: file present in bash but missing in ts: ${relPath}`,
      });
      continue;
    }

    if (b.isJson && t.isJson && b.parsed !== undefined && t.parsed !== undefined) {
      const bElided = applyStateAfterMasks(b.parsed, relPath, stateAfterMasks);
      const tElided = applyStateAfterMasks(t.parsed, relPath, stateAfterMasks);
      const bCanon = canonicaliseJson(bElided);
      const tCanon = canonicaliseJson(tElided);
      if (bCanon !== tCanon) {
        divergences.push({
          verb,
          channel: "fs",
          bashSide: { path: relPath, parsed: b.parsed },
          tsSide: { path: relPath, parsed: t.parsed },
          detail: `fs: JSON content differs at ${relPath}`,
        });
      }
      continue;
    }

    // ADR-057 §D3b: TS-side lock files now carry the owner PID (`<pid>\n`);
    // bash-side leaves them empty. The PID itself is per-process metadata
    // — never load-bearing for the lock semantics (kernel flock is the
    // mutex). Treat all `*.lock` files as content-irrelevant on both
    // sides so the bash/TS divergence on PID content doesn't fail
    // parity. Path presence still matters (sidecar leak detection
    // continues via the missing-from-bash / missing-from-ts branches
    // above); we only neutralize the BYTE content.
    if (relPath.endsWith(".lock")) {
      // Both sides present + path matches: lock-file existence is
      // symmetric, content irrelevant. Skip byte-equal.
      continue;
    }

    // Non-JSON path: byte-equal after global timestamp mask + per-file
    // stateAfter content elision. ADR-028 commit 4: stateAfter for non-JSON
    // files matches the file's full basename as the glob stem (e.g.
    // `last-report.epoch.value` → matches file `state/last-report.epoch`,
    // path token `value` is a sentinel that elides the entire byte content
    // when the regex matches). Used for plain-text state files like the
    // report verb's `last-report.epoch` whose content is a Unix epoch
    // that drifts by one second across the parallel bash + TS spawn.
    const bMaskedRaw = maskTimestamps(decode(b.bytes));
    const tMaskedRaw = maskTimestamps(decode(t.bytes));
    const bMasked = applyNonJsonStateMask(bMaskedRaw, relPath, stateAfterMasks);
    const tMasked = applyNonJsonStateMask(tMaskedRaw, relPath, stateAfterMasks);
    if (bMasked !== tMasked) {
      divergences.push({
        verb,
        channel: "fs",
        bashSide: { path: relPath, content: bMasked },
        tsSide: { path: relPath, content: tMasked },
        detail: `fs: bytes differ (post-mask) at ${relPath}: bash=${bMasked.length}b vs ts=${tMasked.length}b`,
      });
    }
  }

  return divergences;
}

/**
 * Apply ADR-027 `mask.stdout` / `mask.stderr` config to a single channel
 * string. Pattern is fed straight to `String.replace(pattern, "")` —
 * non-global regex replaces first match only (anchored start-of-line
 * masks are common). Absent mask passes through unchanged.
 */
function applyChannelMask(input: string, pattern?: RegExp | string): string {
  if (pattern === undefined) return input;
  return input.replace(pattern as RegExp, "");
}

/**
 * Apply ADR-027 `mask.stateAfter` config to a parsed JSON value tied to
 * one fs-snapshot file. Glob shape is `<filename-stem>.<json-path>` —
 * filename-stem matches against the file's `path.basename` minus `.json`,
 * json-path navigates into the parsed value with `[*]` array wildcards.
 *
 * Matching string/number leaves are replaced with
 * `STATE_AFTER_MASKED_SENTINEL` on BOTH sides, so canonicaliseJson
 * produces byte-equal output post-elision.
 *
 * Globs whose filename-stem doesn't match the current file are no-ops;
 * globs whose path doesn't exist in the parsed value are no-ops; globs
 * whose terminal value doesn't match the regex leave the value untouched.
 */
function applyStateAfterMasks(
  parsed: unknown,
  relPath: string,
  masks?: Record<string, RegExp>,
): unknown {
  if (!masks) return parsed;
  // Filename stem: ".atmux/kanban.json" → "kanban"; "kanban.json" → "kanban"
  const base = relPath.split("/").pop() ?? relPath;
  const stem = base.endsWith(".json") ? base.slice(0, -".json".length) : base;
  let result = parsed;
  for (const [glob, regex] of Object.entries(masks)) {
    const dot = glob.indexOf(".");
    if (dot < 1) continue; // need at least `<stem>.<path>`
    const globStem = glob.slice(0, dot);
    if (globStem !== stem) continue;
    const tokens = parseStateAfterPath(glob.slice(dot + 1));
    if (tokens.length === 0) continue;
    result = elideAtPath(result, tokens, regex);
  }
  return result;
}

/**
 * Apply ADR-027 `stateAfter` mask to a non-JSON file's byte content
 * (post timestamp mask). For non-JSON files, the glob stem is matched
 * against the file's FULL basename (no `.json` strip) — e.g. glob
 * `last-report.epoch.value` matches file `state/last-report.epoch`.
 * The path tail (`.value`) is a sentinel — when present, the entire
 * content is replaced with `STATE_AFTER_MASKED_SENTINEL` if the regex
 * matches the trimmed content.
 *
 * Used by ADR-028 commit-4 report rows whose `last-report.epoch` writes
 * a Unix-epoch second that may differ across parallel bash + TS spawns.
 *
 * Globs whose terminal regex doesn't match the content leave the content
 * unchanged — same fail-open semantics as the JSON path.
 */
function applyNonJsonStateMask(
  content: string,
  relPath: string,
  masks?: Record<string, RegExp>,
): string {
  if (!masks) return content;
  const base = relPath.split("/").pop() ?? relPath;
  // Build candidate glob stems: full basename + the basename's prefix up
  // to each dot. So `last-report.epoch` matches stems `last-report.epoch`
  // (full) and `last-report` (pre-dot). This lets the same matcher cover
  // future plain-text files whose extension acts like `.json` (e.g.
  // `state/foo.txt` with stem `foo`).
  const stems = new Set<string>([base]);
  let i = base.indexOf(".");
  while (i > 0) {
    stems.add(base.slice(0, i));
    i = base.indexOf(".", i + 1);
  }
  for (const [glob, regex] of Object.entries(masks)) {
    const dot = glob.indexOf(".");
    if (dot < 1) continue;
    const globStem = glob.slice(0, dot);
    if (!stems.has(globStem)) continue;
    if (regex.test(content)) return STATE_AFTER_MASKED_SENTINEL;
  }
  return content;
}

type PathToken = { kind: "key"; name: string } | { kind: "wildcard" };

/**
 * Tokenise a state-after path like `tasks[*].id` into
 * `[{kind:"key",name:"tasks"},{kind:"wildcard"},{kind:"key",name:"id"}]`.
 * Returns empty array on malformed input.
 */
function parseStateAfterPath(s: string): PathToken[] {
  const tokens: PathToken[] = [];
  for (const seg of s.split(".")) {
    if (seg.length === 0) return [];
    const m = seg.match(/^([^[]+)(\[\*\])?$/);
    if (!m) return [];
    const name = m[1];
    const wildcard = m[2];
    if (name === undefined) return [];
    tokens.push({ kind: "key", name });
    if (wildcard !== undefined) tokens.push({ kind: "wildcard" });
  }
  return tokens;
}

/** Walk `tokens` into `value`; elide leaves whose stringified value matches `regex`. */
function elideAtPath(value: unknown, tokens: ReadonlyArray<PathToken>, regex: RegExp): unknown {
  if (tokens.length === 0) {
    if (typeof value === "string" && regex.test(value)) return STATE_AFTER_MASKED_SENTINEL;
    if (typeof value === "number" && regex.test(String(value))) return STATE_AFTER_MASKED_SENTINEL;
    return value;
  }
  const tok = tokens[0];
  if (tok === undefined) return value;
  const rest = tokens.slice(1);
  if (tok.kind === "wildcard") {
    if (!Array.isArray(value)) return value;
    return value.map((v) => elideAtPath(v, rest, regex));
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const obj = value as Record<string, unknown>;
  if (!(tok.name in obj)) return value;
  return { ...obj, [tok.name]: elideAtPath(obj[tok.name], rest, regex) };
}

/**
 * Ordered, payload-by-payload Discord-call diff. `ts` is masked away
 * before comparison (it's the only field expected to differ between
 * otherwise-identical bash and TS runs).
 */
function diffDiscord(
  verb: string,
  bashCalls: ReadonlyArray<DiscordCall>,
  tsCalls: ReadonlyArray<DiscordCall>,
): Divergence[] {
  const divergences: Divergence[] = [];
  const max = Math.max(bashCalls.length, tsCalls.length);

  for (let i = 0; i < max; i++) {
    const b = bashCalls[i];
    const t = tsCalls[i];

    if (!b) {
      divergences.push({
        verb,
        channel: "discord",
        bashSide: null,
        tsSide: t,
        detail: `discord[${i}]: extra ts call (bash emitted ${bashCalls.length}, ts emitted ${tsCalls.length})`,
      });
      continue;
    }
    if (!t) {
      divergences.push({
        verb,
        channel: "discord",
        bashSide: b,
        tsSide: null,
        detail: `discord[${i}]: missing ts call (bash emitted ${bashCalls.length}, ts emitted ${tsCalls.length})`,
      });
      continue;
    }

    const bPayload = canonicaliseJson(b.payload);
    const tPayload = canonicaliseJson(t.payload);
    if (bPayload !== tPayload) {
      divergences.push({
        verb,
        channel: "discord",
        bashSide: b,
        tsSide: t,
        detail: `discord[${i}]: payload differs (ts-masked)`,
      });
    }
  }

  return divergences;
}

/**
 * Stable-key JSON canonicaliser. Recursively sorts object keys so two
 * structurally-equal JSON values render to byte-equal strings regardless
 * of insertion order. Arrays preserve order (it's semantically meaningful
 * in atmux state — kanban rows, inbox lines).
 */
function canonicaliseJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicaliseJson(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicaliseJson(obj[k])}`).join(",")}}`;
}

/** UTF-8 decoder. Bytes that fail decode fall back to U+FFFD per Web spec. */
function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Compare a bash-side-only `ParityRun` against a checked-in golden snapshot.
 *
 * Used by ADR-028 golden-file harness mode for verbs whose TS port is
 * absent (e.g. `decisions`, `groom` — bash exists at the parent atmux's
 * `lib/`; worktree-bun's carve-out per ADR-022/026 omits them).
 *
 * Comparison shape:
 *   - Channel `stdout` only — bash side's `stdout`, post-mask, vs the
 *     golden file content. Returns 1 `Divergence` row on mismatch.
 *   - Caller (`index.test.ts`) handles capture mode (env-var
 *     `ATMUX_PARITY_UPDATE_GOLDENS=1`); when set, no comparison is run
 *     and the golden file is overwritten with the post-mask bash stdout.
 *
 * Auto-promotion path: when `src/verbs/<verb>.ts` lands, the matrix row
 * drops `bashOnly: true` and the comparator switches back to the
 * existing bash↔TS path. The golden file becomes redundant; can stay
 * as a historical baseline or be deleted in the same commit.
 *
 * Per-row mask runs FIRST (matching the bash↔TS comparator's order),
 * then global `\d{2}:\d{2} MYT` mask. Both sides of the comparison see
 * the same post-mask string. The golden file IS post-mask too — the
 * capture path also writes post-mask bytes so a re-capture in the same
 * harness yields the same golden (no infinite mask drift).
 */
export function compareGolden(
  bash: ParityRun,
  golden: string,
  mask?: ChannelMask,
): Divergence[] {
  const divergences: Divergence[] = [];
  const bashStdout = maskTimestamps(applyChannelMask(bash.stdout, mask?.stdout));
  if (bashStdout !== golden) {
    divergences.push({
      verb: bash.verb,
      channel: "stdout",
      bashSide: bashStdout,
      tsSide: golden,
      detail: `golden mismatch (post-mask). bash=${bashStdout.length}b vs golden=${golden.length}b`,
    });
  }
  return divergences;
}

/**
 * Apply both per-row + global timestamp masks to a stdout/stderr channel
 * — used by callers (notably `compareGolden`'s capture path in
 * `index.test.ts`) that need post-mask bytes to write to disk.
 *
 * Mirrors the channel-mask order applied inside `compare()` so capture
 * + comparison yield byte-equal output for an unchanged verb.
 */
export function maskChannel(input: string, pattern?: RegExp | string): string {
  return maskTimestamps(applyChannelMask(input, pattern));
}
