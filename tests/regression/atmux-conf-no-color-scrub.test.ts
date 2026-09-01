// Regression guard for the cage colour-environment invariant
// (ADR-277, extended by ADR-281).
//
// A tmux server freezes its own environ at start and hands it to every
// pane it later creates. atmux cages are routinely started from inside
// an agent's Bash tool, whose environment carries `NO_COLOR=1` so that
// captured command output is plain text. tmux re-derives TERM per pane
// from `default-terminal`, but `NO_COLOR` is not in
// `update-environment` — so without an explicit scrub it survives into
// every shell and every TUI in the cage, for the life of the server,
// and Claude Code / codex / opencode all render monochrome.
//
// Honest-test note (CLAUDE.md §"NO LIES"): the grep assertion alone
// would still pass if the conf carried the WRONG tmux verb (e.g.
// `set-environment -g NO_COLOR ""`, which sets it empty rather than
// removing it). So the behavioural test starts a REAL tmux server with
// `NO_COLOR=1` in its environment, loads the shipped conf, and reads
// the actual environment of a real pane. Its control leg keeps the
// shipped conf in place and restores `NO_COLOR=1` through the documented
// local override path, proving the probe can observe a real opt-in.
//
// Every real tmux server in this file loads CONF_PATH. The negative
// control keeps that conf and opts NO_COLOR back in through
// `~/.config/atmux/tmux.conf.local` under the test HOME. The separate
// spawn-seam coverage lives in tests/unit/abstractions/tmux-child-env.test.ts
// and does not need a live tmux server.
//
// Probe safety (ADR-282, 2026-08-28). Every probe below collects ONLY the
// four names in `ENV_DUMP_ALLOWLIST`, filtered inside the pane by
// `dumpEnvCommand`. An earlier revision dumped the whole environment and
// asserted on it, so one red run printed every API token, database
// password and webhook URL in the operator's environment into the test
// log. Filtering on the way IN was the first repair; not collecting it at
// all is the structural one. Do not reintroduce a bare redirect of the
// whole environment.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTmuxBin } from "../../src/core/resolve-tmux-bin.ts";
import { dumpEnvCommand, parseEnvDump } from "../helpers/env-dump.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CONF_PATH = join(REPO_ROOT, "templates", "tmux", "atmux.conf");
const conf = readFileSync(CONF_PATH, "utf8");

/**
 * The tmux binary the CODE UNDER TEST will spawn, resolved exactly as it
 * resolves it (ADR-191's three-tier chain: `ATMUX_TMUX_BIN` ->
 * `/opt/atmux/current/bin/tmux` -> PATH).
 *
 * Corrected 2026-08-28. This used to probe `command -v
 * tmux`, i.e. the bare PATH — so on a box with `ATMUX_TMUX_BIN` set, or
 * with a vendored binary and no system tmux, the gate and the subject
 * disagreed: the suite could skip while atmux had a perfectly good tmux,
 * or run raw-tmux control legs against a DIFFERENT binary from the one
 * `createTmux` drives, which makes the comparison between the two
 * meaningless.
 */
const TMUX_BIN: string | null = (() => {
  try {
    return resolveTmuxBin();
  } catch {
    return null;
  }
})();
const HAS_TMUX = TMUX_BIN !== null;
/** Safe to splice into an argv only inside a `HAS_TMUX` leg. */
const TMUX = TMUX_BIN ?? "tmux";

describe("templates/tmux/atmux.conf cage colour-environment invariant (ADR-277)", () => {
  test("scrubs NO_COLOR from the environment of new processes", () => {
    // `-r` marks the variable for REMOVAL. `-g` puts it on the server's
    // global environment so EVERY pane inherits the scrub, not just the
    // session that happens to be current when the conf loads.
    expect(conf).toMatch(/^set-environment -gr NO_COLOR\b/m);
  });

  test("the scrub carries its ADR pointer", () => {
    expect(conf).toMatch(/ADR-277/);
  });

  test("the scrub precedes the operator override, so an operator can still opt back in", () => {
    // ADR-171's `source-file -q ~/.config/atmux/tmux.conf.local` is
    // loaded LAST by design. An operator who genuinely wants monochrome
    // cages must be able to re-set NO_COLOR there and win.
    const scrubAt = conf.indexOf("set-environment -gr NO_COLOR");
    // Match the DIRECTIVE, not the forward-reference to the same path in
    // the header comment — the comment sits above every option and would
    // make this assertion pass for the wrong reason.
    const overrideAt = conf.search(/^source-file -q .*tmux\.conf\.local/m);
    expect(scrubAt).toBeGreaterThan(-1);
    expect(overrideAt).toBeGreaterThan(scrubAt);
  });

  test("carries the server-level COLORTERM line ADR-281 §D2 says it carries", () => {
    // ADR-281 asserted in three places that this file "keeps
    // its `COLORTERM truecolor` line", and leaned on that as the
    // compensating control for withdrawing the spawn-level injection. IT
    // DID NOT: the only `set-environment` here was NO_COLOR, and the only
    // COLORTERM occurrence was inside a comment. The line existed solely
    // in the operator's personal ~/.tmux.conf, which this repository does
    // not ship. The claim is true now, and this is what keeps it true.
    //
    // `-g`, not `-gr`: the intent here is to SET a value, where
    // NO_COLOR's is to REMOVE one.
    expect(conf).toMatch(/^set-environment -g COLORTERM truecolor$/m);
  });

  test("COLORTERM sits after the NO_COLOR scrub and before the operator override", () => {
    // Ordering is the whole safety argument: above the ADR-171
    // `source-file`, so ADR-277 §D2 still holds and an operator's own
    // conf loads last and can override either line.
    const scrubAt = conf.search(/^set-environment -gr NO_COLOR$/m);
    const colortermAt = conf.search(/^set-environment -g COLORTERM truecolor$/m);
    const overrideAt = conf.search(/^source-file -q .*tmux\.conf\.local/m);
    expect({
      afterScrub: colortermAt > scrubAt,
      beforeOverride: colortermAt < overrideAt,
    }).toEqual({ afterScrub: true, beforeOverride: true });
  });
});

// @skip-reason: the two describes below start REAL tmux servers, so they
// are gated on a resolvable tmux binary.
//
// bun 1.3.14 DOES count a `describe.if(false)` block's tests in the skip
// total (verified 2026-08-28 — 9 tests, 9 skips), so they do not vanish
// from the tally. What was missing is a gate: nothing anywhere made an
// absent tmux a FAILURE. On a developer box without tmux, skipping is
// legitimate. On CI, where the workflow installs tmux on purpose, an
// absent one silently removes every behavioural assertion in this file,
// and that must go red instead of quietly reporting a smaller suite.
describe("the tmux-gated legs are not silently absent", () => {
  test("CI must have a resolvable tmux — a skip there is a failure, not a gap", () => {
    const onCi = process.env.CI === "true" || process.env.CI === "1";
    expect({ onCi, missingOnCi: onCi && !HAS_TMUX }).toEqual({ onCi, missingOnCi: false });
  });
});

describe.if(HAS_TMUX)("cage colour-environment invariant — real tmux server (ADR-277)", () => {
  let dir = "";

  beforeEach(async () => {
    // Short prefix: a unix socket path is capped near 108 bytes, and a
    // long scratch dir silently fails with "File name too long".
    dir = await mkdtemp(join(tmpdir(), "atmux-nc-"));
  });

  afterEach(async () => {
    for (const sock of ["s-shipped", "s-control"]) {
      Bun.spawnSync({
        cmd: [TMUX, "-S", join(dir, sock), "kill-server"],
        env: { ...process.env, TMUX: undefined } as Record<string, string | undefined>,
        stderr: "ignore",
      });
    }
    await rm(dir, { recursive: true, force: true });
  });

  /** Start a tmux server with NO_COLOR=1 in ITS OWN environ, using the
   *  given conf, and return the environment a real pane actually got. */
  async function paneEnv(sock: string, confPath: string): Promise<string> {
    const out = join(dir, `${sock}.env`);
    const proc = Bun.spawnSync({
      cmd: [
        TMUX,
        "-S",
        join(dir, sock),
        "-f",
        confPath,
        "new-session",
        "-d",
        "-s",
        "probe",
        dumpEnvCommand(out),
      ],
      // TMUX unset: per tmux(1) an inherited $TMUX overrides -S and would
      // land this probe on the caller's own server.
      //
      // HOME redirected into the scratch dir (added 2026-08-28 with
      // ADR-281): the conf's LAST line is ADR-171's
      // `source-file -q "~/.config/atmux/tmux.conf.local"`, and on a real
      // operator box that file can itself `source-file ~/.tmux.conf`,
      // which may carry its own `set-environment -gr NO_COLOR` (ADR-281
      // §D4 layer 3). When it does, the control leg below re-acquires the
      // scrub it just stripped and FAILS — and, worse, the shipped-conf
      // leg passes for the operator's reason rather than the shipped
      // conf's. Verified failing that way on geoywsMBP on 2026-08-28,
      // BEFORE any ADR-281 source change. A `-q` source-file of a path
      // that does not exist is silent, so this isolates the suite to the
      // conf it is actually testing without editing the conf.
      env: { ...process.env, NO_COLOR: "1", TMUX: undefined, HOME: dir } as Record<
        string,
        string | undefined
      >,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);

    for (let i = 0; i < 50; i++) {
      try {
        return await readFile(out, "utf8");
      } catch {
        await Bun.sleep(100);
      }
    }
    throw new Error(`probe pane never wrote ${out}`);
  }

  test("a pane started under the shipped conf does NOT inherit NO_COLOR", async () => {
    const env = parseEnvDump(await paneEnv("s-shipped", CONF_PATH));
    expect(env).toContain("TERM=tmux-256color"); // the pane really did start
    expect(env).not.toMatch(/^NO_COLOR=/m);
  });

  test("(control) the same pane with a local override opts NO_COLOR back in", async () => {
    // The shipped conf still runs first; this just models the operator's
    // documented opt-in path under ~/.config/atmux/tmux.conf.local.
    const localDir = join(dir, ".config", "atmux");
    await mkdir(localDir, { recursive: true });
    await writeFile(join(localDir, "tmux.conf.local"), "set-environment -g NO_COLOR 1\n", "utf8");
    const env = parseEnvDump(await paneEnv("s-control", CONF_PATH));
    expect(env).toMatch(/^NO_COLOR=1$/m);
  });
});
