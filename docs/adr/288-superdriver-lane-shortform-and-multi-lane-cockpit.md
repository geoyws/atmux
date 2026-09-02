# ADR-288: Superdriver lane shortform — cockpit window 1 `_superdriver` → `_sd`, `_sdN` multi-lane cockpit, and retirement of `/atmux:bruh` + `/atmux:bruhloop`

**Status**: accepted — adversarial review 2026-09-02 by a fresh reviewer subagent (0 blockers; findings 1-9 and D5-1 fixed and re-verified; full suite 10705 pass / 25 pre-existing skips / 0 fail across 368 files; e2e cockpit-rotate 6 pass hermetic). Operator decision: George, 2026-09-02.
**Date**: 2026-09-02
**Driver-ref**: operator-direct — George, 2026-09-02: rename cockpit window 1 to the ADR-009 shortform, add two more superdriver lanes working the same `superdriver` kb board, and retire the `/bruh` skills that the kb-row operating model has superseded.
**Relates**: [ADR-135](135-cockpit-naming-convention.md) §D2 / §D4 (window literal + rename-shim shape), [ADR-264](264-cockpit-session-atx-rename.md) (precedent: a shortform in a live tmux name), [ADR-279](279-declarative-operator-cockpit-windows.md) (declarative operator windows), [ADR-215](215-multi-driver-support-per-team-default-three.md) (ordinal lane identity), [ADR-167](167-cockpit-rotate-verb.md) (rotate gates), [ADR-217](217-atmux-skills-plugin-bundled-and-wizard-installed.md) (skills plugin carve set), [ADR-166](166-team-autonomy-policy.md) (autonomy dials that `bruh` consumed), [ADR-212](212-retire-medic-lead-gated-rotation-simplify-honker-consumer-set.md) (medic auto-spawn retired), and the external dotfiles ADR-009 at `/Users/geoyws/work/journals/.sb/_dotfiles/docs/adr/009-typed-reference-sigils.md` (lines 55–80, the shortform rule).

**Numbering note (recorded, not hidden):** this ADR was drafted as 287 on the `atmux-sd-lanes-geoyws-driver-1` worktree (based on `atmux-geoyws` at `3815a8ca`, whose tree ended at ADR-285). During the same session the main checkout independently took **286** (eternal-improvement retirement, staged) and **287** (canonical cockpit nesting + drivers-only roster, untracked), and the operator's dotfiles skills already cross-reference *that* ADR-287 §D6. To avoid the ADR-281 collision replay documented in `INDEX.md`, this ADR takes **288**. Every `ADR-288` reference in code, tests and docs on this branch means this document.

## Context

**Window 1 carries the only long-form cockpit-role name.** ADR-135 §D2 named the operator REPL window `_superdriver`. Every other operator-facing name in the fleet has since moved to a shortform: ADR-264 renamed the cockpit *session* `atmux_cockpit` → `atx`, and the operator's dotfiles ADR-009 fixed the lane shortform as **pure truncation** — `driver` → `d`, `driver-2` → `d2`, `driver-N` → `dN`, and explicitly **no `d1`** because no lane is called `driver-1`. Applying the same rule: `superdriver` → `sd`, `superdriver-2` → `sd2`, no `sd1`. A convention that needs a mapping table invites the off-by-one it documents; truncation needs nothing remembered.

**The operator wants three superdriver lanes, not one.** Since 2026-09-02 the superdriver runs as a goal-driven kb worker (superdriver board rules `r-f3f61654` goal-loop model, `r-1376df29` no send-keys, `r-5272e49d` orchestration-only, `r-56d68c97` kb is the context bus, `r-d0eacbb6` record superdriver work on the superdriver board). One lane serialises the fleet's orchestration; three lanes let independent epics be driven in parallel from the cockpit. ADR-279 already gives the cockpit a declarative `windows[]` layer that recreates an operator window after server loss without inventing a code-reserved role. ADR-215 established ordinal lane identity (`ATMUX_MEMBER`, `driver-N`) for team cages; the cockpit tier gets the same shape.

**`/atmux:bruh` and `/atmux:bruhloop` are pre-kb-row artefacts.** ADR-217 carved them into the bundled plugin from the operator's dotfiles: `bruh` was a one-pass unblocker sweep (decisions / blockers / flags / worktrees, with an escalation ladder Rung A–D and a §0.7 eternal-improvement drip); `bruhloop` was pure sugar that armed `/loop 15mins /atmux:bruh`. Under the standing-goal-per-lane model every lane already works its own kb queue continuously, `/atmux:sweep` owns the fleet-health cadence and `/atmux:whip` owns the per-team nudge cadence. On 2026-09-02 the operator confirmed both skills are no longer needed. Keeping them would keep a second, prompt-injecting escalation path alive next to the kb-row one the board rules mandate.

## Decision

### (D1) Cockpit window 1 literal: `_superdriver` → `_sd`

| Surface | Before | After |
|---|---|---|
| tmux window 1 of the cockpit session (`atx`) | `_superdriver` | **`_sd`** |
| `src/verbs/cockpit.ts` — session creation, wanted set, orphan-prune guard, medic-slot anchor, reorder base, `refusePlannedDestructiveOps`, migrate-socket fallback name | `_superdriver` | `_sd` |
| `src/core/cockpit.ts::validateOperatorWindowNames` reserved set | `_superdriver`, `superdriver`, … | `_sd` **plus** `_superdriver`, `superdriver` kept as legacy reserved names |
| `src/verbs/cockpit-rotate.ts` gate-1 capture target | `<session>:_superdriver` | `<session>:_sd` |
| Role name, schema discriminator `type: "superdriver"`, `templates/briefs/superdriver.md`, the `superdriver` kb board, the `gate-4-never-rotate-superdriver` identifier | unchanged | unchanged |

Only the tmux window literal changes. The underscore prefix (ADR-135 §D2 "cockpit system role") is retained; the stem is truncated per ADR-009.

**Migration shim (ADR-135 §D4 shape, extended).** `reconcileCockpitSession` renames in place, in this order, each step idempotent:

1. `superdoctor → medic` (ADR-133 carry-over, unchanged)
2. `superdriver → _sd` (pre-ADR-135 spelling goes straight to the new literal)
3. `_superdriver → _sd` (ADR-135 §D2 spelling → ADR-288 shortform)
4. `medic → _medic` (ADR-135, unchanged)

`rename-window` preserves the pane PID, attached clients and scrollback — no kill + respawn, the operator's live REPL is not disturbed. When a legacy spelling and `_sd` coexist, the shim does not rename and logs the ADR-135 ambiguity warning naming the `tmux kill-window` command; the orphan-prune pass never sweeps either spelling.

**Deprecation window.** `_superdriver` and `superdriver` stay (a) in the never-prune guard of both the live prune loop and the dry-run planner, and (b) in the reserved operator-window set — exactly as `superdoctor` is kept today — for one release cycle, after which they are removed from both lists.

### (D2) `_sdN` lane convention — additional superdriver lanes are ADR-279 operator windows

- **Naming.** Window 1 is `_sd` (lane `sd`). Additional lanes are **`_sdN` for N ≥ 2**; there is **no `_sd1`** (ADR-009: the first lane has no suffix). The current fleet declares `_sd2` and `_sd3`. The loader enforces the spelling: a `windows[]` name that looks like a lane but is not one — `_sd0`, `_sd1`, or a zero-padded `_sd01` / `_sd02` — is rejected by `validateOperatorWindowNames` with a `ConfigError` naming this section ("there is no `_sd1`; lanes are `_sd2`, `_sd3`, …"), so an obsolete or malformed lane fails loudly at load instead of silently becoming an ordinary operator window. Valid lanes (`_sd2`, `_sd10`, …) remain unreserved.
- **Mechanism.** `_sdN` lanes are **not** code-reserved role windows and add no schema leaf. They are ADR-279 `windows[]` entries in the operator's cockpit config. The canonical lane entry launches Claude directly — this is the exact shape the live MBP config uses on 2026-09-02:

  ```json
  {
    "name": "_sd2",
    "cwd": "/Users/geoyws/work/src/atmux",
    "command": "ATMUX_MEMBER=sd2 CLAUDE_CONFIG_DIR=/Users/geoyws/.claude-gmail CLAUDECODE=1 CLAUDE_CODE_EFFORT_LEVEL=xhigh CLAUDE_GUARD_AGENT=1 claude --plugin-dir=/Users/geoyws/work/journals/.sb/claude-skills --permission-mode auto; exec zsh -i"
  }
  ```

  The command mirrors the env set `buildClaudeWindowCommand` (`src/core/tui-cmd.ts`) gives a member pane — `CLAUDECODE=1`, `CLAUDE_CODE_EFFORT_LEVEL=xhigh`, `CLAUDE_GUARD_AGENT=1`, the account's `CLAUDE_CONFIG_DIR`, `--plugin-dir`, `--permission-mode auto` — plus `ATMUX_MEMBER=sdN` for the lane identity, and ends in `; exec zsh -i` so the window survives Claude exiting (tmux destroys a window whose command exits; the shell keeps the slot and its scrollback). Reconcile creates a missing lane window with that command and never restarts an existing pane because its command differs (ADR-279 §3). `command: null` (a bare `zsh`) remains the alternative for an operator who prefers to start Claude by hand.

  `validateOperatorWindowNames` accepts `_sdN` names (only `_sd` and the legacy spellings are reserved); reconcile places them **immediately after `_sd`** in declaration order — before `_medic` and `_superbot` (§D5) — and treats them as wanted: never orphans, never destructive drift. The live cockpit order on 2026-09-02 is `1:_sd 2:_sd2 3:_sd3 4:_medic 5:_misc 6:geoyws 7:unum 8:ifca`.
- **Identity.** Each lane's Claude is spawned with `ATMUX_MEMBER=sdN` (window 1: `ATMUX_MEMBER=sd`), acts on kb as **`claude@sdN`**, on lane **`sdN`**, and all lanes work the **same `superdriver` kb board**. The brief's §0 identity check accepts `sd`, `sd2`, `sd3` in windows `_sd` / `_sdN` of session `atx`.
- **Operating model** (basis: the superdriver kb board rules, as relayed on 2026-09-02 and mirrored in the operator's `pane-agent` skill):
  - each lane's Claude runs under an **operator-armed standing goal** that works its lane's kb queue (`r-f3f61654`);
  - **all interaction is kb rows** — tasks, handoffs, sitreps, attention (`r-56d68c97`);
  - **nobody injects prompts via send-keys** (`r-1376df29`); panes are read-only for liveness checks;
  - a superdriver is **orchestration-only** and delegates the DOING to isolated subagents and worktrees (`r-5272e49d`);
  - superdriver work is recorded on the superdriver board (`r-d0eacbb6`).
- **New rule — lease-guarded dispatch.** A lane may `atmux tell-lead` (or otherwise dispatch to) a team **only about kb rows it currently holds a lease on**. Dispatch is lease-guarded so three lanes cannot double-dispatch the same row; a lane that wants to act on a row first claims it.
- **Shared, read-only cwd.** All lanes sit in `/Users/geoyws/work/src/atmux` (the main checkout). Lanes **never edit files there** — orchestration only. A lane that must write uses its own worktree under `.atmux/worktrees/`, like any other writer.

### (D3) Rotate protections — `_sd` keeps them; `_sdN` lanes are outside the verb's targets

- **`_sd` (window 1).** Gate 1 (user-not-typing) now captures `<session>:=_sd`; when that capture is empty (window absent because the cockpit has not been reconciled since the rename) it falls back to `<session>:=_superdriver` for the deprecation window, so the typing guard never lapses between install and the first `cockpit reconcile`. Both probes — and every other cockpit-role target in the rotate path (gate-2 capture, Ctrl-C and kill-window on `_medic`) — use tmux's `=` exact-match prefix: without it tmux prefix-matches window names, so a bare `atx:_sd` resolves to a lone `_sd2` lane when `_sd` is absent (measured on tmux 3.7c) and the fallback would never fire. Team viewer targets keep the plain form. Gate 4 (never-rotate) stays keyed on the **role name `superdriver`** — the canonical key, because the gate identifier `gate-4-never-rotate-superdriver`, the Discord template and the audit row's `sessionName` all read it — and additionally refuses the ADR-288 shortform **`sd`** and both window literals **`_sd`** / **`_superdriver`**, so no spelling of window 1 reaches the respawn path. `--force` still does not bypass gate 4.
- **`_sdN` lanes — measured behaviour, not policy.** `classifyRole` knows only `medic` and team names, so `atmux cockpit rotate sd2` classifies as `team-driver` and passes gate 4; the verb then refuses **immediately after classification** — before gates 1–3 and before any handoff payload is written — with `team 'sd2' not found in cockpit.json`: exit **70**, a `respawn-failed` audit row, **no Ctrl-C, no kill-window, no new-window, and `~/.claude/teams/__cockpit__/team-driver/handoff.md` untouched** (the review of this ADR found the first draft wrote the payload before discovering the unknown team, clobbering the last real team-driver handoff; the unknown-team check now precedes the write in both the pre-gate path and `performRespawn`). Passing `_sd2` literally takes the same path. The verb therefore cannot rotate a lane; it fails closed before touching any pane or file. There is **no lane-rotate support** in this ADR (see §OQ): the operator restarts a lane by hand (Ctrl-C, re-run, re-arm the standing goal).

### (D4) Retire and delete `/atmux:bruh` and `/atmux:bruhloop`

- `plugins/atmux/skills/bruh/` and `plugins/atmux/skills/bruhloop/` are **deleted**, not tombstoned. `plugin.json` and `SKILLS_TABLE` drop both entries; the bundled plugin now carries **11** skills (ADR-217 §D2 carve set minus these two).
- **Reason.** Superseded by the kb-row operating model — a standing goal per lane plus the `/atmux:sweep` and `/atmux:whip` cadences already cover what `bruh` swept, without a second prompt-injecting escalation path; the operator confirmed on 2026-09-02 they are no longer needed; `bruhloop` was pure sugar over `bruh`.
- **Nothing dangles.** The §0.7 eternal-improvement heuristics that `/atmux:sweep` and `/atmux:whip` cited by reference are inlined into those skills (tech-debt grep / ADR §OQ / coverage gap / aged doctor warn / lint sweep / stale memory). `bruh` is dropped from every marker-scheme list. ADR-167's Rung A–D ladder stays as `cockpit rotate`'s own scope description, marked historical where it named `/bruh`. Amendment notes are appended to ADR-135, ADR-167, ADR-217 and ADR-279; older ADR bodies are left as historical text.

### (D5) Lane placement — `_sdN` lanes sit immediately after `_sd`, before `_medic` and `_superbot`

Operator decision (George, 2026-09-02 11:20 MYT): the live cockpit is `1:_sd 2:_sd2 3:_sd3 4:_medic 5:_misc 6:geoyws 7:unum 8:ifca` and reconcile must keep that order. ADR-279 §4's layout (`_sd`, `_medic`, `_superbot`, `windows[]`, viewers) would have pushed the lanes behind `_medic`.

- **Rule.** An operator window whose name matches `^_sd(?:[2-9]|[1-9][0-9]+)$` — `_sdN` for any integer N ≥ 2, no `_sd1`, no zero-padding (`isSuperdriverLaneName` in `src/verbs/cockpit.ts`; the operator's shorthand `^_sd[2-9][0-9]*$` was tightened so `_sd10`–`_sd19` are lanes too) — is a superdriver lane and is ordered **immediately after `_sd`**, in `windows[]` declaration order, **before `_medic` and `_superbot`**. Every other operator window (e.g. `_misc`) keeps its ADR-279 placement after `_medic` / `_superbot`. Desired layout: `[_sd, …_sdN lanes, _medic?, _superbot?, …other windows[], …viewers]`. The regex decides placement only — `_sdN` stays **not reserved** in `validateOperatorWindowNames`.
- **Medic slot.** The `_medic` anchor becomes *after the last declared lane*: `anchor.index + 1 + laneCount`, where `anchor` is `_sd` (or a legacy spelling, §Consequences) and `laneCount` is the number of enabled `_sdN` entries in `windows[]`. With no lanes declared it collapses to the ADR-077 rule `anchor.index + 1`.
- **No kills when the slot is held by a wanted window.** If the medic slot is occupied by a lane, another operator window or `_superbot`, the medic pass does not move-with-kill; `_medic` is now part of the park-then-place reorder list, which moves every misaligned window through a high parking index first and therefore never destroys a pane. A cockpit still in the pre-§D5 order `_sd, _medic, _sd2, _sd3, _misc` is reordered to `_sd, _sd2, _sd3, _medic, _misc` with every tmux window id preserved and **without `--yes`**. Only a team viewer parked in the medic slot (the ADR-077 upgrade case) is still displaced as before.
- **Dry-run parity.** `refusePlannedDestructiveOps` models the medic slot the same way (`baseIdx + 1 + laneCount`) and does not report a lane / operator window / `_superbot` in that slot as a move-with-kill victim, so the safety gate cannot demand `--yes` for a reorder the live pass performs without kills.
- **Per-team mode** is unchanged: additive only, no relocation, no reorder (`windows[]` is ignored there, so `laneCount` is 0).


| OQ | Resolution | Reversibility |
|---|---|---|
| Why `_sd` and not `_sdrv` / `_super` / `_sdriver` | ADR-009 pure truncation, symmetric with `d` / `d2`; anything else needs a mapping table | Medium — one literal + one shim step |
| Why not code-reserve `_sd2` / `_sd3` as role windows | ADR-279 windows already recreate after server loss; a schema leaf would model a zsh window with a Claude in it as a role, which it is not | Low — convention bake-in |
| Why keep the role name `superdriver` | Schema discriminator, brief template, kb board name and the gate-4 identifier all key on it; renaming is churn with no operator-visible gain | Low |
| Should gate 4 refuse `sd` too | Yes — cheap, and it spares the operator the confusing `team 'sd' not found` path for the window-1 shortform | Low |
| `_medic` sits between `_sd` and `_sd2` in window order | **Resolved by §D5** (operator, 2026-09-02 11:20 MYT): the lanes precede `_medic`; the order is `_sd, _sd2, _sd3, _medic, _misc, …`, and reconcile keeps it (a pre-§D5 cockpit is reordered without kills). Medic auto-spawn is still retired per ADR-212, so the slot is normally empty | Low |
| Three lanes on one `CLAUDE_CONFIG_DIR` share a rate-limit window | Accepted for now; `/atmux:budget` shows the shared bucket. Splitting accounts per lane is a follow-up if contention is measured, not assumed | Medium |
| Whether `_sdN` lanes ever get rotate support | **Open.** Not in this ADR; if wanted, it is a `lane` role in `classifyRole` plus a lane handoff payload shape. Today the verb fails closed (§D3) | — |
| Deprecation window for the legacy spellings | One release cycle, same as ADR-135 §D5 | Low |

## Consequences

- **Change set (one commit family).** `src/verbs/cockpit.ts` (literal + shim + guards + comments), `src/core/cockpit.ts` (reserved set), `src/verbs/cockpit-rotate.ts` (gate-1 target, `RESERVED_NEVER_ROTATE`, historical header), `src/verbs/help.ts` + `src/verbs/README.md` (text), `src/core/skills-plugin-install.ts` + `plugins/atmux/.claude-plugin/plugin.json` (11 skills), two skill directories deleted, tests updated to assert `_sd` with new coverage for the shim / never-prune / reserved names / medic anchor / lane ordering / rotate refusals, docs (`PRD`, `ARCHITECTURE`, `RUNBOOK-cockpit`, `README`, plugin README, `cockpit-rebuild` / `sweep` / `whip` / `tell-lead` / `session` / `budget` / `heads-up` skills, `sweep-prompt`, `templates/briefs/superdriver.md`, `CHANGELOG`), ADR amendments and `INDEX.md`.
- **Operator zero-disruption.** The rename is in place; the running REPL keeps its PID, clients and scrollback. The next `atmux cockpit reconcile` performs the rename once and logs it.
- **Cockpit config is operator-owned.** Declaring `_sd2` / `_sd3` in `windows[]` of `~/.atmux/cockpit.json` (the dotfiles-managed file) and arming each lane's standing goal are operator steps. This ADR does **not** run reconcile, rename a live window, or touch the live cockpit.
- **Fewer surfaces.** Two skills gone, one escalation path fewer; the plugin's skill count and every doc that enumerated it now say 11.
- **Legacy names survive one release.** Anything still targeting `atx:_superdriver` keeps working until the deprecation window closes; after that it targets a window that does not exist.
- **`=` exact-match targets do not bypass the driver guard.** `extractWindowNameFromTargetString` (`src/abstractions/tmux.ts`) strips a leading `=` from the window segment before classifying, so `sess:=driver` still trips the ADR-239 §D2 never-send-keys-to-driver guard (`DriverSendKeysViolation`) now that `cockpit rotate` uses exact-match targets (§D3).
- **Reconcile keeps the live lane order.** Lanes lead (`_sd, _sd2, _sd3`), then `_medic` / `_superbot`, then the other operator windows and the viewers (§D5); a cockpit carrying the pre-§D5 order is corrected by moves only.
- **Window-1 anchoring tolerates a failed rename.** The medic slot, the reorder base and the dry-run planner all anchor on `_sd ?? _superdriver ?? superdriver` (`findWindowOneAnchor`), so if the shim's `rename-window` fails (warn-and-continue) the un-renamed REPL still counts as window 1 and the reorder's move-with-kill can never land on it; the no-anchor fallbacks agree (`2`).

## Cross-references

- [ADR-135](135-cockpit-naming-convention.md) — §D2 literal superseded for window 1; §D4 rename-shim shape reused (amendment appended).
- [ADR-264](264-cockpit-session-atx-rename.md) — precedent for a shortform in a live tmux name (`atx`).
- [ADR-279](279-declarative-operator-cockpit-windows.md) — `_sdN` lanes are its `windows[]` entries; reserved-name set amended.
- [ADR-215](215-multi-driver-support-per-team-default-three.md) — ordinal lane identity via `ATMUX_MEMBER`; the cockpit tier mirrors it as `sd` / `sdN`.
- [ADR-167](167-cockpit-rotate-verb.md) — gate-1 source window + never-rotate key; `/bruh` references now historical (amendment appended).
- [ADR-217](217-atmux-skills-plugin-bundled-and-wizard-installed.md) — carve set loses `bruh` / `bruhloop`; count 13 → 11 (amendment appended).
- [ADR-166](166-team-autonomy-policy.md) — `bruh` was one consumer of the `autonomy` block; the block and its other consumers are unchanged.
- [ADR-212](212-retire-medic-lead-gated-rotation-simplify-honker-consumer-set.md) — why the `_medic` slot between `_sd` and `_sd2` is normally empty.
- Dotfiles ADR-009 — `/Users/geoyws/work/journals/.sb/_dotfiles/docs/adr/009-typed-reference-sigils.md` (lines 55–80) — the shortform-is-truncation rule and the no-`d1` argument this ADR applies.
- `src/verbs/cockpit.ts` — literal, shim, guards. `src/core/cockpit.ts::validateOperatorWindowNames` — reserved set. `src/verbs/cockpit-rotate.ts::RESERVED_NEVER_ROTATE` — gate 4.
- `templates/briefs/superdriver.md` — §0 identity check + §Multi-lane section.

## Out of scope

- Renaming the `superdriver` role, schema discriminator, brief template, kb board, or the `gate-4-never-rotate-superdriver` identifier.
- Any change to `_medic`, `_superbot`, group windows or team viewers.
- Rotate support for `_sdN` lanes (see §OQ).
- Splitting Claude accounts / `CLAUDE_CONFIG_DIR` per lane.
- Running reconcile against the live cockpit, or editing the operator's `~/.atmux/cockpit.json` — operator steps.
- The dotfiles-side cockpit-rebuild shim and the operator's `pane-agent` / `standing-goal` skills — dotfiles territory; they carry the lane-arming text.

## Amendments

_(none yet)_
