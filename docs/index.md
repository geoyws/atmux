---
layout: home

hero:
  name: atmux
  text: agent teams multiplexer
  tagline: one tmux session per project team, one window per agent — coordinated through tmux, not an API
  actions:
    - theme: brand
      text: Get started
      link: /GETTING_STARTED
    - theme: alt
      text: Architecture
      link: /ARCHITECTURE
    - theme: alt
      text: View on GitHub
      link: https://github.com/geoyws/atmux

features:
  - icon: 🧭
    title: Driver → Lead → Workers
    details: |
      Your terminal is the driver. The team-lead routes asks; the planner
      decomposes; workers pull tasks per feature lane. All inside tmux.
  - icon: 🐝
    title: Multi-TUI parallelism
    details: |
      Claude Code for staff (lead, planner, reviewer, gitter, devops, dba).
      Cursor / OpenCode / Kimi / MiniMax for cheap parallel workers per lane.
  - icon: 📋
    title: Pull-kanban + ADRs
    details: |
      Workers self-claim by lane priority via `atmux claim --next`. Lead
      never plans; the planner owns decomposition + ADR authorship.
  - icon: 🤖
    title: Cron-fired hygiene
    details: |
      `whip` (5 min watchdog) + `report` (30 min digest) + `decisions
      digest` (4h) + `groom` (daily) keep teams self-coordinating without
      a daemon.
  - icon: 💰
    title: Budget-aware
    details: |
      Layer 1 OAuth probe surfaces Claude Max budget remaining
      authoritatively. Auto-pauses team-wide when ≤10% remaining; resumes
      at 20% (10pp hysteresis).
  - icon: 🔌
    title: No daemon, no API
    details: |
      tmux is the IPC. State lives on disk in `.atmux/` — greppable,
      diffable, survives tmux restart, replays on `atmux start`.
---

## Why atmux

A multi-TUI agent orchestrator built around three durable principles:

1. **tmux is the IPC.** atmux doesn't speak any AI provider API. It writes
   shell commands into tmux panes via `tmux send-keys` and reads responses
   via `tmux capture-pane`. Works with any interactive coding-agent TUI —
   Claude Code, Cursor, OpenCode, Kimi, or any future one.
2. **State lives on disk, in JSON / markdown.** `.atmux/` is greppable,
   diffable, and survives tmux restarts.
3. **No daemon.** Every verb is idempotent. `whip` and `report` run on cron.

See the [PRD](/PRD) for the full vision + roadmap, or the
[architecture doc](/ARCHITECTURE) for the principles in detail.

## Quickstart

```bash
# 1. Install
curl -fsSL https://raw.githubusercontent.com/geoyws/atmux/main/install.sh | bash

# 2. In your project
cd ~/code/my-project
atmux                  # one-stop: wizard → doctor → start → attach

# 3. Drive the team
atmux tell-lead "build a /healthz endpoint with 100% test coverage"
atmux status           # team pulse
atmux outbox           # read lead's async replies
```

Read the [getting started guide](/GETTING_STARTED) for the full walkthrough.
