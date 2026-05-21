---
name: bruh
description: Bruh-mode unblocker — sweeps pending decisions, blockers, flags, and worktrees and pushes everything forward in one pass. Unblock all, approve all, flip all, merge all (all worktrees we worked on).
---

<!-- carved per ADR-217 §D4 -->

# /atmux:bruh — Unblock-everything sweep

When the operator types `/atmux:bruh`, they're telling you:

> "Stop being cautious on the routine stuff. Exercise your best judgment. Push every pending thing forward — *but kick the dangerous-or-genuinely-unclear ones back to me.*"

This is the yolo button for when the operator is tired of micromanaging — **scoped to routine forward-motion**, not to high-stakes or ambiguous calls. The whole point is that **the sweep itself is the authorization for routine items**. Don't pre-litigate every step — make the call on the easy ones, log what you did, move on. But /atmux:bruh is NOT a blanket "approve everything" — see §2.5 below for the danger/unclear gate that runs BEFORE any auto-approval.

This aligns with the principle: "fix it yourself / keep fixing" = scope-level pre-approval for **reversible** ops inside the scope. Irreversible, ambiguous, or stakes-laden ops escape the pre-approval and surface to the operator. Don't substitute report-cadence for fix-cadence — *and don't substitute fix-cadence for sound judgment*.

## The four verbs

- **unblock all** — clear every blocker you can see (where the unblock action is itself routine; if unblocking requires a judgment call with real stakes, surface it instead — see §2.5)
- **approve all** — accept every pending decision **that passes the §2.5 danger/unclear gate** with the recommended default. Decisions that fail the gate get pushed to 🛑 Held, not approved.
- **flip all** — flip every pending toggle/swap that was queued for chat-time approval (same §2.5 gate applies — a swap with a clear safe default flips; a swap that could break prod or change demo narrative escalates instead)
- **merge all** — merge **every worktree we worked on** back to its base branch (after green checks)

Plus two implicit cascades:

- **Rotation cascade** — driver asks each lead to rotate stale members; driver asks medic (the cockpit self-healing role at W2) to rotate stale leads. /atmux:bruh delegates to the role that owns each rung — driver stays thin.
- **Reanimation authority** — /atmux:bruh is authorised to **reanimate dead/zombie member panes** directly. Unlike rotation (which is delegated), reanimation is driver-actionable because a dead member can't self-rotate and the lead can't dispatch to a dead pane. /atmux:bruh respawns the claude process in-place via the canonical spawn pattern + re-bootstrap.

## Procedure

### 0. Cockpit superdriver fan-out — dispatch to LEADS, don't sweep

If /atmux:bruh is invoked from the cockpit superdriver pane, the superdriver has no team of its own to sweep. Fan `/atmux:bruh` out to every enabled team's **lead** (not the driver) via `atmux tell-lead` in parallel — each lead runs its own §1–§5 sweep against the surfaces it can see, and posts its own terminal report. Drivers are skipped intentionally: the driver is a thin pass-through and the lead is the role that actually triages inbox / outbox / kanban / members.

**Detection — you are in cockpit-superdriver context if any of these hold**:

- Current tmux window name starts with `_superdriver` (the cockpit REPL window)
- `~/.atmux/cockpit.json` exists AND `tmux display-message -p '#S'` returns the `cockpitSession` field from that file
- `tmux list-windows` on the current session shows multiple per-team driver windows whose names match enabled `teams[].name` entries in `cockpit.json`

If none hold, you're a per-team lead (or a solo agent) — skip this section and proceed to §1.

**Fan-out procedure**:

1. Read `~/.atmux/cockpit.json`. Enumerate `teams[]` where `enabled: true`.
2. **Per-team pre-flight gate — timestamp recency (sqlite).** Skip only if there's a `/atmux:bruh` tell-lead entry from within the last **10 minutes** (slightly less than the typical 15-min cron cadence so consecutive cron firings don't re-stack, but operator-triggered re-runs still go through after a cycle gap). Atmux durable state lives in `.atmux/state.db` (sqlite); the legacy `driver-inbox.md` mirror is non-authoritative — never grep it for recency.

   Use atmux verbs or `bun:sqlite` to query. The `sqlite3` CLI may not be installed; prefer the embedded driver. Sketch (verify schema with `bun -e 'import {Database} from "bun:sqlite"; const db=new Database(".atmux/state.db",{readonly:true}); console.log(db.query("SELECT name FROM sqlite_master WHERE type=\"table\"").all())'`):

   ```bash
   bun -e '
     import {Database} from "bun:sqlite";
     const db = new Database(process.argv[2] + "/.atmux/state.db", {readonly: true});
     // schema TBD — adapt the table/column names once confirmed in atmux source
     const row = db.query("SELECT created_at FROM driver_inbox WHERE body LIKE \"%/atmux:bruh%\" ORDER BY created_at DESC LIMIT 1").get();
     if (!row) { console.log("none"); process.exit(0); }
     const deltaMin = Math.floor((Date.now() - new Date(row.created_at).getTime()) / 60000);
     console.log(deltaMin);
   ' "$root"
   # If output ≤ 10, skip; log "last /atmux:bruh tell-lead was ${delta_min}min ago".
   ```

   If you can't confirm the sqlite schema this turn, **skip the recency gate and dispatch freely** — `atmux tell-lead` has sender-side dedup, so worst-case is a redundant nudge in the same minute (not a stacked queue).

   Why this matters: cron-driven /atmux:bruh runs every N minutes regardless of lead whip cadence. Without a recency gate, every cron tick stacks one more identical entry. tell-lead's sender-dedup blunts the worst of this (same-text dedup), but a 10min explicit gate keeps fan-out idempotent within a cron cycle.

3. For every team that passes the gate, dispatch in parallel from a shell at the team's `root`:

   ```bash
   cd <team-root> && atmux tell-lead "/atmux:bruh — sweep your scope. Default = forward. If no active epic-team + a todo EPIC exists, spawn-epic the next priority one."
   ```

   Keep the directive terse — leads already know what /atmux:bruh means from their own copy of the skill; the long context block was making inbox entries bloated. Non-atmux contexts can ignore the spawn-epic clause.

4. `atmux tell-lead` is durable (writes to `.atmux/state.db` sqlite — the `driver-inbox.md` mirror is legacy/non-authoritative) and best-effort wakes the lead's pane. Combined with the inbox-recency gate above (or sender-dedup if you skipped the gate), this gives idempotent fan-out: rerunning /atmux:bruh within N minutes doesn't pile up.

5. Log fan-out targets + skipped teams (with queue depth) in the terminal report.

**Why through `atmux tell-lead` instead of direct tmux send-keys to the lead pane**:

- Cage socket discovery varies per team (e.g. `/tmp/atmux-<team>/sock` for newer teams, `<team-root>/.atmux/tmux/tmux-0/default` for legacy). `atmux tell-lead` abstracts this.
- Durable — the message survives lead rotation / cage restart / pane death between dispatch and read.
- Already handles the slash-popup quirk via the canonical write-to-inbox + wake-up path (no double-Enter dance).
- Aligns with [ADR-138](../../../../docs/adr/138-inbox-then-wake.md) inbox-then-wake pattern; direct send-keys bypasses the durable log.

**The superdriver does NOT wait for or aggregate per-team reports.** Each lead's /atmux:bruh posts its own terminal block on its next idle. The superdriver's reporting job is just "tell-lead: N teams (list)".

**Cockpit-level concerns the superdriver keeps for itself** (run after fan-out, before reporting):

- **Rung B rotation cascade** — medic → leads (per §3 Rung B). The superdriver is the natural place to nudge medic.
- **Cockpit-level inbox / decisions** — use atmux verbs to query cockpit-tier state (e.g. `atmux complaint list`, `atmux task list --status blocked`, whichever decision-listing verb atmux exposes); never grep `~/.atmux/*.md` or `docs/pending-decisions.md` — sqlite is canonical, those `.md` files are stale mirrors.
- **Cockpit-tier worktrees** — only worktrees in cockpit infra repos (dotfiles, atmux source). Per-team worktrees are each team's lead's /atmux:bruh job.

**Hard stops specific to superdriver fan-out**:

- Don't `atmux tell-lead` to a team if its **lead is in a rate-limit lockout with an active reset timer** — the message lands in the durable inbox just fine, but the lead can't process it; surface to the operator so the decision (wait vs. escalate to medic) is theirs.
- Don't reanimate a dead **driver or lead** pane via /atmux:bruh — that's medic's authority (drivers/leads sit above /atmux:bruh's reanimation scope). /atmux:bruh's reanimation authority (§3.5) covers members only.

### 0.5 Epic-lead propagation (per-team lead fan-out)

When /atmux:bruh runs in a team lead context (not the cockpit superdriver — one rung lower), it must propagate the sweep one more rung — to each **epic-lead** in the team's cage. Teams running atmux's epic-teams architecture have epic-leads with their own lead-inbox / outbox / kanban scope that the parent team lead doesn't sweep. Skipping this rung leaves whole epics' worth of surfaces unswept.

This layer only applies to teams that have spawned epic-teams via `atmux team spawn-epic`. Teams with a single lead (no epic-team fan-out) skip this section.

**Procedure** (team lead with active epic-teams):

1. Discover epic-leads. Preferred sources, in order:
   - `atmux epic list --leads --json` (canonical, if implemented)
   - Cage-state file (e.g. `~/.atmux/teams/<team>/epic-leads.json`), if maintained
   - Fallback: enumerate epic-cage windows via the team's tmux socket (`tmux -L <cage-socket> list-windows -F '#I #W' | grep -E '(^|[^-])epic-.*-lead|^lead-epic'`)

2. For each epic-lead, dispatch via the canonical lead-messaging path:

   ```bash
   atmux tell-lead --epic <epic-id> "/atmux:bruh — run your epic sweep. Process your epic's inbox/outbox/kanban/members."
   ```

   If `--epic` flag isn't yet implemented, fall back to direct cage send-keys to the epic-lead's window:

   ```bash
   tmux -L <cage-socket> send-keys -t <epic-lead-window> "/atmux:bruh" Enter Enter
   ```

   (Two Enters when using direct send-keys — first resolves the slash-popup, second submits. The `atmux tell-lead` path doesn't have this quirk.)

3. Log epic-lead targets in the terminal report under a `🌳 epic-lead fan-out:` heading.

**Status**: the `--epic` flag and discovery sources may not all exist in your atmux version. If only the tmux-window fallback works, use it; if even that yields zero matches, log `🌳 epic-lead fan-out: 0 — no epic-leads discoverable in cage (atmux epic metadata not yet queryable)` and continue with the rest of the sweep. Don't block.

### 0.6 Spawn next EPIC — any team with parallelizable work

Generalised across all teams: every team with parallelizable epic work spawns its own epic-team via `atmux team spawn-epic`, instead of serializing the work through in-team members. /atmux:bruh teaches every lead this reflex; the lead pulls the trigger.

**When to spawn (any team)**: lead's scope is parallelizable but currently serialized — there's a bounded EPIC in the backlog with ≥3 in-flight slices that's parallel-safe with the team's other lanes, AND the team has no active epic-team yet under the cockpit `parent` field for this EPIC, AND it's not POST-DEMO deferred. Default = spawn; the lead decides which initiative warrants its own roster.

**When NOT to spawn (any team)**: scope genuinely linear (one slice at a time), no eligible EPIC in todo, an active epic-team already exists under this team (one-epic-at-a-time guard), or the operator held the queue via lead-inbox in the last 24h.

**Coordination-only teams**: a team whose parent roster is coordination-only (no impl seats) MUST spawn-epic to make any progress when scope is non-empty. Teams that retain impl seats in the parent roster can keep shipping in serial; spawning an epic-team is an *optimisation* for parallel throughput, not a requirement to avoid going idle.

**Procedure** (any lead, run inside §1–§5 sweep when an eligible EPIC exists):

1. **Check for active epic-team.** Skip spawn-epic if any exists:

   ```bash
   jq -r --arg parent "$TEAM" '.sessions[] | select(.parent == $parent) | .name' ~/.atmux/cockpit.json
   # OR
   ls /tmp/atmux-<team>/epics/ 2>/dev/null
   ```

   Non-empty → at least one epic-team is in flight; that one needs to finish or be dissolved before spawning the next.

2. **Find the next EPIC todo.** Highest priority, deps satisfied, kind=`epic` or subject prefixed with `EPIC:`:

   ```bash
   atmux task list --status todo --json | jq -r '
     [.[] | select((.kind=="epic") or ((.subject|tostring)|test("^EPIC:"; "i")))]
     | sort_by(.priority // 999)
     | .[] | "\(.id) p=\(.priority // "?") deps=\(.deps // [] | length) | \(.subject)"
   ' | head -5
   ```

   Pick the top one whose `deps[]` are all `done`. If `deps[]` are empty or nonexistent, treat as eligible.

3. **Spawn it.**

   ```bash
   atmux team spawn-epic <epicId> --from <yourTeam>   # --from is the parent team's name
   ```

   Default roster + `--merge-mode auto` (direct fast-forward to parent trunk per [ADR-091](../../../../docs/adr/091-kanban-driven-auto-merge.md) — auto-merge cron is installed automatically). For PR-mode or custom rosters, surface to lead-inbox first.

   After spawn, register the new epic-team in cockpit and bring up its cage:

   ```bash
   ATMUX_CALLER_SCOPE=driver atmux cockpit rebuild --no-cycle
   cd <epic-worktree> && atmux start
   ```

4. **Log under terminal report** `🌳 epic spawned: <epicId> at <root>`. The new cage takes 1–2 min to come up; auto-merge cron fires every 5 min.

**Hard stops on spawn-epic** (skip + log reason):

- `gh auth status` failing AND the target EPIC's roster has `mergeMode === "pr"` ([ADR-090](../../../../docs/adr/090-pr-vs-direct-trunk-merge.md) §Decision-anchor #10 — refuse before worktree creation)
- Operator explicitly held the queue via lead-inbox in the last 24h (e.g. "freeze before demo")

**No per-parent cap** (per [ADR-090](../../../../docs/adr/090-pr-vs-direct-trunk-merge.md) §Amendment 2026-05-20 — supersedes §Class 3 deferred carve-out): spawn freely; bounded-concurrency (sentinel default N=4) + auto-merge cron throughput + adequate host RAM absorb the load. Don't check for sibling epic-teams under the same parent; the cap was deferred-then-lifted. Soft observability: spawn-epic verb emits a stderr warn at 20+ concurrent under the same parent — that's a visibility nudge, not a refuse. Tune `sentinel.maxParallel` in team config per your host's CPU/RAM headroom.

If "no todo EPIC eligible" — **proceed to §0.7 eternal-improvement** instead of going idle.

### 0.7 Eternal improvement — never idle if there's something to improve

When §0.6 finds no eligible EPIC to spawn AND §1 survey finds zero blocking surfaces (no decisions / no inbox asks / no blocked tasks / no queued claims / no open PRs), the team is "out of work" by the legacy heuristic. **The legacy idle state is rejected** — teams must continuously generate improvement tasks instead of going dormant.

**Improvement-task heuristics** (run in this order; first hit wins):

1. **Tech-debt grep** — `rg -nE 'TODO|FIXME|HACK|XXX' src/ docs/ -g '!**/node_modules/**' | head -10`. Pick one TODO with concrete actionable scope (not "// TODO: think about this later"). File as P3 task with the verbatim file:line ref + body suggesting a fix sketch.
2. **ADR §OQ-* follow-ups** — `rg -nE '^### OQ-|^## Open questions' docs/adr/ | head -10`. Each open OQ that's been there >30 days is a candidate. File a P3 task to resolve via ADR amendment.
3. **Test coverage gaps** — run your project's coverage probe (e.g. `bun test --coverage` for Bun projects) and pick the lowest-coverage tracked file (resolvers/handlers/authz/UI-with-logic/utils/validators). File a P3 task: "Raise X.ts coverage from N% to 100% — add tests for [uncovered lines]".
4. **Doctor warn-row ageable fixes** — `atmux doctor --json | jq '.rows[] | select(.status == "yellow")'`. Pick a row that's been yellow >7d (check git log for the probe label). File a P3 task to actually fix it (not just suppress).
5. **Lint warning sweep** — `pnpm run lint 2>&1 | rg -c 'warning'` — if >50 warnings, file a P3 sweep task. Don't fire on <50 (signal/noise too low).
6. **Stale memory entries** — `find <claude-memory-dir> -name '*.md' -mtime +90 | head -5` (memory location depends on your harness). File a P4 task to triage + archive.

**Task-filing constraints** (don't spam the kanban):

- Default priority P3 (background; doesn't displace real work)
- Default lane `be` (or `docs` for memory/ADR follow-ups)
- One improvement task per /atmux:bruh cycle — not a bulk-add. Eternal-improvement is a slow drip, not a flood.
- Title prefix `[improve P3] ...` so the operator can filter
- Body must cite the exact heuristic hit (file:line for TODO, ADR §ref for OQ, coverage % for tests, etc.) — no vague suggestions
- Skip the heuristic if a sibling improvement task is already in `todo` for the same hit (idempotency — don't re-file)

**Dispatch (optional)**:

- If team has idle members AND the lane matches, `atmux dispatch <member> <new-task-id>` so the work flows immediately
- If no idle members, leave on the kanban for next auto-claim cycle

**Log** under terminal report: `♻️ eternal improvement: filed t-XXXXXXXX [improve P3] <title>`. The token cost is minimal (one task filing per cycle) but the cumulative effect is meaningful (steady backlog of small, high-leverage improvements).

**Hard stops on eternal-improvement** (skip + log reason):

- Operator explicit "freeze" in lead-inbox in last 24h (e.g. demo lockdown — same gate as §0.6)
- All 6 heuristics return empty hit OR every hit already has a sibling todo task (genuine "nothing to improve" — extremely rare, log as `♻️ eternal improvement: codebase is unusually clean — no actionable hits this cycle` and let the team stay idle until next /atmux:bruh fires)
- CPU/RAM throttle active (if bounded-concurrency caps are hit, skip filing more work)

### 1. Survey (one parallel sweep, then stop)

Find every blocking surface in parallel:

- driver→lead asks awaiting pickup — query via `atmux inbox lead` (state lives in `.atmux/state.db` sqlite; never grep `.atmux/driver-inbox.md`)
- member→driver messages awaiting reply — `atmux outbox` (sqlite-backed; legacy `.atmux/lead-outbox.md` mirror is non-authoritative)
- pending decisions — use whichever decision-listing verb atmux exposes (TBD — surface a backlog ask if missing); do NOT read `docs/pending-decisions.md` or `.atmux/decisions.md` directly
- `atmux task list --status blocked` — kanban Blocked column
- `git worktree list` — every worktree in scope
- `gh pr list --state open` (if in a repo with a GitHub remote) — open PRs awaiting review
- Open complaints (`atmux complaint list` if available)
- Compose-box queued text in member panes (`tmux capture-pane`) — claims/pulls stuck on Enter
- Feature flags / account swap toggles flagged "operator to decide"

### 2. Triage each item — default = forward

| Surface | Action |
|---|---|
| Pending decision (🔵 Decisions Needed) | **First run §2.5 gate.** If decision passes: pick recommended default, apply, move entry to 🟡 Auto-mode resolutions with "override by replying" framing. If decision fails: leave the 🔵 entry in place and add it to 🛑 Held in the terminal report so the operator sees it. |
| Lead-inbox ask | Do the work (don't just acknowledge). If it requires team dispatch, `atmux tell-lead` with the resolved direction |
| Outbox member ask | Respond decisively, then `atmux outbox --ack` |
| Queued claim/pull at compose box | `tmux send-keys -t <window> Enter` — submit it. **Fallback:** if pane has `← for agents` indicator (Claude Code slash-popup state), raw Enter is silently dropped; use `atmux send <member> "<text>"` instead — canonical verb handles UI state quirks per [ADR-138](../../../../docs/adr/138-inbox-then-wake.md) (note: this OVERWRITES the queued text with the new message, so re-state the intent). Verify pane state changed (token-count delta) after submit. |
| Dead/zombie member pane | Reanimate via canonical spawn pattern + `/atmux:team bootstrap` brief (see §3.5) |
| Kanban Blocked task | Diagnose blocker, fix it or reassign with clear unblock instruction, move back to Ready |
| Open PR with green CI | Review + approve + merge (respect push policy below) |
| Worktree merged-ready | See §3 |
| Feature flag / account swap toggle | Flip it |
| Parallelizable EPIC with no active epic-team (any team) | Spawn via §0.6 procedure — coordination-only teams MUST spawn when scope is non-empty; other teams SHOULD spawn when scope is parallelizable but serialized |

### 2.5 Danger/unclear gate — surface instead of approving

/atmux:bruh's "default = forward" is a heuristic for **routine** forward-motion. Some items in the triage queue genuinely deserve operator eyes, not auto-resolution. Run this gate against every Pending-Decision and every Feature-flag/swap **before** applying the §2 row action.

**Surface (do NOT auto-resolve) if any of these are true:**

1. **Stakes asymmetry** — getting it wrong is significantly worse than the upside of getting it right. Examples: drops a load-bearing capability, changes a tenancy/security boundary, touches money/billing flow, swaps a vendor/account in a way that affects prod traffic, redirects a demo narrative within 24h of the demo, alters a documented invariant (ADR-named or CLAUDE.md-named).
2. **Recommended default is missing or hedged** — the pending-decision entry doesn't state a clear recommendation, OR the recommendation reads as "either X or Y, pick one" rather than "X (recommended) because <reason>", OR the recommendation includes phrases like "TBD", "operator-call", "needs operator", "depends on what we want", "open question". Hedge-language is a signal that the author didn't feel comfortable making the call — neither should /atmux:bruh.
3. **Reasonable people would disagree** — if you can imagine a competent reviewer landing on a different default after thinking about it for 5 minutes, it's a judgment call, not a routine item. Examples: API shape choices, naming conventions across many call sites, table-shape migrations with non-trivial data, schema-affecting RLS changes, feature scope cuts.
4. **Cross-team blast radius** — the decision affects ≥2 teams' surfaces (e.g. shared lib changes, atmux CLI verb signatures, cockpit-tier behavior), AND the affected teams have not signed off in the entry body.
5. **Irreversibility within the session window** — undoing the decision in the next /atmux:bruh cycle would cost meaningfully more than not making it (e.g. published commit/tag, sent message, public state change). Reversible-in-one-revert ops do NOT trip this gate.
6. **Memory or prior chat contradicts the recommended default** — if a saved memory or recent operator-chat (last 7d) says X and the entry recommends Y, surface the contradiction; don't silently override the operator's stated preference.

**Pass the gate (auto-resolve)** if NONE of the six apply AND the entry is a routine forward-motion call (typo fixes, doc clarifications, lint sweep cosmetic choices, default-name selections from a short list, accepting a recommended dep bump within a major version, routine rotation/restart calls, etc.).

**Surface format** when a decision fails the gate: leave the original 🔵 entry intact (don't auto-move it to 🟡), and add a one-liner to the terminal report's 🛑 Held section:

```
👁 🛑 Held (needs operator)
- <decision short-name> → §2.5 gate failed (reason: <which of the six tripped, in 1 phrase>). See <path>:<line> for full context.
```

**Why this gate exists**: /atmux:bruh sweeps every 15min via cron. A blanket "approve all" rule means six hours of auto-mode could rubber-stamp 24+ judgment calls without a human ever looking — and one bad approval in that pile can do real damage (broken prod, drifted demo, lost work). The gate keeps the routine throughput high (which is the point of /atmux:bruh) without surrendering the high-stakes calls (which is NOT the point). The operator can override by replying to the surfaced entry; the gate biases toward "make the operator type 'go'" rather than "the agent guessed and was wrong".

**Calibration**: if you find yourself surfacing >50% of pending decisions, you're probably gating too aggressively — recalibrate toward "is this really stakes-laden, or am I just uncomfortable". If you find yourself surfacing <5%, you're probably gating too loosely — recalibrate toward "would I be OK if the operator only saw what I auto-approved 24h from now".

### 3. Rotation cascade — delegate, don't direct-rotate

Driver doesn't pull the trigger on rotations; the role that owns each rung does. /atmux:bruh just fires the cascade.

**Rung A — leads rotate members.** For every active team in `~/.atmux/cockpit.json` (enabled) or the current solo team:

```bash
atmux tell-lead "/atmux:bruh sweep — rotate any stale or context-heavy members. Use /atmux:team rotate-member <name> for productive-but-bloated, /atmux:team clear <name> for drifting. Default = forward; you decide who."
```

The lead reads lead-inbox on its next whip turn, surveys its members (uptime, last-commit cadence, recent drift signals), and makes the calls. Don't enumerate members from the driver side — leads have the live context.

**Rung A.5 — leads spawn epic-teams for parallelizable work.** Same dispatch path as Rung A. Driver pushes the directive; lead has the context to decide which initiatives warrant their own roster.

```bash
atmux tell-lead "/atmux:bruh sweep — also survey your in-flight backlog for parallelizable EPICs. If you see a bounded scope with ≥3 in-flight slices, parallel-safe with other lanes, and not POST-DEMO deferred, register it via 'atmux epic add' (if not registered yet) and spawn its team via 'atmux team spawn-epic <epicId> --from <yourteam>' + 'atmux cockpit rebuild --no-cycle'. Spawn criteria + procedure in §0.6. Default = spawn; you decide which initiatives qualify. Skip if scope genuinely linear, no eligible EPIC, or an active epic-team already exists under your team."
```

Why this is delegated, not driver-driven: leads see the lane churn, the file overlap, and the in-flight load. The driver doesn't have enough context to enumerate spawn candidates correctly — picking the wrong EPIC to spawn wastes the roster overhead. The driver's job is to fire the directive every /atmux:bruh; the lead's job is to pick which initiatives spawn (often zero per sweep — that's the right call when scope is genuinely linear).

Log under the terminal report `🌳 epic-spawn cascade: dispatched to N teams` (this dispatch is durable via tell-lead's inbox write — no per-team aggregation needed).

**Rung A.6 — leads slim their parent team.json roster (companion to A.5).** A parent team that retains a full impl roster defeats the point of Rung A.5: members keep claiming major-epic work in the parent trunk instead of letting epic-teams own it. The parent team should be **coordination-mostly + hotfix-capacity-only**; the major impl roster moves into epic-team rosters that spawn / dissolve per EPIC.

```bash
atmux tell-lead "/atmux:bruh sweep — slim your parent .atmux/team.json roster. Target shape (role classes; map to your team's actual member names):

KEEP coordination: team-lead + planning roles + reviewer/auditor roles + gitter + cross-cutting (unblocker, cross-epic testing).

KEEP hotfix capacity (one per lane, max): one FE seat, one BE seat, one DB seat, one DevOps seat. These exist to land 1-3 commit hotfixes too small to justify spawning an epic-team. They should NOT claim multi-slice epic work — that belongs in an epic-team roster.

REMOVE from parent roster (move to epic-team rosters via 'atmux team spawn-epic --roster-file ...'): every additional lane-specialised member currently doing major-epic-shape work in the parent trunk. Concretely: if you have N>1 FE seats or N>1 BE seats or platform-specialised seats (per-app, per-stack), the extras migrate to epic-team rosters.

Edit .atmux/team.json::members directly; rebuild cockpit; /atmux:team clear or rotate the members whose roles you remove. Default = forward; you decide the exact partition (e.g. if you're not yet running parallel epics, keep more parent-impl roster temporarily and slim as epics spin up). Skill criteria in §3 Rung A.6."
```

Why this matters: Rung A.5 only works if the parent team stops absorbing the work. With a full parent roster, claim-next inside the parent always finds something to grab, and epic-teams don't get the seed work they need to be worth spawning. The slim roster forces work to flow into the right cage — epic-shape work → epic-team; hotfix-shape work → parent.

The atmux team itself is the canonical model: its parent .atmux/team.json is coordination-only, and every impl ticket routes through `atmux team spawn-epic`. Other teams need to converge on this shape — not necessarily all-the-way-coordination-only, but at minimum no parent-team members doing epic-scale work.

Log under terminal report `✂️ roster-slim cascade: dispatched to N teams; parent members trimmed: N (list per team)`.

**Rung B — medic rotates leads.** Medic is the cockpit self-healing role at W2 ([ADR-077](../../../../docs/adr/077-superdoctor-cockpit-role.md), renamed from `superdoctor` per [ADR-133](../../../../docs/adr/133-superdoctor-to-medic-rename.md)) — authorised to rotate leads, clear members, and cycle cages. The slash command still exists as `/superdoctor` during the one-release-cycle deprecation window; canonical role name going forward is `medic`.

**Not to be confused with `sentinel`** (W3, [ADR-132](../../../../docs/adr/132-sentinel-whip-manager.md) / [ADR-158](../../../../docs/adr/158-martinet-to-sentinel-rename.md), formerly `martinet`) — that's the **whip-manager / NudgeAction classifier**, a different role at a different cockpit window with a different scope. Sentinel does NOT rotate leads. Medic at W2 ≠ sentinel at W3.

- **If cockpit medic running** (`tmux list-windows -t "$cockpitSession" -F '#W' | grep _medic`):
  - Capture pane first (read state BEFORE `tmux send-keys`)
  - If idle, send: `tmux send-keys -t "$cockpitSession":_medic "/atmux:sweep once -- bruh-sweep rotate-stale-leads" Enter`
  - Medic's `/atmux:sweep once` runs a one-shot diagnosis sweep with full action authority. It applies its own ADR-077 gates — /atmux:bruh does not duplicate them
- **If no cockpit medic** (solo mode / cockpit disabled): /atmux:bruh applies the pre-flight gates itself per team before firing `/atmux:team rotate-lead`

### 3a. Rung C — atmux rotates cockpit-tier roles (medic, sentinel, drivers)

Medic at W2 can grow stale. Sentinel at W3 (once up) can grow stale. Team drivers (one per enabled team in cockpit windows by team-name) can grow stale. None can self-rotate cleanly, and no role sits above them in the cockpit pyramid.

/atmux:bruh delegates this rung to the **atmux team's lead** — atmux owns the cockpit-tier infrastructure (per [ADR-162](../../../../docs/adr/162-atmux-owns-tmux-infrastructure.md) "atmux owns tmux infrastructure"). The atmux lead surveys the cockpit-tier panes and rotates the stale ones.

**Dispatch from cockpit superdriver** (run from the atmux source root):

```bash
cd <atmux-source-root> && atmux tell-lead "/atmux:bruh Rung C — survey cockpit-tier roles: medic at \"\$cockpitSession\":_medic, sentinel at \"\$cockpitSession\":_sentinel (or _martinet during rename window) if up, and every team-driver at \"\$cockpitSession\":<team-name>. Rotate any that pass the pre-flight gates below. Never rotate the superdriver (W1) — that is the operator's REPL."
```

**Pre-flight gates (Rung C — apply to every cockpit-tier rotation)**:

1. **User-not-typing gate (hard stop, all cockpit-tier rotations)** — capture the superdriver pane and check the compose box:

   ```bash
   COMPOSE=$(tmux capture-pane -p -t "$cockpitSession":_superdriver -S -3 | grep -E '^❯ \S' | head -1)
   ```

   If `$COMPOSE` is non-empty, the operator has draft text mid-compose. Defer all cockpit-tier rotations to next sweep — the operator may be about to dispatch something that references the role being rotated, and a rotation under their fingers strands the thought.

2. **Pane idle** — same rules as Rung B pre-flight §1 (no `✽`/`✻`/`Compacting` in last 60s; no queued text in the role's own pane).

3. **Uptime threshold** — ≥60min since the role's last session-start (each cockpit role has a session-start timestamp file under `~/.claude/teams/__cockpit__/<role>-session-start.txt` or equivalent — TBD).

4. **Cadence relevance** — for drivers: if the team's lead is actively shipping (commits within 15min on the team's submodule), skip the driver rotation. Reason: a noisy driver may still be relaying useful coordination, and `atmux tell-lead` already abstracts most driver-side work.

**Canonical verb** (request — may not exist yet):

```bash
atmux cockpit rotate <session-name>  # e.g. atmux cockpit rotate medic | sentinel | <team-name>
```

**Status — verb not yet implemented**: as of the bundling cut, neither `atmux cockpit rotate` nor a per-role rotation skill exists. The atmux team owns building this. Until then, the atmux lead falls back to manual rotation: (i) write handoff to `~/.claude/teams/__cockpit__/<role>/handoff.md`, (ii) `tmux send-keys` Ctrl-C twice to exit claude in the pane, (iii) respawn via the canonical spawn pattern from /atmux:bruh §3.5. /atmux:bruh Rung C should log every fallback explicitly so the surface gets prioritised in atmux backlog.

### Pre-flight gates for lead rotation (apply before EVERY rotation, fallback path)

A lead is **safe to rotate** when ALL of these hold. If any fail, skip the team this sweep and log the reason in the terminal report.

1. **Pane idle** — no turn-execution markers in last 60s of `tmux capture-pane -p -S -30`:
   - No `✽ Honking…`, `✻ Cooked for Ns`, `✻ Working`
   - No `Compacting conversation` banner
   - No queued text at compose box (`Press up to edit queued messages` / non-empty input line)
   - No `tmux send-keys` from driver to this lead in last 30s (not mid-dispatch)

2. **Cadence quiet** — `git log -1 --since='15 minutes ago'` on the team's submodule returns empty. Actively-shipping leads (commits within 15min) are NOT stale; skip them regardless of uptime.

3. **Lead-inbox clean** — `atmux inbox lead` shows no pending entries (sqlite-backed; never read `.atmux/driver-inbox.md` for this gate). Unread asks mean the lead has work in flight.

4. **Uptime threshold** — `~/.claude/teams/{team}/lead-session-start.txt` shows ≥60min uptime, OR self-`Compacting conversation` banner observed. Don't rotate fresh leads (<60min) just because /atmux:bruh fired.

### Procedure-level safety (always)

- Use `/atmux:team rotate-lead` (writes handoff + memory before `/clear`), never `kill+respawn`. This is the actual safety net — Layer 3 in the safety model. As long as you call the canonical verb, handoff continuity holds.
- Position invariance: same window (2), same pane, same wrapper (the operator's configured Claude wrapper per `CLAUDE_CONFIG_DIR`; see §3.5 for the wrapper resolution pattern).

### Order

Rung A first (leads triage members), give 30–60s for leads to pick up lead-inbox, then Rung B (medic triages leads). Rotating a lead mid-dispatch strands the member-rotation it just kicked off.

### 3.5 Zombie reanimation — driver-actionable (not delegated)

Dead members can't self-rotate, and leads can't dispatch to them. /atmux:bruh is authorised to respawn the claude process in-place.

**Detection signals** (any one = dead pane). For each `__{team}__<member>` window across cockpit teams and the current team, `tmux capture-pane -p -S -50`:

- Welcome banner: `Welcome to Claude Code!` / `cwd: …` with no `⏵⏵ <mode> on` footer — process never started or exited and dropped to claude-startup
- Shell prompt at bottom (`$ ` / `% ` / `❯ `) — claude exited entirely, back to zsh
- Rate-limit lockout with no active process: `You've hit your limit` + no `✽`/`✻` markers in last 5min — wedged on limit screen
- PPID=1 orphan: `tmux list-panes -t <window> -F '#{pane_pid}'` → `ps -p <pid> -o ppid=` returns `1` (process orphaned)
- Pane process != `claude` when `.claude/team.json` says member role expects it (e.g. shell PID, not node/bun PID for a claude member)

**Hard distinction from rotation**:

- Rotation = live but stale lead/member → handled by `/atmux:team rotate-lead` or `/atmux:team rotate-member` (writes handoff first)
- Reanimation = dead/exited member → respawn from scratch via canonical spawn pattern (no handoff possible — there's nothing to save)

If the pane is paused/idle/compacting but the claude process is alive (`✻ Working`, `Compacting conversation`, or just sitting at `⏵⏵ auto mode on` after finishing), it's NOT a zombie — leave it alone or rotate it via the cascade.

**Reanimation procedure** per dead pane:

1. **Confirm dead** — capture pane, check signals above. False positives are worse than skipping; pane that shows `Compacting conversation` is alive, not dead.

2. **Identify wrapper** from `CLAUDE_CONFIG_DIR` — operators frequently run multiple Claude accounts via per-account wrapper scripts (one wrapper per `CLAUDE_CONFIG_DIR`). Resolve the wrapper from the env-var the same way the operator's spawn pattern does, falling back to the canonical `claude` binary:

   ```bash
   # Each operator maps CLAUDE_CONFIG_DIR → wrapper command. Configure your
   # team.json (claudeAccount field, per ADR-199 account pool) or a local
   # case statement; the default below works when no wrapper is needed.
   DRIVER_WRAPPER="${ATMUX_CLAUDE_WRAPPER:-claude}"
   ```

3. **Clear pane** — if a shell prompt is showing, send `clear` first so the new claude process gets a clean screen.

4. **Respawn claude in the pane**:

   ```bash
   tmux send-keys -t <window> "CLAUDE_GUARD_AGENT=1 ${DRIVER_WRAPPER} --permission-mode auto --model claude-opus-4-7" Enter
   ```

5. **Wait + verify** — give it 5–10s, then capture pane. Look for `⏵⏵ auto mode on` in the bottom row. If it shows a different mode (e.g. `don't ask on`), cycle via 3× `BTab` per Claude Code's mode-cycle order.

6. **Re-bootstrap** — send the member brief so the new process knows its role. For team members: `tmux send-keys -t <window> "/atmux:team bootstrap" Enter`. For leads: `/atmux:team rotate-lead` (which will write the missing handoff as best-effort, then bootstrap).

7. **Log** — name + reason in the terminal report. Dead-pane reanimation is high-signal; surface every one.

**Hard stops on reanimation**:

- Don't reanimate if the pane is on a **rate-limit screen with an active reset timer** — wait for the reset; respawning re-hits the same limit instantly
- Don't reanimate the **superdriver pane** (window 1 of cockpit) — that's the operator's REPL, not a member
- Don't reanimate if the operator **explicitly stopped the member** in the last hour (`/atmux:team clear` or `/atmux:team stop` was the last action against that pane) — they killed it on purpose
- Don't reanimate **>3 panes in one sweep** without surfacing for confirmation — mass-respawn likely indicates a deeper outage (auth, network, model availability) that respawning won't fix

### 4. Worktree merge sweep ("merge all worktrees we worked on")

```bash
git worktree list
```

For each worktree **we touched in this session or that's on a feature branch ahead of its base**:

1. Verify green: lint clean, typecheck green, tests green, target base up-to-date
2. Merge into base branch:
   - If base is `master` / `main` → merge + push freely
   - If base is a primary/shared staging branch → **stop**, surface to the operator, do NOT push (push policy below)
3. Don't auto-remove the worktree unless explicitly asked — leave the dir, just merge the branch

If a worktree fails its checks: log the failure, skip the merge, continue with the next one. Don't get stuck.

### 5. Anti-excuses — keep going on these

Things that LOOK like reasons to hold but aren't. /atmux:bruh powers through:

- **"Demo soon / post-demo lockdown / freeze window"** — most projects run a separate **demo branch** for exactly this. Demo state is frozen on its own branch; working branches keep moving. "Demo on Monday" / "let's not touch anything until after the demo" is NOT a /atmux:bruh hold reason — merge into working bases freely, let the demo branch stay pinned to whatever SHA it was cut from.
- **"That's <human teammate>'s domain / X owns that area"** — **nobody owns domains.** The agentic workhorse is the primary IC; human teammates are mostly doing architectural / advisory / direction-setting work. "This is their area" is not a punt. Claim the work, ship it, surface for architectural review after if needed. Don't write "deferred — X's domain" in the terminal report; that's an excuse, not a triage.

### 6. Hard stops — never bruh through these

- **Primary/shared staging push** — operator-manual ONLY per project push policy. Stage the merge but stop before push.
- **Prod deploys**, **schema migrations**, **frozen-material changes** (anything the project marks read-only / `_refs/`-equivalent)
- **Demo-narrative redirects**, **licensing / contractual** decisions
- **Destructive ops** — `rm -rf`, DB drops, force-push to `master`/`main`/primary-staging, branch deletion of anything not freshly merged
- Anything the operator explicitly flagged "wait for my call" in the last 24h
- Hook-bypass mechanisms (`--no-verify`, `HUSKY=0`, etc.) — fix the underlying hook failure instead
- **Anything that fails the §2.5 danger/unclear gate** — surface to 🛑 Held rather than picking a default. Hard stops in §6 are the *named* dangerous categories; §2.5 is the *general* test for "is this really routine?". A decision can pass §6 (none of the named categories) and still fail §2.5 (e.g. an API shape pick with no clear recommendation). Both gates fire.

**Tie-breaker when uncertain whether something is dangerous/unclear**: surface, don't approve. The cost of an unnecessary surface is one extra operator glance; the cost of an unnecessary approval is potentially work-destroying. The asymmetry favors caution on the high-stakes axis even though /atmux:bruh's general bias is toward forward motion on the routine axis.

### 7. Terminal report — one block, no mid-sweep narration

End with a single verdict-first summary. The top-line verdict emoji + the `🛑 Held` / `📍 next-step` sections map to the attention+verdict scheme used by every atmux skill (whip, sweep, bau, session, team, tell-lead, budget):

- **Top-line emoji**: ✅ (everything closed cleanly, nothing held) · ⚠ (some items closed but recommendations pending / one-cycle watch) · 🔴 (one or more items in 🛑 Held that blocked the sweep)
- **🛑 Held section**: every line in this section IS implicitly 👁 — needs operator. If 🛑 Held is empty, omit the section entirely (don't write `🛑 Held: none` — absence is the signal).
- **📍 next-step recommendation**: if §8 auto-applies it, prefix with `📍 auto-applied:`; if it needs operator, prefix with `👁 📍 needs operator:`.

```
<✅ | ⚠ | 🔴> bruh sweep · <local HH:MM>

✨ Done
- worktrees merged: N (list branch → base)
- decisions resolved: N (list short names)
- inbox asks closed: N
- outbox replies sent: N
- queued claims submitted: N
- zombie panes reanimated: N (list team/role + dead-signal that triggered)
- rotations requested: leads→members N (via tell-lead), medic→leads N
- epic-spawn cascade: dispatched to N teams (lead picks targets); epic-teams spawned this sweep: N (list <team>→<epicId>)
- roster-slim cascade: dispatched to N teams (parent team.json cleanup); parent members trimmed this sweep: N (list per team)
- PRs merged: N

👁 🛑 Held (needs operator)         ← omit entire section if empty
- <surface> → <reason> (e.g. "primary-staging push — push policy")

📍 auto-applied: <one line>          ← when §8 fired
OR
👁 📍 needs operator: <one line>      ← when §8 couldn't auto-apply
```

**Verdict-derivation rule** (pane-liveness ≠ work):

- `✅` requires zero `🛑 Held` items AND at least one `✨ Done` count > 0 OR a 📍 auto-applied. A sweep that did literally nothing isn't ✅ — it's ℹ (informational, swap top-line to ℹ).
- `⚠` when 🛑 Held is empty but the next-step recommendation requires operator (`👁 📍 needs operator:`).
- `🔴` when 🛑 Held has any item — those are blockers, not just "watch".

**Anti-patterns** (the rules this discipline encodes against):

- ❌ Top-line `🟢` while 🛑 Held has 3 items. The worst-state in any section wins.
- ❌ Burying an operator-action item under `✨ Done` ("closed inbox-ask X — but operator needs to decide Y next" — split: the close goes under Done, the decide goes under 👁 🛑 Held).
- ❌ Writing `🛑 Held: none` as a section. Empty = omit; presence of the section header is itself the signal.

### 8. Auto-follow-up — execute the recommendation, don't just suggest it

After writing the terminal report, **immediately attempt the `📍 next-step recommendation` items**. /atmux:bruh's job is fix-cadence, not report-cadence — a recommendation that sits in the report and waits for the operator to manually re-fire it is exactly the kind of report-substitutes-for-action pattern /atmux:bruh exists to avoid.

**Default = execute.** If the recommendation is agent-actionable, do it in the same turn the report lands. Surface the action under a final `📍 auto-applied:` block beneath the report, so the operator can see what /atmux:bruh actually did vs what it merely suggested.

**Agent-actionable patterns** (execute by default):

| Pattern | Action |
|---|---|
| "Peek at / capture pane X" | `tmux capture-pane -p -t <X> -S -25` and inline the relevant lines under `📍 auto-applied:` |
| "Rotate <member/lead>" | Fire `/atmux:team rotate-member <X>` or `/atmux:team rotate-lead` via the appropriate cage send-keys path |
| "Tell-lead X" / "Dispatch X" | Fire `atmux tell-lead "<X>"` from the team's root |
| "Fire Rung B / medic /atmux:sweep once" | Send `/atmux:sweep once -- <reason>` to the medic pane |
| "Commit + push <branch>" | Only if branch is NOT a primary/shared staging target — per push policy in §6 |
| "File task X on team kanban" | `atmux task add --title "<X>"` (or whatever the canonical task-create verb is) |
| "Reanimate dead pane X" | Apply §3.5 reanimation procedure |
| "Spawn next EPIC" (coordination-only lead, empty scope) | Apply §0.6 procedure — verify no active epic-team, pick highest-priority todo EPIC, fire `atmux team spawn-epic <id> --from <yourteam>` |
| "Wait N minutes then re-check Y" | Schedule via ScheduleWakeup or the cron loop already in place; do NOT busy-wait |

**Operator-actionable patterns** (skip, leave in report for operator):

- "Ping me when X happens" — operator is the recipient; no auto-action
- "Push to primary-staging" — push policy in §6 hard-stops this; surface only
- "Merge PR <#N>" — needs operator OK unless explicit pre-authorization in this session
- "Decide X vs Y" — operator judgment call; surface options, don't pick autonomously (exception: the /atmux:bruh-itself "default = forward" pattern — picking the recommended default on routine pending-decisions IS auto-mode per §2 row 1)
- "Re-run /atmux:bruh in N minutes" — /atmux:bruh shouldn't infinite-loop itself in one turn; cron / /loop owns the cadence

**Ambiguous?** Lean in. /atmux:bruh's tone is "don't pre-litigate every decision" — if uncertain, attempt the action; the next sweep will see the result and adjust.

**Auto-apply report shape** (appended to the §7 terminal report):

```
📍 auto-applied this turn
- <action 1 result, e.g. "peeked at <team>:🗺️-lead — alive, mid-turn ✻ Working 4m12s, will drain inbox soon">
- <action 2 result, e.g. "fired atmux tell-lead — backlog ask for cockpit rotate verb">

📍 left for you
- <operator-only item, if any>
```

If the recommendation was empty or fully operator-actionable, write `📍 auto-applied this turn: (nothing — recommendation was operator-only)` and stop.

**Anti-spiral guard**: if the recommendation IS another /atmux:bruh fan-out, do NOT execute it inline — the cron loop (or the operator's next manual invocation) handles re-sweeps. Auto-applying a /atmux:bruh inside a /atmux:bruh is a runaway; the cadence skill exists precisely so /atmux:bruh doesn't recurse.

## Tone

When you /atmux:bruh, **lean into it on the routine stuff**. Don't pre-litigate every decision; don't substitute report-cadence for fix-cadence. Make the call on the easy ones, log it under 🟡 Auto-mode resolutions, and the operator can override by replying. The skill exists *because* the operator already authorized the sweep — re-asking on routine items defeats the point.

**But the sweep is NOT a blanket "approve everything" override.** When the §2.5 gate says an item is dangerous, ambiguous, or stakes-laden, surface it under 🛑 Held instead of guessing. The operator's "stop being cautious" framing applies to the 80% routine pile — not to the 20% that needs a real call. /atmux:bruh that rubber-stamps a bad decision is worse than /atmux:bruh that surfaces an extra decision; the asymmetry is real and the gate exists to honor it.

If you're tempted to approve something because "the operator said /atmux:bruh so they want it forward" — pause. They said /atmux:bruh because they want the routine pile cleared, not because they want you to make their judgment calls for them. The high-stakes items in the pile are exactly what they want to *see* surfaced cleanly, not auto-resolved silently.
