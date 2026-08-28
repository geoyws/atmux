// The environment the test runner is allowed to have (ADR-283).
//
// ADR-282 stopped tests from *collecting* the whole environment. That was
// necessary and it is not sufficient, because it is a rule about the shape
// of code, and code has unbounded shapes. Measured 2026-08-28 over an
// enumeration of 21 whole-environment-capture shapes, ADR-282's own
// matcher caught 9 — missing, among others, `Bun.spawnSync({ cmd:
// ["env"], stdout: "pipe" })`, the idiomatic TypeScript route, which the
// very file that guard protects already uses for other commands.
//
// This module is the defence that does not depend on recognising code.
// The operator's `.zshrc` sources a git-crypt'd `.env` into every shell,
// including the one that runs `bun test`, so the runner's environment
// carries live API tokens, database passwords and webhook URLs. Remove
// them from the runner's environment and **no test can leak them,
// whatever shape it uses** — that is a property of the environment, not a
// property of a regex, so there is nothing to evade.
//
// Two layers, and they cover different things:
//
//   1. `scripts/test.ts` (the wall). Builds the child environment from
//      the allowlist below and execs `bun test` with it. The denied
//      variables are never in the runner process at all.
//   2. `tests/helpers/test-env-guard.ts` (the tripwire). A bunfig preload,
//      so it runs however `bun test` was invoked. It REFUSES when the
//      runner's own environment still carries credential-shaped names —
//      it does not scrub, because it cannot: see "Why the preload cannot
//      be the wall" below.
//
// Why the preload cannot be the wall
// ----------------------------------
// Measured on bun 1.3.14, 2026-08-28: `Bun.spawn`/`Bun.spawnSync` called
// WITHOUT an explicit `env` do not read the live `process.env` — they use
// the environment as it stood when the process started. A variable set
// after startup does not reach such a child, and, decisively, a variable
// `delete`d after startup STILL DOES. So a preload that deleted secrets
// from `process.env` would leave `Bun.spawnSync({ cmd: ["env"] })` —
// exactly the shape that defeats ADR-282's matcher — still dumping them.
// Only an environment that never had them holds under that.

/**
 * Variable names the suites, the runtime, or the OS legitimately need.
 *
 * Derived from every `process.env.<NAME>` read across `src/`, `tests/`,
 * `scripts/` and `bin/` (2026-08-28), plus the shell/OS minimum a spawned
 * `bun` and the tools the tests shell out to require.
 */
export const TEST_ENV_ALLOW_EXACT: ReadonlySet<string> = new Set([
  // Process and filesystem basics. `HOME` is load-bearing: git reads
  // ~/.gitconfig through it, and several suites redirect it per-test.
  "HOME",
  "LOGNAME",
  "OLDPWD",
  "PATH",
  "PWD",
  "SHELL",
  "SHLVL",
  "TMP",
  "TMPDIR",
  "TEMP",
  "USER",
  // Locale and time. `TZ` matters — scripts/lint-tz.ts exists because
  // timestamp formatting is asserted.
  "LANG",
  "LANGUAGE",
  "TZ",
  // Terminal capability. `NO_COLOR`, `COLORTERM` and `TERM` are three of
  // the four names ADR-277/281 assert on (the fourth, `TMUX`, is below);
  // `FORCE_COLOR` and `TERMINFO` ride along as the other two knobs a
  // terminal-rendering test could reasonably need. None can carry a
  // secret — they are capability flags, not identity.
  "COLORTERM",
  "FORCE_COLOR",
  "NO_COLOR",
  "TERM",
  "TERMINFO",
  // tmux addressing. `TMUX` in particular must survive, because
  // sandbox-guard.ts refuses a cage-socket test run by reading it.
  "TMUX",
  "TMUX_PANE",
  "TMUX_TMPDIR",
  // XDG paths (src/ reads XDG_DATA_HOME).
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_STATE_HOME",
  // CI detection.
  "CI",
  // macOS sets this in every shell; harmless, and its absence makes
  // some system tools chatty on stderr.
  "__CF_USER_TEXT_ENCODING",
  // Capability probe read by tests/ (a boolean, not a credential).
  "MINIMAX_CLI_AVAILABLE",
]);

/**
 * Name prefixes that are allowed wholesale.
 *
 * Every one of these is a namespace this repository owns or configures,
 * so a variable inside it is either read by the code under test or set by
 * a test itself. They are still filtered by {@link CREDENTIAL_NAME_RE} —
 * `ATMUX_VOX_TOKEN` and `ATMUX_DISCORD_WEBHOOK` are real credentials that
 * live inside an allowed prefix, which is exactly why the second pass
 * exists.
 */
export const TEST_ENV_ALLOW_PREFIXES: ReadonlyArray<string> = Object.freeze([
  "ATMUX_",
  "BUN_",
  "KANBAN_",
  "LC_",
]);

/**
 * Names whose value must not reach the runner even when an allowed
 * prefix admits them.
 *
 * **Two classes, because one rule cannot serve both.** The long words are
 * matched as substrings — nothing benign is called `…PASSWORD…`, and
 * substring matching is what catches `PGPASSWD`, where the token is not
 * on a `_` boundary at all. The short ones (`KEY`, `PAT`, `AUTH`) are
 * matched only as whole `_`-delimited segments, because a bare-substring
 * version of exactly this pattern lived in `tests/helpers/env-dump.ts`
 * until 2026-08-28 and matched `PATH` (via `PAT`), `MONKEY` and
 * `COMPATIBILITY` (via `KEY`). Redacting `PATH` in a projection is how a
 * filter earns being switched off.
 *
 * `AUTH(?:ORIZATION)?` rather than a substring `AUTH` for the same
 * reason: `GIT_AUTHOR_NAME` must not match, and `AUTHORIZATION` must.
 *
 * Matched against the NAME only. The value is never inspected, so this
 * cannot itself become a disclosure path.
 *
 * This is **not** the wall — {@link TEST_ENV_ALLOW_EXACT} and
 * {@link TEST_ENV_ALLOW_PREFIXES} are. A name pattern is a guess about
 * what a secret is called and will always be incomplete: `DATABASE_URL`
 * carries a password and matches nothing here. It is excluded by the
 * allowlist instead, which is the point of ordering them this way.
 */
export const CREDENTIAL_NAME_RE =
  /(?:PASSWORD|PASSWD|PASSPHRASE|SECRET|TOKEN|WEBHOOK|CREDENTIALS?|APIKEY|SIGNATURE)|(?:^|_)(?:KEYS?|AUTH(?:ORIZATION)?|PAT)(?:_|$)/i;

/** Comma-separated names to admit despite the rules above. Read from the
 *  UNSCRUBBED environment by `scripts/test.ts`; every admitted name is
 *  echoed to stderr, so this can never be a silent widening. */
export const TEST_ENV_PASSTHROUGH_VAR = "ATMUX_TEST_ENV_PASSTHROUGH";

/**
 * Set to `1` when this environment has been vetted — either by
 * `scripts/test.ts`, which sets it after scrubbing, or by hand by someone
 * who accepts running the suite against live credentials. The preload
 * tripwire refuses otherwise.
 *
 * Same shape and same reasoning as `ATMUX_CAGE_TEST_OK` in
 * `sandbox-guard.ts`: a guard whose only bypass is a deliberate,
 * documented export.
 */
export const TEST_ENV_OK_VAR = "ATMUX_TEST_ENV_OK";

/** A name shaped like a shell variable — anything else is not a variable
 *  and is dropped rather than reasoned about. */
const VALID_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Does the allowlist admit `name`, before the credential filter? */
export function isAllowedTestEnvName(name: string): boolean {
  if (TEST_ENV_ALLOW_EXACT.has(name)) return true;
  return TEST_ENV_ALLOW_PREFIXES.some((p) => name.startsWith(p));
}

/** Parse the passthrough list. Invalid names are dropped, not thrown on:
 *  a typo in an escape hatch should not stop the suite from running. */
export function parsePassthrough(raw: string | undefined): string[] {
  if (raw === undefined || raw.length === 0) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => VALID_NAME_RE.test(s));
}

export interface ScrubbedTestEnv {
  /** The environment to hand the runner. */
  env: Record<string, string>;
  /** How many names survived. */
  keptCount: number;
  /** How many names were dropped. NAMES ARE NEVER RETURNED — a count is
   *  enough to see the filter working, and a list is one `console.log`
   *  away from the disclosure this whole module exists to prevent. */
  removedCount: number;
  /** Names admitted only because the escape hatch named them. Returned
   *  so the caller can print a receipt; deliberately the one case where
   *  names ARE surfaced, because an unlogged escape hatch is a hole. */
  passedThrough: string[];
}

/**
 * Project `source` down to what a test runner may see.
 *
 * Two passes, in this order and for this reason: the allowlist decides
 * (structural — a name it does not know is gone whatever it is called),
 * then the credential filter removes what an allowed *prefix* let in
 * (hygiene within a namespace we own).
 */
export function scrubTestEnv(
  source: Readonly<Record<string, string | undefined>>,
  passthrough: ReadonlyArray<string> = [],
): ScrubbedTestEnv {
  const extra = new Set(passthrough);
  const env: Record<string, string> = {};
  const passedThrough: string[] = [];
  let removedCount = 0;

  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!VALID_NAME_RE.test(name)) {
      removedCount++;
      continue;
    }
    if (extra.has(name)) {
      env[name] = value;
      passedThrough.push(name);
      continue;
    }
    if (!isAllowedTestEnvName(name) || CREDENTIAL_NAME_RE.test(name)) {
      removedCount++;
      continue;
    }
    env[name] = value;
  }

  return {
    env,
    keptCount: Object.keys(env).length,
    removedCount,
    passedThrough: passedThrough.sort(),
  };
}

/**
 * How many names in `source` are credential-shaped — the tripwire's
 * question. Returns a COUNT, never the names, for the reason in
 * {@link ScrubbedTestEnv.removedCount}.
 */
export function countCredentialShapedNames(
  source: Readonly<Record<string, string | undefined>>,
): number {
  let n = 0;
  for (const name of Object.keys(source)) {
    if (CREDENTIAL_NAME_RE.test(name)) n++;
  }
  return n;
}
