# ADR-265: `atx` is the canonical shorthand for atmux

**Status**: accepted
**Date**: 2026-07-28
**Driver-ref**: George 2026-07-28 — "make atx the canonical shorthand for atmux from now on and write this to adrs"
**Relates**: [ADR-264](264-cockpit-session-atx-rename.md) (cockpit tmux session renamed to `atx` — this ADR generalises the literal into a project-wide shorthand).

## Context

"atmux" is short but gets typed constantly — in docs, ADRs, chat, commit discussion, and naming discussions — and projects like this drift into competing abbreviations when none is blessed. ADR-264 just gave `atx` a concrete anchor as the cockpit session literal; promoting it to the canonical shorthand (same shape as `k8s` for Kubernetes) gives one blessed short form and makes the cockpit session name doubly motivated: the cockpit is the canonical `atx` surface.

## Decision

### (D1) `atx` = atmux, in prose

`atx` is the canonical shorthand for the atmux project/tool in **prose contexts**: docs, ADR text, comments, chat, release notes, runbook narrative. Reads "ay-tee-ex" (or just "atmux" — the shorthand is orthographic, not a rename).

### (D2) Machine-facing names stay `atmux`

The shorthand never enters machine-facing identifiers. These remain `atmux`, unchanged:

- CLI command / binary / package / repo name (`atmux`, `bin/atmux`, `atmux-bun`)
- tmux naming schemes: team cages `atmux_<team>`, the `atmux-cockpit` socket
- Config keys, file paths (`.atmux/`, `cockpit.json`), env vars (`ATMUX_*`), wire formats, schema literals

Rule of thumb: if a computer parses it, it's `atmux`; if a human reads it, `atx` is fine.

### (D3) Overlap with the cockpit session literal

The cockpit tmux session is literally named `atx` (ADR-264), and per ADR-264 we still call it "the cockpit" in prose. So in prose `atx` means *the project*, and "the cockpit" means the operator surface; the session literal `atx` appears only in tmux-targeting commands (`tmux -L atmux-cockpit attach -t atx`). Where a runbook mixes both in one breath, prefer the full word `atmux` for the tool to keep the command block unambiguous.

### (D4) Forward-looking, not a rewrite

Existing docs/ADRs/release notes are not mass-edited — they stay period-accurate. The convention applies to new and touched content from this date.

## Consequences

- One blessed shorthand; no `atmx` / `atmuxx` / `ATM` drift in future docs.
- Zero code, schema, or wire-format impact — this is a prose convention with an ADR anchor.
- The ADR-264 cockpit session name gains a second rationale: the cockpit is where `atx` (the project) surfaces to the operator.

## Cross-references

- [ADR-264](264-cockpit-session-atx-rename.md) — cockpit session literal `atx`; gains an amendment note pointing here.
