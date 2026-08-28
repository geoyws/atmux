# ADR-277 — Cages scrub `NO_COLOR` from their tmux server environment

Status: accepted
Date: 2026-08-18 (operator-direct: *"yes, fix atmux and the three servers"*)
Amended by: [ADR-281](281-tmux-child-environment-scrub-at-the-spawn-seam.md) (2026-08-28) — **§D1's sentence "Because atmux passes `-f <this file>` on every invocation (ADR-162), this covers every cage, however it was launched" is RETRACTED.** `-f` is only on the argv when the caller supplied a `configFile`, and the conf only loads for the command that actually starts the server — which, against a dead socket, can be `attach` or even `list-keys`. Measured 2026-08-28 on geoywsMBP: 6 of 47 live servers had never loaded any atmux conf, and 2 of those carried a live `NO_COLOR=1`. ADR-281 adds a scrub at the `spawn()` seam beside this one; everything else in this ADR stands, and this file is not rewritten (append-only).

Relates: [ADR-162](162-atmux-owns-tmux-infrastructure.md) (atmux owns the canonical tmux.conf — this adds to that baseline), [ADR-171](171-tmux-conf-local-override.md) (the operator override that must still be able to win; note the conf header's forward-reference to "ADR-163" for that path is stale — ADR-163 is the bundled-tmux-binary decision), [ADR-190](190-tmux-statusline-scaling.md) (the sibling conf invariant, same guard-file family)

## Context

The operator reported his Claude Code TUI rendering greyscale in the `kanban` cage, and asked why it was *still* greyscale after restarts.

Measured on hax, 2026-08-18:

```
tmux server 2341901  -S /tmp/atmux-tmux_kanban/tmux-0/default   NO_COLOR=1
  └─ -zsh 3091371                                                NO_COLOR=1
      └─ claude 3095643                                          NO_COLOR=1
```

That server's own environ also carries `CLAUDECODE=1`, `CLAUDE_CODE_ENTRYPOINT=cli`, `CLAUDE_CODE_SESSION_ID=…`, `TERM=dumb` and an empty `COLORTERM`. Those are the fingerprints of Claude Code's Bash-tool environment: **the cage was created from inside an agent's Bash tool**, which sets `NO_COLOR=1` so captured command output is plain text. That is correct behaviour for a captured subprocess and wrong behaviour for a long-lived interactive cage.

The mechanism that makes it persist:

1. A tmux **server** freezes its own environ at start and initialises the global environment from it.
2. Every pane the server creates thereafter — for the life of the server — is built from that global environment.
3. tmux re-derives `TERM` per pane from `default-terminal`, so `TERM=dumb` never reaches a pane. **`NO_COLOR` is not in `update-environment`**, so it does.
4. `NO_COLOR` is a cross-tool convention. Claude Code, codex and opencode all honour it and strip every style.

Hence "still": restarting the pane, or the TUI, or `claude` itself changes nothing. Only the server's environment does, and nothing was rewriting it.

Scope at time of writing: 3 of ~24 live tmux servers were affected — the `kanban`, `dash` and `geoyws/src/root` cages. Every cage started from a real terminal was clean. This is not a rare accident; **starting a cage from inside an agent session is a normal way to start a cage**, so the fault recurs by construction.

Related environment leakage was observed and deliberately left alone (see §Out of scope).

## Decision

### D1 — The bundled cage conf removes `NO_COLOR` from the environment of new processes

`templates/tmux/atmux.conf` gains one directive:

```tmux
set-environment -gr NO_COLOR
```

`-g` puts it on the server's global environment, so every pane inherits the scrub rather than only the session current when the conf loads. `-r` marks the variable for **removal** from the environment of new processes — the correct verb whether or not the launching environment set it (a no-op when it did not). Setting it empty would be wrong: some consumers treat a defined-but-empty `NO_COLOR` as unset and others do not, and the intent here is "this variable does not exist in a cage".

Because atmux passes `-f <this file>` on every invocation (ADR-162), this covers every cage, however it was launched.

### D2 — The scrub is a default, not a lock

It stays **above** ADR-171's `source-file -q ~/.config/atmux/tmux.conf.local`, which loads last. An operator who genuinely wants monochrome cages re-sets `NO_COLOR` there and wins. Pinned by a test, because it is one conf-reordering away from becoming a lock.

### D3 — Live servers are repaired in place, not by restart

For each affected server:

```sh
tmux -S <sock> set-environment -gr NO_COLOR
```

This mutates only the global environment. Running panes keep their own environ and are **not** signalled, redrawn, or restarted; work in flight is untouched. New panes are clean immediately; an existing pane picks the fix up when its TUI is next relaunched (or after `unset NO_COLOR` in that pane's shell). Restarting the cage servers would have been the tidier-looking fix and would have destroyed live agent context — the same class of loss ADR-081 / ADR-085 guard against.

### D4 — The deployed template is patched in place; no version bump

Cages resolve the conf through `resolveTemplatesDir` → `/opt/atmux/<v>/templates/` (`src/core/templates-dir.ts`), and `/opt/atmux/current` → `0.8.30`. The conf is read **only when a server starts**, so patching the deployed `0.8.30` template affects new cages only and cannot disturb a running one. Cutting a release instead would swing `current` for the entire fleet to fix a one-line default — a much larger blast radius for no added benefit. `0.8.29` (which the atmux cockpit's own long-lived server was started from) is deliberately left alone: it is not `current`, so no new cage will read it.

## Consequences

- New cages, and new panes in repaired cages, render in colour regardless of how the cage was launched.
- One more directive in a conf whose header advertised an "8-option baseline". That number was **already** stale — ADR-190 added the explicit `status-interval` without amending it, making the shipped count 9. The header now records the discrepancy instead of quietly renumbering it, and ADR-162 §Decision-anchor #3 keeps its original text.
- A cage started from an agent Bash tool still inherits other variables from it (§Out of scope). This ADR fixes the one with a user-visible effect and does not pretend to have fixed the class.
- Guarded by `tests/regression/atmux-conf-no-color-scrub.test.ts`: three grep-style assertions (directive present, ADR pointer present, override still loads last) plus a **behavioural** test that starts a real tmux server with `NO_COLOR=1` in its environ, loads the shipped conf, and reads a real pane's environment. Its control leg runs the identical probe against a conf with the directive stripped and asserts `NO_COLOR=1` **does** arrive — so a green result cannot come from the probe never exercising the mechanism.

## Out of scope

`CLAUDECODE=1`, `CLAUDE_CODE_CHILD_SESSION=1`, `CLAUDE_CODE_SESSION_ID` and `CLAUDE_CODE_EXECPATH` also leak from the launching Bash tool into every pane of an agent-launched cage. `CLAUDE_CODE_SESSION_ID` in particular is a stale identifier being handed to processes that have nothing to do with that session. No user-visible fault has been traced to them, and scrubbing tool-detection variables could change how tools inside a cage behave — a separate decision with its own risk, not a rider on a colour fix. Recorded so the next reader finds it already seen rather than missed.
