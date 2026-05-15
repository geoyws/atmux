// ADR-139 §D2 / T3 (t-841049e4): `atmux refusal-scan` verb — invoked
// by medic (hourly, ADR-077 / ADR-133) and martinet (per-tick,
// ADR-132). Pure orchestration wrapper around `scanTeamForRefusals`
// from `src/core/refusal-scan.ts`. Verb stays thin: argv parse,
// `requireTeam` + `getAtmuxDir` resolve, hand off to the core.
//
// Output: JSON one-liner to stdout (default) so cron logs are
// machine-parseable, with `--json` reserved for forward-compat
// (e.g. a future `--format md` variant). Non-zero exit on UsageError;
// scan failures (capture / classify) are logged inline and absorbed.

import { type RefusalScanDeps, type RefusalScanResult, scanTeamForRefusals } from "../core/refusal-scan.ts";
import { getAtmuxDir, type ResolveDirOpts, requireTeam } from "../core/common.ts";
import { UsageError } from "../errors.ts";

const USAGE = "atmux refusal-scan [--team-dir <path>] [--json]";

export interface ParsedRefusalScanArgs {
  teamDir?: string;
  json: boolean;
}

export function parseRefusalScanArgs(argv: ReadonlyArray<string>): ParsedRefusalScanArgs {
  const out: ParsedRefusalScanArgs = { json: false };
  for (let i = 0; i < argv.length; ) {
    const a = argv[i];
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({
          what: "refusal-scan: --team-dir requires a value",
          hint: USAGE,
        });
      }
      out.teamDir = v;
      i += 2;
      continue;
    }
    if (a === "--json") {
      out.json = true;
      i += 1;
      continue;
    }
    throw new UsageError({
      what: `refusal-scan: unknown arg: ${a ?? ""}`,
      hint: USAGE,
    });
  }
  return out;
}

export async function refusalScan(
  argv: ReadonlyArray<string>,
  deps: RefusalScanDeps = {},
): Promise<number> {
  const parsed = parseRefusalScanArgs(argv);
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const team = await requireTeam(dirOpts);
  const atmuxDir = await getAtmuxDir(dirOpts);
  const result: RefusalScanResult = await scanTeamForRefusals(team, atmuxDir, deps);
  // Always emit a JSON summary so cron tail / medic inline grep can
  // distinguish a successful no-detection tick from a scan crash.
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}
