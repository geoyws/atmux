// ADR-020: shared output-sink abstraction.
//
// Lifts the previously-duplicated `defaultStdoutWrite` /
// `defaultStderrWrite` from per-verb files (rotate, handoff, doctor,
// cost, report, dashboard, init, start, add-member) so there is one
// canonical sink and one canonical type for the `*Opts.stdout` /
// `*Opts.stderr` injection pattern.
//
// `Writer` matches `process.stdout.write`'s shape with the return
// value relaxed to `void` — no caller branches on the drain-hint
// `boolean`, and `boolean` widens to `void` so existing
// `process.stdout.write.bind(process.stdout)` call-sites keep working
// without ceremony.

/** A line-sink for verbs. Matches the contract of `process.stdout.write`
 *  with the drain-hint return relaxed to `void` (no caller branches on
 *  it). Tests pass `(s) => buf += s` style stubs. */
export type Writer = (s: string) => void;

/** Standard verb-IO injection shape. Verbs whose `*Opts` interface
 *  needs output redirection should compose this in (or include the
 *  same field shape — Bun's structural typing accepts either). */
export interface IoSinks {
  stdout?: Writer;
  stderr?: Writer;
}

/** Default stdout sink — `process.stdout.write` passthrough. The
 *  `boolean` return is widened to `void` per `Writer`'s contract; no
 *  caller branches on it. */
export function defaultStdoutWrite(s: string): boolean {
  return process.stdout.write(s);
}

/** Default stderr sink — `process.stderr.write` passthrough. */
export function defaultStderrWrite(s: string): boolean {
  return process.stderr.write(s);
}
