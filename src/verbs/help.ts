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
  start                       Create tmux session, spawn all members
  stop [--force]              Kill tmux session, archive state
  attach                      tmux attach to the team session
  status                      Powerline team overview
  cockpit rebuild [--no-cycle|--force-cycle] [--no-launch] [--config <p>]
                              ADR-063: ensure-up the operator cockpit (cages +
                              TUI auto-launch + cockpit session). Reads roster
                              from ~/.atmux/cockpit.json (override via
                              ATMUX_COCKPIT_CONFIG or --config <p>).

Messaging:
  send <member> <msg...>      tmux send-keys to a member's pane
  broadcast <msg...>          Send to every member except the driver
  tell-lead <msg...>          Driver-only: send to lead + append to driver-inbox.md
  reply <msg...>              Member → driver: write to lead-outbox.md
  outbox [--ack] [--json]     Driver: read lead-outbox.md (--ack archives)

Task board (kanban):
  task add <subject> [--body <text>] [--assignee <member>] [--deps <id,id>]
  task list [--status todo|in-progress|done|blocked] [--assignee <member>]
  task show <id>
  task move <id> <todo|in-progress|done|blocked>

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
  reconfigure                 Re-run wizard against an existing team.json
  dashboard [--interval <s>]  Live full-screen status panel
  doctor [--fix] [--json]     Check deps, team.json, TUI PATH, webhook reachability

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
