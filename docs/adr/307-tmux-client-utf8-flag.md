# ADR-307 — Every atmux tmux client call carries `-u` (UTF-8)

Status: proposed (t-48cef478)
Date: 2026-10-01
Relates: [ADR-303](303-tmux-conf-on-every-production-argv.md) (sibling "every argv" rule — the `-f` creating-argv layer; this ADR is the client-encoding layer)

## Context

Measured 2026-10-01 (Linux container, tmux 3.6a and 3.5a): with no UTF-8 locale (LANG unset, LC_CTYPE=POSIX) the tmux CLIENT prints a literal TAB inside a `-F` format as `_`; `tmux -u` (or LC_CTYPE=C.UTF-8) keeps the TAB. atmux parses list-windows/list-panes output as tab-separated (`parseTabular` in `src/abstractions/tmux.ts`), so on a POSIX-locale Linux host (container, cron, systemd) every window/pane lookup returned nothing. macOS dev shells carry a UTF-8 locale, so the suite stayed green there — the fault is environment-dependent, not code-path-dependent, which is why it escaped.

Reproduced on macOS too: under `env -i` (no locale variables at all, not even `__CF_USER_TEXT_ENCODING`) vendored tmux 3.6a prints `a_b` for `-F 'a\tb'`; with the shell's `__CF_USER_TEXT_ENCODING` present the TABs survive, which is why a naive macOS probe looks clean.

## Decision

### D1 — `-u` leads every atmux tmux client argv

`-u` is a tmux global flag (forces UTF-8 on the client) and sits with the other global flags before the subcommand. Injection points, one per raw spawn site:

- `createTmux`'s `socketArgs` prefix (`src/abstractions/tmux.ts`) — covers every namespaced call including attach and buffer paths: `tmux -u -L <name> …` / `tmux -u -S <path> …`.
- `socketDial` (`src/verbs/socket-dial.ts`) — covers every cockpit viewer-loop dial at runtime (`attach -t …` strings need no edit; the `-u` is injected here, not in the shell string).
- Doctor's `rawTmuxSpawn` (`src/verbs/doctor/types.ts`) — covers all probes including `tmux -V`; `guardTmuxArgv` tolerates the leading `-u` when locating the socket flag.
- Raw sites: `fallback-cage.ts` teardown (capture probe + sudo kill), `poke.ts::sendCageBrief` (operator + sudo branches), `test-reaper.ts` kill-server, the cursor-recipes unpinned `list-windows`, and the `start-preflight.ts` `tmux -V` version probe.

No LANG/LC_* is set anywhere as part of this fix: forcing a locale on the operator's process (or the cage server's frozen environ) has a larger blast radius than a client-side rendering flag.

### D2 — Deliberately NOT changed

- Test-only raw tmux probes (fixture setup/teardown in `tests/`) — they assert no src argv and parse no tabs; left byte-identical.
- Viewer-loop shell strings (`attach -t …` in `cockpit.ts`) — covered at runtime by the `socketDial` injection; editing each string would duplicate the flag.

## Consequences

- Tab-separated parses are locale-independent on every atmux-driven call.
- Guarded by `tests/regression/tmux-posix-locale-utf8.test.ts` (real tmux server, LANG/LC_ALL/LC_CTYPE removed for the duration: `listWindows` finds the window by name; verified failing with the `socketArgs` `-u` reverted) and argv-shape updates in `tests/unit/abstractions/tmux.test.ts` + `tests/unit/verbs/socket-dial.test.ts`.
