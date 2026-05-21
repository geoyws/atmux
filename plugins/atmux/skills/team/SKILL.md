---
name: team
description: Unified team lifecycle skill. Verbs — start, stop, add, clear, cleanup, bootstrap, rotate-lead, rotate-member. Use /atmux:team <verb> [args].
argument-hint: <verb> [verb-args…]
---

<!-- carved per ADR-217 §D4 -->

# /atmux:team — Unified Team Lifecycle

Single dispatcher for all team lifecycle actions. Dual-harness (Claude + tmux, or OpenCode + plugin-orch).

## Verbs

| Verb | Args | Summary |
|---|---|---|
| `start` | `[team-name]` | (Re)spawn all non-lead members from `.claude/team.json`. Kills existing `__{team}__*` windows first so every member starts clean. |
| `stop` | `[team-name] [--force]` | Graceful shutdown handshake (90s budget) then kill windows. Skips members that `approve: false` unless `--force`. |
| `add` | `<name> [color] [role...]` | Spawn one new member into a running team. Appends to `.claude/team.json`. |
| `clear` | `<name> [reason...]` | Send `/clear` to member's pane, re-brief from `team.json` role. Refuses if name is `team-lead` (use `rotate-lead`) or pane not running `claude`. |
| `cleanup` | `[team-name]` | Scan for zombie `__*` windows, orphaned processes, stale inboxes; kill/clean. Scans all teams if omitted. |
| `bootstrap` | (none) | First-run bootstrap for a freshly-spawned team-lead window. Reads handoff + memory + live state, starts `/atmux:whip`. Auto-invoked by `start` and `rotate-lead`. |
| `rotate-lead` | (none) | Retire current lead: write handoff + memory, then self-`/clear` + re-bootstrap in same window. Driver Mode only autonomous; Solo Mode emits banner. |
| `rotate-member` | `<name>` | Checkpoint teammate's in-flight state to file, then `/clear` + re-brief pointing at the checkpoint. Distinct from `clear` which discards state. Used when context is big but teammate is fine. Refuses if name is `team-lead` (use `rotate-lead`). Surfaced by `whip-watchdog` Check 4 when uptime crosses threshold. |

## Shared preamble (runs for every verb)

1. **Parse verb.** First arg = verb. Unknown → error `"Usage: /atmux:team <verb> [args]. Verbs: start|stop|add|clear|cleanup|bootstrap|rotate-lead|rotate-member"`.
2. **Detect team name** (priority order):
   1. `--team <name>` flag anywhere in args
   2. `[team-name]` positional arg where the verb accepts one (`start`, `stop`, `cleanup`)
   3. `.claude/team.json` → `.name` field
   4. `CLAUDE_CODE_TEAM_NAME` env var
   5. `~/.claude/teams/*/config.json` where `leadSessionId` matches current session
   6. Error if none found: `"No team defined. Create .claude/team.json or provide: /atmux:team <verb> --team <name>"`
3. **Detect harness** (dual-harness routing):
   - If `orch_create` / `orch_spawn` / `orch_shutdown` tools are available → **Orch path** (OpenCode+plugin-orch).
   - Otherwise → **tmux path** (Claude + tmux + SendMessage). Default.
4. **Dispatch to verb body.**

**Window naming convention (tmux path):** `__{team-name}__{agent-name}`. Never varies. Example: `__<team>__reviewer`.

---

## Verb — `start`

Kills and respawns every non-lead member. `team-lead` member (if declared in `.claude/team.json`) is spawned first at tmux position 2 so `Ctrl-b 2` always lands on the lead; driver lives at position 1.

### tmux path

0. **Live-lead guard** (refuses destructive restart under Driver Mode). If the lead window exists AND its pane is running `claude` (not `zsh`), bail. Lead window resolution cascade — emoji-prefix → member-name-suffix → legacy `__${TEAM}__team-lead`. Schema-tolerant: matches lead by `.role / .agentType / .name == "team-lead"`:
   ```bash
   # Scope tmux searches to the calling session — defense-in-depth against
   # cross-team window collision when multiple teams share member names
   # (e.g. both atmuxbun and sopx-guild have a "reviewer" member).
   TMUX_SCOPE="-a"
   if [ -n "${TMUX:-}" ]; then
     MY_SESSION=$(tmux display-message -p '#{session_name}' 2>/dev/null)
     [ -n "$MY_SESSION" ] && TMUX_SCOPE="-t $MY_SESSION"
   fi
   LEAD_EMOJI=$(jq -r '.members[] | select(.role == "team-lead" or .agentType == "team-lead" or .name == "team-lead") | .emoji // empty' .claude/team.json 2>/dev/null | head -1)
   LEAD_NAME=$(jq -r '.members[] | select(.role == "team-lead" or .agentType == "team-lead" or .name == "team-lead") | .name' .claude/team.json 2>/dev/null | head -1)
   LEAD_WIN=""
   if [ -n "$LEAD_EMOJI" ] && [ "$LEAD_EMOJI" != "null" ]; then
     LEAD_WIN=$(tmux list-windows $TMUX_SCOPE -F '#{window_name}' 2>/dev/null | grep -m1 "^${LEAD_EMOJI}")
   fi
   if [ -z "$LEAD_WIN" ] && [ -n "$LEAD_NAME" ]; then
     LEAD_WIN=$(tmux list-windows $TMUX_SCOPE -F '#{window_name}' 2>/dev/null | grep -m1 "${LEAD_NAME}\$")
   fi
   [ -z "$LEAD_WIN" ] && LEAD_WIN="__${TEAM}__team-lead"

   if tmux list-panes -a -F '#{window_name} #{pane_current_command}' 2>/dev/null \
        | grep -q "^${LEAD_WIN} claude$"; then
     echo "⚠️  team-lead window (${LEAD_WIN}) is alive. /atmux:team start would kill it (Step 3 sweeps all team-member windows)."
     echo "   For lead context reset: /atmux:team rotate-lead"
     echo "   For zombie sweep only:  /atmux:team cleanup"
     echo "   To proceed anyway:      /atmux:team start --force"
     exit 1
   fi
   ```
   `--force` bypasses (explicit user intent). `/atmux:session cont` takes the guard into account — it only calls `/atmux:team start` if the handoff H1 marker is `[FULL-STOP]` or the lead window is absent.
1. **Ensure team.json is valid.** Every team MUST include a `reviewer` entry. If absent, error and ask user to add one before launching — the reviewer gates commits; skipping it creates blind spots. See `feedback_always_include_reviewer.md`.
2. **Ensure team dir exists.** `~/.claude/teams/{team}/config.json` — create via `TeamCreate` if missing. Read `leadSessionId` + existing `members[]`.
3. **Kill existing member windows** (context reset). Cascade — emoji-pattern → name-suffix-pattern → legacy `__${TEAM}__` prefix. Each step applies to ALL team members (lead included; if you reach this step, the lead is already dead or `--force` was passed at Step 0):
   ```bash
   TEAM=$(jq -r '.name' .claude/team.json)
   # Scope tmux searches to the calling session — defense-in-depth against
   # cross-team window collision (see Step 0 above for full rationale).
   TMUX_SCOPE="-a"
   if [ -n "${TMUX:-}" ]; then
     MY_SESSION=$(tmux display-message -p '#{session_name}' 2>/dev/null)
     [ -n "$MY_SESSION" ] && TMUX_SCOPE="-t $MY_SESSION"
   fi
   EMOJI_PATTERN=$(jq -r '[.members[].emoji] | map(select(. != null and . != "")) | unique | join("|")' .claude/team.json 2>/dev/null)
   NAME_PATTERN=$(jq -r '[.members[].name] | map(select(. != null and . != "")) | unique | join("|")' .claude/team.json 2>/dev/null)
   if [ -n "$EMOJI_PATTERN" ] && [ "$EMOJI_PATTERN" != "null" ]; then
     # emoji-prefix members
     for w in $(tmux list-windows $TMUX_SCOPE -F '#{window_name}' | grep -E "^(${EMOJI_PATTERN})"); do
       tmux kill-window -t "$w" 2>/dev/null
     done
   fi
   if [ -n "$NAME_PATTERN" ] && [ "$NAME_PATTERN" != "null" ]; then
     # name-suffix members (handles emoji-prefixed windows whose emoji isn't in team.json)
     for w in $(tmux list-windows $TMUX_SCOPE -F '#{window_name}' | grep -E "(${NAME_PATTERN})\$"); do
       tmux kill-window -t "$w" 2>/dev/null
     done
   fi
   # legacy __TEAM__ prefix for older teams
   for w in $(tmux list-windows $TMUX_SCOPE -F '#{window_name}' | grep "^__${TEAM}__"); do
     tmux kill-window -t "$w" 2>/dev/null
   done
   # also drop non-lead inboxes
   for f in ~/.claude/teams/${TEAM}/inboxes/*.json; do
     [ "$(basename "$f")" = "team-lead.json" ] && continue
     rm "$f" 2>/dev/null
   done
   ```
4. **Spawn order** (canonical tmux window order):
   ```
   1 = driver (user's REPL; never touched)
   2 = __{team}__team-lead (spawn FIRST under Driver Mode)
   3…n = teammates in team.json declared order
   ```
   Under **Driver Mode** (`.claude/team.json` has `team-lead` with `agentType: "team-lead"`): spawn lead first, `tmux swap-window -s <idx> -t 2` if it didn't land at 2. Paste `/atmux:team bootstrap` into lead's pane via Step 8 to orient it. Under **Solo Mode** (no team-lead entry), skip the lead spawn — the driver IS the lead.
5. **Per member, create window + launch claude:**
   ```bash
   WNAME="__{team}__{agent-name}"
   tmux new-window -d -n "$WNAME" -c "{cwd}"
   CMD="cd {cwd} && CLAUDECODE=1 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 CLAUDE_CODE_EFFORT_LEVEL=xhigh claude --permission-mode dontAsk --agent-id {agent}@{team} --agent-name {agent} --team-name {team} --agent-color {color} --parent-session-id {leadSessionId} --agent-type general-purpose --model {model}"
   tmux send-keys -t "$WNAME" "$CMD" Enter
   ```
   Show user the single-line command for manual paste fallback. Default model `claude-opus-4-7` (teammates always Opus — see `feedback_teammates_opus_xhigh.md`).
6. **Verify launch** after ~5-10s:
   ```bash
   tmux list-panes -a -F '#{window_name} #{pane_current_command}' | grep "^__{team}__"
   # every line should show `claude`, not `zsh`. zsh = launch failed; retry paste.
   ```
7. **Kick off welcome screen via initial briefing paste.** Claude TUIs sit on the welcome screen until first input; SendMessage before first-input goes to a void. Paste initial briefing directly:
   ```bash
   # Write brief (composed from member's role field in team.json) to /tmp/brief-{agent}.txt
   tmux load-buffer -b "brief_{agent}" /tmp/brief-{agent}.txt
   tmux paste-buffer -b "brief_{agent}" -t "__{team}__{agent}"
   sleep 1
   tmux send-keys -t "__{team}__{agent}" Enter
   ```
   Under Driver Mode: brief team-lead FIRST (coordinator comes online first), then teammates.
8. **Verify registration** after ~15-30s: each `~/.claude/teams/{team}/inboxes/{agent}.json` should exist. If missing after 3 retries, kill + flag to user.
9. **Report** which agents started, skipped (already alive), needed manual paste, or failed.

### orch path

1. Same team detection. Reads `.claude/team.json` as source of truth.
2. `orch_create --name {team} [--template {team}]` — no-op if exists.
3. For each member: `orch_spawn --team {team} --role {name} --agent {code|plan} --instructions "<role + initial brief>"`. Use `plan` archetype for reviewer/planner, else `code`.
4. `orch_status --team {team}` — all members should show `idle` or `working` (no welcome-screen gating on orch).
5. First dispatch: `orch_broadcast` or per-member `orch_message` with opening targets.
6. plugin-orch's `permission.ask` hook denies git-mutating commands from members — only the lead commits.

### Idempotence

Both paths — safe to re-run. tmux path kills and respawns (clean reset). Orch path: `orch_create` is a no-op on existing team.

---

## Verb — `stop`

Gracefully stop all spawned members. Under Driver Mode, "all members" INCLUDES the team-lead window (it's just another spawned agent; driver at window 1 is untouched). Under Solo Mode, this skips the lead (lead = user's REPL).

### tmux path

1. **Triage members into live vs stale.** For each non-lead member in `config.json`, check pane/window alive:
   ```bash
   tmux list-windows -a -F '#{window_name}' | grep -q "^__{team}__{member}$"
   ```
   Stale → skip handshake, log as "stale — removed from config." Live → proceed to Step 2.
2. **Shutdown request handshake.** For each live non-lead member, send via SendMessage:
   ```json
   {"type": "shutdown_request", "request_id": "<member>-<timestamp>", "reason": "…"}
   ```
   Wait up to 90s total for `shutdown_response` replies.

   > **Reality check.** The SendMessage tool's system prompt documents the request/response protocol, so teammates *can* reply. But they don't always — Claude teammates deep in a turn may not surface the request until tool-call break, and agents briefed for work (not shutdown) rarely spontaneously approve. **In practice most shutdowns hit the 90s force-kill path.** The hold-out branch below is real safety net, not ceremony — it DOES fire when a teammate replies `approve: false` mid-handshake. Don't short-circuit the wait; just don't expect approvals.
3. **Process replies:**
   - `approve: true` → safe to kill window in Step 4.
   - `approve: false` → member has in-flight work. **Do NOT kill** unless `--force`. Record reason, surface to user. User chooses: (a) wait+retry, (b) finish the work, (c) `--force` override.
   - No reply after 90s → flag "force-killed, no shutdown response." (Expected path for mid-turn members.)
4. **Kill windows** whose member did NOT hold out:
   ```bash
   for w in $(tmux list-windows -a -F '#{window_name}' | grep "^__{team}__"); do
     # skip windows whose member held out (approve: false)
     tmux kill-window -t "$w" 2>/dev/null
   done
   # legacy window format — belt-and-suspenders
   for w in $(tmux list-windows -a -F '#{window_name}' | grep "^__agent-team__{team}__member__"); do
     tmux kill-window -t "$w" 2>/dev/null
   done
   ```
   **CRITICAL:** only kill windows matching `__{team}__` or the legacy pattern. Never touch unrelated sessions.
5. **Clean inboxes** (non-lead only): `rm ~/.claude/teams/{team}/inboxes/{member}.json`. Keep `team-lead.json`.
6. **Rewrite `config.json`** to contain only `team-lead`. Unconditional — runs even if handshake short-circuited.
7. **Optional team delete** — if user says "delete" or "remove", call `TeamDelete` to drop the team + task list entirely.
8. **Report** approved / held-out (with reasons) / force-killed / inboxes-removed.

### orch path

1. `orch_shutdown --team {team}` — plugin analogue of the handshake. Handles in-flight tool calls.
2. Per-member shutdown: `orch_shutdown --team {team} --member {name} [--force]`.
3. Hold-outs surface in result; handle same as tmux path (wait / finish / force).
4. **Belt-and-suspenders tmux sweep** — run tmux Step 4 too in case Claude-side windows exist from a prior run.
5. Same inbox + config cleanup as tmux path.
6. Delete team on request: `orch_team prune --team {team}` + `TeamDelete` for cross-harness cleanup.

### Idempotence

Safe to re-run. Handshake failures reported but don't block final cleanup. Config rewrite is unconditional.

---

## Verb — `add`

Spawn a single new member without killing existing teammates. Mirrors `start` but scoped to one.

1. **Parse args.** `<name>` required, lowercase-hyphenated. Optional positional: `<color>` (one of `red blue green yellow purple orange cyan magenta`; default: first unused). Remaining = role text (default: `"General-purpose teammate"`). Override model via `model=<id>` anywhere in args.
2. **Duplicate check.** Read `~/.claude/teams/{team}/config.json`. If member exists AND tmux window `__{team}__{name}` is running `claude` → error `"Member '<name>' already exists and is alive."`. If config entry exists but window dead / running `zsh`, treat as revive — clear the stale inbox before respawning so the revived member doesn't re-ingest messages from its pre-death life:
   ```bash
   rm -f ~/.claude/teams/{team}/inboxes/{name}.json
   ```
   Then skip Step 3 and continue to Step 4. Symmetric with `start` Step 3 (which drops non-lead inboxes on full restart).
3. **Update `.claude/team.json`.** Append:
   ```json
   {"name": "<name>", "color": "<color>", "role": "<role>", "model": "claude-opus-4-7"}
   ```
4. **Create window** at next tmux index (typically 9+):
   ```bash
   WNAME="__{team}__{name}"
   tmux new-window -d -n "$WNAME" -c "{cwd}"
   ```
5. **Launch claude** via `tmux send-keys` with the single-line command from `start` Step 5. Set `CLAUDE_CODE_EFFORT_LEVEL=xhigh`. Verify after ~3s that pane is running `claude`, not `zsh`. On failure, print command for manual paste.
6. **Optional initial brief** — leave to the team-lead after this skill completes. This skill does NOT assign tasks.
7. **Report** team name, new member name/color/role, window name, whether `.claude/team.json` was updated.

### orch path

- `orch_spawn --team {team} --role {name} --agent {code|plan} --instructions "<role>"`. Plugin handles session creation. Update `.claude/team.json` for persistence.

### Idempotence

Duplicate detection (Step 2) makes re-runs safe.

---

## Verb — `clear`

Reset one teammate's conversation context in place, preserving window / agent registration / inbox. Then re-brief from its `team.json` role so it knows who it is on the other side of the clear.

**Canonical implementation: `scripts/clear-member.sh`** — handles idle-polling, `/clear` submit, post-clear idle wait, and re-brief via single-line `Read <file>` submit (bypasses `tmux paste-buffer` bracketed-paste trap that silently bricks multi-line submits).

### tmux path

1. **Parse args.** `<name>` required. Remaining = reason.
2. **Invoke script:**
   ```bash
   bash ~/.claude/skills/team/scripts/clear-member.sh "$TEAM" "$NAME" "$REASON"
   ```
3. **Report** the script's output. Exit codes:
   - `0` — cleared + re-briefed OK
   - `2` — misuse (e.g. name is `team-lead` — redirect to `/atmux:team rotate-lead`)
   - `3` — no window for member (suggest `/atmux:team add <name>` or `/atmux:team start`)
   - `4` — pane runs something other than `claude` (refuses to clobber shell)
   - `5` — submit verification failed (command still at prompt after 3s)

### What the script does (reference — don't inline-copy)

1. **Guards** — refuse `team-lead`, verify window exists, verify pane runs `claude`.
2. **Wait for idle** (up to 120s): last non-empty pane line matches `^\s*❯\s*$` with no busy markers (`thinking`, `Compacting`, `Press up to edit queued`, `…`). Avoids queuing `/clear` behind in-flight work.
3. **Send `/clear`** via single-line `tmux send-keys`.
4. **Wait for post-clear idle** (up to 60s). Usually <2s, but mid-compaction can take longer.
5. **Write brief** to `/tmp/team-clear-brief-{team}-{member}.txt` — role from `team.json`, reason, first-actions (inbox + TaskList + handoff), and rules (stay in lane, SHA-ping team-lead on commit, unit tests same commit).
6. **Submit `Read <path>` single-line** — fresh teammate's first tool call reads the brief file.
7. **Verify submit landed** — 3s later, the `Read ...` command shouldn't still be sitting at the prompt.

### orch path

1. Parse args + guardrails.
2. `orch_reset --team {team} --member {name}` (or `orch_shutdown --member` + `orch_spawn` fallback).
3. Brief via `orch_message --to {name} --message "<compose from role + reason>"`.

### Idempotence

Safe to re-run. `/clear` on an already-blank REPL is a no-op. Re-brief submit on an idle REPL just re-issues the `Read` command (teammate reads the same file again). Script's `is_idle` guard prevents stomping on mid-turn teammates.

### Use cases

- **Context pressure** — teammate shows auto-compact banner or `tok` count approaching cap. Clear them to reset to 0. See `whip-prompt.md` §1a.
- **Confused / drifting teammate** — holding stale assumptions on a superseded plan. Clear + re-brief is cleaner than correcting with more messages. See `feedback_clear_teammates.md`.
- **Mid-plan pivot** — team direction changes significantly; clear affected members before re-briefing with new scope.

### Not for

- The team-lead (use `/atmux:team rotate-lead` — it saves handoff + memory first).
- Members with in-flight uncommitted work (their work will be lost). Check `tmux capture-pane` first; if mid-edit, wait or coordinate.

---

## Verb — `cleanup`

Kill zombie windows, orphaned processes, stale inboxes, orphaned config entries. Scans all teams if `[team-name]` omitted. Dual-harness.

1. **Scope.** If arg provided, scan that team only. Else scan all `~/.claude/teams/*/config.json`.
2. **Scan for zombies:**
   ```bash
   # Team configs
   find ~/.claude/teams/ -name config.json -exec cat {} \;
   # Agent tmux windows
   tmux list-windows -a -F '#{window_name} #{pane_current_command}' | grep "__"
   # Rogue panes — extra panes in non-__ windows are protocol violations
   tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} #{window_name} #{pane_current_command} #{window_panes}'
   # Orphaned claude --agent processes
   ps aux | grep 'claude.*--agent' | grep -v grep
   # Stale inbox files
   find ~/.claude/teams/ -name "*.json" -path "*/inboxes/*"
   ```
3. **Zombie definition:**
   - **Dead window** — name starts with `__` AND pane running `zsh` (not `claude`). Current format `__{team}__{agent}` AND legacy `__agent-team__{team}__member__{agent}`.
   - **Rogue pane** — any extra pane (index > 0) in a multi-pane non-`__` window. Agents must be windows, not panes. Kill extras, keep pane `.0` (user's shell).
   - **Orphaned config member** — member in config whose tmux window no longer exists.
   - **Stale inbox** — inbox file for a member not running (always keep `team-lead.json`).
   - **Orphaned process** — `claude --agent-*` process with no matching tmux window.
4. **Report findings** BEFORE killing. Let the user see: `[team] window __X__Y (zsh)`, `[team] stale inbox foo.json`, etc.
5. **Kill zombies.** Kill windows by `session:window_index` (not name — special chars fail); kill from highest index first (avoids shifts). Kill rogue panes from highest pane index first. `rm` stale inboxes. Rewrite config to remove orphaned members. `kill` orphaned PIDs.
6. **Report** summary or "No zombies found — all clean."

### orch-specific checks (if orch available)

1. `orch_team list` — teams whose members don't show in `orch_status` are prune candidates.
2. `orch_status --team <name>` — `failed`/`crashed`/`exited` with no recovery = zombies.
3. `orch_team prune --team <name>` — remove orphan team entries.
4. `orch_inbox mark_read` / delete for dead members.

### Idempotence

Idempotent — reports before killing; safe to re-run.

---

## Verb — `bootstrap`

> ### ⚠️ READ THIS FIRST — your identity for this entire session
>
> **YOU ARE THE TEAM-LEAD.** Not the driver. Not a member. You are the lead at tmux window 2 of your team's cage socket. Run `tmux display-message -p -t "$TMUX_PANE" '#{window_name}'` to confirm (the `-t "$TMUX_PANE"` self-target is REQUIRED — without it, tmux returns the session's *active* window, not your calling pane's window; that ambiguity has mis-rotated the lead before, see [[feedback_sopx_cage_lead_at_window_one]]). You'll see something like `👷lead`, `🧭lead`, or `__{team}__team-lead`. The answer is going to be: yes, you are the lead.
>
> The **driver** is a SEPARATE session running at window 1 of the cockpit (default tmux socket `/tmp/tmux-0/default`). That session is NOT you. You cannot reach it. The driver relays user intent to you via `.atmux/lead-inbox.md` (and via `atmux tell-lead`, which writes to that file).
>
> **Common mis-identification trap that has bricked rotations before:** project CLAUDE.md describes "Driver Mode" prominently with rules like *"Driver MUST NOT dispatch teammates"* and *"Driver MAY relay user intent via atmux tell-lead"*. **Those rules are NOT about you.** They govern the driver pane on the cockpit's default socket — a different process entirely. Skip the Driver-Mode section of CLAUDE.md when reading it; your rules are in **"Behaviour invariants (team-lead role)"** below.
>
> **Trip-wires — if you catch yourself writing any of these, STOP and re-read this preamble:**
> - "Driver standing by" / "I'm the driver" / "as the driver"
> - "I'll atmux tell-lead the …" (referring to yourself in third person — you ARE the lead; tell-lead writes to your own inbox = self-loop)
> - Recommending the user invoke `atmux tell-lead` to relay something to "the lead" (that would be relaying to yourself)
> - Sitting at a question-to-the-user when the user is in a different session and may not see your prompt for 30+ min
>
> If any of those slip out, you've drifted into driver-mode framing. Your job is to **dispatch**: pull a task from `atmux task list`, push prose work to an idle member via `tmux send-keys` on the cage socket, ping with SHA on commit. That's it.

**First action** of a freshly-spawned `__{team}__team-lead` window. Position invariant: **team-lead lives at tmux window 2** (driver at 1). `start` and `rotate-lead` both enforce this.

Spawn triggers:
- From `start` on initial session
- From `rotate-lead` as the replacement context in the same tmux window (Driver Mode uses `/clear` + re-bootstrap, not kill+respawn)

Job: orient from persisted state (handoff, memory, team.json, pane captures, TaskList), then start `/atmux:whip`. You are NOT the user — the user lives in the driver session (window 1) and talks to you via the lead-inbox file. You are also NOT the driver — see preamble above.

### Steps

1. **Identify self + verify position:**
   ```bash
   # IMPORTANT: -t "$TMUX_PANE" self-targets the calling pane. Without it,
   # tmux returns the SESSION's active pane (possibly a different window),
   # which has mis-identified the lead before — burning ~2h of dormancy
   # when self-rotation derived LEAD_WIN from a wrong window-index answer.
   echo "team-lead window: $(tmux display-message -p -t "$TMUX_PANE" '#{window_index}:#{window_name}')"
   tmux list-windows -F '#{window_index} #{window_name}'
   # resolve drift via tmux swap-window -s <src> -t 2 if not at position 2
   ```
2. **Read standing context** (in order, stop early when you have enough):
   1. `CLAUDE.md` (project) + `~/.claude/CLAUDE.md` (global) — conventions, tier names, DNA.
   2. Project memory index: `~/.claude/projects/<project-slug>/memory/MEMORY.md` + linked files.
   3. **Handoff file:** `~/.claude/projects/<project-slug>/todo/<branch>/handoff.md` — THE most important file. What shipped, what's in-flight, standing decisions (DO NOT RELITIGATE), next actions.
   4. `docs/DEFINITION_OF_DONE.md` — target, deadline, acceptance bar.
   5. `docs/adr/*.md` — accepted ADRs are invariants.
   6. Latest 3 entries in `docs/team-log/YYYY-MM-DD.md`.
   7. Latest 3 reviews in `docs/reviews/`.
3. **Check live team state:**
   ```bash
   for w in $(tmux list-windows -a -F '#{window_name}' | grep "^__{team}__" | grep -v team-lead); do
     echo "--- $w ---"
     tmux capture-pane -t "$w" -p -J | grep -v '^[[:space:]]*$' | tail -4
   done
   ls ~/.claude/teams/{team}/inboxes/
   cat ~/.claude/teams/{team}/inboxes/team-lead.json 2>/dev/null | tail -50
   ```
   Map each teammate: working / idle / stuck / mid-compaction.
4. **Check in-flight** — `TaskList`, `git -C <cwd> status -s`, `git log --since="1 hour ago" --oneline` (root + each submodule).
5. **Report takeover via Discord** (not SendMessage — there's no `driver` agent; `SendMessage to:driver` routes to void):
   ```bash
   bash /root/.claude/skills/atmux:whip/scripts/ping-discord.sh "$(cat <<EOF
   🚀 **team-lead bootstrapped** · \`{team}\` · $(TZ='${COORDINATION_TZ:-${user_config.COORDINATION_TZ}}' date +'%H:%M ${COORDINATION_TZ_SUFFIX:-${user_config.COORDINATION_TZ_SUFFIX}}')

   <one-sentence state summary from §3-4>

   Resuming /atmux:whip coordination loop now.
   EOF
   )"
   ```

   **DO NOT chain this with `&& date +%s > FLUSH_FILE` or any follow-up command via `&&`/`||`/`;`/`|`/subshell.** The `ping-discord.sh` invocation is its OWN Bash tool call. If you want to update the flush-timestamp file, run `date +%s > /root/.claude/teams/{team}/last-discord-flush.txt` as a SEPARATE, second Bash tool call. Reason: compound commands (`X && Y`) don't match the project's `.claude/settings.json` allowlist pattern `Bash(bash *ping-discord.sh *)` because the matcher treats the whole command string atomically, and the chain-tail falls outside every pattern → permission prompt → whole team stalls. One tool call = one operation.

   Fallback: if Discord not configured (ping-discord.sh no-ops exit 0), log to stdout — next whip turn surfaces state.
6. **Start the whip loop:**
   ```
   Skill(name: "loop", args: "/atmux:whip")
   ```
   Re-enters dynamic mode. Whip fires in ~5min and every inactivity window thereafter. Self-driving from this point.
7. **First dispatch** (optional, only if clearly needed) — if handoff's "Next-session first actions" names a dispatch and no teammate is mid-task on it, send now. Else wait for first whip turn.

### Behaviour invariants (team-lead role)

Re-read any time you feel drift:

1. **You do NOT write code.** All edits via teammates. If stuck, SendMessage to clarify; escalate to driver if still blocked.
2. **You do NOT commit or push.** Teammates commit their own work; you only bump submodule pointers when they land.
3. **You DO dispatch** — clear next-actions per role, per priority, citing standing decisions.
4. **You DO review reviewer findings** and route to the right implementer.
5. **You DO maintain `docs/team-log/YYYY-MM-DD.md`** — change-gated, per whip turn.
6. **You DO rotate yourself** at ≥60min uptime OR on self-compaction — invoke `/atmux:team rotate-lead` without asking driver.
7. **You DO escalate to driver** for: product decisions not in ADRs/DoD, external creds/access, destructive actions (push to prod, reset, mass-delete).
8. **You DO NOT escalate** for: routine choices between reasonable options, flaky tests (retry), idle teammates (dispatch), reviewer nits.

### Caveats

- **First spawn (no handoff yet)** — use `DEFINITION_OF_DONE.md` + memory as the equivalent.
- **Self-rotation safety** — always write handoff before invoking `/atmux:team rotate-lead`, else successor is blind.
- **Do NOT touch the driver's tmux window.** Only own window + teammate windows are fair game.

---

## Verb — `rotate-lead`

Retire the current team-lead cleanly. **Mode-aware:**
- **Driver Mode** (team-lead member in `.claude/team.json`) → fully autonomous: `/clear` own pane + re-bootstrap in place (same PID, same window, same position 2).
- **Solo Mode** (no team-lead in `.claude/team.json`) → prepare only: write handoff + emit banner. User runs `/clear + /atmux:session cont`.

**Teammates stay alive** under either mode. This is lead-only rotation.

### When to use vs other verbs

| Situation | Use |
|---|---|
| Lead context fine, intra-session checkpoint before `/clear` | `/atmux:session preclear` |
| End-of-day full team shutdown | `/atmux:session stop` |
| Teammates heavy, want to reset them | `/atmux:team stop` + `/atmux:team start` |
| **Lead specifically heavy; teammates productive** | **`/atmux:team rotate-lead`** |
| Auto-triggered from `/atmux:whip` at ≥60min uptime OR self-compaction | `/atmux:team rotate-lead` |

### Steps

1. **Detect mode:**
   ```bash
   if grep -q '"name": "team-lead"' .claude/team.json 2>/dev/null; then
     MODE="driver"
   else
     MODE="solo"
   fi
   ```
2. **Pre-rotation drain.** Before any `/clear`, ensure no in-flight work is lost:
   - Finish any partial team-log entry — commit to disk.
   - SendMessage queue — already on-disk (inboxes/). Safe.
   - TaskCreate/TaskUpdate — finalize any in-flight tasks. TaskList persists across `/clear`.
   - Inbox drain — read messages received this turn; note in handoff.
   - If mid-draft: DEFER rotation by one whip cycle. Don't rotate mid-draft.
3. **Write handoff** — `~/.claude/projects/<project-slug>/todo/<branch>/handoff.md`:
   ```markdown
   # Session handoff — YYYY-MM-DD HH:MM (tz) [LEAD-ROTATE]

   ## Why we're rotating the lead
   Uptime + token estimate + specific looping/confusion symptom.

   ## Teammates — DO NOT RESTART
   Per-member: status / current task / token count / in-flight file.
   The next lead MUST NOT run `/atmux:team start` — it will kill live teammates.

   ## What shipped this session
   (git log refs, ≤10 bullets)

   ## In-flight at moment of rotate
   (per teammate, what they were last doing)

   ## Open questions / decisions needed
   (numbered list; each requires driver input)

   ## Next-session first actions
   1. Read handoff + team-log + recent reviews (team bootstrap will do this).
   2. Check teammate inboxes for unread messages.
   3. Resume dispatching based on current pane state.

   ## Standing decisions (do not revisit)
   (full list — rotating lead forgets these first)
   ```
4. **TaskList sync** — update in-flight tasks so they're self-contained for next lead. Delete `completed`. Don't touch `in_progress`/`pending`.
5. **Memory save** — persist session-specific lessons (judgment calls that worked, coordination patterns, corrections). Update `MEMORY.md` index.
6. **Driver Mode — autonomous `/clear` + re-bootstrap:**
   ```bash
   TEAM=$(jq -r .name .claude/team.json 2>/dev/null)
   [ -z "$TEAM" ] || [ "$TEAM" = "null" ] && { echo "ERROR: cannot derive team name from .claude/team.json — aborting rotate-lead"; exit 1; }

   # Resolve lead window — cascade: emoji-prefix → member-name-suffix → legacy.
   # Scope tmux searches to the calling session — defense-in-depth against
   # cross-team window collision (see /atmux:team start Step 0 for full rationale).
   TMUX_SCOPE="-a"
   if [ -n "${TMUX:-}" ]; then
     MY_SESSION=$(tmux display-message -p '#{session_name}' 2>/dev/null)
     [ -n "$MY_SESSION" ] && TMUX_SCOPE="-t $MY_SESSION"
   fi
   LEAD_EMOJI=$(jq -r '.members[] | select(.role == "team-lead" or .agentType == "team-lead" or .name == "team-lead") | .emoji // empty' .claude/team.json 2>/dev/null | head -1)
   LEAD_NAME=$(jq -r '.members[] | select(.role == "team-lead" or .agentType == "team-lead" or .name == "team-lead") | .name' .claude/team.json 2>/dev/null | head -1)
   LEAD_WIN=""
   if [ -n "$LEAD_EMOJI" ] && [ "$LEAD_EMOJI" != "null" ]; then
     LEAD_WIN=$(tmux list-windows $TMUX_SCOPE -F '#{window_name}' 2>/dev/null | grep -m1 "^${LEAD_EMOJI}")
   fi
   if [ -z "$LEAD_WIN" ] && [ -n "$LEAD_NAME" ]; then
     LEAD_WIN=$(tmux list-windows $TMUX_SCOPE -F '#{window_name}' 2>/dev/null | grep -m1 "${LEAD_NAME}\$")
   fi
   [ -z "$LEAD_WIN" ] && LEAD_WIN="__${TEAM}__team-lead"

   # ---- safe_submit_slash helper (ADR-081 §A C-m-eat workaround) ----
   # `tmux send-keys "..." Enter` to a claude TUI in bracketed-paste mode
   # sometimes interprets the trailing Enter as newline-in-message, not
   # submit — text lands in compose box and sits unsent. Workaround:
   # SEPARATE the text and Enter into two send-keys calls with a settle,
   # then verify the composer cleared by capturing the pane. Retry up
   # to 2 times on miss before giving up.
   safe_submit_slash() {
     local target=$1 slash=$2 attempts=0
     while [ $attempts -lt 3 ]; do
       tmux send-keys -t "$target" "$slash"
       sleep 0.3
       tmux send-keys -t "$target" C-m
       sleep 0.8
       # Composer-empty check: `❯ ` followed by EOL means input cleared.
       # If text is still on the prompt line, the Enter was eaten.
       if tmux capture-pane -p -t "$target" 2>/dev/null \
            | grep -qE '^❯ *$'; then
         return 0
       fi
       attempts=$((attempts + 1))
     done
     echo "WARN: safe_submit_slash to $target — '$slash' did not submit after 3 attempts (composer still loaded)" >&2
     return 1
   }

   # 6a — /clear own pane. Claude consumes it between turns.
   safe_submit_slash "${LEAD_WIN}" "/clear"

   # 6b — invoke bootstrap. SEPARATE text + C-m sends with composer-empty verify.
   safe_submit_slash "${LEAD_WIN}" "/atmux:team bootstrap"

   # 6c — clear stale team-lead inbox (fresh context shouldn't re-read echoes)
   rm -f ~/.claude/teams/${TEAM}/inboxes/team-lead.json

   # 6d — reset lead uptime marker (new context = new uptime clock)
   rm -f ~/.claude/teams/${TEAM}/lead-session-start.txt
   ```

   **Submit mechanism — separated send-keys with composer-empty verify (ADR-081 §A).** Earlier guidance ("single-line send-keys bypasses bracketed-paste") is INSUFFICIENT — observed 2026-05-19: even `tmux send-keys "..." Enter` (single call, text+Enter together) loses C-m to bracketed-paste-newline on a slow-to-render claude TUI, leaving the slash command sitting in the compose box. Burned ~2h of team-cycle dormancy when the post-rotate bootstrap brief sat unsubmitted. The `safe_submit_slash` helper above mirrors the `src/core/safe-send.ts` pattern from atmux: send text, settle, send C-m as a separate keystroke, then `tmux capture-pane` to confirm the composer is empty. Retry 2× before warning. `tmux paste-buffer` + separate Enter is still broken (different failure mode — bracketed-paste mode appends a continuation line) and should NOT be used here.
   
   **Self-rotation verification — why not inline.** Can't verify submit from inside this skill — the `/clear` doesn't land until AFTER the skill returns. Rotation liveness is guarded by `whip-watchdog` running on the driver side (cron). If the post-rotation lead never produces a Discord flush within 30min, watchdog pages the user.

7. **Solo Mode — banner:**
   ```
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   🔄  LEAD ROTATION REQUIRED
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Lead context is heavy. Handoff written to:
     <handoff-path>

   TEAMMATES ARE STILL ALIVE — DO NOT /atmux:team start again.

   Run these two commands NOW:
     1. /clear
     2. /atmux:session cont

   The fresh lead will read the handoff, skip team-start, resume
   dispatching against the same live inboxes.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ```
8. **Reset lead-uptime marker:** `rm -f ~/.claude/teams/${TEAM}/lead-session-start.txt`
9. **Report:**
   - Driver Mode: `"Lead rotated autonomously. New lead at ${LEAD_WIN}. Handoff at <path>. Fresh lead bootstraps + resumes whip within 30s."`
   - Solo Mode: just the banner (user sees on next interaction).

### Notes

- Do NOT commit / push / touch git working tree during rotation. Handoff + memory only.
- Do NOT kill teammates.
- **Dual-harness:** on orch, Driver Mode equivalent is `orch_shutdown team-lead` + `orch_spawn team-lead`. Plugin handles tmux-equivalent session management.
- **`/clear` escape hatch:** if `/clear` stops working (Claude Code removes the slash command, or lead process is wedged), fall back to kill+respawn (~10s spawn, new session ID). Not the default.

---

## Verb — `rotate-member`

Checkpoint a teammate's in-flight state to a file, then `/clear` + re-brief pointing at the checkpoint. Distinct from `clear` which discards state. Used when context is big but teammate is productive — we want fresh context without losing the thread.

### When to use

| Situation | Verb |
|---|---|
| Teammate confused, drifting, holding stale assumptions | **`/atmux:team clear <name>`** |
| Teammate productive but uptime past rotation threshold (context bloat) | **`/atmux:team rotate-member <name>`** |
| Lead specifically heavy; teammates productive | `/atmux:team rotate-lead` |
| Surfaced by `whip-watchdog` Check 4 as "rotations overdue" | **`/atmux:team rotate-member <name>`** (per member) |

The `clear` verb is the blunt reset — use when past context is actively unhelpful. The `rotate-member` verb is the hygienic refresh — teammate writes their own handoff-to-self first, resumes from that.

### Flow

The canonical implementation lives in `scripts/rotate-member.sh` — invoke it directly. Seven stages:

1. **Guards.** Refuse `team-lead` (use `rotate-lead`), no window, pane not running `claude`.
2. **Wait for idle.** Up to 180s. Aborts if still busy — rotating mid-turn eats state. Exit 6.
3. **Ask for checkpoint.** Write instruction to `/tmp/team-rotate-instr-<team>-<member>.txt`, submit via single-line `tmux send-keys "Read <path>..."` (same bracketed-paste bypass trick as `clear`). Teammate writes to `~/.claude/teams/<team>/rotate-<member>.md` with: what they were doing, uncommitted work, relevant SHAs, next concrete action, open questions.
4. **Poll for checkpoint** (exists + size >100B + mtime stable 5s, up to 180s). Abort if missing → exit 6 (caller can fall back to `/atmux:team clear` which discards state, or surface to user).
5. **Send `/clear`** via single-line `tmux send-keys`. Wait for post-clear idle (60s budget).
6. **Submit resume brief** referencing the checkpoint path. Teammate's first action in fresh context: read checkpoint, execute the "next concrete action" from it, delete checkpoint file.
7. **Write context-age marker** — `~/.claude/teams/<team>/member-clear-<member>.txt` (epoch). Read by `whip-watchdog` Check 4 so it stops nagging about this member.

### Invocation

```bash
bash ~/.claude/skills/team/scripts/rotate-member.sh "$TEAM" "$MEMBER"
```

Exit codes:
- `0` — rotated successfully
- `2` — misuse (called with `team-lead`)
- `3` — no window
- `4` — pane not running `claude`
- `5` — submit didn't land (fresh-context REPL didn't consume the `Read` command)
- `6` — teammate busy past timeout OR checkpoint never written

### Failure handling

- **Exit 6 (busy / no checkpoint):** teammate either didn't cooperate OR is stuck mid-turn. The script does NOT /clear — so no state lost. Caller can:
  - Wait + retry
  - Fall back to `/atmux:team clear <name>` (discards state, safer if teammate is confused)
  - Attach manually via `tmux select-window -t __<team>__<member>` and inspect
- **Exit 5 (submit didn't land):** the `/clear` fired but the resume brief `Read <path>` command sits at the prompt unsubmitted. Rare. Manually attach and press Enter, or re-send the brief command.

### Notes

- **Does NOT touch the lead.** Use `/atmux:team rotate-lead` for the lead.
- **Does NOT modify git.** Rotation is a context refresh, not a commit.
- **Rotation artifacts clean themselves.** Instruction file removed on success. Checkpoint + brief are left for the teammate to delete after absorption (the brief instructs them to).
- **whip-watchdog integration.** Check 4 of `whip/scripts/watchdog.sh` surfaces overdue rotations via Discord, pointing at this verb. The `member-clear-<name>.txt` marker reset here is what quiets the nag.
- **Default rotation threshold.** 90 min (from watchdog's `ROTATE_THRESHOLD_MIN`). Overridable via env var in the cron entry if a team needs a different cadence.

---

## Global notes

- **Always use tmux windows, not panes** — user may be on mobile with limited screen.
- **Single-line commands only** — line breaks cause shell errors when pasting.
- **Only touch `__{team}__*` windows** — never other teams' windows or unrelated sessions.
- **First input is required** for Claude TUIs (welcome-screen gating). Use paste-buffer, not SendMessage, for first message.
- **Teammates stay alive between tasks.** Don't shut them down after work completes — send "stand by" instead. Only `stop`/`full-stop`/explicit user command kills them.
- **Every team must include a reviewer.** Reviewer audits non-trivial work before commit. See `feedback_always_include_reviewer.md`. Dispatch after each round; if unresponsive >10min + 2 nudges, `/atmux:team clear <reviewer>` (or kill-respawn if cleared but still unresponsive) — don't bypass.
- **Watch for spawn failure:** agent whose pane stays `zsh` is dead. Kill the window, kill the process, respawn. See `feedback_team_member_tui_first_input.md`.

## Operator-facing report format — attention + verdict markers

Every team verb ends with a one-block summary so the operator knows whether to act, wait, or move on. All 8 verbs use the same attention+verdict scheme as whip §8.0, medic §9.5, bau header, bruh §7, and session global notes (per `[[feedback-unambiguous-attention-and-verdict]]`).

**Marker glossary:**
- **Top-line emoji** — verdict for the whole verb run: ✅ (clean / done) · ⚠ (partial / watch one cycle) · 🔴 (failed / blocking)
- **👁** prefix on follow-up lines — operator-action-required (must read, don't skim)
- **ℹ** — neutral observation

**Per-verb verdict-derivation rules:**

| Verb | ✅ when | ⚠ when | 🔴 when |
|------|---------|---------|---------|
| `start` | every roster member spawned, lead-bootstrap ack'd, first dispatch fired | some members spawned but ≥1 still on welcome-screen / zsh after retry | tmux session itself failed to create, or no members up |
| `stop` | all teammates + lead stopped clean, windows reaped, config rewrite landed | some force-killed (count them out) | tmux session couldn't be killed, hold-outs survived a clear ask |
| `add` | new member spawned + first-input absorbed + lane assigned in team.json | spawned but first-input retry pending | spawn failed (welcome-screen-stuck, zsh, paste-buffer rejected) |
| `clear` | member /clear'd + re-bootstrap brief delivered + pane shows `❯` prompt | /clear ack'd but bootstrap brief didn't paste cleanly | member pane wedged before /clear could fire (kill+respawn needed) |
| `cleanup` | all reported zombies reaped (windows, panes, orphan processes) | some zombies reaped but ≥1 process survived SIGTERM | session itself dead, can't enumerate state |
| `bootstrap` | lead role established + first-tick green | lead spawned but bootstrap brief truncated / partial-ack | lead window won't take first-input |
| `rotate-lead` | preclear + /clear + re-bootstrap all landed; lead `❯` prompt with fresh ctx | preclear wrote handoff but /clear hung; lead pane in transitional state | lead pane wedged, rotate aborted, original lead state preserved |
| `rotate-member` | checkpoint written + /clear fired + brief delivered + member acks | checkpoint written + /clear fired but brief delivery flaky (retry needed) | member wedged before checkpoint could be written |

**Examples (drop-in for verb summaries):**

```
✅ /atmux:team start (atmuxbun) — 6 members + lead up
Roster: lead, planner, reviewer, fe-1, be-1, devops
Lead bootstrap: ack'd in 47s (ctx 3%)
First dispatch: t-1c7a556b → fe-1
```

```
⚠ /atmux:team rotate-member (planner) — checkpoint written, brief delivery flaky
Checkpoint: ~/.claude/teams/atmuxbun/checkpoints/planner-2026-05-17.md (4.1k)
/clear: ack'd
Brief: paste-buffer flushed but pane shows truncation (last line cut at 73 chars)
👁 Re-paste brief manually from checkpoint OR run /atmux:team rotate-member planner --resume
```

```
👁 🔴 /atmux:team start (sopx) — tmux session creation failed
Failure: `tmux -S /tmp/atmux-sopx/sock new-session -d` exited 1 (Address already in use)
👁 Operator: check `tmux -S /tmp/atmux-sopx/sock list-sessions` and kill stale, then re-run
Roster: 0 / 6 spawned (no partial state to clean up)
```

```
✅ /atmux:team cleanup (atmuxbun) — 3 zombies reaped
Dead windows removed: __atmuxbun__planner-zombie, __atmuxbun__fe-1-zombie
Orphan processes: 1 (claude pid 47284 — SIGTERM accepted)
```

**Anti-patterns:**
- ❌ Top-line `✅` while a `👁` line warns operator must do something. Worst-marker wins — downgrade.
- ❌ Reporting `✅ team started` after a partial-spawn without naming which members failed.
- ❌ Burying force-kill counts at the bottom of a long shutdown narration. Surface them in the first 3 lines.
