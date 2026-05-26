// ADR-090 §`dissolve-epic` verb (t-b430b185) — thin CLI wrapper.
//
// `atmux team dissolve-epic <epicId> [--skip-checks] [--force-prune]`
//
// Body factored into `src/core/dissolve-epic.ts::performDissolveEpic`
// per ADR-232 §D1 so the cross-cage dispatcher
// (src/core/orchd-dispatchers.ts) can invoke the same pipeline without
// re-walking argv. Same factoring pattern as `performEpicMerge` per
// ADR-091. This wrapper is responsible ONLY for argv parsing + dispatch
// into the core. CLI semantics (exit code, stdout shape, error shape)
// are preserved verbatim — `performDissolveEpic` throws the same
// `ConfigError` types and returns `0` from the same success path.

import {
  type DissolveEpicOpts,
  performDissolveEpic,
  type PerformDissolveEpicInput,
} from "../../core/dissolve-epic.ts";
import { UsageError } from "../../errors.ts";

// Re-exports preserve the pre-factor import surface so existing tests
// at `tests/unit/verbs/team/dissolve-epic.test.ts` (which import
// `defaultCageTeardown`, `deleteMergedEpicBranch`, `DissolveEpicOpts`
// from this file) keep working without modification.
export {
  defaultCageTeardown,
  deleteMergedEpicBranch,
  performDissolveEpic,
  type DissolveEpicOpts,
  type PerformDissolveEpicInput,
} from "../../core/dissolve-epic.ts";

const USAGE = "atmux team dissolve-epic <epicId> [--skip-checks] [--force-prune]";

// ---------- Arg parsing ----------

export interface ParsedDissolveEpicArgs {
  epicId: string;
  skipChecks: boolean;
  forcePrune: boolean;
}

export function parseDissolveEpicArgs(argv: ReadonlyArray<string>): ParsedDissolveEpicArgs {
  let epicId: string | undefined;
  let skipChecks = false;
  let forcePrune = false;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--skip-checks") {
      skipChecks = true;
      i += 1;
      continue;
    }
    if (a === "--force-prune") {
      forcePrune = true;
      i += 1;
      continue;
    }
    if (a?.startsWith("-") === true) {
      throw new UsageError({
        what: `dissolve-epic: unknown flag: ${a}`,
        hint: USAGE,
      });
    }
    if (epicId === undefined) {
      epicId = a;
      i += 1;
      continue;
    }
    throw new UsageError({
      what: `dissolve-epic: unexpected positional: ${a}`,
      hint: USAGE,
    });
  }
  if (epicId === undefined || epicId.length === 0) {
    throw new UsageError({
      what: "dissolve-epic: <epicId> required",
      hint: USAGE,
    });
  }
  return { epicId, skipChecks, forcePrune };
}

// ---------- Top-level dispatch ----------

export async function dissolveEpic(
  argv: ReadonlyArray<string>,
  opts: DissolveEpicOpts = {},
): Promise<number> {
  const parsed = parseDissolveEpicArgs(argv);
  const input: PerformDissolveEpicInput = {
    epicId: parsed.epicId,
    skipChecks: parsed.skipChecks,
    forcePrune: parsed.forcePrune,
  };
  return performDissolveEpic(input, opts);
}
