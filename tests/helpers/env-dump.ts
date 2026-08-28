// Safe environment probing for tests (ADR-282).
//
// A test that runs `env`, redirects the WHOLE dump into a file, reads that
// file, and asserts on the string is a credential-disclosure bug waiting
// for its first red run: `expect(received)` prints `received` in full, and
// this operator's shell environment carries live API tokens, database and
// docs passwords, and Discord webhook URLs. That happened on 2026-08-28 —
// ~180 variables with their values went into a test log and an agent
// transcript.
//
// The fix is NOT "filter before asserting". Filtering after the fact still
// pulls every secret into the test process, one careless `expect(raw)`
// away from print. **Never collect what must not be printed.** So:
//
//   1. `dumpEnvCommand()` builds a pane command that greps the allowlist
//      INSIDE the probe, so the file on disk only ever holds four names.
//      It refuses to build anything wider than `ENV_DUMP_MAX_VARS` names
//      or to name anything credential-shaped, so the sanctioned helper
//      cannot be talked into building a whole-environment dump.
//   2. `parseEnvDump()` filters again on the way in, redacts anything
//      whose NAME looks like a credential, redacts EVERY sighting of a
//      name it sees more than once, and refuses to emit an implausibly
//      long value — the seatbelt, not the brake.
//
// Route every environment probe through here. If you need a variable the
// allowlist does not carry, add it to the `vars` argument at the call
// site — that keeps the widening visible in the test that wanted it,
// rather than silently widening every probe in the repo.

/**
 * Names whose value must never reach an assertion, however the dump was
 * produced. Matched against the NAME only — the value is never
 * inspected, so this cannot itself become a disclosure path.
 *
 * **Two classes, because one rule cannot serve both.** The long words are
 * matched as substrings — nothing benign is called `…PASSWORD…`, and
 * substring matching is what catches `PGPASSWD`, where the token is not
 * on a `_` boundary at all. The short ones (`KEY`, `PAT`, `AUTH`) are
 * matched only as whole `_`-delimited segments, because the bare-substring
 * version of exactly this pattern lived here until 2026-08-28 and matched
 * `PATH` (via `PAT`), `MONKEY` and `COMPATIBILITY` (via `KEY`). Redacting
 * `PATH` in a projection is how a filter earns being switched off.
 *
 * `AUTH(?:ORIZATION)?` rather than a substring `AUTH` for the same
 * reason: `GIT_AUTHOR_NAME` must not match, and `AUTHORIZATION` must.
 *
 * This is **not** the wall — {@link ENV_DUMP_ALLOWLIST} is. A name
 * pattern is a guess about what a secret is called and will always be
 * incomplete: `DATABASE_URL` carries a password and matches nothing here.
 * It is excluded by the allowlist instead, which is the point of ordering
 * them this way.
 */
export const SENSITIVE_NAME_RE =
  /(?:PASSWORD|PASSWD|PASSPHRASE|SECRET|TOKEN|WEBHOOK|CREDENTIALS?|APIKEY|SIGNATURE)|(?:^|_)(?:KEYS?|AUTH(?:ORIZATION)?|PAT)(?:_|$)/i;

/**
 * The colour-environment variables the tmux scrub suites need
 * (ADR-277 / ADR-281), and the only ones any probe collects by default.
 *
 * None of these can carry a secret: they are terminal-capability flags
 * and a tmux socket/pane address.
 */
export const ENV_DUMP_ALLOWLIST: ReadonlyArray<string> = Object.freeze([
  "NO_COLOR",
  "COLORTERM",
  "TERM",
  "TMUX",
]);

/**
 * The most names a single probe may collect.
 *
 * Without a cap the sanctioned helper would happily build a
 * whole-environment dump from a wide enough `vars`. A probe that
 * genuinely needs more than this many variables is not a probe; it is
 * the dump this module exists to prevent.
 */
export const ENV_DUMP_MAX_VARS = 8;

/**
 * The longest value `parseEnvDump` will emit before redacting it.
 *
 * Every allowlisted name has a short value — `1`, `truecolor`,
 * `tmux-256color`, `/tmp/sock,1234,0`. A long one means the projection is
 * carrying something it did not mean to, most plausibly a multi-line
 * secret whose second line happens to start with an allowlisted name.
 */
export const ENV_DUMP_MAX_VALUE_LEN = 256;

/** What `parseEnvDump` substitutes for a value it will not emit. */
export const REDACTED = "<redacted>";

/** A variable name safe to splice into both a shell command and an ERE. */
const SAFE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * An `outPath` safe to splice into a shell word.
 *
 * Refusing quotes was not enough: the path is spliced into
 * `… > ${outPath} || true` inside a single-quoted `sh -c '…'`, next to
 * every other shell metacharacter. `;`, `&`, backtick, `$`, `(`, `)`,
 * `<`, `>`, `*`, `?`, whitespace and a newline are each as dangerous as
 * a quote there, and none of them was refused. An allowlist of the
 * characters a real temp path uses is the shape that cannot be
 * incomplete — every call site builds its path with `join(mkdtemp(…), …)`
 * and satisfies it.
 */
const SAFE_OUT_PATH_RE = /^[A-Za-z0-9_@:+=./-]+$/;

/**
 * Build the shell command for a probe pane that writes ONLY `vars` to
 * `outPath`.
 *
 * Returns a complete `sh -c '…'` string, shaped for tmux's
 * `[shell-command]` argument (`new-session` / `new-window` run it through
 * another `/bin/sh -c`, hence the single-quoted inner command).
 *
 * `|| true` is load-bearing, not defensive noise: `grep` exits 1 when
 * nothing matches, and "nothing matched" is a legitimate — indeed the
 * expected — result for the leg that asserts `NO_COLOR` is ABSENT. Without
 * it the probe pane exits non-zero and writes nothing, and the test times
 * out waiting for a file instead of asserting on an empty projection.
 *
 * The trailing `sleep` keeps the pane alive long enough for the caller to
 * read the file back; a pane whose command exits immediately can take the
 * session down with it before the read lands.
 *
 * @throws if `outPath` is not a plain filesystem path (it is spliced into
 *         a shell word), if any name is not a plain identifier (it is
 *         spliced into an ERE), if `vars` is empty or longer than
 *         {@link ENV_DUMP_MAX_VARS}, or if any name is credential-shaped.
 */
export function dumpEnvCommand(
  outPath: string,
  vars: ReadonlyArray<string> = ENV_DUMP_ALLOWLIST,
  keepAliveSeconds = 3,
): string {
  if (!SAFE_OUT_PATH_RE.test(outPath)) {
    throw new Error(
      `dumpEnvCommand: outPath must be a plain path matching ${String(SAFE_OUT_PATH_RE)}: ${outPath}`,
    );
  }
  if (vars.length === 0) {
    throw new Error("dumpEnvCommand: refusing to build a dump with an empty allowlist");
  }
  if (vars.length > ENV_DUMP_MAX_VARS) {
    throw new Error(
      `dumpEnvCommand: refusing to collect ${vars.length} variables (max ${ENV_DUMP_MAX_VARS}) — ` +
        "a probe that needs this many is a whole-environment dump wearing an allowlist",
    );
  }
  for (const name of vars) {
    if (!SAFE_NAME_RE.test(name)) {
      throw new Error(`dumpEnvCommand: not a plain variable name: ${name}`);
    }
    if (SENSITIVE_NAME_RE.test(name)) {
      throw new Error(`dumpEnvCommand: refusing to collect a credential-shaped name: ${name}`);
    }
  }
  const filter = `env | grep -E "^(${vars.join("|")})=" > ${outPath} || true`;
  return `sh -c '${filter}; sleep ${keepAliveSeconds}'`;
}

/**
 * Project a dump down to `vars`, redacting anything it will not vouch
 * for. Assert against THIS, never the raw file contents.
 *
 * Filtering by NAME preserves every assertion's meaning exactly: a
 * variable that is present still appears here, so "absent from the
 * projection" and "absent from the dump" are the same statement for the
 * names in `vars`.
 *
 * Three guards, because the line-oriented filter has a hole:
 *
 *   - a credential-shaped NAME is redacted;
 *   - a value longer than {@link ENV_DUMP_MAX_VALUE_LEN} is redacted;
 *   - a name seen MORE THAN ONCE has EVERY sighting redacted.
 *
 * The last two exist for the same fault. A variable whose value contains
 * a newline followed by `TERM=` produces a second line that looks exactly
 * like a legitimate `TERM` assignment, so the filter would keep it — and
 * that line is a FRAGMENT OF THE SECRET'S VALUE. A real environment
 * cannot contain a name twice, so a repeat is proof the split found
 * something that was never a variable boundary.
 *
 * **Every sighting, not just the repeat, and the difference is the whole
 * bug.** Keeping the first and redacting the rest is order-dependent, and
 * the order is chosen by the secret, not by us: the fragment lands FIRST
 * whenever the secret sorts before the name it collides with, which
 * `env(1)` output does not control. Given
 * `["TERM=<fragment>", "TERM=tmux-256color"]` a keep-the-first rule emits
 * the fragment verbatim and redacts the legitimate value — exactly
 * backwards. Once a name repeats, the boundary that produced BOTH lines is
 * proven fake, so neither line is trustworthy and neither is emitted.
 */
export function parseEnvDump(
  dump: string,
  vars: ReadonlyArray<string> = ENV_DUMP_ALLOWLIST,
): string {
  const wanted = new Set(vars);
  const lines: Array<{ name: string; value: string; line: string }> = [];
  const counts = new Map<string, number>();
  for (const line of dump.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const name = line.slice(0, eq);
    if (!wanted.has(name)) continue;
    lines.push({ name, value: line.slice(eq + 1), line });
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return lines
    .map(({ name, value, line }) => {
      const unsafe =
        (counts.get(name) ?? 0) > 1 ||
        SENSITIVE_NAME_RE.test(name) ||
        value.length > ENV_DUMP_MAX_VALUE_LEN;
      return unsafe ? `${name}=${REDACTED}` : line;
    })
    .join("\n");
}
