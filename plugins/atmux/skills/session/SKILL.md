---
name: session
description: Unified session-continuity skill. Verbs — cont, preclear, handoff, stop. Replaces cont, preclear, handoff, full-stop. Use /atmux:session <verb> [args].
argument-hint: <verb> [verb-args…]
---

<!-- carved per ADR-217 §D4 -->

# /atmux:session — Unified Session Continuity

Single dispatcher for all session-lifecycle actions — resuming, preparing, handing off, shutting down. Dual-harness (Claude + tmux, or OpenCode + plugin-orch).

## Verbs

| Verb | Summary |
|---|---|
| `cont` | Resume work after `/clear`. Auto-detects mode (driver / lead-window / solo / no-team). Reads handoff.md + dispatches resume tasks. |
| `preclear` | Prepare the CURRENT session for `/clear` — save handoff + memory + tasks. Never touches the team. Mode-aware (driver = sanity+exit; solo/lead = full save). |
| `handoff` | Write a forward-going brief for a fresh claude spawned in a new worktree / branch / tmux session. Distinct from `preclear` (which is for same-session `/clear`). |
| `stop` | End-of-day: destructive team shutdown + final `[FULL-STOP]` handoff. Composite of `/atmux:team stop` + `/atmux:team cleanup` + handoff write. |

## Shared preamble (runs for every verb)

1. **Parse verb.** First arg = verb. Unknown → error `"Usage: /atmux:session <verb> [args]. Verbs: cont|preclear|handoff|stop"`.
2. **Detect harness** (dual-harness routing):
   - If `orch_create` / `orch_spawn` / `orch_shutdown` / `orch_memo` tools are available → **orch path** (OpenCode+plugin-orch).
   - Otherwise → **Claude + tmux** (default).
3. **Dispatch to verb body.**

## Handoff file path convention

Every verb that reads or writes a handoff uses this convention:

- **Primary:** `~/.claude/projects/<project-slug>/todo/<branch>/handoff.md`
  - `<project-slug>` = repo root's absolute path with `/` → `-` (e.g. `/home/user/projects/myapp` → `-home-user-projects-myapp`)
  - `<branch>` = current git branch
- **Dual-harness copy:** `{cwd}/HANDOFF.md` — written when the project is dual-harness (detect via `.opencode/` dir OR `CONT.md` at repo root). Add `HANDOFF.md` to `.gitignore`.
- **OpenCode-specific:** `{cwd}/CONT.md` — resume guide that sometimes accompanies `HANDOFF.md`; `cont` reads it if present.

Handoffs are **global** (never in-repo) to avoid polluting git and make cleanup predictable: `find ~/.claude/projects/*/todo/*/handoff.md`.

---

## Verb — `cont`

Resume work after `/clear`. Mode-aware.

### Step 0 — Detect mode (BEFORE anything destructive)

```bash
TEAM="$(jq -r .name .claude/atmux:team.json 2>/dev/null || echo '')"
MY_WINDOW="$(tmux display-message -p '#{window_name}' 2>/dev/null || echo '')"

# Resolve LEAD_WIN — cascade: emoji-prefix → member-name-suffix → legacy.
# Schema-tolerant: matches lead by .role / .agentType / .name == "team-lead",
# since different team.json shapes put the lead-role marker in different fields.
# - emoji-prefix handles teams whose window is named "<emoji>lead" with the
#   emoji declared in team.json (.members[].emoji)
# - name-suffix handles teams whose window endswith the member.name (e.g.
#   "🧭team-lead") with no emoji field in team.json
# - legacy "__${TEAM}__team-lead" handles older teams with no naming convention.
# Scope tmux searches to the calling session (when invoked from a tmux client),
# falling back to all sessions otherwise. Defense-in-depth against cross-team
# window collision when multiple teams share member names (e.g. two teams both
# defining a "reviewer" member).
TMUX_SCOPE="-a"
if [ -n "${TMUX:-}" ]; then
  MY_SESSION=$(tmux display-message -p '#{session_name}' 2>/dev/null)
  [ -n "$MY_SESSION" ] && TMUX_SCOPE="-t $MY_SESSION"
fi

LEAD_EMOJI="$(jq -r '.members[] | select(.role == "team-lead" or .agentType == "team-lead" or .name == "team-lead") | .emoji // empty' .claude/atmux:team.json 2>/dev/null | head -1)"
LEAD_NAME="$(jq -r '.members[] | select(.role == "team-lead" or .agentType == "team-lead" or .name == "team-lead") | .name' .claude/atmux:team.json 2>/dev/null | head -1)"
LEAD_WIN=""
if [ -n "$LEAD_EMOJI" ] && [ "$LEAD_EMOJI" != "null" ]; then
  LEAD_WIN=$(tmux list-windows $TMUX_SCOPE -F '#{window_name}' 2>/dev/null | grep -m1 "^${LEAD_EMOJI}")
fi
if [ -z "$LEAD_WIN" ] && [ -n "$LEAD_NAME" ]; then
  LEAD_WIN=$(tmux list-windows $TMUX_SCOPE -F '#{window_name}' 2>/dev/null | grep -m1 "${LEAD_NAME}\$")
fi
if [ -z "$LEAD_WIN" ] && [ -n "$TEAM" ]; then
  LEGACY="__${TEAM}__team-lead"
  tmux list-windows $TMUX_SCOPE -F '#{window_name}' 2>/dev/null | grep -q "^${LEGACY}$" && LEAD_WIN="$LEGACY"
fi

if [ -z "$TEAM" ]; then
  MODE="no-team"
elif [ -n "$LEAD_WIN" ]; then
  if [ "$MY_WINDOW" = "$LEAD_WIN" ]; then
    MODE="lead-window"
  else
    MODE="driver"
  fi
else
  MODE="solo"
fi
```

The mode matters because `/atmux:team start` (Step 3) kills all team-member windows (resolved via emoji-prefix from team.json, plus legacy `__{team}__*`) — running it against a live team would wipe hours of work.

**`MODE=driver`** (most common under Driver Mode):
- **DO NOT run `/atmux:team start`** — it would kill the alive team.
- Read `handoff.md` (Step 1) for background.
- Glance at `TaskList` (Step 2).
- Skip Step 3 (no team-start).
- Step 4 dispatching: optional. The lead self-drives via `/atmux:whip`.
- Role: user-interface session. Relay to team-lead via `SendMessage`. Don't run `/atmux:whip`.
- Watchdog runs from cron (`*/10 * * * * ... watchdog.sh <team>`); no Claude-side loop to arm.

**`MODE=lead-window`** (rare — `/atmux:session cont` invoked from inside the team-lead window itself, e.g. post-rotation recovery):
- **DO NOT run `/atmux:team start`** — you'd kill your own teammates.
- Instead, pivot to `/atmux:team bootstrap` — this is a fresh lead context, not a session resume. Reads handoff + memory + panes and starts `/atmux:whip`.
- Exit here with a note telling the user to run `/atmux:team bootstrap` from inside the lead window.

**`MODE=solo`** (no team-lead window, but a `.claude/atmux:team.json` team is defined):
- Continue to Step 1 normally. User's session is the lead; `/atmux:team start` spawns the teammates.

**`MODE=no-team`** (no `.claude/atmux:team.json` at all):
- Bail gracefully. Report `"no team found at .claude/atmux:team.json — not a team project"`. User may want `/init` or `/atmux:team start --team <name>`.

### Step 1 — Read handoff.md

Check these locations in order:

1. `~/.claude/projects/<project-slug>/todo/<branch>/handoff.md` — canonical.
2. `{cwd}/HANDOFF.md` — dual-harness fallback.
3. `{cwd}/CONT.md` — OpenCode-specific resume guide (sometimes accompanies HANDOFF.md).

Prefer the project-slug copy if multiple exist (Claude-side canonical).

If none exist, fall back to reading `todo/<branch>/` for checklists / notes. Ask user whether to proceed without a handoff.

Pay attention to:
- "In-flight at moment of /preclear" — who was doing what
- "Open questions / decisions needed" — unresolved user-facing calls
- "Next-session first actions" — your starting dispatch list
- "Standing decisions" — DO NOT relitigate

### Step 2 — Check task list

- **Claude path:** `TaskList` tool.
- **Orch path:** `orch_tasks list`.

Cross-reference against handoff's "in-flight" section to spot drift (task `in_progress` but teammate owning it has nothing to do per handoff).

### Step 3 — Start the team (if needed)

Invoke `/atmux:team start`. Only when handoff H1 has `[FULL-STOP]` OR no team-lead window exists. Under `MODE=driver`/`MODE=lead-window`, skip this entirely.

Wait until all members are running:
- **Claude:** `tmux list-panes -a ... | grep __{team}__` shows `claude` in every row.
- **Orch:** `orch_status` shows every member as `idle` or `working`.

### Step 4 — Dispatch resume tasks

Per teammate, send a resume message:
- **Claude:** `SendMessage`.
- **Orch:** `orch_message --to {member}` (or `orch_broadcast` if identical for every teammate).

Each message should:
1. Acknowledge the `/clear` + cont context (teammate has no conversation history).
2. State their in-flight status from handoff.md.
3. State their concrete first action.
4. Cite the "Standing decisions" that apply to them.

Keep it focused — one teammate, one clear first action.

Example:
```
Welcome back. We /clear'd and restarted. Per handoff.md you were holding on X because Y.
First action: do Z and report back.
Standing decisions that apply: [list].
```

### Step 5 — Dispatch pending decisions to the user

If handoff had open questions / user-decision items still unresolved, surface them in YOUR reply (not via SendMessage to teammates).

### Step 6 — Stand by for replies

After dispatching, wait for teammates to report first-action status.

### Cont notes

- Counterpart to `preclear` and `stop`. If there's no handoff, most likely neither was run.
- `/atmux:team start` only when the previous session ended with `stop` (handoff H1 will show `[FULL-STOP]`). After plain `preclear`, teammates are alive.
- Do NOT re-dispatch completed work. Check `TaskList` status first.
- Resume messages should be tight — one teammate should NOT get a 2000-word briefing. Extract the relevant slice.

---

## Verb — `preclear`

`preclear` prepares **the session it's invoked from** for a `/clear`. Never stops the team. Never disturbs other sessions.

### What "the current session" means

| Mode | Current session | `preclear` does |
|---|---|---|
| **driver** (dedicated lead window alive; invoked from driver's REPL) | the driver | Sanity check + exit. Driver has no coordination state — lead owns handoff, memory, tasks, dispatches, team-log. `/clear` the driver is free. |
| **solo** (no dedicated lead window; user's REPL is both user and lead) | the lead-in-disguise | Save everything — handoff + memory + task cleanup. `/clear` wipes lead context, so it must land on disk first. |
| **lead** (invoked from inside the dedicated `__{team}__team-lead` window) | the lead | Save everything — same as solo. |

**Lead vs `/atmux:team rotate-lead`:** `preclear` from the lead is the state-save **primitive**. `/atmux:team rotate-lead` is the composite that does `preclear`'s state-save PLUS `/clear` PLUS auto-pasting a re-bootstrap brief back into the lead pane. Use `/atmux:team rotate-lead` for the normal rotation loop; use `preclear` from the lead when you want state on disk without the auto-reboot.

In all modes the team stays alive. `preclear` does not kill teammates, ever. For actual shutdown, use `/atmux:session stop`.

### Step 1 — Sanity check + mode detection

```bash
TEAM="$(jq -r .name .claude/atmux:team.json 2>/dev/null || echo '')"
if [ -z "$TEAM" ]; then
  echo "ERROR: no .claude/atmux:team.json team name resolvable — aborting preclear"
  exit 1
fi

# 1. Lead marker sanity (informational)
MARK=~/.claude/teams/${TEAM}/lead-session-start.txt
if [ -f "$MARK" ]; then
  VALUE=$(cat "$MARK")
  NOW=$(date +%s)
  UPTIME_MIN=$(( (NOW - VALUE) / 60 ))
  MARK_TS="$(TZ='${COORDINATION_TZ:-${user_config.COORDINATION_TZ}}' date -d @$VALUE +'%H:%M ${COORDINATION_TZ_SUFFIX:-${user_config.COORDINATION_TZ_SUFFIX}}')"
  echo "1. lead marker: ${VALUE} (${MARK_TS}), uptime ${UPTIME_MIN}min"
else
  echo "1. lead marker: (missing — expected if no lead is running yet)"
fi

# 2. Tmux windows (informational)
echo "2. tmux windows:"
tmux list-windows -F '#{window_index} #{window_name}' | head -10

# 3. Mode detection. Lead window resolution cascade — see cont Step 0 for full
# explanation: emoji-prefix → member-name-suffix → legacy __${TEAM}__team-lead.
MY_WINDOW="$(tmux display-message -p '#{window_name}' 2>/dev/null || echo '')"
# Scope tmux searches to the calling session — see cont Step 0 for rationale
# (cross-team member-name collision defense).
TMUX_SCOPE="-a"
if [ -n "${TMUX:-}" ]; then
  MY_SESSION=$(tmux display-message -p '#{session_name}' 2>/dev/null)
  [ -n "$MY_SESSION" ] && TMUX_SCOPE="-t $MY_SESSION"
fi
LEAD_EMOJI="$(jq -r '.members[] | select(.role == "team-lead" or .agentType == "team-lead" or .name == "team-lead") | .emoji // empty' .claude/atmux:team.json 2>/dev/null | head -1)"
LEAD_NAME="$(jq -r '.members[] | select(.role == "team-lead" or .agentType == "team-lead" or .name == "team-lead") | .name' .claude/atmux:team.json 2>/dev/null | head -1)"
LEAD_WIN=""
if [ -n "$LEAD_EMOJI" ] && [ "$LEAD_EMOJI" != "null" ]; then
  LEAD_WIN=$(tmux list-windows $TMUX_SCOPE -F '#{window_name}' 2>/dev/null | grep -m1 "^${LEAD_EMOJI}")
fi
if [ -z "$LEAD_WIN" ] && [ -n "$LEAD_NAME" ]; then
  LEAD_WIN=$(tmux list-windows $TMUX_SCOPE -F '#{window_name}' 2>/dev/null | grep -m1 "${LEAD_NAME}\$")
fi
if [ -z "$LEAD_WIN" ]; then
  LEGACY="__${TEAM}__team-lead"
  tmux list-windows $TMUX_SCOPE -F '#{window_name}' 2>/dev/null | grep -q "^${LEGACY}$" && LEAD_WIN="$LEGACY"
fi
if [ -n "$LEAD_WIN" ]; then
  if [ "$MY_WINDOW" = "$LEAD_WIN" ]; then MODE="lead"; else MODE="driver"; fi
else
  MODE="solo"
fi
echo "3. MODE=${MODE}"

# 4. Live teammate processes (informational)
echo "4. live processes:"
pgrep -laf "agent-id .*@${TEAM}" | awk '{print "   "$NF, "✅"}' || echo "   ❌ none"
```

### Step 2 — Branch by mode

#### `MODE=driver` — sanity check + exit

Driver has no coordination state: no handoff, no memory-to-save, no tasks (TaskList is lead-scoped), no team-log ownership. `/clear` on the driver is a plain context flush.

```
✅ /atmux:session preclear (driver) — ready for /clear

Pre-flight:
  1. lead marker: <value> (<${COORDINATION_TZ_SUFFIX:-${user_config.COORDINATION_TZ_SUFFIX}} time>), uptime <N>min
  2. tmux windows: all present
  3. MODE: driver
  4. live processes: all <N> ✅

No state to preserve — lead owns handoff, memory, tasks, team-log, dispatches.
/clear the driver freely. /atmux:session cont on the next driver session detects
Driver Mode and skips /atmux:team start.
```

Done. No file writes. Exit.

#### `MODE=solo` OR `MODE=lead` — save everything

Invoking session holds coordination state. `/clear` will wipe it. `preclear` lands it on disk first.

**Step 2.1 — Write handoff.md**

Primary path: `~/.claude/projects/<project-slug>/todo/<branch>/handoff.md`.

Also write `{cwd}/HANDOFF.md` (gitignored) when the project is dual-harness.

Structure — briefing for your future self post-`/clear` with zero prior context:

```markdown
# Session handoff — YYYY-MM-DD HH:MM (timezone)

## What shipped this session
- Committed chains, task numbers, landed artifacts. Include SHAs.

## In-flight at moment of /preclear
- For each teammate: what they were doing, what's committed, what's uncommitted, what they're waiting on.
- Surface holds, STOPs, or crisis states.
- Pending decisions needing user's call.

## Open questions / decisions needed
- Numbered; things the user must decide before work can resume.

## Next-session first actions
- Numbered; first 3-5 things `/atmux:session cont` should dispatch.

## Standing decisions (do not revisit)
- Locked-in architectural or process calls.
```

**DO NOT put:** anything in `git log --oneline -20`, TaskList duplication, chain-of-thought narration.

**DO put:** non-obvious context that disappears with `/clear`, cross-teammate dependencies, race conditions.

**Step 2.2 — Sync tasks + memory**

1. Task audit — update `in_progress` task descriptions to be self-contained.
2. Delete `completed` tasks only. NEVER delete `in_progress` / `pending`.
3. Memory save — any new feedback / project state / reference → save to memory file + update `MEMORY.md` index.
4. TODO files cleanup — strip `- [x]` lines, delete emptied files.

**Step 2.3 — Report**

```
✅ /atmux:session preclear (${MODE}) — ready for /clear

Handoff: <path> (<size>)
Memory updates: <summary or "none">
Task list: <in_progress> in_progress, <pending> pending, completed cleared

Team untouched — teammates remain alive across /clear.
Next session: run /atmux:session cont to resume (or /atmux:team bootstrap if you're the lead
and about to re-bootstrap manually).
```

### Preclear notes

- Never runs `/clear` itself — user does that after `preclear` reports ready.
- Do NOT commit/push during `preclear`. Handoff + memory live outside the git tree.
- **End-of-day full shutdown?** Use `/atmux:session stop` — destructive path.
- **Lead context heavy, want to reboot?** Use `/atmux:team rotate-lead` from the lead — `preclear` + `/clear` + auto-re-bootstrap in one shot. Under Driver Mode the lead self-rotates at ≥60min via `/atmux:whip §0.3`.
- **Lead wants state on disk without auto-reboot?** Use `preclear` from the lead window; then manually `/clear` when ready.

---

## Verb — `handoff`

Write a forward-going brief for a fresh claude spawned in a new worktree / branch / tmux session.

**Distinct from `preclear`** — `preclear` writes a session-continuity handoff for `cont` to restart the SAME session on the SAME branch. `handoff` is **forward-going** — a brief for someone about to do something new.

### Step 1 — Gather the brief

Ask the user (or read the conversation) to produce:
- **Goal** (one sentence — what the fresh claude should achieve)
- **Why** (context / motivation — don't leave them hunting)
- **Starting state** (worktree path, branch, last-known SHAs of relevant submodules, anything already initialized)
- **Scope** (in bounds + out of bounds — don't pre-specify the solution)
- **Success criteria** (how they'll know they're done, specific + testable)
- **Constraints** (the "don't break X" list — standing decisions, fragile neighbours)
- **Decisions the user still owes** (things the fresh claude should ASK before designing — list explicitly)
- **Where to start looking** (files to read first, ADRs, memory refs)
- **What to avoid** (common traps — e.g. "don't push without reviewer", "don't touch demo-path branch")
- **What to report back** (format of their first message to the user)

Not every field applies. A small spike may skip "decisions needed" if scope is clear.

### Step 2 — Determine destination

- **Project slug:** target worktree's root. If it's a worktree of a parent repo, use the PARENT repo's path (e.g. for `/home/user/projects/parent-repo/.claude/worktrees/feature-branch`, slug = `-home-user-projects-parent-repo`, not the full worktree path). If standalone clone, use its path.
- **Branch:** the branch the fresh claude will check out / is already on.

Confirm with user if slug or branch is ambiguous.

### Step 3 — Write the handoff

```bash
mkdir -p ~/.claude/projects/<slug>/todo/<branch>
```

Write to `~/.claude/projects/<slug>/todo/<branch>/handoff.md`.

Open with: `"You are a fresh solo claude. No team, no prior-session context. Read this top-to-bottom, then begin."` — so the fresh claude orients immediately.

If inheriting pending items from another session, also write `tasks-from-<source>.md` in the same directory. Reference from `handoff.md`.

### Step 4 — Spawn the fresh claude (optional)

If the user wants kickoff automatic:

```bash
tmux new-session -d -s "<session-name>" -c "<worktree-path>"
sleep 1
tmux send-keys -t "<session-name>:1" "claude" C-m
sleep 8
tmux send-keys -t "<session-name>:1" "read ~/.claude/projects/<slug>/todo/<branch>/handoff.md and begin" C-m
```

If manual kickoff preferred, just report where the file is.

### Step 5 — Instruct self-destruct

Kickoff prompt should include "delete this handoff.md after you've absorbed it" — or at minimum "you can delete it once you're oriented". The file is ephemeral; it's a brief, not a living document.

If the spike produces a more enduring artifact (design doc, ADR), that lives in the project's real `docs/` tree, not here.

### Handoff cleanup

Handoffs accumulate if fresh claudes don't delete them. Periodically audit:

```bash
find ~/.claude/projects -name 'handoff.md' -mtime +7 -printf '%T@ %p\n' | sort -n
```

Anything older than 7 days is probably stale — spike completed (delete) or stalled (resume or drop). Same rule for `tasks-from-*.md` inheritance files.

`preclear` handoffs in the same tree self-overwrite (one per branch), so they don't need special cleanup — but the `find` above covers them if genuinely stale.

### Handoff notes

- **Why global path, not in-repo `.claude/HANDOFF.md`?** Three problems: (1) easy to `git add .` accidentally, (2) needs per-repo gitignore, (3) orphans on `git worktree prune`. Global has none. Zero ergonomic cost — fresh claude can `cat ~/.claude/projects/.../handoff.md` just as easily.
- **What NOT to use `handoff` for:**
  - Session-continuity after `/clear` → that's `preclear` + `cont`.
  - Long-term docs (ADRs, design docs, READMEs) → live in the repo's `docs/` tree.
  - Task lists for the current session → use `TaskCreate` / `TaskUpdate`.

---

## Verb — `stop`

Destructive counterpart to `preclear`. Kills the alive team cleanly and writes a final handoff for the next session. Dual-harness.

**When to use:** actual end-of-day, you're done working, want everything clean for tomorrow.

**When NOT to use:**
- Intra-session context reset on the driver → just `/clear` the driver.
- Lead context reset → use `/atmux:team rotate-lead` (keeps teammates alive).
- Checkpointing state without killing → use `/atmux:session preclear`.

### Step 0 — Pre-flight sanity

```bash
TEAM="$(jq -r .name .claude/atmux:team.json 2>/dev/null || echo "")"
if [ -z "$TEAM" ]; then echo "ERROR: no .claude/atmux:team.json — aborting"; exit 1; fi

MY_WINDOW="$(tmux display-message -p '#{window_name}' 2>/dev/null || echo '')"
# Lead window resolution cascade — see cont Step 0 for full explanation:
# emoji-prefix → member-name-suffix → legacy __${TEAM}__team-lead.
# Scope tmux searches to the calling session — see cont Step 0 for rationale
# (cross-team member-name collision defense).
TMUX_SCOPE="-a"
if [ -n "${TMUX:-}" ]; then
  MY_SESSION=$(tmux display-message -p '#{session_name}' 2>/dev/null)
  [ -n "$MY_SESSION" ] && TMUX_SCOPE="-t $MY_SESSION"
fi
LEAD_EMOJI="$(jq -r '.members[] | select(.role == "team-lead" or .agentType == "team-lead" or .name == "team-lead") | .emoji // empty' .claude/atmux:team.json 2>/dev/null | head -1)"
LEAD_NAME="$(jq -r '.members[] | select(.role == "team-lead" or .agentType == "team-lead" or .name == "team-lead") | .name' .claude/atmux:team.json 2>/dev/null | head -1)"
LEAD_WIN=""
if [ -n "$LEAD_EMOJI" ] && [ "$LEAD_EMOJI" != "null" ]; then
  LEAD_WIN=$(tmux list-windows $TMUX_SCOPE -F '#{window_name}' 2>/dev/null | grep -m1 "^${LEAD_EMOJI}")
fi
if [ -z "$LEAD_WIN" ] && [ -n "$LEAD_NAME" ]; then
  LEAD_WIN=$(tmux list-windows $TMUX_SCOPE -F '#{window_name}' 2>/dev/null | grep -m1 "${LEAD_NAME}\$")
fi
if [ -z "$LEAD_WIN" ]; then
  LEGACY="__${TEAM}__team-lead"
  tmux list-windows $TMUX_SCOPE -F '#{window_name}' 2>/dev/null | grep -q "^${LEGACY}$" && LEAD_WIN="$LEGACY"
fi
if [ -n "$LEAD_WIN" ]; then
  if [ "$MY_WINDOW" = "$LEAD_WIN" ]; then MODE="lead"; else MODE="driver"; fi
else
  MODE="solo"
fi

echo "TEAM=${TEAM}, MODE=${MODE}"
echo "Spawned processes:"
pgrep -laf "agent-id .*@${TEAM}" || echo "  (none — team may already be stopped)"
```

**Confirm with user:** `"This will kill the live team for ${TEAM}. Continue? (end-of-day shutdown; use /atmux:session preclear for non-destructive checkpoint.)"`

Skip confirmation if user invoked with `force`, or if context makes intent explicit (e.g., "let's wrap for the day").

### Step 1 — Safe team stop

Invoke `/atmux:team stop`. Do NOT bypass safety:
- Sends `shutdown_request` to each member with unique request_ids.
- Waits up to 90s for `shutdown_response` replies.
- Members with in-flight work may respond `approve: false` — hold-outs.

**If hold-outs surface**, pause and ask user:
- (a) Wait — SendMessage "finish task then approve:true", retry.
- (b) Finish their task manually via lead.
- (c) Force-kill — user must explicitly say "force kill", or invoked `/atmux:session stop` with `force`.

Do NOT proceed to Step 2 until all members stopped cleanly or explicitly force-killed.

### Step 2 — Kill zombie remnants (`/atmux:team cleanup`)

After `/atmux:team stop` completes, **always** invoke `/atmux:team cleanup`. `/atmux:team stop` kills live agents gracefully but often leaves:
- Dead tmux panes (agent processes died → bare zsh shells)
- Dead tmux windows (`__`-prefixed windows running zsh)
- Orphaned claude `--agent-*` processes
- Stale inbox files

Mandatory even if `/atmux:team stop` reported all-clear — orphans from earlier sessions accumulate.

### Step 3 — Write final handoff.md

Primary: `~/.claude/projects/<project-slug>/todo/<branch>/handoff.md`.
Dual-harness: also write `{cwd}/HANDOFF.md` (detect by `.opencode/` OR `CONT.md`).

Mark as `[FULL-STOP]` in H1 so tomorrow's `cont` knows to re-start the team:

```markdown
# Session handoff — YYYY-MM-DD HH:MM (tz) [FULL-STOP]

> **/atmux:session cont required to re-start the team — teammates were shut down cleanly at end of day.**

## What shipped this session
- Bullet list of committed chains, task numbers, SHAs.

## State at full-stop
- Per teammate: last action committed, anything left uncommitted (should be nothing — safe team-stop drains this), who was blocking/blocked by whom.

## Open questions / decisions needed
- Numbered; things the user must decide before work can resume.

## Next-session first actions
- Numbered list of the first 3-5 things `/atmux:session cont` should dispatch.

## Standing decisions (do not revisit)
- Locked-in architectural or process calls from this session.
```

### Step 4 — Sync tasks + memory

Same as `preclear`:
1. Task list audit — update `in_progress` descriptions to be self-contained.
2. Delete `completed` tasks. Keep `in_progress` + `pending`.
3. Memory check — save new feedback / project / references. Update `MEMORY.md`.
4. TODO files cleanup — strip `- [x]` lines, delete emptied files.

### Step 5 — Reset markers

```bash
# Clear lead-uptime marker — next session starts from zero
rm -f ~/.claude/teams/${TEAM}/lead-session-start.txt
# Clear last-discord-flush marker — next lead seeds cleanly
rm -f ~/.claude/teams/${TEAM}/last-discord-flush.txt
```

Do NOT clear teammate inboxes — those are empty after successful shutdown. If not, `/atmux:team cleanup` would have surfaced it.

### Step 6 — Report ready

```
✅ /atmux:session stop — team stopped, ready for /clear

Shutdown: <N> teammates + lead stopped cleanly (or: <M> force-killed)
Zombies cleaned: <count> dead windows/panes/processes removed
Handoff: <path> (<size>), marked [FULL-STOP]
Memory updates: <summary or "none">
Task list: <in_progress count> in_progress, <pending count> pending

Team is down. /clear when ready; /atmux:session cont tomorrow will re-start via /atmux:team start.
```

### Stop notes

- Do NOT commit/push during `/atmux:session stop` unless user explicitly asks. Handoff + memory files live outside git.
- **`cont` behavior after `stop`:** `cont` sees no live team-lead window (Driver Mode) or no live teammates (Solo Mode) and runs `/atmux:team start`. `[FULL-STOP]` marker in handoff H1 makes this unambiguous.
- **Partial failures:** if Step 1 leaves hold-outs and user declines wait/force, ABORT `/atmux:session stop` — do NOT write handoff, do NOT cleanup. Team is still alive; user can retry later.
- **Solo Mode caveat:** under Solo Mode the current REPL IS the lead. `/atmux:session stop` from Solo Mode stops only the teammates — the REPL itself is left for the user to `/clear`. The REPL's conversation context is the only "lead state" and is preserved until `/clear`.

---

## Global notes

- All verbs write handoff files to the same canonical path (`~/.claude/projects/<slug>/todo/<branch>/handoff.md`). `cont` reads from this same path.
- Verbs never run `/clear` themselves — user does that. (Exception: `/atmux:team rotate-lead` composite does include `/clear` + re-bootstrap, but that's the team skill, not this one.)
- Dual-harness visibility: always write `{cwd}/HANDOFF.md` alongside the global copy when project has `.opencode/` or `CONT.md`.
- **Watchdog arming:** none of these verbs arm any Claude-side `/loop`. `whip-watchdog` runs from cron (`*/10 * * * *`). If the cron entry is missing, add it via `crontab -e` per `whip/SKILL.md` §Watchdog. Manual one-shot check: `/atmux:whip watchdog [team]`.

## Operator-facing report format — attention + verdict markers

Every session verb ends with a one-block summary the operator reads to decide what to do next (`/clear` now? wait? retry?). All four verbs use the same attention+verdict scheme as whip §8.0, medic §9.5, bau header, and bruh §7 (per `[[feedback-unambiguous-attention-and-verdict]]`).

**Marker glossary:**
- **Top-line emoji** — verdict for the whole verb run: ✅ (clean / ready) · ⚠ (partial / watch one cycle) · 🔴 (failed / blocking)
- **👁** prefix on any follow-up line — operator-action-required in this turn (must read, don't skim)
- **ℹ** — neutral observation (no judgment)

**Per-verb verdict-derivation rules:**

- **`cont`** — ✅ when team-start succeeded (if needed), all in-flight tasks have a teammate assigned, and no pending decisions need operator. ⚠ when team alive but some resume dispatches couldn't fire (member pane wedged, inbox locked). 🔴 when team-start itself failed or handoff.md is missing/corrupt.
- **`preclear`** — ✅ when handoff written, memory landed, task list cleaned, ready-for-/clear. ⚠ when partial (memory wrote but task cleanup hit a lock, etc.) — operator can still `/clear` but should know what didn't land. 🔴 when handoff couldn't be written (path missing, disk full, lock contention).
- **`handoff`** — ✅ when brief written + (optionally) fresh claude spawned + kickoff fired. ⚠ when brief written but spawn skipped/failed — operator must manually kickoff. 🔴 when brief itself couldn't be written.
- **`stop`** — ✅ when ALL teammates stopped cleanly, zombies reaped, handoff marked `[FULL-STOP]`. ⚠ when some force-killed (count them out). 🔴 when stop aborted (hold-outs declined, partial state — team still alive).

**Examples (drop-in for existing verb summaries):**

```
✅ /atmux:session preclear (lead) — ready for /clear
Handoff: ~/.claude/projects/foo/todo/bar/handoff.md (4.2k)
Memory updates: 2 (feedback_X.md, project_Y.md)
Task list: 3 in_progress, 5 pending, completed cleared
```

```
⚠ /atmux:session stop — team stopped with 2 force-kills
Shutdown: 6 teammates + lead stopped (4 clean, 2 force-killed: planner, reviewer)
Zombies cleaned: 1 dead pane removed
Handoff: <path> (12k), marked [FULL-STOP]
👁 Memory updates: 1 (force-kill pattern saved — review on cont)
Task list: 1 in_progress, 4 pending
```

```
👁 🔴 /atmux:session cont — team-start failed
Failure: /atmux:team start exited 1 (atmux start: tmuxTmpdir already in use by another session)
👁 Operator: kill orphan socket at /tmp/atmux-<team>/sock then re-run /atmux:session cont
Handoff: <path> (5.1k) — preserved, not deleted
```

**Anti-patterns to avoid:**
- ❌ Top-line `✅` while a `👁` line in the body warns operator must do something. The worst-state marker wins — if 👁 is present, downgrade to ⚠ or 🔴.
- ❌ Reporting `✅ ready for /clear` after a partial state-save without naming what's missing.
- ❌ Burying a `Partial failure` mention 6 lines deep in narrative. Operator must see it in the first line.
