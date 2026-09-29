# ADR-303 — Every production tmux argv carries `-f <atmux conf>`

Status: accepted (reviewer signoff 2026-09-29)
Date: 2026-09-29 (t-2ff4f48e)
Amends: [ADR-277](277-cage-color-environment-scrub.md) (arrival half; the false "covers every cage, however it was launched" premise was already retracted by [ADR-281](281-tmux-child-environment-scrub-at-the-spawn-seam.md))
Relates: [ADR-162](162-atmux-owns-tmux-infrastructure.md) (canonical conf ownership), [ADR-281](281-tmux-child-environment-scrub-at-the-spawn-seam.md) (spawn-seam scrub — the sibling layer; this ADR is the conf-arrival layer)

## Context

ADR-277's scrub (`set-environment -gr NO_COLOR` in `templates/tmux/atmux.conf`) only reaches a server when `-f` is on the argv of the command that CREATED it — and tmux starts a server implicitly for ANY subcommand against a dead socket. Measured 2026-08-28 across 47 live servers (t-2ff4f48e): `rx`/`hrx` carried live `NO_COLOR=1` from a bare `new-session` with no `-f`; six servers had never loaded any atmux conf; `hx`'s server was created by `list-keys`, `grp-geoyws`'s by `attach`. The creating argv cannot be identified by subcommand, so auditing "session-creation call sites" is the wrong shape: any invocation can be the creating one.

## Decision

### D1 — Every production `createTmux` namespace pins the canonical conf

All ~35 production construction sites now pass `configFile: getAtmuxTmuxConfPath()` (honouring the `ATMUX_TMUX_CONF` escape hatch). Read-only callers are included deliberately: `-f` is inert when the server already exists, so pinning it everywhere costs nothing and closes the whole class. The `TmuxConfig.configFile` field stays optional in type — tests and the `WithoutConfigFile` helper rely on that — but the contract is documented on the type: optional in type, REQUIRED in production.

### D2 — Raw cage-socket spawns splice `-f` after the socket flag

Two paths bypass the factory: `fallback-cage.ts` teardown (`capture-pane` probe + both `kill-session` branches) and `poke.ts::sendCageBrief` (operator + sudo branches). Both target cage sockets and both can be first on a dead one; both now carry `-f <conf>`.

### D3 — Deliberately NOT changed

- Read-only probe argv with no socket pinning (`doctor`'s `defaultTmuxSpawn`, the cursor-recipes unpinned `list-windows`): left byte-identical. ADR-281's `unsetEnv` already keeps a server they implicitly start from freezing `NO_COLOR` in; pointing an unpinned probe at the atmux conf would atmux-ify the operator's own server on creation, a larger blast radius than the fault.
- Row items deferred as follow-ups, not riders: the conf-provenance sentinel (`ATMUX_CONF_VERSION`), `atmux doctor` environment checks, the `has-server` guard against implicit creation, and making `configFile` a required field.

## Consequences

- A server born through any atmux path loads the ADR-277 scrub even when its parent environment carries `NO_COLOR=1`.
- Guarded by `tests/unit/abstractions/tmux-conf-creating-paths.test.ts` (argv recording through the `Bun.spawn` seam: every exported production factory + the attach / vox-supervise / killServer creating paths, with a conf-less control leg proving sensitivity) and two live-server legs in `tests/regression/atmux-conf-no-color-scrub.test.ts` (atmux-factory server under `NO_COLOR=1` arrives clean; the bare no-`-f` fault shape stays dirty, proving the probe observes the mechanism).
