// Integration test — ADR-191 vendored tmux resolution paths.
//
// Exercises `resolveTmuxBin()` against the REAL filesystem + process
// env (no Bun mocks) plus a subprocess-level smoke against `atmux
// doctor` to confirm the `vendored-tmux-binary` probe surfaces the
// right row for each tier. Mirrors the spawn-real-binary pattern
// from `tests/integration/native-listener-e2e.test.ts`.
//
// Coverage per Epic e-1-b71bf640 T6 AC:
//   1. ATMUX_TMUX_BIN set to a known-existing path → returned verbatim.
//   2. ATMUX_TMUX_BIN set + missing → throws operator-actionable error.
//   3. ATMUX_TMUX_BIN unset + synthetic vendored present (tmpdir-based
//      stand-in) → returned.
//   4. ATMUX_TMUX_BIN unset + vendored absent + system tmux on PATH →
//      returns system-resolved absolute path + warn-once.
//   5. atmux doctor end-to-end smoke — vendored absent on this box
//      surfaces yellow `vendored-tmux-missing` row.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "../../src/abstractions/spawn.ts";
import {
  VENDORED_TMUX_PATH,
  createResolveTmuxBinState,
  resolveTmuxBin,
} from "../../src/core/resolve-tmux-bin.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");

describe("ADR-191 resolveTmuxBin — real filesystem / real env", () => {
  let scratch: string;
  let fakeTmux: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "atmux-vendored-tmux-"));
    fakeTmux = join(scratch, "fake-tmux");
    await writeFile(fakeTmux, "#!/bin/sh\necho 'tmux 3.6a'\n");
    await chmod(fakeTmux, 0o755);
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test("AC#1 — ATMUX_TMUX_BIN set to existing path → returned verbatim", () => {
    const r = resolveTmuxBin({ ATMUX_TMUX_BIN: fakeTmux }, undefined, () => {}, createResolveTmuxBinState());
    expect(r).toBe(fakeTmux);
  });

  test("AC#2 — ATMUX_TMUX_BIN set + missing → throws operator-actionable error", () => {
    const missing = join(scratch, "nope-tmux");
    expect(() =>
      resolveTmuxBin(
        { ATMUX_TMUX_BIN: missing },
        undefined,
        () => {},
        createResolveTmuxBinState(),
      ),
    ).toThrow(/no such file/);
  });

  test("AC#3 — vendored at synthetic path (existsSync override) → returned", () => {
    const state = createResolveTmuxBinState();
    const r = resolveTmuxBin(
      {},
      (p) => p === VENDORED_TMUX_PATH,
      () => {},
      state,
    );
    expect(r).toBe(VENDORED_TMUX_PATH);
  });

  test("AC#4 — vendored absent + real system tmux on PATH → resolves + warn-once", () => {
    // Skip if no tmux on the test PATH at all. On any atmux dev or CI
    // env this is always populated (atmux's own dep), but the gate
    // keeps the test honest about its assumption.
    const probe = require("node:child_process").spawnSync("which", ["tmux"], { encoding: "utf8" });
    if (probe.status !== 0) {
      console.warn("skipping AC#4 — no `tmux` on PATH");
      return;
    }
    const expectedAbs = probe.stdout.trim();
    expect(expectedAbs.length).toBeGreaterThan(0);

    const warns: string[] = [];
    const state = createResolveTmuxBinState();
    // Force tier 2 to miss while tier 3 (default pathProbe) probes real PATH.
    const r1 = resolveTmuxBin({}, () => false, (s) => warns.push(s), state);
    const r2 = resolveTmuxBin({}, () => false, (s) => warns.push(s), state);
    expect(r1).toBe(expectedAbs);
    expect(r2).toBe(expectedAbs); // cached
    expect(warns).toHaveLength(1); // warn-once
    expect(warns[0]).toContain(VENDORED_TMUX_PATH);
    expect(warns[0]).toContain(expectedAbs);
  });

  test("AC bootstrap — vendored absent + custom empty PATH probe → throws", () => {
    expect(() =>
      resolveTmuxBin(
        {},
        () => false,
        () => {},
        createResolveTmuxBinState(),
        () => null,
      ),
    ).toThrow(/cannot find tmux/);
  });
});

describe("ADR-191 — atmux doctor end-to-end probe smoke", () => {
  test("`atmux doctor` surfaces vendored-tmux-missing row on this cage", async () => {
    // /opt/atmux/current/bin/tmux is absent on this development box
    // (the whole premise of the unshipped-impl Epic). The doctor
    // probe wired in this same commit should report a yellow row.
    // We run atmux doctor via bun --bun-direct invocation to avoid
    // depending on the installed /usr/local/bin/atmux binary which
    // may lag the source.
    const r = await spawn({
      cmd: process.execPath, // bun binary
      argv: ["run", join(REPO_ROOT, "bin/atmux-entry.ts"), "doctor"],
      cwd: REPO_ROOT,
      expectExitCode: "any",
      timeoutMs: 60_000,
    });
    // doctor may exit non-zero when blockers exist (e.g. lead pane
    // down warnings or other env state) — we only assert on the row.
    const combined = `${r.stdout}\n${r.stderr}`;
    expect(combined).toContain("vendored-tmux-missing");
    expect(combined).toContain("/opt/atmux/current/bin/tmux");
  });
});
