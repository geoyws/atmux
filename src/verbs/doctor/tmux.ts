import { existsSync as fsExistsSync } from "node:fs";
import type { SpawnResult } from "../../abstractions/spawn.ts";
import { type DoctorRow, defaultTmuxSpawn, type TmuxSpawn } from "./types.ts";

// ---------- ADR-162 §Decision-anchor #5: tmux infrastructure probes ----------

/** Lowest tmux version atmux is tested against. Below → yellow.
 *  Per ADR-162 §Part C. */

export const TMUX_MIN_VERSION = "3.2";

/** Highest tmux version atmux is tested against. Above → yellow.
 *  Per ADR-162 §Part C. ADR-138's send-keys verifier contract is
 *  validated against this version on hax. */

export const TMUX_TESTED_VERSION = "3.6a";

/** Parsed tmux version. `suffix` is the optional trailing alphabetic
 *  letter (e.g. `"a"` in `tmux 3.6a`); empty string when absent. */

export interface ParsedTmuxVersion {
  major: number;
  minor: number;
  suffix: string;
}

/**
 * Parse `tmux -V` stdout into a structured version. tmux prints lines
 * like `tmux 3.6a` (release) or `tmux next-3.7` (pre-release); also
 * `tmux master` for source builds. Returns `null` when the line can't
 * be parsed — caller treats that as a "warn-unknown" finding.
 */

export function parseTmuxVersion(stdout: string): ParsedTmuxVersion | null {
  const trimmed = stdout.trim();
  // Strict: `tmux <major>.<minor>[<suffix>]` on a single line. Skips
  // pre-release / source-build outputs so we surface them as
  // unparseable rather than guess.
  const m = trimmed.match(/^tmux (\d+)\.(\d+)([a-z]?)$/);
  if (m === null) return null;
  const major = Number.parseInt(m[1] ?? "", 10);
  const minor = Number.parseInt(m[2] ?? "", 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  return { major, minor, suffix: m[3] ?? "" };
}

/** Compare two `ParsedTmuxVersion`s. Returns -1 / 0 / +1 with
 *  major → minor → suffix precedence. Suffix is compared
 *  lexicographically (`"" < "a" < "b" < …`). */

export function compareTmuxVersion(a: ParsedTmuxVersion, b: ParsedTmuxVersion): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.suffix === b.suffix) return 0;
  return a.suffix < b.suffix ? -1 : 1;
}

export interface CheckTmuxVersionOpts {
  /** tmux spawn override. */
  tmux?: TmuxSpawn;
}

/**
 * ADR-162 §Decision-anchor #5 probe 1 — `tmux-version-mismatch`. Runs
 * `tmux -V`, parses output, and surfaces a yellow row when the host
 * tmux falls below {@link TMUX_MIN_VERSION} or above
 * {@link TMUX_TESTED_VERSION}. Both bounds are warn-class (non-
 * blocking); the canary surface motivates ADR-163's bundled-binary
 * v2 promotion.
 *
 * Unparseable output (`tmux next-3.7`, `tmux master`, missing tmux)
 * collapses to a yellow row with `actual: "unknown"` so the operator
 * still sees something instead of silent skip.
 */

export async function checkTmuxVersionMismatch(
  opts: CheckTmuxVersionOpts = {},
): Promise<DoctorRow[]> {
  const tmux = opts.tmux ?? defaultTmuxSpawn;
  const min = parseTmuxVersion(`tmux ${TMUX_MIN_VERSION}`);
  const tested = parseTmuxVersion(`tmux ${TMUX_TESTED_VERSION}`);
  if (min === null || tested === null) {
    // Defensive — the embedded constants must parse. If a maintainer
    // sets a malformed constant the probe surfaces it on every doctor
    // run rather than failing silently.
    return [
      {
        status: "yellow",
        label: "tmux-version-mismatch",
        detail: "internal — TMUX_MIN_VERSION / TMUX_TESTED_VERSION constant unparseable",
        hint: "report a bug; ADR-162 §Decision-anchor #5",
      },
    ];
  }
  let result: SpawnResult;
  try {
    result = await tmux(["-V"]);
  } catch {
    // Spawn miss / timeout — collapse to unknown. `checkDeps` already
    // covers the missing-binary case with a red row, so this branch is
    // largely defensive (PATH munged mid-run, etc.).
    return [
      {
        status: "yellow",
        label: "tmux-version-mismatch",
        detail: "tmux -V failed to run",
        hint:
          `host tmux not invokable; min ${TMUX_MIN_VERSION}, tested ${TMUX_TESTED_VERSION}. ` +
          "bundled tmux available via ADR-163.",
      },
    ];
  }
  if (result.exitCode !== 0) {
    return [
      {
        status: "yellow",
        label: "tmux-version-mismatch",
        detail: `tmux -V exited ${result.exitCode}`,
        hint:
          `host tmux not responding; min ${TMUX_MIN_VERSION}, tested ${TMUX_TESTED_VERSION}. ` +
          "bundled tmux available via ADR-163.",
      },
    ];
  }
  const parsed = parseTmuxVersion(result.stdout);
  if (parsed === null) {
    return [
      {
        status: "yellow",
        label: "tmux-version-mismatch",
        detail: `tmux -V output unparseable: ${result.stdout.trim().slice(0, 80)}`,
        hint:
          `ADR-138 verifier contract assumes 'tmux X.Y[a]' format; min ${TMUX_MIN_VERSION}, ` +
          `tested ${TMUX_TESTED_VERSION}. Report regressions to atmux issues.`,
      },
    ];
  }
  const actual = `${parsed.major}.${parsed.minor}${parsed.suffix}`;
  if (compareTmuxVersion(parsed, min) < 0) {
    return [
      {
        status: "yellow",
        label: "tmux-version-mismatch",
        detail: `host tmux ${actual} below minimum ${TMUX_MIN_VERSION}`,
        hint: "ADR-138 send-keys verifier may break; bundled tmux available via ADR-163.",
      },
    ];
  }
  if (compareTmuxVersion(parsed, tested) > 0) {
    return [
      {
        status: "yellow",
        label: "tmux-version-mismatch",
        detail: `host tmux ${actual} above tested ${TMUX_TESTED_VERSION}`,
        hint: "untested version; report regressions to atmux issues. Pin via ADR-163 bundled binary.",
      },
    ];
  }
  return [];
}

export interface CheckVendoredTmuxBinaryOpts {
  /** Filesystem probe override (test seam). */
  existsSync?: (path: string) => boolean;
  /** tmux spawn override — invoked with the resolved binary as `cmd`. */
  tmux?: TmuxSpawn;
  /** Override the path probed for the vendored binary. */
  vendoredPath?: string;
  /** Override the version we expect the vendored binary to report. */
  expectedVersion?: string;
}

/**
 * ADR-191 probe — `vendored-tmux-binary`. Two yellow rows possible:
 *
 *   1. `vendored-tmux-missing` — `/opt/atmux/current/bin/tmux` absent.
 *      Operators on dev builds (no `build:install` ever run) and
 *      pre-ADR-191 deploys both land here. Self-clearing after the
 *      build pipeline lands the binary.
 *   2. `vendored-tmux-version-drift` — vendored binary present but
 *      `tmux -V` against it doesn't match the ADR-191 pin (3.6a).
 *      Indicates an out-of-date install or a hand-staged binary.
 *
 * Both rows are warn-class; atmux falls through to system tmux via
 * `resolveTmuxBin()` so no behavior breaks. The probe gives the
 * operator a discoverable signal that the resolution chain is on the
 * fallback tier instead of the vendored tier.
 */

export async function checkVendoredTmuxBinary(
  opts: CheckVendoredTmuxBinaryOpts = {},
): Promise<DoctorRow[]> {
  const exists = opts.existsSync ?? fsExistsSync;
  const tmux = opts.tmux ?? defaultTmuxSpawn;
  const vendoredPath = opts.vendoredPath ?? "/opt/atmux/current/bin/tmux";
  const expected = opts.expectedVersion ?? TMUX_TESTED_VERSION;

  if (!exists(vendoredPath)) {
    return [
      {
        status: "yellow",
        label: "vendored-tmux-missing",
        detail: `${vendoredPath} not installed — resolveTmuxBin() falls through to system tmux`,
        hint:
          "ship the binary via `bun run build:install` (per ADR-191) or set " +
          "ATMUX_TMUX_BIN to silence the fallback warning.",
      },
    ];
  }

  // Vendored binary present. Run `tmux -V` against the resolved binary
  // (which is the vendored path when present) to confirm the pin.
  let result: SpawnResult;
  try {
    result = await tmux(["-V"]);
  } catch {
    return [
      {
        status: "yellow",
        label: "vendored-tmux-version-drift",
        detail: `${vendoredPath} present but \`tmux -V\` failed to run`,
        hint: `expected ${expected} per ADR-191; re-run build:install or check file mode.`,
      },
    ];
  }
  if (result.exitCode !== 0) {
    return [
      {
        status: "yellow",
        label: "vendored-tmux-version-drift",
        detail: `${vendoredPath} present but \`tmux -V\` exited ${result.exitCode}`,
        hint: `expected ${expected} per ADR-191; re-run build:install or check file mode.`,
      },
    ];
  }
  const parsed = parseTmuxVersion(result.stdout);
  if (parsed === null) {
    return [
      {
        status: "yellow",
        label: "vendored-tmux-version-drift",
        detail: `\`tmux -V\` output unparseable: ${result.stdout.trim().slice(0, 80)}`,
        hint: `expected ${expected} per ADR-191; report regressions to atmux issues.`,
      },
    ];
  }
  const actual = `${parsed.major}.${parsed.minor}${parsed.suffix}`;
  if (actual !== expected) {
    return [
      {
        status: "yellow",
        label: "vendored-tmux-version-drift",
        detail: `vendored tmux reports ${actual}, expected ${expected}`,
        hint:
          "re-run `bun run build:install` to retarget /opt/atmux/current at the pinned version " +
          "(ADR-191 §Decision).",
      },
    ];
  }
  return [];
}
