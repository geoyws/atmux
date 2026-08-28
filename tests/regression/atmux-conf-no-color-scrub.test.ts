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
// the actual environment of a real pane. Its control leg runs the same
// probe against a conf WITHOUT the scrub and asserts `NO_COLOR=1` DOES
// arrive — proving the probe can observe the failure it claims to rule
// out, rather than passing because the mechanism never ran.
//
// ADR-281 (2026-08-28) adds the leg those tests could not have. Every
// ADR-277 leg passes `-f CONF_PATH`, so together they can only prove the
// conf is CORRECT — never that it ARRIVED. The final describe drives
// atmux's own `createTmux` with no conf at all and asserts the pane is
// clean anyway, because the scrub now also happens at the `spawn()` seam.
//
// Probe safety (ADR-282, 2026-08-28). Every probe below collects ONLY the
// four names in `ENV_DUMP_ALLOWLIST`, filtered inside the pane by
// `dumpEnvCommand`. An earlier revision dumped the whole environment and
// asserted on it, so one red run printed every API token, database
// password and webhook URL in the operator's environment into the test
// log. Filtering on the way IN was the first repair; not collecting it at
// all is the structural one. Do not reintroduce a bare redirect of the
// whole environment — tests/regression/no-unfiltered-env-dump.test.ts
// fails the suite if you do.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTmux, type TmuxNamespace } from "../../src/abstractions/tmux.ts";
import { defaultPalette, NO_COLOR as NO_COLOR_PALETTE } from "../../src/core/tui.ts";
import { dumpEnvCommand, parseEnvDump } from "../helpers/env-dump.ts";

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
        "tmux",
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

  test("(control) the same pane WITHOUT the scrub does inherit NO_COLOR=1", async () => {
    // If this leg ever goes green-by-default, the test above proves
    // nothing — the pane would be clean for some unrelated reason.
    const control = join(dir, "control.conf");
    await writeFile(control, conf.replace(/^set-environment -gr NO_COLOR$/m, ""), "utf8");
    const env = parseEnvDump(await paneEnv("s-control", control));
    expect(env).toMatch(/^NO_COLOR=1$/m);
  });
});

// ---------------------------------------------------------------------
// ADR-281 — the leg the conf-only guard structurally could not have.
// ---------------------------------------------------------------------
//
// Every leg above passes `-f CONF_PATH`, so all of them together can only
// prove the conf is CORRECT — never that it ARRIVED. ADR-277 asserted it
// always does ("atmux passes `-f <this file>` on every invocation"); it
// does not. `createTmux` only emits `-f` when the caller supplied a
// `configFile`, and tmux starts a server implicitly for any subcommand
// against a dead socket, so a read-only `attach` or `list-keys` can be the
// process whose environ gets frozen before an `-f`-carrying command ever
// runs. Measured 2026-08-28 on geoywsMBP: 6 of 47 live servers had never
// loaded any atmux conf; 2 of those were greyscale.
//
// So this block starts a server through ATMUX'S OWN tmux namespace, with
// `NO_COLOR=1` in `process.env`, and asserts a real pane comes out clean.
//
// `configFile: "/dev/null"` rather than omitting `-f` entirely, and this
// is load-bearing rather than cosmetic: omitting it makes tmux load the
// OPERATOR'S `~/.tmux.conf`, which on the author's box already carries the
// same `set-environment -gr NO_COLOR` (ADR-281 §D4 layer 3). This suite
// must measure layer 1 — the spawn scrub — so both legs below neutralise
// every conf. Same argument, and the same flag, as
// tests/unit/abstractions/tmux.test.ts's own `/dev/null` pin.
//
// Socket safety: a fresh `mkdtemp` dir per test and an explicit `-S` under
// it, so nothing here can reach a live cage socket
// (/tmp/atmux-<team>/sock, /tmp/atmux-grp-*, -L atmux-cockpit). Teardown
// is unconditional.

describe.if(HAS_TMUX)("tmux child-environment scrub at the spawn seam (ADR-281)", () => {
  let dir = "";
  let priorNoColor: string | undefined;
  let priorTmux: string | undefined;
  let tmux: TmuxNamespace | null = null;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atmux-281-"));
    // The fault reproduced: an agent Bash tool's environment.
    priorNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    // Belt-and-braces, exactly as tests/unit/abstractions/tmux.test.ts:
    // per tmux(1) an inherited $TMUX overrides -S and would land these
    // probes on the caller's own server. The load-bearing isolation is
    // still the explicit -S below.
    priorTmux = process.env.TMUX;
    delete process.env.TMUX;
    tmux = null;
  });

  afterEach(async () => {
    try {
      await tmux?.server.killServer();
    } catch {
      // expected: server may already be gone (idempotent teardown)
    }
    Bun.spawnSync({
      cmd: ["tmux", "-S", join(dir, "s-raw"), "kill-server"],
      env: { ...process.env, TMUX: undefined } as Record<string, string | undefined>,
      stderr: "ignore",
    });
    if (priorNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = priorNoColor;
    if (priorTmux !== undefined) process.env.TMUX = priorTmux;
    await rm(dir, { recursive: true, force: true });
  });

  async function waitForDump(out: string): Promise<string> {
    for (let i = 0; i < 50; i++) {
      try {
        return await readFile(out, "utf8");
      } catch {
        await Bun.sleep(100);
      }
    }
    throw new Error(`probe pane never wrote ${out}`);
  }

  test("a server created through atmux's own tmux namespace yields a clean pane", async () => {
    const out = join(dir, "atmux.env");
    tmux = createTmux({ socketPath: join(dir, "s-atmux"), configFile: "/dev/null" });
    await tmux.session.newSession({
      name: "probe",
      detached: true,
      shellCommand: dumpEnvCommand(out),
    });

    const env = parseEnvDump(await waitForDump(out));
    // The pane really started (tmux sets TMUX in every pane it spawns).
    expect(env).toMatch(/^TMUX=/m);
    // The invariant: absent, not empty.
    expect(env).not.toMatch(/^NO_COLOR=/m);
    // There is deliberately no `COLORTERM=truecolor` assertion here.
    // ADR-281 originally carried one; it could not fail, because tmux
    // sets COLORTERM in every pane ITSELF — measured on tmux 3.7c, a
    // pane comes out `COLORTERM=truecolor` even when the server's own
    // global environment holds `COLORTERM=` (empty). It therefore
    // asserted tmux's behaviour, never atmux's, and the policy it was
    // pinning has been withdrawn (ADR-281 §D2, amended 2026-08-28).
  });

  test("the server's global environment has no NO_COLOR to hand out", async () => {
    // Complements the pane assertion: the pane could in principle be
    // clean while the SERVER still holds the variable for future panes.
    // Read via raw tmux — the server already exists, so this cannot
    // create one, and the thing under test is the CREATE path.
    tmux = createTmux({ socketPath: join(dir, "s-atmux"), configFile: "/dev/null" });
    await tmux.session.newSession({ name: "probe", detached: true, shellCommand: "sleep 3" });

    const r = Bun.spawnSync({
      cmd: ["tmux", "-S", join(dir, "s-atmux"), "show-environment", "-g", "NO_COLOR"],
      env: { ...process.env, TMUX: undefined } as Record<string, string | undefined>,
      stdout: "pipe",
      stderr: "pipe",
    });
    const said = `${r.stdout.toString()}${r.stderr.toString()}`;
    // Either "unknown variable" (never present) or "-NO_COLOR" (present
    // and marked for removal) is correct. `NO_COLOR=1` is the fault.
    expect(said).not.toMatch(/^NO_COLOR=1$/m);
    expect(said).toMatch(/unknown variable|^-NO_COLOR$/m);
  });

  test("(control) raw tmux under the SAME environment DOES poison the pane", async () => {
    // The honest-test guard. This leg bypasses atmux entirely and must
    // FAIL to be clean — if it ever goes green, the two legs above prove
    // nothing, because the pane would be clean for an unrelated reason
    // (an operator conf, an env that never carried NO_COLOR, a tmux that
    // scrubs it itself).
    const out = join(dir, "raw.env");
    const proc = Bun.spawnSync({
      cmd: [
        "tmux",
        "-S",
        join(dir, "s-raw"),
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-s",
        "probe",
        dumpEnvCommand(out),
      ],
      env: { ...process.env, NO_COLOR: "1", TMUX: undefined } as Record<string, string | undefined>,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);

    const env = parseEnvDump(await waitForDump(out));
    expect(env).toMatch(/^NO_COLOR=1$/m);
  });

  test("atmux's OWN stdout still honours NO_COLOR after driving a tmux spawn", async () => {
    // ADR-281 §D5. `src/core/tui.ts::defaultPalette` reads process.env at
    // call time, so a `delete process.env.NO_COLOR` anywhere in atmux
    // would silently re-colour atmux's own output inside an agent Bash
    // tool — and break tests/helpers/setup.bash's `export NO_COLOR=1`
    // parity harness. The scrub must reach the CHILD only.
    tmux = createTmux({ socketPath: join(dir, "s-atmux"), configFile: "/dev/null" });
    await tmux.session.newSession({ name: "probe", detached: true, shellCommand: "sleep 3" });

    expect(process.env.NO_COLOR).toBe("1");
    expect(defaultPalette({ isTty: true })).toBe(NO_COLOR_PALETTE);
  });
});
