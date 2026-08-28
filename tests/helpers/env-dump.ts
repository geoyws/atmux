// Safe environment probing for tests (ADR-282).
//
// A test that runs `env` and redirects the WHOLE dump into a file, reads
// that file, and asserts on the string is a credential-disclosure bug
// waiting for its first red run: `expect(received)` prints `received` in
// full, and this operator's runner environment carries live API tokens,
// database and docs passwords, and Discord webhook URLs. That happened on
// 2026-08-28 — ~180 variables with their values went into a test log and
// an agent transcript.
//
// The fix is NOT "filter before asserting". Filtering after the fact still
// pulls every secret into the test process, one careless `expect(raw)`
// away from print. **Never collect what must not be printed.** So:
//
//   1. `dumpEnvCommand()` builds a pane command that greps the allowlist
//      INSIDE the probe, so the file on disk only ever holds four names.
//   2. `parseEnvDump()` filters again on the way in and redacts anything
//      whose NAME looks like a credential — the seatbelt, not the brake.
//   3. `tests/regression/no-unfiltered-env-dump.test.ts` fails the suite
//      if any file under `src/` or `tests/` reintroduces the raw form.
//
// Route every environment probe through here. If you need a variable the
// allowlist does not carry, add it to the `vars` argument at the call
// site — that keeps the widening visible in the test that wanted it,
// rather than silently widening every probe in the repo.

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
 * Variable NAMES whose values must never reach an assertion, however the
 * dump was produced. Matched case-insensitively against the name only —
 * the value is never inspected, so this cannot itself leak by matching.
 *
 * Defence in depth behind `ENV_DUMP_ALLOWLIST`: the allowlist is what
 * actually keeps secrets out of the test process; this catches a call
 * site that widened `vars` without thinking it through.
 */
export const SENSITIVE_NAME_RE = /(TOKEN|SECRET|KEY|PASSWORD|PASSWD|PAT|WEBHOOK|CREDENTIAL|AUTH)/i;

/** What `parseEnvDump` substitutes for a sensitive-looking value. */
export const REDACTED = "<redacted>";

/** A variable name safe to splice into both a shell command and an ERE. */
const SAFE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
 * @throws if `outPath` contains a quote (it is spliced into a shell word)
 *         or any name is not a plain identifier (it is spliced into an ERE).
 */
export function dumpEnvCommand(
  outPath: string,
  vars: ReadonlyArray<string> = ENV_DUMP_ALLOWLIST,
  keepAliveSeconds = 3,
): string {
  if (/['"]/.test(outPath)) {
    throw new Error(`dumpEnvCommand: outPath must not contain quotes: ${outPath}`);
  }
  if (vars.length === 0) {
    throw new Error("dumpEnvCommand: refusing to build a dump with an empty allowlist");
  }
  for (const name of vars) {
    if (!SAFE_NAME_RE.test(name)) {
      throw new Error(`dumpEnvCommand: not a plain variable name: ${name}`);
    }
  }
  const filter = `env | grep -E "^(${vars.join("|")})=" > ${outPath} || true`;
  return `sh -c '${filter}; sleep ${keepAliveSeconds}'`;
}

/**
 * Project a dump down to `vars`, redacting any surviving credential-shaped
 * name. Assert against THIS, never the raw file contents.
 *
 * Filtering by NAME preserves every assertion's meaning exactly: a
 * variable that is present still appears here, so "absent from the
 * projection" and "absent from the dump" are the same statement for the
 * names in `vars`.
 */
export function parseEnvDump(
  dump: string,
  vars: ReadonlyArray<string> = ENV_DUMP_ALLOWLIST,
): string {
  const wanted = new Set(vars);
  const kept: string[] = [];
  for (const line of dump.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const name = line.slice(0, eq);
    if (!wanted.has(name)) continue;
    kept.push(SENSITIVE_NAME_RE.test(name) ? `${name}=${REDACTED}` : line);
  }
  return kept.join("\n");
}
