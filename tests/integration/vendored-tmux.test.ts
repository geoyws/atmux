// Contract test — ADR-191 tmux resolution split.
//
// Exercises the split tmux resolution contract with injected probes
// only. Legacy atmux calls still resolve via `resolveTmuxBin()`
// (override → PATH only); the vendored candidate uses the separate
// `resolveVendoredTmuxBin()` helper.
//
// Coverage per Epic e-1-b71bf640 T6 AC:
//   1. ATMUX_TMUX_BIN set to a known-existing path → returned verbatim.
//   2. ATMUX_TMUX_BIN set + missing → throws operator-actionable error.
//   3. ATMUX_TMUX_BIN unset + PATH has tmux → returns system-resolved
//      absolute path silently.
//   4. `resolveVendoredTmuxBin()` with a tmpdir-backed synthetic
//      vendored binary → returned.
//   5. `resolveVendoredTmuxBin()` with missing vendored binary →
//      throws fail-closed.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VENDORED_TMUX_PATH,
  createResolveTmuxBinState,
  createResolveVendoredTmuxBinState,
  resolveTmuxBin,
  resolveVendoredTmuxBin,
} from "../../src/core/resolve-tmux-bin.ts";

describe("ADR-191 resolveTmuxBin — injected probe contract", () => {
  let scratch: string;
  let fakeTmux: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "atmux-vendored-tmux-"));
    fakeTmux = join(scratch, "fake-tmux");
    await writeFile(fakeTmux, "#!/bin/sh\necho 'tmux 3.7c'\n");
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

  test("AC#3 — ATMUX_TMUX_BIN unset + PATH probe returns a tmux path → resolves silently", () => {
    const state = createResolveTmuxBinState();
    const r1 = resolveTmuxBin({}, () => false, () => {}, state, () => "/usr/local/bin/tmux");
    const r2 = resolveTmuxBin({}, () => false, () => {}, state, () => "/usr/local/bin/tmux");
    expect(r1).toBe("/usr/local/bin/tmux");
    expect(r2).toBe("/usr/local/bin/tmux"); // cached
  });

  test("AC#4 — vendored helper at synthetic path (existsSync override) → returned", () => {
    const state = createResolveVendoredTmuxBinState();
    const r = resolveVendoredTmuxBin(
      {},
      (p) => p === VENDORED_TMUX_PATH,
      state,
    );
    expect(r).toBe(VENDORED_TMUX_PATH);
  });

  test("AC#5 — vendored helper absent + empty probe → throws fail-closed", () => {
    expect(() =>
      resolveVendoredTmuxBin(
        {},
        () => false,
        createResolveVendoredTmuxBinState(),
      ),
    ).toThrow(/cannot find vendored tmux/);
  });
});
