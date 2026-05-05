// ADR-010: CLI dispatcher.
//
// Phase-1 minimal: routes the `version` verb (smallest state, first
// parity-harness verb per task #4). Phase 2 expands the switch as
// porters land additional verbs; alias routing (`broadcast` → `send
// --broadcast` etc.) and top-level error handling (UsageError → exit 64,
// AtmuxError → tagged stderr) follow per ADR-006 + ADR-014.
//
// **Pure library** — no module-level side effects. The TS entrypoint is
// `bin/atmux-bun` (excluded from the coverage denominator per its `bin/`
// path); running `bun run src/cli.ts <verb>` directly is NOT supported.
// This keeps `src/cli.ts` 100% unit-testable per ADR-009 §2 (cli.ts is
// in the tracked set per architect's review-verdict refinement, commit
// 64898c7 + bunfig.toml `9fd3104`).

import { version } from "./verbs/version.ts";

/**
 * Entry point — process argv (sliced past binary + script name) and
 * return the exit code. Throws are not handled here yet; that's the
 * top-level catch's job (Phase 1 follow-up per ADR-006).
 */
export async function main(argv: ReadonlyArray<string>): Promise<number> {
  const verb = argv[0] ?? "";
  switch (verb) {
    case "version":
    case "--version":
    case "-V":
      return version(argv.slice(1));
    default:
      console.error(`atmux-bun: unknown verb: ${verb || "<none>"}`);
      return 1;
  }
}
