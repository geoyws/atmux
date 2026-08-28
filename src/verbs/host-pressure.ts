// ADR-273 §Supplement: `atmux host-pressure` — CPU / memory / disk
// headroom for every host the fleet runs on.
//
// The IO half. Probing, verdict-folding and rendering all live in
// `src/core/vox/host-report.ts` (pure, fixture-testable, and shared with
// the `host_pressure` voice tool); this file parses argv and prints.
//
// Read-only end to end: two /proc reads, a `grep -c`, and a `df` on each
// host. It writes nothing anywhere and loads neither box.

import {
  type HostReportEntry,
  probeHosts,
  renderHostReport,
  resolveHostProbeTimeoutMs,
  summarizeHostReport,
} from "../core/vox/host-report.ts";
import { UsageError } from "../errors.ts";

const USAGE = "atmux host-pressure [--host <name>] [--timeout-ms <n>] [--json]";

/** Parsed `host-pressure` argv. */
export interface HostPressureArgs {
  /** Restrict the report to one host by name. Undefined = every host. */
  host?: string;
  json: boolean;
  timeoutMs?: number;
}

/** Pure parser. Throws `UsageError` on bad invocation. */
export function parseHostPressureArgs(argv: ReadonlyArray<string>): HostPressureArgs {
  let host: string | undefined;
  let json = false;
  let timeoutMs: number | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--host") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "host-pressure: --host requires a value", hint: USAGE });
      }
      host = v;
      i += 2;
      continue;
    }
    if (a === "--timeout-ms") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "host-pressure: --timeout-ms requires a value", hint: USAGE });
      }
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) {
        throw new UsageError({
          what: `host-pressure: --timeout-ms must be a positive number, got ${JSON.stringify(v)}`,
          hint: USAGE,
        });
      }
      timeoutMs = n;
      i += 2;
      continue;
    }
    if (a === "--json") {
      json = true;
      i += 1;
      continue;
    }
    throw new UsageError({ what: `host-pressure: unknown flag: ${a}`, hint: USAGE });
  }
  const out: HostPressureArgs = { json };
  if (host !== undefined) out.host = host;
  if (timeoutMs !== undefined) out.timeoutMs = timeoutMs;
  return out;
}

/** Injection seam — the verb's only boundary beyond stdout. */
export interface HostPressureDeps {
  probe?: typeof probeHosts;
  log?: (line: string) => void;
}

/**
 * Run the report.
 *
 * Exit code is 0 whenever a report was PRODUCED — including one that
 * says a host is on fire. The verdict lives in the rendered text and in
 * `--json`'s `ok` field, not in the exit status.
 *
 * This is not a style choice. Every read verb the voice catalog wires
 * (`health`, `fleet`, `blockers`) returns 0 unconditionally, and the
 * tool bridge maps a NONZERO exit to a `verb_failed` envelope. An
 * earlier version returned 1 on pressure, which made "hig is
 * unreachable" — the single most important thing this tool can say —
 * reach the model as a TOOL FAILURE rather than as the answer. Caught
 * by driving the real bridge end to end; no unit test would have shown
 * it, because each half was correct on its own.
 *
 * Shell users who want a gate read the machine-readable verdict:
 * `atmux host-pressure --json | jq -e .ok`.
 */
export async function hostPressure(
  argv: ReadonlyArray<string>,
  deps: HostPressureDeps = {},
): Promise<number> {
  const args = parseHostPressureArgs(argv);
  const probe = deps.probe ?? probeHosts;
  const log = deps.log ?? ((l: string) => console.log(l));

  const all = await probe({
    ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
  });
  const entries: HostReportEntry[] =
    args.host === undefined ? all : all.filter((e) => e.host === args.host);

  if (args.host !== undefined && entries.length === 0) {
    throw new UsageError({
      what: `host-pressure: no such host: ${args.host}`,
      hint: `known hosts: ${all.map((e) => e.host).join(", ")}`,
    });
  }

  const summary = summarizeHostReport(entries);
  if (args.json) {
    log(
      JSON.stringify({
        ok: summary.ok,
        timeoutMs: args.timeoutMs ?? resolveHostProbeTimeoutMs(),
        summary,
        hosts: entries,
      }),
    );
  } else {
    log(renderHostReport(entries));
  }
  // See the docstring: a produced report is a SUCCESSFUL read, however
  // bad the news in it.
  return 0;
}
