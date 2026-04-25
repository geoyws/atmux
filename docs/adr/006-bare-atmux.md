# ADR-006: Bare `atmux` as one-stop bring-up

**Status**: accepted
**Date**: 2026-04-25

## Context

Onboarding a new project required remembering a command sequence: `atmux init --wizard` → `atmux doctor` → `atmux start` → `atmux attach`. Every step had its own failure mode, and first-time users frequently missed `doctor` and hit start-time errors.

## Decision

**Bare `atmux` (no args) is aliased to a new `up` verb** that runs the full onboarding flow:

```
atmux
  ├── if no team.json → prompt with CWD shown prominently; on y, run wizard
  ├── run doctor preflight (silent on green, full report on red then abort)
  ├── if no tmux session → start
  └── if on TTY and not already inside tmux → attach
```

Re-running `atmux` after the session is up is idempotent — it just reattaches. Inside an existing tmux, it prints the session name + `switch-client` hint instead of fighting for the terminal.

`atmux help` / `atmux --help` / `atmux -h` / `atmux --version` / `atmux -V` still print help/version — the bare-command shortcut only fires when there's nothing at all after the binary name.

## Consequences

### What we gain
- One command onboarding. "curl install.sh | bash, then type `atmux`" is the whole story.
- Idempotent — the same command works for day-1 setup, day-N reattach, cron health-check (with `--no-doctor` / non-TTY branch).
- Scriptable verbs are untouched: explicit `atmux start` still works for scripts that need predictability.

### What we give up
- Convention: "bare command → help" is the most common CLI default. Users who expected that get a behavior that starts spawning real agents. Mitigation: the wizard gate requires explicit `y` confirmation before any `.atmux/` or tmux state is created, showing the CWD prominently so no one scaffolds in the wrong directory.
- `atmux` in a piped context (non-TTY) has more branches than a normal verb: skip wizard prompt, skip attach, run doctor only. Documented but non-trivial to explain.

### Alternatives considered
- **`atmux up` only, no bare alias.** Rejected — defeats the "just type atmux" goal. The explicit verb is kept for scripts and completions; the alias exists for humans.
- **Interactive menu on bare `atmux`.** Rejected — slower than just doing the right thing, and worse UX than the wizard gate which only prompts when there's ambiguity.
