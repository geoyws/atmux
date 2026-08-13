# ADR Index

> Generated 2026-05-24, refreshed 2026-06-05 (MYT) — extended through ADR-256 + backfilled 222/223. Refreshed again 2026-08-06 — extended through ADR-269: backfilled the five missing rows 262–266 (the index stopped at 261) and added the 2026-08-06 operator-ask batch (267 continuity / 268 managed-repo state isolation / 269 recursive branch ledger). Refreshed again 2026-08-14 — extended through ADR-272: added 272 (voice operator interface) and backfilled the missing 271 row (ADR-271 §D9 item 7 deferred its own index edit to avoid a concurrent clobber). **ADR-270 is a deliberate gap in the sequence — no such ADR exists and none is missing.** Live ADRs only; superseded ADRs at the bottom for trace.

## Live ADRs

| ID | Title | Date | Status |
|----|-------|------|--------|
| 001 | Separate planner role from team-lead | 2026-04-25 | accepted |
| 002 | Wizard preset modes (perf / default / eco / custom) | 2026-04-25 | accepted |
| 003 | Per-member emoji auto-assignment | 2026-04-25 | accepted |
| 004 | Ephemeral feature specialists via `add-member` | 2026-04-25 | accepted |
| 005 | `atmux doctor` + silent start preflight | 2026-04-25 | accepted |
| 006 | Bare `atmux` as one-stop bring-up | 2026-04-25 | accepted |
| 007 | Pull-based kanban (Epic / Story / Task) | 2026-04-25 | accepted |
| 008 | `atmux decisions` verb — first-class decision log + Discord ping | 2026-04-25 | accepted |
| 009 | Robust auto-rotation infrastructure | 2026-04-25 | accepted |
| 010 | atmux flag — member→lead structured issue surfacing | 2026-04-25 | accepted |
| 011 | Erlang-style hot reload — brief / config / lib | 2026-04-25 | accepted |
| 012 | Test runner kill-resilience — bats fd-3 hygiene + per-test wallclock cap | 2026-04-25 | accepted |
| 013 | Kanban write atomicity — flock protocol enforcement | 2026-04-26 | accepted |
| 014 | Auto-dispatch depth guard + createdFrom audit trail | 2026-04-26 | accepted |
| 015 | Doctor checks expansion — cron health + phantom inbox detection | 2026-04-26 | accepted |
| 016 | Single-session topology — opt-in flag + Phase 2 migrate verb | 2026-04-26 | superseded by [ADR-026](./026-always-single-session-topology.md) (default policy |
| 017 | Logout-kill preflight — linger detection in doctor + start | 2026-04-27 | accepted |
| 018 | Per-team tmux socket isolation — opt-in via `team.tmuxTmpdir` | 2026-04-27 | accepted |
| 019 | Discord domain separator — per-team color palette + emoji glyph | 2026-04-27 | accepted |
| 020 | Decisions renderer richness gate — high-rev gets full expansion, medium/low gets compact | 2026-04-27 | accepted |
| 021 | `unblocker` role — dedicated blocker triage at 2-min cadence | 2026-04-27 | accepted |
| 022 | `discorder` role — scheduled-ping ownership split from lead | 2026-04-27 | accepted |
| 023 | Rate-limit detection — three-tier with Sonnet LLM judge | 2026-04-27 | accepted |
| 024 | Per-member model selection — Sonnet for read-only roles, Opus for writers | 2026-04-27 | accepted |
| 025 | atmux-superdriver Phase 1 — read-only fleet aggregator | 2026-04-27 | accepted (Phase 2 commit-gate superseded by ADR-034; implementation-shape detail |
| 026 | Always single-session topology — driver + members share session | 2026-04-27 | accepted |
| 027 | `atmux team rename` verb + startup topology invariant check | 2026-04-27 | shipped 2026-05-20 (EPIC e-1e223687) |
| 028 | `main` / `master` is PR-only — agents never push directly | 2026-04-27 | accepted |
| 029 | Driver + lead are scoped to own team; only superdriver messages cross-team | 2026-04-27 | accepted (audit-storage detail superseded by ADR-042 — JSONL file replaces `re |
| 030 | Registry-recorded animal emojis per member — immutable once written | 2026-04-27 | accepted |
| 031 | Aggressive parallelisation as the team default | 2026-04-27 | accepted |
| 032 | Socket pubsub as the messaging layer — supersedes file-write+keystroke-poll | 2026-04-27 | accepted (George 14:13 MYT 2026-05-08 — promoted to substrate-level pre-req pe |
| 033 | `driverOnly: bool` flag on kanban Tasks — load-bearing gate for driver-fires Tasks | 2026-04-27 | accepted (George 14:13 MYT 2026-05-08 — paperwork catch-up; implemented in `sr |
| 034 | Superdriver Phase 2 — drop the bypass-log commit gate, build now | 2026-04-28 | accepted |
| 035 | Per-member-branch model + recursive ops contract | 2026-04-29 | accepted |
| 036 | Supervisor-driven `/clear` on stuck panes — direct, with rotation log | 2026-04-30 | accepted (George 14:13 MYT 2026-05-08 — partially implemented in `src/core/sen |
| 037 | Doctor — orphan `atmux_*` session detector (namespace-scoped, no `--fix`) | 2026-04-30 | accepted (George 14:13 MYT 2026-05-08 — paperwork catch-up; implemented as Che |
| 038 | Declarative-vs-live audit model — class taxonomy + per-class auto-fix gating | 2026-05-02 | accepted |
| 039 | `enforcer` agent role — fleet-level audit consumer on the superdriver team | 2026-05-02 | accepted |
| 040 | Whip → audit sub-pass + `[whip-audit]` Discord template | 2026-05-02 | accepted |
| 041 | Token-savings — agents see slices, never full state files | 2026-05-02 | accepted |
| 042 | Superdriver Phase 2 — implementation shape (bidirectional comms + autonomous fleet awareness + cross-team writes) | 2026-05-02 | accepted |
| 043 | Whip auto-stop on prolonged team idleness | 2026-05-03 | accepted |
| 044 | Driver as window 1 of the team session | 2026-05-04 | accepted (replaces an earlier transient design — see Iteration history) |
| 047 | Canonical atmux install topology — `/usr/local/bin/atmux` symlinks to dev tree, `/opt/atmux-stable` is autopromote's tested-baseline fallback | 2026-05-05 | accepted |
| 050 | Multi-tier executor fallback chain — Tier 2 Cursor v1, Tier 3+ deferred | 2026-05-14 | Accepted (2026-05-15, operator-batch-flip) |
| 051 | — `cron_install` self-heals stale blocks + injects env preamble |  |  |
| 052 | Eternal-improvement loop — Mode A / Mode B autonomous cycle substrate | 2026-05-06 (original implement | accepted (2026-05-16, retrospective backfill per `t-75a79d7c`; substrate shipped |
| 057 | Stall prevention — D1-D7 mitigations against the 7 silent-stall classes | 2026-05-07 | accepted (2026-05-07) |
| 063 | Port `cockpit-rebuild` from operator dotfiles into `atmux cockpit` verb family | 2026-05-08 | accepted (implementation landed 2026-05-08) |
| 077 | superdoctor — self-healing cockpit role | 2026-05-08 | accepted |
| 078 | probeBudget read-only by default — refreshOnNearExpiry opt-in | 2026-05-09 | accepted |
| 079 | Discord noise drainage — wave 2 | 2026-05-09 | accepted (impl wave shipped + reviewer signoff 2026-05-09 13:53 MYT; status-flip |
| 080 | Operator-observed atmux improvements (sopx-driver bundle) | 2026-05-09 | accepted (impl wave shipped + reviewer signoff 2026-05-09 13:53 MYT; status-flip |
| 081 | Bootstrap brief-paste reliability — bracketed-paste Enter, role aliasing, supervisor-side recovery | 2026-05-12 | accepted |
| 082 | Per-member git worktree isolation — concurrency safety at 20+ member scale | 2026-05-12 | Accepted (2026-05-15, operator-batch-flip) |
| 084 | Per-member branch model for worktree isolation — amends ADR-082 OQ6 | 2026-05-12 | accepted |
| 085 | Whip approvals-watcher — surface proposed-ADRs, stale driver-asks, long-blocked tasks | 2026-05-12 | accepted (2026-05-14, all deps green — t-21c3aa64 whip §2.5 integration + Dis |
| 087 | `atmux stop --soft` + resume manifest | 2026-05-13 | Accepted (2026-05-15, operator-batch-flip) |
| 088 | Opt-in submodule init on worktree provision | 2026-05-13 | accepted |
| 089 | Hierarchical cockpit — recursive `sessions[]` + nested tmux prefix chain | 2026-05-13 | accepted |
| 090 | Epic-team lifecycle — `spawn-epic` / `dissolve-epic` verbs + `TeamEpic` schema + roster preset | 2026-05-15 | accepted |
| 091 | Kanban-driven auto-merge state machine — epic-team → parent fan-in | 2026-05-16 | accepted |
| 092 | Cross-team `tell-lead --team <name>` — cockpit-walk lookup + caller-scope gate | 2026-05-16 | accepted (2026-05-16, ships in same commit as impl T1 per planner-deferred decom |
| 093 | Consolidate `docs/adr-bun/` into `docs/adr/` — single tree per project | 2026-05-13 | accepted |
| 094 | c-alias spawn convention as first-class — bake defaults into `atmux::tui_claude` | 2026-05-13 | Accepted (2026-05-15, operator-batch-flip) |
| 095 | Why TypeScript on Bun (vs Go, Zig, staying in bash) |  |  |
| 096 | Module taxonomy (abstraction / core / domain) |  |  |
| 097 | tmux abstraction interface |  |  |
| 098 | JSON + locking model |  |  |
| 099 | Error handling discipline |  |  |
| 100 | Subprocess spawn pattern (`Bun.spawn` wrapper) |  |  |
| 101 | Discord webhook + chunking + named-template enforcement |  |  |
| 102 | Test strategy — `bun:test`, narrowed coverage, parity harness |  |  |
| 103 | CLI dispatcher choice |  |  |
| 104 | Side-by-side cutover protocol |  |  |
| 105 | Time + timezone handling (MYT discipline, UTC internals) |  |  |
| 106 | WIP-bash deferral (Phase 5 scope) |  |  |
| 107 | Verb design debt — deferred v2 redesign (Phase 6) |  |  |
| 108 | Team members work in isolated git worktrees by default |  |  |
| 109 | Schema-version rollout deferred to Phase 6 |  |  |
| 110 | tmux window naming — drop `__<team>__` prefix |  |  |
| 111 | Integration contract with `/coordination:*` Claude skills plugin |  |  |
| 112 | `doctor` verb (V-24) — port scope + deferred bash-only checks |  |  |
| 113 | `Writer` abstraction + shared `core/io.ts` for verb stdout/stderr injection |  |  |
| 114 | atmux as the runtime for `/coordination:session` + `/coordination:team` skills — verb contract |  |  |
| 115 | `whip` verb (V-25) — port scope + deferred bash-only checks |  |  |
| 116 | LLM judge cascade — resilience contract for SOFT rate-limit classifier (and any future judge call site) |  |  |
| 117 | Spawned-agent account matching — team members must run on the driver's claude account |  |  |
| 118 | `SendTarget` discriminated union — type-system enforcement of "no send-keys to driver pane" |  |  |
| 119 | Parity matrix iter-1 scope (refs ADR-102 §3) |  |  |
| 120 | Parity channel-mask contract (Option B per George 2026-05-05) |  |  |
| 121 | Phase 4a parity matrix — cron-fired lane scope (refs ADR-119, ADR-120) |  |  |
| 122 | Phase 3 iter-3 state-mutating lane scope (refs ADR-119 §Iter-3, ADR-120 mask contract) |  |  |
| 123 | Phase 4a parity matrix iter-3 read-only lane scope (refs ADR-119, ADR-120) |  |  |
| 124 | Parity matrix iter-2 — lifecycle lane scope (refs ADR-119, ADR-120) |  |  |
| 125 | Phase 4a iter-3 error-class expansion lane scope (refs ADR-119, ADR-120, ADR-122, ADR-123, ADR-124) |  |  |
| 126 | SQLite for `.atmux/` state, JSON archive-only |  |  |
| 127 | Lane-claim auto-pickup cron + universal supervision | 2026-05-08 | accepted (George 14:13 MYT 2026-05-08 — paperwork catch-up; T1/T2/T3 already s |
| 128 | Complete the driver-role port | 2026-05-08 | accepted (George 14:13 MYT 2026-05-08 — paperwork catch-up; T1/T2/T4 already s |
| 129 | Dogfood-meta — complaints lane, cross-team targeting, nomenclature taxonomy fix, hot-reload, live-status, rename-safe identity (bundled) | 2026-05-08 | accepted (George 14:13 MYT 2026-05-08 — *"accept it now and implement it now"* |
| 130 | Project layout |  |  |
| 131 | Medic kanban-hygiene auto-fix loop | 2026-05-14 | Accepted (2026-05-15, operator-batch-flip) |
| 133 | Rename superdoctor → medic (supersedes ADR-077 naming only) | 2026-05-14 | Accepted (2026-05-15, operator-batch-flip) |
| 134 | In-team auto-merger via expanded gitter role — per-member-branch fan-in | 2026-05-14 | Accepted (2026-05-15, operator-batch-flip) |
| 135 | Cockpit naming convention — `atmux_cockpit` session, `_role` cockpit windows, `<emoji>-<member>` hyphen separator | 2026-05-14 | Accepted (2026-05-15) |
| 136 | Hot-rename member labels (Option B — id + label + emoji split) | 2026-05-14 | Accepted (2026-05-15, operator-batch-flip) |
| 137 | Merge over rebase for intra-team trunk integration | 2026-05-14 | accepted |
| 138 | Verified send-keys — verify-and-retry pattern | 2026-05-14 | Accepted (2026-05-15, operator-batch-flip) |
| 139 | Refusal-pattern detection + auto-rotate (closes dormant-by-refusal failure class) | 2026-05-14 | Accepted (2026-05-15, operator-batch-flip) |
| 140 | Cheap-model-first principle — periodic scans move to martinet; medic event-driven | 2026-05-14 | Accepted (2026-05-15, operator-batch-flip) |
| 141 | Symlink Claude skills + memories across all accounts via dotfiles | 2026-05-15 | Accepted (2026-05-15, t-2736bfa9 ships scripts + ADR; dotfiles-repo init + execu |
| 142 | Modal-cycling detector — catch lead/member modal-soup-stuck patterns whip §1c misses | 2026-05-14 | Accepted (2026-05-15, operator-batch-flip) |
| 144 | epic-team test-gate — isolated branch-staging or cage e2e before merge to trunk | 2026-05-16 | accepted (T2/T3/T4 shipped 2026-05-17; T5 capstone 2026-05-17 — see §Amendmen |
| 145 | atmux team adopts gitter — supersedes "workers commit + push own work" pattern | 2026-05-14 | Accepted (2026-05-15, operator-batch-flip) |
| 146 | Kanban auto-files trunk-merge Task on Story-done — supersedes branch-watcher/cron suggestion | 2026-05-14 | Accepted (2026-05-15, operator-batch-flip) |
| 147 | Ombudsman role + release-notes layout — complaint adjudicator with durable response log | 2026-05-15 | accepted (Ombudsman ROLE half SUPERSEDED 2026-05-21 by [ADR-214](./214-retire-om |
| 148 | Commit-cadence as ground-truth health signal — close pane-alive ≠ shipping gap | 2026-05-15 | Accepted (2026-05-15, reviewer-signoff t-1e9fd74e) |
| 149 | Eternal-improvement gating — config disable toggle + backlog non-emptiness gate | 2026-05-15 | Accepted — ratified by driver 2026-05-21 (per-team enable/disable via `team.js |
| 150 | Cross-team complaint storage semantics — target-team-authoritative writes | 2026-05-16 | Accepted — ratified by driver 2026-05-21 (`--target-team` becomes authoritativ |
| 151 | `unblocker` — in-team kanban-blocked drainer, martinet-routed, Opus-authoritative | 2026-05-16 | accepted |
| 152 | `atmux blockers list` — unified verb fans across 7 surfaces with normalized rows + `blocker_class` taxonomy | 2026-05-16 | accepted (2026-05-16, ships in same commit as T1 impl per planner-deferred decom |
| 153 | Auto-promotion rules — kanban-blocked → complaint (24h) / driver-inbox → flag (12h) / lead-outbox → inbox_messages (6h) + `blocked_at` column | 2026-05-16 | Accepted — ratified by driver 2026-05-21 (3 idempotent threshold-keyed cron-dr |
| 154 | Driver-inbox + lead-outbox SQLite migration — markdown → canonical SQLite tables with rendered markdown view | 2026-05-15 | accepted |
| 155 | `atmux pane-state` — structured TUI-viewport verb to replace tail-10 heuristics | 2026-05-16 | accepted |
| 157 | `/goal` as primary drain for Claude service-loop roles — lane-tick narrows to backstop | 2026-05-16 | accepted (2026-05-16, planner-decomp T1; pending reviewer pre-flag → accepted) |
| 159 | gitter → committer rename — SV register sweep, OSS-canon vocabulary | 2026-05-16 | accepted |
| 160 | whip → poke rename — SV register sweep, atmux-internal scope | 2026-05-16 | accepted |
| 161 | default-member `_-prefix` convention + window-name format split + topographic-normalization verbs | 2026-05-16 | accepted |
| 162 | atmux owns its tmux infrastructure — cockpit-socket isolation + canonical tmux.conf + version-check | 2026-05-16 | accepted |
| 163 | atmux bundles its own tmux binary — version-lock + config-pin | 2026-05-16 | accepted |
| 164 | `atmux sync claude-team-json` — materialize `.claude/team.json` from `.atmux/team.json` | 2026-05-16 | accepted |
| 165 | `atmux team set / get / unset` — CLI surface for `team.json` config edits | 2026-05-16 | Accepted — ratified by driver 2026-05-21 (`atmux team set/get/unset <dot.path> |
| 166 | `team.json.autonomy` shared policy block — aggression dials read by all action-class actors | 2026-05-16 | Accepted — ratified by driver 2026-05-21 (`team.json::autonomy` shared policy  |
| 167 | `atmux cockpit rotate <session-name>` — Rung C canonical rotation verb | 2026-05-16 | accepted (2026-05-18 — EPIC e-0b90d6ac code-complete: T2 c376f63 / T3 5245e39  |
| 168 | send-keys-failures.log rotation policy — closes ADR-138 §Escalation log open question | 2026-05-17 | accepted |
| 169 | state.db migration for residual `.atmux/state/*.json` — 3-phase decomp (flags / role_state / budget) | 2026-05-17 | Accepted — ratified by driver 2026-05-21 (3-phase state.db migration: flags /  |
| 170 | — `atmux team sweep-epics` verb: enumerate + safely dissolve idle epic-teams |  |  |
| 171 | Cage tmux user override conf — `~/.config/atmux/tmux.conf.local` | 2026-05-18 | Accepted — ratified by driver 2026-05-21 (append `source-file -q ~/.config/atm |
| 172 | Stop GitHub Actions CI on geoyws/atmux until things stabilise |  |  |
| 173 | `atmux epic show <eid>` — enumerate child Stories + Tasks | 2026-05-18 | proposed (deferred: epic show children block absent in `src/verbs/epic.ts` as of |
| 174 | `atmux task list` — add `--epic <eid>` and `--story <sid>` filters | 2026-05-18 | proposed (deferred: task list `--epic`/`--story` flags rejected by CLI as of 202 |
| 175 | `atmux story signoff` verb + `mergeMode` story field for trunk-direct stories | 2026-05-18 | accepted |
| 176 | EPIC-aware lane-drift-revert — skip parents with progressing children | 2026-05-17 | Accepted — ratified by driver 2026-05-21 (4th criterion (d) `epic-children-pro |
| 177 | Whip Velocity-Gate — ground-truth classifier + strike counter |  |  |
| 178 | Test-cage leak reaper — spinTmux sidecar + `atmux test-reaper` verb | 2026-05-18 | proposed (deferred: impl not yet shipped; `atmux test-reaper` verb absent + no ` |
| 179 | Per-member-branch fan-in policy — `<base>-<member>` → `<base>` merger model | 2026-05-14 | Accepted (2026-05-15, operator-batch-flip) |
| 180 | Human-attach verb (`--human` flag, TTY-inherit spawn carve-out) |  |  |
| 181 | ADR 181 — Global RAM-budget gate on epic-team + /team start spawn |  |  |
| 182 | ADR 182 — Auto-reap epic-team on successful epic-merge |  |  |
| 184 | Host-wide epic-team cap + spawn queue + dormancy audit | 2026-05-18 | Accepted — ratified by driver 2026-05-21 (host-wide cap=8 + queue + dormancy a |
| 186 | Unified wedge-clearing mechanism — doctor probe library + sentinel runner + `atmux wedges` verb + tiered auto-clear | 2026-05-19 | Accepted — ratified by driver 2026-05-21 (3 extensions: doctor probe-class reg |
| 187 | Coordination skills plugin — operator-facing Claude Code skills that pair with atmux | 2026-05-20 | Accepted — ratified by driver 2026-05-21 (9-skill plugin mapping ↔ atmux ver |
| 188 | TUI send-keys canonical 4-step pattern (scroll → Enter×3 → paste → Enter×3) | 2026-05-20 | Accepted — ratified by driver 2026-05-21 (4-step canonical: scroll → Enter× |
| 189 | Lean-mode side-project topology preset — disable cron-polling stopgaps + aggressive auto-prune | 2026-05-20 | Accepted — ratified by driver 2026-05-21 (lean vs fleet `team.json::topology`  |
| 190 | tmux statusline scaling at multi-team-of-teams cages — zero-fork cage + TTL-cached operator-curated | 2026-05-20 | Accepted — ratified by driver 2026-05-21 (cage statusline zero-fork builtin-on |
| 191 | atmux ships its own vendored tmux binary — version-pinning + behavior isolation + reproducibility | 2026-05-20 | Accepted — ratified by driver 2026-05-21 (vendored tmux at /opt/atmux/<v>/bin/ |
| 192 | Cron-idempotency contract for "arm a cadence" verbs | 2026-05-20 | Accepted — ratified by driver 2026-05-21 (every /Xloop / arm-a-cadence verb ru |
| 193 | Restore documented `atmux task add` flags — `--epic` / `--story` / `--deliverable` | 2026-05-18 | accepted (impl shipped 2026-06-05) |
| 194 | auto-push targets the just-done SHA, not branch tip — shared-worktree race mitigation | 2026-05-20 | Accepted — ratified by driver 2026-05-21 (push just-done SHA not branch tip; � |
| 195 | epic-team EPIC-done — transfer follow-up Tasks to parent kanban before dissolve | 2026-05-20 | Accepted — ratified by driver 2026-05-21 (EPIC-done transfers follow-ups to pa |
| 196 | `worktreeIsolation: true` as default for `spawn-epic` — structural fix for shared-index race class | 2026-05-20 | Accepted — ratified by driver 2026-05-21 (worktreeIsolation=true default for s |
| 197 | Cron-reaper teardown contract — unified cron-cleanup path for `dissolve-epic` / `sweep-epics --apply` / `atmux stop` | 2026-05-20 | Accepted — ratified by driver 2026-05-21 (3-part contract: cron-reaper verb +  |
| 198 | Medic host-pressure playbook — automated cleanup at load / RAM / swap thresholds | 2026-05-21 | Accepted — ratified by driver 2026-05-21 (§D1 3 thresholds + §D2 5-step play |
| 199 | Claude account pool for epic-team spawning — least-loaded selection from a configured pool, replacing manual per-spawn assignment | 2026-05-20 | Accepted — ratified by driver 2026-05-23 (Honker substrate on trunk via Epic A |
| 200 | Install wizard for atmux — guided first-run setup with prereq probe, cockpit init, account pool config, and per-project bootstrap | 2026-05-20 | Accepted — ratified by driver 2026-05-23 (Honker substrate on trunk via Epic A |
| 201 | First-class cursor-cli composer-2.5 member TUI — epic-team members can spawn as cursor instead of Claude, enabling adversarial-LLM-diversity within a team | 2026-05-21 | Rejected — driver verdict 2026-05-21 (re-affirming Opus-only stance per memory |
| 202 | Honker as the in-DB messaging substrate — eliminate polling/whip/observation loops by adopting SQLite NOTIFY/LISTEN semantics | 2026-05-21 | Accepted — ratified by driver 2026-05-23 (substrate fully on trunk via honker- |
| 203 | Event topic taxonomy — canonical names, Zod payload schemas, cross-team propagation rules, post-commit hook | 2026-05-21 | Accepted — ratified by driver 2026-05-23 (ADR-202 substrate fully on trunk; de |
| 205 | Bracketed-paste mode as default for send-keys body content — slash-leading wedge fix | 2026-05-21 | Accepted — ratified by driver 2026-05-21 (Option 2 default + `rawSendKeys` per |
| 208 | Deploy-completeness probe class — extends ADR-027 doctor framework | 2026-05-19 | Accepted — ratified by driver 2026-05-21 (deploy-completeness probe-class exte |
| 209 | Epic-team hold-posture deadlock + cage-state probe false-negative + sweep `lastCommitHoursAgo` semantic | 2026-05-21 | Proposed — filed by driver 2026-05-21 during sopx epic-dissolve sweep; diagnos |
| 210 | Eliminate hold-posture deadlock structurally — lead brief fix + pull-protocol dispatch | 2026-05-21 | Proposed — filed by driver 2026-05-21 immediately after ADR-209 correction |
| 211 | Retire the Sentinel role — observation functions distributed to Honker event consumers | 2026-05-21 | Implemented by e-be01fc89 (sentinel deleted in entirety 2026-05-23; honker-subst |
| 212 | Retire Medic role — lead-gated rotation pattern; fold ADR-211's 4-EPIC sentinel-split back into one watchdogs EPIC (simplification pass) | 2026-05-21 | Accepted — ratified by driver 2026-05-21 (Medic role retires at cockpit W2; AD |
| 213 | Retire `_jury` role — Reviewer absorbs Acceptance-Criteria verification | 2026-05-21 | Accepted — ratified by driver 2026-05-21 (Jury role retires entirely; ADR-204  |
| 214 | Retire Ombudsman role — Lead absorbs complaint adjudication via Honker push | 2026-05-21 | Accepted — ratified by driver 2026-05-21 (Ombudsman role retires entirely; ADR |
| 215 | Multi-driver support per atmux team — ordinal driver-N identity, default count 3, shared inbox with identity-prefix | 2026-05-21 | Accepted — ratified by driver 2026-05-21 (multi-instance the existing driver c |
| 216 | Retire the default-member `_`-prefix convention — ADR-161 superseded; member IDs drop the underscore going forward | 2026-05-21 | Accepted — ratified by driver 2026-05-21 (ADR-161 default-member `_`-prefix co |
| 217 | Bundle atmux skills as a Claude Code plugin shipped with the source tree + installed by the first-run wizard | 2026-05-21 | Proposed |
| 218 | `atmux team auto-fold-in` verb + lead-role auto-drive + sweep-epics chaining — closes the SAFE-DISSOLVE-to-merged gap | 2026-05-21 | proposed |
| 219 | `dissolve-epic` completeness — cage `kill-server` + merged-branch `-D` + orphan-detection invariant | 2026-05-22 | Accepted — ratified by driver 2026-05-23 (impl shipped via Epic e-7a1014f9 + t |
| 220 | Incremental-mode identity coherence — `ATMUX_MEMBER`-drift detection + auto-promote-to-force | 2026-05-22 | Accepted — ratified by driver 2026-05-23 (shipped via docs branch fan-in `b6b1 |
| 221 | Solo-worker scope — small standalone tasks via 1-2 member epic-team |  |  |
| 222 | `atmux topo` — read-only fleet-topology observability verb | 2026-05-22 | accepted (backfilled 2026-06-05 from as-built code; documents shipped surface) |
| 223 | `atmux topo --reap` — orphan-reap cascade semantics + safety gates | 2026-05-22 | accepted (backfilled 2026-06-05; Gate-1 fail-closed contract ratified by ADR-253 §Amendment) |
| 224 | `relayd` → `orchd` rename + auto-spawn / auto-dissolve orchestration loop | 2026-05-22 | Accepted (Phase 1) — ratified by driver 2026-05-23 (Phase 1 rename shipped via |
| 225 | Epic dependencies + isReady toggle — orchd substrate | 2026-05-22 | proposed |
| 226 | orchd auto-merge subscriber (Phase 3) — `task.done` → `atmux epic-merge` → `epic.merged` | 2026-05-23 | accepted |
| 227 | orchd auto-dissolve subscriber (Phase 4) — `epic.merged` → `atmux team dissolve-epic` → `epic.dissolved` | 2026-05-23 | accepted |
| 228 | orchd spawn queue + pressure-monitor loop (Phase 5) — refuse → enqueue → drain on load drop | 2026-05-23 | accepted |
| 229 | orchd auto-push subscriber (Phase 6) — `epic.merged` → `git push origin <base>` + 7 load-bearing safety gates | 2026-05-23 | accepted |
| 230 | `atmux-cockpit-mirror` Rust crate — fleet-wide event consumer | 2026-05-22 | proposed (deferred: pending crate scaffold + cockpit-events.db schema bootstrap  |
| 231 | orchd auto-spawn + solo-worker dissolve loop semantics — Honker consumer of ADR-224 §D6 registry + ADR-225 eligibility substrate | 2026-05-23 | Accepted (Phase 2 shipped) — ratified by reviewer 2026-05-23 (Phase 2 substrat |
| 232 | orchd cross-cage dispatcher seam — `dispatchEpicMerge` / `dispatchDissolveEpic` / `dispatchGitPush` | 2026-05-23 | proposed (deferred: §D2.b transport choice still open per OQ-1; §D2.a routing  |
| 233 | Disable cron auto-install — orchd is the runtime, not cron | 2026-05-24 | Proposed (operator-driver-fired 2026-05-24 post-boot-storm; ship under driver in |
| 234 | 2026-05-24 hax boot-storm + sopx-team-death incident post-mortem | 2026-05-24 | Post-mortem (informational; corrective decisions tracked in [ADR-233](233-cron-a |
| 235 | Cockpit verb-surface rationalization — `reconcile`/`doctor`/`up`/`start` orthogonality, cage-down banner, plain-English refusals | 2026-05-24 | proposed |
| 237 | No LLM cadence into Discord — remove hourly whips, medic on-demand only | 2026-05-24 | Proposed (operator-fired 2026-05-24; ship under driver — surface spans member-skill + cockpit + Discord-template) |
| 238 | orchd is the single Discord emitter — substrate events publish, orchd subscribes-and-renders | 2026-05-24 | Proposed (operator-fired 2026-05-24; architectural-funnel piece making the post-cron Discord surface coherent) |
| 239 | Three-driver minimum per team + no-send-keys-to-drivers invariant — `drivers[]` schema, per-driver worktree, windows grouped at front | 2026-05-24 | Accepted (operator-direct 14:30 MYT; atmux team pilot landed 14:45 MYT; code-enforcement task t-51-576216b2; sibling teams pending op |
| 240 | Drop superorchd — orchd self-supervises, bash supervisor retires (supersedes ADR-236) | 2026-05-24 | Accepted (operator-direct *"simpler is better"* 2026-05-24; D1 + D5 of ADR-236 preserved, D2/D3 dropped) |
| 241 | `atmux start` preflight wizard — installs vendored deps on cold hosts | 2026-05-25 | Accepted (operator-direct *"let's do the recommended"* 2026-05-25; gated on ADR-191 §Pending `build:install` extension landing first) |
| 242 | `atmux shutdown` — single-verb whole-fleet teardown (symmetric inverse of `atmux start`) | 2026-05-25 | Accepted (operator-direct *"let's do the recommended"* 2026-05-25) |
| 243 | Runtime-configurable claude accounts — `~/.atmux/claude-accounts.json` replaces hardcoded `WRAPPER_TABLE` | 2026-05-25 | Accepted (operator-direct *"yes please"* 2026-05-25; bootstrap folds into ADR-241 wizard) |
| 244 | Per-repo pre-commit kanban + decisions snapshot — machine-death backup via git | 2026-05-26 | superseded 2026-05-26 by its own §Supersession (state reframed per-developer/private → dotfile tree + `dotfiles push`) |
| 245 | Singleton `.atmux/` per project — no nested atmux state | 2026-05-27 | Accepted — ratified by operator 2026-05-27 13:15 MYT |
| 246 | Per-cage orchd autostart on `spawn-epic` and `atmux up` | 2026-05-28 | Proposed (operator-fired 2026-05-28; mx-root cross-cage complaint c-3787ee5c) |
| 247 | Lead-stall watchdog — `story.ready` routable event + idle-lead wake substrate | 2026-05-28 | Proposed (operator-fired 2026-05-28; complaint c-b2c8418e) |
| 248 | `atmux team remove` verb — symmetric decommission with safety gates + audit receipt | 2026-05-24 | proposed |
| 249 | orchd singleton guard — one supervisor per team DB via advisory flock | 2026-05-29 | accepted |
| 250 | orchd stale-epic-team reaper — close the spawn-without-reap leak | 2026-05-29 | accepted |
| 251 | epic-cage liveness must resolve the socket via `tmuxTmpdir`, not `resolveCageSocket` | 2026-06-03 | accepted |
| 252 | parent-tmpdir removal must never orphan live epic-team children — `hasLiveEpicChildren` structural guard | 2026-06-04 | accepted |
| 253 | `atmux topo --reap --apply` fails CLOSED — driver-scope gate + presence-as-liveness + fail-closed probes | 2026-06-05 | accepted |
| 254 | Coverage gate must diff the tracked-source universe, not iterate the lcov | 2026-06-05 | accepted |
| 255 | auto-merge tick-result output contract + bounded subprocess wait | 2026-06-05 | accepted |
| 256 | orchd Rust supervisor hardening — bounded subprocess waits, poison-event tripwire, test backfill | 2026-06-05 | accepted |
| 257 | Eternal-improvement = backlog-burndown-first + worktree-isolated, deferred verified merge | 2026-06-08 | accepted |
| 258 | Vendor-agnostic orchestration — `AgentBackend` adapter, tmux demoted to an attach view | 2026-06-09 | accepted |
| 259 | Committer member optional — orchd spawn gates on `autoMerge.enabled`, not committer-presence | 2026-06-09 | accepted |
| 260 | Manual orchestration mode is the default — LLMs self-report status + drive the kanban; orchd opt-in | 2026-06-12 | accepted |
| 261 | issue-sync — external issue-tracker ingestion (GitHub / Azure DevOps): poll → complaints → lead adjudication | 2026-06-12 | proposed |
| 262 | `opencode` headless AgentBackend — flat cheap-model members, capability contract + MCP tool injection; plugin-orch safety ported as policy | 2026-06-12 | proposed |
| 263 | Merge session `preclear` verb into `handoff` (one mode-aware verb, no alias) | 2026-06-26 | accepted |
| 264 | Cockpit tmux session renamed `atmux_cockpit` → `atx` — "cockpit" stays the prose name | 2026-07-28 | accepted |
| 265 | `atx` is the canonical shorthand for atmux — prose-only; machine-facing names stay `atmux` | 2026-07-28 | accepted |
| 266 | Shim sunset policy + first expired-shim sweep and retired-role dead-code removal | 2026-07-28 | accepted |
| 267 | Durable agent-continuity contract — plan/intent is written as you go, not captured on the death-bed | 2026-08-06 | proposed |
| 268 | Managed-repo state isolation — enforce the dotfile-tree invariant in code, not in operator memory | 2026-08-06 | proposed |
| 269 | Recursive branch ledger — per-repo branch state across a monorepo's nested submodules | 2026-08-06 | proposed |
| 271 | SQLite is the sole coordination store (retire `kanban.json`); Rust `atmux-orchd` coordinates by default | 2026-08-07 | proposed |
| 272 | `atmux voice` — spoken operator interface (mobile PWA + provider-neutral realtime seam + verb-only tool bridge) | 2026-08-14 | proposed |

## Superseded (skip)

Retained for historical trace only. Skip unless investigating supersession history.

- [083](083-cron-install-port-scope.SUPERSEDED.md) — cron-install port scope — `atmux start` auto-install glue (refs ADR-051) — superseded by ADR-233
- [086](086-atmux-pulse.SUPERSEDED.md) — `atmux pulse` — cockpit-wide deterministic verdict probe (Phase 1 of MiniMax observer) — superseded by ADR-233
- [132](132-pluggable-martinet.SUPERSEDED.md) — Pluggable Martinet — cockpit-level pane-capture + nudging offload from Claude lead to any-LLM impl — superseded by ADR-211
- [143](143-external-lead-rotation.SUPERSEDED.md) — External cron-fired lead-rotation enforcer (stopgap until martinet ships) — superseded by ADR-233
- [158](158-martinet-to-sentinel-rename.SUPERSEDED.md) — martinet → sentinel rename — SV register sweep, supersedes ADR-132 nomenclature — superseded by ADR-211
- [183](183-sentinel-scope-includes-epic-teams.SUPERSEDED.md) — Sentinel scope includes epic-teams — silent-member-death coverage — superseded by ADR-211
- [185](185-sentinel-epic-team-scope-extension.SUPERSEDED.md) — Sentinel scope extension to epic-teams — supersedes ADR-132/158 §Out of scope — superseded by ADR-211
- [204](204-jury-role-acceptance-criteria-contract.SUPERSEDED.md) — `_jury` role + acceptance-criteria contract — adversarial cursor-based gate that ratifies planner ACs pre-work and judges deliverables post-test — superseded by ADR-213
- [206](206-sentinel-dynamic-epic-discovery.SUPERSEDED.md) — Sentinel dynamic epic-team discovery — drop the cockpit.json registration requirement — superseded by ADR-211
- [207](207-opus-sentinel-supersedes-cursor-sentinel-adr-132.SUPERSEDED.md) — Opus-sentinel supersedes cursor-sentinel — rolls back ADR-132 §D1 cursor backend per ADR-201 rejection — superseded by ADR-211
- [236](236-three-tier-orchd-supervision.SUPERSEDED.md) — Three-tier orchd supervision (D1 internal retry + D2 cockpit superorchd + D3 Discord escalation) — superseded by ADR-240 (D2/D3 dropped, D1+D5 preserved)

