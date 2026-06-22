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

const USAGE = `atmux — tmux agent harness + task feed (ADR-263).

Usage: atmux <verb> [args]
       atmux                        One-stop: wizard (if new) → doctor → start → attach

Setup:
  up                          Same as bare \`atmux\`: bring the team all the way up
  init [--name <team>]        Scaffold .atmux/team.json in current dir
  start                       Create the tmux session, spawn all panes
  stop [--force|--soft]       Kill the tmux session, archive state
  attach                      tmux attach to the team session
  status                      Team / pane overview

Panes:
  send <pane> <msg...>        tmux send-keys to a pane
  broadcast <msg...>          Send to every pane

Task feed (optional, ADR-263 §D2):
  task add <subject> [--body <text>] [--assignee <pane>] [--deps <id,id>]
  task list [--status todo|in-progress|done|blocked] [--assignee <pane>]
  task show <id>
  task move <id> <todo|in-progress|done|blocked>
  task update <id> [--body <text>] [--deps <id,id>] [--owner <pane>|--unassign]
  claim <task-id>             Claim the next/given task
  done <task-id>              Mark a claimed task complete

Git task source (ADR-263 §D3):
  issues sync [--source <owner/repo>] [--dry-run]
                              Poll team.json::taskSources (GitHub) → upsert
                              matching issues/PRs as tasks (deduped on
                              sourceId; feed-only — no auto-dispatch)

Maintenance:
  reconfigure                 Re-run the wizard against an existing team.json
  doctor [--fix] [--json]     Check deps, team.json, TUI PATH
  cleanup <logs|all> [--max-size <bytes>] [--max-age-days <N>] [--dry-run]
                              Rotate big *.log files
  sync <sub>                  Sync derived state (e.g. claude-team-json, ADR-164)
  version
  help | --help | -h

Environment:
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
