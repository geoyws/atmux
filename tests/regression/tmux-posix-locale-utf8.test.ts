// t-48cef478 — every atmux tmux CLIENT call carries `-u` (UTF-8).
//
// Measured 2026-10-01 (Linux container, tmux 3.6a and 3.5a): with no UTF-8
// locale (LANG unset, LC_CTYPE=POSIX) the tmux CLIENT prints a literal TAB
// inside a `-F` format as `_`; `tmux -u` (or LC_CTYPE=C.UTF-8) keeps the
// TAB. atmux parses list-windows/list-panes output as tab-separated
// (`parseTabular`), so on a POSIX-locale Linux host (container, cron,
// systemd) every window/pane lookup returned nothing while macOS dev
// shells (UTF-8 locale) stayed green.
//
// This test runs createTmux-driven newSession + listWindows with LANG,
// LC_ALL and LC_CTYPE removed from process.env for the duration and
// asserts the window is found by name with parsed fields. Without the
// `-u` prefix the `-F` TABs arrive as `_`, the row collapses to one
// column, and the lookup finds nothing — the test fails.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TmuxNamespace } from "../../src/abstractions/tmux.ts";
import { resolveTmuxBin } from "../../src/core/resolve-tmux-bin.ts";
import { createCanonicalAtmuxTmux, setCanonicalAtmuxTmuxHome } from "../helpers/tmux.ts";

/** The tmux binary the code under test spawns (same three-tier chain). */
const TMUX_BIN: string | null = (() => {
  try {
    return resolveTmuxBin();
  } catch {
    return null;
  }
})();
const HAS_TMUX = TMUX_BIN !== null;

// @skip-reason: starts a REAL tmux server; gated on a resolvable binary.
describe.if(HAS_TMUX)("t-48cef478 — tab-separated parses survive a POSIX locale", () => {
  let socketDir = "";
  let homeDir = "";
  let tmux: TmuxNamespace | null = null;
  let restoreHome: (() => void) | undefined;
  let priorTmux: string | undefined;
  let priorLang: string | undefined;
  let priorLcAll: string | undefined;
  let priorLcCtype: string | undefined;
  const session = `posix_${Date.now().toString(36)}`;

  beforeEach(async () => {
    // Short prefix: unix socket paths cap near 108 bytes.
    socketDir = await mkdtemp(join(tmpdir(), "atmux-posix-"));
    await chmod(socketDir, 0o700);
    homeDir = await mkdtemp(join(tmpdir(), "atmux-posix-home-"));
    restoreHome = setCanonicalAtmuxTmuxHome(homeDir);
    priorTmux = process.env.TMUX;
    delete process.env.TMUX;
    // The POSIX-locale condition: no UTF-8 locale anywhere. Saved here,
    // removed for the test body, restored in afterEach.
    priorLang = process.env.LANG;
    priorLcAll = process.env.LC_ALL;
    priorLcCtype = process.env.LC_CTYPE;
    delete process.env.LANG;
    delete process.env.LC_ALL;
    delete process.env.LC_CTYPE;
    tmux = createCanonicalAtmuxTmux({ socketPath: join(socketDir, "sock") });
  });

  afterEach(async () => {
    await tmux?.server.killServer().catch(() => {});
    tmux = null;
    restoreHome?.();
    restoreHome = undefined;
    if (priorTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = priorTmux;
    if (priorLang === undefined) delete process.env.LANG;
    else process.env.LANG = priorLang;
    if (priorLcAll === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = priorLcAll;
    if (priorLcCtype === undefined) delete process.env.LC_CTYPE;
    else process.env.LC_CTYPE = priorLcCtype;
    await Promise.all(
      [socketDir, homeDir].map(async (dir) => await rm(dir, { recursive: true, force: true })),
    );
  });

  test("listWindows finds the session window by name with parsed fields", async () => {
    const ns = tmux as TmuxNamespace;
    await ns.session.newSession({ name: session, windowName: "posixwin" });
    expect(await ns.session.hasSession(session)).toBe(true);
    const windows = await ns.window.listWindows(session);
    const found = windows.find((w) => w.name === "posixwin");
    // Without `-u` on the client argv the `-F` TABs arrive as `_`, the row
    // collapses to a single column, and no window parses with this name.
    expect(found).toBeDefined();
    expect(found?.id.startsWith("@")).toBe(true);
    expect(found?.active).toBe(true);
  });
});
