# ADR-306 — `cockpit attach --live`: fast attach to the live cockpit, never creating one

Status: proposed
Date: 2026-10-01 (epic e-3caa18a2, kb t-671763e7; operator decision 2026-10-01)
Relates: [ADR-162](162-atmux-owns-tmux-infrastructure.md) (cockpit on `-L atmux-cockpit`), [ADR-180](180-human-attach-verb.md) (`--human` stdio shape), [ADR-264](264-cockpit-session-atx-rename.md) (session `atx`), dotfiles ADR-021 (2026-10-01 amendment: `aco` = fast attach, `aca` = ensure-up then attach)

## Context

`atmux cockpit attach` today always runs ensure-up first (the old `aco`
two-step collapsed into one invocation): cycle dead cages, reconcile the
cockpit session, then attach. That is the right default for `aca`, but it
is slow and mutating when the operator only wants to look at a cockpit
that is already up — and when the cockpit is down, ensure-up can create
servers and sessions as a side effect of "just attach me".

The operator's dotfiles already carry the answer: the `acl` shell
function (dotfiles ADR-021, amended 2026-10-01) attaches to the legacy
Homebrew-tmux cockpit with four properties atmux lacks — absolute `-S`
socket paths, a SIGUSR1 re-bind when the socket file is gone but the
server lives, a client-binary fallback order (server's own binary →
Homebrew → vendored → PATH), and a hard rule against ever running a
server-creating command. On 2026-10-01 George decided `aco` = fast
attach to whichever cockpit is LIVE (never creates, refuses when
ambiguous) while `aca` keeps ensure-up-then-attach.

## Decision

### D1 — `atmux cockpit attach --live` (attach-only flag)

`--live` is parsed like the other attach-only flags (`--human`,
`--no-ensure`, `--launch`): rejected on `reconcile` / `reload` /
`migrate-socket`. Flag interplay:

- `--live` **implies `--no-ensure`** — the branch sits before ensure-up
  in `cockpitAttach`, so no reconcile, no TUI launch, no window prune
  can run. `--live --no-ensure` together is redundant but accepted.
- `--live --launch` is **refused** (`UsageError`): `--launch` only
  affects ensure-up's TUI phase, which `--live` never runs. Failing fast
  beats silently ignoring the flag.
- `--live --human` is accepted: `--human` keeps its ADR-180 meaning
  (final attach inherits stdio; default stays piped).

### D2 — Candidate + probe semantics (ported from `acl`)

Candidates: the `ATMUX_COCKPIT_SOCKET` override alone when set
(non-empty), else `atmux-cockpit` + `atmux-vendored-cockpit` in that
order. The session name still comes from cockpit.json `cockpitSession`
(the override only selects the socket, never the session).

Each candidate is probed without the possibility of starting a server:

1. The socket node must exist **and** be a socket (lstat, no follow),
   **and** a plain `connect()` dial must be accepted, before any tmux
   client runs — a `has-session` against a dead/absent path would make
   tmux implicitly start a server. A non-socket node or a dead socket
   is skipped, never handed to tmux.
2. Missing socket + a matching server process (found by its own argv
   `-L <name> … new-session`, so attach clients are never matched):
   recreate the 0700 parent dir when absent, SIGUSR1 the server(s) so
   tmux re-binds the socket, poll the dial up to ~2s (20 × 100ms).
   No server process → not live, stop (never a server-creating command).
3. Client fallback per live socket: the server's own binary when
   readable from its argv, then `/opt/homebrew/bin/tmux`, then
   `/opt/atmux/current/bin/tmux`, then PATH tmux — existence-gated and
   de-duplicated. The first binary whose
   `tmux -S <abs path> has-session -t =<session>` succeeds **and** whose
   `list-windows` reports ≥1 window owns the attach. Every client runs
   with `-S <absolute path>` so an exported `TMUX_TMPDIR` cannot
   redirect it.

### D3 — One / none / many

- Exactly one live candidate → attach with the answering binary
  (with the `attachWithTmux` `$TMUX`-unset around the exec).
- None live → one-line hint naming `aca` (which starts the cockpit),
  exit 1.
- More than one live → warn-list each (socket path, session, window
  count, server `#{version}`), refuse with exit 1; the operator
  disambiguates with `ATMUX_COCKPIT_SOCKET`.

### D4 — Seams

All process/fs/tmux effects live behind `LiveCockpitAttachOpts`
(`src/core/cockpit-live-attach.ts`), defaulting to the ported-`acl`
behaviour; `CockpitOpts.cockpitLiveDeps` threads test fakes through
`cockpitAttachLive`. Unit tests never touch host sockets, servers, or
tmux binaries; the e2e file uses throwaway servers under an isolated
`TMUX_TMPDIR` and fakes only the final blocking attach exec (headless
runners have no tty — the same boundary `src/verbs/attach.ts`
already stubs).

## Consequences

- `aco` (dotfiles) can move to `atmux cockpit attach --live`: same
  semantics, tested, documented, and available on every machine — not
  just shells that source the operator's `acl`.
- The `atmux-vendored-cockpit` name is new surface (no ADR-163/191
  socket by that name existed); it is only ever *dialled*, never
  created, by `--live`. Whatever later owns that socket inherits a
  client that already knows how to reach it.
- Ambiguity refuses rather than guesses: after a migration window with
  two live cockpits, `aco` stops instead of attaching to the wrong one
  until the operator sets `ATMUX_COCKPIT_SOCKET`.
