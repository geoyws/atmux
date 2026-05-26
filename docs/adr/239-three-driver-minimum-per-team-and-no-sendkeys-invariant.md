# ADR-239: Five-driver minimum per team + no-send-keys-to-drivers invariant

**Status**: Accepted — ratified by operator 2026-05-24 14:30 MYT (live operator-design session). **Amended 2026-05-26** — driver floor bumped 3→5; member-roster trimmed to {lead, planner, docs, reviewer, gitter} across every parent team (see §Amendment-2026-05-26).
**Date**: 2026-05-24 (original); 2026-05-26 (amendment)
**Driver-ref**: operator-direct 14:25-14:35 MYT 2026-05-24 — "now we need 3 drivers minimum per team … drivers are never supposed to receive sendkeys … they are to be free for the human to interact with … driver-2 and driver-3 always have their own worktrees that they merge frequently with the trunk". Amendment 2026-05-26 — "i want each atmux parent team to have 5 drivers … you do not give them any pre-prompts … i want u to go thru each team.json and remove ombudsman and any other member apart from lead, planner, docs, reviewer, gitter".
**Cross-refs**: [ADR-044](044-driver-as-window-1.md) (driver as window 1 — extends from singular to three drivers grouped at front), [ADR-082](082-long-lived-member-branches.md) (per-member branch durability — drivers get the same shape per-driver), [ADR-084](084-member-worktree-isolation.md) (per-member worktree isolation — driver-2/driver-3 inherit), [ADR-137](137-merge-not-rebase.md) (merge-not-rebase — drivers merge from `origin/<base>` into `<base>-driver-N` per the team contract), [ADR-018](018-cage-isolation.md) (cage isolation — drivers all live in the same cage tmux session, not separate cages)

## Context

The driver model today is **singular**: every team's `team.json` has at most one `driverSession` (or legacy `driverTui`). Window 1 of the cage tmux session hosts the lone driver pane — operator's interactive Claude REPL.

Two operator pain-points motivate the change:

1. **Single point of human attention.** When the operator wants to drive two concurrent threads of work (e.g. file an ADR in one pane while debugging a wedged member in another), they have to either context-switch within a single Claude session (mixing histories, polluting context) or spawn a sibling pane manually (no schema support, no worktree provisioning, no consistent naming).
2. **Worktree contention.** A single driver works from the team root (the trunk worktree). Any in-flight uncommitted change in the trunk worktree blocks concurrent operator work elsewhere. Real-life pattern: operator has trunk dirty mid-experiment, gets paged to ship a hotfix in another file → either stash the experiment (lose context) or risk a tangled commit.

**Operator decision (live, 2026-05-24):** three drivers minimum per team, each on their own git worktree, each operator-interactive only, never touched by automated send-keys.

## Decision

### D1 — Three drivers per team is the floor

Every team's cage tmux session MUST host three driver panes minimum, named `driver`, `driver-2`, `driver-3`. Teams MAY declare more (`driver-4`, etc.) per operator preference; three is the floor, not the cap.

This is a **per-team** invariant. Epic-teams (`e-*` cages spawned via `atmux team spawn-epic` per ADR-090) ALSO get three drivers — they're separate cages, separate operator-attention surfaces. Solo-worker teams (`w-*` per ADR-221) get three drivers as well; the operator may rarely use 2 and 3 but the slots exist for parity.

### D2 — Drivers are operator-interactive only; NO automated send-keys EVER

**Hard invariant**: no atmux subsystem may `tmux send-keys` to a driver pane under any condition. Not at spawn time (use `tmux new-window -c <cwd> <cmd>` command-mode launch instead, which inlines the initial command without traversing the send-keys keystroke path). Not for lane-dispatch (drivers don't appear in lane-router scope per D5 below). Not for whip pokes. Not for orchd consumer routing. Not for `atmux super-tell` cross-team delivery. Not for the unblock tool from ADR-{TBD-e-20}. Never.

This is a stronger invariant than "drivers don't auto-claim". Today the operator-spawn path at `src/verbs/start.ts:494` sends `drvCmd` via `tmux.pane.sendKeys` to the freshly-created driver pane. **This becomes a violation under D2 and MUST migrate to command-mode launch** (`tmux new-window -d -n driver -c <cwd> '<drvCmd>'` or equivalent — the command runs as the pane's PID 0 child, never traverses the send-keys keystroke buffer).

Send-keys callsites that target a pane name match `^driver(-[0-9]+)?$` MUST refuse with a `DriverSendKeysViolation` thrown error. The refusal lives in the lowest-level send-keys helper (`src/abstractions/tmux.ts` pane.sendKeys) so EVERY caller is covered without per-call audit. Tests assert the refusal fires for `driver` / `driver-2` / `driver-3` / `driver-99` and passes through for everything else.

### D3 — Window ordering: drivers grouped at the front

Cage window layout invariant:

```
window 1: driver
window 2: driver-2
window 3: driver-3
window 4: lead
window 5: planner
window 6+: <remaining members in their existing order>
window N-1: <service windows: __orchd__, __sentinel__ if present, etc.>
```

`atmux start` MUST create driver windows BEFORE member windows when initializing a fresh cage session. For existing cages with the legacy single-driver layout (driver at 1, members at 2-N), `atmux start` incremental-mode MUST insert driver-2 + driver-3 at indices 2 + 3 (shifting members from 2-N to 4-N+2), mirror the auto-rename pattern from [ADR-161](161-default-member-prefix-and-sort-verbs.md) §Self-heal.

### D4 — Per-driver worktree

Each driver gets its own git worktree. Layout:

| Driver | Worktree path | Branch |
|---|---|---|
| `driver` | `<team-root>` (trunk worktree — no nested worktree) | `<base>` (e.g. `atmux-geoyws`) |
| `driver-2` | `<team-root>/.atmux/worktrees/driver-2` | `<base>-driver-2` (e.g. `atmux-geoyws-driver-2`) |
| `driver-3` | `<team-root>/.atmux/worktrees/driver-3` | `<base>-driver-3` (e.g. `atmux-geoyws-driver-3`) |

Same pattern as per-member branches (ADR-082 + ADR-084). Branches are long-lived. Merge cadence is operator-discretionary — the operator IS the driver, so there's no automated merge cron for driver branches (unlike member branches that flow via gitter / committer-sweep). Operator runs `git merge origin/<base> --no-edit` per ADR-137 when they want to sync their driver worktree to trunk; pushes via standard `git push` per global CLAUDE.md push policy.

Worktree provisioning happens at `atmux team start` time — same primitive used for member worktrees. Missing driver branches are created from `origin/<base>` on first start. Branch creation is idempotent (`git switch -c <branch> origin/<base>` if absent; `git switch <branch>` if present).

### D5 — Drivers are NOT briefed, NOT dispatched, NOT in member-scoped surfaces

- **No brief template.** `templates/briefs/driver.md` does NOT exist and MUST NOT be created. Drivers start fresh — operator types whatever they want.
- **Not in `team.members[]`.** Drivers live in their own top-level field (see D7 schema). `members[]` iteration (whip, lane-router, claim-next, brief paste, status walks) skips them by construction.
- **Not in lane-router scope.** `atmux claim --next` + `atmux:lane-router` consumer enumerate `team.members[]` only; drivers are invisible.
- **Not counted in roster size.** `atmux status` / `/bau` / fleet dashboards report driver count separately from member count.
- **No ctx-scan.** orchd's 15min context scan walks `team.members[]`; drivers are skipped. Operator manages their own context.
- **No rotation.** Drivers don't auto-rotate. Operator chooses when to `/clear` or `/preclear`.

### D6 — Default template ships with 3 drivers

`templates/team.example.json` carries the three-driver declaration verbatim. New teams created via `atmux init` / `atmux team add` / wizard get the floor for free.

### D7 — Schema shape

Add a new top-level `drivers: DriverSession[]` array to `team.json` (per `src/schema/team.ts`):

```ts
interface DriverSession {
  name: string;           // "driver" | "driver-2" | "driver-3" | "driver-N"
  tui: string;            // "claude" | "shell" | "bash" | "zsh" | etc. — same vocabulary as members[].tui
  cwd: string;            // relative-to-project-root OR absolute; resolves to team-root for driver, .atmux/worktrees/driver-N for the rest
  claudeAccount?: string; // optional per-driver account override; inherits team.claudeAccount otherwise
}
```

Legacy `driverSession` (singular object) + `driverTui` (string) fields are **deprecated** but read-through as a fallback: when `drivers[]` is absent or empty, the loader synthesizes a single-driver array from `driverSession` / `driverTui` for one release cycle. Migration: operator runs `atmux team migrate-drivers` (new verb, one-shot) which writes the canonical `drivers[]` shape derived from existing config + appends driver-2 + driver-3 with sensible defaults. Or operator edits team.json directly — both paths land at the same end-state.

Removal of the legacy fields targets next release after migration verb ships (per the standard ADR-104 cutover pattern).

### D8 — Cron audit + lock-out

A pre-existing cron job that fired `atmux claim --next --as driver` would directly violate D2. **Audit performed 2026-05-24 14:25 MYT**: `crontab -l | grep -iE "claim|driver"` returned ZERO active claim-next entries targeting drivers. The only matched line is a sopx-staging deploy comment (`# >>> sopx-branch-staging-hourly-deploy — t-11910b10 (driver directive 2026-05-19)`) — the word "driver" appears as part of the human-author attribution, not a target role. No cron entries to delete.

Going forward, `atmux start`'s cron-install path (per ADR-026 + ADR-192) MUST refuse to install any cron line whose argv contains `--as driver` or matches `--as driver-[0-9]+`. Refusal = hard error with the message `ADR-239 §D8 violation: cannot install cron targeting driver pane (drivers are operator-interactive only, no automated dispatch)`. Test asserts the refusal.

## Consequences

### What changes

- **Schema**: `team.json` gains `drivers: DriverSession[]`; legacy `driverSession` / `driverTui` deprecated.
- **Code**: `src/verbs/start.ts` spawn loop iterates `drivers[]` instead of singular `driverSession`. Worktree provisioner extends to driver branches. `src/abstractions/tmux.ts` pane.sendKeys gains the driver-refusal guard.
- **Template**: `templates/team.example.json` updated to declare 3 drivers + the cwd convention.
- **Existing teams**: 5 live teams (atmux, sopx, unum, rentx, ifca-docs) migrate via `atmux team migrate-drivers`. Atmux migrates first as pilot (this commit); others follow operator-direct.
- **Tests**: send-keys guard, schema legacy-fallback, cron-install refusal, worktree provisioning all get coverage in the same commit as the code change.
- **Briefs**: NO new `driver.md` brief. Member briefs that reference "the driver" continue to mean driver-1 by default; if they need to disambiguate, they say "driver-N" explicitly.

### What breaks

- **Anyone targeting driver panes via `tmux send-keys` directly (operator scripts, sibling tools)** — they trip the D2 guard and need to migrate to direct pane attach or shell-via-pane-id. Atmux-internal callsites are all under our control; external scripts are out-of-scope here.
- **`atmux super-tell <team> driver "..."` callsites** — currently writes to driver's pane via the existing super-tell chain. Under D2 these MUST migrate to `super-tell <team> lead` (or similar member) instead. Audit cmd: `rg -nE 'super-tell\s+\S+\s+driver' templates/ docs/ ~/.claude/` — flag findings, replace with lead.
- **`atmux tell-lead` from member panes targeting driver** — wait, `tell-lead` targets lead by name (per ADR's lead routing). Not driver. No breakage.

### What we give up

- **Three windows of cage real estate per team** — minor; tmux handles N windows fine. Window-list line gets longer; offset by ADR-235 cockpit-verb-surface-rationalization §Future-state grouping.
- **Operator simplicity of "one pane to drive from"** — replaced by "three panes, pick whichever is on the right worktree". Operator's tmux muscle-memory adapts.
- **Disk for two extra worktrees per team** — ~50-200MB per worktree depending on repo size + .git pack reuse. For 5 teams that's ~500MB-2GB of new worktree disk. Cleanup is the standard `git worktree remove` + `git branch -d` flow.

### Rollback path

Revert this commit. Legacy `driverSession` fallback continues to work for the deprecation window. Worktrees can be `git worktree remove`'d at operator discretion. Cron audit stays valid regardless.

## Decision-anchors

- **DA1 ↔ D1**: 3-driver floor — operator ask 14:25 MYT verbatim
- **DA2 ↔ D2**: no-send-keys-EVER — operator escalation 14:28 MYT ("drivers are never supposed to receive sendkeys" + "free for the human to interact with")
- **DA3 ↔ D3**: drivers grouped at front — operator ask 14:25 MYT "arrange the location of the drivers to be together at the front"
- **DA4 ↔ D4**: per-driver worktree — operator ask 14:25 MYT "their own worktrees that they merge frequently with the trunk"
- **DA5 ↔ D5**: no-brief / not-in-members — operator ask 14:25 MYT "not to be briefed as members or receive claim-next send keys"
- **DA6 ↔ D6**: default template — operator ask 14:25 MYT "make this a default template from now on"
- **DA7 ↔ D7**: schema shape — design choice (operator agnostic on shape; spec-author's pick within the constraints)
- **DA8 ↔ D8**: cron audit + lock-out — operator ask 14:25 MYT "is there a cron asking them to claim-next? if there is please delete this cron and remove it forever"

## Open questions

1. **OQ1**: Should driver-N (N > 3) be allowed declaratively in `drivers[]`, or capped at 3 by schema? **Lean**: allow declaratively up to a reasonable cap (e.g. 10) — operators may want more concurrency on large projects. Schema validation rejects N > 10 with a clear error. **Decided-by**: planner during implementation.
2. **OQ2**: Should the per-driver worktree be auto-pruned on `atmux team dissolve`? **Lean**: yes — pair with member-worktree pruning (already done). **Decided-by**: planner.
3. **OQ3**: Should `atmux team migrate-drivers` operate cage-wide (atomic update across all teams in cockpit.json) or per-team (operator picks)? **Lean**: per-team default with `--all-teams` opt-in. Safer rollout. **Decided-by**: operator.
4. **OQ4**: For epic-teams + solo-workers — do they REALLY need 3 drivers, or is the floor different? **Lean**: same floor for parity (the operator's muscle-memory across cages matters more than the marginal pane count). **Decided-by**: operator if the parity assumption is wrong.
5. **OQ5**: Should the D8 cron-refusal be a hard error (exit non-zero, abort install) or a warn-and-skip? **Lean**: hard error — silent skip would let mis-config slip in. **Decided-by**: planner.

Resolve OQ1-OQ5 before flipping any sibling ADR to "accepted" that depends on D7's final shape. None of them block the operational pilot (this commit).

## Amendment-2026-05-26 — five-driver floor + strict 5-member roster

**Driver-ref**: operator-direct 2026-05-26 — verbatim two messages: (1) *"i want each atmux parent team to have 5 drivers... driver, driver-2, driver-3.. etc and you do not give them any pre-prompts. they should also spawn into their own git worktrees... (e.g. atmux-geoyws-driver-2) but driver (the original) always remains in atmux-geoyws (the working trunk).... then i want u to spawn these drivers for every running atmux parent team"*; (2) *"i will shutdown and rebuild every team later so it'll reset properly.... also i want u to go thru each team.json and remove ombudsman and any other member apart from lead, planner, docs, reviewer, gitter"*. Operator-decision-scope: ALL parent teams (atmux + sopx-root + aix-root + auditx-root + rentx-root + rentx + ifca-docs + mx-root + unum/root); strict 5-role roster (specialist seats removed across all teams — operator-confirmed via AskUserQuestion, 2026-05-26).

### A1 — Driver floor bumped from 3 → 5

Every parent team's cage tmux session MUST host **five** driver panes minimum, named `driver`, `driver-2`, `driver-3`, `driver-4`, `driver-5`. Teams MAY still declare more (up to OQ1 cap of 10); five is the new floor.

D3 window ordering extends: drivers occupy windows 1-5, members shift to windows 6+. Insert-at-front semantics from the original D3 self-heal pattern apply unchanged — just to slots 4 + 5 instead of stopping at 3.

D4 worktree layout extends with two new rows:

| Driver | Worktree path | Branch |
|---|---|---|
| `driver-4` | `<team-root>/.atmux/worktrees/driver-4` | `<base>-driver-4` |
| `driver-5` | `<team-root>/.atmux/worktrees/driver-5` | `<base>-driver-5` |

Same provisioning primitive (`provisionWorktree` from `src/abstractions/worktree.ts`); same long-lived branch + merge-from-`origin/<base>` cadence.

### A2 — Strict 5-member roster across every parent team

Every parent team's `members[]` MUST be filtered down to exactly the **named** roster `{lead, planner, docs, reviewer, gitter}`. Any member with a name outside this set — `ombudsman`, `unblocker`, `discorder`, `auditor`, `devops`, `dba`, `db`, `tester`, `audit-eng`, `impl`, `eng-backend`, `fe-auth`, `be-auth`, `db-auth`, `planner-near`, `planner-pricing`, `member`, etc. — is removed in the 2026-05-26 sweep commit.

Match is by **member.name**, not member.role — the keep-set is `{ "lead", "planner", "docs", "reviewer", "gitter" }` as literal strings.

Teams that do not currently host one of the five named members (e.g. atmux's `docs` exists; sopx's does not) keep their existing subset — A2 is a **filter**, not a guarantee that all five exist. The operator may add missing slots per team.json as needed; the trim only removes.

Team-level config blocks tied to removed members MUST also be disabled or removed in the same commit:

- `team.ombudsman: { enabled: true, ... }` → removed (ombudsman is gone).
- Other tick / cron blocks bound to removed members (`team.unblocker`, `team.discorder`, etc.) → check + remove.

### A3 — No pre-prompts EVER (re-affirms D5)

Operator amendment language *"you do not give them any pre-prompts"* re-affirms D5 verbatim. Implementation MUST: (1) NOT create `templates/briefs/driver.md`; (2) NOT call any brief-paste / role-anchor / kickoff-keystroke chain against driver panes; (3) launch driver TUI via `tmux new-window … <cmd>` command-mode argument so the launch command never traverses the send-keys keystroke path (re-affirms D2's spawn-time send-keys ban — see implementation guidance in §A5).

### A4 — Open-question resolutions

The original §Open-questions resolve as follows under this amendment:

- **OQ1** (declarative N > 3 in drivers[]): **resolved YES, cap 10.** Schema validates `drivers.length` ∈ [1, 10] (1 for legacy single-driver synthesis, 10 hard ceiling). > 10 → `ConfigError` with hint to either consolidate or cite a follow-up ADR justifying the bump.
- **OQ2** (worktree auto-prune on dissolve): **resolved YES.** Driver worktrees prune alongside member worktrees in `atmux team dissolve` per ADR-090.
- **OQ3** (cage-wide migrate-drivers verb): **deferred.** This amendment ships the bulk sweep directly (operator owns the rebuild). Verb can land later if migration pattern recurs.
- **OQ4** (epic-team + solo-worker parity): **resolved YES — same 5-driver floor for parity.** Operator muscle-memory across cages outweighs the marginal pane-count cost.
- **OQ5** (cron-refusal hard error vs warn-and-skip): **resolved HARD ERROR.** Per §D8 — `atmux start`'s cron-install path refuses with non-zero exit code on any `--as driver(-N)?` argv.

### A5 — Implementation guidance (this PR)

This amendment lands together with the implementation pass (single commit per CLAUDE.md ADR-precedes-code discipline):

1. **Schema** (`src/schema/team.ts`): add `DriverSession` Zod object + `drivers: z.array(DriverSession).min(1).max(10).optional()` field. Legacy `driverSession` + `driverTui` stay; precedence at read-site: `drivers[]` (if present + non-empty) → synthesize-from-`driverSession` (single-element array) → bare `__home` placeholder.
2. **Spawn loop** (`src/verbs/start.ts`): replace the singular `driverSession` block (lines ~440-517 pre-edit) with a `drivers[]` iteration. **Launch via `tmux new-window -d -n <name> -c <cwd> '<cmd>'` command-mode** — does NOT route through `pane.sendKeys`, satisfying D2's no-send-keys-EVER invariant at spawn time. First driver creates the session via `new-session` (which already takes a launch command); subsequent drivers attach as new windows.
3. **Worktree provisioning** (`src/verbs/start.ts` calling `provisionWorktree` from `src/abstractions/worktree.ts`): for each driver with `cwd` containing `.atmux/worktrees/`, ensure branch `<base>-driver-N` exists from `origin/<base>` and worktree at the cwd path is checked out. Reuses ADR-084 member-worktree primitive verbatim; `driver` (the original, cwd = `.`) skips provisioning.
4. **Send-keys guard** (`src/abstractions/tmux.ts` `pane.sendKeys`): at the lowest-level helper, after target serialization, refuse with `DriverSendKeysViolation` when the resolved pane name matches `/^driver(-[0-9]+)?$/`. Type-level guard from ADR-025 stays as the first line of defense; the runtime check is defense-in-depth against callers that synthesize `{ kind: "member", member: "driver", ... }` to bypass the type ban.
5. **Tests** (same commit): spawn-from-drivers (1 + 3 + 5 element drivers[]); legacy `driverSession` fallback; driver worktree provisioning happy + idempotent paths; send-keys guard refusal for `driver` / `driver-N` + pass-through for non-driver names; schema validation (drivers.length 0 → refuse, 1-10 → accept, > 10 → refuse).
6. **Configs**: `templates/team.example.json` ships 5 drivers + 5-name member roster; each parent team.json on hax updated per A2.

### A6 — Rollback path

Same as the original §Rollback path. Revert the amendment commit; legacy `driverSession` continues to work for the deprecation window; member-roster trim is reversible from git history (operator can cherry-pick back any removed member if the trim turns out to be over-aggressive in practice).

### A7 — Decision-anchors (amendment)

- **A-DA1 ↔ A1**: 5-driver floor — operator ask 2026-05-26 verbatim "i want each atmux parent team to have 5 drivers"
- **A-DA2 ↔ A2**: strict 5-name roster — operator ask 2026-05-26 verbatim "remove ombudsman and any other member apart from lead, planner, docs, reviewer, gitter"
- **A-DA3 ↔ A3**: no pre-prompts — operator ask 2026-05-26 verbatim "you do not give them any pre-prompts" (re-affirms D5)
- **A-DA4 ↔ A4-OQ1-cap-10**: declarative cap — original OQ1 lean (planner pick within constraints)
- **A-DA5 ↔ A4-OQ4-parity-holds**: epic-team + solo-worker same floor — original OQ4 lean
- **A-DA6 ↔ A5**: launch via tmux new-window command-mode — derivative of D2 (no send-keys EVER includes spawn-time; the command-mode launch is the ONLY spawn path that satisfies the invariant)

## Supplement-2026-05-26 — storage clarification: dotfile-tree, not in-tree

**Driver-ref**: operator-direct 2026-05-26 ~18:25 MYT — "we best not let the other teams see that we're using atmux at all.... because each dev has their own atmux with their own set of epics and etc entirely separate from the next dev" + "make sure that git worktrees don't duplicate the atmux stuff".

**Clarification (does NOT change A1-A7 design; clarifies storage location).** §A2 directs that every parent team.json is trimmed to the strict 5-name roster `{lead, planner, docs, reviewer, gitter}`. This supplement pins the STORAGE LOCATION:

- **Source of truth**: `~/work/journals/.sb/_dotfiles/atmux/<repo-key>/team.json` (operator's personal dotfile tree).
- **Symlink at consumption**: `<managed-repo>/.atmux/team.json` → the dotfile path. Atmux's existing `fs` read path follows symlinks transparently — no code change required.
- **Git tracking**: each managed repo's `.gitignore` excludes ALL of `.atmux/` (no `!.atmux/team.json` carve-out). The symlink itself is gitignored.

**Why this matters for §A1's per-driver worktrees**: when `.atmux/team.json` was tracked in-repo (the pre-supplement model), git worktree checkouts duplicated the file into every driver-N worktree at `.atmux/worktrees/driver-N/.atmux/team.json` — five drivers = five copies that could drift independently. Untracking + symlinking puts the file outside the git-managed tree entirely; worktrees can't duplicate what isn't tracked.

**Bootstrapping a new managed repo**:

1. Create `~/work/journals/.sb/_dotfiles/atmux/<repo-key>/team.json` with the desired content (use `templates/team.example.json` as the starting shape per §A1+§A2).
2. Symlink: `ln -s ~/work/journals/.sb/_dotfiles/atmux/<repo-key>/team.json <repo>/.atmux/team.json`.
3. Confirm `.gitignore` excludes `.atmux/*` (no `!.atmux/team.json` carve-out).
4. Run `atmux start <team-name>` — should read team.json via the symlink without ceremony.

**Out-of-scope for this supplement**: kanban.sqlite + decisions.md storage. Those follow the same dotfile-centric pattern per ADR-244 §Supersession-2026-05-26.
