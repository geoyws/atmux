// SUNSET(v0.9.1): ADR-274 D2/D3 `ATMUX_VOICE_*` → `ATMUX_VOX_*` fallback —
// delete after v0.9.1 ships (ADR-266 §D1). Deleting this file and inlining
// `env.ATMUX_VOX_<SUFFIX>` at every `readVoxEnv` callsite is the whole
// removal; nothing else depends on it.
//
// WHY A FALLBACK AND NOT A CLEAN BREAK (ADR-274 D2).
//
// `ATMUX_VOICE_TOKEN` is committed to the operator's git-crypt'd dotfiles
// with a `keys/KEYS.md` pointer row, referenced by `~/.atmux/vox-launch.sh`,
// and already exported in whatever shells happen to be open. Without a
// fallback the first launch after the rename lands dies with
// `ATMUX_VOX_TOKEN is required` — an error whose text contains nothing
// connecting it to a rename the operator agreed to days earlier. A
// silent-to-the-cause startup failure is strictly worse than a deprecation
// warning, which is the entire argument ADR-266 exists to make.
//
// PRECEDENCE (ADR-274 D2, final paragraph). `ATMUX_VOX_*` always wins. When
// the legacy name is ALSO set we warn about it, and we say so louder when
// the two values DIFFER — a stale value shadowing a fresh one is the
// failure mode that wastes the most time, because everything looks
// configured and the wrong value is the one in play.

/** Canonical prefix (ADR-274 D1). */
export const VOX_ENV_PREFIX = "ATMUX_VOX_";

/** SUNSET(v0.9.1): the pre-ADR-274 prefix, still read as a fallback. */
export const LEGACY_VOX_ENV_PREFIX = "ATMUX_VOICE_";

/** Where a deprecation notice goes. Injected in tests; stderr in prod. */
export type VoxEnvWarn = (message: string) => void;

/**
 * Process-lifetime dedupe. `resolveVoxConfig` runs more than once per
 * process (boot, `--status`, the supervise re-exec path), and a warning
 * repeated four times reads as four problems.
 */
const warnedMessages = new Set<string>();

/** Default sink: stderr, at most once per distinct message per process. */
export function warnVoxEnvOnce(message: string): void {
  if (warnedMessages.has(message)) return;
  warnedMessages.add(message);
  process.stderr.write(`${message}\n`);
}

/** Test seam — clears the once-per-process dedupe. */
export function resetVoxEnvWarnings(): void {
  warnedMessages.clear();
}

/** An env var counts as SET only when present and non-empty — the same
 *  reading `resolveString` / `resolveOptionalString` already use, so an
 *  exported-but-empty legacy var cannot shadow anything. */
function present(raw: string | undefined): raw is string {
  return raw !== undefined && raw !== "";
}

/**
 * Read `ATMUX_VOX_<suffix>`, falling back to `ATMUX_VOICE_<suffix>`.
 *
 * @param suffix bare knob name, e.g. `"TOKEN"` — no prefix.
 * @returns the resolved value, or `undefined` when neither name is set.
 */
export function readVoxEnv(
  env: NodeJS.ProcessEnv,
  suffix: string,
  warn: VoxEnvWarn = warnVoxEnvOnce,
): string | undefined {
  const freshName = `${VOX_ENV_PREFIX}${suffix}`;
  const legacyName = `${LEGACY_VOX_ENV_PREFIX}${suffix}`;
  const fresh = env[freshName];
  const legacy = env[legacyName];

  // SECRETS: every message below names VARIABLES and never interpolates a
  // VALUE. `ATMUX_VOX_TOKEN` and the provider keys come through this
  // function, `warn` writes to stderr, and `atmux vox --supervise` runs
  // inside a tmux pane whose scrollback is captured. "Both differ" is
  // exactly the moment it is tempting to print both values; don't.
  if (present(fresh)) {
    if (present(legacy)) {
      warn(
        legacy === fresh
          ? `vox: both ${freshName} and ${legacyName} are set — using ${freshName}. Unset the deprecated ${legacyName} (ADR-274; removed in v0.9.1).`
          : `vox: both ${freshName} and ${legacyName} are set with DIFFERENT values — using ${freshName} and IGNORING the stale ${legacyName}. Unset it (ADR-274; removed in v0.9.1).`,
      );
    }
    return fresh;
  }

  if (present(legacy)) {
    warn(
      `vox: ${legacyName} is deprecated — rename it to ${freshName} (ADR-274). Still honoured, removed in v0.9.1.`,
    );
    return legacy;
  }

  return undefined;
}
