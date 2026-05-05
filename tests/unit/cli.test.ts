// Unit tests for src/cli.ts (ADR-010).
// Tracked under the ADR-009 §2 narrowed denominator — `src/cli.ts` was
// pulled into the tracked set by architect's review-verdict refinement
// (commit 64898c7) and the bunfig.toml comment ratifies it: cli.ts
// dispatch logic IS unit-testable (alias routing, unknown-verb path,
// version path) and SHOULD be tracked, not excluded. 100% required.
//
// The Phase-1 minimal dispatcher only routes `version` (+ aliases) and
// emits `unknown verb` to stderr for everything else. These tests cover
// every dispatch branch:
//   - "version" → returns 0, prints version
//   - "--version" alias → same
//   - "-V" alias → same
//   - unknown verb → exit 1 + stderr message
//   - empty argv (verb defaults to "") → unknown-verb branch with "<none>" label

import { describe, expect, test } from "bun:test";
import { main } from "../../src/cli.ts";

/**
 * Capture stdout + stderr of a `main()` invocation. Restoring the
 * originals in `finally` keeps the test runner's own logging intact
 * even if the assertion throws.
 */
async function captureMain(argv: ReadonlyArray<string>): Promise<{
  exit: number;
  stdout: string[];
  stderr: string[];
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (msg: unknown) => {
    stdout.push(String(msg));
  };
  console.error = (msg: unknown) => {
    stderr.push(String(msg));
  };
  try {
    const exit = await main(argv);
    return { exit, stdout, stderr };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

describe("cli.main — dispatch", () => {
  test("'version' routes to the version verb (exit 0, prints `atmux 0.3.0`)", async () => {
    const { exit, stdout, stderr } = await captureMain(["version"]);
    expect(exit).toBe(0);
    expect(stdout).toEqual(["atmux 0.3.0"]);
    expect(stderr).toEqual([]);
  });

  test("'--version' alias routes to version verb", async () => {
    const { exit, stdout, stderr } = await captureMain(["--version"]);
    expect(exit).toBe(0);
    expect(stdout).toEqual(["atmux 0.3.0"]);
    expect(stderr).toEqual([]);
  });

  test("'-V' alias routes to version verb", async () => {
    const { exit, stdout, stderr } = await captureMain(["-V"]);
    expect(exit).toBe(0);
    expect(stdout).toEqual(["atmux 0.3.0"]);
    expect(stderr).toEqual([]);
  });

  test("unknown verb → exit 1 + named stderr line", async () => {
    const { exit, stdout, stderr } = await captureMain(["bogus"]);
    expect(exit).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["atmux-bun: unknown verb: bogus"]);
  });

  test("empty argv → unknown-verb path with '<none>' label", async () => {
    // `verb = argv[0] ?? ""` then the false-branch of `verb || "<none>"`
    // fires — exercises the falsy-coalesce path explicitly, otherwise
    // branch coverage for that `||` would miss the empty-string side.
    const { exit, stdout, stderr } = await captureMain([]);
    expect(exit).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["atmux-bun: unknown verb: <none>"]);
  });
});

describe("cli — bin/atmux-bun entrypoint integration", () => {
  // `src/cli.ts` is a pure library (no module-level side effects per
  // ADR-009 §2 + ADR-010). The canonical TS entrypoint is `bin/atmux-bun`,
  // which forwards to `main(...)` and `process.exit`s with the result.
  // These tests exercise the actual entrypoint as a subprocess so a
  // refactor that breaks the bin shim's exit-code propagation surfaces
  // here, not at parity-harness time.
  //
  // CLAUDE.md "verify green from the right path" — the bin shim is
  // what cron / users invoke; testing only the library would miss
  // shim-level regressions (wrong argv slicing, exit-code dropping).

  const REPO_ROOT = import.meta.dir.replace(/\/tests\/unit$/, "");

  test("`bin/atmux-bun version` exits 0 + prints `atmux 0.3.0`", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "run", "bin/atmux-bun", "version"],
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exit).toBe(0);
    expect(stdout).toBe("atmux 0.3.0\n");
    expect(stderr).toBe("");
  });

  test("`bin/atmux-bun bogus` exits 1 + prints unknown-verb stderr", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "run", "bin/atmux-bun", "bogus"],
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exit).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("atmux-bun: unknown verb: bogus\n");
  });
});
