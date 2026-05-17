// ADR-010: CLI dispatcher — `help` / `--help` / `-h` verb.
//
// Mirrors bash `bin/atmux:25-86 usage()` byte-exact: prints the usage
// block to stdout and exits 0. The usage text is duplicated here rather
// than read from disk because the bash binary does the same (heredoc
// inside the dispatcher), and pinning the literal here lets the parity
// harness diff stdout byte-for-byte.
//
// Args are accepted but ignored (parity with bash, which routes
// `help|--help|-h` to `usage; exit 0` without inspecting `$2..`).

const USAGE = `atmux — agent teams multiplexer.

Usage: atmux <verb> [args]
       atmux                        One-stop: wizard (if new) → doctor → start → attach

Setup:
  up                          Same as bare \`atmux\`: bring a team all the way up
  init [--name <team>]        Scaffold .atmux/team.json in current dir
  start                       Create tmux session, spawn all members. Also
                              auto-adds the team's cockpit viewer window if
                              this team is rostered + enabled in
                              ~/.atmux/cockpit.json (ADR-063 ergonomic fix —
                              additive, sibling windows untouched; un-
                              rostered + disabled teams silent-skip).
  stop [--force|--soft]       Kill tmux session, archive state.
                              --soft (ADR-087): graceful path — notice every
                              pane, grace window, write resume manifest at
                              state/resume.json, NO worktree prune.
  attach                      tmux attach to the team session
  status                      Powerline team overview
  cockpit rebuild [--no-cycle|--force-cycle] [--no-launch] [--config <p>]
                              ADR-063: ensure-up the operator cockpit (cages +
                              TUI auto-launch + cockpit session). Reads roster
                              from ~/.atmux/cockpit.json (override via
                              ATMUX_COCKPIT_CONFIG or --config <p>).
  sentinel [tick|status] [--once] [--config <p>] [--state <p>]
                              ADR-132 §D2: cockpit-tier fleet-wide whip-manager
                              tick loop (window W3, sibling of medic at W2).
                              'tick' iterates every enabled team; 'status'
                              prints last-tick JSON. State persists at
                              ~/.atmux/state/sentinel-state.json.

Messaging:
  send <member> <msg...>      tmux send-keys to a member's pane
  broadcast <msg...>          Send to every member except the driver
  tell-lead <msg...>          Driver-only: send to lead + append to driver-inbox.md
  reply <msg...>              Member → driver: write to lead-outbox.md
  outbox [--ack] [--json]     Driver: read lead-outbox.md (--ack archives)

Task board (kanban):
  task add <subject> [--body <text>] [--assignee <member>] [--deps <id,id>] [--driver-only]
  task list [--status todo|in-progress|done|blocked] [--assignee <member>]
  task show <id>
  task move <id> <todo|in-progress|done|blocked>
  task update <id> [--body <text>] [--deps <id,id>]

Hierarchy (ADR-007):
  epic add <title> [--body <text>] [--driver-ref <ref>]
  epic list [--status <s>] [--json]
  epic show <id> [--json]
  epic advance <id> [--to <state>]    States: planning→ready→in-progress→review→done
  story add <title> --epic <eid> [--ac <criteria>] [--body <text>]
  story list --epic <eid> [--status <s>] [--json]
  story show <id> [--json]
  story advance <id> [--to <state>]   States: planning→ready→in-progress→testing→review→merging→done

Dispatch + work:
  dispatch <member> <task-id> Push task to member's inbox + ping them
  inbox <member>              Show member's inbox
  claim <task-id>             Claim a task from kanban (as a member)
  done <task-id>              Mark claimed task complete

Automation:
  report                      Post 30-min progress digest to Discord
  whip                        Run 5-min watchdog (idle / blocker / budget / clear)
  improve [--budget <spec>] [--status] [--dry-run]  Arm eternal-improvement loop (ADR-052)
  cost [--member <m>] [--since <t>] [--json]  Per-member USD + token usage
  rotate <member>             /clear the member and re-brief
  rotate-lead                 /clear the lead and re-bootstrap
  handoff <from> <to>         Move in-flight work from one member to another
  pause <member>              Mark member paused (dispatch refuses to queue)
  resume <member>             Unpause

Maintenance:
  add-member <name> --role <r> --tui <t> [--model <m>] [--cwd <d>] [--command <c>]
  member rename <id> --label <new>          Hot-rename display label (ADR-136)
  member move <id> --to <position>          Relocate member's tmux window (ADR-161 §C)
  member swap <id-a> <id-b>                 Pairwise window swap (ADR-161 §C)
  member sort [--defaults-first]            Canonical reorder (ADR-161 §C)
  team spawn-epic <epicId> --from <parent> [--roster <preset>|--roster-file <p>]
                              ADR-090: spawn an ephemeral epic-team child of
                              <parent>. Worktree at <parentRoot>-epics/<epicId>
                              on branch <parentBase>-epic-<epicId>; cockpit
                              entry appended under the parent. Requires
                              ATMUX_CALLER_SCOPE=driver.
  team dissolve-epic <epicId> [--skip-checks] [--force-prune]
                              ADR-090: tear down an epic-team spawned via
                              spawn-epic. Soft-stop + prune worktree + remove
                              cockpit entry + mark parent kanban EPIC done.
                              --skip-checks bypasses the all-tasks-done +
                              clean-worktree gates (lead-override).
  team sweep-epics [--apply] [--idle-hours N] [--parent <team>] [--json]
                              ADR-170: enumerate every enabled epic-team and
                              classify each (DRAIN/SAFE-DISSOLVE/STALE-IDLE/
                              RISKY/MISSING). Read-only by default; --apply
                              dissolves only SAFE-DISSOLVE candidates (0 open
                              tasks + clean worktree + branch pushed to
                              origin) via the ADR-090 dissolve-epic pipeline.
  reconfigure                 Re-run wizard against an existing team.json
  dashboard [--interval <s>]  Live full-screen status panel
  doctor [--fix] [--json]     Check deps, team.json, TUI PATH, webhook reachability
  health [--json|--text] [--budget] [--stale-sec <N>]
                              SPEC-066: composed read-only diagnostic snapshot —
                              status + inbox + task + heartbeat (+ optional budget).
                              JSON-first, foundational for fleet dashboards.
  groom [--dry-run] [--quiet] [--kanban-days N] [--decisions-days N] [--keep-bak N]
                              Daily 04:00 cron sweep — flush archive sections, age
                              out done/cancelled cards, cull stale .bak files.
  cleanup <logs|inboxes|all> [--max-size <bytes>] [--max-age-days <N>] [--dry-run]
                              Rotate big *.log files; prune old .done[] in
                              member inboxes. Idempotent + cron-safe.
  discorder <progress|heartbeat>
                              ADR-022 Discord cron pings. progress = 30-min
                              digest; heartbeat = hourly state-of-team.
                              Read-only on kanban/git/decisions.

Misc:
  version
  help | --help | -h

Environment:
  ATMUX_DISCORD_WEBHOOK   Discord webhook URL for whip/report escalations
  ATMUX_DIR               Override state dir (default: ./.atmux)
  ATMUX_TEAM              Override team name (otherwise read from team.json)

Docs:  https://github.com/geoyws/atmux
`;

/**
 * `atmux help` (and `--help` / `-h` aliases) — print the usage block,
 * exit 0. No state touched, no Discord call, no .atmux/ access. Args
 * are accepted but ignored (matches bash dispatcher at bin/atmux:89,
 * which routes all three forms to `usage; exit 0` without arg checks).
 */
export async function help(_args: ReadonlyArray<string>): Promise<number> {
  process.stdout.write(USAGE);
  return 0;
}

export { USAGE as ATMUX_USAGE };
