#!/usr/bin/env bun
// t-15bcfaf8: produce a coverage run that KNOWS what produced it, then gate it.
//
// The gate parses `coverage/lcov.info` and prints a breach count. That
// number is only meaningful alongside the command behind it: the same
// commit and the same unchanged file read 304/304 lines under the
// whole-tree `bun test --coverage` and 296/315 under the narrower
// `bun test tests/unit tests/integration --coverage`. The instrumented
// line set follows which modules a run loads, so the denominator itself
// moves. Two agents quoting "N breaches" for one commit can both be
// right and still disagree.
//
// This wrapper closes that by writing a provenance sidecar next to the
// lcov recording the exact argv. `tests/lcov-gate.ts` reads it and
// prints it above every verdict; an lcov produced any other way reports
// UNKNOWN rather than implying comparability.
//
// WHICH SUITE IS CANONICAL IS NOT DECIDED HERE. Including tests/e2e
// changes the answer AND spawns real tmux servers, so it is an operator
// call, not a default this script should quietly make (raised on the
// kanban board). Pass the suite explicitly; the sidecar records whatever
// you chose, which is the whole point.
//
// Usage:
//   bun scripts/coverage-gate.ts                       # unit + integration
//   bun scripts/coverage-gate.ts --all                 # whole tests/ tree
//   bun scripts/coverage-gate.ts -- tests/unit         # explicit paths
//   bun scripts/coverage-gate.ts --gate-only           # re-gate, no re-run

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { PROVENANCE_BASENAME } from "../tests/lcov-gate.ts";

/** Default suite: unit + integration. Deliberately NOT the whole tree —
 *  see the note above about e2e spawning real tmux servers. */
const DEFAULT_SUITE = ["tests/unit", "tests/integration"];

export interface WrapperArgs {
  /** Test paths handed to `bun test`. Empty means the whole tree. */
  readonly suite: ReadonlyArray<string>;
  /** Skip the coverage run and only re-gate an existing lcov. */
  readonly gateOnly: boolean;
}

export function parseWrapperArgs(argv: ReadonlyArray<string>): WrapperArgs {
  const rest = [...argv];
  let gateOnly = false;
  let all = false;
  const explicit: string[] = [];
  let sawDoubleDash = false;
  for (const a of rest) {
    if (a === "--") {
      sawDoubleDash = true;
      continue;
    }
    if (sawDoubleDash) {
      explicit.push(a);
      continue;
    }
    if (a === "--gate-only") gateOnly = true;
    else if (a === "--all") all = true;
    else explicit.push(a);
  }
  // `--all` means the whole tree, which `bun test` expresses as no paths.
  const suite = all ? [] : explicit.length > 0 ? explicit : DEFAULT_SUITE;
  return { suite, gateOnly };
}

/** Run argv, streaming output, resolving with the exit code. */
function run(cmd: string, argv: ReadonlyArray<string>, cwd: string): Promise<number> {
  return new Promise((res) => {
    const child = spawn(cmd, [...argv], { cwd, stdio: "inherit", env: process.env });
    child.on("close", (code) => res(code ?? 1));
    child.on("error", () => res(127));
  });
}

export async function main(argv: ReadonlyArray<string>, cwd: string): Promise<number> {
  const args = parseWrapperArgs(argv);
  const lcovPath = resolve(cwd, "coverage/lcov.info");
  const sidecar = join(dirname(lcovPath), PROVENANCE_BASENAME);

  if (!args.gateOnly) {
    // `env -u TMUX` is the caller's job, not ours — see the repo memory
    // on running bun test inside a live cage. We do not silently unset it.
    const testArgv = ["test", ...args.suite, "--coverage"];
    const code = await run("bun", testArgv, cwd);
    // A failing suite still leaves an lcov behind, and gating it would
    // report coverage numbers for a run that did not pass. Refuse.
    if (code !== 0) {
      process.stderr.write(
        `coverage-gate: \`bun ${testArgv.join(" ")}\` exited ${code}; refusing to gate a failed run\n`,
      );
      return code;
    }
    await mkdir(dirname(sidecar), { recursive: true });
    await writeFile(
      sidecar,
      `${JSON.stringify(
        { command: ["bun", ...testArgv], finishedAt: new Date().toISOString() },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  return await run("bun", ["tests/lcov-gate.ts"], cwd);
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2), process.cwd()));
}
