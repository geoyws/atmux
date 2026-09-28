# ADR-287: Canonical cockpit nesting — groups are branches, teams are leaf cages hosting drivers; the default roster is drivers-only

**Status**: accepted — operator-direct (George 2026-09-02: *"do what u recommend but let's deprecate the lead, planner, reviewer member windows atm since we only use drivers now"*; in the same session his earlier proposal *"could we rename teams to subgroups? so we can have arbitrary nesting levels"* was assessed and declined — see §D8).

**Date**: 2026-09-02

**Amends**: [ADR-089](089-hierarchical-cockpit.md) (nesting model — closes the §Amendment 2026-08-27 §(C)/§(D) debt and corrects its stale §Implementation-ledger rows 3, 4, 7, 8 and 9), [ADR-239](239-three-driver-minimum-per-team-and-no-sendkeys-invariant.md) (§D6 — the default template now ships zero `members[]`; the driver count itself is unchanged, and the three-vs-five drift between its filename/§D1 and its 2026-05-26 amendment is recorded here, not resolved), [ADR-161](161-default-member-prefix-and-sort-verbs.md) / [ADR-216](216-retire-default-member-underscore-prefix-convention.md) (`DEFAULT_MEMBER_ROLES` and the window-name rendering rules are unchanged — §D5; what is deprecated is the default-role windows as a *shipped default*, which those ADRs assumed), [ADR-044](044-driver-session-on-default-socket.md) (driver as window 1 — ADR-239 §D3/§A1 already extended that to drivers 1..N; §D5 makes drivers the whole default roster).

**Relates**: [ADR-026](026-always-single-session-topology.md) (driver + members share one cage session — a team cage is still that session), [ADR-092](092-cross-team-tell-lead.md) (its deferred `atmux doctor` D8/D9 cross-team-routing checks, t-c2e544b6, remain unbuilt and are unrelated to §D7), [ADR-135](135-cockpit-naming-convention.md) (cockpit naming convention — unchanged), [ADR-264](264-cockpit-session-atx-rename.md) (the cockpit session is `atx`), [ADR-275](275-external-private-kanban-authority.md) (external kanban is the sole work-state authority — the reason drivers alone suffice: drivers work kb rows, so no in-cage lead/planner loop is needed), [ADR-276](276-orchd-retirement-and-atmux-scope.md) (atmux's scope is tmux cages + `atmux vox`), [ADR-280](280-epic-team-retirement-and-staged-excision.md) (epic-team retirement — it made `team` under `team` the general nesting shape this ADR now deprecates), [ADR-285](285-cooperative-bot-seat-and-superbot-offer-protocol.md) (the cooperative `_bot` seat is NOT a member window and is unchanged).

## Context

Two threads from one operator session on 2026-09-02, both about what a cockpit tree is made of.

### Nesting — two ways to nest, no rule saying which

`cockpit.json` `sessions[]` is a discriminated union (`src/schema/cockpit.ts:267`) over `team`, `group`, `superdriver` and `medic`. Two of those carry a recursive `sessions[]`: `TeamSession` (`src/schema/cockpit.ts:209`) and `GroupSession` (`:223`). Team-under-team became "the general shape" when [ADR-280](280-epic-team-retirement-and-staged-excision.md) removed `epic-team`; `group` arrived on 2026-08-27 as a cage-less container and on 2026-08-28 became a real tmux server that consumes a prefix rung (ADR-089 §Group-tier notes). So the tree admits two nestable node kinds and nothing says which one to use for what. They are not equivalent: a team nested under a team is a cage inside a cage — a second repo root, a second `.atmux/team.json`, a second set of worktrees and branches, and a viewer window for the child in the cockpit session (or the nearest group server, `src/core/cockpit.ts:397`), ordered immediately after the parent's own viewer (ADR-135 §D2 amendment, `src/verbs/cockpit.ts:2216`) — never inside the parent's cage session — while a group is exactly the branch-only container the nested team was standing in for.

Depth is unbounded and unchecked. `loadCockpit` (`src/core/cockpit.ts:111`) performs no depth walk. `MAX_NESTING_LEVEL = 6` (`:821`) is read in three places — `validatePrefixChain` (`:901`, a chain-length floor of six), `childNestingEnv` (`:957`, an exported helper for cage-entry env with no `src/` caller as of 2026-09-02 — only tests call it; the live cage level comes from `src/verbs/start.ts:671`, which reads `ATMUX_NESTING_LEVEL` and falls back to `enabledTeams(...).level + 2`) and the `resolvePrefix` hint string (`:875`) — and none reads the tree. ADR-089 §Amendment 2026-08-27 §(C) already ruled that depth past the chain is refused at load with no clamp and no wrap, and that the cap should be the chain length rather than a constant; §(D) recorded that the refusal was never built, and `docs/RUNBOOK-cockpit.md` §11 tells operators in so many words that "that refusal is not implemented yet". The failure mode as of 2026-09-02: an over-deep node's `resolvePrefix` throw is swallowed in the reconcile loop (`src/verbs/cockpit.ts:1045`) and the cage falls back to the legacy `C-\` prefix — one chord meaning the wrong thing, which is the exact defect ADR-089 §Decision-anchor #4 exists to prevent.

The operator's first proposal was to rename teams to subgroups so that nesting could go to any depth. Arbitrary depth already exists — through groups — and the rename would erase the only distinction that carries semantics (§D8, with the measured cost).

### Roster — the template still ships a loop nobody runs

`templates/team.example.json` ships five drivers (ADR-239 §A1), the ADR-285 `bot` block, and five members — `lead`, `planner`, `docs`, `reviewer`, `gitter`. That roster encodes the ADR-007 pull model: the driver files an ask with `atmux tell-lead`, the lead routes it to the planner, the planner decomposes it into atmux's own kanban, members `atmux claim --next`, the reviewer gates commits, gitter merges. Every link in that chain has since been retired or moved out of atmux. [ADR-275](275-external-private-kanban-authority.md) made the external `kb` board the only work-state authority, so there is no in-cage kanban for a planner to decompose into. [ADR-276](276-orchd-retirement-and-atmux-scope.md) retired orchd, the router that woke members. [ADR-286](286-eternal-improvement-retirement.md) retired the loop that fed the planner when the board ran dry. What the operator runs is drivers working kb rows directly, in their own worktrees, under standing goals. The member windows still spawn, still get briefed, and then sit idle — each one a Claude session drawing budget and attention for a loop that does not turn.

The lead is also load-bearing in a handful of verbs. `atmux tell-lead` throws `no lead defined in team.json (need a member with role=team-lead)` (`src/verbs/tell-lead.ts:190`); `rotate-lead`'s `findLeadMember` returns `null`; `poke` branches on `role === "team-lead"`; the ADR-247 lead-stall watchdog pings the lead; `sync claude-team-json` maps `role: team-lead` to `agentType`. `DEFAULT_MEMBER_ROLES` (`src/abstractions/member-roles.ts:27`) drives window-name rendering and `atmux member sort`. None of these need to change for a drivers-only team — they need to fail closed cleanly, and their absence needs to read as expected rather than as a config bug (§D6).

The directive, verbatim: *"do what u recommend but let's deprecate the lead, planner, reviewer member windows atm since we only use drivers now."*

### Measured "team" occurrence counts

Measured 2026-09-02 on branch `atmux-geoyws` (working tree with the ADR-286 batch staged), `rg -n -i '\bteam\b' <dir> | wc -l`: `src/` **4,114** lines, `tests/` **6,819** lines, `docs/adr/` **4,158** lines. Counting the bare substring instead (`rg -n team <dir> | wc -l`, case-sensitive) gives 5,087 / 8,394 / 4,646. The `docs/adr/` figures were measured before this ADR and its ADR-089 / ADR-239 amendments were written; re-measuring afterwards adds the ~45 lines they contribute (the `src/` and `tests/` figures reproduce exactly). On top of the source, the word is the team-socket namespace (`/tmp/atmux-<team>/sock`), the cage session name, the `@:` sigil in the operator's global rules, the `team-rename` verb family (five `src/verbs/team-rename*.ts` modules behind `atmux team rename`), the dotfiles skills (`team`, `tell-lead`, `session`, `rebuild`), and the Discord palette-per-team surface.

## Decision

### D1 — Two node kinds, one path grammar

`cockpit.json` `sessions[]` has exactly two nestable kinds, and they are not interchangeable:

- **`group` is a branch node.** A cage-less container with no repo root and no roster, nestable to ANY depth, backing a real tmux server (`/tmp/atmux-grp-<group>/sock`) whose windows only attach children. A group with a parent is simply a group — "subgroup" is not a node kind.
- **`team` is a LEAF cage.** It owns a project root, `.atmux/team.json`, worktrees and branches, and hosts the driver windows. A team is where work happens; it is not a place to hang more tree.

Drivers are windows inside a team cage, never a tier of the tree. The canonical path grammar is `group[/group...]/team/driver` — for example `unum/aix/driver-2`. Every doc, skill and error message that names a location in the fleet uses that grammar.

### D2 — The chord is derived from depth, never from node kind

The cockpit session binds `prefixChain[0]` (`F1` by default). A node at 0-indexed tree depth `d` binds `prefixChain[d+1]`: a top-level group or an ungrouped top-level team binds `F2`, a team under a top-level group binds `F3`, and so on. This is the arithmetic that already ships (`resolvePrefix(level + 2, …)` at `src/verbs/cockpit.ts:559` for group servers and `:1045` for team cages); this ADR makes it the single stated source.

| Rung | Server it lands on | What its windows are |
|---|---|---|
| `F1` | cockpit `atx` | one window per top-level group, plus ungrouped teams |
| `F2` | top-level group server, or an ungrouped top-level team cage | group server: child groups and teams; team cage: `driver`, `driver-2`, … (+ any explicitly declared member windows) |
| `F3` | team cage under a top-level group (or a second-level group server) | `driver`, `driver-2`, `driver-3` (+ any explicitly declared member windows) |
| `F(d+2)` | deeper nodes | same pattern |

At `F3` and deeper a group server's windows are child groups and teams, exactly as at `F2`; only a team cage's windows are drivers. Drivers are addressed with their team cage's chord plus a window index (`F3 1`, `F3 2`, …) and consume no rung of their own. This table is the single source: `docs/RUNBOOK-cockpit.md` §11 and every skill that explains chords copy it verbatim rather than restating it.

### D3 — team-inside-team is deprecated

A `team` nested under a `team` keeps parsing (grace period — `TeamSession.sessions` stays in the schema). `loadCockpit` emits a warning through its existing `warn` sink naming parent and child: `team-inside-team is deprecated per ADR-287 §D3; move it under a group`. `atmux doctor` renders a yellow row for each such pair (§D7). Hard refusal is reserved for a later ADR, after the fleet has no such nodes; deprecating and refusing in the same change would break a live cockpit with no migration window.

### D4 — Depth past the prefix chain is refused at load; the chain length is the cap

`loadCockpit` walks the parsed tree. If any node at 0-indexed depth `d` needs rung `d+2` and that exceeds the effective chain — `cockpit.prefixChain` when set, else `DEFAULT_PREFIX_CHAIN` (`F1`..`F12`, `src/core/cockpit.ts:801`) — the loader throws a `ConfigError` naming the offending node, its depth, the rung it needs and the chain length, with the hint `add entries to cockpit.prefixChain or reduce nesting depth`. There is no clamp and no wrap: this is ADR-089 §Amendment 2026-08-27 §(C) implemented as written, and it closes §(D).

`MAX_NESTING_LEVEL` is retired as a depth cap. Concretely:

- the export is kept, defined as `DEFAULT_PREFIX_CHAIN.length`, for existing callers;
- `validatePrefixChain` drops its fixed "chain must have ≥6 entries" floor — a chain needs at least one entry, every entry non-empty and unique, and enough rungs for the tree, and the load-time walk is what enforces the last of those (a one-entry chain is valid only for a cockpit with no team or group sessions at all);
- `childNestingEnv` guards against the effective chain length instead of the constant — a contract change for the exported helper only, since it has no `src/` caller as of 2026-09-02 (only `tests/unit/core/cockpit.test.ts` and `tests/unit/verbs/start.test.ts` exercise it);
- the `resolvePrefix` out-of-range hint stops quoting a fixed maximum.

The chain — not a separate number — is the one thing that bounds depth.

### D5 — The default roster is drivers-only

`templates/team.example.json` ships `drivers[]` (count unchanged from what it ships as of 2026-09-02), the ADR-285 `bot` block, and `members: []`. The lead, planner, reviewer and generic member windows are **deprecated, not removed**:

- a `team.json` that still declares `members[]` spawns them exactly as before — the lead-first member step in `src/verbs/start.ts` is untouched;
- window naming is unchanged — `DEFAULT_MEMBER_ROLES` and the ADR-161/ADR-216 rendering rules stay as they are;
- briefs under `templates/briefs/` are retained for every role a team may still declare;
- `atmux doctor` renders a yellow row for any team whose `team.json` declares one or more `members[]` (§D7).

Rationale: since ADR-275 the drivers work kb rows directly, and the in-cage lead→planner→member loop is no longer the operating model. A default that spawns five idle Claude sessions per cage is a default that costs budget for nothing. Teams that want the loop back declare it; the template stops assuming it.

### D6 — Lead-dependent verbs keep their contract only for teams that declare a team-lead

`atmux tell-lead`, `atmux rotate-lead`, the lead-stall watchdog, `poke`'s lead branch, and `atmux sync claude-team-json`'s `agentType` mapping work unchanged when a `role: team-lead` member is declared. Otherwise they fail closed with their EXISTING errors — for example `tell-lead`: `no lead defined in team.json (need a member with role=team-lead)`. For a drivers-only team that state is expected, not a config bug: the ask goes to the kb board as an attention item or a task instead. No verb behaviour changes in this ADR; what changes is the reading of the error, which the docs and skills carry.

### D7 — Two doctor probes

- **`team-inside-team`** — one yellow row per nested pair, read from `cockpit.json`, naming parent and child and pointing at §D3.
- **`deprecated-member-windows`** — one yellow row per team whose `team.json` declares one or more `members[]`, listing the member names and pointing at §D5.

Both are advisory: neither changes exit codes on its own beyond the existing yellow accounting. One exception is deliberate — a `cockpit.json` that is present but refused at load (the §D4 depth refusal, an invalid `prefixChain`, a schema mismatch) is not swallowed: `atmux doctor` renders one red `cockpit.json` row carrying the loader's message (emitted from the `team-inside-team` probe's loader seam, so it appears once), because the one diagnostic verb must show the error every other cockpit-loading verb stops on. An absent `cockpit.json` stays silent — a cage need not be on any cockpit — and the roster probe then reads the current team alone. They slot in beside `checkCockpitOnDefaultSocket` (`src/verbs/doctor/cockpit.ts:362`) in the probe sequence at `src/verbs/doctor.ts` (`rows.push(...)` block, `:160`–`:285`). They are new probes, not a replacement for anything: ADR-092's deferred D8/D9 cross-team-routing checks (t-c2e544b6) are a different finding class and stay unbuilt.

### D8 — Rename team→subgroup declined

Recorded so it is not re-proposed. The rename would erase the branch/leaf distinction that carries all the semantics: a "subgroup" that hosts drivers would still need a repo root, a `team.json`, worktrees and branches — it would be a team under another name, and the tree would have two spellings of leaf and none of branch. Arbitrary nesting was already available through groups before the proposal was made. Against that, the measured blast radius (§Context): `team` appears on 4,114 lines in `src/`, 6,819 in `tests/`, 4,158 across the ADRs, plus the socket namespace (`/tmp/atmux-<team>/sock`), the cage session names, the `@:` sigil, the `team-rename` verb family, the dotfiles skills, orchd's historical event schema, and the Discord per-team palette. A rename of that size buys a word; the model it would have bought already exists.

## Consequences

- **Operators get one table for chords.** §D2 replaces the L0..L12 tier table in `docs/RUNBOOK-cockpit.md` §11 (`:393`–`:401`) and its "that refusal is not implemented yet" paragraph (`:421`); §D4 replaces the ≥6-entry floor under §11 "Override the chain" (`:417`) with "at least one entry, unique, and enough rungs for the tree"; and the sentence at `:433` calling a prefix/level mismatch "the ADR-092 doctor probe D9's finding class" is removed (ADR-092 has no such probe — see §Relates). If a cage's chord is not what §D2 says, the cockpit.json depth is wrong, and since §D4 that is caught at load rather than discovered at the keyboard.
- **Breaking, deliberately: an over-deep `cockpit.json` no longer loads.** Any tree whose deepest node needs a rung past the effective chain fails with a `ConfigError` at `loadCockpit` — every verb that loads the cockpit refuses, not just `cockpit reconcile` (`atmux doctor` reports it as a red `cockpit.json` row instead of aborting — §D7). Before this ADR the same file loaded and gave the deep cage a silently wrong `C-\` chord. The fix is one config edit: lengthen `prefixChain`, or flatten the tree.
- **Chains shorter than six are now accepted when the tree fits.** The gate moves from a fixed constant to the measured tree, which is stricter where it matters (a 12-entry chain admits nodes at 0-indexed depth 0..10; a node at depth 11 — which needs rung 13 — is refused; before, it loaded with a `C-\` chord) and looser where the constant was arbitrary. `MAX_NESTING_LEVEL` still exports, now as 12; any caller that compared against 6 sees the new value. Tests pinned to the old constant (`tests/unit/core/cockpit.test.ts:1535`, `:1609`, `:1647`) are rewritten against the chain length and the load-time refusal.
- **`ATMUX_NESTING_LEVEL` semantics are unchanged.** `src/verbs/start.ts:671` still reads it from env and falls back to `enabledTeams(...).level + 2` when it is unset; `childNestingEnv`'s ceiling moves from the constant to the chain length, but it remains uncalled outside tests, so no cage's level changes.
- **team-inside-team keeps working, with noise.** Existing nested teams load, warn on every load, and show yellow in `atmux doctor`. The migration is `move it under a group` and is an operator edit; a later ADR turns the warning into a refusal once the fleet is clean.
- **New teams have no member windows.** `atmux init` copies the template, so a fresh team spawns drivers, the `_bot` seat if enabled, and nothing else. `atmux start`'s member step runs over an empty list; the `__<team>__home` placeholder is never created when `drivers[]` is non-empty (`src/verbs/start.ts:614`), so the step-9 close-out (`:1159`) is a no-op — the code lane pins this with a drivers-only `team.json` fixture. Two seams moved with the template: `atmux init --claude-account <suffix>` stamps (or, with `default`, strips) every `drivers[]` entry as well as declared members — a members-less template would otherwise make the flag a no-op (`bot.claudeAccount` is untouched, ADR-285) — and its third `Next:` hint no longer suggests `atmux tell-lead`; `atmux doctor`'s `team.json` probe treats `members: []` with `drivers[]` declared as green (`N drivers, M members`) and reds only a team that declares neither.
- **Lead-dependent verbs on a drivers-only team fail closed and that is correct.** `atmux tell-lead` on such a team exits with its existing `no lead defined` error; the operator files a kb attention item or task instead. Before this ADR the dotfiles `tell-lead` skill described that state as "a config bug, not a runtime issue" and the dotfiles `team` skill refused to launch any team without a `reviewer` entry and pinned the lead to window position 2; both were aligned the same day in the dotfiles working tree (follow-up (e), done 2026-09-02 — a separate commit in `_dotfiles`, not atmux code).
- **Docs that drew the old loop were corrected in the same-batch docs lane.** `docs/ARCHITECTURE.md:89` (the `driver / 🧭_lead / 🗺️_planner / 🔍_reviewer` window order), its §Roles table and its §Principles #4 ("Driver is external"), `docs/PRD.md` §7.1 (team-lead at window 1, planner at 2, reviewer at 3 — already contradicted by ADR-239 §D3), and the `README.md` tagline all described the deprecated default. They now read "drivers by default; members only when declared" and cite §D5.
- **Budget.** A cage that used to run drivers plus three to five briefed Claude sessions now runs drivers alone. The saving is per cage per session and is the operator's stated reason.
- **ADRs describing the lead/planner/reviewer loop stay live.** ADR-001, ADR-007, ADR-010, ADR-210, ADR-213, ADR-214, ADR-247 and their siblings describe behaviour a team gets when it declares those roles. Nothing in them is superseded here; they no longer describe the default.
- **The `_bot` seat is unaffected.** ADR-285's cooperative seat is not a member window, is declared in its own `bot` block, and ships in the template as before.

## Out of scope / follow-ups

- **(a) `atmux topo` and its `TopoManifest`.** `renderTree` (`src/verbs/topo.ts`) and `renderFlat` still draw a fixed cockpit→team→epic shape; `TopoManifest` (`src/core/topo-aggregate.ts`, `schema_version: 1`, consumed by the Rust `cockpit-mirror` crate) carries no group, parent or level. Nested teams and groups are invisible to `topo` as of 2026-09-02. A manifest v2 plus renderer change, coordinated with the crate's pin, is a separate task.
- **(b) `groupSocketPath` collision refusal.** A team literally named `grp-<x>` beside a group named `<x>` would share `/tmp/atmux-grp-<x>/sock`. Flagged in `src/core/cockpit.ts::groupSocketPath`'s doc comment; the loader refusal stays a follow-up.
- **(c) Retiring `rotate-lead` / `rotate-member` / `tell-lead` skills outright** is deferred until no team in the fleet declares `members[]`.
- **(d) Migrating the live fleet's `team.json` files to `members: []`** is an operator action, not this ADR. The §D7 probe is how the operator finds which teams still declare members.
- **(e) Dotfiles skills.** `~/.agents/skills/team/SKILL.md` (refused launch without a `reviewer`; pinned the lead to position 2), `~/.agents/skills/tell-lead/SKILL.md` (called a missing lead a config bug), `~/.agents/skills/session/SKILL.md` (lead-window mode detection assumed a lead) and `~/.agents/skills/rebuild/SKILL.md` (described a flat `C-\` cage prefix with no group tier) all predated this ADR and live outside this repo. **Done 2026-09-02**: all four were aligned to §D2 and §D6 in the dotfiles working tree the same day (separate commit there) — `team` no longer refuses launch without a `reviewer` and no longer pins the lead to position 2, `tell-lead` calls the missing lead the expected drivers-only state, `session` resolves a drivers-only team to `solo`, and `rebuild` carries the §D2 table verbatim. Their remaining orchd/honker wording (retired by ADR-276) is a separate dotfiles pass.
- **(f) Hard refusal of team-inside-team** — a later ADR, once §D7 reports zero nested pairs across the fleet.

## Implementation ledger

Status as of authoring, 2026-09-02. Code lanes implement §D3, §D4, §D5-template and §D7 in the same batch as this ADR; the reviewer verifies each "ships in this batch" row against the batch diff before accepting.

| Item | Status | Where |
|---|---|---|
| §D1 — node kinds + path grammar | docs-only, this batch | `docs/RUNBOOK-cockpit.md` §11; `docs/ARCHITECTURE.md` cockpit section; header comment of `src/schema/cockpit.ts` (comment only — no schema change) |
| §D2 — chord table | docs-only, this batch (the arithmetic already ships: `src/verbs/cockpit.ts:559`, `:1045`) | `docs/RUNBOOK-cockpit.md` §11 replaces its L0..L12 table (`:393`–`:401`) with §D2's and drops the `:433` "ADR-092 doctor probe D9" sentence; the dotfiles `rebuild` skill copies the table verbatim (follow-up (e), done 2026-09-02 in the dotfiles working tree) |
| §D3 — team-inside-team warning | ships in this batch (code lane) | `src/core/cockpit.ts::loadCockpit` (`:111`) via its `warn` sink; unit test in `tests/unit/core/cockpit.test.ts` |
| §D4 — load-time depth refusal + chain-length cap | ships in this batch (code lane) | `src/core/cockpit.ts`: tree walk in `loadCockpit` (`:111`); `MAX_NESTING_LEVEL` (`:821`) → `DEFAULT_PREFIX_CHAIN.length`; `validatePrefixChain` (`:901`) drops the ≥6 floor; `childNestingEnv` (`:957`) guards against the effective chain; `resolvePrefix` hint (`:875`); tests at `tests/unit/core/cockpit.test.ts:1535`, `:1609`, `:1647` rewritten, plus a new over-deep-tree refusal test. Docs lane, same batch: `docs/RUNBOOK-cockpit.md` §11 "Override the chain" (`:417`) — replace the ≥6 floor with "at least one entry, unique, and enough rungs for the tree"; §11 "Depth beyond the chain" (`:421`) — drop "not implemented yet" |
| §D5 — template ships `members: []` | ships in this batch (code lane) | `templates/team.example.json` (`members: []`, `_comment_members` rewritten to cite §D5); `templates/team.example.md`; fixtures in `tests/unit/verbs/init.test.ts` |
| §D5 — member windows deprecated (behaviour) | docs + two code seams (code lane); `src/verbs/start.ts` member step unchanged | `docs/ARCHITECTURE.md:89` + §Roles + §Principles #4; `docs/PRD.md` §7.1; `README.md` tagline; `src/verbs/init.ts` (`--claude-account` stamps/strips `drivers[]` too — the shipped template has no members, so the flag would otherwise be a no-op; `Next:` hint 3 is drivers-first instead of `atmux tell-lead`); `src/verbs/doctor/team.ts` (`members: []` + `drivers[]` is green with detail `N drivers, M members`; red only with neither); pinned by `tests/unit/verbs/init.test.ts` and `tests/unit/verbs/doctor.test.ts` |
| §D6 — lead-dependent verbs fail closed | docs-only — no code change | `src/verbs/tell-lead.ts:190` error stands; runbooks and the dotfiles `tell-lead` skill reword "config bug" (follow-up (e), done 2026-09-02 in the dotfiles working tree) |
| §D7 — `team-inside-team` + `deprecated-member-windows` probes | ships in this batch (code lane) | new module `src/verbs/doctor/nesting.ts` (`checkTeamInsideTeam` / `checkDeprecatedMemberWindows` + pure `teamInsideTeamRows` / `deprecatedMemberWindowsRows`, sharing `findTeamInsideTeamPairs` with the loader; `checkTeamInsideTeam`'s loader seam also owns the red `cockpit.json` load-refusal row via `cockpitLoadRefusedRow`), wired into `src/verbs/doctor.ts::runAllChecks` immediately after `checkCockpitOnDefaultSocket` (model: `src/verbs/doctor/cockpit.ts::checkCockpitOnDefaultSocket`); unit tests `tests/unit/verbs/doctor/nesting.test.ts` + wiring tests in `tests/unit/verbs/doctor.test.ts`; listed beside the two existing cockpit probes in `docs/ARCHITECTURE.md` |
| §D8 — rename declined | docs-only — recorded here | — |
| ADR-089 ledger rows 3, 4, 7, 8, 9 corrected | docs-only, this batch | [ADR-089](089-hierarchical-cockpit.md) §Amendment 2026-09-02 |
| ADR-239 §D6 amended | docs-only, this batch | [ADR-239](239-three-driver-minimum-per-team-and-no-sendkeys-invariant.md) §Amendment 2026-09-02 |
| Follow-ups (a)–(f) | deferred | §Out of scope / follow-ups |
