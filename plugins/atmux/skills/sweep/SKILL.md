---
name: sweep
description: Fleet-wide diagnose + complain sweep — runs `atmux doctor` and `atmux status --json` across every enabled team, files complaints on anomalies, and takes structural fixes (rotate lead, clear member, push branch fix). Persisted host-pressure playbook (per ADR-198) is one trigger. Per ADR-077 substrate; manually invoked (the auto-spawned cockpit role was retired per ADR-212).
argument-hint: "[run | once | dry-run]"
---

<!-- generalization-pending -->
