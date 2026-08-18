// Regression guard for the cage colour-environment invariant (ADR-277).
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
// the actual environment of a real pane. Its control leg runs the same
// probe against a conf WITHOUT the scrub and asserts `NO_COLOR=1` DOES
// arrive — proving the probe can observe the failure it claims to rule
// out, rather than passing because the mechanism never ran.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CONF_PATH = join(REPO_ROOT, "templates", "tmux", "atmux.conf");
const conf = readFileSync(CONF_PATH, "utf8");

const HAS_TMUX = Bun.spawnSync({ cmd: ["sh", "-c", "command -v tmux"] }).exitCode === 0;

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
        cmd: ["tmux", "-S", join(dir, sock), "kill-server"],
        env: { ...process.env, TMUX: undefined } as Record<string, string>,
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
        "tmux",
        "-S",
        join(dir, sock),
        "-f",
        confPath,
        "new-session",
        "-d",
        "-s",
        "probe",
        `sh -c 'env > ${out}; sleep 3'`,
      ],
      // TMUX unset: per tmux(1) an inherited $TMUX overrides -S and would
      // land this probe on the caller's own server.
      env: { ...process.env, NO_COLOR: "1", TMUX: undefined } as Record<string, string>,
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
    const env = await paneEnv("s-shipped", CONF_PATH);
    expect(env).toContain("TERM=tmux-256color"); // the pane really did start
    expect(env).not.toMatch(/^NO_COLOR=/m);
  });

  test("(control) the same pane WITHOUT the scrub does inherit NO_COLOR=1", async () => {
    // If this leg ever goes green-by-default, the test above proves
    // nothing — the pane would be clean for some unrelated reason.
    const control = join(dir, "control.conf");
    await writeFile(control, conf.replace(/^set-environment -gr NO_COLOR$/m, ""), "utf8");
    const env = await paneEnv("s-control", control);
    expect(env).toMatch(/^NO_COLOR=1$/m);
  });
});
