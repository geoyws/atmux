// ADR-221 §v2 — `dissolve-worker` verb.
//
// `atmux team dissolve-worker <worker-id-or-task-id> [--skip-checks] [--force-prune]`
//
// Thin wrapper around `dissolve-epic` that adds the worker-team gate:
// only epic-team ids carrying the `w-` prefix can be dissolved through
// this verb. Generic epic-team ids (`e-XXXX`) refuse with a hint
// pointing back to `dissolve-epic`. Accepted input forms mirror
// `spawn-worker`: `t-<tail>` / `<tail>` / `w-<tail>` all normalise to
// `w-<tail>`.
//
// Why a separate verb (vs. just running `dissolve-epic w-<tail>`):
//
//   - Symmetry with `spawn-worker` — operators reach for the matching
//     pair without having to remember the underlying epic-team verb.
//   - Visible audit-trail — `atmux team dissolve-worker w-xxx` reads
//     differently from `atmux team dissolve-epic e-xxx` in logs +
//     command history, even though the disk effect is identical.
//   - Future-proofing — when ADR-221 v3 / e-a946af69 Phase 4 lands the
//     auto-dissolve subscriber, the consumer can call this verb
//     directly without re-implementing the prefix-check guard.

import { resolveCallerScope } from "../../core/common.ts";
import { ConfigError, UsageError } from "../../errors.ts";
import { type DissolveEpicOpts, dissolveEpic } from "./dissolve-epic.ts";
import { normaliseWorkerId } from "./spawn-worker.ts";

const USAGE = "atmux team dissolve-worker <worker-id-or-task-id> [--skip-checks] [--force-prune]";

// ---------- Arg parsing ----------

export interface ParsedDissolveWorkerArgs {
  /** Raw worker/task id positional as the operator typed it. */
  workerOrTaskId: string;
  skipChecks: boolean;
  forcePrune: boolean;
}

export function parseDissolveWorkerArgs(argv: ReadonlyArray<string>): ParsedDissolveWorkerArgs {
  let workerOrTaskId: string | undefined;
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
        what: `dissolve-worker: unknown flag: ${a}`,
        hint: USAGE,
      });
    }
    if (workerOrTaskId === undefined) {
      workerOrTaskId = a;
      i += 1;
      continue;
    }
    throw new UsageError({
      what: `dissolve-worker: unexpected positional: ${a}`,
      hint: USAGE,
    });
  }
  if (workerOrTaskId === undefined || workerOrTaskId.length === 0) {
    throw new UsageError({
      what: "dissolve-worker: <worker-id-or-task-id> required",
      hint: USAGE,
    });
  }
  return { workerOrTaskId, skipChecks, forcePrune };
}

// ---------- Top-level dispatch ----------

export interface DissolveWorkerOpts extends DissolveEpicOpts {
  /** Test-injection seam for the delegated dissolve call. Defaults to
   *  the real `dissolveEpic` from `./dissolve-epic.ts`. */
  dissolve?: (argv: ReadonlyArray<string>, opts: DissolveEpicOpts) => Promise<number>;
}

export async function dissolveWorker(
  argv: ReadonlyArray<string>,
  opts: DissolveWorkerOpts = {},
): Promise<number> {
  const parsed = parseDissolveWorkerArgs(argv);
  const env = opts.env ?? process.env;
  const callerScope = opts.callerScope ?? (() => resolveCallerScope({ env }));
  const dissolveFn = opts.dissolve ?? dissolveEpic;

  // Caller-scope gate. ADR-033: dissolve is driver-scope-only, same
  // as dissolve-epic. Refuse here (instead of letting dissolve-epic
  // refuse downstream) so the error message names this verb — easier
  // for the operator to map back to the command they typed.
  if (callerScope() !== "driver") {
    throw new ConfigError({
      what: "dissolve-worker: refused — caller scope is not 'driver'. Set ATMUX_CALLER_SCOPE=driver in the calling shell (ADR-033 §Caller-scope gate).",
      hint: "from a driver pane: ATMUX_CALLER_SCOPE=driver atmux team dissolve-worker ...",
    });
  }

  // Worker-id gate. Generic `e-` epic ids should go through dissolve-
  // epic; this verb is for the worker-team prefix `w-` only.
  const raw = parsed.workerOrTaskId.trim();
  if (raw.startsWith("e-")) {
    throw new ConfigError({
      what: `dissolve-worker: '${raw}' looks like a generic epic-team id (e-...), not a worker-team — refusing.`,
      hint: `if this really is a worker-team, rerun with the 'w-' form. Otherwise: atmux team dissolve-epic ${raw}`,
    });
  }
  const workerId = normaliseWorkerId(raw);

  // Delegate. All the heavy lifting — caller-scope re-check,
  // cockpit walk, gates, soft-stop, prune, cockpit-mutate, kanban-EPIC
  // mark-done — lives in dissolveEpic; this verb is composition.
  const epicArgv: string[] = [workerId];
  if (parsed.skipChecks) epicArgv.push("--skip-checks");
  if (parsed.forcePrune) epicArgv.push("--force-prune");
  return await dissolveFn(epicArgv, opts);
}
